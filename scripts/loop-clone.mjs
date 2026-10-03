#!/usr/bin/env node
// scripts/loop-clone.mjs
// Owner of the loop's clone <W> = <V>/clone (stage 0c-2, brief section 13; spec 7.5 as amended
// by A11, 7.6; rulings R2, R4, R7, R9-R15, R17, R18, R20, R21, R23). Delegates and verify
// commands work in <W>, a full clone of <P> made with `git clone --no-local`; the loop branch
// lives only there, and the owner receives it as a delivery bundle under <V>/out. Every git call
// in <W> goes through git-safe's workGit (hooks, fsmonitor, pagers, external diff and textconv
// off), and nothing here writes <P>'s tree or .git.
//
// CLI (one JSON line on stdout; exit 0 ok, 2 {state:'error', detail[, partial]}, 3 refused with
// `state` naming why; not the holder is exit 3 {state:'not-holder', detail}):
//   prepare <P> --generation <N> --prefix <p> [--base <b>] [--date YYYY-MM-DD]
//       once per firing, before the first write-capable dispatch: creates <W> or checks it
//       (checkClone, quiesce, the process sweep, the refs the newest run record or the run
//       anchor <V>/run/refs.json holds), saves and resets what an interrupted firing left (the
//       clean-clone rule; with no record left, under the rules the run anchor holds, R25),
//       refreshes from <P>, re-syncs the delivery bundles and rotates to today's branch
//       <p>/<date>. Exit 0
//       {state:'ready', W, branch, base, baseSha, head, startPoint, chainedFrom, created, rotated,
//       retiredReset, baseAhead, adopted, bundles, recovered, notes}; exit 3 not-quiet,
//       clone-invalid {problems}, no-base, infra (also git-too-old, R24; an unsafe merge or
//       filter driver; a rotation that would overwrite ignored files, with {paths}, R30), busy
//       {procs}, save-failed, index-only {paths}, attempt-open, corrupt, tampered.
//   deps <P> --generation <N> [--mark | --clear]
//       the dependency marker <W>/.git/tech-lead-deps.ok ('<branch> sha256:<hex>' over the root
//       lockfiles present): {fresh, marker, current, lockfiles} | {marked} | {cleared};
//       exit 3 no-attempt.
//   check <P> --generation <N> --after deps|dispatch|verify
//       after every untrusted execution: the clone's integrity, HEAD and refs against the record;
//       a delegate commit rewound (loop04); plain staging reset; the touched set (git's standard
//       listing), `hidden` (what only the recorded ignore rules list), `out_of_scope` and the
//       digest commit takes. --after deps records the ignore rules (refusing deps-dirty).
//       Exit 0 {state:'ok', after, head, delegateCommitted, delegateCommits, unstaged, touched,
//       hidden, out_of_scope, scope, digest, counts}; exit 3 no-attempt, no-rules, clone-invalid,
//       tampered, deps-dirty {paths}, unsavable {paths}, index-only {paths}, corrupt.
//   commit <P> --generation <N> --digest <64hex> --subject-file <file>
//       commit-tree of the checked tree on H0 with <P>'s identity, compare-and-swap update-ref,
//       then the delivery bundle. Exit 0 {state:'committed', sha, branch, bundle, bundleError} |
//       {state:'unchanged'}; exit 3 no-attempt, work-changed, out-of-scope {paths}, index-only
//       {paths}, tampered, clone-invalid, commit-failed.
//   bundle <P> --generation <N> --branch <b>
//       {state:'bundled', bundle} | {state:'current'}; exit 3 unvetted, clone-invalid.
//   close <P> --generation <N>
//       deletes the run records that are resolved and ledgered (and, for the newest, whose refs
//       still match the clone), first writing the run anchor <V>/run/refs.json {v:2,
//       generation:N, refs, rules} when it read clone facts (R25: rules are those the newest
//       closed record recorded, else the previous anchor's). N's own prepared or committed record
//       is kept while the clone still holds files under its rules (reason dirty, or hidden for a
//       committed record holding only untracked files); a record whose `adopted` tips no ledger
//       row names (as a commit or a bundle tip) and the base does not contain is kept with reason
//       adopted (R32), and it alone keeps no newer record: {state:'closed', closed,
//       kept:[{generation, dirty, reason}], bundleError?}; exit 3 corrupt.
//   git <P> -- <subcommand> [args...]
//       read-only passthrough, no lock: git's own output and exit status; a refusal is exit 2
//       with the last stderr line `loop-clone git: {"state":"refused","detail":...}`.
//
// Library (for 0c-3 and 0c-4): ensureClone(paths, opts), adoptBranches(W, prefix),
// commitMessage({subject, generation, item}), checkClone (re-exported from clone-check.mjs).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAttrSource, cloneRepo, safeGit, workGit, workGitRun } from './lib/git-safe.mjs'
import { readJson, sweepTemps, tempFile, writeReplace } from './lib/atomic.mjs'
import { canonicalJson, sha256Hex } from './lib/canonical.mjs'
import { chainStart, containedIn, resolveBase, retiredRefs, validPrefix } from './loop-start.mjs'
import { baseRules, collect, currentRules, indexOnly, openWorkTree, recordRules, touched } from './lib/changes.mjs'
import {
  cloneVerdict, committedSha, createRecord, deleteRecord, isResolved, listRecords, ownerRecord, readRecord, updateRecord, vettedTip,
} from './lib/run-record.mjs'
import { DATED_BRANCH_RE, checkClone, cloneMeta, refsSnapshot } from './lib/clone-check.mjs'
import { BASE_REF, bundleCurrent, bundlePath, syncBundles, writeBundle } from './lib/delivery.mjs'
import { readBundle, resetEmpty, resetFor, saveFor } from './reflex-bundle.mjs'
import { markScope } from './lib/loop-scope.mjs'
import { nowLine } from './lib/loop-state.mjs'
import { ledgerShas } from './lib/ledger.mjs'
import { assertHeld, openPaths } from './loop-lock.mjs'
import { quiesce } from './loop-codex.mjs'
import { startToken, sweepOthers } from './lib/loop-proc.mjs'
import { fault } from './lib/fault.mjs'

export { checkClone }

const GENERATION = /^[1-9][0-9]*$/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const SHA_RE = /^[0-9a-f]{64}$/
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const CLONE_TMP = /^clone\.tmp-([1-9][0-9]*)-[0-9a-f]+$/
const LIST_MAX = 50
const SUBJECT_MAX = 200
const MARKER = 'tech-lead-deps.ok'
const ANCHOR = 'refs.json'
const GIT_LOCKS = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock']
// The root lockfiles whose content decides whether dependencies need installing again.
export const LOCKFILES = Object.freeze([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'deno.lock',
  'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'pdm.lock', 'requirements.txt', 'Cargo.lock', 'go.sum',
  'composer.lock', 'mix.lock', 'pubspec.lock', 'Podfile.lock', 'packages.lock.json', 'gradle.lockfile',
])
// The read-only passthrough (brief 13.2).
export const PASSTHROUGH = Object.freeze([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'rev-list', 'merge-base', 'cat-file', 'for-each-ref', 'blame',
  'grep', 'shortlog', 'describe',
])
// Long options the passthrough refuses, by name and by any abbreviation git would expand.
const FORBIDDEN_LONG = ['output', 'ext-diff', 'textconv', 'filters', 'open-files-in-pager', 'upload-pack', 'receive-pack', 'exec']
// Real options that are also prefixes of a forbidden one (an exact name never abbreviates).
const LONG_EXACT_OK = new Set(['text', 'filter'])

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
// The errors of a lost (or unknowable) firing lock: they always propagate as they are (R31).
const LOCK_LOST = new Set(['NOT_HOLDER', 'HOLDER_UNKNOWN'])
const short = s => String(s).slice(0, 12)
const capped = list => ({ shown: list.slice(0, LIST_MAX), more: Math.max(0, list.length - LIST_MAX) })

function refused(state, detail, extra = {}) {
  return Object.assign(new Error(`${state}: ${detail}`), { code: 'REFUSED', state, detail, extra })
}
const infra = detail => refused('infra', detail)
const usage = detail => Object.assign(new Error(detail), { code: 'USAGE' })

// ---------------------------------------------------------------- git in <W>

// A git run that did not reach an exit, as an error that keeps workGitRun's code, so a clone
// made invalid mid-command (CLONE_INVALID) is refused clone-invalid, never a bare error.
const notRun = r => Object.assign(new Error(r.error), { code: r.code })

function revParse(W, spec) {
  const r = workGitRun(W, ['rev-parse', '--verify', '-q', '--end-of-options', spec])
  if (r.code) throw notRun(r)
  return r.status === 0 ? r.stdout.trim() : null
}

function isAncestor(W, a, b) {
  const r = workGitRun(W, ['merge-base', '--is-ancestor', a, b])
  if (r.code) throw notRun(r)
  if (r.status === 0) return true
  if (r.status === 1) return false
  throw new Error(`git merge-base --is-ancestor ${a} ${b} failed: ${String(r.stderr).trim()}`)
}

function symbolicHead(W) {
  const r = workGitRun(W, ['symbolic-ref', '-q', 'HEAD'])
  if (r.code) throw notRun(r)
  return r.status === 0 ? r.stdout.trim() : null
}

