// scripts/lib/loop-state.mjs
// Reading <S>/STATE.md (stage 0c-2; moved here from loop-recover.mjs, which re-exports
// both names). Stage 0c-3 adds the item grammar here.

// What the STATE.md template's `## Now` holds when no item is in flight; a firing leaves
// exactly this line there (loop section 8).
export const PLACEHOLDER = '(empty)'

const SECTION_END = /^#{1,2}(?:[ \t]|$)/

// The first non-blank line of the `## Now` section, trimmed; null when the section is
// missing, blank or holds only the template's `(empty)`. The section ends at the next
// level-1 or level-2 heading.
export function nowLine(text) {
  const lines = String(text).split(/\r?\n/)
  const at = lines.findIndex(l => /^## Now[ \t]*$/.test(l))
  if (at < 0) return null
  for (const l of lines.slice(at + 1)) {
    if (SECTION_END.test(l)) return null
    const s = l.trim()
    if (s && s !== PLACEHOLDER) return s
  }
  return null
}
