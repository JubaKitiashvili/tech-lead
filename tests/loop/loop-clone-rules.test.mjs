// tests/loop/loop-clone-rules.test.mjs
// loop-clone.mjs: which ignore rules list leftovers once close has deleted every record (R25),
// close keeping an own committed record whose tree still holds hidden files (R25, R2), and
// explicit vetting (R28): the adopted tips the creating prepare stores, the tamper check that
// skips only a record holding no snapshot, and a planted ref that a snapshot never vets. Real
// repositories, a held lock, real killed processes (TECH_LEAD_FAULT).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  D1, D2, D3, D4, PREFIX, T, appendLedger, attempt, check, closeCli, commitCli, firing, git, gitCode, headerOf, killAt, prepare,
  prepareArgs, project, recordGenerations, recordOf, scratchApply, snapshot, status, tipOf, write,
} from './loop-clone-fixture.mjs'

const anchorFile = fx => path.join(fx.V, 'run', 'refs.json')
const readAnchor = fx => JSON.parse(fs.readFileSync(anchorFile(fx), 'utf8'))
const exists = (fx, rel) => fs.existsSync(path.join(fx.W, rel))
const FILES = { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': 'node_modules/\n', 'src/app.js': 'app\n' }
const filesOf = (fx, sha) => headerOf(fx, sha).files.map(f => f.path).sort()

// What a dependency install leaves: tools that ignore themselves (a venv, husky's hook shim).
function installDeps(W) {
  write(W, '.venv/.gitignore', '*\n')
  write(W, '.venv/bin/python', 'py\n')
  write(W, '.husky/_/.gitignore', '*\n')
  write(W, '.husky/_/pre-commit', 'hook\n')
}
const depsSnap = fx => ({ venv: snapshot(path.join(fx.W, '.venv'), { skip: [] }), husky: snapshot(path.join(fx.W, '.husky'), { skip: [] }) })

test('after a clean close the next prepare lists leftovers under the anchored rules: install output stays, a stray self-ignored directory is saved (R25, data-safety#1)', T, async t => {
  const fx = project(t, { files: FILES })
  await firing(fx)
  prepare(fx)
  installDeps(fx.W)
  const a = attempt(fx, W => write(W, 'a.txt', 'edited\n'))
  const g1 = fx.N
  const rules1 = recordOf(fx).rules
  assert.ok(rules1.ignores.some(i => i.path === '.venv/.gitignore'), JSON.stringify(rules1.ignores))
  appendLedger(fx, { iteration: g1, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  assert.deepEqual(closeCli(fx), { state: 'closed', closed: [g1], kept: [] })
  assert.deepEqual(recordGenerations(fx), [])
  const anchor = readAnchor(fx)
  const installed = depsSnap(fx)

  // A stray writer after the close: a directory that ignores itself, and an edit.
  write(fx.W, 'stray/.gitignore', '*\n')
  write(fx.W, 'stray/x.txt', 'x\n')
  await firing(fx)
  const g2 = fx.N
  const out = prepare(fx)
  assert.deepEqual(out.recovered.map(r => [r.generation, r.files]), [[null, 2]], JSON.stringify(out.recovered))
  const sha = out.recovered[0].sha
  assert.equal(headerOf(fx, sha).rules.mode, 'recorded')
  assert.deepEqual(filesOf(fx, sha), ['stray/.gitignore', 'stray/x.txt'])
  assert.equal(exists(fx, 'stray'), false)
  assert.deepEqual(depsSnap(fx), installed, 'the install output is neither saved nor removed')
  assert.equal(status(fx.W), '')
  assert.equal(anchor.v, 2)
  assert.equal(anchor.generation, g1)
  assert.deepEqual(anchor.rules, rules1, 'close anchored the rules of the record it closed')

  // No attempt ran in g2 (its record has no rules): its close carries g1's rules forward.
  appendLedger(fx, { iteration: g2, saves: [{ sha }] })
  assert.deepEqual(closeCli(fx).closed, [g2])
  assert.equal(readAnchor(fx).generation, g2)
  assert.deepEqual(readAnchor(fx).rules, rules1)
  write(fx.W, 'stray2/.gitignore', '*\n')
  write(fx.W, 'stray2/y.txt', 'y\n')
  await firing(fx)
  const out3 = prepare(fx)
  assert.deepEqual(out3.recovered.map(r => [r.generation, r.files]), [[null, 2]], JSON.stringify(out3.recovered))
  assert.deepEqual(filesOf(fx, out3.recovered[0].sha), ['stray2/.gitignore', 'stray2/y.txt'])
  assert.deepEqual(depsSnap(fx), installed)
})

test('close keeps an own committed record whose tree still holds hidden files (kept reason hidden); the next prepare saves them before a switch tracks the path (R25, R2, prose-checks#1, Cg4#1)', T, async t => {
  const fx = project(t, { files: FILES })
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  // The delegate hides a new file behind a rule it adds to the tracked .gitignore.
  write(fx.W, '.gitignore', 'node_modules/\nsecret.txt\n')
  write(fx.W, 'secret.txt', 'hidden by the delegate\n')
  const c = check(fx, 'dispatch')
  assert.deepEqual(c.touched, ['.gitignore'])
  assert.deepEqual(c.hidden, ['secret.txt'])
  const m = commitCli(fx, c.digest)
  assert.equal(m.state, 'committed')
  const g1 = fx.N
  appendLedger(fx, { iteration: g1, commits: [m.sha], bundles: [m.bundle] })
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [])
  assert.deepEqual(out.kept, [{ generation: g1, dirty: true, reason: 'hidden' }])
  assert.equal(recordOf(fx, g1).phase, 'committed')

  // The owner merges the loop commit and starts tracking that path (Cg4#1).
  const b = path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)
  git(fx.P, ['fetch', '-q', b, `refs/heads/${PREFIX}/${D2}:refs/remotes/tech-lead/${PREFIX}/${D2}`])
  git(fx.P, ['merge', '-q', '--no-ff', '-m', 'merge day 2', `refs/remotes/tech-lead/${PREFIX}/${D2}`])
  write(fx.P, 'secret.txt', 'the owner\'s own\n')
  git(fx.P, ['add', '-f', 'secret.txt'])
  git(fx.P, ['commit', '-q', '-m', 'track secret.txt'])

  // The next day: the hidden file is saved before the switch to the new base writes the owner's.
  await firing(fx)
  const g2 = fx.N
  const next = prepare(fx, { date: D3 })
  assert.deepEqual(next.recovered.map(r => [r.generation, r.files, r.hidden]), [[g1, 1, 1]], JSON.stringify(next.recovered))
  const sha = next.recovered[0].sha
  assert.equal(headerOf(fx, sha).rules.mode, 'recorded')
  assert.deepEqual(filesOf(fx, sha), ['secret.txt'])
  assert.equal(headerOf(fx, sha).base, m.sha)
  assert.equal(fs.readFileSync(scratchApply(fx, m.sha, sha) + '/secret.txt', 'utf8'), 'hidden by the delegate\n')
  assert.equal(next.head, tipOf(fx.P, 'main'))
  assert.equal(fs.readFileSync(path.join(fx.W, 'secret.txt'), 'utf8'), 'the owner\'s own\n')
  appendLedger(fx, { iteration: g2, recovered: { bundles: [sha] } })
  assert.deepEqual(closeCli(fx).closed, [g1, g2])
})

test('a prepare killed after its own clean-clone save, its reset or the refresh leaves the next prepare ready, never tampered (R28, recovery#1)', T, async t => {
  for (const point of ['recover:after-save', 'reset:after-intent', 'recover:after-reset', 'refresh:after-fetch']) {
    await t.test(point, async t2 => {
      const fx = project(t2)
      await firing(fx)
      prepare(fx)
      appendLedger(fx, { iteration: fx.N })
      assert.deepEqual(closeCli(fx).closed, [fx.N])
      write(fx.W, 'stray.txt', 'stray\n')
      await firing(fx)
      const g2 = fx.N
      killAt(fx, point, ...prepareArgs(fx))
      const rec = recordOf(fx, g2)
      assert.notEqual(rec.phase, 'preparing', point)
      assert.equal(rec.head_ref, null)
      assert.deepEqual(rec.saves.length, 1)
      const sha = rec.saves[0].sha
      await firing(fx)
      const out = prepare(fx)
      assert.equal(out.state, 'ready', JSON.stringify(out))
      assert.equal(exists(fx, 'stray.txt'), false)
      assert.equal(status(fx.W), '')
      const shas = out.recovered.map(r => r.sha)
      assert.ok(shas.every(s => s === sha), `the anchored bundle is reused: ${JSON.stringify(out.recovered)}`)
      await firing(fx)
      assert.equal(prepare(fx).state, 'ready', 'and the firing after that one too')
    })
  }
})

// A commit the loop never made: base plus `file`, written with plain git in <W>.
function plantCommit(fx, base, file) {
  const idx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lc-idx-')), 'index')
  const env = { ...process.env, GIT_INDEX_FILE: idx }
  git(fx.W, ['read-tree', base], { env })
  const blob = git(fx.W, ['hash-object', '-w', '--stdin'], { input: `${file}\n` })
  git(fx.W, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env })
  const tree = git(fx.W, ['write-tree'], { env })
  fs.rmSync(path.dirname(idx), { recursive: true, force: true })
  return git(fx.W, ['commit-tree', tree, '-p', base, '-m', 'planted'])
}

