// tests/loop/loop-codex.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { compareVersions, locateCompanion, parseTrailer } from '../../scripts/loop-codex.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-codex.mjs')
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-codex-companion.mjs')
const ago = min => new Date(Date.now() - min * 60000).toISOString()
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-codex-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

// Runs loop-codex.mjs against the fake companion (or scenario.companion) and returns
// its exit status, its parsed JSON line, and the companion calls it made.
const run = (t, scenario, ...args) => {
  const dir = tmp(t)
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify(scenario))
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TECH_LEAD_CODEX_COMPANION: scenario.companion ?? FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, calls }
}
const W = ['--cwd', '/w']

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

test('start launches a background write job and returns its id', t => {
  const r = run(t, { jobId: 'task-1' }, 'start', ...W, '--prompt-file', '/s/briefs/x.md')
  assert.equal(r.status, 0)
  assert.deepEqual(r.out, { state: 'started', jobId: 'task-1' })
  assert.deepEqual(r.calls, [['task', '--background', '--json', '--write', '--cwd', '/w', '--prompt-file', '/s/briefs/x.md']])
})

test('reproduction (loop09): with no companion, start exits 3 and never runs node on an empty path', t => {
  const missing = run(t, { jobId: 'task-1', companion: '/nonexistent/codex-companion.mjs' }, 'start', ...W, '--prompt-file', '/b.md')
  assert.equal(missing.status, 3)
  assert.equal(missing.out.state, 'unavailable')
  assert.deepEqual(missing.calls, [])
  const unauthenticated = run(t, { taskError: 'Codex CLI is not authenticated' }, 'start', ...W, '--prompt-file', '/b.md')
  assert.equal(unauthenticated.status, 3)
  assert.match(unauthenticated.out.detail, /not authenticated/)
})

test('wait reports running, cap and each ended state, and never waits past the cap or 9 minutes', t => {
  const wait = sc => run(t, { jobId: 'j', ...sc }, 'wait', 'j', ...W, '--cap-min', '45')
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

test('wait on a job the companion cannot find reports error, and exits 0', t => {
  const r = run(t, { statusError: 'No job found for "zz".' }, 'wait', 'zz', ...W, '--cap-min', '45')
  assert.equal(r.status, 0)
  assert.equal(r.out.state, 'error')
  assert.match(r.out.detail, /No job found/)
})

test('result returns the raw answer and flags a missing or non-none trailer', t => {
  const result = raw => run(t, { jobId: 'j', status: 'completed', rawOutput: raw }, 'result', 'j', ...W).out
  const ok = result('Did it.\nJUDGMENT CALLS: none\nSKIPPED: none\n')
  assert.equal(ok.answer, 'Did it.\nJUDGMENT CALLS: none\nSKIPPED: none\n')
  assert.deepEqual(ok.trailer, { judgmentCalls: 'none', skipped: 'none' })
  assert.equal(ok.flagged, false)
  assert.equal(result('Did it.\nJUDGMENT CALLS: chose the v2 API\nSKIPPED: none').flagged, true)
  assert.deepEqual(result('Did it.'), { answer: 'Did it.', trailer: null, flagged: true })
  assert.deepEqual(parseTrailer('JUDGMENT CALLS: none\nSKIPPED: none\n\n'), { trailer: { judgmentCalls: 'none', skipped: 'none' }, flagged: false })
})

test('reproduction (cx-lp04): a cancel that did not interrupt the turn is not a stop', t => {
  const live = run(t, { jobId: 'j', status: 'running', startedAt: ago(50), turnInterrupted: false }, 'stop', 'j', ...W)
  assert.equal(live.out.stopped, false)
  assert.ok(live.calls.some(c => c[0] === 'cancel' && c.includes('--json')))
  const interrupted = run(t, { jobId: 'j', status: 'running', startedAt: ago(50), turnInterrupted: true }, 'stop', 'j', ...W)
  assert.equal(interrupted.out.stopped, true)
})

test('stop: a finished job needs no cancel; a job cancelled elsewhere, a failed cancel or an unreadable status is not a stop', t => {
  const stop = sc => run(t, { jobId: 'j', startedAt: ago(50), ...sc }, 'stop', 'j', ...W)
  for (const s of ['completed', 'failed']) {
    const r = stop({ status: s })
    assert.equal(r.out.stopped, true, s)
    assert.ok(!r.calls.some(c => c[0] === 'cancel'), s)
  }
  const elsewhere = stop({ status: 'cancelled' })
  assert.equal(elsewhere.out.stopped, false)
  assert.ok(!elsewhere.calls.some(c => c[0] === 'cancel'))
  assert.equal(stop({ status: 'running', cancelError: 'broker busy' }).out.stopped, false)
  assert.equal(stop({ statusError: 'status failed', turnInterrupted: false }).out.stopped, false)
})

test('bad usage exits 2 and prints no JSON', t => {
  for (const args of [['wait', 'j', ...W], ['start', ...W], ['result', ...W], ['bogus', 'j', ...W], ['stop', 'j']]) {
    const r = run(t, {}, ...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.out, null)
  }
})
