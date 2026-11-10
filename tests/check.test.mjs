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
  // The Edit of STATE.md is still there, but it no longer stores the returned sha (Codex g4 #4).
  const noSha = copyRepo(t)
  mutate(noSha, LOOP_SKILL, 'One Edit of `STATE.md` writes the full `sha` at the', 'One Edit of `STATE.md` moves the item without storing the bundle hash, at the')
  r = runCheck(noSha)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /no step between the save and the reset writes the sha into `STATE\.md` with one Edit/)
  // The full sha is written, but somewhere else than STATE.md, or the Edit says it never writes
  // it: the Edit's own clause must store it (Codex f2 #5).
  for (const [label, to] of [
    ['destination', 'The helper writes the full `sha` into its run record. One Edit of `STATE.md` moves the item at the'],
    ['negation', 'One Edit of `STATE.md` never writes the full `sha` at the'],
    ['no Edit', 'No Edit of `STATE.md` writes the full `sha` at the'],
    ['destination after', 'One Edit of `STATE.md` writes the full `sha` into the run record, not `STATE.md`, at the'],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, 'One Edit of `STATE.md` writes the full `sha` at the', to)
    r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', /no step between the save and the reset writes the sha into `STATE\.md` with one Edit/, label)
  }
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

// Stage 0c-3 (brief section 7): the prose writes and reads items as loop-state.mjs and the item
// helper (scripts/loop-items.mjs) do. One mutation test (or more) per check.
const DOT = String.fromCodePoint(0xb7)
const ITEMS = 'node <T>/scripts/loop-items.mjs'
// Replace the n-th occurrence (0-based) of text in a copied file; throws if there is none.
const mutateNth = (dir, rel, from, to, n) => {
  const f = path.join(dir, rel), s = fs.readFileSync(f, 'utf8')
  let at = -1
  for (let i = 0; i <= n; i++) {
    at = s.indexOf(from, at + 1)
    if (at < 0) throw new Error(`${rel}: occurrence ${n} of the mutation anchor not found: ${from}`)
  }
  fs.writeFileSync(f, s.slice(0, at) + to + s.slice(at + from.length))
}

test('fails when the STATE.md template in loop-templates.md does not parse cleanly with parseState', t => {
  const name = 'loop: the STATE.md template in loop-templates.md parses with parseState with no problems'
  const field = copyRepo(t)
  mutate(field, LOOP_TEMPLATES, '  - notes: <one line of context>', '  * notes: <one line of context>')
  let r = runCheck(field)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /Backlog item "<task title>": malformed-field/)
  const section = copyRepo(t)
  mutate(section, LOOP_TEMPLATES, '## Done\n(empty)\n\n## Last run\n(never run)', '## Last run\n(never run)')
  r = runCheck(section)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /missing-section/)
})

test('fails when loop-templates.md leaves an item field label undocumented, including one loop-state.mjs gains', t => {
  const name = 'loop: loop-templates.md documents every item field label loop-state.mjs reads (FIELD_LABELS)'
  const dir = copyRepo(t)
  mutate(dir, LOOP_TEMPLATES, '- `no-change-ok:`', '- `no-change:`')
  mutate(dir, 'scripts/lib/loop-state.mjs', "'decided', 'no-change-ok'])", "'decided', 'no-change-ok', 'verified'])")
  const r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /never documents `no-change-ok:`/)
  assert.match(block, /never documents `verified:`/)
  assert.doesNotMatch(block, /`decided:`/)
})

test('fails when a ## Needs decision entry template is headed by the title instead of the id', t => {
  const name = `loop: the ## Needs decision entry templates are headed \`### <id> ${DOT} <title>\``
  const dir = copyRepo(t)
  mutateNth(dir, LOOP_TEMPLATES, `### <id> ${DOT} <title>`, '### <task title>', 1)
  let r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /loop-templates\.md:\d+: `### <task title>`/)
  const none = copyRepo(t)
  mutate(none, LOOP_TEMPLATES, `### <id> ${DOT} <title>`, '### <task title>')
  r = runCheck(none)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /needs both entry templates/)
})

