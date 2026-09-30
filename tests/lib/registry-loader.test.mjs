// tests/lib/registry-loader.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractBlock, evaluateLiteral } from '../../scripts/lib/registry-loader.mjs'

const lines = (...parts) => parts.join('\n')

test('returns null when no block exists and it is optional', () => {
  assert.equal(extractBlock('const a = 1', 'REGISTRY'), null)
})

test('throws when a required block is missing', () => {
  assert.throws(() => extractBlock('const a = 1', 'REGISTRY', { required: true }), /missing/)
})

test('extracts the text between the marker lines', () => {
  const src = lines('const R =', '  // REGISTRY-BEGIN', "{ 'loop.class': { rubricVersion: 1 } }", '  // REGISTRY-END', 'return R')
  assert.equal(extractBlock(src, 'REGISTRY'), "{ 'loop.class': { rubricVersion: 1 } }")
})

test('rejects two blocks', () => {
  const src = lines('// REGISTRY-BEGIN', '{}', '// REGISTRY-END', '// REGISTRY-BEGIN', '{}', '// REGISTRY-END')
  assert.throws(() => extractBlock(src, 'REGISTRY'), /exactly one/)
})

test('rejects an unterminated block', () => {
  assert.throws(() => extractBlock(lines('// REGISTRY-BEGIN', '{}'), 'REGISTRY'), /exactly one/)
})

test('rejects END before BEGIN', () => {
  assert.throws(() => extractBlock(lines('// REGISTRY-END', '{}', '// REGISTRY-BEGIN'), 'REGISTRY'), /before BEGIN/)
})

test('ignores marker text that is not alone on its line', () => {
  const src = lines("const note = '// REGISTRY-BEGIN'", '// REGISTRY-BEGIN', '{ a: 1 }', '// REGISTRY-END')
  assert.equal(extractBlock(src, 'REGISTRY'), '{ a: 1 }')
})

test('evaluates a literal with injected helpers and regex literals', () => {
  const noul = (text, criteria) => ({ kind: 'noul', text, criteria })
  const reg = evaluateLiteral("{ 'loop.class': { q: noul('Touches auth?', { yes: 'y', no: 'n' }), re: /auth/ } };", { noul })
  assert.equal(reg['loop.class'].q.kind, 'noul')
  assert.ok(reg['loop.class'].re.test('auth'))
})

test('reports a syntax error in the literal', () => {
  assert.throws(() => evaluateLiteral('{ a: }'), SyntaxError)
})
