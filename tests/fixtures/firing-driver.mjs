#!/usr/bin/env node
// tests/fixtures/firing-driver.mjs
// A stand-in for one loop firing. It is its own holder (TECH_LEAD_HOLDER_PID is its pid),
// drives the helpers through their CLIs as the loop's prose does, prints one JSON event line
// per step, and stops at a boundary. Two modes.
//
// 1. The 0c-1 lock firing (tests/loop/loop-interrupt.test.mjs):
//   node firing-driver.mjs <P> <W> <stop>
//     acquired  after acquire                        {"event":"acquired",...acquire output}
//     stray     after acquire, with a process left running in <W> that no record names
//               (as a delegate's command would be), in a session of its own
//                                                    {"event":"stray","pid":<pid>}
//     exec      while exec runs LOOP.md verify[0]    {"event":"exec","wrapper":<pid>,"pgid":<pgid>}
//     ledger    after exec --verify 1 and the ledger append, before release
//                                                    {"event":"ledger","generation":N}
//     none      runs to its release and exits 0      {"event":"released","generation":N}
//   At every boundary but none it then waits to be killed. The exec wrapper is started in the
//   driver's own process group, so killing that group kills the firing and the wrapper but
//   not the exec child, which leads a group of its own.
//
// 2. The 0c-2 firing with the clone (tests/loop/loop-interrupt-clone-*.test.mjs; brief
//    section 19), with stage 0c-3's items (brief R13, R14, R17, R18, R20, R21):
//   node firing-driver.mjs firing <scenario.json>
//   It plays the prose in the section 19 order, deterministically. STATE.md is changed only as
//   the main session changes it (tests/fixtures/firing-moves.mjs): one Edit at a time, items
//   found by id; a plan of loop-items.mjs (normalize, pick, followup) applied edit by edit and
//   confirmed with `loop-items check --expect`; every move of an item inserts its whole block
//   at the destination first, deletes the source second, and is confirmed with `loop-items
//   check --item <id>@<section>:<digest>` (the digest pick printed for this firing's item,
//   finish.item_digest for finish-commit, `loop-items digest` read before the move for any
//   other item: loop "Item edits", step 1). An edit that does not apply, or a check that does
//   not match, is R14's incident: {"event":"incident"}, ## Last run, `paused: true`, outcome
//   halted, ## Now left as it stands.
//     section 1   acquire; loop-recover.mjs <P> --generation <N> [--reclaimed <g>] and its
//                 actions (clear-now: the planner's clear.edits, the anchored deletion of the
//                 one ## Now block, applied and checked with check --expect, noted "cleared
//                 interrupted move of <id>", the other copy's digest read and checked;
//                 now-conflict: the item-edit incident, every copy kept (R29);
//                 finish-commit: ## Now to ## Done with finish.sha; requeue-now: ## Now back to
//                 the top of ## Backlog; loop-clone.mjs bundle per write-bundle; `recovered`
//                 carried to the ledger row with `action` the ## Now action taken:
//                 finish-commit, requeue-now or null, null after clear-now too, as loop section
//                 1 step 5 and loop-templates.md's schema say); planner exit 2 puts a ## Now item back at
//                 the top of ## Backlog and halts the firing (incident, paused, outcome skipped)
//     section 2   gate 1 only: LOOP.md's `paused: true` -> {"event":"gated","gate":"paused"},
//                 outcome halted, note "paused", nothing picked, prepared or dispatched
//     sections 3-4  loop-items normalize, then loop-items pick (its releases included), each
//                 applied and checked; normalize's minted ids and problems, pick's released ids
//                 and skipped items go to ## Last run ("minted <ids>", "problem <kind> line <n>:
//                 <detail>", "released <id>", "skipped <id> <title>: <reason> (<detail>)"); dry
//                 -> "backlog dry", outcome skipped; an exit 2 or 3 from normalize, pick or a
//                 move's digest read is the item-edit incident (loop "Item edits"); pick's
//                 `unledgered` (a refusal's too) becomes the row's done_items (R27)
//     section 5   path 'analysis' (L3 analysis-shaped): the read-only delegate between dispatch
//                 open and close, no clone; with scenario.followup the follow-up (below), else
//                 note "analysis -> no follow-up"; the item to ## Done with the dash; outcome
//                 done, commits []
//     section 5   loop-clone.mjs prepare; deps; the install through loop-lock exec --label
//                 deps --cwd <W> --timeout-ms 540000 when not fresh (judged by the exec
//                 line's state); check --after deps; deps --mark when the install ran;
//                 dispatch open; the scripted delegate (scenario ops run in <W>); dispatch
//                 close; check --after dispatch
//     section 6   delegate-flagged -> Save and reset (delegate-flagged): a ## Needs decision
//                 entry and the item back in ## Backlog with status waiting-decision; else the
//                 scope rail on out_of_scope; verify: exec --verify K --timeout-ms 540000
//                 judged by its state (exited 0 passes; lingering is an infra pause, never
//                 retried; anything else fails; {"event":"verify-run","K","restarted","state",
//                 "exit"} after each), then check --after verify after the last command or the
//                 first that failed; a changed digest restarts from K = 0 once (R22), before
//                 any failure counts, and the scope rail applies to the check after it; commit
//                 --digest; with scenario.followup, the analysis follow-up (its JSON written
//                 to <S>/briefs/<id>-followup.json, loop-items followup, applied and checked,
//                 note "analysis -> <id>") before the item goes to ## Done with the sha
//     section 7   an attempt failure (a verify failure, the scope rail, verify changing the
//                 work twice, or commit refused out-of-scope or commit-failed): the first
//                 keeps the attempt (a second dispatch), the second does Save and reset
//                 (attempt-failed) and Blocks the item with its recovery: sub-bullet (outcome
//                 failed); check/commit tampered or work-changed -> Save and reset (pause); an
//                 exit 2 from dispatch open or close is the lock-error pause, with nothing
//                 more dispatched, checked, verified or committed; every other refusal is a
//                 touch-nothing pause (the item back to ## Backlog, its status unchanged)
//     section 8   ## Last run, ## Now (empty), one ledger row (done_items included),
//                 loop-clone.mjs close, release
//   The ## Done trim, after the move to ## Done of section 6 step 4 and of the analysis branch
//   (as in the prose, not after section 1's finish-commit move; a later trim reaches that item):
//   `loop-items trim` (the 20 newest kept; below them only items the ledger records done
//   deleted, whole blocks; nothing pick's unledgered listed is ever dropped, nor a block whose
//   origin-like lines are not exactly one well-formed origin: field, R27a), its edits applied
//   edit by edit and checked with check --expect; an exit 2 or 3 from either is the item-edit
//   incident. The trimmed event carries trim's answer ({"event":"trimmed","dropped","out"}).
//   The follow-up (R17): its JSON written to <S>/briefs/<id>-followup.json, loop-items
//   followup, its edits applied and checked; both ok answers (reused false with one insertion,
//   reused true with none) are a success, note "analysis -> <id>"; a refusal is the incident.
//   Every pause (a touch-nothing pause, a planner exit 2, Save and reset (pause), a failed save
//   or reset) sets `paused: true` in LOOP.md's front matter before section 8, and its ledger row
//   carries paused: true; only the owner sets the flag back.
//   Save and reset: reflex-bundle.mjs save --item <id> (R18), the STATE.md move with the sha
//   (`none` and the empty answer's base, scope and item digest on an empty save, which skips
//   the reset; a re-save rewrites the placed block in place), reflex-bundle.mjs reset (unsaved:
//   once more from the save; busy: pause without a reset). delegate-flagged writes the
//   `### <id> . <title>` entry (upserted by id) before the item's move.
//   A not-holder answer from any helper, or an exec state not-holder or holder-gone (also as
//   a lingering run's outcome), is a lost lock: {"event":"lost-lock","what","out"}, exit 0,
//   and nothing more is written (no STATE.md edit, no ledger row).
//   Stops (the event of the same name is printed at each, and the driver waits there to be
//   killed when it is the scenario's `stop`; a name listed in `gates` waits instead until
//   the file <ctl>/<name>.go exists, then goes on): acquired, cleared (after clear-now's last
//   edit; clear-edit-<k> after an earlier one),
//   planned (after the section 1 edits), normalize-edit-<k>, pick-edit-<k>, followup-edit-<k>
//   (after edit k of that plan, before its check), <move>-inserted and <move>-moved (after a
//   move's insertion and after its deletion, before its check; <move> is finish, requeue,
//   done, blocked, backlog or flag; flag-entry after the entry; <move>-replaced on a re-save),
//   followed (after the follow-up's check), picked, prepared, deps (while the install's exec runs, and again after it),
//   deps-checked (after check --after deps, before deps --mark), dispatched (also the analysis
//   path's, the dispatch still open) /
//   dispatched-commit (after the delegate's ops, the dispatch still open; -commit when the ops
//   committed), checked, verifying (while exec --verify 0 runs), verify-checked (after each
//   check --after verify), verified, saved, saved-state, reset, committed, done, ledger,
//   closed; none runs to the release ({"event":"released"}). The trim's stops: trim-edit-<k>
//   (after edit k, before its check) and trimmed, between the move to ## Done and done.
//   An acquire held prints {"event":"held","status","out"} and exits 0, writing nothing.
//   A fault: scenario.faults maps a call key (prepare, deps-check, check, check1 for a retry's
//   check, verify-check, commit, save, save2, reset, reset2, bundle, close) to a fault point;
//   that one helper call runs
//   with TECH_LEAD_FAULT=<point>, and when it dies by SIGKILL the driver prints
//   {"event":"faulted","key","point"} and waits to be killed (the session dies with it).
//
// Scenario (JSON): {P, stop, gates: [], ctl, prefix, base, date, deps: {install} | null,
//   attempts: [{ops, fail, flag}], path: 'commit' | 'flag' | 'fail' | 'pause' | 'analysis', subject,
//   followup: {title, notes} | null, faults: {}, betweenSaveReset: [ops], env: {}}; briefs
//   and the subject file are named by the item id (R23); env reaches the helpers, after the inherited
//   git routing variables (GIT_ROUTING, tests/helpers.mjs) are scrubbed. Delegate ops, run with
//   cwd <W>:
//   ['write', rel, text], ['write64', rel, base64], ['append', rel, text], ['rm', rel],
//   ['chmod', rel, 'octal'], ['symlink', target, rel], ['mkdir', rel], ['git', ...args],
//   ['commit', message] (git add -A, git commit), ['dweller'] (a process left in <W>, in a
//   session of its own), ['codex', jobId] (loop-codex.mjs start for the generation, with the
//   scenario's env).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scrubGitRouting } from '../helpers.mjs'
import { fold, parseOrigin } from '../../scripts/lib/loop-state.mjs'
import {
  DASH, DOT, blockedBlock, doneBlock, editOnce, findItem, insertTop, nowBlock, removeItem, replaceItem, setSection, upsertEntry, withField,
} from './firing-moves.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.resolve(HERE, '..', '..', 'scripts')
const LOCK = path.join(SCRIPTS, 'loop-lock.mjs')
const emit = o => fs.writeSync(1, `${JSON.stringify(o)}\n`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// ---------------------------------------------------------------- mode 1 (0c-1, unchanged)

async function lockFiring() {
  const [P, W, stop] = process.argv.slice(2)
  if (!P || !W || !['acquired', 'stray', 'exec', 'ledger', 'none'].includes(stop)) {
    process.stderr.write('usage: firing-driver.mjs <P> <W> acquired|stray|exec|ledger|none | firing <scenario.json>\n')
    process.exit(2)
  }
  const env = { ...process.env, TECH_LEAD_HOLDER_PID: String(process.pid) }
  const fail = (what, detail) => {
    emit({ event: 'error', what, detail })
    process.exit(1)
  }
  const hang = () => setInterval(() => {}, 2 ** 30)
  const lock = (...args) => {
    const r = spawnSync(process.execPath, [LOCK, ...args], { encoding: 'utf8', env })
    let out = null
    try {
      out = JSON.parse(r.stdout)
    } catch { /* reported below */ }
    return { status: r.status, out, stderr: r.stderr }
  }

  const acq = lock('acquire', P)
  if (acq.status !== 0) fail('acquire', acq.out || acq.stderr)
  const N = acq.out.generation
  emit({ event: 'acquired', ...acq.out })
  const exec = ['exec', P, '--generation', String(N), '--label', 'verify', '--cwd', W]

  if (stop === 'acquired') {
    hang()
  } else if (stop === 'stray') {
    const stray = spawn('/bin/sleep', ['120'], { cwd: W, detached: true, stdio: 'ignore' })
    stray.unref()
    emit({ event: 'stray', pid: stray.pid })
    hang()
  } else if (stop === 'exec') {
    const wrapper = spawn(process.execPath, [LOCK, ...exec, '--verify', '0'], { env, stdio: 'ignore' })
    const dir = path.join(acq.out.lockDir, 'children')
    let rec = null
    for (let i = 0; i < 200 && !rec; i++) {
      await sleep(50)
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
          if (r.kind === 'proc' && r.pgid && r.start) rec = r
        } catch { /* replaced meanwhile */ }
      }
    }
    if (!rec) fail('exec', 'the exec record never learned its process group')
    emit({ event: 'exec', wrapper: wrapper.pid, pgid: rec.pgid })
    hang()
  } else {
    const v = spawnSync(process.execPath, [LOCK, ...exec, '--verify', '1'], { encoding: 'utf8', env })
    if (v.status !== 0) fail('verify', v.stderr)
    fs.appendFileSync(path.join(P, '.tech-lead', 'LEDGER.jsonl'), `${JSON.stringify({ iteration: N, outcome: 'done', verify: 'pass' })}\n`)
    emit({ event: 'ledger', generation: N })
    if (stop === 'ledger') {
      hang()
    } else {
      const rel = lock('release', P, '--generation', String(N))
      if (rel.status !== 0) fail('release', rel.out || rel.stderr)
      emit({ event: 'released', generation: N })
    }
  }
}

