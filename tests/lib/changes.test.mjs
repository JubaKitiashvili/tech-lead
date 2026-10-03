// tests/lib/changes.test.mjs
// The change-set owner (brief section 8): every change kind captured raw, the index replay of
// the recorded ignore rules, hidden vs standard listings, obstructing directories, index-only
// content, unsavable kinds and the touched digest. Real temp repositories: <P> is a top-level
// repository, <V> lives under a temp TECH_LEAD_CACHE, and the clone <W> = loopPaths(P).W is made
// with plain git (clone --no-local, normalized as the brief's section 13.4 does).
import '../helpers.mjs' // scrubs inherited git routing variables from process.env before any other module loads
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import * as ch from '../../scripts/lib/changes.mjs'
import { loopPaths } from '../../scripts/lib/loop-paths.mjs'
import { canonicalJson, sha256Hex } from '../../scripts/lib/canonical.mjs'

// A private XDG_CONFIG_HOME keeps the user's ~/.config/git/ignore out of every listing.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-chg-xdg-'))
after(() => fs.rmSync(XDG, { recursive: true, force: true }))
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', XDG_CONFIG_HOME: XDG,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
delete process.env.TECH_LEAD_CACHE

const T = { timeout: 90000 }
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

// Plain git, the control.
function git(cwd, args, { buffer = false, input, env = process.env, check = true } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, input, maxBuffer: 64 * 1024 * 1024 })
  if (check && r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  if (buffer) return r.stdout
  return r.stdout.toString('utf8').replace(/\n$/, '')
}

const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  try { return fn() } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

// <P> with `files` committed on main, <V> under a temp cache, and the clone <W> checked out on a
// dated branch at the base. Returns {root, P, W, V, base, wt, env}.
function fixture(t, files, { links = {}, execs = [], plumb } = {}) {
  const root = tmp(t, 'tl-chg-')
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
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(root, 'cache') }
  const paths = loopPaths(P, { env })
  fs.mkdirSync(paths.V, { recursive: true })
  const tpl = path.join(root, 'tpl')
  fs.mkdirSync(tpl)
  fs.mkdirSync(paths.W, { mode: 0o700 })
  execFileSync('git', ['clone', '--no-local', '--no-checkout', `--template=${tpl}`, '-q', '--', P, paths.W], { stdio: 'pipe' })
  const W = paths.W
  git(W, ['config', '--remove-section', 'remote.origin'], { check: false })
  for (const line of git(W, ['config', '--name-only', '--get-regexp', '^branch[.]'], { check: false }).split('\n')) {
    if (line) git(W, ['config', '--remove-section', line.slice(0, line.lastIndexOf('.'))], { check: false })
  }
  git(W, ['update-ref', '--no-deref', '-d', 'refs/remotes/origin/HEAD'], { check: false })
  // A name the volume cannot hold (APFS refuses non-UTF-8) fails alone; switch still exits 0.
  git(W, ['switch', '-q', '--no-track', '-c', 'tl/2026-10-02', 'refs/remotes/origin/main'])
  const base = git(W, ['rev-parse', 'HEAD'])
  const wt = ch.openWorkTree(P, { env })
  return { root, P, W, V: paths.V, base, wt, env }
}

const byBytes = (a, b) => Buffer.compare(ch.decodePath(a), ch.decodePath(b))
const sorted = list => [...list].sort(byBytes)

// Every file and symlink under dir (no .git), keyed by its raw relative path (latin1).
function worktreeMap(dir, rel = Buffer.alloc(0), out = new Map()) {
  const abs = rel.length ? Buffer.concat([Buffer.from(dir + '/'), rel]) : Buffer.from(dir)
  for (const e of fs.readdirSync(abs, { withFileTypes: true, encoding: 'buffer' })) {
    if (e.name.toString('latin1') === '.git') continue
    const r = rel.length ? Buffer.concat([rel, Buffer.from('/'), e.name]) : e.name
    const p = Buffer.concat([Buffer.from(dir + '/'), r])
    const st = fs.lstatSync(p)
    if (st.isDirectory()) worktreeMap(dir, r, out)
    else if (st.isSymbolicLink()) out.set(r.toString('latin1'), { mode: '120000', content: fs.readlinkSync(p, { encoding: 'buffer' }) })
    else out.set(r.toString('latin1'), { mode: st.mode & 0o100 ? '100755' : '100644', content: fs.readFileSync(p) })
  }
  return out
}

function treeEntries(W, tree) {
  const out = new Map()
  const raw = git(W, ['ls-tree', '-r', '-z', '--full-tree', tree], { buffer: true })
  for (const rec of splitNul(raw)) {
    const tab = rec.indexOf(9)
    const [mode, type, oid] = rec.subarray(0, tab).toString('latin1').split(' ')
    out.set(rec.subarray(tab + 1).toString('latin1'), { mode, type, oid })
  }
  return out
}

function treeContents(W, tree) {
  const out = new Map()
  for (const [k, e] of treeEntries(W, tree)) out.set(k, { mode: e.mode, content: git(W, ['cat-file', 'blob', e.oid], { buffer: true }) })
  return out
}

function splitNul(buf) {
  const out = []
  let start = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { out.push(buf.subarray(start, i)); start = i + 1 }
  return out
}

const blobAt = (W, tree, rel) => git(W, ['cat-file', 'blob', `${tree}:${rel}`], { buffer: true })
const noTemps = wt => assert.deepEqual(fs.readdirSync(wt.store).filter(n => n.startsWith('.tmp-')), [], 'temporary indexes removed')
const fileBytes = f => (fs.existsSync(f) ? fs.readFileSync(f) : null)

test('openWorkTree takes the clone layout only and creates the patch store', T, t => {
  const root = tmp(t, 'tl-chg-open-')
  const P = path.join(root, 'proj')
  fs.mkdirSync(P)
  git(P, ['init', '-q', '-b', 'main'])
  git(P, ['commit', '-q', '--allow-empty', '-m', 'base'])
  const env = { ...process.env, TECH_LEAD_CACHE: path.join(root, 'cache') }
  const { V, W } = loopPaths(P, { env })
  assert.throws(() => ch.openWorkTree(P, { env }), e => e.code === 'REFUSED' && e.state === 'layout')
  fs.mkdirSync(W, { recursive: true })
  fs.writeFileSync(path.join(W, '.git'), `gitdir: ${path.join(P, '.git')}\n`)
  assert.throws(() => ch.openWorkTree(P, { env }), e => e.code === 'REFUSED' && e.state === 'layout', 'a gitfile is refused')
  fs.rmSync(path.join(W, '.git'))
  fs.symlinkSync(path.join(P, '.git'), path.join(W, '.git'))
  assert.throws(() => ch.openWorkTree(P, { env }), e => e.code === 'REFUSED' && e.state === 'layout', 'a symlinked .git is refused')
  fs.rmSync(path.join(W, '.git'))
  git(W, ['init', '-q'])
  const wt = ch.openWorkTree(P, { env })
  assert.equal(wt.W, W)
  assert.equal(wt.V, V)
  assert.equal(wt.store, path.join(V, 'patches'))
  assert.ok(fs.statSync(wt.store).isDirectory())
})