test('a ref planted while the newest record is preparing reaches the next snapshot but is never vetted: not chained on, not bundled (R28, contracts-tests#1)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  closeCli(fx)
  await firing(fx)
  killAt(fx, 'prepare:after-preparing', ...prepareArgs(fx, { date: D2 }))
  const planted = `${PREFIX}/2026-10-09`
  const D = plantCommit(fx, tipOf(fx.W, 'refs/tech-lead/base'), 'evil.txt')
  git(fx.W, ['update-ref', `refs/heads/${planted}`, D])
  await firing(fx)
  const f3 = prepare(fx, { date: D3 })
  assert.equal(f3.state, 'ready')
  assert.ok(f3.notes.some(n => n.includes(planted) && /not vetted/.test(n)), JSON.stringify(f3.notes))
  assert.equal(recordOf(fx).refs[`refs/heads/${planted}`], D, 'the snapshot holds the planted ref')
  await firing(fx)
  const f4 = prepare(fx, { date: D4 })
  assert.notEqual(f4.chainedFrom, planted)
  assert.equal(f4.chainedFrom, `${PREFIX}/${D3}`)
  assert.ok(!f4.bundles.some(b => b.branch === planted || b.tip === D), JSON.stringify(f4.bundles))
  assert.equal(fs.existsSync(path.join(fx.V, 'out', PREFIX, '2026-10-09.bundle')), false)
  assert.equal(gitCode(fx.W, ['merge-base', '--is-ancestor', D, 'HEAD']), 1, 'the planted commit is not an ancestor of HEAD')
  assert.equal(fs.existsSync(path.join(fx.W, 'evil.txt')), false)
})

