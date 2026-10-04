# Stage 0c-3: Stable Item Ids, Origins and Unique Open Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every backlog item in the loop's `STATE.md` a stable id and an origin, keep open titles unique, and make the loop refer to items by id only, so that a reused title or an analysis item moved to `## Done` while its follow-up is open can never release a dependent early (audit cx-lr07).

**Architecture:** One owner module per concern (spec §10). The item grammar, ids, origins, titles, digests, the blocker test, eligibility and all edit planning live in `scripts/lib/loop-state.mjs` (pure functions); ledger ids, done ids and origins in `scripts/lib/ledger.mjs` (`ledgerItems`); LOOP.md scalars in `scripts/lib/loop-md.mjs` (`frontScalar`). A new read-only CLI `scripts/loop-items.mjs` (normalize, pick, followup, digest, trim, check) prints anchored edits with an `expect_sha256` that the main session applies with Edit and confirms with `check`; no helper ever writes `STATE.md`. The 0c-2 helpers gain the item: `reflex-bundle.mjs save --item`, run record v:2 (`item_id`, `item_digest`), the `Tech-Lead-Item:` trailer, and the planner's id-and-digest finish rule, `clear-now` and `now-conflict`.

**Tech Stack:** Node.js 22 (ESM `.mjs`, `node:test`), git 2.40 or later. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-system1-layer-design.md`, revision 8 (amendment A12, approved by the owner): §7.1, §4, §5.4, §7.5, §9.1, §10 row 0c-3, §16. **Brief:** `docs/superpowers/plans/2026-10-04-stage-0c3-brief.md` (brief v2, rulings R1-R26 and A12, plus three addenda: R27-R33, R27a/R29a/R30a/R32a, and the trim helper).

## How this plan was produced, and how it is executed

The code this plan lands already exists, built test-first and reviewed by both model families:

1. Five readers mapped the spec, the downstream needs of stages 0c-4 to 4, the prose, the code and the earlier stage 0c design run; the tech lead wrote brief v1. Codex (two slices: 9 P1, 10 P2) and a five-lens Claude review with a skeptic per lens (51 of 59 findings held) reviewed it; brief v2 folded them in, and the owner approved amendment A12 (now spec revision 8).
2. A prototype build in a private clone (six builder agents, test-first, then an integration pass) produced the modules, the CLI, the prose, the checks, the firing driver and the interruption tests.
3. Codex (three module groups: 6 P1) and a five-lens Claude review with skeptics (14 of 22 held) reviewed the prototype; one fix pass (rulings R27-R33) closed every confirmed finding; the Done trim became a helper; a Codex re-check of the fix pass found siblings (1 P1, 4 P2), closed by a second round (R27a, R29a, R30a, R32a). Every fix has a test that was seen failing first.
4. A landing dry run in a fresh copy of the base landed the five tasks below in order: the counts are measured, and the final tree equals the prototype file for file.

The prototype is the git repository `.worktrees/_0c3-work/proto-0c3` (ignored through `.git/info/exclude`), commit `ba3b2f0`. Each task **lands** its files from that commit, never re-typed: `git -C "$PROTO" show ba3b2f0:<file> > <file>` (parent directories created first). If the prototype is lost, the brief plus Appendix B are the specification to rebuild it from, test-first.

## Global Constraints

- No dependencies; Node 22; ASCII-only code (the Bash and Write tools decode backslash-u escapes, so code is landed as files, never re-typed).
- Nothing new under `workflows/`. Version 0.6.0 (README version line and `.claude-plugin/plugin.json`) in Task 6.
- Tests: `node --test "tests/**/*.test.mjs"`; checks: `node scripts/check.mjs`.
- Work in the worktree `.worktrees/s1-0c3-items` on branch `feat/s1-0c3-items` from `feat/system1-design` (which equals `main` plus this plan's docs commit). The main checkout is the live plugin install.
- Long-lived work stays out of `/private/tmp`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No merge, push or PR without the owner.

## Review Focus (for the closing review)

- cx-lr07: no `STATE.md` and `LEDGER.jsonl` contents a person or an interrupted firing can produce let a dependent start while the work it waits on is not done: reused titles, reopened items (well-formed or not), damaged id or origin lines, loop-created follow-ups at any depth, `## Done` trims, `clear-now` and `finish-commit` recoveries.
- Interruption between the main session's Edit calls (a pick, a release, a follow-up, a trim, each prose move): the next firing never loses, duplicates, misfiles or silently rewrites an item; a person's amendment to either copy is never discarded (`now-conflict`).
- A person's hand edits: near-miss formatting parks with a note and a README remedy; nothing a person wrote is rewritten (A12).
- Delegate-written text never reaches a shell command (the follow-up goes through `--input <file>`) and cannot forge an item field (`loop-text.mjs` defangs every FIELD_LABEL).
- The prose: every helper command line is one the helper accepts, every exit state has its action, and every item edit is helper-planned and checked.

