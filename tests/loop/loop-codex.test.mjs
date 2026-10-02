// tests/loop/loop-codex.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { compareVersions, locateCompanion, parseTrailer, processAlive } from '../../scripts/loop-codex.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-codex.mjs')
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'codex', 'scripts', 'codex-companion.mjs')
const ago = min => new Date(Date.now() - min * 60000).toISOString()
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-codex-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
// A real process standing in for a broker or a worker. It is started through a shell that
// exits at once, so the test runner is not its parent and a killed one never lingers as a zombie.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}

// Runs loop-codex.mjs against the fake companion (or scenario.companion) and returns
// its exit status, its parsed JSON line, and the calls it made.
const run = (t, scenario, ...args) => {
  const dir = tmp(t)
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify(scenario))
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: 'this-session', TECH_LEAD_CODEX_COMPANION: scenario.companion ?? FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, calls }
}
const W = ['--cwd', '/w']
const CAP = ['--cap-min', '45']

test('versions compare numerically, so 1.0.10 is newer than 1.0.9', () => {
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  assert.ok(compareVersions('2.0.0', '10.0.0') < 0)
})

test('locateCompanion picks the newest installed version, honours the override, and finds nothing when absent', t => {
  const home = tmp(t)
  const base = path.join(home, '.claude/plugins/cache/openai-codex/codex')
  for (const v of ['1.0.9', '1.0.10', 'next']) {
    fs.mkdirSync(path.join(base, v, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(base, v, 'scripts/codex-companion.mjs'), '')
  }
  assert.equal(locateCompanion({}, home), path.join(base, '1.0.10/scripts/codex-companion.mjs'))
  assert.equal(locateCompanion({ TECH_LEAD_CODEX_COMPANION: FAKE }, home), FAKE)
  assert.equal(locateCompanion({ TECH_LEAD_CODEX_COMPANION: path.join(home, 'missing.mjs') }, home), null)
  assert.equal(locateCompanion({}, tmp(t)), null)
})

test('start validates the cap, then launches a background write job and returns its id', t => {
  const r = run(t, { jobId: 'task-1' }, 'start', ...W, '--prompt-file', '/s/briefs/x.md', ...CAP)
  assert.equal(r.status, 0)
  assert.deepEqual(r.out, { state: 'started', jobId: 'task-1' })
  assert.deepEqual(r.calls, [['task', '--background', '--json', '--write', '--cwd', '/w', '--prompt-file', '/s/briefs/x.md']])
  for (const cap of ['0', 'Infinity', '-5', 'NaN', '45m']) {
    const bad = run(t, { jobId: 'task-1' }, 'start', ...W, '--prompt-file', '/b.md', '--cap-min', cap)
    assert.equal(bad.status, 2, cap)
    assert.deepEqual(bad.calls, [], cap)
  }
})

test('reproduction (loop09): with no companion, start exits 3 and never runs node on an empty path', t => {
  const missing = run(t, { jobId: 'task-1', companion: '/nonexistent/codex-companion.mjs' }, 'start', ...W, '--prompt-file', '/b.md', ...CAP)
  assert.equal(missing.status, 3)
  assert.equal(missing.out.state, 'unavailable')
  assert.deepEqual(missing.calls, [])
  const notInstalled = run(t, { taskError: 'Codex CLI is not installed' }, 'start', ...W, '--prompt-file', '/b.md', ...CAP)
  assert.equal(notInstalled.status, 3)
  assert.match(notInstalled.out.detail, /not installed/)
})

test('wait reports running, cap and each ended state, and never waits past the cap or 9 minutes', t => {
  const wait = sc => run(t, { jobId: 'j', ...sc }, 'wait', 'j', ...W, ...CAP)
  assert.equal(wait({ status: 'running', startedAt: ago(50) }).out.state, 'cap')
  for (const s of ['completed', 'failed', 'cancelled']) assert.equal(wait({ status: s, startedAt: ago(5) }).out.state, s)
  const early = wait({ status: 'running', startedAt: ago(10) })
  assert.equal(early.out.state, 'running')
  const slice = c => Number(c[c.indexOf('--timeout-ms') + 1])
  assert.equal(slice(early.calls.find(c => c.includes('--wait'))), 540000)
  const late = wait({ status: 'running', startedAt: ago(40) })
  const s = slice(late.calls.find(c => c.includes('--wait')))
  assert.ok(s > 290000 && s <= 300000, `slice ${s}`)
})

test('wait survives one failed status read, but reports error when the job cannot be read', t => {
  const once = run(t, { jobId: 'j', status: 'running', startedAt: ago(10), statusErrorOnce: true }, 'wait', 'j', ...W, ...CAP)
  assert.equal(once.out.state, 'running')
  const gone = run(t, { statusError: 'No job found for "zz".' }, 'wait', 'zz', ...W, ...CAP)
  assert.equal(gone.status, 0)
  assert.equal(gone.out.state, 'error')
  assert.match(gone.out.detail, /No job found/)
})

test('result returns the raw answer and flags a missing or non-none trailer; no stored report is an error', t => {
  const result = (sc, raw) => run(t, { jobId: 'j', status: 'completed', rawOutput: raw, ...sc }, 'result', 'j', ...W)
  const ok = result({}, 'Did it.\nJUDGMENT CALLS: none\nSKIPPED: none\n').out
  assert.equal(ok.answer, 'Did it.\nJUDGMENT CALLS: none\nSKIPPED: none\n')
  assert.deepEqual(ok.trailer, { judgmentCalls: 'none', skipped: 'none' })
  assert.equal(ok.flagged, false)
  assert.equal(result({}, 'Did it.\nJUDGMENT CALLS: chose the v2 API\nSKIPPED: none').out.flagged, true)
  assert.deepEqual(result({}, 'Did it.').out, { answer: 'Did it.', trailer: null, flagged: true })
  assert.deepEqual(parseTrailer('JUDGMENT CALLS: none\nSKIPPED: none\n\n'), { trailer: { judgmentCalls: 'none', skipped: 'none' }, flagged: false })
  const missing = result({ noStoredJob: true }, null)
  assert.equal(missing.status, 1)
  assert.equal(missing.out.state, 'error')
})

test('quiesce cancels active jobs across sessions, shuts down the broker, and proves both processes gone', t => {
  const broker = sleeper(t), worker = sleeper(t)
  const r = run(t, { jobId: 'j', status: 'completed', broker: { pid: broker, endpoint: 'unix:/tmp/x.sock' }, active: [{ id: 'j2', pid: worker, status: 'running' }] }, 'quiesce', ...W, '--job', 'j')
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.equal(r.out.final, 'completed')
  assert.ok(!processAlive(broker) && !processAlive(worker))
  assert.deepEqual(r.calls.find(c => c[0] === 'env:CODEX_COMPANION_SESSION_ID'), ['env:CODEX_COMPANION_SESSION_ID', null])
  assert.ok(r.calls.some(c => c[0] === 'cancel' && c[1] === 'j2'))
  assert.ok(r.calls.some(c => c[0] === 'lib:sendBrokerShutdown'))
})

test('reproduction (cx-lp04): an acknowledged interrupt is not enough; a broker that survives shutdown is not quiet', t => {
  const broker = sleeper(t)
  const r = run(t, { jobId: 'j', status: 'running', startedAt: ago(50), turnInterrupted: true, broker: { pid: broker, endpoint: 'e' }, stubborn: [broker], active: [] }, 'quiesce', ...W, '--job', 'j')
  assert.equal(r.out.quiet, false)
  assert.match(r.out.detail, new RegExp(`pid ${broker}`))
})

test('quiesce is not quiet when a worker survives its cancel, the jobs cannot be listed, or the broker API is missing', t => {
  const worker = sleeper(t)
  assert.equal(run(t, { jobId: 'j', status: 'running', active: [{ id: 'j', pid: worker }], stubborn: [worker] }, 'quiesce', ...W).out.quiet, false)
  assert.equal(run(t, { listError: 'state unreadable' }, 'quiesce', ...W).out.quiet, false)
  const bare = tmp(t)
  fs.copyFileSync(FAKE, path.join(bare, 'codex-companion.mjs'))
  const noLib = run(t, { companion: path.join(bare, 'codex-companion.mjs'), active: [] }, 'quiesce', ...W)
  assert.equal(noLib.out.quiet, false)
  assert.match(noLib.out.detail, /broker/)
})

test('quiesce is quiet when no Codex companion is installed: worktree prep must not pause owners without Codex', t => {
  const r = run(t, { companion: '/nonexistent/codex-companion.mjs' }, 'quiesce', ...W)
  assert.equal(r.out.quiet, true)
  assert.match(r.out.detail, /not installed/)
})

test('quiesce with nothing running is quiet, and reports a job that finished during the call', t => {
  const r = run(t, { jobId: 'j', status: 'completed', active: [] }, 'quiesce', ...W, '--job', 'j')
  assert.deepEqual([r.out.quiet, r.out.final], [true, 'completed'])
})

test('bad usage exits 2 and prints no JSON', t => {
  for (const args of [['wait', 'j', ...W], ['start', ...W, ...CAP], ['result', ...W], ['bogus', 'j', ...W], ['quiesce'], ['stop', 'j', ...W]]) {
    const r = run(t, {}, ...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.out, null)
  }
})
