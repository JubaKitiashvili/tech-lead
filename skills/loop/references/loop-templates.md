# Loop State Templates

These are the canonical formats for the `.tech-lead/` state spine. Bootstrap
copies them, and every other part of the loop reads and writes them. Do not
restate these formats elsewhere; link here.

## LOOP.md template

Replace the `<...>` values during bootstrap. The `verify:` commands are
detected from package.json scripts or the Makefile, then confirmed with the
user.

```yaml
---
pattern: backlog-executor
level: 1                 # 1 report-only | 2 mechanical-only | 3 full execution
paused: false            # any runner must exit immediately when true
max_iterations_per_day: 8
max_consecutive_failures: 2
branch_prefix: tech-lead-loop   # commits land on <prefix>/<YYYY-MM-DD>
base: <default branch>   # each day's branch starts here, or from the newest loop branch not merged into it
triage: shadow           # off | shadow (log the Haiku second check) | gate (apply it, escalate-only)
codex_timeout_min: 45    # an L3 Codex job still running after this many minutes is stopped
verify:
  - <detected verify command, e.g. npm test>
  - <detected verify command, e.g. npm run typecheck>
scope:
  - ./
push: never              # literal; v1 has no other value
---
```

A missing `triage:` key means `shadow`. Move to `gate` only after reviewing
at least 20 logged triage rows (see `../../../references/decision-contracts.md`,
Calibration). A missing `codex_timeout_min:` key means 45. A missing `base:`
key means the remote's default branch (`origin/HEAD`); with no remote default,
the firing stops with an infra incident asking for `base:`.

## STATE.md template

All six sections are always present, even when empty. The file is
human-editable: the user may reorder, add, or veto items directly (README,
"Items in STATE.md", has the format a person writes). It uses LF line
endings: every `loop-items.mjs` command refuses a file that holds a carriage
return (`crlf`).

```markdown
# <Project Name> — Loop State

## Now
(empty)

## Backlog
- [ ] P1 · <task title> · class: unclassified
  - origin: bootstrap
  - blocked-by: —
  - status: —
  - notes: <one line of context>

## Needs decision
(empty)

## Blocked
(empty)

## Done
(empty)

## Last run
(never run)
```

Bootstrap writes each initial item this way, with no `id:` line: the first
firing's `normalize` (loop §3) gives every item an id.

**`## Now`** holds the item a firing is working on, and exactly `(empty)`
otherwise: the firing resets it before it ends (loop §8), and the recovery
planner (loop §1 step 5) reads any other text there as an interrupted
item.

**`## Last run`** is rewritten by every firing (loop §8). Besides what
happened, it notes each recovery bundle the firing saved
(`saved <why> bundle <sha12> (<n> files, <k> out of scope, <h> hidden)`),
recovered work (a finished commit, a requeued item, a cleared interrupted
move, a rewritten delivery bundle), rewound delegate commits, hidden paths,
bundle errors, the ids `normalize` minted and the problems it reported, and
each item `pick` skipped, with its reason (loop §3).

### Items

An item is a header line at column 0 and the field lines under it.
`scripts/lib/loop-state.mjs` reads them, the one item grammar every helper
shares. The loop changes items only by applying the edits that
`loop-items.mjs` plans, and by the moves of loop "Item edits". A full item
in `## Backlog`:

```markdown
- [ ] P2 · <title> · class: hard · <one-line reason>
  - id: tl-<8 characters>
  - origin: human
  - blocked-by: tl-<8 characters>
  - status: —
  - notes: <context>
    <more context, indented two spaces deeper than the dash>
  - decision: <the owner's decision>
```

**Header forms,** one per section:

- `## Now` and `## Backlog`: `- [ ] P<n> · <title> · class: <class> · <reason>`.
  `P<n> · ` and ` · <reason>` are optional. A header without ` · class: `
  is all title, with class `unclassified`.
- `## Blocked`: `- [ ] <title> · attempts: <n> · <one-line reason>`.
- `## Done`: `- [x] <title> · <sha> · <YYYY-MM-DD>`, read from the right
  (date, then sha, then the title is the rest).

Every other line at column 0 in those sections is an `unparsed-line`
(`(empty)` and blank lines aside).

**Titles.** The title is the same text in every header form, so it survives
each move unchanged. A title that starts with `P<digits> · `, or contains
` · class: ` or ` · attempts: `, would not (`ambiguous-title`). Titles are
unique among open items (`## Now`, `## Backlog`, `## Blocked`), compared
after folding: compatibility forms and invisible characters folded away,
lower case, whitespace runs as one space. A `## Done` title may repeat any
title. Two open items with one title are `duplicate-title`, both parked;
the loop never renames a person's item. The loop refers to items by id,
never by title.

