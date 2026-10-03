#!/usr/bin/env node
// scripts/loop-review.mjs
// The owner's review of loop work (spec loop04, brief 15 and R11; stage 0c-2). The loop's
// commits live only in its clone <W>; after each commit it writes the delivery bundle
// <V>/out/<prefix>/<date>.bundle (scripts/lib/delivery.mjs). The owner fetches those bundles
// into <P>, which runs nothing from the clone, and rejects work by retiring its branch. Run
// in the owner's own terminal only: no skill names this script, and fetch and retire refuse
// unless stdin and stdout are a TTY, so a delegate's shell cannot vouch for its own work.
//
// CLI (one JSON line on stdout; exit 0, 2 error or usage, 3 refused):
//   paths <P>                                   {V, W, out}; read-only, no terminal needed
//   fetch <P> [--branch <b>] [--trust-unrecorded]
//       {state:'fetched'|'refused', results:[{branch, file, ref, tip, state, ...}]}
//       Each <V>/out/**/<date>.bundle (never a .tmp-* temp file or a .prev-* kept copy), or
//       with --branch that branch's bundle alone, is checked on its own, in this order:
//         a regular file (not-a-file), a readable bundle header (corrupt), exactly one head
//         refs/heads/<branch> matching its path (head-mismatch); a tip one of the branch's
//         retired refs names is not fetched (state retired). A retired ref whose tip the base
//         contains counts for nothing here, as in the clone (R11): the base is LOOP.md's
//         `base:` (else the remote's default branch, as prepare resolves it), and it contains a
//         tip that is its ancestor or that a merge into it would change nothing for (a squash
//         merge; that merge runs in the private repository below, never in <P>); with no base
//         found, every retired ref counts. Then: its tip recorded in the
//         ledger (a commit, a recovered commit or a delivery bundle tip), already reachable
//         from a ref of <P>, or --trust-unrecorded (unrecorded); every prerequisite a commit
//         of <P> (missing-prerequisite); `bundle verify -q` in <P> (verify-failed); a tip <P>
//         already holds also has its whole pack read in a private repository that borrows
//         <P>'s objects and has its object format (verify-failed), since git's fetch reads no
//         pack then; then a
//         non-forced fetch with fsckObjects and --show-forced-updates (git's ancestry check
//         runs whatever fetch.showForcedUpdates says) of refs/heads/<b> into
//         refs/remotes/tech-lead/<b>, with automatic maintenance off (non-fast-forward,
//         fetch-failed). For a branch that
//         has a retired ref the fetch goes to the scratch ref refs/tech-lead/review-tmp/<b>
//         first: a tip comparable with a retired tip stays out of the remote-tracking ref
//         (retired), and a remote-tracking ref naming rejected work (comparable with a retired
//         tip) is replaced by the restarted branch, compare-and-swap (`replaced` names the old
//         tip); any other non-descendant is a non-fast-forward as before. A result is fetched,
//         current (the ref already names the tip; decided after every check), retired, or
//         refused with a reason; any refusal makes the run exit 3, and the results say which
//         bundles were fetched.
//   retire <P> <branch>
//       {state:'retired', branch, ref, tip, from, previous, kept, descendants, notes[, unchanged]}
//       exit 3 {state:'refused', reason: not-confirmed | no-tip | tip-not-in-repo, detail}
//       Shows the tip (refs/remotes/tech-lead/<branch> in <P>, else the bundle's head, which
//       <P> must already hold), asks the owner to type the branch name, then writes
//       refs/tech-lead/retired/<branch> in <P> (compare-and-swap against the value read). A
//       ref that named another tip keeps it first under refs/tech-lead/retired/<branch>@<sha12>
//       (`kept`; R27: a rejection is never dropped). The next prepare fetches every
//       refs/tech-lead/retired/** ref into the clone, which never chains on, bundles or keeps as
//       today's branch a dated branch comparable with one (R11). Every other dated branch of
//       <P> whose tip descends from the retired tip is noted.
//   not a terminal (fetch, retire): exit 2 {state:'error', detail:'needs-terminal: ...'}
// Every git call runs through safeGit in R (realpath of <P>).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { readJson, tempFile } from './lib/atomic.mjs'
import { DATED_BRANCH_RE } from './lib/clone-check.mjs'
import { bundleHeader, bundlePath } from './lib/delivery.mjs'
import { safeGit } from './lib/git-safe.mjs'
import { ledgerShas } from './lib/ledger.mjs'
import { loopPaths } from './lib/loop-paths.mjs'
import { containedIn, resolveBase } from './loop-start.mjs'

