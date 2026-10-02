// scripts/lib/loop-proc.mjs
// Process facts for the firing lock (spec section 10, stage 0c-1). A process is named by
// its pid together with a start token, so a pid the kernel has handed to a new process
// never passes for the one that held the lock. Any fact this module cannot establish is
// reported as unknown, and callers treat unknown as alive.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const POLL_MS = 100
const KILL_WAIT_MS = 2000
const PS_TIMEOUT_MS = 10000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const validPid = pid => Number.isInteger(pid) && pid > 0
// -pgid must name one process group: -0 is the caller's own group and -1 is every process
// the caller may signal, so 0 and 1 are refused before anything is sent.
const validPgid = pgid => Number.isInteger(pgid) && pgid > 1
const unknown = detail => ({ state: 'unknown', detail })

// startToken(pid) -> {state:'live', token} | {state:'gone'} | {state:'unknown', detail}
export function startToken(pid) {
  if (!validPid(pid)) return unknown(`bad pid: ${String(pid)}`)
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code === 'ESRCH') return { state: 'gone' }
    // EPERM: the process exists but belongs to someone else; its token is still readable.
    if (e.code !== 'EPERM') return unknown(`kill ${pid}: ${e.code || e.message}`)
  }
  try {
    if (process.platform === 'darwin') return darwinToken(pid)
    if (process.platform === 'linux') return linuxToken(pid)
    return unknown(`unsupported platform: ${process.platform}`)
  } catch (e) {
    return unknown(`${pid}: ${e.code || e.message}`)
  }
}

// TECH_LEAD_PS replaces /bin/ps in tests only.
const PS = () => process.env.TECH_LEAD_PS || '/bin/ps'

// ps exits 1 for a missing pid and for its own errors alike, so a non-zero exit means gone
// only when the kernel agrees; a live pid that ps could not read is unknown, never gone.
function psFailed(pid, status) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code === 'ESRCH') return { state: 'gone' }
  }
  return unknown(`ps exited ${status} for live pid ${pid}`)
}

// lstart has one-second resolution; LC_ALL=C fixes its spelling and TZ=UTC its zone, so
// every caller on the host reads the same token for one process.
function darwinToken(pid) {
  const r = spawnSync(PS(), ['-o', 'stat=,lstart=', '-p', String(pid)], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PS_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
  if (r.error) return unknown(`ps: ${r.error.code || r.error.message}`)
  if (r.status === null) return unknown(`ps: ended by ${r.signal}`)
  if (r.status !== 0) return psFailed(pid, r.status)
  const m = /^(\S+)\s+(\S.*)$/.exec(r.stdout.trim())
  if (!m) return unknown(`ps: unexpected output ${JSON.stringify(r.stdout)}`)
  if (m[1].startsWith('Z')) return { state: 'gone' }
  return { state: 'live', token: `darwin:${m[2].replace(/\s+/g, ' ')}` }
}

// starttime is in clock ticks since boot, so the boot id makes the token unique across
// reboots.
function linuxToken(pid) {
  const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  if (!stat) return unknown(`/proc/${pid}/stat: unexpected format`)
  if (stat.state === 'Z') return { state: 'gone' }
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!/^[0-9a-f-]+$/.test(bootId)) return unknown(`boot_id: unexpected value ${JSON.stringify(bootId)}`)
  return { state: 'live', token: `linux:${bootId}:${stat.starttime}` }
}

// parseProcStat(text) -> {state, starttime} | null. The line reads "pid (comm) state ...";
// comm may hold spaces and parentheses, so fields are counted from the last ')'. Field 3
// (state) is the first after it, which puts field 22 (starttime) at index 19.
export function parseProcStat(text) {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const state = fields[0], starttime = fields[22 - 3]
  if (!/^[A-Za-z]$/.test(state ?? '') || !/^\d+$/.test(starttime ?? '')) return null
  return { state, starttime }
}

