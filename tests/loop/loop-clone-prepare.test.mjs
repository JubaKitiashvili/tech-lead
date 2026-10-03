// tests/loop/loop-clone-prepare.test.mjs
// loop-clone.mjs prepare: integrity and quiet before any write, and every recovery arm of the
// clean-clone rule (brief 13.3, spec 7.5 as amended by A11; R4, R12, R20, R21). Real
// repositories, a held lock, real killed processes (TECH_LEAD_FAULT).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import {
  D2, FAKE_CODEX, PREFIX, T, attempt, check, cli, closeCli, commitCli, dweller, firing, git, headerOf, killAt, patches, prepare,
  prepareArgs, project, recordOf, scratchApply, snapshot, status, tipOf, waitGone, write,
} from './loop-clone-fixture.mjs'
import { createRecord } from '../../scripts/lib/run-record.mjs'
import { refsSnapshot, cloneMeta } from '../../scripts/lib/clone-check.mjs'

// The read-only planner of the same firing (loop-recover.mjs), its one JSON line asserted.
function planCli(fx, env = fx.env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loop-recover.mjs'), fx.P, '--generation', String(fx.N)], { encoding: 'utf8', env })
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `planner: one JSON line, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr.slice(0, 2000)})`)
  assert.equal(r.status, 0, `planner exit ${r.status}: ${lines[0]}`)
  return JSON.parse(lines[0])
}

// Every git trace variable a caller may carry: each writes to stderr from every git call.
const TRACE = {
  GIT_TRACE: '1', GIT_TRACE2: '1', GIT_TRACE2_EVENT: '1', GIT_TRACE2_PERF: '1', GIT_TRACE_PACKET: '1', GIT_TRACE_SETUP: '1',
  GIT_TRACE_PERFORMANCE: '1', GIT_TRACE_REFS: '1',
}

const BRANCH = `${PREFIX}/${D2}`
const BASE_FILES = {
  'a.txt': 'a\n', 'b.txt': 'b\n', 'del.txt': 'gone soon\n', 'exec.sh': 'echo hi\n', 'obs': 'a file in the base\n',
  'crlf.txt': 'x\n', '.gitignore': '*.log\n', 'src/app.js': 'app\n',
}

// Every file a bundle must reproduce: the work tree minus .git and the ignored install output.
const workSnap = W => snapshot(W, { skip: ['.git', '.venv', 'node.log'] }).filter(([, v]) => v !== 'd')

test('clean: an interrupted firing that left nothing is resolved without a bundle', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const first = fx.N
  await firing(fx)
  const out = prepare(fx)
  assert.deepEqual(out.recovered, [])
  assert.equal(recordOf(fx, first).recovery.step, 'done')
  assert.equal(recordOf(fx, first).recovery.by, fx.N)
  assert.deepEqual(patches(fx), [])
})

test('committed: a commit killed after its update-ref is taken from the record, the stale index reset, the commit bundled', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const subj = path.join(fx.root, 'subj')
  fs.writeFileSync(subj, 'Edit a\n')
  killAt(fx, 'commit:after-update-ref', 'commit', fx.P, '--generation', String(fx.N), '--digest', c.digest, '--subject-file', subj)
  const killed = fx.N
  const rec = recordOf(fx, killed)
  assert.equal(rec.phase, 'intent')
  const C = rec.intent.commit
  assert.equal(tipOf(fx.W), C)
  git(fx.W, ['read-tree', base]) // a stale index: the commit's own read-tree as if it never ran
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.head, C, "today's branch keeps the loop's commit")
  const after = recordOf(fx, killed)
  assert.equal(after.phase, 'committed')
  assert.deepEqual(after.commit, { sha: C })
  assert.equal(after.recovery.step, 'done')
  assert.equal(git(fx.W, ['diff-index', '--cached', '--name-only', 'HEAD']), '', 'the index is reset to the commit')
  assert.equal(status(fx.W), '')
  assert.deepEqual(out.bundles.map(b => [b.branch, b.tip]), [[BRANCH, C]])
  assert.deepEqual(out.recovered, [])
})

