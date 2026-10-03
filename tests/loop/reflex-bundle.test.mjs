// tests/loop/reflex-bundle.test.mjs
// Recovery bundles (brief section 11): saves, verify, tamper refusals, hostile config, fencing
// and the size cap. Resets are in reflex-bundle-reset.test.mjs, apply in
// reflex-bundle-apply.test.mjs, the SIGKILL matrix in reflex-bundle-fault.test.mjs; the shared
// fixture (a held lock, a normalized clone, a prepared run record) is reflex-bundle-fixture.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  T, bundles, cli, fixture, git, gitState, header, patchFile, recordOf, run, save, scratchApply, sha256, sleeper, snapshot, temps, write,
} from './reflex-bundle-fixture.mjs'
import { saveFor, readBundle, verifyBundle, WHYS } from '../../scripts/reflex-bundle.mjs'
import { acquire } from '../../scripts/loop-lock.mjs'
import { baseRules, rulesSha } from '../../scripts/lib/changes.mjs'
import { canonicalJson } from '../../scripts/lib/canonical.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'

const N_ = f => String(f.N)
const D = 'd'.repeat(64)
const kill = async pid => {
  process.kill(pid, 'SIGKILL')
  for (let i = 0; i < 100 && startToken(pid).state !== 'gone'; i++) await new Promise(r => setTimeout(r, 30))
  assert.equal(startToken(pid).state, 'gone')
}

