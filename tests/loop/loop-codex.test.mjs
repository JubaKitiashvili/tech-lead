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
import { commandLine, groupAlive, isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'
import { killGroupIfOurs } from './interrupt-fixture.mjs'

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
// The cleanup never signals an id another process took (review round, contracts-tests#7).
// reapPid kills pid when the test ends only while its start token is still the one read here:
// a test may kill it first, and the kernel may have handed the pid to another process since.
const reapPid = (t, pid) => {
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}
// reapGroup kills the process group pgid when the test ends only while killGroupIfOurs finds its
// leader's token the one read here, or the leader's pid free. Each group it is given is led by
// a process whose parent is init, which reaps a dead leader at once, so a zombie at the pid is
// another process's.
const reapGroup = (t, pgid) => {
  const start = startToken(pgid).token ?? null
  t.after(() => { killGroupIfOurs(pgid, start, { zombieOurs: false }) })
  return pgid
}
// A real process standing in for a broker or a worker. It is started through a shell that
// exits at once, so the test runner is not its parent and a killed one never lingers as a zombie.
const sleeper = t => reapPid(t, Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim()))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// A node process leading a process group of its own, as the companion starts its broker and
// its workers (detached), returned once its command line shows argv. A short-lived launcher
// starts it and exits at once, so its parent is init, which reaps it.
const LAUNCH_NODE = "const c = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
const launched = async (t, argv) => {
  const pid = Number(execFileSync(process.execPath, ['-e', LAUNCH_NODE, process.execPath, ...argv], { encoding: 'utf8' }).trim())
  reapGroup(t, pid)
  reapPid(t, pid)
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
const worker = (t, id, ...extra) => launched(t, [FAKE, 'task-worker', '--cwd', '/w', '--job-id', id, ...extra])
// The pid a fixture's --member or --stubborn-member wrote to file (lib/group-member.mjs). The
// member runs until it is killed, so its start token is read when the pid is first seen.
const memberPid = async (t, file) => {
  for (let i = 0; i < 100; i++) {
    const s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
    if (/^\d+$/.test(s)) return reapPid(t, Number(s))
    await sleep(30)
  }
  assert.fail(`no member pid in ${file}`)
}
const gone = pid => commandLine(pid).state === 'gone'
const killed = async pid => {
  process.kill(pid, 'SIGKILL')
  for (let i = 0; i < 100 && !gone(pid); i++) await sleep(30)
  assert.ok(gone(pid), `pid ${pid} never read as gone`)
}
const pgidOf = pid => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())

