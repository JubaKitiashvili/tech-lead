#!/usr/bin/env node
// tests/fixtures/codex/scripts/codex-companion.mjs
// Test double for the Codex companion CLI (task, status, result, cancel with --json).
// FAKE_CODEX_STATE names a JSON scenario file; each call's argv is appended to FAKE_CODEX_LOG.
import fs from 'node:fs'

const argv = process.argv.slice(2)
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
  case 'task':
    if (s.taskError) fail(s.taskError)
    out({ jobId: s.jobId, status: 'queued', title: 'Codex Task', summary: 's', logFile: '/dev/null' })
    break
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
    // Like the real companion, cancel kills the job's worker process.
    const active = (s.active || []).find(j => j.id === argv[1])
    if (active && Number.isInteger(active.pid) && !(s.stubborn || []).includes(active.pid)) {
      try { process.kill(active.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    out({ jobId: argv[1], status: 'cancelled', title: 'Codex Task', turnInterruptAttempted: true, turnInterrupted: s.turnInterrupted ?? true })
    break
  }
  default:
    fail(`unknown command ${argv[0]}`)
}
