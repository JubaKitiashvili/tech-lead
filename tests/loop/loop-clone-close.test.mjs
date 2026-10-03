// tests/loop/loop-clone-close.test.mjs
// loop-clone.mjs close (brief 13.9, R23), bundle (13.7), the read-only git passthrough (13.2) and
// the fencing of every mutating command. Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  D1, D2, FAKE_CODEX, PREFIX, T, appendLedger, attempt, bundleCli, check, cli, closeCli, commitCli, firing, git, killAt, prepare,
  project, recordGenerations, recordOf, snapshot, tipOf, write, end, bundleHeads,
} from './loop-clone-fixture.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { refsSnapshot } from '../../scripts/lib/clone-check.mjs'

const BRANCH = `${PREFIX}/${D2}`

test('close: a dirty own record is kept with exit 0 (R23); the next prepare saves those leftovers', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'left behind by a touch-nothing pause\n')
  const out = closeCli(fx)
  assert.equal(out.state, 'closed')
  assert.deepEqual(out.closed, [])
  assert.deepEqual(out.kept, [{ generation: fx.N, dirty: true, reason: 'dirty' }])
  const g = fx.N
  await firing(fx)
  const next = prepare(fx)
  assert.deepEqual(next.recovered.map(r => r.generation), [g])
})

test('close: ledgered records are deleted, the committed record\'s bundle made fresh first', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  const file = path.join(fx.V, 'out', PREFIX, `${D2}.bundle`)
  fs.rmSync(file)
  fs.rmSync(`${file}.json`)
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [fx.N])
  assert.deepEqual(out.kept, [])
  assert.equal(out.bundleError, undefined)
  assert.deepEqual(recordGenerations(fx), [])
  assert.deepEqual(bundleHeads(fx.P, file), [[a.commit.sha, `refs/heads/${BRANCH}`]])
})

test('close: a refs mismatch keeps the record; an unledgered record is kept and keeps every newer one', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: fx.N, commits: [a.commit.sha] })
  git(fx.W, ['tag', 'moved-meanwhile'])
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [])
  assert.deepEqual(out.kept, [{ generation: fx.N, dirty: false, reason: 'refs-mismatch' }])
  git(fx.W, ['tag', '-d', 'moved-meanwhile'])

  // An older record whose commit no ledger row names keeps itself and the newer records.
  const g1 = fx.N
  await firing(fx)
  // g1 is committed and unresolved: prepare resolves it (verdict committed).
  prepare(fx)
  assert.equal(recordOf(fx, g1).recovery.step, 'done')
  fs.writeFileSync(path.join(fx.S, 'LEDGER.jsonl'), JSON.stringify({ iteration: fx.N }) + '\n')
  const out2 = closeCli(fx)
  assert.deepEqual(out2.closed, [])
  assert.deepEqual(out2.kept, [
    { generation: g1, dirty: false, reason: 'unledgered' },
    { generation: fx.N, dirty: false, reason: 'older-kept' },
  ])
  appendLedger(fx, { iteration: fx.N, recovered: { commits: [a.commit.sha] } })
  const out3 = closeCli(fx)
  assert.deepEqual(out3.closed, [g1, fx.N])
  assert.deepEqual(recordGenerations(fx), [])
})

// <V>/run/refs.json, the refs anchor close leaves when it deletes records.
const anchorFile = fx => path.join(fx.V, 'run', 'refs.json')
const readAnchor = fx => JSON.parse(fs.readFileSync(anchorFile(fx), 'utf8'))
const cloneState = fx => ({ W: snapshot(fx.W, { skip: [], times: true }), out: snapshot(path.join(fx.V, 'out'), { skip: [], times: true }) })

