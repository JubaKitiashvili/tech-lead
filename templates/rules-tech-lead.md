---
description: tech-lead routing — always-on guidance for which tech-lead skill a task type goes to, which tasks stay out of it, and where routing must stop (subagents, workflow agents, teammates)
alwaysApply: true
---

<description>
The tech-lead plugin (`~/.claude/skills/tech-lead`) is the entry point for execution work bigger than one edit, for expensive-to-reverse decisions, for vetting an external dependency, for small changes the user wants shipped as a PR, and for backlog runs. This rule picks the skill by task type, so routing does not depend on the user saying the exact trigger phrases.
</description>

<recursion_safety>
<important>Only the top-level session routes. Check this before the routing table.</important>
This rule does not apply, and no tech-lead skill is invoked because of it, when any of these holds:

- your system prompt says you are a subagent, an agent spawned by a workflow or orchestration script, or a teammate;
- your task arrived as a brief from another agent (an Agent/Task call, a Workflow `agent()`, a SendMessage);
- you are already executing a tech-lead skill for the current task. Follow that skill; do not re-route mid-task.

A hand-off written inside a tech-lead skill (for example quick proposing `/tech-lead`) is that skill's own instruction, not this rule.
</recursion_safety>

<routing>
<important>When a task matches a row, invoke the row's skill with the Skill tool as your FIRST action: before scouting the repo, before reading files, before writing a plan or a Workflow script. The skill does its own scouting and owns the Workflow decision.</important>

Judge the task type from the request itself; do not open files to size it first. Check the rows in order; the first match wins.

| # | Task type | Skill |
|---|-----------|-------|
| 1 | The user wants a small, bounded change shipped as a PR ("… and open a (draft) PR"), even a one-file change | `tech-lead:quick` |
| 2 | One decision that is expensive to reverse: datastore, architecture, data model, public API shape, migration strategy, security design, major dependency ("hard to change later", "we must choose between X and Y") | `tech-lead:panel` |
| 3 | Evaluating an external library, tool, model, repo, or dataset before adopting or borrowing from it ("check whether X is any good before we adopt it") | `tech-lead:research` |
| 4 | Working through a project backlog or `.tech-lead/` spine, or a `/loop` or cron prompt `Run /tech-lead:loop <path>` | `tech-lead:loop` |
| 5 | A multi-part goal: a feature, refactor, migration, or audit that touches 3+ files or 2+ subsystems (backend + frontend, API server + mobile client, an audit of the whole repo) | `tech-lead` |

If the request names two or more layers or subsystems, or asks for an audit of the whole repo, it is row 5 even if it sounds routine. The word "across" alone does not make row 5: one mechanical change repeated over files is a do-not-route task.
</routing>

<do_not_route>
These stay in the current session without tech-lead:

- questions and explanations ("what does X do", "explain the difference between …");
- single-file edits with no PR requested (a typo, a color, one unit test, one function);
- one mechanical change repeated over files with no PR requested (a rename, a find-and-replace, a year or version bump), even when the request says "across the repo" or "everywhere";
- a quick opinion on a library with no adoption decision in the request ("is X worth using?", "is X still maintained?"): answer directly, and mention that `/tech-lead:research` can run a vetted evaluation;
- debugging (an error, a stack trace, a failing test, "why does this fail"): use `superpowers:systematic-debugging`. Route to `tech-lead:quick` only once the fix itself is known and a PR is wanted;
- trivial tasks you would finish in a couple of tool calls.
</do_not_route>

<process_order>
Process skills come before execution skills:

- New work with no approved design (a new feature, component, or behavior change): `superpowers:brainstorming` first. After the user approves the design or plan, route the execution by the table.
- The user says the design, plan, or spec is approved, or one already exists: skip brainstorming and route straight by the table.
- Audits, decisions, research, backlog runs, and mechanical changes (renames, moves) need no brainstorming step.
</process_order>

<workflow_opt_in>
Routing to a tech-lead skill is not an opt-in to the Workflow tool. Use Workflow only under the opt-in rules the tech-lead skill already has: ultracode is on, the user asked in their own words for a workflow or multi-agent orchestration, the user typed a `/tech-lead…` slash command, or the user said yes when the skill offered one.

For a task that matches the routing table, do not hand-write your own Workflow script in place of the skill. Load the skill first; it names the registered workflow (`tech-lead:panel`, `tech-lead:fanout`, `tech-lead:research`, `tech-lead:triage`) when one applies.
</workflow_opt_in>
