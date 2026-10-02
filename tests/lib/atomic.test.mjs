// tests/lib/atomic.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../helpers.mjs'
import { createExclusive, readJson, writeReplace } from '../../scripts/lib/atomic.mjs'

const MODULE = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'atomic.mjs')).href
const PAD = 65536 // large enough that a write is not one instant, so a torn record would show
const tmp = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-atomic-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const temps = dir => fs.readdirSync(dir).filter(f => f.startsWith('.tmp-'))

// The participants of one race are separate node processes. Each announces itself in
// <dir>/ready-<who> and spins until every participant has, so they start together. A child
// prints one JSON line; a child still running when the test ends is killed.
const BARRIER = `
import fs from 'node:fs'
import path from 'node:path'
const { DIR, WHO, ALL } = process.env
fs.writeFileSync(path.join(DIR, 'ready-' + WHO), '')
const barrierEnd = Date.now() + 30000
while (!ALL.split(',').every(w => fs.existsSync(path.join(DIR, 'ready-' + w)))) {
  if (Date.now() > barrierEnd) { console.log(JSON.stringify({ error: 'barrier' })); process.exit(2) }
}
`
const child = (t, body, env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', BARRIER + body], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL') })
  let out = '', err = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { err += d })
  p.on('error', reject)
  p.on('close', status => {
    if (status !== 0) return reject(new Error(`child ${env.WHO} exit ${status}: ${err}${out}`))
    resolve(JSON.parse(out))
  })
})

test('two processes racing createExclusive on the same files: exactly one wins each, and a reader never sees a partial record', async t => {
  const dir = tmp(t), files = path.join(dir, 'files')
  fs.mkdirSync(files)
  fs.mkdirSync(path.join(dir, 'gate'))
  const N = 200, ALL = 'a,b,reader'
  // The writers go in lockstep: both reach file i before either tries it, so each file is contested.
  const writer = `
import { createExclusive } from ${JSON.stringify(MODULE)}
const won = []
const gate = i => path.join(DIR, 'gate', i + '-')
for (let i = 0; i < ${N}; i++) {
  fs.writeFileSync(gate(i) + WHO, '')
  while (!fs.existsSync(gate(i) + 'a') || !fs.existsSync(gate(i) + 'b')) {
    if (Date.now() > barrierEnd) { console.log(JSON.stringify({ error: 'gate ' + i })); process.exit(2) }
  }
  if (createExclusive(path.join(DIR, 'files', i + '.json'), { who: WHO, i, pad: 'x'.repeat(${PAD}) })) won.push(i)
}
console.log(JSON.stringify(won))
`
  // Follows the frontier: spins on the first file not seen yet and checks it the moment it appears.
  const reader = `
import { readJson } from ${JSON.stringify(MODULE)}
let reads = 0, bad = 0
const until = Date.now() + 30000
for (let i = 0; i < ${N} && Date.now() < until;) {
  let rec
  try { rec = readJson(path.join(DIR, 'files', i + '.json')) } catch { bad++; continue }
  if (rec === null) continue
  reads++
  if (rec.i !== i || rec.pad.length !== ${PAD} || !['a', 'b'].includes(rec.who)) bad++
  i++
}
console.log(JSON.stringify({ reads, bad }))
`
  const [a, b, r] = await Promise.all([
    child(t, writer, { DIR: dir, WHO: 'a', ALL }),
    child(t, writer, { DIR: dir, WHO: 'b', ALL }),
    child(t, reader, { DIR: dir, WHO: 'reader', ALL }),
  ])
  assert.equal(a.length + b.length, N, 'every file has exactly one winner')
  assert.deepEqual([...a, ...b].sort((x, y) => x - y), Array.from({ length: N }, (_, i) => i))
  for (const [who, won] of [['a', a], ['b', b]]) {
    for (const i of won) assert.equal(readJson(path.join(files, `${i}.json`)).who, who, `file ${i}`)
  }
  assert.deepEqual(r, { reads: N, bad: 0 })
  assert.deepEqual(temps(files), [], 'no temporary file is left behind')
})

test('createExclusive writes a new record and refuses an existing one without touching it', t => {
  const dir = tmp(t), file = path.join(dir, '1.json')
  assert.equal(createExclusive(file, { v: 1, generation: 1 }), true)
  assert.deepEqual(readJson(file), { v: 1, generation: 1 })
  assert.equal(createExclusive(file, { v: 1, generation: 2 }), false)
  assert.deepEqual(readJson(file), { v: 1, generation: 1 })
  assert.deepEqual(fs.readdirSync(dir), ['1.json'])
  // A missing directory is an error, not a lost race.
  assert.throws(() => createExclusive(path.join(dir, 'nope', '2.json'), { v: 1 }), { code: 'ENOENT' })
})

test('writeReplace creates or replaces a record in place, leaving no temporary file', t => {
  const dir = tmp(t), file = path.join(dir, 'child.json')
  writeReplace(file, { v: 1, pid: null })
  assert.deepEqual(readJson(file), { v: 1, pid: null })
  writeReplace(file, { v: 1, pid: 42 })
  assert.deepEqual(readJson(file), { v: 1, pid: 42 })
  assert.deepEqual(fs.readdirSync(dir), ['child.json'])
  assert.throws(() => writeReplace(path.join(dir, 'nope', 'x.json'), { v: 1 }), { code: 'ENOENT' })
})

test('a reader process never sees a partial record while another process replaces it', async t => {
  const dir = tmp(t), file = path.join(dir, 'rec.json'), M = 100, ALL = 'writer,reader'
  writeReplace(file, { seq: -1, pad: 'x'.repeat(PAD) })
  const writer = `
import { writeReplace } from ${JSON.stringify(MODULE)}
for (let seq = 0; seq < ${M}; seq++) writeReplace(path.join(DIR, 'rec.json'), { seq, pad: 'x'.repeat(${PAD}) })
console.log('{}')
`
  const reader = `
import { readJson } from ${JSON.stringify(MODULE)}
let reads = 0, bad = 0, missing = 0, regress = 0, last = -1
const until = Date.now() + 30000
while (last < ${M - 1} && Date.now() < until) {
  let rec
  try { rec = readJson(path.join(DIR, 'rec.json')) } catch { bad++; continue }
  if (rec === null) { missing++; continue }
  reads++
  if (rec.pad.length !== ${PAD}) bad++
  if (rec.seq < last) regress++
  last = rec.seq
}
console.log(JSON.stringify({ bad, missing, regress, last, any: reads > 0 }))
`
  const [, r] = await Promise.all([
    child(t, writer, { DIR: dir, WHO: 'writer', ALL }),
    child(t, reader, { DIR: dir, WHO: 'reader', ALL }),
  ])
  assert.deepEqual(r, { bad: 0, missing: 0, regress: 0, last: M - 1, any: true })
  assert.deepEqual(temps(dir), [])
})

test('readJson: a missing file is null; unparseable or non-object content is corrupt; other errors pass through', t => {
  const dir = tmp(t), file = path.join(dir, 'r.json')
  assert.equal(readJson(file), null)
  for (const content of ['', '{"v":1', 'not json', 'null', '42', '[1]', '"s"']) {
    fs.writeFileSync(file, content)
    assert.throws(() => readJson(file), e => e instanceof Error && e.message === `corrupt: ${file}`, JSON.stringify(content))
  }
  fs.writeFileSync(file, '{"v":1}\n')
  assert.deepEqual(readJson(file), { v: 1 })
  // A directory where a record belongs is neither missing nor a record.
  assert.throws(() => readJson(dir), { code: 'EISDIR' })
})
