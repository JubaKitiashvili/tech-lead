// tests/loop/reflex-bundle-item.test.mjs
// The item fields of a recovery bundle (stage 0c-3 brief, ruling R18): `save --item <id>` reads
// <S>/STATE.md through scripts/lib/loop-state.mjs, needs exactly one item carrying the id (any
// section, eligibility aside) and writes item_id and itemDigest(item) into the header; no
// carrier, or several, refuse bad-item with nothing written. On save, --item-digest is accepted
// only with --item and must equal the computed digest. The header check reads item_id as an id
// or null, and item_id and item_digest as both set or both null. Real repositories and processes
// through the shared fixture (reflex-bundle-fixture.mjs, which imports tests/helpers.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  T, bundles, cli, fixture, header, patchFile, recordOf, run, save, sha256, temps, write,
} from './reflex-bundle-fixture.mjs'
import { readBundle, saveFor, verifyBundle } from '../../scripts/reflex-bundle.mjs'
import { canonicalJson } from '../../scripts/lib/canonical.mjs'
import { baseRules } from '../../scripts/lib/changes.mjs'
import { itemDigest, parseState } from '../../scripts/lib/loop-state.mjs'
import { A, B, C, blockedItem, doneItem, open, state } from '../lib/loop-state-fixture.mjs'

const N_ = f => String(f.N)
const FILES = { 'a.txt': 'a\n', 'b.txt': 'b\n' }

// A STATE.md with an item in each item section: A in Now, B in Blocked (a title blocker, so
// not eligible), C in Done.
const STATE = state({
  now: open('Ship the queue', { id: A, notes: 'use redis', decision: 'keep it small' }),
  blocked: blockedItem('Fix the flaky test', { id: B, blockedBy: 'Ship the queue' }),
  done: doneItem('Write the docs', { id: C }),
})

const digestOf = (text, id) => itemDigest(parseState(text).items.find(i => i.id === id))
const putState = (f, text) => fs.writeFileSync(path.join(f.S, 'STATE.md'), text)

// What a refused save must leave as it was: the bundle store and the run record.
const store = f => {
  let names = []
  try { names = fs.readdirSync(path.join(f.V, 'patches')).sort() } catch { /* none yet */ }
  return { names, record: recordOf(f) }
}

test('save --item writes item_id and the item digest into the header; verify reports them', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  write(f.W, 'a.txt', 'edited\n')
  const D = digestOf(STATE, A)
  const r = save(f, 'pause', ['--item', A])
  assert.equal(r.state, 'saved', JSON.stringify(r))
  assert.equal(r.item_id, A)
  assert.equal(r.item_digest, D)
  const h = header(f, r.sha)
  assert.equal(h.item_id, A)
  assert.equal(h.item_digest, D)
  assert.deepEqual(recordOf(f).saves, [{ sha: r.sha, why: 'pause' }])
  const v = run(f.env, 0, 'verify', f.P, '--sha', r.sha)
  assert.equal(v.item_id, A)
  assert.equal(v.item_digest, D)
  assert.deepEqual(readBundle(f.paths, r.sha).header, h)
})

test('save --item takes the one carrier in any section, eligible or not, and an upper-case copy of the id', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  write(f.W, 'a.txt', 'one\n')
  const blocked = save(f, 'pause', ['--item', B])
  assert.equal(blocked.state, 'saved', JSON.stringify(blocked))
  assert.equal(header(f, blocked.sha).item_digest, digestOf(STATE, B))
  write(f.W, 'a.txt', 'two\n')
  const done = save(f, 'pause', ['--item', C])
  assert.equal(header(f, done.sha).item_id, C)
  assert.equal(header(f, done.sha).item_digest, digestOf(STATE, C))
  // A person copied the id in upper case: it is the same id (R2), and the digest uses its
  // lowercase form.
  const upper = STATE.replace(`id: ${A}`, `id: ${A.toUpperCase()}`)
  putState(f, upper)
  write(f.W, 'a.txt', 'three\n')
  const now = save(f, 'pause', ['--item', A])
  assert.equal(now.item_id, A)
  assert.equal(now.item_digest, digestOf(STATE, A))
})

