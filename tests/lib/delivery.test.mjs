// tests/lib/delivery.test.mjs
// Delivery bundles (brief 13.7, R11, 17): <V>/out/<prefix>/<date>.bundle with its sidecar
// <date>.bundle.json, written from the clone <W> against refs/tech-lead/base. Real temporary
// repositories and real processes; the clone is made the way loop-clone makes it (brief 13.4).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../helpers.mjs'
import { cloneRepo, workGit } from '../../scripts/lib/git-safe.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { DATED_BRANCH_RE, checkClone } from '../../scripts/lib/clone-check.mjs'
import { sweepTemps } from '../../scripts/lib/atomic.mjs'
import { isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'
import { acquire, assertHeld, release } from '../../scripts/loop-lock.mjs'
import {
  bundleCurrent, bundleHeader, bundlePath, readSidecar, sidecarPath, syncBundles, writeBundle,
} from '../../scripts/lib/delivery.mjs'

// Keep the user's git config, hooks and any real Codex companion out of the fixtures; workGit
// and the child processes copy this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
delete process.env.TECH_LEAD_FAULT

const PROC = { timeout: 90000 }
const DELIVERY = path.join(ROOT, 'scripts', 'lib', 'delivery.mjs')
const LOOP_PATHS = path.join(ROOT, 'scripts', 'lib', 'loop-paths.mjs')
const PREFIX = 'tl/loop'
const DAY1 = `${PREFIX}/2026-10-01`
const TODAY = `${PREFIX}/2026-10-02`
const PREV_RE = /^2026-10-02\.bundle\.prev-\d{8}T\d{6}Z(?:-\d+)?$/
const TEMP_RE = /^\.tmp-\d+-[0-9a-f]{16}\.bundle$/

// Plain git, the delegate's (and the owner's) view.
const git = (repo, ...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitRun = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: process.env })

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A process standing in for the holder, started through a shell that exits at once so the
// test runner is not its parent. The cleanup kills it only while its start token is still the
// one read here, so a pid the kernel has since handed to another process is never signalled.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const commit = (repo, name, text, msg = name) => {
  write(path.join(repo, name), text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', msg)
  return git(repo, 'rev-parse', 'HEAD')
}

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// The refresh of brief 13.5: <P>'s branches, tags and retired refs, and its base as
// refs/tech-lead/base.
const refresh = paths =>
  workGit(paths.W, ['fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules', '--no-write-fetch-head', paths.R,
    '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*',
    '+refs/tech-lead/retired/*:refs/tech-lead/retired/*', '+refs/heads/main:refs/tech-lead/base'])

