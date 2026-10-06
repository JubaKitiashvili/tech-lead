---
name: loop
description: This skill should be used when the user asks to "run the loop", "start the tech-lead loop", "run a loop iteration", "work through the backlog automatically", or to keep executing a project's queued backlog unattended, including the first run on a project that has no .tech-lead/ directory yet; when the user invokes "/tech-lead:loop"; or when a /loop or cron firing carries the prompt "Run /tech-lead:loop <project-path>". Not for a single task (tech-lead or tech-lead:quick).
argument-hint: [project-path]
---

# tech-lead Loop — one iteration of the backlog executor

This skill executes exactly one iteration of the backlog executor.

- **Memory.** All memory lives on disk in `<P>/.tech-lead/`. Treat the
  conversation as empty even when it is not, so the same firing works from
  `/loop`, from cron, or from a manual call. The loop's work area, outside
  the project (`~/.cache/tech-lead/<key>/`), holds the lock, the clone where
  delegates work, run records and bundles; only the helper scripts create or
  remove files there.
- **Delegation.** The rules are the parent tech-lead skill's; this skill adds
  loop policy around them.
- **Where the details live:**
  - formats: `references/loop-templates.md`;
  - item edits (applying the item helper's plans, moving an item, the
    incident when they do not match): "Item edits", after §8;
  - clone preparation, the checks after untrusted execution, the helpers'
    refusals and the delegate contract: `references/clone.md`;
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
   - `<S>` = `<P>/.tech-lead`.
   - `<T>` = the plugin root: two directories above this skill's base
     directory (the "Base directory for this skill" line), as an absolute
     path. The loop's helper scripts live in `<T>/scripts/`.
   - Every command in this skill uses these absolute paths. Runners may
     start in another directory.
2. **Missing spine.** If `<S>` is missing, follow `references/bootstrap.md`.
   Bootstrap ends the firing. It takes no lock.
3. **Acquire the firing lock,** before anything under `<S>` is read:

   ```
   node <T>/scripts/loop-lock.mjs acquire <P>
   ```

   The lock lives outside the project (in `~/.cache/tech-lead/`), so one
   firing at a time works on `<P>`, whichever runner started it.
   - **Exit 3** (`"state": "held"`) **or exit 2** (`"state": "error"`): end
     the firing at once and write nothing: no spine edit and no ledger
     entry. Ending at the lock, and losing the lock (below), are the only
     exceptions to §8's one-entry rule. Report the printed `reason` or
     `detail`, and any children it lists in `stopped`. Then, by `reason`:
     - `holder-live`, `race` or `holder-unknown` (transient contention:
       another firing holds the lock or took it first, or a holder's
       liveness could not be read just now): keep the runner. In `/loop`
       dynamic mode, schedule the next wakeup as usual (§8, Runners); a
       scheduled runner simply ends this firing.
     - `corrupt`, `dispatch-open`, `child-live`, `sweep-unknown`, or exit 2:
       stop the runner, because a human must look first. These mean an
       unreadable lock record, a dispatch of an interrupted firing in this
       process still on record, a child of an earlier firing that cannot be
       stopped (`alive`) or a process still running in the lock's cache
       directory, which holds `<W>`, or in an old `<S>/worktree` (`procs`;
       the lock never signals a process it did not record), a check for
       such processes that could not run, or a lock error (its `detail`,
       for example `not-toplevel`: `<P>` is not the top level of its
       repository).
   - **Exit 0** (`"state": "acquired"`): `generation` is this firing's
     `<N>`, and `W` is `<W>`, the loop's clone: an isolated full clone of
     the project in the work area, where delegates and verify commands work
     (`references/clone.md`). Write both literally into every later
     command; shell variables do not survive between Bash calls. `<N>` is
     also this firing's ledger `iteration`. The main session runs git in
     `<W>` only through the helpers: `loop-clone.mjs` and
     `reflex-bundle.mjs` make every change there, and a read goes through
     `node <T>/scripts/loop-clone.mjs git <P> -- <subcommand> …`.
   - **`reclaimed` is set:** an earlier firing ended without releasing, and
     acquire stopped its children before taking over. Note "reclaimed
     generation <generation> (<how>)" and what it `stopped` in `## Last run`.
     A `same-process` reclaim is always noted.
   - **`stopped` is set:** children of an earlier generation, other than a
     reclaimed one, were still on record (for example after an owner
     release, which stops nothing), and acquire stopped them first. Note
     each `file` in `## Last run`.
   - **Dispatch records.** Bracket every Agent and Workflow dispatch of
     this firing (the triage workflow, the panel workflow or each of its
     Agent-form seats, each delegate, a §7 retry) with a record of `<N>`.
     Right before the call:

     ```
     node <T>/scripts/loop-lock.mjs dispatch open <P> --generation <N> --label <agent or workflow name>
     ```

     It prints `{"id": …}`. Once the dispatch's result has arrived (§8,
     completion rule), or the call failed, close it with that id:

     ```
     node <T>/scripts/loop-lock.mjs dispatch close <P> --generation <N> --id <id>
     ```

     An open record tells the next firing in this process that an agent of
     `<N>` may still be running, so it does not take the lock over.
   - **Lost lock.** A not-holder answer from a lock-checked command means
     the owner or another firing took `<N>` over: `dispatch open` or
     `dispatch close` exit 3, an `exec` state of `not-holder` or
     `holder-gone` (also as the `outcome` of a `lingering` run),
     `loop-codex.mjs start` exit 4,
     `loop-clone.mjs` or `reflex-bundle.mjs` exit 3 with
     `"state": "not-holder"`, or `release` exit 3 with
     `"state": "not-holder"`. A `"reason": "closing"` on it means another
     firing has begun to stop `<N>`'s children. Stop at once. Write nothing
     more to `<S>` or `<W>`, append no ledger entry, and report it. The
     next firing recovers what this one left. Two answers are not a lost
     lock: a release refused with `"state": "dispatch-open"` (also exit 3,
     §8), and exit 2 (`"state": "error"`), even with a `holder-unknown`
     detail (the runner's own start token could not be read just now, so
     the hold is unproven, not gone; see Lock errors).
   - **Lock errors.** On exit 2 from `dispatch open` or `dispatch close`,
     dispatch nothing more. Write the `detail` as an incident in
     `## Last run`, set `paused: true`, return the item to `## Backlog`
     with its `status:` unchanged, record outcome `skipped`, note "lock
     error", and go on to §8. An `exec` error and a `loop-codex.mjs start`
     exit 2 follow their own steps (§6, §5, `references/clone.md`).
