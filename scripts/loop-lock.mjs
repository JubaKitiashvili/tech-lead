#!/usr/bin/env node
// scripts/loop-lock.mjs
// The firing lock (spec 10, stage 0c-1). Each firing of a project holds one generation N,
// a strictly increasing number that is also the ledger `iteration`. The holder is the
// long-lived runner process, named by pid and start token (scripts/lib/loop-proc.mjs).
//
// Layout under <V>/lock:
//   slots/<N>.json            holder record, immutable (link(2), so one racer wins N)
//   slots/<N>.released.json   release record, immutable
//   slots/<N>.closing.json    closing marker: an acquire has begun to stop N's children, so
//                             no child registers in N any more (assertHeld refuses it)
//   children/<N>-<name>.json  child records: kind proc (exec), codex, dispatch
//
// Acquire takes N = max(last generation, largest ledger iteration) + 1; with no slot on
// record at all, N also exceeds every child record's generation (a generation that had
// children existed). An unreleased last generation blocks it while its holder is alive (or
// unknown) and while the same process still has a dispatch of it open. Then the children
// of every generation below N (a released one's too: an owner release stops nothing) are
// stopped, each generation marked closing first, and any child that cannot be stopped
// blocks it; age plays no part. A newer generation appearing meanwhile ends the acquire
// before its next signal, quiesce or record removal (held `race`). A reclaim (of a dead
// holder's or this same process's generation) then sweeps <S>/worktree and <V> for live
// processes outside the caller's own ancestry: any it finds block it (never signalled).
// A held result creates nothing outside slots/.tmp-* and closing markers; it removes only
// the records of children it proved gone.
//
// Records name the processes behind them: an exec child its wrapper and process group
// (the command is started through a gate only once the group is on record), a Codex job
// the `loop-codex.mjs start` that launches it (a reclaim waits for that starter, and its
// process group, to be gone before it quiesces), a dispatch nothing (it lives in its
// holder's process).
//
// CLI (one JSON line on stdout; exit 0, 2 error or usage, 3 held or not holder):
//   acquire <P>                                         {state:'acquired', generation, V, lockDir, previous, reclaimed} (no W until stage 0c-2's clone)
//                                                       exit 3 {state:'held', reason, generation, ...}
//   release <P> --generation <N> [--owner]              {state:'released', generation, ...}
//                                                       exit 3 {state:'dispatch-open', ...}: nothing released
//   dispatch open <P> --generation <N> --label <L>      {id}
//   dispatch close <P> --generation <N> --id <ID>       {closed:true}
//   status <P>                                          read-only
//   not the holder: exit 3 {state:'not-holder', detail[, reason:'closing']}; a holder whose
//   start token cannot be read: exit 2 {state:'error', detail:'holder-unknown: ...'}
//   (acquire: exit 3 held 'holder-unknown')
// and exec, which prints nothing of its own on stdout:
//   exec <P> --generation <N> --label <L> --cwd <dir> [--timeout-ms <T>] (--verify <K> | -- <argv>...)
//     runs the command as a registered child of generation N in a process group of its
//     own; its stdout and stderr pass through, and the last stderr line is
//     `loop-lock exec: {"state":...,"exit":...,...}`. Exit: the command's own code (128 + n when
//     a signal ended it), 124 timeout, 125 not the holder or the holder gone, 2 usage or
//     setup error (holder-unknown too), 126/127 the command could not start, 123 lingering:
//     the cleanup failed (the group survived or its liveness is unknown, or a process still
//     runs in <dir> or the sweep for one could not run), whatever the command exited;
//     `outcome` then holds the state the run would otherwise have reported.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createExclusive, readJson, writeReplace } from './lib/atomic.mjs'
import { ensureV, loopPaths } from './lib/loop-paths.mjs'
import { cwdSweep, groupAlive, isAlive, killGroup, resolveHolder, startToken } from './lib/loop-proc.mjs'
import { quiesce } from './loop-codex.mjs'

const ATTEMPTS = 5
// A wrapper sent SIGTERM ends once its own cleanup is done, which includes its sweep for
// processes left in <dir> (ps and lsof, PS_TIMEOUT_MS and 20 s at most).
const WRAPPER_WAIT_MS = 40000
const STARTER_WAIT_MS = 10000
const POLL_MS = 100
const EXEC_POLL_MS = 1000
const MAX_TIMEOUT_MS = 2 ** 31 - 1 // the largest delay setTimeout honours
const PS_TIMEOUT_MS = 10000
const EXEC_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM']
const EXIT_LINGERING = 123
const KINDS = ['proc', 'codex', 'dispatch']
// The start gate: /bin/sh waits for the line `go` on its stdin, then becomes the command.
// The wrapper writes that line only once the gate's process group is on record, so a wrapper
// that dies first closes the pipe and the gate exits 125 without running anything.
const GATE = 'IFS= read -r go && [ "$go" = go ] || exit 125; exec "$@" </dev/null'
const GENERATION = /^[1-9]\d*$/
const CHILD_ID = /^[0-9a-f]{16}$/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const validGeneration = g => Number.isSafeInteger(g) && g > 0
const slotsDir = paths => path.join(paths.lockDir, 'slots')
const childrenDir = paths => path.join(paths.lockDir, 'children')
const slotFile = (paths, g) => path.join(slotsDir(paths), `${g}.json`)
const releasedFile = (paths, g) => path.join(slotsDir(paths), `${g}.released.json`)
const closingFile = (paths, g) => path.join(slotsDir(paths), `${g}.closing.json`)
const held = (reason, generation, extra = {}) => ({ state: 'held', reason, generation, ...extra })
const unknownFact = detail => ({ state: 'unknown', detail })

