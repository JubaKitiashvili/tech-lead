// tests/lib/ledger.test.mjs
// Ledger reading (stage 0c-2 brief section 1): ledgerFloor moved here from loop-lock.mjs,
// which re-exports it, and ledgerShas, the set of every sha the ledger names. Stage 0c-3
// (brief R21): ledgerItems, the item ids, done ids and origins the ledger records; R27: done_items.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ledgerFloor, ledgerItems, ledgerShas } from '../../scripts/lib/ledger.mjs'
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

// Item ids in the R2 shape (ID_RE = /^tl-[0-9a-hjkmnp-tv-z]{8}$/).
const A = 'tl-0000000a', B = 'tl-0000000b', C = 'tl-0000000c', D = 'tl-0000000d', E = 'tl-0000000e', F = 'tl-0000000f'
const G = 'tl-0000000g', H = 'tl-0000000h'
const row = fields => JSON.stringify({ iteration: 1, ts: 'x', task: 'a title', ...fields })

test('ledgerItems is empty for a missing or empty ledger and throws on one it cannot read', t => {
  const S = tmp(t)
  for (const r of [ledgerItems(S), ledgerItems(path.join(S, 'missing'))]) {
    assert.deepEqual(Object.keys(r).sort(), ['doneIds', 'ids', 'origins'])
    assert.ok(r.ids instanceof Set && r.doneIds instanceof Set && r.origins instanceof Map)
    assert.deepEqual([r.ids.size, r.doneIds.size, r.origins.size], [0, 0, 0])
  }
  writeLedger(S, [''])
  assert.equal(ledgerItems(S).ids.size, 0)
  fs.rmSync(path.join(S, 'LEDGER.jsonl'))
  fs.mkdirSync(path.join(S, 'LEDGER.jsonl'))
  assert.throws(() => ledgerItems(S), { code: 'EISDIR' })
})

test('ledgerItems collects ids from rows and recovered, done ids from done rows and recovered finish-commits', t => {
  const S = tmp(t)
  writeLedger(S, [
    row({ outcome: 'done', item_id: A, item_origin: 'human' }),
    row({ outcome: 'failed', item_id: B, item_origin: 'unknown' }),
    row({ outcome: 'done', item_id: null, item_origin: null }), // nothing picked: contributes nothing
    'not json',
    row({ outcome: 'skipped', item_id: null, recovered: { action: 'finish-commit', item_id: C, item_origin: `loop from ${A}` } }),
    row({ outcome: 'blocked', item_id: D, recovered: { action: 'requeue-now', item_id: E, item_origin: 'bootstrap' } }),
    row({ outcome: 'done', task: 'legacy row without item_id' }),
    row({ outcome: 'needs-decision', item_id: F, recovered: { action: 'finish-commit', item_id: null } }),
    '[1]', 'null',
  ])
  const r = ledgerItems(S)
  assert.deepEqual(sorted(r.ids), [A, B, C, D, E, F])
  assert.deepEqual(sorted(r.doneIds), [A, C])
  assert.deepEqual([...r.origins].sort(), [[A, 'human'], [B, 'unknown'], [C, `loop from ${A}`], [E, 'bootstrap']])
})

test('ledgerItems: only an ID_RE item_id is done; the outcome and action must match exactly', t => {
  const S = tmp(t)
  writeLedger(S, [
    row({ outcome: 'done', item_id: 'TL-0000000A' }), // an upper-case copy is the same id, lowercased (F12)
    row({ outcome: 'done', item_id: 'my task' }), // a title is never a done id
    row({ outcome: 'done', item_id: 'tl-0000000i' }), // i is outside the alphabet
    row({ outcome: 'Done', item_id: B }),
    row({ outcome: ['done'], item_id: C }),
    row({ outcome: 'skipped', recovered: { action: 'finish-commit', item_id: 'tl-0000000u' } }), // u is outside the alphabet
    row({ outcome: 'skipped', recovered: { action: 'finish', item_id: D } }),
    row({ outcome: 'skipped', recovered: { action: 'Finish-Commit', item_id: E } }),
    row({ outcome: 'done', item_id: F, recovered: 'finish-commit' }),
    row({ outcome: 'skipped', recovered: [{ action: 'finish-commit', item_id: G }] }),
    row({ outcome: 'done', item_id: H }),
  ])
  const r = ledgerItems(S)
  assert.deepEqual(sorted(r.doneIds), [A, F, H])
  // The id set takes every non-empty string item_id (the known set for minting), whatever its shape, lowercased.
  assert.deepEqual(sorted(r.ids), sorted([A, 'my task', 'tl-0000000i', B, C, 'tl-0000000u', D, E, F, H]))
})

// Fix manifest F12 (code-review #5): an upper-case item_id is the same id in lower case, in ids,
// doneIds and origins alike, so a done row written with `TL-…` still satisfies a blocker after
// ## Done is trimmed.
test('ledgerItems lowercases item_id before testing and storing it (F12)', async t => {
  const { blockerStatus, parseState } = await import('../../scripts/lib/loop-state.mjs')
  const S = tmp(t)
  writeLedger(S, [
    row({ outcome: 'done', item_id: A.toUpperCase(), item_origin: 'human' }),
    row({ outcome: 'skipped', recovered: { action: 'finish-commit', item_id: B.toUpperCase(), item_origin: `loop from ${A}` } }),
    row({ outcome: 'failed', item_id: null, done_items: [{ item_id: 'Tl-0000000C', item_origin: 'unknown' }] }),
    row({ outcome: 'failed', item_id: 'My Task', item_origin: 'human' }),
  ])
  const r = ledgerItems(S)
  assert.deepEqual(sorted(r.doneIds), [A, B, C])
  assert.deepEqual(sorted(r.ids), sorted([A, B, C, 'my task']))
  assert.deepEqual([...r.origins].sort(), [['my task', 'human'], [A, 'human'], [B, `loop from ${A}`], [C, 'unknown']])
  // Dependent waits on A; A's Done block was trimmed, so the ledger's record is all there is.
  const state = parseState([
    '## Now', '(empty)', '', '## Backlog',
    '- [ ] Dependent · class: mechanical', `  - id: ${D}`, '  - origin: human', `  - blocked-by: ${A}`,
    '', '## Blocked', '(empty)', '', '## Needs decision', '(empty)', '', '## Done', '(empty)', '', '## Last run', '(empty)', '',
  ].join('\n'))
  assert.equal(blockerStatus(state, A, r), 'finished')
})

