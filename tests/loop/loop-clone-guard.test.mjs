// tests/loop/loop-clone-guard.test.mjs
// loop-clone.mjs against a git that misbehaves at a chosen moment: a stand-in git first on PATH
// runs an action (kill the lock holder, swap a storage directory for a symlink) the first time
// its arguments match, then runs the real git. Covered here: delivery publication re-checks the
// lock (R31), rotation never overwrites ignored files (R30) and runs no filter program, a git
// that ignores GIT_ATTR_SOURCE is refused infra (R24), a clone made invalid mid-command is
// refused clone-invalid, and the containment checks of rotation (opts forwarded, vetted first).
// Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  D1, D2, PREFIX, T, appendLedger, attempt, check, cli, closeCli, commitCli, firing, git, headRef, prepare, prepareArgs,
  project, recordGenerations, recordOf, run, tipOf, write,
} from './loop-clone-fixture.mjs'

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const BRANCH = `${PREFIX}/${D2}`
const bundleFile = (fx, branch = BRANCH) => path.join(fx.V, 'out', `${branch}.bundle`)
const outTemps = fx => {
  try { return fs.readdirSync(path.join(fx.V, 'out', PREFIX)).filter(n => n.startsWith('.tmp-')) } catch { return [] }
}

// A stand-in git first on PATH. The first time ' <its arguments> ' matches the sh case pattern,
// it runs action; every call is appended to log when given; then the real git runs.
function standIn(fx, { pattern = null, action = ':', log = null } = {}) {
  const bin = fs.mkdtempSync(path.join(fx.root, 'git-bin-'))
  const once = path.join(bin, 'fired')
  const lines = ['#!/bin/sh']
  if (log) lines.push(`printf '%s\\n' "$*" >> '${log}'`)
  if (pattern) lines.push('case " $* " in', `  ${pattern}) if [ ! -e '${once}' ]; then : > '${once}'; ${action}; fi ;;`, 'esac')
  lines.push(`exec '${REAL_GIT}' "$@"`, '')
  fs.writeFileSync(path.join(bin, 'git'), lines.join('\n'), { mode: 0o755 })
  return { ...fx.env, PATH: `${bin}:${fx.env.PATH}` }
}
// The holder dies (and is reaped) while git runs: the firing lock is lost from then on.
const killHolder = fx => `kill -9 ${fx.holder}; i=0; while kill -0 ${fx.holder} 2>/dev/null && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done`
const AT_VERIFY = '*" bundle verify "*'

test('bundle: a lock lost while the bundle is made publishes nothing; not-holder (R31, Cg3#6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  attempt(fx, W => write(W, 'one.txt', '1\n'))
  fs.rmSync(bundleFile(fx))
  fs.rmSync(`${bundleFile(fx)}.json`)
  const env = standIn(fx, { pattern: AT_VERIFY, action: killHolder(fx) })
  const out = run(env, 3, 'bundle', fx.P, '--generation', String(fx.N), '--branch', BRANCH)
  assert.equal(out.state, 'not-holder')
  assert.equal(fs.existsSync(bundleFile(fx)), false)
  assert.equal(fs.existsSync(`${bundleFile(fx)}.json`), false)
  assert.deepEqual(outTemps(fx), [])
})

test('commit: a lock lost while the commit\'s bundle is made is not-holder, never a bundleError; the commit stands and nothing is published (R31, Cg2#3)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'one.txt', '1\n')
  const c = check(fx, 'dispatch')
  const env = standIn(fx, { pattern: AT_VERIFY, action: killHolder(fx) })
  const out = commitCli(fx, c.digest, { env, status: 3 })
  assert.equal(out.state, 'not-holder')
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'committed')
  assert.equal(tipOf(fx.W, `refs/heads/${BRANCH}`), rec.commit.sha)
  assert.equal(fs.existsSync(bundleFile(fx)), false)
  assert.deepEqual(outTemps(fx), [])
})

test('close: a lock lost while a bundle is refreshed publishes nothing and deletes no record (R31)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  fs.rmSync(bundleFile(fx))
  fs.rmSync(`${bundleFile(fx)}.json`)
  const env = standIn(fx, { pattern: AT_VERIFY, action: killHolder(fx) })
  const out = closeCli(fx, { env, status: 3 })
  assert.equal(out.state, 'not-holder')
  assert.equal(fs.existsSync(bundleFile(fx)), false)
  assert.deepEqual(recordGenerations(fx), [fx.N])
  assert.equal(fs.existsSync(path.join(fx.V, 'run', 'refs.json')), false)
})

