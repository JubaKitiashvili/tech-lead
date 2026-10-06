// tests/loop/loop-interrupt-items.test.mjs
// Stage 0c-3 brief section 8, Interruption: after each edit of a pick, of a release, of
// normalize and of each prose move (## Now to ## Done, ## Now to ## Blocked, the requeue, the
// delegate-flagged move), the next firing's recovery planner and pick neither lose nor duplicate
// the item (R14, R20 clear-now).
//
// Each case writes STATE.md as the interrupted firing left it (the operation's edits applied up
// to edit k, k = 0 .. all), then plays the next firing's STATE.md part through the real CLIs as
// the prose does: loop-recover.mjs and its clear-now edits (the planner's own anchored deletion,
// R29) or requeue-now move, then loop-items.mjs
// normalize and pick, each plan applied edit by edit and confirmed with `check --expect`. The
// moves are tests/fixtures/firing-moves.mjs's, the same the firing driver makes. The whole
// firing, killed at these points, is tests/loop/loop-interrupt-clone-items.test.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DOT, SCRIPTS, idOf, itemLines, project, stateMd } from './interrupt-fixture.mjs'
import { parseState } from '../../scripts/lib/loop-state.mjs'
import {
  blockedBlock, carriers, deleteAsRead, doneBlock, editOnce, findItem, insertTop, nowBlock, upsertEntry, withField,
} from '../fixtures/firing-moves.mjs'

const T = { timeout: 60000 }
const A = idOf('item A')
const B = idOf('item B')
const SHA = 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe'
const PLACEHOLDER_DECISION = '**Decision:** (fill in to release the task back to the backlog)'
const STATE = fx => path.join(fx.S, 'STATE.md')
const read = fx => fs.readFileSync(STATE(fx), 'utf8')

function cli(fx, script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: fx.env })
  let out = null
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* null */ }
  return { status: r.status, out, stderr: r.stderr }
}
const items = (fx, ...args) => cli(fx, 'loop-items.mjs', [args[0], fx.P, ...args.slice(1)])
function edit(fx, e) {
  fs.writeFileSync(STATE(fx), editOnce(read(fx), e))
}
// A plan's edits applied one by one, then `check --expect` (R14).
function applyPlan(fx, out) {
  for (const e of out.edits) edit(fx, e)
  const c = items(fx, 'check', '--expect', out.expect_sha256)
  assert.equal(c.status, 0, JSON.stringify(c.out))
}

// The next firing's STATE.md part: loop section 1 step 5 (clear-now, requeue-now), then
// section 3 (normalize, pick). Returns {plan, pick}.
function nextFiring(fx) {
  const plan = cli(fx, 'loop-recover.mjs', [fx.P, '--generation', '1'])
  assert.equal(plan.status, 0, JSON.stringify(plan.out) + plan.stderr)
  for (const a of plan.out.actions) {
    // R29: the planner's anchored deletion of the one ## Now block, applied and checked.
    if (a === 'clear-now') applyPlan(fx, plan.out.clear)
    else if (a === 'now-conflict') assert.fail(`now-conflict: ${JSON.stringify(plan.out.conflict)}`)
    else if (a === 'requeue-now') {
      // The deletion is taken from the block as read, before the insertion (F6).
      const del = deleteAsRead(read(fx), nowBlock(read(fx)))
      edit(fx, insertTop(read(fx), 'Backlog', nowBlock(read(fx)).lines))
      edit(fx, del)
    }
  }
  const nz = items(fx, 'normalize')
  assert.equal(nz.status, 0, JSON.stringify(nz.out))
  applyPlan(fx, nz.out)
  const pk = items(fx, 'pick')
  assert.equal(pk.status, 0, JSON.stringify(pk.out))
  applyPlan(fx, pk.out)
  return { plan: plan.out, pick: pk.out }
}

// The edits of an operation, made one by one from `text`: each step is a function of the text
// as the previous edits left it (as the main session reads the file before each Edit).
function sequence(text, steps) {
  const edits = []
  for (const step of steps) {
    const e = step(text)
    edits.push(e)
    text = editOnce(text, e)
  }
  return edits
}

// Every item's title, sorted; and the same with the copies of one id counted once (the items
// the interrupted file holds): an item lost or left copied shows as a difference.
const titlesOf = text => parseState(text).items.map(i => i.title).sort()
function identities(text) {
  const seen = new Set()
  return parseState(text).items.filter(i => !i.id || (!seen.has(i.id) && seen.add(i.id))).map(i => i.title).sort()
}

