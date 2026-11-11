// tests/lib/plan-graph-cli.test.mjs
// scripts/plan-graph.mjs as a child process against a real temporary project (a git repository
// <P>) with TECH_LEAD_CACHE pointing at a temp dir and the clock fixed through TECH_LEAD_NOW: one
// JSON line per run and its exit code; create -> next -> mark through to finished; add; the
// default-run choice with zero, one and two open runs; a corrupt plan; usage errors.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { freshPlan } from '../../scripts/plan-graph.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'plan-graph.mjs')
// Keep the user's git config out of the fixture repositories; the CLI children inherit this.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const NOW = '2026-11-11T10:00:00.000Z'

const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

// A project: a fresh git repository, its cache root and a scratch dir for input files.
function project(t) {
  const P = tmp(t, 'tl-plan-')
  execFileSync('git', ['init', '-q', P])
  return { P, cache: tmp(t, 'tl-plan-cache-'), scratch: tmp(t, 'tl-plan-in-') }
}

// Runs the CLI; stdout must be exactly one JSON line. Returns {code, out}.
function run(fx, args, { now = NOW } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', cwd: os.tmpdir(), timeout: 60000,
    env: { ...process.env, TECH_LEAD_CACHE: fx.cache, TECH_LEAD_NOW: now },
  })
  assert.equal(r.error, undefined, String(r.error))
  const lines = r.stdout.split('\n')
  assert.equal(lines.length, 2, `one line, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  return { code: r.status, out: JSON.parse(lines[0]) }
}

let n = 0
const input = (fx, value) => {
  const f = path.join(fx.scratch, `in-${++n}.json`)
  fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value))
  return f
}
const main = (id, extra = {}) => ({ id, title: `task ${id}`, executor: 'main', model: null, ...extra })
const DRAFT = {
  goal: 'add a plan graph', session_model: 'fable',
  tasks: [
    { id: 'lib', title: 'pure module', executor: 'fast-worker', model: 'sonnet', files: ['scripts/lib/'], verify: 'node --test' },
    { id: 'cli', title: 'cli', executor: 'fast-worker', model: 'sonnet', files: ['scripts/lib/plan.mjs'], verify: 'node --test', depends_on: [] },
    main('docs', { depends_on: ['lib'], files: ['README.md'] }),
    { id: 'review', title: 'review', executor: 'codex', model: 'codex', depends_on: ['cli', 'docs'] },
  ],
}
const create = (fx, draft = DRAFT, now = NOW) => {
  const r = run(fx, ['create', fx.P, '--file', input(fx, draft)], { now })
  assert.equal(r.code, 0, JSON.stringify(r.out))
  return r.out
}

test('validate prints the wave schedule, or every problem with exit 3', t => {
  const fx = project(t)
  const ok = run(fx, ['validate', '--file', input(fx, DRAFT)])
  assert.equal(ok.code, 0)
  assert.deepEqual(ok.out, { state: 'valid', tasks: 4, waves: [['lib'], ['cli', 'docs'], ['review']] })
  const bad = run(fx, ['validate', '--file', input(fx, { goal: 'x', tasks: [main('a', { model: 'opus', colour: 'red' })], owner: 1 })])
  assert.equal(bad.code, 3)
  assert.equal(bad.out.state, 'invalid')
  assert.deepEqual(bad.out.problems.map(p => p.kind).sort(), ['main-has-model', 'unknown-key', 'unknown-key'])
  const notJson = run(fx, ['validate', '--file', input(fx, '{nope')])
  assert.equal(notJson.code, 3)
  assert.equal(notJson.out.problems[0].kind, 'not-json')
  const missing = run(fx, ['validate', '--file', path.join(fx.scratch, 'absent.json')])
  assert.equal(missing.code, 2)
  assert.equal(missing.out.error, 'io')
})

test('create -> next -> mark through to finished', t => {
  const fx = project(t)
  const c = create(fx)
  assert.match(c.run_id, /^20261111T100000Z-[0-9a-f]{4}$/)
  assert.equal(c.file, path.join(fx.cache, 'tech-lead', path.basename(path.dirname(path.dirname(c.file))), 'plans', `${c.run_id}.json`))
  assert.deepEqual(c.waves, [['lib'], ['cli', 'docs'], ['review']])
  const stored = JSON.parse(fs.readFileSync(c.file, 'utf8'))
  assert.equal(stored.project, fs.realpathSync.native(fx.P))
  assert.equal(stored.created_at, NOW)

  let nx = run(fx, ['next', fx.P])
  assert.equal(nx.code, 0)
  assert.deepEqual(nx.out.wave.map(w => w.id), ['lib'])
  assert.deepEqual(nx.out.held, [{ id: 'cli', overlaps: 'lib' }])
  assert.deepEqual(nx.out.blocked, [{ id: 'docs', reason: 'waiting-on', dependencies: ['lib'] }, { id: 'review', reason: 'waiting-on', dependencies: ['cli', 'docs'] }])
  assert.equal(nx.out.finished, false)
  assert.equal(nx.out.other_open_runs, undefined)

  const later = '2026-11-11T10:05:00.000Z'
  let m = run(fx, ['mark', fx.P, '--task', 'lib', '--status', 'running'], { now: later })
  assert.deepEqual(m, { code: 0, out: { state: 'marked', run_id: c.run_id, task: { id: 'lib', status: 'running', attempts: 1 }, finished: false } })
  assert.equal(JSON.parse(fs.readFileSync(c.file, 'utf8')).updated_at, later)
  nx = run(fx, ['next', fx.P])
  assert.deepEqual(nx.out.wave, [])
  assert.deepEqual(nx.out.running, ['lib'])
  assert.deepEqual(nx.out.held, [{ id: 'cli', overlaps: 'lib' }])
  assert.equal(run(fx, ['mark', fx.P, '--task', 'lib', '--status', 'done', '--result', 'green']).code, 0)
  nx = run(fx, ['next', fx.P])
  assert.deepEqual(nx.out.wave.map(w => w.id), ['cli', 'docs'])
  for (const id of ['cli', 'docs']) {
    assert.equal(run(fx, ['mark', fx.P, '--task', id, '--status', 'running']).code, 0)
    assert.equal(run(fx, ['mark', fx.P, '--task', id, '--status', 'done']).code, 0)
  }
  assert.equal(run(fx, ['mark', fx.P, '--task', 'review', '--status', 'running']).code, 0)
  m = run(fx, ['mark', fx.P, '--task', 'review', '--status', 'done', '--result', 'no findings'])
  assert.equal(m.out.finished, true)

  // Finished: no default run any more, but --run still reads it.
  assert.deepEqual(run(fx, ['next', fx.P]).code, 3)
  assert.equal(run(fx, ['next', fx.P]).out.reason, 'no-open-run')
  const st = run(fx, ['status', fx.P, '--run', c.run_id])
  assert.equal(st.code, 0)
  assert.equal(st.out.finished, true)
  assert.equal(st.out.goal, 'add a plan graph')
  assert.equal(st.out.session_model, 'fable')
  assert.deepEqual(st.out.counts, { pending: 0, running: 0, done: 4, failed: 0, skipped: 0 })
  assert.deepEqual(st.out.tasks.find(x => x.id === 'review'), { id: 'review', title: 'review', executor: 'codex', model: 'codex', status: 'done', attempts: 1, result: 'no findings' })
})

test('mark refuses illegal moves and not-ready starts, takes --force, and --decided clears a decision', t => {
  const fx = project(t)
  create(fx, { goal: 'g', tasks: [main('a'), main('b', { depends_on: ['a'] }), main('c', { needs_decision: 'sqlite or postgres?' })] })
  const refused = (args, reason) => {
    const r = run(fx, ['mark', fx.P, ...args])
    assert.equal(r.code, 3, JSON.stringify(r.out))
    assert.equal(r.out.state, 'refused')
    assert.equal(r.out.reason, reason)
    assert.equal(typeof r.out.detail, 'string')
  }
  refused(['--task', 'a', '--status', 'done'], 'illegal-transition')
  refused(['--task', 'b', '--status', 'running'], 'not-ready')
  refused(['--task', 'c', '--status', 'running'], 'not-ready')
  refused(['--task', 'zz', '--status', 'running'], 'unknown-task')
  refused(['--task', 'a', '--status', 'lost'], 'bad-status')
  refused(['--task', 'a', '--decided'], 'no-open-decision')
  assert.equal(run(fx, ['mark', fx.P, '--task', 'b', '--status', 'running', '--force']).out.task.status, 'running')
  assert.equal(run(fx, ['mark', fx.P, '--task', 'a', '--status', 'running']).code, 0)
  refused(['--task', 'a', '--status', 'done', '--result', 'x'.repeat(501)], 'result-too-long')
  assert.equal(run(fx, ['mark', fx.P, '--task', 'a', '--status', 'done']).code, 0)
  refused(['--task', 'a', '--status', 'pending'], 'done-is-final')

  const d = run(fx, ['mark', fx.P, '--task', 'c', '--decided', '--result', 'postgres'])
  assert.deepEqual(d.out.task, { id: 'c', status: 'pending', attempts: 0 })
  const nx = run(fx, ['next', fx.P])
  assert.deepEqual(nx.out.wave.map(w => w.id), ['c'])
  assert.equal(run(fx, ['status', fx.P]).out.tasks.find(x => x.id === 'c').result, 'postgres')
  // Usage: both or neither of --status and --decided, --force with --decided.
  for (const args of [['--task', 'c'], ['--task', 'c', '--status', 'running', '--decided'], ['--task', 'c', '--decided', '--force']]) {
    const r = run(fx, ['mark', fx.P, ...args])
    assert.equal(r.code, 2)
    assert.equal(r.out.error, 'usage')
  }
})

test('add appends a retry depending on a failed task\'s replacement', t => {
  const fx = project(t)
  const c = create(fx, { goal: 'g', tasks: [main('a'), main('b', { depends_on: ['a'] })] })
  run(fx, ['mark', fx.P, '--task', 'a', '--status', 'running'])
  run(fx, ['mark', fx.P, '--task', 'a', '--status', 'failed', '--result', 'wrong approach'])
  let nx = run(fx, ['next', fx.P])
  assert.deepEqual(nx.out.blocked, [{ id: 'b', reason: 'dependency-failed', dependencies: ['a'] }])
  assert.equal(nx.out.finished, false, 'b is still pending')
  assert.deepEqual(run(fx, ['add', fx.P, '--file', input(fx, main('a2', { title: 'redo a' }))]), { code: 0, out: { state: 'added', run_id: c.run_id, task: 'a2' } })
  assert.equal(run(fx, ['add', fx.P, '--file', input(fx, main('b2', { depends_on: ['a2'] }))]).code, 0)
  assert.equal(run(fx, ['mark', fx.P, '--task', 'b', '--status', 'skipped']).code, 0)
  nx = run(fx, ['next', fx.P])
  assert.deepEqual(nx.out.wave.map(w => w.id), ['a2'])
  assert.deepEqual(nx.out.blocked, [{ id: 'b2', reason: 'waiting-on', dependencies: ['a2'] }])
  const dup = run(fx, ['add', fx.P, '--file', input(fx, main('a2', { colour: 1 }))])
  assert.equal(dup.code, 3)
  assert.deepEqual(dup.out.problems.map(p => p.kind).sort(), ['duplicate-id', 'unknown-key'])
  assert.equal(run(fx, ['status', fx.P]).out.total, 4)
})

test('the default run: none, one, and the newest of two with other_open_runs', t => {
  const fx = project(t)
  assert.deepEqual(run(fx, ['list', fx.P]), { code: 0, out: { state: 'ok', runs: [] } })
  const none = run(fx, ['next', fx.P])
  assert.equal(none.code, 3)
  assert.deepEqual([none.out.state, none.out.reason], ['refused', 'no-open-run'])
  const first = create(fx, { goal: 'first', tasks: [main('a')] }, '2026-11-11T09:00:00Z')
  assert.equal(run(fx, ['next', fx.P]).out.run_id, first.run_id)
  assert.equal(run(fx, ['next', fx.P]).out.other_open_runs, undefined)
  const second = create(fx, { goal: 'second', tasks: [main('a')] }, '2026-11-11T09:30:00Z')
  const nx = run(fx, ['next', fx.P])
  assert.equal(nx.out.run_id, second.run_id)
  assert.equal(nx.out.other_open_runs, 1)
  const ls = run(fx, ['list', fx.P])
  assert.deepEqual(ls.out.runs.map(r => [r.run_id, r.goal, r.finished]), [[second.run_id, 'second', false], [first.run_id, 'first', false]])
  assert.deepEqual(ls.out.runs[0].counts, { pending: 1, running: 0, done: 0, failed: 0, skipped: 0 })
  // Finishing the newest makes the older one the default.
  run(fx, ['mark', fx.P, '--task', 'a', '--status', 'skipped'])
  const after = run(fx, ['next', fx.P])
  assert.equal(after.out.run_id, first.run_id)
  assert.equal(after.out.other_open_runs, undefined)
  const missing = run(fx, ['next', fx.P, '--run', '20200101T000000Z-0000'])
  assert.deepEqual([missing.code, missing.out.reason], [3, 'no-such-run'])
})

test('a corrupt plan is exit 2 corrupt-plan and is left as it is', t => {
  const fx = project(t)
  const c = create(fx, { goal: 'g', tasks: [main('a')] })
  const original = JSON.parse(fs.readFileSync(c.file, 'utf8'))
  fs.writeFileSync(c.file, '{"v": 1, ')
  for (const args of [['next', fx.P], ['list', fx.P], ['status', fx.P, '--run', c.run_id], ['mark', fx.P, '--task', 'a', '--status', 'running']]) {
    const r = run(fx, args)
    assert.equal(r.code, 2, JSON.stringify(r.out))
    assert.deepEqual([r.out.state, r.out.error], ['error', 'corrupt-plan'])
  }
  // Valid JSON that fails validation, and a plan copied in from another project.
  const plan = { ...original, tasks: [{ ...original.tasks[0], status: 'lost' }] }
  fs.writeFileSync(c.file, JSON.stringify(plan))
  const r = run(fx, ['next', fx.P])
  assert.equal(r.out.error, 'corrupt-plan')
  assert.equal(r.out.file, c.file)
  assert.deepEqual(r.out.problems.map(p => p.kind), ['bad-status'])
  assert.equal(fs.readFileSync(c.file, 'utf8'), JSON.stringify(plan), 'never repaired')
  fs.writeFileSync(c.file, JSON.stringify({ ...original, project: '/elsewhere' }))
  assert.deepEqual(run(fx, ['next', fx.P]).out.problems.map(p => p.kind), ['wrong-project'])
})

test('usage errors, a non-repository <P> and a bad clock are exit 2', t => {
  const fx = project(t)
  for (const args of [[], ['nope'], ['next'], ['next', fx.P, '--bogus', 'x'], ['create', fx.P], ['next', fx.P, '--run', 'latest'], ['validate', fx.P, '--file', 'x']]) {
    const r = run(fx, args)
    assert.equal(r.code, 2, JSON.stringify(args))
    assert.deepEqual([r.out.state, r.out.error], ['error', 'usage'])
  }
  const plain = tmp(t, 'tl-plan-plain-')
  const r = run(fx, ['next', plain])
  assert.equal(r.code, 2)
  assert.equal(r.out.error, 'not-a-repo')
  const clock = run(fx, ['list', fx.P], { now: 'soon' })
  assert.deepEqual([clock.code, clock.out.error], [2, 'bad-now'])
  // create refuses an invalid draft before it writes anything.
  const bad = run(fx, ['create', fx.P, '--file', input(fx, { goal: 'g', tasks: [main('a', { depends_on: ['a'] })] })])
  assert.equal(bad.code, 3)
  assert.equal(fs.existsSync(path.join(fx.cache, 'tech-lead')), false)
})

// Review findings (2026-11-11): each test below failed before its fix.

test('finding 4: the clock takes only a four-digit-year ISO-8601 UTC instant, and create writes only a valid plan', t => {
  const fx = project(t)
  for (const now of ['+010000-01-01T00:00:00.000Z', '2026-02-30T00:00:00Z', '2026-11-11T10:00:00+04:00', '2026-11-11', '1700000000000']) {
    const r = run(fx, ['create', fx.P, '--file', input(fx, { goal: 'g', tasks: [main('a')] })], { now })
    assert.deepEqual([r.code, r.out.state, r.out.error], [2, 'error', 'bad-now'], now)
  }
  assert.equal(fs.existsSync(path.join(fx.cache, 'tech-lead')), false, 'nothing written')
  assert.equal(run(fx, ['validate', '--file', input(fx, { goal: 'g', tasks: [main('a')] })], { now: '2026-11-11T10:00:00.5Z' }).code, 0)
  // The second end: a plan that fails validatePlan is never handed to the writer.
  const draft = { goal: 'g', tasks: [main('a')] }
  assert.throws(() => freshPlan(draft, { runId: '+0100000101T000000Z-abcd', project: '/repo', now: '+010000-01-01T00:00:00.000Z' }),
    e => e.error === 'invalid-plan' && e.extra.problems.some(p => p.kind === 'bad-run-id'))
  assert.equal(freshPlan(draft, { runId: '20261111T100000Z-abcd', project: '/repo', now: NOW }).run_id, '20261111T100000Z-abcd')
})

test('finding 2: mark refuses to start a task whose files a running task holds, unless --force', t => {
  const fx = project(t)
  create(fx, { goal: 'g', tasks: [main('a', { files: ['src/x.js'] }), main('b', { files: ['SRC/'] })] })
  assert.equal(run(fx, ['mark', fx.P, '--task', 'a', '--status', 'running']).code, 0)
  const r = run(fx, ['mark', fx.P, '--task', 'b', '--status', 'running'])
  assert.deepEqual([r.code, r.out.state, r.out.reason], [3, 'refused', 'files-held'])
  assert.match(r.out.detail, /\ba\b/)
  assert.equal(run(fx, ['mark', fx.P, '--task', 'b', '--status', 'running', '--force']).out.task.status, 'running')
})

test('--json passes the draft inline: validate, create and add accept it; both or neither of --file and --json is a usage error', t => {
  const fx = project(t)
  const draft = JSON.stringify({ goal: 'inline', tasks: [{ id: 'a', title: 't', executor: 'main' }] })
  assert.equal(run(fx, ['validate', '--json', draft]).out.state, 'valid')
  const made = run(fx, ['create', fx.P, '--json', draft])
  assert.equal(made.code, 0)
  assert.equal(made.out.state, 'created')
  const added = run(fx, ['add', fx.P, '--json', JSON.stringify({ id: 'b', title: 't', executor: 'main', depends_on: ['a'] })])
  assert.equal(added.out.state, 'added')
  assert.equal(run(fx, ['status', fx.P]).out.total, 2)
  const bad = run(fx, ['validate', '--json', '{not json'])
  assert.equal(bad.code, 3)
  assert.equal(bad.out.problems[0].kind, 'not-json')
  assert.equal(run(fx, ['validate']).code, 2)
  assert.equal(run(fx, ['validate', '--json', draft, '--file', '/dev/null']).code, 2)
})
