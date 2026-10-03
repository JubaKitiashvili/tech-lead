// tests/loop/interrupt-fixture.mjs
// Shared fixture of the clone interruption tests (tests/loop/loop-interrupt-clone-*.test.mjs;
// brief section 19, the stage 0c-2 acceptance "interruption tests at each persistence boundary
// pass"). A firing is tests/fixtures/firing-driver.mjs in its `firing` mode: its own holder, in
// a process group of its own, playing the prose's part through the real helper CLIs. A firing
// is killed at a prose boundary by SIGKILL to its process group at a driver stop, or inside a
// helper by TECH_LEAD_FAULT passed to that one call (the driver then waits to be killed, as a
// session that died with its helper). The recovering firing runs with stop none, then a third
// firing checks that recovery is idempotent; assertRecovered(fx, expect) checks invariants
// I1-I8 after each.
//
// Real temporary repositories and real processes; the hermetic environment of
// tests/loop/loop-clone-fixture.mjs (imported for it and for its plain-git helpers).
//
// Cleanup never signals a process that only reused an id (review round, Cg4#2 and
// contracts-tests#7): a pid is killed only while its start token is the recorded one, and a
// process group only while groupIsOurs says the id still names the group the test made.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { git, snapshot, tmp, write } from './loop-clone-fixture.mjs'
import { groupAlive, isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'

export { git, snapshot, tmp, write }
export const T = { timeout: 90000 }
// The rows of one file run this many at a time (each in a project of its own).
export const ROWS = { concurrency: 2 }
export const DRIVER = path.join(ROOT, 'tests', 'fixtures', 'firing-driver.mjs')
export const SCRIPTS = path.join(ROOT, 'scripts')
export const FAKE_CODEX = path.join(ROOT, 'tests', 'fixtures', 'codex', 'scripts', 'codex-companion.mjs')
export const PREFIX = 'tl'
export const D1 = '2026-10-01'
export const D2 = '2026-10-02'
export const D3 = '2026-10-03'
export const DOT = String.fromCharCode(0xb7)
export const BASE_FILES = {
  '.gitignore': 'node_modules/\nbuild/\n*.log\n', 'a.txt': 'a\n', 'b.txt': 'b\n', 'src/app.js': 'app\n',
}
// verify[0] leaves an ignored artifact; nothing a check sees changes.
export const VERIFY = ['mkdir -p build && echo built > build/out.txt']
export const ITEMS = ['item A', 'item B', 'item C', 'item D']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function waitFor(fn, ms = 10000) {
  const deadline = Date.now() + ms
  let v = fn()
  while (!v && Date.now() < deadline) {
    await sleep(25)
    v = fn()
  }
  return v
}
export const gone = pid => startToken(pid).state === 'gone'

export const loopMd = ({ verify = VERIFY, scope = ['./'] } = {}) =>
  `---\nlevel: 1\nverify:\n${verify.map(v => `  - ${JSON.stringify(v)}`).join('\n')}\nscope:\n${scope.map(s => `  - ${s}`).join('\n')}\n---\n`
export const itemLine = title => `- [ ] P1 ${DOT} ${title} ${DOT} class: mechanical`
// An item is a title, or {title, sub: [its indented sub-bullet lines]}.
const itemLines = i => (typeof i === 'string' ? [itemLine(i)] : [itemLine(i.title), ...(i.sub ?? [])])
export const stateMd = (items = ITEMS) =>
  ['# Proj - Loop State', '', '## Now', '(empty)', '', '## Backlog', ...(items.length ? items.flatMap(itemLines) : ['(empty)']), '',
    '## Needs decision', '(empty)', '', '## Blocked', '(empty)', '', '## Done', '(empty)', '', '## Last run', '(never run)', ''].join('\n')

// <P> with files committed on main, its spine (LOOP.md, STATE.md with `items` in ## Backlog), a
// cache root and a control directory for the driver's gates.
export function project(t, { files = BASE_FILES, verify = VERIFY, scope = ['./'], items = ITEMS, links = {} } = {}) {
  const root = tmp(t, 'tl-ic-')
  const P = path.join(root, 'proj')
  fs.mkdirSync(P)
  git(P, ['init', '-q', '-b', 'main'])
  for (const [rel, content] of Object.entries(files)) write(P, rel, content)
  for (const [rel, target] of Object.entries(links)) {
    fs.mkdirSync(path.dirname(path.join(P, rel)), { recursive: true })
    fs.symlinkSync(target, path.join(P, rel))
  }
  git(P, ['add', '-A'])
  git(P, ['commit', '-q', '-m', 'base'])
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'LOOP.md'), loopMd({ verify, scope }))
  fs.writeFileSync(path.join(S, 'STATE.md'), stateMd(items))
  const cache = path.join(root, 'cache')
  const ctl = path.join(root, 'ctl')
  fs.mkdirSync(ctl)
  const env = { ...process.env, TECH_LEAD_CACHE: cache }
  delete env.TECH_LEAD_HOLDER_PID
  delete env.TECH_LEAD_FAULT
  const paths = loopPaths(P, { env })
  const fx = { t, root, P, S, cache, ctl, env, paths, V: paths.V, W: paths.W, pSnap: null, n: 0 }
  fx.pSnap = pSnapshot(fx)
  return fx
}

