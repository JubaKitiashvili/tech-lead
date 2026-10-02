// tests/loop/loop-lock-race.test.mjs
// Concurrent acquirers of one firing lock, each a real CLI process with its own live holder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawn } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-lock.mjs')
const RACERS = 8
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// A real process standing in for a holder, started through a shell that exits at once.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  return pid
}
const project = t => {
  const P = tmp(t, 'tl-race-p-')
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  return { P, cache: tmp(t, 'tl-race-c-') }
}
const env = (p, pid) => ({ ...process.env, TECH_LEAD_CACHE: p.cache, TECH_LEAD_HOLDER_PID: String(pid) })
// One CLI acquire, started without waiting, so all racers run at once.
const acquireCli = (p, pid) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SCRIPT, 'acquire', p.P], { env: env(p, pid), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', d => { out += d })
  c.stderr.on('data', d => { err += d })
  c.on('error', reject)
  c.on('close', status => resolve({ pid, status, out: out.trim() ? JSON.parse(out) : null, err }))
})
const race = (p, holders) => Promise.all(holders.map(h => acquireCli(p, h)))
const check = (results, generation) => {
  const won = results.filter(r => r.status === 0)
  assert.equal(won.length, 1, JSON.stringify(results))
  assert.equal(won[0].out.state, 'acquired')
  assert.equal(won[0].out.generation, generation)
  for (const r of results.filter(x => x !== won[0])) {
    assert.equal(r.status, 3, JSON.stringify(r))
    assert.equal(r.out.state, 'held')
    assert.ok(['holder-live', 'race'].includes(r.out.reason), r.out.reason)
  }
  const lockDir = won[0].out.lockDir
  const slot = JSON.parse(fs.readFileSync(path.join(lockDir, 'slots', `${generation}.json`), 'utf8'))
  assert.equal(slot.holder.pid, won[0].pid)
  return won[0]
}

test(`${RACERS} concurrent acquirers with distinct live holders: exactly one acquires`, async t => {
  const p = project(t)
  const won = check(await race(p, Array.from({ length: RACERS }, () => sleeper(t))), 1)
  assert.deepEqual(fs.readdirSync(path.join(won.out.lockDir, 'slots')), ['1.json'])
})

test(`${RACERS} concurrent reclaimers of a dead holder: exactly one takes the next generation`, async t => {
  const p = project(t)
  const first = await acquireCli(p, sleeper(t))
  assert.equal(first.status, 0, first.err)
  process.kill(first.pid, 'SIGKILL')
  for (let i = 0; i < 60 && startToken(first.pid).state !== 'gone'; i++) await sleep(50)
  const won = check(await race(p, Array.from({ length: RACERS }, () => sleeper(t))), 2)
  assert.equal(won.out.reclaimed.how, 'dead-holder')
  assert.deepEqual(fs.readdirSync(path.join(won.out.lockDir, 'slots')).sort(), ['1.json', '2.json'])
})
