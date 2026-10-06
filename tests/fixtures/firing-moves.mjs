// tests/fixtures/firing-moves.mjs
// The main session's STATE.md edits as the firing driver (tests/fixtures/firing-driver.mjs) and
// the item interruption tests (tests/loop/loop-interrupt-items.test.mjs) make them: each one an
// Edit, {old, new}, where `old` must occur exactly once in the file (the Edit tool's own rule),
// computed against the file as it is read just before the edit. Items are found through
// scripts/lib/loop-state.mjs's parseState (the one item grammar), by id.
//
// A prose move (stage 0c-3 brief R14) is two edits, the insertion first: insertTop puts the
// whole block (every field line kept, only the header rewritten for the destination) at the top
// of the destination section, then the source block is deleted, leaving `(empty)` when the
// section holds nothing else. The driver's deletion is deleteAsRead, taken before the insertion
// (the 0c-3 closing fix F6): the source block exactly as read, anchored through the next
// non-blank line after it, so an amendment made between the two edits makes the deletion fail
// (the item-edit incident) instead of being deleted unseen. An interruption between the two
// leaves two copies, never none, and the recovery planner's clear-now resolves the pair that
// involves ## Now when the two copies are identical (its own anchored deletion of the ## Now
// block, R29): the same itemDigest and the same lines under the header, apart from the header
// form and the field lines a move rewrites (R29a; the closing fix F5 narrows what may differ);
// copies that differ are now-conflict, the item-edit incident.
//
// Exports:
//   PLACEHOLDER, DOT, DASH                the `(empty)` line, the header separator's middle dot,
//                                         the em dash (the none spelling and the empty sha slot)
//   editOnce(text, {old, new}) -> text    the Edit tool: throws `edit: old occurs N times` unless
//                                         `old` occurs exactly once
//   findItem(text, id, section = null)    the first item carrying `id` (in `section` when given),
//                                         or null; carriers(text, id) every such item
//   nowBlock(text) -> Item | null         the first item in ## Now (with or without an id)
//   insertTop(text, section, block)       the edit putting the lines `block` at the top of
//                                         `section`, in place of its `(empty)` line
//   removeItem(text, item)                the edit deleting `item`'s block (an Item parsed from
//                                         this text), `(empty)` left when nothing else remains
//   deleteAsRead(text, item)              the same deletion as the prose takes it before the
//                                         insertion: `item`'s block as read, anchored through
//                                         the next non-blank line (loop-state.mjs's
//                                         planDeleteBlock); it no longer applies once the block
//                                         or the line after it changed
//   replaceItem(text, item, block)        the edit replacing `item`'s block in place
//   setSection(text, name, body)          the edit replacing section `name`'s body with `body`
//   upsertEntry(text, id, entry)          the edit replacing the ## Needs decision entry whose
//                                         heading's first token is `id`, or inserting `entry` at
//                                         the top of the section (R15: upserts are by id)
//   withField(lines, label, value)        the block with its `label:` field line set to `value`
//                                         (replaced in place, or appended)
//   fieldOf(lines, label) -> string|null  the trimmed value of the block's first `label:` line
//   doneBlock(item, sha, date)            the block in ## Done form, `sha` null for the dash
//   blockedBlock(item, {attempts, reason, recovery})
//                                         the block in ## Blocked form with its recovery: field
import { parseState, planDeleteBlock } from '../../scripts/lib/loop-state.mjs'

export const PLACEHOLDER = '(empty)'
export const DOT = String.fromCharCode(0xb7)
export const DASH = String.fromCharCode(0x2014)

const count = (text, s) => {
  let n = 0
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) n++
  return n
}

export function editOnce(text, edit) {
  const n = edit.old ? count(text, edit.old) : 0
  if (n !== 1) throw new Error(`edit: old occurs ${n} times: ${JSON.stringify(edit.old).slice(0, 300)}`)
  const i = text.indexOf(edit.old)
  return text.slice(0, i) + edit.new + text.slice(i + edit.old.length)
}

