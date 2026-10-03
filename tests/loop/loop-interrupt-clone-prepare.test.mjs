// tests/loop/loop-interrupt-clone-prepare.test.mjs
// The section 19 interruption matrix, rows inside and around loop-clone.mjs prepare: 3-7, 32
// and 35 (rows 12-17 are in loop-interrupt-clone-recover.test.mjs). A kill inside prepare is
// TECH_LEAD_FAULT=<point> passed to that one call by the driver, which then waits to be killed
// with its session. Invariants I1-I8: tests/loop/interrupt-fixture.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ROWS, D1, D2, D3, PREFIX, T, assertRecovered, deadPid, git, headerOf, interrupt, markP, patches, project, reap, recordOf, run, tipOf,
  titles, waitFor, workSnap,
} from './interrupt-fixture.mjs'
import { groupAlive } from '../../scripts/lib/loop-proc.mjs'

const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited '.repeat(40) + '\n'], ['write', 'new1.txt', 'one\n'], ['write', 'n/new2.txt', 'two\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
const temps = dir => {
  try { return fs.readdirSync(dir).filter(n => n.startsWith('.tmp-')) } catch { return [] }
}

describe('section 19 matrix: prepare', ROWS, () => {
  for (const point of ['prepare:after-temps', 'prepare:after-locks']) {
    test(`row 3: temps and stale git locks: prepare killed at ${point}`, T, async t => {
      const fx = project(t)
      await run(fx, work('one'))
      // A dead helper's temps in each store, its partial clone, and stale git locks in <W>.
      const dead = deadPid()
      const out = path.join(fx.V, 'out', PREFIX)
      fs.writeFileSync(path.join(fx.V, 'patches', `.tmp-${dead}-0123456789abcdef`), 'partial')
      fs.writeFileSync(path.join(fx.V, 'run', `.tmp-${dead}-0123456789abcdef`), 'partial')
      fs.writeFileSync(path.join(out, `.tmp-${dead}-0123456789abcdef.bundle`), 'partial')
      const partial = path.join(fx.V, `clone.tmp-${dead}-abcd1234`)
      fs.mkdirSync(path.join(partial, '.git', 'objects'), { recursive: true })
      fs.writeFileSync(path.join(partial, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      const locks = ['index.lock', 'HEAD.lock', 'packed-refs.lock', `refs/heads/${PREFIX}/${D2}.lock`]
      for (const l of locks) fs.writeFileSync(path.join(fx.W, '.git', l), '')
      await interrupt(fx, { faults: { prepare: point }, ...work('lost') }, () => {
        for (const d of [path.join(fx.V, 'patches'), path.join(fx.V, 'run'), out]) assert.deepEqual(temps(d), [], `${d} swept`)
        assert.equal(fs.existsSync(partial), false, 'the dead helper\'s partial clone is removed (R18)')
        for (const l of locks) assert.equal(fs.existsSync(path.join(fx.W, '.git', l)), point === 'prepare:after-temps', l)
        assert.equal(recordOf(fx, 2), null, 'no record yet')
      })
      const f3 = await run(fx, work('three'))
      assert.deepEqual(f3.get('planned').plan.actions, ['requeue-now'])
      assertRecovered(fx, { rows: [1, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
      await run(fx, work('four'))
      assertRecovered(fx, { rows: [1, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
    })
  }

  for (const point of ['clone:after-clone', 'clone:before-rename']) {
    test(`row 4: the first clone killed at ${point} leaves a partial clone and a preparing record, both recovered`, T, async t => {
      const fx = project(t)
      await interrupt(fx, { faults: { prepare: point }, ...work('lost') }, () => {
        assert.equal(fs.existsSync(fx.W), false)
        assert.equal(fs.readdirSync(fx.V).filter(n => n.startsWith('clone.tmp-')).length, 1)
        assert.equal(recordOf(fx, 1).phase, 'preparing')
      })
      const f2 = await run(fx, work('two'))
      const p = f2.get('planned').plan
      assert.deepEqual(p.records.map(r => [r.generation, r.verdict]), [[1, 'no-clone']])
      assert.deepEqual(p.actions, ['requeue-now'])
      assert.equal(f2.get('prepared').out.created, true)
      assert.deepEqual(fs.readdirSync(fx.V).filter(n => n.startsWith('clone.tmp-')), [])
      assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
      await run(fx, work('three'))
      assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
    })
  }

  test('row 5: killed mid-fetch while creating the clone', T, async t => {
    const fx = project(t)
    await interrupt(fx, { faults: { prepare: 'refresh:after-fetch' }, ...work('lost') })
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('prepared').out.created, true)
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3] })
  })

  test('row 5: killed mid-fetch on an existing clone whose base advanced meanwhile', T, async t => {
    const fx = project(t)
    const c1 = committedSha(await run(fx, work('one')))
    // The owner advances main in <P> between firings.
    fs.writeFileSync(path.join(fx.P, 'm.txt'), 'm\n')
    git(fx.P, ['add', 'm.txt'])
    git(fx.P, ['commit', '-q', '-m', 'owner'])
    markP(fx)
    const main = tipOf(fx.P, 'main')
    let snap
    await interrupt(fx, { faults: { prepare: 'refresh:after-fetch' }, ...work('lost') }, () => {
      assert.equal(tipOf(fx.W, 'refs/tech-lead/base'), main, 'the fetch completed before the kill')
      assert.equal(recordOf(fx, 2).phase, 'preparing')
      snap = workSnap(fx.W)
    })
    const f3 = await run(fx, work('three'))
    const out = f3.get('prepared').out
    assert.equal(out.baseSha, main)
    assert.equal(out.baseAhead, true, "today's branch is kept, never rebased")
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f3)}~1`]), c1)
    assertRecovered(fx, { rows: [1, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] }, work: [{ snap, via: c1 }] })
    await run(fx, work('four'))
    assertRecovered(fx, { rows: [1, 3, 4] })
  })

  test('row 6: killed mid-switch to a new day, with a planted half checkout, a stale index and index.lock', T, async t => {
    const fx = project(t)
    const c1 = committedSha(await run(fx, { date: D1, ...work('one') }))
    // The owner merges the D1 work into main (from its delivery bundle) on top of a commit of
    // their own, so the D2 branch starts from a base whose tree differs from C1's.
    fs.writeFileSync(path.join(fx.P, 'm.txt'), 'm\n')
    git(fx.P, ['add', 'm.txt'])
    git(fx.P, ['commit', '-q', '-m', 'owner'])
    git(fx.P, ['fetch', '-q', path.join(fx.V, 'out', PREFIX, `${D1}.bundle`), `refs/heads/${PREFIX}/${D1}:refs/remotes/tech-lead/${PREFIX}/${D1}`])
    git(fx.P, ['merge', '-q', '--no-ff', '-m', 'merge D1', `refs/remotes/tech-lead/${PREFIX}/${D1}`])
    markP(fx)
    const base2 = tipOf(fx.P, 'main')
    let snap
    await interrupt(fx, { date: D2, faults: { prepare: 'rotate:after-switch' }, ...work('lost') }, () => {
      assert.equal(git(fx.W, ['symbolic-ref', 'HEAD']), `refs/heads/${PREFIX}/${D2}`)
      assert.equal(tipOf(fx.W), base2)
      // A switch cut short: m.txt not written yet, the index still C1's, index.lock left.
      fs.rmSync(path.join(fx.W, 'm.txt'))
      git(fx.W, ['read-tree', c1])
      fs.writeFileSync(path.join(fx.W, '.git', 'index.lock'), '')
      snap = workSnap(fx.W)
    })
    const f3 = await run(fx, { date: D2, ...work('three') })
    assert.ok(f3.get('planned').plan.notes.some(n => /stale git lock/.test(n)), JSON.stringify(f3.get('planned').plan.notes))
    const out = f3.get('prepared').out
    assert.ok(out.notes.some(n => /index\.lock/.test(n)), JSON.stringify(out.notes))
    assert.deepEqual(out.recovered.map(r => [r.generation, r.files]), [[2, 1]])
    assert.equal(fs.readFileSync(path.join(fx.W, 'm.txt'), 'utf8'), 'm\n')
    const ex = { work: [{ snap, via: 'bundle', sha: out.recovered[0].sha }], branch: `${PREFIX}/${D2}` }
    assertRecovered(fx, { ...ex, rows: [1, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f3)}~1`]), base2)
    await run(fx, { date: D2, ...work('four') })
    assertRecovered(fx, { ...ex, rows: [1, 3, 4] })
  })

  test('row 7: killed while the dependency install runs: the reclaim kills its group, the partial install output is saved', T, async t => {
    const fx = project(t)
    // The install writes ignored output (node_modules); the killed one also left a stray file.
    const install = 'mkdir -p node_modules/x && echo m > node_modules/x/i.js'
    let snap, pgid
    await interrupt(fx, { stop: 'deps', deps: { install: `${install} && echo partial > install-partial.txt && sleep 300 >/dev/null 2>&1` }, ...work('lost') }, async (f, e) => {
      pgid = e.pgid
      reap(fx, -pgid)
      // The stop comes once the install's group is on record; its files follow, then it sleeps.
      assert.ok(await waitFor(() => fs.existsSync(path.join(fx.W, 'install-partial.txt'))), 'the install never wrote its output')
      snap = workSnap(fx.W)
    })
    assert.equal(groupAlive(pgid), true, 'the install outlives its firing')
    const f2 = await run(fx, { deps: { install }, ...work('two') })
    assert.deepEqual(f2.get('acquired').reclaimed.stopped.map(s => [s.kind, s.label, s.pgid]), [['proc', 'deps', pgid]])
    assert.equal(groupAlive(pgid), false)
    assert.deepEqual(f2.get('planned').plan.records.map(r => [r.generation, r.phase, r.verdict]), [[1, 'prepared', 'leftovers']])
    const rec = f2.get('prepared').out.recovered
    assert.equal(rec.length, 1)
    const h = headerOf(fx, rec[0].sha)
    assert.equal(h.rules.mode, 'current', 'no dispatch ran: the current rules')
    assert.deepEqual(h.files.map(f => f.path), ['install-partial.txt'], 'the ignored node_modules is neither saved nor reset')
    assert.ok(f2.events.some(e => e.event === 'deps' && e.status === 0), 'the install ran again')
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    const f3 = await run(fx, { deps: { install }, ...work('three') })
    assert.equal(f3.events.some(e => e.event === 'deps'), false, 'the marker is fresh: no install')
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 32: a double interruption across a date change: each day\'s leftovers are saved by the next day\'s prepare', T, async t => {
    const fx = project(t)
    const c1 = committedSha(await run(fx, { date: D1, ...work('one') }))
    let snap1, snap2
    await interrupt(fx, { date: D1, stop: 'dispatched', attempts: [{ ops: EDIT }] }, () => { snap1 = workSnap(fx.W) })
    const f3 = await interrupt(fx, { date: D2, stop: 'dispatched', attempts: [{ ops: [['write', 'day2.txt', 'two\n'], ['write', 'a.txt', 'day two\n']] }] }, () => {
      snap2 = workSnap(fx.W)
    })
    const r3 = f3.get('prepared').out
    assert.deepEqual(r3.recovered.map(r => r.generation), [2])
    assert.equal(r3.branch, `${PREFIX}/${D2}`)
    assert.equal(r3.chainedFrom, `${PREFIX}/${D1}`)
    const f4 = await run(fx, { date: D3, ...work('four') })
    const r4 = f4.get('prepared').out
    assert.deepEqual(r4.recovered.map(r => r.generation), [3])
    // Generation 2's bundle is anchored in its record and in no ledger row; 3 anchors nothing yet.
    assert.deepEqual(f4.get('planned').plan.recovered.generations, [2])
    assert.equal(spawnStatus(fx.W, c1, committedSha(f4)), 0, 'the D1 commit is under the D3 branch')
    const ex = { work: [{ snap: snap1, via: 'bundle', sha: r3.recovered[0].sha }, { snap: snap2, via: 'bundle', sha: r4.recovered[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [1, 4], branch: `${PREFIX}/${D3}`, tip: committedSha(f4), sections: { Done: ['item A', 'item B'] } })
    await run(fx, { date: D3, ...work('five') })
    assertRecovered(fx, { ...ex, rows: [1, 4, 5], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  function spawnStatus(W, a, b) {
    try {
      git(W, ['merge-base', '--is-ancestor', a, b])
      return 0
    } catch {
      return 1
    }
  }

  test('row 35: a set-aside clone with unresolved records of the same and an earlier day: closed clone-missing, the saved bundle kept', T, async t => {
    const fx = project(t)
    let snap
    await interrupt(fx, { date: D1, stop: 'dispatched', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    await interrupt(fx, { date: D2, faults: { prepare: 'recover:after-save' }, ...work('lost') })
    const s1 = recordOf(fx, 1).recovery.bundles[0]
    assert.equal(recordOf(fx, 1).recovery.step, 'saved')
    assert.equal(recordOf(fx, 2).phase, 'preparing')
    // The owner sets the clone aside (README: the corrupt-clone set-aside).
    fs.renameSync(fx.W, path.join(fx.V, 'clone.broken-1'))
    const f3 = await run(fx, { date: D2, ...work('three') })
    const p = f3.get('planned').plan
    assert.ok(p.notes.some(n => /clone-missing/.test(n)), JSON.stringify(p.notes))
    assert.deepEqual(p.recovered.bundles, [s1])
    const out = f3.get('prepared').out
    assert.equal(out.created, true)
    assert.equal(out.notes.filter(n => /clone missing/.test(n)).length, 2, JSON.stringify(out.notes))
    assert.ok(fs.existsSync(path.join(fx.V, 'clone.broken-1')), 'the set-aside clone is left alone')
    const ex = { work: [{ snap, via: 'bundle', sha: s1 }] }
    assertRecovered(fx, { ...ex, rows: [3], tip: committedSha(f3), sections: { Done: ['item A'] } })
    await run(fx, { date: D2, ...work('four') })
    assertRecovered(fx, { ...ex, rows: [3, 4], sections: { Done: ['item A', 'item B'] } })
    void titles
  })
})
