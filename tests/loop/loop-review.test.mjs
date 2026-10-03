// tests/loop/loop-review.test.mjs
// The owner's review helper (brief 15, R11; spec loop04): paths, fetch and retire against real
// temporary git repositories. The bundles under <V>/out are made the way the loop makes them
// (`git bundle create <file> refs/heads/<branch> ^refs/tech-lead/base` in a clone of <P>). The
// TTY path runs through an injected io object, as the owner release in loop-lock.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'
import { fetchBundles, main, retire, reviewPaths } from '../../scripts/loop-review.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-review.mjs')
const PROC = { timeout: 90000 }
// Keep the user's git config and hooks out of the fixture repositories, and any real Codex
// companion away; the CLI children and safeGit inherit this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
delete process.env.TECH_LEAD_FAULT

const PREFIX = 'tl/loop'
const D1 = `${PREFIX}/2026-10-01`
const D2 = `${PREFIX}/2026-10-02`

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitRun = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const revParse = (repo, ref) => {
  const r = gitRun(repo, 'rev-parse', '--verify', '--quiet', ref)
  return r.status === 0 ? r.stdout.trim() : null
}
// Removed when the test ends, retrying while something still writes there (a git process
// the test did not start, say).
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return d
}
// Automatic maintenance off in the test's own repositories, as loop-review's fetch has it: git
// 2.54 detaches the `maintenance run --auto` that commit and fetch start, and a background run
// still writing under .git races the cleanup.
const QUIET = [['gc.auto', '0'], ['maintenance.auto', 'false']]
const quiet = repo => { for (const [k, v] of QUIET) git(repo, 'config', k, v) }
const cloneQuiet = (src, dest) =>
  execFileSync('git', ['clone', '-q', '--no-local', ...QUIET.flatMap(([k, v]) => ['-c', `${k}=${v}`]), src, dest], { stdio: 'ignore' })
// A process standing in for the holder; started through a shell that exits at once, so the
// test runner is not its parent. loop-review never takes the lock: the holder only keeps the
// environment the same as every other loop test's. The cleanup kills it only while its start
// token is still the one read here, so a pid the kernel has since handed to another process is
// never signalled.
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}
// Every path under dirs with its content (symlinks as their target), so a before/after pair
// shows any write.
const snapshot = (...dirs) => {
  const out = {}
  for (const d of dirs) {
    if (!fs.existsSync(d)) { out[d] = null; continue }
    for (const rel of fs.readdirSync(d, { recursive: true }).sort()) {
      const f = path.join(d, rel)
      const st = fs.lstatSync(f)
      out[f] = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? `-> ${fs.readlinkSync(f)}` : fs.readFileSync(f, 'base64')
    }
  }
  return out
}
const refsOf = repo => git(repo, 'for-each-ref', '--format=%(objectname) %(refname)')

