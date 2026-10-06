// tests/loop/loop-interrupt-clone-commit.test.mjs
// The section 19 interruption matrix, rows around Save and reset and the commit: 18, 19, 22,
// 24-27, 31, 33, 37. Kills inside reflex-bundle.mjs save/reset and loop-clone.mjs commit are
// TECH_LEAD_FAULT=<point> on that one call; the others are driver stops. Invariants I1-I8:
// tests/loop/interrupt-fixture.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ROWS, D2, PREFIX, SCRIPTS, T, assertRecovered, bundleTree, editState, git, go, idOf, interrupt, itemHead, itemLines, ledger, patches, project,
  recordOf, run, sections, start, tipOf, titles, workSnap,
} from './interrupt-fixture.mjs'

const BRANCH = `${PREFIX}/${D2}`
const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['write', 'n/deep.txt', 'deep\n'], ['rm', 'b.txt']]
const FAILING = { attempts: [{ ops: EDIT, fail: true }, { ops: [], fail: true }] }
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
const isAncestor = (W, a, b) => spawnSync('git', ['-C', W, 'merge-base', '--is-ancestor', a, b]).status === 0
const doneLine = (fx, title) => sections(fx).Done.find(l => l.includes(` ${title} `))
// The planner's finish (R20): the commit, and the ## Now item it binds by id and digest.
const finishOf = (generation, sha, title = 'item A', n = 0) => ({ generation, sha, item_id: idOf(title, n) })
const finishSeen = p => p.finish && { generation: p.finish.generation, sha: p.finish.sha, item_id: p.finish.item_id }
const verifyCli = (fx, sha) => spawnSync(process.execPath, [path.join(SCRIPTS, 'reflex-bundle.mjs'), 'verify', fx.P, '--sha', sha], { encoding: 'utf8', env: fx.env })

