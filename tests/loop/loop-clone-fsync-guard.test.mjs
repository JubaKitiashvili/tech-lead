// tests/loop/loop-clone-fsync-guard.test.mjs
// Publication after a lock lost during the fsync (closing review F6; sharpened R31): the holder
// is killed while a helper fsyncs the temporary file it is about to publish (a --require
// preload, tests/fixtures/fsync-hook.cjs, kills it right after that fsync). The guard inside the
// atomic publication runs after the fsync, so nothing is published, the temp is gone and the
// helper reports not-holder. Covered: the save's run-record write and bundle link
// (reflex-bundle.mjs), deps --mark, close's run anchor, writeBundle's sidecar, and the clone
// helper's own record writes (prepare's new record, check --after deps's rules, commit's intent).
// Real repositories and processes, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import {
  D2, PREFIX, T, appendLedger, attempt, check, commitCli, firing, prepare, prepareArgs, project, recordOf, run, tipOf, write,
} from './loop-clone-fixture.mjs'
import { sidecarPath, writeBundle } from '../../scripts/lib/delivery.mjs'

const HOOK = path.join(ROOT, 'tests', 'fixtures', 'fsync-hook.cjs')
const REFLEX = path.join(ROOT, 'scripts', 'reflex-bundle.mjs')
const BRANCH = `${PREFIX}/${D2}`

// The environment that kills the holder right after the nth fsync of a matching entry of dir;
// out is the file the hook names the entry in when it fires.
function hooked(fx, { dir, match = '^\\.tmp-', nth = 1 }) {
  const out = path.join(fx.root, `fsync-hook-${process.hrtime.bigint()}`)
  const env = {
    ...fx.env, NODE_OPTIONS: `--require ${HOOK}`, FSYNC_HOOK_DIR: dir, FSYNC_HOOK_MATCH: match,
    FSYNC_HOOK_NTH: String(nth), FSYNC_HOOK_KILL: String(fx.holder), FSYNC_HOOK_OUT: out,
  }
  const fired = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : [])
  return { env, fired }
}

const temps = dir => {
  try { return fs.readdirSync(dir).filter(n => n.startsWith('.tmp-')) } catch { return [] }
}
const bundles = fx => {
  try { return fs.readdirSync(path.join(fx.V, 'patches')).filter(n => /^[0-9a-f]{64}\.patch$/.test(n)) } catch { return [] }
}

function save(fx, env) {
  const r = spawnSync(process.execPath, [REFLEX, 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env })
  let out = null
  try { out = JSON.parse(r.stdout.trim()) } catch { out = null }
  return { status: r.status, out, stderr: r.stderr }
}

async function preparedWithEdit(t) {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'b.txt', 'saved\n')
  return fx
}

test('save: a lock lost during the run record\'s fsync writes no record; not-holder (F6)', T, async t => {
  const fx = await preparedWithEdit(t)
  const runDir = path.join(fx.V, 'run')
  const before = recordOf(fx)
  const h = hooked(fx, { dir: runDir })
  const r = save(fx, h.env)
  assert.equal(h.fired().length, 1, `the holder was killed during the record's fsync (stderr ${r.stderr})`)
  assert.equal(r.status, 3, JSON.stringify(r.out))
  assert.equal(r.out.state, 'not-holder')
  assert.deepEqual(recordOf(fx), before, 'the record is unchanged')
  assert.deepEqual(temps(runDir), [], 'no temp record is left')
})

test('save: a lock lost during the bundle\'s fsync before its link publishes no bundle; not-holder (F6)', T, async t => {
  const fx = await preparedWithEdit(t)
  const store = path.join(fx.V, 'patches')
  // The .patch temp is fsynced twice: once written, then by commitExclusive right before its link.
  const h = hooked(fx, { dir: store, match: '^\\.tmp-.*\\.patch$', nth: 2 })
  const r = save(fx, h.env)
  assert.equal(h.fired().length, 1, `the holder was killed during commitExclusive's fsync (stderr ${r.stderr})`)
  assert.equal(r.status, 3, JSON.stringify(r.out))
  assert.equal(r.out.state, 'not-holder')
  assert.deepEqual(bundles(fx), [], 'no bundle is published')
  assert.deepEqual(temps(store), [], 'no temp is left')
  assert.equal(recordOf(fx).phase, 'prepared')
})

