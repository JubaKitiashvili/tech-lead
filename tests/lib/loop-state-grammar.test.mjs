// tests/lib/loop-state-grammar.test.mjs
// The STATE.md item grammar (stage 0c-3 brief section 2, R3, R5, R7, R15): sections, every
// header form, the field rules, unparsed lines, a carriage return, `## Needs decision`
// entries, and a title that survives every section's header form.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers.mjs'
import { FIELD_LABELS, PLACEHOLDER, itemProblems, nowItem, nowLine, parseState } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, DASH, DOT, FILL, SEP, blockedItem, doneItem, entry, open, state } from './loop-state-fixture.mjs'

const kinds = it => it.problems.map(p => p.kind)
const only = (st, section) => st.items.filter(i => i.section === section)

test('FIELD_LABELS is the R22 list, in order, and frozen', () => {
  assert.deepEqual([...FIELD_LABELS], ['id', 'origin', 'class', 'status', 'blocked-by', 'notes', 'decision', 'attempts', 'recovery', 'decided', 'no-change-ok'])
  assert.ok(Object.isFrozen(FIELD_LABELS))
})

test('the STATE.md template in loop-templates.md parses with no problems', () => {
  const md = fs.readFileSync(path.join(ROOT, 'skills/loop/references/loop-templates.md'), 'utf8')
  const m = /## STATE\.md template[\s\S]*?```markdown\n([\s\S]*?)```/.exec(md)
  assert.ok(m, 'no STATE.md template block')
  const st = parseState(m[1])
  assert.deepEqual(st.problems, [])
  assert.deepEqual(Object.keys(st.sections), ['Now', 'Backlog', 'Needs decision', 'Blocked', 'Done', 'Last run'])
  const [it] = only(st, 'Backlog')
  assert.equal(it.priority, 1)
  assert.equal(it.class, 'unclassified')
  assert.equal(it.blockedBy, null)
  assert.equal(it.status, null)
  for (const p of it.problems) assert.ok(!['malformed-field', 'duplicate-field', 'ambiguous-title'].includes(p.kind), p.kind)
})

test('a fixture state round-trips: every section, item and entry is read back', () => {
  const text = state({
    now: open('fix the parser', { id: A, cls: 'hard', p: 1 }),
    backlog: [...open('later work', { id: B, notes: 'context' }), ...open('third', { id: C, p: 3, cls: 'mechanical' })],
    decisions: entry(`${A}${SEP}fix the parser`),
    blocked: blockedItem('stuck', { id: 'tl-dddddddd' }),
    done: doneItem('shipped', { id: 'tl-eeeeeeee' }),
  })
  const st = parseState(text)
  assert.deepEqual(st.problems, [])
  assert.deepEqual(st.items.map(i => [i.section, i.title, i.id]), [
    ['Now', 'fix the parser', A], ['Backlog', 'later work', B], ['Backlog', 'third', C],
    ['Blocked', 'stuck', 'tl-dddddddd'], ['Done', 'shipped', 'tl-eeeeeeee'],
  ])
  for (const it of st.items) assert.deepEqual(it.problems, [], it.title)
  assert.equal(st.entries.length, 1)
  // Line numbers are 1-based and name the header line.
  const lines = text.split('\n')
  for (const it of st.items) assert.equal(lines[it.line - 1], it.header)
  assert.equal(nowItem(text).id, A)
  assert.equal(nowItem(state()), null)
  assert.equal(nowLine(text), st.items[0].header)
})

test('Now and Backlog headers: optional priority, split at the first class separator, optional reason', () => {
  const st = parseState(state({
    backlog: [
      `- [ ] P2${SEP}with priority${SEP}class: hard`,
      `- [ ] no priority${SEP}class: mechanical${SEP}one-line reason${SEP}more`,
      '- [ ] no class at all',
      `- [ ] P10${SEP}a${SEP}b${SEP}class: high-stakes`,
    ],
  }))
  const got = only(st, 'Backlog').map(i => [i.priority, i.title, i.class, i.reason])
  assert.deepEqual(got, [
    [2, 'with priority', 'hard', null],
    [null, 'no priority', 'mechanical', `one-line reason${SEP}more`],
    [null, 'no class at all', 'unclassified', null],
    [10, `a${SEP}b`, 'high-stakes', null],
  ])
})

