// scripts/lib/git-safe.mjs
// The loop's own git calls (spec 16): no hooks, no fsmonitor, no untracked cache, no replace
// refs, no inherited GIT_* variable that redirects git to another repository, index, object
// store, transport, external diff, pathspec mode, exec path or identity date, no config
// passed in through the environment the way -c passes it (GIT_CONFIG_PARAMETERS, or
// GIT_CONFIG_COUNT with its GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>), and no trace variable
// (GIT_TRACE*, GIT_TRACE2* included), whose output on stderr a caller would read as git's own
// message (checkClone reads a for-each-ref warning as a problem, and some error messages are
// built from the first stderr line). The three trace2 targets are pinned off (GIT_TRACE2,
// GIT_TRACE2_PERF and GIT_TRACE2_EVENT = 0), since trace2.normalTarget, trace2.perfTarget and
// trace2.eventTarget in the system or global config turn them on without any variable, and
// the variable wins over the config. The config files git
// reads still apply, apart from the fixed overrides below: the repository's own, and the system
// and global files, which GIT_CONFIG_SYSTEM, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, HOME and
// XDG_CONFIG_HOME still choose (the owner's identity, filters and eol settings come from them).
//
// safeGit runs git in a repository the owner works in (`-C <cwd>`). workGit runs git in the
// loop's clone <W>, with cwd <W>, GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR pinned to it and the
// wider WORK_OVERRIDES (submodule.recurse=false among them, so no git command recurses into a
// nested repository, R26). cloneRepo makes that clone.
//
// workGit's quick structural check (Cg1#1): before it spawns anything, <W>/.git must be a real
// directory, and each of its storage paths that git writes (objects, objects/pack, objects/info,
// refs, refs/heads, refs/tags and logs as directories; HEAD, index, packed-refs and config as
// regular files) must be what it should be when present, never a symlink; no entry directly in
// objects may be a symlink. A failure throws `clone-invalid: <W>/.git/<path> is <kind>` (code
// CLONE_INVALID), so a delegate that pointed the clone's object store or refs at <P> cannot make
// a helper write there. clone-check's checkClone walks the same paths in full.
//
// Attribute isolation (R24): attrSourceWorks(W) feature-tests, once per process (per PATH),
// that git honours GIT_ATTR_SOURCE (a name that resolves to nothing is fatal, the empty tree is
// accepted); assertAttrSource(W) throws code REFUSED, state 'infra', detail GIT_TOO_OLD when it
// does not, so a helper that relies on the isolation refuses instead of running unisolated.
//
// Options (safeGit, workGit, workGitRun), applied after the scrub so an inherited variable
// never wins: input (string | Buffer, stdin), indexFile (absolute path -> GIT_INDEX_FILE),
// buffer (stdout as a Buffer, nothing stripped), outFd (stdout goes to that descriptor and ''
// is returned), config (['key=value', ...] passed as -c after the fixed overrides, so a later
// value wins), timeoutMs (git is stopped with SIGTERM and the call throws code TIMEOUT; none by
// default for safeGit, 540000 for workGit), env (extra variables, set last; undefined unsets).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DROPPED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_ASKPASS',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_QUARANTINE_PATH', 'GIT_ATTR_SOURCE',
  'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_LITERAL_PATHSPECS',
  'GIT_EXEC_PATH', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE',
]
// Every GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>, whatever follows the prefix, and every
// trace variable (GIT_TRACE, GIT_TRACE_<what>, GIT_TRACE2, GIT_TRACE2_<what>). opts.env, set
// last, can still turn tracing on for one call, or unset a TRACE2_OFF pin so the config applies
// (the loop-clone passthrough hands the caller's own trace back to the caller's git command).
const DROPPED_PREFIX = /^(?:GIT_CONFIG_(?:KEY|VALUE)_|GIT_TRACE)/
// Set in every fixed environment after the scrub: trace2 off whatever the config says.
const TRACE2_OFF = Object.freeze({ GIT_TRACE2: '0', GIT_TRACE2_PERF: '0', GIT_TRACE2_EVENT: '0' })
const OVERRIDES = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false']