const heading = (id, title) => `### ${id} ${DOT} ${title}`
const flagEntry = (id, title, decision = null) => [
  heading(id, title), '**Flagged by:** fast-worker - the delegate stopped on a judgment call',
  decision === null ? PLACEHOLDER_DECISION : `**Decision:** ${decision}`]
// STATE.md with the given section bodies (defaults: (empty)).
function stateWith({ now, backlog, nd, blocked, done }) {
  const base = stateMd([])
  const put = (text, name, body) => (body ? text.replace(`## ${name}\n(empty)\n`, `## ${name}\n${body.join('\n')}\n`) : text)
  return put(put(put(put(put(base, 'Now', now), 'Backlog', backlog), 'Needs decision', nd), 'Blocked', blocked), 'Done', done)
}

// The text after the pick of item A from the plain backlog.
function pickedText(t) {
  const fx = project(t, { items: ['item A', 'item B', 'item C'] })
  const pk = items(fx, 'pick')
  assert.equal(pk.out.id, A)
  applyPlan(fx, pk.out)
  return read(fx)
}

// Runs each prefix of `edits` over `start`, then the next firing; check(k, result, text).
async function eachPrefix(t, start, edits, check) {
  for (let k = 0; k <= edits.length; k++) {
    await t.test(`after edit ${k} of ${edits.length}`, st => {
      const fx = project(st, { items: [] })
      fs.writeFileSync(STATE(fx), edits.slice(0, k).reduce(editOnce, start))
      const before = identities(read(fx))
      const res = nextFiring(fx)
      const text = read(fx)
      assert.deepEqual(titlesOf(text), before, 'no item lost or duplicated')
      const got = parseState(text).items.map(i => i.id)
      assert.equal(new Set(got).size, got.length, `an id carried twice: ${JSON.stringify(got)}`)
      check(k, res, text)
    })
  }
}
// Exactly one item carries `id`, in `section`.
const onceIn = (text, id, section) => assert.deepEqual(carriers(text, id).map(i => i.section), [section], text)

