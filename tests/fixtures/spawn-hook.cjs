// tests/fixtures/spawn-hook.cjs
// A --require preload for the exec wrapper (tests/loop/loop-lock-exec.test.mjs) at the
// boundary a crash can hit: its first child_process.spawn. With SPAWN_HOOK_OUT set it
// appends, as one JSON line, the names in SPAWN_HOOK_DIR at that moment (what is on record
// before the command's process exists). SPAWN_HOOK_KILL=before|after SIGKILLs the wrapper
// just before or just after that spawn. Nothing else is changed.
const cp = require('node:child_process')
const fs = require('node:fs')
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
syncBuiltinESMExports()
