// tests/lib/loop-scope.test.mjs
// The scope rules of spec section 4 (stage 0c-2 brief section 6): parseScope reads LOOP.md's
// scope: list through loop-md's frontList; checkScope canonicalizes and classifies it (ok,
// whole, invalid; invalid beats whole); inScope is the leading-component rule plus the real
// path rule (a symlink, dangling or not, is judged by its link target); scopeDigest hashes
// the canonical entries; markScope is the 0c-2 marking policy (R17: whole marks every path
// whose real path stays inside the root, invalid or unreadable marks every path out; R7:
// .tech-lead/ is always out). Every spec section 11 scope case is here: each whole spelling,
// a .. entry, an absolute path and a prefix-sibling directory.
import '../helpers.mjs' // scrubs inherited git routing variables from process.env before any other module loads
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkScope, inScope, markScope, parseScope, scopeDigest } from '../../scripts/lib/loop-scope.mjs'
import { canonicalJson, sha256Hex } from '../../scripts/lib/canonical.mjs'

// Fixture repositories never see the user's git config, hooks or identity.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
}
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] })

// A temp directory, removed when the test ends.
const tmp = (t, prefix = 'tl-scope-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const write = (root, rel, body = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), body)
}
const link = (root, rel, target) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.symlinkSync(target, path.join(root, rel))
}
// <parent>/repo with src/, src-old/, docs/ and .tech-lead/, and <parent>/outside/ beside it.
// The parent comes from os.tmpdir(), which on macOS is itself under a symlink (/var ->
// /private/var), so every root here is reached through an alias.
const layout = t => {
  const parent = tmp(t)
  const root = path.join(parent, 'repo')
  const outside = path.join(parent, 'outside')
  for (const rel of ['src/a.js', 'src/lib/b.js', 'src-old/a.js', 'docs/x.md', 'a.js', '.tech-lead/STATE.md', 'outside-sib/z']) write(root, rel)
  write(outside, 'secret.txt')
  return { parent, root, outside }
}
const md = scopeLines => `---\nlevel: 1\nverify:\n  - npm test\n${scopeLines}push: never\n---\n# body\n`
const scopeMd = (...entries) => md(`scope:\n${entries.map(e => `  - ${e}\n`).join('')}`)
const WHOLE = ['.']

test('parseScope reads the scope: block list through frontList, with its errors', () => {
  assert.deepEqual(parseScope(scopeMd('src', './docs/', "'odd: name'")), ['src', './docs/', 'odd: name'])
  assert.deepEqual(parseScope(md('scope:\n')), [])
  assert.throws(() => parseScope(md('')), { message: 'no-scope: the front matter has no scope: key' })
  assert.throws(() => parseScope(scopeMd("''")), { message: 'bad-scope: line 6: empty entry' })
  assert.throws(() => parseScope('scope:\n  - src\n'), { message: 'bad-loop-md: LOOP.md has no front matter' })
  assert.throws(() => parseScope(md('scope: [src]\n')), /^Error: bad-scope: line 5: scope: must be a block list/)
})

test('checkScope: every whole-repository spelling is whole (., ./, /, empty), with one canonical entry', () => {
  const spellings = [['.'], ['./'], ['/'], [''], ['   '], ['.//'], ['//'], ['./.'], ['././'], [' ./ '], []]
  for (const raw of spellings) {
    assert.deepEqual(checkScope(raw), { state: 'whole', entries: WHOLE }, JSON.stringify(raw))
  }
  // A whole spelling beside narrower entries is still whole; the entries are the canonical list.
  assert.deepEqual(checkScope(['src/', './', 'src', '.', 'docs']), { state: 'whole', entries: ['.', 'docs', 'src'] })
})

test('checkScope: an entry with a .. component is invalid (dotdot)', () => {
  for (const entry of ['..', '../x', 'src/..', 'a/../b', './..', 'src/../../etc', '../', ' .. ']) {
    assert.deepEqual(checkScope([entry]), { state: 'invalid', problems: [{ entry, why: 'dotdot' }] }, entry)
  }
  // A component that merely contains dots is a name.
  assert.deepEqual(checkScope(['...', 'a..b', '..a', 'b..', '.hidden']), { state: 'ok', entries: ['...', '..a', '.hidden', 'a..b', 'b..'] })
})

test('checkScope: an absolute path is invalid (absolute)', () => {
  for (const entry of ['/etc', '/src/', '//etc', '/..', '/./', ' /tmp/x ']) {
    assert.deepEqual(checkScope([entry]), { state: 'invalid', problems: [{ entry, why: 'absolute' }] }, entry)
  }
})

