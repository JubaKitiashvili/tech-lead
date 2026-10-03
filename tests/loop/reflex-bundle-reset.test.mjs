// tests/loop/reflex-bundle-reset.test.mjs
// Resets of recovery bundles (brief section 11 and section 19's Save and reset): the base
// restored, untracked files removed one at a time, emptied directories removed, ignored files
// kept; every refusal leaves the clone as it was; the relaxed resume after a kill; a symlinked
// ancestor never followed; resetEmpty; a reset into an older record's recovery fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  SCRIPT, T, baseSnapshot, cli, fixture, git, gitCode, gitState, header, recordOf, run, save, scratchApply, sleeper, snapshot, tmp, write,
} from './reflex-bundle-fixture.mjs'
import { removeUntracked, resetEmpty, resetFor, saveFor } from '../../scripts/reflex-bundle.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { readRecord, updateRecord } from '../../scripts/lib/run-record.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'

const N_ = f => String(f.N)
const reset = (f, sha, status, env = f.env) => run(env, status, 'reset', f.P, '--generation', N_(f), '--sha', sha)
const kill = async pid => {
  process.kill(pid, 'SIGKILL')
  for (let i = 0; i < 100 && startToken(pid).state !== 'gone'; i++) await new Promise(r => setTimeout(r, 30))
  assert.equal(startToken(pid).state, 'gone')
}
const exists = p => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

