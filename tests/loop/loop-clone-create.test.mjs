// tests/loop/loop-clone-create.test.mjs
// loop-clone.mjs prepare: creating <W> (brief 13.4), refresh (13.5), rotation and chaining
// (13.6, R11), adoption (13.8), legacy coexistence (R10). Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  D1, D2, D3, D4, PREFIX, T, appendLedger, attempt, check, cli, closeCli, firing, git, killAt, prepare, prepareArgs,
  project, recordOf, snapshot, status, tipOf, headRef, write, tmp, bundleHeads,
} from './loop-clone-fixture.mjs'
import { checkClone, refsSnapshot, cloneMeta } from '../../scripts/lib/clone-check.mjs'
import { workGit } from '../../scripts/lib/git-safe.mjs'
import { adoptBranches, commitMessage } from '../../scripts/loop-clone.mjs'

const today = date => `${PREFIX}/${date}`

// A finished firing's ledger row and close, so its record is gone and its commit stays vetted.
function finish(fx, out) {
  const row = { iteration: fx.N, commits: out ? [out.commit.sha] : [], bundles: out && out.commit.bundle ? [out.commit.bundle] : null }
  appendLedger(fx, row)
  const c = closeCli(fx)
  assert.equal(c.state, 'closed', JSON.stringify(c))
  return c
}

test('prepare creates <W>: a full clone, no remote, no alternates, no .git/info, mode 0700; <P> byte- and time-identical', T, async t => {
  const fx = project(t)
  git(fx.P, ['tag', 'v1'])
  git(fx.P, ['branch', 'feature'])
  write(fx.P, 'c.txt', 'c\n')
  git(fx.P, ['add', '-A'])
  git(fx.P, ['commit', '-q', '-m', 'second'])
  const before = snapshot(fx.P, { skip: ['.tech-lead'], times: true })
  await firing(fx)
  const out = prepare(fx)
  const main = tipOf(fx.P, 'main')
  assert.equal(out.state, 'ready')
  assert.equal(out.W, fx.W)
  assert.equal(out.created, true)
  assert.equal(out.branch, today(D2))
  assert.equal(out.base, 'main')
  assert.equal(out.baseSha, main)
  assert.equal(out.head, main)
  assert.equal(out.startPoint, 'refs/tech-lead/base')
  assert.equal(out.chainedFrom, null)
  assert.equal(out.retiredReset, false)
  assert.equal(out.baseAhead, false)
  assert.deepEqual(out.recovered, [])
  assert.equal(fs.statSync(fx.W).mode & 0o777, 0o700)
  assert.equal(git(fx.W, ['config', '--get-regexp', '^(remote|branch)[.]'], { check: false }), '')
  assert.equal(fs.existsSync(path.join(fx.W, '.git', 'objects', 'info', 'alternates')), false)
  assert.equal(fs.existsSync(path.join(fx.W, '.git', 'info')), false)
  assert.equal(git(fx.W, ['rev-parse', '--is-shallow-repository']), 'false')
  assert.equal(git(fx.W, ['rev-list', '--count', 'refs/tech-lead/base']), git(fx.P, ['rev-list', '--count', 'main']))
  assert.deepEqual(checkClone(fx.W), { problems: [] })
  assert.deepEqual(Object.keys(refsSnapshot(fx.W).refs).sort(), [
    `refs/heads/${today(D2)}`, 'refs/remotes/origin/feature', 'refs/remotes/origin/main', 'refs/tags/v1', 'refs/tech-lead/base',
  ])
  assert.equal(headRef(fx.W), `refs/heads/${today(D2)}`)
  assert.equal(status(fx.W), '')
  assert.equal(fs.readFileSync(path.join(fx.W, 'c.txt'), 'utf8'), 'c\n')
  assert.deepEqual(snapshot(fx.P, { skip: ['.tech-lead'], times: true }), before, '<P> is byte- and time-identical, .git included')
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'prepared')
  assert.equal(rec.branch, today(D2))
  assert.equal(rec.head_ref, `refs/heads/${today(D2)}`)
  assert.equal(rec.base, main)
  assert.equal(rec.rules, null)
  assert.deepEqual(rec.refs, refsSnapshot(fx.W).refs)
  assert.equal(rec.meta_sha, cloneMeta(fx.W))
  assert.equal(rec.now_sha256, null)
})