test('checkScope: invalid beats whole, and every problem is named in input order', () => {
  assert.deepEqual(checkScope(['./', '/etc', 'src', '../x', '.']), {
    state: 'invalid',
    problems: [{ entry: '/etc', why: 'absolute' }, { entry: '../x', why: 'dotdot' }],
  })
  assert.deepEqual(checkScope(['', '..']), { state: 'invalid', problems: [{ entry: '..', why: 'dotdot' }] })
})

test('checkScope: entries canonicalize (./src/ is src) and come back sorted and deduplicated', () => {
  assert.deepEqual(checkScope(['./src/']), { state: 'ok', entries: ['src'] })
  assert.deepEqual(checkScope([' ./src//lib/ ', 'src/./lib', 'docs', './/docs', 'src/lib', 'b', 'a', 'B', 'my dir/']), {
    state: 'ok',
    entries: ['B', 'a', 'b', 'docs', 'my dir', 'src/lib'],
  })
  // Sorting does not depend on the input order.
  assert.deepEqual(checkScope(['z', 'a/b', 'a']).entries, checkScope(['a', 'z', 'a/b', './z/']).entries)
})

test('checkScope never throws on content: malformed entries are invalid, a non-list is a caller bug', () => {
  const lone = String.fromCharCode(0xd800)
  const nul = 'src' + String.fromCharCode(0) + 'x'
  assert.deepEqual(checkScope(['src', lone, nul, 7, null]), {
    state: 'invalid',
    problems: [
      { entry: lone, why: 'malformed' },
      { entry: nul, why: 'malformed' },
      { entry: '7', why: 'malformed' },
      { entry: 'null', why: 'malformed' },
    ],
  })
  // Text outside ASCII is a name like any other.
  const accented = 'caf' + String.fromCharCode(0xe9)
  assert.deepEqual(checkScope([`./${accented}/`]), { state: 'ok', entries: [accented] })
  for (const bad of [undefined, null, 'src', { 0: 'src' }]) assert.throws(() => checkScope(bad), TypeError)
})

test('scopeDigest is SHA-256 over the canonical JSON of the entries', () => {
  const expect = crypto.createHash('sha256').update('["docs","src"]').digest('hex')
  assert.equal(scopeDigest(['docs', 'src']), expect)
  assert.equal(scopeDigest(['docs', 'src']), sha256Hex(canonicalJson(['docs', 'src'])))
  assert.equal(scopeDigest([]), sha256Hex('[]'))
  assert.match(scopeDigest(WHOLE), /^[0-9a-f]{64}$/)
  // Two spellings of one scope give one digest; another scope gives another.
  assert.equal(scopeDigest(checkScope(['./src/', 'docs']).entries), scopeDigest(checkScope(['docs', 'src']).entries))
  assert.notEqual(scopeDigest(['src']), scopeDigest(['src-old']))
})

test('inScope: one leading path component must equal an entry (src holds src/a.js, not src-old/a.js)', t => {
  const { root } = layout(t)
  const yes = (p, entries) => assert.equal(inScope(p, entries, { root }), true, `${p} in ${entries}`)
  const no = (p, entries) => assert.equal(inScope(p, entries, { root }), false, `${p} not in ${entries}`)
  yes('src/a.js', ['src'])
  yes('src', ['src'])
  yes('src/lib/b.js', ['src'])
  no('src-old/a.js', ['src'])
  no('srcx', ['src'])
  no('lib/src/a.js', ['src'])
  no('a.js', ['src'])
  yes('src/lib/b.js', ['src/lib'])
  no('src/a.js', ['src/lib'])
  no('src/libx/c.js', ['src/lib'])
  yes('src-old/a.js', ['docs', 'src-old'])
  no('src/a.js', [])
  // Paths that are not repository-relative are never in scope.
  for (const p of ['', '/src/a.js', '../src/a.js', 'src/../a.js', 'src/../../outside/secret.txt', './src/a.js', 'src/./a.js']) no(p, ['src'])
})

test('inScope: a path that does not exist yet is judged by its nearest existing ancestor', t => {
  const { root, outside } = layout(t)
  assert.equal(inScope('src/new/deep/file.js', ['src'], { root }), true)
  assert.equal(inScope('newdir/file.js', ['newdir'], { root }), true)
  // The ancestor is a symlink out of the root, so the missing file below it is out too.
  link(root, 'src/away', outside)
  assert.equal(inScope('src/away/missing/x.js', ['src'], { root }), false)
})