test('the creating prepare stores the tips it adopted (adopted); they stay vetted when the firing dies before its ledger row (R28, Cg3#5)', T, async t => {
  const fx = project(t)
  git(fx.P, ['switch', '-q', '--detach', 'main'])
  write(fx.P, 'a30.txt', 'a30\n')
  git(fx.P, ['add', '-A'])
  git(fx.P, ['commit', '-q', '-m', 'a30'])
  const a = tipOf(fx.P)
  git(fx.P, ['switch', '-q', 'main'])
  const old = `${PREFIX}/2026-09-30`
  git(fx.P, ['update-ref', `refs/heads/${old}`, a])
  await firing(fx)
  const out = prepare(fx, { date: D2 })
  assert.deepEqual(out.adopted.map(r => [r.branch, r.tip]), [[old, a]])
  assert.deepEqual(recordOf(fx).adopted, [{ ref: `refs/heads/${old}`, tip: a }])
  // The firing dies here: no ledger row names a, and its bundle is lost.
  const file = path.join(fx.V, 'out', PREFIX, '2026-09-30.bundle')
  fs.rmSync(file)
  fs.rmSync(`${file}.json`)
  await firing(fx)
  const next = prepare(fx, { date: D3 })
  assert.equal(next.state, 'ready')
  assert.ok(!next.notes.some(n => n.includes(old) && /not vetted/.test(n)), JSON.stringify(next.notes))
  assert.ok(next.bundles.some(b => b.branch === old && b.tip === a), JSON.stringify(next.bundles))
  assert.equal(next.chainedFrom, old)
  assert.equal(next.head, a)
})

test('the run anchor carries only rules whose ignore files the clone holds: after the clone is set aside and made again, the next prepare is ready (R25)', T, async t => {
  const fx = project(t, { files: FILES })
  await firing(fx)
  prepare(fx)
  // An ignore file whose blob only this clone ever held.
  write(fx.W, 'tool/.gitignore', `*\n# ${fx.root}\n`)
  write(fx.W, 'tool/cache.bin', 'cache\n')
  check(fx, 'deps')
  const rules1 = recordOf(fx).rules
  assert.ok(rules1.ignores.some(i => i.path === 'tool/.gitignore'))
  appendLedger(fx, { iteration: fx.N })
  assert.deepEqual(closeCli(fx).closed, [fx.N])
  assert.deepEqual(readAnchor(fx).rules, rules1)
  // The owner sets the clone aside; the next firing makes a new one and runs no attempt.
  fs.renameSync(fx.W, `${fx.W}.aside`)
  t.after(() => fs.rmSync(`${fx.W}.aside`, { recursive: true, force: true }))
  await firing(fx)
  assert.equal(prepare(fx).created, true)
  appendLedger(fx, { iteration: fx.N })
  assert.deepEqual(closeCli(fx).closed, [fx.N])
  assert.equal(readAnchor(fx).rules, null, 'rules naming blobs the new clone lacks are not carried')
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.state, 'ready')
  assert.deepEqual(out.recovered, [])
})