test('save --item with --item-digest: equal saves, different refuses digest-mismatch with nothing written', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  write(f.W, 'a.txt', 'edited\n')
  const D = digestOf(STATE, A)
  const before = store(f)
  const bad = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause', '--item', A, '--item-digest', 'e'.repeat(64))
  assert.equal(bad.state, 'digest-mismatch')
  assert.match(bad.detail, new RegExp(D))
  assert.deepEqual(store(f), before, 'no bundle, no rules file, no record change')
  assert.deepEqual(temps(f), [])
  const ok = run(f.env, 0, 'save', f.P, '--generation', N_(f), '--why', 'pause', '--item', A, '--item-digest', D)
  assert.equal(ok.state, 'saved')
  assert.equal(header(f, ok.sha).item_digest, D)
})

test('save --item refuses bad-item, writing nothing, when no item or several carry the id', T, async t => {
  const f = await fixture(t, FILES)
  write(f.W, 'a.txt', 'edited\n')
  const expectBad = (text, id, why) => {
    if (text === null) fs.rmSync(path.join(f.S, 'STATE.md'), { force: true })
    else putState(f, text)
    const before = store(f)
    const r = run(f.env, 3, 'save', f.P, '--generation', N_(f), '--why', 'pause', '--item', id)
    assert.equal(r.state, 'bad-item', `${why}: ${JSON.stringify(r)}`)
    assert.equal(typeof r.detail, 'string')
    assert.deepEqual(store(f), before, `${why}: nothing written`)
    assert.deepEqual(temps(f), [])
    return r
  }
  expectBad(STATE, 'tl-zzzzzzzz', 'no carrier')
  // The same id in the Backlog and in Done: two carriers (duplicate-id).
  const twice = state({
    backlog: open('Ship the queue', { id: A }),
    done: doneItem('Ship the queue v0', { id: A }),
  })
  assert.equal(expectBad(twice, A, 'two carriers').carriers, 2)
  // An item with two id lines is invalid-id: it carries the id, but not as its one id.
  const doubled = state({ backlog: open('Ship the queue', { id: A, extra: [`  - id: ${B}`] }) })
  expectBad(doubled, A, 'an invalid-id carrier')
  expectBad(doubled, B, 'an invalid-id carrier, second line')
  // A malformed id line naming the id is no carrier either.
  expectBad(state({ backlog: open('Ship the queue', { id: `${A} extra` }) }), A, 'a malformed id value')
  expectBad(null, A, 'no STATE.md')
  expectBad(STATE.replace(/\n/g, '\r\n'), A, 'a STATE.md with carriage returns')
  // An empty save is refused the same way: the item is checked before anything is collected.
  fs.writeFileSync(path.join(f.W, 'a.txt'), 'a\n')
  expectBad(STATE, 'tl-zzzzzzzz', 'no carrier, nothing changed')
})

test('an empty save --item reports the item id and digest for the Recovery line', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  const r = save(f, 'pause', ['--item', A])
  assert.equal(r.state, 'empty', JSON.stringify(r))
  assert.equal(r.item_id, A)
  assert.equal(r.item_digest, digestOf(STATE, A))
  const plain = save(f, 'pause')
  assert.equal(plain.state, 'empty')
  assert.equal(plain.item_id, null)
  assert.equal(plain.item_digest, null)
})

test('usage errors: --item-digest on save without --item, an --item that is not an id, --item on other commands', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  write(f.W, 'a.txt', 'edited\n')
  const D = digestOf(STATE, A)
  const before = store(f)
  const sha = 'f'.repeat(64)
  for (const args of [
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item-digest', D],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item', 'Ship the queue'],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item', A.toUpperCase()],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item', 'tl-iiiiiiii'],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item', A, '--item', A],
    ['save', f.P, '--generation', N_(f), '--why', 'pause', '--item'],
    ['apply', f.P, '--generation', N_(f), '--sha', sha, '--item', A],
    ['reset', f.P, '--generation', N_(f), '--sha', sha, '--item', A],
    ['verify', f.P, '--sha', sha, '--item', A],
  ]) {
    const r = run(f.env, 2, ...args)
    assert.equal(r.state, 'error', args.join(' '))
    assert.match(r.detail, /^usage: .*--item <id>/)
  }
  assert.deepEqual(store(f), before, 'a usage error writes nothing')
})

