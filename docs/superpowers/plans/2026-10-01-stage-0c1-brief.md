# Stage 0c-1 architecture brief: foundation and firing lock

Binding authority: docs/superpowers/specs/2026-09-30-system1-layer-design.md revision 6
(commit eb3e400): §3 (`<key>`, `<P>` top level), §4, §10 row 0c-1, §11, §16. This brief
fixes module names and interfaces so the prototype, the plan and later stages (0c-2 to 0c-4)
share one owner per concern. Input material only (revision 6 overrides it): the firing-lock
design in scratchpad/0c-design.json.

Conventions (from stages 0a and 0b): Node 22 ESM `.mjs`, no npm dependencies; tests use
`node:test` + `node:assert/strict`, run with `node --test "tests/**/*.test.mjs"`; checks with
`node scripts/check.mjs`. Helper CLIs print exactly one JSON line on stdout (exec is the
exception, see below) and use exit codes 0 / 2 (error or usage) / 3 (refused: held, not
holder) unless stated. A module is runnable as a CLI only via the same guard 0b uses:
`if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)))`.
Write no `\uXXXX` escapes through tools that decode them; keep code ASCII.

In stage 0c-1 the loop still works in the existing git worktree `<S>/worktree`. The clone
`<V>/clone` arrives in 0c-2. Every helper that runs in "the worktree" takes it explicitly
(`--cwd`), never derives it.

## 1. scripts/lib/atomic.mjs (owner: atomic records)

- `createExclusive(file, obj) -> boolean`: write JSON to `<dir>/.tmp-<pid>-<random hex>`,
  `fs.linkSync` it to `file`, unlink the temp; EEXIST -> unlink temp, return false. Readers
  never see a partial record.
- `writeReplace(file, obj)`: temp file in the same directory, then `fs.renameSync`.
- `readJson(file) -> object | null`: null when missing; throws `Error('corrupt: <file>')` on
  unparseable content.

## 2. scripts/lib/loop-proc.mjs (owner: process facts)

- `startToken(pid) -> {state:'live', token} | {state:'gone'} | {state:'unknown', detail}`.
  `process.kill(pid, 0)` ESRCH -> gone (no ps call); EPERM -> continue (exists).
  darwin: `ps -o stat=,lstart= -p <pid>` with env LC_ALL=C TZ=UTC; non-zero exit -> gone;
  stat starting with `Z` -> gone; token = `darwin:` + lstart with whitespace collapsed.
  linux: `/proc/<pid>/stat` (state field Z -> gone; field 22 starttime) and
  `/proc/sys/kernel/random/boot_id` -> `linux:<boot_id>:<starttime>`. Any other failure ->
  unknown.
- `isAlive({pid, start}) -> true | false | null`: gone -> false; live with a different token
  -> false (pid reused); live with the same token -> true; unknown -> null. Callers treat
  null as alive.
- `groupAlive(pgid) -> true | false | null`: `process.kill(-pgid, 0)`: ok or EPERM -> true,
  ESRCH -> false, other -> null.
- `killGroup(pgid, {graceMs = 5000} = {}) -> Promise<boolean>`: SIGTERM to `-pgid`, poll
  every 100 ms until `groupAlive` is false or grace ends, then SIGKILL and poll up to 2 s;
  resolves true when the group is gone.
- `resolveHolder(env = process.env) -> {pid, start, how}`: pid = `env.TECH_LEAD_HOLDER_PID`
  (tests only) or `env.CLAUDE_PID` (set by Claude Code for every Bash command: the long-lived
  `claude` process); its token must be live; otherwise throw `Error('no-holder: …')`.
  `how` = 'TECH_LEAD_HOLDER_PID' | 'CLAUDE_PID'.

## 3. scripts/lib/loop-paths.mjs (owner: `<key>`, `<V>`, identity)

