// tests/loop/loop-clone-check.test.mjs
// loop-clone.mjs deps, check and commit (brief 13.9; loop04; R2, R7, R9, R14, R20). Real
// repositories, a held lock, the delegate as plain git and file writes in <W>.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  D2, PREFIX, T, check, commitCli, deps, firing, git, prepare, project, recordOf, status, tipOf, write, run,
} from './loop-clone-fixture.mjs'

const BRANCH = `${PREFIX}/${D2}`
const FILES = {
  'a.txt': 'a\n', 'b.txt': 'b\n', 'src/app.js': 'app\n', 'package-lock.json': '{"lockfileVersion":3}\n', '.gitignore': 'node_modules/\n',
}

async function ready(t, opts = {}) {
  const fx = project(t, { files: FILES, ...opts })
  await firing(fx)
  prepare(fx)
  return fx
}

test('deps marker: fresh only for the same branch and lockfiles; --mark and --clear (R14)', T, async t => {
  const fx = await ready(t)
  const marker = path.join(fx.W, '.git', 'tech-lead-deps.ok')
  const first = deps(fx)
  assert.equal(first.fresh, false)
  assert.equal(first.marker, null)
  assert.deepEqual(first.lockfiles, ['package-lock.json'])
  assert.match(first.current, new RegExp(`^${BRANCH} sha256:[0-9a-f]{64}$`))
  assert.equal(deps(fx, '--mark').marked, true)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), first.current)
  assert.equal(deps(fx).fresh, true)
  write(fx.W, 'package-lock.json', '{"lockfileVersion":3,"x":1}\n')
  assert.equal(deps(fx).fresh, false)
  write(fx.W, 'package-lock.json', '{"lockfileVersion":3}\n')
  assert.equal(deps(fx).fresh, true)
  assert.equal(deps(fx, '--clear').cleared, true)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(deps(fx).fresh, false)
})

test('check --after deps records the rules; a self-ignored install directory is not deps-dirty, a lockfile rewrite is', T, async t => {
  const fx = await ready(t)
  write(fx.W, 'node_modules/x/index.js', 'x\n')
  write(fx.W, '.venv/.gitignore', '*\n')
  write(fx.W, '.venv/lib/site.py', 'py\n')
  const ok = check(fx, 'deps')
  assert.equal(ok.state, 'ok')
  assert.deepEqual(ok.touched, [])
  const rules = recordOf(fx).rules
  assert.equal(rules.mode, 'recorded')
  assert.deepEqual(rules.ignores.map(i => i.path).sort(), ['.gitignore', '.venv/.gitignore'])

  await firing(fx)
  prepare(fx)
  write(fx.W, 'package-lock.json', '{"lockfileVersion":3,"rewritten":true}\n')
  const dirty = check(fx, 'deps', { status: 3 })
  assert.equal(dirty.state, 'deps-dirty')
  assert.deepEqual(dirty.paths, ['package-lock.json'])
  assert.equal(recordOf(fx).rules, null, 'no rules recorded over a dirty tree')
})

test('husky: core.hookspath and .git/hooks written by the install are allowed, and no hook ever runs', T, async t => {
  const fx = await ready(t)
  const marker = path.join(fx.root, 'hook-ran')
  const hook = `#!/bin/sh\necho "$0" >> '${marker}'\n`
  // What a husky install does: core.hooksPath, hooks in .husky/_ (which ignores itself) and in
  // .git/hooks.
  git(fx.W, ['config', 'core.hooksPath', '.husky/_'])
  write(fx.W, '.husky/_/.gitignore', '*\n')
  for (const name of ['pre-commit', 'post-commit', 'reference-transaction', 'post-checkout']) {
    write(fx.W, `.git/hooks/${name}`, hook)
    fs.chmodSync(path.join(fx.W, '.git', 'hooks', name), 0o755)
    write(fx.W, `.husky/_/${name}`, hook)
    fs.chmodSync(path.join(fx.W, '.husky', '_', name), 0o755)
  }
  const d = check(fx, 'deps')
  assert.equal(d.state, 'ok')
  assert.deepEqual(d.touched, [])
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  // A global config naming a hooks directory is overridden too.
  const globalCfg = path.join(fx.root, 'gitconfig')
  fs.writeFileSync(globalCfg, `[core]\n\thooksPath = ${path.join(fx.W, '.git', 'hooks')}\n`)
  const m = commitCli(fx, c.digest, { env: { ...fx.env, GIT_CONFIG_GLOBAL: globalCfg } })
  assert.equal(m.state, 'committed')
  assert.equal(fs.existsSync(marker), false, 'no hook ran')
})

