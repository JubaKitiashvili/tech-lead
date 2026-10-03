// tests/lib/atomic.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../helpers.mjs'
import * as atomic from '../../scripts/lib/atomic.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'

const { commitExclusive, createExclusive, readJson, sweepTemps, tempDir, tempFile, writeReplace } = atomic

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

// ---- 0c-2: fsync, temp files and directories, commitExclusive, sweepTemps (brief section 3)

// A hermetic git: no user or system config, a fixed identity, nothing inherited that points
// git at another repository or index.
const GIT_ENV = (() => {
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k]
  return env
})()
const git = (repo, args, extra = {}) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...GIT_ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// The inode at p (lstat), or null when nothing is there.
const ino = p => {
  try {
    return fs.lstatSync(p, { bigint: true }).ino
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// Records every fs.fsyncSync call for the rest of the test and passes it on to the real
// fsync (atomic.mjs calls it through this same fs object). A record names the inode synced,
// whether it is a directory, and what probe() returned at that moment, which shows the
// order of the fsync against the link or rename.
const fsyncSpy = (t, probe) => {
  const real = fs.fsyncSync
  const calls = []
  fs.fsyncSync = fd => {
    const st = fs.fstatSync(fd, { bigint: true })
    calls.push({ ino: st.ino, dir: st.isDirectory(), seen: probe() })
    return real(fd)
  }
  t.after(() => { fs.fsyncSync = real })
  return calls
}

// Runs fn under umask mask; a strict mask shows that a mode is set, not inherited.
const underUmask = (mask, fn) => {
  const old = process.umask(mask)
  try {
    return fn()
  } finally {
    process.umask(old)
  }
}

// A temp file in dir (tempFile) holding bytes, closed; returns its path.
const staged = (dir, bytes) => {
  const { path: p, fd } = tempFile(dir, '.part')
  try {
    fs.writeSync(fd, bytes)
  } finally {
    fs.closeSync(fd)
  }
  return p
}

test('a record\'s temp file is fsynced before link or rename names it, and createExclusive and writeReplace fsync the directory after', t => {
  const dir = tmp(t), file = path.join(dir, 'rec.json'), dirIno = ino(dir)
  const calls = fsyncSpy(t, () => ino(file))
  assert.equal(createExclusive(file, { v: 1 }), true)
  const first = ino(file)
  assert.deepEqual(calls, [
    { ino: first, dir: false, seen: null }, // the temp, before link(2) gave it the name
    { ino: dirIno, dir: true, seen: first }, // the directory, once the name is there
  ])
  calls.length = 0
  writeReplace(file, { v: 2 })
  const second = ino(file)
  assert.notEqual(second, first)
  assert.deepEqual(calls, [
    { ino: second, dir: false, seen: first }, // the temp, while the old record still held the name
    { ino: dirIno, dir: true, seen: second },
  ])
  calls.length = 0
  // A lost race still synced its temp before trying the name.
  assert.equal(createExclusive(file, { v: 3 }), false)
  assert.equal(calls[0].dir, false)
  assert.notEqual(calls[0].ino, second)
  assert.deepEqual(readJson(file), { v: 2 })
  assert.deepEqual(temps(dir), [])
})

test('commitExclusive fsyncs the temp before link(2) and the directory after, also when identical bytes are already there', t => {
  const dir = tmp(t), file = path.join(dir, 'x.bundle'), dirIno = ino(dir)
  const calls = fsyncSpy(t, () => ino(file))
  let p = staged(dir, 'bundle bytes')
  const tmpIno = ino(p)
  calls.length = 0
  assert.deepEqual(commitExclusive(p, file), { created: true })
  assert.equal(ino(file), tmpIno)
  assert.deepEqual(calls, [{ ino: tmpIno, dir: false, seen: null }, { ino: dirIno, dir: true, seen: tmpIno }])
  p = staged(dir, 'bundle bytes')
  const againIno = ino(p)
  calls.length = 0
  assert.deepEqual(commitExclusive(p, file), { created: false })
  assert.deepEqual(calls, [{ ino: againIno, dir: false, seen: tmpIno }, { ino: dirIno, dir: true, seen: tmpIno }])
  assert.deepEqual(temps(dir), [])
})

test('tempFile opens <dir>/.tmp-<pid>-<16 hex><suffix> for writing, mode 0600 whatever the umask, a new name each call', t => {
  const dir = tmp(t)
  const made = underUmask(0o277, () => [tempFile(dir), tempFile(dir, '.idx'), tempFile(dir)])
  const names = made.map(f => path.basename(f.path))
  assert.match(names[0], /^\.tmp-(\d+)-[0-9a-f]{16}$/)
  assert.match(names[1], /^\.tmp-(\d+)-[0-9a-f]{16}\.idx$/)
  for (const n of names) assert.equal(Number(/^\.tmp-(\d+)-/.exec(n)[1]), process.pid, n)
  assert.equal(new Set(names).size, 3)
  for (const f of made) {
    assert.equal(path.dirname(f.path), dir)
    const st = fs.fstatSync(f.fd)
    assert.ok(st.isFile())
    assert.equal(st.mode & 0o777, 0o600, f.path)
    assert.equal(st.size, 0)
    fs.writeSync(f.fd, 'written')
    fs.closeSync(f.fd)
    assert.equal(fs.readFileSync(f.path, 'utf8'), 'written')
  }
  // A suffix is part of the name, never a path.
  for (const bad of ['/x', 'a/b', '/../x', 'a\0b']) {
    assert.throws(() => tempFile(dir, bad), /^Error: bad-suffix: /, JSON.stringify(bad))
  }
  assert.equal(fs.readdirSync(dir).length, 3)
})

test('tempFile and tempDir never take over a name that exists: a planted file or symlink there is an EEXIST, left as it was', t => {
  const dir = tmp(t), outside = tmp(t)
  // Pin the random part so the test knows the name in advance.
  const real = crypto.randomBytes
  crypto.randomBytes = n => Buffer.alloc(n, 0xab)
  t.after(() => { crypto.randomBytes = real })
  const name = path.join(dir, `.tmp-${process.pid}-${'ab'.repeat(8)}`)
  fs.writeFileSync(name, 'keep')
  assert.throws(() => tempFile(dir), { code: 'EEXIST' })
  assert.equal(fs.readFileSync(name, 'utf8'), 'keep')
  assert.throws(() => tempDir(dir), { code: 'EEXIST' })
  fs.rmSync(name)
  const target = path.join(outside, 'target')
  fs.symlinkSync(target, name)
  fs.symlinkSync(target, `${name}.idx`)
  assert.throws(() => tempFile(dir), { code: 'EEXIST' })
  assert.throws(() => tempFile(dir, '.idx'), { code: 'EEXIST' })
  assert.throws(() => tempDir(dir), { code: 'EEXIST' })
  assert.equal(fs.existsSync(target), false, 'the planted symlink was not followed')
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('tempDir makes <dir>/.tmp-<pid>-<16 hex>, mode 0700 whatever the umask; a git index path inside it that does not exist yet works with read-tree, an empty file does not', { timeout: 90000 }, t => {
  const dir = tmp(t)
  const [a, b] = underUmask(0o277, () => [tempDir(dir), tempDir(dir)])
  assert.notEqual(a, b)
  for (const d of [a, b]) {
    assert.equal(path.dirname(d), dir)
    assert.match(path.basename(d), /^\.tmp-(\d+)-[0-9a-f]{16}$/)
    assert.equal(Number(/^\.tmp-(\d+)-/.exec(path.basename(d))[1]), process.pid)
    const st = fs.lstatSync(d)
    assert.ok(st.isDirectory())
    assert.equal(st.mode & 0o777, 0o700, d)
    assert.deepEqual(fs.readdirSync(d), [])
  }
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'a'])
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}'])
  // An index path that does not exist yet: read-tree creates it and the index is whole.
  const index = path.join(a, 'index')
  git(repo, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: index })
  assert.equal(git(repo, ['write-tree'], { GIT_INDEX_FILE: index }), tree)
  assert.equal(git(repo, ['ls-files'], { GIT_INDEX_FILE: index }), 'a.txt')
  // An existing empty file is not an index: every command that reads the index first
  // refuses it (plain read-tree <tree> overwrites without reading, so it is not shown here).
  const empty = tempFile(b, '.index')
  fs.closeSync(empty.fd)
  for (const args of [['read-tree', '-m', 'HEAD'], ['read-tree', '--reset', 'HEAD'], ['write-tree'], ['ls-files']]) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...GIT_ENV, GIT_INDEX_FILE: empty.path } })
    assert.notEqual(r.status, 0, args.join(' '))
    assert.match(r.stderr, /index file smaller than expected/, args.join(' '))
  }
})

