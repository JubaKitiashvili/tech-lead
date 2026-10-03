// tests/loop/loop-fixture-git-env.test.mjs
// The loop fixtures' git stays inside their temporary repositories when the suite inherits
// repository-routing variables (Codex g4 #1): fixture setup, and the firing driver's delegate
// git, run in a child whose environment points GIT_DIR, GIT_INDEX_FILE and config injection at
// a decoy repository, and the decoy's index, refs, objects and config are byte-identical
// afterwards. Real repositories, real processes.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ROOT, scrubGitRouting } from '../helpers.mjs'
import { project as firingProject, start } from './interrupt-fixture.mjs'

const T = { timeout: 90000 }
const HERMETIC = scrubGitRouting({
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: HERMETIC })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// A decoy repository with a commit and an owner's staged change, and the environment that aims
// git at it.
function decoyRepo(root) {
  const decoy = path.join(root, 'decoy')
  fs.mkdirSync(decoy)
  git(decoy, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(decoy, 'owner.txt'), 'staged by the owner\n')
  git(decoy, ['add', 'owner.txt'])
  git(decoy, ['commit', '-q', '-m', 'owner'])
  fs.writeFileSync(path.join(decoy, 'owner.txt'), 'staged again\n')
  git(decoy, ['add', 'owner.txt'])
  const hostile = {
    GIT_DIR: path.join(decoy, '.git'), GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'injected',
  }
  return { decoy, hostile }
}
const assertUntouched = (decoy, before) => {
  assert.deepEqual(decoyState(decoy), before, 'the decoy repository is untouched')
  assert.equal(git(decoy, ['diff', '--cached', '--name-only']), 'owner.txt', 'the owner\'s staged change is still staged')
}

// Every file under the decoy's .git with its digest: index, HEAD, refs, objects, config.
function decoyState(dir) {
  const out = []
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) walk(r)
      else out.push(`${r} ${sha256(path.join(dir, r))}`)
    }
  }
  walk('.git')
  return out.sort()
}

// The child (a script file, so that process.argv[1] is not a module the fixture imports takes
// for itself): imports one fixture with the hostile environment in place and runs its setup
// with a stand-in for the test context, then its cleanups.
const CHILD = `
const [url, which] = process.argv.slice(2)
const cleanups = []
const t = { after: fn => cleanups.push(fn) }
try {
  const fx = await import(url)
  if (which === 'clone') fx.project(t)
  else await fx.fixture(t, { 'a.txt': 'a\\n', 'b.txt': 'b\\n' })
} finally {
  for (const fn of cleanups.reverse()) fn()
}
`

const FIXTURES = [
  ['clone', 'loop-clone-fixture.mjs'],
  ['reflex', 'reflex-bundle-fixture.mjs'],
]

for (const [which, file] of FIXTURES) {
  test(`${file}: setup with GIT_DIR, GIT_INDEX_FILE and GIT_CONFIG_* aimed at a decoy leaves the decoy untouched`, T, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fxenv-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const { decoy, hostile } = decoyRepo(root)
    const before = decoyState(decoy)

    const url = pathToFileURL(path.join(ROOT, 'tests', 'loop', file)).href
    const child = path.join(root, 'child.mjs')
    fs.writeFileSync(child, CHILD)
    const r = spawnSync(process.execPath, [child, url, which], {
      encoding: 'utf8', cwd: root,
      env: { ...HERMETIC, ...hostile },
    })
    assertUntouched(decoy, before)
    assert.equal(r.status, 0, `fixture setup failed: ${r.stdout}\n${r.stderr}`)
  })
}

test('firing-driver.mjs: a firing started with GIT_DIR, GIT_INDEX_FILE and GIT_CONFIG_* aimed at a decoy commits in <W>, not in the decoy', T, async t => {
  const fx = firingProject(t)
  const { decoy, hostile } = decoyRepo(fx.root)
  const before = decoyState(decoy)
  const f = start(fx, { attempts: [{ ops: [['write', 'a.txt', 'by the delegate\n'], ['commit', 'delegate']] }], spawnEnv: hostile })
  const { exit } = await f.ended()
  assertUntouched(decoy, before)
  assert.equal(exit.code, 0, f.describe())
  assert.equal(f.get('released')?.outcome, 'done', f.describe())
})

// The suite-level scenario (Codex g4 #1, closing-review verifier): a whole test file run under
// the hostile environment. tests/lib/loop-paths.test.mjs makes its repositories with a plain git
// helper (add -A, commit) and imports no fixture.
test('a test file run with GIT_DIR, GIT_INDEX_FILE and GIT_CONFIG_* aimed at a decoy leaves the decoy untouched', T, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-fxenv-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { decoy, hostile } = decoyRepo(root)
  const before = decoyState(decoy)
  // NODE_TEST_CONTEXT would make the child report to this runner instead of printing TAP.
  const env = { ...HERMETIC, ...hostile }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(ROOT, 'tests', 'lib', 'loop-paths.test.mjs')], {
    encoding: 'utf8', cwd: root, env,
  })
  assertUntouched(decoy, before)
  assert.match(r.stdout, /^# pass [1-9]/m, r.stdout.slice(-2000))
  assert.match(r.stdout, /^# fail 0/m, r.stdout.slice(-2000))
})

