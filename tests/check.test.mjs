// tests/check.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from './helpers.mjs'

const CHECK = path.join(ROOT, 'scripts', 'check.mjs')
const runCheck = root => spawnSync(process.execPath, [CHECK, ...(root ? [root] : [])], { cwd: os.tmpdir(), encoding: 'utf8' })
// A throwaway copy of the plugin, removed when the test ends. Git data, worktrees and
// executor scratch are left out.
const SKIP = new Set(['.git', '.worktrees', '.superpowers'])
const copyRepo = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-check-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.cpSync(ROOT, dir, { recursive: true, filter: src => !SKIP.has(path.basename(src)) })
  return dir
}
// Replace text in a copied file; throws if the text is absent, so a mutation cannot silently miss.
const mutate = (dir, rel, from, to) => {
  const f = path.join(dir, rel), s = fs.readFileSync(f, 'utf8')
  if (!s.includes(from)) throw new Error(`${rel}: mutation anchor not found: ${from}`)
  fs.writeFileSync(f, s.split(from).join(to))
}
const append = (dir, rel, text) => fs.appendFileSync(path.join(dir, rel), text)
// Append one line (after a newline the file may lack) and return its 1-based line number.
const appendLine = (dir, rel, line) => {
  const f = path.join(dir, rel)
  const s = fs.readFileSync(f, 'utf8')
  const out = `${s.endsWith('\n') ? s : `${s}\n`}${line}\n`
  fs.writeFileSync(f, out)
  return out.split('\n').length - 1
}

test('passes on the plugin repo when run from another directory with no argument', () => {
  const r = runCheck(null)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, / 0 failed,/)
})

test('fails and names the file when a doc references an unknown workflow', t => {
  const dir = copyRepo(t)
  fs.appendFileSync(path.join(dir, 'README.md'), '\nWorkflow({name: "tech-lead:no-such-workflow", args: {}})\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /README\.md: tech-lead:no-such-workflow/)
})

test('fails when a workflow meta is not a pure literal', t => {
  const dir = copyRepo(t)
  const f = path.join(dir, 'workflows', 'triage.js')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("name: 'triage'", 'name: `triage`'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL compile workflows\/triage\.js/)
})

test('fails when the panel skill drops an agreement value', t => {
  const dir = copyRepo(t)
  const f = path.join(dir, 'skills', 'panel', 'SKILL.md')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(' | no-seats>', '>'))
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL enum: panel agreement, skills\/panel\/SKILL\.md present shape/)
})

test('fails when panel.js stops passing its schema to seat A', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', 'schema: VERDICT, ', '')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL contract: Panel verdict == panel\.js VERDICT\n\s+panel\.js passed no schema/)
})

test('fails when triage.js stops passing its schema', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/triage.js', 'schema: TRIAGE, ', '')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL contract: Triage verdict == triage\.js TRIAGE/)
})

test('reports a probe that throws as a FAIL line and still runs the other checks', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', "const seatModel = A.seatModel || 'opus'", "if (!A.question) throw new Error('args.question is required')\nconst seatModel = A.seatModel || 'opus'")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL probe workflows\/panel\.js\n\s+args\.question is required/)
  assert.match(r.stdout, /\d+ passed, \d+ failed, \d+ warnings/)
})

test('fails when a workflow defaults to or allows fable, in any expression', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/panel.js', "A.seatModel || 'opus'", "A.seatModel || 'fable'")
  mutate(dir, 'workflows/research.js', "['opus', 'sonnet', 'haiku']", "['opus', 'sonnet', 'haiku', 'fable']")
  mutate(dir, 'workflows/triage.js', "model: 'haiku'", "model: ['claude-fable-5-1'][0]")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = r.stdout.split('FAIL models: no agent or workflow names fable or best')[1] || ''
  for (const f of ['panel', 'research', 'triage']) assert.match(block, new RegExp(`workflows/${f}\\.js`))
})

test('fails when an agent names fable in quoted frontmatter', t => {
  const dir = copyRepo(t)
  mutate(dir, 'agents/fast-worker.md', 'model: sonnet', "model: 'fable'")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL models: no agent or workflow names fable or best')[1] || '', /agents\/fast-worker\.md/)
})