**Field lines** are `- <label>: <value>`, indented two to four spaces under
the header, in any order (the loop writes `id:` first and `origin:` second).
Values are trimmed. Only `notes:` and `decision:` take more lines: each
continuation line is indented at least two spaces deeper than the field's
dash, and a blank line ends the field. Any other line under an item (a tab
indent, a `*` or `+` marker, a capitalized label, markup around the label
such as `- **id:**`, a label without its colon such as `- id tl-…`, a line
under a one-line field, a line before the first field) is
`malformed-field`, and so is a field line at column 0 right below the item
(an outdented `- blocked-by:`), which joins the item; a field given twice
is `duplicate-field`. Either keeps the item from being picked
until a person fixes it. A lowercase label not listed below is kept and
never read.

**Item fields:**

- `id:` the item's stable id: `tl-` and 8 lowercase Crockford base32
  characters (digits and letters, without `i`, `l`, `o` and `u`). Only the
  loop mints ids; a person never types one. The value is compared
  case-insensitively, and `normalize` rewrites an upper-case id in lower
  case. A value of another shape (an empty or `—` one
  included), or two `id:` lines, is `invalid-id`; the same id on two items,
  in any sections (`## Done` included), or on an `id:` line of a block the
  loop cannot read or of a `##` section outside the six, is
  `duplicate-id`. Either parks
  every item concerned, and the loop never mints over an id.
- `origin:` ∈ `bootstrap | human | unknown | loop from <id>`: where the item
  came from. Bootstrap writes `bootstrap`, and a person may write `human`.
  `normalize` writes `unknown` on an item that has no `origin:` line, and a
  follow-up the loop creates (loop §5) gets `loop from <parent id>`. Any
  other value is `invalid-origin`: the item is parked, and every id in the
  value still counts as a parent for blockers.
- `class:` ∈ `mechanical | hard | high-stakes | unclassified`, written in
  the `## Now` and `## Backlog` header (` · class: <class>`), not as a
  sub-bullet. §4 appends a one-line reason after the class.
- `status:` ∈ `— | waiting-decision | waiting-level | waiting-infra`.
  - `waiting-infra` parks an item after an infra incident, such as Codex being
    unavailable. A human clears it.
- `blocked-by:` `—`, or one item's id: the item waits until that item is
  finished (loop §3). Any other value parks the item: a title
  (`title-blocker`; `## Last run` names the candidate id), an id that no
  item and no ledger row carries (`unknown-blocker`), or the item's own id
  (`self-blocker`). For `blocked-by:` and `status:`, an empty value, `—`,
  `-`, `--`, `none` and `n/a` (any case) mean none.
- `notes:` the context the work needs.
- `decision:` the owner's decisions, copied from `## Needs decision` by the
  release (loop §3). A later decision is appended as `<old>; then: <new>`,
  so no decision is ever erased.
- `attempts:` the number of attempts, written in the `## Blocked` header
  (` · attempts: <n>`).
- `recovery:` (optional) the full sha of the recovery bundle that holds the
  item's last saved attempt, after a `codex` or `pause` save (loop §7, Save
  and reset), or its second failed attempt in `## Blocked`. A later save
  replaces it.
- `decided:` reserved for the owner's signed decision stamp (a later
  stage). The loop never writes it, and moves it with the item.
- `no-change-ok:` reserved (a later stage). The loop never writes it, and
  moves it with the item.

The item digest covers the id, the title, the notes and the decision (an
absent or `—` value reads as empty), nothing else.
`node <T>/scripts/loop-items.mjs digest <P> --item <id>` prints it, and the
run record, the recovery bundle and the `**Recovery:**` line carry it.

**`## Done` item format:** `- [x] <title> · <sha> · <YYYY-MM-DD>`, then the
item's field lines, unchanged. Use `—` in the sha slot when `commits: []`.
The list is ordered newest-first: prepend each completion above the
previous one, so the trim (`loop-items.mjs trim`; loop, Item edits,
Trimming `## Done`) drops whole items from the bottom: each dropped item's
header and every field line under it. It keeps the 20 most recent items,
and below them only drops an item whose id the ledger already records
done. The ledger keeps each completed item's id and origin (its own entry,
or a later entry's `done_items`), so a blocker still reads a trimmed item
(loop §3); an item the ledger does not record yet stays in `## Done`, its
only record. So does an item whose origin lines are not exactly one
well-formed `origin:` field (a capitalized `Origin:`, a second origin line,
an `invalid-origin` value): the ledger keeps one parsed origin, so the
block stays the only full record of its parents.

**`## Blocked` item format:**

