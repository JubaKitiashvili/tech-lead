// scripts/lib/atomic.mjs
// Atomic records for the loop's lock and state files, and the temporary files and
// directories behind them. A record is written whole to a temporary file in its own
// directory (<dir>/.tmp-<pid>-<16 hex>), fsynced, and only then given its name, so a reader
// in another process sees either no record, the old one or the new one, never a partial
// one; the directory is fsynced after the name changes, so the name survives a crash too.
//   createExclusive(file, obj, {guard}) -> true, or false when file already exists (link(2)
//                                 is the exclusive step, so two racers cannot both win)
//   writeReplace(file, obj, {guard})  creates or replaces file (rename(2))
//   readJson(file) -> object | null; null only when file is missing; throws
//                                 Error('corrupt: <file>') when the content is not a JSON object
//                                 or the name is not a regular file (a symlink, a FIFO, a
//                                 socket or a device: never followed, never a blocking read);
//                                 a directory throws code EISDIR
//   tempFile(dir, suffix = '') -> {path, fd}: <dir>/.tmp-<pid>-<16 hex><suffix>, created
//                                 O_CREAT|O_EXCL|O_WRONLY with mode 0600; the caller writes
//                                 and closes fd. A suffix holding '/' or NUL is refused
//                                 (bad-suffix), so the name never leaves dir.
//   tempDir(dir) -> path          <dir>/.tmp-<pid>-<16 hex>, created mode 0700. A temporary
//                                 git index is a path inside one that does not exist yet:
//                                 git refuses an existing empty file as an index.
//   commitExclusive(tmpPath, file, {guard}) -> {created}: fsync tmpPath, link(2) it to file,
//                                 fsync the directory. A file already there with identical bytes
//                                 is {created:false}; anything else there (other bytes, or
//                                 not a regular file) throws 'integrity: ...' with code
//                                 INTEGRITY. tmpPath is removed in every case (a bad guard
//                                 included).
//   storageDir(V, dir, {create = false}) -> dir | null: every component of dir below V (dir
//                                 itself included, V and its ancestors not) is a real directory,
//                                 never a symlink (lstat), and realpath(dir) is realpath(V) joined
//                                 with the same names. With create, a missing component is made
//                                 (mode 0700); without, a missing one gives null. A symlink, a
//                                 file, or a dir outside V throws 'clone-invalid: <path> is
//                                 <kind>, not a directory in <V>' (code CLONE_INVALID; every CLI
//                                 reports that as exit 3 {state:'clone-invalid'}). Callers check
//                                 a storage directory of <V> (patches, run, out/<prefix>) and the
//                                 clone root <W> with it before they sweep, allocate a temp,
//                                 create a record or publish there, so a delegate that replaced
//                                 one with a symlink into <P> cannot redirect a helper's writes.
//   sweepTemps(dir) -> string[]   removes the .tmp-<pid>-* entries of dir whose pid is gone
//                                 (startToken), and returns the paths it removed. A file
//                                 (or symlink) is unlinked; a directory has its regular files
//                                 unlinked and is then removed with rmdir, so it stays when it
//                                 holds anything else. A live pid and one whose state is
//                                 unknown keep their entries. A missing dir sweeps nothing.
// The modes are set on the open descriptor after creation, so the caller's umask neither
// widens nor narrows them.
// guard (optional; R31 as sharpened): the caller's lock check, called after the temp is written
// and fsynced, immediately before the rename(2) or link(2) that publishes it, with nothing in
// between; whatever it throws propagates and the temp is removed, so a lock lost during the
// fsync publishes nothing. Anything but a function or undefined is a TypeError before any I/O.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { startToken } from './loop-proc.mjs'

const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fs.constants
const COMPARE_CHUNK = 1024 * 1024
// The pid part is a decimal without a leading zero, as tempName writes it.
const TEMP_ENTRY = /^\.tmp-([1-9][0-9]*)-/

const tempName = (suffix = '') => `.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}${suffix}`