test('a kill after the clone leaves a mode-0700 temporary clone that the next prepare removes (R15, R18)', T, async t => {
  const fx = project(t)
  await firing(fx)
  killAt(fx, 'clone:after-clone', ...prepareArgs(fx))
  const tmps = fs.readdirSync(fx.V).filter(n => n.startsWith('clone.tmp-'))
  assert.equal(tmps.length, 1)
  const tmpDir = path.join(fx.V, tmps[0])
  assert.equal(fs.statSync(tmpDir).mode & 0o777, 0o700)
  assert.ok(fs.existsSync(path.join(tmpDir, '.git', 'HEAD')), 'the content had arrived')
  assert.equal(fs.existsSync(fx.W), false)
  const killed = fx.N
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.created, true)
  assert.deepEqual(fs.readdirSync(fx.V).filter(n => n.startsWith('clone.tmp-')), [])
  const old = recordOf(fx, killed)
  assert.equal(old.recovery.step, 'done')
  assert.equal(old.recovery.note, 'clone-missing')
  assert.ok(out.notes.some(n => /clone missing/.test(n)), JSON.stringify(out.notes))
})

test('loop12: the base comes from <P> (its default branch without --base), never from the clone\'s origin/HEAD', T, async t => {
  const fx = project(t)
  git(fx.P, ['branch', 'develop'])
  git(fx.P, ['switch', '-q', 'develop'])
  write(fx.P, 'dev.txt', 'dev\n')
  git(fx.P, ['add', '-A'])
  git(fx.P, ['commit', '-q', '-m', 'dev'])
  git(fx.P, ['switch', '-q', '-c', 'feature'])
  write(fx.P, 'feat.txt', 'feat\n')
  git(fx.P, ['add', '-A'])
  git(fx.P, ['commit', '-q', '-m', 'feat'])
  git(fx.P, ['update-ref', 'refs/remotes/origin/develop', 'develop'])
  git(fx.P, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
  write(fx.P, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
  await firing(fx)
  const out = prepare(fx, { base: null })
  assert.ok(out.notes.some(n => /project git hooks do not run on loop commits/.test(n) && n.includes('pre-commit') && !n.includes('core.hooksPath')),
    JSON.stringify(out.notes))
  assert.equal(out.base, 'develop')
  assert.equal(out.baseSha, tipOf(fx.P, 'develop'))
  assert.equal(tipOf(fx.W), tipOf(fx.P, 'develop'), 'the checked-out feature branch plays no part')
  assert.equal(fs.existsSync(path.join(fx.W, 'feat.txt')), false)
  assert.equal(git(fx.W, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/HEAD'], { check: false }), '')
})

test('no base: prepare refuses no-base and creates nothing; a project without hooks gets no hooks note', T, async t => {
  const fx = project(t)
  await firing(fx)
  assert.ok(!prepare(fx, { date: D1 }).notes.some(n => /hooks/.test(n)))
  fs.rmSync(fx.W, { recursive: true, force: true })
  fs.rmSync(path.join(fx.V, 'run'), { recursive: true, force: true })
  await firing(fx)
  const out = prepare(fx, { base: null, status: 3 })
  assert.equal(out.state, 'no-base')
  assert.equal(fs.existsSync(fx.W), false)
  assert.equal(recordOf(fx), null)
  const bad = prepare(fx, { base: 'nope', status: 3 })
  assert.equal(bad.state, 'no-base')
})

test('refresh: a base that advances between resolveBase and the fetch is the base the clone records', T, async t => {
  const fx = project(t)
  await firing(fx)
  const first = prepare(fx, { date: D2 })
  const oldBase = first.baseSha
  // A git on PATH that advances <P>'s main once, just before the first fetch runs.
  const shim = tmp(t, 'tl-lc-shim-')
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const mark = path.join(shim, 'advanced')
  fs.writeFileSync(path.join(shim, 'git'), [
    '#!/bin/sh',
    'case " $* " in',
    `  *" fetch "*) if [ ! -e '${mark}' ]; then : > '${mark}'; (unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_LITERAL_PATHSPECS; '${realGit}' -C '${fx.P}' commit -q --allow-empty -m advance) || exit 99; fi ;;`,
    'esac',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  await firing(fx)
  const env = { ...fx.env, PATH: `${shim}:${process.env.PATH}` }
  const out = prepare(fx, { date: D2, env })
  assert.ok(fs.existsSync(mark), 'the shim ran')
  const advanced = tipOf(fx.P, 'main')
  assert.notEqual(advanced, oldBase)
  assert.equal(out.baseSha, advanced, 'baseSha is the base at fetch time')
  assert.equal(tipOf(fx.W, 'refs/tech-lead/base'), advanced)
  assert.equal(out.head, oldBase, "today's branch is kept, never rebased")
  assert.equal(out.baseAhead, true)
  assert.equal(recordOf(fx).base, oldBase)
  await firing(fx)
  const next = prepare(fx, { date: D3 })
  assert.equal(next.head, advanced, 'a new day starts from the base')
  assert.equal(next.chainedFrom, null)
})

test('chaining across days; after a merge and after a squash merge the next day starts from the base', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  const a1 = attempt(fx, W => write(W, 'one.txt', '1\n'))
  const c1 = a1.commit.sha
  assert.equal(git(fx.W, ['rev-parse', `${c1}^`]), tipOf(fx.P, 'main'))
  finish(fx, a1)

  await firing(fx)
  const day2 = prepare(fx, { date: D2 })
  assert.equal(day2.chainedFrom, today(D1))
  assert.equal(day2.startPoint, `refs/heads/${today(D1)}`)
  assert.equal(day2.head, c1)
  const a2 = attempt(fx, W => write(W, 'two.txt', '2\n'))
  finish(fx, a2)

  // The owner fetches the day-2 bundle into <P> and merges it.
  const b2 = path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)
  assert.deepEqual(bundleHeads(fx.P, b2), [[a2.commit.sha, `refs/heads/${today(D2)}`]])
  git(fx.P, ['fetch', '-q', b2, `refs/heads/${today(D2)}:refs/remotes/tech-lead/${today(D2)}`])
  git(fx.P, ['merge', '-q', '--no-ff', '-m', 'merge day 2', `refs/remotes/tech-lead/${today(D2)}`])

  await firing(fx)
  const day3 = prepare(fx, { date: D3 })
  assert.equal(day3.chainedFrom, null, 'merged branches are not chained on')
  assert.equal(day3.head, tipOf(fx.P, 'main'))
  const a3 = attempt(fx, W => write(W, 'three.txt', '3\n'))
  finish(fx, a3)

  // A squash merge: the base holds the work but not the commit.
  const b3 = path.join(fx.V, 'out', PREFIX, `${D3}.bundle`)
  git(fx.P, ['fetch', '-q', b3, `refs/heads/${today(D3)}:refs/remotes/tech-lead/${today(D3)}`])
  git(fx.P, ['merge', '-q', '--squash', `refs/remotes/tech-lead/${today(D3)}`])
  git(fx.P, ['commit', '-q', '-m', 'squash day 3'])
  await firing(fx)
  const day4 = prepare(fx, { date: D4 })
  assert.equal(day4.chainedFrom, null, 'a squash-merged branch is contained in the base')
  assert.equal(day4.head, tipOf(fx.P, 'main'))
})

test('adoption at creation: one copy is taken, or the descendant of two; diverged copies are not; the clone never moves a name it has', T, async t => {
  const fx = project(t)
  const commitOn = (ref, file) => {
    git(fx.P, ['switch', '-q', '--detach', ref])
    write(fx.P, file, `${file}\n`)
    git(fx.P, ['add', '-A'])
    git(fx.P, ['commit', '-q', '-m', file])
    const sha = tipOf(fx.P)
    git(fx.P, ['switch', '-q', 'main'])
    return sha
  }
  const a = commitOn('main', 'a26.txt')
  git(fx.P, ['update-ref', `refs/heads/${PREFIX}/2026-09-26`, a])
  const b = commitOn('main', 'b27.txt')
  git(fx.P, ['update-ref', `refs/remotes/tech-lead/${PREFIX}/2026-09-27`, b])
  const x = commitOn('main', 'x28.txt')
  const xy = commitOn(x, 'y28.txt')
  git(fx.P, ['update-ref', `refs/heads/${PREFIX}/2026-09-28`, x])
  git(fx.P, ['update-ref', `refs/remotes/tech-lead/${PREFIX}/2026-09-28`, xy])
  const p1 = commitOn('main', 'p1.txt')
  const p2 = commitOn('main', 'p2.txt')
  git(fx.P, ['update-ref', `refs/heads/${PREFIX}/2026-09-29`, p1])
  git(fx.P, ['update-ref', `refs/remotes/tech-lead/${PREFIX}/2026-09-29`, p2])
  git(fx.P, ['update-ref', 'refs/heads/other/2026-09-25', a])
  await firing(fx)
  const out = prepare(fx, { date: D2 })
  assert.deepEqual(out.adopted.map(r => [r.branch, r.tip]), [
    [`${PREFIX}/2026-09-26`, a], [`${PREFIX}/2026-09-27`, b], [`${PREFIX}/2026-09-28`, xy],
  ])
  assert.ok(out.notes.some(n => n.includes(`${PREFIX}/2026-09-29`) && /diverged/.test(n)), JSON.stringify(out.notes))
  const heads = git(fx.W, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']).split('\n')
  assert.deepEqual(heads.sort(), [
    `refs/heads/${PREFIX}/2026-09-26 ${a}`, `refs/heads/${PREFIX}/2026-09-27 ${b}`, `refs/heads/${PREFIX}/2026-09-28 ${xy}`,
    `refs/heads/${today(D2)} ${xy}`,
  ].sort())
  assert.equal(out.chainedFrom, `${PREFIX}/2026-09-28`, 'adopted tips are vetted and chained on')
  assert.deepEqual(checkClone(fx.W), { problems: [] })
  assert.equal(recordOf(fx).refs[`refs/heads/${PREFIX}/2026-09-26`], a)
  // A second adoption never moves a name the clone has.
  workGit(fx.W, ['update-ref', `refs/tech-lead/adopt/${PREFIX}/2026-09-26`, b])
  const again = adoptBranches(fx.W, PREFIX)
  assert.ok(!again.adopted.some(r => r.branch === `${PREFIX}/2026-09-26`), JSON.stringify(again.adopted))
  assert.equal(tipOf(fx.W, `refs/heads/${PREFIX}/2026-09-26`), a)
  workGit(fx.W, ['update-ref', '-d', `refs/tech-lead/adopt/${PREFIX}/2026-09-26`])
})

test('legacy coexistence (R10): a registered dirty <S>/worktree on a dated branch is left byte-identical; its branch is adopted and chained', T, async t => {
  const fx = project(t)
  const wt = path.join(fx.S, 'worktree')
  git(fx.P, ['worktree', 'add', '-q', '-b', today(D1), wt, 'main'])
  write(wt, 'legacy.txt', 'legacy\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', 'legacy work'])
  const legacyTip = tipOf(wt)
  write(wt, 'a.txt', 'dirty\n')
  write(wt, 'staged.txt', 'staged\n')
  git(wt, ['add', 'staged.txt'])
  write(wt, 'untracked.txt', 'u\n')
  const wtBefore = snapshot(wt, { skip: [], times: true })
  const adminDir = path.join(fx.P, '.git', 'worktrees', 'worktree')
  const adminBefore = snapshot(adminDir, { skip: [], times: true })
  const pBefore = snapshot(path.join(fx.P, '.git'), { skip: [], times: true })
  await firing(fx)
  const out = prepare(fx, { date: D2 })
  assert.equal(out.state, 'ready')
  assert.deepEqual(out.adopted.map(r => [r.branch, r.tip]), [[today(D1), legacyTip]])
  assert.equal(out.chainedFrom, today(D1))
  assert.equal(out.head, legacyTip)
  assert.deepEqual(snapshot(wt, { skip: [], times: true }), wtBefore, 'the legacy worktree is byte- and time-identical')
  assert.deepEqual(snapshot(adminDir, { skip: [], times: true }), adminBefore)
  assert.deepEqual(snapshot(path.join(fx.P, '.git'), { skip: [], times: true }), pBefore)
})

test('retire (R11): today\'s branch comparable with a retired tip is reset; chaining skips the retired branch and its descendants', T, async t => {
  const fx = project(t)
  const base = tipOf(fx.P, 'main')
  await firing(fx)
  prepare(fx, { date: D1 })
  const a1 = attempt(fx, W => write(W, 'one.txt', '1\n'))
  finish(fx, a1)
  await firing(fx)
  const day2 = prepare(fx, { date: D2 })
  assert.equal(day2.chainedFrom, today(D1))
  const a2 = attempt(fx, W => write(W, 'two.txt', '2\n'))
  finish(fx, a2)
  // The owner fetches day 1's bundle into <P> and retires it.
  git(fx.P, ['fetch', '-q', path.join(fx.V, 'out', PREFIX, `${D1}.bundle`), `refs/heads/${today(D1)}:refs/remotes/tech-lead/${today(D1)}`])
  git(fx.P, ['update-ref', `refs/tech-lead/retired/${today(D1)}`, a1.commit.sha])

  await firing(fx)
  const day3 = prepare(fx, { date: D3 })
  assert.equal(day3.chainedFrom, null, 'day 2 descends from the retired tip and is skipped')
  assert.equal(day3.head, base)
  assert.equal(day3.retiredReset, false)
  assert.ok(!day3.bundles.some(b => b.branch === today(D1) || b.branch === today(D2)), JSON.stringify(day3.bundles))
  assert.equal(tipOf(fx.W, `refs/tech-lead/retired/${today(D1)}`), a1.commit.sha)
  appendLedger(fx, { iteration: fx.N, commits: [] })
  closeCli(fx)

  // Back on day 2: today's branch descends from the retired tip and is reset.
  await firing(fx)
  const again = prepare(fx, { date: D2 })
  assert.equal(again.retiredReset, true)
  assert.equal(again.head, base)
  assert.equal(tipOf(fx.W, `refs/heads/${today(D2)}`), base)
  const b2 = path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)
  assert.deepEqual(bundleHeads(fx.P, b2), [[a2.commit.sha, `refs/heads/${today(D2)}`]], 'the rejected work stays in its bundle')
  // The next commit on today's branch rewrites the bundle and keeps the rejected one as .prev.
  const a3 = attempt(fx, W => write(W, 'three.txt', '3\n'))
  assert.deepEqual(bundleHeads(fx.P, b2), [[a3.commit.sha, `refs/heads/${today(D2)}`]])
  const prev = fs.readdirSync(path.dirname(b2)).filter(n => n.startsWith(`${D2}.bundle.prev-`))
  assert.equal(prev.length, 1)
  assert.deepEqual(bundleHeads(fx.P, path.join(path.dirname(b2), prev[0])), [[a2.commit.sha, `refs/heads/${today(D2)}`]])
})

test('prepare refuses a shallow <P> as infra before writing anything', T, async t => {
  const src = project(t)
  const root = tmp(t, 'tl-lc-shallow-')
  const P = path.join(root, 'shallow')
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src.P}`, P], { stdio: 'pipe', env: process.env })
  fs.mkdirSync(path.join(P, '.tech-lead'))
  fs.writeFileSync(path.join(P, '.tech-lead', 'LOOP.md'), fs.readFileSync(path.join(src.S, 'LOOP.md')))
  const fx = { ...src, P, S: path.join(P, '.tech-lead'), env: { ...src.env, TECH_LEAD_CACHE: path.join(root, 'cache') }, N: null }
  await firing(fx)
  const out = prepare(fx, { status: 3 })
  assert.equal(out.state, 'infra')
  assert.match(out.detail, /shallow/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache', 'tech-lead')).length, 1)
  const V = path.join(root, 'cache', 'tech-lead', fs.readdirSync(path.join(root, 'cache', 'tech-lead'))[0])
  assert.equal(fs.existsSync(path.join(V, 'clone')), false)
  assert.equal(fs.existsSync(path.join(V, 'run', `${fx.N}.json`)), false)
})

test('prepare sweeps the temporary files of dead processes and their partial clones, never a live one\'s', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  const dead = Number(execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!'], { encoding: 'utf8' }).trim())
  const live = fx.holder
  const plant = (rel, dir = false) => {
    const p = path.join(fx.V, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    if (dir) {
      fs.mkdirSync(p)
      fs.writeFileSync(path.join(p, 'f'), 'x')
    } else fs.writeFileSync(p, 'x')
    return p
  }
  const gone = [
    plant(`patches/.tmp-${dead}-0123456789abcdef.patch`), plant(`run/.tmp-${dead}-0123456789abcdef`),
    plant(`out/${PREFIX}/.tmp-${dead}-0123456789abcdef.bundle`), plant(`patches/.tmp-${dead}-aaaaaaaaaaaaaaaa`, true),
    plant(`clone.tmp-${dead}-0badcafe`, true),
  ]
  fs.mkdirSync(path.join(fx.V, `clone.tmp-${dead}-0badcafe`, 'nested'))
  const kept = [plant(`patches/.tmp-${live}-0123456789abcdef.patch`), plant(`clone.tmp-${live}-0badcafe`, true)]
  await firing(fx)
  prepare(fx, { date: D2 })
  for (const p of gone) assert.equal(fs.existsSync(p), false, p)
  for (const p of kept) assert.equal(fs.existsSync(p), true, p)
})

test('a forced repack and gc after rotation leave checkClone clean, and the next prepare is ready', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  await firing(fx)
  const out = prepare(fx, { date: D2 })
  assert.equal(out.rotated, true)
  workGit(fx.W, ['repack', '-a', '-d', '-f', '-q'])
  workGit(fx.W, ['gc', '--auto', '--quiet'], { config: ['gc.auto=1', 'gc.autoDetach=false', 'gc.autoPackLimit=1'] })
  workGit(fx.W, ['gc', '--quiet'], { config: ['gc.autoDetach=false'] })
  assert.deepEqual(checkClone(fx.W), { problems: [] })
  assert.equal(fs.existsSync(path.join(fx.W, '.git', 'info')), false)
  await firing(fx)
  assert.equal(prepare(fx, { date: D2 }).state, 'ready')
})

test('prepare refuses a bad prefix or date as usage, and an attempt already open', T, async t => {
  const fx = project(t)
  await firing(fx)
  const bad = cli(fx.env, 'prepare', fx.P, '--generation', String(fx.N), '--prefix', '-x', '--date', D2)
  assert.equal(bad.status, 2)
  assert.equal(bad.out.state, 'error')
  const date = cli(fx.env, 'prepare', fx.P, '--generation', String(fx.N), '--prefix', PREFIX, '--date', '2026-02-30')
  assert.equal(date.status, 2)
  assert.equal(fs.existsSync(fx.W), false)
  prepare(fx)
  const open = prepare(fx, { status: 3 })
  assert.equal(open.state, 'attempt-open')
})

test('commitMessage: the first subject line without control characters, at most 200 characters, its trailers', () => {
  const esc = String.fromCharCode(0x1b)
  assert.equal(commitMessage({ subject: `Fix ${esc}[31mit\tnow\nCo-Authored-By: x <y>\n`, generation: 7 }), 'Fix [31mitnow\n\nTech-Lead-Generation: 7\n')
  const long = 'x'.repeat(300)
  assert.equal(commitMessage({ subject: long, generation: 1 }).split('\n')[0].length, 200)
  assert.throws(() => commitMessage({ subject: '\n\n', generation: 1 }), /empty-subject/)
  // The item trailer (R19) takes only an item id (ID_RE); anything else is a TypeError.
  assert.equal(commitMessage({ subject: 'S', generation: 3, item: 'tl-0123abcd' }), 'S\n\nTech-Lead-Item: tl-0123abcd\nTech-Lead-Generation: 3\n')
  assert.equal(commitMessage({ subject: 'S', generation: 3, item: null }), 'S\n\nTech-Lead-Generation: 3\n')
  for (const bad of ['it-1', 'TL-0123ABCD', 'tl-0123abci', 'tl-0123abcd ', 'fix the parser', '', 7]) {
    assert.throws(() => commitMessage({ subject: 'S', generation: 3, item: bad }), TypeError, JSON.stringify(bad))
  }
})

void check
void D4
