// scripts/lib/plan-graph.mjs
// The plan graph of one /tech-lead run (pure: no fs, no clock; `now` is an argument). The lead
// writes the plan as a draft, and this module does the bookkeeping: it validates the draft and
// the stored plan, computes which tasks can run now (the wave), applies status transitions and
// appends tasks. It never runs an agent and never decides anything. scripts/plan-graph.mjs
// owns every read and write of the plan file.
//   draft   {goal, session_model?, tasks:[{id, title, executor, model?, effort?, stakes?, files?,
//           depends_on?, verify?, needs_decision?}]}; the omitted keys default to null, 'normal',
//           [], [], null, null
//   plan    {v:1, run_id, project, goal, session_model, created_at, updated_at, tasks:[{...the
//           draft keys, status, attempts, result, started_at, finished_at}]}, every key present
//   problem {task: id|null, kind: <kebab-case slug>, detail: <one sentence>}; a validator
//           collects every problem, it never stops at the first
//   validateDraft(draft) -> problem[]           validatePlan(plan) -> problem[]
//   draftTasks(draft) -> tasks (defaults filled in, status pending), for schedule
//   buildPlan(draft, {runId, project, now}) -> plan (the draft must be valid)
//   nextWave(tasks, {ignoreDecisions}) -> {wave, held, blocked, running, counts, total, finished}
//   schedule(tasks) -> [[id]]: the waves in order, assuming every task succeeds, decisions ignored
//   readiness(tasks, id) -> {ready, blocked}    overlaps(a, b) -> bool (two paths)
//   transition(plan, id, to, {now, result, force}) -> {plan} | {refused: {reason, detail}}
//   decide(plan, id, {now, result}) -> {plan} | {refused}
//   addTask(plan, draftTask, {now}) -> {plan} | {problems}
//   runIdOf(now, hex4) -> '<yyyymmddThhmmssZ>-<hex4>'
// Every function that changes a plan returns a new one; its argument is left as it was.

export const EXECUTORS = ['main', 'fast-worker', 'deep-reasoner', 'codex', 'explore', 'general-purpose', 'panel', 'research']
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'codex']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const STAKES = ['normal', 'high']
export const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped']
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const RUN_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/
export const GOAL_MAX = 500
export const TITLE_MAX = 200
export const RESULT_MAX = 500

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const PLAN_KEYS = ['v', 'run_id', 'project', 'goal', 'session_model', 'created_at', 'updated_at', 'tasks']
const DRAFT_KEYS = ['goal', 'session_model', 'tasks']
const DRAFT_TASK_KEYS = ['id', 'title', 'executor', 'model', 'effort', 'stakes', 'files', 'depends_on', 'verify', 'needs_decision']
const STATE_KEYS = ['status', 'attempts', 'result', 'started_at', 'finished_at']
const TASK_KEYS = [...DRAFT_TASK_KEYS, ...STATE_KEYS]
const DRAFT_REQUIRED = ['id', 'title', 'executor']
const DEFAULTS = { model: null, effort: null, stakes: 'normal', files: [], depends_on: [], verify: null, needs_decision: null }
// The legal moves; pending -> running also needs the task ready (or force).
const MOVES = { pending: ['running', 'skipped'], running: ['done', 'failed', 'skipped'], failed: ['pending', 'skipped'], skipped: ['pending'], done: [] }
const WAVE_FIELDS = ['id', 'title', 'executor', 'model', 'effort', 'stakes', 'files', 'verify']

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isIso = v => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v))
const isText = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max
const json = v => JSON.stringify(v)
const clone = v => structuredClone(v)

export function runIdOf(now, hex4) {
  const d = new Date(now)
  if (Number.isNaN(d.getTime())) throw new Error(`bad-now: ${json(now)} is not a date`)
  if (!/^[0-9a-f]{4}$/.test(hex4)) throw new Error(`bad-suffix: ${json(hex4)} is not 4 lower-case hex digits`)
  return `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z-${hex4}`
}

// A repo-relative path's problem, or null. A trailing `/` marks a directory; no segment may be
// empty, `.` or `..`, so two spellings of one path cannot dodge the overlap test.
function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'is not a non-empty string'
  if (p.startsWith('/')) return 'starts with /'
  const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/')
  if (segs.includes('..')) return 'has a .. segment'
  if (segs.some(s => s === '' || s === '.')) return 'has an empty or . segment'
  if (/[\0\n\r]/.test(p)) return 'holds a NUL or a line break'
  return null
}

