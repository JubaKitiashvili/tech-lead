// tests/fixtures/fsync-hook.cjs
// A --require preload (passed through NODE_OPTIONS) for the R31 publication tests: the holder of
// the firing lock is killed while a helper fsyncs a temporary file it is about to publish, the
// window between the caller's own lock check and the rename or link that publishes the file.
//   FSYNC_HOOK_DIR    the directory whose entries are watched
//   FSYNC_HOOK_MATCH  a regular expression over entry names (default ^\.tmp-)
//   FSYNC_HOOK_NTH    the nth fsync of a watched entry fires the hook (default 1)
//   FSYNC_HOOK_KILL   the pid then sent SIGKILL; the hook waits (10 s at most) until it is gone
//   FSYNC_HOOK_KILL_START  that process's start token (scripts/lib/loop-proc.mjs startToken):
//                     the pid is signalled only while its token, read again right before the
//                     kill, is this one, so a pid that exited and was reused during a long
//                     fsync is never killed (Codex f2 #3); without it nothing is killed
//   FSYNC_HOOK_OUT    when set, the file that gets one line when the hook fires: '<entry name>'
//                     when it killed, '<entry name> no-kill: <why>' when the identity did not
//                     match
// An fsync counts when its descriptor is the file of a matching entry (same device and inode).
// The fsync itself runs first; only fs.fsyncSync is wrapped and nothing else changes.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const dir = process.env.FSYNC_HOOK_DIR
const match = new RegExp(process.env.FSYNC_HOOK_MATCH || '^\\.tmp-')
const nth = Number(process.env.FSYNC_HOOK_NTH || '1')
const victim = Number(process.env.FSYNC_HOOK_KILL || '0')
const victimStart = process.env.FSYNC_HOOK_KILL_START || null
const fsyncSync = fs.fsyncSync
let seen = 0
let fired = false

// The name of the matching entry of dir that is fd's file, or null.
function watched(fd) {
  let st
  try { st = fs.fstatSync(fd) } catch { return null }
  if (!st.isFile()) return null
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const name of names) {
    if (!match.test(name)) continue
    try {
      const e = fs.lstatSync(path.join(dir, name))
      if (e.dev === st.dev && e.ino === st.ino) return name
    } catch { /* gone since the listing */ }
  }
  return null
}

// The start token of pid, read from the source scripts/lib/loop-proc.mjs startToken reads
// (darwin: ps lstart under LC_ALL=C and TZ=UTC, TECH_LEAD_PS in tests; linux: /proc starttime
// with the boot id), in its format: 'gone' for no process or a zombie, null when unreadable.
function tokenOf(pid) {
  try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') return 'gone'; if (e.code !== 'EPERM') return null }
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync(process.env.TECH_LEAD_PS || '/bin/ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      })
      const m = r.status === 0 ? /^(\S+)\s+(\S.*)$/.exec(r.stdout.trim()) : null
      if (!m) return null
      return m[1].startsWith('Z') ? 'gone' : `darwin:${m[2].replace(/\s+/g, ' ')}`
    }
    if (process.platform === 'linux') {
      const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)
      if (fields[0] === 'Z') return 'gone'
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return /^\d+$/.test(fields[19] ?? '') ? `linux:${boot}:${fields[19]}` : null
    }
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone'
  }
  return null
}

fs.fsyncSync = (fd, ...rest) => {
  const out = fsyncSync(fd, ...rest)
  if (dir && !fired) {
    const name = watched(fd)
    if (name !== null && ++seen === nth) {
      fired = true
      let line = name
      if (victim > 0) {
        // The identity is read immediately before the kill; anything but the live, matching
        // token (gone, unreadable, another process, or no token given) kills nothing.
        const now = tokenOf(victim)
        if (victimStart !== null && now === victimStart) {
          try { process.kill(victim, 'SIGKILL') } catch { /* already gone */ }
          const deadline = Date.now() + 10000
          while (tokenOf(victim) === victimStart && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        } else line = `${name} no-kill: pid ${victim} reads ${now ?? 'unreadable'}, not ${victimStart ?? '(no FSYNC_HOOK_KILL_START)'}`
      }
      if (process.env.FSYNC_HOOK_OUT) fs.appendFileSync(process.env.FSYNC_HOOK_OUT, `${line}\n`)
    }
  }
  return out
}
