// tests/lib/loop-state-pick.test.mjs
// planPick (stage 0c-3 brief R13, R14, R16): decided entries first, then `## Backlog`
// top-down; every park reason; waiting-level by level; the section 3.1 release; dry; the
// refusals; and insert-before-delete moves that never lose the item. Closing fixes: the picked
// answer carries the item's origin (F1, for the section 8 row's item_origin), and an unresolved
// legacy heading parks the item whose title it names (F3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, itemDigest, nowLine, parseState, planDeleteBlock, planPick } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, DASH, E, F, FILL, G, H, SEP, blockedItem, doneItem, entry, ledger, open, sha256, state } from './loop-state-fixture.mjs'

const pick = (text, opts = {}) => planPick(text, { ledger: ledger(), level: 3, ...opts })
const applied = (text, plan) => parseState(applyEdits(text, plan.edits))
const section = (st, name) => st.items.filter(i => i.section === name)
const linesOf = (text, name) => {
  const s = parseState(text).sections[name]
  return text.split('\n').slice(s.start, s.end).filter(l => l.trim() !== '')
}

test('the first eligible Backlog item is picked and moved to ## Now in place of (empty)', () => {
  const text = state({ backlog: [...open('first', { id: A, p: 1, notes: 'n' }), ...open('second', { id: B })] })
  const plan = pick(text)
  assert.equal(plan.state, 'picked')
  assert.deepEqual([plan.id, plan.title, plan.from], [A, 'first', 'backlog'])
  assert.deepEqual(plan.released, [])
  assert.deepEqual(plan.skipped, [])
  const after = applyEdits(text, plan.edits)
  assert.equal(plan.expect_sha256, sha256(after))
  const st = parseState(after)
  assert.deepEqual(section(st, 'Now').map(i => i.id), [A])
  assert.deepEqual(section(st, 'Backlog').map(i => i.id), [B])
  // The whole block moved unchanged, and the digest is the moved item's.
  assert.deepEqual(section(st, 'Now')[0].lines, parseState(text).items[0].lines)
  assert.equal(plan.digest, itemDigest(section(st, 'Now')[0]))
  assert.ok(!linesOf(after, 'Now').includes('(empty)'))
  // Picking the last Backlog item leaves (empty) behind.
  const one = state({ backlog: open('only', { id: A }) })
  assert.deepEqual(linesOf(applyEdits(one, pick(one).edits), 'Backlog'), ['(empty)'])
})

// Closing fix F1 (Opus I2): the section 8 row's item_origin comes from pick's answer, never from a
// hand copy of STATE.md.
test('F1: the picked answer carries the item\'s origin as written, or null', () => {
  assert.equal(pick(state({ backlog: open('child', { id: A, origin: `loop from ${B}` }), done: doneItem('parent', { id: B }) })).origin, `loop from ${B}`)
  assert.equal(pick(state({ backlog: open('plain', { id: A }) })).origin, 'human')
  assert.equal(pick(state({ backlog: open('none', { id: A, origin: null }) })).origin, null)
})

// Closing fix F3 (Codex g1#4): a legacy `### <title>` heading holds a decision the release never
// reads, so the item with that title waits until a person rewrites the heading with its id.
test('F3: an unresolved legacy heading parks the open item whose title it names', () => {
  const text = state({
    backlog: [...open('Cache', { id: A }), ...open('other', { id: B })],
    decisions: entry('cache', { decision: 'use Redis' }),
  })
  const plan = pick(text)
  assert.equal(plan.id, B)
  assert.deepEqual(plan.skipped.map(s => [s.id, s.reason]), [[null, 'legacy-entry'], [A, 'legacy-entry']])
  // Unfilled, or delegate-flagged, it parks the item too; an `other` entry does not.
  assert.equal(pick(state({ backlog: open('cache', { id: A }), decisions: entry('cache') })).state, 'dry')
  assert.equal(pick(state({ backlog: open('cache', { id: A }), decisions: entry('cache', { variant: 'delegate-flagged' }) })).state, 'dry')
  assert.equal(pick(state({ backlog: open('cache', { id: A }), decisions: entry('cache', { variant: 'other' }) })).id, A)
  // Rewritten with the id, the decision is released and the item picked with it.
  const fixed = pick(state({ backlog: open('cache', { id: A }), decisions: entry(`${A}${SEP}cache`, { decision: 'use Redis' }) }))
  assert.deepEqual([fixed.id, fixed.from], [A, 'decision'])
})

