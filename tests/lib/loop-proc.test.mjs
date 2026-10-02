// tests/lib/loop-proc.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { commandLine, groupAlive, isAlive, killGroup, parseProcStat, resolveHolder, startToken } from '../../scripts/lib/loop-proc.mjs'

const MODULE = path.join(ROOT, 'scripts', 'lib', 'loop-proc.mjs')
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-proc-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Polls fn until it returns a truthy value or ms pass; returns the last value.
const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms
  let v = fn()
  while (!v && Date.now() < deadline) { await sleep(50); v = fn() }
  return v
}
// A real process standing in for a holder. It is started through a shell that exits at
// once, so the test runner is not its parent and a killed one never lingers as a zombie.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}
// A pid that named a real process a moment ago and names none now.
const deadPid = async t => {
  const pid = sleeper(t)
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(() => startToken(pid).state === 'gone'), 'the killed sleeper never read as gone')
  return pid
}
// A process group of its own (setsid), led by /bin/sh running script. A short-lived node
// launcher starts it and exits at once, so the group's parent is init, which reaps it.
const LAUNCH = "const c = require('node:child_process').spawn('/bin/sh', ['-c', process.argv[1]], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
const group = (t, script) => {
  const pgid = Number(execFileSync(process.execPath, ['-e', LAUNCH, script], { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } })
  return pgid
}

test('a live process has a stable live token that records its start time in UTC', t => {
  const pid = sleeper(t)
  const a = startToken(pid)
  assert.equal(a.state, 'live')
  assert.deepEqual(startToken(pid), a)
  if (process.platform === 'darwin') {
    assert.match(a.token, /^darwin:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)
    // Read as UTC, the start is within a minute of now; a token in local time would be off
    // by the host's UTC offset.
    const started = Date.parse(`${a.token.slice('darwin:'.length)} UTC`)
    assert.ok(Math.abs(Date.now() - started) < 60000, `start ${a.token} is not now in UTC`)
  } else if (process.platform === 'linux') {
    assert.match(a.token, /^linux:[0-9a-f-]+:\d+$/)
  }
  assert.equal(isAlive({ pid, start: a.token }), true)
})

test('a killed process is gone, and its holder record reads as not alive', async t => {
  const pid = sleeper(t)
  const { token } = startToken(pid)
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(() => startToken(pid).state === 'gone'))
  assert.deepEqual(startToken(pid), { state: 'gone' })
  assert.equal(isAlive({ pid, start: token }), false)
})

test('a live pid under a different start token is not alive (the pid was reused)', t => {
  const pid = sleeper(t)
  const { token } = startToken(pid)
  const other = process.platform === 'linux' ? 'linux:00000000-0000-0000-0000-000000000000:1' : 'darwin:Thu Jan 1 00:00:00 1970'
  assert.notEqual(token, other)
  assert.equal(isAlive({ pid, start: token }), true)
  assert.equal(isAlive({ pid, start: other }), false)
})

test('a zombie counts as gone even though it can still be signalled', async t => {
  const file = path.join(tmp(t), 'zombie.pid')
  // The inner shell starts a child that exits at once, records its pid, then becomes
  // `sleep 120`, which never reaps it: the child stays a zombie until the parent dies.
  const parent = Number(execFileSync('/bin/sh', ['-c',
    `sh -c 'sleep 0 & echo $! > "$1"; exec sleep 120' sh "$1" >/dev/null 2>&1 & echo $!`, 'sh', file],
  { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(parent, 'SIGKILL') } catch { /* gone */ } })
  const zombie = await waitFor(() => { try { return Number(fs.readFileSync(file, 'utf8').trim()) || 0 } catch { return 0 } })
  assert.ok(zombie > 0, 'the zombie pid was never written')
  assert.ok(await waitFor(() => startToken(zombie).state === 'gone'), 'the exited child never read as gone')
  assert.doesNotThrow(() => process.kill(zombie, 0), 'the child was reaped, so this was not a zombie')
  assert.equal(isAlive({ pid: zombie, start: 'any' }), false)
})

test('a process this user may not signal (EPERM) still has a live token', () => {
  const t1 = startToken(1)
  assert.equal(t1.state, 'live')
  assert.match(t1.token, /^(darwin|linux):/)
})