test('saveFor takes itemId and itemDigest together or neither', T, async t => {
  const f = await fixture(t, FILES, { record: false })
  write(f.W, 'a.txt', 'left over\n')
  const D = 'd'.repeat(64)
  const base = { saver: f.N, source: null, base: f.base, rules: baseRules(f.wt, f.base), why: 'clean-clone', env: f.env }
  assert.throws(() => saveFor(f.paths, { ...base, itemDigest: D }), TypeError)
  assert.throws(() => saveFor(f.paths, { ...base, itemId: A }), TypeError)
  assert.throws(() => saveFor(f.paths, { ...base, itemId: 'TL-AAAAAAAA', itemDigest: D }), TypeError)
  assert.throws(() => saveFor(f.paths, { ...base, itemId: 'Ship the queue', itemDigest: D }), TypeError)
  assert.deepEqual(bundles(f), [], 'a TypeError writes nothing')
  const r = saveFor(f.paths, { ...base, itemId: A, itemDigest: D })
  assert.equal(r.state, 'saved')
  assert.equal(r.item_id, A)
  assert.deepEqual([header(f, r.sha).item_id, header(f, r.sha).item_digest], [A, D])
  const none = saveFor(f.paths, { ...base })
  assert.notEqual(none.sha, r.sha, 'the item fields are part of the bundle')
  assert.equal(none.item_id, null)
  assert.deepEqual([header(f, none.sha).item_id, header(f, none.sha).item_digest], [null, null])
})

test('the header check: item_id is an id or null, and item_id and item_digest are both set or both null', T, async t => {
  const f = await fixture(t, FILES)
  putState(f, STATE)
  write(f.W, 'a.txt', 'edited\n')
  const s = save(f, 'pause', ['--item', A])
  const text = fs.readFileSync(patchFile(f, s.sha))
  const nl = text.indexOf(0x0a)
  const h = JSON.parse(text.subarray('TECH-LEAD-RECOVERY v1 '.length, nl).toString('utf8'))
  // A bundle file whose header is h with `change` applied, stored under its own sha.
  const forge = change => {
    const bytes = Buffer.concat([Buffer.from(`TECH-LEAD-RECOVERY v1 ${canonicalJson({ ...h, ...change })}`), text.subarray(nl)])
    const sha = sha256(bytes)
    if (!fs.existsSync(patchFile(f, sha))) fs.writeFileSync(patchFile(f, sha), bytes)
    return sha
  }
  assert.equal(readBundle(f.paths, forge({})).sha, s.sha, 'an unchanged header reads')
  for (const [change, why] of [
    [{ item_id: 'Ship the queue' }, /item_id/],
    [{ item_id: A.toUpperCase() }, /item_id/],
    [{ item_id: 7 }, /item_id/],
    [{ item_id: null }, /item_id and item_digest/],
    [{ item_digest: null }, /item_id and item_digest/],
  ]) {
    const sha = forge(change)
    assert.throws(() => readBundle(f.paths, sha), e => e.code === 'REFUSED' && e.state === 'tampered' && why.test(e.detail), JSON.stringify(change))
    const v = run(f.env, 3, 'verify', f.P, '--sha', sha)
    assert.equal(v.state, 'tampered')
  }
  // Both null is a bundle saved without --item.
  const both = forge({ item_id: null, item_digest: null })
  assert.equal(verifyBundle(f.paths, both, { env: f.env }).header.item_id, null)
  assert.equal(cli(f.env, 'verify', f.P, '--sha', both).status, 0)
})