4. **Read state.**
   - `LOOP.md` (config). A missing `triage:` key means `shadow`, and a
     missing `codex_timeout_min:` means 45.
   - Every section of `STATE.md`.
   - From `LEDGER.jsonl`: the last `max(10, max_consecutive_failures)`
     entries, plus every entry whose `ts` date (UTC) is today.
5. **Plan the recovery.** The recovery planner reports what an interrupted
   firing left: an item in `## Now`, a commit without its bookkeeping,
   bundles no ledger entry names, stale delivery bundles, and work left in
   `<W>`. It only reads:

   ```
   node <T>/scripts/loop-recover.mjs <P> --generation <N> --reclaimed <generation>
   ```

   Pass `--reclaimed` only when acquire reported `reclaimed`, with its
   `generation`. Exit 2 means the planner could not read the project or a
   delivery bundle (`bundle-check: <branch>: …`), or found a run record,
   bundle or clone it cannot trust (`corrupt`, `record-from-the-future`,
   `tampered`, `clone-invalid`, `unknown-tip`). First, if `## Now` holds an
   item, move it back to the top of `## Backlog` with its whole block
   (Item edits), its `status:` and `class:` included, and name it in the
   incident. Then write the planner's `detail` as an incident in
   `## Last run`, set `paused: true`, record outcome `skipped`, note
   "recovery planner", and stop the runner. Otherwise, copy its `notes`
   into `## Last run` and take its `actions` in order. At most one of
   `clear-now`, `now-conflict`, `finish-commit` and `requeue-now` is
   listed, and it comes first:
   - `clear-now`: `## Now` holds one item, and an identical copy of it
     (same id, title, notes and decision, the same `blocked-by:`,
     `decided:` and `no-change-ok:` lines, and the same origin lines as
     written; only its `status:`, `class:`, a `recovery:` line and the
     header form, which a move rewrites, may differ) is in
     `clear.section`, so an interrupted firing stopped inside a move,
     after the insertion and before the deletion (Item edits). The other copy is the item. Apply
     `clear.edits` in order, one Edit each (Item edits, Applying edits):
     they delete that one block from `## Now`, never anything else there.
     Then run
     `node <T>/scripts/loop-items.mjs check <P> --expect <clear.expect_sha256>`,
     and note "cleared interrupted move of <clear.id>" in `## Last run`.
     Then confirm the other copy as a move is confirmed (Item edits, steps
     1 and 4): `node <T>/scripts/loop-items.mjs digest <P> --item <clear.id>`,
     then
     `node <T>/scripts/loop-items.mjs check <P> --item <clear.id>@<clear.section>:<item_digest>`.
   - `now-conflict`: the `## Now` item's id is carried elsewhere too, but
     the copies are not one item moved halfway: they differ (a person
     amended one: its title, notes or decision, `digest-differs`; its
     `blocked-by:`, `blocked-by-differs`; an origin line,
     `origin-differs`; or its `decided:` or `no-change-ok:` line,
     `decided-differs`, `no-change-ok-differs`), `## Now` holds another
     block as well (`several-now-items`), the id has more than one other
     carrier (`several-carriers`), or a line that does not read as that
     item carries it (an `id:` line of an unparsed block, `raw-carrier`).
     `conflict.reasons` says which, and `conflict.carriers` lists where
     each copy is. It is an
     item-edit incident (Item edits), named by `conflict.id` and
     `conflict.reasons`: edit no item and keep every copy (a prerequisite
     added to one copy included). The incident
     ends the firing here, so the actions listed after it are not taken
     (the next firing's planner lists them again). A person decides which
     copy is the item (README, Troubleshooting).
   - `finish-commit`: an interrupted firing committed the `## Now` item but
     stopped before its bookkeeping (the planner matched the run record's
     item id and digest, and its `## Now` line; for a record an older
     release wrote, the line alone). Move that item to the top
     of `## Done` (Item edits), in its format, with `finish.sha` in the sha
     slot (no title search); the check takes `finish.item_id` and
     `finish.item_digest`.
   - `requeue-now`: `## Now` holds an item, so a prior firing was
     interrupted. Move that item back to the top of `## Backlog` (Item
     edits), keeping its whole block, its recorded `status:` and `class:`
     included. Fold a "recovered stale Now" note into this firing's
     `## Last run` and into its single ledger entry. One firing, one entry.
   - `ledger-recovered`: a commit or bundle of an interrupted firing is in
     no ledger entry. This firing's single entry carries the planner's
     `recovered` as its `recovered` field (its `item_id` and `item_origin`
     included), with `action` set to the `## Now` action taken
     (`finish-commit`, `requeue-now`, or null; null after `clear-now`).
   - `write-bundle`: for each branch in `write_bundles`, rewrite its
     delivery bundle:

     ```
     node <T>/scripts/loop-clone.mjs bundle <P> --generation <N> --branch <branch>
     ```

     `bundled`: add its `bundle` to the ledger entry's `bundles`. `current`:
     nothing to do. Anything else (`unvetted`, exit 2): note it in
     `## Last run`.
   - `note-leftovers`: `<W>` holds work that an interrupted firing left.
     Note it in `## Last run`. Do not touch `<W>` here: the next clone
     preparation (`references/clone.md` step 1) saves it to a recovery
     bundle and resets `<W>`.

## 2 · Gates (in order; the first hit wins; each hit appends a ledger entry)

1. **Paused.** `LOOP.md` says `paused: true` → outcome `halted`, note
   "paused". Stop the runner.
2. **Circuit breaker.** If the last `max_consecutive_failures` ledger outcomes
   are all `failed`:
   - write an incident to `## Last run`, naming the items (each entry's
     `item_id`, with its `task` title) and their failure notes;
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

The item helper reads `STATE.md`, `LOOP.md` and `LEDGER.jsonl` and never
writes: it prints anchored `edits` and `expect_sha256`, the SHA-256 of
`STATE.md` once they are applied. "Item edits" (after §8) says how to apply
them, and what to do when the helper refuses or a check does not match.

1. **Normalize.** Give every item an id and an origin:

   ```
   node <T>/scripts/loop-items.mjs normalize <P>
   ```

   It mints an id for every item that has no `id:` line, in every section,
   writes `origin: unknown` on every item that has no `origin:` line, and
   rewrites an id written in upper case in lower case.
   It never rewrites what a person wrote: a damaged id, origin, title or
   `blocked-by:` is only reported, in `problems`. Apply its `edits` in
   order, each with one Edit, then confirm them (also when `edits` is
   empty):

   ```
   node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>
   ```

   Note the `minted` ids, and each of `problems` (its `kind`, `line`,
   `detail` and any `candidate` id), in `## Last run`.
2. **Pick.** The helper applies §3.1 and §3.2 below, reading `level` from
   `LOOP.md` itself:

   ```
   node <T>/scripts/loop-items.mjs pick <P>
   ```

   Apply pick's `edits` in order, each with one Edit (they release decided
   items, then move the pick into `## Now`, inserting before deleting),
   then confirm them:

   ```
   node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>
   ```

   - `"state": "picked"`: the item `id` (`title`) now sits in `## Now`. It
     is this firing's item, and the rest of the firing names it by `<id>`.
     Keep its `digest`: every move of this item checks it (Item edits).
     `from: "decision"` means a decision released it (§3.1).
   - `"state": "dry"`: no item is eligible. Write "backlog dry" to
     `## Last run`, record outcome `skipped`, and stop the runner.
   - Either way, note each `released` id in `## Last run`, and each row of
     `skipped` as "skipped <id> <title>: <reason> (<detail>)". A person
     fixes a parked item (README, "Why the loop skips an item").
   - Keep `unledgered` (also printed with an exit 3 refusal): the
     `## Done` items, each `{item_id, item_origin}`, that no ledger entry
     records done yet, such as an item an interrupted firing moved there
     before its ledger append. §8's ledger entry records them, and the
     `## Done` trim keeps them until then (Item edits, Trimming
     `## Done`).

