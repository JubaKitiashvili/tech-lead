# Prepare the Loop Clone

Run this once per firing, before the first write-capable dispatch (the
fast-worker path and the L3 Codex path). A §7 retry keeps its attempt: it
never prepares the clone again (`prepare` refuses with `attempt-open`).

`<P>` is the absolute project path, `<S>` = `<P>/.tech-lead`, `<T>` is the
plugin root, `<N>` is the firing's lock generation, and `<W>` is the clone
that acquire printed as `W` (all from loop §1). `<W>` is a full clone of the
project in the loop's work area `<V>` (`~/.cache/tech-lead/<key>/`), outside
the project. Today's loop branch, `<branch_prefix>/<YYYY-MM-DD>` (UTC), lives
only there. After each commit the loop writes the branch to a delivery bundle
under `<V>/out/`, which the owner fetches.

The main session never runs git in `<W>` itself. `loop-clone.mjs` and
`reflex-bundle.mjs` make every change there, each with the clone's safe git
settings (no hooks, no fsmonitor, no external diff or textconv). A read goes
through the read-only passthrough, for example
`node <T>/scripts/loop-clone.mjs git <P> -- log --oneline -5`. It allows
status, diff, log, show, rev-parse, ls-files, rev-list, merge-base, cat-file,
for-each-ref, blame, grep, shortlog and describe; it never looks inside a
nested repository, runs no filter program and never writes the clone's
index, so it refuses `--ignore-submodules`, `--recurse-submodules`,
`--submodule` and `describe --dirty`/`--broken`. Every helper
call below is one foreground Bash call with `timeout: 600000` and prints one
JSON line. Exit 3 with `"state": "not-holder"` is a lost lock (loop §1 step
3); every other refusal follows [Refusals](#refusals).

## Steps

1. **Prepare the clone.**

   ```
   node <T>/scripts/loop-clone.mjs prepare <P> --generation <N> --prefix <branch_prefix> --base <base>
   ```

   Leave out `--base <base>` when `LOOP.md` has no `base:` key; the helper
   then uses the project's remote default branch (`origin/HEAD`).
   `prepare`, in this order:
   - creates `<W>` on the first run, as a `git clone --no-local` of the
     project that adopts the loop branches already in it; or else checks
     `<W>`: its integrity, Codex quiet in it (it quiesces `<W>` first), no
     process running in it, and its refs against the last run record (or,
     when none is left, against the refs the last close saw);
   - saves whatever an interrupted firing left in `<W>` (edits, new files,
     a delegate's commit) to a recovery bundle, then resets `<W>` (the
     clean-clone rule). Nothing is removed before its bundle is verified.
     Untracked files are listed under the ignore rules that firing
     recorded, never under rules read from `<W>`. When no run record is
     left (a process wrote into `<W>` after a firing closed), they are
     listed under the rules the last close kept with the refs (the clone's
     current rules when it kept none, the base's before any close);
   - refreshes `<W>` from the project and rewrites stale delivery bundles;
   - switches to today's branch. Its start point is the newest dated loop
     branch that still holds work the base lacks, or else the base itself.
     A loop branch whose work the base already holds (after a squash merge,
     say) counts as merged, and a branch the owner retired is never used.
     The branch checked out in `<P>` plays no part. The switch never
     overwrites a file the clone holds and its rules ignore: when the new
     branch tracks one, `prepare` refuses `infra` and names it (`paths`).
2. **Record what `prepare` did** (exit 0, `"state": "ready"`). In
   `## Last run`, note:
   - `created: true`: "created the clone", and each `adopted` branch;
   - `chainedFrom` set: "chained from <chainedFrom>";
   - `retiredReset: true`: today's branch was reset to a fresh start point
     (its old tip was retired or unvetted; it stays in the retired ref and
     the `.prev` bundle);
   - `baseAhead: true`: the base has commits today's branch lacks (the loop
     never rebases);
   - each `recovered` entry: "saved clean-clone bundle <sha12> of
     generation <generation> (<files> files, <out_of_scope> out of scope,
     <hidden> hidden)", and "delegate commit <rewound_from> rewound" when
     `rewound_from` is set. A null `generation` means work no firing
     recorded (a process that wrote into `<W>` after a release);
   - every line of `notes`.

   In this firing's single ledger entry, each `recovered` entry joins
   `saves` as `{sha, why, files, out_of_scope}`, and each row of `bundles`
   joins `bundles`.
3. **Dependency marker.**

   ```
   node <T>/scripts/loop-clone.mjs deps <P> --generation <N>
   ```

   It compares the marker `<W>/.git/tech-lead-deps.ok` (today's branch and
   a hash of the root lockfiles) with the clone's current values. With
   `"fresh": true`, skip step 4; otherwise install the dependencies there.
4. **Dependencies.** A dependency-install failure is a global infra incident:
   the clone is broken for every task, so the loop must stop until a human
   fixes it. The install runs as a child of the firing lock, in a process
   group of its own, through one foreground Bash call with
   `timeout: 600000`. The words after `--` are the project's install
   command (`npm ci` here):

   ```
   node <T>/scripts/loop-lock.mjs exec <P> --generation <N> --label deps --cwd <W> --timeout-ms 540000 -- npm ci
   ```

   `--timeout-ms 540000` ends the install, and kills its process group,
   before the Bash call's own limit: a Bash call that reaches its `timeout`
   is moved to the background, still running in `<W>`. If one ever is, wait
   for its completion notification before going on.

   The install's output passes through, and the last stderr line is
   `loop-lock exec: {"state": …, "exit": …}`. Judge by that `state`, not by
   the exit code alone:
   - **Success** (`state` `exited`, `exit` 0): go on to step 5. This is the
     only success.
   - **Lost lock** (`state` `not-holder` or `holder-gone`, or a
     `lingering` run whose `outcome.state` is one of them): follow loop §1
     step 3.
   - **Failure** (`state` `exited` with any other `exit`, `lingering`,
     any other `state`, or no such line): the marker stays as it was, so
     the next firing installs again. Then:
     - write the incident to `## Last run`;
     - set `paused: true` in `LOOP.md`;
     - return the item to `## Backlog` with its `status:` unchanged;
     - record outcome `skipped`, note "clone deps";
     - stop the runner.
   - `lingering` (exit 123) means a process of the install outlived it:
     its process group survived the cleanup or its liveness could not be
     read (`left`), or a process still runs in `<W>` (`alive`, never
     signalled), or the check for one could not run. Whatever the install
     exited (`outcome`), it is the failure above and an infra incident:
     touch nothing else in `<W>`, name `left` and every process in `alive`
     in the incident, and add the unpause check "set `paused: false` once
     none of these processes runs".
5. **Check the clone after the install,** whether or not step 4 ran:

   ```
   node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after deps
   ```

   It records the ignore rules that every later save lists untracked files
   under, so a delegate's new ignore rule can never hide a file from a save.
   That is why it runs before any dispatch, even with a fresh marker.
   - `"state": "ok"`: when step 4 ran, mark the dependencies installed:

     ```
     node <T>/scripts/loop-clone.mjs deps <P> --generation <N> --mark
     ```

   - `deps-dirty`: the install changed files that git does not ignore
     (`paths`: a rewritten lockfile, generated sources). This is an infra
     incident: name the paths, set `paused: true`, return the item with its
     `status:` unchanged, record outcome `skipped`, note "clone deps-dirty",
     and stop the runner. The next clone preparation saves and resets those
     files. The fix is an install that leaves tracked files alone (`npm ci`,
     not `npm install`), or ignore rules for what it writes.
   - Any other refusal: [Refusals](#refusals).

## After every untrusted execution

Delegates, Codex and verify commands run untrusted code in `<W>`. Check the
clone after each of them: after every dispatch (the fast-worker, each §7
retry) and after every quiet Codex quiesce (loop §5),

```
node <T>/scripts/loop-clone.mjs check <P> --generation <N> --after dispatch
```

and after the verify commands (loop §6 step 3), the same with
`--after verify`. `check` re-verifies the clone's integrity, HEAD and refs
against the run record. It rewinds any commit a delegate made, keeping the
work in the tree, and resets plain staging, so the loop never stages
anything itself. Its `"state": "ok"` result carries:

- `touched`: every path changed against the attempt's base, from git's
  standard listing (at most 50 are listed; `counts.touched` has the total);
- `out_of_scope`: the touched paths outside `LOOP.md`'s `scope:` (a path
  under `.tech-lead/` inside `<W>` always is);
- `hidden`: paths that only the recorded ignore rules list (a delegate's
  new ignore rule hides them from git). They are never committed, and the
  next clone preparation saves them;
- `delegateCommitted` and `delegateCommits`: commits a delegate made, now
  rewound;
- `unstaged: true`: plain staging was reset;
- `digest`: a hash of the touched set, which `commit` takes.

A submodule's own files (a nested repository populated at a path the base
tracks as a gitlink) are never looked into: an edit there is not touched,
never committed, saved or reset, and stays in `<W>`. A gitlink moved to
another commit is seen, and no bundle can hold it (`unsavable`).

