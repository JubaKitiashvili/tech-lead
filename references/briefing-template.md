# Briefing Template

Subagents start with zero conversation context. The exception is
`subagent_type: "fork"`, which inherits it; never use a fork where
independence matters. A brief is ready to send only when it answers every
section below without referring to "the discussion above".

## Template

```
GOAL
One or two sentences: the exact question to answer or task to complete.

CONTEXT
- Project: <what the codebase is, stack, entry points relevant to the task>
- Relevant files: <exact absolute paths, with one line on why each matters>
- Established facts: <anything already verified this session that the agent must not re-derive>

CONSTRAINTS
- <hard requirements: compatibility, performance, style, deadlines>
- <explicit non-goals: what NOT to touch or redesign>

OPTIONS                      (panel briefs only)
- <stable-id>: <one-line description>     (no ordering hint, no favourite)

DONE MEANS
- <acceptance criteria>
- <verification command(s) to run: only for delegates that have Bash
  (fast-worker, Codex); deep-reasoner is read-only>

OUTPUT FORMAT
Concise report for an orchestrator, not a human, at most 40 lines:
- verdict or recommendation first;
- evidence as 3-5 decisive points: file:line, or a command and its result;
- files changed, as absolute paths;
- decisions the brief did not settle, returned as questions, not made.
No file dumps. Long verbatim material (logs, diffs, listings) goes to a file
at <absolute scratch path>, and the report gives the path.
```

**Two substitutions:**

- **`fast-worker` briefs.** Replace OUTPUT FORMAT with its execution-report
  shape: done / files touched / verification result / skipped and flagged /
  judgment calls. State the working directory as an absolute path.
- **Workflow dispatches with a `schema`.** Drop OUTPUT FORMAT entirely; the
  schema is the contract. Keep only the citation rule: `file:line`, no dumps.

## Panel dispatch

For panel dispatch (both the Workflow and the Agent forms), empty-seat
detection, and Codex follow-ups, see `panel-protocol.md` §2–§5. Write the
brief to a file first, and pass its absolute path.

## Brief anti-patterns

- **Brief by pointer.** "Fix the bug we discussed": the agent has no idea
  what was discussed.
- **Leaky panel.** Including "we're leaning toward X" in a panel brief makes
  both seats anchor on X.
- **Relative paths.** Subagent shell cwd resets between calls, so relative
  paths and bare `git` land in the wrong tree. Use absolute paths.