---

### Task 0: Preflight

- [ ] **Step 1:** `git -C /Users/macbook/.claude/skills/tech-lead status --porcelain` prints nothing; the branch is `feat/system1-design` at this plan's docs commit.
- [ ] **Step 2:** `git -C .worktrees/_0c3-work/proto-0c3 rev-parse --verify ba3b2f0^{commit}` succeeds.
- [ ] **Step 3:** create the worktree and check the baseline:

```bash
cd /Users/macbook/.claude/skills/tech-lead
git worktree add .worktrees/s1-0c3-items -b feat/s1-0c3-items feat/system1-design
cd .worktrees/s1-0c3-items
node scripts/check.mjs | tail -1
node --test "tests/**/*.test.mjs" 2>&1 | grep -E '^# (pass|fail)'
```

Expected: `63 passed, 0 failed, 0 warnings`; `# pass 952`, `# fail 0`.

In every later task `PROTO=/Users/macbook/.claude/skills/tech-lead/.worktrees/_0c3-work/proto-0c3`, commands run in the worktree, and landing a file is:

```bash
land() { for f in "$@"; do mkdir -p "$(dirname "$f")"; git -C "$PROTO" show "ba3b2f0:$f" > "$f"; done; }
```

A task's own tests are its listed test files run together (`node --test <files>`); then the full suite and check.mjs. The interruption tests use real processes and timing: when a full run shows a failure or a cancellation in a file the task did not touch, run that file alone three times and record the result in the ledger before deciding (machine load from indexing has caused 90 s timeouts; `.worktrees/.metadata_never_index` keeps Spotlight off the work folders).

### Task 1: Item grammar, planning and readers

**Files (from the prototype):** `scripts/lib/loop-state.mjs`, `scripts/loop-text.mjs`, `scripts/lib/ledger.mjs`, `scripts/lib/loop-md.mjs`, `tests/lib/loop-state.test.mjs`, `tests/lib/loop-state-fixture.mjs`, `tests/lib/loop-state-grammar.test.mjs`, `tests/lib/loop-state-ids.test.mjs`, `tests/lib/loop-state-origins.test.mjs`, `tests/lib/loop-state-titles.test.mjs`, `tests/lib/loop-state-digests.test.mjs`, `tests/lib/loop-state-blockers.test.mjs`, `tests/lib/loop-state-carriers.test.mjs`, `tests/lib/loop-state-normalize.test.mjs`, `tests/lib/loop-state-pick.test.mjs`, `tests/lib/loop-state-release.test.mjs`, `tests/lib/loop-state-followup.test.mjs`, `tests/lib/loop-state-trim.test.mjs`, `tests/loop/loop-text-labels.test.mjs`, `tests/lib/ledger.test.mjs`, `tests/lib/loop-md.test.mjs`.
**Interfaces:** brief §2-§3, R1-R13, R22, R26 and addenda R27, R27a, R28, R30, R30a, R31; Appendix B (loop-state, ledger, loop-md).
**Note:** `loop-state.mjs` and `ledger.mjs` import each other's names (`ID_RE` one way, the ledger object the other), so they land together.