test('prepare: a lock lost during the bundle sync publishes nothing and is not-holder, not infra (R31)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  closeCli(fx)
  fs.rmSync(bundleFile(fx))
  fs.rmSync(`${bundleFile(fx)}.json`)
  await firing(fx)
  const env = standIn(fx, { pattern: AT_VERIFY, action: killHolder(fx) })
  const out = run(env, 3, ...prepareArgs(fx))
  assert.equal(out.state, 'not-holder')
  assert.equal(fs.existsSync(bundleFile(fx)), false)
  assert.deepEqual(outTemps(fx), [])
})

test('rotation never overwrites an ignored file the new base tracks: prepare refuses infra naming it and keeps the file (R30, Cg3#4)', T, async t => {
  const fx = project(t, { files: { 'a.txt': 'a\n', '.gitignore': '*.dat\n' } })
  await firing(fx)
  prepare(fx, { date: D1 })
  write(fx.W, 'cache.dat', 'local cache\n') // the dependency step's output: ignored, never saved
  check(fx, 'deps')
  appendLedger(fx, { iteration: fx.N })
  assert.deepEqual(closeCli(fx).closed, [fx.N])
  // The owner's base starts tracking that path.
  write(fx.P, 'cache.dat', 'tracked by the owner\n')
  git(fx.P, ['add', '-f', 'cache.dat'])
  git(fx.P, ['commit', '-q', '-m', 'track cache.dat'])
  await firing(fx)
  const out = prepare(fx, { status: 3, date: D2 })
  assert.equal(out.state, 'infra')
  assert.deepEqual(out.paths, ['cache.dat'])
  assert.match(out.detail, /cache\.dat/)
  assert.equal(fs.readFileSync(path.join(fx.W, 'cache.dat'), 'utf8'), 'local cache\n')
  assert.equal(headRef(fx.W), `refs/heads/${PREFIX}/${D1}`)
})

test('creation and rotation run no filter program and write the raw blob the reset would write (Cg1 finding, R29)', T, async t => {
  const fx = project(t, { files: { 'a.txt': 'a\n', 'f.dat': 'hello\n', '.gitattributes': 'f.dat filter=rw\n' } })
  const marker = path.join(fx.root, 'smudge-ran')
  const smudge = path.join(fx.root, 'smudge.sh')
  fs.writeFileSync(smudge, `#!/bin/sh\n: > '${marker}'\nsed 's/^/SMUDGED /'\n`, { mode: 0o755 })
  const gcfg = path.join(fx.root, 'gitconfig')
  fs.writeFileSync(gcfg, `[filter "rw"]\n\tsmudge = ${smudge}\n\tclean = sed 's/^SMUDGED //'\n`)
  const env = { ...fx.env, GIT_CONFIG_GLOBAL: gcfg }
  await firing(fx)
  prepare(fx, { env, date: D1 })
  assert.equal(fs.readFileSync(path.join(fx.W, 'f.dat'), 'utf8'), 'hello\n')
  assert.equal(fs.existsSync(marker), false, 'creation ran the smudge filter')
  appendLedger(fx, { iteration: fx.N })
  assert.deepEqual(closeCli(fx, { env }).closed, [fx.N])
  write(fx.P, 'f.dat', 'hello again\n')
  git(fx.P, ['commit', '-q', '-am', 'f.dat again'])
  await firing(fx)
  const out = prepare(fx, { env, date: D2 })
  assert.equal(out.rotated, true)
  assert.equal(fs.readFileSync(path.join(fx.W, 'f.dat'), 'utf8'), 'hello again\n')
  assert.equal(fs.existsSync(marker), false, 'rotation ran the smudge filter')
})

test('on a git that ignores GIT_ATTR_SOURCE, prepare refuses infra git-too-old, never save-failed (R24)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'left behind\n')
  await firing(fx)
  const bin = fs.mkdtempSync(path.join(fx.root, 'oldgit-'))
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nunset GIT_ATTR_SOURCE\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 })
  const out = prepare(fx, { status: 3, env: { ...fx.env, PATH: `${bin}:${fx.env.PATH}` } })
  assert.equal(out.state, 'infra')
  assert.equal(out.detail, 'git-too-old: needs git 2.40 or newer')
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'left behind\n')
})