test('close writes <V>/run/refs.json before it deletes records; prepare compares the clone with it when no newer record holds refs', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const g1 = fx.N
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  appendLedger(fx, { iteration: g1, commits: [a.commit.sha], bundles: [a.commit.bundle] })
  assert.equal(fs.existsSync(anchorFile(fx)), false, 'no anchor before the first close')
  const rules1 = recordOf(fx, g1).rules
  assert.ok(rules1)
  assert.deepEqual(closeCli(fx).closed, [g1])
  assert.deepEqual(recordGenerations(fx), [])
  assert.deepEqual(readAnchor(fx), { v: 2, generation: g1, refs: refsSnapshot(fx.W).refs, rules: rules1 })
  assert.equal(readAnchor(fx).refs[`refs/heads/${BRANCH}`], a.commit.sha)

  // Refs planted or moved after the clean close: prepare refuses tampered, naming each, and
  // changes nothing (no record, no bundle for the planted branch, <W> byte- and time-identical).
  const base = tipOf(fx.W, 'refs/tech-lead/base')
  git(fx.W, ['tag', 'evil'])
  git(fx.W, ['update-ref', `refs/heads/${PREFIX}/2026-01-01`, 'HEAD'])
  git(fx.W, ['update-ref', 'refs/tech-lead/base', 'HEAD'])
  await firing(fx)
  const before = cloneState(fx)
  const r = prepare(fx, { status: 3 })
  assert.equal(r.state, 'tampered')
  assert.deepEqual(r.refs, [`refs/heads/${PREFIX}/2026-01-01`, 'refs/tags/evil', 'refs/tech-lead/base'])
  assert.match(r.detail, new RegExp(`since generation ${g1} closed`))
  assert.deepEqual(cloneState(fx), before)
  assert.equal(recordOf(fx), null)
  assert.equal(fs.existsSync(path.join(fx.V, 'out', PREFIX, '2026-01-01.bundle')), false)
  // A close with no clone facts (no prepare this firing) leaves the anchor as it was.
  assert.deepEqual(closeCli(fx), { state: 'closed', closed: [], kept: [] })
  assert.equal(readAnchor(fx).generation, g1)

  // Undone, the clone is accepted again. The newer record then wins over the older anchor: g2
  // commits (its branch moves, which only its own record allows) and is never closed.
  git(fx.W, ['tag', '-d', 'evil'])
  git(fx.W, ['update-ref', '-d', `refs/heads/${PREFIX}/2026-01-01`])
  git(fx.W, ['update-ref', 'refs/tech-lead/base', base])
  await firing(fx)
  assert.equal(prepare(fx).state, 'ready')
  const g2 = fx.N
  attempt(fx, W => write(W, 'two.txt', '2\n'))
  await firing(fx)
  assert.equal(prepare(fx).state, 'ready', 'compared with g2\'s record, not with the anchor of g1')
  const g3 = fx.N
  assert.equal(recordOf(fx, g2).recovery.step, 'done')

  // A tie goes to the record: g3 is kept dirty while g2 is closed, so the anchor of g3 holds a
  // tag planted during g3, but the next prepare still compares with g3's own record.
  appendLedger(fx, { iteration: g3, recovered: { commits: [recordOf(fx, g2).commit.sha] } })
  write(fx.W, 'left.txt', 'left behind\n')
  git(fx.W, ['tag', 'planted-meanwhile'])
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [g2])
  assert.deepEqual(out.kept, [{ generation: g3, dirty: true, reason: 'dirty' }])
  assert.equal(readAnchor(fx).generation, g3)
  assert.ok(readAnchor(fx).refs['refs/tags/planted-meanwhile'])
  await firing(fx)
  const tie = prepare(fx, { status: 3 })
  assert.equal(tie.state, 'tampered')
  assert.deepEqual(tie.refs, ['refs/tags/planted-meanwhile'])
  assert.match(tie.detail, new RegExp(`since generation ${g3} recorded them`))
  git(fx.W, ['tag', '-d', 'planted-meanwhile'])

  // A malformed anchor, or one not older than the firing, is refused corrupt; nothing changes.
  const g4 = fx.N
  const good = fs.readFileSync(anchorFile(fx), 'utf8')
  fs.rmSync(path.join(fx.V, 'run', `${g3}.json`))
  for (const bad of ['{"v":2,', '[]', JSON.stringify({ v: 2, generation: 1, refs: {} }), JSON.stringify({ v: 1, generation: 1, refs: {} }),
    JSON.stringify({ v: 2, generation: 1, refs: { HEAD: a.commit.sha }, rules: null }),
    JSON.stringify({ v: 2, generation: 1, refs: { 'refs/tags/x': 'nope' }, rules: null }), JSON.stringify({ v: 2, generation: g4, refs: {}, rules: null }),
    JSON.stringify({ v: 2, generation: 1, refs: {}, rules: 'all' }), JSON.stringify({ v: 2, generation: 1, refs: {}, rules: { v: 1, mode: 'base', ignores: [] } })]) {
    fs.writeFileSync(anchorFile(fx), bad)
    const st = cloneState(fx)
    const c = prepare(fx, { status: 3 })
    assert.equal(c.state, 'corrupt', bad)
    assert.match(c.detail, /refs\.json/)
    assert.deepEqual(cloneState(fx), st)
    assert.equal(recordOf(fx), null)
  }
  fs.writeFileSync(anchorFile(fx), good)
})