test('reset restores the base: tracked files back, untracked files and emptied directories gone, ignored files kept', T, async t => {
  const f = await fixture(t, { '.gitignore': '*.log\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'keep/k.txt': 'k\n' })
  const { W } = f
  write(W, 'a.txt', 'edited\n')
  fs.rmSync(path.join(W, 'b.txt'))
  write(W, 'new/sub/n.txt', 'n\n')
  write(W, 'new/sub/x.log', 'ignored, stays\n')
  write(W, 'new2/deep/m.txt', 'm\n')
  write(W, 'top.txt', 't\n')
  write(W, 'keep/extra.txt', 'e\n')
  write(W, 'x.log', 'ignored at the top\n')
  fs.symlinkSync('a.txt', path.join(W, 'ln'))
  const pre = snapshot(W, { dirs: false, skip: ['new/sub/x.log', 'x.log'] })
  const s = save(f)
  const r = reset(f, s.sha, 0)
  assert.equal(r.state, 'reset')
  assert.deepEqual(r.removed, ['keep/extra.txt', 'ln', 'new/sub/n.txt', 'new2/deep/m.txt', 'top.txt'])
  assert.deepEqual(r.restored, ['a.txt', 'b.txt'])
  assert.equal(r.more, 0)
  assert.equal(fs.readFileSync(path.join(W, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(fs.readFileSync(path.join(W, 'b.txt'), 'utf8'), 'b\n')
  assert.equal(exists(path.join(W, 'top.txt')), false)
  assert.equal(exists(path.join(W, 'ln')), false)
  assert.equal(exists(path.join(W, 'new2')), false, 'an emptied directory not in the base is removed')
  assert.equal(exists(path.join(W, 'new/sub/n.txt')), false)
  assert.equal(fs.readFileSync(path.join(W, 'new/sub/x.log'), 'utf8'), 'ignored, stays\n', 'an ignored file outside an obstructing directory stays')
  assert.equal(exists(path.join(W, 'x.log')), true)
  assert.equal(exists(path.join(W, 'keep/k.txt')), true, 'a base directory stays')
  assert.equal(git(W, ['status', '--porcelain']), '')
  assert.equal(gitCode(W, ['diff-index', '--cached', '--quiet', f.base]), 0)
  const rec = recordOf(f)
  assert.equal(rec.phase, 'clean')
  assert.equal(rec.reset_sha, s.sha)
  assert.deepEqual(snapshot(W, { dirs: false, skip: ['new/sub/x.log', 'x.log'] }), baseSnapshot(t, f))
  assert.deepEqual(scratchApply(t, f, s.sha), pre, 'the bundle still holds the work')
})

test('an obstructing directory with an ignored file is saved whole, and the reset puts the base file back', T, async t => {
  const f = await fixture(t, { '.gitignore': '*.log\n', 'obs': 'a file in the base\n', 'z.txt': 'z\n' })
  fs.rmSync(path.join(f.W, 'obs'))
  write(f.W, 'obs/a.txt', 'a\n')
  write(f.W, 'obs/deep/x.log', 'ignored, but a reset would delete it\n')
  const pre = snapshot(f.W, { dirs: false })
  const s = save(f)
  const h = header(f, s.sha)
  assert.deepEqual(h.files.map(e => [e.path, e.kind, e.obstructed]), [
    ['obs', 'deleted', false], ['obs/a.txt', 'added', true], ['obs/deep/x.log', 'added', true],
  ])
  const r = reset(f, s.sha, 0)
  assert.deepEqual(r.removed, ['obs/a.txt', 'obs/deep/x.log'])
  assert.equal(fs.readFileSync(path.join(f.W, 'obs'), 'utf8'), 'a file in the base\n')
  assert.deepEqual(snapshot(f.W, { dirs: false }), baseSnapshot(t, f))
  assert.deepEqual(scratchApply(t, f, s.sha), pre)
})

test('reset refuses not-anchored, index-locked, busy, index-only and unsaved, leaving the clone as it was', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  write(f.W, 'a.txt', 'edited\n')
  write(f.W, 'n.txt', 'new\n')
  const s = save(f)
  const snap = snapshot(f.W)
  const check = name => {
    assert.deepEqual(snapshot(f.W), snap, `${name}: the clone is unchanged`)
    const rec = recordOf(f)
    assert.equal(rec.phase, 'saved', name)
    assert.equal(rec.reset_sha, null, name)
  }

  assert.equal(reset(f, 'e'.repeat(64), 3).state, 'not-anchored')
  check('random sha')
  // A real bundle that is not in the record (an orphan) is not anchored either.
  const orphan = saveFor(f.paths, { saver: f.N, source: f.N, base: f.base, rules: f.rules, why: 'codex', env: f.env })
  assert.notEqual(orphan.sha, s.sha)
  assert.equal(reset(f, orphan.sha, 3).state, 'not-anchored')
  check('orphan')

  fs.writeFileSync(path.join(f.W, '.git', 'index.lock'), '')
  assert.equal(reset(f, s.sha, 3).state, 'index-locked')
  fs.rmSync(path.join(f.W, '.git', 'index.lock'))
  check('index.lock')

  const pid = sleeper(t, f.W)
  const busy = reset(f, s.sha, 3)
  assert.equal(busy.state, 'busy')
  assert.ok(busy.procs.some(p => p.pid === pid), JSON.stringify(busy))
  await kill(pid)
  check('busy')

  const oid = git(f.W, ['hash-object', '-w', '--stdin'], { input: 'staged only\n' })
  git(f.W, ['update-index', '--cacheinfo', `100644,${oid},b.txt`])
  const io = reset(f, s.sha, 3)
  assert.equal(io.state, 'index-only')
  assert.deepEqual(io.paths, ['b.txt'])
  git(f.W, ['read-tree', f.base])
  check('index-only')

  write(f.W, 'n.txt', 'changed after the save\n')
  write(f.W, 'z.txt', 'written after the save\n')
  const un = reset(f, s.sha, 3)
  assert.equal(un.state, 'unsaved')
  assert.deepEqual(un.paths, ['n.txt', 'z.txt'])
  // Save and reset repeats from the save once: the new bundle resets.
  const s2 = save(f)
  assert.equal(reset(f, s2.sha, 0).state, 'reset')
  assert.equal(git(f.W, ['status', '--porcelain']), '')
})

test('reset refuses head-moved when HEAD left the base', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  git(f.W, ['commit', '-q', '--allow-empty', '-m', 'a delegate commit'])
  const snap = snapshot(f.W)
  const r = reset(f, s.sha, 3)
  assert.equal(r.state, 'head-moved')
  assert.equal(r.base, f.base)
  assert.deepEqual(snapshot(f.W), snap)
})

test('relaxed resume: a reset killed after its intent finishes over a half-written file, never over an unlisted change', T, async t => {
  const big = 'line of the base\n'.repeat(200)
  const f = await fixture(t, { 'a.txt': big, 'u.txt': 'u\n' })
  write(f.W, 'a.txt', big + 'one more\n')
  write(f.W, 'n.txt', 'new\n')
  const pre = snapshot(f.W, { dirs: false })
  const s = save(f)
  const saved = fs.readFileSync(path.join(f.W, 'a.txt'))
  const half = Buffer.from(big).subarray(0, big.length / 2)

  // Without a recorded intent a half-written file is an unsaved change.
  fs.writeFileSync(path.join(f.W, 'a.txt'), half)
  assert.deepEqual(reset(f, s.sha, 3).paths, ['a.txt'])
  fs.writeFileSync(path.join(f.W, 'a.txt'), saved)

  const k = cli({ ...f.env, TECH_LEAD_FAULT: 'reset:after-intent' }, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
  assert.equal(k.signal, 'SIGKILL')
  assert.equal(recordOf(f).phase, 'resetting')
  assert.equal(recordOf(f).reset_sha, s.sha)
  // What a kill during read-tree -u leaves: a half-written file the bundle lists.
  fs.writeFileSync(path.join(f.W, 'a.txt'), half)
  write(f.W, 'u.txt', 'an edit the bundle does not hold\n')
  const un = reset(f, s.sha, 3)
  assert.equal(un.state, 'unsaved')
  assert.deepEqual(un.paths, ['u.txt'], 'relaxed only for a path the bundle lists')
  write(f.W, 'u.txt', 'u\n')
  const r = reset(f, s.sha, 0)
  assert.equal(r.state, 'reset')
  assert.equal(fs.readFileSync(path.join(f.W, 'a.txt'), 'utf8'), big)
  assert.equal(exists(path.join(f.W, 'n.txt')), false)
  assert.equal(recordOf(f).phase, 'clean')
  assert.deepEqual(scratchApply(t, f, s.sha), pre, 'nothing was lost')
})

test('a symlinked ancestor is never followed', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  const outside = tmp(t, 'tl-rb-outside-')
  write(outside, 'a.txt', 'outside, never removed\n')
  write(outside, 'b.txt', 'outside too\n')
  fs.symlinkSync(outside, path.join(f.W, 'lnk'))
  write(f.W, 'real/b.txt', 'b\n')
  assert.deepEqual(removeUntracked(f.W, ['lnk/a.txt', 'real/b.txt', '../x', 'lnk/b.txt', '.git/HEAD', '.GIT/config'], new Set()), ['real/b.txt'])
  assert.ok(fs.existsSync(path.join(f.W, '.git', 'HEAD')), 'nothing under .git is ever removed')
  assert.ok(fs.existsSync(path.join(outside, 'a.txt')))
  assert.ok(fs.existsSync(path.join(outside, 'b.txt')))
  assert.equal(exists(path.join(f.W, 'real')), false, 'the emptied directory is removed')
  fs.rmSync(path.join(f.W, 'lnk'))

  // The same through the CLI: a directory swapped for a symlink after a killed reset.
  write(f.W, 'new/a.txt', 'saved\n')
  const s = save(f)
  const k = cli({ ...f.env, TECH_LEAD_FAULT: 'reset:after-intent' }, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
  assert.equal(k.signal, 'SIGKILL')
  fs.rmSync(path.join(f.W, 'new'), { recursive: true })
  fs.symlinkSync(outside, path.join(f.W, 'new'))
  const un = reset(f, s.sha, 3)
  assert.equal(un.state, 'unsaved')
  assert.deepEqual(un.paths, ['new'])
  assert.equal(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'outside, never removed\n')
  fs.rmSync(path.join(f.W, 'new'))
  write(f.W, 'new/a.txt', 'saved\n')
  assert.equal(reset(f, s.sha, 0).state, 'reset')
  assert.ok(fs.existsSync(path.join(outside, 'a.txt')))
})

test('resetEmpty sets a dirty index back to the base, refusing index-only content and a moved HEAD', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n', 'u.txt': 'u\n' })
  git(f.W, ['rm', '--cached', '-q', 'u.txt'])
  const e = run(f.env, 0, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.deepEqual(e, { state: 'empty', base: f.base, head: f.base, indexDirty: true, scope: e.scope })
  const snap = snapshot(f.W)
  assert.deepEqual(resetEmpty(f.paths, { holder: f.N, record: f.N, base: f.base, env: f.env }), { state: 'index-reset', base: f.base })
  assert.equal(gitCode(f.W, ['diff-index', '--cached', '--quiet', f.base]), 0)
  assert.ok(git(f.W, ['ls-files']).split('\n').includes('u.txt'))
  assert.deepEqual(snapshot(f.W), snap, 'the work tree is untouched')

  // Staged content found nowhere else is refused; the same content in a known commit is not.
  const oid = git(f.W, ['hash-object', '-w', '--stdin'], { input: 'staged only\n' })
  git(f.W, ['update-index', '--cacheinfo', `100644,${oid},a.txt`])
  const idx = gitState(f.W).index
  assert.throws(() => resetEmpty(f.paths, { holder: f.N, record: f.N, base: f.base, env: f.env }),
    err => err.code === 'REFUSED' && err.state === 'index-only' && err.extra.paths[0] === 'a.txt')
  assert.equal(gitState(f.W).index, idx, 'a refusal leaves the index')
  const tree = git(f.W, ['write-tree'])
  const commit = git(f.W, ['commit-tree', tree, '-p', f.base, '-m', 'a rewound delegate commit'])
  assert.equal(resetEmpty(f.paths, { holder: f.N, record: f.N, base: f.base, also: [commit], env: f.env }).state, 'index-reset')
  assert.equal(gitCode(f.W, ['diff-index', '--cached', '--quiet', f.base]), 0)

  git(f.W, ['commit', '-q', '--allow-empty', '-m', 'moved'])
  assert.throws(() => resetEmpty(f.paths, { holder: f.N, record: f.N, base: f.base, env: f.env }), err => err.state === 'head-moved')
  assert.throws(() => resetEmpty(f.paths, { holder: f.N + 1, record: f.N, base: f.base, env: f.env }), err => err.code === 'NOT_HOLDER')
})

test('a newer holder resets into an older record: the header names both generations, recovery steps advance', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'left by generation N\n')
  write(f.W, 'n.txt', 'new\n')
  await kill(f.holder)
  const env2 = { ...f.env, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const M = (await acquire(f.P, { env: env2 })).generation
  assert.equal(M, f.N + 1)
  const rec = readRecord(f.paths, f.N)
  const s = saveFor(f.paths, { saver: M, source: f.N, base: rec.base, rules: rec.rules, why: 'clean-clone', env: env2 })
  const h = header(f, s.sha)
  assert.equal(h.generation, M)
  assert.deepEqual(h.source, { generation: f.N })
  updateRecord(f.paths, f.N, { recovery: { by: M, base: rec.base, bundles: [s.sha], step: 'saved' } })
  assert.throws(() => resetFor(f.paths, { holder: M, record: M + 1, sha: s.sha, env: env2 }), /record-from-the-future/)
  const r = resetFor(f.paths, { holder: M, record: f.N, sha: s.sha, env: env2 })
  assert.equal(r.state, 'reset')
  const after = readRecord(f.paths, f.N)
  assert.equal(after.recovery.step, 'done')
  assert.equal(after.recovery.reset_sha, s.sha)
  assert.equal(after.recovery.by, M)
  assert.equal(after.phase, 'prepared', 'an older record keeps its phase')
  assert.equal(git(f.W, ['status', '--porcelain']), '')
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

test('an ignored file and an ignored symlink standing where the base tracks a directory are saved before the reset removes them (Cg1#2, data-safety#2)', T, async t => {
  const f = await fixture(t, { '.gitignore': 'out\nlnk\n', 'docs/out/index.md': 'tracked\n', 'docs/lnk/x.md': 'x\n', 'a.txt': 'a\n' },
    { plumb: P => git(P, ['add', '-f', 'docs']) })
  fs.rmSync(path.join(f.W, 'docs/out'), { recursive: true })
  write(f.W, 'docs/out', 'PRECIOUS delegate content\n')
  fs.rmSync(path.join(f.W, 'docs/lnk'), { recursive: true })
  fs.symlinkSync('../a.txt', path.join(f.W, 'docs/lnk'))
  write(f.W, 'a.txt', 'edited\n')
  const pre = snapshot(f.W, { dirs: false })
  const s = save(f)
  const h = header(f, s.sha)
  assert.deepEqual(h.files.map(e => [e.path, e.kind, e.obstructed]), [
    ['a.txt', 'modified', false], ['docs/lnk', 'added', true], ['docs/lnk/x.md', 'deleted', false],
    ['docs/out', 'added', true], ['docs/out/index.md', 'deleted', false],
  ])
  assert.equal(git(f.W, ['cat-file', 'blob', `${h.tree}:docs/out`]), 'PRECIOUS delegate content')
  const r = reset(f, s.sha, 0)
  assert.deepEqual(r.removed, ['docs/lnk', 'docs/out'])
  assert.equal(fs.readFileSync(path.join(f.W, 'docs/out/index.md'), 'utf8'), 'tracked\n')
  assert.deepEqual(snapshot(f.W, { dirs: false }), baseSnapshot(t, f))
  assert.deepEqual(scratchApply(t, f, s.sha), pre, 'the bundle reproduces the pre-reset bytes')
})

test('raw-only edits a conversion hides are saved, and the reset writes the checkout back without running a filter (R29)', T, async t => {
  const f = await fixture(t, { '.gitattributes': 'id.txt ident\n*.txt text\n*.dat filter=rw\n', 'id.txt': 'v $Id$ end\n', 't.txt': 'one\n', 'a.dat': 'hello\n' })
  const expanded = fs.readFileSync(path.join(f.W, 'id.txt'), 'latin1')
  assert.match(expanded, /\$Id: [0-9a-f]{40} \$/)
  const marker = path.join(f.root, 'smudge-ran')
  const script = path.join(f.root, 'rw.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\nsed s/hello/HELLO/\n`, { mode: 0o755 })
  const gcfg = path.join(f.root, 'filter.gitconfig')
  fs.writeFileSync(gcfg, `[filter "rw"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n`)
  const env = { ...f.env, GIT_CONFIG_GLOBAL: gcfg }
  write(f.W, 'id.txt', 'v $Id: unpublished note $ end\n')
  write(f.W, 't.txt', 'one\r\n')
  write(f.W, 'a.dat', 'hello again\n')
  const s = run(env, 0, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  const h = header(f, s.sha)
  assert.deepEqual(h.files.map(e => e.path), ['a.dat', 'id.txt', 't.txt'])
  assert.equal(git(f.W, ['cat-file', 'blob', `${h.tree}:id.txt`], { buffer: true }).toString('latin1'), 'v $Id: unpublished note $ end\n')
  assert.equal(git(f.W, ['cat-file', 'blob', `${h.tree}:t.txt`], { buffer: true }).toString('latin1'), 'one\r\n')
  const r = reset(f, s.sha, 0, env)
  assert.deepEqual(r.restored, ['a.dat', 'id.txt', 't.txt'])
  assert.equal(fs.readFileSync(path.join(f.W, 'id.txt'), 'latin1'), expanded, 'the checkout expansion is back')
  assert.equal(fs.readFileSync(path.join(f.W, 't.txt'), 'latin1'), 'one\n')
  assert.equal(fs.readFileSync(path.join(f.W, 'a.dat'), 'latin1'), 'hello\n', 'written as the base holds it: no smudge filter ran')
  assert.equal(fs.existsSync(marker), false, 'no filter ran during the reset')
  assert.equal(recordOf(f).phase, 'clean')
})

test('reset refuses unsaved for a path that became unsavable after the save: an unreadable new file, a fifo at a tracked path (contracts-tests#3)', T, async t => {
  if (IS_ROOT) return t.skip('root reads every file')
  const f = await fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  write(f.W, 'new.txt', 'written after the save, then made unreadable\n')
  fs.chmodSync(path.join(f.W, 'new.txt'), 0)
  t.after(() => { try { fs.chmodSync(path.join(f.W, 'new.txt'), 0o644) } catch { /* removed */ } })
  const snap = snapshot(f.W, { skip: ['new.txt'] })
  const un = reset(f, s.sha, 3)
  assert.equal(un.state, 'unsaved')
  assert.deepEqual(un.paths, ['new.txt'])
  assert.ok(fs.existsSync(path.join(f.W, 'new.txt')), 'the unreadable file is kept')
  assert.deepEqual(snapshot(f.W, { skip: ['new.txt'] }), snap)
  assert.equal(recordOf(f).phase, 'saved')
  fs.chmodSync(path.join(f.W, 'new.txt'), 0o644)
  fs.rmSync(path.join(f.W, 'new.txt'))
  fs.rmSync(path.join(f.W, 'b.txt'))
  execFileSync('mkfifo', [path.join(f.W, 'b.txt')])
  const un2 = reset(f, s.sha, 3)
  assert.equal(un2.state, 'unsaved')
  assert.deepEqual(un2.paths, ['b.txt'])
  assert.ok(fs.lstatSync(path.join(f.W, 'b.txt')).isFIFO(), 'the fifo is kept')
  assert.equal(recordOf(f).phase, 'saved')
})

test('removeUntracked calls guard before each unlink and each rmdir, and stops at the first refusal (R31)', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  for (const n of ['n/one.txt', 'n/two.txt', 'n/three.txt']) write(f.W, n, `${n}\n`)
  const seen = []
  const lost = Object.assign(new Error('not-holder: lost'), { code: 'NOT_HOLDER' })
  assert.throws(() => removeUntracked(f.W, ['n/one.txt', 'n/three.txt', 'n/two.txt'], new Set(), () => {}, p => {
    seen.push(p)
    if (seen.length === 2) throw lost
  }), err => err === lost)
  assert.deepEqual(seen, ['n/one.txt', 'n/three.txt'])
  assert.equal(exists(path.join(f.W, 'n/one.txt')), false)
  assert.equal(exists(path.join(f.W, 'n/three.txt')), true, 'nothing is unlinked after the guard refuses')
  assert.equal(exists(path.join(f.W, 'n/two.txt')), true)
  const all = []
  assert.deepEqual(removeUntracked(f.W, ['n/three.txt', 'n/two.txt'], new Set(), () => {}, p => all.push(p)), ['n/three.txt', 'n/two.txt'])
  assert.deepEqual(all, ['n/three.txt', 'n/two.txt', 'n'], 'the rmdir of the emptied directory is guarded too')
  assert.equal(exists(path.join(f.W, 'n')), false)
})

// Starts the CLI without waiting: {child, done: Promise<{status, out}>}.
function startCli(env, ...args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', d => { stdout += d })
  const done = new Promise(resolve => child.on('close', status => {
    const lines = stdout.trim() ? stdout.trim().split('\n') : []
    resolve({ status, lines, out: lines.length === 1 ? JSON.parse(lines[0]) : null })
  }))
  return { child, done }
}

test('a reset that loses the lock mid-way stops at once and reports not-holder, never partial (R31, Cg1#5)', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  const names = Array.from({ length: 120 }, (_, i) => `new/f${String(i).padStart(3, '0')}.txt`)
  for (const n of names) write(f.W, n, `${n}\n`)
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  const first = path.join(f.W, names[0])
  const { done } = startCli(f.env, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
  // The first unlink has happened: the holder dies (a recovering acquire may now start).
  for (let i = 0; i < 6000 && exists(first); i++) await new Promise(r => setTimeout(r, 1))
  process.kill(f.holder, 'SIGKILL')
  const r = await done
  assert.equal(r.status, 3, JSON.stringify(r))
  assert.equal(r.out.state, 'not-holder')
  assert.equal(r.out.partial, undefined)
  const left = names.filter(n => exists(path.join(f.W, n)))
  assert.ok(left.length > 0, 'the reset stopped before removing every untracked file')
  assert.equal(fs.readFileSync(path.join(f.W, 'a.txt'), 'utf8'), 'edited\n', 'no read-tree ran after the lock was lost')
  const rec = recordOf(f)
  assert.equal(rec.phase, 'resetting', 'the intent stays; the next holder finishes the reset from it')
  assert.equal(rec.reset_sha, s.sha)
})

test('a reset that leaves an untracked path removeUntracked skips ends partial (exit 2) and the record is not marked clean (contracts-tests#5 postchk)', T, async t => {
  if (IS_ROOT) return t.skip('root searches every directory')
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited\n')
  write(f.W, 'd/x.txt', 'saved, then out of reach\n')
  const pre = snapshot(f.W, { dirs: false })
  const s = save(f)
  const k = cli({ ...f.env, TECH_LEAD_FAULT: 'reset:after-intent' }, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
  assert.equal(k.signal, 'SIGKILL')
  assert.equal(recordOf(f).phase, 'resetting')
  // d loses its search bit: git still lists d/x.txt from d's entries, and the resume accepts it
  // (the bundle lists it), but removeUntracked cannot lstat it and skips it without a word.
  // The mode is restored in `finally`, before the fixture's t.after removes the directory tree.
  const d = path.join(f.W, 'd')
  fs.chmodSync(d, 0o644)
  try {
    const r = reset(f, s.sha, 2)
    assert.equal(r.state, 'error')
    assert.equal(r.partial, true)
    assert.match(r.detail, /the clone is not clean after the reset: "d\/x\.txt"/)
    const rec = recordOf(f)
    assert.equal(rec.phase, 'resetting', 'the record is not marked clean')
    assert.equal(rec.reset_sha, s.sha)
  } finally {
    fs.chmodSync(d, 0o755)
  }
  assert.equal(fs.readFileSync(path.join(d, 'x.txt'), 'utf8'), 'saved, then out of reach\n', 'the skipped file is still there')
  assert.equal(fs.readFileSync(path.join(f.W, 'a.txt'), 'utf8'), 'a\n', 'the rest of the reset ran')
  // With d searchable again, the next reset finishes from the intent, and nothing was lost.
  assert.equal(reset(f, s.sha, 0).state, 'reset')
  assert.equal(recordOf(f).phase, 'clean')
  assert.equal(exists(d), false)
  assert.deepEqual(scratchApply(t, f, s.sha), pre)
})
