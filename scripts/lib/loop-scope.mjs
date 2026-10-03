// scripts/lib/loop-scope.mjs
// The scope rules of spec section 4 (stage 0c-2; 0c-4 adds the CLI, the bootstrap,
// migration and loop section 2 gates and their refusals). `scope:` in LOOP.md lists
// repository-relative directories. A path is in scope when one of its leading path
// components equals an entry (`src` holds `src/a.js`, not `src-old/a.js`) and its real
// path stays inside the root.
//
//   parseScope(text)            the raw entries (loop-md's frontList(text, 'scope'))
//   checkScope(raw)             canonical entries and the verdict: ok | whole | invalid
//   inScope(path, entries, {root})   the prefix rule plus the real path rule
//   scopeDigest(entries)        SHA-256 over the canonical JSON of the entries
//   markScope(paths, text, {root})   the 0c-2 marking policy (R17, R7) every save, check
//                               and commit uses
//
// Canonical entry: trimmed, repeated `/` collapsed, `.` components (leading `./` among
// them) and a trailing `/` dropped. Whole-repository spellings (`.`, `./`, `/`, an empty
// or blank entry, an empty list) canonicalize to the one entry `.`; another leading `/`
// is `absolute`; a `..` component is `dotdot`; an entry that is not a well-formed string
// without NUL is `malformed`. Any problem makes the list `invalid` (invalid beats whole).
//
// Real path: the path is walked from realpath(root) one component at a time; every
// symlink met is replaced by its link target (the last component's too, so a symlink is
// judged by where it points, dangling or not); below the first missing component the rest
// is resolved lexically (the nearest existing ancestor is the real part). A loop (more than
// 40 links) or an unreadable component has no known real path and is never inside.
import fs from 'node:fs'
import path from 'node:path'
import { canonicalJson, sha256Hex } from './canonical.mjs'
import { frontList } from './loop-md.mjs'

const WHOLE = '.'
const MAX_LINKS = 40
// R7, and the git directory beside it: never in scope, by path or by real path.
const GOVERNED = new Set(['.tech-lead', '.git'])

const show = v => {
  try {
    return String(v)
  } catch {
    return typeof v
  }
}

// parseScope(loopMdText) -> string[]; throws loop-md's `bad-loop-md`, `no-scope`, `bad-scope: ...`.
export function parseScope(loopMdText) {
  return frontList(loopMdText, 'scope')
}

// checkScope(raw) -> {state:'ok', entries} | {state:'whole', entries} |
//   {state:'invalid', problems:[{entry, why:'absolute'|'dotdot'|'malformed'}]}.
// entries are canonical, sorted and deduplicated (whole lists hold `.`); problems name the
// raw entries in input order. Never throws on content; a non-array is a caller bug.
export function checkScope(raw) {
  if (!Array.isArray(raw)) throw new TypeError('checkScope: raw must be an array of entries')
  const problems = []
  const entries = new Set()
  let whole = raw.length === 0
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'string' || !item.isWellFormed() || item.includes('\0')) {
      problems.push({ entry: show(item), why: 'malformed' })
      continue
    }
    const s = item.trim().replace(/\/{2,}/g, '/')
    if (s === '/') {
      whole = true
      continue
    }
    if (s.startsWith('/')) {
      problems.push({ entry: item, why: 'absolute' })
      continue
    }
    const parts = s.split('/')
    if (parts.includes('..')) {
      problems.push({ entry: item, why: 'dotdot' })
      continue
    }
    const canon = parts.filter(c => c !== '' && c !== '.').join('/')
    if (canon === '') whole = true
    else entries.add(canon)
  }
  if (problems.length) return { state: 'invalid', problems }
  if (whole) entries.add(WHOLE)
  return { state: whole ? 'whole' : 'ok', entries: [...entries].sort() }
}

// The components of a repository-relative path, or null for anything else (empty,
// absolute, a `.` or `..` component, an empty component, NUL). One trailing `/` is allowed:
// git lists a nested repository as `dir/`.
function relParts(p) {
  if (p === '' || p.startsWith('/') || p.includes('\0')) return null
  const parts = p.split('/')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  if (parts.some(c => c === '' || c === '.' || c === '..')) return null
  return parts
}

// The real path below the real directory `start` of the components `parts`, or null.
function realOf(start, parts) {
  let cur = start
  let todo = parts.slice()
  let links = 0
  while (todo.length) {
    const part = todo.shift()
    if (part === '' || part === '.') continue
    if (part === '..') {
      cur = path.dirname(cur)
      continue
    }
    const next = cur === '/' ? `/${part}` : `${cur}/${part}`
    let st
    try {
      st = fs.lstatSync(next)
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return settle(cur, [part, ...todo])
      return null
    }
    if (!st.isSymbolicLink()) {
      cur = next
      continue
    }
    if (++links > MAX_LINKS) return null
    let target
    try {
      target = fs.readlinkSync(next)
    } catch {
      return null
    }
    if (target === '' || target.includes('\0')) return null
    if (target.startsWith('/')) cur = '/'
    todo = target.split('/').concat(todo)
  }
  return settle(cur, [])
}