// <P> (main with two commits) and its clone <W> at loopPaths(P).W made as brief 13.4 makes it:
// cloneRepo with an empty template into a 0700 directory, remote.origin and every branch.*
// section removed, refs/remotes/origin/HEAD deleted, the refresh, today's dated branch from the
// base, the non-dated refs/heads/* deleted.
const fixture = t => {
  const root = tmp(t, 'tl-delivery-')
  const cache = path.join(root, 'cache')
  const env = { ...process.env, TECH_LEAD_CACHE: cache, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const P = path.join(root, 'P')
  fs.mkdirSync(P)
  git(P, 'init', '-q', '-b', 'main')
  const B0 = commit(P, 'a.txt', 'a\n')
  const B1 = commit(P, 'b.txt', 'b\n')
  const paths = loopPaths(P, { env })
  const template = path.join(paths.V, 'run', 'empty-template')
  fs.mkdirSync(template, { recursive: true, mode: 0o700 })
  fs.mkdirSync(paths.W, { mode: 0o700 })
  cloneRepo(paths.R, paths.W, { templateDir: template })
  const W = paths.W
  workGit(W, ['config', '--remove-section', 'remote.origin'])
  const keys = workGit(W, ['config', '--file', path.join(W, '.git', 'config'), '--name-only', '--list']).split('\n')
  for (const s of new Set(keys.filter(k => k.startsWith('branch.')).map(k => k.slice(0, k.lastIndexOf('.'))))) {
    workGit(W, ['config', '--remove-section', s])
  }
  workGit(W, ['update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD'])
  refresh(paths)
  workGit(W, ['switch', '-q', '--no-track', '-c', TODAY, 'refs/tech-lead/base'])
  for (const ref of workGit(W, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean)) {
    if (!DATED_BRANCH_RE.test(ref)) workGit(W, ['update-ref', '-d', ref])
  }
  assert.deepEqual(checkClone(W), { problems: [] })
  return { root, env, P, W, paths, B0, B1 }
}

// A copy of <P> as the owner has it, to verify and fetch a bundle in.
const copyOf = (t, P) => {
  const dest = path.join(tmp(t, 'tl-delivery-copy-'), 'P')
  fs.cpSync(P, dest, { recursive: true, verbatimSymlinks: true })
  return dest
}

const outDir = paths => path.join(paths.V, 'out', ...PREFIX.split('/'))
const listOut = paths => (fs.existsSync(outDir(paths)) ? fs.readdirSync(outDir(paths)).sort() : [])
const ALL = () => true

test('bundlePath and sidecarPath place a dated branch under <V>/out/<prefix>/<date>.bundle', PROC, t => {
  const { paths } = fixture(t)
  const file = bundlePath(paths, TODAY)
  assert.equal(file, path.join(paths.V, 'out', 'tl', 'loop', '2026-10-02.bundle'))
  assert.ok(path.isAbsolute(file))
  assert.equal(sidecarPath(paths, TODAY), `${file}.json`)
  assert.equal(bundlePath(paths, 'a.b_c-d/2026-01-31'), path.join(paths.V, 'out', 'a.b_c-d', '2026-01-31.bundle'))
  for (const bad of ['main', '2026-10-02', '../x/2026-10-02', 'a/../b/2026-10-02', '-x/2026-10-02', 'x.lock/2026-10-02',
    'tl//2026-10-02', 'tl/2026-13-02', 'tl/2026-10-02/x', 'tl/2026-10-2', '/tl/2026-10-02', 'refs/heads/tl/2026-10-02x', '']) {
    assert.throws(() => bundlePath(paths, bad), /bad-branch/, bad)
    assert.throws(() => sidecarPath(paths, bad), /bad-branch/, bad)
  }
})

test('writeBundle writes one head with the base as its prerequisite; it verifies and fetches in a copy of <P>', PROC, t => {
  const { P, W, paths, B1 } = fixture(t)
  commit(W, 'c1.txt', 'one\n')
  const tip = commit(W, 'c2.txt', 'two\n')
  const res = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const file = bundlePath(paths, TODAY)
  assert.deepEqual(res, { file, tip, sha256: sha256File(file), bytes: fs.statSync(file).size, why: 'commit' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(listOut(paths), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
  assert.deepEqual(readSidecar(paths, TODAY), { tip, sha256: res.sha256 })
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecarPath(paths, TODAY), 'utf8')), { tip, sha256: res.sha256 })
  const header = bundleHeader(file)
  assert.deepEqual(header.prerequisites, [B1])
  assert.deepEqual(header.heads, [{ oid: tip, ref: `refs/heads/${TODAY}` }])
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: true, reason: null })
  assert.deepEqual(bundleCurrent(paths, TODAY), { current: true, reason: null })

  const copy = copyOf(t, P)
  assert.equal(git(copy, 'bundle', 'list-heads', file), `${tip} refs/heads/${TODAY}`)
  assert.equal(gitRun(copy, 'bundle', 'verify', '-q', file).status, 0)
  git(copy, 'fetch', '-q', '--no-tags', file, `refs/heads/${TODAY}:refs/remotes/tech-lead/${TODAY}`)
  assert.equal(git(copy, 'rev-parse', `refs/remotes/tech-lead/${TODAY}`), tip)
  assert.equal(git(copy, 'show', `${tip}:c1.txt`), 'one')
  // <P> itself is untouched: the commits exist only in the clone and the copy.
  assert.notEqual(gitRun(P, 'cat-file', '-e', tip).status, 0)
})

test('a branch chained on day 1 carries day 1\'s commits', PROC, t => {
  const { P, W, paths, B1 } = fixture(t)
  workGit(W, ['switch', '-q', '--no-track', '-c', DAY1, 'refs/tech-lead/base'])
  const c1 = commit(W, 'day1.txt', 'day one\n')
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, `refs/heads/${DAY1}`])
  const c2 = commit(W, 'day2.txt', 'day two\n')
  const res = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  assert.equal(res.tip, c2)
  assert.deepEqual(bundleHeader(res.file).prerequisites, [B1])
  const copy = copyOf(t, P)
  git(copy, 'fetch', '-q', '--no-tags', res.file, `refs/heads/${TODAY}:refs/remotes/tech-lead/${TODAY}`)
  assert.equal(gitRun(copy, 'cat-file', '-e', `${c1}^{commit}`).status, 0)
  assert.equal(git(copy, 'rev-parse', `${c2}^`), c1)
  assert.equal(git(copy, 'show', `${c2}:day1.txt`), 'day one')
})

test('an empty range writes nothing and leaves no temporary file', PROC, t => {
  const { paths } = fixture(t)
  assert.deepEqual(writeBundle(paths, TODAY, { why: 'commit', guard: () => {} }), { empty: true })
  assert.equal(fs.existsSync(bundlePath(paths, TODAY)), false)
  assert.equal(fs.existsSync(sidecarPath(paths, TODAY)), false)
  assert.deepEqual(listOut(paths).filter(n => n.startsWith('.tmp-')), [])
})

test('writeBundle refuses a branch that is not there, a bad why and a tip that moved', PROC, t => {
  const { W, paths } = fixture(t)
  assert.throws(() => writeBundle(paths, DAY1, { why: 'commit', guard: () => {} }), /no-branch/)
  commit(W, 'x.txt', 'x\n')
  assert.throws(() => writeBundle(paths, TODAY, { why: '', guard: () => {} }), /bad-why/)
  assert.throws(() => writeBundle(paths, TODAY, { guard: () => {} }), /bad-why/)
  assert.throws(() => writeBundle(paths, TODAY, { why: 'commit', tip: '0'.repeat(40), guard: () => {} }), /tip-moved/)
  assert.equal(fs.existsSync(bundlePath(paths, TODAY)), false)
  assert.deepEqual(listOut(paths).filter(n => n.startsWith('.tmp-')), [])
})

