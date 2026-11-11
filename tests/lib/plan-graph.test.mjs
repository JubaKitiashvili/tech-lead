// tests/lib/plan-graph.test.mjs
// The pure plan-graph module: every validation rule fails on its own case and several problems
// are reported together; cycles (a 3-node one included); wave order, file-overlap holding and
// blocked reasons; every legal transition and the refused ones; --force, decide and addTask.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTask, buildPlan, decide, nextWave, overlaps, runIdOf, schedule, transition, validateDraft, validatePlan,
} from '../../scripts/lib/plan-graph.mjs'

const NOW = '2026-11-11T10:00:00.000Z'
const LATER = '2026-11-11T11:00:00.000Z'
const main = (id, extra = {}) => ({ id, title: `task ${id}`, executor: 'main', model: null, ...extra })
const worker = (id, extra = {}) => ({ id, title: `task ${id}`, executor: 'fast-worker', model: 'sonnet', files: [`src/${id}.js`], verify: 'npm test', ...extra })
const draft = (tasks, extra = {}) => ({ goal: 'ship it', tasks, ...extra })
const kinds = problems => problems.map(p => p.kind)
const plan = (tasks, extra) => buildPlan(draft(tasks, extra), { runId: '20261111T100000Z-abcd', project: '/repo', now: NOW })
// A plan whose tasks have the given statuses ({id: status}).
const withStatus = (p, statuses) => ({ ...p, tasks: p.tasks.map(t => (statuses[t.id] ? { ...t, status: statuses[t.id] } : t)) })
const one = (tasks, kind) => {
  const ks = kinds(validateDraft(draft(tasks)))
  assert.ok(ks.includes(kind), `expected ${kind}, got ${JSON.stringify(ks)}`)
}

test('a minimal draft is valid and fills in the defaults', () => {
  assert.deepEqual(validateDraft(draft([main('a')])), [])
  const p = plan([main('a')])
  assert.deepEqual(p.tasks[0], {
    id: 'a', title: 'task a', executor: 'main', model: null, effort: null, stakes: 'normal', files: [], depends_on: [],
    verify: null, needs_decision: null, status: 'pending', attempts: 0, result: null, started_at: null, finished_at: null,
  })
  assert.equal(p.session_model, null)
  assert.deepEqual(validatePlan(p), [])
})

test('a draft task may leave model out: main is valid without it, a delegate is told to pin one', () => {
  assert.deepEqual(kinds(validateDraft({ goal: 'g', tasks: [{ id: 'a', title: 't', executor: 'main' }] })), [])
  assert.deepEqual(kinds(validateDraft({ goal: 'g', tasks: [{ id: 'a', title: 't', executor: 'general-purpose' }] })), ['delegate-needs-model'])
})