// -c overrides that empty every configured filter driver (as changes.mjs does for a save), so a
// checkout runs no program: what it writes is what a reset of the same commit writes (R29).
function filterNeutral(W) {
  const r = workGitRun(W, ['config', '-z', '--name-only', '--get-regexp', '^filter[.]'], { buffer: true })
  if (r.code) throw notRun(r)
  if (r.status === 1) return []
  if (r.status !== 0) throw new Error(`git config --get-regexp filter failed: ${String(r.stderr).trim()}`)
  const names = new Set()
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    const last = rec.lastIndexOf('.')
    if (rec && last > 'filter.'.length) names.add(rec.slice('filter.'.length, last))
  }
  const out = []
  for (const n of [...names].sort()) {
    if (/[=\n\0]/.test(n) || !n.isWellFormed() || n.includes(String.fromCharCode(0xfffd))) {
      throw infra(`unsafe-config: filter driver ${JSON.stringify(n)} cannot be neutralized for a checkout`)
    }
    out.push(`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`)
  }
  return out
}

// The paths git names after "would be overwritten by checkout:" (one per tab-indented line).
function collisionPaths(stderr) {
  const lines = String(stderr).split('\n')
  const at = lines.findIndex(l => /would be (overwritten|removed) by checkout/.test(l))
  if (at < 0) return []
  const out = []
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('\t')) break
    out.push(l.slice(1))
  }
  return out
}

function zeroOid(W) {
  const fmt = workGit(W, ['rev-parse', '--show-object-format'])
  return '0'.repeat(fmt === 'sha256' ? 64 : 40)
}

// Does the real index need resetting to base? It differs from base, or an entry carries a flag
// (skip-worktree, assume-unchanged, a conflict stage) that would hide a change.
function indexNeedsReset(W, base) {
  const d = workGitRun(W, ['diff-index', '--cached', '--quiet', '--ignore-submodules=none', base])
  if (d.code) throw new Error(d.error)
  if (d.status !== 0) return true
  const tags = workGit(W, ['ls-files', '-v', '-z'], { buffer: true })
  for (let i = 0, start = 0; i <= tags.length; i++) {
    if (i === tags.length || tags[i] === 0) {
      if (i > start && tags[start] !== 0x48) return true // 'H': a plain cached entry
      start = i + 1
    }
  }
  return false
}

