// tests/lib/workflow-loader.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadWorkflowSource, parseMeta } from '../../scripts/lib/workflow-loader.mjs'

const META = "{ name: 'x', description: 'd' }"
const wf = (meta, body = 'return args') => `export const meta = ${meta}\n${body}\n`

test('loads meta and runs the body with args and agent()', async () => {
  const w = loadWorkflowSource(wf(META, 'const v = await agent("p", { label: "l" })\nreturn { v, a: args.a }'))
  assert.equal(w.meta.name, 'x')
  const { result, calls } = await w.run({ a: 1 }, () => 42)
  assert.deepEqual(result, { v: 42, a: 1 })
  assert.equal(calls[0].opts.label, 'l')
})

test('accepts braces and parentheses inside meta strings', () => {
  const { meta } = parseMeta(wf("{ name: 'x', description: 'args: {repo, tasks:[{id}]} (see docs', whenToUse: 'use { alone' }"))
  assert.equal(meta.whenToUse, 'use { alone')
})

for (const [label, lit] of [
  ['a template literal', '{ name: `x`, description: "d" }'],
  ['a spread', '{ ...base, name: "x", description: "d" }'],
  ['a call', '{ name: String(1), description: "d" }'],
  ['an identifier reference', '{ name: NAME, description: "d" }'],
  ['a member access', '{ name: "x", description: Math.PI }'],
]) {
  test(`rejects meta with ${label}`, () => {
    assert.throws(() => parseMeta(wf(lit)), /pure literal/)
  })
}

test('requires name and description', () => {
  assert.throws(() => parseMeta(wf("{ name: 'x' }")), /meta\.description is required/)
})

test('requires meta to be the first statement', () => {
  assert.throws(() => parseMeta(`const x = 1\n${wf(META)}`), /first statement/)
})

test('allows comments before meta', () => {
  assert.equal(parseMeta(`// header\n/* block */\n${wf(META)}`).meta.name, 'x')
})

test('reports a syntax error in the body at load time', () => {
  assert.throws(() => loadWorkflowSource(wf(META, 'return {')), SyntaxError)
})

test('Date.now, Math.random and new Date() throw as in the live runtime', async () => {
  for (const body of ['return Date.now()', 'return Math.random()', 'return new Date()']) {
    const w = loadWorkflowSource(wf(META, body))
    await assert.rejects(w.run({}), /unavailable in Workflow scripts/)
  }
  const ok = loadWorkflowSource(wf(META, 'return new Date(0).getTime() + Math.max(1, 2)'))
  assert.equal((await ok.run({})).result, 2)
})

test('parallel turns a throwing thunk into null', async () => {
  const w = loadWorkflowSource(wf(META, 'return parallel([() => 1, () => { throw new Error("x") }])'))
  assert.deepEqual((await w.run({})).result, [1, null])
})

test('pipeline passes (prev, item, index) and drops an item whose stage throws', async () => {
  const body = 'return pipeline([1, 2, 3], x => x * 10, (prev, item, i) => { if (item === 2) throw new Error("x"); return [prev, item, i] })'
  const w = loadWorkflowSource(wf(META, body))
  assert.deepEqual((await w.run({})).result, [[10, 1, 0], null, [30, 3, 2]])
})
