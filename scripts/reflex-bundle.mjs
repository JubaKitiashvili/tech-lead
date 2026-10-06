#!/usr/bin/env node
// scripts/reflex-bundle.mjs
// Owner of recovery bundles (stage 0c-2, brief section 11; spec 7.5 as amended by A11; rulings
// R4-R6, R16, R17, R19-R21; stage 0c-3 ruling R18 adds the item fields). A recovery bundle
// holds what the loop's clone <W> has against a base commit (the tracked diff and the untracked
// files listed under recorded ignore rules, in scope or not) as one file the loop can replay. It
// never uses git stash, and a save never writes the real index, HEAD, a ref, refs/stash or the
// work tree.
//
// Bundle file <V>/patches/<sha>.patch, sha = sha256 of the whole file. Line 1 is
//   TECH-LEAD-RECOVERY v1 <canonicalJson(header)>
// and the rest is exactly what `git diff-tree -r -p --binary --full-index --no-renames --no-color
// --no-ext-diff --no-textconv --no-relative -O/dev/null -U3 --src-prefix=a/ --dst-prefix=b/
// --diff-algorithm=myers <base> <tree>` prints (git apply skips the header line). The diff runs
// with no attribute in force (GIT_ATTR_SOURCE = the empty tree, core.attributesFile=/dev/null),
// and with the plumbing config that would otherwise change its bytes pinned to git's defaults
// (diff.suppressBlankEmpty, diff.indentHeuristic, core.bigFileThreshold, the zlib level of binary
// patches), so one change set always gives one sha whatever the owner's or a delegate's config.
// Header: {v:1, why, generation, source:{generation}, base, head, tree, item_digest, item_id,
// rules:{mode, sha}, scope:{state, entries, digest}, files:[{path, kind, old_mode, mode, oid,
// size, binary, in_scope, hidden, obstructed}]}; no timestamps. item_id is an item id (loop-state
// ID_RE) or null, item_digest 64 hex or null, and the two are both set or both null (R18): a save
// with --item records the item it holds work for and that item's itemDigest. rules.sha = sha256
// of the canonical rules object, which is kept next to the bundles as
// <V>/patches/rules-<sha>.json (content-addressed, so a reset after a kill lists untracked files
// under exactly the rules the save used, whatever mode they had).
//
// Library:
//   saveFor(paths, {saver, source, base, rules, why, itemId, itemDigest, also, requireHeadAtBase,
//     env}) -> {state:'saved', ..., item_id, item_digest} | {state:'empty', base, head,
//     indexDirty, scope:{state, entries, digest}, item_id, item_digest}; itemId (an ID_RE id) and
//     itemDigest (64 hex) are given together or not at all (TypeError), and are written as given
//     (the CLI resolves them from STATE.md); refusals throw code REFUSED with `state`
//     (clone-invalid, infra (git-too-old), head-moved (requireHeadAtBase only), index-only,
//     unsavable, too-large, tampered, base-unknown).
//   resetFor(paths, {holder, record, sha, relaxed, also, rules, env}) -> {state:'reset', removed,
//     restored, more}; refusals: no-record, not-anchored, clone-invalid, infra, tampered,
//     base-unknown, head-moved, index-locked, busy, index-only, unsaved; a reset that began and
//     could not finish throws code PARTIAL. A record already resetting with this sha resumes
//     relaxed.
//   resetEmpty(paths, {holder, record, base, also, env}) -> {state:'index-reset', base}.
//   readBundle(paths, sha) -> {sha, file, bytes, header} (the file's sha and header only).
//   verifyBundle(paths, sha) -> the same after the replay checks of `verify`.
//   removeUntracked(W, paths, baseDirs, onEach, guard) -> the paths it unlinked (exported for
//     tests); guard() runs right before each unlink and each rmdir.
// Lock loss (R31): every step that publishes or destroys (the rules sidecar, the bundle link, the
// record writes, the reset's intent, each unlink and rmdir, each read-tree) re-checks the lock
// right before it, and a lost lock propagates as NOT_HOLDER / HOLDER_UNKNOWN, never as partial.
// A publication through a temp (the rules sidecar, the bundle, each record write) also passes
// the check to atomic as its guard, which runs it after the temp's fsync, right before the link
// or rename, so a lock lost during that fsync publishes nothing.
// Every entry needs a git that honours GIT_ATTR_SOURCE (R24): else REFUSED infra git-too-old.
// CLI (one JSON line on stdout; exit 0 ok, 2 {state:'error', detail[, partial]}, 3 refused):
//   save <P> --generation <N> --why <why> [--item <id> [--item-digest <64hex>]]   (refuses
//     head-moved when HEAD is not the record's base: the reset that follows a save needs HEAD
//     there). --item <id> (an ID_RE id; anything else is a usage error) reads <S>/STATE.md with
//     loop-state's parseState before anything is collected: exactly one item, in any section and
//     eligible or not (a save must keep working while a person edits the backlog), carries the
//     id, else exit 3 {state:'bad-item', detail, carriers} with nothing written (no STATE.md, a
//     STATE.md holding a carriage return, no carrier, several, or a carrier whose id line is
//     invalid-id). The header gets item_id and that item's itemDigest; both outputs, an empty
//     save's included, carry item_id and item_digest (the Recovery line writes the digest).
//     --item-digest is accepted only with --item (alone it is a usage error) and must equal the
//     computed digest, else exit 3 {state:'digest-mismatch'} with nothing written.
//   verify <P> --sha <64hex>   (reports item_id and item_digest)
//   reset <P> --generation <N> --sha <64hex>
//   apply <P> --generation <N> --sha <64hex> [--item-digest <64hex>]   (same base only; no 0c-2
//     prose calls it; stage 3 adds spec 7.5's moved-base allowance). It writes the bundle's bytes
//     raw: a two-way read-tree to the bundle tree on a temporary index, with no attribute, eol
//     conversion or filter in force, so the work tree captures as the bundle. The read-tree starts
//     from the work tree's own raw bytes for the paths the bundle changes, and that index is
//     refreshed with the same raw settings, so its up-to-date check never depends on stat timing.
// Not the holder is exit 3 {state:'not-holder', detail}. A clone git-safe refuses mid-command
// (code CLONE_INVALID: a storage path changed after the clone check) is exit 3
// {state:'clone-invalid', detail, problems:[detail]}, as in loop-clone.mjs.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertAttrSource, workGit, workGitRun } from './lib/git-safe.mjs'
import { commitExclusive, tempDir, tempFile } from './lib/atomic.mjs'
import { canonicalJson, sha256Hex } from './lib/canonical.mjs'
import {
  baseRules, captureTree, collect, currentRules, decodePath, encodePath, indexOnly, manifest, openWorkTree, rulesSha,
} from './lib/changes.mjs'
import { committedSha, readRecord, updateRecord } from './lib/run-record.mjs'
import { checkClone } from './lib/clone-check.mjs'
import { markScope } from './lib/loop-scope.mjs'
import { sweepOthers } from './lib/loop-proc.mjs'
import { assertHeld, openPaths } from './loop-lock.mjs'
import { fault } from './lib/fault.mjs'
import { ID_RE, itemDigest as digestOfItem, parseState } from './lib/loop-state.mjs'