const lstatOrNull = p => {
  try { return fs.lstatSync(p) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

const gitDirOk = W => {
  const st = lstatOrNull(path.join(W, '.git'))
  return Boolean(st && st.isDirectory())
}

// ---------------------------------------------------------------- shared facts

function loopMdText(paths) {
  try { return fs.readFileSync(path.join(paths.S, 'LOOP.md'), 'utf8') } catch { return null }
}

function nowSha(paths) {
  let text
  try { text = fs.readFileSync(path.join(paths.S, 'STATE.md'), 'utf8') } catch { return null }
  const line = nowLine(text)
  return line === null ? null : sha256Hex(line)
}

// Every commit a record knows (R20): staged content found in one of them is never index-only.
function knownCommits(rec) {
  if (!rec) return []
  const r = rec.recovery
  return [...new Set([rec.commit?.sha, rec.intent?.commit, ...(rec.delegate_commits ?? []), r?.rewind?.from, r?.rewind?.to, r?.base,
    rec.base, rec.pre_head].filter(o => typeof o === 'string' && OID_RE.test(o)))]
}

// The oids among list that are objects of `type` (commits unless named) in <W>.
function present(W, list, type = 'commit') {
  const want = [...new Set(list.filter(o => typeof o === 'string' && OID_RE.test(o)))]
  if (!want.length) return []
  const got = workGit(W, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: want.join('\n') + '\n' }).split('\n')
  return want.filter((o, i) => got[i] === `${o} ${type}`)
}

// The vetted-tip predicate every bundle write, rotation and chaining uses, bound to the records
// and the ledger as they are now, plus the tips this prepare adopted.
function vettedFor(paths, extra = new Set()) {
  const records = listRecords(paths)
  const ledger = ledgerShas(paths.S)
  return ({ branch, tip }) => extra.has(tip) || vettedTip({ records, ledger, branch, tip, inBase: false })
}

function retiredTips(W) {
  return workGit(W, ['for-each-ref', '--format=%(objectname)', 'refs/tech-lead/retired/']).split('\n').filter(Boolean)
}

const bundleRow = (paths, w, branch) => ({ branch, tip: w.tip, file: path.relative(paths.V, w.file), sha256: w.sha256, why: w.why })

// ---------------------------------------------------------------- commit message and identity

const dropped = c => c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029

// The commit message: the first line of the subject without control characters, trimmed and cut
// to 200 characters; a blank line; the trailers (Tech-Lead-Item when 0c-3 passes one, then
// Tech-Lead-Generation). Nothing else from the subject file reaches the message.
export function commitMessage({ subject, generation, item = null } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError(`commitMessage: bad generation ${generation}`)
  const first = String(subject ?? '').split(/\r\n|\n|\r/)[0]
  let s = Array.from(first).filter(ch => !dropped(ch.codePointAt(0))).join('').trim()
  s = Array.from(s).slice(0, SUBJECT_MAX).join('').trimEnd()
  if (!s) throw usage('empty-subject: the subject file has no first line to commit with')
  const trailers = []
  if (item !== null) {
    if (typeof item !== 'string' || !/^[!-~]+$/.test(item)) throw new TypeError(`commitMessage: bad item ${JSON.stringify(item)}`)
    trailers.push(`Tech-Lead-Item: ${item}`)
  }
  trailers.push(`Tech-Lead-Generation: ${generation}`)
  return `${s}\n\n${trailers.join('\n')}\n`
}

// <P>'s identity as `git var` gives it (what a commit made in <P> would carry), set explicitly
// for the commit in <W>; the inherited identity dates are scrubbed by git-safe.
function identityOf(R) {
  const parse = (key) => {
    const s = safeGit(R, ['var', key])
    const m = /^(.*) <([^>]*)> [0-9]+ [+-][0-9]{4}$/.exec(s)
    if (!m) throw new Error(`git var ${key} printed ${JSON.stringify(s)}`)
    return { name: m[1], email: m[2] }
  }
  const a = parse('GIT_AUTHOR_IDENT')
  const c = parse('GIT_COMMITTER_IDENT')
  return { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email }
}

// ---------------------------------------------------------------- creation (13.4)

// <V>/run/empty-template, created mode 0700; anything in it is refused (it would be copied into
// the clone's .git).
function emptyTemplate(V) {
  const run = path.join(V, 'run')
  fs.mkdirSync(run, { recursive: true, mode: 0o700 })
  const tpl = path.join(run, 'empty-template')
  try {
    fs.mkdirSync(tpl, { mode: 0o700 })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  const st = fs.lstatSync(tpl)
  if (!st.isDirectory()) throw infra(`${tpl} is not a directory`)
  if (fs.readdirSync(tpl).length) throw infra(`the clone template ${tpl} is not empty`)
  return tpl
}

function removeSectionIfThere(W, section) {
  const r = workGitRun(W, ['config', '--remove-section', section])
  if (r.code) throw new Error(r.error)
}

// remote.origin and every branch.* section removed, refs/remotes/origin/HEAD and every local
// branch the clone made deleted (HEAD then names an unborn branch until rotation).
function normalize(W) {
  removeSectionIfThere(W, 'remote.origin')
  const r = workGitRun(W, ['config', '--file', path.join(W, '.git', 'config'), '--name-only', '--list'])
  if (r.code) throw new Error(r.error)
  const sections = new Set(r.stdout.split('\n').filter(k => k.startsWith('branch.')).map(k => k.slice(0, k.lastIndexOf('.'))))
  for (const s of sections) removeSectionIfThere(W, s)
  workGitRun(W, ['update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD'])
  for (const ref of workGit(W, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean)) {
    workGit(W, ['update-ref', '-d', ref])
  }
}

// safeGit forces core.hooksPath=/dev/null on its own command line, so the owner's setting is
// read scope by scope (a scoped read leaves the command line out) and the hooks directory is
// taken from the common git directory, never from --git-path hooks.
function hooksNote(R) {
  const why = []
  try {
    const hooks = path.join(safeGit(R, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'hooks')
    const names = fs.readdirSync(hooks).filter(n => !n.endsWith('.sample'))
    if (names.length) why.push(`hooks ${names.sort().join(', ')}`)
  } catch { /* no hooks directory */ }
  for (const scope of ['--system', '--global', '--local']) {
    try {
      if (safeGit(R, ['config', scope, '--get', 'core.hooksPath'])) {
        why.push('core.hooksPath')
        break
      }
    } catch { /* unset in that scope */ }
  }
  for (const f of ['.husky', '.pre-commit-config.yaml', 'lefthook.yml']) if (lstatOrNull(path.join(R, f))) why.push(f)
  return why.length ? `project git hooks do not run on loop commits (spec 7.6); add their checks to verify: (${why.join(', ')})` : null
}

// Creates <W> when it is missing (brief 13.4): the identity and shallow checks, the base, a
// temporary clone made mode 0700 before content arrives, normalized, refreshed (with the adopt
// refspec), adoption, rotation, the non-dated heads and adopt refs deleted, checkClone, rename.
// Generation N's run record must exist (adopted tips go into its `adopted`). Returns {created:false}
// when <W> exists, else {created:true, base, baseRef, baseSha, branch, startPoint, chainedFrom,
// rotated, retiredReset, adopted, notes}.
export function ensureClone(paths, { generation, prefix, date, base, env = process.env } = {}) {
  if (lstatOrNull(paths.W)) return { created: false }
  if (!validPrefix(prefix)) throw usage(`bad prefix ${JSON.stringify(prefix)}`)
  const notes = []
  preflight(paths)
  const baseInfo = baseOf(paths, base)
  const tpl = emptyTemplate(paths.V)
  const tmp = path.join(paths.V, `clone.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(tmp, { mode: 0o700 })
  fs.chmodSync(tmp, 0o700)
  let renamed = false
  try {
    cloneRepo(paths.R, tmp, { templateDir: tpl })
    fault('clone:after-clone')
    normalize(tmp)
    const baseSha = refresh(paths, tmp, baseInfo.baseRef, { adopt: true })
    const adoption = adoptBranches(tmp, prefix)
    notes.push(...adoption.notes)
    const adoptedTips = new Set(adoption.adopted.map(a => a.tip))
    if (adoption.adopted.length) {
      // R28: the adopted tips are vetted through this record's `adopted`, never its refs.
      assertHeld(paths, generation, env)
      updateRecord(paths, generation, rec => ({
        ...rec, adopted: [...rec.adopted, ...adoption.adopted.map(a => ({ ref: `refs/heads/${a.branch}`, tip: a.tip }))],
      }))
    }
    const rot = rotate(paths, tmp, { prefix, date, generation, env, extra: adoptedTips })
    notes.push(...rot.notes)
    for (const ref of workGit(tmp, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/tech-lead/adopt/']).split('\n')) {
      if (ref && (ref.startsWith('refs/tech-lead/adopt/') || !DATED_BRANCH_RE.test(ref))) workGit(tmp, ['update-ref', '-d', ref])
    }
    const { problems } = checkClone(tmp)
    if (problems.length) throw refused('clone-invalid', `the new clone fails its check: ${problems.join('; ')}`, { problems })
    fault('clone:before-rename')
    assertHeld(paths, generation, env)
    fs.renameSync(tmp, paths.W)
    renamed = true
    const hn = hooksNote(paths.R)
    if (hn) notes.push(hn)
    return { created: true, base: baseInfo.base, baseRef: baseInfo.baseRef, baseSha, adopted: adoption.adopted, ...rot, notes }
  } finally {
    if (!renamed) fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// What creating <W> needs from <P> before anything is written: an identity for its commits and
// a full (not shallow) history.
function preflight(paths) {
  try {
    safeGit(paths.R, ['var', 'GIT_AUTHOR_IDENT'])
    safeGit(paths.R, ['var', 'GIT_COMMITTER_IDENT'])
  } catch (e) {
    throw infra(`no git identity in ${paths.R}: ${String(e.stderr || e.message).trim().split('\n')[0]}`)
  }
  if (safeGit(paths.R, ['rev-parse', '--is-shallow-repository']) === 'true') throw infra(`${paths.R} is a shallow repository`)
}

function baseOf(paths, base) {
  try {
    return resolveBase(paths.R, base)
  } catch (e) {
    if (e.code === 'NO_BASE') throw refused('no-base', e.message)
    throw e
  }
}

// ---------------------------------------------------------------- refresh (13.5)

function refresh(paths, W, baseRefP, { adopt = false } = {}) {
  const specs = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*',
    '+refs/tech-lead/retired/*:refs/tech-lead/retired/*', `+${baseRefP}:${BASE_REF}`]
  if (adopt) specs.push('+refs/remotes/tech-lead/*:refs/tech-lead/adopt/*')
  const r = workGitRun(W, ['fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules', '--no-write-fetch-head', paths.R, ...specs])
  if (r.code) throw infra(`git fetch from ${paths.R}: ${r.error}`)
  if (r.status !== 0) {
    const err = String(r.stderr).trim()
    if (/couldn't find remote ref/i.test(err)) throw refused('no-base', `the base ${baseRefP} is gone from ${paths.R}: ${err}`)
    throw infra(`git fetch from ${paths.R} failed: ${err}`)
  }
  fault('refresh:after-fetch')
  const baseSha = revParse(W, `${BASE_REF}^{commit}`)
  if (!baseSha) throw refused('no-base', `${BASE_REF} is not a commit after the fetch`)
  return baseSha
}

// ---------------------------------------------------------------- adoption (13.8)

// The dated branches <prefix>/<date> of <P> become the clone's: candidates are
// refs/remotes/origin/<name> (<P>'s branch) and refs/tech-lead/adopt/<name> (<P>'s
// refs/remotes/tech-lead/<name>); one is taken, or the descendant of two; diverged copies are
// not adopted (a note). A name the clone already has is never moved (create-only update-ref).
export function adoptBranches(W, prefix) {
  if (!validPrefix(prefix)) throw new TypeError(`adoptBranches: bad prefix ${JSON.stringify(prefix)}`)
  const list = ns => {
    const out = new Map()
    const lines = workGit(W, ['for-each-ref', '--format=%(objectname) %(refname)', `${ns}${prefix}/`]).split('\n').filter(Boolean)
    for (const line of lines) {
      const sp = line.indexOf(' ')
      const name = line.slice(sp + 1).slice(ns.length)
      const rest = name.slice(prefix.length + 1)
      if (DATE_RE.test(rest) && DATED_BRANCH_RE.test(`refs/heads/${name}`)) out.set(name, line.slice(0, sp))
    }
    return out
  }
  const origin = list('refs/remotes/origin/')
  const adopt = list('refs/tech-lead/adopt/')
  const names = [...new Set([...origin.keys(), ...adopt.keys()])].sort()
  const adopted = []
  const notes = []
  let zero = null
  for (const name of names) {
    if (revParse(W, `refs/heads/${name}`)) continue
    const a = origin.get(name)
    const b = adopt.get(name)
    let tip, from
    if (a && b) {
      if (a === b || isAncestor(W, b, a)) [tip, from] = [a, 'origin']
      else if (isAncestor(W, a, b)) [tip, from] = [b, 'adopt']
      else {
        notes.push(`not adopted: ${name} has diverged copies (${short(a)} in <P>'s branch, ${short(b)} in refs/remotes/tech-lead)`)
        continue
      }
    } else [tip, from] = a ? [a, 'origin'] : [b, 'adopt']
    zero ??= zeroOid(W)
    const r = workGitRun(W, ['update-ref', `refs/heads/${name}`, tip, zero])
    if (r.code || r.status !== 0) {
      notes.push(`not adopted: ${name}: ${r.error || String(r.stderr).trim()}`)
      continue
    }
    adopted.push({ branch: name, tip, from })
  }
  return { adopted, notes }
}

// ---------------------------------------------------------------- rotation (13.6)

function rotate(paths, W, { prefix, date, generation, env, extra = new Set() }) {
  const branch = `${prefix}/${date}`
  const ref = `refs/heads/${branch}`
  // Forwards opts: containedIn reads attributes from the empty tree through them.
  const gitW = (args, opts) => workGit(W, args, opts)
  const retired = retiredTips(W)
  const vetted = vettedFor(paths, extra)
  const notes = []
  const tip = revParse(W, `${ref}^{commit}`)
  let startPoint = null
  let chainedFrom = null
  let rotated = false
  let retiredReset = false
  // Every rotation switch (R30): an ignored file in the way is never overwritten (the clone's
  // leftovers were saved earlier in this prepare; what is left is what the rules ignore), and no
  // filter program runs; attributes come from the commit checked out, so the clone holds what a
  // reset of that commit writes. Every git-derived value comes first, then the lock check right
  // before the switch (R31).
  const switchTo = (args, target) => {
    assertAttrSource(W)
    const at = revParse(W, `${target}^{commit}`)
    if (!at) throw new Error(`${target} is not a commit in the clone`)
    const config = filterNeutral(W)
    assertHeld(paths, generation, env)
    const r = workGitRun(W, ['switch', '-q', '--no-overwrite-ignore', ...args], { config, env: { GIT_ATTR_SOURCE: at } })
    if (r.code) throw notRun(r)
    if (r.status !== 0) {
      const hit = collisionPaths(r.stderr)
      if (hit.length) {
        throw refused('infra', `rotation to ${branch} would overwrite ${hit.length} file(s) the clone holds and its rules ignore: ${hit.slice(0, 5).map(p => JSON.stringify(p)).join(', ')}; move them out of ${W}`, { paths: hit.slice(0, LIST_MAX) })
      }
      throw new Error(`git switch ${args.join(' ')} failed: ${String(r.stderr).trim()}`)
    }
    rotated = true
    fault('rotate:after-switch')
  }
  if (tip) {
    const skip = retiredRefs(gitW, prefix, BASE_REF, retired)
    const isRetired = skip.has(ref)
    // Vetted first: content checks (containedIn merges) only for a tip nothing vouches for.
    const keep = !isRetired && (vetted({ branch, ref, tip }) || isAncestor(W, tip, BASE_REF) || containedIn(gitW, BASE_REF, tip))
    if (!keep) {
      ({ startPoint, chainedFrom } = chainStart(gitW, prefix, BASE_REF, { retired, vetted }))
      switchTo(['--no-track', '-C', branch, startPoint], startPoint)
      retiredReset = true
      notes.push(`today's branch ${branch} at ${short(tip)} was reset to ${startPoint}: ${isRetired ? 'its tip is comparable with a retired tip' : 'its tip is not vetted'}`)
    } else if (symbolicHead(W) !== ref) switchTo([branch], ref)
  } else {
    ({ startPoint, chainedFrom } = chainStart(gitW, prefix, BASE_REF, { retired, vetted }))
    switchTo(['--no-track', '-c', branch, startPoint], startPoint)
  }
  if (rotated) {
    assertHeld(paths, generation, env)
    const gc = workGitRun(W, ['gc', '--auto', '--quiet'], { config: ['gc.auto=6700', 'gc.autoDetach=false'] })
    if (gc.code || gc.status !== 0) notes.push(`gc --auto: ${gc.error || String(gc.stderr).trim()}`)
  }
  if (chainedFrom) notes.push(`chained from ${chainedFrom}`)
  return { branch, startPoint, chainedFrom, rotated, retiredReset, notes }
}

// ---------------------------------------------------------------- prepare (13.3)

function sweepAll(V) {
  const removed = []
  for (const sub of ['patches', 'run']) removed.push(...sweepTemps(path.join(V, sub)))
  const walk = dir => {
    removed.push(...sweepTemps(dir))
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name))
  }
  walk(path.join(V, 'out'))
  let names = []
  try { names = fs.readdirSync(V) } catch { /* no <V> entries */ }
  for (const name of names) {
    const m = CLONE_TMP.exec(name)
    if (!m || startToken(Number(m[1])).state !== 'gone') continue
    const p = path.join(V, name)
    const st = lstatOrNull(p)
    if (!st) continue
    // R18: the one recursive removal, of the helper's own partial clone whose pid is gone.
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true })
    else fs.unlinkSync(p)
    removed.push(p)
  }
  return removed
}

