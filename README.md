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

## What's inside

- `SKILL.md` — the orchestration workflow: delegation rules, high-stakes panel protocol, briefing discipline, context hygiene.
- `agents/deep-reasoner.md` — Opus-pinned, read-only analysis agent.
- `agents/fast-worker.md` — Sonnet-pinned execution agent (stops and reports back on any judgment call instead of guessing).
- `references/briefing-template.md` — reusable brief template and parallel panel dispatch example.