test('every park reason is skipped, top-down, until the first eligible item', () => {
  const text = state({
    backlog: [
      ...open('no id', {}),
      ...open('hand id', { id: 'my-task' }),
      ...open('dup a', { id: A }), ...open('dup b', { id: A }),
      ...open('malformed', { id: B, extra: ['  * star: x'] }),
      ...open('doubled', { id: C, status: DASH, extra: [`  - status: ${DASH}`] }),
      ...open(`P1${SEP}ambiguous`, { id: D, p: 2 }),
      ...open('same title', { id: E }), ...open('Same  title', { id: F }),
      ...open('bad origin', { id: G, origin: 'robot' }),
      `- [x] an unparsed line${SEP}class: hard`,
      ...open('cycle', { id: H, origin: `loop from ${H}` }),
      ...open('title blocker', { id: 'tl-jjjjjjjj', blockedBy: 'no id' }),
      ...open('unknown blocker', { id: 'tl-kkkkkkkk', blockedBy: 'tl-zzzzzzzz' }),
      ...open('self blocker', { id: 'tl-mmmmmmmm', blockedBy: 'tl-mmmmmmmm' }),
      ...open('waiting', { id: 'tl-nnnnnnnn', status: 'waiting-decision' }),
      ...open('blocked', { id: 'tl-pppppppp', blockedBy: 'tl-qqqqqqqq' }),
      ...open('the pick', { id: 'tl-rrrrrrrr' }),
      ...open('after the pick', { id: 'tl-ssssssss', status: 'waiting-infra' }),
    ],
    blocked: blockedItem('open blocker', { id: 'tl-qqqqqqqq' }),
  })
  const plan = pick(text)
  assert.equal(plan.id, 'tl-rrrrrrrr')
  assert.deepEqual(plan.skipped.map(s => [s.title, s.reason]), [
    ['no id', 'no-id'], ['hand id', 'invalid-id'], ['dup a', 'duplicate-id'], ['dup b', 'duplicate-id'],
    ['malformed', 'malformed-field'], ['doubled', 'duplicate-field'], [`P1${SEP}ambiguous`, 'ambiguous-title'],
    ['same title', 'duplicate-title'], ['Same  title', 'duplicate-title'], ['bad origin', 'invalid-origin'],
    [`- [x] an unparsed line${SEP}class: hard`, 'unparsed-line'], ['cycle', 'origin-cycle'],
    ['title blocker', 'title-blocker'], ['unknown blocker', 'unknown-blocker'], ['self blocker', 'self-blocker'],
    ['waiting', 'status'], ['blocked', 'blocked'],
  ])
  for (const s of plan.skipped) assert.ok(typeof s.detail === 'string' && s.detail.length, s.reason)
})

test('dry: no eligible item, every ineligible one listed, ## Now untouched; an id-less item is never picked', () => {
  const text = state({ backlog: [...open('no id', {}), ...open('waiting', { id: A, status: 'waiting-infra' })] })
  const plan = pick(text)
  assert.equal(plan.state, 'dry')
  assert.deepEqual(plan.edits, [])
  assert.equal(plan.expect_sha256, sha256(text))
  assert.deepEqual(plan.skipped.map(s => s.reason), ['no-id', 'status'])
  assert.equal(pick(state()).state, 'dry')
})

