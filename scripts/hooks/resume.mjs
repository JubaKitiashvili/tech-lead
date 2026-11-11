#!/usr/bin/env node
// scripts/hooks/resume.mjs
// SessionStart hook (matcher: compact), registered by the tech-lead skill's frontmatter once the
// skill has been invoked in a session. After a compaction the lead has only a summary of the
// run. If the project has an unfinished plan file (scripts/plan-graph.mjs), this prints a short
// notice that Claude Code adds to the lead's context: where the plan is, how far it got, and the
// command that restores it. The plan file is the record; the summary is not.
//
// The project is the first of these with an unfinished plan: the git top level of cwd (when cwd
// is in a working tree), cwd itself, then each ancestor of cwd, at most MAX_UP levels up and
// never the home directory or the filesystem root or above them. A plan can sit at a workspace
// folder holding several repositories, so a session started in one of them finds it. A
// candidate the CLI refuses (a folder below a repository's top level is not-toplevel) is
// skipped. Every child has a timeout and the whole search a deadline (BUDGET_MS).
//
// stdin: the hook input JSON (cwd). stdout: the notice, or nothing when no candidate has an
// unfinished plan, or anything fails. Always exits 0: a hook that fails here must never get in
// the way of the session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'plan-graph.mjs')

const MAX_UP = 6
const BUDGET_MS = 20000

const toplevel = (cwd, timeout) => {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout })
  return r.status === 0 ? r.stdout.trim() : null
}

// The folders to try, in order, without repeats (see the header).
const candidates = (cwd, top, home) => {
  const out = [top, cwd]
  const stops = new Set([home, path.parse(cwd).root].filter(Boolean).map(p => path.resolve(p)))
  let dir = cwd
  for (let i = 0; i < MAX_UP; i++) {
    const up = path.dirname(dir)
    if (up === dir || stops.has(up)) break
    out.push(up)
    dir = up
  }
  return [...new Set(out.filter(Boolean))]
}

// The open run of the project for cwd, as `plan-graph.mjs status` reports it; null when none.
export const openRun = (cwd, env = process.env) => {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
  const deadline = Date.now() + BUDGET_MS
  const left = cap => Math.min(cap, deadline - Date.now())
  const top = toplevel(cwd, left(5000))
  for (const P of candidates(path.resolve(cwd), top, env.HOME || os.homedir())) {
    const timeout = left(10000)
    if (timeout <= 0) return null
    const r = spawnSync(process.execPath, [CLI, 'status', P], { encoding: 'utf8', timeout, env })
    if (r.status !== 0) continue
    let out
    try { out = JSON.parse(r.stdout) } catch { continue }
    if (out && out.state === 'ok' && out.finished === false) return { P, ...out }
  }
  return null
}

const one = s => String(s).replace(/\s+/g, ' ').trim().slice(0, 200)

export const notice = run => {
  if (!run) return ''
  const c = run.counts || {}
  const left = (run.tasks || []).filter(t => t.status !== 'done' && t.status !== 'skipped')
  const lines = [
    `[tech-lead] This project has an unfinished /tech-lead plan: "${one(run.goal)}" (run ${run.run_id}).`,
    `Progress: ${c.done ?? 0} of ${run.total} done, ${c.running ?? 0} running, ${c.failed ?? 0} failed, ${c.pending ?? 0} pending.`,
  ]
  if (left.length) lines.push(`Not finished: ${left.slice(0, 12).map(t => `${t.id} (${t.status})`).join(', ')}${left.length > 12 ? ', …' : ''}.`)
  lines.push(
    'The plan file is the record of this run; the conversation summary is not. Before you dispatch or mark anything, restore it:',
    `node "${CLI}" status "${run.P}"`,
    'A task marked running may have finished or died while the context was compacted: check its result before you mark it.',
  )
  return lines.join('\n')
}

const main = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  const text = notice(openRun(input && input.cwd))
  if (text) process.stdout.write(text + '\n')
}

const isScript = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isScript()) main().catch(() => {}).finally(() => { process.exitCode = 0 })