test('delegate-commit: a delegate commit is rewound, its changes saved and reset, and it is never bundled', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'd.txt', 'delegate\n')
  git(fx.W, ['add', 'd.txt'])
  git(fx.W, ['commit', '-q', '-m', 'delegate commit'])
  const tipD = tipOf(fx.W)
  const before = workSnap(fx.W)
  const killed = fx.N
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.head, base)
  assert.equal(out.recovered.length, 1)
  const r = out.recovered[0]
  assert.equal(r.generation, killed)
  assert.equal(r.rewound_from, tipD)
  assert.equal(r.files, 1)
  assert.equal(fs.existsSync(path.join(fx.W, 'd.txt')), false)
  assert.equal(status(fx.W), '')
  const rec = recordOf(fx, killed)
  assert.deepEqual(rec.recovery.rewind, { from: tipD, to: base })
  assert.deepEqual(rec.recovery.bundles, [r.sha])
  assert.equal(rec.recovery.step, 'done')
  assert.deepEqual(out.bundles, [])
  assert.equal(fs.existsSync(path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)), false, 'no bundle holds a delegate commit')
  assert.deepEqual(workSnap(scratchApply(fx, base, r.sha)), before)
})

test('rewind-intent is resumed with the tip at either end of the rewind', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  const delegateCommit = name => {
    check(fx, 'deps')
    write(fx.W, name, `${name}\n`)
    git(fx.W, ['add', name])
    git(fx.W, ['commit', '-q', '-m', name])
    return tipOf(fx.W)
  }
  await firing(fx)
  prepare(fx)
  const tip1 = delegateCommit('one.txt')
  const g1 = fx.N
  await firing(fx)
  killAt(fx, 'recover:after-rewind-intent', ...prepareArgs(fx))
  assert.equal(recordOf(fx, g1).recovery.step, 'rewind-intent')
  assert.equal(tipOf(fx.W), tip1, 'the kill came before the rewind')
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.head, base)
  assert.equal(out.recovered[0].rewound_from, tip1)
  assert.equal(recordOf(fx, g1).recovery.step, 'done')

  // The same, with the rewind's update-ref done before the kill: the tip is at its target.
  const tip2 = delegateCommit('two.txt')
  const g2 = fx.N
  await firing(fx)
  killAt(fx, 'recover:after-rewind-intent', ...prepareArgs(fx))
  git(fx.W, ['update-ref', `refs/heads/${BRANCH}`, base, tip2])
  await firing(fx)
  const out2 = prepare(fx)
  assert.equal(out2.head, base)
  assert.equal(out2.recovered[0].generation, g2)
  assert.equal(out2.recovered[0].rewound_from, tip2)
  assert.equal(fs.existsSync(path.join(fx.W, 'two.txt')), false)
  assert.equal(status(fx.W), '')
})

