// scripts/lib/run-record.mjs
// Owner of the run record (stage 0c-2, brief section 9; rulings R3, R4, R13, R20). One file
// per write-capable firing, <V>/run/<N>.json, created once (atomic.createExclusive) and
// replaced after (atomic.writeReplace), both fsynced. Callers hold the firing lock; a holder M
// writes recovery fields into its own record and into older records g < M, never into g > M
// (the schema refuses recovery.by < generation).
//
// Record (v 1; every key present, no other key):
//   {v:1, generation:N,
//    phase: preparing | prepared | intent | committed | saved | resetting | clean,
//    pre_head: oid|null (the tip at creation), branch: '<prefix>/<date>'|null,
//    head_ref: 'refs/heads/<branch>'|null (a dated branch; set together with branch),
//    base: oid|null (H0), now_sha256: sha256|null, rules: null | {v:1, mode, ...} (changes.mjs
//    owns and checks the rest), refs: {'refs/...': oid}, meta_sha: sha256|null,
//    intent: null | {tree, parent, commit}, commit: null | {sha},
//    saves: [{sha: sha256, why: slug}], reset_sha: sha256|null, delegate_commits: [oid],
//    adopted: [{ref: 'refs/heads/<prefix>/<date>', tip: oid}] (the tips the creating prepare
//              adopted, R28; [] in every other record),
//    recovery: null | {by: M >= generation, base: oid|null, rewind: null | {from, to},
//                      bundles: [sha256], reset_sha: sha256|null,
//                      step: rewind-intent | rewound | saved | resetting | done,
//                      note: null | superseded | clone-missing},
//    created_at, updated_at: ISO-8601 UTC}
// plus what the phases and steps imply: prepared, intent, committed, saved and resetting carry
// a base; intent an intent, committed a commit, saved a save, resetting a reset_sha; a
// rewind-intent or rewound recovery a rewind and a base, a saved one a bundle, a resetting one
// a reset_sha; a note only on a finished (done) recovery. An oid is 40 or 64 lowercase hex.
//
// Exports (paths is loopPaths' result; N a positive safe integer):
//   recordFile(paths, N) -> '<V>/run/<N>.json'
//   readRecord(paths, N) -> record | null (missing). Anything at the name that is not a regular
//       file holding a record of generation N throws 'corrupt: <file>: <why>' (code CORRUPT).
//   listRecords(paths) -> records ascending by generation; only names '<N>.json' count; a
//       corrupt one throws as readRecord does; a missing <V>/run is [].
//   createRecord(paths, N, fields = {}, {guard}) -> boolean: the defaults above (phase
//       preparing, null and empty fields) overlaid with fields, timestamps set; false when the
//       record exists. createRecord(paths, {generation: N, ...fields}, {guard}) is the same
//       call. Never creates <V>.
//   updateRecord(paths, N, patch, {guard}) -> the record written. patch is an object merged over the
//       record's top-level keys (a recovery object is laid over the current recovery, so what
//       it leaves out keeps its value; with no current recovery, base, rewind, bundles,
//       reset_sha and note default to null/[]), or a function rec -> new record. v, generation
//       and created_at never change; updated_at is set. Anchors are never dropped, whichever
//       form the patch takes: the current saves and recovery.bundles stay first in their lists
//       (new entries are merged in after them, so the last entry stays the newest), a null
//       reset_sha or recovery.reset_sha keeps the current one, and an update that would still
//       leave a current anchor sha (a save, a reset_sha, a recovery bundle or reset) nowhere in
//       the record throws bad-record. A missing record throws 'no-record: <file>' (NO_RECORD).
//   deleteRecord(paths, N) -> boolean (false when it was missing).
//   maxRecordGeneration(paths) -> the largest N among the names '<N>.json' in <V>/run, 0 when
//       there is none or no directory; content is never read.
//   isResolved(rec) -> phase clean, or recovery.step done (stored fields only).
//   ownerRecord(records) -> the record that owns the clone's tree, or null (see below).
//   committedSha(rec) -> rec.commit?.sha ?? rec.intent?.commit ?? null.
//   vettedTip({records, ledger, branch, tip, inBase}) -> boolean (see below; R28).
//   cloneVerdict(rec | null, facts) -> {verdict, generation, ...} (pure; see below).
// A record that would not pass the schema is never written: create and update throw
// 'bad-record: <why>' (code BAD_RECORD) and leave the file as it was. guard (optional, R31):
// the caller's assertHeld, passed to atomic's createExclusive / writeReplace, which call it
// after the record's temp is fsynced, right before the link or rename; when it throws, nothing
// is written.
import fs from 'node:fs'
import path from 'node:path'
import { createExclusive, readJson, writeReplace } from './atomic.mjs'
import { DATED_BRANCH_RE } from './clone-check.mjs'

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const WHY = /^[a-z][a-z0-9-]*$/
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/
// A ref name as for-each-ref prints it: refs/..., no space or control character (a name
// outside ASCII is allowed: <P>'s branches and tags are copied into the clone).
const REF_NAME = /^refs\/[^\x00-\x20\x7f]+$/
const RECORD_NAME = /^([1-9][0-9]*)\.json$/