// commandLine(pid) -> {state:'live', words} | {state:'gone'} | {state:'unknown', detail}.
// words is the process's command line split on whitespace (darwin: `ps -ww -o command=`;
// linux: /proc/<pid>/cmdline), so an argument holding spaces reads as several words. A
// zombie is gone. It tells what a pid named in another program's state runs now.
export function commandLine(pid) {
  if (!validPid(pid)) return unknown(`bad pid: ${String(pid)}`)
  try {
    process.kill(pid, 0)
  } catch (e) {
    if (e.code === 'ESRCH') return { state: 'gone' }
    if (e.code !== 'EPERM') return unknown(`kill ${pid}: ${e.code || e.message}`)
  }
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync(PS(), ['-ww', '-o', 'stat=,command=', '-p', String(pid)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' },
      })
      if (r.error) return unknown(`ps: ${r.error.code || r.error.message}`)
      if (r.status === null) return unknown(`ps: ended by ${r.signal}`)
      if (r.status !== 0) return psFailed(pid, r.status)
      const words = r.stdout.trim().split(/\s+/)
      if (words.length < 2) return unknown(`ps: unexpected output ${JSON.stringify(r.stdout)}`)
      return words[0].startsWith('Z') ? { state: 'gone' } : { state: 'live', words: words.slice(1) }
    }
    if (process.platform === 'linux') {
      const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (!stat) return unknown(`/proc/${pid}/stat: unexpected format`)
      if (stat.state === 'Z') return { state: 'gone' }
      const words = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim().split(/\s+/)
      return words[0] ? { state: 'live', words } : unknown(`/proc/${pid}/cmdline: empty`)
    }
    return unknown(`unsupported platform: ${process.platform}`)
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'gone' }
    return unknown(`${pid}: ${e.code || e.message}`)
  }
}

// isAlive({pid, start}) -> true | false | null. null (unknown) also covers a record whose
// start cannot be compared; callers treat null as alive.
export function isAlive(holder) {
  const { pid, start } = holder ?? {}
  const t = startToken(pid)
  if (t.state === 'gone') return false
  if (t.state !== 'live' || typeof start !== 'string') return null
  return t.token === start
}

// groupAlive(pgid) -> true | false | null. EPERM means a member exists that we may not
// signal, which still counts as alive.
export function groupAlive(pgid) {
  if (!validPgid(pgid)) return null
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    if (e.code === 'EPERM') return true
    if (e.code === 'ESRCH') return false
    return null
  }
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal)
  } catch { /* gone, or not ours to signal: the poll decides */ }
}

// Resolves true once groupAlive reads false, polling every POLL_MS for at most ms. The
// waits yield to the event loop, so a caller whose own child leads the group reaps it.
async function waitGroupGone(pgid, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    if (groupAlive(pgid) === false) return true
    const left = deadline - Date.now()
    if (left <= 0) return false
    await sleep(Math.min(POLL_MS, left))
  }
}

// killGroup(pgid, {graceMs}) -> Promise<boolean>: SIGTERM, up to graceMs for the group to
// leave, then SIGKILL and up to 2 s more; true when the group is gone.
export async function killGroup(pgid, { graceMs = 5000 } = {}) {
  if (!validPgid(pgid)) throw new Error(`bad-pgid: ${String(pgid)}`)
  signalGroup(pgid, 'SIGTERM')
  if (await waitGroupGone(pgid, graceMs)) return true
  signalGroup(pgid, 'SIGKILL')
  return waitGroupGone(pgid, KILL_WAIT_MS)
}

// resolveHolder(env) -> {pid, start, how}. TECH_LEAD_HOLDER_PID (tests only) wins over
// CLAUDE_PID, which Claude Code sets for every Bash command to the long-lived claude
// process. The first variable set is the holder: a bad one never falls back to the other.
export function resolveHolder(env = process.env) {
  const how = ['TECH_LEAD_HOLDER_PID', 'CLAUDE_PID'].find(k => env[k] != null && env[k] !== '')
  if (!how) throw new Error('no-holder: neither TECH_LEAD_HOLDER_PID nor CLAUDE_PID is set')
  const raw = env[how]
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`no-holder: ${how}=${JSON.stringify(raw)} is not a pid`)
  const pid = Number(raw)
  const t = startToken(pid)
  if (t.state !== 'live') throw new Error(`no-holder: ${how}=${pid} is ${t.state}${t.detail ? ` (${t.detail})` : ''}`)
  return { pid, start: t.token, how }
}
