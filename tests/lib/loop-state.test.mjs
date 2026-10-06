// tests/lib/loop-state.test.mjs
// STATE.md reading (stage 0c-2 brief section 1): nowLine and PLACEHOLDER moved here from
// loop-recover.mjs, which re-exports them unchanged. The fixture's items carry ids (stage 0c-3);
// the item grammar's own tests are tests/lib/loop-state-*.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PLACEHOLDER, nowLine } from '../../scripts/lib/loop-state.mjs'
import * as recover from '../../scripts/loop-recover.mjs'

// The STATE.md separator the templates use; built from its code point to keep this file ASCII.
const DOT = String.fromCodePoint(0xb7)
const ITEM = `- [ ] P1 ${DOT} fix the parser ${DOT} class: hard`
const state = now => [
  '# Demo - Loop State', '',
  '## Now', now, '',
  '## Backlog',
  `- [ ] P2 ${DOT} later work ${DOT} class: unclassified`, '  - id: tl-bbbbbbbb', '  - origin: human', '  - blocked-by: -', '  - status: -', '',
  '## Needs decision', '(empty)', '',
  '## Blocked', '(empty)', '',
  '## Done', '(empty)', '',
  '## Last run', '(never run)', '',
].join('\n')

test('PLACEHOLDER is the template\'s empty ## Now, and loop-recover re-exports both names unchanged', () => {
  assert.equal(PLACEHOLDER, '(empty)')
  assert.equal(recover.nowLine, nowLine)
  assert.equal(recover.PLACEHOLDER, PLACEHOLDER)
})

test('nowLine: the first line of ## Now, null when it is empty or missing', () => {
  assert.equal(nowLine(state(ITEM)), ITEM)
  assert.equal(nowLine(state(PLACEHOLDER)), null)
  assert.equal(nowLine(state(`  ${PLACEHOLDER}  `)), null)
  assert.equal(nowLine(state('')), null)
  // Blank lines before the item, CRLF line ends, trailing spaces, a multi-line item.
  assert.equal(nowLine('## Now\r\n\r\n  - [ ] P1 task  \r\n  - status: -\r\n## Backlog\r\n'), '- [ ] P1 task')
  // The section ends at the next level-1 or level-2 heading; a deeper heading stays inside.
  assert.equal(nowLine('## Now\n## Backlog\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Now\n\n# Other\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Now\n\n##\n- [ ] P2 other\n'), null)
  assert.equal(nowLine('## Now\n### detail\n'), '### detail')
  // Only the exact heading opens the section, and only the first one counts.
  assert.equal(nowLine('## Nowhere\n- [ ] P1 x\n'), null)
  assert.equal(nowLine('## Now  \n- [ ] P1 x\n'), '- [ ] P1 x')
  assert.equal(nowLine('# Title\n\n## Backlog\n- [ ] P1 x\n'), null)
  assert.equal(nowLine('## Now\n(empty)\n## Now\n- [ ] P1 x\n'), null)
  // A placeholder is only the whole line: text around it is an item.
  assert.equal(nowLine('## Now\n(empty) - [ ] P1 x\n'), '(empty) - [ ] P1 x')
  // Anything that is not text reads as its string.
  assert.equal(nowLine(Buffer.from('## Now\n- [ ] P1 x\n')), '- [ ] P1 x')
  assert.equal(nowLine(''), null)
})