describe('interruption: the next firing neither loses nor duplicates the item', { concurrency: 4 }, () => {
  test('a pick (## Backlog to ## Now): insert first, then the deletion', T, async t => {
    const fx = project(t, { items: ['item A', 'item B', 'item C'] })
    const start = read(fx)
    const pk = items(fx, 'pick')
    assert.equal(pk.out.edits.length, 2)
    await eachPrefix(t, start, pk.out.edits, (k, res, text) => {
      // After the insertion the copy in ## Now is cleared (clear-now); after the deletion the
      // item sits in ## Now alone and is requeued; either way it is picked again, once.
      assert.deepEqual(res.plan.actions, [[], ['clear-now'], ['requeue-now']][k])
      assert.equal(res.pick.id, A)
      onceIn(text, A, 'Now')
      onceIn(text, B, 'Backlog')
    })
  })

  test('a release from ## Backlog (decision copied, status cleared, class hard, entry deleted), then the pick', T, async t => {
    const start = stateWith({
      backlog: [...itemLines({ title: 'item A', sub: ['  - status: waiting-decision'] }), ...itemLines('item B')],
      nd: flagEntry(A, 'item A', 'take the left one'),
    })
    const fx = project(t, { items: [] })
    fs.writeFileSync(STATE(fx), start)
    const pk = items(fx, 'pick')
    assert.deepEqual([pk.out.state, pk.out.id, pk.out.from, pk.out.released], ['picked', A, 'decision', [A]])
    assert.ok(pk.out.edits.length >= 3, JSON.stringify(pk.out.edits))
    await eachPrefix(t, start, pk.out.edits, (k, res, text) => {
      assert.equal(res.pick.id, A)
      onceIn(text, A, 'Now')
      const a = findItem(text, A)
      assert.equal(a.decision, 'take the left one', 'the decision once, never doubled')
      assert.equal(a.status, null)
      assert.equal(a.class, 'hard')
      assert.deepEqual(parseState(text).entries, [], 'the entry is gone')
    })
  })

  test('a release from ## Blocked with an earlier decision (appended with "; then:", moved to the top of ## Backlog), then the pick', T, async t => {
    const blockedA = [`- [ ] item A ${DOT} attempts: 2 ${DOT} attempt failed twice`, `  - id: ${A}`, '  - origin: human', '  - decision: first',
      `  - recovery: ${'a'.repeat(64)}`]
    const start = stateWith({
      backlog: itemLines('item B'),
      blocked: blockedA,
      nd: [heading(A, 'item A'), '**Recommendation:** the second way', '**Decision:** second,', 'and quickly'],
    })
    const fx = project(t, { items: [] })
    fs.writeFileSync(STATE(fx), start)
    const pk = items(fx, 'pick')
    assert.deepEqual([pk.out.state, pk.out.id, pk.out.from], ['picked', A, 'decision'])
    await eachPrefix(t, start, pk.out.edits, (k, res, text) => {
      assert.equal(res.pick.id, A)
      onceIn(text, A, 'Now')
      assert.equal(findItem(text, A).decision, 'first; then: second, and quickly')
      assert.deepEqual(parseState(text).entries, [])
      assert.deepEqual(parseState(text).items.filter(i => i.section === 'Blocked'), [])
    })
  })

  test('normalize: ids minted by an interrupted plan are kept, the rest minted, none twice', T, async t => {
    const start = stateMd([{ title: 'item A', id: null, origin: null }, { title: 'item B', id: null, origin: null }, { title: 'item C', id: null }])
    const fx = project(t, { items: [] })
    fs.writeFileSync(STATE(fx), start)
    const nz = items(fx, 'normalize')
    assert.equal(nz.out.minted.length, 3)
    await eachPrefix(t, start, nz.out.edits, (k, res, text) => {
      const written = parseState(nz.out.edits.slice(0, k).reduce(editOnce, start)).items.filter(i => i.id).map(i => [i.title, i.id])
      const now = parseState(text).items
      for (const [title, id] of written) assert.equal(now.find(i => i.title === title).id, id, `${title} keeps the id written before the interruption`)
      const got = now.map(i => i.id)
      assert.ok(got.every(Boolean) && new Set(got).size === 3, JSON.stringify(got))
      assert.ok(now.every(i => i.origin), 'every origin filled')
      assert.equal(res.pick.title, 'item A')
      assert.equal(now.find(i => i.section === 'Now').title, 'item A')
    })
  })

  // The prose moves start from item A picked into ## Now. Each move is two edits, as the prose
  // makes them (loop "Item edits", Moving an item; F6): the deletion is taken from the ## Now
  // block as read before the insertion, and applied after it.
  const move = insert => {
    let del = null
    return [tx => {
      del = deleteAsRead(tx, nowBlock(tx))
      return insert(tx)
    }, () => del]
  }
  const moves = {
    'Now to Done': () => move(tx => insertTop(tx, 'Done', doneBlock(nowBlock(tx), SHA, '2026-10-02'))),
    'Now to Blocked': () => move(tx => insertTop(tx, 'Blocked', blockedBlock(nowBlock(tx), { reason: 'attempt failed twice', recovery: 'b'.repeat(64) }))),
    'the requeue (Now back to the top of Backlog)': () => move(tx => insertTop(tx, 'Backlog', nowBlock(tx).lines)),
    'the delegate-flagged move (entry, Now to Backlog as waiting-decision)': () => [
      tx => upsertEntry(tx, A, flagEntry(A, 'item A')),
      ...move(tx => insertTop(tx, 'Backlog', withField(nowBlock(tx).lines, 'status', 'waiting-decision'))),
    ],
  }
  // By the number of edits applied: the planner's actions, where item A is after the next
  // firing, and the item it picked. Before any edit ## Now holds the item alone (requeue-now,
  // and it is picked again); between the insertion and the deletion clear-now drops the ## Now
  // copy; once moved, the planner has nothing to do.
  const expect = {
    'Now to Done': k => [[['requeue-now'], 'Now', A], [['clear-now'], 'Done', B], [[], 'Done', B]][k],
    'Now to Blocked': k => [[['requeue-now'], 'Now', A], [['clear-now'], 'Blocked', B], [[], 'Blocked', B]][k],
    'the requeue (Now back to the top of Backlog)': k => [[['requeue-now'], 'Now', A], [['clear-now'], 'Now', A], [[], 'Now', A]][k],
    // The entry is written first: interrupted there, the item is requeued with its status
    // unchanged and runs again, and the next flag replaces the entry (an upsert by id).
    'the delegate-flagged move (entry, Now to Backlog as waiting-decision)': k =>
      [[['requeue-now'], 'Now', A], [['requeue-now'], 'Now', A], [['clear-now'], 'Backlog', B], [[], 'Backlog', B]][k],
  }
  for (const [name, steps] of Object.entries(moves)) {
    test(`a prose move, ${name}: insert first, keep the whole block`, T, async t => {
      const start = pickedText(t)
      const edits = sequence(start, steps())
      await eachPrefix(t, start, edits, (k, res, text) => {
        const [actions, where, picked] = expect[name](k)
        assert.deepEqual(res.plan.actions, actions)
        assert.equal(res.pick.id, picked)
        onceIn(text, A, where)
        if (where !== 'Now') {
          // The whole block moved: id and origin kept.
          assert.equal(findItem(text, A).origin, 'human')
        }
      })
    })
  }
})