test('close without a prepare in this firing deletes only records that need no clone fact', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const g1 = fx.N
  await firing(fx)
  prepare(fx) // resolves g1
  const g2 = fx.N
  await firing(fx)
  // No prepare: g1 is resolved and older than g2, so it needs no clone fact; g2 is unresolved.
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [g1])
  assert.deepEqual(out.kept, [{ generation: g2, dirty: false, reason: 'unresolved' }])
})

test('close killed after deleting one record: the next close finishes', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const a1 = attempt(fx, W => write(W, 'one.txt', '1\n'))
  const g1 = fx.N
  await firing(fx)
  prepare(fx) // resolves g1 (committed)
  appendLedger(fx, { iteration: fx.N, commits: [], recovered: { commits: [a1.commit.sha] } })
  killAt(fx, 'close:after-delete-one', 'close', fx.P, '--generation', String(fx.N))
  assert.deepEqual(recordGenerations(fx), [fx.N])
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [fx.N])
  void g1
})

test('bundle: current after a commit; regenerated after corruption; unvetted for a branch nothing vouches for', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx, { date: D1 })
  const a = attempt(fx, W => write(W, 'one.txt', '1\n'))
  const b1 = `${PREFIX}/${D1}`
  assert.equal(bundleCli(fx, b1).state, 'current')
  const file = path.join(fx.V, 'out', PREFIX, `${D1}.bundle`)
  fs.appendFileSync(file, 'corrupt')
  const out = bundleCli(fx, b1)
  assert.equal(out.state, 'bundled')
  assert.equal(out.bundle.tip, a.commit.sha)
  assert.deepEqual(bundleHeads(fx.P, file), [[a.commit.sha, `refs/heads/${b1}`]])
  // A dated branch nothing vouches for (a delegate's) is never bundled.
  git(fx.W, ['update-ref', `refs/heads/${PREFIX}/2026-09-01`, a.commit.sha])
  write(fx.W, 'x.txt', 'x\n')
  git(fx.W, ['add', 'x.txt'])
  const tree = git(fx.W, ['write-tree'])
  const rogue = git(fx.W, ['commit-tree', tree, '-p', a.commit.sha, '-m', 'rogue'])
  git(fx.W, ['update-ref', `refs/heads/${PREFIX}/2026-09-01`, rogue])
  git(fx.W, ['reset', '-q', '--mixed', 'HEAD'])
  fs.rmSync(path.join(fx.W, 'x.txt'))
  const unvetted = bundleCli(fx, `${PREFIX}/2026-09-01`, { status: 3 })
  assert.equal(unvetted.state, 'unvetted')
  assert.equal(fs.existsSync(path.join(fx.V, 'out', PREFIX, '2026-09-01.bundle')), false)
  const bad = cli(fx.env, 'bundle', fx.P, '--generation', String(fx.N), '--branch', 'main')
  assert.equal(bad.status, 2)
})

test('git passthrough: read-only subcommands run with the per-subcommand flags; everything else is refused', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const pass = (...args) => cli({ ...fx.env, GIT_TRACE: '1' }, 'git', fx.P, '--', ...args)
  const traced = (r, sub) => r.stderr.split('\n').find(l => / trace: built-in: git /.test(l) && l.includes(` ${sub}`)) || ''
  const head = pass('rev-parse', 'HEAD')
  assert.equal(head.status, 0, head.stderr)
  assert.equal(head.stdout.trim(), tipOf(fx.W))
  assert.match(traced(pass('diff', 'HEAD'), 'diff'), / diff --no-ext-diff --no-textconv --ignore-submodules=dirty HEAD/)
  assert.match(traced(pass('log', '-1', '--oneline'), 'log'), / log --no-ext-diff --no-textconv -1 --oneline/)
  assert.match(traced(pass('show', '--stat', 'HEAD'), 'show'), / show --no-ext-diff --no-textconv --stat HEAD/)
  assert.match(traced(pass('blame', 'a.txt'), 'blame'), / blame --no-textconv a\.txt/)
  assert.match(traced(pass('status', '--short'), 'status'), / status --ignore-submodules=dirty --short$/)
  assert.doesNotMatch(traced(pass('status', '--short'), 'status'), /no-textconv/)
  // git's own exit status passes through.
  assert.equal(pass('rev-parse', '--verify', '-q', 'refs/heads/nope').status, 1)
  const refusedLine = r => {
    const last = r.stderr.trim().split('\n').pop()
    assert.match(last, /^loop-clone git: /)
    return JSON.parse(last.slice('loop-clone git: '.length))
  }
  for (const argv of [
    ['commit', '-m', 'x'], ['-c', 'core.pager=sh', 'log'], ['diff', '--output=/tmp/x'], ['diff', '--outp=/tmp/x'], ['log', '--ext-diff'],
    ['show', '--textconv'], ['cat-file', '--filters', 'HEAD:a.txt'], ['log', '-O/dev/null'], ['grep', '-nO', 'x'],
    ['grep', '--open-files-in-pager=vi', 'x'], ['log', '--upload-pack=x'], ['log', '--receive-pack=x'], ['log', '--exec=x'],
    ['config', '--list'], [],
  ]) {
    const r = pass(...argv)
    assert.equal(r.status, 2, `${JSON.stringify(argv)} -> ${r.status} ${r.stderr}`)
    assert.equal(refusedLine(r).state, 'refused', JSON.stringify(argv))
  }
  // Paths after -- are never options.
  assert.equal(pass('log', '--oneline', '--', '--output=x').status, 0)
  assert.equal(pass('diff', '--text', 'HEAD').status, 0)
  // An invalid clone is refused.
  git(fx.W, ['config', 'user.name', 'delegate'])
  const inv = pass('status')
  assert.equal(inv.status, 2)
  assert.match(refusedLine(inv).detail, /user\.name/)
})