test('waiting-level is picked once the level permits the class, and the status is cleared', () => {
  const text = cls => state({ backlog: open('parked', { id: A, cls, status: 'waiting-level' }) })
  const cases = [['hard', 2, false], ['hard', 3, true], ['hard', '3', true], ['mechanical', 1, false], ['mechanical', 2, true],
    ['high-stakes', 1, true], ['unclassified', 2, false], ['unclassified', 3, true], ['hard', 'x', false], ['hard', undefined, false]]
  for (const [cls, level, ok] of cases) {
    const plan = planPick(text(cls), { ledger: ledger(), level })
    assert.equal(plan.state, ok ? 'picked' : 'dry', `${cls} at ${level}`)
    if (!ok) {
      assert.equal(plan.skipped[0].reason, 'status')
      continue
    }
    const now = section(applied(text(cls), plan), 'Now')[0]
    assert.equal(now.status, null)
    assert.ok(now.lines.includes(`  - status: ${DASH}`))
  }
  // Other statuses never pass.
  for (const s of ['waiting-decision', 'waiting-infra', 'done']) assert.equal(pick(state({ backlog: open('x', { id: A, status: s }) })).state, 'dry', s)
})

test('a decided entry comes first: released, then picked ahead of the Backlog order', () => {
  const text = state({
    backlog: [...open('top', { id: A, p: 1 }), ...open('decided', { id: B, p: 2, cls: 'high-stakes', status: 'waiting-decision', notes: 'n' })],
    decisions: entry(`${B}${SEP}decided`, { decision: 'use the queue,', after: ['  and retry twice'] }),
  })
  const plan = pick(text)
  assert.deepEqual([plan.state, plan.id, plan.from, plan.released], ['picked', B, 'decision', [B]])
  const st = applied(text, plan)
  const now = section(st, 'Now')[0]
  assert.equal(now.decision, 'use the queue, and retry twice')
  assert.equal(now.class, 'hard')
  assert.equal(now.priority, 2)
  assert.equal(now.status, null)
  assert.equal(now.notes, 'n')
  assert.deepEqual(st.entries, [])
  assert.deepEqual(section(st, 'Backlog').map(i => i.id), [A])
})

test('the release appends a later decision with "; then:" and never erases the earlier one', () => {
  const text = state({
    backlog: [...open('a', { id: A, decision: 'first call', status: 'waiting-decision' })],
    decisions: [...entry(`${A}${SEP}a`, { decision: 'second call' }), ...entry(`${A}${SEP}a`, { variant: 'delegate-flagged', decision: 'third call' })],
  })
  const plan = pick(text)
  const now = section(applied(text, plan), 'Now')[0]
  assert.equal(now.decision, 'first call; then: second call; then: third call')
  // A multi-line earlier decision keeps its lines.
  const multi = state({ backlog: open('a', { id: A, decision: 'one', extra: ['    two'] }), decisions: entry(`${A}${SEP}a`, { decision: 'three' }) })
  assert.equal(section(applied(multi, pick(multi)), 'Now')[0].decision, 'one\ntwo; then: three')
})

test('a Blocked item is released to the top of ## Backlog: inserted there first, then deleted from ## Blocked', () => {
  const text = state({
    backlog: open('waiting work', { id: A, status: 'waiting-infra' }),
    decisions: entry(`${B}${SEP}stuck`, { decision: 'mock the service' }),
    blocked: blockedItem('stuck', { id: B, notes: 'n', blockedBy: C }),
    done: doneItem('c', { id: C }),
  })
  const plan = planPick(text, { ledger: ledger(), level: 1 })
  assert.equal(plan.id, B)
  // Edit 1 inserts into Backlog; after it the item is in two places, never none.
  const one = parseState(applyEdits(text, plan.edits.slice(0, 1)))
  assert.deepEqual(one.items.filter(i => i.id === B).map(i => i.section).sort(), ['Backlog', 'Blocked'])
  const st = applied(text, plan)
  const now = section(st, 'Now')[0]
  assert.equal(now.title, 'stuck')
  assert.equal(now.header, `- [ ] stuck${SEP}class: hard`)
  assert.equal(now.blockedBy, C)
  assert.equal(now.origin, 'human')
  assert.equal(now.decision, 'mock the service')
  assert.deepEqual(linesOf(applyEdits(text, plan.edits), 'Blocked'), ['(empty)'])
})

