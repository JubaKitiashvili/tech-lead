// tests/lib/loop-state-normalize.test.mjs
// planNormalize and applyEdits (stage 0c-3 brief R1, R14): ids and origins in every section,
// nothing a person wrote rewritten, idempotent, anchors that apply once, unique anchors for
// byte-identical blocks, and expect_sha256.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ID_RE, applyEdits, parseState, planNormalize } from '../../scripts/lib/loop-state.mjs'
import { A, B, DASH, SEP, blockedItem, doneItem, entry, ledger, open, sha256, state } from './loop-state-fixture.mjs'

const legacy = () => state({
  now: open('in flight', { origin: null, cls: 'hard', p: 1 }),
  backlog: [
    ...open('first', { origin: null, blockedBy: 'in flight', status: DASH, notes: 'context' }),
    ...open('second', { origin: null, p: 2 }),
  ],
  decisions: entry(`old heading${SEP}x`),
  blocked: blockedItem('stuck', { origin: null }),
  done: [...doneItem('shipped', { origin: null }), ...doneItem('analysed', { origin: null, sha: null })],
})

test('normalize mints an id and fills the origin of every item, in every section', () => {
  const text = legacy()
  const plan = planNormalize(text, { known: new Set() })
  assert.equal(plan.state, 'ok')
  assert.equal(plan.minted.length, 6)
  assert.deepEqual(plan.origins, plan.minted)
  const st = parseState(applyEdits(text, plan.edits))
  assert.deepEqual(st.items.map(i => i.section), ['Now', 'Backlog', 'Backlog', 'Blocked', 'Done', 'Done'])
  assert.deepEqual(st.items.map(i => i.id), plan.minted)
  for (const it of st.items) {
    assert.ok(ID_RE.test(it.id))
    assert.equal(it.origin, 'unknown')
    assert.deepEqual(it.fields.slice(0, 2).map(f => f.label), ['id', 'origin'])
    assert.ok(!it.problems.length, `${it.title}: ${JSON.stringify(it.problems)}`)
  }
  assert.equal(new Set(plan.minted).size, 6)
})

test('normalize adds lines only: every original line stays, in order, and headers are unchanged', () => {
  const text = legacy()
  const after = applyEdits(text, planNormalize(text, { known: new Set() }).edits)
  const added = []
  const orig = text.split('\n')
  let k = 0
  for (const l of after.split('\n')) {
    if (k < orig.length && l === orig[k]) k++
    else added.push(l)
  }
  assert.equal(k, orig.length, 'every original line is kept in order')
  for (const l of added) assert.match(l, /^ {2}- (id: tl-[0-9a-z]{8}|origin: unknown)$/)
})

test('normalize never rewrites a person\'s id, origin, title or blocker; it reports them', () => {
  const text = state({
    backlog: [
      ...open('hand id', { id: 'my-task' }),
      ...open('bad origin', { id: A, origin: 'robot' }),
      ...open(`P1${SEP}odd title`, { id: B, p: 3 }),
      ...open('title blocker', { origin: 'human', blockedBy: 'hand id' }),
    ],
  })
  const plan = planNormalize(text, { known: new Set() })
  const after = applyEdits(text, plan.edits)
  // Only the last item gets a line (its id); nothing else changes.
  assert.equal(plan.minted.length, 1)
  assert.equal(after.split('\n').length, text.split('\n').length + 1)
  for (const l of text.split('\n')) assert.ok(after.includes(l), l)
  const kinds = plan.problems.map(p => p.kind)
  for (const k of ['invalid-id', 'invalid-origin', 'ambiguous-title', 'title-blocker']) assert.ok(kinds.includes(k), k)
  assert.ok(!kinds.includes('no-id'))
})

test('normalize is idempotent, and each of its edits applies only once', () => {
  const text = legacy()
  const plan = planNormalize(text, { known: new Set() })
  const after = applyEdits(text, plan.edits)
  const again = planNormalize(after, { known: new Set() })
  assert.deepEqual(again.edits, [])
  assert.deepEqual(again.minted, [])
  assert.equal(again.expect_sha256, sha256(after))
  // A second application of the whole plan, or of any single edit, fails.
  assert.throws(() => applyEdits(after, plan.edits), /edit-anchor/)
  let t = text
  for (const e of plan.edits) {
    t = applyEdits(t, [e])
    assert.throws(() => applyEdits(t, [e]), /edit-anchor: edit 1: old occurs 0 times/)
  }
  assert.equal(t, after)
})

test('byte-identical id-less blocks get unique anchors and different ids', () => {
  const block = open('same', { origin: null, notes: 'same notes' })
  const text = state({ backlog: [...block, ...block, ...block], blocked: [...blockedItem('same', { origin: null }), ...blockedItem('same', { origin: null })] })
  const plan = planNormalize(text, { known: new Set() })
  for (const e of plan.edits) assert.ok(e.old.length > 0)
  const after = applyEdits(text, plan.edits)
  const st = parseState(after)
  assert.equal(st.items.length, 5)
  assert.equal(new Set(st.items.map(i => i.id)).size, 5)
  assert.deepEqual(st.items.map(i => i.id), plan.minted)
})