- `loopPaths(P, {env = process.env} = {}) -> {P, R, key, S, V, W, lockDir}`:
  `R = fs.realpathSync.native(P)`; `top = fs.realpathSync.native(git -C R rev-parse
  --show-toplevel)`; R !== top -> throw `Error('not-toplevel: <R> is inside <top>')`; not a
  repository -> throw `Error('not-a-repo: …')`. `slug` = basename(R) lowercased, every char
  outside `[a-z0-9._-]` -> `-`, cut to 64, `'project'` when empty. `h` = first 16 hex of
  SHA-256 over the UTF-8 bytes of R. `key = slug-h`. cache root = `env.TECH_LEAD_CACHE` or
  `<homedir>/.cache`. `V = <cache root>/tech-lead/<key>`, `S = R/.tech-lead`,
  `W = V/clone` (reserved for 0c-2), `lockDir = V/lock`.
- `ensureV(paths) -> paths`: mkdir -p V; `identity.json` = `{v:1, R}` via createExclusive;
  if it exists with a different R -> throw `Error('identity-mismatch: <V> belongs to <R>')`.

## 4. scripts/lib/git-safe.mjs (owner: git in the loop's work area)

- `safeGit(cwd, args, {input} = {}) -> string` (stdout, trimmed of one trailing newline):
  runs `git -C <cwd> -c core.hooksPath=/dev/null -c core.fsmonitor=false
  -c core.untrackedCache=false <args>` with an env copied from process.env minus
  GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
  GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_COMMON_DIR, GIT_NAMESPACE, GIT_CONFIG_PARAMETERS,
  plus GIT_NO_REPLACE_OBJECTS=1, LC_ALL=C, GIT_TERMINAL_PROMPT=0. Throws with stderr in the
  message on non-zero exit. (Spec §16: hooks, fsmonitor and inherited GIT_* never reach the
  loop's own git calls.)

## 5. scripts/loop-lock.mjs (owner: firing lock; exports + CLI)

Layout under `lockDir`: `slots/<N>.json` (holder record, immutable), `slots/<N>.released.json`
(release record, immutable), `children/<N>-<name>.json` (child records). Both directories are
created on demand.

Records:
- slot: `{v:1, generation, holder:{pid, start, how}, session: env.CLAUDE_CODE_SESSION_ID ||
  null, acquired_at, previous: {generation, released, reclaim: null|'dead-holder'|'same-process'} | null}`
- release: `{v:1, generation, by:'holder'|'owner', released_at}`
- child, kind proc (exec): `{v:1, kind:'proc', generation, label, cwd, command,
  wrapper:{pid, start}, pid, pgid, start}`; written before spawn with pid/pgid/start null,
  rewritten (writeReplace) right after spawn.
- child, kind codex: `{v:1, kind:'codex', generation, cwd, jobId}` (jobId null until the
  companion returns it).
- child, kind dispatch: `{v:1, kind:'dispatch', generation, id, label, opened_at}` (an
  in-process Agent or Workflow dispatch; it has no pid).

Exports: `acquire(P, {env}) -> Promise<result>`, `release(P, generation, {env, owner, io})`,
`status(P, {env})`, `assertHeld(paths, generation, env) -> slot` (throws an Error with
`code = 'NOT_HOLDER'`), `openDispatch(P, generation, label, {env}) -> id`,
`closeDispatch(P, generation, id, {env})`, `registerCodex(P, generation, cwd, {env}) -> file`,
`setCodexJob(file, jobId)`, `stopChildren(paths, generation) -> Promise<{stopped, alive}>`,
`ledgerFloor(S) -> number` (max numeric `iteration` over parseable lines of
`<S>/LEDGER.jsonl`, 0 when missing; bad lines skipped).

Acquire algorithm (spec §10 0c-1):
1. `paths = ensureV(loopPaths(P, {env}))`; `me = resolveHolder(env)`.
2. Up to 5 attempts:
   a. `max` = highest N among `slots/<N>.json` (null when none); `floor = ledgerFloor(S)`.
   b. If `max` is set and `<max>.released.json` is absent:
      - `slot = readJson` (corrupt -> held `corrupt`).
      - `alive = isAlive(slot.holder)`; null -> held `holder-unknown`.
      - `same = slot.holder.pid === me.pid && slot.holder.start === me.start`.
      - alive and not same -> held `holder-live`.
      - same and any dispatch record of `max` exists -> held `dispatch-open` (a background
        agent may outlive an interrupted in-session firing).
      - `{alive: left} = await stopChildren(paths, max)`; left non-empty -> held `child-live`.
      - `reclaim = same ? 'same-process' : 'dead-holder'`.
   c. `N = Math.max(max ?? 0, floor) + 1`.
   d. `createExclusive(slots/N.json, record)`; false -> next attempt (a racer won; re-read).
   e. Return `{state:'acquired', generation: N, V, W, lockDir, previous, reclaimed:
      {generation: max, how: reclaim, stopped} | null}`.
3. After 5 lost races -> held `race`.
Held results never write anything outside `slots/.tmp-*` (removed again).

`stopChildren(paths, g)` for every `children/<g>-*.json`:
- proc: group identity = `pgid`; the group is ours while `groupAlive(pgid)` is true (POSIX
  never reuses a pid that is still a process group id). If alive -> `killGroup(pgid)`. If the
  wrapper is alive by identity (`isAlive(wrapper)`), SIGTERM it. Record removed when the
  group and the wrapper are gone; otherwise reported in `alive`.
- codex: `quiesce(cwd)` imported from `scripts/loop-codex.mjs`; quiet -> remove record, else
  `alive`.
- dispatch: removed (only reached for a dead holder; same-process returned earlier).
- unreadable record -> `alive` (fail closed).

`release(P, N)`: `assertHeld`; `stopChildren(paths, N)` (anything left is a bug: report it in
`lingering`, still release); `createExclusive(slots/<N>.released.json)`. Owner form
(`--owner`): requires `io.isTTY` (stdin and stdout); prints status; asks the owner to type N;
writes `by:'owner'`; kills nothing. Not a TTY -> exit 2, nothing written.

`assertHeld(paths, N, env)`: max slot === N, not released, holder pid and start equal
`resolveHolder(env)`; else throw NOT_HOLDER.

CLI (`node <T>/scripts/loop-lock.mjs …`):
- `acquire <P>` -> exit 0 acquired | exit 3 `{state:'held', reason, generation, …}` | exit 2
  `{state:'error', detail}`.
- `release <P> --generation N [--owner]` -> exit 0 `{state:'released', generation}` | exit 3
  `{state:'not-holder'}` | exit 2.
- `dispatch open <P> --generation N --label L` -> `{id}`; `dispatch close <P> --generation N
  --id ID` -> `{closed:true}`; not holder -> exit 3.
- `exec <P> --generation N --label L --cwd <dir> [--timeout-ms T] (--verify K | -- argv…)`:
  stdout and stderr pass through; the last stderr line is
  `loop-lock exec: {"state": …, "exit": …}`; exit code = the command's (124 timeout, 125 not
  holder or holder gone). `--verify K` runs the K-th (0-based) item of `verify:` in
  `<S>/LOOP.md` through `/bin/sh -c`, so the model never re-quotes it. Steps: assertHeld;
  write the pending proc record; spawn detached (own process group) with
  `TECH_LEAD_FIRING=<N>` in env; fill pid/pgid/start; poll every 1 s: holder gone ->
  killGroup, exit 125 `holder-gone`; timeout -> killGroup, exit 124; on exit, a still-alive
  group (lingering grandchildren) -> killGroup; remove the record.
