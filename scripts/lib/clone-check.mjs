// scripts/lib/clone-check.mjs
// Integrity of the loop's clone <W> (brief 13.1; spec 7.5 and 16). Read-only: nothing here
// writes to <W>, and every git call goes through workGit, so its fixed overrides apply (no
// hook, fsmonitor, pager or external diff runs whatever <W>'s config says).
//
// checkClone(W) -> {problems}: [] for a clone the loop may use; otherwise one ASCII-led line
// per problem found, in a fixed order (.git itself; the forbidden special files; the storage
// paths; .git/info; the config; the refs; HEAD). A .git that is not a real directory is the
// only problem reported, since nothing else can be read safely; a storage problem (or a config
// that is not a regular file) stops the checks that need git (config, refs, HEAD), since workGit
// refuses such a clone.
// Storage paths (Cg1#1): every path git writes through, walked with lstat from .git down so no
// symlinked or escaped ancestor is followed: objects (a real directory), each entry in it and
// each entry of its subdirectories (no symlink anywhere at those depths; the loose-object and
// pack directories, objects/pack and objects/info real directories); refs and logs, walked
// whole (no symlink, no special file; a reflog, which git appends to in place, must have one
// link); HEAD, index and packed-refs regular files when present. The real path of each storage
// directory must be the one under the real .git.
// cloneMeta(W) -> sha256 hex over the config as git parses it minus core.hookspath, the
// .git/info listing, the presence of each forbidden special file and the identity (kind,
// device and inode) of .git and its storage directories objects, objects/pack, objects/info
// and refs, which git never replaces: a directory put in their place changes it. A dependency
// install may set core.hookspath and write .git/hooks (husky, lefthook, pre-commit); neither
// counts.
// refsSnapshot(W) -> {refs: {"<refname>": "<object id>"}} for every ref, allowed or not.
import fs from 'node:fs'
import path from 'node:path'
import { workGit, workGitRun } from './git-safe.mjs'
import { canonicalJson, sha256Hex } from './canonical.mjs'

// Paths under .git that make git read another repository, object store, history or config.
export const SPECIAL_FILES = Object.freeze([
  'commondir', 'gitdir', 'config.worktree', 'worktrees', 'modules', 'shallow',
  'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates',
])

// The only keys .git/config may hold, as `git config --list` prints them (section and
// variable lower-cased). core.bare must also be false.
export const CONFIG_KEYS = Object.freeze([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'core.hookspath',
  'extensions.objectformat', 'extensions.refstorage',
])
const ALLOWED_KEYS = new Set(CONFIG_KEYS)
const HOOKSPATH = 'core.hookspath'
// The spellings git reads as false for a boolean (an empty value given with `=` included).
const FALSE_VALUES = new Set(['false', 'no', 'off', '0', ''])

// A prefix segment as loop-start's validPrefix allows it, then the UTC date.
const SEG = '[A-Za-z0-9][A-Za-z0-9._-]*'
const DATE = '[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])'
export const DATED_BRANCH_RE = new RegExp(`^refs/heads/(?:${SEG}/)+${DATE}$`)

const refAllowed = ref =>
  DATED_BRANCH_RE.test(ref) ||
  (ref.startsWith('refs/remotes/origin/') && ref.length > 'refs/remotes/origin/'.length) ||
  (ref.startsWith('refs/tags/') && ref.length > 'refs/tags/'.length) ||
  ref === 'refs/tech-lead/base' ||
  (ref.startsWith('refs/tech-lead/retired/') && ref.length > 'refs/tech-lead/retired/'.length)

const lstatOrNull = p => {
  try { return fs.lstatSync(p) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  }
}

const kindOf = st => {
  if (!st) return 'missing'
  if (st.isDirectory()) return 'directory'
  if (st.isSymbolicLink()) return 'symlink'
  if (st.isFile()) return 'file'
  return 'special file'
}