test('a rewrite to a tip that does not descend from the old one keeps the old bundle as .prev-<UTC stamp>', PROC, t => {
  const { W, paths } = fixture(t)
  const t1 = commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  assert.equal(first.tip, t1)
  // An ancestor rewrite (the branch moved on) replaces the file and keeps no .prev.
  const t2 = commit(W, 'c2.txt', 'two\n')
  const second = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  assert.equal(second.tip, t2)
  assert.deepEqual(listOut(paths), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
  const secondBytes = fs.readFileSync(second.file)
  // A non-ancestor rewrite (the branch was reset, as after a retirement) keeps the old file.
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  const t3 = commit(W, 'c3.txt', 'three\n')
  const third = writeBundle(paths, TODAY, { why: 'regenerated', guard: () => {} })
  assert.equal(third.tip, t3)
  assert.equal(third.why, 'regenerated')
  const names = listOut(paths)
  const prev = names.filter(n => PREV_RE.test(n))
  assert.equal(prev.length, 1, names.join(', '))
  assert.deepEqual(names.filter(n => !PREV_RE.test(n)), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
  const prevFile = path.join(outDir(paths), prev[0])
  assert.ok(fs.readFileSync(prevFile).equals(secondBytes))
  assert.deepEqual(bundleHeader(prevFile).heads, [{ oid: t2, ref: `refs/heads/${TODAY}` }])
  assert.deepEqual(bundleHeader(third.file).heads, [{ oid: t3, ref: `refs/heads/${TODAY}` }])
  assert.deepEqual(readSidecar(paths, TODAY), { tip: t3, sha256: third.sha256 })
  // The stamp is the UTC time of the rewrite.
  const stamp = prev[0].match(/prev-(\d{8}T\d{6})Z/)[1]
  const when = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15))
  assert.ok(Math.abs(Date.now() - when) < 120000, stamp)
  // A second non-ancestor rewrite within the same second never overwrites the first .prev.
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  commit(W, 'c4.txt', 'four\n')
  writeBundle(paths, TODAY, { why: 'regenerated', guard: () => {} })
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  commit(W, 'c5.txt', 'five\n')
  writeBundle(paths, TODAY, { why: 'regenerated', guard: () => {} })
  assert.equal(listOut(paths).filter(n => PREV_RE.test(n)).length, 3)
  assert.ok(fs.readFileSync(prevFile).equals(secondBytes))
})

test('bundleCurrent names why a bundle is stale', PROC, t => {
  const { W, paths } = fixture(t)
  const tip = commit(W, 'c1.txt', 'one\n')
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'missing' })
  const res = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const side = sidecarPath(paths, TODAY)
  const sideBytes = fs.readFileSync(side)
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: true, reason: null })

  fs.rmSync(side)
  assert.equal(readSidecar(paths, TODAY), null)
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'no-sidecar' })
  fs.writeFileSync(side, 'not json\n')
  assert.equal(readSidecar(paths, TODAY), null)
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'no-sidecar' })
  fs.writeFileSync(side, JSON.stringify({ tip }) + '\n')
  assert.equal(readSidecar(paths, TODAY), null)
  fs.writeFileSync(side, JSON.stringify({ tip: 'f'.repeat(40), sha256: res.sha256 }) + '\n')
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'other-tip' })
  fs.writeFileSync(side, sideBytes)
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: true, reason: null })
  // The branch moved on: the sidecar names another tip.
  const next = commit(W, 'c2.txt', 'two\n')
  assert.deepEqual(bundleCurrent(paths, TODAY, next), { current: false, reason: 'other-tip' })
  assert.deepEqual(bundleCurrent(paths, TODAY), { current: false, reason: 'other-tip' })
  // The file's bytes no longer hash to the sidecar's sha256.
  fs.appendFileSync(res.file, 'x')
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'sha256-mismatch' })
  // A symlink standing in for the file is no bundle of ours.
  fs.rmSync(res.file)
  fs.symlinkSync(path.join(paths.V, 'identity.json'), res.file)
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'not-a-file' })
})

test('a corrupted file (same header, other pack bytes) is not current and is regenerated without a .prev', PROC, t => {
  const { P, W, paths } = fixture(t)
  const tip = commit(W, 'c1.txt', 'one\n')
  const res = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const good = fs.readFileSync(res.file)
  const { size } = bundleHeader(res.file)
  const bad = Buffer.from(good)
  bad[size + 20] ^= 0xff
  fs.writeFileSync(res.file, bad)
  assert.deepEqual(bundleHeader(res.file).heads, [{ oid: tip, ref: `refs/heads/${TODAY}` }])
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: false, reason: 'sha256-mismatch' })

  const results = syncBundles(paths, { vetted: ALL, guard: () => {} })
  assert.equal(results.length, 1)
  assert.equal(results[0].branch, TODAY)
  assert.equal(results[0].result.state, 'written')
  assert.equal(results[0].result.reason, 'sha256-mismatch')
  assert.equal(results[0].result.tip, tip)
  assert.equal(results[0].result.why, 'regenerated')
  assert.equal(sha256File(res.file), readSidecar(paths, TODAY).sha256)
  assert.deepEqual(listOut(paths), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
  assert.deepEqual(bundleCurrent(paths, TODAY, tip), { current: true, reason: null })
  const copy = copyOf(t, P)
  git(copy, 'fetch', '-q', '--no-tags', res.file, `refs/heads/${TODAY}:refs/remotes/tech-lead/${TODAY}`)
  assert.equal(git(copy, 'rev-parse', `refs/remotes/tech-lead/${TODAY}`), tip)
})