test('R1 pin: git reads a missing skip-worktree per-directory exclude file from the index', T, t => {
  const r = tmp(t, 'tl-chg-pin-')
  git(r, ['init', '-q', '-b', 'main'])
  write(r, 'sub/keep.txt', 'k\n')
  git(r, ['add', '-A'])
  git(r, ['commit', '-q', '-m', 'base'])
  write(r, 'sub/a.log', 'x\n')
  write(r, 'sub/b.txt', 'y\n')
  const idx = path.join(r, '..', path.basename(r) + '.idx')
  t.after(() => fs.rmSync(idx, { force: true }))
  const env = { ...process.env, GIT_INDEX_FILE: idx }
  git(r, ['read-tree', 'HEAD'], { env })
  const oid = git(r, ['hash-object', '-w', '--no-filters', '--stdin'], { input: '*.log\n' })
  git(r, ['update-index', '-z', '--index-info'], { env, input: Buffer.from(`100644 ${oid}\tsub/.tlx-pin\0`) })
  git(r, ['update-index', '--skip-worktree', '-z', '--stdin'], { env, input: 'sub/.tlx-pin\0' })
  assert.equal(fs.existsSync(path.join(r, 'sub/.tlx-pin')), false)
  assert.deepEqual(git(r, ['ls-files', '-o', '--exclude-per-directory=.tlx-pin'], { env }).split('\n'), ['sub/b.txt'])
  // Without the flag git does not read the entry: the replay depends on skip-worktree.
  git(r, ['update-index', '--no-skip-worktree', '-z', '--stdin'], { env, input: 'sub/.tlx-pin\0' })
  assert.deepEqual(git(r, ['ls-files', '-o', '--exclude-per-directory=.tlx-pin'], { env }).split('\n'), ['sub/a.log', 'sub/b.txt'])
})

test('every change kind is listed, captured raw byte-exact, and described by the manifest', T, t => {
  const f = fixture(t, {
    'mod.txt': 'one\n', 'bin.dat': Buffer.from([0, 1, 2, 255, 0]), 'del.txt': 'gone\n', 'exec.sh': '#!/bin/sh\necho hi\n',
    'ren-old.txt': 'moving\n', f: 'file f\n', 'd/x': 'in d\n', 'same.txt': 'unchanged\n', tc: 'type\n',
  }, { links: { ln: 'mod.txt' } })
  const { W, wt, base } = f
  const rules = ch.recordRules(wt, { base })
  const realIndex = fileBytes(path.join(W, '.git/index'))
  const uni = 'caf' + String.fromCodePoint(0xe9) + ' ' + String.fromCodePoint(0xfc) + '.txt'

  write(W, 'mod.txt', 'one\ntwo\n')
  write(W, 'bin.dat', Buffer.from([0, 255, 254, 0, 10, 13]))
  write(W, 'empty.txt', '')
  fs.symlinkSync('../outside-target', path.join(W, 'new-link'))
  fs.rmSync(path.join(W, 'ln'))
  fs.symlinkSync('same.txt', path.join(W, 'ln'))
  fs.rmSync(path.join(W, 'tc'))
  fs.symlinkSync('mod.txt', path.join(W, 'tc'))
  fs.chmodSync(path.join(W, 'exec.sh'), 0o755)
  fs.rmSync(path.join(W, 'del.txt'))
  fs.renameSync(path.join(W, 'ren-old.txt'), path.join(W, 'ren-new.txt'))
  fs.rmSync(path.join(W, 'f'))
  write(W, 'f/g', 'g\n')
  fs.rmSync(path.join(W, 'd'), { recursive: true })
  write(W, 'd', 'now a file\n')
  write(W, uni, 'u\n')
  write(W, 'new\nline.txt', 'nl\n')

  const c = ch.collect(wt, { base, rules })
  assert.equal(c.base, base)
  assert.equal(c.head, base)
  assert.equal(c.headMoved, false)
  assert.deepEqual(c.tracked, sorted(['bin.dat', 'd/x', 'del.txt', 'exec.sh', 'f', 'ln', 'mod.txt', 'ren-old.txt', 'tc']))
  assert.deepEqual(c.untracked, sorted(['d', 'empty.txt', 'f/g', 'new\nline.txt', 'new-link', 'ren-new.txt', uni]))
  // 'd' stands where the base tracks the directory d (the mirror of R21, Cg1#2).
  assert.deepEqual(c.obstructed, ['d', 'f/g'])
  assert.deepEqual(c.hidden, [])
  assert.deepEqual(c.unsavable, [])
  assert.deepEqual(c.indexOnly, [])

  const { tree } = ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] })
  assert.deepEqual(treeContents(W, tree), worktreeMap(W), 'the captured tree is the work tree, byte for byte')

  const m = new Map(ch.manifest(wt, base, tree).map(e => [typeof e.path === 'string' ? e.path : JSON.stringify(e.path), e]))
  const kinds = Object.fromEntries([...m].map(([k, e]) => [k, e.kind]))
  assert.deepEqual(kinds, {
    'bin.dat': 'modified', d: 'added', 'd/x': 'deleted', 'del.txt': 'deleted', 'empty.txt': 'added', 'exec.sh': 'mode-changed',
    f: 'deleted', 'f/g': 'added', ln: 'modified', 'mod.txt': 'modified', 'new\nline.txt': 'added', 'new-link': 'added',
    'ren-new.txt': 'added', 'ren-old.txt': 'deleted', tc: 'type-changed', [uni]: 'added',
  })
  assert.equal(m.get('bin.dat').binary, true)
  assert.equal(m.get('bin.dat').size, 6)
  assert.equal(m.get('mod.txt').binary, false)
  assert.equal(m.get('mod.txt').oid, git(W, ['hash-object', '--no-filters', '--', 'mod.txt']))
  assert.equal(m.get('empty.txt').size, 0)
  assert.deepEqual([m.get('exec.sh').old_mode, m.get('exec.sh').mode], ['100644', '100755'])
  assert.deepEqual([m.get('tc').old_mode, m.get('tc').mode], ['100644', '120000'])
  assert.deepEqual([m.get('new-link').old_mode, m.get('new-link').mode], [null, '120000'])
  assert.deepEqual([m.get('del.txt').mode, m.get('del.txt').oid, m.get('del.txt').size], [null, null, null])
  assert.equal(blobAt(W, tree, 'new-link').toString(), '../outside-target')

  // Nothing the owner or a later git command reads was written.
  assert.deepEqual(fileBytes(path.join(W, '.git/index')), realIndex, 'the real index is unchanged')
  assert.equal(git(W, ['rev-parse', 'HEAD']), base)
  assert.equal(git(W, ['rev-parse', '-q', '--verify', 'refs/stash'], { check: false }), '')
  noTemps(wt)
})