const REMOTE_PREFIX = 'refs/remotes/tech-lead/'
const RETIRED_PREFIX = 'refs/tech-lead/retired/'
const SCRATCH_PREFIX = 'refs/tech-lead/review-tmp/'
// The suffix of a kept rejection: refs/tech-lead/retired/<branch>@<sha12> (R27).
const KEPT_RE = /^@[0-9a-f]{12}$/
const FSCK = ['fetch.fsckObjects=true', 'transfer.fsckObjects=true']
// git runs `maintenance run --auto` after a fetch (detached by default since git 2.54), which
// would start background work in the owner's repository. The fetch turns it off by config
// (git before 2.29 ran `gc --auto` instead) and, where git knows it, --no-auto-maintenance.
const NO_MAINTENANCE = ['maintenance.auto=false', 'gc.auto=0']
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
const CHUNK = 1024 * 1024
const USAGE = 'usage: loop-review.mjs paths <P> | fetch <P> [--branch <b>] [--trust-unrecorded] | retire <P> <branch>'

const firstLines = s => String(s || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ')
const short = oid => String(oid).slice(0, 12)

function usageError(detail) {
  const e = new Error(detail ? `${detail}; ${USAGE}` : USAGE)
  e.code = 'USAGE'
  return e
}

// The paths of P, with <V> bound to R when its identity is on record. Creates nothing.
function openPaths(P, env) {
  const paths = loopPaths(P, { env })
  const id = readJson(path.join(paths.V, 'identity.json'))
  if (id && id.R !== paths.R) throw new Error(`identity-mismatch: ${paths.V} belongs to ${id.R}`)
  return paths
}

// A dated loop branch name, or throws bad-branch (delivery's own check of the name).
function checkBranch(paths, branch) {
  try {
    return bundlePath(paths, branch)
  } catch (e) {
    if (e.code === 'BAD_BRANCH') throw usageError(e.message)
    throw e
  }
}

function terminalIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: text => process.stderr.write(`${text}\n`),
    ask: async question => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
  }
}

function needTerminal(io, what) {
  if (!io || io.isTTY !== true) {
    throw new Error(`needs-terminal: loop-review ${what} runs only in the owner's own terminal (stdin and stdout a TTY); nothing was read or written`)
  }
}

const say = (io, text) => {
  if (io && typeof io.print === 'function') io.print(text)
}

// git in R; true on exit 0, false on any other exit. A run that did not finish throws.
function gitOk(R, args) {
  try {
    safeGit(R, args)
    return true
  } catch (e) {
    if (e.code) throw e
    return false
  }
}

// The commit a name resolves to in R, or null.
function commitOf(R, name) {
  try {
    const out = safeGit(R, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])
    return out || null
  } catch (e) {
    if (e.code) throw e
    return null
  }
}

const isCommit = (R, oid) => commitOf(R, oid) === oid

