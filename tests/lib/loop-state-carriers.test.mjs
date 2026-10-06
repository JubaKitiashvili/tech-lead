// tests/lib/loop-state-carriers.test.mjs
// Open copies count even when they do not parse (fix manifest R28; Claude LR07-A, Codex g1#1,
// g2#2): every id token on an id-like line (an `id` label in any case or indent) inside
// `## Now`, `## Backlog` or `## Blocked` is an open carrier, in parsed items, malformed lines and
// unparsed blocks alike, and every token on an origin-like line is a parent. A blocker with
// such a carrier is unfinished; idCarriers reports the raw carriers next to the parsed ones so
// digest and check --item can refuse an ambiguous id. Closing fixes: the like-tests read
// near-miss labels (markup, a missing colon, `=` and `-`) and a column-0 field line joins the
// item above it (F2); id lines under a `##` section outside the template (F13) and an item
// unticked in place inside `## Done` (F14) are open carriers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, blockerStatus, eligibility, idCarriers, idLikeLine, originLikeLine, parseState, planNormalize, planPick } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, DASH, E, F, SEP, doneItem, ledger, open, state } from './loop-state-fixture.mjs'

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

// Closing fix F2 (Codex g1#3, Opus I1, code-review #6): the exported like-tests loop-recover
// shares. A label in any case or indent, after an optional list marker, with inline markup
// around it; then a colon or `=`, or (with an id token on the line) `-` or a space.
test('F2: idLikeLine and originLikeLine read near-miss labels, and nothing else', () => {
  const FW = String.fromCodePoint(0xff29, 0xff24, 0xff1a) // fullwidth "ID:"
  const ids = [
    `  - id: ${A}`, `  - **id:** ${A}`, `  - **id**: ${A}`, `  - *id*: ${A}`, `  - \`id\`: ${A}`, `  - __ID__: ${A}`,
    `  - id ${A}`, `  - id = ${A}`, `  - id - ${A}`, `  - id=${A}`, `\t* Id:${A}`, `- id: ${A}`, `id ${A}`,
    '  - id: (lost)', '  - id =', `  - ${FW} ${A}`, `      ID  ${A.toUpperCase()}`,
  ]
  const origins = [
    '  - origin: human', `  - **origin:** loop from ${A}`, `  - origin loop from ${A}`, '  - Origin = human',
    `  - origin - loop from ${A}`, 'origin: unknown', `  - \`origin\`: loop from ${A}`,
  ]
  const neither = [
    '  - identity: x', '  - idea: y', `  - notes: id ${A}`, '  - id the thing', '  - origin of the bug is the cache',
    '  - originally: x', `- [ ] id ${A}${SEP}class: hard`, `    the id ${A}`, `  - blocked-by: ${A}`, '', 'plain text',
  ]
  for (const l of ids) assert.deepEqual([idLikeLine(l), originLikeLine(l)], [true, false], JSON.stringify(l))
  for (const l of origins) assert.deepEqual([idLikeLine(l), originLikeLine(l)], [false, true], JSON.stringify(l))
  for (const l of neither) assert.deepEqual([idLikeLine(l), originLikeLine(l)], [false, false], JSON.stringify(l))
})

test('Codex g1#3, Opus I1: a reopened blocker whose id line lost its colon or carries markup holds its dependent, before and after normalize', () => {
  const L = ledger({ done: [A] })
  for (const idLine of [`  - **id:** ${A}`, `  - id ${A}`, `  - id = ${A}`, `  - id - ${A}`, `  - \`id\`: ${A}`]) {
    const text = state({ backlog: [`- [ ] reopened${SEP}class: hard`, idLine, '  - origin: human', ...open('dependent', { id: D, blockedBy: A })] })
    const plan = planNormalize(text, { known: new Set(), ledger: L })
    assert.deepEqual([plan.minted, plan.edits], [[], []], idLine)
    assert.ok(plan.problems.some(p => p.title === 'reopened' && p.kind === 'malformed-field'), idLine)
    const st = parseState(text)
    assert.equal(idCarriers(st, A).raw.length, 1, idLine)
    assert.equal(blockerStatus(st, A, L), 'unfinished', idLine)
    assert.notEqual(pick(text, L).id, D, idLine)
  }
  // An open follow-up of done analysis A whose origin line lost its colon: no origin is filled
  // over it, and A stays unfinished while the follow-up is open.
  for (const originLine of [`  - origin loop from ${A}`, `  - **origin:** loop from ${A}`, `  - origin = loop from ${A}`, `  - origin - loop from ${A}`]) {
    const text = state({
      backlog: [`- [ ] follow-up${SEP}class: hard`, `  - id: ${F}`, originLine, ...open('dependent', { id: D, blockedBy: A })],
      done: doneItem('analysis', { id: A, sha: null }),
    })
    const plan = planNormalize(text, { known: new Set(), ledger: L })
    assert.deepEqual([plan.origins, plan.edits], [[], []], originLine)
    const after = applyEdits(text, plan.edits)
    assert.equal(blockerStatus(parseState(after), A, L), 'unfinished', originLine)
    assert.notEqual(pick(after, L).id, D, originLine)
  }
})

