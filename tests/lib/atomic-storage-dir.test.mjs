// tests/lib/atomic-storage-dir.test.mjs
// atomic.storageDir (closing review F4): every component from <V> down to a storage directory
// is a real directory whose real path stays under realpath(<V>); a symlink, a file or an escape
// throws CLONE_INVALID. Real directories in a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { storageDir } from '../../scripts/lib/atomic.mjs'

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-sdir-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const invalid = e => e.code === 'CLONE_INVALID' && /^clone-invalid: /.test(e.message)

test('storageDir: real directories pass (created on request, mode 0700), a missing one without create is null', t => {
  // os.tmpdir() may itself sit behind a symlink (/var on macOS): only components below V count.
  const V = path.join(tmp(t), 'V')
  fs.mkdirSync(V)
  const deep = path.join(V, 'out', 'tl', 'loop')
  assert.equal(storageDir(V, deep), null)
  assert.equal(storageDir(V, deep, { create: true }), deep)
  assert.ok(fs.lstatSync(deep).isDirectory())
  assert.equal(fs.statSync(path.join(V, 'out')).mode & 0o077, 0, 'no group or other access')
  assert.equal(storageDir(V, deep), deep)
  assert.equal(storageDir(V, V), V)
})

test('storageDir: a symlink at any component, a file, or a path outside V throws CLONE_INVALID and creates nothing', t => {
  const root = tmp(t)
  const V = path.join(root, 'V')
  const elsewhere = path.join(root, 'owner')
  fs.mkdirSync(V)
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, path.join(V, 'patches'))
  assert.throws(() => storageDir(V, path.join(V, 'patches')), invalid)
  fs.symlinkSync(elsewhere, path.join(V, 'out'))
  assert.throws(() => storageDir(V, path.join(V, 'out', 'tl'), { create: true }), invalid)
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was made through the symlink')
  fs.mkdirSync(path.join(V, 'run-parent'))
  fs.symlinkSync(elsewhere, path.join(V, 'run-parent', 'run'))
  assert.throws(() => storageDir(V, path.join(V, 'run-parent', 'run', 'x'), { create: true }), invalid)
  fs.writeFileSync(path.join(V, 'file'), 'x')
  assert.throws(() => storageDir(V, path.join(V, 'file')), invalid)
  assert.throws(() => storageDir(V, elsewhere), invalid)
  assert.throws(() => storageDir(V, path.join(V, '..', 'owner')), invalid)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
})