test('fails and names the file when a doc says a blocker is finished by its title; a negated sentence passes', t => {
  const name = 'loop: no doc says a blocker is finished by its title'
  const dir = copyRepo(t)
  append(dir, LOOP_SKILL, '\nA blocker is finished when the ledger has a `done` entry with exactly that task title.\n')
  append(dir, 'README.md', '\nThe blocker counts as done once a ledger row has the same title.\n')
  append(dir, 'references/decision-contracts.md', '\nA done item with the same title never finishes a blocker.\n')
  const r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+/)
  assert.match(block, /README\.md:\d+/)
  assert.doesNotMatch(block, /decision-contracts\.md/)
})

test('fails when SKILL.md section 3.2 keys the blocker on a title again, though its sentence holds a negation elsewhere (PDC-1)', t => {
  // The live blocker sentence already says "no open item ...": a negation in another clause
  // must not hide a clause that finishes the blocker by its title.
  const name = 'loop: no doc says a blocker is finished by its title'
  const ID_RULE = 'no open item has its id; its\nid is in `## Done`, or a ledger entry records it done (`outcome` `done` with\nthat `item_id`'
  for (const [label, to] of [
    ['open title and Done title', 'no open item has its title; its\ntitle is in `## Done`, or a ledger entry records it done (`outcome` `done` with\nthat `item_id`'],
    ['Done title and ledger task', 'no open item has its id; its\ntitle is in `## Done`, or a ledger entry records it done (`outcome` `done` with\nthat `task`'],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, ID_RULE, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', /skills\/loop\/SKILL\.md:\d+: A blocker is finished when/, label)
  }
})

test('judges the clause that finishes the blocker: a negation elsewhere in it never hides a title key, and a negated finishing passes (Codex fix1-g2#4)', t => {
  const name = 'loop: no doc says a blocker is finished by its title'
  const affirmative = 'The blocker counts as done once a ledger row has the same title and no follow-up is open.'
  const negated = 'A blocker is not finished by its id alone; its title is only for display.'
  const dir = copyRepo(t)
  append(dir, 'README.md', `\n${affirmative}\n`)
  append(dir, 'references/decision-contracts.md', `\n${negated}\n`)
  let r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /README\.md:\d+: The blocker counts as done once/)
  assert.doesNotMatch(block, /decision-contracts\.md/)
  // The negated sentence alone keeps the check green.
  const alone = copyRepo(t)
  append(alone, 'references/decision-contracts.md', `\n${negated}\n`)
  r = runCheck(alone)
  assert.equal(failBlock(r.stdout, name), null, r.stdout)
})

test('fails and names the line when a reflex-bundle.mjs save drops --item <id>', t => {
  const name = 'loop: every reflex-bundle.mjs save in skills/ passes --item <id> (SKILL.md section 7 runs one)'
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, `${SAVE_CMD} --item <id>`, SAVE_CMD)
  append(dir, 'skills/quick/SKILL.md', `\nThen \`${SAVE_CMD}\`.\n`)
  const r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: reflex-bundle\.mjs save without --item <id>/)
  assert.match(block, /skills\/quick\/SKILL\.md:\d+: reflex-bundle\.mjs save without --item <id>/)
  assert.match(block, /section 7 runs no reflex-bundle\.mjs save with --item <id>/)
})