// ---------------------------------------------------------------- mode 2 (0c-2, the clone)

// STATE.md is read and changed as the main session does it (stage 0c-3 brief R14): items are
// found through scripts/lib/loop-state.mjs's parseState, by id, and every change is one Edit
// whose `old` occurs once (tests/fixtures/firing-moves.mjs); the item CLI's plans are applied
// edit by edit and confirmed with `loop-items check --expect`, and every move inserts the whole
// block first, deletes the source second, and is confirmed with `loop-items check --item`.
const ARROW = String.fromCharCode(0x2192)

function cloneFiring(sc) {
  const P = sc.P
  const S = path.join(P, '.tech-lead')
  const STATE = path.join(S, 'STATE.md')
  const LEDGER = path.join(S, 'LEDGER.jsonl')
  const stop = sc.stop ?? 'none'
  const gates = new Set(sc.gates ?? [])
  const faults = sc.faults ?? {}
  const prefix = sc.prefix ?? 'tl'
  const base = sc.base ?? 'main'
  const date = sc.date ?? '2026-10-02'
  const whyPath = sc.path ?? 'commit'
  // No inherited variable routes the delegate's git to another repository, index, object store
  // or configuration (Codex g4 #1); the scenario's env still sets one for the helpers.
  scrubGitRouting(process.env)
  const env = { ...process.env, ...(sc.env ?? {}), TECH_LEAD_HOLDER_PID: String(process.pid) }
  delete env.TECH_LEAD_FAULT
  const notes = []
  // done_items: pick's `unledgered` (R27), the ## Done items no ledger row records done; null
  // when the firing never ran pick.
  const row = { commits: [], bundles: [], saves: [], recovered: null, done_items: null }
  let N = null
  let W = null
  let lockDir = null
  let item = null // the picked item while this firing holds it: {id, title, origin, digest}

  const hang = () => { for (;;) block(2 ** 30) }
  const fail = (what, detail) => {
    emit({ event: 'error', what, detail })
    process.exit(1)
  }
  // The event of a stop; the stop itself waits to be killed, a gate for its go file.
  const at = (name, payload = {}) => {
    emit({ event: name, ...payload })
    if (stop === name) hang()
    if (gates.has(name)) {
      const go = path.join(sc.ctl, `${name}.go`)
      while (!fs.existsSync(go)) block(25)
      emit({ event: `${name}:go` })
    }
  }
  const helper = (script, args, key, extraEnv = {}) => {
    const point = key ? faults[key] : undefined
    const e = { ...env, ...extraEnv }
    if (point) e.TECH_LEAD_FAULT = point
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', env: e, maxBuffer: 64 * 1024 * 1024 })
    if (point) {
      if (r.signal === 'SIGKILL') {
        emit({ event: 'faulted', key, point })
        hang()
      }
      fail('fault-missed', `${script} ${args[0]} ran to its end with TECH_LEAD_FAULT=${point}: ${r.stdout} ${r.stderr.slice(0, 2000)}`)
    }
    let out = null
    try {
      out = JSON.parse(r.stdout.trim().split('\n').pop())
    } catch { /* null */ }
    return { status: r.status, signal: r.signal, out, stdout: r.stdout, stderr: r.stderr }
  }
  const gen = () => ['--generation', String(N)]
  const clone = (cmd, args = [], key = cmd) => helper('loop-clone.mjs', [cmd, P, ...gen(), ...args], key)
  const bundleTool = (cmd, args, key) => helper('reflex-bundle.mjs', [cmd, P, ...gen(), ...args], key)
  const lock = (args, key) => helper('loop-lock.mjs', args, key)
  const lostLock = (what, out) => {
    emit({ event: 'lost-lock', what, out })
    process.exit(0)
  }

  // LOOP.md's `paused:` flag (references/loop-templates.md: any runner exits at once when it
  // is true), read from the front matter. A firing pauses the loop by setting it there: its
  // `paused:` line becomes `paused: true` (a comment after it kept), or the line is added
  // after the opening `---` when the key is missing. Only the owner sets it back.
  const LOOP = path.join(S, 'LOOP.md')
  const frontEnd = lines => lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l))
  const isPaused = () => {
    const lines = fs.readFileSync(LOOP, 'utf8').split('\n')
    return lines.slice(1, frontEnd(lines)).some(l => /^paused\s*:\s*true\s*(#.*)?$/.test(l))
  }
  const setPaused = () => {
    const lines = fs.readFileSync(LOOP, 'utf8').split('\n')
    const at0 = lines.slice(1, frontEnd(lines)).findIndex(l => /^paused\s*:/.test(l)) + 1
    if (at0 > 0) lines[at0] = lines[at0].replace(/^paused\s*:\s*[^\s#]*/, 'paused: true')
    else lines.splice(1, 0, 'paused: true')
    fs.writeFileSync(LOOP, lines.join('\n'))
  }

  const readState = () => fs.readFileSync(STATE, 'utf8')
  const today = () => new Date().toISOString().slice(0, 10)
  // R14's incident: an edit whose `old` does not occur once, or a `check` that does not match.
  // The firing writes it to ## Last run, sets `paused: true`, appends its ledger entry (outcome
  // halted), changes nothing else in STATE.md (## Now stays as it stands for the next
  // firing's planner) and releases the lock.
  let incidentSeen = false
  const incident = (detail, extra = {}) => {
    emit({ event: 'incident', detail, ...extra })
    if (incidentSeen) fail('incident', `a second incident while halting: ${detail}`)
    incidentSeen = true
    notes.push(`item edits: incident: ${String(detail).slice(0, 300)}`)
    finish('halted', { paused: true, keepNow: true })
  }
  // One Edit of STATE.md, then the stop `name`.
  const edit = (e, name = null) => {
    let next = null
    try {
      next = editOnce(readState(), e)
    } catch (err) {
      incident(err.message)
    }
    fs.writeFileSync(STATE, next)
    if (name) at(name)
  }
  const itemsCli = (cmd, args = []) => helper('loop-items.mjs', [cmd, P, ...args])
  const checked = (args, what) => {
    const c = itemsCli('check', args)
    if (c.status !== 0) incident(`${what}: check ${args[0]}: ${c.out?.state ?? c.status}: ${c.out?.detail ?? c.stderr}`, { check: c.out })
  }
  // A plan of loop-items (normalize, pick, followup): its edits in order, a stop after each
  // (<phase>-edit-<k>), then check --expect.
  const applyPlan = (phase, out) => {
    out.edits.forEach((e, k) => edit(e, `${phase}-edit-${k + 1}`))
    checked(['--expect', out.expect_sha256], phase)
  }
  // The itemDigest of the one item carrying `id` (loop-items digest; loop "Item edits", step 1),
  // null for an item without an id. A refusal (no-item: no item or several carry the id) is the
  // item-edit incident, as every other exit 2 or 3 of loop-items.mjs is.
  const digestOf = id => {
    if (!id) return null
    const r = itemsCli('digest', ['--item', id])
    if (r.status !== 0) incident(`digest ${id}: ${r.out?.state ?? r.status}: ${r.out?.detail ?? r.stderr}`)
    return r.out.item_digest
  }
  // check --item after a move (step 4); only a move of an item with no id (an interrupted 0.5.0
  // firing's) goes unchecked, and is noted.
  const checkMove = (id, section, digest, kind) => {
    if (id) checked(['--item', `${id}@${section}:${digest}`], kind)
    else notes.push(`${kind}: move unchecked (an item without an id)`)
  }
  // A prose move of the ## Now item to the top of `to`: the block `make(item)` inserted first
  // (stop <kind>-inserted), then the ## Now block deleted, `(empty)` left (stop <kind>-moved),
  // then check --item with `digest` (or digest(item), read before the move).
  const moveNow = (kind, to, make, digest) => {
    const src = nowBlock(readState())
    if (!src) return null
    const d = typeof digest === 'function' ? digest(src) : digest
    edit(insertTop(readState(), to, make(src)), `${kind}-inserted`)
    edit(removeItem(readState(), nowBlock(readState())), `${kind}-moved`)
    checkMove(src.id, to, d, kind)
    return src
  }
  // The ## Now item back to the top of ## Backlog, its block unchanged, or with `status` set in
  // the insertion (loop section 5: the status a branch set is written in the move's insertion).
  const requeue = (status = null) => moveNow('requeue', 'Backlog', src => (status ? withField(src.lines, 'status', status) : src.lines),
    src => (item && src.id === item.id ? item.digest : digestOf(src.id)))
  const toDone = sha => moveNow('done', 'Done', src => doneBlock(src, sha, today()), item.digest)
  // The Save and reset caller's place for the sha (written again, in place, on a re-save): the
  // item moved from ## Now to `section` as `make(block)`, or, already there, rewritten in place.
  const placeItem = (kind, section, make) => {
    const now = nowBlock(readState())
    if (now && now.id === item.id) return moveNow(kind, section, make, item.digest)
    const cur = findItem(readState(), item.id, section)
    if (!cur) incident(`${kind}: ${item.id} is neither in ## Now nor in ## ${section}`)
    edit(replaceItem(readState(), cur, make(cur)), `${kind}-replaced`)
    checkMove(item.id, section, item.digest, kind)
    return cur
  }
  // delegate-flagged (loop section 6.1): the ## Needs decision entry `### <id> . <title>` with
  // its Recovery line (upserted by id, R15; the item digest from the save, R18), then the item
  // back at the top of ## Backlog with status waiting-decision, its other fields kept. The entry
  // goes first: interrupted there, the item is still in ## Now and is requeued as it was.
  // `saved` is the save's answer (an empty one carries base, scope and the digest too).
  const placeFlag = (sha, saved) => {
    edit(upsertEntry(readState(), item.id, [
      `### ${item.id} ${DOT} ${item.title}`,
      `**Flagged by:** fast-worker ${DASH} the delegate stopped on a judgment call`,
      `**Recovery:** ${sha} ${DOT} base ${saved.base} ${DOT} item-digest ${saved.item_digest ?? 'none'} ${DOT} scope ${saved.scope.digest}`,
      '**Decision:** (fill in to release the task back to the backlog)',
    ]), 'flag-entry')
    placeItem('flag', 'Backlog', src => withField(src.lines, 'status', 'waiting-decision'))
  }
  // attempt-failed: the ## Blocked item (every field kept) with its recovery: field; codex or
  // pause: the item back in ## Backlog, its fields kept, with its recovery: field.
  const placeSub = (section, reason) => sha => placeItem(section === 'Blocked' ? 'blocked' : 'backlog', section,
    src => (section === 'Blocked' ? blockedBlock(src, { attempts: 2, reason, recovery: sha }) : withField(src.lines, 'recovery', sha)))

  // Loop sections 4-5, the analysis follow-up (R17): the JSON written with the Write tool,
  // followup's insertion applied and checked before the item moves to ## Done, so an
  // interruption leaves the analysis in ## Now (finished, cleared or requeued by the planner)
  // and a rerun of it finds the follow-up already there (followup is idempotent). Both ok
  // answers are a success (reused: false with its insertion, reused: true with no edits; Codex
  // g3#3); only a refusal or an error is the item-edit incident.
  const followUp = () => {
    const file = path.join(S, 'briefs', `${item.id}-followup.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(sc.followup))
    const fu = itemsCli('followup', ['--parent', item.id, '--input', file])
    if (fu.status !== 0) incident(`followup: ${fu.out?.state ?? fu.status}: ${fu.out?.detail ?? fu.stderr}`)
    applyPlan('followup', fu.out)
    notes.push(`analysis ${ARROW} ${fu.out.id}`)
    at('followed', { out: fu.out })
  }

  // Loop section 6 step 4 (and the analysis branch), after the move to ## Done and before the
  // ledger append (R27; Claude PDC-2; loop "Item edits", Trimming ## Done), as the prose runs
  // it: `loop-items trim`, its edits applied in order (stop trim-edit-<k>), then check --expect
  // (run with an empty edit list too); an exit 2 or 3 from either is the item-edit incident.
  const trimDone = () => {
    const tr = itemsCli('trim')
    if (tr.status !== 0) incident(`trim: ${tr.out?.state ?? tr.status}: ${tr.out?.detail ?? tr.stderr}`)
    // The rule as R27 states it: nothing pick listed as unledgered is ever dropped (the ledger
    // has not changed since pick).
    const kept = new Set((row.done_items ?? []).map(d => d.item_id))
    if (tr.out.dropped.some(id => kept.has(id))) fail('trim', `loop-items trim drops an item pick listed as unledgered: ${tr.out.dropped}`)
    // R27a as the prose states it: a block whose origin lines are not exactly one well-formed
    // `origin:` field (a capitalized `Origin:`, a second origin line, an invalid value) is the
    // only full record of its parents, so it is never dropped; one with no origin line may go.
    const before = readState()
    const torn = tr.out.dropped.filter(id => {
      const it = findItem(before, id, 'Done')
      if (!it) return false
      const like = it.lines.filter(l => /^\s*(?:[-*+]\s*)?origin\s*:/i.test(fold(l)))
      const own = it.fields.filter(f => f.label === 'origin')
      return like.length > 1 || (like.length === 1 && (own.length !== 1 || parseOrigin(own[0].value) === null))
    })
    if (torn.length) fail('trim', `loop-items trim drops a block whose lineage the ledger cannot carry whole: ${torn}`)
    applyPlan('trim', tr.out)
    at('trimmed', { dropped: tr.out.dropped, out: tr.out })
  }

  // ---- section 8: ## Last run, ## Now (empty), the ledger row, close, release.
  const finish = (outcome, extra = {}) => {
    if (extra.paused) setPaused()
    // An item still in ## Now goes back to the top of ## Backlog (a move), except after an
    // incident, which leaves ## Now as it stands.
    if (!extra.keepNow && nowBlock(readState())) requeue()
    try {
      const line = `- generation ${N}: ${outcome}${notes.length ? ` (${notes.join('; ')})` : ''}`.replace(/\n/g, ' ')
      fs.writeFileSync(STATE, editOnce(readState(), setSection(readState(), 'Last run', [line])))
    } catch (err) {
      notes.push(`## Last run not written: ${err.message}`)
    }
    // R21: the row names the item by id and origin (null when nothing was picked).
    const r = {
      ts: new Date().toISOString(), iteration: N, task: item ? item.title : null, item_id: item ? item.id : null,
      item_origin: item ? item.origin : null, outcome,
      verify: extra.verify ?? null, commits: row.commits, bundles: row.bundles.length ? row.bundles : null,
      saves: row.saves.length ? row.saves : null, recovered: row.recovered, done_items: row.done_items, notes: notes.join('; ') || null,
      ...(extra.paused ? { paused: true } : {}),
    }
    fs.appendFileSync(LEDGER, `${JSON.stringify(r)}\n`)
    at('ledger', { row: r })
    const c = helper('loop-clone.mjs', ['close', P, ...gen()], 'close')
    if (c.status === 3 && c.out?.state === 'not-holder') lostLock('close', c.out)
    at('closed', { status: c.status, out: c.out })
    const rel = lock(['release', P, ...gen()])
    if (rel.status !== 0) fail('release', rel.out || rel.stderr)
    emit({ event: 'released', generation: N, outcome })
    process.exit(0)
  }
  // A touch-nothing pause: the item back to ## Backlog with its status unchanged, or with
  // `status` (waiting-infra for an exec lingering).
  const pause = (why, detail, status = null) => {
    notes.push(`paused: ${why}${detail ? `: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)}` : ''}`)
    emit({ event: 'paused', why, detail })
    requeue(status)
    finish('skipped', { paused: true })
  }
  // The last stderr line of a loop-lock exec run, as JSON ({state:'unreadable'} without one).
  const execLast = r => {
    try {
      return JSON.parse(r.stderr.trim().split('\n').pop().replace(/^loop-lock exec: /, ''))
    } catch {
      return { state: 'unreadable', stderr: r.stderr.slice(0, 2000) }
    }
  }
  const LOST = ['not-holder', 'holder-gone']
  const execLost = last => LOST.includes(last.state) || (last.state === 'lingering' && LOST.includes(last.outcome?.state))
  // A helper's lost-lock answer: exit 3 not-holder.
  const lost = (r, what) => {
    if (r.status === 3 && r.out?.state === 'not-holder') lostLock(what, r.out)
  }

  // ---- Save and reset (the named procedure; brief section 19).
  const saveAndReset = (why, place) => {
    for (let round = 0; round < 2; round++) {
      const s = bundleTool('save', ['--why', why, '--item', item.id], round ? 'save2' : 'save')
      if (s.status === 3 && s.out?.state === 'not-holder') lostLock('save', s.out)
      if (s.out?.state === 'empty') {
        // Nothing to save: the caller's section move with `none` in the sha's place; no reset.
        place('none', s.out)
        at('saved-state', { sha: null, empty: s.out, round })
        return { state: 'empty' }
      }
      if (s.status !== 0 || s.out?.state !== 'saved') return { state: 'save-failed', detail: s.out ?? s.stderr }
      const saved = s.out
      row.saves.push({ sha: saved.sha, why, files: saved.files, out_of_scope: saved.counts?.out_of_scope ?? saved.out_of_scope.length })
      at('saved', { out: saved, round })
      place(saved.sha, saved)
      at('saved-state', { sha: saved.sha, round })
      if (round === 0) runOps(sc.betweenSaveReset ?? [])
      const r = bundleTool('reset', ['--sha', saved.sha], round ? 'reset2' : 'reset')
      if (r.status === 3 && r.out?.state === 'not-holder') lostLock('reset', r.out)
      if (r.status === 0) {
        at('reset', { out: r.out, round })
        return { state: 'reset', sha: saved.sha }
      }
      if (r.out?.state === 'unsaved' && round === 0) {
        notes.push('reset found unsaved changes: saved again')
        continue
      }
      return { state: r.out?.state === 'busy' ? 'busy' : 'reset-failed', detail: r.out ?? r.stderr }
    }
    return { state: 'reset-failed', detail: 'unsaved twice' }
  }
  // A Save and reset that pauses the loop afterwards (or, on a failed save, pauses at once).
  const saveResetThen = (why, place, outcome, extra = {}) => {
    const res = saveAndReset(why, place)
    if (res.state === 'save-failed') {
      notes.push(`save failed: ${JSON.stringify(res.detail).slice(0, 300)}`)
      requeue()
      finish('halted', { paused: true })
    }
    if (res.state === 'busy' || res.state === 'reset-failed') {
      notes.push(`reset ${res.state}: ${JSON.stringify(res.detail).slice(0, 300)}`)
      finish(outcome, { ...extra, paused: true })
    }
    finish(outcome, { ...extra, paused: why === 'pause' })
  }

  // ---- the delegate.
  const dwellers = []
  const codex = []
  const runOps = ops => {
    for (const op of ops) {
      const [kind, ...a] = op
      const abs = rel => path.join(W, rel)
      const parent = rel => fs.mkdirSync(path.dirname(abs(rel)), { recursive: true })
      if (kind === 'write') {
        parent(a[0])
        fs.writeFileSync(abs(a[0]), a[1])
      } else if (kind === 'write64') {
        parent(a[0])
        fs.writeFileSync(abs(a[0]), Buffer.from(a[1], 'base64'))
      } else if (kind === 'append') fs.appendFileSync(abs(a[0]), a[1])
      else if (kind === 'rm') fs.rmSync(abs(a[0]), { recursive: true, force: true })
      else if (kind === 'chmod') fs.chmodSync(abs(a[0]), parseInt(a[1], 8))
      else if (kind === 'symlink') {
        parent(a[1])
        fs.symlinkSync(a[0], abs(a[1]))
      } else if (kind === 'mkdir') fs.mkdirSync(abs(a[0]), { recursive: true })
      else if (kind === 'git' || kind === 'commit') {
        const runs = kind === 'git' ? [a] : [['add', '-A'], ['commit', '-q', '-m', a[0]]]
        for (const args of runs) {
          const r = spawnSync('git', ['-C', W, ...args], { encoding: 'utf8', env: process.env })
          if (r.status !== 0) fail('delegate-git', `git ${args.join(' ')}: ${r.stderr}`)
        }
      } else if (kind === 'dweller') {
        const launch = "const c = require('node:child_process').spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)"
        const r = spawnSync(process.execPath, ['-e', launch], { encoding: 'utf8', cwd: W })
        dwellers.push(Number(r.stdout.trim()))
      } else if (kind === 'codex') {
        const brief = path.join(S, 'briefs', `${item.id}-codex.md`)
        fs.mkdirSync(path.dirname(brief), { recursive: true })
        fs.writeFileSync(brief, 'brief\n')
        const r = helper('loop-codex.mjs', ['start', '--cwd', W, '--prompt-file', brief, '--cap-min', '1', '--project', P, ...gen()])
        if (r.status !== 0) fail('codex-start', r.stdout + r.stderr)
        codex.push(r.out)
      } else fail('op', `unknown delegate op ${JSON.stringify(op)}`)
    }
  }
  // exec in the background, until its child record names the process group.
  const execAsync = args => {
    const wrapper = spawn(process.execPath, [LOCK, ...args], { env, stdio: 'ignore' })
    const dir = path.join(lockDir, 'children')
    const label = args[args.indexOf('--label') + 1]
    for (let i = 0; i < 400; i++) {
      block(50)
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
          if (r.kind === 'proc' && r.label === label && r.pgid && r.start) return { wrapper: wrapper.pid, pgid: r.pgid }
        } catch { /* replaced meanwhile */ }
      }
    }
    return fail('exec', 'the exec record never learned its process group')
  }

  // ---- section 1: acquire, the planner and its actions.
  const acq = lock(['acquire', P])
  if (acq.status !== 0) {
    emit({ event: 'held', status: acq.status, out: acq.out })
    process.exit(0)
  }
  N = acq.out.generation
  W = acq.out.W
  lockDir = acq.out.lockDir
  at('acquired', acq.out)
  const planArgs = [P, ...gen(), ...(acq.out.reclaimed ? ['--reclaimed', String(acq.out.reclaimed.generation)] : [])]
  const plan = helper('loop-recover.mjs', planArgs)
  if (plan.status !== 0) {
    // Loop section 1 step 5: a ## Now item goes back to the top of ## Backlog (finish does it),
    // named in the incident.
    const now = nowBlock(readState())
    notes.push(`recovery planner: ${plan.out?.detail ?? plan.stderr}${now ? `; ${now.title} back to the top of ## Backlog` : ''}`)
    emit({ event: 'halted', status: plan.status, out: plan.out })
    finish('skipped', { paused: true })
  }
  const actions = plan.out.actions
  // The ## Now action taken, which the ledger row's recovered.action names: finish-commit or
  // requeue-now, and null otherwise, after clear-now too (loop section 1 step 5; the ledger
  // schema in loop-templates.md has no clear-now value).
  const nowAction = ['finish-commit', 'requeue-now'].find(a => actions.includes(a)) ?? null
  for (const action of actions) {
    if (action === 'clear-now') {
      // R20, R29: the planner's anchored deletion of the one ## Now block (never the whole
      // section), applied and checked; the other copy is the item, confirmed as a move is.
      const c = plan.out.clear
      c.edits.forEach((e, k) => edit(e, k === c.edits.length - 1 ? 'cleared' : `clear-edit-${k + 1}`))
      checked(['--expect', c.expect_sha256], 'clear-now')
      notes.push(`cleared interrupted move of ${c.id}`)
      checkMove(c.id, c.section, digestOf(c.id), 'clear-now')
    } else if (action === 'now-conflict') {
      // R29: the copies are not one item caught inside a move: the item-edit incident, every
      // copy kept, ## Now as it stands.
      const c = plan.out.conflict
      incident(`now-conflict: ${c.id}: ${c.reasons.join(', ')}`, { conflict: c })
    } else if (action === 'finish-commit') {
      const f = plan.out.finish
      moveNow('finish', 'Done', src => doneBlock(src, f.sha, today()), src => f.item_digest ?? digestOf(src.id))
    } else if (action === 'requeue-now') requeue()
    else if (action === 'ledger-recovered') row.recovered = { ...plan.out.recovered, action: nowAction }
    else if (action === 'write-bundle') {
      for (const b of plan.out.write_bundles) {
        const r = clone('bundle', ['--branch', b], 'bundle')
        if (r.status === 3 && r.out?.state === 'not-holder') lostLock('bundle', r.out)
        if (r.status === 0 && r.out.state === 'bundled') row.bundles.push(r.out.bundle)
        else notes.push(`bundle ${b}: ${JSON.stringify(r.out)}`)
      }
    } else if (action === 'note-leftovers') notes.push('leftovers noted')
  }
  at('planned', { plan: plan.out })

  // ---- section 2, gate 1: LOOP.md's paused flag, read after the recovery above and before
  // any pick, prepare or dispatch -> outcome halted, note "paused".
  if (isPaused()) {
    notes.push('paused')
    emit({ event: 'gated', gate: 'paused' })
    finish('halted')
  }

  // ---- section 3: step 0 normalize (ids and origins filled, R1), then pick (the releases and
  // the order, R13, R16), each plan applied edit by edit and checked; the skipped items and
  // their reasons go to ## Last run. A refusal or error of either is the item-edit incident
  // (loop "Item edits"): ## Now left as it stands, outcome halted, paused.
  const nz = itemsCli('normalize')
  if (nz.status !== 0) incident(`normalize: ${nz.out?.state ?? nz.status}: ${nz.out?.detail ?? nz.stderr}`)
  applyPlan('normalize', nz.out)
  // Loop section 3 step 1: the minted ids and each problem, in ## Last run.
  if (nz.out.minted.length) notes.push(`minted ${nz.out.minted.join(', ')}`)
  for (const pr of nz.out.problems) notes.push(`problem ${pr.kind} line ${pr.line}${pr.detail ? `: ${pr.detail}` : ''}${pr.candidate ? ` (candidate ${pr.candidate})` : ''}`)
  const pk = itemsCli('pick')
  // R27: the row records pick's `unledgered` as its done_items, whatever the outcome (a refusal
  // carries it too).
  if (Array.isArray(pk.out?.unledgered)) row.done_items = pk.out.unledgered
  if (pk.status !== 0) incident(`pick: ${pk.out?.state ?? pk.status}: ${pk.out?.detail ?? pk.stderr}`)
  // Step 2: each released id and each skipped row.
  for (const id of pk.out.released) notes.push(`released ${id}`)
  for (const sk of pk.out.skipped) notes.push(`skipped ${sk.id ?? '-'} ${sk.title ?? ''}: ${sk.reason}${sk.detail ? ` (${sk.detail})` : ''}`)
  applyPlan('pick', pk.out)
  if (pk.out.state !== 'picked') {
    notes.push('backlog dry')
    finish('skipped')
  }
  const picked = findItem(readState(), pk.out.id, 'Now')
  if (!picked) incident(`pick: ${pk.out.id} is not in ## Now`)
  item = { id: pk.out.id, title: pk.out.title, origin: picked.origin ?? null, digest: pk.out.digest }
  at('picked', { item: picked.lines, pick: pk.out })

  // ---- section 5, L3 analysis-shaped (path 'analysis'): the read-only deep-reasoner, bracketed
  // by a dispatch record; no clone is prepared and nothing is committed. Its follow-up (when the
  // scenario has one) is created, applied and checked, then the item moves to ## Done with the
  // dash in the sha slot; outcome done, commits [], note "analysis -> <id or 'no follow-up'>".
  if (whyPath === 'analysis') {
    const d = lock(['dispatch', 'open', P, ...gen(), '--label', 'deep-reasoner'])
    if (d.status === 3) lostLock('dispatch open', d.out)
    if (d.status !== 0) pause('lock error', d.out?.detail)
    at('dispatched', { analysis: true })
    const dc = lock(['dispatch', 'close', P, ...gen(), '--id', d.out.id])
    if (dc.status === 3) lostLock('dispatch close', dc.out)
    if (dc.status !== 0) pause('lock error', dc.out?.detail ?? dc.stderr)
    if (sc.followup) followUp()
    else notes.push(`analysis ${ARROW} no follow-up`)
    toDone(null)
    trimDone()
    at('done', { sha: null })
    finish('done')
  }

  // ---- section 5: prepare, deps, dispatch, check.
  const prep = clone('prepare', ['--prefix', prefix, '--base', base, '--date', date], 'prepare')
  if (prep.status === 3 && prep.out?.state === 'not-holder') lostLock('prepare', prep.out)
  if (prep.status !== 0) pause(`prepare ${prep.out?.state ?? prep.status}`, prep.out?.detail ?? prep.stderr)
  for (const r of prep.out.recovered) row.saves.push({ sha: r.sha, why: r.why ?? 'clean-clone', files: r.files, out_of_scope: r.out_of_scope })
  row.bundles.push(...prep.out.bundles)
  at('prepared', { out: prep.out })

  const depsState = clone('deps', [], 'deps')
  lost(depsState, 'deps')
  if (depsState.status !== 0) pause(`deps ${depsState.out?.state ?? depsState.status}`, depsState.out?.detail ?? depsState.stderr)
  let installed = false
  if (!depsState.out.fresh && sc.deps?.install) {
    const args = ['exec', P, ...gen(), '--label', 'deps', '--cwd', W, '--timeout-ms', '540000', '--', '/bin/sh', '-c', sc.deps.install]
    if (stop === 'deps') at('deps', execAsync(args))
    const r = spawnSync(process.execPath, [LOCK, ...args], { encoding: 'utf8', env })
    const last = execLast(r)
    // clone.md step 4: a lost lock first; only `exited` with exit 0 is a success; anything
    // else (lingering included) is the "clone deps" infra pause.
    if (execLost(last)) lostLock('deps exec', last)
    if (!(last.state === 'exited' && last.exit === 0)) pause(`deps install ${last.state}`, last)
    installed = true
    at('deps', { status: r.status, last })
  }
  const cd = clone('check', ['--after', 'deps'], 'deps-check')
  lost(cd, 'check --after deps')
  if (cd.status !== 0) pause(`check --after deps ${cd.out?.state ?? cd.status}`, cd.out?.detail ?? cd.stderr)
  at('deps-checked', { check: cd.out })
  if (installed) {
    // clone.md step 5: mark the dependencies installed only when step 4 ran, and judge it.
    const mk = clone('deps', ['--mark'], 'deps-mark')
    lost(mk, 'deps --mark')
    if (mk.status !== 0) pause(`deps --mark ${mk.out?.state ?? mk.status}`, mk.out?.detail ?? mk.stderr)
  }

  const verifyCount = (() => {
    const text = fs.readFileSync(path.join(S, 'LOOP.md'), 'utf8')
    const m = /^verify:\n((?:\s+- .*\n)+)/m.exec(text)
    return m ? m[1].trim().split('\n').length : 0
  })()
  const attempts = sc.attempts ?? [{ ops: [] }]
  let failures = 0
  // An attempt failure (loop section 7): the first keeps the attempt (the caller dispatches
  // again), the second runs Save and reset (attempt-failed) and Blocks the item.
  const attemptFailed = () => {
    failures++
    if (failures >= 2) saveResetThen('attempt-failed', placeSub('Blocked', 'attempt failed twice'), 'failed', { verify: 'fail' })
  }
  for (let i = 0; ; i++) {
    const attempt = attempts[i] ?? { ops: [], fail: attempts[0]?.fail }
    const d = lock(['dispatch', 'open', P, ...gen(), '--label', `delegate-${i}`])
    if (d.status === 3) lostLock('dispatch open', d.out)
    if (d.status !== 0) pause('lock error', d.out?.detail)
    runOps(attempt.ops ?? [])
    const committed = (attempt.ops ?? []).some(op => op[0] === 'commit' || (op[0] === 'git' && op[1] === 'commit'))
    at(committed ? 'dispatched-commit' : 'dispatched', { attempt: i, dwellers, codex })
    const dc = lock(['dispatch', 'close', P, ...gen(), '--id', d.out.id])
    if (dc.status === 3) lostLock('dispatch close', dc.out)
    // Loop section 1 step 3, Lock errors: an exit 2 from dispatch close dispatches nothing more
    // and runs no check, verify or commit: the lock-error pause.
    if (dc.status !== 0) pause('lock error', dc.out?.detail ?? dc.stderr)
    const ck = clone('check', ['--after', 'dispatch'], i ? `check${i}` : 'check')
    lost(ck, 'check')
    if (ck.status !== 0) {
      if (['tampered', 'work-changed'].includes(ck.out?.state)) saveResetThen('pause', placeSub('Backlog'), 'skipped')
      pause(`check ${ck.out?.state ?? ck.status}`, ck.out?.detail)
    }
    at('checked', { check: ck.out, attempt: i })

    // ---- section 6.
    if (attempt.flag || whyPath === 'flag') saveResetThen('delegate-flagged', placeFlag, 'flagged')
    if (whyPath === 'pause') saveResetThen('pause', placeSub('Backlog'), 'skipped')
    let failed = Boolean(attempt.fail) || ck.out.out_of_scope.length > 0
    let digest = ck.out.digest
    if (!failed && verifyCount > 0) {
      let restarted = false
      for (;;) {
        let verifyFailed = false
        for (let K = 0; K < verifyCount; K++) {
          const args = ['exec', P, ...gen(), '--label', 'verify', '--cwd', W, '--timeout-ms', '540000', '--verify', String(K)]
          if (stop === 'verifying' && K === 0 && !restarted) at('verifying', execAsync(args))
          const v = spawnSync(process.execPath, [LOCK, ...args], { encoding: 'utf8', env })
          const last = execLast(v)
          emit({ event: 'verify-run', K, restarted, state: last.state, exit: last.exit })
          // Loop section 6 step 3, judged by the exec line's state, never the exit code alone.
          if (execLost(last)) lostLock('verify exec', last)
          if (last.state === 'lingering') pause('exec lingering', last, 'waiting-infra')
          if (!(last.state === 'exited' && last.exit === 0)) {
            verifyFailed = true
            notes.push(`verify ${K} ${last.state}${last.exit === undefined ? '' : ` exit ${last.exit}`}`)
            break
          }
        }
        // After the last command, or the first that failed: check the clone again.
        const cv = clone('check', ['--after', 'verify'], 'verify-check')
        lost(cv, 'check --after verify')
        if (cv.status !== 0) {
          if (['tampered', 'work-changed'].includes(cv.out?.state)) saveResetThen('pause', placeSub('Backlog'), 'skipped')
          pause(`check ${cv.out?.state ?? cv.status}`, cv.out?.detail ?? cv.stderr)
        }
        at('verify-checked', { check: cv.out, restarted, verifyFailed })
        // R22 first, the failing command included (plan Appendix B): a changed digest restarts
        // every verify command from K = 0 once, whether or not a command failed; a second
        // change is an attempt failure.
        if (cv.out.digest !== digest) {
          digest = cv.out.digest
          if (restarted) {
            failed = true
            notes.push('verify changed the work twice')
            break
          }
          restarted = true
          notes.push('verify changed the work: verification restarted')
          continue
        }
        if (verifyFailed) {
          failed = true
          break
        }
        // The scope rail (section 6 step 2) on the check after a restart.
        if (cv.out.out_of_scope.length) {
          failed = true
          notes.push(`out of scope after verify: ${cv.out.out_of_scope.join(', ')}`)
        }
        break
      }
    }
    if (failed) {
      attemptFailed()
      continue
    }
    at('verified', { digest })
    const subject = path.join(S, 'briefs', `${item.id}.subject`)
    fs.mkdirSync(path.dirname(subject), { recursive: true })
    fs.writeFileSync(subject, `${sc.subject ?? item.title}\n`)
    const cm = clone('commit', ['--digest', digest, '--subject-file', subject], 'commit')
    if (cm.status === 3 && cm.out?.state === 'not-holder') lostLock('commit', cm.out)
    if (cm.status !== 0) {
      if (['tampered', 'work-changed'].includes(cm.out?.state)) saveResetThen('pause', placeSub('Backlog'), 'skipped')
      // references/clone.md: out-of-scope and commit-failed are an attempt failure, the detail
      // its failure excerpt.
      if (cm.status === 3 && ['out-of-scope', 'commit-failed'].includes(cm.out?.state)) {
        notes.push(`commit ${cm.out.state}: ${String(cm.out.detail ?? '').slice(0, 300)}`)
        attemptFailed()
        continue
      }
      pause(`commit ${cm.out?.state ?? cm.status}`, cm.out?.detail)
    }
    let sha = null
    if (cm.out.state === 'committed') {
      sha = cm.out.sha
      row.commits.push(sha)
      if (cm.out.bundle) row.bundles.push(cm.out.bundle)
      if (cm.out.bundleError) notes.push(`bundle error: ${cm.out.bundleError}`)
    }
    at('committed', { out: cm.out })
    if (sc.followup) followUp()
    toDone(sha)
    trimDone()
    at('done', { sha })
    finish('done', { verify: 'pass' })
  }
}

// The mode is chosen last, once every constant above is initialized.
if (process.argv[2] === 'firing') cloneFiring(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')))
else await lockFiring()