describe('section 19 matrix: Save and reset and the commit', ROWS, () => {
  for (const [row, point] of [['row 18', 'save:after-check'], ['row 19', 'save:after-link']]) {
    test(`${row}: Save and reset's save killed at ${point}: the next prepare anchors a new bundle; a linked file is an orphan`, T, async t => {
      const fx = project(t)
      let snap
      await interrupt(fx, { faults: { save: point }, ...FAILING }, () => { snap = workSnap(fx.W) })
      const earlier = patches(fx)
      assert.equal(earlier.length, point === 'save:after-link' ? 1 : 0)
      assert.equal(fs.readdirSync(path.join(fx.V, 'patches')).filter(n => n.startsWith('.tmp-')).length, point === 'save:after-check' ? 1 : 0)
      assert.deepEqual(recordOf(fx, 1).saves, [], 'nothing anchored')
      const f2 = await run(fx, work('two'))
      assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now', 'note-leftovers'])
      const rec = f2.get('prepared').out.recovered
      assert.equal(rec.length, 1)
      assert.equal(earlier.includes(rec[0].sha), false, 'a new bundle, anchored')
      assert.deepEqual(fs.readdirSync(path.join(fx.V, 'patches')).filter(n => n.startsWith('.tmp-')), [], 'the dead saver\'s temp is swept')
      if (earlier.length) {
        assert.equal(verifyCli(fx, earlier[0]).status, 0, 'the orphan is a complete bundle')
        assert.deepEqual(bundleTree(fx, earlier[0]), snap)
      }
      const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], orphans: earlier.length }
      assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Blocked: [] } })
      await run(fx, work('three'))
      assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
    })
  }

  for (const point of ['reset:after-unlink-one', 'reset:after-read-tree']) {
    test(`row 22: Save and reset's reset left partial at ${point}, a half-written file included: the next prepare finishes it relaxed`, T, async t => {
      const fx = project(t)
      const f1 = start(fx, { ...FAILING, gates: ['saved'], faults: { reset: point } })
      const e = await f1.event('saved')
      const snap = workSnap(fx.W)
      const sha = e.out.sha
      go(fx, 'saved')
      await f1.event('faulted')
      fs.writeFileSync(path.join(fx.W, 'a.txt'), 'edi') // a write cut short inside the reset
      await f1.kill()
      assert.equal(recordOf(fx, 1).phase, 'resetting')
      assert.deepEqual(titles(fx, 'Blocked'), ['item A'])
      assert.ok(sections(fx).Blocked.includes(`  - recovery: ${sha}`))
      const f2 = await run(fx, work('two'))
      const p = f2.get('planned').plan
      assert.deepEqual(p.records.map(r => [r.generation, r.verdict]), [[1, 'resume-reset']])
      assert.deepEqual(p.actions, ['ledger-recovered', 'note-leftovers'])
      assert.deepEqual(f2.get('prepared').out.recovered.map(r => r.sha), [sha])
      assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
      assert.deepEqual(patches(fx), [sha])
      const ex = { work: [{ snap, via: 'bundle', sha }], sections: { Blocked: ['item A'], Done: ['item B'] } }
      assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2) })
      await run(fx, work('three'))
      assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Blocked: ['item A'], Done: ['item B', 'item C'] } })
    })
  }

  test('row 24: commit killed after its intent: the verified work is saved and the item reruns (R12)', T, async t => {
    const fx = project(t)
    let snap, base
    await interrupt(fx, { faults: { commit: 'commit:after-intent' }, attempts: [{ ops: EDIT }] }, () => {
      snap = workSnap(fx.W)
      base = tipOf(fx.W)
    })
    assert.equal(recordOf(fx, 1).phase, 'intent')
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['requeue-now', 'note-leftovers'])
    assert.deepEqual(p.records.map(r => [r.generation, r.verdict, r.sha]), [[1, 'leftovers', null]])
    const rec = f2.get('prepared').out.recovered
    assert.equal(rec.length, 1)
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f2)}~1`]), base, 'the intent never reached the branch')
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  // A commit killed after its update-ref, its index left stale: {snap, C, H0}.
  async function updateRefKilled(fx, o = {}) {
    let snap, C, H0
    await interrupt(fx, { faults: { commit: 'commit:after-update-ref' }, attempts: [{ ops: EDIT }], ...o }, () => {
      snap = workSnap(fx.W)
      C = tipOf(fx.W)
      H0 = tipOf(fx.W, 'HEAD~1')
      git(fx.W, ['read-tree', H0]) // a stale index, as if the commit's own read-tree never ran
    })
    assert.equal(recordOf(fx, 1).phase, 'intent')
    return { snap, C, H0 }
  }

  test('row 25: commit killed after its update-ref: finish-commit, ledger-recovered, write-bundle; the stale index is reset', T, async t => {
    const fx = project(t)
    const { snap, C } = await updateRefKilled(fx)
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['finish-commit', 'ledger-recovered', 'write-bundle', 'note-leftovers'])
    assert.deepEqual(finishSeen(p), finishOf(1, C))
    assert.match(p.finish.item_digest, /^[0-9a-f]{64}$/)
    assert.deepEqual(p.write_bundles, [BRANCH])
    assert.ok(doneLine(fx, 'item A').includes(C))
    assert.deepEqual(f2.get('prepared').out.recovered, [], 'nothing to save: only the index was stale')
    const row = ledger(fx)[0]
    assert.deepEqual(row.recovered.commits, [C])
    assert.ok(row.bundles.some(b => b.tip === C), JSON.stringify(row.bundles))
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f2)}~1`]), C)
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('row 26: the same with the ## Now line edited: requeue-now, the commit stays on the branch and in the bundle', T, async t => {
    const fx = project(t)
    const { snap, C } = await updateRefKilled(fx)
    editState(fx, text => text.replace(/(## Now\n- \[ \] .*)class: mechanical/, '$1class: hard'))
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['requeue-now', 'ledger-recovered', 'write-bundle', 'note-leftovers'])
    assert.equal(p.finish, null)
    assert.ok(p.notes.some(n => /not the one it recorded/.test(n)), JSON.stringify(p.notes))
    const C2 = committedSha(f2)
    assert.ok(isAncestor(fx.W, C, C2), 'the first commit stays on the branch')
    assert.ok(doneLine(fx, 'item A').includes(C2), 'the requeued item is done again with the new commit')
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: C2, sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 27: the commit killed with its bundle before the rename (bundle:before-rename)', T, async t => {
    const fx = project(t)
    let snap, C
    await interrupt(fx, { faults: { commit: 'bundle:before-rename' }, attempts: [{ ops: EDIT }] }, () => {
      snap = workSnap(fx.W)
      C = tipOf(fx.W)
    })
    assert.equal(recordOf(fx, 1).phase, 'committed')
    const out = path.join(fx.V, 'out', PREFIX)
    assert.equal(fs.existsSync(path.join(out, `${D2}.bundle`)), false)
    assert.equal(fs.readdirSync(out).filter(n => n.startsWith('.tmp-')).length, 1)
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['finish-commit', 'ledger-recovered', 'write-bundle'])
    assert.deepEqual(fs.readdirSync(out).filter(n => n.startsWith('.tmp-')), [], 'the dead writer\'s temp is swept')
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3] })
  })

  test('row 27: the commit killed once bundled (stop committed)', T, async t => {
    const fx = project(t)
    let snap, C
    await interrupt(fx, { stop: 'committed', attempts: [{ ops: EDIT }] }, (f, e) => {
      snap = workSnap(fx.W)
      C = e.out.sha
    })
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['finish-commit', 'ledger-recovered'])
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3] })
  })

  test('row 31: the recovering firing killed after its section 1 edit: the next one ends in the same state (I7)', T, async t => {
    const fx = project(t)
    const { snap, C } = await updateRefKilled(fx)
    const f2 = await interrupt(fx, { stop: 'planned', ...work('lost') })
    assert.deepEqual(f2.get('planned').plan.actions, ['finish-commit', 'ledger-recovered', 'write-bundle', 'note-leftovers'])
    assert.ok(doneLine(fx, 'item A').includes(C))
    const f3 = await run(fx, work('three'))
    const p = f3.get('planned').plan
    assert.deepEqual(p.actions, ['ledger-recovered', 'note-leftovers'], 'the item is not moved twice and the bundle is current')
    assert.deepEqual(p.recovered.commits, [C])
    assert.equal(sections(fx).Done.filter(l => l.includes(C)).length, 1)
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('row 33: a double interruption with two commits on one branch: both reach the ledger, the bundle holds both', T, async t => {
    const fx = project(t)
    let snap1, C1, C2
    await interrupt(fx, { stop: 'committed', attempts: [{ ops: EDIT }] }, (f, e) => {
      snap1 = workSnap(fx.W)
      C1 = e.out.sha
    })
    const f2 = await interrupt(fx, { stop: 'committed', ...work('two') }, (f, e) => { C2 = e.out.sha })
    assert.deepEqual(f2.get('planned').plan.actions, ['finish-commit', 'ledger-recovered'])
    assert.ok(isAncestor(fx.W, C1, C2))
    const f3 = await run(fx, work('three'))
    const p = f3.get('planned').plan
    assert.deepEqual(p.actions, ['finish-commit', 'ledger-recovered'])
    assert.deepEqual(finishSeen(p), finishOf(2, C2, 'item B'))
    assert.deepEqual(p.recovered.generations, [1, 2])
    assert.deepEqual(p.recovered.commits, [C1, C2])
    assert.ok(doneLine(fx, 'item A').includes(C1))
    assert.ok(doneLine(fx, 'item B').includes(C2))
    const ex = { work: [{ snap: snap1, via: C1 }] }
    assertRecovered(fx, { ...ex, rows: [3], tip: committedSha(f3), sections: { Done: ['item A', 'item B', 'item C'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [3, 4], sections: { Done: ['item A', 'item B', 'item C', 'item D'] } })
  })

  // Stage 0c-3: two open items with one title park each other (duplicate-title, R7), so the
  // byte-identical header is a second item a person adds to ## Backlog while the first sits in
  // ## Now; it carries another id. finish-commit binds the ## Now item by its recorded hash, id
  // and digest, and once that item is in ## Done the second one is the only open `item A`.
  test('row 37: finish-commit binds the ## Now item by its recorded hash and id, with a byte-identical second header in ## Backlog', T, async t => {
    const fx = project(t, { items: ['item A', 'item B', 'item C'] })
    const { snap, C } = await updateRefKilled(fx)
    const second = itemLines({ title: 'item A', id: idOf('item A', 1) })
    editState(fx, text => text.replace('## Backlog\n', `## Backlog\n${second.join('\n')}\n`))
    const before = sections(fx)
    assert.equal(before.Backlog[0], before.Now[0], 'the second header is byte-identical')
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(finishSeen(p), finishOf(1, C))
    assert.equal(sections(fx).Done.filter(l => l.includes(' item A ') && l.includes(C)).length, 1, 'the Now item went to Done with the commit')
    // The second item stayed in ## Backlog and is the item this firing picked.
    assert.deepEqual(f2.get('picked').item, second)
    assert.deepEqual(f2.get('picked').item, itemHead('item A', 1))
    assert.equal(sections(fx).Done.filter(l => l.includes(' item A ')).length, 2)
    const ex = { work: [{ snap, via: C }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item A'], Backlog: ['item B', 'item C'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item A', 'item B'], Backlog: ['item C'] } })
  })
})
