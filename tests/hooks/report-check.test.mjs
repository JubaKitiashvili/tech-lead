// tests/hooks/report-check.test.mjs
// The SubagentStop hook script: which contract problems it names, that it only observes (no
// output, exit 0, one log line that holds no report text), and that the skill's frontmatter
// registers it by a path that exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { problems, record, summarize, logFile, LIMITS } from '../../scripts/hooks/report-check.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'report-check.mjs')
const GOOD = 'Done: renamed the helper.\nFiles touched: /repo/src/a.ts\nVerification: `npm test -- a` passed.\nEvidence: src/a.ts:12 holds the new name.'
const run = (stdin, dir, args = []) => spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dir } })
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl report '))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a report with evidence and a verification line has no problems', () => {
  assert.deepEqual(problems({ agent_type: 'tech-lead:fast-worker', last_assistant_message: GOOD }), [])
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: GOOD }), [])
})

test('a missing or very short final message is "empty" and nothing else', () => {
  for (const m of [undefined, '', '   ', 'ok done']) {
    assert.deepEqual(problems({ agent_type: 'tech-lead:fast-worker', last_assistant_message: m }), ['empty'])
  }
})

test('prose with no file:line and no command is "no-evidence"', () => {
  const text = 'The change is complete and everything looks correct. I verified the result carefully and it works as intended.'
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: text }), ['no-evidence'])
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: text + ' See lib/x.mjs:40.' }), [])
})

test('only fast-worker owes a verification line', () => {
  const text = 'Done: updated the imports in src/a.ts:3 and src/b.ts:9, as the spec said, and nothing else was touched.'
  assert.deepEqual(problems({ agent_type: 'tech-lead:fast-worker', last_assistant_message: text }), ['no-verification'])
  assert.deepEqual(problems({ agent_type: 'tech-lead:deep-reasoner', last_assistant_message: text }), [])
})

test('a report past the line or character limit is "long"; a long fenced block is "dump"', () => {
  const many = GOOD + '\n' + Array.from({ length: LIMITS.maxLines }, (_, i) => `point ${i}`).join('\n')
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: many }), ['long'])
  const wide = GOOD + '\n' + 'x'.repeat(LIMITS.maxChars)
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: wide }), ['long'])
  const fence = GOOD + '\n```\n' + Array.from({ length: LIMITS.dumpLines + 1 }, (_, i) => `line ${i}`).join('\n') + '\n```'
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: fence }), ['dump'])
  const unclosed = GOOD + '\n```\n' + Array.from({ length: LIMITS.dumpLines + 1 }, (_, i) => `line ${i}`).join('\n')
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: unclosed }), ['dump'])
  const short = GOOD + '\n```\nnpm test\n```'
  assert.deepEqual(problems({ agent_type: 'general-purpose', last_assistant_message: short }), [])
})

test('the record holds sizes and problem names, never the report text', () => {
  const secret = 'TOKEN-abc123 ' + GOOD
  const r = record({ session_id: 's1', agent_type: 'Explore', agent_id: 'a1', last_assistant_message: secret }, '2026-11-18T00:00:00.000Z')
  assert.deepEqual(Object.keys(r).sort(), ['agent_id', 'agent_type', 'at', 'chars', 'lines', 'problems', 'session'])
  assert.equal(r.chars, secret.length)
  assert.equal(r.lines, 4)
  assert.doesNotMatch(JSON.stringify(r), /TOKEN-abc123|renamed the helper/)
})

test('the log sits in the plugin data directory, or under ~/.claude/tech-lead without one', () => {
  assert.equal(logFile({ CLAUDE_PLUGIN_DATA: '/data' }), path.join('/data', 'report-checks.jsonl'))
  assert.equal(logFile({}), path.join(os.homedir(), '.claude', 'tech-lead', 'report-checks.jsonl'))
})

test('summarize counts reports and problems per agent type and skips broken lines', () => {
  const lines = [
    JSON.stringify({ agent_type: 'a', problems: [] }),
    JSON.stringify({ agent_type: 'a', problems: ['long', 'dump'] }),
    JSON.stringify({ agent_type: 'b', problems: ['long'] }),
    'not json', JSON.stringify({ agent_type: 'b' }),
  ]
  assert.deepEqual(summarize(lines), {
    a: { reports: 2, with_problems: 1, problems: { long: 1, dump: 1 } },
    b: { reports: 1, with_problems: 1, problems: { long: 1 } },
  })
})

test('as a process: observes only. No output, exit 0, one log line per delegate report', t => {
  const dir = tmp(t)
  const bad = run(JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's', agent_type: 'tech-lead:fast-worker', agent_id: 'x', last_assistant_message: 'done' }), dir)
  assert.equal(bad.status, 0)
  assert.equal(bad.stdout, '')
  assert.equal(bad.stderr, '')
  const good = run(JSON.stringify({ session_id: 's', agent_type: 'general-purpose', agent_id: 'y', last_assistant_message: GOOD }), dir)
  assert.equal(good.status, 0)
  const rows = fs.readFileSync(path.join(dir, 'report-checks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(r => [r.agent_type, r.problems]), [['tech-lead:fast-worker', ['empty']], ['general-purpose', []]])
  assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT/)
})

test('as a process: garbage input and an internal agent (empty agent_type) write nothing', t => {
  const dir = tmp(t)
  for (const stdin of ['', 'not json', '[]', JSON.stringify({ agent_type: '', last_assistant_message: GOOD })]) {
    const r = run(stdin, dir)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  assert.equal(fs.existsSync(path.join(dir, 'report-checks.jsonl')), false)
})

test('as a process: a log directory that cannot be written still exits 0 with no output', t => {
  const dir = tmp(t)
  const file = path.join(dir, 'not-a-dir')
  fs.writeFileSync(file, '')
  const r = run(JSON.stringify({ agent_type: 'Explore', last_assistant_message: GOOD }), file)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('as a process: summary prints the counts, also when there is no log yet', t => {
  const dir = tmp(t)
  assert.deepEqual(JSON.parse(run('', dir, ['summary']).stdout).by_agent_type, {})
  run(JSON.stringify({ agent_type: 'Explore', last_assistant_message: 'x' }), dir)
  const out = JSON.parse(run('', dir, ['summary']).stdout)
  assert.deepEqual(out.by_agent_type, { Explore: { reports: 1, with_problems: 1, problems: { empty: 1 } } })
})

test('the skill registers the hook for the bench agents, by a path that exists', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8')
  const front = skill.slice(0, skill.indexOf('\n---', 4))
  const m = /SubagentStop:\n\s+- matcher: "([^"]+)"\n\s+hooks:\n\s+- type: command\n\s+command: "node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/hooks\/report-check\.mjs)\\""/.exec(front)
  assert.ok(m, 'SKILL.md frontmatter has no SubagentStop hook for report-check.mjs')
  assert.ok(fs.existsSync(path.join(ROOT, m[2])))
  const re = new RegExp(`^(?:${m[1]})$`)
  for (const t of ['tech-lead:fast-worker', 'tech-lead:deep-reasoner', 'general-purpose', 'Explore']) assert.match(t, re)
  assert.doesNotMatch('', re)
})
