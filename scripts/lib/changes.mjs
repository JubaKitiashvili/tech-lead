// scripts/lib/changes.mjs
// The change-set owner (stage 0c-2, brief section 8): what the loop's clone <W> holds against a
// base commit, listed under ignore rules that were recorded before any dispatch (spec 7.5 as
// amended by A11), and the trees built from it.
//
// Paths. Between git calls a path is raw bytes (a Buffer; every git call uses -z). In what this
// module returns and accepts, a path is a string when its bytes are valid UTF-8 and otherwise
// {b64: '<base64 of the bytes>'} (encodePath / decodePath), so every result goes into JSON and
// canonicalJson as it is. Lists come sorted by bytes, git's own order.
//
// Ignore rules (rules = {v:1, mode, base, ignores:[{path, oid}], excludes_file, info_exclude}):
//   recordRules   mode 'recorded': every regular file named .gitignore in the work tree (any
//                 depth, tracked or not; a filesystem walk that skips .git and does not enter a
//                 nested repository), each stored as a blob (hash-object -w --no-filters); the
//                 user's excludes file (core.excludesFile, else the XDG default) as bytes; the
//                 bytes of <W>/.git/info/exclude (missing = empty). An excludes file whose real
//                 path lies under <V> or <R> is refused (excludes-file-in-work-area).
//   currentRules  mode 'current': the same read now (a record in which no dispatch ran).
//   baseRules     mode 'base': the base commit's .gitignore blobs, an empty info/exclude (a
//                 valid clone has none) and the current excludes file (leftovers, no record).
//   listUntracked the replay (ruling R1): a temporary index holds the base plus, for each recorded
//                 ignore file in directory d, a skip-worktree entry d/<nonce> with its blob, and
//                 ls-files -o reads --exclude-per-directory=<nonce>, so git takes each recorded
//                 file from the index and never from the work tree; the excludes file and
//                 info/exclude go in as two --exclude-from files, in git's precedence order. A
//                 <d>/<nonce> present in the work tree is refused (tampered).
//
// Two listings (ruling R2). collect (saves, the reset precondition) lists untracked files under
// the given rules; touched (check, commit, deps-dirty) uses git's standard listing, and reports
// as hidden what only the recorded rules see.
//
// Nothing executes while saving (R19). collect, indexOnly and captureTree run every git call that
// converts content with each configured filter driver neutralized (clean, smudge and process
// emptied, required false) and with attributes read from the base commit (GIT_ATTR_SOURCE), so a
// delegate's .gitattributes neither runs a program nor hides an edit. Before any of them relies on
// GIT_ATTR_SOURCE, git-safe's feature test runs (R24): a git that ignores the variable is refused
// (REFUSED, state infra, detail 'git-too-old: needs git 2.40 or newer'). captureTree stores raw
// bytes (hash-object --no-filters; a symlink's target text). stageTree and touched are the commit
// path: git's normal check-in conversion, filters included (R9).
//
// Saves see raw bytes (R29). collect lists, besides git's own diff, every tracked regular file
// whose raw bytes differ both from the base blob and from what a checkout of the base writes
// (checkout-index into a temporary directory, filters neutralized, attributes from the base), so
// an ident expansion or line endings that a conversion folds away are still saved. R29a, the
// deliberate exception to R29's "every tracked path": a file whose raw bytes equal the base blob
// is not listed even when they differ from what a checkout writes (LF bytes in an eol=crlf or
// core.autocrlf file). Those bytes already have a durable home in the base, and listing them
// would stall every save: the save captures a tree equal to the base and returns empty while
// collect would stay dirty. Only files a conversion can touch are compared (core.autocrlf set,
// or a text, eol, crlf, ident or working-tree-encoding attribute); with core.filemode false, an
// exec bit that differs from the base mode is listed too.
//
// Change detection never makes git run inside a nested repository (R26): diff-index and diff-files
// use --ignore-submodules=dirty (a gitlink's commit change is still seen and stays unsavable), the
// refresh passes --ignore-submodules, and git-safe pins submodule.recurse=false.
//
// Every git call goes through workGit; temporary indexes live in atomic.tempDir(<V>/patches)
// and are removed in finally. Refusals throw code 'REFUSED' with `state` (layout, tampered,
// base-unknown, tree-unknown, excludes-file-in-work-area, unsafe-config); a path that cannot be
// captured throws code 'UNSAVABLE' with `reason`.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertAttrSource, workGit, workGitRun } from './git-safe.mjs'
import { loopPaths } from './loop-paths.mjs'
import { storageDir, tempDir } from './atomic.mjs'
import { canonicalJson, sha256Hex } from './canonical.mjs'

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
const SLASH = Buffer.from('/')
const NUL = Buffer.from([0])
const DOT_GIT = Buffer.from('.git')
const GITIGNORE = Buffer.from('.gitignore')
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const NONCE = /^\.tlx-[0-9a-f]{12}$/
const MODES = new Set(['recorded', 'current', 'base'])
// Base modes whose work-tree directory obstructs a tracked file (R21).
const FILE_MODES = new Set(['100644', '100755', '120000'])
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const key = buf => buf.toString('latin1')
const byBytes = (a, b) => Buffer.compare(a, b)
const joinNul = list => Buffer.concat(list.flatMap(p => [p, NUL]))
const show = buf => JSON.stringify(encodePath(buf))

function refused(state, detail, extra = {}) {
  return Object.assign(new Error(`${state}: ${detail}`), { code: 'REFUSED', state, detail }, extra)
}

function unsavableError(p, reason) {
  return Object.assign(new Error(`unsavable: ${show(p)} (${reason})`), { code: 'UNSAVABLE', state: 'unsavable', reason, path: encodePath(p) })
}

// ---------------------------------------------------------------- paths

// A path's bytes -> its JSON form: the string when the bytes are valid UTF-8 (a leading BOM kept),
// else {b64}.
export function encodePath(buf) {
  if (typeof buf === 'string') return buf
  let s = null
  try { s = UTF8.decode(buf) } catch { s = null }
  if (s !== null && Buffer.from(s, 'utf8').equals(buf)) return s
  return { b64: Buffer.from(buf).toString('base64') }
}

