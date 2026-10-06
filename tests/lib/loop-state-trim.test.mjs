// tests/lib/loop-state-trim.test.mjs
// planDoneTrim (fix manifest R27; Claude PDC-2): `## Done` is trimmed to the `max` most recent
// (topmost) entries, whole blocks (header and every field line), and an entry the ledger does
// not record as done is never dropped, so its id and its `loop from` origin survive the trim.
// Fix round 2 (R27a; Codex fix1-g1#1, fix1-g2#2): nor is an entry whose origin-like lines are
// not exactly one well-formed `origin:` field, since the ledger carries one parsed origin only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, blockerStatus, eligibility, parseState, planDoneTrim, planPick } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, DASH, E, F, SEP, doneItem, ledger, open, sha256, state } from './loop-state-fixture.mjs'

// n Done entries; the k-th (k < 32) has the id tl-0000000<the k-th Crockford base32 digit>.
const idOf = k => `tl-0000000${'0123456789abcdefghjkmnpqrstvwxyz'[k]}`
const entries = n => Array.from({ length: n }, (_, k) => doneItem(`done ${k}`, { id: idOf(k), notes: `line one of ${k}`, extra: ['      line two'] })).flat()
const doneIds = st => st.items.filter(i => i.section === 'Done').map(i => i.id)

test('trims to the max most recent entries, dropping whole blocks', () => {
  const text = state({ backlog: open('open', { id: A }), done: entries(23) })
  const L = ledger({ done: Array.from({ length: 23 }, (_, k) => idOf(k)) })
  const plan = planDoneTrim(text, { ledger: L })
  assert.equal(plan.state, 'ok')
  assert.deepEqual(plan.dropped, [idOf(20), idOf(21), idOf(22)])
  assert.deepEqual(plan.unledgered, [])
  const after = applyEdits(text, plan.edits)
  assert.equal(plan.expect_sha256, sha256(after))
  const st = parseState(after)
  assert.deepEqual(doneIds(st), Array.from({ length: 20 }, (_, k) => idOf(k)))
  assert.ok(!after.includes('line one of 20') && !after.includes('done 22'))
  assert.equal(after.split('\n').filter(l => l === '      line two').length, 20)
  assert.deepEqual(st.problems, [])
  // Idempotent: a second trim has nothing to do.
  assert.deepEqual(planDoneTrim(after, { ledger: L }).edits, [])
})

test('an unledgered entry is never dropped, wherever it sits', () => {
  const text = state({ done: entries(6) })
  // Only 0, 1, 3 and 5 are ledgered: with max 2, 3 and 5 go, 2 and 4 stay.
  const L = ledger({ done: [idOf(0), idOf(1), idOf(3), idOf(5)] })
  const plan = planDoneTrim(text, { ledger: L, max: 2 })
  assert.deepEqual(plan.dropped, [idOf(3), idOf(5)])
  assert.deepEqual(plan.unledgered, [{ item_id: idOf(2), item_origin: 'human' }, { item_id: idOf(4), item_origin: 'human' }])
  assert.deepEqual(doneIds(parseState(applyEdits(text, plan.edits))), [idOf(0), idOf(1), idOf(2), idOf(4)])
  // With no ledger at all nothing is dropped.
  assert.deepEqual(planDoneTrim(text, { ledger: null, max: 2 }).edits, [])
})

test('id-less entries are kept; unparsed lines in ## Done are kept and not counted', () => {
  const text = state({ done: [...doneItem('a', { id: A }), `- [x] no date${SEP}abc1234`, '  - id: tl-zzzzzzzz', ...doneItem('no id', {}), ...doneItem('b', { id: B }), ...doneItem('c', { id: C, sha: null })] })
  const plan = planDoneTrim(text, { ledger: ledger({ done: [A, B, C] }), max: 1 })
  assert.deepEqual(plan.dropped, [B, C])
  const after = applyEdits(text, plan.edits)
  assert.ok(after.includes(`- [x] no date${SEP}abc1234\n  - id: tl-zzzzzzzz\n- [x] no id${SEP}`))
  assert.ok(!after.includes(`- [x] c${SEP}${DASH}`))
})