// The first line of git's stderr, for a one-line problem.
const firstLine = text => (String(text || '').trim().split('\n')[0] || '').trim()
// git's own diagnostics on stderr ('warning: ...', 'error: ...', 'fatal: ...'), one per line.
// Anything else there (trace2 targets set in the global config, which no scrub of the
// environment removes) is not git speaking about the repository.
const GIT_MESSAGE = /^(?:warning|error|fatal): /
const gitMessages = text => String(text || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => GIT_MESSAGE.test(l))

// The storage directories whose identity cloneMeta records.
export const STORAGE_IDENTITY = Object.freeze(['objects', 'objects/pack', 'objects/info', 'refs'])
const kindPhrase = st => (st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : st.isFile() ? 'a regular file' : 'a special file')

// The problems of the storage paths under gitDir (see the header), in a fixed order.
function storageProblems(gitDir) {
  const problems = []
  const look = rel => {
    try { return fs.lstatSync(path.join(gitDir, rel)) } catch (e) {
      if (e.code === 'ENOENT') return null
      problems.push(`.git/${rel} is unreadable: ${e.code}`)
      return undefined
    }
  }
  const realGit = (() => { try { return fs.realpathSync.native(gitDir) } catch { return null } })()
  const escaped = rel => {
    let real
    try { real = fs.realpathSync.native(path.join(gitDir, rel)) } catch { return false }
    return realGit !== null && real !== path.join(realGit, rel)
  }
  // Every entry below rel, depth levels deep at most (Infinity: the whole tree).
  const walk = (rel, depth, onFile) => {
    let entries
    try { entries = fs.readdirSync(path.join(gitDir, rel), { withFileTypes: true }) } catch (e) {
      problems.push(`.git/${rel} is unreadable: ${e.code}`)
      return
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = `${rel}/${e.name}`
      if (e.isSymbolicLink()) problems.push(`.git/${r} is a symlink`)
      else if (e.isDirectory()) { if (depth > 1) walk(r, depth - 1, onFile) }
      else if (e.isFile()) onFile?.(r)
      else problems.push(`.git/${r} is a special file`)
    }
  }
  const dir = (rel, required) => {
    const st = look(rel)
    if (st === undefined) return false
    if (st === null) {
      if (required) problems.push(`.git/${rel} is missing`)
      return false
    }
    if (!st.isDirectory()) {
      problems.push(`.git/${rel} is ${kindPhrase(st)}`)
      return false
    }
    if (escaped(rel)) {
      problems.push(`.git/${rel} resolves outside .git`)
      return false
    }
    return true
  }
  if (dir('objects', true)) {
    walk('objects', 2)
    for (const sub of ['objects/pack', 'objects/info']) dir(sub, false)
  }
  if (dir('refs', true)) walk('refs', Infinity)
  if (dir('logs', false)) {
    walk('logs', Infinity, rel => {
      const st = look(rel)
      if (st && st.nlink > 1) problems.push(`.git/${rel} has ${st.nlink} links`)
    })
  }
  for (const rel of ['HEAD', 'index', 'packed-refs']) {
    const st = look(rel)
    if (st && st.isSymbolicLink()) problems.push(`.git/${rel} is a symlink`)
    else if (st && !st.isFile()) problems.push(`.git/${rel} is not a regular file (${kindPhrase(st)})`)
  }
  return problems
}

// {kind, dev, ino} of .git and each STORAGE_IDENTITY directory, as strings.
function storageIdentity(gitDir) {
  const out = {}
  for (const rel of ['.', ...STORAGE_IDENTITY]) {
    let st = null
    try { st = fs.lstatSync(path.join(gitDir, rel)) } catch { st = null }
    out[rel] = st ? `${kindOf(st)}:${st.dev}:${st.ino}` : 'missing'
  }
  return out
}

function cloneInvalid(W, why) {
  const err = new Error(`clone-invalid: ${W}/.git is not a directory (${why})`)
  err.code = 'CLONE_INVALID'
  return err
}