// Two paths overlap when equal, or when one is a directory entry (ends in /) that prefixes the other.
export function overlaps(a, b) {
  return a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
}

const filesOverlap = (fa, fb) => {
  for (const a of fa) for (const b of fb) if (overlaps(a, b)) return true
  return false
}

// The problems of one task's own fields (not its links to other tasks).
function taskProblems(t, where, { plan }) {
  const out = []
  const add = (kind, detail) => out.push({ task: where, kind, detail })
  const allowed = plan ? TASK_KEYS : DRAFT_TASK_KEYS
  for (const k of Object.keys(t)) if (!allowed.includes(k)) add('unknown-key', `task key ${json(k)} is not one of ${allowed.join(', ')}`)
  for (const k of plan ? TASK_KEYS : DRAFT_REQUIRED) if (!Object.hasOwn(t, k)) add('missing-key', `task has no ${json(k)}`)
  const v = k => (Object.hasOwn(t, k) ? t[k] : DEFAULTS[k])
  const has = k => Object.hasOwn(t, k) || Object.hasOwn(DEFAULTS, k)

  if (has('title')) {
    const title = v('title')
    if (!isText(title, TITLE_MAX) || /[\n\r]/.test(title)) add('bad-title', `title must be a single-line string of 1..${TITLE_MAX} characters`)
  }
  const executor = v('executor'), model = v('model'), effort = v('effort')
  const execOk = EXECUTORS.includes(executor)
  if (has('executor') && !execOk) add('bad-executor', `executor ${json(executor)} is not one of ${EXECUTORS.join(', ')}`)
  const modelOk = model === null || MODELS.includes(model)
  if (has('model') && !modelOk) add('bad-model', `model ${json(model)} is not null or one of ${MODELS.join(', ')}`)
  const effortOk = effort === null || EFFORTS.includes(effort)
  if (has('effort') && !effortOk) add('bad-effort', `effort ${json(effort)} is not null or one of ${EFFORTS.join(', ')}`)

  if (execOk && has('model') && modelOk) {
    if (executor === 'main') {
      if (model !== null) add('main-has-model', 'executor main is the session itself, so its model must be null')
    } else {
      if (model === null) add('delegate-needs-model', `executor ${executor} is a delegate and must pin a model`)
      if (model === 'fable') add('fable-on-delegate', `model fable is never allowed on a delegate (executor ${executor})`)
      if ((executor === 'codex') !== (model === 'codex') && model !== null) add('codex-pairing', 'executor codex requires model codex, and model codex requires executor codex')
      if (executor === 'fast-worker' && model !== null && model !== 'sonnet') add('fast-worker-model', `executor fast-worker requires model sonnet, not ${model}`)
      if (executor === 'deep-reasoner' && model !== null && model !== 'opus') add('deep-reasoner-model', `executor deep-reasoner requires model opus, not ${model}`)
    }
  }
  if (execOk && effortOk && executor === 'main' && effort !== null) add('main-has-effort', 'executor main must have effort null')
  if (execOk && executor !== 'main' && model === 'sonnet' && (effort === 'xhigh' || effort === 'max')) {
    add('sonnet-effort', `a delegate on sonnet may not use effort ${effort}`)
  }

  const stakes = v('stakes')
  if (!STAKES.includes(stakes)) add('bad-stakes', `stakes ${json(stakes)} is not normal or high`)
  else if (stakes === 'high' && executor === 'fast-worker') add('high-stakes-fast-worker', 'a high-stakes task may not use executor fast-worker')

  const files = v('files')
  if (!Array.isArray(files)) add('bad-files', 'files must be an array of repo-relative paths')
  else {
    const seen = new Set()
    for (const p of files) {
      const why = pathProblem(p)
      if (why) add('bad-path', `path ${json(p)} ${why}`)
      else if (seen.has(p)) add('duplicate-path', `path ${json(p)} is listed twice`)
      seen.add(p)
    }
    if (executor === 'fast-worker' && files.length === 0) add('fast-worker-needs-files', 'executor fast-worker needs at least one path in files')
  }

  const verify = v('verify')
  if (verify !== null && !isText(verify, Infinity)) add('bad-verify', 'verify must be null or a non-empty string')
  else if (verify === null && executor === 'fast-worker') add('fast-worker-needs-verify', 'executor fast-worker needs a verify command or check')
  const nd = v('needs_decision')
  if (nd !== null && !isText(nd, Infinity)) add('bad-needs-decision', 'needs_decision must be null or a non-empty string')

  const deps = v('depends_on')
  if (!Array.isArray(deps)) add('bad-depends-on', 'depends_on must be an array of task ids')

  if (plan) {
    if (Object.hasOwn(t, 'status') && !STATUSES.includes(t.status)) add('bad-status', `status ${json(t.status)} is not one of ${STATUSES.join(', ')}`)
    if (Object.hasOwn(t, 'attempts') && !(Number.isSafeInteger(t.attempts) && t.attempts >= 0)) add('bad-attempts', 'attempts must be an integer >= 0')
    if (Object.hasOwn(t, 'result') && t.result !== null && !(typeof t.result === 'string' && t.result.length <= RESULT_MAX)) {
      add('bad-result', `result must be null or a string of at most ${RESULT_MAX} characters`)
    }
    for (const k of ['started_at', 'finished_at']) {
      if (Object.hasOwn(t, k) && t[k] !== null && !isIso(t[k])) add(`bad-${k.replace('_', '-')}`, `${k} must be null or an ISO-8601 UTC timestamp`)
    }
  }
  return out
}

