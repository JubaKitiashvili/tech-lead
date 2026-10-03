// scripts/lib/delivery.mjs
// Delivery bundles (brief 13.7, 17, R11; spec loop04): the owner's way to receive the loop's
// commits. Each dated branch `<prefix>/<YYYY-MM-DD>` of the clone <W> with work the base lacks
// is written to <V>/out/<prefix>/<date>.bundle, holding exactly one head refs/heads/<branch>
// and cut at refs/tech-lead/base (so every prerequisite is a commit the owner's base holds),
// with a sidecar <date>.bundle.json {tip, sha256} naming the tip and the file's SHA-256.
// Part of the clone concern: loop-clone.mjs (prepare, commit, bundle, close) and
// loop-recover.mjs import it. The callers hold the firing lock and have checked <W>
// (checkClone); nothing here takes the lock, but every publication re-checks it through the
// caller's guard() (R31): guard is called right before each .prev link, right before the rename
// that publishes the bundle and right before its sidecar is written, with no git call or other
// blocking work between a check and its write (every git-derived value is computed first), and
// whatever it throws (NOT_HOLDER, HOLDER_UNKNOWN) propagates as it is. A lock lost between the
// rename and the sidecar leaves the new bundle published beside the old sidecar (bundleCurrent
// reads it other-tip, so the next sync writes it again). Every git call goes through workGit.
//
//   BASE_REF                         'refs/tech-lead/base'
//   bundlePath(paths, branch)        absolute <V>/out/<prefix>/<date>.bundle; throws
//                                    `bad-branch: ...` unless branch is a dated loop branch
//                                    whose prefix passes loop-start's validPrefix
//   sidecarPath(paths, branch)       bundlePath + '.json'
//   readSidecar(paths, branch)       {tip, sha256} | null (missing, not JSON, or the wrong shape)
//   bundleHeader(file)               {version, capabilities, prerequisites: [oid],
//                                    heads: [{oid, ref}], size (header bytes)}; throws
//                                    `bad-bundle: ...` (code BAD_BUNDLE)
//   bundleCurrent(paths, branch, tip = the branch's tip in <W>) -> {current, reason}
//                                    reason null when current, else 'missing', 'not-a-file',
//                                    'no-sidecar', 'other-tip', 'sha256-mismatch', 'unreadable',
//                                    'head-mismatch' or 'prerequisite-unreachable' (from
//                                    refs/tech-lead/base), checked in that order
//   writeBundle(paths, branch, {why, tip, guard}) -> {file, tip, sha256, bytes, why} | {empty: true}
//                                    temp <dir>/.tmp-<pid>-<16 hex>.bundle (mode 0600),
//                                    `bundle create` of refs/heads/<branch> ^refs/tech-lead/base,
//                                    `bundle verify -q`, sha256; an existing file whose tip is
//                                    not an ancestor of the new tip (or cannot be read) is kept
//                                    as <date>.bundle.prev-<YYYYMMDDTHHMMSSZ>[-<n>] (a hard
//                                    link, never overwritten); fault 'bundle:before-rename';
//                                    rename; then the sidecar (writeReplace). `tip`, when
//                                    given, is the tip the caller vetted: a branch that moved
//                                    throws `tip-moved`. An empty range writes nothing.
//                                    guard() (the caller's assertHeld) runs right before each
//                                    .prev link, right before the rename and right before the
//                                    sidecar; the ancestry check runs before all of them.
//                                    guard is required: without a function, TypeError.
//   syncBundles(paths, {vetted, retired, base = BASE_REF, why = 'regenerated', guard})
//                                    -> [{branch, result}] for every dated refs/heads/* in <W>,
//                                    in ref order; see the function. guard is required
//                                    (TypeError without a function) and passed to writeBundle.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { workGit, workGitRun } from './git-safe.mjs'
import { readJson, tempFile, writeReplace } from './atomic.mjs'
import { DATED_BRANCH_RE } from './clone-check.mjs'
import { fault } from './fault.mjs'
import { containedIn, retiredRefs, validPrefix } from '../loop-start.mjs'

