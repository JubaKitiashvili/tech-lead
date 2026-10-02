// tests/fixtures/codex/scripts/lib/broker-lifecycle.mjs
// Test double for the companion's broker lifecycle API. The scenario's `broker` is
// {pid, endpoint} or absent; every call is appended to FAKE_CODEX_LOG.
import fs from 'node:fs'

const scenario = () => JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
const log = entry => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n') }

export function loadBrokerSession(cwd) {
  log(['lib:loadBrokerSession', cwd])
  return scenario().broker || null
}

export async function sendBrokerShutdown(endpoint) {
  log(['lib:sendBrokerShutdown', endpoint])
}

export function teardownBrokerSession({ pid = null, killProcess = null }) {
  log(['lib:teardownBrokerSession', pid])
  if (Number.isFinite(pid) && killProcess) killProcess(pid)
}

export function clearBrokerSession(cwd) {
  log(['lib:clearBrokerSession', cwd])
}
