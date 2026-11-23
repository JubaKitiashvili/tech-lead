// tests/live-evals.test.mjs
// The live loop eval (live-evals/) without a model: every fixture is a spine the helpers
// accept, and the grader tells an untouched project from a firing that did its work.
import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './helpers.mjs'
import { parseState } from '../scripts/lib/loop-state.mjs'
import { SCENARIOS, buildFixture } from '../live-evals/scenarios.mjs'
import { grade, projectSnapshot } from '../live-evals/grade.mjs'

const LOCK = path.join(ROOT, 'scripts/loop-lock.mjs')

function makeRun(t, scenario) {
  const run = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tl-live-test-'))
  t.after(() => fs.rmSync(run, { recursive: true, force: true }))
  const P = path.join(run, 'repo')
  fs.mkdirSync(P)
  fs.mkdirSync(path.join(run, 'cache'))
  buildFixture(P, scenario)
  const stateText = fs.readFileSync(path.join(P, '.tech-lead/STATE.md'), 'utf8')
  fs.writeFileSync(path.join(run, 'before.json'), JSON.stringify({ scenario, snapshot: projectSnapshot(P), stateText }))
  return { run, P, S: path.join(P, '.tech-lead'), stateText }
}

const failed = res => res.checks.filter(c => !c.pass).map(c => c.name)

for (const scenario of Object.keys(SCENARIOS)) {
  test(`live-evals: the ${scenario} fixture is a clean spine, and an untouched one does not pass`, t => {
    const { run, stateText } = makeRun(t, scenario)
    assert.deepEqual(parseState(stateText).problems, [])
    const res = grade(run, scenario)
    assert.equal(res.pass, false)
    for (const name of ['run-ended', 'one-ledger-entry', 'lock-released', 'last-run-written']) assert.ok(failed(res).includes(name), name)
    assert.ok(!res.checks.some(c => /the check threw/.test(c.detail || '')), JSON.stringify(res.checks))
    assert.ok(!failed(res).includes('project-untouched'))
  })
}

// What a correct "paused" firing leaves: the lock taken and released, ## Last run written,
// one ledger entry, and nothing else.
function pausedFiring(t) {
  const r = makeRun(t, 'paused')
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(r.run, 'cache'), TECH_LEAD_HOLDER_PID: String(process.pid) }
  const lock = (...args) => {
    const out = spawnSync(process.execPath, [LOCK, ...args], { env, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stdout + out.stderr)
  }
  lock('acquire', r.P)
  fs.writeFileSync(path.join(r.S, 'STATE.md'), r.stateText.replace('(never run)', '2026-01-01T00:00:00Z · level 2 · paused, nothing done.'))
  fs.writeFileSync(path.join(r.S, 'LEDGER.jsonl'), JSON.stringify({ ts: '2026-01-01T00:00:00Z', iteration: 1, task: null, item_id: null, outcome: 'halted', notes: 'paused' }) + '\n')
  lock('release', r.P, '--generation', '1')
  const bash = command => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
  r.events = [
    bash(`node ${LOCK} acquire ${r.P}`),
    bash(`node ${LOCK} release ${r.P} --generation 1`),
    { type: 'result', is_error: false, total_cost_usd: 0.5, num_turns: 6, duration_ms: 30000 },
  ]
  r.write = () => fs.writeFileSync(path.join(r.run, 'stream.jsonl'), r.events.map(e => JSON.stringify(e)).join('\n') + '\n')
  r.write()
  return r
}

test('live-evals: a paused firing that only records "halted" passes every check', t => {
  const r = pausedFiring(t)
  const res = grade(r.run, 'paused')
  assert.deepEqual(failed(res), [])
  assert.equal(res.cost_usd, 0.5)
})

test('live-evals: the grader names a changed project file, a push, an unrecorded agent and a second ledger entry', t => {
  const r = pausedFiring(t)
  fs.writeFileSync(path.join(r.P, 'src/math.js'), 'export const add = () => 0\n')
  fs.appendFileSync(path.join(r.S, 'LEDGER.jsonl'), JSON.stringify({ iteration: 2, outcome: 'halted' }) + '\n')
  r.events.splice(1, 0,
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push origin main' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'general-purpose' } }] } },
    // A tool call inside a subagent is not the lead's.
    { type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } })
  r.write()
  assert.deepEqual(failed(grade(r.run, 'paused')), [
    'one-ledger-entry', 'every-dispatch-on-record', 'project-untouched', 'no-push-no-pr', 'every-agent-pins-a-model', 'ledger-halted', 'no-agent',
  ])
})
