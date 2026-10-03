// tests/loop/loop-clone-fixture.mjs
// Shared fixture of the loop-clone tests (tests/loop/loop-clone*.test.mjs). Real temporary git
// repositories and real processes: <P> is a top-level repository with its spine <S>, <V> lives
// under a temporary TECH_LEAD_CACHE, and the firing lock is held through scripts/loop-lock.mjs with
// a sleeper as holder (as tests/loop/loop-lock.test.mjs does). Each firing acquires the next
// generation; the CLI children inherit the hermetic environment below.
import { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { ROOT, scrubGitRouting } from '../helpers.mjs'
import { acquire, release } from '../../scripts/loop-lock.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

export const SCRIPT = path.join(ROOT, 'scripts', 'loop-clone.mjs')
export const FAKE_CODEX = path.join(ROOT, 'tests', 'fixtures', 'codex', 'scripts', 'codex-companion.mjs')
export const T = { timeout: 90000 }
export const PREFIX = 'tl'
export const D1 = '2026-10-01'
export const D2 = '2026-10-02'
export const D3 = '2026-10-03'
export const D4 = '2026-10-04'

// A private XDG_CONFIG_HOME keeps the user's ~/.config/git/ignore out of every listing, and no
// inherited variable routes the fixture's own git to another repository, index, object store or
// configuration (Codex g4 #1); a test sets a hostile one explicitly, in the env it passes.
scrubGitRouting(process.env)
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-lc-xdg-'))
after(() => fs.rmSync(XDG, { recursive: true, force: true }))
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: XDG,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
for (const k of ['TECH_LEAD_CACHE', 'TECH_LEAD_HOLDER_PID', 'TECH_LEAD_FAULT', 'TECH_LEAD_BUNDLE_MAX_BYTES', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']) {
  delete process.env[k]
}

// Plain git: the delegate's and the owner's view, and the control.
export function git(cwd, args, { buffer = false, input, env = process.env, check = true } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, input, maxBuffer: 64 * 1024 * 1024 })
  if (check && r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  if (buffer) return r.stdout
  return r.stdout.toString('utf8').replace(/\n$/, '')
}

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function waitGone(pid, ms = 5000) {
  const deadline = Date.now() + ms
  while (startToken(pid).state !== 'gone' && Date.now() < deadline) await sleep(50)
  assert.equal(startToken(pid).state, 'gone', `pid ${pid} never read as gone`)
}

// Kills pid when the test ends, only while its start token is still the one read here: a test
// may kill it first, and a pid the kernel has since handed to another process is never
// signalled (review round, contracts-tests#7).
const reapPid = (t, pid) => {
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}

// A sleeper started through a shell that exits at once (so the test runner is not its parent).
export const sleeper = t => reapPid(t, Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim()))

// A process whose working directory is cwd, started detached by a launcher that exits at once,
// so init reaps it and it is in nobody's ancestry.
const LAUNCH = "const c = require('node:child_process').spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
export const dweller = (t, cwd) => reapPid(t, Number(execFileSync(process.execPath, ['-e', LAUNCH], { encoding: 'utf8', cwd }).trim()))

export const loopMd = (scope = ['./']) => `---\nverify:\n  - "true"\nscope:\n${scope.map(s => `  - ${s}`).join('\n')}\n---\n`
export const STATE_MD = '# State\n\n## Now\n\n(empty)\n\n## Backlog\n\n## Done\n'

