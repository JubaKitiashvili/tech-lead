// scripts/lib/workflow-loader.mjs
// Loads a Workflow script (workflows/*.js) into a stub of Claude Code's Workflow
// runtime, so checks and tests can compile it and run it with scripted agent() results.
import fs from 'node:fs'
import vm from 'node:vm'
import { matchBrace, skipString } from './js-scan.mjs'

const META_RE = /^export const meta = /m

// The literal with comments removed and every '…' or "…" string emptied to "".
// Template literals are refused.
function codeOnly(lit, file) {
  let out = ''
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i]
    if (c === '/' && lit[i + 1] === '/') {
      const nl = lit.indexOf('\n', i)
      i = (nl === -1 ? lit.length : nl) - 1
      out += ' '
      continue
    }
    if (c === '/' && lit[i + 1] === '*') {
      const end = lit.indexOf('*/', i + 2)
      if (end === -1) throw new Error(`${file}: meta is not a pure literal (unterminated comment)`)
      i = end + 1
      out += ' '
      continue
    }
    if (c === '`') throw new Error(`${file}: meta is not a pure literal (template literal)`)
    if (c === '"' || c === "'") {
      i = skipString(lit, i)
      out += '""'
      continue
    }
    out += c
  }
  return out
}

// What a pure literal may contain once codeOnly has run: punctuation, emptied strings,
// numbers, true/false/null, and identifiers used as keys. Anything else (a variable,
// a call, an operator, a spread) is not a literal.
const PURE_TOKEN = /\s+|[{}[\],:]|""|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|(?:true|false|null)\b|[A-Za-z_$][\w$]*(?=\s*:)/y

function assertPure(code, file) {
  PURE_TOKEN.lastIndex = 0
  while (PURE_TOKEN.lastIndex < code.length) {
    const at = PURE_TOKEN.lastIndex
    if (!PURE_TOKEN.test(code)) throw new Error(`${file}: meta is not a pure literal (unexpected ${JSON.stringify(code.slice(at, at + 12))})`)
  }
}

// Host APIs the live runtime does not provide. A workflow body that touches one fails live,
// so it throws here too.
const HOST_APIS = ['process', 'Buffer', 'require', 'module', 'global', 'globalThis', 'crypto', 'performance',
  'setTimeout', 'setInterval', 'setImmediate', 'fetch']
const hostStub = name => {
  const unavailable = () => { throw new Error(`${name} is unavailable in Workflow scripts`) }
  return new Proxy(function () {}, { get: unavailable, apply: unavailable, construct: unavailable })
}

// The live runtime refuses these schemas at agent().
function checkSchema(schema) {
  const props = schema && schema.properties
  if (!schema || schema.type !== 'object' || !props || typeof props !== 'object' || Array.isArray(props)) {
    throw new Error("agent(): schema needs { type: 'object', properties } at its root")
  }
  const missing = (schema.required || []).filter(k => !Object.hasOwn(props, k))
  if (missing.length) throw new Error(`agent(): schema requires ${missing.join(', ')}, which its properties do not define`)
}

export function parseMeta(src, file = '<workflow>') {
  const m = src.match(META_RE)
  if (!m) throw new Error(`${file}: must start with export const meta`)
  const before = src.slice(0, m.index).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()
  if (before) throw new Error(`${file}: export const meta must be the first statement`)
  const litStart = m.index + m[0].length
  if (src[litStart] !== '{') throw new Error(`${file}: meta is not a pure literal (not an object)`)
  const litEnd = matchBrace(src, litStart)
  const lit = src.slice(litStart, litEnd)
  assertPure(codeOnly(lit, file), file)
  let meta
  try {
    meta = new Function(`"use strict"; return (${lit})`)()
  } catch (e) {
    throw new Error(`${file}: meta is not a pure literal (${e.message})`)
  }
  for (const key of ['name', 'description']) {
    if (typeof meta[key] !== 'string' || !meta[key]) throw new Error(`${file}: meta.${key} is required`)
  }
  return { meta, metaStart: m.index, litStart, litEnd }
}

export function loadWorkflowSource(src, file = '<workflow>') {
  const { meta, metaStart, litStart } = parseMeta(src, file)
  const body = src.slice(0, metaStart) + 'const meta = ' + src.slice(litStart)
  const unavailable = () => {
    throw new Error('Date.now(), Math.random() and new Date() are unavailable in Workflow scripts')
  }
  class StubDate extends Date {
    constructor(...a) {
      if (a.length === 0) unavailable()
      super(...a)
    }
    static now() { unavailable() }
  }
  const StubMath = Object.create(Math)
  StubMath.random = unavailable
  // Strict, so an implicit global throws and `this` is not the host's global object. Compiled
  // through vm without an import callback, so a dynamic import() rejects as it would live.
  const fn = vm.compileFunction(`"use strict"; return (async () => {\n${body}\n})()`,
    ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', 'Date', 'Math', ...HOST_APIS],
    { filename: file, lineOffset: -1 })
  const hosts = HOST_APIS.map(hostStub)

  async function run(args, responder = () => null) {
    const calls = [], logs = [], phases = []
    const agent = async (prompt, opts = {}) => {
      if (opts.schema !== undefined) checkSchema(opts.schema)
      calls.push({ prompt, opts })
      return responder(prompt, opts, calls.length - 1)
    }
    const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
    const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
      try {
        let r = item
        for (const stage of stages) r = await stage(r, item, i)
        return r
      } catch {
        return null
      }
    }))
    const budget = { total: null, spent: () => 0, remaining: () => Infinity }
    const workflow = () => { throw new Error('workflow() is not available in the test runtime') }
    const result = await fn(args, agent, parallel, pipeline, t => phases.push(t), m => logs.push(m), budget, workflow, StubDate, StubMath, ...hosts)
    return { result, calls, logs, phases }
  }

  return { meta, run }
}

export function loadWorkflow(absPath) {
  return loadWorkflowSource(fs.readFileSync(absPath, 'utf8'), absPath)
}
