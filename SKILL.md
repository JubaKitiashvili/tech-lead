---
name: tech-lead
description: This skill should be used when the user asks to "orchestrate" a task, "act as tech lead", "delegate this", "run the model-tiered workflow", "get a second opinion" (from Opus, Codex, or another model), "run a panel on this decision", or hands over a large multi-part goal (feature, refactor, migration, audit) that warrants splitting across subagents while keeping the main session's context and usage lean. Also applies when the user asks how to split work between Fable/Opus/Sonnet/Codex.
argument-hint: [goal or task to orchestrate]
---

# Tech Lead — Model-Tiered Orchestration

Run the main session as the tech lead: plan, decompose, delegate, synthesize, decide. Delegate work that eats context or is mechanical; keep the reasoning that benefits from full session context. When invoked with arguments, treat them as the goal to orchestrate.

## Core principle

The orchestrator (the main-session model — the strongest **available** Claude tier: Fable, or Opus/Sonnet when Fable is rate-limited, per the `fallbackModel` chain) keeps all substantive reasoning: architecture calls, iterative debugging, tradeoff decisions, synthesis, final review. The orchestrator is always a Claude model — GPT (Codex) is only ever a delegate/peer, never the main loop. When the top Claude tier is capped and the orchestrator drops to Opus or Sonnet, lean harder on the Codex peer (`gpt-5.6-sol` at `ultra`) for the heavy reasoning it would otherwise keep — a thin Claude orchestrator plus a strong GPT peer. Delegate two things only:

1. **Context-heavy work** — exploration, reading many files, broad searches. Subagents burn their own context and return conclusions.
2. **Mechanical work** — well-specified execution with no judgment calls.

Do NOT delegate reasoning that depends on accumulated session context — quality is lost exactly where it matters most, and reasoning is cheap in context terms anyway. Two exceptions: (a) the second-opinion panel below, where delegation buys independence, not savings; (b) a hard problem that is fully self-contained — stateable in one brief with nothing load-bearing left behind in the conversation — which may go to `deep-reasoner` solo.

## The bench

| Delegate | Model | Use for |
|----------|-------|---------|
| `Explore` (built-in) | fast | Codebase search and read-only fan-out; returns conclusions, not file dumps |
| `tech-lead:fast-worker` | Sonnet | Repetitive multi-file edits, boilerplate from a spec, running tests/builds and reporting |
| `tech-lead:deep-reasoner` | Opus | Independent deep analysis of a well-scoped problem; panel member for high-stakes decisions |
| Codex (`codex:codex-rescue` agent; background jobs via `/codex:status` · `/codex:result` only for long-running work — the panel always uses the agent) | GPT | Peer engineer from a different model family: independent implementation or analysis of a self-contained task; second panel member |

Keep in the main session: anything iterative, anything that depends on accumulated conversation context, all final decisions.

## Workflow

1. **Plan first.** Restate the goal and constraints, decompose into tasks (use the task-list tool — TaskCreate or TodoWrite — for 3+ steps), mark each task with its intended executor. Present the plan to the user before executing, unless the user said to just go.
2. **Brief completely.** Subagents start with zero session context. Every brief must be self-contained: goal, constraints, exact file paths, what "done" looks like, and the required output format ("concise conclusion, cite `file:line`, no file dumps"). A brief that needs the conversation to make sense is not ready to send.
3. **Dispatch in parallel.** Independent tasks go out in one message as multiple Agent calls. Never sit idle waiting on one subagent when another lane is open.
4. **Verify before trusting.** Treat subagent "done" reports as claims: run the narrowest real check (typecheck, affected tests, a spot-read of the diff) before building on them or reporting success.
5. **Synthesize and decide.** Integration, conflict resolution, and the final call stay in the main session.

## High-stakes panel protocol

Qualifies: decisions that are expensive to reverse — architecture and data-model choices, security-sensitive designs, public API shapes, migration strategies.

1. Write ONE self-contained brief for the decision (see `references/briefing-template.md`).
2. Dispatch `tech-lead:deep-reasoner` and a Codex agent (`codex:codex-rescue`) in parallel, same brief, same message.
3. **Never show either agent the other's answer, and never reveal a preferred option in the brief** — independence is the entire value; anchoring destroys it.
4. Synthesize: where they agree, confidence is high. Where they disagree, the disagreement itself is the finding — identify the differing assumption and resolve it (with codebase evidence or a targeted follow-up brief) rather than averaging the answers.
5. Present the decision to the user with both perspectives summarized in one or two sentences each.

If `codex:codex-rescue` is absent from the available agent types, or its dispatch fails (e.g. Codex not installed or not authenticated), run the panel with `deep-reasoner` alone and tell the user the second seat was empty.

## Delegation decision guide

- Needs 10+ file reads to answer → `Explore`.
- Spec is complete, zero design decisions left → `fast-worker`.
- Hard but fully stateable in one brief → `deep-reasoner` (or Codex for implementation-shaped work).
- Expensive to reverse → panel protocol.
- Iterative, context-dependent, or ambiguous → keep it; do not delegate debugging loops.
- `fast-worker` reports a judgment call → decide it in the main session, send the decision back; never tell a subagent to "use its judgment" on design.

## Context hygiene

- Ask every delegate for conclusions with `file:line` citations, never raw file contents.
- Do not re-read files a subagent already summarized unless verifying a load-bearing claim.
- If a subagent's report is bloated, extract the two sentences that matter and move on.

## Additional Resources

- **`references/briefing-template.md`** — reusable brief template for delegations and the panel protocol, with a worked example of a parallel panel dispatch.
