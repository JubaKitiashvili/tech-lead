# Stage 0c-3 architecture brief: stable item ids, origins, unique open titles (v2)

Spec: `docs/superpowers/specs/2026-09-30-system1-layer-design.md` revision 7 (cited `spec:<line>`).
§10 row 0c-3 (spec:1084): "Stable ids, origins and unique open titles (§7.1; cx-lr07). Accepted
when: Item grammar and blocker tests pass." Base: main 0c4ad2d (0.5.0). Inputs: the reader reports
`.worktrees/_0c3-work/0c3-in-{spec,downstream,prose,code,design}.md`; the v1 review (Codex
`codex-brief-g1.md`, `codex-brief-g2.md`; Claude five-lens review with skeptics
`claude-brief-review.json`); prior non-binding design `0c-design-run.json`. v1 is kept as
`0c3-brief-v1.md`; section 11 maps every review finding to its disposition.

Audit cx-lr07 (P1, verified P2): "Task titles are used where unique identities are needed"; same
root as cx-lp11. Its core is SKILL.md §3.2: a blocker is finished when "the whole `LEDGER.jsonl`
has a `done` entry with exactly that task title", so a reused title, or an L3 analysis item moved
to `## Done` while its implementation follow-up is still open, releases dependents early.

Conventions (as 0c-2): Node 22 ESM `.mjs`, no npm dependencies; `node:test` + `node:assert/strict`;
tests `node --test "tests/**/*.test.mjs"`; checks `node scripts/check.mjs`. Helper CLIs print exactly
one JSON line and exit 0 (ok), 2 (`{state:'error', detail}`: usage, I/O), 3 (refused; `state` names
why; nothing changed). Code is ASCII. Work only in `.worktrees/`; the main checkout is the live
plugin install.

Not in 0c-3: `spine_version:`, the interactive-migration refusal and every interpretive legacy
rewrite (title blockers, legacy entry headings), spine untracking, the scope gates, the rest of
bootstrap (0c-4); `loop.class`, `reflex-report --mark`, the decided cap, chained ledger verification
(stage 1); the release-by-bundle path, acceptance and verify entries, `no-change-ok` honouring
(stage 3).

## A12. Amendment (spec revision 8; needs the owner's approval before the prototype)

§9.1 lists "assign stable ids and origins to items lacking them; the loop never picks an item
without an id" (spec:1025-1026) among the stage 0c migration steps, which run in an interactive
session (spec:997-998), and §10 gives those steps to 0c-4 (spec:1085). Read literally, 0c-3 ships
ids that no existing spine has until 0c-4's interactive migration: every existing backlog would read
"backlog dry" between the two merges. Both review families flagged that v1's R1 (assign ids in every
firing) changes that contract and needs this amendment (spec:1250-1251).

Proposed text, §9.1: "Assigning ids and origins needs no owner input, so it is not a migration step
from stage 0c-3 on: every firing fills them for items that lack them (an item with no `origin:` line
gets `unknown`), before the pick, through the same function 0c-4's migration calls. Anything that
interprets legacy text (a `blocked-by:` that holds a title, a `## Needs decision` heading that holds
a title) is never rewritten unattended: until the owner or 0c-4's interactive migration resolves
it, the item it touches is not picked and `## Last run` names it with the candidate id." §17 gains a
row. Alternative if refused: 0c-3 merges without a version bump and ships to users only together
with 0c-4 (no released interim).

## 0. Rulings (binding for the prototype; the plan records each with its cost)

**R1. Assignment (under A12).** `normalize` (§4) runs in every firing at the start of §3, after the
gates, under the lock. It mints an id for every item that has no `id:` line, in every section, and
writes `origin: <policy>` on every item that has no `origin:` line (with or without an id); the
policy is a parameter, `unknown` in 0c-3 (0c-4 may pass `human` on a versioned spine). It never
rewrites anything a person wrote: an existing id, origin, title or `blocked-by:` is only reported.
The loop never picks an item without a valid id. Cost if wrong: every item a person adds without an
`origin:` line reads `unknown` until 0c-4 (only the escalate-only `loop from` rule reads origin,
spec:684-685).

**R2. Ids.** An id is `tl-` plus 8 lowercase Crockford base32 characters (alphabet
`0123456789abcdefghjkmnpqrstvwxyz`, 40 bits): `ID_RE = /^tl-[0-9a-hjkmnp-tv-z]{8}$/`. Only the loop
mints them (`crypto.randomBytes`, redrawn while the id is known; known = every id in `STATE.md`,
items in every section and entry headings, and every `item_id` in `LEDGER.jsonl`); a person never
needs to type one and a hand-made id is `invalid-id`. One shape makes an id impossible to confuse
with a title (a review P1), and every consumer accepts it: no `/` (`decision_id`, spec:343, 478), no
`|` (spec:571, 576, 627), no `]` or whitespace (spec:612), no leading `-` (`--mark <item_id>`,
spec:706), lowercase (a path segment on case-insensitive volumes), printable ASCII
(`commitMessage`, scripts/loop-clone.mjs:316, tightens to ID_RE). A person copying an id is told:
an `id:` value is compared case-insensitively and rewritten to lowercase. Cost if wrong: an id
copied from an old ledger row onto a new item is not detected (it would have to be copied by hand
from the ledger).