test('save: every change kind round-trips byte-exact under autocrlf and a rewriting filter; the record anchors the sha', T, async t => {
  const nameE = `caf${String.fromCharCode(0xe9)}.txt`
  const f = await fixture(t, {
    '.gitignore': '*.log\n', '.gitattributes': '*.dat filter=rw\n',
    'm.txt': 'one\ntwo\n', 'd.txt': 'gone\n', 'x.sh': 'echo x\n', 'e.sh': 'echo e\n', 't1': 'file\n', 'c.txt': 'a\nb\n',
    'a.dat': 'hello\n', 'b.bin': Buffer.from([0, 1, 2, 3, 0, 255]), 'obs': 'was a file\n', 'dir/f.txt': 'f\n', 'gone/g.txt': 'g\n',
    'blank.txt': 'x\n\ny\n',
  }, { links: { l1: 'm.txt', l2: 'm.txt' }, execs: ['e.sh'] })
  const { W } = f
  const marker = path.join(f.root, 'filter-ran')
  const script = path.join(f.root, 'rw.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\nsed s/hello/HELLO/\n`, { mode: 0o755 })
  const gcfg = path.join(f.root, 'crlf.gitconfig')
  fs.writeFileSync(gcfg, `[core]\n\tautocrlf = true\n[filter "rw"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n`)

  write(W, 'm.txt', 'one\nTWO\nthree\n')
  fs.rmSync(path.join(W, 'd.txt'))
  fs.chmodSync(path.join(W, 'x.sh'), 0o755)
  fs.chmodSync(path.join(W, 'e.sh'), 0o644)
  fs.rmSync(path.join(W, 't1'))
  fs.symlinkSync('m.txt', path.join(W, 't1'))
  fs.rmSync(path.join(W, 'l1'))
  write(W, 'l1', 'now a file\n')
  fs.rmSync(path.join(W, 'l2'))
  fs.symlinkSync('d.txt', path.join(W, 'l2'))
  fs.symlinkSync('nowhere/x', path.join(W, 'nl'))
  write(W, 'c.txt', 'a\r\nb\r\nc\r\n')
  write(W, 'crlf.txt', 'x\r\ny\r\n')
  write(W, 'a.dat', 'hello secret\r\n')
  write(W, 'b.bin', Buffer.from([0, 1, 2, 3, 0, 254, 7]))
  write(W, 'bin.dat', crypto.randomBytes(2048))
  write(W, 'empty.txt', '')
  write(W, 'nonl.txt', 'abc')
  write(W, 'blank.txt', 'x\n\ny\nz\n')
  for (const n of ['sp ace.txt', 'tab\there.txt', 'quote"d.txt', 'new\nline.txt', nameE]) write(W, n, `${n}\n`)
  write(W, 'new/sub/a.txt', 'deep\n')
  fs.rmSync(path.join(W, 'obs'))
  write(W, 'obs/inner.txt', 'in\n')
  write(W, 'obs/ignored.log', 'ignored, inside an obstructing directory\n')
  fs.rmSync(path.join(W, 'dir'), { recursive: true })
  fs.symlinkSync('m.txt', path.join(W, 'dir'))
  fs.rmSync(path.join(W, 'gone'), { recursive: true })
  write(W, 'junk.log', 'ignored\n')
  fs.appendFileSync(path.join(W, '.gitignore'), 'secret.txt\n')
  write(W, 'secret.txt', 'hidden by a rule added after the rules were recorded\n')
  write(W, '.tech-lead/x.md', 'a governance copy\n')

  const before = snapshot(W)
  const state = gitState(W)
  const env = { ...f.env, GIT_CONFIG_GLOBAL: gcfg }
  const r = run(env, 0, 'save', f.P, '--generation', N_(f), '--why', 'delegate-flagged')
  assert.equal(r.state, 'saved')
  assert.match(r.sha, /^[0-9a-f]{64}$/)
  assert.equal(r.file, patchFile(f, r.sha))
  assert.equal(sha256(fs.readFileSync(r.file)), r.sha)
  assert.equal(r.reused, false)
  assert.equal(r.base, f.base)
  assert.deepEqual(r.warnings, ['scope-whole'])
  assert.deepEqual(r.out_of_scope, ['.tech-lead/x.md'])
  assert.deepEqual(r.hidden, ['secret.txt'])
  assert.equal(r.files, r.counts.files)
  assert.equal(fs.existsSync(marker), false, 'no filter ran while saving')

  const rec = recordOf(f)
  assert.equal(rec.phase, 'saved')
  assert.deepEqual(rec.saves, [{ sha: r.sha, why: 'delegate-flagged' }])
  assert.deepEqual(snapshot(W), before, 'the work tree is untouched')
  assert.deepEqual(gitState(W), state, 'no index, HEAD, ref or stash change')

  const h = header(f, r.sha)
  assert.equal(h.v, 1)
  assert.equal(h.why, 'delegate-flagged')
  assert.equal(h.generation, f.N)
  assert.deepEqual(h.source, { generation: f.N })
  assert.equal(h.base, f.base)
  assert.equal(h.head, f.base)
  assert.equal(h.item_digest, null)
  assert.equal(h.item_id, null)
  assert.deepEqual(h.rules, { mode: 'recorded', sha: rulesSha(f.rules) })
  assert.deepEqual(h.scope.state, 'whole')
  assert.deepEqual(h.scope.entries, ['.'])
  const byPath = new Map(h.files.map(e => [typeof e.path === 'string' ? e.path : e.path.b64, e]))
  const kind = p => byPath.get(p)?.kind
  assert.equal(kind('m.txt'), 'modified')
  assert.equal(kind('d.txt'), 'deleted')
  assert.equal(kind('x.sh'), 'mode-changed')
  assert.deepEqual([byPath.get('e.sh').old_mode, byPath.get('e.sh').mode], ['100755', '100644'])
  assert.equal(kind('t1'), 'type-changed')
  assert.equal(kind('l1'), 'type-changed')
  assert.equal(kind('l2'), 'modified')
  assert.equal(byPath.get('nl').mode, '120000')
  assert.equal(kind('obs'), 'deleted')
  assert.equal(kind('dir'), 'added')
  assert.equal(kind('dir/f.txt'), 'deleted')
  assert.equal(kind('gone/g.txt'), 'deleted')
  assert.equal(byPath.get('bin.dat').binary, true)
  assert.equal(byPath.has('junk.log'), false, 'an ignored file is not saved')
  // 'dir' (a symlink where the base tracks the directory dir) is the mirror of R21 (Cg1#2).
  assert.deepEqual(h.files.filter(e => e.obstructed).map(e => e.path), ['dir', 'obs/ignored.log', 'obs/inner.txt'])
  assert.deepEqual(h.files.filter(e => e.hidden).map(e => e.path), ['secret.txt'])
  assert.deepEqual(h.files.filter(e => !e.in_scope).map(e => e.path), ['.tech-lead/x.md'])
  assert.ok(fs.existsSync(path.join(f.V, 'patches', `rules-${rulesSha(f.rules)}.json`)), 'the rules are kept by their sha')

  // The bundle, applied by plain git to a scratch clone at the base, reproduces the work tree.
  assert.deepEqual(scratchApply(t, f, r.sha), snapshot(W, { dirs: false, skip: ['junk.log'] }))

  const v = run(env, 0, 'verify', f.P, '--sha', r.sha)
  assert.equal(v.state, 'verified')
  assert.equal(v.tree, h.tree)
  assert.equal(v.files, h.files.length)
  assert.deepEqual(snapshot(W), before)
  assert.deepEqual(gitState(W), state, 'verify changes no index, HEAD, ref or stash either')
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(temps(f), [], 'no temporary file is left')
})

test('a re-save while saved appends; the same change set gives the same sha and is not recorded twice', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'one\n')
  const s1 = save(f)
  assert.equal(s1.state, 'saved')
  write(f.W, 'b.txt', 'two\n')
  const s2 = save(f)
  assert.notEqual(s2.sha, s1.sha)
  assert.equal(s2.reused, false)
  assert.deepEqual(recordOf(f).saves, [{ sha: s1.sha, why: 'pause' }, { sha: s2.sha, why: 'pause' }])
  assert.equal(recordOf(f).phase, 'saved')
  const s3 = save(f)
  assert.equal(s3.sha, s2.sha)
  assert.equal(s3.reused, true)
  assert.equal(recordOf(f).saves.length, 2, 'the same save is recorded once')
  const s4 = save(f, 'codex')
  assert.notEqual(s4.sha, s2.sha, 'why is part of the header')
  assert.deepEqual(recordOf(f).saves.map(s => s.why), ['pause', 'pause', 'codex'])
  assert.deepEqual(bundles(f), [s1.sha, s2.sha, s4.sha].map(s => `${s}.patch`).sort())
})

