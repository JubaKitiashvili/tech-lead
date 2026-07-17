# tech-lead

Model-tiered orchestration plugin for Claude Code. The main session (your strongest model — Fable/Opus) stays the tech lead: it plans, reasons, synthesizes, and decides. Cheaper or differently-skilled delegates do the work that would waste its context or usage:

| Delegate | Model | Role |
|----------|-------|------|
| `Explore` (built-in) | fast | Codebase search fan-out; conclusions, not file dumps |
| `tech-lead:fast-worker` | Sonnet | Mechanical execution: repetitive edits, boilerplate, test runs |
| `tech-lead:deep-reasoner` | Opus | Independent deep analysis of well-scoped problems; panel seat |
| Codex (`codex:codex-rescue`) | GPT | Peer engineer from a different model family; second panel seat |

The key idea (and where this differs from the popular "Opus as deep-reasoner" recipe): **reasoning stays with the orchestrator** — it is cheap in context terms and is exactly where the strongest model earns its keep. What gets delegated is context-heavy exploration and mechanical work. Opus and Codex are used as an **independent second-opinion panel** on high-stakes decisions: same brief, dispatched in parallel, neither sees the other's answer, the orchestrator synthesizes.

## Install

Personal (this machine): the plugin lives in `~/.claude/skills/tech-lead/` and auto-loads as `tech-lead@skills-dir`.

Team distribution: copy this directory into a git repo, then:

```
/plugin marketplace add <org>/<repo>
/plugin install tech-lead@<marketplace-name>
```

**Optional but recommended:** the OpenAI Codex plugin for the second panel seat (`/plugin marketplace add openai/codex-plugin-cc`, `/plugin install codex@openai-codex`, `/codex:setup`). Without it, panels run with `deep-reasoner` alone.

## Usage

Explicit invocation:

```
/tech-lead Goal: migrate our REST layer to tRPC. Context: apps/api, packages/client. You're the lead — plan first, then execute.
```

It also triggers automatically on phrases like "act as tech lead", "orchestrate this", "get a second opinion", "run a panel on this decision", or when handing over a large multi-part goal.

## Loop mode

`/tech-lead:loop [project-path]` runs ONE iteration of a backlog-executor
loop driven entirely by a per-project `.tech-lead/` state spine (`LOOP.md`
config, `STATE.md` backlog, `LEDGER.jsonl` run log). Because all memory is
on disk, the same skill runs three ways:

- in-session: `/loop /tech-lead:loop` (self-paced, stops when the backlog is dry)
- daily cron: a scheduled session with the prompt `Run /tech-lead:loop <path>`
- manual: invoke it whenever you want one iteration

Safety: maturity ladder (L1 report-only → L2 mechanical-only → L3 full,
L3 manual-only), circuit breaker on consecutive failures, daily iteration
budget, `paused: true` kill switch, commits only on a `tech-lead-loop/<date>`
branch inside a dedicated worktree — never on your working tree, never pushed.
High-stakes items always stop at a human decision gate in `STATE.md`.

First run on a project bootstraps the spine interactively.
Methodology credit: [loop-engineering](https://github.com/cobusgreyling/loop-engineering).

## What's inside

- `SKILL.md` — the orchestration workflow: delegation rules, high-stakes panel protocol, briefing discipline, context hygiene.
- `agents/deep-reasoner.md` — Opus-pinned, read-only analysis agent.
- `agents/fast-worker.md` — Sonnet-pinned execution agent (stops and reports back on any judgment call instead of guessing).
- `references/briefing-template.md` — reusable brief template and parallel panel dispatch example.
- `skills/loop/SKILL.md` — the loop iteration skill (backlog executor).
- `skills/loop/references/loop-templates.md` — canonical state spine templates.
