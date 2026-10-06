// tests/loop/loop-interrupt-clone-state.test.mjs
// The section 19 interruption matrix, rows killed at a prose boundary around the STATE.md,
// ledger and close steps (a driver stop; the firing's process group SIGKILLed while it waits
// there): 20, 21, 23, 28-30, 34 (and 34's recovering prepare killed inside, recovery#1). Each
// row: the interrupted firing, the recovering firing (stop none), then a third firing for
// idempotence, with invariants I1-I8 checked after the last two (tests/loop/interrupt-fixture.mjs).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ROWS, T, assertRecovered, git, headerOf, interrupt, itemBlock, itemHead, ledger, patches, project, recordOf, run, sections, titles, workSnap,
  write,
} from './interrupt-fixture.mjs'

const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}

// Two failed attempts lead to Save and reset (attempt-failed).
const FAILING = { attempts: [{ ops: EDIT, fail: true }, { ops: [], fail: true }] }

describe('section 19 matrix: STATE.md, ledger and close boundaries', ROWS, () => {
  test('row 20: saved, STATE not written: the next prepare resets with the recorded bundle, which is reused (I7)', T, async t => {
    const fx = project(t)
    let snap, sha
    await interrupt(fx, { stop: 'saved', ...FAILING }, (f, e) => {
      snap = workSnap(fx.W)
      sha = e.out.sha
    })
    assert.equal(recordOf(fx, 1).phase, 'saved')
    assert.deepEqual(titles(fx, 'Now'), ['item A'])
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['requeue-now', 'ledger-recovered', 'note-leftovers'])
    assert.deepEqual(p.recovered.bundles, [sha])
    assert.deepEqual(f2.get('prepared').out.recovered.map(r => r.sha), [sha])
    assert.deepEqual(patches(fx), [sha], 'no second bundle')
    const ex = { work: [{ snap, via: 'bundle', sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Blocked: [] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
    assert.deepEqual(patches(fx), [sha])
  })

  test('row 21: STATE written, no reset: the flagged item stays in Needs decision and in Backlog as waiting-decision, the recorded bundle is reused for the reset', T, async t => {
    const fx = project(t)
    let snap, sha
    await interrupt(fx, { stop: 'saved-state', path: 'flag', attempts: [{ ops: EDIT }] }, (f, e) => {
      snap = workSnap(fx.W)
      sha = e.sha
    })
    // Loop section 6.1: the entry, and the item back in ## Backlog with status waiting-decision.
    const flagged = [...itemHead('item A'), '  - status: waiting-decision']
    assert.deepEqual(titles(fx, 'Needs decision'), ['item A'])
    assert.ok(sections(fx)['Needs decision'].some(l => l.startsWith(`**Recovery:** ${sha} `)))
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), flagged)
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['ledger-recovered', 'note-leftovers'])
    assert.deepEqual(f2.get('prepared').out.recovered.map(r => r.sha), [sha])
    assert.deepEqual(patches(fx), [sha])
    const ex = { work: [{ snap, via: 'bundle', sha }], sections: { 'Needs decision': ['item A'], Done: ['item B'], Backlog: ['item A', 'item C', 'item D'] } }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2) })
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), flagged)
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { 'Needs decision': ['item A'], Done: ['item B', 'item C'], Backlog: ['item A', 'item D'] } })
    assert.deepEqual(itemBlock(fx, 'Backlog', 'item A'), flagged)
  })

  test('row 23: checked but not committed: the checked work is saved and the item reruns', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { stop: 'checked', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now', 'note-leftovers'])
    const rec = f2.get('prepared').out.recovered
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 28: Done written, no ledger row: the commit reaches the ledger through ledger-recovered, the item is not moved again', T, async t => {
    const fx = project(t)
    let snap, C
    await interrupt(fx, { stop: 'done', attempts: [{ ops: EDIT }] }, (f, e) => {
      snap = workSnap(fx.W)
      C = e.sha
    })
    assert.deepEqual(titles(fx, 'Done'), ['item A'])
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['ledger-recovered'])
    assert.deepEqual(p.recovered.commits, [C])
    assert.equal(p.finish, null)
    assert.deepEqual(ledger(fx).map(r => r.recovered?.commits ?? null), [[C]])
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('row 29: killed after the ledger append: nothing to recover, the record is closed by the next firing', T, async t => {
    const fx = project(t)
    let C
    await interrupt(fx, { stop: 'ledger', attempts: [{ ops: EDIT }] }, (f, e) => { C = e.row.commits[0] })
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, [])
    assert.deepEqual(f2.get('prepared').out.recovered, [])
    assert.deepEqual(f2.get('closed').out.closed, [1, 2])
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f2)}~1`]), C)
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [1, 2, 3], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('row 30: killed after close, before release: the next firing reclaims and has nothing to do', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'closed', attempts: [{ ops: EDIT }] })
    // No run record is left, only the refs anchor close writes before it deletes them.
    assert.deepEqual(fs.readdirSync(path.join(fx.V, 'run')).filter(n => n.endsWith('.json')), ['refs.json'])
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('acquired').reclaimed.how, 'dead-holder')
    assert.deepEqual(f2.get('planned').plan.actions, [])
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [1, 2, 3], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  // R25: the close of firing 1 anchored its recorded ignore rules, so the leftovers are listed
  // under them (mode recorded), not under the base rules.
  test('row 34: a dirty clone with no record (a stray writer after a normal release) is saved under the anchored rules and reset', T, async t => {
    const fx = project(t)
    await run(fx, work('one'))
    write(fx.W, 'stray.txt', 'stray\n')
    write(fx.W, 'a.txt', 'changed\n')
    write(fx.W, 'x/.gitignore', '*\n')
    write(fx.W, 'x/f.txt', 'f\n')
    const snap = workSnap(fx.W)
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.records, [])
    assert.deepEqual(p.actions, ['note-leftovers'])
    const rec = f2.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => [r.generation, r.files]), [[null, 4]])
    assert.equal(headerOf(fx, rec[0].sha).rules.mode, 'recorded')
    assert.equal(fs.existsSync(path.join(fx.W, 'x')), false)
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [1, 2, 3] })
  })

  // recovery#1 (R28): the same, with the recovering prepare killed after its own save of the
  // no-record leftovers, or after the refresh. Its record holds no refs snapshot (head_ref
  // null), so the next prepare is ready, never tampered, and reuses the anchored bundle.
  for (const point of ['recover:after-save', 'refresh:after-fetch']) {
    test(`row 34: the no-record save's prepare killed at ${point}: the next prepare is ready and reuses the anchored bundle`, T, async t => {
      const fx = project(t)
      await run(fx, work('one'))
      write(fx.W, 'stray.txt', 'stray\n')
      write(fx.W, 'a.txt', 'changed\n')
      const snap = workSnap(fx.W)
      await interrupt(fx, { faults: { prepare: point }, ...work('lost') })
      const rec2 = recordOf(fx, 2)
      assert.equal(rec2.head_ref, null)
      assert.equal(rec2.saves.length, 1)
      const sha = rec2.saves[0].sha
      const f3 = await run(fx, work('three'))
      assert.equal(f3.get('paused'), undefined, f3.describe())
      const rec = f3.get('prepared').out.recovered
      assert.ok(rec.every(r => r.sha === sha), `the anchored bundle is reused: ${JSON.stringify(rec)}`)
      assert.deepEqual(patches(fx), [sha])
      const ex = { work: [{ snap, via: 'bundle', sha }] }
      assertRecovered(fx, { ...ex, rows: [1, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
      await run(fx, work('four'))
      assertRecovered(fx, { ...ex, rows: [1, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
    })
  }
})
