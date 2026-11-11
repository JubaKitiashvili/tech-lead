#!/usr/bin/env node
// scripts/plan-graph.mjs
// The plan-graph CLI: the /tech-lead run's plan as a JSON file, so that code, not the model, does
// the bookkeeping (validation, which tasks can run now, status, resume after compaction or in a
// new session). It never runs an agent and never decides anything. All plan logic is
// scripts/lib/plan-graph.mjs's; this file reads and writes the plan file and prints.
//
// Layout: <V>/plans/<run_id>.json, <V> from loop-paths.mjs (<P> must be the top level of a git
// working tree, as for every loop helper), run_id = <UTC yyyymmddThhmmssZ>-<4 lower-case hex>.
// A plan is created with createExclusive and every change is written whole with writeReplace
// (atomic.mjs), updated_at set; <V>/plans is checked with storageDir before any read or write.
// A plan file that does not parse, or fails validatePlan, or whose run_id or project is not its
// own, is never repaired: exit 2 corrupt-plan. Read-modify-write is not locked: two concurrent
// writers to one plan can lose an update (one lead session owns a run).
// The clock is TECH_LEAD_NOW when set, else the real clock. TECH_LEAD_NOW must be a four-digit-year
// ISO-8601 UTC instant (yyyy-mm-ddThh:mm:ss[.sss]Z, a real time: isIsoInstant), else exit 2 bad-now.
// create validates the finished plan (run id and timestamps included) before it writes it, as
// every other write does: a plan that fails validatePlan is exit 2 invalid-plan {problems},
// never written.
//
// Usage: node plan-graph.mjs <command> [<P>] [flags]; one JSON line on stdout, exit 0 (ok), 2
// ({state:'error', error, detail}: usage, bad-now, not-a-repo, not-toplevel, bad-cache,
// identity-mismatch, io, corrupt-plan {file, problems}, invalid-plan {problems}) or 3 ({state:'invalid', problems:[{task,
// kind, detail}]}, {state:'refused', reason, detail}, or {state:'clone-invalid', detail} when
// <V>/plans is not a real directory in <V>).
//   validate --file <draft.json>              -> {state:'valid', tasks, waves:[[id]]} (waves: the
//                                                schedule if every task succeeds, decisions ignored)
//   create <P> --file <draft.json>            -> {state:'created', run_id, file, tasks, waves}
//   next <P> [--run <id>]                     -> {state:'ok', run_id, file, wave:[{id, title, executor,
//                                                model, effort, stakes, files, verify}], held:[{id,
//                                                overlaps}], blocked:[{id, reason, dependencies |
//                                                needs_decision}], running:[id], counts, total, finished}
//   mark <P> --task <id> --status <s> [--result <text>] [--force] [--run <id>]
//   mark <P> --task <id> --decided [--result <text>] [--run <id>]
//                                             -> {state:'marked', run_id, task:{id, status, attempts},
//                                                finished}; refused: unknown-task, bad-status,
//                                                done-is-final, illegal-transition, not-ready,
//                                                files-held (its files overlap a running task's;
//                                                --force starts it anyway), result-too-long,
//                                                no-open-decision
//   add <P> --file <task.json> [--run <id>]   -> {state:'added', run_id, task: id}
//   status <P> [--run <id>]                   -> {state:'ok', run_id, file, goal, session_model, counts,
//                                                total, finished, tasks:[{id, title, executor, model,
//                                                status, attempts, result}]}
//   list <P>                                  -> {state:'ok', runs:[{run_id, file, goal, created_at,
//                                                finished, counts}]} newest first
// Without --run a command takes the newest plan that is not finished (run_ids sort by time);
// none: exit 3 refused no-open-run; more than one: the newest, with other_open_runs: <n others>.
// A --run naming no plan: exit 3 refused no-such-run. An unreadable or non-JSON input file: exit
// 2 io, or exit 3 invalid not-json.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExclusive, readJson, storageDir, writeReplace } from './lib/atomic.mjs'
import { ensureV } from './lib/loop-paths.mjs'
import {
  RUN_ID_RE, addTask, buildPlan, decide, draftTasks, isIsoInstant, nextWave, runIdOf, schedule, transition, validateDraft,
  validatePlan,
} from './lib/plan-graph.mjs'
import { openPaths } from './loop-lock.mjs'

const USAGE = 'usage: plan-graph.mjs validate --file <draft.json> | create <P> --file <draft.json> | next <P> [--run <id>]' +
  ' | mark <P> --task <id> (--status <s> [--force] | --decided) [--result <text>] [--run <id>]' +
  ' | add <P> --file <task.json> [--run <id>] | status <P> [--run <id>] | list <P>'
// The flags each command takes (a boolean one has no value), the ones it needs, and whether it takes <P>.
const FLAGS = {
  validate: ['file'], create: ['file'], next: ['run'], mark: ['task', 'status', 'result', 'force', 'decided', 'run'],
  add: ['file', 'run'], status: ['run'], list: [],
}
const BOOLEAN = new Set(['force', 'decided'])
const REQUIRED = { validate: ['file'], create: ['file'], mark: ['task'], add: ['file'] }
const RUN_FILE = /^(\d{8}T\d{6}Z-[0-9a-f]{4})\.json$/
const CREATE_ATTEMPTS = 8