test('tracked is the work tree against the base, independent of HEAD (loop04)', T, t => {
  const { W, wt, base } = fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  const rules = ch.recordRules(wt, { base })
  write(W, 'a.txt', 'committed\n')
  git(W, ['commit', '-q', '-am', 'delegate commit'])
  write(W, 'b.txt', 'uncommitted\n')
  const c = ch.collect(wt, { base, rules })
  assert.equal(c.headMoved, true)
  assert.equal(c.head, git(W, ['rev-parse', 'HEAD']))
  assert.deepEqual(c.tracked, ['a.txt', 'b.txt'])
})

test('non-UTF-8 names travel as {b64} and round-trip through decodePath', T, t => {
  const odd = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])
  const { W, wt, base } = fixture(t, { 'a.txt': 'a\n' }, {
    plumb: P => {
      const oid = git(P, ['hash-object', '-w', '--stdin'], { input: 'odd\n' })
      git(P, ['update-index', '-z', '--index-info'], { input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), odd, Buffer.from([0])]) })
    },
  })
  const oddJson = { b64: odd.toString('base64') }
  assert.deepEqual(ch.encodePath(odd), oddJson)
  assert.deepEqual(ch.decodePath(oddJson), odd)
  assert.equal(ch.encodePath(Buffer.from('plain/x.txt')), 'plain/x.txt')
  const rules = ch.recordRules(wt, { base })
  // A volume that cannot hold the name never checked it out; elsewhere the test deletes it.
  const abs = Buffer.concat([Buffer.from(W + '/'), odd])
  if (fs.existsSync(abs)) fs.unlinkSync(abs)
  let created = null
  try {
    created = Buffer.from([0x6e, 0xff, 0x2e, 0x74, 0x78, 0x74])
    fs.writeFileSync(Buffer.concat([Buffer.from(W + '/'), created]), 'new\n')
  } catch (e) {
    if (e.code !== 'EILSEQ') throw e
    t.diagnostic('this volume refuses non-UTF-8 names; the untracked half is skipped')
    created = null
  }
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, [oddJson])
  assert.deepEqual(c.untracked, created ? [{ b64: created.toString('base64') }] : [])
  const { tree } = ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] })
  assert.equal(treeEntries(W, tree).has(odd.toString('latin1')), false)
  const man = ch.manifest(wt, base, tree)
  assert.deepEqual(man.find(e => e.kind === 'deleted').path, oddJson)
  const tu = ch.touched(wt, { base })
  assert.deepEqual(tu.paths, sorted([oddJson, ...(created ? [{ b64: created.toString('base64') }] : [])]))
  assert.match(tu.digest, /^[0-9a-f]{64}$/)
})

test('CRLF bytes and a clean filter: a save keeps raw bytes and runs no filter; stageTree converts', T, t => {
  const f = fixture(t, { '.gitattributes': '*.dat filter=rw\n', 'a.dat': 'hello\n', 't.txt': 'one\ntwo\n', 'u.txt': 'same\n' })
  const { W, wt, base, root } = f
  const marker = path.join(root, 'filter-ran')
  const script = path.join(root, 'rw.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\nsed s/hello/HELLO/\n`)
  fs.chmodSync(script, 0o755)
  const gcfg = path.join(root, 'hostile.gitconfig')
  fs.writeFileSync(gcfg, `[core]\n\tautocrlf = true\n[filter "rw"]\n\tclean = ${script}\n\tsmudge = ${script}\n\trequired = true\n`)
  withEnv({ GIT_CONFIG_GLOBAL: gcfg }, () => {
    const rules = ch.recordRules(wt, { base })
    write(W, 'a.dat', 'hello secret\r\n')
    write(W, 't.txt', 'one\r\ntwo\r\nthree\r\n')
    write(W, 'n.txt', 'x\r\ny\r\n')
    write(W, 'u.txt', 'same\r\n') // what an autocrlf=true checkout writes: not a change
    const c = ch.collect(wt, { base, rules })
    assert.deepEqual(c.tracked, ['a.dat', 't.txt'])
    assert.deepEqual(c.untracked, ['n.txt'])
    assert.deepEqual(c.indexOnly, [])
    const { tree } = ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] })
    assert.equal(blobAt(W, tree, 'a.dat').toString('latin1'), 'hello secret\r\n')
    assert.equal(blobAt(W, tree, 't.txt').toString('latin1'), 'one\r\ntwo\r\nthree\r\n')
    assert.equal(blobAt(W, tree, 'n.txt').toString('latin1'), 'x\r\ny\r\n')
    ch.manifest(wt, base, tree)
    assert.equal(fs.existsSync(marker), false, 'no filter ran while listing, capturing or describing')

    // Control: the commit path (git's normal check-in conversion) runs the filter and the eol rule.
    const st = ch.stageTree(wt, { base, paths: ['a.dat', 'n.txt', 't.txt'] })
    assert.equal(blobAt(W, st.tree, 'a.dat').toString('latin1'), 'HELLO secret\n')
    assert.equal(blobAt(W, st.tree, 'n.txt').toString('latin1'), 'x\ny\n')
    assert.equal(blobAt(W, st.tree, 't.txt').toString('latin1'), 'one\ntwo\nthree\n')
    assert.ok(fs.existsSync(marker), 'the filter fixture is live')
  })
  noTemps(wt)
})

test("a delegate's .gitattributes cannot hide a CRLF-only edit from a save (attributes come from the base)", T, t => {
  const { W, wt, base } = fixture(t, { 't.txt': 'a\nb\n' })
  const rules = ch.recordRules(wt, { base })
  write(W, 't.txt', 'a\r\nb\r\n')
  write(W, '.gitattributes', '*.txt text\n')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['t.txt'])
  assert.deepEqual(c.untracked, ['.gitattributes'])
  // git's standard view (the commit path) normalizes the edit away.
  assert.deepEqual(ch.touched(wt, { base }).paths, ['.gitattributes'])
})

