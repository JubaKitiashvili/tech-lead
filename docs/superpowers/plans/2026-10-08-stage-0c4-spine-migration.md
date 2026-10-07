# Stage 0c-4: Spine Untracking, the Stage 0c Migration, the Scope Gate and Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the loop's spine (`.tech-lead/`) from ever being committed or overwritten by a branch switch, migrate existing 0.6.0 spines interactively to `spine_version: 0c` (untrack, retire the old worktree, ids), refuse whole-repository and unsafe scopes before any work starts, make bootstrap commit nothing, and have quick refuse an in-place switch onto a tree that tracks the spine.

**Architecture:** One owner module per concern (spec §10). `scripts/lib/spine.mjs` owns the stage list, `SPINE.json`, the spine status detector and its verdicts, the ignore line and the snapshots; `scripts/loop-spine.mjs` is its CLI (status, guard, save, restore, ignore, scope, noted helpers); `scripts/loop-migrate.mjs` runs the stage 0c migration (plan, run per step, recorded state under `<V>/migration/0c/`); `loop-scope.mjs` gains the scope gate; `legacy-worktree.mjs`, `git-safe.mjs` (linked-worktree runner) and `changes.mjs` (legacy layout) serve the old worktree's save; the 0c-1 to 0c-3 helpers gain the guard, `adopt`, `release --carry` and `resolve`. The main session still writes every governance file with Write/Edit; helpers print what to write and verify it.

**Tech Stack:** Node.js 22 (ESM `.mjs`, `node:test`), git 2.40 or later. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-system1-layer-design.md`, revision 8 (no amendment; the brief records six readings of the spec text): §3, §4, §9.1, §9.2, §10 row 0c-4, §11. **Brief:** `docs/superpowers/plans/2026-10-08-stage-0c4-brief.md` (brief v2, rulings R1-R44, plus addenda: the prototype review manifest with rulings R45-R59, and fix round 2's R70-R73).

## How this plan was produced, and how it is executed

1. Five readers mapped the spec, the prose, the code, the earlier stage 0c design run and the needs of stages 1-4. The tech lead ruled on the open questions (R1-R16); an Opus drafter wrote brief v1 (R17-R34).
2. Codex (two slices: 22 findings) and a five-lens Claude review with a skeptic per lens (33 of 52 held) reviewed it; brief v2 fixed every confirmed finding under the tech lead's rule "the spec's literal text before an amendment"; no amendment was needed.
3. A prototype build in a private clone (seven builders, test-first, then integration) produced the modules, CLIs, prose, checks and the migration-case tests.
4. Codex (three groups) and a five-lens Claude review with skeptics (21 of 28 held) reviewed the prototype; one consolidated fix pass (F1-F31, rulings R45-R59); a Codex re-check of the fix pass found siblings (2 P1, 4 P2, 5 P3), closed by fix round 2 (R70-R73). Every fix has a test that was seen failing first.
5. A landing dry run in a fresh copy of the base landed the four tasks below in order: the counts are measured, and the final tree equals the prototype file for file.

The prototype is `.worktrees/_0c4-work/proto-0c4` (ignored through `.git/info/exclude`), commit `fb6d230`. Each task **lands** its files from that commit: `git -C "$PROTO" show fb6d230:<file> > <file>`. If the prototype is lost, the brief and its addenda are the specification to rebuild it from, test-first.

## Global Constraints

- No dependencies; Node 22; ASCII-only code, landed as files, never re-typed.
- Version 0.7.0 (README and `.claude-plugin/plugin.json`) arrives with Task 4, as in the prototype.
- Tests: `node --test "tests/**/*.test.mjs"`; checks: `node scripts/check.mjs`.
- Work in `.worktrees/s1-0c4-spine` on branch `feat/s1-0c4-spine` from `feat/system1-design` (main plus this plan's docs commit). The main checkout is the live plugin install.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No merge, push or PR without the owner.

## Review Focus (for the closing review)

- The owner's repository: the migration's untrack commit, exclude line and old-worktree retirement never lose an uncommitted byte, commit anything but their own change, run on the wrong branch, or leave a half state no rerun can resume.
- The branch-switch guard: no branch switch, `git clean`, stash pop, case-variant path or hand edit lets the loop write governance files over a tracked spine, restore a copy that is not the anchored one, or silently drop the owner's edits.
- Interruption: a migration, bootstrap, spine save or restore killed at any boundary (including a wiped `<V>` or a lost lock) is detected from records or content and finished or rolled back.
- Scope: every whole-repository spelling, absolute path, `..`, `.git` and `.tech-lead` entry is refused at bootstrap, in the migration and at the §2 gate; valid scopes keep their digest.
- The prose: every command is one the helpers accept, every verdict and exit state has an action, and the guard runs before every governance-write sequence.

---

### Task 0: Preflight

- [ ] `git -C /Users/macbook/.claude/skills/tech-lead status --porcelain` prints nothing; the branch is `feat/system1-design` at this plan's docs commit; `git -C .worktrees/_0c4-work/proto-0c4 rev-parse --verify fb6d230^{commit}` succeeds.
- [ ] `git worktree add .worktrees/s1-0c4-spine -b feat/s1-0c4-spine feat/system1-design`; in it, `node scripts/check.mjs` gives `81 passed, 0 failed, 0 warnings` and the suite `# pass 1268`, `# fail 0`.

