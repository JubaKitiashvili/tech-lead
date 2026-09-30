// tests/lib/js-scan.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchBrace } from '../../scripts/lib/js-scan.mjs'

test('matches a flat object', () => {
  const s = 'x = { a: 1 } rest'
  assert.equal(s.slice(4, matchBrace(s, 4)), '{ a: 1 }')
})

test('matches nested objects and arrays', () => {
  const s = '{ a: { b: [ { c: 1 } ] } }!'
  assert.equal(s[matchBrace(s, 0)], '!')
})

test('ignores braces inside quoted strings, including escaped quotes', () => {
  const s = `{ a: '}', b: "{", c: 'it\\'s }' }#`
  assert.equal(s[matchBrace(s, 0)], '#')
})

test('ignores braces inside comments', () => {
  const s = '{ // }\n a: 1 /* } */ }#'
  assert.equal(s[matchBrace(s, 0)], '#')
})

test('skips template literals and their ${} expressions', () => {
  const s = '{ a: `x ${ {b: 1}.b } }` }#'
  assert.equal(s[matchBrace(s, 0)], '#')
})

test('throws when the brace never closes', () => {
  assert.throws(() => matchBrace('{ a: 1', 0), /no closing brace/)
})

test('throws when not pointed at a brace', () => {
  assert.throws(() => matchBrace('x', 0), /expected/)
})
