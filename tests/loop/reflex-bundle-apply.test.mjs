// tests/loop/reflex-bundle-apply.test.mjs
// `reflex-bundle.mjs apply` (ruling R6; brief section 11): the minimal same-base apply that the
// spec's section 11 stage 0c contract needs. A bundle holding an out-of-scope file is refused
// before anything is applied; scope-changed, digest-mismatch, moved-base and dirty refuse with
// the work tree untouched; on the same base the bundle reproduces the saved work tree. The save
// names its item with --item (stage 0c-3 R18), so the bundle's item digest is that item's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { T, fixture, git, gitState, recordOf, run, save, snapshot, write } from './reflex-bundle-fixture.mjs'
import { itemDigest, parseState } from '../../scripts/lib/loop-state.mjs'
import { open, state } from '../lib/loop-state-fixture.mjs'

const SCOPED = '---\nverify:\n  - "true"\nscope:\n  - src\n---\n'
const ITEM = 'tl-aaaaaaaa'
const STATE = state({ now: open('Add the feature', { id: ITEM, notes: 'in src' }) })
const D = itemDigest(parseState(STATE).items[0])
const N_ = f => String(f.N)
const FILES = { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'src/run.sh': 'echo\n', 'docs/d.md': 'd\n' }

// Saves the clone's edits (why delegate-flagged, the STATE.md item ITEM, whose digest is D) and
// resets it: {sha, pre}.
function saveAndReset(f) {
  const pre = snapshot(f.W, { dirs: false })
  fs.writeFileSync(path.join(f.S, 'STATE.md'), STATE)
  const s = save(f, 'delegate-flagged', ['--item', ITEM, '--item-digest', D])
  assert.equal(s.state, 'saved')
  assert.equal(s.item_digest, D)
  assert.equal(run(f.env, 0, 'reset', f.P, '--generation', N_(f), '--sha', s.sha).state, 'reset')
  return { sha: s.sha, pre, saved: s }
}
const apply = (f, sha, status, ...extra) => run(f.env, status, 'apply', f.P, '--generation', N_(f), '--sha', sha, ...extra)

test('apply onto the same base reproduces the saved work tree', T, async t => {
  const f = await fixture(t, FILES, { loopMd: SCOPED })
  write(f.W, 'src/a.txt', 'edited\r\n')
  fs.rmSync(path.join(f.W, 'src/b.txt'))
  write(f.W, 'src/new/c.txt', 'c\n')
  fs.symlinkSync('a.txt', path.join(f.W, 'src/l'))
  fs.chmodSync(path.join(f.W, 'src/run.sh'), 0o755)
  const { sha, pre, saved } = saveAndReset(f)
  assert.deepEqual(saved.out_of_scope, [])
  assert.deepEqual(saved.warnings, [])
  assert.deepEqual(saved.scope.entries, ['src'])
  const before = recordOf(f)
  const r = apply(f, sha, 0, '--item-digest', D)
  assert.deepEqual(r, { state: 'applied', sha, base: f.base, tree: r.tree, files: 5 })
  assert.deepEqual(snapshot(f.W, { dirs: false }), pre)
  assert.deepEqual(recordOf(f), before, 'apply writes no record')
})

test('a bundle holding an out-of-scope file is refused before anything is applied', T, async t => {
  const f = await fixture(t, FILES, { loopMd: SCOPED })
  write(f.W, 'src/a.txt', 'in scope\n')
  write(f.W, 'docs/d.md', 'out of scope\n')
  write(f.W, '.tech-lead/LOOP.md', 'a governance copy (R7)\n')
  const { sha, saved } = saveAndReset(f)
  assert.deepEqual(saved.out_of_scope, ['.tech-lead/LOOP.md', 'docs/d.md'])
  const snap = snapshot(f.W)
  const st = gitState(f.W)
  const r = apply(f, sha, 3, '--item-digest', D)
  assert.equal(r.state, 'out-of-scope')
  assert.deepEqual(r.paths, ['.tech-lead/LOOP.md', 'docs/d.md'])
  assert.deepEqual(snapshot(f.W), snap, 'the work tree is untouched')
  assert.deepEqual(gitState(f.W), st)
})