test('the replay keeps the recorded rules: edited, new nested, info/exclude and deleted ignore files', T, t => {
  const { W, wt, base } = fixture(t, { '.gitignore': '*.log\n', 'sub/.gitignore': '*.tmp\n', 'sub/keep.txt': 'k\n' })
  const rules = ch.recordRules(wt, { base })
  assert.equal(rules.v, 1)
  assert.equal(rules.mode, 'recorded')
  assert.equal(rules.base, base)
  assert.deepEqual(rules.ignores.map(i => i.path), ['.gitignore', 'sub/.gitignore'])
  assert.equal(rules.ignores[1].oid, git(W, ['rev-parse', `${base}:sub/.gitignore`]))

  fs.appendFileSync(path.join(W, '.gitignore'), 'secret.txt\n') // tracked edit
  write(W, 'secret.txt', 's\n')
  write(W, 'hide/.gitignore', '*\n') // new nested ignore file that hides itself
  write(W, 'hide/a.txt', 'a\n')
  write(W, '.git/info/exclude', 'inf.txt\n') // local exclude edit
  write(W, 'inf.txt', 'i\n')
  fs.rmSync(path.join(W, 'sub/.gitignore')) // deleted ignore file
  write(W, 'sub/x.tmp', 'was ignored\n')
  write(W, 'plain.txt', 'p\n')
  write(W, 'a.log', 'l\n')

  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['.gitignore', 'sub/.gitignore'])
  assert.deepEqual(c.untracked, ['hide/.gitignore', 'hide/a.txt', 'inf.txt', 'plain.txt', 'secret.txt'])
  assert.deepEqual(c.hidden, ['hide/.gitignore', 'hide/a.txt', 'inf.txt', 'secret.txt'], 'each hidden file is listed')
  assert.deepEqual(ch.listUntracked(wt, { base, rules }), c.untracked)
  // The recorded sub/.gitignore still applies: the file it ignored stays out of a save.
  assert.equal(c.untracked.includes('sub/x.tmp'), false)

  // git's standard listing (touched) sees what the delegate's rules leave visible.
  const tu = ch.touched(wt, { base, rules })
  assert.deepEqual(tu.paths, ['.gitignore', 'plain.txt', 'sub/.gitignore', 'sub/x.tmp'])
  assert.deepEqual(tu.hidden, c.hidden)
  noTemps(wt)
})

test('dependency-created self-ignored directories stay ignored under the recorded rules and out of touched', T, t => {
  const { W, wt, base } = fixture(t, { '.gitignore': 'node_modules/\n', 'src/a.js': 'a\n' })
  write(W, '.venv/.gitignore', '*\n')
  write(W, '.venv/bin/python', 'py\n')
  write(W, '.husky/_/.gitignore', '*\n')
  write(W, '.husky/_/husky.sh', 'h\n')
  write(W, '.pytest_cache/.gitignore', '# Created by pytest automatically.\n*\n')
  write(W, '.pytest_cache/v/cache/nodeids', '[]\n')
  write(W, 'node_modules/x/.gitignore', '!keep\n')
  write(W, 'node_modules/x/index.js', 'x\n')
  const rules = ch.recordRules(wt, { base })
  assert.deepEqual(rules.ignores.map(i => i.path),
    ['.gitignore', '.husky/_/.gitignore', '.pytest_cache/.gitignore', '.venv/.gitignore', 'node_modules/x/.gitignore'])
  // A later install adds more inside them.
  write(W, '.venv/lib/site.py', 's\n')
  write(W, '.pytest_cache/v/more', 'm\n')
  write(W, 'node_modules/x/keep', 'k\n')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual([c.tracked, c.untracked, c.hidden, c.unsavable], [[], [], [], []])
  const tu = ch.touched(wt, { base, rules })
  assert.deepEqual([tu.paths, tu.hidden], [[], []])
  // Leftovers with no record are listed under the base's rules alone.
  assert.deepEqual(ch.listUntracked(wt, { base, rules: ch.baseRules(wt, base) }), sorted([
    '.husky/_/.gitignore', '.husky/_/husky.sh', '.pytest_cache/.gitignore', '.pytest_cache/v/cache/nodeids',
    '.pytest_cache/v/more', '.venv/.gitignore', '.venv/bin/python', '.venv/lib/site.py',
  ]))
})

test('negations and precedence: excludesFile < info/exclude < per-directory, as git standard', T, t => {
  const { W, wt, base, root } = fixture(t, { '.gitignore': '*.log\n!keep.log\n', 'sub/.gitignore': 'top.tmp\n' })
  const excl = path.join(root, 'global-ignore')
  fs.writeFileSync(excl, '*.tmp\n!top.tmp\n')
  const gcfg = path.join(root, 'excl.gitconfig')
  fs.writeFileSync(gcfg, `[core]\n\texcludesFile = ${excl}\n`)
  withEnv({ GIT_CONFIG_GLOBAL: gcfg }, () => {
    write(W, '.git/info/exclude', '!keep.tmp\nonlyinfo.txt\n')
    for (const p of ['keep.tmp', 'x.tmp', 'top.tmp', 'sub/top.tmp', 'sub/x.tmp', 'onlyinfo.txt', 'a.log', 'keep.log', 'plain.txt']) write(W, p, `${p}\n`)
    const rules = ch.recordRules(wt, { base })
    assert.equal(rules.excludes_file.path, excl)
    assert.equal(Buffer.from(rules.excludes_file.b64, 'base64').toString(), '*.tmp\n!top.tmp\n')
    assert.equal(rules.excludes_file.sha256, sha256Hex(Buffer.from('*.tmp\n!top.tmp\n')))
    assert.equal(Buffer.from(rules.info_exclude.b64, 'base64').toString(), '!keep.tmp\nonlyinfo.txt\n')
    const expected = ['keep.log', 'keep.tmp', 'plain.txt', 'top.tmp']
    assert.deepEqual(git(W, ['ls-files', '-o', '--exclude-standard']).split('\n'), expected, 'git standard, the control')
    assert.deepEqual(ch.listUntracked(wt, { base, rules }), expected)
    // The recorded bytes win over a later edit of the excludes file.
    fs.appendFileSync(excl, 'plain.txt\n')
    assert.deepEqual(ch.listUntracked(wt, { base, rules }), expected)
    assert.deepEqual(ch.collect(wt, { base, rules }).hidden, ['plain.txt'])
  })
})

