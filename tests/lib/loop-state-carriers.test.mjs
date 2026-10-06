// tests/lib/loop-state-carriers.test.mjs
// Open copies count even when they do not parse (fix manifest R28; Claude LR07-A, Codex g1#1,
// g2#2): every id token on an id-like line (an `id` label in any case or indent) inside
// `## Now`, `## Backlog` or `## Blocked` is an open carrier, in parsed items, malformed lines and
// unparsed blocks alike, and every token on an origin-like line is a parent. A blocker with
// such a carrier is unfinished; idCarriers reports the raw carriers next to the parsed ones so
// digest and check --item can refuse an ambiguous id.
import test from 'node:test'
import assert from 'node:assert/strict'
import { blockerStatus, eligibility, idCarriers, parseState, planPick } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, F, SEP, doneItem, ledger, open, state } from './loop-state-fixture.mjs'

const dep = () => open('dependent', { id: D, blockedBy: B })
const pick = (text, L) => planPick(text, { ledger: L, level: 3 })
const reasonOf = (st, L) => eligibility(st, { ledger: L, level: 3 }).find(r => r.id === D).reason

test('LR07-A: a Done block pasted back into ## Backlog unchanged holds its dependent', () => {
  // B was finished by the loop (the ledger records it done); the owner reopened it by moving
  // its whole Done block, header included, into the Backlog.
  const L = ledger({ done: [B] })
  const text = state({ backlog: [...doneItem('the blocker', { id: B }), ...dep()] })
  const st = parseState(text)
  assert.deepEqual(st.problems.filter(p => p.kind === 'unparsed-line').map(p => p.section), ['Backlog'])
  assert.equal(blockerStatus(st, B, L), 'unfinished')
  assert.equal(reasonOf(st, L), 'blocked')
  const plan = pick(text, L)
  assert.equal(plan.state, 'dry')
  assert.deepEqual(plan.skipped.map(s => s.reason), ['unparsed-line', 'blocked'])
})

test('LR07-A variants: a damaged id line, a hand-ticked follow-up, a capitalized Origin line', () => {
  const L = ledger({ done: [B] })
  const cases = {
    // (1) the reopened B's id line is damaged: invalid-id, id null, the token still carries B.
    'damaged id': state({ backlog: [...open('the blocker', { id: `${B} (reopened)` }), ...dep()], done: doneItem('old', { id: C }) }),
    // (2) analysis B is done; its open follow-up F has a hand-ticked header in the Backlog.
    'ticked follow-up': state({
      backlog: [`- [x] follow-up${SEP}class: hard`, `  - id: ${F}`, `  - origin: loop from ${B}`, ...dep()],
      done: doneItem('analysis', { id: B, sha: null }),
    }),
    // (3) F's origin line is malformed (a capital O), so it is not a field; its parent holds.
    'Origin capitalized': state({
      backlog: [...open('follow-up', { id: F, origin: undefined, extra: [`  - Origin: loop from ${B}`] }), ...dep()],
      done: doneItem('analysis', { id: B, sha: null }),
    }),
  }
  for (const [name, text] of Object.entries(cases)) {
    const st = parseState(text)
    assert.equal(blockerStatus(st, B, L), 'unfinished', name)
    assert.equal(reasonOf(st, L), 'blocked', name)
    assert.notEqual(pick(text, L).id, D, name)
  }
})

test('Codex g1#1: a reopened blocker with two identical id lines holds its dependent', () => {
  const L = ledger({ done: [A] })
  const text = state({ backlog: [...open('dependent', { id: D, blockedBy: A }), ...open('reopened', { id: A, extra: [`  - id: ${A}`] })] })
  const st = parseState(text)
  assert.equal(st.items.find(i => i.title === 'reopened').id, null)
  assert.equal(blockerStatus(st, A, L), 'unfinished')
  assert.equal(pick(text, L).state, 'dry')
})

test('Codex g2#2: an open copy carrying two ids holds dependents of both', () => {
  const text = state({
    backlog: [...open('dependent', { id: D, blockedBy: A }), ...open('copy', { id: A, extra: [`  - id: ${B}`] })],
    done: doneItem('a', { id: A }),
  })
  const st = parseState(text)
  assert.equal(blockerStatus(st, A, ledger()), 'unfinished')
  assert.equal(blockerStatus(st, B, ledger({ done: [B] })), 'unfinished')
  assert.equal(pick(text, ledger()).state, 'dry')
})

test('a raw carrier makes a blocker known, not unknown; raw lines in ## Done never finish it', () => {
  // Only an unparsed Backlog block carries B: it is open, so the dependent waits as blocked.
  const st = parseState(state({ backlog: [`- [x] reopened${SEP}abc1234${SEP}2026-10-01`, `  - ID: ${B}`, ...dep()] }))
  assert.equal(blockerStatus(st, B, ledger()), 'unfinished')
  assert.equal(reasonOf(st, ledger()), 'blocked')
  // An unparsed Done block is not a Done entry: with no ledger row, B is not finished.
  const st2 = parseState(state({ backlog: dep(), done: [`- [x] no date${SEP}abc1234`, `  - id: ${B}`] }))
  assert.equal(blockerStatus(st2, B, ledger()), 'unfinished')
})

test('a parsed item whose id a raw line elsewhere also carries is a duplicate-id', () => {
  const st = parseState(state({ backlog: [...open('real', { id: A }), `- [x] pasted${SEP}abc1234${SEP}2026-10-01`, `  - id: ${A}`] }))
  const row = eligibility(st, { ledger: ledger(), level: 3 }).find(r => r.id === A)
  assert.equal(row.reason, 'duplicate-id')
})

test('idCarriers: the parsed items carrying an id and every raw line carrying it, in every item section', () => {
  const text = state({
    now: open('now copy', { id: C }),
    backlog: [...open('reopened', { id: A, extra: [`  - id: ${B}`] }), `- [x] pasted${SEP}abc1234${SEP}2026-10-01`, `  - Id: ${A}`],
    done: [...doneItem('a', { id: A }), `- [x] no date${SEP}abc1234`, `  - id: ${C}`],
  })
  const st = parseState(text)
  const lines = text.split('\n')
  const at = s => lines.indexOf(s) + 1
  const a = idCarriers(st, A)
  assert.deepEqual(a.parsed.map(i => [i.section, i.title]), [['Done', 'a']])
  assert.deepEqual(a.raw, [{ section: 'Backlog', line: at(`  - id: ${A}`) }, { section: 'Backlog', line: at(`  - Id: ${A}`) }])
  assert.deepEqual(idCarriers(st, B).raw, [{ section: 'Backlog', line: at(`  - id: ${B}`) }])
  const c = idCarriers(st, C.toUpperCase())
  assert.deepEqual(c.parsed.map(i => i.section), ['Now'])
  assert.deepEqual(c.raw, [{ section: 'Done', line: lines.lastIndexOf(`  - id: ${C}`) + 1 }])
  // An item's own valid id line is a parsed carrier, never a raw one.
  assert.deepEqual(idCarriers(parseState(state({ backlog: open('x', { id: A }) })), A).raw, [])
  assert.deepEqual(idCarriers(st, 'not an id'), { parsed: [], raw: [] })
})