test('commitExclusive names the temp once; identical bytes later are created:false, different bytes INTEGRITY; the temp is always removed', t => {
  const dir = tmp(t), file = path.join(dir, 'abc.bundle')
  // Larger than one comparison chunk, so a difference in the last byte is found.
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7)
  const p = staged(dir, big)
  const first = ino(p)
  assert.deepEqual(commitExclusive(p, file), { created: true })
  assert.equal(ino(file), first, 'link(2) gave the temp its name')
  assert.ok(fs.readFileSync(file).equals(big))
  assert.deepEqual(temps(dir), [])
  assert.deepEqual(commitExclusive(staged(dir, big), file), { created: false })
  assert.equal(ino(file), first, 'the record stays the first one')
  assert.deepEqual(temps(dir), [])
  const flipped = Buffer.from(big)
  flipped[flipped.length - 1] ^= 1
  for (const other of [flipped, big.subarray(0, big.length - 1), Buffer.concat([big, Buffer.from('x')]), Buffer.alloc(0)]) {
    assert.throws(() => commitExclusive(staged(dir, other), file),
      e => e.code === 'INTEGRITY' && e.message.startsWith(`integrity: ${file}`), `${other.length} bytes`)
    assert.equal(ino(file), first)
    assert.ok(fs.readFileSync(file).equals(big))
    assert.deepEqual(temps(dir), [])
  }
  // What stands at the name must be a regular file: a symlink to identical bytes, or a
  // directory, is not the record.
  const link = path.join(dir, 'link.bundle')
  fs.symlinkSync(file, link)
  assert.throws(() => commitExclusive(staged(dir, big), link), { code: 'INTEGRITY' })
  assert.equal(fs.readlinkSync(link), file)
  const sub = path.join(dir, 'sub.bundle')
  fs.mkdirSync(sub)
  assert.throws(() => commitExclusive(staged(dir, big), sub), { code: 'INTEGRITY' })
  assert.deepEqual(fs.readdirSync(sub), [])
  assert.deepEqual(temps(dir), [])
  // Any other failure passes through, and the temp still goes.
  assert.throws(() => commitExclusive(staged(dir, big), path.join(dir, 'nope', 'x.bundle')), { code: 'ENOENT' })
  assert.deepEqual(temps(dir), [])
  assert.deepEqual(fs.readdirSync(dir).sort(), ['abc.bundle', 'link.bundle', 'sub.bundle'])
})

