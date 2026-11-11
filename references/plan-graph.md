# Plan file

`scripts/plan-graph.mjs` keeps a `/tech-lead` plan as a JSON file and does the
bookkeeping: it validates the plan, names the tasks that can run now, records
status, and restores the run after compaction or in a new session. It runs no
agent and decides nothing.

`<T>` is the plugin root and `<P>` the project root (the top level of a git
working tree). Every command prints one JSON line. Exit 0 is ok, 3 is a
refusal or an invalid plan (read `problems` or `reason`), 2 is an error.

## When to write one

After the user approved the plan and before the first dispatch, when the plan
has five or more tasks, or when any delegated task waits for another. A
smaller plan stays in the message and the task list. A project that is not a
git repository cannot have a plan file (`not-a-repo`); keep the plan in the
message there.

## The draft

```bash
node <T>/scripts/plan-graph.mjs create <P> --json '{
  "goal": "CSV export of the orders list",
  "session_model": "claude-opus-5-5",
  "tasks": [
    { "id": "api", "title": "GET /orders/export returns CSV", "executor": "general-purpose",
      "model": "opus", "effort": "high", "stakes": "high",
      "files": ["api/src/"], "verify": "npm test -w api" },
    { "id": "web", "title": "Export button on the orders page", "executor": "fast-worker",
      "model": "sonnet", "effort": "high",
      "files": ["web/src/orders-page.js", "web/test/"], "depends_on": ["api"],
      "verify": "npm test -w web" },
    { "id": "review", "title": "Read the diff, run both suites", "executor": "main",
      "depends_on": ["api", "web"] }
  ]
}'
```

The draft goes inline in `--json`, in single quotes, so the command needs no
file and no redirection. If the draft itself contains a single quote, write it
to a file and pass `--file <path>` instead.

Per task:

| Field | Rule |
|-------|------|
| `id` | Lower-case letters, digits and `-`; unique. |
| `executor` | `main`, `fast-worker`, `deep-reasoner`, `codex`, `explore`, `general-purpose`, `panel` or `research`. |
| `model` | Left out for `main`. Required on every delegate: `opus`, `sonnet`, `haiku` or `codex`. Never `fable`. `fast-worker` is `sonnet`, `deep-reasoner` is `opus`. |
| `effort` | Optional: `low` to `max`. Not `xhigh` or `max` on `sonnet`. |
| `stakes` | `normal` (default) or `high`. A `high` task cannot go to `fast-worker`. |
| `files` | Repo-relative paths the task may change; a path ending in `/` is a directory. Required for `fast-worker`. Two tasks whose files overlap never run together. |
| `depends_on` | Ids that must be `done` first. No cycles. |
| `verify` | The command or check that proves the task. Required for `fast-worker`. |
| `needs_decision` | An open judgment call. The task cannot start until you settle it. |

`create` answers with the `run_id`, the file path, and `waves`: the schedule if
every task succeeds. An invalid draft lists every problem at once; fix them
all and run `create` again. `validate --json '…'` checks a draft without
writing anything.

## Running the plan

```bash
node <T>/scripts/plan-graph.mjs next <P>
node <T>/scripts/plan-graph.mjs mark <P> --task api --status running
node <T>/scripts/plan-graph.mjs mark <P> --task api --status done --result "endpoint added, 14 tests pass"
```

1. `next` prints `wave`: the tasks that can start now. Dispatch them together,
   each with the `model` and `effort` the plan gives it. `held` tasks wait for
   a task that owns the same files; `blocked` tasks wait for a dependency, for
   a failed dependency, or for your decision.
2. Mark a task `running` when you dispatch it.
3. When a task comes back, verify it (Process step 4), then mark it `done` or
   `failed` with a one-line `--result`. A report alone is not `done`.
4. Run `next` again. Repeat until it prints `"finished": true`.

Other moves:

- **A decision:** `mark <P> --task <id> --decided --result "<what you decided>"`
  clears `needs_decision`.
- **A retry:** `mark … --status pending` on a `failed` task, then start it
  again. `attempts` counts the starts.
- **A task you drop:** `mark … --status skipped`. Tasks that depend on it stay
  blocked until you skip them too or add a replacement.
- **A new task:** `add <P> --json '{…}'` with one task object.
- `done` is final. A refused `mark` names the reason; `--force` starts a task
  the script holds back, and is for the rare case where you know better.

## Resuming

After compaction, or in a new session on the same project:

```bash
node <T>/scripts/plan-graph.mjs status <P>
```

After a compaction, once `/tech-lead` has run in the session, a hook prints a
notice with this command when the project has an unfinished plan. In a new
session nothing reminds you: run it yourself.

It prints the goal, every task with its status and result, and the file path.
Continue from `next`. `list <P>` shows every run, finished ones included.
Without `--run <id>` the commands use the newest unfinished plan.

## Limits

- One session owns a run. Two sessions writing the same plan at the same
  moment can lose an update.
- The file lives outside the repository, under
  `~/.cache/tech-lead/<project>/plans/` (or `TECH_LEAD_CACHE`). It is on this
  machine only.
