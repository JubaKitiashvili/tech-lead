# System 1 layer for tech-lead: design

- **Date:** 2026-09-30
- **Status:** revision 7. Design approved section by section; revisions 1-4
  each went through a cross-family review (Claude critic lenses with
  adversarial verification, plus Codex gpt-6.1-sol). Round 4, run under a
  stopping rule (blockers and design-level majors only), found no blockers;
  revision 5 settled its design-level majors (§17). Revision 6 applies the
  stage 0c amendment set the owner approved on 2026-10-01 (§17), found by the
  stage 0c design run. Revision 7 (2026-10-03) reconciles §7.5's two ignore-rule
  statements, as the owner approved during the stage 0c-2 design (§17).
- **Plugin version at design time:** 0.3.3 (HEAD 642edc6); Fable was removed
  in 0.3.4
- **Architecture chosen:** `hybrid-staged`, as amended (see §17)
- **Scope:** umbrella design. Implementation plans are written per delivery
  stage (§10), each with its own PR. §16 lists items deliberately left to those
  plans.

## 1. Context and goals

tech-lead already has a small "reflex layer" (`references/decision-contracts.md`,
`workflows/triage.js`): typed, categorical, escalate-only decisions whose policy
runs in code. It covers one decision (loop §4 triage) in shadow mode, and it has
gaps the 2026-09-30 audit confirmed: gate mode fails open when the checker is
missing, pre-classified items skip the check, the recall metric only counts
failed items, the model's own class is dropped, and the ledger records no
decision id, rubric version or model.

The owner wants a full System 1 layer in the spirit of TypeSafe's Jev and of
Laya, built as our own code, with four goals:

- **A. Typed routing:** which executor, model tier and effort a task gets.
- **B. Safety gates for unattended runs:** escalation, scope, and accepting a
  delegate's result.
- **C. Lower cost without quality loss:** Sonnet is the default decision model;
  Haiku is used only where paired measurement shows no quality loss.
- **D. Learning from outcomes:** a decision journal, human labels, calibration
  and policy evolution.

### Non-goals

- No runtime dependency on Jev, Laya, or any third-party API. Jev output is
  never used as labels or as a teacher (TypeSafe MCA §2.3(b)).
- No probability thresholds on model-reported numbers. `agent({schema})` exposes
  no token probabilities.
- The loop's deterministic gates (pause, circuit breaker, daily budget, scope
  rail, verify, commit) are not replaced by model judgments.
- Interactive-session decision points (executor choice at dispatch, panel
  trigger, quick §1 escalation) and LLM prompt hooks are out of scope. They get
  their own spec after the loop slice has evidence (§10, stage 6).

### Threat model

- **Trusted:** the owner and the owner's terminal; the main session, which may
  make mistakes (mis-copied values) but is not adversarial; Claude Code's hook
  runner; the plugin's own code.
- **Untrusted:** item text from backlogs and issue trackers; repository content;
  delegate output; anything a delegate, a delegate-edited script, or a verify
  command writes.
- **Goal:** untrusted input can at worst cause over-escalation or a pause.
  Governance state (policy, sign-offs, loop state, dispatch authority, guard
  evidence) lies outside every path untrusted code can write (§4). Where
  untrusted code can write (its own work area), the writes are tamper-evident
  and checked before use (§7.8).
- **Injected instructions that aim at data egress** are in scope. Item text
  could lead a delegate to write code that reads files and sends them to an
  allowed host with a credential planted in the item. Controls: reads are
  denied by default outside the project, the work area, toolchains and temp
  (§7.6); credential stores and inherited credentials are unreadable; direct
  publish commands are denied (§7.7); item text containing credential-like
  strings, publish or upload instructions, or foreign URLs hits a
  `high-stakes` floor (§7.1), so a human sees it first; Codex, whose own
  credential would be readable inside the sandbox, is off in sandboxed runs
  unless the owner signs it on (§7.6). What remains is §15's residual.
- **Out of scope:** a deliberately malicious project or dependency that attacks
  the runner itself. The containment reduces what such code can reach but
  cannot rule out misuse of an allowed network host. Unattended runs are meant
  for repositories whose code the owner trusts.

## 2. Principles

The existing reflex rules stay, with two wording changes made in stage 1
(§9.3): rule 3 becomes "a model verdict may only add caution; completion or
acceptance is never granted by a model", and rule 4 cites §6.4 for promotion.
This design adds:

1. **Facts first.** Deterministic facts (git output, verify exit codes, the
   scope rail, spine fields) are computed by a script before any model call.
   When a fact already yields the most cautious value of a type's order, the
   model is skipped (`via: code`).
2. **Typed failures.** Every decision returns `ok` or `unavailable(reason)`. A
   failure is never read as "no". Each type declares one failure action from a
   closed set (§5.7); gates never fail open.
3. **Floors and facts bind in every mode except `off`, with or without the
   Workflow tool.** The main session computes them with the same registry code
   the workflow uses. Only the model-derived part of a decision is log-only in
   shadow.
4. **Direction is judged per type, not per mode.** For an escalate-only type,
   gate is never less cautious than shadow, so gate → shadow and shadow → off
   are de-escalations.
5. **What binds without sign-off:** floors and facts; plugin changes carried by
   a caution certificate (§5.9); pausing the loop; raising an audit share.
6. **What needs owner sign-off:** moving a type to gate; any de-escalation
   (gate → shadow, shadow → off, a cheaper primary model, a lower class, fewer
   checks, looser thresholds); any change to a gated type without a caution
   certificate; acknowledging a kill.
7. **One place per decision type.** Questions, floors, fact definitions,
   derivation, caps, failure action, defaults and version live in one registry
   entry. Project-specific mode and thresholds live in one policy record whose
   sign-off lives outside the project (§6.2).

## 3. Architecture

| Component | Where | Job |
|---|---|---|
| Registry | `workflows/decide.js`, one marker-delimited literal (§5.1) | Defines each decision type. |
| Decide workflow | `workflows/decide.js`, registered as `tech-lead:decide` | Model part of a decision: one `agent()` call (plus an optional challenger call), validation, the gate combination, the envelope. |
| Decider agent | `agents/decider.md` (`tech-lead:decider`) | The only agent type decide.js uses. Tools: `["Read"]`. Replaces `agents/triage.md`. |
| Facts script | `scripts/reflex-facts.mjs` | Deterministic part: facts, floors, caps, the base value and the decision packet, via the shared registry loader; validates the policy against the external sign-off ledger and the runtime identity. |
| Bundle builder | `scripts/reflex-bundle.mjs` | Builds content bundles and the shared patch helper (§7.5). |
| Report | `scripts/reflex-report.mjs` | Journal appends, statistics, review sheet, label ingest, replay, init, promote, sign, demote, kill check and acknowledgement. |
| Caution certificates | `certificates/<type>/<from>-<to>.json` (plugin tree) | check.mjs-generated proofs that a registry change is at least as cautious (§5.9). |
| Registrar hooks | `hooks/hooks.json` + `hooks/registrar.mjs` | PreToolUse(Agent), SubagentStart and SubagentStop hooks that create, bind and remove dispatch records. |
| Delegate guard | `hooks/hooks.json`, `hooks/delegate-guard.sh`, `hooks/delegate-guard.mjs` | Deterministic PreToolUse veto on tech-lead delegates' Bash, Write and Edit; writes guard evidence. |
| Worker clone | `<V>/clone` | An isolated full clone that delegates and verify commands work in. Replaces the git worktree. |

`<P>` is the loop's project path and `<S>` = `<P>/.tech-lead` (governance).
`<V>` = `~/.cache/tech-lead/<key>` is the untrusted work area, kept
outside `<P>` so that the owner's own tools (test runners, indexers) that crawl
`<P>` never pick up delegate-written files. `<W>` = `<V>/clone`. `<X>` =
`~/.claude/tech-lead`.

`<key>` names a project on disk: `<slug>-<h>`. `<R>` is the real path of `<P>`
as realpath(3) returns it (in Node, `fs.realpathSync.native`): every symlink
resolved and, on a case-insensitive volume, the on-disk case. `<slug>` is the
basename of `<R>` lowercased, with every character outside `[a-z0-9._-]`
replaced by `-`, cut to 64 characters, and `project` when empty. `<h>` is
the first 16 hex characters of SHA-256 over the UTF-8 bytes of `<R>`. The key
depends neither on `LOOP.md` nor on the branch checked out, so every firing of
one project, through any symlink, computes the same `<V>` and the same lock.
`<V>/identity.json` records `<R>`; a firing that finds a different `<R>`
there refuses to use that `<V>`. Moving the repository yields a new `<key>`
and a fresh `<V>` (the old one is left for the owner to delete). §6.2's
`project_id` stays the identity bound into sign-offs; it is a value inside
files, never a path segment. Stage 0c neither computes nor stores it; stage 1
defines which commit "the first commit" means when a repository has several
roots.

`<P>` must be the top level of a git working tree: its real path equals
`git -C <P> rev-parse --show-toplevel` (a linked worktree qualifies). Bootstrap
and the §9.1 migration check this before writing anything and refuse a
subdirectory of a repository, including a legacy spine kept in one; the owner
moves the spine to the top level first.

```
main session ── reflex-facts.mjs: packet, facts, floors, base, policy check ──┐
     │                                                                         ▼
     ├─ Workflow tech-lead:decide (decider: Sonnet; Haiku sample) ─────→ applied
     ├─ journals in <V> (hash-chained; head in <S>/CHAIN.json) ← decisions
     └─ dispatch loop-worker ─ registrar hook writes <X>/dispatch/…
                              ─ OS sandbox: writes only <V> and temp
                              ─ delegate guard (veto) writes <X>/guard/…
                              ─ checks after every untrusted execution (§7.8)
```