test('a clone made invalid between the helper\'s check and a later git call is refused clone-invalid, never a bare error (Cg1 finding)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  attempt(fx, W => write(W, 'one.txt', '1\n'))
  const swap = 'mv "$GIT_DIR/objects/info" "$GIT_DIR/objects/info.real" && ln -s info.real "$GIT_DIR/objects/info"'
  const undo = () => {
    fs.unlinkSync(path.join(fx.W, '.git', 'objects', 'info'))
    fs.renameSync(path.join(fx.W, '.git', 'objects', 'info.real'), path.join(fx.W, '.git', 'objects', 'info'))
  }
  // bundle: the swap lands while deliverable lists the retired tips; the next git call refuses.
  const env = standIn(fx, { pattern: '*" refs/tech-lead/retired/ "*', action: swap })
  const out = run(env, 3, 'bundle', fx.P, '--generation', String(fx.N), '--branch', BRANCH)
  assert.equal(out.state, 'clone-invalid')
  assert.match(out.detail, /objects\/info is a symlink/)
  undo()
  // The passthrough: the swap lands on checkClone's last read; git itself is then refused.
  const env2 = standIn(fx, { pattern: '*" symbolic-ref -q HEAD "*', action: swap })
  const r = cli(env2, 'git', fx.P, '--', 'rev-parse', 'HEAD')
  assert.equal(r.status, 2)
  const last = JSON.parse(r.stderr.trim().split('\n').pop().slice('loop-clone git: '.length))
  assert.equal(last.state, 'refused')
  assert.match(last.detail, /^clone-invalid: .*objects\/info is a symlink/)
  undo()
})

test('rotation\'s containment checks read attributes from the empty tree: a squash-merged branch whose attributes select a merge driver is not chained on (B finding)', T, async t => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
  const fx = project(t, { files: { 'a.txt': 'a\n', 'f.txt': lines.join('\n') + '\n' } })
  await firing(fx)
  prepare(fx, { date: D1 })
  attempt(fx, W => {
    write(W, '.gitattributes', 'f.txt merge=keep\n')
    write(W, 'f.txt', lines.map((l, i) => (i === 1 ? 'line two, changed by the loop' : l)).join('\n') + '\n')
  })
  const day1 = recordOf(fx)
  appendLedger(fx, { iteration: fx.N, commits: [day1.commit.sha] })
  closeCli(fx)
  // The owner squash-merges day 1, then edits another line of f.txt.
  const b1 = bundleFile(fx, `${PREFIX}/${D1}`)
  git(fx.P, ['fetch', '-q', b1, `refs/heads/${PREFIX}/${D1}:refs/remotes/tech-lead/${PREFIX}/${D1}`])
  git(fx.P, ['merge', '-q', '--squash', `refs/remotes/tech-lead/${PREFIX}/${D1}`])
  git(fx.P, ['commit', '-q', '-m', 'squash day 1'])
  const txt = fs.readFileSync(path.join(fx.P, 'f.txt'), 'utf8').replace('line 11', 'line eleven, by the owner')
  write(fx.P, 'f.txt', txt)
  git(fx.P, ['commit', '-q', '-am', 'owner edit'])
  // A merge driver named by the branch's attributes is configured (containedIn empties it).
  const gcfg = path.join(fx.root, 'gitconfig')
  fs.writeFileSync(gcfg, '[merge "keep"]\n\tdriver = true\n')
  await firing(fx)
  const day2 = prepare(fx, { date: D2, env: { ...fx.env, GIT_CONFIG_GLOBAL: gcfg } })
  assert.equal(day2.chainedFrom, null, 'the base contains day 1')
  assert.equal(day2.head, tipOf(fx.P, 'main'))
})

test('rotation asks vetted before any content check of today\'s tip (B finding)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  closeCli(fx)
  await firing(fx)
  const log = path.join(fx.root, 'git.log')
  const out = prepare(fx, { env: standIn(fx, { log }) })
  assert.equal(out.head, a.commit.sha)
  const merges = fs.readFileSync(log, 'utf8').split('\n').filter(l => / merge-tree /.test(l) && l.includes(a.commit.sha))
  assert.equal(merges.length, 1, `only the bundle sync merges today's vetted tip: ${merges.join(' | ')}`)
})

