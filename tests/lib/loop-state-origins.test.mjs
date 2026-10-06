// tests/lib/loop-state-origins.test.mjs
// Item origins (stage 0c-3 brief R1, R9): the four forms, filling a missing origin with the
// policy, an invalid origin that still holds the parents its tokens name, a doubled origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, blockerStatus, eligibility, parseOrigin, parseState, planNormalize } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, doneItem, ledger, open, state } from './loop-state-fixture.mjs'

test('parseOrigin: bootstrap, human, unknown and loop from <id>; anything else is null', () => {
  assert.deepEqual(parseOrigin('bootstrap'), { kind: 'bootstrap', parent: null })
  assert.deepEqual(parseOrigin('human'), { kind: 'human', parent: null })
  assert.deepEqual(parseOrigin('unknown'), { kind: 'unknown', parent: null })
  assert.deepEqual(parseOrigin(`loop from ${A}`), { kind: 'loop', parent: A })
  for (const bad of ['', 'Human', 'HUMAN', 'loop from', `loop from ${A.toUpperCase()}`, `loop from ${A} extra`, `loop  from ${A}`,
    'loop from fix the parser', 'machine', ` human`, null, undefined, 42]) {
    assert.equal(parseOrigin(bad), null, JSON.stringify(bad))
  }
})

test('normalize fills a missing origin with the policy, on items with and without an id, in every section', () => {
  const text = state({
    now: open('n', { id: A, origin: null }),
    backlog: [...open('b1', { origin: null }), ...open('b2', { id: B, origin: 'bootstrap' })],
    done: doneItem('d', { id: C, origin: null }),
  })
  const plan = planNormalize(text, { known: new Set() })
  const st = parseState(applyEdits(text, plan.edits))
  assert.deepEqual(st.items.map(i => [i.title, i.origin]), [['n', 'unknown'], ['b1', 'unknown'], ['b2', 'bootstrap'], ['d', 'unknown']])
  const minted = st.items.find(i => i.title === 'b1').id
  assert.deepEqual(plan.minted, [minted])
  assert.deepEqual(plan.origins.sort(), [A, C, minted].sort())
  // Another policy is a parameter.
  const human = planNormalize(text, { known: new Set(), missingOrigin: 'human' })
  assert.deepEqual(parseState(applyEdits(text, human.edits)).items.map(i => i.origin), ['human', 'human', 'bootstrap', 'human'])
  // Only bootstrap, human or unknown can be a policy.
  for (const bad of [`loop from ${A}`, 'nobody', '']) assert.throws(() => planNormalize(text, { missingOrigin: bad }), /missingOrigin/)
})

test('the id goes first and the origin second under the header; an existing id keeps its place', () => {
  const text = state({ backlog: [...open('b1', { origin: null, notes: 'n' }), ...open('b2', { id: B, origin: null, notes: 'n' })] })
  const after = applyEdits(text, planNormalize(text, { known: new Set() }).edits)
  const st = parseState(after)
  assert.deepEqual(st.items.map(i => i.fields.map(f => f.label)), [['id', 'origin', 'notes'], ['id', 'origin', 'notes']])
})

test('an invalid origin parks the item and still holds the parents its tokens name', () => {
  for (const raw of [`loop from ${B} (copied)`, `Loop From ${B.toUpperCase()}`, `from ${B}`]) {
    const st = parseState(state({ backlog: [...open('child', { id: A, origin: raw }), ...open('other', { id: C, blockedBy: B })], done: doneItem('parent', { id: B }) }))
    const child = st.items[0]
    assert.ok(child.problems.some(p => p.kind === 'invalid-origin'), raw)
    assert.deepEqual(child.originParents, [B])
    const rows = eligibility(st, { ledger: ledger(), level: 3 })
    assert.deepEqual(rows.map(r => r.reason), ['invalid-origin', 'blocked'], raw)
    assert.equal(blockerStatus(st, B, ledger()), 'unfinished')
  }
  // normalize never rewrites it.
  const text = state({ backlog: open('child', { id: A, origin: 'robot' }) })
  assert.deepEqual(planNormalize(text, { known: new Set() }).edits, [])
})

test('a doubled origin is duplicate-field, and every value\'s parents count', () => {
  const text = state({
    backlog: [...open('child', { id: A, origin: `loop from ${B}`, extra: [`  - origin: loop from ${C}`] }), ...open('dep', { id: D, blockedBy: C })],
    done: [...doneItem('p1', { id: B }), ...doneItem('p2', { id: C })],
  })
  const st = parseState(text)
  assert.ok(st.items[0].problems.some(p => p.kind === 'duplicate-field'))
  assert.deepEqual(st.items[0].originParents, [B, C])
  assert.equal(blockerStatus(st, B, ledger()), 'unfinished')
  assert.equal(blockerStatus(st, C, ledger()), 'unfinished')
  assert.deepEqual(eligibility(st, { ledger: ledger(), level: 3 }).map(r => r.reason), ['duplicate-field', 'blocked'])
})