**3.1 · A decided item comes first.** A `## Needs decision` entry is decided
when its own line that begins with `**Decision:**` holds something other
than the template placeholder; text anywhere else in the entry never counts.
For each decided panel or delegate-flagged entry, by the id in its heading:

- The item with that id, in `## Backlog` or `## Blocked`, gets the decision
  in its `decision:` field (after any earlier decision, as
  `<old>; then: <new>`), its `status:` cleared, and class `hard`. A
  `## Blocked` item moves to the top of `## Backlog`. Then every entry for
  that id is deleted.
- Nothing is guessed. When no open item has the id, the entry stays and
  `skipped` names it: `orphan-entry` (no item has the id) or
  `entry-item-done` (the item is in `## Done`). So does an entry whose id
  more than one block carries, or a line that does not read as that item
  (an `id:` line of an unparsed block, a capitalized `ID:`), since the
  decision could be meant for either (`ambiguous-carrier`; the decision is
  written into no copy). The one exception is the pair an interrupted
  release left, the `## Blocked` item and its released copy in
  `## Backlog`, when nothing else carries the id: the release finishes
  that move. So does an entry with two `**Decision:**` lines (`ambiguous-decision`), or an item the release
  cannot read (its own problem, such as `malformed-field`) or whose title
  its `## Backlog` header would change (`ambiguous-title`). A heading
  without an id is skipped as `legacy-entry`, with the candidate id.
- A released item is the pick, if it is eligible (§3.2). Otherwise it waits
  in `## Backlog` with its status cleared, and the pick goes on with §3.2.
- **Lower the class only by hand.** `hard` may become `mechanical` only if
  the decision fully specifies the work, with zero design decisions left:
  one Edit of the `## Now` header, before §4. Never make it `high-stakes`,
  or §5 re-panels the same item forever.

**3.2 · Otherwise, the first eligible `## Backlog` item,** from the top. An
item is eligible when all of these hold:

- it has a valid id that no other item carries, and a title that no other
  open item has (open: `## Now`, `## Backlog`, `## Blocked`);
- it has no item problem: a malformed or doubled field, an invalid origin,
  an ambiguous title, an origin cycle, or a `blocked-by:` that is not one
  known id (`references/loop-templates.md`, Items);
- its `status:` is `—`, or `waiting-level` and the current `level` now
  permits its class (`mechanical` needs `level: 2`, `hard` needs
  `level: 3`); the pick clears that status;
- its `blocked-by:` is `—`, or the blocker is finished.

A blocker is finished when all of these hold: no open item has its id; its
id is in `## Done`, or a ledger entry records it done (`outcome` `done` with
that `item_id`, or a `recovered` `finish-commit` with that `item_id`); and
no open item descends from it, following `origin: loop from` links up the
chain through open items, `## Done` items and the origins the ledger
recorded (`## Done` is trimmed). So a done analysis item holds its
dependents while its follow-up is open. A ledger entry without `item_id`
never finishes a blocker.

`waiting-decision` and `waiting-infra` items are never picked. A human
clears `waiting-infra`.

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
   Bracket it with a dispatch record (§1 step 3).
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

Every brief in this section (the fast-worker's, the deep-reasoner's,
Codex's and the panel's) carries the item's title, its notes and, when it is
not empty, its decision under a label of its own (`Decision:`). The §4
triage check gets only the title and notes. Briefs and subjects are named
by the item's `<id>`.

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
  1. Prepare the clone (`references/clone.md`).
  2. Dispatch `tech-lead:fast-worker` (`name: "loop-worker"`) with a
     self-contained brief that carries the execution contract from that file,
     bracketed by a dispatch record (§1 step 3). Its verify commands run
     inside `<W>`.
  3. Check the clone once its result has arrived (`references/clone.md`,
     After every untrusted execution), then go to §6:

     ```
     node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after dispatch
     ```
