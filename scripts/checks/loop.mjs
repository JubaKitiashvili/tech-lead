// scripts/checks/loop.mjs
// The loop's prose wiring to the firing lock (stage 0c-1): the loop skill and its references
// call scripts/loop-lock.mjs where the design needs it. Section 1 acquires before anything
// reads LOOP.md, section 8 releases as the last command, verify runs and the dependency
// install go through `exec`, every Codex start is registered with the lock, Agent and
// Workflow dispatches are bracketed by dispatch records, and nothing in skills/ stashes.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { docFiles } from './repo.mjs'

const SKILL = 'skills/loop/SKILL.md'
const WORKTREE = 'skills/loop/references/worktree.md'
const LOCK = 'node <T>/scripts/loop-lock.mjs'
// A Bash call that reaches its 600000 ms limit is moved to the background, not killed, so
// every exec in the prose ends its own run first (with room for the group kill's 5 s + 2 s).
const MAX_EXEC_MS = 540000
const timeoutOk = ms => Number.isSafeInteger(Number(ms)) && Number(ms) > 0 && Number(ms) <= MAX_EXEC_MS

const lineOf = (text, index) => text.slice(0, index).split('\n').length

// The text from the heading `## <n> ` to the next `## ` heading, and where it starts.
function section(md, n, file) {
  const m = new RegExp(`^## ${n} `, 'm').exec(md)
  if (!m) throw new Error(`${file}: no "## ${n}" section`)
  const end = md.slice(m.index + m[0].length).search(/^## /m)
  return { text: md.slice(m.index, end < 0 ? md.length : m.index + m[0].length + end), at: m.index }
}

// The text of numbered step `<n>. **<title>` up to the next step at the same indent.
function step(md, n, title, file) {
  const m = new RegExp(`^(\\s*)${n}\\. \\*\\*${title}`, 'm').exec(md)
  if (!m) throw new Error(`${file}: no step ${n} "${title}"`)
  const end = md.slice(m.index + m[0].length).search(new RegExp(`^${m[1]}\\d+\\. `, 'm'))
  return md.slice(m.index, end < 0 ? md.length : m.index + m[0].length + end)
}

// The commands the prose tells the model to run, in text order: every non-blank line of a
// fenced block, and every inline span that calls a plugin helper or git.
function commands(text) {
  const out = []
  let rest = text
  for (const m of text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)) {
    let at = m.index + m[0].indexOf('\n') + 1
    for (const line of m[1].split('\n')) {
      if (line.trim()) out.push({ at, cmd: line.trim() })
      at += line.length + 1
    }
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length)
  }
  for (const m of rest.matchAll(/`((?:node <T>\/scripts\/|git -C )[^`]*)`/g)) out.push({ at: m.index, cmd: m[1] })
  return out.sort((a, b) => a.at - b.at)
}

// `git stash`, also with global options, placeholders or paths before the subcommand.
const GIT_STASH = /\bgit(?:\s+(?:-\S+|<[^>\s]+>|\/\S*|\S+=\S*))*\s+stash\b/

function filesUnder(root, dir) {
  return fs.readdirSync(path.join(root, dir), { recursive: true })
    .map(f => `${dir}/${f}`)
    .filter(f => fs.statSync(path.join(root, f)).isFile())
}

export async function checkLoop(ctx, r) {
  const { root, rd } = ctx

  await r.check('loop: SKILL.md section 1 acquires the firing lock before it reads LOOP.md', () => {
    const skill = rd(SKILL)
    const { text, at } = section(skill, 1, SKILL)
    const acquire = text.indexOf(`${LOCK} acquire <P>`)
    assert.ok(acquire >= 0, `${SKILL} section 1 names no loop-lock.mjs acquire <P> (\`${LOCK} acquire <P>\`)`)
    const read = text.indexOf('LOOP.md')
    assert.ok(read >= 0, `${SKILL} section 1 never reads LOOP.md`)
    assert.ok(read > acquire, `${SKILL}:${lineOf(skill, at + read)}: LOOP.md is read before loop-lock.mjs acquire (line ${lineOf(skill, at + acquire)})`)
  })

  await r.check('loop: SKILL.md section 8 releases the firing lock as the last command, after the ledger append', () => {
    const { text } = section(rd(SKILL), 8, SKILL)
    const cmds = commands(text)
    const release = cmds.findIndex(c => c.cmd === `${LOCK} release <P> --generation <N>`)
    assert.ok(release >= 0, `section 8 names no \`${LOCK} release <P> --generation <N>\``)
    assert.equal(release, cmds.length - 1, `section 8's last command is not the release: ${cmds[cmds.length - 1].cmd}`)
    const ledger = text.lastIndexOf('Append exactly one ledger entry')
    assert.ok(ledger >= 0, 'section 8 names no ledger append ("Append exactly one ledger entry")')
    assert.ok(ledger < cmds[release].at, 'section 8: the ledger append comes after the release')
  })

  await r.check('loop: SKILL.md section 6 runs every verify command through loop-lock.mjs exec --verify', () => {
    const exec = new RegExp(`^${LOCK} exec <P> --generation <N> --label verify --cwd <W>(?: --timeout-ms (\\d+))? --verify <K>$`)
    const m = commands(section(rd(SKILL), 6, SKILL).text).map(c => exec.exec(c.cmd)).find(Boolean)
    assert.ok(m, `${SKILL} section 6 has no loop-lock.mjs exec <P> --generation <N> --label verify --cwd <W> --timeout-ms <T> --verify <K>`)
    assert.ok(timeoutOk(m[1]), `${SKILL} section 6: the verify exec needs --timeout-ms of at most ${MAX_EXEC_MS} (the Bash limit backgrounds a longer run), not ${m[1] ?? 'none'}`)
  })

  await r.check('loop: worktree.md installs dependencies through loop-lock.mjs exec', () => {
    const deps = step(rd(WORKTREE), 4, 'Dependencies', WORKTREE)
    const exec = new RegExp(`^${LOCK} exec <P> --generation <N> --label deps --cwd <W>(?: --timeout-ms (\\d+))? -- \\S`)
    const cmds = commands(deps)
    const bad = []
    const m = cmds.map(c => exec.exec(c.cmd)).find(Boolean)
    if (!m) bad.push(`${WORKTREE} step 4 has no loop-lock.mjs exec <P> --generation <N> --label deps --cwd <W> --timeout-ms <T> -- <install>`)
    else if (!timeoutOk(m[1])) bad.push(`${WORKTREE} step 4: the install exec needs --timeout-ms of at most ${MAX_EXEC_MS} (the Bash limit backgrounds a longer run), not ${m[1] ?? 'none'}`)
    for (const c of cmds) if (!c.cmd.startsWith(`${LOCK} exec `)) bad.push(`${WORKTREE} step 4 runs the install directly: ${c.cmd}`)
    for (const m of deps.matchAll(/`(cd <W>[^`]*)`/g)) bad.push(`${WORKTREE} step 4 runs the install directly: ${m[1]}`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: every loop-codex.mjs start in the docs carries --project and --generation', () => {
    // An invocation is a helper path (scripts/loop-codex.mjs start) or the name followed by
    // flags; the bare name in a sentence is not one.
    const bad = []
    for (const f of docFiles(root)) {
      rd(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(scripts\/)?loop-codex\.mjs start\b([^`]*)/g)) {
          if (!m[1] && !/^\s+--/.test(m[2])) continue
          const missing = ['--project', '--generation'].filter(flag => !new RegExp(`(^|\\s)${flag}\\s+[^\\s-]`).test(m[2]))
          if (missing.length) bad.push(`${f}:${i + 1}: loop-codex.mjs start without ${missing.join(', ')}`)
        }
      })
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: no git stash anywhere in skills/', () => {
    // The loop's shared patch helper replaces stashing (spec 7.5); a stash would also move
    // work out of the scope rail's sight.
    const bad = []
    for (const f of filesUnder(root, 'skills')) {
      rd(f).split('\n').forEach((line, i) => {
        if (GIT_STASH.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md brackets Agent and Workflow dispatches with dispatch open and dispatch close', () => {
    const cmds = commands(rd(SKILL))
    const bad = []
    if (!cmds.some(c => c.cmd.startsWith(`${LOCK} dispatch open <P> --generation <N> --label `))) {
      bad.push(`${SKILL} names no loop-lock.mjs dispatch open <P> --generation <N> --label <L>`)
    }
    if (!cmds.some(c => c.cmd.startsWith(`${LOCK} dispatch close <P> --generation <N> --id `))) {
      bad.push(`${SKILL} names no loop-lock.mjs dispatch close <P> --generation <N> --id <id>`)
    }
    assert.deepEqual(bad, [])
  })
}
