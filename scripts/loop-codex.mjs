#!/usr/bin/env node
// scripts/loop-codex.mjs
// The loop's L3 Codex task (loop §5) as a Codex companion job: started in the
// background, waited on in foreground calls, and ended by `quiesce`, which proves no
// Codex process can still write into the worktree. Every call prints one JSON line.
//   start --cwd <W> --prompt-file <brief> --cap-min <n>
//                                  {"state":"started","jobId":…}
//                                  exit 3 {"state":"unavailable","detail":…}
//   wait <jobId> --cwd <W> --cap-min <n>
//                                  {"state":"running"|"cap"|"completed"|"failed"|"cancelled"|"error",…}
//   result <jobId> --cwd <W>       {"answer":…,"trailer":{…}|null,"flagged":bool}
//                                  exit 1 {"state":"error","detail":…}
//   quiesce --cwd <W> [--job <id>] {"quiet":bool,"final":<status of --job>|null,"detail":…}
// The companion is the newest installed
// ~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs;
// TECH_LEAD_CODEX_COMPANION names another one (the tests use a fake).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ACTIVE = new Set(['queued', 'running'])
const ENDED = new Set(['completed', 'failed', 'cancelled'])
const WAIT_SLICE_MS = 540000 // one wait call stays under the Bash tool's 600000 ms limit
const MAX_CAP_MIN = 1440
const SESSION_ENV = 'CODEX_COMPANION_SESSION_ID'

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

async function waitGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let alive = pids.filter(processAlive)
  while (alive.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    alive = alive.filter(processAlive)
  }
  return alive
}

function companion(args, env = process.env) {
  const c = locateCompanion()
  if (!c) throw new Error('Codex companion not found')
  const out = execFileSync(process.execPath, [c, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: WAIT_SLICE_MS + 30000, env,
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

// No Codex process can still write into <W> once (1) every job the companion lists as
// active there, in any Claude session, has been cancelled, (2) <W>'s own broker, which
// hosts the app-server running the turns, has been shut down, and (3) the broker's and
// those jobs' worker processes are gone. Status words alone prove nothing: the companion
// marks a job cancelled even when the interrupt failed, and failed on a dropped connection.
export async function quiesce(cwd, jobId) {
  const companionPath = locateCompanion()
  if (!companionPath) return { quiet: false, final: null, detail: 'Codex companion not found' }
  const listEnv = { ...process.env }
  delete listEnv[SESSION_ENV] // the companion hides other sessions' jobs from a plain listing
  let jobs
  try {
    jobs = companion(['status', '--all', '--json', '--cwd', cwd], listEnv).running || []
  } catch (e) {
    return { quiet: false, final: null, detail: `cannot list Codex jobs: ${detailOf(e)}` }
  }
  for (const job of jobs) {
    try {
      companion(['cancel', job.id, '--cwd', cwd, '--json'])
    } catch {
      // checked below by process liveness
    }
  }
  let session = null
  try {
    const api = await lifecycle(companionPath)
    session = api.loadBrokerSession(cwd)
    if (session) {
      if (session.endpoint) await api.sendBrokerShutdown(session.endpoint)
      api.teardownBrokerSession({ ...session, killProcess: api.terminateProcessTree })
      api.clearBrokerSession(cwd)
    }
  } catch (e) {
    return { quiet: false, final: null, detail: `cannot shut down the Codex broker: ${detailOf(e)}` }
  }
  let final = null
  if (jobId) {
    try {
      final = readJob(jobId, cwd).status
    } catch {
      // reported as null
    }
  }
  if (session && !(Number.isInteger(session.pid) && session.pid > 0)) {
    return { quiet: false, final, detail: 'the Codex broker has no known pid' }
  }
  const pids = [session && session.pid, ...jobs.map(j => j.pid)].filter(p => Number.isInteger(p) && p > 0)
  const alive = await waitGone(pids, 5000)
  if (alive.length) return { quiet: false, final, detail: `still running: pid ${alive.join(', ')}` }
  return { quiet: true, final, detail: `${jobs.length} active job(s) cancelled; broker ${session ? 'shut down' : 'not running'}` }
}

const detailOf = e => String((e.stderr && String(e.stderr).trim()) || e.message).split('\n')[0]

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
    process.stderr.write('usage: loop-codex.mjs start --cwd <W> --prompt-file <f> --cap-min <n> | wait <jobId> --cwd <W> --cap-min <n> | result <jobId> --cwd <W> | quiesce --cwd <W> [--job <id>]\n')
    return 2
  }
  const cwd = opts.cwd, jobId = pos[0]
  if (!cwd) return usage()

  if (cmd === 'start') {
    if (!opts['prompt-file'] || !validCap(opts['cap-min'])) return usage()
    try {
      const p = companion(['task', '--background', '--json', '--write', '--cwd', cwd, '--prompt-file', opts['prompt-file']])
      if (!p.jobId) throw new Error('the companion returned no job id')
      print({ state: 'started', jobId: p.jobId })
      return 0
    } catch (e) {
      print({ state: 'unavailable', detail: detailOf(e) })
      return 3
    }
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