test('entries are deleted after the item edits; other variants stay; orphan and done entries stay with a reason', () => {
  const text = state({
    backlog: [...open('a', { id: A, status: 'waiting-decision' }), ...open('ok', { id: E })],
    decisions: [
      ...entry(`${C}${SEP}acceptance`, { variant: 'other', decision: 'accept' }),
      ...entry(`${A}${SEP}a`, { decision: 'go' }),
      ...entry(`${A}${SEP}a`, { variant: 'delegate-flagged' }),
      ...entry(`${B}${SEP}gone`, { decision: 'go' }),
      ...entry(`${D}${SEP}finished`, { decision: 'go' }),
      ...entry(`old title heading`, { decision: 'go' }),
    ],
    done: doneItem('finished', { id: D }),
  })
  const plan = pick(text)
  assert.deepEqual(plan.released, [A])
  assert.deepEqual(plan.skipped.map(s => [s.id, s.reason]), [[null, 'legacy-entry'], [B, 'orphan-entry'], [D, 'entry-item-done']])
  // Item edit before any entry deletion.
  const firstDelete = plan.edits.findIndex(e => e.old.includes(`### ${A}`) && !e.new.includes(`### ${A}`))
  const itemEdit = plan.edits.findIndex(e => e.new.includes('- decision: go'))
  assert.ok(itemEdit >= 0 && firstDelete > itemEdit)
  const st = applied(text, plan)
  assert.deepEqual(st.entries.map(e => [e.id, e.variant]), [[C, 'other'], [B, 'panel'], [D, 'panel'], [null, 'panel']])
  assert.equal(st.items.find(i => i.id === A).decision, 'go')
})

test('an interrupted release resumes: no doubled decision, no lost or duplicated item', () => {
  // Backlog item: interrupted after the item edit, before the entry deletion.
  const text = state({ backlog: open('a', { id: A, status: 'waiting-decision' }), decisions: entry(`${A}${SEP}a`, { decision: 'go' }) })
  const plan = pick(text)
  for (let k = 1; k < plan.edits.length; k++) {
    const mid = applyEdits(text, plan.edits.slice(0, k))
    if (parseState(mid).items.some(i => i.section === 'Now')) break // the move's insert: the recovery planner's clear-now
    const again = pick(mid)
    assert.equal(again.id, A, `after edit ${k}`)
    const st = applied(mid, again)
    assert.deepEqual(st.items.map(i => [i.section, i.id]), [['Now', A]])
    assert.equal(st.items[0].decision, 'go')
    assert.deepEqual(st.entries, [])
  }
  // Blocked item: interrupted between the insert into Backlog and the delete from Blocked.
  const bl = state({ decisions: entry(`${B}${SEP}stuck`, { decision: 'go' }), blocked: blockedItem('stuck', { id: B }) })
  const blPlan = pick(bl)
  const mid = applyEdits(bl, blPlan.edits.slice(0, 1))
  const again = pick(mid)
  assert.equal(again.id, B)
  assert.deepEqual(again.skipped, [])
  const st = applied(mid, again)
  assert.deepEqual(st.items.map(i => [i.section, i.id]), [['Now', B]])
  assert.equal(st.items[0].decision, 'go')
})

test('the pick move inserts into ## Now first, then deletes from ## Backlog', () => {
  const text = state({ backlog: [...open('a', { id: A }), ...open('b', { id: B })] })
  const plan = pick(text)
  assert.equal(plan.edits.length, 2)
  const one = parseState(applyEdits(text, plan.edits.slice(0, 1)))
  assert.deepEqual(one.items.filter(i => i.id === A).map(i => i.section), ['Now', 'Backlog'])
  // Each prefix of the edits keeps the item somewhere.
  for (let k = 0; k <= plan.edits.length; k++) {
    assert.ok(parseState(applyEdits(text, plan.edits.slice(0, k))).items.some(i => i.id === A), `prefix ${k}`)
  }
})