test('a malformed pid or holder record is unknown, which isAlive reports as null', t => {
  for (const pid of [0, -1, 1.5, '12', null, undefined, NaN]) {
    assert.equal(startToken(pid).state, 'unknown', `pid ${String(pid)}`)
    assert.equal(isAlive({ pid, start: 'darwin:x' }), null, `pid ${String(pid)}`)
  }
  assert.equal(isAlive(null), null)
  // A live pid with no start recorded cannot be compared, so it is not called dead.
  assert.equal(isAlive({ pid: sleeper(t) }), null)
})

test('groupAlive sees a live group, finds none for a pid that leads no group, and never signals an unsafe pgid', async t => {
  const pgid = group(t, 'exec sleep 120')
  assert.equal(groupAlive(pgid), true)
  // The sleeper stays in the test runner's process group, so no group carries its pid.
  const pid = sleeper(t)
  assert.equal(startToken(pid).state, 'live')
  assert.equal(groupAlive(pid), false)
  for (const bad of [0, 1, -5, 1.5, null, undefined, 'x', String(pgid)]) assert.equal(groupAlive(bad), null, `pgid ${String(bad)}`)
  process.kill(-pgid, 'SIGKILL')
  assert.ok(await waitFor(() => groupAlive(pgid) === false))
})

test('killGroup stops a group whose grandchild ignores SIGTERM', async t => {
  const file = path.join(tmp(t), 'grandchild.pid')
  // The grandchild writes its own pid only once its trap is set, so the precondition below
  // never signals a group whose grandchild has not yet started ignoring SIGTERM.
  const pgid = group(t, `sh -c 'trap "" TERM; echo $$ > "$1"; exec sleep 120' sh '${file}' & wait`)
  const grandchild = await waitFor(() => { try { return Number(fs.readFileSync(file, 'utf8').trim()) || 0 } catch { return 0 } })
  assert.ok(grandchild > 0, 'the grandchild pid was never written')
  // Precondition: SIGTERM ends the leader but not the grandchild, so the group lives on.
  process.kill(-pgid, 'SIGTERM')
  assert.ok(await waitFor(() => startToken(pgid).state === 'gone'), 'the leader survived SIGTERM')
  await sleep(200)
  assert.equal(startToken(grandchild).state, 'live')
  assert.equal(groupAlive(pgid), true)

  const t0 = Date.now()
  assert.equal(await killGroup(pgid, { graceMs: 300 }), true)
  assert.ok(Date.now() - t0 >= 300, 'the group was gone before the grace ended, so SIGKILL was not needed')
  assert.equal(groupAlive(pgid), false)
  assert.equal(startToken(grandchild).state, 'gone')
})

test('killGroup returns early for a group that obeys SIGTERM, true for a group already gone, and rejects a bad pgid', async t => {
  // A readiness barrier: a member forked while kill(-pgid) runs could miss the SIGTERM and
  // hold the group for the whole grace, so the group is signalled only once both exist.
  const ready = path.join(tmp(t), 'ready')
  const pgid = group(t, `sleep 120 & sleep 120 & : > '${ready}'; wait`)
  assert.ok(await waitFor(() => fs.existsSync(ready)), 'the group never reported ready')
  assert.equal(groupAlive(pgid), true)
  const t0 = Date.now()
  assert.equal(await killGroup(pgid), true)
  assert.ok(Date.now() - t0 < 4000, 'killGroup waited for the whole grace on an obedient group')
  assert.equal(groupAlive(pgid), false)
  assert.equal(await killGroup(pgid, { graceMs: 100 }), true)
  // Validation comes before any signal; NaN would be refused by process.kill as well.
  await assert.rejects(killGroup('x'), /^Error: bad-pgid: /)
})

