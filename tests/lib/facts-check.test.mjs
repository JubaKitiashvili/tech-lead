// tests/lib/facts-check.test.mjs
// scripts/facts-check.mjs: the table in references/model-facts.md parses clean, every place a
// row says it is used in exists, and the stale list is computed from the dates.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { parseFacts, staleFacts } from '../../scripts/facts-check.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'facts-check.mjs')
const run = args => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' }); return { code: r.status, out: JSON.parse(r.stdout) } }
const HEAD = '| id | Fact | Used in | Source | Checked |\n|--|--|--|--|--|\n'
const row = (o = {}) => `| ${o.id ?? 'a-fact'} | ${o.fact ?? 'a fact long enough to be checked against a page'} | ${o.used ?? 'SKILL.md'} | ${o.source ?? 'https://example.com/page'} | ${o.checked ?? '2026-11-01'} |\n`

test('the shipped table parses with no problem and has unique ids', () => {
  const { facts, problems } = parseFacts(fs.readFileSync(path.join(ROOT, 'references', 'model-facts.md'), 'utf8'))
  assert.deepEqual(problems, [])
  assert.ok(facts.length >= 10)
  assert.equal(new Set(facts.map(f => f.id)).size, facts.length)
})

test('every file a row names under "Used in" exists in the plugin', () => {
  const { facts } = parseFacts(fs.readFileSync(path.join(ROOT, 'references', 'model-facts.md'), 'utf8'))
  for (const f of facts) {
    const files = f.used_in.match(/[\w./-]+\.(?:md|mjs|js)\b|scripts\/hooks\//g) || []
    assert.ok(files.length > 0, `${f.id} names no file`)
    for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), `${f.id}: ${file}`)
  }
})

test('parseFacts reports each kind of bad row', () => {
  const kinds = t => parseFacts(HEAD + t).problems.map(p => p.problem)
  assert.match(kinds(row({ id: 'Bad Id' }))[0], /is not lower-case/)
  assert.match(kinds(row() + row())[0], /used twice/)
  assert.match(kinds(row({ fact: 'short' }))[0], /too short/)
  assert.match(kinds(row({ source: 'http://x.example' }))[0], /https URL/)
  assert.match(kinds(row({ checked: '2026-02-30' }))[0], /not a YYYY-MM-DD day/)
  assert.match(kinds('| only | three | cells |\n')[0], /cells, not 5/)
  assert.match(parseFacts(HEAD).problems[0].problem, /no rows/)
})

test('staleFacts: older than the limit only, oldest first, age in whole days', () => {
  const facts = [{ id: 'new', checked: '2026-11-01', source: 's' }, { id: 'old', checked: '2026-08-01', source: 's' }, { id: 'edge', checked: '2026-09-27', source: 's' }, { id: 'older', checked: '2026-06-01', source: 's' }]
  const out = staleFacts(facts, { days: 45, today: '2026-11-11' })
  assert.deepEqual(out.map(f => f.id), ['older', 'old'])
  assert.equal(out[1].age_days, 102)
  assert.deepEqual(staleFacts(facts, { days: 44, today: '2026-11-11' }).map(f => f.id), ['older', 'old', 'edge'])
})

test('as a process: list, stale with a fixed day, and usage errors', () => {
  const list = run(['list'])
  assert.equal(list.code, 0)
  assert.ok(list.out.facts.every(f => f.id && f.source.startsWith('https://')))
  const none = run(['stale', '--today', '2026-11-12'])
  assert.equal(none.code, 0)
  assert.deepEqual(none.out.stale, [])
  const all = run(['stale', '--days', '0', '--today', '2027-06-01'])
  assert.equal(all.out.stale.length, all.out.total)
  for (const bad of [[], ['nope'], ['stale', '--days', 'x'], ['stale', '--today', '2026-13-01']]) assert.equal(run(bad).code, 2)
})
