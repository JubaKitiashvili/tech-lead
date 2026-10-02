// tests/loop/loop-recover.test.mjs
// The read-only recovery planner (stage 0c-1 brief section 7) against real temporary git
// repositories and a real linked worktree at <S>/worktree. Every case runs the CLI as a
// child process; the planner must report and never write.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { nowLine } from '../../scripts/loop-recover.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-recover.mjs')
// Keep the user's git config and hooks out of the fixture repositories; the CLI children
// inherit this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

// The STATE.md separator the templates use; built from its code point to keep this file ASCII.
const DOT = String.fromCodePoint(0xb7)
const ITEM = `- [ ] P1 ${DOT} fix the parser ${DOT} class: hard`
const state = now => [
  '# Demo - Loop State', '',
  '## Now', now, '',
  '## Backlog',
  `- [ ] P2 ${DOT} later work ${DOT} class: unclassified`, '  - blocked-by: -', '  - status: -', '',
  '## Needs decision', '(empty)', '',
  '## Blocked', '(empty)', '',
  '## Done', '(empty)', '',
  '## Last run', '(never run)', '',
].join('\n')

// A project <P> with two committed files, the spine ignored through info/exclude, a
// STATE.md, and (unless worktree is false) a linked worktree at <S>/worktree on a loop
// branch. <V> would live under the temporary cache root, which must stay empty.
const project = (t, { now = '(empty)', worktree = true } = {}) => {
  const P = tmp(t, 'tl-recover-p-')
  const cache = tmp(t, 'tl-recover-cache-')
  git(P, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(P, 'b.txt'), 'b\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  fs.appendFileSync(path.join(P, '.git', 'info', 'exclude'), '/.tech-lead/\n')
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'STATE.md'), state(now))
  const W = path.join(S, 'worktree')
  if (worktree) git(P, 'worktree', 'add', '-q', '-b', 'tech-lead-loop/2026-10-01', W, 'main')
  return { P, S, W, cache }
}

