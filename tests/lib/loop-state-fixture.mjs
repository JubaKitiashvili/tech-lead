// tests/lib/loop-state-fixture.mjs
// STATE.md builders for the item grammar tests (stage 0c-3 brief section 8). Every helper
// returns lines; state() joins them into a whole STATE.md in the template's section order.
// The separator and the dash are built from their code points, to keep this file ASCII.
import crypto from 'node:crypto'

export const DOT = String.fromCodePoint(0xb7)
export const DASH = String.fromCodePoint(0x2014)
export const SEP = ` ${DOT} `
export const FILL = '(fill in to release the task back to the backlog)'

// Valid ids (Crockford base32 has no i, l, o or u).
export const A = 'tl-aaaaaaaa', B = 'tl-bbbbbbbb', C = 'tl-cccccccc', D = 'tl-dddddddd'
export const E = 'tl-eeeeeeee', F = 'tl-ffffffff', G = 'tl-gggggggg', H = 'tl-hhhhhhhh'

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')

// A `## Now` / `## Backlog` item. Fields are written in the given order; `undefined` omits one.
export function open(title, { id, origin = 'human', cls = 'unclassified', p = null, status, blockedBy, notes, decision, extra = [] } = {}) {
  const head = `- [ ] ${p !== null ? `P${p}${SEP}` : ''}${title}${SEP}class: ${cls}`
  return [head, ...fields({ id, origin, status, blockedBy, notes, decision }), ...extra]
}

// A `## Blocked` item.
export function blockedItem(title, { attempts = 2, reason = 'verify failed', id, origin = 'human', status, blockedBy, notes, decision, extra = [] } = {}) {
  return [`- [ ] ${title}${SEP}attempts: ${attempts}${SEP}${reason}`, ...fields({ id, origin, status, blockedBy, notes, decision }), ...extra]
}

// A `## Done` item; sha null writes the dash.
export function doneItem(title, { sha = 'abc1234', date = '2026-10-01', id, origin = 'human', notes, extra = [] } = {}) {
  return [`- [x] ${title}${SEP}${sha === null ? DASH : sha}${SEP}${date}`, ...fields({ id, origin, notes }), ...extra]
}

function fields({ id, origin, status, blockedBy, notes, decision }) {
  const f = []
  if (id !== undefined) f.push(`  - id: ${id}`)
  if (origin !== undefined && origin !== null) f.push(`  - origin: ${origin}`)
  if (blockedBy !== undefined) f.push(`  - blocked-by: ${blockedBy}`)
  if (status !== undefined) f.push(`  - status: ${status}`)
  if (notes !== undefined) f.push(`  - notes: ${notes}`)
  if (decision !== undefined) f.push(`  - decision: ${decision}`)
  return f
}

// A `## Needs decision` entry: `panel` (Recommendation), `delegate-flagged` (Flagged by and a
// Recovery line) or `other` (neither).
export function entry(heading, { variant = 'panel', decision = FILL, after = [] } = {}) {
  const body = variant === 'panel'
    ? ['**Recommendation:** use the queue', `**Agreement:** agree ${DASH} agreement is corroboration, not proof`]
    : variant === 'delegate-flagged'
      ? [`**Flagged by:** codex ${DASH} the delegate stopped on a judgment call`,
        `**Questions:** which store? ${DASH} suggested default: redis`,
        `**Recovery:** ${'a'.repeat(64)}${SEP}base ${'b'.repeat(40)}${SEP}item-digest none${SEP}scope ${'c'.repeat(64)}`]
      : ['**Acceptance:** check the output']
  return [`### ${heading}`, ...body, `**Decision:** ${decision}`, ...after]
}

// The whole file; each section is a list of lines, or the template's placeholder when empty.
export function state({ now = [], backlog = [], decisions = [], blocked = [], done = [], lastRun = ['(never run)'] } = {}) {
  const sec = (name, lines) => [`## ${name}`, ...(lines.length ? lines : ['(empty)']), '']
  return [
    `# Demo ${DASH} Loop State`, '',
    ...sec('Now', now), ...sec('Backlog', backlog), ...sec('Needs decision', decisions),
    ...sec('Blocked', blocked), ...sec('Done', done), ...sec('Last run', lastRun),
  ].join('\n')
}

// A ledger object as ledgerItems returns it.
export function ledger({ ids = [], done = [], origins = {} } = {}) {
  return { ids: new Set([...ids, ...done, ...Object.keys(origins)]), doneIds: new Set(done), origins: new Map(Object.entries(origins)) }
}

// A deterministic byte source for mintId: each call returns the next buffer of `draws`, or
// bytes derived from a counter once they run out.
export function rngOf(draws = []) {
  let i = 0, n = 0
  return size => {
    if (i < draws.length) return Buffer.from(draws[i++])
    const b = Buffer.alloc(size)
    b.writeUIntBE(n++ % 2 ** 40, 0, Math.min(size, 5))
    return b
  }
}
