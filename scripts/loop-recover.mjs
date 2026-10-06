#!/usr/bin/env node
// scripts/loop-recover.mjs
// The single recovery planner (stage 0c-2 brief section 14; stage 0c-3 R19-R21 bind the ## Now
// item by id and digest and add clear-now; the fix pass's R29 limits clear-now to identical copies
// of one item and adds now-conflict; fix round 2's R29a widens identical past the digest). Run at
// loop section 1 step 5, after acquire and before any write-capable dispatch, it reports what
// interrupted firings left behind and which governance-side recovery actions the main session
// takes, in a fixed order. It carries out none
// of them, writes nothing and runs nothing from the trees it reads: git runs in the clone <W>
// through workGit (GIT_OPTIONAL_LOCKS=0, so not even the index's stat cache is refreshed), and the
// legacy 0c-1 worktree <S>/worktree is only read, through safeGit with --no-optional-locks. Both
// `status` reads empty every configured filter driver and read attributes from the checked-out
// commit (as changes.mjs collect does), and pass --ignore-submodules=dirty, so git never runs
// inside a nested repository (R26: a gitlink moved to another commit is still seen). Every <W>
// mutation of recovery happens later, inside loop-clone.mjs prepare (rulings R10, R13).
//
// Inputs: <S>/STATE.md (nowLine and its SHA-256; the items through loop-state.mjs parseState, the
// one item grammar: the ## Now item, the carriers of its id through idCarriers, raw ones included,
// the ## Done sha slots; the clear-now deletion is planned there too, planDeleteBlock),
// <S>/LEDGER.jsonl (ledgerShas), every run record <V>/run/<g>.json (run-record.mjs), the recovery
// bundles they anchor (<V>/patches/<sha>.patch, hashed in place), the clone's facts (checkClone,
// HEAD, `status`, git lock files) and the delivery bundles (delivery.bundleCurrent).
//
// Only the record that owns the clone (run-record ownerRecord: the newest unresolved record
// that is not a bare preparing one, the record prepare acts on) is judged against the clone
// (run-record cloneVerdict); the others are reported `resolved` or `superseded` without
// consulting it (ruling R4).
//
// Actions, in this order:
//   clear-now         ## Now holds exactly one block, the item, and its id is also carried by
//                     exactly one item in another section, the same item: the same itemDigest
//                     and the same blocked-by:, decided: and no-change-ok: lines and origin-like
//                     lines (as written), whatever its status:, class:, recovery: line and
//                     header form (a move rewrites those) (R29a); and by no raw carrier (an id
//                     line that does not parse to it): a move (pick, finish, requeue, block) was
//                     interrupted between its insertion and its deletion (R14), and the other
//                     copy is the item (R29). The main session applies `clear.edits`, the
//                     anchored deletion of that one block (## Now is left (empty)), and checks
//                     `clear.expect_sha256`. Neither finish-commit nor requeue-now is then due.
//   now-conflict      the ## Now item's id is carried elsewhere but clear-now does not hold: the
//                     copies differ (a person amended one: its title, notes or decision, or a
//                     field of the R29a identity), ## Now holds another block too, the id has
//                     several other carriers, or a raw one (R29). The main session treats it as
//                     the item-edit incident (pause, both copies kept); `conflict` names why.
//                     Neither finish-commit nor requeue-now is then due.
//   finish-commit     the owner record reads `committed`, ## Now holds an item whose line's
//                     SHA-256 is the record's now_sha256, and, for a v:2 record, whose id and
//                     itemDigest are the record's item_id and item_digest (a v:2 record that
//                     bound no item never finishes; a v:1 record, written by 0.5.0, binds the
//                     line alone, R20); and no ## Done header names the commit in its sha slot
//                     (the full sha or a 7+ hex prefix; the header is split from the right)
//                     and no ledger row names it. The main session moves the Now item to
//                     ## Done with the sha in one Edit (no title search). A STATE.md holding a
//                     carriage return (crlf) is never read for items: no clear-now and no
//                     finish-commit.
//   requeue-now       ## Now holds an item and none of clear-now, now-conflict and finish-commit
//                     applies.
//   ledger-recovered  some record still on disk holds a commit, save or recovery-bundle sha
//                     that no ledger row names; this firing's single row gets `recovered`.
//   write-bundle      a branch with a committed record has a missing or stale delivery bundle
//                     and a vetted tip (never while a delegate commit is being rewound, never
//                     for a tip comparable with a retired tip); the main session runs
//                     loop-clone.mjs bundle for each branch in write_bundles.
//   note-leftovers    the owner record (or, with none, the clone) reads
//                     leftovers, delegate-commit, rewind, resume or resume-reset, or committed
//                     with residue: the next clone preparation saves and resets them.
//
// Usage: node loop-recover.mjs <P> --generation <N> [--reclaimed <g>]
//   exit 0 prints {generation, reclaimed, now, now_sha256,
//     clone: {exists, valid, problems, head, branch, dirty: {staged, tracked, untracked, more},
//             locks},
//     records: [{generation, phase, verdict, sha, ledgered}],
//     clear: null | {id, section, edits, expect_sha256} (section: the other copy's; edits and
//       expect_sha256: the anchored deletion of the ## Now block, as loop-items prints edits),
//     conflict: null | {id, reasons, now: {line, digest}, now_items, carriers: [{section, line,
//       digest, raw}]} (reasons: several-now-items, several-carriers, raw-carrier,
//       digest-differs, blocked-by-differs, origin-differs, decided-differs,
//       no-change-ok-differs, each `-differs` naming what the one other copy differs in;
//       now_items the number of blocks in ## Now; a raw carrier's line is its id line and its
//       digest null),
//     finish: null | {generation, sha, item_id, item_digest} (the ## Now item's id and
//       itemDigest; both null when it has no valid id, as after a v:1 record),
//     recovered: null | {generations, commits, bundles, task, item_id, item_origin} (task the
//       ## Now line; item_id and item_origin the ## Now item's id (null without a valid one)
//       and its first origin: value as written, null when there is none),
//     write_bundles: [branch], legacy: {worktree: {exists, staged, tracked, untracked, more,
//     problem}}, actions, notes}
//   exit 2 prints {state:'error', detail} (an incident: paused, outcome skipped, stop the
//   runner): usage, not-a-repo / not-toplevel, no-state, record-from-the-future (a record of
//   generation >= N), corrupt (a run record that does not read), tampered (a referenced
//   recovery bundle missing, not a regular file, or with another SHA-256), clone-invalid
//   (with `problems`), unknown-tip (the owner record reads unknown), or a git
//   or I/O failure (a delivery bundle or sidecar that cannot be inspected: `bundle-check:
//   <branch>: ...`).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopPaths } from './lib/loop-paths.mjs'
import { safeGit, workGitRun } from './lib/git-safe.mjs'
import { sha256Hex } from './lib/canonical.mjs'
import { PLACEHOLDER as STATE_PLACEHOLDER, fold, idCarriers, itemDigest, nowLine, parseState, planDeleteBlock } from './lib/loop-state.mjs'
import { ledgerShas } from './lib/ledger.mjs'
import { checkClone } from './lib/clone-check.mjs'
import {
  cloneVerdict, committedSha, isResolved, listRecords, maxRecordGeneration, ownerRecord, recordFile, recordItem, vettedTip,
} from './lib/run-record.mjs'
import { BASE_REF, bundleCurrent } from './lib/delivery.mjs'
import { worktreeChanged } from './lib/changes.mjs'