export const BASE_REF = 'refs/tech-lead/base'

const { O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = fs.constants
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const SHA256_RE = /^[0-9a-f]{64}$/
const WHY_RE = /^[a-z][a-z0-9-]*$/
// A commit name git cannot read as an option or a pseudo-ref (as loop-start's REF_NAME).
const PLAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const PSEUDO_RE = /^(?:[A-Z_]*HEAD|@)$/
const SIGNATURES = new Map([['# v2 git bundle', 2], ['# v3 git bundle', 3]])
const MAX_HEADER = 16 * 1024 * 1024
const CHUNK = 1024 * 1024

const fail = (code, message) => Object.assign(new Error(message), { code })
// The errors of a lost (or unknowable) firing lock: they propagate, never a branch error.
const LOCK_LOST = new Set(['NOT_HOLDER', 'HOLDER_UNKNOWN'])

// The guard() a caller passes (R31: its assertHeld, bound). It is required: a call without a
// guard function (left out, undefined, null or any other value) throws TypeError before any I/O.
function guardOf(guard, who) {
  if (typeof guard !== 'function') throw new TypeError(`${who}: guard must be a function () => void that throws when the firing lock is lost`)
  return guard
}

// {prefix, date} of a dated loop branch, or throws bad-branch.
function splitBranch(branch) {
  if (typeof branch !== 'string' || !DATED_BRANCH_RE.test(`refs/heads/${branch}`)) {
    throw fail('BAD_BRANCH', `bad-branch: ${JSON.stringify(String(branch))} is not a dated loop branch <prefix>/<YYYY-MM-DD>`)
  }
  const at = branch.lastIndexOf('/')
  const prefix = branch.slice(0, at)
  if (!validPrefix(prefix)) throw fail('BAD_BRANCH', `bad-branch: ${JSON.stringify(branch)} has a prefix git refuses`)
  return { prefix, date: branch.slice(at + 1) }
}

export function bundlePath(paths, branch) {
  const { prefix, date } = splitBranch(branch)
  if (!paths || typeof paths.V !== 'string' || !path.isAbsolute(paths.V)) throw new TypeError('delivery: paths.V must be an absolute path')
  return path.join(paths.V, 'out', ...prefix.split('/'), `${date}.bundle`)
}

export function sidecarPath(paths, branch) {
  return `${bundlePath(paths, branch)}.json`
}

export function readSidecar(paths, branch) {
  let side
  try {
    side = readJson(sidecarPath(paths, branch))
  } catch (e) {
    if (/^corrupt: /.test(e.message) || e.code === 'EISDIR') return null
    throw e
  }
  if (!side || typeof side.tip !== 'string' || !OID_RE.test(side.tip) || typeof side.sha256 !== 'string' || !SHA256_RE.test(side.sha256)) {
    return null
  }
  return { tip: side.tip, sha256: side.sha256 }
}

// readSync until n bytes are in buf at offset or the file ends; returns how many were read.
function readFull(fd, buf, offset, n, position) {
  let got = 0
  while (got < n) {
    const r = fs.readSync(fd, buf, offset + got, n - got, position + got)
    if (r === 0) break
    got += r
  }
  return got
}

export function bundleHeader(file) {
  const bad = why => fail('BAD_BUNDLE', `bad-bundle: ${file}: ${why}`)
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW)
  let buf = Buffer.alloc(0)
  let end = -1
  try {
    for (let pos = 0; end < 0;) {
      if (pos >= MAX_HEADER) throw bad(`no header within ${MAX_HEADER} bytes`)
      const chunk = Buffer.alloc(64 * 1024)
      const n = readFull(fd, chunk, 0, chunk.length, pos)
      if (n === 0) throw bad('the file ends inside the header')
      // Search from one byte back, so a "\n\n" split across two reads is found.
      const from = Math.max(0, buf.length - 1)
      buf = Buffer.concat([buf, chunk.subarray(0, n)])
      end = buf.indexOf('\n\n', from)
      pos += n
    }
  } finally {
    fs.closeSync(fd)
  }
  const lines = buf.subarray(0, end).toString('latin1').split('\n')
  const version = SIGNATURES.get(lines[0])
  if (!version) throw bad('not a v2 or v3 git bundle')
  const capabilities = [], prerequisites = [], heads = []
  let i = 1
  if (version === 3) for (; i < lines.length && lines[i].startsWith('@'); i++) capabilities.push(lines[i].slice(1))
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('-')) {
      const oid = line.slice(1).split(' ')[0]
      if (!OID_RE.test(oid)) throw bad(`bad prerequisite line ${JSON.stringify(line)}`)
      prerequisites.push(oid)
      continue
    }
    const sp = line.indexOf(' ')
    const oid = line.slice(0, sp)
    const ref = line.slice(sp + 1)
    if (sp < 0 || !OID_RE.test(oid) || ref === '') throw bad(`bad ref line ${JSON.stringify(line)}`)
    heads.push({ oid, ref })
  }
  if (!heads.length) throw bad('no ref')
  return { version, capabilities, prerequisites, heads, size: end + 2 }
}