test('Blocked headers split from the left at the first attempts separator; Done headers from the right', () => {
  const st = parseState(state({
    blocked: [`- [ ] a${SEP}b${SEP}attempts: 2${SEP}verify failed${SEP}twice`, '- [ ] waiting on the vendor'],
    done: [`- [x] x${SEP}y${SEP}abc1234${SEP}2026-10-01`, `- [x] analysis${SEP}${DASH}${SEP}2026-09-30`],
  }))
  assert.deepEqual(only(st, 'Blocked').map(i => [i.title, i.attempts, i.reason]), [
    [`a${SEP}b`, '2', `verify failed${SEP}twice`], ['waiting on the vendor', null, null],
  ])
  assert.deepEqual(only(st, 'Done').map(i => [i.title, i.sha, i.date]), [
    [`x${SEP}y`, 'abc1234', '2026-10-01'], ['analysis', null, '2026-09-30'],
  ])
})

test('a title with separators survives Backlog -> Now -> Blocked -> Done unchanged', () => {
  const title = `rework a ${DOT} b${SEP}and c (part 2)`
  const st = parseState(state({
    now: open(title, { id: A, p: 1, cls: 'hard' }),
    backlog: open(title, { id: A }),
    blocked: blockedItem(title, { id: A }),
    done: doneItem(title, { id: A }),
  }))
  assert.deepEqual(st.items.map(i => i.title), [title, title, title, title])
  for (const it of st.items) assert.ok(!kinds(it).includes('ambiguous-title'))
})

test('ambiguous-title: a P<n> prefix, a class or attempts separator inside, or an empty title', () => {
  const st = parseState(state({
    backlog: [
      `- [ ] P1${SEP}P2${SEP}x${SEP}class: hard`,
      `- [ ] y${SEP}attempts: 3${SEP}class: hard`,
      `- [ ] ${SEP}class: hard`,
    ],
    blocked: [`- [ ] z${SEP}class: hard${SEP}attempts: 1${SEP}r`, `- [ ] P4${SEP}w${SEP}attempts: 1${SEP}r`],
    done: [`- [x] v${SEP}class: hard${SEP}abc1234${SEP}2026-10-01`],
  }))
  for (const it of st.items) assert.ok(kinds(it).includes('ambiguous-title'), it.header)
})

test('fields: a control field is one line; notes and decision take deeper continuation lines', () => {
  const st = parseState(state({
    backlog: [
      `- [ ] t${SEP}class: hard`,
      `  - id: ${A}`,
      '  - origin: human',
      '  - notes: first line',
      '    second line',
      '        third, deeper',
      '  - decision: go',
      '      with the queue',
      '  - custom-label: kept',
      '  - recovery: ' + 'f'.repeat(64),
      '  - decided: stamp',
      '  - no-change-ok: yes',
    ],
  }))
  const [it] = st.items
  assert.deepEqual(it.problems, [])
  assert.equal(it.notes, 'first line\nsecond line\nthird, deeper')
  assert.equal(it.decision, 'go\nwith the queue')
  assert.equal(it.recovery, 'f'.repeat(64))
  assert.equal(it.decided, 'stamp')
  assert.equal(it.noChangeOk, 'yes')
  assert.deepEqual(it.fields.map(f => f.label), ['id', 'origin', 'notes', 'decision', 'custom-label', 'recovery', 'decided', 'no-change-ok'])
  assert.equal(it.fields.find(f => f.label === 'custom-label').value, 'kept')
  // Any indentation of two to four spaces is a field.
  const st4 = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `    - id: ${A}`, '   - status: waiting-level'] }))
  assert.equal(st4.items[0].id, A)
  assert.equal(st4.items[0].status, 'waiting-level')
  assert.deepEqual(st4.items[0].problems, [])
})