test('Codex g1#2: a column-0 field line right after an item joins it as malformed-field; its ids and parents count', () => {
  // The dependent's blocker line is outdented: the dependent parks instead of running while A
  // is open.
  const text = state({ backlog: [...open('blocker', { id: A, status: 'waiting-infra' }), ...open('dependent', { id: D }), `- blocked-by: ${A}`] })
  const st = parseState(text)
  assert.deepEqual(st.problems, [])
  const d = st.items.find(i => i.id === D)
  assert.deepEqual(d.problems.map(p => p.kind), ['malformed-field'])
  assert.equal(d.lines.at(-1), `- blocked-by: ${A}`)
  assert.equal(pick(text, ledger()).state, 'dry')
  // An outdented origin on a Done intermediary keeps the chain P -> F -> G (open).
  const chain = state({
    backlog: [...open('G', { id: E, origin: `loop from ${F}` }), ...open('X', { id: D, blockedBy: A })],
    done: [...doneItem('F', { id: F, origin: null }), `- origin: loop from ${A}`, ...doneItem('P', { id: A })],
  })
  const L = ledger({ done: [A, F] })
  assert.equal(blockerStatus(parseState(chain), A, L), 'unfinished')
  assert.notEqual(pick(chain, L).id, D)
  // Every field-looking form joins (a bare label, markup, a capital, the like-tests' forms) with
  // the indented lines under it; normalize mints and fills nothing over a column-0 id or origin.
  for (const extra of [[`id: ${A}`], [`- **id:** ${A}`], [`- ID ${A}`], ['- Notes: more', '  text under it'], [`* origin: loop from ${B}`]]) {
    const one = state({ backlog: [`- [ ] reopened${SEP}class: hard`, ...extra, ...open('next', { id: C })] })
    const s1 = parseState(one)
    assert.deepEqual([s1.problems, s1.items.map(i => i.title)], [[], ['reopened', 'next']], extra[0])
    assert.deepEqual(s1.items[0].lines.slice(1), extra, extra[0])
    assert.ok(s1.items[0].problems.some(p => p.kind === 'malformed-field'), extra[0])
  }
  const lone = state({ backlog: [`- [ ] reopened${SEP}class: hard`, `- id: ${A}`, `- origin: loop from ${B}`] })
  assert.deepEqual(planNormalize(lone, { known: new Set() }).edits, [])
  // After a blank line, or a list line that is not a field, a block of its own starts.
  const apart = parseState(state({ backlog: [...open('x', { id: A }), '', `- blocked-by: ${B}`, ...open('y', { id: C }), '- [x] ticked'] }))
  assert.deepEqual(apart.items.map(i => i.problems), [[], []])
  assert.deepEqual(apart.problems.map(p => [p.kind, p.text]), [['unparsed-line', `- blocked-by: ${B}`], ['unparsed-line', '- [x] ticked']])
})

// Closing fix F13 (Opus M2): a person parks an item under a `##` section the template does not
// have; its id lines are open carriers (cautious) and its origin lines name parents.
test('F13: id lines under a ## section outside the template are open carriers', () => {
  const L = ledger({ done: [A, B] })
  const text = state({ backlog: open('dependent', { id: D, blockedBy: A }), done: [...doneItem('analysis', { id: A, sha: null }), ...doneItem('b', { id: B })] })
    .replace('## Needs decision', `## Later\n- [ ] follow-up${SEP}class: hard\n  - id: ${F}\n  - origin: loop from ${A}\n- reopened\n  - ID: ${B}\nsee ${C} in the notes\n\n## Needs decision`)
  const st = parseState(text)
  assert.deepEqual(st.others.map(o => [o.section, o.lines.length, o.lines[0]]), [['Later', 3, `- [ ] follow-up${SEP}class: hard`], ['Later', 2, '- reopened'], ['Later', 1, `see ${C} in the notes`]])
  assert.deepEqual(st.problems, [])
  assert.equal(blockerStatus(st, A, L), 'unfinished')
  assert.equal(blockerStatus(st, B, L), 'unfinished')
  assert.equal(blockerStatus(st, C, ledger({ done: [C] })), 'finished')
  const lines = text.split('\n')
  assert.deepEqual(idCarriers(st, F).raw, [{ section: 'Later', line: lines.indexOf(`  - id: ${F}`) + 1 }])
  assert.deepEqual(idCarriers(st, B).raw, [{ section: 'Later', line: lines.indexOf(`  - ID: ${B}`) + 1 }])
  assert.equal(pick(text, L).state, 'dry')
  // A section of the template holding no items (Last run) is not one of them.
  const lr = parseState(state({ backlog: open('dependent', { id: D, blockedBy: B }), done: doneItem('b', { id: B }), lastRun: [`  - id: ${B}`] }))
  assert.equal(blockerStatus(lr, B, ledger()), 'finished')
})

// Closing fix F14 (Opus M3): unticking a Done item in place (`- [ ] ...` left in `## Done`) reopens
// it: its id lines are open carriers, so its dependents wait though the ledger records it done.
test('F14: a - [ ] block inside ## Done is open', () => {
  const L = ledger({ done: [A] })
  const text = state({ backlog: open('dependent', { id: D, blockedBy: A }), done: [`- [ ] the blocker${SEP}abc1234${SEP}2026-10-01`, `  - id: ${A}`, '  - origin: human'] })
  const st = parseState(text)
  assert.equal(blockerStatus(st, A, L), 'unfinished')
  assert.equal(eligibility(st, { ledger: L, level: 3 }).find(r => r.id === D).reason, 'blocked')
  // An unticked follow-up keeps its done parent unfinished.
  const child = parseState(state({
    backlog: open('dependent', { id: D, blockedBy: A }),
    done: [`- [ ] follow-up${SEP}${DASH}${SEP}2026-10-01`, `  - id: ${F}`, `  - origin: loop from ${A}`, ...doneItem('analysis', { id: A, sha: null })],
  }))
  assert.equal(blockerStatus(child, A, ledger({ done: [A, F] })), 'unfinished')
  // Any other unparsed Done block stays closed (a Done entry with no date).
  const other = parseState(state({ backlog: open('dependent', { id: D, blockedBy: A }), done: [`- [x] no date${SEP}abc1234`, `  - id: ${A}`] }))
  assert.equal(blockerStatus(other, A, L), 'finished')
})