class Refused extends Error {
  constructor(out) {
    super(out.detail || out.state)
    this.out = out
  }
}
class Failed extends Error {
  constructor(error, detail, extra = {}) {
    super(detail)
    this.error = error
    this.extra = extra
  }
}
const usage = detail => new Failed('usage', detail ? `${detail}; ${USAGE}` : USAGE)
const refuse = (reason, detail) => new Refused({ state: 'refused', reason, detail })
const invalid = problems => new Refused({ state: 'invalid', problems })

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!Object.hasOwn(FLAGS, command ?? '')) throw usage()
  const opts = {}, pos = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const key = a.slice(2)
    if (!a.startsWith('--')) pos.push(a)
    else if (!FLAGS[command].includes(key) || Object.hasOwn(opts, key)) throw usage(`${a} is not a flag of ${command}, or is given twice`)
    else if (BOOLEAN.has(key)) opts[key] = true
    else if (i + 1 < rest.length) opts[key] = rest[++i]
    else throw usage(`${a} needs a value`)
  }
  if (pos.length !== (command === 'validate' ? 0 : 1)) throw usage(`${command} takes ${command === 'validate' ? 'no' : 'exactly one'} <P>`)
  const missing = (REQUIRED[command] ?? []).filter(k => !Object.hasOwn(opts, k))
  if (missing.length) throw usage(`${command} needs --${missing.join(', --')}`)
  if (command === 'mark') {
    if (Boolean(opts.decided) === Object.hasOwn(opts, 'status')) throw usage('mark takes exactly one of --status <s> and --decided')
    if (opts.decided && opts.force) throw usage('--force goes with --status, not --decided')
  }
  if (Object.hasOwn(opts, 'run') && !RUN_ID_RE.test(opts.run)) throw usage(`--run takes a run id <yyyymmddThhmmssZ>-<4 hex>, not ${JSON.stringify(opts.run)}`)
  return { command, P: pos[0], opts }
}

function clock(env) {
  if (!env.TECH_LEAD_NOW) return new Date().toISOString()
  if (!isIsoInstant(env.TECH_LEAD_NOW)) {
    throw new Failed('bad-now', `TECH_LEAD_NOW is not a four-digit-year ISO-8601 UTC instant (yyyy-mm-ddThh:mm:ss[.sss]Z): ${JSON.stringify(env.TECH_LEAD_NOW)}`)
  }
  return new Date(env.TECH_LEAD_NOW).toISOString()
}