test('each validation rule fails on its own case', () => {
  const cases = [
    [[main('A')], 'bad-id'],
    [[main('a'), main('a')], 'duplicate-id'],
    [[main('a', { title: '' })], 'bad-title'],
    [[main('a', { title: 'x'.repeat(201) })], 'bad-title'],
    [[main('a', { title: 'two\nlines' })], 'bad-title'],
    [[main('a', { executor: 'robot' })], 'bad-executor'],
    [[main('a', { model: 'gpt' })], 'bad-model'],
    [[main('a', { model: 'opus' })], 'main-has-model'],
    [[main('a', { effort: 'high' })], 'main-has-effort'],
    [[{ ...main('a'), executor: 'explore' }], 'delegate-needs-model'],
    [[{ ...main('a'), executor: 'explore', model: 'fable' }], 'fable-on-delegate'],
    [[{ ...main('a'), executor: 'codex', model: 'opus' }], 'codex-pairing'],
    [[{ ...main('a'), executor: 'explore', model: 'codex' }], 'codex-pairing'],
    [[worker('a', { model: 'opus' })], 'fast-worker-model'],
    [[{ ...main('a'), executor: 'deep-reasoner', model: 'sonnet' }], 'deep-reasoner-model'],
    [[{ ...main('a'), executor: 'explore', model: 'sonnet', effort: 'xhigh' }], 'sonnet-effort'],
    [[worker('a', { effort: 'max' })], 'sonnet-effort'],
    [[main('a', { effort: 'huge' })], 'bad-effort'],
    [[main('a', { stakes: 'medium' })], 'bad-stakes'],
    [[worker('a', { stakes: 'high' })], 'high-stakes-fast-worker'],
    [[main('a', { files: 'src' })], 'bad-files'],
    [[main('a', { files: ['/etc/x'] })], 'bad-path'],
    [[main('a', { files: ['a/../b'] })], 'bad-path'],
    [[main('a', { files: [''] })], 'bad-path'],
    [[main('a', { files: ['a', 'a'] })], 'duplicate-path'],
    [[worker('a', { files: [] })], 'fast-worker-needs-files'],
    [[worker('a', { verify: null })], 'fast-worker-needs-verify'],
    [[main('a', { verify: 3 })], 'bad-verify'],
    [[main('a', { needs_decision: '' })], 'bad-needs-decision'],
    [[main('a', { depends_on: 'b' })], 'bad-depends-on'],
    [[main('a', { depends_on: ['zz'] })], 'unknown-dependency'],
    [[main('a', { depends_on: ['a'] })], 'self-dependency'],
    [[main('a', { depends_on: ['b', 'b'] }), main('b')], 'duplicate-dependency'],
    [[main('a', { colour: 'red' })], 'unknown-key'],
    [[{ id: 'a', title: 't' }], 'missing-key'],
    [['a'], 'not-an-object'],
  ]
  for (const [tasks, kind] of cases) one(tasks, kind)
  for (const [tasks] of cases) assert.ok(validateDraft(draft(tasks)).every(p => typeof p.detail === 'string' && /^[a-z0-9-]+$/.test(p.kind)))
})

test('the draft head: goal, session_model, tasks and unknown keys', () => {
  assert.deepEqual(kinds(validateDraft({ tasks: [main('a')] })), ['missing-key'])
  assert.deepEqual(kinds(validateDraft(draft([main('a')], { goal: '' }))), ['bad-goal'])
  assert.deepEqual(kinds(validateDraft(draft([main('a')], { goal: 'x'.repeat(501) }))), ['bad-goal'])
  assert.deepEqual(kinds(validateDraft(draft([main('a')], { session_model: 7 }))), ['bad-session-model'])
  assert.deepEqual(kinds(validateDraft(draft([main('a')], { owner: 'me' }))), ['unknown-key'])
  assert.deepEqual(kinds(validateDraft(draft([]))), ['bad-tasks'])
  assert.deepEqual(kinds(validateDraft(draft('nope'))), ['bad-tasks'])
  assert.deepEqual(kinds(validateDraft([])), ['not-an-object'])
  assert.deepEqual(validateDraft(draft([main('a')], { session_model: 'fable' })), [])
})

test('several problems are all reported, each naming its task', () => {
  const problems = validateDraft(draft([
    main('a', { model: 'opus', colour: 'red' }),
    worker('b', { stakes: 'high', files: [], verify: null, depends_on: ['nope'] }),
  ], { extra: 1 }))
  assert.deepEqual(problems.map(p => [p.task, p.kind]).sort(), [
    [null, 'unknown-key'], ['a', 'main-has-model'], ['a', 'unknown-key'], ['b', 'fast-worker-needs-files'],
    ['b', 'fast-worker-needs-verify'], ['b', 'high-stakes-fast-worker'], ['b', 'unknown-dependency'],
  ].sort())
})

test('cycles are found, a 3-node one included', () => {
  const two = validateDraft(draft([main('a', { depends_on: ['b'] }), main('b', { depends_on: ['a'] })]))
  assert.deepEqual(kinds(two), ['cycle'])
  const three = validateDraft(draft([main('a', { depends_on: ['c'] }), main('b', { depends_on: ['a'] }), main('c', { depends_on: ['b'] }), main('d', { depends_on: ['a'] })]))
  assert.deepEqual(kinds(three), ['cycle'])
  assert.equal(three[0].detail, 'the dependencies form a cycle: a -> c -> b -> a')
  assert.deepEqual(validateDraft(draft([main('a'), main('b', { depends_on: ['a'] }), main('c', { depends_on: ['a', 'b'] })])), [])
})