// <P> with one commit on main and a spine directory; <V> bound to it; <W> a full clone with
// refs/tech-lead/base at main, as loop-clone leaves it.
const project = (t, { objectFormat = null } = {}) => {
  const P = tmp(t, 'tl-review-p-')
  git(P, 'init', '-q', '-b', 'main', ...(objectFormat ? [`--object-format=${objectFormat}`] : []))
  quiet(P)
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  const cache = tmp(t, 'tl-review-c-')
  const e = { ...process.env, TECH_LEAD_CACHE: cache, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const paths = loopPaths(P, { env: e })
  fs.mkdirSync(paths.V, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(paths.V, 'identity.json'), JSON.stringify({ v: 1, R: paths.R }))
  cloneQuiet(P, paths.W)
  git(paths.W, 'update-ref', 'refs/tech-lead/base', 'refs/remotes/origin/main')
  return { P, R: paths.R, S, cache, e, paths, V: paths.V, W: paths.W, out: path.join(paths.V, 'out') }
}
// n commits on branch in <W>, started from `from` (default: the base); returns the tip.
let counter = 0
const work = (p, branch, n = 1, from = 'refs/tech-lead/base') => {
  git(p.W, 'switch', '-q', '-C', branch, from)
  for (let i = 0; i < n; i++) {
    const name = `f${++counter}.txt`
    fs.writeFileSync(path.join(p.W, name), `${name}\n`)
    git(p.W, 'add', name)
    git(p.W, 'commit', '-q', '-m', `work ${name}`)
  }
  return git(p.W, 'rev-parse', 'HEAD')
}
const bundleFile = (p, branch) => {
  const at = branch.lastIndexOf('/')
  return path.join(p.out, ...branch.slice(0, at).split('/'), `${branch.slice(at + 1)}.bundle`)
}
// The delivery bundle of branch, as the loop writes it; returns {file, tip}.
const bundle = (p, branch, extra = []) => {
  const file = bundleFile(p, branch)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.rmSync(file, { force: true })
  git(p.W, 'bundle', 'create', '-q', file, `refs/heads/${branch}`, ...extra, '^refs/tech-lead/base')
  return { file, tip: git(p.W, 'rev-parse', `refs/heads/${branch}`) }
}
const ledger = (p, ...rows) => fs.writeFileSync(path.join(p.S, 'LEDGER.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
// The owner's terminal: every line printed, every question asked, and the typed answers.
const tty = (...answers) => {
  const io = { isTTY: true, printed: [], asked: [] }
  io.print = s => io.printed.push(s)
  io.ask = async q => { io.asked.push(q); return answers.shift() }
  return io
}
const remote = branch => `refs/remotes/tech-lead/${branch}`
const retiredRef = branch => `refs/tech-lead/retired/${branch}`
const byBranch = results => Object.fromEntries(results.map(r => [r.branch, r]))
// The CLI without a terminal: stdin and stdout are pipes.
const cli = (e, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: e })
  const lines = r.stdout.trim() ? r.stdout.trim().split('\n') : []
  assert.equal(lines.length, 1, `${args.join(' ')}: expected one JSON line, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  return { status: r.status, out: JSON.parse(lines[0]), stderr: r.stderr }
}
// main() with an injected terminal; returns {status, out} from its one printed line.
const runMain = async (p, io, ...argv) => {
  const lines = []
  const status = await main(argv, { env: p.e, io, print: o => lines.push(o) })
  assert.equal(lines.length, 1, `${argv.join(' ')}: expected one output, got ${JSON.stringify(lines)}`)
  return { status, out: lines[0] }
}

test('paths prints {V, W, out} without a terminal and creates nothing', PROC, async t => {
  const P = tmp(t, 'tl-review-p-')
  git(P, 'init', '-q', '-b', 'main')
  quiet(P)
  fs.writeFileSync(path.join(P, 'a.txt'), 'a\n')
  git(P, 'add', '-A')
  git(P, 'commit', '-q', '-m', 'base')
  const cache = tmp(t, 'tl-review-c-')
  const e = { ...process.env, TECH_LEAD_CACHE: cache, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const want = loopPaths(P, { env: e })
  const beforeP = snapshot(P)
  const r = cli(e, 'paths', P)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.out, { V: want.V, W: want.W, out: path.join(want.V, 'out') })
  assert.deepEqual(reviewPaths(P, { env: e }), r.out)
  assert.deepEqual(fs.readdirSync(cache), [])
  assert.deepEqual(snapshot(P), beforeP)
  // A usage error is exit 2 with the usage line.
  const u = cli(e, 'paths')
  assert.equal(u.status, 2)
  assert.equal(u.out.state, 'error')
  assert.match(u.out.detail, /usage: loop-review\.mjs/)
  assert.equal(cli(e, 'paths', P, '--branch', D1).status, 2)
  assert.equal(cli(e, 'bogus', P).status, 2)
})

test('paths refuses a <V> bound to another repository', PROC, async t => {
  const p = project(t)
  fs.writeFileSync(path.join(p.V, 'identity.json'), JSON.stringify({ v: 1, R: '/somewhere/else' }))
  const r = cli(p.e, 'paths', p.P)
  assert.equal(r.status, 2)
  assert.match(r.out.detail, /identity-mismatch/)
})

test('fetch and retire refuse without a terminal (exit 2 needs-terminal) and read or write nothing', PROC, async t => {
  const p = project(t)
  work(p, D1, 2)
  const { tip } = bundle(p, D1)
  ledger(p, { iteration: 1, commits: [tip] })
  const before = snapshot(p.P, p.V)
  for (const args of [['fetch', p.P], ['fetch', p.P, '--branch', D1], ['fetch', p.P, '--trust-unrecorded'], ['retire', p.P, D1]]) {
    const r = cli(p.e, ...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.equal(r.out.state, 'error')
    assert.match(r.out.detail, /^needs-terminal: /)
  }
  await assert.rejects(fetchBundles(p.P, { env: p.e, io: { isTTY: false } }), /needs-terminal/)
  // The default io is the process's own terminal; a test run has none (stdout is the runner's pipe).
  if (!(process.stdin.isTTY && process.stdout.isTTY)) await assert.rejects(fetchBundles(p.P, { env: p.e }), /needs-terminal/)
  await assert.rejects(retire(p.P, D1, { env: p.e, io: { isTTY: false, ask: async () => D1 } }), /needs-terminal/)
  const r = await runMain(p, { isTTY: false }, 'retire', p.P, D1)
  assert.equal(r.status, 2)
  assert.match(r.out.detail, /needs-terminal/)
  assert.deepEqual(snapshot(p.P, p.V), before)
  assert.equal(revParse(p.P, remote(D1)), null)
})

test('fetch verifies each recorded bundle and fetches it into refs/remotes/tech-lead/<b> with fsck; again is current', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 2)
  bundle(p, D1)
  const t2 = work(p, D2, 1, `refs/heads/${D1}`) // chained on D1
  bundle(p, D2)
  // A temp file and a kept previous bundle are never fetched.
  fs.writeFileSync(path.join(p.out, 'tl', 'loop', '.tmp-1-0123456789abcdef.bundle'), 'partial')
  fs.copyFileSync(bundleFile(p, D1), `${bundleFile(p, D1)}.prev-20261001T000000Z`)
  // D1's tip is a recorded commit, D2's a recorded bundle tip.
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [], bundles: [{ branch: D2, tip: t2, file: 'out/x', sha256: 'f'.repeat(64), why: 'commit' }] })
  const head = git(p.P, 'rev-parse', 'HEAD'), status = git(p.P, 'status', '--porcelain=v1', '--ignored')
  const index = fs.readFileSync(path.join(p.P, '.git', 'index'))
  const io = tty()
  const r = await fetchBundles(p.P, { env: p.e, io })
  assert.equal(r.state, 'fetched', JSON.stringify(r))
  assert.deepEqual(r.results.map(x => x.branch), [D1, D2])
  const res = byBranch(r.results)
  assert.equal(res[D1].state, 'fetched')
  assert.equal(res[D1].tip, t1)
  assert.equal(res[D1].ref, remote(D1))
  assert.equal(res[D1].trusted, 'ledger')
  assert.equal(res[D1].previous, null)
  assert.equal(res[D1].file, bundleFile(p, D1))
  assert.equal(res[D2].state, 'fetched')
  assert.equal(res[D2].trusted, 'ledger')
  assert.equal(revParse(p.P, remote(D1)), t1)
  assert.equal(revParse(p.P, remote(D2)), t2)
  git(p.P, 'fsck', '--strict', '--no-dangling')
  // Nothing else in <P> moved: HEAD, its branch, the index, the work tree; no FETCH_HEAD and no tags.
  assert.equal(git(p.P, 'rev-parse', 'HEAD'), head)
  assert.equal(git(p.P, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  assert.deepEqual(fs.readFileSync(path.join(p.P, '.git', 'index')), index)
  assert.equal(git(p.P, 'status', '--porcelain=v1', '--ignored'), status)
  assert.equal(fs.existsSync(path.join(p.P, '.git', 'FETCH_HEAD')), false)
  assert.equal(git(p.P, 'tag', '--list'), '')
  assert.ok(io.printed.some(s => s.includes(remote(D1))), io.printed.join('\n'))
  // Fetching again changes nothing.
  const refs = refsOf(p.P)
  const again = await fetchBundles(p.P, { env: p.e, io: tty() })
  assert.equal(again.state, 'fetched')
  assert.deepEqual(again.results.map(x => [x.branch, x.state]), [[D1, 'current'], [D2, 'current']])
  assert.equal(refsOf(p.P), refs)
  // A new commit on D2 fast-forwards its remote-tracking ref.
  const t3 = work(p, D2, 1, `refs/heads/${D2}`)
  bundle(p, D2)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 3, commits: [t3] })
  const ff = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D2 })
  assert.equal(ff.state, 'fetched')
  assert.deepEqual(ff.results.map(x => [x.branch, x.state, x.previous]), [[D2, 'fetched', t2]])
  assert.equal(revParse(p.P, remote(D2)), t3)
})

// An owner's <P> in which git would run maintenance after every fetch: automatic maintenance
// on, and the commit-graph task forced (a negative auto value runs it on every --auto run).
const MAINTAIN = [['maintenance.auto', 'true'], ['gc.auto', '6700'], ['maintenance.commit-graph.enabled', 'true'], ['maintenance.commit-graph.auto', '-1']]
// What a maintenance run leaves in a repository: its lock, gc's pid file and log, the commit-graph.
const maintenanceLeft = repo => ['objects/maintenance.lock', 'gc.pid', 'gc.log', 'objects/info/commit-graph', 'objects/info/commit-graphs']
  .filter(rel => fs.existsSync(path.join(repo, '.git', rel)))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('fetch starts no automatic maintenance in <P>: no maintenance task runs, and no maintenance process or lock is left', PROC, async t => {
  const p = project(t)
  for (const [k, v] of MAINTAIN) git(p.P, 'config', k, v)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  const t2 = work(p, D2, 1)
  bundle(p, D2)
  ledger(p, { iteration: 1, commits: [t1, t2] })
  // Control: a plain fetch of the same bundle into a copy of <P> configured the same runs the task.
  const ctl = path.join(tmp(t, 'tl-review-ctl-'), 'ctl')
  execFileSync('git', ['clone', '-q', '--no-local', p.P, ctl], { stdio: 'ignore' })
  for (const [k, v] of [...MAINTAIN, ['maintenance.autoDetach', 'false']]) git(ctl, 'config', k, v)
  assert.deepEqual(maintenanceLeft(ctl), [])
  git(ctl, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', bundleFile(p, D1), `refs/heads/${D1}:${remote(D1)}`)
  assert.notDeepEqual(maintenanceLeft(ctl), [], 'control: a plain fetch runs maintenance')
  // Maintenance in the foreground: a run would have finished before the fetch returned.
  git(p.P, 'config', 'maintenance.autoDetach', 'false')
  const r1 = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D1 })
  assert.equal(r1.results[0].state, 'fetched', JSON.stringify(r1))
  assert.deepEqual(maintenanceLeft(p.P), [])
  // Detached, git's default: nothing appears afterwards either.
  git(p.P, 'config', '--unset', 'maintenance.autoDetach')
  const r2 = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D2 })
  assert.equal(r2.results[0].state, 'fetched', JSON.stringify(r2))
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(maintenanceLeft(p.P), [], `${i * 100} ms after the fetch`)
    await sleep(100)
  }
})

// A stand-in `git` first on PATH: it logs each argument list and runs the real git; with
// `old`, it refuses --no-auto-maintenance the way a git without that option does.
const loggingGit = (t, { old = false } = {}) => {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const dir = tmp(t, 'tl-review-git-')
  const log = path.join(dir, 'argv.log')
  const bt = String.fromCharCode(96)
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'git'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    ...(old ? [
      'for a in "$@"; do',
      '  if [ "$a" = --no-auto-maintenance ]; then',
      `    echo "error: unknown option \\${bt}no-auto-maintenance'" >&2`,
      '    exit 129',
      '  fi',
      'done',
    ] : []),
    `exec '${real}' "$@"`,
    '',
  ].join('\n'))
  fs.chmodSync(path.join(dir, 'bin', 'git'), 0o755)
  return { log, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` }
}

test('fetch passes -c maintenance.auto=false -c gc.auto=0 and --no-auto-maintenance; a git without the option gets the config alone', PROC, async t => {
  for (const old of [false, true]) {
    const p = project(t)
    for (const [k, v] of [...MAINTAIN, ['maintenance.autoDetach', 'false']]) git(p.P, 'config', k, v)
    const tip = work(p, D1, 1)
    bundle(p, D1)
    ledger(p, { iteration: 1, commits: [tip] })
    const fake = loggingGit(t, { old })
    if (old) {
      const probe = spawnSync('git', ['-C', p.P, 'fetch', '--no-auto-maintenance', '-h'], { encoding: 'utf8', env: { ...process.env, PATH: fake.PATH } })
      assert.equal(probe.status, 129)
      assert.match(probe.stderr, /^error: unknown option .no-auto-maintenance'$/m, 'control: the stand-in lacks the option')
    }
    const saved = process.env.PATH
    process.env.PATH = fake.PATH
    let r
    try {
      r = await fetchBundles(p.P, { env: p.e, io: tty() })
    } finally {
      process.env.PATH = saved
    }
    assert.equal(r.state, 'fetched', JSON.stringify(r))
    assert.equal(revParse(p.P, remote(D1)), tip)
    const fetches = fs.readFileSync(fake.log, 'utf8').split('\n').filter(l => / fetch /.test(l) && !/ -h$/.test(l))
    assert.equal(fetches.length, 1, fetches.join('\n'))
    const [cfg, args] = fetches[0].split(' fetch ')
    assert.match(cfg, / -c maintenance\.auto=false -c gc\.auto=0$/, fetches[0])
    if (old) assert.doesNotMatch(args, /--no-auto-maintenance/)
    else assert.match(args, /^--no-auto-maintenance /)
    assert.deepEqual(maintenanceLeft(p.P), [], old ? 'the config alone keeps maintenance off' : 'no maintenance')
  }
})

test('fetch fetches with fsckObjects: a recorded bundle holding a malformed commit is refused', PROC, async t => {
  const p = project(t)
  const base = git(p.W, 'rev-parse', 'refs/tech-lead/base')
  const tree = git(p.W, 'rev-parse', `${base}^{tree}`)
  // A commit git stores but fsck rejects (missingSpaceBeforeEmail).
  const body = `tree ${tree}\nparent ${base}\nauthor t<t@example.com> 1700000000 +0000\ncommitter t <t@example.com> 1700000000 +0000\n\nbad\n`
  const bad = execFileSync('git', ['-C', p.W, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { input: body, encoding: 'utf8' }).trim()
  git(p.W, 'update-ref', `refs/heads/${D1}`, bad)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [bad] })
  const r = await fetchBundles(p.P, { env: p.e, io: tty() })
  assert.equal(r.state, 'refused')
  assert.equal(r.results[0].state, 'refused')
  assert.equal(r.results[0].reason, 'fetch-failed')
  assert.match(r.results[0].detail, /missingSpaceBeforeEmail|fsck/i)
  assert.equal(revParse(p.P, remote(D1)), null)
  // Without fsck the same fetch would have taken it: the check is what refused it.
  const copy = tmp(t, 'tl-review-copy-')
  cloneQuiet(p.P, copy)
  git(copy, 'fetch', '-q', '--no-tags', bundleFile(p, D1), `refs/heads/${D1}:${remote(D1)}`)
  assert.equal(revParse(copy, remote(D1)), bad)
})

test('fetch refuses an unrecorded tip unless --trust-unrecorded; a tip already in <P> is trusted', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: ['0'.repeat(40)], saves: [{ sha: t1 }] }) // a save sha is not a commit
  const before = refsOf(p.P)
  const r = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(r.status, 3)
  assert.equal(r.out.state, 'refused')
  assert.equal(r.out.results[0].reason, 'unrecorded')
  assert.equal(r.out.results[0].tip, t1)
  assert.equal(refsOf(p.P), before)
  const trusted = await runMain(p, tty(), 'fetch', p.P, '--trust-unrecorded')
  assert.equal(trusted.status, 0, JSON.stringify(trusted.out))
  assert.equal(trusted.out.state, 'fetched')
  assert.equal(trusted.out.results[0].trusted, 'flag')
  assert.equal(revParse(p.P, remote(D1)), t1)
  // A tip some ref of <P> already reaches needs no record (the owner merged it, say).
  const t2 = work(p, D2, 1)
  bundle(p, D2)
  git(p.P, 'fetch', '-q', '--no-tags', p.W, `refs/heads/${D2}:refs/heads/merged-by-owner`)
  const r2 = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D2 })
  assert.equal(r2.state, 'fetched')
  assert.equal(r2.results[0].trusted, 'repo')
  assert.equal(revParse(p.P, remote(D2)), t2)
})

