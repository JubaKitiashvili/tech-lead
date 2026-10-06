// scripts/lib/loop-state.mjs
// Reading <S>/STATE.md and planning edits to it (stage 0c-2 moved nowLine and PLACEHOLDER
// here from loop-recover.mjs, which re-exports both names; stage 0c-3 adds the item grammar,
// brief section 2). One grammar: every reader of STATE.md items imports this module (R4).
// Everything here is pure: the ledger and the level are inputs, nothing reads or writes a file.
//
// The grammar (R3, R5, R7, R15). A section is `## <Name>` up to the next `#`/`##` heading,
// except that a column-0 `# ` heading inside an item section is a `stray-heading` problem and
// the section goes on (fix manifest R31). Items live in `## Now`, `## Backlog`, `## Blocked`
// and `## Done`: a column-0 header line, then its indented lines up to the next column-0 line;
// a column-0 text line right after them (no blank line between; not a list line, a heading or
// `(empty)`) joins the item as a malformed line, with the indented lines under it (R31).
// Header forms:
//   Now, Backlog  `- [ ] (P<n> <DOT> )?<title> <DOT> class: <class>( <DOT> <reason>)?`, split at the
//                 first ` <DOT> class: `; without one, the whole text is the title, class
//                 `unclassified`
//   Blocked       `- [ ] <title> <DOT> attempts: <n> <DOT> <reason>`, split from the left at the first
//                 ` <DOT> attempts: `; without one, the whole text is the title
//   Done          `- [x] <title> <DOT> <sha|<DASH>> <DOT> <YYYY-MM-DD>`, split from the right
// Any other column-0 line there is an `unparsed-line` (with the indented lines under it);
// `(empty)` and blank lines are ignored. Under a header, a field is
// `^( {2,4})- ([a-z][a-z-]*):(?:[ \t](.*))?$`; notes and decision take continuation lines
// indented at least two spaces deeper than their dash (trimmed, joined with "\n"; a blank
// line ends them); any other non-blank line is `malformed-field`, and so is an id-like or
// origin-like line inside a continuation. `## Needs decision` holds entries, each from a `### `
// heading to the next one: `### <id> <DOT> <title>`.
//
// Raw carriers (fix manifest R28). An id-like line is any line labelled `id` (any case,
// indent or list marker, read through fold); an origin-like line the same with `origin`. Every
// id token on an id-like line in an item block (a parsed item's or an unparsed block's) that is
// not the item's own valid `id:` field is a raw carrier of that id, and every token on an
// origin-like line is a parent of the block. A raw carrier in `## Now`, `## Backlog` or
// `## Blocked` keeps its id unfinished, and the walk takes the raw parents; normalize never
// mints an id (or an origin) for an item holding an id-like (origin-like) line (R31); a
// release refuses an id with a raw carrier (R30a); and the Done trim keeps a block whose
// origin-like lines are not exactly one well-formed `origin:` field (R27a).
//
// Exports:
//   PLACEHOLDER          what an empty section holds; a firing leaves exactly this in `## Now`
//   nowLine(text)        the first non-blank line of `## Now`, trimmed; null when empty
//   FIELD_LABELS         the item field labels (R22); loop-text.mjs defangs each of them
//   ID_RE                an item id: `tl-` and 8 lowercase Crockford base32 characters (R2)
//   mintId(known, rng)   a fresh id not in `known` (redrawn while it is)
//   parseOrigin(s)       {kind, parent} for `bootstrap|human|unknown|loop from <id>`, else null
//   fold(s), normTitle(t)  the shared text fold, and the title key for uniqueness (R7)
//   parseState(text)     {sections, items, entries, problems}
//   nowItem(text)        the first `## Now` item, or null
//   itemDigest(item), approvedDigest(item)  R6
//   releasedItem(state, entryId)  the item as the section 3.1 release would leave it (R16)
//   itemProblems(state, ledger), eligibility(state, {ledger, level}), blockerStatus(state, id, ledger)
//   idCarriers(state, id)  {parsed, raw}: the items and the raw lines carrying an id (R28)
//   planNormalize, planPick, planFollowup, planDoneTrim, planDeleteBlock, applyEdits
//                        anchored edit plans (R1, R13, R14, R17, R27, R27a, R29, R30a)
// Each is documented where it is defined.
import crypto from 'node:crypto'
import { canonicalJson, sha256Hex } from './canonical.mjs'
// A cycle: loop-text.mjs imports fold and FIELD_LABELS from here and reads them only when
// called, so either module may load first.
import { neutralLine } from '../loop-text.mjs'

// What the STATE.md template's `## Now` holds when no item is in flight; a firing leaves
// exactly this line there (loop section 8).
export const PLACEHOLDER = '(empty)'

const SECTION_END = /^#{1,2}(?:[ \t]|$)/
const LEVEL1 = /^#(?:[ \t]|$)/