test('leftovers of every kind are saved under the recorded rules and reset; a self-ignored .venv stays (A11, R21)', T, async t => {
  const fx = project(t, { files: BASE_FILES })
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  // Dependency preparation: a venv that ignores itself, and ignored install output.
  write(fx.W, '.venv/.gitignore', '*\n')
  write(fx.W, '.venv/bin/python', 'py\n')
  write(fx.W, 'node.log', 'install log\n')
  const deps = check(fx, 'deps')
  assert.deepEqual(deps.touched, [])
  // The delegate.
  const W = fx.W
  write(W, 'a.txt', 'edited\n')
  fs.unlinkSync(path.join(W, 'del.txt'))
  fs.chmodSync(path.join(W, 'exec.sh'), 0o755)
  write(W, 'new.txt', 'new\n')
  fs.symlinkSync('a.txt', path.join(W, 'link'))
  write(W, 'crlf.txt', 'x\r\ny\r\n')
  fs.unlinkSync(path.join(W, 'obs'))
  write(W, 'obs/inner.txt', 'inner\n')
  write(W, 'obs/x.log', 'ignored, but inside an obstructing directory\n')
  write(W, '.gitignore', '*.log\nsecret.txt\n')
  write(W, 'secret.txt', 'hidden by the delegate\n')
  write(W, 'sub/.gitignore', '*\n')
  write(W, 'sub/hidden.txt', 'hidden too\n')
  write(W, '.tech-lead/notes.md', 'never in scope\n')
  const before = workSnap(W)
  const killed = fx.N
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.recovered.length, 1)
  const r = out.recovered[0]
  assert.equal(r.generation, killed)
  assert.equal(r.out_of_scope, 1)
  assert.ok(r.hidden >= 3, JSON.stringify(r))
  const h = headerOf(fx, r.sha)
  assert.equal(h.why, 'clean-clone')
  assert.equal(h.source.generation, killed)
  assert.equal(h.generation, fx.N)
  assert.equal(h.rules.mode, 'recorded')
  const byPath = Object.fromEntries(h.files.map(f => [f.path, f]))
  assert.equal(byPath['secret.txt'].hidden, true)
  assert.equal(byPath['sub/hidden.txt'].hidden, true)
  assert.equal(byPath['obs/x.log'].obstructed, true)
  assert.equal(byPath['.tech-lead/notes.md'].in_scope, false)
  assert.equal(byPath['exec.sh'].kind, 'mode-changed')
  assert.equal(byPath['link'].mode, '120000')
  // The clone is clean at the base; the venv and the ignored log stay.
  assert.equal(status(W), '')
  assert.equal(fs.readFileSync(path.join(W, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(fs.readFileSync(path.join(W, 'obs'), 'utf8'), 'a file in the base\n')
  for (const gone of ['new.txt', 'secret.txt', 'sub', 'link', '.tech-lead']) assert.equal(fs.existsSync(path.join(W, gone)), false, gone)
  assert.equal(fs.readFileSync(path.join(W, '.venv/bin/python'), 'utf8'), 'py\n')
  assert.equal(fs.readFileSync(path.join(W, 'node.log'), 'utf8'), 'install log\n')
  // I1: the bundle reproduces the pre-kill tree byte for byte.
  assert.deepEqual(workSnap(scratchApply(fx, base, r.sha)), before)
})

test('a dirty clone with no record (a stray writer after a normal close) is saved under the anchored rules: the current ones when the anchor holds none, the base rules with no anchor (R25)', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  fs.appendFileSync(path.join(fx.S, 'LEDGER.jsonl'), JSON.stringify({ iteration: fx.N }) + '\n')
  run3(fx)
  const anchorFile = path.join(fx.V, 'run', 'refs.json')
  assert.equal(JSON.parse(fs.readFileSync(anchorFile, 'utf8')).rules, null, 'no attempt ran: the anchor holds no rules')
  // The stray writer, including a directory that ignores itself.
  write(fx.W, 'stray.txt', 'stray\n')
  write(fx.W, 'a.txt', 'changed\n')
  write(fx.W, 'x/.gitignore', '*\n')
  write(fx.W, 'x/f.txt', 'f\n')
  const before = workSnap(fx.W)
  await firing(fx)
  const out = prepare(fx)
  assert.deepEqual(out.recovered.map(r => [r.generation, r.files]), [[null, 2]], JSON.stringify(out.recovered))
  const sha = out.recovered[0].sha
  assert.equal(headerOf(fx, sha).rules.mode, 'current')
  assert.equal(status(fx.W), '')
  assert.equal(fs.readFileSync(path.join(fx.W, 'x/f.txt'), 'utf8'), 'f\n', 'what the current rules ignore stays')
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'prepared')
  assert.deepEqual(rec.saves, [{ sha, why: 'clean-clone' }])
  assert.deepEqual(workSnap(scratchApply(fx, base, sha)), before.filter(([p]) => !p.startsWith('x/')))

  // With no anchor at all, the base's rules list everything the base does not ignore.
  fs.appendFileSync(path.join(fx.S, 'LEDGER.jsonl'), JSON.stringify({ iteration: fx.N, saves: [{ sha }] }) + '\n')
  run3(fx)
  fs.rmSync(anchorFile)
  write(fx.W, 'stray2.txt', 'stray 2\n')
  const before2 = workSnap(fx.W)
  await firing(fx)
  const out2 = prepare(fx)
  assert.deepEqual(out2.recovered.map(r => [r.generation, r.files]), [[null, 3]], JSON.stringify(out2.recovered))
  assert.equal(headerOf(fx, out2.recovered[0].sha).rules.mode, 'base')
  assert.equal(status(fx.W), '')
  assert.equal(fs.existsSync(path.join(fx.W, 'x')), false)
  assert.deepEqual(workSnap(scratchApply(fx, base, out2.recovered[0].sha)), before2)
})

// close for a firing whose record is clean at the base and ledgered.
function run3(fx) {
  const r = cli(fx.env, 'close', fx.P, '--generation', String(fx.N))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(r.out.closed, [fx.N])
}