function removeGitLocks(W, guard) {
  const gitDir = path.join(W, '.git')
  const removed = []
  const unlinkFile = p => {
    const st = lstatOrNull(p)
    if (st && (st.isFile() || st.isSymbolicLink())) {
      guard()
      fs.unlinkSync(p)
      removed.push(path.relative(gitDir, p))
    }
  }
  for (const name of GIT_LOCKS) unlinkFile(path.join(gitDir, name))
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.lock')) unlinkFile(p)
    }
  }
  walk(path.join(gitDir, 'refs'))
  return removed
}

// The run anchor <V>/run/refs.json {v:2, generation, refs, rules} (R25): the clone's refs as the
// close of that generation saw them, and the ignore rules recorded by the newest record it
// closed that had any (carried forward from the previous anchor when none had; rules whose
// ignore blobs the clone no longer holds are never carried, see anchorRules). close writes it
// before it deletes records, so a ref planted in <W> after a firing that closed cleanly (no
// record left) is still caught, and leftovers found with no record are listed under rules a
// firing recorded. null when absent (the first firing); a malformed one, or one whose generation
// is not below `below`, throws CORRUPT. rules is null or a recorded rules object (changes.mjs
// checks it in full when it lists).
const anchorFile = paths => path.join(paths.V, 'run', ANCHOR)

function readAnchor(paths, below) {
  const file = anchorFile(paths)
  const bad = why => Object.assign(new Error(`corrupt: ${file}: ${why}`), { code: 'CORRUPT', file })
  const st = lstatOrNull(file)
  if (!st) return null
  if (!st.isFile()) throw bad('not a regular file')
  let a
  try {
    a = readJson(file)
  } catch (e) {
    if (typeof e.message === 'string' && e.message.startsWith('corrupt: ')) throw bad('not a JSON object')
    throw e
  }
  if (a === null) return null
  const rulesOk = r => r === null || (isPlain(r) && r.v === 1 && r.mode === 'recorded' && Array.isArray(r.ignores))
  const shape = Object.keys(a).sort().join(',') === 'generation,refs,rules,v' && a.v === 2 && Number.isSafeInteger(a.generation)
    && a.generation >= 1 && isPlain(a.refs) && Object.entries(a.refs).every(([k, v]) => k.startsWith('refs/') && typeof v === 'string' && OID_RE.test(v))
    && rulesOk(a.rules)
  if (!shape) throw bad('not a run anchor {v:2, generation, refs, rules}')
  if (a.generation >= below) throw bad(`generation ${a.generation} is not older than ${below}`)
  return a
}

// Prepare step 3: the newest refs snapshot, by generation, of the newest record on disk (any
// phase) and the anchor, must still match the clone. A record is matched apart from its head_ref
// and the refs naming its own commit, and wins a tie (close writes the anchor of its own
// generation when it deletes older records but keeps its own, which holds what this firing's
// prepare and commit recorded). The anchor is matched exactly: nothing moves a ref in <W>
// between a close and the next prepare. A record whose head_ref is null holds no snapshot (only
// prepare step 6 sets both), whatever its phase: the check is skipped then (R28).
function tamperCheck(paths, W, anchor) {
  const recs = listRecords(paths)
  const newest = recs[recs.length - 1] ?? null
  let want, since
  let headRef = null
  const own = new Set()
  if (newest && (!anchor || newest.generation >= anchor.generation)) {
    if (newest.head_ref === null) return
    want = newest.refs
    headRef = newest.head_ref
    const c = committedSha(newest)
    if (c) own.add(c)
    since = `since generation ${newest.generation} recorded them`
  } else if (anchor) {
    want = anchor.refs
    since = `since generation ${anchor.generation} closed (${path.relative(paths.V, anchorFile(paths))})`
  } else return
  const now = refsSnapshot(W).refs
  const bad = []
  for (const ref of [...new Set([...Object.keys(now), ...Object.keys(want)])].sort()) {
    if (ref === headRef || now[ref] === want[ref]) continue
    if (now[ref] && own.has(now[ref])) continue
    bad.push(ref)
  }
  if (bad.length) throw refused('tampered', `refs changed in the clone ${since}: ${bad.join(', ')}`, { refs: bad })
}

// The facts cloneVerdict judges. dirty is always true: whether anything is left is decided by
// the save under the recorded rules, never by git's standard listing, which a delegate's ignore
// rule can fool.
function factsOf(W) {
  const headRef = symbolicHead(W)
  const tip = revParse(W, 'HEAD^{commit}')
  return {
    exists: true, valid: true, symbolic: headRef !== null, headRef, tip, dirty: true, indexDirty: true,
    isAncestor: (a, b) => isAncestor(W, a, b),
  }
}

// A save's refusal as prepare reports it: index-only and infra (git-too-old, R24) as they are,
// a lost lock or a clone made invalid as they are, anything else save-failed.
function saveError(e) {
  if (e.code === 'NOT_HOLDER' || e.code === 'HOLDER_UNKNOWN' || e.code === 'CLONE_INVALID') return e
  if (e.code === 'REFUSED' && e.state === 'index-only') return refused('index-only', e.detail, e.extra)
  if (e.code === 'REFUSED' && e.state === 'infra') return refused('infra', e.detail, e.extra)
  if (e.code === 'REFUSED') return refused('save-failed', `${e.state}: ${e.detail}`, { reason: e.state, ...(e.extra ?? {}) })
  return refused('save-failed', e.message)
}

function resetError(e) {
  if (e.code === 'NOT_HOLDER' || e.code === 'HOLDER_UNKNOWN' || e.code === 'PARTIAL') return e
  if (e.code === 'REFUSED' && ['busy', 'index-only', 'tampered'].includes(e.state)) return refused(e.state, e.detail, e.extra)
  if (e.code === 'REFUSED') return infra(`reset refused ${e.state}: ${e.detail}`)
  return e
}

// The rules a verdict names: the record's recorded rules, the current ones (a record in which
// no dispatch ran), or, with no record, those the run anchor holds (R25): its recorded rules,
// the current ones when it holds none, the base's only when there is no anchor.
function rulesFor(wt, mode, rec, base, anchor = null) {
  if (!rec) {
    if (anchor?.rules) return anchor.rules
    return anchor ? currentRules(wt, { base }) : baseRules(wt, base)
  }
  if (mode === 'recorded') return rec.rules
  if (mode === 'current') return currentRules(wt, { base })
  return baseRules(wt, base)
}

// The rules object a bundle was saved under, from the copy reflex-bundle keeps next to it.
function bundleRules(paths, sha) {
  const h = readBundle(paths, sha).header
  try {
    const r = JSON.parse(fs.readFileSync(path.join(paths.V, 'patches', `rules-${h.rules.sha}.json`), 'utf8'))
    if (sha256Hex(canonicalJson(r)) === h.rules.sha) return r
  } catch { /* recomputed below */ }
  return null
}

// One recovery (brief 13.3 step 4): r is the record that owns the tree (null for none: N's own
// record is then the anchor), N the holder.
class Recovery {
  constructor(ctx, wt, r) {
    Object.assign(this, ctx)
    this.wt = wt
    this.r = r
    this.g = r ? r.generation : this.N
    this.rulesUsed = null
  }

  assertHeld() { assertHeld(this.paths, this.N, this.env) }

  // Writes the recovery fields of r (by N) with patch applied over them.
  recovery(patch) {
    this.assertHeld()
    updateRecord(this.paths, this.r.generation, rec => {
      const cur = rec.recovery ?? {}
      return {
        ...rec,
        recovery: {
          base: cur.base ?? null, rewind: cur.rewind ?? null, bundles: cur.bundles ?? [], reset_sha: cur.reset_sha ?? null,
          step: cur.step ?? 'done', note: null, ...patch, by: this.N,
        },
      }
    })
  }

  done(base) {
    if (!this.r) return
    const cur = readRecord(this.paths, this.r.generation).recovery
    this.recovery({ base: cur?.base ?? base, step: 'done', note: null })
  }

  // Anchors a saved bundle before any reset: in r's recovery, or in N's own saves.
  anchor(sha, base) {
    if (this.r) {
      const cur = readRecord(this.paths, this.r.generation).recovery
      const bundles = cur?.bundles ?? []
      this.recovery({ base: cur?.base ?? base, bundles: bundles.includes(sha) ? bundles : [...bundles, sha], step: 'saved' })
      return
    }
    this.assertHeld()
    updateRecord(this.paths, this.N, rec => ({
      ...rec, phase: 'saved', base,
      saves: rec.saves.some(s => s.sha === sha) ? rec.saves : [...rec.saves, { sha, why: 'clean-clone' }],
    }))
  }

  save(base, rules, also) {
    try {
      return saveFor(this.paths, {
        saver: this.N, source: this.r ? this.r.generation : null, base, rules, why: 'clean-clone', also, env: this.env,
      })
    } catch (e) {
      throw saveError(e)
    }
  }

