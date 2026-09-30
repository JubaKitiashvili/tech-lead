// scripts/lib/registry-loader.mjs
// Spec §5.1: the decision registry lives in workflows/decide.js between the lines
// `// REGISTRY-BEGIN` and `// REGISTRY-END`, as one object literal. Node scripts
// extract it here and evaluate it with the question helpers passed in.

function markerLines(lines, marker) {
  const out = []
  lines.forEach((line, i) => { if (line.trim() === marker) out.push(i) })
  return out
}

export function extractBlock(src, name, { required = false } = {}) {
  const lines = src.split('\n')
  const begins = markerLines(lines, `// ${name}-BEGIN`)
  const ends = markerLines(lines, `// ${name}-END`)
  if (begins.length === 0 && ends.length === 0) {
    if (required) throw new Error(`${name} block is missing`)
    return null
  }
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(`${name}: expected exactly one BEGIN/END pair, found ${begins.length} BEGIN and ${ends.length} END`)
  }
  if (ends[0] < begins[0]) throw new Error(`${name}: END comes before BEGIN`)
  return lines.slice(begins[0] + 1, ends[0]).join('\n').trim()
}

export function evaluateLiteral(text, scope = {}) {
  const names = Object.keys(scope)
  const expr = text.replace(/;\s*$/, '')
  return new Function(...names, `"use strict"; return (${expr})`)(...names.map(n => scope[n]))
}
