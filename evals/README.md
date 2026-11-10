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
| `skip-question` | routing, guard | A plain question invokes no tech-lead skill |
| `skip-single-edit` | routing, guard | A one-line fix invokes no tech-lead skill |
| `plan-first` | behaviour | The plan names a model per task and nothing is dispatched before approval |
| `delegates-pin-model` | behaviour, costly | After approval, every `Agent` call carries a model |

The routing cases grant only `Skill`, `Read`, `Glob` and `Grep`, so a skill
that fires cannot dispatch agents; they measure the skill descriptions, not the
work. A run loads only this plugin: the user's `CLAUDE.md` and rule files are
absent, so the routing rule in `~/.claude/rules/tech-lead.md` plays no part.

## Running

Each case runs `runs` times with the plugin and the same number without it
(default 3 + 3). Eight cases at the default are about 48 agent runs plus judge
calls. Start small:

```bash
# cheapest pass: routing only, one run per arm (12 agent runs)
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

## Limits

- The guard cases pass without the plugin too, so their difference is zero by
  design. They exist to catch a description that starts firing too widely.
- `Workflow` is not documented for eval runs, so panels, fan-outs and research
  lanes are not covered here.
- `Bash`, `Write` and `Edit` are not granted, so `tech-lead:quick` is checked
  for routing only, not for the branch and the PR it opens.
