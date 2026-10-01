#!/usr/bin/env node
// scripts/loop-text.mjs
// Neutralizes text that a delegate, a panel seat or tool output wrote, before the
// loop copies it into STATE.md. Such text must never form a heading, a list item or
// a `**Decision:**` line that loop §3.1 would read as a human decision.
// Usage: node loop-text.mjs line <file>...   one neutral line per file, in order
//        node loop-text.mjs block <file>     the file's lines, each quoted with "> "
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// Zero-width and bidi control characters, which can hide markup from a reader.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu
const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/u

// Removes bold markers and turns `Decision` (not preceded by a letter, so
// `_Decision` counts) followed by any colon-like character into `Decision -`.
function defang(s) {
  return s
    .replace(/\*{2,}/g, '')
    .replace(/(?<![a-z])(decision)\s*[:\uFF1A\uFE55\uA789]/giu, '$1 -')
}

export function neutralLine(text) {
  return defang(String(text).replace(INVISIBLE, '').replace(/[\s\u0085]+/gu, ' ')).trim()
}

export function neutralBlock(text) {
  return String(text).replace(INVISIBLE, '').split(LINE_BREAK)
    .map(line => `> ${defang(line.replace(/\s+/gu, ' ')).trim()}`.trimEnd())
    .join('\n')
}

function main(argv) {
  const [mode, ...files] = argv
  if (!['line', 'block'].includes(mode) || files.length === 0 || (mode === 'block' && files.length !== 1)) {
    process.stderr.write('usage: loop-text.mjs line <file>... | block <file>\n')
    return 2
  }
  let texts
  try {
    texts = files.map(f => fs.readFileSync(f, 'utf8'))
  } catch (e) {
    process.stderr.write(`loop-text: ${e.message}\n`)
    return 2
  }
  process.stdout.write(texts.map(mode === 'line' ? neutralLine : neutralBlock).join('\n') + '\n')
  return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