// `existing` holds no symlink; realpath(3) only fixes its case on a case-insensitive
// volume. The missing rest is joined lexically.
function settle(existing, rest) {
  let base
  try {
    base = fs.realpathSync.native(existing)
  } catch {
    return null
  }
  return path.resolve(base, ...rest)
}

// The real path of root/p relative to realRoot ('' for the root itself), or null when p is
// not a repository-relative path or its real path is unknown or leaves the root.
function realRel(realRoot, p) {
  const parts = relParts(p)
  if (!parts) return null
  const real = realOf(realRoot, parts)
  if (real === null) return null
  if (real === realRoot) return ''
  const prefix = realRoot.endsWith('/') ? realRoot : `${realRoot}/`
  return real.startsWith(prefix) ? real.slice(prefix.length) : null
}

const matches = (p, entries) => entries.some(e => typeof e === 'string' && e !== '' && (p === e || p.startsWith(`${e}/`)))

const rootOf = (fn, opts) => {
  const root = opts && opts.root
  if (typeof root !== 'string' || root === '') throw new TypeError(`${fn}: {root} is required`)
  return root
}

// inScope(path, entries, {root}) -> boolean: a leading path component run equals an entry,
// and the real path of root/path lies inside realpath(root). Throws when root cannot be
// resolved.
export function inScope(p, entries, opts) {
  if (typeof p !== 'string') throw new TypeError('inScope: path must be a string')
  if (!Array.isArray(entries)) throw new TypeError('inScope: entries must be an array')
  const realRoot = fs.realpathSync.native(rootOf('inScope', opts))
  return relParts(p) !== null && matches(p, entries) && realRel(realRoot, p) !== null
}

// scopeDigest(entries) -> sha256Hex(canonicalJson(entries)).
export function scopeDigest(entries) {
  if (!Array.isArray(entries)) throw new TypeError('scopeDigest: entries must be an array')
  return sha256Hex(canonicalJson(entries))
}

const governed = rel => GOVERNED.has(rel.split('/')[0].toLowerCase())
// Control characters never reach a note through a detail.
const printable = s => s.toWellFormed().replace(/[\x00-\x1f\x7f]/g, '?')

// The scope a LOOP.md text gives: {state, entries, detail?}; never throws.
function readScope(text) {
  const invalid = detail => ({ state: 'invalid', entries: [], detail: printable(detail) })
  if (typeof text !== 'string') return invalid('unreadable: no LOOP.md text')
  let raw
  try {
    raw = parseScope(text)
  } catch (e) {
    return invalid(`unreadable: ${e.message}`)
  }
  const c = checkScope(raw)
  if (c.state === 'invalid') return invalid(c.problems.map(q => `${q.why} ${q.entry}`).join('; '))
  return { state: c.state, entries: c.entries }
}

// markScope(paths, loopMdText, {root}) -> {state, entries, digest, outOfScope, warnings[, detail]}.
// The 0c-2 policy: ok -> inScope; whole -> every path whose real path stays inside root
// (warning scope-whole, R17); invalid or unreadable -> every path out (warning
// scope-invalid, entries [], detail names why; R17). Under every state a path under
// .tech-lead/ (R7) or .git, by its own spelling or by its real path, is out. outOfScope
// keeps the input order without repeats. A scope never makes it throw.
export function markScope(paths, loopMdText, opts) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) throw new TypeError('markScope: paths must be an array of strings')
  const root = rootOf('markScope', opts)
  const scope = readScope(loopMdText)
  const realRoot = scope.state === 'invalid' ? null : fs.realpathSync.native(root)
  const marksIn = p => {
    if (scope.state === 'invalid' || governed(p)) return false
    if (scope.state === 'ok' && !matches(p, scope.entries)) return false
    const rel = realRel(realRoot, p)
    return rel !== null && !governed(rel)
  }
  const seen = new Set()
  const outOfScope = []
  for (const p of paths) {
    if (seen.has(p)) continue
    seen.add(p)
    if (!marksIn(p)) outOfScope.push(p)
  }
  const result = {
    state: scope.state,
    entries: scope.entries,
    digest: scopeDigest(scope.entries),
    outOfScope,
    warnings: scope.state === 'ok' ? [] : [`scope-${scope.state}`],
  }
  if (scope.detail !== undefined) result.detail = scope.detail
  return result
}
