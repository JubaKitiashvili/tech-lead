// tests/loop/loop-clone-passthrough-tmpdir.test.mjs
// The read-only git passthrough (brief 13.2) writes nothing outside the work area: its private
// copy of the index lives in a temporary directory of <V>/patches (atomic.tempDir, named for its
// pid), never under os.tmpdir(), so a TMPDIR inside <P> stays untouched, and an interrupted run
// leaves a directory prepare's gone-pid sweep removes. Real repositories and processes: the
// passthrough is stopped mid-command by a full stdout pipe (cat-file of a large blob), observed,
// then killed. A symlinked <V>/patches is refused (atomic.storageDir), so nothing is written
// through it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { SCRIPT, T, cli, firing, prepare, project, waitGone } from './loop-clone-fixture.mjs'
import { sweepTemps } from '../../scripts/lib/atomic.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const passTemps = fx => {
  const dir = path.join(fx.V, 'patches')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith('.tmp-')).map(n => path.join(dir, n)) : []
}

test('passthrough keeps its index copy in <V>/patches, never under TMPDIR, and an interrupted run leaves only a temp the sweep removes', T, async t => {
  const fx = project(t, { files: { 'a.txt': 'a\n', 'big.bin': Buffer.alloc(4 * 1024 * 1024, 'x') } })
  await firing(fx)
  prepare(fx)
  const inside = path.join(fx.P, 'tmp-inside')
  fs.mkdirSync(inside)
  const env = { ...fx.env, TMPDIR: inside }
  // A finished run leaves nothing anywhere.
  for (const argv of [['status', '--porcelain'], ['diff'], ['diff', 'HEAD'], ['ls-files', '-m']]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
    assert.deepEqual(fs.readdirSync(inside), [], `${argv.join(' ')} wrote into TMPDIR`)
    assert.deepEqual(passTemps(fx), [], `${argv.join(' ')} left a temporary directory`)
  }
  // A run held mid-command: git blocks on a stdout nobody reads.
  const child = spawn(process.execPath, [SCRIPT, 'git', fx.P, '--', 'cat-file', '-p', 'HEAD:big.bin'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pause()
  const exited = new Promise(resolve => child.on('exit', resolve))
  t.after(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
  const deadline = Date.now() + 20000
  while (passTemps(fx).length === 0 && fs.readdirSync(inside).length === 0 && Date.now() < deadline) await sleep(20)
  await sleep(200) // the copy is written before git starts; let git fill the pipe
  assert.deepEqual(fs.readdirSync(inside), [], 'the running passthrough wrote into TMPDIR')
  const temps = passTemps(fx)
  assert.equal(temps.length, 1, `one temporary directory in <V>/patches: ${JSON.stringify(temps)}`)
  assert.match(path.basename(temps[0]), new RegExp(`^\\.tmp-${child.pid}-`))
  assert.ok(fs.readdirSync(temps[0]).includes('index'), 'the index copy lives there')
  child.kill('SIGKILL')
  await exited
  child.stdout.destroy()
  await waitGone(child.pid)
  assert.deepEqual(fs.readdirSync(inside), [])
  // prepare's sweep (atomic.sweepTemps of <V>/patches) removes what the killed run left.
  assert.deepEqual(sweepTemps(path.join(fx.V, 'patches')), temps)
  assert.deepEqual(passTemps(fx), [])
})

test('passthrough refuses clone-invalid when <V>/patches is a symlink, and writes nothing through it', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const target = path.join(fx.P, 'elsewhere')
  fs.mkdirSync(target)
  fs.rmSync(path.join(fx.V, 'patches'), { recursive: true, force: true })
  fs.symlinkSync(target, path.join(fx.V, 'patches'))
  const r = cli(fx.env, 'git', fx.P, '--', 'status', '--porcelain')
  assert.equal(r.status, 2, r.stderr)
  const last = JSON.parse(r.stderr.trim().split('\n').pop().slice('loop-clone git: '.length))
  assert.equal(last.state, 'refused')
  assert.match(last.detail, /^clone-invalid: .*patches/)
  assert.deepEqual(fs.readdirSync(target), [])
})
