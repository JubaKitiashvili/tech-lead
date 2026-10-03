// tests/lib/atomic-guard.test.mjs
// Publication guards (closing review F6; sharpened R31): writeReplace, createExclusive and
// commitExclusive call the caller's guard after the temporary file is written and fsynced,
// immediately before the rename or link that publishes it, and remove the temp when it throws;
// run-record's createRecord and updateRecord pass a guard through. Real files in a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitExclusive, createExclusive, tempFile, writeReplace } from '../../scripts/lib/atomic.mjs'
import { createRecord, readRecord, recordFile, updateRecord } from '../../scripts/lib/run-record.mjs'

const tmp = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-guard-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const temps = dir => fs.readdirSync(dir).filter(n => n.startsWith('.tmp-'))
const lockLost = () => Object.assign(new Error('not-holder: generation 1 was released'), { code: 'NOT_HOLDER' })

// A guard that records what dir holds when it runs (each temp's bytes), then throws or not.
function spy(dir, { fail = true } = {}) {
  const calls = []
  const guard = () => {
    calls.push(Object.fromEntries(temps(dir).map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')])))
    if (fail) throw lockLost()
  }
  return { guard, calls }
}

test('writeReplace: the guard runs once the whole record is in its temp, right before the rename; a throw publishes nothing', t => {
  const dir = tmp(t)
  const file = path.join(dir, 'rec.json')
  writeReplace(file, { v: 1 })
  const s = spy(dir)
  assert.throws(() => writeReplace(file, { v: 2 }, { guard: s.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(s.calls.length, 1)
  assert.deepEqual(Object.values(s.calls[0]), ['{"v":2}\n'], 'the temp held the whole record when the guard ran')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}\n', 'the old record stays')
  assert.deepEqual(temps(dir), [], 'the temp is removed')
  const ok = spy(dir, { fail: false })
  writeReplace(file, { v: 3 }, { guard: ok.guard })
  assert.equal(ok.calls.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":3}\n')
  assert.deepEqual(temps(dir), [])
})

test('createExclusive: the guard runs right before the link; a throw creates nothing', t => {
  const dir = tmp(t)
  const file = path.join(dir, 'slot.json')
  const s = spy(dir)
  assert.throws(() => createExclusive(file, { v: 1 }, { guard: s.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(s.calls.length, 1)
  assert.deepEqual(Object.values(s.calls[0]), ['{"v":1}\n'])
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(temps(dir), [])
  const ok = spy(dir, { fail: false })
  assert.equal(createExclusive(file, { v: 2 }, { guard: ok.guard }), true)
  assert.equal(ok.calls.length, 1)
  assert.equal(createExclusive(file, { v: 3 }, { guard: ok.guard }), false)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}\n')
  assert.deepEqual(temps(dir), [])
})

test('commitExclusive: the guard runs after the fsync, right before the link; a throw links nothing and removes the temp', t => {
  const dir = tmp(t)
  const file = path.join(dir, 'b.patch')
  const { path: p, fd } = tempFile(dir, '.patch')
  fs.writeSync(fd, 'bytes\n')
  fs.closeSync(fd)
  const s = spy(dir)
  assert.throws(() => commitExclusive(p, file, { guard: s.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(s.calls.length, 1)
  assert.deepEqual(Object.values(s.calls[0]), ['bytes\n'])
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(temps(dir), [])
  const again = tempFile(dir, '.patch')
  fs.writeSync(again.fd, 'bytes\n')
  fs.closeSync(again.fd)
  const ok = spy(dir, { fail: false })
  assert.deepEqual(commitExclusive(again.path, file, { guard: ok.guard }), { created: true })
  assert.equal(ok.calls.length, 1)
  assert.deepEqual(temps(dir), [])
})

test('a guard that is not a function is refused before any temp exists', t => {
  const dir = tmp(t)
  const file = path.join(dir, 'x.json')
  assert.throws(() => writeReplace(file, { v: 1 }, { guard: true }), TypeError)
  assert.throws(() => createExclusive(file, { v: 1 }, { guard: 'yes' }), TypeError)
  const { path: p, fd } = tempFile(dir)
  fs.closeSync(fd)
  assert.throws(() => commitExclusive(p, file, { guard: 1 }), TypeError)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(temps(dir), [])
})

test('run-record: createRecord and updateRecord pass the guard to the publication; a throw leaves the record as it was', t => {
  const V = tmp(t)
  const paths = { V }
  const run = path.join(V, 'run')
  const s = spy(run)
  assert.throws(() => createRecord(paths, 1, {}, { guard: s.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(s.calls.length, 1)
  assert.equal(JSON.parse(Object.values(s.calls[0])[0]).generation, 1, 'the guard ran with the record in its temp')
  assert.equal(fs.existsSync(recordFile(paths, 1)), false)
  assert.deepEqual(temps(run), [])
  // The object form takes the options third.
  assert.throws(() => createRecord(paths, { generation: 1 }, { guard: s.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(fs.existsSync(recordFile(paths, 1)), false)
  assert.equal(createRecord(paths, 1, {}, { guard: () => {} }), true)
  const before = fs.readFileSync(recordFile(paths, 1), 'utf8')
  const u = spy(run)
  assert.throws(() => updateRecord(paths, 1, { pre_head: 'a'.repeat(40) }, { guard: u.guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(u.calls.length, 1)
  assert.equal(JSON.parse(Object.values(u.calls[0])[0]).pre_head, 'a'.repeat(40))
  assert.equal(fs.readFileSync(recordFile(paths, 1), 'utf8'), before, 'the record is unchanged')
  assert.deepEqual(temps(run), [])
  updateRecord(paths, 1, { pre_head: 'b'.repeat(40) }, { guard: () => {} })
  assert.equal(readRecord(paths, 1).pre_head, 'b'.repeat(40))
})