// nowLine and PLACEHOLDER moved to scripts/lib/loop-state.mjs (stage 0c-2); re-exported.
// scripts/checks/loop.mjs reads the placeholder from loop-state.mjs.
export { nowLine, STATE_PLACEHOLDER as PLACEHOLDER }

export const ACTIONS = ['clear-now', 'now-conflict', 'finish-commit', 'requeue-now', 'ledger-recovered', 'write-bundle', 'note-leftovers']

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
const CAP = 50
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
// A ## Done sha slot that names a commit: a full or abbreviated sha of 7 to 64 hex digits.
const SHA_SLOT = /^[0-9a-f]{7,64}$/
const LEFTOVER_VERDICTS = new Set(['leftovers', 'delegate-commit', 'rewind', 'resume', 'resume-reset'])
const REWINDING = new Set(['delegate-commit', 'rewind'])
const GIT_LOCKS = ['HEAD.lock', 'config.lock', 'index.lock', 'packed-refs.lock']
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const firstLine = s => String(s).trim().split('\n')[0]
const short = sha => String(sha).slice(0, 12)
const unique = list => [...new Set(list)]
const fail = (detail, extra = {}) => Object.assign(new Error(detail), { extra })

// A path's bytes as JSON: the string when they are valid UTF-8, else {b64} (brief section 8).
function encodePath(buf) {
  try {
    return UTF8.decode(buf)
  } catch {
    return { b64: buf.toString('base64') }
  }
}

function splitNul(buf) {
  const out = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue
    out.push(buf.subarray(start, i))
    start = i + 1
  }
  if (start < buf.length) out.push(buf.subarray(start))
  return out
}