test('inScope: a symlink whose target leaves the root is out, under an explicit scope', t => {
  const { root, outside } = layout(t)
  link(root, 'src/abs', path.join(outside, 'secret.txt'))
  link(root, 'src/rel', '../../outside/secret.txt')
  link(root, 'src/dir', outside)
  link(root, 'src/hop', 'rel') // a chain whose last link leaves
  link(root, 'src/up', '..') // the root itself stays inside
  link(root, 'src/sib', '../src-old/a.js') // inside the root, though not in scope as a path
  const at = p => inScope(p, ['src'], { root })
  assert.equal(at('src/abs'), false)
  assert.equal(at('src/rel'), false)
  assert.equal(at('src/dir'), false)
  assert.equal(at('src/dir/secret.txt'), false)
  assert.equal(at('src/hop'), false)
  assert.equal(at('src/up'), true)
  assert.equal(at('src/sib'), true)
  // The entry itself as a symlink out of the root.
  fs.rmSync(path.join(root, 'docs'), { recursive: true })
  link(root, 'docs', outside)
  assert.equal(inScope('docs/secret.txt', ['docs'], { root }), false)
  assert.equal(inScope('docs', ['docs'], { root }), false)
})

test('inScope: a dangling symlink is judged by its link target', t => {
  const { root, outside } = layout(t)
  link(root, 'src/dang-out', path.join(outside, 'missing', 'file.txt'))
  link(root, 'src/dang-far', '/nonexistent-tech-lead-scope-test/abc')
  link(root, 'src/dang-in', 'missing.txt')
  link(root, 'src/dang-climb', 'nothere/../../../outside/x') // .. below a missing component
  link(root, 'src/dang-back', 'nothere/../ok.txt')
  link(root, 'src/loop1', 'loop2')
  link(root, 'src/loop2', 'loop1')
  const at = p => inScope(p, ['src'], { root })
  assert.equal(at('src/dang-out'), false)
  assert.equal(at('src/dang-far'), false)
  assert.equal(at('src/dang-in'), true)
  assert.equal(at('src/dang-climb'), false)
  assert.equal(at('src/dang-back'), true)
  // A loop never resolves, so it is out.
  assert.equal(at('src/loop1'), false)
})

test('inScope: the root and link targets may be reached through an alias', t => {
  const { parent, root } = layout(t)
  const alias = path.join(parent, 'alias')
  fs.symlinkSync(root, alias)
  assert.equal(inScope('src/a.js', ['src'], { root: alias }), true)
  // An absolute target that spells the root through the alias stays inside.
  link(root, 'src/via-alias', path.join(alias, 'docs', 'x.md'))
  assert.equal(inScope('src/via-alias', ['src'], { root }), true)
  assert.equal(inScope('src/via-alias', ['src'], { root: alias }), true)
})

test('inScope requires a root and an entry list', t => {
  const { root } = layout(t)
  assert.throws(() => inScope('src/a.js', ['src']), TypeError)
  assert.throws(() => inScope('src/a.js', ['src'], {}), TypeError)
  assert.throws(() => inScope('src/a.js', 'src', { root }), TypeError)
  assert.throws(() => inScope('src/a.js', ['src'], { root: path.join(root, 'no-such-dir') }), /ENOENT/)
})

test('markScope with an explicit scope: the prefix rule, the real path rule, and .tech-lead/ always out', t => {
  const { root, outside } = layout(t)
  link(root, 'src/out', path.join(outside, 'secret.txt'))
  link(root, 'src/dang', path.join(outside, 'nothing-here'))
  const paths = ['src/a.js', 'src-old/a.js', 'docs/x.md', '.tech-lead/STATE.md', 'src/out', 'src/dang', 'src/lib/b.js', 'src/new.js', 'src-old/a.js']
  assert.deepEqual(markScope(paths, scopeMd('./src/'), { root }), {
    state: 'ok',
    entries: ['src'],
    digest: scopeDigest(['src']),
    outOfScope: ['src-old/a.js', 'docs/x.md', '.tech-lead/STATE.md', 'src/out', 'src/dang'],
    warnings: [],
  })
  // Naming .tech-lead in scope: does not bring it in (R7).
  const r = markScope(['.tech-lead/STATE.md', '.tech-lead', '.tech-lead/x/y', 'src/a.js'], scopeMd('src', '.tech-lead'), { root })
  assert.equal(r.state, 'ok')
  assert.deepEqual(r.outOfScope, ['.tech-lead/STATE.md', '.tech-lead', '.tech-lead/x/y'])
  assert.deepEqual(markScope([], scopeMd('src'), { root }).outOfScope, [])
})

test('markScope with each whole spelling: in scope when the real path stays inside the root (R17)', t => {
  const { root, outside } = layout(t)
  link(root, 'src/out', path.join(outside, 'secret.txt'))
  link(root, 'lnk-dang', '/nonexistent-tech-lead-scope-test/abc')
  link(root, 'lnk-in', 'docs/x.md')
  const paths = ['a.js', 'src/a.js', 'src-old/a.js', 'gone/deleted.js', 'src/out', 'lnk-dang', 'lnk-in', '.tech-lead/LOOP.md']
  const texts = [scopeMd('./'), scopeMd('.'), scopeMd('/'), scopeMd('"/"'), scopeMd("'./'"), md('scope:\n'), md('scope:   # whole\n'), scopeMd('./', 'src')]
  for (const text of texts) {
    const r = markScope(paths, text, { root })
    assert.equal(r.state, 'whole', text)
    assert.deepEqual(r.outOfScope, ['src/out', 'lnk-dang', '.tech-lead/LOOP.md'], text)
    assert.deepEqual(r.warnings, ['scope-whole'], text)
    assert.equal(r.digest, scopeDigest(r.entries), text)
  }
  assert.deepEqual(markScope(paths, scopeMd('./'), { root }).entries, WHOLE)
  assert.deepEqual(markScope(paths, scopeMd('./', 'src'), { root }).entries, ['.', 'src'])
})

