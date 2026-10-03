// scripts/lib/loop-md.mjs
// LOOP.md front-matter lists (stage 0c-2; the grammar is stage 0c-1's verify: reader).
//
// frontList(text, key) reads the list under the front matter's top-level `<key>:` as YAML
// reads it: a block sequence whose items all start at one indentation with "- ", each item
// a plain, single-quoted or double-quoted scalar on one line, with comments and blank lines
// dropped; a top-level key ends it. Every other shape is refused rather than guessed (a
// more-indented "- ", a sibling at another indentation, a continuation line, anything else
// before the next key: `unsupported <key>: syntax at line N`), so a caller never acts on
// text other than the item the owner reads in the file. An empty item is refused; an empty
// list is []. Errors: `bad-loop-md: ...` (no front matter, or not closed), `no-<key>: ...`
// (the front matter has no such key), `bad-<key>: ...` (any other refusal).
//
// verify: items are commands and every other key's are entries; the messages name them so
// (loop-lock.mjs's verifyCommands is frontList(text, 'verify'), with 0c-1's messages).

const TOP_KEY = /^(?:[^\s#\-?:,[\]{}&*!|>%@`'"][^:]*|"[^"]*"|'[^']*')\s*:(?:\s|$)/
// A key is matched as text inside a pattern, so only plain YAML key spellings are taken.
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/
const NOUN = { verify: 'command' }

export function frontList(text, key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new TypeError(`frontList: bad key ${JSON.stringify(String(key))}`)
  const noun = NOUN[key] ?? 'entry'
  const lines = String(text).split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('bad-loop-md: LOOP.md has no front matter')
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l))
  if (end < 0) throw new Error('bad-loop-md: the front matter is not closed')
  const opens = new RegExp(`^${key}\\s*:`)
  const keys = lines.slice(0, end).flatMap((l, i) => opens.test(l) ? [i] : [])
  if (!keys.length) throw new Error(`no-${key}: the front matter has no ${key}: key`)
  if (keys.length > 1) throw new Error(`bad-${key}: ${key}: appears ${keys.length} times`)
  const at = keys[0]
  if (!new RegExp(`^${key}\\s*:\\s*(#.*)?$`).test(lines[at])) {
    throw new Error(`bad-${key}: line ${at + 1}: ${key}: must be a block list of "  - <${noun}>" lines`)
  }
  const out = []
  let indent = null
  const unsupported = (n, why) => new Error(`bad-${key}: unsupported ${key}: syntax at line ${n} (${why})`)
  for (let i = at + 1; i < end; i++) {
    const line = lines[i]
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^( *)-(?:[ \t]+(.*))?$/.exec(line)
    if (item && (indent === null || item[1].length === indent)) {
      indent = item[1].length
      out.push(listItem(item[2] ?? '', i + 1, key, noun))
    } else if (item) {
      throw unsupported(i + 1, `a "- " ${item[1].length > indent ? 'more' : 'less'} indented than the items above it`)
    } else if (TOP_KEY.test(line)) {
      break // the next top-level key
    } else {
      throw unsupported(i + 1, /^\s/.test(line) ? 'a continuation line or other text inside the list' : 'a line that is neither an item nor a key')
    }
  }
  return out
}

function listItem(s, n, key, noun) {
  const bad = why => new Error(`bad-${key}: line ${n}: ${why}`)
  const tail = rest => {
    if (!/^\s*(#.*)?$/.test(rest)) throw bad('text after the closing quote')
  }
  let v
  if (s.startsWith('"')) {
    let i = 1
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1
    if (i >= s.length) throw bad(`unterminated double-quoted ${noun}`)
    tail(s.slice(i + 1))
    // YAML and JSON share the escapes of quote, backslash, slash, b, f, n, r, t and u;
    // any other escape is refused.
    try {
      v = JSON.parse(s.slice(0, i + 1))
    } catch {
      throw bad('an escape JSON does not share with YAML; use single quotes')
    }
  } else if (s.startsWith("'")) {
    let i = 1
    v = ''
    for (;;) {
      if (i >= s.length) throw bad(`unterminated single-quoted ${noun}`)
      if (s[i] === "'") {
        if (s[i + 1] !== "'") break
        v += "'"
        i += 2
      } else {
        v += s[i++]
      }
    }
    tail(s.slice(i + 1))
  } else {
    v = s.replace(/(^|\s)#.*$/, '').trim()
    if (/^[-?:](\s|$)|^[[\]{},&*!|>%@`]/.test(v)) throw bad(`a YAML indicator starts the ${noun}; quote it`)
    if (/:(\s|$)/.test(v)) throw bad(`": " makes the item a mapping; quote the ${noun}`)
  }
  if (!v.trim()) throw bad(`empty ${noun}`)
  return v
}
