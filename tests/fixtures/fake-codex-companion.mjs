#!/usr/bin/env node
// tests/fixtures/fake-codex-companion.mjs
// Test double for the Codex companion CLI (task, status, result, cancel with --json).
// FAKE_CODEX_STATE names a JSON scenario file; each call's argv is appended to FAKE_CODEX_LOG.
import fs from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(argv) + '\n')
const s = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
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
    if (s.statusError) fail(s.statusError)
    out({ workspaceRoot: '/w', job: job(), ...(argv.includes('--wait') ? { waitTimedOut: s.status === 'queued' || s.status === 'running' } : {}) })
    break
  case 'result':
    out({ job: job(), storedJob: { result: { rawOutput: s.rawOutput } } })
    break
  case 'cancel':
    if (s.cancelError) fail(s.cancelError)
    out({ jobId: s.jobId, status: 'cancelled', title: 'Codex Task', turnInterruptAttempted: true, turnInterrupted: s.turnInterrupted })
    break
  default:
    fail(`unknown command ${argv[0]}`)
}
