// tests/loop/loop-clone-passthrough-nested.test.mjs
// The read-only git passthrough (brief 13.2) never makes git run inside a nested repository
// (R26), runs no filter program, and never writes <W>/.git/index. Real repositories, a held lock:
// the base tracks a gitlink `sub`, which a delegate populates with an independent repository whose
// own config names a clean filter and an fsmonitor hook that write a marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { T, cli, firing, git, prepare, project, write } from './loop-clone-fixture.mjs'

const refusedLine = r => {
  const last = r.stderr.trim().split('\n').pop()
  assert.match(last, /^loop-clone git: /, r.stderr)
  return JSON.parse(last.slice('loop-clone git: '.length))
}

// A shell script that appends its name to `marker` and passes stdin through (a clean filter that
// changes nothing, or an fsmonitor hook that answers nothing).
function markerScript(dir, name, marker) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${marker}'\ncat\n`, { mode: 0o755 })
  return file
}

// <P> whose base tracks the gitlink `sub` (an independent repository X), prepared; then the
// delegate clones X into <W>/sub, arms its local config and .gitattributes, and makes a same-size
// edit, so a git that looks inside compares content (the filter) and asks the hook.
async function nestedFixture(t) {
  let X
  const fx = project(t, {
    plumb: P => {
      X = path.join(path.dirname(P), 'x-repo')
      fs.mkdirSync(X)
      git(X, ['init', '-q', '-b', 'main'])
      write(X, 'inner.txt', 'inner\n')
      git(X, ['add', '-A'])
      git(X, ['commit', '-q', '-m', 'x'])
      git(P, ['clone', '-q', '--', X, 'sub']) // `add -A` records it as the gitlink sub
    },
  })
  await firing(fx)
  prepare(fx)
  const sub = path.join(fx.W, 'sub')
  fs.rmSync(sub, { recursive: true, force: true })
  git(fx.root, ['clone', '-q', '--', X, sub])
  // The passthrough's GIT_ATTR_SOURCE (<W>'s HEAD) reaches a nested git too, which then reads no
  // .gitattributes from its work tree and fails on a commit it lacks; a delegate defeats that by
  // fetching the commit and selecting the filter from info/attributes, which git still reads.
  git(sub, ['fetch', '-q', '--', fx.W, 'HEAD'])
  const marker = path.join(fx.root, 'marker')
  const bin = fs.mkdtempSync(path.join(fx.root, 'evil-'))
  git(sub, ['config', 'filter.evil.clean', markerScript(bin, 'clean', marker)])
  git(sub, ['config', 'core.fsmonitor', markerScript(bin, 'fsmonitor', marker)])
  write(sub, '.gitattributes', '* filter=evil\n')
  write(sub, path.join('.git', 'info', 'attributes'), '* filter=evil\n')
  write(sub, 'inner.txt', 'INNER\n')
  return { fx, sub, marker }
}

const pass = (fx, ...args) => cli(fx.env, 'git', fx.P, '--', ...args)
const markers = marker => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')

test('passthrough status and diff never run git inside a populated gitlink: no nested filter, no nested fsmonitor (R26)', T, async t => {
  const { fx, sub, marker } = await nestedFixture(t)
  // The control: git's own status of <W> enters the nested repository and runs its programs.
  git(fx.W, ['status', '--porcelain'])
  assert.notEqual(markers(marker), '', 'the fixture arms the nested repository')
  fs.rmSync(marker)
  // ... and under the passthrough's attribute source too.
  fs.writeFileSync(path.join(sub, 'inner.txt'), 'InneR\n')
  git(fx.W, ['status', '--porcelain'], { env: { ...fx.env, GIT_ATTR_SOURCE: git(fx.W, ['rev-parse', 'HEAD']) } })
  assert.match(markers(marker), /clean/, 'the nested filter runs under GIT_ATTR_SOURCE')
  fs.rmSync(marker)
  fs.writeFileSync(path.join(sub, 'inner.txt'), 'inneR\n') // stat-dirty again, same size
  for (const argv of [['status', '--porcelain'], ['status'], ['diff'], ['diff', 'HEAD'], ['diff', '--stat']]) {
    const r = pass(fx, ...argv)
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(markers(marker), '', `${argv.join(' ')} ran a program the nested repository names`)
  }
})