test('fetch refuses a corrupt bundle, a bundle whose head does not match its path, and a non-file', PROC, async t => {
  const p = project(t)
  // Pack data damaged near the end: the header reads and `bundle verify` passes, the fsck
  // fetch fails.
  const big = 'x'.repeat(50000).replace(/x/g, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)))
  git(p.W, 'switch', '-q', '-C', D1, 'refs/tech-lead/base')
  fs.writeFileSync(path.join(p.W, 'big.txt'), big)
  git(p.W, 'add', 'big.txt')
  git(p.W, 'commit', '-q', '-m', 'big')
  const { file, tip } = bundle(p, D1)
  const buf = fs.readFileSync(file)
  for (let i = buf.length - 200; i < buf.length - 190; i++) buf[i] ^= 0xff
  fs.writeFileSync(file, buf)
  // Not a bundle at all.
  const junk = bundleFile(p, `${PREFIX}/2026-09-01`)
  fs.writeFileSync(junk, 'not a bundle\n\n')
  // One head, but another branch's.
  const t2 = work(p, D2, 1)
  const wrong = bundleFile(p, `${PREFIX}/2026-09-02`)
  git(p.W, 'bundle', 'create', '-q', wrong, `refs/heads/${D2}`, '^refs/tech-lead/base')
  // Two heads.
  const two = bundleFile(p, `${PREFIX}/2026-09-03`)
  git(p.W, 'branch', '-q', `${PREFIX}/2026-09-03`, D2)
  git(p.W, 'bundle', 'create', '-q', two, `refs/heads/${PREFIX}/2026-09-03`, `refs/heads/${D2}`, '^refs/tech-lead/base')
  // A symlink at a bundle's name.
  fs.symlinkSync(bundleFile(p, D2), bundleFile(p, `${PREFIX}/2026-09-04`))
  ledger(p, { iteration: 1, commits: [tip, t2] })
  const before = refsOf(p.P)
  const scratch = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('tech-lead-review-')).sort()
  const scratchBefore = scratch()
  const r = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(r.status, 3)
  // The checks and the fetch read a private copy, removed afterwards; messages name the bundle.
  assert.deepEqual(scratch(), scratchBefore)
  const res = byBranch(r.out.results)
  assert.ok(res[`${PREFIX}/2026-09-01`].detail.includes(junk), res[`${PREFIX}/2026-09-01`].detail)
  assert.ok(!res[`${PREFIX}/2026-09-01`].detail.includes('tech-lead-review-'), res[`${PREFIX}/2026-09-01`].detail)
  assert.deepEqual(Object.keys(res).sort(), [`${PREFIX}/2026-09-01`, `${PREFIX}/2026-09-02`, `${PREFIX}/2026-09-03`, `${PREFIX}/2026-09-04`, D1])
  assert.equal(res[D1].reason, 'fetch-failed')
  assert.equal(res[`${PREFIX}/2026-09-01`].reason, 'corrupt')
  assert.equal(res[`${PREFIX}/2026-09-02`].reason, 'head-mismatch')
  assert.equal(res[`${PREFIX}/2026-09-03`].reason, 'head-mismatch')
  assert.equal(res[`${PREFIX}/2026-09-04`].reason, 'not-a-file')
  for (const x of r.out.results) assert.equal(x.state, 'refused')
  assert.equal(refsOf(p.P), before)
  // A truncated bundle fails `bundle verify` (or the fetch) and is refused too.
  fs.writeFileSync(file, buf.subarray(0, Math.floor(buf.length / 2)))
  const r2 = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D1 })
  assert.equal(r2.state, 'refused')
  assert.match(r2.results[0].reason, /^(verify-failed|fetch-failed)$/)
  assert.equal(refsOf(p.P), before)
})

