# Models and effort: sources, measurements and history

`SKILL.md` → *Models and effort* holds the rules. This file holds what is
behind them: Anthropic's wording, the measurements, and the history. Read it
when a rule needs its reason, or when a new model ships and the rules need a
re-check.

This section was checked against Anthropic's docs on 2026-11-10, for Claude
Code 2.1.321 on the Anthropic API.

**Use aliases, not model IDs.** Agent frontmatter and `agent()` calls name
`opus`, `sonnet` or `haiku`. Today these resolve to Opus 5.5, Sonnet 5.5 and
Haiku 5.5 (`haiku` moved in Claude Code v2.1.293). Never name `fable` in an
agent or workflow (see "Fable leads at most" below). Avoid `best` too: it is the
same as `opus` since v2.1.321 and pointed at Fable before that, so it has
already changed meaning once. Aliases move with new releases. Off the
Anthropic API they can resolve to older models: `sonnet` is Sonnet 4.6 on
Claude Platform on AWS and Sonnet 4.5 on Bedrock, Vertex and Foundry, `opus`
is Opus 4.6 on Foundry, and `haiku` is Haiku 4.5 everywhere off the
Anthropic API.

**Which tier for what,** in Anthropic's words:

| Model | Fit |
|---|---|
| Opus 5.5 | "Complex work requiring careful judgment" and long-horizon agentic work. The default: "start with Claude Opus 5.5 for most workloads." |
| Sonnet 5.5 | "Well-scoped everyday tasks". It "fits best when the task has a clear spec and a way to check the result." |
| Haiku 5.5 | "High-volume, latency-sensitive tasks such as classification, extraction, and routing", and lookups. It takes all five effort levels and defaults to `medium`. |

**Fable leads at most; it is never a delegate.** Fable 5.1 was removed on
2026-09-25. Fable 5.2 (2026-11-09) was re-checked on 2026-11-10. It costs 2x
Opus 5.5 per token, down from 2.5x, and a Max plan gives it at most half of
the weekly limit. Anthropic's own measurements put Fable 5.2 at `high` level
with Opus 5.5 at `max` on coding ("45.3% vs. 45.5%") "for roughly half the
cost per task", so per task Fable is the cheaper of the two there, and found that
Fable 5.2 leading Sonnet subagents cost 19% more than Opus 5.5 for about the
same score. The first independent numbers (Vals, Artificial Analysis) show a
lead of a few points on aggregate indices and ties with Opus 5.5 on coding.
So the owner may run the main session on Fable 5.2 for long, ambiguous work,
and no agent or workflow names it; the checks enforce that. On a Fable
session the plugin keeps Fable's share of the limit for judgment. It does
not lower the total cost of a run. None of this was measured on this
plugin. Re-check when independent results on long-horizon work exist, or
when the next Fable model ships.

**Who writes the code.** Anthropic's sources disagree here. The Opus 5.5
cost post (Sep 25, written before Sonnet 5.5) says to keep code edits, even
mechanical multi-file ones, on Opus 5.5 at `low`, and to move only lookups
down to Sonnet or Haiku. The Sonnet 5.5 material (Sep 28) places well-scoped
coding that has a check on Sonnet 5.5. This plugin's choice: spec-complete
edits that have a verify step go to `fast-worker` on Sonnet 5.5, and edits
tangled with judgment calls stay in the main session (on a Fable session,
see Core principle).

**Effort before tier.** Anthropic: "Tuning effort is often a better lever
than switching models." Levels are calibrated per model, so do not carry a
setting over from Opus 5 or Sonnet 5. In Claude Code, Opus 5.5 and Sonnet 5.5
both default to `medium`, and Opus 5.5 at `medium` matches or beats Opus 5 at
`high`. Climb one step at a time:

1. `medium`: day-to-day work with a clear scope.
2. `high`: work where verification matters or edge cases are likely.
3. `xhigh`: long-running agentic work. "Reserve `xhigh` and `max` for work
   where you've measured a quality gain."
4. If Opus 5.5 at `xhigh` hits the same problem twice, change the approach
   (re-plan, split the problem, find the missing fact). Then get an
   independent look from the Codex peer or a fresh-context `deep-reasoner`.
   If the problem is still open, tell the owner that moving the session to
   Fable 5.2 (`/model fable`) is Anthropic's documented next step. It is the
   owner's call, because it changes cost. `max` on Opus 5.5 is the last
   effort step.

On a Fable 5.2 main session the ladder is shorter: `high` is the working
level. If Fable 5.2 at `high` hits the same problem twice, change the
approach and get the independent look. There is no stronger Claude model to
climb to.