test('a hostile global config gives the same sha and runs nothing', T, async t => {
  const f = await fixture(t, {
    '.gitattributes': '*.txt diff=hostile\n*.dat filter=hostile diff=hostile\n',
    'a.txt': 'x\n\ny\n\nw\n', 'b.dat': 'data\n', 'c.bin': Buffer.concat([Buffer.from([0]), Buffer.from('hello '.repeat(400))]),
  })
  write(f.W, 'a.txt', 'x\n\ny\n\nz\n')
  write(f.W, 'b.dat', 'data two\n')
  write(f.W, 'c.bin', Buffer.concat([Buffer.from([0, 1]), Buffer.from('hello world '.repeat(400))]))
  write(f.W, 'new.txt', 'new\n\n\nfile\n')
  const clean = save(f)
  assert.equal(clean.state, 'saved')

  const marker = path.join(f.root, 'hostile-ran')
  const prog = path.join(f.root, 'prog.sh')
  fs.writeFileSync(prog, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`, { mode: 0o755 })
  const hooks = path.join(f.root, 'hooks')
  fs.mkdirSync(hooks)
  for (const h of ['post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit', 'pre-auto-gc']) {
    fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho hook ${h} >> '${marker}'\n`, { mode: 0o755 })
  }
  const attrs = path.join(f.root, 'attributes')
  fs.writeFileSync(attrs, '* diff=hostile filter=hostile\n')
  const order = path.join(f.root, 'order')
  fs.writeFileSync(order, 'new.txt\n*\n')
  const gcfg = path.join(f.root, 'hostile.gitconfig')
  fs.writeFileSync(gcfg, [
    '[core]', `\thooksPath = ${hooks}`, `\tfsmonitor = ${prog}`, `\tpager = ${prog}`, `\tattributesFile = ${attrs}`,
    '\tbigFileThreshold = 1', '\tcompression = 9', '\tlooseCompression = 9', '\tquotePath = false',
    '[diff]', '\tnoprefix = true', `\texternal = ${prog}`, '\talgorithm = histogram', '\tsuppressBlankEmpty = true',
    '\tindentHeuristic = false', '\tcontext = 10', '\tinterHunkContext = 10', '\tmnemonicPrefix = true', '\trelative = true',
    '\trenames = copies', `\torderFile = ${order}`,
    '[diff "hostile"]', `\tcommand = ${prog}`, `\ttextconv = ${prog}`, '\tbinary = true', '\txfuncname = ^(.*)$',
    '[filter "hostile"]', `\tclean = ${prog}`, `\tsmudge = ${prog}`, `\tprocess = ${prog}`, '\trequired = true',
    '[color]', '\tui = always', '\tdiff = always',
    '[apply]', '\twhitespace = error', '\tignoreWhitespace = change',
    '[gc]', '\tauto = 1', '',
  ].join('\n'))
  const env = { ...f.env, GIT_CONFIG_GLOBAL: gcfg, GIT_EXTERNAL_DIFF: prog, GIT_PAGER: prog }
  const hostile = run(env, 0, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(hostile.sha, clean.sha, 'one change set, one sha')
  assert.equal(hostile.reused, true)
  run(env, 0, 'verify', f.P, '--sha', clean.sha)
  assert.equal(fs.existsSync(marker), false, `nothing ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`)
})

