// tests/fixtures/fsync-hook.cjs
// A --require preload (passed through NODE_OPTIONS) for the R31 publication tests: the holder of
// the firing lock is killed while a helper fsyncs a temporary file it is about to publish, the
// window between the caller's own lock check and the rename or link that publishes the file.
//   FSYNC_HOOK_DIR    the directory whose entries are watched
//   FSYNC_HOOK_MATCH  a regular expression over entry names (default ^\.tmp-)
//   FSYNC_HOOK_NTH    the nth fsync of a watched entry fires the hook (default 1)
//   FSYNC_HOOK_KILL   the pid then sent SIGKILL; the hook waits (10 s at most) until it is gone
//   FSYNC_HOOK_OUT    when set, the file that gets one line '<entry name>' when the hook fires
// An fsync counts when its descriptor is the file of a matching entry (same device and inode).
// The fsync itself runs first; only fs.fsyncSync is wrapped and nothing else changes.
const fs = require('node:fs')
const path = require('node:path')

const dir = process.env.FSYNC_HOOK_DIR
const match = new RegExp(process.env.FSYNC_HOOK_MATCH || '^\\.tmp-')
const nth = Number(process.env.FSYNC_HOOK_NTH || '1')
const victim = Number(process.env.FSYNC_HOOK_KILL || '0')
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

const gone = pid => {
  try { process.kill(pid, 0) } catch (e) { return e.code === 'ESRCH' }
  return false
}

fs.fsyncSync = (fd, ...rest) => {
  const out = fsyncSync(fd, ...rest)
  if (dir && !fired) {
    const name = watched(fd)
    if (name !== null && ++seen === nth) {
      fired = true
      if (process.env.FSYNC_HOOK_OUT) fs.appendFileSync(process.env.FSYNC_HOOK_OUT, `${name}\n`)
      if (victim > 0) {
        try { process.kill(victim, 'SIGKILL') } catch { /* already gone */ }
        const deadline = Date.now() + 10000
        while (!gone(victim) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
  }
  return out
}