// The absolute <W>/.git when it is a real directory, else null and the kind found.
function gitDirOf(W) {
  const gitDir = path.join(path.resolve(W), '.git')
  let st
  try { st = fs.lstatSync(gitDir) } catch (e) { return { gitDir: null, kind: e.code === 'ENOENT' ? 'missing' : `unreadable: ${e.code}` } }
  return st.isDirectory() ? { gitDir, kind: 'directory' } : { gitDir: null, kind: kindOf(st) }
}

// `git config --file <gitDir>/config --no-includes --list -z` as raw entries
// ({key, value: Buffer | null, raw: Buffer}), or {error} when git cannot parse the file.
function configEntries(W, gitDir) {
  const r = workGitRun(W, ['config', '--file', path.join(gitDir, 'config'), '--no-includes', '--list', '-z'], { buffer: true })
  if (r.code || r.status !== 0) return { error: r.error || firstLine(r.stderr) || `git config exited ${r.status}` }
  const entries = []
  let start = 0
  const out = r.stdout
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue
    const raw = out.subarray(start, i)
    const nl = raw.indexOf(0x0a)
    const keyBytes = nl < 0 ? raw : raw.subarray(0, nl)
    entries.push({ key: keyBytes.toString('utf8'), value: nl < 0 ? null : raw.subarray(nl + 1), raw })
    start = i + 1
  }
  return { entries }
}

// checkClone(W) -> {problems: string[]}; [] when <W> is a clone the loop may use.
export function checkClone(W) {
  const problems = []
  const { gitDir, kind } = gitDirOf(W)
  if (!gitDir) return { problems: [`.git is not a real directory (${kind === 'file' ? 'a file' : kind === 'symlink' ? 'a symlink' : kind})`] }

  for (const name of SPECIAL_FILES) {
    if (lstatOrNull(path.join(gitDir, name))) problems.push(`.git/${name} exists`)
  }

  const storage = storageProblems(gitDir)
  problems.push(...storage)

  const infoDir = path.join(gitDir, 'info')
  const infoSt = lstatOrNull(infoDir)
  if (infoSt && !infoSt.isDirectory()) problems.push(`.git/info is not a directory (${kindOf(infoSt)})`)
  else if (infoSt) {
    let names
    try { names = fs.readdirSync(infoDir).sort() } catch (e) { names = null; problems.push(`.git/info is unreadable: ${e.code}`) }
    if (names && names.length) problems.push(`.git/info is not empty: ${names.join(', ')}`)
  }

  const cfgSt = lstatOrNull(path.join(gitDir, 'config'))
  // workGit refuses a clone whose storage paths are unsafe: nothing below needs git then.
  if (storage.length) return { problems }
  if (!cfgSt) problems.push('.git/config is missing')
  else if (!cfgSt.isFile()) problems.push(`.git/config is not a regular file (${kindOf(cfgSt) === 'symlink' ? 'a symlink' : kindOf(cfgSt)})`)
  else {
    const cfg = configEntries(W, gitDir)
    if (cfg.error) problems.push(`config unreadable: ${cfg.error}`)
    else {
      for (const { key, value } of cfg.entries) {
        if (!ALLOWED_KEYS.has(key)) problems.push(`config key not allowed: ${key}`)
        else if (key === 'core.bare' && (value === null || !FALSE_VALUES.has(value.toString('utf8').trim().toLowerCase()))) {
          problems.push('config core.bare is not false')
        }
      }
    }
  }

  // A config that is not a regular file makes workGit refuse too: the ref and HEAD reads would
  // only repeat that refusal.
  if (cfgSt && !cfgSt.isFile()) return { problems }

  const refs = workGitRun(W, ['for-each-ref', '--format=%(refname)'])
  if (refs.code || refs.status !== 0) problems.push(`refs unreadable: ${refs.error || firstLine(refs.stderr)}`)
  else {
    // git skips a broken ref or a ref with a malformed name with a warning; neither is allowed.
    for (const warning of gitMessages(refs.stderr)) problems.push(`refs: ${warning}`)
    for (const ref of refs.stdout.split('\n')) {
      if (ref && !refAllowed(ref)) problems.push(`ref not allowed: ${ref}`)
    }
  }

  const head = workGitRun(W, ['symbolic-ref', '-q', 'HEAD'])
  if (head.code || (head.status !== 0 && head.status !== 1)) problems.push(`HEAD unreadable: ${head.error || firstLine(head.stderr)}`)
  else if (head.status === 1) problems.push('HEAD is detached')
  else if (!DATED_BRANCH_RE.test(head.stdout)) problems.push(`HEAD is not a dated branch: ${head.stdout}`)

  return { problems }
}