- **L2, `hard`.** Park it by level:
  - write the plan into `## Last run`;
  - mark the item `status: waiting-level`;
  - record outcome `report-only`, note "waiting-level".
- **L3, `hard`, analysis-shaped.** Dispatch `tech-lead:deep-reasoner`,
  bracketed by a dispatch record (§1 step 3). It is read-only, so its
  analysis must land somewhere:
  - Write its Recommendation and Risks into `## Last run`, through
    `loop-text.mjs block`.
  - If the analysis implies code changes, create one follow-up item. Write
    its title (one line) and notes, from the analysis, as the JSON object
    `{"title": "<title>", "notes": "<notes>"}` to
    `<S>/briefs/<id>-followup.json` with the Write tool, where `<id>` is the
    analysed item's id. The text never goes on a command line. Then:

    ```
    node <T>/scripts/loop-items.mjs followup <P> --parent <id> --input <S>/briefs/<id>-followup.json
    ```

    It plans a new item at the top of `## Backlog`: a fresh id,
    `origin: loop from <id>`, `class: unclassified` (the firing that picks
    it classifies it, §4), and the title and notes neutralized; a title
    another open item already has gets the new id appended. Apply its
    `edits` in order with Edit, then run
    `node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>`.
    Both of its `"state": "ok"` answers are a success, and `id` names the
    follow-up: `"reused": false` is a new follow-up, with its insertion in
    `edits`; `"reused": true` means an interrupted firing already created
    it, and `edits` is empty (run the check all the same). Only a refusal
    (exit 3) or an error (exit 2) is an item-edit incident (Item edits).
  - Move the analysed item to `## Done` with `—` in the sha slot (Item
    edits), then trim `## Done` (Item edits, Trimming `## Done`). Record
    outcome `done`, `commits: []`, note "analysis →
    <follow-up id or 'no follow-up'>". While the follow-up is open, the
    analysed item still holds every item it blocks (§3).
- **L3, `hard`, implementation-shaped (Codex).**
  1. Prepare the clone (`references/clone.md`).
  2. Write the brief, including the execution contract and its
     `JUDGMENT CALLS:` / `SKIPPED:` trailer, to `<S>/briefs/<id>-codex.md`.
  3. **Start.** The `codex:codex-rescue` wrapper cannot pin a working
     directory, so the loop runs Codex as a companion job through its
     helper. Every helper call is a foreground Bash call with
     `timeout: 600000`, and prints one JSON line:

     ```
     node <T>/scripts/loop-codex.mjs start --cwd <W> --prompt-file <S>/briefs/<id>-codex.md --cap-min <codex_timeout_min> --project <P> --generation <N>
     ```

     - Exit 2: nothing was launched. Either `codex_timeout_min` is not a
       number of minutes from 1 to 1440, or the lock could not register
       the job (`"state": "error"` with a `detail`). Write an incident
       naming the value or the `detail`, set `paused: true`, return the
       item with its `status:` unchanged, and record outcome `skipped`,
       note "codex_timeout_min invalid" or "codex start error".
     - Exit 3 (`"state": "unavailable"`): Codex could not be launched (not
       installed, a version error, or a launch whose outcome is unknown).
       Run step 5's quiesce without `--job`. When it is quiet, check the
       clone (`check --after dispatch`, as in step 6), return the item
       with `status: waiting-infra`, and record outcome `skipped`, note
       "codex unavailable".
     - Exit 4 (`"state": "not-holder"`): the firing lost its lock (§1
       step 3). The helper launched nothing, or quiesced the job it had
       just launched (its `quiet` tells whether that worked).
  4. **Wait.** Repeat while `state` is `running`. Write the printed `jobId`
     literally into each call; shell variables do not survive between Bash
     calls:

     ```
     node <T>/scripts/loop-codex.mjs wait <jobId> --cwd <W> --cap-min <codex_timeout_min>
     ```

     A wait call that exits non-zero, prints no JSON, or hits the Bash
     timeout counts as `error`.
  5. **Quiesce,** whatever the state (`completed`, `failed`, `cancelled`,
     `cap` or `error`). No status proves Codex stopped writing: the companion
     reports a job `cancelled` even when the interrupt failed.

     ```
     node <T>/scripts/loop-codex.mjs quiesce --cwd <W> --job <jobId>
     ```

     It cancels every Codex job active in `<W>`, shuts down `<W>`'s Codex
     broker, and reports `"quiet": true` only when those processes are gone.
     On `"quiet": false`, do not touch `<W>`. Write an incident to
     `## Last run` with its `detail` and this unpause check: "run
     `node <T>/scripts/loop-codex.mjs quiesce --cwd <W>`; set
     `paused: false` once it prints `"quiet": true`". Set `paused: true`,
     return the item with `status: waiting-infra`, and record outcome
     `skipped`, note "codex not quiet".
  6. **Outcomes,** after a quiet quiesce. First check the clone
     (`references/clone.md`, After every untrusted execution):

     ```
     node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after dispatch
     ```

     - **`final` is `completed`:** run
       `node <T>/scripts/loop-codex.mjs result <jobId> --cwd <W>`. Its
       `answer` is Codex's report, and `flagged: true` (the trailer is
       missing or is not `none`) makes the item delegate-flagged. Go to §6.
       If `result` exits 1, the report is unreadable: run §7's Save and
       reset with `--why codex`, return the item with
       `status: waiting-infra`, and record outcome `skipped`, note "codex
       result unreadable".
     - **Any other `final`:** run §7's Save and reset with `--why codex`,
       return the item with `status: waiting-infra`, and record outcome
       `skipped`, note "codex timeout" when the wait ended at `cap`, or
       "codex <final>" otherwise.

     Never retry while a Codex turn may still be live.
