# tech-lead

A model-tiered orchestration plugin for Claude Code. The main session (Opus
5.5, falling back to Sonnet 5) stays the tech lead: it plans, reasons,
synthesizes, and decides. Cheaper delegates, or delegates with different
skills, do the work that would waste its context or usage.

| Delegate | Model | Role |
|----------|-------|------|
| `Explore` (built-in) | Pass `model: "sonnet"` or `"haiku"`; otherwise it inherits Opus | Codebase search fan-out; returns conclusions, not file dumps |
| `tech-lead:fast-worker` | Sonnet 5 | Mechanical execution: repetitive edits, boilerplate, test runs |
| `tech-lead:deep-reasoner` | Opus 5.5, fresh context | Independent deep analysis; panel seat A |
| `tech-lead:triage` | Haiku 4.5, Read-only; runs only via the `tech-lead:triage` workflow | The loop's escalate-only second check on classification |
| Codex (`codex:codex-rescue`) | GPT; model and effort come from `~/.codex/config.toml` | Peer engineer from another model family; panel seat B |

The key idea: **reasoning stays with the orchestrator.** Reasoning is cheap in
context terms, and it is exactly where the strongest model earns its keep.
What gets delegated is context-heavy exploration and mechanical work.

For high-stakes decisions, a fresh-context Opus seat and Codex act as an
**independent second-opinion panel**:

- both seats get the same brief file and are dispatched in parallel;
- neither sees the other's answer, and the options are shown to them in
  opposite orders;
- agreement is computed in code, and the orchestrator synthesizes the result.

The seats' independence comes from their fresh context and from Codex being a
different model family, not from a different Claude tier.

## Skills

| Command | What it does |
|---------|--------------|
| `/tech-lead <goal>` | Orchestrate a multi-part goal: plan, delegate, verify, and decide |
| `/tech-lead:quick <task>` | The Direct lane: implement it yourself, verify it (plus an argent UI check when a device is running), then open a `feature/<slug>` branch, a commit, and a **draft PR**. It pushes only when you typed the command or asked for a PR. It escalates to `/tech-lead` for high-stakes or large work |
| `/tech-lead:panel <decision>` | Run one expensive-to-reverse decision through the two-seat panel |
| `/tech-lead:research <subject>` | Multi-lane research (primary source, ecosystem, alternatives, fit), with an adversarial fact-check of every lane against primary sources |
| `/tech-lead:loop [path]` | One iteration of the backlog-executor loop (see below) |

**Task-type routing (0.3.1).** The skill descriptions trigger on the task type (a multi-part goal, one expensive-to-reverse decision, vetting an external dependency, a small change shipped as a PR, a backlog run), not only on exact phrases; for always-on routing with a do-not-route list and recursion safety (only the top-level session routes), pair them with a user rule such as `~/.claude/rules/tech-lead.md`.

## Workflow mode

When Workflow is opted in, the plugin runs its own Workflow scripts instead
of hand-dispatched Agent calls. Workflow is opted in when any of these holds:

- ultracode is on;
- you ask for a workflow;
- you type a `/tech-lead…` command.

The scripts, in `workflows/`:

- `panel.js`: two seats with typed verdicts, agreement computed in code, and
  empty-seat detection. If Opus fails, seat A retries on Sonnet.
- `fanout.js`: parallel `fast-worker`s with JSON-schema execution reports,
  plus code checks for scope and judgment calls.
- `research.js`: research lanes, each followed by its own fact-checker.
- `triage.js`: the loop's Haiku triage verdict under an enforced schema, with
  the escalate-only policy computed in code.

The plugin registers these at session start as `tech-lead:<name>`, and
skills call them by name. After updating the plugin, restart the session so
new workflows register.

Git, human gates, spine writes, and the final verify always stay in the main
session.

## The reflex layer (our own "System 1")

`references/decision-contracts.md` defines the reflex layer. These are small,
typed, categorical decisions:

