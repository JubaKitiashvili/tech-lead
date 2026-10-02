# tech-lead

Model-tiered orchestration for [Claude Code](https://code.claude.com). Your
main session acts as the tech lead: it plans, keeps the reasoning, makes the
decisions, and checks the results. Delegates take the work that would waste
its context or usage:

- cheaper Claude models do exploration and mechanical edits;
- a fresh-context Opus seat and OpenAI Codex give independent second opinions;
- Workflow scripts turn panels, fan-outs, research, and loop triage into
  typed contracts that code enforces.

**Version 0.3.4.** Tested with Claude Code 2.1.284 on the Anthropic API.

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

- **Claude Code 2.1.284 or later** (`claude --version`). The model names in
  this README assume the Anthropic API. On Bedrock, Vertex, Foundry, and
  Claude Platform on AWS, the model aliases resolve to older models.
- **Dynamic workflows.** Workflows are available on paid plans and the API;
  on Pro, turn them on in `/config`. `"disableWorkflows": true` or
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1` switches them off. Without Workflow the
  commands fall back to plain Agent calls. The one exception is loop triage,
  which records `no-verdict`.
- **`git`**, plus **`gh`** logged in. `/tech-lead:quick` needs a GitHub remote,
  and the research lanes use `gh` for GitHub lookups.
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
| `Explore` (built-in) | Inherits the main model (capped at Opus). The skill always passes `model: "sonnet"`, or `"haiku"` for pure lookups | Session level; a plugin can't pin it | Built-in, read-only | Search fan-out that returns conclusions, not file dumps |
| `tech-lead:fast-worker` | `sonnet`: Sonnet 5.5 | `medium` | Read, Grep, Glob, Write, Edit, Bash | Complete specs that have a check: repetitive multi-file edits, boilerplate, test and build runs. Stops on judgment calls |
| `tech-lead:deep-reasoner` | `opus`: Opus 5.5, fresh context | `xhigh` | Read, Grep, Glob | Independent deep analysis of a well-scoped problem; panel seat A |
| `tech-lead:triage` | `haiku`: Haiku 4.5 | none (Haiku has no effort parameter) | Read | The loop's escalate-only second check; runs only through its workflow |
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
Anthropic's documentation on 2026-09-29. In short:

- **The orchestrator is Opus 5.5.** It is the default model, and the `opus`
  alias resolves to it from Claude Code 2.1.280.
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
  deep-reasoner; `max` is the last effort step.
- **Aliases, not model IDs.** Agents and scripts name `opus`, `sonnet`, and
  `haiku`, so they follow the aliases when new models ship. Haiku 5.5 is
  announced, for example. The plugin never names `fable`, or `best`, which
  resolves to Fable: a verified re-check on 2026-09-30 found no role for
  Fable 5.1 here (see "No Fable tier" in SKILL.md).

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
| `tech-lead:fanout` | `repo` (absolute) and `tasks` (`{id, brief, files: [absolute paths]}`, with disjoint file sets) | `summary` (count per status) and `results` (one entry per task: `id`, `status`, `report`, `out_of_scope`) | Paths are normalized, kept inside the repo, and never shared by two tasks; each task gets a status |
| `tech-lead:research-lanes` | **Required:** `question` and `scratch` (absolute). **Optional:** `context`, `lanes` (`{key, prompt}`), `model` | `lanes` (one entry per lane, with `corrected_summary`, `confirmed_facts`, `verified_ideas`, `verified_risks`, `refuted`, `unverifiable`) and `unverified_lanes` | An independent fact-checker verifies every lane, and only the verifier's output is returned |
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
inspects its diff, then fixes or re-dispatches. A worker's optional
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
   it. The plan is shown before anything runs, unless you said to just go.
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
  agents.
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
scheduler.

### Running it

- **By hand.** `/tech-lead:loop ~/code/my-app`. Without a path, it uses the
  current directory.
- **In a session.** `/loop /tech-lead:loop ~/code/my-app`. The loop paces
  itself. The runner stops when:
  - the backlog is dry (this includes every item waiting on you);
  - the daily budget is spent;
  - the loop is paused;
  - an infrastructure incident happened.
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
    - git;
    - your verify commands. The delegate runs them in
      `.tech-lead/worktree`; the loop's own verify runs go through
      `node <plugin>/scripts/loop-lock.mjs exec`;
    - your dependency install (for example `npm ci`), through the same
      `exec` wrapper. It runs in `.tech-lead/worktree` on the first
      write-capable firing, and a denial pauses the loop;
    - `shasum` and `xargs`, for the panel's snapshot of the project;
    - `rm`, to remove a failed task's new files;
    - `node`, at every level, for the loop's helper scripts in the plugin's
      `scripts/`, and for the Codex companion at L3;
    - file edits;
    - the `Workflow` tool.
- **Not supported:** cloud routines, which cannot see your local tree.

Scheduled firings never ask questions. Anything that needs you goes into
`STATE.md`.

### One iteration

1. **Rehydrate.** Take the project's [firing lock](#the-firing-lock); a
   firing that finds it held exits and writes nothing. Then read
   `LOOP.md`, `STATE.md`, and the recent ledger. An interrupted item goes
   back to the backlog.
2. **Gates.** Stop if the loop is paused, if the circuit breaker has tripped
   (too many consecutive failures), or if the daily budget is spent.
3. **Pick.** Take an item you just decided, or the first eligible backlog
   item.
4. **Classify.** Label the item `mechanical`, `hard`, or `high-stakes`,
   picking the more cautious class when unsure. The triage workflow then
   runs as a second check.
5. **Execute** according to the level and class (see the table below).
6. **Verify and commit.**
   - Every touched path must be inside `scope:`, which is the scope rail.
   - Every `verify:` command must pass.
   - Only then does the loop commit.
7. **Failure path.** Retry once with the failure excerpt. After a second
   failure, reset the task's changes and move the item to `## Blocked`.
8. **Report.** Update `## Last run`, append exactly one ledger entry, and
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
| `STATE.md` | Six sections: `## Now`, `## Backlog`, `## Needs decision`, `## Blocked`, `## Done`, `## Last run`. You can edit it directly to reorder, add, or veto items |
| `LEDGER.jsonl` | One JSON line per firing that took the lock: task, class, outcome, verify, commits, triage, and panel |
| `briefs/` | Panel and Codex briefs (gitignored) |
| `worktree/` | The loop's git worktree (gitignored) |
| `worktree-deps.ok` | Marker for installed dependencies (gitignored) |

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

### The firing lock

Every firing that finds a spine takes the project's firing lock before it
reads the spine, and releases it as its last command. Only one firing works
on a project at a time, whichever runner started it.

- **Where it lives.** Outside the project, in
  `~/.cache/tech-lead/<key>/lock`. `<key>` is the project folder's name
  plus a hash of its real path, so every path to the project, symlinks
  included, finds the same lock. A moved project gets a fresh one.
- **A held lock.** A firing that finds the lock held exits at once and
  writes nothing, not even a ledger entry.
- **Generations.** Each firing gets the next generation number, which is
  also its ledger `iteration`. Numbers only grow, and gaps are normal.
- **Children.** Verify commands and the dependency install run through
  the lock's `exec` wrapper, each in a process group of its own, and every
  Codex job is registered with the lock before it starts. When a firing
  dies, the next one stops its children (it kills their process groups and
  quiesces Codex) and only then takes the lock over. Every acquire stops
  any child still on record first, of the last generation or an earlier
  one. Age alone
  never frees a lock, and no watchdog process runs.
- **Status.** `node <plugin>/scripts/loop-lock.mjs status <project>`
  prints the last generation, its holder and whether it is alive, and every
  child record. It changes nothing.
- **Owner release.** When the lock stays held and you know its firing is
  not running (for example, a firing interrupted in a session that stays
  open while a background agent ran: `"reason": "dispatch-open"`), run
  `node <plugin>/scripts/loop-lock.mjs release <project> --generation <N> --owner`
  in your own terminal. It prints the status, asks you to type `<N>`, and
  releases without stopping anything. Without a terminal it refuses and
  writes nothing. The next firing then stops every child the released
  generation left running (its process groups and Codex jobs) before it
  starts, and waits while any of them cannot be stopped.

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
  - Work is committed on `<branch_prefix>/<YYYY-MM-DD>` (UTC) inside
    `.tech-lead/worktree`. Your working tree is not touched.
  - Each day's branch starts from `base:` in `LOOP.md`, or from the newest
    loop branch not yet merged into it, never from the branch you have
    checked out.
  - Loop commits carry no Co-Authored-By line. They are never pushed or
    merged; reviewing and merging the loop branch is up to you.
  - **Exception:** the one-time bootstrap commits the spine (`LOOP.md`,
    `STATE.md`, `LEDGER.jsonl`) and `.gitignore` on your current branch.
    After that the loop keeps updating those files and never commits them,
    so they show as modified in your tree.
- **Human gates.**
  - High-stakes items and delegate judgment calls stop in
    `## Needs decision`. Answer by filling in the item's `**Decision:**`
    line. Only you write that line: text from delegates and seats is
    flattened to one line and defanged before it lands in `STATE.md`.
  - The next firing moves the item back to the backlog. The item is
    reclassified as `hard`, or as `mechanical` only if the follow-up is fully
    specified, and never as `high-stakes`.
  - To resume: clear a `waiting-infra` status, or set `paused: false`.
- **Triage.** Runs in `shadow` mode by default, which only logs the Haiku
  second check. Switch to `gate`, which applies it (escalate-only), only
  after you have reviewed at least 20 logged rows.
- **Never.**
  - Push, open PRs, or merge.
  - Run `rm -rf`, `git reset --hard`, or anything with `--force`.
  - Touch files outside `scope:`.
  - Execute a high-stakes decision, or answer a delegate's judgment call
    itself.
  - Create the spine unattended.

The first run on a project bootstraps the spine interactively:

- it detects your verify commands;
- it builds the initial backlog with you;
- it refuses to run on a dirty index.

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
| The loop says "backlog dry" while items remain | The items wait on a decision, a level, or infrastructure, or their `blocked-by:` names an item that isn't done or doesn't exist (see `## Last run`) | Fill in `**Decision:**`, raise `level:`, clear `waiting-infra`, or fix the `blocked-by:` line |
| A firing ends at once and writes nothing, not even a ledger entry | Another firing holds the project's [firing lock](#the-firing-lock), or a child of an interrupted firing could not be stopped yet (the printed `reason`). Or the lock failed (the printed `detail`, for example no holder process) | Run `node <plugin>/scripts/loop-lock.mjs status <project>`. A live holder finishes on its own. If its firing is not running and the lock stays held (`dispatch-open`, for example), use the owner release |
| The loop paused with "codex not quiet" | A Codex process may still be writing into `.tech-lead/worktree` (after a timeout, a failure, or an interrupted firing) | Run `node <plugin>/scripts/loop-codex.mjs quiesce --cwd <project>/.tech-lead/worktree` (the plugin folder this skill runs from); once it prints `"quiet": true`, set `paused: false`. `/codex:status` cannot see the worktree's jobs |

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
  fast-worker.md       Sonnet, effort medium; mechanical execution
  deep-reasoner.md     Opus, effort xhigh, read-only; independent analysis
  triage.md            Haiku, Read-only; loop triage via its workflow
skills/
  quick/               /tech-lead:quick, the draft-PR lane
  panel/               /tech-lead:panel
  research/            /tech-lead:research
  loop/                /tech-lead:loop, plus references/ (bootstrap, spine templates, worktree contract)
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
  loop-*.mjs             helpers the loop runs (text neutralizer, start-point, Codex job, firing lock, recovery planner)
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