const MAGIC = 'TECH-LEAD-RECOVERY v1 '
const SHA = /^[0-9a-f]{64}$/
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const GENERATION = /^[1-9][0-9]*$/
export const WHYS = Object.freeze(['clean-clone', 'delegate-flagged', 'codex', 'attempt-failed', 'pause'])
const KINDS = new Set(['added', 'modified', 'deleted', 'mode-changed', 'type-changed'])
const RULE_MODES = new Set(['recorded', 'current', 'base'])
const SCOPE_STATES = new Set(['ok', 'whole', 'invalid'])
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024 // R16
const LIST_MAX = 50
const HEADER_MAX = 256 * 1024 * 1024
const CHUNK = 1024 * 1024
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants

const DIFF = ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', '--no-color', '--no-ext-diff',
  '--no-textconv', '--no-relative', '-O/dev/null', '-U3', '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers']
// Plumbing config that changes diff-tree's bytes, pinned to git's defaults. core.looseCompression
// sets the zlib level of binary patches whatever core.compression says.
const DIFF_CONFIG = ['core.attributesFile=/dev/null', 'diff.suppressBlankEmpty=false', 'diff.indentHeuristic=true',
  'core.bigFileThreshold=536870912', 'core.looseCompression=1']
const APPLY_CONFIG = ['core.attributesFile=/dev/null', 'apply.whitespace=nowarn', 'apply.ignoreWhitespace=no']

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
const isGeneration = v => Number.isSafeInteger(v) && v > 0
const pathKey = p => (typeof p === 'string' ? `s${p}` : `b${p.b64}`)
const keySet = list => new Set(list.map(pathKey))
const capList = list => ({ shown: list.slice(0, LIST_MAX), more: Math.max(0, list.length - LIST_MAX) })

function refused(state, detail, extra = {}) {
  return Object.assign(new Error(`${state}: ${detail}`), { code: 'REFUSED', state, detail, extra })
}

function partial(detail) {
  return Object.assign(new Error(`partial: ${detail}`), { code: 'PARTIAL', partial: true })
}

// A list of paths in a refusal: at most 50, with how many more there were.
function pathsExtra(list, key = 'paths') {
  const c = capList(list)
  return { [key]: c.shown, more: c.more }
}

// ---------------------------------------------------------------- the clone

// The work tree of paths (changes.openWorkTree's clone layout), refused clone-invalid when
// checkClone finds anything.
function openClone(paths, env) {
  const { problems } = checkClone(paths.W)
  if (problems.length) throw refused('clone-invalid', problems.join('; '), { problems })
  assertAttrSource(paths.W)
  let wt
  try {
    wt = openWorkTree(paths.P, { env })
  } catch (e) {
    if (e.code === 'REFUSED' && e.state === 'layout') throw refused('clone-invalid', e.detail, { problems: [e.detail] })
    throw e
  }
  if (wt.W !== paths.W) throw new Error(`layout: ${wt.W} is not ${paths.W}`)
  return wt
}

// A git run that did not reach an exit, as an error that keeps workGitRun's code, so a clone
// made invalid mid-command (CLONE_INVALID) is refused clone-invalid, never a bare error.
const notRun = r => Object.assign(new Error(r.error), { code: r.code })

function revParse(wt, spec) {
  const r = workGitRun(wt.W, ['rev-parse', '--verify', '-q', '--end-of-options', spec])
  if (r.code) throw notRun(r)
  return r.status === 0 ? r.stdout.trim() : null
}

const EMPTY_TREES = new WeakMap()
function emptyTree(wt) {
  if (!EMPTY_TREES.has(wt)) EMPTY_TREES.set(wt, workGit(wt.W, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim())
  return EMPTY_TREES.get(wt)
}

// No attribute applies: no diff driver, textconv, binary or funcname rule from any .gitattributes.
const neutralEnv = wt => ({ GIT_ATTR_SOURCE: emptyTree(wt), GIT_ATTR_NOSYSTEM: '1' })

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

// diff-tree -z --raw: {path (JSON form), state: '<mode> <oid>' | 'deleted'} per entry.
function rawDiff(wt, a, b) {
  const out = workGit(wt.W, ['diff-tree', '-r', '-z', '--raw', '--no-renames', a, b], { buffer: true })
  const toks = splitNul(out)
  const recs = []
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const [, newMode, , newOid, status] = toks[i].toString('latin1').slice(1).split(' ')
    recs.push({ path: encodePath(toks[i + 1]), state: status[0] === 'D' ? 'deleted' : `${newMode} ${newOid}` })
  }
  return recs
}

// The paths git's content test calls binary for base -> tree, under the save's pinned diff config
// (changes.manifest leaves core.bigFileThreshold to the owner's config, which would make one
// change set's header differ between configs).
function binaryPaths(wt, base, tree) {
  const out = workGit(wt.W, ['diff-tree', '-r', '-z', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', base, tree],
    { buffer: true, config: DIFF_CONFIG, env: neutralEnv(wt) })
  const set = new Set()
  for (const rec of splitNul(out)) {
    const t1 = rec.indexOf(9)
    const t2 = rec.indexOf(9, t1 + 1)
    if (t1 > 0 && t2 > t1 && rec.subarray(0, t1).toString('latin1') === '-') set.add(pathKey(encodePath(rec.subarray(t2 + 1))))
  }
  return set
}

// The directories of a tree, as path keys.
function treeDirs(wt, tree) {
  const out = workGit(wt.W, ['ls-tree', '-r', '-d', '-z', '--name-only', '--full-tree', tree], { buffer: true })
  return new Set(splitNul(out).map(b => pathKey(encodePath(b))))
}

// The oids among list that exist in the clone, without base, deduplicated.
function existing(wt, list, base) {
  const want = [...new Set(list.filter(o => typeof o === 'string' && OID.test(o) && o !== base))]
  if (!want.length) return []
  const got = workGit(wt.W, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: want.join('\n') + '\n' }).split('\n')
  return want.filter((o, i) => got[i] === `${o} commit` || got[i] === `${o} tree`)
}

// Every commit a record knows (R20): staged content found in one of them is not index-only.
function knownCommits(rec) {
  if (!rec) return []
  const r = rec.recovery
  return [rec.commit?.sha, rec.intent?.commit, committedSha(rec), ...(rec.delegate_commits ?? []), r?.rewind?.from, r?.rewind?.to,
    r?.base, rec.base, rec.pre_head]
}

function readLoopMd(paths) {
  try {
    return fs.readFileSync(path.join(paths.S, 'LOOP.md'), 'utf8')
  } catch {
    return null // markScope reads a missing LOOP.md as an invalid scope
  }
}