test('a released item whose blocker is unfinished stays in the Backlog, and the Backlog order continues', () => {
  const text = state({
    backlog: [...open('free', { id: A }), ...open('decided', { id: B, status: 'waiting-decision', blockedBy: C })],
    decisions: entry(`${B}${SEP}decided`, { decision: 'go' }),
    blocked: blockedItem('blocker', { id: C }),
  })
  const plan = pick(text)
  assert.deepEqual([plan.id, plan.from, plan.released], [A, 'backlog', [B]])
  assert.deepEqual(plan.skipped.map(s => [s.id, s.reason]), [[B, 'blocked']])
  const st = applied(text, plan)
  const b = st.items.find(i => i.id === B)
  assert.deepEqual([b.section, b.status, b.decision, b.class], ['Backlog', null, 'go', 'hard'])
})

test('refusals: a carriage return, missing or repeated sections, an occupied ## Now', () => {
  const text = state({ backlog: open('a', { id: A }) })
  assert.equal(pick(text.replace(/\n/g, '\r\n')).reason, 'crlf')
  assert.equal(pick(text.replace('## Backlog', '## Later')).reason, 'bad-sections')
  assert.equal(pick(text + '\n## Done\n').reason, 'bad-sections')
  const busy = state({ now: open('in flight', { id: B }), backlog: open('a', { id: A }) })
  const r = pick(busy)
  assert.deepEqual([r.state, r.reason, r.edits], ['refused', 'now-occupied', []])
  assert.equal(r.expect_sha256, null)
})

test('a filled decision on a placeholder, an empty one, or two Decision lines releases nothing', () => {
  const base = { backlog: open('a', { id: A, status: 'waiting-decision' }) }
  for (const decisions of [entry(`${A}${SEP}a`), entry(`${A}${SEP}a`, { decision: '' }), [...entry(`${A}${SEP}a`, { decision: FILL }), 'more text']]) {
    const plan = pick(state({ ...base, decisions }))
    assert.deepEqual([plan.state, plan.released], ['dry', []])
  }
  const two = pick(state({ ...base, decisions: [...entry(`${A}${SEP}a`, { decision: 'yes' }), '**Decision:** no'] }))
  assert.deepEqual(two.skipped.map(s => s.reason), ['ambiguous-decision', 'status'])
  assert.deepEqual(two.edits, [])
})

// Fix manifest R31 (Claude EP1): a deletion's anchor runs through the next non-blank line after
// the block, so a line a person appended to the block between plan and apply makes the Edit
// fail instead of leaving the line behind as a field of the item above.
test('EP1: a line appended to a planned deletion\'s block makes that edit fail', () => {
  const text = state({ backlog: [...open('parked', { id: C, status: 'waiting-infra' }), ...open('picked', { id: A }), ...open('next', { id: B })] })
  const plan = pick(text)
  assert.equal(plan.id, A)
  const last = `  - origin: human\n- [ ] next${SEP}`
  for (const added of [`  - blocked-by: ${B}\n`, `\n  - blocked-by: ${B}\n`]) {
    const i = text.indexOf(last) + '  - origin: human\n'.length
    const edited = text.slice(0, i) + added + text.slice(i)
    assert.ok(parseState(edited).items.find(it => it.id === A).lines.join('\n').includes('blocked-by'), JSON.stringify(added))
    assert.doesNotThrow(() => applyEdits(edited, plan.edits.slice(0, 1)))
    assert.throws(() => applyEdits(edited, plan.edits), /edit-anchor: edit 2: old occurs 0 times/, JSON.stringify(added))
  }
  // An entry deletion is anchored the same way.
  const dec = state({ backlog: open('a', { id: A, status: 'waiting-decision' }), decisions: entry(`${A}${SEP}a`, { decision: 'go' }) })
  const dp = pick(dec)
  const k = dp.edits.findIndex(e => e.old.includes(`### ${A}`))
  assert.ok(k > 0)
  const appended = applyEdits(dec, dp.edits.slice(0, k)).replace('**Decision:** go\n', '**Decision:** go\nand one more line\n')
  assert.throws(() => applyEdits(appended, [dp.edits[k]]), /old occurs 0 times/)
})