**R3. Placement.** `- id: <id>` and `- origin: <origin>` are sub-bullets, written first and second
under the item's header line; the parser accepts any order. Header lines keep their current forms,
so `nowLine` and the run record's `now_sha256` are unchanged.

**R4. One grammar, owned by `scripts/lib/loop-state.mjs`** (§2). Every reader of `STATE.md` items
imports it: `loop-recover.mjs` (its private section and Done-sha readers move there),
`loop-clone.mjs`, `reflex-bundle.mjs`, the new `loop-items.mjs`; later 0c-4's migration and stage 1's
`reflex-facts.mjs` (spec:1075-1076).

**R5. Field lines.** Under an item header, a field is `^( {2,4})- ([a-z][a-z-]*):(?:[ \t](.*))?$`.
- Control fields (`id`, `origin`, `class`, `status`, `blocked-by`, `attempts`, `recovery`, `decided`,
  `no-change-ok`) are one line. Text fields (`notes`, `decision`) also take continuation lines: a
  line indented at least two spaces deeper than the field's dash, which is trimmed and joined with
  `\n`.
- Any other non-blank line under an item (a tab indent, a `*` or `+` marker, a capitalized label, a
  continuation under a control field, an indented line before the first field) is a
  `malformed-field` problem, and the item is not picked until a person fixes it.
- A control field given twice is `duplicate-field` (not picked). Unknown lowercase labels are kept
  and never affect eligibility.
- Values are trimmed. For `blocked-by:` and `status:`, an empty value, `—`, `-`, `--`, `none` and
  `n/a` (any case) mean none. An `id:` line with an empty or such value is `invalid-id`. For the
  digests, an absent or empty `notes`/`decision` and `—` read as `""`.
Cost if wrong: a person's near-miss formatting parks the item (with a `## Last run` note naming it)
instead of being read loosely.

**R6. Digests.** `itemDigest(item) = sha256Hex(canonicalJson({id, title, notes, decision}))`;
`approvedDigest(item) = sha256Hex(canonicalJson({title, notes, decision}))` (spec:686-688, 707), with
the R5 values, no Unicode normalization, `canonical.mjs` imported. Both are defined here, and
`releasedItem(state, entryId)` (the item as §3.1 would leave it, R16) is exported so stage 1's
`--mark decided` can compute the approved digest before a firing applies the release.

**R7. Titles.** `normTitle(t)` = the same fold `loop-text.mjs` uses (NFKC, Default_Ignorable code
points removed; one shared function, moved into `loop-state.mjs` and imported by `loop-text.mjs`),
then lower case, whitespace runs to one space, trimmed. Titles are unique among open items (`## Now`,
`## Backlog`, `## Blocked`, spec:681-682); a Done title may repeat any title. A collision a person
made parks every member (`duplicate-title`, a note naming the ids); the loop never renames a
person's item. A title the loop writes (a follow-up) that would collide gets ` (<its own id>)`.
A title that starts with `P<digits> · ` or contains ` · class: ` or ` · attempts: ` is
`ambiguous-title` (not picked), so a title survives every section's header form unchanged.

**R8. Id problems.** The same id on two items (any sections, `## Done` included) parks every carrier
(`duplicate-id`), except the interrupted-move copy in `## Now` (R14), which the recovery planner
resolves first. An id that fails ID_RE, or an item with two `id:` lines, is `invalid-id` (not picked,
never re-minted over). Reopening a done item is a move of its whole block, never a copy.

**R9. Origins.** `bootstrap | human | unknown | loop from <id>` (spec:675-677), one line. The loop
writes an origin only when it is missing (R1) or on a follow-up it creates (`loop from <parent>`). An
invalid value is `invalid-origin`: the item is not picked, and, for the blocker rule, every ID_RE
token in the raw value counts as a parent (a damaged `loop from` line still holds its parent).
`origin:` given twice: every value's parents count (and `duplicate-field` parks the item).

**R10. `blocked-by:`** holds `—` (none, R5) or one id. Any other value (a title, several ids, an
unknown id) parks the item: `title-blocker` when it is not an id (the note names the candidate id
when exactly one open item, or failing that exactly one `## Done` entry, has that `normTitle`, and
says "an analysis item; its follow-up may still be open" when that Done entry has `—` in its sha
slot), `unknown-blocker` when it is an id no item or ledger row carries, `self-blocker` when it is
the item's own id. The loop never resolves a title by itself (A12); a person replaces it with the
id. Cost if wrong: every legacy title blocker parks its dependent until a person writes an id (one
edit each, with the candidate printed).