test('dropping every entry leaves (empty); refusals: a carriage return, a missing ## Done', () => {
  const text = state({ done: entries(2) })
  const all = planDoneTrim(text, { ledger: ledger({ done: [idOf(0), idOf(1)] }), max: 0 })
  const s = parseState(applyEdits(text, all.edits))
  assert.deepEqual(doneIds(s), [])
  assert.deepEqual(applyEdits(text, all.edits).split('\n').slice(s.sections.Done.start, s.sections.Done.end).filter(l => l.trim()), ['(empty)'])
  assert.equal(planDoneTrim(text.replace(/\n/g, '\r\n'), { ledger: ledger() }).reason, 'crlf')
  assert.equal(planDoneTrim(text.replace('## Done', '## Finished'), { ledger: ledger() }).reason, 'bad-sections')
  assert.throws(() => planDoneTrim(text, { ledger: ledger(), max: -1 }), TypeError)
})

// P -> F -> G: P done and ledgered, F a Done follow-up whose parent P is named on a line the
// ledger cannot carry whole, G open (loop from F), X blocked by P, and twenty newer
// completions above F. The firing journals F with the one origin pick reports (unledgered),
// then trims: F stays, so P stays unfinished and X stays parked while G is open.
const lineage = {
  'a capitalized Origin:': [`  - id: ${F}`, `  - Origin: loop from ${A}`],
  'a second origin: line': [`  - id: ${F}`, '  - origin: human', `  - origin: loop from ${A}`],
  'a malformed origin: field': [`  - id: ${F}`, `  - origin: loop from ${A} (the cache work)`],
}

test('Codex fix1-g1#1, fix1-g2#2: a Done entry whose lineage the ledger cannot carry whole is never trimmed', () => {
  for (const [label, fLines] of Object.entries(lineage)) {
    const text = state({
      backlog: [...open('G', { id: E, origin: `loop from ${F}` }), ...open('X', { id: D, blockedBy: A })],
      done: [...entries(20), `- [x] F${SEP}abc1234${SEP}2026-09-01`, ...fLines, ...doneItem('P', { id: A, date: '2026-08-01' })],
    })
    const st = parseState(text)
    const before = ledger({ done: [A, ...Array.from({ length: 20 }, (_, k) => idOf(k))] })
    assert.equal(blockerStatus(st, A, before), 'unfinished', label)
    // The firing journals what pick reports unledgered: F, with its one parsed origin.
    const un = planPick(text, { ledger: before, level: 3 }).unledgered
    assert.deepEqual(un.map(u => u.item_id), [F], label)
    const L = ledger({ done: [...before.doneIds, F], origins: Object.fromEntries(un.filter(u => u.item_origin).map(u => [u.item_id, u.item_origin])) })
    const plan = planDoneTrim(text, { ledger: L })
    assert.deepEqual(plan.dropped, [A], label)
    const after = parseState(applyEdits(text, plan.edits))
    assert.ok(after.items.some(i => i.section === 'Done' && i.title === 'F'), label)
    assert.equal(blockerStatus(after, A, L), 'unfinished', label)
    assert.equal(eligibility(after, { ledger: L, level: 3 }).find(r => r.id === D).reason, 'blocked', label)
  }
})

test('R27a: one well-formed origin: field, or no origin-like line at all, still lets a ledgered entry go', () => {
  const text = state({
    done: [...entries(1), ...doneItem('loop child', { id: A, origin: `loop from ${idOf(0)}` }), ...doneItem('no origin', { id: B, origin: null }), ...doneItem('id only on a note', { id: C, notes: 'origin is human' })],
  })
  const plan = planDoneTrim(text, { ledger: ledger({ done: [idOf(0), A, B, C] }), max: 1 })
  assert.deepEqual(plan.dropped, [A, B, C])
})
