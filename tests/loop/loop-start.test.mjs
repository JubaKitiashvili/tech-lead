// tests/loop/loop-start.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { startPoint } from '../../scripts/loop-start.mjs'

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