test('tamper is refused: a flipped byte, a truncation, a deletion, an edited header, a symlink; a store collision; an unknown base', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  write(f.W, 'a.txt', 'changed\n')
  write(f.W, 'n.txt', 'new\n')
  const s = save(f)
  const file = patchFile(f, s.sha)
  const good = fs.readFileSync(file)
  const snap = snapshot(f.W)
  const tampers = {
    flip: () => { const b = Buffer.from(good); b[b.length - 10] ^= 1; fs.writeFileSync(file, b) },
    truncate: () => fs.writeFileSync(file, good.subarray(0, good.length - 20)),
    delete: () => fs.rmSync(file),
    header: () => fs.writeFileSync(file, Buffer.from(good.toString('latin1').replace('"why":"pause"', '"why":"codex"'), 'latin1')),
    symlink: () => {
      const copy = path.join(f.root, 'copy.patch')
      fs.writeFileSync(copy, good)
      fs.rmSync(file)
      fs.symlinkSync(copy, file)
    },
  }
  for (const [name, tamper] of Object.entries(tampers)) {
    fs.rmSync(file, { force: true })
    fs.writeFileSync(file, good)
    tamper()
    const v = run(f.env, 3, 'verify', f.P, '--sha', s.sha)
    assert.equal(v.state, 'tampered', `${name}: ${JSON.stringify(v)}`)
    const r = run(f.env, 3, 'reset', f.P, '--generation', N_(f), '--sha', s.sha)
    assert.equal(r.state, 'tampered', `${name}: ${JSON.stringify(r)}`)
    assert.deepEqual(snapshot(f.W), snap, `${name}: the clone is untouched`)
    assert.equal(recordOf(f).phase, 'saved')
  }
  fs.rmSync(file, { force: true })
  fs.writeFileSync(file, good)
  assert.equal(run(f.env, 0, 'verify', f.P, '--sha', s.sha).state, 'verified')

  // A store collision: other bytes under the name the next save computes.
  const garbage = Buffer.from('not the bundle\n')
  fs.writeFileSync(file, garbage)
  const c = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(c.state, 'tampered')
  assert.deepEqual(fs.readFileSync(file), garbage, 'the existing file is never replaced')
  assert.deepEqual(recordOf(f).saves, [{ sha: s.sha, why: 'pause' }])
  assert.deepEqual(temps(f), [])

  // A well-formed bundle naming a base the clone does not have.
  const text = good.toString('latin1')
  const forged = Buffer.from(text.replace(`"base":"${f.base}"`, `"base":"${'f'.repeat(f.base.length)}"`), 'latin1')
  const fsha = sha256(forged)
  fs.writeFileSync(patchFile(f, fsha), forged)
  assert.equal(run(f.env, 3, 'verify', f.P, '--sha', fsha).state, 'base-unknown')
  assert.throws(() => readBundle(f.paths, 'z'.repeat(64)), e => e.code === 'REFUSED' && e.state === 'tampered')
})

