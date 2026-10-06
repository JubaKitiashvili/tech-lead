// tests/lib/loop-state-digests.test.mjs
// Item digests (stage 0c-3 brief R6): itemDigest over {id, title, notes, decision} and
// approvedDigest over {title, notes, decision}, as SHA-256 of canonical JSON; releasedItem's
// digest equals the item's once the release is applied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, approvedDigest, itemDigest, parseState, planPick, releasedItem } from '../../scripts/lib/loop-state.mjs'
import { A, B, DASH, blockedItem, entry, ledger, open, sha256, state, SEP } from './loop-state-fixture.mjs'

const base = { id: A, title: 'fix the parser', notes: 'context', decision: '' }

test('itemDigest is the SHA-256 of the canonical JSON of {id, title, notes, decision}', () => {
  assert.equal(itemDigest(base), sha256(`{"decision":"","id":"${A}","notes":"context","title":"fix the parser"}`))
  assert.equal(approvedDigest(base), sha256('{"decision":"","notes":"context","title":"fix the parser"}'))
})

test('the digests are stable under key order and ignore every other field', () => {
  const shuffled = { decision: '', notes: 'context', title: 'fix the parser', id: A }
  assert.equal(itemDigest(shuffled), itemDigest(base))
  const extra = { ...base, class: 'hard', status: 'waiting-level', origin: 'human', blockedBy: B, decided: 'x', noChangeOk: 'yes', recovery: 'f'.repeat(64) }
  assert.equal(itemDigest(extra), itemDigest(base))
  assert.equal(approvedDigest(extra), approvedDigest(base))
})

test('each of id, title, notes and decision changes itemDigest; the id does not change approvedDigest', () => {
  const d = itemDigest(base)
  for (const [k, v] of [['id', B], ['title', 'fix the parser!'], ['notes', 'context.'], ['decision', 'go']]) {
    assert.notEqual(itemDigest({ ...base, [k]: v }), d, k)
    if (k !== 'id') assert.notEqual(approvedDigest({ ...base, [k]: v }), approvedDigest(base), k)
  }
  assert.equal(approvedDigest({ ...base, id: B }), approvedDigest(base))
})

test('digests read the R5 values: an absent or dash notes is "", no Unicode normalization', () => {
  const st = parseState(state({ backlog: [...open('t', { id: A, notes: DASH }), ...open('u', { id: B })] }))
  assert.equal(itemDigest(st.items[0]), itemDigest({ id: A, title: 't', notes: '', decision: '' }))
  assert.equal(itemDigest(st.items[1]), itemDigest({ id: B, title: 'u', notes: '', decision: '' }))
  const nfc = String.fromCodePoint(0xe9), nfd = String.fromCodePoint(0x65, 0x301)
  assert.notEqual(itemDigest({ ...base, title: nfc }), itemDigest({ ...base, title: nfd }))
})

test('releasedItem: the item as the release leaves it, and its digest equals the applied item\'s', () => {
  const cases = [
    state({ backlog: open('fix the parser', { id: A, cls: 'high-stakes', status: 'waiting-decision', notes: 'n' }), decisions: entry(`${A}${SEP}fix the parser`, { decision: 'use the queue' }) }),
    state({ backlog: open('fix the parser', { id: A, decision: 'earlier', status: 'waiting-decision' }), decisions: entry(`${A}${SEP}x`, { variant: 'delegate-flagged', decision: 'later' }) }),
    state({ blocked: blockedItem('stuck', { id: A, notes: 'n' }), decisions: entry(`${A}${SEP}stuck`, { decision: 'retry with a mock' }) }),
  ]
  for (const text of cases) {
    const st = parseState(text)
    const rel = releasedItem(st, A)
    assert.equal(rel.section, 'Backlog')
    assert.equal(rel.class, 'hard')
    assert.equal(rel.status, null)
    const after = parseState(applyEdits(text, planPick(text, { ledger: ledger(), level: 1 }).edits))
    const applied = after.items.find(i => i.id === A)
    assert.equal(itemDigest(rel), itemDigest(applied))
    assert.equal(approvedDigest(rel), approvedDigest(applied))
    assert.equal(rel.decision, applied.decision)
  }
  assert.equal(releasedItem(parseState(cases[1]), A).decision, 'earlier; then: later')
  // Nothing to release: no filled entry, or no such item.
  assert.equal(releasedItem(parseState(state({ backlog: open('t', { id: A }), decisions: entry(`${A}${SEP}t`) })), A), null)
  assert.equal(releasedItem(parseState(state({ decisions: entry(`${A}${SEP}t`, { decision: 'go' }) })), A), null)
  assert.equal(releasedItem(parseState(state()), 'not an id'), null)
})