// The id of each task (null when it is not a valid id) and the problems of ids and links.
function graphProblems(tasks) {
  const out = []
  const ids = new Set(), dupes = new Set()
  const idOf = t => (isObject(t) && typeof t.id === 'string' && TASK_ID_RE.test(t.id) ? t.id : null)
  tasks.forEach((t, i) => {
    if (!isObject(t)) return
    const id = idOf(t)
    if (Object.hasOwn(t, 'id') && id === null) out.push({ task: null, kind: 'bad-id', detail: `task ${i + 1} has id ${json(t.id)}, which does not match ${TASK_ID_RE}` })
    if (id !== null) {
      if (ids.has(id) && !dupes.has(id)) out.push({ task: id, kind: 'duplicate-id', detail: `id ${id} is used by more than one task` })
      if (ids.has(id)) dupes.add(id)
      ids.add(id)
    }
  })
  const edges = new Map()
  for (const t of tasks) {
    const id = idOf(t)
    if (id === null || !Array.isArray(t.depends_on)) continue
    const seen = new Set(), good = []
    for (const d of t.depends_on) {
      if (d === id) out.push({ task: id, kind: 'self-dependency', detail: `task ${id} depends on itself` })
      else if (typeof d !== 'string' || !ids.has(d)) out.push({ task: id, kind: 'unknown-dependency', detail: `dependency ${json(d)} is not a task in the plan` })
      else if (seen.has(d)) out.push({ task: id, kind: 'duplicate-dependency', detail: `dependency ${d} is listed twice` })
      else good.push(d)
      if (typeof d === 'string') seen.add(d)
    }
    if (!edges.has(id)) edges.set(id, good)
  }
  // Three-colour DFS in plan order; each back edge closes one cycle, reported from its first node.
  const colour = new Map(), stack = []
  const visit = id => {
    colour.set(id, 1)
    stack.push(id)
    for (const d of edges.get(id) || []) {
      if (colour.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d))
        out.push({ task: cyc[0], kind: 'cycle', detail: `the dependencies form a cycle: ${[...cyc, cyc[0]].join(' -> ')}` })
      } else if (!colour.has(d)) visit(d)
    }
    stack.pop()
    colour.set(id, 2)
  }
  for (const id of edges.keys()) if (!colour.has(id)) visit(id)
  return out
}

function tasksProblems(tasks, { plan }) {
  if (!Array.isArray(tasks)) return [{ task: null, kind: 'bad-tasks', detail: 'tasks must be an array' }]
  const out = []
  if (tasks.length === 0) out.push({ task: null, kind: 'bad-tasks', detail: 'tasks must hold at least one task' })
  tasks.forEach((t, i) => {
    if (!isObject(t)) out.push({ task: null, kind: 'not-an-object', detail: `task ${i + 1} is not a JSON object` })
    else out.push(...taskProblems(t, typeof t.id === 'string' && TASK_ID_RE.test(t.id) ? t.id : null, { plan }))
  })
  return [...out, ...graphProblems(tasks)]
}

