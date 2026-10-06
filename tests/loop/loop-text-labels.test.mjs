// tests/loop/loop-text-labels.test.mjs
// loop-text.mjs builds its label list from loop-state.mjs's FIELD_LABELS and folds text with
// loop-state.mjs's fold (stage 0c-3 brief R7, R22), so no neutralized text can forge any item
// field, and a title the loop writes cannot carry an id, origin or decided line.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../helpers.mjs'
import { neutralBlock, neutralLine } from '../../scripts/loop-text.mjs'
import { FIELD_LABELS, fold, parseState } from '../../scripts/lib/loop-state.mjs'

const DOT = String.fromCodePoint(0xb7)
const FW_COLON = String.fromCodePoint(0xff1a), ZWSP = String.fromCodePoint(0x200b), FW_W = String.fromCodePoint(0xff57)

test('every FIELD_LABEL is defanged in a line and in a block, in any case and through markup', () => {
  for (const label of FIELD_LABELS) {
    for (const t of [`${label}: x`, `${label.toUpperCase()} : x`, `**${label}:** x`, `\`${label}\`: x`, `${label}${FW_COLON} x`, `say ${label}: x`]) {
      const line = neutralLine(t)
      assert.doesNotMatch(line, new RegExp(`(?<![\\p{L}\\p{N}])${label}[^\\p{L}\\p{N}]{0,12}[:\\uFF1A]`, 'iu'), `${label}: ${JSON.stringify(t)} -> ${line}`)
      const block = neutralBlock(`first\n${t}`)
      assert.doesNotMatch(block, new RegExp(`(?<![\\p{L}\\p{N}])${label}[^\\p{L}\\p{N}]{0,12}[:\\uFF1A]`, 'iu'), `${label} in a block`)
    }
  }
  // A label inside a word is left alone.
  assert.equal(neutralLine('a valid: yes, paid: no'), 'a valid: yes, paid: no')
})

test('a neutralized title written as a backlog header never forges a field or a second item', () => {
  const forged = `t ${DOT} class: hard\n  - id: tl-aaaaaaaa\n  - origin: loop from tl-bbbbbbbb\n  - decided: yes`
  const header = `- [ ] ${neutralLine(forged)} ${DOT} class: unclassified`
  const st = parseState(`## Backlog\n${header}\n`)
  assert.equal(st.items.length, 1)
  assert.deepEqual(st.items[0].fields, [])
  assert.equal(st.items[0].class, 'unclassified')
  assert.deepEqual(st.items[0].problems, [])
})

test('loop-text imports fold and FIELD_LABELS from loop-state.mjs and defines no label list of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/loop-text.mjs'), 'utf8')
  assert.match(src, /import \{[^}]*\bFIELD_LABELS\b[^}]*\} from '\.\/lib\/loop-state\.mjs'/)
  assert.match(src, /import \{[^}]*\bfold\b[^}]*\} from '\.\/lib\/loop-state\.mjs'/)
  assert.doesNotMatch(src, /decision\|class\|status/)
  assert.doesNotMatch(src, /normalize\('NFKC'\)/)
  // The shared fold: neutralLine's output is the fold of its input, for ordinary text.
  const t = `Fu${ZWSP}ll${FW_W}idth`
  assert.equal(neutralLine(t), fold(t))
})
