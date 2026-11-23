# Live loop evals

`claude plugin eval` (see `../evals/README.md`) cannot run git in its sandbox,
and `/tech-lead:loop` does most of its work through git. So the cases under
`evals/` only measure that the loop is routed to and that it does not bootstrap
silently. These scenarios measure the rest: one real firing of the loop in a
scratch repository, graded from what it left on disk.

Every run is a real, paid model session, started with `claude -p` and
`--permission-mode bypassPermissions` in a scratch repository. Nothing here
runs in `scripts/check.mjs`, in the test suite or in CI.
`tests/live-evals.test.mjs` tests the fixtures and the grader without a model.

## Scenarios

| Scenario | Starts from | A correct firing |
|----------|-------------|------------------|
| `paused` | `paused: true` | records `halted` and touches nothing else |
| `dry` | an empty backlog | records `skipped` and says the backlog is dry |
| `report-only-l1` | level 1, one mechanical item | dispatches nothing, writes the would-do plan, returns the item to the backlog |
| `stale-now` | level 1, the item left in `## Now` by an interrupted firing | puts the item back once, then handles it as `report-only-l1` |
| `mechanical-l2` | level 2, one mechanical item | sends it to `fast-worker` in the clone, verifies, commits there, moves the item to `## Done` |

Every scenario also checks what holds for any firing: exactly one ledger
entry, the lock released with no child record left, one dispatch record per
`Agent` or `Workflow` call and each one closed, `## Now` back to `(empty)`,
a `STATE.md` the parser reads without a problem, no push and no PR, no
question asked, and no change to the project outside `.tech-lead/`: the same
`HEAD`, the same refs, a clean tree.

`mechanical-l2` checks the commit itself: it is on `tech-lead-loop/<date>` in
the clone, carries the `Tech-Lead-Item` and `Tech-Lead-Generation` trailers
and no Co-Authored-By line, touches only `src/` and `test/`, has a delivery
bundle, and its tree passes the project's tests and a probe of the new
function.

## Running

```bash
node live-evals/run.mjs --list
node live-evals/run.mjs paused --model opus --budget 2 --out ~/tech-lead-live-runs
node live-evals/run.mjs --grade <run directory> paused     # grade an earlier run again
```

- `--model` is the session model (default `opus`). `--budget` is the session's
  `--max-budget-usd` (default 4).
- `--out` is where the run directory is made (default: the system temp
  directory). It must be outside the plugin. The run directory holds `repo/`
  (the project), `cache/` (the loop's work area, through `TECH_LEAD_CACHE`),
  `stream.jsonl`, `before.json` and `result.json`.
- The exit code is 0 when every check passed, 1 when one failed, 2 on a usage
  error.
- Run one at a time, and not beside other heavy jobs on the same machine.

The session loads your own settings, plugins and `CLAUDE.md` beside the plugin
under test. If another copy of tech-lead is installed, the check
`helpers-from-this-plugin` fails when the firing ran that copy's scripts.

## Limits

- One run per scenario shows that the path works once. It gives no rate.
- Not covered: a failed attempt and the retry, a delegate-flagged item, the
  panel, the triage check (the fixtures set `triage: off`), Codex at level 3,
  two firings racing for the lock, and a firing interrupted mid-run.
- The runs are headless. A `/loop` or cron runner in a live session may behave
  differently.

## Results so far

- 2026-11-23, plugin 0.9.4, Claude Code 2.1.329, `--model opus`, one run per
  scenario: all five passed every check. `paused` 19 of 19 ($0.71, 38 s),
  `dry` 18 of 18 ($0.84, 59 s), `report-only-l1` 21 of 21 ($0.98, 78 s),
  `stale-now` 18 of 18 ($1.20, 120 s), `mechanical-l2` 20 of 20 ($1.42,
  144 s). $5.15 in all. In `mechanical-l2` the `fast-worker` ran on Sonnet,
  and the loop committed its work in the clone with both trailers.