// <P> gains the dated branch `name` at a commit beyond main that adds `file` (main stays put).
function oldBranch(fx, name, file) {
  git(fx.P, ['switch', '-q', '--detach', 'main'])
  write(fx.P, file, `${file}\n`)
  git(fx.P, ['add', '--', file]) // the spine <P>/.tech-lead stays untracked
  git(fx.P, ['commit', '-q', '-m', file])
  const tip = tipOf(fx.P)
  git(fx.P, ['switch', '-q', 'main'])
  git(fx.P, ['update-ref', `refs/heads/${name}`, tip])
  return tip
}

test('close keeps the creating record (kept reason adopted) until each adopted tip is ledgered or in the base, so a creation that died before its ledger row leaves them vetted (R32, code#6)', T, async t => {
  const fx = project(t)
  const oldA = `${PREFIX}/2026-09-30`
  const oldB = `${PREFIX}/2026-09-29`
  const a = oldBranch(fx, oldA, 'a30.txt')
  const b = oldBranch(fx, oldB, 'b29.txt')
  await firing(fx)
  const g1 = fx.N
  const out = prepare(fx, { date: D2 })
  assert.deepEqual(out.adopted.map(r => [r.branch, r.tip]), [[oldB, b], [oldA, a]])
  const rows = out.bundles.map(r => [r.branch, r.tip])
  assert.deepEqual(rows.filter(([br]) => br === oldA || br === oldB), [[oldB, b], [oldA, a]], JSON.stringify(rows))
  // The firing dies here, before its ledger row: no row names a or b, and their bundles stay
  // published and current, so no later firing writes a row naming them either.
  await firing(fx)
  const g2 = fx.N
  const second = prepare(fx, { date: D3 })
  assert.deepEqual(second.bundles, [], JSON.stringify(second.bundles))
  appendLedger(fx, { iteration: g2 })
  const c2 = closeCli(fx)
  assert.deepEqual(c2.kept, [{ generation: g1, dirty: false, reason: 'adopted' }], JSON.stringify(c2))
  assert.deepEqual(c2.closed, [g2], 'a record kept for its adopted tips holds back no newer one')
  assert.deepEqual(recordOf(fx, g1).adopted, [{ ref: `refs/heads/${oldB}`, tip: b }, { ref: `refs/heads/${oldA}`, tip: a }])
  assert.equal(readAnchor(fx).generation, g2, 'the anchor still records the clone as close saw it')
  // The adopted tips stay vetted meanwhile: chained on, and their bundles not skipped.
  await firing(fx)
  const g3 = fx.N
  const third = prepare(fx, { date: D4 })
  assert.ok(!third.notes.some(n => (n.includes(oldA) || n.includes(oldB)) && /not vetted/.test(n)), JSON.stringify(third.notes))
  assert.equal(third.chainedFrom, oldA)
  // A ledger row naming a as a bundle tip settles a; b still holds the record.
  appendLedger(fx, { iteration: g3, bundles: [{ branch: oldA, tip: a, file: `out/${oldA}.bundle`, sha256: 'a'.repeat(64), why: 'regenerated' }] })
  const c3 = closeCli(fx)
  assert.deepEqual(c3.kept, [{ generation: g1, dirty: false, reason: 'adopted' }], JSON.stringify(c3))
  assert.deepEqual(c3.closed, [g3])
  // The owner merges b into the base: once a refresh brings it, close lets the record go.
  git(fx.P, ['merge', '-q', '--no-ff', '-m', 'merge b', b])
  await firing(fx)
  const g4 = fx.N
  prepare(fx, { date: D4 })
  appendLedger(fx, { iteration: g4 })
  const c4 = closeCli(fx)
  assert.deepEqual(c4.kept, [], JSON.stringify(c4))
  assert.deepEqual(c4.closed, [g1, g4])
})