**R11. The blocker test** (replaces SKILL.md §3.2's title test). Blocker id `B` is finished when all
hold: (i) no open item has id `B`; (ii) `B` is in `## Done`, or the ledger records it done (a row with
outcome `done` and `item_id` `B`, or a row whose `recovered.action` is `finish-commit` with
`recovered.item_id` `B`); (iii) no open item descends from `B`: for each open item, follow its
`loop from` parents (R9) through every known origin (open items, `## Done` entries, and the ledger's
recorded origins, R21) up the chain; if `B` is reached, `B` is unfinished. The walk keeps a visited
set: a cycle stops it, and the items on a cycle are parked (`origin-cycle`). Anything else is
unfinished. Ledger rows without `item_id` never satisfy a blocker. Cost if wrong: the transitive
reading holds a done item longer than the literal one-level reading of spec:684-685 would.

**R12. Lineage survives `## Done` trimming** because the ledger records each completed item's
origin (R21) and the walk reads it; `## Done` is trimmed to 20 as today. (v1's retention rule is
replaced: it missed a reopened item whose trimmed parent was itself done, a review P1.)

**R13. Pick in code.** `loop-items pick` (§4) applies §3.1 releases, then the §3.2 order, and returns
the item to work on, the edits, and every skipped item with its reason (the prose writes them to
`## Last run`). Eligibility: a valid id carried by no other item, a unique open title, no item
problem (R5, R7-R11), the status rule of today (`—`, or `waiting-level` when the current `level`
permits the class: `hard` needs `level: 3`; read with `loop-md.mjs`), and a finished blocker.

**R14. Edits and interruption.** Helpers never write `STATE.md` (spec:193). `normalize`, `pick` and
`followup` print anchored edits `[{old, new}]` plus `expect_sha256` (the SHA-256 of the file once
all edits are applied in order).
- Each `old` occurs exactly once in the text it applies to, and no longer occurs once its edit is
  applied (an anchor includes the line after an insertion point), so an edit cannot apply twice. The
  planner widens an anchor with preceding lines until it is unique; the section heading is unique,
  so an anchor always exists.
- Insertions come before deletions and before anything that refers to them: a move inserts the
  block at its destination first, then deletes the source. An interruption between the two leaves
  two copies, never none. The only such pair the loop makes involves `## Now` (pick: Backlog to Now;
  the prose's Now to Done, Now to Blocked, Now back to Backlog), and the recovery planner resolves it
  (R20: `clear-now`).
- The main session applies the edits with Edit, in order, and runs `loop-items check <P> --expect
  <sha>`. A mismatch is an incident: the firing writes the problems to `## Last run`, sets `paused:
  true`, appends its ledger entry (outcome `halted`), changes nothing else in `STATE.md`, and releases
  the lock as usual; the next firing's planner handles whatever `## Now` holds (README row "STATE.md
  does not match the planned item edits").
- The prose moves at the end of a firing (to `## Done`, `## Blocked`, a requeue, a recovery move)
  insert first, keep the whole block (every field), and are followed by `loop-items check <P> --item
  <id>@<section>:<digest>`, which confirms the item now sits in that section, once, with that
  `itemDigest`. A failure is the same incident.
- A `STATE.md` holding a carriage return is refused (`crlf`) by every command (README row: convert
  the file to LF line endings).
Cost if wrong: a mis-applied Edit pauses the loop until the owner looks.

**R15. `## Needs decision` entries** are keyed by id: `### <id> · <title>`, the title for display.
A heading whose first token is not an ID_RE id carried by an item is `legacy-entry` (the note names
the candidate id when exactly one item has that `normTitle`); the release skips it, and a person
rewrites the heading (A12). `Entry` carries a `variant` (`panel` when it has a `**Recommendation:**`
line, `delegate-flagged` when it has a `**Flagged by:**` line, otherwise `other`) and the parsed
`**Recovery:**` tuple `{sha, base, itemDigest, scope}`; the 0c release handles only `panel` and
`delegate-flagged` and leaves `other` (stage 3's acceptance and verify) untouched. Upserts (§5,
§6.1) replace an entry with the same id.

**R16. §3.1 release** (inside `pick`). For each `panel` or `delegate-flagged` entry whose
`**Decision:**` is filled (today's rule), by heading id:
- The decision is the text after `**Decision:**` on its line plus the following lines of the entry
  up to the next line that starts with `**` or the entry's end, joined with spaces.
- The item with that id in `## Backlog` or `## Blocked` gets `decision:` set to it, or, when it
  already has one, `<old>; then: <new>` (a later decision never erases an earlier one, a review
  finding); its `status:` is cleared and its class set to `hard`; a `## Blocked` item moves to the top
  of `## Backlog`. Then every entry for that id is deleted (item edits first, so an interrupted
  sequence never loses the decision).
- No item with that id: the release refuses to guess (a review P1 showed recreation drops the
  item's `blocked-by:` and origin): `orphan-entry` (an id found nowhere) or `entry-item-done` (the id
  is in `## Done`); the entry stays and `## Last run` names it.
- The prose keeps today's rule that it may lower `hard` to `mechanical` only when the decision fully
  specifies the work (one Edit before §4).

**R17. Follow-up.** The main session writes the analysis's follow-up as JSON `{title, notes}` to
`<S>/briefs/<parent id>-followup.json` with the Write tool (foreign text never goes into a shell
command; the Safety rails), then runs `loop-items followup <P> --parent <id> --input <file>`, which
prints the edit inserting at the top of `## Backlog` a new item: minted id, `origin: loop from
<parent>`, `class: unclassified`, `status: —`, `blocked-by: —`, title and notes through
`loop-text.mjs`'s line neutralizer, the R7 suffix on a collision. Idempotent: when an open item with
`origin: loop from <parent>` has the same base title (its stored title with its own ` (<id>)` suffix
removed, compared by `normTitle` against the neutralized request), it prints no edit and returns
that id.

**R18. The item digest reaches the recovery bundle.** `reflex-bundle.mjs save --item <id>` reads
`<S>/STATE.md` through `loop-state.mjs` and needs exactly one item carrying that id (a valid id, any
section, the `## Now` item usually); eligibility does not matter (a save must keep working while a
person edits the backlog). It writes `item_id` and `item_digest` into the bundle header. An id that
no item, or several, carry refuses `save` (`bad-item`, nothing written). On `save`, `--item-digest`
is accepted only with `--item` and must equal the computed digest; alone it is a usage error.
`apply` keeps `--item-digest` (stage 3). Header validation: `item_id` is ID_RE or null, and
`item_id`/`item_digest` are both set or both null. The `## Needs decision` Recovery line writes the
digest instead of `none`.

**R19. Run record v:2** adds `item_id` and `item_digest`, set by `prepare` from the `## Now` item (no
new flag); `commit` passes `item_id` to `commitMessage` (the `Tech-Lead-Item:` trailer). v:1 records
(an interrupted 0.5.0 firing) are read as `item_id: null` and updated in place as v:1; new records
are v:2.

**R20. The recovery planner.**
- `finish-commit` needs the `## Now` item's `item_id` and `itemDigest` to equal the record's, and
  `now_sha256` to match; any difference requeues (`requeue-now`); a v:1 record uses `now_sha256` alone
  (a review P1: an owner who amends an interrupted item's notes must not see the old commit finish
  the new requirement).
- `clear-now`: when the `## Now` item's id is also carried by exactly one item in another section,
  the firing was interrupted inside a move (R14), and the other copy is the item: the planner reports
  `clear-now`, and the prose replaces `## Now` with `(empty)`. This runs before `finish-commit` and
  `requeue-now`.
- The Done-sha check reads only the Done header's sha slot (the header is split from the right:
  date, then sha, then the title is the rest).

**R21. Ledger.** Every row gains `item_id` and `item_origin` (the item's origin when the row is
written; null when nothing was picked) next to `task`, which stays a display title; `recovered` gains
`item_id` and `item_origin`. `scripts/lib/ledger.mjs` exports `ledgerItems(S) -> {ids: Set, doneIds:
Set, origins: Map<id, origin>}` (ids from rows and `recovered`; done from R11 (ii); the latest origin
per id). Stage 1 constraint, recorded: once the ledger moves into delegate-writable `<V>`, blockers
read it only after chain verification.

**R22. Field labels.** `FIELD_LABELS` in `loop-state.mjs` = `id, origin, class, status, blocked-by,
notes, decision, attempts, recovery, decided, no-change-ok`; `loop-text.mjs`'s `LABEL` is built from
it. `decided` and `no-change-ok` are reserved: parsed, moved with the item, never written by the 0c
loop, outside both digests.

**R23. Briefs and subjects are named by id**: `<S>/briefs/<id>-codex.md`, `<id>-panel.md`,
`<id>.subject`, `<id>-followup.json` replace `<slug>` (SKILL.md, loop-templates.md,
references/panel-protocol.md).

**R24. The brief carries the decision** (spec:678-679): §5's briefs include the title, the notes and,
when not empty, the decision under its own label. The triage second check still gets only the title
and notes (spec:677).

**R25. Bootstrap writes `- origin: bootstrap`** on each initial item (bootstrap.md step 4); no ids
(the first firing mints them). Every other bootstrap change is 0c-4's.

**R26. `loop-md.mjs` gains `frontScalar(text, key)`** (the owner of LOOP.md front matter); `pick`
reads `level` with it.

## 1. Ownership map

| Concern | Owner | Imports it |
|---|---|---|
| Item grammar, ids, origins, titles, fold, digests, blockers, eligibility, edit planning | `scripts/lib/loop-state.mjs` (extend) | loop-items, loop-recover, loop-clone, reflex-bundle, loop-text; 0c-4; stage 1 |
| Ledger ids, done ids, origins | `scripts/lib/ledger.mjs` (`ledgerItems`) | loop-items, loop-recover |
| LOOP.md scalars | `scripts/lib/loop-md.mjs` (`frontScalar`) | loop-items |
| Item CLI (read-only) | `scripts/loop-items.mjs` (new) | SKILL.md prose |
| Bundle header item fields | `scripts/reflex-bundle.mjs` (`save --item`) | prose |
| Run record item fields | `scripts/lib/run-record.mjs` (v:2) | loop-clone, loop-recover |
| Commit trailer, prepare item | `scripts/loop-clone.mjs` | prose |
| Planner rules | `scripts/loop-recover.mjs` | prose |

## 2. scripts/lib/loop-state.mjs (extend; keeps `export const PLACEHOLDER = '...'`, which checks/loop.mjs reads, and `nowLine`)

- `parseState(text) -> {sections, items, entries, problems}`; refuses a text holding `\r`
  (`{problems:[{kind:'crlf'}]}`, nothing else parsed). Sections: `## <Name>` to the next `#`/`##`
  heading (the `nowLine` end rule). Headers (column 0): `## Now`/`## Backlog`:
  `- [ ] (P<n> · )?<title> · class: <class>( · <reason>)?`, split at the first ` · class: `, a header
  without it is a title with class `unclassified`; `## Blocked`: `- [ ] <title> · attempts: <n> ·
  <reason>`, split from the left at the first ` · attempts: `; `## Done`: `- [x] <title> · <sha|—> ·
  <YYYY-MM-DD>`, split from the right. Any other column-0 list line is `unparsed-line`; `(empty)` and
  blank lines are ignored. `Item = {section, line, header, title, priority, class, reason, attempts,
  sha, date, id, origin, originParents, status, blockedBy, notes, decision, recovery, decided,
  noChangeOk, fields, problems}`. `Entry = {line, id, title, legacy, variant, decision, filled,
  recovery}`.
- `FIELD_LABELS`, `ID_RE`, `mintId(known, rng = crypto.randomBytes)`, `parseOrigin(s) -> {kind,
  parent} | null`, `fold`, `normTitle`, `itemDigest`, `approvedDigest`, `releasedItem`, `nowItem(text)`.
- `itemProblems(state, ledger)` and `eligibility(state, {ledger, level}) -> [{id, title, ok,
  reason}]`, reasons: `no-id`, `invalid-id`, `duplicate-id`, `duplicate-title`, `ambiguous-title`,
  `malformed-field`, `duplicate-field`, `invalid-origin`, `origin-cycle`, `title-blocker`,
  `unknown-blocker`, `self-blocker`, `blocked`, `status`, `unparsed-line`.
- `blockerStatus(state, id, ledger) -> 'finished' | 'unfinished' | 'unknown'` (R11).
- `planNormalize(text, {known, missingOrigin = 'unknown'})`, `planPick(text, {ledger, level})`,
  `planFollowup(text, {parent, title, notes, known})`, each `-> {edits, expect_sha256, ...}`;
  `applyEdits(text, edits)` (the one implementation the CLI and tests use; refuses an `old` that is
  not unique or that survives its edit).

## 3. scripts/lib/ledger.mjs, scripts/lib/loop-md.mjs (extend)

`ledgerItems(S)` (R21); `frontScalar(text, key)` (R26). Existing exports unchanged.

## 4. scripts/loop-items.mjs (new; read-only; never writes anything)

`node <T>/scripts/loop-items.mjs <command> <P> ...`, one JSON line, exit 0/2/3. Reads `<S>/STATE.md`,
`<S>/LOOP.md` and `<S>/LEDGER.jsonl` (paths from `loop-paths.mjs`). Every command exits 3 `crlf` on a
carriage return.
- `normalize <P>` → `{state:'ok', edits, expect_sha256, minted:[id], origins:[id], problems}`.
- `pick <P>` → `{state:'picked', id, title, from:'decision'|'backlog', digest, released:[id], edits,
  expect_sha256, skipped:[{id, title, reason, detail}]}`, or `{state:'dry', ...}`.
- `followup <P> --parent <id> --input <file>` → `{state:'ok', id, reused, edits, expect_sha256}`; exit
  3 `bad-parent` or `bad-input`.
- `digest <P> --item <id>` → `{state:'ok', id, item_digest, approved_digest}`; exit 3 `no-item`.
- `check <P> [--expect <sha>] [--item <id>@<section>:<digest>]` → exit 0 `{state:'ok', problems}`
  (problems a person made are reported, not failures); exit 3 `mismatch` (with what differs).

## 5. Changes to merged modules

- `scripts/loop-text.mjs`: imports `fold` and `FIELD_LABELS`; `LABEL` built from it (R7, R22).
- `scripts/reflex-bundle.mjs`: `save --item <id>`; header checks (R18).
- `scripts/lib/run-record.mjs`: v:2 with `item_id`, `item_digest`; v:1 read and updated as v:1 (R19).
- `scripts/loop-clone.mjs`: `prepare` records the Now item's id and digest; `commit` passes the id to
  `commitMessage`, which validates ID_RE (R19).
- `scripts/loop-recover.mjs`: readers from `loop-state.mjs`; R20's rules; `recovered.item_id` and
  `item_origin` in its report.

## 6. Prose (SKILL.md, references/loop-templates.md, clone.md, bootstrap.md, panel-protocol.md, README.md)

- §1 step 5: `clear-now` before the other recovery actions; recovery moves insert first and keep the
  whole block, then `check --item`.
- §3: step 0 `normalize` + Edit + `check --expect`; then `pick` + Edit + `check --expect`; the skipped
  reasons go to `## Last run`; delete "exactly that task title"; the §3.1/§3.2 rules in plain words.
- §4/§5: the L3 analysis follow-up through the JSON file and `followup` (R17); the ledger note names
  ids ("analysis → <follow-up id>"); briefs by id (R23); the brief carries the decision (R24).
- §5 panel and §6.1 delegate-flagged entries: `### <id> · <title>`, upsert by id (R15).
- §6/§8: moves insert first, keep whole blocks, and are checked (R14); ledger rows carry `item_id`
  and `item_origin` (R21).
- §7 Save: `--item <id>` (R18); the Recovery line's digest.
- Templates: Backlog, Done, Blocked and Needs decision formats with `id:`, `origin:`, `decision:`, the
  reserved labels, the none spellings; the ledger schema with `item_id` and `item_origin`.
- bootstrap.md step 4: `- origin: bootstrap` (R25).
- README: the item format a person writes (no id; `origin: human` optional; `blocked-by:` takes an
  id, the candidate printed in `## Last run`), and troubleshooting rows: each park reason, the R14
  incident, `crlf`.

## 7. Checks (scripts/checks/loop.mjs; each with a mutation test)

1. The STATE.md template in loop-templates.md parses with `parseState` with no problems.
2. Every FIELD_LABEL is documented in loop-templates.md.
3. The `## Needs decision` heading template is `### <id> · <title>`.
4. No prose says a blocker is finished by title ("exactly that task title" and similar).
5. The Save command in SKILL.md §7 passes `--item <id>`.
6. SKILL.md §3 runs `normalize`, applies the edits and runs `check --expect` before `pick`, and runs
   `check --expect` after `pick`'s edits.
7. The follow-up reaches `followup` through `--input <file>`, never through a title argument.

## 8. Tests ("item grammar and blocker tests", spec:1084)

Grammar: template round-trip; every header form; Done split from the right; titles with ` · `; R5's
field rules (continuations only under text fields; each malformed form; duplicate control fields;
the none spellings; `id:` empty or `—`); `unparsed-line`; `crlf`; entries (id headings, legacy
headings, variants, the Recovery tuple, the decision extent); a title survives Backlog → Now → Done
unchanged; `ambiguous-title`.
Ids: ID_RE; `mintId` with an injected rng (redraw on known, ledger ids included; 10,000 unique
mints); a hand-made id is `invalid-id`; an upper-case copy is rewritten to lowercase; duplicate ids
across sections park every carrier.
Origins: the four forms; missing origins filled with the policy (with and without an id); an invalid
origin parks the item and still holds the parents its tokens name; a doubled origin.
Titles: `normTitle` agrees with `loop-text`'s fold on Default_Ignorable input; duplicate open titles
park every member; a Done title may repeat; the follow-up suffix.
Digests: stable under key order; each of id/title/notes/decision changes `itemDigest`; the id does
not change `approvedDigest`; `releasedItem`'s digest equals the item's after the release.
Blockers: finished via Done; via a ledger done row; via a `recovered` finish-commit; unfinished while
open in each open section; a done blocker with an open `loop from` child in each open section; the
chain through a Done follow-up; the chain through ledger origins after a trim; the reopened
grandchild case (P → F → G done, F trimmed, G reopened: P unfinished); a cycle parks its members and
terminates; legacy ledger rows never count; cx-lr07 (a reused title never finishes a blocker); cx-lp11
(two items with one title keep separate identities); title, unknown and self blockers with their
notes and candidates (including the analysis hint).
Normalize: mints ids and origins in every section; never rewrites a person's id, origin, title or
blocker; idempotent; insertions anchored so that a second application fails; byte-identical
id-less blocks get unique anchors; `expect_sha256` equals the applied text's hash.
Pick: decided entries first, then Backlog top-down; each park reason; waiting-level by level; the
release (decision extent, append with `; then:`, status cleared, class hard, a Blocked item moved
back, entries deleted after the item edits, `orphan-entry`, `entry-item-done`, `other` variants
untouched); never picks an id-less item; `dry`; insert-before-delete order.
Interruption: after each edit of a pick, of a release and of each prose move, the next firing's
planner and `pick` neither lose nor duplicate the item (`clear-now`).
Follow-up: input file; neutralized title and notes; origin; suffix; idempotent after a suffixed
creation.
Integration: `check --expect` and `check --item` mismatches exit 3; `reflex-bundle save --item` (header
fields, exactly-one-carrier rule, `--item-digest` agreement and its usage error); run record v:2
written, v:1 read and updated as v:1; the `Tech-Lead-Item:` trailer; R20's finish rule (all three
match → finish; notes amended → requeue; v:1 → hash only) and `clear-now`; `loop-text.mjs` defangs
every FIELD_LABEL; the fixtures (`tests/loop/interrupt-fixture.mjs`, `tests/fixtures/firing-driver.mjs`,
`tests/loop/loop-recover.test.mjs`, `tests/lib/loop-state.test.mjs`) write items with ids, and the
firing driver runs `normalize`, `pick`, `followup` and `check` through the CLI as the prose does.

## 9. Residual risks (named in the plan)

A delegate can edit ids, origins and `blocked-by:` before stage 2 (spec:1214-1217; deleting a
`loop from` origin releases dependents early); an id copied by hand from an old ledger row onto a new
item is not detected (R2); legacy title blockers and headings park their items until a person
writes the id (R10, R15); legacy analysis/follow-up pairs carry no `loop from` link, so a person who
points a dependent at the analysis item's id releases it (the note warns); random ids are less
memorable than titles; case-folded title comparison; the ledger is trusted for done ids and origins
until stage 1 chain-verifies it.

## 10. For later stages

0c-4: its migration calls `planNormalize` (with `missingOrigin: 'human'` on a versioned spine if it
chooses) and resolves legacy title blockers and headings interactively, using the candidates
`itemProblems` reports; bootstrap writes items through the grammar. Stage 1: `reflex-facts.mjs`
parses items with `parseState`; `--mark decided <item_id>` stores `approvedDigest(releasedItem(...))`;
journal `item_id`s join R2's known set; blockers read the ledger after chain verification. Stage 3:
the release compares `itemDigest` before any decision is copied; acceptance and verify entries are
`variant: 'other'` to the 0c release and get their own handler.

## 11. Review dispositions (v1 → v2)

Fixed in v2: Codex g1 #1, #2 (R2, R10), #3 (R12, R21), #4 (R5, R9), #5 (R14), #6 (A12), #7 (R2), #8
(R1), #9 (R7), #10 (R15), #11 (R21); Codex g2 #1 (R14, R20), #2 (R16), #3 (R19, R20), #4 (R17), #5
(R2, R15), #6 and Claude F4/E13/DS2 (R18), #7 and Claude LR07-5 (R21), #8 and Claude DS5 (R21);
Claude F1/HE-10 (R10 analysis hint, residual), F2 (A12), F3 (R16 append), F5/LR07-6/DS12 and F11
(R16 no recreation), F7/HE-6/LR07-9/DS11 (R2 single shape), F8/LR07-7/DS9/E10 (R17), F9/LR07-8 (R11
cycle), F10/DS8 (R18), HE-1/E1 and HE-2/DS4 (R5), HE-3 (R17 input file), HE-4 (R16 extent), HE-5 (R5
none spellings), HE-7 (R14 --expect), HE-8 (R14 anchors), HE-11/E5 (R14 crlf), HE-12 (R7 shared
fold), HE-13 (§2 right split), LR07-1 (R10: no title resolution), LR07-3 (§6 §1 step 5), LR07-4/E6
(R14 check --item), E2 (R14, R20 clear-now), E3 (R14 order), E4 (R14 non-reapplicable), E8 (R14
incident path), DS1 (R6 releasedItem), DS3 (R19), DS6 (R21), DS7 (R26), DS10 (R5).
Dropped by the skeptics (not acted on): F6, HE-9, HE-14, LR07-2 (a duplicate of F1), E7, E9, E11, E12.

## Addendum 1 (2026-10-04): rulings from the prototype review

## New rulings (binding for this pass; the plan records them with their cost)

**R27. Every completion reaches the ledger before `## Done` can lose it.** A firing interrupted after
its move to `## Done` and before its ledger append (or a `clear-now` that ends such a move, or an
analysis item, which has no run record) leaves `## Done` as the only record, and a later trim then
drops its id and its `loop from` origin, so an ancestor reads finished while a descendant is open
(Codex g2#1, g3#1; Claude LR07-B, EP3, merged-cli-1; integration open #0). Rule: `pick` (and its
`dry` answer) returns `unledgered: [{item_id, item_origin}]`, the `## Done` entries whose id
`ledgerItems` does not record as done; the firing's ledger row carries them as `done_items` (written
whatever the outcome); `ledgerItems` counts `done_items` as done and takes their origins. The §8 trim
never drops an entry that is unledgered at the time of the trim. Pre-0c-3 Done entries get recorded
once, with their (minted, `unknown`) origin. Cost if wrong: one extra field per ledger row.