// The tip is a commit some ref of R already reaches.
function reachable(R, tip) {
  if (!isCommit(R, tip)) return false
  return safeGit(R, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', tip]) !== ''
}

const isAncestor = (R, a, b) => gitOk(R, ['merge-base', '--is-ancestor', a, b])
// Either contains the other (R11's "comparable").
const comparable = (R, a, b) => a === b || isAncestor(R, a, b) || isAncestor(R, b, a)

// The retired tips of branch in R: refs/tech-lead/retired/<branch> and each kept
// refs/tech-lead/retired/<branch>@<sha12> (R27), as [{ref, tip}].
function retiredOf(R, branch) {
  const own = `${RETIRED_PREFIX}${branch}`
  const parent = `${RETIRED_PREFIX}${branch.slice(0, branch.lastIndexOf('/'))}/`
  const out = []
  for (const line of safeGit(R, ['for-each-ref', '--format=%(objectname) %(refname)', parent]).split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const ref = line.slice(sp + 1)
    if (ref === own || (ref.startsWith(own) && KEPT_RE.test(ref.slice(own.length)))) out.push({ ref, tip: line.slice(0, sp) })
  }
  return out
}

// Runs fn(repo) with repo a private bare repository under dir that borrows <P>'s objects through
// alternates and has <P>'s object format (a SHA-256 <P> needs a SHA-256 repository, code#4), and
// removes it again; <P> is not written. An empty template: no hook, nothing copied in.
function withPrivateRepo(R, dir, fn) {
  const box = fs.mkdtempSync(path.join(dir, 'check-'))
  try {
    const template = path.join(box, 'template')
    fs.mkdirSync(template)
    const format = safeGit(R, ['rev-parse', '--show-object-format'])
    if (!/^sha(?:1|256)$/.test(format)) throw new Error(`object-format: ${R} reports ${JSON.stringify(format)}`)
    safeGit(box, ['init', '-q', '--bare', `--object-format=${format}`, `--template=${template}`, 'repo.git'])
    const repo = path.join(box, 'repo.git')
    const objects = path.resolve(R, safeGit(R, ['rev-parse', '--git-common-dir']), 'objects')
    fs.mkdirSync(path.join(repo, 'objects', 'info'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'objects', 'info', 'alternates'), `${objects}\n`)
    return fn(repo)
  } finally {
    // The private check repository only: under the mkdtemp directory this run made.
    fs.rmSync(box, { recursive: true, force: true })
  }
}

// Reads the bundle copy's whole pack (index-pack, through `bundle unbundle`) in a private
// repository (withPrivateRepo). Returns null when the pack is intact, else git's message. git's
// fetch reads no pack at all when <P> already holds every object, so this is how a bundle whose
// tip <P> has is still checked before it reads current.
function packProblem(R, copy, dir) {
  try {
    return withPrivateRepo(R, dir, repo => {
      safeGit(repo, ['bundle', 'unbundle', copy], { config: NO_MAINTENANCE })
      return null
    })
  } catch (e) {
    if (e.code) throw e
    return firstLines(e.stderr || e.message)
  }
}

// The base LOOP.md names in its front matter (`base: <name>`, plain or quoted, a trailing
// comment allowed), else null: no LOOP.md, no such key, or a value read some other way.
function loopMdBase(S) {
  let text
  try {
    text = fs.readFileSync(path.join(S, 'LOOP.md'), 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return null
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l))
  if (end < 0) return null
  const hits = lines.slice(1, end).map(l => /^base\s*:(.*)$/.exec(l)).filter(Boolean)
  if (hits.length !== 1) return null
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s#'"][^\s#]*))\s*(?:#.*)?$/.exec(hits[0][1])
  if (!m) return null
  return m[1] ?? m[2] ?? m[3]
}

// The commit of the base the clone branches from (R11), resolved in <P> as prepare resolves it
// (loop-start's resolveBase: LOOP.md's base, else the remote's default branch), or null when
// none resolves.
function reviewBase(paths) {
  let baseRef
  try {
    ({ baseRef } = resolveBase(paths.R, loopMdBase(paths.S) ?? undefined))
  } catch (e) {
    if (e.code === 'NO_BASE') return null
    throw e
  }
  return commitOf(paths.R, baseRef)
}

// The retired tips (retiredOf's entries) that still withhold work: those the base does not
// contain, by ancestry or by a merge that would change nothing (loop-start's containedIn, run in
// a private repository so <P> gets no object; a merge driver it cannot empty keeps the
// retirement). With no base, every one.
function activeRetired(R, retired, base, dir) {
  if (!retired.length || base === null) return retired
  const left = retired.filter(r => !isAncestor(R, r.tip, base))
  if (!left.length) return left
  return withPrivateRepo(R, dir, repo => left.filter(r => {
    try {
      return !containedIn((args, opts) => safeGit(repo, args, opts), base, r.tip)
    } catch (e) {
      if (e.code === 'UNSAFE_CONFIG') return true
      throw e
    }
  }))
}

export function reviewPaths(P, { env = process.env } = {}) {
  const paths = openPaths(P, env)
  return { V: paths.V, W: paths.W, out: path.join(paths.V, 'out') }
}

// The delivery bundles under <V>/out: [{branch, file}] sorted by branch, from every entry
// named <date>.bundle at any depth (symlinked directories are not entered; a symlink or other
// non-file at a bundle's name is listed, so the check refuses it). A name that is no dated
// branch is listed with branch set to its relative path, and refused.
function listBundles(paths) {
  const out = path.join(paths.V, 'out')
  let st
  try {
    st = fs.lstatSync(out)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  if (!st.isDirectory()) throw new Error(`bad-out: ${out} is not a directory`)
  const found = []
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      if (!ent.name.endsWith('.bundle') || ent.name.startsWith('.tmp-')) continue
      const rel = path.relative(out, full).split(path.sep).join('/')
      const branch = rel.slice(0, -'.bundle'.length)
      let named = null
      try {
        named = bundlePath(paths, branch)
      } catch (e) {
        if (e.code !== 'BAD_BRANCH') throw e
      }
      found.push({ branch, file: full, badName: named !== full })
    }
  }
  walk(out)
  return found.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}

