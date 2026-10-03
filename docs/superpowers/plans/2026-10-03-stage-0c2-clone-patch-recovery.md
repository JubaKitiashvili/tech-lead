# Stage 0c-2: Isolated Clone, Patch Helper and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the loop's work out of the owner's repository into a private full clone, deliver its commits as verified bundles, save every uncommitted byte as a recovery bundle before anything is discarded (never `git stash`), start each firing from a clean clone, and recover correctly from a firing killed at any persistence boundary.

**Architecture:** One owner module per concern (spec §10), as the brief fixes them: the clone `scripts/loop-clone.mjs` (create, refresh, rotation, adoption, deps marker, check, commit, close, read-only git passthrough), delivery bundles `scripts/lib/delivery.mjs`, the shared patch helper `scripts/reflex-bundle.mjs` (save, verify, reset, apply) over the change-set owner `scripts/lib/changes.mjs`, the per-firing run record and recovery verdict `scripts/lib/run-record.mjs`, the extended planner `scripts/loop-recover.mjs`, the owner-only review tool `scripts/loop-review.mjs`, plus small owners for clone integrity, scope rules, canonical JSON, LOOP.md lists, STATE.md and ledger reading, and test-only fault points. The loop prose calls them as `node <T>/scripts/…`; `references/clone.md` replaces `references/worktree.md`.

**Tech Stack:** Node.js 22 (ESM `.mjs`, `node:test`), git 2.40 or later (attribute isolation is feature-tested at run time), macOS or Linux process facts. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-system1-layer-design.md`, revision 7: §3, §4, §7.5 (as amended by A11), §7.6, §9.1, §10 row 0c-2, §11, §15, §16. **Brief:** `docs/superpowers/plans/2026-10-03-stage-0c2-brief.md` (the binding architecture brief v2 with its addendum of review rulings R24-R32 and R29a).

## How this plan was produced, and how it is executed

The code this plan lands already exists, built test-first and reviewed twice:

1. Five readers mapped the prose, the clone and patch-helper designs, recovery and the 0c-1 interfaces; the tech lead wrote the brief. Codex (17 findings) and a 48-agent Claude find-and-refute workflow (42 confirmed) reviewed the brief; brief v2 folded them in, and the owner approved amendment A11 (now spec revision 7).
2. Three prototype builds in a private clone (17 builder agents, each test-first) produced the modules, the prose, the checks and the interruption matrix.
3. Codex (four module groups, about 27 findings) and a five-lens Claude workflow with a skeptic per finding (21 confirmed) reviewed the prototype. One consolidated fix pass (rulings R24-R31), a follow-up pass, a Codex re-check of the fixes, and a second fix round (R29a, R32, sharpened R31) closed every confirmed finding; each fix has a test that was seen failing first.
4. A machine reboot erased the session scratchpad mid-way; the prototype was rebuilt byte-exact by replaying every builder's file writes from their transcripts (0 divergences; every snapshot and suite count matched) and moved to a durable folder.
5. A landing dry run in a fresh copy of the base landed the tasks below in order: the counts are measured, and the final tree equals the prototype file for file.

The prototype is the git repository `.worktrees/_0c2-work/proto-0c2` (ignored through `.git/info/exclude`), commit `be11c0d`. Each task **lands** its files from that commit, never re-typed: `git -C "$PROTO" show be11c0d:<file> > <file>` (parent directories created first), or `git rm` for a deletion. If the prototype is lost, the brief plus Appendix B are the specification to rebuild it from, test-first.

## Global Constraints

- No dependencies; Node 22; ASCII-only code (the Bash and Write tools decode backslash-u escapes, so code is landed as files, never re-typed).
- Nothing new under `workflows/`. Version 0.5.0 (README version line and `.claude-plugin/plugin.json`) in Task 11.
- Tests: `node --test "tests/**/*.test.mjs"`; checks: `node scripts/check.mjs`.
- Work in the worktree `.worktrees/s1-0c2-clone` on branch `feat/s1-0c2-clone` from `feat/system1-design` (which equals `main` plus this plan's docs commit). The main checkout is the live plugin install.
- Long-lived work stays out of `/private/tmp` (a reboot clears it).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No merge, push or PR without the owner.

## Review Focus (for the closing review)

- A firing killed (SIGKILL) at any of the 27 fault points or prose boundaries: the next firing saves every uncommitted byte before discarding anything, never commits twice, never rewinds a loop commit, never bundles an unvetted or retired commit, and never pauses for ever.
- Delegate-written content in the clone (ignore rules, attributes, filters, git config, hooks, refs, symlinks in git storage, nested repositories): no helper or owner command executes it, writes the owner's repository, or lets it hide a file from a save.
- Tool-written self-ignored directories (a venv, `.husky/_`, test caches): kept across firings (A11, R25), while files a delegate hid with a new ignore rule are still saved.
- A lock lost in the middle of any helper: no publication, discard or record write after the loss; `not-holder` propagates as such.
- The prose: every command line is one the helpers accept, every exit state has its action, and `close` runs before the release.

---

### Task 0: Preflight

- [ ] **Step 1:** `git -C /Users/macbook/.claude/skills/tech-lead status --porcelain` prints nothing; the branch is `feat/system1-design` at this plan's docs commit.
- [ ] **Step 2:** `git -C .worktrees/_0c2-work/proto-0c2 rev-parse --verify be11c0d^{commit}` succeeds.
- [ ] **Step 3:** create the worktree and check the baseline:

```bash
cd /Users/macbook/.claude/skills/tech-lead
git worktree add .worktrees/s1-0c2-clone -b feat/s1-0c2-clone feat/system1-design
cd .worktrees/s1-0c2-clone
node scripts/check.mjs | tail -1
node --test "tests/**/*.test.mjs" 2>&1 | grep -E '^# (pass|fail)'
```

Expected: `53 passed, 0 failed, 0 warnings`; `# pass 281`, `# fail 0`.