// Porcelain v1 with -z: `XY path` entries separated by NUL; a rename or copy entry is
// followed by one more field, its source path. Untracked paths in git's order, capped at CAP
// with the rest counted in `more`.
function parseStatus(buf) {
  let staged = false, tracked = false
  const untracked = []
  const fields = splitNul(buf)
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i]
    if (e.length < 4) continue
    const x = String.fromCharCode(e[0]), y = String.fromCharCode(e[1])
    if (x === '?' && y === '?') {
      untracked.push(encodePath(e.subarray(3)))
      continue
    }
    if (x === '!' && y === '!') continue
    if (x !== ' ') staged = true
    if (y !== ' ') tracked = true
    if ('RC'.includes(x) || 'RC'.includes(y)) i++
  }
  return { staged, tracked, untracked: untracked.slice(0, CAP), more: Math.max(0, untracked.length - CAP), count: untracked.length }
}
const dirtyOf = s => ({ staged: s.staged, tracked: s.tracked, untracked: s.untracked, more: s.more })

const lstatOrNull = p => {
  try {
    return fs.lstatSync(p)
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

const kindOf = st => (st.isSymbolicLink() ? 'a symlink' : st.isFile() ? 'a file' : 'a special file')

function gitError(r, label) {
  return new Error(r.error || `git ${label} failed (exit ${r.status}): ${firstLine(r.stderr)}`)
}

// ---------------------------------------------------------------- STATE.md

// Does a ## Done item name sha in its header's sha slot (R20: the header is split from the
// right, date, then sha, so a title never counts), in full or by a prefix of 7 or more hex
// digits, any case? state is parseState's result; a dash slot names nothing, and a Done line
// that does not parse as a header is no item.
function doneNames(state, sha) {
  for (const item of state.items) {
    if (item.section !== 'Done' || item.sha === null) continue
    const hex = item.sha.toLowerCase()
    if (SHA_SLOT.test(hex) && sha.startsWith(hex)) return true
  }
  return false
}

// An origin-like line (fix manifest R28): `origin` in any case, after any indent and an optional
// list marker, then a colon, read through fold. The same test as loop-state.mjs's (not exported).
const ORIGIN_LIKE = /^\s*(?:[-*+]\s*)?origin\s*:/i

// What decides an item's behaviour beyond its itemDigest (fix round 2, R29a), as
// [[reason, value]]: the values of its blocked-by:, decided: and no-change-ok: lines and every
// origin-like line of its block as written (a malformed `Origin:` included). Two copies of one
// item moved halfway agree on each; what a move itself rewrites (status:, class:, a recovery:
// line, the header form) is left out.
function identity(item) {
  const values = label => item.fields.filter(f => f.label === label).map(f => f.value)
  return [
    ['blocked-by-differs', values('blocked-by')],
    ['origin-differs', item.lines.filter(l => ORIGIN_LIKE.test(fold(l)))],
    ['decided-differs', values('decided')],
    ['no-change-ok-differs', values('no-change-ok')],
  ]
}

// The reasons two copies of one id are not one item moved halfway: digest-differs (title,
// notes or decision), then each identity field on which they differ.
function differences(a, b) {
  const ib = new Map(identity(b))
  return [
    ...(itemDigest(a) === itemDigest(b) ? [] : ['digest-differs']),
    ...identity(a).filter(([why, v]) => JSON.stringify(v) !== JSON.stringify(ib.get(why))).map(([why]) => why),
  ]
}

// clear-now and now-conflict (R20, R29, R29a): {clear, conflict}, at most one of them set, both
// null when the ## Now item has no valid id or no other block carries it. Every carrier counts:
// the parsed items with the id (a second one in ## Now included) and the raw id lines
// idCarriers reports. clear-now needs ## Now to hold this one block and exactly one other
// carrier, parsed, that is the same item: the same itemDigest and the same identity (blocked-by:,
// origin-like lines, decided:, no-change-ok:); anything else is a conflict, with its reasons.
function interruptedMove(text, state, item) {
  if (item === null || item.id === null) return { clear: null, conflict: null }
  const { parsed, raw } = idCarriers(state, item.id)
  const carriers = [
    ...parsed.filter(i => i !== item).map(i => ({ section: i.section, line: i.line, digest: itemDigest(i), raw: false, item: i })),
    ...raw.map(r => ({ section: r.section, line: r.line, digest: null, raw: true, item: null })),
  ].sort((a, b) => a.line - b.line)
  if (!carriers.length) return { clear: null, conflict: null }
  const nowItems = state.items.filter(i => i.section === 'Now').length
    + state.problems.filter(p => p.kind === 'unparsed-line' && p.section === 'Now').length
  const digest = itemDigest(item)
  const reasons = []
  if (nowItems > 1) reasons.push('several-now-items')
  if (carriers.length > 1) reasons.push('several-carriers')
  if (raw.length) reasons.push('raw-carrier')
  if (carriers.length === 1 && !raw.length) reasons.push(...differences(item, carriers[0].item))
  if (!reasons.length) return { clear: { id: item.id, section: carriers[0].section, ...planDeleteBlock(text, 'Now', item.start, item.end) }, conflict: null }
  return {
    clear: null,
    conflict: {
      id: item.id, reasons, now: { line: item.line, digest }, now_items: nowItems,
      carriers: carriers.map(({ section, line, digest: d, raw: r }) => ({ section, line, digest: d, raw: r })),
    },
  }
}

const CONFLICT_WHY = {
  'several-now-items': '## Now holds another block too, which clearing would lose',
  'several-carriers': 'several other blocks carry the id',
  'raw-carrier': 'a block holds the id on a line that does not parse to it',
  'digest-differs': 'the copies differ (title, notes or decision): one was edited after the interruption',
  'blocked-by-differs': 'the copies\' blocked-by: lines differ: one was edited after the interruption',
  'origin-differs': 'the copies\' origin lines differ: one was edited after the interruption',
  'decided-differs': 'the copies\' decided: lines differ: one was edited after the interruption',
  'no-change-ok-differs': 'the copies\' no-change-ok: lines differ: one was edited after the interruption',
}

// ---------------------------------------------------------------- run records and bundles

// Every recovery-bundle sha a record anchors: its saves, its reset, its recovery's bundles
// and reset.
function anchoredShas(rec) {
  const r = rec.recovery
  return unique([...rec.saves.map(s => s.sha), rec.reset_sha, ...(r ? [...r.bundles, r.reset_sha] : [])].filter(s => s !== null))
}

function tampered(file, why) {
  return fail(`tampered: ${file} (${why})`)
}

// The anchored file <V>/patches/<sha>.patch must be a regular file (never followed through a
// symlink) whose SHA-256 is sha. Hashed a chunk at a time (a bundle may be up to 512 MiB); a
// fifo never blocks the open.
function checkPatch(paths, sha) {
  const dir = path.join(paths.V, 'patches')
  const file = path.join(dir, `${sha}.patch`)
  const dst = lstatOrNull(dir)
  if (!dst) throw tampered(file, 'missing')
  if (!dst.isDirectory()) throw tampered(file, `${dir} is ${kindOf(dst)}, not a directory`)
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (e.code === 'ENOENT') throw tampered(file, 'missing')
    if (e.code === 'ELOOP' || e.code === 'EMLINK') throw tampered(file, 'a symlink')
    throw e
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw tampered(file, 'not a regular file')
    const buf = Buffer.alloc(1024 * 1024)
    const hash = crypto.createHash('sha256')
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
      pos += n
    }
    const got = hash.digest('hex')
    if (got !== sha) throw tampered(file, `sha256 ${got}`)
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------- the clone

// git lock files under <W>/.git that a killed git leaves: the fixed names and refs/**/*.lock
// (symlinks never followed).
function gitLocks(W) {
  const gitDir = path.join(W, '.git')
  const st = lstatOrNull(gitDir)
  if (!st || !st.isDirectory()) return []
  const out = GIT_LOCKS.filter(name => lstatOrNull(path.join(gitDir, name)) !== null)
  const walk = rel => {
    let entries
    try {
      entries = fs.readdirSync(path.join(gitDir, rel), { withFileTypes: true })
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return
      throw e
    }
    for (const ent of entries) {
      const sub = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(sub)
      else if (ent.name.endsWith('.lock')) out.push(sub)
    }
  }
  walk('refs')
  return out.sort()
}

// -c overrides that empty every configured filter driver, so `status` runs no clean filter.
// run(args, opts) is workGitRun-shaped ({status, stdout, code, error, stderr}).
function filterOverrides(run) {
  const r = run(['config', '-z', '--name-only', '--get-regexp', '^filter[.]'], { buffer: true })
  if (r.code) throw gitError(r, 'config')
  if (r.status === 1) return []
  if (r.status !== 0) throw gitError(r, 'config --get-regexp')
  const names = new Set()
  for (const rec of splitNul(r.stdout)) {
    const k = rec.toString('utf8')
    const last = k.lastIndexOf('.')
    if (last > 'filter.'.length) names.add(k.slice('filter.'.length, last))
  }
  const out = []
  for (const n of [...names].sort()) {
    if (/[=\n\0]/.test(n) || !n.isWellFormed() || n.includes(String.fromCharCode(0xfffd))) {
      throw new Error(`unsafe-config: filter driver ${JSON.stringify(n)} cannot be neutralized`)
    }
    out.push(`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`)
  }
  return out
}

// Read-only git helpers for <W>.
function cloneGit(W) {
  const revParse = spec => {
    const r = workGitRun(W, ['rev-parse', '--verify', '-q', '--end-of-options', spec])
    if (r.code) throw gitError(r, 'rev-parse')
    return r.status === 0 && OID.test(r.stdout.trim()) ? r.stdout.trim() : null
  }
  // a is an ancestor of b (b itself included); a missing object reads as false.
  const isAncestor = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !OID.test(a) || !OID.test(b)) return false
    const r = workGitRun(W, ['merge-base', '--is-ancestor', a, b])
    if (r.code) throw gitError(r, 'merge-base')
    return r.status === 0
  }
  const contained = new Map()
  // Some branch of <W> holds commit c: it landed (a commit-tree whose update-ref never ran did not).
  const landed = c => {
    if (!contained.has(c)) {
      const r = workGitRun(W, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', c, 'refs/heads/'])
      if (r.code) throw gitError(r, 'for-each-ref')
      contained.set(c, r.status === 0 && r.stdout.trim() !== '')
    }
    return contained.get(c)
  }
  const refTips = prefix => {
    const r = workGitRun(W, ['for-each-ref', '--format=%(objectname)', prefix])
    if (r.code || r.status !== 0) throw gitError(r, 'for-each-ref')
    return r.stdout.split('\n').filter(o => OID.test(o))
  }
  return { revParse, isAncestor, landed, refTips }
}

// The clone's facts for the output (`clone`) and for cloneVerdict (`facts`), plus `git`, the
// read-only helpers (null unless the clone is valid).
export function cloneFacts(W) {
  const clone = {
    exists: false, valid: false, problems: [], head: null, branch: null,
    dirty: { staged: false, tracked: false, untracked: [], more: 0 }, locks: [],
  }
  const facts = { exists: false, valid: false, symbolic: false, headRef: null, tip: null, dirty: false, indexDirty: false, isAncestor: () => false }
  const st = lstatOrNull(W)
  if (!st) return { clone, facts, git: null }
  clone.exists = facts.exists = true
  if (!st.isDirectory()) {
    clone.problems = [`${W} is not a directory (${kindOf(st)})`]
    return { clone, facts, git: null }
  }
  clone.locks = gitLocks(W)
  clone.problems = checkClone(W).problems
  if (clone.problems.length) return { clone, facts, git: null }
  clone.valid = facts.valid = true
  const git = cloneGit(W)
  facts.isAncestor = git.isAncestor

  const head = workGitRun(W, ['symbolic-ref', '-q', 'HEAD'])
  if (head.code) throw gitError(head, 'symbolic-ref')
  if (head.status === 0) {
    facts.symbolic = true
    facts.headRef = head.stdout.trim()
    clone.branch = facts.headRef.replace(/^refs\/heads\//, '')
  }
  facts.tip = clone.head = git.revParse('HEAD^{commit}')

  const opts = { buffer: true, config: filterOverrides((args, o) => workGitRun(W, args, o)), env: facts.tip ? { GIT_ATTR_SOURCE: facts.tip } : {} }
  const r = workGitRun(W, ['status', '--porcelain=v1', '-z', '-uall', '--ignore-submodules=dirty'], opts)
  if (r.code || r.status !== 0) throw gitError(r, 'status')
  const s = parseStatus(r.stdout)
  // R29a: a file git calls modified whose raw bytes equal its blob (a CRLF blob committed before
  // `* text eol=lf`) is no leftover; prepare's save would find nothing in it.
  if (s.tracked && !worktreeChanged(W, opts)) s.tracked = false
  clone.dirty = dirtyOf(s)
  facts.dirty = s.tracked || s.count > 0
  facts.indexDirty = s.staged
  return { clone, facts, git }
}

// ---------------------------------------------------------------- the legacy worktree

// safeGit in a repository the owner works in, workGitRun-shaped: never throws for a git that ran.
function safeRun(dir, args, opts) {
  try {
    return { status: 0, stdout: safeGit(dir, args, opts), stderr: '' }
  } catch (e) {
    if (e.code) return { status: null, stdout: '', stderr: e.stderr || '', code: e.code, error: e.message }
    return { status: e.status, stdout: '', stderr: e.stderr || '' }
  }
}

// Facts about the 0c-1 worktree at dir, reported only (ruling R10). A missing directory is
// exists: false. One that is not the top level of its own working tree, or is the project R
// itself, is reported as a `problem` and never asked about (git would answer for <P>). Its
// status runs no filter (every configured driver emptied, attributes from its HEAD) and never
// enters a nested repository (--ignore-submodules=dirty), as the clone's does.
export function legacyFacts(dir, R) {
  const none = { exists: false, staged: false, tracked: false, untracked: [], more: 0, problem: null }
  const problem = why => ({ ...none, exists: true, problem: why })
  let st
  try {
    st = fs.statSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return none
    return problem(`not-a-worktree: ${dir}: ${e.code || e.message}`)
  }
  if (!st.isDirectory()) return problem(`not-a-worktree: ${dir} is not a directory`)
  const real = fs.realpathSync.native(dir)
  if (real === R) return problem(`worktree-is-project: ${dir} is the project ${R} itself`)
  let top
  try {
    top = fs.realpathSync.native(safeGit(real, ['rev-parse', '--show-toplevel']))
  } catch (e) {
    return problem(`not-a-worktree: ${real}: ${firstLine(e.stderr || e.message)}`)
  }
  if (top !== real) return problem(`not-a-worktree: ${real} is inside ${top}`)
  let buf
  try {
    const head = safeRun(real, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
    if (head.code) throw new Error(head.error)
    const tip = head.status === 0 && OID.test(head.stdout.trim()) ? head.stdout.trim() : null
    const opts = { buffer: true, config: filterOverrides((args, o) => safeRun(real, args, o)), env: tip ? { GIT_ATTR_SOURCE: tip } : {} }
    buf = safeGit(real, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--ignore-submodules=dirty'], opts)
  } catch (e) {
    return problem(`unreadable: ${real}: ${firstLine(e.stderr || e.message)}`)
  }
  return { exists: true, ...dirtyOf(parseStatus(buf)), problem: null }
}

// ---------------------------------------------------------------- the plan

function readState(S) {
  const file = path.join(S, 'STATE.md')
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no-state: ${file} is missing`)
    throw e
  }
}

const gens = list => (list.length === 1 ? `generation ${list[0]}` : `generations ${list.join(', ')}`)

// The verdict's note, or null.
function verdictNote(v, rec, clone) {
  const who = rec ? `generation ${rec.generation}` : 'no run record'
  switch (v.verdict) {
    case 'leftovers':
      return `leftovers of ${who} against ${short(v.base)}: the next clone preparation saves them in a recovery bundle, then resets the clone`
    case 'delegate-commit':
      return `${who}: ${clone.branch} holds a delegate commit (${short(v.tip)} on top of ${short(v.base)}): the next clone preparation rewinds it and saves the work; no bundle is written for it`
    case 'rewind':
      return `${who}: an interrupted rewind of ${clone.branch} from ${short(v.from)} to ${short(v.to)}: the next clone preparation repeats it and saves the work; no bundle is written meanwhile`
    case 'resume':
      return `${who} saved its work as ${short(v.sha)} but the clone was not reset: the next clone preparation resets it`
    case 'resume-reset':
      return `${who}: the reset with ${short(v.sha)} was interrupted: the next clone preparation finishes it`
    case 'committed':
      return v.dirty ? `${who}: commit ${short(v.sha)} has uncommitted residue: the next clone preparation saves it` : null
    default:
      return null
  }
}

export function recoverPlan(P, { generation, reclaimed = null, env = process.env } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(`usage: --generation must be a positive integer, got ${generation}`)
  const paths = loopPaths(P, { env })
  const { R, S, W } = paths
  const text = readState(S)
  const now = nowLine(text)
  const nowSha = now === null ? null : sha256Hex(now)
  const notes = []
  // The items, through the one grammar (R4). A carriage return makes parseState refuse the
  // file (crlf): then no item is read, so nothing is cleared or finished.
  const state = parseState(text)
  const crlf = state.problems.some(p => p.kind === 'crlf')
  if (crlf) notes.push('STATE.md holds a carriage return (crlf): its items are not read, so nothing is cleared or finished; convert the file to LF line endings')
  // The ## Now item is the block whose header is the Now line: an unparsed line above an item
  // leaves no item to bind, clear or name (the Now line is requeued as it is).
  const first = state.items.find(i => i.section === 'Now') ?? null
  const item = first !== null && first.header.trim() === now ? first : null
  const { clear, conflict } = interruptedMove(text, state, item)
  if (clear) {
    notes.push(`the ## Now item ${clear.id} is also in ## ${clear.section}: a move was interrupted after its insertion; apply the clear edits, which delete the ## Now copy alone (the ## ${clear.section} copy is the item)`)
  }
  if (conflict) {
    const where = conflict.carriers.map(c => `## ${c.section} line ${c.line}`).join(', ')
    notes.push(`now-conflict: the ## Now item ${conflict.id} (line ${conflict.now.line}) is also carried at ${where}, but ${conflict.reasons.map(r => CONFLICT_WHY[r]).join('; ')}: `
      + 'nothing is cleared; pause and keep both copies until a person resolves them')
  }

  // Governance-side integrity first: no record of this or a later generation, every record
  // readable, every anchored recovery bundle intact.
  const top = maxRecordGeneration(paths)
  if (top >= generation) throw fail(`record-from-the-future: ${recordFile(paths, top)} (generation ${top} >= ${generation})`)
  let records
  try {
    records = listRecords(paths)
  } catch (e) {
    if (e.code === 'ENOTDIR') throw fail(`corrupt: ${path.join(paths.V, 'run')} is not a directory`)
    throw e
  }
  for (const rec of records) for (const sha of anchoredShas(rec)) checkPatch(paths, sha)
  const ledger = ledgerShas(S)

  // The clone, judged for the owner record only: the one prepare acts on.
  const { clone, facts, git } = cloneFacts(W)
  const unresolved = records.filter(rec => !isResolved(rec))
  const owner = ownerRecord(records)
  const v = cloneVerdict(owner, facts)
  if (v.verdict === 'unknown') {
    if (v.why === 'clone-invalid') throw fail(`clone-invalid: ${clone.problems.join('; ')}`, { problems: clone.problems })
    throw fail(`unknown-tip: generation ${owner ? owner.generation : 'none'}: ${v.why} (HEAD ${clone.branch ?? 'detached'} at ${clone.head ?? 'no commit'})`)
  }

  // A record's commit counts once it landed: recorded as committed, or (an intent whose
  // record never said so) held by a branch of the clone.
  const landedCommit = rec => {
    const c = committedSha(rec)
    if (c === null) return null
    if (rec.commit?.sha === c) return c
    return git && git.landed(c) ? c : null
  }

  const rows = [], gensUnledgered = [], commits = [], bundles = []
  const committedBranches = new Set()
  for (const rec of records) {
    const sha = landedCommit(rec)
    if (sha !== null && rec.branch !== null) committedBranches.add(rec.branch)
    const lostCommit = sha !== null && !ledger.commits.has(sha)
    const lostSaves = anchoredShas(rec).filter(s => !ledger.saves.has(s))
    if (lostCommit || lostSaves.length) {
      gensUnledgered.push(rec.generation)
      if (lostCommit) commits.push(sha)
      bundles.push(...lostSaves)
    }
    let verdict
    if (rec === owner) verdict = v.verdict
    else if (isResolved(rec)) verdict = 'resolved'
    else {
      verdict = 'superseded'
      notes.push(`generation ${rec.generation} is superseded by generation ${owner.generation}, which owns the clone`)
    }
    rows.push({ generation: rec.generation, phase: rec.phase, verdict, sha, ledgered: !lostCommit && lostSaves.length === 0 })
  }
  const recovered = gensUnledgered.length
    ? {
      generations: gensUnledgered, commits: unique(commits), bundles: unique(bundles), task: now,
      item_id: item?.id ?? null, item_origin: item?.origin ?? null,
    }
    : null

  if (v.verdict === 'no-clone' && unresolved.length) {
    notes.push(`the clone ${W} is missing: the next clone preparation creates it, and the uncommitted work of ${gens(unresolved.map(r => r.generation))} is lost (clone-missing)`)
  }
  const vnote = verdictNote(v, owner, clone)
  if (vnote) notes.push(vnote)

  // finish-commit binds the Now item to the commit by the recorded Now line hash and, for a v:2
  // record, by the recorded item id and digest too (R20).
  let finish = null
  if (v.verdict === 'committed') {
    const c = v.sha
    const where = `generation ${owner.generation} committed ${short(c)} on ${owner.branch ?? clone.branch}`
    const bound = recordItem(owner)
    const stays = 'requeue the item; the commit stays on the branch'
    let why = null
    if (now === null) why = '## Now is empty, so no item moves'
    else if (clear !== null) why = `## Now holds a copy of ${clear.id} left by an interrupted move: clear ## Now; the commit stays on the branch`
    else if (conflict !== null) why = `## Now holds ${conflict.id}, which conflicts with another copy: nothing moves until a person resolves it; the commit stays on the branch`
    else if (crlf) why = `STATE.md holds a carriage return, so the ## Now item cannot be read: ${stays}`
    else if (owner.now_sha256 !== nowSha) why = `the ## Now line is not the one it recorded: ${stays}`
    else if (owner.v !== 1 && bound.item_id === null) why = `it recorded no item, so the commit cannot be bound to the ## Now item: ${stays}`
    else if (owner.v !== 1 && (item === null || item.id !== bound.item_id)) why = `the ## Now item is not ${bound.item_id}, the item it recorded: ${stays}`
    else if (owner.v !== 1 && itemDigest(item) !== bound.item_digest) {
      why = `the ## Now item ${bound.item_id} changed since it was recorded (its title, notes or decision): ${stays}`
    } else if (doneNames(state, c)) why = '## Done already names it: requeue the item'
    else if (ledger.commits.has(c) || ledger.tips.has(c)) why = 'a ledger row already names it: requeue the item'
    if (why === null) {
      const id = item?.id ?? null
      finish = { generation: owner.generation, sha: c, item_id: id, item_digest: id === null ? null : itemDigest(item) }
      notes.push(`${where} before its bookkeeping: move the ## Now item to ## Done with ${c}`)
    } else notes.push(`${where}, but ${why}`)
  }

  // write-bundle: each branch with a committed record whose delivery bundle is missing or stale.
  const writeBundles = []
  if (git && committedBranches.size) {
    const baseOid = git.revParse(`${BASE_REF}^{commit}`)
    const retired = git.refTips('refs/tech-lead/retired/')
    for (const branch of [...committedBranches].sort()) {
      const ref = `refs/heads/${branch}`
      if (REWINDING.has(v.verdict) && facts.headRef === ref) {
        notes.push(`bundle withheld: ${branch} carries a delegate commit until the next clone preparation rewinds it`)
        continue
      }
      const tip = git.revParse(`${ref}^{commit}`)
      if (tip === null) {
        notes.push(`bundle ${branch}: the branch is missing from the clone`)
        continue
      }
      if (baseOid === null) {
        notes.push(`bundle ${branch}: ${BASE_REF} is missing from the clone; the next clone preparation refreshes it`)
        continue
      }
      if (git.isAncestor(tip, baseOid)) continue // the base holds it: nothing to deliver
      const rt = retired.find(r => !git.isAncestor(r, baseOid) && (git.isAncestor(r, tip) || git.isAncestor(tip, r)))
      if (rt) {
        notes.push(`bundle withheld: ${branch} at ${short(tip)} is comparable with the retired tip ${short(rt)}`)
        continue
      }
      if (!vettedTip({ records, ledger, branch, tip, inBase: false })) {
        notes.push(`bundle withheld: ${branch} at ${short(tip)} is not vetted`)
        continue
      }
      // bundleCurrent reports every condition a rewrite repairs as a reason; what it throws
      // (an unreadable bundle or sidecar, a git failure) is an incident (exit 2).
      let cur
      try {
        cur = bundleCurrent(paths, branch, tip)
      } catch (e) {
        throw fail(`bundle-check: ${branch}: ${firstLine(e.message)}`)
      }
      if (!cur.current) {
        writeBundles.push(branch)
        notes.push(`bundle ${branch} at ${short(tip)} is ${cur.reason}: run loop-clone.mjs bundle for it`)
      }
    }
  }

  if (clone.locks.length) {
    notes.push(`stale git lock files in the clone (${clone.locks.join(', ')}): the next clone preparation removes them after an empty process sweep`)
  }
  const legacy = legacyFacts(path.join(S, 'worktree'), R)
  if (legacy.problem) notes.push(`legacy worktree ${path.join(S, 'worktree')}: ${legacy.problem}`)
  else if (legacy.staged || legacy.tracked || legacy.untracked.length) {
    notes.push(`the legacy worktree ${path.join(S, 'worktree')} holds uncommitted changes; stage 0c-2 never touches it`)
  }

  const leftovers = LEFTOVER_VERDICTS.has(v.verdict) || (v.verdict === 'committed' && v.dirty)
  const due = {
    'clear-now': clear !== null,
    'now-conflict': conflict !== null,
    'finish-commit': finish !== null,
    'requeue-now': now !== null && finish === null && clear === null && conflict === null,
    'ledger-recovered': recovered !== null,
    'write-bundle': writeBundles.length > 0,
    'note-leftovers': leftovers,
  }
  return {
    generation, reclaimed, now, now_sha256: nowSha, clone, records: rows, clear, conflict, finish, recovered,
    write_bundles: writeBundles, legacy: { worktree: legacy }, actions: ACTIONS.filter(a => due[a]), notes,
  }
}

const USAGE = 'usage: loop-recover.mjs <P> --generation <N> [--reclaimed <g>]'
const GENERATION = /^[1-9][0-9]*$/

// Exactly one positional <P>, --generation once, --reclaimed at most once, each a positive
// safe integer, nothing else; null on misuse.
function parseArgs(argv) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const key = a.slice(2)
    if (!a.startsWith('--')) pos.push(a)
    else if (['generation', 'reclaimed'].includes(key) && !(key in opts) && i + 1 < argv.length) opts[key] = argv[++i]
    else return null
  }
  if (pos.length !== 1 || !('generation' in opts)) return null
  for (const key of ['generation', 'reclaimed']) {
    if (!(key in opts)) continue
    if (!GENERATION.test(opts[key]) || !Number.isSafeInteger(Number(opts[key]))) return null
    opts[key] = Number(opts[key])
  }
  return { P: pos[0], generation: opts.generation, reclaimed: opts.reclaimed ?? null }
}

function main(argv) {
  const print = o => process.stdout.write(`${JSON.stringify(o)}\n`)
  const args = parseArgs(argv)
  if (!args) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    print(recoverPlan(args.P, { generation: args.generation, reclaimed: args.reclaimed }))
    return 0
  } catch (e) {
    print({ state: 'error', detail: e.message, ...(e.extra || {}) })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