test('fails when a probed agent() call dispatches fable through a variable', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/triage.js', "model: 'haiku'", "model: ['fa', 'ble'].join('')")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL models: no probed agent\(\) call dispatches fable or best/)
})

test('documented args: values are not keys, the last shorthand key counts, an unclosed quote is reported', t => {
  const dir = copyRepo(t)
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:panel-seats", args: {briefPath: "/b.md", seatModel: sonnet, options}})\n')
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:panel-seats", args: {briefPath, bogus}})\n')
  append(dir, 'README.md', '\nWorkflow({name: "tech-lead:triage", args: {item: "unterminated\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = r.stdout.split('FAIL args:')[1] || ''
  assert.match(block, /tech-lead:panel-seats args\.bogus is never read/)
  assert.match(block, /tech-lead:triage args block is not terminated/)
  assert.doesNotMatch(block, /args\.(sonnet|lead|tiered)\b/)
})

test('agentType and Workflow names are checked in either quote style', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/fanout.js', "agentType: 'tech-lead:fast-worker'", 'agentType: "tech-lead:missing-agent"')
  append(dir, 'README.md', "\nWorkflow({name: 'tech-lead:panel', args: {}})\n")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL names: every agentType in workflows is a plugin agent or an external agent\n\s+fanout\.js: tech-lead:missing-agent/)
  assert.match(r.stdout, /README\.md: tech-lead:panel\b/)
})

test('research SKILL.md fields are checked against the keys research.js returns', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/research.js', '    verified_ideas: r.verdict ? r.verdict.verified_ideas : [],', '    ideas: r.verdict ? r.verdict.verified_ideas : [],')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL fields: research SKILL\.md §3 names only fields research\.js returns[\s\S]*verified_ideas/)
})

test('fails when a doc names a plugin script that does not exist', t => {
  const dir = copyRepo(t)
  append(dir, 'skills/loop/SKILL.md', '\nRun `node <T>/scripts/loop-nope.mjs line <file>`.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL scripts: every scripts\/\*\.mjs path the docs name exists/)
  assert.match(r.stdout, /skills\/loop\/SKILL\.md: scripts\/loop-nope\.mjs/)
})

test('fails when README and the template disagree on the LOOP.md defaults', t => {
  const dir = copyRepo(t)
  mutate(dir, 'README.md', 'max_iterations_per_day: 8', 'max_iterations_per_day: 12')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL dup: README LOOP\.md defaults == loop-templates\.md LOOP\.md template/)
})

test('fails when a doc tells the model to pass CronCreate durable', t => {
  const dir = copyRepo(t)
  append(dir, 'README.md', '\nSchedule it with `CronCreate`, `durable: true`.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL runners: no doc tells the model to pass CronCreate a durable flag\n[\s\S]*README\.md/)
})

// Stage 0c-1 prose wiring (scripts/checks/loop.mjs): one mutation per check.
const LOOP_SKILL = 'skills/loop/SKILL.md'
// Stage 0c-2 replaced worktree.md with clone.md; the checks that read step 4 moved with it.
const LOOP_CLONE = 'skills/loop/references/clone.md'
const failBlock = (stdout, name) => stdout.split(`FAIL ${name}`)[1]?.split('\nFAIL ')[0] ?? null

test('fails when loop section 1 reads LOOP.md before it acquires the firing lock', t => {
  const name = 'loop: SKILL.md section 1 acquires the firing lock before it reads LOOP.md'
  const early = copyRepo(t)
  mutate(early, LOOP_SKILL, '2. **Missing spine.** If `<S>` is missing', '2. **Missing spine.** Read `LOOP.md` first. If `<S>` is missing')
  let r = runCheck(early)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /LOOP\.md is read before loop-lock\.mjs acquire/)
  const none = copyRepo(t)
  mutate(none, LOOP_SKILL, 'node <T>/scripts/loop-lock.mjs acquire <P>', 'node <T>/scripts/loop-lock.mjs status <P>')
  r = runCheck(none)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /names no loop-lock\.mjs acquire/)
})

