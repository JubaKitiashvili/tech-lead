// scripts/lib/loop-paths.mjs
// Owner of <key>, <V> and the identity of <V> (spec 3). Every firing of one project,
// through any symlink and whatever branch is checked out, computes the same <key>, so the
// same <V> and the same lock.
//   R       realpath(3) of <P>: symlinks resolved, on-disk case on a case-insensitive volume
//   key     <slug>-<h>: slug from basename(R), h = first 16 hex of SHA-256 over R (UTF-8)
//   V       <TECH_LEAD_CACHE or homedir/.cache>/tech-lead/<key>, the untrusted work area
//   S       R/.tech-lead (governance); W = V/clone (from stage 0c-2); lockDir = V/lock
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExclusive, readJson } from './atomic.mjs'
import { safeGit } from './git-safe.mjs'

const firstLine = s => String(s).trim().split('\n')[0]

// The key of a real path. The slug is the basename lowercased, each character (code
// point) outside [a-z0-9._-] replaced by one `-`, cut to 64, and `project` when empty.
export function keyOf(R) {
  const slug = path.basename(R).toLowerCase().replace(/[^a-z0-9._-]/gu, '-').slice(0, 64) || 'project'
  const h = crypto.createHash('sha256').update(R, 'utf8').digest('hex').slice(0, 16)
  return `${slug}-${h}`
}

// Pure: computes the paths and creates nothing. <P> must be the top level of a git
// working tree (a linked worktree qualifies). git runs through safeGit, so an inherited
// GIT_DIR or GIT_WORK_TREE cannot make a subdirectory or a plain directory pass.
export function loopPaths(P, { env = process.env } = {}) {
  let R
  try {
    R = fs.realpathSync.native(P)
  } catch (e) {
    throw new Error(`not-a-repo: ${P}: ${e.code || e.message}`)
  }
  let out
  try {
    out = safeGit(R, ['rev-parse', '--show-toplevel'])
  } catch (e) {
    throw new Error(`not-a-repo: ${R}: ${firstLine(e.stderr || e.message)}`)
  }
  const top = fs.realpathSync.native(out)
  if (R !== top) throw new Error(`not-toplevel: ${R} is inside ${top}`)
  const cacheRoot = env.TECH_LEAD_CACHE || path.join(os.homedir(), '.cache')
  // A relative root would put <V>, and so the lock, under whatever directory a firing
  // happens to run in: two firings of one project would not share a lock.
  if (!path.isAbsolute(cacheRoot)) throw new Error(`bad-cache: TECH_LEAD_CACHE is not an absolute path: ${cacheRoot}`)
  const key = keyOf(R)
  const V = path.join(cacheRoot, 'tech-lead', key)
  return { P, R, key, S: path.join(R, '.tech-lead'), V, W: path.join(V, 'clone'), lockDir: path.join(V, 'lock') }
}

// Creates <V> and binds it to R through identity.json ({v:1, R}, written exclusively, so
// of two first firings one writes and the other reads). A <V> that records another R is
// refused and left as it is.
export function ensureV(paths) {
  fs.mkdirSync(paths.V, { recursive: true })
  const file = path.join(paths.V, 'identity.json')
  if (createExclusive(file, { v: 1, R: paths.R })) return paths
  const id = readJson(file)
  if (!id || id.R !== paths.R) {
    throw new Error(`identity-mismatch: ${paths.V} belongs to ${id ? id.R : 'nobody (identity.json vanished)'}`)
  }
  return paths
}
