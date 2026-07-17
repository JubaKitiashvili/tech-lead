# Loop State Templates

Canonical formats for the `.tech-lead/` state spine. Bootstrap copies these;
every other part of the loop reads/writes them. Do not restate these formats
elsewhere — link here.

## LOOP.md template

Replace `<...>` values during bootstrap. `verify:` commands are detected from
package.json scripts / Makefile and confirmed with the user.

```yaml
---
pattern: backlog-executor
level: 1                 # 1 report-only | 2 mechanical-only | 3 full execution
paused: false            # any runner must exit immediately when true
max_iterations_per_day: 8
max_consecutive_failures: 2
branch_prefix: tech-lead-loop   # commits land on <prefix>/<YYYY-MM-DD>
verify:
  - <detected verify command, e.g. npm test>
  - <detected verify command, e.g. npm run typecheck>
scope:
  - ./
push: never              # literal; v1 has no other value
---
```

## STATE.md template

All six sections are always present, even when empty. Human-editable:
the user may reorder, add, or veto items directly.

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

Backlog item fields: `class:` ∈ `mechanical | hard | high-stakes | unclassified`;
`status:` ∈ `— | waiting-decision | waiting-level`; `blocked-by:` names another
item or `—`.

`## Done` item format: `- [x] <title> · <sha> · <YYYY-MM-DD>` (`—` in the
sha slot when `commits: []`).
`## Blocked` item format: `- [ ] <title> · attempts: <n> · <one-line reason>`.

`## Needs decision` entry format:

```markdown
### <task title>
**Recommendation:** <one-sentence synthesis>
**Seat A (deep-reasoner):** <one line>
**Seat B (Codex):** <one line, or "seat empty — Codex unavailable">
**Decision:** (fill in to release the task back to the backlog)
```

## LEDGER.jsonl entry schema

One JSON object per line, appended every firing without exception:

```json
{"ts": "<ISO-8601 UTC>", "iteration": <int>, "task": "<title or null>",
 "class": "<class or null>", "delegate": "<agent or null>",
 "outcome": "<done|failed|blocked|skipped|report-only|needs-decision|halted>",
 "verify": "<pass|fail|null>", "commits": ["<sha>"], "notes": "<one line>"}
```

`iteration` is the previous entry's iteration + 1 (1 when the file is empty).
`delegate` for panel firings (the `high-stakes` path running both seats) is
the literal string `"panel"`. The circuit breaker reads consecutive `failed`
outcomes; the daily budget counts entries whose `ts` date is today in UTC.

## Project .gitignore addition (bootstrap)

```
.tech-lead/worktree/
```