- **Any level, `high-stakes`.** Follow `../../references/panel-protocol.md`,
  with these loop specifics:
  1. **Brief.** Write it to `<S>/briefs/<id>-panel.md`, with option ids.
     Pass `briefPath` as an absolute path.
  2. **Snapshot the project content**, excluding `.tech-lead/`.
     `diff.autoRefreshIndex=false` keeps the snapshot from rewriting
     `<P>/.git/index`:

     ```
     (cd <P> && { git rev-parse HEAD; git -c diff.autoRefreshIndex=false diff HEAD --binary -- . ':(exclude).tech-lead'; git ls-files -o --exclude-standard -z -- . ':(exclude).tech-lead' | xargs -0 shasum; } | shasum)
     ```

  3. **Run the seats,** each dispatch bracketed by a dispatch record (§1
     step 3):
     - Workflow opted in → `Workflow({name: "tech-lead:panel-seats", args:
       {briefPath, options}})`;
     - otherwise, or if the workflow is "not found" → the protocol's Agent
       form.
  4. **Upsert `## Needs decision`.** Write the synthesis using the template
     format, headed `### <id> · <title>`, recording each seat's model and
     the `agreement`. Each seat's line is seat-written text, so it goes
     through `loop-text.mjs line` first (Safety rails). Replace any existing
     entry whose heading has this item's id; never append a second one.
  5. **Set outcomes.** Mark the item `status: waiting-decision`, and record
     outcome `needs-decision`.
  6. **Re-take the snapshot,** with the same command. If it differs, the
     project changed during the panel. The cause may be a seat, or the
     user's own concurrent edits.
     - Put a warning in the `## Needs decision` entry and in `## Last run`.
     - Set `paused: true`, so a human looks before the loop continues.
     - Never revert the user's tree.

  The loop never executes a high-stakes decision itself. The panel runs at
  every level, including L1.

**Ending the iteration before §6/§7.** Any branch that ends without reaching
§6 or §7 returns the item from `## Now` to the top of `## Backlog` (Item
edits). The one exception is the L3 analysis branch, which moves the item to
`## Done`. The returned item keeps the `status:` that its branch set, written
in the move's insertion:

- `waiting-decision` for a panel;
- `waiting-level` for parked L2 work;
- `waiting-infra` for an infra incident.

The only reset is an L1 `report-only` item: it returns with `status: —`,
keeping its class, so L2 re-picks it. That reset never applies to a panel
item that ran at L1. When the firing ends, `## Now` holds exactly
`(empty)` (§8).

## 6 · Verify & commit (after a write-capable dispatch)

§6 starts once the dispatch's `check --after dispatch` printed
`"state": "ok"`; its other answers follow `references/clone.md`. The loop
never stages anything: `check` resets plain staging, and the commit is
built from the checked tree (step 4).

1. **Delegate-flagged check (first).** It fires when the delegate reported
   any judgment call, or skipped or flagged any spec item. For Codex, that
   means `loop-codex.mjs result` reported `flagged: true`. When it fires,
   do not verify. Run §7's **Save and reset** with `--why delegate-flagged`.
   Its step 2 does the rest, the entry first:
   1. Upsert a `## Needs decision` entry for the item, headed
      `### <id> · <title>` (it replaces any entry with this id), holding
      the questions and the delegate's suggested defaults (template
      format), each passed through `loop-text.mjs line` first, and the
      `**Recovery:**` line built from the save: its `sha`, `base`,
      `item_digest` and `scope.digest`. An `empty` save answers `base`,
      `item_digest` and `scope` too: write `none` in the sha's place, with
      its `base`, `item_digest` and `scope.digest`.
   2. Return the item to `## Backlog` with `status: waiting-decision`
      (Item edits).

   Record outcome `flagged`. A human fills `Decision:`, and §3.1 releases
   the item. The loop never answers a delegate's judgment call itself.
