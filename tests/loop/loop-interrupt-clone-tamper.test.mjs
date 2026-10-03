// tests/loop/loop-interrupt-clone-tamper.test.mjs
// The section 19 tamper table: a recorded patch byte-flipped, deleted or replaced (planner exit
// 2, reset refuses, <W> unchanged); a corrupt or future run record; a store collision; a
// tampered delivery bundle (the sidecar mismatch regenerates it); a delivery bundle that cannot
// be read (planner exit 2 bundle-check); a ref changed in <W> between firings (tampered). Plus matrix row 36, a staged-then-reverted change (index-only pause,
// nothing lost). Each ends with the owner's fix from the README troubleshooting rows (the
// unpause included) and the loop recovering. Invariants I1-I8: tests/loop/interrupt-fixture.mjs.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ROWS, D2, PREFIX, SCRIPTS, T, assertRecovered, git, go, helperAs, interrupt, ledger, patches, project, recordGenerations, run, snapshot, start,
  titles, unpause, workSnap,
} from './interrupt-fixture.mjs'
import { createRecord } from '../../scripts/lib/run-record.mjs'

const BRANCH = `${PREFIX}/${D2}`
const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}
const fullSnap = W => snapshot(W, { skip: [], times: true })
// <W> with times, its object store left out (a save stores blobs there and git freshens the
// times of objects it already has; neither is a change to the clone's tree, index, HEAD or refs).
const cloneState = W => fullSnap(W).filter(([p]) => p !== '.git/objects' && !p.startsWith('.git/objects/'))
// The owner moves a run record aside (README: "recovery planner: tampered/corrupt/...").
const setAside = (fx, g) => {
  const dir = path.join(fx.V, 'run.broken-1')
  fs.mkdirSync(dir, { recursive: true })
  fs.renameSync(path.join(fx.V, 'run', `${g}.json`), path.join(dir, `${g}.json`))
}