// The JSON form -> the bytes. A {b64} must be canonical base64; a string must be well-formed.
export function decodePath(p) {
  if (typeof p === 'string') {
    if (!p.isWellFormed()) throw new TypeError('changes: a path string is not well-formed Unicode')
    return Buffer.from(p, 'utf8')
  }
  if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 1 && typeof p.b64 === 'string') {
    const b = Buffer.from(p.b64, 'base64')
    if (b.toString('base64') !== p.b64) throw new TypeError('changes: a {b64} path is not canonical base64')
    return b
  }
  throw new TypeError(`changes: not a path: ${JSON.stringify(p)}`)
}

// A relative path inside the work tree: no NUL, no leading or doubled slash, no `.`, `..` or
// `.git` component (git refuses those too).
function relOk(buf) {
  if (!buf.length || buf.includes(0) || buf[0] === 0x2f || buf[buf.length - 1] === 0x2f) return false
  for (const part of key(buf).split('/')) {
    if (part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') return false
  }
  return true
}

// Caller paths -> unique Buffers, sorted.
function normPaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError('changes: paths must be an array')
  const seen = new Map()
  for (const p of paths) {
    const b = decodePath(p)
    if (!relOk(b)) throw new TypeError(`changes: not a work-tree path: ${JSON.stringify(p)}`)
    seen.set(key(b), b)
  }
  return [...seen.values()].sort(byBytes)
}

function splitNul(buf) {
  const out = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  if (start < buf.length) out.push(buf.subarray(start))
  return out
}

const encodeAll = list => [...list].sort(byBytes).map(encodePath)
const dirOf = buf => {
  const i = buf.lastIndexOf(0x2f)
  return i < 0 ? Buffer.alloc(0) : buf.subarray(0, i)
}
const baseName = buf => buf.subarray(buf.lastIndexOf(0x2f) + 1)

// ---------------------------------------------------------------- git

const git = (wt, args, opts = {}) => workGit(wt.W, args, opts)

function gitFailure(r, label) {
  const err = new Error(r.error || `git ${label} failed (exit ${r.status}): ${String(r.stderr).trim()}`)
  if (r.code) err.code = r.code
  err.stderr = r.stderr
  return err
}

function revParse(wt, spec) {
  const r = workGitRun(wt.W, ['rev-parse', '--verify', '-q', '--end-of-options', spec])
  if (r.code) throw gitFailure(r, 'rev-parse')
  return r.status === 0 ? r.stdout.trim() : null
}

function resolveCommit(wt, base) {
  if (typeof base !== 'string' || base === '') throw new TypeError('changes: base must be a commit')
  const oid = revParse(wt, `${base}^{commit}`)
  if (!oid) throw refused('base-unknown', `${base} is not a commit in ${wt.W}`)
  return oid
}

function resolveTrees(wt, list, state) {
  if (!Array.isArray(list)) throw new TypeError('changes: also must be an array')
  return list.map(x => {
    if (typeof x !== 'string' || x === '') throw new TypeError('changes: also holds commits or trees')
    const oid = revParse(wt, `${x}^{tree}`)
    if (!oid) throw refused(state, `${x} is not a commit or tree in ${wt.W}`)
    return oid
  })
}

function headOf(wt) {
  return revParse(wt, 'HEAD')
}

// -c overrides that empty every configured filter driver, so content conversion runs no program.
function filterOverrides(wt) {
  const r = workGitRun(wt.W, ['config', '-z', '--name-only', '--get-regexp', '^filter[.]'], { buffer: true })
  if (r.code) throw gitFailure(r, 'config')
  if (r.status === 1) return []
  if (r.status !== 0) throw gitFailure(r, 'config --get-regexp')
  const names = new Set()
  for (const rec of splitNul(r.stdout)) {
    const k = rec.toString('utf8')
    const last = k.lastIndexOf('.')
    if (last <= 'filter.'.length) continue // filter.<var>: no driver name
    names.add(k.slice('filter.'.length, last))
  }
  const out = []
  for (const n of [...names].sort()) {
    if (/[=\n\0]/.test(n) || !n.isWellFormed() || n.includes(String.fromCharCode(0xfffd))) {
      throw refused('unsafe-config', `filter driver ${JSON.stringify(n)} cannot be neutralized`)
    }
    out.push(`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`)
  }
  return out
}

// The options for a save's git calls: no filter program runs, attributes come from the base
// (refused git-too-old when git would ignore GIT_ATTR_SOURCE, R24).
function rawOpts(wt, baseOid) {
  assertAttrSource(wt.W)
  return { config: filterOverrides(wt), env: { GIT_ATTR_SOURCE: baseOid } }
}

function lsTree(wt, treeish) {
  const out = git(wt, ['ls-tree', '-r', '-z', '--full-tree', treeish], { buffer: true })
  return splitNul(out).map(rec => {
    const tab = rec.indexOf(9)
    const [mode, type, oid] = rec.subarray(0, tab).toString('latin1').split(' ')
    return { mode, type, oid, path: rec.subarray(tab + 1) }
  })
}

// C-quoted for hash-object --stdin-paths, which unquotes a line that starts with a double quote:
// any byte, newlines included, survives.
function cQuote(buf) {
  let s = '"'
  for (const b of buf) {
    if (b === 0x22) s += '\\"'
    else if (b === 0x5c) s += '\\\\'
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b)
    else s += '\\' + b.toString(8).padStart(3, '0')
  }
  return s + '"'
}

// Raw blobs (no filters, no eol conversion) for files under <W>, written to the object store
// (write: false only hashes them).
function hashFiles(wt, rels, { write = true } = {}) {
  if (!rels.length) return []
  const input = Buffer.from(rels.map(cQuote).join('\n') + '\n', 'latin1')
  const oids = git(wt, ['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--stdin-paths'], { input }).split('\n')
  if (oids.length !== rels.length || !oids.every(o => OID.test(o))) throw new Error('changes: hash-object returned an unexpected listing')
  return oids
}

const hashBytes = (wt, bytes) => git(wt, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes }).trim()

// ---------------------------------------------------------------- temporary indexes

function withTemp(wt, fn) {
  const dir = tempDir(wt.store)
  try {
    return fn(dir)
  } finally {
    removeTemp(dir)
  }
}

// One level only (a git crash can leave an index.lock next to an index), then rmdir.
function removeTemp(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) {
    const p = path.join(dir, name)
    try { if (!fs.lstatSync(p).isDirectory()) fs.unlinkSync(p) } catch { /* removed already */ }
  }
  try { fs.rmdirSync(dir) } catch { /* left for sweepTemps */ }
}

// ---------------------------------------------------------------- work tree facts