test('fails when loop section 8 runs a command after the release or appends the ledger after it', t => {
  const name = 'loop: SKILL.md section 8 releases the firing lock as the last command, after the ledger append'
  const after = copyRepo(t)
  mutate(after, LOOP_SKILL, '- **Manual.** Report the summary', '- **Manual.** Run `node <T>/scripts/loop-codex.mjs quiesce --cwd <W>`, then report the summary')
  let r = runCheck(after)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /last command is not the release: node <T>\/scripts\/loop-codex\.mjs quiesce/)
  const late = copyRepo(t)
  mutate(late, LOOP_SKILL, '2. Append exactly one ledger entry, even for', '2. Write one entry, even for')
  mutate(late, LOOP_SKILL, '- **Manual.** Report the summary', '- **Manual.** Append exactly one ledger entry, then report the summary')
  r = runCheck(late)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /the ledger append comes after the release/)
})

test('fails when loop section 6 runs verify commands outside loop-lock.mjs exec', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'node <T>/scripts/loop-lock.mjs exec <P> --generation <N> --label verify --cwd <W> --timeout-ms 540000 --verify <K>', 'cd <W> && <verify command K>')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, 'loop: SKILL.md section 6 runs every verify command through loop-lock.mjs exec --verify') ?? '',
    /no loop-lock\.mjs exec .*--label verify .*--verify <K>/)
})

test('fails when clone.md installs dependencies outside loop-lock.mjs exec', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_CLONE, 'node <T>/scripts/loop-lock.mjs exec <P> --generation <N> --label deps --cwd <W> --timeout-ms 540000 -- npm ci', 'cd <W> && npm ci')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: clone.md installs dependencies through loop-lock.mjs exec') ?? ''
  assert.match(block, /no loop-lock\.mjs exec .*--label deps/)
  assert.match(block, /runs the install directly: cd <W> && npm ci/)
})

// A Bash call that reaches its own 600000 ms limit is moved to the background, not killed,
// so exec must end the run (and kill its group) first.
test('fails when the verify or the dependency exec has no --timeout-ms, or one at or past the Bash limit', t => {
  const verify = 'loop: SKILL.md section 6 runs every verify command through loop-lock.mjs exec --verify'
  const deps = 'loop: clone.md installs dependencies through loop-lock.mjs exec'
  for (const [file, name, from, to] of [
    [LOOP_SKILL, verify, ' --timeout-ms 540000 --verify <K>', ' --verify <K>'],
    [LOOP_SKILL, verify, ' --timeout-ms 540000 --verify <K>', ' --timeout-ms 600000 --verify <K>'],
    [LOOP_CLONE, deps, ' --timeout-ms 540000 -- npm ci', ' -- npm ci'],
    [LOOP_CLONE, deps, ' --timeout-ms 540000 -- npm ci', ' --timeout-ms 999999 -- npm ci'],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, file, from, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, to)
    assert.match(failBlock(r.stdout, name) ?? '', /--timeout-ms/, to)
  }
})

test('fails and names the line when a doc starts Codex without --project and --generation', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, ' --cap-min <codex_timeout_min> --project <P> --generation <N>', ' --cap-min <codex_timeout_min>')
  append(dir, 'README.md', '\nRun `node <plugin>/scripts/loop-codex.mjs start --cwd <W> --prompt-file <f> --cap-min 45 --generation <N>`.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: every loop-codex.mjs start in the docs carries --project and --generation') ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: loop-codex\.mjs start without --project, --generation/)
  assert.match(block, /README\.md:\d+: loop-codex\.mjs start without --project/)
  assert.doesNotMatch(block, /README\.md:\d+: loop-codex\.mjs start without --project, --generation/)
})

test('fails and names the file when git stash appears anywhere in skills/', t => {
  const dir = copyRepo(t)
  append(dir, LOOP_CLONE, '\nKeep the edits with `git -C <W> stash push` first.\n')
  append(dir, 'skills/quick/SKILL.md', '\nThen run git stash.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: no git stash anywhere in skills/') ?? ''
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+/)
  assert.match(block, /skills\/quick\/SKILL\.md:\d+/)
})

