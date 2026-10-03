// tests/loop/record-guard-scan.test.mjs
// Sharpened R31 for run records (closing review F6): every createRecord / updateRecord call in
// scripts/ passes a guard, so the lock is checked again after the record's fsync, right before
// its rename or link. A static scan of the call arguments; run-record.mjs itself is skipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers.mjs'

const CALL = /\b(createRecord|updateRecord)\(/g

// The index just past the parenthesis that closes the one at open, skipping strings, template
// literals and comments (regex literals are not handled; the scanned calls hold none).
function closeParen(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  throw new Error(`unclosed call at ${open}`)
}

function calls() {
  const found = []
  const dirs = [path.join(ROOT, 'scripts'), path.join(ROOT, 'scripts', 'lib')]
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
      if (name === 'run-record.mjs') continue
      const file = path.join(dir, name)
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(CALL)) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const line = src.slice(lineStart, src.indexOf('\n', m.index))
        if (/^\s*(\/\/|\*|import\b)/.test(line) || /\bfunction\s+$/.test(src.slice(lineStart, m.index))) continue
        const open = m.index + m[0].length - 1
        found.push({ where: `${path.relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`, args: src.slice(open, closeParen(src, open)) })
      }
    }
  }
  return found
}

test('every run-record write in scripts/ passes a guard (F6, sharpened R31)', () => {
  const all = calls()
  assert.ok(all.length >= 10, `the scan found the record writes (${all.length})`)
  const bare = all.filter(c => !/\bguard\b/.test(c.args)).map(c => c.where)
  assert.deepEqual(bare, [], 'record writes without a guard')
})