test('apply refuses scope-changed, digest-mismatch, moved-base and dirty, leaving the work tree untouched', T, async t => {
  const f = await fixture(t, FILES, { loopMd: SCOPED })
  write(f.W, 'src/a.txt', 'edited\n')
  const { sha } = saveAndReset(f)
  const expect = (state, ...extra) => {
    const snap = snapshot(f.W)
    const r = apply(f, sha, 3, ...extra)
    assert.equal(r.state, state, JSON.stringify(r))
    assert.deepEqual(snapshot(f.W), snap, `${state}: untouched`)
    return r
  }

  const loopMd = path.join(f.S, 'LOOP.md')
  fs.writeFileSync(loopMd, '---\nverify:\n  - "true"\nscope:\n  - src\n  - lib\n---\n')
  expect('scope-changed', '--item-digest', D)
  fs.writeFileSync(loopMd, SCOPED)

  expect('digest-mismatch')
  expect('digest-mismatch', '--item-digest', 'b'.repeat(64))

  write(f.W, 'src/z.txt', 'untracked\n')
  assert.deepEqual(expect('dirty', '--item-digest', D).paths, ['src/z.txt'])
  fs.rmSync(path.join(f.W, 'src/z.txt'))
  git(f.W, ['rm', '--cached', '-q', 'src/b.txt'])
  expect('dirty', '--item-digest', D)
  git(f.W, ['read-tree', f.base])

  git(f.W, ['commit', '-q', '--allow-empty', '-m', 'the base moved'])
  expect('moved-base', '--item-digest', D)
  git(f.W, ['reset', '-q', '--soft', f.base])

  assert.equal(apply(f, sha, 0, '--item-digest', D).state, 'applied')
  assert.equal(fs.readFileSync(path.join(f.W, 'src/a.txt'), 'utf8'), 'edited\n')
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

test('apply writes the bundle raw: core.autocrlf=true in the owner config converts nothing (data-safety#4)', T, async t => {
  const f = await fixture(t, FILES, { loopMd: SCOPED })
  write(f.W, 'src/a.txt', 'edited\n')
  write(f.W, 'src/n.txt', 'x\ny\n')
  const { sha, pre } = saveAndReset(f)
  const gcfg = path.join(f.root, 'crlf.gitconfig')
  fs.writeFileSync(gcfg, '[core]\n\tautocrlf = true\n')
  const r = run({ ...f.env, GIT_CONFIG_GLOBAL: gcfg }, 0, 'apply', f.P, '--generation', N_(f), '--sha', sha, '--item-digest', D)
  assert.equal(r.state, 'applied')
  assert.equal(fs.readFileSync(path.join(f.W, 'src/n.txt'), 'latin1'), 'x\ny\n')
  assert.equal(fs.readFileSync(path.join(f.W, 'src/a.txt'), 'latin1'), 'edited\n')
  assert.deepEqual(snapshot(f.W, { dirs: false }), pre)
})

test('apply writes the bundle raw under a base .gitattributes with text eol=crlf, and turns a directory into a file (data-safety#4)', T, async t => {
  const f = await fixture(t, { ...FILES, '.gitattributes': '*.txt text eol=crlf\n', 'src/d/x.txt': 'x\n' }, { loopMd: SCOPED })
  assert.equal(fs.readFileSync(path.join(f.W, 'src/a.txt'), 'latin1'), 'a\r\n', 'the checkout writes CRLF')
  write(f.W, 'src/a.txt', 'edited\n')
  write(f.W, 'src/n.txt', 'x\ny\n')
  fs.rmSync(path.join(f.W, 'src/d'), { recursive: true })
  write(f.W, 'src/d', 'now a file\n')
  const { sha, pre } = saveAndReset(f)
  assert.equal(fs.readFileSync(path.join(f.W, 'src/a.txt'), 'latin1'), 'a\r\n', 'the reset wrote the checkout back')
  const st = gitState(f.W)
  const r = apply(f, sha, 0, '--item-digest', D)
  assert.equal(r.state, 'applied')
  assert.deepEqual(snapshot(f.W, { dirs: false }), pre)
  assert.equal(gitState(f.W).index, st.index, 'the real index is left as it was (at the base)')
})

test('apply refuses dirty and writes nothing when ignored files lie in a directory the bundle turns into a file (data-safety#4)', T, async t => {
  const f = await fixture(t, { ...FILES, '.gitignore': '*.log\n', 'src/d/x.txt': 'x\n' }, { loopMd: SCOPED })
  fs.rmSync(path.join(f.W, 'src/d'), { recursive: true })
  write(f.W, 'src/d', 'now a file\n')
  const { sha } = saveAndReset(f)
  // git's own two-way read-tree (2.35 and later) deletes ignored files in its way.
  write(f.W, 'src/d/keep.log', 'an ignored file the apply must not delete\n')
  write(f.W, 'src/d/deep/more.log', 'and one deeper\n')
  fs.mkdirSync(path.join(f.W, 'src/d/empty'))
  const snap = snapshot(f.W)
  const r = apply(f, sha, 3, '--item-digest', D)
  assert.equal(r.state, 'dirty')
  assert.deepEqual(r.paths, ['src/d/deep/more.log', 'src/d/keep.log'])
  assert.deepEqual(snapshot(f.W), snap, 'nothing was written')
  fs.rmSync(path.join(f.W, 'src/d/keep.log'))
  fs.rmSync(path.join(f.W, 'src/d/deep'), { recursive: true })
  assert.equal(apply(f, sha, 0, '--item-digest', D).state, 'applied', 'an empty directory is no obstacle')
  assert.equal(fs.readFileSync(path.join(f.W, 'src/d'), 'utf8'), 'now a file\n')
})

// ---------------------------------------------------------------- fix round 2

test('apply does not depend on stat timing: files the index reads as racily clean still apply raw under a base eol=crlf (racy git)', T, async t => {
  const f = await fixture(t, { ...FILES, '.gitattributes': '*.txt text eol=crlf\n', 'src/d/x.txt': 'x\n' }, { loopMd: SCOPED })
  write(f.W, 'src/a.txt', 'edited\n')
  write(f.W, 'src/n.txt', 'x\ny\n')
  fs.rmSync(path.join(f.W, 'src/d'), { recursive: true })
  write(f.W, 'src/d', 'now a file\n')
  const { sha, pre } = saveAndReset(f)
  assert.equal(fs.readFileSync(path.join(f.W, 'src/a.txt'), 'latin1'), 'a\r\n', 'the reset wrote the checkout back')
  // Every base file the bundle changes now reads as written no earlier than any index git makes
  // from here on, so git judges each such entry racily clean and compares its content: what a
  // reset and an apply within the same second meet by chance, made certain.
  const later = new Date(Date.now() + 3600 * 1000)
  for (const rel of ['src/a.txt', 'src/b.txt', 'src/d/x.txt', 'src/run.sh']) fs.utimesSync(path.join(f.W, rel), later, later)
  const st = gitState(f.W)
  const r = apply(f, sha, 0, '--item-digest', D)
  assert.equal(r.state, 'applied', JSON.stringify(r))
  assert.deepEqual(snapshot(f.W, { dirs: false }), pre)
  assert.equal(gitState(f.W).index, st.index, 'the real index is left as it was (at the base)')
})