2. **Scope rail.**
   1. The touched paths come from the last `check`: `touched` is every path
      the attempt changed in `<W>` against its base (a delegate's commit is
      rewound first, so it cannot hide work), and `out_of_scope` names those
      outside `LOOP.md`'s `scope:`. A path under `.tech-lead/` inside `<W>`
      is always out of scope, and is never committed.
   2. If `out_of_scope` is not empty, nothing is committed. That is an
      attempt failure (§7); name the paths in the failure note. A
      `scope.state` of `invalid` puts every path out of scope: name
      `scope-invalid` too.
   3. In-scope paths the delegate did not report stay eligible. List them in
      `## Last run` as "unreported: …".
   4. Note in `## Last run` each `hidden` path ("hidden, not committed: …")
      and each rewound commit in `delegateCommits` ("delegate commit <sha12>
      rewound").
3. **Verify.** Run every `verify:` command inside `<W>`.
   - Run each command as a child of the firing lock, in a process group of
     its own. For the `verify:` item at index `<K>` (counting from 0), one
     foreground Bash call with `timeout: 600000`:

     ```
     node <T>/scripts/loop-lock.mjs exec <P> --generation <N> --label verify --cwd <W> --timeout-ms 540000 --verify <K>
     ```

     `--verify <K>` makes the wrapper read the command from `LOOP.md`
     itself, so never retype or quote a verify command. `--timeout-ms
     540000` ends the run, and kills its process group, before the Bash
     call's own limit: a Bash call that reaches its `timeout` is not
     killed but moved to the background, where it keeps running in `<W>`.
     If a Bash call is ever moved to the background, wait for its
     completion notification before you run any other `exec`, dispatch,
     or change to `<W>`. Its output passes
     through, and the last stderr line is
     `loop-lock exec: {"state": …, "exit": …}`. Judge by that `state`, not
     by the exit code alone (a command may exit 123, 124 or 125 itself):
     - `exited` with `exit` 0: the command passed. The line may carry
       `"lingering": true`: processes the command left in its process
       group were killed. `exited` with any other `exit` failed.
     - `not-holder` or `holder-gone`: the firing lost its lock (§1 step 3).
     - `lingering` (exit 123): a process of this firing outlived its
       command. Its process group survived the cleanup or its liveness
       could not be read (`left`), or a process still runs in `<W>`
       (`alive`, never signalled), or the check for one could not run.
       It is never a pass, whatever the command exited (`outcome` holds
       that). If `outcome.state` is `not-holder` or `holder-gone`, the
       firing lost its lock (§1 step 3). Otherwise it is an infra
       incident, never retried: run no other `exec` or dispatch and touch
       nothing in `<W>`. Write an incident to `## Last run` naming `left`
       and every process in `alive`, with this unpause check: "set
       `paused: false` once none of these processes runs". Set
       `paused: true`, return the item with `status: waiting-infra`, and
       record outcome `skipped`, note "exec lingering".
     - `timeout` (the run passed 540000 ms), `error`, anything else, or no
       such line: it failed.
   - After the last command, or the first that failed, check the clone
     again:

     ```
     node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after verify
     ```

   - If its `digest` differs from the previous check's, a verify command
     changed the work (a formatter, a generated file), the one that failed
     included: run every `verify:` command again from `<K>` = 0, then
     `check --after verify` once more, and apply the scope rail (step 2) to
     it. A second change is an attempt failure (§7), note "verify changed
     the work twice".
   - Any verify failure left after that is an attempt failure (§7). A
     `lingering` run is not one: it is the infra incident above.
4. **Commit.**
   - **All pass:**
     1. Write the commit subject, one line (the item's title), to
        `<S>/briefs/<id>.subject` with the Write tool.
     2. Commit, with `<digest>` from the last `check`:

        ```
        node <T>/scripts/loop-clone.mjs commit <P> --generation <N> --digest <digest> --subject-file <S>/briefs/<id>.subject
        ```

        It commits exactly the checked tree on the loop branch, with a
        `Tech-Lead-Item: <id>` trailer (the item `prepare` recorded from
        `## Now`) and a `Tech-Lead-Generation: <N>` trailer, no
        Co-Authored-By line, and your git identity, then writes the
        branch's delivery bundle.
        Project git hooks never run on loop commits (spec §7.6): a check
        that a hook enforces belongs in `verify:`.
     3. `"state": "committed"`: move the item to `## Done` with the `sha`
        (Item edits).
        Record outcome `done`, `verify: "pass"`, the `sha` in `commits`,
        and its `bundle` in the ledger entry's `bundles`. A `bundleError`
        goes into `## Last run`; the commit stands, and a later firing
        rewrites the bundle. A lock lost while the bundle is written is
        never a `bundleError`: it is exit 3 `not-holder`, a lost lock (§1
        step 3), and the next firing's planner finishes the commit.
     4. `"state": "unchanged"`: nothing changed. Record outcome `done`,
        `commits: []`, note "no changes needed". Move the item to `## Done`
        with `—` in the sha slot (Item edits).
     5. `out-of-scope` or `commit-failed`: an attempt failure (§7), with
        the `detail` as the failure excerpt. Any other refusal follows
        `references/clone.md`.

   Either way, trim `## Done` (Item edits, Trimming `## Done`): it keeps
   the 20 most recent items, and an older one only goes as a whole block
   once the ledger records it.

## 7 · Failure path

**Attempt failure.** An attempt fails on a verify failure, a scope-rail
violation, a verify run that changed the work twice, or a `commit` refused
with `out-of-scope` or `commit-failed`.

1. **First failure:** retry once with the same delegate. The retry brief is
   the original brief plus the verbatim failure excerpt. The retry works on
   top of the current tree, in the same attempt: never prepare the clone
   again. Run it as the first dispatch ran (a dispatch record, or Codex's
   start, wait and quiesce), run `check --after dispatch` once it is done,
   then return to §6.
2. **Second failure:** run Save and reset with `--why attempt-failed`, then
   Block.

**Save and reset** keeps an attempt's work in a recovery bundle, then
returns `<W>` to the loop branch's tip. It is the only way the loop discards
changes in `<W>`. The caller names `<why>`: `delegate-flagged` (§6),
`attempt-failed` (above), `codex` (§5) or `pause` (a `check` or `commit`
refused with `tampered` or `work-changed`).

1. **Save.** One foreground Bash call with `timeout: 600000`:

   ```
   node <T>/scripts/reflex-bundle.mjs save <P> --generation <N> --why <why> --item <id>
   ```

   `<id>` is this firing's item's id (a repeated save finds the item
   wherever step 2 put it). The save reads that item from `STATE.md` and
   records its id and digest in the bundle; both answers print them as
   `item_id` and `item_digest`.
   - `"state": "saved"`: `sha` names the bundle (64 hex digits). Note
     "saved <why> bundle <sha12> (<files> files, <out_of_scope> out of
     scope, <hidden> hidden)" in `## Last run`, from its `counts`, and add
     `{sha, why, files, out_of_scope}` (the counts) to the ledger entry's
     `saves`.
   - `"state": "empty"`: there was nothing to save. Do the caller's section
     move with `none` in the sha's place (step 2; a `**Recovery:**` line
     takes the empty answer's `base`, `item_digest` and `scope.digest`) and
     skip step 3; `check` or the next clone preparation resets a dirty
     index.
   - Exit 3 `not-holder`: the lock was lost (§1 step 3).
   - Any other answer (exit 3 `index-only`, `unsavable`, `too-large`,
     `tampered`, `head-moved`, `bad-item` (no item carries `<id>`, or
     several do), `digest-mismatch` and the like, or exit 2): reset nothing.
     Write the `detail` (and any `paths`, `largest`, `problems` or `procs`)
     as an incident in `## Last run`, set `paused: true`,
     return the item to `## Backlog` with its `status:` unchanged, record
     outcome `halted`, note "save failed", and stop the runner. The next
     clone preparation saves the work.
2. **Write the sha.** One Edit of `STATE.md` writes the full `sha` at the
   caller's place, and is the first Edit of the item's move (Item edits):
   the `## Needs decision` entry's `**Recovery:**` line, with the save's
   `item_digest` (`delegate-flagged`; the entry goes in before the item
   moves), the `recovery:` sub-bullet of the item's block as it is inserted
   into `## Blocked` (`attempt-failed`), or as it is inserted at the top of
   `## Backlog` (`codex`, `pause`), in place of any older one
   (`references/loop-templates.md`). The move then inserts the item if the
   entry went first, deletes it from `## Now`, and runs `check --item`.
3. **Reset.**

   ```
   node <T>/scripts/reflex-bundle.mjs reset <P> --generation <N> --sha <sha>
   ```

   - `"state": "reset"`: `<W>` is clean at the loop branch's tip.
   - `unsaved` (a path changed after the save): repeat from step 1 once;
     the new sha takes the old one's place.
   - `busy` (a process runs in `<W>`, listed in `procs`): reset nothing
     more. Write an incident naming the processes, with the unpause check
     "set `paused: false` once none of these processes runs", and set
     `paused: true`. The next clone preparation finishes the reset.
   - Exit 3 `not-holder`: the lock was lost (§1 step 3).
   - A second refusal, `tampered`, `index-locked`, `index-only`, any other
     refusal, or exit 2 (`"partial": true` included): write an incident
     with the `detail` and set `paused: true`. The item stays where step 2
     put it, and the next clone preparation finishes the reset from the
     run record.

**Touch-nothing pause.** These leave `<W>` exactly as it is, with no save
and no reset: a `check` or `commit` refused with `clone-invalid`,
`unsavable`, `index-only` or another state that `references/clone.md` pauses
on (`infra`, `unsafe-config` and the like); a Codex quiesce with
`"quiet": false`; an exec
`lingering`; a lock error after a dispatch; a reset refused with `busy`; a
failed save. Each follows its own step (`references/clone.md`, Refusals): an
incident, `paused: true`, the item back in `## Backlog`. The next clone
preparation saves what `<W>` holds.

**Block:** move the item to `## Blocked` (Item edits), in its header form with
`attempts: 2` and a one-line reason covering both attempts, keeping every
field line, and with its `recovery:` sub-bullet (Save and reset, step 2).
Record outcome `failed`, `verify: "fail"`.

## 8 · Report & runner handling

**Always,** in this order:

1. Update `## Last run`: timestamp, level, what happened, and the next
   planned action. Reset `## Now` to exactly `(empty)`: the recovery
   planner (§1 step 5) reads any other text there as an interrupted item.
   An item-edit incident (Item edits) is the one exception: it leaves
   `## Now` as it is.
2. Append exactly one ledger entry, even for failed or halted firings. Its
   `iteration` is `<N>`. Its `task`, `item_id` and `item_origin` are the
   picked item's title, id and `origin:` value, or null when nothing was
   picked. Its `done_items` is the `unledgered` list `pick` printed (§3
   step 2), whatever the outcome, a refusal's included (`[]` when it was
   empty; null when the firing never ran `pick`, or `pick` printed none,
   as with an exit 2): from then on the ledger
   keeps those items' ids and origins, which blockers read once `## Done`
   is trimmed. A firing that ended at the lock or lost the lock (§1 step 3)
   writes nothing; those are the only exceptions.