Why these boundaries:

- Workflow scripts cannot read files, so the registry lives inside `decide.js`
  as one literal. check.mjs, reflex-facts.mjs, reflex-bundle.mjs and
  reflex-report.mjs evaluate the same literal, so floors, facts and derivation
  have one implementation.
- Mode and evidence live per project because calibration does not transfer
  across projects (the Janus result in the ecosystem survey).
- Plugin subagents ignore `hooks` in their frontmatter, so all hooks are
  plugin-level `hooks/hooks.json` entries that filter on `agent_type`
  (`plugin:<plugin>:<agent>`), which hooks receive inside subagents.
- A command hook that errors or times out does not block a tool call; only
  exit 2 or a JSON deny does. The guard is therefore a veto layer; containment
  comes from the OS sandbox.
- Hook commands and the owner's terminal run outside the sandbox, and
  sandboxed commands cannot write most of `~/.claude`. So `<X>` holds the state
  no untrusted process may write: runner settings, dispatch records, guard
  evidence and sign-offs.

## 4. Layout and write authority

| Location | Contents | Who can write it |
|---|---|---|
| `<X>/runners/<key>.json` | Runner settings (from stage 2) | Owner terminal (bootstrap, from stage 2) |
| `<X>/signoffs/<key>.json` | Signed policy digests, demotions, kill acknowledgements | Owner terminal (`reflex-report.mjs --sign`, `--demote`, `--ack-kill`) |
| `<X>/dispatch/<session_id>.json` | Dispatch records | Registrar hooks |
| `<X>/guard/<key>.jsonl` | Guard decisions (heartbeat) | Delegate guard hook |
| `<S>/LOOP.md`, `STATE.md`, `POLICY.json`, `CHAIN.json`, `SPINE.json` | Governance | Main session's Write/Edit tools; `POLICY.json` only by `reflex-report.mjs` in the owner's terminal |
| `<V>/` | Worker clone, journals, snapshots, patches, bundles, review sheet, lock, spine copy | Main session's sandboxed Bash, delegates, verify commands |
| `<P>` (user tree and `.git`) | The owner's repository | Nobody in an unattended run |

- From stage 2, in an unattended run the sandbox's write set is `<V>` and the
  per-user temp directory only (before stage 2, see §15). Governance in `<S>` is written through the main
  session's Write and Edit tools, which the guard denies to delegates outside
  `<W>`.
- **Governance write mechanism (selected by probe P5).** The contract: the main
  session's Write/Edit can change the governance files; no sandboxed process
  can. Claude Code adds Edit allow-rule paths to the sandbox's writable set, so
  the mechanism is chosen from, in order: (a) exact-file Edit allow rules for
  the governance files plus the same paths in `sandbox.filesystem.denyWrite`,
  if denyWrite does not also block the Edit tool; (b) governance kept under
  `<X>/projects/<key>/` and written by the Edit tool, if protected-path
  rules permit that; (c) otherwise, unattended runs have no write-capable
  dispatch. The loop also hashes the governance files before and after every
  untrusted execution, in case the guard was inactive.
- `POLICY.json` holds the thresholds and mode; its sign-off digest is valid
  only if it matches `<X>/signoffs/<key>.json`. The main session never
  writes `POLICY.json`; a pause is `paused: true` in `LOOP.md`.