// Copies the regular file `file` (never through a symlink, never blocking on a FIFO) into
// the private directory dir; returns the copy's path, or null when file is not a regular file.
// Every check and the fetch read the copy, so a bundle swapped under <V>/out after it was
// checked is never what git fetches.
function privateCopy(file, dir) {
  const src = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    if (!fs.fstatSync(src).isFile()) return null
    const dst = tempFile(dir, '.bundle')
    try {
      const buf = Buffer.alloc(CHUNK)
      for (let pos = 0; ;) {
        const n = fs.readSync(src, buf, 0, buf.length, pos)
        if (n === 0) break
        for (let off = 0; off < n;) off += fs.writeSync(dst.fd, buf, off, n - off)
        pos += n
      }
    } finally {
      fs.closeSync(dst.fd)
    }
    return dst.path
  } finally {
    fs.closeSync(src)
  }
}

// ['--no-auto-maintenance'] when this git's fetch knows the option (git 2.29 and later), else []
// (NO_MAINTENANCE alone keeps maintenance off). `fetch -h` exits 129 either way and writes
// nothing; an option git does not know is an 'unknown option' error on stderr first.
function autoMaintenanceArgs(R) {
  try {
    safeGit(R, ['fetch', '--no-auto-maintenance', '-h'])
  } catch (e) {
    if (e.code) throw e
    if (/unknown option/.test(String(e.stderr || ''))) return []
  }
  return ['--no-auto-maintenance']
}

// One bundle checked and fetched; returns its result. dir is a private directory for the copy.
function fetchOne(paths, { branch, file, badName }, { shas, trustUnrecorded, dir, noAuto, base }) {
  const R = paths.R
  const ref = `${REMOTE_PREFIX}${branch}`
  const res = { branch, file, ref, tip: null }
  const refuse = (reason, detail, extra = {}) => Object.assign(res, { state: 'refused', reason, detail, ...extra })
  if (badName) return refuse('bad-name', `${file} is not named <prefix>/<YYYY-MM-DD>.bundle for a dated loop branch`)
  let copy
  try {
    copy = privateCopy(file, dir)
  } catch (e) {
    if (e.code === 'ENOENT') return refuse('no-bundle', `no bundle for ${branch} at ${file}`)
    if (e.code !== 'ELOOP') throw e
    copy = null
  }
  if (copy === null) return refuse('not-a-file', `${file} is not a regular file`)
  try {
    return checkAndFetch(R, res, refuse, copy, { branch, ref, shas, trustUnrecorded, noAuto, dir, base })
  } finally {
    fs.rmSync(copy, { force: true })
  }
}

