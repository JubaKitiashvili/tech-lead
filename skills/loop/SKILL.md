---
name: loop
description: This skill should be used when the user asks to "run the loop", "start the tech-lead loop", "run a loop iteration", "work through the backlog automatically", invokes "/tech-lead:loop", or when a /loop or cron firing carries the prompt "Run /tech-lead:loop <project-path>". Executes exactly ONE iteration of the backlog-executor loop against the project's .tech-lead/ state spine, and handles first-run bootstrap when the spine is missing.
argument-hint: [project-path]
---

# tech-lead Loop — one iteration of the backlog executor

Execute exactly one iteration against the project at the argument path
(default: current working directory). All memory lives on disk in
`.tech-lead/` — treat the conversation as empty even when it is not, so the
same firing works from `/loop`, cron, or a manual call. Delegation rules are
the parent tech-lead skill's; this skill adds loop policy around them.
File formats: `references/loop-templates.md`. Briefing rules:
`../../references/briefing-template.md`.

## 0 · Bootstrap (only when `.tech-lead/` is missing)

- Unsure whether a user is attending: ask one confirmation question and
  scaffold only on an affirmative reply — in a cron session the question
  goes unanswered and the firing simply ends, which is the correct headless
  outcome.
- Headless (cron, no user attending): print an error naming the missing
  spine and exit. Never scaffold unattended.
- Interactive: create `LOOP.md` and `STATE.md` from the templates. Detect
  `verify:` candidates from package.json scripts / Makefile and confirm them
  with the user. Build the initial `## Backlog` with the user from the
  project's existing task sources. Create an empty `LEDGER.jsonl`. Add
  `.tech-lead/worktree/` to the project `.gitignore`. Commit the spine to
  the project repo (message: `chore: tech-lead loop state spine`). Bootstrap
  ends the firing — the first real iteration is the next one.

## 1 · Rehydrate

Read `LOOP.md` (config), all sections of `STATE.md`, and the last 10 entries
of `LEDGER.jsonl`.

## 2 · Gate checks (in order — first hit wins, each appends a ledger entry)

1. `paused: true` → outcome `halted`, note "paused"; stop the runner (§8).
2. The last `max_consecutive_failures` ledger outcomes are all `failed` →
   write an incident to `## Last run` (which task(s) and their failure
   notes), outcome `halted`, and set `paused: true` in `LOOP.md` so
   subsequent cron firings stay halted until the human unpauses; stop the
   runner.
3. Ledger entries whose `ts` date (UTC) is today ≥ `max_iterations_per_day`
   → outcome `skipped`, note "daily budget"; stop the runner (cron refires
   tomorrow; in `/loop` mode stop and tell the user why).

## 3 · Pick

1. Any `## Needs decision` entry whose `Decision:` line is filled → copy the
   decision onto the matching `## Backlog` item (recreate it at the top of
   `## Backlog` if missing), clear its `status:`, **reclassify it to `hard`
   (or `mechanical` only if the decided follow-up is fully specified with
   zero remaining design decisions) — never leave it `high-stakes`, or §5
   re-panels the same item forever and the decision is never consumed**, and
   delete the entry from `## Needs decision`; it becomes the pick.
2. Else: the first `## Backlog` item whose `blocked-by:` is `—` (or names an
   item already in `## Done`) and whose `status:` is `—` — or
   `waiting-level` when the current `level` now permits its class (clear
   the `status:` on pick).
3. Backlog dry → write "backlog dry" to `## Last run`, outcome `skipped`;
   stop the runner.

Move the pick to `## Now`.

## 4 · Classify

If `class: unclassified`: `mechanical` = fully specified, zero design
decisions; `high-stakes` = expensive to reverse (architecture, data model,
public API shape, security, major-version dependency); `hard` = everything
else that fits in one self-contained brief. Write the class back to the item.

## 5 · Execute (level × class)

- **Level 1 (`mechanical`/`hard`):** write the complete would-do plan
  (chosen delegate, brief outline, verify plan) into `## Last run`; outcome
  `report-only`. Dispatch nothing and modify no project files at L1.
  Promotion: clean = the previous ledger entry is `report-only` and this
  firing's outcome will be `report-only` — two consecutive counting this
  run; then set `level: 2` in `LOOP.md` and record the promotion in
  `## Last run` and the ledger note. Never change `level` in any other
  case — promotion to 3 is the human's edit alone.