test('fails when loop SKILL.md drops the dispatch close around Agent and Workflow dispatches', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'node <T>/scripts/loop-lock.mjs dispatch close <P> --generation <N> --id <id>', 'nothing')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, 'loop: SKILL.md brackets Agent and Workflow dispatches with dispatch open and dispatch close') ?? '',
    /names no loop-lock\.mjs dispatch close/)
})

// F13: the prose keeps up with what the lock helpers print. One mutation (or more) per check.
const LOOP_TEMPLATES = 'skills/loop/references/loop-templates.md'

test('fails when loop section 1 stops the runner on transient contention, or leaves a held reason unhandled', t => {
  const name = 'loop: SKILL.md section 1 handles every held reason acquire prints, and keeps the runner only for transient contention'
  const moved = copyRepo(t)
  mutate(moved, LOOP_SKILL, '`holder-live`, `race` or `holder-unknown`', '`holder-live` or `holder-unknown`')
  mutate(moved, LOOP_SKILL, '`corrupt`, `dispatch-open`, `child-live`', '`race`, `corrupt`, `dispatch-open`, `child-live`')
  let r = runCheck(moved)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /held reason `race` must keep the runner; section 1 step 3 has it under stop/)
  const dropped = copyRepo(t)
  mutate(dropped, LOOP_SKILL, '`child-live`, `sweep-unknown`, or exit 2', '`child-live`, or exit 2')
  r = runCheck(dropped)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /held reason `sweep-unknown` must stop the runner; section 1 step 3 has it nowhere/)
  // A held reason the lock gains is not handled until the prose names it.
  const added = copyRepo(t)
  mutate(added, 'scripts/loop-lock.mjs', "  return held('race', max)\n}", "  return held('wedged', max)\n}")
  r = runCheck(added)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /held reason `wedged` must stop the runner; section 1 step 3 has it nowhere/)
})

test('fails when the Lost-lock rule counts every release exit 3 as lost, or drops the holder-unknown error', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, '`release` exit 3 with\n     `"state": "not-holder"`', '`release` exit 3')
  mutate(dir, LOOP_SKILL, 'even with a `holder-unknown`', 'even with an unknown holder')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: the Lost-lock rule counts a release exit 3 as lost only with "state": "not-holder", and a holder-unknown error as no loss') ?? ''
  assert.match(block, /does not name `release` exit 3 with `"state": "not-holder"`/)
  assert.match(block, /counts a `release` exit 3 as lost without/)
  assert.match(block, /never says that an exit 2 `holder-unknown` error is not a lost lock/)
})

test('fails and names the place when the ledger rule drops one of its two exceptions', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_TEMPLATES, 'and one that loses the lock', 'and one more')
  mutate(dir, 'README.md', '- **A lost lock.** A firing that loses the lock', '- **A lost lock.** A firing whose generation is taken over')
  mutate(dir, 'README.md', 'Ending at the lock and losing the lock', 'These two')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: the ledger rule names both of its exceptions, ending at the lock and losing it') ?? ''
  assert.match(block, /loop-templates\.md LEDGER\.jsonl rule \(before the schema\) does not name the firing that loses the lock/)
  assert.match(block, /README\.md The firing lock does not name the firing that loses the lock/)
  assert.doesNotMatch(block, /SKILL\.md/)
})

test('fails when loop section 8 says the release lists the children it stopped in lingering', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'children it stopped in `stopped`', 'children it stopped in `lingering`')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, 'loop: SKILL.md section 8 says what each list of a holder release holds') ?? '',
    /does not say the release lists the children it stopped in `stopped`/)
})

test('fails when an exec rule passes an exited run with a non-zero exit, or drops the lingering state', t => {
  const name = 'loop: the verify and install exec rules fail an exited run with a non-zero exit and never pass a lingering run'
  const dir = copyRepo(t)
  mutate(dir, LOOP_CLONE, '`state` `exited` with any other `exit`, ', '')
  mutate(dir, LOOP_SKILL, '- `lingering` (exit 123):', '- `stuck`:')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /clone\.md step 4 never says that `exited` with a non-zero `exit` is a failure/)
  assert.match(block, /SKILL\.md section 6 step 3 never handles the `lingering` state \(exit 123\)/)
  assert.doesNotMatch(block, /clone\.md step 4 never handles/)
})