  // resetFor with the anchored sha; `unsaved` (a writer since the save) saves again once.
  reset(sha, { base, rules, also, relaxed = false }) {
    try {
      resetFor(this.paths, { holder: this.N, record: this.g, sha, relaxed, also, rules, env: this.env })
      return sha
    } catch (e) {
      if (!(e.code === 'REFUSED' && e.state === 'unsaved')) throw resetError(e)
    }
    const again = this.save(base, rules, also)
    if (again.state !== 'saved') {
      // Nothing left to save after all: only a dirty index can remain.
      if (again.indexDirty) {
        try {
          resetEmpty(this.paths, { holder: this.N, record: this.g, base, also, env: this.env })
        } catch (e) {
          throw resetError(e)
        }
      }
      return sha
    }
    this.anchor(again.sha, base)
    try {
      resetFor(this.paths, { holder: this.N, record: this.g, sha: again.sha, also, rules, env: this.env })
    } catch (e) {
      throw resetError(e)
    }
    return again.sha
  }

  note(sha, rewoundFrom) {
    const h = readBundle(this.paths, sha).header
    this.recovered.push({
      generation: this.r ? this.r.generation : null, sha, why: h.why, files: h.files.length,
      out_of_scope: h.files.filter(f => !f.in_scope).length, hidden: h.files.filter(f => f.hidden).length,
      rewound_from: rewoundFrom ?? null,
    })
  }

  // Save what the clone holds against base, then reset; or reset a dirty index alone.
  leftovers(base, mode, also, rewoundFrom = null) {
    const rules = rulesFor(this.wt, mode, this.r, base, this.runAnchor)
    this.rulesUsed = rules
    const alsoList = present(this.paths.W, also.filter(o => o !== base))
    const res = this.save(base, rules, alsoList)
    if (res.state === 'empty') {
      if (res.indexDirty) {
        try {
          resetEmpty(this.paths, { holder: this.N, record: this.g, base, also: alsoList, env: this.env })
        } catch (e) {
          throw resetError(e)
        }
      }
      this.done(base)
      return
    }
    this.anchor(res.sha, base)
    fault('recover:after-save')
    const sha = this.reset(res.sha, { base, rules, also: alsoList })
    fault('recover:after-reset')
    this.done(base)
    this.note(sha, rewoundFrom)
  }

  // The rewind of a delegate commit: the record first (rewind-intent), the compare-and-swap,
  // the index, then step rewound.
  rewind(v, { intent }) {
    const W = this.paths.W
    const io = indexOnly(this.wt, { base: v.to, also: present(W, v.also) })
    if (io.length) throw refused('index-only', `staged content found nowhere else: ${io.length} path(s)`, { paths: io.slice(0, LIST_MAX) })
    if (!this.r.head_ref) throw infra(`generation ${this.r.generation} has no head_ref to rewind`)
    if (intent) {
      this.recovery({ base: v.to, rewind: { from: v.from, to: v.to }, bundles: [], reset_sha: null, step: 'rewind-intent' })
      fault('recover:after-rewind-intent')
    }
    this.assertHeld()
    const cas = workGitRun(W, ['update-ref', this.r.head_ref, v.to, v.from])
    if (cas.code || cas.status !== 0) throw infra(`the rewind of ${this.r.head_ref} failed: ${cas.error || String(cas.stderr).trim()}`)
    if (indexNeedsReset(W, v.to)) {
      this.assertHeld()
      workGit(W, ['read-tree', v.to])
    }
    this.recovery({ step: 'rewound' })
    fault('recover:after-rewind')
  }

  resume(v, relaxed) {
    const rules = bundleRules(this.paths, v.sha) ?? rulesFor(this.wt, v.rules, this.r, v.base, this.runAnchor)
    this.rulesUsed = rules
    const alsoList = present(this.paths.W, v.also)
    const sha = this.reset(v.sha, { base: v.base, rules, also: alsoList, relaxed })
    fault('recover:after-reset')
    this.done(v.base)
    this.note(sha, this.r?.recovery?.rewind?.from ?? null)
  }

  run() {
    const W = this.paths.W
    const v = cloneVerdict(this.r, factsOf(W))
    const r = this.r
    switch (v.verdict) {
      case 'no-clone':
        throw infra('the clone vanished during prepare')
      case 'unknown':
        throw refused('clone-invalid', `generation ${v.generation ?? 'none'}: the clone cannot be judged (${v.why})`, { problems: [`verdict unknown: ${v.why}`] })
      case 'clean':
        this.rulesUsed = r?.rules ?? null
        this.done(revParse(W, 'HEAD'))
        return
      case 'committed':
        this.assertHeld()
        updateRecord(this.paths, r.generation, rec => ({ ...rec, phase: 'committed', commit: { sha: v.sha } }))
        this.leftovers(v.base, v.rules, v.also)
        return
      case 'delegate-commit':
        this.rewind(v, { intent: true })
        this.leftovers(v.to, v.rules, v.also, v.from)
        return
      case 'rewind':
        this.rewind(v, { intent: false })
        this.leftovers(v.to, v.rules, v.also, v.from)
        return
      case 'leftovers':
        this.leftovers(v.base, v.rules, v.also, r?.recovery?.rewind?.from ?? null)
        return
      case 'resume':
        this.resume(v, false)
        return
      case 'resume-reset':
        this.resume(v, true)
        return
      default:
        throw infra(`unknown verdict ${v.verdict}`)
    }
  }
}

// Step 4: resolve what interrupted firings left. run-record's ownerRecord names the record that
// owns the tree (the newest unresolved one, except that a bare preparing record never takes it
// from an older one); the planner judges the same record. Every other unresolved record is
// marked superseded.
function resolveLeftovers(ctx) {
  const { paths, N, env, notes } = ctx
  const W = paths.W
  const unresolved = listRecords(paths).filter(r => r.generation < N && !isResolved(r))
  const r = ownerRecord(unresolved)
  for (const x of unresolved) {
    if (x === r) continue
    assertHeld(paths, N, env)
    // Laid over x's recovery: updateRecord keeps every anchor (saves, bundles, resets) it holds.
    updateRecord(paths, x.generation, { recovery: { by: N, step: 'done', note: 'superseded' } })
    notes.push(`generation ${x.generation} superseded by generation ${r.generation}`)
  }
  const wt = openWorkTree(paths.P, { env })
  const rec = new Recovery(ctx, wt, r)
  rec.run()
  if (r && !isResolved(readRecord(paths, r.generation))) throw infra(`generation ${r.generation} is still unresolved after recovery`)
  const left = listRecords(paths).filter(x => x.generation < N && !isResolved(x))
  if (left.length) throw infra(`unresolved records remain: ${left.map(x => x.generation).join(', ')}`)
  const head = revParse(W, 'HEAD')
  const rules = rec.rulesUsed ?? currentRules(wt, { base: head })
  const c = collect(wt, { base: head, rules, also: [] })
  if (c.tracked.length || c.untracked.length || c.indexDirty || c.indexOnly.length) {
    const left2 = [...c.tracked, ...c.untracked].slice(0, 5).map(p => JSON.stringify(p)).join(', ')
    throw infra(`the clone is not clean after recovery: ${left2}${c.indexDirty ? ' (the index differs from HEAD)' : ''}`)
  }
}

function validDate(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}

async function prepareCmd(a, env) {
  const N = a.generation
  const prefix = a.prefix
  if (!validPrefix(prefix)) throw usage(`bad --prefix ${JSON.stringify(prefix)}`)
  const date = a.date ?? new Date().toISOString().slice(0, 10)
  if (!validDate(date)) throw usage(`bad --date ${JSON.stringify(date)}`)
  const paths = openPaths(a.P, env)
  assertHeld(paths, N, env)
  process.chdir(paths.V)
  if (readRecord(paths, N)) throw refused('attempt-open', `generation ${N} already prepared its clone (a retry keeps its attempt)`)
  sweepAll(paths.V)
  fault('prepare:after-temps')
  const W = paths.W
  const notes = []
  const recovered = []
  const ctx = { paths, N, env, notes, recovered, runAnchor: null }
  const baseInfo = baseOf(paths, a.base)
  let made = { created: false }
  if (!lstatOrNull(W)) {
    preflight(paths)
    assertHeld(paths, N, env)
    createRecord(paths, N, { phase: 'preparing', pre_head: null })
    fault('prepare:after-preparing')
    for (const x of listRecords(paths).filter(x => x.generation < N && !isResolved(x))) {
      assertHeld(paths, N, env)
      updateRecord(paths, x.generation, { recovery: { by: N, step: 'done', note: 'clone-missing' } })
      notes.push(`clone missing: generation ${x.generation}'s uncommitted work was not saved`)
    }
    made = ensureClone(paths, { generation: N, prefix, date, base: a.base, env })
    notes.push(...made.notes)
  } else {
    const first = checkClone(W)
    if (first.problems.length) throw refused('clone-invalid', first.problems.join('; '), { problems: first.problems })
    const q = await quiesce(W)
    if (!q.quiet) throw refused('not-quiet', q.detail)
    const second = checkClone(W)
    if (second.problems.length) throw refused('clone-invalid', second.problems.join('; '), { problems: second.problems })
    const sw = sweepOthers([W])
    if (sw.state !== 'ok') throw infra(`the sweep for processes in ${W} could not run: ${sw.detail}`)
    if (sw.procs.length) throw refused('busy', `${sw.procs.length} process(es) run in ${W}`, { procs: sw.procs })
    ctx.runAnchor = readAnchor(paths, N)
    tamperCheck(paths, W, ctx.runAnchor)
    assertHeld(paths, N, env)
    const locks = removeGitLocks(W, () => assertHeld(paths, N, env))
    if (locks.length) notes.push(`removed stale git locks: ${locks.join(', ')}`)
    fault('prepare:after-locks')
    const preHead = revParse(W, 'HEAD^{commit}')
    assertHeld(paths, N, env)
    createRecord(paths, N, { phase: 'preparing', pre_head: preHead })
    fault('prepare:after-preparing')
    resolveLeftovers(ctx)
  }

  // Step 5: refresh, bundle sync, rotation.
  let baseSha = made.baseSha
  if (!made.created) {
    assertHeld(paths, N, env)
    baseSha = refresh(paths, W, baseInfo.baseRef)
  }
  const adoptedTips = new Set((made.adopted ?? []).map(x => x.tip))
  const bundles = []
  let sync
  const guard = () => assertHeld(paths, N, env)
  guard()
  try {
    sync = syncBundles(paths, { vetted: vettedFor(paths, adoptedTips), why: 'regenerated', guard })
  } catch (e) {
    if (LOCK_LOST.has(e.code) || e.code === 'CLONE_INVALID') throw e
    throw infra(`bundle sync: ${e.message}`)
  }
  for (const { branch, result } of sync) {
    if (result.state === 'written') bundles.push(bundleRow(paths, result, branch))
    else if (result.state === 'unvetted') notes.push(result.note)
    else if (result.state === 'error') notes.push(`bundle ${branch}: ${result.detail}`)
  }
  const rot = made.created ? made : rotate(paths, W, { prefix, date, generation: N, env, extra: adoptedTips })
  if (!made.created) notes.push(...rot.notes)

  // Step 6: the record. Every field is read first (git and files); the lock is checked right
  // before the write, which is a data-only patch (R31).
  const head = revParse(W, 'HEAD^{commit}')
  const branch = `${prefix}/${date}`
  const fields = {
    phase: 'prepared', branch, head_ref: `refs/heads/${branch}`, base: head, rules: null, intent: null, commit: null,
    refs: refsSnapshot(W).refs, meta_sha: cloneMeta(W), now_sha256: nowSha(paths),
  }
  assertHeld(paths, N, env)
  updateRecord(paths, N, fields)
  fault('prepare:after-record')
  return {
    state: 'ready', W, branch, base: baseInfo.base, baseSha, head, startPoint: rot.startPoint ?? null, chainedFrom: rot.chainedFrom ?? null,
    created: made.created, rotated: Boolean(rot.rotated), retiredReset: Boolean(rot.retiredReset), baseAhead: !isAncestor(W, baseSha, head),
    adopted: made.adopted ?? [], bundles, recovered, notes,
  }
}

