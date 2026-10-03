// tests/loop/loop-start.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { safeGit } from '../../scripts/lib/git-safe.mjs'
import { branchRef, chainStart, containedIn, resolveBase, retiredRefs, startPoint, validPrefix } from '../../scripts/loop-start.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-start.mjs')
// Keep the user's git config and hooks out of the fixture repositories; the script
// under test and its CLI child inherit this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// A commit that changes a file, so the branch carries real content.
const commit = (repo, name) => {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', name)
}

// A repository with one commit on main, removed when the test ends.
const repo = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-start-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '-q', '-b', 'main')
  commit(dir, 'base')
  return dir
}

test('starts from the base, whatever <P> has checked out', t => {
  const r = repo(t)
  git(r, 'switch', '-q', '-c', 'wip/spike')
  commit(r, 'half-finished')
  assert.deepEqual(startPoint(r, 'tech-lead-loop', 'main'), { base: 'main', startPoint: 'refs/heads/main', chainedFrom: null })
  git(r, 'switch', '-q', '--detach', 'HEAD')
  assert.equal(startPoint(r, 'tech-lead-loop', 'main').startPoint, 'refs/heads/main')
})

test('chains from the newest unmerged dated loop branch; merged, undated and other-prefix branches do not count', t => {
  const r = repo(t)
  for (const d of ['2026-09-27', '2026-09-28', '2026-09-29']) {
    git(r, 'switch', '-q', '-c', `tech-lead-loop/${d}`, 'main')
    commit(r, d)
  }
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--ff-only', 'tech-lead-loop/2026-09-27')
  git(r, 'branch', 'tech-lead-loop/notes', 'tech-lead-loop/2026-09-28')
  git(r, 'branch', 'tech-lead-loop-old/2026-09-30', 'tech-lead-loop/2026-09-28')
  assert.deepEqual(startPoint(r, 'tech-lead-loop', 'main'),
    { base: 'main', startPoint: 'refs/heads/tech-lead-loop/2026-09-29', chainedFrom: 'tech-lead-loop/2026-09-29' })
  git(r, 'merge', '-q', '--no-edit', 'tech-lead-loop/2026-09-29')
  assert.equal(startPoint(r, 'tech-lead-loop', 'main').startPoint, 'refs/heads/tech-lead-loop/2026-09-28')
})

test('a loop branch the base already contains, such as a squash merge, is not chained', t => {
  const r = repo(t)
  git(r, 'switch', '-q', '-c', 'tech-lead-loop/2026-09-29', 'main')
  commit(r, 'loop-a')
  commit(r, 'loop-b')
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--squash', 'tech-lead-loop/2026-09-29')
  git(r, 'commit', '-q', '-m', 'squash')
  assert.deepEqual(startPoint(r, 'tech-lead-loop', 'main'), { base: 'main', startPoint: 'refs/heads/main', chainedFrom: null })
})

