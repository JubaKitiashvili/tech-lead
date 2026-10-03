// tests/loop/loop-interrupt-clone-live.test.mjs
// The section 19 live-child table: a firing interrupted while something of it still runs, or a
// process found in <W>: an exec verify group alive; an unrecorded process in <W> (held
// child-live); a process in <W> after a normal release (busy); a writer between save and reset
// (unsaved, re-save); a live Codex job (quiesce, or held); the same process with an open
// dispatch. Invariants I1-I8: tests/loop/interrupt-fixture.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ROWS, FAKE_CODEX, T, assertRecovered, gone, go, helperAs, interrupt, ledger, loopMd, project, reap, recordGenerations, run, sections, snapshot,
  start, titles, waitFor, workSnap,
} from './interrupt-fixture.mjs'
import { groupAlive } from '../../scripts/lib/loop-proc.mjs'

const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
const fullSnap = W => snapshot(W, { skip: [], times: true })
// A process whose working directory is W, started by a launcher that exits at once.
const LAUNCH = "const c = require('node:child_process').spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
const dweller = (fx, cwd) => {
  const pid = Number(execFileSync(process.execPath, ['-e', LAUNCH], { encoding: 'utf8', cwd }).trim())
  reap(fx, pid)
  return pid
}

describe('section 19 live children', ROWS, () => {
  test('live: an exec verify group alive when its firing dies is killed by the reclaim; its leftovers are saved', T, async t => {
    const fx = project(t)
    // verify[0] hangs while the delegate's hang.flag is there, after a marker outside <W> says it runs.
    const started = path.join(fx.ctl, 'verify.started')
    const hang = `if [ -f hang.flag ]; then echo run > ${JSON.stringify(started)}; sleep 300 >/dev/null 2>&1; fi`
    fs.writeFileSync(path.join(fx.S, 'LOOP.md'), loopMd({ verify: [hang, 'mkdir -p build && echo built > build/out.txt'] }))
    let snap, pgid
    await interrupt(fx, { stop: 'verifying', attempts: [{ ops: [['write', 'hang.flag', 'x\n'], ...EDIT] }] }, async (f, e) => {
      pgid = e.pgid
      reap(fx, -pgid)
      // The stop comes once the group is on record; the command starts after the exec gate opens.
      assert.ok(await waitFor(() => fs.existsSync(started)), 'verify[0] never started')
      snap = workSnap(fx.W)
    })
    assert.equal(groupAlive(pgid), true, 'the verify group outlives its firing')
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('acquired').reclaimed.stopped.map(s => [s.kind, s.label, s.pgid]), [['proc', 'verify', pgid]])
    assert.equal(groupAlive(pgid), false)
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now', 'note-leftovers'])
    const rec = f2.get('prepared').out.recovered
    assert.equal(fs.existsSync(path.join(fx.W, 'hang.flag')), false)
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('live: an unrecorded process left in <W> holds the next acquire (child-live) and is never signalled', T, async t => {
    const fx = project(t)
    let snap, pid
    await interrupt(fx, { stop: 'dispatched', attempts: [{ ops: [...EDIT, ['dweller']] }] }, (f, e) => {
      pid = e.dwellers[0]
      reap(fx, pid)
      snap = workSnap(fx.W)
    })
    const before = fullSnap(fx.W)
    const f2 = start(fx, work('two'))
    const held = await f2.event('held')
    assert.deepEqual([held.status, held.out.state, held.out.reason, held.out.generation], [3, 'held', 'child-live', 1])
    assert.ok(held.out.procs.some(p => p.pid === pid), JSON.stringify(held.out.procs))
    assert.equal(gone(pid), false, 'the process was signalled')
    assert.deepEqual(fullSnap(fx.W), before, '<W> untouched')
    assert.deepEqual(ledger(fx), [], 'a firing that ends at the lock writes nothing')
    process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(() => gone(pid)))
    // A held acquire takes no generation: the next one is 2.
    const f3 = await run(fx, work('three'))
    assert.deepEqual([f3.get('acquired').generation, f3.get('acquired').reclaimed.generation], [2, 1])
    const rec = f3.get('prepared').out.recovered
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f3), sections: { Done: ['item A'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('live: a process in <W> after a normal release makes prepare refuse busy, touching nothing; the next firing saves the stray work', T, async t => {
    const fx = project(t)
    await run(fx, work('one'))
    fs.writeFileSync(path.join(fx.W, 'stray.txt'), 'stray\n')
    const snap = workSnap(fx.W)
    const pid = dweller(fx, fx.W)
    const before = fullSnap(fx.W)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('acquired').reclaimed, null, 'a released generation is not reclaimed (no sweep)')
    const paused = f2.get('paused')
    assert.equal(paused.why, 'prepare busy')
    assert.deepEqual(fullSnap(fx.W), before, '<W> untouched while busy')
    assert.deepEqual(recordGenerations(fx), [], 'busy refuses before the record is created')
    assert.deepEqual(titles(fx, 'Backlog'), ['item B', 'item C', 'item D'])
    assert.equal(ledger(fx)[1].paused, true)
    process.kill(pid, 'SIGKILL')
    assert.ok(await waitFor(() => gone(pid)))
    const f3 = await run(fx, work('three'))
    const rec = f3.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => r.generation), [null])
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [1, 2, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [1, 2, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('live: a writer between save and reset makes the reset refuse unsaved; the firing saves again and resets', T, async t => {
    const fx = project(t)
    const f1 = start(fx, { path: 'flag', gates: ['saved-state'], attempts: [{ ops: EDIT }] })
    const e = await f1.event('saved-state')
    const s1 = e.sha
    // The writer: another process changes <W> after the save.
    fs.writeFileSync(path.join(fx.W, 'late.txt'), 'late\n')
    fs.appendFileSync(path.join(fx.W, 'a.txt'), 'more\n')
    const snap = workSnap(fx.W)
    go(fx, 'saved-state')
    await f1.event('released', 80000)
    const saves = f1.events.filter(x => x.event === 'saved').map(x => x.out.sha)
    assert.equal(saves.length, 2)
    assert.equal(saves[0], s1)
    const s2 = saves[1]
    assert.notEqual(s2, s1)
    assert.deepEqual(f1.events.filter(x => x.event === 'reset').map(x => x.out.sha), [s2])
    assert.ok(sections(fx)['Needs decision'].some(l => l.startsWith(`**Recovery:** ${s2} `)), 'the STATE edit names the second bundle')
    assert.deepEqual(ledger(fx)[0].saves.map(s => s.sha), [s1, s2])
    const ex = { work: [{ snap, via: 'bundle', sha: s2 }], sections: { 'Needs decision': ['item A'] } }
    assertRecovered(fx, { ...ex, rows: [1] })
    await run(fx, work('two'))
    assertRecovered(fx, { ...ex, rows: [1, 2], sections: { 'Needs decision': ['item A'], Done: ['item B'] } })
  })

  // The fake Codex companion playing a job that launches a worker in <W>.
  function codexEnv(fx) {
    const state = path.join(fx.root, 'codex-state.json')
    const log = path.join(fx.root, 'codex-calls.log')
    fs.writeFileSync(state, JSON.stringify({ jobId: 'job-1', status: 'running', startedAt: new Date().toISOString(), launchWorker: true, active: [] }))
    return { state, log, env: { TECH_LEAD_CODEX_COMPANION: FAKE_CODEX, FAKE_CODEX_STATE: state, FAKE_CODEX_LOG: log } }
  }
  const calls = log => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))

  for (const variant of ['quiesce', 'held']) {
    test(`live: a Codex job alive when its firing dies (${variant}): quiesced by the reclaim, which it holds while it cannot be shown quiet`, T, async t => {
      const fx = project(t)
      const cx = codexEnv(fx)
      let snap
      await interrupt(fx, { stop: 'dispatched', env: cx.env, attempts: [{ ops: [...EDIT, ['codex', 'job-1']] }] }, (f, e) => {
        assert.equal(e.codex[0].state, 'started')
        snap = workSnap(fx.W)
      })
      const worker = calls(cx.log).find(c => c[0] === 'launched')[1]
      reap(fx, worker)
      assert.equal(gone(worker), false, 'the job outlives its firing')
      if (variant === 'held') {
        const st = JSON.parse(fs.readFileSync(cx.state, 'utf8'))
        fs.writeFileSync(cx.state, JSON.stringify({ ...st, listError: 'state.json was half-written' }))
        const f2 = start(fx, { env: cx.env, ...work('two') })
        const held = await f2.event('held')
        assert.deepEqual([held.out.reason, held.out.generation], ['child-live', 1])
        assert.ok(held.out.alive.some(c => c.kind === 'codex'), JSON.stringify(held.out.alive))
        assert.equal(gone(worker), false)
        fs.writeFileSync(cx.state, JSON.stringify(st))
      }
      const f = await run(fx, { env: cx.env, ...work('two') })
      assert.ok(f.get('acquired').reclaimed.stopped.some(s => s.kind === 'codex' && s.jobId === 'job-1'), JSON.stringify(f.get('acquired').reclaimed))
      assert.ok(await waitFor(() => gone(worker)), `worker ${worker} survived the quiesce`)
      const rec = f.get('prepared').out.recovered
      const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
      // A held acquire takes no generation: the recovering firing is 2 either way.
      assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f), sections: { Done: ['item A'] } })
      await run(fx, { env: cx.env, ...work('three') })
      assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
    })
  }

  test('live: the same process re-acquiring with a dispatch of its generation open is held dispatch-open; the firing then finishes', T, async t => {
    const fx = project(t)
    const f1 = start(fx, { gates: ['dispatched'], attempts: [{ ops: EDIT }] })
    await f1.event('dispatched')
    const again = helperAs(fx, f1.pid, 'loop-lock.mjs', ['acquire', fx.P])
    assert.equal(again.status, 3, again.stdout)
    assert.deepEqual([again.out.state, again.out.reason, again.out.generation], ['held', 'dispatch-open', 1])
    const rel = helperAs(fx, f1.pid, 'loop-lock.mjs', ['release', fx.P, '--generation', '1'])
    assert.deepEqual([rel.status, rel.out.state], [3, 'dispatch-open'])
    go(fx, 'dispatched')
    await f1.event('released', 80000)
    assertRecovered(fx, { rows: [1], tip: committedSha(f1), sections: { Done: ['item A'] } })
    await run(fx, work('two'))
    assertRecovered(fx, { rows: [1, 2], sections: { Done: ['item A', 'item B'] } })
  })
})