const PHASES = new Set(['preparing', 'prepared', 'intent', 'committed', 'saved', 'resetting', 'clean'])
const STEPS = new Set(['rewind-intent', 'rewound', 'saved', 'resetting', 'done'])
const NOTES = new Set(['superseded', 'clone-missing'])
const RULE_MODES = new Set(['recorded', 'current', 'base'])
const NEEDS_BASE = new Set(['prepared', 'intent', 'committed', 'saved', 'resetting'])
const KEYS = [
  'v', 'generation', 'phase', 'pre_head', 'branch', 'head_ref', 'base', 'now_sha256', 'rules', 'refs', 'meta_sha',
  'intent', 'commit', 'saves', 'reset_sha', 'delegate_commits', 'adopted', 'recovery', 'created_at', 'updated_at',
]
const RECOVERY_KEYS = ['by', 'base', 'rewind', 'bundles', 'reset_sha', 'step', 'note']

const isPlain = v => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const isGeneration = v => Number.isSafeInteger(v) && v > 0
const isOid = v => typeof v === 'string' && OID.test(v)
const isSha = v => typeof v === 'string' && SHA256.test(v)
const oidOrNull = v => v === null || isOid(v)
const shaOrNull = v => v === null || isSha(v)
const stamp = () => new Date().toISOString()

const corrupt = (file, why) => Object.assign(new Error(`corrupt: ${file}: ${why}`), { code: 'CORRUPT', file })
const badRecord = why => Object.assign(new Error(`bad-record: ${why}`), { code: 'BAD_RECORD' })

// ---------------------------------------------------------------- schema

// The first missing or unknown key of obj, or null.
function keysProblem(obj, keys, where) {
  for (const k of keys) if (!Object.hasOwn(obj, k)) return `${where} has no ${k}`
  for (const k of Object.keys(obj)) if (!keys.includes(k)) return `${where} has an unknown key ${JSON.stringify(k)}`
  return null
}

function exactOids(obj, keys, where) {
  if (!isPlain(obj)) return `${where} is not an object`
  const k = keysProblem(obj, keys, where)
  if (k) return k
  for (const key of keys) if (!isOid(obj[key])) return `${where}.${key} is not an object id`
  return null
}

