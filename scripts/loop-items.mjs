#!/usr/bin/env node
// scripts/loop-items.mjs
// The item CLI (stage 0c-3 brief section 4): the main session's read-only window on
// <S>/STATE.md items. It reads <S>/STATE.md, <S>/LOOP.md (the `level`, through loop-md.mjs's
// frontScalar; only `pick` reads it) and <S>/LEDGER.jsonl (ledger.mjs's ledgerItems), with <S>
// from loop-paths.mjs, and never writes anything: every change it plans is printed as anchored
// edits [{old, new}] plus expect_sha256 (the SHA-256 of STATE.md once all edits are applied in
// order), which the main session applies with Edit and confirms with `check` (R14). All item
// logic is scripts/lib/loop-state.mjs's (R4); this file reads the files, calls it and prints.
//
// Usage: node loop-items.mjs <command> <P> [flags]; one JSON line, exit 0 (ok), 2 ({state:
// 'error', detail}: usage, not-a-repo, no-state, bad-encoding, no-loop-md, bad-loop-md,
// bad-level, an unreadable ledger or input file, edit-anchor) or 3 ({state: <why>, detail}:
// refused, nothing to apply). Every command refuses a STATE.md holding a carriage return with
// exit 3 `crlf` before anything else (README: convert the file to LF line endings).
//   normalize <P>   -> {state:'ok', edits, expect_sha256, minted:[id], origins:[id], problems}
//                      (R1: ids minted for items without one, `origin: unknown` filled in;
//                      the ledger's ids are known, so a minted id never repeats one)
//   pick <P>        -> {state:'picked', id, title, origin, from:'decision'|'backlog', digest,
//                      released:[id], edits, expect_sha256, skipped:[{id, title, reason,
//                      detail}], unledgered:[{item_id, item_origin}]} or {state:'dry', released,
//                      edits, expect_sha256, skipped, unledgered} (R13, R16; origin the picked
//                      item's `origin:` value as written, or null, which the firing's ledger row
//                      copies as item_origin, fix manifest F1; R27: unledgered, the ## Done
//                      entries the ledger does not record done, for the firing's ledger row's
//                      done_items); planPick's answer printed as it is; exit 3
//                      `now-occupied` or `bad-sections`, with `unledgered` too
//   followup <P> --parent <id> --input <file>
//                   -> {state:'ok', id, reused, edits, expect_sha256} (R17); <file> holds the
//                      JSON object {title, notes} (notes optional), written by the main
//                      session, so foreign text never passes through a shell argument; exit 3
//                      `bad-parent`, `bad-input` (not UTF-8, not JSON, not an object, a key
//                      other than title and notes, no title, a non-string value, an empty
//                      title) or `bad-sections`
//   digest <P> --item <id>
//                   -> {state:'ok', id, item_digest, approved_digest} (R6) for the one item
//                      carrying <id> (any section; its `id:` line in any case); exit 3
//                      `no-item` when none does (a raw carrier alone included: nothing parses
//                      to the id), when it has more than one carrier (R28: loop-state's
//                      idCarriers, the raw id lines that do not parse to it included), or
//                      <id> is not an id
//   check <P> [--expect <sha256>] [--item <id>@<section>:<digest>]
//                   -> {state:'ok', problems} (problems a person made are reported, not
//                      failures); exit 3 {state:'mismatch', detail, mismatches, problems} when
//                      the file's SHA-256 is not <sha256> ({kind:'expect', expected, actual}),
//                      or when the item is not carried exactly once in the whole file, raw
//                      carriers included (R28), in <section> (Now, Backlog, Blocked or Done),
//                      with that itemDigest ({kind: 'item', id, section, digest, found:
//                      [{section, line, digest, raw}]}, a raw carrier with its id line and
//                      digest null)
//   trim <P>        -> {state:'ok', edits, expect_sha256, dropped:[id], unledgered:[{item_id,
//                      item_origin}]} (R27; loop "Item edits", Trimming ## Done): `## Done` kept
//                      to its 20 most recent items; below them each item the ledger records
//                      done is deleted as a whole block, and every other one (an unledgered
//                      item, an id-less one) is kept, since ## Done is then the only record of
//                      its id and origin; planDoneTrim's answer printed as it is, edits empty
//                      when nothing can go; exit 3 `bad-sections` (no `## Done`, or a repeated
//                      section)
// Ids and hex digests on the command line are taken exactly as the helpers print them, in lower
// case (ID_RE, 64 lower-case hex digits), as reflex-bundle.mjs and loop-clone.mjs take them; an
// upper-case copy is not an id (STATE.md's own `id:` values are compared case-insensitively, R2).
// STATE.md and LOOP.md must be UTF-8 (a byte-order mark is kept, so the hash is the file's).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loopPaths } from './lib/loop-paths.mjs'
import { sha256Hex } from './lib/canonical.mjs'
import { ledgerItems } from './lib/ledger.mjs'
import { frontScalar } from './lib/loop-md.mjs'
import {
  ID_RE, approvedDigest, idCarriers, itemDigest, itemProblems, parseState, planDoneTrim, planFollowup, planNormalize, planPick,
} from './lib/loop-state.mjs'

