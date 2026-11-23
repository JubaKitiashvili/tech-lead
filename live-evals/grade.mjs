// live-evals/grade.mjs
// Grades one live firing from its run directory: <run>/repo (the project), <run>/cache (the
// loop's work area), <run>/stream.jsonl (the session's events) and <run>/before.json.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseState } from '../scripts/lib/loop-state.mjs'
import { SCENARIOS } from './scenarios.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// What the project looks like to git, the spine left out: HEAD, every ref, and every path
// that differs from HEAD or is untracked or ignored.
export function projectSnapshot(P) {
  // Not trimmed: a porcelain line starts with its two status columns, which may be blank.
  const dirty = execFileSync('git', ['-C', P, 'status', '--porcelain', '--ignored', '--untracked-files=all'], { encoding: 'utf8' }).split('\n')
    .filter(l => l && !l.slice(3).startsWith('.tech-lead/'))
  return { head: git(P, 'rev-parse', 'HEAD'), refs: git(P, 'for-each-ref', '--format=%(refname) %(objectname)'), dirty }
}

export function readStream(file) {
  const events = []
  if (!fs.existsSync(file)) return events
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* a cut-off last line */ }
  }
  return events
}

function facts(run) {
  const P = path.join(run, 'repo'), S = path.join(P, '.tech-lead')
  const before = JSON.parse(fs.readFileSync(path.join(run, 'before.json'), 'utf8'))
  const events = readStream(path.join(run, 'stream.jsonl'))
  const calls = []
  for (const e of events) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue
    for (const c of e.message.content) if (c.type === 'tool_use') calls.push({ name: c.name, input: c.input || {}, lead: !e.parent_tool_use_id })
  }
  const stateText = fs.readFileSync(path.join(S, 'STATE.md'), 'utf8')
  const ledger = fs.readFileSync(path.join(S, 'LEDGER.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => {
    try { return JSON.parse(l) } catch { return { outcome: '(unparsable line)' } }
  })
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(run, 'cache') }
  let lock = null
  try { lock = JSON.parse(execFileSync('node', [path.join(ROOT, 'scripts/loop-lock.mjs'), 'status', P], { encoding: 'utf8', env })) } catch { /* reported by lock-released */ }
  return {
    P, S, before, events, calls, stateText, ledger, lock,
    V: lock ? lock.V : null,
    W: lock ? path.join(lock.V, 'clone') : null,
    state: parseState(stateText),
    loopText: fs.readFileSync(path.join(S, 'LOOP.md'), 'utf8'),
    result: events.filter(e => e.type === 'result').pop() || null,
    after: projectSnapshot(P),
    leadCalls: name => calls.filter(c => c.lead && c.name === name).map(c => c.input),
    bash: () => calls.filter(c => c.name === 'Bash').map(c => String(c.input.command || '')),
  }
}

// The checks every scenario shares.
const COMMON = {
  'run-ended': f => (!f.result ? 'the stream has no result event' : f.result.is_error ? `the session ended in an error (${f.result.subtype})` : null),
  'loop-skill-loaded': f => (f.leadCalls('Skill').some(i => /(^|:)loop$/.test(String(i.skill || ''))) || f.bash().some(c => c.includes('loop-lock.mjs')) ? null
    : 'the loop skill never ran'),
  'helpers-from-this-plugin': f => {
    const other = f.bash().filter(c => /scripts\/(loop-|reflex-)/.test(c) && !c.includes(ROOT))
    return other.length ? `${other.length} helper calls ran from another copy of the plugin, e.g. ${other[0].slice(0, 120)}` : null
  },
  'one-ledger-entry': f => (f.ledger.length === 1 && f.ledger[0].iteration === 1 ? null : `${f.ledger.length} ledger entries, iterations ${JSON.stringify(f.ledger.map(e => e.iteration))}`),
  'lock-released': f => (!f.lock ? 'the lock status could not be read'
    : f.lock.generation !== 1 ? `the lock generation is ${f.lock.generation}`
      : !f.lock.released ? 'generation 1 was never released'
        : f.lock.children.length ? `${f.lock.children.length} child records are left` : null),
  'dispatch-records-balanced': f => {
    const n = re => f.bash().filter(c => re.test(c)).length
    const open = n(/loop-lock\.mjs\s+dispatch\s+open/), close = n(/loop-lock\.mjs\s+dispatch\s+close/)
    return open === close ? null : `${open} dispatch open, ${close} dispatch close`
  },
  'every-dispatch-on-record': f => {
    const open = f.bash().filter(c => /loop-lock\.mjs\s+dispatch\s+open/.test(c)).length
    const sent = f.leadCalls('Agent').length + f.leadCalls('Workflow').length
    return open === sent ? null : `${sent} Agent or Workflow calls, ${open} dispatch records`
  },
  'now-is-empty': f => {
    const m = /^## Now[ \t]*\n([\s\S]*?)^## /m.exec(f.stateText)
    return m && m[1].trim() === '(empty)' ? null : `## Now holds: ${m ? JSON.stringify(m[1].trim().slice(0, 80)) : 'no section'}`
  },
  'state-file-clean': f => (f.state.problems.length ? `STATE.md problems: ${f.state.problems.map(p => p.kind).join(', ')}` : null),
  'last-run-written': f => (/^## Last run[ \t]*\n\(never run\)/m.test(f.stateText) ? '## Last run was not written' : null),
  'project-untouched': f => (f.after.head !== f.before.snapshot.head ? 'HEAD moved in the project'
    : f.after.refs !== f.before.snapshot.refs ? 'a ref changed in the project'
      : f.after.dirty.length ? `the project tree changed: ${f.after.dirty.join(' | ')}` : null),
  'no-push-no-pr': f => {
    const hit = f.bash().find(c => /\bgit\b[^|;&\n]*\bpush\b|\bgh\s+pr\s+(create|merge)\b/.test(c))
    return hit ? `ran: ${hit.slice(0, 120)}` : null
  },
  'no-question': f => (f.calls.some(c => c.name === 'AskUserQuestion') ? 'AskUserQuestion was called' : null),
  'every-agent-pins-a-model': f => {
    const bare = f.leadCalls('Agent').filter(i => !i.model && !String(i.subagent_type || '').startsWith('tech-lead:'))
    return bare.length ? `${bare.length} Agent calls without a model` : null
  },
}

export function grade(run, scenario) {
  const sc = SCENARIOS[scenario]
  if (!sc) throw new Error(`unknown scenario: ${scenario}`)
  const f = facts(run)
  const checks = []
  for (const [name, fn] of [...Object.entries(COMMON), ...Object.entries(sc.checks)]) {
    let detail
    try { detail = fn(f) } catch (err) { detail = `the check threw: ${String(err.message).split('\n')[0]}` }
    checks.push({ name, pass: detail === null, detail })
  }
  const r = f.result || {}
  return {
    scenario,
    pass: checks.every(c => c.pass),
    passed: checks.filter(c => c.pass).length,
    total: checks.length,
    cost_usd: r.total_cost_usd ?? null,
    turns: r.num_turns ?? null,
    seconds: r.duration_ms ? Math.round(r.duration_ms / 1000) : null,
    checks,
  }
}