// Cg4#7: the words stay, the meaning flips. A rule that calls a non-zero exit (or a lingering
// run) a pass must fail the check, not only one that drops the phrase.
test('fails when an exec rule says a non-zero exit or a lingering run passed, the words around it kept', t => {
  const name = 'loop: the verify and install exec rules fail an exited run with a non-zero exit and never pass a lingering run'
  for (const [file, from, to, want] of [
    [LOOP_SKILL, '`exited` with any other `exit` failed.', '`exited` with any other `exit` passed.',
      /SKILL\.md section 6 step 3 calls `exited` with a non-zero `exit` a pass, or no failure/],
    [LOOP_CLONE, '**Failure** (`state` `exited` with any other `exit`,', '**Success** (`state` `exited` with any other `exit`,',
      /clone\.md step 4 calls `exited` with a non-zero `exit` a pass, or no failure/],
    [LOOP_SKILL, 'It is never a pass, whatever the command exited', 'It is a pass, whatever the command exited',
      /SKILL\.md section 6 step 3 lets a `lingering` run pass/],
    [LOOP_CLONE, 'it is the failure above and an infra incident', 'it passes, and it is an infra incident',
      /clone\.md step 4 lets a `lingering` run pass/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, file, from, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, to)
    const block = failBlock(r.stdout, name) ?? ''
    assert.match(block, want, to)
    // Only the flipped rule is named.
    assert.equal(block.split('\n').filter(l => /^\s+(?:-|\+|')/.test(l) && /SKILL\.md|clone\.md/.test(l)).length, 1, `${to}: ${block}`)
  }
})

test('fails when a firing may leave ## Now holding anything but the placeholder loop-state.mjs reads as empty', t => {
  const name = 'loop: a firing leaves ## Now holding exactly the placeholder loop-state.mjs reads as empty'
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'Reset `## Now` to exactly `(empty)`', 'Clear `## Now`')
  let r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /section 8 never resets `## Now` to exactly `\(empty\)`/)
  // The placeholder is loop-state.mjs's (the planner reads STATE.md through it): another one
  // there fails the template too.
  const planner = copyRepo(t)
  mutate(planner, 'scripts/lib/loop-state.mjs', "export const PLACEHOLDER = '(empty)'", "export const PLACEHOLDER = '(none)'")
  r = runCheck(planner)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /STATE\.md template's ## Now holds "\(empty\)", not \(none\)/)
  assert.match(block, /never resets `## Now` to exactly `\(none\)`/)
})

test('fails when README troubleshooting drops a held reason or the not-toplevel refusal', t => {
  const dir = copyRepo(t)
  mutate(dir, 'README.md', '`not-toplevel`', 'not-toplevel')
  mutate(dir, 'README.md', '`sweep-unknown`', 'sweep-unknown')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: README troubleshooting names every held reason acquire prints, and the not-toplevel refusal') ?? ''
  assert.match(block, /never names `sweep-unknown`/)
  assert.match(block, /never names `not-toplevel`/)
  assert.doesNotMatch(block, /never names `race`/)
})

// Stage 0c-2 (brief section 21): the prose runs the clone helpers as they behave. One
// mutation test (or more) per check.
const SAVE_CMD = 'node <T>/scripts/reflex-bundle.mjs save <P> --generation <N> --why <why>'
const RESET_CMD = 'node <T>/scripts/reflex-bundle.mjs reset <P> --generation <N> --sha <sha>'
const CLOSE_CMD = 'node <T>/scripts/loop-clone.mjs close <P> --generation <N>'

test('fails and names the line when SKILL.md or clone.md runs git -C <W>, adds a worktree, or puts <W> at <S>/worktree', t => {
  const name = 'loop: SKILL.md and clone.md never run git -C <W>, add a worktree, or put <W> at <S>/worktree'
  const dir = copyRepo(t)
  append(dir, LOOP_SKILL, '\nCheck it with `git -C <W> status --porcelain=v1 -uall`.\n')
  append(dir, LOOP_CLONE, '\nIf it is missing, run `git -C <P> worktree add -b <branch> <W> <start-point>`.\n')
  append(dir, LOOP_SKILL, '\nHere `<W>` =\n`<S>/worktree`.\n')
  // Another reference may still name the old layout (0c-4 owns bootstrap.md).
  append(dir, 'skills/loop/references/bootstrap.md', '\nThe old `git -C <W> status` is gone.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: git -C <W>/)
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+: worktree add/)
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: `<W>` = `<S>\/worktree`/)
  assert.doesNotMatch(block, /clone\.md:\d+: git -C <W>/)
  assert.doesNotMatch(block, /bootstrap\.md/)
})

test('fails and names the line when a loop-clone.mjs or reflex-bundle.mjs command drops --generation <N>', t => {
  const name = 'loop: every loop-clone.mjs command in skills/ (but git) and every reflex-bundle.mjs save, reset and apply carries --generation <N>'
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, RESET_CMD, 'node <T>/scripts/reflex-bundle.mjs reset <P> --sha <sha>')
  mutate(dir, LOOP_CLONE, 'node <T>/scripts/loop-clone.mjs deps <P> --generation <N>\n', 'node <T>/scripts/loop-clone.mjs deps <P>\n')
  append(dir, 'skills/quick/SKILL.md', '\nThen `node <T>/scripts/reflex-bundle.mjs apply <P> --generation 7 --sha <sha>`.\n')
  // The read-only passthrough and verify take no generation; a bare name in a sentence is no command.
  append(dir, 'skills/loop/references/bootstrap.md', '\nRead with `node <T>/scripts/loop-clone.mjs git <P> -- status` or `node <T>/scripts/reflex-bundle.mjs verify <P> --sha <sha>`; loop-clone.mjs commit refuses.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: reflex-bundle\.mjs reset without --generation <N>/)
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+: loop-clone\.mjs deps without --generation <N>/)
  assert.match(block, /skills\/quick\/SKILL\.md:\d+: reflex-bundle\.mjs apply without --generation <N>/)
  assert.doesNotMatch(block, /bootstrap\.md/)
})