test('validatePlan wants every key and nothing else', () => {
  const p = plan([main('a')])
  const { status, ...noStatus } = p.tasks[0]
  assert.equal(status, 'pending')
  assert.deepEqual(kinds(validatePlan({ ...p, tasks: [noStatus] })), ['missing-key'])
  assert.deepEqual(kinds(validatePlan({ ...p, tasks: [{ ...p.tasks[0], status: 'lost' }] })), ['bad-status'])
  assert.deepEqual(kinds(validatePlan({ ...p, tasks: [{ ...p.tasks[0], attempts: -1 }] })), ['bad-attempts'])
  assert.deepEqual(kinds(validatePlan({ ...p, tasks: [{ ...p.tasks[0], result: 'x'.repeat(501) }] })), ['bad-result'])
  assert.deepEqual(kinds(validatePlan({ ...p, tasks: [{ ...p.tasks[0], started_at: 'yesterday' }] })), ['bad-started-at'])
  assert.deepEqual(kinds(validatePlan({ ...p, v: 2, run_id: 'x', created_at: 'now', extra: 1 })).sort(), ['bad-created-at', 'bad-run-id', 'bad-version', 'unknown-key'])
  const { goal, ...noGoal } = p
  assert.equal(goal, 'ship it')
  assert.deepEqual(kinds(validatePlan(noGoal)), ['missing-key'])
})

test('runIdOf formats the UTC second and the suffix', () => {
  assert.equal(runIdOf('2026-11-11T09:08:07.654Z', '0f3a'), '20261111T090807Z-0f3a')
  assert.throws(() => runIdOf('soon', '0f3a'), /bad-now/)
  assert.throws(() => runIdOf(NOW, 'XYZ1'), /bad-suffix/)
})

test('overlaps: equal paths and a directory prefix, in either order', () => {
  assert.ok(overlaps('a/b.js', 'a/b.js'))
  assert.ok(overlaps('a/', 'a/b.js'))
  assert.ok(overlaps('a/b.js', 'a/'))
  assert.ok(overlaps('a/', 'a/c/'))
  assert.ok(!overlaps('a', 'a/b.js'), 'a file entry is no directory')
  assert.ok(!overlaps('ab/', 'a/b.js'))
  assert.ok(!overlaps('a/b.js', 'a/b.jsx'))
})

test('the wave holds back ready tasks whose files overlap one already in it or running', () => {
  const p = plan([
    main('a', { files: ['src/x.js'] }),
    main('b', { files: ['src/x.js'] }), // equal path to a
    main('c', { files: ['src/'] }), // directory prefix of a
    main('d', { files: ['lib/y.js'] }),
    main('e'), // no files: overlaps nothing
    main('f', { files: ['docs/'] }),
  ])
  const r = nextWave(p.tasks)
  assert.deepEqual(r.wave.map(w => w.id), ['a', 'd', 'e', 'f'])
  assert.deepEqual(r.held, [{ id: 'b', overlaps: 'a' }, { id: 'c', overlaps: 'a' }])
  assert.deepEqual(Object.keys(r.wave[0]), ['id', 'title', 'executor', 'model', 'effort', 'stakes', 'files', 'verify'])
  const run = nextWave(withStatus(p, { f: 'running' }).tasks.concat())
  assert.deepEqual(run.running, ['f'])
  const p2 = plan([main('r', { files: ['lib/'] }), main('s', { files: ['lib/z.js'] }), main('t', { files: ['bin/t'] })])
  const r2 = nextWave(withStatus(p2, { r: 'running' }).tasks)
  assert.deepEqual(r2.wave.map(w => w.id), ['t'])
  assert.deepEqual(r2.held, [{ id: 's', overlaps: 'r' }])
  assert.equal(r2.finished, false)
  assert.deepEqual(r2.counts, { pending: 2, running: 1, done: 0, failed: 0, skipped: 0 })
  assert.equal(r2.total, 3)
})

