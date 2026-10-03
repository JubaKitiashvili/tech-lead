// scripts/lib/loop-proc.mjs
// Process facts for the firing lock (spec section 10, stage 0c-1). A process is named by
// its pid together with a start token, so a pid the kernel has handed to a new process
// never passes for the one that held the lock. Any fact this module cannot establish is
// reported as unknown, and callers treat unknown as alive.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const POLL_MS = 100
const KILL_WAIT_MS = 2000
const PS_TIMEOUT_MS = 10000
const LSOF_TIMEOUT_MS = 20000
const HOLDER_RETRIES = 3
const HOLDER_RETRY_MS = 100

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Blocks the thread for ms; for the synchronous callers of resolveHolder.
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
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

const holderError = (code, message) => Object.assign(new Error(message), { code })

// resolveHolder(env) -> {pid, start, how}. TECH_LEAD_HOLDER_PID (tests only) wins over
// CLAUDE_PID, which Claude Code sets for every Bash command to the long-lived claude
// process. The first variable set is the holder: a bad one never falls back to the other.
// Throws code NO_HOLDER ('no-holder: ...') when no variable is set, the one set is not a
// pid, or its process is gone. A live holder whose start token cannot be read (ps failing)
// is read again up to HOLDER_RETRIES times, HOLDER_RETRY_MS apart; if it stays unreadable
// the error is code HOLDER_UNKNOWN ('holder-unknown: ...'), because the holder may well be
// alive and must not be taken for absent.
export function resolveHolder(env = process.env) {
  const how = ['TECH_LEAD_HOLDER_PID', 'CLAUDE_PID'].find(k => env[k] != null && env[k] !== '')
  if (!how) throw holderError('NO_HOLDER', 'no-holder: neither TECH_LEAD_HOLDER_PID nor CLAUDE_PID is set')
  const raw = env[how]
  if (!/^[1-9]\d*$/.test(raw)) throw holderError('NO_HOLDER', `no-holder: ${how}=${JSON.stringify(raw)} is not a pid`)
  const pid = Number(raw)
  let t = startToken(pid)
  for (let retry = 0; t.state === 'unknown' && retry < HOLDER_RETRIES; retry++) {
    sleepSync(HOLDER_RETRY_MS)
    t = startToken(pid)
  }
  if (t.state === 'unknown') throw holderError('HOLDER_UNKNOWN', `holder-unknown: ${how}=${pid} cannot be read (${t.detail})`)
  if (t.state !== 'live') throw holderError('NO_HOLDER', `no-holder: ${how}=${pid} is ${t.state}`)
  return { pid, start: t.token, how }
}

