// tests/lib/run-record-storage.test.mjs
// run-record against a symlinked <V>/run (closing review F4, Codex g2 #1): create, update and
// delete refuse CLONE_INVALID and the directory the symlink names is untouched (createRecord
// used to accept EEXIST from mkdir for a symlink there). Real directories in a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRecord, deleteRecord, recordFile, updateRecord } from '../../scripts/lib/run-record.mjs'

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-rrs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const invalid = e => e.code === 'CLONE_INVALID' && /^clone-invalid: /.test(e.message)

test('run-record: a symlinked <V>/run is refused for create, update and delete; the target is untouched (F4)', t => {
  const root = tmp(t)
  const V = path.join(root, 'V')
  fs.mkdirSync(V)
  const paths = { V }
  assert.equal(createRecord(paths, 1), true)
  const elsewhere = path.join(root, 'owner')
  fs.renameSync(path.join(V, 'run'), elsewhere)
  fs.symlinkSync(elsewhere, path.join(V, 'run'))
  const before = fs.readdirSync(elsewhere).sort()
  assert.throws(() => createRecord(paths, 2), invalid)
  assert.throws(() => updateRecord(paths, 1, { pre_head: 'a'.repeat(40) }), invalid)
  assert.throws(() => deleteRecord(paths, 1), invalid)
  assert.deepEqual(fs.readdirSync(elsewhere).sort(), before)
  assert.equal(JSON.parse(fs.readFileSync(path.join(elsewhere, '1.json'), 'utf8')).pre_head, null)
  // A fresh <V> whose run is a symlink from the start: createRecord's EEXIST never accepts it.
  const V2 = path.join(root, 'V2')
  fs.mkdirSync(V2)
  fs.symlinkSync(elsewhere, path.join(V2, 'run'))
  assert.throws(() => createRecord({ V: V2 }, 7), invalid)
  assert.equal(fs.existsSync(path.join(elsewhere, '7.json')), false)
  assert.equal(recordFile({ V: V2 }, 7), path.join(V2, 'run', '7.json'))
})
