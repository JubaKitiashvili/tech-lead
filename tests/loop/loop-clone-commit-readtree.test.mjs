// tests/loop/loop-clone-commit-readtree.test.mjs
// commit records its intent, then `read-tree C`. When that read-tree fails (here: an index.lock
// git cannot take), nothing moved: HEAD is still H0 and the index is untouched (read-tree writes
// it atomically). The intent is cleared and commit refuses commit-failed, as a failed
// compare-and-swap does (brief 13, commit), so the attempt stays open: loop §7's retry (check,
// commit) and its Save and reset still run in this firing, and the next firing's recovery reads a
// prepared record. Real repositories, a held lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { T, check, cli, commitCli, firing, prepare, project, recordOf, subjectFile, tipOf, write } from './loop-clone-fixture.mjs'

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

test('a failed compare-and-swap whose rollback read-tree H0 also fails clears the intent and refuses commit-failed; the next firing saves the work (F9)', T, async t => {
  const fx = project(t)
  await firing(fx)
  prepare(fx)
  const H0 = tipOf(fx.W)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const r = cli(failingGit(fx, H0), 'commit', fx.P, '--generation', String(fx.N), '--digest', c.digest, '--subject-file', subjectFile(fx, 'Do it\n'))
  assert.equal(r.status, 3, `${r.stdout} ${r.stderr}`)
  assert.equal(r.out.state, 'commit-failed', r.stdout)
  const rec = recordOf(fx)
  assert.equal(rec.phase, 'prepared', 'the attempt stays open in this firing')
  assert.equal(rec.intent, null)
  assert.equal(tipOf(fx.W), H0, 'HEAD did not move')
  await firing(fx)
  const p = prepare(fx, { date: '2026-10-03' })
  assert.equal(p.state, 'ready', JSON.stringify(p))
  assert.equal(fs.readFileSync(path.join(fx.W, 'a.txt'), 'utf8'), 'a\n')
  const old = recordOf(fx, 1)
  assert.equal(old.saves.length + (old.recovery?.bundles?.length ?? 0), 1, `the edit was saved: ${JSON.stringify(old)}`)
})