function recoveryProblem(r, generation) {
  if (!isPlain(r)) return 'recovery is not an object'
  const k = keysProblem(r, RECOVERY_KEYS, 'recovery')
  if (k) return k
  if (!isGeneration(r.by)) return 'recovery.by is not a generation'
  if (r.by < generation) return `recovery.by ${r.by} is older than the record's generation ${generation}`
  if (!oidOrNull(r.base)) return 'recovery.base is not an object id'
  if (r.rewind !== null) {
    const w = exactOids(r.rewind, ['from', 'to'], 'recovery.rewind')
    if (w) return w
  }
  if (!Array.isArray(r.bundles) || !r.bundles.every(isSha)) return 'recovery.bundles is not a list of sha256'
  if (!shaOrNull(r.reset_sha)) return 'recovery.reset_sha is not a sha256'
  if (!STEPS.has(r.step)) return `recovery.step ${JSON.stringify(r.step)} is unknown`
  if (r.note !== null && !NOTES.has(r.note)) return `recovery.note ${JSON.stringify(r.note)} is unknown`
  if (r.note !== null && r.step !== 'done') return `recovery.note on an unfinished recovery (step ${r.step})`
  if ((r.step === 'rewind-intent' || r.step === 'rewound') && (r.rewind === null || r.base === null)) {
    return `recovery step ${r.step} without a rewind and a base`
  }
  if (r.step === 'saved' && r.bundles.length === 0) return 'recovery step saved without a bundle'
  if (r.step === 'resetting' && r.reset_sha === null) return 'recovery step resetting without reset_sha'
  return null
}

// Why rec is not a valid record (of generation N when N is given), or null.
function recordProblem(rec, N) {
  if (!isPlain(rec)) return 'not a JSON object'
  const k = keysProblem(rec, KEYS, 'the record')
  if (k) return k
  if (rec.v !== 1) return `v is ${JSON.stringify(rec.v)}, not 1`
  if (!isGeneration(rec.generation)) return 'generation is not a positive integer'
  if (N !== undefined && rec.generation !== N) return `generation ${rec.generation} in the record of generation ${N}`
  if (!PHASES.has(rec.phase)) return `phase ${JSON.stringify(rec.phase)} is unknown`
  for (const key of ['pre_head', 'base']) if (!oidOrNull(rec[key])) return `${key} is not an object id`
  if (rec.head_ref !== null && (typeof rec.head_ref !== 'string' || !DATED_BRANCH_RE.test(rec.head_ref))) {
    return 'head_ref is not a dated branch'
  }
  if (rec.branch !== null && typeof rec.branch !== 'string') return 'branch is not a string'
  if ((rec.branch === null) !== (rec.head_ref === null)) return 'branch and head_ref are not set together'
  if (rec.branch !== null && rec.head_ref !== `refs/heads/${rec.branch}`) return 'head_ref does not name branch'
  for (const key of ['now_sha256', 'meta_sha', 'reset_sha']) if (!shaOrNull(rec[key])) return `${key} is not a sha256`
  if (rec.rules !== null && !(isPlain(rec.rules) && rec.rules.v === 1 && RULE_MODES.has(rec.rules.mode))) {
    return 'rules is not a v1 rules object'
  }
  if (!isPlain(rec.refs)) return 'refs is not an object'
  for (const [ref, oid] of Object.entries(rec.refs)) {
    if (!REF_NAME.test(ref)) return `refs names ${JSON.stringify(ref)}, not a ref`
    if (!isOid(oid)) return `refs[${JSON.stringify(ref)}] is not an object id`
  }
  if (rec.intent !== null) {
    const p = exactOids(rec.intent, ['tree', 'parent', 'commit'], 'intent')
    if (p) return p
  }
  if (rec.commit !== null) {
    const p = exactOids(rec.commit, ['sha'], 'commit')
    if (p) return p
  }
  if (!Array.isArray(rec.saves)) return 'saves is not a list'
  for (const [i, s] of rec.saves.entries()) {
    if (!isPlain(s)) return `saves[${i}] is not an object`
    const p = keysProblem(s, ['sha', 'why'], `saves[${i}]`)
    if (p) return p
    if (!isSha(s.sha)) return `saves[${i}].sha is not a sha256`
    if (typeof s.why !== 'string' || !WHY.test(s.why)) return `saves[${i}].why is not a reason`
  }
  if (!Array.isArray(rec.delegate_commits) || !rec.delegate_commits.every(isOid)) return 'delegate_commits is not a list of object ids'
  if (!Array.isArray(rec.adopted)) return 'adopted is not a list'
  for (const [i, a] of rec.adopted.entries()) {
    if (!isPlain(a)) return `adopted[${i}] is not an object`
    const p = keysProblem(a, ['ref', 'tip'], `adopted[${i}]`)
    if (p) return p
    if (typeof a.ref !== 'string' || !DATED_BRANCH_RE.test(a.ref)) return `adopted[${i}].ref is not a dated branch`
    if (!isOid(a.tip)) return `adopted[${i}].tip is not an object id`
  }
  if (rec.recovery !== null) {
    const p = recoveryProblem(rec.recovery, rec.generation)
    if (p) return p
  }
  for (const key of ['created_at', 'updated_at']) {
    if (typeof rec[key] !== 'string' || !STAMP.test(rec[key])) return `${key} is not a UTC timestamp`
  }
  if (NEEDS_BASE.has(rec.phase) && rec.base === null) return `phase ${rec.phase} without a base`
  if (rec.phase === 'intent' && rec.intent === null) return 'phase intent without an intent'
  if (rec.phase === 'committed' && rec.commit === null) return 'phase committed without a commit'
  if (rec.phase === 'saved' && rec.saves.length === 0) return 'phase saved without a save'
  if (rec.phase === 'resetting' && rec.reset_sha === null) return 'phase resetting without reset_sha'
  return null
}