test('git passthrough: trace2 from the caller\'s config still reaches the caller\'s own git command, never the helper\'s checks', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const cfg = path.join(fx.root, 'trace2.gitconfig')
  fs.writeFileSync(cfg, '[trace2]\n\tnormalTarget = /dev/stderr\n')
  const r = cli({ ...fx.env, GIT_CONFIG_GLOBAL: cfg }, 'git', fx.P, '--', 'rev-parse', 'HEAD')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), tipOf(fx.W))
  const names = r.stderr.split('\n').map(l => / cmd_name (\S+)/.exec(l)?.[1]).filter(Boolean)
  assert.deepEqual(names, ['rev-parse'], 'only the caller\'s command is traced, as the caller\'s own git would')
})

test('fencing: every mutating command with a stale generation is not-holder and changes nothing', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'work\n')
  const c = check(fx, 'dispatch')
  const stale = fx.N
  await end(fx)
  const r = await acquire(fx.P, { env: fx.env })
  fx.N = r.generation
  const snap = () => ({ W: snapshot(fx.W, { skip: [], times: true }), V: snapshot(fx.V, { skip: ['lock', 'clone'], times: true }) })
  const before = snap()
  const subj = path.join(fx.root, 'subj')
  fs.writeFileSync(subj, 'S\n')
  const cmds = [
    ['prepare', fx.P, '--generation', String(stale), '--prefix', PREFIX, '--base', 'main', '--date', D2],
    ['deps', fx.P, '--generation', String(stale), '--mark'],
    ['deps', fx.P, '--generation', String(stale), '--clear'],
    ['check', fx.P, '--generation', String(stale), '--after', 'dispatch'],
    ['commit', fx.P, '--generation', String(stale), '--digest', c.digest, '--subject-file', subj],
    ['bundle', fx.P, '--generation', String(stale), '--branch', BRANCH],
    ['close', fx.P, '--generation', String(stale)],
  ]
  for (const args of cmds) {
    const out = cli(fx.env, ...args)
    assert.equal(out.status, 3, `${args[0]}: ${out.stdout} ${out.stderr}`)
    assert.equal(out.out.state, 'not-holder', args[0])
  }
  assert.deepEqual(snap(), before)
  void commitCli
})

test('a corrupt run record is refused corrupt by prepare and close, and nothing changes', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const g1 = fx.N
  fs.writeFileSync(path.join(fx.V, 'run', `${g1}.json`), '{"v":1,"generation":')
  await firing(fx)
  const before = snapshot(fx.W, { skip: [], times: true })
  assert.equal(prepare(fx, { status: 3 }).state, 'corrupt')
  assert.equal(closeCli(fx, { status: 3 }).state, 'corrupt')
  assert.deepEqual(snapshot(fx.W, { skip: [], times: true }), before)
  assert.equal(recordOf(fx), null)
})