// ---------------------------------------------------------------- the attempt's commands

// The attempt open in generation N: its record in phase prepared, the holder checked, cwd <V>.
function openAttempt(a, env) {
  const paths = openPaths(a.P, env)
  assertHeld(paths, a.generation, env)
  process.chdir(paths.V)
  const rec = readRecord(paths, a.generation)
  if (!rec || rec.phase !== 'prepared') {
    throw refused('no-attempt', rec ? `generation ${a.generation}'s record is in phase ${rec.phase}` : `generation ${a.generation} prepared no clone`)
  }
  return { paths, rec, W: paths.W }
}

function lockfiles(W) {
  const rows = []
  for (const name of LOCKFILES) {
    const p = path.join(W, name)
    const st = lstatOrNull(p)
    if (!st) continue
    if (st.isFile()) rows.push([name, sha256Hex(fs.readFileSync(p))])
    else if (st.isSymbolicLink()) rows.push([name, `link:${fs.readlinkSync(p)}`])
  }
  return { names: rows.map(r => r[0]), digest: sha256Hex(canonicalJson(rows)) }
}

function depsCmd(a, env) {
  if (a.mark && a.clear) throw usage('--mark and --clear exclude each other')
  const { paths, rec, W } = openAttempt(a, env)
  if (!gitDirOk(W)) throw refused('clone-invalid', `${W}/.git is not a directory`, { problems: ['.git is not a real directory'] })
  const marker = path.join(W, '.git', MARKER)
  const lf = lockfiles(W)
  const current = `${rec.branch} sha256:${lf.digest}`
  if (a.mark) {
    assertHeld(paths, a.generation, env)
    const tmp = tempFile(path.join(W, '.git'))
    try {
      fs.writeFileSync(tmp.fd, `${current}\n`)
      fs.fsyncSync(tmp.fd)
    } finally {
      fs.closeSync(tmp.fd)
    }
    fs.renameSync(tmp.path, marker)
    return { marked: true, marker: current }
  }
  if (a.clear) {
    assertHeld(paths, a.generation, env)
    fs.rmSync(marker, { force: true })
    return { cleared: true }
  }
  let have = null
  const st = lstatOrNull(marker)
  if (st && st.isFile()) have = fs.readFileSync(marker, 'utf8').trim()
  return { fresh: have === current, marker: have, current, lockfiles: lf.names }
}

function cloneInvalidIf(W) {
  const { problems } = checkClone(W)
  if (problems.length) throw refused('clone-invalid', problems.join('; '), { problems })
}

// The refs of the clone other than head_ref against the record's.
function refsDiffer(rec, W) {
  const now = refsSnapshot(W).refs
  const bad = []
  for (const ref of [...new Set([...Object.keys(now), ...Object.keys(rec.refs)])].sort()) {
    if (ref !== rec.head_ref && now[ref] !== rec.refs[ref]) bad.push(ref)
  }
  return bad
}

// markScope over the touched paths; a path that is not UTF-8 cannot be named by a scope entry.
function scopeOf(paths, W, list) {
  const m = markScope(list.filter(p => typeof p === 'string'), loopMdText(paths), { root: W })
  const outSet = new Set(m.outOfScope)
  const out = list.filter(p => typeof p !== 'string' || outSet.has(p))
  return { scope: { state: m.state, entries: m.entries, digest: m.digest, warnings: m.warnings }, out }
}

function checkCmd(a, env) {
  if (!['deps', 'dispatch', 'verify'].includes(a.after)) throw usage(`bad --after ${JSON.stringify(a.after)}`)
  const { paths, rec, W } = openAttempt(a, env)
  const N = a.generation
  if (a.after !== 'deps' && !rec.rules) throw refused('no-rules', `generation ${N} recorded no ignore rules: run check --after deps first`)
  cloneInvalidIf(W)
  const meta = cloneMeta(W)
  if (meta !== rec.meta_sha && a.after !== 'deps') {
    throw refused('tampered', "the clone's config, .git/info or special files changed since prepare")
  }
  const headRefNow = symbolicHead(W)
  if (headRefNow !== rec.head_ref) throw refused('tampered', `HEAD is ${headRefNow ?? 'detached'}, not ${rec.head_ref}`)
  const badRefs = refsDiffer(rec, W)
  if (badRefs.length) throw refused('tampered', `refs changed in the clone: ${badRefs.join(', ')}`, { refs: badRefs })
  const wt = openWorkTree(paths.P, { env })
  const base = rec.base
  const tip = revParse(W, 'HEAD^{commit}')
  let delegateCommitted = false
  if (tip !== base) {
    if (!tip || !isAncestor(W, base, tip)) throw refused('tampered', `HEAD moved to ${tip}, which does not descend from the base ${base}`)
    const io = indexOnly(wt, { base, also: present(W, [tip, ...knownCommits(rec)].filter(o => o !== base)) })
    if (io.length) throw refused('index-only', `staged content found nowhere else: ${io.length} path(s)`, { paths: io.slice(0, LIST_MAX) })
    assertHeld(paths, N, env)
    updateRecord(paths, N, r => ({ ...r, delegate_commits: r.delegate_commits.includes(tip) ? r.delegate_commits : [...r.delegate_commits, tip] }))
    assertHeld(paths, N, env)
    const cas = workGitRun(W, ['update-ref', rec.head_ref, base, tip])
    if (cas.code || cas.status !== 0) throw refused('tampered', `the rewind of ${rec.head_ref} failed: ${cas.error || String(cas.stderr).trim()}`)
    if (indexNeedsReset(W, base)) {
      assertHeld(paths, N, env)
      workGit(W, ['read-tree', base])
    }
    delegateCommitted = true
    fault('check:after-rewind')
  }
  const cur = readRecord(paths, N)
  const io = indexOnly(wt, { base, also: present(W, knownCommits(cur).filter(o => o !== base)) })
  if (io.length) throw refused('index-only', `staged content found nowhere else: ${io.length} path(s)`, { paths: io.slice(0, LIST_MAX) })
  let unstaged = false
  if (indexNeedsReset(W, base)) {
    assertHeld(paths, N, env)
    workGit(W, ['read-tree', base])
    unstaged = true
  }
  const t = touched(wt, { base, rules: a.after === 'deps' ? null : cur.rules })
  if (t.unsavable.length) throw refused('unsavable', `${t.unsavable.length} path(s) cannot be saved`, { paths: t.unsavable.slice(0, LIST_MAX) })
  if (a.after === 'deps') {
    if (t.paths.length) throw refused('deps-dirty', `the dependency preparation changed ${t.paths.length} path(s)`, { paths: t.paths.slice(0, LIST_MAX) })
    const rules = cur.rules ?? recordRules(wt, { base })
    assertHeld(paths, N, env)
    updateRecord(paths, N, r => ({ ...r, rules, meta_sha: meta }))
  }
  const { scope, out } = scopeOf(paths, W, t.paths)
  const tc = capped(t.paths)
  const hc = capped(t.hidden)
  const oc = capped(out)
  return {
    state: 'ok', after: a.after, head: revParse(W, 'HEAD^{commit}'), delegateCommitted, delegateCommits: readRecord(paths, N).delegate_commits,
    unstaged, touched: tc.shown, hidden: hc.shown, out_of_scope: oc.shown, scope, digest: t.digest,
    counts: { touched: t.paths.length, hidden: t.hidden.length, out_of_scope: out.length },
  }
}

function readSubject(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw usage(`cannot read the subject file ${file}: ${e.code || e.message}`)
  }
  return text
}

