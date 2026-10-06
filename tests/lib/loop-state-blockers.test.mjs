// tests/lib/loop-state-blockers.test.mjs
// The blocker test (stage 0c-3 brief R10, R11, R12): a blocker id is finished only when no
// open item has it, `## Done` or the ledger records it done, and no open item descends from it
// through `loop from` origins (open items', Done items' and the ledger's). Title, unknown and
// self blockers park their item with a note. cx-lr07 and cx-lp11 are the audit cases. Closing
// fix F8: for a dependent's own blocker, the walk leaves out the dependent and what descends from
// it through the dependent alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ledgerItems } from '../../scripts/lib/ledger.mjs'
import { blockerStatus, eligibility, itemDigest, itemProblems, parseState } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, D, E, F, blockedItem, doneItem, ledger, open, state } from './loop-state-fixture.mjs'

const dep = (blocker, extra = {}) => open('dependent', { id: D, blockedBy: blocker, ...extra })
const reason = (st, L = ledger()) => eligibility(st, { ledger: L, level: 3 }).find(r => r.id === D).reason
const ledgerDir = (t, rows) => {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-blockers-'))
  t.after(() => fs.rmSync(S, { recursive: true, force: true }))
  fs.writeFileSync(path.join(S, 'LEDGER.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return ledgerItems(S)
}

test('finished via ## Done', () => {
  const st = parseState(state({ backlog: dep(B), done: doneItem('the blocker', { id: B }) }))
  assert.equal(blockerStatus(st, B, ledger()), 'finished')
  assert.equal(reason(st), null)
})

test('finished via a ledger done row, after ## Done was trimmed', t => {
  const L = ledgerDir(t, [{ outcome: 'done', task: 'the blocker', item_id: B, item_origin: 'human' }])
  const st = parseState(state({ backlog: dep(B) }))
  assert.equal(blockerStatus(st, B, L), 'finished')
  assert.equal(reason(st, L), null)
  // A row with another outcome only makes the id known.
  const L2 = ledgerDir(t, [{ outcome: 'failed', task: 'the blocker', item_id: B }])
  assert.equal(blockerStatus(st, B, L2), 'unfinished')
  assert.equal(reason(st, L2), 'blocked')
})

test('finished via a recovered finish-commit', t => {
  const L = ledgerDir(t, [{ outcome: 'skipped', task: null, item_id: null, recovered: { action: 'finish-commit', item_id: B, item_origin: 'human' } }])
  const st = parseState(state({ backlog: dep(B) }))
  assert.equal(blockerStatus(st, B, L), 'finished')
  // requeue-now does not finish it.
  const L2 = ledgerDir(t, [{ outcome: 'skipped', recovered: { action: 'requeue-now', item_id: B } }])
  assert.equal(blockerStatus(st, B, L2), 'unfinished')
})

test('unfinished while the blocker is open, in each open section, whatever Done and the ledger say', () => {
  const L = ledger({ done: [B] })
  for (const where of [{ now: open('the blocker', { id: B }) }, { backlog: open('the blocker', { id: B }) }, { blocked: blockedItem('the blocker', { id: B }) }]) {
    const st = parseState(state({ ...where, backlog: [...(where.backlog ?? []), ...dep(B)], done: doneItem('old copy', { id: E }) }))
    assert.equal(blockerStatus(st, B, L), 'unfinished', Object.keys(where)[0])
    assert.equal(reason(st, L), 'blocked')
  }
})

test('a done blocker stays unfinished while an open loop from child exists, in each open section', () => {
  for (const key of ['now', 'backlog', 'blocked']) {
    const child = key === 'blocked' ? blockedItem('follow-up', { id: C, origin: `loop from ${B}` }) : open('follow-up', { id: C, origin: `loop from ${B}` })
    const parts = { backlog: dep(B), done: doneItem('analysis', { id: B, sha: null }) }
    parts[key] = [...(parts[key] ?? []), ...child]
    const st = parseState(state(parts))
    assert.equal(blockerStatus(st, B, ledger()), 'unfinished', key)
    assert.equal(reason(st), 'blocked')
  }
  // Once the child is done too, the analysis is finished.
  const st = parseState(state({ backlog: dep(B), done: [...doneItem('follow-up', { id: C, origin: `loop from ${B}` }), ...doneItem('analysis', { id: B, sha: null })] }))
  assert.equal(blockerStatus(st, B, ledger()), 'finished')
})

test('the chain runs through a Done follow-up to an open grandchild', () => {
  const st = parseState(state({
    backlog: [...open('grandchild', { id: E, origin: `loop from ${C}` }), ...dep(B)],
    done: [...doneItem('follow-up', { id: C, origin: `loop from ${B}` }), ...doneItem('analysis', { id: B })],
  }))
  assert.equal(blockerStatus(st, B, ledger()), 'unfinished')
  assert.equal(blockerStatus(st, C, ledger()), 'unfinished')
})

test('the chain runs through ledger origins after a trim', t => {
  // The follow-up C was trimmed from ## Done; only the ledger still records its origin.
  const L = ledgerDir(t, [
    { outcome: 'done', item_id: B, item_origin: 'human' },
    { outcome: 'done', item_id: C, item_origin: `loop from ${B}` },
  ])
  const st = parseState(state({ backlog: [...open('grandchild', { id: E, origin: `loop from ${C}` }), ...dep(B)], done: doneItem('analysis', { id: B }) }))
  assert.equal(blockerStatus(st, B, L), 'unfinished')
  // Without the ledger's origin the walk cannot see the link.
  assert.equal(blockerStatus(st, B, ledger({ done: [B, C] })), 'finished')
})

test('the reopened grandchild: P -> F -> G all done, F trimmed, G reopened, so P is unfinished', t => {
  const P = A, Fid = C, Gid = E
  const L = ledgerDir(t, [
    { outcome: 'done', item_id: P, item_origin: 'human' },
    { outcome: 'done', item_id: Fid, item_origin: `loop from ${P}` },
    { outcome: 'done', item_id: Gid, item_origin: `loop from ${Fid}` },
  ])
  const before = parseState(state({ backlog: dep(P), done: [...doneItem('G', { id: Gid, origin: `loop from ${Fid}` }), ...doneItem('P', { id: P })] }))
  assert.equal(blockerStatus(before, P, L), 'finished')
  // G is reopened: its whole block moves back to ## Backlog.
  const after = parseState(state({ backlog: [...open('G', { id: Gid, origin: `loop from ${Fid}` }), ...dep(P)], done: doneItem('P', { id: P }) }))
  assert.equal(blockerStatus(after, P, L), 'unfinished')
  assert.equal(reason(after, L), 'blocked')
})

test('a loop from cycle parks its members and the walk terminates', () => {
  const st = parseState(state({
    backlog: [...open('x', { id: A, origin: `loop from ${B}` }), ...open('y', { id: B, origin: `loop from ${A}` }), ...dep(F), ...open('z', { id: E })],
    done: doneItem('f', { id: F, origin: `loop from ${F}` }),
  }))
  const cyc = itemProblems(st, ledger()).filter(r => r.kind === 'origin-cycle').map(r => r.id).sort()
  assert.deepEqual(cyc, [A, B, F].sort())
  const rows = eligibility(st, { ledger: ledger(), level: 3 })
  assert.deepEqual(rows.map(r => [r.id, r.reason]), [[A, 'origin-cycle'], [B, 'origin-cycle'], [D, null], [E, null]])
  assert.equal(blockerStatus(st, F, ledger()), 'finished')
  // A cycle through the ledger's origins terminates too.
  const L = ledger({ done: [C], origins: { [C]: `loop from ${E}`, [E]: `loop from ${C}` } })
  const st2 = parseState(state({ backlog: [...open('e', { id: E, origin: `loop from ${C}` }), ...dep(B)], done: doneItem('b', { id: B }) }))
  assert.equal(blockerStatus(st2, B, L), 'finished')
  assert.equal(blockerStatus(st2, C, L), 'unfinished')
  assert.ok(itemProblems(st2, L).some(r => r.kind === 'origin-cycle' && r.id === E))
})

test('legacy ledger rows (no item_id) never satisfy a blocker', t => {
  const L = ledgerDir(t, [{ outcome: 'done', task: 'the blocker' }, { outcome: 'done', task: B }])
  assert.equal(L.doneIds.size, 0)
  const byId = parseState(state({ backlog: dep(B) }))
  assert.equal(blockerStatus(byId, B, L), 'unknown')
  assert.equal(reason(byId, L), 'unknown-blocker')
  const byTitle = parseState(state({ backlog: dep('the blocker') }))
  assert.equal(reason(byTitle, L), 'title-blocker')
})

test('cx-lr07: a reused title never finishes a blocker', t => {
  // "fix the parser" was done once (A); a new item reuses the title (B) and is still open.
  const L = ledgerDir(t, [{ outcome: 'done', task: 'fix the parser', item_id: A, item_origin: 'human' }])
  const st = parseState(state({
    backlog: [...open('fix the parser', { id: B }), ...dep(B)],
    done: doneItem('fix the parser', { id: A }),
  }))
  assert.equal(blockerStatus(st, B, L), 'unfinished')
  assert.equal(reason(st, L), 'blocked')
  assert.equal(blockerStatus(st, A, L), 'finished')
})

test('cx-lp11: two items with one title keep separate identities', () => {
  const st = parseState(state({
    backlog: [...open('fix the parser', { id: B, notes: 'n' }), ...dep(A)],
    done: doneItem('fix the parser', { id: A, notes: 'n' }),
  }))
  const [open1] = st.items.filter(i => i.id === B), [done1] = st.items.filter(i => i.id === A)
  assert.notEqual(itemDigest(open1), itemDigest(done1))
  assert.equal(blockerStatus(st, A, ledger()), 'finished')
  assert.equal(blockerStatus(st, B, ledger()), 'unfinished')
  assert.equal(reason(st), null)
  // Two open items with one title are both parked, and still two ids.
  const two = parseState(state({ backlog: [...open('fix the parser', { id: A }), ...open('Fix the parser', { id: B })] }))
  assert.deepEqual(eligibility(two, { ledger: ledger(), level: 3 }).map(r => [r.id, r.reason]), [[A, 'duplicate-title'], [B, 'duplicate-title']])
})

test('title, unknown and self blockers park the item with a note and the candidate', () => {
  const probs = st => itemProblems(st, ledger()).filter(r => r.id === D)
  // One open item has the title: it is the candidate.
  let st = parseState(state({ backlog: [...open('Fix The Parser', { id: B }), ...dep('fix the parser')], done: doneItem('fix the parser', { id: A }) }))
  let [p] = probs(st).filter(r => r.kind === 'title-blocker')
  assert.equal(p.candidate, B)
  assert.match(p.detail, new RegExp(`candidate ${B}`))
  assert.equal(reason(st), 'title-blocker')
  // No open match, exactly one Done item: the candidate, with the analysis hint for a dash sha.
  st = parseState(state({ backlog: dep('analyse the cache'), done: doneItem('analyse the cache', { id: A, sha: null }) }))
  ;[p] = probs(st).filter(r => r.kind === 'title-blocker')
  assert.equal(p.candidate, A)
  assert.match(p.detail, /an analysis item; its follow-up may still be open/)
  st = parseState(state({ backlog: dep('ship it'), done: doneItem('ship it', { id: A }) }))
  ;[p] = probs(st).filter(r => r.kind === 'title-blocker')
  assert.equal(p.candidate, A)
  assert.doesNotMatch(p.detail, /analysis/)
  // Two matches, or several ids: no candidate.
  st = parseState(state({ backlog: [...open('dup', { id: A }), ...open('dup', { id: B }), ...dep('dup')] }))
  assert.equal(probs(st).find(r => r.kind === 'title-blocker').candidate, null)
  st = parseState(state({ backlog: dep(`${A}, ${B}`) }))
  assert.equal(reason(st), 'title-blocker')
  // An id nothing carries; the item's own id.
  st = parseState(state({ backlog: dep(E) }))
  assert.equal(reason(st), 'unknown-blocker')
  assert.match(probs(st).find(r => r.kind === 'unknown-blocker').detail, new RegExp(E))
  assert.equal(reason(parseState(state({ backlog: dep(E) })), ledger({ ids: [E] })), 'blocked')
  st = parseState(state({ backlog: dep(D) }))
  assert.equal(reason(st), 'self-blocker')
  // An upper-case copy of an id is read as the id.
  st = parseState(state({ backlog: dep(B.toUpperCase()), done: doneItem('b', { id: B }) }))
  assert.equal(reason(st), null)
})

// Closing fix F8 (code-review #1): a follow-up blocked by its own parent (or a grandchild blocked
// by its grandparent) is not an open descendant holding that blocker against itself.
test('F8: a follow-up blocked by its own ancestor runs once the ancestor is done', () => {
  const L = ledger({ done: [B] })
  const ok = st => eligibility(st, { ledger: L, level: 3 }).find(r => r.id === F)
  const P = doneItem('analysis', { id: B, sha: null })
  const own = parseState(state({ backlog: open('follow-up', { id: F, origin: `loop from ${B}`, blockedBy: B }), done: P }))
  assert.equal(ok(own).ok, true)
  // The ancestor itself still reads unfinished while the follow-up is open.
  assert.equal(blockerStatus(own, B, L), 'unfinished')
  // A grandchild blocked by its grandparent, the child done.
  const grand = parseState(state({ backlog: open('grandchild', { id: F, origin: `loop from ${C}`, blockedBy: B }), done: [...doneItem('child', { id: C, origin: `loop from ${B}` }), ...P] }))
  assert.equal(ok(grand).ok, true)
  // The follow-up's own open child does not hold it; another open child of the ancestor does,
  // and so does an open block that names the ancestor directly as well as the follow-up.
  const sub = open('sub', { id: E, origin: `loop from ${F}` })
  assert.equal(ok(parseState(state({ backlog: [...open('follow-up', { id: F, origin: `loop from ${B}`, blockedBy: B }), ...sub], done: P }))).ok, true)
  const sibling = open('sibling', { id: C, origin: `loop from ${B}` })
  assert.equal(ok(parseState(state({ backlog: [...open('follow-up', { id: F, origin: `loop from ${B}`, blockedBy: B }), ...sibling], done: P }))).reason, 'blocked')
  const both = open('both', { id: E, origin: `loop from ${F}`, extra: [`  - origin: loop from ${B}`] })
  assert.equal(ok(parseState(state({ backlog: [...open('follow-up', { id: F, origin: `loop from ${B}`, blockedBy: B }), ...both], done: P }))).reason, 'blocked')
})
