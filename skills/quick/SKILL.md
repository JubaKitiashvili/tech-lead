---
name: quick
description: This skill should be used when the user invokes "/tech-lead:quick", or asks to "implement it and open a PR", "fast lane this into a PR", or "make this small change and open a draft PR" for a small, bounded, low-risk task in a git repository. Not for shipping changes that already exist in the working tree, multi-part goals, high-stakes decisions, or open-ended debugging.
argument-hint: [task to implement]
---

# tech-lead Quick — the Direct lane

You implement a small task yourself, verify it, and ship it as a draft PR.
The speed comes from skipping delegation and the plan-approval round trip. It
never comes from skipping verification.

**Authorization.** Publishing is authorized only in two cases:

- the user typed `/tech-lead:quick`;
- the user explicitly asked for a PR in this request.

In either case, this run may create a feature branch, make one commit, push
that branch, and open a draft PR. It must never force-push, push to the base
branch, or merge.

If this skill was picked any other way, do everything up to the local commit.
Then stop and ask before pushing.

## 0 · Preflight

- **Repo check.** The repo must have a GitHub remote, so that `gh repo view`
  succeeds. If it does not, stop and say so.
- **Clean tree.** Run
  `git status --porcelain -- . ':(exclude).tech-lead'`. The live tech-lead
  loop spine does not count.
  - If the output is non-empty, stop and ask the user how to handle their
    uncommitted changes.
  - Never mix their work into this PR. Never stash or commit it yourself.
- **Starting branch.** Record which branch the user is on.
- **Loop spine present.** Check whether `.tech-lead/` is tracked:
  `git -C <repo> ls-files --error-unmatch .tech-lead/LOOP.md`. If it is, do
  not switch branches in the user's checkout. Switching would abort on the
  modified spine, or delete it from disk. Instead, work in a separate
  worktree:
  - Create it with
    `git -C <repo> worktree add -b feature/<slug> <tmpdir>/quick-<slug> origin/<base>`,
    in step 2.
  - Install dependencies there if the checks need them.
  - Run every later command inside that worktree.
  - After the PR is open, run `git -C <repo> worktree remove <path>`.

## 1 · Restate and escalation check (before any branch or edit)

Restate the task in one line, followed by its acceptance check.

**Stop and propose the full `/tech-lead` instead** (or `/tech-lead:panel`
for the decision) if any of these hold:

- The change touches a public API, a data model or migration, security or
  auth, or a major dependency version.
- A real design choice is unresolved.
- The change will touch more than about 5 files, or needs more than about 10
  file reads just to locate the code.

Ask as a plain question and end your turn. Continue only on an explicit
"proceed anyway", and record the escalation reason in the PR body.

## 2 · Branch

1. Pick the base. The user may name one. Otherwise, use the repo's default
   branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
2. `git fetch origin <base>`.
3. `git switch -c feature/<slug> origin/<base>`.
   - `<slug>` is kebab-case, derived from the task, 40 characters or fewer.
   - If the name is taken, append `-2`.

**If you stop before making any edits,** switch back to the starting branch
and delete the empty feature branch. Or remove the separate worktree.

**If you stop after making edits,** stay on the feature branch. Uncommitted
edits are never carried back to the starting branch. Report both branch
names.

## 3 · Implement it yourself

- Read only what you need. If locating the code needs 10+ file reads, make
  one Explore call with `model: "sonnet"`. Dispatch no other subagents.
- Keep the diff minimal. Follow the repo's conventions. Make no drive-by
  refactors.
- **Logic change with a test harness nearby:** write or adjust a failing test
  first, then make it pass.

## 4 · Verify

- **Checks.** Find the repo's checks in package.json scripts or the Makefile.
  Run:
  - typecheck;
  - the tests covering the touched code (the whole suite if it is fast);
  - lint on the touched files.
- **UI check.** This applies only when both of the following hold:
  - the diff changes visible React Native UI (screens, components, styles,
    copy, navigation);
  - a simulator or emulator is already running (argent `list-devices`).

  Then do one on-device check, following the `argent-device-interact` skill:
  open the affected screen, take a screenshot, and confirm the change.
  - Never boot a device for this.
  - If no device is running, write "UI not checked on a device" in the PR
    body.
- **On failure.** Fix and re-run. After two failed fix attempts, stop and
  report the failing output. Leave the changes uncommitted on the feature
  branch. Commit nothing and push nothing red.

## 5 · Ship

1. Review `git diff` yourself. This is ground truth: only the intended files
   should have changed.
2. Stage the intended paths explicitly with `git add <paths>`, including new
   files. Then commit:
   - message: `feat|fix|chore|refactor(<scope>): …`, with a body saying what
     changed and why;
   - end the message with the commit attribution from the system reminder,
     if there is one.
3. **Authorization check.** If publishing is not authorized (see
   Authorization above), stop here and ask.
4. `git push -u origin feature/<slug>`.
5. `gh pr create --draft --base <base> --title "<commit subject>" --body …`.
   The body contains:
   - a summary;
   - the changes;
   - verification: the exact commands and their results, plus the UI check
     result or "UI not checked on a device";
   - risks and notes;
   - the PR attribution line from the system reminder, if there is one.

## 6 · Report

Report the following:

- the PR URL (or "not pushed: awaiting approval");
- the feature branch, and the branch the user started on;
- a one-line summary of the change;
- the verification results;
- anything that was not verified.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Starting on a dirty tree ("it's just one file") | Stop in preflight. The user's work in progress never rides along. |
| "It's small, so no escalation check" | Size is only one signal. An API, schema, or auth change is high-stakes at any size. |
| Branching before the escalation check | Check first. A stop must leave the user on their original branch. |
| Pushing because the skill "looked like" a PR request | Push only on `/tech-lead:quick` or an explicit request for a PR. |
| Pushing with a failing check "to show progress" | Nothing red is committed or pushed. Stop after two fix attempts. |
| Booting a simulator to verify UI | Only use a device that is already running. Otherwise, say so in the PR. |
| `git add -A` | Stage only the intended paths, after reading `git diff`. |
