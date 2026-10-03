// tests/loop/loop-interrupt-clone-recover.test.mjs
// The section 19 interruption matrix, rows 12-17: the firing interrupted mid-dispatch (with a
// delegate commit for the rewind points), then its recovering prepare killed at each recover:*
// and reset:* point by TECH_LEAD_FAULT=<point> on that one call; the next firing finishes the
// recovery with the bundle the record holds (I7: one bundle, reused), then a fourth firing finds
// nothing to do. Invariants I1-I8: tests/loop/interrupt-fixture.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ROWS, T, assertRecovered, interrupt, patches, project, run, tipOf, workSnap,
} from './interrupt-fixture.mjs'

const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited '.repeat(40) + '\n'], ['write', 'new1.txt', 'one\n'], ['write', 'n/new2.txt', 'two\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}

const POINTS = [
  ['row 12', 'recover:after-rewind-intent', true],
  ['row 13', 'recover:after-rewind', true],
  ['row 14', 'recover:after-save', false],
  ['row 15', 'recover:after-reset', false],
  ['row 16', 'reset:after-check', false],
  ['row 16', 'reset:after-intent', false],
  ['row 17', 'reset:after-unlink-one', false],
  ['row 17', 'reset:after-read-tree', false],
  ['row 17', 'reset:after-record', false],
]

describe('section 19 matrix: the recovering prepare killed (rows 12-17)', ROWS, () => {
  for (const [row, point, rewind] of POINTS) {
    test(`${row}: the recovering prepare killed at ${point}; the next firing finishes with the recorded bundle`, T, async t => {
      const fx = project(t)
      let snap, D = null
      const ops = rewind ? [...EDIT.slice(0, 2), ['commit', 'delegate commit'], ...EDIT.slice(2)] : EDIT
      await interrupt(fx, { stop: rewind ? 'dispatched-commit' : 'dispatched', attempts: [{ ops }] }, () => {
        snap = workSnap(fx.W)
        if (rewind) D = tipOf(fx.W)
      })
      await interrupt(fx, { faults: { prepare: point }, ...work('lost') }, () => {
        if (point === 'reset:after-unlink-one') fs.writeFileSync(path.join(fx.W, 'a.txt'), 'edi') // a write cut short
      })
      const before = patches(fx)
      const f3 = await run(fx, work('three'))
      const rec = f3.get('prepared').out.recovered
      const all = patches(fx)
      assert.equal(all.length, 1, `${point}: one bundle in all (${all})`)
      if (before.length) assert.deepEqual(all, before, `${point}: the recorded bundle is reused`)
      if (point === 'recover:after-reset' || point === 'reset:after-record') assert.deepEqual(rec, [], 'the reset had finished')
      else assert.deepEqual(rec.map(r => r.sha), all)
      if (rewind) assert.deepEqual(rec.map(r => r.rewound_from), [D])
      const ex = { work: [{ snap, via: 'bundle', sha: all[0] }], delegate: D ? [D] : [] }
      assertRecovered(fx, { ...ex, rows: [3], tip: committedSha(f3), sections: { Done: ['item A'] } })
      await run(fx, work('four'))
      assertRecovered(fx, { ...ex, rows: [3, 4], sections: { Done: ['item A', 'item B'] } })
      assert.deepEqual(patches(fx), all)
    })
  }
})