// The first non-blank line of the `## Now` section, trimmed; null when the section is
// missing, blank or holds only the template's `(empty)`. The section ends at the next
// level-1 or level-2 heading.
export function nowLine(text) {
  const lines = String(text).split(/\r?\n/)
  const at = lines.findIndex(l => /^## Now[ \t]*$/.test(l))
  if (at < 0) return null
  for (const l of lines.slice(at + 1)) {
    if (SECTION_END.test(l)) return null
    const s = l.trim()
    if (s && s !== PLACEHOLDER) return s
  }
  return null
}

// ---------------------------------------------------------------- vocabulary

// The separator and the none dash, built from their code points (this file is ASCII).
const DOT = String.fromCodePoint(0xb7)
const DASH = String.fromCodePoint(0x2014)
const SEP = ` ${DOT} `

// Every label an item field may carry (R22). `decided` and `no-change-ok` are reserved: parsed
// and moved with the item, never written by the 0c loop, outside both digests.
export const FIELD_LABELS = Object.freeze(['id', 'origin', 'class', 'status', 'blocked-by', 'notes', 'decision', 'attempts', 'recovery', 'decided', 'no-change-ok'])
const KNOWN = new Set(FIELD_LABELS)
// Text fields take continuation lines; every other known label is a one-line control field.
const TEXT = new Set(['notes', 'decision'])

// An item id (R2): `tl-` and 8 characters of lowercase Crockford base32 (no i, l, o, u).
export const ID_RE = /^tl-[0-9a-hjkmnp-tv-z]{8}$/
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
// An id-shaped token anywhere in a text, any case (lowercased before use).
const ID_TOKEN = /(?<![0-9a-z-])tl-[0-9a-hjkmnp-tv-z]{8}(?![0-9a-z-])/gi

const SECTIONS = ['Now', 'Backlog', 'Needs decision', 'Blocked', 'Done', 'Last run']
const ITEM_SECTIONS = new Set(['Now', 'Backlog', 'Blocked', 'Done'])
const OPEN = new Set(['Now', 'Backlog', 'Blocked'])
const ORIGIN_WORDS = new Set(['bootstrap', 'human', 'unknown'])
// Values of blocked-by and status that mean none (R5), compared in lower case.
const NONE = new Set(['', DASH, '-', '--', 'none', 'n/a'])
// The `**Decision:**` placeholder of the `## Needs decision` templates.
const DECISION_PLACEHOLDER = '(fill in to release the task back to the backlog)'

const FIELD = /^( {2,4})- ([a-z][a-z-]*):(?:[ \t](.*))?$/
// A list line naming a known label at any depth: never read as a continuation (it would hide
// a field), so it is malformed there.
const LOOKALIKE = /^\s*[-*+]\s*([a-z][a-z-]*)\s*:/i
// An id-like or origin-like line (R28, R31): the label in any case, after any indent and an
// optional list marker, then a colon; read through fold, so a fullwidth colon counts.
const LIKE = /^\s*(?:[-*+]\s*)?(id|origin)\s*:/i

const isNone = v => NONE.has(v.toLowerCase())
const textValue = v => (v === '' || v === DASH ? '' : v)

// mintId(known, rng = crypto.randomBytes) -> a fresh id: 40 random bits as 8 base32 digits,
// redrawn while `known` (a Set, or any iterable of ids) has it. Throws after 1000 draws (a
// broken rng).
export function mintId(known = new Set(), rng = crypto.randomBytes) {
  const seen = known instanceof Set ? known : new Set(known)
  for (let draw = 0; draw < 1000; draw++) {
    const bytes = rng(5)
    let n = 0
    for (let i = 0; i < 5; i++) n = n * 256 + (bytes[i] ?? 0)
    let s = ''
    for (let i = 0; i < 8; i++) {
      s = ALPHABET[n % 32] + s
      n = Math.floor(n / 32)
    }
    const id = `tl-${s}`
    if (!seen.has(id)) return id
  }
  throw new Error('mintId: 1000 draws were all known ids')
}

// parseOrigin(s) -> {kind: 'bootstrap'|'human'|'unknown', parent: null} or {kind: 'loop',
// parent: <id>} for exactly `loop from <id>` (R9), else null.
export function parseOrigin(s) {
  if (typeof s !== 'string') return null
  if (ORIGIN_WORDS.has(s)) return { kind: s, parent: null }
  const m = /^loop from (\S+)$/.exec(s)
  return m && ID_RE.test(m[1]) ? { kind: 'loop', parent: m[1] } : null
}

// The parents an origin value names for the blocker walk (R9): the parent of a valid `loop
// from`, and for an invalid value every id-shaped token in it.
function originParents(s) {
  const o = parseOrigin(s)
  if (o) return o.parent ? [o.parent] : []
  return [...String(s).matchAll(ID_TOKEN)].map(m => m[0].toLowerCase())
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

// fold(s): Unicode compatibility forms (fullwidth letters and colons) fold to ASCII (NFKC);
// invisible (Default_Ignorable) characters go. loop-text.mjs neutralizes through it.
export function fold(s) {
  return String(s).normalize('NFKC').replace(IGNORABLE, '')
}

// normTitle(t): the key titles are unique by (R7): fold, lower case, whitespace runs to one
// space, trimmed.
export function normTitle(t) {
  return fold(t).toLowerCase().replace(/[\s\x85]+/gu, ' ').trim()
}

// ---------------------------------------------------------------- parsing

// parseState(text) -> {sections, items, entries, problems}.
//   sections  {<name>: {at, start, end}} for the first heading of each of the six names, in
//             file order (0-based line indexes: the heading, the first body line, one past
//             the last); other `## ` sections are not reported
//   items     Item = {section, line, header, title, priority, class, reason, attempts, sha,
//             date, id, origin, originParents, status, blockedBy, notes, decision, recovery,
//             decided, noChangeOk, fields, problems, start, end, lines}. `line` is the 1-based
//             header line; `start`/`end` the 0-based block (trailing blank lines excluded),
//             `lines` its text. `id` is the lowercased id when valid, else null; `sha` is null
//             for the dash; `status`/`blockedBy` null for none; `notes`/`decision` '' when
//             absent or a dash. `fields` = [{label, value, line, at, end}] in order, unknown
//             labels included. `problems` = [{kind, detail}] of the grammar: malformed-field,
//             duplicate-field, invalid-id, invalid-origin, ambiguous-title.
//   entries   Entry = {line, id, title, legacy, variant, decision, filled, recovery, problems,
//             start, end, lines}: `legacy` when the heading's first token is not an id;
//             `variant` panel | delegate-flagged | other; `recovery` {sha, base, itemDigest,
//             scope} (none as null) or null; problems [{kind: 'ambiguous-decision'}] when the
//             entry has several `**Decision:**` lines (then it is not filled).
//   problems  [{kind, ...}] of the file: crlf (then nothing else is parsed), unparsed-line
//             {section, line, text} (in an item section also `end` and `lines`, its block),
//             stray-heading {section, line, text} (a `# ` heading inside an item section, R31),
//             missing-section {name}, duplicate-section {name, line}.
export function parseState(text) {
  text = String(text)
  if (text.includes('\r')) return { sections: {}, items: [], entries: [], problems: [{ kind: 'crlf' }] }
  const lines = text.split('\n')
  const sections = {}, items = [], entries = [], problems = []
  const spans = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    if (!SECTION_END.test(lines[i])) continue
    // A level-1 heading inside an item section does not end it (parseItems reports it, R31).
    if (cur && ITEM_SECTIONS.has(cur.name) && LEVEL1.test(lines[i])) continue
    if (cur) cur.end = i
    const m = /^## (.*?)[ \t]*$/.exec(lines[i])
    cur = m && m[1] ? { name: m[1], at: i, start: i + 1, end: lines.length } : null
    if (cur) spans.push(cur)
  }
  for (const s of spans) {
    if (!SECTIONS.includes(s.name)) continue
    if (sections[s.name]) problems.push({ kind: 'duplicate-section', name: s.name, line: s.at + 1 })
    else sections[s.name] = { at: s.at, start: s.start, end: s.end }
    if (ITEM_SECTIONS.has(s.name)) parseItems(lines, s, items, problems)
    else if (s.name === 'Needs decision') parseEntries(lines, s, entries, problems)
  }
  for (const name of SECTIONS) if (!sections[name]) problems.push({ kind: 'missing-section', name })
  return { sections, items, entries, problems }
}

// The block [start, end) of lines from `from`: the indented and blank lines up to the next
// column-0 line or `limit`, trailing blank lines excluded.
function blockEnd(lines, from, limit) {
  let end = from + 1
  for (let i = from + 1; i < limit; i++) {
    const l = lines[i]
    if (l.trim() === '') continue
    if (!/^[ \t]/.test(l)) break
    end = i + 1
  }
  return end
}

// A column-0 line that continues the item block right above it (R31): text, not a list line,
// a heading or `(empty)`.
const lazyLine = l => l.trim() !== '' && !/^[ \t]/.test(l) && l.trim() !== PLACEHOLDER && !/^(?:[-*+]|\d+[.)])(?:[ \t]|$)/.test(l) && !l.startsWith('#')

function parseItems(lines, span, items, problems) {
  let i = span.start
  while (i < span.end) {
    const l = lines[i]
    if (l.trim() === '' || l.trim() === PLACEHOLDER) {
      i++
      continue
    }
    if (LEVEL1.test(l)) {
      problems.push({ kind: 'stray-heading', section: span.name, line: i + 1, text: l })
      i++
      continue
    }
    let end = blockEnd(lines, i, span.end)
    const head = /^[ \t]/.test(l) ? null : parseHeader(span.name, l.trimEnd())
    if (!head) problems.push({ kind: 'unparsed-line', section: span.name, line: i + 1, text: l, end, lines: lines.slice(i, end) })
    else {
      while (end < span.end && lazyLine(lines[end])) end = blockEnd(lines, end, span.end)
      items.push(buildItem(span.name, lines, i, end, head))
    }
    i = end
  }
}

function parseHeader(section, line) {
  if (section === 'Done') {
    const m = new RegExp(`^- \\[x\\] (.*)${SEP}(\\S+)${SEP}(\\d{4}-\\d{2}-\\d{2})$`).exec(line)
    if (!m) return null
    return { title: m[1].trim(), sha: m[2] === DASH ? null : m[2], date: m[3] }
  }
  const m = /^- \[ \](?: (.*))?$/.exec(line)
  if (!m) return null
  let body = m[1] ?? ''
  if (section === 'Blocked') {
    const k = body.indexOf(`${SEP}attempts: `)
    if (k < 0) return { title: body.trim(), attempts: null, reason: null }
    const rest = body.slice(k + SEP.length + 'attempts: '.length)
    const j = rest.indexOf(SEP)
    return { title: body.slice(0, k).trim(), attempts: (j < 0 ? rest : rest.slice(0, j)).trim(), reason: j < 0 ? null : rest.slice(j + SEP.length) }
  }
  let priority = null
  const p = new RegExp(`^P(\\d+)${SEP}`).exec(body)
  if (p) {
    priority = Number(p[1])
    body = body.slice(p[0].length)
  }
  const k = body.indexOf(`${SEP}class: `)
  if (k < 0) return { priority, title: body.trim(), class: 'unclassified', reason: null }
  const rest = body.slice(k + SEP.length + 'class: '.length)
  const j = rest.indexOf(SEP)
  return { priority, title: body.slice(0, k).trim(), class: (j < 0 ? rest : rest.slice(0, j)).trim(), reason: j < 0 ? null : rest.slice(j + SEP.length) }
}

