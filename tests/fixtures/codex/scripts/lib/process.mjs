// tests/fixtures/codex/scripts/lib/process.mjs
// Test double for the companion's terminateProcessTree: kills the pid unless the
// scenario lists it as stubborn.
import fs from 'node:fs'

export function terminateProcessTree(pid) {
  const s = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
  if ((s.stubborn || []).includes(pid)) return { attempted: true, delivered: false }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
  return { attempted: true, delivered: true }
}