function commitCmd(a, env) {
  if (!SHA_RE.test(a.digest)) throw usage('--digest must be 64 hex digits')
  const subject = readSubject(a['subject-file'])
  const { paths, rec, W } = openAttempt(a, env)
  const N = a.generation
  const message = commitMessage({ subject, generation: N })
  cloneInvalidIf(W)
  if (cloneMeta(W) !== rec.meta_sha) throw refused('tampered', "the clone's config, .git/info or special files changed since the last check")
  const headRefNow = symbolicHead(W)
  if (headRefNow !== rec.head_ref) throw refused('tampered', `HEAD is ${headRefNow ?? 'detached'}, not ${rec.head_ref}`)
  const H0 = rec.base
  const tip = revParse(W, 'HEAD^{commit}')
  if (tip !== H0) throw refused('tampered', `HEAD moved to ${tip}: check was not run`)
  const badRefs = refsDiffer(rec, W)
  if (badRefs.length) throw refused('tampered', `refs changed in the clone: ${badRefs.join(', ')}`, { refs: badRefs })
  const wt = openWorkTree(paths.P, { env })
  const t = touched(wt, { base: H0, also: present(W, knownCommits(rec).filter(o => o !== H0)) })
  if (t.digest !== a.digest) throw refused('work-changed', 'the touched set differs from the one check reported')
  if (!t.paths.length) {
    assertHeld(paths, N, env)
    updateRecord(paths, N, r => ({ ...r, phase: 'clean' }))
    return { state: 'unchanged' }
  }
  const { out } = scopeOf(paths, W, t.paths)
  if (out.length) throw refused('out-of-scope', `${out.length} touched path(s) are out of scope`, { paths: out.slice(0, LIST_MAX) })
  if (t.unsavable.length) throw refused('work-changed', `${t.unsavable.length} path(s) cannot be committed`, { paths: t.unsavable.slice(0, LIST_MAX) })
  if (t.indexOnly.length) throw refused('index-only', `staged content found nowhere else: ${t.indexOnly.length} path(s)`, { paths: t.indexOnly.slice(0, LIST_MAX) })
  let ident
  try {
    ident = identityOf(paths.R)
  } catch (e) {
    throw refused('commit-failed', `no git identity in ${paths.R}: ${String(e.stderr || e.message).trim().split('\n')[0]}`)
  }
  const T = t.tree
  let C
  try {
    C = workGit(W, ['commit-tree', T, '-p', H0, '-F', '-'], { input: message, env: ident }).trim()
  } catch (e) {
    throw refused('commit-failed', `git commit-tree: ${String(e.stderr || e.message).trim()}`)
  }
  const guard = () => assertHeld(paths, N, env)
  guard()
  updateRecord(paths, N, r => ({ ...r, phase: 'intent', intent: { tree: T, parent: H0, commit: C } }))
  fault('commit:after-intent')
  guard()
  workGit(W, ['read-tree', C])
  guard()
  const cas = workGitRun(W, ['update-ref', rec.head_ref, C, H0])
  if (cas.code || cas.status !== 0) {
    guard()
    workGit(W, ['read-tree', H0])
    guard()
    updateRecord(paths, N, r => ({ ...r, phase: 'prepared', intent: null }))
    throw refused('commit-failed', `update-ref ${rec.head_ref}: ${cas.error || String(cas.stderr).trim()}`)
  }
  fault('commit:after-update-ref')
  guard()
  updateRecord(paths, N, r => ({ ...r, phase: 'committed', commit: { sha: C }, refs: { ...r.refs, [r.head_ref]: C } }))
  fault('commit:after-record')
  let bundle = null
  let bundleError = null
  try {
    const w = writeBundle(paths, rec.branch, { why: 'commit', tip: C, guard })
    if (!w.empty) bundle = bundleRow(paths, w, rec.branch)
  } catch (e) {
    // A lost lock is no bundle error: the commit stands, and nothing more is written (R31).
    if (LOCK_LOST.has(e.code)) throw e
    bundleError = e.message
  }
  return { state: 'committed', sha: C, branch: rec.branch, bundle, bundleError }
}

// ---------------------------------------------------------------- bundle and close

// The branch's tip when a bundle of it may be written: not retired, vetted; else null and why.
function deliverable(paths, W, branch, vetted) {
  const ref = `refs/heads/${branch}`
  const tip = revParse(W, `${ref}^{commit}`)
  if (!tip) return { tip: null, why: `${ref} is not a branch of the clone` }
  const prefix = branch.slice(0, branch.lastIndexOf('/'))
  const gitW = (args, opts) => workGit(W, args, opts)
  if (retiredRefs(gitW, prefix, BASE_REF, retiredTips(W)).has(ref)) return { tip: null, why: `${branch} at ${short(tip)} is comparable with a retired tip` }
  const inBase = isAncestor(W, tip, BASE_REF)
  if (!inBase && !vetted({ branch, ref, tip })) return { tip: null, why: `${branch} at ${short(tip)} is not vetted` }
  return { tip, why: null }
}

function bundleCmd(a, env) {
  const paths = openPaths(a.P, env)
  assertHeld(paths, a.generation, env)
  process.chdir(paths.V)
  try {
    bundlePath(paths, a.branch)
  } catch (e) {
    throw usage(e.message)
  }
  const W = paths.W
  cloneInvalidIf(W)
  const d = deliverable(paths, W, a.branch, vettedFor(paths))
  if (!d.tip) throw refused('unvetted', d.why)
  const cur = bundleCurrent(paths, a.branch, d.tip)
  if (cur.current) return { state: 'current', file: path.relative(paths.V, bundlePath(paths, a.branch)) }
  const guard = () => assertHeld(paths, a.generation, env)
  guard()
  const w = writeBundle(paths, a.branch, { why: 'regenerated', tip: d.tip, guard })
  if (w.empty) return { state: 'current', empty: true }
  return { state: 'bundled', bundle: bundleRow(paths, w, a.branch) }
}

function allLedgered(rec, ledger) {
  if (rec.commit?.sha && !ledger.commits.has(rec.commit.sha)) return false
  if (rec.saves.some(s => !ledger.saves.has(s.sha))) return false
  return (rec.recovery?.bundles ?? []).every(b => ledger.saves.has(b))
}

// R32 (adopted-tip continuity): the `adopted` entries of rec that nothing else vets yet. An entry
// is settled once a ledger row names its tip as a commit or a delivery bundle tip, or the base
// contains it (inBase: refs/tech-lead/base in <W>, judged only with clone facts). The creating
// record is the only vetting evidence of an adopted tip until then (R28), so close keeps it.
function openAdoptions(rec, ledger, inBase) {
  return (rec.adopted ?? []).filter(a => !ledger.commits.has(a.tip) && !ledger.tips.has(a.tip) && !inBase(a.tip))
}

const sameRefs = (a, b) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

// What an own record's clone still holds, judged under the record's rules (its recorded ones,
// else the current ones): null when the clone is clean at the record's tip (its base, or its
// commit once committed) with HEAD on head_ref; 'hidden' when a committed record's tree holds only
// untracked files (what the recorded rules list and its commit left out, R2); else 'dirty'.
function leftAtClose(paths, rec, env) {
  const W = paths.W
  const at = rec.phase === 'committed' ? committedSha(rec) : rec.base
  if (!at || revParse(W, 'HEAD^{commit}') !== at || symbolicHead(W) !== rec.head_ref) return 'dirty'
  const wt = openWorkTree(paths.P, { env })
  const c = collect(wt, { base: at, rules: rec.rules ?? currentRules(wt, { base: at }), also: [] })
  if (c.tracked.length || c.indexDirty || c.indexOnly.length) return 'dirty'
  if (c.untracked.length) return rec.phase === 'committed' ? 'hidden' : 'dirty'
  return null
}

// True when every ignore file `rules` names is a blob in <W>: listing replays them from the
// object store, and refuses rules whose blobs are gone (a clone set aside and made again, or
// loose blobs gc pruned), so such rules are never carried.
function rulesInClone(W, rules) {
  if (!rules) return false
  return present(W, rules.ignores.map(i => i.oid), 'blob').length === new Set(rules.ignores.map(i => i.oid)).size
}

// The rules the run anchor carries (R25): those of the newest record being closed that recorded
// any, else the previous anchor's, else null; in each case only rules the clone can replay.
function anchorRules(paths, N, closing) {
  for (let i = closing.length - 1; i >= 0; i--) if (rulesInClone(paths.W, closing[i].rules)) return closing[i].rules
  const prev = readAnchor(paths, N + 1)?.rules ?? null
  return rulesInClone(paths.W, prev) ? prev : null
}

