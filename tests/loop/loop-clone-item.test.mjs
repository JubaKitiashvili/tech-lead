// tests/loop/loop-clone-item.test.mjs
// loop-clone.mjs and the ## Now item (stage 0c-3, brief R19): prepare records the item's id and
// itemDigest in its v:2 run record (null when ## Now is empty or its item has no valid id), and
// commit passes the record's item_id to commitMessage, so the loop commit carries the
// `Tech-Lead-Item:` trailer before `Tech-Lead-Generation:`. A v:1 record an interrupted 0.5.0
// firing left is recovered by the next prepare and stays v:1. R33: prepare's clean-clone save
// writes the interrupted v:2 record's item_id and item_digest into the bundle header (null for a
// v:1 record). Real repositories, a held lock, the CLI as a child process.
import '../helpers.mjs' // scrubs inherited git routing variables from process.env before any other module loads
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { T, attempt, check, firing, git, headerOf, killAt, prepare, project, recordOf, tipOf, write } from './loop-clone-fixture.mjs'
import { canonicalJson, sha256Hex } from '../../scripts/lib/canonical.mjs'
import { itemDigest, nowItem } from '../../scripts/lib/loop-state.mjs'

// The STATE.md separator and the none dash, built from their code points to keep this file ASCII.
const DOT = String.fromCodePoint(0xb7)
const DASH = String.fromCodePoint(0x2014)
const ID = 'tl-0123abcd'
const HEADER = `- [ ] P1 ${DOT} fix the parser ${DOT} class: hard`
const block = (idLine = `  - id: ${ID}`) => [HEADER, ...(idLine === null ? [] : [idLine]), '  - origin: human', `  - status: ${DASH}`,
  '  - notes: parse every header form', '    and keep the titles'].join('\n')
const state = now => ['# State', '', '## Now', now, '', '## Backlog', '(empty)', '', '## Done', '(empty)', ''].join('\n')
const setState = (fx, now) => fs.writeFileSync(path.join(fx.S, 'STATE.md'), state(now))
const messageOf = (fx, sha) => git(fx.W, ['log', '-1', '--format=%B', sha])

test('prepare records the ## Now item id and digest (v:2), and commit writes the Tech-Lead-Item trailer from the record', T, async t => {
  const fx = project(t)
  setState(fx, block())
  await firing(fx)
  prepare(fx)
  const rec = recordOf(fx)
  assert.equal(rec.v, 2)
  assert.equal(rec.now_sha256, sha256Hex(HEADER), 'now_sha256 stays the header line hash (R3)')
  assert.equal(rec.item_id, ID)
  // R6 over the R5 values: the notes' continuation joined with a newline, the absent decision ''.
  const expected = sha256Hex(canonicalJson({ id: ID, title: 'fix the parser', notes: 'parse every header form\nand keep the titles', decision: '' }))
  assert.equal(rec.item_digest, expected)
  assert.equal(rec.item_digest, itemDigest(nowItem(state(block()))))

  // The record is the binding: an edit of ## Now after prepare does not change the trailer.
  setState(fx, block('  - id: tl-zzzzzzzz'))
  const { commit } = attempt(fx, W => write(W, 'a.txt', 'edited\n'), { subject: 'Fix the parser\nTech-Lead-Item: tl-yyyyyyyy\n' })
  assert.equal(messageOf(fx, commit.sha), `Fix the parser\n\nTech-Lead-Item: ${ID}\nTech-Lead-Generation: ${fx.N}\n`)
  assert.equal(recordOf(fx).item_id, ID, 'commit keeps the recorded item')
})

test('an upper-case id copy is recorded in lower case', T, async t => {
  const fx = project(t)
  setState(fx, block(`  - id: ${ID.toUpperCase()}`))
  await firing(fx)
  prepare(fx)
  assert.equal(recordOf(fx).item_id, ID)
  assert.equal(recordOf(fx).item_digest, itemDigest(nowItem(state(block()))))
})

