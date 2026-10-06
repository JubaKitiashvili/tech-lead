// tests/lib/loop-state-titles.test.mjs
// Titles (stage 0c-3 brief R7): normTitle shares loop-text's fold, duplicate open titles park
// every member, a Done title may repeat any title, and the loop's own suffix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { neutralLine } from '../../scripts/loop-text.mjs'
import { applyEdits, eligibility, fold, itemProblems, normTitle, parseState, planFollowup } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, blockedItem, doneItem, ledger, open, state } from './loop-state-fixture.mjs'

const cp = (...n) => String.fromCodePoint(...n)

test('normTitle: the shared fold, lower case, whitespace runs to one space, trimmed', () => {
  assert.equal(normTitle('  Fix   the\tParser  '), 'fix the parser')
  // Default_Ignorable code points (zero-width space, soft hyphen, word joiner, CGJ) go.
  const hidden = `Fix${cp(0x200b)} the Pa${cp(0xad)}r${cp(0x2060)}s${cp(0x34f)}er`
  assert.equal(normTitle(hidden), 'fix the parser')
  // Compatibility forms fold (fullwidth letters); NEL and NBSP are whitespace.
  assert.equal(normTitle(`${cp(0xff26)}ix${cp(0x85)}the${cp(0xa0)}parser`), 'fix the parser')
  // It agrees with loop-text's fold: a neutralized title has the key of its input.
  for (const t of [hidden, `${cp(0xff26)}IX  the parser`, 'Plain title', `Caf${cp(0x65, 0x301)}`]) {
    assert.equal(normTitle(neutralLine(t)), normTitle(t), JSON.stringify(t))
    assert.equal(normTitle(t), fold(t).toLowerCase().replace(/\s+/g, ' ').trim())
  }
  // NFKC composes, so a decomposed and a precomposed letter are one title.
  assert.equal(normTitle(`Caf${cp(0x65, 0x301)}`), normTitle(`Caf${cp(0xe9)}`))
})

test('duplicate open titles park every member, across Now, Backlog and Blocked, compared by normTitle', () => {
  const st = parseState(state({
    now: open('Fix the parser', { id: A }),
    backlog: [...open('fix  THE parser', { id: B }), ...open('other', { id: C })],
    blocked: blockedItem(`fix the${cp(0x200b)} parser`, { id: D }),
  }))
  const rows = itemProblems(st, ledger()).filter(r => r.kind === 'duplicate-title')
  assert.deepEqual(rows.map(r => r.id).sort(), [A, B, D].sort())
  for (const r of rows) for (const other of [A, B, D].filter(x => x !== r.id)) assert.ok(r.detail.includes(other), r.detail)
  assert.deepEqual(eligibility(st, { ledger: ledger(), level: 3 }).map(r => [r.title, r.reason]), [['fix  THE parser', 'duplicate-title'], ['other', null]])
})

test('a Done title may repeat any title, open or done', () => {
  const st = parseState(state({
    backlog: open('fix the parser', { id: A }),
    done: [...doneItem('fix the parser', { id: B }), ...doneItem('Fix The Parser', { id: C })],
  }))
  assert.ok(!itemProblems(st, ledger()).some(r => r.kind === 'duplicate-title'))
  assert.equal(eligibility(st, { ledger: ledger(), level: 3 })[0].ok, true)
})

test('a follow-up whose title collides with an open title gets its own id as a suffix', () => {
  const text = state({ now: open('analyse the cache', { id: A, cls: 'hard' }), backlog: open('Implement the cache', { id: B }) })
  const plan = planFollowup(text, { parent: A, title: 'implement  the cache', notes: '', known: new Set() })
  const st = parseState(applyEdits(text, plan.edits))
  const made = st.items.find(i => i.id === plan.id)
  assert.equal(made.title, `implement the cache (${plan.id})`)
  assert.ok(!itemProblems(st, ledger()).some(r => r.kind === 'duplicate-title'))
})
