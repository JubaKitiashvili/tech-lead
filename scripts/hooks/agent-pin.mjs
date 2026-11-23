#!/usr/bin/env node
// scripts/hooks/agent-pin.mjs
// PreToolUse hook on Agent, registered by the tech-lead skill's frontmatter once the skill has
// been invoked in a session. It refuses an Agent call that would inherit the session's model:
// one with no `model`, for an agent type whose definition pins none. On a Fable session such a
// call runs a helper at the lead's price, and the written rule alone did not stop it
// (evals/README.md, 2026-11-23).
//
// A GATE, unlike report-check.mjs: the refusal costs the lead one retry, and its reason says
// what to send. It refuses only what it is sure of:
//   - the lead's own calls (a call inside a subagent carries agent_id and is left alone);
//   - the built-in types that take the session's model: general-purpose (also the default when
//     subagent_type is missing), Explore, Plan and claude. A plugin's or the user's own agent
//     type may pin a model in its definition, which the hook cannot see, so it passes; so does
//     a fork, which ignores `model`.
//
// stdin: the hook input JSON (tool_name, tool_input, agent_id). stdout: the deny decision, or
// nothing. Always exits 0, and prints nothing on input it cannot read: a hook that fails here
// must never get in the way of the session.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const INHERITING = Object.freeze(['general-purpose', 'Explore', 'Plan', 'claude'])

export const REASON = [
  '[tech-lead] This Agent call has no `model`, so it would run on the session\'s model, the most expensive one on a Fable session.',
  'Send it again with `model` and `effort`: `sonnet` for running commands or reading files, `haiku` for a lookup, `opus` for work that needs judgment. Never `fable`.',
  'To run commands, `subagent_type: "tech-lead:fast-worker"` is already pinned.',
].join(' ')

// The reason to refuse this call, or null to let it through.
export const refusal = input => {
  if (!input || input.tool_name !== 'Agent' || input.agent_id) return null
  const ti = input.tool_input
  if (!ti || typeof ti !== 'object') return null
  if (typeof ti.model === 'string' && ti.model.trim()) return null
  const type = ti.subagent_type == null || ti.subagent_type === '' ? 'general-purpose' : ti.subagent_type
  return INHERITING.includes(type) ? REASON : null
}

const main = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  const reason = refusal(input)
  if (!reason) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n')
}

// Run only as a script, not when a test imports refusal(). realpath on both sides: the plugin
// may sit under a path with spaces or behind a symlink.
const isScript = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isScript()) main().catch(() => {}).finally(() => { process.exitCode = 0 })