// The JSON value that will be on disk (and read back), checked against the schema.
function toRecord(obj, N) {
  let value
  try {
    value = JSON.parse(JSON.stringify(obj))
  } catch (e) {
    throw badRecord(`not JSON: ${e.message}`)
  }
  const why = recordProblem(value, N)
  if (why) throw badRecord(why)
  return value
}

const withRecoveryDefaults = r => (isPlain(r) ? { base: null, rewind: null, bundles: [], reset_sha: null, note: null, ...r } : r)

// Every bundle sha rec anchors: its saves, its reset, its recovery's bundles and reset.
function anchors(rec) {
  const r = isPlain(rec?.recovery) ? rec.recovery : null
  const list = [
    ...(Array.isArray(rec?.saves) ? rec.saves.map(s => s?.sha) : []), rec?.reset_sha,
    ...(r ? [...(Array.isArray(r.bundles) ? r.bundles : []), r.reset_sha] : []),
  ]
  return [...new Set(list.filter(isSha))]
}

// old, then what neu holds beyond it (neu minus one match per entry of old, in neu's order): a
// list that already starts with old comes back unchanged, and an empty one gives old.
function mergeAfter(old, neu, eq) {
  const rest = [...neu]
  for (const o of old) {
    const i = rest.findIndex(x => eq(x, o))
    if (i >= 0) rest.splice(i, 1)
  }
  return [...old, ...rest]
}
const sameSave = (a, b) => isPlain(a) && isPlain(b) && a.sha === b.sha && a.why === b.why

// next with cur's anchors kept: cur's saves and recovery bundles merged in first, and a null
// reset_sha (top level or recovery) given cur's value. Values of the wrong type are left for
// the schema to refuse.
function keepAnchors(cur, next) {
  const out = { ...next }
  if (Array.isArray(out.saves)) out.saves = mergeAfter(cur.saves, out.saves, sameSave)
  if (out.reset_sha === null && cur.reset_sha !== null) out.reset_sha = cur.reset_sha
  const was = cur.recovery
  if (was !== null && isPlain(out.recovery)) {
    const r = { ...out.recovery }
    if (Array.isArray(r.bundles)) r.bundles = mergeAfter(was.bundles, r.bundles, (a, b) => a === b)
    if (r.reset_sha === null && was.reset_sha !== null) r.reset_sha = was.reset_sha
    out.recovery = r
  }
  return out
}

// ---------------------------------------------------------------- files

function runDir(paths) {
  if (!paths || typeof paths.V !== 'string' || !path.isAbsolute(paths.V)) throw new Error('bad-paths: paths.V is not an absolute path')
  return path.join(paths.V, 'run')
}