const USAGE = 'usage: loop-items.mjs normalize <P> | pick <P> | followup <P> --parent <id> --input <file>' +
  ' | digest <P> --item <id> | check <P> [--expect <sha256>] [--item <id>@<section>:<digest>] | trim <P>'
// The flags each command takes, and the ones it needs.
const FLAGS = { normalize: [], pick: [], followup: ['parent', 'input'], digest: ['item'], check: ['expect', 'item'], trim: [] }
const REQUIRED = { followup: ['parent', 'input'], digest: ['item'] }
const ITEM_SECTIONS = ['Now', 'Backlog', 'Blocked', 'Done']
const HEX64 = /^[0-9a-f]{64}$/
const LEVELS = new Set(['1', '2', '3'])
const INPUT_KEYS = new Set(['title', 'notes'])
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A refusal: exit 3 with {state, detail}.
class Refused extends Error {
  constructor(state, detail) {
    super(detail)
    this.state = state
  }
}
const usage = detail => new Error(detail ? `usage: ${detail}` : USAGE)

// <command> <P> and the command's flags, each once, as `--flag value`; a usage Error on misuse.
function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!Object.hasOwn(FLAGS, command ?? '')) throw usage()
  const opts = {}, pos = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const key = a.slice(2)
    if (!a.startsWith('--')) pos.push(a)
    else if (FLAGS[command].includes(key) && !Object.hasOwn(opts, key) && i + 1 < rest.length) opts[key] = rest[++i]
    else throw usage()
  }
  if (pos.length !== 1 || (REQUIRED[command] ?? []).some(k => !Object.hasOwn(opts, k))) throw usage()
  if (command === 'check') {
    if (Object.hasOwn(opts, 'expect')) {
      if (!HEX64.test(opts.expect)) throw usage(`--expect takes a SHA-256 (64 lower-case hex digits), not ${JSON.stringify(opts.expect)}`)
    }
    if (Object.hasOwn(opts, 'item')) opts.item = itemSpec(opts.item)
  }
  return { command, P: pos[0], opts }
}

// `<id>@<section>:<digest>` -> {id, section, digest}; a usage Error otherwise.
function itemSpec(s) {
  const at = s.indexOf('@'), colon = s.lastIndexOf(':')
  const id = s.slice(0, at), section = s.slice(at + 1, colon), digest = s.slice(colon + 1)
  if (at < 0 || colon < at || !ID_RE.test(id) || !ITEM_SECTIONS.includes(section) || !HEX64.test(digest)) {
    throw usage(`--item takes <id>@<${ITEM_SECTIONS.join('|')}>:<64 lower-case hex digest>, not ${JSON.stringify(s)}`)
  }
  return { id, section, digest }
}

// A file's bytes and its UTF-8 text; `missing` names the error of a file that cannot be read.
function readUtf8(file, missing) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `${missing}: ${file} is missing` : `${missing}: ${file}: ${e.code || e.message}`)
  }
  try {
    return { buf, text: UTF8.decode(buf) }
  } catch {
    throw new Error(`bad-encoding: ${file} is not UTF-8`)
  }
}

// STATE.md, refused before anything else when it holds a carriage return.
function readState(S) {
  const got = readUtf8(path.join(S, 'STATE.md'), 'no-state')
  if (got.text.includes('\r')) throw new Refused('crlf', 'STATE.md holds a carriage return; convert it to LF line endings')
  return got
}

function readLedger(S) {
  try {
    return ledgerItems(S)
  } catch (e) {
    throw new Error(`ledger: ${path.join(S, 'LEDGER.jsonl')}: ${e.code || e.message}`)
  }
}

// LOOP.md's `level` as a number: 1, 2 or 3; 1 when the key is absent (the template always
// writes it). Any other value is refused rather than read as some level.
function readLevel(S) {
  const { text } = readUtf8(path.join(S, 'LOOP.md'), 'no-loop-md')
  const v = frontScalar(text, 'level')
  if (v === null) return 1
  if (!LEVELS.has(v.trim())) throw new Error(`bad-level: LOOP.md level: must be 1, 2 or 3, not ${JSON.stringify(v)}`)
  return Number(v.trim())
}