// cwdSweep(dirs, {exclude}) -> {state:'ok', procs:[{pid, cwd, command}]} | {state:'unknown', detail}.
// The live processes, of any user this one may read, whose working directory is one of
// dirs or below one of them; spec 16's sweep for processes still holding files in the
// work area. It reports and never signals. dirs are absolute paths compared by real path,
// and one that does not exist contributes nothing. This process, its parent and every pid
// in exclude are never listed. A listing that cannot be had, or that does not show this
// very process (so it is not a full one), is unknown.
//   darwin: lsof spells the cwd with every byte outside printable ASCII escaped and with
//   the on-disk case; the dirs are spelled the same way and compared without case, so a
//   doubtful spelling only ever adds a process. cwd is reported as lsof printed it.
//   linux: readlink /proc/<pid>/cwd for every numeric entry (see procCwds).
export function cwdSweep(dirs, { exclude = [] } = {}) {
  if (!Array.isArray(dirs) || !dirs.every(d => typeof d === 'string' && path.isAbsolute(d))) {
    return unknown(`bad dirs: ${JSON.stringify(dirs)}`)
  }
  if (!Array.isArray(exclude)) return unknown(`bad exclude: ${JSON.stringify(exclude)}`)
  const roots = []
  for (const d of dirs) {
    try {
      roots.push(fs.realpathSync.native(d))
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue
      return unknown(`realpath ${d}: ${e.code || e.message}`)
    }
  }
  if (roots.length === 0) return { state: 'ok', procs: [] }
  const darwin = process.platform === 'darwin'
  let listing
  if (darwin) listing = lsofCwds()
  else if (process.platform === 'linux') listing = procCwds('/proc')
  else return unknown(`unsupported platform: ${process.platform}`)
  if (listing.state !== 'ok') return listing
  if (!listing.procs.some(p => p.pid === process.pid)) return unknown('the cwd listing does not show this process, so it is not a full one')
  const fold = darwin ? s => s.toLowerCase() : s => s
  const prefixes = roots.map(r => fold(darwin ? lsofSpelling(r) : r))
  const inside = cwd => {
    const c = fold(cwd)
    return prefixes.some(p => c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`))
  }
  const skip = new Set([process.pid, process.ppid, ...(listing.skip ?? []), ...exclude.map(Number)])
  const procs = []
  for (const p of listing.procs) {
    if (skip.has(p.pid) || !inside(p.cwd)) continue
    skip.add(p.pid)
    procs.push({ pid: p.pid, cwd: p.cwd, command: p.command })
  }
  return { state: 'ok', procs }
}

// ancestry(pid = process.pid) -> {state:'ok', pids} | {state:'unknown', detail}: pid and
// each of its ancestors up to (not including) pid 1. darwin: one `ps -A -o pid= -o ppid=`
// listing; linux: the ppid field of /proc/<pid>/stat. A pid whose parent cannot be read
// (one that is gone included) makes the whole chain unknown.
export function ancestry(pid = process.pid) {
  if (!validPid(pid)) return unknown(`bad pid: ${String(pid)}`)
  let parentOf
  if (process.platform === 'linux') {
    parentOf = p => {
      try {
        const text = fs.readFileSync(`/proc/${p}/stat`, 'utf8')
        const ppid = Number(text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
        return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined
      } catch {
        return undefined
      }
    }
  } else {
    const r = spawnSync(PS(), ['-A', '-o', 'pid=', '-o', 'ppid='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' },
    })
    if (r.error || r.status !== 0) return unknown(`ps -A: ${r.error ? r.error.code || r.error.message : `exit ${r.status}`}`)
    const map = new Map()
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
      if (m) map.set(Number(m[1]), Number(m[2]))
    }
    parentOf = p => map.get(p)
  }
  const pids = []
  for (let p = pid; p > 1 && !pids.includes(p);) {
    pids.push(p)
    const ppid = parentOf(p)
    if (ppid === undefined) return unknown(`cannot read the parent of pid ${p}`)
    p = ppid
  }
  return { state: 'ok', pids }
}

// sweepOthers(dirs) -> cwdSweep's result: the processes working in dirs, never this
// process or any of its ancestors (the runner, its shell, a terminal standing in the work
// tree). An ancestry that cannot be read is returned as it is (state unknown), so no sweep
// runs on a partial exclusion list.
export function sweepOthers(dirs) {
  const a = ancestry()
  if (a.state !== 'ok') return a
  return cwdSweep(dirs, { exclude: a.pids })
}

// TECH_LEAD_LSOF replaces /usr/sbin/lsof in tests only.
const LSOF = () => process.env.TECH_LEAD_LSOF || '/usr/sbin/lsof'

// Every process's cwd as lsof prints it ({state:'ok', procs, skip:[lsof's own pid]}). lsof
// exits 1 both when nothing matched and on partial errors, so its exit status says
// nothing; the parsed output decides. It runs in / so that it holds no dir of the sweep.
function lsofCwds() {
  const r = spawnSync(LSOF(), ['-a', '-d', 'cwd', '-F', 'pcn'], {
    cwd: '/', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: LSOF_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  })
  if (r.error) return unknown(`lsof: ${r.error.code || r.error.message}`)
  if (r.status === null) return unknown(`lsof: ended by ${r.signal}`)
  const procs = []
  let cur = null
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue
    const field = line[0], value = line.slice(1)
    if (field === 'p') {
      if (!/^[1-9]\d*$/.test(value)) return unknown(`lsof: bad process line ${JSON.stringify(line)}`)
      cur = { pid: Number(value), command: null }
    } else if (!cur) {
      return unknown(`lsof: ${JSON.stringify(line)} before any process line`)
    } else if (field === 'c') {
      cur.command = value
    } else if (field === 'n') {
      procs.push({ pid: cur.pid, cwd: value, command: cur.command })
    } // f (always printed) and any other field: nothing the sweep needs
  }
  return { state: 'ok', procs, skip: Number.isInteger(r.pid) ? [r.pid] : [] }
}

// How lsof (LC_ALL=C) prints a path, byte by byte: a backslash doubled; \b \t \n \f \r;
// any other control byte as ^ and a letter (a literal ^ stays as it is, so two paths can
// print alike, which only adds matches); every byte from 0x7f up as \x and two lowercase
// hex digits.
const LSOF_ESCAPES = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 92: '\\\\' }
function lsofSpelling(s) {
  let out = ''
  for (const b of Buffer.from(s, 'utf8')) {
    if (LSOF_ESCAPES[b]) out += LSOF_ESCAPES[b]
    else if (b < 0x20) out += `^${String.fromCharCode(b + 0x40)}`
    else if (b < 0x7f) out += String.fromCharCode(b)
    else out += `\\x${b.toString(16).padStart(2, '0')}`
  }
  return out
}

// procCwds(root = '/proc') -> {state:'ok', procs:[{pid, cwd, command}]} | {state:'unknown', detail}.
// Linux: readlink <root>/<pid>/cwd for every numeric entry; command is <root>/<pid>/comm
// (null when unreadable). An entry that is another user's (EACCES) or has exited (ENOENT)
// is skipped; any other error, or no readable root, is unknown. A cwd the kernel marks
// " (deleted)" is reported without the mark, so a process left in a removed directory
// still matches that directory's path. Exported to test it on any host.
export function procCwds(root = '/proc') {
  let names
  try {
    names = fs.readdirSync(root)
  } catch (e) {
    return unknown(`${root}: ${e.code || e.message}`)
  }
  const procs = []
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue
    let cwd
    try {
      cwd = fs.readlinkSync(path.join(root, name, 'cwd'))
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'ENOENT') continue
      return unknown(`${path.join(root, name, 'cwd')}: ${e.code || e.message}`)
    }
    let command = null
    try {
      command = fs.readFileSync(path.join(root, name, 'comm'), 'utf8').replace(/\n$/, '')
    } catch { /* gone or unreadable: the cwd is what the sweep needs */ }
    procs.push({ pid: Number(name), cwd: cwd.replace(/ \(deleted\)$/, ''), command })
  }
  return { state: 'ok', procs }
}