export function recordFile(paths, N) {
  if (!isGeneration(N)) throw new Error(`bad-generation: ${String(N)}`)
  return path.join(runDir(paths), `${N}.json`)
}

function readFileRecord(file, N) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  if (!st.isFile()) throw corrupt(file, 'not a regular file')
  let rec
  try {
    rec = readJson(file)
  } catch (e) {
    if (typeof e.message === 'string' && e.message.startsWith('corrupt: ')) throw corrupt(file, 'not a JSON object')
    throw e
  }
  if (rec === null) return null // removed since the lstat
  const why = recordProblem(rec, N)
  if (why) throw corrupt(file, why)
  return rec
}

export function readRecord(paths, N) {
  return readFileRecord(recordFile(paths, N), N)
}

// The generations named by '<N>.json' entries of dir, ascending. A missing dir is [] (and so
// is one that is not a directory, when tolerant); any other read error throws.
function generations(dir, { tolerant = false } = {}) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT' || (tolerant && e.code === 'ENOTDIR')) return []
    throw e
  }
  const out = []
  for (const name of names) {
    const m = RECORD_NAME.exec(name)
    if (m && Number.isSafeInteger(Number(m[1]))) out.push(Number(m[1]))
  }
  return out.sort((a, b) => a - b)
}

export function listRecords(paths) {
  const dir = runDir(paths)
  const out = []
  for (const g of generations(dir)) {
    const rec = readFileRecord(path.join(dir, `${g}.json`), g)
    if (rec !== null) out.push(rec)
  }
  return out
}

export function createRecord(paths, N, fields = {}, opts = {}) {
  if (isPlain(N)) {
    opts = fields
    fields = N
    N = fields.generation
  }
  const file = recordFile(paths, N)
  if (!isPlain(fields)) throw badRecord('fields is not an object')
  if (Object.hasOwn(fields, 'generation') && fields.generation !== N) {
    throw badRecord(`generation ${JSON.stringify(fields.generation)} in the record of generation ${N}`)
  }
  const now = stamp()
  const rec = toRecord({
    v: 1, phase: 'preparing', pre_head: null, branch: null, head_ref: null, base: null, now_sha256: null, rules: null,
    refs: {}, meta_sha: null, intent: null, commit: null, saves: [], reset_sha: null, delegate_commits: [], adopted: [],
    recovery: null, ...fields,
    generation: N, recovery: withRecoveryDefaults(fields.recovery ?? null), created_at: now, updated_at: now,
  }, N)
  // <V> itself is ensureV's; only run/ is made here, owner-only.
  try {
    fs.mkdirSync(path.dirname(file), { mode: 0o700 })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  return createExclusive(file, rec, { guard: opts?.guard })
}

export function updateRecord(paths, N, patch, opts = {}) {
  const file = recordFile(paths, N)
  const cur = readFileRecord(file, N)
  if (cur === null) throw Object.assign(new Error(`no-record: ${file}`), { code: 'NO_RECORD', file })
  let next
  if (typeof patch === 'function') next = patch(structuredClone(cur))
  else if (isPlain(patch)) {
    next = { ...cur, ...patch }
    // A recovery object is laid over the current recovery: what it leaves out keeps its value.
    if (isPlain(patch.recovery) && cur.recovery !== null) next.recovery = { ...cur.recovery, ...patch.recovery }
  } else throw badRecord('the patch is neither an object nor a function')
  if (!isPlain(next)) throw badRecord('the update gave no record object')
  for (const key of ['v', 'generation', 'created_at']) {
    if (next[key] !== cur[key]) throw badRecord(`${key} cannot change (${JSON.stringify(cur[key])} -> ${JSON.stringify(next[key])})`)
  }
  const rec = toRecord({ ...keepAnchors(cur, { ...next, recovery: withRecoveryDefaults(next.recovery) }), updated_at: stamp() }, N)
  // An anchor is how ledger-recovered and close find a bundle: none may vanish from the record.
  const kept = new Set(anchors(rec))
  const lost = anchors(cur).filter(sha => !kept.has(sha))
  if (lost.length) throw badRecord(`the update would drop the anchored sha ${lost.join(', ')}`)
  writeReplace(file, rec, { guard: opts?.guard })
  return rec
}

// fsync(2) of a directory makes a removal durable; a filesystem that cannot sync a directory
// (EINVAL, ENOTSUP) loses nothing here, since a record that comes back is deleted again.
function fsyncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
  try {
    fs.fsyncSync(fd)
  } catch (e) {
    if (e.code !== 'EINVAL' && e.code !== 'ENOTSUP') throw e
  } finally {
    fs.closeSync(fd)
  }
}