// The follow-up request {title, notes} from the input file; refused as `bad-input` when it is
// not one.
function readInput(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (e) {
    throw new Error(`input: ${file}: ${e.code || e.message}`)
  }
  let value
  try {
    value = JSON.parse(UTF8.decode(buf))
  } catch (e) {
    throw new Refused('bad-input', `${file} is not UTF-8 JSON: ${e.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refused('bad-input', `${file} does not hold a JSON object {title, notes}`)
  const extra = Object.keys(value).filter(k => !INPUT_KEYS.has(k))
  if (extra.length) throw new Refused('bad-input', `${file} has keys other than title and notes: ${extra.join(', ')}`)
  if (!Object.hasOwn(value, 'title')) throw new Refused('bad-input', `${file} has no title`)
  return { title: value.title, notes: value.notes ?? '' }
}

// A planner's result: a refusal throws (keeping pick's `unledgered`, R27), anything else is
// printed as it is.
function planned(result) {
  if (result.state === 'refused') {
    const e = new Refused(result.reason, result.detail)
    if (Array.isArray(result.unledgered)) e.extra = { unledgered: result.unledgered }
    throw e
  }
  return result
}

const where = it => `## ${it.section} line ${it.line}`

// Every block carrying id (R28), in file order: the parsed items, with their digests, and the
// raw id lines that do not parse to it, with digest null.
function carriersOf(st, id) {
  const { parsed, raw } = idCarriers(st, id)
  return [
    ...parsed.map(i => ({ section: i.section, line: i.line, digest: itemDigest(i), raw: false, item: i })),
    ...raw.map(r => ({ section: r.section, line: r.line, digest: null, raw: true, item: null })),
  ].sort((a, b) => a.line - b.line)
}
const named = c => `${where(c)}${c.raw ? ' (an id line that does not parse to it)' : ''}`

const COMMANDS = {
  normalize({ S }) {
    const { text } = readState(S)
    const ledger = readLedger(S)
    const r = planned(planNormalize(text, { known: [...ledger.ids], ledger }))
    return { state: r.state, edits: r.edits, expect_sha256: r.expect_sha256, minted: r.minted, origins: r.origins, problems: r.problems }
  },

  pick({ S }) {
    const { text } = readState(S)
    const ledger = readLedger(S)
    return planned(planPick(text, { ledger, level: readLevel(S) }))
  },

  followup({ S }, { parent, input }) {
    const { text } = readState(S)
    const ledger = readLedger(S)
    const { title, notes } = readInput(input)
    if (!ID_RE.test(parent)) throw new Refused('bad-parent', `${JSON.stringify(parent)} is not an id`)
    return planned(planFollowup(text, { parent, title, notes, known: [...ledger.ids] }))
  },

  digest({ S }, { item: id }) {
    const { text } = readState(S)
    if (!ID_RE.test(id)) throw new Refused('no-item', `${JSON.stringify(id)} is not an id`)
    const carriers = carriersOf(parseState(text), id)
    if (carriers.length === 0) throw new Refused('no-item', `no item carries ${id}`)
    if (carriers.length > 1) throw new Refused('no-item', `${id} is carried ${carriers.length} times: ${carriers.map(named).join(', ')}`)
    const [{ item }] = carriers
    // A raw carrier alone is no item: nothing parses to the id, so there is nothing to digest.
    if (item === null) throw new Refused('no-item', `no item carries ${id}; only ${named(carriers[0])} holds it`)
    return { state: 'ok', id, item_digest: itemDigest(item), approved_digest: approvedDigest(item) }
  },

  check({ S }, { expect, item }) {
    const { buf, text } = readState(S)
    const st = parseState(text)
    const problems = itemProblems(st, readLedger(S))
    const mismatches = [], details = []
    if (expect !== undefined) {
      const actual = sha256Hex(buf)
      if (actual !== expect) {
        mismatches.push({ kind: 'expect', expected: expect, actual })
        details.push(`STATE.md hashes to ${actual}, not the expected ${expect}`)
      }
    }
    if (item !== undefined) {
      const found = carriersOf(st, item.id).map(({ section, line, digest, raw }) => ({ section, line, digest, raw }))
      if (found.length !== 1 || found[0].raw || found[0].section !== item.section || found[0].digest !== item.digest) {
        mismatches.push({ kind: 'item', ...item, found })
        details.push(`${item.id} is wanted once, in ## ${item.section}, with digest ${item.digest}; found ` +
          (found.length ? found.map(f => (f.raw ? named(f) : `${where(f)} with digest ${f.digest}`)).join(', ') : 'no item carrying it'))
      }
    }
    if (mismatches.length) throw Object.assign(new Refused('mismatch', details.join('; ')), { extra: { mismatches, problems } })
    return { state: 'ok', problems }
  },

  trim({ S }) {
    const { text } = readState(S)
    const r = planned(planDoneTrim(text, { ledger: readLedger(S) }))
    return { state: r.state, edits: r.edits, expect_sha256: r.expect_sha256, dropped: r.dropped, unledgered: r.unledgered }
  },
}

// Runs one command line: {code, out}, never throws.
function cli(argv) {
  try {
    const { command, P, opts } = parseArgs(argv)
    return { code: 0, out: COMMANDS[command](loopPaths(P), opts) }
  } catch (e) {
    if (e instanceof Refused) return { code: 3, out: { state: e.state, detail: e.message, ...(e.extra || {}) } }
    return { code: 2, out: { state: 'error', detail: e.message } }
  }
}

function main(argv) {
  const { code, out } = cli(argv)
  process.stdout.write(`${JSON.stringify(out)}\n`)
  return code
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
