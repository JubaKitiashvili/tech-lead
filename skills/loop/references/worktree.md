# Prepare the Loop Worktree

Run this once per firing, before the first write-capable dispatch (the
fast-worker path and the L3 Codex path). A §7 retry reuses the prepared
worktree and its `U` unchanged. It never re-runs these steps.

`<P>` is the absolute project path, `<S>` = `<P>/.tech-lead`,
`<W>` = `<S>/worktree`, and `<T>` is the plugin root (loop §1). Every
command names its directory explicitly: use `git -C` with an absolute path,
never a bare `git` or a relative path.

## Steps

1. **Today's branch** is `<branch_prefix>/<YYYY-MM-DD>` (UTC date).
   - **Start-point:** use the branch currently checked out in `<P>` when no
     unmerged loop commits exist.
   - Otherwise chain from the newest dated loop branch, and note the
     divergence in `## Last run`.
2. **Clean the tracked tree.** This only applies when `<W>` exists.
   - Check: `git -C <W> diff --quiet && git -C <W> diff --cached --quiet`.
   - If the check fails, an earlier firing was interrupted. Reset:
     `git -C <W> restore --staged .` then `git -C <W> checkout -- .`.
   - Note the recovery in `## Last run`.
3. **Create or rotate the worktree.**
   - If `<W>` is missing: `git -C <P> worktree add -b <branch> <W> <start-point>`.
     If `<branch>` already exists, attach to it instead:
     `git -C <P> worktree add <W> <branch>`.
   - If `<W>` exists on an older dated branch:
     `git -C <W> switch -c <branch> <start-point>`. If `<branch>` already
     exists, run `git -C <W> switch <branch>` instead.
   - Any other failure here is an infra incident, handled the same way as a
     dependency failure in step 4.
4. **Dependencies.** A dependency-install failure is a global infra incident:
   the worktree is broken for every task, so the loop must stop until a human
   fixes it.
   - `<S>/worktree-deps.ok` holds `<branch> <lockfile hash>`.
   - If that file is missing, or its content differs from the current values,
     install dependencies in `<W>` (e.g. `cd <W> && npm ci`).
     - **Success:** rewrite the marker.
     - **Failure:** delete the marker, then:
       - write the incident to `## Last run`;
       - set `paused: true` in `LOOP.md`;
       - return the item to `## Backlog` with its `status:` unchanged;
       - record outcome `skipped`, note "worktree deps";
       - stop the runner.
5. **Untracked baseline.**
   - Record `U` = the untracked entries in
     `git -C <W> status --porcelain=v1 -uall`, excluding `.tech-lead/`.
   - These are leftovers from interrupted firings, and their ownership is
     uncertain. §6 never stages anything in `U`, and never deletes it.
   - If `U` is non-empty, list it in `## Last run` as "leftover untracked (not
     staged): …" for a human to resolve.

## Execution contract for every write-capable delegate

Put this in every write-capable brief (the fast-worker prompt, or the Codex
brief file):

- The worktree's absolute path is `<W>`. Stating it once is not enough,
  because a subagent's cwd resets between Bash calls:
  - every shell command must be `cd <W> && …` or `git -C <W> …`;
  - every Read, Edit and Write path must be absolute under `<W>`.
- Ignore the worktree's own stale committed `.tech-lead/` copy.
- No state-changing git commands. The loop owns git.
- Do not run write-mode formatters or `--fix` linters on files outside the
  task.
- Stop and report any judgment call instead of guessing.
- **Codex only:** end the answer with exactly these two lines:
  `JUDGMENT CALLS: none | <list>` and `SKIPPED: none | <list>`.

Never use Agent or Workflow `isolation: "worktree"` for loop dispatches. The
loop owns its own worktree.
