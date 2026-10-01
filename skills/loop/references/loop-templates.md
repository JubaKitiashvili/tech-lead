# Loop State Templates

These are the canonical formats for the `.tech-lead/` state spine. Bootstrap
copies them, and every other part of the loop reads and writes them. Do not
restate these formats elsewhere; link here.

## LOOP.md template

Replace the `<...>` values during bootstrap. The `verify:` commands are
detected from package.json scripts or the Makefile, then confirmed with the
user.

```yaml
---
pattern: backlog-executor
level: 1                 # 1 report-only | 2 mechanical-only | 3 full execution
paused: false            # any runner must exit immediately when true
max_iterations_per_day: 8
max_consecutive_failures: 2
branch_prefix: tech-lead-loop   # commits land on <prefix>/<YYYY-MM-DD>
triage: shadow           # off | shadow (log the Haiku second check) | gate (apply it, escalate-only)
codex_timeout_min: 45    # an L3 Codex job still running after this many minutes is stopped
verify:
  - <detected verify command, e.g. npm test>
  - <detected verify command, e.g. npm run typecheck>
scope:
  - ./
push: never              # literal; v1 has no other value
---
```

A missing `triage:` key means `shadow`. Move to `gate` only after reviewing
at least 20 logged triage rows (see `../../../references/decision-contracts.md`,
Calibration). A missing `codex_timeout_min:` key means 45.

## STATE.md template

All six sections are always present, even when empty. The file is
human-editable: the user may reorder, add, or veto items directly.

```markdown
# <Project Name> — Loop State

## Now
(empty)

## Backlog
- [ ] P1 · <task title> · class: unclassified
  - blocked-by: —
  - status: —
  - notes: <one line of context>

## Needs decision
(empty)

## Blocked
(empty)

## Done
(empty)

## Last run
(never run)
```

**Backlog item fields:**

- `class:` ∈ `mechanical | hard | high-stakes | unclassified`. §4 appends a
  one-line reason after the class.
- `status:` ∈ `— | waiting-decision | waiting-level | waiting-infra`.
  - `waiting-infra` parks an item after an infra incident, such as Codex being
    unavailable. A human clears it.
- `blocked-by:` names another item, or is `—`.

**`## Done` item format:** `- [x] <title> · <sha> · <YYYY-MM-DD>`. Use `—` in
the sha slot when `commits: []`. The list is ordered newest-first: prepend
each completion above the previous one, so the "trim to 20 most recent" step
drops from the bottom.

**`## Blocked` item format:**
`- [ ] <title> · attempts: <n> · <one-line reason>`.

**`## Needs decision` entry format:**

```markdown
### <task title>
**Recommendation:** <one-sentence synthesis>
**Seat A (deep-reasoner · <opus|sonnet[, fallback]>):** <one line>
**Seat B (Codex · <model from ~/.codex/config.toml>):** <one line, or "seat empty — <unavailable | empty output | backgrounded | error>">
**Agreement:** <agree | disagree | single-seat | no-seats> — agreement is corroboration, not proof
**Decision:** (fill in to release the task back to the backlog)
```

A delegate-flagged entry (loop §6) uses the same heading and `Decision:`
line, with these fields:

```markdown
### <task title>
**Flagged by:** <fast-worker | codex> — the delegate stopped on a judgment call
**Questions:** <each question> — suggested default: <delegate's default>
**Decision:** (fill in to release the task back to the backlog)
```

A warning line is added to the entry when the project tree changed during a
panel (loop §5):
`**WARNING:** project content changed during the panel — check before unpausing.`

Panel and Codex briefs live in `.tech-lead/briefs/<slug>.md`. The
dependency marker is `.tech-lead/worktree-deps.ok`. Both are gitignored at
bootstrap, and the loop never commits them.

## LEDGER.jsonl entry schema

Append one JSON object per line, every firing, without exception:

```json
{"ts": "<ISO-8601 UTC>", "iteration": <int>, "task": "<title or null>",
 "class": "<final class or null>", "delegate": "<agent or null>",
 "outcome": "<done|failed|blocked|flagged|skipped|report-only|needs-decision|halted>",
 "verify": "<pass|fail|null>", "commits": ["<sha>"], "notes": "<one line>",
 "reason": "<one-line class/route reason or null>",
 "models": {"delegate": "<sonnet|opus|haiku|codex|null>"},
 "triage": {"mode": "<off|shadow|gate>", "orchestrator": "<class>", "checker": "<class|null>",
            "derived": "<class|null>", "signals": {…}, "checker_reason": "<string|null>",
            "agreement": "<agree|escalated|checker-lower|no-verdict>", "final": "<class>"},
 "panel": {"seat_a": "<opus|sonnet|null>", "seat_b": "<codex|empty>", "agreement": "<agree|disagree|single-seat|no-seats>"},
 "workflow_run_id": "<runId or null>"}
```

**Field rules:**

- `reason`, `models`, `triage`, `panel` and `workflow_run_id` are null or
  absent when they do not apply. Older entries without them remain valid.
- `iteration` is the previous entry's iteration + 1, or 1 when the file is
  empty.
- `delegate` is the literal string `"panel"` for panel firings (the
  `high-stakes` path that runs both seats).
- `triage.agreement` values:

  | Value | Meaning |
  |---|---|
  | `agree` | the checker's class equals the orchestrator's |
  | `escalated` | the checker's class is higher |
  | `checker-lower` | the checker's class is lower (never applied) |
  | `no-verdict` | the checker's output was missing or did not parse |

- **Circuit breaker.** It reads consecutive `failed` outcomes. `flagged` is
  not a failure.
- **Daily budget.** It counts today's entries (by `ts` date, UTC) whose
  outcome is `done`, `failed`, `blocked`, `flagged`, `report-only` or
  `needs-decision`. `halted` and `skipped` do not count.
- **Infra incidents** never retry in a loop. A missing Codex parks the item
  (`waiting-infra`). A dependency-install failure, or a Codex turn that
  cannot be confirmed stopped, sets `paused: true`.

## Project .gitignore addition (bootstrap)

```
.tech-lead/worktree/
.tech-lead/briefs/
.tech-lead/worktree-deps.ok
```