- Every file under `<S>` is ignored by git on every branch (stage 0c untracks
  the spine; audit loop02), through the repository's exclude file: the path
  `git -C <P> rev-parse --path-format=absolute --git-path info/exclude`
  prints (in a linked worktree, the common directory's file). Bootstrap and the
  §9.1 migration add `/.tech-lead/` there, keep the file's other lines, and
  verify the result with `git check-ignore`; a rule that un-ignores the spine
  makes them refuse. A new spine is never committed. A spine that was tracked is
  untracked by the §9.1 migration, which also commits a `/.tech-lead/` line in
  `.gitignore` so other clones of the repository ignore it.
- **Branch-switch hazard.** Git overwrites ignored files on checkout, so
  checking out a branch that still tracks the spine replaces the live spine
  with that branch's copy (and switching back deletes it). After each firing the
  loop copies `LOOP.md`, `STATE.md` and `LEDGER.jsonl` (never `POLICY.json`
  or `CHAIN.json`) to `<V>/spine`, and writes their byte lengths and SHA-256
  values to `<S>/SPINE.json`, a file no branch has ever tracked, so no checkout
  rewrites it. At §1, under the firing lock and before anything is written: the
  spine is **lost** when `SPINE.json` exists and a spine file is missing, and
  **regressed** when `LEDGER.jsonl` no longer begins with the bytes anchored in
  `SPINE.json` (the ledger is append-only, so owner edits to `LOOP.md` and
  `STATE.md` between firings never look like a regression). A lost or regressed
  spine makes an unattended firing exit without writing. An interactive firing
  shows the owner the difference between the live spine and the copy, and
  restores the copy only on the owner's confirmation and only when the copy
  still matches `SPINE.json`; edits made since the last firing are lost
  unless the owner merges them by hand.
- **No governance writes over a tracked spine.** Before a restore or any
  governance write, the loop refuses when HEAD or the index tracks a path under
  `.tech-lead/`; the owner switches to a migrated branch or runs the §9.1
  untracking first, and a confirmation never bypasses this.
- The copied files and the regression check follow the stages: in stage 0c the
  copy covers `LOOP.md`, `STATE.md` and `LEDGER.jsonl`. When stage 1 moves the
  ledger into `<V>`, the copy keeps `LOOP.md` and `STATE.md`, regression is
  judged against the journal head that `CHAIN.json` records, and the stage 1
  migration rewrites `SPINE.json` before scheduled runs resume.
- **Scope (stage 0c).** `scope:` in `LOOP.md` lists repository-relative
  directory paths. One validator, used by bootstrap, the §9.1 migration and a
  loop §2 gate before any pick, canonicalizes them (no leading `./`, no
  trailing `/`) and refuses an absolute path, a `..` component, an empty
  entry and every spelling of the whole repository (`.`, `./`, `/`, empty;
  audit loop07). A path is in scope when one of its leading path components
  equals an entry (`src` holds `src/a.js`, not `src-old/a.js`); a path whose
  real path leaves the repository is out of scope.

## 5. Decision contract

### 5.1 Registry

`decide.js` holds the registry between `// REGISTRY-BEGIN` and `// REGISTRY-END`
as one object literal. check.mjs asserts there is exactly one such block. The
loader (from `docs/superpowers/specs/assets/check-prototype.mjs`) extracts and
evaluates it in a function scope with the question helpers defined.

```js
'loop.class': {
  rubricVersion: 1,
  models: { primary: 'claude-sonnet-5-5',
            allowed: ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] },
  effort: 'medium',
  challenger: { model: 'claude-haiku-4-5-20251001', share: 0.2 },
  order: ['mechanical', 'hard', 'high-stakes'],         // low → high caution
  state: { title: { max_chars: 300 }, notes: { max_chars: 8000 } },
  floors: [ { id: 'auth-path@1', field: 'notes', re: /…/, value: 'high-stakes' } ],
  facts: { /* named fact definitions, e.g. test globs, marker lists */ },
  questions: {
    security_or_auth: noul('Does the item touch authentication, …?',
                           { yes: '…', no: '…' }),
    class: choice('How expensive is this item to reverse?',
                  { mechanical: '…', hard: '…', 'high-stakes': '…' }),
  },
  logOnly: ['suggested_executor', 'suggested_effort'],
  derive(answers, facts) { /* pure; returns { value, reasons[] } */ },
  cap(value, facts, reasons) { /* optional; §7.1 only */ },
  onUnavailable: 'skip-firing',                          // closed set, §5.7
  defaults: { target_miss_rate: 0.05, review_share: 0.25, label_coverage: 0.9,
              kill: { needless_rate_max: 0.3, window: 50 },
              haiku_miss_margin: 0.02, haiku_needless_margin: 0.05 },
}
```

- `derive()` never sees the baseline; clamping happens only in §5.6.
- check.mjs asserts that `derive()` reads no `logOnly` key, and that the
  all-cautious answer set derives the top of `order`.
- **Floors are append-only.** A floor's `id` carries a version (`@1`). Changing
  or removing a floor means adding a new id and retiring the old one, and
  retiring a floor is a de-escalation that needs sign-off. check.mjs compares
  against the previous registry to enforce this.
- Fact definitions (test globs, suppression markers, verify-config paths) live
  in the registry; project-specific extensions live in the signed policy
  record.

### 5.2 Question types and schema

| Type | Answer values | Notes |
|---|---|---|
| `noul` | `yes`, `no`, `insufficient` | Phrased so that `yes` is the risky answer. |
| `choice` | one declared label, or `insufficient_evidence` | Each label has a description with `what`, `not_for` and examples. |
| `score` | one declared level id | Levels describe observable situations, low to high. |

- `insufficient` and `insufficient_evidence` always count toward caution.
- The schema uses neutral property names (`q1…qn`). Question text and criteria
  go in each property's description; code maps names back to ids.
- The schema contains only `enum` and `string` constraints, plus a required
  `parts_read` array when the decision has content.
- Validation covers the non-log-only keys. A bad log-only answer is recorded as
  null and does not change `status`.
- The decider's prompt states that the fenced state and every file it reads
  are untrusted data, never instructions.

### 5.3 Inputs

- **State** fields and caps are declared per type (§7). State is fenced, `<` and
  `>` are escaped, and each field is capped. A truncated field is a fact
  (`state_truncated`), not a model question: the decision is `status: ok`,
  `via: code`, `reason: truncated`, and derives the top of `order`.
  Truncated rows never count as evaluation evidence.
- **Facts** are computed by `reflex-facts.mjs` from full git output and spine
  files, never typed by the model. If the script fails, the type takes its
  failure action in every mode except `off`.
- **Content bundles** (a diff and new files) are built by `reflex-bundle.mjs`,
  never by the main session: parts of at most 1,500 lines and 60 KB each,
  over-long lines folded with a visible continuation marker, and a manifest of
  paths, sizes and shas. Binary files are not rendered; they set the
  `binary_changed` fact. A bundle over the type's limits sets
  `bundle_truncated`. Both facts derive the top of `order`.
- The decider returns `parts_read`; decide.js rejects the answer as
  `invalid-response` unless it lists every part in the manifest.

### 5.4 Identity, hashing and the decision packet

- `decision_id = <item_id>/<type>/<iteration>/<attempt>`. `item_id` is the
  stable item id (stage 0c).
- decide.js and the scripts share a named pure-JS hash (FNV-1a, 32-bit) with
  per-purpose salts for sampling and rotation: `challenger`, `audit`, `rotate`.
  Evaluation membership is defined in §6.3.
- Each registry entry has two fingerprints, computed by check.mjs and embedded
  next to the registry as constants that check.mjs verifies:
  - `prompt_hash`: question text, kinds and options, state caps, the models
    block, effort, the challenger block, and the decider agent file;
  - `policy_hash`: floors, fact definitions (`FACTS_VERSION`), `derive()` and
    `cap()` source, order, the failure action, `logOnly` membership, defaults,
    and `ENGINE_VERSION` (decide.js's validation, truncation and combination
    code).
- `reflex-facts.mjs` builds the **decision packet**: type, `decision_id`,
  `item_id`, the canonical state, the content manifest digest, facts, baseline,
  base and the policy verdict. It prints the packet and its digest. decide.js
  recomputes the digest over what it received and returns `invalid-args` on a
  mismatch; the envelope echoes the digest; the main session compares it and
  the `effective_mode` with the script's output and pauses on a mismatch. This
  catches copying errors by the main session.

### 5.5 Arguments, policy verdict and envelope

```
args: { packet, packet_digest }
```

`reflex-facts.mjs` computes the policy verdict:

- `off` only if the record says off and its digest matches a sign-off entry in
  `<X>/signoffs/<key>.json` for this project;
- `gate` if the record says gate, its digest matches a sign-off entry for this
  project, its hashes match the registry or are reached from the signed hashes
  by a chain of caution certificates (§5.9), its model is in `models.allowed`,
  and the runtime identity is verified;
- `paused` if a gated type fails any of those checks, if the latest sign-off
  entry shows gate but the record now says otherwise without a signed
  `demoted` entry, or if the runtime identity cannot be verified; the loop runs
  `pause-loop`;
- `shadow` otherwise.

`effective_model` is the signed record's model for a gated type, otherwise the
registry's `models.primary`.

```
envelope: { decision_id, item_id, type, rubricVersion, prompt_hash, policy_hash,
  packet_digest, model, effective_mode,
  status: 'ok' | 'unavailable',
  reason: null | 'no-verdict' | 'invalid-response' | 'invalid-args' | 'truncated' | 'error',
  via: 'code' | 'model',
  baseline, base, model_raw, model_derived: {value, reasons} | null,
  applied, capped: bool,
  challenger: null | { status, reason, model, raw, derived },
  audit: bool, audit_primary: null | { status, reason, model, raw, derived },
  state_hash, excerpt, calls, wall_ms }
```

- Every `agent()` call is wrapped: null maps to `no-verdict`; a throw maps to
  `invalid-response` (schema failure) or `error`, with a capped message.
- The challenger and audit calls run inside `parallel([...])`, so their failure
  never changes the primary's `status`.
- `workflow-missing` and `not-permitted` are journaled by the main session when
  the Workflow tool itself fails.

### 5.6 Applying policy

For a type with caution order `order`:

```
base    = max(baseline, floor, fact)              computed by reflex-facts.mjs
model   = derive(answers, facts).value            only when status is ok

off                          applied = baseline
shadow                       applied = cap(base)
gate, status ok              applied = cap(max(base, model))
gate, status unavailable     the type's failure action (§5.7)
Workflow unavailable         applied = cap(base) in shadow; failure action in gate
```

- decide.js recomputes the floors and facts it can see and returns
  `invalid-args` if they differ from the packet.
- The model is skipped (`via: code`) only when `fact` equals the top of `order`
  (this includes `state_truncated`, `bundle_truncated` and `binary_changed`).
- `cap` is the identity except for the §7.1 decided-item cap. A cap may lower
  `applied` below `floor` or `model`, never below `baseline`.

**Invariants checked by check.mjs** over every answer combination, baseline,
floor hit and fact value of every type:

1. Monotonicity: moving any noul toward `yes`/`insufficient`, or any choice
   toward a more cautious label or `insufficient_evidence`, never lowers
   `derive()`; the all-cautious answer set derives the top of `order`.
2. `applied >= baseline` in every mode.
3. `applied >= max(floor, fact)` in every mode except `off`, and except where a
   documented cap applies.
4. No answer value outside the type's order; no value grants a permission.
5. The `via: code` short-circuit fires only at the top of `order`.

### 5.7 Failure actions

| Action | Loop effect |
|---|---|
| `skip-firing` | The item goes back to the top of `## Backlog` with its status unchanged; outcome `skipped`, note naming the reason; the runner stops. Two consecutive firings skipped for the same reason escalate to `pause-loop`. |
| `ask` | Upsert a `## Needs decision` entry; item status `waiting-decision`; outcome `flagged`. Used only where no edits exist. |
| `flag-with-patch` | Save the attempt with the shared patch helper (§7.5), reset the clone, then act as `ask` with the patch bound to the entry. Used wherever edits exist. |
| `pause-loop` | Save any edits with the patch helper, then `paused: true` in `LOOP.md`; outcome `halted`; an incident in `## Last run` naming what failed; the owner is notified (§6.6). |
| `baseline` | Apply the baseline. Allowed only where the baseline is itself a bounded deterministic rule (verify_failure: retry once, then block). |

- **Preflight.** At pick time the loop determines every decision type the item
  can reach in this firing. If any of them is gated and cannot run (Workflow
  not opted in, not permitted, or missing), the item returns unchanged before
  dispatch: outcome `skipped`, note "gate needs Workflow". Shadow types
  continue with `cap(base)`.
- If Workflow becomes unavailable after edits exist, a gated type takes its
  failure action (`flag-with-patch` for post-edit points).
- Configuration incidents and `skip-firing` never count as clean firings for
  the L1 → L2 promotion.

### 5.8 Journal, snapshots and replay

The journals live in `<V>/` (the only area the loop's scripts can write):

```
DECISIONS.jsonl:
{ kind: 'decision', ts, prev, ...envelope, snapshot: 'decisions/<decision_id>.json', snapshot_sha }
{ kind: 'label', ts, prev, decision_id, item_id, by: 'human', correct, sheet_hash }
{ kind: 'policy', ts, prev, type, event, detail }
LEDGER.jsonl: one row per firing, with `prev` and `decisions: [decision_id]`
```

- **Hash chain.** Each row carries `prev`, the hash of the previous row. After
  each append the main session writes the new head and row count into
  `<S>/CHAIN.json` with its Edit tool. Every read of a journal first verifies
  the chain against `CHAIN.json`; a mismatch runs `pause-loop` and names the
  file.
- `decisions/<decision_id>.json` holds the complete evaluated packet and the
  model raw answers; its sha is in the chained row.
- `registry/<policy_hash>-<prompt_hash>/decide.js` archives the whole
  `decide.js` (registry, helpers and engine) the first time a fingerprint pair
  is used; its sha goes into a chained `policy` row.
- **Historical replay** runs a past packet through its archived `decide.js`
  and refuses rows whose snapshot or archive is missing or fails its sha.
  **Counterfactual replay** applies the current policy to past model answers
  and is labelled as such.

### 5.9 Versioning, certificates and runtime identity

- `rubricVersion` bumps when either fingerprint changes.
- Decision models are pinned by full model id. This is a documented exception
  to the plugin's "aliases, not model IDs" rule: sign-offs need a stable model
  identity, and an alias can resolve to the main session's model or be changed
  by an environment variable. `claude_version` is metadata only.
- **Caution certificates.** When a registry change keeps `prompt_hash` and
  check.mjs proves the new applied policy pointwise at least as cautious as the
  old one (floors, including regex semantics via the append-only rule; facts;
  derive; cap; order; failure action; `logOnly` membership) over every answer
  combination of the old questions, check.mjs writes
  `certificates/<type>/<old policy_hash>-<new policy_hash>.json`, committed with
  the change. A signed configuration stays gated across any chain of such
  certificates. Any other change, including a model change or a prompt change,
  makes the type `paused` until the owner signs the new configuration.
- **Evidence for re-signing.** A paused type resumes only through the owner:
  either a signed demotion to shadow (floors keep binding) to collect a fresh,
  unused eval cohort for the new configuration, or a signature on fresh
  evidence. Re-running the new configuration on an already-labelled cohort is
  diagnostic and regression evidence only, because the owner has seen those
  items' answers; it never counts toward §6.4 or §6.7.
- **Runtime identity.** At firing start `reflex-facts.mjs` checks for model and
  provider overrides (`CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`,
  `ANTHROPIC_MODEL`, the Bedrock, Vertex and Foundry switches) and the runner
  settings disable model fallback. After each decide call the report reads the
  decider's transcript (from the workflow run's transcript directory) and
  compares the recorded model with the requested one (probe P9). An override,
  a mismatch or an unreadable transcript marks the row unverified: gated types
  are `paused`, and unverified rows are excluded from evidence.

## 6. Staged adoption and autonomy

### 6.1 Modes and transitions

| From → to | Trigger | Sign-off |
|---|---|---|
| (none) → shadow | Type registered; no record | no |
| shadow → gate | Promotion criteria met (§6.4) | **yes** |
| shadow → off | Owner decision | **yes** |
| gate → shadow / off | Owner decision (`--demote`) | **yes** |
| gate → gate (new configuration) | A caution certificate chain (§5.9) | no |
| gate → paused | Uncertified change, model change, invalid record, unverified runtime, kill | no |
| paused → gate | Owner signs the current configuration, or acknowledges the kill | **yes** |

The main session only pauses. It never demotes, never writes `POLICY.json`, and
`--init-policy` never overwrites an existing record.

### 6.2 Policy record and sign-off ledger

Created by `reflex-report.mjs <P> --init-policy` with the registry defaults and
`mode: shadow` (bootstrap runs it in an interactive session).

```json
{ "loop.class": {
    "mode": "shadow",
    "project_id": "<realpath of P>|<sha of the first commit>",
    "rubricVersion": 1, "prompt_hash": "…", "policy_hash": "…",
    "model": "claude-sonnet-5-5",
    "target_miss_rate": 0.05, "review_share": 0.25, "label_coverage": 0.9,
    "kill": { "needless_rate_max": 0.3, "window": 50 },
    "haiku_miss_margin": 0.02, "haiku_needless_margin": 0.05,
    "facts_ext": { "test_globs": [], "verify_config_paths": [] },
    "codex_in_sandbox": false,
    "evidence": null } }
```

- `--promote <type>` writes the proposed record and its evidence to
  `<V>/POLICY.draft.json`.
- `--sign <type>` runs only in an interactive terminal (it refuses without a
  TTY), shows the draft and the evidence, asks the owner to type the type name,
  moves the draft into `POLICY.json`, and appends `{type, project_id,
  record_digest, evidence_hash, signed_at}` to `<X>/signoffs/<key>.json`.
  The digest is a SHA-256 over the canonical record.
- `--demote` and `--ack-kill` work the same way and append their own entries.
- Owner-provenance fields that change behaviour are set the same way:
  `no-change-ok` (§7.2) and `decided` stamps (§7.1) are written by
  `reflex-report.mjs --mark` in the owner's terminal, which also appends to the
  sign-off ledger; the loop honours a stamp only if the ledger has it.

### 6.3 Evaluation cohort

- For each `(type, prompt_hash, policy_hash)` the cohort is every item with
  `hash(item_id|prompt_hash|policy_hash|review) < review_share`, excluding
  items already labelled in an earlier cohort of the same type (a used item is
  never evaluation evidence twice). The observation for an item is its first
  decision of that type under that configuration. Membership is frozen when the
  observation is journaled.
- The cohort splits by `hash(item_id|split)` into `tune` and `eval` halves. The
  owner may study `tune` rows when revising a rubric; promotion and parity
  statistics use `eval` only.
- Promotion needs labels on at least `label_coverage` (default 90%) of the eval
  half's observations; `skip` counts as unlabelled. Unavailable, truncated or
  unverified observations are recorded with that disposition; if they exceed
  10% of the eval half, promotion is blocked.

### 6.4 Promotion to gate

On the eval half, over observations with `via: model` and `status: ok`:

1. **Positives:** items whose correct value is above the baseline. The one-sided
   95% Clopper-Pearson upper bound on misses ÷ positives must be below
   `target_miss_rate`. For a 5% target that needs at least 59 positives with
   zero misses, or 93 with one; a 1% target needs 299 with zero misses.
2. **Needless escalations:** among eval observations where
   `model_derived > baseline`, the share whose correct value is below
   `model_derived` is at or below `kill.needless_rate_max`.
3. **Golden set:** the candidate configuration runs on
   the plugin's `tests/golden/<type>.jsonl` plus the project's
   `<S>/golden/<type>.jsonl` with zero under-escalations; the run's hash goes
   into the evidence.
4. Diagnostic strata (disagreements, audit rows, escalations) are reported
   separately; any miss found there blocks promotion until explained.
5. `--promote` writes the draft with the evidence and the cohort hash; the owner
   signs (§6.2).

### 6.5 Labels

- Only human labels count. Model labels, including an Opus "reference", never
  count toward promotion (rule 6).
- `reflex-report.mjs <P> --review N` writes `<V>/REVIEW.md`: eval-cohort
  entries first, then tune and diagnostic entries. Each entry has a
  script-owned heading `### <decision_id>`, the evidence in a fenced block with
  every line prefixed (so item text cannot forge sheet syntax), and one anchor
  line `label[<decision_id>]: ` for a value from the type's order or `skip`.
- Cohort and audit entries are **blind**: they show the item and the execution
  evidence (the diff, verify results) but not the model answers, `applied`, the
  route taken, or outcomes a model influenced. Those appear after the label is
  ingested. Diagnostic entries may show answers.
- `--ingest` accepts only changes to anchor lines, checked against a skeleton
  hash stored in `CHAIN.json`, and appends chained `label` rows with
  `sheet_hash`. It refuses to overwrite a sheet that still has un-ingested
  labels.
- Code derives, per primary and per challenger:
  `missed = correct > max(baseline, model_derived)` and
  `needless = model_derived > baseline && correct < model_derived`.

### 6.6 After gating

- **Audit slice:** 2% of gated decisions, chosen by `hash(id|audit)`, always
  call the model and go on the review sheet (blind). While Haiku is primary,
  the audit call is made by Sonnet and journaled in `audit_primary`.
- **Kill check:** `reflex-report.mjs <P> --kill-check` runs at loop §1 and exits
  3 when, over the **signed lineage** (every configuration reached by caution
  certificates since the last sign-off or acknowledgement), either any eval or
  audit label is a miss, or the needless rate over the last `kill.window` model
  escalations exceeds `kill.needless_rate_max`. The loop then runs
  `pause-loop`; the type stays in gate. A miss also adds the item to the
  project's golden file `<S>/golden/<type>.jsonl`; only the owner copies items
  into the plugin's `tests/golden/`.
- **Acknowledgement:** a pending kill clears only through the owner's terminal:
  `--ack-kill <type>` (after the golden set, including the new misses, passes
  with zero under-escalations), `--demote`, or `--sign` of a new configuration.
  A certified plugin change never clears a pending kill.
- **Notification:** a `pause-loop` sends a PushNotification when the session
  has that tool, and always writes the incident to `STATE.md` and
  `## Last run`.

### 6.7 Haiku as primary

Making Haiku a type's primary is a de-escalation. During shadow and gate the
challenger runs on every cohort item (and on `challenger.share` of the rest),
so paired data exists. On the eval half:

1. Haiku's own bound passes §6.4 item 1.
2. The one-sided 95% Clopper-Pearson upper bound on Haiku-only misses ÷
   positives is below `haiku_miss_margin`.
3. The one-sided 95% Clopper-Pearson upper bound on Haiku-only needless
   escalations ÷ paired observations is below `haiku_needless_margin`.
4. The golden set passes with zero under-escalations on Haiku.
5. The owner signs, recording Haiku as the record's `model`.

**After the switch** promotion certification and regression detection are
separate. Sonnet answers the audit slice. Besides §6.6, the kill fires on
evidence of regression only: any confirmed Haiku-only miss on an audit pair, or
a one-sided 95% Clopper-Pearson **lower** bound on Haiku-only needless
escalations above `haiku_needless_margin` over the last `kill.window` audit
pairs. Too few pairs is "insufficient evidence", never a failure.

## 7. First slice

All first-slice decision points live in the loop. Routing questions ride in
the `loop.class` call from stage 1 as log-only questions.

### 7.1 `loop.class` (loop §4; replaces `triage.js`)

- **State:** `title` (300 chars), `notes` (8,000 chars).
- **Item fields (stage 0c):** a stable id, an `origin` (`bootstrap`, `human`,
  `loop from <id>` for a follow-up, or `unknown` for a migrated item), the live
  `title` and `notes` (the only fields `loop.class` reads), the decision text in
  its own field, and an owner-signed `decided` stamp when present. The brief
  reads the title, the notes and the decision field. Stage 0c only reserves the
  `decided:` label; stage 1's `--mark` writes it.
- **Open items and titles (stage 0c, audit cx-lr07):** an item is open while it
  is in `## Now`, `## Backlog` or `## Blocked`; titles are unique among open
  items, and the loop refers to items by id, never by title. For `blocked-by`,
  a done item counts as unfinished while an open item has `origin: loop from`
  its id.
- **Item digest:** SHA-256 over the canonical JSON of `{id, title, notes,
  decision}`; §7.5 binds recovery bundles to it. `approved_digest` (below)
  covers the title, notes and decision text only.
- **Floors (code):** path and keyword markers for migrations, auth, secrets and
  major dependency bumps set `high-stakes`; so do credential-like strings
  (token prefixes, key patterns), publish or upload instructions, and URLs to
  hosts outside the project's own. Self-classifying phrases ("trivial", "just a
  rename", "no review needed") set `hard` at minimum.
- **Questions:** six nouls (`public_api`, `data_model_or_migration`,
  `security_or_auth`, `major_dependency`, `unresolved_design_choice`,
  `spec_incomplete`) and one choice (`class`). Log-only: `suggested_executor`
  (fast-worker, deep-reasoner, codex, main-session, panel) and
  `suggested_effort` (low, medium, high, xhigh).
- **derive:** any of the first four nouls `yes`/`insufficient` → `high-stakes`;
  else either of the last two `yes`/`insufficient` → `hard`; else `mechanical`;
  then the max of that and the `class` answer (`insufficient_evidence` →
  `high-stakes`).
- **Baseline:** the orchestrator's class. **Coverage:** every picked item,
  including items classified before this firing.
- **Decided-item cap.** When the owner releases an item after a panel, they run
  `reflex-report.mjs --mark decided <item_id>`, which stores the
  `approved_digest` (a hash of the item's current title, notes and decision
  text) and the reason ids from the envelope that sent the item to the panel
  (floor ids, cautious noul ids, the `class` answer). The cap
  `applied = max(baseline, min(value, 'hard'))` applies while the current
  digest equals `approved_digest` and no floor id outside the stored set
  matches. Any amendment to the title, notes or decision changes the digest and
  removes the cap until the owner marks the item again. A new model-only
  reason gives `ask`. Code drift in the repository is not covered by the cap;
  `loop.accept` reviews the resulting diff.
- **Failure action:** `skip-firing`.

### 7.2 `loop.accept` (loop §6, after verify and the scope rail pass, before staging)

- **Content:** the bundle from `reflex-bundle.mjs`: the tracked diff against
  the pre-dispatch HEAD, every new in-scope untracked file, and the complete
  brief. Limits: 12,000 lines, 600 KB.
- **State:** the delegate's report (4,000 chars).
- **Facts:** `empty_diff`; `deleted_tests`; `suppression_added`;
  `verify_config_changed` (changes to files that define or configure `verify:`:
  package manifests' scripts, Makefiles, CI configs, test runner configs, plus
  `facts_ext.verify_config_paths`); `binary_changed`; `bundle_truncated`;
  `unreported_paths` (informational). Every fact except the last gives
  `needs-decision` with `via: code`. `empty_diff` gives `needs-decision` unless
  the item carries an owner-signed `no-change-ok` stamp.
- **Questions:** three nouls, answered against the bundle, not the report:
  `brief_items_missing`, `unrequested_behavior_change`,
  `claims_unsupported_by_diff`.
- **derive:** any `yes`/`insufficient` → `needs-decision`; else `accept`.
- **Baseline:** `accept`. **Failure action:** `flag-with-patch`.

### 7.3 `loop.verify_failure` (loop §7, first failed attempt)

- **Red-base check (a loop step, before decide):** save the attempt with the
  patch helper, reset the clone, and re-run the failing verify command on the
  clean loop-branch HEAD. If it still fails, the base is red: `pause-loop` as a
  global infra incident, patch kept. If it passes, re-apply the patch and call
  decide.
- **State:** the verify command and the last 4,000 characters of its output.
- **Question:** one choice, `cause`: `bug_in_change`, `flaky`.
- **derive → action:** `bug_in_change` → `retry`; `flaky` → `retry`;
  `insufficient_evidence` → `flag-with-patch`.
- **Caution order:** `retry < block < flag-with-patch`.
- **Baseline:** today's rule (retry once, then block), which records `failed`
  and feeds the circuit breaker. The decision never adds retries.
- **Failure action:** `baseline`.

### 7.4 Routing (log-only)

- `suggested_executor` and `suggested_effort` are journaled next to what the
  loop actually used (the level × class table).
- Stage 5 adds a usage report: calls, wall time and total usage per item. The
  ecosystem survey found routers that raised total cost (+69.7% in one case).
- A tier is chosen only when a delegate is spawned; the main session's model is
  never switched. No routing gate in this spec.

### 7.5 Transitions after edits exist

| Point | Outcome | Clone | Item | Ledger outcome |
|---|---|---|---|---|
| `loop.accept` | `needs-decision`, or unavailable in gate | patch saved, reset | `waiting-decision`, entry variant "acceptance" | `flagged` |
| `loop.verify_failure` | red base | patch saved, reset | back to `## Backlog`, unchanged | `halted` (loop paused) |
| `loop.verify_failure` | `flag-with-patch` | patch saved, reset | `waiting-decision`, entry variant "verify" | `flagged` |
| any | `pause-loop` | patch saved, reset | back to `## Backlog`, unchanged | `halted` |

**Shared patch helper** (`reflex-bundle.mjs`, from stage 0c): saves the
tracked diff against the base plus every non-ignored untracked file not in the
baseline `U` as one recovery bundle, in scope or not (out-of-scope files are
marked, never discarded unsaved; audit cx-lr03), and checks it applies to that
base. Every save, not only the first clone preparation's, lists untracked files
under the ignore rules recorded before the dispatch (the paths ignored then,
whether by `.gitignore` files at any depth or by local excludes), so a
delegate's new or edited ignore rule cannot hide a file; the bundle is validated
before anything is reset or removed. It prints the bundle's sha, the base HEAD, the item digest (§7.1) and the
scope; the main session writes them into the `## Needs decision` entry in
`STATE.md` (governance, §4). If saving fails, the reset does not run and the
loop pauses. It never uses `git stash`, whose `refs/stash` is shared across
worktrees.

**The private clone starts clean.** Nothing in `<W>` belongs to the owner, so
the firing's first clone preparation (never a retry, which keeps its attempt)
saves any leftovers of an interrupted firing into a recovery bundle bound to
that firing's generation, then removes them. Its untracked files are listed
under the interrupted firing's recorded ignore rules (the patch-helper rule
above), read back from the record and never from the working tree, so a
delegate's new or edited ignore rule cannot hide a file; leftovers with no
record are listed under the base's rules alone. One bundle holds the tracked
diff and those files, and it is validated before anything is reset or
removed. Cleanliness is checked again after the reset
and after dependency preparation. `U` is therefore empty at every dispatch,
and a delegate cannot edit a file the loop is not allowed to save or reset
(audit cx-lr04).

