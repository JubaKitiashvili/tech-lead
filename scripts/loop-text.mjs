#!/usr/bin/env node
// scripts/loop-text.mjs
// Neutralizes text that a delegate, a panel seat or tool output wrote, before the
// loop copies it into STATE.md. The output never starts a line of its own (line mode
// is one line; block mode quotes every line with "> "), carries no HTML tag or entity,
// and has no item field label (loop-state.mjs's FIELD_LABELS: `id`, `origin`, `class`,
// `status`, `blocked-by`, `notes`, `decision`, `attempts`, `recovery`, `decided`,
// `no-change-ok`; `decision` also covers `Decision`) followed by a colon, and no backlog field
// separator. So it can never form a heading, a list item, an item field, or the
// `**Decision:**` line loop section 3.1 reads. Text is folded with loop-state.mjs's fold (NFKC,
// Default_Ignorable code points removed), the same fold titles are compared by (brief R7).
// Usage: node loop-text.mjs line <file>...   one neutral line per file, in order
//        node loop-text.mjs block <file>     the file's lines, each quoted with "> "
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FIELD_LABELS, fold } from './lib/loop-state.mjs'

const LINE_BREAK = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/u
const SEPARATORS = /[\u00B7\u2022\u2219\u22C5\u30FB\uFF65]/gu
const COLONS = ':\uA789\u2236\u02D0\u0589\u05C3\u205A'
// A label, then up to 12 non-alphanumeric characters (markup such as `__`, `*`, backticks), then a colon.
// Built on first use: loop-state.mjs imports this module too (planFollowup neutralizes through
// neutralLine), so FIELD_LABELS may not be initialized yet while this module evaluates. The
// labels are lowercase words and hyphens, so they need no escaping in a pattern.
let LABEL = null
const label = () => (LABEL ??= new RegExp(
  `(?<![\\p{L}\\p{N}])(${FIELD_LABELS.join('|')})([^\\p{L}\\p{N}]{0,12}?)[${COLONS}]`, 'giu'))

function defang(s) {
  return s
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\*{2,}/g, '')
    .replace(SEPARATORS, ' - ')
    .replace(label(), '$1$2 -')
}

// Unicode compatibility forms (fullwidth letters and colons) fold to ASCII; invisible characters go.
const clean = text => fold(text)

export function neutralLine(text) {
  return defang(clean(text).replace(/[\s\u0085]+/gu, ' ')).replace(/ {2,}/g, ' ').trim()
}

export function neutralBlock(text) {
  return clean(text).split(LINE_BREAK)
    .map(line => `> ${defang(line.replace(/\s+/gu, ' ')).replace(/ {2,}/g, ' ').trim()}`.trimEnd())
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
