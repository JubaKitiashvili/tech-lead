// scripts/lib/canonical.mjs
// Canonical JSON and SHA-256 (stage 0c-2). Every digest, bundle header and record hash
// is computed over canonicalJson, so one value has exactly one spelling: object keys
// sorted by UTF-16 code unit (Array.prototype.sort, as RFC 8785 does) at every depth,
// arrays in order, no whitespace, strings escaped as JSON.stringify escapes them (text
// outside ASCII is kept as it is). Only plain objects, arrays, well-formed strings, safe
// integers, booleans and null are accepted; anything else (a float, undefined, a Date, a
// Map, a class instance, a cycle, a hole in an array, a symbol key, a lone surrogate) is
// refused with `not-canonical: <where> ...` rather than silently changed.
import crypto from 'node:crypto'

const notCanonical = (at, why) => new Error(`not-canonical: ${at} ${why}`)
// A place in the value, spelled as a JavaScript accessor: $.a.b[2] or $["odd key"].
const child = (at, key) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`)

function isPlain(v) {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function typeName(v) {
  const proto = Object.getPrototypeOf(v)
  const name = proto && proto.constructor && proto.constructor.name
  return name ? `a ${name}` : 'an object'
}

function write(v, at, open) {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(v)) throw notCanonical(at, `is ${String(v)}, not a safe integer`)
      return Object.is(v, -0) ? '0' : String(v)
    case 'string':
      if (!v.isWellFormed()) throw notCanonical(at, 'is a string that is not well-formed Unicode')
      return JSON.stringify(v)
    case 'object':
      break
    default:
      throw notCanonical(at, `is ${v === undefined ? 'undefined' : `a ${typeof v}`}`)
  }
  if (open.has(v)) throw notCanonical(at, 'is a cycle')
  open.add(v)
  try {
    if (Array.isArray(v)) {
      const parts = []
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) throw notCanonical(`${at}[${i}]`, 'is a hole in an array')
        parts.push(write(v[i], `${at}[${i}]`, open))
      }
      return `[${parts.join(',')}]`
    }
    if (!isPlain(v)) throw notCanonical(at, `is ${typeName(v)}, not a plain object`)
    if (Object.getOwnPropertySymbols(v).length) throw notCanonical(at, 'has a symbol key')
    const keys = Object.keys(v).sort()
    const parts = []
    for (const k of keys) {
      if (!k.isWellFormed()) throw notCanonical(at, 'has a key that is not well-formed Unicode')
      parts.push(`${JSON.stringify(k)}:${write(v[k], child(at, k), open)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    open.delete(v)
  }
}

// canonicalJson(value) -> string; throws `not-canonical: ...` for anything outside the grammar.
export function canonicalJson(value) {
  return write(value, '$', new Set())
}

// sha256Hex(data) -> 64 lowercase hex digits. A string is hashed as its UTF-8 bytes; a
// Buffer (or any Uint8Array) as given.
export function sha256Hex(data) {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new TypeError(`sha256Hex: data must be a Buffer or a string, not ${data === null ? 'null' : typeof data}`)
  }
  return crypto.createHash('sha256').update(data).digest('hex')
}
