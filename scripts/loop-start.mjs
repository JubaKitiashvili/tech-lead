#!/usr/bin/env node
// scripts/loop-start.mjs
// Start-point of today's loop branch (loop worktree.md step 1). The branch checked
// out in <P> plays no part: the start-point is the newest dated loop branch that still
// carries work the base lacks, or else the base itself.
// Usage: node loop-start.mjs <P> <branch_prefix> [base]
//   prints {"base": …, "startPoint": <full ref>, "chainedFrom": <branch> | null}
//   exit 2 prints {"error": …}: no usable base, an infra incident for the loop
// Without [base] (LOOP.md has no `base:` key) the remote's default branch is used.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Plain branch names only: never a leading `-` that git would read as an option, and
// never HEAD or another pseudo-ref, which would follow whatever is checked out.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const PSEUDO_REF = /^(?:[A-Z_]*HEAD|@)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (repo, ...args) => {
  try {
    return git(repo, ...args)
  } catch {
    return null
  }
}

export function defaultBase(repo) {
  const ref = tryGit(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  return ref ? ref.replace(/^origin\//, '') : null
}

// The base as a branch ref: local first, then the remote's.
function branchRef(repo, name) {
  for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/origin/${name}`]) {
    if (tryGit(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null) return ref
  }
  return null
}

// True when merging `ref` into `baseRef` would change nothing: the base already holds its
// work, as after a squash merge. A merge with conflicts counts as work the base lacks.
function containedIn(repo, baseRef, ref) {
  const merged = tryGit(repo, 'merge-tree', '--write-tree', baseRef, ref)
  return merged !== null && merged.split('\n')[0] === git(repo, 'rev-parse', `${baseRef}^{tree}`)
}

export function startPoint(repo, prefix, base) {
  if (!REF_NAME.test(prefix)) throw new Error(`branch_prefix ${JSON.stringify(prefix)} is not a plain branch name`)
  const b = base || defaultBase(repo)
  if (!b) throw new Error('no base: set `base:` in LOOP.md (the remote has no default branch)')
  if (!REF_NAME.test(b) || PSEUDO_REF.test(b)) throw new Error(`base ${JSON.stringify(b)} is not a plain branch name`)
  const baseRef = branchRef(repo, b)
  if (!baseRef) throw new Error(`base ${b} is not a branch in this repository`)
  const heads = `refs/heads/${prefix}/`
  const unmerged = git(repo, 'for-each-ref', '--format=%(refname)', '--no-merged', baseRef, `refs/heads/${prefix}`)
    .split('\n')
    .filter(ref => ref.startsWith(heads) && DATE.test(ref.slice(heads.length)))
    .filter(ref => !containedIn(repo, baseRef, ref))
    .sort()
  const newest = unmerged.length ? unmerged[unmerged.length - 1] : null
  return { base: b, startPoint: newest || baseRef, chainedFrom: newest ? newest.slice('refs/heads/'.length) : null }
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