// <P> with `files` committed on main (plumb(P) runs before the commit), its spine, a holder and a
// cache root. Returns the fixture; call firing(fx) to hold a generation.
export function project(t, { files = { 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/app.js': 'app\n' }, scope = ['./'], plumb, links = {} } = {}) {
  const root = tmp(t, 'tl-lc-')
  const P = path.join(root, 'proj')
  fs.mkdirSync(P)
  git(P, ['init', '-q', '-b', 'main'])
  for (const [rel, content] of Object.entries(files)) write(P, rel, content)
  for (const [rel, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true })
    fs.symlinkSync(target, path.join(P, rel))
  }
  if (plumb) plumb(P)
  git(P, ['add', '-A'])
  git(P, ['commit', '-q', '--allow-empty', '-m', 'base'])
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), loopMd(scope))
  fs.writeFileSync(path.join(S, 'STATE.md'), STATE_MD)
  const holder = sleeper(t)
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(root, 'cache'), TECH_LEAD_HOLDER_PID: String(holder) }
  const paths = loopPaths(P, { env })
  return { t, root, P, S, env, holder, paths, V: paths.V, W: paths.W, N: null }
}

// Releases the generation held (if any) and acquires the next one.
export async function firing(fx) {
  if (fx.N !== null) await end(fx)
  const r = await acquire(fx.P, { env: fx.env })
  assert.equal(r.state, 'acquired', JSON.stringify(r))
  fx.N = r.generation
  return fx.N
}

export async function end(fx) {
  if (fx.N === null) return
  const r = await release(fx.P, fx.N, { env: fx.env })
  assert.equal(r.state, 'released', JSON.stringify(r))
}

// The CLI: {status, signal, out (the one JSON line, or null), lines, stdout, stderr}.
export function cli(env, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  const lines = r.stdout.trim() ? r.stdout.trim().split('\n') : []
  let out = null
  if (lines.length === 1) {
    try { out = JSON.parse(lines[0]) } catch { out = null }
  }
  return { status: r.status, signal: r.signal, out, lines, stdout: r.stdout, stderr: r.stderr }
}

// The CLI with one JSON line asserted, and the exit status checked when given.
export function run(env, status, ...args) {
  const r = cli(env, ...args)
  assert.equal(r.lines.length, 1, `${args.join(' ')}: expected one JSON line, got ${JSON.stringify(r.lines)} (stderr ${r.stderr})`)
  if (status !== undefined) assert.equal(r.status, status, `${args.join(' ')} -> ${JSON.stringify(r.out)} (stderr ${r.stderr})`)
  return r.out
}

export const prepareArgs = (fx, { date = D2, base = 'main', generation = fx.N } = {}) =>
  ['prepare', fx.P, '--generation', String(generation), '--prefix', PREFIX, ...(base === null ? [] : ['--base', base]), '--date', date]
export const prepare = (fx, { status = 0, env = fx.env, ...o } = {}) => run(env, status, ...prepareArgs(fx, o))
export const check = (fx, after, { status = 0, env = fx.env } = {}) =>
  run(env, status, 'check', fx.P, '--generation', String(fx.N), '--after', after)
export const deps = (fx, ...flags) => run(fx.env, 0, 'deps', fx.P, '--generation', String(fx.N), ...flags)
export const closeCli = (fx, { status = 0, env = fx.env } = {}) => run(env, status, 'close', fx.P, '--generation', String(fx.N))
export const bundleCli = (fx, branch, { status = 0 } = {}) => run(fx.env, status, 'bundle', fx.P, '--generation', String(fx.N), '--branch', branch)

export function subjectFile(fx, text) {
  const file = path.join(fx.root, `subject-${crypto.randomBytes(4).toString('hex')}`)
  fs.writeFileSync(file, text)
  return file
}
export const commitCli = (fx, digest, { subject = 'Do the thing\n', status = 0, env = fx.env } = {}) =>
  run(env, status, 'commit', fx.P, '--generation', String(fx.N), '--digest', digest, '--subject-file', subjectFile(fx, subject))

// The CLI killed at a fault point.
export function killAt(fx, point, ...args) {
  const r = cli({ ...fx.env, TECH_LEAD_FAULT: point }, ...args)
  assert.equal(r.signal, 'SIGKILL', `${point}: expected SIGKILL, got status ${r.status} ${r.stdout} ${r.stderr}`)
  return r
}