function direntKind(e, abs) {
  if (e.isDirectory()) return 'dir'
  if (e.isFile()) return 'file'
  if (e.isSymbolicLink()) return 'link'
  if (e.isFIFO() || e.isSocket() || e.isCharacterDevice() || e.isBlockDevice()) return 'special'
  try {
    const st = fs.lstatSync(abs)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : 'special'
  } catch {
    return 'missing'
  }
}

// lstat of a relative path as git sees it: a path below a symlink, a file or a missing directory
// is missing (git never follows a symlinked leading directory). Directory answers are cached.
function treeStat(W) {
  const root = Buffer.from(W + '/')
  const dirs = new Map()
  const realDir = prefix => {
    const k = key(prefix)
    if (dirs.has(k)) return dirs.get(k)
    let ok
    const up = prefix.lastIndexOf(0x2f)
    if (up >= 0 && !realDir(prefix.subarray(0, up))) ok = false
    else {
      try { ok = fs.lstatSync(Buffer.concat([root, prefix])).isDirectory() } catch { ok = false }
    }
    dirs.set(k, ok)
    return ok
  }
  const stat = rel => {
    const up = rel.lastIndexOf(0x2f)
    if (up >= 0 && !realDir(rel.subarray(0, up))) return { kind: 'missing' }
    let st
    try {
      st = fs.lstatSync(Buffer.concat([root, rel]))
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { kind: 'missing' }
      if (e.code === 'EACCES' || e.code === 'EPERM') return { kind: 'unreadable' }
      throw e
    }
    if (st.isFile()) return { kind: 'file', st }
    if (st.isSymbolicLink()) return { kind: 'link', st }
    if (st.isDirectory()) return { kind: 'dir', st }
    return { kind: 'special', st }
  }
  stat.root = root
  return stat
}

// Can the file be opened for reading? (A chmod-000 file lstats fine and still cannot be saved.)
function readable(root, rel) {
  let fd
  try {
    fd = fs.openSync(Buffer.concat([root, rel]), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return false
    if (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'ENOTDIR') return true // changed since: judged by its new state
    throw e
  }
  fs.closeSync(fd)
  return true
}

const hasDotGit = (root, rel) => {
  try { fs.lstatSync(Buffer.concat([root, rel, SLASH, DOT_GIT])); return true } catch { return false }
}

// Every regular file named .gitignore under W, skipping .git and nested repositories.
function findIgnoreFiles(W) {
  const root = Buffer.from(W + '/')
  const out = []
  const walk = rel => {
    const abs = rel ? Buffer.concat([root, rel]) : Buffer.from(W)
    let entries
    try { entries = fs.readdirSync(abs, { withFileTypes: true, encoding: 'buffer' }) } catch { return }
    if (rel && entries.some(e => e.name.equals(DOT_GIT))) return // git lists a nested repository whole
    for (const e of entries) {
      if (e.name.equals(DOT_GIT)) continue
      const r = rel ? Buffer.concat([rel, SLASH, e.name]) : Buffer.from(e.name)
      const kind = direntKind(e, Buffer.concat([root, r]))
      if (kind === 'dir') walk(r)
      else if (kind === 'file' && e.name.equals(GITIGNORE)) out.push(r)
    }
  }
  walk(null)
  return out.sort(byBytes)
}

// The files below an obstructing directory (R21), ignored or not. A nested repository or an
// unreadable directory inside it is marked and listed as it stands.
function walkObstructed(root, rel, out, mark) {
  let entries
  try {
    entries = fs.readdirSync(Buffer.concat([root, rel]), { withFileTypes: true, encoding: 'buffer' })
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return
    mark(rel, 'unreadable')
    out.push(rel)
    return
  }
  if (entries.some(e => e.name.equals(DOT_GIT))) {
    mark(rel, 'nested-repo')
    out.push(rel)
    return
  }
  for (const e of entries) {
    const r = Buffer.concat([rel, SLASH, e.name])
    if (direntKind(e, Buffer.concat([root, r])) === 'dir') walkObstructed(root, r, out, mark)
    else out.push(r)
  }
}

// ---------------------------------------------------------------- rules

const bytesRecord = b => ({ sha256: sha256Hex(b), b64: b.toString('base64') })

// The bytes of a regular file, or null when it is missing, unreadable or not a regular file (git
// warns and goes on without such a file; so does the record). O_NONBLOCK: a fifo never blocks.
function readOptional(file) {
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NONBLOCK)
  } catch (e) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENXIO'].includes(e.code)) return null
    throw e
  }
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null
  } finally {
    fs.closeSync(fd)
  }
}

// Copies <W>/.git/index to `dest` (nothing when it is missing: git reads a missing index as an
// empty one). Anything but a regular file there is refused, never followed or read from.
function copyIndex(wt, dest) {
  const src = path.join(wt.W, '.git', 'index')
  let fd
  try {
    fd = fs.openSync(src, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (e.code === 'ENOENT') return
    if (e.code === 'ELOOP') throw refused('tampered', `${src} is a symbolic link`)
    throw e
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw refused('tampered', `${src} is not a regular file`)
    fs.writeFileSync(dest, fs.readFileSync(fd), { mode: 0o600 })
  } finally {
    fs.closeSync(fd)
  }
}

// realpath of p, or of its nearest existing ancestor with the rest appended.
function realish(p) {
  let cur = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse())
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      const up = path.dirname(cur)
      if (up === cur) return path.resolve(p)
      rest.push(path.basename(cur))
      cur = up
    }
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

// The excludes file git would read for <W>: core.excludesFile, else $XDG_CONFIG_HOME/git/ignore,
// else $HOME/.config/git/ignore (git reads them from its own environment, which is this one).
function excludesPath(wt) {
  const r = workGitRun(wt.W, ['config', '--path', '--get', 'core.excludesFile'])
  if (r.code) throw gitFailure(r, 'config')
  if (r.status === 0) return r.stdout === '' ? null : path.resolve(wt.W, r.stdout)
  if (r.status !== 1) throw gitFailure(r, 'config --get core.excludesFile')
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'git', 'ignore')
  return process.env.HOME ? path.join(process.env.HOME, '.config', 'git', 'ignore') : null
}

function readExcludesFile(wt) {
  const file = excludesPath(wt)
  if (file === null) return null
  const real = realish(file)
  for (const dir of [wt.V, wt.R]) {
    if (inside(real, realish(dir))) {
      throw refused('excludes-file-in-work-area', `the excludes file ${file} lies under ${dir}`)
    }
  }
  const bytes = readOptional(file)
  return bytes === null ? null : { path: file, ...bytesRecord(bytes) }
}