function checkAndFetch(R, res, refuse, copy, { branch, ref, shas, trustUnrecorded, noAuto, dir, base }) {
  // Messages name the bundle the owner knows, never the private copy.
  const named = text => String(text).split(copy).join(res.file)
  let header
  try {
    header = bundleHeader(copy)
  } catch (e) {
    if (e.code === 'BAD_BUNDLE') return refuse('corrupt', named(e.message))
    throw e
  }
  const want = `refs/heads/${branch}`
  if (header.heads.length !== 1 || header.heads[0].ref !== want) {
    return refuse('head-mismatch', `${res.file} must hold exactly the one head ${want}; it holds ${header.heads.map(h => h.ref).join(', ')}`)
  }
  const tip = header.heads[0].oid
  res.tip = tip
  const previous = commitOf(R, ref)
  res.previous = previous
  // The owner rejected this very tip: nothing to review, so nothing is fetched (no refusal).
  // Retirements the base contains count for nothing (R11).
  const retired = activeRetired(R, retiredOf(R, branch), base, dir)
  const hit = retired.find(r => r.tip === tip)
  if (hit) return Object.assign(res, { state: 'retired', retired: hit.ref, detail: `${branch} at ${short(tip)} is the tip ${hit.ref} retired; not fetched` })
  let trusted
  if (shas.commits.has(tip) || shas.tips.has(tip)) trusted = 'ledger'
  else if (reachable(R, tip)) trusted = 'repo'
  else if (trustUnrecorded) trusted = 'flag'
  else {
    return refuse('unrecorded', `${branch} at ${short(tip)}: no ledger row names this tip as a commit or a bundle tip, and <P> does not have it; review how it was made, then pass --trust-unrecorded to fetch it anyway`)
  }
  res.trusted = trusted
  const missing = header.prerequisites.filter(oid => !isCommit(R, oid))
  if (missing.length) {
    return refuse('missing-prerequisite', `${branch}: <P> lacks the prerequisite commit(s) ${missing.map(short).join(', ')} (the base the bundle was cut from)`, { missing })
  }
  try {
    safeGit(R, ['bundle', 'verify', '-q', copy])
  } catch (e) {
    if (e.code) throw e
    return refuse('verify-failed', `git bundle verify: ${named(firstLines(e.stderr || e.message))}`)
  }
  if (isCommit(R, tip)) {
    const bad = packProblem(R, copy, dir)
    if (bad !== null) return refuse('verify-failed', `the bundle's pack: ${named(bad)}`)
  }
  // --show-forced-updates: under fetch.showForcedUpdates=false git moves a ref to a
  // non-descendant as a fast-forward, without its ancestry check (closing review F8).
  const fetchInto = dest => safeGit(R, ['fetch', ...noAuto(), '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--show-forced-updates', copy, `${want}:${dest}`], {
    config: [...FSCK, ...NO_MAINTENANCE],
  })
  const nonFastForward = () => refuse('non-fast-forward', `${ref} is at ${short(previous)}, which ${short(tip)} does not descend from; it was left where it was`)
  if (!retired.length) {
    try {
      fetchInto(ref)
    } catch (e) {
      if (e.code) throw e
      const stderr = String(e.stderr || '')
      const nonFF = previous !== null && (/non-fast-forward/.test(stderr) || (isCommit(R, tip) && !isAncestor(R, previous, tip)))
      if (nonFF) return nonFastForward()
      return refuse('fetch-failed', `git fetch: ${named(firstLines(stderr || e.message))}`)
    }
    const now = commitOf(R, ref)
    if (now !== tip) return refuse('fetch-failed', `${ref} is at ${now ? short(now) : 'nothing'} after the fetch, not ${short(tip)}`)
    return Object.assign(res, { state: previous === tip ? 'current' : 'fetched' })
  }
  return fetchRetired(R, res, refuse, { branch, ref, tip, previous, retired, fetchInto, named, nonFastForward })
}

// The fetch of a branch the owner retired at least once (prose-checks#2): into a scratch ref
// first, then the remote-tracking ref is moved by compare-and-swap only when the tip carries
// no rejected work, fast-forwarding it, or replacing a value that names rejected work (the
// branch restarted after a retire, R11). The scratch ref is removed in every case.
function fetchRetired(R, res, refuse, { branch, ref, tip, previous, retired, fetchInto, named, nonFastForward }) {
  const scratch = `${SCRATCH_PREFIX}${branch}`
  const drop = () => { if (commitOf(R, scratch) !== null) safeGit(R, ['update-ref', '-d', scratch]) }
  drop() // a scratch ref a killed run left
  try {
    try {
      fetchInto(scratch)
    } catch (e) {
      if (e.code) throw e
      return refuse('fetch-failed', `git fetch: ${named(firstLines(e.stderr || e.message))}`)
    }
    const got = commitOf(R, scratch)
    if (got !== tip) return refuse('fetch-failed', `${scratch} is at ${got ? short(got) : 'nothing'} after the fetch, not ${short(tip)}`)
    const rejected = retired.find(r => comparable(R, r.tip, tip))
    if (rejected) {
      return Object.assign(res, { state: 'retired', retired: rejected.ref, detail: `${branch} at ${short(tip)} carries work ${rejected.ref} retired (${short(rejected.tip)}); ${ref} was left where it was` })
    }
    if (previous === tip) return Object.assign(res, { state: 'current' })
    let replaced = null
    if (previous !== null && !isAncestor(R, previous, tip)) {
      if (!retired.some(r => comparable(R, r.tip, previous))) return nonFastForward()
      replaced = previous
    }
    try {
      safeGit(R, ['update-ref', '-m', 'loop-review fetch', ref, tip, previous ?? ''])
    } catch (e) {
      if (e.code) throw e
      return refuse('fetch-failed', `update-ref ${ref}: ${firstLines(e.stderr || e.message)}`)
    }
    if (replaced !== null) res.replaced = replaced
    return Object.assign(res, { state: 'fetched' })
  } finally {
    drop()
  }
}