## Refusals

**Pause** means: touch nothing in `<W>`, write the incident to `## Last run`
with the `detail` (and any `paths`, `largest`, `problems` or `procs` it
printed), set `paused: true`, return the item to `## Backlog` with its
`status:` unchanged, record outcome `skipped` with the note in the table, and
stop the runner. The next clone preparation saves what `<W>` holds. README's
Troubleshooting has the owner's fix for each note.

| Command | `state` (exit 3) | What the loop does |
|---|---|---|
| any | `not-holder` | Lost lock (loop §1 step 3). `commit`, `bundle` and `close` also answer it when the lock is lost while they write a delivery bundle, never as a `bundleError`. The bundle may then already be published without its sidecar (the `.json` beside it is missing or names an older tip); the next clone preparation regenerates both |
| `prepare` | `not-quiet` | A Codex process may still write into `<W>`. Pause, note "codex not quiet", with the unpause check from loop §5 step 5 |
| `prepare` | `busy` | A process runs in `<W>` (`procs`, never signalled). Pause, note "clone busy", with the unpause check "set `paused: false` once none of these processes runs" |
| `prepare`, `deps`, `check`, `commit` | `clone-invalid` | `<W>` is not a clone the loop can trust (`problems`: for example a key in its config, or a git storage path such as `.git/objects` replaced by a symbolic link; also `<W>` itself or a folder of the work area such as `patches/`, `run/` or `out/` being a symbolic link), or it changed that way while the helper ran. Pause, note "clone invalid" |
| `prepare`, `check --after deps` | `tampered` | A ref or HEAD in `<W>` changed since the run record (no dispatch has run yet, so there is nothing of this attempt to save). Pause, note "clone tampered" |
| `prepare` | `save-failed` | What an interrupted firing left could not be saved, so nothing was removed. Pause, note "clone save-failed" |
| `prepare`, `check`, `commit` | `index-only` | Staged content that exists nowhere else (`paths`); nothing was removed. Pause, note "clone index-only" |
| `prepare`, `deps`, `check`, `commit` | `corrupt` | A run record does not read. Pause, note "run record corrupt" |
| `prepare` | `no-base` | The base is missing. Pause, note "no base" |
| `prepare`, `check` | `infra` | A git failure, a shallow project, no git identity in `<P>`, a git older than 2.40 (`git-too-old: needs git 2.40 or newer`), a merge or filter driver the clone cannot switch off (`unsafe-config: …`), or a switch to today's branch that would overwrite ignored files (`paths`). Pause, note "clone infra" |
| `prepare`, `check` | `unsafe-config` | A filter driver in the owner's git config has a name the clone cannot switch off. Pause, note "clone unsafe-config" |
| `prepare`, `check` | `excludes-file-in-work-area` | The owner's `core.excludesFile` lies inside the project or the work area. Pause, note "clone excludes-file" |
| `prepare` | `attempt-open` | This firing already prepared its clone. Pause, note "clone attempt-open" |
| `deps`, `check`, `commit` | `no-attempt` | No open attempt: `prepare` did not run, or the attempt ended. Pause, note "clone no-attempt" |
| `check` | `no-rules` | Step 5 did not run. Pause, note "clone no-rules" |
| `check --after deps` | `deps-dirty` | Step 5 |
| `check` | `unsavable` | A path no bundle can hold (`paths`: a nested repository, a gitlink moved to another commit, a special or unreadable file). Pause, note "clone unsavable" |
| `check --after dispatch` or `verify`, `commit` | `tampered` | Something changed the clone outside its work tree (config, refs, HEAD). Save and reset with `--why pause` (loop §7), then pause, note "clone tampered" |
| `commit` | `work-changed` | The work changed after the last `check`. Save and reset with `--why pause`, then pause, note "work changed" |
| `commit` | `out-of-scope`, `commit-failed` | An attempt failure (loop §7), with the `detail` as the failure excerpt |
| `bundle` | any other (`unvetted`, `clone-invalid`, `infra`) | Note it in `## Last run`; nothing else |
| `close` | any other (`corrupt`, `clone-invalid`, `infra`) | Only the summary names it (loop §8) |