function ambiguousTitle(t) {
  return t === '' || new RegExp(`^P\\d+${SEP}`).test(t) || t.includes(`${SEP}class: `) || t.includes(`${SEP}attempts: `)
}

function buildItem(section, lines, start, end, head) {
  const problems = []
  const fields = parseFields(lines, start, end, problems)
  const all = label => fields.filter(f => f.label === label)
  const one = label => all(label)[0]?.value ?? null
  for (const label of FIELD_LABELS) {
    if (label !== 'id' && all(label).length > 1) problems.push({ kind: 'duplicate-field', detail: `${label}: is given ${all(label).length} times` })
  }
  let id = null
  const idLines = all('id')
  if (idLines.length > 1) problems.push({ kind: 'invalid-id', detail: `${idLines.length} id: lines` })
  else if (idLines.length === 1) {
    const v = idLines[0].value.toLowerCase()
    if (ID_RE.test(v)) id = v
    else problems.push({ kind: 'invalid-id', detail: `id: ${JSON.stringify(idLines[0].value)} is not a tl- id` })
  }
  const origins = all('origin').map(f => f.value)
  for (const o of origins) if (!parseOrigin(o)) problems.push({ kind: 'invalid-origin', detail: `origin: ${JSON.stringify(o)}` })
  const title = head.title
  if (ambiguousTitle(title)) problems.push({ kind: 'ambiguous-title', detail: title === '' ? 'the title is empty' : `the title ${JSON.stringify(title)} would not survive every header form` })
  const none = v => (v === null || isNone(v) ? null : v)
  return {
    section,
    line: start + 1,
    header: lines[start],
    title,
    priority: head.priority ?? null,
    class: head.class ?? null,
    reason: head.reason ?? null,
    attempts: head.attempts ?? one('attempts'),
    sha: head.sha ?? null,
    date: head.date ?? null,
    id,
    origin: origins[0] ?? null,
    originParents: [...new Set(origins.flatMap(originParents))],
    status: none(one('status')),
    blockedBy: none(one('blocked-by')),
    notes: textValue(one('notes') ?? ''),
    decision: textValue(one('decision') ?? ''),
    recovery: one('recovery'),
    decided: one('decided'),
    noChangeOk: one('no-change-ok'),
    fields,
    problems,
    start,
    end,
    lines: lines.slice(start, end),
  }
}

function parseFields(lines, start, end, problems) {
  const fields = []
  let text = null // the open text field: {field, dash, parts}
  const malformed = (i, why) => problems.push({ kind: 'malformed-field', detail: `line ${i + 1}: ${why}: ${JSON.stringify(lines[i])}` })
  const close = () => {
    if (text) text.field.value = text.parts.join('\n')
    text = null
  }
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      close()
      continue
    }
    if (text) {
      const indent = /^ */.exec(l)[0].length
      if (indent >= text.dash + 2) {
        const look = LOOKALIKE.exec(l)
        if (look && KNOWN.has(look[1].toLowerCase())) malformed(i, 'a field inside a text field\'s continuation')
        else if (LIKE.test(fold(l))) malformed(i, 'an id or origin line inside a text field\'s continuation')
        else {
          text.parts.push(l.trim())
          text.field.end = i + 1
        }
        continue
      }
      close()
    }
    const m = FIELD.exec(l)
    if (!m) {
      malformed(i, fields.length ? 'not a field' : 'a line before the first field')
      continue
    }
    const field = { label: m[2], value: (m[3] ?? '').trim(), line: i + 1, at: i, end: i + 1 }
    fields.push(field)
    if (TEXT.has(m[2])) text = { field, dash: m[1].length, parts: [field.value] }
  }
  close()
  return fields
}

