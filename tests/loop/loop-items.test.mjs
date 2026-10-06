// tests/loop/loop-items.test.mjs
// The read-only item CLI (stage 0c-3 brief section 4) against real temporary projects: a git
// repository <P> with its spine <S> = <P>/.tech-lead holding STATE.md, LOOP.md and LEDGER.jsonl.
// Every case runs scripts/loop-items.mjs as a child process and reads its one JSON line: the
// outputs and exit states of normalize, pick, followup, digest, check and trim; the printed edits,
// applied with loop-state.mjs's applyEdits, reproduce expect_sha256; check --expect and --item
// mismatches exit 3; every command refuses a carriage return; nothing is ever written.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ROOT } from '../helpers.mjs'
import { ID_RE, applyEdits, approvedDigest, itemDigest, parseState } from '../../scripts/lib/loop-state.mjs'
import { neutralLine } from '../../scripts/loop-text.mjs'
import {
  A, B, C, D, E, SEP, blockedItem, doneItem, entry, open, sha256, state,
} from '../lib/loop-state-fixture.mjs'

const SCRIPT = path.join(ROOT, 'scripts', 'loop-items.mjs')
// Keep the user's git config out of the fixture repositories; the CLI children inherit this.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })

const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

const loopMd = level => ['---', ...(level === null ? [] : [`level: ${level}`]), 'verify:', '  - npm test', '---', '# Loop', ''].join('\n')

// A project: a fresh git repository with <S>/STATE.md, <S>/LOOP.md (unless loop is null) and
// <S>/LEDGER.jsonl (unless ledger is null; rows are objects). Returns {P, S, cache, file}.
function project(t, { text = state(), level = 1, loop = loopMd(level), ledger = null } = {}) {
  const P = tmp(t, 'tl-items-')
  execFileSync('git', ['init', '-q', P])
  const S = path.join(P, '.tech-lead')
  fs.mkdirSync(S)
  fs.writeFileSync(path.join(S, 'STATE.md'), text)
  if (loop !== null) fs.writeFileSync(path.join(S, 'LOOP.md'), loop)
  if (ledger !== null) fs.writeFileSync(path.join(S, 'LEDGER.jsonl'), ledger.map(r => `${JSON.stringify(r)}\n`).join(''))
  const cache = tmp(t, 'tl-items-cache-')
  return { P, S, cache, file: path.join(S, 'STATE.md') }
}

// Runs the CLI; stdout must be exactly one JSON line. Returns {code, out}.
function run(fx, args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', cwd: cwd ?? fx?.P ?? os.tmpdir(), timeout: 60000,
    env: { ...process.env, ...(fx ? { TECH_LEAD_CACHE: fx.cache } : {}) },
  })
  assert.equal(r.error, undefined, String(r.error))
  const lines = r.stdout.split('\n')
  assert.equal(lines.length, 2, `one line, got ${JSON.stringify(r.stdout)} (stderr ${r.stderr})`)
  assert.equal(lines[1], '')
  return { code: r.status, out: JSON.parse(lines[0]) }
}

const read = fx => fs.readFileSync(fx.file, 'utf8')
const write = (fx, text) => fs.writeFileSync(fx.file, text)

// Every file under a directory with its bytes, for the never-writes assertions.
function snapshot(dir) {
  const out = {}
  const walk = d => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name)
      const st = fs.lstatSync(p)
      if (st.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}

// Applies a printed plan: the edits reproduce expect_sha256, and a second application fails.
function applyPlan(fx, out) {
  const before = read(fx)
  const after = applyEdits(before, out.edits)
  assert.equal(sha256(after), out.expect_sha256)
  if (out.edits.length) assert.throws(() => applyEdits(after, out.edits), /edit-anchor/)
  return after
}

const LEDGER_DONE = id => ({ iteration: 1, task: 'old', outcome: 'done', item_id: id, item_origin: 'human' })

// ---------------------------------------------------------------- usage and inputs

test('usage errors exit 2 with state error', t => {
  const fx = project(t)
  const sha = 'a'.repeat(64)
  for (const args of [
    [], ['frobnicate', fx.P], ['normalize'], ['normalize', fx.P, 'extra'], ['normalize', fx.P, '--expect', sha],
    ['pick', fx.P, '--level', '3'], ['followup', fx.P, '--parent', A], ['followup', fx.P, '--input', 'x.json'],
    ['followup', fx.P, '--parent', A, '--parent', A, '--input', 'x.json'], ['digest', fx.P], ['digest', fx.P, '--item'],
    ['check', fx.P, '--expect', 'abc'], ['check', fx.P, '--expect', sha, '--expect', sha],
    ['check', fx.P, '--item', `${A}@Now`], ['check', fx.P, '--item', `${A}@Elsewhere:${sha}`],
    ['check', fx.P, '--item', `not-an-id@Now:${sha}`], ['check', fx.P, '--item', `${A}@Now:${'g'.repeat(64)}`],
    ['check', fx.P, '--item', `${A}@Needs decision:${sha}`],
  ]) {
    const { code, out } = run(fx, args)
    assert.equal(code, 2, JSON.stringify(args))
    assert.equal(out.state, 'error', JSON.stringify(args))
    assert.match(out.detail, /usage/, JSON.stringify(args))
  }
})

