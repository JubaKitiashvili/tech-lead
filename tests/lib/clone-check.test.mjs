// tests/lib/clone-check.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { cloneRepo, workGit } from '../../scripts/lib/git-safe.mjs'
import {
  CONFIG_KEYS, DATED_BRANCH_RE, SPECIAL_FILES, checkClone, cloneMeta, refsSnapshot,
} from '../../scripts/lib/clone-check.mjs'

// Keep the user's git config and hooks out of the fixtures; workGit copies this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})

const PROC = { timeout: 90000 }
const BRANCH = 'tl/loop/2026-10-02'

// Plain git, the delegate's view: no overrides, whatever the repository's config says.
const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// <P>: main with two commits, a tag, a non-dated branch and an older dated branch.
const project = root => {
  const P = path.join(root, 'P')
  fs.mkdirSync(P)
  git(P, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, ['add', '-A'])
  git(P, ['commit', '-q', '-m', 'a'])
  git(P, ['tag', 'v1'])
  git(P, ['branch', 'feature'])
  git(P, ['branch', 'tl/loop/2026-10-01'])
  fs.writeFileSync(path.join(P, 'b.txt'), 'b\n')
  git(P, ['add', '-A'])
  git(P, ['commit', '-q', '-m', 'b'])
  return P
}

