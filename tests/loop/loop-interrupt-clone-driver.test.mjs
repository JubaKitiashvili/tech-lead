// tests/loop/loop-interrupt-clone-driver.test.mjs
// The firing driver plays the prose as it is written (review round: Cg4#3-#6, #9 and
// prose-checks#7), and the shared fixture's cleanup never signals a process or a process group
// that only reused an id (Cg4#2, contracts-tests#7). Each firing case ends with the invariants
// I1-I8 (tests/loop/interrupt-fixture.mjs) where the loop goes on.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  BASE_FILES, DOT, ROWS, T, assertRecovered, git, go, gone, groupIsOurs, helperAs, idOf, interrupt, itemBlock, itemHead, killGroupIfOurs, ledger,
  loopMd, patches, project, reap, run, sections, start, stateText, titles, tmp, waitFor, workSnap,
} from './interrupt-fixture.mjs'
import { groupAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

const DASH = String.fromCharCode(0x2014)
const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
// The ## Blocked block of item A after two failed attempts: the whole block kept (R14), its
// recovery: field added.
const blockedA = sha => [`- [ ] item A ${DOT} attempts: 2 ${DOT} attempt failed twice`, ...itemHead('item A').slice(1), `  - recovery: ${sha}`]
const loopText = fx => fs.readFileSync(path.join(fx.S, 'LOOP.md'), 'utf8')
const PAUSED = /^paused: true$/m
// A firing while LOOP.md says paused: true recovers, then halts at the gate (loop section 2):
// outcome halted, note "paused", nothing picked, prepared or dispatched, <W> untouched.
async function assertGated(fx, o) {
  const snap = workSnap(fx.W)
  const before = ledger(fx).length
  const f = await run(fx, o)
  assert.ok(f.get('gated'), f.describe())
  for (const name of ['picked', 'prepared', 'dispatched', 'dispatched-commit']) assert.equal(f.get(name), undefined, `${name} while paused: ${f.describe()}`)
  const row = ledger(fx)[before]
  assert.equal(row.outcome, 'halted')
  assert.ok(row.notes.split('; ').includes('paused'), row.notes)
  assert.deepEqual(workSnap(fx.W), snap, '<W> untouched while paused')
  assert.match(loopText(fx), PAUSED, 'still paused')
  return f
}
const ledgerText = fx => {
  try { return fs.readFileSync(path.join(fx.S, 'LEDGER.jsonl'), 'utf8') } catch { return '' }
}
// A process group this file makes (`child`, spawned detached, leads it), killed when the test
// ends only while interrupt-fixture's groupIsOurs proves the id still names it (prose#1). The
// leader's start token is read here, while the leader is surely this process's unreaped
// child. A zombie at the pid is ours only until Node has reaped the child (its 'exit'), never
// after, since that zombie is another process's. disarm() once the test has seen the group
// gone, so no later kill is aimed at its id at all.
const ownGroup = (t, child) => {
  const start = startToken(child.pid).token ?? null
  let reaped = false
  let disarmed = false
  child.on('exit', () => { reaped = true })
  t.after(() => { if (!disarmed) killGroupIfOurs(child.pid, start, { zombieOurs: !reaped }) })
  return { disarm: () => { disarmed = true } }
}

describe('the firing driver follows the prose', ROWS, () => {
  // A verify command that starts a process outside its own process group, working in <W>, and
  // writes its pid to the file argv[2] names (outside <W>), so the test can always reap it.
  const LINGER = "const c = require('node:child_process').spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' }); c.unref(); "
    + "require('node:fs').appendFileSync(process.argv[2], c.pid + '\\n')\n"

  test('Cg4#3, Codex g4 #2: a verify run that leaves a process in the clone is an infra pause: never retried, <W> untouched, the item back as waiting-infra, LOOP.md paused until the owner unpauses', T, async t => {
    const fx = project(t, { files: { ...BASE_FILES, 'linger.js': LINGER } })
    const pidFile = path.join(fx.ctl, 'linger.pids')
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd({ verify: [`${process.execPath} linger.js ${pidFile}`] }))
    const f1 = start(fx, { attempts: [{ ops: EDIT }, { ops: [] }] })
    await f1.ended()
    // Every process a verify run left, reaped before anything is asserted.
    const left = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
    for (const pid of left) reap(fx, pid)
    assert.deepEqual((await f1.ended()).exit, { code: 0, signal: null }, f1.describe())
    const paused = f1.get('paused')
    assert.ok(paused, f1.describe())
    assert.equal(paused.why, 'exec lingering')
    assert.equal(paused.detail.state, 'lingering')
    const alive = (paused.detail.alive ?? []).map(p => p.pid)
    assert.deepEqual(alive, left, JSON.stringify(paused.detail))
    assert.equal(f1.events.filter(e => e.event === 'dispatched').length, 1, 'never retried')
    assert.equal(f1.events.some(e => e.event === 'saved'), false, 'no save, no reset: touch nothing')
    const snap = workSnap(fx.W)
    assert.ok(snap.some(([p]) => p === 'new.txt'), 'the attempt stays in <W>')
    assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].paused], ['skipped', true])
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), [...itemHead('item A'), '  - status: waiting-infra'])
    assert.match(loopText(fx), PAUSED, 'the pause is LOOP.md\'s flag')
    // The owner ends the processes and fixes verify, but has not unpaused yet: no dispatch.
    for (const pid of alive) process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(() => alive.every(gone)))
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd().replace('---\n', '---\npaused: true\n'))
    await assertGated(fx, work('gated'))
    // The owner unpauses: the next firing dispatches again.
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd().replace('---\n', '---\npaused: false\n'))
    const f2 = await run(fx, work('two'))
    assert.ok(f2.get('dispatched'), f2.describe())
    const rec = f2.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => r.generation), [1])
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [1, 2, 3], tip: committedSha(f2), sections: { Done: ['item B'], Backlog: ['item A', 'item C', 'item D'] } })
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), [...itemHead('item A'), '  - status: waiting-infra'], 'a waiting-infra item is never picked')
  })

  // The verify events in order: [event, K, restarted] for a verify run, [event, attempt] else.
  const verifyTrail = f => f.events.filter(e => ['dispatched', 'checked', 'verify-run', 'verify-checked'].includes(e.event))
    .map(e => e.event === 'verify-run' ? [e.event, e.K, e.restarted] : e.event === 'verify-checked' ? [e.event, e.restarted] : [e.event])

  test('Cg4#3, Cg4#9, Codex g4 #3: a verify command that edits and fails is followed by check --after verify and a restart from command zero (R22); the second change fails the attempt, the second failure Blocks with outcome failed', T, async t => {
    const fx = project(t, { verify: ['echo more >> a.txt; exit 1', 'true'] })
    const f1 = await run(fx, { attempts: [{ ops: EDIT }, { ops: [] }] })
    const once = [['verify-run', 0, false], ['verify-checked', false], ['verify-run', 0, true], ['verify-checked', true]]
    assert.deepEqual(verifyTrail(f1), [['dispatched'], ['checked'], ...once, ['dispatched'], ['checked'], ...once])
    const vc = f1.events.filter(e => e.event === 'verify-checked')
    assert.ok(vc.every(e => e.verifyFailed), JSON.stringify(vc))
    assert.ok(vc[0].check.touched.includes('a.txt'), 'the failed command\'s edit is checked')
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.verify], ['failed', 'fail'])
    assert.equal(row.notes.split('; ').filter(n => n === 'verify changed the work twice').length, 2, row.notes)
    const sha = row.saves[0].sha
    assert.deepEqual(itemBlock(fx, 'Blocked', 'item A'), blockedA(sha))
    assert.match(fs.readFileSync(path.join(fx.V, 'patches', `${sha}.patch`), 'utf8'), /\+edited\n(\+more\n){4}(?!\+more)/)
    assert.doesNotMatch(loopText(fx), PAUSED, 'an attempt failure is no pause')
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd())
    const f2 = await run(fx, work('two'))
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Blocked: ['item A'], Done: ['item B'] } })
  })

  test('Codex g4 #3: a formatter that rewrites a file and exits 1 once is cured by the restart from command zero: one dispatch, then the commit (R22)', T, async t => {
    const fx = project(t)
    const mark = path.join(fx.ctl, 'formatted')
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd({ verify: [`[ -e '${mark}' ] || { touch '${mark}'; echo formatted >> a.txt; exit 1; }`, 'true'] }))
    const f1 = await run(fx, { attempts: [{ ops: EDIT }, { ops: [] }] })
    assert.deepEqual(verifyTrail(f1), [['dispatched'], ['checked'],
      ['verify-run', 0, false], ['verify-checked', false], ['verify-run', 0, true], ['verify-run', 1, true], ['verify-checked', true]])
    const sha = committedSha(f1)
    assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].verify], ['done', 'pass'])
    assert.equal(git(fx.W, ['show', `${sha}:a.txt`]), 'edited\nformatted')
  })

  // The owner's release, run as the live driver (the holder), while it waits at `gate`.
  for (const [gate, install, what] of [
    ['prepared', null, 'deps'],
    ['deps', 'mkdir -p node_modules/x && echo m > node_modules/x/i.js', 'check --after deps'],
    ['deps-checked', 'mkdir -p node_modules/x && echo m > node_modules/x/i.js', 'deps --mark'],
  ]) {
    test(`Cg4#4: a lock lost before ${what} stops the firing: no STATE.md edit, no ledger row`, T, async t => {
      const fx = project(t)
      const f1 = start(fx, { gates: [gate], deps: install ? { install } : null, ...work('one') })
      await f1.event(gate)
      const state = stateText(fx)
      const rows = ledgerText(fx)
      const rel = helperAs(fx, f1.pid, 'loop-lock.mjs', ['release', fx.P, '--generation', '1'])
      assert.equal(rel.status, 0, rel.stdout + rel.stderr)
      go(fx, gate)
      const { exit } = await f1.ended()
      assert.deepEqual(exit, { code: 0, signal: null }, f1.describe())
      const e = f1.get('lost-lock')
      assert.ok(e, f1.describe())
      assert.equal(e.what, what)
      assert.equal(e.out.state, 'not-holder')
      assert.equal(f1.get('paused'), undefined, f1.describe())
      assert.equal(stateText(fx), state, 'STATE.md untouched')
      assert.equal(ledgerText(fx), rows, 'no ledger row')
    })
  }

  test('Cg4#5: a delegate-flagged item goes back to ## Backlog as waiting-decision with its fields; later firings pass it over', T, async t => {
    const sub = [`  - blocked-by: ${DASH}`, `  - status: ${DASH}`, '  - notes: keep this note']
    const fx = project(t, { items: [{ title: 'item A', sub }, 'item B', 'item C'] })
    const f1 = await run(fx, { path: 'flag', attempts: [{ ops: EDIT }] })
    const sha = f1.get('saved').out.sha
    assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].verify], ['flagged', null])
    assert.ok(sections(fx)['Needs decision'].some(l => l.startsWith(`**Recovery:** ${sha} `)))
    const want = [...itemHead('item A'), `  - blocked-by: ${DASH}`, '  - status: waiting-decision', '  - notes: keep this note']
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), want)
    assert.deepEqual(titles(fx, 'Backlog'), ['item A', 'item B', 'item C'])
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('picked').item, itemHead('item B'))
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { 'Needs decision': ['item A'], Done: ['item B'], Backlog: ['item A', 'item C'] } })
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), want)
  })

  test('Cg4#6: an empty save on a flagged item writes the Recovery line with none and the base, scope and item digest the empty answer carries', T, async t => {
    const fx = project(t)
    const f1 = await run(fx, { path: 'flag', attempts: [{ ops: [] }] })
    const e = f1.events.find(x => x.event === 'saved-state')
    assert.ok(e && e.empty, f1.describe())
    assert.equal(e.empty.state, 'empty')
    assert.match(e.empty.scope.digest, /^[0-9a-f]{64}$/)
    const line = sections(fx)['Needs decision'].find(l => l.startsWith('**Recovery:** '))
    // R18: the Recovery line writes the item digest instead of none.
    assert.match(e.empty.item_digest, /^[0-9a-f]{64}$/)
    assert.equal(e.empty.item_id, idOf('item A'))
    assert.equal(line, `**Recovery:** none ${DOT} base ${e.empty.base} ${DOT} item-digest ${e.empty.item_digest} ${DOT} scope ${e.empty.scope.digest}`)
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), [...itemHead('item A'), '  - status: waiting-decision'])
    assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].saves], ['flagged', null])
    assert.deepEqual(patches(fx), [])
    assert.equal(f1.events.some(x => x.event === 'reset'), false, 'an empty save skips the reset')
    // A save that holds work, under the same LOOP.md, reports the same scope digest.
    const f2 = await run(fx, { path: 'flag', attempts: [{ ops: EDIT }] })
    assert.equal(f2.get('saved').out.scope.digest, e.empty.scope.digest)
    assertRecovered(fx, { rows: [1, 2], sections: { 'Needs decision': ['item A', 'item B'] }, work: [] })
  })

  test('prose-checks#7: a planner exit 2 puts the ## Now item back at the top of ## Backlog and names it; nothing is lost', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'prepared', ...work('lost') })
    assert.deepEqual(titles(fx, 'Now'), ['item A'])
    fs.writeFileSync(path.join(fx.V, 'run', '1.json'), '{"v":1,')
    const f2 = await run(fx, work('two'))
    assert.match(f2.get('halted').out.detail, /^corrupt: /)
    assert.deepEqual(titles(fx, 'Now'), [])
    assert.deepEqual(titles(fx, 'Backlog'), ['item A', 'item B', 'item C', 'item D'])
    assert.match(ledger(fx)[0].notes, /item A back to the top of ## Backlog/)
    assert.match(loopText(fx), PAUSED, 'the planner incident pauses the loop')
    // The owner's fix (README "recovery planner"): the record set aside, then the unpause.
    fs.mkdirSync(path.join(fx.V, 'run.broken-1'))
    fs.renameSync(path.join(fx.V, 'run', '1.json'), path.join(fx.V, 'run.broken-1', '1.json'))
    await assertGated(fx, work('gated'))
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopText(fx).replace(PAUSED, 'paused: false'))
    const f3 = await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3, 4], tip: committedSha(f3), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
  })

  // A git on PATH (for the helpers only: the scenario's env) that fails `commit-tree`, the
  // commit's first git write, `times` times (a counter file outside <W>); every other call runs
  // the real git. commit then refuses commit-failed before it records an intent.
  const commitTreeFails = (fx, times) => {
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: fx.env }).stdout.trim()
    const bin = path.join(fx.root, 'fake-git')
    const count = path.join(fx.root, 'commit-tree.count')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  if [ "$a" = commit-tree ]; then',
      `    n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `    if [ "$n" -lt ${times} ]; then echo $((n + 1)) > '${count}'; echo "fatal: injected commit-tree failure" >&2; exit 128; fi`,
      '  fi',
      'done',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
    return { env: { PATH: `${bin}:${fx.env.PATH}` }, count: () => Number(fs.readFileSync(count, 'utf8')) }
  }

  test('Codex f2 #1: a commit refused commit-failed is an attempt failure (loop section 7): the retry in the same firing commits, with no pause', T, async t => {
    const fx = project(t)
    const fake = commitTreeFails(fx, 1)
    const f1 = await run(fx, { attempts: [{ ops: EDIT }, { ops: [] }], env: fake.env })
    assert.equal(fake.count(), 1, 'the first commit was refused')
    assert.equal(f1.get('paused'), undefined, f1.describe())
    assert.equal(f1.events.filter(e => e.event === 'dispatched').length, 2, `the attempt was retried: ${f1.describe()}`)
    const sha = committedSha(f1)
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.verify, row.paused], ['done', 'pass', undefined])
    assert.match(row.notes, /commit commit-failed: git commit-tree: fatal: injected commit-tree failure/)
    assert.doesNotMatch(loopText(fx), PAUSED, 'an attempt failure is no pause')
    assert.equal(git(fx.W, ['show', `${sha}:a.txt`]), 'edited')
    assertRecovered(fx, { rows: [1], tip: sha, sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
  })

  test('Codex f2 #1: a commit refused commit-failed twice runs Save and reset (attempt-failed) and Blocks the item: outcome failed, no pause', T, async t => {
    const fx = project(t)
    const fake = commitTreeFails(fx, 2)
    const f1 = await run(fx, { attempts: [{ ops: EDIT }, { ops: [] }], env: fake.env })
    assert.equal(fake.count(), 2)
    assert.equal(f1.get('paused'), undefined, f1.describe())
    assert.equal(f1.get('committed'), undefined, f1.describe())
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.verify, row.paused], ['failed', 'fail', undefined])
    const sha = row.saves[0].sha
    assert.equal(row.saves[0].why, 'attempt-failed')
    assert.deepEqual(itemBlock(fx, 'Blocked', 'item A'), blockedA(sha))
    assert.doesNotMatch(loopText(fx), PAUSED, 'an attempt failure is no pause')
  })

  test('Codex f2 #2: an exit 2 from dispatch close is a lock error: the pause, with no check, verify or commit after it', T, async t => {
    const fx = project(t)
    const f1 = start(fx, { gates: ['dispatched'], attempts: [{ ops: EDIT }, { ops: [] }] })
    await f1.event('dispatched')
    // The dispatch record gone before its close: dispatch close answers exit 2 no-dispatch.
    const children = path.join(f1.get('acquired').lockDir, 'children')
    const recs = fs.readdirSync(children).filter(n => n.includes('-dispatch-'))
    assert.equal(recs.length, 1, JSON.stringify(recs))
    fs.rmSync(path.join(children, recs[0]))
    const snap = workSnap(fx.W)
    go(fx, 'dispatched')
    const { exit } = await f1.ended()
    assert.deepEqual(exit, { code: 0, signal: null }, f1.describe())
    const paused = f1.get('paused')
    assert.ok(paused, f1.describe())
    assert.equal(paused.why, 'lock error')
    assert.match(paused.detail, /^no-dispatch: /)
    for (const name of ['checked', 'verify-run', 'verify-checked', 'verified', 'saved', 'committed', 'done']) assert.equal(f1.get(name), undefined, `${name} after a lock error: ${f1.describe()}`)
    assert.equal(f1.events.filter(e => e.event === 'dispatched').length, 1, 'nothing more dispatched')
    assert.deepEqual(workSnap(fx.W), snap, '<W> untouched')
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.paused, row.verify, row.commits], ['skipped', true, null, []])
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), itemHead('item A'), 'the item back with its status unchanged')
    assert.match(loopText(fx), PAUSED)
  })
})

describe('the fixture cleanup never signals an id another process took', () => {
  test('reap leaves a process group alone whose leader is not the process it recorded (Cg4#2)', T, async t => {
    const s = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    const own = ownGroup(t, s)
    const exited = new Promise(resolve => s.on('exit', resolve))
    // The group was registered for an earlier leader (another start token): its id was reused.
    await t.test('registered under another start token', t2 => { reap({ t: t2 }, -s.pid, 'live:an-earlier-leader') })
    assert.equal(groupAlive(s.pid), true, 'the reused group was killed')
    assert.equal(startToken(s.pid).state, 'live')
    // Registered under its own token, it is killed.
    await t.test('registered under its own start token', t2 => { reap({ t: t2 }, -s.pid) })
    await exited
    assert.ok(await waitFor(() => groupAlive(s.pid) === false))
    own.disarm()
  })

  test('killGroupIfOurs: a live leader of another token is left alone; a reaped leader\'s group lives on and is killed (Cg4#2)', T, async t => {
    const s = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    const ownS = ownGroup(t, s)
    const token = startToken(s.pid).token
    assert.equal(groupIsOurs(s.pid, 'live:another', { zombieOurs: false }), false)
    assert.equal(killGroupIfOurs(s.pid, 'live:another', { zombieOurs: false }), false)
    assert.equal(startToken(s.pid).state, 'live')
    // A leader that exited and was reaped by this process, its group still holding a sleeper:
    // the pid stays free while the group exists, so the group is ours to kill.
    const sh = spawn('/bin/sh', ['-c', 'sleep 120 >/dev/null 2>&1 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    sh.stdout.on('data', d => { out += d })
    const ownSh = ownGroup(t, sh)
    await new Promise(resolve => sh.on('exit', resolve))
    const bg = Number(out.trim())
    assert.ok(bg > 0 && startToken(bg).state === 'live', out)
    assert.equal(groupAlive(sh.pid), true)
    assert.equal(killGroupIfOurs(sh.pid, 'live:whatever-it-was', { zombieOurs: false }), true)
    assert.ok(await waitFor(() => gone(bg)), `the group's sleeper ${bg} survived`)
    assert.ok(await waitFor(() => groupAlive(sh.pid) === false), `group ${sh.pid} outlived its sleeper`)
    ownSh.disarm()
    // The live leader of its own recorded token is ours.
    assert.equal(killGroupIfOurs(s.pid, token), true)
    assert.ok(await waitFor(() => groupAlive(s.pid) === false))
    ownS.disarm()
  })
})