test('fetch refuses a non-fast-forward and leaves the remote-tracking ref where it was', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  assert.equal(revParse(p.P, remote(D1)), t1)
  // D1 rewritten: a commit that does not descend from the fetched tip.
  const t1b = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t1b] })
  const r = await runMain(p, tty(), 'fetch', p.P, '--branch', D1)
  assert.equal(r.status, 3)
  assert.equal(r.out.results[0].reason, 'non-fast-forward')
  assert.equal(r.out.results[0].previous, t1)
  assert.equal(revParse(p.P, remote(D1)), t1)
})

test('fetch refuses a bundle whose prerequisite <P> lacks', PROC, async t => {
  const p = project(t)
  // The base moved in <W> past anything <P> has (as when <P>'s base was rewound).
  git(p.W, 'switch', '-q', '-C', 'moved', 'refs/tech-lead/base')
  fs.writeFileSync(path.join(p.W, 'moved.txt'), 'moved\n')
  git(p.W, 'add', 'moved.txt')
  git(p.W, 'commit', '-q', '-m', 'moved base')
  const missing = git(p.W, 'rev-parse', 'HEAD')
  git(p.W, 'update-ref', 'refs/tech-lead/base', missing)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  const before = snapshot(p.P)
  const r = await fetchBundles(p.P, { env: p.e, io: tty() })
  assert.equal(r.state, 'refused')
  assert.equal(r.results[0].reason, 'missing-prerequisite')
  assert.deepEqual(r.results[0].missing, [missing])
  assert.deepEqual(snapshot(p.P), before)
})

