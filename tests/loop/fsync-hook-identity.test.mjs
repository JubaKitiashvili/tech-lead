// tests/loop/fsync-hook-identity.test.mjs
// The R31 fsync hook (tests/fixtures/fsync-hook.cjs) kills its victim only while the pid still
// names the process the test meant (Codex f2 #3): the test passes the victim's start token
// (scripts/lib/loop-proc.mjs startToken) with its pid, and the hook reads the pid's token again
// right before the SIGKILL. A pid whose token differs (it exited and was reused meanwhile) is
// never signalled, and the hook says so in FSYNC_HOOK_OUT. Real processes: a sleeper this file
// starts, and a node process with the hook preloaded that fsyncs one watched file.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'

const HOOK = path.join(ROOT, 'tests', 'fixtures', 'fsync-hook.cjs')
const T = { timeout: 60000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A sleeper child of this process, killed when the test ends (unreaped, its pid is ours).
function sleeper(t) {
  const child = spawn('/bin/sleep', ['120'], { stdio: 'ignore' })
  const exited = new Promise(resolve => child.on('exit', resolve))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  return { child, exited }
}

// One fsync of <dir>/.tmp-x by a node process with the hook preloaded, aimed at pid with the
// start token start (omitted: no FSYNC_HOOK_KILL_START at all); the lines of FSYNC_HOOK_OUT.
function fsyncOnce(t, pid, start) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fsync-hook-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, 'out')
  const env = { ...process.env, NODE_OPTIONS: `--require ${HOOK}`, FSYNC_HOOK_DIR: dir, FSYNC_HOOK_KILL: String(pid), FSYNC_HOOK_OUT: out }
  if (start !== undefined) env.FSYNC_HOOK_KILL_START = start
  const code = "const fs = require('node:fs'); const fd = fs.openSync(process.argv[1], 'w'); fs.writeSync(fd, 'x'); fs.fsyncSync(fd); fs.closeSync(fd)"
  const r = spawnSync(process.execPath, ['-e', code, path.join(dir, '.tmp-x')], { encoding: 'utf8', env, timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  return fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean) : []
}

test('a hook aimed at a pid whose start token is not the one passed leaves that process alone and records no-kill', T, async t => {
  const s = sleeper(t)
  const token = startToken(s.child.pid)
  assert.equal(token.state, 'live', JSON.stringify(token))
  const lines = fsyncOnce(t, s.child.pid, `${token.token}-an-earlier-process`)
  await sleep(200)
  assert.equal(s.child.exitCode, null, `the hook killed pid ${s.child.pid}, whose token did not match`)
  assert.equal(s.child.signalCode, null, `the hook killed pid ${s.child.pid}, whose token did not match`)
  assert.deepEqual(startToken(s.child.pid), token, 'the sleeper still runs')
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.match(lines[0], /^\.tmp-x no-kill: /)
})

test('a hook given no start token kills nothing', T, async t => {
  const s = sleeper(t)
  const token = startToken(s.child.pid)
  const lines = fsyncOnce(t, s.child.pid)
  await sleep(200)
  assert.deepEqual(startToken(s.child.pid), token, `the hook killed pid ${s.child.pid} with no identity to match`)
  assert.match(lines[0] ?? '', /^\.tmp-x no-kill: /, JSON.stringify(lines))
})

test('a hook given the live start token kills its victim and records the entry', T, async t => {
  const s = sleeper(t)
  const token = startToken(s.child.pid)
  const lines = fsyncOnce(t, s.child.pid, token.token)
  assert.equal(await s.exited, null)
  assert.equal(s.child.signalCode, 'SIGKILL')
  assert.deepEqual(lines, ['.tmp-x'])
})
