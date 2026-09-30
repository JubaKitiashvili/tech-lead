// scripts/lib/js-scan.mjs
// Minimal JavaScript scanner for the check harness. It skips string literals,
// template literals and comments. Regex literals are not handled, so callers
// use it only on object literals that hold no regex (workflow `meta`).

export function matchBrace(src, open) {
  if (src[open] !== '{') throw new Error(`matchBrace: expected '{' at ${open}`)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) throw new Error(`matchBrace: unterminated comment at ${i}`)
      i = end + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  throw new Error(`matchBrace: no closing brace for '{' at ${open}`)
}

// Returns the index of the closing quote of the string that starts at `start`.
export function skipString(src, start) {
  const quote = src[start]
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
      i = matchBrace(src, i + 1) - 1
      continue
    }
    if (src[i] === quote) return i
  }
  throw new Error(`matchBrace: unterminated string starting at ${start}`)
}
