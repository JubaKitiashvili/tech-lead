// tests/loop/firing-moves.test.mjs
// The main session's STATE.md edits as the firing driver makes them (tests/fixtures/
// firing-moves.mjs): each is one Edit whose `old` occurs once, a move inserts the whole block
// before it deletes the source, and every result parses with no problem.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parseState } from '../../scripts/lib/loop-state.mjs'
import {
  DASH, DOT, blockedBlock, carriers, doneBlock, editOnce, fieldOf, findItem, insertTop, nowBlock, removeItem, replaceItem, setSection,
  upsertEntry, withField,
} from '../fixtures/firing-moves.mjs'

const A = 'tl-aaaaaaaa'
const B = 'tl-bbbbbbbb'
const head = t => `- [ ] P1 ${DOT} ${t} ${DOT} class: mechanical`
const state = ({ now = ['(empty)'], backlog = ['(empty)'], nd = ['(empty)'], blocked = ['(empty)'], done = ['(empty)'] } = {}) => [
  '# P - Loop State', '', '## Now', ...now, '', '## Backlog', ...backlog, '', '## Needs decision', ...nd, '', '## Blocked', ...blocked, '',
  '## Done', ...done, '', '## Last run', '(never run)', '',
].join('\n')
const blockA = [head('item A'), `  - id: ${A}`, '  - origin: human', '  - notes: keep me']
const blockB = [head('item B'), `  - id: ${B}`, '  - origin: human']
const clean = text => assert.deepEqual(parseState(text).problems, [], text)

describe('firing-moves: the Edit model', () => {
  test('editOnce applies an old that occurs once and refuses none or two', () => {
    assert.equal(editOnce('a b c', { old: 'b', new: 'x' }), 'a x c')
    assert.throws(() => editOnce('a b b', { old: 'b', new: 'x' }), /old occurs 2 times/)
    assert.throws(() => editOnce('a', { old: 'b', new: 'x' }), /old occurs 0 times/)
    assert.throws(() => editOnce('a', { old: '', new: 'x' }), /old occurs/)
  })

  test('a move Now -> Done: insertion first (two copies), then the deletion leaves (empty)', () => {
    const t0 = state({ now: blockA, backlog: blockB })
    const item = nowBlock(t0)
    assert.equal(item.id, A)
    const t1 = editOnce(t0, insertTop(t0, 'Done', doneBlock(item, 'abc1234', '2026-10-02')))
    clean(t1)
    assert.deepEqual(carriers(t1, A).map(i => i.section), ['Now', 'Done'])
    const t2 = editOnce(t1, removeItem(t1, findItem(t1, A, 'Now')))
    clean(t2)
    assert.match(t2, /\n## Now\n\(empty\)\n\n## Backlog\n/)
    const done = findItem(t2, A)
    assert.equal(done.section, 'Done')
    assert.deepEqual(done.lines, [`- [x] item A ${DOT} abc1234 ${DOT} 2026-10-02`, ...blockA.slice(1)])
    assert.equal(doneBlock(item, null, '2026-10-02')[0], `- [x] item A ${DOT} ${DASH} ${DOT} 2026-10-02`)
  })

  test('insertTop above an existing item keeps it; removeItem of one of two keeps the other and no (empty)', () => {
    const t0 = state({ now: blockA, backlog: blockB })
    const t1 = editOnce(t0, insertTop(t0, 'Backlog', nowBlock(t0).lines))
    assert.deepEqual(parseState(t1).items.filter(i => i.section === 'Backlog').map(i => i.id), [A, B])
    const t2 = editOnce(t1, removeItem(t1, findItem(t1, B)))
    clean(t2)
    assert.match(t2, /\n## Backlog\n- \[ \] P1 . item A[^\n]*\n {2}- id: tl-aaaaaaaa\n {2}- origin: human\n {2}- notes: keep me\n\n## Needs decision/)
  })

  test('a Blocked block keeps every field and sets recovery: in place; replaceItem rewrites a block where it is', () => {
    const t0 = state({ now: [...blockA, '  - recovery: old'] })
    const b = blockedBlock(nowBlock(t0), { reason: 'attempt failed twice', recovery: 'new' })
    assert.deepEqual(b, [`- [ ] item A ${DOT} attempts: 2 ${DOT} attempt failed twice`, ...blockA.slice(1), '  - recovery: new'])
    const t1 = editOnce(t0, insertTop(t0, 'Blocked', b))
    const t2 = editOnce(t1, removeItem(t1, findItem(t1, A, 'Now')))
    const t3 = editOnce(t2, replaceItem(t2, findItem(t2, A), withField(findItem(t2, A).lines, 'recovery', 'newer')))
    clean(t3)
    assert.equal(fieldOf(findItem(t3, A).lines, 'recovery'), 'newer')
    assert.equal(fieldOf(findItem(t3, A).lines, 'notes'), 'keep me')
    assert.equal(fieldOf(findItem(t3, A).lines, 'status'), null)
  })

  test('upsertEntry inserts by id, then replaces the entry with that id; setSection rewrites a body', () => {
    const t0 = state({ now: blockA })
    const e1 = [`### ${A} ${DOT} item A`, '**Flagged by:** x', '**Decision:** (fill in to release the task back to the backlog)']
    const t1 = editOnce(t0, upsertEntry(t0, A, e1))
    const e2 = [`### ${A} ${DOT} item A`, '**Flagged by:** y', '**Decision:** (fill in to release the task back to the backlog)']
    const t2 = editOnce(t1, upsertEntry(t1, A, e2))
    clean(t2)
    assert.deepEqual(parseState(t2).entries.map(e => [e.id, e.lines[1]]), [[A, '**Flagged by:** y']])
    const t3 = editOnce(t2, setSection(t2, 'Last run', ['- generation 1: done']))
    assert.ok(t3.endsWith('## Last run\n- generation 1: done\n'), t3)
    clean(t3)
  })
})