3. **Release the firing lock,** as the firing's last command. First close
   the firing's run records, which the work area keeps for recovery:

   ```
   node <T>/scripts/loop-clone.mjs close <P> --generation <N>
   ```

   It deletes the records that are settled and named in the ledger, and
   lists the rest in `kept` (reason `dirty` or `hidden`: the clone still
   holds files that the next clone preparation saves; reason `adopted`: the
   record that created the clone stays until the branches it adopted are in
   the ledger or the base). It quiesces Codex in
   `<W>` itself and reads `<W>` only when that is quiet, so it runs after a
   `"quiet": false` pause too (the record is then kept, reason
   `no-clone-facts`). Its `kept`, a `bundleError`, any other exit 3
   (`corrupt`, `clone-invalid`, `infra`) or an exit 2 go only into the
   summary: they write no second ledger entry and never block the release.
   Exit 3 `not-holder` is a lost lock (§1 step 3). Then release:

   ```
   node <T>/scripts/loop-lock.mjs release <P> --generation <N>
   ```

   - It stops any child of `<N>` still on record. It lists the
     children it stopped in `stopped`, and those it could not stop in
     `lingering` (the next acquire stops those again before it takes the
     lock). This firing's `codex` record belongs in `stopped`: the release
     quiesces `<W>` once more and removes it. Every other child should be
     gone by now, so any other `stopped` entry, or any `lingering` one, is
     a bug. Name it in the summary. It goes into no spine file, because
     the lock is no longer this firing's; the next firing notes in
     `## Last run` what its acquire stops.
   - Exit 3 with `"state": "dispatch-open"`: a dispatch record of `<N>` is
     still open, and nothing was released. Wait for that dispatch's result
     (completion rule below), close it with the printed `id`, then run the
     release again.
   - Exit 3 with `"state": "not-holder"`: the lock was lost (§1 step 3).
   - Exit 2 (`"state": "error"`, for example a `holder-unknown` detail):
     nothing was released. Run the release once more. If it fails again,
     name its `detail` in the summary and stop the runner: the lock stays
     held until this process ends, a later firing in it reclaims the lock,
     or the owner releases it.
   - After the release, only the runner handling below remains: no other
     command, and no write to `<S>` or `<W>`.

**Completion rule.** Every dispatch must COMPLETE inside the firing.

- Agent and Workflow results arrive as completion notifications. Wait for
  them before §6, then close their dispatch records (§1 step 3). Headless
  `claude -p` waits too. Never release with a dispatch record open.
- A Codex job is waited on with foreground `loop-codex.mjs wait` calls
  until its state is no longer `running`, then quiesced (§5).
- Never end the turn, call ScheduleWakeup, or exit while a dispatch is
  outstanding.
- Start Codex only through `loop-codex.mjs start`; never call the
  companion's `task` yourself. Never use `isolation: "remote"`.

**Runners:**

- **`/loop` dynamic mode.**
  - Work remains, the budget allows, and this firing had no infra
    incident; or the firing ended at the lock on transient contention (§1
    step 3) →
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

## Item edits

`loop-items.mjs` never writes `STATE.md`. `normalize`, `pick`, `followup` and
`trim` (and the recovery planner, for `clear-now`) print `edits`, a list of
`{old, new}` pairs, and `expect_sha256`, the SHA-256 of `STATE.md` once
every edit is applied in order.

