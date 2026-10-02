---
name: panel
description: This skill should be used when the user invokes "/tech-lead:panel", or asks to "run a panel on", "get independent second opinions on", or "have Opus and Codex both weigh in on" one specific decision, or faces one choice that is expensive or hard to reverse ("hard to change later", "we must choose between X and Y", "which one should we commit to"). Applies to a single expensive-to-reverse decision (architecture, data model, datastore or database choice, public API shape, migration strategy, security design, major dependency). Not for easily reversed choices or for executing a decision already made.
argument-hint: [decision question]
---

# tech-lead Panel — one high-stakes decision

This skill runs one decision through `../../references/panel-protocol.md`.
Follow that protocol exactly. The steps below only frame the decision and
fix the output shape.

**Workflow opt-in.** Workflow is opted in only when one of these holds:

- the user typed `/tech-lead:panel`;
- ultracode is on;
- the user asked for a workflow.

When this skill was picked from a phrase alone, use the protocol's Agent
form.

## 1 · Frame the decision

- Restate the decision in one sentence.
- Gather the facts the seats will need: facts, not opinions. If that takes
  10+ file reads, use Explore with `model: "sonnet"`.
- List 2-5 options with stable kebab-case ids. Include the status quo when it
  is a real option.
- If the user's message reveals a preference, keep it out of the brief.

## 2 · Write the brief

Write the brief to `<scratchpad>/panel-<slug>.md`, following
`../../references/briefing-template.md`. Include its OPTIONS section.

Before sending, check two things:

- **Self-contained:** would the brief make sense to someone who has never
  seen this conversation?
- **Neutral:** does the wording, order, or level of detail favour any option?

## 3 · Run, synthesize, present

Run the seats, synthesize, and present per protocol steps 2–6. Present in
this shape:

```
**Decision:** <question>
**Recommendation (tech lead):** <your synthesis, one or two sentences>
**Seat A (deep-reasoner · <model>):** <one or two sentences>
**Seat B (Codex · <model from ~/.codex/config.toml>):** <one or two sentences | seat empty: <reason>>
**Agreement:** <agree | disagree | single-seat | no-seats>, and what it does and does not establish
**What would flip it:** <the load-bearing assumptions>
```

The decision belongs to the user. Do not implement until they choose.
