// tests/loop/loop-clone-root-symlink.test.mjs
// A symlink at the clone root <W> = <V>/clone (closing review F5; Codex g1 #3, g3 #2): the .git
// checks read <W>/.git through it, so replacing <W> with a symlink to an ordinary owner
// repository let deps --mark / --clear write <P>/.git/tech-lead-deps.ok and let save act on the
// owner's files. <W> itself must be a real directory inside <V>: checkClone, workGit and the
// deps marker refuse clone-invalid (exit 3) and the owner repository is left as it was. Real
// repositories and processes, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { checkClone, cloneMeta } from '../../scripts/lib/clone-check.mjs'
import { workGit } from '../../scripts/lib/git-safe.mjs'
import { T, check, firing, prepare, project, recordOf, run, write } from './loop-clone-fixture.mjs'

const REFLEX = path.join(ROOT, 'scripts', 'reflex-bundle.mjs')
const MARKER = 'tech-lead-deps.ok'

// Sets the clone aside and puts a symlink to target at <W>.
function swapRoot(fx, target) {
  fs.renameSync(fx.W, path.join(fx.V, 'clone-aside'))
  fs.symlinkSync(target, fx.W)
}

test('deps --mark and --clear through a symlinked <W> are refused clone-invalid; <P>/.git is untouched (F5)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  swapRoot(fx, fx.P)
  const marker = path.join(fx.P, '.git', MARKER)
  const mark = run(fx.env, 3, 'deps', fx.P, '--generation', String(fx.N), '--mark')
  assert.equal(mark.state, 'clone-invalid', JSON.stringify(mark))
  assert.equal(fs.existsSync(marker), false, 'no marker in <P>/.git')
  assert.deepEqual(fs.readdirSync(path.join(fx.P, '.git')).filter(n => n.startsWith('.tmp-')), [], 'no temp in <P>/.git')
  fs.writeFileSync(marker, 'owner\n')
  const clear = run(fx.env, 3, 'deps', fx.P, '--generation', String(fx.N), '--clear')
  assert.equal(clear.state, 'clone-invalid', JSON.stringify(clear))
  assert.equal(fs.readFileSync(marker, 'utf8'), 'owner\n', 'the owner\'s file stays')
})

test('save through a symlinked <W> (an owner repository whose metadata passes) is refused clone-invalid (F5)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  // An ordinary repository of the owner that happens to look like the clone.
  const owner = path.join(fx.root, 'owner-repo')
  fs.cpSync(fx.W, owner, { recursive: true, verbatimSymlinks: true })
  write(owner, 'b.txt', 'owner work\n')
  swapRoot(fx, owner)
  assert.deepEqual(checkClone(path.join(fx.V, 'clone-aside')).problems, [], 'the same tree as a real directory passes')
  const r = spawnSync(process.execPath, [REFLEX, 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env: fx.env })
  const out = JSON.parse(r.stdout.trim())
  assert.equal(r.status, 3, JSON.stringify(out))
  assert.equal(out.state, 'clone-invalid')
  assert.equal(recordOf(fx).phase, 'prepared')
  assert.equal(fs.readFileSync(path.join(owner, 'b.txt'), 'utf8'), 'owner work\n')
})

test('checkClone, cloneMeta and workGit refuse a symlinked clone root before reading .git (F5)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  swapRoot(fx, path.join(fx.V, 'clone-aside'))
  const { problems } = checkClone(fx.W)
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /^the clone root is not a real directory \(a symlink\)$/)
  assert.throws(() => cloneMeta(fx.W), e => e.code === 'CLONE_INVALID')
  assert.throws(() => workGit(fx.W, ['rev-parse', 'HEAD']), e => e.code === 'CLONE_INVALID' && /clone-invalid: /.test(e.message))
})