test('fetch --branch takes one bundle: a missing one is refused, a bad name is a usage error, no bundles is an empty fetch', PROC, async t => {
  const p = project(t)
  const empty = await fetchBundles(p.P, { env: p.e, io: tty() })
  assert.deepEqual(empty, { state: 'fetched', results: [] })
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  work(p, D2, 1)
  bundle(p, D2)
  ledger(p, { iteration: 1, commits: [t1] })
  const one = await fetchBundles(p.P, { env: p.e, io: tty(), branch: D1 })
  assert.equal(one.state, 'fetched')
  assert.deepEqual(one.results.map(x => x.branch), [D1])
  assert.equal(revParse(p.P, remote(D2)), null)
  const none = await runMain(p, tty(), 'fetch', p.P, '--branch', `${PREFIX}/2026-01-01`)
  assert.equal(none.status, 3)
  assert.equal(none.out.results[0].reason, 'no-bundle')
  for (const argv of [['fetch', p.P, '--branch', 'main'], ['fetch', p.P, '--branch', '-x/2026-10-01'], ['fetch', p.P, '--branch'], ['fetch'], ['fetch', p.P, p.P], ['fetch', p.P, '--bogus']]) {
    const u = await runMain(p, tty(), ...argv)
    assert.equal(u.status, 2, argv.join(' '))
    assert.equal(u.out.state, 'error')
  }
})