describe('section 19 tamper table', ROWS, () => {
  for (const how of ['flipped', 'deleted', 'replaced']) {
    test(`tamper: a recorded patch ${how}: the planner halts, reset refuses, <W> is unchanged`, T, async t => {
      const fx = project(t)
      let snap, sha, before
      await interrupt(fx, { stop: 'saved-state', path: 'flag', attempts: [{ ops: EDIT }] }, (f, e) => {
        sha = e.sha
        snap = workSnap(fx.W)
        const file = path.join(fx.V, 'patches', `${sha}.patch`)
        const bytes = fs.readFileSync(file)
        if (how === 'flipped') {
          bytes[bytes.length - 3] ^= 0x01
          fs.writeFileSync(file, bytes)
        } else if (how === 'deleted') fs.unlinkSync(file)
        else fs.writeFileSync(file, `${bytes.toString('utf8').split('\n')[0]}\n`)
        before = fullSnap(fx.W)
        const r = helperAs(fx, f.pid, 'reflex-bundle.mjs', ['reset', fx.P, '--generation', '1', '--sha', sha])
        assert.equal(r.status, 3, r.stdout + r.stderr)
        assert.equal(r.out.state, 'tampered', r.stdout)
        assert.deepEqual(fullSnap(fx.W), before, 'reset refused before touching <W>')
      })
      const f2 = await run(fx, work('two'))
      const halted = f2.get('halted')
      assert.equal(halted.status, 2)
      assert.match(halted.out.detail, /^tampered: /)
      assert.equal(f2.get('prepared'), undefined)
      assert.deepEqual(fullSnap(fx.W), before, '<W> unchanged by the halted firing')
      assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].paused], ['skipped', true])
      setAside(fx, 1)
      unpause(fx)
      const f3 = await run(fx, work('three'))
      const rec = f3.get('prepared').out.recovered
      assert.deepEqual(rec.map(r => r.generation), [null], 'with the record set aside, the leftovers have no record')
      const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], orphans: how === 'deleted' ? 0 : 1 }
      assertRecovered(fx, { ...ex, rows: [2, 3], tip: committedSha(f3), sections: { 'Needs decision': ['item A'], Done: ['item B'] } })
      await run(fx, work('four'))
      assertRecovered(fx, { ...ex, rows: [2, 3, 4], sections: { 'Needs decision': ['item A'], Done: ['item B', 'item C'] } })
    })
  }

  test('tamper: a corrupt run record halts the planner until the owner moves it aside', T, async t => {
    const fx = project(t)
    await run(fx, work('one'))
    fs.writeFileSync(path.join(fx.V, 'run', '1.json'), '{"v":1,')
    const before = fullSnap(fx.W)
    const f2 = await run(fx, work('two'))
    assert.match(f2.get('halted').out.detail, /^corrupt: /)
    assert.deepEqual([f2.get('closed').status, f2.get('closed').out.state], [3, 'corrupt'])
    assert.deepEqual(fullSnap(fx.W), before)
    setAside(fx, 1)
    unpause(fx)
    const f3 = await run(fx, work('three'))
    assertRecovered(fx, { rows: [1, 2, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { rows: [1, 2, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  test('tamper: a run record from the future halts the planner until the owner moves it aside', T, async t => {
    const fx = project(t)
    const f1 = start(fx, { gates: ['acquired'], ...work('one') })
    const a = await f1.event('acquired')
    assert.equal(createRecord(fx.paths, a.generation, { phase: 'preparing', pre_head: null }), true)
    go(fx, 'acquired')
    await f1.event('released', 80000)
    assert.match(f1.get('halted').out.detail, /^record-from-the-future: /)
    assert.equal(f1.get('prepared'), undefined)
    setAside(fx, 1)
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [1, 2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('tamper: a store collision (another file under the bundle\'s name) fails the save as tampered; nothing is reset or lost', T, async t => {
    const fx = project(t)
    let snap, before, planted
    const f1 = start(fx, { path: 'pause', gates: ['checked'], attempts: [{ ops: EDIT }] })
    await f1.event('checked')
    // The same save, killed before its link, gives the name the driver's save will want.
    const k = helperAs(fx, f1.pid, 'reflex-bundle.mjs', ['save', fx.P, '--generation', '1', '--why', 'pause'], { TECH_LEAD_FAULT: 'save:after-check' })
    assert.equal(k.signal, 'SIGKILL', k.stdout + k.stderr)
    const dir = path.join(fx.V, 'patches')
    const temp = fs.readdirSync(dir).find(n => n.startsWith('.tmp-'))
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, temp))).digest('hex')
    planted = `${sha}.patch`
    fs.writeFileSync(path.join(dir, planted), 'not that bundle\n')
    snap = workSnap(fx.W)
    before = cloneState(fx.W)
    go(fx, 'checked')
    await f1.event('released', 80000)
    assert.deepEqual(f1.events.filter(e => e.event === 'saved'), [], 'the save failed')
    assert.match(ledger(fx)[0].notes, /save failed.*tampered/)
    assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].paused], ['halted', true])
    assert.deepEqual(cloneState(fx.W), before, 'no reset, nothing touched')
    assert.deepEqual(titles(fx, 'Backlog')[0], 'item A', 'the item is back unchanged')
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['note-leftovers'])
    const rec = f2.get('prepared').out.recovered
    assert.notEqual(rec[0].sha, sha)
    assert.equal(fs.readFileSync(path.join(dir, planted), 'utf8'), 'not that bundle\n', 'the colliding file is left alone')
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], orphans: 1 }
    assertRecovered(fx, { ...ex, rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [1, 2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  // Flips one byte of a delivery bundle's pack data, past its header.
  function corruptBundle(file) {
    const bytes = fs.readFileSync(file)
    const at = bytes.indexOf('\n\n') + 2 + 20
    bytes[at] ^= 0xff
    fs.writeFileSync(file, bytes)
  }

  test('tamper: a delivery bundle whose bytes no longer match its sidecar is regenerated by prepare\'s bundle sync', T, async t => {
    const fx = project(t)
    const C1 = committedSha(await run(fx, work('one')))
    const file = path.join(fx.V, 'out', `${BRANCH}.bundle`)
    corruptBundle(file)
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, [])
    assert.deepEqual(f2.get('prepared').out.bundles.map(b => [b.branch, b.tip, b.why]), [[BRANCH, C1, 'regenerated']])
    assertRecovered(fx, { rows: [1, 2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [1, 2, 3] })
  })

  test('tamper: a delivery bundle whose bytes no longer match its sidecar is regenerated through the planner\'s write-bundle', T, async t => {
    const fx = project(t)
    let C1
    await interrupt(fx, { stop: 'done', ...work('one') }, (f, e) => { C1 = e.sha })
    corruptBundle(path.join(fx.V, 'out', `${BRANCH}.bundle`))
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.actions, ['ledger-recovered', 'write-bundle'])
    assert.ok(p.notes.some(n => /sha256-mismatch/.test(n)), JSON.stringify(p.notes))
    assert.ok(ledger(fx)[0].bundles.some(b => b.tip === C1 && b.why === 'regenerated'), JSON.stringify(ledger(fx)[0].bundles))
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A', 'item B'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3] })
  })

  for (const which of ['bundle', 'sidecar']) {
    test(`tamper: a delivery ${which} that cannot be read halts the planner (bundle-check) until the owner moves it aside; the next firing writes the bundle again`, T, async t => {
      // The planner inspects the bundle of a branch whose committed record is still on disk:
      // a firing killed once its item is done, before its ledger row.
      const fx = project(t)
      let C
      await interrupt(fx, { stop: 'done', ...work('one') }, (f, e) => { C = e.sha })
      const file = path.join(fx.V, 'out', `${BRANCH}.bundle`)
      const target = which === 'bundle' ? file : `${file}.json`
      fs.chmodSync(target, 0o000)
      t.after(() => { try { fs.chmodSync(target, 0o600) } catch { /* moved */ } })
      const f2 = await run(fx, work('two'))
      assert.ok(f2.get('halted'), f2.describe())
      assert.match(f2.get('halted').out.detail, new RegExp(`^bundle-check: ${BRANCH}: `))
      assert.equal(f2.get('prepared'), undefined)
      assert.deepEqual([ledger(fx)[0].outcome, ledger(fx)[0].paused], ['skipped', true])
      // The owner's fix (README "recovery planner", bundle-check): both files set aside.
      const aside = path.join(fx.V, 'out.broken-1')
      fs.mkdirSync(aside)
      fs.renameSync(file, path.join(aside, path.basename(file)))
      fs.renameSync(`${file}.json`, path.join(aside, `${path.basename(file)}.json`))
      unpause(fx)
      const f3 = await run(fx, work('three'))
      const p = f3.get('planned').plan
      assert.deepEqual(p.write_bundles, [BRANCH], JSON.stringify(p))
      assert.ok(ledger(fx)[1].bundles.some(b => b.tip === C), JSON.stringify(ledger(fx)[1].bundles))
      assertRecovered(fx, { rows: [2, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
      await run(fx, work('four'))
      assertRecovered(fx, { rows: [2, 3, 4], sections: { Done: ['item A', 'item B', 'item C'] } })
    })
  }

  // A ref planted in <W> between firings (a tag, and a dated branch).
  function plantRefs(fx) {
    git(fx.W, ['tag', 'evil'])
    git(fx.W, ['update-ref', 'refs/heads/tl/2026-01-01', 'HEAD'])
  }
  function undoRefs(fx) {
    git(fx.W, ['tag', '-d', 'evil'])
    git(fx.W, ['update-ref', '-d', 'refs/heads/tl/2026-01-01'])
  }

  test('tamper: a ref changed in <W> between firings makes prepare refuse tampered, touching nothing, until the owner undoes it', T, async t => {
    // The interrupted firing's record holds the refs snapshot prepare compares with.
    const fx = project(t)
    let snap
    await interrupt(fx, { stop: 'checked', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    plantRefs(fx)
    const before = fullSnap(fx.W)
    const f2 = await run(fx, work('two'))
    const paused = f2.get('paused')
    assert.ok(paused, f2.describe())
    assert.equal(paused.why, 'prepare tampered')
    assert.match(paused.detail, /refs\/tags\/evil/)
    assert.match(paused.detail, /refs\/heads\/tl\/2026-01-01/)
    assert.deepEqual(fullSnap(fx.W), before)
    assert.deepEqual(recordGenerations(fx), [1])
    undoRefs(fx)
    unpause(fx)
    const f3 = await run(fx, work('three'))
    const rec = f3.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => r.generation), [1])
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2, 3], tip: committedSha(f3), sections: { Done: ['item A'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { ...ex, rows: [2, 3, 4], sections: { Done: ['item A', 'item B'] } })
  })

  test('tamper: a ref changed in <W> after a firing that closed cleanly is tampered too', T, async t => {
    // No record survives a clean close; <V>/run/refs.json, written by close, is the anchor.
    const fx = project(t)
    await run(fx, work('one'))
    plantRefs(fx)
    const before = fullSnap(fx.W)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('prepared'), undefined, 'prepare must refuse refs nobody recorded')
    assert.equal(f2.get('paused')?.why, 'prepare tampered')
    assert.deepEqual(fullSnap(fx.W), before)
    assert.equal(fs.existsSync(path.join(fx.V, 'out', 'tl', '2026-01-01.bundle')), false, 'no bundle for a planted branch')
  })

  test('row 36: a staged-then-reverted change pauses index-only, twice, with nothing lost; the owner sets the clone aside', T, async t => {
    const fx = project(t)
    const ops = [['write', 'a.txt', 'staged\n'], ['git', 'add', 'a.txt'], ['write', 'a.txt', 'a\n'], ['write', 'new.txt', 'new\n']]
    const f1 = await run(fx, { attempts: [{ ops }] })
    assert.equal(f1.get('paused').why, 'check index-only')
    assert.deepEqual(f1.get('closed').out.kept.map(k => [k.generation, k.dirty]), [[1, true]])
    assert.equal(git(fx.W, ['show', ':a.txt']), 'staged')
    const before = fullSnap(fx.W)
    unpause(fx)
    const f2 = await run(fx, work('two'))
    assert.equal(f2.get('paused').why, 'prepare index-only')
    assert.deepEqual(fullSnap(fx.W), before, 'nothing touched')
    assert.equal(git(fx.W, ['show', ':a.txt']), 'staged', 'the staged content is still there')
    // The owner's fix (README "clone index-only"): read it through the read-only passthrough,
    // then set the clone aside; the staged content stays in the set-aside clone.
    const look = spawnSync(process.execPath, [path.join(SCRIPTS, 'loop-clone.mjs'), 'git', fx.P, '--', 'show', ':a.txt'], { encoding: 'utf8', env: fx.env })
    assert.deepEqual([look.status, look.stdout], [0, 'staged\n'])
    const broken = path.join(fx.V, 'clone.broken-1')
    fs.renameSync(fx.W, broken)
    unpause(fx)
    const f3 = await run(fx, work('three'))
    const out = f3.get('prepared').out
    assert.equal(out.created, true)
    assert.equal(out.notes.filter(n => /clone missing/.test(n)).length, 2, JSON.stringify(out.notes))
    assert.equal(git(broken, ['show', ':a.txt']), 'staged', 'nothing lost: the staged content is in the set-aside clone')
    assert.equal(fs.readFileSync(path.join(broken, 'new.txt'), 'utf8'), 'new\n')
    assertRecovered(fx, { rows: [1, 2, 3], tip: committedSha(f3), sections: { Done: ['item A'] } })
    await run(fx, work('four'))
    assertRecovered(fx, { rows: [1, 2, 3, 4], sections: { Done: ['item A', 'item B'] } })
  })
})