- [ ] Land the files:

```bash
land scripts/lib/loop-state.mjs scripts/loop-text.mjs scripts/lib/ledger.mjs scripts/lib/loop-md.mjs \
     tests/lib/loop-state.test.mjs tests/lib/loop-state-fixture.mjs tests/lib/loop-state-grammar.test.mjs \
     tests/lib/loop-state-ids.test.mjs tests/lib/loop-state-origins.test.mjs tests/lib/loop-state-titles.test.mjs \
     tests/lib/loop-state-digests.test.mjs tests/lib/loop-state-blockers.test.mjs tests/lib/loop-state-carriers.test.mjs \
     tests/lib/loop-state-normalize.test.mjs tests/lib/loop-state-pick.test.mjs tests/lib/loop-state-release.test.mjs \
     tests/lib/loop-state-followup.test.mjs tests/lib/loop-state-trim.test.mjs tests/loop/loop-text-labels.test.mjs \
     tests/lib/ledger.test.mjs tests/lib/loop-md.test.mjs
```

- [ ] Own tests (the 17 test files above): expected `# pass 126`, `# fail 0`.
- [ ] Full suite: `# pass 1068`, `# fail 0`. `node scripts/check.mjs`: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(items): item grammar, ids, origins, blocker test and edit planning`.

### Task 2: Item CLI

**Files (from the prototype):** `scripts/loop-items.mjs`, `tests/loop/loop-items.test.mjs`.
**Interfaces:** brief §4, R13, R14, R17, R26; addenda R28 (digest and check refuse several carriers), Addendum 3 (trim); Appendix B (loop-items).

- [ ] `land scripts/loop-items.mjs tests/loop/loop-items.test.mjs`
- [ ] Own tests: `node --test tests/loop/loop-items.test.mjs`. Expected: `# pass 33`, `# fail 0`.
- [ ] Full suite: `# pass 1101`, `# fail 0`. Checks: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit: `feat(items): read-only item CLI (normalize, pick, followup, digest, trim, check)`.

### Task 3: Bundle item binding

**Files (from the prototype):** `scripts/reflex-bundle.mjs`, `tests/loop/reflex-bundle-item.test.mjs`, `tests/loop/reflex-bundle.test.mjs`, `tests/loop/reflex-bundle-apply.test.mjs`, `tests/loop/reflex-bundle-reset.test.mjs`.
**Interfaces:** brief R18; Appendix B (reflex-bundle).

- [ ] `land scripts/reflex-bundle.mjs tests/loop/reflex-bundle-item.test.mjs tests/loop/reflex-bundle.test.mjs tests/loop/reflex-bundle-apply.test.mjs tests/loop/reflex-bundle-reset.test.mjs`
- [ ] Own tests (the four test files): expected `# pass 44`, `# fail 0`.
- [ ] Full suite: `# pass 1109`, `# fail 0`. Checks: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit: `feat(items): recovery bundles carry the item id and digest`.

### Task 4: Run record v2, clone item, planner rules, firing driver and interruption tests

**Files (from the prototype):** `scripts/lib/run-record.mjs`, `scripts/loop-clone.mjs`, `scripts/loop-recover.mjs`, `tests/lib/run-record.test.mjs`, `tests/loop/loop-recover.test.mjs`, `tests/loop/loop-clone-create.test.mjs`, `tests/loop/loop-clone-item.test.mjs`, `tests/fixtures/firing-driver.mjs`, `tests/fixtures/firing-moves.mjs`, `tests/loop/interrupt-fixture.mjs`, `tests/loop/firing-moves.test.mjs`, `tests/loop/loop-interrupt-clone-commit.test.mjs`, `tests/loop/loop-interrupt-clone-driver.test.mjs`, `tests/loop/loop-interrupt-clone-items.test.mjs`, `tests/loop/loop-interrupt-clone-prose.test.mjs`, `tests/loop/loop-interrupt-clone-state.test.mjs`, `tests/loop/loop-interrupt-clone-tamper.test.mjs`, `tests/loop/loop-interrupt-items.test.mjs`.
**Interfaces:** brief R19-R21, R33; addenda R27 (ledger `done_items`), R29, R29a; Appendix B (run-record, loop-clone, loop-recover, the driver).
**Note:** the new planner rules change what the interruption tests expect, so the driver and those tests land in the same task (the dry run showed seven failures when they were split).

