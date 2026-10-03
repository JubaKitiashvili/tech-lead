// tests/lib/loop-md.test.mjs
// LOOP.md front-matter block lists (stage 0c-2 brief section 5): frontList(text, key) is
// stage 0c-1's verify: grammar for any key, and loop-lock's verifyCommands is
// frontList(text, 'verify') with the same messages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { frontList } from '../../scripts/lib/loop-md.mjs'
import { verifyCommands } from '../../scripts/loop-lock.mjs'

const md = body => `---\n${body}---\n`
// The exact message frontList throws for text, or null when it returns.
const messageOf = (text, key) => {
  try {
    frontList(text, key)
    return null
  } catch (e) {
    return e.message
  }
}

test('frontList reads the block list under any top-level key, with comments, quotes and blank lines, and stops at the next key', () => {
  const text = md([
    'level: 2',
    'verify:',
    '  - npm test   # the unit tests',
    "  - 'printf ''%s'' a'",
    '',
    '    # a note',
    '  - "echo \\"q\\" && true"',
    'scope:',
    '  - src',
    '  - ./docs/',
    "  - 'odd: name'",
    '  - "a#b"',
    '  - c#d',
    'base: main',
  ].join('\n') + '\n')
  assert.deepEqual(frontList(text, 'verify'), ['npm test', "printf '%s' a", 'echo "q" && true'])
  assert.deepEqual(frontList(text, 'scope'), ['src', './docs/', 'odd: name', 'a#b', 'c#d'])
  assert.deepEqual(frontList(md('scope:\n- a\n- b\n'), 'scope'), ['a', 'b'])
  assert.deepEqual(frontList(md('scope:\n'), 'scope'), [])
  assert.deepEqual(frontList(md('scope:   # nothing yet\nverify:\n  - x\n'), 'scope'), [])
  // CRLF line ends read the same.
  assert.deepEqual(frontList('---\r\nscope:\r\n  - src\r\n---\r\n', 'scope'), ['src'])
  // The key is matched whole: scopes: is another key.
  assert.equal(messageOf(md('scopes:\n  - x\n'), 'scope'), 'no-scope: the front matter has no scope: key')
  // A key that would not be a plain YAML key is a caller bug, never matched as a pattern.
  for (const key of ['', 'a.b', 'a b', '.*', 'verify:', 7, undefined]) {
    assert.throws(() => frontList(md('verify:\n  - x\n'), key), /^TypeError: frontList: bad key/, String(key))
  }
})

// Every refusal with its exact message, for a key and its item noun.
const refusals = (key, noun) => [
  ['no front matter', `${key}:\n  - x\n`, 'bad-loop-md: LOOP.md has no front matter'],
  ['unterminated front matter', `---\n${key}:\n  - x\n`, 'bad-loop-md: the front matter is not closed'],
  ['no key', md('level: 1\n'), `no-${key}: the front matter has no ${key}: key`],
  ['key below the front matter', `---\nlevel: 1\n---\n${key}:\n  - x\n`, `no-${key}: the front matter has no ${key}: key`],
  ['key twice', md(`${key}:\n  - a\n${key}:\n  - b\n`), `bad-${key}: ${key}: appears 2 times`],
  ['flow sequence', md(`${key}: [a, b]\n`), `bad-${key}: line 2: ${key}: must be a block list of "  - <${noun}>" lines`],
  ['scalar value', md(`${key}: a\n`), `bad-${key}: line 2: ${key}: must be a block list of "  - <${noun}>" lines`],
  ['more-indented dash', md(`${key}:\n  - a\n    - b\n`), `bad-${key}: unsupported ${key}: syntax at line 4 (a "- " more indented than the items above it)`],
  ['less-indented dash', md(`${key}:\n    - a\n  - b\n`), `bad-${key}: unsupported ${key}: syntax at line 4 (a "- " less indented than the items above it)`],
  ['continuation line', md(`${key}:\n  - a\n    b\n`), `bad-${key}: unsupported ${key}: syntax at line 4 (a continuation line or other text inside the list)`],
  ['column-0 text', md(`${key}:\n  - a\nrm -rf x\n`), `bad-${key}: unsupported ${key}: syntax at line 4 (a line that is neither an item nor a key)`],
  ['tab before the dash', md(`${key}:\n\t- a\n`), `bad-${key}: unsupported ${key}: syntax at line 3 (a continuation line or other text inside the list)`],
  ['unterminated double quote', md(`${key}:\n  - "a\n`), `bad-${key}: line 3: unterminated double-quoted ${noun}`],
  ['unterminated single quote', md(`${key}:\n  - 'a\n`), `bad-${key}: line 3: unterminated single-quoted ${noun}`],
  ['text after a double quote', md(`${key}:\n  - "a" b\n`), `bad-${key}: line 3: text after the closing quote`],
  ['text after a single quote', md(`${key}:\n  - 'a' b\n`), `bad-${key}: line 3: text after the closing quote`],
  ['yaml-only escape', md(`${key}:\n  - "a \\x41"\n`), `bad-${key}: line 3: an escape JSON does not share with YAML; use single quotes`],
  ['indicator first', md(`${key}:\n  - - a\n`), `bad-${key}: line 3: a YAML indicator starts the ${noun}; quote it`],
  ['flow indicator first', md(`${key}:\n  - [a]\n`), `bad-${key}: line 3: a YAML indicator starts the ${noun}; quote it`],
  ['mapping item', md(`${key}:\n  - run: a\n`), `bad-${key}: line 3: ": " makes the item a mapping; quote the ${noun}`],
  ['empty item', md(`${key}:\n  -\n`), `bad-${key}: line 3: empty ${noun}`],
  ['comment-only item', md(`${key}:\n  - # nothing\n`), `bad-${key}: line 3: empty ${noun}`],
  ['blank quoted item', md(`${key}:\n  - "  "\n`), `bad-${key}: line 3: empty ${noun}`],
  ['blank single-quoted item', md(`${key}:\n  - ''\n`), `bad-${key}: line 3: empty ${noun}`],
]

test('frontList(text, "verify") refuses every other shape with stage 0c-1\'s exact messages, and verifyCommands is the same function of the text', () => {
  for (const [why, text, message] of refusals('verify', 'command')) {
    assert.equal(messageOf(text, 'verify'), message, why)
    assert.throws(() => verifyCommands(text), err => err.message === message, `verifyCommands: ${why}`)
  }
  for (const text of [md('verify:\n  - npm test\n  - "make lint"\n'), md('verify:\n'), md('scope:\n  - a\nverify:\n- x # y\n')]) {
    assert.deepEqual(verifyCommands(text), frontList(text, 'verify'))
  }
})

test('frontList for another key names that key in every message and calls its items entries', () => {
  for (const [why, text, message] of refusals('scope', 'entry')) {
    assert.equal(messageOf(text, 'scope'), message, why)
  }
  // A malformed verify: list does not affect reading scope:, and the reverse.
  const text = md('verify: npm test\nscope:\n  - src\n')
  assert.deepEqual(frontList(text, 'scope'), ['src'])
  assert.equal(messageOf(text, 'verify'), 'bad-verify: line 2: verify: must be a block list of "  - <command>" lines')
})