**R28. Open copies count even when they do not parse.** The blocker test reads every id token on an
id-like line (an `id` label in any case or indent, a `- [x]` header's line block, an unparsed or
malformed block) inside `## Now`, `## Backlog` and `## Blocked` as an open carrier, and every token
on an origin-like line as a parent; a blocker with such a carrier is unfinished, and the carrier's
own item stays parked (Claude LR07-A; Codex g1#1, g2#2). `digest` and `check --item` refuse an id
with more than one carrier, raw carriers included. The README's reopen instruction says to rewrite
the header to the Backlog form (`- [ ] <title> · class: <class>`), keeping every field line. Cost if
wrong: a stray id token in an open section holds its item's dependents until a person fixes it.

**R29. `clear-now` only for identical copies of one item.** The planner reports `clear-now` only when
`## Now` holds exactly one item block, its id is carried by exactly one item in another section, and
both copies have the same `itemDigest`; otherwise (copies differ, `## Now` holds several items) it
reports `now-conflict` with the details, and the prose treats it as the item-edit incident (pause,
both copies kept). The prose deletes only that item's block from `## Now` (an anchored deletion
printed by the planner), never the whole section (Codex g2#3, g2#4; Claude EP2).

**R30. Release fixes.** A release appends a missing `decision:` line at two spaces after the item's
last field line, outside any continuation (Codex g1#2); recognizes an already-applied decision
sequence, including a remaining suffix after a partial entry deletion, before appending (Codex
g1#3); refuses an item with `ambiguous-title` (entry kept, `## Last run` names it) (Codex g1#4).

**R31. Normalize never mints over a person's lookalike.** An item with an id-like or origin-like line
that is not a well-formed field (a tab indent, `* id:`, `- ID:`, `- id :`) is reported `malformed-field`
and gets no minted id or origin (Claude PARSE-1). A column-0 `# ` heading inside an item section is a
`stray-heading` problem (the items under it still parse in their section) rather than a silent section
end (Claude PARSE-3). Deletion anchors include the line after the block, so a line a person appended
to the block between plan and apply makes the Edit fail (`old` not found) instead of leaving a stray
line (Claude EP1).

**R32. Bootstrap keeps known dependencies.** Bootstrap writes a known prerequisite as
`blocked-by: <its title>` (R10 parks the dependent until the owner writes the id; the candidate is
printed); it never blanks a dependency (Codex g3#2). Its only other 0c-3 change is `origin: bootstrap`
(R25).

**R33. Clean-clone saves carry the interrupted item.** prepare's clean-clone save passes the
interrupted run record's `item_id`/`item_digest` when that record is v:2 (Claude merged-cli-2).

## Prose fixes

- §5 follow-up: both `reused: true` and `reused: false` answers are success; apply and check the edits
  when there are any; only refusals and errors are the incident (Codex g3#3).
- §1 step 5: `clear-now` deletes the planner's anchored block; `now-conflict` is the incident (R29).
- §8: the ledger row's `done_items` from `pick`'s `unledgered`; the trim keeps unledgered entries and
  trims whole blocks (header and field lines) (R27; Claude PDC-2).
- Item edits step 1: say where the id for "any other item" comes from (the planner's answer or the
  Now item's `id:` line) (Claude PDC-3).
- README: reopen = rewrite the header to the Backlog form (R28); bootstrap dependencies (R32).
- checks/loop.mjs: the cx-lr07 check must not skip a sentence just because it holds a negation; it
  looks for the title-based finishing phrases themselves (Claude PDC-1).

## Tests to add (each failing first)

LR07-A reopen (Done header kept in Backlog) and its variants (damaged id line, `- [x]` follow-up,
`Origin:` capitalized); Codex g1#1 doubled id; Codex g2#2 two ids; the R27 chains (P → F → G with F's
interrupted Done move and a trim; analysis read-only path through the driver, Codex g3#1); clear-now
with amended Now copy and with two Now items; release with mixed indentation, two filled entries
interrupted, ambiguous title; normalize over lookalikes; stray heading; deletion anchor with an
appended line; bootstrap dependency kept; clean-clone save item fields; follow-up `reused:false`
through the driver; the check mutation with a negation in the sentence.

## Deferred minors (recorded, not fixed)

Claude EP5 (a pick interrupted after a release and before the Now insertion re-reads the item as an
ordinary Backlog item: it is still picked in Backlog order); PARSE-6 (a nested list under notes naming
a field word parks the item); integration open: an unfilled delegate-flagged entry left for a Done
item; reflex-bundle's crlf refusal named `bad-item`; class values and §7.1 caps not validated (stage
1); `const id = item` leftover in loop-items.mjs.
Dropped by the skeptics: LR07-C, EP4, PARSE-2, PARSE-4, PARSE-5, PARSE-7, PARSE-8, PDC-4.

## Addendum 2 (2026-10-04): rulings from the Codex re-check of the fix pass

Source: the Codex re-check of the fix pass, `codex-fix1-g1.md` and `codex-fix1-g2.md`. Each fix test-first.

**R29a. `clear-now` compares every field that decides behaviour.** Two copies are identical for
`clear-now` when their id, `itemDigest` (title, notes, decision), `blocked-by:`, every origin-like line
(raw text) and the reserved `decided:`/`no-change-ok:` lines agree; `status:`, `class:` and the header
form are ignored (a pick rewrites a waiting-level status, the Done move rewrites the header). Any other
difference is `now-conflict` (the item-edit incident), so a prerequisite added to the `## Now` copy is
never discarded (Codex fix1-g2#1, P1). Test: the Now copy gains `blocked-by:` (and, separately, a
changed origin line) while the digest stays equal -> now-conflict.

**R27a. The trim keeps a Done block whose lineage the ledger cannot carry whole.** `planDoneTrim`
never drops a `## Done` block whose origin-like lines are not exactly one well-formed `origin:` field
(a capitalized `Origin:`, a second origin line, a malformed one): the ledger's `item_origin` records only
one parsed origin, so the block stays the only full record of its parents (Codex fix1-g1#1,
fix1-g2#2). Tests: P -> F -> G with F's parent on `Origin:` and, separately, on a second `origin:` line;
after twenty newer completions and a trim, F stays and X (blocked by P) stays parked while G is open.

**R30a. A release refuses an id with raw carriers.** `releaseFor` consults `idCarriers`; when the id has
any raw carrier, or more than one parsed carrier, the release skips that id (`ambiguous-carrier`), keeps
the entry, and the item edits are not planned; this also applies before the interrupted-release resume
shortcut (Codex fix1-g1#2). Test: a stale Backlog copy carrying A and the Blocked item carrying A and B,
a filled decision for A -> no release, entry kept.

**R32a. Bootstrap never writes a none spelling as a blocker.** When a prerequisite's title is one of
the none spellings (`—`, `-`, `--`, `none`, `n/a`, any case), bootstrap renames that prerequisite by
appending ` (task)` before writing the dependent's `blocked-by:` (Codex fix1-g2#3). Prose and its check.

**Small fixes.** `loop-items digest` with a sole raw carrier exits 3 `no-item` (Codex fix1-g1#3); the
loop-recover test "an identical copy with an unrelated person-made Backlog item still clears" gains the
unrelated block and asserts it survives the applied `clear.edits` (fix1-g1#4); the cx-lr07 prose check
judges the clause, not the sentence: it flags a clause that ties a blocker's finishing to a title match
unless a negation governs that finishing assertion, with mutation tests for both of Codex's sentences
(fix1-g2#4); a prose wiring check that SKILL.md's follow-up step accepts both `reused: true` and
`reused: false` as success, with a mutation test (fix1-g2#5).

## Addendum 3 (2026-10-04): the Done trim is a helper

`loop-items.mjs trim <P>` prints `planDoneTrim`'s edits and `expect_sha256`; the firing applies them and runs `check --expect`, as for every other helper-planned edit (R14), so no item edit is left to the model's judgement.
