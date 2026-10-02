# Stage 0c-1: Foundation and Firing Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the loop a firing lock that lets one firing at a time work on a project, takes over safely from an interrupted firing, and kills only processes it can prove are its own; plus the shared foundation modules every later stage 0c plan imports.

**Architecture:** One owner module per concern (spec §10): `scripts/lib/atomic.mjs` (records that readers never see half-written), `scripts/lib/git-safe.mjs` (the loop's own git calls without hooks or inherited `GIT_*`), `scripts/lib/loop-proc.mjs` (process identity by pid plus start token), `scripts/lib/loop-paths.mjs` (`<key>`, `<V>` and its identity check), `scripts/loop-lock.mjs` (the lock, its exec wrapper and dispatch records), `scripts/loop-recover.mjs` (a read-only recovery planner skeleton), and `scripts/checks/loop.mjs` (checks that the loop prose calls them). The loop prose runs them as `node <T>/scripts/…`, as stage 0b's helpers are run.

**Tech Stack:** Node.js 22 (ESM `.mjs`, `node:test`), git 2.38 or later, macOS or Linux process facts (`ps`, `/proc`). No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-system1-layer-design.md`, revision 6 (commit eb3e400): §3 (`<key>`, top level), §4, §10 row 0c-1, §11 (stage 0c contracts), §15 (lock integrity), §16.

## How this plan was produced, and how it is executed

The code this plan lands already exists, built test-first and reviewed:

1. A design run (7 researchers, 7 designers, 2 critics) produced per-component designs; the owner approved the amendment set they implied (spec revision 6).
2. The tech lead wrote the binding architecture brief (Appendix A) for 0c-1.
3. A prototype workflow built every module test-first in a scratch copy (each build saw its tests fail before writing code), then five reviewers attacked it (concurrency, interruption, process safety, spec fidelity, test quality). 15 important findings were confirmed and fixed, each with a test that failed first.
4. The tech lead re-graded the 20 remaining minors by effect, fixed four of them test-first (Appendix C), and ran the full suite three times: 226 of 226 tests, check.mjs 46 of 0, no leaked processes.
5. A landing dry run in a fresh copy of the base landed the tasks in order: every intermediate state was green (the counts below are measured), and the final tree equals the prototype file for file.

The prototype lives at `<scratchpad>/proto-0c1/` with a backup at `<scratchpad>/proto-0c1-final.tgz` (`<scratchpad>` is this session's scratchpad directory). Re-typing 4,700 lines of tested code into this document would only add transcription risk, so each task below **lands** its files from the prototype into the stage worktree, verifies them with their own tests and the full suite, and commits. If the prototype is lost, Appendix A plus Appendix B are the specification to rebuild it from, test-first.

## Global Constraints

- No dependencies; Node 22; ASCII-only code (the Bash and Write tools decode `\uXXXX` escapes into raw characters, so code is copied as files, never re-typed).
- Nothing new under `workflows/`.
- Tests: `node --test "tests/**/*.test.mjs"`; checks: `node scripts/check.mjs`.
- Work in the worktree `.worktrees/s1-0c1-lock` on branch `feat/s1-0c1-lock` from `feat/system1-design` (`.worktrees/` is ignored through `.git/info/exclude`; the main checkout is the live plugin install).
- In stage 0c-1 the loop still works in `<S>/worktree`; `<V>/clone` (and `W` in any output) arrives with 0c-2.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No merge, push or PR without the owner.

## Review Focus (for the closing review)

- Two firings started within milliseconds of each other on one project: exactly one acquires; neither writes the spine while held.
- A firing killed (SIGKILL) between any two of its writes: the next firing reclaims, stops what the dead one left running, and never repeats a generation.
- A pid or process group number reused by an unrelated process, a zombie, `ps` failing on a live pid, an unreadable start token: nothing that is not provably ours is ever signalled, and unknown liveness blocks the reclaim instead of passing it.
- A background agent still running after an interrupted in-session firing: the same Claude process does not take the lock over while its dispatch record is open.
- A command that outlives the Bash tool's limit, or leaves grandchildren behind: the exec wrapper's group kill and its timeout below the Bash limit.

---

### Task 0: Preflight

- [ ] **Step 1:** `git -C /Users/macbook/.claude/skills/tech-lead status --porcelain` prints nothing; the branch is `feat/system1-design`.
- [ ] **Step 2:** create the worktree and check the baseline:

```bash
cd /Users/macbook/.claude/skills/tech-lead
git worktree add .worktrees/s1-0c1-lock -b feat/s1-0c1-lock feat/system1-design
cd .worktrees/s1-0c1-lock
node scripts/check.mjs | tail -1
node --test "tests/**/*.test.mjs" 2>&1 | grep -E '^# (pass|fail)'
```

Expected: `39 passed, 0 failed, 0 warnings`; `# pass 119`, `# fail 0`.

In every later task, `PROTO` is `<scratchpad>/proto-0c1` and commands run in the worktree. A landing step is `cp "$PROTO/<file>" <file>` for each listed file (creating parent directories), followed by the task's tests.

### Task 1: Atomic records

**Files:** create `scripts/lib/atomic.mjs`, `tests/lib/atomic.test.mjs`.
**Interfaces:** Appendix A §1, plus the Appendix B ruling on non-object JSON.

- [ ] Land both files. Run `node --test tests/lib/atomic.test.mjs`. Expected: `# pass 5`, `# fail 0`.
- [ ] Run the full suite: `# pass 124`, `# fail 0`.
- [ ] Commit: `feat(lock): atomic records that readers never see half-written`.

### Task 2: Safe git runner

**Files:** create `scripts/lib/git-safe.mjs`, `tests/lib/git-safe.test.mjs`.
**Interfaces:** Appendix A §4.

- [ ] Land both files. `node --test tests/lib/git-safe.test.mjs`: `# pass 7`, `# fail 0`. Full suite: `# pass 131`.
- [ ] Commit: `feat(lock): git runner without hooks, fsmonitor or inherited GIT_*`.

### Task 3: Process facts

**Files:** create `scripts/lib/loop-proc.mjs`, `tests/lib/loop-proc.test.mjs`.
**Interfaces:** Appendix A §2, plus the Appendix B rulings (parseProcStat, malformed records, pgid bounds, holder override, `/bin/ps` path, `commandLine`) and Appendix C fix 1.

- [ ] Land both files. `node --test tests/lib/loop-proc.test.mjs`: `# pass 15`, `# fail 0`. Full suite: `# pass 146`.
- [ ] Commit: `feat(lock): process identity by pid and start token`.

### Task 4: Paths, key and identity

**Files:** create `scripts/lib/loop-paths.mjs`, `tests/lib/loop-paths.test.mjs`.
**Interfaces:** Appendix A §3, plus the Appendix B rulings (keyOf, absolute cache root, missing P, toplevel through safeGit).

- [ ] Land both files. `node --test tests/lib/loop-paths.test.mjs`: `# pass 11`, `# fail 0`. Full suite: `# pass 157`.
- [ ] Commit: `feat(lock): <key>, <V> and the identity check (spec §3)`.

### Task 5: The firing lock and Codex registration

**Files:** create `scripts/loop-lock.mjs`, `tests/loop/loop-lock.test.mjs`, `tests/loop/loop-lock-race.test.mjs`, `tests/fixtures/codex/app-server-broker.mjs`; modify `scripts/loop-codex.mjs`, `tests/loop/loop-codex.test.mjs`, `tests/fixtures/codex/scripts/codex-companion.mjs`.
**Interfaces:** Appendix A §5 and §6, plus the Appendix B lock rulings and Appendix C fixes 2 and 3.

- [ ] Land the files. Run `node --test tests/loop/loop-lock.test.mjs tests/loop/loop-lock-race.test.mjs tests/loop/loop-codex.test.mjs`: `# pass 45`, `# fail 0` (25 + 2 + 18).
- [ ] Full suite: `# pass 189`, `# fail 0`.
- [ ] Commit: `feat(lock): firing lock with reclaim, dispatch records and Codex children`.

### Task 6: The exec wrapper and interruption tests

**Files:** create `tests/loop/loop-lock-exec.test.mjs`, `tests/loop/loop-interrupt.test.mjs`, `tests/fixtures/firing-driver.mjs`, `tests/fixtures/spawn-hook.cjs`. (The exec code is in `scripts/loop-lock.mjs`, landed in Task 5.)

- [ ] Land the files. `node --test tests/loop/loop-lock-exec.test.mjs tests/loop/loop-interrupt.test.mjs`: `# pass 18`, `# fail 0` (14 + 4).
- [ ] Full suite: `# pass 207`.
- [ ] Commit: `test(lock): exec wrapper and interruption at every persistence boundary`.

### Task 7: Recovery planner skeleton

**Files:** create `scripts/loop-recover.mjs`, `tests/loop/loop-recover.test.mjs`.
**Interfaces:** Appendix A §7, plus the Appendix B recover rulings.

- [ ] Land both files. `node --test tests/loop/loop-recover.test.mjs`: `# pass 11`, `# fail 0`. Full suite: `# pass 218`.
- [ ] Commit: `feat(lock): read-only recovery planner skeleton`.

### Task 8: Prose wiring and its checks

**Files:** create `scripts/checks/loop.mjs`; modify `scripts/check.mjs`, `scripts/checks/repo.mjs`, `tests/check.test.mjs`, `skills/loop/SKILL.md`, `skills/loop/references/worktree.md`, `skills/loop/references/loop-templates.md`, `README.md`.
**Interfaces:** Appendix A §8 and §9, plus the Appendix B prose rulings and Appendix C fix 4.

- [ ] Land the files. `node scripts/check.mjs`: `46 passed, 0 failed, 0 warnings`. `node --test tests/check.test.mjs`: `# pass 24`, `# fail 0`.
- [ ] Full suite: `# pass 226`, `# fail 0`; run it three times (the lock tests use real processes and timing).
- [ ] `pgrep -f 'sleep 120'` prints nothing afterwards.
- [ ] Commit: `feat(loop): take the firing lock, bracket dispatches, run verify and installs through exec`.

### Task 9: Acceptance and hand-off

- [ ] Acceptance: from `/tmp`, `node <worktree>/scripts/check.mjs` gives 46/0; the suite gives 226/226 three times; the tree is clean.
- [ ] Closing review, three seats that do not see each other: the `code-review` skill at `high` on `feat/system1-design...feat/s1-0c1-lock`; a fresh `general-purpose` reviewer on `opus` with superpowers' `code-reviewer.md`, given this plan's Review Focus; Codex from the main session (`codex exec --skip-git-repo-check -s read-only -c model_reasoning_effort=xhigh -C <worktree> -o <scratchpad>/codex-0c1-review.md "…" < /dev/null`, after a `Reply with exactly: OK` probe).
- [ ] Verify every finding against the code; fix confirmed ones test-first in one pass.
- [ ] Ask the owner: merge locally into `feat/system1-design`, push and PR, or keep (superpowers:finishing-a-development-branch).

---

## Appendix A: the architecture brief

The binding brief is `<scratchpad>/0c1-brief.md`, written before the prototype; it is copied
verbatim into this repository as `docs/superpowers/plans/2026-10-01-stage-0c1-brief.md` in the
same commit as this plan, so the specification survives the scratchpad.

## Appendix B: deviations from the brief, as built (each a ruling)

- atomic: `readJson` also throws `corrupt` for JSON that is not an object (`null`, numbers, strings, arrays), so `null` content never reads as a missing record.
- proc: `parseProcStat` is exported to test the Linux parser on macOS; a malformed or start-less holder record reads as unknown (fail closed); `groupAlive`/`killGroup` refuse a pgid that is not an integer above 1 (`-0` and `-1` would signal the caller's group or every process); a set but dead `TECH_LEAD_HOLDER_PID` never falls back to `CLAUDE_PID`; `ps` runs by absolute path with a 10 s timeout; `commandLine(pid)` added for the Codex quiesce owner check.
- paths: `keyOf(R)` exported; a relative `TECH_LEAD_CACHE` is refused; a missing `<P>` is `not-a-repo`; the top-level probe goes through `safeGit`, so an inherited `GIT_DIR` cannot fool it.
- lock: `resolveHolder` runs before `ensureV`, so a firing with no holder writes nothing; a parseable but malformed slot is held `corrupt`; a pending proc record whose wrapper is gone blocks the reclaim unless the record is `gated` (the command starts only after its group is on record, so a gated pending record ran nothing); acquire sweeps the children of every generation up to the last, not only an unreleased last one (an owner release stops nothing, so its children are stopped by the next acquire); release refuses while a dispatch of its generation is open (exit 3 `dispatch-open`); Codex records carry their `starter` and are quiesced only once the starter is gone; outputs carry more fields than the brief lists; owner release errors are `needs-terminal`, `not-confirmed`, `not-current`; `closeDispatch` of an unknown id is an error.
- exec: `verifyCommands(text)` exported; its own exit codes 2 (usage), 126/127 (cannot start); its poll also stops on a released or superseded generation; `assertHeld` is checked again between the pending record and the spawn; the record is rewritten twice after the spawn; the status line carries generation and label.
- codex: `loop-codex.mjs` imports `loop-lock.mjs` statically (a dynamic import back into a module with a pending top-level await deadlocks); a missing companion is detected before registration; quiesce signals no pid the companion's state names once that pid is gone or runs another command.
- recover: refuses a `--worktree` that is not its own working-tree top level, or that resolves to `<P>`; a missing `STATE.md` is an error, not `now: null`.
- prose: the verify and install checks are separate; the Codex-start check requires `--project` and `--generation`; the `git stash` check also matches `git -C … stash`; `docFiles(root)` is shared between the repo and loop checks; a "Lost lock" rule stops a firing whose lock was taken over; verify and installs pass `--timeout-ms` below the Bash tool's limit (a Bash call that reaches its limit is backgrounded, not killed).

## Appendix C: minors re-graded and fixed by the tech lead (each test-first)

1. `ps` exits 1 for its own errors as well as for a missing pid; a non-zero exit is now `gone` only when `kill(pid, 0)` agrees, else `unknown` (both `startToken` and `commandLine`). Test: "a live pid that ps fails to read is unknown, never gone" (TECH_LEAD_PS points at a fake `ps`).
2. A proc record whose live leader has no recorded start, or an unreadable token, can no longer be verified, so it blocks the reclaim and is never signalled. Test: "a proc record whose live leader has no recorded start cannot be verified…".
3. `acquire` no longer prints `W` (it named `<V>/clone`, which does not exist until 0c-2, while the 0c-1 loop works in `<S>/worktree`).
4. The prose names both ledger exceptions (ending at the lock, losing it) the same way in §1 and §8.

## Appendix D: deferred minors

- A release racing an exiting holder is labelled `dead-holder` instead of `same-process` (cosmetic).
- A `<V>` wiped *during* a firing can repeat that firing's generation (the floor comes from the ledger, which the in-flight firing has not written).
- Same-process reclaim gives no exclusion between two firings run concurrently inside one Claude process (Claude Code runs in-session firings one at a time; subagents share the holder identity).
- No `fsync` before link or rename: after power loss a record can come back empty, which reads as `corrupt` and holds the lock until the owner releases it.
- Acquire lists the children once; a child registered by a same-process holder during the stop window is not seen until the next firing.
- The verify prose counts exec `state: error` as an attempt failure; the verify check asserts one exec line rather than every verify item.
- Tests: the release-while-exec test does not assert the wrapper; one loop-codex `setCodexJob` failure branch is untested; the "resolveHolder before ensureV" comment is untested; git-safe's env scrub test covers three of the scrubbed variables; some lock tests set no per-test timeout.
- `loop-codex start` checks the companion before the holder, so a non-holder without Codex gets `unavailable` instead of `not-holder`.