In every later task `PROTO=/Users/macbook/.claude/skills/tech-lead/.worktrees/_0c2-work/proto-0c2`, commands run in the worktree, and landing a file is:

```bash
land() { for f in "$@"; do mkdir -p "$(dirname "$f")"; git -C "$PROTO" show "be11c0d:$f" > "$f"; done; }
```

A task's own tests are its listed test files run together (`node --test <files>`); then the full suite and check.mjs. Process tests use real processes and timing: when a full run shows one failure in a file the task did not touch, run that file alone three times and record the result in the ledger before deciding.

### Task 1: Foundation libraries

**Files (from the prototype):** `scripts/lib/git-safe.mjs`, `tests/lib/git-safe.test.mjs`, `scripts/lib/atomic.mjs`, `tests/lib/atomic.test.mjs`, `scripts/lib/loop-proc.mjs`, `scripts/lib/canonical.mjs`, `tests/lib/canonical.test.mjs`, `scripts/lib/loop-md.mjs`, `tests/lib/loop-md.test.mjs`, `scripts/lib/loop-state.mjs`, `scripts/lib/ledger.mjs`, `scripts/lib/fault.mjs`, `tests/lib/fault.test.mjs`.
**Interfaces:** brief §2-§5, §7, §10 and the §1 rows for loop-state and ledger; Appendix B (git-safe, atomic).
**Note:** `loop-state.mjs` and `ledger.mjs` arrive here; their own tests land with the modules that re-export them (Tasks 5 and 9). Until Task 5 replaces it, the old `loop-proc` zombie test is a known flake under load (fixed in this stage): if it is the only failure, run `node --test tests/lib/loop-proc.test.mjs` alone three times and record it.

- [ ] Land the files:

```bash
land scripts/lib/git-safe.mjs \
     tests/lib/git-safe.test.mjs \
     scripts/lib/atomic.mjs \
     tests/lib/atomic.test.mjs \
     scripts/lib/loop-proc.mjs \
     scripts/lib/canonical.mjs \
     tests/lib/canonical.test.mjs \
     scripts/lib/loop-md.mjs \
     tests/lib/loop-md.test.mjs \
     scripts/lib/loop-state.mjs \
     scripts/lib/ledger.mjs \
     scripts/lib/fault.mjs \
     tests/lib/fault.test.mjs
```

- [ ] Own tests: `node --test tests/lib/git-safe.test.mjs tests/lib/atomic.test.mjs tests/lib/canonical.test.mjs tests/lib/loop-md.test.mjs tests/lib/fault.test.mjs`. Expected: `# pass 53`, `# fail 0`.
- [ ] Full suite: `# pass 321`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): foundation libraries for the clone and the patch helper`.

### Task 2: Scope rules, clone integrity and the start point

**Files (from the prototype):** `scripts/lib/loop-scope.mjs`, `tests/lib/loop-scope.test.mjs`, `scripts/lib/clone-check.mjs`, `tests/lib/clone-check.test.mjs`, `scripts/loop-start.mjs`, `tests/loop/loop-start.test.mjs`.
**Interfaces:** brief §6, §12, §13.1; rulings R11, R17, R27, R28; Appendix B (clone-check, loop-start).

- [ ] Land the files:

```bash
land scripts/lib/loop-scope.mjs \
     tests/lib/loop-scope.test.mjs \
     scripts/lib/clone-check.mjs \
     tests/lib/clone-check.test.mjs \
     scripts/loop-start.mjs \
     tests/loop/loop-start.test.mjs
```

- [ ] Own tests: `node --test tests/lib/loop-scope.test.mjs tests/lib/clone-check.test.mjs tests/loop/loop-start.test.mjs`. Expected: `# pass 86`, `# fail 0`.
- [ ] Full suite: `# pass 401`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): scope rules, clone integrity checks and a start point split into base and chain`.

### Task 3: Change sets

**Files (from the prototype):** `scripts/lib/changes.mjs`, `tests/lib/changes.test.mjs`.
**Interfaces:** brief §8; amendment A11; rulings R1, R2, R19-R21, R26, R29, R29a; Appendix B (changes).

- [ ] Land the files:

```bash
land scripts/lib/changes.mjs \
     tests/lib/changes.test.mjs
```

- [ ] Own tests: `node --test tests/lib/changes.test.mjs`. Expected: `# pass 25`, `# fail 0`.
- [ ] Full suite: `# pass 426`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): change sets under recorded ignore rules, with raw-byte capture`.

### Task 4: Run record and delivery bundles

**Files (from the prototype):** `scripts/lib/run-record.mjs`, `tests/lib/run-record.test.mjs`, `scripts/lib/delivery.mjs`, `tests/lib/delivery.test.mjs`.
**Interfaces:** brief §9, §13.7; rulings R3, R4, R11, R28, R31, R32; Appendix B (run-record, ownership).

- [ ] Land the files:

```bash
land scripts/lib/run-record.mjs \
     tests/lib/run-record.test.mjs \
     scripts/lib/delivery.mjs \
     tests/lib/delivery.test.mjs