test('retire writes refs/tech-lead/retired/<branch> in <P> only after the owner types the branch name, and notes a descendant branch', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  const t2 = work(p, D2, 1, `refs/heads/${D1}`) // D2 descends from D1
  bundle(p, D2)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t2] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  const before = snapshot(p.P, p.V)
  // A wrong answer writes nothing.
  const wrong = tty(D2)
  const no = await retire(p.P, D1, { env: p.e, io: wrong })
  assert.equal(no.state, 'refused')
  assert.equal(no.reason, 'not-confirmed')
  assert.ok(wrong.asked[0].includes(D1), wrong.asked[0])
  assert.ok(wrong.printed.join('\n').includes(t1), wrong.printed.join('\n'))
  assert.deepEqual(snapshot(p.P, p.V), before)
  const viaMain = await runMain(p, tty('nope'), 'retire', p.P, D1)
  assert.equal(viaMain.status, 3)
  assert.equal(viaMain.out.reason, 'not-confirmed')
  // The typed name retires it at the tip of refs/remotes/tech-lead/<branch>.
  const io = tty(`${D1}\n`)
  const r = await retire(p.P, D1, { env: p.e, io })
  assert.equal(r.state, 'retired', JSON.stringify(r))
  assert.equal(r.branch, D1)
  assert.equal(r.ref, retiredRef(D1))
  assert.equal(r.tip, t1)
  assert.equal(r.from, 'remote')
  assert.equal(r.previous, null)
  assert.deepEqual(r.descendants, [remote(D2)])
  assert.ok(r.notes.some(n => n.includes(D2)), JSON.stringify(r.notes))
  assert.ok(io.printed.join('\n').includes(D2), io.printed.join('\n'))
  assert.equal(revParse(p.P, retiredRef(D1)), t1)
  // Nothing else in <P> or <V> changed.
  const after = snapshot(p.P, p.V)
  const changed = Object.keys(after).filter(k => after[k] !== before[k])
  assert.ok(changed.every(k => k.startsWith(path.join(p.P, '.git'))), changed.join('\n'))
  assert.equal(git(p.P, 'rev-parse', 'HEAD'), git(p.P, 'rev-parse', 'refs/heads/main'))
  // Retiring it again at the same tip is a no-op that asks nothing.
  const again = tty()
  const same = await retire(p.P, D1, { env: p.e, io: again })
  assert.equal(same.state, 'retired')
  assert.equal(same.unchanged, true)
  assert.deepEqual(again.asked, [])
})

test('retire takes the bundle tip when <P> has no remote-tracking ref, and refuses a tip <P> does not have', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  // Never fetched: the bundle's tip is not in <P>, so no retired ref can name it.
  const before = snapshot(p.P)
  const no = await runMain(p, tty(D1), 'retire', p.P, D1)
  assert.equal(no.status, 3)
  assert.equal(no.out.reason, 'tip-not-in-repo')
  assert.match(no.out.detail, /fetch/)
  assert.deepEqual(snapshot(p.P), before)
  // Fetched, then the remote-tracking ref deleted: the bundle's tip is used.
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  git(p.P, 'branch', '-q', 'keep', remote(D1))
  git(p.P, 'update-ref', '-d', remote(D1))
  const r = await retire(p.P, D1, { env: p.e, io: tty(D1) })
  assert.equal(r.state, 'retired')
  assert.equal(r.from, 'bundle')
  assert.equal(r.tip, t1)
  assert.deepEqual(r.descendants, [])
  assert.equal(revParse(p.P, retiredRef(D1)), t1)
  // No ref and no bundle: nothing to retire.
  const gone = await runMain(p, tty(D2), 'retire', p.P, D2)
  assert.equal(gone.status, 3)
  assert.equal(gone.out.reason, 'no-tip')
  // A name that is no dated loop branch is a usage error.
  for (const argv of [['retire', p.P, 'main'], ['retire', p.P], ['retire', p.P, D1, D2]]) {
    const u = await runMain(p, tty(), ...argv)
    assert.equal(u.status, 2, argv.join(' '))
  }
})

// --- review round: current only after the checks (Cg3#7); retire keeps every rejected tip
// (R27, Cg3#8); the review flow after a same-day retire (prose-checks#2) ---

// A commit holding enough random bytes that its pack can be damaged well past the header.
const bigWork = (p, branch, from = 'refs/tech-lead/base') => {
  git(p.W, 'switch', '-q', '-C', branch, from)
  fs.writeFileSync(path.join(p.W, `big${++counter}.txt`), crypto.randomBytes(30000).toString('base64'))
  git(p.W, 'add', '-A')
  git(p.W, 'commit', '-q', '-m', 'big work')
  return git(p.W, 'rev-parse', 'HEAD')
}
const headerEnd = buf => buf.indexOf('\n\n') + 2
const tmpPacks = repo => fs.readdirSync(path.join(repo, '.git', 'objects', 'pack')).filter(n => n.startsWith('tmp_'))

test('fetch says current only after every check: a current tip with a damaged pack or a missing prerequisite is refused', PROC, async t => {
  const p = project(t)
  const t1 = bigWork(p, D1)
  const { file } = bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).results[0].state, 'fetched')
  const good = fs.readFileSync(file)
  const refs = refsOf(p.P)
  assert.deepEqual((await fetchBundles(p.P, { env: p.e, io: tty() })).results.map(r => r.state), ['current'])
  // The same header, one pack byte flipped: git's fetch would read nothing (<P> has every object).
  const damaged = Buffer.from(good)
  damaged[headerEnd(good) + 200] ^= 0xff
  fs.writeFileSync(file, damaged)
  const r1 = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(r1.status, 3, JSON.stringify(r1.out))
  assert.equal(r1.out.results[0].reason, 'verify-failed', JSON.stringify(r1.out.results[0]))
  // A prerequisite <P> lacks, written into the header.
  const fake = 'e'.repeat(40)
  const end = headerEnd(good)
  const lines = good.subarray(0, end - 1).toString('latin1').split('\n')
  lines.splice(1, 0, `-${fake} fake prerequisite`)
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'latin1'), good.subarray(end - 1)]))
  const r2 = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(r2.status, 3)
  assert.equal(r2.out.results[0].reason, 'missing-prerequisite')
  assert.deepEqual(r2.out.results[0].missing, [fake])
  // Intact again: current. <P>'s refs never moved and no temporary pack was left in it.
  fs.writeFileSync(file, good)
  assert.deepEqual((await fetchBundles(p.P, { env: p.e, io: tty() })).results.map(r => r.state), ['current'])
  assert.equal(refsOf(p.P), refs)
  assert.deepEqual(tmpPacks(p.P), [])
  git(p.P, 'fsck', '--strict', '--no-dangling')
})