test('fencing: a stale generation is not the holder and writes nothing', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  write(f.W, 'b.txt', 'more\n')
  const snap = snapshot(f.W)
  const rec = fs.readFileSync(path.join(f.V, 'run', `${f.N}.json`), 'utf8')
  await kill(f.holder)
  const env2 = { ...f.env, TECH_LEAD_HOLDER_PID: String(sleeper(t)) }
  const acq = await acquire(f.P, { env: env2 })
  assert.equal(acq.generation, f.N + 1)
  const before = bundles(f)
  for (const env of [f.env, env2]) {
    for (const args of [
      ['save', f.P, '--generation', N_(f), '--why', 'pause'],
      ['reset', f.P, '--generation', N_(f), '--sha', s.sha],
      ['apply', f.P, '--generation', N_(f), '--sha', s.sha],
    ]) {
      const r = run(env, 3, ...args)
      assert.equal(r.state, 'not-holder', `${args[0]}: ${JSON.stringify(r)}`)
    }
  }
  assert.throws(() => saveFor(f.paths, { saver: f.N, source: f.N, base: f.base, rules: f.rules, why: 'pause', env: env2 }), e => e.code === 'NOT_HOLDER')
  assert.deepEqual(bundles(f), before, 'no bundle written')
  assert.deepEqual(temps(f), [])
  assert.equal(fs.readFileSync(path.join(f.V, 'run', `${f.N}.json`), 'utf8'), rec, 'the record is unchanged')
  assert.deepEqual(snapshot(f.W), snap, 'the clone is unchanged')
})

test('the size cap refuses a bundle over TECH_LEAD_BUNDLE_MAX_BYTES and keeps nothing', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'big.txt', 'x'.repeat(4000) + '\n')
  write(f.W, 'a.txt', 'b\n')
  const r = run({ ...f.env, TECH_LEAD_BUNDLE_MAX_BYTES: '600' }, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(r.state, 'too-large')
  assert.ok(r.bytes > 600)
  assert.deepEqual(r.largest, { path: 'big.txt', size: 4001 })
  assert.deepEqual(bundles(f), [])
  assert.deepEqual(temps(f), [])
  assert.equal(recordOf(f).phase, 'prepared')
  assert.deepEqual(recordOf(f).saves, [])
  assert.equal(save(f).state, 'saved', 'under the default cap it saves')
})

test('save refuses index-only and unsavable content and an invalid clone; a clean clone is empty', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n', 'u.txt': 'u\n' })
  const e = run(f.env, 0, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.deepEqual(e, { state: 'empty', base: f.base, head: f.base, indexDirty: false, scope: e.scope })
  assert.deepEqual([e.scope.state, e.scope.entries], ['whole', ['.']])
  assert.match(e.scope.digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(recordOf(f).saves, [])

  const oid = git(f.W, ['hash-object', '-w', '--stdin'], { input: 'staged only\n' })
  git(f.W, ['update-index', '--cacheinfo', `100644,${oid},a.txt`])
  const io = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(io.state, 'index-only')
  assert.deepEqual(io.paths, ['a.txt'])
  git(f.W, ['read-tree', f.base])

  // git lists no untracked fifo; one standing where the base tracks a file cannot be saved.
  fs.rmSync(path.join(f.W, 'u.txt'))
  execFileSync('mkfifo', [path.join(f.W, 'u.txt')])
  const un = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(un.state, 'unsavable')
  assert.deepEqual(un.paths, [{ path: 'u.txt', reason: 'special-file' }])
  fs.rmSync(path.join(f.W, 'u.txt'))
  write(f.W, 'u.txt', 'u\n')

  fs.mkdirSync(path.join(f.W, '.git', 'info'), { recursive: true })
  fs.writeFileSync(path.join(f.W, '.git', 'info', 'attributes'), '* diff=x\n')
  write(f.W, 'a.txt', 'edited\n')
  const ci = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(ci.state, 'clone-invalid')
  assert.ok(ci.problems.some(p => p.includes('.git/info is not empty')))
  assert.deepEqual(bundles(f), [])
})

test('a changed gitlink is unsavable', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' }, { plumb: P => git(P, ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`]) })
  assert.ok(fs.lstatSync(path.join(f.W, 'sub')).isDirectory(), 'git checks a gitlink out as an empty directory')
  fs.rmdirSync(path.join(f.W, 'sub'))
  write(f.W, 'a.txt', 'edited\n')
  const r = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(r.state, 'unsavable')
  assert.deepEqual(r.paths, [{ path: 'sub', reason: 'gitlink' }])
  assert.deepEqual(bundles(f), [])
})