export const carriers = (text, id) => parseState(text).items.filter(i => i.id !== null && i.id === String(id).toLowerCase())
export const findItem = (text, id, section = null) => carriers(text, id).find(i => section === null || i.section === section) ?? null
export const nowBlock = text => parseState(text).items.find(i => i.section === 'Now') ?? null

// The lines [from, to) of text as an `old` string, and the same place's `new` string for the
// lines `repl`: whole lines, with the newline after the last one when a line follows it.
const tail = (lines, to) => (to < lines.length ? '\n' : '')
const span = (lines, from, to) => lines.slice(from, to).join('\n') + tail(lines, to)
const edit = (lines, from, to, repl) => ({ old: span(lines, from, to), new: repl.join('\n') + tail(lines, to) })

function sectionOf(text, name) {
  const sec = parseState(text).sections[name]
  if (!sec) throw new Error(`edit: no ## ${name} section`)
  return sec
}

export function insertTop(text, section, block) {
  const lines = text.split('\n')
  const { at } = sectionOf(text, section)
  const next = lines[at + 1] ?? ''
  return edit(lines, at, at + 2, [lines[at], ...block, ...(next.trim() === PLACEHOLDER ? [] : [next])])
}

export function removeItem(text, item) {
  const lines = text.split('\n')
  const sec = sectionOf(text, item.section)
  // Anything else the section holds (another item, an unparsed line) keeps it from `(empty)`.
  const rest = [...lines.slice(sec.start, item.start), ...lines.slice(item.end, sec.end)].filter(l => l.trim() && l.trim() !== PLACEHOLDER)
  return edit(lines, sec.at, item.end, [...lines.slice(sec.at, item.start), ...(rest.length ? [] : [PLACEHOLDER])])
}

// A prose move's deletion, taken from the text as read before its insertion (F6, Codex closing
// g3#1): the planner's own anchored deletion (R31), one edit.
export function deleteAsRead(text, item) {
  const { edits } = planDeleteBlock(text, item.section, item.start, item.end)
  if (edits.length !== 1) throw new Error(`edit: the deletion of ${item.id ?? item.title} is ${edits.length} edits`)
  return edits[0]
}

export function replaceItem(text, item, block) {
  const lines = text.split('\n')
  const sec = sectionOf(text, item.section)
  return edit(lines, sec.at, item.end, [...lines.slice(sec.at, item.start), ...block])
}

export function setSection(text, name, body) {
  const lines = text.split('\n')
  const sec = sectionOf(text, name)
  // The body ends at the section's last non-blank line, so the blank line before the next
  // heading stays.
  let end = sec.end
  while (end > sec.start && !lines[end - 1].trim()) end--
  return edit(lines, sec.at, end, [lines[sec.at], ...body])
}

export function upsertEntry(text, id, entry) {
  const st = parseState(text)
  const old = st.entries.find(e => e.id === id)
  if (!old) return insertTop(text, 'Needs decision', entry)
  const lines = text.split('\n')
  const sec = st.sections['Needs decision']
  return edit(lines, sec.at, old.end, [...lines.slice(sec.at, old.start), ...entry])
}

const fieldRe = label => new RegExp(`^\\s+- ${label.replace(/-/g, '\\-')}:(?:[ \\t]|$)`)
export function withField(lines, label, value) {
  const re = fieldRe(label)
  const at = lines.findIndex((l, i) => i > 0 && re.test(l))
  const out = [...lines]
  if (at >= 0) out[at] = `  - ${label}: ${value}`
  else out.push(`  - ${label}: ${value}`)
  return out
}
export function fieldOf(lines, label) {
  const re = fieldRe(label)
  const l = lines.find((x, i) => i > 0 && re.test(x))
  return l === undefined ? null : l.slice(l.indexOf(':') + 1).trim()
}

export const doneBlock = (item, sha, date) => [`- [x] ${item.title} ${DOT} ${sha ?? DASH} ${DOT} ${date}`, ...item.lines.slice(1)]
export const blockedBlock = (item, { attempts = 2, reason, recovery }) =>
  withField([`- [ ] ${item.title} ${DOT} attempts: ${attempts} ${DOT} ${reason}`, ...item.lines.slice(1)], 'recovery', recovery)
