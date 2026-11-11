#!/usr/bin/env node
// scripts/hooks/model-switch.mjs
// PostModelSwitch hook, registered by the tech-lead skill's frontmatter once the skill has been
// invoked in a session. Claude Code delivers this script's stdout to the lead with its next
// request, so the lead learns that the session model changed: without it a fallback (for
// example Fable 5.2 to Opus 5.5 after a limit) is invisible to the model, and the lead keeps
// applying the rules of a model it no longer runs on.
//
// stdin: the hook input JSON (from_model, to_model, source). stdout: one short notice, or
// nothing when the input cannot be read or the model did not change. Always exits 0: a hook
// that fails here must never get in the way of the session.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const family = id => {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(String(id || ''))
  return m ? m[1].toLowerCase() : null
}

const HOW = {
  command: 'the user switched it',
  picker: 'the user switched it',
  sdk: 'the client switched it',
  auto: 'an automatic fallback, nobody chose it',
  resume: 'restored when the session resumed',
}

export const notice = input => {
  const from = input && input.from_model
  const to = input && input.to_model
  if (!to || from === to) return ''
  const how = HOW[input.source] || 'source unknown'
  const lines = [
    `[tech-lead] The session model changed: ${from || 'unknown'} -> ${to} (${how}).`,
    'You are the lead on the new model now. Before the next dispatch, re-read "Core principle" in the tech-lead skill and apply the row for this session model. Delegate pins (model and effort on every Agent and agent() call) stay as they are.',
  ]
  const [a, b] = [family(from), family(to)]
  if (a === 'fable' && b && b !== 'fable') {
    lines.push('The Fable rules no longer apply to you: the lead is not on Fable. The earlier turns\' thinking is not readable from here, so rely on what is written in the plan and in the messages.')
  } else if (b === 'fable' && a !== 'fable') {
    lines.push('The Fable rules apply from now on: Fable decides, Opus writes, and no delegate runs on Fable.')
  } else if (b === 'sonnet' || b === 'haiku') {
    lines.push('This model is below the tier the lead role is written for. Tell the user, and keep judgment calls for a fresh-context Opus seat (deep-reasoner) or for the user.')
  }
  if (input.source === 'auto') lines.push('Tell the user about the fallback in your next message, in one line.')
  return lines.join('\n')
}

const main = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let input
  try { input = JSON.parse(raw) } catch { return }
  const text = notice(input)
  if (text) process.stdout.write(text + '\n')
}

// Run only as a script, not when a test imports notice(). realpath on both sides: the plugin
// may sit under a path with spaces or behind a symlink.
const isScript = () => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (isScript()) main().catch(() => {}).finally(() => { process.exitCode = 0 })