test('fails when loop section 3 picks before it normalizes, or applies and checks no edits around normalize and pick', t => {
  const name = 'loop: SKILL.md section 3 normalizes, applies the edits and checks them before pick, then checks pick\'s edits'
  const CHECK_EXPECT = `${ITEMS} check <P> --expect <expect_sha256>`
  for (const [label, apply, want] of [
    ['no normalize', d => mutate(d, LOOP_SKILL, `${ITEMS} normalize <P>`, `${ITEMS} digest <P> --item <id>`), /names no `node <T>\/scripts\/loop-items\.mjs normalize <P>`/],
    ['no check before pick', d => mutateNth(d, LOOP_SKILL, CHECK_EXPECT, `${ITEMS} check <P>`, 0), /runs no `node <T>\/scripts\/loop-items\.mjs check <P> --expect <expect_sha256>` between normalize and pick/],
    ['no check after pick', d => mutateNth(d, LOOP_SKILL, CHECK_EXPECT, `${ITEMS} check <P>`, 1), /runs no `node <T>\/scripts\/loop-items\.mjs check <P> --expect <expect_sha256>` after pick/],
    ['no apply after pick', d => mutate(d, LOOP_SKILL, 'Apply pick\'s `edits`', 'Read pick\'s output'), /never says to apply pick's `edits` with Edit before its check/],
    ['no apply after normalize', d => mutate(d, LOOP_SKILL, 'Apply its `edits`', 'Read its output'), /never says to apply normalize's `edits` with Edit before its check/],
  ]) {
    const dir = copyRepo(t)
    apply(dir)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when the follow-up reaches loop-items.mjs followup by a title argument instead of --input <file>', t => {
  const name = 'loop: the follow-up reaches loop-items.mjs followup only through --input <file>, never a title argument'
  const dir = copyRepo(t)
  mutate(dir, LOOP_SKILL, `${ITEMS} followup <P> --parent <id> --input <S>/briefs/<id>-followup.json`, `${ITEMS} followup <P> --parent <id> --title "<follow-up title>"`)
  append(dir, 'README.md', `\nOr run \`${ITEMS.replace('<T>', '<plugin>')} followup <project> --parent <id> --title <title>\`.\n`)
  let r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  let block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /skills\/loop\/SKILL\.md:\d+: loop-items\.mjs followup without --input/)
  assert.match(block, /README\.md:\d+: loop-items\.mjs followup without --input/)
  assert.match(block, /section 5 runs no `node <T>\/scripts\/loop-items\.mjs followup <P> --parent <id> --input /)
  // The JSON file must be written with the Write tool before the call.
  const noWrite = copyRepo(t)
  mutate(noWrite, LOOP_SKILL, '-followup.json` with the Write tool', '-followup.json`')
  r = runCheck(noWrite)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /never says to write the follow-up file with the Write tool/)
})

test('fails when bootstrap.md blanks a dependency the sources name instead of keeping it as a title blocker (Codex g3#2, R32)', t => {
  const name = 'loop: bootstrap.md keeps a known dependency as `blocked-by: <title>`, which parks the dependent behind its prerequisite'
  const BOOTSTRAP = 'skills/loop/references/bootstrap.md'
  const dir = copyRepo(t)
  const s = fs.readFileSync(path.join(dir, BOOTSTRAP), 'utf8')
  const at = s.indexOf('Never drop a dependency')
  const end = s.indexOf('5. **Update')
  assert.ok(at > 0 && end > at, 'bootstrap.md step 4 has the dependency rule')
  fs.writeFileSync(path.join(dir, BOOTSTRAP), `${s.slice(0, at)}Leave \`blocked-by:\` at\n   \`—\`: a blocker is an id, which the items get only then.\n${s.slice(end)}`)
  const r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /bootstrap\.md step 4 never writes a dependency as `blocked-by: <[^>]*title>`/)
})

test('fails when loop section 1 step 5 clears the whole ## Now section, skips clear.edits or its check, or never pauses on now-conflict (R29)', t => {
  const name = 'loop: SKILL.md section 1 step 5 applies the planner\'s clear.edits and checks them, and treats now-conflict as the item-edit incident'
  for (const [label, apply, want] of [
    ['whole section', d => mutate(d, LOOP_SKILL, 'Apply\n     `clear.edits` in order, one Edit each', 'In one Edit,\n     replace the `## Now` block with `(empty)`'), /never applies `clear\.edits`/],
    ['no check', d => mutate(d, LOOP_SKILL, `${ITEMS} check <P> --expect <clear.expect_sha256>`, `${ITEMS} check <P>`), /never runs `node <T>\/scripts\/loop-items\.mjs check <P> --expect <clear\.expect_sha256>`/],
    ['no incident', d => mutate(d, LOOP_SKILL, 'It is an\n     item-edit incident (Item edits), named by', 'Note it, named by'), /`now-conflict` bullet never calls it an item-edit incident/],
  ]) {
    const dir = copyRepo(t)
    apply(dir)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when the ## Done trim does not run loop-items.mjs trim, apply its edits, or check them with --expect (R27, R14)', t => {
  const name = 'loop: SKILL.md\'s ## Done trim runs loop-items.mjs trim, applies its edits with Edit and checks them with check --expect'
  for (const [label, apply, want] of [
    ['no helper', d => mutate(d, LOOP_SKILL, '`node <T>/scripts/loop-items.mjs trim <P>`', 'the trim by hand'), /Trimming `## Done` never runs `node <T>\/scripts\/loop-items\.mjs trim <P>`/],
    ['no apply', d => mutate(d, LOOP_SKILL, 'apply its `edits` in the\n  printed order, one Edit each', 'read its `edits`'), /Trimming `## Done` never says to apply trim's `edits` with Edit before its check/],
    ['no --expect', d => mutate(d, LOOP_SKILL, '`node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>`,\n  also when `edits` is empty', '`node <T>/scripts/loop-items.mjs check <P>`,\n  also when `edits` is empty'), /Trimming `## Done` never runs `node <T>\/scripts\/loop-items\.mjs check <P> --expect <expect_sha256>` after the trim/],
  ]) {
    const dir = copyRepo(t)
    apply(dir)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when the ledger entry drops pick\'s unledgered (done_items) or the ## Done trim rule stops keeping an unledgered item (R27)', t => {
  const name = 'loop: section 8\'s ledger entry records pick\'s unledgered as done_items, and the ## Done trim keeps unledgered items'
  for (const [label, apply, want] of [
    ['no done_items', d => mutate(d, LOOP_SKILL, 'Its `done_items` is the `unledgered` list `pick` printed', 'Its notes name the `unledgered` list `pick` printed'), /section 8 never writes `done_items` from pick's `unledgered`/],
    ['old trim', d => mutate(d, LOOP_SKILL, 'Either way, trim `## Done` (Item edits, Trimming `## Done`)', 'Either way, trim `## Done` to the 20 most recent entries'), /section 6 trims `## Done` without the Trimming `## Done` rule/],
    ['trim drops unledgered', d => mutate(d, LOOP_SKILL, 'and, below them, every item the ledger does not record done yet (one\n  `unledgered` names', 'and drops every older item (even one\n  `unledgered` names'), /Trimming `## Done` never keeps the items `unledgered` names/],
    ['schema', d => mutate(d, LOOP_TEMPLATES, ' "done_items": [{"item_id": "<id>", "item_origin": "<origin or null>"}],\n', ''), /schema has no `done_items`/],
  ]) {
    const dir = copyRepo(t)
    apply(dir)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when SKILL.md section 5 counts only one follow-up answer as a success, as the original prose did (Codex fix1-g2#5)', t => {
  const name = 'loop: SKILL.md section 5 counts both follow-up answers (reused true and false) as a success, and only a refusal or an error as the incident'
  const LIVE = 'Both of its `"state": "ok"` answers are a success, and `id` names the\n    follow-up: `"reused": false` is a new follow-up, with its insertion in\n    `edits`; `"reused": true` means an interrupted firing already created\n    it, and `edits` is empty (run the check all the same). Only a refusal\n    (exit 3) or an error (exit 2) is an item-edit incident (Item edits).'
  for (const [label, to, want] of [
    // The prose before the fix pass: a new follow-up (reused false) fell under "any other answer".
    ['original', '`"reused": true` means an interrupted firing already created this\n    follow-up: there are no edits, and `id` names it. Any other answer is\n    an item-edit incident (Item edits).', /never names `"reused": false`/],
    ['only one success', LIVE.replace('Both of its `"state": "ok"` answers are a success', 'Only `"reused": true` is a success'), /no sentence counts both answers as a success/],
    ['incident widened', LIVE.replace('Only a refusal\n    (exit 3) or an error (exit 2) is', 'A refusal (exit 3), an error\n    (exit 2) or `"reused": false` is'), /an incident sentence names an ok answer/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, LIVE, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when bootstrap.md writes a prerequisite whose title is a none spelling as the blocker unchanged (Codex fix1-g2#3, R32a)', t => {
  const name = 'loop: bootstrap.md renames a prerequisite whose title is a none spelling before it writes the blocker (R32a)'
  const BOOTSTRAP = 'skills/loop/references/bootstrap.md'
  const dir = copyRepo(t)
  const s = fs.readFileSync(path.join(dir, BOOTSTRAP), 'utf8')
  const at = s.indexOf('A prerequisite whose title')
  const end = s.indexOf('A blocker is an id,')
  assert.ok(at > 0 && end > at, 'bootstrap.md step 4 has the none-spelling rule')
  fs.writeFileSync(path.join(dir, BOOTSTRAP), s.slice(0, at) + s.slice(end))
  let r = runCheck(dir)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /step 4 never names the none spelling `--`/)
  assert.match(failBlock(r.stdout, name) ?? '', /step 4 never renames the prerequisite by appending a suffix/)
  // A list that misses one spelling the parser reads as none.
  const short = copyRepo(t)
  mutate(short, BOOTSTRAP, ', `n/a`', '')
  r = runCheck(short)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /step 4 never names the none spelling `n\/a`/)
  assert.doesNotMatch(block, /`none`/)
})

test('fails when SKILL.md section 1 step 5 drops a now-conflict reason loop-recover.mjs prints, or a field clear-now compares (R29a)', t => {
  const name = 'loop: SKILL.md section 1 step 5 names every now-conflict reason loop-recover.mjs prints and every field clear-now compares (R29a)'
  for (const [label, from, to, want] of [
    ['reason dropped', '     `origin-differs`; its', '     an origin line; its', /never names the reason `origin-differs`/],
    ['field dropped', '(same id, title, notes and decision, the same `blocked-by:`,\n     `decided:`', '(same id, title, notes and decision, the same\n     `decided:`', /the `clear-now` bullet never names `blocked-by:`/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, from, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when README\'s skip table or SKILL.md section 3.1 drops a release refusal pick can report (R30a ambiguous-carrier)', t => {
  const name = 'loop: README\'s skip table and SKILL.md section 3.1 name every release refusal pick can report'
  const readme = copyRepo(t)
  const f = path.join(readme, 'README.md'), s = fs.readFileSync(f, 'utf8')
  const row = s.split('\n').find(l => l.startsWith('| `ambiguous-carrier` |'))
  assert.ok(row, 'README has the ambiguous-carrier row')
  fs.writeFileSync(f, s.replace(`${row}\n`, ''))
  let r = runCheck(readme)
  assert.equal(r.status, 1, r.stdout)
  assert.match(failBlock(r.stdout, name) ?? '', /README\.md: Why the loop skips an item has no row for `ambiguous-carrier`/)
  const skill = copyRepo(t)
  mutate(skill, LOOP_SKILL, '(`ambiguous-carrier`; the decision is', '(the decision is')
  r = runCheck(skill)
  assert.equal(r.status, 1, r.stdout)
  const block = failBlock(r.stdout, name) ?? ''
  assert.match(block, /section 3\.1 never names `ambiguous-carrier`/)
  assert.doesNotMatch(block, /README/)
})

test('fails when an item move writes its deletion from a later read of the source, or a failed deletion is no incident (Codex closing g3#1, F6)', t => {
  const name = 'loop: SKILL.md\'s item move takes its deletion from the source block as read, before the insertion, and a failed deletion is the item-edit incident (F6)'
  const TAKE = '  2. Take the deletion before the insertion. Copy the source block exactly\n     as you read it, from its header line through its last line, with the\n     lines after it up to and including the next non-blank line (the\n     anchor, such as the next section\'s heading). That text is the\n     deletion\'s `old`; its `new` is the anchor alone, with `(empty)` on the\n     line before it when the section holds nothing else. Never write the\n     deletion from a later read of the source.\n  3. One Edit inserts'
  for (const [label, from, to, want] of [
    // The prose before the fix: the deletion was written when it was made, from the file as it
    // read then, so an amendment between the two edits was deleted unseen.
    ['original', TAKE, '  2. One Edit inserts', /never takes the deletion from the source block exactly as read/],
    ['after the insertion', 'Take the deletion before the insertion.', 'Take the deletion after the insertion.', /never takes the deletion before the insertion/],
    ['no anchor', ' with the\n     lines after it up to and including the next non-blank line (the\n     anchor, such as the next section\'s heading)', '', /never anchors the deletion through the next non-blank line/],
    ['re-read', 'with the `old` and\n     `new` of step 2', 'as the source reads then', /the deletion never uses the `old` and `new` of step 2/],
    ['no incident', 'it is an item-edit incident (Incident): both copies\n     stay', 'read the source again and delete that: both copies\n     stay', /never calls a failed deletion an item-edit incident/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, from, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when section 8 copies item_origin from STATE.md instead of pick\'s answer, or section 3 drops pick\'s origin (Codex closing g1#1, Opus I2, F1)', t => {
  const name = 'loop: section 8\'s ledger entry copies task, item_id and item_origin from pick\'s answer (F1)'
  for (const [label, from, to, want] of [
    // The prose before the fix: the model copied the origin from STATE.md by hand.
    ['original', '`title`, `id` and `origin` that `pick` printed for the picked item (§3\n   step 2), copied from that answer and never from `STATE.md` by hand, or\n   null', 'picked item\'s title, id and `origin:` value, or null', /section 8 never copies `item_origin` from the `origin` `pick` printed/],
    ['not kept', '     Keep its `origin` too (the item\'s `origin:` value as written, or null\n     without one): §8\'s ledger entry copies it from this answer.\n', '', /section 3 never keeps the `origin` `pick` printed for the ledger entry/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, LOOP_SKILL, from, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when README\'s invalid-id fix deletes a valid id, as the original row did (Codex closing g3#2, F7)', t => {
  const name = 'loop: README\'s invalid-id fix never deletes a valid id (F7)'
  const LIVE = 'Never delete a valid id: other items\' `blocked-by:` and `origin: loop from` lines and `## Needs decision` headings name it, and a fresh id would cut those links. When the two `id:` lines carry the same id, delete only one of them. When they carry two ids, or the value is a damaged id, keep or restore the id that other lines name (in `STATE.md` or `LEDGER.jsonl`). Delete the `id:` line, so the next firing gives the item a fresh id, only when no other line names its id'
  for (const [label, to, want] of [
    ['original', 'Delete the `id:` lines; the next firing gives the item a fresh id. Point any `blocked-by:` that named the old value at the new id', /tells the owner to delete both `id:` lines/],
    ['both deleted', LIVE.replace('delete only one of them', 'delete both of them'), /never deletes only one of two identical `id:` lines/],
    ['remint widened', LIVE.replace(', only when no other line names its id', ''), /never limits a fresh id to an id no other line names/],
  ]) {
    const dir = copyRepo(t)
    mutate(dir, 'README.md', LIVE, to)
    const r = runCheck(dir)
    assert.equal(r.status, 1, `${label}: ${r.stdout}`)
    assert.match(failBlock(r.stdout, name) ?? '', want, label)
  }
})

test('fails when a workflow agent() call pins no model and names no agent', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/research.js', "const verifyOpt = { model: 'opus', effort: 'high' }", "const verifyOpt = { effort: 'high' }")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL models: every probed agent() call pins a model')[1] || '', /verify:primary/)
})

test('fails when a bench agent pins no model, so it would inherit the session model', t => {
  const dir = copyRepo(t)
  mutate(dir, 'agents/triage.md', 'model: haiku\n', '')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL bench: every agent pins a model and none can spawn agents')[1] || '', /agents\/triage\.md: no model/)
})

test('fails when a bench agent is given the Agent tool', t => {
  const dir = copyRepo(t)
  mutate(dir, 'agents/fast-worker.md', '"Edit", "Bash"]', '"Edit", "Bash", "Agent"]')
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL bench: every agent pins a model and none can spawn agents')[1] || '', /agents\/fast-worker\.md: tool Agent/)
})

const BENCH = 'FAIL bench: every agent pins a model and none can spawn agents'
const benchFails = (t, rel, from, to, want) => {
  const dir = copyRepo(t)
  mutate(dir, rel, from, to)
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split(BENCH)[1] || '', want)
}

test('fails when a bench agent has no tools line, so it would get every tool', t => {
  benchFails(t, 'agents/fast-worker.md', 'tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"]\n', '', /agents\/fast-worker\.md: no tools list/)
})

test('fails when a bench agent sets model: inherit', t => {
  benchFails(t, 'agents/triage.md', 'model: haiku', 'model: inherit', /agents\/triage\.md: no model/)
})

test('fails when a bench agent is given a restricted Agent tool such as Agent(Explore)', t => {
  benchFails(t, 'agents/fast-worker.md', '"Edit", "Bash"]', '"Edit", "Bash", "Agent(Explore)"]', /agents\/fast-worker\.md: tool Agent\(Explore\)/)
})

test('fails when a workflow agent() call passes model: inherit', t => {
  const dir = copyRepo(t)
  mutate(dir, 'workflows/research.js', "const verifyOpt = { model: 'opus', effort: 'high' }", "const verifyOpt = { model: 'inherit', effort: 'high' }")
  const r = runCheck(dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout.split('FAIL models: every probed agent() call pins a model')[1] || '', /verify:primary/)
})
