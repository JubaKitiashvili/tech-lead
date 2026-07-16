# Briefing Template

Subagents start with zero conversation context. A brief is ready to send only when it answers every section below without referencing "the discussion above".

## Template

```
GOAL
One or two sentences: the exact question to answer or task to complete.

CONTEXT
- Project: <what the codebase is, stack, entry points relevant to the task>
- Relevant files: <exact paths, with one line on why each matters>
- Established facts: <anything already verified this session the agent must not re-derive>

CONSTRAINTS
- <hard requirements: compatibility, performance, style, deadlines>
- <explicit non-goals: what NOT to touch or redesign>

DONE MEANS
- <acceptance criteria; verification command(s) to run — only for delegates
  that have Bash (fast-worker, Codex); deep-reasoner is read-only>

OUTPUT FORMAT
Concise report for an orchestrator, not a human:
recommendation/summary first, reasoning as 3-5 decisive points,
cite code as file:line, no file dumps, under ~400 words.
```

For `fast-worker` briefs, replace OUTPUT FORMAT with its execution-report shape: done / files touched / verification result / skipped-and-flagged.

## Panel dispatch example

One brief, two independent seats, one message. The brief must not hint at a preferred option.

```
Agent(subagent_type: "tech-lead:deep-reasoner",
      description: "Panel seat A: storage decision",
      prompt: <BRIEF>)
Agent(subagent_type: "codex:codex-rescue",
      description: "Panel seat B: storage decision",
      prompt: <BRIEF>)
```

Both calls go in the same message so they run concurrently. When both return, synthesize per the panel protocol in SKILL.md — never average the answers, and never forward one seat's output to the other for "rebuttal"; that reintroduces anchoring.

## Brief anti-patterns

- **Brief by pointer:** "fix the bug we discussed" — the agent has no idea what was discussed.
- **Leaky panel:** including "we're leaning toward X" in a panel brief — both seats will anchor on X.