test('save needs a prepared record with recorded rules; usage errors exit 2', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' }, { record: false })
  write(f.W, 'a.txt', 'edited\n')
  assert.equal(run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause').state, 'no-record')
  for (const args of [
    ['save', f.P, '--generation', N_(f)],
    ['save', f.P, '--generation', N_(f), '--why', 'nope'],
    ['save', f.P, '--generation', '0', '--why', 'pause'],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item-digest', 'xyz'],
    ['reset', f.P, '--generation', N_(f), '--sha', 'abc'],
    ['verify', f.P],
    ['frob', f.P],
  ]) {
    const r = run(f.env, 2, ...args)
    assert.equal(r.state, 'error', args.join(' '))
    assert.match(r.detail, /^usage: /)
  }
  assert.deepEqual(WHYS, ['clean-clone', 'delegate-flagged', 'codex', 'attempt-failed', 'pause'])
})

test('saveFor as prepare calls it: base rules, no source, an item digest; verifyBundle and readBundle agree', T, async t => {
  const f = await fixture(t, { '.gitignore': '*.tmp\n', 'a.txt': 'a\n' }, { record: false })
  write(f.W, 'a.txt', 'left over\n')
  write(f.W, 'x.tmp', 'ignored by the base rules\n')
  write(f.W, 'n.txt', 'new\n')
  const rules = baseRules(f.wt, f.base)
  const r = saveFor(f.paths, { saver: f.N, source: null, base: f.base, rules, why: 'clean-clone', itemDigest: D, env: f.env })
  assert.equal(r.state, 'saved')
  assert.equal(r.item_digest, D)
  assert.deepEqual(r.paths, ['a.txt', 'n.txt'])
  const h = header(f, r.sha)
  assert.deepEqual(h.source, { generation: null })
  assert.equal(h.why, 'clean-clone')
  assert.deepEqual(h.rules, { mode: 'base', sha: rulesSha(rules) })
  assert.equal(h.item_digest, D)
  const stored = fs.readFileSync(path.join(f.V, 'patches', `rules-${rulesSha(rules)}.json`), 'utf8')
  assert.equal(stored, canonicalJson(rules))
  const b = verifyBundle(f.paths, r.sha, { env: f.env })
  assert.deepEqual(b.header, h)
  assert.deepEqual(readBundle(f.paths, r.sha).header, h)
  assert.equal(b.bytes, fs.statSync(r.file).size)
  // Nothing changed: the same call again is the same bundle.
  const again = saveFor(f.paths, { saver: f.N, source: null, base: f.base, rules, why: 'clean-clone', itemDigest: D, env: f.env })
  assert.equal(again.sha, r.sha)
  assert.equal(again.reused, true)
  assert.throws(() => saveFor(f.paths, { saver: f.N, base: f.base, rules, why: 'migration', env: f.env }), TypeError)
  const cli1 = cli(f.env, 'verify', f.P, '--sha', r.sha)
  assert.equal(cli1.status, 0)
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

const looseIn = gitDir => {
  let n = 0
  for (const d of fs.readdirSync(path.join(gitDir, 'objects'))) if (/^[0-9a-f]{2}$/.test(d)) n += fs.readdirSync(path.join(gitDir, 'objects', d)).length
  return n
}

test('a clone whose object store is a symlink into <P> is refused clone-invalid, and no object reaches <P> (Cg1#1, Cg3#2)', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  const pObjects = path.join(f.P, '.git', 'objects')
  fs.renameSync(path.join(f.W, '.git', 'objects'), path.join(f.root, 'w-objects'))
  fs.symlinkSync(pObjects, path.join(f.W, '.git', 'objects'))
  write(f.W, 'a.txt', 'a delegate edit that must not be hashed into <P>\n')
  write(f.W, 'n.txt', 'new\n')
  const before = looseIn(path.join(f.P, '.git'))
  const r = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(r.state, 'clone-invalid')
  assert.ok(r.problems.includes('.git/objects is a symlink'), JSON.stringify(r))
  assert.equal(looseIn(path.join(f.P, '.git')), before, 'no object was written into <P>')
  assert.deepEqual(bundles(f), [])
  assert.equal(recordOf(f).phase, 'prepared')
  // A symlinked loose-object directory and a symlinked refs directory are refused the same way.
  fs.rmSync(path.join(f.W, '.git', 'objects'))
  fs.renameSync(path.join(f.root, 'w-objects'), path.join(f.W, '.git', 'objects'))
  fs.mkdirSync(path.join(pObjects, 'ab'), { recursive: true })
  fs.rmSync(path.join(f.W, '.git', 'objects', 'ab'), { recursive: true, force: true })
  fs.symlinkSync(path.join(pObjects, 'ab'), path.join(f.W, '.git', 'objects', 'ab'))
  assert.equal(run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause').state, 'clone-invalid')
})

test('save refuses head-moved when a delegate moved HEAD off the base; nothing is written (data-safety#3)', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited, then amended into the base commit\n')
  git(f.W, ['commit', '-q', '--amend', '-a', '--no-edit'])
  const snap = snapshot(f.W)
  const r = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause')
  assert.equal(r.state, 'head-moved')
  assert.equal(r.base, f.base)
  assert.equal(r.head, git(f.W, ['rev-parse', 'HEAD']))
  assert.deepEqual(bundles(f), [])
  assert.equal(recordOf(f).phase, 'prepared')
  assert.deepEqual(recordOf(f).saves, [])
  assert.deepEqual(snapshot(f.W), snap)
  // The library default keeps saving whatever HEAD is (prepare's recovery saves against a base
  // it chose), and a HEAD back at the base saves again through the CLI.
  git(f.W, ['reset', '-q', '--soft', f.base])
  assert.equal(save(f).state, 'saved')
})

test('an empty save reports the scope it was judged under, the one a save under the same LOOP.md reports (Cg4#6)', T, async t => {
  const f = await fixture(t, { 'src/a.txt': 'a\n' }, { loopMd: '---\nverify:\n  - "true"\nscope:\n  - src\n---\n' })
  const e = run(f.env, 0, 'save', f.P, '--generation', N_(f), '--why', 'delegate-flagged')
  assert.equal(e.state, 'empty')
  assert.deepEqual(Object.keys(e.scope).sort(), ['digest', 'entries', 'state'])
  assert.deepEqual([e.scope.state, e.scope.entries], ['ok', ['src']])
  write(f.W, 'src/a.txt', 'b\n')
  const s = save(f, 'delegate-flagged')
  assert.deepEqual(e.scope, s.scope)
})

// A stand-in git first on PATH that drops GIT_ATTR_SOURCE, as a git older than 2.40 ignores it.
const oldGitEnv = (t, f) => {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = path.join(f.root, 'oldgit-bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nunset GIT_ATTR_SOURCE\nexec '${real}' "$@"\n`, { mode: 0o755 })
  return { ...f.env, PATH: `${bin}:${f.env.PATH}` }
}

test('on a git that ignores GIT_ATTR_SOURCE, save, reset and verify refuse infra git-too-old and write nothing (R24)', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  write(f.W, 'n.txt', 'new\n')
  const env = oldGitEnv(t, f)
  const snap = snapshot(f.W)
  for (const args of [['save', f.P, '--generation', N_(f), '--why', 'pause'], ['reset', f.P, '--generation', N_(f), '--sha', s.sha], ['verify', f.P, '--sha', s.sha]]) {
    const r = run(env, 3, ...args)
    assert.deepEqual(r, { state: 'infra', detail: 'git-too-old: needs git 2.40 or newer' }, args[0])
  }
  assert.deepEqual(bundles(f), [`${s.sha}.patch`])
  assert.deepEqual(snapshot(f.W), snap)
  assert.equal(recordOf(f).phase, 'saved')
})

// A stand-in git first on PATH that, once the first `rev-parse --verify` it runs in <W> has
// finished, points a loose-object directory of <W> at a directory outside the clone (as a
// delegate could, Cg1#1). Every later git run in <W> is then refused by git-safe's quick check
// (code CLONE_INVALID), mid-command: openClone's checkClone already passed.
const storageFlipEnv = f => {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const objects = path.join(f.W, '.git', 'objects')
  const name = ['ab', 'cd', 'ef', '12', '34', '56'].find(n => !fs.existsSync(path.join(objects, n)))
  const bin = path.join(f.root, 'flipgit-bin')
  const outside = path.join(f.root, 'outside-objects')
  fs.mkdirSync(bin)
  fs.mkdirSync(outside)
  const link = path.join(objects, name)
  const marker = path.join(f.root, 'flipped')
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `'${real}' "$@"`,
    'status=$?',
    `if [ "$GIT_DIR" = '${path.join(f.W, '.git')}' ] && [ ! -e '${marker}' ]; then`,
    '  case " $* " in',
    `    *" rev-parse --verify "*) ln -s '${outside}' '${link}' && : > '${marker}' ;;`,
    '  esac',
    'fi',
    'exit $status',
  ].join('\n') + '\n', { mode: 0o755 })
  const rearm = () => {
    fs.rmSync(link, { force: true })
    fs.rmSync(marker, { force: true })
  }
  return { env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, name, link, marker, rearm }
}