test('passthrough refuses options that override the pinned submodule handling or inspect nested repositories, and describe --dirty/--broken (R26)', T, async t => {
  const { fx, marker } = await nestedFixture(t)
  for (const argv of [
    ['status', '--ignore-submodules=none'], ['status', '--ignore-submodules'], ['status', '--ignore-sub=none'],
    ['diff', '--ignore-submodules=none'], ['diff', '--submodule=diff'], ['diff', '--submodule'], ['log', '-p', '--submodule=diff'],
    ['show', '--submod=diff'], ['ls-files', '--recurse-submodules'], ['grep', '--recurse-submodules', 'x'],
    ['status', '--recurse-sub'], ['describe', '--always', '--dirty'], ['describe', '--always', '--dirty=-x'],
    ['describe', '--always', '--dirt'], ['describe', '--always', '--broken'],
  ]) {
    const r = pass(fx, ...argv)
    assert.equal(r.status, 2, `${JSON.stringify(argv)} -> ${r.status} ${r.stderr}`)
    assert.equal(refusedLine(r).state, 'refused', JSON.stringify(argv))
  }
  assert.equal(markers(marker), '', 'a refused command runs nothing')
  // Harmless look-alikes still pass.
  assert.equal(pass(fx, 'status', '--ignored').status, 0)
  assert.equal(pass(fx, 'diff', '--summary', 'HEAD').status, 0)
  assert.equal(pass(fx, 'describe', '--always').status, 0)
})

test('passthrough runs no top-level filter program: drivers emptied and attributes read from HEAD, not the delegate\'s .gitattributes', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const marker = path.join(fx.root, 'marker')
  const bin = fs.mkdtempSync(path.join(fx.root, 'evil-'))
  // The owner's global config names a driver; the delegate's .gitattributes selects it.
  const cfg = path.join(fx.root, 'global.gitconfig')
  fs.writeFileSync(cfg, `[filter "evil"]\n\tclean = ${markerScript(bin, 'clean', marker)}\n`)
  write(fx.W, '.gitattributes', '* filter=evil\n')
  write(fx.W, 'a.txt', 'A\n') // same size as the base's 'a\n'
  const env = { ...fx.env, GIT_CONFIG_GLOBAL: cfg }
  git(fx.W, ['status', '--porcelain'], { env })
  assert.notEqual(markers(marker), '', 'the control runs the filter')
  fs.rmSync(marker)
  write(fx.W, 'a.txt', 'B\n')
  for (const argv of [['status', '--porcelain'], ['diff'], ['diff', 'HEAD'], ['blame', 'a.txt'], ['ls-files', '-m']]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
    assert.equal(markers(marker), '', `${argv.join(' ')} ran the filter`)
  }
  // The diff still shows the edit.
  const d = cli(env, 'git', fx.P, '--', 'diff', '--name-only')
  assert.deepEqual(d.stdout.trim().split('\n').sort(), ['a.txt'])
})

test('passthrough never writes <W>/.git/index: status, diff and describe leave it byte-identical with its mtime', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const index = path.join(fx.W, '.git', 'index')
  const look = () => ({ bytes: fs.readFileSync(index).toString('base64'), mtime: fs.statSync(index).mtimeMs })
  // Stat-dirty but unchanged files: a refreshing git would rewrite the index.
  const later = new Date(Date.now() + 5000)
  for (const rel of ['a.txt', 'b.txt', 'src/app.js']) fs.utimesSync(path.join(fx.W, rel), later, later)
  const before = look()
  for (const argv of [['status'], ['status', '--porcelain'], ['diff'], ['diff', 'HEAD'], ['diff', '--quiet'], ['describe', '--always'], ['ls-files', '-m']]) {
    const r = pass(fx, ...argv)
    assert.equal(r.status, 0, `${argv.join(' ')}: ${r.stderr}`)
    assert.deepEqual(look(), before, `${argv.join(' ')} wrote the index`)
  }
  assert.equal(fs.existsSync(`${index}.lock`), false)
})

test('passthrough refuses the negated spellings that would undo the pinned submodule handling: --no-ignore-submodules and its abbreviations (R26)', T, async t => {
  const { fx, sub, marker } = await nestedFixture(t)
  for (const argv of [
    ['status', '--no-ignore-submodules'], ['status', '--porcelain', '--no-ignore-sub'], ['status', '--no-ig'],
    ['diff', '--no-ignore-submodules'], ['diff', 'HEAD', '--no-ignore-sub'], ['status', '--no-ignore-submodules=none'],
    ['status', '--no-'], ['describe', '--always', '--no-e'],
  ]) {
    fs.writeFileSync(path.join(sub, 'inner.txt'), argv.length % 2 ? 'inneR\n' : 'INNER\n') // stat-dirty, same size
    const r = pass(fx, ...argv)
    assert.equal(r.status, 2, `${JSON.stringify(argv)} -> ${r.status} ${r.stderr}`)
    assert.equal(refusedLine(r).state, 'refused', JSON.stringify(argv))
    assert.equal(markers(marker), '', `${JSON.stringify(argv)} ran a program the nested repository names`)
  }
  // Negations that only turn something off still pass.
  for (const argv of [
    ['diff', '--no-ext-diff'], ['diff', '--no-textconv', 'HEAD'], ['blame', '--no-textconv', 'a.txt'], ['diff', '--no-color'],
    ['diff', '--no-renames', 'HEAD'], ['rev-list', '--no-filter', 'HEAD'], ['ls-files', '--exclude-standard', '-o'],
  ]) {
    const r = pass(fx, ...argv)
    assert.equal(r.status, 0, `${JSON.stringify(argv)}: ${r.stderr}`)
  }
  assert.equal(markers(marker), '')
})