const run = (fx, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, TECH_LEAD_CACHE: fx.cache },
  })
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `exactly one JSON line on stdout, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  return { code: r.status, out: JSON.parse(lines[0]), stderr: r.stderr }
}
const plan = (fx, ...extra) => run(fx, fx.P, '--worktree', fx.W, ...extra)

const CLEAN = { exists: true, staged: false, tracked: false, untracked: [] }

// Every entry under root (lstat, symlinks not followed): directories with their mtime, so a
// file created and removed again shows; files with size, times and a content hash, so a
// rewritten index shows even when its size does not change.
const snapshot = root => {
  const out = {}
  const walk = rel => {
    const abs = path.join(root, rel)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) {
      out[rel || '.'] = { dir: true, mtimeMs: st.mtimeMs }
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name))
    } else if (st.isSymbolicLink()) {
      out[rel] = { link: fs.readlinkSync(abs), mtimeMs: st.mtimeMs }
    } else {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
      out[rel] = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha }
    }
  }
  walk('')
  return out
}

test('a Now item -> requeue-now, before the worktree exists; --reclaimed is echoed', t => {
  const fx = project(t, { now: ITEM, worktree: false })
  const { code, out } = plan(fx, '--reclaimed', '7')
  assert.equal(code, 0)
  assert.deepEqual(out, {
    reclaimed: 7, now: ITEM,
    worktree: { exists: false, staged: false, tracked: false, untracked: [] },
    actions: ['requeue-now'],
  })
})

test('a dirty tracked file in a real worktree -> reset-worktree', t => {
  const fx = project(t)
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'changed by an interrupted firing\n')
  const { code, out } = plan(fx)
  assert.equal(code, 0)
  assert.deepEqual(out, {
    reclaimed: null, now: null,
    worktree: { exists: true, staged: false, tracked: true, untracked: [] },
    actions: ['reset-worktree'],
  })
})

test('a deleted tracked file counts as a tracked change', t => {
  const fx = project(t)
  fs.rmSync(path.join(fx.W, 'b.txt'))
  const { out } = plan(fx)
  assert.deepEqual(out.worktree, { ...CLEAN, tracked: true })
  assert.deepEqual(out.actions, ['reset-worktree'])
})

test('a staged change alone -> reset-worktree; a staged rename is staged, not a tracked change', t => {
  const fx = project(t)
  git(fx.W, 'mv', 'a.txt', 'renamed a.txt')
  let { out } = plan(fx)
  assert.deepEqual(out.worktree, { ...CLEAN, staged: true })
  assert.deepEqual(out.actions, ['reset-worktree'])

  fs.writeFileSync(path.join(fx.W, 'new.txt'), 'new\n')
  git(fx.W, 'add', 'new.txt')
  ;({ out } = plan(fx))
  assert.deepEqual(out.worktree, { ...CLEAN, staged: true })
})

test('untracked files alone are listed one by one and plan no action', t => {
  const fx = project(t)
  fs.mkdirSync(path.join(fx.W, 'notes', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(fx.W, 'notes', 'deep', 'x.txt'), 'x\n')
  fs.writeFileSync(path.join(fx.W, 'my file.txt'), 'y\n')
  const { code, out } = plan(fx)
  assert.equal(code, 0)
  assert.deepEqual(out.worktree, { ...CLEAN, untracked: ['my file.txt', 'notes/deep/x.txt'] })
  assert.deepEqual(out.actions, [])
})

test('clean -> []: an empty Now and a worktree whose files were only touched', t => {
  const fx = project(t)
  // New times, same content: the index's stat data is stale, the tree is still clean.
  fs.utimesSync(path.join(fx.W, 'a.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const { code, out } = plan(fx)
  assert.equal(code, 0)
  assert.deepEqual(out, { reclaimed: null, now: null, worktree: CLEAN, actions: [] })
})

test('a Now item and a dirty worktree -> both actions, requeue-now first', t => {
  const fx = project(t, { now: ITEM })
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(fx.W, 'left.txt'), 'leftover\n')
  const { out } = plan(fx, '--reclaimed', '41')
  assert.deepEqual(out, {
    reclaimed: 41, now: ITEM,
    worktree: { exists: true, staged: false, tracked: true, untracked: ['left.txt'] },
    actions: ['requeue-now', 'reset-worktree'],
  })
})

test('it never writes: <P>, its .git, the worktree and the cache are byte- and time-identical after a run', t => {
  const fx = project(t, { now: ITEM })
  // Every kind of change at once, plus stale stat data that a plain `git status` would
  // refresh by rewriting the worktree's index.
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(fx.W, 'staged.txt'), 'staged\n')
  git(fx.W, 'add', 'staged.txt')
  fs.writeFileSync(path.join(fx.W, 'left.txt'), 'leftover\n')
  fs.utimesSync(path.join(fx.W, 'b.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const before = { P: snapshot(fx.P), cache: snapshot(fx.cache) }
  const { code, out } = plan(fx, '--reclaimed', '3')
  assert.equal(code, 0)
  assert.deepEqual(out.actions, ['requeue-now', 'reset-worktree'])
  assert.deepEqual(out.worktree, { exists: true, staged: true, tracked: true, untracked: ['left.txt'] })
  assert.deepEqual({ P: snapshot(fx.P), cache: snapshot(fx.cache) }, before)
  assert.deepEqual(fs.readdirSync(fx.cache), [])
  // The refused forms write nothing either.
  for (const args of [[fx.P, '--worktree', fx.P], [fx.P, '--worktree', fx.S], [fx.P, '--worktree', fx.W, '--reclaimed', '0']]) {
    assert.equal(run(fx, ...args).code, 2)
  }
  assert.deepEqual({ P: snapshot(fx.P), cache: snapshot(fx.cache) }, before)
})

test('refuses a worktree that is not the top level of its own working tree, and <P> itself', t => {
  const fx = project(t)
  fs.writeFileSync(path.join(fx.P, 'a.txt'), 'the owner is editing\n')
  // A plain directory inside <P>: git would answer for <P>, and a reset would hit the owner's tree.
  const plain = path.join(fx.S, 'plain')
  fs.mkdirSync(plain)
  let r = run(fx, fx.P, '--worktree', plain)
  assert.equal(r.code, 2)
  assert.equal(r.out.state, 'error')
  assert.match(r.out.detail, /^not-a-worktree: /)
  // <P> itself, directly and through a symlink.
  r = run(fx, fx.P, '--worktree', fx.P)
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^worktree-is-project: /)
  const alias = path.join(tmp(t, 'tl-recover-alias-'), 'p')
  fs.symlinkSync(fx.P, alias)
  r = run(fx, fx.P, '--worktree', alias)
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^worktree-is-project: /)
  // A path that exists but is not a directory.
  fs.writeFileSync(path.join(fx.S, 'afile'), 'x\n')
  r = run(fx, fx.P, '--worktree', path.join(fx.S, 'afile'))
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^not-a-worktree: /)
})

test('refuses a <P> below the top level, a missing STATE.md and bad usage, with one JSON line', t => {
  const fx = project(t)
  fs.mkdirSync(path.join(fx.P, 'sub'))
  let r = run(fx, path.join(fx.P, 'sub'), '--worktree', fx.W)
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^not-toplevel: /)

  fs.rmSync(path.join(fx.S, 'STATE.md'))
  r = plan(fx)
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^no-state: /)

  for (const args of [
    [], [fx.P], [fx.P, '--worktree'], ['--worktree', fx.W], [fx.P, fx.P, '--worktree', fx.W],
    [fx.P, '--worktree', fx.W, '--reclaimed', 'x'], [fx.P, '--worktree', fx.W, '--reclaimed', '0'],
    [fx.P, '--worktree', fx.W, '--reclaimed', '1.5'], [fx.P, '--worktree', fx.W, '--reclaimed', '9007199254740993'],
    [fx.P, '--worktree', fx.W, '--worktree', fx.W], [fx.P, '--worktree', fx.W, '--bundle', 'x'],
  ]) {
    r = run(fx, ...args)
    assert.equal(r.code, 2, `exit 2 for ${JSON.stringify(args)}`)
    assert.equal(r.out.state, 'error')
    assert.match(r.out.detail, /^usage: /)
  }
})

test('nowLine: the first line of ## Now, null when it is empty or missing', () => {
  assert.equal(nowLine(state(ITEM)), ITEM)
  assert.equal(nowLine(state('(empty)')), null)
  assert.equal(nowLine(state('')), null)
  // Blank lines before the item, CRLF line ends, trailing spaces, a multi-line item.
  assert.equal(nowLine('## Now\r\n\r\n  - [ ] P1 task  \r\n  - status: -\r\n## Backlog\r\n'), '- [ ] P1 task')
  // The section ends at the next level-1 or level-2 heading; a deeper heading stays inside.
  assert.equal(nowLine('## Now\n## Backlog\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Now\n\n# Other\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Now\n### detail\n'), '### detail')
  // Only the exact heading opens the section.
  assert.equal(nowLine('## Nowhere\n- [ ] P1 x\n'), null)
  assert.equal(nowLine('## Now  \n- [ ] P1 x\n'), '- [ ] P1 x')
  assert.equal(nowLine('# Title\n\n## Backlog\n- [ ] P1 x\n'), null)
})
