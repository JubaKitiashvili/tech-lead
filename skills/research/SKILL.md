---
name: research
description: This skill should be used when the user invokes "/tech-lead:research", or asks to research, vet, check, or deeply evaluate an external library, tool, model, dataset, or repository before adopting it, depending on it, or borrowing from it ("research X before we adopt it", "check whether X is any good before we adopt it", "vet this repo", "evaluate X against alternatives"). Not for quick factual or opinion questions with no adoption decision attached ("is X worth using?", "is X still maintained?"), for questions answerable from the local codebase alone, or for a hard-to-reverse choice between well-known options (tech-lead:panel).
argument-hint: [what to research]
---

# tech-lead Research — verified evaluation

Web research routinely invents names, numbers, features, and integrations.
This skill runs every research lane past an independent fact-checker, and
you synthesize only from what survived.

**Cost check.** A research run spends many agents: 4 lanes (Sonnet at effort
`high`) and 4 fact-checkers (Opus at `high`) by default, with
repository clones and web searches.

**Workflow opt-in.** Run §2 as a Workflow in these cases:

- the user typed `/tech-lead:research`;
- ultracode is on;
- the user asked for a workflow or deep research.

When this skill was picked from a phrase alone, first offer the run in one
line, with its scope and cost. A "yes" to that offer opts in. On a "no",
answer from a single Explore or general-purpose Agent call instead, and mark
the answer unverified.

## 1 · Scope

- **Pin down the subject.** Identify each subject exactly: names and URLs. If
  the name is ambiguous, ask one clarifying question.
- **Write the evaluation context.** State:
  - what we would use the subject for;
  - the relevant local files, as absolute paths;
  - our constraints: stack, machine, data egress, cost.

## 2 · Run

```
Workflow({name: "tech-lead:research-lanes",
          args: {question: "<subject + what we want to know>",
                 context: "<evaluation context>",
                 scratch: "<scratchpad>/research-<slug>"}})
```

- **Default lanes:** `primary`, `ecosystem`, `alternatives`, `fit`.
- **Custom lanes:** pass `args.lanes` only when the defaults do not fit. It
  replaces the default set. Each entry is a default lane's key, which keeps
  that lane's prompt, or a `{key, prompt}`; keys must be unique. For example,
  with two subjects:
  `lanes: ["ecosystem", "alternatives", "fit", {key: "primary-drizzle", prompt: "…"}, {key: "primary-prisma", prompt: "…"}]`.
- **Model and effort:** `args.model` and `args.effort` change the lanes only.
  Fact-checkers always run on Opus at `high`, whatever the session model is.
- **If the Workflow tool is not available, or says "not found":** dispatch the same lanes as
  general-purpose Agent calls with `model: "sonnet"`, in one message. Then
  dispatch one verifier Agent per lane with `model: "opus"`, using the lane
  and fact-check prompts in `../../workflows/research.js`. Agent calls cannot
  pin effort, so on this path every agent runs at the session's effort.

## 3 · Synthesize

- Build the synthesis only from each lane's `corrected_summary`,
  `confirmed_facts` (claims with their sources), `verified_ideas` and
  `verified_risks`.
- Treat anything from `unverified_lanes` as unverified.
- Refuted claims never enter the synthesis. Label unverifiable claims as
  unverified.
- Separate hype signals (stars, launch threads) from evidence of real use
  (dependents, code-search hits, issues from real users).

## 4 · Recommend

Pick one of four recommendations:

- **adopt:** use the subject as a dependency;
- **borrow ideas:** take mechanisms without taking the dependency;
- **ignore:** neither;
- **build our own.**

Then:

- For each borrowed idea, name the concrete mechanism and where it plugs in.
- Say what evidence would change the recommendation.
- If adopting is expensive to reverse, offer `/tech-lead:panel` with a brief
  built from the verified findings.

## Report shape

The report has six parts:

1. **What it is:** verified facts only.
2. **Evidence of real use:** separate from hype.
3. **Alternatives:** including building our own.
4. **Fit and recommendation.**
5. **Refuted or unverified claims:** so nobody repeats them.
6. **Sources.**
