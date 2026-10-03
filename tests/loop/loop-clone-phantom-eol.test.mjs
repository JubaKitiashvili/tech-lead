// tests/loop/loop-clone-phantom-eol.test.mjs
// A base whose blobs break its own .gitattributes normalization (a CRLF blob committed before
// `* text eol=lf`): git's conversion-aware diff calls the file modified right after a clean
// checkout, though its raw bytes are the base blob. R29a extends to git's own diff, so neither
// check --after deps (deps-dirty), the touched set, the commit nor the clean check after recovery
// counts it; a real edit to that file still goes in. Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { T, check, commitCli, firing, git, patches, prepare, project, tipOf, write } from './loop-clone-fixture.mjs'

const CRLF = 'one\r\ntwo\r\n'
const OLD = new Date('2001-01-01T00:00:00Z')

// <P>: win.txt and old.txt committed with CRLF bytes, then a base commit that adds
// `* text eol=lf` (the legacy state `git add --renormalize .` would fix). The files' mtimes go
// back first, so the base commit's `add -A` never re-reads them as racily clean.
function phantomProject(t) {
  return project(t, {
    plumb: P => {
      write(P, 'win.txt', CRLF)
      write(P, 'old.txt', CRLF)
      for (const rel of ['win.txt', 'old.txt']) fs.utimesSync(path.join(P, rel), OLD, OLD)
      git(P, ['add', 'win.txt', 'old.txt'])
      git(P, ['commit', '-q', '-m', 'legacy crlf'])
      write(P, '.gitattributes', '* text eol=lf\n')
    },
  })
}

const blobOf = (W, rev, rel) => git(W, ['rev-parse', `${rev}:${rel}`])

test('a CRLF base blob under `* text eol=lf`: check --after deps passes and an untouched firing commits nothing', T, async t => {
  const fx = phantomProject(t)
  await firing(fx)
  prepare(fx)
  // The control: git itself calls the untouched file modified in the fresh clone.
  assert.match(git(fx.W, ['status', '--porcelain']), /win\.txt/)
  assert.equal(fs.readFileSync(path.join(fx.W, 'win.txt'), 'utf8'), CRLF)
  const d = check(fx, 'deps')
  assert.deepEqual(d.touched, [])
  const c = check(fx, 'dispatch')
  assert.deepEqual(c.touched, [])
  assert.equal(commitCli(fx, c.digest).state, 'unchanged')
})

test('a real edit to a phantom file goes into the commit; the untouched phantom stays out', T, async t => {
  const fx = phantomProject(t)
  await firing(fx)
  prepare(fx)
  const base = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'win.txt', 'one\r\nTWO\r\n')
  write(fx.W, 'a.txt', 'A\n')
  const c = check(fx, 'dispatch')
  assert.deepEqual(c.touched, ['a.txt', 'win.txt'])
  const m = commitCli(fx, c.digest)
  assert.equal(m.state, 'committed', JSON.stringify(m))
  assert.equal(blobOf(fx.W, m.sha, 'old.txt'), blobOf(fx.W, base, 'old.txt'), 'the untouched phantom is the base blob')
  assert.equal(git(fx.W, ['cat-file', 'blob', `${m.sha}:win.txt`]), 'one\nTWO', 'the edit is checked in as git add would')
  assert.deepEqual(git(fx.W, ['diff', '--name-only', base, m.sha]).split('\n').sort(), ['a.txt', 'win.txt'])
})

test('a firing after an interrupted one recovers clean over a phantom file, and the next check passes', T, async t => {
  const fx = phantomProject(t)
  await firing(fx)
  prepare(fx)
  // Interrupted after a delegate edit, before any check.
  write(fx.W, 'a.txt', 'A\n')
  await firing(fx)
  const r = prepare(fx, { date: '2026-10-03' })
  assert.equal(r.state, 'ready', JSON.stringify(r))
  assert.equal(patches(fx).length, 1, 'the leftover edit was saved')
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(fs.readFileSync(path.join(fx.W, 'win.txt'), 'utf8'), CRLF)
  assert.deepEqual(check(fx, 'deps').touched, [])
  // A third firing with nothing left behind: prepare is ready again.
  await firing(fx)
  assert.equal(prepare(fx, { date: '2026-10-03' }).state, 'ready')
})