// An input file's JSON value: exit 2 io when it cannot be read, exit 3 invalid when it is not JSON.
function readInput(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new Failed('io', `${file}: ${e.code || e.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw invalid([{ task: null, kind: 'not-json', detail: `${file} is not JSON: ${e.message}` }])
  }
}

const plansDir = (paths, create) => storageDir(paths.V, path.join(paths.V, 'plans'), { create })

// One plan, read and checked: null when the file is missing.
function loadPlan(paths, dir, runId) {
  const file = path.join(dir, `${runId}.json`)
  let plan
  try {
    plan = readJson(file)
  } catch (e) {
    if (/^corrupt: /.test(e.message)) throw new Failed('corrupt-plan', `${file} is not a JSON object or not a regular file`, { file, problems: [] })
    throw new Failed('io', `${file}: ${e.code || e.message}`)
  }
  if (plan === null) return null
  const problems = validatePlan(plan)
  if (plan.run_id !== runId) problems.push({ task: null, kind: 'wrong-run-id', detail: `the file is named ${runId} but holds run_id ${JSON.stringify(plan.run_id)}` })
  if (plan.project !== paths.R) problems.push({ task: null, kind: 'wrong-project', detail: `the plan belongs to ${JSON.stringify(plan.project)}, not ${paths.R}` })
  if (problems.length) throw new Failed('corrupt-plan', `${file} fails validation (${problems.length} problem${problems.length === 1 ? '' : 's'})`, { file, problems })
  return { file, plan }
}

// Every plan of the project, newest first.
function allPlans(paths) {
  const dir = plansDir(paths, false)
  if (!dir) return []
  const ids = fs.readdirSync(dir).map(n => RUN_FILE.exec(n)?.[1]).filter(Boolean).sort().reverse()
  return ids.map(id => loadPlan(paths, dir, id)).filter(Boolean)
}

const isFinished = plan => nextWave(plan.tasks).finished

// The run a command acts on: --run, else the newest unfinished plan. {file, plan, other}.
function selectRun(paths, run) {
  if (run !== undefined) {
    const dir = plansDir(paths, false)
    const got = dir && loadPlan(paths, dir, run)
    if (!got) throw refuse('no-such-run', `no plan ${run} for ${paths.R}`)
    return { ...got, other: 0 }
  }
  const open = allPlans(paths).filter(p => !isFinished(p.plan))
  if (open.length === 0) throw refuse('no-open-run', `no unfinished plan for ${paths.R}; pass --run <id> to read a finished one`)
  return { ...open[0], other: open.length - 1 }
}

const others = n => (n > 0 ? { other_open_runs: n } : {})

// A plan is written only once it passes validatePlan; one that does not is a bug here.
function checked(plan) {
  const problems = validatePlan(plan)
  if (problems.length) throw new Failed('invalid-plan', `refusing to write a plan that fails validation (${problems.map(p => p.kind).join(', ')})`, { problems })
  return plan
}

// The plan create writes, validated: throws invalid-plan instead of returning one that fails.
export const freshPlan = (draft, { runId, project, now }) => checked(buildPlan(draft, { runId, project, now }))

function save(file, plan) {
  writeReplace(file, checked(plan))
}

function changed(r) {
  if (r.refused) throw refuse(r.refused.reason, r.refused.detail)
  if (r.problems) throw invalid(r.problems)
  return r.plan
}

const COMMANDS = {
  validate(_P, { file }) {
    const draft = readInput(file)
    const problems = validateDraft(draft)
    if (problems.length) throw invalid(problems)
    return { state: 'valid', tasks: draft.tasks.length, waves: schedule(draftTasks(draft)) }
  },

  create(P, { file: input }, env) {
    const base = openPaths(P, env)
    const draft = readInput(input)
    const problems = validateDraft(draft)
    if (problems.length) throw invalid(problems)
    const paths = ensureV(base)
    const dir = plansDir(paths, true)
    const now = clock(env)
    for (let i = 0; i < CREATE_ATTEMPTS; i++) {
      const runId = runIdOf(now, crypto.randomBytes(2).toString('hex'))
      const plan = freshPlan(draft, { runId, project: paths.R, now })
      const file = path.join(dir, `${runId}.json`)
      if (createExclusive(file, plan)) return { state: 'created', run_id: runId, file, tasks: plan.tasks.length, waves: schedule(plan.tasks) }
    }
    throw new Failed('io', `could not find a free run id in ${dir} after ${CREATE_ATTEMPTS} attempts`)
  },

  next(P, { run }, env) {
    const { file, plan, other } = selectRun(openPaths(P, env), run)
    return { state: 'ok', run_id: plan.run_id, file, ...nextWave(plan.tasks), ...others(other) }
  },

  mark(P, { task, status, result, force, decided, run }, env) {
    const { file, plan, other } = selectRun(openPaths(P, env), run)
    const now = clock(env)
    const next = changed(decided ? decide(plan, task, { now, result }) : transition(plan, task, status, { now, result, force: Boolean(force) }))
    save(file, next)
    const t = next.tasks.find(x => x.id === task)
    return { state: 'marked', run_id: next.run_id, task: { id: t.id, status: t.status, attempts: t.attempts }, finished: isFinished(next), ...others(other) }
  },

  add(P, { file: input, run }, env) {
    const { file, plan, other } = selectRun(openPaths(P, env), run)
    const draftTask = readInput(input)
    const next = changed(addTask(plan, draftTask, { now: clock(env) }))
    save(file, next)
    return { state: 'added', run_id: next.run_id, task: draftTask.id, ...others(other) }
  },

  status(P, { run }, env) {
    const { file, plan, other } = selectRun(openPaths(P, env), run)
    const { counts, total, finished } = nextWave(plan.tasks)
    return {
      state: 'ok', run_id: plan.run_id, file, goal: plan.goal, session_model: plan.session_model, counts, total, finished,
      tasks: plan.tasks.map(({ id, title, executor, model, status, attempts, result }) => ({ id, title, executor, model, status, attempts, result })),
      ...others(other),
    }
  },

  list(P, _opts, env) {
    const runs = allPlans(openPaths(P, env)).map(({ file, plan }) => {
      const { counts, finished } = nextWave(plan.tasks)
      return { run_id: plan.run_id, file, goal: plan.goal, created_at: plan.created_at, finished, counts }
    })
    return { state: 'ok', runs }
  },
}

// Runs one command line: {code, out}, never throws.
export function cli(argv, env = process.env) {
  try {
    const { command, P, opts } = parseArgs(argv)
    if (env.TECH_LEAD_NOW !== undefined) clock(env)
    return { code: 0, out: COMMANDS[command](P, opts, env) }
  } catch (e) {
    if (e instanceof Refused) return { code: 3, out: e.out }
    if (e instanceof Failed) return { code: 2, out: { state: 'error', error: e.error, detail: e.message, ...e.extra } }
    if (e.code === 'CLONE_INVALID') return { code: 3, out: { state: 'clone-invalid', detail: e.message } }
    const m = /^([a-z][a-z-]*): /.exec(e.message || '')
    return { code: 2, out: { state: 'error', error: m ? m[1] : 'io', detail: e.message } }
  }
}

function main(argv) {
  const { code, out } = cli(argv)
  process.stdout.write(`${JSON.stringify(out)}\n`)
  return code
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