**Out-of-scope files in a bundle.** A recovery bundle keeps them, but a release
refuses such a bundle before applying anything: the entry asks the owner to
drop those files or widen `scope:`, and a new bundle is bound for review. On
every release the scope rail runs before verify.

**Release by a human decision.** Loop §3.1 handles an acceptance or verify
release before any reclassification or level parking. `Decision: accept`
makes the firing check that the recovery bundle's sha, the base HEAD, the item
digest and the scope all equal the values in the entry; re-apply; re-run
verify and the scope rail; and commit, skipping `loop.accept` for that
decision (the skip is journaled). The loop keeps committing other items while
an entry waits, so a moved base alone does not invalidate the release: if the
commits since the recorded base touch none of the bundle's paths and no
verify-config file, the bundle is applied on the current HEAD and verify
decides. If they do, or any other value differs, the entry is re-flagged with
a fresh bundle for a new review. `Decision: reject: …` moves the item to
`## Blocked`.

### 7.6 Unattended containment

**Runners.** Two supported forms, both started from `<V>` with the runner
settings. Until stage 2 ships the runner settings, both forms start from `<P>`
(`cd <P> && claude -p 'Run /tech-lead:loop <P>'`): a session started in `<V>`
without them would lose the allow rules the owner keeps in `<P>`'s settings.