function parseEntries(lines, span, entries, problems) {
  let i = span.start
  while (i < span.end) {
    const l = lines[i]
    if (!/^###(?:[ \t]|$)/.test(l)) {
      if (l.trim() !== '' && l.trim() !== PLACEHOLDER) problems.push({ kind: 'unparsed-line', section: span.name, line: i + 1, text: l })
      i++
      continue
    }
    let end = i + 1
    for (let j = i + 1; j < span.end && !/^###(?:[ \t]|$)/.test(lines[j]); j++) if (lines[j].trim() !== '') end = j + 1
    entries.push(buildEntry(lines, i, end))
    let next = end
    while (next < span.end && !/^###(?:[ \t]|$)/.test(lines[next])) next++
    i = next
  }
}

function buildEntry(lines, start, end) {
  const heading = lines[start].replace(/^###[ \t]*/, '').trim()
  const token = heading.split(/\s/)[0]
  const isId = ID_RE.test(token.toLowerCase())
  let title = heading
  if (isId) {
    title = heading.slice(token.length).trim()
    if (title.startsWith(`${DOT} `) || title === DOT) title = title.slice(1).trim()
  }
  const body = lines.slice(start + 1, end)
  const starts = p => body.some(l => l.startsWith(p))
  const variant = starts('**Recommendation:**') ? 'panel' : starts('**Flagged by:**') ? 'delegate-flagged' : 'other'
  const problems = []
  const at = body.flatMap((l, k) => (l.startsWith('**Decision:**') ? [k] : []))
  let decision = '', filled = false
  if (at.length > 1) problems.push({ kind: 'ambiguous-decision', detail: `${at.length} **Decision:** lines` })
  else if (at.length === 1) {
    const own = body[at[0]].slice('**Decision:**'.length).trim()
    const parts = [own]
    for (let k = at[0] + 1; k < body.length && !body[k].startsWith('**'); k++) parts.push(body[k].trim())
    decision = parts.filter(Boolean).join(' ')
    filled = decision !== '' && own !== DECISION_PLACEHOLDER
  }
  let recovery = null
  const rec = body.find(l => l.startsWith('**Recovery:**'))
  if (rec) {
    const m = new RegExp(`^\\*\\*Recovery:\\*\\* (\\S+)${SEP}base (\\S+)${SEP}item-digest (\\S+)${SEP}scope (\\S+)$`).exec(rec.trimEnd())
    const v = s => (s === 'none' ? null : s)
    if (m) recovery = { sha: v(m[1]), base: v(m[2]), itemDigest: v(m[3]), scope: v(m[4]) }
  }
  return {
    line: start + 1,
    id: isId ? token.toLowerCase() : null,
    title,
    legacy: !isId,
    variant,
    decision,
    filled,
    recovery,
    problems,
    start,
    end,
    lines: lines.slice(start, end),
  }
}

// nowItem(text) -> the first `## Now` item (an Item), or null.
export function nowItem(text) {
  return parseState(text).items.find(i => i.section === 'Now') ?? null
}

// ---------------------------------------------------------------- digests

// itemDigest(item) = sha256Hex(canonicalJson({id, title, notes, decision})) and
// approvedDigest(item) = the same without the id (R6), over the R5 values as parseState reads
// them (no Unicode normalization). Every other field (class, status, origin, decided, ...)
// is outside both.
export function itemDigest(item) {
  return sha256Hex(canonicalJson({ id: item.id ?? null, title: item.title, notes: item.notes ?? '', decision: item.decision ?? '' }))
}

export function approvedDigest(item) {
  return sha256Hex(canonicalJson({ title: item.title, notes: item.notes ?? '', decision: item.decision ?? '' }))
}

// ---------------------------------------------------------------- problems, eligibility, blockers

// The ledger as ledger.mjs's ledgerItems returns it: {ids: Set, doneIds: Set, origins: Map}.
// null or undefined reads as an empty ledger.
function asLedger(l) {
  if (l === null || l === undefined) return { ids: new Set(), doneIds: new Set(), origins: new Map() }
  const set = v => (v instanceof Set ? v : new Set(v ?? []))
  return { ids: set(l.ids), doneIds: set(l.doneIds), origins: l.origins instanceof Map ? l.origins : new Map(Object.entries(l.origins ?? {})) }
}

const where = it => `${it.section} line ${it.line}`
const nameOf = it => it.id ?? where(it)

// The id-like and origin-like lines of a block (R28, R31): [{label: 'id'|'origin', at, tokens}],
// `at` the 0-based line index, `tokens` the distinct lowercased id tokens on the line.
function likeRows(lines, start) {
  const rows = []
  lines.forEach((l, k) => {
    const f = fold(l)
    const m = LIKE.exec(f)
    if (m) rows.push({ label: m[1].toLowerCase(), at: start + k, tokens: [...new Set([...f.matchAll(ID_TOKEN)].map(x => x[0].toLowerCase()))] })
  })
  return rows
}

// What every rule below reads from one state and ledger: the parsed carriers of each id, its
// raw carriers (R28: id tokens on id-like lines that are not an item's own valid `id:` field),
// the interrupted-move pair (a `## Now` item whose id exactly one item in another section also
// carries: the recovery planner's clear-now resolves it, R8, R20), every item block and
// unparsed block with the ids it carries and the parents its origin and origin-like lines name,
// and the loop-from parents of each id through those blocks and the ledger's origins (R11, R12).
function context(state, ledger) {
  const L = asLedger(ledger)
  const carriers = new Map()
  for (const it of state.items) if (it.id) carriers.set(it.id, [...(carriers.get(it.id) ?? []), it])
  const moved = new Set()
  for (const it of state.items) {
    const c = it.section === 'Now' && it.id ? carriers.get(it.id) : null
    if (c && c.length === 2 && c.every(x => x === it || x.section !== 'Now')) for (const x of c) moved.add(x)
  }
  const blocks = state.items.map(it => ({ section: it.section, item: it, start: it.start, lines: it.lines }))
  for (const p of state.problems) {
    if (p.kind === 'unparsed-line' && ITEM_SECTIONS.has(p.section) && p.lines) blocks.push({ section: p.section, item: null, start: p.line - 1, lines: p.lines })
  }
  const raw = new Map(), likes = new Map()
  for (const b of blocks) {
    b.ids = new Set(b.item?.id ? [b.item.id] : [])
    b.parents = new Set(b.item?.originParents ?? [])
    const rows = likeRows(b.lines, b.start)
    if (b.item) likes.set(b.item, rows)
    for (const r of rows) {
      if (r.label === 'origin') for (const t of r.tokens) b.parents.add(t)
      else if (!(b.item?.id && b.item.fields.some(f => f.label === 'id' && f.at === r.at))) {
        for (const t of r.tokens) {
          b.ids.add(t)
          raw.set(t, [...(raw.get(t) ?? []), { section: b.section, line: r.at + 1, block: b }])
        }
      }
    }
  }
  for (const rows of raw.values()) rows.sort((x, y) => x.line - y.line)
  const openBlocks = blocks.filter(b => OPEN.has(b.section))
  const parentsOf = id => {
    const out = new Set()
    for (const b of blocks) if (b.ids.has(id)) for (const p of b.parents) out.add(p)
    const o = L.origins.get(id)
    if (typeof o === 'string') for (const p of originParents(o)) out.add(p)
    return out
  }
  // Does a walk up the loop-from chain from `parents` reach `target`? Cycle-safe.
  const reaches = (parents, target) => {
    const stack = [...parents], seen = new Set()
    while (stack.length) {
      const p = stack.pop()
      if (p === target) return true
      if (seen.has(p)) continue
      seen.add(p)
      stack.push(...parentsOf(p))
    }
    return false
  }
  return { L, carriers, raw, likes, moved, openBlocks, parentsOf, reaches }
}

function status(state, ctx, id) {
  if (!ID_RE.test(id)) return 'unknown'
  const carriers = ctx.carriers.get(id) ?? []
  const raw = ctx.raw.get(id) ?? []
  if (!carriers.length && !raw.length && !ctx.L.ids.has(id)) return 'unknown'
  if (carriers.some(i => OPEN.has(i.section)) || raw.some(r => OPEN.has(r.section))) return 'unfinished'
  if (!carriers.some(i => i.section === 'Done') && !ctx.L.doneIds.has(id)) return 'unfinished'
  for (const b of ctx.openBlocks) if (ctx.reaches(b.parents, id)) return 'unfinished'
  return 'finished'
}

// blockerStatus(state, id, ledger) -> 'finished' | 'unfinished' | 'unknown' (R11, R28).
// `unknown`: not an id, or an id no item, no raw line and no ledger row carries. `finished`:
// no open item and no raw line in an open section carries the id; a parsed `## Done` item has
// it or the ledger records it done; and no open block descends from it through `loop from`
// origins and origin-like lines (open blocks', Done blocks' and the ledger's, a cycle stops the
// walk). Anything else is `unfinished`.
export function blockerStatus(state, id, ledger) {
  return status(state, context(state, ledger), String(id ?? '').toLowerCase())
}

// idCarriers(state, id) -> {parsed: Item[], raw: [{section, line}]} (R28): the items whose id
// is `id` (any section, file order) and every raw carrier of it (an id-like line in an item
// section holding its token that is not an item's own valid `id:` field; 1-based lines, in
// order). loop-items.mjs refuses an id with more than one carrier, raw ones included. Not an
// id: both empty.
export function idCarriers(state, id) {
  const v = String(id ?? '').toLowerCase()
  if (!ID_RE.test(v)) return { parsed: [], raw: [] }
  const ctx = context(state, null)
  return { parsed: state.items.filter(i => i.id === v), raw: (ctx.raw.get(v) ?? []).map(r => ({ section: r.section, line: r.line })) }
}

// The problems of every item, in file order: the grammar's (parseState), then no-id,
// duplicate-id, duplicate-title, origin-cycle, title-blocker, unknown-blocker, self-blocker.
function analyze(state, ctx) {
  const out = new Map()
  const openKey = new Map()
  for (const it of state.items) {
    if (!OPEN.has(it.section) || it.title === '') continue
    // The interrupted-move pair is one item: its `## Now` copy holds no title of its own.
    if (it.section === 'Now' && ctx.moved.has(it)) continue
    const k = normTitle(it.title)
    openKey.set(k, [...(openKey.get(k) ?? []), it])
  }
  for (const it of state.items) {
    const ps = [...it.problems]
    // An item holding an id-like line that is not a field is malformed-field, not id-less (R31).
    if (!(ctx.likes.get(it) ?? []).some(r => r.label === 'id')) ps.push({ kind: 'no-id', detail: 'no id: line (normalize mints one)' })
    const same = it.id ? ctx.carriers.get(it.id) : []
    const rawElse = it.id ? (ctx.raw.get(it.id) ?? []).filter(r => r.block.item !== it) : []
    if ((same.length > 1 && !ctx.moved.has(it)) || rawElse.length) {
      const others = [...(same.length > 1 && !ctx.moved.has(it) ? same.filter(x => x !== it).map(where) : []), ...rawElse.map(r => `${r.section} line ${r.line}`)]
      ps.push({ kind: 'duplicate-id', detail: `${it.id} is also carried by ${others.join(', ')}` })
    }
    const dup = OPEN.has(it.section) && it.title !== '' && !(it.section === 'Now' && ctx.moved.has(it)) ? openKey.get(normTitle(it.title)) : null
    if (dup && dup.length > 1) {
      ps.push({ kind: 'duplicate-title', detail: `the open title is also carried by ${dup.filter(x => x !== it).map(nameOf).join(', ')}` })
    }
    if (it.id && ctx.reaches(ctx.parentsOf(it.id), it.id)) ps.push({ kind: 'origin-cycle', detail: `the loop from chain of ${it.id} returns to it` })
    if (it.blockedBy !== null) ps.push(...blockerProblems(state, ctx, it))
    out.set(it, ps)
  }
  return out
}

function blockerProblems(state, ctx, it) {
  const v = it.blockedBy.toLowerCase()
  if (ID_RE.test(v)) {
    if (v === it.id) return [{ kind: 'self-blocker', detail: `blocked-by: names the item's own id ${v}` }]
    if (!ctx.carriers.has(v) && !ctx.raw.has(v) && !ctx.L.ids.has(v)) return [{ kind: 'unknown-blocker', detail: `no item and no ledger row carries ${v}` }]
    return []
  }
  // A title (or several ids): never resolved by the loop (A12). Name the candidate when exactly
  // one open item, or with no open match exactly one `## Done` item, has that title.
  const key = normTitle(it.blockedBy)
  const openMatch = state.items.filter(i => OPEN.has(i.section) && i !== it && normTitle(i.title) === key)
  const doneMatch = state.items.filter(i => i.section === 'Done' && normTitle(i.title) === key)
  let candidate = null, hint = ''
  if (openMatch.length === 1) candidate = openMatch[0].id
  else if (openMatch.length === 0 && doneMatch.length === 1) {
    candidate = doneMatch[0].id
    if (doneMatch[0].sha === null) hint = ' (an analysis item; its follow-up may still be open)'
  }
  const detail = `blocked-by: ${JSON.stringify(it.blockedBy)} is not an id; replace it with the blocker's id` +
    (candidate ? `; candidate ${candidate}${hint}` : '')
  return [{ kind: 'title-blocker', detail, candidate }]
}

// itemProblems(state, ledger) -> [{section, line, id, title, kind, detail, candidate?}]: every
// problem of every item (the grammar's and the rules' above), the file's problems
// (unparsed-line, missing-section, duplicate-section; id and title null), and each legacy
// `## Needs decision` heading (`legacy-entry`, with the candidate id when exactly one item has
// that title). Problems a person made are reported here; nothing is rewritten.
export function itemProblems(state, ledger) {
  const ctx = context(state, ledger)
  const rows = []
  for (const p of state.problems) {
    if (p.kind === 'crlf') rows.push({ section: null, line: null, id: null, title: null, kind: 'crlf', detail: 'STATE.md holds a carriage return' })
    else rows.push({ section: p.section ?? p.name ?? null, line: p.line ?? null, id: null, title: null, kind: p.kind, detail: p.text ?? p.name })
  }
  for (const [it, ps] of analyze(state, ctx)) {
    for (const p of ps) rows.push({ section: it.section, line: it.line, id: it.id, title: it.title, kind: p.kind, detail: p.detail, ...(p.candidate !== undefined ? { candidate: p.candidate } : {}) })
  }
  for (const e of state.entries) if (e.legacy) rows.push({ section: 'Needs decision', line: e.line, id: null, title: e.title, ...legacyEntry(state, e) })
  return rows
}

function legacyEntry(state, e) {
  const match = state.items.filter(i => normTitle(i.title) === normTitle(e.title))
  const candidate = match.length === 1 ? match[0].id : null
  return { kind: 'legacy-entry', detail: `the heading is not "### <id> ${DOT} <title>"${candidate ? `; candidate ${candidate}` : ''}`, candidate }
}

// The level a class needs before a `waiting-level` item is picked again: mechanical runs at
// level 2, hard at level 3, high-stakes (the panel) at any level; any other class needs 3.
const LEVEL_NEEDS = { mechanical: 2, hard: 3, 'high-stakes': 1 }
const levelOf = v => {
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1
}
const permits = (cls, level) => levelOf(level) >= (LEVEL_NEEDS[cls] ?? 3)

// Ordered: the first problem an item has, in this order, is its reason.
const REASONS = ['no-id', 'invalid-id', 'duplicate-id', 'malformed-field', 'duplicate-field', 'ambiguous-title', 'duplicate-title',
  'invalid-origin', 'origin-cycle', 'title-blocker', 'unknown-blocker', 'self-blocker']

// eligibility(state, {ledger, level}) -> [{id, title, section, line, ok, reason, detail}], one
// row per `## Backlog` item and per unparsed `## Backlog` line, in file order (R13). An item is
// eligible when it has a valid id no other item carries, a unique open title, no problem
// (REASONS), a status of none (or `waiting-level` once `level`, 1 to 3 from LOOP.md, permits
// its class; anything else reads as 1) and a finished blocker. `reason` is null when ok, else
// one of REASONS, `status`, `blocked` or `unparsed-line`.
export function eligibility(state, { ledger = null, level = 1 } = {}) {
  const ctx = context(state, ledger)
  const problems = analyze(state, ctx)
  const rows = []
  for (const p of state.problems) {
    if (p.kind === 'unparsed-line' && p.section === 'Backlog') {
      rows.push({ id: null, title: p.text.trim(), section: 'Backlog', line: p.line, ok: false, reason: 'unparsed-line', detail: `line ${p.line} is not an item` })
    }
  }
  for (const it of state.items) {
    if (it.section !== 'Backlog') continue
    const row = { id: it.id, title: it.title, section: it.section, line: it.line, ok: false, reason: null, detail: null }
    const ps = problems.get(it)
    const first = REASONS.map(r => ps.find(p => p.kind === r)).find(Boolean)
    if (first) Object.assign(row, { reason: first.kind, detail: first.detail })
    else if (it.status !== null && !(it.status === 'waiting-level' && permits(it.class, level))) {
      Object.assign(row, { reason: 'status', detail: `status: ${it.status}${it.status === 'waiting-level' ? ` (level ${levelOf(level)} does not permit class ${it.class})` : ''}` })
    } else if (it.blockedBy !== null && status(state, ctx, it.blockedBy.toLowerCase()) !== 'finished') {
      Object.assign(row, { reason: 'blocked', detail: `blocker ${it.blockedBy.toLowerCase()} is unfinished` })
    } else row.ok = true
    rows.push(row)
  }
  return rows.sort((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------- edits

const occurrences = (hay, needle) => {
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++
  return n
}

// applyEdits(text, edits) -> the text with each {old, new} applied in order: `old` must occur
// exactly once in the text it applies to (overlapping occurrences count) and no longer occur
// once replaced; otherwise it throws `edit-anchor: ...` and nothing is returned. The one
// implementation the CLI and the tests use, mirroring the main session's Edit tool.
export function applyEdits(text, edits) {
  let t = String(text)
  edits.forEach((e, k) => {
    if (!e || typeof e.old !== 'string' || typeof e.new !== 'string' || e.old === '') throw new Error(`edit-anchor: edit ${k + 1} is not {old, new} with a non-empty old`)
    const n = occurrences(t, e.old)
    if (n !== 1) throw new Error(`edit-anchor: edit ${k + 1}: old occurs ${n} times`)
    const i = t.indexOf(e.old)
    const next = t.slice(0, i) + e.new + t.slice(i + e.old.length)
    if (occurrences(next, e.old) !== 0) throw new Error(`edit-anchor: edit ${k + 1}: old survives its edit`)
    t = next
  })
  return t
}

// An edit plan over a working copy of the text (R14). splice(a, b, lines, {tail}) replaces the
// lines [a, b) with `lines` through one anchored edit: the anchor starts as those lines (for an
// insertion, the line after the insertion point; with `tail`, also every line after them up to
// and including the next non-blank one, R31) and widens with preceding lines, then following
// ones, until it occurs once and not after its edit.
class Plan {
  constructor(text) {
    this.start = text
    this.text = text
    this.edits = []
  }

  get lines() {
    return this.text.split('\n')
  }

  splice(a, b, repl, { tail = false } = {}) {
    const lines = this.lines
    if (b - a === repl.length && repl.every((l, k) => l === lines[a + k])) return
    // After the last line of a file with no final newline, the old text would survive any
    // anchored insertion (R14): refused, the file needs its final newline.
    if (a === lines.length) throw new Error('edit-anchor: an insertion after the last line of a file with no final newline')
    const unit = i => lines[i] + (i < lines.length - 1 ? '\n' : '')
    const piece = (s, e) => {
      let o = ''
      for (let i = s; i < e; i++) o += unit(i)
      return o
    }
    const added = repl.map(l => `${l}\n`).join('')
    let s = a, e = Math.min(Math.max(b, a + 1), lines.length)
    if (tail && b > a) {
      let k = b
      while (k < lines.length && lines[k].trim() === '') k++
      e = Math.min(k + 1, lines.length)
    }
    for (;;) {
      const old = piece(s, e)
      const nu = piece(s, a) + added + piece(b, e)
      if (old !== '' && occurrences(this.text, old) === 1) {
        const i = this.text.indexOf(old)
        const next = this.text.slice(0, i) + nu + this.text.slice(i + old.length)
        if (occurrences(next, old) === 0) {
          this.edits.push({ old, new: nu })
          this.text = next
          return
        }
      }
      if (s > 0) s--
      else if (e < lines.length) e++
      else throw new Error('edit-anchor: no unique anchor for an edit')
    }
  }

  // The plan's result: {edits, expect_sha256}; the edits are replayed through applyEdits.
  done() {
    if (applyEdits(this.start, this.edits) !== this.text) throw new Error('edit-anchor: the edits do not replay to the planned text')
    return { edits: this.edits, expect_sha256: sha256Hex(this.text) }
  }
}

const indentOf = l => /^ */.exec(l)[0]
// The indentation of an item's fields: its first field's, or two spaces.
const fieldIndent = it => (it.fields.length ? indentOf(it.lines[it.fields[0].at - it.start]) : '  ')

// Inserts `block` at the top of section `name`, in place of its `(empty)` line when that is
// the section's first non-blank line.
function insertTop(plan, name, block) {
  const s = parseState(plan.text).sections[name]
  const lines = plan.lines
  let first = s.start
  while (first < s.end && lines[first].trim() === '') first++
  if (first < s.end && lines[first].trim() === PLACEHOLDER) plan.splice(first, first + 1, block)
  else plan.splice(s.start, s.start, block)
}

// Deletes the block [start, end) of section `name`; a section left with no other non-blank
// line gets `(empty)` in its place. The anchor runs through the next non-blank line after the
// block (R31, Claude EP1): a line a person adds to the block between plan and apply makes the
// Edit fail (`old` not found) instead of staying behind as a line of the block above.
function deleteBlock(plan, name, start, end) {
  const s = parseState(plan.text).sections[name]
  const lines = plan.lines
  let rest = false
  for (let i = s.start; i < s.end; i++) if ((i < start || i >= end) && lines[i].trim() !== '') rest = true
  plan.splice(start, end, rest ? [] : [PLACEHOLDER], { tail: true })
}

// planDeleteBlock(text, name, start, end) -> {edits, expect_sha256}: the anchored deletion of
// the block [start, end) (0-based lines, as an Item's start and end) from section `name`, with
// `(empty)` in its place when nothing else is left there, anchored through the next non-blank
// line (deleteBlock). loop-recover.mjs prints it for clear-now, which deletes only the `## Now`
// item's block (fix manifest R29). Throws when the text has no such section or the block is
// not inside it.
export function planDeleteBlock(text, name, start, end) {
  text = String(text)
  const s = parseState(text).sections[name]
  if (!s || !Number.isInteger(start) || !Number.isInteger(end) || start < s.start || end > s.end || end <= start) {
    throw new RangeError(`planDeleteBlock: no block [${start}, ${end}) inside ## ${name}`)
  }
  const plan = new Plan(text)
  deleteBlock(plan, name, start, end)
  return plan.done()
}

// The refusal every planner returns: nothing to apply.
const refusal = (reason, detail, extra = {}) => ({ state: 'refused', reason, detail, edits: [], expect_sha256: null, ...extra })

// The structural refusals: a carriage return, or a section the plan needs that is missing or
// given twice.
function structural(st, need) {
  if (st.problems.some(p => p.kind === 'crlf')) return ['crlf', 'STATE.md holds a carriage return; convert it to LF line endings']
  const dup = st.problems.find(p => p.kind === 'duplicate-section' && p.name !== 'Last run')
  if (dup) return ['bad-sections', `## ${dup.name} appears twice (line ${dup.line})`]
  const miss = need.find(n => !st.sections[n])
  if (miss) return ['bad-sections', `STATE.md has no ## ${miss} section`]
  return null
}

// Every id STATE.md, the caller and the ledger know (R2): the given ids, the ledger's, and
// every id-shaped token anywhere in the text (items in every section, entry headings, blockers,
// origins, `## Last run`), lowercased.
function knownIds(text, known, ledger) {
  const out = new Set()
  for (const id of known ?? []) out.add(String(id).toLowerCase())
  for (const id of asLedger(ledger).ids) out.add(String(id).toLowerCase())
  for (const m of String(text).matchAll(ID_TOKEN)) out.add(m[0].toLowerCase())
  return out
}

// ---------------------------------------------------------------- normalize

// planNormalize(text, {known, missingOrigin = 'unknown', ledger, rng}) -> {state: 'ok', edits,
// expect_sha256, minted, origins, problems} (R1). For every item in every section: an item with
// no id-like line gets a minted id (first under the header), an item with no origin-like line
// gets `origin: <missingOrigin>` (second, or under its id line), and an id written in upper case
// is rewritten to lowercase (R2). An id-like or origin-like line that is not a well-formed
// field (a tab indent, `* id:`, `- ID:`, `- id :`) is a person's lookalike: it is reported
// (malformed-field) and never minted over (R31). Nothing else a person wrote (an id, origin,
// title, blocker) is rewritten; `problems` (itemProblems of the result) reports it. `known` (ids from the ledger)
// joins knownIds; `missingOrigin` is bootstrap, human or unknown. `minted` lists the new ids in
// file order, `origins` the ids of the items whose origin was filled. A carriage return
// refuses: {state: 'refused', reason: 'crlf'}.
export function planNormalize(text, { known = [], missingOrigin = 'unknown', ledger = null, rng = crypto.randomBytes } = {}) {
  if (!ORIGIN_WORDS.has(missingOrigin)) throw new TypeError(`planNormalize: missingOrigin must be bootstrap, human or unknown, not ${JSON.stringify(missingOrigin)}`)
  text = String(text)
  const st = parseState(text)
  if (st.problems.some(p => p.kind === 'crlf')) return refusal('crlf', 'STATE.md holds a carriage return; convert it to LF line endings', { minted: [], origins: [], problems: itemProblems(st, ledger) })
  const seen = knownIds(text, known, ledger)
  const work = st.items.map(it => {
    const likes = likeRows(it.lines, it.start)
    const idLine = it.fields.find(f => f.label === 'id') ?? null
    const id = likes.some(r => r.label === 'id') ? null : mintId(seen, rng)
    if (id) seen.add(id)
    const lower = idLine && idLine.value !== idLine.value.toLowerCase() && ID_RE.test(idLine.value.toLowerCase()) ? idLine.value.toLowerCase() : null
    return { it, idLine, id, lower, origin: !likes.some(r => r.label === 'origin') }
  })
  const plan = new Plan(text)
  const ORIGIN = ind => `${ind}- origin: ${missingOrigin}`
  // Bottom-up, so the lines above each edit keep their indexes.
  for (const w of [...work].reverse()) {
    const ind = fieldIndent(w.it)
    if (w.idLine) {
      const at = w.idLine.at
      if (w.lower) plan.splice(at, at + 1, [`${indentOf(plan.lines[at])}- id: ${w.lower}`])
      if (w.origin) plan.splice(at + 1, at + 1, [ORIGIN(indentOf(plan.lines[at]))])
    } else if (!w.id) {
      // An id lookalike and no field: only the missing origin, first under the header.
      if (w.origin) plan.splice(w.it.start + 1, w.it.start + 1, [ORIGIN(ind)])
    } else {
      plan.splice(w.it.start + 1, w.it.start + 1, [`${ind}- id: ${w.id}`, ...(w.origin ? [ORIGIN(ind)] : [])])
    }
  }
  const out = plan.done()
  return {
    state: 'ok',
    ...out,
    minted: work.filter(w => w.id).map(w => w.id),
    origins: work.filter(w => w.origin && (w.id ?? w.it.id)).map(w => w.id ?? w.it.id),
    problems: itemProblems(parseState(plan.text), ledger),
  }
}

// ---------------------------------------------------------------- the section 3.1 release

// `<old>; then: <d1>; then: <d2> ...`: a later decision never erases an earlier one (R16). A
// sequence the item already ends with is not appended again (R30): the release appends every
// filled entry's decision in one item edit and then deletes the entries in file order, so a
// release interrupted before or between the entry deletions runs again with the whole
// sequence, or the suffix of it whose entries remain, already at the end of the decision.
function appendDecisions(old, ds) {
  if (!ds.length) return old
  const seq = ds.join('; then: ')
  if (old === '') return seq
  if (old === seq || old.endsWith(`; then: ${seq}`)) return old
  return `${old}; then: ${seq}`
}

// The item's block as the release leaves it: the Backlog header form with `class: hard` (a
// Backlog item keeps its priority; the class reason and a Blocked header's attempts and reason
// go), `decision:` set or appended (in place, or as a new last field at two spaces, which is
// outside any continuation above it, R30), a set `status:` cleared to the dash; every other
// line kept.
function releaseBlock(it, decisions) {
  const dec = appendDecisions(it.decision, decisions)
  const [first, ...rest] = dec.split('\n')
  const decLines = [`  - decision: ${first}`, ...rest.map(l => `    ${l}`)]
  const ops = []
  const df = it.fields.find(f => f.label === 'decision')
  ops.push(df ? [df.at, df.end, [`${indentOf(it.lines[df.at - it.start])}- decision: ${first}`, ...rest.map(l => `${indentOf(it.lines[df.at - it.start])}  ${l}`)]] : [it.end, it.end, decLines])
  const sf = it.fields.find(f => f.label === 'status')
  if (sf && it.status !== null) ops.push([sf.at, sf.end, [`${indentOf(it.lines[sf.at - it.start])}- status: ${DASH}`]])
  const body = [...it.lines]
  for (const [a, b, repl] of ops.sort((x, y) => y[0] - x[0])) body.splice(a - it.start, b - a, ...repl)
  body[0] = `- [ ] ${it.section === 'Backlog' && it.priority !== null ? `P${it.priority}${SEP}` : ''}${it.title}${SEP}class: hard`
  return body
}

const sameLines = (a, b) => a.length === b.length && a.every((l, k) => l === b[k])
const GRAMMAR = new Set(['malformed-field', 'duplicate-field', 'invalid-id'])

// What the release does for entry id `id` in `state`: null when no `panel` or
// `delegate-flagged` entry for it is filled; {skip, title, detail} when it refuses (R16:
// ambiguous-decision, orphan-entry, entry-item-done, ambiguous-carrier, an item in `## Now`, an
// item whose block it cannot read, or an ambiguous-title item, whose title the Backlog header
// would change, R30); otherwise {item, decisions, resume}. `resume` is the
// `## Backlog` copy of an interrupted Blocked -> Backlog move (it equals the released block),
// whose Blocked copy only needs deleting. `ambiguous-carrier` (R30a): the id has a raw carrier
// (idCarriers), checked before the resume shortcut, or more than one parsed carrier that is not
// that resume pair; which copy the person means is theirs to say, so the entry stays.
function releaseFor(state, id) {
  const es = state.entries.filter(e => e.id === id && e.variant !== 'other')
  const filled = es.filter(e => e.filled)
  const title = (filled[0] ?? es[0])?.title ?? ''
  if (es.some(e => e.problems.length)) return { skip: 'ambiguous-decision', title, detail: `an entry for ${id} has several **Decision:** lines` }
  if (!filled.length) return null
  const decisions = filled.map(e => e.decision)
  const { parsed: carriers, raw } = idCarriers(state, id)
  if (raw.length) {
    const at = [...carriers.map(where), ...raw.map(r => `${r.section} line ${r.line} (an id line that does not parse to it)`)]
    return { skip: 'ambiguous-carrier', title, detail: `${id} is carried by ${at.join(', ')}; the entry stays` }
  }
  if (!carriers.length) return { skip: 'orphan-entry', title, detail: `no item carries ${id}; the entry stays` }
  if (carriers.length === 2) {
    const bl = carriers.find(i => i.section === 'Blocked'), bk = carriers.find(i => i.section === 'Backlog')
    if (bl && bk && sameLines(bk.lines, releaseBlock(bl, decisions))) return { item: bl, decisions, resume: bk }
  }
  if (carriers.length > 1) return { skip: 'ambiguous-carrier', title, detail: `${id} is carried by ${carriers.map(where).join(', ')}; the entry stays` }
  const [it] = carriers
  if (it.section === 'Done') return { skip: 'entry-item-done', title, detail: `${id} is in ## Done; the entry stays` }
  if (it.section === 'Now') return { skip: 'entry-item-now', title, detail: `${id} is in ## Now` }
  const bad = it.problems.find(p => GRAMMAR.has(p.kind))
  if (bad) return { skip: bad.kind, title, detail: `the item cannot be read to release it: ${bad.detail}` }
  const amb = it.problems.find(p => p.kind === 'ambiguous-title')
  if (amb) return { skip: 'ambiguous-title', title, detail: `${amb.detail}; the entry stays until the title is changed` }
  return { item: it, decisions, resume: null }
}

// releasedItem(state, entryId) -> the Item as the section 3.1 release would leave it (in
// `## Backlog`; line, start and end null), so its digests can be computed before a firing
// applies the release (R6); null when the release would not release it.
export function releasedItem(state, entryId) {
  const id = String(entryId ?? '').toLowerCase()
  if (!ID_RE.test(id)) return null
  const r = releaseFor(state, id)
  if (!r || r.skip) return null
  const it = parseState(`## Backlog\n${releaseBlock(r.item, r.decisions).join('\n')}\n`).items[0]
  return { ...it, line: null, start: null, end: null }
}

// ---------------------------------------------------------------- pick

// The `## Done` items the ledger does not record as done (R27), as [{item_id, item_origin}] in
// file order, once per id: the firing's ledger row carries them as `done_items`, so their ids
// and origins outlive the trim. An id-less Done item has nothing to record. `ledger` is
// ledgerItems' object, done_items already counted in its doneIds.
function unledgeredOf(st, ledger) {
  const L = asLedger(ledger)
  const out = [], seen = new Set()
  for (const it of st.items) {
    if (it.section !== 'Done' || !it.id || L.doneIds.has(it.id) || seen.has(it.id)) continue
    seen.add(it.id)
    out.push({ item_id: it.id, item_origin: it.origin })
  }
  return out
}

// planPick(text, {ledger, level}) -> the section 3 pick as edits (R13, R16):
//   {state: 'picked', id, title, from: 'decision'|'backlog', digest, released, edits,
//    expect_sha256, skipped, unledgered}  or  {state: 'dry', released, edits, expect_sha256,
//    skipped, unledgered}
// First the release: for each id (in file order) with a filled `panel` or `delegate-flagged`
// entry, the item in `## Backlog` or `## Blocked` gets the decision (appended with `; then:`),
// its status cleared and class `hard`; a Blocked item is inserted at the top of `## Backlog`
// and then deleted from `## Blocked`; then every panel and delegate-flagged entry for the id is
// deleted (the unfilled ones first). `other` entries are never touched. Then the pick: the
// first eligible released item, else the first eligible `## Backlog` item (eligibility, on the
// released state), moved to `## Now` in place of its `(empty)` (a `waiting-level` status
// cleared): inserted there first, then deleted from `## Backlog`. `skipped` lists each release
// refusal (legacy-entry, ambiguous-decision, orphan-entry, entry-item-done, ambiguous-carrier, ...)
// and each ineligible item passed over before the pick (all of them when dry), as {id, title,
// reason, detail}. `digest` is the picked item's itemDigest. `unledgered` (every answer, the
// refusals included) lists the `## Done` items the ledger lacks (R27, unledgeredOf). Refused,
// with no edits: `crlf`, `bad-sections` (no `## Now` or `## Backlog`, or a repeated section),
// `now-occupied` (a `## Now` line, or an item parsed in `## Now` below a stray heading).
export function planPick(text, { ledger = null, level = 1 } = {}) {
  text = String(text)
  const st = parseState(text)
  const unledgered = unledgeredOf(st, ledger)
  const bad = structural(st, ['Now', 'Backlog'])
  if (bad) return refusal(...bad, { released: [], skipped: [], unledgered })
  const busy = nowLine(text) ?? st.items.find(i => i.section === 'Now')?.header ?? null
  if (busy !== null) return refusal('now-occupied', `## Now holds ${JSON.stringify(busy)}; the recovery planner resolves it first`, { released: [], skipped: [], unledgered })
  const plan = new Plan(text)
  const released = [], skipped = []
  for (const e of st.entries) {
    if (e.legacy && e.filled && e.variant !== 'other') skipped.push({ id: null, title: e.title, reason: 'legacy-entry', detail: legacyEntry(st, e).detail })
  }
  const ids = [...new Set(st.entries.filter(e => e.id && e.variant !== 'other').map(e => e.id))]
  for (const id of ids) {
    const r = releaseFor(parseState(plan.text), id)
    if (!r) continue
    if (r.skip) {
      skipped.push({ id, title: r.title, reason: r.skip, detail: r.detail })
      continue
    }
    if (r.resume) deleteBlock(plan, 'Blocked', r.item.start, r.item.end)
    else if (r.item.section === 'Backlog') plan.splice(r.item.start, r.item.end, releaseBlock(r.item, r.decisions))
    else {
      insertTop(plan, 'Backlog', releaseBlock(r.item, r.decisions))
      const copy = parseState(plan.text).items.find(i => i.id === id && i.section === 'Blocked')
      deleteBlock(plan, 'Blocked', copy.start, copy.end)
    }
    released.push(id)
  }
  for (const id of released) {
    for (;;) {
      const es = parseState(plan.text).entries.filter(e => e.id === id && e.variant !== 'other')
      if (!es.length) break
      const e = es.find(x => !x.filled) ?? es[0]
      deleteBlock(plan, 'Needs decision', e.start, e.end)
    }
  }
  const after = parseState(plan.text)
  const rows = eligibility(after, { ledger, level })
  const order = [...released.flatMap(id => rows.filter(r => r.id === id)), ...rows.filter(r => !released.includes(r.id))]
  const pick = order.find(r => r.ok) ?? null
  for (const r of order) {
    if (r === pick) break
    if (!r.ok) skipped.push({ id: r.id, title: r.title, reason: r.reason, detail: r.detail })
  }
  if (!pick) return { state: 'dry', released, ...plan.done(), skipped, unledgered }
  const it = after.items.find(i => i.section === 'Backlog' && i.id === pick.id)
  const block = [...it.lines]
  const sf = it.fields.find(f => f.label === 'status')
  if (sf && it.status === 'waiting-level') block.splice(sf.at - it.start, 1, `${indentOf(block[sf.at - it.start])}- status: ${DASH}`)
  insertTop(plan, 'Now', block)
  const source = parseState(plan.text).items.find(i => i.section === 'Backlog' && i.id === pick.id)
  deleteBlock(plan, 'Backlog', source.start, source.end)
  return {
    state: 'picked',
    id: it.id,
    title: it.title,
    from: released.includes(it.id) ? 'decision' : 'backlog',
    digest: itemDigest(it),
    released,
    ...plan.done(),
    skipped,
    unledgered,
  }
}

// ---------------------------------------------------------------- the section 8 trim

// Can the ledger carry this item's lineage whole (R27a)? Its `item_origin` records one parsed
// origin (unledgeredOf), so only when the block's origin-like lines are none at all, or exactly
// one, which is the item's own `origin:` field and parses (parseOrigin). A capitalized
// `Origin:`, a second origin line or a malformed value names parents the ledger would lose.
function lineageWhole(it) {
  const rows = likeRows(it.lines, it.start).filter(r => r.label === 'origin')
  if (!rows.length) return true
  const f = it.fields.find(x => x.label === 'origin')
  return rows.length === 1 && f !== undefined && f.at === rows[0].at && parseOrigin(f.value) !== null
}

// planDoneTrim(text, {ledger, max = 20}) -> {state: 'ok', edits, expect_sha256, dropped,
// unledgered} (R27): `## Done` trimmed to its `max` most recent (topmost) items. Of the items
// below the first `max`, each the ledger records as done (`ledger` as ledgerItems returns it)
// is deleted as a whole block (header and every field line); an item the ledger lacks, an
// id-less one included, is never dropped, so its id and `loop from` origin survive until a
// ledger row carries them. Nor is an item whose origin-like lines are not exactly one
// well-formed `origin:` field (none at all is fine): the block stays the only full record of
// its parents (R27a, lineageWhole). Unparsed lines are kept and not counted. `dropped` lists
// the deleted ids in file order; `unledgered` is planPick's. Refused, with no edits: `crlf`,
// `bad-sections` (no `## Done`, or a repeated section). A `max` that is not a non-negative
// integer throws.
export function planDoneTrim(text, { ledger = null, max = 20 } = {}) {
  if (!Number.isInteger(max) || max < 0) throw new TypeError(`planDoneTrim: max must be a non-negative integer, not ${JSON.stringify(max)}`)
  text = String(text)
  const st = parseState(text)
  const bad = structural(st, ['Done'])
  if (bad) return refusal(...bad, { dropped: [], unledgered: [] })
  const L = asLedger(ledger)
  const drop = st.items.filter(i => i.section === 'Done').slice(max).filter(i => i.id && L.doneIds.has(i.id) && lineageWhole(i))
  const plan = new Plan(text)
  // Bottom-up, so the blocks above each deletion keep their indexes.
  for (const it of [...drop].reverse()) deleteBlock(plan, 'Done', it.start, it.end)
  return { state: 'ok', ...plan.done(), dropped: drop.map(i => i.id), unledgered: unledgeredOf(st, ledger) }
}

// ---------------------------------------------------------------- follow-up

// The title without its own ` (<id>)` suffix (R7).
const baseTitle = it => (it.id && it.title.endsWith(` (${it.id})`) ? it.title.slice(0, -` (${it.id})`.length) : it.title)

// planFollowup(text, {parent, title, notes, known}) -> {state: 'ok', id, reused, edits,
// expect_sha256} (R17): the edit inserting at the top of `## Backlog` a new item with a minted
// id, `origin: loop from <parent>`, `class: unclassified`, `status:` and `blocked-by:` none,
// and the title and notes through loop-text.mjs's neutralLine; a title that collides with an
// open title gets ` (<its own id>)`. Idempotent: when an open item with `origin: loop from
// <parent>` has the same base title (by normTitle), no edit, reused: true and that id. Refused
// with no edits: `crlf`, `bad-sections` (no `## Backlog`, or a repeated section), `bad-parent`
// (not an id exactly one item carries), `bad-input` (a title that is not a string or is empty
// once neutralized, or notes that are not a string).
export function planFollowup(text, { parent, title, notes = '', known = [] } = {}) {
  text = String(text)
  const st = parseState(text)
  const bad = structural(st, ['Backlog'])
  if (bad) return refusal(...bad)
  const p = String(parent ?? '').toLowerCase()
  if (!ID_RE.test(p) || st.items.filter(i => i.id === p).length !== 1) return refusal('bad-parent', `${JSON.stringify(parent ?? null)} is not an id exactly one item carries`)
  if (typeof title !== 'string' || (notes !== null && notes !== undefined && typeof notes !== 'string')) return refusal('bad-input', 'title and notes must be strings')
  const t = neutralLine(title), n = neutralLine(notes ?? '')
  if (t === '') return refusal('bad-input', 'the title is empty')
  const open = st.items.filter(i => OPEN.has(i.section))
  const twin = open.find(i => parseOrigin(i.origin)?.parent === p && i.originParents.length === 1 && normTitle(baseTitle(i)) === normTitle(t))
  if (twin && twin.id) return { state: 'ok', id: twin.id, reused: true, edits: [], expect_sha256: sha256Hex(text) }
  const id = mintId(knownIds(text, known, null))
  const taken = new Set(open.map(i => normTitle(i.title)))
  const final = taken.has(normTitle(t)) ? `${t} (${id})` : t
  const plan = new Plan(text)
  insertTop(plan, 'Backlog', [
    `- [ ] ${final}${SEP}class: unclassified`,
    `  - id: ${id}`,
    `  - origin: loop from ${p}`,
    `  - status: ${DASH}`,
    `  - blocked-by: ${DASH}`,
    `  - notes: ${n === '' ? DASH : n}`,
  ])
  return { state: 'ok', id, reused: false, ...plan.done() }
}