test('fails when loop section 8 closes the run records before the ledger append, after the release, or not at all', t => {
  const name = 'loop: SKILL.md section 8 closes the run records after the ledger append and before the release'
  const none = copyRepo(t)
  mutate(none, LOOP_SKILL, CLOSE_CMD, 'node <T>/scripts/loop-lock.mjs status <P>')
  let r = runCheck(none)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /section 8 names no `node <T>\/scripts\/loop-clone\.mjs close <P> --generation <N>`/)
  const early = copyRepo(t)
  mutate(early, LOOP_SKILL, CLOSE_CMD, 'node <T>/scripts/loop-lock.mjs status <P>')
  mutate(early, LOOP_SKILL, '1. Update `## Last run`:', `1. Run \`${CLOSE_CMD}\`, then update \`## Last run\`:`)
  r = runCheck(early)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /section 8 closes the run records before the ledger append/)
  const late = copyRepo(t)
  mutate(late, LOOP_SKILL, CLOSE_CMD, 'node <T>/scripts/loop-lock.mjs status <P>')
  mutate(late, LOOP_SKILL, '- **Manual.** Report the summary', `- **Manual.** Run \`${CLOSE_CMD}\`, then report the summary`)
  r = runCheck(late)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /section 8 closes the run records after the release/)
})

test('fails when loop section 1 step 5 runs the recovery planner without --generation <N>', t => {
  const name = 'loop: SKILL.md section 1 step 5 runs the recovery planner with --generation <N>'
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'node <T>/scripts/loop-recover.mjs <P> --generation <N>', 'node <T>/scripts/loop-recover.mjs <P> --worktree <W>')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /section 1 step 5 names no `node <T>\/scripts\/loop-recover\.mjs <P> --generation <N>`/)
})

test('fails and names the file when skills/ names loop-review.mjs', t => {
  const dir = copyRepo(t)
  append(dir, LOOP_CLONE, '\nThe owner fetches it with `node <T>/scripts/loop-review.mjs fetch <P>`.\n')
  append(dir, 'skills/quick/SKILL.md', '\nRetire it with loop-review.mjs retire.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: skills/ never names loop-review.mjs') ?? ''
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+/)
  assert.match(block, /skills\/quick\/SKILL\.md:\d+/)
  assert.doesNotMatch(block, /README/)
})

