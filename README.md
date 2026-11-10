# tech-lead

Model-tiered orchestration for [Claude Code](https://code.claude.com). Your
main session acts as the tech lead: it plans, keeps the reasoning, makes the
decisions, and checks the results. Delegates take the work that would waste
its context or usage:

- cheaper Claude models do exploration and mechanical edits;
- a fresh-context Opus seat and OpenAI Codex give independent second opinions;
- Workflow scripts turn panels, fan-outs, research, and loop triage into
  typed contracts that code enforces.

**Version 0.7.1.** Tested with Claude Code 2.1.284 on the Anthropic API.

## Contents

- [Why](#why)
- [Commands](#commands)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Commands in detail](#commands-in-detail)
- [Loop mode](#loop-mode)
- [Troubleshooting](#troubleshooting)
- [Releasing a new version](#releasing-a-new-version)
- [Repository layout](#repository-layout)
- [Credits](#credits)

## Why

- **Reasoning stays with the orchestrator.** Reasoning costs little context,
  and it is exactly where the strongest model earns its keep. Architecture
  calls, debugging loops, tradeoffs, synthesis, and final review stay in the
  main session.
- **Delegate only two things.** Context-heavy exploration (many file reads,
  broad searches), and mechanical work that is fully specified with no
  judgment calls left.
- **Independence, not agreement.** A decision that is expensive to reverse
  goes to two seats that read the same brief and never see each other's
  answer: a fresh-context Opus seat and Codex, from another model family.
- **Contracts over prose.** A delegate's "done" is only a claim. `git
  status`, `git diff`, and your own verify commands decide completion.
  Workflow scripts validate every report against a JSON schema and compute
  verdicts in code.

## Commands

| Command | What it does | Use it for |
|---|---|---|
| `/tech-lead <goal>` | Plans, delegates, verifies, and decides | A feature, refactor, migration, or audit that touches 3+ files or 2+ subsystems |
| `/tech-lead:quick <task>` | The main session implements and verifies the change itself, then opens a draft PR on a `feature/<slug>` branch | A small, bounded, low-risk change you want shipped as a PR |
| `/tech-lead:panel <decision>` | Runs one decision through the two-seat panel | One choice that is expensive to reverse: datastore, data model, public API, migration, security design, or a major dependency |
| `/tech-lead:research <subject>` | Runs multi-lane research, then fact-checks every lane against primary sources | Vetting a library, tool, model, repo, or dataset before you adopt it |
| `/tech-lead:loop [project-path]` | Runs one iteration of a backlog executor, driven by a `.tech-lead/` spine | Working through a project backlog unattended, with brakes and human gates |

The skill descriptions trigger on the task type too, so a request such as "add
X across the API and the mobile client" can start `/tech-lead` without the
slash command. For stricter always-on routing, see
[the routing rule](#optional-always-on-routing-rule).

## Requirements

- **Claude Code 2.1.293 or later** (`claude --version`). The model names in
  this README assume the Anthropic API. On Bedrock, Vertex, Foundry, and
  Claude Platform on AWS, the model aliases resolve to older models.
- **Dynamic workflows.** Workflows are available on paid plans and the API;
  on Pro, turn them on in `/config`. `"disableWorkflows": true` or
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1` switches them off. Without Workflow the
  commands fall back to plain Agent calls. The one exception is loop triage,
  which records `no-verdict`.
- **`git`**, plus **`gh`** logged in. `/tech-lead:quick` needs a GitHub remote,
  and the research lanes use `gh` for GitHub lookups. Loop mode's clone needs
  git 2.40 or newer: on an older git the loop pauses (`git-too-old`).
- **Optional:**
  - the [Codex plugin](#optional-codex-as-the-second-panel-seat), for panel
    seat B and the loop's L3 implementation delegate;
  - argent, for quick's on-device check of React Native UI;
  - the superpowers plugin, which the routing rule template refers to.

## Installation

Pick **one** of the two install methods. If you use both, the marketplace
install wins, and the skills-directory copy shows as not loaded.

### Option A: clone into your skills directory

This is best for personal use and for developing the plugin.

```sh
git clone https://github.com/JubaKitiashvili/tech-lead.git ~/.claude/skills/tech-lead
```

Claude Code loads any folder under `~/.claude/skills/` that contains
`.claude-plugin/plugin.json` as a plugin, with no install step:

- the plugin appears as `tech-lead@skills-dir` in `claude plugin list`;
- the root skill runs as `/tech-lead`;
- it loads when you start a new session.

To update:

```sh
git -C ~/.claude/skills/tech-lead pull
```

Then restart the session, so that the workflows register again.

### Option B: install from GitHub as a marketplace

The repository is its own marketplace (`.claude-plugin/marketplace.json`), so
the plugin id is `tech-lead@tech-lead`.

In a session (Claude Code 2.1.275 or later):

```
/plugin install tech-lead --marketplace JubaKitiashvili/tech-lead
```

From the shell:

```sh
claude plugin marketplace add JubaKitiashvili/tech-lead
claude plugin install tech-lead@tech-lead
```

A shell install loads in the next session, or after `/reload-plugins`. With a
marketplace install the root skill is `/tech-lead:tech-lead`. Bare
`/tech-lead` also works unless another command already uses that name.

**Access to the private repository.** Claude Code clones with plain `git`, and
prompts are disabled. It has no token of its own, so your machine's git
credentials must work without a prompt:

```sh
gh auth login
gh auth setup-git
git ls-remote https://github.com/JubaKitiashvili/tech-lead.git   # must succeed with no prompt
```

- **SSH:** the key must load without a passphrase prompt (for example, from
  ssh-agent).
- **Force HTTPS:** `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` skips the SSH probe.

**Updates.**

- Auto-update is off by default for third-party marketplaces. Turn it on in
  `/plugin` → Marketplaces.
- To update manually, run `claude plugin update tech-lead@tech-lead`, or use
  `/plugin` → Installed → Update now.
- `plugin.json` pins the version, so users get a release only when the
  version changes.

**Uninstall.**

```sh
claude plugin uninstall tech-lead@tech-lead                   # Option B, user scope
claude plugin uninstall tech-lead@tech-lead --scope project   # a Teams install (edits the shared settings)
rm -rf ~/.claude/skills/tech-lead                             # Option A
```

`uninstall` defaults to user scope and fails for a project-scope install. To
opt out of a Teams install on your own machine, run
`claude plugin disable tech-lead@tech-lead --scope local`. If you installed
the [routing rule](#optional-always-on-routing-rule), delete
`~/.claude/rules/tech-lead.md` too. Otherwise it keeps sending tasks to
skills that no longer exist.

**Teams.**

1. Declare the marketplace in the project's `.claude/settings.json`:

   ```sh
   claude plugin marketplace add JubaKitiashvili/tech-lead --scope project
   ```

2. Commit and push `.claude/settings.json`, so teammates get the
   declaration. Only teammates who trust the folder pick it up.
3. Each teammate needs read access to this private repository.
4. Each teammate pulls, then installs the plugin:

   ```sh
   claude plugin install tech-lead@tech-lead --scope project
   ```

   If the marketplace is reported as unknown, open `claude` in the repository
   once and accept the trust dialog. Or run
   `claude plugin marketplace add JubaKitiashvili/tech-lead` yourself.

Cloud sessions (claude.ai/code) load neither plugins installed on your
machine nor ones that the repository's `.claude/settings.json` turns on.

### Optional: Codex as the second panel seat

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup
```

The Codex plugin's README lists its account and Node.js requirements.

Without Codex:

- panels run with seat A alone, and the result says why the second seat was
  empty;
- the loop parks L3 implementation items as `waiting-infra`.

Tested with Codex plugin 1.0.6 and Codex CLI 0.156.1. The Codex rescue wrapper
can write files by default, so tech-lead always sends panel briefs read-only,
with `--wait`.

### Optional: always-on routing rule

`templates/rules-tech-lead.md` is a user rule that routes by task type. It
adds a do-not-route list (questions, single-file edits, debugging, and
repeated mechanical changes stay out of tech-lead). It also adds recursion
safety: only the top-level session routes, never a subagent, workflow agent,
or teammate.

From a clone:

```sh
mkdir -p ~/.claude/rules
cp ~/.claude/skills/tech-lead/templates/rules-tech-lead.md ~/.claude/rules/tech-lead.md
```

From GitHub, which is what you want for a marketplace install, because the
plugin cache path changes with every version:

```sh
mkdir -p ~/.claude/rules
gh api repos/JubaKitiashvili/tech-lead/contents/templates/rules-tech-lead.md \
  -H "Accept: application/vnd.github.raw" > ~/.claude/rules/tech-lead.md
```

The rule sends debugging to `superpowers:systematic-debugging` and new
designs to `superpowers:brainstorming`, so it assumes the superpowers plugin
is installed.

## Quick start

```
/tech-lead Add rate limiting to the public API and show 429s in the mobile client
/tech-lead:quick Fix the typo in the checkout empty-state message and open a draft PR
/tech-lead:panel Should session state live in Postgres or Redis?
/tech-lead:research Evaluate drizzle-orm before we adopt it for the billing service
/tech-lead:loop ~/code/my-app
```

## How it works

### The bench

| Delegate | Model | Effort | Tools | Role |
|---|---|---|---|---|
| `Explore` (built-in) | Inherits the main model (capped at Opus). The skill always passes `model: "sonnet"`, or `"haiku"` for pure lookups | Set per call with the Agent tool's `effort`; otherwise the model's default | Built-in, read-only | Search fan-out that returns conclusions, not file dumps |
| `tech-lead:fast-worker` | `sonnet`: Sonnet 5.5 | `high` | Read, Grep, Glob, Write, Edit, Bash | Complete specs that have a check: repetitive multi-file edits, boilerplate, test and build runs. Stops on judgment calls |
| `tech-lead:deep-reasoner` | `opus`: Opus 5.5, fresh context | `xhigh` | Read, Grep, Glob | Independent deep analysis of a well-scoped problem; panel seat A |
| `tech-lead:triage` | `haiku`: Haiku 5.5 | `high`, set by the workflow | Read | The loop's escalate-only second check; runs only through its workflow |
| Codex (`codex:codex-rescue`) | GPT, from `~/.codex/config.toml` | Set per call (panel: `xhigh`) | Codex CLI | A peer from another model family: panel seat B, and the loop's L3 implementer |

**Always kept in the main session:**

- iterative or context-dependent work;
- every final decision;
- human gates;
- all git branch, commit, and push operations;
- scheduling.

A panel seat, or any delegate valued for its independence, is never a `fork`,
because a fork inherits your context and your leanings.

### Models and effort

`SKILL.md` → *Models and effort* has the full guidance, checked against
Anthropic's documentation on 2026-11-10. In short:

- **The orchestrator is Opus 5.5 by default, or Fable 5.2 when you pick
  it** with `/model fable`. On a Fable session, Fable leads and never
  executes: every delegate keeps its own model, and two checks stop an agent
  from inheriting Fable. This keeps Fable's share of your limit for
  judgment; it does not lower the total cost of a run.
- **A session ends up on Sonnet only through a switch** such as
  `/model sonnet`, typically after an "Opus limit" message. `fallbackModel`
  is not a rate-limit fallback: it fires only on overload, unavailability, or
  a server error, and only for one turn. On a Sonnet main session, lean on
  Codex for the heavy reasoning.
- **Effort comes before tier.** In Claude Code, Opus 5.5 and Sonnet 5.5
  default to `medium`. Go to `high` when verification matters, and to
  `xhigh` for long agentic work. Anthropic says to reserve `xhigh` and `max`
  for measured gains, and the Claude Code docs call `max` "prone to
  overthinking". If Opus 5.5 at `xhigh` hits the same problem twice, change
  the approach, then bring in the Codex peer or a fresh-context
  deep-reasoner. After that, moving the session to Fable 5.2 is the owner's
  call; `max` is the last effort step.
- **Sub-skills set their own effort.** `quick`, `loop` and `panel` run the
  invoking turn at `high`, and `research` at `medium`. After that turn the
  session level returns. `CLAUDE_CODE_EFFORT_LEVEL` overrides it.
  `/tech-lead` sets none, so it plans at your session level: use `high` or
  above.
- **Aliases, not model IDs.** Agents and scripts name `opus`, `sonnet`, and
  `haiku`, so they follow the aliases when new models ship. The plugin never
  names `fable` or `best` in an agent or workflow: Fable 5.2 may lead a
  session, and it is never a delegate (see "Fable leads at most" in
  SKILL.md).

### Workflow mode

tech-lead uses its Workflow scripts when any of these holds:

- ultracode is on;
- you ask, in your own words, for a workflow or multi-agent orchestration;
- you type `/tech-lead`, `/tech-lead:panel`, `/tech-lead:research`, or
  `/tech-lead:loop`, including a `/loop` or cron prompt that runs one;
- you say yes when a skill offers a workflow run.

Trigger phrases on their own ("orchestrate", "delegate this") pick the skill
but do not opt in. `/tech-lead:quick` never uses Workflow.

The plugin registers four workflows at session start:

| Workflow | Args | Returns | Enforced in code |
|---|---|---|---|
| `tech-lead:panel-seats` | **Required:** `briefPath` (absolute) and `options` (2+ `{id, label}` with unique ids). **Optional:** `seatModel` (default `opus`), `seatEffort` (default `xhigh`; one of `low`…`max`), `codexEffort` (default `xhigh`) | `agreement`, plus `seatA` and `seatB`, each with its model, verdict, and the option order it saw | Typed verdicts; agreement computed from the two option ids; seat B sees the options in reverse order; empty-seat detection; one retry on Sonnet at `high` if the Opus seat returns nothing |
| `tech-lead:fanout` | `repo` (absolute) and `tasks` (`{id, brief, files: [absolute paths]}`, with unique ids and disjoint file sets) | `summary` (count per status) and `results` (one entry per task: `id`, `status`, `report`, `out_of_scope`, `error`) | Paths are normalized, kept inside the repo, and never shared or nested between two tasks; directory entries are refused; every task gets a status, also when its worker could not run |
| `tech-lead:research-lanes` | **Required:** `question` and `scratch` (absolute). **Optional:** `context`, `lanes` (a non-empty list of default lane keys and `{key, prompt}` entries, with unique keys; replaces the default set), `model` (lanes only; default `sonnet`), `effort` (lanes only; default `high`) | `lanes` (one entry per lane, with `corrected_summary`, `confirmed_facts`, `verified_ideas`, `verified_risks`, `refuted`, `unverifiable`) and `unverified_lanes` | An independent fact-checker on Opus at `high` verifies every lane, and only the verifier's output is returned; a lane whose agent fails is still listed in `unverified_lanes` |
| `tech-lead:triage` | `item` (`{title, notes}`) and `orchestratorClass` | `agreement`, `checker`, `derived`, `signals` | A Haiku verdict under a schema; the class is derived from the signals in code; it can only escalate |

**What stays outside the scripts.** Scripts cannot touch files, git, clocks,
or you. Git operations, human gates, spine writes, and the final verify all
happen in the main session.

**"Not found".** If the Workflow tool answers "not found", the workflows were
not registered in this session, for example because the plugin was updated
after the session started. The skills then fall back to Agent calls. The
exception is loop triage, which records `no-verdict` and does not run.
Restart the session to fix it.

**Fan-out results.** Each task gets the first status that applies:

| Order | `status` | Condition | What the orchestrator does |
|---|---|---|---|
| 1 | `out-of-scope` | The worker touched a file outside its list | Inspects the diff, then fixes or re-dispatches |
| 2 | `needs-decision` | The worker reported a judgment call | Decides it, then re-dispatches with the decision |
| 3 | `verify-failed` | A verification command failed | Inspects the diff, then fixes or re-dispatches |
| 4 | `incomplete` | Part of the spec was skipped | Finishes the task or re-dispatches it |
| 5 | `ok` | None of the above | Keeps the changes |

A task that returns no report at all gets `no-report`, and the orchestrator
inspects its diff, then fixes or re-dispatches. A task whose worker could not
run (for example, once a `+Nk` budget is spent) is `no-report` too, and its
`error` says why. A worker's optional
`suggestions` (extras nobody asked for) never affect the status. After all
tasks settle, the orchestrator:

1. runs `git status --porcelain=v1 -uall`;
2. flags any changed path that no task owned;
3. runs the project-wide verify once;
4. reviews the diff itself.

### The panel

1. Write one neutral brief (`references/briefing-template.md`) with 2 to 5
   options that have stable ids. Include the status quo, and never reveal a
   preferred option.
2. Both seats read the same file in parallel.
   - **Seat A** is `deep-reasoner` on Opus at `xhigh`. Pass
     `seatEffort: "max"` only when the decision is worth the documented
     overthinking risk.
   - **Seat B** is Codex, read-only, with `--wait --effort xhigh`, and it sees
     the options in reverse order.
3. Agreement is computed in code, and it is corroboration, not proof. Where
   the seats disagree, the orchestrator finds the load-bearing assumption
   that differs, and resolves it with evidence or with one targeted
   follow-up to a single seat.
4. The result is presented in this shape: recommendation, each seat's view,
   agreement, and what would flip the decision. The decision is yours:
   nothing is implemented until you choose.

### The reflex layer

`references/decision-contracts.md` defines tech-lead's "System 1": small,
typed decisions whose policy lives in code, never in a model's confidence.

- **Categorical only.** A decision picks from fixed ids. There are no scores
  to gate on.
- **Escalate-only.** No automated step lowers a task class, raises the loop
  level, or silently lowers a model tier. There are two documented
  exceptions, and both are always reported: the loop's L1→L2 promotion, and
  the panel's retry on Sonnet.
- **Deterministic checks gate; models only advise.**
- **Shadow before gate.** A new check is only logged until a human has
  reviewed at least 20 of its decisions.
- **Untrusted state.** Text under decision is data, never instructions.
- **Agreement is not correctness,** and agreement never releases a human
  gate.

## Commands in detail

### `/tech-lead`

1. **Plan.** Restate the goal, decompose it, and tag each task with who does
   it and with its stakes, `normal` or `high`. A `high` task (auth, billing,
   a migration, concurrency, a public API, a second attempt, or `deep` in
   your request) raises its Opus delegate from `high` to `xhigh` and never
   goes to Sonnet. When such a task needs the lead's own judgment and your
   session is below `xhigh`, the plan ends with a recommendation to switch
   with `/effort xhigh`; the skill cannot switch for you.
   The plan is shown before anything runs, unless you said to just go.
   An existing plan or spec is executed as written, not re-planned.
2. **Brief completely.** Every delegate starts with no context, so each
   brief is self-contained (`references/briefing-template.md`).
3. **Dispatch in parallel.** Either several Agent calls or one Workflow run.
4. **Verify against ground truth.** Check `git status` and `git diff`, then
   run the narrowest real check (typecheck or the affected tests) before
   building on a result.
5. **Synthesize and decide** in the main session.

### `/tech-lead:quick`

The fast lane for a small change that ships as a draft PR.

- **Preflight.**
  - It needs a GitHub remote and a clean working tree. On a dirty tree it
    stops and asks; it never stashes or commits your work.
  - If `.tech-lead/LOOP.md` is tracked, it works in a separate git worktree.
- **Escalation check,** before any branch or edit. It stops and proposes
  `/tech-lead` or `/tech-lead:panel` if the change:
  - touches a public API, a data model or migration, security or auth, or a
    major dependency;
  - leaves a design choice open;
  - would touch more than about 5 files, or needs more than about 10 reads
    just to locate the code.

  It continues only on an explicit "proceed anyway".
- **Implement.** It creates `feature/<slug>` from the base branch, and the
  main session writes the change itself. There is at most one Explore call,
  and a logic change gets a test first when a test harness is nearby.
- **Verify.**
  - It runs typecheck, the covering tests, and lint.
  - If the diff changes visible React Native UI and a simulator is already
    running, it also runs one argent check on the device. It never boots a
    device.
  - After two failed fix attempts it stops, and nothing is committed.
- **Ship.**
  - It stages explicit paths only, makes one commit, pushes that branch, and
    opens a **draft** PR.
  - It pushes only when you typed the command or asked for a PR. Otherwise it
    stops after the local commit and asks.
  - It never force-pushes, pushes to the base branch, or merges.

### `/tech-lead:panel`

1. Frame the decision and gather facts.
2. List 2 to 5 option ids, including the status quo.
3. Write the brief to the scratchpad and check that it is self-contained and
   neutral.
4. Run the [panel](#the-panel) and present the result.

### `/tech-lead:research`

- **Lanes.** By default four lanes run in parallel: `primary` (the source
  itself), `ecosystem` (real-world use), `alternatives`, and `fit` (with your
  code). Every lane gets its own adversarial fact-checker, so a run starts 8
  agents. Lanes run on Sonnet at effort `high`, and fact-checkers on Opus
  at `high`. Custom `lanes` replace the defaults; list a
  default's key to keep it.
- **Synthesis** uses only what survived verification:
  - refuted claims never enter it;
  - claims that could not be verified are labeled as such;
  - hype signals are kept apart from evidence of real use.
- **Recommendation.** Exactly one of **adopt**, **borrow ideas**, **ignore**,
  or **build our own**. If adopting would be expensive to reverse, it offers
  a panel.
- **Report.** Six parts: what it is, evidence of real use, alternatives, fit
  and recommendation, refuted or unverified claims, and sources.

## Loop mode

`/tech-lead:loop [project-path]` runs **one** iteration of a backlog
executor. All of its memory is on disk, in `<project>/.tech-lead/`, so the
same iteration works when you run it by hand, from `/loop`, or from a
scheduler. Its work happens in an isolated clone of your project, outside
it (see [The work area](#the-work-area)), so your working tree and your
branches are never touched.

### Running it

- **By hand.** `/tech-lead:loop ~/code/my-app`. Without a path, it uses the
  current directory.
- **In a session.** `/loop /tech-lead:loop ~/code/my-app`. The loop paces
  itself. The runner stops when:
  - the backlog is dry (this includes every item waiting on you);
  - the daily budget is spent;
  - the loop is paused;
  - an infrastructure incident happened;
  - the [firing lock](#the-firing-lock) refuses for a reason that needs
    you: an unreadable lock record, an open dispatch of an interrupted
    firing, a child of an earlier firing or another process still running
    in the loop's clone, a process check that could not run, or a lock error
    (see [Troubleshooting](#troubleshooting)).

  A firing that finds the lock busy (another firing holds it or took it
  first, or a holder's liveness could not be read just now) ends without
  writing anything, and the runner tries again at its next wakeup.
- **Scheduled in Claude Code.** Ask Claude to schedule the prompt
  `Run /tech-lead:loop <abs-path>` with `CronCreate`, in a dedicated session
  opened in the project that stays open. The job runs inside that session,
  with its working directory and settings. Jobs are session-only, and
  recurring jobs expire after 7 days, so re-arm them.
- **Scheduled by the OS.** Run
  `cd <abs-path> && claude -p 'Run /tech-lead:loop <abs-path>'` from cron or
  launchd.
  - **Use absolute paths.** cron and launchd run with a minimal PATH, so give
    the absolute path to `claude` (find it with `command -v claude` in a
    login shell), or set `PATH` in the crontab or the plist. launchd has no
    shell, so wrap the command as `/bin/sh -c 'cd <abs-path> && …'`.
  - **Run the first iteration interactively,** with `claude` opened in the
    project folder, and accept the trust dialog. A headless run refuses to
    create the spine. Also, `claude -p` applies the allow rules in the
    project's `.claude/settings.json` only once the folder is trusted.
    Rules in an untracked `.claude/settings.local.json` apply either way.
  - **Allow what one firing runs.** Headless runs can't answer permission
    prompts. The loop needs:
    - git, which the panel's snapshot runs in your project (the loop runs
      git in its clone only through its helper scripts);
    - your verify commands. The delegate runs them in the loop's clone,
      `~/.cache/tech-lead/<key>/clone`; the loop's own verify runs go
      through `node <plugin>/scripts/loop-lock.mjs exec`;
    - your dependency install (for example `npm ci`), through the same
      `exec` wrapper. It runs in the clone on the first write-capable
      firing, and a denial pauses the loop;
    - `shasum` and `xargs`, for the panel's snapshot of the project;
    - `node`, at every level, for the loop's helper scripts in the plugin's
      `scripts/`, and for the Codex companion at L3;
    - file edits in `.tech-lead/` and in the clone. The clone is outside
      the project folder, so add its path (printed by
      `node <plugin>/scripts/loop-review.mjs paths <project>`) to
      `permissions.additionalDirectories` in the project's
      `.claude/settings.json` or `.claude/settings.local.json`;
    - the `Workflow` tool.
- **Not supported:** cloud routines, which cannot see your local tree.

Scheduled firings never ask questions. Anything that needs you goes into
`STATE.md`.

### One iteration

1. **Rehydrate.** Take the project's [firing lock](#the-firing-lock); a
   firing that finds it held exits and writes nothing. Then read
   `LOOP.md`, `STATE.md`, and the recent ledger, and plan the recovery of
   an interrupted firing: its item goes back to the backlog (or to
   `## Done`, when its commit landed, or stays where an interrupted move
   already put it), and work no ledger entry names is recorded.
2. **Gates.** Stop if the loop is paused, if the circuit breaker has tripped
   (too many consecutive failures), or if the daily budget is spent.
3. **Pick.** Give every item that lacks one an id and an origin, then take
   an item you just decided, or the first eligible backlog item. A helper
   plans both as edits; the firing applies them and checks the result
   before it goes on (see [Items in `STATE.md`](#items-in-statemd)).
4. **Classify.** Label the item `mechanical`, `hard`, or `high-stakes`,
   picking the more cautious class when unsure. The triage workflow then
   runs as a second check.
5. **Execute** according to the level and class (see the table below).
   Write-capable work happens in the loop's clone. Preparing it first saves
   anything an interrupted firing left there to a recovery bundle, then
   resets it.
6. **Verify and commit.**
   - Every touched path must be inside `scope:`, which is the scope rail.
   - Every `verify:` command must pass.
   - Only then does the loop commit, in the clone, and write the day's
     delivery bundle for you to fetch.
   - The item moves to `## Done`, which keeps its 20 most recent items:
     an older one goes, as a whole block, only once the ledger records it
     done with the origin the block holds, and never while it holds an
     origin line other than one well-formed `origin:` field (the ledger
     keeps only that one). A
     helper plans this trim as edits; the firing applies them and checks
     the result.
7. **Failure path.** Retry once with the failure excerpt. After a second
   failure, save the task's changes to a recovery bundle, reset the clone,
   and move the item to `## Blocked`.
8. **Report.** Update `## Last run`, append exactly one ledger entry (it
   also records every `## Done` item no earlier entry records, so its id
   and origin outlive `## Done`), close the firing's run records, and
   release the lock.

| Level | `mechanical` | `hard` | `high-stakes` |
|---|---|---|---|
| **L1** (default) | Would-do plan only (`report-only`) | Would-do plan only (`report-only`) | Panel, then waits for your decision |
| **L2** | `fast-worker` executes | Parked as `waiting-level` | Panel, then waits for your decision |
| **L3** | `fast-worker` executes | `deep-reasoner` for analysis; Codex for implementation | Panel, then waits for your decision |

### The spine: `.tech-lead/`

| Path | What it is |
|---|---|
| `LOOP.md` | Configuration (see below) |
| `STATE.md` | Six sections: `## Now`, `## Backlog`, `## Needs decision`, `## Blocked`, `## Done`, `## Last run`. You can edit it directly to reorder, add, or veto items (see [Items in `STATE.md`](#items-in-statemd)) |
| `LEDGER.jsonl` | One JSON line per firing that took the lock and kept it: task, its item id and origin, class, outcome, verify, commits, triage, and panel |
| `briefs/` | Panel and Codex briefs, and commit subjects (gitignored) |

Up to 0.4.x the spine also held `worktree/`, the loop's git worktree, and
`worktree-deps.ok`. 0.5.0 leaves both in place and unused (see
[Upgrading to 0.5.0](#upgrading-to-050)).

The `LOOP.md` defaults:

```yaml
---
pattern: backlog-executor
level: 1                 # 1 report-only | 2 mechanical-only | 3 full execution
paused: false            # any runner must exit immediately when true
max_iterations_per_day: 8
max_consecutive_failures: 2
branch_prefix: tech-lead-loop   # commits land on <prefix>/<YYYY-MM-DD>
base: <default branch>   # each day's branch starts here, or from the newest loop branch not merged into it
triage: shadow           # off | shadow (log the Haiku second check) | gate (apply it, escalate-only)
codex_timeout_min: 45    # an L3 Codex job still running after this many minutes is stopped
verify:
  - <detected verify command, e.g. npm test>
  - <detected verify command, e.g. npm run typecheck>
scope:
  - ./
push: never              # literal; v1 has no other value
---
```

### Items in `STATE.md`

Each item in `STATE.md` is a header line with field lines under it
(`skills/loop/references/loop-templates.md` has every format). To add one,
write it in `## Backlog` where you want it picked, items above it first:

```markdown
- [ ] Add rate limiting to the upload endpoint · class: unclassified
  - origin: human
  - blocked-by: —
  - status: —
  - notes: 10 requests a minute per user; answer 429 with Retry-After
```

- **No id.** The next firing gives each item without an `id:` line a stable
  id (`tl-` and 8 characters), written first under its header, and writes
  `origin: unknown` on an item without an `origin:` line, so
  `origin: human` is optional. Never write an `id:` line yourself: the
  loop mints ids, a value of another shape is refused (`invalid-id`), and
  one id on two items parks both.
- **One title per open item.** Titles are unique among the items in
  `## Now`, `## Backlog` and `## Blocked`, case and spacing aside; the loop
  never renames your items. A title may not start with `P<digits> · ` or
  contain ` · class: ` or ` · attempts: `. `## Done` may hold any title.
- **`blocked-by:` takes an id,** copied from the other item's `id:` line,
  or `—`. The item waits until that item is in `## Done` (or the ledger
  records it done) and no follow-up the loop made from it
  (`origin: loop from <id>`) is still open. The loop never reads a title
  there as an item: it skips the item, and `## Last run` names the
  candidate id to write instead.
- **Field lines** are `- <label>: <value>`, indented two to four spaces.
  Only `notes:` and `decision:` continue on more lines, each indented two
  more spaces than the field's dash. Anything else under an item (a tab, a
  `*` bullet, a capitalized `Notes:`, a bold `**id:**`, a field line
  written at column 0 right below the header) keeps the item from being
  picked until you fix it.
- **Moving or reopening an item:** move its whole block, every field line
  with it, never a copy. To reopen a done item, move its block from
  `## Done` to `## Backlog` and rewrite its header in the Backlog form,
  `- [ ] <title> · class: <class>` (the `- [x]`, the sha and the date
  go), keeping every field line under it. A `- [x]` header left in
  `## Backlog` does not read as an item: the loop keeps every item that
  waits for it waiting, and skips the line (`unparsed-line`) until you
  rewrite it. The loop moves items the same way: it inserts the block at
  its new place first, deletes the old one, then checks the result.
- **Decisions.** When you fill in `**Decision:**` in a `## Needs decision`
  entry, the next firing copies it into the item's `decision:` field, after
  any earlier decision (`<old>; then: <new>`), and deletes the entry.
  Entries are headed `### <id> · <title>`, and the id is what finds the
  item. An older entry headed by its title alone is never released, and
  the open item with that title waits (`legacy-entry`) until you add the
  id to the heading.
- **Line endings.** Keep the file in LF line endings: the loop refuses a
  `STATE.md` that holds a carriage return (`crlf`).

### The firing lock

Every firing that finds a spine takes the project's firing lock before it
reads the spine, and releases it as its last command. Only one firing works
on a project at a time, whichever runner started it.

- **Where it lives.** Outside the project, in
  `~/.cache/tech-lead/<key>/lock`. `<key>` is the project folder's name
  plus a hash of its real path, so every path to the project, symlinks
  included, finds the same lock. A moved project gets a fresh one.
- **A held lock.** A firing that finds the lock held ends at the lock: it
  exits at once and writes nothing, not even a ledger entry. When another
  firing simply holds the lock, the runner tries again later; when the
  lock needs you, the runner stops (see
  [Troubleshooting](#troubleshooting)).
- **A lost lock.** A firing that loses the lock while it runs (your owner
  release, or another firing, took its generation over) stops at once and
  appends no ledger entry either. Ending at the lock and losing the lock
  are the only two ways a firing leaves no ledger entry.
- **Generations.** Each firing gets the next generation number, which is
  also its ledger `iteration`. Numbers only grow, and gaps are normal.
- **Children.** Verify commands and the dependency install run through
  the lock's `exec` wrapper, each in a process group of its own, and every
  Codex job is registered with the lock before it starts. When a firing
  dies, the next one stops its children (it kills their process groups and
  quiesces Codex) and only then takes the lock over. Every acquire stops
  any child still on record first, of the last generation or an earlier
  one. Age alone never frees a lock, and no watchdog process runs.
- **Processes it did not start.** Before it takes over from a firing that
  died or was interrupted, acquire also checks that no process has its
  working directory in the lock's cache folder (`~/.cache/tech-lead/<key>`,
  which holds the loop's clone) or in an old `.tech-lead/worktree`: a
  delegate's leftover command, a dev server, or a shell you opened there.
  Any it finds block the lock until they are gone; it never kills them. In
  the same way, a verify run or a dependency install that leaves a process
  behind (its process group survives, or a process still runs in the
  clone) ends `lingering`, and the loop pauses instead of counting it as a
  pass.
- **Status.** `node <plugin>/scripts/loop-lock.mjs status <project>`
  prints the last generation, its holder and whether it is alive, and every
  child record. It changes nothing.
- **Owner release.** When the lock stays held and you know its firing is
  not running (for example, a firing interrupted in a session that stays
  open while a background agent ran: `"reason": "dispatch-open"`), run
  `node <plugin>/scripts/loop-lock.mjs release <project> --generation <N> --owner`
  in your own terminal. It prints the status, asks you to type `<N>`, and
  releases without stopping anything. Child records that no acquire can
  read (or of a kind it does not know) are listed before the prompt and
  discarded once you confirm; nothing is signalled. Without a terminal it
  refuses and writes nothing. The next firing then stops every child the
  released generation left running (its process groups and Codex jobs)
  before it starts, and waits while any of them cannot be stopped.

### The work area

The loop works outside your project, in `~/.cache/tech-lead/<key>/`, where
`<key>` is the project folder's name plus a hash of its real path (the
lock's folder). Delegates and verify commands write inside `clone/`; every
other file there is created and removed by the loop's helper scripts, apart
from the set-aside folders that Troubleshooting has you make.
`node <plugin>/scripts/loop-review.mjs paths <project>` prints the folder,
the clone and the bundle folder.

| Path | What it is |
|---|---|
| `identity.json` | The project this folder belongs to |
| `lock/` | The [firing lock](#the-firing-lock) |
| `clone/` | The loop's clone: a full clone of your project (`git clone --no-local`) where delegates and verify commands work, and the only place the loop branch lives. Its `.git/tech-lead-deps.ok` marks installed dependencies |
| `out/<prefix>/<date>.bundle` | The delivery bundle of a day's loop branch, rewritten after each commit, with `<date>.bundle.json` (its tip and hash). A bundle that is replaced by unrelated history is kept as `<date>.bundle.prev-<stamp>` |
| `run/<N>.json` | The run record of firing `<N>`: what it prepared, committed and saved, so the next firing can recover an interrupted one. Deleted once it is settled and in the ledger |
| `run/refs.json` | The clone's refs as the last firing that deleted run records saw them, with the ignore rules the newest of those records recorded, so the next firing notices a ref changed in between, and lists files left in the clone under those rules, even when no run record is left. Rewritten by each such firing |
| `patches/<sha>.patch` | A recovery bundle: an attempt's work that the loop saved before it reset the clone, with `rules-<sha>.json` (the ignore rules the save used). Nothing prunes them |
| `clone.broken-<stamp>/`, `run.broken-<stamp>/`, `out.broken-<stamp>/` | A clone, run records or delivery bundles you set aside (see [Troubleshooting](#troubleshooting)); delete them once you have kept what you need |

A recovery bundle is a binary `git diff` against the base commit that its
first line names. `git apply` skips that header line, so you can replay a
bundle onto a checkout of its base: `git apply --binary <file>`.

### Reviewing loop work

The loop commits only inside its clone, and never touches your branches.
After each commit it writes the day's branch to a delivery bundle. Review it
from your own terminal: the review commands refuse to run without one, so no
firing can vouch for its own work.

```sh
node <plugin>/scripts/loop-review.mjs fetch <project>                    # all bundles, or --branch <prefix>/<date>
git -C <project> log <base>..tech-lead/<prefix>/<date>                   # what the loop did
git -C <project> diff <base>...tech-lead/<prefix>/<date>
git -C <project> merge tech-lead/<prefix>/<date>                         # keep it (or cherry-pick)
node <plugin>/scripts/loop-review.mjs retire <project> <prefix>/<date>   # reject it
```

- **`fetch`** checks each bundle first: exactly one branch, a tip that the
  ledger records or that your repository already has, every prerequisite a
  commit you already have, `git bundle verify`, and every object
  fsck-checked (the whole bundle is read even when your repository already
  holds its tip). Then it fetches the branch into
  `refs/remotes/tech-lead/<prefix>/<date>`, never forced. Each bundle's
  result is `fetched`, `current` (the ref already names its tip), `retired`
  (its tip is one you retired, so nothing is fetched), or `refused` with
  its reason, which makes the command exit 3. `--trust-unrecorded` accepts
  a tip that the ledger does not name, once you have checked it yourself.
- **`retire`** shows the branch's tip, asks you to type the branch name,
  and records it as `refs/tech-lead/retired/<prefix>/<date>` in your
  repository. The loop never builds on a retired tip again: the next firing
  starts that day's branch afresh. The rejected work stays in the retired
  ref and in its bundle file (a rewritten bundle keeps the old one as
  `.prev-<stamp>`).
  - After a retire, the next `fetch` replaces
    `tech-lead/<prefix>/<date>` with the restarted branch (its result names
    the old tip in `replaced`). Until then that ref still names the
    rejected work: do not merge it.
  - Retiring the same branch again, at its new tip, keeps the earlier
    rejection as `refs/tech-lead/retired/<prefix>/<date>@<sha12>` (the
    result's `kept`): a rejection is never dropped.
  - A retirement stops counting once your base contains its tip (you merged
    the work after all): later work on that branch is fetched again.
- **Never run git inside the clone yourself**, and never pull from it
  directly: the bundle is the way out.
- **The work area lives under `~/.cache`.** Clearing that folder deletes
  the clone, its run records, the recovery bundles, and every delivery
  bundle you have not fetched yet.

### Safety

- **Maturity ladder.** L1 is report-only, L2 is mechanical-only, and L3 is
  full execution.
  - After two consecutive report-only firings, the loop promotes itself once
    from L1 to L2, and records it.
  - Only you can set L3, by editing `level:`.
- **Brakes.**
  - A circuit breaker trips on consecutive failures. It pauses the loop and
    writes an incident.
  - A daily budget counts only work outcomes.
  - `paused: true` is the kill switch.
  - Infrastructure incidents park the item or pause the loop; they never
    retry in a loop.
- **Where commits land.**
  - Work is committed on `<branch_prefix>/<YYYY-MM-DD>` (UTC) inside the
    loop's clone, `~/.cache/tech-lead/<key>/clone`. Your working tree,
    your branches and your `.git` are not touched.
  - After each commit the loop writes the day's branch to a delivery
    bundle in `~/.cache/tech-lead/<key>/out/`, which you fetch (see
    [Reviewing loop work](#reviewing-loop-work)).
  - Each day's branch starts from `base:` in `LOOP.md`, or from the newest
    loop branch not yet merged into it (and not retired by you), never from
    the branch you have checked out.
  - Loop commits use your git identity, carry `Tech-Lead-Item:` (the
    item's id) and `Tech-Lead-Generation:` trailers and no Co-Authored-By
    line. Your project's git hooks do not run
    on them, so put the checks a hook enforces into `verify:`. They are
    never pushed or merged; reviewing and merging the loop branch is up to
    you.
  - **Work is saved before it is reset.** When an attempt fails twice, a
    delegate stops on a judgment call, or a firing is interrupted, the loop
    saves the attempt's changes to a recovery bundle before it resets the
    clone, and names the bundle's sha in `STATE.md`.
  - **Exception:** the one-time bootstrap commits the spine (`LOOP.md`,
    `STATE.md`, `LEDGER.jsonl`) and `.gitignore` on your current branch.
    After that the loop keeps updating those files and never commits them,
    so they show as modified in your tree.
- **Human gates.**
  - High-stakes items and delegate judgment calls stop in
    `## Needs decision`. Answer by filling in the item's `**Decision:**`
    line. Only you write that line: text from delegates and seats is
    flattened to one line and defanged before it lands in `STATE.md`.
  - The next firing copies your decision into the item's `decision:`
    field and moves the item back to the backlog. The item is reclassified
    as `hard`, or as `mechanical` only if the follow-up is fully specified,
    and never as `high-stakes`.
  - To resume: clear a `waiting-infra` status, or set `paused: false`.
- **Triage.** Runs in `shadow` mode by default, which only logs the Haiku
  second check. Switch to `gate`, which applies it (escalate-only), only
  after you have reviewed at least 20 logged rows. Count rows from plugin
  0.6.2 on: the checker is now Haiku 5.5 at effort `high`, and older rows
  came from a different checker.
- **Never.**
  - Push, open PRs, or merge.
  - Write your working tree or `.git` outside `.tech-lead/` (the one-time
    bootstrap aside: its `.gitignore` lines and commit).
  - Run `rm -rf`, `git reset --hard`, or anything with `--force`.
  - Touch files outside `scope:`.
  - Execute a high-stakes decision, or answer a delegate's judgment call
    itself.
  - Create the spine unattended.

The first run on a project bootstraps the spine interactively:

- it detects your verify commands;
- it builds the initial backlog with you, keeping each dependency your
  task sources name as `blocked-by: <the other item's title>` (the waiting
  item is skipped as `title-blocker` until you write the id that
  `## Last run` names as the candidate); a prerequisite titled like an
  empty blocker (`—`, `-`, `--`, `none` or `n/a`, in any case) is first
  renamed with ` (task)` appended, so the blocker still names it;
- it refuses to run on a dirty index.

### Upgrading to 0.5.0

0.5.0 moves the loop's work out of your project, into an isolated clone.

- **Loop commits leave your repository.** Up to 0.4.x the loop committed in
  `.tech-lead/worktree`, which shares your repository's branches. From
  0.5.0 it commits in the clone, and you fetch its work (see
  [Reviewing loop work](#reviewing-loop-work)).
- **The first write-capable firing creates the clone,** and adopts the
  dated loop branches your repository already has (and any you fetched into
  `tech-lead/…`), so a day's branch keeps chaining.
- **The old `.tech-lead/worktree` is left alone.** 0.5.0 never writes,
  resets or removes it; a later release retires it. Uncommitted edits that
  an interrupted 0.4.x firing left there are not carried over: check
  `git -C <project>/.tech-lead/worktree status --ignore-submodules=dirty`
  (which never runs git inside a nested repository), and keep what you need.
- **Dependencies are installed once more,** in the clone. The old
  `.tech-lead/worktree-deps.ok` is no longer read.
- **Headless runs need one more permission:** file edits in the clone (see
  [Running it](#running-it)).
- **Your project's git hooks no longer run on loop commits.** Put their
  checks into `verify:`.
- **Git 2.40 or newer.** The clone reads git attributes only from the base
  (`GIT_ATTR_SOURCE`), so a delegate's `.gitattributes` cannot hide a change
  from a save. An older git pauses the loop with "clone infra"
  (`git-too-old`) instead of saving without that protection.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Workflow ... not found` | Workflows register at session start | Restart the session. Until then, the skills fall back to Agent calls, and loop triage records `no-verdict` |
| `Failed to add marketplace: Marketplace file not found` | The ref you added has no `.claude-plugin/marketplace.json` (commits before the file existed) | Add the latest `main` with `JubaKitiashvili/tech-lead`, without pinning an older ref |
| The marketplace add or clone fails with an auth error | The repository is private, and git cannot prompt | Run `gh auth login && gh auth setup-git`, then check that `git ls-remote https://github.com/JubaKitiashvili/tech-lead.git` works |
| `tech-lead is already at the latest version` | `version` in `plugin.json` was not bumped | See [Releasing a new version](#releasing-a-new-version) |
| `/tech-lead` is unknown after a marketplace install | Another command already uses the bare name | Use `/tech-lead:tech-lead` |
| The panel reports "seat B empty" | Codex is missing, failed, or returned a background job id | Install Codex and run `/codex:setup`. Meanwhile the panel runs with seat A alone |
| A headless loop stalls, exits, or pauses itself | A denied permission, an untrusted folder, `claude` not on cron's PATH, or no spine yet | See [Running it](#running-it): absolute paths, a trusted first run, and the full allow list |
| The loop says "backlog dry" while items remain | The items wait on a decision, a level, or infrastructure, or their `blocked-by:` names an item that is not finished (still open, or a follow-up the loop made from it is open), or they are skipped for a problem in their lines. `## Last run` names each skipped item with its reason | Fill in `**Decision:**`, raise `level:`, clear `waiting-infra`, or fix what the reason names (see [Why the loop skips an item](#why-the-loop-skips-an-item)) |
| The loop paused with "item edits": `STATE.md` does not match the planned item edits (`mismatch`) | An edit the firing applied to `STATE.md` did not land as planned, or something else wrote the file at the same time (you, an editor, another tool). `## Last run` names what differs. The firing changed nothing else, and left `## Now` as it was | Check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`). Each item should appear once: when one sits in two sections, keep the copy in the section it was moving to and delete the other (when one copy is in `## Now` and the two copies are identical, apart from the header form and the line a move writes, such as a `status:` or `recovery:` line, the next firing does that itself; when they differ, it pauses with `now-conflict`). Run `node <plugin>/scripts/loop-items.mjs check <project>` (read-only), fix what its `problems` name, then set `paused: false` |
| The loop paused with "item edits" and `crlf` | `STATE.md` holds a carriage return (Windows line endings, often from an editor or git's `core.autocrlf`), which every item command refuses | Convert the file to LF line endings (for example `perl -pi -e 's/\r//g' <project>/.tech-lead/STATE.md`), then set `paused: false` |
| The loop paused with "item edits" and `bad-sections`, `now-occupied`, `bad-parent`, `bad-input` or `no-item` | `STATE.md` lacks a section or repeats one (`bad-sections`), or the firing found the file other than it left it: `## Now` not empty when it picked, the item it worked on gone or doubled. The detail names it | Restore the six sections (`skills/loop/references/loop-templates.md`), make sure each item appears once, then set `paused: false` |
| The loop paused with "item edits" and `now-conflict` | An interrupted firing left the item in `## Now` and its id on another item too, but the two are not one item caught halfway through a move: their title, notes or decision differ (you edited one), or their `blocked-by:`, `decided:` or `no-change-ok:` lines or origin lines do (a prerequisite you added to one copy included), or any other line under the header does (a field line you added or changed), `## Now` holds a second item, or more than two items (or an id line that does not read as an item) carry the id. The loop deletes neither copy. `## Last run` names the id, the reasons and every copy's section and line | Check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`). Keep the copy that holds what you want done and delete every other block that carries the id (every line of it). A copy you keep in `## Now` goes back to the top of `## Backlog` at the next firing. Run `node <plugin>/scripts/loop-items.mjs check <project>` (read-only), then set `paused: false` |
| The loop paused with "item edits" and an error (`"state": "error"`) | The item helper could not read what it needs: `LOOP.md`'s `level:` is not 1, 2 or 3 (`bad-level`), `LOOP.md` is missing (`no-loop-md`), `STATE.md` or `LOOP.md` is not UTF-8 (`bad-encoding`), `LEDGER.jsonl` cannot be read (`ledger: ...`), or a planned edit found no anchor in `STATE.md` (`edit-anchor`, for example a file whose last line has no newline). The detail names it | Fix what the detail names (a `level:` of 1, 2 or 3, the file saved as UTF-8, a readable ledger, a newline at the end of `STATE.md`), then set `paused: false` |
| A firing ends at once and writes nothing, not even a ledger entry, and the loop goes on | The project's [firing lock](#the-firing-lock) is busy: another firing holds it (`holder-live`) or took it first (`race`), or a holder's liveness could not be read just now (`holder-unknown`) | Nothing: a live holder finishes on its own, and a later firing takes the lock. If it keeps happening, run `node <plugin>/scripts/loop-lock.mjs status <project>`: a holder that stays alive without running a firing (an interrupted turn in a session that stays open) needs the owner release |
| A firing ends at once, writes nothing, and the runner stops | The lock needs you: an unreadable lock record (`corrupt`), a dispatch of an interrupted firing in this session still on record (`dispatch-open`), or a lock error (the printed `detail`, for example no holder process) | Run `node <plugin>/scripts/loop-lock.mjs status <project>`. If the firing that holds the lock is not running, use the owner release |
| The runner stops with `child-live` | A child of an earlier firing could not be stopped (`alive`), or a process has its working directory inside the lock's cache folder (which holds the loop's clone) or an old `.tech-lead/worktree` (`procs`): a delegate's leftover command, a dev server, or a shell you opened there. The lock waits until they are gone, and never kills a process it cannot prove is its own | End the listed processes yourself, or move your shells out of the clone, then run the loop again |
| The runner stops with `sweep-unknown` | The check for processes in the loop's clone and the lock's cache folder could not run: `ps` or `lsof` (macOS) or `/proc` (Linux) failed or was denied | Make sure the runner can run `ps` and `lsof` (or read `/proc`), then run the loop again |
| The lock fails with `not-toplevel` | `.tech-lead/` sits in a subdirectory of a git repository, and the loop runs only at a repository's top level | Move the spine (`.tech-lead/`) to the repository's top level, and run the loop with that path |
| The loop paused with "exec lingering", or "clone deps" with a lingering incident | A verify run or the dependency install left a process running: its process group survived, or a process still has its working directory in the loop's clone (named in `## Last run`) | End those processes, then set `paused: false` |
| The loop paused with "codex not quiet" | A Codex process may still be writing into the loop's clone (after a timeout, a failure, or an interrupted firing) | Run `node <plugin>/scripts/loop-codex.mjs quiesce --cwd <clone>`, with the clone path from the incident (or from `node <plugin>/scripts/loop-review.mjs paths <project>`) and the plugin folder this skill runs from; once it prints `"quiet": true`, set `paused: false`. `/codex:status` cannot see the clone's jobs |
| The loop paused with "clone busy" | A process has its working directory in the loop's clone (named in `## Last run`). The loop never kills it | End it, or move your shell out of the clone, then set `paused: false` |
| The loop paused with "clone invalid" or "clone tampered", or the recovery planner reports `clone-invalid` or `unknown-tip` | The clone is damaged, or something outside the loop changed it (a config key, a ref, a detached HEAD, a git storage path such as `.git/objects` replaced by a symbolic link, or HEAD moved off the base of an attempt the loop saved; named in `## Last run`). The same pause (or "save failed", or a reset incident, when the save or the reset meets it) comes when the clone itself or a folder of the work area (`patches/`, `run/`, `out/` or one below it) is a symbolic link. The detail then reads `clone-invalid: <path> is a symlink, not a directory in <work area>` (from `prepare`, `deps`, `check`, `bundle`, the save and the reset; `<path>` is the folder); for the clone itself, `check` and the save say `the clone root is not a real directory (a symlink)`, and the recovery planner `clone-invalid: <work area>/clone is not a directory (a symlink)`. A linked `patches/` behind which a run record names a recovery bundle reaches the recovery planner first, as `tampered` (the "recovery planner" row) | For a symbolic-link folder of the work area other than `clone`, check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`), then replace the link with a real folder holding a copy of everything behind it (recovery bundles, `rules-*.json` sidecars, run records and `run/refs.json`, delivery bundles and their `.json` sidecars), with `<path>` the folder the detail names: `mkdir <path>.copy && cp -pR <path>/. <path>.copy/ && mv <path> <path>.link-<stamp> && mv <path>.copy <path>`. What the link pointed to stays as it was. Never only move the link away: a run record would then name a recovery bundle that is gone, which the recovery planner reports as `tampered` before any firing can make the folder again, and without `run/refs.json` a same-day run can reset a loop commit nobody vetted. If the link points nowhere any more, its files are lost: move it away with `mv <path> <path>.link-<stamp>`, and follow the row for what the next firing reports (a lost recovery bundle: the "recovery planner" row). When that folder was `run/`, also set the clone aside (below), since nothing reports the lost `run/refs.json`. Then set `paused: false`. Otherwise (a symbolic-link `clone` included), set the clone aside. Check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`), fetch what the loop delivered (`node <plugin>/scripts/loop-review.mjs fetch <project>`), move the clone away with `mv <work area>/clone <work area>/clone.broken-<stamp>`, and set `paused: false`. The next firing makes a fresh clone; the old one keeps any uncommitted work |
| The loop paused with "clone save-failed", "save failed" or "clone unsavable" | Work in the clone could not be saved to a recovery bundle, so nothing was reset: a special or unreadable file, a nested repository, a submodule (gitlink) changed or removed, a bundle over 512 MiB (`too-large`; the biggest file is in `largest`), or HEAD no longer at the attempt's base (`head-moved`). The paths are in `## Last run` | When the detail names the clone or a folder of the work area as a symlink, follow the "clone invalid" row instead. Otherwise check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`), and move the named paths out of the clone with plain `mv` (keep them if you need them). For a path whose reason is `gitlink` (a submodule), move out whatever stands there, then put back an empty folder with `mkdir <work area>/clone/<path>`. For `too-large`, move out the `largest` path, or set the clone aside (the "clone invalid" row). For `head-moved`, move nothing: the next firing rewinds a commit made on top of the base, and the recovery planner reports `unknown-tip` for any other HEAD (then set the clone aside). Then set `paused: false` |
| The loop paused with "clone index-only" | The clone's index holds staged content found nowhere else (not in its files, the base, or any loop commit). The loop never discards it | Look at it with `node <plugin>/scripts/loop-clone.mjs git <project> -- diff --cached` (read-only) and keep what you need (`… -- show :<path>`). Then set the clone aside (the "clone invalid" row): moving files does not empty the index |
| The loop paused with "recovery planner" or "run record corrupt" (`tampered`, `corrupt`, `record-from-the-future` or `bundle-check`) | A run record in the work area does not read, names a generation newer than the firing, or points at a recovery bundle that is missing or changed; or a delivery bundle or its sidecar could not be read (`bundle-check: <branch>: …`, for example a permission or disk error). Named in the incident; the item the firing held is back at the top of `## Backlog` | Check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`) and fetch what the loop delivered (`node <plugin>/scripts/loop-review.mjs fetch <project>`). For `corrupt` or `record-from-the-future`, move the named run record into `<work area>/run.broken-<stamp>/`. For `tampered` whose detail ends with `(<work area>/patches is a symlink, not a directory)`, the bundle is not damaged: move no run record, and replace the link with a real folder as the "clone invalid" row says. For any other `tampered`, the incident names the recovery bundle: find the run record that names its sha with `grep -l <sha> <work area>/run/*.json` and move that record the same way. If it was the newest record, the next firing may pause with "clone tampered", which the "clone invalid" row's set-aside fixes (you may also set the clone aside right away). Never move `run/refs.json`: it is the check that notices a ref changed in the clone. For `bundle-check`, make the named file under `<work area>/out/` readable again, or move the bundle and its `.json` sidecar into `<work area>/out.broken-<stamp>/` (the next firing writes the bundle again). Then set `paused: false`. In `STATE.md`, replace any `recovery:` sha that names a bundle you moved or lost with `none` |
| The loop paused with "clone deps-dirty" | The dependency install changed files git does not ignore, for example a rewritten lockfile (named in `## Last run`) | Make the install leave tracked files alone (`npm ci`, not `npm install`), or ignore what it writes, then set `paused: false`. The next firing saves those files to a recovery bundle and resets them |
| The loop paused with "work changed" | The clone's files changed between the loop's last check and its commit. The loop saved the work to a recovery bundle (its sha is on the item) and reset the clone | Find what wrote into the clone, then set `paused: false` |
| The loop paused with "clone infra" and the incident names `git-too-old` | The loop needs a git that honours `GIT_ATTR_SOURCE` (git 2.40 or newer) to read attributes only from the base, so a delegate's `.gitattributes` cannot hide a change; this git does not | Upgrade git (check `git --version` on the runner's `PATH`), then set `paused: false` |
| The loop paused with "clone infra" naming files the switch to the day's branch would overwrite | The new day's branch tracks a path where the clone holds a file its ignore rules ignore (for example output the base now commits). The loop never overwrites it | Check that no firing holds the lock (`node <plugin>/scripts/loop-lock.mjs status <project>`), move the named files out of the clone with plain `mv` (keep them if you need them), then set `paused: false` |
| The loop paused with "clone unsafe-config", or "clone infra" or "save failed" naming `unsafe-config` | A filter or merge driver in your git config has a name the loop cannot switch off on its command line (it holds `=`, a line break, or bytes that are not UTF-8), so a git run in the clone could start that driver's program | Rename that `filter.<name>` or `merge.<name>` section of your git config, then set `paused: false` |
| The loop paused with "clone excludes-file" (`excludes-file-in-work-area`) | Your `core.excludesFile` lies inside the project or the loop's work area, where a delegate could edit the rules that keep a file out of a save | Move the file elsewhere (for example `~/.config/git/ignore`), point `core.excludesFile` at it, then set `paused: false` |
| Each firing's `## Last run` notes a clean-clone bundle of the same tool cache (for example `.pytest_cache`), and `close` keeps a record as `hidden` | A verify command creates a folder that ignores itself (its own `*` `.gitignore`), and your base `.gitignore` does not list it. The loop cannot tell that from a delegate hiding a file, so it saves and removes the folder each time | Add the folder to the `.gitignore` of your base branch |
| The loop paused with "clone infra", "clone error" or "no base" | A git failure, a shallow repository, no git identity in your repository, a first clone that took longer than 540 s, or a base the loop cannot find (named in `## Last run`) | Fix the named cause (for example `git config user.name` and `user.email`, `git fetch --unshallow`, or `base:` in `LOOP.md`), then set `paused: false` |

### Why the loop skips an item

Each firing writes the items it skipped to `## Last run`, as
"skipped <id> <title>: <reason> (<detail>)", and the problems it found in
`STATE.md` the same way. A skipped item stays where it is until you fix it.
See [Items in `STATE.md`](#items-in-statemd) for the format.

| Reason | What it means | Fix |
|---|---|---|
| `no-id` | The item has no `id:` line yet. The firing gives it one before it picks, so this means that step reported a problem | Look for the problem `## Last run` names first |
| `invalid-id` | The `id:` value is not a loop id (`tl-` and 8 characters; an empty value or `—` included), or the item has two `id:` lines. The loop never writes over it | Never delete a valid id: other items' `blocked-by:` and `origin: loop from` lines and `## Needs decision` headings name it, and a fresh id would cut those links. When the two `id:` lines carry the same id, delete only one of them. When they carry two ids, or the value is a damaged id, keep or restore the id that other lines name (in `STATE.md` or `LEDGER.jsonl`). Delete the `id:` line, so the next firing gives the item a fresh id, only when no other line names its id |
| `duplicate-id` | Two items carry the same id, in any sections (`## Done` included), or an `id:` line elsewhere names it too (in a block the loop cannot read, or under a `##` section that is not one of the six), so a blocker or a decision could mean either. Every carrier is skipped | Keep the id on the item it belongs to and delete the `id:` line of the copy (the next firing gives it its own id). To reopen a done item, move its block back, never copy it, and rewrite its header as `- [ ] <title> · class: <class>` |
| `duplicate-title` | Two open items have the same title, case and spacing aside. Both are skipped, and the detail names their ids | Rename one of them |
| `ambiguous-title` | The title is empty, starts with `P<digits> · `, or contains ` · class: ` or ` · attempts: `, so it would not survive a move to another section | Reword the title |
| `malformed-field` | A line under the item is not a field line: a tab indent, a `*` or `+` bullet, a capitalized label, markup around the label (`- **id:**`), a label without its colon (`- id tl-…`), a line under a one-line field, a line before the first field, or a field line at column 0 right below the item (an outdented `- blocked-by:`). The detail names the line | Rewrite it as `- <label>: <value>`, indented two to four spaces, or move the text into `notes:` |
| `duplicate-field` | A field appears twice (two `status:` or two `notes:` lines, for example) | Merge them into one line |
| `invalid-origin` | `origin:` is not `bootstrap`, `human`, `unknown` or `loop from <id>`. Any id in the value still counts as the item's parent | Fix the value, keeping the parent id of a `loop from` line |
| `origin-cycle` | The `loop from` links of some items lead in a circle | Fix the `origin:` lines of the items the detail names |
| `title-blocker` | `blocked-by:` holds a title, or anything else that is not one id. The detail names the candidate id (the one open item with that title, or else the one `## Done` item), and says "an analysis item; its follow-up may still be open" when that is a done analysis | Write the id instead (or `—`). For an analysis item, check whether the item waits for its follow-up, and use the follow-up's id if so |
| `unknown-blocker` | `blocked-by:` holds an id that no item and no ledger entry carries | Fix the id, or write `—` |
| `self-blocker` | `blocked-by:` holds the item's own id | Write the id of the item it waits for, or `—` |
| `blocked` | The item it waits for is not finished: it is still open, or an item the loop made from it (`origin: loop from <id>`, or further down that chain) is open, other than the waiting item itself and the items made from it. An `id:` or `origin:` line under a `##` section that is not one of the six, or under a `- [ ]` line in `## Done`, counts as open | Nothing: the item is picked once those are done. Write `—` to stop the wait. Move a stray `id:` line out of a section of your own, and reopen an unticked `## Done` item by moving its block to `## Backlog` |
| `status` | `status:` is `waiting-decision` or `waiting-infra`, or `waiting-level` while `level:` does not allow the item's class yet | Fill in its `**Decision:**`, clear `waiting-infra`, or raise `level:` |
| `unparsed-line` | A line at column 0 in `## Now`, `## Backlog`, `## Blocked` or `## Done` that is no item header in that section's form (`- [x]` outside `## Done`, a `*` bullet, plain text) | Rewrite it as an item, or delete it |
| `legacy-entry` | A `## Needs decision` heading is not `### <id> · <title>` (an entry written before items had ids). Its decision is not released; the detail names the candidate id. The open item whose title the heading names is skipped too, so it never runs without that decision; its detail names the heading's line | Rewrite the heading as `### <id> · <title>`, with the item's id |
| `orphan-entry` | A decided entry names an id that no item carries. The loop keeps the entry and does not recreate the item | Rewrite the heading with the id of the item the decision is for (the next firing releases it), or delete the entry |
| `entry-item-done` | A decided entry names an item that is in `## Done` | Reopen the item (move its whole block back to `## Backlog`, its header rewritten as `- [ ] <title> · class: <class>`), or delete the entry |
| `ambiguous-decision` | The entry has two `**Decision:**` lines | Keep one |
| `ambiguous-carrier` | A decided entry names an id that more than one block carries, or that a line which does not read as that item carries (an `id:` line of a block the loop cannot read, a capitalized `ID:`), so the decision could be meant for either. The loop keeps the entry and writes the decision into no copy | Keep the id on the item the decision is for: delete the other copy, or fix its id line (the next firing releases the decision) |

## Releasing a new version

1. Bump `version` in `.claude-plugin/plugin.json`. Leave it out of
   `marketplace.json`, because `plugin.json` wins.
2. Run the repository checks and the unit tests; both must pass:

   ```sh
   node scripts/check.mjs
   node --test "tests/**/*.test.mjs"
   ```

   Quote the glob: `node --test tests/` does not run the suite on Node 22.
3. Validate the marketplace file and the manifest:

   ```sh
   claude plugin validate --strict .
   claude plugin validate --strict .claude-plugin/plugin.json
   ```

4. Commit and push. Optionally, tag the release with
   `claude plugin tag --push`, which creates `tech-lead--v<version>` and
   refuses to run on a dirty tree.
5. Users update:
   - marketplace install: `claude plugin update tech-lead@tech-lead`;
   - clone: `git pull`.

   Either way, they then restart the session.

## Repository layout

```
.claude-plugin/
  plugin.json          manifest: name, version, skill paths
  marketplace.json     makes the repo installable as tech-lead@tech-lead
SKILL.md               /tech-lead: orchestration, bench, models and effort, Workflow mode
agents/
  fast-worker.md       Sonnet, effort high; mechanical execution
  deep-reasoner.md     Opus, effort xhigh, read-only; independent analysis
  triage.md            Haiku, Read-only; loop triage via its workflow
skills/
  quick/               /tech-lead:quick, the draft-PR lane
  panel/               /tech-lead:panel
  research/            /tech-lead:research
  loop/                /tech-lead:loop, plus references/ (bootstrap, spine templates, clone contract)
workflows/
  panel.js     tech-lead:panel-seats     (named apart from the /tech-lead:panel skill)
  fanout.js    tech-lead:fanout
  research.js  tech-lead:research-lanes  (named apart from the /tech-lead:research skill)
  triage.js    tech-lead:triage
references/
  briefing-template.md   the brief every delegate gets
  panel-protocol.md      seats, independence, empty seats, follow-ups
  decision-contracts.md  the reflex rules and JSON contracts
templates/
  rules-tech-lead.md     the optional always-on routing rule
scripts/
  check.mjs              repository checks (node scripts/check.mjs)
  lib/, checks/          loader, stub Workflow runtime, the loop's shared helpers, and the check modules
  loop-*.mjs             helpers the loop runs (text neutralizer, start point, Codex job, firing lock, recovery planner, clone)
  reflex-bundle.mjs      recovery bundles: save the clone's work, then reset it
  loop-review.mjs        your review of loop work: fetch and retire (your terminal only; no skill runs it)
tests/                   unit tests (node --test "tests/**/*.test.mjs")
docs/superpowers/        design specs and implementation plans
```

## Credits

- The reflex layer borrows the typed-decision pattern of TypeSafe's
  [Jev](https://docs.typesafe.ai) and the open-source
  [Laya](https://github.com/NandhaKishorM/laya), along with their
  ecosystem's asymmetric routing and shadow mode. It has no dependency on
  either: a JSON-schema `agent()` call is the typed decision primitive.
- The loop methodology draws on
  [loop-engineering](https://github.com/cobusgreyling/loop-engineering).