test('without a base it uses the remote default branch, and names base: when there is none', t => {
  const r = repo(t)
  assert.throws(() => startPoint(r, 'tech-lead-loop'), /set `base:` in LOOP\.md/)
  git(r, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  assert.equal(startPoint(r, 'tech-lead-loop').base, 'main')
  git(r, 'switch', '-q', '-c', 'work')
  git(r, 'branch', '-D', 'main')
  assert.equal(startPoint(r, 'tech-lead-loop').startPoint, 'refs/remotes/origin/main')
})

test('a base that is missing, a pseudo-ref, a tag, or looks like an option is refused', t => {
  const r = repo(t)
  git(r, 'tag', 'v1')
  assert.throws(() => startPoint(r, 'tech-lead-loop', 'develop'), /is not a branch/)
  assert.throws(() => startPoint(r, 'tech-lead-loop', 'v1'), /is not a branch/)
  for (const b of ['HEAD', 'ORIG_HEAD', 'FETCH_HEAD']) assert.throws(() => startPoint(r, 'tech-lead-loop', b), /not a plain branch name/, b)
  assert.throws(() => startPoint(r, 'tech-lead-loop', '--output=/tmp/x'), /not a plain branch name/)
  assert.throws(() => startPoint(r, '-x', 'main'), /not a plain branch name/)
})

test('CLI prints one JSON line; an unusable base or bad usage exits 2', t => {
  const r = repo(t)
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const ok = run(r, 'tech-lead-loop', 'main')
  assert.equal(ok.status, 0)
  assert.deepEqual(JSON.parse(ok.stdout), { base: 'main', startPoint: 'refs/heads/main', chainedFrom: null })
  const bad = run(r, 'tech-lead-loop', 'develop')
  assert.equal(bad.status, 2)
  assert.match(JSON.parse(bad.stdout).error, /is not a branch/)
  assert.equal(run().status, 2)
})

// --- stage 0c-2: validPrefix, resolveBase, chainStart (brief section 12) ---

const P = 'tech-lead-loop'
// The injected git runner chainStart takes: args in, stdout out, throws on a non-zero exit.
const runner = r => args => safeGit(r, args)
// startPoint rebuilt from its two halves.
const rebuilt = (r, prefix, base, opts) => {
  const { base: b, baseRef } = resolveBase(r, base)
  return { base: b, ...chainStart(runner(r), prefix, baseRef, opts) }
}
const tipOf = (r, ref) => git(r, 'rev-parse', ref)
// Dated branches chained one on another from `from`: D1 <- D2 <- ... (each one commit).
const chain = (r, dates, from = 'main') => {
  let prev = from
  for (const d of dates) {
    git(r, 'switch', '-q', '-c', `${P}/${d}`, prev)
    commit(r, d)
    prev = `${P}/${d}`
  }
  git(r, 'switch', '-q', 'main')
}

test('validPrefix accepts plain segments and refuses .., .lock, a leading - and empty segments', () => {
  for (const ok of ['tech-lead-loop', 'a', 'A9', 'team.x/loop_1', 'a/b/c', 'x.locked', 'lock', 'a.b'])
    assert.equal(validPrefix(ok), true, ok)
  for (const bad of ['', '..', '.', 'a/..', '../a', 'a/./b', 'a..b', 'a/b..', 'foo.lock', 'a/foo.lock', 'x.lock/b',
    '-x', 'a/-x', '-', 'a//b', '/a', 'a/', '/', '.hidden', 'a/.b', '_a', 'a b', 'a~b', 'a:b', 'a^b', 'a@{1}', 'a*', 'a\\b',
    undefined, null, 42, ['a']])
    assert.equal(validPrefix(bad), false, JSON.stringify(bad))
})

test('startPoint and chainStart refuse a prefix validPrefix refuses', t => {
  const r = repo(t)
  for (const bad of ['loop.lock', 'a//b', 'a/', '..', '-x'])
    assert.throws(() => startPoint(r, bad, 'main'), /not a plain branch name/, bad)
  assert.throws(() => chainStart(runner(r), 'a/../b', 'refs/heads/main'), /not a plain branch name/)
})

test('branchRef and resolveBase: local branch first, then the remote; the remote default without a base', t => {
  const r = repo(t)
  assert.equal(branchRef(r, 'main'), 'refs/heads/main')
  assert.equal(branchRef(r, 'develop'), null)
  assert.deepEqual(resolveBase(r, 'main'), { base: 'main', baseRef: 'refs/heads/main' })
  git(r, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(r, 'update-ref', 'refs/remotes/origin/trunk', 'main')
  assert.equal(branchRef(r, 'trunk'), 'refs/remotes/origin/trunk')
  assert.deepEqual(resolveBase(r, 'trunk'), { base: 'trunk', baseRef: 'refs/remotes/origin/trunk' })
  git(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  assert.deepEqual(resolveBase(r), { base: 'main', baseRef: 'refs/heads/main' })
  git(r, 'switch', '-q', '-c', 'work')
  git(r, 'branch', '-D', 'main')
  assert.deepEqual(resolveBase(r), { base: 'main', baseRef: 'refs/remotes/origin/main' })
})

test('resolveBase refuses as startPoint does, with code NO_BASE', t => {
  const r = repo(t)
  git(r, 'tag', 'v1')
  const refuses = (base, re) => assert.throws(() => resolveBase(r, base), e => re.test(e.message) && e.code === 'NO_BASE', String(base))
  refuses(undefined, /set `base:` in LOOP\.md/)
  refuses('develop', /is not a branch/)
  refuses('v1', /is not a branch/)
  for (const b of ['HEAD', 'ORIG_HEAD', 'FETCH_HEAD', '@', '--output=/tmp/x']) refuses(b, /not a plain branch name/)
})

test('resolveBase + chainStart reproduce startPoint: merged, undated and other-prefix branches', t => {
  const r = repo(t)
  const same = label => {
    const want = startPoint(r, P, 'main')
    assert.deepEqual(rebuilt(r, P, 'main'), want, label)
    return want
  }
  assert.equal(same('no loop branches').startPoint, 'refs/heads/main')
  chain(r, ['2026-09-27'])
  for (const d of ['2026-09-28', '2026-09-29']) {
    git(r, 'switch', '-q', '-c', `${P}/${d}`, 'main')
    commit(r, d)
  }
  git(r, 'switch', '-q', 'main')
  assert.equal(same('three unmerged').chainedFrom, `${P}/2026-09-29`)
  git(r, 'merge', '-q', '--ff-only', `${P}/2026-09-27`)
  git(r, 'branch', `${P}/notes`, `${P}/2026-09-28`)
  git(r, 'branch', `${P}/2026-09-30-x`, `${P}/2026-09-28`)
  git(r, 'branch', `${P}-old/2026-09-30`, `${P}/2026-09-28`)
  git(r, 'branch', `${P}/sub/2026-09-30`, `${P}/2026-09-28`)
  assert.equal(same('merged, undated, other prefix').chainedFrom, `${P}/2026-09-29`)
  git(r, 'merge', '-q', '--no-edit', `${P}/2026-09-29`)
  assert.equal(same('after a merge').chainedFrom, `${P}/2026-09-28`)
  git(r, 'merge', '-q', '--no-edit', `${P}/2026-09-28`)
  assert.deepEqual(same('all merged'), { base: 'main', startPoint: 'refs/heads/main', chainedFrom: null })
})

test('resolveBase + chainStart reproduce startPoint: squash-merged branches and a remote base', t => {
  const r = repo(t)
  chain(r, ['2026-09-28'])
  git(r, 'switch', '-q', '-c', `${P}/2026-09-29`, 'main')
  commit(r, 'loop-a')
  commit(r, 'loop-b')
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--squash', `${P}/2026-09-29`)
  git(r, 'commit', '-q', '-m', 'squash')
  const want = startPoint(r, P, 'main')
  assert.equal(want.chainedFrom, `${P}/2026-09-28`)
  assert.deepEqual(rebuilt(r, P, 'main'), want)
  git(r, 'update-ref', 'refs/remotes/origin/main', 'main')
  git(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git(r, 'switch', '-q', '--detach', 'main')
  git(r, 'branch', '-D', 'main')
  const remote = startPoint(r, P)
  assert.equal(remote.chainedFrom, `${P}/2026-09-28`)
  assert.deepEqual(rebuilt(r, P), remote)
})

test('chainStart: a branch comparable with a retired tip is skipped; D1 <- D2 <- D3 with D2 retired starts day 4 at the base', t => {
  const r = repo(t)
  chain(r, ['2026-09-27', '2026-09-28', '2026-09-29'])
  const [d1, d2, d3] = ['2026-09-27', '2026-09-28', '2026-09-29'].map(d => tipOf(r, `${P}/${d}`))
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main'),
    { startPoint: `refs/heads/${P}/2026-09-29`, chainedFrom: `${P}/2026-09-29` })
  // D1 is an ancestor of the retired tip, D3 descends from it, D2 equals it.
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main', { retired: [d2] }),
    { startPoint: 'refs/heads/main', chainedFrom: null })
  // Either direction, and a retired ref name works as well as a sha.
  for (const tip of [d1, d3]) assert.equal(chainStart(runner(r), P, 'refs/heads/main', { retired: [tip] }).chainedFrom, null)
  git(r, 'update-ref', `refs/tech-lead/retired/${P}/2026-09-28`, d2)
  assert.equal(chainStart(runner(r), P, 'refs/heads/main', { retired: [`refs/tech-lead/retired/${P}/2026-09-28`] }).chainedFrom, null)
  // An older dated branch not comparable with the retired tip still chains.
  git(r, 'switch', '-q', '-c', `${P}/2026-09-26`, 'main')
  commit(r, 'side')
  git(r, 'switch', '-q', 'main')
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main', { retired: [d2] }),
    { startPoint: `refs/heads/${P}/2026-09-26`, chainedFrom: `${P}/2026-09-26` })
  // startPoint itself knows nothing of retirement.
  assert.equal(startPoint(r, P, 'main').chainedFrom, `${P}/2026-09-29`)
})

test('chainStart: a retired tip the base already contains is ignored (merge and squash merge)', t => {
  const r = repo(t)
  chain(r, ['2026-09-28', '2026-09-29'])
  const d1 = tipOf(r, `${P}/2026-09-28`)
  // Not yet in the base: both branches are comparable with it.
  assert.equal(chainStart(runner(r), P, 'refs/heads/main', { retired: [d1] }).chainedFrom, null)
  git(r, 'branch', 'squashed', 'main')
  git(r, 'merge', '-q', '--ff-only', `${P}/2026-09-28`)
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main', { retired: [d1] }),
    { startPoint: `refs/heads/${P}/2026-09-29`, chainedFrom: `${P}/2026-09-29` })
  git(r, 'switch', '-q', 'squashed')
  git(r, 'merge', '-q', '--squash', `${P}/2026-09-28`)
  git(r, 'commit', '-q', '-m', 'squash d1')
  git(r, 'switch', '-q', 'main')
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/squashed', { retired: [d1] }),
    { startPoint: `refs/heads/${P}/2026-09-29`, chainedFrom: `${P}/2026-09-29` })
})