test('a base that advances keeps the bundle current; a base rewrite makes it stale and the rewrite carries what the new base lacks', PROC, t => {
  const { root, P, W, paths, B0, B1 } = fixture(t)
  const c1 = commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  assert.deepEqual(bundleHeader(first.file).prerequisites, [B1])
  // The owner's base moves forward: every prerequisite is still reachable from it.
  commit(P, 'p.txt', 'p\n')
  refresh(paths)
  assert.deepEqual(bundleCurrent(paths, TODAY, c1), { current: true, reason: null })
  assert.deepEqual(syncBundles(paths, { vetted: ALL, guard: () => {} }).map(r => [r.branch, r.result.state]), [[TODAY, 'current']])
  // The owner rewrites the base back to B0: B1 is no longer reachable from refs/tech-lead/base.
  git(P, 'reset', '-q', '--hard', B0)
  refresh(paths)
  assert.equal(workGit(W, ['rev-parse', 'refs/tech-lead/base']), B0)
  assert.deepEqual(bundleCurrent(paths, TODAY, c1), { current: false, reason: 'prerequisite-unreachable' })
  const results = syncBundles(paths, { vetted: ALL, guard: () => {} })
  assert.equal(results[0].result.state, 'written')
  assert.equal(results[0].result.reason, 'prerequisite-unreachable')
  assert.deepEqual(bundleHeader(first.file).prerequisites, [B0])
  assert.deepEqual(listOut(paths), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
  // A fresh repository holding only the rewritten base gets B1 and c1 from the bundle.
  const fresh = path.join(root, 'fresh')
  execFileSync('git', ['clone', '-q', '--no-local', P, fresh], { env: process.env, stdio: 'ignore' })
  assert.notEqual(gitRun(fresh, 'cat-file', '-e', `${B1}^{commit}`).status, 0)
  assert.equal(gitRun(fresh, 'bundle', 'verify', '-q', first.file).status, 0)
  git(fresh, 'fetch', '-q', '--no-tags', first.file, `refs/heads/${TODAY}:refs/remotes/tech-lead/${TODAY}`)
  assert.equal(git(fresh, 'rev-parse', `${c1}^`), B1)
})

test('syncBundles skips merged, contained, retired and unvetted branches and rewrites only what is stale', PROC, t => {
  const { P, W, paths, B0 } = fixture(t)
  const branchAt = (name, start) => workGit(W, ['switch', '-q', '--no-track', '-C', name, start])
  // merged: no commit beyond the base.
  workGit(W, ['update-ref', 'refs/heads/tl/loop/2026-09-27', B0])
  // contained: squash-merged into the base by the owner.
  branchAt('tl/loop/2026-09-28', 'refs/tech-lead/base')
  commit(W, 'squash.txt', 'squashed\n')
  commit(P, 'squash.txt', 'squashed\n', 'squash merge')
  // retired, and a branch chained on the retired tip (comparable with it).
  branchAt('tl/loop/2026-09-29', 'refs/tech-lead/base')
  const r1 = commit(W, 'rejected.txt', 'rejected\n')
  branchAt('tl/loop/2026-09-30', 'refs/heads/tl/loop/2026-09-29')
  commit(W, 'on-rejected.txt', 'more\n')
  // unvetted, under another prefix.
  branchAt('other/2026-10-01', 'refs/tech-lead/base')
  const u1 = commit(W, 'unvetted.txt', 'u\n')
  // today's work.
  workGit(W, ['switch', '-q', TODAY])
  const tip = commit(W, 'today.txt', 'today\n')
  // A non-dated head is never a delivery branch (checkClone would refuse it; it is not listed).
  // The owner retires 2026-09-29 in <P>; the refresh brings the ref and the squash merge.
  execFileSync('git', ['-C', P, 'fetch', '-q', W, `refs/heads/tl/loop/2026-09-29:refs/tech-lead/retired/tl/loop/2026-09-29`],
    { env: process.env, stdio: 'ignore' })
  refresh(paths)
  assert.equal(workGit(W, ['rev-parse', 'refs/tech-lead/retired/tl/loop/2026-09-29']), r1)

  const seen = []
  const vetted = ({ branch, ref, tip: at }) => {
    seen.push({ branch, ref, tip: at })
    return branch !== 'other/2026-10-01'
  }
  const results = syncBundles(paths, { vetted, guard: () => {} })
  const states = Object.fromEntries(results.map(r => [r.branch, r.result.state === 'skipped' ? `skipped:${r.result.reason}` : r.result.state]))
  assert.deepEqual(states, {
    'other/2026-10-01': 'unvetted',
    'tl/loop/2026-09-27': 'skipped:merged',
    'tl/loop/2026-09-28': 'skipped:contained',
    'tl/loop/2026-09-29': 'skipped:retired',
    'tl/loop/2026-09-30': 'skipped:retired',
    [TODAY]: 'written',
  })
  assert.deepEqual(results.map(r => r.branch), Object.keys(states).sort())
  const unvetted = results.find(r => r.branch === 'other/2026-10-01').result
  assert.match(unvetted.note, /other\/2026-10-01/)
  assert.match(unvetted.note, /not vetted/)
  assert.equal(unvetted.tip, u1)
  // vetted is asked for every branch that is neither merged nor retired, the contained one
  // included: it comes before the containment check, which merges the branch's content.
  assert.deepEqual(seen, [
    { branch: 'other/2026-10-01', ref: 'refs/heads/other/2026-10-01', tip: u1 },
    { branch: 'tl/loop/2026-09-28', ref: 'refs/heads/tl/loop/2026-09-28', tip: workGit(W, ['rev-parse', 'refs/heads/tl/loop/2026-09-28']) },
    { branch: TODAY, ref: `refs/heads/${TODAY}`, tip },
  ])
  const written = results.find(r => r.branch === TODAY).result
  assert.equal(written.reason, 'missing')
  assert.equal(written.tip, tip)
  assert.equal(written.file, bundlePath(paths, TODAY))
  // Only today's bundle exists under <V>/out.
  const files = []
  const walk = dir => { for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); fs.statSync(p).isDirectory() ? walk(p) : files.push(path.relative(paths.V, p)) } }
  walk(path.join(paths.V, 'out'))
  assert.deepEqual(files.sort(), ['out/tl/loop/2026-10-02.bundle', 'out/tl/loop/2026-10-02.bundle.json'])

  // A second sync rewrites nothing: the file keeps its inode and bytes.
  const before = fs.statSync(written.file)
  const again = syncBundles(paths, { vetted, guard: () => {} })
  assert.deepEqual(again.find(r => r.branch === TODAY).result, { state: 'current', file: written.file, tip })
  const after = fs.statSync(written.file)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)

  // retired given explicitly (commit names) gives the same answer; an empty list retires nothing.
  const explicit = syncBundles(paths, { vetted, retired: [r1], guard: () => {} })
  assert.equal(explicit.find(r => r.branch === 'tl/loop/2026-09-30').result.state, 'skipped')
  const none = syncBundles(paths, { vetted, retired: [], guard: () => {} })
  assert.equal(none.find(r => r.branch === 'tl/loop/2026-09-29').result.state, 'written')
  assert.equal(none.find(r => r.branch === 'tl/loop/2026-09-30').result.state, 'written')
})

