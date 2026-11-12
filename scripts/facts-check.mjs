#!/usr/bin/env node
// scripts/facts-check.mjs
// Reads references/model-facts.md: the outside facts the plugin's rules rest on, each with its
// source page and the day it was last read there. It does not fetch anything; re-reading the
// pages is a model's job (references/facts-check-prompt.md). This script gives that job its
// input and says which rows are due.
//
// Usage (one JSON document on stdout; exit 0, or 2 when the table cannot be read):
//   list                         -> {facts:[{id, fact, used_in, source, checked}]}
//   stale [--days N] [--today D] -> {days, today, stale:[{id, checked, age_days, source}], total}
//                                   (N defaults to 45; D, a YYYY-MM-DD day, defaults to today UTC)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'references', 'model-facts.md')
const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = s => {
  if (typeof s !== 'string' || !DAY.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

// The table's rows as objects, with the problems found: [{row, problem}].
export function parseFacts(text) {
  const facts = [], problems = []
  const lines = text.split('\n').filter(l => l.startsWith('|'))
  for (const [i, line] of lines.slice(2).entries()) {
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    const bad = p => problems.push({ row: i + 1, problem: p })
    if (cells.length !== 5) { bad(`has ${cells.length} cells, not 5`); continue }
    const [id, fact, used_in, source, checked] = cells
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) bad(`id ${JSON.stringify(id)} is not lower-case letters, digits and "-"`)
    if (facts.some(f => f.id === id)) bad(`id ${id} is used twice`)
    if (fact.length < 20) bad(`${id}: the fact is too short to check`)
    if (!used_in) bad(`${id}: does not say where it is used`)
    if (!/^https:\/\/[^\s|]+$/.test(source)) bad(`${id}: the source is not one https URL`)
    if (!isDay(checked)) bad(`${id}: checked ${JSON.stringify(checked)} is not a YYYY-MM-DD day`)
    facts.push({ id, fact, used_in, source, checked })
  }
  if (lines.length < 3) problems.push({ row: 0, problem: 'the table has no rows' })
  return { facts, problems }
}

// The facts last checked more than `days` days before `today` (both YYYY-MM-DD), oldest first.
export function staleFacts(facts, { days = 45, today }) {
  const t = Date.parse(`${today}T00:00:00Z`)
  return facts
    .map(f => ({ id: f.id, checked: f.checked, age_days: Math.round((t - Date.parse(`${f.checked}T00:00:00Z`)) / 86400000), source: f.source }))
    .filter(f => f.age_days > days)
    .sort((a, b) => b.age_days - a.age_days)
}

function main(argv) {
  const [command, ...rest] = argv
  const flag = name => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
  let parsed
  try { parsed = parseFacts(fs.readFileSync(FILE, 'utf8')) } catch (e) {
    console.log(JSON.stringify({ state: 'error', error: 'io', detail: `${FILE}: ${e.code || e.message}` })); return 2
  }
  if (parsed.problems.length) { console.log(JSON.stringify({ state: 'error', error: 'bad-table', problems: parsed.problems })); return 2 }
  if (command === 'list') { console.log(JSON.stringify({ facts: parsed.facts })); return 0 }
  if (command === 'stale') {
    const days = flag('days') === undefined ? 45 : Number(flag('days'))
    const today = flag('today') ?? new Date().toISOString().slice(0, 10)
    if (!Number.isInteger(days) || days < 0 || !isDay(today)) { console.log(JSON.stringify({ state: 'error', error: 'usage', detail: 'stale [--days <whole number>] [--today <YYYY-MM-DD>]' })); return 2 }
    console.log(JSON.stringify({ days, today, stale: staleFacts(parsed.facts, { days, today }), total: parsed.facts.length })); return 0
  }
  console.log(JSON.stringify({ state: 'error', error: 'usage', detail: 'facts-check.mjs list | stale [--days N] [--today YYYY-MM-DD]' })); return 2
}

const isScript = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (isScript()) process.exitCode = main(process.argv.slice(2))
