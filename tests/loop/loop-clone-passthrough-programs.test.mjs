// tests/loop/loop-clone-passthrough-programs.test.mjs
// The read-only git passthrough (brief 13.2) runs no program the owner's config names for the
// clone's content (status -v, whose diff runs textconv, is refused). A remerge diff (show --remerge-diff, log --diff-merges=remerge, or -m under
// the owner's log.diffMerges=remerge) merges a merge commit's parents again, and a custom merge
// driver the owner's config names and an attribute selects would run a program from <W>. Real
// repositories, a held lock: the base's history holds a merge whose parents both changed c.txt,
// the base's .gitattributes selects the driver `evil` for it, the owner's global config points
// that driver at ./merge.sh, and the delegate writes a merge.sh into <W> that leaves a marker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { T, cli, firing, git, prepare, project, write } from './loop-clone-fixture.mjs'

const markers = marker => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')

async function remergeFixture(t, { diffMerges } = {}) {
  let M
  const fx = project(t, {
    plumb: P => {
      write(P, 'c.txt', 'one\ntwo\nthree\nfour\nfive\n')
      write(P, '.gitattributes', 'c.txt merge=evil\n')
      git(P, ['add', '--', 'c.txt', '.gitattributes'])
      git(P, ['commit', '-q', '-m', 'c'])
      git(P, ['checkout', '-q', '-b', 'side'])
      write(P, 'c.txt', 'ONE\ntwo\nthree\nfour\nfive\n')
      git(P, ['commit', '-q', '-am', 'side'])
      git(P, ['checkout', '-q', 'main'])
      write(P, 'c.txt', 'one\ntwo\nthree\nfour\nFIVE\n')
      git(P, ['commit', '-q', '-am', 'main'])
      git(P, ['merge', '-q', '--no-edit', 'side']) // no driver configured here: a clean text merge
      git(P, ['branch', '-q', '-D', 'side'])
      M = git(P, ['rev-parse', 'HEAD'])
    },
  })
  await firing(fx)
  prepare(fx)
  const marker = path.join(fx.root, 'marker')
  fs.writeFileSync(path.join(fx.W, 'merge.sh'), `#!/bin/sh\necho merge >> '${marker}'\nexit 1\n`, { mode: 0o755 })
  const cfg = path.join(fx.root, 'global.gitconfig')
  fs.writeFileSync(cfg, `[merge "evil"]\n\tdriver = ./merge.sh %O %A %B\n${diffMerges ? `[log]\n\tdiffMerges = ${diffMerges}\n` : ''}`)
  return { fx, M, marker, env: { ...fx.env, GIT_CONFIG_GLOBAL: cfg } }
}

