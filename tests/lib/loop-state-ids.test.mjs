// tests/lib/loop-state-ids.test.mjs
// Item ids (stage 0c-3 brief R2, R8): the id shape, minting with an injected byte source,
// hand-made ids, the lowercase rewrite of a copied id, and duplicate ids across sections.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ID_RE, applyEdits, eligibility, itemProblems, mintId, parseState, planNormalize } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, blockedItem, doneItem, ledger, open, rngOf, state } from './loop-state-fixture.mjs'

test('ID_RE: tl- and 8 lowercase Crockford base32 characters, nothing else', () => {
  for (const ok of [A, 'tl-0123456z', 'tl-hjkmnpqr', 'tl-stvwxyz9']) assert.ok(ID_RE.test(ok), ok)
  for (const bad of ['TL-AAAAAAAA', 'tl-AAAAAAAA', 'tl-aaaaaaa', 'tl-aaaaaaaaa', 'tl-iaaaaaaa', 'tl-laaaaaaa', 'tl-oaaaaaaa',
    'tl-uaaaaaaa', 'tl_aaaaaaaa', ' tl-aaaaaaaa', 'tl-aaaaaaaa ', 'xtl-aaaaaaaa', 'tl-aaaa/aaa', 'tl-aaaa|aaa', '-tl-aaaaaaa', 'my-task', '']) {
    assert.ok(!ID_RE.test(bad), bad)
  }
})

test('mintId: 40 bits as 8 base32 digits, most significant first', () => {
  assert.equal(mintId(new Set(), rngOf([[0, 0, 0, 0, 0]])), 'tl-00000000')
  assert.equal(mintId(new Set(), rngOf([[0, 0, 0, 0, 1]])), 'tl-00000001')
  assert.equal(mintId(new Set(), rngOf([[0, 0, 0, 0, 32]])), 'tl-00000010')
  assert.equal(mintId(new Set(), rngOf([[255, 255, 255, 255, 255]])), 'tl-zzzzzzzz')
  // The rng is asked for exactly five bytes.
  const sizes = []
  mintId(new Set(), n => (sizes.push(n), Buffer.alloc(n)))
  assert.deepEqual(sizes, [5])
})

test('mintId redraws while the id is known (a Set or any iterable)', () => {
  const draws = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]
  assert.equal(mintId(new Set(['tl-00000000', 'tl-00000001']), rngOf(draws)), 'tl-00000002')
  assert.equal(mintId(['tl-00000000'], rngOf(draws)), 'tl-00000001')
  assert.throws(() => mintId(new Set(['tl-00000000']), () => Buffer.alloc(5)), /1000 draws/)
})

test('mintId: 10,000 mints into a growing known set are unique and all match ID_RE', () => {
  const known = new Set()
  for (let i = 0; i < 10000; i++) {
    const id = mintId(known)
    assert.ok(ID_RE.test(id), id)
    assert.ok(!known.has(id))
    known.add(id)
  }
  assert.equal(known.size, 10000)
})

test('normalize never mints an id STATE.md or the ledger already knows', () => {
  const text = state({ backlog: open('new item', { origin: 'human' }), lastRun: ['noted tl-00000001 earlier'] })
  const rng = rngOf([[0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]])
  // tl-00000000 is a ledger id; tl-00000001 appears in ## Last run.
  const plan = planNormalize(text, { known: new Set(['tl-00000000']), rng })
  assert.deepEqual(plan.minted, ['tl-00000002'])
  const after = parseState(applyEdits(text, plan.edits))
  assert.equal(after.items[0].id, 'tl-00000002')
})

test('a hand-made id is invalid-id: never picked and never re-minted over', () => {
  for (const v of ['my-task', 'tl-abc', 'tl-iiiiiiii', 'TASK-1', `${A} extra`]) {
    const text = state({ backlog: open('t', { id: v }) })
    const st = parseState(text)
    assert.ok(st.items[0].problems.some(p => p.kind === 'invalid-id'), v)
    const [row] = eligibility(st, { ledger: ledger(), level: 3 })
    assert.equal(row.ok, false)
    assert.equal(row.reason, 'invalid-id')
    const plan = planNormalize(text, { known: new Set() })
    assert.deepEqual(plan.minted, [], v)
    assert.deepEqual(plan.edits, [], v)
  }
})

test('an upper-case copy of an id is read case-insensitively and rewritten to lowercase', () => {
  const text = state({ backlog: [...open('t', { id: A.toUpperCase() })] })
  const st = parseState(text)
  assert.equal(st.items[0].id, A)
  assert.deepEqual(st.items[0].problems, [])
  const plan = planNormalize(text, { known: new Set() })
  assert.deepEqual(plan.minted, [])
  const after = applyEdits(text, plan.edits)
  assert.ok(after.includes(`  - id: ${A}\n`))
  assert.ok(!after.includes(A.toUpperCase()))
  assert.deepEqual(planNormalize(after, { known: new Set() }).edits, [])
})

test('the same id on two items parks every carrier, in any sections, Done included', () => {
  const combos = [
    { backlog: [...open('a', { id: A }), ...open('b', { id: A })] },
    { backlog: open('a', { id: A }), blocked: blockedItem('b', { id: A }) },
    { backlog: open('a', { id: A }), done: doneItem('b', { id: A }) },
    { blocked: blockedItem('a', { id: A }), done: doneItem('b', { id: A }) },
  ]
  for (const c of combos) {
    const st = parseState(state(c))
    const rows = itemProblems(st, ledger()).filter(r => r.kind === 'duplicate-id')
    assert.equal(rows.length, 2, JSON.stringify(c))
    for (const r of rows) {
      assert.equal(r.id, A)
      assert.match(r.detail, /line \d+/)
    }
    for (const row of eligibility(st, { ledger: ledger(), level: 3 })) assert.equal(row.reason, 'duplicate-id')
  }
  // Three carriers: each is parked; other items are not.
  const st = parseState(state({ backlog: [...open('a', { id: A }), ...open('b', { id: A }), ...open('c', { id: B })], done: doneItem('d', { id: A }) }))
  const rows = eligibility(st, { ledger: ledger(), level: 3 })
  assert.deepEqual(rows.map(r => [r.title, r.ok, r.reason]), [['a', false, 'duplicate-id'], ['b', false, 'duplicate-id'], ['c', true, null]])
})

test('the interrupted-move copy in ## Now is not a duplicate id: the recovery planner resolves it first', () => {
  const st = parseState(state({ now: open('a', { id: A }), backlog: [...open('a', { id: A }), ...open('c', { id: C })] }))
  const kinds = itemProblems(st, ledger()).map(r => r.kind)
  assert.ok(!kinds.includes('duplicate-id'))
  assert.ok(!kinds.includes('duplicate-title'))
  // Two copies besides ## Now are duplicates again.
  const st3 = parseState(state({ now: open('a', { id: A }), backlog: open('a', { id: A }), blocked: blockedItem('a', { id: A }) }))
  assert.equal(itemProblems(st3, ledger()).filter(r => r.kind === 'duplicate-id').length, 3)
})