// The fixed config for every git call in <W>, in this order, before the caller's config.
export const WORK_OVERRIDES = Object.freeze([
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'core.pager=cat',
  'color.ui=never', 'commit.gpgSign=false', 'tag.gpgSign=false', 'gc.auto=0', 'maintenance.auto=false',
  'repack.updateServerInfo=false', 'protocol.allow=never', 'protocol.file.allow=always',
  'core.safecrlf=false', 'index.sparse=false', 'core.sparseCheckout=false', 'core.quotePath=true',
  'submodule.recurse=false',
])
const WORK_TIMEOUT_MS = 540000
// clone.defaultRemoteName=origin: the owner's global name would leave remote.<name> and
// refs/remotes/<name>/ in the clone, which normalize does not remove and checkClone refuses (F2).
const CLONE_OVERRIDES = [
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'protocol.allow=never', 'protocol.file.allow=always',
  'clone.defaultRemoteName=origin',
]
// The porcelain commands that would run an external diff driver or a textconv filter.
const DIFF_PORCELAIN = new Set(['diff', 'log', 'show'])
const NO_EXT = ['--no-ext-diff', '--no-textconv']
const MAX_BUFFER = 256 * 1024 * 1024

const asConfig = list => list.flatMap(kv => ['-c', kv])

function scrubbedEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (DROPPED.includes(k) || DROPPED_PREFIX.test(k)) delete env[k]
  return env
}

// The scrubbed environment plus `fixed`, then the options' variables on top.
function buildEnv(fixed, opts) {
  const env = Object.assign(scrubbedEnv(), fixed)
  if (opts.indexFile !== undefined) {
    if (typeof opts.indexFile !== 'string' || !path.isAbsolute(opts.indexFile)) {
      throw new TypeError(`git-safe: indexFile must be an absolute path, got ${JSON.stringify(opts.indexFile)}`)
    }
    env.GIT_INDEX_FILE = opts.indexFile
  }
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined) delete env[k]
    else env[k] = String(v)
  }
  return env
}

function configArgs(opts) {
  const list = opts.config || []
  if (!Array.isArray(list) || !list.every(kv => typeof kv === 'string')) {
    throw new TypeError('git-safe: config must be an array of "key=value" strings')
  }
  return asConfig(list)
}

// One spawn. Returns {status, signal, stdout, stderr} with stderr as text and stdout as a
// Buffer (buffer), '' (outFd) or text without its one trailing newline; on a run that did not
// complete, also {code, error}: code 'TIMEOUT' or the spawn error's code.
function spawnGit(argv, label, { cwd, env, opts }) {
  const outFd = opts.outFd
  const r = spawnSync('git', argv, {
    cwd, env, input: opts.input, stdio: ['pipe', outFd === undefined ? 'pipe' : outFd, 'pipe'],
    maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs || undefined, killSignal: 'SIGTERM',
  })
  const stderr = r.stderr ? r.stderr.toString('utf8') : ''
  let stdout
  if (outFd !== undefined) stdout = ''
  else if (opts.buffer) stdout = r.stdout || Buffer.alloc(0)
  else {
    stdout = r.stdout ? r.stdout.toString('utf8') : ''
    if (stdout.endsWith('\n')) stdout = stdout.slice(0, -1)
  }
  const res = { status: r.status, signal: r.signal, stdout, stderr }
  if (r.error) {
    const timedOut = r.error.code === 'ETIMEDOUT'
    res.code = timedOut ? 'TIMEOUT' : (r.error.code || 'SPAWN')
    res.error = timedOut ? `git ${label} timed out after ${opts.timeoutMs} ms` : `git ${label}: ${r.error.message}`
  }
  return res
}

// Throws the error a failed run describes, or returns its stdout.
function settle(res, label) {
  if (res.code) {
    const err = new Error(res.error)
    err.code = res.code
    err.status = res.status
    err.signal = res.signal
    err.stderr = res.stderr
    throw err
  }
  if (res.status !== 0) {
    const how = res.status === null ? `signal ${res.signal}` : `exit ${res.status}`
    const err = new Error(`git ${label} failed (${how}): ${res.stderr.trim()}`)
    err.status = res.status
    err.signal = res.signal
    err.stderr = res.stderr
    throw err
  }
  return res.stdout
}

