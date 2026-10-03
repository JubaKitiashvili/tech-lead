// tests/loop/loop-clone-commit-readtree.test.mjs
// commit records its intent, then `read-tree C`. When that read-tree fails (here: an index.lock
// git cannot take), nothing moved: HEAD is still H0 and the index is untouched (read-tree writes
// it atomically). The intent is cleared and commit refuses commit-failed, as a failed
// compare-and-swap does (brief 13, commit), so the attempt stays open: loop §7's retry (check,
// commit) and its Save and reset still run in this firing, and the next firing's recovery reads a
// prepared record. When instead the compare-and-swap fails and so does its rollback read-tree H0,
// the index holds C's tree: the intent is kept (C stays known) and commit exits 2, a clone error.
// Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  T, bundleHeads, check, cli, commitCli, firing, git, prepare, project, recordOf, scratchApply, subjectFile, tipOf, write,
} from './loop-clone-fixture.mjs'

const commitRaw = (fx, digest) => cli(fx.env, 'commit', fx.P, '--generation', String(fx.N), '--digest', digest, '--subject-file', subjectFile(fx, 'Do it\n'))

test('a read-tree C that fails clears the intent and refuses commit-failed; the attempt stays open and the retry commits', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const H0 = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const lock = path.join(fx.W, '.git', 'index.lock')
  const indexBefore = fs.readFileSync(path.join(fx.W, '.git', 'index'))
  fs.writeFileSync(lock, '')
  const r = commitRaw(fx, c.digest)
  assert.equal(r.status, 3, `${r.stdout} ${r.stderr}`)
  assert.equal(r.out.state, 'commit-failed', r.stdout)
  assert.match(r.out.detail, /read-tree/)
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'prepared')
  assert.equal(rec.intent, null)
  assert.equal(tipOf(fx.W), H0, 'HEAD did not move')
  assert.deepEqual(fs.readFileSync(path.join(fx.W, '.git', 'index')), indexBefore, 'the index is untouched')
  // loop §7's retry in the same firing: check again, then commit.
  fs.unlinkSync(lock)
  const again = check(fx, 'dispatch')
  assert.deepEqual(again.touched, ['a.txt'])
  const m = commitCli(fx, again.digest)
  assert.equal(m.state, 'committed', JSON.stringify(m))
  assert.equal(recordOf(fx).phase, 'committed')
})

test('after a failed read-tree C the next firing recovers the work as a prepared record: saved, reset, ready', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const lock = path.join(fx.W, '.git', 'index.lock')
  fs.writeFileSync(lock, '')
  assert.equal(commitRaw(fx, c.digest).out.state, 'commit-failed')
  fs.unlinkSync(lock)
  await firing(fx)
  const p = prepare(fx, { date: '2026-10-03' })
  assert.equal(p.state, 'ready', JSON.stringify(p))
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  const saves = recordOf(fx, 1).saves.length + (recordOf(fx, 1).recovery?.bundles?.length ?? 0)
  assert.equal(saves, 1, `the edit was saved: ${JSON.stringify(recordOf(fx, 1))}`)
})

// A git on PATH that fails `update-ref` (the compare-and-swap) and then `read-tree <H0>` (its
// rollback, on the clone's own index: a temporary index is GIT_INDEX_FILE), as two faults in a
// row would; every other call runs the real git.
function failingGit(fx, H0) {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = path.join(fx.root, `fake-git-${process.hrtime.bigint()}`)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$a" in',
    '    update-ref) echo "fatal: injected update-ref failure" >&2; exit 128 ;;',
    `    ${H0}) case " $* " in *" read-tree "*) [ -z "$GIT_INDEX_FILE" ] && { echo "fatal: injected read-tree failure" >&2; exit 128; } ;; esac ;;`,
    '  esac',
    'done',
    `exec ${real} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })
  return { ...fx.env, PATH: `${bin}:${fx.env.PATH ?? process.env.PATH}` }
}

// The double fault after an edit of a.txt: the compare-and-swap fails, then its rollback read-tree
// H0, so the index is left holding C's tree. Returns {H0, r} (r: the commit CLI's result).
function doubleFault(fx) {
  const H0 = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const r = cli(failingGit(fx, H0), 'commit', fx.P, '--generation', String(fx.N), '--digest', c.digest, '--subject-file', subjectFile(fx, 'Do it\n'))
  assert.equal(tipOf(fx.W), H0, 'HEAD did not move')
  return { H0, r }
}

// Every save sha a record anchors: its own saves and its recovery's bundles.
const savesOf = rec => [...rec.saves.map(s => s.sha), ...(rec.recovery?.bundles ?? [])]

test('a failed compare-and-swap whose rollback read-tree H0 also fails keeps the intent with C and exits 2; the next firing saves the work and never delivers C (F9)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const { H0, r } = doubleFault(fx)
  assert.equal(r.status, 2, `${r.stdout} ${r.stderr}`)
  assert.equal(r.out.state, 'error', r.stdout)
  assert.match(r.out.detail, /read-tree/)
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'intent', 'the intent is kept: C stays known')
  assert.equal(rec.intent.parent, H0)
  const C = rec.intent.commit
  assert.equal(git(fx.W, ['show', `${C}:a.txt`]), 'edited', "C's tree holds the edit")
  // The firing pauses (clone error); the next one recovers.
  await firing(fx)
  const p = prepare(fx, { date: '2026-10-03' })
  assert.equal(p.state, 'ready', JSON.stringify(p))
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  const old = recordOf(fx, 1)
  assert.equal(old.commit, null, 'C was never recorded as committed')
  const saves = savesOf(old)
  assert.equal(saves.length, 1, `the edit was saved once: ${JSON.stringify(old)}`)
  assert.equal(fs.readFileSync(path.join(scratchApply(fx, H0, saves[0]), 'a.txt'), 'utf8'), 'edited\n')
  // C reaches no ref of the clone and no delivery bundle.
  assert.equal(git(fx.W, ['for-each-ref', '--contains', C]), '', 'no ref of the clone contains C')
  assert.ok(!JSON.stringify(p.bundles).includes(C), `prepare re-synced no bundle of C: ${JSON.stringify(p.bundles)}`)
  const out = path.join(fx.V, 'out')
  for (const name of fs.existsSync(out) ? fs.readdirSync(out).filter(n => n.endsWith('.bundle')) : []) {
    for (const [sha] of bundleHeads(fx.W, path.join(out, name))) assert.notEqual(sha, C, `${name} holds C`)
  }
})

// The re-check seats' probe: with the intent cleared, C was forgotten while the index still held
// its tree, so a later edit of a path C changed left a staged blob found nowhere else (index-only)
// and every later prepare refused.
test('after the double fault a rewrite of a path C changed still recovers: the next prepare is ready (not index-only) and the save holds the latest bytes', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const { H0 } = doubleFault(fx)
  write(fx.W, 'a.txt', 'latest\n')
  await firing(fx)
  const p = prepare(fx, { date: '2026-10-03' })
  assert.equal(p.state, 'ready', JSON.stringify(p))
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  const saves = savesOf(recordOf(fx, 1))
  assert.equal(saves.length, 1, JSON.stringify(recordOf(fx, 1)))
  assert.equal(fs.readFileSync(path.join(scratchApply(fx, H0, saves[0]), 'a.txt'), 'utf8'), 'latest\n')
})
