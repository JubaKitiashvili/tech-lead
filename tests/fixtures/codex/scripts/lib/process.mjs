// tests/fixtures/codex/scripts/lib/process.mjs
// Test double for the companion's terminateProcessTree, which on POSIX sends SIGTERM to the
// pid's whole process group (-pid), falls back to the pid itself only when the group signal
// fails with anything but ESRCH, and reports nothing delivered on ESRCH. The double does the
// same, except that it signals nothing for a pid the scenario lists as stubborn, and nothing
// for a pid that is not an integer above 1: the real one would send SIGTERM to -0 (the
// caller's own group) or -1 (every process the caller may signal). Each call is appended to
// FAKE_CODEX_LOG as ['lib:terminateProcessTree', pid].
import fs from 'node:fs'

export function terminateProcessTree(pid) {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(['lib:terminateProcessTree', pid]) + '\n')
  if (!(Number.isInteger(pid) && pid > 1)) return { attempted: false, delivered: false, method: null }
  const s = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
  if ((s.stubborn || []).includes(pid)) return { attempted: true, delivered: false, method: 'process-group' }
  try {
    process.kill(-pid, 'SIGTERM')
    return { attempted: true, delivered: true, method: 'process-group' }
  } catch (e) {
    if (e.code === 'ESRCH') return { attempted: true, delivered: false, method: 'process-group' }
  }
  try {
    process.kill(pid, 'SIGTERM')
    return { attempted: true, delivered: true, method: 'process' }
  } catch {
    return { attempted: true, delivered: false, method: 'process' }
  }
}
