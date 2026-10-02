#!/usr/bin/env node
// tests/fixtures/codex/scripts/codex-companion.mjs
// Test double for the Codex companion CLI (task, status, result, cancel with --json).
// FAKE_CODEX_STATE names a JSON scenario file; each call's argv is appended to FAKE_CODEX_LOG.
// `task` also logs ['task:cwd', <its working directory>]. A scenario's watchDir makes `task`
// also log ['watch', {name: parsed JSON}] for every record in that directory at launch time.
// A scenario's taskDelayMs delays `task`, and launchWorker makes it start the job's worker
// (`task-worker`, detached, as the real companion does) and add {id, pid, status:'running'}
// to the scenario's active jobs.
// `task-worker --cwd <W> --job-id <id> [--member <f>] [--stubborn-member <f>]` is that
// worker: it only waits to be killed, and its command line names its job, as the real one's
// does; the member flags start one more process in its group (lib/group-member.mjs).
// `cancel` does what the real one does to the job's processes and state: SIGTERM to the
// worker's whole process group (lib/process.mjs's terminateProcessTree, which signals
// nothing for a stubborn pid or one that is not an integer above 1), then the job is
// rewritten as cancelled with pid null, so it leaves the active list; the scenario's
// `cancelled` keeps {id, pid} of each cancelled job.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// lib/ is imported only where it is used: a copy of this file without lib/ still lists jobs.
const argv = process.argv.slice(2)
if (argv[0] === 'task-worker') {
  const { startMembers } = await import('./lib/group-member.mjs')
  startMembers(argv)
  setInterval(() => {}, 2 ** 30)
} else {
  await main()
}

async function main() {
  const log = entry => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n') }
  log(argv)
  const file = process.env.FAKE_CODEX_STATE
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  const out = o => console.log(JSON.stringify(o, null, 2)) // the companion pretty-prints --json output
  const fail = m => {
    process.stderr.write(`${m}\n`)
    process.exit(1)
  }
  const job = () => ({ id: s.jobId, status: s.status, createdAt: s.createdAt || s.startedAt, startedAt: s.startedAt || null })

  switch (argv[0]) {
    case 'task': {
      log(['task:cwd', process.cwd()])
      if (s.watchDir) {
        const names = fs.existsSync(s.watchDir) ? fs.readdirSync(s.watchDir).filter(n => !n.startsWith('.')).sort() : []
        log(['watch', Object.fromEntries(names.map(n => [n, JSON.parse(fs.readFileSync(`${s.watchDir}/${n}`, 'utf8'))]))])
      }
      if (s.taskError) fail(s.taskError)
      if (s.taskDelayMs) await new Promise(resolve => setTimeout(resolve, s.taskDelayMs))
      if (s.launchWorker) {
        const cwd = argv[argv.indexOf('--cwd') + 1]
        const w = spawn(process.execPath, [fileURLToPath(import.meta.url), 'task-worker', '--cwd', cwd, '--job-id', s.jobId], { detached: true, stdio: 'ignore' })
        w.unref()
        const now = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({ ...now, active: [...(now.active || []), { id: s.jobId, pid: w.pid, status: 'running' }] }))
        log(['launched', w.pid])
      }
      out({ jobId: s.jobId, status: 'queued', title: 'Codex Task', summary: 's', logFile: '/dev/null' })
      break
    }
    case 'status':
      if (argv.includes('--all')) {
        log(['env:CODEX_COMPANION_SESSION_ID', process.env.CODEX_COMPANION_SESSION_ID ?? null])
        if (s.listError) fail(s.listError)
        out({ workspaceRoot: '/w', running: s.active || [] })
        break
      }
      if (s.statusErrorOnce) {
        fs.writeFileSync(file, JSON.stringify({ ...s, statusErrorOnce: false }))
        fail('state.json was half-written')
      }
      if (s.statusError) fail(s.statusError)
      out({ workspaceRoot: '/w', job: job(), ...(argv.includes('--wait') ? { waitTimedOut: s.status === 'queued' || s.status === 'running' } : {}) })
      break
    case 'result':
      out({ job: job(), storedJob: s.noStoredJob ? null : { result: { rawOutput: s.rawOutput } } })
      break
    case 'cancel': {
      if (s.cancelError) fail(s.cancelError)
      const active = (s.active || []).find(j => j.id === argv[1])
      if (active) {
        const { terminateProcessTree } = await import('./lib/process.mjs')
        terminateProcessTree(active.pid ?? Number.NaN)
        const now = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({
          ...now,
          active: (now.active || []).filter(j => j.id !== argv[1]),
          cancelled: [...(now.cancelled || []), { id: argv[1], pid: active.pid ?? null }],
        }))
      }
      out({ jobId: argv[1], status: 'cancelled', title: 'Codex Task', turnInterruptAttempted: true, turnInterrupted: s.turnInterrupted ?? true })
      break
    }
    default:
      fail(`unknown command ${argv[0]}`)
  }
}