test('base and current rule modes', T, t => {
  const { W, wt, base } = fixture(t, { '.gitignore': '*.log\n', 'k.txt': 'k\n' })
  write(W, '.venv/.gitignore', '*\n')
  write(W, '.venv/x', 'x\n')
  write(W, '.git/info/exclude', 'inf.txt\n')
  write(W, 'inf.txt', 'i\n')
  write(W, 'a.log', 'l\n')
  write(W, 'p.txt', 'p\n')

  const br = ch.baseRules(wt, base)
  assert.equal(br.mode, 'base')
  assert.equal(br.base, base)
  assert.deepEqual(br.ignores, [{ path: '.gitignore', oid: git(W, ['rev-parse', `${base}:.gitignore`]) }])
  assert.deepEqual(br.info_exclude, { sha256: sha256Hex(Buffer.alloc(0)), b64: '' }, 'the clone info/exclude does not count')
  assert.equal(br.excludes_file, null)
  assert.deepEqual(ch.listUntracked(wt, { base, rules: br }), ['.venv/.gitignore', '.venv/x', 'inf.txt', 'p.txt'])

  const cr = ch.currentRules(wt)
  assert.equal(cr.mode, 'current')
  assert.deepEqual(cr.ignores.map(i => i.path), ['.gitignore', '.venv/.gitignore'])
  assert.equal(Buffer.from(cr.info_exclude.b64, 'base64').toString(), 'inf.txt\n')
  assert.deepEqual(ch.listUntracked(wt, { base, rules: cr }), ['p.txt'])

  const rr = ch.recordRules(wt, { base })
  assert.equal(rr.mode, 'recorded')
  assert.deepEqual({ ...rr, mode: 'current', base: null }, cr, 'recorded and current read the same sources')
  assert.match(ch.rulesSha(rr), /^[0-9a-f]{64}$/)
  assert.equal(ch.rulesSha(rr), sha256Hex(canonicalJson(rr)))
  canonicalJson(br)
})

test('a planted nonce file, tampered rules and an excludes file in the work area are refused', T, t => {
  const { W, V, P, wt, base, root } = fixture(t, { '.gitignore': '*.log\n', 'sub/.gitignore': '*.tmp\n' })
  const rules = ch.recordRules(wt, { base })
  const nonce = '.tlx-0123456789ab'
  assert.deepEqual(ch.listUntracked(wt, { base, rules, nonce }), [])
  write(W, `sub/${nonce}`, '!*\n')
  assert.throws(() => ch.listUntracked(wt, { base, rules, nonce }), e => e.code === 'REFUSED' && e.state === 'tampered')
  fs.rmSync(path.join(W, 'sub', nonce))
  write(W, nonce, '!*\n')
  assert.throws(() => ch.listUntracked(wt, { base, rules, nonce }), e => e.code === 'REFUSED' && e.state === 'tampered')
  fs.rmSync(path.join(W, nonce))
  assert.throws(() => ch.listUntracked(wt, { base, rules, nonce: 'bad' }), /nonce/)

  const forged = structuredClone(rules)
  forged.info_exclude.b64 = Buffer.from('*\n').toString('base64')
  assert.throws(() => ch.listUntracked(wt, { base, rules: forged }), e => e.code === 'REFUSED' && e.state === 'tampered')
  const missing = structuredClone(rules)
  missing.ignores[0].oid = '0123456789012345678901234567890123456789'
  assert.throws(() => ch.collect(wt, { base, rules: missing }), e => e.code === 'REFUSED' && e.state === 'tampered')
  assert.throws(() => ch.collect(wt, { base: 'f'.repeat(40), rules }), e => e.code === 'REFUSED' && e.state === 'base-unknown')

  for (const where of [path.join(P, '.myignore'), path.join(V, 'nowhere', 'ignore')]) {
    if (where.startsWith(P)) fs.writeFileSync(where, '*.x\n')
    const gcfg = path.join(root, 'workarea.gitconfig')
    fs.writeFileSync(gcfg, `[core]\n\texcludesFile = ${where}\n`)
    withEnv({ GIT_CONFIG_GLOBAL: gcfg }, () => {
      assert.throws(() => ch.recordRules(wt, { base }), e => e.code === 'REFUSED' && e.state === 'excludes-file-in-work-area')
    })
  }
  noTemps(wt)
})

test('an obstructing directory: its files, ignored or not, are reported and saved', T, t => {
  const { W, wt, base } = fixture(t, { '.gitignore': '*.log\n', obs: 'a file in the base\n', 'k.txt': 'k\n' })
  const rules = ch.recordRules(wt, { base })
  fs.rmSync(path.join(W, 'obs'))
  write(W, 'obs/a.txt', 'a\n')
  write(W, 'obs/deep/x.log', 'ignored but obstructing\n')
  write(W, 'elsewhere.log', 'ignored, not saved\n')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['obs'])
  assert.deepEqual(c.obstructed, ['obs/a.txt', 'obs/deep/x.log'])
  assert.deepEqual(c.untracked, ['obs/a.txt', 'obs/deep/x.log'])
  const { tree } = ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] })
  const entries = treeEntries(W, tree)
  assert.equal(entries.has('obs'), false)
  assert.equal(blobAt(W, tree, 'obs/deep/x.log').toString(), 'ignored but obstructing\n')
  assert.equal(entries.has('elsewhere.log'), false)
})

test('a symlinked directory is never followed: what lies beyond it is neither listed nor read', T, t => {
  const { W, wt, base, root } = fixture(t, { 'dir/a.txt': 'inside\n', 'k.txt': 'k\n' })
  const rules = ch.recordRules(wt, { base })
  const outside = path.join(root, 'outside')
  write(outside, 'a.txt', 'outside secret\n')
  fs.rmSync(path.join(W, 'dir'), { recursive: true })
  fs.symlinkSync(outside, path.join(W, 'dir'))
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['dir/a.txt'])
  assert.deepEqual(c.untracked, ['dir'])
  assert.deepEqual(c.unsavable, [])
  for (const { tree } of [ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] }), ch.stageTree(wt, { base, paths: [...c.tracked, ...c.untracked] })]) {
    const e = treeEntries(W, tree)
    assert.equal(e.has('dir/a.txt'), false, 'the file beyond the link is a deletion, never read')
    assert.equal(e.get('dir').mode, '120000')
    assert.equal(blobAt(W, tree, 'dir').toString(), outside)
  }
  assert.throws(() => ch.captureTree(wt, { base, paths: ['../outside/a.txt'] }), /not a work-tree path/)
  assert.throws(() => ch.captureTree(wt, { base, paths: ['.git/config'] }), /not a work-tree path/)
  assert.deepEqual(ch.touched(wt, { base }).paths, ['dir', 'dir/a.txt'])
})

