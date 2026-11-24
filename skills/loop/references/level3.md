# Level 3, `hard` items

The loop reads this file at SKILL.md §5 when a `hard` item runs at
`level: 3`: the analysis branch for an analysis-shaped item, the Codex
branch for an implementation-shaped one. Placeholders are those of SKILL.md
§1; step numbers are the Codex branch's own, and a § number or a section
name (Item edits) without a file name is SKILL.md's.

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
  1. Prepare the clone (`clone.md`).
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
     (`clone.md`, After every untrusted execution):

     ```
     node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after dispatch
     ```

     - **`final` is `completed`:** run
       `node <T>/scripts/loop-codex.mjs result <jobId> --cwd <W>`. Its
       `answer` is Codex's report, and `flagged: true` (the trailer is
       missing or is not `none`) makes the item delegate-flagged. Go to §6.
       If `result` exits 1, the report is unreadable: run §7's Save and
       reset (`failure.md`) with `--why codex`, return the item with
       `status: waiting-infra`, and record outcome `skipped`, note "codex
       result unreadable".
     - **Any other `final`:** run §7's Save and reset (`failure.md`) with
       `--why codex`, return the item with `status: waiting-infra`, and
       record outcome `skipped`, note "codex timeout" when the wait ended at `cap`, or
       "codex <final>" otherwise.

     Never retry while a Codex turn may still be live.
