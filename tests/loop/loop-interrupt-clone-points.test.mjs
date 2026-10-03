// tests/loop/loop-interrupt-clone-points.test.mjs
// Every section 19 fault point that no matrix row names, driven through the firing (the
// acceptance: interruption at each persistence boundary): prepare:after-preparing,
// prepare:after-record, check:after-rewind, commit:after-record, close:after-delete-one,
// save:after-write, save:after-record, and Save and reset's own reset at reset:after-check,
// reset:after-intent and reset:after-record (rows 12-17 kill the recovering prepare's reset; row
// 22 the own reset mid-way). Each: the interrupted firing, the recovering firing, a third one;
// invariants I1-I8 after the last two (tests/loop/interrupt-fixture.mjs).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  ROWS, T, assertRecovered, go, interrupt, patches, project, recordOf, run, sections, start, tipOf, titles, workSnap,
} from './interrupt-fixture.mjs'

const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const FAILING = { attempts: [{ ops: EDIT, fail: true }, { ops: [], fail: true }] }
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}

describe('section 19 fault points no matrix row names', ROWS, () => {
  test('prepare:after-preparing: the bare record is superseded by the attempt it interrupted', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { stop: 'dispatched', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    await interrupt(fx, { faults: { prepare: 'prepare:after-preparing' }, ...work('lost') })
    assert.deepEqual([recordOf(fx, 2).phase, recordOf(fx, 2).recovery], ['preparing', null])
    const f3 = await run(fx, work('three'))
    const p = f3.get('planned').plan
    assert.deepEqual(p.records.map(r => [r.generation, r.verdict]), [[1, 'leftovers'], [2, 'superseded']])
    const rec = f3.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => r.generation), [1])
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [3], tip: committedSha(f3), sections: { Done: ['item A'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [3, 4], sections: { Done: ['item A', 'item B'] } })
  })

  test('prepare:after-record: a prepared attempt with nothing in it resolves empty', T, async t => {
    const fx = project(t)
    await interrupt(fx, { faults: { prepare: 'prepare:after-record' }, ...work('lost') })
    assert.equal(recordOf(fx, 1).phase, 'prepared')
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now'])
    assert.deepEqual(f2.get('prepared').out.recovered, [])
    assert.deepEqual(patches(fx), [])
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('check:after-rewind: a delegate commit rewound by check, its work saved by the next prepare', T, async t => {
    const fx = project(t)
    let snap, D
    await interrupt(fx, { faults: { check: 'check:after-rewind' }, attempts: [{ ops: [['write', 'd.txt', 'd\n'], ['commit', 'delegate'], ...EDIT] }] }, () => {
      snap = workSnap(fx.W)
      D = recordOf(fx, 1).delegate_commits[0]
    })
    assert.equal(tipOf(fx.W), recordOf(fx, 1).base, 'check rewound the branch before the kill')
    const f2 = await run(fx, work('two'))
    const rec = f2.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => r.generation), [1])
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], delegate: [D] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('commit:after-record: the recorded commit is finished by the planner and bundled', T, async t => {
    const fx = project(t)
    let snap, C
    await interrupt(fx, { faults: { commit: 'commit:after-record' }, attempts: [{ ops: EDIT }] }, () => {
      snap = workSnap(fx.W)
      C = tipOf(fx.W)
    })
    assert.deepEqual(recordOf(fx, 1).commit, { sha: C })
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['finish-commit', 'ledger-recovered', 'write-bundle'])
    assert.ok(sections(fx).Done.some(l => l.includes(' item A ') && l.includes(C)))
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3] })
  })

  test('close:after-delete-one: close killed between deletions; the next firing closes the rest', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { stop: 'checked', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    let C2
    await interrupt(fx, { faults: { close: 'close:after-delete-one' }, ...work('two') }, f => { C2 = committedSha(f) })
    assert.equal(recordOf(fx, 1), null, 'the first record went')
    assert.equal(recordOf(fx, 2).phase, 'committed', 'the second stayed')
    const f3 = await run(fx, work('three'))
    assert.deepEqual(f3.get('planned').plan.actions, [])
    assert.deepEqual(f3.get('closed').out.closed, [2, 3])
    // Generation 2's row names the bundle that saved generation 1's leftovers.
    const ex = { work: [{ snap, via: 'bundle' }] }
    assertRecovered(fx, { ...ex, rows: [2, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    assert.equal(spawnSync('git', ['-C', fx.W, 'rev-parse', `${committedSha(f3)}~1`], { encoding: 'utf8' }).stdout.trim(), C2)
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [2, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('Save and reset\'s save killed at save:after-write: only a temp file; the next prepare saves the work anew', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { faults: { save: 'save:after-write' }, ...FAILING }, () => { snap = workSnap(fx.W) })
    assert.deepEqual(patches(fx), [])
    const f2 = await run(fx, work('two'))
    const rec = f2.get('prepared').out.recovered
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3] })
  })

  test('Save and reset\'s save killed at save:after-record: anchored before the STATE edit; the next prepare reuses it', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { faults: { save: 'save:after-record' }, ...FAILING }, () => { snap = workSnap(fx.W) })
    const sha = recordOf(fx, 1).saves[0].sha
    assert.equal(recordOf(fx, 1).phase, 'saved')
    assert.deepEqual(titles(fx, 'Now'), ['item A'], 'the STATE edit never ran')
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now', 'ledger-recovered', 'note-leftovers'])
    assert.deepEqual(f2.get('prepared').out.recovered.map(r => r.sha), [sha])
    assert.deepEqual(patches(fx), [sha])
    const ex = { work: [{ snap, via: 'bundle', sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Blocked: [] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3] })
  })

  for (const [point, phase, verdict] of [
    ['reset:after-check', 'saved', 'resume'], ['reset:after-intent', 'resetting', 'resume-reset'], ['reset:after-record', 'clean', 'resolved'],
  ]) {
    test(`Save and reset's own reset killed at ${point}`, T, async t => {
      const fx = project(t)
      // The work as saved: read at the save, before the reset begins.
      const f1 = start(fx, { faults: { reset: point }, ...FAILING, gates: ['saved'] })
      await f1.event('saved')
      const snap = workSnap(fx.W)
      go(fx, 'saved')
      await f1.event('faulted')
      await f1.kill()
      const rec1 = recordOf(fx, 1)
      const sha = rec1.saves[0].sha
      assert.equal(rec1.phase, phase)
      assert.deepEqual(titles(fx, 'Blocked'), ['item A'])
      assert.ok(sections(fx).Blocked.includes(`  - recovery: ${sha}`))
      const f2 = await run(fx, work('two'))
      const p = f2.get('planned').plan
      assert.deepEqual(p.records.map(r => [r.generation, r.verdict]), [[1, verdict]])
      assert.deepEqual(p.recovered.bundles, [sha])
      assert.deepEqual(f2.get('prepared').out.recovered.map(r => r.sha), point === 'reset:after-record' ? [] : [sha])
      assert.deepEqual(patches(fx), [sha])
      const ex = { work: [{ snap, via: 'bundle', sha }], sections: { Blocked: ['item A'], Done: ['item B'] } }
      assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2) })
      await run(fx, work('three'))
      assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Blocked: ['item A'], Done: ['item B', 'item C'] } })
    })
  }
})