export function deleteRecord(paths, N) {
  const file = recordFile(paths, N)
  try {
    fs.unlinkSync(file)
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
  fsyncDir(path.dirname(file))
  return true
}

// From file names alone, so a corrupt or half-written record still raises the floor that
// loop-lock's acquire takes the next generation above.
export function maxRecordGeneration(paths) {
  const gens = generations(runDir(paths), { tolerant: true })
  return gens.length ? gens[gens.length - 1] : 0
}

// ---------------------------------------------------------------- predicates

export function isResolved(rec) {
  return Boolean(rec) && (rec.phase === 'clean' || rec.recovery?.step === 'done')
}

export function committedSha(rec) {
  return rec?.commit?.sha ?? rec?.intent?.commit ?? null
}

// A bare record: phase preparing and anchoring nothing (no recovery, no save, no reset). A
// prepare killed before it resolved anything leaves one (prepare:after-preparing).
const isBare = rec => rec.phase === 'preparing' && rec.recovery === null && rec.saves.length === 0 && rec.reset_sha === null

// ownerRecord(records) -> the record that owns the clone's tree, or null: the newest
// unresolved record that is not bare; a bare record owns only when every unresolved record is
// bare (the newest of them then). records is any list (listRecords' result, or a filtered
// one); resolved records are skipped and the order given does not matter. Every other
// unresolved record is superseded by it (ruling R4 as refined: a bare record never takes the
// tree from an older one, so a prepare killed after a recovering prepare's save resumes that
// save, I7). prepare acts on this record and the planner judges it, so both name the same one.
export function ownerRecord(records) {
  const open = (records ?? []).filter(r => r && !isResolved(r)).sort((a, b) => a.generation - b.generation)
  for (let i = open.length - 1; i >= 0; i--) if (!isBare(open[i])) return open[i]
  return open.length ? open[open.length - 1] : null
}

// vettedTip: the one predicate every bundle write, rotation and chaining uses (R28: vetting is
// explicit). A tip is vetted when it is contained in the base (inBase, which the caller
// computes), is some record's committed sha (commit.sha or intent.commit), is named by a ledger
// row as a commit (commits, recovered.commits) or as a delivery bundle's tip (a bundle is only
// ever written for a vetted tip, so this keeps a tip adopted at creation vetted after its
// record is closed), or is an `adopted` entry {ref: refs/heads/<branch>, tip} of a record (the
// creating prepare stores the tips it adopted there). A record's refs snapshot never vets a
// tip: step 6 snapshots every ref of the clone, a planted one included. ledger is ledgerShas'
// result ({commits, saves, tips}); branch is '<prefix>/<date>' or a full refs/heads/ name. A
// record's delegate_commits never vet anything.
export function vettedTip({ records = [], ledger = null, branch = null, tip, inBase = false } = {}) {
  if (!isOid(tip)) return false
  if (inBase === true) return true
  const ref = typeof branch === 'string' && branch !== '' ? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) : null
  for (const rec of records ?? []) {
    if (!rec) continue
    if (committedSha(rec) === tip) return true
    if (ref && Array.isArray(rec.adopted) && rec.adopted.some(a => isPlain(a) && a.ref === ref && a.tip === tip)) return true
  }
  return Boolean(ledger?.commits?.has?.(tip) || ledger?.tips?.has?.(tip))
}