// reason, when given, names why in one word (e.reason, and `reason` in the CLI output).
function notHolder(detail, reason) {
  const e = new Error(`not-holder: ${detail}`)
  e.code = 'NOT_HOLDER'
  if (reason) e.reason = reason
  return e
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

// The lock paths of P without creating anything. A <V> bound to another R is refused.
export function openPaths(P, env = process.env) {
  const paths = loopPaths(P, { env })
  const id = readJson(path.join(paths.V, 'identity.json'))
  if (id && id.R !== paths.R) throw new Error(`identity-mismatch: ${paths.V} belongs to ${id.R}`)
  return paths
}

// The highest N with a slots/<N>.json, or null.
function maxSlot(paths) {
  let max = null
  for (const name of listDir(slotsDir(paths))) {
    const m = /^([1-9]\d*)\.json$/.exec(name)
    const g = m ? Number(m[1]) : 0
    if (validGeneration(g) && (max === null || g > max)) max = g
  }
  return max
}

// The child record files of generation g (temp files start with a dot and never match).
function childFiles(paths, g) {
  return listDir(childrenDir(paths)).filter(n => n.startsWith(`${g}-`) && n.endsWith('.json')).sort()
    .map(n => path.join(childrenDir(paths), n))
}

// The generations that have child records, ascending.
function childGenerations(paths) {
  const out = new Set()
  for (const n of listDir(childrenDir(paths))) {
    const m = /^([1-9]\d*)-.+\.json$/.exec(n)
    if (m && validGeneration(Number(m[1]))) out.add(Number(m[1]))
  }
  return [...out].sort((a, b) => a - b)
}

// max numeric `iteration` over the parseable lines of <S>/LEDGER.jsonl; 0 when missing.
// A fractional value is rounded up, so the next generation still exceeds it.
export function ledgerFloor(S) {
  let text
  try {
    text = fs.readFileSync(path.join(S, 'LEDGER.jsonl'), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return 0
    throw e
  }
  let floor = 0
  for (const line of text.split('\n')) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const it = row !== null && typeof row === 'object' ? row.iteration : undefined
    if (typeof it === 'number' && Number.isFinite(it)) floor = Math.max(floor, Math.ceil(it))
  }
  return floor
}

// TECH_LEAD_PS replaces /bin/ps in tests only, as in loop-proc.mjs.
const PS = () => process.env.TECH_LEAD_PS || '/bin/ps'
const ps = args => spawnSync(PS(), args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' },
})

// The process group id of pid (ps -o pgid=; linux: /proc/<pid>/stat), or null when it
// cannot be read or is not a usable one (an integer above 1).
function processGroup(pid) {
  let pgid = null
  try {
    if (process.platform === 'linux') {
      const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      pgid = Number(text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[2])
    } else {
      const r = ps(['-o', 'pgid=', '-p', String(pid)])
      if (r.status === 0 && /^\s*\d+\s*$/.test(r.stdout)) pgid = Number(r.stdout)
    }
  } catch { /* unreadable: null */ }
  return Number.isInteger(pgid) && pgid > 1 ? pgid : null
}

// ancestry() -> {state:'ok', pids} | {state:'unknown', detail}: this process and each of
// its ancestors up to (not including) pid 1. darwin: one `ps -A -o pid= -o ppid=` listing;
// linux: the ppid field of /proc/<pid>/stat.
function ancestry() {
  let parentOf
  if (process.platform === 'linux') {
    parentOf = pid => {
      try {
        const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const ppid = Number(text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
        return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined
      } catch {
        return undefined
      }
    }
  } else {
    const r = ps(['-A', '-o', 'pid=', '-o', 'ppid='])
    if (r.error || r.status !== 0) return unknownFact(`ps -A: ${r.error ? r.error.code || r.error.message : `exit ${r.status}`}`)
    const map = new Map()
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (m) map.set(Number(m[1]), Number(m[2]))
    }
    parentOf = pid => map.get(pid)
  }
  const pids = []
  for (let pid = process.pid; pid > 1 && !pids.includes(pid);) {
    pids.push(pid)
    const ppid = parentOf(pid)
    if (ppid === undefined) return unknownFact(`cannot read the parent of pid ${pid}`)
    pid = ppid
  }
  return { state: 'ok', pids }
}

// cwdSweep over dirs, never listing this process or any of its ancestors (the runner, its
// shell, a terminal standing in the work tree): {state:'ok', procs} | {state:'unknown', detail}.
function sweep(dirs) {
  const a = ancestry()
  if (a.state !== 'ok') return a
  return cwdSweep(dirs, { exclude: a.pids })
}

// The slot of generation N when the caller's holder holds it: N is the last generation,
// it is neither released nor closing, and its holder has the caller's pid and start token.
// Throws NOT_HOLDER (reason 'closing' for a closing generation), or the HOLDER_UNKNOWN of
// resolveHolder as it is: a holder whose token cannot be read is not known to be absent.
export function assertHeld(paths, generation, env = process.env) {
  if (!validGeneration(generation)) throw notHolder(`bad generation ${generation}`)
  const max = maxSlot(paths)
  if (max !== generation) throw notHolder(max === null ? 'no generation is held' : `generation ${generation} is not the current one (${max})`)
  if (fs.existsSync(releasedFile(paths, generation))) throw notHolder(`generation ${generation} was released`)
  if (fs.existsSync(closingFile(paths, generation))) {
    throw notHolder(`generation ${generation} is closing: an acquire has begun to stop its children`, 'closing')
  }
  let slot, me
  try {
    slot = readJson(slotFile(paths, generation))
    me = resolveHolder(env)
  } catch (e) {
    if (e.code === 'HOLDER_UNKNOWN') throw e
    throw notHolder(e.message)
  }
  const h = slot && slot.holder
  if (!h || h.pid !== me.pid || h.start !== me.start) throw notHolder(`generation ${generation} is held by pid ${h ? h.pid : 'unknown'}`)
  return slot
}

const validSlot = (slot, g) => slot && slot.generation === g && slot.holder
  && Number.isInteger(slot.holder.pid) && typeof slot.holder.start === 'string'

function openDispatches(paths, g) {
  const out = []
  for (const file of childFiles(paths, g)) {
    let rec
    try {
      rec = readJson(file)
    } catch {
      continue // stopChildren fails closed on it
    }
    if (rec && rec.kind === 'dispatch') out.push({ id: rec.id, label: rec.label, opened_at: rec.opened_at })
  }
  return out
}

// A newer generation than observed (the last one an acquire read; null for none): a reason
// to stop at once, or null. Slots that cannot be listed count as superseded, so a stop that
// cannot tell never goes on.
function superseded(paths, observed) {
  let m
  try {
    m = maxSlot(paths)
  } catch (e) {
    return `the slots cannot be listed: ${e.code || e.message}`
  }
  return m !== null && (observed === null || m > observed) ? `generation ${m} was taken meanwhile` : null
}

// Throws SUPERSEDED before a destructive step of a stop whose generation was overtaken.
function guardStep(guard) {
  const why = guard && superseded(guard.paths, guard.observed)
  if (why) throw Object.assign(new Error(`superseded: ${why}`), { code: 'SUPERSEDED' })
}

// Marks generation g closing (already marked is fine): from now on assertHeld refuses g, so
// a child that registers after this acquire listed g's children is removed again by its
// own registration.
function markClosing(paths, g, me) {
  fs.mkdirSync(slotsDir(paths), { recursive: true })
  createExclusive(closingFile(paths, g), { v: 1, generation: g, by: { pid: me.pid, start: me.start }, closed_at: now() })
}