function snapshotRules(wt, mode, base) {
  // An unreadable ignore file is one git skips (with a warning); the record skips it too.
  const root = Buffer.from(wt.W + '/')
  const files = findIgnoreFiles(wt.W).filter(f => readable(root, f))
  const oids = hashFiles(wt, files)
  return {
    v: 1, mode, base,
    ignores: files.map((f, i) => ({ path: encodePath(f), oid: oids[i] })),
    excludes_file: readExcludesFile(wt),
    info_exclude: bytesRecord(readOptional(path.join(wt.W, '.git', 'info', 'exclude')) || Buffer.alloc(0)),
  }
}

// Called once per firing, after dependency preparation and before any dispatch.
export function recordRules(wt, { base } = {}) {
  return snapshotRules(wt, 'recorded', resolveCommit(wt, base))
}

// The same read at the moment of use, for a record in which no dispatch ran.
export function currentRules(wt, { base = null } = {}) {
  return snapshotRules(wt, 'current', base === null ? null : resolveCommit(wt, base))
}

// The base commit's .gitignore blobs alone, for leftovers with no record (A11).
export function baseRules(wt, base) {
  const oid = resolveCommit(wt, base)
  const ignores = lsTree(wt, oid)
    .filter(e => (e.mode === '100644' || e.mode === '100755') && baseName(e.path).equals(GITIGNORE))
    .sort((a, b) => byBytes(a.path, b.path))
    .map(e => ({ path: encodePath(e.path), oid: e.oid }))
  return { v: 1, mode: 'base', base: oid, ignores, excludes_file: readExcludesFile(wt), info_exclude: bytesRecord(Buffer.alloc(0)) }
}

// sha256 of the canonical rules object (a bundle header's rules.sha).
export function rulesSha(rules) {
  return sha256Hex(canonicalJson(rules))
}

// Schema and integrity of a rules object read back from a record. -> {ignores:[{path, dir, oid}],
// info, excl} with the bytes decoded.
function checkRules(rules) {
  const bad = why => refused('tampered', `ignore rules: ${why}`)
  if (!rules || typeof rules !== 'object' || rules.v !== 1) throw bad('not a v1 rules object')
  if (!MODES.has(rules.mode)) throw bad(`mode ${JSON.stringify(rules.mode)}`)
  if (!Array.isArray(rules.ignores)) throw bad('ignores is not a list')
  const seen = new Set()
  const ignores = rules.ignores.map(i => {
    if (!i || typeof i !== 'object' || typeof i.oid !== 'string' || !OID.test(i.oid)) throw bad('an ignore entry has no oid')
    let p
    try { p = decodePath(i.path) } catch { throw bad('an ignore entry has no path') }
    if (!relOk(p) || !baseName(p).equals(GITIGNORE)) throw bad(`${JSON.stringify(i.path)} is not a .gitignore path`)
    if (seen.has(key(p))) throw bad(`${JSON.stringify(i.path)} is listed twice`)
    seen.add(key(p))
    return { path: p, dir: dirOf(p), oid: i.oid }
  })
  const bytesOf = (rec, what) => {
    if (!rec || typeof rec !== 'object' || typeof rec.b64 !== 'string' || typeof rec.sha256 !== 'string') throw bad(`${what} is malformed`)
    const b = Buffer.from(rec.b64, 'base64')
    if (b.toString('base64') !== rec.b64 || sha256Hex(b) !== rec.sha256) throw bad(`${what} does not match its sha256`)
    return b
  }
  const info = bytesOf(rules.info_exclude, 'info_exclude')
  if (rules.excludes_file !== null && (typeof rules.excludes_file !== 'object' || typeof rules.excludes_file.path !== 'string')) {
    throw bad('excludes_file is malformed')
  }
  const excl = rules.excludes_file === null ? Buffer.alloc(0) : bytesOf(rules.excludes_file, 'excludes_file')
  return { ignores, info, excl }
}

const newNonce = () => '.tlx-' + crypto.randomBytes(6).toString('hex')

// The recorded listing (raw entries; a nested repository ends in '/').
function replay(wt, dir, baseOid, parsed, nonce) {
  const idx = path.join(dir, 'tb')
  git(wt, ['read-tree', baseOid], { indexFile: idx })
  if (parsed.ignores.length) {
    const want = parsed.ignores.map(i => i.oid)
    const got = git(wt, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: want.join('\n') + '\n' }).split('\n')
    want.forEach((oid, n) => {
      if (got[n] !== `${oid} blob`) throw refused('tampered', `ignore rules: blob ${oid} is not in the clone`)
    })
  }
  // An ignore file whose directory stands where the base tracks a file or a submodule gets no
  // entry: adding one would push that base entry out of the index (an obstructing directory is
  // saved whole anyway, R21).
  let blocked = null
  const entries = []
  for (const i of parsed.ignores) {
    if (i.dir.length) {
      if (!blocked) blocked = new Set(lsTree(wt, baseOid).map(e => key(e.path)))
      const parts = key(i.dir).split('/')
      if (parts.some((_, n) => blocked.has(parts.slice(0, n + 1).join('/')))) continue
    }
    const np = i.dir.length ? Buffer.concat([i.dir, SLASH, Buffer.from(nonce)]) : Buffer.from(nonce)
    entries.push({ np, oid: i.oid })
  }
  const planted = () => {
    for (const e of entries) {
      try {
        fs.lstatSync(Buffer.concat([Buffer.from(wt.W + '/'), e.np]))
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue
        throw err
      }
      throw refused('tampered', `${show(e.np)} exists in the work tree`)
    }
  }
  planted()
  if (entries.length) {
    git(wt, ['update-index', '-z', '--index-info'], {
      indexFile: idx, input: Buffer.concat(entries.flatMap(e => [Buffer.from(`100644 ${e.oid}\t`), e.np, NUL])),
    })
    git(wt, ['update-index', '--skip-worktree', '-z', '--stdin'], { indexFile: idx, input: joinNul(entries.map(e => e.np)) })
  }
  const exFile = path.join(dir, 'excludes')
  const infoFile = path.join(dir, 'info-exclude')
  fs.writeFileSync(exFile, parsed.excl, { mode: 0o600 })
  fs.writeFileSync(infoFile, parsed.info, { mode: 0o600 })
  // excludesFile first, info/exclude second: later lists win, as in git's standard order.
  const out = git(wt, ['ls-files', '-z', '-o', `--exclude-from=${exFile}`, `--exclude-from=${infoFile}`,
    `--exclude-per-directory=${nonce}`], { indexFile: idx, buffer: true })
  planted()
  return splitNul(out)
}