function headProblems(obj, keys, required, what) {
  const out = []
  for (const k of Object.keys(obj)) if (!keys.includes(k)) out.push({ task: null, kind: 'unknown-key', detail: `key ${json(k)} is not one of ${keys.join(', ')}` })
  for (const k of required) if (!Object.hasOwn(obj, k)) out.push({ task: null, kind: 'missing-key', detail: `the ${what} has no ${json(k)}` })
  if (Object.hasOwn(obj, 'goal') && !isText(obj.goal, GOAL_MAX)) out.push({ task: null, kind: 'bad-goal', detail: `goal must be a string of 1..${GOAL_MAX} characters` })
  const sm = obj.session_model
  if (Object.hasOwn(obj, 'session_model') && sm !== null && typeof sm !== 'string') out.push({ task: null, kind: 'bad-session-model', detail: 'session_model must be a string or null' })
  return out
}

export function validateDraft(draft) {
  if (!isObject(draft)) return [{ task: null, kind: 'not-an-object', detail: 'the draft is not a JSON object' }]
  return [...headProblems(draft, DRAFT_KEYS, ['goal', 'tasks'], 'draft'), ...(Object.hasOwn(draft, 'tasks') ? tasksProblems(draft.tasks, { plan: false }) : [])]
}

export function validatePlan(plan) {
  if (!isObject(plan)) return [{ task: null, kind: 'not-an-object', detail: 'the plan is not a JSON object' }]
  const out = headProblems(plan, PLAN_KEYS, PLAN_KEYS, 'plan')
  const bad = (kind, detail) => out.push({ task: null, kind, detail })
  if (Object.hasOwn(plan, 'v') && plan.v !== 1) bad('bad-version', `v must be 1, not ${json(plan.v)}`)
  if (Object.hasOwn(plan, 'run_id') && !(typeof plan.run_id === 'string' && RUN_ID_RE.test(plan.run_id))) bad('bad-run-id', `run_id ${json(plan.run_id)} does not match ${RUN_ID_RE}`)
  if (Object.hasOwn(plan, 'project') && !(typeof plan.project === 'string' && plan.project.startsWith('/'))) bad('bad-project', 'project must be an absolute path')
  for (const k of ['created_at', 'updated_at']) if (Object.hasOwn(plan, k) && !isIso(plan[k])) bad(`bad-${k.replace('_', '-')}`, `${k} must be an ISO-8601 UTC timestamp`)
  return Object.hasOwn(plan, 'tasks') ? [...out, ...tasksProblems(plan.tasks, { plan: true })] : out
}

const fullTask = t => ({
  id: t.id, title: t.title, executor: t.executor, model: t.model,
  ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, Object.hasOwn(t, k) ? clone(t[k]) : clone(d)])),
  status: 'pending', attempts: 0, result: null, started_at: null, finished_at: null,
})

export const draftTasks = draft => draft.tasks.map(fullTask)

export function buildPlan(draft, { runId, project, now }) {
  return {
    v: 1, run_id: runId, project, goal: draft.goal, session_model: draft.session_model ?? null,
    created_at: now, updated_at: now, tasks: draftTasks(draft),
  }
}

const countsOf = tasks => Object.fromEntries(STATUSES.map(s => [s, tasks.filter(t => t.status === s).length]))

// Why a pending task cannot run yet, or null when it can: a failed or skipped dependency first,
// then an unfinished one, then an open decision.
function blockOf(t, byId, ignoreDecisions) {
  const deps = t.depends_on.map(d => byId.get(d))
  const dead = deps.filter(d => d.status === 'failed' || d.status === 'skipped').map(d => d.id)
  if (dead.length) return { id: t.id, reason: 'dependency-failed', dependencies: dead }
  const open = deps.filter(d => d.status !== 'done').map(d => d.id)
  if (open.length) return { id: t.id, reason: 'waiting-on', dependencies: open }
  if (!ignoreDecisions && t.needs_decision !== null) return { id: t.id, reason: 'needs-decision', needs_decision: t.needs_decision }
  return null
}

export function readiness(tasks, id) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const t = byId.get(id)
  if (!t || t.status !== 'pending') return { ready: false, blocked: null }
  const blocked = blockOf(t, byId, false)
  return { ready: blocked === null, blocked }
}

