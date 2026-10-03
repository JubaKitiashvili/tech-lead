// tests/lib/run-record.test.mjs
// The run record (stage 0c-2 brief section 9): one schema-checked file per write-capable firing,
// <V>/run/<N>.json, written through atomic.mjs; isResolved and committedSha from stored fields;
// vettedTip, the one predicate for bundle writes, rotation and chaining; and the pure
// cloneVerdict with its nine ordered rules. Records live under a real <V> (loopPaths over a
// real temporary git repository, TECH_LEAD_CACHE in a temporary directory).
import '../helpers.mjs' // scrubs inherited git routing variables from process.env before any other module loads
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as runRecord from '../../scripts/lib/run-record.mjs'
import { ledgerShas } from '../../scripts/lib/ledger.mjs'
import { ensureV, loopPaths } from '../../scripts/lib/loop-paths.mjs'

const {
  cloneVerdict, committedSha, createRecord, deleteRecord, isResolved, listRecords, maxRecordGeneration,
  readRecord, recordFile, updateRecord, vettedTip,
} = runRecord

// Keep the user's git config and hooks out of the fixture repositories.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  TECH_LEAD_CODEX_COMPANION: '/nonexistent/codex-companion.mjs',
})
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tmp = (t, prefix = 'tl-run-record-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
// A real project <P> with one commit and its <V> under a temporary cache.
const project = t => {
  const root = tmp(t)
  const P = path.join(root, 'proj')
  fs.mkdirSync(P)
  git(P, 'init', '-q', '-b', 'main')
  git(P, 'commit', '-q', '--allow-empty', '-m', 'H0')
  const env = { TECH_LEAD_CACHE: path.join(root, 'cache') }
  const paths = ensureV(loopPaths(P, { env }))
  return { root, P, env, paths, run: path.join(paths.V, 'run') }
}
const temps = dir => fs.readdirSync(dir).filter(f => f.startsWith('.tmp-'))

const O = c => c.repeat(40) // an object id
const H = c => c.repeat(64) // a sha256
const BASE = O('b'), C = O('c'), D = O('d'), CD = O('7'), ORPHAN = O('f'), PRE = O('a'), OTHER = O('e')
const BR = 'tl/2026-10-02', REF = `refs/heads/${BR}`
const TS = '2026-10-02T00:00:00.000Z'
const RULES = { v: 1, mode: 'recorded', base: BASE, ignores: [], excludes_file: null, info_exclude: { sha256: H('0'), b64: '' } }

// A complete, schema-valid record (phase prepared unless overridden).
const full = (generation, over = {}) => ({
  v: 1, generation, phase: 'prepared', pre_head: PRE, branch: BR, head_ref: REF, base: BASE,
  now_sha256: H('1'), rules: null, refs: { [REF]: BASE, 'refs/tech-lead/base': BASE }, meta_sha: H('2'),
  intent: null, commit: null, saves: [], reset_sha: null, delegate_commits: [], adopted: [], recovery: null,
  created_at: TS, updated_at: TS, ...over,
})
const recovery = over => ({ by: 9, base: BASE, rewind: null, bundles: [], reset_sha: null, step: 'saved', note: null, ...over })
const writeRaw = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n')
}

// Ancestry for the pure verdict tests: BASE <- C <- CD, BASE <- D; ORPHAN and OTHER unrelated.
const PARENT = { [C]: BASE, [D]: BASE, [CD]: C }
const calls = []
const isAncestor = (a, b) => {
  calls.push([a, b])
  for (let x = b; x; x = PARENT[x]) if (x === a) return true
  return false
}
const facts = over => ({ exists: true, valid: true, symbolic: true, headRef: REF, tip: BASE, dirty: false, indexDirty: false, isAncestor, ...over })
// The verdict holds every expected field with an equal value (also compared as a set).
const asSet = (k, v) => (k === 'also' && Array.isArray(v) ? [...v].sort() : v)
const like = (actual, expected, msg) => {
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(asSet(k, actual[k]), asSet(k, v), `${msg ?? ''} field ${k} of ${JSON.stringify(actual)}`)
  }
}
const deepFreeze = o => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

test('run-record exports what brief section 9 names', () => {
  for (const name of ['recordFile', 'readRecord', 'listRecords', 'createRecord', 'updateRecord', 'deleteRecord',
    'maxRecordGeneration', 'isResolved', 'committedSha', 'vettedTip', 'cloneVerdict']) {
    assert.equal(typeof runRecord[name], 'function', name)
  }
})

test('recordFile is <V>/run/<N>.json and refuses a generation that is not a positive safe integer', t => {
  const { paths } = project(t)
  assert.equal(recordFile(paths, 7), path.join(paths.V, 'run', '7.json'))
  assert.equal(recordFile(paths, 123456), path.join(paths.V, 'run', '123456.json'))
  for (const bad of [0, -1, 1.5, '7', null, undefined, NaN, 2 ** 53, Infinity]) {
    assert.throws(() => recordFile(paths, bad), /bad-generation/, String(bad))
  }
})

