# Loop Bootstrap (only when `<P>/.tech-lead/` is missing)

`<P>` is the absolute project path resolved in §1 of the loop skill.

## Who is attending

- **Unsure whether a user is attending:** ask one confirmation question as
  plain text that ends the turn (not AskUserQuestion). Scaffold only on an
  affirmative reply. In a cron session the question goes unanswered and the
  firing simply ends, which is the correct headless outcome.
- **Headless (cron, nobody attending):** print an error naming the missing
  spine and exit. Never scaffold unattended.

## Interactive bootstrap

1. **Refuse on a dirty index or `.gitignore`.** If
   `git -C <P> diff --cached --quiet` fails, or `.gitignore` already has
   uncommitted changes, stop and ask the user to commit or stash first. The
   bootstrap commit must contain only the spine.
2. **Create the spine files** from `loop-templates.md`:
   `<P>/.tech-lead/LOOP.md`, `STATE.md`, and an empty `LEDGER.jsonl`.
   - Set `base:` to the remote's default branch
     (`git -C <P> symbolic-ref --quiet --short refs/remotes/origin/HEAD`,
     without the `origin/` part). With no remote default, propose the branch
     bootstrap runs on. Confirm it with the user; on a detached HEAD with no
     remote default, ask which branch to use.
3. **Detect `verify:` candidates** from package.json scripts or the Makefile,
   and confirm them with the user.
4. **Build the initial `## Backlog`** with the user, from the project's
   existing task sources.
5. **Update `.gitignore`.** Append `.tech-lead/worktree/`,
   `.tech-lead/briefs/` and `.tech-lead/worktree-deps.ok` to
   `<P>/.gitignore`.
6. **Commit exactly these paths:**

   ```
   git -C <P> add -- .tech-lead/LOOP.md .tech-lead/STATE.md .tech-lead/LEDGER.jsonl .gitignore
   git -C <P> commit --only -m "chore: tech-lead loop state spine" -- .tech-lead/LOOP.md .tech-lead/STATE.md .tech-lead/LEDGER.jsonl .gitignore
   ```

Bootstrap ends the firing. The first real iteration is the next one.
