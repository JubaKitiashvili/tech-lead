#!/usr/bin/env node
// scripts/hooks/report-check.mjs
// SubagentStop hook, registered by the tech-lead skill's frontmatter once the skill has been
// invoked in a session. It checks a delegate's final report against the report contract
// (references/briefing-template.md, agents/fast-worker.md) and records what it finds.
//
// OBSERVE MODE. It never blocks and prints nothing: the delegate stops as it would without the
// hook, and the lead sees no extra text. It appends one line per report to a log, so that real
// runs show how often each problem occurs before any of them is turned into a gate. A gate
// would exit 2 with the reason on stderr (Claude Code then keeps the delegate running and hands
// it the reason); exit 1 does not block.
//
// What is stored: the agent type, sizes, and the names of the problems. Never the report text.
//
// stdin: the hook input JSON (agent_type, agent_id, last_assistant_message, session_id).
// Log: $CLAUDE_PLUGIN_DATA/report-checks.jsonl, or ~/.claude/tech-lead/report-checks.jsonl when
// the variable is not set. `node report-check.mjs summary [file]` prints the counts.
// Always exits 0: a hook that fails here must never get in the way of the session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LIMITS = { minChars: 40, maxLines: 120, maxChars: 12000, dumpLines: 40 }

const EVIDENCE = [
  /[\w./@-]+\.[A-Za-z0-9]{1,8}:\d+/, // path/file.ext:12
  /`[^`\n]{3,}`/, // a command or an identifier in backticks
]

// The longest fenced block, in lines.
const longestFence = text => {
  let longest = 0
  let open = -1
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(```|~~~)/.test(lines[i])) continue
    if (open < 0) open = i
    else { longest = Math.max(longest, i - open - 1); open = -1 }
  }
  if (open >= 0) longest = Math.max(longest, lines.length - open - 1)
  return longest
}

// The names of the contract problems in one report. An empty list means none was found.
export const problems = input => {
  const text = String((input && input.last_assistant_message) || '')
  const type = String((input && input.agent_type) || '')
  const body = text.trim()
  // A delegate that hands its report back through SubagentHandback leaves only closing text
  // here, so a short message is recorded under its own name and nothing else is judged.
  if (body.length < LIMITS.minChars) return ['empty']
  const out = []
  if (!EVIDENCE.some(re => re.test(body))) out.push('no-evidence')
  if (/fast-worker$/.test(type) && !/verif/i.test(body)) out.push('no-verification')
  if (body.split('\n').length > LIMITS.maxLines || body.length > LIMITS.maxChars) out.push('long')
  if (longestFence(body) > LIMITS.dumpLines) out.push('dump')
  return out
}

export const record = (input, now) => {
  const text = String((input && input.last_assistant_message) || '').trim()
  return {
    at: now,
    session: String((input && input.session_id) || ''),
    agent_type: String((input && input.agent_type) || ''),
    agent_id: String((input && input.agent_id) || ''),
    chars: text.length,
    lines: text ? text.split('\n').length : 0,
    problems: problems(input),
  }
}

export const logFile = env => path.join(env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'tech-lead'), 'report-checks.jsonl')

// Counts per agent type: reports, reports with a problem, and each problem.
export const summarize = lines => {
  const by = {}
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (!r || !Array.isArray(r.problems)) continue
    const t = (by[r.agent_type || '(none)'] ||= { reports: 0, with_problems: 0, problems: {} })
    t.reports++
    if (r.problems.length) t.with_problems++
    for (const p of r.problems) t.problems[p] = (t.problems[p] || 0) + 1
  }
  return by
}

const main = async () => {
  if (process.argv[2] === 'summary') {
    const file = process.argv[3] || logFile(process.env)
    let raw = ''
    try { raw = fs.readFileSync(file, 'utf8') } catch { /* no log yet */ }
    process.stdout.write(JSON.stringify({ file, by_agent_type: summarize(raw.split('\n').filter(Boolean)) }, null, 2) + '\n')
    return
  }
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  // Claude Code's own internal agents stop with an empty agent_type; they are not delegates.
  if (!input || !input.agent_type) return
  const file = logFile(process.env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record(input, new Date().toISOString())) + '\n')
}

// Run only as a script, not when a test imports it. realpath on both sides: the plugin may sit
// under a path with spaces or behind a symlink.
const isScript = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isScript()) main().catch(() => {}).finally(() => { process.exitCode = 0 })
