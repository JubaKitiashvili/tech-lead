// tests/lib/git-safe.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { safeGit } from '../../scripts/lib/git-safe.mjs'

// Keep the user's git config and hooks out of the fixture repositories; safeGit copies
// this environment for its own git calls.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})

// Plain git, the control: it sees whatever the given environment says.
const git = (repo, args, env = process.env) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const commit = (repo, name, env) => {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`)
  git(repo, ['add', '-A'], env)
  git(repo, ['commit', '-q', '-m', name], env)
}

// A temp directory, removed when the test ends.
const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A repository with one commit on main, named `name`.
const repo = (t, name = 'base') => {
  const dir = tmp(t, 'tl-gitsafe-')
  git(dir, ['init', '-q', '-b', 'main'])
  commit(dir, name)
  return dir
}

// Sets environment variables for the duration of fn, then restores the previous values.
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return fn() } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

// An executable shell script that appends its name to `marker` when it runs.
const markerScript = (file, marker) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\necho ${path.basename(file)} >> '${marker}'\nexit 0\n`)
  fs.chmodSync(file, 0o755)
}

test('a commit through safeGit runs no hook, from .git/hooks or from a repo-configured core.hooksPath', t => {
  const r = repo(t)
  const marker = path.join(tmp(t, 'tl-gitsafe-marker-'), 'ran')
  for (const h of ['pre-commit', 'commit-msg', 'post-commit']) markerScript(path.join(r, '.git', 'hooks', h), marker)

  // Control: plain git runs the hooks, so the fixture is live.
  commit(r, 'control')
  assert.equal(fs.readFileSync(marker, 'utf8'), 'pre-commit\ncommit-msg\npost-commit\n')
  fs.rmSync(marker)

  fs.writeFileSync(path.join(r, 'a.txt'), 'a\n')
  safeGit(r, ['add', '-A'])
  safeGit(r, ['commit', '-q', '-m', 'through safeGit'])
  assert.equal(safeGit(r, ['log', '-1', '--format=%s']), 'through safeGit')
  assert.equal(fs.existsSync(marker), false, 'no hook ran under safeGit')

  // A repository that points core.hooksPath at its own directory, as husky does.
  for (const h of ['pre-commit', 'post-commit']) markerScript(path.join(r, '.githooks', h), marker)
  git(r, ['config', 'core.hooksPath', '.githooks'])
  fs.writeFileSync(path.join(r, 'b.txt'), 'b\n')
  safeGit(r, ['add', '-A'])
  safeGit(r, ['commit', '-q', '-m', 'second'])
  assert.equal(fs.existsSync(marker), false, 'no hook from core.hooksPath ran under safeGit')
  commit(r, 'control-2')
  assert.equal(fs.readFileSync(marker, 'utf8'), 'pre-commit\npost-commit\n', 'control: plain git runs them')
})

test('an fsmonitor hook configured in the repository does not run under safeGit', t => {
  const r = repo(t)
  const marker = path.join(tmp(t, 'tl-gitsafe-marker-'), 'ran')
  const hook = path.join(tmp(t, 'tl-gitsafe-fsmon-'), 'fsmonitor')
  markerScript(hook, marker)
  git(r, ['config', 'core.fsmonitor', hook])

  git(r, ['status', '--porcelain'])
  assert.equal(fs.existsSync(marker), true, 'control: plain git status runs the fsmonitor hook')
  fs.rmSync(marker)

  fs.writeFileSync(path.join(r, 'base.txt'), 'changed\n')
  assert.equal(safeGit(r, ['status', '--porcelain']), ' M base.txt')
  assert.equal(fs.existsSync(marker), false, 'the fsmonitor hook did not run under safeGit')
})

