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

test('meta may carry comments, including parentheses and apostrophes', () => {
  const lit = "{\n  name: 'x', // keep in sync (see docs)\n  description: 'd', /* don't wrap */\n  phases: [   // one entry per phase() call\n    { title: 'A' },\n  ],\n  size: -1.5, deep: { ok: true, none: null, 'quoted.key': [1, 2e3] },\n}"
  const { meta } = parseMeta(wf(lit))
  assert.equal(meta.phases[0].title, 'A'); assert.equal(meta.size, -1.5); assert.deepEqual(meta.deep['quoted.key'], [1, 2000])
})

for (const [label, lit] of [
  ['string concatenation', "{ name: 'x', description: 'long ' + 'text' }"],
  ['an IIFE', "{ name: 'x', description: (() => 'd')() }"],
  ['an indirect eval', `{ name: 'x', description: (0, eval)('"d"') }`],
  ['new without parentheses', "{ name: 'x', description: 'd', at: new Date }"],
  ['a bare global', "{ name: 'x', description: 'd', env: process }"],
  ['undefined', "{ name: 'x', description: 'd', v: undefined }"],
  ['an arrow function', "{ name: 'x', description: 'd', f: () => 1 }"],
  ['a property read on a literal', "{ name: 'x', description: 'd', n: [1, 2].length }"],
  ['a call hidden after an apostrophe in a comment', "{ name: 'x', // don't\n  description: String(1), // it's\n}"],
]) {
  test(`rejects meta with ${label}`, () => {
    assert.throws(() => parseMeta(wf(lit)), /pure literal/)
  })
}

test('host APIs the live runtime lacks throw in a workflow body', async () => {
  for (const expr of ['process.env.HOME', 'Buffer.from("x")', 'crypto.randomUUID()', 'performance.now()', 'globalThis.Date.now()',
    'await new Promise(r => setTimeout(r, 1))', 'fetch("https://example.com")', 'require("fs")']) {
    const w = loadWorkflowSource(wf(META, `return ${expr}`))
    await assert.rejects(w.run({}), /unavailable in Workflow scripts/, expr)
  }
})

test('the body runs in strict mode: no implicit globals, no global this', async () => {
  await assert.rejects(loadWorkflowSource(wf(META, 'reuslt = 5\nreturn 1')).run({}), ReferenceError)
  assert.equal((await loadWorkflowSource(wf(META, 'return this')).run({})).result, undefined)
})

test('agent() rejects a schema the live runtime refuses', async () => {
  const body = s => wf(META, `return agent('p', { schema: ${s} })`)
  const ok = loadWorkflowSource(body("{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }"))
  assert.equal((await ok.run({}, () => 7)).result, 7)
  for (const s of ["{ type: 'array', items: {} }", "{ type: 'object' }", "{ type: 'object', properties: { a: {} }, required: ['a', 'b'] }"]) {
    await assert.rejects(loadWorkflowSource(body(s)).run({}, () => 7), /schema/, s)
  }
})

test('dynamic import() fails in a workflow body', async () => {
  const w = loadWorkflowSource(wf(META, "const fs = await import('node:fs')\nreturn typeof fs.readFileSync"))
  await assert.rejects(w.run({}), /dynamic import/)
})