// Runs `git -C <cwd> <overrides> <config> <args>` and returns stdout without its one trailing
// newline (or as a Buffer with `buffer`, or '' with `outFd`). Throws with git's stderr in the
// message on a non-zero exit, and with code 'TIMEOUT' when timeoutMs passes.
export function safeGit(cwd, args, opts = {}) {
  const env = buildEnv({ GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...TRACE2_OFF }, opts)
  const argv = ['-C', cwd, ...asConfig(OVERRIDES), ...configArgs(opts), ...args]
  const label = args.join(' ')
  return settle(spawnGit(argv, label, { env, opts }), label)
}

function cloneInvalid(W, why) {
  const err = new Error(`clone-invalid: ${W}/.git is not a directory${why ? ` (${why})` : ''}`)
  err.code = 'CLONE_INVALID'
  return err
}

function storageInvalid(W, rel, what) {
  return Object.assign(new Error(`clone-invalid: ${W}/.git/${rel} is ${what}`), { code: 'CLONE_INVALID' })
}

// The storage paths of the quick structural check: directories, then regular files.
export const STORAGE_DIRS = Object.freeze(['objects', 'objects/pack', 'objects/info', 'refs', 'refs/heads', 'refs/tags', 'logs'])
export const STORAGE_FILES = Object.freeze(['HEAD', 'index', 'packed-refs', 'config'])

const kindName = st => (st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : st.isFile() ? 'a regular file' : 'a special file')

// Throws CLONE_INVALID when a storage path of gitDir is not what git expects to write through.
function quickCheck(W, gitDir) {
  const look = rel => {
    try { return fs.lstatSync(path.join(gitDir, rel)) } catch (e) {
      if (e.code === 'ENOENT') return null
      throw storageInvalid(W, rel, `unreadable (${e.code})`)
    }
  }
  for (const rel of STORAGE_DIRS) {
    const st = look(rel)
    if (st && !st.isDirectory()) throw storageInvalid(W, rel, kindName(st))
  }
  for (const rel of STORAGE_FILES) {
    const st = look(rel)
    if (st && !st.isFile()) throw storageInvalid(W, rel, kindName(st))
  }
  let entries = []
  try { entries = fs.readdirSync(path.join(gitDir, 'objects'), { withFileTypes: true }) } catch (e) {
    if (e.code !== 'ENOENT') throw storageInvalid(W, 'objects', `unreadable (${e.code})`)
  }
  for (const e of entries) if (e.isSymbolicLink()) throw storageInvalid(W, `objects/${e.name}`, 'a symlink')
}

// The checked spawn plan for <W>: refuses unless <W>/.git is a real directory (not a gitfile,
// not a symlink, present) and its storage paths pass the quick structural check.
function workPlan(W, args, opts) {
  const dir = path.resolve(W)
  const gitDir = path.join(dir, '.git')
  let st
  try { st = fs.lstatSync(gitDir) } catch (e) { throw cloneInvalid(W, e.code) }
  if (!st.isDirectory()) throw cloneInvalid(W, '')
  quickCheck(W, gitDir)
  const env = buildEnv({
    GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_COMMON_DIR: gitDir, GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: ':', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0', ...TRACE2_OFF,
  }, opts)
  const cmd = DIFF_PORCELAIN.has(args[0]) ? [args[0], ...NO_EXT, ...args.slice(1)] : args
  const argv = [...asConfig(WORK_OVERRIDES), ...configArgs(opts), ...cmd]
  const timeoutMs = opts.timeoutMs === undefined ? WORK_TIMEOUT_MS : opts.timeoutMs
  return { argv, label: args.join(' '), cwd: dir, env, opts: { ...opts, timeoutMs } }
}