```

- [ ] Own tests: `node --test tests/lib/run-record.test.mjs tests/lib/delivery.test.mjs`. Expected: `# pass 62`, `# fail 0`.
- [ ] Full suite: `# pass 488`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): per-firing run record, recovery verdict and delivery bundles`.

### Task 5: Firing lock and Codex changes

**Files (from the prototype):** `scripts/loop-lock.mjs`, `scripts/loop-codex.mjs`, `tests/lib/ledger.test.mjs`, `tests/loop/loop-clone-fixture.mjs`, `tests/loop/interrupt-fixture.mjs`, `tests/loop/loop-lock.test.mjs`, `tests/loop/loop-lock-exec.test.mjs`, `tests/loop/loop-lock-race.test.mjs`, `tests/loop/loop-codex.test.mjs`, `tests/loop/reflex-bundle-fixture.mjs`, `tests/lib/loop-proc.test.mjs`.
**Interfaces:** brief §16; Appendix B (git-safe, loop-proc, tests).
**Note:** The shared test fixtures land here because the lock tests import them; the fixed `loop-proc` test replaces the old flaky one.

- [ ] Land the files:

```bash
land scripts/loop-lock.mjs \
     scripts/loop-codex.mjs \
     tests/lib/ledger.test.mjs \
     tests/loop/loop-clone-fixture.mjs \
     tests/loop/interrupt-fixture.mjs \
     tests/loop/loop-lock.test.mjs \
     tests/loop/loop-lock-exec.test.mjs \
     tests/loop/loop-lock-race.test.mjs \
     tests/loop/loop-codex.test.mjs \
     tests/loop/reflex-bundle-fixture.mjs \
     tests/lib/loop-proc.test.mjs
```

- [ ] Own tests: `node --test tests/lib/ledger.test.mjs tests/loop/loop-lock.test.mjs tests/loop/loop-lock-exec.test.mjs tests/loop/loop-lock-race.test.mjs tests/loop/loop-codex.test.mjs tests/lib/loop-proc.test.mjs`. Expected: `# pass 163`, `# fail 0`.
- [ ] Full suite: `# pass 545`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(lock): acquire names the clone and floors the generation above run records`.

### Task 6: Patch helper

**Files (from the prototype):** `scripts/reflex-bundle.mjs`, `tests/loop/reflex-bundle.test.mjs`, `tests/loop/reflex-bundle-reset.test.mjs`, `tests/loop/reflex-bundle-apply.test.mjs`, `tests/loop/reflex-bundle-fault.test.mjs`.
**Interfaces:** brief §11; rulings R4-R6, R16, R19-R21, R24, R29, R31; Appendix B (reflex-bundle).

- [ ] Land the files:

```bash
land scripts/reflex-bundle.mjs \
     tests/loop/reflex-bundle.test.mjs \
     tests/loop/reflex-bundle-reset.test.mjs \
     tests/loop/reflex-bundle-apply.test.mjs \
     tests/loop/reflex-bundle-fault.test.mjs
```

- [ ] Own tests: `node --test tests/loop/reflex-bundle.test.mjs tests/loop/reflex-bundle-reset.test.mjs tests/loop/reflex-bundle-apply.test.mjs tests/loop/reflex-bundle-fault.test.mjs`. Expected: `# pass 45`, `# fail 0`.
- [ ] Full suite: `# pass 590`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): the shared patch helper: save, verify, reset and apply, never git stash`.

### Task 7: Owner review

**Files (from the prototype):** `scripts/loop-review.mjs`, `tests/loop/loop-review.test.mjs`.
**Interfaces:** brief §15; rulings R11, R27; Appendix B (loop-review).

- [ ] Land the files:

```bash
land scripts/loop-review.mjs \
     tests/loop/loop-review.test.mjs
```

- [ ] Own tests: `node --test tests/loop/loop-review.test.mjs`. Expected: `# pass 26`, `# fail 0`.
- [ ] Full suite: `# pass 616`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): owner review: fetch verified bundles and retire rejected work`.

### Task 8: Clone helper

**Files (from the prototype):** `scripts/loop-clone.mjs`, `tests/loop/loop-clone-create.test.mjs`, `tests/loop/loop-clone-check.test.mjs`, `tests/loop/loop-clone-close.test.mjs`, `tests/loop/loop-clone-guard.test.mjs`, `tests/loop/loop-clone-rules.test.mjs`.
**Interfaces:** brief §13; amendment A11; rulings R9, R10, R14, R15, R18, R25, R28, R30-R32; Appendix B (loop-clone).
**Note:** `tests/loop/loop-clone-prepare.test.mjs` lands in Task 9 with the planner it also exercises.

- [ ] Land the files:

```bash
land scripts/loop-clone.mjs \
     tests/loop/loop-clone-create.test.mjs \
     tests/loop/loop-clone-check.test.mjs \
     tests/loop/loop-clone-close.test.mjs \
     tests/loop/loop-clone-guard.test.mjs \
     tests/loop/loop-clone-rules.test.mjs
