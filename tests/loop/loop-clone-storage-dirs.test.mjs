// tests/loop/loop-clone-storage-dirs.test.mjs
// Symlinked storage directories under <V> (closing review F4; Codex g1 #1, g2 #1): a delegate
// replaces <V>/patches, <V>/out/<prefix> or <V>/run with a symlink to a directory of <P>. No
// helper sweeps, allocates a temp, creates a record or publishes through it: each refuses
// clone-invalid (exit 3) and the owner's directory is left as it was. Real repositories and
// processes, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { startToken } from '../../scripts/lib/loop-proc.mjs'
import {
  D2, PREFIX, T, attempt, check, firing, prepare, project, recordOf, run, write,
} from './loop-clone-fixture.mjs'

const REFLEX = path.join(ROOT, 'scripts', 'reflex-bundle.mjs')
const BRANCH = `${PREFIX}/${D2}`

// A pid that has exited and been reaped.
function gonePid() {
  const pid = spawnSync('true').pid
  assert.equal(startToken(pid).state, 'gone')
  return pid
}

// Every entry of dir with its bytes (files) or 'dir' / 'link', sorted.
const listing = dir => fs.readdirSync(dir).sort().map(n => {
  const st = fs.lstatSync(path.join(dir, n))
  return [n, st.isFile() ? fs.readFileSync(path.join(dir, n), 'utf8') : st.isDirectory() ? 'dir' : 'link']
})

// Replaces <V>/<rel> (whatever is there) with a symlink to target.
function redirect(fx, rel, target) {
  const p = path.join(fx.V, rel)
  fs.rmSync(p, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.symlinkSync(target, p)
}

// An owner directory in <P> holding a file named like a temp of a gone pid, and one more.
function ownerDir(fx, name) {
  const dir = path.join(fx.P, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, `.tmp-${gonePid()}-draft.txt`), 'owner draft\n')
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'owner notes\n')
  return dir
}

test('prepare: a symlinked <V>/patches is refused clone-invalid before the sweep; the owner\'s temp-named file stays (F4)', T, async t => {
  const fx = project(t)
  await firing(fx)
  const dir = ownerDir(fx, 'drafts')
  const before = listing(dir)
  redirect(fx, 'patches', dir)
  const out = prepare(fx, { status: 3 })
  assert.equal(out.state, 'clone-invalid', JSON.stringify(out))
  assert.match(out.detail, /patches/)
  assert.deepEqual(listing(dir), before, 'nothing in <P> was removed or written')
})

test('prepare: a symlinked <V>/out or <V>/run is refused clone-invalid; nothing in <P> is swept (F4)', T, async t => {
  for (const rel of ['out', 'run']) {
    const fx = project(t)
    await firing(fx)
    const dir = ownerDir(fx, `owner-${rel}`)
    const before = listing(dir)
    redirect(fx, rel, dir)
    const out = prepare(fx, { status: 3 })
    assert.equal(out.state, 'clone-invalid', `${rel}: ${JSON.stringify(out)}`)
    assert.deepEqual(listing(dir), before, rel)
  }
})

test('save: a symlinked patch store is refused clone-invalid; no temp or bundle lands in <P> (F4)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'b.txt', 'saved\n')
  const dir = path.join(fx.P, 'store')
  fs.mkdirSync(dir)
  redirect(fx, 'patches', dir)
  const r = spawnSync(process.execPath, [REFLEX, 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env: fx.env })
  const out = JSON.parse(r.stdout.trim())
  assert.equal(r.status, 3, JSON.stringify(out))
  assert.equal(out.state, 'clone-invalid')
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written into <P>')
  assert.equal(recordOf(fx).phase, 'prepared')
})

test('bundle: a symlinked <V>/out/<prefix> is refused clone-invalid; no bundle, temp or sidecar lands in <P> (F4)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  attempt(fx, W => write(W, 'one.txt', '1\n'))
  const dir = path.join(fx.P, 'docs')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'guide.md'), 'owner\n')
  redirect(fx, path.join('out', PREFIX), dir)
  const out = run(fx.env, 3, 'bundle', fx.P, '--generation', String(fx.N), '--branch', BRANCH)
  assert.equal(out.state, 'clone-invalid', JSON.stringify(out))
  assert.deepEqual(listing(dir), [['guide.md', 'owner\n']])
})

test('prepare sweeps a dead deps --mark temp from <W>/.git; a live pid\'s temp stays (code-review #10)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const dead = path.join(fx.W, '.git', `.tmp-${gonePid()}-0123456789abcdef`)
  const live = path.join(fx.W, '.git', `.tmp-${process.pid}-0123456789abcdef`)
  fs.writeFileSync(dead, 'tl/2026-10-02 sha256:x\n')
  fs.writeFileSync(live, 'tl/2026-10-02 sha256:y\n')
  await firing(fx)
  prepare(fx)
  assert.equal(fs.existsSync(dead), false, 'the dead temp is swept')
  assert.equal(fs.existsSync(live), true, 'a live pid keeps its temp')
  fs.rmSync(live)
})
