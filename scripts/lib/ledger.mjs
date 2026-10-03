// scripts/lib/ledger.mjs
// Reading <S>/LEDGER.jsonl (stage 0c-2; ledgerFloor moved here from loop-lock.mjs, which
// re-exports it). One JSON object per line; a line that does not parse, or is not an
// object, is skipped, and a missing file reads as an empty ledger. Any other read error
// throws. Stage 1 moves the ledger into <V> and changes this module for every reader.
import fs from 'node:fs'
import path from 'node:path'

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
