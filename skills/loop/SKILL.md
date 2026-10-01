---
name: loop
description: This skill should be used when the user asks to "run the loop", "start the tech-lead loop", "run a loop iteration", "work through the backlog automatically", or to keep executing a project's queued backlog unattended, including the first run on a project that has no .tech-lead/ directory yet; when the user invokes "/tech-lead:loop"; or when a /loop or cron firing carries the prompt "Run /tech-lead:loop <project-path>". Not for a single task (tech-lead or tech-lead:quick).
argument-hint: [project-path]
---

# tech-lead Loop — one iteration of the backlog executor

This skill executes exactly one iteration of the backlog executor.

- **Memory.** All memory lives on disk in `<P>/.tech-lead/`. Treat the
  conversation as empty even when it is not, so the same firing works from
  `/loop`, from cron, or from a manual call.
- **Delegation.** The rules are the parent tech-lead skill's; this skill adds
  loop policy around them.
- **Where the details live:**
  - formats: `references/loop-templates.md`;
  - worktree preparation and the delegate contract: `references/worktree.md`;
  - first run: `references/bootstrap.md`;
  - briefs: `../../references/briefing-template.md`;
  - panel: `../../references/panel-protocol.md`;
  - reflex rules: `../../references/decision-contracts.md`.
- **Workflow opt-in.** Workflow is opted in when:
  - the user typed `/tech-lead:loop`, including a `/loop` or cron prompt that
    runs it; or
  - ultracode is on.

  When the skill was triggered by a phrase alone, skip the §4 triage check
  (record it as `no-verdict`) and use the panel's Agent form.

## 1 · Rehydrate

1. **Resolve paths.**
   - `<P>` = the absolute path of the argument. The default is the current
     directory.
   - `<S>` = `<P>/.tech-lead`, and `<W>` = `<S>/worktree`.
   - `<T>` = the plugin root: two directories above this skill's base
     directory (the "Base directory for this skill" line), as an absolute
     path. The loop's helper scripts live in `<T>/scripts/`.
   - Every command in this skill uses these absolute paths with `git -C`.
     Runners may start in another directory.
2. **Missing spine.** If `<S>` is missing, follow `references/bootstrap.md`.
   Bootstrap ends the firing.
3. **Read state.**
   - `LOOP.md` (config). A missing `triage:` key means `shadow`, and a
     missing `codex_timeout_min:` means 45.
   - Every section of `STATE.md`.
   - From `LEDGER.jsonl`: the last `max(10, max_consecutive_failures)`
     entries, plus every entry whose `ts` date (UTC) is today.
4. **Stale `## Now`.** If `## Now` is non-empty, a prior firing was
   interrupted.
   - Move that item back to the top of `## Backlog`, keeping its recorded
     `status:` and `class:`.
   - Fold a "recovered stale Now" note into this firing's `## Last run` and
     into its single ledger entry. One firing, one entry.

## 2 · Gates (in order; the first hit wins; each hit appends a ledger entry)

1. **Paused.** `paused: true` → outcome `halted`, note "paused". Stop the
   runner.
2. **Circuit breaker.** If the last `max_consecutive_failures` ledger outcomes
   are all `failed`:
   - write an incident to `## Last run`, naming the tasks and their failure
     notes;
   - record outcome `halted`;
   - set `paused: true` in `LOOP.md`;
   - stop the runner.
3. **Daily budget.**
   - Count today's entries (UTC) whose outcome is `done`, `failed`,
     `blocked`, `report-only`, `needs-decision` or `flagged`.
   - `halted` and `skipped` do not count. Infra incidents never loop: they
     park the item or pause the loop.
   - If the count ≥ `max_iterations_per_day`: record outcome `skipped`, note
     "daily budget", and stop the runner.

## 3 · Pick

1. **A decided item comes first.** If any `## Needs decision` entry has its
   `Decision:` line filled:
   - Copy the decision onto the matching `## Backlog` item. If the item is
     missing, recreate it at the top.
   - Clear its `status:`.
   - **Reclassify it to `hard`.** Use `mechanical` only if the decided
     follow-up is fully specified, with zero design decisions left. Never
     leave it `high-stakes`, or §5 re-panels the same item forever.
   - Delete every `## Needs decision` entry for that item.
   - It becomes the pick, but only if its `blocked-by:` passes the test in
     §3.2. If the blocker is unfinished, leave the item in `## Backlog` with
     `status: —` and continue with §3.2.
