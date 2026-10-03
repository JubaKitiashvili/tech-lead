// tests/lib/canonical.test.mjs
// Canonical JSON and SHA-256 (stage 0c-2 brief section 4): the one spelling every digest,
// bundle header and record hash is computed over.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { canonicalJson, sha256Hex } from '../../scripts/lib/canonical.mjs'

test('canonicalJson sorts object keys at every depth, keeps array order and writes no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 1, 2], c: { z: null, y: true, x: 'v' } }), '{"a":[3,1,2],"b":1,"c":{"x":"v","y":true,"z":null}}')
  // Insertion order never shows: two objects with the same entries have one spelling.
  const one = {}, two = {}
  for (const k of ['m', 'a', 'z', 'b']) one[k] = k
  for (const k of ['b', 'z', 'a', 'm']) two[k] = k
  assert.equal(canonicalJson(one), canonicalJson(two))
  // Keys sort by UTF-16 code unit, as Array.prototype.sort does: upper case before lower,
  // digits before letters, a prefix before its extensions; integer-like keys sort as strings.
  assert.equal(canonicalJson({ b: 0, B: 0, 10: 0, 9: 0, a: 0, ab: 0, '': 0 }), '{"":0,"10":0,"9":0,"B":0,"a":0,"ab":0,"b":0}')
  const hi = String.fromCharCode(0xe9), astral = String.fromCodePoint(0x1f600)
  assert.equal(canonicalJson({ [astral]: 1, [hi]: 2, z: 3 }), `{"z":3,"${hi}":2,"${astral}":1}`)
})

test('canonicalJson writes scalars as JSON.stringify does: strings escaped, non-ASCII text kept, safe integers only', () => {
  for (const v of [null, true, false, 0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, '', 'a "q" \\ /', `tab\tnl\n${String.fromCharCode(1)}`]) {
    assert.equal(canonicalJson(v), JSON.stringify(v), JSON.stringify(v))
  }
  // Negative zero is the integer zero.
  assert.equal(canonicalJson(-0), '0')
  assert.equal(canonicalJson([]), '[]')
  assert.equal(canonicalJson({}), '{}')
  const geo = String.fromCharCode(0x10d0, 0x10d1)
  assert.equal(canonicalJson({ path: `src/${geo}.txt` }), `{"path":"src/${geo}.txt"}`)
  // An object with no prototype is a plain object too.
  const bare = Object.create(null)
  bare.k = 1
  assert.equal(canonicalJson(bare), '{"k":1}')
  // The output parses back to an equal value.
  const v = { files: [{ path: 'a b', size: 12, binary: false, oid: null }], v: 1 }
  assert.deepEqual(JSON.parse(canonicalJson(v)), v)
})

test('canonicalJson refuses every value outside its grammar with not-canonical and the place it found it', () => {
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  const holey = [1, , 3] // eslint-disable-line no-sparse-arrays
  const sym = { a: 1, [Symbol('s')]: 2 }
  class Thing { constructor() { this.a = 1 } }
  const lone = String.fromCharCode(0xd800)
  const refused = [
    [1.5, /^not-canonical: \$ is 1\.5, not a safe integer$/],
    [Number.MAX_SAFE_INTEGER + 1, /not a safe integer/],
    [NaN, /not a safe integer/],
    [Infinity, /not a safe integer/],
    [10n, /^not-canonical: \$ is a bigint$/],
    [undefined, /^not-canonical: \$ is undefined$/],
    [() => 1, /^not-canonical: \$ is a function$/],
    [Symbol('x'), /^not-canonical: \$ is a symbol$/],
    [new Date(0), /^not-canonical: \$ is a Date, not a plain object$/],
    [new Map(), /^not-canonical: \$ is a Map, not a plain object$/],
    [Buffer.from('x'), /not a plain object/],
    [new Thing(), /^not-canonical: \$ is a Thing, not a plain object$/],
    [new String('x'), /not a plain object/],
    [{ a: { b: [1, 2.5] } }, /^not-canonical: \$\.a\.b\[1\] is 2\.5, not a safe integer$/],
    [{ a: undefined }, /^not-canonical: \$\.a is undefined$/],
    [{ 'odd key': [undefined] }, /^not-canonical: \$\["odd key"\]\[0\] is undefined$/],
    [cyclic, /^not-canonical: \$\.self is a cycle$/],
    [holey, /^not-canonical: \$\[1\] is a hole in an array$/],
    [sym, /^not-canonical: \$ has a symbol key$/],
    [lone, /^not-canonical: \$ is a string that is not well-formed Unicode$/],
    [{ [lone]: 1 }, /^not-canonical: \$ has a key that is not well-formed Unicode$/],
  ]
  for (const [value, re] of refused) {
    assert.throws(() => canonicalJson(value), err => err instanceof Error && re.test(err.message), String(re))
  }
  // A value seen twice without a cycle is fine.
  const shared = { x: 1 }
  assert.equal(canonicalJson({ a: shared, b: [shared] }), '{"a":{"x":1},"b":[{"x":1}]}')
})

test('sha256Hex hashes a string as its UTF-8 bytes and a Buffer as given', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const geo = String.fromCharCode(0x10d0)
  assert.equal(sha256Hex(geo), sha256Hex(Buffer.from(geo, 'utf8')))
  const bytes = Buffer.from([0, 255, 128, 10])
  assert.equal(sha256Hex(bytes), crypto.createHash('sha256').update(bytes).digest('hex'))
  assert.equal(sha256Hex(new Uint8Array(bytes)), sha256Hex(bytes))
  assert.match(sha256Hex(canonicalJson({ a: 1 })), /^[0-9a-f]{64}$/)
  for (const bad of [undefined, null, 1, {}, ['a']]) {
    assert.throws(() => sha256Hex(bad), /^TypeError: sha256Hex: data must be a Buffer or a string/, String(bad))
  }
})
