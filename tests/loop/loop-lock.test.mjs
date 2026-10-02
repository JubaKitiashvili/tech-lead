// tests/loop/loop-lock.test.mjs
// The firing lock (spec 10, stage 0c-1) against real processes and real temporary git
// repositories. Holders are sleepers named through TECH_LEAD_HOLDER_PID; <V> lives under a
// temporary TECH_LEAD_CACHE.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import {
  acquire, assertHeld, closeDispatch, ledgerFloor, openDispatch, registerCodex, release, setCodexJob, status, stopChildren,
} from '../../scripts/loop-lock.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { groupAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-lock.mjs')
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'codex', 'scripts', 'codex-companion.mjs')
// Keep the user's git config and hooks out of the fixture repositories, and keep any real
// Codex companion away from fixture records; the CLI children inherit this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix = 'tl-lock-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, ms = 3000) => {
  const deadline = Date.now() + ms
  let v = fn()
  while (!v && Date.now() < deadline) { await sleep(50); v = fn() }
  return v
}
// A real process standing in for a holder or a wrapper. It is started through a shell that
// exits at once, so the test runner is not its parent and a killed one never lingers as a zombie.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}
const kill = async pid => {
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(() => startToken(pid).state === 'gone'), `pid ${pid} never read as gone`)
}
// The identity of a process that existed a moment ago and is gone now.
const deadProcess = async t => {
  const pid = sleeper(t)
  const start = startToken(pid).token
  await kill(pid)
  return { pid, start }
}
// A process group of its own led by /bin/sh running script. A short-lived node launcher
// starts it and exits at once, so the group's parent is init, which reaps it.
// cwd, when given, is the group's working directory.
const LAUNCH = "const c = require('node:child_process').spawn('/bin/sh', ['-c', process.argv[1]], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
const group = (t, script, cwd) => {
  const pgid = Number(execFileSync(process.execPath, ['-e', LAUNCH, script], { encoding: 'utf8', cwd }).trim())
  t.after(() => { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } })
  return pgid
}
const killGroupNow = async pgid => {
  process.kill(-pgid, 'SIGKILL')
  assert.ok(await waitFor(() => groupAlive(pgid) === false), `group ${pgid} survived SIGKILL`)
}
// The process group id of this test process, as ps reports it.
const ownPgid = () => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
// An executable shell script standing in for a system tool (TECH_LEAD_PS, TECH_LEAD_LSOF).
const fakeTool = (t, name, body) => {
  const file = path.join(tmp(t), name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}
// A CLI acquire started without waiting; resolves {status, out, stderr}.
const acquireAsync = (t, e, P) => {
  const c = spawn(process.execPath, [SCRIPT, 'acquire', P], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', d => { out += d })
  c.stderr.on('data', d => { err += d })
  t.after(() => { try { c.kill('SIGKILL') } catch { /* gone */ } })
  return new Promise(resolve => c.on('close', status => resolve({ status, out: out.trim() ? JSON.parse(out) : null, stderr: err })))
}
const genSlots = lockDir => fs.readdirSync(path.join(lockDir, 'slots')).filter(n => /^\d+\.json$/.test(n)).sort()

// A repository with one commit and a spine directory, plus a cache root for <V>.
const project = t => {
  const P = tmp(t, 'tl-lock-p-')
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), '---\nverify:\n  - "true"\n---\n')
  return { P, S, cache: tmp(t, 'tl-lock-c-') }
}
const env = (p, pid, extra = {}) => ({
  ...process.env, TECH_LEAD_CACHE: p.cache, TECH_LEAD_HOLDER_PID: String(pid), CLAUDE_CODE_SESSION_ID: 'session-test', ...extra,
})
const cli = (e, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: e })
  const lines = r.stdout.trim() ? r.stdout.trim().split('\n') : []
  assert.equal(lines.length, 1, `${args.join(' ')}: expected one JSON line, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  return { status: r.status, out: JSON.parse(lines[0]), stderr: r.stderr }
}
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const writeChild = (lockDir, name, content) => {
  fs.mkdirSync(path.join(lockDir, 'children'), { recursive: true })
  fs.writeFileSync(path.join(lockDir, 'children', name), typeof content === 'string' ? content : JSON.stringify(content))
}
const children = lockDir => {
  try { return fs.readdirSync(path.join(lockDir, 'children')).sort() } catch { return [] }
}
const procRecord = (generation, { wrapper, pid = null, pgid = null, start = null }) => ({
  v: 1, kind: 'proc', generation, label: 'verify', cwd: '/w', command: 'npm test', wrapper, pid, pgid, start,
})
// Every path under dirs with its content, so a before/after pair shows any write.
const snapshot = (...dirs) => {
  const out = {}
  for (const d of dirs) {
    if (!fs.existsSync(d)) { out[d] = null; continue }
    for (const rel of fs.readdirSync(d, { recursive: true }).sort()) {
      const f = path.join(d, rel)
      out[f] = fs.lstatSync(f).isDirectory() ? 'dir' : fs.readFileSync(f, 'utf8')
    }
  }
  return out
}

test('acquire on an empty lock takes generation 1 and records the holder by pid and start', async t => {
  const p = project(t), a = sleeper(t)
  const r = await acquire(p.P, { env: env(p, a) })
  const paths = loopPaths(p.P, { env: env(p, a) })
  assert.equal(paths.V, path.join(p.cache, 'tech-lead', paths.key))
  assert.deepEqual(r, { state: 'acquired', generation: 1, V: paths.V, lockDir: path.join(paths.V, 'lock'), previous: null, reclaimed: null })
  const slot = readJSON(path.join(r.lockDir, 'slots', '1.json'))
  assert.deepEqual(slot, {
    v: 1, generation: 1, holder: { pid: a, start: startToken(a).token, how: 'TECH_LEAD_HOLDER_PID' },
    session: 'session-test', acquired_at: slot.acquired_at, previous: null,
  })
  assert.ok(Math.abs(Date.now() - Date.parse(slot.acquired_at)) < 60000, slot.acquired_at)
  assert.deepEqual(fs.readdirSync(path.join(r.lockDir, 'slots')), ['1.json'])
  assert.deepEqual(readJSON(path.join(r.V, 'identity.json')), { v: 1, R: fs.realpathSync.native(p.P) })
})

test('ledgerFloor is the largest numeric iteration; a missing ledger is 0 and bad lines are skipped', t => {
  const S = tmp(t)
  assert.equal(ledgerFloor(S), 0)
  assert.equal(ledgerFloor(path.join(S, 'missing')), 0)
  fs.writeFileSync(path.join(S, 'LEDGER.jsonl'), [
    '{"iteration":7,"ts":"x"}', 'not json', '{"iteration":"99"}', '{"iteration":41}', '', '[50]',
    '{"iteration":null}', '{"other":60}', '{"iteration":12}', '{"iteration": 70',
  ].join('\n') + '\n')
  assert.equal(ledgerFloor(S), 41)
})

test('the generation exceeds both the last lock generation and every ledger iteration', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  assert.equal((await acquire(p.P, { env: e })).generation, 1)
  await release(p.P, 1, { env: e })
  fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), '{"iteration":5}\n')
  const r = await acquire(p.P, { env: e })
  assert.equal(r.generation, 6)
  assert.deepEqual(r.previous, { generation: 1, released: true, reclaim: null })
  assert.equal(r.reclaimed, null)
  await release(p.P, 6, { env: e })
  assert.equal((await acquire(p.P, { env: e })).generation, 7)
})

test('a wiped <V> never repeats a generation: ledger iteration 41 gives 42', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), '{"iteration":40}\n{"iteration":41}\n')
  fs.rmSync(first.V, { recursive: true, force: true })
  const r = await acquire(p.P, { env: e })
  assert.equal(r.generation, 42)
  assert.equal(r.previous, null)
  assert.equal(r.reclaimed, null)
  assert.deepEqual(fs.readdirSync(path.join(r.lockDir, 'slots')), ['42.json'])
  assert.deepEqual(readJSON(path.join(r.V, 'identity.json')), { v: 1, R: fs.realpathSync.native(p.P) })
})

test('a live holder makes acquire exit 3 and write nothing, in <V> or in the spine', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), '{"iteration":3}\n')
  const first = cli(env(p, a), 'acquire', p.P)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(first.out.generation, 4)
  const before = snapshot(first.out.V, p.S)
  const r = cli(env(p, b), 'acquire', p.P)
  assert.equal(r.status, 3)
  assert.equal(r.out.state, 'held')
  assert.equal(r.out.reason, 'holder-live')
  assert.equal(r.out.generation, 4)
  assert.equal(r.out.holder.pid, a)
  assert.deepEqual(snapshot(first.out.V, p.S), before)
  const inProcess = await acquire(p.P, { env: env(p, b) })
  assert.equal(inProcess.reason, 'holder-live')
  assert.deepEqual(snapshot(first.out.V, p.S), before)
})

test('a dead holder is reclaimed: its process group is killed, its records removed, the reclaim recorded', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  openDispatch(p.P, 1, 'loop-worker', { env: env(p, a) })
  const pgid = group(t, 'sleep 120 & sleep 120; wait')
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  await kill(a)
  const r = await acquire(p.P, { env: env(p, b) })
  assert.equal(r.state, 'acquired')
  assert.equal(r.generation, 2)
  assert.deepEqual(r.previous, { generation: 1, released: false, reclaim: 'dead-holder' })
  assert.equal(r.reclaimed.generation, 1)
  assert.equal(r.reclaimed.how, 'dead-holder')
  assert.deepEqual(r.reclaimed.stopped.map(s => s.kind).sort(), ['dispatch', 'proc'])
  assert.equal(groupAlive(pgid), false)
  assert.deepEqual(children(first.lockDir), [])
  const slot = readJSON(path.join(first.lockDir, 'slots', '2.json'))
  assert.deepEqual(slot.previous, r.previous)
  assert.equal(slot.holder.pid, b)
})

test('a child that cannot be proven gone blocks the reclaim, and no generation is taken', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  await kill(a)
  // A record that cannot be read, and a record whose wrapper died before it learned its group.
  const cases = [['1-x.json', '{"v":1,'], ['1-verify.json', procRecord(1, { wrapper: await deadProcess(t) })]]
  for (const [name, content] of cases) {
    writeChild(first.lockDir, name, content)
    const r = await acquire(p.P, { env: env(p, b) })
    assert.equal(r.state, 'held', name)
    assert.equal(r.reason, 'child-live', name)
    assert.equal(r.generation, 1, name)
    assert.deepEqual(r.alive.map(c => c.file), [name])
    // No generation is taken; generation 1 is marked closing, so nothing registers in it.
    assert.deepEqual(fs.readdirSync(path.join(first.lockDir, 'slots')).sort(), ['1.closing.json', '1.json'])
    assert.deepEqual(children(first.lockDir), [name])
    fs.rmSync(path.join(first.lockDir, 'children', name))
  }
  assert.equal((await acquire(p.P, { env: env(p, b) })).generation, 2)
})

test('the same process reclaims its own unreleased generation and the reclaim is noted', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  await acquire(p.P, { env: e })
  const r = await acquire(p.P, { env: e })
  assert.equal(r.state, 'acquired')
  assert.equal(r.generation, 2)
  assert.deepEqual(r.previous, { generation: 1, released: false, reclaim: 'same-process' })
  assert.deepEqual(r.reclaimed, { generation: 1, how: 'same-process', stopped: [] })
  assert.deepEqual(readJSON(path.join(r.lockDir, 'slots', '2.json')).previous, r.previous)
})

test('a reused pid is another process: neither the holder for assertHeld nor a same-process reclaim', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const paths = loopPaths(p.P, { env: e })
  // Generation 1 was held by an earlier process that had a's pid.
  fs.mkdirSync(path.join(paths.lockDir, 'slots'), { recursive: true })
  const earlier = { pid: a, start: `${startToken(a).token.split(':')[0]}:Thu Jan 1 00:00:00 1970`, how: 'TECH_LEAD_HOLDER_PID' }
  fs.writeFileSync(path.join(paths.lockDir, 'slots', '1.json'), JSON.stringify({ v: 1, generation: 1, holder: earlier, session: null, acquired_at: '1970-01-01T00:00:00.000Z', previous: null }))
  assert.throws(() => assertHeld(paths, 1, e), { code: 'NOT_HOLDER' })
  const r = await acquire(p.P, { env: e })
  assert.equal(r.generation, 2)
  assert.deepEqual(r.previous, { generation: 1, released: false, reclaim: 'dead-holder' })
})

test('the same process with an open dispatch of its generation is held dispatch-open until the dispatch closes', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const id = openDispatch(p.P, 1, 'loop-worker: item 3', { env: e })
  assert.match(id, /^[0-9a-f]{16}$/)
  const [name] = children(first.lockDir)
  const rec = readJSON(path.join(first.lockDir, 'children', name))
  assert.ok(name.startsWith('1-'), name)
  assert.deepEqual(rec, { v: 1, kind: 'dispatch', generation: 1, id, label: 'loop-worker: item 3', opened_at: rec.opened_at })
  const before = snapshot(first.V, p.S)
  const held = await acquire(p.P, { env: e })
  assert.equal(held.state, 'held')
  assert.equal(held.reason, 'dispatch-open')
  assert.equal(held.generation, 1)
  assert.deepEqual(held.dispatches.map(d => d.id), [id])
  assert.deepEqual(snapshot(first.V, p.S), before)
  assert.throws(() => closeDispatch(p.P, 1, 'f'.repeat(16), { env: e }), /no-dispatch/)
  assert.deepEqual(closeDispatch(p.P, 1, id, { env: e }), { closed: true })
  assert.deepEqual(children(first.lockDir), [])
  const r = await acquire(p.P, { env: e })
  assert.equal(r.generation, 2)
  assert.equal(r.reclaimed.how, 'same-process')
})

test('release: only the holder releases; it stops its generation\'s children, and the next acquire starts fresh', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-deps.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  await assert.rejects(release(p.P, 1, { env: env(p, b) }), { code: 'NOT_HOLDER' })
  assert.equal(groupAlive(pgid), true)
  assert.ok(!fs.existsSync(path.join(first.lockDir, 'slots', '1.released.json')))
  const r = await release(p.P, 1, { env: e })
  assert.equal(r.state, 'released')
  assert.equal(r.generation, 1)
  assert.deepEqual(r.lingering, [])
  assert.equal(groupAlive(pgid), false)
  assert.deepEqual(children(first.lockDir), [])
  const rel = readJSON(path.join(first.lockDir, 'slots', '1.released.json'))
  assert.deepEqual(rel, { v: 1, generation: 1, by: 'holder', released_at: rel.released_at })
  await assert.rejects(release(p.P, 1, { env: e }), { code: 'NOT_HOLDER' })
  const next = await acquire(p.P, { env: env(p, b) })
  assert.equal(next.generation, 2)
  assert.deepEqual(next.previous, { generation: 1, released: true, reclaim: null })
  assert.equal(next.reclaimed, null)
})

test('owner release refuses without a terminal and writes nothing', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  openDispatch(p.P, 1, 'loop-worker', { env: e })
  const before = snapshot(first.V, p.S)
  const r = cli(e, 'release', p.P, '--generation', '1', '--owner')
  assert.equal(r.status, 2)
  assert.equal(r.out.state, 'error')
  assert.match(r.out.detail, /terminal/)
  assert.deepEqual(snapshot(first.V, p.S), before)
  await assert.rejects(release(p.P, 1, { env: e, owner: true, io: { isTTY: false } }), /terminal/)
  assert.deepEqual(snapshot(first.V, p.S), before)
})

test('owner release at a terminal shows the status, needs the generation typed, writes by owner and kills nothing', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  openDispatch(p.P, 1, 'loop-worker', { env: e })
  const printed = [], asked = []
  const io = answer => ({ isTTY: true, print: s => printed.push(s), ask: async q => { asked.push(q); return answer } })
  const before = snapshot(first.V, p.S)
  await assert.rejects(release(p.P, 1, { env: e, owner: true, io: io('2') }), /not-confirmed/)
  assert.deepEqual(snapshot(first.V, p.S), before)
  assert.ok(printed.join('\n').includes(`"pid": ${a}`), printed.join('\n'))
  assert.match(asked[0], /\b1\b/)
  const r = await release(p.P, 1, { env: e, owner: true, io: io('1\n') })
  assert.equal(r.state, 'released')
  assert.equal(r.generation, 1)
  const rel = readJSON(path.join(first.lockDir, 'slots', '1.released.json'))
  assert.deepEqual(rel, { v: 1, generation: 1, by: 'owner', released_at: rel.released_at })
  assert.equal(startToken(a).state, 'live')
  assert.equal(children(first.lockDir).length, 1)
  const next = await acquire(p.P, { env: env(p, b) })
  assert.equal(next.generation, 2)
  assert.deepEqual(next.previous, { generation: 1, released: true, reclaim: null })
})

test('assertHeld: NOT_HOLDER for another holder, after another acquire and after release; stale helpers write nothing', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), ea = env(p, a), eb = env(p, b)
  const paths = loopPaths(p.P, { env: ea })
  await acquire(p.P, { env: ea })
  assert.equal(assertHeld(paths, 1, ea).generation, 1)
  assert.throws(() => assertHeld(paths, 1, eb), { code: 'NOT_HOLDER' })
  await acquire(p.P, { env: ea })
  assert.throws(() => assertHeld(paths, 1, ea), { code: 'NOT_HOLDER' })
  await kill(a)
  const r = await acquire(p.P, { env: eb })
  assert.equal(r.generation, 3)
  assert.throws(() => assertHeld(paths, 2, eb), { code: 'NOT_HOLDER' })
  assert.equal(assertHeld(paths, 3, eb).holder.pid, b)
  const before = snapshot(r.V, p.S)
  assert.throws(() => openDispatch(p.P, 2, 'late', { env: eb }), { code: 'NOT_HOLDER' })
  assert.throws(() => registerCodex(p.P, 2, path.join(r.V, 'clone'), { env: eb }), { code: 'NOT_HOLDER' })
  const c = cli(eb, 'dispatch', 'open', p.P, '--generation', '2', '--label', 'late')
  assert.equal(c.status, 3)
  assert.equal(c.out.state, 'not-holder')
  assert.deepEqual(snapshot(r.V, p.S), before)
  await release(p.P, 3, { env: eb })
  assert.throws(() => assertHeld(paths, 3, eb), { code: 'NOT_HOLDER' })
})

test('the CLI prints one JSON line per call and exits 0, 2 or 3', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const acq = cli(e, 'acquire', p.P)
  assert.equal(acq.status, 0, acq.stderr)
  assert.equal(acq.out.state, 'acquired')
  assert.equal(acq.out.generation, 1)
  const st = cli(e, 'status', p.P)
  assert.equal(st.status, 0)
  assert.equal(st.out.generation, 1)
  assert.equal(st.out.released, false)
  assert.equal(st.out.holder.pid, a)
  assert.equal(st.out.holder_alive, true)
  const open = cli(e, 'dispatch', 'open', p.P, '--generation', '1', '--label', 'loop-worker')
  assert.equal(open.status, 0)
  assert.match(open.out.id, /^[0-9a-f]{16}$/)
  assert.deepEqual(cli(e, 'status', p.P).out.children.map(c => [c.kind, c.id]), [['dispatch', open.out.id]])
  assert.equal(cli(eb(), 'dispatch', 'close', p.P, '--generation', '1', '--id', open.out.id).status, 3)
  const close = cli(e, 'dispatch', 'close', p.P, '--generation', '1', '--id', open.out.id)
  assert.deepEqual([close.status, close.out], [0, { closed: true }])
  const stranger = cli(eb(), 'release', p.P, '--generation', '1')
  assert.deepEqual([stranger.status, stranger.out.state], [3, 'not-holder'])
  const rel = cli(e, 'release', p.P, '--generation', '1')
  assert.equal(rel.status, 0)
  assert.equal(rel.out.state, 'released')
  assert.equal(rel.out.generation, 1)
  assert.equal(cli(e, 'status', p.P).out.released, true)

  fs.mkdirSync(path.join(p.P, 'sub'))
  const sub = cli(e, 'acquire', path.join(p.P, 'sub'))
  assert.deepEqual([sub.status, sub.out.state], [2, 'error'])
  assert.match(sub.out.detail, /not-toplevel/)
  const noHolder = { ...e }
  delete noHolder.TECH_LEAD_HOLDER_PID
  delete noHolder.CLAUDE_PID
  const nh = cli(noHolder, 'acquire', p.P)
  assert.deepEqual([nh.status, nh.out.state], [2, 'error'])
  assert.match(nh.out.detail, /no-holder/)
  for (const args of [[], ['bogus', p.P], ['acquire'], ['release', p.P], ['release', p.P, '--generation', '0'],
    ['release', p.P, '--generation', '1x'], ['dispatch', 'open', p.P, '--generation', '2'],
    ['dispatch', 'close', p.P, '--generation', '2', '--id', '../x'], ['acquire', p.P, '--bogus', '1']]) {
    const u = cli(e, ...args)
    assert.deepEqual([u.status, u.out.state], [2, 'error'], args.join(' '))
  }
  function eb() { return env(p, b) }
})

test('status is read-only and reports the holder, the floor and each child', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const fresh = status(p.P, { env: e })
  assert.equal(fresh.generation, null)
  assert.deepEqual(fresh.children, [])
  assert.ok(!fs.existsSync(fresh.V), 'status created <V>')
  fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), '{"iteration":9}\n')
  const first = await acquire(p.P, { env: e })
  const id = openDispatch(p.P, 10, 'loop-worker', { env: e })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '10-verify.json', procRecord(10, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  const before = snapshot(first.V, p.S)
  const st = status(p.P, { env: e })
  assert.deepEqual(snapshot(first.V, p.S), before)
  assert.equal(st.generation, 10)
  assert.equal(st.released, false)
  assert.equal(st.holder.pid, a)
  assert.equal(st.holder_alive, true)
  assert.equal(st.floor, 9)
  const byKind = Object.fromEntries(st.children.map(c => [c.kind, c]))
  assert.equal(byKind.dispatch.id, id)
  assert.equal(byKind.proc.pgid, pgid)
  assert.equal(byKind.proc.alive, true)
  assert.equal(groupAlive(pgid), true)
})

test('registerCodex records the job before launch; a dead holder\'s Codex record blocks until Codex is quiet', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), ea = env(p, a)
  const first = await acquire(p.P, { env: ea })
  // By default the calling process is the starter, which a reclaim waits for.
  const self = registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: ea })
  assert.deepEqual(readJSON(self).starter, { pid: process.pid, start: startToken(process.pid).token, pgid: ownPgid() })
  fs.rmSync(self)
  // A start that has ended since it launched the job.
  const starter = await deadProcess(t)
  const file = registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: ea, starter })
  assert.ok(path.basename(file).startsWith('1-'), file)
  assert.deepEqual(readJSON(file), { v: 1, kind: 'codex', generation: 1, cwd: path.join(first.V, 'clone'), jobId: null, starter })
  setCodexJob(file, 'task-1')
  assert.deepEqual(readJSON(file), { v: 1, kind: 'codex', generation: 1, cwd: path.join(first.V, 'clone'), jobId: 'task-1', starter })
  await kill(a)
  const dir = tmp(t)
  const state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  const codexEnv = scenario => {
    fs.writeFileSync(state, JSON.stringify(scenario))
    return env(p, b, { TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log })
  }
  const held = cli(codexEnv({ listError: 'state unreadable' }), 'acquire', p.P)
  assert.equal(held.status, 3)
  assert.equal(held.out.reason, 'child-live')
  assert.ok(fs.existsSync(file))
  const ok = cli(codexEnv({ active: [] }), 'acquire', p.P)
  assert.equal(ok.status, 0, JSON.stringify(ok.out))
  assert.equal(ok.out.generation, 2)
  assert.deepEqual(ok.out.reclaimed.stopped.map(s => s.kind), ['codex'])
  assert.ok(!fs.existsSync(file))
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(calls.some(c => c[0] === 'status' && c.includes('--all') && c[c.indexOf('--cwd') + 1] === path.join(first.V, 'clone')), JSON.stringify(calls))
})

test('stopChildren touches only the named generation', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '10-verify.json', procRecord(10, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  const paths = loopPaths(p.P, { env: e })
  assert.deepEqual(await stopChildren(paths, 1), { stopped: [], alive: [] })
  assert.equal(groupAlive(pgid), true)
  assert.deepEqual(children(first.lockDir), ['10-verify.json'])
})

test('a proc record whose leader pid now names another process (a different start token) is gone: that group is never signalled', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  // The recorded group ended long ago and its pid now leads an unrelated group.
  const unrelated = group(t, 'sleep 120')
  const platform = startToken(unrelated).token.split(':')[0]
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: unrelated, pgid: unrelated, start: `${platform}:Thu Jan 1 00:00:00 1970` }))
  await kill(a)
  const r = await acquire(p.P, { env: env(p, b) })
  assert.equal(r.generation, 2)
  assert.deepEqual(r.reclaimed.stopped.map(s => s.file), ['1-verify.json'])
  assert.equal(groupAlive(unrelated), true, 'an unrelated process group was killed')
  assert.deepEqual(children(first.lockDir), [])
})

// A CLI environment whose Codex companion is the fake, playing scenario.
const fakeCodex = (t, p, holder, scenario) => {
  const dir = tmp(t)
  const state = path.join(dir, 'state.json')
  fs.writeFileSync(state, JSON.stringify(scenario))
  return env(p, holder, { TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: path.join(dir, 'calls.log') })
}
const ownerIo = n => ({ isTTY: true, print: () => {}, ask: async () => String(n) })

test('an owner release stops nothing, but the next acquire stops the released generation\'s children before it takes the next one', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  // A verify group whose wrapper died with the interrupted turn; the holder lives on.
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  await release(p.P, 1, { env: e, owner: true, io: ownerIo(1) })
  assert.equal(groupAlive(pgid), true)
  const next = await acquire(p.P, { env: env(p, b) })
  assert.equal(next.state, 'acquired')
  assert.equal(next.generation, 2)
  assert.deepEqual(next.previous, { generation: 1, released: true, reclaim: null })
  assert.equal(next.reclaimed, null)
  assert.deepEqual((next.stopped ?? []).map(s => [s.file, s.kind]), [['1-verify.json', 'proc']])
  assert.equal(groupAlive(pgid), false, 'the released generation\'s group outlived the next acquire')
  assert.deepEqual(children(first.lockDir), [])
})

test('a child a holder release left lingering blocks every later acquire until it is gone', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  const file = registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: env(p, a), starter: await deadProcess(t) })
  // The companion cannot list its jobs, so quiesce cannot prove Codex quiet.
  const rel = cli(fakeCodex(t, p, a, { listError: 'state.json was half-written' }), 'release', p.P, '--generation', '1')
  assert.equal(rel.status, 0, rel.stderr)
  assert.deepEqual(rel.out.lingering.map(c => c.file), [path.basename(file)])
  for (const holder of [b, a]) {
    const r = cli(fakeCodex(t, p, holder, { listError: 'state.json was half-written' }), 'acquire', p.P)
    assert.equal(r.status, 3, JSON.stringify(r.out))
    assert.equal(r.out.reason, 'child-live')
    assert.deepEqual(r.out.alive.map(c => c.file), [path.basename(file)])
    assert.deepEqual(fs.readdirSync(path.join(first.lockDir, 'slots')).sort(), ['1.closing.json', '1.json', '1.released.json'])
  }
  const ok = cli(fakeCodex(t, p, b, { active: [] }), 'acquire', p.P)
  assert.equal(ok.status, 0, JSON.stringify(ok.out))
  assert.equal(ok.out.generation, 2)
  assert.deepEqual(ok.out.stopped.map(c => c.file), [path.basename(file)])
  assert.deepEqual(children(first.lockDir), [])
})

test('release refuses while a dispatch of its generation is open, stops and writes nothing, and releases once it is closed', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const id = openDispatch(p.P, 1, 'loop-worker', { env: e })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  const before = snapshot(first.V, p.S)
  await assert.rejects(release(p.P, 1, { env: e }), e2 => e2.code === 'DISPATCH_OPEN' && e2.dispatches.map(d => d.id).join() === id)
  const r = cli(e, 'release', p.P, '--generation', '1')
  assert.equal(r.status, 3)
  assert.equal(r.out.state, 'dispatch-open')
  assert.equal(r.out.generation, 1)
  assert.deepEqual(r.out.dispatches.map(d => d.id), [id])
  assert.deepEqual(snapshot(first.V, p.S), before)
  assert.equal(groupAlive(pgid), true)
  closeDispatch(p.P, 1, id, { env: e })
  const ok = await release(p.P, 1, { env: e })
  assert.equal(ok.state, 'released')
  assert.deepEqual(ok.lingering, [])
  assert.equal(groupAlive(pgid), false)
})

test('a dispatch record goes only once its holder is gone or the owner released its generation', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const paths = loopPaths(p.P, { env: e })
  const id = openDispatch(p.P, 1, 'loop-worker', { env: e })
  const name = `1-dispatch-${id}.json`
  // Its holder lives (this is what a release or a same-process reclaim sees): it stays.
  const live = await stopChildren(paths, 1)
  assert.deepEqual(live.stopped, [])
  assert.deepEqual(live.alive.map(c => [c.file, c.kind]), [[name, 'dispatch']])
  assert.deepEqual(children(first.lockDir), [name])
  // A dispatch record that outlived a holder release (one opened while the release ran):
  // the same process may not start the next firing while its holder lives.
  closeDispatch(p.P, 1, id, { env: e })
  await release(p.P, 1, { env: e })
  writeChild(first.lockDir, name, { v: 1, kind: 'dispatch', generation: 1, id, label: 'loop-worker', opened_at: '2026-10-01T00:00:00.000Z' })
  const same = await acquire(p.P, { env: e })
  assert.equal(same.state, 'held')
  assert.equal(same.reason, 'child-live')
  assert.deepEqual(same.alive.map(c => c.file), [name])
  assert.deepEqual(fs.readdirSync(path.join(first.lockDir, 'slots')).sort(), ['1.closing.json', '1.json', '1.released.json'])
  await kill(a)
  const next = await acquire(p.P, { env: env(p, b) })
  assert.equal(next.generation, 2)
  assert.deepEqual(next.stopped.map(c => c.file), [name])
  assert.deepEqual(children(first.lockDir), [])
  // The owner vouches that the firing is not running: its open dispatch goes with the release.
  const id2 = openDispatch(p.P, 2, 'loop-worker', { env: env(p, b) })
  await release(p.P, 2, { env: env(p, b), owner: true, io: ownerIo(2) })
  const after = await acquire(p.P, { env: env(p, b) })
  assert.equal(after.generation, 3)
  assert.deepEqual(after.stopped.map(c => c.file), [`2-dispatch-${id2}.json`])
  assert.deepEqual(children(first.lockDir), [])
})

test('acquire never stops a child of a generation above the last one it read: a racer that acquired meanwhile owns it', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  await release(p.P, 1, { env: e })
  // What a slow acquire finds when another firing took the next generation after it read
  // the last one (1) and started an exec child of it.
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '5-verify.json', procRecord(5, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  const r = await acquire(p.P, { env: env(p, b) })
  assert.equal(r.generation, 2)
  assert.equal(r.stopped, undefined)
  assert.equal(groupAlive(pgid), true, 'a racer\'s child was stopped')
  assert.deepEqual(children(first.lockDir), ['5-verify.json'])
})

test('a proc record whose live leader has no recorded start cannot be verified: it blocks the reclaim and is never signalled', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  const leader = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: leader, pgid: leader, start: null }))
  await kill(a)
  const r = await acquire(p.P, { env: env(p, b) })
  assert.equal(r.state, 'held')
  assert.equal(r.reason, 'child-live')
  assert.equal(groupAlive(leader), true, 'an unverifiable process group was signalled')
})

test('a proc record whose pid is not its pgid, or not an integer above 1, cannot be verified: it blocks the reclaim and is never signalled', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  await kill(a)
  const leader = group(t, 'sleep 120')
  const start = startToken(leader).token
  const cases = {
    'the pid of another process': { pid: (await deadProcess(t)).pid, pgid: leader, start },
    'a pid spelled as a string': { pid: String(leader), pgid: leader, start },
    'pid 1': { pid: 1, pgid: leader, start },
  }
  for (const [why, ids] of Object.entries(cases)) {
    writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), ...ids }))
    const r = await acquire(p.P, { env: env(p, b) })
    assert.deepEqual([r.state, r.reason], ['held', 'child-live'], why)
    assert.equal(groupAlive(leader), true, `${why}: an unverifiable process group was signalled`)
    assert.equal(status(p.P, { env: env(p, b) }).children[0].alive, null, why)
    fs.rmSync(path.join(first.lockDir, 'children', '1-verify.json'))
  }
})

test('acquire stops the children of every generation below the one it takes, also when their slots were lost', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  await release(p.P, 1, { env: env(p, a) })
  // A child of generation 3, whose slot is lost; the ledger reached 5, so acquire takes 6.
  const g3 = group(t, 'sleep 120')
  writeChild(first.lockDir, '3-verify.json', procRecord(3, { wrapper: await deadProcess(t), pid: g3, pgid: g3, start: startToken(g3).token }))
  fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), '{"iteration":5}\n')
  const r = await acquire(p.P, { env: env(p, b) })
  assert.equal(r.state, 'acquired', JSON.stringify(r))
  assert.equal(r.generation, 6)
  assert.deepEqual((r.stopped ?? []).map(s => s.file), ['3-verify.json'])
  assert.equal(groupAlive(g3), false, 'a child below the new generation outlived the acquire')
  // No slot on record at all: every child record is stopped, and the generation exceeds
  // each of theirs (a generation that had children existed).
  fs.rmSync(path.join(first.lockDir, 'slots'), { recursive: true })
  const g9 = group(t, 'sleep 120')
  writeChild(first.lockDir, '9-verify.json', procRecord(9, { wrapper: await deadProcess(t), pid: g9, pgid: g9, start: startToken(g9).token }))
  const r2 = await acquire(p.P, { env: env(p, b) })
  assert.equal(r2.state, 'acquired', JSON.stringify(r2))
  assert.equal(r2.generation, 10)
  assert.equal(r2.previous, null)
  assert.deepEqual((r2.stopped ?? []).map(s => s.file), ['9-verify.json'])
  assert.equal(groupAlive(g9), false)
  assert.deepEqual(children(first.lockDir), [])
})

test('a process left with its cwd in <S>/worktree or <V> blocks a reclaim and is never signalled; the caller\'s own ancestors do not', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const W = path.join(p.S, 'worktree')
  fs.mkdirSync(W)
  const first = await acquire(p.P, { env: env(p, a) })
  // A delegate's command the dead firing never recorded, still running in the work tree.
  const stray = group(t, 'sleep 120; exit 0', W)
  await kill(a)
  const r = await acquire(p.P, { env: env(p, b) })
  assert.deepEqual([r.state, r.reason, r.generation], ['held', 'child-live', 1], JSON.stringify(r))
  assert.ok(r.procs.some(x => x.pid === stray), JSON.stringify(r.procs))
  assert.ok(r.procs.every(x => typeof x.cwd === 'string'), JSON.stringify(r.procs))
  assert.equal(groupAlive(stray), true, 'a stray process was signalled')
  assert.deepEqual(genSlots(first.lockDir), ['1.json'])
  await killGroupNow(stray)
  const ok = await acquire(p.P, { env: env(p, b) })
  assert.deepEqual([ok.state, ok.generation, ok.reclaimed.how], ['acquired', 2, 'dead-holder'])
  // The same process reclaiming its own generation: a process in <V> blocks it too.
  const inV = path.join(ok.V, 'scratch')
  fs.mkdirSync(inV)
  const stray2 = group(t, 'sleep 120; exit 0', inV)
  const same = await acquire(p.P, { env: env(p, b) })
  assert.deepEqual([same.state, same.reason], ['held', 'child-live'], JSON.stringify(same))
  assert.ok(same.procs.some(x => x.pid === stray2), JSON.stringify(same.procs))
  assert.equal(groupAlive(stray2), true)
  await killGroupNow(stray2)
  // The caller's own ancestors may stand in the work tree: an acquire run from two nested
  // shells there (neither execs its command, so both stay in the chain).
  const inner = `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} acquire ${JSON.stringify(p.P)}; exit $?`
  const nested = spawnSync('/bin/sh', ['-c', 'cd "$1" || exit 9; /bin/sh -c "$2"; exit $?', 'sh', W, inner], { encoding: 'utf8', env: env(p, b) })
  assert.equal(nested.status, 0, nested.stdout + nested.stderr)
  const out = JSON.parse(nested.stdout)
  assert.deepEqual([out.state, out.generation, out.reclaimed.how], ['acquired', 3, 'same-process'])
})

test('a reclaim whose process sweep cannot run is held sweep-unknown', { skip: process.platform !== 'darwin' && 'the sweep reads lsof on darwin only' }, async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  await kill(a)
  const r = cli(env(p, b, { TECH_LEAD_LSOF: fakeTool(t, 'lsof', 'exit 1') }), 'acquire', p.P)
  assert.equal(r.status, 3, JSON.stringify(r.out))
  assert.deepEqual([r.out.state, r.out.reason, r.out.generation], ['held', 'sweep-unknown', 1])
  assert.equal(typeof r.out.detail, 'string')
  assert.deepEqual(genSlots(first.lockDir), ['1.json'])
  assert.equal(cli(env(p, b), 'acquire', p.P).out.generation, 2)
})

test('a reclaim closes the generation it stops: no child registers in it afterwards, and its holder can no longer release it', async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  writeChild(first.lockDir, '1-x.json', '{"v":1,')
  const r = await acquire(p.P, { env: e })
  assert.deepEqual([r.state, r.reason], ['held', 'child-live'])
  assert.ok(fs.existsSync(path.join(first.lockDir, 'slots', '1.closing.json')), 'no closing marker')
  const paths = loopPaths(p.P, { env: e })
  assert.throws(() => assertHeld(paths, 1, e), err => err.code === 'NOT_HOLDER' && err.reason === 'closing')
  assert.throws(() => openDispatch(p.P, 1, 'late', { env: e }), { code: 'NOT_HOLDER' })
  assert.throws(() => registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: e, starter: null }), { code: 'NOT_HOLDER' })
  const d = cli(e, 'dispatch', 'open', p.P, '--generation', '1', '--label', 'late')
  assert.deepEqual([d.status, d.out.state, d.out.reason], [3, 'not-holder', 'closing'])
  const x = spawnSync(process.execPath, [SCRIPT, 'exec', p.P, '--generation', '1', '--label', 'verify', '--cwd', p.S, '--', '/bin/sh', '-c', 'echo ran > ran.txt'], { encoding: 'utf8', env: e })
  assert.equal(x.status, 125, x.stderr)
  assert.ok(!fs.existsSync(path.join(p.S, 'ran.txt')), 'exec ran a command in a closing generation')
  await assert.rejects(release(p.P, 1, { env: e }), { code: 'NOT_HOLDER' })
  assert.deepEqual(children(first.lockDir), ['1-x.json'])
  assert.equal(status(p.P, { env: e }).closing, true)
})

test('a reclaimer that finds a newer generation before a destructive step backs off: it quiesces nothing, kills nothing and removes nothing', { timeout: 60000 }, async t => {
  const p = project(t), a = sleeper(t), c = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  // A Codex job whose starter still runs, so the reclaim waits on it before it quiesces.
  const starter = group(t, 'sleep 120; exit 0')
  const codexFile = registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: env(p, a), starter: { pid: starter, start: startToken(starter).token, pgid: starter } })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  await kill(a)
  const dir = tmp(t), state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify({ active: [] }))
  const slow = acquireAsync(t, env(p, sleeper(t), { TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log }), p.P)
  await waitFor(() => fs.existsSync(path.join(first.lockDir, 'slots', '1.closing.json')), 5000)
  // Meanwhile another firing took generation 2; then the starter ends.
  fs.writeFileSync(path.join(first.lockDir, 'slots', '2.json'), JSON.stringify({
    v: 1, generation: 2, holder: { pid: c, start: startToken(c).token, how: 'TECH_LEAD_HOLDER_PID' }, session: null, acquired_at: new Date().toISOString(), previous: null,
  }))
  await killGroupNow(starter)
  const r = await slow
  assert.equal(r.status, 3, JSON.stringify(r))
  assert.deepEqual([r.out.state, r.out.reason, r.out.generation], ['held', 'race', 1])
  assert.ok(!fs.existsSync(log), `the slow reclaimer ran Codex: ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`)
  assert.ok(fs.existsSync(codexFile), 'the Codex record was removed')
  assert.ok(children(first.lockDir).includes('1-verify.json'), 'the proc record was removed')
  assert.equal(groupAlive(pgid), true, 'the slow reclaimer killed a process group after a newer generation appeared')
})

test('a Codex record is quiesced only once its starter and the starter\'s process group are gone; an unusable group id blocks', { timeout: 60000 }, async t => {
  const p = project(t), a = sleeper(t)
  const first = await acquire(p.P, { env: env(p, a) })
  // The starter itself has ended, but a process of its group (a companion child) still runs.
  const grp = group(t, 'sleep 120; exit 0')
  const file = registerCodex(p.P, 1, path.join(first.V, 'clone'), { env: env(p, a), starter: { ...(await deadProcess(t)), pgid: grp } })
  await kill(a)
  const dir = tmp(t), state = path.join(dir, 'state.json'), log = path.join(dir, 'calls.log')
  fs.writeFileSync(state, JSON.stringify({ active: [] }))
  const b = sleeper(t)
  const ce = env(p, b, { TECH_LEAD_CODEX_COMPANION: FAKE, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log })
  const run = acquireAsync(t, ce, p.P)
  await sleep(2000)
  assert.ok(!fs.existsSync(log), 'Codex was quiesced while the starter\'s process group was alive')
  await killGroupNow(grp)
  const r = await run
  assert.equal(r.status, 0, JSON.stringify(r))
  assert.deepEqual(r.out.reclaimed.stopped.map(s => s.kind), ['codex'])
  assert.ok(!fs.existsSync(file))
  assert.ok(fs.readFileSync(log, 'utf8').includes('"--all"'))
  // A starter whose recorded group id is not a usable one cannot be waited on: it blocks
  // (here the same process reclaims its own generation 2).
  const bad = registerCodex(p.P, 2, path.join(first.V, 'clone'), { env: env(p, b), starter: { ...(await deadProcess(t)), pgid: 0 } })
  const held = cli(ce, 'acquire', p.P)
  assert.deepEqual([held.status, held.out.reason], [3, 'child-live'], JSON.stringify(held.out))
  assert.ok(fs.existsSync(bad))
})

test('an owner release discards the child records no acquire could stop (unreadable, unknown kind), kills nothing, and the next acquire proceeds', async t => {
  const p = project(t), a = sleeper(t), b = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const pgid = group(t, 'sleep 120')
  writeChild(first.lockDir, '1-x.json', '{"v":1,')
  writeChild(first.lockDir, '1-y.json', { v: 1, kind: 'mystery', generation: 1 })
  writeChild(first.lockDir, '1-verify.json', procRecord(1, { wrapper: await deadProcess(t), pid: pgid, pgid, start: startToken(pgid).token }))
  const printed = []
  const io = answer => ({ isTTY: true, print: s => printed.push(s), ask: async () => answer })
  await assert.rejects(release(p.P, 1, { env: e, owner: true, io: io('2') }), /not-confirmed/)
  assert.deepEqual(children(first.lockDir), ['1-verify.json', '1-x.json', '1-y.json'])
  const r = await release(p.P, 1, { env: e, owner: true, io: io('1') })
  assert.equal(r.state, 'released')
  assert.deepEqual(r.discarded.map(d => d.file), ['1-x.json', '1-y.json'])
  assert.deepEqual(children(first.lockDir), ['1-verify.json'])
  assert.equal(groupAlive(pgid), true, 'an owner release signalled a process group')
  assert.match(printed.join('\n'), /1-x\.json/)
  const next = await acquire(p.P, { env: env(p, b) })
  assert.equal(next.state, 'acquired', JSON.stringify(next))
  assert.equal(next.generation, 2)
  assert.deepEqual((next.stopped ?? []).map(s => s.file), ['1-verify.json'])
  assert.equal(groupAlive(pgid), false)
})

test('a holder whose start token cannot be read is holder-unknown: exit 2 for every lock-checked command, a held refusal for acquire', { skip: process.platform !== 'darwin' && 'the start token comes from ps on darwin only' }, async t => {
  const p = project(t), a = sleeper(t), e = env(p, a)
  const first = await acquire(p.P, { env: e })
  const id = openDispatch(p.P, 1, 'loop-worker', { env: e })
  const u = { ...e, TECH_LEAD_PS: fakeTool(t, 'ps', 'exit 1') }
  const before = snapshot(first.V, p.S)
  for (const args of [['release', p.P, '--generation', '1'], ['dispatch', 'open', p.P, '--generation', '1', '--label', 'x'], ['dispatch', 'close', p.P, '--generation', '1', '--id', id]]) {
    const r = cli(u, ...args)
    assert.deepEqual([r.status, r.out.state], [2, 'error'], `${args.join(' ')}: ${JSON.stringify(r.out)}`)
    assert.match(r.out.detail, /^holder-unknown: /, args.join(' '))
  }
  const acq = cli(u, 'acquire', p.P)
  assert.deepEqual([acq.status, acq.out.state, acq.out.reason], [3, 'held', 'holder-unknown'], JSON.stringify(acq.out))
  assert.match(acq.out.detail, /^holder-unknown: /)
  const x = spawnSync(process.execPath, [SCRIPT, 'exec', p.P, '--generation', '1', '--label', 'verify', '--cwd', p.S, '--', '/bin/sh', '-c', 'echo ran > ran.txt'], { encoding: 'utf8', env: u })
  assert.equal(x.status, 2, x.stderr)
  const st = JSON.parse(/loop-lock exec: (\{.*\})\s*$/.exec(x.stderr)[1])
  assert.equal(st.state, 'error')
  assert.match(st.detail, /^holder-unknown: /)
  assert.deepEqual(snapshot(first.V, p.S), before)
})