// <P>'s bytes and times (its tree, .git, refs, config, index), the spine left out (I6).
export const pSnapshot = fx => snapshot(fx.P, { skip: ['.tech-lead'], times: true })
export const markP = fx => { fx.pSnap = pSnapshot(fx) }

// Whether the process group `pgid` is still the group the test recorded, whose leader had the
// start token `start` (Cg4#2). A group id is never handed out while that group exists, so:
//   - its leader alive with that token: ours;
//   - the pid held by a live process with another token: our group is gone, and whatever leads
//     the id now is someone else's;
//   - the pid free (ESRCH): any member left in the group is ours;
//   - a zombie at the pid: ours only when `zombieOurs` (a leader its own parent has not reaped
//     yet); never after this process reaped its own child, since that zombie is another one;
//   - a token that cannot be read: not provably ours, so left alone.
export function groupIsOurs(pgid, start, { zombieOurs = true } = {}) {
  if (groupAlive(pgid) !== true) return false
  const t = startToken(pgid)
  if (t.state === 'live') return typeof start === 'string' && t.token === start
  if (t.state !== 'gone') return false
  try {
    process.kill(pgid, 0)
  } catch (e) {
    return e.code === 'ESRCH'
  }
  return zombieOurs
}
// SIGKILL for the group `pgid` when groupIsOurs; true when it was sent.
export function killGroupIfOurs(pgid, start, opts) {
  if (!groupIsOurs(pgid, start, opts)) return false
  try {
    process.kill(-pgid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

// A process (pid > 0) or process group (-pgid) killed when the test ends: a process only while
// its start token is the one read here (or the `start` given), a group only while
// groupIsOurs says its leader's token still matches or its pid is free.
export function reap(fx, id, start = startToken(Math.abs(id)).token ?? null) {
  fx.t.after(() => {
    if (id > 0) {
      if (isAlive({ pid: id, start }) !== true) return
      try { process.kill(id, 'SIGKILL') } catch { /* gone */ }
    } else killGroupIfOurs(-id, start)
  })
}

// One firing of the driver: {pid, events, event(name), kill(), exited, scenario}.
export function start(fx, o = {}) {
  const scenario = { P: fx.P, stop: 'none', ctl: fx.ctl, prefix: PREFIX, base: 'main', date: D2, ...o }
  const file = path.join(fx.root, `scenario-${++fx.n}.json`)
  fs.writeFileSync(file, JSON.stringify(scenario))
  const c = spawn(process.execPath, [DRIVER, 'firing', file], { env: { ...fx.env, ...(o.spawnEnv ?? {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  // The driver leads its own group; its token is read while it is surely our child.
  const leaderStart = startToken(c.pid).token ?? null
  const events = []
  let buf = ''
  let stderr = ''
  let exit = null
  // Set once the driver's group is known to be empty: no later kill can then be aimed at it.
  let disarmed = false
  c.stdout.on('data', d => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) events.push(JSON.parse(buf.slice(0, i)))
  })
  c.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => c.on('exit', (code, signal) => {
    exit = { code, signal }
    if (groupAlive(c.pid) === false) disarmed = true
    resolve(exit)
  }))
  fx.t.after(() => {
    // Not yet reaped, the driver's pid (and so its group id) is still ours; once reaped, the id
    // may be another process's, so the group is killed only while groupIsOurs.
    if (!disarmed) {
      if (exit === null) {
        try { process.kill(-c.pid, 'SIGKILL') } catch { /* gone */ }
      } else killGroupIfOurs(c.pid, leaderStart, { zombieOurs: false })
    }
    c.stdout.destroy()
    c.stderr.destroy()
  })
  const describe = () => `events ${JSON.stringify(events).slice(0, 6000)}, exit ${JSON.stringify(exit)}, stderr ${stderr.slice(0, 3000)}`
  const event = async (name, ms = 60000) => {
    const e = await waitFor(() => events.find(x => x.event === name) || (exit && 'exit'), ms)
    assert.ok(e && e !== 'exit', `no ${name} event from the firing (${describe()})`)
    return e
  }
  const kill = async () => {
    process.kill(-c.pid, 'SIGKILL')
    await exited
    assert.ok(await waitFor(() => groupAlive(c.pid) === false), `firing group ${c.pid} survived`)
    disarmed = true
  }
  const ended = async () => {
    await exited
    return { exit, events, stderr }
  }
  const get = name => events.find(x => x.event === name)
  return { pid: c.pid, events, event, kill, exited, ended, get, describe, scenario }
}

// A firing run to its release; its events by name.
export async function run(fx, o = {}) {
  const f = start(fx, o)
  await f.event('released', 80000)
  const { exit } = await f.ended()
  assert.deepEqual(exit, { code: 0, signal: null }, f.describe())
  assert.equal(f.events.some(e => e.event === 'error'), false, f.describe())
  return f
}

// A firing killed at its stop (or at its fault): onStop(f, e) runs while it waits there.
export async function interrupt(fx, o, onStop = null) {
  const f = start(fx, o)
  const name = o.faults && Object.keys(o.faults).length ? 'faulted' : o.stop
  assert.ok(name, 'interrupt needs a stop or a fault')
  const e = await f.event(name, 80000)
  if (onStop) await onStop(f, e)
  await f.kill()
  return f
}

// Lets a firing waiting at gate `name` go on.
export const go = (fx, name) => fs.writeFileSync(path.join(fx.ctl, `${name}.go`), '')

// ---------------------------------------------------------------- facts

export const stateText = fx => fs.readFileSync(path.join(fx.S, 'STATE.md'), 'utf8')
// The lines of the first item titled `title` in a section: its `- ` line and the indented
// sub-bullets under it; null when there is none.
export function itemBlock(fx, name, title) {
  const lines = sections(fx)[name] ?? []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('- ')) continue
    const parts = lines[i].replace(/^- \[[ x]\] /, '').split(` ${DOT} `)
    const t = (parts.length > 1 && /^P[0-9]+$/.test(parts[0]) ? parts[1] : parts[0]).trim()
    if (t !== title) continue
    let end = i + 1
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++
    return lines.slice(i, end)
  }
  return null
}
export function sections(fx) {
  const out = {}
  let cur = null
  for (const line of stateText(fx).split('\n')) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      cur = m[1]
      out[cur] = []
    } else if (cur && line.trim() && line.trim() !== '(empty)') out[cur].push(line)
  }
  return out
}
// The item titles a section holds (`- ` lines and `### ` entries).
export function titles(fx, name) {
  return (sections(fx)[name] ?? []).flatMap(l => {
    if (l.startsWith('### ')) return [l.slice(4).trim()]
    if (!l.startsWith('- ')) return []
    const parts = l.replace(/^- \[[ x]\] /, '').split(` ${DOT} `)
    return [(parts.length > 1 && /^P[0-9]+$/.test(parts[0]) ? parts[1] : parts[0]).trim()]
  })
}
export function editState(fx, fn) {
  const file = path.join(fx.S, 'STATE.md')
  fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')))
}

export function ledger(fx) {
  const f = path.join(fx.S, 'LEDGER.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
}
export function ledgerNames(fx) {
  const commits = new Set()
  const saves = new Set()
  for (const r of ledger(fx)) {
    for (const c of [...(r.commits ?? []), ...(r.recovered?.commits ?? [])]) commits.add(c)
    for (const s of r.saves ?? []) saves.add(s.sha)
    for (const b of r.recovered?.bundles ?? []) saves.add(b)
  }
  return { commits, saves }
}
export const recordOf = (fx, g) => {
  try { return JSON.parse(fs.readFileSync(path.join(fx.V, 'run', `${g}.json`), 'utf8')) } catch { return null }
}
export const recordGenerations = fx => {
  try {
    return fs.readdirSync(path.join(fx.V, 'run')).filter(n => /^[0-9]+\.json$/.test(n)).map(n => Number(n.slice(0, -5))).sort((a, b) => a - b)
  } catch { return [] }
}
export const patches = fx => {
  try { return fs.readdirSync(path.join(fx.V, 'patches')).filter(n => /^[0-9a-f]{64}\.patch$/.test(n)).map(n => n.slice(0, 64)).sort() } catch { return [] }
}
export const headerOf = (fx, sha) => {
  const first = fs.readFileSync(path.join(fx.V, 'patches', `${sha}.patch`), 'utf8').split('\n')[0]
  return JSON.parse(first.slice('TECH-LEAD-RECOVERY v1 '.length))
}
export const tipOf = (W, ref = 'HEAD') => git(W, ['rev-parse', ref])
export const status = W => git(W, ['status', '--porcelain=v1', '-uall'])
export const bundleFile = (fx, branch) => path.join(fx.V, 'out', `${branch}.bundle`)

// The work a bundle or commit must reproduce: every file and symlink under W (no directories),
// minus .git and the ignored install and verify output.
export const SKIP = ['.git', 'node_modules', 'build']
export const workSnap = (W, skip = SKIP) => snapshot(W, { skip }).filter(([, v]) => v !== 'd')

// A scratch work tree that borrows W's objects (alternates), so any commit W has can be checked out.
function scratch(fx, W) {
  const dir = path.join(tmp(fx.t, 'tl-ic-s-'), 's')
  git(fx.root, ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), `${path.join(W, '.git', 'objects')}\n`)
  return dir
}
// The tree a recovery bundle reproduces: its base checked out, the bundle applied by plain git apply.
export function bundleTree(fx, sha, skip = SKIP) {
  const h = headerOf(fx, sha)
  const dir = scratch(fx, fx.W)
  git(dir, ['checkout', '-q', '--detach', h.base])
  git(dir, ['apply', '--binary', path.join(fx.V, 'patches', `${sha}.patch`)])
  return workSnap(dir, skip)
}
export function commitTree(fx, sha, skip = SKIP) {
  const dir = scratch(fx, fx.W)
  git(dir, ['checkout', '-q', '--detach', sha])
  return workSnap(dir, skip)
}

function lockFiles(dir) {
  const out = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.lock')) out.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return out
}

// The dated branches of W with commits beyond refs/tech-lead/base: [[branch, tip]].
export function loopBranches(fx) {
  const W = fx.W
  return git(W, ['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/heads/${PREFIX}/`]).split('\n').filter(Boolean)
    .map(l => l.split(' ')).filter(([, tip]) => git(W, ['rev-list', '--count', tip, '--not', 'refs/tech-lead/base']) !== '0')
}

// ---------------------------------------------------------------- the invariants

const LEDGER_OUTCOMES = ['done', 'failed', 'blocked', 'flagged', 'skipped', 'report-only', 'needs-decision', 'halted']
const SAVE_WHYS = ['clean-clone', 'delegate-flagged', 'codex', 'attempt-failed', 'pause']

// expect: {records: [g...] (default []), tip, branch, sections: {name: [titles]}, rows: [iterations],
//   orphans (patches named by no ledger row; default 0), work: [{snap, skip, via: 'bundle' | sha}],
//   delegate: [shas no bundle may hold], retired: [tips no bundle may hold], bundles: false to skip I5}
export function assertRecovered(fx, ex = {}) {
  const W = fx.W
  const label = ex.label ? `${ex.label}: ` : ''

  // I8: no run record left except as expected, and none unresolved below the newest.
  const gens = recordGenerations(fx)
  assert.deepEqual(gens, ex.records ?? [], `${label}I8 run records left`)
  const recs = gens.map(g => recordOf(fx, g))
  for (const r of recs.slice(0, -1)) {
    const resolved = r.phase === 'clean' || r.recovery?.step === 'done'
    assert.ok(resolved, `${label}I8 generation ${r.generation} is unresolved below the newest record`)
  }

  // I2: <W> clean at the expected tip, no lock file left.
  assert.equal(status(W), '', `${label}I2 <W> is not clean`)
  if (ex.tip) assert.equal(tipOf(W), ex.tip, `${label}I2 tip`)
  if (ex.branch) assert.equal(git(W, ['symbolic-ref', 'HEAD']), `refs/heads/${ex.branch}`, `${label}I2 branch`)
  assert.deepEqual(lockFiles(path.join(W, '.git')), [], `${label}I2 lock files left in <W>/.git`)

  // I3: ## Now holds exactly (empty); each item in its expected section.
  assert.match(stateText(fx), /\n## Now\n\(empty\)\n/, `${label}I3 ## Now is not (empty)`)
  for (const [name, list] of Object.entries(ex.sections ?? {})) {
    assert.deepEqual(titles(fx, name).sort(), [...list].sort(), `${label}I3 ## ${name}`)
  }

  // I4: one ledger row per completed firing, generations strictly increasing, every loop commit
  // and every bundle named by some row (an orphaned bundle file excepted).
  const rows = ledger(fx)
  // The ledger schema (loop-templates.md) for the fields the firing writes.
  for (const r of rows) {
    assert.ok(LEDGER_OUTCOMES.includes(r.outcome), `${label}I4 row ${r.iteration}: outcome ${JSON.stringify(r.outcome)}`)
    assert.ok([null, 'pass', 'fail'].includes(r.verify), `${label}I4 row ${r.iteration}: verify ${JSON.stringify(r.verify)}`)
    if (r.recovered != null) {
      assert.ok(['finish-commit', 'requeue-now', null].includes(r.recovered.action), `${label}I4 row ${r.iteration}: recovered.action ${JSON.stringify(r.recovered.action)}`)
    }
    for (const sv of r.saves ?? []) assert.ok(SAVE_WHYS.includes(sv.why), `${label}I4 row ${r.iteration}: save why ${JSON.stringify(sv.why)}`)
  }
  const its = rows.map(r => r.iteration)
  for (let i = 1; i < its.length; i++) assert.ok(its[i] > its[i - 1], `${label}I4 iterations ${its} are not strictly increasing`)
  if (ex.rows) assert.deepEqual(its, ex.rows, `${label}I4 ledger rows`)
  const names = ledgerNames(fx)
  const loopCommits = git(W, ['rev-list', `--branches=${PREFIX}/*`, '--not', 'refs/tech-lead/base']).split('\n').filter(Boolean)
  for (const c of loopCommits) assert.ok(names.commits.has(c), `${label}I4 loop commit ${c} is in no ledger row`)
  const orphans = patches(fx).filter(s => !names.saves.has(s))
  assert.equal(orphans.length, ex.orphans ?? 0, `${label}I4 bundles named by no ledger row: ${orphans}`)

  // I5: every branch with loop commits has a verified bundle at its tip; no bundle holds a
  // delegate commit or a retired tip.
  if (ex.bundles !== false) {
    for (const [branch, tip] of loopBranches(fx)) {
      const file = bundleFile(fx, branch)
      assert.ok(fs.existsSync(file), `${label}I5 no bundle for ${branch}`)
      const side = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'))
      assert.equal(side.tip, tip, `${label}I5 the bundle of ${branch} is not at its tip`)
      assert.equal(side.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), `${label}I5 sidecar sha256`)
      git(W, ['bundle', 'verify', '-q', file])
      assert.deepEqual(git(W, ['bundle', 'list-heads', file]).split('\n'), [`${tip} refs/heads/${branch}`], `${label}I5 bundle heads`)
    }
  }
  const bad = [...(ex.delegate ?? []), ...(ex.retired ?? [])]
  if (bad.length) {
    for (const file of bundleFiles(fx)) {
      for (const line of git(W, ['bundle', 'list-heads', file]).split('\n').filter(Boolean)) {
        const tip = line.split(' ')[0]
        for (const d of bad) {
          const held = spawnSync('git', ['-C', W, 'merge-base', '--is-ancestor', d, tip]).status === 0
          assert.equal(held, false, `${label}I5 ${path.relative(fx.V, file)} holds ${d}`)
        }
      }
    }
  }

  // I6: no refs/stash; <P> byte- and time-identical apart from the spine.
  assert.equal(spawnSync('git', ['-C', W, 'rev-parse', '-q', '--verify', 'refs/stash']).status, 1, `${label}I6 refs/stash in <W>`)
  assert.equal(spawnSync('git', ['-C', fx.P, 'rev-parse', '-q', '--verify', 'refs/stash']).status, 1, `${label}I6 refs/stash in <P>`)
  if (fx.pSnap) assert.deepEqual(pSnapshot(fx), fx.pSnap, `${label}I6 <P> changed`)

  // I1: no work lost.
  for (const w of ex.work ?? []) {
    if (w.via === 'bundle') {
      const shas = [...names.saves].filter(s => fs.existsSync(path.join(fx.V, 'patches', `${s}.patch`)))
      const hit = shas.find(s => JSON.stringify(bundleTree(fx, s, w.skip)) === JSON.stringify(w.snap))
      assert.ok(hit, `${label}I1 no ledgered bundle of ${JSON.stringify(shas)} reproduces the pre-kill work ${JSON.stringify(w.snap).slice(0, 2000)}`)
      if (w.sha) assert.equal(hit, w.sha, `${label}I1 the reproducing bundle`)
    } else {
      assert.deepEqual(commitTree(fx, w.via, w.skip), w.snap, `${label}I1 commit ${w.via} does not hold the work`)
    }
  }
}

export function bundleFiles(fx) {
  const out = []
  const walk = d => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.bundle') && !e.name.startsWith('.tmp-')) out.push(p)
    }
  }
  walk(path.join(fx.V, 'out'))
  return out.sort()
}

// A pid that no longer exists (a short process that has been reaped).
export function deadPid() {
  return spawnSync('/usr/bin/true').pid
}

// The planner run by the test (read-only): its one JSON line and exit status.
export function plan(fx, N) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'loop-recover.mjs'), fx.P, '--generation', String(N)], { encoding: 'utf8', env: fx.env })
  return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr }
}

// A helper CLI run as the holder holder (a live driver's pid): {status, signal, out}.
export function helperAs(fx, holder, script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: { ...fx.env, TECH_LEAD_HOLDER_PID: String(holder), ...env } })
  let out = null
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* null */ }
  return { status: r.status, signal: r.signal, out, stdout: r.stdout, stderr: r.stderr }
}