```

- [ ] Own tests: `node --test tests/loop/loop-clone-create.test.mjs tests/loop/loop-clone-check.test.mjs tests/loop/loop-clone-close.test.mjs tests/loop/loop-clone-guard.test.mjs tests/loop/loop-clone-rules.test.mjs`. Expected: `# pass 71`, `# fail 0`.
- [ ] Full suite: `# pass 687`, `# fail 0`. `node scripts/check.mjs`: `53 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(clone): the private clone: prepare, deps, check, commit, bundle, close`.

### Task 9: Planner, loop prose and checks

**Files (from the prototype):** `scripts/loop-recover.mjs`, `tests/loop/loop-recover.test.mjs`, `tests/lib/loop-state.test.mjs`, `skills/loop/SKILL.md`, `skills/loop/references/clone.md`, `skills/loop/references/loop-templates.md`, `README.md`, `scripts/checks/loop.mjs`, `tests/check.test.mjs`, `scripts/loop-text.mjs`, `tests/loop/loop-text.test.mjs`, `tests/loop/loop-clone-prepare.test.mjs`; remove `skills/loop/references/worktree.md`.
**Interfaces:** brief §14, §18-§21; rulings R5, R7, R12, R13, R22, R23; Appendix B (loop-recover, prose).
**Note:** `skills/loop/references/worktree.md` is removed with `git rm` (spec §9.2: replaced by the clone).

- [ ] Land the files:

```bash
land scripts/loop-recover.mjs \
     tests/loop/loop-recover.test.mjs \
     tests/lib/loop-state.test.mjs \
     skills/loop/SKILL.md \
     skills/loop/references/clone.md \
     skills/loop/references/loop-templates.md \
     README.md \
     scripts/checks/loop.mjs \
     tests/check.test.mjs \
     scripts/loop-text.mjs \
     tests/loop/loop-text.test.mjs \
     tests/loop/loop-clone-prepare.test.mjs
git rm -q skills/loop/references/worktree.md
```

- [ ] Own tests: `node --test tests/loop/loop-recover.test.mjs tests/lib/loop-state.test.mjs tests/check.test.mjs tests/loop/loop-text.test.mjs tests/loop/loop-clone-prepare.test.mjs`. Expected: `# pass 144`, `# fail 0`.
- [ ] Full suite: `# pass 780`, `# fail 0`. `node scripts/check.mjs`: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `feat(loop): work in the clone, save before every discard, recover interrupted firings`.

### Task 10: Interruption matrix

**Files (from the prototype):** `tests/fixtures/firing-driver.mjs`, `tests/loop/loop-interrupt.test.mjs`, `tests/loop/loop-interrupt-clone-commit.test.mjs`, `tests/loop/loop-interrupt-clone-driver.test.mjs`, `tests/loop/loop-interrupt-clone-live.test.mjs`, `tests/loop/loop-interrupt-clone-points.test.mjs`, `tests/loop/loop-interrupt-clone-prepare.test.mjs`, `tests/loop/loop-interrupt-clone-prose.test.mjs`, `tests/loop/loop-interrupt-clone-recover.test.mjs`, `tests/loop/loop-interrupt-clone-state.test.mjs`, `tests/loop/loop-interrupt-clone-tamper.test.mjs`.
**Interfaces:** brief §19 (fault points, driver stops, invariants I1-I8, matrix, live-child and tamper tables); rulings R8, R12.
**Note:** Run the full suite three times (real processes and timing); `pgrep -fl 'sleep 120'` prints nothing afterwards.

- [ ] Land the files:

```bash
land tests/fixtures/firing-driver.mjs \
     tests/loop/loop-interrupt.test.mjs \
     tests/loop/loop-interrupt-clone-commit.test.mjs \
     tests/loop/loop-interrupt-clone-driver.test.mjs \
     tests/loop/loop-interrupt-clone-live.test.mjs \
     tests/loop/loop-interrupt-clone-points.test.mjs \
     tests/loop/loop-interrupt-clone-prepare.test.mjs \
     tests/loop/loop-interrupt-clone-prose.test.mjs \
     tests/loop/loop-interrupt-clone-recover.test.mjs \
     tests/loop/loop-interrupt-clone-state.test.mjs \
     tests/loop/loop-interrupt-clone-tamper.test.mjs
```

- [ ] Own tests: `node --test tests/loop/loop-interrupt.test.mjs tests/loop/loop-interrupt-clone-commit.test.mjs tests/loop/loop-interrupt-clone-driver.test.mjs tests/loop/loop-interrupt-clone-live.test.mjs tests/loop/loop-interrupt-clone-points.test.mjs tests/loop/loop-interrupt-clone-prepare.test.mjs tests/loop/loop-interrupt-clone-prose.test.mjs tests/loop/loop-interrupt-clone-recover.test.mjs tests/loop/loop-interrupt-clone-state.test.mjs tests/loop/loop-interrupt-clone-tamper.test.mjs`. Expected: `# pass 98`, `# fail 0`.
- [ ] Full suite: `# pass 873`, `# fail 0`. `node scripts/check.mjs`: `63 passed, 0 failed, 0 warnings`.
- [ ] Commit (add exactly the landed paths): `test(clone): interruption at every persistence boundary, live children and tampered bundles`.

### Task 11: Version, acceptance and hand-off

- [ ] Set the version to 0.5.0 in `.claude-plugin/plugin.json` and in README's `**Version …**` line (the version check ties them). Commit: `0.5.0: System 1 stage 0c-2 (isolated clone, patch helper, recovery)`.
- [ ] Acceptance: from `/tmp`, `node <worktree>/scripts/check.mjs` gives `63 passed, 0 failed, 0 warnings`; the full suite gives `# pass 873` three times; the tree is clean; `git diff --stat be11c0d` against the prototype shows only the version lines.
- [ ] Closing review, three seats that do not see each other: the `code-review` skill at `high` on `feat/system1-design...feat/s1-0c2-clone`; a fresh `general-purpose` reviewer on `opus` with superpowers' `code-reviewer.md` and this plan's Review Focus; Codex from the main session (`codex exec --skip-git-repo-check -s read-only -C <worktree> -o <durable file> "…" < /dev/null`, after a `Reply with exactly: OK` probe), split by module group as the prototype review was.
- [ ] Verify every finding against the code; fix confirmed ones test-first in one pass; record rulings and deferred minors.
- [ ] Ask the owner how to integrate: PR to `main` (as stages 0a-0c-1 were), merge locally, or keep (superpowers:finishing-a-development-branch).

---

## Appendix A: the architecture brief

`docs/superpowers/plans/2026-10-03-stage-0c2-brief.md`, committed with this plan: brief v2 (rulings R1-R23 and amendment A11) plus the addendum of review rulings R24-R32 and R29a. It is the specification; where the landed code differs, Appendix B records the difference.

## Appendix B: deviations from the brief, as built (each a ruling)