test('check refuses no-rules before deps, and no-attempt without a prepared record', T, async t => {
  const fx = await ready(t)
  const before = fs.readFileSync(path.join(fx.V, 'run', `${fx.N}.json`), 'utf8')
  assert.equal(check(fx, 'dispatch', { status: 3 }).state, 'no-rules')
  assert.equal(fs.readFileSync(path.join(fx.V, 'run', `${fx.N}.json`), 'utf8'), before)
  await firing(fx)
  assert.equal(check(fx, 'deps', { status: 3 }).state, 'no-attempt')
  const bad = run(fx.env, 2, 'check', fx.P, '--generation', String(fx.N), '--after', 'lunch')
  assert.equal(bad.state, 'error')
})

test('loop04: a delegate commit is rewound; its work stays as edits and the loop commits it on H0', T, async t => {
  const fx = await ready(t)
  const base = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'by the delegate\n')
  git(fx.W, ['commit', '-q', '-am', 'delegate'])
  const tipD = tipOf(fx.W)
  const c = check(fx, 'dispatch')
  assert.equal(c.delegateCommitted, true)
  assert.deepEqual(c.delegateCommits, [tipD])
  assert.equal(c.head, base)
  assert.deepEqual(c.touched, ['a.txt'])
  assert.equal(tipOf(fx.W), base)
  assert.equal(git(fx.W, ['diff-index', '--cached', '--name-only', base]), '', 'the index is back at the base')
  assert.deepEqual(recordOf(fx).delegate_commits, [tipD])
  const m = commitCli(fx, c.digest)
  assert.equal(m.state, 'committed')
  assert.equal(git(fx.W, ['rev-parse', `${m.sha}^`]), base)
  assert.equal(git(fx.W, ['rev-list', '--count', `${m.sha}`, `^${base}`]), '1')
  assert.notEqual(git(fx.W, ['merge-base', '--is-ancestor', tipD, m.sha], { check: false }), 0)
  assert.equal(git(fx.W, ['show', `${m.sha}:a.txt`]), 'by the delegate')
})

test('tamper: a branch switch and a new tag are tampered; refs/stash and a config key make the clone invalid', T, async t => {
  const cases = [
    ['branch switch', W => git(W, ['switch', '-q', '-c', `${PREFIX}/2026-01-01`]), 'tampered'],
    ['new tag', W => git(W, ['tag', 'sneaky']), 'tampered'],
    ['refs/stash', W => { write(W, 'a.txt', 'stash me\n'); git(W, ['stash', '-q']) }, 'clone-invalid'],
    ['config key', W => git(W, ['config', 'user.name', 'delegate']), 'clone-invalid'],
  ]
  for (const [name, tamper, state] of cases) {
    await t.test(name, async t2 => {
      const fx = await ready(t2)
      check(fx, 'deps')
      tamper(fx.W)
      const out = check(fx, 'dispatch', { status: 3 })
      assert.equal(out.state, state, JSON.stringify(out))
      assert.equal(recordOf(fx).phase, 'prepared')
    })
  }
})

test('index-only content is refused and kept (R20); plain staging is reset', T, async t => {
  const fx = await ready(t)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'staged\n')
  git(fx.W, ['add', 'a.txt'])
  write(fx.W, 'a.txt', 'work tree\n')
  const staged = git(fx.W, ['ls-files', '-s', 'a.txt'])
  const out = check(fx, 'dispatch', { status: 3 })
  assert.equal(out.state, 'index-only')
  assert.deepEqual(out.paths, ['a.txt'])
  assert.equal(git(fx.W, ['ls-files', '-s', 'a.txt']), staged, 'the staged blob is kept')

  git(fx.W, ['add', 'a.txt'])
  write(fx.W, 'b.txt', 'b staged as is\n')
  git(fx.W, ['add', 'b.txt'])
  const ok = check(fx, 'dispatch')
  assert.equal(ok.unstaged, true)
  assert.deepEqual(ok.touched, ['a.txt', 'b.txt'])
  assert.equal(git(fx.W, ['diff-index', '--cached', '--name-only', 'HEAD']), '')
  assert.equal(fs.readFileSync(path.join(fx.W, 'b.txt'), 'utf8'), 'b staged as is\n')
})

