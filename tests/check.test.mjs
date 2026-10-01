// tests/check.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from './helpers.mjs'

const CHECK = path.join(ROOT, 'scripts', 'check.mjs')
const runCheck = root => spawnSync(process.execPath, [CHECK, ...(root ? [root] : [])], { cwd: os.tmpdir(), encoding: 'utf8' })
// A throwaway copy of the plugin, removed when the test ends. Git data, worktrees and
// executor scratch are left out.
const SKIP = new Set(['.git', '.worktrees', '.superpowers'])
const copyRepo = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-check-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.cpSync(ROOT, dir, { recursive: true, filter: src => !SKIP.has(path.basename(src)) })
  return dir
}
// Replace text in a copied file; throws if the text is absent, so a mutation cannot silently miss.
const mutate = (dir, rel, from, to) => {
  const f = path.join(dir, rel), s = fs.readFileSync(f, 'utf8')
  if (!s.includes(from)) throw new Error(`${rel}: mutation anchor not found: ${from}`)
  fs.writeFileSync(f, s.split(from).join(to))
}
const append = (dir, rel, text) => fs.appendFileSync(path.join(dir, rel), text)

test('passes on the plugin repo when run from another directory with no argument', () => {
  const r = runCheck(null)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, / 0 failed,/)
})

test('fails and names the file when a doc references an unknown workflow', t => {
  const dir = copyRepo(t)
  fs.appendFileSync(path.join(dir, 'README.md'), '\nWorkflow({name: "tech-lead:no-such-workflow", args: {}})\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /README\.md: tech-lead:no-such-workflow/)
})

test('fails when a workflow meta is not a pure literal', t => {
  const dir = copyRepo(t)
  const f = path.join(dir, 'workflows', 'triage.js')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("name: 'triage'", 'name: `triage`'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL compile workflows\/triage\.js/)
})

test('fails when the panel skill drops an agreement value', t => {
  const dir = copyRepo(t)
  const f = path.join(dir, 'skills', 'panel', 'SKILL.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(' | no-seats>', '>'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL enum: panel agreement, skills\/panel\/SKILL\.md present shape/)
})

test('fails when panel.js stops passing its schema to seat A', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', 'schema: VERDICT, ', '')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL contract: Panel verdict == panel\.js VERDICT\n\s+panel\.js passed no schema/)
})

test('fails when triage.js stops passing its schema', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/triage.js', 'schema: TRIAGE, ', '')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL contract: Triage verdict == triage\.js TRIAGE/)
})

test('reports a probe that throws as a FAIL line and still runs the other checks', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', "const seatModel = A.seatModel || 'opus'", "if (!A.question) throw new Error('args.question is required')\nconst seatModel = A.seatModel || 'opus'")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL probe workflows\/panel\.js\n\s+args\.question is required/)
  assert.match(r.stdout, /\d+ passed, \d+ failed, \d+ warnings/)
})

test('fails when a workflow defaults to or allows fable, in any expression', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', "A.seatModel || 'opus'", "A.seatModel || 'fable'")
  mutate(dir, 'workflows/research.js', "['opus', 'sonnet', 'haiku']", "['opus', 'sonnet', 'haiku', 'fable']")
  mutate(dir, 'workflows/triage.js', "model: 'haiku'", "model: ['claude-fable-5-1'][0]")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = r.stdout.split('FAIL models: no agent or workflow names fable or best')[1] || ''
  for (const f of ['panel', 'research', 'triage']) assert.match(block, new RegExp(`workflows/${f}\\.js`))
})

test('fails when an agent names fable in quoted frontmatter', t => {
  const dir = copyRepo(t)
  mutate(dir, 'agents/fast-worker.md', 'model: sonnet', "model: 'fable'")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL models: no agent or workflow names fable or best')[1] || '', /agents\/fast-worker\.md/)
})

test('fails when a probed agent() call dispatches fable through a variable', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/triage.js', "model: 'haiku'", "model: ['fa', 'ble'].join('')")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL models: no probed agent\(\) call dispatches fable or best/)
})

test('documented args: values are not keys, the last shorthand key counts, an unclosed quote is reported', t => {
  const dir = copyRepo(t)
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:panel-seats", args: {briefPath: "/b.md", seatModel: sonnet, options}})\n')
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:panel-seats", args: {briefPath, bogus}})\n')
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:triage", args: {item: "unterminated\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = r.stdout.split('FAIL args:')[1] || ''
  assert.match(block, /tech-lead:panel-seats args\.bogus is never read/)
  assert.match(block, /tech-lead:triage args block is not terminated/)
  assert.doesNotMatch(block, /args\.(sonnet|lead|tiered)\b/)
})

test('agentType and Workflow names are checked in either quote style', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/fanout.js', "agentType: 'tech-lead:fast-worker'", 'agentType: "tech-lead:missing-agent"')
  append(dir, 'README.md', "\nWorkflow({name: 'tech-lead:panel', args: {}})\n")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL names: every agentType in workflows is a plugin agent or an external agent\n\s+fanout\.js: tech-lead:missing-agent/)
  assert.match(r.stdout, /README\.md: tech-lead:panel\b/)
})

test('research SKILL.md fields are checked against the keys research.js returns', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/research.js', '    verified_ideas: r.verdict ? r.verdict.verified_ideas : [],', '    ideas: r.verdict ? r.verdict.verified_ideas : [],')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL fields: research SKILL\.md §3 names only fields research\.js returns[\s\S]*verified_ideas/)
})

test('fails when a doc names a plugin script that does not exist', t => {
  const dir = copyRepo(t)
  append(dir, 'skills/loop/SKILL.md', '\nRun `node <T>/scripts/loop-nope.mjs line <file>`.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL scripts: every scripts\/\*\.mjs path the docs name exists/)
  assert.match(r.stdout, /skills\/loop\/SKILL\.md: scripts\/loop-nope\.mjs/)
})

test('fails when README and the template disagree on the LOOP.md defaults', t => {
  const dir = copyRepo(t)
  mutate(dir, 'README.md', 'max_iterations_per_day: 8', 'max_iterations_per_day: 12')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL dup: README LOOP\.md defaults == loop-templates\.md LOOP\.md template/)
})
