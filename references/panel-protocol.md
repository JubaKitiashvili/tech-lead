# High-Stakes Panel Protocol

This protocol applies to decisions that are expensive to reverse:
architecture and data-model choices, security-sensitive designs, public API
shapes, and migration strategies. Every tech-lead entry point runs it the
same way: the root skill, `/tech-lead:panel`, and the loop.

## 1 · Brief

Write ONE self-contained brief to a file, following `briefing-template.md`:

- Write it to your scratchpad directory, or to `<P>/.tech-lead/briefs/<slug>.md`
  in loop mode. Pass the path as an absolute path.
- List 2–5 options with stable ids.
- Keep the brief neutral: no preferred option, and no wording, ordering, or
  level of detail that favours one.

Both seats read the same file.

## 2 · Seats (in parallel)

- **Workflow opted in:**
  `Workflow({name: "tech-lead:panel", args: {briefPath, options}})`.
  - **Seat A** is `tech-lead:deep-reasoner` on Opus, in a fresh context. If
    Opus returns nothing, it retries once on Sonnet. That fallback is a
    documented exception to the reflex rules, and the result reports it.
  - **Seat B** is Codex. It runs `--wait`, read-only, `--effort xhigh`, and
    gets the options in reversed order.
  - The workflow returns `agreement`, computed in code.
- **Otherwise** (not opted in, or the workflow says "not found"): send two
  Agent calls in one message.
  - `tech-lead:deep-reasoner`, `name: "seat-a"`. Prompt: "Read the brief at
    `<path>` and answer it. Options: `<list>`."
  - `codex:codex-rescue`, `name: "seat-b"`. Prompt, in order:
    1. `--wait --effort xhigh --fresh`
    2. the line "Read-only: do not add --write; Codex must not modify files."
    3. "Forward to Codex as written: Read the brief at `<path>` and answer it.
       Options: `<reversed list>`. End with 'RECOMMENDATION: `<id>`'."

## 3 · Independence

- Never show either seat the other's answer.
- Never reveal a preferred option.
- Never use `subagent_type: "fork"` for a seat.

## 4 · Empty seat

Seat B is empty when any of these holds:

- `codex:codex-rescue` is absent from the agent types;
- its output is empty;
- its output starts with `SEAT-EMPTY:`;
- its output is a job id, or a queued or background notice, rather than an
  analysis.

When seat B is empty, run with seat A alone and tell the user why the second
seat was empty.

## 5 · Synthesis

**Agreement is corroboration, not proof.** A shared wrong assumption produces
agreement too.

**Disagreement.** Where the seats disagree, the disagreement itself is the
finding.

1. Compare the seats' load-bearing assumptions to find the one that differs.
2. Resolve it with codebase evidence, or with one targeted follow-up to a
   single seat:
   - **Seat A:** use `SendMessage` to `seat-a` (Agent form), or a fresh
     `tech-lead:deep-reasoner` call with a brief narrowed to the assumption.
   - **Seat B:** every follow-up repeats the full Codex prefix:
     `--wait --effort xhigh`, the read-only line, and a brief file path. Add
     `--fresh` for a new question, or `--resume` to continue. Codex does not
     remember its earlier answer unless you pass `--resume`. `SendMessage`
     to `seat-b` reaches only the forwarding wrapper, not Codex's reasoning.
3. Never include the other seat's answer, or your own leaning, in a
   follow-up.

## 6 · Present

Present the decision to the user:

- your recommendation, as the tech lead;
- each seat's answer in one or two sentences, with the model it ran on;
- the agreement status, and what it does and does not establish;
- what would flip the decision.

The decision belongs to the user. Do not implement it until they have chosen.