test('createRecord writes a complete record once; a second create is false and changes nothing', t => {
  const { paths, run } = project(t)
  assert.equal(fs.existsSync(run), false)
  assert.equal(createRecord(paths, 5, { phase: 'preparing', pre_head: PRE }), true)
  assert.equal(fs.statSync(run).mode & 0o777, 0o700)
  const text = fs.readFileSync(recordFile(paths, 5), 'utf8')
  assert.ok(text.endsWith('\n') && !text.slice(0, -1).includes('\n'), 'one JSON line')
  const rec = readRecord(paths, 5)
  assert.deepEqual(Object.keys(rec).sort(), Object.keys(full(5)).sort())
  like(rec, {
    v: 1, generation: 5, phase: 'preparing', pre_head: PRE, branch: null, head_ref: null, base: null, now_sha256: null,
    rules: null, refs: {}, meta_sha: null, intent: null, commit: null, saves: [], reset_sha: null, delegate_commits: [],
    adopted: [], recovery: null,
  })
  assert.match(rec.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(rec.updated_at, rec.created_at)

  assert.equal(createRecord(paths, 5, { phase: 'clean' }), false)
  assert.equal(fs.readFileSync(recordFile(paths, 5), 'utf8'), text)
  assert.deepEqual(temps(run), [], 'no temporary file is left behind')
})

test('createRecord also takes the generation inside the fields; a mismatch is refused', t => {
  const { paths } = project(t)
  assert.equal(createRecord(paths, { generation: 3, phase: 'preparing', pre_head: null }), true)
  assert.equal(readRecord(paths, 3).generation, 3)
  assert.throws(() => createRecord(paths, 4, { generation: 5 }), /bad-record/)
  assert.equal(fs.existsSync(recordFile(paths, 4)), false)
  assert.equal(fs.existsSync(recordFile(paths, 5)), false)
})

test('createRecord refuses a record that would not pass the schema, and writes nothing', t => {
  const { paths, run } = project(t)
  const refusals = [
    { phase: 'running' }, { pre_head: 'HEAD' }, { unknown_key: 1 }, { branch: 'main', head_ref: 'refs/heads/main' },
    { phase: 'prepared' }, // prepared needs a base
    { saves: [{ sha: 'abc', why: 'pause' }] },
    { recovery: { by: 2, step: 'done', note: 'superseded' } }, // by < generation
  ]
  for (const fields of refusals) {
    assert.throws(() => createRecord(paths, 6, fields), err => err.code === 'BAD_RECORD' && /^bad-record: /.test(err.message), JSON.stringify(fields))
  }
  assert.equal(fs.existsSync(run), false, 'a refused record does not even make run/')
  createRecord(paths, 5, {})
  assert.throws(() => createRecord(paths, 6, { phase: 'saved', base: BASE }), { code: 'BAD_RECORD' })
  assert.equal(fs.existsSync(recordFile(paths, 6)), false)
  assert.deepEqual(temps(run), [])
})

test('createRecord never creates <V> itself', t => {
  const { root, P } = project(t)
  const paths = loopPaths(P, { env: { TECH_LEAD_CACHE: path.join(root, 'other-cache') } })
  assert.throws(() => createRecord(paths, 1, {}), { code: 'ENOENT' })
  assert.equal(fs.existsSync(paths.V), false)
})

test('readRecord: a missing record is null; a full record reads back unchanged', t => {
  const { paths } = project(t)
  assert.equal(readRecord(paths, 1), null)
  const rec = full(8, {
    phase: 'committed', rules: RULES, intent: { tree: OTHER, parent: BASE, commit: C }, commit: { sha: C },
    saves: [{ sha: H('3'), why: 'clean-clone' }], reset_sha: H('4'), delegate_commits: [D],
    refs: { [REF]: C, 'refs/tags/v1': OTHER, 'refs/remotes/origin/main': BASE },
    recovery: recovery({ by: 9, rewind: { from: D, to: BASE }, bundles: [H('5')], reset_sha: H('5'), step: 'done', note: null }),
  })
  writeRaw(recordFile(paths, 8), rec)
  assert.deepEqual(readRecord(paths, 8), rec)
  // A sha256 object id (a sha256 repository) is an object id too.
  const rec64 = full(10, { base: H('b'), pre_head: H('a'), refs: { [REF]: H('b') } })
  writeRaw(recordFile(paths, 10), rec64)
  assert.deepEqual(readRecord(paths, 10), rec64)
})

test('readRecord refuses every schema violation as corrupt: <file>', t => {
  const { paths } = project(t)
  const file = recordFile(paths, 7)
  const cases = [
    ['not JSON', '{"v":1,'],
    ['an array', '[1]\n'],
    ['null', 'null\n'],
    ['v 2', r => ({ ...r, v: 2 })],
    ['a missing key', r => { const { meta_sha, ...rest } = r; return rest }],
    ['an unknown key', r => ({ ...r, item_id: 'x' })],
    ['generation other than the file name', r => ({ ...r, generation: 8 })],
    ['generation a string', r => ({ ...r, generation: '7' })],
    ['an unknown phase', r => ({ ...r, phase: 'done' })],
    ['pre_head not an object id', r => ({ ...r, pre_head: 'HEAD' })],
    ['an upper-case object id', r => ({ ...r, base: 'B'.repeat(40) })],
    ['head_ref not a dated branch', r => ({ ...r, branch: 'main', head_ref: 'refs/heads/main' })],
    ['branch and head_ref disagree', r => ({ ...r, branch: 'tl/2026-10-03' })],
    ['branch without head_ref', r => ({ ...r, head_ref: null })],
    ['now_sha256 short', r => ({ ...r, now_sha256: 'abc' })],
    ['rules of another version', r => ({ ...r, rules: { ...RULES, v: 2 } })],
    ['rules with an unknown mode', r => ({ ...r, rules: { ...RULES, mode: 'live' } })],
    ['refs an array', r => ({ ...r, refs: [] })],
    ['a ref outside refs/', r => ({ ...r, refs: { HEAD: BASE } })],
    ['a ref naming no object id', r => ({ ...r, refs: { [REF]: 'main' } })],
    ['meta_sha an object id', r => ({ ...r, meta_sha: BASE })],
    ['intent missing its commit', r => ({ ...r, intent: { tree: OTHER, parent: BASE } })],
    ['commit with an extra key', r => ({ ...r, commit: { sha: C, extra: 1 } })],
    ['saves not a list', r => ({ ...r, saves: {} })],
    ['a save sha that is an object id', r => ({ ...r, saves: [{ sha: C, why: 'pause' }] })],
    ['a save without why', r => ({ ...r, saves: [{ sha: H('3') }] })],
    ['reset_sha short', r => ({ ...r, reset_sha: 'ab' })],
    ['a delegate commit that is no object id', r => ({ ...r, delegate_commits: ['x'] })],
    ['recovery by a later generation only', r => ({ ...r, recovery: recovery({ by: 6, step: 'done' }) })],
    ['recovery with an unknown step', r => ({ ...r, recovery: recovery({ step: 'halfway' }) })],
    ['recovery with an unknown note', r => ({ ...r, recovery: recovery({ step: 'done', note: 'lost' }) })],
    ['a note on an unfinished recovery', r => ({ ...r, recovery: recovery({ step: 'saved', bundles: [H('5')], note: 'superseded' }) })],
    ['recovery missing a key', r => { const { reset_sha, ...rest } = recovery({ step: 'done' }); return { ...r, recovery: rest } }],
    ['rewind-intent without rewind', r => ({ ...r, recovery: recovery({ step: 'rewind-intent', rewind: null }) })],
    ['rewound without rewind', r => ({ ...r, recovery: recovery({ step: 'rewound', rewind: null }) })],
    ['recovery step saved without a bundle', r => ({ ...r, recovery: recovery({ step: 'saved', bundles: [] }) })],
    ['recovery step resetting without reset_sha', r => ({ ...r, recovery: recovery({ step: 'resetting', bundles: [H('5')], reset_sha: null }) })],
    ['phase prepared without base', r => ({ ...r, base: null })],
    ['phase intent without intent', r => ({ ...r, phase: 'intent' })],
    ['phase committed without commit', r => ({ ...r, phase: 'committed', intent: { tree: OTHER, parent: BASE, commit: C } })],
    ['phase saved without a save', r => ({ ...r, phase: 'saved' })],
    ['phase resetting without reset_sha', r => ({ ...r, phase: 'resetting', saves: [{ sha: H('3'), why: 'pause' }] })],
    ['created_at not a timestamp', r => ({ ...r, created_at: 'yesterday' })],
  ]
  for (const [label, change] of cases) {
    writeRaw(file, typeof change === 'string' ? change : change(full(7)))
    assert.throws(() => readRecord(paths, 7), err => err.code === 'CORRUPT' && err.message.startsWith(`corrupt: ${file}`), label)
  }
  // Not a regular file at the record's name: a directory, a symlink to a valid record.
  fs.rmSync(file)
  fs.mkdirSync(file)
  assert.throws(() => readRecord(paths, 7), { code: 'CORRUPT' })
  fs.rmdirSync(file)
  const elsewhere = path.join(paths.V, 'elsewhere.json')
  writeRaw(elsewhere, full(7))
  fs.symlinkSync(elsewhere, file)
  assert.throws(() => readRecord(paths, 7), { code: 'CORRUPT' })
})

test('listRecords: ascending by generation, only record names, a corrupt record throws', t => {
  const { paths, run } = project(t)
  assert.deepEqual(listRecords(paths), [])
  for (const g of [10, 2, 9]) writeRaw(recordFile(paths, g), full(g))
  fs.mkdirSync(path.join(run, 'empty-template'))
  for (const odd of ['.tmp-1-abcdef.json', '011.json', 'x.json', '12.json.tmp', '0.json', 'notes.txt']) writeRaw(path.join(run, odd), 'junk')
  assert.deepEqual(listRecords(paths).map(r => r.generation), [2, 9, 10])
  writeRaw(recordFile(paths, 4), '{broken')
  assert.throws(() => listRecords(paths), err => err.code === 'CORRUPT' && err.message.includes(recordFile(paths, 4)))
})

test('updateRecord merges a patch or applies a function, keeps created_at and refreshes updated_at', async t => {
  const { paths, run } = project(t)
  createRecord(paths, 4, { phase: 'preparing', pre_head: PRE })
  const created = readRecord(paths, 4).created_at
  await new Promise(resolve => setTimeout(resolve, 5))
  const r1 = updateRecord(paths, 4, { phase: 'prepared', branch: BR, head_ref: REF, base: BASE, refs: { [REF]: BASE } })
  like(r1, { phase: 'prepared', branch: BR, head_ref: REF, base: BASE, pre_head: PRE, created_at: created })
  assert.ok(r1.updated_at > created, 'updated_at moves on')
  assert.deepEqual(readRecord(paths, 4), r1)

  const r2 = updateRecord(paths, 4, rec => ({ ...rec, delegate_commits: [...rec.delegate_commits, D] }))
  assert.deepEqual(r2.delegate_commits, [D])
  assert.deepEqual(readRecord(paths, 4).delegate_commits, [D])
  assert.deepEqual(temps(run), [])
})

test('updateRecord fills the optional recovery fields a short recovery leaves out', t => {
  const { paths } = project(t)
  writeRaw(recordFile(paths, 3), full(3))
  const rec = updateRecord(paths, 3, { recovery: { by: 5, step: 'done', note: 'superseded' } })
  assert.deepEqual(rec.recovery, { by: 5, base: null, rewind: null, bundles: [], reset_sha: null, step: 'done', note: 'superseded' })
  assert.deepEqual(readRecord(paths, 3).recovery, rec.recovery)
})

// A record that anchors bundles: two saves and a reset of its own, and a recovery by a later
// holder that saved twice and was resetting with the second bundle.
const anchored = generation => full(generation, {
  saves: [{ sha: H('3'), why: 'attempt-failed' }, { sha: H('4'), why: 'pause' }], reset_sha: H('4'),
  recovery: recovery({ by: 6, rewind: { from: D, to: BASE }, bundles: [H('5'), H('6')], reset_sha: H('6'), step: 'resetting' }),
})

test('marking a record superseded or clone-missing keeps every anchor: saves, reset_sha, recovery bundles and reset', t => {
  const { paths } = project(t)
  for (const note of ['superseded', 'clone-missing']) {
    writeRaw(recordFile(paths, 3), anchored(3))
    const before = readRecord(paths, 3)
    // The brief's shorthand: a recovery that leaves out base, rewind, bundles and reset_sha.
    const rec = updateRecord(paths, 3, { recovery: { by: 7, step: 'done', note } })
    assert.deepEqual(rec.saves, before.saves, note)
    assert.equal(rec.reset_sha, H('4'), note)
    assert.deepEqual(rec.recovery, {
      by: 7, base: BASE, rewind: { from: D, to: BASE }, bundles: [H('5'), H('6')], reset_sha: H('6'), step: 'done', note,
    }, note)
    assert.deepEqual(readRecord(paths, 3), rec, note)
    assert.equal(isResolved(rec), true, note)
  }
})

test('updateRecord never replaces an anchor with an empty value, from an object patch or a function', t => {
  const { paths } = project(t)
  const emptied = [
    { saves: [], reset_sha: null, recovery: { by: 7, base: null, rewind: null, bundles: [], reset_sha: null, step: 'done', note: 'superseded' } },
    rec => ({ ...rec, saves: [], reset_sha: null, recovery: { ...rec.recovery, by: 7, bundles: [], reset_sha: null, step: 'done', note: 'superseded' } }),
  ]
  for (const patch of emptied) {
    writeRaw(recordFile(paths, 3), anchored(3))
    const rec = updateRecord(paths, 3, patch)
    assert.deepEqual(rec.saves, anchored(3).saves)
    assert.equal(rec.reset_sha, H('4'))
    assert.deepEqual(rec.recovery.bundles, [H('5'), H('6')])
    assert.equal(rec.recovery.reset_sha, H('6'))
    assert.equal(rec.recovery.step, 'done')
    assert.equal(rec.recovery.by, 7)
  }
})

test('updateRecord merges new anchors in after the old ones, so the last save and the last bundle stay the newest', t => {
  const { paths } = project(t)
  writeRaw(recordFile(paths, 3), anchored(3))
  // A patch listing only the new entry, and a function appending it, give the same lists.
  const a = updateRecord(paths, 3, { saves: [{ sha: H('7'), why: 'pause' }] })
  assert.deepEqual(a.saves.map(s => s.sha), [H('3'), H('4'), H('7')])
  const b = updateRecord(paths, 3, rec => ({ ...rec, saves: [...rec.saves, { sha: H('8'), why: 'codex' }] }))
  assert.deepEqual(b.saves.map(s => s.sha), [H('3'), H('4'), H('7'), H('8')])
  // The same bundle saved again after another one is a new, newest entry, not a duplicate dropped.
  const c = updateRecord(paths, 3, rec => ({ ...rec, saves: [...rec.saves, { sha: H('3'), why: 'attempt-failed' }] }))
  assert.deepEqual(c.saves.map(s => s.sha), [H('3'), H('4'), H('7'), H('8'), H('3')])
  const d = updateRecord(paths, 3, { recovery: { by: 7, bundles: [H('9')], step: 'saved' } })
  assert.deepEqual(d.recovery.bundles, [H('5'), H('6'), H('9')])
  assert.equal(d.recovery.reset_sha, H('6'))
  like(cloneVerdict(d, facts()), { verdict: 'resume', sha: H('9') })
  // A new reset sha replaces the old one when the old one stays anchored elsewhere.
  const e = updateRecord(paths, 3, { recovery: { by: 7, reset_sha: H('9'), step: 'resetting' } })
  assert.equal(e.recovery.reset_sha, H('9'))
  assert.deepEqual(e.recovery.bundles, [H('5'), H('6'), H('9')])
  const f = updateRecord(paths, 3, { reset_sha: H('8') })
  assert.equal(f.reset_sha, H('8'))
})

test('updateRecord refuses an update that would drop an anchored sha, and writes nothing', t => {
  const { paths } = project(t)
  // A reset sha anchored nowhere else: replacing it would lose the only record of that bundle.
  writeRaw(recordFile(paths, 3), full(3, { recovery: recovery({ by: 6, bundles: [], reset_sha: H('6'), step: 'resetting' }) }))
  const before = fs.readFileSync(recordFile(paths, 3), 'utf8')
  for (const patch of [
    { recovery: { by: 7, reset_sha: H('9'), step: 'resetting' } },
    { recovery: null },
    rec => ({ ...rec, recovery: null }),
  ]) {
    assert.throws(() => updateRecord(paths, 3, patch), err => err.code === 'BAD_RECORD' && err.message.includes(H('6')), String(patch))
  }
  writeRaw(recordFile(paths, 4), full(4, { phase: 'resetting', saves: [], reset_sha: H('4') }))
  assert.throws(() => updateRecord(paths, 4, { reset_sha: H('8') }), err => err.code === 'BAD_RECORD' && err.message.includes(H('4')))
  assert.equal(fs.readFileSync(recordFile(paths, 3), 'utf8'), before)
})

test('ownerRecord: the newest unresolved record owns the tree, but a bare preparing record never takes it from an older one', () => {
  const { ownerRecord } = runRecord
  assert.equal(typeof ownerRecord, 'function')
  const bare = g => full(g, { phase: 'preparing', branch: null, head_ref: null, base: null, refs: {} })
  const committed = full(2, { phase: 'committed', commit: { sha: C } })
  const done = g => full(g, { recovery: recovery({ step: 'done', note: 'superseded' }) })
  assert.equal(ownerRecord([]), null)
  assert.equal(ownerRecord([done(1), full(2, { phase: 'clean' })]), null)
  // A committed older record behind a preparing record killed at prepare:after-preparing.
  assert.equal(ownerRecord([committed, bare(3)]), committed)
  assert.equal(ownerRecord([bare(3), committed]), committed, 'the order given does not matter')
  assert.equal(ownerRecord([done(1), committed, bare(3), bare(4)]), committed)
  // An unfinished recovery is never bare: a recovering prepare killed after its save.
  const resuming = full(2, { recovery: recovery({ by: 3, bundles: [H('5')], step: 'saved' }) })
  assert.equal(ownerRecord([resuming, bare(3)]), resuming)
  // The newest of several non-bare records owns; the newest bare record owns when every one is bare.
  const prepared = full(3)
  assert.equal(ownerRecord([committed, prepared, bare(4)]), prepared)
  assert.equal(ownerRecord([bare(3), bare(5), bare(4)]).generation, 5)
  assert.equal(ownerRecord([done(1), bare(4)]).generation, 4)
  // A preparing record that anchors something is not bare.
  const saving = full(4, { phase: 'preparing', saves: [{ sha: H('5'), why: 'clean-clone' }] })
  assert.equal(ownerRecord([committed, saving]), saving)
  const recovering = full(4, { phase: 'preparing', recovery: recovery({ by: 4, bundles: [H('5')], step: 'saved' }) })
  assert.equal(ownerRecord([committed, recovering]), recovering)
})

test('updateRecord refuses a missing record, a corrupt one, an identity change and an invalid result', t => {
  const { paths } = project(t)
  assert.throws(() => updateRecord(paths, 2, { phase: 'clean' }), err => err.code === 'NO_RECORD' && /^no-record: /.test(err.message))
  assert.equal(fs.existsSync(recordFile(paths, 2)), false)
  writeRaw(recordFile(paths, 2), '{broken')
  assert.throws(() => updateRecord(paths, 2, { phase: 'clean' }), { code: 'CORRUPT' })

  writeRaw(recordFile(paths, 3), full(3))
  const before = fs.readFileSync(recordFile(paths, 3), 'utf8')
  for (const patch of [{ generation: 4 }, { v: 2 }, { created_at: '2020-01-01T00:00:00.000Z' }, { phase: 'intent' }, { base: 'x' },
    { recovery: { by: 2, step: 'done' } }, rec => ({ ...rec, generation: 9 }), () => null]) {
    assert.throws(() => updateRecord(paths, 3, patch), { code: 'BAD_RECORD' }, String(patch.toString?.() ?? JSON.stringify(patch)))
  }
  assert.equal(fs.readFileSync(recordFile(paths, 3), 'utf8'), before)
})

test('deleteRecord removes a record; a missing one is false', t => {
  const { paths } = project(t)
  writeRaw(recordFile(paths, 3), full(3))
  assert.equal(deleteRecord(paths, 3), true)
  assert.equal(fs.existsSync(recordFile(paths, 3)), false)
  assert.equal(deleteRecord(paths, 3), false)
  assert.equal(deleteRecord(paths, 99), false)
})

test('maxRecordGeneration reads only file names and tolerates everything else', t => {
  const { paths, run } = project(t)
  assert.equal(maxRecordGeneration(paths), 0, 'no run directory')
  fs.mkdirSync(run)
  assert.equal(maxRecordGeneration(paths), 0, 'an empty run directory')
  writeRaw(recordFile(paths, 3), full(3))
  writeRaw(recordFile(paths, 12), '{not even json') // content is never read
  fs.mkdirSync(path.join(run, 'empty-template'))
  const odd = [
    '.tmp-99999-0123456789abcdef', '.tmp-4-1.json', '0400.json', '0.json', '-50.json', '50.json.tmp', '50.JSON', 'x50.json',
    '50', '1e9.json', '5.5.json', ' 60.json', '99999999999999999999.json', '+70.json', '80.json~', '0x90.json',
  ]
  for (const name of odd) writeRaw(path.join(run, name), 'junk')
  assert.equal(maxRecordGeneration(paths), 12)
  fs.mkdirSync(path.join(run, '15.json')) // a directory at a record name still counts by its name
  assert.equal(maxRecordGeneration(paths), 15)
  // A plain file where the run directory belongs reads as no records.
  fs.rmSync(run, { recursive: true })
  fs.writeFileSync(run, 'not a directory')
  assert.equal(maxRecordGeneration(paths), 0)
})

test('isResolved reads only stored fields: phase clean, or a finished recovery', () => {
  assert.equal(isResolved(full(3, { phase: 'clean', base: null, head_ref: null, branch: null })), true)
  assert.equal(isResolved(full(3, { recovery: recovery({ step: 'done', note: 'superseded' }) })), true)
  assert.equal(isResolved(full(3, { phase: 'committed', commit: { sha: C }, recovery: recovery({ step: 'done' }) })), true)
  for (const phase of ['preparing', 'prepared', 'intent', 'committed', 'saved', 'resetting']) {
    assert.equal(isResolved(full(3, { phase })), false, phase)
  }
  for (const step of ['rewind-intent', 'rewound', 'saved', 'resetting']) {
    assert.equal(isResolved(full(3, { recovery: recovery({ step, rewind: { from: D, to: BASE }, bundles: [H('5')], reset_sha: H('5') }) })), false, step)
  }
  // Nothing about the clone is consulted: a second argument changes nothing.
  assert.equal(isResolved(full(3), facts({ dirty: true })), false)
  assert.equal(isResolved(full(3, { phase: 'clean' }), facts({ exists: false })), true)
})

test('committedSha is commit.sha, else intent.commit, else null', () => {
  assert.equal(committedSha(full(3, { commit: { sha: C }, intent: { tree: OTHER, parent: BASE, commit: CD } })), C)
  assert.equal(committedSha(full(3, { intent: { tree: OTHER, parent: BASE, commit: CD } })), CD)
  assert.equal(committedSha(full(3)), null)
})

test('vettedTip accepts each source on its own and nothing else', t => {
  const S = tmp(t)
  fs.writeFileSync(path.join(S, 'LEDGER.jsonl'), [
    JSON.stringify({ iteration: 1, commits: [O('1')], saves: [{ sha: H('6'), why: 'pause' }], bundles: [{ branch: BR, tip: O('2'), file: 'out/x.bundle', sha256: H('7'), why: 'commit' }] }),
    JSON.stringify({ iteration: 2, commits: [], recovered: { generations: [1], action: 'finish', commits: [O('3')], bundles: [H('8')], task: null } }),
  ].join('\n') + '\n')
  const ledger = ledgerShas(S)
  const records = [
    full(4, { phase: 'committed', commit: { sha: O('4') }, refs: { [REF]: O('4') }, delegate_commits: [O('9')] }),
    full(5, { phase: 'intent', intent: { tree: OTHER, parent: BASE, commit: O('5') }, refs: { [REF]: BASE, 'refs/heads/tl/2026-09-30': O('a') } }),
    full(3, { phase: 'clean', adopted: [{ ref: 'refs/heads/tl/2026-09-30', tip: O('6') }] }),
  ]
  const v = (tip, over = {}) => vettedTip({ records, ledger, branch: 'tl/2026-09-30', tip, inBase: false, ...over })
  assert.equal(v(O('4')), true, "a record's committed sha")
  assert.equal(v(O('5')), true, "a record's intent commit")
  assert.equal(v(O('1')), true, 'a ledger commit')
  assert.equal(v(O('3')), true, 'a ledger recovered commit')
  assert.equal(v(O('2')), true, 'a ledger delivery bundle tip')
  assert.equal(v(O('6')), true, "a tip adopted at creation (an adopted entry of that branch)")
  assert.equal(v(O('6'), { branch: 'refs/heads/tl/2026-09-30' }), true, 'the branch given as a full ref name')
  assert.equal(v(O('a')), false, "a record's refs snapshot is no adoption (R28)")
  assert.equal(v(O('8'), { inBase: true }), true, 'contained in the base')
  assert.equal(v(O('8')), false, 'none of them')
  assert.equal(v(O('6'), { branch: 'tl/2026-10-01' }), false, 'an adoption of another branch')
  assert.equal(v(O('6'), { branch: null }), false, 'no branch, no adoption')
  assert.equal(v(O('9')), false, 'a delegate commit is never vetted by its record')
  assert.equal(v(H('6')), false, 'a recovery bundle sha is no commit')
  assert.equal(v(null, { inBase: true }), false, 'no tip')
  assert.equal(v('HEAD', { inBase: true }), false, 'a tip that is no object id')
  assert.equal(vettedTip({ records: [], ledger: ledgerShas(path.join(S, 'missing')), branch: BR, tip: O('1'), inBase: false }), false)
  assert.equal(vettedTip({ records: [], ledger: null, branch: BR, tip: O('1'), inBase: true }), true)
})

// ---------------------------------------------------------------- cloneVerdict

test('rule 1: no clone, then an invalid clone or a detached HEAD, before anything else', () => {
  const unfinished = full(9, { recovery: recovery({ by: 9, step: 'saved', bundles: [H('5')] }) })
  for (const rec of [null, full(9), unfinished]) {
    like(cloneVerdict(rec, facts({ exists: false, valid: false, symbolic: false, dirty: true })), { verdict: 'no-clone' })
    like(cloneVerdict(rec, facts({ valid: false, dirty: true })), { verdict: 'unknown', why: 'clone-invalid' })
    like(cloneVerdict(rec, facts({ symbolic: false, headRef: null, dirty: true })), { verdict: 'unknown', why: 'detached' })
  }
  like(cloneVerdict(null, facts({ tip: null })), { verdict: 'unknown', why: 'no-tip' })
})

test('rule 2: no record -> leftovers against the tip under the base rules, or clean', () => {
  like(cloneVerdict(null, facts({ tip: OTHER, dirty: true })), { verdict: 'leftovers', generation: null, base: OTHER, rules: 'base', also: [] })
  like(cloneVerdict(null, facts({ tip: OTHER, indexDirty: true })), { verdict: 'leftovers', base: OTHER, rules: 'base' })
  like(cloneVerdict(null, facts({ tip: OTHER, headRef: 'refs/heads/x/2026-01-01' })), { verdict: 'clean', generation: null })
})

test('rule 3: an unfinished rewind-intent goes by the tip (at from, at to, elsewhere) before the phase', () => {
  const rec = full(6, { recovery: recovery({ by: 7, step: 'rewind-intent', rewind: { from: D, to: BASE } }) })
  like(cloneVerdict(rec, facts({ tip: D })), { verdict: 'rewind', generation: 6, from: D, to: BASE, base: BASE, also: [D, PRE] })
  // At to (the CAS ran, the step was not written): leftovers against to, also from, even when status is clean.
  like(cloneVerdict(rec, facts({ tip: BASE, indexDirty: true })), { verdict: 'leftovers', base: BASE, rules: 'current', also: [D, PRE] })
  like(cloneVerdict(rec, facts({ tip: BASE })), { verdict: 'leftovers', base: BASE, also: [D, PRE] })
  like(cloneVerdict(rec, facts({ tip: C })), { verdict: 'unknown', why: 'rewind-tip' })
  // Before the phase: the same tip D under phase prepared alone would read delegate-commit.
  like(cloneVerdict(full(6), facts({ tip: D })), { verdict: 'delegate-commit' })
  // Before the head ref check (rule 5).
  like(cloneVerdict(rec, facts({ tip: D, headRef: 'refs/heads/tl/2026-10-01' })), { verdict: 'rewind' })
  // Recorded rules are named when the record has them.
  like(cloneVerdict({ ...rec, rules: RULES }, facts({ tip: BASE })), { verdict: 'leftovers', rules: 'recorded' })
})

test('rule 3: rewound -> leftovers against recovery.base; saved -> resume; resetting -> relaxed resume-reset', () => {
  const rewound = full(6, { phase: 'committed', commit: { sha: C }, recovery: recovery({ step: 'rewound', base: BASE, rewind: { from: D, to: BASE } }) })
  like(cloneVerdict(rewound, facts({ tip: BASE, dirty: true })), { verdict: 'leftovers', base: BASE, also: [D, C, PRE] })
  like(cloneVerdict(rewound, facts({ tip: BASE })), { verdict: 'leftovers', base: BASE })

  const saved = full(6, { phase: 'intent', intent: { tree: OTHER, parent: BASE, commit: C }, recovery: recovery({ step: 'saved', bundles: [H('5'), H('6')] }) })
  like(cloneVerdict(saved, facts({ tip: BASE, headRef: 'refs/heads/tl/2026-01-01' })), { verdict: 'resume', generation: 6, sha: H('6'), base: BASE })
  like(cloneVerdict(saved, facts({ tip: ORPHAN })), { verdict: 'unknown', why: 'tip' })
  const savedAfterRewind = full(6, { recovery: recovery({ step: 'saved', bundles: [H('5')], rewind: { from: D, to: BASE } }) })
  like(cloneVerdict(savedAfterRewind, facts({ tip: BASE })), { verdict: 'resume', sha: H('5'), base: BASE, also: [D, PRE] })

  const resetting = full(6, { recovery: recovery({ step: 'resetting', bundles: [H('5')], reset_sha: H('5') }) })
  like(cloneVerdict(resetting, facts({ tip: BASE, dirty: true })), { verdict: 'resume-reset', sha: H('5'), relaxed: true, base: BASE })
  like(cloneVerdict(resetting, facts({ tip: ORPHAN, dirty: true })), { verdict: 'unknown', why: 'tip' })

  // A finished recovery is no longer judged by rule 3: the phase decides.
  const done = full(6, { recovery: recovery({ step: 'done', note: 'superseded' }) })
  like(cloneVerdict(done, facts({ tip: BASE })), { verdict: 'clean' })
})

test('rule 4: phase saved -> resume with the last save; phase resetting -> relaxed resume-reset; both before the head ref check', () => {
  const saved = full(5, { phase: 'saved', saves: [{ sha: H('3'), why: 'pause' }, { sha: H('4'), why: 'attempt-failed' }] })
  like(cloneVerdict(saved, facts({ tip: BASE, dirty: true })), { verdict: 'resume', sha: H('4'), base: BASE, rules: 'current' })
  like(cloneVerdict(saved, facts({ tip: D, dirty: true })), { verdict: 'unknown', why: 'tip' })
  like(cloneVerdict(saved, facts({ tip: BASE, headRef: 'refs/heads/tl/2026-01-01' })), { verdict: 'resume', sha: H('4') })
  const resetting = full(5, { phase: 'resetting', saves: [{ sha: H('3'), why: 'pause' }], reset_sha: H('3'), rules: RULES })
  like(cloneVerdict(resetting, facts({ tip: BASE, headRef: 'refs/heads/tl/2026-01-01' })), { verdict: 'resume-reset', sha: H('3'), relaxed: true, rules: 'recorded' })
  // An unfinished recovery still comes first.
  const both = { ...saved, recovery: recovery({ step: 'saved', bundles: [H('9')] }) }
  like(cloneVerdict(both, facts({ tip: BASE })), { verdict: 'resume', sha: H('9') })
})

test('rule 5: HEAD on another branch than the recorded head_ref -> unknown; no head_ref, no check', () => {
  const other = 'refs/heads/tl/2026-10-01'
  like(cloneVerdict(full(5), facts({ headRef: other })), { verdict: 'unknown', why: 'head-ref' })
  like(cloneVerdict(full(5, { phase: 'intent', intent: { tree: OTHER, parent: BASE, commit: C } }), facts({ headRef: other, tip: C })), { verdict: 'unknown', why: 'head-ref' })
  like(cloneVerdict(full(5, { phase: 'clean' }), facts({ headRef: other })), { verdict: 'unknown', why: 'head-ref' })
  const preparing = full(5, { phase: 'preparing', branch: null, head_ref: null, base: null })
  like(cloneVerdict(preparing, facts({ headRef: other, tip: OTHER, dirty: true })), { verdict: 'leftovers', base: OTHER })
})

test('rule 6: intent and committed against committedSha, the base, a delegate commit, or unknown', () => {
  const intent = full(5, { phase: 'intent', intent: { tree: OTHER, parent: BASE, commit: C }, rules: RULES })
  const committed = full(5, { phase: 'committed', intent: { tree: OTHER, parent: BASE, commit: C }, commit: { sha: C }, rules: RULES })
  for (const rec of [intent, committed]) {
    like(cloneVerdict(rec, facts({ tip: C })), { verdict: 'committed', sha: C, base: C, also: [BASE, PRE], rules: 'recorded', dirty: false })
    like(cloneVerdict(rec, facts({ tip: C, dirty: true })), { verdict: 'committed', sha: C, dirty: true })
    like(cloneVerdict(rec, facts({ tip: C, indexDirty: true })), { verdict: 'committed', dirty: true })
    like(cloneVerdict(rec, facts({ tip: BASE, dirty: true })), { verdict: 'leftovers', base: BASE, also: [C, PRE], rules: 'recorded' })
    like(cloneVerdict(rec, facts({ tip: BASE })), { verdict: 'clean' })
    like(cloneVerdict(rec, facts({ tip: D })), { verdict: 'delegate-commit', base: BASE, tip: D, from: D, to: BASE, also: [D, C, PRE] })
    like(cloneVerdict(rec, facts({ tip: ORPHAN })), { verdict: 'unknown', why: 'tip' })
  }
  // A commit on top of the loop's own commit rewinds to that commit, never below it.
  like(cloneVerdict(committed, facts({ tip: CD, dirty: true })), { verdict: 'delegate-commit', base: C, tip: CD, from: CD, to: C, also: [CD, BASE, PRE] })
  // committedSha prefers commit.sha over intent.commit.
  const moved = { ...committed, commit: { sha: CD } }
  like(cloneVerdict(moved, facts({ tip: CD })), { verdict: 'committed', sha: CD })
})

test('rule 6 asks isAncestor(base, tip), base first', () => {
  calls.length = 0
  cloneVerdict(full(5, { phase: 'intent', intent: { tree: OTHER, parent: BASE, commit: C } }), facts({ tip: D }))
  assert.deepEqual(calls.at(-1), [BASE, D])
  calls.length = 0
  cloneVerdict(full(5), facts({ tip: D }))
  assert.deepEqual(calls, [[BASE, D]])
})

test('rule 7: prepared at the base -> leftovers (recorded or current rules) or clean; a descendant -> delegate-commit; else unknown', () => {
  like(cloneVerdict(full(5), facts({ dirty: true })), { verdict: 'leftovers', generation: 5, base: BASE, rules: 'current', also: [PRE] })
  like(cloneVerdict(full(5, { rules: RULES }), facts({ indexDirty: true })), { verdict: 'leftovers', rules: 'recorded' })
  like(cloneVerdict(full(5), facts()), { verdict: 'clean', generation: 5 })
  like(cloneVerdict(full(5), facts({ tip: D })), { verdict: 'delegate-commit', base: BASE, tip: D, also: [D, PRE] })
  like(cloneVerdict(full(5), facts({ tip: CD, dirty: true })), { verdict: 'delegate-commit', base: BASE, tip: CD })
  like(cloneVerdict(full(5), facts({ tip: ORPHAN })), { verdict: 'unknown', why: 'tip' })
})

test('rule 8: preparing -> leftovers against the tip under the current rules, or clean', () => {
  const preparing = full(5, { phase: 'preparing', branch: null, head_ref: null, base: null, refs: {}, meta_sha: null })
  like(cloneVerdict(preparing, facts({ tip: ORPHAN, dirty: true })), { verdict: 'leftovers', base: ORPHAN, rules: 'current', also: [PRE] })
  like(cloneVerdict(preparing, facts({ tip: ORPHAN })), { verdict: 'clean' })
  // A preparing record that already names its branch still goes by the tip.
  like(cloneVerdict(full(5, { phase: 'preparing' }), facts({ tip: D, indexDirty: true })), { verdict: 'leftovers', base: D })
})

test('rule 9: clean -> clean, or leftovers against the base when dirty', () => {
  like(cloneVerdict(full(5, { phase: 'clean' }), facts()), { verdict: 'clean' })
  like(cloneVerdict(full(5, { phase: 'clean' }), facts({ dirty: true })), { verdict: 'leftovers', base: BASE })
  like(cloneVerdict(full(5, { phase: 'clean', base: null, branch: null, head_ref: null }), facts({ tip: OTHER, dirty: true })), { verdict: 'leftovers', base: OTHER })
})

test('also names every commit the record knows except the base the work is listed against (R20)', () => {
  const rec = full(6, {
    phase: 'committed', intent: { tree: OTHER, parent: BASE, commit: C }, commit: { sha: C }, delegate_commits: [D, O('8')],
    recovery: recovery({ step: 'rewound', base: BASE, rewind: { from: CD, to: BASE } }),
  })
  const v = cloneVerdict(rec, facts({ tip: BASE, dirty: true }))
  like(v, { verdict: 'leftovers', base: BASE, also: [CD, C, D, O('8'), PRE] })
  assert.equal(v.also[0], CD, 'the rewound tip comes first')
  assert.equal(new Set(v.also).size, v.also.length, 'no duplicates')
  // A record that knows nothing beyond its base adds nothing.
  like(cloneVerdict(full(6, { pre_head: null }), facts({ dirty: true })), { verdict: 'leftovers', also: [] })
  like(cloneVerdict(full(6, { pre_head: BASE }), facts({ dirty: true })), { verdict: 'leftovers', also: [] })
})

test('cloneVerdict is pure: it changes neither the record nor the facts', () => {
  const rec = deepFreeze(full(6, { recovery: recovery({ step: 'rewind-intent', rewind: { from: D, to: BASE } }) }))
  const f = deepFreeze(facts({ tip: D }))
  like(cloneVerdict(rec, f), { verdict: 'rewind' })
  const a = cloneVerdict(full(5), facts({ dirty: true })), b = cloneVerdict(full(5), facts({ dirty: true }))
  assert.deepEqual(a, b)
  a.also.push('x')
  assert.deepEqual(cloneVerdict(full(5), facts({ dirty: true })).also, [PRE])
})

test('a record written and read back through the module, judged against a real repository', t => {
  const { P, paths } = project(t)
  const branch = 'tl/2026-10-02'
  git(P, 'switch', '-q', '-c', branch)
  const base = git(P, 'rev-parse', 'HEAD')
  createRecord(paths, 2, { phase: 'preparing', pre_head: base })
  updateRecord(paths, 2, { phase: 'prepared', branch, head_ref: `refs/heads/${branch}`, base, refs: { [`refs/heads/${branch}`]: base } })
  fs.writeFileSync(path.join(P, 'f.txt'), 'delegate\n')
  git(P, 'add', 'f.txt')
  git(P, 'commit', '-q', '-m', 'delegate commit')
  const tip = git(P, 'rev-parse', 'HEAD')
  const orphan = git(P, 'commit-tree', git(P, 'rev-parse', 'HEAD^{tree}'), '-m', 'orphan')
  const realFacts = over => ({
    exists: true, valid: true, symbolic: true, headRef: git(P, 'symbolic-ref', 'HEAD'), tip, dirty: false, indexDirty: false,
    isAncestor: (a, b) => {
      try { git(P, 'merge-base', '--is-ancestor', a, b); return true } catch { return false }
    },
    ...over,
  })
  const [rec] = listRecords(paths)
  like(cloneVerdict(rec, realFacts()), { verdict: 'delegate-commit', generation: 2, base, tip, from: tip, to: base })
  like(cloneVerdict(rec, realFacts({ tip: orphan })), { verdict: 'unknown' })
  like(cloneVerdict(rec, realFacts({ tip: base, dirty: true })), { verdict: 'leftovers', base, rules: 'current' })
  // The refs snapshot vets nothing (R28); the base tip is vetted by containment, an adoption by its entry.
  assert.equal(vettedTip({ records: [rec], ledger: ledgerShas(paths.S), branch, tip: base, inBase: false }), false)
  assert.equal(vettedTip({ records: [rec], ledger: ledgerShas(paths.S), branch, tip: base, inBase: true }), true)
  assert.equal(vettedTip({ records: [rec], ledger: ledgerShas(paths.S), branch, tip, inBase: false }), false)
  updateRecord(paths, 2, { adopted: [{ ref: `refs/heads/${branch}`, tip }] })
  assert.equal(vettedTip({ records: listRecords(paths), ledger: ledgerShas(paths.S), branch, tip, inBase: false }), true)
  assert.equal(maxRecordGeneration(paths), 2)
})

// ---------------------------------------------------------------- review round

test('createRecord defaults adopted to []; the schema checks each adopted entry {ref, tip} (R28)', t => {
  const { paths } = project(t)
  const ADOPTED = [{ ref: 'refs/heads/tl/2026-09-30', tip: O('6') }]
  assert.equal(createRecord(paths, 5, { phase: 'preparing', pre_head: null, adopted: ADOPTED }), true)
  assert.deepEqual(readRecord(paths, 5).adopted, ADOPTED)
  assert.equal(createRecord(paths, 6, {}), true)
  assert.deepEqual(readRecord(paths, 6).adopted, [])
  const file = recordFile(paths, 7)
  const cases = [
    ['adopted not a list', { adopted: {} }],
    ['an adopted entry without its tip', { adopted: [{ ref: REF }] }],
    ['an adopted entry with an extra key', { adopted: [{ ref: REF, tip: C, why: 'adopt' }] }],
    ['an adopted ref that is no dated branch', { adopted: [{ ref: 'refs/heads/main', tip: C }] }],
    ['an adopted tip that is no object id', { adopted: [{ ref: REF, tip: 'main' }] }],
  ]
  for (const [label, over] of cases) {
    writeRaw(file, full(7, over))
    assert.throws(() => readRecord(paths, 7), err => err.code === 'CORRUPT', label)
    assert.throws(() => createRecord(paths, 8, { phase: 'preparing', ...over }), { code: 'BAD_RECORD' }, label)
  }
  // The field is part of the strict schema: a record without it does not read.
  const { adopted, ...older } = full(7)
  writeRaw(file, older)
  assert.throws(() => readRecord(paths, 7), err => err.code === 'CORRUPT' && /adopted/.test(err.message))
})

test('vettedTip: a refs snapshot never vets a tip; an adopted entry of the creating record does (R28)', t => {
  const ledger = ledgerShas(tmp(t))
  const planted = O('6'), OLDER = 'tl/2026-09-30'
  const v = (records, branch, tip = planted) => vettedTip({ records, ledger, branch, tip, inBase: false })
  // Step 6 snapshots every ref, a planted one included; the snapshot vets nothing, in any phase.
  for (const phase of ['preparing', 'prepared', 'clean']) {
    const snap = full(4, { phase, refs: { [REF]: planted, [`refs/heads/${OLDER}`]: planted } })
    assert.equal(v([snap], BR), false, `${phase}: the head_ref in the snapshot`)
    assert.equal(v([snap], OLDER), false, `${phase}: another branch in the snapshot`)
  }
  const creating = full(3, { phase: 'preparing', base: null, branch: null, head_ref: null, refs: {}, adopted: [{ ref: `refs/heads/${OLDER}`, tip: planted }] })
  assert.equal(v([creating], OLDER), true, 'adopted at creation')
  assert.equal(v([creating], `refs/heads/${OLDER}`), true, 'the branch as a full ref')
  assert.equal(v([creating], BR), false, 'adopted for another branch')
  assert.equal(v([creating], null), false, 'no branch, no adoption')
  assert.equal(v([creating], OLDER, O('7')), false, 'another tip of the adopted branch')
})

test('rules 3 and 4: a save or reset to resume with HEAD off its base reads unknown (tip), since reset refuses head-moved', () => {
  const saves = [{ sha: H('4'), why: 'pause' }]
  const saved = full(5, { phase: 'saved', saves })
  const resetting = full(5, { phase: 'resetting', saves, reset_sha: H('4') })
  for (const rec of [saved, resetting]) {
    for (const tip of [D, CD, ORPHAN]) like(cloneVerdict(rec, facts({ tip, dirty: true })), { verdict: 'unknown', why: 'tip' }, `${rec.phase} at ${tip}`)
    like(cloneVerdict(rec, facts({ tip: BASE, dirty: true })), { verdict: rec.phase === 'saved' ? 'resume' : 'resume-reset', base: BASE })
  }
  // An unfinished recovery resumes against its own base (here C: residue saved against the commit).
  const rSaved = full(6, { phase: 'committed', intent: { tree: OTHER, parent: BASE, commit: C }, commit: { sha: C }, recovery: recovery({ step: 'saved', base: C, bundles: [H('5')] }) })
  const rResetting = { ...rSaved, recovery: recovery({ step: 'resetting', base: C, bundles: [H('5')], reset_sha: H('5') }) }
  for (const rec of [rSaved, rResetting]) {
    for (const tip of [BASE, D, CD, ORPHAN]) like(cloneVerdict(rec, facts({ tip })), { verdict: 'unknown', why: 'tip' }, `${rec.recovery.step} at ${tip}`)
    like(cloneVerdict(rec, facts({ tip: C })), { verdict: rec.recovery.step === 'saved' ? 'resume' : 'resume-reset', base: C })
  }
  // A recovery without a base of its own is judged against the record's base.
  const noBase = full(6, { recovery: recovery({ step: 'saved', base: null, bundles: [H('5')] }) })
  like(cloneVerdict(noBase, facts({ tip: BASE })), { verdict: 'resume', base: BASE })
  like(cloneVerdict(noBase, facts({ tip: D })), { verdict: 'unknown', why: 'tip' })
})
