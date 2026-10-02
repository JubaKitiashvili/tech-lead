#!/usr/bin/env node
// scripts/loop-codex.mjs
// The loop's L3 Codex task (loop §5) as a Codex companion job: started in the
// background, waited on in foreground calls, and ended by `quiesce`, which proves no
// Codex process can still write into the worktree. Every call prints one JSON line.
//   start --cwd <W> --prompt-file <brief> --cap-min <n> [--project <P> --generation <N>]
//                                  {"state":"started","jobId":…}
//                                  exit 3 {"state":"unavailable","detail":…}
//                                  exit 4 {"state":"not-holder","detail":...}: nothing launched, or
//                                  {"state":"not-holder","jobId":...,"quiet":bool,"detail":...}: the
//                                  generation was lost while the job launched, which was quiesced
//     The companion runs in <W> (as its working directory and with --cwd <W>), so a sweep
//     for processes inside <W> sees it. With --project and --generation the job is a child
//     of the firing lock's generation N (scripts/loop-lock.mjs): registered before it is
//     launched, so a firing that dies at any point leaves the next acquire a record to
//     quiesce <W> by; its starter is this process ({pid, start, pgid}: a reclaim waits for
//     it and for its process group, in which the companion runs); given its job id once the
//     companion returns it; and the generation is checked again before `started` is
//     printed. No watchdog process is started.
//   wait <jobId> --cwd <W> --cap-min <n>
//                                  {"state":"running"|"cap"|"completed"|"failed"|"cancelled"|"error",…}
//   result <jobId> --cwd <W>       {"answer":…,"trailer":{…}|null,"flagged":bool}
//                                  exit 1 {"state":"error","detail":…}
//   quiesce --cwd <W> [--job <id>] {"quiet":bool,"final":<status of --job>|null,"detail":…}
// The companion is the newest installed
// ~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs;
// TECH_LEAD_CODEX_COMPANION names another one (the tests use a fake). quiesce keeps a record
// of the Codex job processes it has signalled but not yet seen gone, per <W>, under
// <TECH_LEAD_CACHE or ~/.cache>/tech-lead/codex-quiesce/.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
// A static import: loop-lock.mjs imports quiesce from here, and a dynamic import back into
// a module whose top-level await is still pending would never settle.
import { assertHeld, openPaths, registerCodex, setCodexJob } from './loop-lock.mjs'
import { readJson, writeReplace } from './lib/atomic.mjs'
import { commandLine, groupAlive, startToken } from './lib/loop-proc.mjs'

const ACTIVE = new Set(['queued', 'running'])
const ENDED = new Set(['completed', 'failed', 'cancelled'])
const WAIT_SLICE_MS = 540000 // one wait call stays under the Bash tool's 600000 ms limit
const MAX_CAP_MIN = 1440
const GENERATION = /^[1-9]\d*$/
const SESSION_ENV = 'CODEX_COMPANION_SESSION_ID'
const GONE_WAIT_MS = 5000
const POLL_MS = 100
const PS_TIMEOUT_MS = 10000

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

export function locateCompanion(env = process.env, home = os.homedir()) {
  if (env.TECH_LEAD_CODEX_COMPANION) {
    return fs.existsSync(env.TECH_LEAD_CODEX_COMPANION) ? env.TECH_LEAD_CODEX_COMPANION : null
  }
  const dir = path.join(home, '.claude/plugins/cache/openai-codex/codex')
  let versions
  try {
    versions = fs.readdirSync(dir).filter(v => /^\d+(\.\d+)*$/.test(v))
  } catch {
    return null
  }
  return versions.sort(compareVersions).reverse()
    .map(v => path.join(dir, v, 'scripts', 'codex-companion.mjs'))
    .find(p => fs.existsSync(p)) || null
}

export function waitState(job, capMin, nowMs) {
  const started = Date.parse(job.startedAt || job.createdAt)
  const elapsedMs = Number.isFinite(started) ? nowMs - started : null
  const elapsedMin = elapsedMs === null ? null : Math.floor(elapsedMs / 60000)
  if (ENDED.has(job.status)) return { state: job.status, elapsedMin }
  if (!ACTIVE.has(job.status) || elapsedMs === null) {
    return { state: 'error', elapsedMin, detail: `unexpected job status ${job.status}` }
  }
  return { state: elapsedMs >= capMin * 60000 ? 'cap' : 'running', elapsedMin }
}