test('an inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE pointing at another repo are ignored', t => {
  const mine = repo(t, 'mine')
  const other = repo(t, 'other')
  const inherited = {
    GIT_DIR: path.join(other, '.git'),
    GIT_WORK_TREE: other,
    GIT_INDEX_FILE: path.join(other, '.git', 'index'),
  }
  const before = git(other, ['rev-parse', 'HEAD'])

  withEnv(inherited, () => {
    // Control: plain git follows the inherited variables to the other repository.
    assert.equal(git(mine, ['log', '-1', '--format=%s']), 'other')

    assert.equal(safeGit(mine, ['log', '-1', '--format=%s']), 'mine')
    assert.equal(fs.realpathSync(safeGit(mine, ['rev-parse', '--show-toplevel'])), fs.realpathSync(mine))
    fs.writeFileSync(path.join(mine, 'new.txt'), 'new\n')
    safeGit(mine, ['add', '-A'])
    safeGit(mine, ['commit', '-q', '-m', 'lands in mine'])
  })

  assert.equal(git(mine, ['log', '-1', '--format=%s']), 'lands in mine')
  assert.equal(git(other, ['rev-parse', 'HEAD']), before, 'the other repository is untouched')
  assert.equal(git(other, ['status', '--porcelain']), '')
})

test('inherited GIT_CONFIG_PARAMETERS does not reach git', t => {
  const r = repo(t)
  withEnv({ GIT_CONFIG_PARAMETERS: "'tl.probe'='inherited'" }, () => {
    assert.equal(git(r, ['config', '--default', 'none', '--get', 'tl.probe']), 'inherited', 'control')
    assert.equal(safeGit(r, ['config', '--default', 'none', '--get', 'tl.probe']), 'none')
  })
})

test('config injected through GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n> does not reach git', t => {
  const r = repo(t)
  const injected = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'alias.x', GIT_CONFIG_VALUE_0: '!echo injected',
    GIT_CONFIG_KEY_1: 'tl.probe', GIT_CONFIG_VALUE_1: 'inherited',
  }
  withEnv(injected, () => {
    assert.equal(git(r, ['x']), 'injected', 'control: plain git runs the injected alias')
    assert.equal(git(r, ['config', '--default', 'none', '--get', 'tl.probe']), 'inherited', 'control')
    assert.throws(() => safeGit(r, ['x']), /'x' is not a git command/)
    assert.equal(safeGit(r, ['config', '--default', 'none', '--get', 'tl.probe']), 'none')
    // None of the variables is left in the environment git runs with, even one whose
    // index GIT_CONFIG_COUNT would not reach.
    withEnv({ GIT_CONFIG_KEY_7: 'tl.far', GIT_CONFIG_VALUE_7: 'x' }, () => {
      const env = safeGit(r, ['-c', 'alias.env=!env', 'env']).split('\n')
      assert.deepEqual(env.filter(l => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(l)), [])
      assert.ok(env.some(l => l === 'GIT_NO_REPLACE_OBJECTS=1'), 'the listing is the environment git ran with')
    })
  })
})

test('replace refs are not followed', t => {
  const r = repo(t)
  const original = git(r, ['rev-parse', 'HEAD'])
  const fake = git(r, ['commit-tree', `${original}^{tree}`, '-m', 'replacement'])
  git(r, ['replace', original, fake])
  assert.equal(git(r, ['log', '-1', '--format=%s', original]), 'replacement', 'control: plain git follows the replace ref')
  assert.equal(safeGit(r, ['log', '-1', '--format=%s', original]), 'base')
})

test('a failing command throws with git stderr in the message', t => {
  const r = repo(t)
  assert.throws(() => safeGit(r, ['rev-parse', '--verify', 'refs/heads/no-such-branch']),
    err => /Needed a single revision/.test(err.message) && /rev-parse/.test(err.message))
  const missing = path.join(tmp(t, 'tl-gitsafe-gone-'), 'nowhere')
  assert.throws(() => safeGit(missing, ['status']), /cannot change to/)
})

test('stdin comes from input, and only one trailing newline is trimmed from stdout', t => {
  const r = repo(t)
  const blob = safeGit(r, ['hash-object', '-w', '--stdin'], { input: 'line\n\n' })
  assert.match(blob, /^[0-9a-f]{40}$/)
  assert.equal(safeGit(r, ['cat-file', '-p', blob]), 'line\n')
  // Leading whitespace is significant in porcelain output.
  fs.writeFileSync(path.join(r, 'base.txt'), 'changed\n')
  assert.equal(safeGit(r, ['status', '--porcelain']), ' M base.txt')
  assert.equal(safeGit(r, ['diff', '--quiet', '--cached']), '')
})
