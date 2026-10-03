// tests/loop/loop-interrupt-clone-prose.test.mjs
// The section 19 interruption matrix, rows killed at a prose boundary before the commit (a
// driver stop; the firing's process group SIGKILLed while it waits there): 1, 2, 8-11; rows
// 20, 21, 23, 28-30 and 34 are in loop-interrupt-clone-state.test.mjs.
// Each row: the interrupted firing, the recovering firing (stop none), then a third firing for
// idempotence, with invariants I1-I8 checked after the last two (tests/loop/interrupt-fixture.mjs).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ROWS, BASE_FILES, D2, PREFIX, T, assertRecovered, git, headerOf, interrupt, project, run, tipOf, titles, workSnap,
} from './interrupt-fixture.mjs'

const BRANCH = `${PREFIX}/${D2}`
const work = (name, o = {}) => ({ attempts: [{ ops: [['write', `${name}.txt`, `${name}\n`]] }], ...o })
const EDIT = [['write', 'a.txt', 'edited\n'], ['write', 'new.txt', 'new\n'], ['rm', 'b.txt']]
const committedSha = f => {
  const e = f.get('committed')
  assert.ok(e, `the firing did not commit: ${f.describe()}`)
  return e.out.sha
}

describe('section 19 matrix: prose boundaries before the commit', ROWS, () => {
  test('row 1: a firing killed after acquire is reclaimed; the clone and its branch are untouched', T, async t => {
    const fx = project(t)
    const f1 = await run(fx, work('one'))
    const c1 = committedSha(f1)
    await interrupt(fx, { stop: 'acquired', ...work('lost') })
    const f3 = await run(fx, work('three'))
    assert.deepEqual(f3.get('acquired').reclaimed, { generation: 2, how: 'dead-holder', stopped: [] })
    assert.deepEqual(f3.get('planned').plan.actions, [])
    assert.deepEqual(f3.get('prepared').out.recovered, [])
    assert.equal(git(fx.W, ['rev-parse', `${committedSha(f3)}~1`]), c1, 'the new commit sits on the old one')
    assertRecovered(fx, { rows: [1, 3], branch: BRANCH, tip: committedSha(f3), sections: { Done: ['item A', 'item B'], Backlog: ['item C', 'item D'] } })
    const f4 = await run(fx, work('four'))
    assertRecovered(fx, { rows: [1, 3, 4], tip: committedSha(f4), sections: { Done: ['item A', 'item B', 'item C'], Backlog: ['item D'] } })
  })

  test('row 2: a firing killed after its pick has the item requeued (requeue-now) and done by the next firing', T, async t => {
    const fx = project(t)
    await interrupt(fx, { stop: 'picked', ...work('lost') })
    assert.deepEqual(titles(fx, 'Now'), ['item A'])
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now'])
    assert.deepEqual(f2.get('picked').item.length, 1)
    assertRecovered(fx, { rows: [2], tip: committedSha(f2), sections: { Done: ['item A'], Backlog: ['item B', 'item C', 'item D'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 8: killed after prepared; two more firings commit, and the earlier commit stays on the branch and in the live bundle', T, async t => {
    const fx = project(t)
    const c1 = committedSha(await run(fx, work('one')))
    await interrupt(fx, { stop: 'prepared', ...work('lost') })
    const f3 = await run(fx, work('three'))
    assert.deepEqual(f3.get('planned').plan.actions, ['requeue-now'])
    assert.deepEqual(f3.get('prepared').out.recovered, [], 'nothing was left to save')
    assertRecovered(fx, { rows: [1, 3], tip: committedSha(f3), sections: { Done: ['item A', 'item B'] } })
    const f4 = await run(fx, work('four'))
    const tip = committedSha(f4)
    assert.equal(spawnSync('git', ['-C', fx.W, 'merge-base', '--is-ancestor', c1, tip]).status, 0, 'the first commit stays on the branch')
    const file = path.join(fx.V, 'out', `${BRANCH}.bundle`)
    assert.deepEqual(git(fx.W, ['bundle', 'list-heads', file]).split('\n'), [`${tip} refs/heads/${BRANCH}`])
    const inBundle = git(fx.W, ['rev-list', tip, '--not', 'refs/tech-lead/base']).split('\n')
    assert.ok(inBundle.includes(c1), 'the live bundle carries the first commit')
    assertRecovered(fx, { rows: [1, 3, 4], tip, sections: { Done: ['item A', 'item B', 'item C'] } })
  })

  // Every kind of delegate edit (I1's list): a modified, deleted, added, binary and CRLF file, an
  // exec bit, a symlink, an out-of-scope file (.tech-lead/ inside <W>, R7), files hidden by a
  // delegate .gitignore edit and by a new nested .gitignore, and files (one ignored) in a directory
  // standing where the base tracks a file (R21).
  const KIND_FILES = { ...BASE_FILES, 'del.txt': 'gone soon\n', 'exec.sh': 'echo hi\n', obs: 'a file in the base\n', 'crlf.txt': 'x\n' }
  const KIND_OPS = [
    ['write', 'a.txt', 'edited\n'], ['rm', 'del.txt'], ['chmod', 'exec.sh', '755'], ['write', 'new.txt', 'new\n'],
    ['symlink', 'a.txt', 'link'], ['write', 'crlf.txt', 'x\r\ny\r\n'], ['write64', 'bin.dat', Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]).toString('base64')],
    ['rm', 'obs'], ['write', 'obs/inner.txt', 'inner\n'], ['write', 'obs/x.log', 'ignored, but inside an obstructing directory\n'],
    ['write', '.gitignore', 'node_modules/\nbuild/\n*.log\nsecret.txt\n'], ['write', 'secret.txt', 'hidden by the delegate\n'],
    ['write', 'sub/.gitignore', '*\n'], ['write', 'sub/hidden.txt', 'hidden too\n'], ['write', '.tech-lead/notes.md', 'never in scope\n'],
  ]

  test('row 9: delegate edits of every kind, killed mid-dispatch, are saved byte-exactly and reset', T, async t => {
    const fx = project(t, { files: KIND_FILES })
    let snap
    await interrupt(fx, { stop: 'dispatched', attempts: [{ ops: KIND_OPS }] }, () => { snap = workSnap(fx.W) })
    const f2 = await run(fx, work('two'))
    assert.deepEqual(f2.get('planned').plan.actions, ['requeue-now', 'note-leftovers'])
    const rec = f2.get('prepared').out.recovered
    assert.equal(rec.length, 1)
    assert.equal(rec[0].generation, 1)
    assert.equal(rec[0].out_of_scope, 1)
    assert.ok(rec[0].hidden >= 3, JSON.stringify(rec[0]))
    const h = headerOf(fx, rec[0].sha)
    const by = Object.fromEntries(h.files.map(f => [f.path, f]))
    assert.equal(h.rules.mode, 'recorded')
    assert.deepEqual([by['secret.txt'].hidden, by['sub/hidden.txt'].hidden, by['obs/x.log'].obstructed, by['.tech-lead/notes.md'].in_scope],
      [true, true, true, false])
    assert.deepEqual([by['exec.sh'].kind, by.link.mode, by['bin.dat'].binary], ['mode-changed', '120000', true])
    assert.equal(fs.readFileSync(path.join(fx.W, 'obs'), 'utf8'), 'a file in the base\n')
    for (const gone of ['secret.txt', 'sub', 'link', '.tech-lead', 'bin.dat']) assert.equal(fs.existsSync(path.join(fx.W, gone)), false, gone)
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], sections: { Done: ['item A'] } }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2) })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 10: a delegate commit is rewound, never bundled, and its work saved with the edits after it', T, async t => {
    const fx = project(t)
    let snap, D
    await interrupt(fx, { stop: 'dispatched-commit', attempts: [{ ops: [['write', 'd.txt', 'd\n'], ['commit', 'delegate commit'], ['write', 'e.txt', 'e\n']] }] }, () => {
      snap = workSnap(fx.W)
      D = tipOf(fx.W)
    })
    const f2 = await run(fx, work('two'))
    const p = f2.get('planned').plan
    assert.deepEqual(p.records.map(r => [r.generation, r.verdict]), [[1, 'delegate-commit']])
    assert.deepEqual(p.write_bundles, [])
    const rec = f2.get('prepared').out.recovered
    assert.deepEqual(rec.map(r => [r.generation, r.rewound_from]), [[1, D]])
    assert.equal(git(fx.W, ['branch', '--contains', D]), '', 'no branch holds the delegate commit')
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }], delegate: [D] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })

  test('row 11: verify artifacts left by a killed firing are saved (an ignored artifact is neither saved nor reset)', T, async t => {
    const fx = project(t, { verify: ['mkdir -p build && echo built > build/out.txt', 'echo report > report.txt'] })
    let snap
    const f1 = await interrupt(fx, { stop: 'verified', attempts: [{ ops: EDIT }] }, () => { snap = workSnap(fx.W) })
    assert.ok(snap.some(([p]) => p === 'report.txt'), 'the verify artifact is in the work')
    assert.equal(f1.events.filter(e => e.event === 'checked').length, 1)
    const f2 = await run(fx, work('two'))
    const rec = f2.get('prepared').out.recovered
    assert.equal(rec.length, 1)
    assert.ok(headerOf(fx, rec[0].sha).files.some(f => f.path === 'report.txt'))
    assert.ok(!headerOf(fx, rec[0].sha).files.some(f => f.path.startsWith('build/')))
    assert.equal(fs.readFileSync(path.join(fx.W, 'build', 'out.txt'), 'utf8'), 'built\n', 'the ignored artifact stays')
    const ex = { work: [{ snap, via: 'bundle', sha: rec[0].sha }] }
    assertRecovered(fx, { ...ex, rows: [2], tip: committedSha(f2), sections: { Done: ['item A'] } })
    await run(fx, work('three'))
    assertRecovered(fx, { ...ex, rows: [2, 3], sections: { Done: ['item A', 'item B'] } })
  })
})