test('fails and names the line when skills/loop/ discards work in place outside a line that forbids it', t => {
  const name = 'loop: skills/loop/ never discards work in place (checkout --, restore --worktree, restore -W, git clean, reset --hard) except on a line that forbids it'
  const dir = copyRepo(t)
  append(dir, LOOP_CLONE, '\nTo start over, run `git -C <W> checkout -- .`, then `git -C <W> clean -fd`.\n')
  append(dir, LOOP_TEMPLATES, '\nOr `git restore -W .`, and `git restore --worktree .`, then `git reset --hard`.\n')
  append(dir, 'skills/loop/references/bootstrap.md', '\nNever run `git restore --worktree .` or `git clean` there.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+: checkout -- /)
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+: git clean/)
  for (const what of ['restore -W', 'restore --worktree', 'reset --hard']) {
    assert.match(block, new RegExp(`skills/loop/references/loop-templates\\.md:\\d+: ${what}`), what)
  }
  assert.doesNotMatch(block, /bootstrap\.md/)
})

// Cg4#8, prose-checks#3: a negation somewhere on the line ("did not", "no conflicts") does not
// make a discarding instruction a prohibition; only a sentence that opens by forbidding can be
// one (and only for a command its prohibition governs: the next test).
test('fails when a discarding instruction only shares its line with a negation; a sentence that opens by forbidding stays exempt', t => {
  const name = 'loop: skills/loop/ never discards work in place (checkout --, restore --worktree, restore -W, git clean, reset --hard) except on a line that forbids it'
  const dir = copyRepo(t)
  append(dir, LOOP_CLONE, '\nIf a reset did not finish, run `git clean -fdx` in the clone.\n')
  append(dir, LOOP_TEMPLATES, '\nWhen there are no conflicts, run `git reset --hard`.\n')
  append(dir, LOOP_TEMPLATES, '\nNever stash anything. Then run `git restore --worktree .` there.\n')
  append(dir, 'skills/loop/references/bootstrap.md', '\nDo not run `git clean` there. Never use `git reset --hard` either.\n- **No** `git checkout -- .` in the clone, ever.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/references\/clone\.md:\d+: git clean/)
  assert.match(block, /skills\/loop\/references\/loop-templates\.md:\d+: reset --hard/)
  assert.match(block, /skills\/loop\/references\/loop-templates\.md:\d+: restore --worktree/)
  assert.doesNotMatch(block, /bootstrap\.md/)
  assert.doesNotMatch(block, /SKILL\.md/, 'the safety rails forbid what they name')
})

// code#3, prose#4: a sentence that opens by forbidding exempts only a command its prohibition
// governs. An affirmative clause after a semicolon, a comma or a conjunction is an instruction
// of its own, whatever the sentence opened with.
test('fails when a sentence opens by forbidding something else and a later clause runs the discarding command', t => {
  const name = 'loop: skills/loop/ never discards work in place (checkout --, restore --worktree, restore -W, git clean, reset --hard) except on a line that forbids it'
  const dir = copyRepo(t)
  const flagged = [
    'No recovery is needed; run git clean -fd.',
    'Never wait for recovery; run git clean -fd.',
    'Do not retry verification; run `git clean -fd` in the clone instead.',
    'Do not retry verification, run `git clean -fd` instead.',
    'No recovery is needed and `git clean -fd` is fine.',
  ].map(line => [line, appendLine(dir, LOOP_CLONE, line)])
  // Prohibitions that govern their command stay exempt: one forbidding verb over a list, and a
  // later clause that forbids the command itself.
  append(dir, 'skills/loop/references/bootstrap.md', '\nNo recovery is needed; do not run `git clean -fd`.\nNever run `git checkout -- .`, `git restore --worktree .` or `git clean` there.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  for (const [line, n] of flagged) assert.match(block, new RegExp(`skills/loop/references/clone\\.md:${n}: git clean`), line)
  assert.doesNotMatch(block, /bootstrap\.md/)
  assert.doesNotMatch(block, /SKILL\.md/, 'the safety rails forbid what they name')
})

// prose#2, R31 (sharpened): delivery checks the lock right before the bundle's rename and again
// before its sidecar, so a not-holder from commit, bundle or close can leave the bundle
// published without its sidecar. The refusal table must say so, and that the next clone
// preparation regenerates it, never that nothing was published.
test('fails when clone.md\'s not-holder row promises that nothing was published, or drops the bundle left without its sidecar', t => {
  const name = 'loop: clone.md says a not-holder from commit, bundle or close can leave a published bundle without its sidecar, which the next clone preparation regenerates'
  // The row keeps its opening sentence; what follows it is replaced.
  const ROW = /^(\| any \| `not-holder` \| Lost lock \(loop \S+ step 3\)\. ).*$/m
  const setRow = (dir, rest) => {
    const f = path.join(dir, LOOP_CLONE), s = fs.readFileSync(f, 'utf8')
    if (!ROW.test(s)) throw new Error(`${LOOP_CLONE}: no not-holder row`)
    fs.writeFileSync(f, s.replace(ROW, (_, head) => `${head}${rest}`))
  }
  const promise = copyRepo(t)
  setRow(promise, '`commit`, `bundle` and `close` also answer it when the lock is lost while they write a delivery bundle, never as a `bundleError`: nothing is published |')
  let r = runCheck(promise)
  assert.equal(r.status, 1, r.stdout)
  let block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /clone\.md:\d+: the not-holder row promises that nothing was published/)
  assert.match(block, /never says that the bundle may be published without its sidecar/)
  const silent = copyRepo(t)
  setRow(silent, '`commit`, `bundle` and `close` also answer it when the lock is lost while they write a delivery bundle, never as a `bundleError` |')
  r = runCheck(silent)
  assert.equal(r.status, 1, r.stdout)
  block = failBlock(r.stdout, name) ?? ''
  assert.doesNotMatch(block, /promises/)
  assert.match(block, /never says that the bundle may be published without its sidecar/)
  assert.match(block, /never says that the next clone preparation regenerates it/)
  const noClose = copyRepo(t)
  setRow(noClose, '`commit` and `bundle` also answer it when the lock is lost while they write a delivery bundle, never as a `bundleError`; the bundle may then be published without its sidecar, and the next clone preparation regenerates it |')
  r = runCheck(noClose)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /never names `close` as answering it during delivery/)
})