export async function fetchBundles(P, { branch = null, trustUnrecorded = false, env = process.env, io = terminalIo() } = {}) {
  needTerminal(io, 'fetch')
  const paths = openPaths(P, env)
  let bundles
  if (branch !== null) bundles = [{ branch, file: checkBranch(paths, branch), badName: false }]
  else bundles = listBundles(paths)
  const shas = ledgerShas(paths.S)
  let results
  let auto = null
  const noAuto = () => (auto ??= autoMaintenanceArgs(paths.R)) // probed once, before the first fetch
  const base = bundles.length ? reviewBase(paths) : null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tech-lead-review-')) // mode 0700
  try {
    results = bundles.map(b => fetchOne(paths, b, { shas, trustUnrecorded: Boolean(trustUnrecorded), dir, noAuto, base }))
  } finally {
    // Each copy was removed once its bundle was done, so the private directory is empty.
    try {
      fs.rmdirSync(dir)
    } catch { /* left in the temp directory */ }
  }
  for (const r of results) {
    if (r.state === 'fetched') {
      say(io, `fetched ${r.branch} at ${short(r.tip)} into ${r.ref}${r.trusted === 'flag' ? ' (unrecorded; trusted by --trust-unrecorded)' : ''}; review: git log <base>..${r.ref}`)
      if (r.replaced) say(io, `  ${r.ref} named the retired work ${short(r.replaced)}; it now names the restarted branch`)
    } else if (r.state === 'current') say(io, `current ${r.branch}: ${r.ref} already at ${short(r.tip)}`)
    else if (r.state === 'retired') say(io, `retired ${r.branch}: ${r.detail}`)
    else say(io, `refused ${r.branch}: ${r.reason}: ${r.detail}`)
  }
  if (!results.length) say(io, `no delivery bundles under ${path.join(paths.V, 'out')}`)
  return { state: results.some(r => r.state === 'refused') ? 'refused' : 'fetched', results }
}

// The dated branches of R (local, and fetched under refs/remotes/tech-lead/) other than
// `branch` whose tip contains tip.
function descendantsOf(R, branch, tip) {
  const refs = safeGit(R, ['for-each-ref', '--format=%(refname)', '--contains', tip, 'refs/heads/', REMOTE_PREFIX.slice(0, -1)])
  const out = []
  for (const ref of refs.split('\n').filter(Boolean)) {
    const name = ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : ref.slice('refs/heads/'.length)
    if (name === branch || !DATED_BRANCH_RE.test(`refs/heads/${name}`)) continue
    out.push(ref)
  }
  return out.sort()
}