test('retire at another tip keeps the earlier one under refs/tech-lead/retired/<branch>@<sha12> (R27)', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  assert.equal((await retire(p.P, D1, { env: p.e, io: tty(D1) })).state, 'retired')
  // The owner points the remote-tracking ref at other work and retires again.
  const t2 = work(p, D1, 1)
  git(p.P, 'fetch', '-q', '--no-tags', p.W, `+refs/heads/${D1}:${remote(D1)}`)
  const io = tty(D1)
  const r = await retire(p.P, D1, { env: p.e, io })
  assert.equal(r.state, 'retired', JSON.stringify(r))
  assert.equal(r.previous, t1)
  assert.equal(r.tip, t2)
  const kept = `${retiredRef(D1)}@${t1.slice(0, 12)}`
  assert.equal(r.kept, kept)
  assert.equal(revParse(p.P, kept), t1, 'the earlier rejection keeps its own ref')
  assert.equal(revParse(p.P, retiredRef(D1)), t2)
  assert.ok(r.notes.some(n => n.includes(kept)), JSON.stringify(r.notes))
  assert.ok(io.printed.join('\n').includes(kept), io.printed.join('\n'))
  // Every retired tip of the branch counts in the clone: the refresh brings the kept ref too.
  const shown = git(p.P, 'for-each-ref', '--format=%(refname)', 'refs/tech-lead/retired/').split('\n')
  assert.deepEqual(shown, [retiredRef(D1), kept])
  // A third retire at the current tip changes nothing.
  assert.equal((await retire(p.P, D1, { env: p.e, io: tty() })).unchanged, true)
})

test('after a same-day retire, fetch replaces the remote ref of the rejected work with the restarted branch, and retire then takes the new tip', PROC, async t => {
  const p = project(t)
  // Firing 1 commits; the owner fetches and retires it.
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  assert.equal((await retire(p.P, D1, { env: p.e, io: tty(D1) })).tip, t1)
  // Firing 2, the same day: the branch restarts from the base (R11) and commits new work.
  const t2 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t2] })
  const io = tty()
  const r = await runMain(p, io, 'fetch', p.P)
  assert.equal(r.status, 0, JSON.stringify(r.out))
  const res = r.out.results[0]
  assert.equal(res.state, 'fetched', JSON.stringify(res))
  assert.equal(res.previous, t1)
  assert.equal(res.replaced, t1)
  assert.equal(revParse(p.P, remote(D1)), t2)
  assert.equal(git(p.P, 'for-each-ref', '--format=%(refname)', 'refs/tech-lead/review-tmp/'), '', 'no scratch ref left')
  // A second retire now takes the restarted tip and keeps the first.
  const again = await retire(p.P, D1, { env: p.e, io: tty(D1) })
  assert.equal(again.tip, t2)
  assert.equal(again.unchanged, undefined)
  assert.equal(revParse(p.P, `${retiredRef(D1)}@${t1.slice(0, 12)}`), t1)
  // The retired bundle itself is never fetched again: retired, not a refusal.
  const same = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(same.status, 0)
  assert.equal(same.out.results[0].state, 'retired', JSON.stringify(same.out.results[0]))
  // Work on top of a retired tip (a bundle written before the retirement reached the clone)
  // never moves the remote ref either, even though it fast-forwards.
  const t3 = work(p, D1, 1, `refs/heads/${D1}`)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t2] }, { iteration: 3, commits: [t3] })
  const on = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(on.status, 0)
  assert.equal(on.out.results[0].state, 'retired', JSON.stringify(on.out.results[0]))
  assert.equal(revParse(p.P, remote(D1)), t2)
  assert.equal(git(p.P, 'for-each-ref', '--format=%(refname)', 'refs/tech-lead/review-tmp/'), '')
})

test('a remote ref that names work nobody retired is still never replaced (non-fast-forward)', PROC, async t => {
  const p = project(t)
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  // D1 was retired once at another, unrelated tip: the remote ref's work was never rejected.
  const other = work(p, `${PREFIX}/2026-09-01`, 1)
  git(p.P, 'fetch', '-q', '--no-tags', p.W, `refs/heads/${PREFIX}/2026-09-01:refs/tech-lead/retired/${D1}`)
  assert.equal(revParse(p.P, retiredRef(D1)), other)
  const t2 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1, t2] })
  const r = await runMain(p, tty(), 'fetch', p.P, '--branch', D1)
  assert.equal(r.status, 3)
  assert.equal(r.out.results[0].reason, 'non-fast-forward', JSON.stringify(r.out.results[0]))
  assert.equal(revParse(p.P, remote(D1)), t1)
  assert.equal(git(p.P, 'for-each-ref', '--format=%(refname)', 'refs/tech-lead/review-tmp/'), '')
})

// --- fix round 2: the pack check repository takes <P>'s object format (code#4); a retirement
// the base contains no longer withholds later work (code#5, R11) ---