test('a real index that is not a regular file is refused without blocking', T, t => {
  const { W, wt, base } = fixture(t, { 'a.txt': 'a\n' })
  const rules = ch.recordRules(wt, { base })
  const index = path.join(W, '.git/index')
  fs.renameSync(index, index + '.saved')
  execFileSync('mkfifo', [index])
  // git-safe's quick structural check refuses it before any git runs (Cg1#1); copyIndex's own
  // tampered refusal stays behind it.
  assert.throws(() => ch.collect(wt, { base, rules }), e => e.code === 'CLONE_INVALID' && /\.git\/index is a special file$/.test(e.message))
  fs.rmSync(index)
  fs.symlinkSync(index + '.saved', index)
  assert.throws(() => ch.indexOnly(wt, { base }), e => e.code === 'CLONE_INVALID' && /\.git\/index is a symlink$/.test(e.message))
  fs.rmSync(index)
  assert.deepEqual(ch.collect(wt, { base, rules }).indexOnly, [], 'a missing index holds nothing index-only')
  noTemps(wt)
})

test('indexOnly: a staged-then-reverted change is found; staging the work tree and the commit-finalize index are not', T, t => {
  const { W, wt, base } = fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'n.keep': 'n\n' })
  const rules = ch.recordRules(wt, { base })
  write(W, 'c.txt', 'c committed\n')
  git(W, ['add', 'c.txt'])
  git(W, ['commit', '-q', '-m', 'commit not yet finalized'])
  const C = git(W, ['rev-parse', 'HEAD'])
  write(W, 'c.txt', 'c edited after\n') // index holds C's blob, the work tree another
  write(W, 'a.txt', 'staged only\n')
  git(W, ['add', 'a.txt'])
  write(W, 'a.txt', 'a\n') // reverted: the staged blob exists nowhere else
  write(W, 'b.txt', 'b staged as in the work tree\n')
  git(W, ['add', 'b.txt'])
  write(W, 'new.txt', 'added then deleted\n')
  git(W, ['add', 'new.txt'])
  fs.rmSync(path.join(W, 'new.txt'))

  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.indexOnly, ['a.txt', 'c.txt', 'new.txt'])
  assert.equal(c.tracked.includes('a.txt'), false, 'the work tree equals the base for a.txt')
  assert.equal(c.indexDirty, true)
  assert.deepEqual(ch.collect(wt, { base, rules, also: [C] }).indexOnly, ['a.txt', 'new.txt'])
  assert.deepEqual(ch.indexOnly(wt, { base, also: [C] }), ['a.txt', 'new.txt'])
  // Plain staging of what the work tree holds is never index-only.
  git(W, ['reset', '-q', base, '--', 'a.txt', 'c.txt', 'new.txt'])
  const d = ch.collect(wt, { base, rules })
  assert.deepEqual(d.indexOnly, [])
  assert.equal(d.indexDirty, true, 'b.txt is still staged')
  assert.deepEqual(ch.touched(wt, { base }).indexOnly, [])
})

test('unsavable: a fifo, an unreadable file and a nested repository', T, t => {
  const { W, wt, base } = fixture(t, { 'r.txt': 'r\n', 'k.txt': 'k\n', 'q.txt': 'q\n', obs: 'a file in the base\n' })
  const rules = ch.recordRules(wt, { base })
  // git lists no untracked fifo (it is neither a file nor a link), so a fifo is seen where the
  // base tracks a file, or inside an obstructing directory, which the walk reads itself.
  fs.rmSync(path.join(W, 'q.txt'))
  execFileSync('mkfifo', [path.join(W, 'q.txt')])
  fs.rmSync(path.join(W, 'obs'))
  fs.mkdirSync(path.join(W, 'obs'))
  execFileSync('mkfifo', [path.join(W, 'obs/p')])
  execFileSync('mkfifo', [path.join(W, 'pipe')])
  write(W, 'nested/inner.txt', 'i\n')
  git(path.join(W, 'nested'), ['init', '-q'])
  const expected = [
    { path: 'nested', reason: 'nested-repo' }, { path: 'obs/p', reason: 'special-file' }, { path: 'q.txt', reason: 'special-file' },
  ]
  if (!IS_ROOT) {
    write(W, 'locked.txt', 'secret\n')
    fs.chmodSync(path.join(W, 'locked.txt'), 0o000)
    write(W, 'r.txt', 'r changed\n')
    fs.chmodSync(path.join(W, 'r.txt'), 0o000)
    t.after(() => { for (const p of ['locked.txt', 'r.txt']) try { fs.chmodSync(path.join(W, p), 0o644) } catch {} })
    expected.unshift({ path: 'locked.txt', reason: 'unreadable' })
    expected.push({ path: 'r.txt', reason: 'unreadable' })
  } else {
    t.diagnostic('running as root: the unreadable cases are skipped')
  }
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.unsavable, expected)
  assert.ok(c.untracked.includes('nested') && c.untracked.includes('obs/p') && c.tracked.includes('q.txt'),
    'unsavable paths stay in the change set')
  assert.equal(c.untracked.includes('pipe'), false, 'an untracked fifo is invisible to git (residual)')
  assert.throws(() => ch.captureTree(wt, { base, paths: ['q.txt'] }), e => e.code === 'UNSAVABLE')
  assert.throws(() => ch.captureTree(wt, { base, paths: ['nested'] }), e => e.code === 'UNSAVABLE')
  if (!IS_ROOT) assert.throws(() => ch.captureTree(wt, { base, paths: ['locked.txt'] }), e => e.code === 'UNSAVABLE')
  const tu = ch.touched(wt, { base })
  assert.deepEqual(tu.unsavable, expected.filter(u => u.path !== 'obs/p'), 'the standard listing walks no obstructing directory')
  // A repository standing where the base tracks a file is unsavable as a whole.
  fs.rmSync(path.join(W, 'obs'), { recursive: true })
  write(W, 'obs/x.txt', 'x\n')
  git(path.join(W, 'obs'), ['init', '-q'])
  assert.deepEqual(ch.collect(wt, { base, rules }).unsavable.find(u => u.path === 'obs'), { path: 'obs', reason: 'nested-repo' })
  assert.throws(() => ch.captureTree(wt, { base, paths: ['obs'] }), e => e.code === 'UNSAVABLE' && e.reason === 'nested-repo')
  noTemps(wt)
})

test('an unreadable .gitignore is left out of the record, as git leaves it out of its listing', T, t => {
  if (IS_ROOT) return t.skip('root reads every file')
  const { W, wt, base } = fixture(t, { 'k.txt': 'k\n' })
  write(W, 'sub/.gitignore', '*.log\n')
  fs.chmodSync(path.join(W, 'sub/.gitignore'), 0o000)
  t.after(() => { try { fs.chmodSync(path.join(W, 'sub/.gitignore'), 0o644) } catch {} })
  const rules = ch.recordRules(wt, { base })
  assert.deepEqual(rules.ignores, [])
})

