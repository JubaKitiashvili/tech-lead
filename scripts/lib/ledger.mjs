// scripts/lib/ledger.mjs
// Reading <S>/LEDGER.jsonl (stage 0c-2; ledgerFloor moved here from loop-lock.mjs, which
// re-exports it). One JSON object per line; a line that does not parse, or is not an
// object, is skipped, and a missing file reads as an empty ledger. Any other read error
// throws. Stage 1 moves the ledger into <V> and changes this module for every reader.
// Stage 0c-3 (brief R21) adds ledgerItems, the item ids, done ids and origins rows record;
// R27 adds a row's done_items, the ## Done entries a firing recorded because no row had.
import fs from 'node:fs'
import path from 'node:path'
import { ID_RE } from './loop-state.mjs'

// The parsed object rows of <S>/LEDGER.jsonl, in file order; [] when the file is missing.
function rows(S) {
  let text
  try {
    text = fs.readFileSync(path.join(S, 'LEDGER.jsonl'), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const out = []
  for (const line of text.split('\n')) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (isObject(row)) out.push(row)
  }
  return out
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])
const sha = v => typeof v === 'string' && v !== ''

// max numeric `iteration` over the parseable lines of <S>/LEDGER.jsonl; 0 when missing.
// A fractional value is rounded up, so the next generation still exceeds it.
export function ledgerFloor(S) {
  let floor = 0
  for (const row of rows(S)) {
    const it = row.iteration
    if (typeof it === 'number' && Number.isFinite(it)) floor = Math.max(floor, Math.ceil(it))
  }
  return floor
}

// ledgerShas(S) -> {commits, saves, tips}, three Sets of the shas the ledger names:
//   commits  every entry of a row's `commits` and of its `recovered.commits`
//   saves    every `saves[].sha` and every entry of `recovered.bundles` (recovery bundles)
//   tips     every `bundles[].tip` (delivery bundle tips)
// A field of the wrong shape, or an entry that is not a non-empty string, is skipped on its
// own; the rest of its row still counts.
export function ledgerShas(S) {
  const commits = new Set(), saves = new Set(), tips = new Set()
  for (const row of rows(S)) {
    const recovered = isObject(row.recovered) ? row.recovered : {}
    for (const c of [...list(row.commits), ...list(recovered.commits)]) if (sha(c)) commits.add(c)
    for (const s of list(row.saves)) if (isObject(s) && sha(s.sha)) saves.add(s.sha)
    for (const b of list(recovered.bundles)) if (sha(b)) saves.add(b)
    for (const b of list(row.bundles)) if (isObject(b) && sha(b.tip)) tips.add(b.tip)
  }
  return { commits, saves, tips }
}

// ledgerItems(S) -> {ids, doneIds, origins}, what the ledger records about items (R21):
//   ids      a Set of every non-empty string `item_id` of a row, of its `recovered` and of
//            its `done_items` entries (the ledger's part of the known set mintId redraws on,
//            R2), whatever its shape
//   doneIds  a Set of the ids the ledger records done (R11 (ii)): a row's ID_RE `item_id` when
//            its `outcome` is exactly 'done', a `recovered.item_id` that is ID_RE when
//            `recovered.action` is exactly 'finish-commit', and the ID_RE `item_id` of every
//            object in a row's `done_items` array (R27: pick's `unledgered`, the ## Done entries
//            no row recorded done, written whatever the row's outcome); nothing else ever
//            counts, so a legacy row without `item_id` never satisfies a blocker
//   origins  a Map from id to the raw `item_origin` string recorded with it last, for the
//            blocker walk after `## Done` is trimmed (R12); the value is not parsed here
//            (loop-state.mjs reads it, damaged values included, R9)
// Rows are read in file order and, inside a row, `recovered`, then `done_items` in array order,
// then the row's own fields (the recovery report and the recorded Done entries describe earlier
// firings than the row's pick). A `done_items` that is not an array, or an entry that is not an
// object, is skipped on its own. An `item_origin` that is null, empty or not a string records
// nothing, so an earlier origin stands; a row or entry without a usable `item_id` contributes
// nothing at all.
const filled = v => typeof v === 'string' && v !== ''

export function ledgerItems(S) {
  const ids = new Set(), doneIds = new Set(), origins = new Map()
  const note = (rec, done) => {
    if (!filled(rec.item_id)) return
    ids.add(rec.item_id)
    if (done && ID_RE.test(rec.item_id)) doneIds.add(rec.item_id)
    if (filled(rec.item_origin)) origins.set(rec.item_id, rec.item_origin)
  }
  for (const row of rows(S)) {
    if (isObject(row.recovered)) note(row.recovered, row.recovered.action === 'finish-commit')
    for (const d of list(row.done_items)) if (isObject(d)) note(d, true)
    note(row, row.outcome === 'done')
  }
  return { ids, doneIds, origins }
}