test('chainStart: a vetted predicate that rejects the newest branch falls back to the next', t => {
  const r = repo(t)
  for (const d of ['2026-09-27', '2026-09-28', '2026-09-29']) {
    git(r, 'switch', '-q', '-c', `${P}/${d}`, 'main')
    commit(r, d)
  }
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--ff-only', `${P}/2026-09-27`)
  const seen = []
  const newest = `${P}/2026-09-29`
  const vetted = c => { seen.push(c); return c.branch !== newest }
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main', { vetted }),
    { startPoint: `refs/heads/${P}/2026-09-28`, chainedFrom: `${P}/2026-09-28` })
  assert.deepEqual(seen[0], { branch: newest, ref: `refs/heads/${newest}`, tip: tipOf(r, newest) })
  // A branch the base contains is skipped before the predicate is asked.
  assert.ok(!seen.some(c => c.branch === `${P}/2026-09-27`))
  assert.deepEqual(chainStart(runner(r), P, 'refs/heads/main', { vetted: () => false }),
    { startPoint: 'refs/heads/main', chainedFrom: null })
})

test('chainStart runs git only through the injected runner and refuses option-like inputs', t => {
  const r = repo(t)
  chain(r, ['2026-09-29'])
  const calls = []
  const rec = args => { calls.push(args); return safeGit(r, args) }
  assert.equal(chainStart(rec, P, 'refs/heads/main', { retired: [tipOf(r, 'main')] }).chainedFrom, `${P}/2026-09-29`)
  assert.ok(calls.length > 0 && calls.every(a => Array.isArray(a) && !a.includes(r)))
  assert.throws(() => chainStart(runner(r), P, '--output=/tmp/x'), /not a plain ref/)
  assert.throws(() => chainStart(runner(r), P, 'HEAD'), /not a plain ref/)
  assert.throws(() => chainStart(runner(r), P, 'refs/heads/main', { retired: ['--all'] }), /retired/)
  assert.throws(() => chainStart(runner(r), P, 'refs/heads/main', { retired: 'abc' }), /retired/)
  // A retired tip git cannot resolve is an error, never silently ignored.
  assert.throws(() => chainStart(runner(r), P, 'refs/heads/main', { retired: ['0123456789abcdef0123456789abcdef01234567'] }))
  // A git run that did not finish (a timeout) is an error, never "not contained".
  const timeout = args => {
    if (args.includes('merge-tree')) { const e = new Error('git merge-tree timed out'); e.code = 'TIMEOUT'; throw e }
    return safeGit(r, args)
  }
  assert.throws(() => chainStart(timeout, P, 'refs/heads/main'), /timed out/)
})