- **Escalate-only.** Nothing automated lowers a class, tier, or level.
- **Deterministic gates.** Checks like `git status`, `verify:` and the scope
  rail decide; model verdicts only advise.
- **Shadow before gate.** A new check is logged before it is ever applied.
- **Calibration from the loop ledger.** The owner reviews logged decisions
  before switching a check on.

This is inspired by the typed-decision pattern of TypeSafe's
[Jev](https://docs.typesafe.ai) and the open-source
[Laya](https://github.com/NandhaKishorM/laya), and borrows their ecosystem's
asymmetric-routing and shadow-mode practices. It has no dependency on
either: in this setting, a JSON-schema `agent()` call on Haiku is the typed
decision primitive. Laya's zero-shot accuracy was near chance and needed
torch; Jev is closed and needs an API key.

## Install

Personal (this machine): the plugin lives in `~/.claude/skills/tech-lead/` and
auto-loads as `tech-lead@skills-dir`.

Team distribution: copy this directory into a git repo, then run:

```
/plugin marketplace add <org>/<repo>
/plugin install tech-lead@<marketplace-name>
```

**Optional but recommended:** the OpenAI Codex plugin, for the second panel
seat:

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup
```

Without it, panels run with seat A alone.

Tested with Codex plugin 1.0.6 and Codex CLI 0.156.1. The rescue wrapper is
write-capable by default, so tech-lead always sends panel briefs as read-only
with `--wait`.

## Loop mode

`/tech-lead:loop [project-path]` runs ONE iteration of a backlog-executor
loop. The loop is driven entirely by a per-project `.tech-lead/` state spine:

- `LOOP.md`: config;
- `STATE.md`: the backlog;
- `LEDGER.jsonl`: the run log;
- `briefs/`: panel briefs.

Because all memory is on disk, the loop runs as:

- **in-session:** `/loop /tech-lead:loop` (self-paced; stops when the backlog
  is dry);
- **scheduled:** a durable `CronCreate` in a dedicated project session, or OS
  cron / launchd running `cd <abs-path> && claude -p 'Run /tech-lead:loop <abs-path>'`. Cloud
  routines are not supported;
- **manual:** invoke it whenever you want one iteration.

**Safety:**

- **Maturity ladder.** L1 report-only → L2 mechanical-only → L3 full. Only a
  human can set L3.
- **Brakes.** A circuit breaker on consecutive failures, a daily iteration
  budget (only work outcomes count), and a `paused: true` kill switch.
- **Commits.** Commits land only on a `tech-lead-loop/<date>` branch inside a
  dedicated worktree. They never touch your working tree and are never
  pushed.
- **Human gates.** High-stakes items and delegate judgment calls always stop at a
  human decision gate (`## Needs decision`). Infra incidents park the item or
  pause the loop; they never retry in a loop.
- **Triage.** It runs in `shadow` mode by default.

The first run on a project bootstraps the spine interactively. Methodology
credit: [loop-engineering](https://github.com/cobusgreyling/loop-engineering).

## What's inside

- `SKILL.md`: the orchestration process, delegation rules, Workflow mode,
  the panel protocol, and the reflex rules.
- `agents/`: `deep-reasoner.md` (Opus, read-only), `fast-worker.md` (Sonnet;
  stops on judgment calls), `triage.md` (Haiku, Read-only, schema-enforced via workflow).
- `workflows/`: `panel.js`, `fanout.js`, `research.js`, `triage.js`. Registered at session start as `tech-lead:<name>`; invoke by `name`.
- `references/`: `briefing-template.md` (the brief template),
  `panel-protocol.md` (the panel, dispatch forms, and empty-seat and Codex
  follow-up rules), and `decision-contracts.md` (reflex rules and JSON
  contracts).
- `skills/loop/references/`: `loop-templates.md`, `worktree.md` (the shared
  worktree preparation and delegate execution contract), and
  `bootstrap.md`.
- `skills/`: `quick/`, `panel/`, `research/`, and `loop/`, whose
  `references/loop-templates.md` holds the state spine formats.
