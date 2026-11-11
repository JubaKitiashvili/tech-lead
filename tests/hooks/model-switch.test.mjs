// tests/hooks/model-switch.test.mjs
// The PostModelSwitch hook script: what it prints for each kind of switch, that it stays silent
// on input it cannot use, and that the skill's frontmatter registers it by a path that exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { notice } from '../../scripts/hooks/model-switch.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'model-switch.mjs')
const run = stdin => spawnSync(process.execPath, [SCRIPT], { input: stdin, encoding: 'utf8' })

test('an automatic fallback from Fable names both models, drops the Fable rules and asks to tell the user', () => {
  const out = notice({ from_model: 'claude-fable-5-2', to_model: 'claude-opus-5-5', source: 'auto' })
  assert.match(out, /claude-fable-5-2 -> claude-opus-5-5/)
  assert.match(out, /automatic fallback/)
  assert.match(out, /Fable rules no longer apply/)
  assert.match(out, /Tell the user about the fallback/)
})

test('a switch to Fable turns the Fable rules on and does not mention a fallback', () => {
  const out = notice({ from_model: 'claude-opus-5-5', to_model: 'claude-fable-5-2', source: 'command' })
  assert.match(out, /Fable rules apply from now on/)
  assert.doesNotMatch(out, /fallback/)
})

test('a switch to Sonnet or Haiku says the lead is below its tier', () => {
  for (const to of ['claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.match(notice({ from_model: 'claude-opus-5-5', to_model: to, source: 'picker' }), /below the tier/)
  }
})

test('every notice keeps the delegate pins and points at Core principle', () => {
  const out = notice({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5', source: 'resume' })
  assert.match(out, /Core principle/)
  assert.match(out, /Delegate pins/)
  assert.match(out, /restored when the session resumed/)
})

test('no notice when the model did not change or the input has no target model', () => {
  assert.equal(notice({ from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5', source: 'resume' }), '')
  assert.equal(notice({ from_model: 'claude-opus-5-5' }), '')
  assert.equal(notice(null), '')
})

test('as a process: prints the notice for valid input, prints nothing for garbage, exits 0 both times', () => {
  const ok = run(JSON.stringify({ hook_event_name: 'PostModelSwitch', from_model: 'claude-fable-5-2', to_model: 'claude-opus-5-5', source: 'auto' }))
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /^\[tech-lead\] The session model changed/)
  for (const bad of ['', 'not json', '[]']) {
    const r = run(bad)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})

test('as a process: works from a path with a space and through a symlink', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl hook '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const copy = path.join(dir, 'model-switch.mjs')
  fs.copyFileSync(SCRIPT, copy)
  const link = path.join(dir, 'link.mjs')
  fs.symlinkSync(copy, link)
  const input = JSON.stringify({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', source: 'command' })
  for (const p of [copy, link]) {
    const r = spawnSync(process.execPath, [p], { input, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /claude-opus-5-5 -> claude-sonnet-5-5/)
  }
})

test('the root skill registers the hook, and the registered path exists in the plugin', () => {
  const md = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8')
  const fm = md.slice(0, md.indexOf('\n---\n', 4))
  assert.match(fm, /\nhooks:\n {2}PostModelSwitch:\n/)
  const m = /command: "node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)\\""/.exec(fm)
  assert.ok(m, 'the command is node "${CLAUDE_PLUGIN_ROOT}/<path>"')
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1])
})