// Every test file that runs git imports tests/helpers.mjs, directly or through a fixture module
// that does: importing it scrubs the routing variables from process.env. A file runs git when it
// or a module of tests/ it imports (a fixture: git reached only through it counts too) names git
// as the program of a spawn or exec call (any quote, sync or not), as the program of an argv
// array, or as a command inside a string (a shell command such as `cd x && git add -A`, `sh -c
// "git ..."`, or the `command -v git` of a fake git that execs the real one). The scripts' own
// git runs through scripts/lib/git-safe.mjs, which drops the routing variables itself.
const GIT_DIRECT = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]git(?:['"`]|\s)|['"`]git['"`]\s*,\s*\[/
const GIT_SHELL = /['"`](?:[^'"`\n]*?(?:&&|\|\||[;|(]|\$\(|\bexec\b|\bcommand -v|\bsh -c))?\s*['"]?git(?:\s+-{0,2}[A-Za-z]|['"`])/
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

// The .test.mjs files under testsDir that run git without reaching helpers (paths relative to
// testsDir).
function unscrubbed(testsDir, helpers) {
  const src = file => fs.readFileSync(file, 'utf8')
  const local = file => [...src(file).matchAll(IMPORT)].map(m => path.resolve(path.dirname(file), m[1] ?? m[2]))
    .filter(dep => dep.startsWith(testsDir + path.sep) && fs.existsSync(dep))
  // own(file), or the same of a module of testsDir it imports, at any depth (each file once).
  const reach = (own, memo = new Map()) => function go(file) {
    if (!memo.has(file)) {
      memo.set(file, false)
      memo.set(file, own(file) || local(file).some(go))
    }
    return memo.get(file)
  }
  const runsGit = reach(file => GIT_DIRECT.test(src(file)) || GIT_SHELL.test(src(file)))
  const reachesHelpers = reach(file => local(file).includes(helpers))
  const files = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.test.mjs')) files.push(p)
    }
  }
  walk(testsDir)
  return files.filter(f => runsGit(f) && !reachesHelpers(f)).map(f => path.relative(testsDir, f)).sort()
}

test('every test file that runs git imports tests/helpers.mjs, which scrubs the routing variables', () => {
  assert.deepEqual(unscrubbed(path.join(ROOT, 'tests'), path.join(ROOT, 'tests', 'helpers.mjs')), [], 'test files that run git without importing tests/helpers.mjs')
})

test('the scan sees every way a test runs git: spawn, double quotes, a shell string, a fake git, a fixture (Claude gap-verify P3)', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tl-gitscan-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  put('helpers.mjs', 'export const ROOT = 1\n')
  const runs = {
    'spawn.test.mjs': "import { spawn } from 'node:child_process'\nspawn('git', ['status'])\n",
    'double.test.mjs': 'import { spawnSync } from "node:child_process"\nspawnSync("git", ["status"])\n',
    'shell.test.mjs': "import { execSync } from 'node:child_process'\nexecSync('cd x && git add -A')\n",
    'sh-c.test.mjs': "import { execFileSync } from 'node:child_process'\nexecFileSync('/bin/sh', ['-c', 'git -C x commit -q -m m'])\n",
    'fake.test.mjs': "import { execFileSync } from 'node:child_process'\nconst real = execFileSync('sh', ['-c', 'command -v git']).toString()\n",
    'argv.test.mjs': "const cmd = ['git', ['init']]\n",
    'via-fixture.test.mjs': "import { run } from './fx/plain.mjs'\nrun()\n",
  }
  for (const [rel, text] of Object.entries(runs)) put(rel, text)
  put('fx/plain.mjs', "import { spawnSync } from 'node:child_process'\nexport const run = () => spawnSync(\"git\", ['init'])\n")
  // Scrubbed: they reach helpers.mjs, directly or through a fixture.
  put('ok-direct.test.mjs', "import './helpers.mjs'\nimport { spawnSync } from 'node:child_process'\nspawnSync('git', ['status'])\n")
  put('fx/good.mjs', "import '../helpers.mjs'\nimport { spawnSync } from 'node:child_process'\nexport const run = () => spawnSync('git', ['init'])\n")
  put('ok-fixture.test.mjs', "import { run } from './fx/good.mjs'\nrun()\n")
  // No git: a title that only mentions it, and a file that runs another program.
  put('none.test.mjs', "import test from 'node:test'\ntest('the passthrough never runs git inside a nested repository', () => {})\n")
  put('other.test.mjs', "import { spawnSync } from 'node:child_process'\nspawnSync('gitk-free', [])\nspawnSync('ls', ['-la'])\n")
  assert.deepEqual(unscrubbed(dir, path.join(dir, 'helpers.mjs')), Object.keys(runs).sort())
})
