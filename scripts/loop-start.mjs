#!/usr/bin/env node
// scripts/loop-start.mjs
// Start point of today's loop branch in the clone (references/clone.md; loop-clone.mjs prepare
// calls resolveBase and chainStart). The branch checked out in <P> plays no part: the start
// point is the newest dated loop branch that still carries work the base lacks, or else the
// base itself.
// Usage: node loop-start.mjs <P> <branch_prefix> [base]
//   prints {"base": ..., "startPoint": <full ref>, "chainedFrom": <branch> | null}
//   exit 2 prints {"error": ...}: no usable base, an infra incident for the loop
// Without [base] (LOOP.md has no `base:` key) the remote's default branch is used.
//
// Exports:
//   validPrefix(prefix) -> boolean
//   defaultBase(repo) -> name | null
//   branchRef(repo, name) -> full ref | null
//   resolveBase(repo, base) -> {base, baseRef}; throws code NO_BASE
//   chainStart(git, prefix, baseRef, {retired, vetted}) -> {startPoint, chainedFrom}
//   containedIn(git, baseRef, ref) -> boolean
//   retiredRefs(git, prefix, baseRef, retired) -> Set of full refs
//   startPoint(repo, prefix, base) -> {base, startPoint, chainedFrom}
// `git` is an injected runner: git(args, opts) runs git with that argument array in one
// repository and returns stdout without its trailing newline; it throws on a non-zero exit
// with `err.status` set, and with `err.code` set when git did not run to an exit (a timeout, a
// spawn failure). opts is git-safe's option object ({env}); a runner should pass it on:
// (args, opts) => safeGit(P, args, opts) and (args, opts) => workGit(W, args, opts). A runner
// that drops it still qualifies: containedIn's safety does not depend on it (see there).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { safeGit } from './lib/git-safe.mjs'

// Plain names only: never a leading `-` that git would read as an option, and never HEAD or
// another pseudo-ref, which would follow whatever is checked out.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const PSEUDO_REF = /^(?:[A-Z_]*HEAD|@)$/
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const tryGit = (repo, args) => {
  try {
    return safeGit(repo, args)
  } catch {
    return null
  }
}

// A branch prefix git accepts as the leading segments of `<prefix>/<YYYY-MM-DD>`: each `/`
// segment starts with a letter or digit, holds only letters, digits, `.`, `_` and `-`, does not
// end in `.lock`; no empty segment and no `..` anywhere (git refuses both in a ref name).
export function validPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix === '' || prefix.includes('..')) return false
  return prefix.split('/').every(s => SEGMENT.test(s) && s !== '.' && s !== '..' && !s.endsWith('.lock'))
}

const badPrefix = prefix => new Error(`branch_prefix ${JSON.stringify(prefix)} is not a plain branch name`)

export function defaultBase(repo) {
  const ref = tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  return ref ? ref.replace(/^origin\//, '') : null
}

// The base as a branch ref: local first, then the remote's.
export function branchRef(repo, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/origin/${name}`]) {
    if (tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) return ref
  }
  return null
}

function noBase(message) {
  const err = new Error(message)
  err.code = 'NO_BASE'
  return err
}

// The base branch name (LOOP.md's `base:`, else the remote's default branch) and its full ref.
export function resolveBase(repo, base) {
  const b = base || defaultBase(repo)
  if (!b) throw noBase('no base: set `base:` in LOOP.md (the remote has no default branch)')
  if (!REF_NAME.test(b) || PSEUDO_REF.test(b)) throw noBase(`base ${JSON.stringify(b)} is not a plain branch name`)
  const baseRef = branchRef(repo, b)
  if (!baseRef) throw noBase(`base ${b} is not a branch in this repository`)
  return { base: b, baseRef }
}

// -c overrides that keep a merge from running any program (review round, Cg2#2 / Cg3#3): no
// attributes file of the user, no renormalization (it runs the clean filter the merged
// .gitattributes selects), and every configured merge driver emptied to `false` (so whatever
// selects one, an attribute in any source, merge.default or another driver's `recursive`, the
// path merges as a conflict, which reads as work the base lacks). A driver name -c cannot carry
// (an `=`, a newline, not UTF-8) throws code UNSAFE_CONFIG before anything merges.
function mergeOverrides(git) {
  let names
  try {
    names = git(['config', '-z', '--name-only', '--get-regexp', '^merge[.].*[.]driver$'])
  } catch (e) {
    if (e && e.code) throw e
    if (e && e.status === 1) names = '' // no driver configured
    else throw e
  }
  const out = ['core.attributesFile=/dev/null', 'merge.renormalize=false']
  for (const key of names.split('\0').filter(Boolean)) {
    const name = key.slice('merge.'.length, -'.driver'.length)
    if (/[=\n\0]/.test(name) || !name.isWellFormed() || name.includes(String.fromCharCode(0xfffd))) {
      throw Object.assign(new Error(`unsafe-config: merge driver ${JSON.stringify(name)} cannot be neutralized for a containment check`), { code: 'UNSAFE_CONFIG' })
    }
    out.push(`merge.${name}.driver=false`)
  }
  return out.flatMap(kv => ['-c', kv])
}

// True when merging `ref` into `baseRef` would change nothing: the base already holds its work,
// as after a squash merge. A merge git refuses or that has conflicts (any exit) counts as work
// the base lacks; a git run that did not finish (err.code) is rethrown. The merge runs nothing
// from either side: mergeOverrides above, plus attributes read from the empty tree
// (GIT_ATTR_SOURCE, GIT_ATTR_NOSYSTEM; passed in opts, for a runner that forwards them), so
// the branch's .gitattributes choose nothing either.
export function containedIn(git, baseRef, ref) {
  const overrides = mergeOverrides(git)
  const emptyTree = git(['hash-object', '-t', 'tree', '/dev/null'])
  let merged
  try {
    merged = git([...overrides, 'merge-tree', '--write-tree', baseRef, ref], { env: { GIT_ATTR_SOURCE: emptyTree, GIT_ATTR_NOSYSTEM: '1' } })
  } catch (e) {
    if (e && e.code) throw e
    return false
  }
  return merged.split('\n')[0] === git(['rev-parse', `${baseRef}^{tree}`])
}

// The dated loop branches (full refs) whose tip is comparable with a retired tip, either an
// ancestor of it, equal to it or a descendant of it, counting only retired tips the base does
// not contain (spec R11). `retired` holds commit names (shas or full refs); one git cannot
// resolve to a commit throws, so a retirement is never silently dropped.
export function retiredRefs(git, prefix, baseRef, retired = []) {
  checkRetired(retired)
  const out = new Set()
  for (const r of retired) {
    let tip
    try {
      tip = git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`])
    } catch (e) {
      if (e && e.code) throw e
      throw new Error(`retired tip ${r} is not a commit in this repository`)
    }
    if (containedIn(git, baseRef, tip)) continue
    for (const how of ['--contains', '--merged']) {
      const refs = git(['for-each-ref', '--format=%(refname)', how, tip, `refs/heads/${prefix}`])
      for (const ref of refs.split('\n')) if (ref) out.add(ref)
    }
  }
  return out
}

