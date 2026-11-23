// tests/hooks/agent-pin.test.mjs
// The PreToolUse hook on Agent: which calls it refuses, that it prints the deny decision Claude
// Code reads and stays silent otherwise, and that the skill's frontmatter registers it by a
// path that exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { INHERITING, REASON, refusal } from '../../scripts/hooks/agent-pin.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'agent-pin.mjs')
const run = stdin => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' })
const call = (tool_input, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input, ...extra })

test('a call that would inherit the session model is refused: no model, on a built-in type or none', () => {
  for (const subagent_type of [...INHERITING, undefined, '']) {
    assert.equal(refusal(call({ subagent_type, description: 'Run checks', prompt: 'x' })), REASON, String(subagent_type))
  }
  assert.equal(refusal(call({ subagent_type: 'general-purpose', model: '  ' })), REASON)
  assert.equal(refusal(call({ subagent_type: 'Explore', model: null })), REASON)
})

test('a call with a model passes, whatever its type', () => {
  for (const subagent_type of [...INHERITING, undefined]) assert.equal(refusal(call({ subagent_type, model: 'sonnet' })), null)
})

test('an agent type that may pin its own model passes without one, and so does a fork', () => {
  for (const subagent_type of ['tech-lead:fast-worker', 'tech-lead:deep-reasoner', 'codex:codex-rescue', 'my-own-agent', 'fork']) {
    assert.equal(refusal(call({ subagent_type })), null, subagent_type)
  }
})

test('a call inside a subagent, another tool, and input without tool_input are left alone', () => {
  assert.equal(refusal(call({ subagent_type: 'general-purpose' }, { agent_id: 'a1' })), null)
  assert.equal(refusal({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null)
  assert.equal(refusal({ tool_name: 'Agent' }), null)
  assert.equal(refusal(null), null)
})

test('the reason tells the lead what to send, and never suggests Fable as a model', () => {
  assert.match(REASON, /`model` and `effort`/)
  assert.match(REASON, /tech-lead:fast-worker/)
  assert.match(REASON, /Never `fable`/)
})

test('the script prints the PreToolUse deny decision for a refused call and exits 0', () => {
  const r = run(JSON.stringify(call({ subagent_type: 'general-purpose', prompt: 'run git log' })))
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
  })
})

test('the script prints nothing and exits 0 for a pinned call and for input it cannot read', () => {
  for (const stdin of [JSON.stringify(call({ subagent_type: 'general-purpose', model: 'haiku' })), '', 'not json', '[]', '{"tool_name":"Agent","tool_input":7}']) {
    const r = run(stdin)
    assert.equal(r.status, 0, stdin)
    assert.equal(r.stdout, '', stdin)
  }
})

test('the skill registers the hook on Agent, by a path that exists', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8')
  const front = skill.slice(0, skill.indexOf('\n---', 4))
  const m = /PreToolUse:\n\s+- matcher: "([^"]+)"\n\s+hooks:\n\s+- type: command\n\s+command: "node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/hooks\/agent-pin\.mjs)\\""/.exec(front)
  assert.ok(m, 'SKILL.md frontmatter has no PreToolUse hook for agent-pin.mjs')
  assert.equal(m[1], 'Agent')
  assert.ok(fs.existsSync(path.join(ROOT, m[2])))
})