test('resume: a prepare killed after its save resets with the recorded bundle, which is reused (I7)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const g1 = fx.N
  await firing(fx)
  killAt(fx, 'recover:after-save', ...prepareArgs(fx))
  const g2 = fx.N
  const saved = recordOf(fx, g1).recovery
  assert.equal(saved.step, 'saved')
  assert.equal(saved.bundles.length, 1)
  await firing(fx)
  const out = prepare(fx)
  assert.deepEqual(out.recovered.map(r => [r.generation, r.sha]), [[g1, saved.bundles[0]]])
  assert.deepEqual(patches(fx), [`${saved.bundles[0]}.patch`], 'no second bundle')
  assert.equal(status(fx.W), '')
  assert.equal(recordOf(fx, g1).recovery.step, 'done')
  assert.equal(recordOf(fx, g2).recovery.note, 'superseded')
})

test('resume-reset: a reset killed mid-way is finished, a half-written file included', T, async t => {
  for (const point of ['reset:after-intent', 'reset:after-unlink-one', 'reset:after-read-tree']) {
    await t.test(point, async t2 => {
      const fx = project(t2)
      const base = tipOf(fx.P, 'main')
      await firing(fx)
      prepare(fx)
      check(fx, 'deps')
      write(fx.W, 'a.txt', 'edited '.repeat(100) + '\n')
      write(fx.W, 'new1.txt', 'one\n')
      write(fx.W, 'new2.txt', 'two\n')
      const before = workSnap(fx.W)
      const g1 = fx.N
      await firing(fx)
      killAt(fx, point, ...prepareArgs(fx))
      const rec = recordOf(fx, g1)
      assert.equal(rec.recovery.step, 'resetting')
      // A kill inside read-tree -u leaves a file half-written.
      write(fx.W, 'a.txt', 'edi')
      await firing(fx)
      const out = prepare(fx)
      assert.equal(status(fx.W), '')
      assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
      assert.deepEqual(out.recovered.map(r => r.sha), [rec.recovery.reset_sha])
      assert.equal(recordOf(fx, g1).recovery.step, 'done')
      assert.deepEqual(workSnap(scratchApply(fx, base, rec.recovery.reset_sha)), before)
    })
  }
})

test('superseded (R4): a bare preparing record is superseded; of two prepared records the newest owns the tree', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'one\n')
  const g1 = fx.N
  await firing(fx)
  killAt(fx, 'prepare:after-preparing', ...prepareArgs(fx))
  const g2 = fx.N
  assert.equal(recordOf(fx, g2).phase, 'preparing')
  await firing(fx)
  const out = prepare(fx)
  assert.deepEqual(out.recovered.map(r => r.generation), [g1])
  assert.equal(recordOf(fx, g2).recovery.note, 'superseded')
  assert.equal(recordOf(fx, g2).recovery.step, 'done')
  assert.equal(recordOf(fx, g1).recovery.note, null)

  // Two prepared records: a planted newer one owns the tree, the older is superseded.
  check(fx, 'deps')
  write(fx.W, 'b.txt', 'two\n')
  const g3 = fx.N
  const planted = g3 + 1
  const W = fx.W
  assert.equal(createRecord(fx.paths, planted, {
    phase: 'prepared', branch: BRANCH, head_ref: `refs/heads/${BRANCH}`, base: tipOf(W), refs: refsSnapshot(W).refs, meta_sha: cloneMeta(W),
  }), true)
  await firing(fx)
  assert.ok(fx.N > planted)
  const out2 = prepare(fx)
  assert.deepEqual(out2.recovered.map(r => r.generation), [planted])
  assert.equal(recordOf(fx, g3).recovery.note, 'superseded')
  assert.equal(recordOf(fx, planted).recovery.note, null)
  assert.equal(status(fx.W), '')
})