test('malformed-field: every near-miss form parks the item', () => {
  const cases = {
    'a tab indent': '\t- status: waiting-level',
    'a star marker': '  * status: waiting-level',
    'a plus marker': '  + status: waiting-level',
    'a capitalized label': '  - Status: waiting-level',
    'no space after the colon': '  - status:waiting-level',
    'five spaces': '     - status: waiting-level',
    'a continuation under a control field': ['  - status: waiting-level', '    more'],
    'an indented line before the first field': ['  context text', '  - status: waiting-level'],
    'a field look-alike as a continuation': ['  - notes: a', `    - id: ${B}`],
    'a continuation after a blank line': ['  - notes: a', '', '    b'],
    'a continuation not deep enough': ['  - notes: a', '   b'],
  }
  for (const [name, lines] of Object.entries(cases)) {
    const st = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, ...[].concat(lines)] }))
    assert.equal(st.items.length, 1, name)
    assert.ok(kinds(st.items[0]).includes('malformed-field'), name)
    assert.match(st.items[0].problems.find(p => p.kind === 'malformed-field').detail, /line \d+/, name)
  }
  // A continuation that does not look like a known field is text, even when it is a list line.
  const ok = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, '  - notes: steps:', '    - step one', '    - other: thing'] }))
  assert.deepEqual(ok.items[0].problems, [])
  assert.equal(ok.items[0].notes, 'steps:\n- step one\n- other: thing')
})

test('duplicate-field: a known field given twice; two id lines are invalid-id', () => {
  for (const label of ['origin', 'class', 'status', 'blocked-by', 'attempts', 'recovery', 'decided', 'no-change-ok', 'notes', 'decision']) {
    const st = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, `  - ${label}: one`, `  - ${label}: two`] }))
    assert.ok(kinds(st.items[0]).includes('duplicate-field'), label)
  }
  const two = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, `  - id: ${A}`] }))
  assert.ok(kinds(two.items[0]).includes('invalid-id'))
  assert.equal(two.items[0].id, null)
  // An unknown label given twice is kept and is no problem.
  const unk = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, '  - extra: 1', '  - extra: 2'] }))
  assert.deepEqual(unk.items[0].problems, [])
})