// The clone the way loop-clone makes it (brief 13.4): cloneRepo with an empty template, then
// remote.origin and every branch.* section removed, refs/remotes/origin/HEAD deleted, today's
// dated branch switched to with --no-track, the non-dated refs/heads/* deleted. The loop's
// own refs (base, a retired tip) and an adopted older dated branch are added the way refresh
// and adoption add them.
const makeClone = t => {
  const root = tmp(t, 'tl-clonecheck-')
  const P = project(root)
  const template = path.join(root, 'empty-template')
  fs.mkdirSync(template, { mode: 0o700 })
  const W = path.join(root, 'W')
  fs.mkdirSync(W, { mode: 0o700 })
  cloneRepo(P, W, { templateDir: template })
  workGit(W, ['config', '--remove-section', 'remote.origin'])
  const keys = workGit(W, ['config', '--file', path.join(W, '.git', 'config'), '--name-only', '--list']).split('\n')
  const sections = new Set(keys.filter(k => k.startsWith('branch.')).map(k => k.slice(0, k.lastIndexOf('.'))))
  for (const s of sections) workGit(W, ['config', '--remove-section', s])
  workGit(W, ['update-ref', '-d', '--no-deref', 'refs/remotes/origin/HEAD'])
  workGit(W, ['update-ref', 'refs/tech-lead/base', 'refs/remotes/origin/main'])
  workGit(W, ['switch', '-q', '--no-track', '-c', BRANCH, 'refs/tech-lead/base'])
  workGit(W, ['update-ref', 'refs/heads/tl/loop/2026-10-01', 'refs/remotes/origin/tl/loop/2026-10-01', '0'.repeat(40)])
  workGit(W, ['update-ref', 'refs/tech-lead/retired/tl/loop/2026-09-30', 'refs/remotes/origin/feature'])
  const heads = workGit(W, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean)
  for (const ref of heads) if (!DATED_BRANCH_RE.test(ref)) workGit(W, ['update-ref', '-d', ref])
  return { root, P, W }
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// Every path under dir with its kind and bytes, for a byte-identical comparison.
const snapshot = dir => {
  const out = {}
  const walk = rel => {
    const abs = path.join(dir, rel)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) {
      out[rel || '.'] = 'dir'
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name))
    } else if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`
    else out[rel] = `file:${st.mode}:${fs.readFileSync(abs).toString('base64')}`
  }
  walk('')
  return out
}

test('a clone made the way loop-clone makes it has no problems', PROC, t => {
  const { W } = makeClone(t)
  assert.deepEqual(checkClone(W), { problems: [] })
  // The fixture is the realistic one: the tracked files are checked out and the status is clean.
  assert.equal(fs.readFileSync(path.join(W, 'b.txt'), 'utf8'), 'b\n')
  assert.equal(git(W, ['status', '--porcelain']), '')
  assert.equal(git(W, ['symbolic-ref', 'HEAD']), `refs/heads/${BRANCH}`)
})

test('the exported lists are the brief\'s', () => {
  assert.deepEqual([...SPECIAL_FILES], ['commondir', 'gitdir', 'config.worktree', 'worktrees', 'modules', 'shallow',
    'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates'])
  assert.deepEqual([...CONFIG_KEYS].sort(), ['core.bare', 'core.filemode', 'core.hookspath', 'core.ignorecase',
    'core.logallrefupdates', 'core.precomposeunicode', 'core.repositoryformatversion', 'core.symlinks',
    'extensions.objectformat', 'extensions.refstorage'])
  for (const ok of ['refs/heads/tl/2026-10-02', 'refs/heads/a/b.c/x_y-z/2026-01-31']) assert.ok(DATED_BRANCH_RE.test(ok), ok)
  for (const bad of ['refs/heads/2026-10-02', 'refs/heads/main', 'refs/heads/tl/2026-13-02', 'refs/heads/tl/2026-10-02x',
    'refs/heads/tl/2026-10-00', 'refs/heads/.x/2026-10-02', 'refs/heads//2026-10-02', 'refs/tags/tl/2026-10-02']) {
    assert.ok(!DATED_BRANCH_RE.test(bad), bad)
  }
})

// Each tamper case: what a delegate (or anything else in <W>) could do, and the problem it gives.
const TAMPER = [
  ['core.fsmonitor set', W => git(W, ['config', 'core.fsmonitor', 'true']), /^config key not allowed: core\.fsmonitor$/],
  ['a remote.x.url', W => git(W, ['config', 'remote.x.url', '/elsewhere']), /^config key not allowed: remote\.x\.url$/],
  ['an include.path', W => git(W, ['config', 'include.path', '/dev/null']), /^config key not allowed: include\.path$/],
  ['an includeIf path', W => git(W, ['config', 'includeIf.gitdir:/.path', '/dev/null']), /^config key not allowed: includeif\.gitdir:\/\.path$/],
  ['a url.*.insteadOf', W => git(W, ['config', 'url./elsewhere/.insteadOf', '/here/']), /^config key not allowed: url\.\/elsewhere\/\.insteadof$/],
  ['a filter.*', W => git(W, ['config', 'filter.evil.clean', 'touch pwned']), /^config key not allowed: filter\.evil\.clean$/],
  ['core.bare true', W => git(W, ['config', 'core.bare', 'true']), /^config core\.bare is not false$/],
  ['extensions.refstorage reftable', W => git(W, ['config', 'extensions.refstorage', 'reftable']), /^config extensions\.refstorage is not files$/],
  ['an objects/info/alternates file', W => write(path.join(W, '.git/objects/info/alternates'), '/elsewhere/objects\n'), /^\.git\/objects\/info\/alternates exists$/],
  ['an objects/info/http-alternates file', W => write(path.join(W, '.git/objects/info/http-alternates'), 'http://x/\n'), /^\.git\/objects\/info\/http-alternates exists$/],
  ['an info/grafts file', W => write(path.join(W, '.git/info/grafts'), `${git(W, ['rev-parse', 'HEAD'])}\n`), /^\.git\/info\/grafts exists$/],
  ['an info/exclude with content', W => write(path.join(W, '.git/info/exclude'), 'secret.txt\n'), /^\.git\/info is not empty: exclude$/],
  ['an info/attributes file', W => write(path.join(W, '.git/info/attributes'), '* filter=evil\n'), /^\.git\/info is not empty: attributes$/],
  ['a config.worktree file', W => write(path.join(W, '.git/config.worktree'), '[core]\n\tfsmonitor = true\n'), /^\.git\/config\.worktree exists$/],
  ['a commondir file', W => write(path.join(W, '.git/commondir'), '../../elsewhere/.git\n'), /^\.git\/commondir exists$/],
  ['a gitdir file', W => write(path.join(W, '.git/gitdir'), '/elsewhere/.git\n'), /^\.git\/gitdir exists$/],
  ['a worktrees/ directory', W => fs.mkdirSync(path.join(W, '.git/worktrees/x'), { recursive: true }), /^\.git\/worktrees exists$/],
  ['a modules/ directory', W => fs.mkdirSync(path.join(W, '.git/modules/x'), { recursive: true }), /^\.git\/modules exists$/],
  ['a shallow file', W => write(path.join(W, '.git/shallow'), `${git(W, ['rev-parse', 'HEAD'])}\n`), /^\.git\/shallow exists$/],
  ['a gitfile .git', W => {
    fs.renameSync(path.join(W, '.git'), path.join(W, '.git-real'))
    fs.writeFileSync(path.join(W, '.git'), `gitdir: ${path.join(W, '.git-real')}\n`)
  }, /^\.git is not a real directory \(a file\)$/],
  ['a symlinked .git', W => {
    fs.renameSync(path.join(W, '.git'), path.join(W, '.git-real'))
    fs.symlinkSync(path.join(W, '.git-real'), path.join(W, '.git'))
  }, /^\.git is not a real directory \(a symlink\)$/],
  ['a missing .git', W => fs.rmSync(path.join(W, '.git'), { recursive: true, force: true }), /^\.git is not a real directory \(missing\)$/],
  ['a symlinked .git/config', W => {
    fs.renameSync(path.join(W, '.git/config'), path.join(W, 'config-real'))
    fs.symlinkSync(path.join(W, 'config-real'), path.join(W, '.git/config'))
  }, /^\.git\/config is not a regular file \(a symlink\)$/],
  ['refs/stash', W => git(W, ['update-ref', 'refs/stash', 'HEAD']), /^ref not allowed: refs\/stash$/],
  ['an extra non-dated branch', W => git(W, ['branch', 'feature']), /^ref not allowed: refs\/heads\/feature$/],
  ['a dated name outside refs/heads', W => git(W, ['update-ref', 'refs/notes/tl/2026-10-02', 'HEAD']), /^ref not allowed: refs\/notes\/tl\/2026-10-02$/],
  ['a replace ref', W => git(W, ['update-ref', `refs/replace/${git(W, ['rev-parse', 'HEAD'])}`, 'HEAD~1']), /^ref not allowed: refs\/replace\//],
  ['a leftover adopt ref', W => git(W, ['update-ref', 'refs/tech-lead/adopt/tl/loop/2026-10-01', 'HEAD']), /^ref not allowed: refs\/tech-lead\/adopt\//],
  ['a ref under refs/tech-lead/base/', W => {
    git(W, ['update-ref', '-d', 'refs/tech-lead/base'])
    git(W, ['update-ref', 'refs/tech-lead/base/x', 'HEAD'])
  }, /^ref not allowed: refs\/tech-lead\/base\/x$/],
  ['a broken ref file', W => write(path.join(W, '.git/refs/heads/broken'), 'zzz\n'), /^refs: .*refs\/heads\/broken/],
  ['a detached HEAD', W => git(W, ['switch', '-q', '--detach']), /^HEAD is detached$/],
  ['HEAD on a non-dated branch', W => git(W, ['symbolic-ref', 'HEAD', 'refs/heads/main']), /^HEAD is not a dated branch: refs\/heads\/main$/],
]

for (const [name, tamper, expected] of TAMPER) {
  test(`tamper: ${name} is a problem`, PROC, t => {
    const { W } = makeClone(t)
    tamper(W)
    const { problems } = checkClone(W)
    assert.ok(problems.some(p => expected.test(p)), `expected ${expected} in ${JSON.stringify(problems)}`)
  })
}

// Sets environment variables for the duration of fn, then restores the previous values.
const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try { return fn() } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}
// Every git trace variable a caller may carry: each writes to stderr from every git call.
const TRACE = {
  GIT_TRACE: '1', GIT_TRACE2: '1', GIT_TRACE2_EVENT: '1', GIT_TRACE2_PERF: '1', GIT_TRACE_PACKET: '1', GIT_TRACE_SETUP: '1',
  GIT_TRACE_PERFORMANCE: '1', GIT_TRACE_REFS: '1',
}

test('an inherited GIT_TRACE* is no problem for checkClone, and cloneMeta and refsSnapshot read the same', PROC, t => {
  const { W } = makeClone(t)
  const meta = cloneMeta(W)
  const refs = refsSnapshot(W)
  withEnv(TRACE, () => {
    // Control: plain git traces to stderr under this environment.
    const ctl = spawnSync('git', ['-C', W, 'for-each-ref'], { encoding: 'utf8', env: process.env })
    assert.match(ctl.stderr, /trace: built-in: git for-each-ref/)
    assert.deepEqual(checkClone(W), { problems: [] })
    assert.equal(cloneMeta(W), meta)
    assert.deepEqual(refsSnapshot(W), refs)
  })
})

// A stand-in `git` first on PATH: it runs the real git and writes lines that are not git
// messages to stderr before and after git's own, the way a wrapper around git can. Unlike
// trace2 from the config (git-safe pins its targets off), no environment the helpers set
// removes them, so they keep checkClone's warning filter under test.
const noisyGit = (t, root) => {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = path.join(root, 'noisy-bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    "echo '12:00:00.000000 git.c:463 cmd_name wrapper (wrapper)' >&2",
    `'${real}' "$@"`,
    's=$?',
    "echo 'note: a wrapper line that is not a git message' >&2",
    'exit $s',
    '',
  ].join('\n'))
  fs.chmodSync(path.join(bin, 'git'), 0o755)
  return `${bin}:${process.env.PATH}`
}

test('stderr lines that are not git warnings (a wrapper around git, trace2 from the global config) are no ref problem; a broken ref still is', PROC, t => {
  const { root, W } = makeClone(t)
  // trace2 targets set in the global config write to stderr from every plain git call;
  // git-safe pins them off. The wrapper's lines reach every helper git call.
  const cfg = path.join(root, 'trace2.gitconfig')
  fs.writeFileSync(cfg, '[trace2]\n\tnormalTarget = 2\n\tperfTarget = 2\n')
  withEnv({ GIT_CONFIG_GLOBAL: cfg, PATH: noisyGit(t, root) }, () => {
    const ctl = spawnSync('git', ['-C', W, 'for-each-ref'], { encoding: 'utf8', env: process.env })
    assert.match(ctl.stderr, /cmd_name for-each-ref/, 'control: trace2 lines on stderr')
    assert.match(ctl.stderr, /cmd_name wrapper/, 'control: the wrapper\'s first line on stderr')
    assert.match(ctl.stderr, /^note: a wrapper line/m, 'control: the wrapper\'s last line on stderr')
    assert.deepEqual(checkClone(W), { problems: [] })
    write(path.join(W, '.git/refs/heads/broken'), 'zzz\n')
    git(W, ['update-ref', 'refs/heads/ok', 'HEAD'])
    fs.copyFileSync(path.join(W, '.git/refs/heads/ok'), path.join(W, '.git/refs/heads/a..b'))
    fs.rmSync(path.join(W, '.git/refs/heads/ok'))
    const { problems } = checkClone(W)
    assert.deepEqual(problems.filter(p => p.startsWith('refs: ')), [
      'refs: warning: ignoring ref with broken name refs/heads/a..b',
      'refs: warning: ignoring broken ref refs/heads/broken',
    ])
    assert.ok(!problems.some(p => /cmd_name|version|trace|wrapper/.test(p)), JSON.stringify(problems))
  })
})

test('a gitfile .git stops the check at that problem; cloneMeta and refsSnapshot refuse clone-invalid', PROC, t => {
  const { W } = makeClone(t)
  fs.renameSync(path.join(W, '.git'), path.join(W, '.git-real'))
  fs.writeFileSync(path.join(W, '.git'), `gitdir: ${path.join(W, '.git-real')}\n`)
  assert.deepEqual(checkClone(W), { problems: ['.git is not a real directory (a file)'] })
  assert.throws(() => cloneMeta(W), e => e.code === 'CLONE_INVALID' && /^clone-invalid: /.test(e.message))
  assert.throws(() => refsSnapshot(W), e => e.code === 'CLONE_INVALID')
})

test('a config git cannot parse is a problem, and the ref and HEAD checks fail closed', PROC, t => {
  const { W } = makeClone(t)
  const m0 = cloneMeta(W)
  fs.appendFileSync(path.join(W, '.git/config'), '[core\n')
  const { problems } = checkClone(W)
  assert.equal(problems.length, 3, JSON.stringify(problems))
  assert.match(problems[0], /^config unreadable: .*bad config line/)
  assert.match(problems[1], /^refs unreadable: /)
  assert.match(problems[2], /^HEAD unreadable: /)
  const m1 = cloneMeta(W)
  assert.notEqual(m1, m0, 'an unparsable config still gives a meta, from its bytes')
  fs.appendFileSync(path.join(W, '.git/config'), '#\n')
  assert.notEqual(cloneMeta(W), m1, 'and any byte change to it changes the meta')
})

test('a husky-style install is allowed: core.hookspath and files in .git/hooks', PROC, t => {
  const { W } = makeClone(t)
  const before = cloneMeta(W)
  // husky 9: a hooks directory in the work tree and core.hooksPath pointing at it.
  write(path.join(W, '.husky/_/pre-commit'), '#!/bin/sh\nexit 0\n')
  write(path.join(W, '.husky/_/h'), '#!/bin/sh\nexit 0\n')
  git(W, ['config', 'core.hooksPath', '.husky/_'])
  // pre-commit and lefthook write into .git/hooks itself.
  write(path.join(W, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n')
  fs.chmodSync(path.join(W, '.git/hooks/pre-commit'), 0o755)
  assert.deepEqual(checkClone(W), { problems: [] })
  assert.equal(cloneMeta(W), before, 'cloneMeta ignores core.hookspath and .git/hooks')
  git(W, ['config', 'core.hooksPath', '.husky/other'])
  assert.equal(cloneMeta(W), before, 'a changed core.hookspath value is ignored too')
  git(W, ['config', '--unset', 'core.hooksPath'])
  assert.equal(cloneMeta(W), before, 'and so is its removal')
})

test('an empty .git/info directory is allowed and leaves cloneMeta unchanged', PROC, t => {
  const { W } = makeClone(t)
  const before = cloneMeta(W)
  fs.mkdirSync(path.join(W, '.git/info'))
  assert.deepEqual(checkClone(W), { problems: [] })
  assert.equal(cloneMeta(W), before)
})

test('cloneMeta is a stable sha256 and changes when any other config key changes', PROC, t => {
  const { W } = makeClone(t)
  const m0 = cloneMeta(W)
  assert.match(m0, /^[0-9a-f]{64}$/)
  assert.equal(cloneMeta(W), m0)
  git(W, ['config', 'core.logallrefupdates', 'false'])
  const m1 = cloneMeta(W)
  assert.notEqual(m1, m0, 'a changed value of an allowed key')
  git(W, ['config', 'user.name', 'someone'])
  const m2 = cloneMeta(W)
  assert.notEqual(m2, m1, 'an added key')
  git(W, ['config', '--unset', 'user.name'])
  git(W, ['config', 'core.logallrefupdates', 'true'])
  assert.equal(cloneMeta(W), m0, 'back to the same config, back to the same meta')
  git(W, ['config', 'core.fsmonitor', 'false'])
  assert.notEqual(cloneMeta(W), m0, 'a disallowed key even with a harmless value')
})

test('cloneMeta changes with the .git/info listing and with each forbidden special file', PROC, t => {
  const { W } = makeClone(t)
  const m0 = cloneMeta(W)
  write(path.join(W, '.git/info/exclude'), '')
  const m1 = cloneMeta(W)
  assert.notEqual(m1, m0, 'an empty exclude file is an entry in the listing')
  fs.writeFileSync(path.join(W, '.git/info/exclude'), 'x\n')
  assert.notEqual(cloneMeta(W), m1, 'an entry whose bytes change')
  fs.rmSync(path.join(W, '.git/info'), { recursive: true })
  assert.equal(cloneMeta(W), m0)
  const seen = new Set([m0])
  for (const name of SPECIAL_FILES) {
    if (name === 'info/grafts') continue // covered by the listing above
    const file = path.join(W, '.git', name)
    write(file, 'x\n')
    const m = cloneMeta(W)
    assert.ok(!seen.has(m), `${name} changes cloneMeta`)
    seen.add(m)
    fs.rmSync(file)
    assert.equal(cloneMeta(W), m0, `${name} removed`)
  }
})

test('refsSnapshot lists every ref with its object id, allowed or not', PROC, t => {
  const { W } = makeClone(t)
  const head = git(W, ['rev-parse', 'HEAD'])
  const older = git(W, ['rev-parse', 'refs/heads/tl/loop/2026-10-01'])
  const tag = git(W, ['rev-parse', 'refs/tags/v1'])
  const { refs } = refsSnapshot(W)
  assert.deepEqual(refs, {
    [`refs/heads/${BRANCH}`]: head,
    'refs/heads/tl/loop/2026-10-01': older,
    'refs/remotes/origin/feature': older,
    'refs/remotes/origin/main': head,
    'refs/remotes/origin/tl/loop/2026-10-01': older,
    'refs/tags/v1': tag,
    'refs/tech-lead/base': head,
    'refs/tech-lead/retired/tl/loop/2026-09-30': older,
  })
  assert.equal(Object.getPrototypeOf(refs), Object.prototype, 'a plain object, so a JSON round trip compares equal')
  git(W, ['update-ref', 'refs/stash', 'HEAD~1'])
  git(W, ['pack-refs', '--all'])
  assert.equal(refsSnapshot(W).refs['refs/stash'], older, 'packed refs are listed too')
})

test('the checks are read-only and run nothing a hostile config names', PROC, t => {
  const { W, root } = makeClone(t)
  const marker = path.join(root, 'ran')
  const script = path.join(root, 'mark.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`)
  fs.chmodSync(script, 0o755)
  for (const h of ['pre-commit', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) {
    fs.mkdirSync(path.join(W, '.git/hooks'), { recursive: true })
    fs.copyFileSync(script, path.join(W, '.git/hooks', h))
    fs.chmodSync(path.join(W, '.git/hooks', h), 0o755)
  }
  git(W, ['config', 'core.fsmonitor', script])
  git(W, ['config', 'core.pager', script])
  git(W, ['config', 'diff.external', script])
  git(W, ['config', 'core.sshCommand', script])
  const before = snapshot(path.join(W, '.git'))
  const { problems } = checkClone(W)
  assert.ok(problems.includes('config key not allowed: core.fsmonitor'), JSON.stringify(problems))
  cloneMeta(W)
  refsSnapshot(W)
  assert.equal(fs.existsSync(marker), false, 'nothing ran')
  assert.deepEqual(snapshot(path.join(W, '.git')), before, '.git is byte-identical')
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

const lnk = (W, rel, target) => {
  const p = path.join(W, '.git', rel)
  fs.rmSync(p, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.symlinkSync(target, p)
}

test('a symlink in a git storage path is a problem: objects and each of its subdirectories, refs, logs, packed-refs, index, HEAD (Cg1#1, Cg3#2)', PROC, t => {
  const cases = [
    ['objects', P => path.join(P, '.git', 'objects'), '.git/objects is a symlink'],
    ['objects/pack', P => path.join(P, '.git', 'objects', 'pack'), '.git/objects/pack is a symlink'],
    ['objects/info', P => path.join(P, '.git', 'objects', 'info'), '.git/objects/info is a symlink'],
    ['objects/ab', P => { fs.mkdirSync(path.join(P, '.git', 'objects', 'ab'), { recursive: true }); return path.join(P, '.git', 'objects', 'ab') }, '.git/objects/ab is a symlink'],
    ['refs', P => path.join(P, '.git', 'refs'), '.git/refs is a symlink'],
    ['refs/heads/tl', P => path.join(P, '.git', 'refs', 'heads', 'tl'), '.git/refs/heads/tl is a symlink'],
    ['logs', P => path.join(P, '.git', 'logs'), '.git/logs is a symlink'],
    ['logs/HEAD', P => path.join(P, '.git', 'logs', 'HEAD'), '.git/logs/HEAD is a symlink'],
    ['packed-refs', P => { git(P, ['pack-refs', '--all']); return path.join(P, '.git', 'packed-refs') }, '.git/packed-refs is a symlink'],
    ['index', P => path.join(P, '.git', 'index'), '.git/index is a symlink'],
    ['HEAD', P => path.join(P, '.git', 'HEAD'), '.git/HEAD is a symlink'],
  ]
  for (const [rel, target, problem] of cases) {
    const { P, W } = makeClone(t)
    fs.mkdirSync(path.join(P, '.git', 'refs', 'heads', 'tl'), { recursive: true })
    lnk(W, rel, target(P))
    const { problems } = checkClone(W)
    assert.ok(problems.includes(problem), `${rel}: ${JSON.stringify(problems)}`)
  }
  // A file inside a loose-object directory that is a symlink, and a refs file that is one.
  const { P, W } = makeClone(t)
  const blob = git(W, ['hash-object', '-w', '--', path.join(W, '.git', 'HEAD')])
  const file = path.join(W, '.git', 'objects', blob.slice(0, 2), blob.slice(2))
  fs.rmSync(file, { force: true })
  fs.symlinkSync(path.join(P, '.git', 'HEAD'), file)
  fs.symlinkSync(path.join(P, '.git', 'refs', 'heads', 'main'), path.join(W, '.git', 'refs', 'tags', 'evil'))
  const { problems } = checkClone(W)
  assert.ok(problems.includes(`.git/objects/${blob.slice(0, 2)}/${blob.slice(2)} is a symlink`), JSON.stringify(problems))
  assert.ok(problems.includes('.git/refs/tags/evil is a symlink'), JSON.stringify(problems))
})

test('a hard-linked reflog, a wrong kind in a storage path and a missing objects directory are problems', PROC, t => {
  const { P, W } = makeClone(t)
  const log = path.join(W, '.git', 'logs', 'HEAD')
  fs.rmSync(log)
  fs.linkSync(path.join(P, '.git', 'logs', 'HEAD'), log)
  assert.ok(checkClone(W).problems.includes('.git/logs/HEAD has 2 links'), JSON.stringify(checkClone(W).problems))

  const k = makeClone(t)
  fs.rmSync(path.join(k.W, '.git', 'index'))
  fs.mkdirSync(path.join(k.W, '.git', 'index'))
  assert.ok(checkClone(k.W).problems.includes('.git/index is not a regular file (a directory)'), JSON.stringify(checkClone(k.W).problems))

  const m = makeClone(t)
  fs.renameSync(path.join(m.W, '.git', 'objects'), path.join(m.root, 'objects.moved'))
  assert.ok(checkClone(m.W).problems.includes('.git/objects is missing'), JSON.stringify(checkClone(m.W).problems))
})

test('cloneMeta records the identity of the storage directories: a real copy put in place of objects changes it', PROC, t => {
  const { root, W } = makeClone(t)
  const before = cloneMeta(W)
  assert.equal(cloneMeta(W), before)
  // Ordinary writes (a new object, a ref update, a reflog line) leave it unchanged.
  git(W, ['hash-object', '-w', '--', path.join(W, '.git', 'config')])
  workGit(W, ['update-ref', 'refs/tags/t1', 'HEAD'])
  assert.equal(cloneMeta(W), before)
  for (const rel of ['objects', 'objects/pack', 'objects/info', 'refs']) {
    const p = path.join(W, '.git', rel)
    const copy = path.join(root, `copy-${rel.replace('/', '-')}`)
    fs.cpSync(p, copy, { recursive: true })
    fs.renameSync(p, `${copy}.old`)
    fs.renameSync(copy, p)
    assert.deepEqual(checkClone(W).problems, [], `${rel}: a real directory is no problem`)
    assert.notEqual(cloneMeta(W), before, `${rel}: a replaced directory changes cloneMeta`)
    fs.rmSync(p, { recursive: true })
    fs.renameSync(`${copy}.old`, p)
    assert.equal(cloneMeta(W), before, `${rel}: the original back`)
  }
})
