#!/usr/bin/env node
// scripts/loop-start.mjs
// Start-point of today's loop branch (loop worktree.md step 1). The branch checked
// out in <P> plays no part: the start-point is the newest dated loop branch not yet
// merged into the base, or else the base itself.
// Usage: node loop-start.mjs <P> <branch_prefix> [base]
//   prints {"base": …, "startPoint": …, "chainedFrom": <branch> | null}
//   exit 2 prints {"error": …}: no usable base, an infra incident for the loop
// Without [base] (LOOP.md has no `base:` key) the remote's default branch is used.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Plain branch names only: never a leading `-` that git would read as an option.
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function defaultBase(repo) {
  try {
    return git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '')
  } catch {
    return null
  }
}

export function startPoint(repo, prefix, base) {
  if (!REF_NAME.test(prefix)) throw new Error(`branch_prefix ${JSON.stringify(prefix)} is not a plain branch name`)
  const b = base || defaultBase(repo)
  if (!b) throw new Error('no base: set `base:` in LOOP.md (the remote has no default branch)')
  if (!REF_NAME.test(b)) throw new Error(`base ${JSON.stringify(b)} is not a plain branch name`)
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', `${b}^{commit}`)
  } catch {
    throw new Error(`base ${b} does not resolve to a commit`)
  }
  const heads = `refs/heads/${prefix}/`
  const unmerged = git(repo, 'for-each-ref', '--format=%(refname)', '--no-merged', b, `refs/heads/${prefix}`)
    .split('\n')
    .filter(ref => ref.startsWith(heads) && DATE.test(ref.slice(heads.length)))
    .map(ref => ref.slice('refs/heads/'.length))
    .sort()
  const newest = unmerged.length ? unmerged[unmerged.length - 1] : null
  return { base: b, startPoint: newest || b, chainedFrom: newest }
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
