// tests/loop/loop-interrupt.test.mjs
// Lock interruption (spec 10, stage 0c-1 acceptance): a firing (tests/fixtures/firing-driver.mjs,
// its own holder) is SIGKILLed at each boundary: after acquire, during an exec child, and
// after its ledger append but before release. The next acquire reclaims, kills the group
// the dead firing left behind, and never repeats a generation. The work tree is the 0c-1
// loop's <S>/worktree, so every reclaim also sweeps it for processes no record names.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { groupAlive, isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

const LOCK = path.join(ROOT, 'scripts', 'loop-lock.mjs')
const DRIVER = path.join(ROOT, 'tests', 'fixtures', 'firing-driver.mjs')
const T = { timeout: 90000 }
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (fn, ms = 10000) => {
  const deadline = Date.now() + ms
  let v = fn()
  while (!v && Date.now() < deadline) { await sleep(50); v = fn() }
  return v
}
const gone = pid => startToken(pid).state === 'gone'
// A real process standing in for a holder, started through a shell that exits at once.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}
// Kills a process group (-pgid) or a process when the test ends; a process only while its
// start token still matches, so a reused pid is left alone.
const reap = (t, id) => {
  const start = id > 0 ? startToken(id).token : null
  t.after(() => {
    if (id > 0 ? isAlive({ pid: id, start }) !== true : groupAlive(-id) !== true) return
    try { process.kill(id, 'SIGKILL') } catch { /* gone */ }
  })
}

// verify[0] outlives any firing: a foreground sleep plus a grandchild whose pid lands in
// gc.pid. verify[1] finishes at once.
const LOOP_MD = `---
level: 1
verify:
  - sleep 300 >/dev/null 2>&1 & echo $! > gc.pid; sleep 300 >/dev/null 2>&1
  - echo ok > verified.txt
---
`
const project = t => {
  const P = tmp(t, 'tl-int-p-')
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), LOOP_MD)
  fs.mkdirSync(path.join(S, 'worktree'))
  return { P, S, cache: tmp(t, 'tl-int-c-'), W: fs.realpathSync(path.join(S, 'worktree')) }
}
const ledger = p => {
  const f = path.join(p.S, 'LEDGER.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
}
const childFiles = lockDir => {
  try { return fs.readdirSync(path.join(lockDir, 'children')).sort() } catch { return [] }
}

// A firing in a process group of its own, so killing that group kills the firing and the
// exec wrapper it started, but not the exec child's own group. Events are its JSON lines.
const firing = (t, p, stop) => {
  const c = spawn(process.execPath, [DRIVER, p.P, p.W, stop], {
    env: { ...process.env, TECH_LEAD_CACHE: p.cache }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const events = []
  let buf = '', stderr = '', exit = null
  c.stdout.on('data', d => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) events.push(JSON.parse(buf.slice(0, i)))
  })
  c.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => c.on('exit', (code, signal) => { exit = { code, signal }; resolve(exit) }))
  t.after(() => {
    try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ }
    c.stdout.destroy()
    c.stderr.destroy()
  })
  const event = async name => {
    const e = await waitFor(() => events.find(x => x.event === name) || (exit && 'exit'), 30000)
    assert.ok(e && e !== 'exit', `no ${name} event from the firing (events ${JSON.stringify(events)}, exit ${JSON.stringify(exit)}, stderr ${stderr})`)
    return e
  }
  // SIGKILL for the firing and its exec wrapper at once, as when the session dies.
  const kill = async () => {
    process.kill(-c.pid, 'SIGKILL')
    await exited
    assert.ok(await waitFor(() => groupAlive(c.pid) === false), `firing group ${c.pid} survived`)
  }
  return { pid: c.pid, event, kill, exited, events }
}
const acquireCli = (p, holder) => {
  const r = spawnSync(process.execPath, [LOCK, 'acquire', p.P], { encoding: 'utf8', env: { ...process.env, TECH_LEAD_CACHE: p.cache, TECH_LEAD_HOLDER_PID: String(holder) } })
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr }
}