test('fails when the Save and reset procedure resets before it saves, or writes no sha into STATE.md between them', t => {
  const name = 'loop: the Save and reset procedure saves, writes the sha into STATE.md, then resets'
  const swapped = copyRepo(t)
  mutate(swapped, LOOP_SKILL, SAVE_CMD, '@@SAVE@@')
  mutate(swapped, LOOP_SKILL, RESET_CMD, SAVE_CMD)
  mutate(swapped, LOOP_SKILL, '@@SAVE@@', RESET_CMD)
  let r = runCheck(swapped)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /resets before/)
  const noEdit = copyRepo(t)
  mutate(noEdit, LOOP_SKILL, 'One Edit of `STATE.md` writes', 'One note writes')
  r = runCheck(noEdit)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, name) ?? '', /no step between the save and the reset writes the sha into `STATE\.md` with one Edit/)
})

test('fails when the panel snapshot may refresh <P>/.git/index', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, 'git -c diff.autoRefreshIndex=false diff HEAD', 'git diff HEAD')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(failBlock(r.stdout, 'loop: the panel snapshot never refreshes <P>/.git/index (diff.autoRefreshIndex=false)') ?? '',
    /SKILL\.md:\d+: the panel snapshot runs git diff without -c diff\.autoRefreshIndex=false/)
})

test('fails when the Lost-lock rule drops the loop-clone.mjs or reflex-bundle.mjs not-holder answer', t => {
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, '`loop-clone.mjs` or `reflex-bundle.mjs`', '`loop-clone.mjs`')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  const block = failBlock(r.stdout, 'loop: the Lost-lock rule counts a loop-clone.mjs or reflex-bundle.mjs exit 3 "not-holder" as lost') ?? ''
  assert.match(block, /never names `reflex-bundle\.mjs` exit 3 with `"state": "not-holder"`/)
  assert.doesNotMatch(block, /never names `loop-clone\.mjs`/)
})