Any other exit 3 from `prepare`, `deps`, `check` or `commit` is a pause too,
note "clone <state>". Exit 2 (`"state": "error"`) from them is a pause too,
note "clone error". From `bundle` or `close` it only goes into
`## Last run` or the summary. `reflex-bundle.mjs save` and `reset` answers
follow loop §7's Save and reset (a save refused `head-moved`, HEAD no longer
at the attempt's base, is a failed save there).

## Execution contract for every write-capable delegate

Put this in every write-capable brief (the fast-worker prompt, or the Codex
brief file):

- The clone's absolute path is `<W>`. Stating it once is not enough,
  because a subagent's cwd resets between Bash calls:
  - every shell command must be `cd <W> && …`;
  - every Read, Edit and Write path must be absolute under `<W>`.
- Never read or write the project at `<P>`, or its `.tech-lead/`: all work
  happens in the clone.
- Never touch `<W>/.git`.
- Ignore the clone's own stale committed `.tech-lead/` copy, if it has one.
  A change under it is out of scope.
- No state-changing git commands. The loop owns git.
- Do not run write-mode formatters or `--fix` linters on files outside the
  task.
- Stop and report any judgment call instead of guessing.
- **Codex only:** end the answer with exactly these two lines:
  `JUDGMENT CALLS: none | <list>` and `SKIPPED: none | <list>`.

Never use Agent or Workflow `isolation: "worktree"` for loop dispatches. The
loop owns its own clone.

The owner reviews and rejects loop work from their own terminal (README,
"Reviewing loop work"); no firing runs that review.