- [ ] Land the 18 files listed above (one `land` call).
- [ ] Own tests (the 13 test files): expected `# pass 275`, `# fail 0`.
- [ ] Full suite: `# pass 1215`, `# fail 0`. Checks: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit: `feat(items): run record v2, item trailer, id-and-digest recovery, clear-now and now-conflict; interruption tests`.

### Task 5: Loop prose and checks

**Files (from the prototype):** `skills/loop/SKILL.md`, `skills/loop/references/loop-templates.md`, `skills/loop/references/clone.md`, `skills/loop/references/bootstrap.md`, `references/panel-protocol.md`, `README.md`, `scripts/checks/loop.mjs`, `tests/check.test.mjs`.
**Interfaces:** brief §6-§7, R14-R17, R23-R25; addenda R27-R32a and the trim helper; Appendix B (prose, checks).

- [ ] Land the 8 files listed above.
- [ ] Own tests: `node --test tests/check.test.mjs`. Expected: `# pass 61`, `# fail 0`.
- [ ] Full suite: `# pass 1232`, `# fail 0`. `node scripts/check.mjs`: `78 passed, 0 failed, 0 warnings`.
- [ ] Commit: `docs(loop): items by id; normalize, pick, follow-up, trim and checked moves in the firing`.

### Task 6: Version, acceptance and hand-off

- [ ] Set the version to 0.6.0 in `.claude-plugin/plugin.json` and in README's `**Version …**` line (the version check ties them). Commit: `0.6.0: System 1 stage 0c-3 (stable item ids, origins, unique open titles)`.
- [ ] Acceptance: from `/tmp`, `node <worktree>/scripts/check.mjs` gives `78 passed, 0 failed, 0 warnings`; the full suite gives `# pass 1232` three times; the tree is clean; `git diff --stat ba3b2f0` against the prototype shows only the version lines outside `docs/`.
- [ ] Closing review, three seats that do not see each other: the `code-review` skill at `high` on `feat/system1-design...feat/s1-0c3-items`; a fresh `general-purpose` reviewer on `opus` with superpowers' `code-reviewer.md` and this plan's Review Focus; Codex from the main session (`codex exec --skip-git-repo-check -s read-only -C <worktree> -o <durable file> "…" < /dev/null`), split by module group as the prototype review was.
- [ ] Verify every finding against the code; fix confirmed ones test-first in one pass; record rulings and deferred minors.
- [ ] Ask the owner how to integrate: PR to `main` (as stages 0a-0c-2 were), merge locally, or keep (superpowers:finishing-a-development-branch).

---

## Appendix A: the architecture brief

`docs/superpowers/plans/2026-10-04-stage-0c3-brief.md`, committed with this plan: brief v2 (rulings R1-R26 and amendment A12, with §11 mapping every v1 review finding to its disposition) plus three addenda: R27-R33 (prototype review), R27a, R29a, R30a, R32a (Codex re-check), and the trim helper. It is the specification; where the landed code differs, Appendix B records the difference.

## Appendix B: deviations from the brief, as built (each a ruling)

