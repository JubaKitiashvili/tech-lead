// scripts/lib/fault.mjs
// Fault points for the interruption tests (stage 0c-2, ruling R8). A helper calls
// fault('<helper>:<step>') at each persistence boundary; when TECH_LEAD_FAULT names that
// point, the process sends itself SIGKILL, so nothing after the boundary runs and no
// cleanup (exit handlers, finally blocks) runs either: the state on disk is exactly what a
// kill at that boundary leaves. Unset, or naming another point, the call does nothing.
// TECH_LEAD_FAULT is set by tests only.

const POINT = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/
// kill(2) delivers a signal sent to the calling process before it returns; the wait is a
// guard that keeps the next step from running should it not.
const GUARD_MS = 10000

export function fault(point) {
  if (typeof point !== 'string' || !POINT.test(point)) throw new TypeError(`fault: bad point ${JSON.stringify(String(point))}`)
  if (process.env.TECH_LEAD_FAULT !== point) return
  process.kill(process.pid, 'SIGKILL')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, GUARD_MS)
  throw new Error(`fault: SIGKILL at ${point} did not end process ${process.pid}`)
}
