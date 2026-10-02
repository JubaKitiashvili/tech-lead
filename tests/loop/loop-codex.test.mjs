// tests/loop/loop-codex.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { compareVersions, locateCompanion, parseTrailer, processAlive } from '../../scripts/loop-codex.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { commandLine, startToken } from '../../scripts/lib/loop-proc.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-codex.mjs')
const LOCK = path.join(ROOT, 'scripts', 'loop-lock.mjs')
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'codex', 'scripts', 'codex-companion.mjs')
const BROKER = path.join(ROOT, 'tests', 'fixtures', 'codex', 'app-server-broker.mjs')
// Keep the user's git config and hooks out of the fixture repositories of the lock cases.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// A node process started the same way, once its command line shows argv (after its exec).
const launched = async (t, argv) => {
  const pid = Number(execFileSync('/bin/sh', ['-c', '"$@" >/dev/null 2>&1 & echo $!', 'sh', process.execPath, ...argv], { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  for (let i = 0; i < 100; i++) {
    const c = commandLine(pid)
    if (c.state === 'live' && c.words.includes(argv[argv.length - 1])) return pid
    await sleep(30)
  }
  assert.fail(`${argv.join(' ')} never started`)
}
// The processes the companion's state names, with the command lines the real companion
// gives them: the broker serving endpoint, and the worker of job id.
const broker = (t, endpoint, ...extra) => launched(t, [BROKER, 'serve', '--endpoint', endpoint, ...extra])
const worker = (t, id) => launched(t, [FAKE, 'task-worker', '--cwd', '/w', '--job-id', id])

// Runs loop-codex.mjs against the fake companion (or scenario.companion) and returns
// its exit status, its parsed JSON line, and the calls it made. scenario.env is added to
// the environment.
const run = (t, scenario, ...args) => {
  const dir = tmp(t)
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify(scenario))
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...scenario.env, CODEX_COMPANION_SESSION_ID: 'this-session', TECH_LEAD_CODEX_COMPANION: scenario.companion ?? FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, calls, stderr: r.stderr }
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

test('quiesce cancels active jobs across sessions, shuts down the broker, and proves both processes gone', async t => {
  const b = await broker(t, 'unix:/tmp/x.sock'), w = await worker(t, 'j2')
  // A foreground job runs in the companion process itself, whose command line names no job.
  const fg = await launched(t, [FAKE, 'task-worker', '--cwd', '/w'])
  const r = run(t, { jobId: 'j', status: 'completed', broker: { pid: b, endpoint: 'unix:/tmp/x.sock' }, active: [{ id: 'j2', pid: w, status: 'running' }, { id: 'j4', pid: fg, status: 'running' }] }, 'quiesce', ...W, '--job', 'j')
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.equal(r.out.final, 'completed')
  assert.ok(!processAlive(b) && !processAlive(w) && !processAlive(fg))
  assert.deepEqual(r.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['j2', 'j4'])
  assert.deepEqual(r.calls.find(c => c[0] === 'env:CODEX_COMPANION_SESSION_ID'), ['env:CODEX_COMPANION_SESSION_ID', null])
  assert.ok(r.calls.some(c => c[0] === 'cancel' && c[1] === 'j2'))
  assert.ok(r.calls.some(c => c[0] === 'lib:sendBrokerShutdown'))
})

test('reproduction (cx-lp04): an acknowledged interrupt is not enough; a broker that survives shutdown is not quiet', async t => {
  const b = await broker(t, 'e')
  const r = run(t, { jobId: 'j', status: 'running', startedAt: ago(50), turnInterrupted: true, broker: { pid: b, endpoint: 'e' }, stubborn: [b], active: [] }, 'quiesce', ...W, '--job', 'j')
  assert.equal(r.out.quiet, false)
  assert.match(r.out.detail, new RegExp(`pid ${b}`))
})

test('quiesce is not quiet when a worker survives its cancel, the jobs cannot be listed, or the broker API is missing', async t => {
  const w = await worker(t, 'j')
  assert.equal(run(t, { jobId: 'j', status: 'running', active: [{ id: 'j', pid: w }], stubborn: [w] }, 'quiesce', ...W).out.quiet, false)
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

test('quiesce signals no pid the companion\'s state names once that pid is gone or runs another program', async t => {
  // After a crash or a reboot broker.json and a job still marked running outlive their
  // processes, and their pids may lead unrelated process groups.
  const LAUNCH = "const c = require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 120'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
  const unrelated = () => {
    const pgid = Number(execFileSync(process.execPath, ['-e', LAUNCH], { encoding: 'utf8' }).trim())
    t.after(() => { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } })
    return pgid
  }
  const groupAlive = pgid => { try { process.kill(-pgid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const other = unrelated(), otherJob = unrelated(), elsewhere = await worker(t, 'j9')
  const dead = sleeper(t)
  process.kill(dead, 'SIGKILL')
  for (let i = 0; i < 60 && processAlive(dead); i++) await sleep(50)
  const r = run(t, {
    broker: { pid: other, endpoint: 'unix:/tmp/stale.sock' },
    active: [{ id: 'j1', pid: otherJob, status: 'running' }, { id: 'j2', pid: dead, status: 'running' }, { id: 'j3', pid: elsewhere, status: 'running' }],
  }, 'quiesce', ...W)
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.equal(groupAlive(other), true, 'the stale broker pid\'s group was signalled')
  assert.equal(groupAlive(otherJob), true, 'a stale job pid\'s group was signalled')
  assert.equal(processAlive(elsewhere), true, 'the worker of another job was signalled')
  assert.deepEqual(r.calls.filter(c => c[0] === 'cancel'), [])
  assert.deepEqual(r.calls.filter(c => c[0] === 'lib:sendBrokerShutdown'), [])
  assert.ok(r.calls.some(c => c[0] === 'lib:clearBrokerSession'), JSON.stringify(r.calls))
  assert.match(r.out.detail, /stale/)
})

test('bad usage exits 2 and prints no JSON', t => {
  for (const args of [['wait', 'j', ...W], ['start', ...W, ...CAP], ['result', ...W], ['bogus', 'j', ...W], ['quiesce'], ['stop', 'j', ...W]]) {
    const r = run(t, {}, ...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.out, null)
  }
})

// The firing lock's side of start (brief 6). A project whose generation 1 is held by a live
// sleeper, with <V> under a temporary cache root and a work directory W.
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const lockProject = async t => {
  const P = tmp(t)
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const cache = tmp(t), W = fs.realpathSync(tmp(t)), holder = sleeper(t)
  const env = { TECH_LEAD_CACHE: cache, TECH_LEAD_HOLDER_PID: String(holder) }
  const r = await acquire(P, { env: { ...process.env, ...env } })
  assert.equal(r.generation, 1)
  return { P, cache, W, holder, env, lockDir: r.lockDir }
}
const records = lockDir => {
  const dir = path.join(lockDir, 'children')
  return (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []).map(name => ({ name, rec: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
}
const START = (p, g = '1') => ['start', '--cwd', p.W, '--prompt-file', '/b.md', ...CAP, '--project', p.P, '--generation', g]

test('start --project --generation registers the Codex job in the lock before launching it, and records its id after', async t => {
  const p = await lockProject(t)
  const r = run(t, { jobId: 'task-7', watchDir: path.join(p.lockDir, 'children'), env: p.env }, ...START(p))
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.out, { state: 'started', jobId: 'task-7' })
  assert.deepEqual(r.calls.find(c => c[0] === 'task'), ['task', '--background', '--json', '--write', '--cwd', p.W, '--prompt-file', '/b.md'])
  // What the lock held at the moment the companion was asked to launch the job.
  const [, atLaunch] = r.calls.find(c => c[0] === 'watch')
  const names = Object.keys(atLaunch)
  assert.equal(names.length, 1)
  assert.match(names[0], /^1-codex-[0-9a-f]{16}\.json$/)
  // The record names the start process itself as its starter.
  const { starter } = atLaunch[names[0]]
  assert.ok(Number.isInteger(starter.pid) && starter.pid !== process.pid && typeof starter.start === 'string', JSON.stringify(starter))
  assert.deepEqual(atLaunch[names[0]], { v: 1, kind: 'codex', generation: 1, cwd: p.W, jobId: null, starter })
  assert.deepEqual(records(p.lockDir), [{ name: names[0], rec: { v: 1, kind: 'codex', generation: 1, cwd: p.W, jobId: 'task-7', starter } }])
})

test('start for a generation the caller does not hold exits 4, launches nothing and writes no record', async t => {
  const p = await lockProject(t)
  const other = { ...p.env, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  for (const [who, env, g] of [['another holder', other, '1'], ['a later generation', p.env, '2']]) {
    const r = run(t, { jobId: 'task-7', env }, ...START(p, g))
    assert.equal(r.status, 4, who)
    assert.equal(r.out.state, 'not-holder', who)
    assert.deepEqual(r.calls, [], who)
  }
  const missing = run(t, { jobId: 'task-7', companion: '/nonexistent/codex-companion.mjs', env: p.env }, ...START(p))
  assert.deepEqual([missing.status, missing.out.state], [3, 'unavailable'])
  const base = ['start', '--cwd', p.W, '--prompt-file', '/b.md', ...CAP]
  for (const args of [[...base, '--project', p.P], [...base, '--generation', '1'], [...base, '--project', p.P, '--generation', '0'], [...base, '--project', p.P, '--generation', '1x']]) {
    const r = run(t, { jobId: 'task-7', env: p.env }, ...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.deepEqual(r.calls, [], args.join(' '))
  }
  assert.deepEqual(records(p.lockDir), [])
})

test('a dead holder\'s Codex job is quiesced by the next acquire: cancelled, broker shut down, both processes gone', async t => {
  const p = await lockProject(t)
  const started = run(t, { jobId: 'task-9', env: p.env }, ...START(p))
  assert.equal(started.status, 0, started.stderr)
  const [{ name }] = records(p.lockDir)
  const b = await broker(t, 'unix:/tmp/b.sock'), w = await worker(t, 'task-9')
  process.kill(p.holder, 'SIGKILL')
  for (let i = 0; i < 60 && startToken(p.holder).state !== 'gone'; i++) await new Promise(resolve => setTimeout(resolve, 50))
  const dir = tmp(t)
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify({
    jobId: 'task-9', status: 'running', startedAt: ago(1),
    broker: { pid: b, endpoint: 'unix:/tmp/b.sock' }, active: [{ id: 'task-9', pid: w, status: 'running' }],
  }))
  const r = spawnSync(process.execPath, [LOCK, 'acquire', p.P], {
    encoding: 'utf8',
    env: { ...process.env, TECH_LEAD_CACHE: p.cache, TECH_LEAD_HOLDER_PID: String(sleeper(t)), TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.generation, 2)
  assert.deepEqual(out.reclaimed, { generation: 1, how: 'dead-holder', stopped: [{ file: name, kind: 'codex', jobId: 'task-9' }] })
  assert.ok(!processAlive(w), `worker ${w} survived`)
  assert.ok(!processAlive(b), `broker ${b} survived`)
  assert.deepEqual(records(p.lockDir), [])
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(calls.some(c => c[0] === 'status' && c.includes('--all') && c[c.indexOf('--cwd') + 1] === p.W), JSON.stringify(calls))
  assert.ok(calls.some(c => c[0] === 'cancel' && c[1] === 'task-9' && c[c.indexOf('--cwd') + 1] === p.W), JSON.stringify(calls))
  assert.deepEqual(calls.find(c => c[0] === 'lib:sendBrokerShutdown'), ['lib:sendBrokerShutdown', 'unix:/tmp/b.sock'])
})

// A CLI run started without waiting; done resolves with its exit status and stdout.
const background = (t, args, env) => {
  const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  c.stdout.on('data', d => { stdout += d })
  c.stderr.on('data', d => { stderr += d })
  t.after(() => { try { c.kill('SIGKILL') } catch { /* gone */ } })
  return new Promise(resolve => c.on('close', status => resolve({ status, stdout, stderr })))
}

test('a reclaim waits for a Codex start that is still launching its job, then quiesces the job it launched', async t => {
  const p = await lockProject(t)
  // The broker takes 4 s to exit, which keeps the reclaim's quiesce busy while the start
  // finishes: the window in which a job launched after the jobs were listed went unseen.
  const b = await broker(t, 'unix:/tmp/slow.sock', '--exit-after-ms', '4000')
  // Its own directory: the worker named in the scenario is killed before the file goes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-codex-'))
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  t.after(() => {
    try {
      for (const j of JSON.parse(fs.readFileSync(state, 'utf8')).active || []) try { process.kill(j.pid, 'SIGKILL') } catch { /* gone */ }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  fs.writeFileSync(state, JSON.stringify({ jobId: 'task-5', taskDelayMs: 1200, launchWorker: true, broker: { pid: b, endpoint: 'unix:/tmp/slow.sock' }, stubborn: [b], active: [] }))
  const base = { ...process.env, ...p.env, TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log }
  const starting = background(t, [SCRIPT, ...START(p)], base)
  // The start is in the companion's task call once that call is logged: it has registered
  // and checked its record.
  const inTask = () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').split('\n').some(l => l.startsWith('["task"'))
  for (let i = 0; i < 200 && !inTask(); i++) await sleep(20)
  assert.ok(inTask(), 'the start never called the companion')
  const [{ name, rec }] = records(p.lockDir)
  assert.equal(rec.starter.pid > 0 && typeof rec.starter.start === 'string', true, JSON.stringify(rec))
  // The holder dies while the start is still in the companion's task call.
  process.kill(p.holder, 'SIGKILL')
  for (let i = 0; i < 60 && startToken(p.holder).state !== 'gone'; i++) await sleep(50)
  const acquiring = background(t, [LOCK, 'acquire', p.P], { ...base, TECH_LEAD_HOLDER_PID: String(sleeper(t)) })
  const [started, acq] = await Promise.all([starting, acquiring])
  assert.equal(started.status, 0, started.stdout + started.stderr)
  assert.deepEqual(JSON.parse(started.stdout), { state: 'started', jobId: 'task-5' })
  assert.equal(acq.status, 0, acq.stdout + acq.stderr)
  const out = JSON.parse(acq.stdout)
  assert.equal(out.generation, 2)
  assert.deepEqual(out.reclaimed.stopped, [{ file: name, kind: 'codex', jobId: 'task-5' }])
  const [job] = JSON.parse(fs.readFileSync(state, 'utf8')).active
  assert.ok(job, 'the start never launched its job')
  assert.ok(!processAlive(job.pid), `the job's worker ${job.pid} outlived the reclaim`)
  assert.deepEqual(records(p.lockDir), [])
})