- loop-state: `loop-text.mjs` and `loop-state.mjs` import each other (`neutralLine` one way, `fold` and `FIELD_LABELS` the other); `loop-text` builds `LABEL` lazily so either can load first. The planners take more options than the brief lists (`ledger`, `rng`) and return `state`/`reason` so the CLI maps refusals to exit 3. Structural problems the brief does not name: `missing-section`, `duplicate-section`, `stray-heading` (R31), and planner refusals `bad-sections` and `now-occupied` (pick never runs while `## Now` holds an item). A Done line must match its header exactly or it is `unparsed-line` (never done); a Blocked line without `attempts:` is still an open item. Field rules where the brief is silent: an empty title is `ambiguous-title`; a blank line ends a continuation; a field-label list line inside a continuation is `malformed-field`; `notes`/`decision` given twice are `duplicate-field`; a column-0 text line glued to an item joins it as `malformed-field`. The interrupted-move copy pair in `## Now` and another section is exempt from `duplicate-id`/`duplicate-title`. A `title-blocker` candidate comes from `## Done` only when no open item has the title. Release: only `panel` and `delegate-flagged` entries are deleted, unfilled ones first; several filled entries append in file order; an already-applied decision sequence is not appended again (R30); the refusals `ambiguous-decision`, `ambiguous-title`, `ambiguous-carrier` (R30a) keep the entry; a released Blocked item loses its attempts and reason in the Backlog header form; the Blocked-to-Backlog release is an insert-then-delete pair that the next pick recognizes and finishes. Levels for `waiting-level`: mechanical 2, hard 3, high-stakes 1. `planPick`'s `skipped` lists release refusals and the items passed over before the pick. Anchors widen forward at the start of a file; an insertion after a last line with no newline is an `edit-anchor` error. `planDeleteBlock` and `idCarriers` are exported for the planner and the CLI. `lineageWhole` (R27a) keeps a Done block with an origin-like line that is not exactly one well-formed `origin:` field; a block with no origin-like line can be trimmed.
- ledger and loop-md: `ledgerItems.ids` holds every non-empty `item_id` string (a larger known set for minting); done ids need an exact `ID_RE` match; the latest usable origin per id stands; `done_items` count as done (R27). `frontScalar` returns strings, refuses an empty value, `key:value` without a space and anything between key and value, and reuses `frontList`'s scalar parser.
- loop-items: exit-3 answers are `{state: <reason>, detail}`; `check --item` needs exactly one carrier of the id in the whole file (raw carriers included); `digest` refuses several carriers and a sole raw carrier as `no-item`; ids and digests on the command line must be lowercase (`ID_RE`, 64 hex); a missing LOOP.md or a bad `level:` exits 2; STATE.md and LOOP.md must be valid UTF-8 (`bad-encoding`); `crlf` is checked first; the follow-up input file must be a JSON object with `title` (and optional `notes`) only; `check` with no flag reports problems only.
- reflex-bundle: `--item` must match `ID_RE` exactly (a usage error otherwise); the carrier rule counts every item with an `id:` field equal to the id, and an `invalid-id` sole carrier is `bad-item`; a missing STATE.md, a `crlf` STATE.md and no carrier are all `bad-item`; a differing `--item-digest` is `digest-mismatch`; `saveFor` takes `itemId` and `itemDigest` together; saved and empty results carry both; a header with `item_digest` set and `item_id` null is now tampered.
- run-record, loop-clone, loop-recover: a v:2 record with no item never finishes a commit (requeued); prepare binds the item only when its header is the Now line; v:1 records cannot be half-upgraded; with a `crlf` STATE.md the planner reads no items and requeues; the Done-sha check reads only parsed Done headers; `clear-now` needs one Now item block, exactly one other carrier and identical behaviour fields (R29a: id, digest, `blocked-by:`, raw origin lines, `decided:`, `no-change-ok:`), otherwise `now-conflict` with named reasons; `recovered.item_origin` is the first origin as written; a clean-clone save carries the interrupted v:2 record's item (R33).
- prose and checks: a new `## Item edits` section holds the shared rules (apply, `check --expect`, moves with `check --item`, the incident); any exit 3 or 2 from a `loop-items` command is the item-edit incident (halted, paused, `## Now` kept); the follow-up arrives `unclassified` and is classified by the firing that picks it; a move of an item without a valid id is unchecked (an item a 0.5.0 firing left in `## Now`); `clear-now` records `recovered.action` null; the trim runs through `loop-items trim` before the ledger append; bootstrap writes `origin: bootstrap` and keeps dependencies as title blockers, renaming a prerequisite whose title is a none spelling (R32, R32a); checks 1-7 of the brief plus the trim, follow-up-answer, bootstrap, `now-conflict` and release-refusal checks (78 in all), each with a mutation test.
- tests: the firing driver drives every item helper through its CLI as the prose does; `tests/fixtures/firing-moves.mjs` (the Edit model and move primitives) is shared by the driver and the CLI-level matrix; fixture items carry deterministic ids and `origin: human`; row 37 of the commit matrix was redesigned (two open items with one title now park each other).

