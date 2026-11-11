// tests/lib/workspace-paths.test.mjs
// loop-paths.mjs's workspacePaths and checkIdentity: a repository's top level gets loopPaths'
// own key and <V>; a folder in no repository works; a folder below a repository's top level is
// not-toplevel; a missing path or a file is not-a-directory; a symlink resolves to the folder's
// key; a <V> bound to another R is refused.
import '../helpers.mjs' // scrubs inherited git routing variables from process.env before any other module loads
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkIdentity, ensureV, keyOf, loopPaths, workspacePaths } from '../../scripts/lib/loop-paths.mjs'

Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })

const tmp = (t, prefix = 'tl-ws-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const cacheEnv = t => ({ ...process.env, TECH_LEAD_CACHE: path.join(tmp(t, 'tl-ws-cache-'), 'cache') })
const repo = dir => {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  return dir
}

test('a repository\'s top level gets exactly loopPaths\' key and <V>', t => {
  const P = repo(path.join(tmp(t), 'code'))
  const env = cacheEnv(t)
  const w = workspacePaths(P, { env }), l = loopPaths(P, { env })
  assert.deepEqual(w, { P, R: l.R, key: l.key, V: l.V })
  assert.equal(fs.existsSync(env.TECH_LEAD_CACHE), false, 'creates nothing')
})

test('a folder in no repository works, keyed by its real path; a symlink to it gives the same key', t => {
  const parent = tmp(t)
  const W = path.join(parent, 'Workspace')
  fs.mkdirSync(W)
  repo(path.join(W, 'inner'))
  const env = cacheEnv(t)
  const w = workspacePaths(W, { env })
  const R = fs.realpathSync.native(W)
  assert.deepEqual(w, { P: W, R, key: keyOf(R), V: path.join(env.TECH_LEAD_CACHE, 'tech-lead', keyOf(R)) })
  const alias = path.join(parent, 'alias')
  fs.symlinkSync(W, alias)
  const a = workspacePaths(alias, { env })
  assert.deepEqual([a.R, a.key, a.V], [w.R, w.key, w.V])
  assert.throws(() => loopPaths(W, { env }), /^Error: not-a-repo: /, 'loopPaths itself is unchanged')
})

test('below a repository\'s top level is not-toplevel, its git directory too', t => {
  const P = repo(path.join(tmp(t), 'code'))
  const sub = path.join(P, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  const env = cacheEnv(t)
  assert.throws(() => workspacePaths(sub, { env }), /^Error: not-toplevel: /)
  assert.throws(() => workspacePaths(path.join(P, '.git'), { env }), /^Error: not-toplevel: /)
})

test('a missing path and a file are not-a-directory; a relative cache root is bad-cache', t => {
  const d = tmp(t)
  const file = path.join(d, 'f.txt')
  fs.writeFileSync(file, 'x')
  const env = cacheEnv(t)
  assert.throws(() => workspacePaths(path.join(d, 'absent'), { env }), /^Error: not-a-directory: /)
  assert.throws(() => workspacePaths(file, { env }), /^Error: not-a-directory: /)
  assert.throws(() => workspacePaths(d, { env: { ...env, TECH_LEAD_CACHE: 'rel/cache' } }), /^Error: bad-cache: /)
})

test('identity: ensureV binds a workspace <V> to its R, and checkIdentity refuses a <V> bound to another', t => {
  const d = tmp(t)
  const env = cacheEnv(t)
  const w = ensureV(workspacePaths(d, { env }))
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.V, 'identity.json'), 'utf8')), { v: 1, R: w.R })
  assert.equal(checkIdentity(w), w)
  fs.writeFileSync(path.join(w.V, 'identity.json'), JSON.stringify({ v: 1, R: '/somewhere/else' }))
  assert.throws(() => checkIdentity(workspacePaths(d, { env })), new Error(`identity-mismatch: ${w.V} belongs to /somewhere/else`))
  assert.throws(() => ensureV(workspacePaths(d, { env })), /^Error: identity-mismatch: /)
})
