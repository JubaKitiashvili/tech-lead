// tests/loop/reflex-bundle-fixture.mjs
// Shared fixture of the reflex-bundle tests (tests/loop/reflex-bundle*.test.mjs). Real temporary
// git repositories and real processes: <P> is a top-level repository with its spine <S>, <V>
// lives under a temporary TECH_LEAD_CACHE, the firing lock is held through scripts/loop-lock.mjs
// with a sleeper as holder (as tests/loop/loop-lock.test.mjs does), the clone <W> = loopPaths(P).W
// is made the way brief 13.4 makes it (cloneRepo flags, an empty template, remote.origin and
// branch.* removed, refs/tech-lead/base, a dated branch, the non-dated heads deleted), and the run
// record of the held generation is in phase prepared with rules recorded by changes.recordRules.
import { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'
import { openWorkTree, recordRules } from '../../scripts/lib/changes.mjs'
import { checkClone, cloneMeta, refsSnapshot } from '../../scripts/lib/clone-check.mjs'
import { createRecord } from '../../scripts/lib/run-record.mjs'

export const SCRIPT = path.join(ROOT, 'scripts', 'reflex-bundle.mjs')
export const T = { timeout: 90000 }
export const BRANCH = 'tl/2026-10-02'
export const HEAD_REF = `refs/heads/${BRANCH}`

// A private XDG_CONFIG_HOME keeps the user's ~/.config/git/ignore out of every listing; the CLI
// children inherit this environment.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-rb-xdg-'))
after(() => fs.rmSync(XDG, { recursive: true, force: true }))
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: XDG,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
for (const k of ['TECH_LEAD_CACHE', 'TECH_LEAD_HOLDER_PID', 'TECH_LEAD_FAULT', 'TECH_LEAD_BUNDLE_MAX_BYTES']) delete process.env[k]

// Plain git, the delegate's view and the control.
export function git(cwd, args, { buffer = false, input, env = process.env, check = true } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, input, maxBuffer: 64 * 1024 * 1024 })
  if (check && r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  if (buffer) return r.stdout
  return r.stdout.toString('utf8').replace(/\n$/, '')
}

// The exit status of plain git (0 when the command holds, e.g. diff-index --quiet).
export const gitCode = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { env: process.env }).status

export const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// A sleeper started through a shell that exits at once (so the test runner is not its parent),
// optionally with its cwd in dir. The cleanup kills it only while its start token is still the
// one read here: a test may kill it first, and a pid the kernel has since handed to another
// process is never signalled (review round, contracts-tests#7).
export const sleeper = (t, cwd) => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8', cwd }).trim())
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}

export const DEFAULT_LOOP_MD = '---\nverify:\n  - "true"\nscope:\n  - ./\n---\n'

// <P> with `files` committed on main, the lock held by a sleeper, <W> on a dated branch at the
// base, and the run record of the held generation N in phase prepared with recorded rules.
export async function fixture(t, files, { links = {}, execs = [], plumb, loopMd = DEFAULT_LOOP_MD, record = true } = {}) {
  const root = tmp(t, 'tl-rb-')
  const P = path.join(root, 'proj')
  fs.mkdirSync(P)
  git(P, ['init', '-q', '-b', 'main'])
  for (const [rel, content] of Object.entries(files)) write(P, rel, content)
  for (const [rel, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true })
    fs.symlinkSync(target, path.join(P, rel))
  }
  for (const rel of execs) fs.chmodSync(path.join(P, rel), 0o755)
  git(P, ['add', '-A'])
  if (plumb) plumb(P)
  git(P, ['commit', '-q', '--allow-empty', '-m', 'base'])
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), loopMd)
  const holder = sleeper(t)
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(root, 'cache'), TECH_LEAD_HOLDER_PID: String(holder) }
  const acq = await acquire(P, { env })
  assert.equal(acq.state, 'acquired', JSON.stringify(acq))
  const N = acq.generation
  const paths = loopPaths(P, { env })
  const tpl = path.join(root, 'tpl')
  fs.mkdirSync(tpl, { mode: 0o700 })
  const W = paths.W
  fs.mkdirSync(W, { mode: 0o700 })
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-checkout', '--no-recurse-submodules',
    `--template=${tpl}`, '-q', '--', P, W], { stdio: 'pipe' })
  git(W, ['config', '--remove-section', 'remote.origin'])
  for (const line of git(W, ['config', '--name-only', '--get-regexp', '^branch[.]'], { check: false }).split('\n')) {
    if (line) git(W, ['config', '--remove-section', line.slice(0, line.lastIndexOf('.'))], { check: false })
  }
  git(W, ['update-ref', '--no-deref', '-d', 'refs/remotes/origin/HEAD'], { check: false })
  const base = git(P, ['rev-parse', 'HEAD'])
  git(W, ['update-ref', 'refs/tech-lead/base', base])
  git(W, ['switch', '-q', '--no-track', '-c', BRANCH, base])
  git(W, ['update-ref', '-d', 'refs/heads/main'])
  assert.deepEqual(checkClone(W).problems, [], 'the fixture clone is one the loop accepts')
  const wt = openWorkTree(P, { env })
  let rules = null
  if (record) {
    rules = recordRules(wt, { base })
    assert.equal(createRecord(paths, N, {
      phase: 'prepared', branch: BRANCH, head_ref: HEAD_REF, base, rules, refs: refsSnapshot(W).refs, meta_sha: cloneMeta(W),
    }), true)
  }
  return { root, P, S, W, V: paths.V, paths, env, N, base, wt, holder, rules }
}