test('syncBundles needs a vetted predicate and a plain base', PROC, t => {
  const { paths } = fixture(t)
  assert.throws(() => syncBundles(paths, { guard: () => {} }), /vetted/)
  assert.throws(() => syncBundles(paths, { vetted: true, guard: () => {} }), /vetted/)
  assert.throws(() => syncBundles(paths, { vetted: ALL, base: '--all', guard: () => {} }), /base/)
})

// Runs writeBundle in a child process with TECH_LEAD_FAULT set; returns the spawn result.
const killedWrite = (env, P) => {
  const code = [
    `import fs from 'node:fs';`,
    `const { writeBundle } = await import(${JSON.stringify(pathToFileURL(DELIVERY).href)});`,
    `const { loopPaths } = await import(${JSON.stringify(pathToFileURL(LOOP_PATHS).href)});`,
    `fs.writeSync(1, 'started ' + process.pid + '\\n');`,
    `writeBundle(loopPaths(${JSON.stringify(P)}), ${JSON.stringify(TODAY)}, { why: 'commit', guard: () => {} });`,
    `fs.writeSync(1, 'finished\\n');`,
  ].join('\n')
  return spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...env, TECH_LEAD_FAULT: 'bundle:before-rename' }, encoding: 'utf8', timeout: 60000 })
}

test('a SIGKILL at bundle:before-rename leaves the old bundle and its sidecar intact', PROC, async t => {
  const { env, P, W, paths } = fixture(t)
  const t1 = commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const oldBundle = fs.readFileSync(first.file)
  const oldSide = fs.readFileSync(sidecarPath(paths, TODAY))

  // An ancestor rewrite killed before the rename.
  const t2 = commit(W, 'c2.txt', 'two\n')
  const r = killedWrite(env, P)
  assert.equal(r.signal, 'SIGKILL', `status ${r.status} stdout ${r.stdout} stderr ${r.stderr}`)
  assert.match(r.stdout, /^started \d+\n$/)
  const childPid = Number(r.stdout.match(/started (\d+)/)[1])
  assert.ok(fs.readFileSync(first.file).equals(oldBundle))
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide))
  assert.deepEqual(readSidecar(paths, TODAY), { tip: t1, sha256: first.sha256 })
  const temps = listOut(paths).filter(n => n.startsWith('.tmp-'))
  assert.equal(temps.length, 1)
  assert.match(temps[0], TEMP_RE)
  assert.ok(temps[0].startsWith(`.tmp-${childPid}-`))
  assert.deepEqual(listOut(paths).filter(n => PREV_RE.test(n)), [])
  assert.deepEqual(bundleCurrent(paths, TODAY, t2), { current: false, reason: 'other-tip' })
  // The dead writer's temporary file is swept the way prepare sweeps <V>/out.
  assert.equal(startToken(childPid).state, 'gone')
  assert.deepEqual(sweepTemps(outDir(paths)), [path.join(outDir(paths), temps[0])])

  // A non-ancestor rewrite killed before the rename: the old file is still the bundle, and its
  // .prev copy is already there, so nothing is lost either way.
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  const t3 = commit(W, 'c3.txt', 'three\n')
  const r2 = killedWrite(env, P)
  assert.equal(r2.signal, 'SIGKILL', `status ${r2.status} stdout ${r2.stdout} stderr ${r2.stderr}`)
  assert.ok(fs.readFileSync(first.file).equals(oldBundle))
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide))
  const prev = listOut(paths).filter(n => PREV_RE.test(n))
  assert.equal(prev.length, 1)
  assert.ok(fs.readFileSync(path.join(outDir(paths), prev[0])).equals(oldBundle))

  // The next sync writes the bundle for the current tip.
  sweepTemps(outDir(paths))
  const results = syncBundles(paths, { vetted: ALL, guard: () => {} })
  assert.equal(results[0].result.state, 'written')
  assert.equal(results[0].result.reason, 'other-tip')
  assert.equal(results[0].result.tip, t3)
  assert.deepEqual(bundleCurrent(paths, TODAY, t3), { current: true, reason: null })
  assert.deepEqual(listOut(paths).filter(n => n.startsWith('.tmp-')), [])
})