test('ledgerItems keeps the latest origin per id in file order, recovered before the row, and skips empty or non-string ones', t => {
  const S = tmp(t)
  writeLedger(S, [
    row({ outcome: 'failed', item_id: A, item_origin: 'unknown' }),
    row({ outcome: 'done', item_id: A, item_origin: 'human' }),
    // The recovery report describes an earlier generation, so the row's own origin is later.
    row({ outcome: 'failed', item_id: B, item_origin: `loop from ${A}`, recovered: { action: 'finish-commit', item_id: B, item_origin: 'bootstrap' } }),
    row({ outcome: 'failed', item_id: A, item_origin: null }), // no origin recorded: the earlier one stands
    row({ outcome: 'failed', item_id: A, item_origin: '' }),
    row({ outcome: 'failed', item_id: A, item_origin: 7 }),
    row({ outcome: 'failed', item_id: null, item_origin: 'human' }), // no id: nothing
    row({ outcome: 'failed', item_origin: 'human' }),
    row({ outcome: 'failed', item_id: C, item_origin: 'loop from damaged tl-0000000d' }), // kept raw for the R9 token rule
    row({ outcome: 'failed', item_id: 5, item_origin: 'human' }),
    row({ outcome: 'failed', item_id: '', item_origin: 'human' }),
  ])
  const r = ledgerItems(S)
  assert.deepEqual([...r.origins].sort(), [[A, 'human'], [B, `loop from ${A}`], [C, 'loop from damaged tl-0000000d']])
  assert.deepEqual(sorted(r.ids), [A, B, C])
})

// R27: a row's done_items [{item_id, item_origin}] (pick's `unledgered`, the ## Done entries no
// row recorded done) count as done and give their origins, so a completion whose own row was
// lost (an interrupted Done move, an analysis item) survives the ## Done trim.
test('ledgerItems counts each done_items entry as done and takes its origin, after recovered and before the row', t => {
  const S = tmp(t)
  writeLedger(S, [
    row({ outcome: 'failed', item_id: A, item_origin: 'human', done_items: [{ item_id: B, item_origin: `loop from ${C}` }, { item_id: D, item_origin: 'unknown' }] }),
    // The row's own fields describe its pick, which is later than the entries it records.
    row({ outcome: 'failed', item_id: E, item_origin: 'human', done_items: [{ item_id: E, item_origin: 'unknown' }] }),
    row({ outcome: 'halted', item_id: null, item_origin: null, done_items: [{ item_id: F, item_origin: null }] }),
    // Wrong shapes are skipped one at a time; a non-ID_RE id is known but never done.
    row({ outcome: 'failed', item_id: null, done_items: [null, 'tl-0000000g', [G], { item_id: 7 }, { item_id: 'my task', item_origin: 'human' }, { item_id: H }] }),
    row({ outcome: 'failed', item_id: null, done_items: { item_id: G } }),
  ])
  const r = ledgerItems(S)
  assert.deepEqual(sorted(r.doneIds), [B, D, E, F, H])
  assert.deepEqual(sorted(r.ids), sorted([A, B, D, E, F, 'my task', H]))
  assert.deepEqual([...r.origins].sort(), [['my task', 'human'], [A, 'human'], [B, `loop from ${C}`], [D, 'unknown'], [E, 'human']])
})

test('R27 chain: a done_items row keeps P unfinished after the trim while its grandchild G is open', async t => {
  const { blockerStatus, parseState } = await import('../../scripts/lib/loop-state.mjs')
  const S = tmp(t)
  // P is done; F (loop from P) reached ## Done but its firing's row was lost; F is then trimmed.
  // G (loop from F) is still open, X waits on P.
  const state = parseState([
    '## Now', '(empty)', '', '## Backlog',
    '- [ ] X · class: mechanical', `  - id: ${A}`, '  - origin: human', `  - blocked-by: ${C}`,
    '- [ ] G · class: mechanical', `  - id: ${B}`, `  - origin: loop from ${F}`,
    '', '## Blocked', '(empty)', '', '## Needs decision', '(empty)', '', '## Done', '(empty)', '', '## Last run', '(empty)', '',
  ].join('\n'))
  writeLedger(S, [row({ outcome: 'done', item_id: C, item_origin: 'human' })])
  assert.equal(blockerStatus(state, C, ledgerItems(S)), 'finished', 'the lost row is the early release R27 closes')
  // The next firing's row records F from pick's unledgered, before the trim drops it.
  writeLedger(S, [
    row({ outcome: 'done', item_id: C, item_origin: 'human' }),
    row({ outcome: 'failed', item_id: D, item_origin: 'human', done_items: [{ item_id: F, item_origin: `loop from ${C}` }] }),
  ])
  assert.equal(blockerStatus(state, C, ledgerItems(S)), 'unfinished')
  assert.equal(blockerStatus(state, F, ledgerItems(S)), 'unfinished')
})
