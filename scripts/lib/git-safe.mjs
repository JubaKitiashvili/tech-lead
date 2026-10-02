// scripts/lib/git-safe.mjs
// The loop's own git calls in its work area (spec 16): no hooks, no fsmonitor, no
// untracked cache, no replace refs, and no inherited GIT_* variable that redirects git to
// another repository, index or object store, or injects config.
import { spawnSync } from 'node:child_process'

const DROPPED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS',
]
const OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']

function safeEnv() {
  const env = { ...process.env }
  for (const k of DROPPED) delete env[k]
  return Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' })
}

// Runs `git -C <cwd> <overrides> <args>` and returns stdout without its one trailing
// newline. Throws with git's stderr in the message on a non-zero exit.
export function safeGit(cwd, args, { input } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...OVERRIDES, ...args], {
    encoding: 'utf8', env: safeEnv(), input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  })
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) {
    const how = r.status === null ? `signal ${r.signal}` : `exit ${r.status}`
    const err = new Error(`git ${args.join(' ')} failed (${how}): ${r.stderr.trim()}`)
    err.status = r.status
    err.stderr = r.stderr
    throw err
  }
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout
}