// A fake companion's scenario file and call log, plus a cache root for quiesce's own record.
// groups collects the runs started in the background ({pid, start, exited}). One hook ends, in
// order, those runs' process groups (so their companion launches nothing more), the workers
// the fake launched (it logs ['launched', pid]), and then removes the files. Neither kill
// reaches an id another process took (contracts-tests#7):
//   - a run's group: while Node has not reaped the run, its pid (so its group id) is still
//     this process's child's; once reaped, only while killGroupIfOurs finds the leader's
//     recorded token or its pid free;
//   - a worker's group: the test never sees the fake start a worker, so the hook proves it by
//     what it runs, as quiesce does: the fake's task-worker for the scenario's job id, with
//     the --cwd of the task call that launched it. The start token is read before that check
//     and compared again by killGroupIfOurs, so the command line read is the killed leader's.
//     A free pid leaves only the worker's own group members; init reaps a dead worker, so a
//     zombie at its pid is another process's.
const stateFiles = (t, scenario) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-codex-'))
  const files = { state: path.join(dir, 'state.json'), log: path.join(dir, 'calls.log'), cache: path.join(dir, 'cache'), groups: [] }
  fs.writeFileSync(files.state, JSON.stringify(scenario))
  t.after(() => {
    for (const run of files.groups) {
      if (!run.exited) {
        try { process.kill(-run.pid, 'SIGKILL') } catch { /* gone */ }
      } else killGroupIfOurs(run.pid, run.start, { zombieOurs: false })
    }
    for (const c of callsOf(files)) {
      if (c[0] !== 'launched') continue
      const leader = startToken(c[1])
      if (leader.state === 'live' && !launchedWorker(files, c[1])) continue
      killGroupIfOurs(c[1], leader.token ?? null, { zombieOurs: false })
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return files
}
// Whether pid runs the fake's task-worker for the job id of files' scenario, with the --cwd of
// the task call in files' log. A state file that cannot be read proves nothing.
const launchedWorker = (files, pid) => {
  const c = commandLine(pid)
  const task = callsOf(files).find(x => x[0] === 'task')
  if (c.state !== 'live' || !task) return false
  let jobId
  try { ({ jobId } = JSON.parse(fs.readFileSync(files.state, 'utf8'))) } catch { return false }
  const arg = (words, flag) => (words.includes(flag) ? words[words.indexOf(flag) + 1] : undefined)
  return c.words.includes('task-worker') && arg(c.words, '--cwd') === arg(task, '--cwd') && arg(c.words, '--job-id') === jobId
}
// The environment of a run against files: the fake companion (or scenario.companion), with
// scenario.env added.
const envFor = files => {
  const scenario = JSON.parse(fs.readFileSync(files.state, 'utf8'))
  return {
    ...process.env, TECH_LEAD_CACHE: files.cache, ...scenario.env, CODEX_COMPANION_SESSION_ID: 'this-session',
    TECH_LEAD_CODEX_COMPANION: scenario.companion ?? FAKE, FAKE_CODEX_STATE: files.state, FAKE_CODEX_LOG: files.log,
  }
}
const callsOf = files => fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
// Runs loop-codex.mjs once against files, whose scenario carries over from earlier runs, and
// returns its exit status, its parsed JSON line, and the calls this run made. It runs in a
// process group of its own unless inGroup: a start's Codex record names the start's group,
// which a reclaim waits for.
const exec = (files, args, { inGroup = false } = {}) => {
  const before = callsOf(files).length
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: envFor(files), detached: !inGroup })
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, calls: callsOf(files).slice(before), stderr: r.stderr }
}
const run = (t, scenario, ...args) => exec(stateFiles(t, scenario), args)
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

test('start validates the cap, then launches a background write job in the worktree and returns its id', t => {
  const w = fs.realpathSync(tmp(t))
  const r = run(t, { jobId: 'task-1' }, 'start', '--cwd', w, '--prompt-file', '/s/briefs/x.md', ...CAP)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.out, { state: 'started', jobId: 'task-1' })
  // The companion runs in <W> as well as with --cwd <W>, so a sweep of <W> sees it.
  assert.deepEqual(r.calls, [['task', '--background', '--json', '--write', '--cwd', w, '--prompt-file', '/s/briefs/x.md'], ['task:cwd', w]])
  for (const cap of ['0', 'Infinity', '-5', 'NaN', '45m']) {
    const bad = run(t, { jobId: 'task-1' }, 'start', '--cwd', w, '--prompt-file', '/b.md', '--cap-min', cap)
    assert.equal(bad.status, 2, cap)
    assert.deepEqual(bad.calls, [], cap)
  }
})