- OS cron or launchd: `cd <V> && claude -p --settings <X>/runners/<key>.json 'Run /tech-lead:loop <P>'`;
- an interactive session opened the same way (`cd <V> && claude --settings …`),
  which then uses CronCreate. CronCreate enqueues into that open session and
  inherits its cwd and settings; it cannot start a new process.

From stage 2, the loop checks at §1 what it can observe: that the runner
settings are loaded and that the P5 sandbox check passes. If either fails, it
runs without any write-capable dispatch. Before stage 2 the runners are a
headless `cd <P> && claude -p 'Run /tech-lead:loop <P>'` and an interactive
session opened in `<P>` that uses CronCreate.

**Settings.**

- `sandbox.enabled: true`, `sandbox.failIfUnavailable: true`,
  `allowUnsandboxedCommands: false`, empty `excludedCommands`;
- filesystem writes: the working directory `<V>` and the per-user temp
  directory; nothing else. `denyWrite` for `<W>/.git/hooks`, `<W>/.git/config`
  and startup files the sandbox does not already protect (probe P5 lists
  them, including a planted `.git`, `CLAUDE.md`, `CLAUDE.local.md` and
  `.claude/` in `<V>`);
- filesystem reads: denied by default under the home directory, re-allowed for
  `<P>`, `<S>`, `<V>`, the toolchain directories and temp; credential stores
  (`~/.ssh`, `~/.aws`, `~/.config/gh`, keychains, `~/.codex`) stay denied;
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, so subprocesses do not inherit
  credentials;
- network: `allowedDomains` lists only the package registries and the Codex API
  hosts named in `LOOP.md`; git remotes and `gh` hosts are not listed;
- permissions: Write and Edit allowed only under `<S>`; an allow rule for the
  `tech-lead:decide` workflow (probe P8); model fallback disabled;
- the effective merged settings are checked at §1 (probe P5): no extra write
  paths, excluded commands, hooks or allow rules from other settings sources.

**Isolated clone.** Delegates and verify commands work in `<W>`, a full clone of
`<P>` made with `git clone --no-local`. The loop branch lives only there. The
main session runs its own git commands in `<W>` with fixed safe overrides
(`-c core.hooksPath=/dev/null -c core.fsmonitor=false` and the like). After each
commit the loop writes `<V>/out/<branch>.bundle` with `git bundle create`;
the owner reviews by fetching the bundle into `<P>`, which runs nothing from
the clone. The owner never runs git inside `<W>` directly.

**Codex: off by default in sandboxed runs.** Codex needs its own credential,
and inside the sandbox any process could read it. So sandboxed runs use no
Codex unless the owner signs `codex_in_sandbox: true` in the policy record,
accepting that residual. Without it, L3 Codex items return `waiting-level`, and
panels run single-seat with the reason recorded (the owner can run the Codex
seat interactively). With it, and when probe P5 confirms it works, Codex runs as
`codex exec -s danger-full-access -C <W>` inside the outer sandbox (a nested
Seatbelt profile usually fails on macOS), with a dedicated `CODEX_HOME` in the
temp directory holding only what the run needs. `excludedCommands` is never used
for Codex.

