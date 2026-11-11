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
the weekly limit. Anthropic's own measurements put Opus 5.5 at `xhigh` level
with Fable 5.2 at `high` on coding for about half the cost, and found that
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

## Prompting Fable 5.2

Read on 2026-11-11: Anthropic's guide
(https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2).
These findings are behind the Fable rules in `SKILL.md`.

- **It applies rules as written.** "If your system prompt has approval rules,
  name the exact actions they cover, because the model applies them as
  written." Under a bare "never" rule the model took an approved step "in
  about one try in ten"; "when the rule itself said to get a go-ahead first,
  the model took the step in about nine tries in ten". A separate line
  clearing approved steps "didn't change that rate much".
- **Caution piles up.** "Cautious instructions build up wherever context
  carries over: memory, notes, instruction files, and messages between
  agents." With a reviewer's "stop at the first error" in context, Fable 5.2
  "didn't retry in about a third of the tries. Claude Fable 5.1 and Claude
  Opus 5.5 retried." "A general instruction to act more freely changed
  nothing": name the steps that need no approval.
- **It can stop early.** "Claude Fable 5.2 sometimes ends a turn before the
  work is done … with a list of what remains, an offer to continue, or a stop
  at an ordinary obstacle such as a timeout. This occurs more often at `low`
  and `medium` effort." Anthropic's finishing text halved the sessions that
  "ended with doable work left" for about 30 percent more output tokens, and
  "separates two kinds of obstacle": ordinary ones to work through, and
  deliberate blockers to leave alone. "Finish the run" is this plugin's
  version; the plan stop is one of its named exceptions.
- **Effort.** "Start at `high`." "Most of the gain in capability is already
  present at `high`." `xhigh` "raised scores slightly and used many more
  tokens"; `max` is "for measuring the model's ceiling". "At `high` and
  above, the model thinks before almost every reply", and "an instruction to
  answer directly without deliberating didn't stop the model from thinking at
  `medium` and above": lower the effort, do not add such a line.
- **Subagents.** It "delegates readily" where prompts invite it, and at
  `xhigh` and `max` uses "subagents to review its own work". A description
  that "puts cost first" cut delegation by about a third with the same task
  success. "Subagents can account for a large part of what a session costs,
  so check which model your harness runs subagents on by default."
- **Who owns the code.** With no ownership statement the model "tended to add
  to the existing structure" and "to report nearby problems instead of fixing
  them". Told "this codebase is yours", it merged repeated code in about half
  of tries, for "about 1.5 times the output tokens" and "several changes that
  nobody had asked for"; a "no drive-by refactors" rule elsewhere "doesn't
  cancel the ownership sentence". This plugin says nothing about ownership,
  which keeps diffs small. Add the sentence to a brief only when a
  restructuring is the task.
- **Quiet runs and reports.** It "sometimes writes little user-facing text
  during long runs of tool calls". Readers of a final report "usually haven't
  seen the tool calls or files behind it. The report needs to make sense on
  its own."
- **Reasoning in the reply.** A request that "asks the model to reproduce its
  internal reasoning in the response text" can be declined
  (`reasoning_extraction`). Ask a Fable lead for conclusions and their
  grounds, not for its reasoning.
- **Hard style limits.** It "follows style rules closely, so a hard limit …
  can make its prose choppy". The report contract's 40-line cap is for
  delegates, which are never Fable.

## Opus 5.5 and Sonnet 5.5: the guides, re-read

Read on 2026-11-11:
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
and
https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5.
Both say that prompts written for Opus 5 and Sonnet 5 "should perform well
without changes". What they add for this plugin's delegates:

- **Sonnet 5.5 adds things.** "The model tends to add tests, documentation,
  and small supporting files that fit your repository's conventions, even
  when you don't ask for them. It does this at every effort level, and more
  at higher effort." `fast-worker` rule 2 is Anthropic's counter-text:
  "Don't add features, tests, files, docs or refactors that weren't asked
  for. If you think one would help, mention it at the end instead of doing
  it."
- **Sonnet 5.5 at `xhigh` and `max`.** "After it completes a task, it can
  start its own rounds of review and verification, sometimes with subagents
  if your harness provides them … so run routine work at `high` or below,
  where it's rare." At `low` it "can skip verifying a change" and "sometimes
  reports a change as done without running a check that exercises it".
  Hence `fast-worker` at `high`, and its rule that a syntax-only check or a
  command that failed to start does not count.
- **Opus 5.5 at `xhigh` and `max`** "tends to think more per turn than Claude
  Opus 5 … expect longer turns and more output tokens". "Reserve `xhigh` and
  `max` for work where you've measured a quality gain." With the SWE-bench
  Pro figure above (1.4 points for 2.5 times the cost), this is why only the
  reviewer of a high-stakes task runs at `xhigh`; the implementer stays at
  `high`.
- **An end of turn is a report, not proof.** For unattended runs on Opus
  5.5: "Treat a text-only end of turn as a report rather than as proof the
  task is done", "keep the task's parts in a checklist the model updates,
  such as a to-do tool or a file", and "stop after two or three automatic
  continuations on the same task". The plan file is that checklist.
- **Do not ask for reasoning in the reply.** On Opus 5.5, Sonnet 5.5 and
  Fable 5.2 a prompt that "pushes the model to reproduce its reasoning in the
  response text might be declined with the `reasoning_extraction` refusal
  category". "You can still ask for a short explanation of the answer or a
  summary of the actions taken." `deep-reasoner` therefore reports "Why",
  the decisive points with their evidence.
- **Reviewing.** Opus 5.5: "more bugs caught than on Claude Opus 5 and fewer
  false alarms". "Finding vulnerabilities in source code is allowed.
  High-risk dual-use cybersecurity activities are not."
- **Not adopted.** The Opus 5.5 guide's "treat that answer as done" line is
  for chat; it makes the model "less likely to point out a mistake in an
  earlier answer", which a lead that verifies work must keep doing.

## When delegation pays

Anthropic's cost measurements (API benchmarks): on one dependent chain of
reasoning, the main model alone at lower effort came out ahead of delegating
in every measured case. Delegation paid off in two cases: work larger than
one context window, and insurance against the cost tail on routine work.