test('fetch checks the pack of a SHA-256 <P> in a private repository of the same object format: a valid bundle fetched twice reads current (code#4)', PROC, async t => {
  const p = project(t, { objectFormat: 'sha256' })
  assert.equal(git(p.P, 'rev-parse', '--show-object-format'), 'sha256')
  const t1 = work(p, D1, 2)
  assert.equal(t1.length, 64)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  const first = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(first.status, 0, JSON.stringify(first.out))
  assert.equal(first.out.results[0].state, 'fetched')
  // <P> now holds the tip, so the private repository reads the whole pack.
  const second = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(second.status, 0, JSON.stringify(second.out))
  assert.equal(second.out.results[0].state, 'current', JSON.stringify(second.out.results[0]))
  assert.equal(revParse(p.P, remote(D1)), t1)
})

// LOOP.md naming the base the loop branches from (the clone's refs/tech-lead/base).
const loopMdBase = (p, base) => fs.writeFileSync(path.join(p.S, 'LOOP.md'), `---\nbase: ${base}\nverify:\n  - "true"\n---\n`)

test('a retired tip the base contains withholds nothing: after the owner merges it, the next work on the branch is fetched (code#5, R11)', PROC, async t => {
  for (const how of ['merge', 'squash']) {
    await t.test(how, async st => {
      const p = project(st)
      loopMdBase(p, 'main')
      const t1 = work(p, D1, 1)
      bundle(p, D1)
      ledger(p, { iteration: 1, commits: [t1] })
      assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
      assert.equal((await retire(p.P, D1, { env: p.e, io: tty(D1) })).tip, t1)
      // The owner changes their mind and merges the retired work into the base after all.
      if (how === 'merge') git(p.P, 'merge', '-q', '--no-ff', '-m', 'merge day 1', remote(D1))
      else {
        git(p.P, 'merge', '-q', '--squash', remote(D1))
        git(p.P, 'commit', '-q', '-m', 'squash day 1')
        assert.notEqual(gitRun(p.P, 'merge-base', '--is-ancestor', t1, 'main').status, 0)
      }
      // The clone no longer treats t1 as retired (the base contains it) and commits on top.
      const t2 = work(p, D1, 1, `refs/heads/${D1}`)
      bundle(p, D1)
      ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t2] })
      const before = refsOf(p.P)
      const r = await runMain(p, tty(), 'fetch', p.P)
      assert.equal(r.status, 0, JSON.stringify(r.out))
      assert.equal(r.out.results[0].state, 'fetched', JSON.stringify(r.out.results[0]))
      assert.equal(revParse(p.P, remote(D1)), t2)
      assert.equal(revParse(p.P, retiredRef(D1)), t1, 'the retired ref itself stays')
      assert.equal(git(p.P, 'for-each-ref', '--format=%(refname)', 'refs/tech-lead/review-tmp/'), '')
      assert.notEqual(refsOf(p.P), before)
    })
  }
})

test('a retirement the base does not contain still withholds later work when a base is named (control for code#5)', PROC, async t => {
  const p = project(t)
  loopMdBase(p, 'main')
  const t1 = work(p, D1, 1)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] })
  assert.equal((await fetchBundles(p.P, { env: p.e, io: tty() })).state, 'fetched')
  assert.equal((await retire(p.P, D1, { env: p.e, io: tty(D1) })).tip, t1)
  const t2 = work(p, D1, 1, `refs/heads/${D1}`)
  bundle(p, D1)
  ledger(p, { iteration: 1, commits: [t1] }, { iteration: 2, commits: [t2] })
  const r = await runMain(p, tty(), 'fetch', p.P)
  assert.equal(r.status, 0)
  assert.equal(r.out.results[0].state, 'retired', JSON.stringify(r.out.results[0]))
  assert.equal(revParse(p.P, remote(D1)), t1)
})

// The test harness's cleanup (review round, contracts-tests#7): the sleeper's hook signals its
// pid only while the pid still names the sleeper, since under several concurrent suites the pid
// counter can wrap before the hook. A ps (TECH_LEAD_PS) that reads every live process as one
// started in 1970 stands in for the kernel handing the pid to another process.
test('contracts-tests#7: the sleeper cleanup kills its own process, and leaves alone a pid that names another process by then', { skip: process.platform !== 'darwin' && 'the start token reads ps on darwin only' }, async t => {
  const waitGone = async pid => {
    for (let i = 0; i < 60 && startToken(pid).state !== 'gone'; i++) await new Promise(resolve => setTimeout(resolve, 50))
    return startToken(pid).state === 'gone'
  }
  let pid, start
  await t.test('the pid reads as another process when the test ends', st => {
    pid = sleeper(st)
    start = startToken(pid).token
    const file = path.join(tmp(st, 'tl-review-ps-'), 'ps')
    fs.writeFileSync(file, '#!/bin/sh\necho "S Thu Jan 1 00:00:00 1970"\n', { mode: 0o755 })
    const before = process.env.TECH_LEAD_PS
    process.env.TECH_LEAD_PS = file
    st.after(() => { if (before === undefined) delete process.env.TECH_LEAD_PS; else process.env.TECH_LEAD_PS = before })
  })
  t.after(() => { if (isAlive({ pid, start }) === true) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  assert.equal(isAlive({ pid, start }), true, `the cleanup killed pid ${pid}, which it could not prove its own`)
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitGone(pid))
  let own
  await t.test('the pid still names the sleeper when the test ends', st => { own = sleeper(st) })
  assert.ok(await waitGone(own), `the cleanup left its own sleeper ${own} running`)
})