Landing a file: `land() { for f in "$@"; do mkdir -p "$(dirname "$f")"; git -C "$PROTO" show "fb6d230:$f" > "$f"; done; }` with `PROTO=/Users/macbook/.claude/skills/tech-lead/.worktrees/_0c4-work/proto-0c4`. Each task's files are listed in `.worktrees/_0c4-work/land-tasks.json` (task N = entry N). A task's own tests are its listed test files run together; then the full suite and check.mjs. The process tests are timing-sensitive under machine load: a failure or cancellation in a file the task did not touch is re-run alone three times and recorded before deciding.

### Task 1: Libraries

**Files:** land-tasks.json entry 1 (18 files): `scripts/lib/{spine,legacy-worktree,loop-md,loop-scope,loop-state,ledger,git-safe,changes}.mjs` and their `tests/lib/` tests and fixture (the legacy-worktree test lands in Task 2).
**Interfaces:** brief §2, §4.1-§4.4, §4.6-§4.8; R5, R7, R10, R15, R17, R26.

- [ ] Land; own tests: `# pass 96`, `# fail 0`; full suite: `# pass 1364`, `# fail 0`; checks `81 passed, 0 failed, 0 warnings`.
- [ ] Commit: `feat(spine): spine library, scope gate, legacy worktree, linked runner and legacy layout`.

### Task 2: Helper CLIs, the firing driver and the interrupt fixture

**Files:** entry 2 (21 files): `scripts/{loop-spine,loop-lock,loop-items,loop-clone,loop-recover,reflex-bundle}.mjs`, their tests, `tests/lib/legacy-worktree.test.mjs`, `tests/fixtures/firing-driver.mjs`, `tests/loop/interrupt-fixture.mjs`.
**Interfaces:** brief §3, §4.5, §5.5-§5.8; R2, R17-R19, R27, R35, R36.
**Note:** the driver and interrupt fixture land here because the new helpers change what the interruption matrix expects (the dry run showed 102 failures when they were split).

- [ ] Land; own tests: `# pass 263`, `# fail 0`; full suite: `# pass 1455`, `# fail 0`; checks `81 passed`.
- [ ] Commit: `feat(spine): spine CLI, guard, release --carry, adopt, resolve and the legacy save`.

### Task 3: Migration helper

**Files:** entry 3 (5 files): `scripts/loop-migrate.mjs`, `tests/loop/loop-migrate-{fixture,plan,untrack,worktree}...`.
**Interfaces:** brief §5.1-§5.4; R3, R4, R6, R12, R22, R24, R25, R38; manifest rulings; R70-R73.

- [ ] Land; own tests: `# pass 78`, `# fail 0`; full suite: `# pass 1532`, `# fail 0`; checks `81 passed`.
- [ ] Commit: `feat(migrate): the stage 0c migration (untrack, old worktree, ids, version)`.

### Task 4: Prose, checks, migration cases and 0.7.0

**Files:** entry 4 (18 files): `skills/loop/SKILL.md`, `skills/loop/references/{bootstrap,clone,loop-templates,migration}.md`, `skills/quick/SKILL.md`, `README.md`, `.claude-plugin/plugin.json`, `scripts/checks/{loop,contracts}.mjs`, `tests/check.test.mjs`, `tests/check-guard-order.test.mjs`, `tests/loop/migration-cases-*`.
**Interfaces:** brief §6-§9.

- [ ] Land; own tests: `# pass 159`, `# fail 0`; full suite: `# pass 1628`, `# fail 0`; checks `99 passed, 0 failed, 0 warnings`.
- [ ] Commit: `0.7.0: System 1 stage 0c-4 (spine untracking, migration, scope gate, bootstrap without a commit)`.

### Task 5: Acceptance, closing review and hand-off

- [ ] Acceptance: from `/tmp`, `node <worktree>/scripts/check.mjs` gives `99 passed`; the full suite gives `# pass 1628` three times; the tree is clean; every landed file equals the prototype's.
- [ ] Closing review, three independent seats: the `code-review` skill at `high` on `feat/system1-design...feat/s1-0c4-spine`; a fresh `general-purpose` reviewer on `opus` with superpowers' `code-reviewer.md` and this plan's Review Focus; Codex xhigh from the main session in module groups.
- [ ] Verify every finding against the code; fix confirmed ones test-first in one pass; record rulings and deferred minors.
- [ ] Ask the owner how to integrate (PR to main as before, merge locally, or keep).

---

## Appendix A: the brief

`docs/superpowers/plans/2026-10-08-stage-0c4-brief.md`: brief v2 (R1-R44; its §12 maps every brief-review finding to its disposition; its spec-amendments section records six readings of the spec text and no amendment), Addendum 1 (the prototype review fix manifest, findings F1-F31, rulings R45-R59, with their tests and costs), Addendum 2 (fix round 2, R70-R73).

## Appendix B: rulings and costs

Each ruling in the brief and its addenda carries its cost if wrong. The ones an owner feels most: the migration and any restore run only in a firing the owner starts (a scheduled firing that needs one exits without writing and stops its runner); the untrack commit lands on the `base:` branch with hooks disabled and is verified after it is made; bootstrap no longer commits, mints ids and resolves dependencies with the owner; an invalid scope pauses the loop with a note; a worktree git refuses to remove keeps the migration pending; the guard runs before every governance-write sequence. Process ruling: the tasks land the reviewed prototype instead of re-typing it (as in 0c-1 to 0c-3).

## Appendix C: residual risks and deferred minors

From the brief §10 and the manifests: the migration and bootstrap need git writes to `<P>` and cannot run inside stage 2's sandboxed runner; other branches that still track the spine get warnings only; a restore larger than the inline limit is copied by the owner with `cp`; the old worktree's save writes objects into `<P>/.git` during the interactive migration; the process tests are sensitive to heavy machine load. No minor was deferred: every confirmed review finding was fixed.