// Real /proc/<pid>/stat lines captured in a Linux container (alpine, kernel 6.x): a script
// whose name holds spaces and parentheses, and a zombie. The Linux branch of startToken
// cannot run on a macOS host, so its parser is checked against them here.
test('parseProcStat reads state and starttime (field 22) past a comm holding spaces and parentheses', () => {
  const weird = '8 (a b) (d) S 1 1 1 0 -1 4194304 66 0 0 0 0 0 0 0 20 0 1 0 9738017 1740800 242 18446744073709551615 187650600009728 187650600861660 281474959838304 0 0 0 0 6 65536 1 0 0 17 9 0 0 0 0 0 187650600912680 187650600927289 187651149185024 281474959838866 281474959838887 281474959838887 281474959839211 0\n'
  const zombie = '14 (busybox) Z 12 1 1 0 -1 4227084 57 0 0 0 0 0 0 0 20 0 1 0 9738048 0 0 18446744073709551615 0 0 0 0 0 0 0 6 0 1 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n'
  assert.deepEqual(parseProcStat(weird), { state: 'S', starttime: '9738017' })
  assert.deepEqual(parseProcStat(zombie), { state: 'Z', starttime: '9738048' })
  for (const bad of ['', '8 (sleep S 1 1', '8 (sleep) S 1 1 1', '8 (x) S 1 1 1 0 -1 4 66 0 0 0 0 0 0 0 20 0 1 0 12ab 1']) {
    assert.equal(parseProcStat(bad), null, JSON.stringify(bad))
  }
})

test('resolveHolder takes TECH_LEAD_HOLDER_PID before CLAUDE_PID', t => {
  const a = sleeper(t), b = sleeper(t)
  assert.deepEqual(resolveHolder({ TECH_LEAD_HOLDER_PID: String(a), CLAUDE_PID: String(b) }),
    { pid: a, start: startToken(a).token, how: 'TECH_LEAD_HOLDER_PID' })
})

test('resolveHolder falls back to CLAUDE_PID, read from process.env by default', t => {
  const b = sleeper(t)
  assert.deepEqual(resolveHolder({ CLAUDE_PID: String(b), TECH_LEAD_HOLDER_PID: '' }),
    { pid: b, start: startToken(b).token, how: 'CLAUDE_PID' })
  // The default argument is the real environment, as Claude Code sets it for a Bash command.
  const env = { ...process.env, CLAUDE_PID: String(b) }
  delete env.TECH_LEAD_HOLDER_PID
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { resolveHolder } from ${JSON.stringify(new URL(`file://${MODULE}`).href)}; console.log(JSON.stringify(resolveHolder()))`],
  { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { pid: b, start: startToken(b).token, how: 'CLAUDE_PID' })
})

test('resolveHolder throws no-holder unless the variable it reads names a live process', async t => {
  const live = sleeper(t), dead = await deadPid(t)
  for (const env of [
    {},
    { CLAUDE_PID: '' },
    { CLAUDE_PID: String(dead) },
    { CLAUDE_PID: 'abc' },
    { CLAUDE_PID: '0' },
    { CLAUDE_PID: '-1' },
    { CLAUDE_PID: `${live}x` },
    // The override, once set, is the holder: a dead one never falls back to CLAUDE_PID.
    { TECH_LEAD_HOLDER_PID: String(dead), CLAUDE_PID: String(live) },
  ]) assert.throws(() => resolveHolder(env), /^Error: no-holder: /, JSON.stringify(env))
})

test('commandLine reads a live process\'s argv as words, and reports a gone process, a zombie and a bad pid', async t => {
  const pid = Number(execFileSync('/bin/sh', ['-c', '"$@" >/dev/null 2>&1 & echo $!', 'sh', process.execPath, '-e', 'setInterval(() => {}, 1e9)', 'two words'], { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  // Between fork and exec the child still runs the shell; wait for the exec.
  const c = await waitFor(() => { const r = commandLine(pid); return r.state === 'live' && r.words.includes('-e') ? r : null })
  assert.ok(c, JSON.stringify(commandLine(pid)))
  assert.deepEqual(c.words.slice(-2), ['two', 'words'])
  assert.match(c.words[0], /node$/)
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(() => commandLine(pid).state === 'gone'))
  for (const bad of [0, -1, 1.5, null]) assert.equal(commandLine(bad).state, 'unknown', String(bad))
})

test('a live pid that ps fails to read is unknown, never gone', { skip: process.platform !== 'darwin' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ps-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fakePs = path.join(dir, 'ps')
  fs.writeFileSync(fakePs, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = process.env.TECH_LEAD_PS
  process.env.TECH_LEAD_PS = fakePs
  t.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
  assert.equal(startToken(process.pid).state, 'unknown')
})