test('markScope with an invalid or unreadable scope: every path out (R17), never a throw', t => {
  const { root } = layout(t)
  const paths = ['a.js', 'src/a.js', '.tech-lead/STATE.md']
  const texts = [
    scopeMd('/etc'),
    scopeMd('../x'),
    scopeMd('./', '/etc'), // invalid beats whole
    scopeMd('src', 'src/../..'),
    scopeMd("''"), // frontList refuses an empty entry
    md(''), // no scope: key
    md('scope: [src]\n'),
    'scope:\n  - src\n', // no front matter
    '',
    null,
    undefined,
    Buffer.from(scopeMd('src')),
  ]
  for (const text of texts) {
    const r = markScope(paths, text, { root })
    assert.equal(r.state, 'invalid', String(text))
    assert.deepEqual(r.entries, [], String(text))
    assert.equal(r.digest, scopeDigest([]), String(text))
    assert.deepEqual(r.outOfScope, paths, String(text))
    assert.deepEqual(r.warnings, ['scope-invalid'], String(text))
    assert.equal(typeof r.detail, 'string', String(text))
  }
  assert.match(markScope(paths, scopeMd('./', '/etc', '../x'), { root }).detail, /^absolute \/etc; dotdot \.\.\/x$/)
  assert.match(markScope(paths, md(''), { root }).detail, /^unreadable: no-scope: /)
})

test('markScope: a path whose real path is inside .tech-lead/ or .git is out under any scope', t => {
  const { root } = layout(t)
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
  link(root, 'src/spine', '../.tech-lead/STATE.md')
  link(root, 'src/hook', '../.git/hooks/pre-commit')
  link(root, 'src/gitdir', '../.git')
  link(root, 'src/spine-dir', '../.TECH-LEAD')
  for (const text of [scopeMd('src'), scopeMd('./')]) {
    const r = markScope(['src/a.js', 'src/spine', 'src/hook', 'src/gitdir', 'src/spine-dir', '.git/config', '.GIT/config', '.Tech-Lead/x'], text, { root })
    assert.deepEqual(r.outOfScope, ['src/spine', 'src/hook', 'src/gitdir', 'src/spine-dir', '.git/config', '.GIT/config', '.Tech-Lead/x'], text)
  }
})

test('markScope requires a root and a path list', t => {
  const { root } = layout(t)
  assert.throws(() => markScope(['a.js'], scopeMd('src')), TypeError)
  assert.throws(() => markScope('a.js', scopeMd('src'), { root }), TypeError)
  assert.throws(() => markScope([7], scopeMd('src'), { root }), TypeError)
})

test('markScope marks the paths git reports in a real clone, symlinks included', t => {
  const parent = tmp(t)
  const W = path.join(parent, 'clone')
  const outside = path.join(parent, 'outside')
  write(outside, 'secret.txt')
  fs.mkdirSync(W)
  git(W, 'init', '-q', '-b', 'main')
  write(W, 'src/a.js', 'a\n')
  write(W, 'src-old/a.js', 'old\n')
  git(W, 'add', '-A')
  git(W, 'commit', '-q', '-m', 'base')
  // A delegate's work: an edit, a new file, a deletion, two symlinks, a spine write.
  write(W, 'src/a.js', 'a2\n')
  write(W, 'src/b.js', 'b\n')
  fs.rmSync(path.join(W, 'src-old/a.js'))
  link(W, 'src/leak', path.join(outside, 'secret.txt'))
  link(W, 'src/ok', 'a.js')
  write(W, '.tech-lead/STATE.md', 's\n')
  const touched = git(W, 'status', '--porcelain=v1', '-z', '-uall').split('\0').filter(Boolean).map(l => l.slice(3)).sort()
  assert.deepEqual(touched, ['.tech-lead/STATE.md', 'src-old/a.js', 'src/a.js', 'src/b.js', 'src/leak', 'src/ok'])
  assert.deepEqual(markScope(touched, scopeMd('src'), { root: W }).outOfScope, ['.tech-lead/STATE.md', 'src-old/a.js', 'src/leak'])
  assert.deepEqual(markScope(touched, scopeMd('./'), { root: W }).outOfScope, ['.tech-lead/STATE.md', 'src/leak'])
})
