# Stage 0c-4 architecture brief: spine untracking, the branch-switch guard, the 0c migration, the scope gate, bootstrap, quick (v2)

Spec: `docs/superpowers/specs/2026-09-30-system1-layer-design.md` revision 8 (cited `spec:<line>`).
§10 row 0c-4 (spec:1096): "Spine untracking (loop02) and the branch-switch guard (§4); the stage 0c
steps of the §9.1 migration with `spine_version:`; the scope validator (§4) in bootstrap, the
migration and a loop §2 gate, refusing `./` and every other whole-repository spelling, absolute
paths and `..` (loop07); bootstrap no longer commits, writes `spine_version:` and records itself in
`## Last run`; the quick skill's target-tree check (§9.2). | Each migration case has a passing
test." Base: main 7bc9ade (0.6.0); this stage ships 0.7.0.

Inputs: the tech lead's rulings `.worktrees/_0c4-work/rulings-v1.md` (binding; R1-R16 below carry
their numbers); the reader reports `.worktrees/_0c4-work/0c4-in-{spec,prose,code,design,downstream}.md`
(cited `spec-rep`, `prose-rep`, `code-rep`, `design-rep`, `down-rep` with their item ids); the
merged briefs `docs/superpowers/plans/2026-10-03-stage-0c2-brief.md` (`0c2-brief:<line>`) and
`2026-10-04-stage-0c3-brief.md` (`0c3-brief:<line>`). Rulings marked **(drafter)** answer questions
the tech lead's rulings leave open; the tech lead reviews them before the prototype.