const stripSlash = p => (p.length && p[p.length - 1] === 0x2f ? p.subarray(0, -1) : p)

// Untracked paths under `rules` (a nested repository as its directory), sorted.
export function listUntracked(wt, { base, rules, nonce = newNonce() } = {}) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError(`changes: bad nonce ${JSON.stringify(nonce)}`)
  const parsed = checkRules(rules)
  const baseOid = resolveCommit(wt, base)
  return encodeAll(withTemp(wt, dir => replay(wt, dir, baseOid, parsed, nonce)).map(stripSlash))
}

// ---------------------------------------------------------------- listings

// Tracked paths whose work-tree state differs from the base (independent of HEAD: loop04), from
// a fresh index of the base (no stat data, so every file is compared by content).
// A gitlink's commit change is seen; nothing inside a nested repository is looked at (R26).
function trackedChanges(wt, idx, baseOid, opts) {
  git(wt, ['read-tree', baseOid], { ...opts, indexFile: idx })
  git(wt, ['update-index', '-q', '--ignore-submodules', '--refresh'], { ...opts, indexFile: idx })
  const out = git(wt, ['diff-index', '-z', '--raw', '--no-renames', '--ignore-submodules=dirty', baseOid], { ...opts, indexFile: idx, buffer: true })
  return parseRaw(out)
}

// ---------------------------------------------------------------- raw comparison (R29)

const FALSY = new Set(['false', 'no', 'off', '0', ''])
const COMPARE_CHUNK = 1024 * 1024

// The value of a config key in <W> (every scope), lower-cased, or null when unset.
function configValue(wt, name, extra = []) {
  const r = workGitRun(wt.W, ['config', ...extra, '--get', name])
  if (r.code) throw gitFailure(r, 'config')
  if (r.status === 1) return null
  if (r.status !== 0) return undefined // a value git cannot read as asked
  return r.stdout.trim().toLowerCase()
}

// The base paths (keys) a conversion can touch, judged by the base's attributes.
function convertible(wt, entries, opts) {
  const attrs = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding']
  const out = git(wt, ['check-attr', '-z', '--stdin', ...attrs], { ...opts, input: joinNul(entries.map(e => e.path)), buffer: true })
  const toks = splitNul(out)
  const keys = new Set()
  for (let i = 0; i + 2 < toks.length; i += 3) {
    const attr = toks[i + 1].toString('latin1')
    const info = toks[i + 2].toString('latin1')
    if (info === 'unspecified') continue
    if ((attr === 'text' || attr === 'crlf' || attr === 'working-tree-encoding') && info === 'unset') continue
    if (attr === 'ident' && info !== 'set') continue
    keys.add(key(toks[i]))
  }
  return keys
}

// true when the two files hold the same bytes (read a chunk at a time).
function sameFile(a, b) {
  let fa, fb
  try {
    fa = fs.openSync(a, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    fb = fs.openSync(b, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    const sa = fs.fstatSync(fa)
    const sb = fs.fstatSync(fb)
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false
    const ba = Buffer.alloc(Math.min(COMPARE_CHUNK, Math.max(1, sa.size)))
    const bb = Buffer.alloc(ba.length)
    for (let pos = 0; pos < sa.size;) {
      const n = Math.min(ba.length, sa.size - pos)
      let ga = 0, gb = 0
      while (ga < n) { const r = fs.readSync(fa, ba, ga, n - ga, pos + ga); if (!r) return false; ga += r }
      while (gb < n) { const r = fs.readSync(fb, bb, gb, n - gb, pos + gb); if (!r) return false; gb += r }
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false
      pos += n
    }
    return true
  } catch (e) {
    if (['ENOENT', 'ELOOP', 'EACCES', 'EPERM', 'ENOTDIR'].includes(e.code)) return false
    throw e
  } finally {
    if (fa !== undefined) fs.closeSync(fa)
    if (fb !== undefined) fs.closeSync(fb)
  }
}

// Removes what checkout-index wrote under co: each file, then each emptied directory, deepest
// first, then co itself. Nothing else is removed (no recursive removal).
function removeCheckout(co, rels) {
  const dirs = new Map()
  for (const rel of rels) {
    try { fs.unlinkSync(Buffer.concat([Buffer.from(co + '/'), rel])) } catch { /* not written */ }
    for (let i = rel.indexOf(0x2f); i >= 0; i = rel.indexOf(0x2f, i + 1)) dirs.set(key(rel.subarray(0, i)), rel.subarray(0, i))
  }
  for (const d of [...dirs.values()].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(Buffer.concat([Buffer.from(co + '/'), d])) } catch { /* not empty, or gone */ }
  }
  try { fs.rmdirSync(co) } catch { /* left for sweepTemps */ }
}

// Tracked regular files of the base that git's diff (seen: its keys) does not list and whose raw
// bytes or exec bit differ from what a checkout of the base writes (R29); raw bytes equal to the
// base blob are never listed (R29a, see the header). idx holds the base.
function rawChanges(wt, dir, idx, baseOid, opts, seen) {
  const entries = lsTree(wt, baseOid).filter(e => (e.mode === '100644' || e.mode === '100755') && !seen.has(key(e.path)))
  if (!entries.length) return []
  const autocrlf = configValue(wt, 'core.autocrlf')
  const filemode = configValue(wt, 'core.filemode', ['--type=bool'])
  const modeCheck = filemode === 'false' || filemode === undefined
  const all = autocrlf === undefined || (autocrlf !== null && !FALSY.has(autocrlf))
  const conv = all ? null : convertible(wt, entries, opts)
  const stat = treeStat(wt.W)
  const out = new Map()
  const candidates = []
  for (const e of entries) {
    const isConv = all || conv.has(key(e.path))
    if (!isConv && !modeCheck) continue
    const s = stat(e.path)
    if (s.kind !== 'file') continue // a kind change is git's diff
    if (((s.st.mode & 0o100) ? '100755' : '100644') !== e.mode) { out.set(key(e.path), e); continue }
    if (!isConv) continue
    if (!readable(stat.root, e.path)) { out.set(key(e.path), e); continue } // judged unreadable by classify
    candidates.push(e)
  }
  if (candidates.length) {
    const oids = hashFiles(wt, candidates.map(e => e.path), { write: false })
    const differ = candidates.filter((e, n) => oids[n] !== e.oid)
    if (differ.length) {
      const co = path.join(dir, 'checkout')
      fs.mkdirSync(co, { mode: 0o700 })
      try {
        git(wt, ['checkout-index', '-z', '--stdin', `--prefix=${co}/`], { ...opts, indexFile: idx, input: joinNul(differ.map(e => e.path)) })
        for (const e of differ) {
          if (!sameFile(Buffer.concat([stat.root, e.path]), Buffer.concat([Buffer.from(co + '/'), e.path]))) out.set(key(e.path), e)
        }
      } finally {
        removeCheckout(co, differ.map(e => e.path))
      }
    }
  }
  return [...out.values()].map(e => ({ oldMode: e.mode, newMode: e.mode, oldOid: e.oid, newOid: e.oid, status: 'M', path: e.path }))
}

// diff -z --raw: ":<old> <new> <oldoid> <newoid> <S>" NUL "<path>" NUL ...
function parseRaw(out) {
  const recs = []
  const toks = splitNul(out)
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid, status] = toks[i].toString('latin1').slice(1).split(' ')
    recs.push({ oldMode, newMode, oldOid, newOid, status: status[0], path: toks[i + 1] })
  }
  return recs
}