test('a committed older record behind a preparing record killed at prepare:after-preparing: the planner and prepare take the committed one', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const C = attempt(fx, W => write(W, 'a.txt', 'committed\n')).commit.sha
  const g1 = fx.N
  // Killed before the commit's bookkeeping: no close, the record stays committed and unresolved.
  assert.equal(recordOf(fx, g1).phase, 'committed')
  await firing(fx)
  killAt(fx, 'prepare:after-preparing', ...prepareArgs(fx))
  const g2 = fx.N
  assert.equal(recordOf(fx, g2).phase, 'preparing')
  assert.equal(recordOf(fx, g2).recovery, null)
  await firing(fx)
  // The planner judges the record prepare acts on, not the bare preparing record above it.
  const plan = planCli(fx)
  assert.deepEqual(plan.records.map(r => [r.generation, r.phase, r.verdict, r.sha]), [[g1, 'committed', 'committed', C], [g2, 'preparing', 'superseded', null]])
  assert.ok(plan.notes.some(n => n.includes(`generation ${g2} is superseded by generation ${g1}`)), JSON.stringify(plan.notes))
  const out = prepare(fx)
  assert.equal(out.head, C, "today's branch keeps the loop's commit")
  assert.deepEqual(out.recovered, [])
  assert.ok(out.notes.includes(`generation ${g2} superseded by generation ${g1}`), JSON.stringify(out.notes))
  const owner = recordOf(fx, g1)
  assert.equal(owner.phase, 'committed')
  assert.deepEqual(owner.commit, { sha: C })
  assert.deepEqual([owner.recovery.by, owner.recovery.step, owner.recovery.note], [fx.N, 'done', null])
  assert.deepEqual([recordOf(fx, g2).recovery.step, recordOf(fx, g2).recovery.note], ['done', 'superseded'])
  assert.equal(status(fx.W), '')
  assert.deepEqual(patches(fx), [], 'nothing was left to save')
})

test('an inherited GIT_TRACE* makes no helper report a clone problem; the passthrough still hands it to git', T, async t => {
  const fx = project(t)
  const env = { ...fx.env, ...TRACE }
  await firing(fx)
  // Creation (checkClone on the new clone before the rename), then an existing clone (checkClone twice).
  assert.equal(prepare(fx, { env }).created, true)
  check(fx, 'deps', { env })
  write(fx.W, 'a.txt', 'traced\n')
  const c = check(fx, 'dispatch', { env })
  assert.equal(commitCli(fx, c.digest, { env }).state, 'committed')
  await firing(fx)
  const plan = planCli(fx, env)
  assert.equal(plan.clone.valid, true)
  assert.deepEqual(plan.clone.problems, [])
  const out = prepare(fx, { env })
  assert.equal(out.created, false)
  check(fx, 'deps', { env })
  write(fx.W, 'b.txt', 'saved\n')
  const save = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reflex-bundle.mjs'), 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env })
  assert.equal(save.status, 0, save.stdout + save.stderr.slice(0, 2000))
  assert.equal(JSON.parse(save.stdout).state, 'saved')
  assert.equal(closeCli(fx, { env }).state, 'closed')
  const pass = cli(env, 'git', fx.P, '--', 'rev-parse', 'HEAD')
  assert.equal(pass.status, 0, pass.stderr.slice(0, 2000))
  assert.equal(pass.stdout.trim(), tipOf(fx.W))
  assert.match(pass.stderr, / trace: built-in: git rev-parse HEAD/, 'the caller\'s own git command is traced')
})

test('clone-missing: unresolved records of a clone that was set aside are closed with a note, and a new clone is made', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'saved, then lost with the clone\n')
  // A save whose reset never ran (a busy pause): the record anchors the bundle.
  const save = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reflex-bundle.mjs'), 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env: fx.env })
  assert.equal(save.status, 0, save.stdout + save.stderr)
  const s = JSON.parse(save.stdout).sha
  write(fx.W, 'b.txt', 'lost with the clone\n')
  const g1 = fx.N
  fs.renameSync(fx.W, path.join(fx.V, 'clone.broken-1'))
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.created, true)
  assert.ok(out.notes.some(n => n.includes(`generation ${g1}`) && /clone missing/.test(n)), JSON.stringify(out.notes))
  const rec = recordOf(fx, g1)
  assert.equal(rec.recovery.note, 'clone-missing')
  assert.equal(rec.recovery.step, 'done')
  assert.deepEqual(rec.saves, [{ sha: s, why: 'pause' }], 'the mark keeps the anchored save')
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  // The next planner still sees the save for ledger-recovered.
  await firing(fx)
  const plan = planCli(fx)
  assert.ok(plan.recovered && plan.recovered.bundles.includes(s), JSON.stringify(plan.recovered))
})