export function parseTrailer(answer) {
  const lines = String(answer).split('\n').map(l => l.trim()).filter(Boolean)
  const judgment = /^JUDGMENT CALLS:\s*(.*)$/.exec(lines[lines.length - 2] || '')
  const skipped = /^SKIPPED:\s*(.*)$/.exec(lines[lines.length - 1] || '')
  if (!judgment || !skipped) return { trailer: null, flagged: true }
  const trailer = { judgmentCalls: judgment[1], skipped: skipped[1] }
  return { trailer, flagged: !(trailer.judgmentCalls === 'none' && trailer.skipped === 'none') }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Only integers above 1 name a process that may be signalled: the companion's cancel and its
// terminateProcessTree send SIGTERM to -pid, and -0 is the caller's own process group, -1
// every process the caller may signal; pid 1 is init. null or a missing pid: not started yet.
const validPid = pid => Number.isInteger(pid) && pid > 1
const notStarted = pid => pid === null || pid === undefined

// A process the companion's state names is gone once its pid and the process group it led
// are both gone. Unknown group liveness counts as alive.
const leftAlive = pid => processAlive(pid) || groupAlive(pid) !== false

// targets: [{what, pid}]. Waits up to timeoutMs for every target to be gone; returns those left.
async function waitGone(targets, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let alive = targets.filter(x => leftAlive(x.pid))
  while (alive.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    alive = alive.filter(x => leftAlive(x.pid))
  }
  return alive
}

function companion(args, { env = process.env, cwd } = {}) {
  const c = locateCompanion()
  if (!c) throw new Error('Codex companion not found')
  const out = execFileSync(process.execPath, [c, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: WAIT_SLICE_MS + 30000, env, cwd,
  })
  return JSON.parse(out.slice(out.indexOf('{')))
}

// A status read, retried once: the companion's state file can be caught half-written.
function readJob(jobId, cwd) {
  try {
    return companion(['status', jobId, '--cwd', cwd, '--json']).job
  } catch {
    return companion(['status', jobId, '--cwd', cwd, '--json']).job
  }
}

// The companion's own broker lifecycle and process helpers, from the same install.
async function lifecycle(companionPath) {
  const lib = path.join(path.dirname(companionPath), 'lib')
  const broker = await import(pathToFileURL(path.join(lib, 'broker-lifecycle.mjs')).href)
  const proc = await import(pathToFileURL(path.join(lib, 'process.mjs')).href)
  for (const fn of ['loadBrokerSession', 'sendBrokerShutdown', 'teardownBrokerSession', 'clearBrokerSession']) {
    if (typeof broker[fn] !== 'function') throw new Error(`the companion's broker API has no ${fn}`)
  }
  if (typeof proc.terminateProcessTree !== 'function') throw new Error("the companion's process API has no terminateProcessTree")
  return { ...broker, terminateProcessTree: proc.terminateProcessTree }
}

// What a pid the companion's state names stands for now, given test(line) for the command
// line it should run (whitespace-normalized and padded with one space on each side):
//   'ours'    it runs that command;
//   'group'   it is gone, but the process group it led lives on: POSIX never reuses a pid
//             that is still a live process-group id, so that group is the one it led;
//   'gone'    it and its group are gone;
//   'other'   it runs another program: the pid was reused, which it could not be while its
//             old group lived, so that group is gone too;
//   'unknown' its command line or its group cannot be read.
// test null: the command it should run is not known, so a live pid is 'unknown'.
function owner(pid, test) {
  const c = commandLine(pid)
  if (c.state === 'live') return test ? (test(` ${c.words.join(' ')} `) ? 'ours' : 'other') : 'unknown'
  if (c.state !== 'gone') return 'unknown'
  const g = groupAlive(pid)
  return g === true ? 'group' : g === false ? 'gone' : 'unknown'
}
const phrase = (...words) => ` ${words.join(' ').trim().split(/\s+/).join(' ')} `
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// test(line) for a process running script, by any path, with words right after it.
const runsScript = (script, ...words) => {
  const re = new RegExp(` (?:\\S*/)?${escapeRe(script)}${escapeRe(phrase(...words))}`)
  return line => re.test(line)
}
// A job runs in the detached worker the companion starts for it (the loop starts background
// jobs only): `codex-companion.mjs task-worker --cwd <W> --job-id <id>`. <W> may hold spaces,
// so the job id is matched as a phrase of its own, exactly.
const jobProcess = id => {
  const worker = runsScript('codex-companion.mjs', 'task-worker'), job = phrase('--job-id', id)
  return line => worker(line) && line.includes(job)
}
// The companion starts its broker as `app-server-broker.mjs serve --endpoint <E> --cwd <W>
// --pid-file <f>`, and each session's endpoint lies in a directory of its own.
const brokerProcess = endpoint => runsScript('app-server-broker.mjs', 'serve', '--endpoint', endpoint)

// The record of the job processes quiesce signalled through the companion's cancel but has
// not seen gone yet, for one <W>: {v:1, cwd, jobs:[{id, pid}]}. The cancel rewrites the job
// as cancelled with pid null, so a later quiesce that read only the companion's active jobs
// would no longer see a worker group that outlived it. Each job goes on this record before
// it is cancelled and leaves it once it is gone; a later quiesce waits for it again but never
// signals it again (its pid has been out of the companion's sight since).
function memoFile(cwd) {
  const root = process.env.TECH_LEAD_CACHE || path.join(os.homedir(), '.cache')
  if (!path.isAbsolute(root)) throw new Error(`bad-cache: TECH_LEAD_CACHE is not an absolute path: ${root}`)
  const abs = realOrResolved(cwd)
  const h = crypto.createHash('sha256').update(abs, 'utf8').digest('hex').slice(0, 16)
  return { file: path.join(root, 'tech-lead', 'codex-quiesce', `${h}.json`), abs }
}
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
function readMemo(cwd) {
  const { file, abs } = memoFile(cwd)
  const rec = readJson(file)
  if (rec === null) return []
  const ok = rec.v === 1 && rec.cwd === abs && Array.isArray(rec.jobs)
    && rec.jobs.every(j => j && typeof j.id === 'string' && validPid(j.pid))
  if (!ok) throw new Error(`unreadable: ${file}`)
  return rec.jobs.map(j => ({ id: j.id, pid: j.pid }))
}
function writeMemo(cwd, jobs) {
  const { file, abs } = memoFile(cwd)
  if (!jobs.length) {
    fs.rmSync(file, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeReplace(file, { v: 1, cwd: abs, jobs })
}

const notQuiet = (detail, final = null) => ({ quiet: false, final, detail })
const said = who => (who === 'other' ? 'runs another program' : 'gone')

// No Codex process can still write into <W> once (0) no companion is installed, or (1) every
// job the companion lists as active there, in any Claude session, has been cancelled, (2)
// <W>'s own broker, which hosts the app-server running the turns, has been shut down, and (3)
// the broker's and those jobs' worker processes, and the process groups they lead, are gone.
// Status words alone prove nothing: the companion marks a job cancelled even when the
// interrupt failed, and failed on a dropped connection.
// The companion's state can outlive its processes (a crash, a reboot), and both its cancel
// and its broker teardown signal the recorded pid's whole process group. So a recorded pid
// is signalled only while it is provably ours: it runs that job's worker or the broker
// serving that endpoint, or it is gone while the group it led lives on (owner()). A pid that
// is gone with its group, or runs another program, cannot write into <W>; it is left alone
// and reported as stale. A pid that is not an integer above 1, or one whose process cannot
// be read, is not quiet, and then nothing is signalled. Until everything is proven gone, the
// broker session and quiesce's record of the cancelled jobs stay, so a retry sees the same
// processes again.
export async function quiesce(cwd, jobId) {
  let memo
  try {
    memo = readMemo(cwd)
  } catch (e) {
    return notQuiet(`cannot read the record of Codex processes not yet proven gone: ${detailOf(e)}`)
  }
  const companionPath = locateCompanion()
  // No companion, no companion-run Codex process: worktree prep must not pause owners without Codex.
  if (!companionPath && !memo.length) return { quiet: true, final: null, detail: 'Codex companion not installed' }
  let jobs = [], api = null
  if (companionPath) {
    const listEnv = { ...process.env }
    delete listEnv[SESSION_ENV] // the companion hides other sessions' jobs from a plain listing
    try {
      jobs = companion(['status', '--all', '--json', '--cwd', cwd], { env: listEnv }).running || []
    } catch (e) {
      return notQuiet(`cannot list Codex jobs: ${detailOf(e)}`)
    }
    try {
      api = await lifecycle(companionPath)
    } catch (e) {
      return notQuiet(`cannot shut down the Codex broker: ${detailOf(e)}`)
    }
  }
  // Every listed job is judged before anything is signalled.
  const cancels = [], targets = [], stale = []
  for (const job of jobs) {
    const id = String(job.id), pid = job.pid
    if (notStarted(pid)) {
      cancels.push(id) // its cancel signals nothing and keeps it from starting
      continue
    }
    if (!validPid(pid)) return notQuiet(`Codex job ${id} names pid ${JSON.stringify(pid)}, which is not a process that may be signalled`)
    const who = owner(pid, jobProcess(id))
    if (who === 'unknown') return notQuiet(`cannot tell what pid ${pid} of Codex job ${id} runs`)
    if (who === 'ours' || who === 'group') {
      cancels.push(id)
      targets.push({ what: `job ${id}`, id, pid })
    } else {
      stale.push(`job ${id} (pid ${pid} ${said(who)})`)
    }
  }
  // Jobs cancelled by an earlier quiesce that were not yet gone: waited for, never signalled.
  for (const m of memo) {
    if (targets.some(x => x.pid === m.pid)) continue
    const who = owner(m.pid, jobProcess(m.id))
    if (who === 'gone' || who === 'other') continue
    targets.push({ what: `job ${m.id} (cancelled earlier)`, id: m.id, pid: m.pid })
  }
  // And <W>'s broker.
  let session = null, broker = null
  if (api) {
    try {
      session = api.loadBrokerSession(cwd)
    } catch (e) {
      return notQuiet(`cannot read the Codex broker session: ${detailOf(e)}`)
    }
    if (session) {
      const pid = session.pid
      if (!validPid(pid)) return notQuiet(`the Codex broker names pid ${JSON.stringify(pid)}, which is not a process that may be signalled`)
      const endpoint = typeof session.endpoint === 'string' && session.endpoint ? session.endpoint : null
      // Without an endpoint a live broker cannot be told from another program.
      const who = owner(pid, endpoint && brokerProcess(endpoint))
      if (who === 'unknown') return notQuiet(`cannot tell whether pid ${pid} is the Codex broker`)
      if (who === 'ours' || who === 'group') broker = { who, pid, endpoint }
      else stale.push(`broker (pid ${pid} ${said(who)})`)
    }
  }
  try {
    writeMemo(cwd, targets.map(x => ({ id: x.id, pid: x.pid })))
  } catch (e) {
    return notQuiet(`cannot record the Codex jobs to cancel: ${detailOf(e)}`)
  }
  for (const id of cancels) {
    try {
      companion(['cancel', id, '--cwd', cwd, '--json'])
    } catch {
      // checked below by process liveness
    }
  }
  if (broker) {
    try {
      // A broker whose leader is gone serves nothing more: its group is only signalled.
      if (broker.who === 'ours') await api.sendBrokerShutdown(broker.endpoint)
      api.terminateProcessTree(broker.pid)
    } catch (e) {
      return notQuiet(`cannot shut down the Codex broker: ${detailOf(e)}`)
    }
    targets.push({ what: 'broker', pid: broker.pid })
  }
  let final = null
  if (jobId && companionPath) {
    try {
      final = readJob(jobId, cwd).status
    } catch {
      // reported as null
    }
  }
  const alive = await waitGone(targets, GONE_WAIT_MS)
  const jobsLeft = alive.filter(x => x.id !== undefined).map(x => ({ id: x.id, pid: x.pid }))
  try {
    writeMemo(cwd, jobsLeft)
  } catch (e) {
    return notQuiet(`cannot update the record of Codex jobs not yet proven gone: ${detailOf(e)}`, final)
  }
  if (alive.length) {
    return notQuiet(`still running: ${alive.map(x => `${x.what} (pid ${x.pid} or its process group)`).join(', ')}`, final)
  }
  if (session) {
    try {
      // Its files only: every process it named is proven gone.
      api.teardownBrokerSession({ ...session, killProcess: null })
      api.clearBrokerSession(cwd)
    } catch (e) {
      return notQuiet(`cannot clear the Codex broker session: ${detailOf(e)}`, final)
    }
  }
  const cancelled = jobs.length - stale.filter(x => x.startsWith('job ')).length
  return { quiet: true, final, detail: `${cancelled} active job(s) cancelled; broker ${broker ? 'shut down' : 'not running'}${stale.length ? `; stale, left alone: ${stale.join(', ')}` : ''}` }
}

const detailOf = e => String((e.stderr && String(e.stderr).trim()) || e.message).split('\n')[0]

// The process group of pid as `ps -o pgid=` reads it, or null when it cannot be read.
// TECH_LEAD_PS replaces /bin/ps in tests only (scripts/lib/loop-proc.mjs).
function processGroup(pid) {
  const r = spawnSync(process.env.TECH_LEAD_PS || '/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' },
  })
  const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
  return /^[1-9]\d*$/.test(out) ? Number(out) : null
}

// This start process as a Codex record's starter: {pid, start, pgid}. The companion it runs
// shares its process group, so a starter killed while the companion launches the job leaves
// that group alive, and the job may still be launched: a reclaim waits for the starter and
// for its group. pgid null: the group could not be read.
function starterIdentity() {
  const t = startToken(process.pid)
  if (t.state !== 'live') throw new Error(`no-identity: the starter cannot read its own start token (${t.detail || t.state})`)
  return { pid: process.pid, start: t.token, pgid: processGroup(process.pid) }
}

function parseArgs(argv) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i]
    else pos.push(argv[i])
  }
  return { opts, pos }
}