test('a firing killed at each boundary is reclaimed by the next acquire, its orphaned group killed, and no generation repeats', T, async t => {
  const p = project(t)
  const generations = []

  // 1. Killed right after acquire: nothing else is left behind.
  const f1 = firing(t, p, 'acquired')
  const a1 = await f1.event('acquired')
  assert.deepEqual([a1.generation, a1.previous, a1.reclaimed], [1, null, null])
  generations.push(a1.generation)
  await f1.kill()

  // 2. Killed during an exec child: the firing and the wrapper die; the child's group lives on.
  const f2 = firing(t, p, 'exec')
  const a2 = await f2.event('acquired')
  assert.equal(a2.generation, 2)
  assert.deepEqual(a2.previous, { generation: 1, released: false, reclaim: 'dead-holder' })
  assert.deepEqual(a2.reclaimed, { generation: 1, how: 'dead-holder', stopped: [] })
  generations.push(a2.generation)
  const ex = await f2.event('exec')
  reap(t, -ex.pgid)
  const gcFile = path.join(p.W, 'gc.pid')
  assert.ok(await waitFor(() => fs.existsSync(gcFile) && fs.readFileSync(gcFile, 'utf8').trim()), 'the exec child never started its grandchild')
  const gc = Number(fs.readFileSync(gcFile, 'utf8').trim())
  reap(t, gc)
  await f2.kill()
  assert.ok(await waitFor(() => gone(ex.wrapper)), `wrapper ${ex.wrapper} survived`)
  assert.equal(groupAlive(ex.pgid), true, 'the orphaned group should outlive its firing')
  assert.equal(gone(gc), false)
  assert.equal(childFiles(a2.lockDir).length, 1)

  // 3. The next firing reclaims generation 2: it kills the orphaned group before taking 3.
  //    It is then killed after its ledger append, before its release.
  const f3 = firing(t, p, 'ledger')
  const a3 = await f3.event('acquired')
  assert.equal(a3.generation, 3)
  assert.deepEqual(a3.previous, { generation: 2, released: false, reclaim: 'dead-holder' })
  assert.equal(a3.reclaimed.how, 'dead-holder')
  assert.deepEqual(a3.reclaimed.stopped.map(s => [s.kind, s.label, s.pgid]), [['proc', 'verify', ex.pgid]])
  assert.equal(groupAlive(ex.pgid), false)
  assert.ok(await waitFor(() => gone(gc)), `grandchild ${gc} survived the reclaim`)
  generations.push(a3.generation)
  await f3.event('ledger')
  assert.deepEqual(ledger(p).map(r => r.iteration), [3])
  assert.equal(fs.readFileSync(path.join(p.W, 'verified.txt'), 'utf8'), 'ok\n')
  await f3.kill()
  assert.deepEqual(childFiles(a3.lockDir), [])

  // 4. Any next holder reclaims generation 3 and takes 4.
  const b = sleeper(t)
  const a4 = acquireCli(p, b)
  assert.equal(a4.status, 0, a4.stderr)
  assert.deepEqual(a4.out.reclaimed, { generation: 3, how: 'dead-holder', stopped: [] })
  generations.push(a4.out.generation)
  assert.deepEqual(generations, [1, 2, 3, 4])
})

test('a firing killed after its ledger append, with <V> wiped too, never has its generation repeated', T, async t => {
  const p = project(t)
  const f = firing(t, p, 'ledger')
  const a = await f.event('acquired')
  assert.equal(a.generation, 1)
  await f.event('ledger')
  await f.kill()
  fs.rmSync(a.V, { recursive: true, force: true })
  const b = sleeper(t)
  const next = acquireCli(p, b)
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.out.generation, 2)
  assert.equal(next.out.previous, null)
})

test('a firing that runs to its release leaves nothing to reclaim', T, async t => {
  const p = project(t)
  const f = firing(t, p, 'none')
  const a = await f.event('acquired')
  const done = await f.event('released')
  assert.deepEqual(done, { event: 'released', generation: a.generation })
  assert.deepEqual(await f.exited, { code: 0, signal: null })
  const next = acquireCli(p, sleeper(t))
  assert.equal(next.status, 0, next.stderr)
  assert.equal(next.out.generation, 2)
  assert.deepEqual(next.out.previous, { generation: 1, released: true, reclaim: null })
  assert.equal(next.out.reclaimed, null)
})

test('when only the firing dies, its surviving exec wrapper stops its own group and removes its record', T, async t => {
  const p = project(t)
  const f = firing(t, p, 'exec')
  const a = await f.event('acquired')
  const ex = await f.event('exec')
  reap(t, -ex.pgid)
  reap(t, ex.wrapper)
  process.kill(f.pid, 'SIGKILL')
  await f.exited
  assert.ok(await waitFor(() => groupAlive(ex.pgid) === false, 20000), `group ${ex.pgid} survived its holder`)
  assert.ok(await waitFor(() => gone(ex.wrapper), 20000), `wrapper ${ex.wrapper} never ended`)
  assert.deepEqual(childFiles(a.lockDir), [])
  const next = acquireCli(p, sleeper(t))
  assert.equal(next.status, 0, next.stderr)
  assert.deepEqual(next.out.reclaimed, { generation: 1, how: 'dead-holder', stopped: [] })
})

test('a process a killed firing left in the work tree without a record blocks the next acquire until it is gone, and is never signalled', T, async t => {
  const p = project(t)
  const f = firing(t, p, 'stray')
  const a = await f.event('acquired')
  const { pid: stray } = await f.event('stray')
  reap(t, stray)
  await f.kill()
  const b = sleeper(t)
  const r = acquireCli(p, b)
  assert.equal(r.status, 3, JSON.stringify(r.out))
  assert.deepEqual([r.out.state, r.out.reason, r.out.generation], ['held', 'child-live', a.generation])
  assert.ok(r.out.procs.some(x => x.pid === stray), JSON.stringify(r.out.procs))
  assert.equal(gone(stray), false, 'the stray process was signalled')
  process.kill(stray, 'SIGKILL')
  assert.ok(await waitFor(() => gone(stray)), `stray ${stray} never read as gone`)
  const ok = acquireCli(p, b)
  assert.equal(ok.status, 0, JSON.stringify(ok.out))
  assert.deepEqual(ok.out.reclaimed, { generation: a.generation, how: 'dead-holder', stopped: [] })
})
