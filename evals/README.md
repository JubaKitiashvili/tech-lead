# Behaviour evals

These cases measure what the checks and the test suite cannot: whether Claude
behaves better with the plugin loaded than without it. They run with
`claude plugin eval` (Claude Code 2.1.269 or later).

Every run is a real model call. Nothing here runs in `scripts/check.mjs` or in
the test suite.

## Cases

| Case | Tags | What it checks |
|------|------|----------------|
| `route-multipart` | routing | A multi-part goal invokes `tech-lead` and no other skill |
| `route-panel` | routing | An expensive-to-reverse decision invokes `tech-lead:panel` |
| `route-research` | routing | Vetting a dependency invokes `tech-lead:research` |
| `route-quick` | routing | A small change plus "open a draft PR" invokes `tech-lead:quick` |
| `route-loop` | routing | "Start the loop on this backlog" invokes `tech-lead:loop` |
| `skip-question` | routing, guard | A plain question invokes no tech-lead skill |
| `skip-single-edit` | routing, guard | A one-line fix invokes no tech-lead skill |
| `skip-rename` | routing, guard | One mechanical rename across files, no PR, invokes no skill |
| `skip-debug` | routing, guard | A stack trace and "why does this fail" invokes no skill |
| `skip-opinion` | routing, guard | A quick opinion on a library invokes no skill |
| `plan-first` | behaviour | The plan names a model per task and nothing is dispatched before approval |
| `delegates-pin-model` | behaviour, costly | After approval, every `Agent` call carries a model |

In the routing cases the "skill fired" grader is marked `arm: both`, so it is
part of the score: a run without the plugin scores 0.5 by design, and a run
with the plugin where the skill stays silent fails the case.
| `plan-file` | behaviour, plan-graph, costly | An approved six-task plan with ordering is recorded with `plan-graph.mjs create`, and every `Agent` call carries a model. Needs `--allow-tools Bash`. The sandbox cannot run git, so `create` itself fails there and `next`/`mark` are not measured |
| `loop-no-silent-bootstrap` | behaviour, loop | With no `.tech-lead/` spine the loop creates and dispatches nothing; it asks first or names the gap |

The routing cases grant only `Skill`, `Read`, `Glob` and `Grep`, so a skill
that fires cannot dispatch agents; they measure the skill descriptions, not the
work. A run loads only this plugin: the user's `CLAUDE.md` and rule files are
absent, so the routing rule in `~/.claude/rules/tech-lead.md` plays no part.

## Running

Each case runs `runs` times with the plugin and the same number without it
(default 3 + 3). Thirteen cases at the default are about 78 agent runs plus judge
calls. Start small:

```bash
# cheapest pass: routing only, one run per arm (20 agent runs)
claude plugin eval . --tag routing --runs 1 --model opus \
  --output-dir /tmp/tech-lead-evals --no-publish

# the two behaviour cases need the fixture project
claude plugin eval . --tag behaviour --runs 1 --model opus --scaffold \
  --output-dir /tmp/tech-lead-evals --no-publish
```

- `--model` pins the session model so scores compare over time. Run the
  behaviour cases once with `--model fable` to measure the Fable rules.
- `--scaffold` runs each case's `fixture.sh` as you. Without it the behaviour
  cases start in an empty folder.
- `--output-dir` must point outside the plugin: the manifest declares the plugin
  root as a skill folder, and the command warns when results land inside it.
- `--max-cost-usd <n>` stops launching new runs once the ceiling is reached.
- Do not run it beside other heavy jobs on the same machine.

## Results so far

- 2026-11-11, plugin 0.7.2, Claude Code 2.1.322, `--tag routing --runs 1 --model opus`:
  6 of 6 cases passed, the right skill fired in all four routing cases, no
  skill fired in the two guard cases. 12 agent runs, 252 s, $1.28. One run per
  arm, so this shows the suite works and gives no rate.