const validCap = v => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= MAX_CAP_MIN ? n : null
}

async function main(argv) {
  const [cmd, ...rest] = argv
  const { opts, pos } = parseArgs(rest)
  const print = o => process.stdout.write(JSON.stringify(o) + '\n')
  const usage = () => {
    process.stderr.write('usage: loop-codex.mjs start --cwd <W> --prompt-file <f> --cap-min <n> [--project <P> --generation <N>] | wait <jobId> --cwd <W> --cap-min <n> | result <jobId> --cwd <W> | quiesce --cwd <W> [--job <id>]\n')
    return 2
  }
  const cwd = opts.cwd, jobId = pos[0]
  if (!cwd) return usage()

  if (cmd === 'start') {
    if (!opts['prompt-file'] || !validCap(opts['cap-min'])) return usage()
    const locked = 'project' in opts || 'generation' in opts
    const generation = Number(opts.generation)
    if (locked && !(opts.project && GENERATION.test(opts.generation ?? '') && Number.isSafeInteger(generation))) return usage()
    let record = null, paths = null
    if (locked) {
      if (!locateCompanion()) {
        print({ state: 'unavailable', detail: 'Codex companion not found' })
        return 3
      }
      try {
        paths = openPaths(opts.project)
        record = registerCodex(opts.project, generation, cwd, { starter: starterIdentity() })
      } catch (e) {
        print({ state: e.code === 'NOT_HOLDER' ? 'not-holder' : 'error', detail: e.message })
        return e.code === 'NOT_HOLDER' ? 4 : 2
      }
    }
    let job
    try {
      // In <W> as well as with --cwd <W>: a sweep for processes inside <W> sees the companion.
      const p = companion(['task', '--background', '--json', '--write', '--cwd', cwd, '--prompt-file', opts['prompt-file']], { cwd })
      if (!p.jobId) throw new Error('the companion returned no job id')
      job = p.jobId
    } catch (e) {
      // A registered record stays: the release or the next acquire quiesces <W> for it.
      print({ state: 'unavailable', detail: detailOf(e) })
      return 3
    }
    if (record) {
      try {
        setCodexJob(record, job)
        // The generation may have been lost while the companion launched the job.
        assertHeld(paths, generation)
      } catch (e) {
        // Not provably the holder any more: stop the job too. The record keeps its id for the
        // next acquire, which quiesces <W> again.
        const q = await quiesce(cwd, job)
        print({ state: 'not-holder', jobId: job, quiet: q.quiet, detail: `${e.message}; ${q.detail}` })
        return 4
      }
    }
    print({ state: 'started', jobId: job })
    return 0
  }

  if (cmd === 'quiesce') {
    if (pos.length) return usage()
    print(await quiesce(cwd, opts.job))
    return 0
  }

  if (!jobId || !['wait', 'result'].includes(cmd)) return usage()

  if (cmd === 'wait') {
    const capMin = validCap(opts['cap-min'])
    if (!capMin) return usage()
    try {
      let job = readJob(jobId, cwd)
      let w = waitState(job, capMin, Date.now())
      if (w.state === 'running') {
        const remaining = capMin * 60000 - (Date.now() - Date.parse(job.startedAt || job.createdAt))
        const slice = Math.round(Math.max(1000, Math.min(WAIT_SLICE_MS, remaining)))
        try {
          job = companion(['status', jobId, '--cwd', cwd, '--wait', '--timeout-ms', String(slice), '--json']).job
        } catch {
          job = readJob(jobId, cwd)
        }
        w = waitState(job, capMin, Date.now())
      }
      print(w)
    } catch (e) {
      print({ state: 'error', detail: detailOf(e) })
    }
    return 0
  }

  try {
    const { storedJob } = companion(['result', jobId, '--cwd', cwd, '--json'])
    const r = (storedJob && storedJob.result) || {}
    const answer = r.rawOutput || (r.codex && r.codex.stdout) || (storedJob && storedJob.rendered) || ''
    if (!answer.trim()) throw new Error('the companion has no stored report for this job')
    print({ answer, ...parseTrailer(answer) })
    return 0
  } catch (e) {
    print({ state: 'error', detail: detailOf(e) })
    return 1
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