### 7.7 Dispatch registrar and delegate guard

**Registrar (hooks, outside the sandbox).**

- `PreToolUse`, matcher `Agent`, filtered to `subagent_type` `loop-worker`: the
  hook reads the brief's first line,
  `TECH-LEAD-DISPATCH {"P":…,"S":…,"W":…,"generation":…}`, checks that the
  paths are canonical and consistent, generates a random `dispatch_id`, and
  writes `<X>/dispatch/<session_id>.json` with those fields and an expiry. The
  `dispatch_id` never appears anywhere a delegate can read. A missing or
  malformed header denies the Agent call (exit 2).
- `SubagentStart` for `plugin:tech-lead:loop-worker` binds the `agent_id` into
  the record. `SubagentStop` removes the record.

**Guard.**

- `hooks/hooks.json`: PreToolUse, matcher `Bash|Write|Edit`, command
  `sh "${CLAUDE_PLUGIN_ROOT}/hooks/delegate-guard.sh"`, with an internal
  watchdog shorter than the hook timeout.
- The sh wrapper reads stdin and exits 0 at once unless `agent_type` names a
  tech-lead delegate (`plugin:tech-lead:…`). For a delegate it runs
  `delegate-guard.mjs`; if node is missing or the script exits with anything
  other than 0 or 2, the wrapper prints "guard error" and exits 2.
- Rules for `fast-worker` (used only interactively) and `loop-worker`:
  - git: only read-only subcommands (`status`, `diff`, `log`, `show`, `blame`,
    `ls-files`, `rev-parse`, `grep`), after skipping global options (`-C`,
    `--git-dir`, `--work-tree`, `--no-pager`); `git -c` and every other
    subcommand are denied. `gh` is denied.
  - `rm` with a recursive flag in any form, and `find … -delete`, are denied.
  - Direct publish and upload commands (`npm publish`, `yarn publish`,
    `pnpm publish`, `twine upload`, `gem push`, `cargo publish`, and the like)
    are denied.
  - Write and Edit targets, and resolvable Bash redirection targets, are
    resolved to real paths; writes under `<S>` outside `<W>` are denied.
- Extra rules for `loop-worker`:
  - The dispatch record must exist for the hook input's `session_id`, carry the
    input's `agent_id`, and be unexpired. Otherwise every mutating call is
    denied.
  - Writes outside `<W>` are denied.
  - Inline interpreters and nested shells (`node -e`, `python -c`, `sh -c`,
    `bash -c`, `eval`) are denied.
  - Every guard decision for `loop-worker`, including allows, is appended to
    `<X>/guard/<key>.jsonl` with the record's `dispatch_id`.
- A block is final: the reason tells the delegate to stop and report.
- Interactive panel seat B (`codex:codex-rescue`) is not a tech-lead delegate
  and is not covered.

### 7.8 Checks after every untrusted execution

Untrusted execution means a delegate dispatch and every verify run. Before it,
the loop records:

- `git -C <W> rev-parse HEAD` and a hash of `git -C <W> for-each-ref`;
- a manifest of shas for every file under `<V>` except the clone's
  working files (journals, snapshots, archives, patches, bundles, review sheet,
  lock);
- the `CHAIN.json` heads.

After it, before anything reads those files:

- a moved clone HEAD: `git -C <W> reset --soft <recorded sha>` keeps the work
  as uncommitted changes; the attempt continues with the note "delegate
  committed";
- any other ref change, a changed manifest entry, or a broken chain:
  `pause-loop`, naming each changed path. A release, review sheet or bundle
  whose file changed is invalid until the owner re-confirms it;
- a dispatch whose delegate made tool calls (from its tool-use count) but left
  no row with its `dispatch_id` in `<X>/guard/`: the guard was not active,
  `pause-loop`.

Governance files in `<S>` and everything in `<X>` are outside the sandbox's
write set. The governance files are still hashed around each untrusted
execution (§4), since only the guard keeps a delegate's Write/Edit tools out of
them.

### 7.9 Runner model (measured)

Anthropic positions Sonnet 5.5 for "recurring agent work: run triage and
investigation, ready for your review every morning", which describes the loop.
With System 1 in place, the loop's main session mostly follows a fixed state
machine, while judgment sits in typed decisions and the panel. So the runner
could run on Sonnet (`--model sonnet` in the runner command) at a fraction of
the usage. Because the owner puts quality above cost, this is measured first:

- **Default:** the runner keeps the session's default model (Opus 5.5).
- **Comparison:** the owner may sign a comparison period in which firings
  alternate by `hash(firing generation|runner)` between an Opus runner and a
  Sonnet runner. The model is chosen when the runner process starts, never
  switched mid-session. Every ledger row records the runner model.
- **Measures, per runner model:** item outcomes (done, flagged, failed,
  blocked), verify failures and retries, needless and missed escalations from
  the human labels, owner re-work after review (items reopened or reverted),
  and usage per firing.
- **Switching** the default runner to Sonnet is a de-escalation: it needs the
  comparison report and the owner's sign-off, and it keeps a kill criterion
  (a rise in flagged or failed items, or in owner re-work, above a signed
  margin returns the loop to an Opus runner and pauses for review).
- Decision models (§5.1) and delegate models are unaffected; this covers only
  the loop's main session.

## 8. Error handling

| Case | Shadow | Gate |
|---|---|---|
| Workflow missing, errored or not permitted | continue with `cap(base)`; journal the incident | preflight: item skipped before dispatch; after edits: the type's failure action |
| `agent()` null or throw | journal; `cap(base)` | the type's failure action |
| `invalid-args` (packet or floor mismatch) | journal; `cap(base)` | the type's failure action |
| Facts script fails | the type's failure action | same |
| Journal write or chain check fails | `pause-loop` | same |
| Policy verdict `paused` | n/a | `pause-loop` |
| Runtime identity unverified | row excluded from evidence | `pause-loop` |
| Runner settings or sandbox check fails (from stage 2) | no write-capable dispatch | same |
| Guard: non-delegate or unreadable `agent_type` | exit 0 | exit 0 |
| Guard: script error for a delegate | exit 2 ("guard error") | same |
| Registrar: missing dispatch header | Agent call denied | same |
| §7.8 finds a change | `pause-loop` | same |
| Kill check exits 3 | n/a | `pause-loop`; type stays in gate |

## 9. Migration

### 9.1 Existing spines

Run in an interactive session (the loop refuses scheduled runs with "migration
needs an interactive run" until it is done). Migration is staged: each delivery
stage migrates what it introduces, and `LOOP.md`'s `spine_version:` key records
the last stage whose migration completed (a missing key means a spine from
before stage 0c). Stages are installed in order: a stage's migration requires
the previous stage's to be complete. Bootstrap writes `spine_version:` set to
the current stage, since a new spine has nothing to migrate. Every step is
idempotent and safe to re-run after an interruption.

Stage 0c:

- untrack the spine (a named exception to the loop's no-commit rail): refuse
  when the index holds changes other than this step's own, or when
  `.gitignore` exists but is untracked or differs from HEAD by anything other
  than this step's own line (the step's own state, recorded in
  `<V>/migration/`, is recognized before these checks, and a migration commit
  already made is detected and not repeated); record the original HEAD and the
  expected change in `<V>/migration/`; run
  `git rm --cached -r -- .tech-lead` (skipped when nothing under it is
  tracked) and add the `/.tech-lead/` line to `.gitignore` (when absent);
  check that the staged change is exactly those removals and that line; and
  commit without `--only` or `-a`. The files stay on disk. A re-run resumes
  only that recorded change. (`git commit --only` on the spine paths would
  commit their content and leave them tracked.)
- replace the git worktree with the isolated clone (§7.6): stop any Codex job
  in the old worktree, save its uncommitted work with the patch helper, adopt
  the dated loop branches into the clone, and retire the old worktree without
  `--force` or a recursive delete; when git refuses, the owner is asked;
- assign stable ids and origins to items lacking them; the loop never picks an
  item without an id;
- check `scope:`: a scope of `./` (the whole repository) is refused, and the
  owner sets a narrower one (audit loop07).

Stage 1:

- move journals into `<V>` (`~/.cache/tech-lead/<key>`, outside `<P>`); start
  fresh hash chains;
- map `triage:`: off → `loop.class: off` pending the owner's signed off (shadow
  until then); shadow or missing → shadow; gate → shadow plus a paused loop and a
  notice, since gate under the old checker is not carried over;
- remove the `triage:` key; mark old ledger `triage` objects as legacy, never
  counted toward promotion;
- run `--init-policy`.

Stage 2:

- write runner settings to `<X>/runners/`.

### 9.2 Plugin files

- `workflows/triage.js` and `agents/triage.md` are removed; `agents/decider.md`
  and `agents/loop-worker.md` are added.
- `skills/loop/SKILL.md` §1, §3.1, §4, §5, §6, §7 and §8,
  `skills/loop/references/loop-templates.md`, `skills/loop/references/bootstrap.md`,
  `skills/loop/references/worktree.md` (replaced by the clone),
  `templates/rules-tech-lead.md` (its workflow list names `tech-lead:triage`),
  `SKILL.md` and `README.md` are updated in the PR of the stage that changes
  them (stage 0c adds the loop §2 scope gate). The release notes tell users to
  re-copy the routing rule and how to fetch loop branches from bundles.
- `skills/quick/SKILL.md` changes with the untracked spine (stage 0c): its
  check for a tracked `.tech-lead/` no longer fires after migration, and its
  branch switch to `origin/<base>` hits the branch-switch hazard (§4) while the
  base still tracks the spine. Quick therefore inspects the target tree, and
  works in a separate worktree when the current or the target tree tracks
  `.tech-lead/`.

