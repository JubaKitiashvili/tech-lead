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
// (never when lingering: the rule's own sentence must call a non-zero exit a failure, and the
// lingering rule must call the run no pass), `## Now` ends as loop-state.mjs's placeholder, and
// README's troubleshooting names every held reason.
// Stage 0c-2 (the clone, brief section 21): the main session runs no git in <W> itself
// (clone.md replaces worktree.md), every loop-clone.mjs command and every reflex-bundle.mjs
// save, reset and apply is fenced by --generation <N>, section 1 step 5 runs the planner with
// the generation, section 8 closes the run records between the ledger append and the release,
// Save and reset saves, writes the full returned sha into STATE.md with one Edit, then resets,
// nothing in skills/loop/ discards work in place (only a command a prohibition governs is
// exempt), the owner-only loop-review.mjs is named in no skill, the panel snapshot never
// refreshes <P>/.git/index, and a not-holder answer from the clone helpers is a lost lock.
// Stage 0c-3 (brief section 7): the prose writes and reads STATE.md items as loop-state.mjs and
// the item helper loop-items.mjs do. The STATE.md template parses with parseState with no
// problems, loop-templates.md documents every FIELD_LABEL, the `## Needs decision` entry
// templates are keyed by id (`### <id> <DOT> <title>`), no doc finishes a blocker by its title
// (audit cx-lr07), every recovery save names its item (`--item <id>`), section 3 normalizes and
// checks the applied edits before it picks and checks pick's edits after, and the analysis
// follow-up reaches loop-items.mjs only through a JSON file written with the Write tool. The fix
// pass adds: the title-blocker test reads each clause on its own (PDC-1); bootstrap keeps a
// known dependency as a title blocker that parks the dependent (R32); section 1 step 5 applies
// and checks the planner's clear.edits and pauses on now-conflict (R29); and the ledger entry
// records pick's unledgered as done_items while the ## Done trim keeps those items (R27); the
// trim runs loop-items.mjs trim, applies its edits and checks them with check --expect (R27,
// R14, PDC-2: the helper deletes whole blocks). Fix round 2: the title-blocker test judges the
// clause that finishes the blocker, so a negation counts only where it governs the finishing
// (Codex fix1-g2#4); bootstrap renames a prerequisite whose title is a none spelling before it
// writes the blocker (R32a); section 5 counts both follow-up answers, reused true and false,
// as a success, with only a refusal or an error as the incident (Codex fix1-g2#5); section 1
// step 5 names every now-conflict reason loop-recover.mjs prints and every field clear-now
// compares (R29a); and README's skip table and section 3.1 name every release refusal pick can
// report, ambiguous-carrier included (R30a).
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { docFiles } from './repo.mjs'

const SKILL = 'skills/loop/SKILL.md'
const CLONE = 'skills/loop/references/clone.md'
const TEMPLATES = 'skills/loop/references/loop-templates.md'
const BOOTSTRAP = 'skills/loop/references/bootstrap.md'
const LOCK_SRC = 'scripts/loop-lock.mjs'
const STATE_SRC = 'scripts/lib/loop-state.mjs'
const PATHS_SRC = 'scripts/lib/loop-paths.mjs'
const RECOVER_SRC = 'scripts/loop-recover.mjs'
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

