// tests/lib/atomic-fifo.test.mjs
// atomic.readJson against a name that is no regular file (closing review F7, Codex g2 #3): a
// FIFO with no writer put where a delivery sidecar belongs must read as corrupt at once, never
// block. Each read runs in a child process with a timeout, so a regression fails the test
// instead of hanging the suite (a blocked synchronous read cannot be interrupted in-process).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../helpers.mjs'

const ATOMIC = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'atomic.mjs')).href
const DELIVERY = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'delivery.mjs')).href
const READ_MS = 5000

const tmp = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fifo-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Runs code (an ES module body that prints one JSON line) in a child; {timedOut, out}.
function child(code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: READ_MS })
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM'
  let out = null
  try { out = JSON.parse(r.stdout.trim()) } catch { out = null }
  return { timedOut, out, stderr: r.stderr }
}

const readJsonIn = file => child(`
import { readJson } from ${JSON.stringify(ATOMIC)}
try { console.log(JSON.stringify({ value: readJson(${JSON.stringify(file)}) })) }
catch (e) { console.log(JSON.stringify({ message: e.message, code: e.code ?? null })) }`)

test('readJson: a FIFO with no writer is corrupt at once, never a blocking read', t => {
  const dir = tmp(t)
  const fifo = path.join(dir, 'x.json')
  execFileSync('mkfifo', [fifo])
  const r = readJsonIn(fifo)
  assert.equal(r.timedOut, false, `readJson blocked on a FIFO (stderr ${r.stderr})`)
  assert.deepEqual(r.out, { message: `corrupt: ${fifo}`, code: null })
})

test('readJson: a symlink at the name is corrupt; a regular file, a missing name and a directory read as before', t => {
  const dir = tmp(t)
  const real = path.join(dir, 'real.json')
  fs.writeFileSync(real, '{"v":1}\n')
  const link = path.join(dir, 'link.json')
  fs.symlinkSync(real, link)
  assert.deepEqual(readJsonIn(link).out, { message: `corrupt: ${link}`, code: null })
  assert.deepEqual(readJsonIn(real).out, { value: { v: 1 } })
  assert.deepEqual(readJsonIn(path.join(dir, 'missing.json')).out, { value: null })
  assert.equal(readJsonIn(dir).out.code, 'EISDIR')
})

test('readSidecar: a FIFO sidecar reads as no sidecar, without blocking', t => {
  const dir = tmp(t)
  const V = path.join(dir, 'V')
  const side = path.join(V, 'out', 'tl', '2026-10-02.bundle.json')
  fs.mkdirSync(path.dirname(side), { recursive: true })
  execFileSync('mkfifo', [side])
  const r = child(`
import { readSidecar } from ${JSON.stringify(DELIVERY)}
try { console.log(JSON.stringify({ value: readSidecar({ V: ${JSON.stringify(V)} }, 'tl/2026-10-02') })) }
catch (e) { console.log(JSON.stringify({ message: e.message })) }`)
  assert.equal(r.timedOut, false, `readSidecar blocked on a FIFO (stderr ${r.stderr})`)
  assert.deepEqual(r.out, { value: null })
})