test('a <P> that is not a repository, or a missing STATE.md, exits 2', t => {
  const plain = tmp(t, 'tl-items-plain-')
  const r1 = run(null, ['normalize', plain])
  assert.equal(r1.code, 2)
  assert.match(r1.out.detail, /^not-a-repo/)
  const fx = project(t)
  fs.rmSync(fx.file)
  const r2 = run(fx, ['check', fx.P])
  assert.equal(r2.code, 2)
  assert.equal(r2.out.state, 'error')
  assert.match(r2.out.detail, /^no-state: /)
})

test('every command exits 3 crlf on a STATE.md holding a carriage return', t => {
  const text = state({ backlog: open('ready', { id: A }) }).replace(/\n/g, '\r\n')
  const fx = project(t, { text, loop: null })
  const input = path.join(fx.S, 'in.json')
  fs.writeFileSync(input, 'not json')
  for (const args of [
    ['normalize', fx.P], ['pick', fx.P], ['followup', fx.P, '--parent', A, '--input', input],
    ['digest', fx.P, '--item', A], ['check', fx.P], ['check', fx.P, '--expect', sha256(text)], ['trim', fx.P],
  ]) {
    const { code, out } = run(fx, args)
    assert.equal(code, 3, JSON.stringify(args))
    assert.equal(out.state, 'crlf', JSON.stringify(args))
    assert.match(out.detail, /carriage return/)
  }
  // A lone carriage return counts too.
  write(fx, state({ backlog: open('ready', { id: A }) }).replace('## Done', '## Done\r'))
  assert.equal(run(fx, ['check', fx.P]).out.state, 'crlf')
})

test('a STATE.md that is not UTF-8 exits 2', t => {
  const fx = project(t)
  fs.writeFileSync(fx.file, Buffer.concat([Buffer.from(state()), Buffer.from([0xff, 0xfe, 0x0a])]))
  const { code, out } = run(fx, ['check', fx.P])
  assert.equal(code, 2)
  assert.match(out.detail, /^bad-encoding: /)
})

test('no command writes anything: the spine, the cache and the repository stay as they were', t => {
  const text = state({
    now: [], backlog: [...open('first', { origin: null }), ...open('second', { id: B })],
    done: doneItem('old', { id: D }),
  })
  const fx = project(t, { text, ledger: [LEDGER_DONE(E)] })
  const input = path.join(fx.S, 'briefs', `${D}-followup.json`)
  fs.mkdirSync(path.dirname(input))
  fs.writeFileSync(input, JSON.stringify({ title: 'next step', notes: 'n' }))
  const spine = snapshot(fx.S), repo = snapshot(path.join(fx.P, '.git'))
  for (const args of [
    ['normalize', fx.P], ['pick', fx.P], ['followup', fx.P, '--parent', D, '--input', input],
    ['digest', fx.P, '--item', B], ['check', fx.P, '--expect', sha256(text), '--item', `${B}@Backlog:${'0'.repeat(64)}`],
    ['trim', fx.P],
  ]) run(fx, args)
  assert.deepEqual(snapshot(fx.S), spine)
  assert.deepEqual(snapshot(path.join(fx.P, '.git')), repo)
  assert.deepEqual(fs.readdirSync(fx.cache), [])
})

// ---------------------------------------------------------------- normalize

test('normalize mints ids and origins in every section, reports problems, and the edits replay to expect_sha256', t => {
  const text = state({
    now: open('in flight', { origin: null }),
    backlog: [
      ...open('first', { origin: null }), ...open('second', { id: B }), ...open('third', { id: 'TL-CCCCCCCC' }),
      ...open('waits on a title', { id: A, blockedBy: 'second' }),
    ],
    blocked: blockedItem('stuck', { origin: null }),
    done: doneItem('old', { id: D, origin: null }),
  })
  const fx = project(t, { text, ledger: [LEDGER_DONE(E)] })
  const { code, out } = run(fx, ['normalize', fx.P])
  assert.equal(code, 0, JSON.stringify(out))
  assert.equal(out.state, 'ok')
  assert.equal(out.minted.length, 3)
  for (const id of out.minted) {
    assert.match(id, ID_RE)
    assert.ok(![A, B, C, D, E].includes(id), id)
  }
  assert.deepEqual(new Set(out.origins), new Set([...out.minted, D]))
  assert.ok(out.problems.some(p => p.kind === 'title-blocker' && p.id === A && p.candidate === B), JSON.stringify(out.problems))
  const after = applyPlan(fx, out)
  assert.match(after, /\n {2}- id: tl-cccccccc\n/)
  const st = parseState(after)
  for (const it of st.items) {
    assert.match(it.id, ID_RE)
    assert.ok(it.origin, it.title)
  }
  assert.equal(st.items.find(i => i.title === 'old').origin, 'unknown')
  // The applied file normalizes to nothing: idempotent.
  write(fx, after)
  const again = run(fx, ['normalize', fx.P])
  assert.equal(again.code, 0)
  assert.deepEqual(again.out.edits, [])
  assert.deepEqual(again.out.minted, [])
  assert.equal(again.out.expect_sha256, sha256(after))
})