test('blocked tasks say why: waiting-on, dependency-failed, needs-decision', () => {
  const p = plan([
    main('a'), main('b'), main('c', { depends_on: ['a', 'b'] }), main('d', { depends_on: ['b'] }), main('e', { needs_decision: 'which db?' }),
    main('f', { depends_on: ['x'] }), main('x'),
  ])
  const r = nextWave(withStatus(p, { a: 'done', b: 'failed', x: 'skipped' }).tasks)
  assert.deepEqual(r.wave, [])
  assert.deepEqual(r.blocked, [
    { id: 'c', reason: 'dependency-failed', dependencies: ['b'] },
    { id: 'd', reason: 'dependency-failed', dependencies: ['b'] },
    { id: 'e', reason: 'needs-decision', needs_decision: 'which db?' },
    { id: 'f', reason: 'dependency-failed', dependencies: ['x'] },
  ])
  const w = nextWave(withStatus(p, { a: 'running' }).tasks)
  assert.deepEqual(w.blocked.find(b => b.id === 'c'), { id: 'c', reason: 'waiting-on', dependencies: ['a', 'b'] })
  assert.deepEqual(w.wave.map(t => t.id), ['b', 'x'])
})

test('finished is true only when nothing is pending or running', () => {
  const p = plan([main('a'), main('b')])
  assert.equal(nextWave(withStatus(p, { a: 'done', b: 'running' }).tasks).finished, false)
  assert.equal(nextWave(withStatus(p, { a: 'done', b: 'failed' }).tasks).finished, true)
})

test('schedule gives the waves assuming success, decisions ignored and overlaps serialised', () => {
  const p = plan([
    main('a', { files: ['src/'] }), main('b', { files: ['src/b.js'] }), main('c', { depends_on: ['a'], needs_decision: 'ok?' }),
    main('d', { depends_on: ['b', 'c'] }), main('e'),
  ])
  assert.deepEqual(schedule(p.tasks), [['a', 'e'], ['b', 'c'], ['d']])
})

test('every legal transition, with its field changes', () => {
  let p = plan([main('a'), main('b')])
  let r = transition(p, 'a', 'running', { now: NOW })
  assert.deepEqual(p.tasks[0].status, 'pending', 'the argument is left as it was')
  p = r.plan
  assert.deepEqual(pick(p, 'a'), { status: 'running', attempts: 1, started_at: NOW, finished_at: null, result: null })
  p = transition(p, 'a', 'failed', { now: LATER, result: 'tests red' }).plan
  assert.deepEqual(pick(p, 'a'), { status: 'failed', attempts: 1, started_at: NOW, finished_at: LATER, result: 'tests red' })
  assert.equal(p.updated_at, LATER)
  p = transition(p, 'a', 'pending', { now: LATER }).plan
  assert.deepEqual(pick(p, 'a'), { status: 'pending', attempts: 1, started_at: null, finished_at: null, result: 'tests red' })
  p = transition(p, 'a', 'running', { now: LATER }).plan
  assert.deepEqual(pick(p, 'a'), { status: 'running', attempts: 2, started_at: LATER, finished_at: null, result: null })
  p = transition(p, 'a', 'done', { now: LATER, result: 'green' }).plan
  assert.deepEqual(pick(p, 'a'), { status: 'done', attempts: 2, started_at: LATER, finished_at: LATER, result: 'green' })
  for (const from of ['pending', 'running', 'failed']) {
    const q = transition(withStatus(p, { b: from }), 'b', 'skipped', { now: LATER })
    assert.equal(q.plan.tasks[1].status, 'skipped', `${from} -> skipped`)
    assert.equal(transition(q.plan, 'b', 'pending', { now: LATER }).plan.tasks[1].status, 'pending', 'skipped -> pending')
  }
  assert.deepEqual(validatePlan(p), [])
})

const pick = (p, id) => {
  const { status, attempts, started_at, finished_at, result } = p.tasks.find(t => t.id === id)
  return { status, attempts, started_at, finished_at, result }
}