```markdown
- [ ] <title> · attempts: <n> · <one-line reason>
  - id: <id>
  - origin: <origin>
  - <every other field line the item had>
  - recovery: <64hex>
```

`## Blocked` is an open section: its items keep every field, count for
title uniqueness, and keep their dependents waiting. The `recovery:`
sub-bullet names the recovery bundle that holds the second attempt's work
(loop §7, Save and reset); it is `none` when that save found nothing to
keep.

**`## Needs decision` entry format:**

```markdown
### <id> · <title>
**Recommendation:** <one-sentence synthesis>
**Seat A (deep-reasoner · <opus|sonnet[, fallback]>):** <one line>
**Seat B (Codex · <model from ~/.codex/config.toml>):** <one line, or "seat empty — <unavailable | empty output | backgrounded | error>">
**Agreement:** <agree | disagree | single-seat | no-seats> — agreement is corroboration, not proof
**Decision:** (fill in to release the task back to the backlog)
```

A delegate-flagged entry (loop §6) uses the same heading and `Decision:`
line, with these fields:

```markdown
### <id> · <title>
**Flagged by:** <fast-worker | codex> — the delegate stopped on a judgment call
**Questions:** <each question> — suggested default: <delegate's default>
**Recovery:** <64hex> · base <oid> · item-digest <64hex> · scope <digest>
**Decision:** (fill in to release the task back to the backlog)
```

The heading's first token is the item's id; the title after ` · ` is for
display. Entries are keyed by id: the loop replaces an entry with the same
id and never appends a second one, and the release (loop §3) finds the item
by it. A heading whose first token is not an id is a legacy entry: the
release skips it, `## Last run` names the candidate id, and a person
rewrites the heading as `### <id> · <title>`. Until then the open item
whose title the heading names is parked as `legacy-entry` too, so it never
runs without that decision. The decision is the text
after `**Decision:**` on its line, plus the entry's following lines up to
the next line that starts with `**`.

The `**Recovery:**` line binds the entry to the recovery bundle that holds
the delegate's work (loop §7, Save and reset): the save's `sha`, its `base`
commit, its `item_digest` (the item's digest, from `--item <id>`) and its
`scope.digest`. When the save found nothing (`empty`), the sha's place holds
`none`, and the `base`, `item_digest` and `scope.digest` are the ones the
empty answer carries.

Every field a seat or a delegate wrote (the seat lines, the questions and the
suggested defaults) is passed through `loop-text.mjs line` before it is
written (loop Safety rails). No field can break the entry into new lines or
forge a `**Decision:**` line or an item field.

A warning line is added to the entry when the project tree changed during a
panel (loop §5):
`**WARNING:** project content changed during the panel — check before unpausing.`

Briefs and subjects are named by the item's id: panel briefs live in
`.tech-lead/briefs/<id>-panel.md`, Codex briefs in
`.tech-lead/briefs/<id>-codex.md`, commit subjects in
`.tech-lead/briefs/<id>.subject`, and an analysis's follow-up in
`.tech-lead/briefs/<id>-followup.json` (loop §5). The briefs folder is
gitignored at bootstrap, and the loop never commits it. The dependency
marker is `.git/tech-lead-deps.ok` inside the loop's clone, and only
`loop-clone.mjs` writes it (`clone.md` step 5).

## LEDGER.jsonl entry schema

Append one JSON object per line for every firing that acquired the firing
lock (loop §1 step 3) and kept it, whatever its outcome. Two firings write
nothing, not even an entry: one that ends at the lock (held, or a lock
error), and one that loses the lock (the owner or another firing took its
generation over while it ran). Those are the only exceptions:

```json
{"ts": "<ISO-8601 UTC>", "iteration": <int>, "task": "<title or null>",
 "item_id": "<id or null>", "item_origin": "<origin or null>",
 "class": "<final class or null>", "delegate": "<agent or null>",
 "outcome": "<done|failed|blocked|flagged|skipped|report-only|needs-decision|halted>",
 "verify": "<pass|fail|null>", "commits": ["<sha>"], "notes": "<one line>",
 "reason": "<one-line class/route reason or null>",
 "models": {"delegate": "<sonnet|opus|haiku|codex|null>"},
 "triage": {"mode": "<off|shadow|gate>", "orchestrator": "<class>", "checker": "<class|null>",
            "derived": "<class|null>", "signals": {…}, "checker_reason": "<string|null>",
            "agreement": "<agree|escalated|checker-lower|no-verdict>", "final": "<class>"},
 "panel": {"seat_a": "<opus|sonnet|null>", "seat_b": "<codex|empty>", "agreement": "<agree|disagree|single-seat|no-seats>"},
 "bundles": [{"branch": "<prefix>/<YYYY-MM-DD>", "tip": "<sha>", "file": "<path in the work area>", "sha256": "<hex>", "why": "<commit|regenerated>"}],
 "saves": [{"sha": "<64 hex>", "why": "<clean-clone|delegate-flagged|codex|attempt-failed|pause>", "files": <int>, "out_of_scope": <int>}],
 "recovered": {"generations": [<int>], "action": "<finish-commit|requeue-now|null>", "commits": ["<sha>"], "bundles": ["<64 hex>"], "task": "<the interrupted Now line or null>",
               "item_id": "<id or null>", "item_origin": "<origin or null>"},
 "done_items": [{"item_id": "<id>", "item_origin": "<origin or null>"}],
 "workflow_run_id": "<runId or null>"}
```

**Field rules:**

- `reason`, `models`, `triage`, `panel`, `bundles`, `saves`, `recovered`,
  `done_items` and `workflow_run_id` are null or absent when they do not
  apply. Older
  entries without them remain valid.
- `task` is the picked item's title, for people. `item_id` and
  `item_origin` are its id and its `origin:` value as written: the
  `title`, `id` and `origin` that `pick` printed (loop §3 step 2, §8);
  all three are null when nothing was picked. Older
  entries without `item_id` remain valid, but only an entry with one can
  finish a blocker (loop §3).
- `commits` holds only this firing's own commits. A commit an interrupted
  firing made goes into `recovered.commits`.
- `bundles` lists the delivery bundles this firing wrote: its commit's
  (`why: "commit"`), and each one rewritten by clone preparation or by the
  planner's `write-bundle` action (`"regenerated"`). `file` is relative to
  the work area (`~/.cache/tech-lead/<key>/`).
- `saves` lists every recovery bundle this firing saved, clone
  preparation's `clean-clone` saves included; `files` and `out_of_scope`
  are counts.
- `recovered` carries what the recovery planner (loop §1 step 5) found that
  no ledger entry named: the interrupted `generations`, the `## Now`
  `action` taken, their `commits` and recovery `bundles`, the
  interrupted `task` line, and that item's `item_id` and `item_origin` (as
  the planner printed them). A `clear-now` records `action` null: the item
  already sits where the interrupted move put it. A `now-conflict` is an
  incident that ends the firing before `ledger-recovered` is taken, so
  that entry's `recovered` is null and the next firing's planner reports
  the same commits and bundles again.