- 2026-11-11, same versions, `--tag behaviour --runs 1 --model opus --scaffold`:
  4 agent runs, 418 s, $2.03.
  - `delegates-pin-model`: passed. Both `Agent` calls carried `model: opus` and
    `effort: high`.
  - `plan-first`: **failed** with the plugin. The skill fired and the lead read
    the project, then called `Write` four times without showing a plan or
    asking for approval. The calls were refused only because the run grants no
    `Write`. One run, so it is a lead to follow up, not a rate. The case had no
    grader for a direct edit at that point; `no-write-before-approval` and
    `no-edit-before-approval` were added after this run.

- 2026-11-11, plugin 0.7.2, `--case plan-first --runs 3 --scaffold`, on
  `--model opus` ($4.25) and on `--model fable` ($6.62): with the plugin, 0 of
  6 runs showed a plan or asked for approval. The lead dispatched agents at
  once (every call carried a model), and in some runs also tried to write
  files itself. With the first run that is 0 of 7.
- 2026-11-11, plugin 0.7.3 (the "Stop after the plan" rule), same case,
  `--runs 3 --ablation none`: 3 of 3 on `opus` ($0.64) and 3 of 3 on `fable`
  ($1.33). Each run ended on a plan with an executor and stakes per task and
  no agent, write or edit. `delegates-pin-model` on `opus`, `--runs 2`: 2 of 2
  ($1.20), so an approved plan still executes without a second stop.

- 2026-11-11, plugin 0.7.3, `--runs 3 -j 2 --model opus`, all ten routing
  cases ($6.05) and `loop-no-silent-bootstrap` ($2.02):
  - The five `route-*` cases: the right skill fired, and no other, in 15 of 15
    runs with the plugin.
  - The five `skip-*` cases: no skill fired in 15 of 15 runs with the plugin.
  - `loop-no-silent-bootstrap`: 3 of 3. The loop created nothing and
    dispatched nothing, and named the missing spine. Without the plugin 0 of 3.
  - One `skip-debug` run failed its `llm` grader although the answer was a
    direct diagnosis: the rubric asked for one cause and the reply listed
    several. The rubric was loosened and the case re-run: 3 of 3 ($0.47).

- 2026-11-11, plugin 0.8.0, `--case plan-file --runs 1 --ablation none --model opus --scaffold`:
  three single runs while the case and the script were adjusted ($3.10).
  With `--allow-tools "Bash(node *)"` the lead's first `create` used a heredoc
  and was denied (the script then gained `--json`); with the same grant and an
  unrelated denied `git` call the lead skipped the plan file; with
  `--allow-tools Bash` it called `create --json` with a valid draft, and the
  call failed because git does not run in the eval sandbox. All five `Agent`
  calls carried a model in every run.
- 2026-11-11, same plugin, one live headless run outside the eval sandbox
  (`claude -p --plugin-dir . --model opus` in a scratch git repository, same
  prompt, $2.00): the plan file was created with six tasks, each task was
  marked `running` and then `done`, and the run ended with every task `done`.
  The lead never called `next`; it marked the tasks in dependency order, which
  `mark` enforces.

- 2026-11-11, plugin 0.8.3, one run each on `opus`, `--ablation none`:
  `plan-first` passed and its plan ended with a `Done when:` line
  ($0.23); `loop-no-silent-bootstrap` passed with `disallowed-tools:
  AskUserQuestion` in the loop skill's frontmatter ($0.32). The
  `done-when` grader was added after that run.

Eval runs are non-interactive. A lead may behave differently when a user is
there to answer, so these numbers describe `claude -p`, not a live session.

## Limits

- The guard cases pass without the plugin too, so their difference is zero by
  design. They exist to catch a description that starts firing too widely.
- `Workflow` is not documented for eval runs, so panels, fan-outs and research
  lanes are not covered here.
- `Bash`, `Write` and `Edit` are not granted, so `tech-lead:quick` is checked
  for routing only, not for the branch and the PR it opens.