- Ownership: delivery bundles have their own owner `scripts/lib/delivery.mjs` (the brief put them inside loop-clone), shared by loop-clone, the planner and loop-review; `checkClone`, `cloneMeta` and `refsSnapshot` live in `scripts/lib/clone-check.mjs` and are re-exported by loop-clone; `nowLine`/`PLACEHOLDER` move to `scripts/lib/loop-state.mjs` and `ledgerFloor` to `scripts/lib/ledger.mjs`, each re-exported by its old module; loop-review also imports loop-start (base resolution) and delivery.
- git-safe: `workGit` adds `--no-ext-diff --no-textconv` itself for diff, log and show; it runs a structural check of git storage (no symlink or wrong kind in objects, refs, logs, packed-refs, index, HEAD, config) before every spawn; `GIT_TRACE*` is scrubbed and `GIT_TRACE2*` pinned to 0; `submodule.recurse=false`; `attrSourceWorks`/`assertAttrSource` implement R24 (refusal `infra` `git-too-old: needs git 2.40 or newer`).
- atomic: modes are forced with fchmod; `sweepTemps` returns absolute paths and removes a dead pid's temp directory only one level deep; `commitExclusive` treats a symlink at the target as an integrity failure.
- changes: every converting git call runs with filter drivers emptied and attributes from the base (`GIT_ATTR_SOURCE`); raw edits a conversion hides are found by comparing with a `checkout-index` of the base into a temp directory (R29), except bytes equal to the base blob (R29a); an obstruction in either direction is saved whatever the ignore rules say (R21 and its mirror); `unsavable` is an overlay on the tracked and untracked lists; change detection uses `--ignore-submodules=dirty` (R26).
- run-record: a strict schema checked on write and on read; `updateRecord` merges recovery and save anchors and refuses an update that would drop one; `cloneVerdict` returns objects, judges only the owner record (`ownerRecord`: the newest unresolved record that is not a bare preparing record), and rewinds a tip that descends from the record's own commit to that commit, not below it; `vettedTip` trusts a record's commit, ledgered commits and bundle tips, explicit `adopted` entries (R28) and containment in the base, never a refs snapshot.
- reflex-bundle: the rules a save used are kept as `patches/rules-<sha>.json` (a reset after a kill lists under exactly those rules); the diff is pinned against user config (attributes off, myers, fixed compression); a re-save with the same sha and why does not append twice; the save CLI refuses `head-moved`; `apply` writes raw bytes with attributes, filters and eol conversion off, from a refreshed temporary index with the same settings (no racy-git refusal); `CLONE_INVALID` maps to exit 3 `clone-invalid` as in loop-clone.
- loop-clone: no-record leftovers are listed under the rules the last close anchored in `<V>/run/refs.json` (`{v:2, generation, refs, rules}`), current rules when it holds none, base rules only before any close (R25); `close` keeps a record with reason `dirty`, `hidden` (R25), `adopted` (R32, without holding back newer records) or `no-clone-facts` (it quiesces Codex itself before reading `<W>`); the tamper check skips only a record without `head_ref`; rotation uses `--no-overwrite-ignore` (R30) and resets today's branch when it is retired or unvetted; every lock check sits right before the write it guards (sharpened R31); deps marker digest over a fixed list of root lockfiles; the passthrough requires the subcommand first.
- loop-recover: judges clone dirtiness with git's standard listing (a recorded-rules replay would need a temporary index, a write); filters are neutralized and submodules not entered for the clone and the legacy worktree; a delivery-inspection failure is exit 2, never a silent plan.
- loop-review: each bundle is copied to a private directory before it is checked and fetched; its pack is checked in a private repository of `<P>`'s object format before `current` can be reported; `retire` keeps an earlier rejection under `<branch>@<sha12>` (R27); a retirement the base contains no longer withholds work (R11); fetch disables auto-maintenance in `<P>`.
- prose: R22 is applied once after the last (or first failing) verify command, restarting all verify commands from K = 0 on a changed digest; a Backlog `recovery:` field is used by the `codex` and `pause` callers; a planner exit 2 first moves the `## Now` item back to the top of `## Backlog`; the discard check exempts a destructive command only when a prohibition in the same clause governs it; nine new checks (63 in all) each with a mutation test.
- tests: shared fixtures `tests/loop/{loop-clone,reflex-bundle,interrupt}-fixture.mjs`; every test cleanup kill is fenced by the recorded start token (a reused pid or group is never signalled); the interruption matrix is split into nine files and drives the real helpers through the extended firing driver.