// markScope over the bundle's paths. A path that is not UTF-8 cannot be named by a scope entry
// and is marked out of scope.
function scopeOf(wt, list, text) {
  const m = markScope(list.filter(p => typeof p === 'string'), text, { root: wt.W })
  const out = new Set(m.outOfScope)
  return { state: m.state, entries: m.entries, digest: m.digest, warnings: m.warnings, isOut: p => typeof p !== 'string' || out.has(p) }
}

// The -c overrides that empty every configured filter driver (as changes.mjs does for saves).
function filterOverrides(wt) {
  const r = workGitRun(wt.W, ['config', '-z', '--name-only', '--get-regexp', '^filter[.]'], { buffer: true })
  if (r.code) throw notRun(r)
  if (r.status === 1) return []
  if (r.status !== 0) throw new Error(`git config --get-regexp failed: ${String(r.stderr).trim()}`)
  const names = new Set()
  for (const rec of splitNul(r.stdout)) {
    const k = rec.toString('utf8')
    const last = k.lastIndexOf('.')
    if (last > 'filter.'.length) names.add(k.slice('filter.'.length, last))
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

// ---------------------------------------------------------------- files

function writeAll(fd, buf) {
  for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off)
}

// One level of regular files, then rmdir (a temporary index directory).
function removeTemp(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = path.join(dir, n)
    try { if (!fs.lstatSync(p).isDirectory()) fs.unlinkSync(p) } catch { /* gone */ }
  }
  try { fs.rmdirSync(dir) } catch { /* left for sweepTemps */ }
}

function withTemp(wt, fn) {
  const dir = tempDir(wt.store)
  try {
    return fn(dir)
  } finally {
    removeTemp(dir)
  }
}

const bundleFile = (store, sha) => path.join(store, `${sha}.patch`)
const rulesFile = (store, sha) => path.join(store, `rules-${sha}.json`)
const storeOf = paths => path.join(paths.V, 'patches')

// sha256 of a file, read a chunk at a time.
function hashFile(file) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW)
  try {
    const h = crypto.createHash('sha256')
    const buf = Buffer.alloc(CHUNK)
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      h.update(buf.subarray(0, n))
      pos += n
    }
    return h.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

// Writes bytes to <store>/<name> through a temp file and link(2): identical bytes already there
// are fine, other bytes are tampering. guard runs right before the link (atomic.commitExclusive).
function commitBytes(store, name, bytes, guard) {
  const { path: tmp, fd } = tempFile(store)
  try {
    writeAll(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    return commitExclusive(tmp, path.join(store, name), { guard })
  } catch (e) {
    if (e.code === 'INTEGRITY') throw refused('tampered', e.message)
    throw e
  }
}

// ---------------------------------------------------------------- header

const isPathJson = p => {
  try {
    decodePath(p)
    return true
  } catch {
    return false
  }
}

// Why h is not a v1 header, or null.
function headerProblem(h) {
  if (!isPlain(h)) return 'the header is not an object'
  if (h.v !== 1) return `v is ${JSON.stringify(h.v)}, not 1`
  if (typeof h.why !== 'string' || !/^[a-z][a-z0-9-]*$/.test(h.why)) return 'why is not a reason'
  if (!isGeneration(h.generation)) return 'generation is not a generation'
  if (!isPlain(h.source) || !(h.source.generation === null || isGeneration(h.source.generation))) return 'source is malformed'
  for (const k of ['base', 'tree']) if (typeof h[k] !== 'string' || !OID.test(h[k])) return `${k} is not an object id`
  if (!(h.head === null || (typeof h.head === 'string' && OID.test(h.head)))) return 'head is not an object id'
  if (!(h.item_digest === null || (typeof h.item_digest === 'string' && SHA.test(h.item_digest)))) return 'item_digest is malformed'
  if (!(h.item_id === null || (typeof h.item_id === 'string' && ID_RE.test(h.item_id)))) return 'item_id is not an item id or null'
  if ((h.item_id === null) !== (h.item_digest === null)) return 'item_id and item_digest are not both set or both null'
  if (!isPlain(h.rules) || !RULE_MODES.has(h.rules.mode) || typeof h.rules.sha !== 'string' || !SHA.test(h.rules.sha)) return 'rules is malformed'
  const s = h.scope
  if (!isPlain(s) || !SCOPE_STATES.has(s.state) || !Array.isArray(s.entries) || !s.entries.every(e => typeof e === 'string')
    || typeof s.digest !== 'string' || !SHA.test(s.digest)) return 'scope is malformed'
  if (!Array.isArray(h.files) || !h.files.length) return 'files is not a non-empty list'
  for (const [i, f] of h.files.entries()) {
    if (!isPlain(f) || !isPathJson(f.path) || !KINDS.has(f.kind)) return `files[${i}] is malformed`
    for (const k of ['binary', 'in_scope', 'hidden', 'obstructed']) if (typeof f[k] !== 'boolean') return `files[${i}].${k} is not a boolean`
    if (f.kind === 'deleted' ? f.mode !== null || f.oid !== null : typeof f.oid !== 'string' || !OID.test(f.oid)) return `files[${i}] has a bad oid`
  }
  return null
}

// The file of bundle sha: its sha checked, its header read. Throws REFUSED tampered.
function readBundleIn(store, sha) {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw refused('tampered', `not a bundle sha: ${JSON.stringify(sha)}`)
  const file = bundleFile(store, sha)
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (e) {
    if (e.code === 'ENOENT') throw refused('tampered', `bundle ${sha} is missing from ${store}`)
    if (e.code === 'ELOOP') throw refused('tampered', `${file} is a symbolic link`)
    throw e
  }
  let head = null
  let bytes = 0
  const h = crypto.createHash('sha256')
  try {
    if (!fs.fstatSync(fd).isFile()) throw refused('tampered', `${file} is not a regular file`)
    const parts = []
    const buf = Buffer.alloc(CHUNK)
    for (let pos = 0; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (!n) break
      const chunk = buf.subarray(0, n)
      h.update(chunk)
      if (head === null) {
        const nl = chunk.indexOf(0x0a)
        parts.push(Buffer.from(nl < 0 ? chunk : chunk.subarray(0, nl)))
        if (nl >= 0) head = Buffer.concat(parts)
        else if (pos + n > HEADER_MAX) throw refused('tampered', `${file} has no header line`)
      }
      pos += n
      bytes = pos
    }
  } finally {
    fs.closeSync(fd)
  }
  if (h.digest('hex') !== sha) throw refused('tampered', `${file} does not hash to its name`)
  if (head === null) throw refused('tampered', `${file} has no header line`)
  const text = head.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(head) || !text.startsWith(MAGIC)) throw refused('tampered', `${file} is not a v1 recovery bundle`)
  let header
  try {
    header = JSON.parse(text.slice(MAGIC.length))
    if (canonicalJson(header) !== text.slice(MAGIC.length)) throw new Error('not canonical')
  } catch (e) {
    throw refused('tampered', `${file}: the header is not canonical JSON (${e.message})`)
  }
  const why = headerProblem(header)
  if (why) throw refused('tampered', `${file}: ${why}`)
  return { sha, file, bytes, header }
}