// Index-only content (R20): a staged entry that differs from the base, from every oid in `also`
// and from the work tree. The real index is copied (never written); the work-tree comparison runs
// on a fresh index holding only the candidates, so forged stat data cannot hide a difference.
function indexOnlyIn(wt, dir, baseOid, alsoTrees, opts) {
  const copy = path.join(dir, 'real-index')
  copyIndex(wt, copy)
  const sets = [baseOid, ...alsoTrees].map(oid => new Set(splitNul(git(wt,
    ['diff-index', '--cached', '-z', '--name-only', '--no-renames', '--ignore-submodules=dirty', oid],
    { ...opts, indexFile: copy, buffer: true })).map(key)))
  const dirty = sets[0].size > 0
  const cand = new Set([...sets[0]].filter(k => sets.every(s => s.has(k))))
  if (!cand.size) return { paths: [], dirty }
  const result = new Map()
  const stage0 = []
  for (const rec of splitNul(git(wt, ['ls-files', '-s', '-z'], { indexFile: copy, buffer: true }))) {
    const tab = rec.indexOf(9)
    const [mode, oid, stage] = rec.subarray(0, tab).toString('latin1').split(' ')
    const p = rec.subarray(tab + 1)
    if (!cand.has(key(p))) continue
    if (stage !== '0') result.set(key(p), p) // a conflict stage exists nowhere else
    else stage0.push({ mode, oid, p })
  }
  if (stage0.length) {
    const ti = path.join(dir, 'candidates')
    git(wt, ['update-index', '-z', '--index-info'], {
      indexFile: ti, input: Buffer.concat(stage0.flatMap(e => [Buffer.from(`${e.mode} ${e.oid}\t`), e.p, NUL])),
    })
    git(wt, ['update-index', '-q', '--ignore-submodules', '--refresh'], { ...opts, indexFile: ti })
    const out = git(wt, ['diff-files', '-z', '--name-only', '--ignore-submodules=dirty'], { ...opts, indexFile: ti, buffer: true })
    for (const p of splitNul(out)) result.set(key(p), p)
  }
  return { paths: [...result.values()].sort(byBytes), dirty }
}

// Sorts the listings into the change set and marks what cannot be saved (step 4). Unsavable paths
// stay in tracked / untracked; `unsavable` is an overlay.
function classify(W, trackedRecs, listed, { obstruct }) {
  const stat = treeStat(W)
  const root = stat.root
  const unsavable = new Map()
  const mark = (p, reason) => { if (!unsavable.has(key(p))) unsavable.set(key(p), { path: p, reason }) }
  const judge = (p, s) => {
    if (s.kind === 'file') { if (!readable(root, p)) mark(p, 'unreadable') }
    else if (s.kind === 'special') mark(p, 'special-file')
    else if (s.kind === 'unreadable') mark(p, 'unreadable')
  }
  const obstructed = []
  // The mirror of R21: the first leading component of a tracked path that is not a real
  // directory, when it is a file, a symlink or something else (Cg1#2). A reset's read-tree
  // would delete it to put the base's directory back, so it is saved whatever the rules say.
  const blockers = new Map()
  const blockerOf = rel => {
    for (let i = rel.indexOf(0x2f); i >= 0; i = rel.indexOf(0x2f, i + 1)) {
      const anc = rel.subarray(0, i)
      const k = key(anc)
      if (blockers.has(k)) {
        const b = blockers.get(k)
        if (b !== 'dir') return b
        continue
      }
      let st
      try {
        st = fs.lstatSync(Buffer.concat([root, anc]))
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { blockers.set(k, null); return null }
        if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e
        st = null
      }
      const b = st && st.isDirectory() ? 'dir'
        : { path: anc, reason: st === null ? 'unreadable' : st.isFile() || st.isSymbolicLink() ? null : 'special-file' }
      blockers.set(k, b)
      if (b !== 'dir') return b
    }
    return null
  }
  const seenBlocker = new Set()
  for (const rec of trackedRecs) {
    const s = stat(rec.path)
    if (s.kind === 'dir') {
      if (rec.oldMode === '160000') mark(rec.path, 'gitlink')
      else if (obstruct && FILE_MODES.has(rec.oldMode)) walkObstructed(root, rec.path, obstructed, mark)
    } else {
      judge(rec.path, s)
      if (obstruct && s.kind === 'missing') {
        const b = blockerOf(rec.path)
        if (b && !seenBlocker.has(key(b.path))) {
          seenBlocker.add(key(b.path))
          if (b.reason) mark(b.path, b.reason)
          obstructed.push(b.path)
        }
      }
    }
  }
  const untracked = new Map()
  for (const p of obstructed) untracked.set(key(p), p)
  for (const entry of listed) {
    const p = stripSlash(entry)
    untracked.set(key(p), p)
    if (p !== entry) mark(p, 'nested-repo')
  }
  for (const [k, p] of untracked) {
    if (unsavable.has(k)) continue
    const s = stat(p)
    if (s.kind === 'missing') untracked.delete(k) // gone since the listing
    else if (s.kind === 'dir') {
      if (hasDotGit(root, p)) mark(p, 'nested-repo')
      else untracked.delete(k) // an empty directory: nothing to save
    } else judge(p, s)
  }
  return {
    tracked: trackedRecs.map(r => r.path).sort(byBytes),
    untracked: [...untracked.values()].sort(byBytes),
    obstructed: obstructed.sort(byBytes),
    unsavable: [...unsavable.values()].sort((a, b) => byBytes(a.path, b.path)),
  }
}