export async function retire(P, branch, { env = process.env, io = terminalIo() } = {}) {
  needTerminal(io, 'retire')
  const paths = openPaths(P, env)
  const file = checkBranch(paths, branch)
  const R = paths.R
  const ref = `${RETIRED_PREFIX}${branch}`
  const remote = `${REMOTE_PREFIX}${branch}`
  const refuse = (reason, detail) => ({ state: 'refused', reason, branch, detail })
  let tip = commitOf(R, remote), from = 'remote'
  if (tip === null) {
    from = 'bundle'
    let header = null
    try {
      if (fs.lstatSync(file).isFile()) header = bundleHeader(file)
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'BAD_BUNDLE' && e.code !== 'ELOOP') throw e
    }
    const head = header && header.heads.length === 1 && header.heads[0].ref === `refs/heads/${branch}` ? header.heads[0] : null
    if (!head) return refuse('no-tip', `<P> has no ${remote} and ${file} holds no readable bundle of refs/heads/${branch}; nothing was written`)
    tip = head.oid
    if (!isCommit(R, tip)) {
      return refuse('tip-not-in-repo', `the bundle's tip ${short(tip)} is not in <P>, so no ref there can name it; fetch it first (loop-review.mjs fetch ${P} --branch ${branch}); nothing was written`)
    }
  }
  const previous = commitOf(R, ref)
  const descendants = descendantsOf(R, branch, tip)
  const notes = descendants.map(d => `${d} descends from the retired tip ${short(tip)}: it carries the rejected work, and the loop will not chain on it`)
  // R27: the tip the ref names now stays retired under its own ref before the ref moves.
  const kept = previous !== null && previous !== tip ? `${ref}@${previous.slice(0, 12)}` : null
  const result = { state: 'retired', branch, ref, tip, from, previous, kept, descendants, notes }
  if (previous === tip) {
    say(io, `${branch} is already retired at ${short(tip)}; nothing to write`)
    return { ...result, unchanged: true }
  }
  if (kept !== null) notes.push(`${ref} named ${short(previous)}; that tip stays retired as ${kept}, and ${ref} now names ${short(tip)}`)
  const subject = safeGit(R, ['log', '-1', '--format=%h %s', tip])
  say(io, `retire ${branch} at ${tip} (${from === 'remote' ? remote : file})`)
  say(io, `  ${subject}`)
  say(io, `the loop will never chain on, bundle again or keep as today's branch a dated branch comparable with this tip (it writes ${ref} in ${R})`)
  if (kept !== null) say(io, `note: ${ref} currently names ${previous}; it stays retired as ${kept}`)
  for (const n of notes.slice(0, descendants.length)) say(io, `note: ${n}`)
  const answer = String((await io.ask(`Type ${branch} to retire it: `)) ?? '').trim()
  if (answer !== branch) return refuse('not-confirmed', `typed ${JSON.stringify(answer)}, not ${branch}; nothing was written`)
  if (kept !== null) {
    const at = commitOf(R, kept)
    if (at === null) safeGit(R, ['update-ref', '-m', 'loop-review retire (kept)', kept, previous, ''])
    else if (at !== previous) throw new Error(`retired-ref-collision: ${kept} names ${at}, not ${previous}; nothing was written`)
  }
  safeGit(R, ['update-ref', '-m', 'loop-review retire', ref, tip, previous ?? ''])
  say(io, `retired ${branch} at ${short(tip)} (${ref})`)
  return result
}

// Exactly the positionals the command takes, each flag once; null on misuse.
function parseArgs(argv, { positionals, flags = [], bools = [] }) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) pos.push(a)
    else if (bools.includes(a.slice(2)) && !(a.slice(2) in opts)) opts[a.slice(2)] = true
    else if (flags.includes(a.slice(2)) && !(a.slice(2) in opts) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
    else return null
  }
  if (pos.length !== positionals) return null
  return { pos, opts }
}

const COMMANDS = {
  paths: { positionals: 1, run: async ({ pos }, { env }) => [0, reviewPaths(pos[0], { env })] },
  fetch: {
    positionals: 1, flags: ['branch'], bools: ['trust-unrecorded'],
    run: async ({ pos, opts }, { env, io }) => {
      const r = await fetchBundles(pos[0], { branch: opts.branch ?? null, trustUnrecorded: Boolean(opts['trust-unrecorded']), env, io })
      return [r.state === 'fetched' ? 0 : 3, r]
    },
  },
  retire: {
    positionals: 2,
    run: async ({ pos }, { env, io }) => {
      const r = await retire(pos[0], pos[1], { env, io })
      return [r.state === 'retired' ? 0 : 3, r]
    },
  },
}

// Runs one command; returns the exit code and prints exactly one output object.
export async function main(argv, { env = process.env, io, print = o => process.stdout.write(`${JSON.stringify(o)}\n`) } = {}) {
  const cmd = argv[0] !== undefined && Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv[0]] : null
  const args = cmd && parseArgs(argv.slice(1), cmd)
  if (!args) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    const [code, out] = await cmd.run(args, { env, io: io ?? terminalIo() })
    print(out)
    return code
  } catch (e) {
    print({ state: 'error', detail: e.message })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
