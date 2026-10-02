// scripts/lib/git-safe.mjs
// The loop's own git calls in its work area (spec 16): no hooks, no fsmonitor, no
// untracked cache, no replace refs, no inherited GIT_* variable that redirects git to
// another repository, index or object store, and no config passed in through the
// environment the way -c passes it (GIT_CONFIG_PARAMETERS, or GIT_CONFIG_COUNT with its
// GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>). The config files git reads still apply,
// apart from the three overrides below: the repository's own, and the system and global
// files, which GIT_CONFIG_SYSTEM, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, HOME and
// XDG_CONFIG_HOME still choose (later stages need the user's identity from them).
import { spawnSync } from 'node:child_process'

const DROPPED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
]
// Every GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>, whatever follows the prefix.
const DROPPED_PREFIX = /^GIT_CONFIG_(KEY|VALUE)_/
const OVERRIDES = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']

function safeEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (DROPPED.includes(k) || DROPPED_PREFIX.test(k)) delete env[k]
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