test('expect_sha256 is the hash of the text with every edit applied; no edits hash the input', () => {
  const text = legacy()
  const plan = planNormalize(text, { known: new Set() })
  assert.equal(plan.expect_sha256, sha256(applyEdits(text, plan.edits)))
  const clean = state({ backlog: open('t', { id: A }) })
  const none = planNormalize(clean, { known: new Set() })
  assert.deepEqual(none.edits, [])
  assert.equal(none.expect_sha256, sha256(clean))
})

test('normalize refuses a carriage return; the ledger joins the known ids and the problems', () => {
  const crlf = planNormalize(legacy().replace(/\n/g, '\r\n'), { known: new Set() })
  assert.equal(crlf.state, 'refused')
  assert.equal(crlf.reason, 'crlf')
  assert.deepEqual(crlf.edits, [])
  const text = state({ backlog: open('t', { id: A, blockedBy: B }) })
  assert.ok(planNormalize(text, {}).problems.some(p => p.kind === 'unknown-blocker'))
  assert.ok(!planNormalize(text, { ledger: ledger({ done: [B] }) }).problems.some(p => p.kind === 'unknown-blocker'))
})

test('applyEdits refuses an anchor that is missing, repeated or survives its edit', () => {
  assert.equal(applyEdits('a\nb\n', [{ old: 'a\n', new: 'x\n' }, { old: 'x\nb', new: 'y' }]), 'y\n')
  assert.throws(() => applyEdits('a\na\n', [{ old: 'a', new: 'b' }]), /occurs 2 times/)
  assert.throws(() => applyEdits('aaa', [{ old: 'aa', new: 'b' }]), /occurs 2 times/) // overlapping occurrences count
  assert.throws(() => applyEdits('a\n', [{ old: 'z', new: 'b' }]), /occurs 0 times/)
  assert.throws(() => applyEdits('a\n', [{ old: 'a', new: 'aa' }]), /survives its edit/)
  assert.throws(() => applyEdits('a\n', [{ old: '', new: 'b' }]), /non-empty old/)
  assert.throws(() => applyEdits('a\n', [{ old: 'a' }]), /non-empty old/)
  // A replacement holding $ patterns is copied literally.
  assert.equal(applyEdits('a\n', [{ old: 'a', new: '$&$1' }]), '$&$1\n')
})

// Fix manifest R31 (Claude PARSE-1): an id-like or origin-like line that is not a well-formed
// field is malformed-field, and normalize mints no id (or origin) over it.
test('normalize never mints over a person\'s id or origin lookalike; the item is malformed-field', () => {
  const TAB = '\t'
  for (const [name, idLine, originLine] of [
    ['tab indent', `${TAB}- id: ${A}`, `${TAB}- origin: human`],
    ['star marker', `  * id: ${A}`, '  * origin: human'],
    ['capital label', `  - ID: ${A}`, '  - Origin: human'],
    ['space before colon', `  - id : ${A}`, '  - origin : human'],
    ['no space after colon', `  - id:${A}`, '  - origin:human'],
    ['six-space indent', `      - id: ${A}`, '      - origin: human'],
  ]) {
    const text = state({ backlog: [`- [ ] lookalike${SEP}class: unclassified`, idLine, originLine, `  - status: waiting-infra`] })
    const plan = planNormalize(text, { known: new Set() })
    assert.deepEqual([plan.minted, plan.origins, plan.edits], [[], [], []], name)
    const kinds = plan.problems.map(p => p.kind)
    assert.ok(kinds.includes('malformed-field'), `${name}: ${kinds}`)
    assert.ok(!kinds.includes('no-id'), `${name}: ${kinds}`)
  }
  // An id lookalike alone: no id minted, but the missing origin is still filled; and the reverse.
  const idOnly = state({ backlog: [`- [ ] a${SEP}class: unclassified`, `  - ID: ${A}`] })
  const p1 = planNormalize(idOnly, { known: new Set() })
  assert.deepEqual(p1.minted, [])
  assert.match(applyEdits(idOnly, p1.edits), /\n {2}- origin: unknown\n/)
  const originOnly = state({ backlog: [`- [ ] b${SEP}class: unclassified`, `  - id: ${B}`, `  - Origin: loop from ${A}`] })
  assert.deepEqual(planNormalize(originOnly, { known: new Set() }).edits, [])
})

test('PARSE-1: a column-0 text line inside an item joins it as malformed-field: no mint, never picked', () => {
  const text = state({ backlog: [`- [ ] parked${SEP}class: mechanical`, 'Note: waiting on vendor', `  - id: ${A}`, '  - origin: human', '  - status: waiting-infra'] })
  const st = parseState(text)
  assert.deepEqual(st.problems.filter(p => p.kind === 'unparsed-line'), [])
  const it = st.items[0]
  assert.deepEqual([it.id, it.status], [A, 'waiting-infra'])
  assert.deepEqual(it.problems.map(p => p.kind), ['malformed-field'])
  const plan = planNormalize(text, { known: new Set() })
  assert.deepEqual(plan.edits, [])
  // A list line or a blank line before it still starts a block of its own.
  const apart = parseState(state({ backlog: [...open('x', { id: A }), '', 'loose text', '* star line'] }))
  assert.deepEqual(apart.items[0].problems, [])
  assert.deepEqual(apart.problems.map(p => p.kind), ['unparsed-line', 'unparsed-line'])
})
