# Pick rules

The loop reads this file to explain a `skipped` row or a surprising pick:
these are the rules `loop-items.mjs pick` applies itself (SKILL.md §3 step
2). Placeholders are those of SKILL.md §1; §3.1 and §3.2 are the two parts
below, and any other § number, or a section name without a file name, is
SKILL.md's.

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
  without an id is skipped as `legacy-entry`, with the candidate id, and
  the open item its title names waits until a person adds the id (§3.2).
- A released item is the pick, if it is eligible (§3.2). Otherwise it waits
  in `## Backlog` with its status cleared, and the pick goes on with §3.2.

**3.2 · Otherwise, the first eligible `## Backlog` item,** from the top. An
item is eligible when all of these hold:

- it has a valid id that no other item carries, and a title that no other
  open item has (open: `## Now`, `## Backlog`, `## Blocked`);
- it has no item problem: a malformed or doubled field, an invalid origin,
  an ambiguous title, an origin cycle, or a `blocked-by:` that is not one
  known id (`loop-templates.md`, Items);
- no panel or delegate-flagged `## Needs decision` heading without an id
  names its title (`legacy-entry`): that entry's decision is never
  released, so the item waits until a person rewrites the heading as
  `### <id> · <title>`;
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
dependents while its follow-up is open. The waiting item itself, and the
items that descend from it, are left out of that walk: a follow-up
blocked by its own parent runs once the parent is done. Open, for this
test, also means an `id:` or `origin:` line under a `##` section that is
not one of the six, and a `- [ ]` line inside `## Done` (an item unticked
in place). A ledger entry without `item_id` never finishes a blocker.