test('illegal transitions are refused with a reason', () => {
  const p = plan([main('a'), main('b', { depends_on: ['a'] }), main('c', { needs_decision: 'pick one' })])
  const reason = (q, id, to, o = {}) => transition(q, id, to, { now: NOW, ...o }).refused?.reason
  assert.equal(reason(p, 'a', 'done'), 'illegal-transition')
  assert.equal(reason(p, 'a', 'failed'), 'illegal-transition')
  assert.equal(reason(p, 'a', 'pending'), 'illegal-transition')
  assert.equal(reason(withStatus(p, { a: 'running' }), 'a', 'pending'), 'illegal-transition')
  assert.equal(reason(withStatus(p, { a: 'failed' }), 'a', 'done'), 'illegal-transition')
  assert.equal(reason(withStatus(p, { a: 'skipped' }), 'a', 'running'), 'illegal-transition')
  assert.equal(reason(withStatus(p, { a: 'done' }), 'a', 'pending'), 'done-is-final')
  assert.equal(reason(withStatus(p, { a: 'done' }), 'a', 'skipped'), 'done-is-final')
  assert.equal(reason(p, 'zz', 'running'), 'unknown-task')
  assert.equal(reason(p, 'a', 'lost'), 'bad-status')
  assert.equal(reason(withStatus(p, { a: 'running' }), 'a', 'done', { result: 'x'.repeat(501) }), 'result-too-long')
  assert.equal(transition(withStatus(p, { a: 'running' }), 'a', 'done', { now: NOW, result: 'x'.repeat(500) }).plan.tasks[0].result.length, 500)
  // Not ready: an unfinished dependency, an open decision.
  assert.equal(reason(p, 'b', 'running'), 'not-ready')
  assert.match(transition(p, 'c', 'running', { now: NOW }).refused.detail, /pick one/)
})

test('force starts a task that is not ready, and nothing else', () => {
  const p = plan([main('a'), main('b', { depends_on: ['a'] })])
  const r = transition(p, 'b', 'running', { now: NOW, force: true })
  assert.equal(r.plan.tasks[1].status, 'running')
  assert.equal(transition(withStatus(p, { a: 'done' }), 'a', 'pending', { now: NOW, force: true }).refused.reason, 'done-is-final')
})

test('decide clears needs_decision, records the decision, and changes nothing else', () => {
  const p = plan([main('a', { needs_decision: 'postgres or sqlite?' })])
  const r = decide(p, 'a', { now: LATER, result: 'postgres' })
  assert.deepEqual(r.plan.tasks[0], { ...p.tasks[0], needs_decision: null, result: 'postgres' })
  assert.equal(r.plan.updated_at, LATER)
  assert.deepEqual(nextWave(r.plan.tasks).wave.map(w => w.id), ['a'])
  assert.deepEqual(decide(p, 'a', { now: LATER }).plan.tasks[0], { ...p.tasks[0], needs_decision: null })
  assert.equal(decide(r.plan, 'a', { now: LATER }).refused.reason, 'no-open-decision')
  assert.equal(decide(p, 'zz', { now: LATER }).refused.reason, 'unknown-task')
})

test('addTask appends a validated task: a retry depending on a failed task\'s replacement', () => {
  let p = plan([main('a'), main('b', { depends_on: ['a'] })])
  p = withStatus(p, { a: 'failed' })
  let r = addTask(p, main('a2', { title: 'redo a' }), { now: LATER })
  assert.equal(r.plan.tasks.length, 3)
  assert.equal(r.plan.tasks[2].status, 'pending')
  r = addTask(r.plan, main('b2', { depends_on: ['a2'] }), { now: LATER })
  p = r.plan
  assert.equal(p.updated_at, LATER)
  const n = nextWave(p.tasks)
  assert.deepEqual(n.wave.map(w => w.id), ['a2'])
  assert.deepEqual(n.blocked, [{ id: 'b', reason: 'dependency-failed', dependencies: ['a'] }, { id: 'b2', reason: 'waiting-on', dependencies: ['a2'] }])
  assert.deepEqual(kinds(addTask(p, main('a'), { now: LATER }).problems), ['duplicate-id'])
  assert.deepEqual(kinds(addTask(p, main('z', { depends_on: ['nope'] }), { now: LATER }).problems), ['unknown-dependency'])
  assert.deepEqual(kinds(addTask(p, { ...main('z'), status: 'done' }, { now: LATER }).problems), ['unknown-key'])
  assert.deepEqual(validatePlan(p), [])
})