// A companion that stands for a Codex job which wrote into <W>/.git while it was stopped: on
// `status` it plants .git/info/exclude in the --cwd it is asked about, then answers as the
// fixture companion does (its lib/ is the fixture's, so the broker API is there too).
function plantingCompanion(fx) {
  const dir = path.join(fx.root, 'companion')
  fs.mkdirSync(dir)
  fs.symlinkSync(path.join(path.dirname(FAKE_CODEX), 'lib'), path.join(dir, 'lib'))
  const file = path.join(dir, 'codex-companion.mjs')
  fs.writeFileSync(file, [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { spawnSync } from 'node:child_process'",
    'const argv = process.argv.slice(2)',
    "if (argv[0] === 'status' && argv.includes('--cwd')) {",
    "  const git = path.join(argv[argv.indexOf('--cwd') + 1], '.git')",
    "  fs.mkdirSync(path.join(git, 'info'), { recursive: true })",
    "  fs.writeFileSync(path.join(git, 'info', 'exclude'), 'written by a job that just stopped\\n')",
    '}',
    `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_CODEX)}, ...argv], { stdio: 'inherit' })`,
    'process.exit(r.status ?? 1)',
    '',
  ].join('\n'))
  const state = path.join(fx.root, 'codex-state.json')
  fs.writeFileSync(state, '{}')
  return { ...fx.env, TECH_LEAD_CODEX_COMPANION: file, FAKE_CODEX_STATE: state }
}

test('close quiesces Codex before it reads <W>: not quiet, or the clone invalid after the quiesce, keeps the own record (no-clone-facts) and writes no anchor (contracts-tests#6)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  appendLedger(fx, { iteration: fx.N })
  const state = path.join(fx.root, 'codex-not-quiet.json')
  fs.writeFileSync(state, JSON.stringify({ listError: 'state unreadable' }))
  const notQuiet = { ...fx.env, TECH_LEAD_CODEX_COMPANION: FAKE_CODEX, FAKE_CODEX_STATE: state }
  const before = snapshot(fx.W, { skip: [], times: true })
  const out = closeCli(fx, { env: notQuiet })
  assert.deepEqual(out, { state: 'closed', closed: [], kept: [{ generation: fx.N, dirty: false, reason: 'no-clone-facts' }] })
  assert.equal(fs.existsSync(anchorFile(fx)), false, 'no anchor from a clone that may still be written')
  assert.deepEqual(recordGenerations(fx), [fx.N])
  assert.deepEqual(snapshot(fx.W, { skip: [], times: true }), before)

  // Quiet, but the stopped job left the clone invalid: still nothing is read or deleted.
  const planting = plantingCompanion(fx)
  const out2 = closeCli(fx, { env: planting })
  assert.deepEqual(out2.kept, [{ generation: fx.N, dirty: false, reason: 'no-clone-facts' }])
  assert.deepEqual(out2.closed, [])
  assert.equal(fs.existsSync(anchorFile(fx)), false)
  fs.rmSync(path.join(fx.W, '.git', 'info'), { recursive: true })

  // Once Codex is quiet and the clone is valid, close reads it and closes the record.
  assert.deepEqual(closeCli(fx).closed, [fx.N])
  assert.equal(fs.existsSync(anchorFile(fx)), true)
})

test('close deletes a record only once the ledger names its recovery bundles and its own saves (contracts-tests#4)', T, async t => {
  // A recovery bundle anchored in an older record's recovery.bundles.
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'left behind\n')
  const g1 = fx.N
  assert.deepEqual(closeCli(fx).kept, [{ generation: g1, dirty: true, reason: 'dirty' }])
  await firing(fx)
  const g2 = fx.N
  const p2 = prepare(fx)
  const sha = p2.recovered[0].sha
  assert.deepEqual(recordOf(fx, g1).recovery.bundles, [sha])
  fs.writeFileSync(path.join(fx.S, 'LEDGER.jsonl'), JSON.stringify({ iteration: g2 }) + '\n')
  const out = closeCli(fx)
  assert.deepEqual(out.closed, [])
  assert.deepEqual(out.kept, [{ generation: g1, dirty: false, reason: 'unledgered' }, { generation: g2, dirty: false, reason: 'older-kept' }])
  appendLedger(fx, { iteration: g2, recovered: { bundles: [sha] } })
  assert.deepEqual(closeCli(fx).closed, [g1, g2])

  // A clean-clone save anchored in the firing's own saves (no older record left).
  write(fx.W, 'b.txt', 'a stray edit after the close\n')
  await firing(fx)
  const g3 = fx.N
  const p3 = prepare(fx)
  const own = p3.recovered[0].sha
  assert.deepEqual(recordOf(fx, g3).saves, [{ sha: own, why: 'clean-clone' }])
  appendLedger(fx, { iteration: g3 })
  const out3 = closeCli(fx)
  assert.deepEqual(out3.closed, [])
  assert.deepEqual(out3.kept, [{ generation: g3, dirty: false, reason: 'unledgered' }])
  appendLedger(fx, { iteration: g3, saves: [{ sha: own }] })
  assert.deepEqual(closeCli(fx).closed, [g3])
})