test('normalize refuses a STATE.md it cannot plan against with exit 2, never a partial plan', t => {
  // An insertion after the last line of a file with no final newline has no anchor (R14).
  const text = state({ done: doneItem('old', { origin: null }) }).replace(/\n## Last run\n\(never run\)\n$/, '').replace(/\n+$/, '')
  const fx = project(t, { text })
  const { code, out } = run(fx, ['normalize', fx.P])
  assert.equal(code, 2)
  assert.deepEqual(Object.keys(out).sort(), ['detail', 'state'])
  assert.equal(out.state, 'error')
  assert.match(out.detail, /^edit-anchor: /)
})

// ---------------------------------------------------------------- pick

test('pick moves the first eligible Backlog item to ## Now and lists the skipped ones', t => {
  const text = state({
    backlog: [...open('waits on B', { id: A, blockedBy: B }), ...open('ready', { id: C, notes: 'do it' })],
    blocked: blockedItem('the blocker', { id: B }),
  })
  const fx = project(t, { text })
  const { code, out } = run(fx, ['pick', fx.P])
  assert.equal(code, 0, JSON.stringify(out))
  assert.equal(out.state, 'picked')
  assert.equal(out.id, C)
  assert.equal(out.title, 'ready')
  assert.equal(out.from, 'backlog')
  assert.deepEqual(out.released, [])
  assert.deepEqual(out.skipped.map(s => [s.id, s.reason]), [[A, 'blocked']])
  const after = applyPlan(fx, out)
  const now = parseState(after).items.filter(i => i.section === 'Now')
  assert.equal(now.length, 1)
  assert.equal(now[0].id, C)
  assert.equal(out.digest, itemDigest(now[0]))
  assert.equal(parseState(after).items.filter(i => i.id === C).length, 1)
  // The prose's next steps: check --expect and check --item on the applied file.
  write(fx, after)
  assert.equal(run(fx, ['check', fx.P, '--expect', out.expect_sha256]).code, 0)
  assert.equal(run(fx, ['check', fx.P, '--item', `${C}@Now:${out.digest}`]).code, 0)
})

test('pick reads LEDGER.jsonl: a blocker the ledger records done is finished', t => {
  const text = state({ backlog: open('waits on E', { id: A, blockedBy: E }) })
  const without = project(t, { text })
  const r1 = run(without, ['pick', without.P])
  assert.equal(r1.code, 0)
  assert.equal(r1.out.state, 'dry')
  assert.deepEqual(r1.out.skipped.map(s => [s.id, s.reason]), [[A, 'unknown-blocker']])
  assert.equal(r1.out.expect_sha256, sha256(text))
  const withLedger = project(t, { text, ledger: [LEDGER_DONE(E)] })
  const r2 = run(withLedger, ['pick', withLedger.P])
  assert.equal(r2.out.state, 'picked')
  assert.equal(r2.out.id, A)
})

// R27: pick (picked or dry) passes through planPick's `unledgered`, the ## Done entries whose id
// the ledger does not record done, with their origins, for the firing's ledger row's done_items.
test('pick prints unledgered: the ## Done entries the ledger does not record done, picked or dry', t => {
  const done = [...doneItem('analysis without a row', { id: B, sha: null, origin: `loop from ${C}` }), ...doneItem('recorded', { id: D })]
  for (const backlog of [open('ready', { id: A }), []]) {
    const fx = project(t, { text: state({ backlog, done }), ledger: [LEDGER_DONE(D)] })
    const { code, out } = run(fx, ['pick', fx.P])
    assert.equal(code, 0, JSON.stringify(out))
    assert.equal(out.state, backlog.length ? 'picked' : 'dry')
    assert.deepEqual(out.unledgered, [{ item_id: B, item_origin: `loop from ${C}` }], out.state)
  }
  // A refusal (exit 3) carries it too: the halted firing's row still records the entries.
  const busy = project(t, { text: state({ now: open('busy', { id: E }), done }), ledger: [LEDGER_DONE(D)] })
  const { code, out } = run(busy, ['pick', busy.P])
  assert.deepEqual([code, out.state], [3, 'now-occupied'])
  assert.deepEqual(out.unledgered, [{ item_id: B, item_origin: `loop from ${C}` }])
})

test('pick reads level from LOOP.md: a waiting-level hard item waits for level 3', t => {
  const text = state({ backlog: open('parked', { id: A, cls: 'hard', status: 'waiting-level' }) })
  for (const [level, want] of [[1, 'dry'], [2, 'dry'], [3, 'picked'], ["'3'", 'picked'], [null, 'dry']]) {
    const fx = project(t, { text, level })
    const { code, out } = run(fx, ['pick', fx.P])
    assert.equal(code, 0, `level ${level}: ${JSON.stringify(out)}`)
    assert.equal(out.state, want, `level ${level}`)
    if (want === 'dry') assert.deepEqual(out.skipped.map(s => s.reason), ['status'])
    else assert.match(applyPlan(fx, out), /## Now\n- \[ \] parked/)
  }
})

test('pick refuses a LOOP.md it cannot read a level from with exit 2', t => {
  const text = state({ backlog: open('ready', { id: A }) })
  const cases = [
    [null, /^no-loop-md: /], ['# no front matter\n', /^bad-loop-md: /], [loopMd('three'), /^bad-level: /],
    [loopMd('4'), /^bad-level: /], [['---', 'level: 1', 'level: 2', '---', ''].join('\n'), /^bad-level: /],
  ]
  for (const [loop, re] of cases) {
    const fx = project(t, { text, loop })
    const { code, out } = run(fx, ['pick', fx.P])
    assert.equal(code, 2, String(loop))
    assert.equal(out.state, 'error')
    assert.match(out.detail, re)
  }
  // Only pick reads LOOP.md.
  const fx = project(t, { text, loop: null })
  assert.equal(run(fx, ['normalize', fx.P]).code, 0)
  assert.equal(run(fx, ['check', fx.P]).code, 0)
})

test('pick releases a filled decision first and picks the released item', t => {
  const text = state({
    backlog: [...open('other work', { id: B }), ...open('decide it', { id: A, status: 'waiting-decision' })],
    decisions: entry(`${A}${SEP}decide it`, { decision: 'use redis' }),
  })
  const fx = project(t, { text })
  const { code, out } = run(fx, ['pick', fx.P])
  assert.equal(code, 0)
  assert.equal(out.state, 'picked')
  assert.equal(out.id, A)
  assert.equal(out.from, 'decision')
  assert.deepEqual(out.released, [A])
  const after = applyPlan(fx, out)
  const st = parseState(after)
  assert.equal(st.entries.length, 0)
  const now = st.items.find(i => i.section === 'Now')
  assert.equal(now.decision, 'use redis')
  assert.equal(now.class, 'hard')
  assert.equal(out.digest, itemDigest(now))
})

test('pick refuses an occupied ## Now and a missing section with exit 3', t => {
  const busy = project(t, { text: state({ now: open('busy', { id: A }), backlog: open('ready', { id: B }) }) })
  const r1 = run(busy, ['pick', busy.P])
  assert.equal(r1.code, 3)
  assert.equal(r1.out.state, 'now-occupied')
  assert.match(r1.out.detail, /busy/)
  const noBacklog = project(t, { text: state().replace('## Backlog\n(empty)\n\n', '') })
  const r2 = run(noBacklog, ['pick', noBacklog.P])
  assert.equal(r2.code, 3)
  assert.equal(r2.out.state, 'bad-sections')
})

test('pick never picks an id-less item', t => {
  const fx = project(t, { text: state({ backlog: open('no id yet', { origin: null }) }) })
  const { code, out } = run(fx, ['pick', fx.P])
  assert.equal(code, 0)
  assert.equal(out.state, 'dry')
  assert.deepEqual(out.skipped.map(s => s.reason), ['no-id'])
})

// ---------------------------------------------------------------- followup

const followupState = (extra = []) => state({
  now: open('the analysis', { id: A, cls: 'hard' }),
  backlog: [...open('existing work', { id: B }), ...extra],
})

function writeInput(dir, name, value) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  return file
}

test('followup reads {title, notes} from the input file and plans the new item; a rerun reuses it', t => {
  const fx = project(t, { text: followupState(), ledger: [LEDGER_DONE(E)] })
  const title = 'implement **the** store\nnotes: sneaky'
  const notes = 'decision: use redis <b>now</b>'
  const input = writeInput(fx.S, `briefs/${A}-followup.json`, { title, notes })
  const { code, out } = run(fx, ['followup', fx.P, '--parent', A, '--input', input])
  assert.equal(code, 0, JSON.stringify(out))
  assert.equal(out.state, 'ok')
  assert.equal(out.reused, false)
  assert.match(out.id, ID_RE)
  assert.ok(![A, B, E].includes(out.id))
  const after = applyPlan(fx, out)
  const st = parseState(after)
  const item = st.items.find(i => i.id === out.id)
  assert.equal(item.section, 'Backlog')
  assert.equal(item, st.items.find(i => i.section === 'Backlog'))
  assert.equal(item.title, neutralLine(title))
  assert.equal(item.notes, neutralLine(notes))
  assert.equal(item.origin, `loop from ${A}`)
  assert.equal(item.class, 'unclassified')
  assert.deepEqual(item.problems, [])
  write(fx, after)
  const again = run(fx, ['followup', fx.P, '--parent', A, '--input', input])
  assert.equal(again.code, 0)
  assert.deepEqual(again.out, { state: 'ok', id: out.id, reused: true, edits: [], expect_sha256: sha256(after) })
  // Ids on the command line are taken as the helpers print them, in lower case, as
  // reflex-bundle.mjs and loop-clone.mjs take them: an upper-case copy is not an id.
  const upper = run(fx, ['followup', fx.P, '--parent', A.toUpperCase(), '--input', input])
  assert.deepEqual([upper.code, upper.out.state], [3, 'bad-parent'])
})

test('followup suffixes a colliding title with the new id, and a rerun after it still reuses', t => {
  const fx = project(t, { text: followupState() })
  const input = writeInput(fx.S, `briefs/${A}-followup.json`, { title: 'Existing  work', notes: '' })
  const { out } = run(fx, ['followup', fx.P, '--parent', A, '--input', input])
  const after = applyPlan(fx, out)
  assert.equal(parseState(after).items.find(i => i.id === out.id).title, `Existing work (${out.id})`)
  write(fx, after)
  const again = run(fx, ['followup', fx.P, '--parent', A, '--input', input])
  assert.equal(again.out.reused, true)
  assert.equal(again.out.id, out.id)
})

test('followup takes the input file path as given: spaces and quotes, relative to the working directory, notes optional', t => {
  const fx = project(t, { text: followupState() })
  const odd = writeInput(fx.S, `briefs/with space's "q" $HOME/${A}-followup.json`, { title: 'odd path' })
  const r1 = run(fx, ['followup', fx.P, '--parent', A, '--input', odd])
  assert.equal(r1.code, 0, JSON.stringify(r1.out))
  assert.equal(parseState(applyPlan(fx, r1.out)).items.find(i => i.id === r1.out.id).title, 'odd path')
  writeInput(fx.S, 'briefs/rel.json', { title: 'relative path', notes: null })
  const r2 = run(fx, ['followup', fx.P, '--parent', A, '--input', 'briefs/rel.json'], { cwd: fx.S })
  assert.equal(r2.code, 0, JSON.stringify(r2.out))
  assert.equal(parseState(applyPlan(fx, r2.out)).items.find(i => i.id === r2.out.id).title, 'relative path')
})

test('followup refuses a bad parent and a bad input with exit 3, and an unreadable input with exit 2', t => {
  const fx = project(t, { text: followupState([...open('twin', { id: C }), ...open('twin copy', { id: C })]) })
  const good = writeInput(fx.S, 'briefs/good.json', { title: 'fine' })
  for (const parent of ['tl-zzzzzzzz', 'not an id', C]) {
    const { code, out } = run(fx, ['followup', fx.P, '--parent', parent, '--input', good])
    assert.equal(code, 3, parent)
    assert.equal(out.state, 'bad-parent', parent)
  }
  const bad = [
    'not json', '[1, 2]', 'null', '"a title"', JSON.stringify({ notes: 'no title' }), JSON.stringify({ title: 5 }),
    JSON.stringify({ title: 'x', notes: 3 }), JSON.stringify({ title: 'x', extra: 1 }), JSON.stringify({ title: '   ' }),
    Buffer.from([0x7b, 0x22, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  ]
  bad.forEach((content, k) => {
    const file = writeInput(fx.S, `briefs/bad-${k}.json`, content)
    const { code, out } = run(fx, ['followup', fx.P, '--parent', A, '--input', file])
    assert.equal(code, 3, `case ${k}: ${JSON.stringify(out)}`)
    assert.equal(out.state, 'bad-input', `case ${k}`)
    assert.equal(typeof out.detail, 'string')
  })
  for (const file of [path.join(fx.S, 'briefs', 'missing.json'), path.join(fx.S, 'briefs')]) {
    const { code, out } = run(fx, ['followup', fx.P, '--parent', A, '--input', file])
    assert.equal(code, 2, file)
    assert.equal(out.state, 'error')
    assert.match(out.detail, /^input: /)
  }
})

// ---------------------------------------------------------------- digest

test('digest prints the item and approved digests of the one item carrying the id', t => {
  const text = state({
    backlog: open('decided work', { id: A, notes: 'the notes', decision: 'use redis' }),
    done: [...doneItem('done once', { id: B }), ...doneItem('done twice', { id: B })],
  })
  const fx = project(t, { text })
  const it = parseState(text).items.find(i => i.id === A)
  const { code, out } = run(fx, ['digest', fx.P, '--item', A])
  assert.equal(code, 0)
  assert.deepEqual(out, { state: 'ok', id: A, item_digest: itemDigest(it), approved_digest: approvedDigest(it) })
  for (const [arg, re] of [[C, /no item carries/], ['nonsense', /not an id/], [A.toUpperCase(), /not an id/], [B, /carried 2 times/]]) {
    const { code, out } = run(fx, ['digest', fx.P, '--item', arg])
    assert.equal(code, 3, arg)
    assert.equal(out.state, 'no-item', arg)
    assert.match(out.detail, re)
  }
})

// R28: a block that holds the id on an id-like line but does not parse to it (two id: lines, a
// doubled id) is a raw carrier; digest refuses an id more than one block carries, raw included
// (Codex g2#2 two ids, g1#1 doubled id).
test('digest refuses an id that a raw carrier also holds (two id lines, a doubled id)', t => {
  for (const [label, extra] of [
    ['two ids', [`  - id: ${B}`]],
    ['a doubled id', [`  - id: ${A}`]],
  ]) {
    const text = state({
      backlog: open('reopened', { id: A, extra }),
      done: doneItem('finished once', { id: A }),
    })
    assert.equal(parseState(text).items.filter(i => i.id === A).length, 1, `${label}: the open copy does not parse to ${A}`)
    const fx = project(t, { text })
    const { code, out } = run(fx, ['digest', fx.P, '--item', A])
    assert.equal(code, 3, `${label}: ${JSON.stringify(out)}`)
    assert.equal(out.state, 'no-item', label)
    assert.match(out.detail, /carried [23] times/, label)
    assert.match(out.detail, /Backlog line \d+ \(an id line that does not parse to it\)/, label)
  }
})

// Fix round 2 (Codex fix1-g1#3): a raw carrier alone is no item to digest: an unparsed reopened
// block (a Done header kept in ## Backlog) or a capitalized `ID:` line exits 3 no-item, naming
// the raw line, instead of crashing on its missing item.
test('digest refuses an id whose only carrier is raw (an unparsed block, a capitalized ID: line)', t => {
  for (const [label, backlog] of [
    ['an unparsed reopened block', doneItem('finished once', { id: A })],
    ['a capitalized ID: line', open('reopened', { extra: [`  - ID: ${A}`] })],
  ]) {
    const text = state({ backlog })
    assert.equal(parseState(text).items.some(i => i.id === A), false, `${label}: no item parses to ${A}`)
    const fx = project(t, { text })
    const { code, out } = run(fx, ['digest', fx.P, '--item', A])
    assert.equal(code, 3, `${label}: ${JSON.stringify(out)}`)
    assert.equal(out.state, 'no-item', label)
    assert.match(out.detail, /Backlog line \d+ \(an id line that does not parse to it\)/, label)
  }
})

// ---------------------------------------------------------------- trim

// n ## Done entries, newest first; the k-th (k < 32) has the id tl-0000000<k-th base32 digit>
// and a notes continuation line, so a dropped entry must go as a whole block.
const idOf = k => `tl-0000000${'0123456789abcdefghjkmnpqrstvwxyz'[k]}`
const doneEntries = n => Array.from({ length: n }, (_, k) => doneItem(`done ${k}`, { id: idOf(k), notes: `first of ${k}`, extra: ['      second line'] })).flat()
const doneIdsOf = text => parseState(text).items.filter(i => i.section === 'Done').map(i => i.id)
const ids = (from, to) => Array.from({ length: to - from }, (_, k) => idOf(from + k))

test('trim prints the ## Done trim: the 20 newest kept, the ledgered rest dropped as whole blocks; the edits replay to expect_sha256', t => {
  const fx = project(t, { text: state({ backlog: open('open', { id: A }), done: doneEntries(23) }), ledger: ids(0, 23).map(LEDGER_DONE) })
  const { code, out } = run(fx, ['trim', fx.P])
  assert.equal(code, 0, JSON.stringify(out))
  assert.deepEqual(Object.keys(out).sort(), ['dropped', 'edits', 'expect_sha256', 'state', 'unledgered'])
  assert.equal(out.state, 'ok')
  assert.deepEqual(out.dropped, ids(20, 23))
  assert.deepEqual(out.unledgered, [])
  const after = applyPlan(fx, out)
  assert.deepEqual(doneIdsOf(after), ids(0, 20))
  assert.ok(!after.includes('first of 20') && !after.includes('done 22'))
  assert.equal(after.split('\n').filter(l => l === '      second line').length, 20)
  write(fx, after)
  assert.deepEqual(run(fx, ['check', fx.P, '--expect', out.expect_sha256]), { code: 0, out: { state: 'ok', problems: [] } })
  // A second trim has nothing left to do.
  assert.deepEqual(run(fx, ['trim', fx.P]).out.edits, [])
})

test('trim keeps an unledgered ## Done entry below the 20 newest, and prints it in unledgered', t => {
  const done = doneEntries(23)
  const fx = project(t, { text: state({ done }), ledger: ids(0, 23).filter(id => id !== idOf(21)).map(LEDGER_DONE) })
  const { code, out } = run(fx, ['trim', fx.P])
  assert.equal(code, 0, JSON.stringify(out))
  assert.deepEqual(out.dropped, [idOf(20), idOf(22)])
  assert.deepEqual(out.unledgered, [{ item_id: idOf(21), item_origin: 'human' }])
  const after = applyPlan(fx, out)
  assert.deepEqual(doneIdsOf(after), [...ids(0, 20), idOf(21)])
  assert.ok(after.includes('- [x] done 21') && after.includes('first of 21'))
})

test('trim prints an empty edit list when nothing can go', t => {
  for (const [label, done, ledger] of [
    ['20 entries, all ledgered', doneEntries(20), ids(0, 20).map(LEDGER_DONE)],
    ['23 entries, no ledger', doneEntries(23), null],
    ['23 entries, the three oldest unledgered', doneEntries(23), ids(0, 20).map(LEDGER_DONE)],
    ['an empty ## Done', [], null],
  ]) {
    const fx = project(t, { text: state({ done }), ledger })
    const before = read(fx)
    const { code, out } = run(fx, ['trim', fx.P])
    assert.equal(code, 0, `${label}: ${JSON.stringify(out)}`)
    assert.equal(out.state, 'ok', label)
    assert.deepEqual([out.edits, out.dropped], [[], []], label)
    assert.equal(out.expect_sha256, sha256(before), label)
    assert.equal(run(fx, ['check', fx.P, '--expect', out.expect_sha256]).code, 0, label)
  }
})

test('trim refuses a STATE.md without one ## Done with exit 3 bad-sections, and takes no flag', t => {
  for (const text of [state().replace('## Done', '## Finished'), `${state()}\n## Done\n(empty)\n`]) {
    const fx = project(t, { text })
    const { code, out } = run(fx, ['trim', fx.P])
    assert.deepEqual([code, out.state], [3, 'bad-sections'], JSON.stringify(out))
  }
  const fx = project(t)
  for (const args of [['trim'], ['trim', fx.P, fx.P], ['trim', fx.P, '--expect', 'a'.repeat(64)], ['trim', fx.P, '--max', '5']]) {
    const { code, out } = run(fx, args)
    assert.deepEqual([code, out.state], [2, 'error'], JSON.stringify(args))
  }
})

// ---------------------------------------------------------------- check

test('check reports the problems a person made and exits 0', t => {
  const text = state({ backlog: [...open('same', { id: A }), ...open('Same', { id: B })] })
  const fx = project(t, { text })
  const { code, out } = run(fx, ['check', fx.P])
  assert.equal(code, 0)
  assert.equal(out.state, 'ok')
  assert.deepEqual(out.problems.filter(p => p.kind === 'duplicate-title').map(p => p.id).sort(), [A, B])
})

test('check --expect compares the file SHA-256; a mismatch exits 3 with both hashes', t => {
  const text = state({ backlog: open('ready', { id: A }) })
  const fx = project(t, { text })
  assert.deepEqual(run(fx, ['check', fx.P, '--expect', sha256(text)]), { code: 0, out: { state: 'ok', problems: [] } })
  // A digest on the command line is lower-case hex, as the helpers print it.
  assert.deepEqual([run(fx, ['check', fx.P, '--expect', sha256(text).toUpperCase()]).code, run(fx, ['check', fx.P, '--expect', sha256(text).toUpperCase()]).out.state], [2, 'error'])
  const wrong = 'f'.repeat(64)
  const { code, out } = run(fx, ['check', fx.P, '--expect', wrong])
  assert.equal(code, 3)
  assert.equal(out.state, 'mismatch')
  assert.deepEqual(out.mismatches, [{ kind: 'expect', expected: wrong, actual: sha256(text) }])
  assert.match(out.detail, new RegExp(wrong))
  assert.deepEqual(out.problems, [])
})

test('check --item confirms the item sits in that section, once, with that digest; anything else exits 3', t => {
  const text = state({
    backlog: open('ready', { id: A, notes: 'n' }),
    done: doneItem('finished', { id: B }),
  })
  const fx = project(t, { text })
  const st = parseState(text)
  const dA = itemDigest(st.items.find(i => i.id === A)), dB = itemDigest(st.items.find(i => i.id === B))
  assert.equal(run(fx, ['check', fx.P, '--item', `${A}@Backlog:${dA}`]).code, 0)
  assert.equal(run(fx, ['check', fx.P, '--item', `${B}@Done:${dB}`]).code, 0)
  for (const spec of [`${B.toUpperCase()}@Done:${dB}`, `${B}@Done:${dB.toUpperCase()}`]) assert.equal(run(fx, ['check', fx.P, '--item', spec]).code, 2, spec)
  const cases = [
    [`${A}@Backlog:${dB}`, [{ section: 'Backlog', digest: dA }]],
    [`${A}@Now:${dA}`, [{ section: 'Backlog', digest: dA }]],
    [`${C}@Backlog:${dA}`, []],
  ]
  for (const [spec, found] of cases) {
    const { code, out } = run(fx, ['check', fx.P, '--item', spec])
    assert.equal(code, 3, spec)
    assert.equal(out.state, 'mismatch', spec)
    assert.equal(out.mismatches.length, 1)
    const m = out.mismatches[0]
    assert.equal(m.kind, 'item')
    assert.deepEqual(m.found.map(f => ({ section: f.section, digest: f.digest })), found, spec)
    assert.equal(typeof out.detail, 'string')
  }
})

test('check --item fails while an interrupted move leaves two copies', t => {
  const block = open('moving', { id: A })
  const text = state({ now: block, backlog: block })
  const fx = project(t, { text })
  const d = itemDigest(parseState(text).items[0])
  for (const section of ['Now', 'Backlog']) {
    const { code, out } = run(fx, ['check', fx.P, '--item', `${A}@${section}:${d}`])
    assert.equal(code, 3)
    assert.deepEqual(out.mismatches[0].found.map(f => f.section), ['Now', 'Backlog'])
  }
})

test('check --item fails when a raw carrier also holds the id (R28): the Done copy is not the only carrier', t => {
  for (const [label, extra] of [['two ids', [`  - id: ${B}`]], ['a doubled id', [`  - id: ${A}`]]]) {
    const text = state({
      backlog: open('reopened', { id: A, extra }),
      done: doneItem('finished once', { id: A }),
    })
    const fx = project(t, { text })
    const d = itemDigest(parseState(text).items.find(i => i.id === A))
    const { code, out } = run(fx, ['check', fx.P, '--item', `${A}@Done:${d}`])
    assert.equal(code, 3, `${label}: ${JSON.stringify(out)}`)
    assert.equal(out.state, 'mismatch', label)
    // Each id line that does not parse to the id is a raw carrier (a doubled id has two).
    const found = out.mismatches[0].found
    assert.ok(found.some(f => f.section === 'Backlog' && f.raw === true && f.digest === null), `${label}: ${JSON.stringify(found)}`)
    assert.deepEqual(found.filter(f => !f.raw).map(f => [f.section, f.digest]), [['Done', d]], label)
  }
})

test('check with both flags reports every mismatch, and exits 0 only when both hold', t => {
  const text = state({ backlog: open('ready', { id: A }) })
  const fx = project(t, { text })
  const d = itemDigest(parseState(text).items[0])
  assert.equal(run(fx, ['check', fx.P, '--expect', sha256(text), '--item', `${A}@Backlog:${d}`]).code, 0)
  const one = run(fx, ['check', fx.P, '--expect', sha256(text), '--item', `${A}@Done:${d}`])
  assert.equal(one.code, 3)
  assert.deepEqual(one.out.mismatches.map(m => m.kind), ['item'])
  const both = run(fx, ['check', fx.P, '--item', `${A}@Done:${d}`, '--expect', '0'.repeat(64)])
  assert.deepEqual(both.out.mismatches.map(m => m.kind), ['expect', 'item'])
})

// ---------------------------------------------------------------- the firing, as the prose runs it

test('a firing through the CLI: normalize, pick, followup, each applied and checked', t => {
  const text = state({
    backlog: [...open('analyse the store', { origin: null, cls: 'hard' }), ...open('later', { origin: null })],
  })
  const fx = project(t, { text, level: 3 })
  const norm = run(fx, ['normalize', fx.P]).out
  write(fx, applyPlan(fx, norm))
  assert.equal(run(fx, ['check', fx.P, '--expect', norm.expect_sha256]).code, 0)
  const pick = run(fx, ['pick', fx.P]).out
  assert.equal(pick.state, 'picked')
  assert.equal(pick.id, norm.minted[0])
  write(fx, applyPlan(fx, pick))
  assert.equal(run(fx, ['check', fx.P, '--expect', pick.expect_sha256]).code, 0)
  assert.equal(run(fx, ['check', fx.P, '--item', `${pick.id}@Now:${pick.digest}`]).code, 0)
  const input = writeInput(fx.S, `briefs/${pick.id}-followup.json`, { title: 'implement the store', notes: 'per the analysis' })
  const fu = run(fx, ['followup', fx.P, '--parent', pick.id, '--input', input]).out
  write(fx, applyPlan(fx, fu))
  assert.equal(run(fx, ['check', fx.P, '--expect', fu.expect_sha256]).code, 0)
  const digest = run(fx, ['digest', fx.P, '--item', fu.id]).out
  assert.equal(run(fx, ['check', fx.P, '--item', `${fu.id}@Backlog:${digest.item_digest}`]).code, 0)
  // A pick now refuses: the analysis still sits in ## Now.
  assert.equal(run(fx, ['pick', fx.P]).out.state, 'now-occupied')
})
