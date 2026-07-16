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
   write an incident to `## Last run` (which task, both failure notes),
   outcome `halted`; stop the runner.
3. Ledger entries dated today ≥ `max_iterations_per_day` → outcome
   `skipped`, note "daily budget"; stop the runner (cron refires tomorrow;
   in `/loop` mode stop and tell the user why).

## 3 · Pick

1. Any `## Needs decision` entry whose `Decision:` line is filled → move it
   to the top of `## Backlog` with the decision attached and clear its
   `status:`; it becomes the pick.
2. Else: the first `## Backlog` item with no `blocked-by` and no parked
   `status:`.
3. Backlog dry → write "backlog dry" to `## Last run`, outcome `skipped`;
   stop the runner.

Move the pick to `## Now`.

## 4 · Classify

If `class: unclassified`: `mechanical` = fully specified, zero design
decisions; `high-stakes` = expensive to reverse (architecture, data model,
public API shape, security, major-version dependency); `hard` = everything
else that fits in one self-contained brief. Write the class back to the item.

## 5 · Execute (level × class)

- **Level 1 (any class):** write the complete would-do plan (chosen
  delegate, brief outline, verify plan) into `## Last run`; outcome
  `report-only`; touch nothing else. Promotion: if this is the 2nd
  consecutive clean `report-only` run, set `level: 2` in `LOOP.md` and
  record the promotion in `## Last run` and the ledger note. Never change
  `level` in any other case — promotion to 3 is the human's edit alone.
- **L2+, `mechanical`:** ensure the loop worktree exists —
  `git worktree add .tech-lead/worktree <branch_prefix>/<YYYY-MM-DD>`
  (create the branch from the current HEAD if new; if the worktree exists on
  an older dated branch, create today's branch from that branch's head).
  Dispatch `tech-lead:fast-worker` with a self-contained brief whose stated
  working directory is the worktree path. Its verify commands run inside the
  worktree.
- **L2, `hard` or parked-by-level work:** write the plan into `## Last run`,
  mark the item `status: waiting-level`, outcome `report-only`, note
  "waiting-level".
- **L3, `hard`:** dispatch `tech-lead:deep-reasoner` for analysis-shaped
  work or `codex:codex-rescue` for implementation-shaped work (in the
  worktree, as above).
- **Any level, `high-stakes`:** run the panel per the parent skill —
  `tech-lead:deep-reasoner` + `codex:codex-rescue`, same brief, same
  message, no cross-contamination; single seat if Codex is unavailable
  (say so). Write the synthesized recommendation to `## Needs decision`
  using the template format, mark the item `status: waiting-decision`,
  outcome `needs-decision`. This concludes the iteration — the loop never
  executes a high-stakes decision itself.

## 6 · Verify & commit (only when files changed)

Run every `verify:` command inside the worktree. All pass → commit there on
the loop branch (no Co-Authored-By line), move the item from `## Now` to
`## Done` with the SHA, outcome `done`, `verify: "pass"`. Any fail → §7.

## 7 · Failure path

First failure: one retry — revise the brief using the failure output, same
delegate. Second failure: revert uncommitted worktree changes
(`git -C .tech-lead/worktree checkout -- .`), move the item to `## Blocked`
with both failure notes, outcome `failed`, `verify: "fail"`. The firing ends;
the next firing takes the next item.

## 8 · Report & runner handling

Always: update `## Last run` (timestamp, level, what happened, next planned
action) and append exactly one ledger entry — including failed and halted
firings. No silent runs.

- `/loop` dynamic mode: work remains and budget allows → ScheduleWakeup
  60–120s; a long background delegate is still running → fallback 1200s+;
  dry / halted / paused / budget → `stop: true` with the reason. Also
  narrate a one-paragraph summary to the user.
- Cron: exit; cron refires on schedule. Never ask questions — anything
  needing input goes to `STATE.md` and the iteration ends.
- Manual invocation: report the summary and the suggested next step.

## Safety rails (absolute, all levels)

- Never push, never create PRs, never merge the loop branch.
- No destructive commands (`rm -rf`, `git reset --hard`, any `--force`) — a
  task requiring one becomes `blocked` with that reason.
- Modify files only under `scope:` paths and `.tech-lead/` itself.
- Spine updates are written to disk but never committed by the loop
  (bootstrap's single commit is the exception).