test('touched: the standard listing, a stable digest over {base, tree, paths}, which changes with content', T, t => {
  const { W, wt, base } = fixture(t, { '.gitignore': '*.log\n', 'a.txt': 'a\n', 'gone.txt': 'g\n' })
  write(W, 'a.txt', 'b\n')
  write(W, 'n.txt', 'n\n')
  write(W, 'x.log', 'ignored\n')
  fs.rmSync(path.join(W, 'gone.txt'))
  const t1 = ch.touched(wt, { base })
  assert.deepEqual(t1.paths, ['a.txt', 'gone.txt', 'n.txt'])
  assert.deepEqual([t1.hidden, t1.unsavable, t1.indexOnly, t1.headMoved], [[], [], [], false])
  assert.equal(t1.tree, ch.stageTree(wt, { base, paths: t1.paths }).tree)
  assert.equal(t1.digest, sha256Hex(canonicalJson({ base, tree: t1.tree, paths: t1.paths })))
  assert.equal(ch.touched(wt, { base }).digest, t1.digest, 'the same work tree gives the same digest')
  write(W, 'a.txt', 'c\n')
  const t2 = ch.touched(wt, { base })
  assert.deepEqual(t2.paths, t1.paths)
  assert.notEqual(t2.tree, t1.tree)
  assert.notEqual(t2.digest, t1.digest)
  const empty = fixture(t, { 'a.txt': 'a\n' })
  const t3 = ch.touched(empty.wt, { base: empty.base })
  assert.deepEqual(t3.paths, [])
  assert.equal(t3.tree, git(empty.W, ['rev-parse', `${empty.base}^{tree}`]))
  noTemps(wt)
})

// ---------------------------------------------------------------- 0c-2 fix pass (group A)

test('an ignored file or symlink standing where the base tracks a directory is listed and obstructed whatever the rules say; a fifo there is unsavable (Cg1#2, data-safety#2)', T, t => {
  const files = { '.gitignore': 'out\nlnk\npipe\n', 'docs/out/index.md': 'tracked\n', 'docs/lnk/x.md': 'x\n', 'docs/pipe/p.md': 'p\n', 'a.txt': 'a\n' }
  const { W, wt, base } = fixture(t, files, { plumb: P => git(P, ['add', '-f', 'docs']) })
  const rules = ch.recordRules(wt, { base })
  fs.rmSync(path.join(W, 'docs/out'), { recursive: true })
  write(W, 'docs/out', 'PRECIOUS delegate content\n')
  fs.rmSync(path.join(W, 'docs/lnk'), { recursive: true })
  fs.symlinkSync('../a.txt', path.join(W, 'docs/lnk'))
  write(W, 'a.txt', 'edited\n')
  // Control: git's own listing under these rules hides both.
  assert.equal(git(W, ['status', '--porcelain', '--untracked-files=all', '--', 'docs/out', 'docs/lnk']).includes('??'), false)
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['a.txt', 'docs/lnk/x.md', 'docs/out/index.md'])
  assert.deepEqual(c.untracked, ['docs/lnk', 'docs/out'])
  assert.deepEqual(c.obstructed, ['docs/lnk', 'docs/out'])
  assert.deepEqual(c.unsavable, [])
  const { tree } = ch.captureTree(wt, { base, paths: [...c.tracked, ...c.untracked] })
  assert.equal(blobAt(W, tree, 'docs/out').toString(), 'PRECIOUS delegate content\n')
  assert.equal(git(W, ['ls-tree', tree, 'docs/lnk']).split(' ')[0], '120000')
  // A fifo standing there cannot be saved.
  fs.rmSync(path.join(W, 'docs/pipe'), { recursive: true })
  execFileSync('mkfifo', [path.join(W, 'docs/pipe')])
  const c2 = ch.collect(wt, { base, rules })
  assert.deepEqual(c2.unsavable, [{ path: 'docs/pipe', reason: 'special-file' }])
  assert.ok(c2.untracked.includes('docs/pipe'))
  // touched (the commit view) is unchanged: the ignored file stays out of a commit.
  assert.equal(ch.touched(wt, { base }).paths.includes('docs/out'), false)
  noTemps(wt)
})

test('raw bytes a conversion hides are listed: an ident expansion and CRLF in a text file; an untouched checkout, LF equal to the blob and touched are not (R29, Cg1#3)', T, t => {
  const files = { '.gitattributes': 'id.txt ident\n*.txt text\n*.crlf text eol=crlf\n', 'id.txt': 'v $Id$ end\n', 't.txt': 'one\ntwo\n',
    'c.crlf': 'l1\nl2\n', 'k.crlf': 'k1\nk2\n', 'plain.bin': 'p\n' }
  const { W, wt, base } = fixture(t, files)
  // The checkout expanded the ident and wrote CRLF for the eol=crlf files.
  assert.match(fs.readFileSync(path.join(W, 'id.txt'), 'latin1'), /^v \$Id: [0-9a-f]{40} \$ end\n$/)
  assert.equal(fs.readFileSync(path.join(W, 'c.crlf'), 'latin1'), 'l1\r\nl2\r\n')
  const rules = ch.recordRules(wt, { base })
  assert.deepEqual(ch.collect(wt, { base, rules }).tracked, [], 'a fresh checkout is clean')
  write(W, 'id.txt', 'v $Id: unpublished note $ end\n')
  write(W, 't.txt', 'one\r\ntwo\r\n')
  write(W, 'c.crlf', 'l1\nl2\n') // LF, equal to the blob: the base holds these bytes
  // Control: git's own content view (diff drops what only its stat data calls changed) sees none.
  assert.equal(git(W, ['diff', '--name-only']), '')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['id.txt', 't.txt'])
  const { tree } = ch.captureTree(wt, { base, paths: c.tracked })
  assert.equal(blobAt(W, tree, 'id.txt').toString('latin1'), 'v $Id: unpublished note $ end\n')
  assert.equal(blobAt(W, tree, 't.txt').toString('latin1'), 'one\r\ntwo\r\n')
  assert.deepEqual(ch.touched(wt, { base }).paths, [], 'the commit view keeps git\'s conversion-aware view')
  // A delegate's .gitattributes cannot turn the comparison off (attributes come from the base).
  write(W, '.gitattributes', '* -text -ident\n')
  assert.deepEqual(ch.collect(wt, { base, rules }).tracked, ['.gitattributes', 'id.txt', 't.txt'])
  noTemps(wt)
})

