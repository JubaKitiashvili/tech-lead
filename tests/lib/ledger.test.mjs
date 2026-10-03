// tests/lib/ledger.test.mjs
// Ledger reading (stage 0c-2 brief section 1): ledgerFloor moved here from loop-lock.mjs,
// which re-exports it, and ledgerShas, the set of every sha the ledger names.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ledgerFloor, ledgerShas } from '../../scripts/lib/ledger.mjs'
import * as lock from '../../scripts/loop-lock.mjs'

const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ledger-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const writeLedger = (S, lines) => fs.writeFileSync(path.join(S, 'LEDGER.jsonl'), lines.join('\n') + '\n')
const sorted = set => [...set].sort()
const hex = (c, n) => c.repeat(n)

test('loop-lock re-exports ledgerFloor unchanged', () => {
  assert.equal(lock.ledgerFloor, ledgerFloor)
})

test('ledgerFloor is the largest numeric iteration; a missing ledger is 0 and bad lines are skipped', t => {
  const S = tmp(t)
  assert.equal(ledgerFloor(S), 0)
  assert.equal(ledgerFloor(path.join(S, 'missing')), 0)
  writeLedger(S, [
    '{"iteration":7,"ts":"x"}', 'not json', '{"iteration":"99"}', '{"iteration":41}', '', '[50]',
    '{"iteration":null}', '{"other":60}', '{"iteration":12}', '{"iteration": 70',
  ])
  assert.equal(ledgerFloor(S), 41)
  // A fractional iteration rounds up, so the next generation still exceeds it.
  writeLedger(S, ['{"iteration":3}', '{"iteration":41.2}', 'null', '7'])
  assert.equal(ledgerFloor(S), 42)
})

test('ledgerFloor throws on a ledger it cannot read for another reason than absence', t => {
  const S = tmp(t)
  fs.mkdirSync(path.join(S, 'LEDGER.jsonl'))
  assert.throws(() => ledgerFloor(S), { code: 'EISDIR' })
})

test('ledgerShas collects commits, recovered commits, saves, recovered bundles and bundle tips from every row', t => {
  const S = tmp(t)
  const empty = ledgerShas(S)
  assert.deepEqual([empty.commits, empty.saves, empty.tips].map(s => s instanceof Set && s.size), [0, 0, 0])
  assert.deepEqual(Object.keys(empty).sort(), ['commits', 'saves', 'tips'])
  assert.equal(ledgerShas(path.join(S, 'missing')).commits.size, 0)

  const c1 = hex('1', 40), c2 = hex('2', 40), c3 = hex('3', 40), c4 = hex('4', 64)
  const s1 = hex('a', 64), s2 = hex('b', 64), s3 = hex('c', 64), s4 = hex('d', 64)
  const t1 = hex('e', 40), t2 = hex('f', 40)
  writeLedger(S, [
    JSON.stringify({ iteration: 1, commits: [c1], saves: null, bundles: null, recovered: null }),
    'not json',
    JSON.stringify({ iteration: 2, commits: [c2, c1], saves: [{ sha: s1, why: 'clean-clone', files: 2, out_of_scope: 0 }, { sha: s2, why: 'pause' }],
      bundles: [{ branch: 'tl/2026-10-01', tip: t1, file: 'out/tl/2026-10-01.bundle', sha256: hex('9', 64), why: 'commit' }] }),
    JSON.stringify({ iteration: 3, commits: [], recovered: { generations: [2], action: 'finish', commits: [c3, c4], bundles: [s3], task: null },
      bundles: [{ branch: 'tl/2026-10-02', tip: t2 }, { branch: 'tl/x', tip: t1 }] }),
    // Entries of the wrong shape are skipped one by one; the rest of the row still counts.
    JSON.stringify({ iteration: 4, commits: [7, null, '', { sha: c1 }], saves: ['x', { sha: 5 }, { sha: s4 }, null], bundles: [null, { tip: 1 }, 'tip'],
      recovered: { commits: 'nope', bundles: [null, 3] } }),
    JSON.stringify({ iteration: 5, commits: 'abc', saves: { sha: s1 }, bundles: { tip: t1 }, recovered: [c1] }),
    '[1,2]', 'null', '"text"', '',
    `{"iteration":6,"commits":["${hex('5', 40)}"]`, // cut short: a bad line
  ])
  const r = ledgerShas(S)
  assert.deepEqual(sorted(r.commits), sorted([c1, c2, c3, c4]))
  assert.deepEqual(sorted(r.saves), sorted([s1, s2, s3, s4]))
  assert.deepEqual(sorted(r.tips), sorted([t1, t2]))
})

test('ledgerShas throws on a ledger it cannot read for another reason than absence', t => {
  const S = tmp(t)
  fs.mkdirSync(path.join(S, 'LEDGER.jsonl'))
  assert.throws(() => ledgerShas(S), { code: 'EISDIR' })
})