test('stale git locks are removed only after the sweep finds no process in <W>; a process there is busy', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const locks = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock', `refs/heads/${BRANCH}.lock`]
  for (const l of locks) fs.writeFileSync(path.join(fx.W, '.git', l), '')
  const pid = dweller(t, fx.W)
  await firing(fx)
  const busy = prepare(fx, { status: 3 })
  assert.equal(busy.state, 'busy')
  assert.ok(busy.procs.some(p => p.pid === pid), JSON.stringify(busy.procs))
  for (const l of locks) assert.ok(fs.existsSync(path.join(fx.W, '.git', l)), `${l} is kept while a process runs in <W>`)
  assert.equal(recordOf(fx), null, 'nothing was written')
  process.kill(pid, 'SIGKILL')
  await waitGone(pid)
  const out = prepare(fx)
  assert.equal(out.state, 'ready')
  for (const l of locks) assert.equal(fs.existsSync(path.join(fx.W, '.git', l)), false, `${l} removed`)
})

test('quiesce not quiet: prepare refuses not-quiet and leaves <W> untouched', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'dirty\n')
  const before = snapshot(fx.W, { skip: [], times: true })
  const state = path.join(fx.root, 'codex-state.json')
  fs.writeFileSync(state, JSON.stringify({ listError: 'state unreadable' }))
  await firing(fx)
  const env = { ...fx.env, TECH_LEAD_CODEX_COMPANION: FAKE_CODEX, FAKE_CODEX_STATE: state }
  const out = prepare(fx, { status: 3, env })
  assert.equal(out.state, 'not-quiet')
  assert.deepEqual(snapshot(fx.W, { skip: [], times: true }), before)
  assert.equal(recordOf(fx), null)
})

test('a ref changed in <W> between firings is tampered, naming the ref, and nothing changes', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  git(fx.W, ['tag', 'evil'])
  git(fx.W, ['update-ref', 'refs/heads/tl/2026-01-01', 'HEAD'])
  const before = snapshot(fx.W, { skip: [], times: true })
  await firing(fx)
  const out = prepare(fx, { status: 3 })
  assert.equal(out.state, 'tampered')
  assert.match(out.detail, /refs\/tags\/evil/)
  assert.match(out.detail, /refs\/heads\/tl\/2026-01-01/)
  assert.deepEqual(snapshot(fx.W, { skip: [], times: true }), before)
  assert.equal(recordOf(fx), null)
})

test('an invalid clone is refused clone-invalid before anything is written', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  git(fx.W, ['config', 'user.name', 'delegate'])
  await firing(fx)
  const out = prepare(fx, { status: 3 })
  assert.equal(out.state, 'clone-invalid')
  assert.ok(out.problems.some(p => /user\.name/.test(p)), JSON.stringify(out.problems))
  assert.equal(recordOf(fx), null)
})

test('commit:after-intent: the uncommitted work is saved and the item reruns (R12)', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'verified, not committed\n')
  const c = check(fx, 'dispatch')
  const subj = path.join(fx.root, 'subj')
  fs.writeFileSync(subj, 'S\n')
  killAt(fx, 'commit:after-intent', 'commit', fx.P, '--generation', String(fx.N), '--digest', c.digest, '--subject-file', subj)
  const g1 = fx.N
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.head, base)
  assert.equal(out.recovered.length, 1)
  assert.equal(out.recovered[0].generation, g1)
  assert.equal(recordOf(fx, g1).phase, 'intent')
  assert.equal(recordOf(fx, g1).recovery.step, 'done')
  assert.equal(status(fx.W), '')
  void commitCli
})