- **L2+, `mechanical`:** ensure the loop worktree exists, on a branch for
  today. Start-point: start today's branch from the branch currently
  checked out in the main working tree when no unmerged loop commits
  exist; otherwise chain from the newest dated loop branch and note the
  divergence in `## Last run`. If the worktree is missing, create it with
  `git worktree add -b <branch_prefix>/<YYYY-MM-DD> .tech-lead/worktree
  <start-point>`; if it exists on an older dated branch, create today's
  branch there from the same start-point instead. After creating the
  worktree or a new dated branch, install dependencies there (e.g. `npm
  ci`) before dispatching; a dependency-install failure is an incident —
  write it to `## Last run`, outcome `skipped`, note "worktree deps" (not
  a task failure). If the same worktree-deps incident repeats across
  firings, flag it prominently in `## Last run` as chronic — it silently
  consumes the daily budget until a human fixes the worktree. Dispatch
  `tech-lead:fast-worker` with a self-contained brief that states the
  worktree's absolute path as the working directory and tells the delegate
  to ignore the worktree's own stale committed `.tech-lead/` copy. Its
  verify commands run inside the worktree.
- **L2, `hard` or parked-by-level work:** write the plan into `## Last run`,
  mark the item `status: waiting-level`, outcome `report-only`, note
  "waiting-level".
- **L3, `hard`:** dispatch `tech-lead:deep-reasoner` for analysis-shaped
  work or `codex:codex-rescue` for implementation-shaped work (in the
  worktree, as above).
- **Any level, `high-stakes`:** run the panel per the parent skill —
  `tech-lead:deep-reasoner` + `codex:codex-rescue`, same brief, same
  message, no cross-contamination; single seat if Codex is unavailable
  (say so). This runs at every level including L1 — the panel writes only
  to the spine, never to project files. Write the synthesized
  recommendation to `## Needs decision` using the template format, mark
  the item `status: waiting-decision`, outcome `needs-decision`. This
  concludes the iteration — the loop never executes a high-stakes decision
  itself.

Any branch that ends the iteration without reaching §6 or §7 (e.g.
`report-only`, `waiting-level`, `needs-decision`, `skipped`) → return the
item from `## Now` to the top of `## Backlog` with its `status:` set (at
L1 return it with `status: —`, keeping its recorded class); `## Now` must
be empty when the firing ends.

## 6 · Verify & commit (after dispatch)

Verify BEFORE staging anything — a failing task must never leave a staged
index for the next firing. First, take the delegate's reported touched
paths and confirm every one falls under `LOOP.md`'s `scope:` (`.tech-lead/`
spine writes are exempt and are never committed by the loop). If any
touched path is outside `scope:`, stage nothing — treat the attempt as a
failure (§7's path), naming the out-of-scope path in the failure note.
Otherwise run every `verify:` command inside the worktree with nothing
staged. Any verify failure → §7. All pass and files changed → stage only
the in-scope touched paths (`git -C .tech-lead/worktree add -- <paths>`),
then commit on the loop branch (no Co-Authored-By line), move the item
from `## Now` to `## Done` with the SHA, outcome `done`, `verify:
"pass"`. All pass and nothing changed → outcome `done`, `commits: []`,
note "no changes needed", and still move the item to `## Done`, using
`—` in the sha slot. Either way, trim `## Done` to the 20 most recent
entries.

## 7 · Failure path

First failure: one retry — revise the brief using the failure output, same
delegate. Second failure: reset the worktree to a clean baseline before the
next firing — unstage everything (`git -C .tech-lead/worktree restore
--staged .`), revert tracked changes (`git -C .tech-lead/worktree checkout
-- .`), and delete untracked files the delegate created (individual `rm`,
never `rm -rf`); the worktree's index and tracked tree must match the loop
branch HEAD afterward, so no failed-task change survives into the next
task's commit. Move the item to `## Blocked` with a one-line reason
summarizing both attempts, outcome `failed`, `verify: "fail"`. The firing
ends; the next firing takes the next item.

## 8 · Report & runner handling

Always: update `## Last run` (timestamp, level, what happened, next planned
action) and append exactly one ledger entry — including failed and halted
firings. No silent runs. All delegate dispatches are synchronous within a
firing — v1 never dispatches background jobs.

- `/loop` dynamic mode: work remains and budget allows → ScheduleWakeup
  60–120s; dry / halted / paused / budget → `stop: true` with the reason.
  Also narrate a one-paragraph summary to the user.
- Cron: exit; cron refires on schedule. Never ask questions — anything
  needing input goes to `STATE.md` and the iteration ends (§0's bootstrap
  confirmation question is the sole exception).
- Manual invocation: report the summary and the suggested next step.

## Safety rails (absolute, all levels)

- Never push, never create PRs, never merge the loop branch.
- No destructive commands (`rm -rf`, `git reset --hard`, any `--force`) — a
  task requiring one becomes `blocked` with that reason (ledger outcome
  `blocked`).
- Modify files only under `scope:` paths and `.tech-lead/` itself.
- Spine updates are written to disk but never committed by the loop
  (bootstrap's single commit is the exception).