- `status <P>` -> read-only, exit 0.

## 6. scripts/loop-codex.mjs (modified)

`start` gains optional `--project <P> --generation <N>`: when given, `assertHeld` (exit 4
`{state:'not-holder'}`, nothing launched), `registerCodex` before launching, `setCodexJob`
after the companion returns the job id. No watchdog process (revision 6).

## 7. scripts/loop-recover.mjs (owner: recovery planning; read-only skeleton)

`node <T>/scripts/loop-recover.mjs <P> --worktree <dir> [--reclaimed <N>]` -> exit 0
`{reclaimed, now: <first line of ## Now or null>, worktree: {exists, staged, tracked,
untracked: [paths]}, actions: [...]}`; actions in order from
`['requeue-now', 'reset-worktree']`: requeue-now when `## Now` holds an item; reset-worktree
when the worktree has staged or tracked changes. Reads with safeGit; never writes. Later
stages add bundle and commit-trailer actions.

## 8. scripts/checks/loop.mjs (prose wiring) and check.mjs

Checks (each with an e2e mutation test in tests/check.test.mjs):
- SKILL.md §1 names `loop-lock.mjs acquire` before it reads `LOOP.md`;
- SKILL.md §8 names `loop-lock.mjs release` as the last command;
- verify commands run through `loop-lock.mjs exec` (`--verify`), and worktree.md's
  dependency install through `loop-lock.mjs exec`;