test('check reports hidden paths from the recorded rules and out_of_scope from the scope (R2, R7)', T, async t => {
  const fx = await ready(t, { scope: ['src'] })
  check(fx, 'deps')
  write(fx.W, 'src/app.js', 'in scope\n')
  write(fx.W, 'a.txt', 'out of scope\n')
  write(fx.W, 'sub/.gitignore', '*\n')
  write(fx.W, 'sub/h.txt', 'hidden\n')
  write(fx.W, '.tech-lead/x.md', 'spine copy\n')
  const c = check(fx, 'dispatch')
  assert.deepEqual(c.touched, ['.tech-lead/x.md', 'a.txt', 'src/app.js'])
  assert.deepEqual(c.out_of_scope, ['.tech-lead/x.md', 'a.txt'])
  assert.deepEqual(c.hidden, ['sub/.gitignore', 'sub/h.txt'])
  assert.equal(c.scope.state, 'ok')
  assert.deepEqual(c.scope.entries, ['src'])
  const m = commitCli(fx, c.digest, { status: 3 })
  assert.equal(m.state, 'out-of-scope')
  assert.deepEqual(m.paths, ['.tech-lead/x.md', 'a.txt'])
  assert.equal(tipOf(fx.W), recordOf(fx).base)
})

test('commit: odd names, one Tech-Lead-Generation trailer, no Co-Authored-By, parent H0, the record committed and the commit bundled', T, async t => {
  const fx = await ready(t)
  const base = tipOf(fx.W)
  const names = ['with space.txt', '-dash.txt', 'quote"s.txt', `uni-${String.fromCodePoint(0xe9, 0x1f600)}.txt`, 'new\nline.txt', 'tab\there.txt']
  check(fx, 'deps')
  for (const n of names) write(fx.W, n, `${n}\n`)
  const c = check(fx, 'dispatch')
  assert.equal(c.touched.length, names.length)
  const m = commitCli(fx, c.digest, { subject: 'Add odd files\nCo-Authored-By: Claude <noreply@anthropic.com>\nTech-Lead-Generation: 99\n' })
  assert.equal(m.state, 'committed')
  assert.equal(m.branch, BRANCH)
  assert.equal(m.bundleError, null)
  assert.equal(m.bundle.tip, m.sha)
  assert.equal(tipOf(fx.W), m.sha)
  assert.equal(git(fx.W, ['log', '-1', '--format=%B', m.sha]), `Add odd files\n\nTech-Lead-Generation: ${fx.N}\n`)
  assert.equal(git(fx.W, ['log', '-1', '--format=%P', m.sha]), base)
  const tree = git(fx.W, ['ls-tree', '-z', '--name-only', m.sha], { buffer: true }).toString('utf8').split('\0').filter(Boolean)
  for (const n of names) assert.ok(tree.includes(n), JSON.stringify(n))
  assert.equal(status(fx.W), '')
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'committed')
  assert.deepEqual(rec.commit, { sha: m.sha })
  assert.deepEqual(rec.intent, { tree: git(fx.W, ['rev-parse', `${m.sha}^{tree}`]), parent: base, commit: m.sha })
  assert.equal(rec.refs[`refs/heads/${BRANCH}`], m.sha)
  assert.ok(fs.existsSync(path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)))
  assert.equal(check(fx, 'dispatch', { status: 3 }).state, 'no-attempt', 'one commit per attempt')
})

