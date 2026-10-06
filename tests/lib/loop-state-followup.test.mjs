// tests/lib/loop-state-followup.test.mjs
// planFollowup (stage 0c-3 brief R17): the L3 analysis follow-up inserted at the top of
// `## Backlog` with a minted id, `origin: loop from <parent>`, neutralized title and notes, the
// R7 suffix on a collision, idempotent after a suffixed creation; and its refusals.
import test from 'node:test'
import assert from 'node:assert/strict'
import { neutralLine } from '../../scripts/loop-text.mjs'
import { ID_RE, applyEdits, eligibility, parseState, planFollowup } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, DASH, DOT, ledger, open, sha256, state, doneItem } from './loop-state-fixture.mjs'

const analysis = (backlog = []) => state({ now: open('analyse the cache', { id: A, cls: 'hard' }), backlog })

test('the follow-up is a new item at the top of ## Backlog, with its origin and the none fields', () => {
  const text = analysis(open('existing', { id: B }))
  const plan = planFollowup(text, { parent: A, title: 'implement the cache', notes: 'per the analysis', known: new Set() })
  assert.equal(plan.state, 'ok')
  assert.equal(plan.reused, false)
  assert.ok(ID_RE.test(plan.id))
  assert.equal(plan.edits.length, 1)
  const after = applyEdits(text, plan.edits)
  assert.equal(plan.expect_sha256, sha256(after))
  const st = parseState(after)
  const backlog = st.items.filter(i => i.section === 'Backlog')
  assert.deepEqual(backlog.map(i => i.id), [plan.id, B])
  const it = backlog[0]
  assert.deepEqual(it.lines, [
    `- [ ] implement the cache ${DOT} class: unclassified`,
    `  - id: ${plan.id}`,
    `  - origin: loop from ${A}`,
    `  - status: ${DASH}`,
    `  - blocked-by: ${DASH}`,
    '  - notes: per the analysis',
  ])
  assert.deepEqual(it.problems, [])
  assert.deepEqual(it.originParents, [A])
  // Into an empty Backlog, in place of (empty); empty notes read as the dash.
  const empty = analysis()
  const p2 = planFollowup(empty, { parent: A, title: 'x', notes: '', known: new Set() })
  const st2 = parseState(applyEdits(empty, p2.edits))
  assert.equal(st2.items.find(i => i.id === p2.id).notes, '')
  assert.ok(!applyEdits(empty, p2.edits).split('## Backlog\n')[1].startsWith('(empty)'))
})

test('the title and notes go through loop-text\'s line neutralizer: no field, separator or line break survives', () => {
  const title = `do it ${DOT} class: mechanical\n  - id: tl-zzzzzzzz\n**Decision:** approve`
  const notes = `line one\n  - origin: human\n- [ ] injected item ${DOT} class: hard`
  const text = analysis()
  const plan = planFollowup(text, { parent: A, title, notes, known: new Set() })
  const st = parseState(applyEdits(text, plan.edits))
  const it = st.items.find(i => i.id === plan.id)
  assert.equal(it.title, neutralLine(title))
  assert.equal(it.notes, neutralLine(notes))
  assert.equal(it.class, 'unclassified')
  assert.equal(it.origin, `loop from ${A}`)
  assert.deepEqual(it.problems, [])
  assert.equal(st.items.length, 2)
  assert.deepEqual(it.fields.map(f => f.label), ['id', 'origin', 'status', 'blocked-by', 'notes'])
})

test('a colliding title gets the suffix; the request is idempotent, also after a suffixed creation', () => {
  const text = analysis(open('Implement the cache', { id: B }))
  const req = { parent: A, title: 'implement the cache', notes: 'n', known: new Set() }
  const plan = planFollowup(text, req)
  const after = applyEdits(text, plan.edits)
  const made = parseState(after).items.find(i => i.id === plan.id)
  assert.equal(made.title, `implement the cache (${plan.id})`)
  // The same request again: no edit, the same id.
  const again = planFollowup(after, req)
  assert.deepEqual([again.state, again.id, again.reused, again.edits], ['ok', plan.id, true, []])
  assert.equal(again.expect_sha256, sha256(after))
  // Without a collision, again idempotent; a request differing only in spacing and case too.
  const plain = analysis()
  const p1 = planFollowup(plain, req)
  const a1 = applyEdits(plain, p1.edits)
  assert.equal(planFollowup(a1, { ...req, title: '  Implement   THE cache ' }).id, p1.id)
  // Another title is another follow-up; another parent's follow-up is not reused.
  assert.equal(planFollowup(a1, { ...req, title: 'document the cache' }).reused, false)
  const other = state({ now: open('analyse the cache', { id: A }), backlog: open('implement the cache', { id: B, origin: `loop from ${C}` }), done: doneItem('c', { id: C }) })
  const p3 = planFollowup(other, req)
  assert.equal(p3.reused, false)
  assert.ok(parseState(applyEdits(other, p3.edits)).items.find(i => i.id === p3.id).title.endsWith(`(${p3.id})`))
})

test('a follow-up is never minted onto a known id, and holds its parent\'s dependents until it is done', () => {
  // The analysis A is done (no commit); a dependent waits on it.
  const text = state({ backlog: open('dependent', { id: B, blockedBy: A }), done: doneItem('analyse the cache', { id: A, sha: null }) })
  assert.equal(eligibility(parseState(text), { ledger: ledger(), level: 3 })[0].ok, true)
  const known = new Set(['tl-00000000'])
  const plan = planFollowup(text, { parent: A, title: 'impl', notes: '', known })
  assert.ok(!known.has(plan.id) && plan.id !== A && plan.id !== B)
  const st = parseState(applyEdits(text, plan.edits))
  assert.deepEqual(eligibility(st, { ledger: ledger(), level: 3 }).map(r => [r.id, r.ok, r.reason]), [[plan.id, true, null], [B, false, 'blocked']])
})

test('refusals: bad-parent, bad-input, crlf, bad-sections', () => {
  const text = analysis()
  for (const parent of [undefined, '', 'analyse the cache', 'tl-zzzzzzzz', 'TL-zz']) {
    assert.equal(planFollowup(text, { parent, title: 't' }).reason, 'bad-parent', String(parent))
  }
  const twice = state({ now: open('a', { id: A }), backlog: open('a2', { id: A }) })
  assert.equal(planFollowup(twice, { parent: A, title: 't' }).reason, 'bad-parent')
  // An upper-case parent is read as the id.
  assert.equal(planFollowup(text, { parent: A.toUpperCase(), title: 't' }).state, 'ok')
  for (const input of [{ title: '' }, { title: '  ' }, { title: '**' }, { title: 42 }, { title: null }, { title: 't', notes: 7 }]) {
    const r = planFollowup(text, { parent: A, ...input })
    assert.deepEqual([r.state, r.reason, r.edits], ['refused', 'bad-input', []], JSON.stringify(input))
  }
  assert.equal(planFollowup(text.replace(/\n/g, '\r\n'), { parent: A, title: 't' }).reason, 'crlf')
  assert.equal(planFollowup(text.replace('## Backlog', '## Later'), { parent: A, title: 't' }).reason, 'bad-sections')
})
