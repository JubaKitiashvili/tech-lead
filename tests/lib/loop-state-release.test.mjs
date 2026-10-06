// tests/lib/loop-state-release.test.mjs
// The section 3.1 release inside planPick (fix manifest R30; Codex g1#2-#4): a missing
// `decision:` line goes in at two spaces after the item's last field, outside any
// continuation; an already-applied decision sequence (or the suffix left after a partial entry
// deletion) is never appended again; an item with an ambiguous title is refused, its entry kept.
// Fix round 2 (R30a; Codex fix1-g1#2): an id with a raw carrier, or with more than one parsed
// carrier other than an interrupted release's pair, is refused as `ambiguous-carrier`, before
// the resume shortcut too; the entry stays and no item is edited.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, parseState, planPick, releasedItem } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, DASH, SEP, blockedItem, entry, ledger, open, state } from './loop-state-fixture.mjs'

const pick = text => planPick(text, { ledger: ledger(), level: 3 })

test('Codex g1#2: with mixed field indentation the new decision line is a field of its own', () => {
  const text = state({
    backlog: [`- [ ] cache${SEP}class: unclassified`, `    - id: ${A}`, '    - origin: human', '  - status: waiting-decision', '  - notes: first line', '      second line'],
    decisions: entry(`${A}${SEP}cache`, { decision: 'use Redis' }),
  })
  const plan = pick(text)
  assert.deepEqual([plan.state, plan.id, plan.released], ['picked', A, [A]])
  const it = parseState(applyEdits(text, plan.edits)).items.find(i => i.id === A)
  assert.deepEqual(it.problems, [])
  assert.equal(it.decision, 'use Redis')
  assert.equal(it.notes, 'first line\nsecond line')
  assert.ok(it.lines.includes('  - decision: use Redis'), it.lines.join('\n'))
})

test('Codex g1#3: an interrupted release of two filled entries never appends them again', () => {
  const text = state({
    backlog: [`- [ ] cache${SEP}class: unclassified`, `  - id: ${A}`, '  - origin: human', '  - status: waiting-decision', '  - decision: old'],
    decisions: [...entry(`${A}${SEP}cache`, { decision: 'use Redis' }), ...entry(`${A}${SEP}cache`, { variant: 'delegate-flagged', decision: 'use queues' })],
  })
  const want = 'old; then: use Redis; then: use queues'
  const plan = pick(text)
  const final = parseState(applyEdits(text, plan.edits)).items.find(i => i.id === A)
  assert.equal(final.decision, want)
  // Interrupted after the item edit, and after each entry deletion: the rerun keeps the sequence.
  const entryDeletes = plan.edits.filter(e => e.old.includes(`### ${A}`)).length
  assert.equal(entryDeletes, 2)
  for (let k = 1; k <= 1 + entryDeletes - 1; k++) {
    const mid = applyEdits(text, plan.edits.slice(0, k))
    const again = pick(mid)
    assert.equal(again.id, A, `after edit ${k}`)
    const it = parseState(applyEdits(mid, again.edits)).items.find(i => i.id === A)
    assert.equal(it.decision, want, `after edit ${k}`)
    assert.deepEqual(parseState(applyEdits(mid, again.edits)).entries, [], `after edit ${k}`)
  }
})

test('Codex g1#4: an item with an ambiguous title is never released; its entry stays and is named', () => {
  for (const title of [`P1${SEP}build cache`, `build cache${SEP}class: mechanical`]) {
    const text = state({
      decisions: entry(`${A}${SEP}build cache`, { decision: 'use Redis' }),
      blocked: blockedItem(title, { id: A, status: DASH }),
    })
    assert.deepEqual(parseState(text).items[0].problems.map(p => p.kind), ['ambiguous-title'], title)
    const plan = pick(text)
    assert.deepEqual([plan.state, plan.released, plan.edits], ['dry', [], []], title)
    assert.deepEqual(plan.skipped.map(s => [s.id, s.reason]), [[A, 'ambiguous-title']], title)
  }
})

// The release refused for `id`: nothing else is eligible in these files, so the answer is dry
// with no edit at all (no item edited, no entry deleted), and releasedItem agrees.
const refusedRelease = (text, id, label) => {
  const plan = pick(text)
  assert.deepEqual([plan.state, plan.released, plan.edits], ['dry', [], []], label)
  // The release's refusal comes first; the pick may then pass over an ineligible copy too.
  assert.equal(plan.skipped.find(s => s.id === id)?.reason, 'ambiguous-carrier', label)
  assert.equal(releasedItem(parseState(text), id), null, label)
  const after = parseState(applyEdits(text, plan.edits))
  assert.deepEqual(after.entries.filter(e => e.id === id).map(e => e.filled), [true], label)
  return { plan, after }
}

test('Codex fix1-g1#2: a stale Backlog copy and a Blocked item carrying A and B: no release, the entry stays', () => {
  const text = state({
    backlog: open('cache (old copy)', { id: A }),
    decisions: entry(`${A}${SEP}cache`, { decision: 'use Redis' }),
    blocked: blockedItem('cache', { id: A, extra: [`  - id: ${B}`] }),
  })
  const { after } = refusedRelease(text, A, 'stale copy')
  // The stale copy stays in ## Backlog with no decision.
  assert.deepEqual(after.items.map(i => [i.section, i.id, i.decision]), [['Backlog', A, ''], ['Blocked', null, '']])
})

test('R30a: a raw carrier refuses the release before the interrupted-release resume shortcut', () => {
  const bl = state({ decisions: entry(`${B}${SEP}stuck`, { decision: 'use Redis' }), blocked: blockedItem('stuck', { id: B }) })
  // Interrupted between the insert into ## Backlog and the delete from ## Blocked: the resume
  // pair. A person's item elsewhere also names B on an id-like line.
  const mid = applyEdits(bl, pick(bl).edits.slice(0, 1))
  assert.deepEqual(parseState(mid).items.map(i => [i.section, i.id]), [['Backlog', B], ['Blocked', B]])
  const text = mid.replace('## Done\n(empty)', `## Done\n- [x] other${SEP}abc1234${SEP}2026-10-01\n  - id: ${C}\n  - origin: human\n  - ID: ${B}`)
  assert.notEqual(text, mid)
  const { plan, after } = refusedRelease(text, B, 'resume pair with a raw carrier')
  // Neither copy is deleted.
  assert.deepEqual(after.items.filter(i => i.id === B).map(i => i.section), ['Backlog', 'Blocked'])
  assert.match(plan.skipped[0].detail, /Done line \d+ \(an id line that does not parse to it\)/)
})

test('R30a: two parsed carriers that are not a resume pair are ambiguous-carrier', () => {
  const text = state({
    backlog: open('cache', { id: A, notes: 'one copy' }),
    decisions: entry(`${A}${SEP}cache`, { decision: 'use Redis' }),
    blocked: blockedItem('cache', { id: A, notes: 'another copy' }),
  })
  refusedRelease(text, A, 'two copies')
})