// --- review round: vetting before content checks (Cg2#2, Cg3#3); the lock re-checked right
// before publication (Cg2#3, Cg3#6, R31) ---

test('syncBundles asks vetted before any content check: an unvetted branch is never merged, even one the base contains', PROC, t => {
  const { P, W, paths } = fixture(t)
  // Squash-merged by the owner, and not vetted.
  workGit(W, ['switch', '-q', '--no-track', '-C', 'tl/loop/2026-09-28', 'refs/tech-lead/base'])
  commit(W, 'squash.txt', 'squashed\n')
  commit(P, 'squash.txt', 'squashed\n', 'squash merge')
  refresh(paths)
  workGit(W, ['switch', '-q', TODAY])
  const seen = []
  const results = syncBundles(paths, { vetted: ({ branch }) => { seen.push(branch); return branch !== 'tl/loop/2026-09-28' }, guard: () => {} })
  const r = results.find(x => x.branch === 'tl/loop/2026-09-28').result
  assert.equal(r.state, 'unvetted', JSON.stringify(r))
  assert.deepEqual(seen, ['tl/loop/2026-09-28'], 'today has no commit beyond the base, so only the squashed branch is asked')
  // Vetted, the same branch reads contained.
  assert.equal(syncBundles(paths, { vetted: ALL, guard: () => {} }).find(x => x.branch === 'tl/loop/2026-09-28').result.reason, 'contained')
})

test('syncBundles runs no merge driver the branch selects (its containment check neutralizes them)', PROC, t => {
  const { P, W, paths, root } = fixture(t)
  const m = path.join(root, 'ran')
  // <W>'s config names a driver (as an owner's global config could); today's branch selects it
  // for b.txt and edits b.txt, and the owner's base edits b.txt too, so a merge would call it.
  workGit(W, ['config', 'merge.evil.driver', `touch '${m}'; exit 0`])
  write(path.join(W, '.gitattributes'), 'b.txt merge=evil\n')
  write(path.join(W, 'b.txt'), 'b\nbranch\n')
  workGit(W, ['add', '-A'])
  workGit(W, ['commit', '-q', '-m', 'branch work'])
  write(path.join(P, 'b.txt'), 'base\nb\n')
  git(P, 'commit', '-q', '-a', '-m', 'base moves on')
  refresh(paths)
  // Control: plain git in <W> runs it.
  gitRun(W, 'merge-tree', '--write-tree', 'refs/tech-lead/base', `refs/heads/${TODAY}`)
  assert.equal(fs.existsSync(m), true, 'control')
  fs.rmSync(m)
  const results = syncBundles(paths, { vetted: ALL, guard: () => {} })
  assert.equal(results.find(x => x.branch === TODAY).result.state, 'written', JSON.stringify(results))
  assert.equal(fs.existsSync(m), false, 'syncBundles ran the merge driver')
})

const lockLost = (why = 'generation 1 was released') => Object.assign(new Error(`not-holder: ${why}`), { code: 'NOT_HOLDER' })

test('writeBundle re-checks the lock right before it publishes: a lock lost while the bundle was made publishes nothing', PROC, async t => {
  const { env, P, W, paths } = fixture(t)
  const lock = await acquire(P, { env })
  assert.equal(lock.state, 'acquired', JSON.stringify(lock))
  const N = lock.generation
  const held = () => assertHeld(paths, N, env)
  commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: held })
  const oldBundle = fs.readFileSync(first.file)
  const oldSide = fs.readFileSync(sidecarPath(paths, TODAY))
  // A rewrite that does not descend from the old tip (it would keep a .prev).
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  commit(W, 'c2.txt', 'two\n')
  // The lock is lost (an owner release) after the caller's own check.
  const r = await release(P, N, { env })
  assert.equal(r.state, 'released', JSON.stringify(r))
  const seen = []
  const guard = () => { seen.push(listOut(paths)); return held() }
  assert.throws(() => writeBundle(paths, TODAY, { why: 'commit', guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(seen.length, 1)
  assert.ok(seen[0].some(n => TEMP_RE.test(n)), `the check ran once the bundle was made: ${seen[0]}`)
  assert.ok(fs.readFileSync(first.file).equals(oldBundle), 'the published bundle is unchanged')
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide), 'the sidecar is unchanged')
  assert.deepEqual(listOut(paths).filter(n => PREV_RE.test(n) || n.startsWith('.tmp-')), [], 'no .prev, no temp file')
})

