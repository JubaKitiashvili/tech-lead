#!/usr/bin/env node
// scripts/loop-recover.mjs
// Recovery planning for a firing that follows an interrupted one (stage 0c-1, read-only
// skeleton). It reports what the interrupted firing left behind and which recovery
// actions the loop should take, in a fixed order; it carries out none of them and writes
// nothing (git runs through safeGit with --no-optional-locks, so not even the index's
// stat cache is refreshed). Later stages add bundle and commit-trailer actions.
//   requeue-now      `## Now` in <S>/STATE.md holds an item (loop section 1 step 4)
//   reset-worktree   the worktree has staged changes or changes to tracked files
//                    (worktree.md step 2); untracked files are listed, never acted on
//
// Usage: node loop-recover.mjs <P> --worktree <dir> [--reclaimed <N>]
//   exit 0 prints {reclaimed, now, worktree: {exists, staged, tracked, untracked}, actions}
//   exit 2 prints {state:'error', detail}: usage, <P> not a repository top level, no
//   STATE.md, or a worktree path that is not the top level of its own working tree (git
//   would then answer for the enclosing repository, and a reset would hit <P>)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopPaths } from './lib/loop-paths.mjs'
import { safeGit } from './lib/git-safe.mjs'

export const ACTIONS = ['requeue-now', 'reset-worktree']

const firstLine = s => String(s).trim().split('\n')[0]
const SECTION_END = /^#{1,2}(?:[ \t]|$)/
const PLACEHOLDER = '(empty)'

// The first non-blank line of the `## Now` section, trimmed; null when the section is
// missing, blank or holds only the template's `(empty)`. The section ends at the next
// level-1 or level-2 heading.
export function nowLine(text) {
  const lines = String(text).split(/\r?\n/)
  const at = lines.findIndex(l => /^## Now[ \t]*$/.test(l))
  if (at < 0) return null
  for (const l of lines.slice(at + 1)) {
    if (SECTION_END.test(l)) return null
    const s = l.trim()
    if (s && s !== PLACEHOLDER) return s
  }
  return null
}

// Facts about the worktree at dir. A missing directory is a fact (exists: false), not an
// error. An existing one must be the top level of its own working tree and must not be the
// project R itself.
export function worktreeFacts(dir, R) {
  const none = { exists: false, staged: false, tracked: false, untracked: [] }
  let st
  try {
    st = fs.statSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return none
    throw new Error(`not-a-worktree: ${dir}: ${e.code || e.message}`)
  }
  if (!st.isDirectory()) throw new Error(`not-a-worktree: ${dir} is not a directory`)
  const real = fs.realpathSync.native(dir)
  if (real === R) throw new Error(`worktree-is-project: ${dir} is the project ${R} itself`)
  let top
  try {
    top = fs.realpathSync.native(safeGit(real, ['rev-parse', '--show-toplevel']))
  } catch (e) {
    throw new Error(`not-a-worktree: ${real}: ${firstLine(e.stderr || e.message)}`)
  }
  if (top !== real) throw new Error(`not-a-worktree: ${real} is inside ${top}`)

  // Porcelain v1 with -z: `XY path` entries separated by NUL; a rename or copy entry is
  // followed by one more field, its source path. status compares content where the stat
  // data is stale, so a touched but unchanged file is clean; --no-optional-locks keeps it
  // from writing the refreshed index back.
  const fields = safeGit(real, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall']).split('\0')
  const facts = { exists: true, staged: false, tracked: false, untracked: [] }
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i]
    if (!e) continue
    const x = e[0], y = e[1], file = e.slice(3)
    if (x === '?' && y === '?') {
      facts.untracked.push(file)
      continue
    }
    if (x === '!' && y === '!') continue
    if (x !== ' ') facts.staged = true
    if (y !== ' ') facts.tracked = true
    if ('RC'.includes(x) || 'RC'.includes(y)) i++
  }
  return facts
}

// The recovery plan for project P. Reads <S>/STATE.md and the worktree; writes nothing.
export function recoverPlan(P, { worktree, reclaimed = null, env = process.env } = {}) {
  const { R, S } = loopPaths(P, { env })
  const file = path.join(S, 'STATE.md')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no-state: ${file} is missing`)
    throw e
  }
  const now = nowLine(text)
  const facts = worktreeFacts(path.resolve(worktree), R)
  const actions = ACTIONS.filter(a => (a === 'requeue-now' ? now !== null : facts.staged || facts.tracked))
  return { reclaimed, now, worktree: facts, actions }
}

const USAGE = 'usage: loop-recover.mjs <P> --worktree <dir> [--reclaimed <N>]'
const GENERATION = /^[1-9][0-9]*$/

// Exactly one positional <P>, --worktree once, --reclaimed at most once as a positive
// safe integer, nothing else; null on misuse.
function parseArgs(argv) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) pos.push(a)
    else if (['worktree', 'reclaimed'].includes(a.slice(2)) && !(a.slice(2) in opts) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
    else return null
  }
  if (pos.length !== 1 || !opts.worktree) return null
  if ('reclaimed' in opts) {
    if (!GENERATION.test(opts.reclaimed) || !Number.isSafeInteger(Number(opts.reclaimed))) return null
    opts.reclaimed = Number(opts.reclaimed)
  }
  return { P: pos[0], worktree: opts.worktree, reclaimed: opts.reclaimed ?? null }
}

function main(argv) {
  const print = o => process.stdout.write(`${JSON.stringify(o)}\n`)
  const args = parseArgs(argv)
  if (!args) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    print(recoverPlan(args.P, { worktree: args.worktree, reclaimed: args.reclaimed }))
    return 0
  } catch (e) {
    print({ state: 'error', detail: e.message })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