v2 revises v1 (kept as `.worktrees/_0c4-work/0c4-brief-v1.md`) against the Codex reviews
`codex-brief-g1.md` and `codex-brief-g2.md`, the Claude five-lens review with skeptics
`claude-brief-review.json` (entries with `holds: true`, each with the skeptic's better fix), and the
tech lead's five decisions for this revision: (1) the spec's literal text over an amendment (no
origin offer, record-only recognition of the untrack step's partial state, a kept worktree leaves
the migration pending); (2) the tracked/lost/regressed guard runs right before every
governance-write sequence (R35); (3) every destructive step persists its intent before destroying,
resumes against the original record, and keeps every save reference (R38); (4) every other held
finding fixed at its cause, the more cautious option when unsure; (5) a fix that needs a spec
contract change is a proposed amendment, never adopted silently. §12 maps every finding to its fix.
Rulings new in v2 are R35-R44; rulings v2 changed carry "(v2)" after their title.

Conventions (as 0c-2 and 0c-3): Node 22 ESM `.mjs`, no npm dependencies; `node:test` +
`node:assert/strict`; tests `node --test "tests/**/*.test.mjs"`; checks `node scripts/check.mjs`.
Helper CLIs print exactly one JSON line and exit 0 (ok), 2 (`{state:'error', detail}`: usage,
setup, git or I/O failure; nothing destructive done unless `partial: true`), 3 (refused; `state`
names why; nothing changed unless stated). Not the holder is exit 3 `{state:'not-holder', detail}`
in every lock-checked command. Every mutating entry takes `--generation <N>`, calls
`assertHeld(paths, N, env)` before its first write and again immediately before each destructive
step (0c-2 R31 sharpened), and `process.chdir(paths.V)` first. git in `<P>` runs through
`safeGit(R, ...)` with `GIT_LITERAL_PATHSPECS=1` in `opts.env`. Fault points are
`fault('<helper>:<step>')` (`scripts/lib/fault.mjs`). Files in `<V>` are written only through
`atomic.mjs` (`storageDir(V, dir, {create:true})`, `createExclusive`, `writeReplace`). Code is
ASCII. Work only in `.worktrees/`; the main checkout is the live plugin install.

## Not in 0c-4

- Stage 1: its §9.1 steps (journals into `<V>`, the `triage:` mapping and removal, `--init-policy`),
  `SPINE.json` v2 and regression judged against `CHAIN.json` (spec:246-250), bootstrap's
  `--init-policy` step.
- Stage 2: runner settings and the sandbox; running the migration, bootstrap or the restore inside
  a sandboxed runner session (R14 records why they cannot); the §7.8 manifest entries for
  `<V>/spine` and `<V>/migration`; governance hashing; detecting a delegate's write to the live
  spine (spec:1225-1228; the anchor detects checkout damage, not delegate edits, spec-rep R1).
- Stage 3: applying a migration bundle through the release path (`apply`'s moved-base allowance).
- Stage 0' (loop13, loop14): quick's undefined `<repo>` and `<tmpdir>` placeholders and its other
  git hygiene. 0c-4 changes only the tracked-spine trigger and the switch path.
- `missingOrigin: 'human'` (R11), an owner `--reanchor` command, per-firing checks of other
  branches' ignore rules (residual, §11), monorepo subdirectory spines (refused, spec:152-156).

## Spec amendments

None. Every ruling below fits revision 8. Six rulings are read against spec text, and the brief
states the reading so the tech lead can confirm or bring an amendment instead:

1. R13 says quick "refuses" when the target tree or the index tracks `.tech-lead/`. Spec §9.2
   (spec:1070-1072): "Quick therefore inspects the target tree, and works in a separate worktree
   when the current or the target tree tracks `.tech-lead/`." The brief reads R13 as refusing the
   **in-place switch** and taking the separate-worktree path, which the spec requires. A literal
   refusal of the whole run would contradict §9.2 and need an amendment.
2. R8 says bootstrap, finding `<V>/spine` for the project, "offers the interactive restore
   instead". Spec §4 (spec:238-240) restores "only when the copy still matches `SPINE.json`", and
   `SPINE.json` lives in `<S>`, so it is gone whenever bootstrap is reached (`<S>` missing, or
   `<S>` holding no `LOOP.md` and no `SPINE.json`). No conforming restore exists then. The brief
   reads "offers the restore" as: bootstrap refuses and gives the owner the copy's path and the
   README's manual restore (R8, R18). A loop-performed restore without `SPINE.json` would need an
   amendment.
3. R4 step 1 has the owner fix `scope:` "in conversation" before the untracking, while spec §4
   (spec:242-245) forbids "any governance write" over a tracked spine "and a confirmation never
   bypasses this". The brief has the owner edit `LOOP.md` by hand while the spine is tracked; the
   loop writes nothing there until the untracking is done (R21).
4. (v2, decision 1) R4 step 4's offer to write `origin: loop from <analysis id>` on legacy
   follow-ups is dropped: spec:1030-1031 says "an item with no `origin:` line gets `unknown`", and
   R11 keeps missing origins `unknown`. The ledger's legacy analysis/follow-up pairs appear in
   `## Last run` as hints only (R4, R24); nothing rewrites an origin.
5. (v2, decision 1) The untrack step recognizes its own partial state only from its record:
   spec:1015-1017 ("the step's own state, recorded in `<V>/migration/`, is recognized before these
   checks"). Without a record, staged changes refuse `index-dirty` with the restore remedy (R22).
   A commit already made is still detected from git facts (spec:1017: "a migration commit already
   made is detected and not repeated").
6. (v2, decision 1) A worktree that git refuses to remove leaves the migration pending: the stage 0c
   step is to "retire the old worktree" (spec:1024-1027), and `spine_version:` records "the last
   stage whose migration completed" (spec:1001-1002). The version step needs the worktree phase
   `removed` or `skipped`; `plan` offers the removal again on every interactive firing (R25).

No v2 fix needs a spec contract change, so no amendment A13 or later is proposed. Every new
verdict, exit and record in v2 is stricter than revision 8's text and lives at plan level (the
named no-write exits, the `partial`, `unanchored` and `restore-pending` verdicts, the carried
reclaim notes, the scope re-check at check and commit).

## 0. Rulings (binding for the prototype; the plan records each with its cost)

**R1. Interactive and scheduled firings (v2).** A firing is **interactive** when the owner invoked the
loop in this session: the owner typed `/tech-lead:loop [path]` or asked for it in words. It is
**scheduled** when it runs from a cron or `/loop` prompt: the turn began with
`Run /tech-lead:loop <path>` (cron, launchd, a CronCreate job, `claude -p`), or it is a `/loop`
firing or wakeup (`/loop` dynamic mode counts as scheduled even in an attended session). The
migration (`references/migration.md`) and every spine restore run only in interactive firings. A
scheduled firing that needs either ends at §1 without writing (R2) and prints exactly
`migration needs an interactive run` or `spine needs an interactive restore`. SKILL.md §1 step 1
gains the definition as a bullet; bootstrap.md's "Who is attending" points to it. When the firing
cannot tell, it is scheduled (R31). (v2) `Run /tech-lead:loop <P>` is the only supported
scheduled prompt: the Runners prose and SKILL.md:30-31 name it, and a cron or `/loop` prompt that
types `/tech-lead:loop` directly is unsupported (README). Because a misspelled scheduled prompt
would read as interactive, every interactive-only write asks the owner one plain question in this
session first (the migration's yeses, the restore, bootstrap's confirmation, the exposed repair
R32, the anchor firing R37); an unanswered question writes nothing. Cost if wrong: an owner who
wants to migrate from `/loop` must run one plain `/tech-lead:loop` first.

**R2. Named no-write exits (v2).** Each of these ends the firing at §1 step 4, after the lock was
acquired: a tracked spine (HEAD or the index tracks a path under `.tech-lead/`) in any firing (in
an interactive one the exit hands over to the migration, R17); a lost, regressed,
`restore-pending` or `anchor-invalid` spine in a scheduled firing; a missing or older
`spine_version:` in a scheduled firing; an `absent`, `partial` or `unanchored` spine in a scheduled
firing (printing `spine needs an interactive run (missing)` or
`spine needs an interactive run (unanchored)`, R37); an unknown `spine_version:` or a
`loop-spine.mjs status` exit 2 in any firing; an `exposed` spine in a scheduled firing (R9); and the
interactive outcomes R17, R18 and R37 add (a declined or refused restore, the restore itself, the
anchor firing, the hand-over to bootstrap or to the migration). (v2) A guard hit later in the
firing (R35) takes the same exit. `<S>` missing in a scheduled firing (§1 step 2, before any lock)
stops the runner and prints `spine needs an interactive run (missing)`; there is no lock to release.
A no-write exit writes nothing in `<S>` (no `## Last run`, no ledger row, no `SPINE.json`; the
confirmed restore writes only the restored files, R18, and the anchor firing only `SPINE.json`,
R37), releases the lock (`loop-lock.mjs release <P> --generation <N> --carry`, with no
`loop-clone.mjs close`; a run record left open is the next firing's 0c-2 recovery), and stops the
runner (CronDelete in a CronCreate session, `ScheduleWakeup({stop: true})` in `/loop`; an OS cron
job cannot be stopped from inside, so the printed reason is the record) with a printed reason.
(v2) The printed reason includes acquire's `reclaimed` (generation, how) and `stopped` facts, and
`--carry` keeps them in the lock record so the next writing firing notes them in `## Last run`
(R36), which keeps spec 0c-1's "a same-process reclaim is noted in `## Last run`" (spec:1093).
The hand-overs to bootstrap and migration are interactive and stop nothing. These exits join "the
only exceptions" to the ledger rule
wherever that text appears: SKILL.md §1 step 3 (:60-61) and §8 step 2 (:846-847),
`loop-templates.md` (:285-289), README "The firing lock" (:687-688), and the check
`scripts/checks/loop.mjs:366-386` (§7 C7). Cost if wrong: a stuck scheduled runner stops instead
of retrying, and the owner sees only the printed reason.

**R3. Migration form (v2).** The procedure is prose in a new `skills/loop/references/migration.md`,
driven by a new helper `scripts/loop-migrate.mjs`: `plan` (read-only) and
`run --stage <token> --step <step> --plan <digest> --generation <N>` (one call per step; §5.3).
Resume state lives under `<V>/migration/<token>/` (`0c` here; §5.2). A migration firing takes the firing lock for its write phase,
because `ensureClone`, adoption and saves are generation-fenced (`scripts/loop-clone.mjs:423-466`,
`scripts/reflex-bundle.mjs:519`); owner conversations happen before `run`, unlocked, and every
`run` re-checks its step against the plan under the lock (`plan-changed`). (v2) One exception: the
ids decisions need the ids that `normalize` mints, so they are collected after the normalize Edits,
under the lock, with the owner present (a scheduled firing meanwhile meets a live holder and exits
without writing, 0c-1); `resolve` re-checks them (`stale-decision`). It appends one ledger
row (outcome `migrated`, R33) once the spine is untracked by current git facts (in this firing or
an earlier one; never from `state.json` alone, R35); a migration firing that ends before that
writes nothing in `<S>` (R2). (v2) The finalize order is `## Last run`, the ledger row, the anchor
(save, Write, `status --expect`), then the version Edit, then close and release (R39), so a kill
anywhere leaves a state `plan` resumes. Cost if wrong: a migration interrupted mid-conversation
leaves no trace in `<S>`; re-running `plan` resumes it.

**R4. Step order (v2).**
1. `scope`: the top-level check (spec:152-156; `loopPaths` refuses `not-toplevel`,
   `scripts/lib/loop-paths.mjs:43`) and the scope validator (R10). The owner fixes `scope:` in
   conversation (R21); every later step refuses while this one does.
2. `untrack` (R6, §5.3).
3. `worktree`: retire the legacy worktree (R12).
4. `ids`: `loop-items.mjs normalize` (`planNormalize`, the function every firing calls; spec:1029-1032)
   applied first (Edits, `check --expect`), then, against the ids it minted, the interactive
   resolution of legacy title blockers and title-keyed `## Needs decision` headings from
   `itemProblems` candidates (`scripts/lib/loop-state.mjs:705-744`); the owner confirms each one
   (R24). (v2, decision 1) No origin is written: the legacy analysis/follow-up pairs the ledger
   names (pre-0c-3 rows' notes `analysis → <title>`) are listed in `## Last run` as hints
   (`legacy follow-up <id> may come from analysis <id>; origin stays unknown`), and missing origins
   stay `unknown` (R11).
5. `version`: the completed stage's token (`0c`) written last.
Unresolved legacy items do not block step 5: they stay parked and are reported (spec:1035-1037).
Cost if wrong: an interrupted migration re-runs from the first unfinished step; `spine_version:`
never reads complete early.

**R5. `spine_version:` (v2)** is a stage token from one ordered list, `SPINE_STAGES = ['0c', '1', '2']`,
owned by a new `scripts/lib/spine.mjs` together with `CURRENT_STAGE` (`'0c'` in 0c-4), the per-stage
step registry `STAGE_STEPS` (`{'0c': ['scope', 'untrack', 'worktree', 'ids', 'version']}`; stage 1
adds its own key and never edits `'0c'`), the `SPINE.json` format (R7) and the spine status
detector (R17). Tokens compare by list position, never numerically (`0c` is not a number; down-rep
D5). A stage with no migration steps adds no token and leaves `CURRENT_STAGE` where it is (stages
3-5 ship with `CURRENT_STAGE = '2'`). A missing key means a spine from before stage 0c
(spec:1003-1004); a token not in the list (a newer plugin's, a typo) refuses in every mode
(`version-unknown`). It is read only through `frontScalar(text, 'spine_version')`
(`scripts/lib/loop-md.mjs:49`). (v2) Execution is registry-driven: `plan` binds itself to the
first pending stage (`migrationNeeded(version).pending[0]`) and reports only that stage's steps;
`run` takes `--stage <token>` and refuses `stage-mismatch` unless it equals that pending stage; the
version step writes that stage's own token, never `CURRENT_STAGE`, so a stage-1 plugin over a
pre-0c spine writes `0c` after the 0c steps and then plans stage 1. Each stage keeps its state in
`<V>/migration/<token>/`. Cost if wrong: a downgraded plugin stops every firing on a spine a
newer one migrated.

**R6. The untracking commit (v2)** lands only on the `base:` branch (LOOP.md `base:`, or
`defaultBase` when the key is missing; `scripts/loop-start.mjs:56`) and only when it is checked out
in `<P>`: otherwise `wrong-branch` (the remedy: check out `<base>`, or merge it into the other branch
in a temporary worktree, R34). (v2) One exception: when the base's tree tracks nothing under
`.tech-lead/` and the checked-out branch's HEAD does (a 0.6.0 spine bootstrapped and committed on a
feature branch), the commit lands on the checked-out branch: `plan` warns `base-never-tracked
{branch, base}` and the owner confirms that branch by name in migration.md step 3. It refuses a
detached HEAD (`detached-head`), an unborn HEAD (`unborn-head`) and a merge, rebase, cherry-pick,
revert or bisect in progress (`operation-in-progress`). The index must hold nothing but this step's
own recorded change (R22): any other staged change refuses `index-dirty` with the remedy
`git -C <P> restore --staged -- .tech-lead .gitignore` when HEAD tracks a path under `.tech-lead/`,
and `git -C <P> rm --cached -r -q -- .tech-lead` when HEAD tracks nothing there (an index-only
tracking, such as a popped pre-migration stash with unmerged entries; it keeps the files). A
resumed step also requires HEAD to be `refs/heads/<recorded branch>` at the recorded `head0`
(`head-moved`, R22); the branch preconditions apply to resumed steps too. Every diff the step
compares runs with `--ignore-submodules=none`, so a staged gitlink cannot hide (OWN-3), and
`.gitignore` is compared by `git hash-object --path=.gitignore` oids, never raw bytes, with
`core.safecrlf=false` on the step's calls (OWN-6). Hooks are disabled for this one commit (`safeGit`
forces `core.hooksPath=/dev/null`, `scripts/lib/git-safe.mjs:67`); the owner's signing and identity
configuration apply (`safeGit` overrides neither). The commit is verified after it is made:
`HEAD^` is the recorded `head0` and `HEAD^..HEAD` is exactly the recorded removals plus the one
`.gitignore` line; a mismatch refuses `commit-mismatch` with a ROLLBACK computed from the commit
actually made (R22). The exclude-file line is written too (spec:217-222) and verified with
`git check-ignore` (§5.1). Cost if wrong: an owner on a feature branch must check out the base to
migrate; a pre-commit hook's checks do not run on this commit.

**R7. `SPINE.json` and the spine copy (v2: `save` refuses every verdict but `ok`, `migrate` and
`unanchored`, R35).** `scripts/loop-spine.mjs save` copies `LOOP.md`,
`STATE.md` and `LEDGER.jsonl` (never `POLICY.json` or `CHAIN.json`, spec:229-230) into `<V>/spine`
itself (R19 fixes the directory layout) and prints the `SPINE.json` text and its SHA-256; the main
session writes `<S>/SPINE.json` with the Write tool (governance, spec:196), and
`loop-spine.mjs status <P> --expect <sha256>` confirms it. Order: copies first, anchor last. It runs
at §8 after the ledger append and before `loop-clone.mjs close` and the release. Format (one line,
`canonicalJson` plus `\n`): `{"files":[{"bytes":<int>,"name":"LEDGER.jsonl","sha256":"<64hex>"},
{..."LOOP.md"...},{..."STATE.md"...}],"generation":<N>,"stage":"<token>","v":1}`, files sorted by
name. `stage` is the writing plugin's `CURRENT_STAGE`: it names which file set and regression rule
the anchor follows (stage 1 writes `v: 2`), not the spine's `spine_version:`, so a spine is anchored
as soon as it is untracked, before its migration completes. Cost if wrong: a firing that dies between the copy and the Write leaves the previous anchor,
which still guards (R19).

**R8. Bootstrap (v2)** writes the first `SPINE.json` and copy; takes the firing lock only for its write
phase (the interview runs unlocked); writes the exclude line and verifies it with `check-ignore`;
writes `spine_version:` = `CURRENT_STAGE`; validates `scope:` with the one validator (refusing every
whole-repository spelling) after proposing concrete directories; never commits and never edits
`.gitignore`; records itself in `## Last run`; mints ids through `loop-items.mjs normalize` and
resolves each dependency to the prerequisite's id through `loop-items.mjs resolve` (R24), the owner
having named the dependency during the interview. This amends 0c-3 R25 and R32 at plan level
(0c3-brief:256-257, 478-481): new spines no longer park on title blockers. Bootstrap refuses when
HEAD, the index or the chosen base tracks `.tech-lead/` (`tracked`), when `<V>/spine` exists for
this project (`copy-exists`: it names the copy's directory and points to the README's manual
restore, spec amendments item 2; the README also says how to start fresh by moving `<V>/spine`
aside), and when `LEDGER.jsonl` already holds rows (`history`). (v2) It also refuses
`migrated-before {commit}` when `<V>/migration/0c/state.json` exists or
`git -C <P> log -1 --format=%H -- .tech-lead` finds history: the spine of a migration interrupted
before its first anchor still exists at `<commit>^`, and the remedy is
`git -C <P> restore --source=<commit>^ -- .tech-lead` (work tree only; the files stay untracked and
ignored), then an interactive firing; only an explicit owner yes to "start a new spine anyway",
asked after showing the commit and the remedy, passes this refusal. (v2) An interrupted bootstrap
is resumed, never overwritten (R37): a `partial` spine (no `LOOP.md`, no `SPINE.json`, `STATE.md`
or an empty `LEDGER.jsonl` present) keeps its existing `STATE.md` unless the owner, shown it,
chooses to replace it; an `unanchored` spine (LOOP.md written, no `SPINE.json`) is anchored by an
interactive anchor firing. The guard (R35) runs before each write step with
`--allow absent,partial,unanchored`. Cost if wrong: an owner whose `<S>` was wiped restores by hand
from `<V>/spine`.

**R9. Lost and regressed (v2)** follow spec §4 (spec:232-241): **lost** when `SPINE.json` exists and a
file it lists is missing; **regressed** when `LEDGER.jsonl` no longer begins with the bytes
anchored in `SPINE.json` (shorter than the anchored length, or the SHA-256 of its first
`bytes` bytes differs). Owner edits to `LOOP.md` and `STATE.md` never count. An interactive firing
restores only on the owner's confirmation and only when the copy matches `SPINE.json` (R18). An
`exposed` spine (nothing tracked, but `.tech-lead/` not ignored) re-runs the ignore step in an
interactive firing after one plain question (R32) and is a no-write exit in a scheduled one, printing
`spine needs an interactive run (not ignored)` (R32). Cost if wrong: a spine whose exclude line was
removed stops scheduled firings until an interactive one.

**R10. Scope (v2).** `scripts/lib/loop-scope.mjs` gains `scopeGate`, the one validator (§4.1). It
refuses every whole-repository spelling (`.`, `./`, `/`, empty; spec:254-256), an absolute path, a
`..` component, an empty entry, a malformed entry, and an entry whose first component is `.git` or
`.tech-lead` (`governed`); for every valid scope its canonical entries and `scopeDigest` are those
`checkScope` gives today (down-rep D25). File entries follow the spec text: "`scope:` in `LOOP.md`
lists repository-relative directory paths" (spec:251-252), so (v2) at bootstrap and in the
migration, where a base ref is known, an entry that `base:`'s tree holds as anything but a tree
(`ls-tree <baseRef> -- <entry>` shows a blob, a symlink or a gitlink) is refused
(`not-a-directory`); an entry the base tree lacks is allowed (R26). The check never reads `<P>`'s
checked-out working tree, and the §2 gate keeps to the syntactic refusals (whole, absolute, dotdot,
empty, malformed, governed, placeholder), so the owner's checkout cannot change its answer;
symlinks met at run time stay with the real-path in-scope rule (spec:257-258). A §2 gate sits after
Paused and before the circuit breaker: an invalid scope writes an incident in `## Last run`,
records outcome `halted`, sets `paused: true`, notes `scope invalid: <reason>`, and stops the
runner. `markScope` keeps 0c-2 R17 for saves (a save never fails on scope;
`scripts/lib/loop-scope.mjs:209-212`). (v2) `loop-clone.mjs check` and `commit` run the syntactic
`scopeGate` on the current `LOOP.md` before `scopeOf` and refuse `scope-invalid {reason}` (exit 3),
so a scope changed to a whole-repository spelling during a firing never reaches a commit; the prose
treats it as the §2 gate's incident. The `LOOP.md` template's `scope:` becomes a placeholder
bootstrap must fill. Cost if wrong: root files (`package.json`) can never be in scope; changes to
them go through the owner.

**R11. Origins.** Missing origins stay `unknown` on every spine (spec:1030-1032 as amended by A12);
no `human` policy, no amendment. SKILL.md:266, `loop-templates.md:156-159` and README:629-632 do
not change. Cost if wrong: person-added items keep reading `unknown`; only the escalate-only
`loop from` rule reads origins.

**R12. Legacy worktree retirement (v2).** In this order, under the lock, inside
`loop-migrate.mjs run --step worktree`: (a) quiesce Codex jobs of `<S>/worktree`
(`quiesce`, `scripts/loop-codex.mjs:250`) and sweep it for live processes (`sweepOthers`); (b) save
its uncommitted work with a `legacy` layout save (why `migration`, the save appended to
`<V>/migration/0c/state.json`'s `saves` list, which is never shortened or rewritten, R38; writes
into `<P>/.git`'s object store are accepted in the interactive migration); (c) adopt its dated
branches into the clone through `adoptFor` in-process (the new sanctioned `loop-clone.mjs adopt`
path, whose CLI no prose names; 0c-2 R13, 0c2-brief:89-90, gains this path; §5.6), with a defined collision rule for names the clone already has (R40); (d) persist the reset
intent (phase `resetting` with the bundle sha and base) and only then reset the worktree after a
verified save, resuming against that recorded bundle after any interruption (R38); (e)
`git worktree remove <S>/worktree` without `--force` and without any recursive delete; a refusal is
shown to the owner and leaves the migration pending (R25). The `--item`
check for saves exempts the migration's legacy save explicitly (R28). Cost if wrong: objects of the
legacy work land in `<P>/.git` (unreachable after removal; collected by the owner's `git gc`).

**R13. Quick's target-tree check.** Before branching, after `git fetch origin <base>`, quick refuses
to switch branches in the user's checkout when the target tree (`origin/<base>`) or the current
tree (the index, and HEAD, R29) tracks anything under `.tech-lead/`, and works in its separate
worktree instead (spec amendments item 1). The check is plain git in prose; quick runs no plugin
scripts. Cost if wrong: one extra worktree per quick run until the base is migrated and pushed.

**R14. Stage 2 sandbox residual.** Migration, bootstrap, the exposed-spine repair and the restore
write `<P>` (the index, a commit, `.gitignore`, the exclude file, `<P>/.git/worktrees/`, objects) or
governance outside an unattended run, so they run only in an interactive session outside any
sandboxed runner. Recorded as a residual for stage 2 (§11), which must keep such a session
possible. Cost if wrong: stage 2 needs an owner-terminal form for them.

**R15. One owner per concern** (§1): `spine.mjs` (stage list, `SPINE.json`, status detector,
ignore line), `loop-scope.mjs` (validator), `loop-migrate.mjs` (migration CLI), `loop-spine.mjs`
(spine CLI), `git-safe.mjs` (the linked-worktree runner for the legacy layout), `changes.mjs` (the
`legacy` layout). `legacyFacts` moves from `scripts/loop-recover.mjs:504-535` into a library module
(`scripts/lib/legacy-worktree.mjs`, drafter name; loop-recover re-exports it, as it does `nowLine`,
`scripts/loop-recover.mjs:124`). Cost if wrong: none beyond the move.

**R16. README (v2)** gains "Upgrading to 0.7.0" (run the loop interactively once to migrate; merge
the untrack commit into other branches and push the base) and a Troubleshooting row for every new
exit and refusal (§6.7). (v2) Every merge into another branch is given as a recipe that never
switches `<P>`'s checkout, since a checkout of a branch that still tracks the spine overwrites the
ignored live spine and the merge then deletes it:
`git -C <P> worktree add <tmp> <branch> && git -C <tmp> merge <base> && git -C <P> worktree remove <tmp>`.
The commit message, the `switch-back` and `wrong-branch` remedies and R34's warnings point to that
README section instead of a bare "merge before switching". (v2) The pull behaviour is stated as git
has it: pulling the untrack commit deletes an unmodified tracked spine and aborts on a modified one;
another clone that runs the loop upgrades and migrates there before pulling (the two untrack
commits make the same change and merge cleanly), and anyone else copies `.tech-lead/` aside first.
Cost if wrong: none.

**R17 (drafter, v2). The spine status verdict and §1 step 4.** `spineStatus` (spine.mjs) computes
facts and one verdict, in this precedence (first match wins):
`tracked` (HEAD or the index tracks a path under `.tech-lead/`; `tracked.head` empty marks the
index-only case) > `anchor-invalid` (`SPINE.json` exists and does not parse as R7's format) >
`restore-pending` (a restore marker in `<V>/spine`, R18) > `lost` > `regressed` > `absent` (no
`SPINE.json`, no `LOOP.md`, no `STATE.md`, no `LEDGER.jsonl`) > `partial` (no `SPINE.json`, no
`LOOP.md`, but `STATE.md` or `LEDGER.jsonl` present: an interrupted bootstrap, R37) > `exposed`
(nothing tracked, a spine file present, `.tech-lead/` not ignored) > `version-unknown` > `migrate`
(`spine_version:` missing or older than `CURRENT_STAGE`) > `unanchored` (`spine_version:` current,
no `SPINE.json`, R37) > `ok`. §1 step 4 acts on it: `ok` goes on to read state; `absent` and
`partial` release the lock (no-write exit) and follow bootstrap when interactive (an interrupted
bootstrap or a hand-made `<S>`) and print `spine needs an interactive run (missing)` when
scheduled; `tracked` and `migrate` are a no-write exit printing `migration needs an interactive run`
when scheduled and, when interactive, release the lock and follow `references/migration.md` (an
index-only `tracked` prints the `rm --cached` remedy of R6 first); `lost`, `regressed` and
`restore-pending` are a no-write exit printing `spine needs an interactive restore` when scheduled
and follow R18 when interactive; `unanchored` follows R37; `exposed` follows R9; `anchor-invalid`,
`version-unknown` and a status exit 2 are no-write exits in every mode (the runner stops; README
rows). `tracked` comes first because spec:242-243 forbids a restore while HEAD or the index tracks
the spine. (v2) The same detector runs again before every later governance-write sequence (R35).
Cost if wrong: an owner on an old branch that still tracks the spine is sent to the migration,
whose plan sends them back (R23).

**R18 (drafter, v2). The interactive restore.** At a `lost`, `regressed` or `restore-pending`
verdict in an interactive firing: run `loop-spine.mjs restore <P>` (read-only) and release the
lock; show the owner the difference it prints and ask one plain question; on an explicit yes,
acquire the lock again, run `loop-spine.mjs restore <P> --token <token> --generation <N>` (fenced;
refuses `token-changed` when anything differs from what was shown; before printing the files it
writes the marker `<V>/spine/restore-pending.json` `{anchor_sha256, generation, token}` through
`atomic.mjs`), write each listed file with the Write tool from the printed text, byte for byte, in
the printed order, which puts `LEDGER.jsonl` last, then run
`loop-spine.mjs status <P> --expect <anchor sha256> --restored --generation <N>`, and release.
`--restored` compares every live spine file's `{bytes, sha256}` with `<V>/spine/<g>/` and refuses
`restore-incomplete {names}` on any difference; only a full match removes the marker. While the
marker exists the verdict is `restore-pending` (R17), so a killed, partial or mistranscribed restore
can never read `ok`: the next interactive firing offers the restore again and a scheduled one exits
without writing. The restore firing writes nothing else (no `## Last run`, no ledger row): the
restored files equal the anchored copy, and the next firing proceeds normally. A declined restore
or a `copy-tampered` or `no-copy` refusal ends the firing without writing (R2); a
`restore-incomplete` ends it with no further write, names each mismatching file and its `cp`
command. A file over 64 KiB, or one that does not decode as UTF-8, is not printed (`too_large`):
the owner copies it in their own terminal with the printed `cp` command (the ledger's `cp` last),
then the firing runs the `--restored` check. (v2, G9) The decline message and the README row say
how to keep the live spine as it is (an intentional ledger edit): delete `<S>/SPINE.json`; the next
interactive firing anchors the live files (R37). Edits made since the last firing are lost unless
the owner merges them by hand (spec:240-241). Cost if wrong: files over 64 KiB are restored by the
owner's `cp`.

**R19 (drafter, v2). Copy layout.** The copy for generation `N` lives in `<V>/spine/<N>/` (three
files plus `anchor.json`, a byte copy of the `SPINE.json` text this save prints; mode 0600,
directory 0700); `SPINE.json.generation` names the directory the anchor describes. (v2) `save`
builds the copy in `<V>/spine/.partial-<N>-<random>/` (each file through a temp and a rename,
`anchor.json` last, then the directory fsynced) and publishes it with one rename to
`<V>/spine/<N>/` (the parent fsynced) before printing, so a directory named by a plain integer is
always complete; a stray `.partial-*` directory is never a restore source. When `<V>/spine/<N>/`
already exists it is replaced only if the current `SPINE.json` does not name generation `N`
(a failed earlier save of the same generation); otherwise `save` refuses `copy-in-use` and never
rewrites the anchored directory (one save per generation is the design: §8, bootstrap, the
migration's finalize and the anchor firing each run in their own generation). After printing it
removes every other `<V>/spine/<g>/` and `.partial-*` except the new one and the one the current
`SPINE.json` names (one file at a time, then `rmdir`; never recursive). A save that fails
before the Write leaves the previous anchor and its directory intact, so lost, regressed and the
restore keep working (the ledger is append-only). A `save` failure other than `not-holder` goes into
the summary and never blocks close or release. Cost if wrong: up to two copies of the spine in `<V>`.

**R20 (drafter). Bootstrap appends no ledger row.** Its record is `## Last run`; `LEDGER.jsonl` stays
empty, so L1-to-L2 promotion timing (SKILL.md:422-427) is unchanged. Bootstrap joins the ledger
rule's named exceptions (R2's places). Cost if wrong: bootstrap's generation is a ledger gap
(spec:1093 allows gaps).

**R21 (drafter, v2). Scope while the spine is tracked.** The migration's scope step never writes
`LOOP.md` while HEAD or the index tracks `.tech-lead/`: `plan` shows the refusal and a proposed
list of directories, the owner edits `scope:` by hand, and `plan` is run again. Once the untracking
is done (a resumed migration), the main session may make the edit with Edit on the list the owner
typed, after `guard --allow migrate,ok` (R35). `plan` names every `## Needs decision` entry whose `**Recovery:**` scope digest no longer
equals the new scope's digest (down-rep D26), and the migration notes them in `## Last run`.
Cost if wrong: one hand edit per migrated project.

**R22 (drafter, v2). Recognizing the untrack step's own state.** (v2, decision 1) Before the
preconditions, the step recognizes its own partial state **only from its record** in
`<V>/migration/0c/state.json` (spec:1015-1017). Without a record, any staged change is foreign:
`index-dirty` with R6's remedy (`restore --staged -- .tech-lead .gitignore`, or `rm --cached -r -q --
.tech-lead` when HEAD tracks nothing there). Without a record, an untracked `.gitignore` refuses
`gitignore-untracked`; when its bytes are exactly `withLine('')` (the shape an interrupted step
leaves when HEAD has no `.gitignore` and the record was lost) the refusal carries `own_shape: true`
and the remedy `rm -- <R>/.gitignore`. A forged record cannot widen what is accepted, because the
staged-set check (spec:1020) and the post-commit check compare git facts. A commit already made is
detected from git (spec:1017): when nothing under `.tech-lead/` is tracked in HEAD or the index and
HEAD's `.gitignore` carries the line (in any of the forms `withLine` treats as present), the step is
done and makes no commit; (v2, g1#5) the done path still runs `ensureIgnored` under the lock and
verifies `ignoreFacts`, so a hand-untracked spine without the exclude line gets it. (v2) A resumed
record (phase `recorded` or `staged`) is valid only while HEAD is `refs/heads/<branch>` at `head0`;
otherwise the step rolls back only what is still its own (recorded removals still staged as
deletions: `restore --staged`; a `.gitignore` index blob equal to `after_oid` while HEAD's blob is
not: `restore --staged -- .gitignore`; a working `.gitignore` whose oid equals `after_oid`: put back
HEAD's current bytes, or remove it when HEAD has none), moves the record to `state.json`'s
`untrack_history` (never deleted, R38), and refuses `head-moved {branch, head0, head}`; `plan`
reports the same as `plan-changed` before any run. A failure before the commit (with HEAD at
`head0`) rolls back what the step itself did (`restore --staged -- .tech-lead .gitignore`,
`.gitignore` back to its recorded bytes, or removed if it did not exist; the exclude line stays) and
refuses. A mismatch after the commit keeps the commit and prints a ROLLBACK computed from the commit
actually made, `C` (`git -C <R> reset --soft C^`, then
`git -C <R> restore --staged -- .tech-lead .gitignore`, then, when `gitignore.existed`,
`git -C <R> restore --source=C^ --worktree -- .gitignore`, else `rm -- <R>/.gitignore`); it is
printed only while HEAD is `C` on the recorded branch (otherwise the refusal says the branch moved
and prints no command). The helper never moves a ref in `<P>` after the fact. Cost if wrong: a hook
that adds files to the commit leaves the owner one documented rollback; a wiped `<V>` mid-step costs
the owner one printed remedy command.

**R23 (drafter, v2). Untracking over a migrated project refuses.** When `<S>/SPINE.json` exists and the
live spine is lost or regressed against it (an owner who checked out a branch that still tracks the
spine), `plan` reports the untrack step `refused` with `switch-back`: untracking that branch's copy
would bake a regressed spine in. The remedy: check out the migrated branch (or merge the base into
this branch in a temporary worktree, R16). (v2, G3) When only the index tracks the spine and HEAD
does not (HEAD is a migrated branch), the remedy is R6's `rm --cached -r -q -- .tech-lead`, never a
checkout, and the next interactive firing offers the R18 restore for any spine file that differs
from the copy. Cost if wrong: an owner who really wants that branch's copy deletes `SPINE.json` by
hand first.

**R24 (drafter, v2). Plan digests, the ids step and one resolve planner.** `plan` prints a digest
per step over the step's intent (§5.3); `run --step <s> --plan <digest>` recomputes that step's
intent and refuses `plan-changed` on a difference. (v2, g1#8) Each step's exact canonical intent is
persisted in `state.json` with its phase (`untrack.intent`, `worktree.intent`), and a resumed step's
intent is that recorded intent checked against live facts (untrack: HEAD on the recorded branch at
`head0`; worktree: the worktree's live HEAD equals the recorded `head`, else `plan-changed` with
`head_moved: true`, R38), never reconstructed after the tree changed. The ids step runs through
`loop-items.mjs` (spec:1031-1032: "through the same function this migration step calls"):
`normalize` applied first, then the new `resolve <P> --input <file>` (§4.5), whose input lists the
owner-confirmed decisions taken against the minted ids; it is also bootstrap's dependency step
(R8). `loop-migrate.mjs` has no `ids` run; its plan lists the candidates (by title before
normalize; `plan` re-run after the normalize Edits lists them by the minted ids) and the origin hints. Cost if wrong: two
helpers touch one step.

**R25 (drafter, v2). Legacy worktree refusals and the owner's choice.** `plan` refuses the worktree step,
before anything is written, when `legacyFacts` reports a problem (`legacy-invalid`), when
`git worktree list --porcelain` shows it locked (`worktree-locked`), and when its HEAD is not a
symbolic ref to a dated branch under `branch_prefix` (`legacy-detached`: commits on a detached HEAD
would be unreachable after removal). It lists the ignored files present in it (`ignored: {count,
sample}`): if `git worktree remove` deletes them (pinned by test MC-W9), the owner sees that before
confirming. When git refuses the removal after a save and reset, `run` reports `worktree-refused`
with git's message and the phase becomes `refused`. (v2, decision 1) There is no `--keep` and no
`kept` phase: the version step needs the worktree phase `removed` or `skipped`, so a refused
removal leaves the migration pending, and every interactive firing's `plan` shows git's message
again and offers the removal again (a `run` from phase `refused` retries only the removal, after
re-checking that the tree is still clean against the last save). migration.md step 3 asks the owner
to fix the cause; the README row also gives the owner's own way out once the tree is clean and
saved (`git -C <P> worktree remove --force <S>/worktree` in their terminal); a `refused` phase whose
path is gone and no longer registered is recorded `removed` (`by: 'owner'`). Scheduled firings
meanwhile exit with `migration needs an interactive run`. Cost if wrong: a worktree git will not
remove (a submodule inside it) keeps the loop paused until the owner removes it.

**R26 (drafter, v2). Scope CLI and gate details.** The scope CLI is `loop-spine.mjs scope` (no second
`loop-scope.mjs` basename). `governed`, `not-a-directory` and `placeholder` (an entry holding `<` or
`>`, a template placeholder left in place) live only in `scopeGate`, never in `checkScope`, so
`markScope`, bundle headers and `scopeDigest` are unchanged. `.git` and `.tech-lead` compare ASCII
case-insensitively. (v2, SF-7) `not-a-directory` runs only when the caller passes `baseRef`
(bootstrap's `scope --input` and the migration's scope step): `ls-tree -z <baseRef> -- <entry>`
showing a blob (`100644`/`100755`), a symlink (`120000`) or a gitlink (`160000`) refuses; no entry
passes. It never reads the working tree. The §2 gate and `loop-clone.mjs check`/`commit` pass no
`baseRef`. Cost if wrong: an entry that is a symlink in the base tree cannot be a scope entry.

**R27 (drafter, v2). Adoption records.** `adoptFor` (and `loop-clone.mjs adopt`) creates generation
N's run record when it is absent (`createRecord`, phase `clean`, `head_ref: null`, `adopted: []`),
so R28 vetting (0c2-brief:494-498) has a home; with `<W>` missing it calls
`ensureClone(paths, {generation, prefix, date, base})`, which adopts at creation into that record.
(v2, g2#4) `date` is the UTC `YYYY-MM-DD` of the migration firing, validated with loop-clone's
`validDate`, recorded in `worktree.intent.date` before the call, and reused unchanged by every
resumed run, so a retry never creates a second dated branch. `close` keeps such a record (reason `adopted`) until each tip is
named by a ledger commit or bundle tip, or contained in the base (0c-2 R32), and deletes it after.
Cost if wrong: one more kept record per migration.

**R28 (drafter). The legacy save never appears in prose.** `loop-migrate.mjs run --step worktree`
calls `saveLegacy` in-process (§5.5); no `reflex-bundle.mjs save` for the migration appears in
`skills/`. The `--item` check (`scripts/checks/loop.mjs:823-838`) keeps its rule and states the
exemption: `references/migration.md` must name no `reflex-bundle.mjs save` (§7 C11). The `save` CLI
refuses `--why migration` as a usage error. Cost if wrong: none; the exemption is a check, not a
code path.

**R29 (drafter). Quick checks HEAD too.** The current tree is HEAD and the index (spec:243 reads
"HEAD or the index"); a staged removal of the spine with HEAD still tracking it takes the worktree
path. Cost if wrong: none.

**R30 (drafter). Release notes.** README "Upgrading to 0.7.0" is the release notes. It says the
routing rule (`templates/rules-tech-lead.md`) is unchanged in 0.7.0, so no re-copy is needed, and
links "Reviewing loop work" for fetching loop branches from bundles (spec:1065-1066). Cost if wrong:
none.

**R31 (drafter). In doubt, scheduled.** A firing whose origin the main session cannot tell is
scheduled for R1's purposes; bootstrap keeps its one confirmation question
(`skills/loop/references/bootstrap.md:7-12`) inside an interactive firing. Cost if wrong: an
attended owner sees "needs an interactive run" and types `/tech-lead:loop`.

**R32 (drafter, v2). The exposed repair.** In an interactive firing, `exposed` asks the owner one
plain question (G8: "the spine is not ignored by git; add `/.tech-lead/` to `<exclude path>`?"); on
a yes it runs `loop-spine.mjs ignore <P> --generation <N>` (fenced, R42); on `ignored` the firing
re-runs `status` and goes on with the verdict it gets; on `negated` it is a no-write exit naming
each un-ignoring rule (R42); a no is a no-write exit. Cost if wrong: none.

**R33 (drafter, v2). The migration's ledger row.** Outcome `migrated` (a new value in the ledger
schema's enum; neither the daily budget nor the circuit breaker counts it); `task`, `item_id`,
`item_origin`, `class`, `delegate`, `verify` null; `commits: []` (the untrack commit is `<P>`'s, not a
loop commit, and must not vet anything through `vettedTip`); `saves: [{sha, why: 'migration', files,
out_of_scope}]`, one entry per save in `state.json`'s `saves` list not yet named by an earlier
`migrated` row (R38); `done_items: null`; `notes`:
`migrated to 0c: untrack <sha12|none> on <branch>; worktree <removed|skipped|refused>; ids
<n> resolved, <m> left; origin hints <k>; spine_version <0c|pending>` (v2: the row is written
before the version Edit, R39, so it names the version the firing is about to write, or `pending`
when a step is still open). `saves.why` gains `migration`. Cost if wrong: the row after a migration
delays L1-to-L2 promotion by one firing; a resumed migration writes one row per migration firing.

**R34 (drafter, v2). Other branches.** `plan` warns, never refuses, on every local branch other than the
base whose tip tracks `.tech-lead/` (`branches-track-spine`), on `origin/<base>` tracking it until
the owner pushes (`remote-base-tracks-spine`), and on dated loop branches chained from
pre-migration tips (part of the first warning), and (v2) `base-never-tracked` (R6). The loop never
pushes or rewrites them; README tells the owner to merge the base into them in a temporary worktree
(R16), never by switching `<P>`. Cost if wrong: such branches stay switch hazards, which the guard
detects (`lost`, `regressed`, `tracked`).

**R35 (v2, decision 2). The guard before every governance-write sequence.** The spine detector
(R17) runs again right before each governance-write sequence, not only at §1:
`node <T>/scripts/loop-spine.mjs guard <P> --allow <verdicts>` (read-only, no lock; exit 0
`{state:'ok', verdict}` when the verdict is in the list; exit 3 `{state:'guard', verdict, facts}`
otherwise). The sites and their lists: SKILL.md §2 before the first gate write, §3 before the
pick's first STATE.md Edit, §4-§7 before each step that edits `STATE.md` or `LOOP.md`, §8 before
step 1 (`## Last run`; the sequence covers the ledger append and the anchor) — each with
`--allow ok`; migration.md before the normalize Edits, before the resolve Edits and before the
finalize (step 8) — `--allow migrate,ok`; bootstrap.md before writing `STATE.md` and the ledger,
before the ids Edits, before `LOOP.md` — `--allow absent,partial`, and before the anchor —
`--allow unanchored`. The migration's `run` steps and `loop-spine.mjs save` check the same detector
inside the helper (`run --step untrack` accepts `tracked` and `migrate`, the other steps `migrate`;
`save` accepts `ok`, `migrate` and `unanchored`), so the check sits under the lock immediately
before the write. A hit takes R2's no-write exit: nothing more is written in `<S>`, no ledger row,
release with `--carry`, stop the runner, and print the reason plus the summary the firing would
have written (the would-be `## Last run` text and ledger row). Migration reporting uses current git
facts (`trackedFacts`), never `state.json`'s "untracked earlier". Cost if wrong: one read-only
helper call per write sequence; a branch switch during a long firing costs that firing's record,
which the printed summary keeps.

**R36 (v2). Carried reclaim notes.** `loop-lock.mjs release <P> --generation <N> --carry` stores the
acquire result's `reclaimed` and `stopped` facts (and any `carried` it received) in the lock
record's `carried` list; the next `acquire` returns them as `carried` and clears them only when the
firing that received them writes `## Last run` (§1 step 3 notes `carried` with its own facts; a
no-write exit passes them on with `--carry` again). Every no-write exit prints them. Cost if wrong:
one extra field in the lock record (0c-1's format gains `carried`, absent meaning none).

**R37 (v2). Partial and unanchored spines.** `partial` (an interrupted bootstrap after `STATE.md`)
and `unanchored` (a current `spine_version:` with no `SPINE.json`: bootstrap or a hand-deleted
anchor) never pass as `ok`. Interactive: `partial` hands over to bootstrap, which resumes at its
interview with the existing `STATE.md` shown and kept unless the owner explicitly chooses to replace
it (the replacement shows the difference first); `unanchored` asks the owner one plain question,
then runs the anchor firing: `loop-spine.mjs save <P> --generation <N>`, Write `<S>/SPINE.json`,
`status --expect`, release; it writes nothing else (no `## Last run`, no ledger row) and joins the
named exceptions (R2). Scheduled: both are no-write exits printing
`spine needs an interactive run (missing)` or `spine needs an interactive run (unanchored)`. Cost
if wrong: an owner who deletes `SPINE.json` runs one interactive firing to re-anchor.

**R38 (v2, decision 3). Destructive steps persist intent first and keep every save.** (a) The
worktree reset: before `resetLegacy`'s first destructive call, `state.json` records phase
`resetting` with `reset: {sha, base, started_at}` (fsynced, after `assertHeld`); `resetLegacy` uses
the durable resetting protocol of `resetFor` (`scripts/reflex-bundle.mjs:731-764`) with that
record instead of a run record; a resumed `resetting` phase resumes against `reset.sha` only and
never saves the partially reset tree (`unsaved` cannot arise there). (b) Saves: `worktree.saves` is
an append-only list; a re-save (the tree changed after `saved`, or the worktree's HEAD moved: IR-6)
appends and never replaces; `resetLegacy`'s `anchored` is the whole list; every sha appears in the
`migrated` row (R33) and the report. (c) HEAD moved after `saved`/`adopted` (before `resetting`):
`plan` reports `plan-changed` with `head_moved: true`; on the owner's yes the run verifies the
earlier bundle (kept), saves again against the new HEAD (appended), adopts again (R40), updates the
recorded intent, then resets; HEAD moved during `resetting` refuses `head-moved` and never resets.
(d) The untrack step's record is never deleted: a stale record moves to `untrack_history` (R22).
Cost if wrong: up to two bundles per migration in `<V>/patches`.

**R39 (v2). Migration finalize order.** migration.md step 8 (v1's step 9), when current git facts show nothing
tracked under `.tech-lead/`: guard (R35), `## Last run`, the `migrated` ledger row (R33), Anchor the
spine (save, Write `SPINE.json`, `status --expect`; the anchor does not depend on `LOOP.md`'s bytes,
since owner and loop edits to `LOOP.md` never count as a regression), then `run --step version` and
its Edit when every step is done, then `plan` must print `complete`, `loop-clone.mjs close`,
release. A kill before the version Edit leaves `migrate` and the next interactive run repeats only
the version step and its report; a kill after it leaves an anchored, complete spine. `complete`
means: `spine_version:` reads `CURRENT_STAGE`, nothing tracked, worktree `removed` or `skipped`.
Cost if wrong: one more ledger row when a migration is resumed.

**R40 (v2). Adoption collisions.** `adoptFor` treats each dated branch of `<P>` whose name the clone
already has: same tip, or the incoming tip an ancestor of the clone's -> nothing moves, recorded
`{from:'present'}`; the clone's tip an ancestor of the incoming tip -> fast-forward the clone's
branch with a compare-and-swap `update-ref` (never the branch checked out in `<W>`; that case
refuses), recorded `{from:'adopt-ff', previous}`; diverged -> refuse `adopt-collision {branch,
clone_tip, legacy_tip}` before the reset, nothing destroyed (the tip stays in `<P>`'s branch;
remedy in README: rename one branch). `plan` reports collisions ahead. Cost if wrong: a diverged
dated branch stops the migration until the owner renames it.

**R41 (v2). `.gitignore` handling in the untrack step.** The working file and the index are
reconciled independently against `after_oid` (g1#4): when the working file's
`hash-object --path=.gitignore` oid differs from `after_oid`, write `withLine(working bytes)` (temp
file and rename in `<R>`); when the index blob differs from `after_oid`, `update-index --add`. A
resumed step after `migrate:after-gitignore` therefore stages instead of failing. `.gitignore` must
be a regular file by `lstat` and HEAD's entry mode `100644` or `100755` (`gitignore-not-regular`);
`after_oid` is computed with `hash-object --path=.gitignore` so eol attributes apply (OWN-6). Cost
if wrong: none.

**R42 (v2). The ignore command is fenced and names its rules.** `loop-spine.mjs ignore <P>
--generation <N>` calls `assertHeld` before reading and passes `guard: () => assertHeld(...)` to
`ensureIgnored`, which calls it right before the rename; C13 covers it. On not-ignored,
`ignoreFacts` scans the sources git reads for the root (`<R>/.gitignore`, the exclude file, the
`core.excludesFile` path) for `!` lines whose pattern could match `.tech-lead` and reports each as
`<source>:<line>:<pattern>`, or names the sources when none is found (`check-ignore -v -n` prints
`::` for a negated path, OWN-9). Cost if wrong: none.

**R43 (v2). Manual recovery never switches `<P>`.** The README's recipe for getting a migration
bundle's work back adds a temporary worktree at the bundle's base
(`git -C <P> worktree add --detach <tmp> <base>`, `git -C <tmp> apply <V>/patches/<sha>.patch`,
then commit there on a new branch and `git -C <P> worktree remove <tmp>`), so a base that still
tracks `.tech-lead/` never overwrites the live spine (g2#3). The wiped-spine recipe copies from the
newest `<V>/spine/<g>/` whose name is a plain integer (complete by construction, R19), the three
spine files plus `anchor.json` as `<S>/SPINE.json`, then an interactive firing (g2#11). Cost if
wrong: none.

**R44 (v2). A broken `state.json` keeps its save shas visible.** `plan` on a `state-corrupt` file
also scans it as text for 64-hex values under `"sha"` keys and reports them as
`broken_saves: [sha]`; migration.md step 3 shows them and the README `state-corrupt` row tells the
owner to note them before moving the file aside, so a bundle in `<V>/patches` is never left without a
pointer (OX10). Cost if wrong: none.

## 1. Ownership map

| Concern | Owner | 0c-4 action | Imported by |
|---|---|---|---|
| Stage list, `CURRENT_STAGE`, step registry, `SPINE.json` format, status detector, ignore line and exclude write | `scripts/lib/spine.mjs` | new | loop-spine, loop-migrate, checks (reads `IGNORE_LINE` and `CURRENT_STAGE` from source) |
| Spine CLI (status, guard, save, restore, ignore, scope) | `scripts/loop-spine.mjs` | new | SKILL.md §1-§8; bootstrap.md; migration.md |
| Migration (plan, untrack, worktree, version; registry-driven by stage) and its state in `<V>/migration/<stage>/` | `scripts/loop-migrate.mjs` | new | migration.md |
| Scope validator | `scripts/lib/loop-scope.mjs` | extend (`scopeGate`) | loop-spine, loop-migrate |
| LOOP.md scalar edit planning | `scripts/lib/loop-md.mjs` | extend (`planScalar`) | loop-migrate |
| Legacy-text resolution planner, origin hints | `scripts/lib/loop-state.mjs` | extend (`planResolve` for blockers and headings; `originCandidates` for hints only) | loop-items, loop-migrate |
| Legacy analysis pairs from ledger notes | `scripts/lib/ledger.mjs` | extend (`legacyAnalysisPairs`) | loop-migrate, loop-items |
| Item CLI | `scripts/loop-items.mjs` | extend (`resolve`) | SKILL.md (none new), bootstrap.md, migration.md |
| Legacy worktree facts | `scripts/lib/legacy-worktree.mjs` | new (moved `legacyFacts`) | loop-recover (re-export), loop-migrate |
| Linked-worktree git runner | `scripts/lib/git-safe.mjs` | extend (`linkedGit`, `linkedGitRun`) | changes |
| `legacy` layout | `scripts/lib/changes.mjs` | extend | reflex-bundle |
| `migration` why, legacy save, reset and verify | `scripts/reflex-bundle.mjs` | extend | loop-migrate |
| Re-adoption on an existing clone; scope re-check at check and commit | `scripts/loop-clone.mjs` | extend (`adoptFor` with R40's collision rule, CLI `adopt`; `check`/`commit` call `scopeGate`) | loop-migrate |
| Carried reclaim notes | `scripts/loop-lock.mjs` | extend (`release --carry`, `acquire` returns `carried`; R36) | SKILL.md §1 |
| Recovery planner note | `scripts/loop-recover.mjs` | small change | — |
| Prose wiring checks | `scripts/checks/loop.mjs`, `scripts/checks/contracts.mjs` | extend; rewrite contracts.mjs:107-112 | check.mjs |

Import edges (acyclic; no module imports `loop-migrate.mjs` or `loop-spine.mjs`):
`spine -> loop-paths, git-safe, canonical, atomic, loop-md`; `loop-spine -> spine, loop-scope,
loop-paths, loop-lock (assertHeld, openPaths), loop-start (resolveBase)`; `loop-clone -> (existing) +
loop-scope scopeGate`; `loop-migrate -> spine, loop-scope, loop-md,
loop-paths, loop-start (resolveBase, defaultBase), git-safe, atomic, canonical, fault, loop-lock,
loop-codex (quiesce), loop-proc (sweepOthers), legacy-worktree, reflex-bundle (saveLegacy,
resetLegacy, verifyBundle), loop-clone (adoptFor), loop-state, ledger`; `legacy-worktree ->
git-safe`; `changes -> (existing) + git-safe linkedGit`.

## 2. scripts/lib/spine.mjs (new)

- `SPINE_STAGES = Object.freeze(['0c', '1', '2'])`, `CURRENT_STAGE = '0c'`,
  `STAGE_STEPS = Object.freeze({'0c': Object.freeze(['scope', 'untrack', 'worktree', 'ids', 'version'])})`,
  `RUN_STEPS = Object.freeze({'0c': Object.freeze(['untrack', 'worktree', 'version'])})` (the steps
  `loop-migrate.mjs run` executes for that stage; `scope` and `ids` are prose-driven). (v2) Every
  stage's step list ends in `version`, which writes that stage's token (R5).
- `stageIndex(token) -> int` (-1 for anything not in the list, `null` included).
- `migrationNeeded(version) -> {state:'current'} | {state:'needed', from: version|null, pending:[token]}
  | {state:'unknown', version}`: `null` means pre-0c (pending every stage up to `CURRENT_STAGE` that
  has steps); a known token older than `CURRENT_STAGE` is `needed`; a token newer than
  `CURRENT_STAGE` is `unknown`.
- `SPINE_FILES = Object.freeze(['LEDGER.jsonl', 'LOOP.md', 'STATE.md'])` (stage 0c's allowlist;
  never computed from a directory listing, down-rep D13); `ANCHOR = 'SPINE.json'`.
- `IGNORE_LINE = '/.tech-lead/'`; `hasIgnoreLine(text) -> boolean` (a line, after trimming trailing
  `\r` and blanks, equal to `/.tech-lead/`, `.tech-lead/`, `/.tech-lead` or `.tech-lead`);
  `withLine(text, line = IGNORE_LINE) -> text` (unchanged when `hasIgnoreLine`; else appends,
  adding a missing final newline first, using `\r\n` when every line of `text` ends in `\r\n`;
  `''`/missing gives `'/.tech-lead/\n'`). Pure.
- `anchorText({stage, generation, files}) -> string` (`canonicalJson` + `\n`, files sorted by name);
  `parseAnchor(text) -> {v, stage, generation, files} | null` (exactly the R7 keys; `v === 1`;
  `stage` in `SPINE_STAGES`; `generation` a safe positive integer; `files` exactly `SPINE_FILES`, each
  `{name, bytes, sha256}` with a non-negative safe integer and 64 lower-case hex; anything else
  null).
- `excludePath(R) -> string`: `safeGit(R, ['rev-parse', '--path-format=absolute', '--git-path',
  'info/exclude'])` (the common directory's file in a linked worktree, spec:219-220).
- `ignoreFacts(R) -> {ignored:boolean, rules:[string], sources:[string]}`: for each of
  `.tech-lead/`, `.tech-lead/LOOP.md`, `.tech-lead/STATE.md`, `.tech-lead/LEDGER.jsonl`,
  `.tech-lead/SPINE.json`: `safeGit(R, ['check-ignore', '--no-index', '-v', '-n', '--', <path>])`; a
  path is ignored iff the printed pattern is non-empty and does not start with `!`. (v2, R42) When
  not ignored, `rules` lists each `!` line in `<R>/.gitignore`, the exclude file and the
  `core.excludesFile` path whose pattern could match `.tech-lead` (`<source>:<line>:<pattern>`;
  git prints `::` for a negated path, OWN-9), and `sources` names the files scanned when `rules` is
  empty. `--no-index` makes the answer the same before and after the untracking (spec-rep G-10).
- `ensureIgnored(R, {guard}) -> {state:'ignored', path, added} | throws REFUSED negated {rules, sources}`
  (`guard` required, TypeError otherwise; R42):
  reads the exclude file (missing reads empty), and when `hasIgnoreLine` is false writes
  `withLine(text)` through a temp file in the same directory and a rename (creating `info/` mode 0755
  when missing; `guard()` right before the rename); then `ignoreFacts`; not ignored refuses
  `negated` (the exclude line stays). Writes nothing else.
- `trackedFacts(R, {base = null}) -> {head:[path], index:[path], base:null|[path]}`:
  `ls-tree -r -z --name-only --full-name HEAD -- .tech-lead` (an unborn HEAD gives `[]`),
  `ls-files -z --full-name -- .tech-lead`, and for `base` the ref from `resolveBase(R, base)`
  (`refs/heads/<b>` or `refs/remotes/origin/<b>`); at most 50 paths each, plus `more`.
- `spineStatus(P, {env, base = null}) -> facts` (read-only; writes nothing in `<P>`, `<S>` or `<V>`;
  every git read with `--no-optional-locks`):
  `{state, current_stage, version, version_detail, tracked, anchor:{present, valid, sha256,
  generation, stage}|null, files:{<name>:{present, bytes, sha256}}, lost:[name], regressed:null|
  {anchored_bytes, live_bytes}, ignored, rules, exclude:{path, has_line}, copy:{dir, exists,
  matches}|null, copy_exists, restore_pending:null|{anchor_sha256, generation, token},
  ledger_rows, R, S, V}` (v2: `restore_pending` reads `<V>/spine/restore-pending.json`; `partial`
  and `unanchored` follow from `files` and `anchor`). `version` from `frontScalar(LOOP.md,
  'spine_version')` (`version_detail` holds a `bad-loop-md`/`appears N times` message, which makes
  the state `version-unknown`); `copy.matches` is true when each file in `<V>/spine/<generation>/`
  has the anchored bytes and SHA-256; `copy_exists` is true when `<V>/spine` exists at all;
  `ledger_rows` counts non-empty lines. The verdict follows R17's precedence exactly.

## 3. scripts/loop-spine.mjs (new CLI; one JSON line; exit 0/2/3)

`node <T>/scripts/loop-spine.mjs <command> <P> [flags]`. `<R>`, `<S>`, `<V>` from `loopPaths`
(`not-toplevel` and `not-a-repo` are exit 2 errors carrying the message).

| Command | Exit 0 | Exit 3 `state` |
|---|---|---|
| `status <P> [--base <branch>] [--expect <sha256> [--restored --generation <N>]]` | `spineStatus` facts with the R17 `state` | with `--expect` only: `anchor-mismatch {expected, actual, copy_matches}` when `<S>/SPINE.json`'s SHA-256 differs or its copy directory does not match it; with `--restored` also `restore-incomplete {names}` (R18), `not-holder` |
| `guard <P> --allow <v,...>` | `{state:'ok', verdict}` | `guard {verdict, facts}` (R35) |
| `save <P> --generation <N>` | `{state:'saved', generation, dir, text, sha256, pruned:[g]}` (`text` = the exact `SPINE.json` bytes for the Write tool) | `not-holder`, `refused-verdict {verdict}` (any verdict but `ok`, `migrate`, `unanchored`; `tracked` carries `{head, index}`), `spine-missing {names}`, `copy-in-use` (R19) |
| `restore <P> [--token <hex> --generation <N>]` | `{state:'restorable', token, anchor_sha256, generation, diff:[{name, live:{present, bytes, sha256}, copy:{bytes, sha256}, patch}], files:[{name, text}], too_large:[{name, bytes, command}]}` | `not-restorable {reason}` (`tracked`, `no-anchor`, `anchor-invalid`, `no-copy`, `copy-tampered`, `not-lost`), `token-changed`, `not-holder` |
| `ignore <P> --generation <N>` | `{state:'ignored', path, added}` | `negated {rules, sources}`, `not-holder` |
| `scope <P> [--input <file>] [--base <branch>]` | `{state:'ok', entries, digest}` | `scope-invalid {reason, detail, problems}` |

- `save`: `assertHeld`; `chdir(V)`; (v2, R35) runs `spineStatus` and refuses every verdict but
  `ok`, `migrate` and `unanchored` (nothing anchors a tracked, lost, regressed or restore-pending
  spine, spec:242-245); reads each of `SPINE_FILES` once into a buffer; builds
  `<V>/spine/.partial-<N>-<random>/` (temp + rename each; `fault('spine:after-copy-one')` after the
  first; `anchor.json` last); fsyncs it (`fault('spine:after-copies')`); renames it to
  `<V>/spine/<N>/` per R19 (`guard()` before the rename; `fault('spine:after-publish')`); prunes per
  R19 (`guard()` before each unlink and `rmdir`); prints. Writes nothing in `<S>`.
- `guard`: read-only, no lock; `--allow` takes verdict names from R17 (anything else is a usage
  error).
- `restore`: without `--token`, read-only. Refuses unless the verdict is `lost`, `regressed` or
  `restore-pending`, `SPINE.json` parses, and `<V>/spine/<generation>/` matches it byte for byte
  (`copy-tampered`, spec:239-240). `diff[].patch` is `git diff --no-index --no-color -U3` of the live
  file against the copy, cut at 200 lines. `files` holds the text of each spine file whose live
  bytes differ from the copy and whose copy is at most 64 KiB (UTF-8; a file that does not decode
  goes to `too_large`), in the order `LOOP.md`, `STATE.md`, `LEDGER.jsonl` (the ledger last, R18);
  `too_large[].command` is `cp <V>/spine/<g>/<name> <S>/<name>`, ledger last. `token` =
  `sha256Hex(canonicalJson({anchor_sha256, live:[{name, present, sha256}]}))`; with `--token` (which
  requires `--generation`, `assertHeld`) the same report is recomputed and must give the same
  token, then the marker `<V>/spine/restore-pending.json` is written (`writeReplace`) before
  printing. `status --expect <sha> --restored --generation <N>` compares each live file with the copy
  and, on a full match, removes the marker (`guard()` first).
- `scope`: without `--input`, `scopeGate(<S>/LOOP.md text, {root: R})` (syntactic; the §2 gate);
  with `--input <file>`, the file holds the JSON `{"scope": [<string>...]}` (written with the Write
  tool; bootstrap) and is checked with `scopeEntriesGate(list, {root: R, baseRef})`, `baseRef` from
  `resolveBase(R, --base)` (R26). The migration's scope step calls `scopeGate` with its `baseRef`
  in-process. A bad input file is exit 3 `scope-invalid` reason `unreadable`.
- `ignore`: (v2, R42) `assertHeld`, `chdir(V)`, `ensureIgnored(R, {guard: () => assertHeld(...)})`.
  It runs in bootstrap's write phase, the migration and R32's repair, each under the lock and after
  the owner's yes; the prose never names it in a scheduled path (§7 C16).

## 4. Changes to merged library modules

### 4.1 scripts/lib/loop-scope.mjs (extend; `checkScope`, `markScope`, `inScope`, `scopeDigest` unchanged)

- `scopeGate(loopMdText, {root, baseRef = null}) -> {state:'ok', entries, digest} | {state:'refused',
  reason, detail, problems}`: `parseScope` (a throw is reason `unreadable`, detail its message; `bad-scope: ... empty
  entry` stays `unreadable`, so an empty entry is refused, spec-rep C-5), then
  `scopeEntriesGate(raw, {root, baseRef})`.
- `scopeEntriesGate(raw, {root, baseRef = null})`: `checkScope(raw)`: `whole` -> reason `whole`;
  `invalid` -> reason `invalid` with its problems; `ok` -> each entry checked for `placeholder` and
  `governed`, and for `not-a-directory` against `baseRef`'s tree only when `baseRef` is given (R26;
  never the working tree), any hit -> reason `invalid` with problems
  `[{entry, why: 'absolute'|'dotdot'|'malformed'|'placeholder'|'governed'|'not-a-directory'}]`.
  `ok` returns `checkScope`'s entries and `scopeDigest(entries)`. `root` is required (TypeError).
  Never throws on content.

### 4.2 scripts/lib/loop-md.mjs (extend)

`planScalar(text, key, value) -> {edits:[{old, new}], expect_sha256}`: refuses (throws
`bad-loop-md: ...`) whatever `frontScalar` refuses; a present key's line is replaced in place
(trailing comment dropped); an absent key is inserted as `<key>: <value>` immediately before the
closing `---` line, with an anchor that includes the line before it and is unique (0c-3 R14 anchor
rules); `expect_sha256` is the text's SHA-256 after the edits. `value` must match
`^[0-9a-z][0-9a-z.-]*$`.

### 4.3 scripts/lib/loop-state.mjs (extend; the grammar owner)

- `planResolve(text, {blockers = [], headings = []}) -> {state:'ok', edits,
  expect_sha256, applied:[{kind, item, ...}], skipped:[{kind, item, reason}]} | {state:'refused',
  reason:'crlf'|'stale-decision', detail}`. Each decision is applied only when it still matches the
  current problems exactly, else the whole call refuses `stale-decision` (nothing planned):
  - `blockers: [{item, blocked_by}]`: the item carrying `item` (one parsed carrier, no raw carrier;
    0c-3 R28, R30a) has a `title-blocker` problem whose `candidate` is `blocked_by`; the edit
    rewrites that `blocked-by:` line's value to `blocked_by`, nothing else.
  - `headings: [{id}]`: a `legacy-entry` heading whose candidate is `id`; the edit rewrites
    `### <title>` to `### <id> · <title>` (0c3-brief:175-178).
  (v2, decision 1) There is no `origins` decision: no planner rewrites an `origin:` line.
  Never touches an item with `ambiguous-title`, `duplicate-id`, raw carriers or `malformed-field`
  (down-rep D43).
- `originCandidates(state, pairs) -> [{item, parent, analysis_title, followup_title}]`: for each
  `{analysis_title, followup_title}` pair, exactly one `## Done` item has the analysis title's
  `normTitle` (the parent) and exactly one open item has the follow-up's `normTitle` and the origin
  `unknown`; any ambiguity drops the pair. (v2) Used only for the `## Last run` hints (R4); its
  result is never an edit.

### 4.4 scripts/lib/ledger.mjs (extend)

`legacyAnalysisPairs(S) -> [{analysis_title, followup_title}]`: rows with `item_id` absent or null
whose `notes` contain `analysis → <text>`, with `task` as the analysis title and `<text>` up to the
next `;` or the end as the follow-up title (rows 0c-3 wrote name an id there and are skipped).

### 4.5 scripts/loop-items.mjs (extend; still writes nothing)

`resolve <P> --input <file>` -> `planResolve`'s answer (exit 0 `ok`; exit 3 `stale-decision`,
`bad-input`, `crlf`). `<file>` is JSON `{"blockers":[{"item":"<id>","blocked_by":"<id>"}],
"headings":[{"id":"<id>"}]}` (any key may be absent; an `origins` key is `bad-input`;
unknown keys, non-id values or duplicates are `bad-input`), written by the main session with the
Write tool to `<S>/briefs/resolve.json`. `FLAGS.resolve = ['input']` (loop-items.mjs:77).

### 4.6 scripts/lib/legacy-worktree.mjs (new; moved)

`legacyFacts(dir, R)` moves unchanged from `scripts/loop-recover.mjs:504-535` (loop-recover imports
and re-exports it). New: `legacyPath(paths) -> <S>/worktree`; `worktreeEntry(R, dir) ->
{registered, locked, branch, head, detached, gitdir}` from `safeGit(R, ['worktree', 'list',
'--porcelain', '-z'])` matched by real path.

### 4.7 scripts/lib/git-safe.mjs (extend)

`linkedGit(wt, args, opts)` / `linkedGitRun(wt, args, opts)`: preconditions (else throw
`legacy-invalid: <why>`, `code = 'LEGACY_INVALID'`): `<wt.dir>/.git` is a regular file holding
`gitdir: <G>`; `realpath(G)` is `<common>/worktrees/<name>` where `<common>` is
`safeGit(R, ['rev-parse', '--path-format=absolute', '--git-common-dir'])`; `<G>/gitdir` names
`<wt.dir>/.git`; `<G>/commondir` resolves to `<common>`. Env: the scrub, then `GIT_DIR=<G>`,
`GIT_COMMON_DIR=<common>`, `GIT_WORK_TREE=<wt.dir>`, and the rest of `workGit`'s fixed values
(`GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`, `LC_ALL=C`, ...);
args prefixed with `WORK_OVERRIDES`. Never inherits `GIT_OBJECT_DIRECTORY` or
`GIT_ALTERNATE_OBJECT_DIRECTORIES`. Objects it writes land in `<common>/objects` (R12).

### 4.8 scripts/lib/changes.mjs (extend)

`openWorkTree(P, {env, layout = 'clone'})`: `layout: 'legacy'` returns `{P, R, S, V, W: <S>/worktree,
gitDir: <G>, commonDir: <common>, store: <V>/patches, layout: 'legacy', env}` after `linkedGit`'s
preconditions. Every git call goes through a per-layout runner (`workGit` for `clone`, `linkedGit`
for `legacy`); the direct reads at `changes.mjs:433` (`<W>/.git/index`) and `:502`
(`<W>/.git/info/exclude`) use `wt.gitDir/index` and `wt.commonDir/info/exclude`. The legacy layout
accepts rules mode `current` only (the worktree has no recorded rules; 0c-2 R2 listing rules apply
unchanged). Filter drivers are neutralized as for the clone (0c-2 R26). Any other layout is refused
`layout` as today.

## 5. The migration

### 5.1 The untrack step (spec:1011-1023; R6, R22)

Inside `run --step untrack`, in this order (v2: every `diff`/`diff-tree` below carries
`--ignore-submodules=none`; every call `-c core.safecrlf=false`; `.gitignore` is compared by
`hash-object --path=.gitignore` oids, R41):
1. Guard and recognize (R35, R22). `spineStatus` must read `tracked` or `migrate` (else exit 3
   `guard {verdict}`; `lost`/`regressed` with `SPINE.json` present is `switch-back`, R23). The step's
   own partial state comes **only** from `<V>/migration/0c/state.json` `untrack` (decision 1). A
   record in phase `recorded` or `staged` is resumed only while HEAD is `refs/heads/<branch>` at
   `head0`; otherwise roll back what is still the step's own, move the record to `untrack_history`
   and refuse `head-moved {branch, head0, head}` (R22). Done by git facts (nothing tracked in HEAD or
   the index, HEAD's `.gitignore` has the line) -> `ensureIgnored(R, {guard})` and `ignoreFacts` (g1#5)
   -> `{state:'done', commit, exclude_added}` (exit 0; only the exclude file may be written).
2. Preconditions (for a new record, and for a resumed one wherever its own change does not explain
   the fact): branch (`wrong-branch`, unless R6's `base-never-tracked` case, `detached-head`,
   `unborn-head`), `operation-in-progress {op}` (any of `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
   `REVERT_HEAD`, `BISECT_LOG`, `rebase-merge/`, `rebase-apply/` under `rev-parse --git-path`),
   `index-dirty {paths, remedy}` (`diff --cached --name-status -z --no-renames HEAD` holds anything
   but the recorded change; without a record, anything at all; R6's remedy by whether HEAD tracks the
   spine), `gitignore-not-regular` (R41), `gitignore-untracked {own_shape, remedy}` (`.gitignore`
   exists and `ls-files --error-unmatch` fails; R22's `own_shape`), `gitignore-dirty {remedy}` (the
   working file's oid is neither HEAD's blob oid nor the oid of `withLine(HEAD's bytes)`, a deletion
   included; unstaged edits are refused, spec:1145-1146), `switch-back` (R23), `scope-invalid`
   (step 1).
3. Record (new records only; `fault('migrate:after-record')` after): `untrack = {phase:'recorded',
   intent:{head0, branch, removals, before_oid, add_line}, head0, branch, removals:[path],
   gitignore:{existed, before_oid|null, after_oid}, exclude:{path}, commit:null}`. Nothing in `<P>`
   changes before this record is fsynced (decision 3).
4. `ensureIgnored(R, {guard})` (`negated` refuses; `fault('migrate:after-exclude')`).
5. When `ls-files -z -- .tech-lead` is non-empty: `rm --cached -r -q -- .tech-lead`
   (`fault('migrate:after-rm')`). The files stay on disk.
6. When the line is to be added (R41, each half independent): the working file's oid differs from
   `after_oid` -> write `withLine(working bytes)` (temp file and rename;
   `fault('migrate:after-gitignore')`); the index blob differs from `after_oid` ->
   `update-index --add -- .gitignore` (so a global ignore of dotfiles cannot block it;
   `fault('migrate:after-add')`). Phase `staged`.
7. Staged-set check: `diff --cached --name-status -z --no-renames --ignore-submodules=none HEAD`
   equals `D` for each recorded removal plus `M`/`A .gitignore` when the line was added, and the
   index blob of `.gitignore` equals `after_oid`; else roll back (R22) and refuse
   `staged-mismatch {expected, actual}`. `assertHeld`, and HEAD still `head0` on `<branch>`
   (`head-moved`).
8. Nothing staged (nothing tracked and the line already in HEAD): phase `done`, no commit.
   Otherwise `commit -q -F -` (no `--only`, no `-a`) with the message
   `chore: untrack the tech-lead loop spine` + blank line + `The spine stays on disk, ignored through
   .git/info/exclude and the /.tech-lead/ line. Before switching to another branch, read the
   README section "Upgrading to 0.7.0".` + blank line + `Tech-Lead-Migration: 0c` (no
   Co-Authored-By). A failure rolls back and refuses `commit-failed {detail}` (git's stderr, last 20
   lines). `fault('migrate:after-commit')`.
9. Post-commit check (R6): with `C = rev-parse HEAD`, `rev-parse C^` == `head0` and
   `diff-tree -r -z --no-renames --ignore-submodules=none --name-status head0 C` equals the recorded
   set with `.gitignore`'s blob == `after_oid`; else `commit-mismatch {expected, actual, rollback}`
   with R22's ROLLBACK built from `C` and `gitignore.existed` (the commit stays). Record `commit`,
   phase `done` (`fault('migrate:after-done')`).
10. `ignoreFacts(R)` must say ignored (else `negated {rules, sources}`). Exit 0 `{state:'untracked',
    commit, branch, removals (<=50), more, gitignore_added, exclude_added, warnings}`.

### 5.2 `<V>/migration/0c/state.json` (v2)

```
{"v":1,"stage":"0c","R":"<real path>",
 "untrack":null|{"phase":"recorded|staged|done",
   "intent":{"head0":"<oid>","branch":"<name>","removals":["<path>"],"before_oid":"<oid>|null","add_line":bool},
   "head0":"<oid>","branch":"<name>","removals":["<path>"],
   "gitignore":{"existed":bool,"before_oid":"<oid>|null","after_oid":"<oid>"},
   "exclude":{"path":"<abs>"},"commit":"<oid>|null"},
 "untrack_history":[<a retired untrack object plus {"retired_at":"<ISO>","why":"head-moved"}>],
 "worktree":null|{"phase":"saved|adopted|resetting|reset|removed|refused|skipped",
   "intent":{"path":"<abs>","branch":"<name>|null","head":"<oid>|null","dirty_digest":"<64hex>",
     "ignored_count":<int>,"date":"YYYY-MM-DD"},
   "path":"<abs>","branch":"<name>|null","head":"<oid>|null",
   "saves":[{"sha":"<64hex>","why":"migration","generation":<N>,"files":<int>,"out_of_scope":<int>,"head":"<oid>"}],
   "reset":null|{"sha":"<64hex>","base":"<oid>","started_at":"<ISO>"},
   "adopted":[{"branch":"<name>","tip":"<oid>","from":"origin|adopt|adopt-ff|present","previous":"<oid>|null"}],
   "refused":null|{"detail":"<git message>"},"removed_by":null|"loop"|"owner"},
 "created_at":"<ISO>","updated_at":"<ISO>"}
```

Written through `storageDir(V, 'migration/0c', {create:true})` and `writeReplace` (fsynced), only by
`run`, each write after `assertHeld`. (v2, decision 3) `saves` and `untrack_history` are
append-only: a write that would drop or change an entry is a bug the tests catch (MC-W13); the
`resetting` phase and its `reset` object are fsynced before the first destructive reset call
(R38). A file that does not parse as this schema refuses every `run` with `state-corrupt`; `plan`
reports it with `broken_saves` (R44; README row: note the shas, then move it to
`<V>/migration/0c.broken-<stamp>/`). Stage 1 keeps its own `<V>/migration/1/` (down-rep D4).

### 5.3 scripts/loop-migrate.mjs (new CLI; v2)

`plan <P>` (read-only; no lock; no quiesce) -> exit 0
`{state:'plan'|'complete', stage:<first pending token>, from, current_stage, R, branch, base,
steps:[...], warnings, pending_entries, origin_hints, broken_saves}`; exit 3 `version-unknown`; exit
2 errors (`not-toplevel` among them). (v2, R5) `stage` is `migrationNeeded(version).pending[0]`
and `steps` are that stage's only. `complete` (R39) when `spine_version:` already reads
`CURRENT_STAGE`, nothing is tracked by current git facts, and the worktree phase is `removed` or
`skipped` (or no `<S>/worktree` exists). Each step:

- `{step:'scope', state:'ok'|'refused', entries, digest, reason, problems, proposal:[dir]}`
  (`proposal`: the top-level directories `ls-tree -d --name-only <baseRef>` lists, minus names
  starting with `.`; the check passes `baseRef`, R26).
- `{step:'untrack', state:'todo'|'resume'|'done'|'refused', digest, head0, branch, base, removals,
  more, gitignore:{exists, tracked, has_line, own_shape}, exclude:{path, has_line}, refusals:[{code,
  detail, remedy}]}` (a recorded `head0` that is no longer HEAD on the recorded branch is reported
  `refused` with `head-moved`, so `run` sees `plan-changed`).
- `{step:'worktree', state:'skip'|'todo'|'resume'|'done'|'refused', phase, digest, path, branch,
  head, head_moved, dirty:{staged, tracked, untracked}, ignored:{count, sample}, codex_live, locked,
  collisions:[{branch, clone_tip, legacy_tip, kind}], saves:[sha], refused_detail, refusals}`.
- `{step:'ids', state:'todo'|'done', normalize_edits, candidates:[{kind:'title-blocker'|
  'legacy-entry', item, line, value, candidate, hint}], unresolved:[{item, reason}]}` (candidates
  name minted ids only after the normalize Edits; before them `item` is a title and the prose
  re-runs `plan`, R24).
- `{step:'version', state:'todo'|'done', value}` (`value` = `stage`).

`origin_hints`: `originCandidates` over `legacyAnalysisPairs` (R4; hints only). Step digests:
`sha256Hex(canonicalJson(intent))` with intent = untrack `{head0, branch, removals, before_oid,
add_line}`; worktree `{path, branch, head, dirty_digest, ignored_count, date}` (`dirty_digest` over
the sorted changed paths); ids `{candidates}`; version `{value, from}`; scope `{entries}`. (v2,
g1#8) A resumed or done step's intent is the `intent` object recorded in `state.json`, checked
against live facts (untrack: HEAD on the recorded branch at `head0`; worktree: live HEAD equals
the recorded `head`, else `head_moved: true` and the digest of the intent R38(c) would record).
`warnings`: R34's codes with their branches. `pending_entries`: R21's entries.

`run <P> --stage <token> --step <s> --plan <digest> --generation <N>` (`<s>` from
`RUN_STEPS[<token>]`) -> `assertHeld`, `chdir(V)`, re-plan; `--stage` not the first pending stage
-> exit 3 `stage-mismatch {pending}`; `scope` refused -> exit 3 `scope-invalid`; the step's digest
differs -> exit 3 `plan-changed {expected, actual}`; the spine verdict not allowed for the step
(R35) -> exit 3 `guard {verdict}`. Then:

| Step | Exit 0 | Exit 3 `state` |
|---|---|---|
| `untrack` | `untracked {...}` (§5.1) or `done {exclude_added}` | `not-holder`, `stage-mismatch`, `plan-changed`, `guard`, `scope-invalid`, `wrong-branch {branch, base}`, `detached-head`, `unborn-head`, `operation-in-progress {op}`, `index-dirty {paths, remedy}`, `gitignore-not-regular`, `gitignore-untracked {own_shape, remedy}`, `gitignore-dirty {remedy}`, `switch-back`, `head-moved {branch, head0, head}`, `negated {rules, sources}`, `staged-mismatch`, `commit-failed {detail}`, `commit-mismatch {expected, actual, rollback}`, `state-corrupt` |
| `worktree` | `retired {saves, adopted, removed:true}`, `skipped` (no `<S>/worktree`), `done` | `not-holder`, `stage-mismatch`, `plan-changed`, `guard`, `steps-pending {steps}` (untrack not done by git facts), `legacy-invalid {problem}`, `worktree-locked`, `legacy-detached`, `not-quiet`, `busy {procs}`, `index-only {paths}`, `unsavable {paths}`, `too-large`, `save-failed {detail}`, `adopt-failed {detail}`, `adopt-collision {branch, clone_tip, legacy_tip}`, `unsaved {paths}` (preflight), `head-moved {head, recorded}` (during `resetting`), `worktree-refused {detail}`, `state-corrupt`; exit 2 `partial: true` for a reset that began and could not finish (the `resetting` record stays; the next run resumes it) |
| `version` | `edits {file:'LOOP.md', edits, expect_sha256, value}` or `done` | `not-holder`, `stage-mismatch`, `plan-changed`, `guard`, `steps-pending {steps}` (untrack not done by git facts, or worktree not `removed`/`skipped`) |

`run --step version` prints the edit from `planScalar(LOOP.md, 'spine_version', <stage>)` (the
completed stage's token, R5); the main session applies it with Edit, and `plan` must then print
`complete` (or the next pending stage). There is no `--keep` (R25).

### 5.4 The worktree step (R12, R25, R38, R40; v2)

In `run --step worktree`, after `steps-pending`: no `<S>/worktree` -> phase `skipped` (a `refused`
phase whose path is gone and unregistered -> `removed`, `removed_by: 'owner'`). Else, by phase:

- new or `saved`/`adopted` (before any destruction): `legacyFacts` and `worktreeEntry` (refusals per
  R25, nothing written); `quiesce(<S>/worktree)` (`not-quiet`); `sweepOthers([<S>/worktree])`
  (`busy`, unknown -> exit 2); when there is no save yet, or the tree or HEAD differs from the last
  save (R38(c), after the owner's yes to the `plan-changed` re-plan): record the intent (with
  `date`), `saveLegacy` (§5.5) -> append to `saves`, phase `saved` (`fault('migrate:after-save')`);
  `verifyBundle(paths, sha, {layout:'legacy'})` for the last save; `adoptFor(paths, {generation: N,
  prefix, date, base})` (§5.6, R40) -> record `adopted`, phase `adopted`
  (`fault('migrate:after-adopt')`).
- then: `resetLegacy(paths, {holder: N, sha: <last save>, anchored: saves, preflight: true})`
  (read-only: bundle verified, HEAD == base, no `index.lock`, nobody busy, no change since the save;
  a refusal leaves the phase as it is, nothing destroyed; `unsaved {paths}` means the tree changed
  after the save, and the next `plan` reports `plan-changed` so the owner confirms a re-save);
  `assertHeld`; record phase `resetting` with `reset: {sha, base, started_at}` (fsynced;
  `fault('migrate:after-reset-intent')`); `resetLegacy(paths, {holder: N, sha, anchored: saves,
  record: <the reset object>})` -> phase `reset` (`fault('migrate:after-reset')`).
- `resetting` (resumed): `resetLegacy` resumes against `reset.sha` only (R38(a)); never a save;
  HEAD moved -> `head-moved`, nothing reset.
- `reset` or `refused`: re-check that the tree is clean against `reset.base`; `assertHeld`;
  `safeGit(R, ['worktree', 'remove', <S>/worktree])` (no `--force`): success -> phase `removed`
  (`removed_by: 'loop'`; `fault('migrate:after-remove')`); failure -> phase `refused` with git's
  message, exit 3 `worktree-refused`.

An `empty` save with a dirty index resets the index only (`read-tree HEAD` through `linkedGit`,
after the index-only check), under the same `resetting` record.

### 5.5 scripts/reflex-bundle.mjs (extend)

- `WHYS` gains `'migration'` (`scripts/reflex-bundle.mjs:101`); stage 3 adds its own to the same list.
- `saveLegacy(paths, {saver, env}) -> saveFor's result shape`: `assertHeld`; `openWorkTree(P,
  {layout:'legacy'})`; base = the worktree's HEAD; rules = `currentRules(wt)`; then `saveFor`'s
  steps unchanged (index-only, unsavable, too-large, the apply check against base in the legacy
  layout); header `why:'migration'`, `generation: saver`, `source: {generation: null}`,
  `item_id: null`, `item_digest: null`. Writes no run record (the caller records the sha).
- `resetLegacy(paths, {holder, sha, anchored, preflight = false, record = null, env})`: `anchored`
  (every sha in `saves`) must hold `sha` (else `not-anchored`). (v2, R38) With `preflight: true` it
  is read-only: `verifyBundle(paths, sha, {layout:'legacy'})`, HEAD == header base (`head-moved`),
  `index.lock` -> `index-locked`, `sweepOthers` -> `busy`, and `resetFor`'s "nothing unsaved"
  precondition (`unsaved {paths}`). Without it, `record` (the persisted `reset` object naming `sha`;
  else `not-anchored`) must exist, and the call follows `resetFor`'s durable resetting protocol
  (`scripts/reflex-bundle.mjs:731-764`): it re-checks HEAD == base and the bundle, never the
  "unsaved" precondition (a partly reset tree is expected to differ, and the persisted record is
  what proves the save came first), then one-file-at-a-time unlinks and `read-tree --reset -u
  <base>` through `linkedGit`, each destructive step after `guard()`. A resumed call does exactly
  the same against the same record.
- `verifyBundle(paths, sha, {layout = 'clone'})`: `legacy` replays onto the base in `<P>`'s object
  store through a temp index under `<V>/patches` (base exists there, down-rep D34).
- `saveFor` accepts `why:'migration'` only from `saveLegacy`; the `save` CLI's `parseArgs` treats
  `--why migration` as a usage error (R28).

### 5.6 scripts/loop-clone.mjs (extend; v2)

- Export `adoptFor(paths, {generation, prefix, date, base, env}) -> {state:'adopted', created,
  adopted: [{branch, tip, from, previous}], notes}`: `assertHeld`; `validDate(date)` (TypeError
  otherwise, g2#4); R27's record; `<W>` missing -> `ensureClone(paths, {generation, prefix, date,
  base})` (`created: true`); else `checkClone` (`clone-invalid`), `quiesce(W)` (`not-quiet`),
  `sweepOthers([W])` (`busy`), `refresh(paths, W, baseRef, {adopt: true})`
  (`scripts/loop-clone.mjs:491-506`, stays private), then (v2, R40) for each candidate dated branch:
  a name the clone lacks -> `adoptBranches`' create-only `update-ref` (`from:'adopt'`); a name it has
  -> same tip or the incoming tip an ancestor of the clone's: `from:'present'`; the clone's tip an
  ancestor of the incoming one and the branch not checked out in `<W>`: compare-and-swap
  `update-ref refs/heads/<name> <incoming> <clone tip>` (`from:'adopt-ff', previous`); otherwise
  refuse `adopt-collision {branch, clone_tip, legacy_tip}` before any ref moves. Then `updateRecord`
  appending to `adopted` (0c-2 R28), delete `refs/tech-lead/adopt/*`, `checkClone`. Fault points
  `adopt:after-refresh`, `adopt:after-ff`, `adopt:after-record`. `adoptBranches` keeps its
  create-only behaviour for `prepare`; the collision rule lives only in `adoptFor`.
- CLI `adopt <P> --generation <N> --prefix <p> --date <YYYY-MM-DD> [--base <b>]` wraps it (exit 3
  `not-holder`, `clone-invalid {problems}`, `not-quiet`, `busy {procs}`, `no-base`,
  `adopt-collision`, `infra {detail}`). It is the third sanctioned `<W>` mutation path besides
  `prepare` and Save and reset (0c-2 R13); no prose names it (C13).
- `close` keeps an adoption record per R27.
- (v2, g2#8) `check` and `commit` read `<S>/LOOP.md` and run `scopeGate(text, {root: R})` (no
  `baseRef`) before `scopeOf`; a refusal is exit 3 `scope-invalid {reason, problems}` and nothing is
  committed. `markScope` stays permissive for saves (0c-2 R17).

### 5.7 scripts/loop-recover.mjs (small)

Imports `legacyFacts` from `scripts/lib/legacy-worktree.mjs` and re-exports it. The note at
`scripts/loop-recover.mjs:748` reads: `the old worktree <path> holds uncommitted changes; the
migration (references/migration.md) saves and retires it`.

### 5.8 scripts/loop-lock.mjs (extend; v2, R36)

- `release <P> --generation <N> [--carry]`: with `--carry`, before the release the lock record gains
  `carried: [...]` = the record's existing `carried` plus this generation's acquire facts
  (`reclaimed`, `stopped`, as `acquire` recorded them in generation N's slot record when it returned
  them; v2 adds that write where the slot does not hold them yet; never passed on the command line), deduplicated by `{generation, how}` and child identity. Without `--carry` a
  release leaves `carried` as it is.
- `acquire` returns `carried` (absent when empty). A firing clears it with
  `loop-lock.mjs noted <P> --generation <N>` (fenced; drops exactly the entries it was given), run
  right after `## Last run` is written at §8 step 1, bootstrap step 8 or migration step 8.
- C7's lists name `--carry` on every no-write exit's release line.

## 6. Prose (every file and section)

### 6.1 skills/loop/SKILL.md

- Frontmatter description (:3): add "or whose spine needs migrating".
- "Memory" (:11-16): the work area also holds the spine copy (`<V>/spine`) and the migration's
  record (`<V>/migration`).
- "Where the details live" (:19-28): add "migration of an existing spine: `references/migration.md`".
- §1 step 1 (:39-47): new last bullet **Interactive or scheduled** with R1's definition and R31 (no
  mention of `LOOP.md`; check `scripts/checks/loop.mjs:254-262`).
- §1 step 2 (:48-49): "If `<S>` is missing, follow `references/bootstrap.md`. Bootstrap ends the
  firing.", with "It takes no lock" replaced by "It takes the lock only for its write phase"; (v2,
  G6) in a scheduled firing `<S>` missing instead stops the runner and prints
  `spine needs an interactive run (missing)` (no lock is held yet).
- §1 step 3 (:50-133): the exit-3/exit-2 bullet's "the only exceptions" sentence names the spine
  guard's exits (step 4, and R35's later hits), the restore and anchor firings and bootstrap too;
  the Lost lock bullet adds `loop-spine.mjs save`, `restore --token`, `ignore`, `status --restored`,
  `loop-migrate.mjs run` and `loop-clone.mjs adopt` exit 3 `"state": "not-holder"`; (v2, R36) the
  bullet that notes `reclaimed` and `stopped` in `## Last run` also notes acquire's `carried`.
- §1 step 4 (:134-139) becomes **4. Guard the spine, then read state.** First bullet runs
  `node <T>/scripts/loop-spine.mjs status <P>` and acts on `state` per R17 (one bullet per verdict;
  the no-write exit per R2 spelled out once: write nothing in `<S>`, release with
  `node <T>/scripts/loop-lock.mjs release <P> --generation <N> --carry`, stop the runner, print the
  reason with acquire's `reclaimed`, `stopped` and `carried` facts; the exact phrases
  `migration needs an interactive run`, `spine needs an interactive restore`,
  `spine needs an interactive run (not ignored)`, `spine needs an interactive run (missing)`,
  `spine needs an interactive run (unanchored)`); the R18 restore procedure as a sub-list (with
  `--generation`, the ledger written last and the `status --expect ... --restored` check); the R37
  anchor firing as a sub-list; then the existing read bullets, plus "`spine_version:` reads the
  current stage here; the guard sent every other value away". (v2, R35) A second bullet defines
  **Guard before writing** once: run `node <T>/scripts/loop-spine.mjs guard <P> --allow ok` right
  before each governance-write sequence (named where it applies: §2, §3, §4-§7 STATE.md or LOOP.md
  edits, §8 step 1); exit 3 is the no-write exit above, printing the summary the firing would have
  written instead of writing it. Steps 3 and 5 keep their numbers and titles (checks `loop.mjs:338`, `:497`,
  `:727`, `:752`).
- §2 (:233-250): gates become 1 Paused, **2 Scope**, 3 Circuit breaker, 4 Daily budget, preceded by
  "Guard before writing" (R35) ahead of the first gate that writes. Scope:
  `node <T>/scripts/loop-spine.mjs scope <P>` (syntactic, R26); exit 3 -> incident in `## Last run`
  naming the reason and each problem, outcome `halted`, `paused: true`, note
  `scope invalid: <reason>`, stop the runner. The new text must not contain the phrase "whose
  outcome is" (contracts.mjs:103). (v2, g2#8) Where §5-§7 run `loop-clone.mjs check` or `commit`,
  an exit 3 `scope-invalid` is the same incident.
- §3 (:259 on): "Guard before writing" before the pick's first STATE.md Edit; §4-§7: the same before
  each step that edits `STATE.md` or `LOOP.md`.
- §3 step 1 (:259-277): unchanged (R11).
- §8 step 2 (:837-847): "those are the only exceptions" becomes the full list (R2, R20).
- §8 step 1: "Guard before writing" first (R35); then `## Last run`; then
  `node <T>/scripts/loop-lock.mjs noted <P> --generation <N>` when acquire returned `carried` (R36).
- §8 step 3 (:848 on): before `loop-clone.mjs close`, **Anchor the spine**:
  `node <T>/scripts/loop-spine.mjs save <P> --generation <N>`; on `saved`, write `<S>/SPINE.json`
  with the Write tool, content exactly `text`; then
  `node <T>/scripts/loop-spine.mjs status <P> --expect <sha256>`; `not-holder` is a lost lock; any
  other exit or a mismatch goes into the summary and never blocks close or release (R19).
- Runners, Scheduled (:926-928): "The bootstrap confirmation is the sole exception" gains: the
  migration, the restore, the exposed repair and the anchor firing never run in a scheduled firing
  (R1); define "stop the runner" once (CronDelete / `ScheduleWakeup({stop: true})` / the printed
  reason for OS cron); (v2, G8) `Run /tech-lead:loop <P>` is the only supported scheduled prompt
  (also at SKILL.md:30-31).
- Safety rails (:1037-1043) become: "The loop never writes `<P>`'s tree or `.git` outside `<S>`,
  except in an interactive firing: the exclude-file line (bootstrap, the migration, the exposed
  repair), the migration's untrack commit with its `.gitignore` line, the legacy save's objects and
  reset, and `git worktree remove` of the old worktree (`references/migration.md`)." / "Modify files
  only under `scope:` paths in `<W>`, and in `<S>`." / "Spine updates are written to disk and never
  committed by the loop. The migration's untrack commit, which commits removals and one
  `.gitignore` line and never spine content, is the only exception."
- The phrase "bootstrap commit" disappears from SKILL.md.

### 6.2 skills/loop/references/bootstrap.md (one merged text; v2)

Title: "Loop Bootstrap (a project with no spine)". "Who is attending": interactive firings only
(R1, R31); keep the one confirmation question; a scheduled firing never reaches this file (R2, G6).
**Interview (unlocked; writes nothing):**
1. **Check the project.** `node <T>/scripts/loop-spine.mjs status <P>`: refuse `tracked`,
   `copy-exists` (`copy_exists` true; name `<V>/spine`, README "Restoring a wiped spine", and the
   start-fresh remedy), `history` (`ledger_rows` > 0), `migrated-before` (R8: `<V>/migration/0c/`
   exists or `git -C <P> log -1 --format=%H -- .tech-lead` prints a commit; show the commit and
   `git -C <P> restore --source=<commit>^ -- .tech-lead`; continue only on an explicit yes to
   "start a new spine anyway"), and an exit 2 (`not-toplevel` among them; spec:152-156). (v2, R37)
   On `partial`, show the existing `STATE.md` (and say the ledger is empty) and ask: keep it (the
   default; step 8 then writes nothing and step 4 builds on it) or replace it (show the difference
   first; replace only on an explicit yes). On `unanchored`, bootstrap is not the path: the anchor
   firing is (R37).
2. **Choose `base:`** (today's step 2 text), then
   `node <T>/scripts/loop-spine.mjs status <P> --base <base>`: a non-empty `tracked.base` refuses.
3. **Detect `verify:` candidates** (today's step 3).
4. **Build the initial `## Backlog`** (title and anchors kept for `scripts/checks/loop.mjs:667-722`:
   `- origin: bootstrap`, `blocked-by: <the other item's title>`, the none spellings and the
   ` (task)` rename). The closing sentences change: the write phase mints ids and replaces each such
   title with the prerequisite's id (step 9), so a bootstrapped dependent is parked only when no
   unique candidate exists.
5. **Choose `scope:`**: propose top-level directories of `<base>` (`git -C <P> ls-tree -d
   --name-only <base>`, without dot-directories), let the owner pick or type, write
   `{"scope": [...]}` to a temp file outside `<P>` with the Write tool, and run
   `node <T>/scripts/loop-spine.mjs scope <P> --input <file> --base <base>`; repeat until `ok`; keep
   its canonical `entries`.
**Write phase:**
6. **Acquire** `node <T>/scripts/loop-lock.mjs acquire <P>` (held or error: end, write nothing);
   re-run step 1's `status`; anything that refuses now: release, stop.
7. **Ignore the spine.** Ask the confirmation question (it covers this write); then
   `node <T>/scripts/loop-spine.mjs ignore <P> --generation <N>`; `negated`: release, tell the owner
   each rule printed (`rules`, or the `sources` scanned).
8. **Write `STATE.md` and an empty `LEDGER.jsonl`** after
   `node <T>/scripts/loop-spine.mjs guard <P> --allow absent,partial` (template; a kept `partial`
   `STATE.md` is not rewritten, only its `## Last run` is; `## Last run` holds
   `bootstrapped <UTC ISO>: spine_version <current_stage>; base <base>; scope <entries>; verify <n>
   commands; ignored through <exclude path>; never committed. The first iteration is the next
   firing.` plus acquire's `carried` facts, then `loop-lock.mjs noted` when there were any).
9. **Mint ids and resolve dependencies.** `guard --allow partial`; `loop-items.mjs normalize <P>`,
   Edits, `check --expect`; then for each `title-blocker` problem with a `candidate` (the owner named
   that dependency in step 4), write `{"blockers": [...]}` to `<S>/briefs/resolve.json` with the
   Write tool, run `loop-items.mjs resolve <P> --input <S>/briefs/resolve.json`, Edits,
   `check --expect`.
10. **Write `LOOP.md` last** after `guard --allow partial` (template; `base`, `verify`, the canonical
    `scope` entries, `spine_version: <current_stage>` from step 1's status).
11. **Anchor the spine.** `node <T>/scripts/loop-spine.mjs save <P> --generation <N>` (it accepts
    the `unanchored` verdict, R35), Write `<S>/SPINE.json`,
    `node <T>/scripts/loop-spine.mjs status <P> --expect <sha256>`.
12. **Release** `node <T>/scripts/loop-lock.mjs release <P> --generation <N>`. No ledger row (R20).
A guard hit at steps 8-11 releases with `--carry` and stops (R35). An interruption after step 8
leaves `partial` (the next interactive firing resumes here, keeping the files); after step 10,
`unanchored` (the next interactive firing anchors). No `git add`, `git commit`, `.gitignore` edit or
dirty-index refusal remains.

### 6.3 skills/loop/references/migration.md (new; v2)

Sections: "When" (§1 step 4 handed over in an interactive firing; never scheduled; the lock was
released); "What it changes" (the five steps of R4, the exceptions to the rails, the ignored files
the worktree removal deletes, the `/.tech-lead/` line in the exclude file and `.gitignore`); the
procedure:
1. `node <T>/scripts/loop-migrate.mjs plan <P>` (unlocked). `complete`: tell the owner, end.
2. Scope: per R21 until `plan` shows it `ok`.
3. Show the owner every step's state, refusals with their remedies, warnings (R34, including
   `base-never-tracked`), `pending_entries`, `broken_saves` (R44), the worktree's dirty and ignored
   files, adoption collisions, a worktree `refused` with git's message (ask the owner to fix the
   cause; the README row gives the owner's own way out once the tree is clean and saved; R25), and a
   `head_moved` worktree (ask for a yes to save again, R38). Collect a yes for the untrack commit on
   `<branch>` (named), and for the worktree retirement. Refusals the owner must fix (wrong branch,
   dirty index, a collision, ...) end here; the owner re-invokes the loop.
4. `node <T>/scripts/loop-lock.mjs acquire <P>` (held or error: end without writing).
5. `node <T>/scripts/loop-migrate.mjs run <P> --stage <stage> --step untrack --plan <digest>
   --generation <N>`.
6. `node <T>/scripts/loop-migrate.mjs run <P> --stage <stage> --step worktree --plan <digest>
   --generation <N>`.
7. Ids (R4, R24): `node <T>/scripts/loop-spine.mjs guard <P> --allow migrate,ok`;
   `loop-items.mjs normalize <P>`, Edits, `check --expect`; then `loop-migrate.mjs plan <P>` again
   (read-only) for the candidates by minted id; show each candidate with its hint and collect a yes
   or no per candidate (the lock stays held; R3); when the owner accepted any, `guard --allow
   migrate,ok`, write `<S>/briefs/resolve.json` with the Write tool, `loop-items.mjs resolve <P>
   --input <S>/briefs/resolve.json`, Edits, `check --expect`. No origin is written (R4).
8. Finalize (R39), only when `plan`'s untrack step reads `done` by current git facts:
   `guard --allow migrate,ok`; `## Last run` (the R33 summary, every save sha, the refusals, R21's
   entries, unresolved items, the origin hints `legacy follow-up <id> may come from analysis <id>;
   origin stays unknown`, acquire's `carried` facts) and `loop-lock.mjs noted` when there were any;
   one ledger row (R33); Anchor the spine (as §8; `save` accepts `migrate`); then, when every step is
   done, `node <T>/scripts/loop-migrate.mjs run <P> --stage <stage> --step version --plan <digest>
   --generation <N>` and the Edit, and `plan` must print `complete` (or the next pending stage).
9. `loop-clone.mjs close <P> --generation <N>`, release. Not untracked: write nothing in `<S>`,
   release with `--carry`.
A refusal or exit 2 at steps 5-7 skips to 8 (or to 9 when not untracked); a guard hit at any step
takes R2's no-write exit (release with `--carry`, print the summary). The owner conversation about
a refusal happens after the release. The file names no `reflex-bundle.mjs save`, no `git commit`,
`git rm`, `git worktree`, `git stash`, `checkout --`, `reset --hard`, `--force` or
`loop-clone.mjs adopt`.

### 6.4 skills/loop/references/loop-templates.md

- LOOP.md template (:13-31): `scope:` / `  - <directory the loop may change, e.g. src>` and a new
  last key before `---`: `spine_version: <current stage>   # last stage whose migration completed;
  written by bootstrap and the migration`.
- Defaults paragraph (:33-37): a missing `spine_version:` means a spine from before stage 0c (the
  migration); the scope rules (repository-relative directories; never `.`, `./`, `/`, an empty
  entry, an absolute path, `..`, a path under `.git` or `.tech-lead`, a file, or a placeholder;
  canonical form; the prefix-component rule with `src`/`src-old`).
- STATE.md template note (:73-74): bootstrap writes items with `origin: bootstrap` and no `id:`
  line, then mints ids with `normalize` itself.
- Briefs paragraph (:278-279): "every path under `.tech-lead/` is ignored through the exclude file,
  and the loop never commits it".
- LEDGER rule (:285-289): R2's and R20's exceptions; outcome enum gains `migrated`; `saves.why`
  (:304) gains `migration`.
- "Project .gitignore addition (bootstrap)" (:381-387) becomes "## Spine ignore line" with the one
  line `/.tech-lead/`, written to the exclude file by bootstrap and the migration and committed to
  `.gitignore` by the migration; the old three lines stay in existing repositories (the migration
  removes none, down-rep D10).

### 6.5 skills/quick/SKILL.md

- §0 "Loop spine present" (:35-46) is replaced by a pointer: the spine check runs in §2 after the
  fetch.
- §2 (:64-72) gains, between step 2 (`git fetch origin <base>`) and step 3: **Spine check.** Run
  `git -C <repo> ls-tree -r --name-only origin/<base> -- .tech-lead`,
  `git -C <repo> ls-files -- .tech-lead` and `git -C <repo> ls-tree -r --name-only HEAD -- .tech-lead`.
  Any output: do not switch branches in the user's checkout (git would overwrite the ignored live
  spine with the base's copy, or delete it on the way back); create the separate worktree with
  `git -C <repo> worktree add -b feature/<slug> <tmpdir>/quick-<slug> origin/<base>` and run every
  later command there (the existing sub-bullets move here). No output: step 3 switches in place. In
  the worktree a tracked `.tech-lead/` is a stale copy, never the live spine (down-rep D52).
- "If you stop before making any edits" (:74-79): unchanged; it is safe because an in-place switch
  only happens when neither tree tracks the spine.

### 6.6 SKILL.md (root) and templates/rules-tech-lead.md

No change (prose-rep §7).

### 6.7 README.md

- :13 "Version 0.7.0." (`scripts/checks/repo.mjs:131`); `.claude-plugin/plugin.json` 0.7.0.
- `/tech-lead:quick` Preflight (:409-412): "If your branch or the base it branches from tracks
  `.tech-lead/`, it works in a separate git worktree, so a switch never overwrites or deletes the
  loop's spine."
- Running (:504-506): a headless run also refuses to migrate (`migration needs an interactive run`);
  `/loop` counts as scheduled (R1).
- One iteration (:535-542): Rehydrate names the spine guard; Gates names the scope gate.
- Scope rail (:555) and Never (:850): the scope definition (directories only, no whole repository,
  the prefix rule).
- The spine (:580-591): the whole spine is ignored through the exclude file; `SPINE.json` row (the
  branch-switch anchor; no branch ever tracks it); `worktree/` points to "Upgrading to 0.7.0".
- `LOOP.md` defaults (:609-610): byte-equal to the template (contracts.mjs:113-123).
- The firing lock (:670-688): "finds a spine" per R17; "the only two ways" becomes the full list.
- The work area (:723-742): rows `spine/` (the copy per generation, each with `anchor.json`, and a
  `restore-pending.json` marker during a restore) and `migration/` (the migration's resume record
  with every save sha); clearing `~/.cache` drops the copy, so a lost spine then has nothing to
  restore from.
- Safety, Where commits land (:828-831): a new spine is never committed and never shows in
  `git status`; the migration makes one commit on the base (removals and the `/.tech-lead/` line);
  merge it into other branches in a temporary worktree (R16) and push the base. Never (:847-848): the §6.1 rail wording.
- First run (:855-864): asks for `scope:` and refuses whole-repository spellings; writes
  `spine_version:`; ignores the spine through `.git/info/exclude`; never commits; notes itself in
  `## Last run`; resolves dependencies to ids with you; the dirty-index bullet goes.
- New **Upgrading to 0.7.0** after "Upgrading to 0.5.0" (:866-891, whose "a later release retires
  it" points here): stop runners; run `/tech-lead:loop` interactively once on the base branch (or,
  when the base never tracked the spine, on the branch that does, R6); what the migration does (each
  step, the commit, the save with why `migration`, adoption and its collision rule, removal without
  `--force`, the ignored files git deletes with the worktree, the scope question, ids, the origin
  hints, `spine_version: 0c`); (v2, R16) merging the untrack commit into other branches only through
  a temporary worktree (`git -C <P> worktree add <tmp> <branch> && git -C <tmp> merge <base> &&
  git -C <P> worktree remove <tmp>`), never by switching `<P>`; push the base so other clones ignore
  the spine; (v2) what a pull does (an unmodified tracked spine is deleted, a modified one makes the
  pull abort): another clone that runs the loop upgrades and migrates there before pulling, anyone
  else copies `.tech-lead/` aside first; `git clean -x` deletes the ignored spine; (v2, R43) getting
  a migration bundle's work back by hand in a temporary worktree at its base (`git -C <P> worktree
  add --detach <tmp> <base>`, `git -C <tmp> apply <V>/patches/<sha>.patch`, commit on a new branch
  there, `git -C <P> worktree remove <tmp>`; stage 3 automates it); `Run /tech-lead:loop <P>` is the
  only supported scheduled prompt (G8); the routing rule is unchanged (R30); fetching loop branches:
  "Reviewing loop work".
- **Restoring a wiped spine** (new subsection): `<S>` gone with `SPINE.json` (for example after
  `git clean -fdx`) cannot be restored by the loop; (v2, R43) copy the three spine files from the
  newest `<V>/spine/<g>/` whose name is a plain integer (never a `.partial-*` directory) to `<S>/`,
  and its `anchor.json` to `<S>/SPINE.json`, then run the loop interactively; to start fresh
  instead, move `<V>/spine` aside and bootstrap.
- (v2, OX11) Repository layout (:989-1022): entries for `skills/loop/references/migration.md`,
  `scripts/loop-spine.mjs`, `scripts/loop-migrate.mjs`, `scripts/lib/spine.mjs`,
  `scripts/lib/legacy-worktree.mjs`.
- Troubleshooting (:893-929), one row each (cause; fix): `migration needs an interactive run`;
  `spine needs an interactive restore` (with G9's "to keep the live spine as it is, delete
  `<S>/SPINE.json`; the next interactive firing anchors it"); `spine needs an interactive run (not
  ignored)`; `spine needs an interactive run (missing)` (run `/tech-lead:loop` in a terminal
  session; bootstrap resumes a partial spine); `spine needs an interactive run (unanchored)`;
  `restore-incomplete` (the printed `cp` commands, then an interactive firing); a branch switch
  during a firing (the guard's printed summary is the record; R35); tracked spine on a migrated
  project (`switch-back`, merge in a temporary worktree); index-only tracking (`git -C <P> rm
  --cached -r -q -- .tech-lead`, G3); `anchor-invalid`; `version-unknown` (a newer plugin wrote it);
  `copy-tampered` / `no-copy` (merge by hand, then delete `SPINE.json` so the next interactive firing
  re-anchors; if `LOOP.md` is gone too, restore it by hand or move `<V>/spine` aside to start fresh);
  `copy-in-use`; `too_large` restore (`cp`); `token-changed` (re-run the loop; the spine changed while
  you read the difference); `scope invalid: <reason>` (each reason; also from `check`/`commit`);
  bootstrap `tracked`, `copy-exists` (or move `<V>/spine` aside to start fresh), `history`,
  `migrated-before` (the printed restore command); migration `wrong-branch` (merge in a temporary
  worktree or check out the base), `base-never-tracked`, `detached-head`, `unborn-head`,
  `operation-in-progress`, `index-dirty` (both remedies), `gitignore-not-regular`,
  `gitignore-untracked` (the `own_shape` remedy), `gitignore-dirty`, `negated` (the rules printed),
  `staged-mismatch`, `commit-failed`, `commit-mismatch` (the printed ROLLBACK, only while HEAD is
  the commit), `head-moved` (untrack: re-run; worktree: the re-save question), `plan-changed`,
  `stage-mismatch`, `steps-pending`, `state-corrupt` (note `broken_saves`, then move the file
  aside), `legacy-invalid`, `worktree-locked`, `legacy-detached`, `not-quiet`, `busy`, `index-only`,
  `unsavable`, `too-large`, `save-failed`, `adopt-failed`, `adopt-collision` (rename one branch),
  `unsaved` (the re-save question), `worktree-refused` (fix the cause and re-run; once the tree is
  clean and saved you may run `git -C <P> worktree remove --force <S>/worktree` yourself; the
  migration stays pending until the worktree is gone, R25); remote base still tracking
  (`remote-base-tracks-spine`). The `title-blocker` (:949) and `legacy-entry` (:955) rows say the
  migration offers the candidate. A cron or `/loop` prompt that types `/tech-lead:loop` directly is
  unsupported (G8).

## 7. Checks (scripts/checks/loop.mjs unless named; each with a mutation test in tests/check.test.mjs)

- **C1** (replaces `contracts.mjs:107-112`) "dup: spine ignore line": `IGNORE_LINE` read from
  `scripts/lib/spine.mjs` source == the single line of loop-templates.md "## Spine ignore line"
  block (v2, OX8: source and template only; migration.md's "What it changes" names the line too and
  is compared when present). Mutation: change the template line to `.tech-lead/`.
- **C2** bootstrap.md stages and commits nothing: no `git add`, `git commit`, `git rm`,
  `update-index` or `.gitignore` write. Mutation: append the old step 6 command.
- **C3** §1 step 4 runs `loop-spine.mjs status <P>` before any other command in steps 4 and 5, and
  names each R17 verdict (v2: `restore-pending`, `partial`, `unanchored` included). Mutation: move
  the status line after the planner.
- **C3b** (v2, R35) "Guard before writing": SKILL.md defines `loop-spine.mjs guard <P> --allow ok`
  once in §1 step 4 and names it in §2 (before the first gate write), §3 (before the pick's Edits)
  and §8 (before step 1); migration.md names `guard <P> --allow migrate,ok` before the normalize
  Edits, the resolve Edits and the finalize; bootstrap.md names `guard` before steps 8, 9 and 10.
  Mutation: drop the §8 guard line.
- **C4** The five exit phrases (R2, R37) appear verbatim in SKILL.md §1 step 4 and README
  Troubleshooting; `migration needs an interactive run` also in migration.md;
  `spine needs an interactive run (missing)` also in SKILL.md §1 step 2. Mutation: reword one.
- **C5** §2 lists Paused, Scope, Circuit breaker, Daily budget in that order; the Scope gate runs
  `loop-spine.mjs scope <P>` and records `halted` with `paused: true`. Mutation: swap gates 2 and 3.
- **C6** §8 runs `loop-spine.mjs save <P> --generation <N>` after "Append exactly one ledger entry",
  then `loop-spine.mjs status <P> --expect <sha256>`, both before `loop-clone.mjs close`. Mutation:
  put save after close.
- **C6b** (v2, R18) the restore sub-list names `restore <P> --token <token> --generation <N>`, the
  ledger written last, and `status <P> --expect <sha256> --restored --generation <N>`. Mutation:
  drop `--restored`.
- **C7** (extends `:366-386`) each of the four places names ending at the lock, losing the lock,
  the spine guard's exits, the restore and anchor firings and bootstrap; every no-write exit's
  release line carries `--carry` (R36). Mutation: drop "bootstrap" from README.
- **C8** Safety rails: no "bootstrap commit" anywhere in SKILL.md or README; the rail names the
  untrack commit and the exclude file. Mutation: restore the old rail sentence.
- **C9** quick §2 runs all three commands, `ls-tree -r --name-only origin/<base> -- .tech-lead`,
  `ls-files -- .tech-lead` and `ls-tree -r --name-only HEAD -- .tech-lead`, after
  `git fetch origin <base>` and before `git switch -c` (v2, OX8); §0 no longer names
  `ls-files --error-unmatch .tech-lead/LOOP.md`. Mutation: move the check before the fetch; drop the
  HEAD command.
- **C10** (`contracts.mjs`) every documented LOOP.md yaml block (template, README defaults) parses
  with `parseScope`, and `checkScope` gives neither `whole` nor `invalid`; both hold a
  `spine_version:` line. Mutation: `- ./`.
- **C11** migration.md names no `reflex-bundle.mjs save` (the R28 exemption, also stated in the
  `:823-838` check's comment), no `git commit`, `git rm`, `git worktree`, `git stash`, `--force`,
  `--keep` or `loop-clone.mjs adopt`; every `loop-migrate.mjs run` carries `--stage`, `--plan` and
  `--generation <N>`; step 3 names the `refused` worktree handling (v2, OX5). Mutation: add a save
  line.
- **C12** the `:447-460` check covers bootstrap.md and migration.md too (`git -C <W>`,
  `worktree add`); `tests/check.test.mjs:415-430` drops its "0c-4 owns bootstrap.md" exception.
- **C13** the `--generation <N>` fencing check (`:462-479`) covers `loop-spine.mjs save`, `ignore`,
  `restore --token`, `status --restored` and `loop-migrate.mjs run`; (v2, OX8) `loop-clone.mjs adopt`
  is asserted absent from `skills/`. Mutation: drop it from the §8 save; drop it from `ignore`.
- **C14** the Lost lock bullet names `loop-spine.mjs` and `loop-migrate.mjs` exit 3 not-holder.
- **C15** bootstrap.md step 4 still satisfies `:667-722`; `tests/check.test.mjs:798-810` and
  `:875-890` slice to `'5. **Choose'` instead of `'5. **Update'`.
- **C16** no scheduled path names a write to `<P>`: the Runners "Scheduled" bullet names the
  migration, the restore, the exposed repair and the anchor firing as interactive only and
  `Run /tech-lead:loop <P>` as the only scheduled prompt, and §1 step 4's scheduled bullets name no
  `loop-spine.mjs ignore`, `restore`, `save` or `loop-migrate.mjs`. Mutation: add `ignore` to the
  scheduled `exposed` bullet.
- **C17** (v2, OX9) bootstrap.md's write phase names, in order: `loop-lock.mjs acquire`,
  `loop-spine.mjs ignore <P> --generation <N>`, `guard`, `loop-items.mjs normalize`,
  `loop-items.mjs resolve`, `spine_version:`, `loop-spine.mjs save <P> --generation <N>`,
  `status <P> --expect`, `loop-lock.mjs release`; its interview names
  `loop-spine.mjs scope <P> --input` and `migrated-before`. Mutation: move `save` before `LOOP.md`.
- **C18** (v2, OX9, R39) migration.md's finalize names, in order: `guard`, `## Last run`, the
  ledger row, `loop-spine.mjs save`, `status --expect`, `--step version`, `loop-clone.mjs close`,
  release; and no origin rewrite (`origin: loop from` absent). Mutation: move `--step version` before
  the ledger row.

## 8. Tests (real temp repos; hermetic git env as 0c-2; fault points through `TECH_LEAD_FAULT`)

### 8.1 Migration cases (acceptance: "Each migration case has a passing test", spec:1096)

Each row is one test (or subtest); "nothing changed" means `<P>`'s HEAD, refs, index, `.gitignore`,
exclude file and `<S>` byte-identical, and no `state.json` written unless stated.

Gate and frame:
- MC-G1 scheduled firing over a tracked pre-0c spine: `migration needs an interactive run`, nothing
  written in `<S>`, lock released, runner stop recorded by the driver.
- MC-G2 scheduled firing over an untracked spine without `spine_version:`: the same.
- MC-G3 `spine_version: 7` and `spine_version: 2` under `CURRENT_STAGE = '0c'`: `version-unknown`,
  no-write exit in both modes; `spine_version: 0c` with a test-only `CURRENT_STAGE = '1'` reads
  `migrate`.
- MC-G4 interactive firing over a tracked spine hands over to the migration (driver) and writes
  nothing before `run`.
- MC-G5 `plan` writes nothing (`<P>/.git` and `<V>` listings with sizes and mtimes unchanged).
- MC-G6 `plan` on a migrated spine prints `complete`; every `run` then prints `done`/`skipped`.
- MC-G7 (v2, G6) scheduled firing with `<S>` missing, with an `absent` and with a `partial` spine:
  `spine needs an interactive run (missing)`, runner stop recorded, nothing written.
- MC-G8 (v2, R36) a no-write exit after an acquire that reclaimed a generation: the printed reason
  names `reclaimed` and `stopped`; the next writing firing's `## Last run` notes them (`carried`) and
  `noted` clears them; two no-write exits in a row carry them through.
- MC-G9 (v2, R35) a branch switch to a tracking branch between §1 and §8 (driver hook): §8's guard
  hits, `<S>` is unwritten after the hit (no `## Last run`, no ledger row, no `SPINE.json`), the
  summary is printed, the lock released with `--carry`; the same at §2, §3 and at migration step 8.
Top level and scope:
- MC-S1 `<P>` a subdirectory of a repository with a legacy spine: `plan` exit 2 `not-toplevel`,
  nothing changed.
- MC-S2 a linked worktree as `<P>`: the exclude line lands in the common directory's file.
- MC-S3 each of `./`, `.`, `/`, `.//`, `./.`, an empty list, `''`, `../x`, `src/..`, `/abs`, `.git`,
  `.tech-lead/x`, `.Git`, an entry the base tree holds as a file (`package.json`), as a symlink and as
  a gitlink, `<directory ...>`: scope step `refused` with the reason; `run --step untrack` refuses
  `scope-invalid`, nothing changed.
- MC-S3b (v2, SF-7) an entry that is a directory in `base:` but a file in the owner's checked-out
  branch: the §2 gate and the migration accept it (the working tree is never read).
- MC-S4 `src` with `src-old/` present: `ok`; a missing `newdir`: `ok`; digest equals
  `scopeDigest(checkScope(raw).entries)`.
- MC-S5 the owner's hand edit while tracked, then `plan` again: `ok`; the loop wrote nothing to
  `LOOP.md` (R21).
- MC-S6 `pending_entries` names a `## Needs decision` entry whose Recovery scope digest was of `['.']`.
- MC-S7 (v2, g2#8) `scope: src` passes §2, then becomes `./` during the firing: `loop-clone.mjs
  check` and `commit` refuse `scope-invalid`, nothing committed; a save still succeeds.
Untrack:
- MC-U1 tracked spine on the base: one commit; parent `head0`; `D` for each spine path plus
  `.gitignore` gaining exactly `/.tech-lead/`; files byte-identical on disk; `check-ignore` true;
  exclude line once; message without Co-Authored-By; `Tech-Lead-Migration: 0c` trailer.
- MC-U2 `.gitignore` absent: created with the one line; legacy three lines kept when present (D10);
  `.tech-lead/` already present in another form: no line added.
- MC-U3 nothing tracked, line absent: a commit holding only `.gitignore`; nothing tracked, line in
  HEAD: no commit, step `done`; (v2, g1#5) the same with the exclude line missing: `done` writes it
  and `check-ignore` is true.
- MC-U4 foreign tracked files under `.tech-lead/` (a `briefs/` file): untracked and listed.
- MC-U5 refusals, each nothing changed: other branch (`wrong-branch`), detached HEAD, unborn HEAD,
  merge, rebase, cherry-pick, revert and bisect in progress, a staged foreign file, a staged spine
  edit (`index-dirty` with the remedy), `.gitignore` untracked, `.gitignore` with an unstaged edit,
  `.gitignore` deleted in the work tree, `!/.tech-lead/` in `.gitignore` (`negated` naming the rule
  as `<source>:<line>:<pattern>`; the exclude line may stay: assert only that), a `switch-back`
  (SPINE.json present, ledger regressed), (v2) a staged gitlink bump under
  `submodule.<name>.ignore=all` (`index-dirty`, OWN-3), `.gitignore` a symlink
  (`gitignore-not-regular`), an index-only tracked spine with HEAD clean (`index-dirty` with the
  `rm --cached` remedy, G3).
- MC-U5b (v2, OWN-6) `core.autocrlf=true` and `.gitattributes eol=crlf` with a clean `.gitignore`:
  no `gitignore-dirty`, one commit whose blob equals `after_oid`; with `core.safecrlf=true` too.
- MC-U5c (v2, OX1) the spine tracked only on a feature branch, the base never tracking it: `plan`
  warns `base-never-tracked`; the commit lands on the feature branch; the base is untouched.
- MC-U6 interrupted at each of `migrate:after-record`, `:after-exclude`, `:after-rm`,
  `:after-gitignore`, `:after-add`, `:after-commit`, `:after-done`, then re-run: exactly one commit,
  same end state as MC-U1; after `:after-commit` the made commit is detected and not repeated; (v2,
  g1#4) after `:after-gitignore` the resume stages `.gitignore` instead of failing the staged-set
  check.
- MC-U7 (v2, decision 1) `<V>/migration` deleted after `:after-rm`, `:after-gitignore` and
  `:after-add`, each with and without a HEAD `.gitignore`: the re-run refuses `index-dirty` with the
  restore remedy or `gitignore-untracked` with `own_shape: true` and the `rm` remedy, nothing
  changed; running the printed remedy and re-running gives one commit as MC-U1.
- MC-U8 a forged `state.json` (another `head0`, extra removals): refused or decided from git facts;
  never a commit with more than the spine removals and the line.
- MC-U9 a pre-commit hook that would fail and one that stages a file: neither runs; the commit is as
  MC-U1. A `commit.gpgSign` configuration with a failing `gpg.program`: `commit-failed`, the index
  and `.gitignore` rolled back, spine files untouched.
- MC-U10 `commit-mismatch` (a test hook point that amends HEAD before the post-check): refused with
  the ROLLBACK built from the commit made; running it restores `head0`'s state with the spine on
  disk, both with `gitignore.existed` true (`restore --source=C^`) and false (`rm`, OWN-7).
- MC-U11 the `git commit --only` reproduction: `--only` on the spine paths re-tracks them
  (documents why the step never uses it).
- MC-U12 after the migration, `git stash`, `git checkout -- .` and `git commit -a` leave the spine
  alone (loop02 inverted).
- MC-U13 (v2, IR-1) interrupted at `:after-add`, the owner commits on the base, re-run: `head-moved`,
  only the step's own still-staged change rolled back, the record moved to `untrack_history`, no
  commit on top of the owner's; a fresh `plan` then proceeds.
- MC-U14 (v2, G5) interrupted at `:after-add`, the owner switches to another branch carrying the
  staged change, re-run: `head-moved`, no commit on that branch, no printed ROLLBACK that would move
  it.
Worktree:
- MC-W1 no `<S>/worktree`: `skipped`.
- MC-W2 clean registered worktree on a dated branch, clone not yet created: created through
  `ensureClone` with the recorded `date` (a dated branch, never `…/undefined`; g2#4) with the branch
  adopted (R27 record), worktree removed without `--force`, branch kept in `<P>`; a resumed run
  reuses the same date.
- MC-W3 (v2, R40) an existing clone holding the dated branch: same tip -> `present`; the legacy
  branch advanced (clone tip an ancestor) -> fast-forwarded, `adopt-ff` with `previous`; diverged ->
  `adopt-collision` before any reset, nothing destroyed; the branch checked out in `<W>` -> refused;
  `close` keeps the record (`adopted`) until ledgered.
- MC-W4 dirty worktree (staged, tracked, untracked in and out of scope, exec bit, symlink): saved
  with `why: 'migration'`, `item_id: null`, anchored in `state.json`; `verifyBundle` legacy passes;
  applying the bundle onto its base reproduces the tree byte-exactly; then reset and removed.
- MC-W5 live Codex job in the worktree: quiesced; one that cannot be quiesced: `not-quiet`, nothing
  changed.
- MC-W6 a live process with its cwd in the worktree: `busy`, nothing changed.
- MC-W7 a plain directory, the project itself, a nested non-top-level path at `<S>/worktree`:
  `legacy-invalid`, never removed.
- MC-W8 a locked worktree: `worktree-locked` before any save; a detached HEAD worktree:
  `legacy-detached`.
- MC-W9 a worktree whose only leftovers after reset are ignored files (`node_modules/x`, `.env`):
  pins git's behaviour (removed with them, or refused); `plan` listed them in `ignored`.
- MC-W10 (v2, decision 1) git refuses the removal (a submodule fixture): `worktree-refused` with
  git's message; the worktree is clean and the bundle anchored; `version` refuses `steps-pending`;
  `plan` on the next firing offers the removal again; after the owner removes it by hand, the phase
  reads `removed` (`removed_by: 'owner'`) and `version` is allowed.
- MC-W11 (v2, g1#1) interrupted at `migrate:after-save`, `:after-adopt`, `:after-reset-intent`, inside
  `resetLegacy` after its first unlink (a test fault point), at `:after-reset` and `:after-remove`: a
  re-run converges against the original bundle; `saves` holds exactly the one sha it held before
  the interruption; the partly reset tree is never saved.
- MC-W13 (v2, IR-6, decision 3) the worktree's HEAD moves (a commit in `<S>/worktree`) after
  `saved`: `plan` reports `plan-changed` with `head_moved`; on the re-plan the run saves again, both
  shas stay in `saves`, the new tip is adopted (`adopt-ff`), the reset uses the second bundle, and
  the `migrated` row and `## Last run` name both shas; HEAD moved during `resetting` -> `head-moved`,
  nothing reset.
- MC-W14 (v2, OX10) `state-corrupt` (plan reports `broken_saves`), `save-failed`, `adopt-failed`,
  `index-only`, `unsavable`, `too-large`, `unsaved` (preflight; nothing destroyed), and the warnings
  `branches-track-spine` and `remote-base-tracks-spine`, one subtest each.
- MC-W12 `<P>`'s refs other than `refs/heads` untouched; objects added to `<P>/.git` only by the save
  (R12).
Ids:
- MC-I1 legacy items without ids and origins: `normalize` fills them (`unknown`), idempotent.
- MC-I2 title blocker with a unique candidate, confirmed: `blocked-by: <id>`; declined: kept, item
  parked, named in `## Last run`.
- MC-I3 title blocker with no candidate, and with two candidates: no candidate offered; stays parked.
- MC-I4 legacy `## Needs decision` heading with a candidate: rewritten to `### <id> · <title>`;
  `ambiguous-carrier` cases refused (D43).
- MC-I5 (v2, decision 1) legacy analysis/follow-up pair from a ledger note `analysis → <title>`:
  listed in `plan`'s `origin_hints` and in `## Last run`; no `origin:` line changes; a resolve input
  with an `origins` key is `bad-input`.
- MC-I7 (v2, g1#6) legacy items with no ids and a title blocker: the candidates are collected after
  the normalize Edits against the minted ids, and the confirmed `resolve` applies cleanly (no
  `stale-decision`).
- MC-I6 a decision file naming a resolved or changed item: `stale-decision`, nothing planned.
Version and completion:
- MC-V1 `spine_version: 0c` is written only after untrack `done` (by git facts) and worktree
  `removed`/`skipped` (`steps-pending` otherwise); unresolved ids do not block.
- MC-V2 the full migration in one firing: one ledger row (`migrated`, R33 fields), `SPINE.json`
  written and confirmed, the next scheduled firing proceeds through the guard and the scope gate.
- MC-V3 a migration refused at untrack: no ledger row, `<S>` unchanged; refused at worktree after the
  untrack: the row is written and the spine anchored, `spine_version:` not.
- MC-V4 `plan-changed`: HEAD moved between `plan` and `run`.
- MC-V5 (v2, g1#10, g2#7) two stages pending (a test-only `CURRENT_STAGE = '1'` with one run step)
  over a pre-0c spine: `plan` reports stage `0c` only; `run --stage 1` refuses `stage-mismatch`;
  the version step writes `0c`, never `1`; then `plan` reports stage `1`, and its version step
  writes `1`.
- MC-V6 (v2, IR-3, g2#6) killed after `## Last run`, after the ledger append, inside `save`, after the
  `SPINE.json` Write and after the version Edit: each re-run converges; `plan` prints `complete`
  only after the version Edit, and the anchor exists whenever the version reads complete.
Spine guard (spec:1143-1144):
- MC-P1 lost: a checkout of a pre-migration branch deletes the files on the way back; scheduled:
  `spine needs an interactive restore`, nothing written.
- MC-P2 regressed: a checkout of a branch tracking an older spine; owner edits to `LOOP.md` and
  `STATE.md` alone are not a regression; a ledger appended beyond the anchor is not either.
- MC-P3 interactive restore: confirmed with the token, files restored byte-exactly (the ledger
  written last), `status --expect --restored` passes and removes the marker, no `## Last run` or
  ledger row written; declined: nothing written; (v2, G4, OX4, IR-5) a deliberately altered
  `STATE.md` Write and a ledger written with the right prefix plus extra bytes: `restore-incomplete`
  naming the file, verdict `restore-pending` until fixed; killed after the `LOOP.md` Write: the next
  firing reads `restore-pending` (interactive offers again; scheduled exits).
- MC-P4 tampered copy (one byte flipped in `<V>/spine/<g>/STATE.md`): `copy-tampered`, no restore.
- MC-P5 tracked spine with `SPINE.json` present and the owner confirming a restore: refused
  (`tracked` comes first; a confirmation never bypasses it).
- MC-P6 `token-changed`: the live ledger changes between the report and the restore.
- MC-P7 `too_large`: a file over 64 KiB gives the `cp` command, no text; the ledger's command is
  last.
- MC-P8 `anchor-invalid` and `exposed` (exclude line removed): scheduled no-write exits; interactive
  `exposed` repaired by `ignore` and the firing goes on.
- MC-P9 `save` killed at `spine:after-copy-one`, `spine:after-copies` and `spine:after-publish`:
  the old anchor and its directory still verify; no integer-named directory is ever incomplete; the
  next save prunes the stray `.partial-*`; (v2, g2#11) the same kill followed by a wiped `<S>`: the
  README recipe picks a complete directory and its `anchor.json`, and the next interactive firing
  reads `ok`; a second `save` in the anchored generation refuses `copy-in-use`.
- MC-P10 `git clean -fdx` reproduction: `<S>` gone, `<V>/spine` present: step 2 sends to bootstrap,
  which refuses `copy-exists`.
- MC-P11 after a full migration, quick's `switch -c x origin/<base>` reproduction against a
  still-tracking remote base: regressed, then lost on the way back (why quick uses the worktree).
- MC-P12 (v2, G3) a pre-migration stash popped on the migrated branch (index-only tracking with an
  unmerged entry): `tracked` with `head: []`, the `rm --cached` remedy works, then the restore is
  offered for the files that differ from the copy.
- MC-P13 (v2, G9, R37) the owner edits the ledger, declines the restore, deletes `SPINE.json`:
  verdict `unanchored`; scheduled: `spine needs an interactive run (unanchored)`; interactive: one
  question, the anchor firing writes only `SPINE.json`, the next firing reads `ok`.
- MC-P14 (v2, R32, R42) interactive `exposed`: the question asked, `ignore --generation` repairs; a
  lost generation right before the rename: `not-holder`, the exclude file unchanged; a negation in
  `core.excludesFile`: `negated` names it.
Bootstrap:
- MC-B1 no commit, no `.gitignore` change, exclude line written and `check-ignore` true,
  `spine_version: 0c`, the `## Last run` record, `SPINE.json` and copy written, LEDGER empty, items
  with ids and resolved blockers.
- MC-B2 refusals: `not-toplevel`, HEAD tracks `.tech-lead/` with `<S>` missing, the base tracks it,
  `copy-exists`, `history`, a whole-repository scope (each spelling), `negated`.
- MC-B3 (v2, g1#3, g2#1) interrupted after `STATE.md` (no `LOOP.md`, no `SPINE.json`): the verdict is
  `partial`; scheduled: no-write exit; interactive: bootstrap resumes and arbitrary existing
  `STATE.md` bytes survive unless the owner chooses to replace them; interrupted after `LOOP.md`:
  `unanchored`, never `ok`; the anchor firing completes it.
- MC-B4 (v2, IR-4) a migration killed after the untrack commit and before its first anchor, then a
  switch to a pre-migration branch and back (the spine deleted): bootstrap refuses
  `migrated-before` with the commit; the printed `restore --source=<commit>^` brings the spine back
  untracked; the migration then resumes.
Quick (spec:1067-1072):
- MC-Q1 current tree tracks (index), target does not: worktree path.
- MC-Q2 target tracks, current does not (a migrated branch, an unmigrated remote base): worktree path.
- MC-Q3 neither tracks: in-place switch. (Prose check C9 plus a scripted reproduction in a temp repo
  with a bare remote.)
README recipes (v2; scripted reproductions):
- MC-R1 (g2#3, R43) the migration-bundle recovery in a temporary worktree at a base that still
  tracks `.tech-lead/`: `<P>`'s live spine stays byte-identical.
- MC-R2 (OX2, OWN-1) the temporary-worktree merge of the base into a still-tracking branch: `<P>`'s
  live spine stays byte-identical and the branch no longer tracks it.
- MC-R3 (g2#10, OX3, OWN-2) two clones: pulling the untrack commit deletes an unmodified tracked
  spine and aborts on a modified one; a clone that migrated first merges cleanly and keeps its files.

### 8.2 Unit and integration tests besides the cases

`tests/lib/spine.test.mjs` (stage ordering, `migrationNeeded`, `withLine` forms and CRLF,
`anchorText`/`parseAnchor` round trip and every malformed key, `spineStatus` precedence over every
pair of facts, `ignoreFacts` with a negation in `.gitignore`, in a nested `.gitignore` and in the
excludes file); `tests/lib/loop-scope.test.mjs` (`scopeGate` reasons; `checkScope` and `markScope`
unchanged for every existing case); `tests/lib/loop-md.test.mjs` (`planScalar` insert and replace,
refusals); `tests/lib/loop-state.test.mjs` (`planResolve`, `originCandidates`);
`tests/lib/ledger.test.mjs` (`legacyAnalysisPairs`); `tests/lib/git-safe.test.mjs` (`linkedGit`
preconditions and refusals, hostile global config runs nothing); `tests/lib/changes.test.mjs` (the
legacy layout: every change kind, index and exclude paths from `gitDir`/`commonDir`, a gitfile
pointing elsewhere refused); `tests/loop/reflex-bundle-legacy.test.mjs` (`saveLegacy`,
`resetLegacy` preflight refusals `not-anchored`, `head-moved`, `busy`, `unsaved`, and the resumed
reset against a persisted record that skips `unsaved`; `--why migration` usage error); `tests/loop/loop-clone-adopt.test.mjs` (fencing, created vs existing clone, R40's present,
fast-forward, collision and checked-out cases, the `date` argument, R27 record, close keeps then
deletes; `check`/`commit` `scope-invalid`); `tests/loop/loop-lock-carry.test.mjs` (R36: `--carry`,
`carried`, `noted`); `tests/loop/loop-items.test.mjs` (`resolve` CLI);
`tests/loop/loop-spine.test.mjs` (each command's exits; save never writes `<S>`; restore without
`--token` never writes; the marker lifecycle; `guard --allow`); `tests/loop/loop-migrate-*.test.mjs` (the cases); `tests/check.test.mjs` (a mutation per
check). Fixtures: `tests/loop/interrupt-fixture.mjs` and `tests/fixtures/firing-driver.mjs` write
`spine_version: 0c`, a default scope of `['src']` and the exclude line, and the driver plays §1 step
4's guard, the §2 scope gate and §8's spine anchor through the CLIs as the prose does
(`tests/loop/loop-interrupt-clone-prose.test.mjs` keeps matching); `loop-clone-fixture.mjs` and
`reflex-bundle-fixture.mjs` keep `['./']` (helpers do not gate, R10). Three full-suite runs.

## 9. The firing with the guard (prose order)

1. §1: resolve paths; step 2 (`<S>` missing -> bootstrap when interactive, the `(missing)` exit when
   scheduled); acquire; step 4 guard (R17); read state; step 5 planner.
2. §2: guard before writing (R35); Paused, Scope, Circuit breaker, Daily budget.
3. §3-§7 unchanged, except the guard before the pick's Edits and before each later STATE.md or
   LOOP.md edit (R35), and `check`/`commit`'s `scope-invalid` (R10).
4. §8: guard before writing (R35); `## Last run` (with any `carried` facts, then `noted`); the
   ledger append; Anchor the spine (save, Write, `status --expect`); `loop-clone.mjs close`;
   release, last.

## 10. Residual risks (named in the plan)

`<V>/spine` and `<V>/migration` are delegate-writable before stage 2: a forged copy is caught by
`SPINE.json` (restore refused), a forged record by the git-fact checks (R22), a deleted copy only
removes the restore option; `SPINE.json` itself sits in `<S>`, which a delegate can reach before
stage 2 (spec:1225-1228), and the anchor detects checkout damage, not delegate edits to `LOOP.md` or
`STATE.md`; the untrack commit runs no project hooks; other branches and the remote base keep
tracking the spine until the owner merges and pushes (the guard detects the damage; R34 warns); a
`.gitignore` negation committed on another branch un-ignores the spine after a switch and is caught
only at the next firing's guard (`exposed`, spec-rep G-11); `git worktree remove` may delete ignored
files in the legacy worktree (MC-W9 pins it; `plan` lists them); the legacy save writes objects into
`<P>/.git` (R12); migration, bootstrap and the restore need an unsandboxed interactive session (R14);
a large ledger is restored by the owner's `cp`; a spine wiped with its `SPINE.json` is restored only
by hand (spec amendments item 2); narrowing `scope:` re-flags pending recovery entries in stage 3
(R21 names them); a `migrated` row delays L1-to-L2 promotion by one firing (R33); no-write exits
leave ledger gaps (spec:1093 allows them); a signing setup that needs a terminal makes the untrack
commit fail cleanly (`commit-failed`) and the owner commits signing-capable; scheduled runners stop
on every guard exit until an interactive firing. (v2) The guard (R35) narrows the branch-switch
window to the gap between a guard call and the write sequence it opens (seconds), not to zero; a
guard hit at §8 leaves that firing's work recorded only in the printed summary and the open run
record (0c-2 recovery); reclaim notes of a firing that never writes again are only printed (R36); a
worktree git refuses to remove keeps the loop paused until the owner removes it (R25); a pre-0c
analysis/follow-up pair keeps `origin: unknown`, so a dependent pointed at the analysis id can be
released before the follow-up ends (the 0c-3 residual stands; `## Last run` lists the pairs as
hints, R4).

## 11. For later stages

Stage 1: adds `'1'` to `STAGE_STEPS` and `RUN_STEPS` (journals into `<V>`, the `triage:` mapping and removal,
`--init-policy`) and sets `CURRENT_STAGE = '1'`; keeps state in `<V>/migration/1/`; rewrites
`SPINE.json` as `v: 2` (per-file mode, the ledger out of the copy, regression judged against the
journal head in `CHAIN.json`, spec:246-250) before scheduled runs resume; routes the ledger read of
the regression check through `ledger.mjs`; bootstrap gains its `--init-policy` step after step 10;
inserts its chain verification and kill check after §1 step 4's guard; edits LOOP.md keys with
`planScalar` (or a sibling that removes a key), never by a script write. Stage 2: adds `'2'` (runner
settings in `<X>/runners/`); keeps migration, bootstrap, the exposed repair and the restore runnable
outside the sandbox (R14), likely as an owner-terminal or unsandboxed interactive form; adds
`<V>/spine` and `<V>/migration` to the §7.8 manifest; if probe P5 picks option (b), relocates
`<S>` paths in `loop-paths.mjs` and `spine.mjs` together; shares the per-file `{bytes, sha256}`
digest with governance hashing. Stage 3: adds its whys to `WHYS`; extends `apply` so a migration
bundle (no item, no entry) can be applied by the owner; compares scope digests at release (R21).
Stage 4: owner-terminal commands keep 0c-2's TTY convention (`needs-terminal`); 0c-4 adds no TTY
command. Stage 0': quick's `<repo>` and `<tmpdir>` (loop13, loop14).

## 12. Review dispositions (v1 -> v2)

Every finding of the three reviews, with the ruling or section that fixes it. "Decision n" is the
tech lead's decision n for this revision (see the header). Every Codex finding and every Claude
entry with `holds: true` is fixed; no finding is left unfixed, and no fix needed a spec amendment
(§ Spec amendments).

Codex g1 (`codex-brief-g1.md`):
- g1#1 interrupted reset replaces the recovery anchor -> decision 3: R38(a)(b), R12(d), §5.2
  (`resetting`, `reset`, append-only `saves`), §5.4 (read-only preflight, then the persisted
  intent, then the reset), §5.5 `resetLegacy`; MC-W11.
- g1#2 the tracked-spine guard expires before later writes -> decision 2: R35, R2, R17, §3 `guard`,
  §6.1 "Guard before writing", §6.2, §6.3, §9, C3b; MC-G9.
- g1#3 bootstrap interruption windows -> R37, R8, R17 (`partial`, `unanchored`), §6.2; MC-B3.
- g1#4 `.gitignore` write and staging coupled -> R41, §5.1 step 6; MC-U6.
- g1#5 "already done" skips the exclude repair -> R22 (done path), §5.1 step 1; MC-U3.
- g1#6 confirmed ids do not survive normalize -> R3, R4 step 4, R24, §5.3 (ids step), §6.3 step 7;
  MC-I7.
- g1#7 existing-branch adoption skips advanced branches -> R40, §5.6; MC-W3.
- g1#8 resumed intent missing from the state format -> R24, §5.2 (`intent`), §5.3.
- g1#9 restore verification never checks the restored files -> R18 (`--restored`, the marker,
  `restore-pending`), §3; MC-P3.
- g1#10 the stage extension skips intermediate completion -> R5, §2 (`RUN_STEPS`), §5.3
  (`--stage`, `stage-mismatch`, version writes the completed stage's token); MC-V5.
- g1#11 `ignore` bypasses generation fencing -> R42, R32, §3, C13; MC-P14.

Codex g2 (`codex-brief-g2.md`):
- g2#1 bootstrap can overwrite an interrupted spine -> as g1#3 (R37, R8, §6.2; MC-B3).
- g2#2 the guard expires before later writes -> as g1#2 (decision 2, R35; MC-G9).
- g2#3 the manual bundle recipe switches `<P>` -> R43, §6.7; MC-R1.
- g2#4 `ensureClone` without `date` -> R27, §5.2 (`intent.date`), §5.6; MC-W2.
- g2#5 existing-branch re-adoption -> as g1#7 (R40; MC-W3).
- g2#6 completion bypasses reporting and anchoring -> R39, R3, §5.3 (`complete`), §6.3 step 8;
  MC-V6.
- g2#7 the stage registry has no execution interface -> as g1#10 (R5, §5.3; MC-V5).
- g2#8 a whole-repository scope can reach commit -> R10, §5.6 (`check`/`commit` run `scopeGate`),
  §6.1 §2; MC-S7.
- g2#9 exposed repair unfenced -> as g1#11 (R42, C13).
- g2#10 the collaborator-pull statement is false -> R16, §6.7; MC-R3.
- g2#11 the newest copy may be partial -> R19 (`.partial-*` then one rename, `anchor.json`,
  `copy-in-use`), R43, §3 `save`; MC-P9.

Claude review (`claude-brief-review.json`, `holds: true`, each with the skeptic's better fix):
- SF-1 guard only at §1 -> decision 2: R35 (every write sequence, beyond the better fix's §8 and
  migration step 9).
- SF-5, G7, OX12 reclaim and `stopped` notes dropped on a no-write exit -> R2 (printed), R36 and
  §5.8 (`--carry`, `carried`, `noted`), §6.1 §1 step 3, C7; MC-G8. Fixed without an amendment: the
  next writing firing notes them in `## Last run`.
- SF-7 `not-a-directory` depends on the owner's checkout -> R10, R26, §4.1 (against `base:`'s tree,
  only at bootstrap and in the migration; the §2 gate syntactic); MC-S3, MC-S3b.
- G1 no re-check before later writes; `save` anchors lost/regressed spines -> R35, R7, §3 `save`
  (only `ok`, `migrate`, `unanchored`); MC-G9 (per-batch guards adopted per decision 2).
- G3 index-only tracking after a stash pop -> R6 (`rm --cached` remedy), R17 (`head: []`), R23;
  MC-U5, MC-P12.
- G4 restore not verified; 512 KiB Writes -> R18 (`--restored`, 64 KiB); MC-P3, MC-P7.
- G5 resumed untrack on another branch; ROLLBACK from `head0` -> R6, R22 (`head-moved`; ROLLBACK
  from the commit made), §5.1; MC-U14.
- G6 wiped `<S>` in a scheduled firing never stops the runner -> R2, R17, §6.1 §1 step 2, §6.2,
  C4; MC-G7.
- G8 a misspelled scheduled prompt reads interactive -> R1, R32 (question before `ignore`), R37,
  §6.1 Runners, C16.
- G9 no way to accept an intentional ledger edit -> R18 (decline message), R37, §6.7; MC-P13.
- IR-1 owner commits between interrupted run and resume -> R22, §5.1 step 1; MC-U13.
- IR-3 version written before the report -> R39; MC-V6.
- IR-4 no anchor between untrack and first anchor; bootstrap starts fresh -> R8
  (`migrated-before`), §6.2 step 1; MC-B4.
- IR-5 restore order and fencing -> R18 (ledger last, the marker, `--generation`), §3; MC-P3.
- IR-6 the worktree's HEAD moves after `saved` -> R38(c), R24, §5.3, §5.4; MC-W13.
- IR-8 untracked own-shape `.gitignore` with a wiped `<V>` -> R22 (`own_shape` and its `rm`
  remedy; decision 1 replaces content recognition by a printed remedy); MC-U7.
- OX1 `wrong-branch` when the base never tracked the spine -> R6 (`base-never-tracked`), R34;
  MC-U5c.
- OX2, OWN-1 "merge before switching" cannot be followed -> R16 (temporary-worktree recipe), §5.1
  step 8 (commit message), §6.7; MC-R2.
- OX3, OWN-2 the pull statement is backwards -> R16, §6.7; MC-R3.
- OX4 restore checks the anchor, not the files -> R18; MC-P3.
- OX5 no procedure step for `--keep` -> decision 1: R25 (no `--keep`; a refused removal is offered
  again), §6.3 step 3, C11; MC-W10.
- OX8 C1, C9, C13 vacuous or unfailable -> C1 (source and template), C9 (all three commands), C13
  (`adopt` absent from `skills/`).
- OX9 no checks for bootstrap's new obligations or migration step 9 -> C17, C18.
- OX10 missing cases; `state-corrupt` loses the save sha -> R44, §5.2, §5.3 (`broken_saves`);
  MC-W14.
- OX11 incomplete README rows and layout -> §6.7 (rows, layout, the start-fresh remedies).
- OWN-3 diffs hide staged gitlinks -> R6, §5.1 (`--ignore-submodules=none`); MC-U5.
- OWN-6 CRLF and symlinked `.gitignore` -> R6, R41 (oids, `core.safecrlf=false`,
  `gitignore-not-regular`); MC-U5, MC-U5b.
- OWN-7 ROLLBACK fails without a HEAD `.gitignore` -> R22 (built from `gitignore.existed`); MC-U10.
- OWN-9 `check-ignore` prints no rule for a negation -> R42, §2 `ignoreFacts`; MC-U5, MC-P14.

Dropped by the skeptics (`holds: false`; not acted on as findings): SF-6, G2, IR-2, IR-7, IR-9, OX6,
OX7, OWN-4, OWN-5, OWN-8, OWN-10, OWN-11, OWN-12, OWN-13, OWN-14, OWN-15. Three skeptic-dropped
entries are nonetheless covered by the tech lead's decision 1, which adopts the spec's literal text:
SF-2 (the origin offer is removed, R4, spec amendments item 4), SF-3 (record-only recognition,
R22, item 5) and SF-4 (a refused worktree leaves the migration pending, R25, item 6). IR-7's
subject (one `save` slot) is also moot under decision 3 (append-only `saves`, R38), and the
`migrated-before` refusal (R8, for IR-4) also closes the double-fault paths G2 and OWN-15 describe.

## Addendum 1 (2026-10-08): the prototype review fix manifest


Base under review: branch `proto-0c4` at `e3219bc` (diff `7bc9ade..e3219bc`), worktree
`.worktrees/_0c4-work/proto-0c4`. Binding brief: `0c4-brief.md` (v2, cited `brief:<line>` or by
ruling). Spec: revision 8 (`spec:<line>`). Sources:

- Codex: `codex-proto-g1.md` (spine, lock: G1-1..G1-3), `codex-proto-g2.md` (migration, bundle:
  G2-1..G2-5), `codex-proto-g3.md` (prose, checks, fixtures: G3-1..G3-5). Not skeptic-checked;
  each was verified against the code below. None is dropped.
- Claude five-lens review with skeptics: `claude-proto-review.json` field `all` (28 entries). Acted
  on: every `holds: true` entry, with the skeptic's `better` fix where given.

Numbering note: brief v2 already uses R1-R44 (R41-R44 are v2 rulings at brief:637-667), so the new
rulings here start at **R45**, not R41, to avoid two rulings with one number.

Rules every lane follows (from the tech lead): every fix test-first (write the named test, see it
fail for the stated reason, then fix); fix at the cause; the more cautious behaviour when unsure;
no spec contract changes (none is needed: see "Spec amendments"); no file outside the lane's list.

---------------------------------------------------------------------------------------------------

## 1. Disposition of every source finding

| Source | Holds | Group | Note |
|---|---|---|---|
| Codex G1-1 case variants bypass the guard (P1) | verified | F1 | `spine.mjs:350-353` literal pathspec; trackedFacts never sees `.Tech-Lead/...` |
| Codex G1-2 interrupted reclaim drops recovery notes (P2) | verified | F2 | `loop-lock.mjs` acquire reads only `carried.json`; a reclaimed slot's own `reclaimed`/`stopped` are never inherited |
| Codex G1-3 pruning breaks "numbered folder is complete" (P3) | verified | F3 | `loop-spine.mjs:239-256` `removeEntry` unlinks inside an integer-named dir |
| Codex G2-1 resumed untrack overwrites staged-only `.gitignore` (P1) | verified | F4 | resumed path compares status letters only (`loop-migrate.mjs` "foreign" filter), then `update-index --add` |
| Codex G2-2 resumed legacy reset deletes unsaved files (P1) | verified | F5 | `reflex-bundle.mjs:925-930`: `unsavedPaths` runs only under `preflight` |
| Codex G2-3 empty-save resume destroys staged-only work (P1) | verified | F6 | `loop-migrate.mjs` resetting branch: `read-tree` with no index-only check (brief:1054-1055 requires one) |
| Codex G2-4 forged record authorizes unrelated deletion (P1) | verified | F7 | resumed path trusts `rec.removals` in the staged-set and post-commit checks; R22 (brief:432-433) claims the opposite |
| Codex G2-5 read-only plan runs clean filters (P2) | verified | F8 | `gitignoreFacts` -> `hash-object --path=.gitignore`; `safeGit` neutralizes no filter driver in `<P>` |
| Codex G3-1 recovery before the first anchor loses uncommitted spine bytes (P1) | verified (static) | F9 | untrack has no unstaged-spine precondition; `bootstrap.md:35-42` restores only `<commit>^` |
| Codex G3-2 bootstrap overwrites state made during the unlocked interview (P1) | verified | F10 | `bootstrap.md:104-106` accepts `absent` or `partial` at the recheck; player keeps step 1's `partial` (`migration-cases-fixture.mjs:281`) |
| Codex G3-3 documented retry cannot recover reset-phase changes (P2) | verified | F11 | same as Claude MIG-2 |
| Codex G3-4 C3b accepts `tracked` in allow-lists (P2) | verified | F12 | `checks/loop.mjs:1083` checks only the `guard <P> --allow ` prefix |
| Codex G3-5 collision remedy makes an invalid legacy branch name (P3) | verified | F13 | `README.md` adopt-collision row; `datedRe` requires `<prefix>/YYYY-MM-DD` |
| BS-1 scope entries that do not round-trip | true | F14 | |
| BS-2 proposal lists gitlinks; bare base name | true | F15 | |
| BS-3 symlinked exclude with the line refuses; step 7 exit 2 unhandled | true | F16 | |
| BS-4 case-sensitive trackedFacts | false | (F1) | skeptic: brief prescribes the pathspec; the defect itself is SG-2/G1-1, fixed under F1 |
| BS-5 migrated-before after a completed migration | true | F17 | |
| SG-1 index-only remedy never offers the promised restore | true | F18 | |
| SG-2 case variants overwrite the live spine unseen | true | F1 | |
| SG-3 `--first-parent` for migrated-before | false | dropped | brief R8 settles the command; off the documented path |
| PROSE-1 C3 matches verdict names anywhere | true | F19 | |
| PROSE-2 no check covers the SPINE.json Write | true | F20 | |
| PROSE-3 C16 passes scheduled bullets naming write sub-lists | true | F21 | |
| PROSE-4 C3b/C7 coverage gaps | true | F12 | grouped with G3-4 |
| PROSE-5 C6b "ledger last" can never fail | true | F22 | |
| PROSE-6 MC-Q/C9 cannot fail on quick's decision | true | F23 | |
| PROSE-7 quick step 4 reads unconditional; worktree `-2` missing | true | F24 | |
| PROSE-8 helper exits without a prose action | true (a-d) | F16 (a), F25 (b-d) | (e) effectively covered (skeptic); not acted on |
| PROSE-9 scope Edit outside the lock | false | dropped | brief 6.3/R21 settle it; two concurrent interactive sessions |
| PROSE-10 kept `partial` STATE.md contradicts itself; MC-B3 short | true | F26 | |
| M1 resumed reset skips the unsaved check | false (vs brief) | F5 | skeptic reproduced the data loss and held it false only because brief 5.5/R38(a) prescribe it; Codex G2-2 is the same defect, verified in code; spec:1024-1027 ("save its uncommitted work") and brief's false premise (resetFor keeps a relaxed check on resume, `reflex-bundle.mjs:845`) make it a fix, recorded as R46 superseding the brief clause |
| M2 adoption record disables the tamper check | true | F27 | |
| MIG-1 negation checked before the `.gitignore` line; remedy loop | true | F28 | |
| MIG-2 no re-save after resetting/reset/refused | true | F11 | |
| MIG-3 legacy worktree files under `.tech-lead/` become ignored and deleted | true | F29 | |
| MIG-4 index-dirty remedy for foreign paths | false | dropped | R6/R22 prescribe it verbatim; README opens with "Commit or unstage them" |
| MIG-5 branchWarnings never names the base | false | dropped | R34 settles the warning set |
| MIG-6 plan-time untrack head-moved never self-clears | true | F30 | |
| MIG-7 `.gitignore.tl-*` temp left on a lost lock | true | F31 | |
| MIG-8 `absent` with only `<S>/worktree` | false | dropped | thin evidence, below threshold |

---------------------------------------------------------------------------------------------------

## 2. Finding groups

Each group: sources, defect (as verified), fix, the test that must fail first (file, title,
assertion), lane. "Lane" names the lane that owns the code; prose/README parts are always lane C.

### F1. Case variants of `.tech-lead` escape the tracked-spine guard and the migration (lanes A, B)
- Sources: Codex G1-1 (P1); SG-2 (P3); BS-4 (dup, held false).
- Defect: `trackedFacts` (spine.mjs:348-363) and loop-migrate's `treePaths`/`indexPaths`/`rm
  --cached` use the literal, case-sensitive pathspec `.tech-lead`. With `core.ignorecase=true` a
  tree tracking `.Tech-Lead/LEDGER.jsonl` overwrites the live spine on checkout while the verdict
  reads `regressed` or `ok`, never `tracked`, so a restore or a governance write lands on a file git
  tracks (spec §4 "No governance writes over a tracked spine"). The migration would not untrack
  such a path either.
- Fix (R45): list without a pathspec and filter by the first path component, ASCII
  case-insensitively when `git config --bool core.ignorecase` is true, exactly otherwise; report
  git's own spelling. trackedFacts, `untrackDoneByGit`, the untrack removals, `rm --cached` (one
  pathspec per distinct root spelling, through `--pathspec-from-file=- --pathspec-file-nul`),
  rollbacks and printed remedies (`-- <roots...>`) all use the shared helpers (section 5, lane A
  exports). Quick's plain-git prose keeps its literal commands (residual: stage 0' owns quick's git
  hygiene; README not changed for it).
- Tests first:
  - A: `tests/lib/spine-status.test.mjs` "a HEAD tracking .Tech-Lead/LEDGER.jsonl reads tracked
    when core.ignorecase is true, with git's spelling; not tracked when false" (tree built with
    `update-index --cacheinfo` + `write-tree` + `commit-tree`, so it runs on any filesystem).
    Fails today: verdict is not `tracked`.
  - B: `tests/loop/loop-migrate-untrack.test.mjs` "F1: core.ignorecase true, HEAD tracks
    .tech-lead/STATE.md and .Tech-Lead/x: one commit removes both; the status afterwards is not
    tracked". Fails today: `.Tech-Lead/x` stays in the index and the staged-set check refuses.

### F2. An interrupted reclaimer loses the facts of the generation it reclaimed (lane A; prose C)
- Source: Codex G1-2 (P2, reproduced in memory).
- Defect: gen 2 reclaims gen 1 (facts in `slots/2.json`), dies before `release --carry` and before
  `## Last run`; gen 3 reads only `carried.json`, reclaims gen 2 and never inherits gen 1's reclaim
  or stopped children; they vanish from every later `## Last run` (spec:1093, R36).
- Fix (R52): on a reclaim of slot `max` that has no `slots/<max>.noted.json`, acquire inherits
  `joinEntries(slot.carried ?? [], factsOf(slot, max))` into its own `carried` (record.carried and
  the result). `release --carry` joins `readCarried`, `slot.carried` and `factsOf(slot, N)`.
  `noted` drops the given entries from `carried.json` as today and also creates
  `slots/<N>.noted.json` (`{v:1, generation:N, noted_at}`, createExclusive, an existing one is fine).
  Prose (lane C): `noted` runs after `## Last run` whenever acquire returned `reclaimed`, `stopped`
  or `carried` (SKILL.md §1 step 3 and §8 step 1, bootstrap step 8, migration step 8; driver and
  migration-case fixture likewise).
- Test first: `tests/loop/loop-lock-carry.test.mjs` "F2: gen 2 reclaims gen 1 and dies before
  release; gen 3's carried names gen 1's reclaim and stopped children; carry, acquire, noted clear
  them; a noted slot is not inherited again". Fails today: gen 3's `carried` lacks gen 1.

### F3. Pruning can leave an incomplete integer-named copy (lane A)
- Source: Codex G1-3 (P3, reproduced by fault injection).
- Defect: `save`'s prune unlinks files inside `<V>/spine/<g>/` one at a time; a kill after the
  first unlink leaves `spine/<g>/` without a file, against R19's "a directory named by a plain
  integer is always complete" and the README wiped-spine recipe (R43).
- Fix (within R19, no new ruling): prune each obsolete integer directory by first renaming it to
  `<V>/spine/.partial-<g>-<hex>` (guard before the rename, parent fsynced), then removing it one
  file at a time and `rmdir` (never recursive). New fault point `spine:after-prune-one` after the
  first unlink of a pruned entry.
- Test first: `tests/loop/loop-spine-save.test.mjs` "F3: killed at spine:after-prune-one: every
  integer-named directory under <V>/spine holds its three files and anchor.json; the next save
  sweeps the .partial-*". Fails today: `spine/<old>/` lacks `LEDGER.jsonl`.

### F4. A resumed untrack overwrites a staged-only `.gitignore` (lane B)
- Source: Codex G2-1 (P1, control-flow reproduction).
- Defect: the resumed path accepts `M .gitignore` by status letter; step 6 then runs
  `update-index --add` and replaces an owner's staged blob that exists nowhere else.
- Fix (R57): in the resumed path, before any mutation, the index entry of `.gitignore` must be
  absent (when the derived `existed` is false), HEAD's blob (`before_oid`) or `after_oid`;
  anything else refuses `index-dirty {paths:['.gitignore'], remedy}` with the remedy "commit the
  staged .gitignore, or copy it out (`git -C <R> show :.gitignore > <file>`) before
  `git -C <R> restore --staged -- .gitignore`". Nothing changes.
- Test first: `loop-migrate-untrack.test.mjs` "F4: interrupted at migrate:after-add; the owner
  stages other .gitignore bytes and restores the working file to the step's bytes; the run refuses
  index-dirty and the staged blob is unchanged". Fails today: the run proceeds and the staged blob
  is replaced.

### F5. A resumed legacy reset deletes work no bundle holds (lanes D, B)
- Sources: Codex G2-2 (P1); M1 (held false only against the brief; reproduced).
- Defect: non-preflight `resetLegacy` never runs `unsavedPaths`; after a kill at
  `migrate:after-reset-intent` or `reset-legacy:after-unlink-one`, new untracked files and tracked
  edits are unlinked/overwritten and the worktree removed; nothing holds them. `plan` in phase
  `resetting` reports `changed: false`, so the owner confirms a plan that hides the new work.
- Fix (R46): lane D: non-preflight `resetLegacy` runs `unsavedPaths(wt, h, c, true)` (relaxed:
  paths the bundle lists may be half-reset) before its first destructive call and refuses `unsaved
  {paths}` with nothing destroyed. New read-only `legacyCheck` (section 5). Lane B: `worktreeStep`
  in phase `resetting` calls `legacyCheck(paths, {sha: reset.sha, base: reset.base})` (or with
  `sha: null` for an empty save) and sets `changed: true` with the live intent's digest when
  `unsaved` is non-empty; `index_only` non-empty is a plan refusal `index-only`. The re-save then
  follows R47 (F11).
- Tests first:
  - D: `tests/loop/reflex-bundle-legacy.test.mjs` "F5: a resumed resetLegacy (record given) with a
    new untracked file and a tracked edit outside the bundle refuses unsaved; nothing is unlinked";
    and "a resumed resetLegacy over a half-reset tree (bundle-listed paths only) still resets".
    First fails today (the reset runs).
  - B: `loop-migrate-worktree.test.mjs` "F5: killed at migrate:after-reset-intent, then
    src/wip.txt written in the old worktree: plan reports changed; the run with the old digest
    refuses plan-changed; wip.txt survives". Fails today: `retired`, wip.txt gone.

### F6. The empty-save reset discards newly staged-only work (lane B, uses D)
- Source: Codex G2-3 (P1).
- Defect: in phase `resetting` with `reset.sha === null` and `index_dirty`, the run executes
  `read-tree <base>` without the index-only check brief:1054-1055 requires, on first runs and
  retries alike.
- Fix (brief-conformant): immediately before that `read-tree` (every run, resumed included), call
  `legacyCheck(paths, {sha: null, base: w.reset.base})`; non-empty `index_only` refuses
  `index-only {paths}` and nothing is reset.
- Test first: `loop-migrate-worktree.test.mjs` "F6: empty save with a staged removal; killed at
  migrate:after-reset-intent; unique content staged and the working file restored to base: the run
  refuses index-only; the staged blob and the worktree remain". Fails today: the worktree is removed.

### F7. A forged or stale untrack record widens what the commit may hold (lane B)
- Source: Codex G2-4 (P1). Found while verifying: the resumed path also skips the branch
  preconditions R6 requires for resumed steps ("the branch preconditions apply to resumed steps
  too", brief:212), so a record naming a non-base branch commits there.
- Defect: `expectedSet(rec)` and `commitMatches` read the record's own `removals` and `gitignore`;
  a record with an extra removal plus a matching staged deletion is committed. R22 (brief:432-433)
  claims a forged record cannot widen what is accepted; the code contradicts it.
- Fix (R57): `derivedUntrack(ctx, head0)` computes from git at `head0`: `removals =
  listSpinePaths(R, {ref: head0})`, `existed`, `before_oid`, `after_oid` (hash of
  `withLine(head0 bytes)`, or `before_oid` when it has the line), `add_line`. A resumable record
  whose `head0`, `branch`, `removals`, `intent.*` or `gitignore.*` differ from the derived facts,
  or whose branch fails R6's rule (the base, or R6's base-never-tracked case from current facts),
  is refused: plan reports untrack `refused` with `state-corrupt` (detail `untrack record does not
  match <head0>: <field>`), run exits 3 `state-corrupt`, nothing changes. The staged-set check,
  `rollbackOwn`, `rollbackOf` and the post-commit check use the derived values only.
- Test first: `loop-migrate-untrack.test.mjs` "F7: after migrate:after-record, keep.txt appended to
  both removal lists and its deletion staged: the run refuses state-corrupt, HEAD and the index
  unchanged"; and "a record naming a non-base branch at that branch's tip: refused, no commit".
  Fails today: `untracked` with `D keep.txt` committed. (MC-U8 at loop-migrate-untrack.test.mjs:299
  stays and must still pass.)

### F8. The read-only plan runs repository-configured clean filters (lane B; README C)
- Source: Codex G2-5 (P2, reproduced with read-only git).
- Defect: `hash-object --path=.gitignore` (plan and run) invokes any clean/process filter that
  `.gitattributes` maps to `.gitignore`, before confirmation and without the lock.
- Fix (R48): before any hash of `.gitignore`, `check-attr -z filter -- .gitignore`; a value other
  than `unspecified`/`unset` refuses `gitignore-filtered {filter}` (plan refusal; run exit 3) and
  no `hash-object`, `update-index` or rollback hash runs. README row (lane C).
- Test first: `loop-migrate-plan.test.mjs` "F8: .gitattributes maps .gitignore to filter x whose
  clean command touches a marker: plan refuses gitignore-filtered and the marker does not exist".
  Fails today: marker created, no refusal.

### F9. Uncommitted spine bytes are lost if a branch switch hits before the first anchor (lanes B, A, C)
- Source: Codex G3-1 (P1, static trace; verified: no untrack precondition refuses unstaged spine
  edits, and 0.6.0 firings never commit the spine, so unstaged edits are the normal state).
- Defect: after the untrack commit the spine is ignored, so a switch to a tracking branch silently
  overwrites it (before, git refused the switch over unstaged tracked edits); before the first
  anchor nothing detects it, and the documented recovery `git restore --source=<commit>^` restores
  committed bytes only.
- Fix (R49): lane B: in untrack step 3 (new record only), before the record is written, snapshot
  each present spine file (`SPINE_FILES`) into `preUntrackDir(V)/<k>/` (k = 1 + the largest
  plain-integer name; built as `.partial-<k>-<hex>`, temp + rename per file, mode 0600,
  `manifest.json` last via `snapshotManifestText`, dir fsynced, one rename to `<k>`, parent
  fsynced; never removed); the record gains `snapshot: {dir, files:[{name, bytes, sha256}]}`;
  fault `migrate:after-snapshot` after the publish. Lane A: `spineStatus` reports
  `migrated: {record, commit, snapshot, snapshot_files}`. Lane C: bootstrap step 1's
  `migrated-before` uses those facts; the remedy is the snapshot's `cp` commands
  (`mkdir -p <S>`, then `cp <snapshot>/<name> <S>/<name>` per file) when `migrated.snapshot` is
  set, else today's `git restore --source=<commit>^`; README row likewise.
- Tests first:
  - B: `loop-migrate-untrack.test.mjs` "F9: unstaged STATE.md and LEDGER.jsonl edits before the
    untrack: the snapshot holds the unstaged bytes and the record names them". Fails today (no
    snapshot).
  - A: `spine-status.test.mjs` "F9: migrated facts: record, commit, newest complete snapshot; a
    .partial-* is never named". Fails today (no `migrated`).
  - C: `migration-cases-bootstrap.test.mjs` MC-B4 extended "uncommitted sentinels in STATE.md and
    LEDGER.jsonl before the migration survive the kill, the switch and the printed restore".
    Fails today (sentinels lost). Integration-dependent on A and B.

### F10. Bootstrap overwrites a STATE.md made during its unlocked interview (lane C)
- Source: Codex G3-2 (P1, reproduced in memory with the player).
- Defect: step 1 sees `absent`; the owner creates `STATE.md` before step 6; the recheck accepts
  `partial`; step 8 writes the template over the owner's file (the player keeps step 1's
  `partial = false`). A replacement also never checks the shown bytes are still current.
- Fix (R53): step 1 notes the verdict and `files['STATE.md'].sha256` (null when absent); the step 6
  recheck requires the same verdict and the same `STATE.md` sha256; any difference releases with
  `--carry`, tells the owner, and returns to step 1's keep/replace question (a new interview round,
  writing nothing). The player follows the prose.
- Test first: `migration-cases-bootstrap.test.mjs` "F10: STATE.md created between the interview
  and the acquire: bootstrap releases and asks again; the owner's bytes survive". Fails today
  (sentinel gone).

### F11. Resetting/reset/refused phases never re-save, so the documented retry never works (lanes B, D; README C)
- Sources: Codex G3-3 (P2); MIG-2 (P3).
- Defect: phase `resetting` with a moved HEAD refuses `head-moved` forever; phases `reset`/`refused`
  with a changed tree refuse `unsaved` forever (a tracked edit even reports `paths: []`); `plan`
  reports `changed: false`; README promises "the plan asks you to save again". No code path does.
- Fix (R47): `worktreeStep` sets `changed: true` (intent = live, `head_moved` when HEAD moved) in
  phase `resetting` when HEAD differs from `reset.base` or `legacyCheck` reports unsaved paths, and
  in phases `reset`/`refused` when the tree is dirty or HEAD differs from `reset.base`. A run with
  the new digest (the owner's yes) takes R38(c)'s path from any of these phases: verify every kept
  bundle, `saveLegacy` (appended; never replaces), `adoptFor` again (R40), new `resetting` record
  `{sha, base, started_at}`, reset, remove. A run with the old digest refuses `plan-changed`
  (nothing reset). The removal-time `unsaved` refusal stays as a race guard and gains `{tracked,
  staged}` booleans beside `paths`. README rows `head-moved` (worktree) and `unsaved` describe
  this (lane C).
- Tests first (`loop-migrate-worktree.test.mjs`):
  - "F11: killed at migrate:after-reset, src/late.txt written: plan changed; run with the new digest
    appends a second save holding late.txt, resets, removes; saves holds both shas". Fails today
    (`unsaved` forever).
  - "F11: killed at migrate:after-reset-intent, a commit in the old worktree: plan head_moved and
    changed; old digest -> plan-changed, nothing reset; new digest -> re-save, adopt-ff, reset,
    removed". Fails today (`head-moved` forever). The existing MC-W13 "HEAD moved during resetting:
    head-moved, nothing reset" (loop-migrate-worktree.test.mjs:277) is updated to this behaviour
    (old digest refuses, nothing reset).
  - "F11: a tracked edit after reset: the unsaved refusal names tracked: true". Fails today.

### F12. C3b and C7 cannot fail on the guard's allow-lists and several sites (lane C)
- Sources: Codex G3-4 (P2, 98 checks pass with `tracked` inserted); PROSE-4 (P3).
- Fix: C3b asserts the exact allow set at each site: SKILL.md `ok`; migration.md `migrate,ok`;
  bootstrap step 8 `absent,partial`, steps 9 and 10 `partial`, step 11 `unanchored` (and step 11's
  first command is that guard); the §4 sentence covering `STATE.md`/`LOOP.md` edits up to §7 names
  the guard; migration step 2's Edit is preceded by `GUARD_MIG`; the Guard-before-writing bullet
  sends exit 3 and exit 2 to "the no-write exit". No site may list `tracked`, `lost`, `regressed`,
  `restore-pending`, `anchor-invalid`, `exposed` or `version-unknown`. C7 rejects any sentence in
  bootstrap.md or migration.md that releases at a no-write exit ("Release ... as in step 6" and the
  like) without `--carry`.
- Tests first (`tests/check.test.mjs`): mutations: insert `tracked` into bootstrap step 8's list;
  drop bootstrap step 11's guard; rewrite the guard-hit action to "write ## Last run and go on";
  drop `--carry` from bootstrap step 7's release. Each passes today; each must fail.

### F13. The adopt-collision remedy breaks the dated-branch rule (lane C)
- Source: Codex G3-5 (P3; predicate confirmed).
- Fix: README `adopt-collision` row Fix text: "Rename the branch in your repository so the names no
  longer collide: the branch checked out in the old worktree to a dated name the clone does not
  have (`git -C <project> branch -m <branch> <prefix>/<YYYY-MM-DD>`, a day with no loop branch);
  any other branch to a name outside `<prefix>/` (`git -C <project> branch -m <branch>
  kept/<branch>`), which keeps it in your repository only. Nothing was reset; run the loop again."
  New check C19: that row names `<prefix>/<YYYY-MM-DD>` and no `-legacy` suffix form.
- Test first: `tests/check.test.mjs` mutation restoring `<branch>-legacy` must fail C19 (C19 is new,
  so it fails before the README edit).

### F14. Scope entries the LOOP.md list cannot hold pass the gate (lane A)
- Source: BS-1 (P3, reproduced).
- Fix (R54): in `scopeEntriesGate`, an entry with a C0 control character or DEL, or for which
  `frontList('---\nscope:\n  - ' + e + '\n---\n', 'scope')` does not return exactly `[e]` (a throw
  counts), is a problem `{entry, why: 'malformed'}` (reason `invalid`). Covers bootstrap `--input`
  and the migration.
- Test first: `tests/lib/loop-scope-gate.test.mjs` "F14: 'src #old', 'a: b', '[x', '- x', a leading
  quote, 'a\nb', 'a\rb', 'src\u001b[31m' are malformed". Fails today (`ok`).

### F15. The scope proposal lists gitlinks and runs ls-tree on a bare branch name (lanes A, B; prose C)
- Source: BS-2 (P3, reproduced).
- Fix (R54): lane A: `scopeProposal(root, baseRef)` (loop-scope.mjs) from `ls-tree -z <baseRef>`,
  keeping `040000 tree` entries whose names do not start with `.`; `loop-spine.mjs scope <P>
  --propose --base <branch>` prints it (`resolveBase`, so a remote-only base works). Lane B:
  `scopeStep` uses `scopeProposal`. Lane C: bootstrap step 5 runs `scope <P> --propose --base
  <base>` and names no `ls-tree`.
- Tests first: A: `tests/loop/loop-spine.test.mjs` "F15: --propose omits a top-level submodule and
  works when the base exists only as origin/<base>". B: `loop-migrate-plan.test.mjs` "F15: the scope
  proposal omits a gitlink". Both fail today.

### F16. A symlinked exclude file that already holds the line refuses; the exit 2 has no prose action (lanes A, C)
- Sources: BS-3 (P3, reproduced); PROSE-8(a).
- Fix: lane A: `ensureIgnored` reads the file git reads (`excludePath(R)`) first; when it has the
  line and `ignoreFacts` says ignored, return `{state:'ignored', path, added:false}` before the
  symlink and `file !== own` refusals; refuse `exclude-not-regular` only when a write is needed
  (this lives in `writeIgnoreLine`, section 5). Lane C: the exposed repair and bootstrap step 7 add
  "exit 2: the no-write exit (in bootstrap, release with `--carry` as in step 6), naming the
  `detail`"; bootstrap's closing rule reads "steps 7 to 11".
- Tests first: A: `tests/lib/spine-ignore.test.mjs` "F16: a symlinked exclude file that already
  holds /.tech-lead/: ensureIgnored returns ignored, added false; without the line it still refuses
  exclude-not-regular". C: check mutation dropping step 7's exit 2 clause must fail (new assertion
  in C17).

### F17. `migrated-before` misreads a completed migration (lane C)
- Source: BS-5 (P3).
- Fix (R49): bootstrap step 1's `migrated-before` bullet and the README row say: when the owner
  moved the work area's copy aside to start fresh after a completed migration, this refusal is
  expected (the commit shown is the untrack commit, trailer `Tech-Lead-Migration: 0c`) and the
  owner answers yes; when the migration never finished, restore from `migrated.snapshot` (or the
  commit's parent). README "Restoring a wiped spine" start-fresh paragraph adds the same yes.
- Test first: check C17 extension: the `migrated-before` bullet names `migrated.snapshot` and the
  completed-migration case; README's start-fresh paragraph names `migrated-before`. Mutation drops
  either; passes today, must fail.

### F18. The index-only remedy never offers the promised restore (lanes A, C)
- Source: SG-1 (P2, reproduced with the repo's fixtures).
- Defect: R23 (G3) and README promise a restore of any spine file that differs from the copy after
  `rm --cached`; the verdict after the remedy is `ok`, and `restore` refuses `not-lost`, so a
  stash-popped old STATE.md silently becomes the backlog.
- Fix (R50): lane A: `spineStatus` gains `drift: [name]` (LOOP.md and STATE.md, never LEDGER.jsonl,
  whose live `{bytes, sha256}` differ from the anchor, computed only when the anchor is valid and
  the copy matches; else `[]`); `restore <P> --drift [--token <t> --generation <N>]` accepts
  verdict `ok` with non-empty `drift` (refuses `not-restorable` reason `no-drift` when empty, and
  `not-drift` for any other verdict), reports and writes only drift files, same token, marker and
  `--restored` flow. Lane C: SKILL.md §1 step 4, interactive `tracked` with empty `tracked.head`
  and `anchor.present`: take the no-write exit, print the `rm --cached` remedy (with
  `<roots...>`), ask the owner one plain question to run it and reply; on the reply run `status
  <P>`; on `ok` with non-empty `drift`, follow the restore sub-list with `--drift` added to both
  restore commands (a no keeps the live files); any other answer or verdict ends the firing.
  Without `anchor.present` the hand-over to migration.md stays. README row and MC-P12 follow.
- Tests first: A: `tests/loop/loop-spine-restore.test.mjs` "F18: STATE.md differs from a matching
  copy: status ok with drift [STATE.md]; restore --drift lists only STATE.md; plain restore still
  refuses not-lost; --drift with no drift refuses no-drift; a ledger extension is never drift".
  Fails today. C: `migration-cases-spine.test.mjs` MC-P12 "a STATE.md-only stash: after the remedy
  the firing offers the drift restore and the restored STATE.md equals the copy". Integration-
  dependent on A.

### F19. C3 matches verdict names anywhere in step 4 (lane C)
- Source: PROSE-1 (P3, reproduced). Fix: each VERDICTS name must appear in the head of a top-level
  bullet of step 4 (the backticked names before the first `(` or `:`). Test first: mutation
  deleting the `restore-pending` clause from the lost/regressed bullet, and the `partial` clause
  from the absent bullet; both pass today; must fail.

### F20. No check covers the `SPINE.json` Write in the anchor sequences (lane C)
- Source: PROSE-2 (P3). Fix: C6, C17, C18 and a §1 step 4 anchor-firing assertion require
  "`<S>/SPINE.json` with the Write tool" between `save <P> --generation <N>` and `status <P>
  --expect`. Test first: mutations dropping it from §8 and from the anchor firing; pass today; must
  fail.

### F21. C16 accepts scheduled bullets that name write sub-lists (lane C)
- Source: PROSE-3 (P3). Fix: every `- **Scheduled:**` bullet in step 4 begins with "the no-write
  exit" and names no write sub-list (`the restore`, `anchor firing`, `exposed repair`,
  `references/migration.md`, `references/bootstrap.md`). Test first: mutation "the restore (below)"
  in the scheduled lost bullet; passes today; must fail.

### F22. C6b's "ledger last" can never fail (lane C)
- Source: PROSE-5 (P3). Fix: test the regex only on the slice from "Write each file in `files`" to
  "A file in `too_large`". Test first: mutation "in any order"; passes today; must fail.

### F23. Nothing checks quick's worktree decision (lane C)
- Source: PROSE-6 (P3). Fix: C9 requires in quick §2 step 3: "Any output" followed by the literal
  `worktree add -b feature/<slug> <tmpdir>/quick-<slug> origin/<base>`, and "No output" followed
  by "switches in place"; MC-Q1..Q3 additionally read the decision words from quick's SKILL.md.
  Test first: mutations inverting the decision and deleting the `worktree add -b` line; pass
  today; must fail.

### F24. Quick step 4 reads as unconditional; the worktree path has no taken-name rule (lane C)
- Source: PROSE-7 (P3). Fix: step 4 begins "Only when the spine check printed nothing:"; the
  worktree sub-list adds "if `feature/<slug>` is taken, append `-2` in the `worktree add -b`; step
  4 does not run". C9 asserts both. Test first: C9 mutation removing "Only when the spine check
  printed nothing"; must fail.

### F25. Other helper exits without a prose action (lane C)
- Source: PROSE-8 (b)-(d) (P3). Fix (R59): bootstrap steps 2 and 5: "exit 2 (a base that does not
  resolve, for example): tell the owner the `detail` and ask for the base again"; bootstrap
  closing: "A refusal from `save` or `status --expect` at step 11 leaves the spine `unanchored`: go
  on to step 12 and tell the owner; the next interactive firing anchors it"; migration step 8: "a
  refusal or exit 2 from `run --step version`, or a `plan` that does not print `complete` after the
  Edit, goes into the summary; go on to step 9". Test first: C17/C18 assertions for each clause,
  with one mutation each; pass today; must fail.

### F26. A kept `partial` STATE.md has three readings; MC-B3 stops early (lane C)
- Source: PROSE-10 (P3). Fix (R53): bootstrap says a kept `STATE.md` gets step 4's new items (one
  Edit each) and a `## Last run` section (replaced when present, added where the template places it
  when missing); step 9 may add `id:`/`origin:` lines; a `normalize` or `check` refusal on a kept
  file (for example `crlf`) releases with `--carry` and tells the owner the file must be fixed or
  replaced. The player follows. Test first: `migration-cases-bootstrap.test.mjs` MC-B3 "an LF kept
  STATE.md without ## Last run runs through step 12 with its bytes kept and ## Last run added"; and
  "a CRLF kept STATE.md reaches the refusal with the detail". Fail today.

### F27. An adoption record disables the 0c-2 tamper check (lane D)
- Source: M2 (P3, reproduced). Fix (R56): `tamperCheck` skips only when the newest record holds no
  snapshot (`head_ref === null` and `refs` absent or empty); a record with `head_ref: null` and a
  non-empty `refs` (an adoption record) is matched exactly (no ref exempt). Test first:
  `tests/loop/loop-clone-adopt.test.mjs` "F27: adopt, close, update-ref in <W>: the next prepare
  refuses tampered" (both the existing-clone and the created-clone forms). Fails today (`ready`).

### F28. Untrack checks negation before its own `.gitignore` line; the remedy loops (lanes A, B; README C)
- Source: MIG-1 (P3, reproduced with a dotfile whitelist).
- Fix (R55): lane A splits `ensureIgnored` into `writeIgnoreLine` (write half) and the check (section
  5). Lane B: untrack step 4 calls `writeIgnoreLine` (no negation check); after step 6 (the line in
  the working `.gitignore` and staged) and before step 7, `ignoreFacts(R)` must say ignored, else
  roll back the step's own change (as today), move the record to `untrack_history` with `why:
  'negated'`, and refuse `negated {rules, sources}`. The done path keeps `ensureIgnored`. README
  `negated` row: "Remove each rule it names; a rule in `.gitignore` is a change you commit, then run
  the loop again; the exclude line stays"; `gitignore-dirty` row adds "or make `.gitignore` exactly
  HEAD's bytes plus the line `/.tech-lead/`".
- Test first: `loop-migrate-untrack.test.mjs` "F28: committed .gitignore `.*`, `!.gitignore`,
  `!.tech-lead/`: the untrack step commits and the spine is ignored". Fails today (`negated`).

### F29. Untracked files under the legacy worktree's `.tech-lead/` become ignored and are deleted (lane B; README C)
- Source: MIG-3 (P3, reproduced).
- Fix (R51): `worktreeStep` refuses `newly-ignored {paths, more}` (plan refusal; run exit 3) when
  the old worktree holds an untracked entry whose first component matches the spine root
  (`isSpinePath`) and that is either not ignored at all (the untrack will ignore it) or ignored only
  by the common exclude file's spine line (`check-ignore -v -n --no-index` through `linkedGit`:
  source is `excludePath(R)` and the pattern satisfies `hasIgnoreLine`). Remedy: move them out of
  `<S>/worktree/.tech-lead/`. README row (lane C).
- Test first: `loop-migrate-worktree.test.mjs` "F29: an untracked .tech-lead/notes.md in the old
  worktree: plan refuses newly-ignored before and after the untrack; the run refuses; notes.md
  remains". Fails today (`retired`, notes.md gone).

### F30. A plan-time untrack `head-moved` never clears without a run (lane B; prose C)
- Source: MIG-6 (P3, reproduced). Fix (R58): plan's `head-moved` refusal carries `self_heals: true`
  and the remedy "confirm the untrack step: its run rolls back the step's own staged change,
  records it and refuses head-moved; the next plan starts afresh". migration.md step 3: an untrack
  refusal with `self_heals: true` is not the owner's to fix: collect the untrack yes and go on to
  step 4. README `head-moved` row (untrack) likewise. Test first: B: `loop-migrate-plan.test.mjs`
  "F30: killed at migrate:after-rm, an owner commit: plan's head-moved refusal has self_heals true";
  C: C11 assertion that step 3 names `self_heals`; both fail today.

### F31. `.gitignore.tl-*` temp file left in `<P>` on a lost lock (lane B)
- Source: MIG-7 (P3). Fix: `ctx.held()` before writing the temp file; write and rename inside a
  try that removes the temp file on any failure (as `ensureIgnored` does). Test first:
  `loop-migrate-untrack.test.mjs` "F31: the lock lost at step 6 (taken over at migrate:after-rm):
  not-holder and no .gitignore.tl-* in <R>". Fails today.

---------------------------------------------------------------------------------------------------

## 3. New rulings (behaviour the brief did not settle, or settled on a false premise)

- **R45. Spine path matching follows `core.ignorecase`.** A path is under the spine when its first
  component equals `.tech-lead`, ASCII case-insensitively when `git config --bool core.ignorecase`
  is true in `<R>`, exactly otherwise; git's own spelling is reported and used as the pathspec.
  Used by trackedFacts, the untrack step, its rollbacks and remedies, and F29. Quick's prose keeps
  its literal commands (stage 0'). Cost if wrong: a repository whose `core.ignorecase` misstates its
  filesystem (copied between volumes) keeps the old blind spot, or untracks a same-named directory
  on a case-sensitive volume.
- **R46. A resumed legacy reset keeps the relaxed unsaved check.** Non-preflight `resetLegacy`
  refuses `unsaved` when a changed path is neither at the base, at its bundle state, nor listed in
  the bundle (relaxed); `plan` in phase `resetting` reports such work as `changed` through
  `legacyCheck`. Supersedes brief 5.5's "never the 'unsaved' precondition" and R38(a)'s "(`unsaved`
  cannot arise there)" (see section 4); spec:1024-1027 requires the save. Cost if wrong: a resumed
  reset whose tree holds new work asks for a re-save (R47) instead of resetting.
- **R47. Re-save from `resetting`, `reset` and `refused`.** When the old worktree's HEAD differs from
  `reset.base` or it holds work outside the kept bundles (`resetting`), or it is dirty or its HEAD
  moved (`reset`, `refused`), `plan` reports `changed` (and `head_moved`) with the live intent's
  digest; on the owner's yes the run takes R38(c)'s path (verify every kept bundle, save again
  appended, adopt again, a new `resetting` record, reset, remove). Every earlier save stays in
  `saves`. Supersedes R38(c)'s last clause and brief 5.4's `resetting` and "`reset` or `refused`"
  bullets (section 4). Cost if wrong: an extra bundle per interruption in `<V>/patches`, and a
  partly reset tree may be saved as one more bundle (all kept, nothing replaced).
- **R48. A filtered `.gitignore` refuses the untrack step.** `check-attr filter` on `.gitignore`
  other than `unspecified`/`unset` refuses `gitignore-filtered {filter}` in `plan` and `run` before
  any hash or staging of `.gitignore`. Cost if wrong: a repository that runs a clean filter on
  `.gitignore` migrates only after the owner drops that attribute for `.gitignore`.
- **R49. The untrack step snapshots the live spine first; bootstrap reads it.** A new untrack record
  is preceded by a complete copy of the present spine files in
  `<V>/migration/0c/pre-untrack/<k>/` (with `manifest.json`), never removed, named in the record.
  `spineStatus.migrated` reports `{record, commit, snapshot, snapshot_files}`. Bootstrap's
  `migrated-before` remedy restores from the snapshot (`cp`) when one exists, else from
  `<commit>^`; it says that after a completed migration whose copy the owner moved aside this
  refusal is expected and answered yes. Cost if wrong: one extra copy of three files per untrack
  record in the work area.
- **R50. The drift restore after the index-only remedy, in the same firing.** With `tracked.head`
  empty and `SPINE.json` present, the interactive firing has the owner run the `rm --cached` remedy,
  re-reads the status, and offers `restore --drift` for `LOOP.md`/`STATE.md` that differ from a
  matching copy. The ledger is never part of a drift restore. Supersedes R23 (G3)'s "the next
  interactive firing offers the R18 restore" (section 4). Cost if wrong: an owner who runs the
  remedy outside the firing gets no offer and compares `<V>/spine/<g>/` by hand (README says so).
- **R51. Untracked files under the old worktree's `.tech-lead/` refuse the worktree step**
  (`newly-ignored {paths, more}`) when the migration's exclude line would ignore them. Cost if
  wrong: the owner moves such files out by hand before the worktree is retired.
- **R52. Carried facts survive an interrupted reclaimer.** Acquire inherits an un-noted reclaimed
  slot's `carried` and own facts; `noted` writes `slots/<N>.noted.json`; prose runs `noted`
  whenever acquire returned `reclaimed`, `stopped` or `carried`. Extends R36. Cost if wrong: a
  firing that wrote `## Last run` and died before `noted` repeats those notes once.
- **R53. Bootstrap consent binds to what the owner saw.** Step 6's recheck needs step 1's verdict
  and `STATE.md` sha256; a difference releases with `--carry` and repeats step 1's question. A kept
  `STATE.md` gets the new items and a `## Last run` (added when missing); a normalize/check refusal
  on it means fix or replace. Cost if wrong: an owner who edits `STATE.md` during the interview
  answers the keep/replace question again.
- **R54. Scope entries must round-trip; the proposal is the helper's.** `malformed` for control
  characters and for entries the LOOP.md list grammar cannot hold as written; `scope --propose`
  lists only tree entries of the resolved base. Cost if wrong: a directory named with ` #`, `: `, a
  leading YAML indicator, a quote or a control character cannot be a scope entry.
- **R55. Untrack verifies the ignore after staging its own line; a `negated` refusal retires the
  record** (`untrack_history` why `negated`), so the owner's committed `.gitignore` fix starts a
  fresh step. Cost if wrong: none beyond a re-run.
- **R56. Adoption records are tamper-checked.** A record with `head_ref: null` and a non-empty
  `refs` is matched exactly by the next prepare. Cost if wrong: a ref moved by hand in the hidden
  clone between the migration's close and the next prepare stops that prepare `tampered`, as after
  any close.
- **R57. A resumable untrack record is checked against `head0` and the branch rule.** Mismatch is
  `state-corrupt`; the staged-set and post-commit checks use facts derived from `head0` only; the
  staged `.gitignore` blob must be HEAD's or `after_oid`. Makes R22's existing claim true. Cost if
  wrong: a hand-edited `state.json` reads `state-corrupt` and the owner moves it aside (README row).
- **R58. A plan-time untrack `head-moved` self-heals** (`self_heals: true`; the run rolls back and
  records). Cost if wrong: none.
- **R59. Every helper exit named in bootstrap.md and migration.md has an action** (F16, F25 clauses).
  Cost if wrong: none.

---------------------------------------------------------------------------------------------------

## 4. Brief text superseded (not spec; recorded so the plan and brief v3 match the code)

- brief 5.5, `resetLegacy` (brief:1071-1073): replace "it re-checks HEAD == base and the bundle, never
  the 'unsaved' precondition (a partly reset tree is expected to differ, and the persisted record is
  what proves the save came first)" with "it re-checks HEAD == base, the bundle, and `resetFor`'s
  relaxed 'unsaved' precondition (a path the bundle lists may be in any state; any other changed
  path refuses `unsaved`)" (R46).
- R38(a) (brief:607-608): replace "and never saves the partially reset tree (`unsaved` cannot arise
  there)" with "and refuses `unsaved` for work outside the kept bundles, which R47's re-save then
  keeps" (R46, R47).
- R38(c) (brief:614) and 5.4 (brief:1047-1052): replace "HEAD moved during `resetting` refuses
  `head-moved` and never resets" and "`reset` or `refused`: re-check that the tree is clean ..." with
  R47's text; R25's "a `run` from phase `refused` retries only the removal" holds only while the tree
  is clean and HEAD is `reset.base`.
- R23 (G3) (brief:461-463): replace "the next interactive firing offers the R18 restore for any spine
  file that differs from the copy" with R50's same-firing drift restore.
- R19 (brief:406-407): prune "one file at a time, then `rmdir`" gains "after renaming the directory
  to `.partial-<g>-<hex>`" (F3).

## 5. Spec amendments

None. Every fix fits revision 8: R45 makes "HEAD or the index tracks a path under `.tech-lead/`"
(spec §4) hold on case-insensitive volumes; R46/R47 serve "save its uncommitted work" and "every step
is idempotent and safe to re-run" (spec §9.1); R49 adds to what `<V>/migration/` records; R50
restores only on confirmation and only from a copy that matches `SPINE.json`; the rest are plan-level
refusals and prose.

---------------------------------------------------------------------------------------------------

## 6. Cross-lane interfaces (fixed; implement exactly, consume exactly)

### Lane A provides
`scripts/lib/spine.mjs`:
- `export function ignoreCase(R) -> boolean` (`git config --bool core.ignorecase` reads `true`).
- `export function isSpinePath(p, icase) -> boolean` (first `/`-component equals `.tech-lead`,
  ASCII case-insensitively when `icase`).
- `export function listSpinePaths(R, { ref = null, icase = ignoreCase(R) } = {}) -> string[]`:
  uncapped, git's spelling, git's order; `ref === null` lists the index (`ls-files -z
  --full-name`), else `ls-tree -r -z --name-only --full-name <ref>`; an unborn or missing ref
  gives `[]`. No pathspec.
- `export function spineRoots(paths) -> string[]` (distinct first components, sorted; `[]` for none).
- `trackedFacts(R, {base})`: signature and shape unchanged; built on `listSpinePaths`.
- `export function writeIgnoreLine(R, { guard }) -> { path, added }`: the write half (temp file +
  rename, `guard()` before the rename); throws `Error('exclude-not-regular: ...')` only when a write
  is needed; never consults `ignoreFacts`. TypeError without `guard`.
- `ensureIgnored(R, {guard})`: unchanged signature and result; reads first (F16), then
  `writeIgnoreLine` when needed, then the `ignoreFacts` check (throws `REFUSED negated` as today).
- `spineStatus` facts gain `drift: string[]` (subset of `['LOOP.md', 'STATE.md']`, RESTORE_ORDER)
  and `migrated: { record: boolean, commit: string|null, snapshot: string|null,
  snapshot_files: string[] }` (`record`: `<V>/migration/0c` is a directory; `commit`: `git log -1
  --format=%H` over the spine roots, `.tech-lead` when none; `snapshot`: absolute path of the
  plain-integer-named `pre-untrack/<k>/` with the largest k whose manifest parses; `snapshot_files`:
  its manifest's names).
- `export const SNAPSHOT_MANIFEST = 'manifest.json'`; `export function preUntrackDir(V) ->
  path.join(V, 'migration', '0c', 'pre-untrack')`; `export function snapshotManifestText({ head0,
  branch, files, created_at }) -> string` (`canonicalJson({v:1, head0, branch, files (sorted by
  name, each {name, bytes, sha256}), created_at}) + '\n'`); `export function
  parseSnapshotManifest(text) -> object | null`.

`scripts/lib/loop-scope.mjs`:
- `scopeEntriesGate`: new `why: 'malformed'` cases (F14); otherwise unchanged.
- `export function scopeProposal(root, baseRef) -> string[]` (tree entries `040000` of `baseRef`'s
  top level, names not starting with `.`, git's order).

`scripts/loop-spine.mjs` CLI:
- `scope <P> --propose --base <branch>` -> exit 0 `{state:'proposal', base, base_ref, proposal}`;
  exit 2 for an unresolvable base; `--propose` with `--input` is a usage error.
- `restore <P> --drift [--token <hex> --generation <N>]`: as `restore`, over `drift` names only;
  exit 3 `not-restorable` reasons gain `no-drift`, `not-drift`. The marker and `status --expect
  <sha> --restored --generation <N>` are unchanged.
- `save`: new fault point `spine:after-prune-one`; output unchanged.

`scripts/loop-lock.mjs`: CLI unchanged. `acquire`'s `carried` may hold inherited entries (same
entry shape); `noted` also creates `slots/<N>.noted.json`.

### Lane D provides
`scripts/reflex-bundle.mjs`:
- `export function legacyCheck(paths, { sha = null, base = null, env = process.env } = {}) ->
  { state: 'ok', base, index_only: string[], unsaved: string[], tracked: boolean, staged: boolean }`:
  read-only, takes no lock; `openLegacy` refusals as today (LEGACY_INVALID). With `sha`: the bundle
  verified (its refusals as `verifyBundle`), `base` = its header base, `unsaved` =
  `unsavedPaths(..., relaxed = true)`. With `sha === null`: `base` required (an oid), `unsaved` =
  working-tree paths (tracked edits and untracked files) differing from `base`, index-only
  differences excluded. `index_only` = staged content found in no commit (as `resetEmpty`'s check).
  `tracked`/`staged`: the worktree has tracked edits / staged changes.
- `resetLegacy(...)`: signature unchanged; non-preflight refuses `unsaved {paths}` per R46 before
  any destructive call.

`scripts/loop-clone.mjs`: no interface change (tamperCheck is private).

### Lane B provides (consumed by lane C prose, README and migration-case tests)
`loop-migrate.mjs` outputs: untrack refusals gain `gitignore-filtered {filter}` and `state-corrupt`
(record mismatch, detail `untrack record does not match <head0>: <field>`); untrack `head-moved`
refusal gains `self_heals: true`; worktree refusals gain `newly-ignored {paths, more}` and
`index-only` in phase `resetting`; worktree `changed`/`head_moved` per R47; run exit 3 gains
`gitignore-filtered`, `newly-ignored`; `unsaved` extra `{paths, more, tracked, staged}`;
`negated` now retires the record. `state.json`: `untrack.snapshot: {dir, files}` (optional, null
for none), `untrack_history[].why` gains `'negated'`. Fault point `migrate:after-snapshot`.
Remedies print every root spelling (`-- <roots...>`).

---------------------------------------------------------------------------------------------------

## 7. Lanes (file-disjoint)

### Lane A: spine, scope, lock
Files: `scripts/lib/spine.mjs`, `scripts/loop-spine.mjs`, `scripts/lib/loop-scope.mjs`,
`scripts/loop-lock.mjs`, `tests/lib/spine.test.mjs`, `tests/lib/spine-status.test.mjs`,
`tests/lib/spine-ignore.test.mjs`, `tests/lib/spine-fixture.mjs`,
`tests/lib/loop-scope-gate.test.mjs`, `tests/loop/loop-spine.test.mjs`,
`tests/loop/loop-spine-save.test.mjs`, `tests/loop/loop-spine-restore.test.mjs`,
`tests/loop/loop-spine-fixture.mjs`, `tests/loop/loop-lock-carry.test.mjs`.
Findings: F1 (library), F2, F3, F9 (status facts, snapshot format), F14, F15 (library, CLI), F16
(code), F18 (status, CLI), F28 (`writeIgnoreLine`).
All lane A tests run green inside the lane.

### Lane B: migration helper
Files: `scripts/loop-migrate.mjs`, `tests/loop/loop-migrate-fixture.mjs`,
`tests/loop/loop-migrate-plan.test.mjs`, `tests/loop/loop-migrate-untrack.test.mjs`,
`tests/loop/loop-migrate-worktree.test.mjs`.
Findings: F1 (migration side), F4, F5 (plan side), F6, F7, F8, F9 (snapshot write), F11 (migration
side), F15 (scopeStep), F28 (step order, retirement), F29, F30, F31.
Integration-dependent tests (green after lanes A and D land): F1-B, F5-B, F6, F9-B, F11, F15-B,
F28, F29 (uses `isSpinePath`).

### Lane C: prose, README, checks, fixtures, firing driver, migration cases
Files: `skills/loop/SKILL.md`, `skills/loop/references/bootstrap.md`,
`skills/loop/references/migration.md`, `skills/quick/SKILL.md`, `README.md`,
`scripts/checks/loop.mjs`, `tests/check.test.mjs`, `tests/fixtures/firing-driver.mjs`,
`tests/loop/migration-cases-fixture.mjs`, `tests/loop/migration-cases-bootstrap.test.mjs`,
`tests/loop/migration-cases-gate.test.mjs`, `tests/loop/migration-cases-migration.test.mjs`,
`tests/loop/migration-cases-recipes.test.mjs`, `tests/loop/migration-cases-spine.test.mjs`.
Findings: F2 (noted wording), F8/F11/F28/F29/F30 (README rows, migration.md step 3), F9 (bootstrap
remedy, MC-B4), F10, F12, F13, F15 (bootstrap step 5), F16 (prose), F17, F18 (SKILL.md, README,
MC-P12), F19, F20, F21, F22, F23, F24, F25, F26.
Integration-dependent tests: MC-B4 (A, B), MC-P12 drift (A), MC-G8 noted rule (A), bootstrap step 5
`--propose` in the player (A).

### Lane D: bundle and clone helpers
Files: `scripts/reflex-bundle.mjs`, `scripts/loop-clone.mjs`,
`tests/loop/reflex-bundle-legacy.test.mjs`, `tests/loop/loop-clone-adopt.test.mjs`,
`tests/loop/reflex-bundle-fixture.mjs`.
Findings: F5 (library), F6/F11 (`legacyCheck`), F27.
All lane D tests run green inside the lane.

No lane edits `scripts/lib/loop-md.mjs`, `scripts/lib/git-safe.mjs`, `scripts/lib/changes.mjs`,
`scripts/lib/legacy-worktree.mjs`, `scripts/loop-recover.mjs`, `scripts/checks/contracts.mjs` or the
spec.

## 8. Integration
Merge order A, D, B, C (any order works: the interfaces above are fixed). Then `node
scripts/check.mjs` (every new mutation fails the check it targets) and three full runs of `node
--test "tests/**/*.test.mjs"`. MC-W11, MC-W13 (updated), MC-U8 and every existing case keep passing.

## Addendum 2 (2026-10-08): fix round 2 rulings (Codex re-check)

- R70: a resumed untrack record whose snapshot no longer matches the live spine (or is incomplete) gets a new snapshot before anything is untracked; older snapshots are kept. Cost if wrong: one extra snapshot directory per such resume.
- R71: the legacy reset (preflight and resume) and legacyCheck are strict: every changed path, bundle-listed or not, must be at the base or at its saved state, otherwise the call refuses unsaved and the migration re-saves (R47). Cost if wrong: a re-save where a relaxed check would have reset.
- R72: legacyCheck is read-only: it reads and hash-checks the bundle without replaying it, keeps temporary indexes in a private temp directory, and hashes nothing into the object store. Cost if wrong: none beyond a temp directory.
- R73: the untrack step names its .gitignore temp file from its record and sweeps the temp files of the current and retired records at the start of every run. Cost if wrong: none.
- Readiness checks: snapshots are named only when every listed file verifies (size and sha256); C3b pins that the migration step 2 Edit runs right after its guard.