test('none spellings: blocked-by and status read as none; id with such a value is invalid-id; notes dash reads empty', () => {
  for (const v of ['', DASH, '-', '--', 'none', 'NONE', 'n/a', 'N/A', '  none  ']) {
    const st = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id: ${A}`, `  - blocked-by:${v === '' ? '' : ` ${v}`}`, `  - status: ${v}`] }))
    assert.equal(st.items[0].blockedBy, null, JSON.stringify(v))
    assert.equal(st.items[0].status, null, JSON.stringify(v))
    assert.deepEqual(st.items[0].problems, [], JSON.stringify(v))
  }
  for (const v of ['', DASH, 'none', '-']) {
    const st = parseState(state({ backlog: [`- [ ] t${SEP}class: hard`, `  - id:${v === '' ? '' : ` ${v}`}`] }))
    assert.ok(kinds(st.items[0]).includes('invalid-id'), JSON.stringify(v))
    assert.equal(st.items[0].id, null)
  }
  const st = parseState(state({ backlog: [...open('t', { id: A, notes: DASH, decision: '' })] }))
  assert.equal(st.items[0].notes, '')
  assert.equal(st.items[0].decision, '')
  assert.equal(parseState(state({ backlog: open('t', { id: A }) })).items[0].notes, '')
  // Values are trimmed.
  assert.equal(parseState(state({ backlog: open('t', { id: A, notes: 'x   ', blockedBy: `${B}  ` }) })).items[0].notes, 'x')
})

test('unparsed-line: any other column-0 line in an item section, with its indented lines', () => {
  const text = state({
    backlog: [`- [x] checked in the backlog${SEP}class: hard`, `  - id: ${A}`, '* a star item', 'plain text', '### a heading', '  stray indented'],
    done: [`- [ ] open in done${SEP}abc1234${SEP}2026-10-01`, `- [x] no date${SEP}abc1234`, `- [x] bad date${SEP}abc1234${SEP}2026-1-1`],
  })
  const st = parseState(text)
  assert.equal(st.items.length, 0)
  const lines = text.split('\n')
  const un = st.problems.filter(p => p.kind === 'unparsed-line')
  assert.deepEqual(un.map(p => [p.section, lines[p.line - 1]]), [
    ['Backlog', `- [x] checked in the backlog${SEP}class: hard`], ['Backlog', '* a star item'], ['Backlog', 'plain text'],
    ['Backlog', '### a heading'],
    ['Done', `- [ ] open in done${SEP}abc1234${SEP}2026-10-01`], ['Done', `- [x] no date${SEP}abc1234`],
    ['Done', `- [x] bad date${SEP}abc1234${SEP}2026-1-1`],
  ])
  // `(empty)` and blank lines are ignored; an indented line before any item is unparsed.
  const st2 = parseState(state({ backlog: ['', `  ${PLACEHOLDER}`, '  stray'] }))
  assert.deepEqual(st2.problems.map(p => p.kind), ['unparsed-line'])
})

test('crlf: a text holding a carriage return is refused and nothing else is parsed', () => {
  const text = state({ backlog: open('t', { id: A }) }).replace(/\n/g, '\r\n')
  assert.deepEqual(parseState(text), { sections: {}, items: [], entries: [], problems: [{ kind: 'crlf' }] })
  assert.deepEqual(parseState('## Now\r(empty)\n').problems, [{ kind: 'crlf' }])
  assert.equal(nowItem(text), null)
})

test('sections end at the next level-2 heading (level-1 outside item sections); missing and repeated sections are problems', () => {
  // A level-1 heading inside an item section is a stray-heading and the section goes on (R31).
  const st = parseState(`## Now\n${PLACEHOLDER}\n## Backlog\n${open('t', { id: A }).join('\n')}\n# Other\n- [ ] an item after it\n`)
  assert.deepEqual(st.items.map(i => [i.section, i.title]), [['Backlog', 't'], ['Backlog', 'an item after it']])
  assert.deepEqual(st.problems.map(p => [p.kind, p.name ?? p.section]).sort(), [
    ['missing-section', 'Blocked'], ['missing-section', 'Done'], ['missing-section', 'Last run'], ['missing-section', 'Needs decision'],
    ['stray-heading', 'Backlog'],
  ])
  // Outside an item section it ends the section as before.
  const nd = parseState(`## Needs decision\n# Other\n- [ ] not an entry\n`)
  assert.deepEqual(nd.problems.filter(p => p.kind === 'unparsed-line'), [])
  const dup = parseState(state({ backlog: open('t', { id: A }) }) + `\n## Backlog\n${open('u', { id: B }).join('\n')}\n`)
  assert.deepEqual(dup.problems.map(p => [p.kind, p.name]), [['duplicate-section', 'Backlog']])
  // Items of the repeated section still count (their ids are known).
  assert.deepEqual(dup.items.map(i => i.id), [A, B])
  // A `### ` heading does not end a section; `## Last run` holds no items.
  const lr = parseState(state({ lastRun: ['- [ ] P1 ' + DOT + ' looks like an item ' + DOT + ' class: hard'] }))
  assert.deepEqual(lr.items, [])
  assert.deepEqual(lr.problems, [])
})

test('entries: id headings, legacy headings, variants and the Recovery tuple', () => {
  const st = parseState(state({
    backlog: open('fix the parser', { id: A }),
    decisions: [
      ...entry(`${A}${SEP}fix the parser`),
      ...entry(`${B.toUpperCase()}${SEP}flagged one`, { variant: 'delegate-flagged' }),
      ...entry('an old title heading'),
      ...entry(`${C}${SEP}acceptance`, { variant: 'other' }),
    ],
  }))
  assert.deepEqual(st.entries.map(e => [e.id, e.title, e.legacy, e.variant, e.filled]), [
    [A, 'fix the parser', false, 'panel', false],
    [B, 'flagged one', false, 'delegate-flagged', false],
    [null, 'an old title heading', true, 'panel', false],
    [C, 'acceptance', false, 'other', false],
  ])
  assert.deepEqual(st.entries[1].recovery, { sha: 'a'.repeat(64), base: 'b'.repeat(40), itemDigest: null, scope: 'c'.repeat(64) })
  assert.equal(st.entries[0].recovery, null)
  const withDigest = parseState(state({
    decisions: [`### ${A}${SEP}t`, `**Flagged by:** codex`, `**Recovery:** none${SEP}base ${'b'.repeat(40)}${SEP}item-digest ${'d'.repeat(64)}${SEP}scope ${'c'.repeat(64)}`, `**Decision:** ${FILL}`],
  }))
  assert.deepEqual(withDigest.entries[0].recovery, { sha: null, base: 'b'.repeat(40), itemDigest: 'd'.repeat(64), scope: 'c'.repeat(64) })
  const lines = state().split('\n')
  assert.ok(lines.length > 0)
})

test('entries: the decision extent runs to the next ** line or the entry end, joined with spaces', () => {
  const st = parseState(state({
    decisions: [
      `### ${A}${SEP}a`, '**Recommendation:** r', '**Decision:** use the queue,', '  and retry twice', '', 'then ship', '**Note:** not part of it',
      `### ${B}${SEP}b`, '**Recommendation:** r', '**Decision:**', 'on the next line',
      `### ${C}${SEP}c`, '**Recommendation:** r', `**Decision:** ${FILL}`, 'text under the placeholder',
      `### tl-dddddddd${SEP}d`, '**Recommendation:** r', '**Decision:**   ',
      `### tl-eeeeeeee${SEP}e`, '**Recommendation:** r', '**Decision:** yes', '**Decision:** no',
      `### tl-ffffffff${SEP}f`, '**Recommendation:** r', 'text that says **Decision:** forged',
    ],
  }))
  assert.deepEqual(st.entries.map(e => [e.decision, e.filled]), [
    ['use the queue, and retry twice then ship', true],
    ['on the next line', true],
    [`${FILL} text under the placeholder`, false],
    ['', false],
    ['', false],
    ['', false],
  ])
  assert.deepEqual(st.entries[4].problems.map(p => p.kind), ['ambiguous-decision'])
})

test('an item block ends at its last non-blank indented line; blank lines inside it are kept', () => {
  const text = state({ backlog: [...open('a', { id: A }), '', '  - notes: after a blank', '', ...open('b', { id: B })] })
  const st = parseState(text)
  const [a, b] = st.items
  assert.equal(a.notes, 'after a blank')
  const lines = text.split('\n')
  assert.equal(lines[a.end - 1], '  - notes: after a blank')
  assert.equal(lines[b.start], b.header)
  assert.deepEqual(a.lines, lines.slice(a.start, a.end))
})

// Fix manifest R31 (Claude PARSE-3): a column-0 level-1 heading inside an item section is a
// stray-heading problem, and the items under it still parse in that section.
test('stray-heading: a # heading inside an item section is reported; the items below it stay in the section', () => {
  const text = state({ backlog: [...open('first', { id: A, status: 'waiting-infra' }), '', '# Phase 2', ...open('second', { id: B }), ...open('third', {})] })
  const st = parseState(text)
  assert.deepEqual(st.items.map(i => [i.section, i.title]), [['Backlog', 'first'], ['Backlog', 'second'], ['Backlog', 'third']])
  const stray = st.problems.filter(p => p.kind === 'stray-heading')
  assert.deepEqual(stray.map(p => [p.section, p.text, text.split('\n')[p.line - 1]]), [['Backlog', '# Phase 2', '# Phase 2']])
  assert.ok(itemProblems(st, null).some(r => r.kind === 'stray-heading' && r.section === 'Backlog'))
  // The heading still ends a section that holds no items (nowLine's rule is unchanged there).
  const lr = parseState(`${state()}\n# Appendix\n- [ ] not an item\n`)
  assert.deepEqual(lr.problems, [])
})