export async function acquire(P, { env = process.env } = {}) {
  const base = loopPaths(P, { env })
  let me
  try {
    me = resolveHolder(env) // before ensureV, so a firing without a holder writes nothing
  } catch (e) {
    if (e.code !== 'HOLDER_UNKNOWN') throw e
    // This runner may well be alive: a transient refusal, like an unknown holder on record.
    let generation = null
    try {
      generation = maxSlot(base)
    } catch { /* null */ }
    return held('holder-unknown', generation, { holder: null, detail: e.message })
  }
  const paths = ensureV(base)
  let max = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    max = maxSlot(paths)
    const floor = ledgerFloor(paths.S)
    let previous = null, reclaimed = null, reclaim = null
    if (max !== null) {
      const released = fs.existsSync(releasedFile(paths, max))
      previous = { generation: max, released, reclaim: null }
      if (!released) {
        let slot
        try {
          slot = readJson(slotFile(paths, max))
        } catch (e) {
          return held('corrupt', max, { detail: e.message })
        }
        if (!validSlot(slot, max)) return held('corrupt', max, { detail: `slots/${max}.json is not a holder record` })
        const alive = isAlive(slot.holder)
        if (alive === null) return held('holder-unknown', max, { holder: slot.holder })
        const same = slot.holder.pid === me.pid && slot.holder.start === me.start
        if (alive && !same) return held('holder-live', max, { holder: slot.holder, session: slot.session ?? null, acquired_at: slot.acquired_at ?? null })
        // A background agent may outlive an interrupted in-session firing.
        if (same) {
          const dispatches = openDispatches(paths, max)
          if (dispatches.length) return held('dispatch-open', max, { dispatches })
        }
        reclaim = same ? 'same-process' : 'dead-holder'
      }
    }
    // With no slot on record, every child record is an orphan of lost slots, and its
    // generation existed: N exceeds it too, so no generation repeats. With slots, a child
    // above the last one read can only be a racer's, which N does not count.
    const gens = childGenerations(paths)
    const top = max ?? (gens.length ? gens[gens.length - 1] : 0)
    const N = Math.max(top, floor) + 1
    if (!validGeneration(N)) throw new Error(`bad-generation: ${N}`)
    // The children of every generation below N are stopped first: the reclaimed one's, those
    // of a generation released while they ran (an owner release stops nothing, and a holder
    // release may leave some lingering), and those left below N by any other window (lost
    // slots). Each generation is marked closing before its children are listed. A newer
    // generation appearing meanwhile was taken by a racer: the acquire stops at once.
    const stop = new Set(gens.filter(g => g < N))
    if (reclaim) stop.add(max) // closed even with no child on record yet
    const mine = [], others = [], left = []
    const stoppedSoFar = () => [...mine, ...others]
    for (const g of [...stop].sort((x, y) => x - y)) {
      const why = superseded(paths, max)
      if (why) return held('race', max, { detail: `superseded: ${why}`, stopped: stoppedSoFar() })
      markClosing(paths, g, me)
      const r = await stopChildren(paths, g, { observed: max })
      ;(reclaim && g === max ? mine : others).push(...r.stopped)
      if (r.superseded) return held('race', max, { detail: r.superseded, stopped: stoppedSoFar() })
      left.push(...r.alive)
    }
    if (left.length) return held('child-live', max, { alive: left, stopped: stoppedSoFar() })
    if (reclaim) {
      // Spec 16's sweep: a process the dead (or interrupted) firing never recorded, such as
      // a delegate's command, may still write in the work tree. It is reported, never signalled.
      const dirs = [path.join(paths.S, 'worktree'), paths.V]
      const sw = sweep(dirs)
      if (sw.state !== 'ok') return held('sweep-unknown', max, { detail: `cannot sweep ${dirs.join(' and ')} for live processes: ${sw.detail}`, stopped: stoppedSoFar() })
      if (sw.procs.length) {
        return held('child-live', max, {
          alive: [], procs: sw.procs, stopped: stoppedSoFar(),
          detail: `${sw.procs.length} process(es) outside this runner's ancestry still have their working directory in ${dirs.join(' or ')}; none was signalled`,
        })
      }
      previous.reclaim = reclaim
      reclaimed = { generation: max, how: reclaim, stopped: mine }
    }
    fs.mkdirSync(slotsDir(paths), { recursive: true })
    const record = { v: 1, generation: N, holder: me, session: env.CLAUDE_CODE_SESSION_ID || null, acquired_at: now(), previous }
    if (createExclusive(slotFile(paths, N), record)) {
      const out = { state: 'acquired', generation: N, V: paths.V, lockDir: paths.lockDir, previous, reclaimed }
      // Children of other generations that this acquire stopped (the reclaimed one's are in
      // reclaimed.stopped).
      if (others.length) out.stopped = others
      return out
    }
    // A racer took N first: read the lock again.
  }
  return held('race', max)
}

// Child processes. A proc record's group is ours while groupAlive(pgid) is true: POSIX never
// reuses a pid that is still a process group id. A live process under the leader's pid
// with another start token means the pid was reused, which happens only once our group was
// empty. Returns true | false | null, or undefined when the record never learned its group.
function groupState(rec) {
  if (rec.pgid === null || rec.pgid === undefined) return undefined
  // exec records its child as the leader of a group of its own (pid === pgid). Any other
  // shape, or an id that is not an integer above 1, cannot be verified: never signalled.
  if (!Number.isInteger(rec.pgid) || rec.pgid <= 1 || rec.pid !== rec.pgid) return null
  // A live leader is ours only when its start token matches the record; without a recorded
  // start, or with an unreadable token, the group cannot be verified and is never signalled.
  const t = startToken(rec.pid)
  if (t.state === 'unknown') return null
  if (t.state === 'live') {
    if (typeof rec.start !== 'string') return null
    if (t.token !== rec.start) return false
  }
  return groupAlive(rec.pgid)
}

async function stopGroup(rec, guard) {
  const g = groupState(rec)
  if (g !== true) return g
  guardStep(guard)
  return !(await killGroup(rec.pgid))
}

// SIGTERM to a wrapper that is alive by identity, then up to WRAPPER_WAIT_MS for it to go.
async function stopWrapper(wrapper, guard) {
  if (!wrapper) return false
  let alive = isAlive(wrapper)
  if (alive !== true) return alive
  guardStep(guard)
  try {
    process.kill(wrapper.pid, 'SIGTERM')
  } catch { /* gone meanwhile */ }
  const deadline = Date.now() + WRAPPER_WAIT_MS
  while ((alive = isAlive(wrapper)) === true && Date.now() < deadline) await sleep(POLL_MS)
  return alive
}