### 9.3 Rules text

`decision-contracts.md` becomes the registry's documentation: the reflex rules
(with the rule 3 and rule 4 wording from §2), the failure actions, the modes and
transitions, the write-authority table, and the envelope and journal contracts.

## 10. Delivery stages

Each stage is one PR and closes with a cross-family review (a Claude fan-out
plus Codex run from the main session). Stage 0' is several independent PRs.
Stage 0c is four plans (0c-1 to 0c-4); each is its own PR, with its own plan
dry run before execution and its own closing review. Within stage 0c, each
concern has one owner module that later plans import and never redefine. Audit
finding ids refer to the owner's audit report.

| Stage | Contents | Accepted when |
|---|---|---|
| 0a | `scripts/check.mjs` from the prototype with the §5.1 loader contract; `tests/` scaffold. | check.mjs green on the repo. |
| 0b | Loop safety fixes: Codex L3 timeout (loop09, cx-lp04); neutralize `Decision:` and markup in delegate- and seat-written text; LOOP.md `base:` key (loop12); CronCreate `durable` removal and the runner forms of §7.6 (cons01). | Each fix has a test or a scripted reproduction. |
| 0c-1 | Foundation: the `<key>` and `<V>` resolver (§3), process facts, atomic records, a safe git runner for `<W>`. Firing lock: the holder is the runner process, identified by pid and start time; children (each verify run and dependency install, run by an exec wrapper in its own process group and registered before it starts, and each Codex job) are recorded with the same identity before anything is signalled; a read-only recovery-planner skeleton. A live holder makes the firing exit without writing (the lock protocol's own temporary file excepted). Reclaim needs every child gone and either the holder gone or the holder being this same process with no in-process dispatch (agent or workflow) of its generation still open; firings in one process do not overlap, but a background agent can outlive an interrupted firing. A same-process reclaim is noted in `## Last run`; never by age alone. The next firing stops a dead holder's children itself (process groups killed, Codex quiesced with stage 0b's `quiesce`) and reclaims once they are gone; no watchdog or supervisor process is started (the exec wrapper may stop its own group when its holder dies, but correctness never depends on it). The generation strictly increases, with gaps allowed, and is the ledger `iteration`: each acquire takes one more than the larger of the lock's last generation and the largest `iteration` in `LEDGER.jsonl`, so a wiped `<V>` never repeats one. | Concurrency (live holder, races, reclaim) and lock interruption tests pass. |
| 0c-2 | Isolated clone and bundle delivery (loop04); the shared patch helper, never `git stash` (§7.5); the clean-clone rule; recovery of an interrupted firing. | Interruption tests at each persistence boundary pass. |
| 0c-3 | Stable ids, origins and unique open titles (§7.1; cx-lr07). | Item grammar and blocker tests pass. |
| 0c-4 | Spine untracking (loop02) and the branch-switch guard (§4); the stage 0c steps of the §9.1 migration with `spine_version:`; the scope validator (§4) in bootstrap, the migration and a loop §2 gate, refusing `./` and every other whole-repository spelling, absolute paths and `..` (loop07); bootstrap no longer commits, writes `spine_version:` and records itself in `## Last run`; the quick skill's target-tree check (§9.2). | Each migration case has a passing test. |
| 0d | Root SKILL.md trim: "Models and effort" moves to `references/models.md`; Workflow opt-in becomes one closed sentence copied into each sub-skill (prom02, cons02). | check.mjs green; text reviewed. |
| 0' | Independent PRs: the Fable decision (done: removed in 0.3.4); fanout and research contracts (work01, work02, work10, cons05, cons06); panel contract (work04, cons03, cons04, work03); quick git hygiene (loop13, cx-ss01–04, loop14); write-capable brief contract (cx-rt03, cx-rt05, cx-rt06, cx-ag01, cx-ag03); routing rule, audit shape and slash-command redirect (rout01–07); README accuracy (cx-rd01, cx-rd02, cx-rd07, cx-rd08). | Per PR. |
| 1 | Registry, decide.js, decider agent, reflex-facts.mjs, reflex-bundle.mjs, chained journals, snapshots and archives, reflex-report.mjs (journal, stats, review, ingest, replay, init-policy, mark), `loop.class` in shadow with log-only routing questions, the workflow permission rule. Needs probes P6–P9. | Unit and invariant tests green; one live shadow firing journaled end to end. |
| 2 | Containment: runner settings, registrar hooks, guard, `loop-worker`, §7.8 checks, the Codex path. Needs probes P1–P5. Can run in parallel with stage 1 after 0c. | Guard integration test and sandbox checks pass. |
| 3 | `loop.accept` and `loop.verify_failure` in shadow, the red-base check (loop06), the release path. | Transition tests (§7.5) pass. |
| 4 | Promotion machinery: cohort, promote, sign, demote, ack-kill, kill check, audit slice, certificates, re-validation, Haiku parity. No type can be gated before this merges. | A dry-run promotion on synthetic labels produces the expected draft and ledger entry. |
| 5 | Routing usage report; runner-model comparison (§7.9): runner model in ledger rows, alternating firings under a signed comparison period, comparison report. | Reports run on the journal and ledger. |
| 6 | Next spec: prompt-hook spike and interactive-session decision points. | — |

## 11. Testing

- **check.mjs** (no dependencies):
  - every workflow body compiles; `meta` is a literal with `name` and
    `description`; exactly one registry block;
  - the §5.6 invariants over every answer combination, baseline, floor hit and
    fact value of every type; `derive()` reads no `logOnly` key;
  - fingerprints match the embedded constants; a change bumps `rubricVersion`;
    floors are append-only against the previous registry; certificates are
    regenerated and verified;
  - generated schemas match snapshots in `tests/contracts/<type>.json`;
  - no workflow or agent names `fable` or `best`.
- **decide.js unit tests** with a stub runtime: null, throw, invalid response,
  missing `parts_read`, valid response, truncation facts, floor or packet
  mismatch, facts short-circuit, cap, challenger failure isolated, audit
  selection, every policy verdict.
- **Script tests:** each fact and floor; bundle folding, binary and truncation
  facts; policy verdicts against the sign-off ledger (missing entry, wrong
  project, hash mismatch, certificate chain, model not allowed, runtime
  override); chain verification.
- **Golden set per type** (`tests/golden/<type>.jsonl`): `{state, facts,
  expected_min, tags}` with injection canaries, option-order rotations and
  opaque relabels. Required for promotion and re-signing (§6.4).
- **Replay:** historical and counterfactual modes, including refusal on a
  missing or altered snapshot or archive.
- **Guard and registrar:** unit tests with sample hook inputs (non-delegate →
  allow; each deny rule with at least one bypass attempt, including git global
  options and inline interpreters; malformed input; missing node; missing,
  expired or foreign dispatch record); an integration test with a real
  `loop-worker` dispatch that checks a deny, heartbeat rows and record removal.
- **Loop integration:** concurrent firings with a live holder; interruption at
  each persistence boundary; a live child at recovery time; a tampered journal
  and a tampered patch; each migration case; each §7.5 transition; §7.8 checks
  for a moved HEAD, a changed ref and a changed work file after a verify run.
- **Stage 0c contracts:** `<key>` through a symlink alias and with an
  over-long or empty basename, and an `identity.json` mismatch; a same-process
  reclaim with an open in-process dispatch (refused) and without (noted); the
  generation after a wiped `<V>`; a regressed and a lost spine versus owner
  edits, and a tampered copy; untracking interrupted after each step, and with
  unstaged `.gitignore` edits (refused); every whole-repository scope
  spelling, `..`, an absolute path and a prefix-sibling directory; a release of
  a bundle holding an out-of-scope file (refused before applying).

## 12. Cost and measurement

- `loop.class`: one Sonnet call per picked item (today one Haiku call), plus a
  Haiku call on cohort items and on 20% of the rest.
- `loop.accept`: one Sonnet call per executed item whose facts pass.
- `loop.verify_failure`: one Sonnet call per first failure on a green base.
- Bundles are files, so the Opus main session never re-emits content.
- Each envelope records `calls` and `wall_ms`; the owner compares subscription
  usage before and after each stage.

## 13. Probes (release prerequisites for the stage that needs them)

| Probe | What it settles | Stage |
|---|---|---|
| P1 | The exact `agent_type` strings for this skills-dir install, and the `if` filter syntax for `Agent(subagent_type: …)` | 2 |
| P2 | `CLAUDE_PLUGIN_ROOT` in plugin command hooks, `sh` availability, stdin JSON, the hook timeout and watchdog | 2 |
| P3 | Hooks can write `<X>` while sandboxed Bash cannot; the hook input's `session_id` inside a subagent is the parent's | 2 |
| P4 | The guard's early-exit latency (target under 50 ms) | 2 |
| P5 | The sandbox under `claude -p --settings` and in an interactive session opened from `<V>`: `failIfUnavailable`; the effective merged write set, read boundary, deny rules and domains; which startup files are protected; coverage of subagent Bash; which governance write mechanism of §4 works (does `denyWrite` also block the Edit tool; can the Edit tool write `<X>/projects/`); nested Codex (`-s danger-full-access` with a dedicated `CODEX_HOME`); a check the loop can run at §1 | 2 |
| P6 | `agent({agentType: 'tech-lead:decider', model: <full id>, schema})` works under the subscription login, with Read | 1 |
| P7 | null versus throw from `agent()` in each failure case | 1 |
| P8 | The permission rule a runner needs for `Workflow(tech-lead:decide)` | 1 |
| P9 | Reading the decider's model id from its transcript in the workflow run directory | 1 |

## 14. Evidence behind the design

- **Jev docs and SDKs** (docs.typesafe.ai, typesafe-sdk-python): three primitives;
  atomic questions combined in code; fan-out in one call; question ids are
  code-only; thresholds and policy live in the application.
- **Laya** (`docs/staged-adoption.md`, `docs/evals.md`): shadow, compare, policy
  record, bounded promotion; run identity hashes; metamorphic checks.
- **Ecosystem survey** (about 1,300 repos): facts first; typed failures;
  versioned journals with later labels; replay; sticky routing per delegate.
  Against: routers with +69.7% cost, cache loss from mid-session model switches,
  a skill router with about 5% follow-through, a Claude Code stop-hook gate
  with 8 false stops.
- **disler/ten-levels-of-jev** (MIT): tool-boundary hooks, typed questions about
  files, an agent-authored ask tool, "the ten rules".
- **ipenywis/Jef:** routing is the weakest category (78.5%); raw logprobs are
  not calibrated confidence; opaque relabels; untouched holdouts.
- **Claude Code docs:** only exit 2 or a JSON deny blocks PreToolUse, and errors
  and timeouts do not; hook commands run outside the sandbox; plugin hooks run
  inside subagents and carry `agent_id` and `agent_type`
  (`plugin:<plugin>:<agent>`) with the parent's `session_id`; PreToolUse on the
  Agent tool carries `subagent_type` and `prompt`; plugin subagents ignore
  `hooks`, `mcpServers` and `permissionMode` frontmatter; the Bash sandbox is
  OS-level, covers subagents and child processes, protects most of `~/.claude`
  and the working directory's configuration from sandboxed writes, and supports
  `failIfUnavailable`, disabling the unsandboxed fallback, and credential
  protections.
- **Codex companion 1.0.6:** its broker can be reused across processes
  (`lib/broker-lifecycle.mjs`), so sandboxed runs use `codex exec`.
- **Statistics:** Clopper-Pearson bounds as quoted in §6.4.
- **Owner's audit report:** https://claude.ai/artifact/U2EFYNVt7USkxBnu9ux4Es

## 15. Residual risks

- **Egress through an allowed host.** Injected item text that slips past the
  §7.1 floors could lead a delegate to write code that sends readable project
  files to an allowed package registry with a credential planted in the item.
  Reads are limited to the project, the work area, toolchains and temp; direct
  publish commands are denied; credentials are scrubbed. The project's own
  source remains exposed to this path.
- A deliberately malicious project or dependency could misuse an allowed host
  with credentials it brings itself. Unattended runs are for trusted
  repositories.
- With `codex_in_sandbox: true`, the Codex credential in the run's `CODEX_HOME`
  is readable by sandboxed processes; the owner accepts that when signing it on.
- Writes inside `<V>` by delegate-edited code are detected, not prevented.
  Detection runs after every untrusted execution and before any read.
- The decided-item cap does not track code drift; `loop.accept` covers it at
  execution time.
- **Lock integrity under the sandbox.** The firing lock lives in `<V>`, which
  delegates and verify commands can write, so a delegate could delete it
  (admitting a concurrent firing) or forge a live holder (stalling the loop).
  Stage 2 revisits this with the runner settings.
- **Governance writes before stage 2.** Until stage 2 ships the runner settings
  and the §7.8 checks, runs start in `<P>`, so a delegate's relative
  `.tech-lead/` path reaches the live spine, and stage 0c does not detect such
  a write.

## 16. Left to implementation plans

Exact command syntax (permission rules, `if` filters, sandbox keys), file-level
task breakdown, the lock and chain file formats, the REVIEW.md grammar details,
the exact test-glob and verify-config defaults, and the per-stage acceptance
scripts. Round 4 of the review also named these plan inputs:

- Store the §7.8 pre-execution record outside `<V>`, so recovery after an
  interrupted firing can compare against it; define the recovery path for a
  firing interrupted between a journal append and the `CHAIN.json` update (a
  pending-head record, or an owner-terminal re-anchor command).
- Run each untrusted execution in its own process group and kill the group
  before the post-check; sweep for processes still holding files under `<V>`.
  Count dependency installs as untrusted executions.
- Use SHA-256 for chain and packet digests; define canonical serialization and
  manifest handling for added, removed and linked paths.
- Pin `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE` and `GIT_NO_REPLACE_OBJECTS`
  for the main session's git in `<W>`, and include `.git` metadata (`commondir`,
  `info/`, `objects/info/alternates`, `config.worktree`) in the §7.8 manifest.
- Verify model identity for primary, challenger and audit calls before their
  results are used; P1–P9 are release prerequisites for their stages.
- `--sign` recomputes the draft and evidence from the verified journal and
  refuses on a mismatch; `--mark` gets the same TTY and typed confirmation as
  `--sign`, `--demote` and `--ack-kill`.
- Keep a released recovery bundle bound to the approved content through verify
  and staging.
- Implement historical replay with archived raw answers and deterministic
  runtime stubs.
- Settle guard heartbeat applicability (Claude delegates versus Codex) and the
  permitted clone-metadata changes.

Each plan must keep every contract in this spec; a plan that needs to change a
contract comes back here first.

## 17. Decision log

| Date | Decision | By |
|---|---|---|
| 2026-09-30 | Goals A, B, C and D | owner |
| 2026-09-30 | Quality over cost: Sonnet default, Haiku only with measured parity | owner |
| 2026-09-30 | Autonomy (b): earned per decision type, with sign-off | owner |
| 2026-09-30 | Shadow means the model verdict is log-only; floors and caution-ward changes bind immediately | owner |
| 2026-09-30 | Architecture `hybrid-staged`. Seat A (deep-reasoner, Opus 5.5, xhigh) chose it and moved the hooks into `hooks/hooks.json`; seat B (Codex, gpt-6.1-sol, xhigh) chose `registry-workflow`. Audit findings loop04, loop05 and cx-lp05 settled the differing assumption. Prompt hooks wait for a measured spike. | owner, on the tech lead's recommendation |
| 2026-09-30 | Fable 5.1 removed from the plugin (0.3.4): a verified re-check found no role for it that Opus 5.5 does not fill | tech lead, on the owner's delegation |
| 2026-09-30 | Revision 2: floors and facts bind in shadow; kills pause instead of demoting; OS sandbox for containment and the guard as a veto; decision models pinned by full id; promotion on a uniform cohort; paired Haiku parity | tech lead; for owner review |
| 2026-09-30 | Revision 3: floors computed in the main session; `off` needs sign-off; uncertified changes to a gated type pause; runner settings and dispatch records under `~/.claude/tech-lead/`, written by hooks; `codex exec` in sandboxed runs; eval/tune split and blind labels | tech lead; for owner review |
| 2026-09-30 | Revision 4: write-authority split (governance outside every untrusted write path; sign-offs, guard evidence and dispatch records in `~/.claude/tech-lead/`); isolated worker clone with bundle delivery, so the user's tree and `.git` leave the write set; hash-chained journals; checks after every untrusted execution including verify runs; caution certificates in the plugin tree; per-call model identity from transcripts; script-built bundles with `parts_read`; append-only floors; kill acknowledgement; malicious project code declared out of scope | tech lead; for owner review |
| 2026-09-30 | Revision 5 (round 4 found no blockers): the work area moves outside `<P>` to `~/.cache/tech-lead/<project_id>`; the governance write mechanism is chosen by probe P5 with no-dispatch as the fallback; the decided-item cap binds to the approved title, notes and decision text; re-signing needs a fresh eval cohort, and replay on a used cohort is diagnostic only; kills bind to the signed lineage and clear only from the owner's terminal; post-switch Haiku monitoring fires on evidence of regression, not on too few samples; releases survive unrelated commits; injected egress controls (read boundary, publish denial, egress floors); Codex off in sandboxed runs unless signed on | tech lead; for owner review |
| 2026-09-30 | Runner-model comparison (§7.9): Opus runner by default; a Sonnet runner only after a signed, measured comparison | owner |
| 2026-10-01 | Revision 6, the stage 0c amendment set from the stage 0c design run: `<key>` replaces `project_id` as a path segment (§3); a new spine is ignored through `.git/info/exclude` and never committed, a tracked spine is untracked by `git rm --cached` plus a committed `.gitignore` rule, and a spine copy in `<V>` guards the branch-switch hazard (§4, §9.1); migration is staged with `spine_version:`; runs start in `<P>` until stage 2's runner settings; the lock reclaims from the same process and stops a dead holder's children itself, and its generation is the ledger `iteration`; recovery bundles keep out-of-scope untracked files and the private clone starts clean (§7.5); item origins, open-title uniqueness and the item digest (§7.1); "in scope" defined and `./` refused at bootstrap and at §2; lock integrity and pre-stage-2 governance writes recorded as residual risks (§15); 0c split into 0c-1 to 0c-4 (§10); `skills/quick` added to §9.2. A verification round (a Claude find-and-refute workflow and Codex) made these exact: the canonical, bounded, collision-checked `<key>`; the ignore rule on every branch through the exclude file; the spine anchor in `<S>/SPINE.json`, lost and regressed defined by the append-only ledger, and an interactive, confirmed restore that never touches `POLICY.json`; the scope validator; same-process reclaim refused while an in-process dispatch is open; no watchdog daemons; the generation floor; safe, resumable untracking; out-of-scope bundles refused at release; the clean-clone timing; stage qualifiers for the runner checks | owner, on the tech lead's recommendation |
| 2026-10-03 | Revision 7 (amendment A11, from the stage 0c-2 design and its review): the clean clone lists an interrupted firing's untracked files under that firing's recorded ignore rules (read back from the record, never from the working tree; recorded after dependency preparation, before any dispatch), so tool-written self-ignored directories (a venv, `.husky/_`, test caches) are not bundled and deleted at every firing; leftovers with no record use the base's rules; the restore-first sentence of §7.5 is removed | owner, on the tech lead's recommendation |
