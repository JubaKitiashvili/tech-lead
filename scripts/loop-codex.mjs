#!/usr/bin/env node
// scripts/loop-codex.mjs
// The loop's L3 Codex task (loop §5) as a Codex companion job: started in the
// background, waited on in foreground calls, and stopped only when the Codex turn
// is confirmed stopped. Every call prints one JSON line.
//   start --cwd <W> --prompt-file <brief>  {"state":"started","jobId":…}
//                                           exit 3 {"state":"unavailable","detail":…}
//   wait <jobId> --cwd <W> --cap-min <n>   {"state":"running"|"cap"|"completed"|"failed"|"cancelled"|"error",…}
//   result <jobId> --cwd <W>               {"answer":…,"trailer":{…}|null,"flagged":bool}
//                                           exit 1 {"state":"error","detail":…}
//   stop <jobId> --cwd <W>                 {"stopped":bool,"detail":…}
// The companion is the newest installed
// ~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs;
// TECH_LEAD_CODEX_COMPANION names another one (the tests use a fake).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ACTIVE = new Set(['queued', 'running'])
const ENDED = new Set(['completed', 'failed', 'cancelled'])
// Ended by the job itself. A job marked `cancelled` is not proof: the companion marks
// it cancelled even when interrupting the Codex turn failed.
const FINISHED = new Set(['completed', 'failed'])
const WAIT_SLICE_MS = 540000 // one wait call stays under the Bash tool's 600000 ms limit

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

export function stopVerdict(status, cancel) {
  if (FINISHED.has(status)) return { stopped: true, detail: `job already ${status}` }
  if (cancel && cancel.turnInterrupted === true) return { stopped: true, detail: 'Codex turn interrupted' }
  if (status === 'cancelled') return { stopped: false, detail: 'job was cancelled elsewhere; the Codex turn is not confirmed stopped' }
  return { stopped: false, detail: cancel ? 'cancel did not confirm the Codex turn stopped' : 'cancel failed' }
}

function companion(args) {
  const c = locateCompanion()
  if (!c) throw new Error('Codex companion not found')
  const out = execFileSync(process.execPath, [c, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: WAIT_SLICE_MS + 30000,
  })
  return JSON.parse(out.slice(out.indexOf('{')))
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

function main(argv) {
  const [cmd, ...rest] = argv
  const { opts, pos } = parseArgs(rest)
  const print = o => process.stdout.write(JSON.stringify(o) + '\n')
  const usage = () => {
    process.stderr.write('usage: loop-codex.mjs start --cwd <W> --prompt-file <f> | wait <jobId> --cwd <W> --cap-min <n> | result <jobId> --cwd <W> | stop <jobId> --cwd <W>\n')
    return 2
  }
  const cwd = opts.cwd, jobId = pos[0]
  if (!cwd) return usage()

  if (cmd === 'start') {
    if (!opts['prompt-file']) return usage()
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
  if (!jobId || !['wait', 'result', 'stop'].includes(cmd)) return usage()

  if (cmd === 'wait') {
    const capMin = Number(opts['cap-min'])
    if (!(capMin > 0)) return usage()
    try {
      let job = companion(['status', jobId, '--cwd', cwd, '--json']).job
      let w = waitState(job, capMin, Date.now())
      if (w.state === 'running') {
        const remaining = capMin * 60000 - (Date.now() - Date.parse(job.startedAt || job.createdAt))
        const slice = Math.round(Math.max(1000, Math.min(WAIT_SLICE_MS, remaining)))
        job = companion(['status', jobId, '--cwd', cwd, '--wait', '--timeout-ms', String(slice), '--json']).job
        w = waitState(job, capMin, Date.now())
      }
      print(w)
    } catch (e) {
      print({ state: 'error', detail: detailOf(e) })
    }
    return 0
  }

  if (cmd === 'result') {
    try {
      const { storedJob } = companion(['result', jobId, '--cwd', cwd, '--json'])
      const r = (storedJob && storedJob.result) || {}
      const answer = r.rawOutput || (r.codex && r.codex.stdout) || (storedJob && storedJob.rendered) || ''
      print({ answer, ...parseTrailer(answer) })
      return 0
    } catch (e) {
      print({ state: 'error', detail: detailOf(e) })
      return 1
    }
  }

  let status = null
  try {
    status = companion(['status', jobId, '--cwd', cwd, '--json']).job.status
  } catch {
    // unreadable status: treat the job as live and try to cancel it
  }
  let cancel = null
  if (!status || ACTIVE.has(status)) {
    try {
      cancel = companion(['cancel', jobId, '--cwd', cwd, '--json'])
    } catch {
      // a failed cancel is reported by stopVerdict
    }
  }
  print(stopVerdict(status, cancel))
  return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