// {sha256, bytes} of a regular file, read a chunk at a time (a bundle can be large).
function fileDigest(file) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW)
  try {
    const hash = crypto.createHash('sha256')
    const buf = Buffer.alloc(CHUNK)
    let bytes = 0
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, bytes)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      bytes += n
    }
    return { sha256: hash.digest('hex'), bytes }
  } finally {
    fs.closeSync(fd)
  }
}

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

const lstatOrNull = p => {
  try {
    return fs.lstatSync(p)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// a is an ancestor of (or equal to) b in <W>. A missing object or ref reads as false; a git run
// that did not finish throws.
function isAncestor(W, a, b) {
  const r = workGitRun(W, ['merge-base', '--is-ancestor', a, b])
  if (r.code) throw fail(r.code, r.error)
  return r.status === 0
}

// The branch's tip in <W>; throws no-branch when refs/heads/<branch> names no commit.
function branchTip(W, branch) {
  const r = workGitRun(W, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  if (r.code) throw fail(r.code, r.error)
  if (r.status !== 0 || !OID_RE.test(r.stdout)) throw fail('NO_BRANCH', `no-branch: refs/heads/${branch} is not a commit in ${W}`)
  return r.stdout
}

const checkOid = (tip, who) => {
  if (typeof tip !== 'string' || !OID_RE.test(tip)) throw new TypeError(`${who}: tip must be a full object id, got ${JSON.stringify(tip)}`)
}

export function bundleCurrent(paths, branch, tip) {
  const file = bundlePath(paths, branch)
  if (tip !== undefined) checkOid(tip, 'bundleCurrent')
  const st = lstatOrNull(file)
  if (!st) return { current: false, reason: 'missing' }
  if (!st.isFile()) return { current: false, reason: 'not-a-file' }
  const side = readSidecar(paths, branch)
  if (!side) return { current: false, reason: 'no-sidecar' }
  const want = tip === undefined ? branchTip(paths.W, branch) : tip
  if (side.tip !== want) return { current: false, reason: 'other-tip' }
  if (fileDigest(file).sha256 !== side.sha256) return { current: false, reason: 'sha256-mismatch' }
  let header
  try {
    header = bundleHeader(file)
  } catch (e) {
    if (e.code === 'BAD_BUNDLE') return { current: false, reason: 'unreadable' }
    throw e
  }
  if (header.heads.length !== 1 || header.heads[0].ref !== `refs/heads/${branch}` || header.heads[0].oid !== want) {
    return { current: false, reason: 'head-mismatch' }
  }
  for (const oid of header.prerequisites) {
    if (!isAncestor(paths.W, oid, BASE_REF)) return { current: false, reason: 'prerequisite-unreachable' }
  }
  return { current: true, reason: null }
}

// The UTC time as YYYYMMDDTHHMMSSZ.
const utcStamp = () => `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`

// Whether the existing bundle must be kept before it is replaced: it is a regular file and the
// new tip does not descend from its tip (or its tip cannot be read). Reads only; the git call
// (the ancestry check) runs here, before the caller's guard, never between guard and link.
function needsPrevious(W, file, branch, tip) {
  const st = lstatOrNull(file)
  // Nothing there, or something that is no bundle of ours (the rename replaces a symlink itself).
  if (!st || !st.isFile()) return false
  let old = null
  try {
    const head = bundleHeader(file).heads.find(h => h.ref === `refs/heads/${branch}`)
    old = head ? head.oid : null
  } catch (e) {
    if (e.code !== 'BAD_BUNDLE') throw e
  }
  return !(old !== null && (old === tip || isAncestor(W, old, tip)))
}

// Keeps the existing bundle as a hard link <file>.prev-<stamp>[-<n>], created exclusively, so
// neither an earlier .prev nor the file itself is ever replaced. held() (R31) runs right before
// each link attempt, with nothing between it and the link. Returns the .prev path.
function keepPrevious(file, held) {
  const stamp = utcStamp()
  for (let n = 1; ; n++) {
    const prev = `${file}.prev-${stamp}${n === 1 ? '' : `-${n}`}`
    held()
    try {
      fs.linkSync(file, prev)
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    fsyncDir(path.dirname(file))
    return prev
  }
}

export function writeBundle(paths, branch, { why, tip: expect, guard } = {}) {
  const file = bundlePath(paths, branch)
  if (typeof why !== 'string' || !WHY_RE.test(why)) throw fail('BAD_WHY', `bad-why: ${JSON.stringify(why)} (a lower-case word such as commit or regenerated)`)
  if (expect !== undefined) checkOid(expect, 'writeBundle')
  const held = guardOf(guard, 'writeBundle')
  const W = paths.W
  const ref = `refs/heads/${branch}`
  const tip = branchTip(W, branch)
  const moved = got => fail('TIP_MOVED', `tip-moved: ${ref} is at ${got}, not ${expect ?? tip}`)
  if (expect !== undefined && tip !== expect) throw moved(tip)
  if (workGit(W, ['rev-list', '--count', `${BASE_REF}..${tip}`]) === '0') return { empty: true }

  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = tempFile(dir, '.bundle')
  let renamed = false
  let digest
  try {
    try {
      workGit(W, ['bundle', 'create', '-q', '-', ref, `^${BASE_REF}`], { outFd: tmp.fd })
      fs.fsyncSync(tmp.fd)
    } finally {
      fs.closeSync(tmp.fd)
    }
    // What the file holds, not what was asked for: one head, today's tip, cut at the base.
    const header = bundleHeader(tmp.path)
    if (header.heads.length !== 1 || header.heads[0].ref !== ref) {
      throw fail('BAD_BUNDLE', `bad-bundle: ${tmp.path}: expected the one head ${ref}`)
    }
    if (header.heads[0].oid !== tip) throw moved(header.heads[0].oid)
    for (const oid of header.prerequisites) {
      if (!isAncestor(W, oid, BASE_REF)) throw fail('BAD_BUNDLE', `bad-bundle: ${tmp.path}: prerequisite ${oid} is not in ${BASE_REF}`)
    }
    workGit(W, ['bundle', 'verify', '-q', tmp.path])
    digest = fileDigest(tmp.path)
    // Every git-derived value first, then each check right before the write it protects (R31):
    // the lock may be lost while the bundle is made or the old one is judged; publish nothing then.
    if (needsPrevious(W, file, branch, tip)) keepPrevious(file, held)
    fault('bundle:before-rename')
    held()
    fs.renameSync(tmp.path, file)
    renamed = true
    fsyncDir(dir)
  } finally {
    if (!renamed) fs.rmSync(tmp.path, { force: true })
  }
  held()
  writeReplace(sidecarPath(paths, branch), { tip, sha256: digest.sha256 })
  return { file, tip, sha256: digest.sha256, bytes: digest.bytes, why }
}

// For every dated refs/heads/* of <W> (sorted by ref), one {branch, result}:
//   {state:'skipped', reason:'merged', tip}     no commit beyond `base`
//   {state:'skipped', reason:'retired', tip}    comparable with a retired tip the base does not
//                                               contain (R11; loop-start's retiredRefs)
//   {state:'unvetted', tip, note}               vetted({branch, ref, tip}) said no (asked
//                                               before any content of the branch is merged)
//   {state:'skipped', reason:'contained', tip}  the base holds its work (a squash merge;
//                                               loop-start's containedIn)
//   {state:'current', file, tip}                bundleCurrent: nothing written
//   {state:'written', reason, file, tip, sha256, bytes, why}   rewritten; reason is
//                                               bundleCurrent's
//   {state:'empty', tip}                        writeBundle found an empty range
//   {state:'error', tip, detail}                that branch failed; the others still sync
// A lost lock (guard() throwing NOT_HOLDER or HOLDER_UNKNOWN, passed on to writeBundle) is no
// branch error: it propagates at once and the remaining branches are left alone.
// `vetted` and `guard` are required (vetted: the run-record vettedTip predicate; guard: the
// caller's assertHeld; both bound by the caller, TypeError otherwise). `retired`
// holds commit names; omitted, it is every refs/tech-lead/retired/** tip in <W>. `base` selects
// the branches (merged, contained, retired); the bundles themselves are always cut at
// refs/tech-lead/base. Listing failures throw.
export function syncBundles(paths, { vetted, retired, base = BASE_REF, why = 'regenerated', guard } = {}) {
  if (typeof vetted !== 'function') throw new TypeError('syncBundles: vetted must be a function ({branch, ref, tip}) -> boolean')
  const held = guardOf(guard, 'syncBundles')
  if (typeof base !== 'string' || !PLAIN_RE.test(base) || PSEUDO_RE.test(base)) {
    throw new TypeError(`syncBundles: base ${JSON.stringify(base)} is not a plain commit name`)
  }
  if (typeof why !== 'string' || !WHY_RE.test(why)) throw fail('BAD_WHY', `bad-why: ${JSON.stringify(why)}`)
  const W = paths.W
  const git = (args, opts) => workGit(W, args, opts)
  const heads = git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/'])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const sp = line.indexOf(' ')
      return { tip: line.slice(0, sp), ref: line.slice(sp + 1) }
    })
    .filter(({ ref }) => DATED_BRANCH_RE.test(ref))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
  if (!heads.length) return []
  const retiredTips = retired === undefined
    ? git(['for-each-ref', '--format=%(objectname)', 'refs/tech-lead/retired/']).split('\n').filter(Boolean)
    : retired
  const skip = new Set()
  const prefixes = new Set(heads.map(({ ref }) => ref.slice('refs/heads/'.length, ref.lastIndexOf('/'))))
  for (const prefix of prefixes) for (const ref of retiredRefs(git, prefix, base, retiredTips)) skip.add(ref)

  const out = []
  for (const { ref, tip } of heads) {
    const branch = ref.slice('refs/heads/'.length)
    let result
    try {
      if (git(['rev-list', '--count', `${base}..${tip}`]) === '0') result = { state: 'skipped', reason: 'merged', tip }
      else if (skip.has(ref)) result = { state: 'skipped', reason: 'retired', tip }
      else if (!vetted({ branch, ref, tip })) {
        result = { state: 'unvetted', tip, note: `bundle skipped: ${branch} at ${tip.slice(0, 12)} is not vetted` }
      } else if (containedIn(git, base, tip)) result = { state: 'skipped', reason: 'contained', tip }
      else {
        const cur = bundleCurrent(paths, branch, tip)
        if (cur.current) result = { state: 'current', file: bundlePath(paths, branch), tip }
        else {
          const w = writeBundle(paths, branch, { why, tip, guard: held })
          result = w.empty ? { state: 'empty', tip } : { state: 'written', reason: cur.reason, ...w }
        }
      }
    } catch (e) {
      if (e && LOCK_LOST.has(e.code)) throw e
      result = { state: 'error', tip, detail: e.message }
    }
    out.push({ branch, result })
  }
  return out
}
