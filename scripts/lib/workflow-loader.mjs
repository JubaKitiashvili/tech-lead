// scripts/lib/workflow-loader.mjs
// Loads a Workflow script (workflows/*.js) into a stub of Claude Code's Workflow
// runtime, so checks and tests can compile it and run it with scripted agent() results.
import fs from 'node:fs'
import { matchBrace } from './js-scan.mjs'

const AsyncFunction = (async () => {}).constructor
const META_RE = /^export const meta = /m

// The literal with the contents of '…' and "…" removed. Template literals are refused.
function codeOnly(lit, file) {
  let out = ''
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i]
    if (c === '`') throw new Error(`${file}: meta is not a pure literal (template literal)`)
    if (c === '"' || c === "'") {
      let j = i + 1
      for (; j < lit.length && lit[j] !== c; j++) if (lit[j] === '\\') j++
      out += c + c
      i = j
      continue
    }
    out += c
  }
  return out
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
  if (/\.\.\.|[A-Za-z_$][\w$]*\s*[.(]/.test(codeOnly(lit, file))) throw new Error(`${file}: meta is not a pure literal`)
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
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', 'Date', 'Math', body)

  async function run(args, responder = () => null) {
    const calls = [], logs = [], phases = []
    const agent = async (prompt, opts = {}) => {
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
    const result = await fn(args, agent, parallel, pipeline, t => phases.push(t), m => logs.push(m), budget, workflow, StubDate, StubMath)
    return { result, calls, logs, phases }
  }

  return { meta, run }
}

export function loadWorkflow(absPath) {
  return loadWorkflowSource(fs.readFileSync(absPath, 'utf8'), absPath)
}