test('a merge driver the containment check cannot empty makes prepare refuse infra, not a bare error (B containedIn UNSAFE_CONFIG)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  closeCli(fx)
  const gcfg = path.join(fx.root, 'gitconfig')
  fs.writeFileSync(gcfg, '[merge "a=b"]\n\tdriver = true\n')
  await firing(fx)
  const out = prepare(fx, { status: 3, date: D2, env: { ...fx.env, GIT_CONFIG_GLOBAL: gcfg } })
  assert.equal(out.state, 'infra')
  assert.match(out.detail, /unsafe-config: merge driver "a=b"/)
})

// The delegate commits D over the base; E, on top of D, is where a racing writer moves the branch.
function delegateCommits(fx) {
  write(fx.W, 'one.txt', '1\n')
  git(fx.W, ['add', 'one.txt'])
  git(fx.W, ['commit', '-q', '-m', 'D'])
  const D = tipOf(fx.W)
  const E = git(fx.W, ['commit-tree', `${D}^{tree}`, '-p', D, '-m', 'E'])
  return { D, E }
}
const moveBranchFirst = (fx, E) => standIn(fx, { pattern: `*" update-ref refs/heads/${BRANCH} "*`, action: `'${REAL_GIT}' update-ref refs/heads/${BRANCH} ${E}` })

test('both rewinds of a delegate commit are compare-and-swap: a branch moved meanwhile is refused and left where it is (contracts-tests#5)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  const { E } = delegateCommits(fx)
  const out = check(fx, 'dispatch', { status: 3, env: moveBranchFirst(fx, E) })
  assert.equal(out.state, 'tampered')
  assert.match(out.detail, /rewind/)
  assert.equal(tipOf(fx.W, `refs/heads/${BRANCH}`), E)

  // prepare's rewind (Recovery.rewind) of the same kind of commit.
  const fy = project(t)
  await firing(fy)
  prepare(fy)
  check(fy, 'deps')
  const { E: E2 } = delegateCommits(fy)
  await firing(fy)
  const p = prepare(fy, { status: 3, env: moveBranchFirst(fy, E2) })
  assert.equal(p.state, 'infra')
  assert.match(p.detail, /rewind of refs\/heads\//)
  assert.equal(tipOf(fy.W, `refs/heads/${BRANCH}`), E2)
})

// --- fix round 2: a guard sits right before the write it protects, with no git call between
// them; every git-derived value is computed first (code#2, R31 sharpened) ---

test('prepare: a lock lost while step 6 reads the clone\'s refs writes no prepared record; not-holder (code#2, R31)', T, async t => {
  const fx = project(t)
  await firing(fx)
  // refsSnapshot's listing: the first for-each-ref of every ref with no pattern after it.
  const env = standIn(fx, { pattern: '*" for-each-ref --format=%(objectname) %(refname) "', action: killHolder(fx) })
  const out = run(env, 3, ...prepareArgs(fx))
  assert.equal(out.state, 'not-holder', JSON.stringify(out))
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'preparing', 'the record is not written prepared after the lock was lost')
  assert.equal(rec.head_ref, null)
  assert.deepEqual(rec.refs, {})
})

test('prepare: a lock lost while it reads HEAD for its new record writes no record (code#2, R31)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  appendLedger(fx, { iteration: fx.N })
  assert.deepEqual(closeCli(fx).closed, [fx.N])
  await firing(fx)
  const env = standIn(fx, { pattern: '*" rev-parse --verify -q --end-of-options HEAD^{commit} "*', action: killHolder(fx) })
  const out = run(env, 3, ...prepareArgs(fx))
  assert.equal(out.state, 'not-holder', JSON.stringify(out))
  assert.equal(recordOf(fx), null, 'no record of the generation whose lock was lost')
})

test('rotation: a lock lost while the switch\'s filter overrides are read runs no switch (R31)', T, async t => {
  const fx = project(t)
  await firing(fx)
  const log = path.join(fx.root, 'git.log')
  const env = standIn(fx, { pattern: '*" config -z --name-only --get-regexp ^filter[.] "*', action: killHolder(fx), log })
  const out = run(env, 3, ...prepareArgs(fx))
  assert.equal(out.state, 'not-holder', JSON.stringify(out))
  const lines = fs.readFileSync(log, 'utf8').split('\n')
  const at = lines.findIndex(l => l.includes(' config -z --name-only --get-regexp ^filter[.]'))
  assert.ok(at >= 0, 'the switch read its filter overrides')
  const after = lines.slice(at + 1).filter(l => / switch /.test(l))
  assert.deepEqual(after, [], 'no switch ran once the lock was lost')
  assert.equal(fs.existsSync(fx.W), false)
})