// The CLI: {status, signal, out (the one JSON line, or null), lines, stderr}.
export function cli(env, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  const lines = r.stdout.trim() ? r.stdout.trim().split('\n') : []
  let out = null
  if (lines.length === 1) out = JSON.parse(lines[0])
  return { status: r.status, signal: r.signal, out, lines, stderr: r.stderr }
}

// The CLI with one JSON line asserted, and the exit status checked when given.
export function run(env, status, ...args) {
  const r = cli(env, ...args)
  assert.equal(r.lines.length, 1, `${args.join(' ')}: expected one JSON line, got ${JSON.stringify(r.lines)} (stderr ${r.stderr})`)
  if (status !== undefined) assert.equal(r.status, status, `${args.join(' ')} -> ${JSON.stringify(r.out)} (stderr ${r.stderr})`)
  return r.out
}

export const save = (f, why = 'pause', extra = [], env = f.env) => run(env, undefined, 'save', f.P, '--generation', String(f.N), '--why', why, ...extra)

// Every entry under dir except .git: [rel (latin1), 'f <mode> <sha256>' | 'l <target hex>' | 'd'],
// sorted. dirs: false leaves directories out (an applied patch makes no empty directory).
export function snapshot(dir, { dirs = true, skip = [] } = {}) {
  const out = []
  const walk = rel => {
    const abs = rel.length ? Buffer.concat([Buffer.from(dir + '/'), rel]) : Buffer.from(dir)
    for (const e of fs.readdirSync(abs, { withFileTypes: true, encoding: 'buffer' })) {
      if (!rel.length && e.name.toString('latin1') === '.git') continue
      const r = rel.length ? Buffer.concat([rel, Buffer.from('/'), e.name]) : Buffer.from(e.name)
      const key = r.toString('latin1')
      if (skip.includes(key)) continue
      const p = Buffer.concat([Buffer.from(dir + '/'), r])
      const st = fs.lstatSync(p)
      if (st.isDirectory()) {
        if (dirs) out.push([key, 'd'])
        walk(r)
      } else if (st.isSymbolicLink()) out.push([key, `l ${fs.readlinkSync(p, { encoding: 'buffer' }).toString('hex')}`])
      else out.push([key, `f ${st.mode & 0o100 ? '100755' : '100644'} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`])
    }
  }
  walk(Buffer.alloc(0))
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// The git state a save must never change: index bytes, HEAD, every ref, no refs/stash.
export function gitState(W) {
  const index = path.join(W, '.git', 'index')
  return {
    index: fs.existsSync(index) ? crypto.createHash('sha256').update(fs.readFileSync(index)).digest('hex') : null,
    HEAD: fs.readFileSync(path.join(W, '.git', 'HEAD'), 'utf8'),
    refs: git(W, ['for-each-ref', '--format=%(objectname) %(refname)']),
    stash: git(W, ['rev-parse', '--verify', '-q', 'refs/stash'], { check: false }),
  }
}

export const patchFile = (f, sha) => path.join(f.V, 'patches', `${sha}.patch`)
export const bundles = f => {
  try {
    return fs.readdirSync(path.join(f.V, 'patches')).filter(n => /^[0-9a-f]{64}\.patch$/.test(n)).sort()
  } catch {
    return []
  }
}
export const temps = f => {
  try {
    return fs.readdirSync(path.join(f.V, 'patches')).filter(n => n.startsWith('.tmp-'))
  } catch {
    return []
  }
}
export const recordOf = f => JSON.parse(fs.readFileSync(path.join(f.V, 'run', `${f.N}.json`), 'utf8'))

// A scratch clone of <P> at the base with the bundle applied by plain `git apply --binary`
// (no autocrlf, no filter): its snapshot is what the bundle reproduces, byte for byte.
export function scratchApply(t, f, sha) {
  const dir = path.join(tmp(t, 'tl-rb-scratch-'), 's')
  execFileSync('git', ['clone', '-q', '--no-local', '--no-checkout', '--', f.P, dir], { stdio: 'pipe' })
  git(dir, ['checkout', '-q', '--detach', f.base])
  git(dir, ['apply', '--binary', patchFile(f, sha)])
  return snapshot(dir, { dirs: false })
}

// A scratch checkout of the base alone.
export function baseSnapshot(t, f) {
  const dir = path.join(tmp(t, 'tl-rb-base-'), 's')
  execFileSync('git', ['clone', '-q', '--no-local', '--no-checkout', '--', f.P, dir], { stdio: 'pipe' })
  git(dir, ['checkout', '-q', '--detach', f.base])
  return snapshot(dir, { dirs: false })
}

export const header = (f, sha) => {
  const text = fs.readFileSync(patchFile(f, sha), 'utf8')
  const line = text.slice(0, text.indexOf('\n'))
  assert.ok(line.startsWith('TECH-LEAD-RECOVERY v1 '))
  return JSON.parse(line.slice('TECH-LEAD-RECOVERY v1 '.length))
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
