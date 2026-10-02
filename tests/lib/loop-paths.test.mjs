// tests/lib/loop-paths.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureV, keyOf, loopPaths } from '../../scripts/lib/loop-paths.mjs'

// Keep the user's git config and hooks out of the fixture repositories; loopPaths' own
// git call copies this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const h16 = R => crypto.createHash('sha256').update(R, 'utf8').digest('hex').slice(0, 16)

// A temp directory, removed when the test ends.
const tmp = (t, prefix = 'tl-paths-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
// A repository with one commit at <parent>/<name>.
const repoAt = (parent, name) => {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}
// An env whose cache root is a not yet existing directory in a temp dir.
const cacheEnv = t => ({ ...process.env, TECH_LEAD_CACHE: path.join(tmp(t, 'tl-cache-'), 'cache') })

test('the key is slug-h over the real path, and every path hangs off <R> and <V>', t => {
  const parent = tmp(t)
  const P = repoAt(parent, 'Code')
  const env = cacheEnv(t)
  const p = loopPaths(P, { env })
  const R = fs.realpathSync.native(P)
  const key = `code-${h16(R)}`
  const V = path.join(env.TECH_LEAD_CACHE, 'tech-lead', key)
  assert.deepEqual(p, { P, R, key, S: path.join(R, '.tech-lead'), V, W: path.join(V, 'clone'), lockDir: path.join(V, 'lock') })
  assert.match(p.key, /^code-[0-9a-f]{16}$/)
  assert.equal(fs.existsSync(env.TECH_LEAD_CACHE), false, 'loopPaths creates nothing')
})

test('a symlink alias of the project gives the key of the real path', t => {
  const parent = tmp(t)
  const real = repoAt(parent, 'code')
  const alias = path.join(parent, 'alias')
  fs.symlinkSync(real, alias)
  const env = cacheEnv(t)
  const viaAlias = loopPaths(alias, { env }), viaReal = loopPaths(real, { env })
  assert.equal(viaAlias.P, alias)
  assert.equal(viaAlias.R, fs.realpathSync.native(real))
  assert.equal(viaAlias.key, viaReal.key)
  assert.equal(viaAlias.V, viaReal.V)
  assert.equal(viaAlias.lockDir, viaReal.lockDir)
  assert.ok(viaAlias.key.startsWith('code-'), 'the slug is the real basename, not the alias name')
  // os.tmpdir() is itself behind a symlink on macOS (/var -> /private/var): R resolves it.
  assert.equal(viaReal.R, fs.realpathSync.native(parent) + path.sep + 'code')
})

test('on a case-insensitive volume a differently cased path gives the on-disk case and the same key', t => {
  const parent = tmp(t)
  const real = repoAt(parent, 'MyProj')
  const other = path.join(parent, 'myproj')
  if (!fs.existsSync(other)) return t.skip('case-sensitive volume')
  const env = cacheEnv(t)
  const p = loopPaths(other, { env })
  assert.equal(path.basename(p.R), 'MyProj')
  assert.equal(p.key, loopPaths(real, { env }).key)
  assert.match(p.key, /^myproj-[0-9a-f]{16}$/)
})

test('a 200-character basename gives a 64-character slug of lowercase and dashes', t => {
  const parent = tmp(t)
  const name = 'Ab C'.repeat(50)
  assert.equal(name.length, 200)
  const p = loopPaths(repoAt(parent, name), { env: cacheEnv(t) })
  const [slug, h] = [p.key.slice(0, -17), p.key.slice(-16)]
  assert.equal(slug, 'ab-c'.repeat(16))
  assert.equal(slug.length, 64)
  assert.equal(p.key[64], '-')
  assert.equal(h, h16(p.R))
})

test('keyOf: an empty basename becomes project; each character outside [a-z0-9._-] becomes one dash', () => {
  assert.equal(keyOf('/'), `project-${h16('/')}`)
  assert.equal(keyOf('/x/My Repo.v2_(x)'), `my-repo.v2_-x--${h16('/x/My Repo.v2_(x)')}`)
  const astral = 'a' + String.fromCodePoint(0x1F600) + 'b'
  assert.equal(keyOf(`/x/${astral}`), `a-b-${h16(`/x/${astral}`)}`)
})

test('a subdirectory of a repository is refused as not-toplevel', t => {
  const parent = tmp(t)
  const repo = repoAt(parent, 'code')
  fs.mkdirSync(path.join(repo, 'sub'))
  const R = fs.realpathSync.native(path.join(repo, 'sub')), top = fs.realpathSync.native(repo)
  assert.throws(() => loopPaths(path.join(repo, 'sub'), { env: cacheEnv(t) }),
    { message: `not-toplevel: ${R} is inside ${top}` })
})

test('an inherited GIT_DIR does not make a subdirectory or a plain directory pass', t => {
  const parent = tmp(t)
  const repo = repoAt(parent, 'code')
  fs.mkdirSync(path.join(repo, 'sub'))
  const plain = tmp(t, 'tl-plain-')
  const env = cacheEnv(t)
  const saved = process.env.GIT_DIR
  process.env.GIT_DIR = path.join(repo, '.git')
  try {
    assert.throws(() => loopPaths(path.join(repo, 'sub'), { env }), /^Error: not-toplevel: /)
    assert.throws(() => loopPaths(plain, { env }), /^Error: not-a-repo: /)
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
  }
})

test('a linked worktree is a top level of its own', t => {
  const parent = tmp(t)
  const repo = repoAt(parent, 'code')
  const wt = path.join(parent, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  const env = cacheEnv(t)
  const p = loopPaths(wt, { env })
  assert.equal(p.R, fs.realpathSync.native(wt))
  assert.notEqual(p.key, loopPaths(repo, { env }).key)
})

test('a directory outside any repository, or a missing one, is refused as not-a-repo', t => {
  const plain = tmp(t, 'tl-plain-')
  assert.throws(() => loopPaths(plain, { env: cacheEnv(t) }), /^Error: not-a-repo: /)
  assert.throws(() => loopPaths(path.join(plain, 'missing'), { env: cacheEnv(t) }), /^Error: not-a-repo: /)
})

test('TECH_LEAD_CACHE replaces <homedir>/.cache as the cache root', t => {
  const P = repoAt(tmp(t), 'code')
  const env = cacheEnv(t)
  const key = loopPaths(P, { env }).key
  assert.equal(loopPaths(P, { env }).V, path.join(env.TECH_LEAD_CACHE, 'tech-lead', key))
  const bare = { ...process.env }
  delete bare.TECH_LEAD_CACHE
  assert.equal(loopPaths(P, { env: bare }).V, path.join(os.homedir(), '.cache', 'tech-lead', key))
  assert.equal(loopPaths(P, { env: { ...bare, TECH_LEAD_CACHE: '' } }).V, path.join(os.homedir(), '.cache', 'tech-lead', key))
  // A relative root would follow the firing's working directory, so two firings would not share a lock.
  assert.throws(() => loopPaths(P, { env: { ...bare, TECH_LEAD_CACHE: 'cache' } }), /^Error: bad-cache: /)
})

test('ensureV creates <V> and identity.json, accepts the same R again and refuses a different one', t => {
  const parent = tmp(t)
  const env = cacheEnv(t)
  const p = loopPaths(repoAt(parent, 'code'), { env })
  assert.equal(ensureV(p), p)
  const idFile = path.join(p.V, 'identity.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(idFile, 'utf8')), { v: 1, R: p.R })
  assert.equal(ensureV(p), p, 'a second firing of the same project reuses <V>')
  assert.deepEqual(fs.readdirSync(p.V), ['identity.json'], 'no temp files are left behind')

  // Another project whose <V> path collides with this one (the owner moved a cache, or a
  // hash collision): the recorded R wins and nothing is rewritten.
  const before = fs.readFileSync(idFile, 'utf8')
  const other = { ...p, R: path.join(parent, 'elsewhere') }
  assert.throws(() => ensureV(other), { message: `identity-mismatch: ${p.V} belongs to ${p.R}` })
  assert.equal(fs.readFileSync(idFile, 'utf8'), before)

  fs.writeFileSync(idFile, '{"v":1,')
  assert.throws(() => ensureV(p), /corrupt: /)
})