- every `loop-codex.mjs start` in the docs carries `--generation`;
- no `git stash` anywhere in skills/;
- Agent and Workflow dispatches in SKILL.md are bracketed by `dispatch open` / `dispatch close`
  (check: the prose names both).

## 9. Prose (skills/loop/SKILL.md, references/worktree.md, references/loop-templates.md, README.md)

- §1 order: resolve paths; missing spine -> bootstrap (unchanged; bootstrap ends the firing,
  no lock); `loop-lock.mjs acquire <P>`: exit 3 or 2 -> end the firing at once and write
  nothing (the one exception to §8's one-entry rule); exit 0 -> keep generation N; a
  `reclaimed` result goes into `## Last run`; then read state; then stale `## Now` via
  `loop-recover.mjs`.
- Every Agent or Workflow dispatch: `dispatch open` before, `dispatch close` after the result.
- §6 verify: `loop-lock.mjs exec <P> --generation N --label verify --cwd <W> --verify K`.
- worktree.md step 4: the install through `exec … --label deps --cwd <W> -- <argv>`.
- Codex start gains `--project <P> --generation <N>`.
- §8: `loop-lock.mjs release <P> --generation N` after the ledger append, as the last command.
- loop-templates.md: `iteration` is the firing's lock generation (strictly increasing, gaps
  allowed); a firing that ends at the lock writes nothing.
- README: the lock (status, owner release), and that runs use it.

## 10. Tests (real processes and real temp git repos; no mocks of the OS)

- atomic: exclusive create race (two writers, one wins), replace, corrupt read.
- proc: token of a live sleeper, gone after kill, pid reuse simulated by a different token,
  zombie counted gone (where reproducible), groupAlive, killGroup on a group with a
  grandchild that ignores SIGTERM.
- paths: key through a symlink alias equals the key of the real path; over-long and empty
  basenames; not-toplevel refused; identity mismatch refused.
- git-safe: a pre-commit hook in the repo does not run; an inherited GIT_DIR pointing at
  another repo is ignored.
- lock: acquire on empty -> generation 1; floor from LEDGER.jsonl; held by a live other
  holder (a sleeper as TECH_LEAD_HOLDER_PID) -> exit 3 and no files written; dead holder ->
  reclaim; same process -> reclaim noted; same process with an open dispatch -> held;
  a wiped `<V>` with ledger iteration 41 -> generation 42; release; owner release refuses
  without a TTY; assertHeld after another firing acquired -> NOT_HOLDER.
- race: 8 concurrent acquirers with distinct live holders -> exactly one acquired.
- exec: exit code passthrough; `--verify K`; lingering grandchild killed; timeout 124;
  not holder 125; holder death mid-run -> group killed, 125.
- interruption: a firing driver (tests/fixtures/firing-driver.mjs) that acquires, starts an
  exec child, and is SIGKILLed at each boundary (after acquire; during exec; after the ledger
  append, before release); the next acquire reclaims, kills the orphaned group, and the
  generation never repeats.
- codex: start --generation registers before launching; not holder -> exit 4; a dead
  holder's codex record is quiesced by the next acquire (fake companion fixture from 0b).
- recover: Now item -> requeue-now; dirty tracked file -> reset-worktree; clean -> [].
- check: a mutation test per new prose check.