// --- review round: containment runs nothing from the branch (Cg2#2, Cg3#3) ---

const markerDir = t => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-start-m-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
// A shell command that records that git ran it, then behaves as `then` says.
const evil = (m, then) => `touch '${m}'; ${then}`
// main and the dated branch both change f.txt (lines far apart, so a text merge is clean);
// the branch also adds `attributes` as its .gitattributes, and main changes g.txt. The work
// tree is left on the branch, as <W>'s is during a firing.
const hostile = (t, attributes) => {
  const r = repo(t)
  fs.writeFileSync(path.join(r, 'f.txt'), 'a\nb\nc\nd\ne\n')
  fs.writeFileSync(path.join(r, 'g.txt'), 'g\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'f and g')
  const branch = `${P}/2026-09-29`
  git(r, 'switch', '-q', '-c', branch)
  if (attributes !== null) fs.writeFileSync(path.join(r, '.gitattributes'), attributes)
  fs.writeFileSync(path.join(r, 'f.txt'), 'A\nb\nc\nd\ne\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'branch work')
  git(r, 'switch', '-q', 'main')
  fs.writeFileSync(path.join(r, 'f.txt'), 'a\nb\nc\nd\nE\n')
  fs.writeFileSync(path.join(r, 'g.txt'), 'g2\n')
  git(r, 'commit', '-q', '-a', '-m', 'base moves on')
  git(r, 'switch', '-q', branch)
  return { r, branch, ref: `refs/heads/${branch}`, m: path.join(markerDir(t), 'ran') }
}

test('containedIn runs no merge driver and no clean filter, whatever the attributes or the config select', t => {
  const cases = [
    ['an attribute in the branch selects a configured driver', 'f.txt merge=evil\n', m => [['merge.evil.driver', evil(m, 'exit 0')]]],
    ['merge.default names a configured driver', null, m => [['merge.default', 'evil'], ['merge.evil.driver', evil(m, 'exit 0')]]],
    ['a driver selected for the inner merge (recursive)', 'f.txt merge=outer\n', m => [
      ['merge.outer.driver', evil(m, 'exit 0')], ['merge.outer.recursive', 'evil'], ['merge.evil.driver', evil(m, 'exit 0')]]],
    ['merge.renormalize runs the clean filter the branch selects', '* filter=evil\n', m => [
      ['merge.renormalize', 'true'], ['filter.evil.clean', evil(m, 'cat')], ['filter.evil.smudge', evil(m, 'cat')]]],
  ]
  for (const [label, attributes, config] of cases) {
    const { r, ref, m } = hostile(t, attributes)
    for (const [k, v] of config(m)) git(r, 'config', k, v)
    // Control: plain git runs the program.
    spawnSync('git', ['-C', r, 'merge-tree', '--write-tree', 'refs/heads/main', ref], { encoding: 'utf8' })
    assert.equal(fs.existsSync(m), true, `${label}: control, plain merge-tree runs it`)
    fs.rmSync(m)
    for (const run of [runner(r), (args, opts) => safeGit(r, args, opts)]) {
      assert.equal(containedIn(run, 'refs/heads/main', ref), false, label)
      assert.equal(fs.existsSync(m), false, `${label}: containedIn ran it`)
    }
    // chainStart and retiredRefs reach the same check.
    assert.equal(chainStart(runner(r), P, 'refs/heads/main').chainedFrom, `${P}/2026-09-29`, label)
    assert.equal(retiredRefs(runner(r), P, 'refs/heads/main', [ref]).has(ref), true, label)
    assert.equal(fs.existsSync(m), false, `${label}: chainStart or retiredRefs ran it`)
  }
})

test('containedIn: the merge reads attributes from the empty tree with renormalization off and every driver emptied', t => {
  const { r, ref } = hostile(t, 'f.txt merge=evil\n')
  git(r, 'config', 'merge.evil.driver', 'false')
  git(r, 'config', 'merge.Other Name.driver', 'false')
  const calls = []
  const rec = (args, opts) => { calls.push({ args, opts }); return safeGit(r, args, opts) }
  assert.equal(containedIn(rec, 'refs/heads/main', ref), false)
  const merge = calls.find(c => c.args.includes('merge-tree'))
  assert.ok(merge, JSON.stringify(calls))
  const at = merge.args.indexOf('merge-tree')
  const config = merge.args.slice(0, at)
  for (const kv of ['core.attributesFile=/dev/null', 'merge.renormalize=false', 'merge.evil.driver=false', 'merge.Other Name.driver=false']) {
    assert.ok(config.some((a, i) => a === kv && config[i - 1] === '-c'), `${kv} in ${JSON.stringify(config)}`)
  }
  assert.deepEqual(merge.args.slice(at), ['merge-tree', '--write-tree', 'refs/heads/main', ref])
  assert.equal(merge.opts.env.GIT_ATTR_SOURCE, git(r, 'hash-object', '-t', 'tree', '/dev/null'))
  assert.equal(merge.opts.env.GIT_ATTR_NOSYSTEM, '1')
  // A squash merge still reads as contained through a runner that takes the options.
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--squash', ref)
  git(r, 'commit', '-q', '-m', 'squash')
  assert.equal(containedIn(rec, 'refs/heads/main', ref), true)
  // A runner that drops opts lets git read the work tree's .gitattributes (the squash brought
  // `f.txt merge=evil` in): the emptied driver conflicts, so the answer errs toward work the
  // base lacks, and still nothing runs.
  assert.equal(containedIn(runner(r), 'refs/heads/main', ref), false)
})

test('containedIn refuses a merge driver it cannot empty, and never runs the merge', t => {
  const { r, ref, m } = hostile(t, 'f.txt merge=x\n')
  git(r, 'config', 'merge.x=y.driver', evil(m, 'exit 0'))
  const calls = []
  const rec = args => { calls.push(args); return safeGit(r, args) }
  assert.throws(() => containedIn(rec, 'refs/heads/main', ref), e => e.code === 'UNSAFE_CONFIG' && /merge driver/.test(e.message))
  assert.ok(!calls.some(a => a.includes('merge-tree')), JSON.stringify(calls))
  assert.equal(fs.existsSync(m), false)
})

test('chainStart asks vetted before it runs any content check on a branch', t => {
  const r = repo(t)
  chain(r, ['2026-09-28'])
  git(r, 'switch', '-q', '-c', `${P}/2026-09-29`, 'main')
  commit(r, 'squashed-work')
  git(r, 'switch', '-q', 'main')
  git(r, 'merge', '-q', '--squash', `${P}/2026-09-29`)
  git(r, 'commit', '-q', '-m', 'squash')
  const calls = []
  const rec = (args, opts) => { calls.push(args); return safeGit(r, args, opts) }
  const seen = []
  const vetted = c => { seen.push(c.branch); return c.branch !== `${P}/2026-09-29` }
  assert.deepEqual(chainStart(rec, P, 'refs/heads/main', { vetted }), { startPoint: `refs/heads/${P}/2026-09-28`, chainedFrom: `${P}/2026-09-28` })
  assert.deepEqual(seen, [`${P}/2026-09-29`, `${P}/2026-09-28`])
  assert.ok(!calls.some(a => a.includes('merge-tree') && a.includes(`refs/heads/${P}/2026-09-29`)), 'no merge of the unvetted branch')
})