// A pid that named a real process a moment ago and names none now: spawnSync has reaped
// the child by the time it returns.
const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
  assert.equal(r.status, 0)
  assert.equal(startToken(r.pid).state, 'gone')
  return r.pid
}
// A live process other than this one, killed and reaped when the test ends.
const liveChild = async t => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
  await once(p, 'spawn')
  t.after(async () => {
    if (p.exitCode !== null || p.signalCode !== null) return
    p.kill('SIGKILL')
    await once(p, 'exit')
  })
  assert.equal(startToken(p.pid).state, 'live')
  return p.pid
}
const hex = n => n.toString(16).padStart(16, '0')

test('sweepTemps removes the temp files and directories of a dead pid and keeps those of a live pid, of an unknown pid, and every other name', { timeout: 90000 }, async t => {
  const dir = tmp(t), outside = tmp(t)
  const live = await liveChild(t)
  const dead = deadPid()
  const file = name => { fs.writeFileSync(path.join(dir, name), name); return name }
  const folder = (name, files) => {
    fs.mkdirSync(path.join(dir, name))
    for (const f of files) fs.writeFileSync(path.join(dir, name, f), f)
    return name
  }
  const symlink = (target, name) => { fs.symlinkSync(target, path.join(dir, name)); return name }
  const target = path.join(outside, 'target'), targetDir = path.join(outside, 'dir')
  fs.writeFileSync(target, 'target')
  fs.mkdirSync(targetDir)
  fs.writeFileSync(path.join(targetDir, 'inner'), 'inner')

  const gone = [
    file(`.tmp-${dead}-${hex(1)}`),
    file(`.tmp-${dead}-${hex(2)}.idx`),
    folder(`.tmp-${dead}-${hex(3)}`, ['index', 'index.lock']),
    folder(`.tmp-${dead}-${hex(4)}`, []),
    // A symlink is unlinked, never followed.
    symlink(target, `.tmp-${dead}-${hex(5)}`),
    symlink(targetDir, `.tmp-${dead}-${hex(6)}`),
  ]
  // A dead pid's directory that holds more than regular files: its regular files go, and the
  // rest, the directory with them, stays (the sweep never goes below one level).
  const deep = folder(`.tmp-${dead}-${hex(7)}`, ['a', 'b'])
  fs.mkdirSync(path.join(dir, deep, 'sub'))
  fs.writeFileSync(path.join(dir, deep, 'sub', 'c'), 'c')
  fs.symlinkSync(target, path.join(dir, deep, 'link'))
  const kept = [
    file(`.tmp-${process.pid}-${hex(8)}`),
    folder(`.tmp-${process.pid}-${hex(9)}`, ['index']),
    file(`.tmp-${live}-${hex(10)}.idx`),
    folder(`.tmp-${live}-${hex(11)}`, ['index']),
    // Unknown: startToken cannot read a pid this large.
    file(`.tmp-99999999999999999999-${hex(12)}`),
    folder(`.tmp-${2 ** 31 + 5}-${hex(13)}`, ['index']),
    // Not temp names.
    file('rec.json'), file(`.tmp-${dead}`), file(`tmp-${dead}-${hex(14)}`), file('.tmp-x-1'),
    file(`.tmp--${dead}-1`), file(`.tmp-0-${hex(15)}`), file(`.tmp-0${dead}-${hex(16)}`), folder(`.tmpx-${dead}-1`, ['index']),
  ]
  const removed = sweepTemps(dir)
  assert.deepEqual([...removed].sort(), gone.map(n => path.join(dir, n)).sort())
  assert.deepEqual(fs.readdirSync(dir).sort(), [...kept, deep].sort())
  assert.deepEqual(fs.readdirSync(path.join(dir, deep)).sort(), ['link', 'sub'])
  assert.equal(fs.readFileSync(path.join(dir, deep, 'sub', 'c'), 'utf8'), 'c')
  assert.equal(fs.readFileSync(target, 'utf8'), 'target')
  assert.deepEqual(fs.readdirSync(targetDir), ['inner'])
  for (const name of kept) {
    const p = path.join(dir, name)
    if (fs.lstatSync(p).isDirectory()) assert.deepEqual(fs.readdirSync(p), ['index'], name)
    else assert.equal(fs.readFileSync(p, 'utf8'), name)
  }
  // Nothing more to sweep; a directory that does not exist has nothing to sweep.
  assert.deepEqual(sweepTemps(dir), [])
  assert.deepEqual(sweepTemps(path.join(dir, 'missing')), [])
})

test('sweepTemps keeps the temps of a live pid whose start token ps cannot read, and still removes a dead pid\'s', { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
  const dir = tmp(t)
  const live = await liveChild(t)
  const dead = deadPid()
  const fake = path.join(tmp(t), 'ps')
  fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = process.env.TECH_LEAD_PS
  process.env.TECH_LEAD_PS = fake
  t.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
  assert.equal(startToken(live).state, 'unknown')
  const keep = [`.tmp-${live}-${hex(1)}`, `.tmp-${live}-${hex(2)}`]
  fs.writeFileSync(path.join(dir, keep[0]), '')
  fs.mkdirSync(path.join(dir, keep[1]))
  fs.writeFileSync(path.join(dir, keep[1], 'index'), '')
  const drop = `.tmp-${dead}-${hex(3)}`
  fs.mkdirSync(path.join(dir, drop))
  fs.writeFileSync(path.join(dir, drop, 'index'), '')
  assert.deepEqual(sweepTemps(dir), [path.join(dir, drop)])
  assert.deepEqual(fs.readdirSync(dir).sort(), keep.sort())
  assert.deepEqual(fs.readdirSync(path.join(dir, keep[1])), ['index'])
})