// ---------------------------------------------------------------- cloneVerdict

// Every commit rec knows (R20): a staged blob found in one of them is never index-only.
function knownCommits(rec) {
  const r = rec.recovery
  return [rec.commit?.sha, rec.intent?.commit, ...(Array.isArray(rec.delegate_commits) ? rec.delegate_commits : []),
    r?.rewind?.from, r?.rewind?.to, rec.base, rec.pre_head]
}

// cloneVerdict(rec | null, facts) -> {verdict, generation, ...}. Pure: it reads rec (the record
// ownerRecord names; callers report the others resolved or superseded without it) and facts =
// {exists, valid, symbolic, headRef, tip, dirty, indexDirty, isAncestor(a, b)}, where
// isAncestor(a, b) says a is an ancestor of b (b itself included), and changes neither.
// Verdicts and their fields:
//   no-clone
//   unknown         {why}: clone-invalid, detached, no-tip, rewind-tip, head-ref, tip, record
//   clean
//   leftovers       {base, rules, also}: save what the clone holds against base, then reset
//   committed       {sha, base: sha, rules, also, dirty}: the tip is the record's commit; any
//                   residue (dirty) is leftovers against it
//   delegate-commit {base, tip, from: tip, to: base, rules, also}: rewind <head_ref> from tip to
//                   base (base is the record's base, or its own commit when the tip descends
//                   from that), then leftovers against base
//   rewind          {from, to, base: to, rules, also}: repeat an interrupted rewind
//   resume          {sha, base, rules, also}: reset with the save sha (save again if unsaved)
//   resume-reset    {sha, relaxed: true, base, rules, also}: finish an interrupted reset
// rules names the ignore rules for listing: 'recorded' (the record's), 'current' (a record
// without recorded rules: no dispatch ran in it), 'base' (no record: only the fallback, see
// rule 2). also lists the commits, other than base, whose content the index may hold without
// it being index-only (R20): the tip that is rewound, then every commit the record knows.
// generation is the record's, or null.
// Rules, in order:
//   1 no clone -> no-clone; an invalid clone, a detached HEAD or no tip -> unknown.
//   2 no record -> leftovers against the tip when dirty or indexDirty, else clean. Its rules
//     'base' is only the fallback: the caller lists no-record leftovers under the run anchor's
//     rules (R25: the recorded rules <V>/run/refs.json holds, the current ones when it holds
//     rules: null), and under the base's rules only when there is no anchor.
//   3 an unfinished recovery: rewind-intent -> rewind (tip at from), leftovers against to (tip
//     at to), else unknown; rewound -> leftovers against recovery.base; saved -> resume (the
//     last recovery bundle); resetting -> resume-reset (recovery.reset_sha). A saved or
//     resetting recovery whose tip is not its base (recovery.base, else the record's) reads
//     unknown (tip): every save and reset path leaves HEAD at the base, and reset refuses
//     head-moved, so only a moved HEAD (a delegate's amend, say) gets here (data-safety#3).
//   4 phase saved -> resume (the last save); phase resetting -> resume-reset (reset_sha); with
//     the tip not at the record's base, unknown (tip), as in rule 3.
//   5 HEAD not on the recorded head_ref (when one is recorded) -> unknown.
//   6 intent or committed: tip at committedSha -> committed; at the base -> leftovers or clean;
//     a descendant of the commit, else of the base -> delegate-commit; else unknown.
//   7 prepared: tip at the base -> leftovers or clean; a descendant -> delegate-commit; else
//     unknown.
//   8 preparing -> leftovers against the tip, or clean.
//   9 clean -> clean, or leftovers against the base when dirty.
export function cloneVerdict(rec, facts) {
  const f = facts ?? {}
  const generation = rec ? rec.generation : null
  const out = (verdict, extra = {}) => ({ verdict, generation, ...extra })
  const unknown = why => out('unknown', { why })
  // rule 1
  if (!f.exists) return out('no-clone')
  if (!f.valid) return unknown('clone-invalid')
  if (!f.symbolic) return unknown('detached')
  const tip = f.tip
  if (!isOid(tip)) return unknown('no-tip')
  const messy = Boolean(f.dirty || f.indexDirty)
  const also = (base, list) => [...new Set(list.filter(o => isOid(o) && o !== base))]

  // rule 2 ('base' is the fallback: the caller uses the run anchor's rules when it has one, R25)
  if (!rec) return messy ? out('leftovers', { base: tip, rules: 'base', also: [] }) : out('clean')

  const rules = rec.rules ? 'recorded' : 'current'
  const known = (base, ...first) => also(base, [...first, ...knownCommits(rec)])
  const leftovers = (base, ...first) => out('leftovers', { base, rules, also: known(base, ...first) })
  const tidy = base => (messy ? leftovers(base) : out('clean'))
  const delegate = base => out('delegate-commit', { base, tip, from: tip, to: base, rules, also: known(base, tip) })

  // rule 3
  const r = rec.recovery
  if (r && r.step !== 'done') {
    const from = r.rewind?.from ?? null
    const rbase = r.base ?? rec.base ?? tip
    switch (r.step) {
      case 'rewind-intent':
        if (!r.rewind) return unknown('record')
        if (tip === r.rewind.from) return out('rewind', { from: r.rewind.from, to: r.rewind.to, base: r.rewind.to, rules, also: known(r.rewind.to, r.rewind.from) })
        if (tip === r.rewind.to) return leftovers(r.rewind.to, r.rewind.from)
        return unknown('rewind-tip')
      case 'rewound':
        return leftovers(rbase, from)
      case 'saved':
        if (!Array.isArray(r.bundles) || r.bundles.length === 0) return unknown('record')
        if (tip !== rbase) return unknown('tip')
        return out('resume', { sha: r.bundles[r.bundles.length - 1], base: rbase, rules, also: known(rbase, from) })
      case 'resetting':
        if (!isSha(r.reset_sha)) return unknown('record')
        if (tip !== rbase) return unknown('tip')
        return out('resume-reset', { sha: r.reset_sha, relaxed: true, base: rbase, rules, also: known(rbase, from) })
      default:
        return unknown('record')
    }
  }

  // rule 4
  const base = rec.base ?? null
  if (rec.phase === 'saved') {
    if (!Array.isArray(rec.saves) || rec.saves.length === 0) return unknown('record')
    const b = base ?? tip
    if (tip !== b) return unknown('tip')
    return out('resume', { sha: rec.saves[rec.saves.length - 1].sha, base: b, rules, also: known(b) })
  }
  if (rec.phase === 'resetting') {
    if (!isSha(rec.reset_sha)) return unknown('record')
    const b = base ?? tip
    if (tip !== b) return unknown('tip')
    return out('resume-reset', { sha: rec.reset_sha, relaxed: true, base: b, rules, also: known(b) })
  }

  // rule 5
  if (rec.head_ref && f.headRef !== rec.head_ref) return unknown('head-ref')

  switch (rec.phase) {
    case 'intent':
    case 'committed': { // rule 6
      const c = committedSha(rec)
      if (!isOid(c) || !isOid(base)) return unknown('record')
      if (tip === c) return out('committed', { sha: c, base: c, rules, also: known(c), dirty: messy })
      if (tip === base) return tidy(base)
      // A commit on top of the loop's own commit rewinds to that commit, never below it.
      if (f.isAncestor(c, tip)) return delegate(c)
      if (f.isAncestor(base, tip)) return delegate(base)
      return unknown('tip')
    }
    case 'prepared': // rule 7
      if (!isOid(base)) return unknown('record')
      if (tip === base) return tidy(base)
      if (f.isAncestor(base, tip)) return delegate(base)
      return unknown('tip')
    case 'preparing': // rule 8
      return tidy(tip)
    case 'clean': // rule 9
      return tidy(base ?? tip)
    default:
      return unknown('record')
  }
}