test('R29a: raw bytes equal to the base blob are not listed even where a checkout writes other bytes (eol=crlf, core.autocrlf=true), so collect reads clean (R29a, code#8)', T, t => {
  const { W, wt, base } = fixture(t, { '.gitattributes': '*.crlf text eol=crlf\n', 'c.crlf': 'l1\nl2\n', 'u.txt': 'u1\nu2\n' })
  const rules = ch.recordRules(wt, { base })
  assert.equal(fs.readFileSync(path.join(W, 'c.crlf'), 'latin1'), 'l1\r\nl2\r\n', 'the checkout wrote CRLF')
  // The blob's own bytes, which a checkout would not write: the base holds them already.
  write(W, 'c.crlf', 'l1\nl2\n')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual([c.tracked, c.untracked, c.indexDirty], [[], [], false])
  // core.autocrlf=true: a checkout converts every text file; u.txt still holds its blob's LF.
  git(W, ['config', 'core.autocrlf', 'true'])
  assert.equal(fs.readFileSync(path.join(W, 'u.txt'), 'latin1'), 'u1\nu2\n')
  assert.deepEqual(ch.collect(wt, { base, rules }).tracked, [])
  // Control: bytes that match neither the blob nor the checkout are listed.
  write(W, 'u.txt', 'u1\r\nu2\n')
  write(W, 'c.crlf', 'l1\r\nl2\n')
  assert.deepEqual(ch.collect(wt, { base, rules }).tracked, ['c.crlf', 'u.txt'])
  noTemps(wt)
})

test('with core.filemode false, an exec-bit change git ignores is listed and captured (R29)', T, t => {
  const { W, wt, base } = fixture(t, { 'run.sh': 'echo\n', 'x.sh': 'x\n' }, { execs: ['x.sh'] })
  const rules = ch.recordRules(wt, { base })
  git(W, ['config', 'core.filemode', 'false'])
  fs.chmodSync(path.join(W, 'run.sh'), 0o755)
  fs.chmodSync(path.join(W, 'x.sh'), 0o644)
  assert.equal(git(W, ['status', '--porcelain']), '', 'git ignores the exec bit')
  const c = ch.collect(wt, { base, rules })
  assert.deepEqual(c.tracked, ['run.sh', 'x.sh'])
  const { tree } = ch.captureTree(wt, { base, paths: c.tracked })
  assert.equal(git(W, ['ls-tree', tree, 'run.sh']).split(' ')[0], '100755')
  assert.equal(git(W, ['ls-tree', tree, 'x.sh']).split(' ')[0], '100644')
  noTemps(wt)
})

test('change detection never runs git inside a populated nested repository; a gitlink commit change is still seen (R26, Cg2#1)', T, t => {
  const root0 = tmp(t, 'tl-chg-sub-')
  const S = path.join(root0, 'S')
  fs.mkdirSync(S)
  git(S, ['init', '-q', '-b', 'main'])
  write(S, 'in.txt', 'inner\n')
  git(S, ['add', '-A'])
  git(S, ['commit', '-q', '-m', 's1'])
  const X = git(S, ['rev-parse', 'HEAD'])
  write(S, 'in.txt', 'inner 2\n')
  git(S, ['commit', '-q', '-am', 's2'])
  const Y = git(S, ['rev-parse', 'HEAD'])
  const { W, wt, base, root } = fixture(t, { 'a.txt': 'a\n' }, { plumb: P => git(P, ['update-index', '--add', '--cacheinfo', `160000,${X},sub`]) })
  const rules = ch.recordRules(wt, { base })
  fs.rmSync(path.join(W, 'sub'), { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--', S, path.join(W, 'sub')], { stdio: 'pipe' })
  git(path.join(W, 'sub'), ['checkout', '-q', '--detach', X])
  const marker = path.join(root, 'nested-filter-ran')
  const script = path.join(root, 'evil.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`)
  fs.chmodSync(script, 0o755)
  git(path.join(W, 'sub'), ['config', 'filter.evil.clean', script])
  fs.mkdirSync(path.join(W, 'sub/.git/info'), { recursive: true })
  fs.writeFileSync(path.join(W, 'sub/.git/info/attributes'), '* filter=evil\n')
  // Same size, new content: status must hash the file, so its clean filter would run.
  write(W, 'sub/in.txt', 'INNER\n')
  // Control: git's status in the parent with submodules not ignored runs the nested filter.
  git(W, ['status', '--porcelain', '--ignore-submodules=none'])
  assert.ok(fs.existsSync(marker), 'the nested filter fixture is live')
  fs.rmSync(marker)
  const c = ch.collect(wt, { base, rules })
  const tu = ch.touched(wt, { base })
  ch.indexOnly(wt, { base })
  assert.equal(fs.existsSync(marker), false, 'no helper ran git inside the nested repository')
  assert.deepEqual(c.tracked, [], 'dirty content inside the nested repository is not a change of the parent')
  assert.deepEqual(c.unsavable, [])
  assert.deepEqual(tu.paths, [])
  // A commit-level change of the gitlink is still seen, and stays unsavable.
  git(path.join(W, 'sub'), ['checkout', '-q', '-f', '--detach', Y])
  const c2 = ch.collect(wt, { base, rules })
  assert.deepEqual(c2.tracked, ['sub'])
  assert.deepEqual(c2.unsavable, [{ path: 'sub', reason: 'gitlink' }])
  assert.equal(fs.existsSync(marker), false)
  noTemps(wt)
})

// A stand-in git first on PATH that drops GIT_ATTR_SOURCE (as a git older than 2.40 ignores it).
const oldGitPath = t => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const bin = path.join(tmp(t, 'tl-chg-oldgit-'), 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nunset GIT_ATTR_SOURCE\nexec '${real}' "$@"\n`)
  fs.chmodSync(path.join(bin, 'git'), 0o755)
  return `${bin}:${process.env.PATH}`
}

test('on a git that ignores GIT_ATTR_SOURCE, collect, indexOnly and manifest refuse infra git-too-old (R24)', T, t => {
  const { W, wt, base } = fixture(t, { 'a.txt': 'a\n' })
  const rules = ch.recordRules(wt, { base })
  write(W, 'a.txt', 'b\n')
  const tree = ch.captureTree(wt, { base, paths: ['a.txt'] }).tree
  withEnv({ PATH: oldGitPath(t) }, () => {
    const tooOld = e => e.code === 'REFUSED' && e.state === 'infra' && e.detail === 'git-too-old: needs git 2.40 or newer'
    assert.throws(() => ch.collect(wt, { base, rules }), tooOld)
    assert.throws(() => ch.indexOnly(wt, { base }), tooOld)
    assert.throws(() => ch.manifest(wt, base, tree), tooOld)
  })
  assert.deepEqual(ch.collect(wt, { base, rules }).tracked, ['a.txt'])
})
