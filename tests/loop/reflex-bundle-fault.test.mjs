// tests/loop/reflex-bundle-fault.test.mjs
// Interruption at each persistence boundary of a save and a reset (brief section 19; ruling R8):
// the CLI runs as a child with TECH_LEAD_FAULT naming the point and is killed there by SIGKILL.
// Whatever the point, there is either no bundle file or one complete bundle that verifies and,
// applied to its base, reproduces the work tree byte for byte (I1); a reset is never left half
// done in a way that loses data, and the next save and reset finish the job (I7).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  T, baseSnapshot, bundles, cli, fixture, gitState, recordOf, run, save, scratchApply, snapshot, temps, write,
} from './reflex-bundle-fixture.mjs'

const FILES = { '.gitignore': '*.log\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'run.sh': 'echo\n', 'dir/c.txt': 'c\n' }
const N_ = f => String(f.N)

function edit(W) {
  write(W, 'a.txt', 'edited\r\n')
  fs.rmSync(path.join(W, 'b.txt'))
  fs.chmodSync(path.join(W, 'run.sh'), 0o755)
  write(W, 'n/new.txt', 'new\n')
  write(W, 'n/deeper/x.txt', 'x\n')
  write(W, 'top.txt', 'top\n')
  fs.symlinkSync('a.txt', path.join(W, 'ln'))
  write(W, 'ignored.log', 'not saved, not reset\n')
}

const SAVE_POINTS = ['save:after-write', 'save:after-check', 'save:after-link', 'save:after-record']
const RESET_POINTS = ['reset:after-check', 'reset:after-intent', 'reset:after-unlink-one', 'reset:after-read-tree', 'reset:after-record']

for (const point of SAVE_POINTS) {
  test(`SIGKILL at ${point}: no bundle or one complete verified bundle; the next save anchors it and the reset finishes`, T, async t => {
    const f = await fixture(t, FILES)
    edit(f.W)
    const pre = snapshot(f.W)
    const st = gitState(f.W)
    const k = cli({ ...f.env, TECH_LEAD_FAULT: point }, 'save', f.P, '--generation', N_(f), '--why', 'attempt-failed')
    assert.equal(k.signal, 'SIGKILL', `${point}: ${k.stderr}`)
    assert.deepEqual(k.lines, [], 'nothing was printed')
    assert.deepEqual(snapshot(f.W), pre, 'a save never touches the work tree')
    assert.deepEqual(gitState(f.W), st, 'nor the index, HEAD or refs')
    const files = bundles(f)
    const rec = recordOf(f)
    const early = point === 'save:after-write' || point === 'save:after-check'
    if (early) {
      assert.deepEqual(files, [], 'no bundle file')
      assert.equal(temps(f).length, 1, 'only the dead saver\'s temp file, which sweepTemps removes')
      assert.equal(rec.phase, 'prepared')
      assert.deepEqual(rec.saves, [])
    } else {
      assert.equal(files.length, 1)
      const sha = files[0].slice(0, 64)
      assert.equal(run(f.env, 0, 'verify', f.P, '--sha', sha).state, 'verified')
      assert.deepEqual(scratchApply(t, f, sha), snapshot(f.W, { dirs: false, skip: ['ignored.log'] }), 'the bundle holds every byte')
      assert.deepEqual(temps(f), [])
      if (point === 'save:after-link') assert.deepEqual(rec.saves, [], 'linked, not yet anchored')
      else assert.deepEqual(rec.saves, [{ sha, why: 'attempt-failed' }])
    }
    const s = save(f, 'attempt-failed')
    assert.equal(s.state, 'saved')
    if (!early) {
      assert.equal(`${s.sha}.patch`, files[0], 'the same change set is the same bundle')
      assert.equal(s.reused, true)
    }
    assert.deepEqual(recordOf(f).saves, [{ sha: s.sha, why: 'attempt-failed' }], 'one anchored bundle')
    assert.equal(run(f.env, 0, 'reset', f.P, '--generation', N_(f), '--sha', s.sha).state, 'reset')
    assert.deepEqual(snapshot(f.W, { dirs: false, skip: ['ignored.log'] }), baseSnapshot(t, f))
  })
}

for (const point of RESET_POINTS) {
  test(`SIGKILL at ${point}: the anchored bundle still reproduces the work, and the next reset finishes`, T, async t => {
    const f = await fixture(t, FILES)
    edit(f.W)
    const pre = snapshot(f.W)
    const s = save(f, 'attempt-failed')
    const k = cli({ ...f.env, TECH_LEAD_FAULT: point }, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
    assert.equal(k.signal, 'SIGKILL', `${point}: ${k.stderr}`)
    assert.deepEqual(k.lines, [])
    assert.equal(run(f.env, 0, 'verify', f.P, '--sha', s.sha).state, 'verified')
    assert.deepEqual(scratchApply(t, f, s.sha), pre.filter(([p, d]) => d !== 'd' && p !== 'ignored.log'), 'no data lost')
    const rec = recordOf(f)
    const phase = { 'reset:after-check': 'saved', 'reset:after-record': 'clean' }[point] ?? 'resetting'
    assert.equal(rec.phase, phase)
    if (phase !== 'saved') assert.equal(rec.reset_sha, s.sha)
    if (point === 'reset:after-check' || point === 'reset:after-intent') assert.deepEqual(snapshot(f.W), pre, 'nothing removed yet')
    if (point === 'reset:after-unlink-one') {
      const now = snapshot(f.W)
      assert.equal(pre.filter(([p]) => !now.some(([q]) => q === p)).length, 1, 'one untracked file removed')
    }
    const r = run(f.env, 0, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
    assert.equal(r.state, 'reset')
    assert.equal(recordOf(f).phase, 'clean')
    assert.deepEqual(snapshot(f.W, { dirs: false, skip: ['ignored.log'] }), baseSnapshot(t, f))
    assert.ok(fs.existsSync(path.join(f.W, 'ignored.log')), 'an ignored file is never reset')
  })
}
