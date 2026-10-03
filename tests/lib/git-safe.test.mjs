// tests/lib/git-safe.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  GIT_TOO_OLD, STORAGE_DIRS, STORAGE_FILES, WORK_OVERRIDES, assertAttrSource, attrSourceWorks, cloneRepo, safeGit, workGit, workGitRun,
} from '../../scripts/lib/git-safe.mjs'

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

// ---- 0c-2: options, scrub additions, workGit, workGitRun, cloneRepo (brief section 2) ----

const PROC = { timeout: 90000 }
const NEW_SCRUBBED = [
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_QUARANTINE_PATH', 'GIT_ATTR_SOURCE',
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS', 'GIT_EXEC_PATH',
  'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE',
]
const sentinel = k => `tl-sentinel-${k.toLowerCase()}`
const OLD_DATE = '@1000000000 +0000'

// Bytes that are not valid UTF-8, with a NUL and two trailing newlines.
const RAW = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x0a, 0x0a])

// A stand-in `git` first on PATH: a real process that prints its physical cwd, each argument
// and its environment, and appends to `marker` when it runs. It shows exactly what the
// helpers spawn; the behaviour tests use the real git.
const fakeGit = t => {
  const dir = tmp(t, 'tl-gitsafe-fake-')
  const marker = path.join(dir, 'ran')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `echo ran >> '${marker}'`,
    'printf "cwd=%s\\n" "$(pwd -P)"',
    'for a in "$@"; do printf "arg=%s\\n" "$a"; done',
    'env | sed "s/^/env=/"',
    '',
  ].join('\n'))
  fs.chmodSync(path.join(bin, 'git'), 0o755)
  return {
    marker,
    run: fn => withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn),
    parse: out => {
      const lines = String(out).split('\n')
      const env = {}
      for (const l of lines.filter(x => x.startsWith('env='))) {
        const kv = l.slice(4), i = kv.indexOf('=')
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
      }
      return {
        cwd: lines.find(l => l.startsWith('cwd='))?.slice(4),
        args: lines.filter(l => l.startsWith('arg=')).map(l => l.slice(4)),
        env,
      }
    },
  }
}

const cfgArgs = list => list.flatMap(kv => ['-c', kv])

const mkfifo = (t) => {
  const p = path.join(tmp(t, 'tl-gitsafe-fifo-'), 'fifo')
  execFileSync('mkfifo', [p])
  return p
}
// No process still has the FIFO path on its command line.
const noProcessWith = needle => {
  const r = spawnSync('pgrep', ['-f', needle], { encoding: 'utf8' })
  assert.equal(r.status, 1, `a process with ${needle} on its command line is still running: ${r.stdout}`)
}

test('input may be a Buffer and buffer returns stdout as raw bytes with nothing stripped', t => {
  const r = repo(t)
  const blob = safeGit(r, ['hash-object', '-w', '--stdin'], { input: RAW })
  assert.match(blob, /^[0-9a-f]{40}$/)
  const out = safeGit(r, ['cat-file', 'blob', blob], { buffer: true })
  assert.ok(Buffer.isBuffer(out))
  assert.deepEqual(out, RAW)
  // Control: the default string mode decodes and strips, so it cannot carry these bytes.
  assert.notDeepEqual(Buffer.from(safeGit(r, ['cat-file', 'blob', blob]), 'utf8'), RAW)
  // A failing command still throws with git's stderr as text.
  assert.throws(() => safeGit(r, ['cat-file', 'blob', '0'.repeat(40)], { buffer: true }),
    err => typeof err.stderr === 'string' && /cat-file/.test(err.message) && err.status !== 0)
})

test('outFd streams stdout to that descriptor byte for byte and returns an empty string', t => {
  const r = repo(t)
  const big = Buffer.concat([RAW, Buffer.alloc(1024 * 1024, 0x61), RAW])
  const blob = safeGit(r, ['hash-object', '-w', '--stdin'], { input: big })
  const file = path.join(tmp(t, 'tl-gitsafe-out-'), 'blob.bin')
  const fd = fs.openSync(file, 'w')
  let ret
  try { ret = safeGit(r, ['cat-file', 'blob', blob], { outFd: fd }) } finally { fs.closeSync(fd) }
  assert.equal(ret, '')
  // Compared with equals: an assertion diff of a 1 MiB Buffer takes minutes to render.
  const got = fs.readFileSync(file)
  assert.equal(got.length, big.length)
  assert.ok(got.equals(big), 'the file holds exactly the blob bytes')
})

test('indexFile points git at a temporary index that does not exist yet, even over an inherited GIT_INDEX_FILE', t => {
  const r = repo(t)
  const other = repo(t, 'other')
  const mainIndex = fs.readFileSync(path.join(r, '.git', 'index'))
  const otherIndex = fs.readFileSync(path.join(other, '.git', 'index'))
  const idx = path.join(tmp(t, 'tl-gitsafe-idx-'), 'index')
  assert.equal(fs.existsSync(idx), false)
  withEnv({ GIT_INDEX_FILE: path.join(other, '.git', 'index') }, () => {
    safeGit(r, ['read-tree', 'HEAD'], { indexFile: idx })
    const blob = safeGit(r, ['hash-object', '-w', '--stdin'], { input: 'new\n' })
    safeGit(r, ['update-index', '--add', '--cacheinfo', `100644,${blob},new.txt`], { indexFile: idx })
    assert.equal(safeGit(r, ['ls-files'], { indexFile: idx }), 'base.txt\nnew.txt')
    const tree = safeGit(r, ['write-tree'], { indexFile: idx })
    assert.equal(safeGit(r, ['ls-tree', '--name-only', tree]), 'base.txt\nnew.txt')
    assert.equal(safeGit(r, ['ls-files']), 'base.txt', 'without the option the repository index is used')
  })
  assert.ok(fs.existsSync(idx))
  assert.deepEqual(fs.readFileSync(path.join(r, '.git', 'index')), mainIndex, 'the repository index is byte-identical')
  assert.deepEqual(fs.readFileSync(path.join(other, '.git', 'index')), otherIndex, 'the inherited index is untouched')
  assert.throws(() => safeGit(r, ['ls-files'], { indexFile: 'relative/index' }), /indexFile must be an absolute path/)
})