// Records are taken oldest first; once one is kept every newer one is kept too, so the newest
// record on disk is always the newest record snapshot of the clone's refs. Before the first
// deletion, a close that read clone facts writes the run anchor (generation N, the refs it read
// after the bundle refresh, and the rules of anchorRules), so the snapshot and the rules outlive
// the records (prepare's tamper check and its no-record listing). Clone facts need N's own
// record past preparing, a clone that checks, and a quiet quiesce. N's own committed record is
// kept while its tree still holds files (reason hidden or dirty), so the next prepare saves them
// under its recorded rules (R25). A record that nothing else would keep but whose adopted tips
// are not yet ledgered or in the base is kept with reason adopted (R32); it alone holds back no
// newer record: it is kept only as vetting evidence, and the anchor this close writes (newer than
// it) is what the next prepare's tamper check reads.
async function closeCmd(a, env) {
  const paths = openPaths(a.P, env)
  const N = a.generation
  assertHeld(paths, N, env)
  process.chdir(paths.V)
  const all = listRecords(paths)
  const recs = all.filter(r => r.generation <= N)
  const own = recs.find(r => r.generation === N) ?? null
  const W = paths.W
  const valid = () => checkClone(W).problems.length === 0
  let facts = Boolean(own && own.phase !== 'preparing' && lstatOrNull(W) && gitDirOk(W) && valid())
  // Codex may still write in <W> (a quiesce of this firing that was not quiet): close reads
  // nothing there until a quiesce of its own is quiet and the clone still checks (brief 13.9).
  if (facts) facts = (await quiesce(W)).quiet && valid()
  const ledger = ledgerShas(paths.S)
  const errors = []
  let snapshot = null
  // Base containment of an adopted tip (R32), read only with clone facts; a check that cannot be
  // made (a missing object, an unsafe merge driver) reads as not contained, so the record stays.
  const contained = new Map()
  const inBase = tip => {
    if (!facts) return false
    if (!contained.has(tip)) {
      let yes = false
      try {
        yes = isAncestor(W, tip, BASE_REF) || containedIn((args, opts) => workGit(W, args, opts), BASE_REF, tip)
      } catch (e) {
        if (LOCK_LOST.has(e.code)) throw e
      }
      contained.set(tip, yes)
    }
    return contained.get(tip)
  }
  if (facts) {
    const vetted = vettedFor(paths)
    const branches = [...new Set(recs.filter(r => r.commit?.sha && r.branch).map(r => r.branch))]
    for (const branch of branches) {
      try {
        const d = deliverable(paths, W, branch, vetted)
        if (!d.tip) continue
        if (bundleCurrent(paths, branch, d.tip).current) continue
        const guard = () => assertHeld(paths, N, env)
        guard()
        writeBundle(paths, branch, { why: 'regenerated', tip: d.tip, guard })
      } catch (e) {
        if (LOCK_LOST.has(e.code)) throw e
        errors.push(`${branch}: ${e.message}`)
      }
    }
    snapshot = refsSnapshot(W).refs
  }
  const newest = recs[recs.length - 1]
  const closing = []
  const kept = []
  let blocked = false
  for (const rec of recs) {
    let reason = null
    let dirty = false
    const isOwn = rec.generation === N
    let done = isResolved(rec) || (isOwn && rec.phase === 'clean')
    if (!done && isOwn && (rec.phase === 'prepared' || rec.phase === 'committed')) {
      const left = facts ? leftAtClose(paths, rec, env) : 'no-clone-facts'
      if (left === null) done = true
      else {
        reason = left
        dirty = left !== 'no-clone-facts'
      }
    }
    if (!reason && !done) reason = 'unresolved'
    if (!reason && !allLedgered(rec, ledger)) reason = 'unledgered'
    if (!reason && rec === newest) {
      if (!facts) reason = 'no-clone-facts'
      else if (!sameRefs(rec.refs, snapshot)) reason = 'refs-mismatch'
    }
    if (!reason && blocked) reason = 'older-kept'
    if (!reason && openAdoptions(rec, ledger, inBase).length) reason = 'adopted'
    if (reason) {
      kept.push({ generation: rec.generation, dirty, reason })
      if (reason !== 'adopted') blocked = true
      continue
    }
    closing.push(rec)
  }
  const closed = []
  if (facts && closing.length) {
    const rules = anchorRules(paths, N, closing)
    assertHeld(paths, N, env)
    writeReplace(anchorFile(paths), { v: 2, generation: N, refs: snapshot, rules })
  }
  for (const rec of closing) {
    assertHeld(paths, N, env)
    deleteRecord(paths, rec.generation)
    closed.push(rec.generation)
    fault('close:after-delete-one')
  }
  for (const rec of all) if (rec.generation > N) kept.push({ generation: rec.generation, dirty: false, reason: 'newer' })
  return { state: 'closed', closed, kept, ...(errors.length ? { bundleError: errors.join('; ') } : {}) }
}

// ---------------------------------------------------------------- git passthrough

function passRefusal(arg) {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0]
    if (!name) return null
    for (const f of FORBIDDEN_LONG) {
      if (name.startsWith(f)) return `--${name} is not allowed`
      if (f.startsWith(name) && !LONG_EXACT_OK.has(name)) return `--${name} abbreviates --${f}, which is not allowed`
    }
    return null
  }
  if (arg.startsWith('-') && arg.length > 1 && arg.slice(1).includes('O')) return `${arg}: -O is not allowed`
  return null
}

function gitPassthrough(argv, env, trace = {}) {
  const refuse = detail => {
    process.stderr.write(`loop-clone git: ${JSON.stringify({ state: 'refused', detail })}\n`)
    return 2
  }
  const [P, sep, sub, ...rest] = argv
  if (!P || sep !== '--') return refuse('usage: loop-clone.mjs git <P> -- <subcommand> [args...]')
  if (!sub || !PASSTHROUGH.includes(sub)) return refuse(`${JSON.stringify(sub ?? '')} is not a read-only subcommand the passthrough allows (${PASSTHROUGH.join(', ')})`)
  for (const arg of rest) {
    if (arg === '--' || arg === '--end-of-options') break
    const why = passRefusal(arg)
    if (why) return refuse(why)
  }
  let paths
  try {
    paths = openPaths(P, env)
  } catch (e) {
    return refuse(e.message)
  }
  const { problems } = checkClone(paths.W)
  if (problems.length) return refuse(`clone-invalid: ${problems.join('; ')}`)
  // diff, log and show get --no-ext-diff --no-textconv from workGit itself.
  const args = sub === 'blame' ? [sub, '--no-textconv', ...rest] : [sub, ...rest]
  const r = workGitRun(paths.W, args, { outFd: 1, env: trace })
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.code === 'CLONE_INVALID') return refuse(r.error)
  if (r.code) {
    process.stderr.write(`loop-clone git: ${JSON.stringify({ state: 'error', detail: r.error })}\n`)
    return 2
  }
  return r.status ?? 128
}

// ---------------------------------------------------------------- CLI

const USAGE = 'usage: loop-clone.mjs prepare <P> --generation <N> --prefix <p> [--base <b>] [--date YYYY-MM-DD] | '
  + 'deps <P> --generation <N> [--mark | --clear] | check <P> --generation <N> --after deps|dispatch|verify | '
  + 'commit <P> --generation <N> --digest <64hex> --subject-file <file> | bundle <P> --generation <N> --branch <b> | '
  + 'close <P> --generation <N> | git <P> -- <subcommand> [args...]'

const COMMANDS = {
  prepare: { flags: ['generation', 'prefix'], optional: ['base', 'date'], bools: [], run: prepareCmd },
  deps: { flags: ['generation'], optional: [], bools: ['mark', 'clear'], run: depsCmd },
  check: { flags: ['generation', 'after'], optional: [], bools: [], run: checkCmd },
  commit: { flags: ['generation', 'digest', 'subject-file'], optional: [], bools: [], run: commitCmd },
  bundle: { flags: ['generation', 'branch'], optional: [], bools: [], run: bundleCmd },
  close: { flags: ['generation'], optional: [], bools: [], run: closeCmd },
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
    if (k in opts) return null
    if (cmd.bools.includes(k)) {
      opts[k] = true
      continue
    }
    if (![...cmd.flags, ...cmd.optional].includes(k) || i + 1 >= rest.length) return null
    opts[k] = rest[++i]
  }
  if (pos.length !== 1 || cmd.flags.some(k => opts[k] === undefined)) return null
  if (!GENERATION.test(opts.generation) || !Number.isSafeInteger(Number(opts.generation))) return null
  opts.generation = Number(opts.generation)
  return { cmd: argv[0], run: cmd.run, P: pos[0], ...opts }
}

// git-safe scrubs git's trace variables from every helper git call and pins the three trace2
// targets off (checkClone would read their stderr as a problem). The passthrough hands the
// caller's own back to the caller's git command, through workGit's env option, which is set
// after the scrub: a pin the caller does not override is unset, so trace2 from the caller's
// config reaches that command as it reaches the caller's own git.
const TRACE2_TARGETS = ['GIT_TRACE2', 'GIT_TRACE2_PERF', 'GIT_TRACE2_EVENT']
function traceEnv(env) {
  return {
    ...Object.fromEntries(TRACE2_TARGETS.map(k => [k, undefined])),
    ...Object.fromEntries(Object.entries(env).filter(([k]) => /^GIT_TRACE/.test(k))),
  }
}

export async function main(argv, env = process.env) {
  if (argv[0] === 'git') return gitPassthrough(argv.slice(1), env, traceEnv(env))
  const print = o => process.stdout.write(`${JSON.stringify(o)}\n`)
  const a = parseArgs(argv)
  if (!a) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    print(await a.run(a, env))
    return 0
  } catch (e) {
    if (e.code === 'NOT_HOLDER') {
      print({ state: 'not-holder', detail: e.message, ...(e.reason ? { reason: e.reason } : {}) })
      return 3
    }
    if (e.code === 'REFUSED') {
      print({ ...(isPlain(e.extra) ? e.extra : {}), state: e.state, detail: e.detail })
      return 3
    }
    if (e.code === 'CORRUPT') {
      print({ state: 'corrupt', detail: e.message })
      return 3
    }
    if (e.code === 'UNSAFE_CONFIG') {
      // loop-start's containment check met a merge driver it cannot empty: an owner config fix.
      print({ state: 'infra', detail: e.message })
      return 3
    }
    if (e.code === 'CLONE_INVALID') {
      // git-safe refused <W> mid-command (its storage changed after this helper checked it).
      print({ state: 'clone-invalid', detail: e.message, problems: [e.message] })
      return 3
    }
    if (e.code === 'PARTIAL') {
      print({ state: 'error', partial: true, detail: e.message })
      return 2
    }
    if (e.code === 'USAGE') {
      print({ state: 'error', detail: `${e.message}; ${USAGE}` })
      return 2
    }
    print({ state: 'error', detail: e.message })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