test('a storage path changed mid-command is refused clone-invalid (exit 3), as loop-clone refuses it, and nothing is written', T, async t => {
  const f = await fixture(t, { 'a.txt': 'a\n' })
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f)
  write(f.W, 'n.txt', 'new\n')
  const flip = storageFlipEnv(f)
  const snap = snapshot(f.W)
  const rec = recordOf(f)
  for (const args of [
    ['save', f.P, '--generation', N_(f), '--why', 'pause'],
    ['verify', f.P, '--sha', s.sha],
    ['reset', f.P, '--generation', N_(f), '--sha', s.sha],
    ['apply', f.P, '--generation', N_(f), '--sha', s.sha],
  ]) {
    flip.rearm()
    const r = cli(flip.env, ...args)
    assert.ok(fs.existsSync(flip.marker), `${args[0]}: the stand-in changed the storage path`)
    assert.equal(r.lines.length, 1, `${args[0]}: ${JSON.stringify(r.lines)} (stderr ${r.stderr})`)
    assert.equal(r.status, 3, `${args[0]} -> ${JSON.stringify(r.out)}`)
    assert.deepEqual(Object.keys(r.out).sort(), ['detail', 'problems', 'state'], args[0])
    assert.equal(r.out.state, 'clone-invalid', args[0])
    assert.equal(r.out.detail, `clone-invalid: ${f.W}/.git/objects/${flip.name} is a symlink`, args[0])
    assert.deepEqual(r.out.problems, [r.out.detail], args[0])
  }
  flip.rearm()
  assert.deepEqual(bundles(f), [`${s.sha}.patch`])
  assert.deepEqual(snapshot(f.W), snap)
  assert.deepEqual(recordOf(f), rec)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'outside-objects')), [], 'nothing was written through the link')
})