export function readBundle(paths, sha) {
  return readBundleIn(storeOf(paths), sha)
}

// Applies the bundle file to a temporary index of base; returns the tree, or throws code APPLY.
function replayTree(wt, base, file) {
  return withTemp(wt, dir => {
    const idx = path.join(dir, 'replay')
    workGit(wt.W, ['read-tree', base], { indexFile: idx })
    const r = workGitRun(wt.W, ['apply', '--cached', '--binary', '--whitespace=nowarn', file],
      { indexFile: idx, config: APPLY_CONFIG, env: neutralEnv(wt) })
    if (r.code) throw notRun(r)
    if (r.status !== 0) throw Object.assign(new Error(`git apply --cached: ${String(r.stderr).trim()}`), { code: 'APPLY' })
    return workGit(wt.W, ['write-tree'], { indexFile: idx }).trim()
  })
}

// verify: the sha, magic and header, the base, the replay onto it and the paths it changes.
function verifyIn(wt, sha) {
  const b = readBundleIn(wt.store, sha)
  const h = b.header
  if (revParse(wt, `${h.base}^{commit}`) !== h.base) throw refused('base-unknown', `base ${h.base} of bundle ${sha} is not in the clone`)
  let tree
  try {
    tree = replayTree(wt, h.base, b.file)
  } catch (e) {
    if (e.code === 'APPLY') throw refused('tampered', `bundle ${sha} does not apply to its base: ${e.message}`)
    throw e
  }
  if (tree !== h.tree) throw refused('tampered', `bundle ${sha} replays to ${tree}, not ${h.tree}`)
  const names = splitNul(workGit(wt.W, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', h.base, h.tree], { buffer: true }))
  const listed = h.files.map(f => decodePath(f.path))
  if (names.length !== listed.length || names.some((n, i) => !n.equals(listed[i]))) {
    throw refused('tampered', `bundle ${sha} lists other paths than its diff changes`)
  }
  return b
}

export function verifyBundle(paths, sha, { env = process.env } = {}) {
  return verifyIn(openClone(paths, env), sha)
}

// The rules object a header names: the stored copy, else the record's own rules, else the base
// rules recomputed (mode base), each only when its sha matches.
function rulesFor(wt, header, rec, given) {
  const want = header.rules.sha
  const candidates = []
  if (given) candidates.push(() => given)
  candidates.push(() => {
    let text
    try {
      text = fs.readFileSync(rulesFile(wt.store, want), 'utf8')
    } catch {
      return null
    }
    return JSON.parse(text)
  })
  if (rec?.rules) candidates.push(() => rec.rules)
  if (header.rules.mode === 'base') candidates.push(() => baseRules(wt, header.base))
  for (const get of candidates) {
    let r
    try {
      r = get()
    } catch {
      continue
    }
    if (r && rulesSha(r) === want) return r
  }
  throw refused('tampered', `the ignore rules ${want} of the bundle are not on record`)
}

function maxBytes(env) {
  const v = env.TECH_LEAD_BUNDLE_MAX_BYTES
  return typeof v === 'string' && GENERATION.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : DEFAULT_MAX_BYTES
}

// ---------------------------------------------------------------- save

export function saveFor(paths, { saver, source = null, base, rules, why, itemId = null, itemDigest = null, also = [], requireHeadAtBase = false, env = process.env } = {}) {
  if (!isGeneration(saver)) throw new TypeError(`saveFor: saver must be a generation, got ${saver}`)
  if (!(source === null || isGeneration(source))) throw new TypeError(`saveFor: source must be a generation or null, got ${source}`)
  if (!WHYS.includes(why)) throw new TypeError(`saveFor: why must be one of ${WHYS.join(', ')}`)
  if (!(itemDigest === null || (typeof itemDigest === 'string' && SHA.test(itemDigest)))) throw new TypeError('saveFor: itemDigest must be 64 hex or null')
  if (!(itemId === null || (typeof itemId === 'string' && ID_RE.test(itemId)))) throw new TypeError('saveFor: itemId must be an item id or null')
  if ((itemId === null) !== (itemDigest === null)) throw new TypeError('saveFor: itemId and itemDigest go together')
  if (!isPlain(rules)) throw new TypeError('saveFor: rules must be a rules object')
  assertHeld(paths, saver, env)
  const wt = openClone(paths, env)
  if (requireHeadAtBase) {
    const want = revParse(wt, `${base}^{commit}`)
    const head = revParse(wt, 'HEAD')
    if (want && head !== want) throw refused('head-moved', `HEAD is ${head}, not the base ${want}`, { head, base: want })
  }
  const c = collect(wt, { base, rules, also: existing(wt, also, null) })
  if (c.indexOnly.length) throw refused('index-only', `staged content found nowhere else: ${c.indexOnly.length} path(s)`, pathsExtra(c.indexOnly))
  if (c.unsavable.length) throw refused('unsavable', `${c.unsavable.length} path(s) cannot be saved`, pathsExtra(c.unsavable))
  const changed = [...new Map([...c.tracked, ...c.untracked].map(p => [pathKey(p), p])).values()]
  // An empty save carries the scope it was judged under, so the caller can write its entry.
  const empty = () => {
    const sc = scopeOf(wt, [], readLoopMd(paths))
    return {
      state: 'empty', base: c.base, head: c.head, indexDirty: c.indexDirty, scope: { state: sc.state, entries: sc.entries, digest: sc.digest },
      item_id: itemId, item_digest: itemDigest,
    }
  }
  if (!changed.length) return empty()
  let tree
  try {
    tree = captureTree(wt, { base: c.base, paths: changed }).tree
  } catch (e) {
    if (e.code === 'UNSAVABLE') throw refused('unsavable', e.message, pathsExtra([{ path: e.path, reason: e.reason }]))
    throw e
  }
  // Raw bytes equal to the base everywhere (an eol-only difference git's view reports): nothing to save.
  if (tree === revParse(wt, `${c.base}^{tree}`)) return empty()
  const entries = manifest(wt, c.base, tree)
  const links = entries.filter(f => f.mode === '160000' || f.old_mode === '160000')
  if (links.length) throw refused('unsavable', 'a gitlink changed', pathsExtra(links.map(f => ({ path: f.path, reason: 'gitlink' }))))
  const scope = scopeOf(wt, entries.map(f => f.path), readLoopMd(paths))
  const hidden = keySet(c.hidden)
  const obstructed = keySet(c.obstructed)
  const binary = binaryPaths(wt, c.base, tree)
  const files = entries.map(f => ({
    ...f, binary: binary.has(pathKey(f.path)), in_scope: !scope.isOut(f.path), hidden: hidden.has(pathKey(f.path)), obstructed: obstructed.has(pathKey(f.path)),
  }))
  const rsha = rulesSha(rules)
  const header = {
    v: 1, why, generation: saver, source: { generation: source }, base: c.base, head: c.head, tree,
    item_digest: itemDigest, item_id: itemId, rules: { mode: rules.mode, sha: rsha },
    scope: { state: scope.state, entries: scope.entries, digest: scope.digest }, files,
  }
  const { path: tmp, fd } = tempFile(wt.store, '.patch')
  let linked = false
  try {
    try {
      writeAll(fd, Buffer.from(`${MAGIC}${canonicalJson(header)}\n`, 'utf8'))
      workGit(wt.W, [...DIFF, c.base, tree], { outFd: fd, config: DIFF_CONFIG, env: neutralEnv(wt) })
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fault('save:after-write')
    const bytes = fs.statSync(tmp).size
    const max = maxBytes(env)
    if (bytes > max) {
      const big = files.filter(f => f.size !== null).sort((a, b) => b.size - a.size)[0] ?? null
      throw refused('too-large', `the bundle is ${bytes} bytes, over the cap of ${max}`, { bytes, max, largest: big && { path: big.path, size: big.size } })
    }
    let replayed
    try {
      replayed = replayTree(wt, c.base, tmp)
    } catch (e) {
      if (e.code === 'APPLY') throw new Error(`apply-check: ${e.message}`)
      throw e
    }
    if (replayed !== tree) throw new Error(`apply-check: the bundle replays to ${replayed}, not the captured tree ${tree}`)
    fault('save:after-check')
    const sha = hashFile(tmp)
    const held = () => assertHeld(paths, saver, env)
    held()
    commitBytes(wt.store, `rules-${rsha}.json`, Buffer.from(canonicalJson(rules), 'utf8'), held)
    const file = bundleFile(wt.store, sha)
    let created
    held()
    try {
      ({ created } = commitExclusive(tmp, file, { guard: held }))
    } catch (e) {
      if (e.code === 'INTEGRITY') throw refused('tampered', e.message)
      throw e
    }
    linked = true
    fault('save:after-link')
    const all = files.map(f => f.path)
    const out = files.filter(f => !f.in_scope).map(f => f.path)
    const hid = files.filter(f => f.hidden).map(f => f.path)
    const shown = capList(all)
    return {
      state: 'saved', sha, file, base: c.base, head: c.head, tree, item_id: itemId, item_digest: itemDigest,
      scope: header.scope, files: files.length, out_of_scope: out.slice(0, LIST_MAX), hidden: hid.slice(0, LIST_MAX),
      paths: shown.shown, more: shown.more, counts: { files: files.length, out_of_scope: out.length, hidden: hid.length },
      bytes, reused: !created, warnings: scope.warnings,
    }
  } finally {
    if (!linked) fs.rmSync(tmp, { force: true })
  }
}

// ---------------------------------------------------------------- reset

// Unlinks each listed untracked path that is a regular file or a symlink, reached through real
// directories only (no symlinked ancestor) and with its real parent inside realpath(W); then
// removes, deepest first, the emptied directories that are not directories of the base.
export function removeUntracked(W, list, baseDirs = new Set(), onEach = () => {}, guard = () => {}) {
  const realW = fs.realpathSync.native(W, { encoding: 'buffer' })
  const root = Buffer.from(W + '/')
  const removed = []
  const dirs = new Map()
  for (const p of list) {
    const rel = decodePath(p)
    const parts = []
    let start = 0
    for (let i = 0; i <= rel.length; i++) {
      if (i === rel.length || rel[i] === 0x2f) {
        parts.push(rel.subarray(start, i))
        start = i + 1
      }
    }
    if (parts.some(x => !x.length || x.equals(Buffer.from('.')) || x.equals(Buffer.from('..')) || x.toString('latin1').toLowerCase() === '.git')) continue
    let ok = true
    let cur = Buffer.alloc(0)
    const ancestors = []
    for (let i = 0; i < parts.length - 1 && ok; i++) {
      cur = cur.length ? Buffer.concat([cur, Buffer.from('/'), parts[i]]) : Buffer.from(parts[i])
      try {
        ok = fs.lstatSync(Buffer.concat([root, cur])).isDirectory()
      } catch {
        ok = false
      }
      ancestors.push(cur)
    }
    if (!ok) continue
    const abs = Buffer.concat([root, rel])
    const parent = ancestors.length ? Buffer.concat([root, ancestors[ancestors.length - 1]]) : Buffer.from(W)
    let real
    try {
      real = fs.realpathSync.native(parent, { encoding: 'buffer' })
    } catch {
      continue
    }
    const inside = real.equals(realW) || (real.length > realW.length && real[realW.length] === 0x2f && real.subarray(0, realW.length).equals(realW))
    if (!inside) continue
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue
    guard(p)
    fs.unlinkSync(abs)
    removed.push(p)
    for (const a of ancestors) dirs.set(a.toString('latin1'), a)
    onEach(p)
  }
  const order = [...dirs.values()].filter(d => !baseDirs.has(pathKey(encodePath(d)))).sort((a, b) => b.length - a.length)
  for (const d of order) {
    const abs = Buffer.concat([root, d])
    guard(encodePath(d))
    try {
      if (fs.lstatSync(abs).isDirectory()) fs.rmdirSync(abs)
    } catch { /* not empty (an ignored file stays), or gone */ }
  }
  return removed
}

// The changed paths whose current raw state is neither the bundle's nor the base's. relaxed: a
// path the bundle lists may be in any state (a reset killed mid-write leaves one half-written).
function unsavedPaths(wt, header, c, relaxed) {
  const listed = new Map(header.files.map(f => [pathKey(f.path), f.kind === 'deleted' ? 'deleted' : `${f.mode} ${f.oid}`]))
  const changed = [...new Map([...c.tracked, ...c.untracked].map(p => [pathKey(p), p])).values()]
  const unsavable = keySet(c.unsavable.map(u => u.path))
  const out = []
  const capture = []
  for (const p of changed) {
    const k = pathKey(p)
    if (relaxed && listed.has(k)) continue
    if (unsavable.has(k)) out.push(p)
    else capture.push(p)
  }
  if (!capture.length) return out
  let tree
  try {
    tree = captureTree(wt, { base: header.base, paths: capture }).tree
  } catch (e) {
    if (e.code !== 'UNSAVABLE') throw e
    return [...out, ...capture]
  }
  const now = new Map(rawDiff(wt, header.base, tree).map(r => [pathKey(r.path), r.state]))
  for (const p of capture) {
    const k = pathKey(p)
    if (!now.has(k)) continue // equal to the base
    if (now.get(k) !== (listed.get(k) ?? null)) out.push(p)
  }
  return out
}

// Does the real index need resetting to base? It differs from base, or an entry carries a flag
// (skip-worktree, assume-unchanged, a conflict stage) that would keep a file from being restored.
function indexNeedsReset(wt, base) {
  const d = workGitRun(wt.W, ['diff-index', '--cached', '--quiet', '--ignore-submodules=dirty', base])
  if (d.code) throw notRun(d)
  if (d.status !== 0) return true
  const tags = workGit(wt.W, ['ls-files', '-v', '-z'], { buffer: true })
  return splitNul(tags).some(rec => rec.length && rec[0] !== 0x48) // 'H': a plain cached entry
}

function recordIntent(paths, g, holder, sha, base, guard) {
  updateRecord(paths, g, r => (g === holder
    ? { ...r, phase: 'resetting', reset_sha: sha }
    : { ...r, recovery: { ...(r.recovery ?? {}), by: holder, base: r.recovery?.base ?? base, step: 'resetting', reset_sha: sha, note: null } }), { guard })
}

function recordDone(paths, g, holder, guard) {
  updateRecord(paths, g, r => (g === holder ? { ...r, phase: 'clean' } : { ...r, recovery: { ...r.recovery, by: holder, step: 'done' } }), { guard })
}

const isClean = c => !c.tracked.length && !c.untracked.length && !c.indexDirty && !c.indexOnly.length

export function resetFor(paths, { holder, record, sha, relaxed = false, also = null, rules = null, env = process.env } = {}) {
  if (!isGeneration(holder)) throw new TypeError(`resetFor: holder must be a generation, got ${holder}`)
  const g = isGeneration(record) ? record : record?.generation
  if (!isGeneration(g)) throw new TypeError('resetFor: record must be a record or its generation')
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new TypeError('resetFor: sha must be 64 hex')
  assertHeld(paths, holder, env)
  if (g > holder) throw new Error(`record-from-the-future: generation ${holder} cannot write the record of ${g}`)
  const rec = readRecord(paths, g)
  if (!rec) throw refused('no-record', `generation ${g} has no run record`)
  const anchored = rec.saves.some(s => s.sha === sha) || (rec.recovery?.bundles ?? []).includes(sha)
  if (!anchored) throw refused('not-anchored', `bundle ${sha} is not recorded in the run record of generation ${g}`)
  const wt = openClone(paths, env)
  const b = verifyIn(wt, sha)
  const h = b.header
  const head = revParse(wt, 'HEAD')
  if (head !== h.base) throw refused('head-moved', `HEAD is ${head}, the bundle's base is ${h.base}`, { head, base: h.base })
  if (fs.existsSync(path.join(wt.W, '.git', 'index.lock'))) throw refused('index-locked', `${wt.W}/.git/index.lock exists`)
  const sw = sweepOthers([wt.W])
  if (sw.state !== 'ok') throw refused('busy', `the sweep for processes in ${wt.W} could not run: ${sw.detail}`, { procs: [] })
  if (sw.procs.length) throw refused('busy', `${sw.procs.length} process(es) run in ${wt.W}`, { procs: sw.procs })
  const ruleSet = rulesFor(wt, h, rec, rules)
  const alsoList = existing(wt, also ?? knownCommits(rec), h.base)
  const resuming = g === holder ? rec.phase === 'resetting' && rec.reset_sha === sha
    : rec.recovery?.step === 'resetting' && rec.recovery?.reset_sha === sha
  const c = collect(wt, { base: h.base, rules: ruleSet, also: alsoList })
  if (c.indexOnly.length) throw refused('index-only', `staged content found nowhere else: ${c.indexOnly.length} path(s)`, pathsExtra(c.indexOnly))
  const unsaved = unsavedPaths(wt, h, c, relaxed || resuming)
  if (unsaved.length) throw refused('unsaved', `${unsaved.length} path(s) changed since the bundle was saved`, pathsExtra(unsaved))
  fault('reset:after-check')
  // The checkout writes what R29's comparison expects: attributes from the base, no filter.
  const restoreOpts = { config: filterOverrides(wt), env: { GIT_ATTR_SOURCE: h.base } }
  const held = () => assertHeld(paths, holder, env)
  held()
  recordIntent(paths, g, holder, sha, h.base, held)
  fault('reset:after-intent')
  const restore = () => {
    held()
    workGit(wt.W, ['read-tree', '--reset', '-u', '--no-recurse-submodules', h.base], restoreOpts)
  }
  let removed
  try {
    if (indexNeedsReset(wt, h.base)) {
      held()
      workGit(wt.W, ['read-tree', h.base])
    }
    removed = removeUntracked(wt.W, c.untracked, treeDirs(wt, h.base), () => fault('reset:after-unlink-one'), held)
    restore()
    fault('reset:after-read-tree')
    let after = collect(wt, { base: h.base, rules: ruleSet, also: alsoList })
    if (!isClean(after) && !after.indexOnly.length) {
      // An index entry whose stat data matched a changed file kept it from being restored:
      // rebuild the index from the base and restore every file once more.
      held()
      workGit(wt.W, ['read-tree', h.base])
      restore()
      after = collect(wt, { base: h.base, rules: ruleSet, also: alsoList })
    }
    if (!isClean(after)) {
      const left = [...after.tracked, ...after.untracked]
      throw partial(`the clone is not clean after the reset: ${left.slice(0, 5).map(p => JSON.stringify(p)).join(', ')}${after.indexDirty ? ' (index differs from the base)' : ''}`)
    }
  } catch (e) {
    if (e.code === 'PARTIAL' || e.code === 'NOT_HOLDER' || e.code === 'HOLDER_UNKNOWN') throw e
    throw partial(e.message)
  }
  held()
  recordDone(paths, g, holder, held)
  fault('reset:after-record')
  const rm = capList(removed)
  const rs = capList(c.tracked)
  return { state: 'reset', sha, base: h.base, removed: rm.shown, restored: rs.shown, more: rm.more + rs.more }
}

// For an empty save whose index is dirty: the index alone is set to base.
export function resetEmpty(paths, { holder, record = null, base, also = null, env = process.env } = {}) {
  if (!isGeneration(holder)) throw new TypeError(`resetEmpty: holder must be a generation, got ${holder}`)
  assertHeld(paths, holder, env)
  const wt = openClone(paths, env)
  const baseOid = revParse(wt, `${base}^{commit}`)
  if (!baseOid) throw refused('base-unknown', `${base} is not a commit in the clone`)
  const head = revParse(wt, 'HEAD')
  if (head !== baseOid) throw refused('head-moved', `HEAD is ${head}, not ${baseOid}`, { head, base: baseOid })
  if (fs.existsSync(path.join(wt.W, '.git', 'index.lock'))) throw refused('index-locked', `${wt.W}/.git/index.lock exists`)
  const g = isGeneration(record) ? record : record?.generation
  const rec = isGeneration(g) ? readRecord(paths, g) : null
  const io = indexOnly(wt, { base: baseOid, also: existing(wt, also ?? knownCommits(rec), baseOid) })
  if (io.length) throw refused('index-only', `staged content found nowhere else: ${io.length} path(s)`, pathsExtra(io))
  assertHeld(paths, holder, env)
  workGit(wt.W, ['read-tree', baseOid])
  const d = workGitRun(wt.W, ['diff-index', '--cached', '--quiet', '--ignore-submodules=dirty', baseOid])
  if (d.code || d.status !== 0) throw partial('the index differs from the base after read-tree')
  return { state: 'index-reset', base: baseOid }
}

// ---------------------------------------------------------------- apply

// The untracked paths a two-way read-tree from the base to the bundle tree would overwrite or
// delete. The clone is clean at the base, so any such path is ignored, and read-tree (git 2.35
// and later) removes ignored files in its way: an ignored file at a path the bundle writes, at a
// leading directory of one, or inside a directory the bundle replaces with a file.
function applyObstacles(wt, h) {
  const tracked = new Set(splitNul(workGit(wt.W, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', h.base], { buffer: true })).map(b => b.toString('latin1')))
  const root = Buffer.from(wt.W + '/')
  const lst = rel => {
    try { return fs.lstatSync(Buffer.concat([root, rel])) } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
      throw e
    }
  }
  const out = new Map()
  const add = rel => out.set(rel.toString('latin1'), rel)
  // Every non-directory below dir that the base does not track (a nested repository whole).
  const walk = rel => {
    let entries
    try { entries = fs.readdirSync(Buffer.concat([root, rel]), { withFileTypes: true, encoding: 'buffer' }) } catch { add(rel); return }
    for (const e of entries) {
      const r = Buffer.concat([rel, Buffer.from('/'), e.name])
      if (e.name.toString('latin1').toLowerCase() === '.git') { add(rel); continue }
      if (e.isDirectory()) walk(r)
      else if (!tracked.has(r.toString('latin1'))) add(r)
    }
  }
  for (const f of h.files) {
    if (f.kind === 'deleted') continue
    const rel = decodePath(f.path)
    for (let i = rel.indexOf(0x2f); i >= 0; i = rel.indexOf(0x2f, i + 1)) {
      const anc = rel.subarray(0, i)
      const st = lst(anc)
      if (!st || st.isDirectory()) continue
      if (!tracked.has(anc.toString('latin1'))) add(anc)
      break
    }
    const st = lst(rel)
    if (!st) continue
    if (st.isDirectory()) walk(rel)
    else if (!tracked.has(rel.toString('latin1'))) add(rel)
  }
  return [...out.values()].sort(Buffer.compare).map(encodePath)
}

function applyBundle(paths, generation, sha, itemDigest, env) {
  assertHeld(paths, generation, env)
  const wt = openClone(paths, env)
  const b = verifyIn(wt, sha)
  const h = b.header
  const out = h.files.filter(f => !f.in_scope).map(f => f.path)
  if (out.length) throw refused('out-of-scope', `${out.length} path(s) of the bundle are out of scope`, pathsExtra(out))
  const now = markScope([], readLoopMd(paths), { root: wt.W })
  if (now.digest !== h.scope.digest || now.state !== h.scope.state) {
    throw refused('scope-changed', `the scope is ${now.state} ${now.digest}, the bundle was saved under ${h.scope.state} ${h.scope.digest}`)
  }
  if ((itemDigest ?? null) !== h.item_digest) throw refused('digest-mismatch', `item digest ${itemDigest ?? 'none'}, the bundle has ${h.item_digest ?? 'none'}`)
  const head = revParse(wt, 'HEAD')
  if (head !== h.base) throw refused('moved-base', `HEAD is ${head}, the bundle's base is ${h.base}`, { head, base: h.base })
  if (fs.existsSync(path.join(wt.W, '.git', 'index.lock'))) throw refused('dirty', `${wt.W}/.git/index.lock exists`, { paths: [] })
  const rec = readRecord(paths, generation)
  const rules = rec?.rules ?? currentRules(wt, { base: head })
  const c = collect(wt, { base: head, rules, also: [] })
  if (!isClean(c)) throw refused('dirty', 'the clone is not clean at the base', pathsExtra([...c.tracked, ...c.untracked]))
  const obstacles = applyObstacles(wt, h)
  if (obstacles.length) throw refused('dirty', `${obstacles.length} ignored path(s) stand where the bundle writes`, pathsExtra(obstacles))
  const filters = filterOverrides(wt)
  // The bytes are written raw (data-safety#4): no attribute (the empty tree), no eol conversion,
  // no filter. Git's checkout conversion would otherwise rewrite them (core.autocrlf, a base
  // .gitattributes with text eol=crlf), and the work tree would never capture as the bundle.
  const writeOpts = {
    config: ['core.attributesFile=/dev/null', 'core.autocrlf=false', 'core.eol=lf', ...filters],
    env: neutralEnv(wt),
  }
  // The tree the two-way read-tree starts from: the base, with each base path the bundle changes
  // set to its raw bytes in the work tree (the clean check passed, so those are the blob's bytes
  // or what the base's checkout wrote, CRLF under eol=crlf, say). Its index is refreshed with the
  // read-tree's own raw settings, so the refresh and the read-tree's up-to-date check agree
  // whether git trusts an entry's stat data or reads its content (an entry racily clean against
  // the index, when the reset and the apply fall in the same second): never a timing-dependent
  // 'not uptodate'. Paths the bundle leaves alone are kept as they are and never checked.
  let from
  try {
    const baseSide = h.files.filter(f => f.kind !== 'added').map(f => f.path)
    from = baseSide.length ? captureTree(wt, { base: h.base, paths: baseSide }).tree : `${h.base}^{tree}`
  } catch (e) {
    if (e.code === 'UNSAVABLE') throw refused('dirty', `the clone cannot be read where the bundle writes: ${e.message}`, pathsExtra([e.path]))
    throw e
  }
  withTemp(wt, dir => {
    const idx = path.join(dir, 'apply')
    workGit(wt.W, ['read-tree', from], { indexFile: idx })
    workGit(wt.W, ['update-index', '-q', '--ignore-submodules', '--refresh'], { ...writeOpts, indexFile: idx })
    assertHeld(paths, generation, env)
    const r = workGitRun(wt.W, ['read-tree', '-m', '-u', '--no-recurse-submodules', from, h.tree], { ...writeOpts, indexFile: idx })
    if (r.code || r.status !== 0) {
      const detail = r.error || String(r.stderr).trim()
      // read-tree checks every entry before it writes one: a refusal that left the clone clean
      // changed nothing.
      const again = collect(wt, { base: head, rules, also: [] })
      if (isClean(again)) throw refused('dirty', `read-tree refused: ${detail}`, { paths: [] })
      throw partial(`read-tree -m -u: ${detail}`)
    }
  })
  let tree
  try {
    tree = captureTree(wt, { base: h.base, paths: h.files.map(f => f.path) }).tree
  } catch (e) {
    throw partial(`the applied work tree cannot be captured: ${e.message}`)
  }
  if (tree !== h.tree) throw partial(`the applied work tree captures as ${tree}, not the bundle's ${h.tree}`)
  return { state: 'applied', sha, base: h.base, tree, files: h.files.length }
}

// ---------------------------------------------------------------- CLI

const USAGE = 'usage: reflex-bundle.mjs save <P> --generation <N> --why <why> [--item <id> [--item-digest <64hex>]] | verify <P> --sha <64hex> | '
  + 'reset <P> --generation <N> --sha <64hex> | apply <P> --generation <N> --sha <64hex> [--item-digest <64hex>]'

const COMMANDS = {
  save: { flags: ['generation', 'why'], optional: ['item', 'item-digest'] },
  verify: { flags: ['sha'], optional: [] },
  reset: { flags: ['generation', 'sha'], optional: [] },
  apply: { flags: ['generation', 'sha'], optional: ['item-digest'] },
}

function parseArgs(argv) {
  const cmd = Object.hasOwn(COMMANDS, argv[0] ?? '') ? COMMANDS[argv[0]] : null
  if (!cmd) return null
  const opts = {}
  const pos = []
  const rest = argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const k = a.slice(2)
    if (![...cmd.flags, ...cmd.optional].includes(k) || k in opts || i + 1 >= rest.length) return null
    opts[k] = rest[++i]
  }
  if (pos.length !== 1 || cmd.flags.some(k => opts[k] === undefined)) return null
  if ('generation' in opts) {
    if (!GENERATION.test(opts.generation) || !Number.isSafeInteger(Number(opts.generation))) return null
    opts.generation = Number(opts.generation)
  }
  if ('sha' in opts && !SHA.test(opts.sha)) return null
  if ('item-digest' in opts && !SHA.test(opts['item-digest'])) return null
  if ('item' in opts && !ID_RE.test(opts.item)) return null
  // On save the digest is checked against the item's (R18): it means nothing without one.
  if (argv[0] === 'save' && 'item-digest' in opts && !('item' in opts)) return null
  if ('why' in opts && !WHYS.includes(opts.why)) return null
  return { cmd: argv[0], P: pos[0], ...opts }
}

// The item `save --item <id>` holds work for (R18): {id, digest}, read from <S>/STATE.md
// through loop-state.mjs. Exactly one item, in any section, carries the id; eligibility does not
// matter. A carrier is an item with an `id:` line naming the id (compared case-insensitively, R2),
// so an item with two id lines (invalid-id, its id null) still counts, and is refused: its digest
// would not name the id. want, when given, must equal the digest (digest-mismatch).
function savedItem(paths, id, want) {
  const file = path.join(paths.S, 'STATE.md')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw refused('bad-item', `${file} does not exist, so no item carries ${id}`, { carriers: 0 })
    throw e
  }
  const st = parseState(text)
  if (st.problems.some(p => p.kind === 'crlf')) {
    throw refused('bad-item', `${file} holds a carriage return (crlf): convert it to LF line endings`, { carriers: 0 })
  }
  const carriers = st.items.filter(it => it.fields.some(fl => fl.label === 'id' && fl.value.trim().toLowerCase() === id))
  if (carriers.length !== 1) {
    const where = carriers.map(it => `${it.section} line ${it.line}`).join(', ')
    throw refused('bad-item', carriers.length ? `${carriers.length} items carry ${id} (${where})` : `no item in ${file} carries ${id}`,
      { carriers: carriers.length })
  }
  const it = carriers[0]
  if (it.id !== id) throw refused('bad-item', `the item at ${it.section} line ${it.line} has an invalid id (two id lines)`, { carriers: 1 })
  const digest = digestOfItem(it)
  if (want !== undefined && want !== digest) {
    throw refused('digest-mismatch', `item digest ${want} was given, the item ${id} has ${digest}`, { item_id: id, item_digest: digest })
  }
  return { id, digest }
}

function saveCli(a, env) {
  const paths = openPaths(a.P, env)
  assertHeld(paths, a.generation, env)
  process.chdir(paths.V)
  const rec = readRecord(paths, a.generation)
  if (!rec || !['prepared', 'saved'].includes(rec.phase) || !rec.rules) {
    throw refused('no-record', rec ? `the run record of generation ${a.generation} is in phase ${rec.phase}${rec.rules ? '' : ' without recorded rules'}` : `generation ${a.generation} has no run record`)
  }
  const item = a.item === undefined ? null : savedItem(paths, a.item, a['item-digest'])
  // HEAD away from the base (a delegate's amend or reset) is refused: the reset that follows a
  // save needs HEAD at the base, and the next prepare judges that tip (data-safety#3).
  const r = saveFor(paths, {
    saver: a.generation, source: a.generation, base: rec.base, rules: rec.rules, why: a.why,
    itemId: item && item.id, itemDigest: item && item.digest, also: knownCommits(rec), requireHeadAtBase: true, env,
  })
  if (r.state !== 'saved') return r
  const held = () => assertHeld(paths, a.generation, env)
  held()
  updateRecord(paths, a.generation, cur => {
    const last = cur.saves[cur.saves.length - 1]
    const saves = last && last.sha === r.sha && last.why === a.why ? cur.saves : [...cur.saves, { sha: r.sha, why: a.why }]
    return { ...cur, phase: 'saved', saves }
  }, { guard: held })
  fault('save:after-record')
  return r
}

function verifyCli(a, env) {
  const paths = openPaths(a.P, env)
  process.chdir(paths.V)
  const b = verifyBundle(paths, a.sha, { env })
  const h = b.header
  return {
    state: 'verified', sha: b.sha, file: b.file, bytes: b.bytes, why: h.why, generation: h.generation, source: h.source,
    base: h.base, tree: h.tree, item_id: h.item_id, item_digest: h.item_digest, scope: h.scope, files: h.files.length,
  }
}

function resetCli(a, env) {
  const paths = openPaths(a.P, env)
  assertHeld(paths, a.generation, env)
  process.chdir(paths.V)
  return resetFor(paths, { holder: a.generation, record: a.generation, sha: a.sha, env })
}

function applyCli(a, env) {
  const paths = openPaths(a.P, env)
  assertHeld(paths, a.generation, env)
  process.chdir(paths.V)
  return applyBundle(paths, a.generation, a.sha, a['item-digest'] ?? null, env)
}

const RUN = { save: saveCli, verify: verifyCli, reset: resetCli, apply: applyCli }

export function main(argv, env = process.env) {
  const print = o => process.stdout.write(`${JSON.stringify(o)}\n`)
  const a = parseArgs(argv)
  if (!a) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    print(RUN[a.cmd](a, env))
    return 0
  } catch (e) {
    if (e.code === 'NOT_HOLDER') {
      print({ state: 'not-holder', detail: e.message, ...(e.reason ? { reason: e.reason } : {}) })
      return 3
    }
    if (e.code === 'REFUSED') {
      print({ ...(e.extra ?? {}), state: e.state, detail: e.detail })
      return 3
    }
    if (e.code === 'CLONE_INVALID') {
      // git-safe refused <W> mid-command (its storage changed after openClone checked it), as
      // loop-clone.mjs refuses it.
      print({ state: 'clone-invalid', detail: e.message, problems: [e.message] })
      return 3
    }
    if (e.code === 'PARTIAL') {
      print({ state: 'error', partial: true, detail: e.message })
      return 2
    }
    print({ state: 'error', detail: e.message })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
