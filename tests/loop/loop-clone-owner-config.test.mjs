// tests/loop/loop-clone-owner-config.test.mjs
// The owner's global git config does not break the loop's clone (closing review F2): a firing
// under a non-empty GIT_CONFIG_GLOBAL (clone.defaultRemoteName, init.defaultRefFormat with
// GIT_DEFAULT_REF_FORMAT, core.autocrlf, a filter driver applied to every path through a global
// core.attributesFile) creates the clone, passes its check, saves an untouched clone as empty and
// recovers a save, and the filter program never runs outside the commit path (R9). The rest of
// the suite pins GIT_CONFIG_GLOBAL=/dev/null, which hides this whole class. Real repositories and
// processes, as in loop-clone-prepare.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { T, check, firing, git, prepare, project, write } from './loop-clone-fixture.mjs'

// git >= 2.45 knows init.defaultRefFormat=reftable; an older git ignores the key.
const [MAJOR, MINOR] = /git version (\d+)\.(\d+)/.exec(spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout).slice(1).map(Number)
const HAS_REFTABLE = MAJOR > 2 || (MAJOR === 2 && MINOR >= 45)

// A global config file under fx.root and the environment that points the CLI children at it.
// The filter program appends to `marker` whenever git runs it.
function ownerConfig(fx, { reftable = false } = {}) {
  const dir = path.join(fx.root, 'owner-config')
  fs.mkdirSync(dir)
  const marker = path.join(dir, 'filter-ran')
  const prog = path.join(dir, 'filter.sh')
  fs.writeFileSync(prog, `#!/bin/sh\necho "$1 $(ps -o command= -p $PPID)" >> '${marker}'\nexec cat\n`, { mode: 0o755 })
  const attrs = path.join(dir, 'attributes')
  fs.writeFileSync(attrs, '* filter=x\n')
  const file = path.join(dir, 'gitconfig')
  fs.writeFileSync(file, [
    '[clone]', '\tdefaultRemoteName = upstream',
    ...(reftable ? ['[init]', '\tdefaultRefFormat = reftable'] : []),
    '[core]', '\tautocrlf = true', `\tattributesFile = "${attrs}"`,
    '[filter "x"]', `\tclean = "${prog}" clean`, `\tsmudge = "${prog}" smudge`,
    '',
  ].join('\n'))
  // The variable wins over init.defaultRefFormat, so cloneRepo has to pin the variable.
  const refEnv = reftable ? { GIT_DEFAULT_REF_FORMAT: 'reftable' } : {}
  return { env: { ...fx.env, GIT_CONFIG_GLOBAL: file, ...refEnv }, marker }
}

function saveCli(fx, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reflex-bundle.mjs'), 'save', fx.P, '--generation', String(fx.N), '--why', 'pause'], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout + r.stderr.slice(0, 2000))
  return JSON.parse(r.stdout)
}

// The read-only planner's view of the clone (checkClone and the clone's status).
function planClone(fx, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loop-recover.mjs'), fx.P, '--generation', String(fx.N)], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout + r.stderr.slice(0, 2000))
  return JSON.parse(r.stdout).clone
}

const ran = marker => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')

// Creation, the clone check and saves under the owner config. check --after deps is the commit
// path's touched set, which applies the owner's check-in conversion by design (R9), so the marker
// is cleared after it; nothing else may run the filter.
async function firingUnder(t, opts) {
  const fx = project(t)
  const { env, marker } = ownerConfig(fx, opts)
  await firing(fx)
  const out = prepare(fx, { env })
  assert.equal(out.created, true, JSON.stringify(out))
  assert.equal(ran(marker), '', 'prepare (creation) ran the owner\'s filter')
  // The owner's global eol settings apply in the clone, as in <P> (git-safe's header): a.txt is
  // checked out with CRLF under core.autocrlf=true, and still reads as clean.
  const checkedOut = fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8')
  assert.equal(checkedOut, 'a\r\n')
  assert.ok(fs.lstatSync(path.join(fx.W, '.git', 'refs', 'heads')).isDirectory(), 'the clone keeps the files ref backend')
  assert.equal(git(fx.W, ['config', '--file', path.join(fx.W, '.git', 'config'), '--get-regexp', '^(remote|extensions)[.]'], { check: false }), '',
    'the clone has no remote and no extension')
  check(fx, 'deps', { env })
  fs.rmSync(marker, { force: true })
  const empty = saveCli(fx, env)
  assert.equal(empty.state, 'empty', JSON.stringify(empty))
  write(fx.W, 'a.txt', 'changed\n')
  const saved = saveCli(fx, env)
  assert.equal(saved.state, 'saved', JSON.stringify(saved))
  assert.equal(ran(marker), '', 'a save ran the owner\'s filter')
  await firing(fx)
  const plan = planClone(fx, env)
  assert.equal(plan.valid, true, JSON.stringify(plan))
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.dirty.tracked, true, 'the planner sees the saved edit')
  assert.equal(ran(marker), '', 'the clone check ran the owner\'s filter')
  const again = prepare(fx, { env })
  assert.equal(again.created, false)
  assert.equal(ran(marker), '', 'prepare (recovery of the save) ran the owner\'s filter')
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), checkedOut, 'the reset writes what creation checked out')
  await firing(fx)
  const clean = planClone(fx, env)
  assert.equal(clean.valid, true, JSON.stringify(clean))
  assert.deepEqual(clean.dirty, { staged: false, tracked: false, untracked: [], more: 0 })
  assert.equal(ran(marker), '', 'the clone check ran the owner\'s filter')
}

test('owner config: clone.defaultRemoteName, core.autocrlf and a global filter; prepare, check and save succeed, no filter runs', T, async t => {
  await firingUnder(t)
})

test('owner config with init.defaultRefFormat=reftable and GIT_DEFAULT_REF_FORMAT=reftable: the clone is made with the files backend', { ...T, skip: !HAS_REFTABLE && 'git < 2.45 has no reftable' }, async t => {
  await firingUnder(t, { reftable: true })
})