test('config extras are passed as -c after the fixed overrides, so a later value wins', t => {
  const r = repo(t)
  assert.equal(safeGit(r, ['config', '--get', 'core.untrackedCache']), 'false')
  assert.equal(safeGit(r, ['config', '--get-all', 'core.untrackedCache'], { config: ['core.untrackedCache=true'] }), 'false\ntrue')
  assert.equal(safeGit(r, ['config', '--get', 'core.untrackedCache'], { config: ['core.untrackedCache=true'] }), 'true')
  assert.equal(safeGit(r, ['config', '--get', 'tl.extra'], { config: ['tl.extra=one'] }), 'one')

  const fake = fakeGit(t)
  const seen = fake.parse(fake.run(() => safeGit(r, ['status', '--porcelain'], { config: ['tl.a=1', 'tl.b=2'] })))
  assert.deepEqual(seen.args, ['-C', r,
    ...cfgArgs(['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'tl.a=1', 'tl.b=2']),
    'status', '--porcelain'])
})

test('timeoutMs stops a git that does not finish and throws code TIMEOUT', PROC, t => {
  const r = repo(t)
  const fifo = mkfifo(t) // git blocks opening a FIFO that has no writer
  const started = Date.now()
  assert.throws(() => safeGit(r, ['hash-object', fifo], { timeoutMs: 300 }),
    err => err.code === 'TIMEOUT' && /timed out after 300 ms/.test(err.message) && /hash-object/.test(err.message))
  assert.ok(Date.now() - started < 30000)
  noProcessWith(fifo)
})

test('env extras are set last, after the scrub', t => {
  const r = repo(t)
  withEnv({ GIT_AUTHOR_DATE: OLD_DATE }, () => {
    const ident = safeGit(r, ['var', 'GIT_AUTHOR_IDENT'], {
      env: { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_AUTHOR_DATE: '@1234567890 +0000' },
    })
    assert.equal(ident, 'Owner <owner@example.com> 1234567890 +0000')
  })
  // env wins over indexFile and the fixed variables, being set last.
  const fake = fakeGit(t)
  const seen = fake.parse(fake.run(() => safeGit(r, ['status'], {
    indexFile: '/abs/one', env: { GIT_INDEX_FILE: '/abs/two', LC_ALL: 'en_US.UTF-8', TL_PROBE: 'x' },
  })))
  assert.equal(seen.env.GIT_INDEX_FILE, '/abs/two')
  assert.equal(seen.env.LC_ALL, 'en_US.UTF-8')
  assert.equal(seen.env.TL_PROBE, 'x')
  // An undefined value unsets the variable.
  const unset = fake.parse(fake.run(() => safeGit(r, ['status'], { env: { GIT_TERMINAL_PROMPT: undefined } })))
  assert.equal(unset.env.GIT_TERMINAL_PROMPT, undefined)
  assert.equal(seen.env.GIT_TERMINAL_PROMPT, '0')
})

test('each newly scrubbed variable, the identity dates included, does not reach git from safeGit, workGit or cloneRepo', t => {
  const r = repo(t)
  const W = repo(t, 'work')
  const fake = fakeGit(t)
  const vars = Object.fromEntries(NEW_SCRUBBED.map(k => [k, sentinel(k)]))
  withEnv(vars, () => fake.run(() => {
    const outs = {
      safeGit: safeGit(r, ['status']),
      workGit: workGit(W, ['status']),
    }
    const dest = path.join(tmp(t, 'tl-gitsafe-dest-'), 'd')
    fs.mkdirSync(dest, { mode: 0o700 })
    outs.cloneRepo = cloneRepo(r, dest, { templateDir: tmp(t, 'tl-gitsafe-tmpl-') })
    for (const [who, out] of Object.entries(outs)) {
      const { env } = fake.parse(out)
      assert.ok(Object.keys(env).length > 3, `${who}: the listing is the environment git ran with`)
      for (const k of NEW_SCRUBBED) assert.notEqual(env[k], sentinel(k), `${who}: ${k} reached git`)
    }
  }))
})

// git's trace variables: each writes to stderr (or a file) from every git call.
const TRACE_VARS = [
  'GIT_TRACE', 'GIT_TRACE2', 'GIT_TRACE2_EVENT', 'GIT_TRACE2_PERF', 'GIT_TRACE2_BRIEF', 'GIT_TRACE2_ENV_VARS',
  'GIT_TRACE2_CONFIG_PARAMS', 'GIT_TRACE2_PARENT_SID', 'GIT_TRACE_PACKET', 'GIT_TRACE_PACKFILE', 'GIT_TRACE_SETUP',
  'GIT_TRACE_PERFORMANCE', 'GIT_TRACE_REFS', 'GIT_TRACE_CURL', 'GIT_TRACE_CURL_NO_DATA', 'GIT_TRACE_SHALLOW',
  'GIT_TRACE_PACK_ACCESS', 'GIT_TRACE_FSMONITOR', 'GIT_TRACE_REDACT',
]

test('every inherited GIT_TRACE* and GIT_TRACE2* variable is scrubbed from safeGit, workGit and cloneRepo', t => {
  const r = repo(t)
  const W = repo(t, 'work')
  const fake = fakeGit(t)
  withEnv(Object.fromEntries(TRACE_VARS.map(k => [k, '1'])), () => fake.run(() => {
    const dest = path.join(tmp(t, 'tl-gitsafe-dest-'), 'd')
    fs.mkdirSync(dest, { mode: 0o700 })
    const outs = {
      safeGit: safeGit(r, ['status']),
      workGit: workGit(W, ['status']),
      workGitRun: workGitRun(W, ['status']).stdout,
      cloneRepo: cloneRepo(r, dest, { templateDir: tmp(t, 'tl-gitsafe-tmpl-') }),
    }
    for (const [who, out] of Object.entries(outs)) {
      const { env } = fake.parse(out)
      assert.ok(Object.keys(env).length > 3, `${who}: the listing is the environment git ran with`)
      // Only the three trace2 targets reach git, pinned off (config-driven trace2 is off too).
      const traced = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_TRACE')))
      assert.deepEqual(traced, { GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' }, `${who}: a trace variable reached git`)
    }
  }))
})

test('trace2 targets set in the global config reach no helper stderr; env can still turn trace2 on', PROC, t => {
  const r = repo(t)
  const W = repo(t, 'work')
  const cfg = path.join(tmp(t, 'tl-gitsafe-trace2-'), 'gitconfig')
  fs.writeFileSync(cfg, '[trace2]\n\tnormalTarget = /dev/stderr\n\tperfTarget = /dev/stderr\n\teventTarget = /dev/stderr\n')
  withEnv({ GIT_CONFIG_GLOBAL: cfg }, () => {
    // Control: plain git writes all three trace2 streams to stderr under this config.
    const ctl = spawnSync('git', ['-C', r, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: process.env })
    assert.equal(ctl.status, 0, ctl.stderr)
    assert.match(ctl.stderr, /cmd_name rev-parse/, 'control: the normal target')
    assert.match(ctl.stderr, /\| cmd_name +\|/, 'control: the perf target')
    assert.match(ctl.stderr, /"event":"cmd_name"/, 'control: the event target')
    for (const args of [['for-each-ref'], ['rev-parse', 'HEAD'], ['config', '--list'], ['status', '--porcelain']]) {
      const res = workGitRun(W, args)
      assert.equal(res.status, 0, args.join(' '))
      assert.equal(res.stderr, '', `workGitRun ${args.join(' ')}`)
    }
    // A failure's stderr, and so its message, is git's own one line.
    const oneLine = err => /^fatal: /.test(err.stderr) && err.stderr.trim().split('\n').length === 1 && !/cmd_name|"event"/.test(err.message)
    assert.throws(() => safeGit(r, ['cat-file', '-t', 'nope']), oneLine)
    assert.throws(() => workGit(W, ['cat-file', '-t', 'nope']), oneLine)
    const dest = path.join(tmp(t, 'tl-gitsafe-dest-'), 'd')
    fs.mkdirSync(dest, { mode: 0o700 })
    assert.throws(() => cloneRepo(path.join(r, 'missing'), dest, { templateDir: tmp(t, 'tl-gitsafe-tmpl-') }), err =>
      !/cmd_name|"event"|\| main +\|/.test(err.stderr) && /fatal: /.test(err.stderr))
    // env is set last: a caller can still turn a trace2 target on, or unset the pin so the config applies.
    assert.match(workGitRun(W, ['rev-parse', 'HEAD'], { env: { GIT_TRACE2: '1' } }).stderr, /cmd_name rev-parse/)
    assert.match(workGitRun(W, ['rev-parse', 'HEAD'], { env: { GIT_TRACE2_EVENT: undefined } }).stderr, /"event":"cmd_name"/)
  })
})

test('under an inherited GIT_TRACE git writes nothing but its own messages to stderr; env can still turn tracing on', PROC, t => {
  const r = repo(t)
  const W = repo(t, 'work')
  withEnv({ GIT_TRACE: '1', GIT_TRACE2: '1', GIT_TRACE2_PERF: '1', GIT_TRACE_SETUP: '1', GIT_TRACE_PERFORMANCE: '1' }, () => {
    // Control: plain git traces under this environment.
    assert.match(spawnSync('git', ['-C', r, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: process.env }).stderr, /trace: built-in: git rev-parse/)
    for (const args of [['for-each-ref'], ['rev-parse', 'HEAD'], ['config', '--list']]) {
      const res = workGitRun(W, args)
      assert.equal(res.status, 0, args.join(' '))
      assert.equal(res.stderr, '', `workGitRun ${args.join(' ')}`)
    }
    assert.throws(() => safeGit(r, ['cat-file', '-t', 'nope']), err => /^fatal: /.test(err.stderr) && err.stderr.trim().split('\n').length === 1)
    assert.throws(() => workGit(W, ['cat-file', '-t', 'nope']), err => /^fatal: /.test(err.stderr) && err.stderr.trim().split('\n').length === 1)
    // env is set last: a caller that wants a trace (the loop-clone passthrough) still gets one.
    assert.match(workGitRun(W, ['rev-parse', 'HEAD'], { env: { GIT_TRACE: '1' } }).stderr, / trace: built-in: git rev-parse HEAD/)
  })
})

test('inherited identity dates and GIT_EXTERNAL_DIFF and GIT_LITERAL_PATHSPECS change nothing under safeGit', t => {
  const r = repo(t)
  const marker = path.join(tmp(t, 'tl-gitsafe-marker-'), 'ran')
  const ext = path.join(tmp(t, 'tl-gitsafe-ext-'), 'ext-diff')
  markerScript(ext, marker)
  fs.writeFileSync(path.join(r, 'base.txt'), 'changed\n')
  withEnv({ GIT_AUTHOR_DATE: OLD_DATE, GIT_COMMITTER_DATE: OLD_DATE, GIT_EXTERNAL_DIFF: ext, GIT_LITERAL_PATHSPECS: '1' }, () => {
    // Controls: plain git follows each of them.
    assert.match(git(r, ['var', 'GIT_AUTHOR_IDENT']), / 1000000000 \+0000$/)
    git(r, ['diff'])
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ext-diff\n')
    fs.rmSync(marker)
    assert.equal(git(r, ['ls-files', '--', '*.txt']), '')

    assert.doesNotMatch(safeGit(r, ['var', 'GIT_AUTHOR_IDENT']), / 1000000000 \+0000$/)
    assert.doesNotMatch(safeGit(r, ['var', 'GIT_COMMITTER_IDENT']), / 1000000000 \+0000$/)
    assert.match(safeGit(r, ['diff']), /^\+changed$/m)
    assert.equal(fs.existsSync(marker), false, 'the inherited external diff did not run')
    assert.equal(safeGit(r, ['ls-files', '--', '*.txt']), 'base.txt')
    safeGit(r, ['commit', '-q', '-am', 'dated now'])
    const [at, ct] = safeGit(r, ['log', '-1', '--format=%at %ct']).split(' ').map(Number)
    assert.ok(at > 1600000000 && ct > 1600000000, 'the commit carries the current time, not the inherited date')
  })
})

test('workGit refuses a gitfile .git, a symlinked .git and a missing .git with CLONE_INVALID and spawns nothing', t => {
  const real = repo(t, 'real')
  const gitfile = tmp(t, 'tl-gitsafe-gitfile-')
  fs.writeFileSync(path.join(gitfile, '.git'), `gitdir: ${path.join(real, '.git')}\n`)
  const linked = tmp(t, 'tl-gitsafe-linked-')
  fs.symlinkSync(path.join(real, '.git'), path.join(linked, '.git'))
  const missing = tmp(t, 'tl-gitsafe-missing-')
  // Controls: plain git follows the gitfile and the symlink to the real repository.
  assert.equal(git(gitfile, ['log', '-1', '--format=%s']), 'real')
  assert.equal(git(linked, ['log', '-1', '--format=%s']), 'real')

  const fake = fakeGit(t)
  fake.run(() => {
    for (const W of [gitfile, linked, missing]) {
      assert.throws(() => workGit(W, ['status']),
        err => err.code === 'CLONE_INVALID' && err.message.startsWith(`clone-invalid: ${W}/.git is not a directory`))
      const res = workGitRun(W, ['status'])
      assert.equal(res.status, null)
      assert.equal(res.code, 'CLONE_INVALID')
      assert.match(res.error, /^clone-invalid: /)
    }
  })
  assert.equal(fs.existsSync(fake.marker), false, 'git was never spawned')
})

test('workGit spawns git with cwd W, no -C, the work overrides then config, and pinned GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR', t => {
  const W = repo(t, 'work')
  const other = repo(t, 'other')
  const fake = fakeGit(t)
  const inherited = {
    GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: path.join(other, '.git'),
    GIT_INDEX_FILE: path.join(other, '.git', 'index'), GIT_OBJECT_DIRECTORY: path.join(other, '.git', 'objects'),
    GIT_EDITOR: 'vi', GIT_PAGER: 'less',
  }
  withEnv(inherited, () => fake.run(() => {
    const seen = fake.parse(workGit(W, ['status', '--porcelain'], { config: ['tl.extra=1'] }))
    assert.equal(seen.cwd, fs.realpathSync(W))
    assert.deepEqual(seen.args, [...cfgArgs([...WORK_OVERRIDES, 'tl.extra=1']), 'status', '--porcelain'])
    assert.equal(seen.args.includes('-C'), false)
    assert.deepEqual({
      GIT_DIR: seen.env.GIT_DIR, GIT_WORK_TREE: seen.env.GIT_WORK_TREE, GIT_COMMON_DIR: seen.env.GIT_COMMON_DIR,
      GIT_NO_REPLACE_OBJECTS: seen.env.GIT_NO_REPLACE_OBJECTS, GIT_OPTIONAL_LOCKS: seen.env.GIT_OPTIONAL_LOCKS,
      GIT_PAGER: seen.env.GIT_PAGER, GIT_EDITOR: seen.env.GIT_EDITOR, GIT_LITERAL_PATHSPECS: seen.env.GIT_LITERAL_PATHSPECS,
      LC_ALL: seen.env.LC_ALL, GIT_TERMINAL_PROMPT: seen.env.GIT_TERMINAL_PROMPT,
    }, {
      GIT_DIR: path.join(W, '.git'), GIT_WORK_TREE: W, GIT_COMMON_DIR: path.join(W, '.git'),
      GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: ':', GIT_LITERAL_PATHSPECS: '1',
      LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
    })
    assert.equal(seen.env.GIT_INDEX_FILE, undefined)
    assert.equal(seen.env.GIT_OBJECT_DIRECTORY, undefined)
    // indexFile and env are set after the pins.
    const withIdx = fake.parse(workGit(W, ['ls-files'], { indexFile: '/abs/idx', env: { TL_PROBE: 'y' } }))
    assert.equal(withIdx.env.GIT_INDEX_FILE, '/abs/idx')
    assert.equal(withIdx.env.TL_PROBE, 'y')
    // diff, log and show get --no-ext-diff --no-textconv right after the subcommand.
    for (const sub of ['diff', 'log', 'show']) {
      const s = fake.parse(workGit(W, [sub, 'HEAD', '--', 'x']))
      assert.deepEqual(s.args.slice(WORK_OVERRIDES.length * 2), [sub, '--no-ext-diff', '--no-textconv', 'HEAD', '--', 'x'])
    }
  }))
  assert.ok(WORK_OVERRIDES.includes('repack.updateServerInfo=false'))
  assert.deepEqual(WORK_OVERRIDES, [
    'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'core.pager=cat', 'color.ui=never',
    'commit.gpgSign=false', 'tag.gpgSign=false', 'gc.auto=0', 'maintenance.auto=false', 'repack.updateServerInfo=false',
    'protocol.allow=never', 'protocol.file.allow=always', 'core.safecrlf=false', 'index.sparse=false',
    'core.sparseCheckout=false', 'core.quotePath=true', 'submodule.recurse=false',
  ])
})

test('workGit works in W whatever GIT_* the caller inherited, and its options behave as safeGit\'s', PROC, t => {
  const W = repo(t, 'mine')
  const other = repo(t, 'other')
  const before = git(other, ['rev-parse', 'HEAD'])
  withEnv({
    GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: path.join(other, '.git'),
    GIT_INDEX_FILE: path.join(other, '.git', 'index'), GIT_AUTHOR_DATE: OLD_DATE, GIT_COMMITTER_DATE: OLD_DATE,
  }, () => {
    assert.equal(git(W, ['log', '-1', '--format=%s']), 'other', 'control')
    assert.equal(workGit(W, ['log', '-1', '--format=%s']), 'mine')
    assert.equal(workGit(W, ['rev-parse', '--git-dir']), path.join(W, '.git'))
    assert.equal(fs.realpathSync(workGit(W, ['rev-parse', '--show-toplevel'])), fs.realpathSync(W))
    fs.writeFileSync(path.join(W, 'new.txt'), 'new\n')
    workGit(W, ['add', '-A'])
    workGit(W, ['commit', '-q', '-m', 'lands in W'])
    assert.ok(Number(workGit(W, ['log', '-1', '--format=%ct'])) > 1600000000)
    // Pathspecs are literal.
    assert.equal(workGit(W, ['ls-files', '--', '*.txt']), '')
    assert.equal(workGit(W, ['ls-files', '--', 'new.txt']), 'new.txt')
    // Options.
    const blob = workGit(W, ['hash-object', '-w', '--stdin'], { input: RAW })
    assert.deepEqual(workGit(W, ['cat-file', 'blob', blob], { buffer: true }), RAW)
    const idx = path.join(tmp(t, 'tl-gitsafe-idx-'), 'index')
    workGit(W, ['read-tree', 'HEAD~1'], { indexFile: idx })
    assert.equal(workGit(W, ['ls-files'], { indexFile: idx }), 'mine.txt')
    assert.equal(workGit(W, ['ls-files']), 'mine.txt\nnew.txt')
    assert.equal(workGit(W, ['config', '--get-all', 'gc.auto'], { config: ['gc.auto=6700'] }), '0\n6700')
    assert.equal(workGit(W, ['var', 'GIT_COMMITTER_IDENT'], { env: { GIT_COMMITTER_DATE: '@1234567890 +0000' } }).endsWith(' 1234567890 +0000'), true)
    const file = path.join(tmp(t, 'tl-gitsafe-out-'), 'b')
    const fd = fs.openSync(file, 'w')
    try { assert.equal(workGit(W, ['cat-file', 'blob', blob], { outFd: fd }), '') } finally { fs.closeSync(fd) }
    assert.deepEqual(fs.readFileSync(file), RAW)
  })
  assert.equal(git(W, ['log', '-1', '--format=%s']), 'lands in W')
  assert.equal(git(other, ['rev-parse', 'HEAD']), before, 'the other repository is untouched')
  assert.equal(git(other, ['status', '--porcelain']), '')
  assert.throws(() => workGit(W, ['rev-parse', '--verify', 'refs/heads/none']),
    err => /Needed a single revision/.test(err.message) && err.status === 128 && typeof err.stderr === 'string')
})

test('a hostile global config leaves commit and diff working under workGit and runs nothing', PROC, t => {
  const W = repo(t, 'work')
  fs.writeFileSync(path.join(W, '.gitattributes'), '*.txt diff=hostile\n')
  git(W, ['add', '-A'])
  git(W, ['commit', '-q', '-m', 'attributes'])
  const h = tmp(t, 'tl-gitsafe-hostile-')
  const marker = path.join(h, 'ran')
  const script = (name, tail = 'exit 0') => {
    const file = path.join(h, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `#!/bin/sh\necho ${path.basename(name)} >> '${marker}'\n${tail}\n`)
    fs.chmodSync(file, 0o755)
    return file
  }
  script('hooks/pre-commit', 'exit 1')
  script('hooks/post-commit')
  script('hooks/reference-transaction')
  const cfg = path.join(h, 'gitconfig')
  fs.writeFileSync(cfg, [
    '[core]', `\thooksPath = ${path.join(h, 'hooks')}`, `\tfsmonitor = ${script('fsmonitor')}`,
    '[commit]', '\tgpgSign = true',
    '[tag]', '\tgpgSign = true',
    '[gpg]', `\tprogram = ${script('gpg', 'exit 1')}`,
    '[diff]', `\texternal = ${script('ext-diff')}`,
    '[diff "hostile"]', `\ttextconv = ${script('textconv', 'cat "$1"')}`,
    '',
  ].join('\n'))
  const ran = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : []

  fs.writeFileSync(path.join(W, 'work.txt'), 'changed\n')
  withEnv({ GIT_CONFIG_GLOBAL: cfg }, () => {
    // Controls: plain git runs each of them.
    git(W, ['status', '--porcelain'])
    assert.ok(ran().includes('fsmonitor'), 'control: fsmonitor')
    git(W, ['diff'])
    assert.ok(ran().includes('ext-diff'), 'control: external diff')
    git(W, ['log', '-p', '-1', 'HEAD~1'])
    assert.ok(ran().includes('textconv'), 'control: textconv')
    git(W, ['add', '-A'])
    assert.throws(() => git(W, ['commit', '-q', '-m', 'control']))
    assert.ok(ran().includes('pre-commit'), 'control: failing pre-commit hook')
    assert.throws(() => git(W, ['commit', '-q', '--no-verify', '-m', 'control']))
    assert.ok(ran().includes('gpg'), 'control: gpg signing')
    git(W, ['reset', '-q'])
    fs.rmSync(marker)

    assert.equal(workGit(W, ['config', '--get', 'diff.external']), path.join(h, 'ext-diff'), 'the hostile config is read')
    assert.equal(workGit(W, ['status', '--porcelain']), ' M work.txt')
    assert.match(workGit(W, ['diff']), /^\+changed$/m)
    assert.match(workGit(W, ['diff', 'HEAD']), /^\+changed$/m)
    assert.match(workGit(W, ['log', '-p', '-1', 'HEAD~1']), /^\+work$/m)
    assert.match(workGit(W, ['show', 'HEAD~1']), /^\+work$/m)
    workGit(W, ['add', '-A'])
    workGit(W, ['commit', '-q', '-m', 'through workGit'])
    workGit(W, ['tag', '-a', '-m', 'annotated', 't1'])
    assert.equal(workGit(W, ['log', '-1', '--format=%s']), 'through workGit')
    assert.doesNotMatch(workGit(W, ['cat-file', 'commit', 'HEAD']), /gpgsig/)
    assert.doesNotMatch(workGit(W, ['cat-file', 'tag', 't1']), /BEGIN PGP/)
    assert.deepEqual(ran(), [], 'nothing from the hostile config ran')
  })
})

test('workGitRun never throws: a non-zero exit, a refusal and a timeout come back as fields', PROC, t => {
  const W = repo(t, 'work')
  fs.writeFileSync(path.join(W, 'work.txt'), 'changed\n')
  const dirty = workGitRun(W, ['diff', '--quiet'])
  assert.deepEqual({ status: dirty.status, signal: dirty.signal, stdout: dirty.stdout }, { status: 1, signal: null, stdout: '' })
  const ok = workGitRun(W, ['status', '--porcelain'])
  assert.deepEqual({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }, { status: 0, stdout: ' M work.txt', stderr: '' })
  const bad = workGitRun(W, ['rev-parse', '--verify', 'nope'])
  assert.equal(bad.status, 128)
  assert.match(bad.stderr, /Needed a single revision/)
  const raw = workGitRun(W, ['cat-file', 'blob', workGit(W, ['hash-object', '-w', '--stdin'], { input: RAW })], { buffer: true })
  assert.deepEqual(raw.stdout, RAW)

  const fifo = mkfifo(t)
  const slow = workGitRun(W, ['hash-object', fifo], { timeoutMs: 300 })
  assert.equal(slow.status, null)
  assert.equal(slow.code, 'TIMEOUT')
  assert.equal(slow.signal, 'SIGTERM')
  assert.throws(() => workGit(W, ['hash-object', fifo], { timeoutMs: 300 }), err => err.code === 'TIMEOUT')
  noProcessWith(fifo)
})

test('cloneRepo makes a full clone with no hooks/ and no info/ from an empty template, and runs the fixed command', PROC, t => {
  const src = repo(t, 'one')
  commit(src, 'two')
  git(src, ['branch', 'feature', 'HEAD~1'])
  git(src, ['tag', '-a', '-m', 'v1', 'v1'])
  const template = tmp(t, 'tl-gitsafe-tmpl-')
  const dest = path.join(tmp(t, 'tl-gitsafe-dest-'), 'clone')
  fs.mkdirSync(dest, { mode: 0o700 })

  // A hostile global hooks path: plain git clone runs its reference-transaction hook.
  const marker = path.join(tmp(t, 'tl-gitsafe-marker-'), 'ran')
  const hooks = tmp(t, 'tl-gitsafe-hooks-')
  for (const h of ['reference-transaction', 'post-checkout']) markerScript(path.join(hooks, h), marker)
  const cfg = path.join(hooks, 'gitconfig')
  fs.writeFileSync(cfg, `[core]\n\thooksPath = ${hooks}\n`)
  withEnv({ GIT_CONFIG_GLOBAL: cfg }, () => {
    const control = path.join(tmp(t, 'tl-gitsafe-ctl-'), 'c')
    git(path.dirname(control), ['clone', '-q', '--no-local', '--no-checkout', `--template=${template}`, '--', src, control])
    assert.ok(fs.existsSync(marker), 'control: plain clone runs a hook from the global hooks path')
    fs.rmSync(marker)
    assert.equal(cloneRepo(src, dest, { templateDir: template }), '')
  })
  assert.equal(fs.existsSync(marker), false, 'no hook ran under cloneRepo')

  const gd = path.join(dest, '.git')
  assert.deepEqual(fs.readdirSync(dest), ['.git'], 'nothing is checked out')
  assert.equal(fs.existsSync(path.join(gd, 'hooks')), false, 'no hooks/ directory')
  assert.equal(fs.existsSync(path.join(gd, 'info')), false, 'no info/ directory')
  assert.equal(fs.existsSync(path.join(gd, 'objects', 'info', 'alternates')), false, 'no alternates')
  assert.equal(fs.existsSync(path.join(gd, 'shallow')), false, 'not shallow')
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700, 'the caller\'s mode is kept')
  const refs = d => git(d, ['for-each-ref', '--format=%(objectname) %(refname)'])
  const srcHeads = refs(src).split('\n').filter(l => l.includes(' refs/heads/'))
    .map(l => l.replace(' refs/heads/', ' refs/remotes/origin/'))
  const destRefs = refs(dest).split('\n')
  for (const l of srcHeads) assert.ok(destRefs.includes(l), `${l} is in the clone`)
  assert.ok(destRefs.includes(refs(src).split('\n').find(l => l.endsWith(' refs/tags/v1'))))
  const objects = d => git(d, ['rev-list', '--objects', '--all']).split('\n').map(l => l.split(' ')[0]).sort()
  assert.deepEqual(objects(dest), objects(src), 'every object is in the clone')
  const counts = git(dest, ['count-objects', '-v'])
  assert.match(counts, /^count: 0$/m, 'objects were copied as a pack, not hardlinked loose files')
  git(dest, ['fsck', '--full', '--no-dangling'])

  // The exact command line.
  const fake = fakeGit(t)
  const d2 = path.join(tmp(t, 'tl-gitsafe-dest-'), 'c2')
  const seen = fake.parse(fake.run(() => cloneRepo(src, d2, { templateDir: template })))
  assert.deepEqual(seen.args, [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
    '-c', 'protocol.file.allow=always', '-c', 'clone.defaultRemoteName=origin', 'clone', '--no-local', '--no-checkout',
    '--no-recurse-submodules', `--template=${template}`, '-q', '--', src, d2,
  ])
  // The files ref backend whatever the owner's init.defaultRefFormat says (F2).
  assert.equal(seen.env.GIT_DEFAULT_REF_FORMAT, 'files')
  assert.throws(() => cloneRepo(src, d2, {}), /templateDir/)
})

test('cloneRepo allows only the file transport and runs no inherited ssh command', PROC, t => {
  const marker = path.join(tmp(t, 'tl-gitsafe-marker-'), 'ran')
  const ssh = path.join(tmp(t, 'tl-gitsafe-ssh-'), 'ssh-cmd')
  fs.writeFileSync(ssh, `#!/bin/sh\necho ssh >> '${marker}'\nexit 1\n`)
  fs.chmodSync(ssh, 0o755)
  const template = tmp(t, 'tl-gitsafe-tmpl-')
  const base = tmp(t, 'tl-gitsafe-dest-')
  withEnv({ GIT_SSH_COMMAND: ssh }, () => {
    const control = path.join(base, 'control')
    assert.throws(() => git(base, ['clone', '-q', 'ssh://127.0.0.1/x.git', control]))
    assert.ok(fs.existsSync(marker), 'control: plain git runs the inherited ssh command')
    fs.rmSync(marker)
    const dest = path.join(base, 'd')
    fs.mkdirSync(dest, { mode: 0o700 })
    assert.throws(() => cloneRepo('ssh://127.0.0.1/x.git', dest, { templateDir: template }),
      err => /transport 'ssh' not allowed/.test(err.message) && err.status === 128)
  })
  assert.equal(fs.existsSync(marker), false)
})

test('cloneRepo honours timeoutMs', PROC, t => {
  const src = repo(t)
  const dest = path.join(tmp(t, 'tl-gitsafe-dest-'), 'd')
  fs.mkdirSync(dest, { mode: 0o700 })
  assert.throws(() => cloneRepo(src, dest, { templateDir: tmp(t, 'tl-gitsafe-tmpl-'), timeoutMs: 1 }),
    err => err.code === 'TIMEOUT')
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

// Loose objects under a repository's object store.
const looseCount = repoDir => {
  const objects = path.join(repoDir, '.git', 'objects')
  let n = 0
  for (const d of fs.readdirSync(objects)) if (/^[0-9a-f]{2}$/.test(d)) n += fs.readdirSync(path.join(objects, d)).length
  return n
}

test('workGit refuses a clone whose git storage paths are symlinks or of the wrong kind, and spawns nothing (Cg1#1)', PROC, t => {
  const other = repo(t, 'other')
  git(other, ['pack-refs', '--all'])
  assert.deepEqual(STORAGE_DIRS, ['objects', 'objects/pack', 'objects/info', 'refs', 'refs/heads', 'refs/tags', 'logs'])
  assert.deepEqual(STORAGE_FILES, ['HEAD', 'index', 'packed-refs', 'config'])
  // Control: plain git writes a new object through a symlinked object store into the other repository.
  const control = repo(t, 'control')
  fs.renameSync(path.join(control, '.git', 'objects'), path.join(control, '.git', 'objects.real'))
  fs.symlinkSync(path.join(other, '.git', 'objects'), path.join(control, '.git', 'objects'))
  const before = looseCount(other)
  execFileSync('git', ['-C', control, 'hash-object', '-w', '--stdin'], { input: 'through the link\n', env: process.env })
  assert.equal(looseCount(other), before + 1, 'plain git writes into the repository the link names')

  const cases = [...STORAGE_DIRS, ...STORAGE_FILES]
  for (const rel of cases) {
    const W = repo(t, 'work')
    git(W, ['pack-refs', '--all'])
    const p = path.join(W, '.git', rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.rmSync(p, { recursive: true, force: true })
    fs.symlinkSync(path.join(other, '.git', rel), p)
    const fake = fakeGit(t)
    fake.run(() => {
      assert.throws(() => workGit(W, ['status']),
        err => err.code === 'CLONE_INVALID' && err.message === `clone-invalid: ${W}/.git/${rel} is a symlink`, rel)
      const res = workGitRun(W, ['status'])
      assert.equal(res.code, 'CLONE_INVALID', rel)
      assert.equal(res.status, null, rel)
    })
    assert.equal(fs.existsSync(fake.marker), false, `${rel}: git was never spawned`)
  }

  // A symlinked loose-object directory inside a real objects directory.
  const W = repo(t, 'loose')
  fs.mkdirSync(path.join(other, '.git', 'objects', 'ab'), { recursive: true })
  fs.rmSync(path.join(W, '.git', 'objects', 'ab'), { recursive: true, force: true })
  fs.symlinkSync(path.join(other, '.git', 'objects', 'ab'), path.join(W, '.git', 'objects', 'ab'))
  assert.throws(() => workGit(W, ['hash-object', '-w', '--stdin'], { input: 'x' }),
    err => err.code === 'CLONE_INVALID' && err.message === `clone-invalid: ${W}/.git/objects/ab is a symlink`)

  // The wrong kind of a real entry: a directory where the index belongs, a file where refs belongs.
  const W2 = repo(t, 'kinds')
  fs.rmSync(path.join(W2, '.git', 'index'))
  fs.mkdirSync(path.join(W2, '.git', 'index'))
  assert.throws(() => workGit(W2, ['status']), err => err.code === 'CLONE_INVALID' && err.message === `clone-invalid: ${W2}/.git/index is a directory`)
  const W3 = repo(t, 'kinds2')
  fs.rmSync(path.join(W3, '.git', 'refs', 'tags'), { recursive: true })
  fs.writeFileSync(path.join(W3, '.git', 'refs', 'tags'), '')
  assert.throws(() => workGit(W3, ['status']), err => err.code === 'CLONE_INVALID' && err.message === `clone-invalid: ${W3}/.git/refs/tags is a regular file`)
  // Absent optional paths are fine: no packed-refs, no logs.
  const W4 = repo(t, 'bare-ish')
  fs.rmSync(path.join(W4, '.git', 'logs'), { recursive: true, force: true })
  fs.rmSync(path.join(W4, '.git', 'packed-refs'), { force: true })
  assert.equal(workGit(W4, ['log', '-1', '--format=%s']), 'bare-ish')
})

test('through workGit, nothing is written into a repository a symlinked object store names', PROC, t => {
  const other = repo(t, 'other')
  const W = repo(t, 'work')
  fs.renameSync(path.join(W, '.git', 'objects'), path.join(W, '.git', 'objects.real'))
  fs.symlinkSync(path.join(other, '.git', 'objects'), path.join(W, '.git', 'objects'))
  const before = looseCount(other)
  assert.throws(() => workGit(W, ['hash-object', '-w', '--stdin'], { input: 'a delegate never gets this into <P>\n' }), err => err.code === 'CLONE_INVALID')
  assert.equal(looseCount(other), before)
})

// A stand-in git first on PATH that drops GIT_ATTR_SOURCE before running the real git, as a git
// older than the variable does, and counts its runs.
const oldGit = t => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const dir = tmp(t, 'tl-gitsafe-oldgit-')
  const marker = path.join(dir, 'ran')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), ['#!/bin/sh', `echo ran >> '${marker}'`, 'unset GIT_ATTR_SOURCE', `exec '${real}' "$@"`, ''].join('\n'))
  fs.chmodSync(path.join(bin, 'git'), 0o755)
  const runs = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0)
  return { runs, run: fn => withEnv({ PATH: `${bin}:${process.env.PATH}` }, fn) }
}

test('the GIT_ATTR_SOURCE feature test passes on this git and refuses infra git-too-old on a git that ignores the variable, once per PATH (R24)', PROC, t => {
  const W = repo(t, 'probe')
  assert.equal(GIT_TOO_OLD, 'git-too-old: needs git 2.40 or newer')
  assert.equal(attrSourceWorks(W), true)
  assert.doesNotThrow(() => assertAttrSource(W))
  const old = oldGit(t)
  old.run(() => {
    assert.equal(attrSourceWorks(W), false)
    const after = old.runs()
    assert.ok(after >= 2, `the probe ran git (${after} runs)`)
    assert.throws(() => assertAttrSource(W), err => err.code === 'REFUSED' && err.state === 'infra' && err.detail === GIT_TOO_OLD && err.message === GIT_TOO_OLD)
    assert.equal(attrSourceWorks(W), false)
    assert.equal(old.runs(), after, 'probed once per process and PATH')
  })
  assert.equal(attrSourceWorks(W), true, 'the real git keeps its own answer')
})