// The .git/info listing: [hex name, kind, digest] per entry, sorted, recursing into real
// directories (symlinks are recorded by their target, never followed). Absent equals empty.
// Paths stay Buffers, so a name that is not UTF-8 keeps its bytes.
function listing(dir) {
  const rows = []
  for (const name of fs.readdirSync(dir, { encoding: 'buffer' })) {
    const p = Buffer.concat([dir, Buffer.from('/'), name])
    const st = fs.lstatSync(p)
    const hex = name.toString('hex')
    if (st.isDirectory()) rows.push([hex, 'directory', listing(p)])
    else if (st.isSymbolicLink()) rows.push([hex, 'symlink', fs.readlinkSync(p, { encoding: 'buffer' }).toString('hex')])
    else if (st.isFile()) rows.push([hex, 'file', sha256Hex(fs.readFileSync(p))])
    else rows.push([hex, 'special file', ''])
  }
  return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

function configFacet(W, gitDir) {
  const file = path.join(gitDir, 'config')
  const st = lstatOrNull(file)
  if (!st) return { kind: 'missing' }
  if (st.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(file, { encoding: 'buffer' }).toString('hex') }
  if (!st.isFile()) return { kind: kindOf(st) }
  const cfg = configEntries(W, gitDir)
  // A file git cannot parse: its raw bytes, so any change to it still changes the meta.
  if (cfg.error) return { kind: 'unparsable', sha256: sha256Hex(fs.readFileSync(file)) }
  const kept = cfg.entries.filter(e => e.key !== HOOKSPATH).map(e => Buffer.concat([e.raw, Buffer.from([0])]))
  return { kind: 'file', sha256: sha256Hex(Buffer.concat(kept)) }
}

// cloneMeta(W) -> 64 hex digits; throws clone-invalid (code CLONE_INVALID) when <W>/.git is
// not a real directory.
export function cloneMeta(W) {
  const { gitDir, kind } = gitDirOf(W)
  if (!gitDir) throw cloneInvalid(W, kind)
  const infoDir = path.join(gitDir, 'info')
  const infoSt = lstatOrNull(infoDir)
  let info
  if (!infoSt) info = []
  else if (infoSt.isDirectory()) info = listing(Buffer.from(infoDir))
  else if (infoSt.isSymbolicLink()) info = { kind: 'symlink', target: fs.readlinkSync(infoDir, { encoding: 'buffer' }).toString('hex') }
  else info = { kind: kindOf(infoSt) }
  const special = {}
  for (const name of SPECIAL_FILES) special[name] = lstatOrNull(path.join(gitDir, name)) !== null
  return sha256Hex(canonicalJson({ v: 2, config: configFacet(W, gitDir), info, special, storage: storageIdentity(gitDir) }))
}

// refsSnapshot(W) -> {refs}: every ref under refs/ with the object id it names (an annotated
// tag's own object id). Throws as workGit throws.
export function refsSnapshot(W) {
  const out = workGit(W, ['for-each-ref', '--format=%(objectname) %(refname)'])
  const refs = {}
  for (const line of out.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    refs[line.slice(sp + 1)] = line.slice(0, sp)
  }
  return { refs }
}