test('no item to bind: an empty ## Now, an item without an id, an invalid or doubled id, a CRLF file, a Now line that is not the item header -> item null, no trailer', T, async t => {
  const fx = project(t)
  const cases = [
    ['an empty ## Now', state('(empty)'), false],
    ['an item without an id', state(block(null)), true],
    ['an invalid id', state(block('  - id: it-1')), true],
    ['two id lines', state(block(`  - id: ${ID}\n  - id: tl-11111111`)), true],
    ['a CRLF file', state(block()).replace(/\n/g, '\r\n'), true],
    // The Now line (what now_sha256 hashes) is not the item's header: loop-recover would not
    // read this item as the Now item either, so prepare binds none.
    ['an unparsed line above the item', state(`* a stray note\n${block()}`), true],
    ['an indented first line above the item', state(`  - [ ] P1 ${DOT} indented ${DOT} class: hard\n${block()}`), true],
  ]
  for (const [label, text, hasNow] of cases) {
    fs.writeFileSync(path.join(fx.S, 'STATE.md'), text)
    await firing(fx)
    prepare(fx)
    const rec = recordOf(fx)
    assert.equal(rec.v, 2, label)
    assert.equal(rec.item_id, null, label)
    assert.equal(rec.item_digest, null, label)
    assert.equal(rec.now_sha256 === null, !hasNow, `${label}: now_sha256 as before`)
    const { commit } = attempt(fx, W => write(W, 'a.txt', `${label}\n`))
    assert.equal(messageOf(fx, commit.sha), `Do the thing\n\nTech-Lead-Generation: ${fx.N}\n`, label)
  }
})

test('a missing STATE.md records no item and no Now hash', T, async t => {
  const fx = project(t)
  fs.rmSync(path.join(fx.S, 'STATE.md'))
  await firing(fx)
  prepare(fx)
  const rec = recordOf(fx)
  assert.deepEqual([rec.now_sha256, rec.item_id, rec.item_digest], [null, null, null])
})

// The record as a 0.5.0 firing wrote it: v:1, without the item keys.
const toV1 = (fx, g) => {
  const { item_id, item_digest, ...rest } = recordOf(fx, g)
  void item_id, void item_digest
  fs.writeFileSync(path.join(fx.V, 'run', `${g}.json`), `${JSON.stringify({ ...rest, v: 1 })}\n`)
}

test('a v:1 record of an interrupted 0.5.0 commit: the next prepare recovers it and keeps it v:1; the new record is v:2', T, async t => {
  const fx = project(t)
  setState(fx, block())
  await firing(fx)
  prepare(fx)
  check(fx, 'deps')
  write(fx.W, 'a.txt', 'edited\n')
  const c = check(fx, 'dispatch')
  const subj = path.join(fx.root, 'subj')
  fs.writeFileSync(subj, 'Edit a\n')
  killAt(fx, 'commit:after-update-ref', 'commit', fx.P, '--generation', String(fx.N), '--digest', c.digest, '--subject-file', subj)
  const killed = fx.N
  toV1(fx, killed)
  const C = recordOf(fx, killed).intent.commit
  assert.equal(recordOf(fx, killed).v, 1)
  await firing(fx)
  const out = prepare(fx)
  assert.equal(out.head, C, "today's branch keeps the loop's commit")
  const old = recordOf(fx, killed)
  assert.equal(old.v, 1, 'the recovered record stays v:1')
  assert.equal(Object.hasOwn(old, 'item_id') || Object.hasOwn(old, 'item_digest'), false)
  assert.equal(old.phase, 'committed')
  assert.deepEqual(old.commit, { sha: C })
  assert.equal(old.recovery.step, 'done')
  assert.equal(old.recovery.by, fx.N)
  const rec = recordOf(fx, fx.N)
  assert.deepEqual([rec.v, rec.item_id], [2, ID])
  const { commit } = attempt(fx, W => write(W, 'b.txt', 'next\n'))
  assert.equal(tipOf(fx.W), commit.sha)
  assert.equal(messageOf(fx, commit.sha), `Do the thing\n\nTech-Lead-Item: ${ID}\nTech-Lead-Generation: ${fx.N}\n`)
})

test('R33: the clean-clone save of an interrupted v:2 firing carries its item_id and item_digest; a v:1 record gives null', T, async t => {
  for (const v1 of [false, true]) {
    const fx = project(t)
    setState(fx, block())
    await firing(fx)
    prepare(fx)
    check(fx, 'deps')
    write(fx.W, 'a.txt', 'left by the delegate\n')
    const killed = fx.N
    const bound = recordOf(fx, killed)
    if (v1) toV1(fx, killed)
    // The owner edits ## Now meanwhile: the bundle keeps the item the interrupted firing bound.
    setState(fx, block('  - id: tl-zzzzzzzz'))
    await firing(fx)
    const out = prepare(fx)
    assert.equal(out.recovered.length, 1, JSON.stringify(out.recovered))
    const h = headerOf(fx, out.recovered[0].sha)
    assert.equal(h.why, 'clean-clone')
    assert.equal(h.source.generation, killed)
    const want = v1 ? [null, null] : [ID, bound.item_digest]
    assert.deepEqual([h.item_id, h.item_digest], want, v1 ? 'v:1 record' : 'v:2 record')
    if (!v1) assert.equal(bound.item_digest, itemDigest(nowItem(state(block()))))
  }
})