2. **Otherwise, the first eligible `## Backlog` item.** An item is eligible
   when both of these hold:
   - its `status:` is `—`, or `waiting-level` and the current `level` now
     permits its class (clear the status on pick);
   - its `blocked-by:` is `—`, or the blocker is finished. A blocker is
     finished when it is in `## Done`, or when the whole `LEDGER.jsonl` has
     a `done` entry with exactly that task title (`## Done` is trimmed).
     If a blocker name matches no item and no ledger entry, write "unknown
     blocker: <name>" in `## Last run` and keep the item ineligible.

   `waiting-decision` and `waiting-infra` items are never picked. A human
   clears `waiting-infra`.
3. **Backlog dry.** Write "backlog dry" to `## Last run`, record outcome
   `skipped`, and stop the runner.

Move the pick to `## Now`.

## 4 · Classify

**Classes.** If `class: unclassified`, pick one:

- `mechanical`: fully specified, zero design decisions;
- `high-stakes`: expensive to reverse (architecture, data model, public API
  shape, security, a major-version dependency);
- `hard`: everything else that fits in one self-contained brief.

When unsure between two classes, pick the more cautious one. Write the class,
and a one-line reason, back to the item.

**Triage second check.** It runs on every freshly classified item, unless
`LOOP.md` has `triage: off` or Workflow is not opted in.

1. Run `Workflow({name: "tech-lead:triage", args: {item: {title, notes},
   orchestratorClass: <your class>}})`. Only the title and notes go in.
2. The workflow enforces the verdict schema and computes `derived`,
   `checker` and `agreement` in code.
3. If the workflow is unavailable, returns "not found", or returns no verdict,
   record `no-verdict` and fail open. Do not substitute a plain Agent call:
   its output is not schema-enforced.
4. Set the final class:
   - `triage: shadow` → your class;
   - `triage: gate` → `max(your class, checker)`.

   Nothing lowers your class.
5. Record the result in the ledger `triage` field.

An item whose class was set before this firing is not re-triaged. That
includes a class set in §3.

## 5 · Execute (level × class)

- **L1, `mechanical` or `hard`.** Dispatch nothing and modify no project
  files.
  - Write the complete would-do plan into `## Last run`: delegate, brief
    outline, and verify plan. Record outcome `report-only`.
  - **Promotion from L1 to L2.** This is the only automatic change of
    caution, and it is a documented exception to the reflex rules. When the
    previous ledger entry is `report-only` and this firing's outcome is also
    `report-only`:
    - set `level: 2` in `LOOP.md`;
    - record the promotion in `## Last run` and in the ledger note.

    Never change `level` in any other case. Promotion to L3 is the human's
    edit alone.
- **L2+, `mechanical`.**
  1. Prepare the worktree (`references/worktree.md`).
  2. Dispatch `tech-lead:fast-worker` (`name: "loop-worker"`) with a
     self-contained brief that carries the execution contract from that file.
     Its verify commands run inside `<W>`.
- **L2, `hard`.** Park it by level:
  - write the plan into `## Last run`;
  - mark the item `status: waiting-level`;
  - record outcome `report-only`, note "waiting-level".
- **L3, `hard`, analysis-shaped.** Dispatch `tech-lead:deep-reasoner`. It is
  read-only, so its analysis must land somewhere:
  - Write its Recommendation and Risks into `## Last run`.
  - If the analysis implies code changes, add a follow-up item at the top of
    `## Backlog`, classified per §4.
  - Move the analysed item to `## Done` with `—` in the sha slot. Record
    outcome `done`, `commits: []`, note "analysis → <follow-up title or 'no
    follow-up'>".