`max` lasts only for the current session in Claude Code, and the docs call it
"prone to overthinking". More effort catches missed edge cases; it does not
fix a wrong approach, so change the approach first.

**Skill effort.** The sub-skills set `effort` in their frontmatter: `high`
for `quick`, `loop` and `panel`, and `medium` for `research`, where the lead
only routes and reads verified output. The value holds for the turn that
invokes the skill, then the session level returns. It replaces the session
level in both directions, and `CLAUDE_CODE_EFFORT_LEVEL` overrides it.
`/tech-lead` itself sets none: its invoking turn is the planning turn, and
a session raised to `xhigh` for a hard goal must not plan at `high`. Run
`/tech-lead` at `high` or above.

**Pin effort on delegates.** With no `effort` in its frontmatter or its
call, a delegate on the session's own model runs at the session's level. A
delegate on another model runs at that model's default instead.
`CLAUDE_CODE_EFFORT_LEVEL` overrides even a pin. `fast-worker` pins `high`
and `deep-reasoner` pins `xhigh`; the workflows pin Haiku at `high` for
triage and `low` for the seat-B mapping. A plugin cannot pin the built-in
Explore, but the Agent call can: pass `effort` with the call (Claude Code
v2.1.292 or later). With `model: "sonnet"` or `"haiku"` and no `effort`,
Explore runs at that model's default, `medium`. Keep Sonnet 5.5 at `high` or below for routine work: at
`xhigh` and `max` it starts its own review rounds and widens scope.

**Advisor.** `/advisor opus` is Claude Code's documented pairing for a
Sonnet main session. It is experimental and Anthropic-API only. The advisor
reads the whole conversation, so it never replaces an independent panel seat.

## How a session ends up on another model

Only through a switch such as `/model sonnet`, typically after an "Opus
limit" message. `fallbackModel` is not a rate-limit fallback: it fires only
when the model is overloaded, unavailable, or returns a non-retryable server
error, and only for that one turn. Session and weekly limits are shared
across all models, so a switch does not lift them. After a switch, the new
model starts on a cold cache. Fable 5.2 can read the earlier model's
thinking; nothing else can read Fable 5.2's, and Sonnet cannot read Opus
5.5's.

## Fable 5.2: what the announcement and Artificial Analysis add