test('writeBundle re-checks the lock before the sidecar; syncBundles propagates NOT_HOLDER and HOLDER_UNKNOWN', PROC, t => {
  const { W, paths } = fixture(t)
  const t1 = commit(W, 'c1.txt', 'one\n')
  writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const oldSide = fs.readFileSync(sidecarPath(paths, TODAY))
  const t2 = commit(W, 'c2.txt', 'two\n')
  let calls = 0
  assert.throws(() => writeBundle(paths, TODAY, { why: 'commit', guard: () => { if (++calls === 2) throw lockLost() } }), e => e.code === 'NOT_HOLDER')
  assert.equal(calls, 2)
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide), 'no sidecar written after the lock was lost')
  assert.deepEqual(readSidecar(paths, TODAY).tip, t1)
  assert.deepEqual(bundleCurrent(paths, TODAY, t2), { current: false, reason: 'other-tip' })
  // syncBundles: a lost lock is no branch error; it propagates, and the later branches wait.
  for (const code of ['NOT_HOLDER', 'HOLDER_UNKNOWN']) {
    const err = Object.assign(new Error(`${code.toLowerCase().replace('_', '-')}: gone`), { code })
    assert.throws(() => syncBundles(paths, { vetted: ALL, guard: () => { throw err } }), e => e === err, code)
    assert.deepEqual(bundleCurrent(paths, TODAY, t2), { current: false, reason: 'other-tip' }, code)
  }
  // A guard that holds lets the sync publish; one that is no function is refused.
  const ok = syncBundles(paths, { vetted: ALL, guard: () => {} })
  assert.equal(ok[0].result.state, 'written')
  assert.throws(() => writeBundle(paths, TODAY, { why: 'commit', guard: true }), TypeError)
  assert.throws(() => syncBundles(paths, { vetted: ALL, guard: 'yes' }), TypeError)
})

test('guard is required: writeBundle and syncBundles without a guard function throw TypeError and publish nothing (R31)', PROC, t => {
  const { W, paths } = fixture(t)
  commit(W, 'c1.txt', 'one\n')
  const guardError = e => e instanceof TypeError && /guard must be a function/.test(e.message)
  for (const [label, opts] of [['left out', { why: 'commit' }], ['undefined', { why: 'commit', guard: undefined }], ['null', { why: 'commit', guard: null }]]) {
    assert.throws(() => writeBundle(paths, TODAY, opts), guardError, `writeBundle, guard ${label}`)
  }
  assert.throws(() => syncBundles(paths, { vetted: ALL }), guardError, 'syncBundles, guard left out')
  assert.throws(() => syncBundles(paths, { vetted: ALL, guard: undefined }), guardError, 'syncBundles, guard undefined')
  assert.deepEqual(listOut(paths), [], 'nothing was published')
  // The same calls with a guard publish.
  assert.equal(syncBundles(paths, { vetted: ALL, guard: () => {} })[0].result.state, 'written')
  assert.deepEqual(listOut(paths), ['2026-10-02.bundle', '2026-10-02.bundle.json'])
})

test('every refs/tech-lead/retired/** tip counts as retired, a kept <branch>@<sha12> one included (R27)', PROC, t => {
  const { P, W, paths } = fixture(t)
  workGit(W, ['switch', '-q', '--no-track', '-C', 'tl/loop/2026-09-29', 'refs/tech-lead/base'])
  const r1 = commit(W, 'rejected.txt', 'rejected\n')
  workGit(W, ['switch', '-q', TODAY])
  // Retired once at r1, then again at another tip: r1 is kept under its own ref in <P>.
  const kept = `refs/tech-lead/retired/tl/loop/2026-09-29@${r1.slice(0, 12)}`
  execFileSync('git', ['-C', P, 'fetch', '-q', W, `refs/heads/tl/loop/2026-09-29:${kept}`], { env: process.env, stdio: 'ignore' })
  refresh(paths)
  assert.equal(workGit(W, ['rev-parse', kept]), r1, 'the refresh refspec brings the kept ref into <W>')
  const r = syncBundles(paths, { vetted: ALL, guard: () => {} }).find(x => x.branch === 'tl/loop/2026-09-29').result
  assert.deepEqual([r.state, r.reason], ['skipped', 'retired'])
})

// --- fix round 2: the guard sits right before each .prev link and right before the public
// rename, with no git call between them (code#1, R31 sharpened) ---

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

// A stand-in git first on PATH (workGit looks git up on this process's PATH): the first time
// ' <its arguments> ' matches the sh case pattern, it runs action; then the real git runs.
// run(fn) calls fn with the stand-in first on PATH and puts PATH back afterwards.
const standIn = (root, pattern, action) => {
  const bin = fs.mkdtempSync(path.join(root, 'git-bin-'))
  const once = path.join(bin, 'fired')
  const lines = ['#!/bin/sh', 'case " $* " in', `  ${pattern}) if [ ! -e '${once}' ]; then : > '${once}'; ${action}; fi ;;`, 'esac',
    `exec '${REAL_GIT}' "$@"`, '']
  fs.writeFileSync(path.join(bin, 'git'), lines.join('\n'), { mode: 0o755 })
  return {
    fired: () => fs.existsSync(once),
    run: fn => {
      const saved = process.env.PATH
      process.env.PATH = `${bin}:${saved}`
      try { return fn() } finally { process.env.PATH = saved }
    },
  }
}
// The holder dies (and is reaped by init) while git runs: the firing lock is lost from then on.
const killHolder = pid => `kill -9 ${pid}; i=0; while kill -0 ${pid} 2>/dev/null && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done`