// null once the proc child is gone, else why it is not.
async function stopProc(file, rec, guard) {
  let group = await stopGroup(rec, guard)
  const wrapper = await stopWrapper(rec.wrapper, guard)
  if (group === undefined && wrapper === false) {
    // The wrapper is gone, so its last write is final: it may have learned its group.
    const last = readJson(file)
    if (!last) return null
    rec = last
    group = await stopGroup(last, guard)
  }
  if (wrapper !== false) return wrapper === null ? 'wrapper liveness unknown' : 'wrapper still running'
  // A gated command runs only once its group is on record, so a gated record whose wrapper
  // ended before recording the group ran nothing. Without the gate unknown is alive: a
  // wrapper that died between spawn and recording may have left a child.
  if (group === undefined) return rec.gated === true ? null : 'pending: the wrapper ended before it recorded its process group'
  if (group !== false) return group === null ? 'process group liveness unknown' : 'process group still running'
  return null
}

// A Codex child is quiesced only once its starter (the `loop-codex.mjs start` that recorded
// it, {pid, start, pgid}) is gone by identity and, when its pgid is an integer above 1, so
// is that process group: a starter still in the companion's task call, or the companion
// child of a starter that was killed, may launch its job after quiesce has listed the jobs.
// pgid null means unread (the starter alone is waited on); any other value cannot be
// verified, and unknown liveness blocks. Its last write is final, so the record is read again.
async function stopCodex(file, rec, guard) {
  if (rec.starter) {
    const s = rec.starter, pgid = s.pgid
    if (pgid !== undefined && pgid !== null && !(Number.isInteger(pgid) && pgid > 1)) {
      return `codex starter's process group ${JSON.stringify(pgid)} cannot be verified`
    }
    const state = () => {
      const alive = isAlive(s)
      if (alive !== false || pgid === undefined || pgid === null) return [alive, `codex starter pid ${s.pid}`]
      return [groupAlive(pgid), `codex starter's process group ${pgid}`]
    }
    let [alive, what] = state()
    const deadline = Date.now() + STARTER_WAIT_MS
    while (alive === true && Date.now() < deadline) {
      await sleep(POLL_MS)
      ;[alive, what] = state()
    }
    if (alive !== false) return alive === null ? `${what}: liveness unknown` : `${what} still running`
    rec = readJson(file)
    if (!rec) return null // removed meanwhile by another reclaim
  }
  if (typeof rec.cwd !== 'string' || !rec.cwd) return 'codex record without cwd'
  guardStep(guard)
  const q = await quiesce(rec.cwd, typeof rec.jobId === 'string' ? rec.jobId : undefined)
  return q.quiet ? null : `codex not quiet: ${q.detail}`
}

const FACTS = ['label', 'id', 'jobId', 'pid', 'pgid']
function summary(name, rec) {
  const out = { file: name, kind: rec.kind ?? null }
  for (const k of FACTS) if (rec[k] !== undefined) out[k] = rec[k]
  return out
}

// A dispatch is an agent inside its holder's process, so it can run only while that process
// does. Its record goes once the holder is gone, or once the owner released the generation
// (the owner vouched that its firing is not running); otherwise it stays.
function dispatchesGone(paths, g) {
  try {
    const rel = readJson(releasedFile(paths, g))
    if (rel && rel.by === 'owner') return true
    const slot = readJson(slotFile(paths, g))
    return Boolean(validSlot(slot, g)) && isAlive(slot.holder) === false
  } catch {
    return false
  }
}

// Stops every child of generation g and removes the records of those proven gone.
// Anything that cannot be proven gone, including an unreadable record, is in `alive`.
// observed is the last generation the caller read (default: g itself, for its holder's
// release): before each signal, quiesce and record removal the slots are read again, and a
// newer generation ends the stop at once with `superseded` set to why.
export async function stopChildren(paths, generation, { observed = generation } = {}) {
  const guard = { paths, observed }
  const stopped = [], alive = []
  let gone = null
  try {
    for (const file of childFiles(paths, generation)) {
      const name = path.basename(file)
      let rec
      try {
        rec = readJson(file)
      } catch {
        alive.push({ file: name, kind: null, detail: 'unreadable record' })
        continue
      }
      if (!rec) continue // its wrapper removed it meanwhile
      let left
      try {
        if (rec.kind === 'proc') left = await stopProc(file, rec, guard)
        else if (rec.kind === 'codex') {
          left = await stopCodex(file, rec, guard)
          rec = readJson(file) ?? rec // the facts it ended with, such as the job id
        }
        else if (rec.kind === 'dispatch') {
          gone ??= dispatchesGone(paths, generation)
          left = gone ? null : 'an agent of this generation may still be running: its holder is alive or unknown'
        }
        else left = `unknown kind ${JSON.stringify(rec.kind)}`
      } catch (e) {
        if (e.code === 'SUPERSEDED') throw e
        left = e.message
      }
      if (left) {
        alive.push({ ...summary(name, rec), detail: left })
      } else {
        guardStep(guard)
        fs.rmSync(file, { force: true })
        stopped.push(summary(name, rec))
      }
    }
  } catch (e) {
    if (e.code !== 'SUPERSEDED') throw e
    return { stopped, alive, superseded: e.message }
  }
  return { stopped, alive }
}

function terminalIo() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: text => process.stderr.write(`${text}\n`),
    ask: async question => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await rl.question(question)
      } finally {
        rl.close()
      }
    },
  }
}

// The holder's release: refused while a dispatch of its generation is open (an agent may
// still run; nothing is stopped or written), else stop its generation's children (anything
// left is a bug, reported in `lingering`; the next acquire stops it), then write the release
// record. The owner form kills nothing.
export async function release(P, generation, { env = process.env, owner = false, io = terminalIo() } = {}) {
  if (owner) return ownerRelease(P, generation, env, io)
  const paths = openPaths(P, env)
  assertHeld(paths, generation, env)
  const dispatches = openDispatches(paths, generation)
  if (dispatches.length) {
    const e = new Error(`dispatch-open: ${dispatches.length} dispatch record(s) of generation ${generation} are open; close each once its result has arrived, then release`)
    Object.assign(e, { code: 'DISPATCH_OPEN', generation, dispatches })
    throw e
  }
  const { stopped, alive, superseded: lost } = await stopChildren(paths, generation)
  if (lost) throw notHolder(`generation ${generation} was taken over while its children were stopped (${lost})`)
  if (!createExclusive(releasedFile(paths, generation), { v: 1, generation, by: 'holder', released_at: now() })) {
    throw notHolder(`generation ${generation} was released meanwhile`)
  }
  return { state: 'released', generation, by: 'holder', stopped, lingering: alive }
}