// Commands that discard work in place (brief 21): only Save and reset (reflex-bundle.mjs)
// removes edits in <W>, after it saved them. `git clean` also with options before it.
const DISCARD = [
  ['checkout -- ', /checkout -- /],
  ['restore --worktree', /\brestore --worktree\b/],
  ['restore -W', /\brestore -W\b/],
  ['git clean', /\bgit(?:\s+(?:-\S+|<[^>\s]+>|\/\S*|\S+=\S*))*\s+clean\b/],
  ['reset --hard', /\breset --hard\b/],
]
// A command is forbidden, not prescribed, only when a prohibition governs it (code#3,
// prose#4). The sentence that holds it opens by forbidding (a bullet marker and bold may come
// first), and between the nearest forbidding word before it and the command there is nothing
// but at most one verb (run, use, ...) and other commands joined by commas, `or`, `and` or
// `nor`: "Never run `git clean`", "Never run `a`, `b` or `git clean`", "- **No destructive
// commands:** no `git reset --hard`", "No recovery is needed; do not run `git clean`". A
// negation elsewhere ("If a reset did not finish, run `git clean -fdx`", "When there are no
// conflicts, ...") exempts nothing, and neither does an opening prohibition of something else
// followed by an affirmative clause ("Do not retry verification; run `git clean -fd`", "No
// recovery is needed and `git clean -fd` is fine"). Backticked spans are read as single
// commands, so a word inside one ("--no-verify") is never a forbidding word.
const OPENS_FORBIDDING = /^\s*(?:[-*]\s+)?(?:\*\*)?\s*(?:never|no|nor|do not|don't)\b/i
const FORBIDDING_WORD = /\b(?:never|no|nor|not|don't)\b/gi
const GOVERNED = /^\s*(?:\*+\s*)?(?:(?:run|use|call|type|execute|issue|invoke|try)\s+)?(?:`#`\s*(?:,\s*(?:(?:or|and|nor)\s+)?|(?:or|and|nor)\s+))*$/i
function forbidsAt(line, at) {
  // Every complete span becomes `#`; an unclosed one is the start of the command's own span.
  const masked = line.slice(0, at).replace(/`[^`]*`/g, '`#`').replace(/`[^`]*$/, '')
  const sentence = masked.split(/[.!?](?=\s)/).pop()
  if (!OPENS_FORBIDDING.test(sentence)) return false
  const last = [...sentence.matchAll(FORBIDDING_WORD)].pop()
  return GOVERNED.test(sentence.slice(last.index + last[0].length))
}
// The sentence of a flat text that holds index `at` (sentences end at a '.', '!' or '?' before
// a space).
function sentenceAt(text, at) {
  const before = text.slice(0, at).split(/(?<=[.!?])\s/)
  const after = text.slice(at).search(/[.!?](?=\s|$)/)
  return before[before.length - 1] + text.slice(at, after < 0 ? text.length : at + after + 1)
}
// What an exec rule calls a run: a failure, or a pass (Cg4#7: the phrase alone proves nothing).
const FAIL_WORD = /\bfail(?:s|ed|ure)?\b/i
const PASS_WORD = /\bpass(?:es|ed)?\b|\bsuccess(?:ful)?\b|\bsucceed(?:s|ed)?\b/i
// The lingering rule must say the run is no pass, and must never call it one.
const NEVER_PASS = /\bnever (?:a pass|passes|passed)\b|\b(?:is|counts as) (?:the|a) failure\b/i
const SAYS_PASS = /\b(?:it|the run|the install|the command) (?:is a pass|passes|passed|succeeds|succeeded)\b/i
// The helpers fenced by the firing lock's generation: every loop-clone.mjs subcommand but the
// read-only `git` passthrough, and reflex-bundle.mjs save, reset and apply (verify reads only).
const FENCED = [
  ['loop-clone.mjs', /(scripts\/)?loop-clone\.mjs ([a-z][a-z-]*)([^`\n]*)/g, sub => sub !== 'git'],
  ['reflex-bundle.mjs', /(scripts\/)?reflex-bundle\.mjs ([a-z][a-z-]*)([^`\n]*)/g, sub => ['save', 'reset', 'apply'].includes(sub)],
]
const CLOSE = 'node <T>/scripts/loop-clone.mjs close <P> --generation <N>'
// The item helper (stage 0c-3) and the commands section 3 runs through it.
const ITEMS = 'node <T>/scripts/loop-items.mjs'
const NORMALIZE = `${ITEMS} normalize <P>`
const PICK = `${ITEMS} pick <P>`
const CHECK_EXPECT = `${ITEMS} check <P> --expect <expect_sha256>`
const FOLLOWUP = `${ITEMS} followup <P> --parent <id> --input <S>/briefs/<id>-followup.json`
const TRIM = `${ITEMS} trim <P>`
// "Apply its `edits` ... Edit": the sentence that applies a plan's edits before its check.
const APPLIES = /\bApply (?:its|the|normalize's|pick's) `edits`[^.]*\bEdit\b/i
// The `## Needs decision` entry heading (R15), with loop-state.mjs's separator (this file is ASCII).
const ENTRY_HEADING = `### <id> ${String.fromCodePoint(0xb7)} <title>`
// A sentence that finishes a blocker by its title (cx-lr07): the old wording, or one that names
// a blocker and has a clause (the sentence split at ';' and ':') that says something is finished
// with no negation governing that finishing, where that clause, or, when it sets a condition
// after the finishing ("when", "once", "if"), a clause after it in the sentence, keys on a title
// or name. A negation elsewhere in the clause ("once a ledger row has the same title and no
// follow-up is open", "when no open item has its title") never hides the title key; a negated
// finishing ("a done item with the same title never finishes a blocker", "a blocker is not
// finished by its id alone; its title is only for display") says the opposite (Claude PDC-1,
// Codex fix1-g2#4).
const OLD_TITLE_BLOCKER = /exactly that (?:task )?title/i
const BLOCKER_WORD = /\bblock(?:er|ers|ed-by)\b/i
const FINISH_WORD = /\bfinish(?:es|ed)?\b|\b(?:is|are|counts? as|as) done\b|\bsatisf(?:y|ies|ied)\b/gi
const TITLE_KEY = /\b(?:same|matching|that|its|the) (?:task )?(?:title|name)\b/i
// A negation that governs the finishing word after it: at most two words between them
// ("never finishes", "is not finished", "does not by itself satisfy"), or a "no" that opens
// the clause's subject ("no item with the same title finishes a blocker").
const GOVERNS = /(?:\b(?:never|not|no longer|cannot)|n't)(?:\s+[\w-]+){0,2}\s+$|^\W*(?:no|nothing|none)\b/i
const CONDITION = /^\W*(?:\w+\W+){0,3}?(?:when|whenever|once|if|after|as soon as)\b/i
// The clauses of a sentence that finish something affirmatively and key that on a title.
function titleFinishing(sentence) {
  const clauses = sentence.split(/[;:]/)
  return clauses.some((c, i) => [...c.matchAll(FINISH_WORD)].some(m => {
    if (GOVERNS.test(c.slice(0, m.index))) return false
    const after = c.slice(m.index + m[0].length)
    const scope = CONDITION.test(after) ? [c, ...clauses.slice(i + 1)] : [c]
    return scope.some(x => TITLE_KEY.test(x))
  }))
}
// loop-state.mjs of the checked tree (a copy, in the mutation tests), for parseState and FIELD_LABELS.
const stateLib = root => import(pathToFileURL(path.join(root, STATE_SRC)).href)

// The sentences of a text with where each starts: split after a '.', '!' or '?' before
// whitespace, at a blank line, and at a table cell's '|'.
function sentences(text) {
  const out = []
  let at = 0
  for (const m of text.matchAll(/(?<=[.!?])\s+|\n\s*\n|\|/g)) {
    out.push({ at, s: text.slice(at, m.index) })
    at = m.index + m[0].length
  }
  out.push({ at, s: text.slice(at) })
  return out
}

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

  await r.check('loop: clone.md installs dependencies through loop-lock.mjs exec', () => {
    const deps = step(rd(CLONE), 4, 'Dependencies', CLONE)
    const exec = new RegExp(`^${LOCK} exec <P> --generation <N> --label deps --cwd <W>(?: --timeout-ms (\\d+))? -- \\S`)
    const cmds = commands(deps)
    const bad = []
    const m = cmds.map(c => exec.exec(c.cmd)).find(Boolean)
    if (!m) bad.push(`${CLONE} step 4 has no loop-lock.mjs exec <P> --generation <N> --label deps --cwd <W> --timeout-ms <T> -- <install>`)
    else if (!timeoutOk(m[1])) bad.push(`${CLONE} step 4: the install exec needs --timeout-ms of at most ${MAX_EXEC_MS} (the Bash limit backgrounds a longer run), not ${m[1] ?? 'none'}`)
    for (const c of cmds) if (!c.cmd.startsWith(`${LOCK} exec `)) bad.push(`${CLONE} step 4 runs the install directly: ${c.cmd}`)
    for (const m of deps.matchAll(/`(cd <W>[^`]*)`/g)) bad.push(`${CLONE} step 4 runs the install directly: ${m[1]}`)
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
      [`${CLONE} step 4`, step(rd(CLONE), 4, 'Dependencies', CLONE)],
    ]) {
      const t = flat(text)
      const NONZERO = /`exited` with (?:any other|a non-zero) `exit`/g
      const hits = [...t.matchAll(NONZERO)]
      if (!hits.length) bad.push(`${where} never says that \`exited\` with a non-zero \`exit\` is a failure`)
      for (const m of hits) {
        // The sentence that names the non-zero exit must call it a failure, and no pass.
        const s = sentenceAt(t, m.index)
        if (!FAIL_WORD.test(s) || PASS_WORD.test(s)) bad.push(`${where} calls \`exited\` with a non-zero \`exit\` a pass, or no failure: "${s.trim()}"`)
      }
      const LINGERING = `\`lingering\` (exit ${code[1]})`
      const rule = bullets(text).map(flat).find(b => b.startsWith(`- ${LINGERING}`))
      if (!t.includes(LINGERING)) bad.push(`${where} never handles the \`lingering\` state (exit ${code[1]})`)
      else if (!rule) bad.push(`${where} has no bullet that opens with ${LINGERING}`)
      else if (!NEVER_PASS.test(rule) || SAYS_PASS.test(rule)) bad.push(`${where} lets a \`lingering\` run pass: its rule never says it is no pass ("never a pass", "is the failure")`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: a firing leaves ## Now holding exactly the placeholder loop-state.mjs reads as empty', () => {
    // loop-state.mjs owns the placeholder; the recovery planner reads STATE.md through it.
    const m = /export const PLACEHOLDER = '([^']+)'/.exec(rd(STATE_SRC))
    assert.ok(m, `${STATE_SRC}: no PLACEHOLDER constant`)
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
  await r.check('loop: SKILL.md and clone.md never run git -C <W>, add a worktree, or put <W> at <S>/worktree', () => {
    // <W> is the clone loop-clone.mjs owns (stage 0c-2): the main session runs git there only
    // through the helpers, and the 0c-1 worktree layout is gone from the loop's prose.
    const bad = []
    for (const f of [SKILL, CLONE]) {
      const text = rd(f)
      for (const [label, re] of [
        ['git -C <W>', /\bgit\s+-C\s+<W>/g],
        ['worktree add', /\bworktree\s+add\b/g],
        ['`<W>` = `<S>/worktree`', /`<W>`\s*=\s*`<S>\/worktree`/g],
      ]) for (const m of text.matchAll(re)) bad.push(`${f}:${lineOf(text, m.index)}: ${label}`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: every loop-clone.mjs command in skills/ (but git) and every reflex-bundle.mjs save, reset and apply carries --generation <N>', () => {
    // An invocation is a helper path (scripts/loop-clone.mjs prepare) or the name followed by
    // <P> or a flag; the bare name in a sentence is not one.
    const bad = []
    for (const f of filesUnder(root, 'skills')) {
      rd(f).split('\n').forEach((line, i) => {
        for (const [name, re, fenced] of FENCED) {
          for (const m of line.matchAll(re)) {
            if (!m[1] && !/^\s+(?:<P>|--)/.test(m[3])) continue
            if (!fenced(m[2])) continue
            if (!/(?:^|\s)--generation <N>(?:\s|$)/.test(m[3])) bad.push(`${f}:${i + 1}: ${name} ${m[2]} without --generation <N>`)
          }
        }
      })
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 8 closes the run records after the ledger append and before the release', () => {
    // close reads the ledger to decide which run records it may delete, and it is fenced by
    // the generation, so it runs once the entry is appended and while the lock is held.
    const { text } = section(rd(SKILL), 8, SKILL)
    const cmds = commands(text)
    const closes = cmds.filter(c => c.cmd === CLOSE)
    const release = cmds.find(c => c.cmd === `${LOCK} release <P> --generation <N>`)
    const ledger = text.indexOf('2. Append exactly one ledger entry')
    const bad = closes.length ? [] : [`${SKILL} section 8 names no \`${CLOSE}\``]
    for (const c of closes) {
      if (ledger < 0 || c.at < ledger) bad.push(`${SKILL} section 8 closes the run records before the ledger append ("2. Append exactly one ledger entry")`)
      if (!release || c.at > release.at) bad.push(`${SKILL} section 8 closes the run records after the release`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 1 step 5 runs the recovery planner with --generation <N>', () => {
    const plan = step(section(rd(SKILL), 1, SKILL).text, 5, 'Plan the recovery', SKILL)
    const planner = /^node <T>\/scripts\/loop-recover\.mjs <P> --generation <N>(?:\s|$)/
    assert.ok(commands(plan).some(c => planner.test(c.cmd)), `${SKILL} section 1 step 5 names no \`node <T>/scripts/loop-recover.mjs <P> --generation <N>\``)
  })

  await r.check('loop: skills/ never names loop-review.mjs', () => {
    // The owner's review (fetch, retire) runs in the owner's terminal only (brief 15): a
    // firing must never be told to vouch for its own work.
    const bad = []
    for (const f of filesUnder(root, 'skills')) {
      rd(f).split('\n').forEach((line, i) => {
        if (/loop-review\.mjs/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: skills/loop/ never discards work in place (checkout --, restore --worktree, restore -W, git clean, reset --hard) except on a line that forbids it', () => {
    const bad = []
    for (const f of filesUnder(root, 'skills/loop')) {
      rd(f).split('\n').forEach((line, i) => {
        for (const [label, re] of DISCARD) {
          const g = new RegExp(re.source, 'g')
          if ([...line.matchAll(g)].some(m => !forbidsAt(line, m.index))) bad.push(`${f}:${i + 1}: ${label}`)
        }
      })
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the Save and reset procedure saves, writes the sha into STATE.md, then resets', () => {
    // Ruling R5: the bundle sha reaches STATE.md before anything in <W> is reset, so a flag
    // outcome is never left pointing at work that is gone.
    const s7 = section(rd(SKILL), 7, SKILL).text
    const m = /^\*\*Save and reset\b[^*\n]*\*\*/m.exec(s7)
    assert.ok(m, `${SKILL} section 7 has no "**Save and reset**" procedure`)
    const rest = s7.slice(m.index + m[0].length)
    const end = rest.search(/^\*\*/m)
    const steps = (end < 0 ? rest : rest.slice(0, end)).split(/^(?=\d+\. )/m).slice(1)
    const SAVE = /^node <T>\/scripts\/reflex-bundle\.mjs save <P> --generation <N> --why /
    const RESET = /^node <T>\/scripts\/reflex-bundle\.mjs reset <P> --generation <N> --sha /
    const has = (s, re) => commands(s).some(c => re.test(c.cmd))
    const save = steps.findIndex(s => has(s, SAVE))
    const reset = steps.findIndex(s => has(s, RESET))
    // The Edit step must store the save's returned sha, in full, and the Edit of `STATE.md`
    // itself must be what stores it, affirmatively: an Edit that only moves the item (Codex g4
    // #4), a sha written somewhere else beside it, an Edit that "never writes" it (Codex f2
    // #5), "No Edit ... writes" or a destination after the sha passes no sha on: the clause reads
    // "One Edit of `STATE.md` writes the full `sha` at" (its place in STATE.md). Line breaks are
    // read as spaces.
    const STORES_SHA = /\bOne Edit of `STATE\.md` (?:writes|stores|records) the full `sha` at\b/
    const edit = steps.findIndex((s, i) => i > save && !has(s, SAVE) && !has(s, RESET) && STORES_SHA.test(s.replace(/\s+/g, ' ')))
    const bad = []
    if (save < 0) bad.push('the Save and reset procedure has no step that runs `node <T>/scripts/reflex-bundle.mjs save <P> --generation <N> --why <why>`')
    if (reset < 0) bad.push('the Save and reset procedure has no step that runs `node <T>/scripts/reflex-bundle.mjs reset <P> --generation <N> --sha <sha>`')
    if (save >= 0 && reset >= 0) {
      if (reset <= save) bad.push(`the Save and reset procedure resets before it saves (step ${reset + 1} resets, step ${save + 1} saves)`)
      else if (!(edit > save && edit < reset)) bad.push('no step between the save and the reset writes the sha into `STATE.md` with one Edit')
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the panel snapshot never refreshes <P>/.git/index (diff.autoRefreshIndex=false)', () => {
    // A plain `git diff` refreshes the index's stat data and rewrites <P>/.git/index; the loop
    // never writes <P>'s tree or .git outside <S>.
    const skill = rd(SKILL)
    const { text, at } = section(skill, 5, SKILL)
    const bad = []
    let seen = 0
    for (const c of commands(text)) {
      for (const g of c.cmd.matchAll(/\bgit((?:\s+-c\s+\S+)*)\s+diff\b/g)) {
        seen++
        if (!/(?:^|\s)-c\s+diff\.autoRefreshIndex=false(?:\s|$)/.test(g[1])) {
          bad.push(`${SKILL}:${lineOf(skill, at + c.at)}: the panel snapshot runs git diff without -c diff.autoRefreshIndex=false`)
        }
      }
    }
    if (!seen) bad.push(`${SKILL} section 5 has no panel snapshot (git -c diff.autoRefreshIndex=false diff HEAD ...)`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the Lost-lock rule counts a loop-clone.mjs or reflex-bundle.mjs exit 3 "not-holder" as lost', () => {
    const lost = bullets(step(rd(SKILL), 3, 'Acquire the firing lock', SKILL)).filter(b => b.startsWith('- **Lost lock.**'))
    assert.equal(lost.length, 1, `${SKILL} section 1 step 3 has no "- **Lost lock.**" bullet`)
    const t = flat(lost[0]), bad = []
    for (const h of ['loop-clone.mjs', 'reflex-bundle.mjs']) {
      if (!rd(`scripts/${h}`).includes("state: 'not-holder'")) bad.push(`scripts/${h} no longer answers not-holder`)
      if (!new RegExp(`\`${esc(h)}\`(?: or \`[\\w.-]+\`)* exit 3 with \`"state": "not-holder"\``).test(t)) {
        bad.push(`the Lost-lock rule never names \`${h}\` exit 3 with \`"state": "not-holder"\``)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: clone.md says a not-holder from commit, bundle or close can leave a published bundle without its sidecar, which the next clone preparation regenerates', () => {
    // R31 (sharpened), prose#2: delivery checks the lock right before a bundle's rename and
    // again right before its sidecar, so a lock lost between the two leaves the new bundle
    // published while its sidecar is missing or still names the older tip. The next clone
    // preparation's bundle sync finds it not current and writes both again.
    const clone = rd(CLONE)
    const m = /^\|[^|\n]*\|\s*`not-holder`\s*\|.*$/m.exec(clone)
    assert.ok(m, `${CLONE} has no refusal-table row for \`not-holder\``)
    const row = m[0], at = `${CLONE}:${lineOf(clone, m.index)}`, bad = []
    if (/\bnothing\b[^.;|]*\bpublish/i.test(row)) bad.push(`${at}: the not-holder row promises that nothing was published`)
    for (const c of ['commit', 'bundle', 'close']) {
      if (!row.includes(`\`${c}\``)) bad.push(`${at}: the not-holder row never names \`${c}\` as answering it during delivery`)
    }
    if (!/\bpublished\b[^.|]*\bwithout\b[^.|]*\bsidecar\b/i.test(row)) bad.push(`${at}: the not-holder row never says that the bundle may be published without its sidecar`)
    if (!/\bnext clone preparation\b[^.|]*\bregenerates\b/i.test(row)) bad.push(`${at}: the not-holder row never says that the next clone preparation regenerates it`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the STATE.md template in loop-templates.md parses with parseState with no problems', async () => {
    // Bootstrap copies the template, and the first firing reads it through the one item
    // grammar (R4): a template the grammar reads as damaged parks every item a person copies.
    const { parseState } = await stateLib(root)
    const m = /^## STATE\.md template[\s\S]*?```markdown\n([\s\S]*?)```/m.exec(rd(TEMPLATES))
    assert.ok(m, `${TEMPLATES} has no \`\`\`markdown block under "## STATE.md template"`)
    const st = parseState(m[1])
    const bad = st.problems.map(p => `the template: ${p.kind}${p.name ? ` ${p.name}` : ''}${p.line ? ` (template line ${p.line})` : ''}`)
    for (const it of st.items) for (const p of it.problems) bad.push(`${it.section} item ${JSON.stringify(it.title)}: ${p.kind}: ${p.detail}`)
    for (const e of st.entries) for (const p of e.problems) bad.push(`entry ${JSON.stringify(e.title)}: ${p.kind}`)
    if (!st.items.some(i => i.section === 'Backlog')) bad.push('the template holds no ## Backlog item')
    assert.deepEqual(bad, [])
  })

  await r.check('loop: loop-templates.md documents every item field label loop-state.mjs reads (FIELD_LABELS)', async () => {
    // Each label is a bullet of its own that opens with it (R22): "- `decided:` ...".
    const { FIELD_LABELS } = await stateLib(root)
    const t = rd(TEMPLATES)
    const missing = FIELD_LABELS.filter(l => !new RegExp(`^\\s*- \`${esc(l)}:\``, 'm').test(t))
    assert.deepEqual(missing.map(l => `${TEMPLATES} never documents \`${l}:\` (a bullet that opens with it)`), [])
  })

  await r.check(`loop: the ## Needs decision entry templates are headed \`${ENTRY_HEADING}\``, () => {
    // Entries are keyed by id (R15): the release, the upserts and the planner find them by the
    // heading's first token. Every `### ` line of a fenced block in loop-templates.md is an
    // entry heading; the panel and the delegate-flagged templates each have one.
    const t = rd(TEMPLATES), bad = []
    let n = 0
    for (const b of t.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
      const start = b.index + b[0].indexOf('\n') + 1
      let at = start
      for (const line of b[1].split('\n')) {
        if (/^###\s/.test(line)) {
          if (line.trimEnd() === ENTRY_HEADING) n++
          else bad.push(`${TEMPLATES}:${lineOf(t, at)}: \`${line.trimEnd()}\`, not \`${ENTRY_HEADING}\``)
        }
        at += line.length + 1
      }
    }
    if (n < 2) bad.push(`${TEMPLATES} needs both entry templates (panel and delegate-flagged) headed \`${ENTRY_HEADING}\`; found ${n}`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: no doc says a blocker is finished by its title', () => {
    // Audit cx-lr07: a reused title, or a done analysis item whose follow-up is still open,
    // released dependents early. A blocker is an id (R10, R11).
    const bad = []
    for (const f of docFiles(root)) {
      const text = rd(f)
      for (const { at, s } of sentences(text)) {
        const t = flat(s)
        const byTitle = OLD_TITLE_BLOCKER.test(t) || (BLOCKER_WORD.test(t) && titleFinishing(t))
        if (byTitle) bad.push(`${f}:${lineOf(text, at + s.search(/\S|$/))}: ${t.trim()}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: bootstrap.md keeps a known dependency as `blocked-by: <title>`, which parks the dependent behind its prerequisite', async () => {
    // R32 (Codex g3#2): bootstrap writes items before any id exists, so a dependency the task
    // sources name is kept as a title blocker; R10 parks the dependent (title-blocker, with the
    // candidate id) until the owner writes the id. A blanked dependency let the dependent run
    // first. The form step 4 names is then read through loop-state.mjs of the checked tree.
    const text = rd(BOOTSTRAP)
    const s4 = step(text, 4, 'Build the initial', BOOTSTRAP)
    const form = /`blocked-by: <([^>`]*\btitle)>`/.exec(flat(s4))
    assert.ok(form, `${BOOTSTRAP} step 4 never writes a dependency as \`blocked-by: <...title>\``)
    assert.ok(/- origin: bootstrap/.test(s4), `${BOOTSTRAP} step 4 never writes \`- origin: bootstrap\``)
    const { applyEdits, planNormalize, planPick } = await stateLib(root)
    const D = String.fromCodePoint(0xb7), E = String.fromCodePoint(0x2014)
    const item = (title, blocker) => [`- [ ] ${title} ${D} class: unclassified`, '  - origin: bootstrap', `  - blocked-by: ${blocker}`, `  - status: ${E}`]
    let st = ['# P - Loop State', '', '## Now', '(empty)', '', '## Backlog', ...item('Deploy consumer', 'Create API'), ...item('Create API', E), '',
      '## Needs decision', '(empty)', '', '## Blocked', '(empty)', '', '## Done', '(empty)', '', '## Last run', '(never run)', ''].join('\n')
    const nz = planNormalize(st, {})
    st = applyEdits(st, nz.edits)
    const pk = planPick(st, { level: 3 })
    const dep = pk.skipped.find(x => x.title === 'Deploy consumer')
    assert.equal(pk.title, 'Create API', `a dependent written as step 4 says is picked before its prerequisite: ${JSON.stringify(pk)}`)
    assert.equal(dep?.reason, 'title-blocker', `the dependent is not parked as title-blocker: ${JSON.stringify(pk.skipped)}`)
    assert.ok(dep.detail.includes(`candidate ${pk.id}`), `the park names no candidate id: ${dep.detail}`)
  })

  await r.check('loop: bootstrap.md renames a prerequisite whose title is a none spelling before it writes the blocker (R32a)', async () => {
    // R32a (Codex fix1-g2#3): `blocked-by: None` (or `N/A`, `--`) reads as no blocker, so a
    // prerequisite with such a title let its dependent run first. Step 4 names every spelling
    // loop-state.mjs reads as none (its NONE set, read from the source), in any case, and the
    // suffix it appends; each renamed title, written as step 4 says, then parks the dependent.
    const s4 = flat(step(rd(BOOTSTRAP), 4, 'Build the initial', BOOTSTRAP))
    const src = rd(STATE_SRC)
    const set = /const NONE = new Set\(\[([^\]]*)\]\)/.exec(src)
    assert.ok(set, `${STATE_SRC} has no \`const NONE = new Set([...])\``)
    const consts = Object.fromEntries([...src.matchAll(/^const ([A-Z]+) = String\.fromCodePoint\((0x[0-9a-f]+)\)/gm)].map(m => [m[1], String.fromCodePoint(Number(m[2]))]))
    const spellings = set[1].split(',').map(x => x.trim()).map(x => /^'(.*)'$/.exec(x)?.[1] ?? consts[x]).filter(x => x !== '')
    const named = new Set(ticked(s4).map(x => x.toLowerCase()))
    const bad = spellings.filter(x => x === undefined || !named.has(x)).map(x => `${BOOTSTRAP} step 4 never names the none spelling \`${x}\``)
    if (!/\bin any case\b/.test(s4)) bad.push(`${BOOTSTRAP} step 4 never says the none spellings count in any case`)
    const suffix = /\bappending `([^`]+)` to its title\b/.exec(s4)?.[1]
    if (!suffix) bad.push(`${BOOTSTRAP} step 4 never renames the prerequisite by appending a suffix (\`appending \` (task)\` to its title\`)`)
    assert.deepEqual(bad, [])
    const { applyEdits, planNormalize, planPick } = await stateLib(root)
    const D = String.fromCodePoint(0xb7), E = String.fromCodePoint(0x2014)
    const item = (title, blocker) => [`- [ ] ${title} ${D} class: unclassified`, '  - origin: bootstrap', `  - blocked-by: ${blocker}`, `  - status: ${E}`]
    for (const x of spellings.flatMap(x => [...new Set([x, x.toUpperCase(), x[0].toUpperCase() + x.slice(1)])])) {
      const title = `${x}${suffix}`
      let st = ['# P - Loop State', '', '## Now', '(empty)', '', '## Backlog', ...item('Deploy consumer', title), ...item(title, E), '',
        '## Needs decision', '(empty)', '', '## Blocked', '(empty)', '', '## Done', '(empty)', '', '## Last run', '(never run)', ''].join('\n')
      st = applyEdits(st, planNormalize(st, {}).edits)
      const pk = planPick(st, { level: 3 })
      const dep = pk.skipped.find(s => s.title === 'Deploy consumer')
      if (pk.title !== title || dep?.reason !== 'title-blocker') bad.push(`a prerequisite titled \`${x}\`, renamed to \`${title}\`, is picked before its prerequisite or not parked: ${JSON.stringify({ picked: pk.title, dep })}`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 1 step 5 applies the planner\'s clear.edits and checks them, and treats now-conflict as the item-edit incident', () => {
    // R29 (Codex g2#3, g2#4): clear-now deletes the one ## Now block the planner planned, never
    // the whole section, and confirms it; copies that are not one item moved halfway pause the
    // loop with both kept.
    const plan = step(section(rd(SKILL), 1, SKILL).text, 5, 'Plan the recovery', SKILL)
    const bs = bullets(plan).map(flat)
    const clear = bs.find(b => b.startsWith('- `clear-now`'))
    const conflict = bs.find(b => b.startsWith('- `now-conflict`'))
    const bad = []
    if (!clear) bad.push(`${SKILL} section 1 step 5 has no \`clear-now\` bullet`)
    else {
      if (!/\bApply `clear\.edits`/.test(clear)) bad.push(`${SKILL} section 1 step 5: the \`clear-now\` bullet never applies \`clear.edits\``)
      if (!clear.includes(`${ITEMS} check <P> --expect <clear.expect_sha256>`)) bad.push(`${SKILL} section 1 step 5: the \`clear-now\` bullet never runs \`${ITEMS} check <P> --expect <clear.expect_sha256>\``)
      if (/\breplace\b[^.]*`## Now`[^.]*`\(empty\)`/i.test(clear)) bad.push(`${SKILL} section 1 step 5: the \`clear-now\` bullet replaces the whole \`## Now\` section`)
    }
    if (!conflict) bad.push(`${SKILL} section 1 step 5 has no \`now-conflict\` bullet`)
    else if (!/\bitem-edit incident\b/.test(conflict)) bad.push(`${SKILL} section 1 step 5: the \`now-conflict\` bullet never calls it an item-edit incident`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 1 step 5 names every now-conflict reason loop-recover.mjs prints and every field clear-now compares (R29a)', () => {
    // R29a (Codex fix1-g2#1): clear-now deletes the ## Now copy only when the other copy agrees
    // on the digest and on blocked-by:, decided:, no-change-ok: and the origin lines, so the
    // prose must say so (a prerequisite added to one copy is never dropped), and the
    // now-conflict bullet names each reason the planner can print (its CONFLICT_WHY keys).
    const src = rd(RECOVER_SRC)
    const table = /const CONFLICT_WHY = \{([\s\S]*?)\n\}/.exec(src)
    if (!table) throw new Error(`${RECOVER_SRC}: no CONFLICT_WHY table`)
    const reasons = [...table[1].matchAll(/^\s*'([a-z-]+)':/gm)].map(m => m[1])
    const plan = step(section(rd(SKILL), 1, SKILL).text, 5, 'Plan the recovery', SKILL)
    const bs = bullets(plan).map(flat)
    const clear = bs.find(b => b.startsWith('- `clear-now`')) ?? ''
    const conflict = bs.find(b => b.startsWith('- `now-conflict`')) ?? ''
    const bad = reasons.length ? [] : [`${RECOVER_SRC}: CONFLICT_WHY lists no reason`]
    for (const x of reasons) if (!ticked(conflict).includes(x)) bad.push(`${SKILL} section 1 step 5: the \`now-conflict\` bullet never names the reason \`${x}\``)
    for (const f of ['blocked-by:', 'decided:', 'no-change-ok:']) if (!ticked(clear).includes(f)) bad.push(`${SKILL} section 1 step 5: the \`clear-now\` bullet never names \`${f}\` among what the copies share`)
    if (!/\borigin lines\b/.test(clear)) bad.push(`${SKILL} section 1 step 5: the \`clear-now\` bullet never names the origin lines among what the copies share`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: README\'s skip table and SKILL.md section 3.1 name every release refusal pick can report', () => {
    // R16, R30, R30a (Codex fix1-g1#2): each refusal releaseFor returns reaches ## Last run as
    // a skipped row, so the owner's table and section 3.1 name it. entry-item-now never does:
    // pick refuses `now-occupied` before any release.
    const src = rd(STATE_SRC)
    const at = src.indexOf('function releaseFor(')
    if (at < 0) throw new Error(`${STATE_SRC}: no releaseFor`)
    const body = src.slice(at, src.indexOf('\n}\n', at))
    const reasons = [...new Set([...body.matchAll(/\bskip: '([a-z-]+)'/g)].map(m => m[1]))].filter(x => x !== 'entry-item-now')
    const bad = reasons.includes('ambiguous-carrier') ? [] : [`${STATE_SRC}: releaseFor never refuses \`ambiguous-carrier\``]
    const rows = part(rd('README.md'), '### Why the loop skips an item', 'README.md').split('\n').map(l => /^\| `([a-z-]+)` \|/.exec(l)?.[1]).filter(Boolean)
    const s31 = flat(rd(SKILL)).split('**3.1 ·')[1]?.split('**3.2 ·')[0] ?? ''
    if (!s31) bad.push(`${SKILL} has no section 3.1`)
    for (const x of reasons) {
      if (!rows.includes(x)) bad.push(`README.md: Why the loop skips an item has no row for \`${x}\``)
      if (s31 && !ticked(s31).includes(x)) bad.push(`${SKILL} section 3.1 never names \`${x}\``)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: section 8\'s ledger entry records pick\'s unledgered as done_items, and the ## Done trim keeps unledgered items', () => {
    // R27 (Codex g2#1, g3#1; Claude EP3, LR07-B): ## Done may be the only record of a completed
    // item's id and origin until a ledger entry records it, so the entry records pick's
    // unledgered and the trim never drops those items. The trim's edits come from
    // loop-items.mjs trim, which deletes whole blocks (PDC-2; the check after this one).
    const skill = rd(SKILL), bad = []
    const s8 = flat(section(skill, 8, SKILL).text)
    if (!/`done_items` is the `unledgered` list `pick` printed/.test(s8)) bad.push(`${SKILL} section 8 never writes \`done_items\` from pick's \`unledgered\``)
    const s6 = flat(section(skill, 6, SKILL).text)
    if (/\btrim `## Done`/.test(s6) && !/\btrim `## Done` \(Item edits, Trimming `## Done`\)/.test(s6)) bad.push(`${SKILL} section 6 trims \`## Done\` without the Trimming \`## Done\` rule (Item edits)`)
    const rule = bullets(part(skill, '## Item edits', SKILL)).map(flat).find(b => b.startsWith('- **Trimming `## Done`'))
    if (!rule) bad.push(`${SKILL} Item edits has no "Trimming \`## Done\`" bullet`)
    else {
      if (!/\bkeeps\b[^.]*\bevery item the ledger does not record done yet \(one `unledgered` names\b/.test(rule)) bad.push(`${SKILL} Item edits: Trimming \`## Done\` never keeps the items \`unledgered\` names`)
    }
    const schema = part(rd(TEMPLATES), '## LEDGER.jsonl entry schema', TEMPLATES)
    if (!/"done_items": \[\{"item_id"/.test(schema)) bad.push(`${TEMPLATES}: the LEDGER.jsonl schema has no \`done_items\``)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md\'s ## Done trim runs loop-items.mjs trim, applies its edits with Edit and checks them with check --expect', () => {
    // R27, R14: the trim is planned in code (the 20 newest kept, an unledgered item never
    // dropped, whole blocks deleted); the prose only applies the printed edits and confirms them.
    const rule = bullets(part(rd(SKILL), '## Item edits', SKILL)).find(b => b.startsWith('- **Trimming `## Done`'))
    const where = `${SKILL} Item edits: Trimming \`## Done\``
    const bad = []
    if (!rule) bad.push(`${SKILL} Item edits has no "Trimming \`## Done\`" bullet`)
    else {
      const cmds = commands(rule)
      const t = cmds.findIndex(c => c.cmd === TRIM)
      if (t < 0) bad.push(`${where} never runs \`${TRIM}\``)
      else {
        const c = cmds.findIndex((x, i) => i > t && x.cmd === CHECK_EXPECT)
        if (c < 0) bad.push(`${where} never runs \`${CHECK_EXPECT}\` after the trim`)
        if (!APPLIES.test(flat(rule.slice(cmds[t].at, c < 0 ? rule.length : cmds[c].at)))) bad.push(`${where} never says to apply trim's \`edits\` with Edit before its check`)
      }
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: every reflex-bundle.mjs save in skills/ passes --item <id> (SKILL.md section 7 runs one)', () => {
    // R18: the save reads the item's digest from STATE.md itself and binds the bundle to it.
    // An invocation is a helper path or the name followed by <P> or a flag.
    const bad = []
    for (const f of filesUnder(root, 'skills')) {
      rd(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(scripts\/)?reflex-bundle\.mjs save\b([^`\n]*)/g)) {
          if (!m[1] && !/^\s+(?:<P>|--)/.test(m[2])) continue
          if (!/(?:^|\s)--item <id>(?:\s|$)/.test(m[2])) bad.push(`${f}:${i + 1}: reflex-bundle.mjs save without --item <id>`)
        }
      })
    }
    const SAVE = /^node <T>\/scripts\/reflex-bundle\.mjs save <P> .*(?:^|\s)--item <id>(?:\s|$)/
    if (!commands(section(rd(SKILL), 7, SKILL).text).some(c => SAVE.test(c.cmd))) bad.push(`${SKILL} section 7 runs no reflex-bundle.mjs save with --item <id>`)
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 3 normalizes, applies the edits and checks them before pick, then checks pick\'s edits', () => {
    // R1, R13, R14: ids exist before the pick reads them, and each plan's edits are confirmed
    // against its expect_sha256 before anything else reads STATE.md.
    const { text } = section(rd(SKILL), 3, SKILL)
    const cmds = commands(text)
    const where = () => `${SKILL} section 3`
    const bad = []
    const n = cmds.findIndex(c => c.cmd === NORMALIZE)
    const p = cmds.findIndex(c => c.cmd === PICK)
    if (n < 0) bad.push(`${where()} names no \`${NORMALIZE}\``)
    if (p < 0) bad.push(`${where()} names no \`${PICK}\``)
    if (n >= 0 && p >= 0) {
      if (p < n) bad.push(`${where()} runs pick before normalize`)
      else {
        const c1 = cmds.findIndex((c, i) => i > n && i < p && c.cmd === CHECK_EXPECT)
        if (c1 < 0) bad.push(`${where()} runs no \`${CHECK_EXPECT}\` between normalize and pick`)
        if (!APPLIES.test(flat(text.slice(cmds[n].at, cmds[c1 < 0 ? p : c1].at)))) bad.push(`${where()} never says to apply normalize's \`edits\` with Edit before its check`)
      }
      const c2 = cmds.findIndex((c, i) => i > p && c.cmd === CHECK_EXPECT)
      if (c2 < 0) bad.push(`${where()} runs no \`${CHECK_EXPECT}\` after pick`)
      if (!APPLIES.test(flat(text.slice(cmds[p].at, c2 < 0 ? text.length : cmds[c2].at)))) bad.push(`${where()} never says to apply pick's \`edits\` with Edit before its check`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: the follow-up reaches loop-items.mjs followup only through --input <file>, never a title argument', () => {
    // R17: the follow-up's title and notes are foreign text (the analysis wrote them), so they
    // go into a JSON file written with the Write tool, never onto a command line.
    const bad = []
    for (const f of docFiles(root)) {
      rd(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(scripts\/)?loop-items\.mjs followup\b([^`\n]*)/g)) {
          if (!m[1] && !/^\s+(?:<[^>]+>|--)/.test(m[2])) continue
          if (!/(?:^|\s)--input\s+\S/.test(m[2]) || /--(?:title|notes)\b/.test(m[2])) {
            bad.push(`${f}:${i + 1}: loop-items.mjs followup without --input <file>, or with a title or notes argument`)
          }
        }
      })
    }
    const { text } = section(rd(SKILL), 5, SKILL)
    const call = commands(text).find(c => c.cmd === FOLLOWUP)
    if (!call) bad.push(`${SKILL} section 5 runs no \`${FOLLOWUP}\``)
    else if (!/`<S>\/briefs\/<id>-followup\.json` with the Write tool\b/.test(flat(text.slice(0, call.at)))) {
      bad.push(`${SKILL} section 5 never says to write the follow-up file with the Write tool (\`<S>/briefs/<id>-followup.json\` with the Write tool) before the call`)
    }
    assert.deepEqual(bad, [])
  })

  await r.check('loop: SKILL.md section 5 counts both follow-up answers (reused true and false) as a success, and only a refusal or an error as the incident', () => {
    // Codex g3#3, fix1-g2#5: followup answers `"state": "ok"` with `"reused": false` (a new
    // follow-up, its insertion in edits) or `"reused": true` (an interrupted firing created it,
    // no edits). The prose once called only reused true a success, so every new follow-up was an
    // incident. The driver accepts both on its own, so the wording is checked here: the rule
    // after the call (to the next bullet at its parent's level) names both answers, a sentence
    // with no restriction counts both as a success, and the incident sentence names a refusal
    // (exit 3) and an error (exit 2) and no ok answer.
    const { text } = section(rd(SKILL), 5, SKILL)
    const call = commands(text).find(c => c.cmd === FOLLOWUP)
    assert.ok(call, `${SKILL} section 5 runs no \`${FOLLOWUP}\``)
    const own = text.slice(text.lastIndexOf('\n', call.at) + 1).search(/\S/)
    const parent = text.slice(0, call.at).split('\n').findLast(l => /^\s*- /.test(l) && l.search(/\S/) < own)
    const indent = parent ? parent.search(/\S/) : 0
    const rest = text.slice(call.at)
    const stop = rest.search(new RegExp(`\\n {0,${indent}}(?:- |\\S)`))
    const rule = sentences(rest.slice(0, stop < 0 ? rest.length : stop)).map(x => flat(x.s))
    const T = '`"reused": true`', F = '`"reused": false`', OK = /`"(?:reused|state)": (?:true|false|"ok")`/
    const bad = []
    for (const v of [T, F]) if (!rule.some(s => s.includes(v))) bad.push(`${SKILL} section 5: the follow-up rule never names ${v}`)
    const success = rule.filter(s => PASS_WORD.test(s))
    if (!success.some(s => (/\bboth\b/i.test(s) || (s.includes(T) && s.includes(F))) && !/\b(?:only|never|not)\b/i.test(s))) {
      bad.push(`${SKILL} section 5: no sentence counts both answers as a success (\`"state": "ok"\` with ${F} and with ${T})`)
    }
    const incident = rule.filter(s => /\bincident\b/.test(s))
    if (!incident.some(s => /\brefusal \(exit 3\)/.test(s) && /\berror \(exit 2\)/.test(s))) bad.push(`${SKILL} section 5: no incident sentence names a refusal (exit 3) and an error (exit 2)`)
    for (const s of incident) if (OK.test(s) || /\b(?:any|every) other answer\b/i.test(s)) bad.push(`${SKILL} section 5: an incident sentence names an ok answer, or every other answer: ${s.trim()}`)
    assert.deepEqual(bad, [])
  })
}