test('passthrough runs no merge driver: remerge options are refused and every configured driver is emptied', T, async t => {
  const { fx, M, marker, env } = await remergeFixture(t)
  // The control: git's own remerge diff in <W>, attributes read from HEAD as the passthrough reads them.
  git(fx.W, ['show', '--remerge-diff', M], { env: { ...env, GIT_ATTR_SOURCE: git(fx.W, ['rev-parse', 'HEAD']) } })
  assert.match(markers(marker), /merge/, 'the control runs the driver')
  fs.rmSync(marker)
  for (const argv of [
    ['show', '--remerge-diff', M], ['log', '--remerge-diff'], ['log', '--diff-merges=remerge'], ['log', '--diff-merges=r'],
    ['show', '--diff-merges=r', M], ['log', '--diff-merges', 'remerge'], ['log', '--remerge', '-1'],
  ]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(markers(marker), '', `${JSON.stringify(argv)} ran the merge driver (exit ${r.status})`)
    assert.equal(r.status, 2, `${JSON.stringify(argv)} -> ${r.status} ${r.stderr}`)
    assert.match(r.stderr, /loop-clone git: \{"state":"refused"/, JSON.stringify(argv))
  }
  // The other merge formats still show the merge.
  for (const argv of [['show', M], ['log', '-m', '-1', '--format=%H', M], ['log', '--diff-merges=first-parent', '-1', M], ['show', '--cc', M]]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(r.status, 0, `${JSON.stringify(argv)}: ${r.stderr}`)
  }
  assert.equal(markers(marker), '')
})

test('passthrough runs no merge driver under the owner\'s log.diffMerges=remerge: -m and --diff-merges=on show a separate diff', T, async t => {
  const { fx, M, marker, env } = await remergeFixture(t, { diffMerges: 'remerge' })
  git(fx.W, ['log', '-m', '-1', '-p', M], { env: { ...env, GIT_ATTR_SOURCE: git(fx.W, ['rev-parse', 'HEAD']) } })
  assert.match(markers(marker), /merge/, 'the control runs the driver through the owner\'s config')
  fs.rmSync(marker)
  for (const argv of [['log', '-m', '-1', '-p', M], ['show', '-m', M], ['log', '--diff-merges=on', '-1', M], ['log', '--diff-merges=m', '-1', M]]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(r.status, 0, `${JSON.stringify(argv)}: ${r.stderr}`)
    assert.equal(markers(marker), '', `${JSON.stringify(argv)} ran the merge driver`)
    // One diff against each parent, not a remerge diff with its conflict markers.
    assert.match(r.stdout, /^commit [0-9a-f]{40} \(from [0-9a-f]{40}\)$/m, `${JSON.stringify(argv)}: ${r.stdout}`)
    assert.doesNotMatch(r.stdout, /<<<<<<<|remerge/, JSON.stringify(argv))
  }
})

test('passthrough refuses status --verbose, whose diff of the changes runs a textconv program (status takes no --no-textconv)', T, async t => {
  const fx = project(t, { files: { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitattributes': '*.txt diff=evil\n' } })
  await firing(fx)
  prepare(fx)
  const marker = path.join(fx.root, 'marker')
  const bin = fs.mkdtempSync(path.join(fx.root, 'evil-'))
  // The owner's global config names a textconv driver; the base's .gitattributes selects it.
  const tc = path.join(bin, 'textconv')
  fs.writeFileSync(tc, `#!/bin/sh\necho textconv >> '${marker}'\ncat "$1"\n`, { mode: 0o755 })
  const cfg = path.join(fx.root, 'global.gitconfig')
  fs.writeFileSync(cfg, `[diff "evil"]\n\ttextconv = ${tc}\n`)
  const env = { ...fx.env, GIT_CONFIG_GLOBAL: cfg }
  write(fx.W, 'a.txt', 'staged\n')
  git(fx.W, ['add', '--', 'a.txt'])
  write(fx.W, 'a.txt', 'edited\n')
  git(fx.W, ['status', '-vv'], { env: { ...env, GIT_ATTR_SOURCE: git(fx.W, ['rev-parse', 'HEAD']) } })
  assert.match(markers(marker), /textconv/, 'the control runs the textconv program')
  fs.rmSync(marker)
  for (const argv of [['status', '-v'], ['status', '-vv'], ['status', '--verbose'], ['status', '--verb'], ['status', '-sv'], ['status', '-bv', '--', 'a.txt']]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(markers(marker), '', `${JSON.stringify(argv)} ran the textconv program (exit ${r.status})`)
    assert.equal(r.status, 2, `${JSON.stringify(argv)} -> ${r.status} ${r.stderr}`)
    assert.match(r.stderr, /loop-clone git: \{"state":"refused"/, JSON.stringify(argv))
  }
  // Look-alikes still pass, and diff shows the edit without the program.
  for (const argv of [['status', '-sb'], ['status', '--no-verbose'], ['status', '-uno'], ['diff', '--cached'], ['log', '-p', '-1']]) {
    const r = cli(env, 'git', fx.P, '--', ...argv)
    assert.equal(r.status, 0, `${JSON.stringify(argv)}: ${r.stderr}`)
  }
  assert.equal(markers(marker), '')
})