const encodeUnsavable = list => list.map(u => ({ path: encodePath(u.path), reason: u.reason }))

// The change set of <W> against `base` under `rules` (saves, the reset precondition).
//   tracked     work tree vs base (deletions, type changes, an obstructing directory's path),
//               plus the raw-only differences of R29
//   untracked   not ignored under `rules`, plus every file below an obstructing directory and
//               every file or symlink standing where the base tracks a directory
//   hidden      what `rules` list and git's standard listing does not (R2)
//   obstructed  the files below directories standing where the base tracks a file (R21), and
//               the file, symlink or special file standing where the base tracks a directory
//   unsavable   [{path, reason: nested-repo|special-file|unreadable|gitlink}], an overlay
//   indexOnly   staged content found nowhere else (R20); `also` names commits it may match
//   indexDirty  the real index differs from the base
export function collect(wt, { base, rules, also = [] } = {}) {
  const parsed = checkRules(rules)
  const baseOid = resolveCommit(wt, base)
  const alsoTrees = resolveTrees(wt, also, 'base-unknown')
  const opts = rawOpts(wt, baseOid)
  const r = withTemp(wt, dir => {
    const ta = path.join(dir, 'ta')
    const diffRecs = trackedChanges(wt, ta, baseOid, opts)
    const trackedRecs = [...diffRecs, ...rawChanges(wt, dir, ta, baseOid, opts, new Set(diffRecs.map(r => key(r.path))))]
    const recorded = replay(wt, dir, baseOid, parsed, newNonce())
    const standard = new Set(splitNul(git(wt, ['ls-files', '-z', '-o', '--exclude-standard'], { indexFile: ta, buffer: true })).map(key))
    const hidden = recorded.filter(p => !standard.has(key(p))).map(stripSlash)
    const sets = classify(wt.W, trackedRecs, recorded, { obstruct: true })
    const io = indexOnlyIn(wt, dir, baseOid, alsoTrees, opts)
    return { ...sets, hidden, io }
  })
  const head = headOf(wt)
  return {
    base: baseOid, head, headMoved: head !== baseOid,
    tracked: encodeAll(r.tracked), untracked: encodeAll(r.untracked), hidden: encodeAll(r.hidden),
    obstructed: encodeAll(r.obstructed), unsavable: encodeUnsavable(r.unsavable),
    indexOnly: encodeAll(r.io.paths), indexDirty: r.io.dirty,
  }
}

// indexOnly alone (R20), e.g. before a helper resets the index. raw: false compares with git's
// normal conversion, as touched does.
export function indexOnly(wt, { base, also = [], raw = true } = {}) {
  const baseOid = resolveCommit(wt, base)
  const alsoTrees = resolveTrees(wt, also, 'base-unknown')
  const opts = raw ? rawOpts(wt, baseOid) : {}
  return encodeAll(withTemp(wt, dir => indexOnlyIn(wt, dir, baseOid, alsoTrees, opts)).paths)
}

// ---------------------------------------------------------------- trees

function baseModes(wt, baseOid) {
  let map = null
  return p => {
    if (!map) map = new Map(lsTree(wt, baseOid).map(e => [key(e.path), e.mode]))
    return map.get(key(p))
  }
}

// The saved tree (R19): the base with each path set to its raw work-tree state. A regular file is
// stored byte for byte (100755 when the owner exec bit is set), a symlink as its target text, a
// missing path (or one below a symlink) and a directory standing where the base tracks a file are
// removed. Anything else throws UNSAVABLE.
export function captureTree(wt, { base, paths } = {}) {
  const baseOid = resolveCommit(wt, base)
  const list = normPaths(paths)
  return withTemp(wt, dir => {
    const idx = path.join(dir, 'capture')
    git(wt, ['read-tree', baseOid], { indexFile: idx })
    const stat = treeStat(wt.W)
    const modeAt = baseModes(wt, baseOid)
    const removes = []
    const files = []
    const adds = []
    for (const p of list) {
      const s = stat(p)
      if (s.kind === 'missing') removes.push(p)
      else if (s.kind === 'file') {
        if (!readable(stat.root, p)) throw unsavableError(p, 'unreadable')
        files.push({ p, mode: s.st.mode & 0o100 ? '100755' : '100644' })
      } else if (s.kind === 'link') {
        adds.push({ p, mode: '120000', oid: hashBytes(wt, fs.readlinkSync(Buffer.concat([stat.root, p]), { encoding: 'buffer' })) })
      } else if (s.kind === 'dir') {
        const m = modeAt(p)
        if (m === '160000') throw unsavableError(p, 'gitlink')
        if (hasDotGit(stat.root, p)) throw unsavableError(p, 'nested-repo')
        if (m === undefined) throw unsavableError(p, 'directory')
        removes.push(p) // the files below it are captured as their own paths
      } else throw unsavableError(p, s.kind === 'special' ? 'special-file' : 'unreadable')
    }
    const oids = hashFiles(wt, files.map(f => f.p))
    files.forEach((f, n) => adds.push({ p: f.p, mode: f.mode, oid: oids[n] }))
    if (removes.length) git(wt, ['update-index', '--force-remove', '-z', '--stdin'], { indexFile: idx, input: joinNul(removes) })
    if (adds.length) {
      git(wt, ['update-index', '-z', '--index-info'], {
        indexFile: idx, input: Buffer.concat(adds.flatMap(a => [Buffer.from(`${a.mode} ${a.oid}\t`), a.p, NUL])),
      })
    }
    return { tree: git(wt, ['write-tree'], { indexFile: idx }).trim() }
  })
}