async function ownerRelease(P, generation, env, io) {
  if (!io || io.isTTY !== true) {
    throw new Error('needs-terminal: an owner release runs only in the owner\'s own terminal (stdin and stdout a TTY); nothing was written')
  }
  if (!validGeneration(generation)) throw new Error(`bad generation ${generation}`)
  const st = status(P, { env })
  io.print(JSON.stringify(st, null, 2))
  if (st.generation !== generation || st.released) {
    throw new Error(`not-current: generation ${generation} is not the held generation (last ${st.generation}${st.released ? ', released' : ''})`)
  }
  if (st.holder_alive !== false) {
    io.print(`warning: holder pid ${st.holder ? st.holder.pid : '?'} may still be running; release only if that firing is not running (for example an interrupted turn in an open session)`)
  }
  const open = st.children.filter(c => c.generation === generation && c.alive !== false)
  if (open.length) io.print(`note: ${open.length} child record(s) of generation ${generation} remain; an owner release stops none of them, and the next acquire stops them before it takes the lock`)
  const paths = openPaths(P, env)
  const list = recs => recs.map(d => `${d.file} (${d.detail})`).join(', ')
  const doomed = unstoppable(paths, generation)
  if (doomed.length) io.print(`note: the release also discards ${doomed.length} child record(s) that no acquire can stop, and signals nothing: ${list(doomed)}`)
  const answer = String((await io.ask(`Type ${generation} to release generation ${generation}: `)) ?? '').trim()
  if (answer !== String(generation)) throw new Error(`not-confirmed: typed ${JSON.stringify(answer)}, not ${generation}; nothing was written`)
  if (maxSlot(paths) !== generation) throw new Error(`not-current: generation ${generation} is no longer the last generation`)
  if (!createExclusive(releasedFile(paths, generation), { v: 1, generation, by: 'owner', released_at: now() })) {
    throw new Error(`already-released: generation ${generation}`)
  }
  // Records no acquire can ever stop would hold every later acquire: the owner, having
  // confirmed, has them discarded (listed again, as they are now). Nothing is signalled.
  const discarded = []
  for (const d of unstoppable(paths, generation)) {
    fs.rmSync(d.path, { force: true })
    discarded.push({ file: d.file, detail: d.detail })
  }
  if (discarded.length) io.print(`discarded ${discarded.length} child record(s): ${list(discarded)}`)
  return { state: 'released', generation, by: 'owner', discarded }
}

// The child records of generations up to g that no acquire can ever stop: unreadable ones
// and those of a kind it does not know. [{file, path, detail}]
function unstoppable(paths, g) {
  const out = []
  for (const gen of childGenerations(paths).filter(x => x <= g)) {
    for (const file of childFiles(paths, gen)) {
      let detail
      try {
        const rec = readJson(file)
        if (!rec || KINDS.includes(rec.kind)) continue
        detail = `unknown kind ${JSON.stringify(rec.kind)}`
      } catch {
        detail = 'unreadable record'
      }
      out.push({ file: path.basename(file), path: file, detail })
    }
  }
  return out
}

function describeChild(file) {
  const name = path.basename(file)
  let rec
  try {
    rec = readJson(file)
  } catch {
    return { file: name, kind: null, generation: null, alive: null, detail: 'unreadable record' }
  }
  if (!rec) return { file: name, kind: null, generation: null, alive: false, detail: 'removed' }
  const facts = { ...summary(name, rec), generation: rec.generation ?? null }
  if (rec.kind !== 'proc') return { ...facts, alive: null }
  const g = groupState(rec), w = rec.wrapper ? isAlive(rec.wrapper) : false
  return { ...facts, alive: g === true || w === true ? true : g === false && w === false ? false : null }
}

// Read-only: the last generation, its holder and liveness, the ledger floor, and every
// child record with its liveness (null where only stopping it could tell).
export function status(P, { env = process.env } = {}) {
  const paths = openPaths(P, env)
  const generation = maxSlot(paths)
  const out = {
    V: paths.V, lockDir: paths.lockDir, generation, released: null, released_by: null, closing: null, holder: null,
    holder_alive: null, mine: null, session: null, acquired_at: null, floor: ledgerFloor(paths.S), children: [],
  }
  if (generation !== null) {
    out.released = fs.existsSync(releasedFile(paths, generation))
    out.closing = fs.existsSync(closingFile(paths, generation))
    try {
      const rel = readJson(releasedFile(paths, generation))
      out.released_by = rel ? rel.by ?? null : null
      const slot = readJson(slotFile(paths, generation))
      if (!validSlot(slot, generation)) throw new Error(`corrupt: slots/${generation}.json is not a holder record`)
      Object.assign(out, { holder: slot.holder, holder_alive: isAlive(slot.holder), session: slot.session ?? null, acquired_at: slot.acquired_at ?? null })
      try {
        const me = resolveHolder(env)
        out.mine = me.pid === slot.holder.pid && me.start === slot.holder.start
      } catch { /* no holder in this environment: mine stays null */ }
    } catch (e) {
      out.corrupt = e.message
    }
  }
  out.children = listDir(childrenDir(paths)).filter(n => /^[1-9]\d*-.+\.json$/.test(n)).sort()
    .map(n => describeChild(path.join(childrenDir(paths), n)))
  return out
}

// A new child record named <N>-<kind>-<16 hex>.json, created exclusively.
function newChild(paths, generation, kind, make) {
  fs.mkdirSync(childrenDir(paths), { recursive: true })
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomBytes(8).toString('hex')
    const file = path.join(childrenDir(paths), `${generation}-${kind}-${id}.json`)
    if (createExclusive(file, make(id))) return { id, file }
  }
  throw new Error(`cannot create a ${kind} record`)
}

// A child record of the holder's generation, checked again once it exists: a reclaim or a
// release that listed the children just before it was created has not seen it, so the
// generation must still be held after it is on record. Removed again when it is not.
function newHeldChild(paths, generation, env, kind, make) {
  assertHeld(paths, generation, env)
  const child = newChild(paths, generation, kind, make)
  try {
    assertHeld(paths, generation, env)
  } catch (e) {
    fs.rmSync(child.file, { force: true })
    throw e
  }
  return child
}

// An in-process Agent or Workflow dispatch of the holder's generation; it has no pid.
export function openDispatch(P, generation, label, { env = process.env } = {}) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('bad-label: a dispatch needs a label')
  const paths = openPaths(P, env)
  return newHeldChild(paths, generation, env, 'dispatch', id => ({ v: 1, kind: 'dispatch', generation, id, label, opened_at: now() })).id
}

export function closeDispatch(P, generation, id, { env = process.env } = {}) {
  if (typeof id !== 'string' || !CHILD_ID.test(id)) throw new Error(`bad-id: ${JSON.stringify(id)}`)
  const paths = openPaths(P, env)
  assertHeld(paths, generation, env)
  const file = path.join(childrenDir(paths), `${generation}-dispatch-${id}.json`)
  const rec = readJson(file)
  if (!rec || rec.kind !== 'dispatch' || rec.id !== id) throw new Error(`no-dispatch: ${id} is not open in generation ${generation}`)
  fs.rmSync(file, { force: true })
  return { closed: true }
}

