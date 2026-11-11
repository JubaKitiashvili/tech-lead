// tests/hooks/resume.test.mjs
// The SessionStart (compact) hook script: it names an unfinished plan of the project at cwd,
// stays silent when there is none, and never fails.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { notice } from '../../scripts/hooks/resume.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'hooks', 'resume.mjs')
const CLI = path.join(ROOT, 'scripts', 'plan-graph.mjs')
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const project = t => {
  const P = tmp(t, 'tl-resume-')
  execFileSync('git', ['init', '-q', P])
  return { P, env: { ...process.env, TECH_LEAD_CACHE: tmp(t, 'tl-resume-cache-') } }
}
const cli = (fx, args) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: fx.env }).stdout)
const hook = (fx, input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: fx.env })
const DRAFT = JSON.stringify({
  goal: 'CSV export',
  tasks: [
    { id: 'api', title: 'endpoint', executor: 'general-purpose', model: 'opus' },
    { id: 'review', title: 'review', executor: 'main', depends_on: ['api'] },
  ],
})

test('with an unfinished plan the hook names the goal, the progress, the open tasks and the restore command', t => {
  const fx = project(t)
  const made = cli(fx, ['create', fx.P, '--json', DRAFT])
  cli(fx, ['mark', fx.P, '--task', 'api', '--status', 'running'])
  const sub = path.join(fx.P, 'deep', 'er')
  fs.mkdirSync(sub, { recursive: true })
  for (const cwd of [fx.P, sub]) {
    const r = hook(fx, JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd }))
    assert.equal(r.status, 0)
    assert.match(r.stdout, /^\[tech-lead\] This project has an unfinished \/tech-lead plan: "CSV export"/)
    assert.ok(r.stdout.includes(made.run_id))
    assert.match(r.stdout, /0 of 2 done, 1 running, 0 failed, 1 pending/)
    assert.match(r.stdout, /api \(running\), review \(pending\)/)
    assert.ok(r.stdout.includes(`status "${fx.P}"`))
  }
})

test('silent, exit 0: no plan, a finished plan, a folder that is no git project, and unusable input', t => {
  const fx = project(t)
  const at = cwd => hook(fx, JSON.stringify({ cwd }))
  assert.deepEqual([at(fx.P).status, at(fx.P).stdout], [0, ''])
  cli(fx, ['create', fx.P, '--json', JSON.stringify({ goal: 'g', tasks: [{ id: 'a', title: 't', executor: 'main' }] })])
  cli(fx, ['mark', fx.P, '--task', 'a', '--status', 'running'])
  cli(fx, ['mark', fx.P, '--task', 'a', '--status', 'done'])
  assert.deepEqual([at(fx.P).status, at(fx.P).stdout], [0, ''])
  const plain = tmp(t, 'tl-resume-plain-')
  assert.deepEqual([at(plain).status, at(plain).stdout], [0, ''])
  for (const bad of ['', 'not json', '{}', '{"cwd":"relative/path"}', '{"cwd":42}']) {
    const r = hook(fx, bad)
    assert.deepEqual([r.status, r.stdout], [0, ''])
  }
})

test('notice: a long goal is cut to one line, and more than twelve open tasks end in an ellipsis', () => {
  const tasks = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, status: 'pending' }))
  const out = notice({ P: '/p', run_id: 'r', goal: 'a\nb ' + 'x'.repeat(400), total: 14, counts: { pending: 14 }, tasks })
  assert.equal(out.split('\n')[0].length < 300, true)
  assert.doesNotMatch(out.split('\n')[0], /a\nb/)
  assert.match(out, /t11 \(pending\), …\./)
  assert.equal(notice(null), '')
})

test('the root skill registers the hook on SessionStart for compact, by a path that exists', () => {
  const md = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8')
  const fm = md.slice(0, md.indexOf('\n---\n', 4))
  const m = /\n {2}SessionStart:\n {4}- matcher: "compact"\n {6}hooks:\n {8}- type: command\n {10}command: "node \\"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\]+)\\""/.exec(fm)
  assert.ok(m, 'SessionStart, matcher compact, node "${CLAUDE_PLUGIN_ROOT}/<path>"')
  assert.equal(m[1], 'scripts/hooks/resume.mjs')
  assert.ok(fs.existsSync(path.join(ROOT, m[1])))
})

// A workspace folder holding two repositories, with a plan created at the folder itself.
const workspace = t => {
  const W = tmp(t, 'tl-resume-ws-')
  for (const r of ['api', 'web']) execFileSync('git', ['init', '-q', path.join(W, r)])
  return { P: W, env: { ...process.env, TECH_LEAD_CACHE: tmp(t, 'tl-resume-ws-cache-') } }
}
const WS_DRAFT = JSON.stringify({ goal: 'cross-repo', tasks: [{ id: 'a', title: 't', executor: 'main', files: ['api/src/', 'web/src/'] }] })

test('a plan at a workspace folder is found from an inner repository, a subfolder of it, and the folder itself', t => {
  const fx = workspace(t)
  const made = cli(fx, ['create', fx.P, '--json', WS_DRAFT])
  assert.equal(made.state, 'created', JSON.stringify(made))
  const deep = path.join(fx.P, 'api', 'src', 'deep')
  fs.mkdirSync(deep, { recursive: true })
  for (const cwd of [path.join(fx.P, 'api'), deep, fx.P]) {
    const r = hook(fx, JSON.stringify({ cwd }))
    assert.equal(r.status, 0)
    assert.ok(r.stdout.includes(made.run_id), cwd)
    assert.ok(r.stdout.includes(`status "${fx.P}"`), cwd)
  }
})

test('silent, exit 0: seven levels below the plan\'s folder, or when its only plan is finished', t => {
  const fx = workspace(t)
  cli(fx, ['create', fx.P, '--json', WS_DRAFT])
  const six = path.join(fx.P, '1', '2', '3', '4', '5', '6')
  const seven = path.join(six, '7')
  fs.mkdirSync(seven, { recursive: true })
  assert.match(hook(fx, JSON.stringify({ cwd: six })).stdout, /unfinished \/tech-lead plan/, 'six levels up is still searched')
  assert.deepEqual([hook(fx, JSON.stringify({ cwd: seven })).status, hook(fx, JSON.stringify({ cwd: seven })).stdout], [0, ''])
  cli(fx, ['mark', fx.P, '--task', 'a', '--status', 'running'])
  cli(fx, ['mark', fx.P, '--task', 'a', '--status', 'done'])
  const r = hook(fx, JSON.stringify({ cwd: path.join(fx.P, 'web') }))
  assert.deepEqual([r.status, r.stdout], [0, ''])
})