export function nextWave(tasks, { ignoreDecisions = false } = {}) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const running = tasks.filter(t => t.status === 'running')
  const wave = [], held = [], blocked = []
  for (const t of tasks) {
    if (t.status !== 'pending') continue
    const why = blockOf(t, byId, ignoreDecisions)
    if (why) { blocked.push(why); continue }
    const clash = [...running, ...wave].find(o => filesOverlap(t.files, o.files))
    if (clash) held.push({ id: t.id, overlaps: clash.id })
    else wave.push(t)
  }
  const counts = countsOf(tasks)
  return {
    wave: wave.map(t => Object.fromEntries(WAVE_FIELDS.map(k => [k, clone(t[k])]))),
    held, blocked, running: running.map(t => t.id), counts, total: tasks.length,
    finished: counts.pending === 0 && counts.running === 0,
  }
}

// The waves `next` would give if every task succeeded the moment it ran and no decision were open.
export function schedule(tasks) {
  const sim = tasks.map(t => ({ ...t, status: t.status === 'running' ? 'pending' : t.status }))
  const waves = []
  for (;;) {
    const { wave } = nextWave(sim, { ignoreDecisions: true })
    if (wave.length === 0) break
    const ids = new Set(wave.map(w => w.id))
    for (const t of sim) if (ids.has(t.id)) t.status = 'done'
    waves.push([...ids])
  }
  return waves
}

const refused = (reason, detail) => ({ refused: { reason, detail } })

function withTask(plan, id, now, change) {
  const next = clone(plan)
  const t = next.tasks.find(x => x.id === id)
  change(t)
  next.updated_at = now
  return { plan: next }
}

export function transition(plan, id, to, { now, result, force = false } = {}) {
  const t = plan.tasks.find(x => x.id === id)
  if (!t) return refused('unknown-task', `no task ${json(id)} in run ${plan.run_id}`)
  if (!STATUSES.includes(to)) return refused('bad-status', `status ${json(to)} is not one of ${STATUSES.join(', ')}`)
  if (result !== undefined && result !== null && result.length > RESULT_MAX) {
    return refused('result-too-long', `the result has ${result.length} characters; at most ${RESULT_MAX} are stored`)
  }
  if (t.status === 'done') return refused('done-is-final', `task ${id} is done, and done is final`)
  if (!MOVES[t.status].includes(to)) {
    return refused('illegal-transition', `task ${id} cannot go from ${t.status} to ${to}; from ${t.status} it can go to ${MOVES[t.status].join(' or ')}`)
  }
  if (to === 'running' && !force) {
    const { blocked } = readiness(plan.tasks, id)
    if (blocked) {
      const why = blocked.reason === 'needs-decision' ? `it needs a decision: ${blocked.needs_decision}` : `${blocked.reason} ${blocked.dependencies.join(', ')}`
      return refused('not-ready', `task ${id} is not ready (${why}); pass --force to start it anyway`)
    }
  }
  return withTask(plan, id, now, x => {
    if (to === 'running') Object.assign(x, { attempts: x.attempts + 1, started_at: now, finished_at: null, result: null })
    else if (to === 'pending') Object.assign(x, { started_at: null, finished_at: null })
    else x.finished_at = now
    x.status = to
    if (result !== undefined && result !== null) x.result = result
  })
}

export function decide(plan, id, { now, result } = {}) {
  const t = plan.tasks.find(x => x.id === id)
  if (!t) return refused('unknown-task', `no task ${json(id)} in run ${plan.run_id}`)
  if (t.needs_decision === null) return refused('no-open-decision', `task ${id} has no open decision to clear`)
  if (result !== undefined && result !== null && result.length > RESULT_MAX) {
    return refused('result-too-long', `the result has ${result.length} characters; at most ${RESULT_MAX} are stored`)
  }
  return withTask(plan, id, now, x => {
    x.needs_decision = null
    if (result !== undefined && result !== null) x.result = result
  })
}

const asDraft = t => Object.fromEntries(DRAFT_TASK_KEYS.map(k => [k, t[k]]))

export function addTask(plan, draftTask, { now }) {
  const draft = { goal: plan.goal, tasks: [...plan.tasks.map(asDraft), draftTask] }
  const problems = validateDraft(draft)
  if (problems.length) return { problems }
  const next = clone(plan)
  next.tasks.push(fullTask(draftTask))
  next.updated_at = now
  return { plan: next }
}