test('reproduction (loop09): with no companion, start exits 3 and never runs node on an empty path', t => {
  const w = tmp(t)
  const missing = run(t, { jobId: 'task-1', companion: '/nonexistent/codex-companion.mjs' }, 'start', '--cwd', w, '--prompt-file', '/b.md', ...CAP)
  assert.equal(missing.status, 3)
  assert.equal(missing.out.state, 'unavailable')
  assert.deepEqual(missing.calls, [])
  const notInstalled = run(t, { taskError: 'Codex CLI is not installed' }, 'start', '--cwd', w, '--prompt-file', '/b.md', ...CAP)
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

test('quiesce cancels active jobs across sessions, shuts down the broker, and proves both process groups gone', async t => {
  const b = await broker(t, 'unix:/tmp/x.sock'), w = await worker(t, 'j2')
  const files = stateFiles(t, { jobId: 'j', status: 'completed', broker: { pid: b, endpoint: 'unix:/tmp/x.sock' }, active: [{ id: 'j2', pid: w, status: 'running' }] })
  const r = exec(files, ['quiesce', ...W, '--job', 'j'])
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.equal(r.out.final, 'completed')
  assert.ok(gone(b) && gone(w))
  assert.equal(groupAlive(b), false)
  assert.equal(groupAlive(w), false)
  assert.deepEqual(r.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['j2'])
  assert.deepEqual(r.calls.find(c => c[0] === 'env:CODEX_COMPANION_SESSION_ID'), ['env:CODEX_COMPANION_SESSION_ID', null])
  assert.ok(r.calls.some(c => c[0] === 'lib:sendBrokerShutdown'))
  assert.ok(r.calls.some(c => c[0] === 'lib:clearBrokerSession'))
  // Nothing is left on quiesce's own record once everything is proven gone.
  const memo = path.join(files.cache, 'tech-lead', 'codex-quiesce')
  assert.deepEqual(fs.existsSync(memo) ? fs.readdirSync(memo) : [], [])
})

test('reproduction (cx-lp04): an acknowledged interrupt is not enough; a broker that survives shutdown is not quiet', async t => {
  const b = await broker(t, 'e')
  const r = run(t, { jobId: 'j', status: 'running', startedAt: ago(50), turnInterrupted: true, broker: { pid: b, endpoint: 'e' }, stubborn: [b], active: [] }, 'quiesce', ...W, '--job', 'j')
  assert.equal(r.out.quiet, false)
  assert.match(r.out.detail, new RegExp(`pid ${b}`))
  // The broker session stays, so the next quiesce sees the broker again.
  assert.deepEqual(r.calls.filter(c => c[0] === 'lib:clearBrokerSession'), [])
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
  const unrelated = () => reapGroup(t, Number(execFileSync(process.execPath, ['-e', LAUNCH], { encoding: 'utf8' }).trim()))
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

test('quiesce refuses a Codex pid that is not an integer above 1: not quiet, and nothing is cancelled or signalled', t => {
  // The companion's cancel sends SIGTERM to -pid: -0 is the caller's own group, -1 every
  // process the caller may signal.
  for (const pid of [0, 1, -1, -7, 2.5, '4242', true]) {
    const r = run(t, { active: [{ id: 'j', pid, status: 'running' }] }, 'quiesce', ...W)
    assert.equal(r.out.quiet, false, `job pid ${JSON.stringify(pid)}: ${r.out.detail}`)
    assert.match(r.out.detail, /pid/)
    assert.deepEqual(r.calls.filter(c => c[0] === 'cancel' || c[0] === 'lib:terminateProcessTree'), [], `job pid ${JSON.stringify(pid)}`)
  }
  for (const pid of [0, 1, -1, 2.5, '4242', null, undefined]) {
    const r = run(t, { broker: { pid, endpoint: 'unix:/tmp/bad.sock' }, active: [] }, 'quiesce', ...W)
    assert.equal(r.out.quiet, false, `broker pid ${JSON.stringify(pid)}: ${r.out.detail}`)
    assert.deepEqual(r.calls.filter(c => /^lib:(sendBrokerShutdown|terminateProcessTree|teardownBrokerSession|clearBrokerSession)$/.test(c[0])), [], `broker pid ${JSON.stringify(pid)}`)
  }
  // No pid yet: the job has not started, and its cancel only stops it from starting.
  for (const job of [{ id: 'q', pid: null, status: 'queued' }, { id: 'q', status: 'queued' }]) {
    const r = run(t, { active: [job] }, 'quiesce', ...W)
    assert.equal(r.out.quiet, true, r.out.detail)
    assert.deepEqual(r.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['q'])
  }
})

test('a job process is ours only when it is the companion\'s worker of that very job id', async t => {
  const dir = tmp(t)
  const impostorScript = path.join(dir, 'not-codex-companion.mjs')
  fs.writeFileSync(impostorScript, 'setInterval(() => {}, 2 ** 30)\n')
  const noId = await launched(t, [FAKE, 'task-worker', '--cwd', '/w'])
  const otherId = await worker(t, 'j20')
  const impostor = await launched(t, [impostorScript, 'task-worker', '--cwd', '/w', '--job-id', 'j3'])
  const mine = await worker(t, 'j4')
  const r = run(t, {
    active: [{ id: 'j1', pid: noId, status: 'running' }, { id: 'j2', pid: otherId, status: 'running' }, { id: 'j3', pid: impostor, status: 'running' }, { id: 'j4', pid: mine, status: 'running' }],
  }, 'quiesce', ...W)
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.deepEqual(r.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['j4'])
  for (const pid of [noId, otherId, impostor]) assert.ok(processAlive(pid), `pid ${pid} (${commandLine(pid).words?.join(' ')}) was signalled`)
  assert.ok(gone(mine))
  assert.match(r.out.detail, /stale/)
})

test('the broker is ours only when it is the companion\'s broker serving the recorded endpoint', async t => {
  const E = 'unix:/tmp/own.sock'
  for (const argv of [[FAKE, 'task-worker', '--cwd', '/w', '--endpoint', E], [BROKER, 'listen', '--endpoint', E], [BROKER, 'serve', '--endpoint', `${E}2`]]) {
    const pid = await launched(t, argv)
    const r = run(t, { broker: { pid, endpoint: E }, active: [] }, 'quiesce', ...W)
    assert.equal(r.out.quiet, true, r.out.detail)
    assert.ok(processAlive(pid), `${argv.join(' ')} was signalled`)
    assert.deepEqual(r.calls.filter(c => c[0] === 'lib:sendBrokerShutdown' || c[0] === 'lib:terminateProcessTree'), [], argv.join(' '))
    assert.match(r.out.detail, /stale/)
  }
  const b = await broker(t, E)
  const r = run(t, { broker: { pid: b, endpoint: E }, active: [] }, 'quiesce', ...W)
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.ok(gone(b))
  assert.deepEqual(r.calls.find(c => c[0] === 'lib:sendBrokerShutdown'), ['lib:sendBrokerShutdown', E])
})

test('a job whose worker is gone while its process group lives on is still ours: quiesce cancels it and waits for the group', async t => {
  const mf = path.join(tmp(t), 'member.pid')
  const w = await worker(t, 'j1', '--member', mf)
  const m = await memberPid(t, mf)
  await killed(w)
  assert.equal(groupAlive(w), true)
  const r = run(t, { active: [{ id: 'j1', pid: w, status: 'running' }] }, 'quiesce', ...W)
  assert.equal(r.out.quiet, true, r.out.detail)
  assert.deepEqual(r.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['j1'])
  assert.equal(groupAlive(w), false, 'the worker\'s group outlived the quiesce')
  assert.ok(gone(m))
})

test('a job group that outlives its cancel is not quiet, and a retry still waits for it once the companion marked the job cancelled', async t => {
  const mf = path.join(tmp(t), 'member.pid')
  const w = await worker(t, 'j1', '--stubborn-member', mf)
  const m = await memberPid(t, mf)
  const files = stateFiles(t, { active: [{ id: 'j1', pid: w, status: 'running' }] })
  const first = exec(files, ['quiesce', ...W])
  assert.equal(first.out.quiet, false, first.out.detail)
  assert.match(first.out.detail, new RegExp(`pid ${w}\\b`))
  assert.deepEqual(first.calls.filter(c => c[0] === 'cancel').map(c => c[1]), ['j1'])
  assert.ok(gone(w), 'the cancel did not end the worker itself')
  assert.ok(processAlive(m))
  // The companion no longer lists the job: its cancel rewrote it as cancelled with pid null.
  assert.deepEqual(JSON.parse(fs.readFileSync(files.state, 'utf8')).active, [])
  const retry = exec(files, ['quiesce', ...W])
  assert.equal(retry.out.quiet, false, retry.out.detail)
  assert.match(retry.out.detail, new RegExp(`pid ${w}\\b`))
  // Out of the companion's sight it is waited for, never signalled again.
  assert.deepEqual(retry.calls.filter(c => c[0] === 'cancel' || c[0] === 'lib:terminateProcessTree'), [])
  await killed(m)
  const last = exec(files, ['quiesce', ...W])
  assert.equal(last.out.quiet, true, last.out.detail)
  assert.deepEqual(fs.readdirSync(path.join(files.cache, 'tech-lead', 'codex-quiesce')), [])
})

test('a broker whose leader is gone while its process group lives on is signalled, and its session is kept until the group is gone', async t => {
  const E = 'unix:/tmp/leaderless.sock', mf = path.join(tmp(t), 'member.pid')
  const b = await broker(t, E, '--stubborn-member', mf)
  const m = await memberPid(t, mf)
  await killed(b)
  assert.equal(groupAlive(b), true)
  const files = stateFiles(t, { broker: { pid: b, endpoint: E }, active: [] })
  const first = exec(files, ['quiesce', ...W])
  assert.equal(first.out.quiet, false, first.out.detail)
  assert.match(first.out.detail, new RegExp(`pid ${b}\\b`))
  assert.ok(first.calls.some(c => c[0] === 'lib:terminateProcessTree' && c[1] === b), JSON.stringify(first.calls))
  assert.deepEqual(first.calls.filter(c => c[0] === 'lib:teardownBrokerSession' || c[0] === 'lib:clearBrokerSession'), [])
  const retry = exec(files, ['quiesce', ...W])
  assert.equal(retry.out.quiet, false, retry.out.detail)
  assert.match(retry.out.detail, new RegExp(`pid ${b}\\b`))
  await killed(m)
  const last = exec(files, ['quiesce', ...W])
  assert.equal(last.out.quiet, true, last.out.detail)
  assert.ok(last.calls.some(c => c[0] === 'lib:clearBrokerSession'), JSON.stringify(last.calls))
  assert.equal(JSON.parse(fs.readFileSync(files.state, 'utf8')).broker, undefined)
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
// A CLI run against files started without waiting, in a process group of its own (a start's
// record names its group, which a reclaim waits for); it resolves with its exit status, its
// output, and the time it ended.
const background = (files, args, env = envFor(files)) => {
  const c = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  // The run leads its own group; its token is read while it is surely this process's child,
  // and exited is set once Node has reaped it.
  const run = { pid: c.pid, start: startToken(c.pid).token ?? null, exited: false }
  c.on('exit', () => { run.exited = true })
  files.groups.push(run)
  let stdout = '', stderr = ''
  c.stdout.on('data', d => { stdout += d })
  c.stderr.on('data', d => { stderr += d })
  return new Promise(resolve => c.on('close', status => resolve({ status, stdout, stderr, at: Date.now() })))
}

test('start --project --generation registers the Codex job in the lock before launching it, and records its id after', async t => {
  const p = await lockProject(t)
  // Run in this process's group, as a Bash tool command runs in its shell's.
  const r = exec(stateFiles(t, { jobId: 'task-7', watchDir: path.join(p.lockDir, 'children'), env: p.env }), START(p), { inGroup: true })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.out, { state: 'started', jobId: 'task-7' })
  assert.deepEqual(r.calls.find(c => c[0] === 'task'), ['task', '--background', '--json', '--write', '--cwd', p.W, '--prompt-file', '/b.md'])
  assert.deepEqual(r.calls.find(c => c[0] === 'task:cwd'), ['task:cwd', p.W])
  // What the lock held at the moment the companion was asked to launch the job.
  const [, atLaunch] = r.calls.find(c => c[0] === 'watch')
  const names = Object.keys(atLaunch)
  assert.equal(names.length, 1)
  assert.match(names[0], /^1-codex-[0-9a-f]{16}\.json$/)
  // The record names the start process itself as its starter, with the process group it
  // shares with the companion it runs.
  const { starter } = atLaunch[names[0]]
  assert.ok(Number.isInteger(starter.pid) && starter.pid !== process.pid && typeof starter.start === 'string', JSON.stringify(starter))
  assert.equal(starter.pgid, pgidOf(process.pid), JSON.stringify(starter))
  assert.notEqual(starter.pgid, starter.pid)
  assert.deepEqual(Object.keys(starter).sort(), ['pgid', 'pid', 'start'])
  assert.deepEqual(atLaunch[names[0]], { v: 1, kind: 'codex', generation: 1, cwd: p.W, jobId: null, starter })
  assert.deepEqual(records(p.lockDir), [{ name: names[0], rec: { v: 1, kind: 'codex', generation: 1, cwd: p.W, jobId: 'task-7', starter } }])
})

test('a start that no longer holds its generation once the companion returns the job id quiesces that job and exits 4', async t => {
  const p = await lockProject(t)
  const files = stateFiles(t, { jobId: 'task-3', taskDelayMs: 1500, launchWorker: true, active: [], env: p.env })
  const starting = background(files, [SCRIPT, ...START(p)])
  const inTask = () => callsOf(files).some(c => c[0] === 'task')
  for (let i = 0; i < 200 && !inTask(); i++) await sleep(20)
  assert.ok(inTask(), 'the start never called the companion')
  // The holder dies while the companion launches the job.
  process.kill(p.holder, 'SIGKILL')
  for (let i = 0; i < 60 && startToken(p.holder).state !== 'gone'; i++) await sleep(50)
  const r = await starting
  assert.equal(r.status, 4, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual([out.state, out.jobId, out.quiet], ['not-holder', 'task-3', true], out.detail)
  const calls = callsOf(files)
  const [, w] = calls.find(c => c[0] === 'launched')
  assert.ok(gone(w), `the job's worker ${w} outlived the start`)
  assert.ok(calls.some(c => c[0] === 'cancel' && c[1] === 'task-3'), JSON.stringify(calls))
  // The record stays, with the job id, for the next acquire to quiesce again.
  assert.deepEqual(records(p.lockDir).map(x => x.rec.jobId), ['task-3'])
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
  assert.ok(gone(w), `worker ${w} survived`)
  assert.ok(gone(b), `broker ${b} survived`)
  assert.deepEqual(records(p.lockDir), [])
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(calls.some(c => c[0] === 'status' && c.includes('--all') && c[c.indexOf('--cwd') + 1] === p.W), JSON.stringify(calls))
  assert.ok(calls.some(c => c[0] === 'cancel' && c[1] === 'task-9' && c[c.indexOf('--cwd') + 1] === p.W), JSON.stringify(calls))
  assert.deepEqual(calls.find(c => c[0] === 'lib:sendBrokerShutdown'), ['lib:sendBrokerShutdown', 'unix:/tmp/b.sock'])
})

test('a reclaim waits for a Codex start that is still launching its job, which finds its generation lost and quiesces the job it launched', async t => {
  const p = await lockProject(t)
  // The broker takes 4 s to exit, which keeps the reclaim's quiesce busy while the start
  // finishes: the window in which a job launched after the jobs were listed went unseen.
  const b = await broker(t, 'unix:/tmp/slow.sock', '--exit-after-ms', '4000')
  const files = stateFiles(t, { jobId: 'task-5', taskDelayMs: 1200, launchWorker: true, broker: { pid: b, endpoint: 'unix:/tmp/slow.sock' }, stubborn: [b], active: [], env: p.env })
  const starting = background(files, [SCRIPT, ...START(p)])
  // The start is in the companion's task call once that call is logged: it has registered
  // and checked its record.
  const inTask = () => callsOf(files).some(c => c[0] === 'task')
  for (let i = 0; i < 200 && !inTask(); i++) await sleep(20)
  assert.ok(inTask(), 'the start never called the companion')
  const [{ name, rec }] = records(p.lockDir)
  assert.equal(rec.starter.pid > 0 && typeof rec.starter.start === 'string', true, JSON.stringify(rec))
  // The start leads its own process group here, and its companion runs in it.
  assert.equal(rec.starter.pgid, rec.starter.pid, JSON.stringify(rec))
  // The holder dies while the start is still in the companion's task call.
  process.kill(p.holder, 'SIGKILL')
  for (let i = 0; i < 60 && startToken(p.holder).state !== 'gone'; i++) await sleep(50)
  const acquiring = background(files, [LOCK, 'acquire', p.P], { ...envFor(files), TECH_LEAD_HOLDER_PID: String(sleeper(t)) })
  const [started, acq] = await Promise.all([starting, acquiring])
  // Once the companion returns, the start finds generation 1 lost and stops its own job.
  assert.equal(started.status, 4, started.stdout + started.stderr)
  const so = JSON.parse(started.stdout)
  assert.deepEqual([so.state, so.jobId], ['not-holder', 'task-5'], so.detail)
  assert.equal(acq.status, 0, acq.stdout + acq.stderr)
  assert.ok(acq.at >= started.at, 'the reclaim ended before the start it had to wait for')
  const out = JSON.parse(acq.stdout)
  assert.equal(out.generation, 2)
  assert.deepEqual(out.reclaimed.stopped, [{ file: name, kind: 'codex', jobId: 'task-5' }])
  const launchedWorker = callsOf(files).find(c => c[0] === 'launched')
  assert.ok(launchedWorker, 'the start never launched its job')
  assert.ok(gone(launchedWorker[1]), `the job's worker ${launchedWorker[1]} outlived the reclaim`)
  assert.deepEqual(records(p.lockDir), [])
})

// The test harness's cleanup (review round, contracts-tests#7): a hook that runs when a test
// ends signals a recorded pid or process group only while the id still names the process the
// test made, since under several concurrent suites the pid counter can wrap before the hook.
// impostorPs points TECH_LEAD_PS, for the rest of test t, at a ps that reads every live
// process as one started in 1970: each id recorded earlier then names another process.
const impostorPs = t => {
  const file = path.join(tmp(t), 'ps')
  fs.writeFileSync(file, '#!/bin/sh\necho "S Thu Jan 1 00:00:00 1970"\n', { mode: 0o755 })
  const before = process.env.TECH_LEAD_PS
  process.env.TECH_LEAD_PS = file
  t.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
}
const darwinOnly = { skip: process.platform !== 'darwin' && 'the start token reads ps on darwin only' }
const goneSoon = async pid => {
  for (let i = 0; i < 100 && !gone(pid); i++) await sleep(30)
  return gone(pid)
}
// The group of a leader that just died. On Linux the dead leader is a zombie, and so a member of
// its group, until this process's event loop reaps it; the waits here yield to that reap.
const groupGoneSoon = async pgid => {
  for (let i = 0; i < 100 && groupAlive(pgid) !== false; i++) await sleep(30)
  return groupAlive(pgid)
}
// A stand-in for a process the companion started, its pid written to a file as the fixtures
// write a member's.
const pidInFile = (t, pid) => {
  const file = path.join(tmp(t), 'member.pid')
  fs.writeFileSync(file, String(pid))
  return file
}

for (const [name, make] of [
  ['sleeper', async st => sleeper(st)],
  ['memberPid', async (st, t) => memberPid(st, pidInFile(st, sleeper(t)))],
]) {
  test(`contracts-tests#7: the ${name} cleanup kills its own process, and leaves alone a pid that names another process by then`, darwinOnly, async t => {
    let pid, start
    await t.test('the pid reads as another process when the test ends', async st => {
      pid = await make(st, t)
      start = startToken(pid).token
      impostorPs(st)
    })
    t.after(() => { if (isAlive({ pid, start }) === true) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
    assert.equal(isAlive({ pid, start }), true, `the cleanup killed pid ${pid}, which it could not prove its own`)
    await killed(pid)
    let own
    await t.test('the pid still names its process when the test ends', async st => { own = await make(st, t) })
    assert.ok(await goneSoon(own), `the cleanup left its own process ${own} running`)
  })
}

test('contracts-tests#7: the launched cleanup kills its own group, and leaves alone a group id whose leader is another process by then', darwinOnly, async t => {
  const IDLE = ['-e', 'setInterval(() => {}, 2 ** 30)']
  let pid, start
  await t.test('the leader reads as another process when the test ends', async st => {
    pid = await launched(st, [...IDLE, 'spared'])
    start = startToken(pid).token
    impostorPs(st)
  })
  t.after(() => { killGroupIfOurs(pid, start, { zombieOurs: false }) })
  assert.equal(isAlive({ pid, start }), true, `the cleanup killed ${pid}, which it could not prove its own`)
  assert.equal(groupAlive(pid), true)
  await killed(pid)
  let own
  await t.test('the leader is still the one recorded when the test ends', async st => { own = await launched(st, [...IDLE, 'own']) })
  assert.ok(await goneSoon(own), `the cleanup left its own leader ${own} running`)
  assert.equal(await groupGoneSoon(own), false)
})

test('contracts-tests#7: the stateFiles cleanup kills a launched worker it can prove its own, and leaves alone a logged pid that runs something else by then', async t => {
  const W = fs.realpathSync(tmp(t))
  // Where a logged worker was, the group of another program stands by the time the test ends.
  const LAUNCH = "const c = require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 120'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
  const other = Number(execFileSync(process.execPath, ['-e', LAUNCH], { encoding: 'utf8' }).trim())
  const otherStart = startToken(other).token
  t.after(() => { killGroupIfOurs(other, otherStart, { zombieOurs: false }) })
  const w = await launched(t, [FAKE, 'task-worker', '--cwd', W, '--job-id', 'task-1'])
  await t.test('the call log names the other group and the worker as launched', st => {
    const files = stateFiles(st, { jobId: 'task-1' })
    const task = ['task', '--background', '--json', '--write', '--cwd', W, '--prompt-file', '/b.md']
    fs.writeFileSync(files.log, [task, ['launched', other], ['launched', w]].map(c => `${JSON.stringify(c)}\n`).join(''))
  })
  assert.equal(startToken(other).token, otherStart, `the cleanup killed group ${other}, whose leader runs another program`)
  assert.equal(groupAlive(other), true)
  assert.ok(await goneSoon(w), `the cleanup left the launched worker ${w} running`)
  assert.equal(await groupGoneSoon(w), false)
})

test('contracts-tests#7: the stateFiles cleanup still kills what a background run left in its group after it exited', async t => {
  let member
  await t.test('a background run that leaves a member of its group behind', async st => {
    const files = stateFiles(st, {})
    const r = await background(files, ['-e', "const c = require('node:child_process').spawn('/bin/sleep', ['120'], { stdio: 'ignore' }); c.unref(); console.log(c.pid)"])
    member = Number(r.stdout.trim())
    const start = startToken(member).token
    t.after(() => { if (isAlive({ pid: member, start }) === true) try { process.kill(member, 'SIGKILL') } catch { /* gone */ } })
    assert.equal(typeof start, 'string', r.stderr)
  })
  assert.ok(await goneSoon(member), `the cleanup left ${member}, a member of an exited run's group, running`)
})