- `done_items` lists the `## Done` items that no earlier entry records
  done (`pick`'s `unledgered`, loop §3 step 2), each with its id and its
  `origin:` value as written: an item an interrupted firing moved to
  `## Done` before its append (one that `clear-now` left there included),
  or an item that a release before 0c-3 completed, and an item an earlier
  entry records done with another origin than its block holds now (a
  person edited the `origin:` line; the trim keeps the block until an
  entry records the origin as written). It is written
  whatever the outcome. Each entry counts as done for blockers, and its
  origin feeds the blocker walk, so the item may then leave `## Done`.
- `iteration` is the firing's lock generation `<N>` (loop §1 step 3). It
  strictly increases, and gaps are allowed: a firing that was interrupted
  before its append, or that lost its lock, leaves one. Acquire takes one
  more than the larger of the lock's last generation and the largest
  `iteration` here, so a lost lock directory never repeats a number.
- `delegate` is the literal string `"panel"` for panel firings (the
  `high-stakes` path that runs both seats).
- `triage.agreement` values:

  | Value | Meaning |
  |---|---|
  | `agree` | the checker's class equals the orchestrator's |
  | `escalated` | the checker's class is higher |
  | `checker-lower` | the checker's class is lower (never applied) |
  | `no-verdict` | the checker's output was missing or did not parse |

- **Circuit breaker.** It reads consecutive `failed` outcomes. `flagged` is
  not a failure.
- **Daily budget.** It counts today's entries (by `ts` date, UTC) whose
  outcome is `done`, `failed`, `blocked`, `flagged`, `report-only` or
  `needs-decision`. `halted` and `skipped` do not count.
- **Infra incidents** never retry in a loop. A missing Codex parks the item
  (`waiting-infra`). A dependency-install failure, a missing base, a clone
  that `loop-codex.mjs quiesce` cannot show quiet, an invalid or tampered
  clone, a save to a recovery bundle that failed, a git too old for the
  clone (`git-too-old`), a switch to today's branch that would overwrite
  ignored files, an `exec` run that left a process behind (`lingering`), or
  a lock error from `dispatch open` or `dispatch close` sets
  `paused: true`.

## Project .gitignore addition (bootstrap)

```
.tech-lead/worktree/
.tech-lead/briefs/
.tech-lead/worktree-deps.ok
```