Read on 2026-11-11: Anthropic's announcement
(https://www.anthropic.com/claude-fable-and-mythos-5-2) and the Artificial
Analysis model page (https://artificialanalysis.ai/models/claude-fable-5-2).
Nothing here changes a rule above; it gives the rules their numbers.

- **The roles are Anthropic's own.** "Fable 5.2 can also play the role of
  Advisor (where Haiku, Sonnet, or Opus models consult it to help solve
  harder problems) or Orchestrator (where it delegates simpler tasks to
  smaller models)." And for the default: "we recommend that users start with
  Claude Opus 5.5, our strongest daily driver."
- **Price.** "$8 per million input tokens and $40 per million output
  tokens"; fast mode is $16 and $80 for output "up to 2.5 times" faster.
- **Cost per task depends on effort more than on the per-token price.**
  Anthropic's figures: at `high`, Fable 5.2 "scores about the same as Opus
  5.5's best score (45.3% vs. 45.5%) for roughly half the cost per task"
  (FrontierCode 2.0); at `medium` it "matches Opus 5.5's top score for about
  40% of the cost per task" (WANDR). `medium` is "the default in Claude apps
  and Claude Code".
- **Why never `max`.** Artificial Analysis measured the `max` configuration:
  45.0 minutes per task against a median of 12.6, 247.85 s to the first
  answer token against a median of 12.29 s, $26.54 per task, and 275M output
  tokens against a median of 72.8M. Its verdict: "notably slow per task and
  very verbose." It ranks first on that index (65, median 40) and last on
  cost.
- **Which model answers a blocked request.** "Users will instead receive a
  response from Opus 4.8 for cybersecurity and Opus 5 for biology", and
  there are "transparent fallbacks to Opus 5 for a small set of topics" in AI
  R&D, "including kernel development on certain nonstandard accelerators".
  Both are older than the Opus 5.5 a delegate runs on, which is the reason
  for the Security work rule: an Opus 5.5 executor does that work better than
  a Fable lead that has fallen back. Anthropic reports "about 55% fewer
  blocks with Fable 5.2 compared with Fable 5.1".
- **Plan limits, launch promotion.** "Fable is included for up to 50% of
  weekly usage limits for Pro plans and standard seats on the Team plan",
  with one to three resets by length of subscription. The announcement does
  not mention the Max plan; the Max figure above comes from the Claude Code
  model-config page.

## Choosing a model: Anthropic's playbook

Read on 2026-11-11: "Which Claude model should you build with?"
(https://claude.dev/blog/which-claude-model-should-you-build-with/, 2026-11-09).

- **Start and move.** "Start most work on Opus 5.5 at its default effort
  level, `medium`." Down to Sonnet 5.5 "for well-scoped everyday work, like a
  bug fix or a feature built against a spec", to Haiku 5.5 for
  "classification, routing, and extraction", and up to Fable 5.2 "when Opus
  5.5 at `high` still falls short, or for long unattended runs". Its task
  table gives Fable 5.2 "major refactors and migrations, architecture
  planning, and leading many subagents", at "`medium`, then `high`".
- **A clear spec is not enough for Sonnet.** "A migration or a performance
  optimization can have clear specs and still be difficult enough to warrant
  Opus 5.5."
- **When a model is not good enough,** in this order: "Check that the model
  can verify its own work, with a test, a build or a script that calls the
  endpoint." Then "raise effort one level." Then "move to the next model up,
  starting at a lower effort level than you used on the smaller one."
- **Past `high`, compare with the next model.** "Past `high`, one more effort
  level can cost as much as a bigger model." On SWE-bench Pro, Opus 5.5 "at
  `xhigh` … scored about 1.4 points higher for 2.5 times the cost of `high`";
  at `medium` it scored "about 2.5 points lower for about 70% of the cost".
- **Cheap first, retry the failures.** "Opus 5.5 at `low` with failures
  re-run at `high` passed about 97% of tasks for about $0.17 each, against
  95.3% for $0.29 with every task at `high`."
- **What goes to subagents.** "Keep small models on work where a mistake is
  cheap to spot, like finding files, running tests and reading logs. Keep
  code edits and judgment calls on the main model." And: "a lean main context
  matters more the bigger the main model is." The article calls `opusplan`
  (plan on Opus, edit on Sonnet) "the reverse" of this advice and says to
  measure it first. The plugin's `fast-worker` and "Fable decides, Opus
  writes" are on the `opusplan` side of that line: they trade the article's
  default for a smaller share of the lead's limit, and the only measurement
  of them here is the eval suite.
- **Bulk workers.** "An Opus 5.5 lead over Sonnet 5.5 workers, up to 25 at a
  time, cost about a third less than Opus 5.5 alone at its default effort. It
  scored about the same" (a defect search over about 22 million tokens).
  "Skip it for one chain of dependent steps or for work that fits in one
  context window. There, the planning and merging cost more than they save."
- **Routing in code.** "When the routing rule is simple, such as one model
  for each step type, let code pick the model rather than asking a model to."
- **Advisor.** "Of the four pairings in its advisor table, none clearly beat
  its executor alone"; an Opus 5.5 executor with a Fable advisor gained 1.7
  points "for about 2.1 times the money".
- **Switching models.** "The prompt cache belongs to the model that wrote it.
  Your first turn on a new model pays the cache-write price on the whole
  conversation." So "run `/compact` first in Claude Code, or start a fresh
  session with a short written plan." "A move down a tier loses the earlier
  reasoning."
- **Defaults.** API defaults are `medium` for Haiku 5.5 and Opus 5.5 and
  `high` for Sonnet 5.5 and Fable 5.2; in Claude Code Sonnet 5.5 and Fable
  5.2 default to `medium`. `/effort status` shows the session's.

## A thousand agents: what carries over

Read on 2026-11-11: "Safely scaling multi-agent teams with Claude Fable 5.2"
(https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/,
2026-11-09). One experiment (a lead and 999 helpers formalizing a proof), not
a guide. Four findings match this plugin's design:

- **State lives outside the agents.** Earlier attempts "failed because agents
  lost track of the project's state". The lead's first act was a shared store
  with orders, assignments, notes, claimable subtasks and a log of finished
  work. The plan file is the small version of that.
- **A hard check decides what is done.** A statement "counted as proved only
  once Lean's checker accepted a finished proof".
- **A worker's "cannot be done" is a claim too.** "Agents tend to give up on
  hard problems and misjudge their difficulty": helpers judged "47 of the 60
  statements infeasible", and "the team went on to prove most of them".
- **One flagged action stops the team for a person.** "When the classifier
  blocks a tool call, the whole agent team stops and a person must review the
  block."

## When delegation pays

Anthropic's cost measurements (API benchmarks): on one dependent chain of
reasoning, the main model alone at lower effort came out ahead of delegating
in every measured case. Delegation paid off in two cases: work larger than
one context window, and insurance against the cost tail on routine work.
