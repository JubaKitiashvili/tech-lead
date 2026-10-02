// tests/fixtures/spawn-hook.cjs
// A --require preload for the exec wrapper and the lock CLI (tests/loop/loop-lock-exec.test.mjs)
// at the boundaries a crash or a racer can hit.
//   Its first child_process.spawn: with SPAWN_HOOK_OUT set it appends, as one JSON line, the
//   names in SPAWN_HOOK_DIR at that moment (what is on record before the command's process
//   exists). SPAWN_HOOK_KILL=before|after SIGKILLs the process just before or just after
//   that spawn.
//   Its first fs.linkSync into LINK_HOOK_DIR (a child record landing): right after it, the
//   file LINK_HOOK_WRITE is created, as a racing acquire would write a closing marker
//   between the record and the registration's second hold check.
// Nothing else is changed.
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')

const spawn = cp.spawn
let first = true
cp.spawn = (...args) => {
  const hook = first
  first = false
  if (hook && process.env.SPAWN_HOOK_OUT) {
    let names = []
    try {
      names = fs.readdirSync(process.env.SPAWN_HOOK_DIR).filter(n => !n.startsWith('.')).sort()
    } catch { /* no directory yet: nothing on record */ }
    fs.appendFileSync(process.env.SPAWN_HOOK_OUT, `${JSON.stringify(names)}\n`)
  }
  if (hook && process.env.SPAWN_HOOK_KILL === 'before') process.kill(process.pid, 'SIGKILL')
  const child = spawn(...args)
  if (hook && process.env.SPAWN_HOOK_KILL === 'after') process.kill(process.pid, 'SIGKILL')
  return child
}

const linkSync = fs.linkSync
let linked = false
fs.linkSync = (from, to, ...rest) => {
  const out = linkSync(from, to, ...rest)
  if (!linked && process.env.LINK_HOOK_DIR && path.dirname(String(to)) === process.env.LINK_HOOK_DIR) {
    linked = true
    fs.writeFileSync(process.env.LINK_HOOK_WRITE, '{}\n')
  }
  return out
}
syncBuiltinESMExports()