// Fix manifest R27: pick reports the `## Done` entries the ledger does not record as done, so
// the firing's ledger row can carry them before a trim drops them.
test('R27: picked and dry answers carry unledgered, the Done entries the ledger lacks', () => {
  const done = [...doneItem('follow-up', { id: F, origin: `loop from ${C}`, sha: null }), ...doneItem('ledgered', { id: C }), ...doneItem('old', { id: E, origin: 'unknown' })]
  const L = ledger({ done: [C], origins: { [C]: 'human' } })
  const want = [{ item_id: F, item_origin: `loop from ${C}` }, { item_id: E, item_origin: 'unknown' }]
  // F1: an entry recorded done without its origin as written is listed too, with its origin.
  assert.deepEqual(planPick(state({ done }), { ledger: ledger({ done: [C] }), level: 3 }).unledgered, [want[0], { item_id: C, item_origin: 'human' }, want[1]])
  const picked = planPick(state({ backlog: open('a', { id: A }), done }), { ledger: L, level: 3 })
  assert.equal(picked.state, 'picked')
  assert.deepEqual(picked.unledgered, want)
  const dry = planPick(state({ done }), { ledger: L, level: 3 })
  assert.equal(dry.state, 'dry')
  assert.deepEqual(dry.unledgered, want)
  // The ledger's done_items count once ledgerItems has read them: nothing is left.
  const all = ledger({ done: [C, F, E], origins: { [C]: 'human', [F]: `loop from ${C}`, [E]: 'unknown' } })
  assert.deepEqual(planPick(state({ done }), { ledger: all, level: 3 }).unledgered, [])
  // An occupied ## Now still reports them; an id-less Done entry has no id to record.
  assert.deepEqual(planPick(state({ now: open('x', { id: G }), done }), { ledger: L }).unledgered, want)
  assert.deepEqual(planPick(state({ done: doneItem('no id', {}) }), { ledger: L }).unledgered, [])
})

// Fix manifest R29: clear-now deletes only the `## Now` item's block, through the same anchored
// deletion (loop-recover.mjs prints it).
test('planDeleteBlock: deletes one block, (empty) when nothing is left, anchored through the next line', () => {
  const text = state({ now: [...open('copy', { id: A }), ...open('another', { id: B })], backlog: open('copy', { id: A }) })
  const now = parseState(text).items.filter(i => i.section === 'Now')
  const one = planDeleteBlock(text, 'Now', now[0].start, now[0].end)
  const after = applyEdits(text, one.edits)
  assert.equal(one.expect_sha256, sha256(after))
  assert.deepEqual(parseState(after).items.map(i => [i.section, i.id]), [['Now', B], ['Backlog', A]])
  assert.throws(() => applyEdits(after, one.edits), /edit-anchor/)
  // A line a person added to the block in between makes the deletion fail.
  assert.throws(() => applyEdits(text.replace(`  - origin: human\n- [ ] another`, `  - origin: human\n  - notes: amended\n- [ ] another`), one.edits), /old occurs 0 times/)
  const single = state({ now: open('only', { id: A }), backlog: open('only', { id: A }) })
  const it = parseState(single).items[0]
  const gone = applyEdits(single, planDeleteBlock(single, 'Now', it.start, it.end).edits)
  assert.equal(nowLine(gone), null)
  assert.ok(gone.includes('## Now\n(empty)\n'))
  assert.throws(() => planDeleteBlock(single, 'Now', 0, 1), RangeError)
  assert.throws(() => planDeleteBlock(single, 'Later', it.start, it.end), RangeError)
})

test('R31: an item below a stray heading in ## Now still occupies it; one in ## Backlog is still picked', () => {
  const now = state({ backlog: open('a', { id: A }) }).replace('## Now\n(empty)\n', `## Now\n(empty)\n# stray\n${open('hidden', { id: B }).join('\n')}\n`)
  const r = pick(now)
  assert.deepEqual([r.state, r.reason], ['refused', 'now-occupied'])
  const back = state({ backlog: [...open('parked', { id: A, status: 'waiting-infra' }), '# Phase 2', ...open('next', { id: B })] })
  assert.equal(pick(back).id, B)
})