- **Applying edits.** Apply them in the printed order, one Edit each, with
  `old` as the text to replace and `new` as its replacement, copied
  exactly. Each `old` occurs once in the file and is gone once its edit is
  applied, so an edit never applies twice. Then run
  `node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>`. Its
  exit 0 lists the `problems` a person made in `STATE.md`; they are
  reported, not failures.
- **Moving an item.** Every move of an item from one section to another in
  this skill and in `references/clone.md` (a return to `## Backlog`, a move
  to `## Done` or `## Blocked`, a recovery move) keeps the item whole and
  inserts before it deletes:
  1. If the item has an id, take its digest first. For this firing's item,
     it is the `digest` that `pick` printed, so a change made to the item's
     title, notes or decision during the firing fails step 4; for
     `finish-commit` it is `finish.item_digest`. For any other item (one an
     interrupted firing left in `## Now`, the other copy after `clear-now`),
     read it with `node <T>/scripts/loop-items.mjs digest <P> --item <id>`,
     which prints `item_digest`. That `<id>` comes from the planner's
     answer when it names the item (`clear.id`); otherwise (a `requeue-now`
     item, a recovery move after a planner exit 2) it is the value of the
     `## Now` item's `id:` line, written in lower case, as the helpers
     print ids (`digest` refuses an upper-case copy).
  2. One Edit inserts the whole block at its destination: the header line
     in that section's form (`references/loop-templates.md`) with the title
     unchanged, and every field line under it as it was (`id:`, `origin:`,
     `notes:`, `decision:`, the reserved labels and any other). A change
     the move makes (a `status:`, a `recovery:` line) goes into this
     insertion.
  3. A second Edit deletes the block from its source. An interruption
     between the two leaves two copies, never none, and the next firing's
     recovery planner clears the `## Now` copy (§1 step 5, `clear-now`);
     when the copies no longer match, it reports `now-conflict` and the
     loop pauses with both kept.
  4. Confirm it:
     `node <T>/scripts/loop-items.mjs check <P> --item <id>@<section>:<digest>`,
     with the digest from step 1 and `<section>` one of `Now`, `Backlog`,
     `Blocked` or `Done`. Exit 0 means the item sits in that section, once
     in the whole file, with that digest.

  An item with no valid id (one an older release left in `## Now`) moves
  without steps 1 and 4.
- **Trimming `## Done`,** after a move to `## Done` (§5 analysis, §6 step
  4), before §8's ledger append. Run
  `node <T>/scripts/loop-items.mjs trim <P>`, apply its `edits` in the
  printed order, one Edit each (Applying edits), then run
  `node <T>/scripts/loop-items.mjs check <P> --expect <expect_sha256>`,
  also when `edits` is empty. Any exit 3 or exit 2 from either is an
  item-edit incident (Incident). The trim keeps the 20 most recent items
  and, below them, every item the ledger does not record done yet (one
  `unledgered` names, one without a valid id), since `## Done` is then the
  only record of its id and its `loop from` origin and dropping it could
  release an item that waits on an ancestor. For the same reason it keeps
  every item whose origin lines are not exactly one well-formed `origin:`
  field (a capitalized `Origin:`, a second origin line, a value that is
  not `bootstrap`, `human`, `unknown` or `loop from <id>`): the ledger
  records one parsed origin, so the block stays the only full record of
  its parents. An item with no origin line at all may go.
- **Incident.** An exit 3 from `check` (`mismatch`: the file is not what the
  edits or the move should have left), and any other exit 3 or exit 2 from
  `loop-items.mjs` (`crlf`: `STATE.md` holds a carriage return;
  `now-occupied`, `bad-sections`, `bad-parent`, `bad-input`, `no-item`, or
  `"state": "error"`), and the recovery planner's `now-conflict` (§1 step
  5), is an incident. Write the printed `detail` (for `now-conflict`, the
  `conflict`), and any `mismatches` and `problems`, as an incident in
  `## Last run`. Set
  `paused: true`, dispatch nothing more, change nothing in `<W>`, record
  outcome `halted`, note "item edits", and go on to §8; then stop the
  runner. Change nothing else in `STATE.md`: §8 step 1 writes only
  `## Last run` and leaves `## Now` as it is, for the next firing's
  recovery planner. README's Troubleshooting has the owner's fix.

## Safety rails (absolute, all levels)

- Never push, create PRs, or merge the loop branch.
- **No destructive commands:** no `rm -rf`, no `git reset --hard`, no
  `--force`. A task that requires one becomes `blocked` with that reason.
- **No git in `<W>` except through the helpers:** `loop-clone.mjs`,
  `reflex-bundle.mjs`, and the read-only `loop-clone.mjs git` passthrough.
  Never run `git checkout -- …`, `git restore --worktree` or `git clean`
  in `<W>`: edits there are discarded only by Save and reset (§7).
- Files in the work area (`<W>`, run records, bundles) are created and
  removed only by the helper scripts.
- The loop never writes `<P>`'s tree or `.git` outside `<S>`, the one-time
  bootstrap (`references/bootstrap.md`: its `.gitignore` append and
  commit) aside.
- Modify files only under `scope:` paths in `<W>`, and in `<S>` (the
  bootstrap's `.gitignore` append aside).
- Spine updates are written to disk and never committed by the loop. The
  bootstrap commit is the only exception.
- **Foreign text is neutralized.** Text that a delegate, a panel seat, a
  verify command or other tool output wrote reaches `STATE.md` only through
  `node <T>/scripts/loop-text.mjs`: `line` for a field (one line, bold
  markers removed, `Decision:` and every item field label defanged) and
  `block` for longer text (every line quoted with `> `). Write the raw text
  to a file under `<S>/briefs/` with the Write tool, pass the file's path,
  and copy the output verbatim. A follow-up's title and notes go in a JSON
  file to `loop-items.mjs followup`, which neutralizes them itself (§5).
  Never put foreign text on a shell command line. If `loop-text.mjs` fails,
  write `(withheld: neutralizer failed)` in place of the text. Only a human
  writes a `**Decision:**` line.
