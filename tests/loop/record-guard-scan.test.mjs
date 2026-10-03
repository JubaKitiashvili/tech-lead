// tests/loop/record-guard-scan.test.mjs
// Sharpened R31 for run records (closing review F6; re-check Codex f2 #6, Claude gap-verify): every
// createRecord, updateRecord and deleteRecord call in scripts/ (scripts/lib and scripts/checks
// included; run-record.mjs, which defines them, is skipped) passes a guard, so the lock is checked
// again right before the record's rename, link or unlink. A static scan: comments, strings and
// regex literals are blanked first; a call is found by its name, by a renamed import of it
// (`import { updateRecord as ur }`) or through a namespace import (`rr.updateRecord(`); its last
// argument must be the options object literal (create and update take four arguments, delete
// three) with a `guard` property whose value is not undefined, null or void. A function that
// passes one of its own parameters as that guard (reflex-bundle's recordIntent and recordDone) is
// a wrapper: every call of it must pass a guard in that position, in turn, and it may be neither
// exported nor used as a value. The scanner also runs on synthetic sources, so a guard that is
// undefined, commented out or missing is shown to be caught.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers.mjs'

const WRITES = { createRecord: 4, updateRecord: 4, deleteRecord: 3 }
const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'])
const NO_VALUE = /^(?:undefined|null|void\b.*)$/s
const IDENT = /^[A-Za-z_$][\w$]*$/

// src with every comment, and the contents of every string, template and regex literal, replaced
// by spaces (newlines kept, so offsets and line numbers stay). A `/` starts a regex literal where an
// expression may begin: after an operator or opening bracket, a keyword, or nothing.
function mask(src) {
  const out = src.split('')
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  let prev = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i)
      const end = e < 0 ? src.length : e
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e < 0 ? src.length : e + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      prev = c
      continue
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || KEYWORDS.has(prev))) {
      let j = i + 1
      let inClass = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      while (i < src.length && /[a-z]/.test(src[i])) i++
      prev = '/'
      continue
    }
    if (/[\w$]/.test(c)) {
      let j = i
      while (j < src.length && /[\w$]/.test(src[j])) j++
      prev = src.slice(i, j)
      i = j
      continue
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}

// The index just past the bracket that closes the one at open, in masked source.
function closing(m, open) {
  let depth = 0
  for (let i = open; i < m.length; i++) {
    if ('([{'.includes(m[i])) depth++
    else if (')]}'.includes(m[i]) && --depth === 0) return i + 1
  }
  throw new Error(`unclosed bracket at ${open}`)
}

// The top-level comma-separated parts of masked text (an argument list's or an object's inside).
function parts(text) {
  const out = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if ('([{'.includes(text[i])) depth++
    else if (')]}'.includes(text[i])) depth--
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(from, i).trim())
      from = i + 1
    }
  }
  const last = text.slice(from).trim()
  if (last || out.length) out.push(last)
  return out.filter((p, k, a) => p !== '' || k < a.length - 1)
}