// Registers a Codex job in cwd before it is launched; setCodexJob adds its id afterwards.
// The record names its starter {pid, start, pgid}, by default the calling process, which
// launches the job: a reclaim waits for the starter, and for its process group (pgid null
// when unreadable), to be gone before it quiesces cwd. null: no starter.
export function registerCodex(P, generation, cwd, { env = process.env, starter = 'self' } = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('bad-cwd: a Codex record needs its cwd')
  const paths = openPaths(P, env)
  let who = starter
  if (who === 'self') {
    const t = startToken(process.pid)
    if (t.state !== 'live') throw new Error(`no-identity: the starter cannot read its own start token (${t.detail || t.state})`)
    who = { pid: process.pid, start: t.token, pgid: processGroup(process.pid) }
  }
  const abs = path.resolve(cwd)
  return newHeldChild(paths, generation, env, 'codex', () => ({ v: 1, kind: 'codex', generation, cwd: abs, jobId: null, starter: who })).file
}

export function setCodexJob(file, jobId) {
  const rec = readJson(file)
  if (!rec || rec.kind !== 'codex') throw new Error(`not-a-codex-record: ${file}`)
  writeReplace(file, { ...rec, jobId })
}

// LOOP.md's verify: list as YAML reads it: a block sequence under the front matter's
// top-level `verify:` key whose items all start at one indentation with "- ", each item a
// plain, single-quoted or double-quoted scalar on one line, with comments and blank lines
// dropped; a top-level key ends it. Every other shape is refused rather than guessed (a
// more-indented "- ", a sibling at another indentation, a continuation line, anything else
// before the next key: `unsupported verify: syntax at line N`), so exec never runs text
// other than the command the owner reads in the file.
const TOP_KEY = /^(?:[^\s#\-?:,[\]{}&*!|>%@`'"][^:]*|"[^"]*"|'[^']*')\s*:(?:\s|$)/
export function verifyCommands(text) {
  const lines = String(text).split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('bad-loop-md: LOOP.md has no front matter')
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l))
  if (end < 0) throw new Error('bad-loop-md: the front matter is not closed')
  const keys = lines.slice(0, end).flatMap((l, i) => /^verify\s*:/.test(l) ? [i] : [])
  if (!keys.length) throw new Error('no-verify: the front matter has no verify: key')
  if (keys.length > 1) throw new Error(`bad-verify: verify: appears ${keys.length} times`)
  const at = keys[0]
  if (!/^verify\s*:\s*(#.*)?$/.test(lines[at])) throw new Error(`bad-verify: line ${at + 1}: verify: must be a block list of "  - <command>" lines`)
  const out = []
  let indent = null
  const unsupported = (n, why) => new Error(`bad-verify: unsupported verify: syntax at line ${n} (${why})`)
  for (let i = at + 1; i < end; i++) {
    const line = lines[i]
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^( *)-(?:[ \t]+(.*))?$/.exec(line)
    if (item && (indent === null || item[1].length === indent)) {
      indent = item[1].length
      out.push(verifyItem(item[2] ?? '', i + 1))
    } else if (item) {
      throw unsupported(i + 1, `a "- " ${item[1].length > indent ? 'more' : 'less'} indented than the items above it`)
    } else if (TOP_KEY.test(line)) {
      break // the next top-level key
    } else {
      throw unsupported(i + 1, /^\s/.test(line) ? 'a continuation line or other text inside the list' : 'a line that is neither an item nor a key')
    }
  }
  return out
}

function verifyItem(s, n) {
  const bad = why => new Error(`bad-verify: line ${n}: ${why}`)
  const tail = rest => {
    if (!/^\s*(#.*)?$/.test(rest)) throw bad('text after the closing quote')
  }
  let v
  if (s.startsWith('"')) {
    let i = 1
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
    if (i >= s.length) throw bad('unterminated double-quoted command')
    tail(s.slice(i + 1))
    // YAML and JSON share \" \\ \/ \b \f \n \r \t \u; any other escape is refused.
    try {
      v = JSON.parse(s.slice(0, i + 1))
    } catch {
      throw bad('an escape JSON does not share with YAML; use single quotes')
    }
  } else if (s.startsWith("'")) {
    let i = 1
    v = ''
    for (;;) {
      if (i >= s.length) throw bad('unterminated single-quoted command')
      if (s[i] === "'") {
        if (s[i + 1] !== "'") break
        v += "'"
        i += 2
      } else {
        v += s[i++]
      }
    }
    tail(s.slice(i + 1))
  } else {
    v = s.replace(/(^|\s)#.*$/, '').trim()
    if (/^[-?:](\s|$)|^[[\]{},&*!|>%@`]/.test(v)) throw bad('a YAML indicator starts the command; quote it')
    if (/:(\s|$)/.test(v)) throw bad('": " makes the item a mapping; quote the command')
  }
  if (!v.trim()) throw bad('empty command')
  return v
}

function verifyCommand(S, k) {
  const file = path.join(S, 'LOOP.md')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`no-loop-md: ${file}: ${e.code || e.message}`)
  }
  const list = verifyCommands(text)
  if (k >= list.length) throw new Error(`bad-verify: LOOP.md lists ${list.length} verify command(s), so there is no item ${k}`)
  return list[k]
}

const EXEC_USAGE = 'usage: loop-lock.mjs exec <P> --generation <N> --label <L> --cwd <dir> [--timeout-ms <T>] (--verify <K> | -- <argv>...)'
const EXEC_FLAGS = ['generation', 'label', 'cwd', 'timeout-ms', 'verify']

// Everything after the first `--` is the command, untouched; null on misuse.
function parseExecArgs(argv) {
  const cut = argv.indexOf('--')
  const head = cut < 0 ? argv : argv.slice(0, cut)
  const command = cut < 0 ? null : argv.slice(cut + 1)
  const opts = {}, pos = []
  for (let i = 0; i < head.length; i++) {
    const a = head[i]
    if (!a.startsWith('--')) {
      pos.push(a)
      continue
    }
    const k = a.slice(2)
    if (!EXEC_FLAGS.includes(k) || k in opts || i + 1 >= head.length) return null
    opts[k] = head[++i]
  }
  if (pos.length !== 1 || [opts.generation, opts.label, opts.cwd].includes(undefined)) return null
  if (!GENERATION.test(opts.generation) || !validGeneration(Number(opts.generation)) || !opts.label.trim() || !opts.cwd) return null
  if ((opts.verify === undefined) === (command === null) || (command && !command.length)) return null
  if (opts.verify !== undefined && !(/^(0|[1-9]\d*)$/.test(opts.verify) && Number.isSafeInteger(Number(opts.verify)))) return null
  const t = opts['timeout-ms']
  if (t !== undefined && !(GENERATION.test(t) && Number(t) <= MAX_TIMEOUT_MS)) return null
  return {
    P: pos[0], generation: Number(opts.generation), label: opts.label, cwd: opts.cwd,
    timeoutMs: t === undefined ? null : Number(t), verify: opts.verify === undefined ? null : Number(opts.verify), argv: command,
  }
}

// Why the holder of generation N no longer holds it, or null while it does. slot is the
// holder record the run started under: a slot of N with another holder or another
// acquired_at (a <V> wiped and N taken again) is not the run's. Unknown holder liveness, and
// a slot that cannot be read just now, count as held, so a failing ps never ends a verify run.
function lostHold(paths, generation, slot) {
  let max, released, cur
  try {
    max = maxSlot(paths)
    released = fs.existsSync(releasedFile(paths, generation))
    cur = max === generation ? readJson(slotFile(paths, generation)) : null
  } catch {
    return null
  }
  if (max !== generation) {
    return { state: 'not-holder', exit: 125, detail: max === null ? `the lock no longer has generation ${generation}` : `generation ${max} replaced ${generation}` }
  }
  if (released) return { state: 'not-holder', exit: 125, detail: `generation ${generation} was released` }
  const was = slot.holder, h = cur && cur.holder
  if (cur && (!h || h.pid !== was.pid || h.start !== was.start || cur.acquired_at !== slot.acquired_at)) {
    return { state: 'not-holder', exit: 125, detail: `generation ${generation} is now held by pid ${h ? h.pid : 'unknown'}, acquired ${cur.acquired_at}` }
  }
  if (isAlive(was) === false) return { state: 'holder-gone', exit: 125, detail: `holder pid ${was.pid} is gone` }
  return null
}

const signalExit = sig => 128 + (os.constants.signals[sig] ?? 0)

// Why name cannot be executed as execvp would look it up ('ENOENT' | 'EACCES'), or null.
// The gate's shell runs the command with exec, so a command that cannot start is reported
// here, with the exit code spawn would have given (127, 126), rather than by the shell.
function cannotExecute(name, env, cwd) {
  const candidates = name.includes('/') ? [path.resolve(cwd, name)]
    : String(env.PATH ?? '/usr/bin:/bin').split(':').map(d => path.resolve(cwd, d || '.', name))
  let denied = false
  for (const f of candidates) {
    try {
      if (!fs.statSync(f).isFile()) continue
      fs.accessSync(f, fs.constants.X_OK)
      return null
    } catch (e) {
      if (e.code === 'EACCES') denied = true
    }
  }
  return denied ? 'EACCES' : 'ENOENT'
}

// A run whose cleanup failed: something it started may still run, so it never reads as the
// command's own result, which stays in outcome.
const lingering = (outcome, facts) => ({ state: 'lingering', exit: EXIT_LINGERING, outcome, ...facts })

// Registers, starts and supervises one exec child; resolves {state, exit, ...facts}. The
// record exists before the child does and is removed only once its group is gone, so a
// firing that dies at any point leaves the next acquire a record to stop the group by.
async function superviseChild(paths, slot, pending, timeoutMs, env) {
  const generation = pending.generation
  let child = null, file = null, finished = false, outcome = null, killing = null, timer = null, poll = null
  let giveUp
  const abandoned = new Promise(resolve => { giveUp = resolve })
  const started = () => child !== null && Number.isInteger(child.pid)
  // The first outcome wins, and the group is killed once.
  const stop = o => {
    if (finished) return
    if (!outcome) outcome = o
    if (started() && !killing) {
      killing = killGroup(child.pid).then(ok => {
        if (!ok) giveUp(null)
        return ok
      })
    }
  }
  const onSignal = sig => stop({ state: 'interrupted', exit: signalExit(sig), signal: sig })
  for (const s of EXEC_SIGNALS) process.on(s, onSignal)
  try {
    // A reclaim that listed the children just before the record existed has not seen it:
    // the hold is checked again once the record is on disk, and the record removed if lost.
    try {
      file = newHeldChild(paths, generation, env, 'proc', () => pending).file
    } catch (e) {
      if (e.code !== 'NOT_HOLDER') throw e // holder-unknown and setup errors: exit 2
      return { state: 'not-holder', exit: 125, detail: e.message, ...(e.reason ? { reason: e.reason } : {}) }
    }
    const why = cannotExecute(pending.command[0], env, pending.cwd)
    if (why) {
      fs.rmSync(file, { force: true })
      return { state: 'error', exit: why === 'ENOENT' ? 127 : 126, detail: `cannot start ${pending.command[0]}: ${why}` }
    }
    child = spawn('/bin/sh', ['-c', GATE, 'loop-lock-gate', ...pending.command], {
      cwd: pending.cwd, detached: true, stdio: ['pipe', 'inherit', 'inherit'], env: { ...env, TECH_LEAD_FIRING: String(generation) },
    })
    child.stdin.on('error', () => {}) // a gate already ended: its exit is reported below
    const exited = new Promise(resolve => {
      child.once('exit', (code, signal) => {
        finished = true
        resolve({ code, signal })
      })
      child.once('error', error => {
        finished = true
        resolve({ error })
      })
    })
    if (!started()) {
      const r = await exited
      fs.rmSync(file, { force: true })
      const why = r.error ? r.error.code || r.error.message : 'no pid'
      return { state: 'error', exit: r.error && r.error.code === 'ENOENT' ? 127 : 126, detail: `cannot start ${pending.command[0]}: ${why}` }
    }
    // detached: the child leads a new session, so its pid is its process group id. One write
    // puts the group on record, and only then does the gate let the command start.
    const pid = child.pid
    const token = startToken(pid)
    writeReplace(file, { ...pending, pid, pgid: pid, start: token.state === 'live' ? token.token : null })
    if (outcome) stop(outcome) // a signal came before the group was on record: never start it
    else child.stdin.end('go\n')
    if (timeoutMs !== null) timer = setTimeout(() => stop({ state: 'timeout', exit: 124, detail: `still running after ${timeoutMs} ms` }), timeoutMs)
    poll = setInterval(() => {
      const lost = lostHold(paths, generation, slot)
      if (lost) stop(lost)
    }, EXEC_POLL_MS)
    const r = await Promise.race([exited, abandoned])
    if (!r) return lingering(outcome, { left: `process group ${pid} survived SIGKILL; its record stays` })
    if (killing) await killing
    // Grandchildren still in the group after the command ended are killed with it.
    let grandchildren = false, alive = groupAlive(pid)
    if (alive === true) {
      grandchildren = outcome === null
      alive = !(await killGroup(pid))
    }
    const result = outcome
      ? { ...outcome }
      : r.code !== null ? { state: 'exited', exit: r.code } : { state: 'signalled', exit: signalExit(r.signal), signal: r.signal }
    if (grandchildren) result.lingering = true
    if (alive !== false) {
      return lingering(result, { left: alive === null ? `the liveness of process group ${pid} cannot be read; its record stays` : `process group ${pid} is still running; its record stays` })
    }
    fs.rmSync(file, { force: true })
    // Spec 16's sweep: a process that left the group (a daemon in a session of its own) is
    // not ours to signal, but a run that leaves one behind in <dir> did not end cleanly.
    const sw = sweep([pending.cwd])
    if (sw.state !== 'ok') return lingering(result, { left: `the sweep of ${pending.cwd} for processes left behind could not run: ${sw.detail}` })
    if (sw.procs.length) {
      return lingering(result, { left: `${sw.procs.length} process(es) outside the group still run in ${pending.cwd}; none was signalled`, alive: sw.procs })
    }
    return result
  } catch (e) {
    // A failed record write: stop the group if one was started; its record stays while
    // anything in the group may still run.
    if (started() && groupAlive(child.pid) !== false && !(await killGroup(child.pid))) {
      return lingering({ state: 'error', exit: 2, detail: e.message }, { left: `process group ${child.pid} may still be running; its record stays` })
    }
    if (file) fs.rmSync(file, { force: true })
    return { state: 'error', exit: 2, detail: e.message }
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    for (const s of EXEC_SIGNALS) process.off(s, onSignal)
  }
}

// The status line is written synchronously to fd 2, after everything the command wrote,
// and on a line of its own even when the command's last line had no newline.
function execReport(o) {
  const line = Buffer.from(`\nloop-lock exec: ${JSON.stringify(o)}\n`)
  for (let off = 0, tries = 0; off < line.length && tries < 1000; tries++) {
    try {
      off += fs.writeSync(2, line, off)
    } catch (e) {
      if (e.code !== 'EAGAIN') break
    }
  }
  return o.exit
}

async function execMain(argv, env = process.env) {
  const a = parseExecArgs(argv)
  if (!a) return execReport({ state: 'error', exit: 2, detail: EXEC_USAGE })
  const tag = { generation: a.generation, label: a.label }
  const report = ({ state, exit, ...facts }) => execReport({ state, exit, ...tag, ...facts })
  let paths, slot, pending
  try {
    paths = openPaths(a.P, env)
    slot = assertHeld(paths, a.generation, env)
  } catch (e) {
    // holder-unknown (the holder's token cannot be read) is an error, never a lost hold.
    return report(e.code === 'NOT_HOLDER'
      ? { state: 'not-holder', exit: 125, detail: e.message, ...(e.reason ? { reason: e.reason } : {}) }
      : { state: 'error', exit: 2, detail: e.message })
  }
  try {
    const command = a.verify === null ? a.argv : ['/bin/sh', '-c', verifyCommand(paths.S, a.verify)]
    const cwd = path.resolve(a.cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`bad-cwd: ${cwd} is not a directory`)
    const me = startToken(process.pid)
    if (me.state !== 'live') throw new Error(`no-identity: the wrapper cannot read its own start token (${me.detail || me.state})`)
    pending = { v: 1, kind: 'proc', generation: a.generation, label: a.label, cwd, command, wrapper: { pid: process.pid, start: me.token }, pid: null, pgid: null, start: null, gated: true }
  } catch (e) {
    return report({ state: 'error', exit: 2, detail: e.message })
  }
  return report(await superviseChild(paths, slot, pending, a.timeoutMs, env))
}

const USAGE = 'usage: loop-lock.mjs acquire <P> | release <P> --generation <N> [--owner] | dispatch open <P> --generation <N> --label <L> | dispatch close <P> --generation <N> --id <ID> | status <P> | exec <P> --generation <N> --label <L> --cwd <dir> [--timeout-ms <T>] (--verify <K> | -- <argv>...)'

// Each command: the value flags it requires, its boolean flags, and run(args) -> [exit, output].
const COMMANDS = {
  acquire: { run: async ({ P }) => {
    const r = await acquire(P)
    return [r.state === 'acquired' ? 0 : 3, r]
  } },
  release: { flags: ['generation'], bools: ['owner'], run: async ({ P, generation, owner }) => [0, await release(P, generation, { owner: Boolean(owner) })] },
  'dispatch open': { flags: ['generation', 'label'], run: ({ P, generation, label }) => [0, { id: openDispatch(P, generation, label) }] },
  'dispatch close': { flags: ['generation', 'id'], run: ({ P, generation, id }) => [0, closeDispatch(P, generation, id)] },
  status: { run: ({ P }) => [0, status(P)] },
}

// Exactly one positional <P>, every required flag once, nothing unknown; null on misuse.
function parseArgs(argv, { flags = [], bools = [] }) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) pos.push(a)
    else if (bools.includes(a.slice(2)) && !(a.slice(2) in opts)) opts[a.slice(2)] = true
    else if (flags.includes(a.slice(2)) && !(a.slice(2) in opts) && i + 1 < argv.length) opts[a.slice(2)] = argv[++i]
    else return null
  }
  if (pos.length !== 1 || flags.some(k => opts[k] === undefined)) return null
  if ('generation' in opts) {
    if (!GENERATION.test(opts.generation) || !validGeneration(Number(opts.generation))) return null
    opts.generation = Number(opts.generation)
  }
  if ('id' in opts && !CHILD_ID.test(opts.id)) return null
  if ('label' in opts && !opts.label.trim()) return null
  return { P: pos[0], ...opts }
}

async function main(argv) {
  if (argv[0] === 'exec') return execMain(argv.slice(1))
  const print = o => process.stdout.write(`${JSON.stringify(o)}\n`)
  const dispatch = argv[0] === 'dispatch'
  const name = dispatch ? `dispatch ${argv[1]}` : argv[0]
  const cmd = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null
  const args = cmd && parseArgs(argv.slice(dispatch ? 2 : 1), cmd)
  if (!args) {
    print({ state: 'error', detail: USAGE })
    return 2
  }
  try {
    const [code, out] = await cmd.run(args)
    print(out)
    return code
  } catch (e) {
    if (e.code === 'NOT_HOLDER') {
      print({ state: 'not-holder', detail: e.message, ...(e.reason ? { reason: e.reason } : {}) })
      return 3
    }
    if (e.code === 'DISPATCH_OPEN') {
      print({ state: 'dispatch-open', generation: e.generation, dispatches: e.dispatches, detail: e.message })
      return 3
    }
    print({ state: 'error', detail: e.message })
    return 2
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