test('commit identity (R9): <P>\'s git var identity, current dates; inherited identity dates are scrubbed', T, async t => {
  const fx = await ready(t)
  git(fx.P, ['config', 'user.name', 'Owner Name'])
  git(fx.P, ['config', 'user.email', 'owner@example.com'])
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'x\n')
  const c = check(fx, 'dispatch')
  const env = { ...fx.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[k]
  const m = commitCli(fx, c.digest, { env })
  assert.equal(m.state, 'committed')
  assert.equal(git(fx.W, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', m.sha]), 'Owner Name <owner@example.com>|Owner Name <owner@example.com>')
  const when = Number(git(fx.W, ['log', '-1', '--format=%at', m.sha]))
  assert.ok(Math.abs(Date.now() / 1000 - when) < 600, `author date ${when} is now, not the inherited 2001`)
  assert.ok(Math.abs(Date.now() / 1000 - Number(git(fx.W, ['log', '-1', '--format=%ct', m.sha]))) < 600)

  // With identity variables in the environment, the commit carries what `git var` in <P> gives,
  // as a commit made in <P> would.
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'b.txt', 'y\n')
  const c2 = check(fx, 'dispatch')
  const env2 = { ...fx.env, GIT_AUTHOR_NAME: 'Env Author', GIT_AUTHOR_EMAIL: 'env@example.com' }
  delete env2.GIT_COMMITTER_NAME
  delete env2.GIT_COMMITTER_EMAIL
  const m2 = commitCli(fx, c2.digest, { env: env2 })
  const pVar = k => git(fx.P, ['var', k], { env: env2 }).replace(/ [0-9]+ [+-][0-9]{4}$/, '')
  assert.equal(git(fx.W, ['log', '-1', '--format=%an <%ae>', m2.sha]), pVar('GIT_AUTHOR_IDENT'))
  assert.equal(git(fx.W, ['log', '-1', '--format=%cn <%ce>', m2.sha]), pVar('GIT_COMMITTER_IDENT'))
  assert.equal(pVar('GIT_COMMITTER_IDENT'), 'Owner Name <owner@example.com>')
})

test('commit refuses work-changed and commits nothing; with nothing touched it is unchanged and closes the record', T, async t => {
  const fx = await ready(t)
  const base = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'checked\n')
  const c = check(fx, 'dispatch')
  write(fx.W, 'a.txt', 'changed after the check\n')
  const out = commitCli(fx, c.digest, { status: 3 })
  assert.equal(out.state, 'work-changed')
  assert.equal(tipOf(fx.W), base)
  assert.equal(recordOf(fx).phase, 'prepared')
  const bad = commitCli(fx, 'f'.repeat(64), { status: 3 })
  assert.equal(bad.state, 'work-changed')

  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  const empty = check(fx, 'dispatch')
  assert.deepEqual(empty.touched, [])
  const u = commitCli(fx, empty.digest)
  assert.deepEqual(u, { state: 'unchanged' })
  assert.equal(recordOf(fx).phase, 'clean')
})

// The delegate commits D over the base, then stages a blob X that no commit holds and writes Y.
function commitThenStage(fx) {
  write(fx.W, 'a.txt', 'Z\n')
  git(fx.W, ['commit', '-q', '-am', 'D'])
  const D = tipOf(fx.W)
  write(fx.W, 'a.txt', 'X\n')
  git(fx.W, ['add', 'a.txt'])
  write(fx.W, 'a.txt', 'Y\n')
  return { D, staged: git(fx.W, ['ls-files', '-s', 'a.txt']) }
}

test('a delegate commit over index-only content: check and the next prepare refuse index-only before either rewinds (R20, contracts-tests#2)', T, async t => {
  const fx = await ready(t)
  check(fx, 'deps')
  const { D, staged } = commitThenStage(fx)
  const out = check(fx, 'dispatch', { status: 3 })
  assert.equal(out.state, 'index-only')
  assert.deepEqual(out.paths, ['a.txt'])
  assert.equal(git(fx.W, ['ls-files', '-s', 'a.txt']), staged, 'X is kept')
  assert.equal(tipOf(fx.W), D, 'no rewind')
  assert.deepEqual(recordOf(fx).delegate_commits, [])
  // The next firing, with no check in between: prepare's rewind is refused the same way.
  const g1 = fx.N
  await firing(fx)
  const p = prepare(fx, { status: 3 })
  assert.equal(p.state, 'index-only')
  assert.deepEqual(p.paths, ['a.txt'])
  assert.equal(git(fx.W, ['ls-files', '-s', 'a.txt']), staged)
  assert.equal(tipOf(fx.W), D)
  assert.equal(recordOf(fx, g1).recovery, null, 'no rewind intent was written')
})

test('a second check --after deps keeps the rules recorded first: a delegate\'s ignore file never joins them (contracts-tests#5)', T, async t => {
  const fx = await ready(t)
  check(fx, 'deps')
  const first = recordOf(fx).rules
  assert.deepEqual(first.ignores.map(i => i.path), ['.gitignore'])
  write(fx.W, 'sub/.gitignore', '*\n')
  write(fx.W, 'sub/secret.txt', 'hidden\n')
  assert.deepEqual(check(fx, 'dispatch').hidden, ['sub/.gitignore', 'sub/secret.txt'])
  check(fx, 'deps')
  assert.deepEqual(recordOf(fx).rules, first)
  assert.deepEqual(check(fx, 'dispatch').hidden, ['sub/.gitignore', 'sub/secret.txt'])
})

test('check refuses tampered when an allowed config key changes after the deps check (contracts-tests#5)', T, async t => {
  const fx = await ready(t)
  check(fx, 'deps')
  git(fx.W, ['config', 'core.filemode', 'false'])
  const out = check(fx, 'dispatch', { status: 3 })
  assert.equal(out.state, 'tampered')
  assert.match(out.detail, /config/)
})
