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
const copyRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-check-'))
  fs.cpSync(ROOT, dir, { recursive: true, filter: src => path.basename(src) !== '.git' })
  return dir
}

test('passes on the plugin repo when run from another directory with no argument', () => {
  const r = runCheck(null)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, / 0 failed,/)
})

test('fails and names the file when a doc references an unknown workflow', () => {
  const dir = copyRepo()
  fs.appendFileSync(path.join(dir, 'README.md'), '\nWorkflow({name: "tech-lead:no-such-workflow", args: {}})\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /README\.md: tech-lead:no-such-workflow/)
})

test('fails when a workflow meta is not a pure literal', () => {
  const dir = copyRepo()
  const f = path.join(dir, 'workflows', 'triage.js')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("name: 'triage'", 'name: `triage`'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL compile workflows\/triage\.js/)
})

test('fails when the panel skill drops an agreement value', () => {
  const dir = copyRepo()
  const f = path.join(dir, 'skills', 'panel', 'SKILL.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(' | no-seats>', '>'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL enum: panel agreement, skills\/panel\/SKILL\.md present shape/)
})