// fsync(2) of a directory makes the names in it durable. A filesystem that cannot sync a
// directory says EINVAL (or ENOTSUP); that is no failure of the write, so it is not one here.
function fsyncDir(dir) {
  const fd = fs.openSync(dir, O_RDONLY | O_DIRECTORY)
  try {
    fs.fsyncSync(fd)
  } catch (e) {
    if (e.code !== 'EINVAL' && e.code !== 'ENOTSUP') throw e
  } finally {
    fs.closeSync(fd)
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function guardOf(opts, who) {
  const guard = opts?.guard
  if (guard !== undefined && typeof guard !== 'function') throw new TypeError(`${who}: guard must be a function () => void that throws when the firing lock is lost`)
  return guard ?? (() => {})
}

// The record's bytes in a new temp file next to file, fsynced and closed. A failure after
// the temp exists removes it; a failure to create it removes nothing (the name is not ours).
function writeTemp(file, obj) {
  const tmp = path.join(path.dirname(file), tempName())
  const fd = fs.openSync(tmp, 'wx')
  let ok = false
  try {
    fs.writeFileSync(fd, JSON.stringify(obj) + '\n')
    fs.fsyncSync(fd)
    ok = true
  } finally {
    fs.closeSync(fd)
    if (!ok) fs.rmSync(tmp, { force: true })
  }
  return tmp
}

export function createExclusive(file, obj, opts = {}) {
  const guard = guardOf(opts, 'createExclusive')
  const tmp = writeTemp(file, obj)
  let created = false
  try {
    guard()
    fs.linkSync(tmp, file)
    created = true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  if (created) fsyncDir(path.dirname(file))
  return created
}

export function writeReplace(file, obj, opts = {}) {
  const guard = guardOf(opts, 'writeReplace')
  const tmp = writeTemp(file, obj)
  try {
    guard()
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fsyncDir(path.dirname(file))
}

// Opened O_NONBLOCK|O_NOFOLLOW and judged by fstat before any read: a FIFO put at the name (no
// writer) would block a plain read forever, and a symlink there is no record a helper wrote.
export function readJson(file) {
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    if (e.code === 'ELOOP') throw new Error(`corrupt: ${file}`)
    throw e
  }
  let text
  try {
    const st = fs.fstatSync(fd)
    if (st.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${file}'`), { code: 'EISDIR' })
    if (!st.isFile()) throw new Error(`corrupt: ${file}`)
    text = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`corrupt: ${file}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`corrupt: ${file}`)
  return value
}

export function tempFile(dir, suffix = '') {
  if (typeof suffix !== 'string' || suffix.includes('/') || suffix.includes('\0')) {
    throw new Error(`bad-suffix: ${JSON.stringify(suffix)}`)
  }
  const file = path.join(dir, tempName(suffix))
  // O_EXCL with O_CREAT fails on any existing entry, a symlink included, and never follows one.
  const fd = fs.openSync(file, O_CREAT | O_EXCL | O_WRONLY, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
  } catch (e) {
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
    throw e
  }
  return { path: file, fd }
}

export function tempDir(dir) {
  const made = path.join(dir, tempName())
  fs.mkdirSync(made, { mode: 0o700 })
  try {
    const fd = fs.openSync(made, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try {
      fs.fchmodSync(fd, 0o700)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    fs.rmdirSync(made)
    throw e
  }
  return made
}

// readSync until n bytes are in buf (or the file ends); returns how many were read.
function readFull(fd, buf, n, position) {
  let got = 0
  while (got < n) {
    const r = fs.readSync(fd, buf, got, n - got, position + got)
    if (r === 0) break
    got += r
  }
  return got
}

// true when file is a regular file holding exactly the bytes of tmp. Compared a chunk at a
// time, so a large bundle is never read into memory whole.
function sameBytes(tmp, file) {
  if (!fs.lstatSync(file).isFile()) return false
  const fa = fs.openSync(tmp, O_RDONLY | O_NOFOLLOW)
  try {
    let fb
    try {
      fb = fs.openSync(file, O_RDONLY | O_NOFOLLOW)
    } catch (e) {
      if (e.code === 'ELOOP') return false // replaced by a symlink since the lstat
      throw e
    }
    try {
      const sa = fs.fstatSync(fa), sb = fs.fstatSync(fb)
      if (!sb.isFile() || sa.size !== sb.size) return false
      const ba = Buffer.alloc(Math.min(COMPARE_CHUNK, sa.size)), bb = Buffer.alloc(ba.length)
      for (let pos = 0; pos < sa.size;) {
        const n = Math.min(ba.length, sa.size - pos)
        if (readFull(fa, ba, n, pos) !== n || readFull(fb, bb, n, pos) !== n) return false
        if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false
        pos += n
      }
      return true
    } finally {
      fs.closeSync(fb)
    }
  } finally {
    fs.closeSync(fa)
  }
}

export function commitExclusive(tmpPath, file, opts = {}) {
  try {
    const guard = guardOf(opts, 'commitExclusive')
    fsyncFile(tmpPath)
    let created = true
    try {
      guard()
      fs.linkSync(tmpPath, file)
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (!sameBytes(tmpPath, file)) {
        throw Object.assign(new Error(`integrity: ${file} already exists with other content`), { code: 'INTEGRITY' })
      }
      created = false
    }
    // Also when the bytes were there already: their writer may have died before its own
    // directory fsync, and a caller now relies on the name.
    fsyncDir(path.dirname(file))
    return { created }
  } finally {
    fs.rmSync(tmpPath, { force: true })
  }
}

const kindOf = st => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a regular file' : 'a special file')

export function storageDir(V, dir, { create = false } = {}) {
  const root = path.resolve(V)
  const target = path.resolve(dir)
  const rel = path.relative(root, target)
  const invalid = (p, kind) => Object.assign(new Error(`clone-invalid: ${p} is ${kind}, not a directory in ${root}`), { code: 'CLONE_INVALID', kind })
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw invalid(target, 'outside')
  let p = root
  for (const name of rel === '' ? [] : rel.split(path.sep)) {
    p = path.join(p, name)
    let st = lstatOrNull(p)
    if (!st && create) {
      try {
        fs.mkdirSync(p, { mode: 0o700 })
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
      st = lstatOrNull(p)
    }
    if (!st) return null
    if (!st.isDirectory()) throw invalid(p, kindOf(st))
  }
  // Each component was a real directory when read; the real path catches a swap since.
  if (fs.realpathSync.native(target) !== path.join(fs.realpathSync.native(root), rel)) throw invalid(target, 'elsewhere on disk')
  return target
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

// Unlinks p; false when it was already gone.
function unlinkIfThere(p) {
  try {
    fs.unlinkSync(p)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

// Unlinks the regular files directly inside d, then rmdir d. false when d is gone or still
// holds something else (a directory, a symlink): nothing below the first level is touched.
function removeTempDir(d) {
  let names
  try {
    names = fs.readdirSync(d)
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
  for (const name of names) {
    const p = path.join(d, name)
    let st
    try {
      st = fs.lstatSync(p)
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    if (st.isFile()) unlinkIfThere(p)
  }
  try {
    fs.rmdirSync(d)
    return true
  } catch (e) {
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'ENOENT') return false
    throw e
  }
}

export function sweepTemps(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const states = new Map()
  const gone = pid => {
    if (!states.has(pid)) states.set(pid, startToken(pid).state)
    return states.get(pid) === 'gone'
  }
  const removed = []
  for (const name of names.sort()) {
    const m = TEMP_ENTRY.exec(name)
    if (!m || !gone(Number(m[1]))) continue
    const p = path.join(dir, name)
    let st
    try {
      st = fs.lstatSync(p)
    } catch (e) {
      if (e.code === 'ENOENT') continue
      throw e
    }
    if (st.isDirectory() ? removeTempDir(p) : unlinkIfThere(p)) removed.push(p)
  }
  return removed
}