## Appendix C: rulings and what each costs if wrong

The full text is in the brief (R1-R23, §0) and its addendum (R24-R32, R29a). Costs, in short:

- A11 / R1 (recorded-rules listing through an index replay): a git change that stops reading skip-worktree exclude files from the index fails a pinned test loudly.
- R2 (two listings): a delegate can keep a file out of a commit by hiding it, never out of a save.
- R3 (run record in `<V>` until stage 2): a delegate can forge it before stage 2 (§15 class).
- R5 (record as the reset anchor): a kill between save and the STATE edit loses the flag outcome; the item reruns, the sha reaches the ledger.
- R6 (minimal same-base `apply`): stage 3 must add the moved-base allowance.
- R7 (`.tech-lead/` in the clone is out of scope): a delegate touching the stale committed copy fails the attempt.
- R8 (named fault points): one env-gated no-op call per boundary in production code.
- R9 (commit-tree, hooks never run, `<P>`'s identity): project hooks' checks must move into `verify:`.
- R10 (coexist with a legacy `<S>/worktree`): disk for both until 0c-4 retires it.
- R11 / R27 (retire, never dropped): an earlier rejection stays binding until the base contains it.
- R12 (no commit on a dead firing's behalf): verified work reruns.
- R16 (512 MiB cap, no pruning): bundles accumulate in `<V>`.
- R19 / R29 / R29a (raw bytes): bytes equal to the base blob are not re-saved; a commit still applies the owner's check-in conversion.
- R20 (index-only content pauses): the owner resolves it by hand (README row).
- R22 (verify restart once): a verify that rewrites files twice fails the attempt.
- R24 (git 2.40 floor by feature test): older git refuses instead of running unisolated.
- R25 (rules survive close): verify-created self-ignored caches not in the base `.gitignore` are bundled and removed at the next prepare (owner remedy: list them in `.gitignore`).
- R26 (never inside nested repositories): dirty content inside a populated submodule is neither saved nor reset.
- R28 / R32 (explicit vetting, adopted continuity): a creating record can linger until its adopted tips are ledgered or merged.
- R30 (no overwrite of ignored files): a rotation that would collide pauses for the owner.
- R31 (lock re-check before every destructive step): a `not-holder` from delivery can leave a published bundle without its sidecar, which the next sync rewrites.
- Process ruling: the tasks land the reviewed prototype instead of re-typing it (as in 0c-1); each module's red step happened in the prototype builds and fix passes.


## Appendix D: residual risks and deferred minors

Residual risks (named for the owner): a forged run record before stage 2 (R3); a delegate that forgets `cd <W>` writes `<P>` undetected before stage 2; project hooks no longer run; `<P>`'s repository config, submodule contents and LFS objects are not carried into the clone; disk use doubles and a huge first clone can pass 540 s (an `infra` pause); a purged cache loses unfetched work; a git upgrade writing new config keys gives a false `clone-invalid`; git lock removal relies on the cwd sweep; `.prev`, orphaned and anchored bundles accumulate in `<V>`; writes to ignored paths outside obstructions, or inside a submodule, are neither saved nor reset; verify-created caches are bundled each firing unless the base ignores them (R25); darwin's one-second `lstart` lets a pid reused within the same second pass a test fence; §15's lock-integrity residual is unchanged.

Deferred minors: unpinned lower-value guards (loop-review's retire compare-and-swap, finish-commit's ledger-tips clause, verify's path-list check, resetFor's rules-sha check); R31 hardening asserts in commit, check, rewind, gc and lock-file removal that only timing can test; the discard check flags a few correct prohibitions that use a comma or "ever" (authors rephrase); the planner withholds `write-bundle` for a squash-merged retired tip (conservative); a `CLONE_INVALID` raised inside a reset after its intent is reported `partial`; the git-version message names 2.40 while the probe tests the capability; from 0c-1, a `<V>` wiped during a firing can still repeat that firing's generation, and same-process concurrent firings are not excluded.