test('a lock lost during the ancestry check of the bundle a rewrite keeps publishes nothing: no .prev, the old bundle stays (code#1, R31)', PROC, async t => {
  const { env, root, P, W, paths } = fixture(t)
  const lock = await acquire(P, { env })
  assert.equal(lock.state, 'acquired', JSON.stringify(lock))
  const held = () => assertHeld(paths, lock.generation, env)
  const t1 = commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: held })
  const oldBundle = fs.readFileSync(first.file)
  const oldSide = fs.readFileSync(sidecarPath(paths, TODAY))
  // A rewrite whose tip does not descend from t1: writeBundle asks git whether t1 is an
  // ancestor of it (should the old bundle be kept as .prev?), and the holder dies during that
  // very git run.
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  const t2 = commit(W, 'c2.txt', 'two\n')
  const fake = standIn(root, `*" merge-base --is-ancestor ${t1} ${t2} "*`, killHolder(Number(env.TECH_LEAD_HOLDER_PID)))
  assert.throws(() => fake.run(() => writeBundle(paths, TODAY, { why: 'regenerated', guard: held })), e => e.code === 'NOT_HOLDER')
  assert.equal(fake.fired(), true, 'the ancestry check ran')
  assert.ok(fs.readFileSync(first.file).equals(oldBundle), 'the published bundle is unchanged')
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide), 'the sidecar is unchanged')
  assert.deepEqual(listOut(paths).filter(n => PREV_RE.test(n) || n.startsWith('.tmp-')), [], 'no .prev, no temp file')
  assert.deepEqual(bundleCurrent(paths, TODAY, t2), { current: false, reason: 'other-tip' })
})

test('a lock lost once the .prev link is made publishes nothing: the guard runs again right before the rename (code#1, R31)', PROC, t => {
  const { W, paths } = fixture(t)
  commit(W, 'c1.txt', 'one\n')
  const first = writeBundle(paths, TODAY, { why: 'commit', guard: () => {} })
  const oldBundle = fs.readFileSync(first.file)
  const oldSide = fs.readFileSync(sidecarPath(paths, TODAY))
  workGit(W, ['switch', '-q', '--no-track', '-C', TODAY, 'refs/tech-lead/base'])
  commit(W, 'c2.txt', 'two\n')
  // The lock holds until the .prev copy exists; every check from then on finds it lost.
  const seen = []
  const guard = () => {
    const names = listOut(paths)
    seen.push(names)
    if (names.some(n => PREV_RE.test(n))) throw lockLost('released after the .prev link')
  }
  assert.throws(() => writeBundle(paths, TODAY, { why: 'regenerated', guard }), e => e.code === 'NOT_HOLDER')
  assert.equal(seen.length, 2, JSON.stringify(seen))
  assert.ok(fs.readFileSync(first.file).equals(oldBundle), 'the published bundle is unchanged')
  assert.ok(fs.readFileSync(sidecarPath(paths, TODAY)).equals(oldSide), 'the sidecar is unchanged')
  const prev = listOut(paths).filter(n => PREV_RE.test(n))
  assert.equal(prev.length, 1, 'the .prev link made before the loss stays (a copy of the published bundle)')
  assert.ok(fs.readFileSync(path.join(outDir(paths), prev[0])).equals(oldBundle))
  assert.deepEqual(listOut(paths).filter(n => n.startsWith('.tmp-')), [], 'no temp file')
})

// The test harness's cleanup (fix round 2): the sleeper's hook signals its pid only while the
// pid still names the sleeper. A ps (TECH_LEAD_PS) that reads every live process as one started
// in 1970 stands in for the kernel handing the pid to another process before the hook runs.
test('the sleeper cleanup kills its own process, and leaves alone a pid that names another process by then', { skip: process.platform !== 'darwin' && 'the start token reads ps on darwin only' }, async t => {
  const waitGone = async pid => {
    for (let i = 0; i < 60 && startToken(pid).state !== 'gone'; i++) await new Promise(resolve => setTimeout(resolve, 50))
    return startToken(pid).state === 'gone'
  }
  let pid, start
  await t.test('the pid reads as another process when the test ends', st => {
    pid = sleeper(st)
    start = startToken(pid).token
    const file = path.join(tmp(st, 'tl-delivery-ps-'), 'ps')
    fs.writeFileSync(file, '#!/bin/sh\necho "S Thu Jan 1 00:00:00 1970"\n', { mode: 0o755 })
    const before = process.env.TECH_LEAD_PS
    process.env.TECH_LEAD_PS = file
    st.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
  })
  t.after(() => { if (isAlive({ pid, start }) === true) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  assert.equal(isAlive({ pid, start }), true, `the cleanup killed pid ${pid}, which it could not prove its own`)
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitGone(pid))
  let own
  await t.test('the pid still names the sleeper when the test ends', st => { own = sleeper(st) })
  assert.ok(await waitGone(own), `the cleanup left its own sleeper ${own} running`)
})