test('deps --mark: a lock lost during the marker\'s fsync publishes no marker and leaves no temp; not-holder (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const gitDir = path.join(fx.W, '.git')
  const h = hooked(fx, { dir: gitDir })
  const out = run(h.env, 3, 'deps', fx.P, '--generation', String(fx.N), '--mark')
  assert.equal(h.fired().length, 1, 'the holder was killed during the marker\'s fsync')
  assert.equal(out.state, 'not-holder')
  assert.equal(fs.existsSync(path.join(gitDir, 'tech-lead-deps.ok')), false, 'no marker')
  assert.deepEqual(temps(gitDir), [], 'no temp in <W>/.git')
})

test('close: a lock lost during the run anchor\'s fsync writes no anchor and deletes no record; not-holder (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  const runDir = path.join(fx.V, 'run')
  const h = hooked(fx, { dir: runDir })
  const out = run(h.env, 3, 'close', fx.P, '--generation', String(fx.N))
  assert.equal(h.fired().length, 1, 'the holder was killed during the anchor\'s fsync')
  assert.equal(out.state, 'not-holder')
  assert.equal(fs.existsSync(path.join(runDir, 'refs.json')), false, 'no run anchor')
  assert.equal(recordOf(fx).phase, 'committed', 'the record is kept')
  assert.deepEqual(temps(runDir), [])
})

test('writeBundle: the guard runs again after the sidecar\'s fsync, right before its rename; a throw there publishes no sidecar (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  attempt(fx, W => write(W, 'one.txt', '1\n'))
  const side = sidecarPath(fx.paths, BRANCH)
  const dir = path.dirname(side)
  fs.rmSync(side)
  const seen = []
  const guard = () => {
    const tmp = temps(dir).filter(n => !n.endsWith('.bundle'))
    seen.push(tmp.map(n => fs.readFileSync(path.join(dir, n), 'utf8')))
    if (seen.length === 3) throw Object.assign(new Error('not-holder: released'), { code: 'NOT_HOLDER' })
  }
  assert.throws(() => writeBundle(fx.paths, BRANCH, { why: 'regenerated', guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(seen.length, 3)
  assert.equal(seen[2].length, 1, 'the sidecar temp existed when the guard ran')
  assert.equal(JSON.parse(seen[2][0]).tip.length, 40, 'it held the whole sidecar')
  assert.equal(fs.existsSync(side), false, 'no sidecar is published')
  assert.deepEqual(temps(dir), [], 'no temp is left')
})

test('prepare: a lock lost during the new run record\'s fsync creates no record; not-holder (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  const runDir = path.join(fx.V, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const h = hooked(fx, { dir: runDir })
  const out = run(h.env, 3, ...prepareArgs(fx))
  assert.equal(h.fired().length, 1, 'the holder was killed during the record\'s fsync')
  assert.equal(out.state, 'not-holder')
  assert.equal(recordOf(fx), null, 'no record of this generation')
  assert.deepEqual(temps(runDir), [])
})

test('check --after deps: a lock lost during the record\'s fsync leaves the record as it was; not-holder (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const runDir = path.join(fx.V, 'run')
  const before = recordOf(fx)
  const h = hooked(fx, { dir: runDir })
  const out = check(fx, 'deps', { status: 3, env: h.env })
  assert.equal(h.fired().length, 1, 'the holder was killed during the record\'s fsync')
  assert.equal(out.state, 'not-holder')
  assert.deepEqual(recordOf(fx), before, 'the record is unchanged')
  assert.deepEqual(temps(runDir), [])
})

test('commit: a lock lost during the intent\'s fsync records no intent and moves no ref; not-holder (F6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'one.txt', '1\n')
  const c = check(fx, 'dispatch')
  const runDir = path.join(fx.V, 'run')
  const before = recordOf(fx)
  const head = tipOf(fx.W)
  const h = hooked(fx, { dir: runDir })
  const out = commitCli(fx, c.digest, { status: 3, env: h.env })
  assert.equal(h.fired().length, 1, 'the holder was killed during the intent\'s fsync')
  assert.equal(out.state, 'not-holder')
  assert.deepEqual(recordOf(fx), before, 'no intent is recorded')
  assert.equal(tipOf(fx.W), head, 'the branch did not move')
  assert.deepEqual(temps(runDir), [])
})
