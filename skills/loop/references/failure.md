# Failure path

The loop reads this file before it acts on an attempt failure, a
delegate-flagged item (SKILL.md §6 step 1), a Codex outcome that names Save
and reset (`level3.md`), or any pause: it holds SKILL.md §7's procedures.
Placeholders are those of SKILL.md §1, and a § number or a section name
(Item edits) without a file name is SKILL.md's.

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
`attempt-failed` (above), `codex` (§5, `level3.md`) or `pause` (a `check` or `commit`
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
   caller's place, and is the first Edit of the item's move (Item edits;
   take the move's deletion, its step 2, before this Edit):
   the `## Needs decision` entry's `**Recovery:**` line, with the save's
   `item_digest` (`delegate-flagged`; the entry goes in before the item
   moves), the `recovery:` sub-bullet of the item's block as it is inserted
   into `## Blocked` (`attempt-failed`), or as it is inserted at the top of
   `## Backlog` (`codex`, `pause`), in place of any older one
   (`loop-templates.md`). The move then inserts the item if the
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
`unsavable`, `index-only` or another state that `clone.md` pauses
on (`infra`, `unsafe-config` and the like); a Codex quiesce with
`"quiet": false`; an exec
`lingering`; a lock error after a dispatch; a reset refused with `busy`; a
failed save. Each follows its own step (`clone.md`, Refusals): an
incident, `paused: true`, the item back in `## Backlog`. The next clone
preparation saves what `<W>` holds.

**Block:** move the item to `## Blocked` (Item edits), in its header form with
`attempts: 2` and a one-line reason covering both attempts, keeping every
field line, and with its `recovery:` sub-bullet (Save and reset, step 2).
Record outcome `failed`, `verify: "fail"`.