- **L3, `hard`, implementation-shaped (Codex).**
  1. Prepare the worktree (`references/worktree.md`).
  2. Write the brief, including the execution contract and its
     `JUDGMENT CALLS:` / `SKIPPED:` trailer, to `<S>/briefs/<slug>.md`.
  3. **Start.** The `codex:codex-rescue` wrapper cannot pin a working
     directory, so the loop runs Codex as a companion job through its
     helper. Every helper call is a foreground Bash call with
     `timeout: 600000`, and prints one JSON line:

     ```
     node <T>/scripts/loop-codex.mjs start --cwd <W> --prompt-file <S>/briefs/<slug>.md
     ```

     Exit 3 (`"state": "unavailable"`) means Codex cannot run: not
     installed, not authenticated, or a version error. Return the item to
     `## Backlog` with `status: waiting-infra`, and record outcome
     `skipped`, note "codex unavailable".
  4. **Wait.** Repeat while `state` is `running`. Write the printed `jobId`
     literally into each call; shell variables do not survive between Bash
     calls:

     ```
     node <T>/scripts/loop-codex.mjs wait <jobId> --cwd <W> --cap-min <codex_timeout_min>
     ```

  5. **Outcomes:**
     - **`completed`:** run
       `node <T>/scripts/loop-codex.mjs result <jobId> --cwd <W>`. Its
       `answer` is Codex's report, and `flagged: true` (the trailer is
       missing or is not `none`) makes the item delegate-flagged. Go to §6.
       If `result` exits 1, the turn has ended but its report is
       unreadable: run §7's Reset, return the item with
       `status: waiting-infra`, and record outcome `skipped`, note "codex
       result unreadable".
     - **`failed`:** the turn has ended. Run §7's Reset, return the item
       with `status: waiting-infra`, and record outcome `skipped`, note
       "codex failed".
     - **`cap`, `cancelled` or `error`:** the turn may still be writing into
       `<W>`. Run `node <T>/scripts/loop-codex.mjs stop <jobId> --cwd <W>`.
       It reports `"stopped": true` only when the job finished by itself or
       the companion confirmed the Codex turn was interrupted.
       - `"stopped": true`: run §7's Reset, return the item with
         `status: waiting-infra`, and record outcome `skipped`, note "codex
         timeout".
       - `"stopped": false`: do not touch `<W>`. Write an incident to
         `## Last run` ("Codex job <jobId> could not be confirmed stopped;
         check `/codex:status` before unpausing"), set `paused: true` in
         `LOOP.md`, return the item with `status: waiting-infra`, and record
         outcome `skipped`, note "codex turn still live".

     Never retry while a Codex turn may still be live.
- **Any level, `high-stakes`.** Follow `../../references/panel-protocol.md`,
  with these loop specifics:
  1. **Brief.** Write it to `<S>/briefs/<slug>.md`, with option ids. Pass
     `briefPath` as an absolute path.
  2. **Snapshot the project content**, excluding `.tech-lead/`:

     ```
     (cd <P> && { git rev-parse HEAD; git diff HEAD --binary -- . ':(exclude).tech-lead'; git ls-files -o --exclude-standard -z -- . ':(exclude).tech-lead' | xargs -0 shasum; } | shasum)
     ```

  3. **Run the seats:**
     - Workflow opted in → `Workflow({name: "tech-lead:panel-seats", args:
       {briefPath, options}})`;
     - otherwise, or if the workflow is "not found" → the protocol's Agent
       form.
  4. **Upsert `## Needs decision`.** Write the synthesis using the template
     format, recording each seat's model and the `agreement`. Replace any
     existing entry for this item; never append a second one.
  5. **Set outcomes.** Mark the item `status: waiting-decision`, and record
     outcome `needs-decision`.
  6. **Re-take the snapshot.** If it differs, the project changed during the
     panel. The cause may be a seat, or the user's own concurrent edits.
     - Put a warning in the `## Needs decision` entry and in `## Last run`.
     - Set `paused: true`, so a human looks before the loop continues.
     - Never revert the user's tree.

  The loop never executes a high-stakes decision itself. The panel runs at
  every level, including L1.

**Ending the iteration before §6/§7.** Any branch that ends without reaching
§6 or §7 returns the item from `## Now` to the top of `## Backlog`. The one
exception is the L3 analysis branch, which moves the item to `## Done`. The
returned item keeps the `status:` that its branch set:

- `waiting-decision` for a panel;
- `waiting-level` for parked L2 work;
- `waiting-infra` for an infra incident.

The only reset is an L1 `report-only` item: it returns with `status: —`,
keeping its class, so L2 re-picks it. That reset never applies to a panel
item that ran at L1. `## Now` must be empty when the firing ends.

## 6 · Verify & commit (after a write-capable dispatch)

Verify BEFORE staging anything. A failing task must never leave a staged
index for the next firing.

1. **Delegate-flagged check (first).** It fires when the delegate reported
   any judgment call, or skipped or flagged any spec item. For Codex, that
   means `loop-codex.mjs result` reported `flagged: true`. When it fires:
   1. Do not verify and do not stage. Run §7's **Reset** only.
   2. Upsert a `## Needs decision` entry for the item, holding the questions
      and the delegate's suggested defaults (template format).
   3. Return the item to `## Backlog` with `status: waiting-decision`.
   4. Record outcome `flagged`.

   A human fills `Decision:`, and §3.1 releases the item. The loop never
   answers a delegate's judgment call itself.
2. **Scope rail.**
   1. Compute the touched paths from ground truth:
      `git -C <W> status --porcelain=v1 -uall`, minus the untracked baseline
      `U` recorded in `worktree.md` step 5.
   2. Every path must fall under `LOOP.md`'s `scope:`. `.tech-lead/` is
      exempt and is never committed. If any path is outside `scope:`, stage
      nothing. That is an attempt failure (§7); name the path in the
      failure note.
   3. In-scope paths the delegate did not report stay eligible. List them in
      `## Last run` as "unreported: …".
3. **Verify.** Run every `verify:` command inside `<W>`, with nothing
   staged.
   - Assert `git -C <W> diff --cached --quiet`.
   - If the index is unexpectedly non-empty, unstage it without reverting the
     working tree: `git -C <W> restore --staged .`. Then assert again.
     - Never run §7's working-tree revert here. It would discard the current
       task's work.
   - Any verify failure is an attempt failure (§7).
4. **Commit.**
   - **All pass, files changed:**
     1. Stage only the in-scope ground-truth paths: `git -C <W> add --
        <paths>`.
     2. Commit on the loop branch, with no Co-Authored-By line. If `add` or
        `commit` fails (for example, a rejecting pre-commit hook), that is an
        attempt failure (§7). Include the hook's output in the failure
        excerpt.
     3. On a clean commit, move the item to `## Done` with the SHA. Record
        outcome `done`, `verify: "pass"`.
   - **All pass, nothing changed:** record outcome `done`, `commits: []`,
     note "no changes needed". Move the item to `## Done` with `—` in the sha
     slot.

   Either way, trim `## Done` to the 20 most recent entries.

## 7 · Failure path

**Attempt failure.** An attempt fails on a verify failure, a scope-rail
violation, or a failed `add` or `commit`.

1. Unstage: `git -C <W> restore --staged .`. Keep the working tree.
2. **First failure:** retry once with the same delegate. The retry brief is
   the original brief plus the verbatim failure excerpt. The retry works on
   top of the current tree.
   - Do not re-run the worktree preparation.
   - `U` stays exactly as recorded.
   - Then return to §6.
3. **Second failure:** run Reset, then Block.

**Reset** returns `<W>` to a clean baseline:

1. `git -C <W> restore --staged .`
2. `git -C <W> checkout -- .`
3. Delete the untracked files this task created: the untracked paths not in
   `U`. Use individual `rm`, never `rm -rf`.
4. `<W>`'s index and tracked tree must now match the loop branch HEAD.

**Block:** move the item to `## Blocked` with a one-line reason covering both
attempts. Record outcome `failed`, `verify: "fail"`.

## 8 · Report & runner handling

**Always:**

- Update `## Last run`: timestamp, level, what happened, and the next planned
  action.
- Append exactly one ledger entry, even for failed or halted firings.

**Completion rule.** Every dispatch must COMPLETE inside the firing.

- Agent and Workflow results arrive as completion notifications. Wait for
  them before §6. Headless `claude -p` waits too.
- A Codex job is waited on with foreground `loop-codex.mjs wait` calls
  until its state is no longer `running`.
- Never end the turn, call ScheduleWakeup, or exit while a dispatch is
  outstanding.
- Start Codex only through `loop-codex.mjs start`; never call the
  companion's `task` yourself. Never use `isolation: "remote"`.

**Runners:**

- **`/loop` dynamic mode.**
  - Work remains, the budget allows, and this firing had no infra incident →
    `ScheduleWakeup({delaySeconds: 60–120, reason: "<one line>", prompt:
    <the same /loop input, verbatim>, noop: <true only if nothing
    changed>})`.
  - Otherwise → `ScheduleWakeup({stop: true})`, and state the reason.
  - Narrate a one-paragraph summary.
- **Scheduled.**
  - Supported runners:
    - (a) `CronCreate` in a dedicated interactive session opened in `<P>`
      that stays open. CronCreate enqueues into that session and inherits
      its working directory and settings; it cannot start a new process.
      Jobs are session-only (CronCreate has no durable mode), and recurring
      jobs expire after 7 days, so re-arm them.
    - (b) OS cron or launchd running
      `cd <P> && claude -p 'Run /tech-lead:loop <P>'`.
  - Cloud routines are not supported: they cannot see the local tree.
  - Treat every scheduled firing as unattended. Never ask questions; anything
    that needs input goes to `STATE.md`. The bootstrap confirmation is the
    sole exception.
- **Manual.** Report the summary and the suggested next step.

## Safety rails (absolute, all levels)

- Never push, create PRs, or merge the loop branch.
- **No destructive commands:** no `rm -rf`, no `git reset --hard`, no
  `--force`. A task that requires one becomes `blocked` with that reason.
- Modify files only under `scope:` paths and `<S>`.
- Spine updates are written to disk and never committed by the loop. The
  bootstrap commit is the only exception.
- Never stage or delete files in the untracked baseline `U`.
