// scripts/checks/loop.mjs
// The loop's prose wiring to the firing lock (stage 0c-1): the loop skill and its references
// call scripts/loop-lock.mjs where the design needs it. Section 1 acquires before anything
// reads LOOP.md, section 8 releases as the last command, verify runs and the dependency
// install go through `exec`, every Codex start is registered with the lock, Agent and
// Workflow dispatches are bracketed by dispatch records, and nothing in skills/ stashes.
// The prose also keeps up with what the helpers print: every held reason acquire returns is
// handled (the runner stays only for transient contention), a release exit 3 is a lost lock
// only with not-holder, the ledger rule names both of its exceptions, the release's two
// lists mean what the code puts in them, an exec run counts as passed only when it exited 0
// (never when lingering), `## Now` ends as loop-recover.mjs's placeholder, and README's
// troubleshooting names every held reason.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { docFiles } from './repo.mjs'

const SKILL = 'skills/loop/SKILL.md'
const WORKTREE = 'skills/loop/references/worktree.md'
const TEMPLATES = 'skills/loop/references/loop-templates.md'
const LOCK_SRC = 'scripts/loop-lock.mjs'
const RECOVER_SRC = 'scripts/loop-recover.mjs'
const PATHS_SRC = 'scripts/lib/loop-paths.mjs'
const LOCK = 'node <T>/scripts/loop-lock.mjs'
// Acquire's held reasons that mean transient contention: the firing ends without writing,
// and the runner stays (the next wakeup tries again). Every other held reason needs a human.
const TRANSIENT = ['holder-live', 'race', 'holder-unknown']
// What each list of a holder release's result holds, as section 8 must say it.
const RELEASE_LISTS = { stopped: 'stopped', lingering: 'could not stop' }
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

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Prose with every run of whitespace (line wraps included) as one space.
const flat = s => s.replace(/\s+/g, ' ')
// Every backticked span of a text.
const ticked = s => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1])
// The reasons acquire can print as held, read from its source.
const heldReasons = src => [...new Set([...src.matchAll(/\bheld\('([a-z-]+)'/g)].map(m => m[1]))].sort()

// The text from the heading line `marker` (`## Title`, `### Title`) to the next heading of
// the same level or higher.
function part(md, marker, file) {
  const level = /^#+/.exec(marker)[0].length
  const m = new RegExp(`^${esc(marker)}[ \\t]*$`, 'm').exec(md)
  if (!m) throw new Error(`${file}: no "${marker}" heading`)
  const end = md.slice(m.index + m[0].length).search(new RegExp(`^#{1,${level}} `, 'm'))
  return md.slice(m.index, end < 0 ? md.length : m.index + m[0].length + end)
}

// The bullets of a text, each joined with its indented continuation lines; a nested bullet
// is an item of its own.
function bullets(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (/^\s*- /.test(line)) out.push(line.trim())
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`
  }
  return out
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

  await r.check('loop: SKILL.md section 1 handles every held reason acquire prints, and keeps the runner only for transient contention', () => {
    const reasons = heldReasons(rd(LOCK_SRC))
    const bad = TRANSIENT.filter(x => !reasons.includes(x)).map(x => `${LOCK_SRC} prints no held reason ${x}`)
    const items = bullets(step(rd(SKILL), 3, 'Acquire the firing lock', SKILL))
    const named = b => ticked(b).filter(x => reasons.includes(x))
    const keep = items.filter(b => /keep the runner/i.test(b))
    const stop = items.filter(b => /stop the runner/i.test(b) && named(b).length)
    if (keep.length !== 1) bad.push(`${SKILL} section 1 step 3 needs one bullet that says "keep the runner" (found ${keep.length})`)
    if (stop.length !== 1) bad.push(`${SKILL} section 1 step 3 needs one bullet that names held reasons and says "stop the runner" (found ${stop.length})`)
    const k = keep.length === 1 ? named(keep[0]) : [], s = stop.length === 1 ? named(stop[0]) : []
    for (const x of reasons) {
      const want = TRANSIENT.includes(x) ? 'keep' : 'stop'
      const got = [k.includes(x) && 'keep', s.includes(x) && 'stop'].filter(Boolean)
      if (got.length !== 1 || got[0] !== want) {
        bad.push(`held reason \`${x}\` must ${want} the runner; section 1 step 3 has it ${got.length ? `under ${got.join(' and ')}` : 'nowhere'}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the Lost-lock rule counts a release exit 3 as lost only with "state": "not-holder", and a holder-unknown error as no loss', () => {
    const lost = bullets(step(rd(SKILL), 3, 'Acquire the firing lock', SKILL)).filter(b => b.startsWith('- **Lost lock.**'))
    assert.equal(lost.length, 1, `${SKILL} section 1 step 3 has no "- **Lost lock.**" bullet`)
    const t = flat(lost[0]), bad = []
    const NOT_HOLDER = ' with `"state": "not-holder"`'
    if (!t.includes(`\`release\` exit 3${NOT_HOLDER}`)) bad.push(`the Lost-lock rule does not name \`release\` exit 3${NOT_HOLDER}`)
    if (new RegExp(`\`release\` exit 3(?!${esc(NOT_HOLDER)})`).test(t)) bad.push('the Lost-lock rule counts a `release` exit 3 as lost without `"state": "not-holder"` (exit 3 `dispatch-open` is no loss)')
    if (!t.includes('`holder-unknown`')) bad.push('the Lost-lock rule never says that an exit 2 `holder-unknown` error is not a lost lock')
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the ledger rule names both of its exceptions, ending at the lock and losing it', () => {
    const END = /\bend(?:s|ed|ing)? at the lock\b/i, LOSE = /\b(?:loses|losing|lost) (?:the|its) lock\b/i
    const skill = rd(SKILL)
    const s8 = section(skill, 8, SKILL).text
    const append = s8.indexOf('2. Append exactly one ledger entry'), releaseStep = s8.indexOf('3. **Release the firing lock')
    const templates = part(rd(TEMPLATES), '## LEDGER.jsonl entry schema', TEMPLATES)
    const places = [
      [`${SKILL} section 1 step 3`, step(skill, 3, 'Acquire the firing lock', SKILL)],
      [`${SKILL} section 8 step 2`, append >= 0 && releaseStep > append ? s8.slice(append, releaseStep) : ''],
      [`${TEMPLATES} LEDGER.jsonl rule (before the schema)`, templates.slice(0, templates.indexOf('```'))],
      ['README.md The firing lock', part(rd('README.md'), '### The firing lock', 'README.md')],
    ]
    const bad = append < 0 || releaseStep < append ? [`${SKILL} section 8 has no step "2. Append exactly one ledger entry" before its release step`] : []
    for (const [where, text] of places) {
      const t = flat(text)
      if (!END.test(t)) bad.push(`${where} does not name the firing that ends at the lock`)
      if (!LOSE.test(t)) bad.push(`${where} does not name the firing that loses the lock`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 8 says what each list of a holder release holds', () => {
    // The holder release's result, as loop-lock.mjs returns it: its lists after `by: 'holder'`.
    const m = /\{ state: 'released', generation, by: 'holder', ([^}]*)\}/.exec(rd(LOCK_SRC))
    assert.ok(m, `${LOCK_SRC}: no holder release result ({ state: 'released', generation, by: 'holder', ... })`)
    const lists = m[1].split(',').map(f => f.split(':')[0].trim()).filter(Boolean)
    const t = flat(step(rd(SKILL), 3, 'Release the firing lock', SKILL))
    const bad = []
    for (const f of lists) {
      if (!Object.hasOwn(RELEASE_LISTS, f)) bad.push(`${LOCK_SRC}: the release lists \`${f}\`, which scripts/checks/loop.mjs has no meaning for`)
      else if (!t.includes(`${RELEASE_LISTS[f]} in \`${f}\``)) bad.push(`${SKILL} section 8 does not say the release lists the children it ${RELEASE_LISTS[f]} in \`${f}\``)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the verify and install exec rules fail an exited run with a non-zero exit and never pass a lingering run', () => {
    const src = rd(LOCK_SRC)
    const code = /const EXIT_LINGERING = (\d+)/.exec(src)
    assert.ok(code && src.includes("state: 'lingering'"), `${LOCK_SRC}: no lingering state (EXIT_LINGERING)`)
    const bad = []
    for (const [where, text] of [
      [`${SKILL} section 6 step 3`, step(section(rd(SKILL), 6, SKILL).text, 3, 'Verify', SKILL)],
      [`${WORKTREE} step 4`, step(rd(WORKTREE), 4, 'Dependencies', WORKTREE)],
    ]) {
      const t = flat(text)
      if (!/`exited` with (?:any other|a non-zero) `exit`/.test(t)) bad.push(`${where} never says that \`exited\` with a non-zero \`exit\` is a failure`)
      if (!t.includes(`\`lingering\` (exit ${code[1]})`)) bad.push(`${where} never handles the \`lingering\` state (exit ${code[1]})`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: a firing leaves ## Now holding exactly the placeholder loop-recover.mjs reads as empty', () => {
    const m = /const PLACEHOLDER = '([^']+)'/.exec(rd(RECOVER_SRC))
    assert.ok(m, `${RECOVER_SRC}: no PLACEHOLDER constant`)
    const ph = m[1], bad = []
    const tpl = /^## Now\n(.*)$/m.exec(rd(TEMPLATES))
    if (!tpl || tpl[1] !== ph) bad.push(`${TEMPLATES}: the STATE.md template's ## Now holds ${JSON.stringify(tpl ? tpl[1] : null)}, not ${ph}`)
    if (!new RegExp(`\`## Now\`[^.]* exactly \`${esc(ph)}\``).test(flat(section(rd(SKILL), 8, SKILL).text))) {
      bad.push(`${SKILL} section 8 never resets \`## Now\` to exactly \`${ph}\` (the recovery planner reads any other text there as an item)`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: README troubleshooting names every held reason acquire prints, and the not-toplevel refusal', () => {
    assert.ok(rd(PATHS_SRC).includes('`not-toplevel: '), `${PATHS_SRC} no longer refuses with not-toplevel`)
    const names = ticked(part(rd('README.md'), '## Troubleshooting', 'README.md'))
    const missing = [...heldReasons(rd(LOCK_SRC)), 'not-toplevel'].filter(x => !names.includes(x))
    assert.deepEqual(missing.map(x => `README.md Troubleshooting never names \`${x}\``), [])
  })
}