function checkRetired(retired) {
  if (!Array.isArray(retired)) throw new TypeError('chainStart: retired must be an array of commit names')
  for (const r of retired) {
    if (typeof r !== 'string' || !REF_NAME.test(r) || PSEUDO_REF.test(r)) {
      throw new TypeError(`chainStart: retired tip ${JSON.stringify(r)} is not a plain commit name`)
    }
  }
}

// The start point for today's branch: the newest dated branch `<prefix>/<YYYY-MM-DD>` that the
// base has not merged and does not contain, that is not comparable with a retired tip, and that
// `vetted({branch, ref, tip})` accepts (every branch when no predicate is given); else baseRef.
// vetted is asked before the containment check, so no content of an unvetted branch is merged.
export function chainStart(git, prefix, baseRef, { retired = [], vetted } = {}) {
  if (!validPrefix(prefix)) throw badPrefix(prefix)
  if (typeof baseRef !== 'string' || !REF_NAME.test(baseRef) || PSEUDO_REF.test(baseRef)) {
    throw new Error(`base ref ${JSON.stringify(baseRef)} is not a plain ref`)
  }
  if (vetted !== undefined && typeof vetted !== 'function') throw new TypeError('chainStart: vetted must be a function')
  checkRetired(retired)
  const heads = `refs/heads/${prefix}/`
  const unmerged = git(['for-each-ref', '--format=%(objectname) %(refname)', '--no-merged', baseRef, `refs/heads/${prefix}`])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const at = line.indexOf(' ')
      return { tip: line.slice(0, at), ref: line.slice(at + 1) }
    })
    .filter(({ ref }) => ref.startsWith(heads) && DATE.test(ref.slice(heads.length)))
    .sort((a, b) => (a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0))
  const skip = retiredRefs(git, prefix, baseRef, retired)
  for (const { tip, ref } of unmerged) {
    if (skip.has(ref)) continue
    const branch = ref.slice('refs/heads/'.length)
    if (vetted && !vetted({ branch, ref, tip })) continue
    if (containedIn(git, baseRef, ref)) continue
    return { startPoint: ref, chainedFrom: branch }
  }
  return { startPoint: baseRef, chainedFrom: null }
}

export function startPoint(repo, prefix, base) {
  if (!validPrefix(prefix)) throw badPrefix(prefix)
  const { base: b, baseRef } = resolveBase(repo, base)
  return { base: b, ...chainStart((args, opts) => safeGit(repo, args, opts), prefix, baseRef) }
}

function main(argv) {
  const [repo, prefix, base] = argv
  if (!repo || !prefix) {
    process.stderr.write('usage: loop-start.mjs <P> <branch_prefix> [base]\n')
    return 2
  }
  try {
    process.stdout.write(JSON.stringify(startPoint(repo, prefix, base)) + '\n')
    return 0
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n')
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