// The guard's value in an options object literal (masked text), or why there is none.
function guardOf(arg) {
  if (!arg || arg[0] !== '{' || closing(arg, 0) !== arg.length) return { why: 'the last argument is not an options object literal' }
  for (const p of parts(arg.slice(1, -1))) {
    if (p === 'guard') return { value: 'guard' }
    const m = /^guard\s*:\s*([^]*)$/.exec(p)
    if (!m) continue
    const value = m[1].trim()
    if (!value || NO_VALUE.test(value)) return { why: `guard is ${value || 'empty'}` }
    return { value }
  }
  return { why: 'no guard' }
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length

// The functions declared in masked source: {name, params, body: [from, to], exported}.
function functions(m) {
  const out = []
  for (const f of m.matchAll(/(\bexport\s+)?(?:async\s+)?\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = f.index + f[0].length - 1
    const close = closing(m, open)
    const brace = m.indexOf('{', close)
    if (brace < 0) continue
    const params = parts(m.slice(open + 1, close - 1)).map(p => p.replace(/=[^]*$/, '').trim())
    out.push({ name: f[2], params, body: [brace, closing(m, brace)], exported: Boolean(f[1]) })
  }
  return out
}

// The innermost declared function whose body holds offset at.
const enclosing = (fns, at) => fns.filter(f => f.body[0] < at && at < f.body[1]).sort((a, b) => (b.body[0] - a.body[0]))[0] ?? null

// The calls of callee in masked source (not its declaration, not a method of another object).
function callsOf(m, callee) {
  const out = []
  const esc = callee.replace(/[.$]/g, s => `\\${s}`)
  for (const c of m.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*\\(`, 'g'))) {
    if (/\bfunction\s*\*?\s*$/.test(m.slice(Math.max(0, c.index - 20), c.index))) continue
    const open = c.index + c[0].length - 1
    out.push({ at: c.index, args: parts(m.slice(open + 1, closing(m, open) - 1)) })
  }
  return out
}

// The local names under which src reaches each record write: {local: write}.
function writeNames(m, src) {
  const names = Object.fromEntries(Object.keys(WRITES).map(w => [w, w]))
  for (const imp of src.matchAll(/\bimport\s+([^;]*?)\s+from\s+['"]([^'"]*run-record\.mjs)['"]/g)) {
    const clause = imp[1]
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (ns) for (const w of Object.keys(WRITES)) names[`${ns[1]}.${w}`] = w
    const braces = /\{([^}]*)\}/.exec(clause)
    for (const spec of braces ? braces[1].split(',') : []) {
      const s = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec)
      if (s && WRITES[s[1]] && s[2]) names[s[2]] = s[1]
    }
  }
  return names
}

// scan(src, file) -> {calls: [{where, write}], problems: [string]}.
function scan(src, file = 'source') {
  const m = mask(src)
  const fns = functions(m)
  const calls = []
  const problems = []
  const wrappers = new Map()
  const where = at => `${file}:${lineOf(src, at)}`
  // A guard that is a parameter of the enclosing function makes that function a wrapper.
  const viaParam = (value, at) => {
    if (!IDENT.test(value)) return
    const fn = enclosing(fns, at)
    const k = fn ? fn.params.indexOf(value) : -1
    if (k >= 0 && !wrappers.has(fn.name)) wrappers.set(fn.name, { fn, k })
  }
  for (const [local, write] of Object.entries(writeNames(m, src))) {
    for (const c of callsOf(m, local)) {
      calls.push({ where: where(c.at), write })
      if (c.args.length !== WRITES[write]) {
        problems.push(`${where(c.at)}: ${local} takes ${WRITES[write]} arguments, the options last (${c.args.length} given)`)
        continue
      }
      const g = guardOf(c.args[c.args.length - 1])
      if (g.why) problems.push(`${where(c.at)}: ${local}: ${g.why}`)
      else viaParam(g.value, c.at)
    }
  }
  for (const [name, w] of wrappers) {
    if (w.fn.exported) problems.push(`${file}: the guard wrapper ${name} is exported (only callers in this file are checked)`)
    const uses = [...m.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'))]
    for (const u of uses) problems.push(`${where(u.index)}: the guard wrapper ${name} is used as a value`)
    for (const c of callsOf(m, name)) {
      const arg = c.args[w.k]
      if (arg === undefined || arg === '' || NO_VALUE.test(arg)) problems.push(`${where(c.at)}: ${name} is called without its guard (argument ${w.k + 1})`)
      else viaParam(arg, c.at)
    }
  }
  return { calls, problems }
}

function scanScripts() {
  const files = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.mjs') && e.name !== 'run-record.mjs') files.push(p)
    }
  }
  walk(path.join(ROOT, 'scripts'))
  const calls = []
  const problems = []
  for (const file of files) {
    const r = scan(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file))
    calls.push(...r.calls)
    problems.push(...r.problems)
  }
  return { files, calls, problems }
}

test('every run-record write in scripts/ passes a guard, and every guard wrapper\'s caller passes one (F6, sharpened R31)', () => {
  const { files, calls, problems } = scanScripts()
  assert.ok(files.some(f => f.includes(`${path.sep}checks${path.sep}`)), 'scripts/checks is scanned')
  assert.ok(calls.filter(c => c.write !== 'deleteRecord').length >= 10, `the scan found the record writes (${calls.length})`)
  assert.ok(calls.some(c => c.write === 'deleteRecord'), 'the scan found close\'s deleteRecord')
  assert.deepEqual(problems, [], 'record writes without a guard')
})

const IMPORT = "import { createRecord, deleteRecord, updateRecord } from './lib/run-record.mjs'\n"
const problemsOf = src => scan(src, 'x.mjs').problems

test('the scanner accepts a guard given as a name, a shorthand or a function', () => {
  assert.deepEqual(problemsOf(`${IMPORT}const held = () => 1
updateRecord(paths, N, r => ({ ...r, phase: 'clean' }), { guard: held })
createRecord(paths, N, { phase: 'preparing' }, { guard: () => assertHeld(paths, N, env) })
function f(guard) { deleteRecord(paths, 1, { guard }) }
f(held)
`), [])
})

test('the scanner catches a guard that is undefined, null or void', () => {
  for (const v of ['undefined', 'null', 'void 0']) {
    assert.deepEqual(problemsOf(`${IMPORT}updateRecord(paths, N, {}, { guard: ${v} })\n`), [`x.mjs:2: updateRecord: guard is ${v}`], v)
  }
})

test('the scanner catches a commented-out guard and a guard only named in a comment or a string', () => {
  assert.deepEqual(problemsOf(`${IMPORT}updateRecord(paths, N, {}, { /* guard */ })\n`), ['x.mjs:2: updateRecord: no guard'])
  assert.deepEqual(problemsOf(`${IMPORT}updateRecord(paths, N, {}, {
  // guard: held,
})
`), ['x.mjs:2: updateRecord: no guard'])
  assert.deepEqual(problemsOf(`${IMPORT}createRecord(paths, N, { note: 'guard' }, { why: 'guard' })\n`), ['x.mjs:2: createRecord: no guard'])
})

test('the scanner catches a missing guard: no options, or options without one, deleteRecord included', () => {
  assert.deepEqual(problemsOf(`${IMPORT}updateRecord(paths, N, { guard: held })\n`),
    ['x.mjs:2: updateRecord takes 4 arguments, the options last (3 given)'])
  assert.deepEqual(problemsOf(`${IMPORT}deleteRecord(paths, rec.generation)\n`),
    ['x.mjs:2: deleteRecord takes 3 arguments, the options last (2 given)'])
  assert.deepEqual(problemsOf(`${IMPORT}deleteRecord(paths, 1, opts)\n`), ['x.mjs:2: deleteRecord: the last argument is not an options object literal'])
  assert.deepEqual(problemsOf(`${IMPORT}createRecord(paths, N, {}, { ...opts })\n`), ['x.mjs:2: createRecord: no guard'])
})

test('the scanner follows a renamed import and a namespace import', () => {
  assert.deepEqual(problemsOf("import { updateRecord as ur, deleteRecord as gone } from '../lib/run-record.mjs'\nur(p, 1, {}, {})\ngone(p, 1, { guard: g })\n"),
    ['x.mjs:2: ur: no guard'])
  assert.deepEqual(problemsOf("import * as rr from './lib/run-record.mjs'\nrr.createRecord(p, 1, {}, { guard: undefined })\n"),
    ['x.mjs:2: rr.createRecord: guard is undefined'])
})

test('the scanner requires every caller of a guard wrapper to pass a guard', () => {
  const wrapper = `${IMPORT}function recordDone(paths, g, holder, guard) {
  updateRecord(paths, g, r => r, { guard })
}
`
  assert.deepEqual(problemsOf(`${wrapper}recordDone(paths, 1, 1, held)\n`), [])
  assert.deepEqual(problemsOf(`${wrapper}recordDone(paths, 1, 1)\n`), ['x.mjs:5: recordDone is called without its guard (argument 4)'])
  assert.deepEqual(problemsOf(`${wrapper}recordDone(paths, 1, 1, undefined)\n`), ['x.mjs:5: recordDone is called without its guard (argument 4)'])
  assert.deepEqual(problemsOf(`${wrapper}[1].forEach(recordDone)\n`), ['x.mjs:5: the guard wrapper recordDone is used as a value'])
  // A wrapper of a wrapper: the outer one's callers are held to it too.
  assert.deepEqual(problemsOf(`${wrapper}function outer(guard) { recordDone(paths, 1, 1, guard) }\nouter()\n`),
    ['x.mjs:6: outer is called without its guard (argument 1)'])
  assert.deepEqual(problemsOf(`${IMPORT}export function done(paths, guard) {\n  deleteRecord(paths, 1, { guard })\n}\n`),
    ['x.mjs: the guard wrapper done is exported (only callers in this file are checked)'])
})

test('the scanner ignores calls inside comments, strings and regex literals', () => {
  assert.deepEqual(problemsOf(`${IMPORT}// updateRecord(paths, N, {})
const s = 'deleteRecord(paths, 1)'
const re = /createRecord\\(paths/
`), [])
})