// The commit tree: the base with each path checked in as `git add` would (filters, eol
// conversion, the exec bit per core.fileMode). A missing path and a directory standing where the
// base tracks a file are removed.
export function stageTree(wt, { base, paths } = {}) {
  const baseOid = resolveCommit(wt, base)
  const list = normPaths(paths)
  return withTemp(wt, dir => {
    const idx = path.join(dir, 'stage')
    git(wt, ['read-tree', baseOid], { indexFile: idx })
    const stat = treeStat(wt.W)
    const modeAt = baseModes(wt, baseOid)
    const removes = []
    const updates = []
    for (const p of list) {
      const s = stat(p)
      if (s.kind === 'missing' || (s.kind === 'dir' && modeAt(p) !== '160000')) removes.push(p)
      else updates.push(p)
    }
    if (removes.length) git(wt, ['update-index', '--force-remove', '-z', '--stdin'], { indexFile: idx, input: joinNul(removes) })
    if (updates.length) git(wt, ['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], { indexFile: idx, input: joinNul(updates) })
    return { tree: git(wt, ['write-tree'], { indexFile: idx }).trim() }
  })
}

// [{path, kind, old_mode, mode, oid, size, binary}] for base -> tree. kind: added, deleted,
// modified, mode-changed (only the mode differs), type-changed. `binary` is git's content test
// (no attribute applies); a deleted entry has mode, oid and size null.
export function manifest(wt, base, tree) {
  const baseOid = resolveCommit(wt, base)
  if (typeof tree !== 'string' || tree === '') throw new TypeError('changes: tree must be a tree oid')
  const treeOid = revParse(wt, `${tree}^{tree}`)
  if (!treeOid) throw refused('tree-unknown', `${tree} is not a tree in ${wt.W}`)
  assertAttrSource(wt.W)
  const emptyTree = git(wt, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim()
  const opts = { config: ['core.attributesFile=/dev/null'], env: { GIT_ATTR_SOURCE: emptyTree, GIT_ATTR_NOSYSTEM: '1' }, buffer: true }
  const diff = ['-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseOid, treeOid]
  const recs = parseRaw(git(wt, ['diff-tree', '--raw', ...diff], opts))
  const binary = new Set()
  for (const rec of splitNul(git(wt, ['diff-tree', '--numstat', ...diff], opts))) {
    const t1 = rec.indexOf(9)
    const t2 = rec.indexOf(9, t1 + 1)
    if (rec.subarray(0, t1).toString('latin1') === '-') binary.add(key(rec.subarray(t2 + 1)))
  }
  const live = [...new Set(recs.filter(r => r.status !== 'D').map(r => r.newOid))]
  const sizes = new Map()
  if (live.length) {
    const out = git(wt, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: live.join('\n') + '\n' }).split('\n')
    for (const line of out) {
      const [oid, size] = line.split(' ')
      if (/^[0-9]+$/.test(size)) sizes.set(oid, Number(size))
    }
  }
  return recs.map(r => {
    const kind = r.status === 'A' ? 'added' : r.status === 'D' ? 'deleted' : r.status === 'T' ? 'type-changed'
      : r.oldOid === r.newOid && r.oldMode !== r.newMode ? 'mode-changed' : 'modified'
    const gone = kind === 'deleted'
    return {
      path: encodePath(r.path), kind,
      old_mode: kind === 'added' ? null : r.oldMode,
      mode: gone ? null : r.newMode,
      oid: gone ? null : r.newOid,
      size: gone ? null : (sizes.get(r.newOid) ?? null),
      binary: binary.has(key(r.path)),
    }
  })
}

// The touched set (R2; check, commit, deps-dirty): tracked plus git's standard untracked listing,
// all under git's normal conversion. `hidden` (from `rules` when given) is what the recorded rules
// list and the standard listing does not. tree = stageTree of the savable paths; digest =
// sha256Hex(canonicalJson({base, tree, paths})).
export function touched(wt, { base, rules = null, also = [] } = {}) {
  const parsed = rules === null ? null : checkRules(rules)
  const baseOid = resolveCommit(wt, base)
  const alsoTrees = resolveTrees(wt, also, 'base-unknown')
  const r = withTemp(wt, dir => {
    const ta = path.join(dir, 'ta')
    const trackedRecs = trackedChanges(wt, ta, baseOid, {})
    const standardRaw = splitNul(git(wt, ['ls-files', '-z', '-o', '--exclude-standard'], { indexFile: ta, buffer: true }))
    let hidden = []
    if (parsed) {
      const standard = new Set(standardRaw.map(key))
      hidden = replay(wt, dir, baseOid, parsed, newNonce()).filter(p => !standard.has(key(p))).map(stripSlash)
    }
    const sets = classify(wt.W, trackedRecs, standardRaw, { obstruct: false })
    const io = indexOnlyIn(wt, dir, baseOid, alsoTrees, {})
    return { ...sets, hidden, io }
  })
  const all = new Map()
  for (const p of [...r.tracked, ...r.untracked]) all.set(key(p), p)
  const paths = [...all.values()].sort(byBytes)
  const unsavableKeys = new Set(r.unsavable.map(u => key(u.path)))
  const { tree } = stageTree(wt, { base: baseOid, paths: paths.filter(p => !unsavableKeys.has(key(p))).map(encodePath) })
  const encoded = paths.map(encodePath)
  const head = headOf(wt)
  return {
    base: baseOid, head, headMoved: head !== baseOid,
    paths: encoded, hidden: encodeAll(r.hidden), unsavable: encodeUnsavable(r.unsavable),
    indexOnly: encodeAll(r.io.paths), indexDirty: r.io.dirty,
    tree, digest: sha256Hex(canonicalJson({ base: baseOid, tree, paths: encoded })),
  }
}

// ---------------------------------------------------------------- the work tree

// The clone layout (0c-4 adds `legacy`): <W> = loopPaths(P).W with a real <W>/.git directory;
// store = <V>/patches (created; atomic.storageDir, so a symlink there throws CLONE_INVALID
// before any temp is allocated in it). Anything else is refused `layout`.
export function openWorkTree(P, { env = process.env } = {}) {
  const paths = loopPaths(P, { env })
  const gitDir = path.join(paths.W, '.git')
  let st
  try {
    st = fs.lstatSync(gitDir)
  } catch (e) {
    throw refused('layout', `${paths.W} is not a loop clone (${e.code || e.message})`)
  }
  if (!st.isDirectory()) throw refused('layout', `${gitDir} is not a directory`)
  const store = storageDir(paths.V, path.join(paths.V, 'patches'), { create: true })
  return { P, R: paths.R, S: paths.S, V: paths.V, W: paths.W, store, env }
}
