// tests/loop/loop-interrupt-clone-items.test.mjs
// Stage 0c-3 brief section 8, Interruption, through the whole firing: the driver
// (tests/fixtures/firing-driver.mjs) killed between the edits of normalize, of a pick, of a
// release, of the follow-up and of each prose move (## Now to ## Done, to ## Blocked, the
// requeue, the delegate-flagged move), and the next firing neither loses nor duplicates the item
// (R14; R20 clear-now). Also R14's incident: STATE.md changed under a plan fails `check --expect`,
// the firing halts with the loop paused and ## Now as it stands. Invariants I1-I9 after each
// recovering firing (tests/loop/interrupt-fixture.mjs). The same points, edit by edit, without the
// clone: tests/loop/loop-interrupt-items.test.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DOT, ROWS, T, assertRecovered, editState, go, idOf, ids, interrupt, itemHead, ledger, project, run, sections, start, stateText, titles, unpause,
} from './interrupt-fixture.mjs'
import { parseState } from '../../scripts/lib/loop-state.mjs'

const A = idOf('item A')
const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const FAILING = { attempts: [{ ops: EDIT, fail: true }, { ops: [], fail: true }] }
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
const item = (fx, id) => parseState(stateText(fx)).items.filter(i => i.id === id)

describe('interruption between the item edits of a firing', ROWS, () => {
  test('pick killed after its insertion into ## Now: clear-now drops the copy, the item is picked again and done once', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'pick-edit-1', ...work('lost') })
    assert.deepEqual(item(fx, A).map(i => i.section), ['Now', 'Backlog'], 'two copies, never none')
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['clear-now'])
    const clear = f2.get('planned').plan.clear
    assert.deepEqual([clear.id, clear.section, clear.edits.length], [A, 'Backlog', 1], 'one anchored deletion of the ## Now block (R29)')
    assert.match(clear.expect_sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(f2.get('picked').item, itemHead('item A'))
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
    assert.deepEqual(ledger(fx)[0].item_id, A)
    assert.ok(ledger(fx)[0].notes.split('; ').includes(`cleared interrupted move of ${A}`), ledger(fx)[0].notes)
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'], Backlog: ['item C', 'item D'] } })
  })

  test('the Now to Done move killed after its insertion: clear-now, the commit reaches the ledger, the item is done once', T, async t => {
    const fx = project(t)
    let C
    await interrupt(fx, { stop: 'done-inserted', attempts: [{ ops: EDIT }] }, f => { C = committedSha(f) })
    assert.deepEqual(item(fx, A).map(i => i.section), ['Now', 'Done'])
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['clear-now', 'ledger-recovered'])
    assert.equal(p.finish, null)
    const row = ledger(fx)[0]
    assert.deepEqual([row.recovered.action, row.recovered.commits, row.recovered.item_id], [null, [C], A], 'recovered.action is null after clear-now (loop section 1 step 5)')
    assert.ok(sections(fx).Done.some(l => l.includes(' item A ') && l.includes(C)))
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('the Now to Blocked move killed after its insertion: clear-now, the item stays Blocked once with its recovery bundle', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'blocked-inserted', ...FAILING })
    assert.deepEqual(item(fx, A).map(i => i.section), ['Now', 'Blocked'])
    const sha = item(fx, A)[1].recovery
    assert.match(sha, /^[0-9a-f]{64}$/)
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions.slice(0, 2), ['clear-now', 'ledger-recovered'])
    assert.deepEqual(item(fx, A).map(i => [i.section, i.recovery]), [['Blocked', sha]])
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Blocked: ['item A'], Done: ['item B'] }, work: [] })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Blocked: ['item A'], Done: ['item B', 'item C'] } })
  })

  test('the recovery requeue killed after its insertion into ## Backlog: the third firing clears ## Now and runs the item once', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'prepared', ...work('lost') })
    const f2 = await interrupt(fx, { stop: 'requeue-inserted', ...work('lost2') })
    assert.deepEqual(f2.get('requeue-inserted') && item(fx, A).map(i => i.section), ['Now', 'Backlog'])
    const f3 = await run(fx, work('three'))
    assert.deepEqual(f3.get('planned').plan.actions, ['clear-now'])
    assertRecovered(fx, { rows: [3], tip: committedSha(f3), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { rows: [3, 4], sections: { Done: ['item A', 'item B'] } })
  })

  test('the delegate-flagged move killed after the ## Backlog insertion: clear-now, one entry keyed by id, the item waits once', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'flag-inserted', path: 'flag', attempts: [{ ops: EDIT }] })
    assert.deepEqual(item(fx, A).map(i => [i.section, i.status]), [['Now', null], ['Backlog', 'waiting-decision']])
    const entries = parseState(stateText(fx)).entries
    assert.deepEqual(entries.map(e => [e.id, e.title, e.variant]), [[A, 'item A', 'delegate-flagged']])
    assert.match(entries[0].recovery.itemDigest, /^[0-9a-f]{64}$/, 'the Recovery line carries the item digest (R18)')
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions.slice(0, 2), ['clear-now', 'ledger-recovered'])
    const ex = { sections: { 'Needs decision': ['item A'], Done: ['item B'], Backlog: ['item A', 'item C', 'item D'] }, work: [] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2) })
    assert.deepEqual(item(fx, A).map(i => [i.section, i.status]), [['Backlog', 'waiting-decision']])
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { 'Needs decision': ['item A'], Done: ['item B', 'item C'], Backlog: ['item A', 'item D'] } })
  })

  test('normalize killed after its first edit: the ids it wrote stay, the next firing mints the rest, none twice', T, async t => {
    const bare = title => ({ title, id: null, origin: null })
    const fx = project(t, { items: [bare('item A'), bare('item B'), bare('item C')] })
    await interrupt(fx, { stop: 'normalize-edit-1', ...work('lost') })
    const written = parseState(stateText(fx)).items.filter(i => i.id).map(i => [i.title, i.id])
    assert.equal(written.length, 1, JSON.stringify(written))
    const f2 = await run(fx, work('two'))
    const now = parseState(stateText(fx)).items
    for (const [title, id] of written) assert.equal(now.find(i => i.title === title).id, id)
    assert.ok(now.every(i => i.origin === 'unknown'), 'origin: unknown filled (R1)')
    assert.equal(f2.get('picked').item[0].includes(' item A '), true)
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C'] } })
    assert.equal(new Set(ids(fx)).size, 3)
    // Loop section 3 step 1: the minted ids are noted in ## Last run (and the ledger note).
    const minted = ids(fx).filter(id => !written.some(([, w]) => w === id)).sort()
    const note = ledger(fx)[0].notes.split('; ').find(x => x.startsWith('minted '))
    assert.deepEqual(note?.slice('minted '.length).split(', ').sort(), minted, ledger(fx)[0].notes)
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'], Backlog: ['item C'] } })
  })

  for (const k of [1, 2, 3]) {
    test(`a release from ## Blocked killed after pick edit ${k}: the decision reaches the item once and the item runs once`, T, async t => {
      const fx = project(t, { items: ['item B', 'item C'] })
      editState(fx, text => text
        .replace('## Blocked\n(empty)\n', `## Blocked\n- [ ] item A ${DOT} attempts: 2 ${DOT} attempt failed twice\n  - id: ${A}\n  - origin: human\n  - recovery: ${'a'.repeat(64)}\n`)
        .replace('## Needs decision\n(empty)\n', `## Needs decision\n### ${A} ${DOT} item A\n**Recommendation:** split it\n**Decision:** split it in two\n`))
      await interrupt(fx, { stop: `pick-edit-${k}`, ...work('lost') })
      const f2 = await run(fx, work('two'))
      assert.deepEqual(f2.get('picked').pick.id, A)
      if (k < 3) assert.ok(ledger(fx)[0].notes.split('; ').includes(`released ${A}`), ledger(fx)[0].notes)
      const done = item(fx, A)
      assert.deepEqual(done.map(i => [i.section, i.decision]), [['Done', 'split it in two']])
      assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C'], Blocked: [], 'Needs decision': [] } })
      await run(fx, work('three'))
      assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'], Backlog: ['item C'] } })
    })
  }

  test('the follow-up killed after its edit: the analysis is finished by the planner, the follow-up exists once and runs', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'followup-edit-1', attempts: [{ ops: EDIT }], followup: { title: 'follow A', notes: 'the rest of A' } })
    const fu = parseState(stateText(fx)).items.filter(i => i.origin === `loop from ${A}`)
    assert.deepEqual(fu.map(i => [i.section, i.title, i.notes]), [['Backlog', 'follow A', 'the rest of A']])
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions.slice(0, 1), ['finish-commit'])
    assert.equal(f2.get('picked').pick.id, fu[0].id, 'the follow-up sits at the top of ## Backlog')
    // F1: pick prints the picked item's origin, and the ledger row copies it from that answer.
    assert.deepEqual([f2.get('picked').pick.origin, ledger(fx).at(-1).item_origin], [`loop from ${A}`, `loop from ${A}`], f2.describe())
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'follow A'], Backlog: ['item B', 'item C', 'item D'] } })
    assert.equal(parseState(stateText(fx)).items.filter(i => i.origin === `loop from ${A}`).length, 1)
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'follow A', 'item B'] } })
  })

  test('Codex g3#1: the read-only analysis F of P killed after its ## Done insertion; after twenty more completions trim F, P\'s dependent stays parked while F\'s follow-up G is open (R27)', { timeout: 400000 }, async t => {
    const P = idOf('item P')
    const Q = Array.from({ length: 20 }, (_, k) => `item Q${k + 1}`)
    const fx = project(t, { items: ['item P', { title: 'item X', sub: [`  - blocked-by: ${P}`] }, ...Q] })
    const analysis = followup => ({ path: 'analysis', ...(followup ? { followup } : {}) })
    // P: analysed, its follow-up F created, P done and ledgered.
    await run(fx, analysis({ title: 'follow P', notes: 'implement P' }))
    const F = parseState(stateText(fx)).items.find(i => i.origin === `loop from ${P}`).id
    // F: analysed (read-only), its follow-up G created, F inserted into ## Done, then killed
    // before the ## Now deletion and before the ledger append: ## Done is F's only record.
    await interrupt(fx, { stop: 'done-inserted', ...analysis({ title: 'follow F', notes: 'implement F' }) })
    assert.deepEqual(item(fx, F).map(i => i.section), ['Now', 'Done'])
    const G = parseState(stateText(fx)).items.find(i => i.origin === `loop from ${F}`).id
    assert.equal(ledger(fx).length, 1, 'no ledger row for the interrupted firing')
    // The next firing clears ## Now and records F as done with its origin (pick's unledgered);
    // it picks G, whose delegate stops on a judgment call: G waits, open, in ## Backlog.
    const f3 = await run(fx, { path: 'flag', attempts: [{ ops: EDIT }] })
    assert.deepEqual(f3.get('planned').plan.actions, ['clear-now'])
    assert.equal(f3.get('picked').pick.id, G)
    assert.deepEqual(f3.get('picked').pick.unledgered, [{ item_id: F, item_origin: `loop from ${P}` }])
    assert.deepEqual(ledger(fx).at(-1).done_items, [{ item_id: F, item_origin: `loop from ${P}` }], 'the row carries F as done_items')
    assert.deepEqual(item(fx, G).map(i => [i.section, i.status]), [['Backlog', 'waiting-decision']])
    // Twenty more completions; X is skipped as blocked each time, and the trims drop F and P,
    // both recorded done by then, each as a whole block (PDC-2).
    const dropped = []
    for (const q of Q) {
      const f = await run(fx, analysis(null))
      assert.equal(f.get('picked')?.pick.title, q, f.describe())
      assert.ok(f.get('picked').pick.skipped.some(s => s.title === 'item X' && s.reason === 'blocked'), JSON.stringify(f.get('picked').pick.skipped))
      dropped.push(...f.get('trimmed').dropped)
    }
    assert.deepEqual(dropped, [P, F], 'P goes first (the oldest), then F')
    assert.deepEqual(titles(fx, 'Done').sort(), [...Q].sort(), '## Done holds the twenty newest; F and P were trimmed')
    const st = parseState(stateText(fx))
    assert.deepEqual([st.problems, st.items.flatMap(i => i.problems)], [[], []], 'no field line of a trimmed block is left behind')
    const last = await run(fx, analysis(null))
    assert.equal(last.get('picked'), undefined, `X was picked while G is open: ${last.describe()}`)
    assert.ok(ledger(fx).at(-1).notes.includes('backlog dry'), ledger(fx).at(-1).notes)
    assert.deepEqual(item(fx, idOf('item X')).map(i => i.section), ['Backlog'])
    assertRecovered(fx, { sections: { Done: Q, Backlog: ['item X', 'follow F'] } })
  })

  test('the ## Done trim runs through loop-items trim: the trimmed event carries its answer, and killed there STATE.md hashes to its expect_sha256 (R27, R14)', T, async t => {
    // 21 older ## Done items; the analysis firing puts item A on top, so 22: the 20 newest are
    // A and old 0-18. Below them old 20 is ledgered (dropped) and old 19 is not (kept).
    const fx = project(t)
    const old = Array.from({ length: 21 }, (_, k) => `old ${k}`)
    const done = old.flatMap(title => [`- [x] ${title} ${DOT} abc1234 ${DOT} 2026-09-01`, `  - id: ${idOf(title)}`, '  - origin: human'])
    editState(fx, s => s.replace('## Done\n(empty)\n', `## Done\n${done.join('\n')}\n`))
    const rows = old.filter(title => title !== 'old 19').map(title => ({ iteration: 0, task: title, outcome: 'done', item_id: idOf(title), item_origin: 'human' }))
    fs.writeFileSync(path.join(fx.S, 'LEDGER.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
    let out = null, hash = null
    await interrupt(fx, { stop: 'trimmed', path: 'analysis' }, (f, e) => {
      out = e.out
      hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(fx.S, 'STATE.md'))).digest('hex')
    })
    assert.ok(out, 'the trimmed event carries loop-items trim\'s answer')
    assert.deepEqual(Object.keys(out).sort(), ['dropped', 'edits', 'expect_sha256', 'state', 'unledgered'])
    assert.deepEqual([out.state, out.dropped, out.edits.length], ['ok', [idOf('old 20')], 1])
    assert.deepEqual(out.unledgered.map(u => u.item_id).sort(), [A, idOf('old 19')].sort(), 'A (not ledgered yet) and old 19')
    assert.equal(hash, out.expect_sha256, 'the edits were applied as printed')
    assert.deepEqual(titles(fx, 'Done'), ['item A', ...old.slice(0, 20)])
  })

  test('the ## Done trim keeps a ledgered block whose lineage the ledger cannot carry whole: a capitalized Origin:, a second origin line, a malformed value (Codex fix1-g1#1, fix1-g2#2, R27a)', T, async t => {
    // 24 older ## Done items, every one ledgered; item A goes on top, so the 20 newest are A and
    // old 0-18. Below them old 19 and old 20 have one well-formed origin: field (dropped); old 21
    // names its parent on `Origin:`, old 22 on a second origin line, old 23 in a malformed value
    // (each kept: the ledger records one parsed origin, so the block is its parents' only record).
    const fx = project(t)
    const old = Array.from({ length: 24 }, (_, k) => `old ${k}`)
    const P = idOf('old parent')
    const origins = { 'old 21': [`  - Origin: loop from ${P}`], 'old 22': ['  - origin: human', `  - origin: loop from ${P}`], 'old 23': [`  - origin: loop from ${P} (the cache work)`] }
    const done = old.flatMap(title => [`- [x] ${title} ${DOT} abc1234 ${DOT} 2026-09-01`, `  - id: ${idOf(title)}`, ...(origins[title] ?? ['  - origin: human'])])
    editState(fx, s => s.replace('## Done\n(empty)\n', `## Done\n${done.join('\n')}\n`))
    const rows = old.map(title => ({ iteration: 0, task: title, outcome: 'done', item_id: idOf(title), item_origin: 'human' }))
    fs.writeFileSync(path.join(fx.S, 'LEDGER.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))
    const f = await run(fx, { path: 'analysis' })
    assert.deepEqual(f.get('trimmed')?.dropped, [idOf('old 19'), idOf('old 20')], f.describe())
    assert.deepEqual(titles(fx, 'Done'), ['item A', ...old.slice(0, 19), 'old 21', 'old 22', 'old 23'])
  })

  test('R14 incident: STATE.md changed under the pick fails check --expect: halted, paused, ## Now left as it stands; the next firing recovers it', T, async t => {
    const fx = project(t)
    const f1 = start(fx, { gates: ['pick-edit-2'], ...work('lost') })
    await f1.event('pick-edit-2')
    const D = idOf('item D')
    editState(fx, text => text.replace(`  - id: ${D}\n  - origin: human\n`, `  - id: ${D}\n  - origin: human\n  - notes: a person typed this\n`))
    const before = stateText(fx)
    go(fx, 'pick-edit-2')
    const { exit } = await f1.ended()
    assert.deepEqual(exit, { code: 0, signal: null }, f1.describe())
    assert.ok(f1.get('incident'), f1.describe())
    assert.equal(f1.get('prepared'), undefined, 'nothing prepared after the incident')
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.paused], ['halted', true])
    assert.match(row.notes, /check --expect/)
    assert.deepEqual(titles(fx, 'Now'), ['item A'], '## Now as it stands')
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 1: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
    assert.ok(stateText(fx).includes('  - notes: a person typed this\n'), 'the person\'s edit stays')
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now'])
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
  })

  test('an interrupted item whose id two other items also carry is now-conflict: the item-edit incident, every copy kept, ## Now left as it stands (R29)', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'prepared', ...work('lost') })
    // A person copied item A's id onto two backlog items: no single interrupted move to clear,
    // and no copy the loop may requeue over the others.
    editState(fx, text => text.replace('## Backlog\n', `## Backlog\n- [ ] P1 ${DOT} item X ${DOT} class: mechanical\n  - id: ${A}\n  - origin: human\n- [ ] P1 ${DOT} item Y ${DOT} class: mechanical\n  - id: ${A}\n  - origin: human\n`))
    const before = stateText(fx)
    const f2 = await run(fx, work('two'))
    assert.ok(f2.get('incident'), f2.describe())
    assert.equal(f2.get('incident').detail, `now-conflict: ${A}: several-carriers`)
    assert.deepEqual(f2.get('incident').conflict.carriers.map(c => c.section), ['Backlog', 'Backlog'])
    assert.equal(f2.get('planned'), undefined, 'the incident came in the planner\'s actions')
    assert.equal(f2.get('requeue-inserted'), undefined, 'no requeue')
    assert.equal(f2.get('picked'), undefined, 'nothing picked after the incident')
    const row = ledger(fx).at(-1)
    assert.deepEqual([row.outcome, row.paused, row.item_id], ['halted', true, null])
    assert.match(row.notes, /item edits: incident: now-conflict/)
    assert.deepEqual(titles(fx, 'Now'), ['item A'], '## Now as it stands')
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 2: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
  })

  test('the Now to Done move killed after its insertion, then the ## Now copy amended: now-conflict pauses with both copies kept; the owner keeps one and the loop goes on (Codex g2#3)', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'done-inserted', attempts: [{ ops: EDIT }] })
    editState(fx, text => text.replace(`## Now\n${itemHead('item A').join('\n')}\n`, `## Now\n${itemHead('item A').join('\n')}\n  - notes: also handle the empty case\n`))
    const before = stateText(fx)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('incident')?.detail, `now-conflict: ${A}: digest-differs`, f2.describe())
    assert.deepEqual(item(fx, A).map(i => [i.section, i.notes]), [['Now', 'also handle the empty case'], ['Done', '']], 'the amendment is kept, never cleared')
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 2: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
    assert.deepEqual([ledger(fx).at(-1).outcome, ledger(fx).at(-1).paused], ['halted', true])
    // The owner keeps the amended copy: it goes back to ## Backlog and runs again.
    editState(fx, text => {
      const st = parseState(text)
      const done = st.items.find(i => i.section === 'Done' && i.id === A)
      const lines = text.split('\n')
      lines.splice(done.start, done.end - done.start, '(empty)')
      return lines.join('\n')
    })
    unpause(fx)
    const f3 = await run(fx, work('three'))
    assert.deepEqual(f3.get('planned').plan.actions.slice(0, 1), ['requeue-now'])
    assert.equal(f3.get('picked').pick.id, A)
    assert.deepEqual(item(fx, A).map(i => [i.section, i.notes]), [['Done', 'also handle the empty case']])
  })

  test('the Now to Done move with the ## Now copy amended between its insertion and its deletion, in the same firing: the deletion fails, the item-edit incident keeps both copies (Codex closing g3#1, F6)', T, async t => {
    // The deletion's old text is the source block as read before the insertion: an amendment
    // made after that read is never deleted unseen while ## Done keeps the original, whose
    // digest `check --item` would still accept, and which would release A's dependents.
    const fx = project(t)
    const f1 = start(fx, { gates: ['done-inserted'], attempts: [{ ops: EDIT }] })
    await f1.event('done-inserted')
    editState(fx, text => text.replace(`## Now\n${itemHead('item A').join('\n')}\n`, `## Now\n${itemHead('item A').join('\n')}\n  - notes: also handle the empty case\n`))
    const before = stateText(fx)
    go(fx, 'done-inserted')
    const { exit } = await f1.ended()
    assert.deepEqual(exit, { code: 0, signal: null }, f1.describe())
    assert.ok(f1.get('incident'), `the deletion went through over the amendment: ${f1.describe()}`)
    assert.equal(f1.get('done-moved'), undefined, 'no deletion after the amendment')
    assert.deepEqual(item(fx, A).map(i => [i.section, i.notes]), [['Now', 'also handle the empty case'], ['Done', '']], 'both copies, the amendment kept')
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 1: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
    const row = ledger(fx).at(-1)
    assert.deepEqual([row.outcome, row.paused, row.item_id], ['halted', true, A])
    assert.match(row.notes, /item edits: incident: edit: old occurs 0 times/)
    // The owner unpauses without resolving the pair: the next firing's planner reports it as
    // now-conflict and nothing is picked, so no dependent of A starts past the amendment.
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('incident')?.detail, `now-conflict: ${A}: digest-differs`, f2.describe())
    assert.equal(f2.get('picked'), undefined, 'nothing picked while the copies differ')
    assert.deepEqual(item(fx, A).map(i => [i.section, i.notes]), [['Now', 'also handle the empty case'], ['Done', '']])
  })

  test('the pick killed after its insertion, then a prerequisite added to the ## Now copy: now-conflict (blocked-by-differs), the prerequisite never discarded (Codex fix1-g2#1, R29a)', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'pick-edit-1', ...work('lost') })
    const B = idOf('item B')
    editState(fx, text => text.replace(`## Now\n${itemHead('item A').join('\n')}\n`, `## Now\n${itemHead('item A').join('\n')}\n  - blocked-by: ${B}\n`))
    const before = stateText(fx)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('incident')?.detail, `now-conflict: ${A}: blocked-by-differs`, f2.describe())
    assert.equal(f2.get('picked'), undefined, 'nothing picked after the incident')
    assert.deepEqual(item(fx, A).map(i => [i.section, i.blockedBy]), [['Now', B], ['Backlog', null]], 'the prerequisite is kept, never cleared')
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 2: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
    assert.deepEqual([ledger(fx).at(-1).outcome, ledger(fx).at(-1).paused], ['halted', true])
  })

  test('a decided entry whose id a stale Backlog block also carries on a raw `ID:` line: the release skips it as ambiguous-carrier, the entry stays and no copy gets the decision (Codex fix1-g1#2, R30a)', T, async t => {
    const fx = project(t, { items: ['item B', 'item C'] })
    editState(fx, text => text
      .replace('## Backlog\n', `## Backlog\n- [ ] item A (stale copy) ${DOT} class: unclassified\n  - ID: ${A}\n  - origin: human\n`)
      .replace('## Blocked\n(empty)\n', `## Blocked\n- [ ] item A ${DOT} attempts: 2 ${DOT} attempt failed twice\n  - id: ${A}\n  - origin: human\n  - recovery: ${'a'.repeat(64)}\n`)
      .replace('## Needs decision\n(empty)\n', `## Needs decision\n### ${A} ${DOT} item A\n**Recommendation:** split it\n**Decision:** split it in two\n`))
    const f = await run(fx, work('one'))
    const skip = f.get('picked')?.pick.skipped.find(s => s.id === A)
    assert.equal(skip?.reason, 'ambiguous-carrier', f.describe())
    assert.deepEqual(f.get('picked').pick.released, [])
    assert.equal(f.get('picked').pick.id, idOf('item B'))
    const notes = ledger(fx).at(-1).notes.split('; ')
    assert.ok(notes.some(n => n.startsWith(`skipped ${A} item A: ambiguous-carrier (`)), ledger(fx).at(-1).notes)
    assert.deepEqual(item(fx, A).map(i => [i.section, i.decision]), [['Blocked', '']], 'the Blocked item gets no decision')
    assert.ok(stateText(fx).includes(`  - ID: ${A}\n`), 'the stale copy is left as it was')
    assert.deepEqual(titles(fx, 'Needs decision'), ['item A'], 'the entry stays')
  })

  test('## Now holding a second item beside an interrupted move: now-conflict, nothing deleted, the second item kept (Codex g2#4)', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'pick-edit-1', ...work('lost') })
    const B = idOf('item B')
    editState(fx, text => text.replace(`## Now\n${itemHead('item A').join('\n')}\n`, `## Now\n${itemHead('item A').join('\n')}\n- [ ] P1 ${DOT} item N ${DOT} class: mechanical\n  - id: ${idOf('item N')}\n  - origin: human\n`))
    const before = stateText(fx)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('incident')?.detail, `now-conflict: ${A}: several-now-items`, f2.describe())
    assert.deepEqual(titles(fx, 'Now'), ['item A', 'item N'], 'neither ## Now item is deleted')
    assert.deepEqual(item(fx, A).map(i => i.section), ['Now', 'Backlog'])
    assert.deepEqual(item(fx, B).map(i => i.section), ['Backlog'])
    const changed = stateText(fx).split('\n').filter(l => !before.split('\n').includes(l))
    assert.ok(changed.every(l => l.startsWith('- generation 2: halted')), `only ## Last run changed: ${JSON.stringify(changed)}`)
  })

  test('an analysis whose follow-up exists from an interrupted firing: followup answers reused: true with no edits, a success; the follow-up exists once (Codex g3#3)', T, async t => {
    const fx = project(t)
    const fu = { title: 'follow A', notes: 'the rest of A' }
    const f1 = await interrupt(fx, { stop: 'followed', path: 'analysis', followup: fu })
    assert.equal(f1.get('followed').out.reused, false, 'a first creation: reused false, one insertion')
    assert.equal(f1.get('followed').out.edits.length, 1)
    const f2 = await run(fx, { path: 'analysis', followup: fu })
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now'])
    assert.equal(f2.get('picked').pick.id, A, 'the requeued analysis sits at the top of ## Backlog')
    assert.deepEqual([f2.get('followed').out.reused, f2.get('followed').out.edits], [true, []])
    assert.equal(f2.get('incident'), undefined, f2.describe())
    const row = ledger(fx).at(-1)
    assert.deepEqual([row.outcome, row.commits, row.item_id], ['done', [], A])
    const follow = parseState(stateText(fx)).items.filter(i => i.origin === `loop from ${A}`)
    assert.deepEqual(follow.map(i => [i.section, i.title]), [['Backlog', 'follow A']])
    assert.ok(row.notes.split('; ').includes(`analysis \u2192 ${follow[0].id}`), row.notes)
    assertRecovered(fx, { clone: false, rows: [2], sections: { Done: ['item A'], Backlog: ['follow A', 'item B', 'item C', 'item D'] } })
  })

  test('a refusal of normalize (crlf) is the item-edit incident: halted, paused, note "item edits", STATE.md untouched, nothing prepared', T, async t => {
    const fx = project(t)
    editState(fx, text => text.replace(/\n/g, '\r\n'))
    const before = stateText(fx)
    const f1 = await run(fx, work('lost'))
    assert.ok(f1.get('incident'), f1.describe())
    assert.equal(f1.get('picked'), undefined, 'nothing picked after the incident')
    assert.equal(f1.get('prepared'), undefined, 'nothing prepared after the incident')
    const row = ledger(fx)[0]
    assert.deepEqual([row.outcome, row.paused, row.item_id], ['halted', true, null])
    assert.match(row.notes, /item edits: incident: normalize: crlf/)
    assert.equal(stateText(fx), before, 'a file the item grammar refuses is left as it is')
    editState(fx, text => text.replace(/\r/g, ''))
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
  })
})