// prose#1: the cleanup of the groups the tests above make (ownGroup) signals only a group the
// test can prove its own. A fake ps that reads every live process as one started in 1970
// stands in for a group id whose leader is another process by the time the hook runs.
describe('this file\'s own group cleanup never signals an id another process took', () => {
  const darwinOnly = { ...T, skip: process.platform !== 'darwin' && 'the start token reads ps on darwin only' }
  const impostorPs = t => {
    const file = path.join(tmp(t, 'tl-drv-ps-'), 'ps')
    fs.writeFileSync(file, '#!/bin/sh\necho "S Thu Jan 1 00:00:00 1970"\n', { mode: 0o755 })
    const before = process.env.TECH_LEAD_PS
    process.env.TECH_LEAD_PS = file
    t.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
  }
  // A detached sleeper leading its own group: {child, start (its token now), exited}.
  const leader = () => {
    const child = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    return { child, start: startToken(child.pid).token, exited: new Promise(resolve => child.on('exit', resolve)) }
  }

  test('a group cleanup kills its own group, and leaves alone a group id whose leader reads as another process by then', darwinOnly, async t => {
    let a
    await t.test('the leader reads as another process when the test ends', st => {
      a = leader()
      ownGroup(st, a.child)
      impostorPs(st)
    })
    t.after(() => { killGroupIfOurs(a.child.pid, a.start, { zombieOurs: false }) })
    // A killed leader reads as gone at once (a zombie until Node reaps it), so the token tells.
    assert.equal(startToken(a.child.pid).token, a.start, `the cleanup killed group ${a.child.pid}, which it could not prove its own`)
    assert.equal(groupAlive(a.child.pid), true)
    process.kill(-a.child.pid, 'SIGKILL')
    await a.exited
    assert.ok(await waitFor(() => groupAlive(a.child.pid) === false))
    let b
    await t.test('the leader is still the one recorded when the test ends', st => {
      b = leader()
      ownGroup(st, b.child)
    })
    t.after(() => { killGroupIfOurs(b.child.pid, b.start, { zombieOurs: false }) })
    assert.ok(await waitFor(() => groupAlive(b.child.pid) === false), `the cleanup left its own group ${b.child.pid} running`)
    await b.exited
  })

  test('a disarmed group cleanup signals nothing', T, async t => {
    let a
    await t.test('the cleanup is disarmed before the test ends', st => {
      a = leader()
      ownGroup(st, a.child).disarm()
    })
    t.after(() => { killGroupIfOurs(a.child.pid, a.start, { zombieOurs: false }) })
    assert.equal(startToken(a.child.pid).token, a.start, `a disarmed cleanup killed group ${a.child.pid}`)
    assert.equal(groupAlive(a.child.pid), true)
    process.kill(-a.child.pid, 'SIGKILL')
    await a.exited
    assert.ok(await waitFor(() => groupAlive(a.child.pid) === false))
  })
})