## Appendix C: rulings and what each costs if wrong

The full text is in the brief (R1-R26, A12) and its addenda. Costs, in short:

- A12 / R1 (ids and origins filled every firing): items a person adds without an `origin:` line read `unknown` until 0c-4.
- R2 (ids only `tl-` + 8 base32, loop-minted): an id copied by hand from an old ledger row is not detected.
- R5 (strict field lines): near-miss formatting parks the item until a person fixes it.
- R6 (digests over trimmed raw values): a whitespace edit inside a value changes the digest.
- R7 (folded title comparison): "Fix API" and "fix api" are one title.
- R8 (duplicate ids park every carrier): a pasted duplicate strands both until a person fixes one.
- R9 (invalid origin parks the item, its tokens still hold parents): a typo in an origin parks the item.
- R10 (blocked-by holds only ids): every legacy title blocker parks its dependent until a person writes the id (candidate printed).
- R11 (transitive loop-from walk): a done item is held longer than the one-level reading.
- R14 / R31 (helper-planned, checked edits; tail anchors): a mis-applied Edit, or a line a person adds mid-firing, pauses the loop until the owner looks.
- R15 (legacy entry headings park): a pending decision under a title heading waits for a person.
- R16 / R30 (append decisions, no recreation): a decision written as paragraphs becomes one line; an orphan entry waits for a person.
- R17 (follow-up through a JSON file): one more file under `<S>/briefs/`.
- R18 (save needs one carrier): a save refuses while the item's id is ambiguous.
- R19 / R20 (record v:2; finish needs id, digest and Now hash): an item amended mid-firing is requeued, not finished.
- R21 / R27 (ledger `item_id`, `item_origin`, `done_items`): three more fields per ledger row.
- R22 (all labels defanged): delegate text cannot write a line that starts like an item field.
- R23-R25 (briefs by id, the decision in the brief, bootstrap origin): none beyond the wording.
- R27a (trim keeps malformed lineage): such Done blocks stay until a person fixes their origin lines.
- R28 (raw open carriers count): a stray id token in an open section holds that item's dependents.
- R29 / R29a (`clear-now` only for identical copies): an interrupted move with an amended copy pauses the loop.
- R32 / R32a (bootstrap keeps dependencies): a bootstrapped dependent waits until the owner writes its blocker's id.
- R33 (clean-clone save carries the item): none.
- Process ruling: the tasks land the reviewed prototype instead of re-typing it (as in 0c-1 and 0c-2); each module's red step happened in the prototype build and fix passes.

## Appendix D: residual risks and deferred minors

Residual risks (named for the owner): a delegate can edit ids, origins and `blocked-by:` before stage 2 (spec §15; deleting a `loop from` origin releases dependents early); an id copied by hand from an old ledger row onto a new item is not detected; legacy title blockers and headings park their items until a person writes the id; legacy analysis/follow-up pairs carry no `loop from` link, so a person who points a dependent at the analysis item's id releases it (the note warns); random ids are less memorable than titles; case-folded title comparison; the ledger is trusted for done ids and origins until stage 1 chain-verifies it; each firing runs five or six more short helper calls (about 0.2 s).

Deferred minors: a pick interrupted after a release and before its `## Now` insertion re-reads the item as an ordinary Backlog item (it is still picked in Backlog order); a nested list under `notes:` that names a field word parks the item; an unfilled delegate-flagged entry can remain for an item that later completed (the next upsert replaces it); reflex-bundle names a `crlf` STATE.md `bad-item`; class values and §7.1's caps (title 300, notes 8,000) are not validated (stage 1).
