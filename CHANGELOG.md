# Changelog

One entry per released version, newest first. A change merged without a
version bump is listed under the next version that followed it. Numbers such
as #39 are pull requests in this repository.

## What counts as a breaking change

Before 1.0.0 anything could change in any release. From 1.0.0 on, a release
that breaks one of these raises the major version:

- the command and skill names: `/tech-lead`, `/tech-lead:quick`,
  `/tech-lead:panel`, `/tech-lead:research`, `/tech-lead:loop`;
- the agent names (`tech-lead:fast-worker`, `tech-lead:deep-reasoner`,
  `tech-lead:triage`) and the registered workflow names with their
  documented `args`;
- the files a project keeps in `.tech-lead/`: the keys of `LOOP.md`, the
  item format of `STATE.md`, and the fields of `LEDGER.jsonl`. A new
  optional key or field is not a break. A removed or renamed one, or one
  whose meaning changes, is. A release that needs a one-time migration of
  these files is a break even when it ships the migration;
- the commands the README tells you to run yourself, such as
  `loop-lock.mjs status` and `loop-lock.mjs release --owner`.

Not part of that promise: the wording of the skill files, the other helper
scripts and their output, the loop's work area under `~/.cache/tech-lead/`,
the checks, the tests and the evals. A higher minimum Claude Code version is
a minor release, named in its entry.

## 1.0.1 — 2026-11-24

- The loop skill loads less on every firing. `skills/loop/SKILL.md` went
  from 59,205 to 41,671 bytes: the recovery actions, the picking rules, the
  level 3 branches, the high-stakes panel steps and the failure path moved
  word for word into `skills/loop/references/`, and the skill reads each
  file only when a firing reaches that branch. No behaviour changed.
- A new check keeps every reference file named in the skill, and every
  named reference present.
- A new live scenario, `failing-l2`, runs a firing whose verification can
  never pass and checks the retry, the saved bundle, the reset and the
  Blocked item. All six live scenarios pass on Opus with the split skill.

## 1.0.0 — 2026-11-24

The first stable release. Nothing in the protected surface changed since
0.9.6; from this version on, the rule above holds.

- `/tech-lead:quick` ends its report with a pointer to `/steward`, for Claude
  Code v2.1.330 or later (#43).
- README: where the model-pin hook does not run (#43).

## 0.9.6 — 2026-11-24

- macOS: a process group whose last member was just reaped no longer reads as
  alive while another process's `ps` or `lsof` listing holds the kernel's
  record of it. An `exec` run could report `lingering: true` for a command
  that left nothing behind (#42).

## 0.9.5 — 2026-11-23

- A hook refuses an `Agent` call from the lead that has no `model` and would
  inherit the session model (#39).
- Live loop evals: one real firing in a scratch repository, graded from disk
  (#38).
- README: the firing lock's known limits (#40).

## 0.9.4 — 2026-11-23

- Linux: a process that exits while the lock probes it reads as gone, not
  unknown (#37).

## 0.9.3 — 2026-11-21

- README recommends `gpt-6.2-sol` for the Codex seat and ships a config
  template (#36).
- `check.mjs` fails on a tag in a skill description and on a `SKILL.md` past
  its ceiling (#34).
- README covers the skill grade step, the skill-file checks, CI and evals
  (#35).

## 0.9.2 — 2026-11-20

- Every skill reaches grade A on SkillEvaluator's quality check, gated in CI
  (#33).

## 0.9.1 — 2026-11-18

- Evals for the review and delegate rules; every `Agent` call carries a model
  (#32).

## 0.9.0 — 2026-11-18

- A hook checks delegate reports against the report contract, in observe
  mode (#31).

## 0.8.9 — 2026-11-18

- Prompt audit of the skill files for Fable 5.2 (#30).

## 0.8.8 — 2026-11-17

- The reviewer is started with `Agent` and a `name` (#29).

## 0.8.7 — 2026-11-17

- Verification and review rules (#28).

## 0.8.6 — 2026-11-14

- A finite wait ceiling for scheduled headless runs (#27).

## 0.8.5 — 2026-11-12

- Headless runs keep the background wait ceiling off (#26).

## 0.8.4 — 2026-11-12

- A model facts table and a facts check (#25).
- The test suite passes on Linux; CI requires both systems (#23).

## 0.8.3 — 2026-11-11

- The plan ends with a `Done when:` line; the loop cannot open a question
  dialog (#24).

## 0.8.2 — 2026-11-11

- The skill is written for a Fable 5.2 lead; `xhigh` only for the reviewer
  (#22).

## 0.8.1 — 2026-11-11

- A resume notice after compaction; plan files in multi-repo folders (#21).
- Models reference: the Fable 5.2 announcement and the model-choice playbook
  (#20).

## 0.8.0 — 2026-11-11

- `/tech-lead` records a larger plan in a plan file, with validation, waves
  and status (#18, #19).
- MIT license (#17).
- CI runs the checks and the test suite on every pull request (#15).

## 0.7.4 — 2026-11-11

- The lead is told when the session model changes (#16).
- The eval suite gains loop and guard cases (#14).

## 0.7.3 — 2026-11-11

- A behaviour eval suite; the lead stops after the plan (#13).

## 0.7.2 — 2026-11-11

- `SKILL.md` keeps the rules; sources and history move to a reference (#12).

## 0.7.1 — 2026-11-10

- Stakes per task, an effort recommendation, fewer lead turns (#11).

## 0.7.0 — 2026-11-10

- Fable 5.2 may lead a session; it is never a delegate (#10).

## 0.6.2 — 2026-11-10

- `fast-worker` and triage run at `high`; model facts for Claude Code 2.1.321
  (#9).

## 0.6.1 — 2026-11-10

- Sub-skill effort in frontmatter; research fact-checkers pinned to `opus`
  (#7, #8).

## 0.6.0 — 2026-10-07

- Loop: stable item ids, origins, unique open titles (#6).

## 0.5.0 — 2026-10-03

- Loop: an isolated clone, a patch helper, recovery (#5). See "Upgrading to
  0.5.0" in the README.

## 0.4.1 — 2026-10-02

- The fanout and research workflows keep every task and lane (#4).

## 0.4.0 — 2026-10-02

- Loop: the firing lock (#3) and safety fixes (#2).

## 0.3.4 — 2026-10-02

- The check harness (#1).
