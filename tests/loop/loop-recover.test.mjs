// tests/loop/loop-recover.test.mjs
// The read-only recovery planner (stage 0c-2 brief section 14) against real temporary git
// repositories: a project <P> with its spine <S>, a real clone <W> = <V>/clone under a
// temporary TECH_LEAD_CACHE, real run records (run-record.mjs), real recovery-bundle files in
// <V>/patches and real delivery bundles (delivery.mjs). Every case runs the CLI as a child
// process; the planner must report and never write.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { ACTIONS, PLACEHOLDER, nowLine } from '../../scripts/loop-recover.mjs'
import { ensureV, loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { createRecord } from '../../scripts/lib/run-record.mjs'
import { checkClone } from '../../scripts/lib/clone-check.mjs'
import { bundlePath, writeBundle } from '../../scripts/lib/delivery.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { isAlive, startToken } from '../../scripts/lib/loop-proc.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-recover.mjs')
const TIMEOUT = { timeout: 90000 }
// Keep the user's git config and hooks out of the fixture repositories, and any real Codex
// companion away from them; the CLI children inherit this environment.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
delete process.env.TECH_LEAD_FAULT
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
// A real process standing in for the lock holder, started through a shell that exits at once
// so it never lingers as this runner's zombie. The cleanup kills it only while its start token
// is still the one read here, so a pid the kernel has since handed to another process is never
// signalled (review round, contracts-tests#7).
const sleeper = t => {
  const pid = Number(execSync("sh -c 'sleep 120 >/dev/null 2>&1 & echo $!'", { encoding: 'utf8' }).trim())
  const start = startToken(pid).token ?? null
  t.after(() => {
    if (isAlive({ pid, start }) !== true) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  })
  return pid
}
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

// The STATE.md separator the templates use; built from its code point to keep this file ASCII.
const DOT = String.fromCodePoint(0xb7)
const ITEM = `- [ ] P1 ${DOT} fix the parser ${DOT} class: hard`
const ITEM_EDITED = `- [ ] P1 ${DOT} fix the parser and the lexer ${DOT} class: hard`
const state = ({ now = PLACEHOLDER, done = PLACEHOLDER } = {}) => [
  '# Demo - Loop State', '',
  '## Now', now, '',
  '## Backlog',
  `- [ ] P2 ${DOT} later work ${DOT} class: unclassified`, '  - blocked-by: -', '  - status: -', '',
  '## Needs decision', '(empty)', '',
  '## Blocked', '(empty)', '',
  '## Done', done, '',
  '## Last run', '(never run)', '',
].join('\n')
const doneLine = sha => `- [x] fix the parser ${DOT} ${sha} ${DOT} 2026-10-01`

const BRANCH = 'tech-lead-loop/2026-10-01'
const HEAD_REF = `refs/heads/${BRANCH}`
const OTHER_REF = 'refs/heads/tech-lead-loop/2026-09-29'
const DIRTY_NONE = { staged: false, tracked: false, untracked: [], more: 0 }
const LEGACY_NONE = { exists: false, staged: false, tracked: false, untracked: [], more: 0, problem: null }

// The clone <W> as prepare leaves it: a full clone of <P> with no remote, no branch sections,
// no hooks or info (an empty template), HEAD on today's dated branch at <P>'s main, and
// refs/tech-lead/base at the same commit. checkClone must find it clean.
const makeClone = (t, fx) => {
  const template = tmp(t, 'tl-recover-tpl-')
  fs.mkdirSync(fx.W, { mode: 0o700 })
  execFileSync('git', ['clone', '--no-local', '--no-checkout', `--template=${template}`, '-q', '--', fx.P, fx.W], { stdio: 'ignore' })
  git(fx.W, 'config', '--remove-section', 'remote.origin')
  try { git(fx.W, 'config', '--remove-section', 'branch.main') } catch { /* none */ }
  git(fx.W, 'update-ref', 'refs/tech-lead/base', fx.H0)
  git(fx.W, 'update-ref', HEAD_REF, fx.H0)
  git(fx.W, 'symbolic-ref', 'HEAD', HEAD_REF)
  git(fx.W, 'update-ref', '-d', 'refs/heads/main')
  git(fx.W, 'read-tree', '-u', '--reset', 'HEAD')
  assert.deepEqual(checkClone(fx.W).problems, [], 'the fixture clone passes checkClone')
}

// A project <P> with two committed files, the spine ignored through info/exclude, a STATE.md,
// <V> bound to <P> (identity.json) and, unless clone is false, the clone <W>. legacy adds a
// 0c-1 linked worktree at <S>/worktree.
const project = (t, { now = PLACEHOLDER, done = PLACEHOLDER, clone = true, legacy = false } = {}) => {
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
  fs.writeFileSync(path.join(S, 'STATE.md'), state({ now, done }))
  const env = { ...process.env, TECH_LEAD_CACHE: cache, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const paths = ensureV(loopPaths(P, { env }))
  const fx = { P, S, cache, env, paths, V: paths.V, W: paths.W, H0: git(P, 'rev-parse', 'HEAD'), legacy: path.join(S, 'worktree') }
  if (clone) makeClone(t, fx)
  if (legacy) git(P, 'worktree', 'add', '-q', '-b', 'tech-lead-loop/2026-09-30', fx.legacy, 'main')
  return fx
}

const setState = (fx, opts) => fs.writeFileSync(path.join(fx.S, 'STATE.md'), state(opts))
const setLedger = (fx, ...rows) => fs.writeFileSync(path.join(fx.S, 'LEDGER.jsonl'), rows.map(r => `${JSON.stringify(r)}\n`).join(''))

// A commit on HEAD's branch in <W>: {sha, tree}.
const commitInW = (fx, file, content, message = 'loop work') => {
  fs.writeFileSync(path.join(fx.W, file), content)
  git(fx.W, 'add', '--', file)
  git(fx.W, 'commit', '-q', '-m', message)
  return { sha: git(fx.W, 'rev-parse', 'HEAD'), tree: git(fx.W, 'rev-parse', 'HEAD^{tree}') }
}

// A recovery-bundle file in <V>/patches named by the SHA-256 of its bytes; returns the sha.
const patchFile = (fx, content) => {
  const dir = path.join(fx.V, 'patches')
  fs.mkdirSync(dir, { recursive: true })
  const sha = sha256(content)
  fs.writeFileSync(path.join(dir, `${sha}.patch`), content)
  return sha
}
const patchPath = (fx, sha) => path.join(fx.V, 'patches', `${sha}.patch`)

const record = (fx, g, fields) => assert.equal(createRecord(fx.paths, g, fields), true)
const onBranch = fx => ({ base: fx.H0, branch: BRANCH, head_ref: HEAD_REF, now_sha256: sha256(ITEM) })

const run = (fx, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: fx.env })
  const lines = r.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `exactly one JSON line on stdout, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  return { code: r.status, out: JSON.parse(lines[0]), stderr: r.stderr }
}
const plan = (fx, N, ...extra) => run(fx, fx.P, '--generation', String(N), ...extra)
// A plan that must succeed.
const ok = (fx, N, ...extra) => {
  const r = plan(fx, N, ...extra)
  assert.equal(r.code, 0, `exit 0, got ${r.code}: ${JSON.stringify(r.out)}`)
  return r.out
}
// A plan that must fail with exit 2 and a detail matching re.
const refused = (fx, N, re) => {
  const r = plan(fx, N)
  assert.equal(r.code, 2, `exit 2, got ${r.code}: ${JSON.stringify(r.out)}`)
  assert.equal(r.out.state, 'error')
  assert.match(r.out.detail, re)
  return r.out
}

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
      out[rel] = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha: sha256(fs.readFileSync(abs)) }
    }
  }
  walk('')
  return out
}

test('the action list is closed and ordered', () => {
  assert.deepEqual(ACTIONS, ['finish-commit', 'requeue-now', 'ledger-recovered', 'write-bundle', 'note-leftovers'])
})

test('no clone and no record: the full output shape; a Now item -> requeue-now; --reclaimed is echoed', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM, clone: false })
  assert.deepEqual(ok(fx, 5, '--reclaimed', '4'), {
    generation: 5, reclaimed: 4, now: ITEM, now_sha256: sha256(ITEM),
    clone: { exists: false, valid: false, problems: [], head: null, branch: null, dirty: DIRTY_NONE, locks: [] },
    records: [], finish: null, recovered: null, write_bundles: [], legacy: { worktree: LEGACY_NONE },
    actions: ['requeue-now'], notes: [],
  })
  await t.test('an unresolved record with no clone reads no-clone and is noted', () => {
    record(fx, 3, { phase: 'prepared', ...onBranch(fx) })
    const out = ok(fx, 5)
    assert.deepEqual(out.records, [{ generation: 3, phase: 'prepared', verdict: 'no-clone', sha: null, ledgered: true }])
    assert.deepEqual(out.actions, ['requeue-now'])
    assert.ok(out.notes.some(n => /clone/.test(n) && /generation 3/.test(n)), JSON.stringify(out.notes))
  })
})

test('a clean clone and no record -> no action; the clone facts', TIMEOUT, t => {
  const fx = project(t)
  // New times, same content: the index's stat data is stale, the tree is still clean.
  fs.utimesSync(path.join(fx.W, 'a.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const out = ok(fx, 1)
  assert.deepEqual(out.clone, { exists: true, valid: true, problems: [], head: fx.H0, branch: BRANCH, dirty: DIRTY_NONE, locks: [] })
  assert.deepEqual(out.records, [])
  assert.deepEqual(out.actions, [])
  assert.equal(out.now, null)
  assert.equal(out.now_sha256, null)
})

test('a no-record dirty clone (a stray writer after a normal release) -> note-leftovers', TIMEOUT, t => {
  const fx = project(t)
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'a stray writer\n')
  fs.writeFileSync(path.join(fx.W, 'stray.txt'), 'stray\n')
  fs.mkdirSync(path.join(fx.W, 'deep', 'er'), { recursive: true })
  fs.writeFileSync(path.join(fx.W, 'deep', 'er', 'x.txt'), 'x\n')
  const out = ok(fx, 2)
  assert.deepEqual(out.clone.dirty, { staged: false, tracked: true, untracked: ['deep/er/x.txt', 'stray.txt'], more: 0 })
  assert.deepEqual(out.records, [])
  assert.deepEqual(out.actions, ['note-leftovers'])
  assert.ok(out.notes.some(n => /leftovers/.test(n)), JSON.stringify(out.notes))
})

test('leftovers of a prepared record: requeue-now first, then note-leftovers; staged and locks reported', TIMEOUT, t => {
  const fx = project(t, { now: ITEM })
  record(fx, 3, { phase: 'prepared', ...onBranch(fx) })
  fs.writeFileSync(path.join(fx.W, 'new.txt'), 'new\n')
  git(fx.W, 'add', '--', 'new.txt')
  fs.writeFileSync(path.join(fx.W, '.git', 'index.lock'), '')
  fs.mkdirSync(path.join(fx.W, '.git', 'refs', 'heads', 'tech-lead-loop'), { recursive: true })
  fs.writeFileSync(path.join(fx.W, '.git', 'refs', 'heads', 'tech-lead-loop', '2026-10-01.lock'), '')
  const out = ok(fx, 4)
  assert.deepEqual(out.clone.dirty, { staged: true, tracked: false, untracked: [], more: 0 })
  assert.deepEqual(out.clone.locks, ['index.lock', 'refs/heads/tech-lead-loop/2026-10-01.lock'])
  assert.deepEqual(out.records, [{ generation: 3, phase: 'prepared', verdict: 'leftovers', sha: null, ledgered: true }])
  assert.deepEqual(out.actions, ['requeue-now', 'note-leftovers'])
  assert.equal(out.finish, null)
  assert.equal(out.recovered, null)
})

test('untracked paths are capped at 50 with the rest counted', TIMEOUT, t => {
  const fx = project(t)
  for (let i = 0; i < 53; i++) fs.writeFileSync(path.join(fx.W, `f${String(i).padStart(2, '0')}.txt`), `${i}\n`)
  const out = ok(fx, 1)
  assert.equal(out.clone.dirty.untracked.length, 50)
  assert.equal(out.clone.dirty.untracked[0], 'f00.txt')
  assert.equal(out.clone.dirty.more, 3)
})

test('committed: finish-commit only when the Now line hash matches and neither Done nor the ledger names the commit', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM })
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  // Killed after the branch moved, before the record said committed (commit:after-update-ref).
  record(fx, 3, { phase: 'intent', ...onBranch(fx), intent: { tree: c.tree, parent: fx.H0, commit: c.sha } })

  await t.test('the binding holds: finish-commit, ledger-recovered, write-bundle', () => {
    const out = ok(fx, 4)
    assert.deepEqual(out.records, [{ generation: 3, phase: 'intent', verdict: 'committed', sha: c.sha, ledgered: false }])
    assert.deepEqual(out.finish, { generation: 3, sha: c.sha })
    assert.deepEqual(out.recovered, { generations: [3], commits: [c.sha], bundles: [], task: ITEM })
    assert.deepEqual(out.write_bundles, [BRANCH])
    assert.deepEqual(out.actions, ['finish-commit', 'ledger-recovered', 'write-bundle'])
  })

  await t.test('the Now line edited -> requeue-now plus a note naming the sha; no title search', () => {
    setState(fx, { now: ITEM_EDITED, done: `- [x] ${ITEM.slice(6)}` })
    const out = ok(fx, 4)
    assert.equal(out.finish, null)
    assert.deepEqual(out.actions, ['requeue-now', 'ledger-recovered', 'write-bundle'])
    assert.ok(out.notes.some(n => n.includes(c.sha.slice(0, 12)) && /Now/.test(n)), JSON.stringify(out.notes))
  })

  await t.test('## Done already names the full sha -> requeue-now', () => {
    setState(fx, { now: ITEM, done: doneLine(c.sha) })
    const out = ok(fx, 4)
    assert.equal(out.finish, null)
    assert.deepEqual(out.actions, ['requeue-now', 'ledger-recovered', 'write-bundle'])
  })

  await t.test('a byte-identical second Now line after a pick, with Done naming a 7-hex prefix -> requeue-now', () => {
    setState(fx, { now: ITEM, done: doneLine(c.sha.slice(0, 7)) })
    const out = ok(fx, 4)
    assert.equal(out.now_sha256, sha256(ITEM))
    assert.equal(out.finish, null)
    assert.deepEqual(out.actions, ['requeue-now', 'ledger-recovered', 'write-bundle'])
  })

  await t.test('six hex digits or a hex run inside a word are no sha', () => {
    setState(fx, { now: ITEM, done: `${doneLine(c.sha.slice(0, 6))}\n- [x] x${c.sha.slice(0, 9)} ${DOT} 2026-10-01` })
    assert.deepEqual(ok(fx, 4).actions, ['finish-commit', 'ledger-recovered', 'write-bundle'])
  })

  await t.test('a ledger row names the commit -> requeue-now and no ledger-recovered', () => {
    setState(fx, { now: ITEM })
    setLedger(fx, { iteration: 3, commits: [c.sha] })
    let out = ok(fx, 4)
    assert.equal(out.finish, null)
    assert.deepEqual(out.records[0].ledgered, true)
    assert.equal(out.recovered, null)
    assert.deepEqual(out.actions, ['requeue-now', 'write-bundle'])
    // A later firing's recovered field counts as well.
    setLedger(fx, 'not json', { iteration: 4, commits: [], recovered: { generations: [3], commits: [c.sha], bundles: [] } })
    out = ok(fx, 5)
    assert.deepEqual(out.actions, ['requeue-now', 'write-bundle'])
    fs.rmSync(path.join(fx.S, 'LEDGER.jsonl'))
  })

  await t.test('an empty ## Now: no finish-commit and no requeue-now', () => {
    setState(fx, { now: PLACEHOLDER })
    const out = ok(fx, 4)
    assert.equal(out.finish, null)
    assert.deepEqual(out.actions, ['ledger-recovered', 'write-bundle'])
  })

  await t.test('the record phase committed (killed before the ledger) binds the same way', () => {
    setState(fx, { now: ITEM })
    record(fx, 4, { phase: 'committed', ...onBranch(fx), base: c.sha, commit: { sha: c.sha } })
    // Generation 4 is now the newest unresolved record; 3 is superseded, its commit still counts.
    const out = ok(fx, 5)
    assert.deepEqual(out.records.map(r => [r.generation, r.verdict, r.sha]), [[3, 'superseded', c.sha], [4, 'committed', c.sha]])
    assert.deepEqual(out.finish, { generation: 4, sha: c.sha })
    assert.deepEqual(out.recovered, { generations: [3, 4], commits: [c.sha], bundles: [], task: ITEM })
  })
})

test('matrix rows 2, 28, 29 and 31: after a pick, Done written without a ledger row, after the ledger', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM })
  await t.test('row 2: killed after the pick, before any record -> requeue-now only', () => {
    assert.deepEqual(ok(fx, 2, '--reclaimed', '1').actions, ['requeue-now'])
  })
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  record(fx, 3, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha } })
  writeBundle(fx.paths, BRANCH, { why: 'commit', guard: () => {} })
  await t.test('rows 28 and 31: the item moved to Done with the sha, no ledger row -> ledger-recovered only', () => {
    setState(fx, { now: PLACEHOLDER, done: doneLine(c.sha.slice(0, 7)) })
    const out = ok(fx, 4)
    assert.equal(out.finish, null)
    assert.deepEqual(out.recovered, { generations: [3], commits: [c.sha], bundles: [], task: null })
    assert.deepEqual(out.actions, ['ledger-recovered'])
  })
  await t.test('row 29: after the ledger -> nothing', () => {
    setLedger(fx, { iteration: 3, commits: [c.sha], bundles: [{ branch: BRANCH, tip: c.sha, why: 'commit' }] })
    const out = ok(fx, 4)
    assert.deepEqual(out.records, [{ generation: 3, phase: 'committed', verdict: 'committed', sha: c.sha, ledgered: true }])
    assert.deepEqual(out.actions, [])
  })
})

test('row 17: the recovering prepare killed mid-reset -> the older record\'s unfinished reset owns the clone over the bare preparing record', TIMEOUT, t => {
  const fx = project(t, { now: ITEM })
  const x = patchFile(fx, 'TECH-LEAD-RECOVERY v1 {"fixture":17}\n')
  // Generation 3 left leftovers; generation 4's prepare saved them as x and was killed while
  // resetting, after creating its own (bare) record. A half-reset tree stays behind. prepare
  // finishes 3's reset (ownerRecord), so the planner judges 3, not 4.
  record(fx, 3, { phase: 'prepared', ...onBranch(fx), recovery: { by: 4, base: fx.H0, bundles: [x], reset_sha: x, step: 'resetting' } })
  record(fx, 4, { phase: 'preparing', pre_head: fx.H0 })
  fs.writeFileSync(path.join(fx.W, 'left.txt'), 'half reset\n')
  const out = ok(fx, 5, '--reclaimed', '4')
  assert.deepEqual(out.records, [
    { generation: 3, phase: 'prepared', verdict: 'resume-reset', sha: null, ledgered: false },
    { generation: 4, phase: 'preparing', verdict: 'superseded', sha: null, ledgered: true },
  ])
  assert.ok(out.notes.some(n => n.includes('generation 4 is superseded by generation 3')), JSON.stringify(out.notes))
  assert.deepEqual(out.recovered, { generations: [3], commits: [], bundles: [x], task: ITEM })
  assert.deepEqual(out.actions, ['requeue-now', 'ledger-recovered', 'note-leftovers'])
})

test('a committed older record behind a preparing record killed at prepare:after-preparing -> the committed record owns the clone', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM })
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  // Generation 3 committed and was killed before its bookkeeping; generation 4's prepare was
  // killed right after creating its record (phase preparing, no recovery, no save).
  record(fx, 3, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha } })
  record(fx, 4, { phase: 'preparing', pre_head: c.sha })
  await t.test('the planner judges 3, as prepare does: finish-commit, ledger-recovered, write-bundle', () => {
    const out = ok(fx, 5, '--reclaimed', '4')
    assert.deepEqual(out.records, [
      { generation: 3, phase: 'committed', verdict: 'committed', sha: c.sha, ledgered: false },
      { generation: 4, phase: 'preparing', verdict: 'superseded', sha: null, ledgered: true },
    ])
    assert.deepEqual(out.finish, { generation: 3, sha: c.sha })
    assert.deepEqual(out.actions, ['finish-commit', 'ledger-recovered', 'write-bundle'])
    assert.ok(out.notes.some(n => n.includes('generation 4 is superseded by generation 3')), JSON.stringify(out.notes))
  })
  await t.test('residue on the commit -> note-leftovers for 3', () => {
    fs.writeFileSync(path.join(fx.W, 'left.txt'), 'residue\n')
    const out = ok(fx, 5)
    assert.deepEqual(out.records.map(r => [r.generation, r.verdict]), [[3, 'committed'], [4, 'superseded']])
    assert.ok(out.actions.includes('note-leftovers'), JSON.stringify(out.actions))
    fs.rmSync(path.join(fx.W, 'left.txt'))
  })
  await t.test('a second bare preparing record changes nothing; a non-bare newer record owns', () => {
    record(fx, 5, { phase: 'preparing', pre_head: c.sha })
    assert.deepEqual(ok(fx, 6).records.map(r => [r.generation, r.verdict]), [[3, 'committed'], [4, 'superseded'], [5, 'superseded']])
    record(fx, 6, { phase: 'prepared', ...onBranch(fx), base: c.sha })
    assert.deepEqual(ok(fx, 7).records.map(r => [r.generation, r.verdict]), [[3, 'superseded'], [4, 'superseded'], [5, 'superseded'], [6, 'clean']])
  })
})

test('an inherited GIT_TRACE* is no clone problem for the planner', TIMEOUT, t => {
  const fx = project(t)
  const trace = { GIT_TRACE: '1', GIT_TRACE2: '1', GIT_TRACE2_EVENT: '1', GIT_TRACE2_PERF: '1', GIT_TRACE_PACKET: '1', GIT_TRACE_SETUP: '1' }
  const out = ok({ ...fx, env: { ...fx.env, ...trace } }, 4)
  assert.equal(out.clone.valid, true)
  assert.deepEqual(out.clone.problems, [])
  assert.deepEqual(out.actions, [])
})

test('write-bundle: a committed branch with a missing or stale bundle and a vetted tip', TIMEOUT, async t => {
  const fx = project(t)
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  record(fx, 3, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha } })
  setLedger(fx, { iteration: 3, commits: [c.sha] })

  await t.test('missing -> write-bundle', () => {
    const out = ok(fx, 4)
    assert.deepEqual(out.write_bundles, [BRANCH])
    assert.deepEqual(out.actions, ['write-bundle'])
  })
  await t.test('current -> nothing', () => {
    const w = writeBundle(fx.paths, BRANCH, { why: 'commit', guard: () => {} })
    assert.equal(w.tip, c.sha)
    const out = ok(fx, 4)
    assert.deepEqual(out.write_bundles, [])
    assert.deepEqual(out.actions, [])
  })
  await t.test('a byte flipped in the bundle -> write-bundle', () => {
    const file = bundlePath(fx.paths, BRANCH)
    const bytes = fs.readFileSync(file)
    bytes[bytes.length - 1] ^= 0xff
    fs.writeFileSync(file, bytes)
    const out = ok(fx, 4)
    assert.deepEqual(out.write_bundles, [BRANCH])
    assert.ok(out.notes.some(n => n.includes(BRANCH) && /sha256-mismatch/.test(n)), JSON.stringify(out.notes))
  })
  await t.test('a tip comparable with a retired tip the base lacks -> withheld with a note', () => {
    git(fx.W, 'update-ref', `refs/tech-lead/retired/${BRANCH}`, c.sha)
    const out = ok(fx, 4)
    assert.deepEqual(out.write_bundles, [])
    assert.deepEqual(out.actions, [])
    assert.ok(out.notes.some(n => /retired/.test(n) && n.includes(BRANCH)), JSON.stringify(out.notes))
    git(fx.W, 'update-ref', '-d', `refs/tech-lead/retired/${BRANCH}`)
  })
  await t.test('a branch the base already holds -> nothing to bundle', () => {
    git(fx.W, 'update-ref', 'refs/tech-lead/base', c.sha)
    assert.deepEqual(ok(fx, 4).write_bundles, [])
    git(fx.W, 'update-ref', 'refs/tech-lead/base', fx.H0)
  })
  await t.test('an unvetted tip (a commit no record or ledger row names) -> withheld with a note', () => {
    // The branch moved on by a commit nothing vetted, and a newer record owns the clone there.
    const d = commitInW(fx, 'other.txt', 'other\n', 'unvetted')
    record(fx, 4, { phase: 'prepared', ...onBranch(fx), base: d.sha })
    const out = ok(fx, 5)
    assert.deepEqual(out.records.map(r => [r.generation, r.verdict]), [[3, 'superseded'], [4, 'clean']])
    assert.deepEqual(out.write_bundles, [])
    assert.deepEqual(out.actions, [])
    assert.ok(out.notes.some(n => /not vetted/.test(n) && n.includes(BRANCH)), JSON.stringify(out.notes))
  })
})

test('delegate-commit -> note-leftovers; write-bundle withheld even for an older committed record on the branch', TIMEOUT, t => {
  const fx = project(t)
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  // Generation 2 committed c and was resolved; generation 3 prepared on c and its delegate committed d.
  record(fx, 2, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha }, recovery: { by: 3, step: 'done' } })
  record(fx, 3, { phase: 'prepared', ...onBranch(fx), base: c.sha })
  const d = commitInW(fx, 'delegate.txt', 'delegate\n', 'a delegate commit')
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'and an edit\n')
  setLedger(fx, { iteration: 2, commits: [c.sha] })
  const out = ok(fx, 4)
  assert.deepEqual(out.records, [
    { generation: 2, phase: 'committed', verdict: 'resolved', sha: c.sha, ledgered: true },
    { generation: 3, phase: 'prepared', verdict: 'delegate-commit', sha: null, ledgered: true },
  ])
  assert.equal(out.clone.head, d.sha)
  assert.deepEqual(out.write_bundles, [])
  assert.deepEqual(out.actions, ['note-leftovers'])
  assert.ok(out.notes.some(n => /delegate/.test(n) && n.includes(d.sha.slice(0, 12))), JSON.stringify(out.notes))
  assert.ok(!fs.existsSync(path.join(fx.V, 'out')), 'no bundle written')
})

test('an interrupted rewind -> note-leftovers, write-bundle withheld', TIMEOUT, t => {
  const fx = project(t)
  const d = commitInW(fx, 'delegate.txt', 'delegate\n', 'a delegate commit')
  record(fx, 3, {
    phase: 'prepared', ...onBranch(fx),
    recovery: { by: 4, base: fx.H0, rewind: { from: d.sha, to: fx.H0 }, step: 'rewind-intent' },
  })
  const out = ok(fx, 5)
  assert.deepEqual(out.records, [{ generation: 3, phase: 'prepared', verdict: 'rewind', sha: null, ledgered: true }])
  assert.deepEqual(out.write_bundles, [])
  assert.deepEqual(out.actions, ['note-leftovers'])
})

test('resume (saved, STATE not written) -> requeue-now, ledger-recovered for the save, note-leftovers', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM })
  const x = patchFile(fx, 'TECH-LEAD-RECOVERY v1 {"fixture":1}\n')
  record(fx, 3, { phase: 'saved', ...onBranch(fx), saves: [{ sha: x, why: 'delegate-flagged' }] })
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'flagged work\n')
  const out = ok(fx, 4)
  assert.deepEqual(out.records, [{ generation: 3, phase: 'saved', verdict: 'resume', sha: null, ledgered: false }])
  assert.deepEqual(out.recovered, { generations: [3], commits: [], bundles: [x], task: ITEM })
  assert.deepEqual(out.actions, ['requeue-now', 'ledger-recovered', 'note-leftovers'])

  await t.test('resume-reset (resetting, the save ledgered) -> note-leftovers only', () => {
    fs.rmSync(fx.paths.V + '/run/3.json')
    record(fx, 3, { phase: 'resetting', ...onBranch(fx), saves: [{ sha: x, why: 'delegate-flagged' }], reset_sha: x })
    setState(fx, { now: PLACEHOLDER })
    setLedger(fx, { iteration: 3, saves: [{ sha: x, why: 'delegate-flagged', files: 1, out_of_scope: 0 }] })
    const again = ok(fx, 4)
    assert.deepEqual(again.records, [{ generation: 3, phase: 'resetting', verdict: 'resume-reset', sha: null, ledgered: true }])
    assert.equal(again.recovered, null)
    assert.deepEqual(again.actions, ['note-leftovers'])
  })
})

test('ledger-recovered: an unledgered commit, save or recovery bundle of any record still on disk', TIMEOUT, async t => {
  const fx = project(t)
  const y = patchFile(fx, 'recovery bundle y\n')
  const z = patchFile(fx, 'save z\n')
  // Generation 1: a clean record holding a save; generation 2: a recovery that saved y.
  record(fx, 1, { phase: 'clean', ...onBranch(fx), saves: [{ sha: z, why: 'attempt-failed' }] })
  record(fx, 2, { phase: 'prepared', ...onBranch(fx), recovery: { by: 3, base: fx.H0, bundles: [y], step: 'done' } })
  let out = ok(fx, 3)
  assert.deepEqual(out.records, [
    { generation: 1, phase: 'clean', verdict: 'resolved', sha: null, ledgered: false },
    { generation: 2, phase: 'prepared', verdict: 'resolved', sha: null, ledgered: false },
  ])
  assert.deepEqual(out.recovered, { generations: [1, 2], commits: [], bundles: [z, y], task: null })
  assert.deepEqual(out.actions, ['ledger-recovered'])

  await t.test('a save named by a row\'s saves and a bundle by a row\'s recovered.bundles -> nothing', () => {
    setLedger(fx, { iteration: 1, saves: [{ sha: z }] }, { iteration: 2, recovered: { bundles: [y] } })
    out = ok(fx, 3)
    assert.deepEqual(out.records.map(r => r.ledgered), [true, true])
    assert.equal(out.recovered, null)
    assert.deepEqual(out.actions, [])
  })

  await t.test('an intent whose commit never landed on a branch is no recovered commit', () => {
    const tree = git(fx.W, 'rev-parse', 'HEAD^{tree}')
    const dangling = execFileSync('git', ['-C', fx.W, 'commit-tree', tree, '-p', fx.H0, '-m', 'never landed'], { encoding: 'utf8' }).trim()
    record(fx, 3, { phase: 'intent', ...onBranch(fx), intent: { tree, parent: fx.H0, commit: dangling } })
    out = ok(fx, 4)
    assert.deepEqual(out.records[2], { generation: 3, phase: 'intent', verdict: 'clean', sha: null, ledgered: true })
    assert.equal(out.recovered, null)
    assert.deepEqual(out.actions, [])
  })
})

test('older records are reported resolved or superseded without consulting the clone', TIMEOUT, t => {
  const fx = project(t)
  record(fx, 1, { phase: 'clean', ...onBranch(fx) })
  // Judged against the clone, generation 2 would read unknown (HEAD is on another branch).
  record(fx, 2, { phase: 'prepared', ...onBranch(fx), branch: 'tech-lead-loop/2026-09-29', head_ref: OTHER_REF })
  record(fx, 3, { phase: 'prepared', ...onBranch(fx) })
  const out = ok(fx, 4)
  assert.deepEqual(out.records, [
    { generation: 1, phase: 'clean', verdict: 'resolved', sha: null, ledgered: true },
    { generation: 2, phase: 'prepared', verdict: 'superseded', sha: null, ledgered: true },
    { generation: 3, phase: 'prepared', verdict: 'clean', sha: null, ledgered: true },
  ])
  assert.deepEqual(out.actions, [])
  assert.ok(out.notes.some(n => /generation 2/.test(n) && /superseded/.test(n)), JSON.stringify(out.notes))
})

test('exit 2: corrupt and record-from-the-future', TIMEOUT, t => {
  const fx = project(t, { now: ITEM })
  record(fx, 3, { phase: 'prepared', ...onBranch(fx) })
  refused(fx, 3, /^record-from-the-future: .*3\.json/)
  refused(fx, 2, /^record-from-the-future: .*3\.json/)
  assert.equal(plan(fx, 4).code, 0)
  fs.writeFileSync(path.join(fx.V, 'run', '2.json'), '{"v":1,')
  refused(fx, 4, /^corrupt: .*2\.json/)
  fs.writeFileSync(path.join(fx.V, 'run', '2.json'), JSON.stringify({ v: 1, generation: 7 }))
  refused(fx, 4, /^corrupt: .*2\.json/)
  fs.rmSync(path.join(fx.V, 'run'), { recursive: true })
  fs.writeFileSync(path.join(fx.V, 'run'), 'not a directory\n')
  refused(fx, 4, /^corrupt: .*run is not a directory/)
})

test('exit 2: a referenced patch byte-flipped, missing or replaced', TIMEOUT, t => {
  const fx = project(t)
  const x = patchFile(fx, 'TECH-LEAD-RECOVERY v1 {"fixture":2}\nbody\n')
  const y = patchFile(fx, 'an older resolved save\n')
  record(fx, 2, { phase: 'clean', ...onBranch(fx), saves: [{ sha: y, why: 'pause' }] })
  record(fx, 3, { phase: 'saved', ...onBranch(fx), saves: [{ sha: x, why: 'attempt-failed' }] })
  assert.equal(plan(fx, 4).code, 0)
  const file = patchPath(fx, x)
  const good = fs.readFileSync(file)
  const flipped = Buffer.from(good)
  flipped[0] ^= 0x01
  fs.writeFileSync(file, flipped)
  refused(fx, 4, new RegExp(`^tampered: .*${x}\\.patch`))
  fs.rmSync(file)
  refused(fx, 4, new RegExp(`^tampered: .*${x}\\.patch`))
  // Same bytes behind a symlink: not the store's own file.
  const elsewhere = path.join(tmp(t, 'tl-recover-x-'), 'x.patch')
  fs.writeFileSync(elsewhere, good)
  fs.symlinkSync(elsewhere, file)
  refused(fx, 4, new RegExp(`^tampered: .*${x}\\.patch`))
  fs.rmSync(file)
  fs.writeFileSync(file, good)
  assert.equal(plan(fx, 4).code, 0)
  // A resolved record's anchor counts too.
  fs.writeFileSync(patchPath(fx, y), 'replaced\n')
  refused(fx, 4, new RegExp(`^tampered: .*${y}\\.patch`))
})

test('exit 2: clone-invalid, with the problems', TIMEOUT, t => {
  const fx = project(t, { now: ITEM })
  fs.mkdirSync(path.join(fx.W, '.git', 'info'))
  fs.writeFileSync(path.join(fx.W, '.git', 'info', 'exclude'), 'secret/\n')
  let out = refused(fx, 1, /^clone-invalid: /)
  assert.deepEqual(out.problems, ['.git/info is not empty: exclude'])
  fs.rmSync(path.join(fx.W, '.git', 'info'), { recursive: true })
  git(fx.W, 'config', 'core.fsmonitor', 'true')
  out = refused(fx, 1, /^clone-invalid: /)
  assert.deepEqual(out.problems, ['config key not allowed: core.fsmonitor'])
  git(fx.W, 'config', '--unset', 'core.fsmonitor')
  assert.equal(plan(fx, 1).code, 0)
  // A <W> that is a symlink to a valid clone is not the clone.
  const real = `${fx.W}.real`
  fs.renameSync(fx.W, real)
  fs.symlinkSync(real, fx.W)
  out = refused(fx, 1, /^clone-invalid: /)
  assert.match(out.problems[0], /not a directory/)
})

test('exit 2: unknown-tip when the newest unresolved record reads unknown', TIMEOUT, t => {
  const fx = project(t)
  // HEAD is on today's branch; the record names another one.
  record(fx, 3, { phase: 'prepared', ...onBranch(fx), branch: 'tech-lead-loop/2026-09-29', head_ref: OTHER_REF })
  refused(fx, 4, /^unknown-tip: generation 3/)
})

test('legacy <S>/worktree facts are reported and planned no action', TIMEOUT, async t => {
  const fx = project(t, { legacy: true })
  fs.writeFileSync(path.join(fx.legacy, 'a.txt'), 'changed by a 0c-1 firing\n')
  fs.writeFileSync(path.join(fx.legacy, 'staged.txt'), 'staged\n')
  git(fx.legacy, 'add', 'staged.txt')
  fs.writeFileSync(path.join(fx.legacy, 'left.txt'), 'leftover\n')
  const out = ok(fx, 1)
  assert.deepEqual(out.legacy, { worktree: { exists: true, staged: true, tracked: true, untracked: ['left.txt'], more: 0, problem: null } })
  assert.deepEqual(out.actions, [])
  assert.ok(out.notes.some(n => /legacy/.test(n)), JSON.stringify(out.notes))

  await t.test('a plain directory there is a problem, not an error, and git never answers for <P>', () => {
    const fy = project(t)
    fs.mkdirSync(fy.legacy)
    fs.writeFileSync(path.join(fy.P, 'a.txt'), 'the owner is editing\n')
    const o = ok(fy, 1)
    assert.equal(o.legacy.worktree.exists, true)
    assert.equal(o.legacy.worktree.tracked, false)
    assert.match(o.legacy.worktree.problem, /^not-a-worktree: /)
    assert.deepEqual(o.actions, [])
  })
})

test('it never writes: <P> (with <S>), <V> (run, patches, out, lock) and <W> with its .git are byte- and time-identical', TIMEOUT, async t => {
  const fx = project(t, { now: ITEM, legacy: true })
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  writeBundle(fx.paths, BRANCH, { why: 'commit', guard: () => {} })
  const x = patchFile(fx, 'an anchored save\n')
  record(fx, 1, { phase: 'clean', ...onBranch(fx), saves: [{ sha: x, why: 'pause' }] })
  record(fx, 2, { phase: 'intent', ...onBranch(fx), intent: { tree: c.tree, parent: fx.H0, commit: c.sha } })
  setLedger(fx, { iteration: 2, commits: [] })
  // The lock is held while the planner runs, as in a firing.
  const lock = await acquire(fx.P, { env: fx.env })
  assert.equal(lock.state, 'acquired')
  const N = lock.generation
  assert.ok(N > 2, `generation ${N} exceeds the records`)
  // Every kind of change in <W> and in the legacy worktree, plus stale stat data that a plain
  // `git status` would refresh by rewriting an index.
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'changed\n')
  fs.writeFileSync(path.join(fx.W, 'staged.txt'), 'staged\n')
  git(fx.W, 'add', 'staged.txt')
  fs.writeFileSync(path.join(fx.W, 'left.txt'), 'leftover\n')
  fs.utimesSync(path.join(fx.W, 'b.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  fs.writeFileSync(path.join(fx.legacy, 'a.txt'), 'legacy change\n')
  fs.utimesSync(path.join(fx.legacy, 'b.txt'), new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const take = () => ({ P: snapshot(fx.P), V: snapshot(fx.V) })
  const before = take()
  const out = ok(fx, N, '--reclaimed', String(N - 1))
  assert.deepEqual(out.actions, ['finish-commit', 'ledger-recovered', 'note-leftovers'])
  assert.deepEqual(out.clone.dirty, { staged: true, tracked: true, untracked: ['left.txt'], more: 0 })
  assert.deepEqual(take(), before)
  // The refused forms write nothing either.
  for (const args of [[fx.P], [fx.P, '--generation', '2'], [fx.P, '--generation', String(N), '--worktree', fx.legacy]]) {
    assert.equal(run(fx, ...args).code, 2, JSON.stringify(args))
  }
  assert.deepEqual(take(), before)
})

test('refuses a <P> below the top level, a missing STATE.md and bad usage, with one JSON line', TIMEOUT, t => {
  const fx = project(t, { clone: false })
  fs.mkdirSync(path.join(fx.P, 'sub'))
  let r = run(fx, path.join(fx.P, 'sub'), '--generation', '1')
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^not-toplevel: /)

  fs.rmSync(path.join(fx.S, 'STATE.md'))
  r = plan(fx, 1)
  assert.equal(r.code, 2)
  assert.match(r.out.detail, /^no-state: /)

  for (const args of [
    [], [fx.P], [fx.P, '--generation'], ['--generation', '1'], [fx.P, fx.P, '--generation', '1'],
    [fx.P, '--generation', '0'], [fx.P, '--generation', 'x'], [fx.P, '--generation', '1.5'],
    [fx.P, '--generation', '9007199254740993'], [fx.P, '--generation', '1', '--generation', '1'],
    [fx.P, '--generation', '2', '--reclaimed', 'x'], [fx.P, '--generation', '2', '--reclaimed', '0'],
    [fx.P, '--reclaimed', '1'], [fx.P, '--generation', '2', '--reclaimed', '1', '--reclaimed', '1'],
    [fx.P, '--generation', '1', '--worktree', fx.S], [fx.P, '--generation', '1', '--bundle', 'x'],
  ]) {
    r = run(fx, ...args)
    assert.equal(r.code, 2, `exit 2 for ${JSON.stringify(args)}`)
    assert.equal(r.out.state, 'error')
    assert.match(r.out.detail, /^usage: /)
  }
})

test('nowLine is re-exported: the first line of ## Now, null when it is empty or missing', () => {
  assert.equal(PLACEHOLDER, '(empty)')
  assert.equal(nowLine(state({ now: ITEM })), ITEM)
  assert.equal(nowLine(state({ now: '(empty)' })), null)
  assert.equal(nowLine(state({ now: '' })), null)
  assert.equal(nowLine('## Now\r\n\r\n  - [ ] P1 task  \r\n  - status: -\r\n## Backlog\r\n'), '- [ ] P1 task')
  assert.equal(nowLine('## Now\n## Backlog\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Nowhere\n- [ ] P1 x\n'), null)
})

// ---------------------------------------------------------------- review round

// A standalone repository standing where the project tracks a gitlink `sub`, as a delegate can
// make it: its own config defines filter `evil` (a program that leaves a marker), its own
// .git/info/attributes selects it, and a tracked file there is edited, so a `git status` run
// inside it would call the filter.
const subRepo = (t, marker) => {
  const src = tmp(t, 'tl-recover-sub-')
  git(src, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(src, 'x.txt'), 'x\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-q', '-m', 'sub')
  return { src, sha: git(src, 'rev-parse', 'HEAD'), marker }
}
const populate = (dir, sub) => {
  fs.rmSync(dir, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--no-local', sub.src, dir], { stdio: 'ignore' })
  git(dir, 'config', 'filter.evil.clean', `touch '${sub.marker}'; cat`)
  git(dir, 'config', 'filter.evil.smudge', `touch '${sub.marker}'; cat`)
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '* filter=evil\n')
  // Same size, so git must hash the content (through the filter) to tell it changed.
  fs.writeFileSync(path.join(dir, 'x.txt'), 'y\n')
}
const gitlinkProject = (t, opts = {}) => {
  const marker = path.join(tmp(t, 'tl-recover-m-'), 'ran')
  const fx = project(t, { ...opts, clone: false })
  const sub = subRepo(t, marker)
  git(fx.P, 'update-index', '--add', '--cacheinfo', `160000,${sub.sha},sub`)
  git(fx.P, 'commit', '-q', '-m', 'track sub as a gitlink')
  fx.H0 = git(fx.P, 'rev-parse', 'HEAD')
  return { fx, sub, marker }
}

test('the clone status never runs git inside a populated nested repository (R26)', TIMEOUT, t => {
  const { fx, sub, marker } = gitlinkProject(t)
  makeClone(t, fx)
  populate(path.join(fx.W, 'sub'), sub)
  // Control: git's own status with --ignore-submodules=none runs the nested filter.
  spawnSync('git', ['-C', fx.W, 'status', '--porcelain', '--ignore-submodules=none'], { encoding: 'utf8' })
  assert.equal(fs.existsSync(marker), true, 'control: git status ran the filter inside sub')
  fs.rmSync(marker)
  const out = ok(fx, 1)
  assert.equal(fs.existsSync(marker), false, 'the planner ran a program inside the nested repository')
  // A dirty nested work tree is not reported; the gitlink itself at the recorded commit is clean.
  assert.deepEqual(out.clone.dirty, DIRTY_NONE)
  // A gitlink moved to another commit is still seen (and nothing runs).
  fs.writeFileSync(path.join(fx.W, 'sub', 'y.txt'), 'y\n')
  git(path.join(fx.W, 'sub'), 'add', 'y.txt')
  git(path.join(fx.W, 'sub'), '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'move the gitlink')
  fs.rmSync(marker, { force: true })
  const moved = ok(fx, 1)
  assert.equal(moved.clone.dirty.tracked, true, JSON.stringify(moved.clone.dirty))
  assert.equal(fs.existsSync(marker), false)
})

test('the legacy worktree status runs no filter: configured drivers emptied, nested repositories not entered (R26)', TIMEOUT, t => {
  const { fx, sub, marker } = gitlinkProject(t)
  makeClone(t, fx)
  git(fx.P, 'worktree', 'add', '-q', '-b', 'tech-lead-loop/2026-09-30', fx.legacy, 'main')
  // The owner's repository configures a clean filter; the legacy work tree's attributes select
  // it and a tracked file there is edited; its gitlink is populated by a hostile nested repo.
  git(fx.P, 'config', 'filter.evil.clean', `touch '${marker}'; cat`)
  git(fx.P, 'config', 'filter.evil.smudge', `touch '${marker}'; cat`)
  fs.writeFileSync(path.join(fx.legacy, '.gitattributes'), '* filter=evil\n')
  fs.writeFileSync(path.join(fx.legacy, 'a.txt'), 'changed by a 0c-1 firing\n')
  populate(path.join(fx.legacy, 'sub'), sub)
  spawnSync('git', ['-C', fx.legacy, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8' })
  assert.equal(fs.existsSync(marker), true, 'control: a plain status in the legacy worktree runs the filter')
  fs.rmSync(marker)
  const out = ok(fx, 1)
  assert.equal(fs.existsSync(marker), false, 'the planner ran a filter in the legacy worktree')
  assert.equal(out.legacy.worktree.tracked, true, JSON.stringify(out.legacy))
  assert.deepEqual(out.legacy.worktree.untracked, ['.gitattributes'])
  assert.equal(out.legacy.worktree.problem, null)
})

test('exit 2: a delivery bundle that cannot be inspected (I/O) stops the firing instead of becoming a note', TIMEOUT, async t => {
  const fx = project(t)
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  record(fx, 3, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha } })
  setLedger(fx, { iteration: 3, commits: [c.sha] })
  writeBundle(fx.paths, BRANCH, { why: 'commit', guard: () => {} })
  assert.deepEqual(ok(fx, 4).write_bundles, [])
  const side = `${bundlePath(fx.paths, BRANCH)}.json`
  for (const file of [side, bundlePath(fx.paths, BRANCH)]) {
    fs.chmodSync(file, 0o000)
    t.after(() => { try { fs.chmodSync(file, 0o600) } catch { /* removed */ } })
    const out = refused(fx, 4, new RegExp(`^bundle-check: ${BRANCH}: .*EACCES`))
    assert.equal(out.state, 'error')
    fs.chmodSync(file, 0o600)
  }
  assert.deepEqual(ok(fx, 4).write_bundles, [])
})

test('exit 2: a saved record whose HEAD was moved off its base (a delegate amend) reads unknown-tip, not resume (data-safety#3)', TIMEOUT, t => {
  const fx = project(t)
  const x = patchFile(fx, 'TECH-LEAD-RECOVERY v1 {"fixture":"amend"}\n')
  record(fx, 3, { phase: 'saved', ...onBranch(fx), saves: [{ sha: x, why: 'pause' }] })
  fs.writeFileSync(path.join(fx.W, 'a.txt'), 'amended\n')
  git(fx.W, 'commit', '-q', '--amend', '-a', '--no-edit')
  refused(fx, 4, /^unknown-tip: generation 3: tip /)
  // The same record with HEAD back at its base resumes.
  git(fx.W, 'update-ref', HEAD_REF, fx.H0)
  assert.deepEqual(ok(fx, 4).records.map(r => r.verdict), ['resume'])
  // A reset that began (phase resetting) with HEAD on a descendant of the base: unknown too.
  fs.rmSync(path.join(fx.V, 'run', '3.json'))
  record(fx, 3, { phase: 'resetting', ...onBranch(fx), saves: [{ sha: x, why: 'pause' }], reset_sha: x })
  commitInW(fx, 'more.txt', 'more\n', 'a delegate commit')
  refused(fx, 4, /^unknown-tip: generation 3: tip /)
})

test('write-bundle is withheld for a tip comparable with a kept retired tip <branch>@<sha12> (R27)', TIMEOUT, t => {
  const fx = project(t)
  const c = commitInW(fx, 'feature.txt', 'feature\n')
  record(fx, 3, { phase: 'committed', ...onBranch(fx), commit: { sha: c.sha } })
  setLedger(fx, { iteration: 3, commits: [c.sha] })
  git(fx.W, 'update-ref', `refs/tech-lead/retired/${BRANCH}@${c.sha.slice(0, 12)}`, c.sha)
  const out = ok(fx, 4)
  assert.deepEqual(out.write_bundles, [])
  assert.ok(out.notes.some(n => /retired/.test(n) && n.includes(BRANCH)), JSON.stringify(out.notes))
})