// The usual write-capable attempt after prepare: check --after deps, the delegate's edits, check
// --after dispatch, commit. Returns {check, commit}.
export function attempt(fx, edits, { subject = 'Do the thing\n' } = {}) {
  check(fx, 'deps')
  edits(fx.W)
  const c = check(fx, 'dispatch')
  const m = commitCli(fx, c.digest, { subject })
  assert.equal(m.state, 'committed', JSON.stringify(m))
  return { check: c, commit: m }
}

export const recordOf = (fx, g = fx.N) => {
  try { return JSON.parse(fs.readFileSync(path.join(fx.V, 'run', `${g}.json`), 'utf8')) } catch { return null }
}
export const recordGenerations = fx => {
  try {
    return fs.readdirSync(path.join(fx.V, 'run')).filter(n => /^[0-9]+\.json$/.test(n)).map(n => Number(n.slice(0, -5))).sort((a, b) => a - b)
  } catch { return [] }
}
export const appendLedger = (fx, row) => fs.appendFileSync(path.join(fx.S, 'LEDGER.jsonl'), JSON.stringify(row) + '\n')
export const tipOf = (W, ref = 'HEAD') => git(W, ['rev-parse', ref])
export const headRef = W => git(W, ['symbolic-ref', 'HEAD'])
export const patches = fx => {
  try { return fs.readdirSync(path.join(fx.V, 'patches')).filter(n => /^[0-9a-f]{64}\.patch$/.test(n)).sort() } catch { return [] }
}
export const headerOf = (fx, sha) => {
  const first = fs.readFileSync(path.join(fx.V, 'patches', `${sha}.patch`), 'utf8').split('\n')[0]
  return JSON.parse(first.slice('TECH-LEAD-RECOVERY v1 '.length))
}
// git status of <W> as the delegate sees it ('' when clean).
export const status = W => git(W, ['status', '--porcelain=v1', '-uall'])

// Every entry under dir: [rel (latin1), 'f <mode> <sha256>' | 'l <target hex>' | 'd'], sorted.
// skip lists top-level names to leave out; times: true adds each mtime (files and directories).
export function snapshot(dir, { skip = ['.git'], times = false } = {}) {
  const out = []
  const walk = rel => {
    const abs = rel.length ? Buffer.concat([Buffer.from(dir + '/'), rel]) : Buffer.from(dir)
    for (const e of fs.readdirSync(abs, { withFileTypes: true, encoding: 'buffer' })) {
      if (!rel.length && skip.includes(e.name.toString('latin1'))) continue
      const r = rel.length ? Buffer.concat([rel, Buffer.from('/'), e.name]) : Buffer.from(e.name)
      const key = r.toString('latin1')
      const p = Buffer.concat([Buffer.from(dir + '/'), r])
      const st = fs.lstatSync(p)
      const t = times ? ` @${st.mtimeMs}` : ''
      if (st.isDirectory()) {
        out.push([key, `d${t}`])
        walk(r)
      } else if (st.isSymbolicLink()) out.push([key, `l ${fs.readlinkSync(p, { encoding: 'buffer' }).toString('hex')}${t}`])
      else out.push([key, `f ${(st.mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}${t}`])
    }
  }
  walk(Buffer.alloc(0))
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// A scratch checkout of <P> at base with the recovery bundle applied by plain `git apply
// --binary` (no autocrlf, no filter): its snapshot is what the bundle reproduces.
export function scratchApply(fx, base, sha) {
  const dir = path.join(tmp(fx.t, 'tl-lc-scratch-'), 's')
  execFileSync('git', ['clone', '-q', '--no-local', '--no-checkout', '--', fx.P, dir], { stdio: 'pipe', env: process.env })
  git(dir, ['checkout', '-q', '--detach', base])
  git(dir, ['apply', '--binary', path.join(fx.V, 'patches', `${sha}.patch`)])
  return dir
}

// The heads of a git bundle file.
export const bundleHeads = (cwd, file) => git(cwd, ['bundle', 'list-heads', file]).split('\n').filter(Boolean).map(l => l.split(' '))