// git in the loop's clone <W>: cwd <W> (no -C), the pinned repository variables, then
// WORK_OVERRIDES and the caller's config. diff, log and show also get --no-ext-diff
// --no-textconv right after the subcommand. Returns and throws as safeGit; a <W>/.git that
// is not a real directory throws `clone-invalid: ...` with code CLONE_INVALID.
export function workGit(W, args, opts = {}) {
  const plan = workPlan(W, args, opts)
  return settle(spawnGit(plan.argv, plan.label, plan), plan.label)
}

// workGit that never throws: {status, signal, stdout, stderr}, plus {code, error} when git did
// not run to an exit (code CLONE_INVALID, TIMEOUT, or the spawn error's code; status null).
export function workGitRun(W, args, opts = {}) {
  let plan
  try { plan = workPlan(W, args, opts) } catch (e) {
    return { status: null, signal: null, stdout: opts.buffer ? Buffer.alloc(0) : '', stderr: '', code: e.code || 'USAGE', error: e.message }
  }
  return spawnGit(plan.argv, plan.label, plan)
}

// ---------------------------------------------------------------- attribute isolation (R24)

export const GIT_TOO_OLD = 'git-too-old: needs git 2.40 or newer'
const ATTR_PROBE = new Map()
const PROBE_PATH = 'tech-lead-attr-probe'
const MISSING_SOURCE = 'refs/tech-lead/no-such-attr-source'

// true when the git on PATH honours GIT_ATTR_SOURCE: a source that names nothing is fatal and
// the empty tree is accepted (a git that ignores the variable accepts both). Probed once per
// process and PATH with two read-only check-attr runs in W; a git that cannot be run throws.
export function attrSourceWorks(W) {
  const k = process.env.PATH ?? ''
  if (ATTR_PROBE.has(k)) return ATTR_PROBE.get(k)
  const run = (env, args = ['check-attr', '-a', '--', PROBE_PATH]) => {
    const r = workGitRun(W, args, { env })
    if (r.code) throw Object.assign(new Error(r.error), { code: r.code })
    return r
  }
  const empty = run({}, ['hash-object', '-t', 'tree', '--stdin'])
  if (empty.status !== 0) throw new Error(`git hash-object failed (exit ${empty.status}): ${empty.stderr.trim()}`)
  const bad = run({ GIT_ATTR_SOURCE: MISSING_SOURCE })
  const good = run({ GIT_ATTR_SOURCE: empty.stdout.trim() })
  const works = bad.status !== 0 && good.status === 0
  ATTR_PROBE.set(k, works)
  return works
}

// Throws code REFUSED {state: 'infra', detail: GIT_TOO_OLD} unless attrSourceWorks(W).
export function assertAttrSource(W) {
  if (!attrSourceWorks(W)) throw Object.assign(new Error(GIT_TOO_OLD), { code: 'REFUSED', state: 'infra', detail: GIT_TOO_OLD })
}

// A full clone of `src` into the existing empty directory `dest` (made mode 0700 by the
// caller): objects copied by the transport (--no-local), nothing checked out, no submodules,
// the template directory's content only (an empty one gives no hooks/ and no info/), the remote
// named origin and the files ref backend whatever the owner's clone.defaultRemoteName,
// init.defaultRefFormat or GIT_DEFAULT_REF_FORMAT say (the storage checks need refs/heads as a
// directory; GIT_DEFAULT_REF_FORMAT wins over the config, and a git older than 2.45 ignores it).
export function cloneRepo(src, dest, { templateDir, timeoutMs = WORK_TIMEOUT_MS } = {}) {
  if (typeof templateDir !== 'string' || templateDir === '') throw new TypeError('git-safe: cloneRepo needs a templateDir')
  const env = buildEnv({ GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_DEFAULT_REF_FORMAT: 'files', ...TRACE2_OFF }, {})
  const argv = [...asConfig(CLONE_OVERRIDES), 'clone', '--no-local', '--no-checkout', '--no-recurse-submodules',
    `--template=${templateDir}`, '-q', '--', src, dest]
  const label = `clone ${src} ${dest}`
  return settle(spawnGit(argv, label, { env, opts: { timeoutMs } }), label)
}