test('every other loop-clone fault point: the next firing comes back ready and clean, and the edit is kept', T, async t => {
  const subj = fx => {
    const f = path.join(fx.root, 'subject')
    fs.writeFileSync(f, 'Edit\n')
    return f
  }
  // The firing that is killed: a prepare (the edit left by the previous firing), a check after a
  // delegate commit, or a commit after its check.
  const leftover = async fx => {
    await firing(fx)
    prepare(fx)
    check(fx, 'deps')
    write(fx.W, 'edit.txt', 'edit\n')
    await firing(fx)
  }
  const cases = [
    ['prepare:after-temps', leftover, fx => prepareArgs(fx)],
    ['prepare:after-locks', leftover, fx => prepareArgs(fx)],
    ['recover:after-reset', leftover, fx => prepareArgs(fx)],
    ['refresh:after-fetch', leftover, fx => prepareArgs(fx)],
    ['rotate:after-switch', leftover, fx => prepareArgs(fx, { date: '2026-10-03' })],
    ['prepare:after-record', leftover, fx => prepareArgs(fx)],
    ['recover:after-rewind', async fx => {
      await firing(fx)
      prepare(fx)
      check(fx, 'deps')
      write(fx.W, 'edit.txt', 'edit\n')
      git(fx.W, ['add', 'edit.txt'])
      git(fx.W, ['commit', '-q', '-m', 'delegate'])
      await firing(fx)
    }, fx => prepareArgs(fx)],
    ['clone:before-rename', async fx => { await firing(fx) }, fx => prepareArgs(fx)],
    ['check:after-rewind', async fx => {
      await firing(fx)
      prepare(fx)
      check(fx, 'deps')
      write(fx.W, 'edit.txt', 'edit\n')
      git(fx.W, ['add', 'edit.txt'])
      git(fx.W, ['commit', '-q', '-m', 'delegate'])
    }, fx => ['check', fx.P, '--generation', String(fx.N), '--after', 'dispatch']],
    ['commit:after-record', async fx => {
      await firing(fx)
      prepare(fx)
      check(fx, 'deps')
      write(fx.W, 'edit.txt', 'edit\n')
    }, fx => ['commit', fx.P, '--generation', String(fx.N), '--digest', check(fx, 'dispatch').digest, '--subject-file', subj(fx)]],
  ]
  for (const [point, setup, args] of cases) {
    await t.test(point, async t2 => {
      const fx = project(t2)
      await setup(fx)
      killAt(fx, point, ...args(fx))
      await firing(fx)
      const out = prepare(fx, { date: '2026-10-03' })
      assert.equal(out.state, 'ready')
      assert.equal(status(fx.W), '')
      for (const l of ['index.lock', 'HEAD.lock']) assert.equal(fs.existsSync(path.join(fx.W, '.git', l)), false)
      if (point === 'clone:before-rename') {
        assert.equal(out.created, true)
        return
      }
      let inHead = false
      try { inHead = git(fx.W, ['show', 'HEAD:edit.txt']) === 'edit' } catch { inHead = false }
      const inBundle = patches(fx).some(p => headerOf(fx, p.slice(0, 64)).files.some(f => f.path === 'edit.txt'))
      assert.ok(inHead || inBundle, `${point}: the edit is neither committed nor saved`)
      if (point === 'commit:after-record') {
        assert.ok(inHead)
        assert.ok(fs.existsSync(path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)), 'the commit is bundled by the next prepare')
      }
    })
  }
})

test('today\'s branch at a tip nothing vouches for is reset to a fresh start point (R11, contracts-tests#5)', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  // The run's records are lost: no record, no anchor, and no ledger row names the commit.
  for (const n of fs.readdirSync(path.join(fx.V, 'run'))) if (/^(?:[0-9]+|refs)\.json$/.test(n)) fs.rmSync(path.join(fx.V, 'run', n))
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.retiredReset, true)
  assert.equal(out.head, base)
  assert.equal(tipOf(fx.W, `refs/heads/${BRANCH}`), base)
  assert.ok(out.notes.some(n => n.includes(BRANCH) && n.includes(a.commit.sha.slice(0, 12)) && /not vetted/.test(n)), JSON.stringify(out.notes))
})

test('a rewind onto the loop\'s own commit, killed after the rewind, resumes against that commit, not the record\'s base (contracts-tests#5)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  const C = a.commit.sha
  // After the loop's commit a delegate commits D on top of it and leaves an edit.
  write(fx.W, 'two.txt', '2\n')
  git(fx.W, ['add', 'two.txt'])
  git(fx.W, ['commit', '-q', '-m', 'D'])
  const D = tipOf(fx.W)
  write(fx.W, 'b.txt', 'edited\n')
  const g1 = fx.N
  await firing(fx)
  killAt(fx, 'recover:after-rewind', ...prepareArgs(fx))
  const rec = recordOf(fx, g1)
  assert.equal(rec.recovery.step, 'rewound')
  assert.equal(rec.recovery.base, C)
  assert.equal(tipOf(fx.W), C)
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.state, 'ready')
  assert.deepEqual(out.recovered.map(r => [r.generation, r.rewound_from]), [[g1, D]])
  const h = headerOf(fx, out.recovered[0].sha)
  assert.equal(h.base, C)
  assert.deepEqual(h.files.map(f => f.path).sort(), ['b.txt', 'two.txt'])
  assert.equal(tipOf(fx.W, `refs/heads/${BRANCH}`), C)
  assert.equal(status(fx.W), '')
})
