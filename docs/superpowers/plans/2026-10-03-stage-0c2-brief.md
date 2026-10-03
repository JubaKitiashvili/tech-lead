# Stage 0c-2 architecture brief: isolated clone, patch helper, recovery (v2)

Binding authority: `docs/superpowers/specs/2026-09-30-system1-layer-design.md` revision 6 (§3,
§4, §7.5, §7.6, §9.1, §10 row 0c-2, §11, §15, §16; the stage 2 parts of §7.6-§7.8 excluded), plus
amendment A11 (§0, owner approval pending). This brief fixes module names and interfaces so the
prototype, the plan and later stages (0c-3, 0c-4, 1-3) share one owner per concern. Input
material (revision 6 and the merged 0c-1 code override it): scratchpad
`0c2-in-{prose,clone,patch,recovery,api}.md`, `0c-design.json`. v2 folds in the brief review
(Codex xhigh: 17 findings; a 48-agent Claude find-and-refute workflow: 42 confirmed) recorded in
`0c2-brief-review.md` and `codex-0c2-brief.md`.

Spec row: "Isolated clone and bundle delivery (loop04); the shared patch helper, never git stash
(§7.5); the clean-clone rule; recovery of an interrupted firing. Accepted when: interruption tests
at each persistence boundary pass."

Conventions (0a-0c-1): Node 22 ESM `.mjs`, no npm dependencies; `node:test` +
`node:assert/strict`; tests `node --test "tests/**/*.test.mjs"`; checks `node scripts/check.mjs`.
Helper CLIs print exactly one JSON line on stdout (exceptions: `loop-lock exec`, `loop-clone git`)
and exit 0 (ok), 2 (`{state:'error', detail}`: usage, setup, git or I/O failure, holder-unknown;
nothing destructive done unless `partial: true`), 3 (refused, `state` names why; nothing changed
unless stated). Not the holder is always exit 3 `{state:'not-holder', detail}` in every new helper.
Flag `--generation <N>` everywhere. Main guard as 0b/0c-1. Code is ASCII; write no `\uXXXX`
through tools that decode it. Every mutating entry calls `assertHeld(paths, N, env)` before its
first write and again right before each destructive step, and `process.chdir(paths.V)` first.

Not in 0c-2: runner `cd <V>` and runner settings, the §7.8 manifest, governance hashes, guard
heartbeat, anchoring records outside `<V>`, the open-file sweep, Codex in the sandbox (stage 2);
the release path, its prose and `apply`'s moved-base allowance (stage 3); item ids, digest,
`Tech-Lead-Item` (0c-3); spine untracking, `.gitignore`/exclude lines, bootstrap, the scope gates
and refusals, retiring the old worktree (0c-4).

## 0. Amendment and rulings

**Amendment A11 (spec revision 7; needs the owner's approval before the prototype).** §7.5's two
paragraphs disagree on which ignore rules list untracked files: the patch-helper paragraph says
"the ignore rules recorded before the dispatch (the paths ignored then, whether by `.gitignore`
files at any depth or by local excludes)", the clean-clone paragraph says "the tracked files
(`.gitignore` included) are restored to the base first, so the untracked files are listed under
the base's ignore rules". Read literally, the clean-clone rule saves and removes every tool's
self-ignored directory (a venv, `.husky/_`, `.pytest_cache`, each with its own `*` .gitignore),
which a dependency install recreates: every firing would bundle and delete them (or pause on
`too-large`). Proposed text for the clean-clone paragraph: "Its untracked files are listed under
the interrupted firing's recorded ignore rules (the patch-helper rule above), read back from the
record and never from the working tree, so a delegate's new or edited ignore rule cannot hide a
file; leftovers with no record are listed under the base's rules alone. One bundle holds the
tracked diff and those files, and it is validated before anything is reset or removed." The
restore-first sentence goes. The recorded rules (§8) are the base commit's `.gitignore` blobs, the
ignore files present once dependency preparation finished (read before any dispatch), the
clone's local excludes and the user's excludes file.

Rulings (each goes to the plan's Appendix B with its cost):
- R1 Listing is an index replay of the recorded rules (git reads each recorded ignore file from a
  skip-worktree index entry, never from the working tree), so a new nested `.gitignore` or an
  info/exclude edit cannot hide a file either. Pinned by a test (git >= 2.38 reads a missing
  skip-worktree exclude file from the index). Cost: a git change fails that test loudly.
- R2 Two listings with two jobs. Saves and the reset precondition use the recorded rules (§7.5).
  The touched set that `check`, the scope rail, `deps-dirty` and the commit use is git's standard
  listing; paths only the recorded rules see are reported as `hidden` (neither committed nor an
  attempt failure) and the next clean clone saves them. Cost: a delegate can keep a file out of a
  commit by hiding it, never out of a save.
- R3 The run record stays in `<V>/run/` in 0c-2; §16's "outside `<V>`" belongs to stage 2's §7.8
  record, which mirrors it. Cost: a delegate can forge a record before stage 2 (§15 class).
- R4 "Bound to that firing's generation" = the interrupted (source) generation; a bundle header
  carries the saver's `generation` and `source.generation`. When more than one record is
  unresolved, the newest owns the tree and the others are marked superseded.
- R5 The anchor that permits a reset is the run record (the helper writes the bundle sha there,
  fsynced, before it prints); the prose writes the sha into STATE.md before calling reset. Cost: a
  firing killed between save and the STATE write loses the flag outcome (the item reruns; the sha
  reaches the ledger through `ledger-recovered`).
- R6 A minimal `reflex-bundle.mjs apply` (same base only) ships in 0c-2 for the §11 stage 0c
  contract; no prose calls it until stage 3, which adds §7.5's moved-base allowance.
- R7 A touched path under `.tech-lead/` inside `<W>` is out of scope (an attempt failure).
- R8 Fault injection: named SIGKILL points through `scripts/lib/fault.mjs` (`TECH_LEAD_FAULT`),
  plus the extended firing driver for prose boundaries. Cost: one env-gated no-op call per
  boundary in production code.
- R9 Commits: `commit-tree` from the checked tree, compare-and-swap `update-ref`; project hooks
  never run (spec §7.6); no Co-Authored-By; author and committer from `git var GIT_AUTHOR_IDENT` /
  `GIT_COMMITTER_IDENT` in `<P>`, set explicitly; inherited `GIT_*_DATE` scrubbed. Filters and
  eol conversion the owner's config selects run at commit time, as a `git add` in `<P>` would.
- R10 0c-2 runs alongside a legacy `<S>/worktree`: it never writes, resets or removes it; only the
  planner reads it (the `legacy` facts); the first clone adopts `<P>`'s dated branches. Saving and
  retiring it is 0c-4 (an added `legacy` layout in `changes.mjs`).
- R11 Owner-side rejection: `loop-review.mjs retire` writes `refs/tech-lead/retired/<branch>` in
  `<P>`. A dated branch whose tip is comparable with a retired tip (either contains the other) and
  not contained in the base is never chained on, bundled again, or kept as today's branch (today's
  branch is reset to a fresh start point; the rejected work stays in the retired ref and the
  `.prev` bundle).
- R12 Interrupted verified-but-uncommitted work is saved and the item reruns.
- R13 Governance-side recovery (planner actions) runs even in a paused firing; every `<W>`
  mutation happens only inside `prepare` or the Save and reset procedure.
- R14 The dependency marker lives in `<W>/.git/tech-lead-deps.ok`.
- R15 `<W>` and its temporary clone directory are created mode 0700 before content arrives.
- R16 Recovery-bundle size cap 512 MiB (test override `TECH_LEAD_BUNDLE_MAX_BYTES`); no
  retention or pruning in 0c; orphaned (unanchored) bundle files are left in place.
- R17 Until 0c-4, `scope: - ./` marks in scope every path whose real path stays inside `<W>`
  (warning `scope-whole`); an invalid scope marks every path out of scope (`scope-invalid`). A save
  never fails on either.
- R18 The one recursive removal: the helper's own partial clone directory
  `<V>/clone.tmp-<pid>-<hex>` once its pid is gone.
- R19 Saves capture raw bytes (`hash-object --no-filters`; a symlink's target text), so a bundle
  is byte-exact and nothing executes while saving.
- R20 Index-only content (a staged blob that differs from the base, the working tree and every
  commit the record knows) is never discarded: any helper that would reset the index refuses
  `index-only` and the loop pauses. Plain staging of what the working tree holds is reset freely.
- R21 Ignored files inside a directory that stands where the base tracks a file are saved
  (a reset would otherwise delete them); other ignored paths are neither saved nor reset.
- R22 A verify run that changes the touched digest restarts verification from the first command
  once; a second change is an attempt failure.
- R23 `close` reports a dirty own record as `kept` (exit 0): after a touch-nothing pause the next
  `prepare` saves those leftovers.

## 1. Ownership map

| Concern | Owner module | 0c-2 action |
|---|---|---|
| `<key>`, `<V>`, `W` path, identity | `scripts/lib/loop-paths.mjs` | none |
| atomic records, temp files and directories | `scripts/lib/atomic.mjs` | extend (§3) |
| git for the loop | `scripts/lib/git-safe.mjs` | extend (§2) |
| process facts, ancestry sweep | `scripts/lib/loop-proc.mjs` | extend (§7) |
| canonical JSON, SHA-256 | `scripts/lib/canonical.mjs` | new (§4) |
| LOOP.md front-matter lists | `scripts/lib/loop-md.mjs` | new (§5) |
| STATE.md reading (`nowLine`, `PLACEHOLDER`) | `scripts/lib/loop-state.mjs` | new (moved from loop-recover, which re-exports; 0c-3 adds the item grammar here) |
| ledger reading (`ledgerFloor`, `ledgerShas`) | `scripts/lib/ledger.mjs` | new (`ledgerFloor` moved from loop-lock, which re-exports; stage 1 moves the ledger) |
| scope rules of spec §4 | `scripts/lib/loop-scope.mjs` | new (§6); 0c-4 adds CLI, gates, refusals |
| clone integrity (`checkClone`, `cloneMeta`, `refsSnapshot`) | `scripts/lib/clone-check.mjs` | new (§13.1); loop-clone re-exports |
| change set vs base under recorded rules | `scripts/lib/changes.mjs` | new (§8) |
| run record, verdict, vetted tips | `scripts/lib/run-record.mjs` | new (§9) |
| fault points | `scripts/lib/fault.mjs` | new (§10) |
| recovery bundles | `scripts/reflex-bundle.mjs` | new (§11); stage 1 adds content bundles, stage 3 extends `apply` |
| start point, base, chaining | `scripts/loop-start.mjs` | extend (§12) |
| the clone `<W>`, delivery bundles, commit, deps marker | `scripts/loop-clone.mjs` | new (§13) |
| recovery planning | `scripts/loop-recover.mjs` | extend (§14) |
| owner review | `scripts/loop-review.mjs` | new (§15) |
| firing lock | `scripts/loop-lock.mjs` | small changes (§16) |
| prose wiring checks | `scripts/checks/loop.mjs` | extend (§21) |

Import edges (acyclic; the built static `loop-lock` <-> `loop-codex` cycle stays as is; no new
module imports either dynamically): `atomic -> loop-proc`; `ledger -> (none)`; `loop-state ->
(none)`; `clone-check -> git-safe, canonical`; `changes -> git-safe, loop-paths, atomic,
canonical`; `run-record -> atomic, git-safe, canonical, clone-check, ledger`; `reflex-bundle ->
git-safe, atomic, canonical, changes, run-record, clone-check, loop-scope, loop-md, loop-proc,
loop-lock (assertHeld, openPaths), fault`; `loop-clone -> git-safe, atomic, canonical, loop-paths,
loop-start, changes, run-record, clone-check, reflex-bundle, loop-scope, loop-md, loop-state,
ledger, loop-lock, loop-codex (quiesce), loop-proc, fault`; `loop-recover -> loop-paths, git-safe,
canonical, run-record, clone-check, loop-state, ledger`; `loop-review -> git-safe, loop-paths,
atomic, ledger`; `loop-lock -> loop-md, ledger, run-record (maxRecordGeneration), loop-proc`
(plus the existing).

## 2. scripts/lib/git-safe.mjs (extend)

`safeGit(cwd, args, opts = {}) -> string | Buffer` keeps its behaviour and gains options (set
after the scrub, so an inherited variable never wins): `input` (string | Buffer); `indexFile`
(absolute) -> `GIT_INDEX_FILE`; `buffer` (stdout as a Buffer, nothing stripped); `outFd` (stdout
to that fd; returns ''); `config` (`['k=v']` passed as `-c` after the fixed overrides);
`timeoutMs` (none by default; a timeout throws `code = 'TIMEOUT'`); `env` (extra variables, set
last). The scrub list grows: `GIT_EXTERNAL_DIFF, GIT_DIFF_OPTS, GIT_SSH, GIT_SSH_COMMAND,
GIT_PROXY_COMMAND, GIT_ASKPASS, GIT_SHALLOW_FILE, GIT_GRAFT_FILE, GIT_REPLACE_REF_BASE,
GIT_QUARANTINE_PATH, GIT_ATTR_SOURCE, GIT_GLOB_PATHSPECS, GIT_NOGLOB_PATHSPECS,
GIT_ICASE_PATHSPECS, GIT_LITERAL_PATHSPECS, GIT_EXEC_PATH, GIT_AUTHOR_DATE, GIT_COMMITTER_DATE`.

New exports:
- `workGit(W, args, opts)`: precondition `fs.lstatSync(W + '/.git')` is a real directory, else
  throws `clone-invalid: <W>/.git is not a directory` (`code = 'CLONE_INVALID'`). Spawns `git`
  with `cwd: W` (no `-C`), env = scrub plus `GIT_DIR=<W>/.git`, `GIT_WORK_TREE=<W>`,
  `GIT_COMMON_DIR=<W>/.git`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`,
  `GIT_EDITOR=:`, `GIT_LITERAL_PATHSPECS=1`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`; args prefixed by
  `WORK_OVERRIDES` = `core.hooksPath=/dev/null core.fsmonitor=false core.untrackedCache=false
  core.pager=cat color.ui=never commit.gpgSign=false tag.gpgSign=false gc.auto=0
  maintenance.auto=false repack.updateServerInfo=false protocol.allow=never
  protocol.file.allow=always core.safecrlf=false index.sparse=false core.sparseCheckout=false
  core.quotePath=true`, then `opts.config`. Default `timeoutMs` 540000. Every diff/log/show the
  helpers run adds `--no-ext-diff --no-textconv`.
- `workGitRun(W, args, opts) -> {status, signal, stdout, stderr}` (never throws).
- `cloneRepo(src, dest, {templateDir, timeoutMs = 540000})`: `git -c core.hooksPath=/dev/null -c
  core.fsmonitor=false -c protocol.allow=never -c protocol.file.allow=always clone --no-local
  --no-checkout --no-recurse-submodules --template=<templateDir> -q -- <src> <dest>` into an
  existing empty directory `dest` created mode 0700 by the caller.

## 3. scripts/lib/atomic.mjs (extend)

- Every temp write fsyncs the file before link or rename; `createExclusive` and `writeReplace`
  fsync the directory after (closes the 0c-1 "no fsync" minor).
- `tempFile(dir, suffix = '') -> {path, fd}`: `<dir>/.tmp-<pid>-<16 hex><suffix>`,
  `O_CREAT|O_EXCL|O_WRONLY`, mode 0600.
- `tempDir(dir) -> path`: `<dir>/.tmp-<pid>-<16 hex>/` created mode 0700. Temporary git indexes are
  paths inside such a directory that do not exist yet (git rejects an existing empty index file).
- `commitExclusive(tmpPath, file) -> {created}`: fsync tmp; `link(tmp, file)`; EEXIST with
  identical bytes -> `{created:false}`, different bytes -> throw `integrity: …`
  (`code = 'INTEGRITY'`); fsync the directory; always unlink tmp.
- `sweepTemps(dir) -> string[]`: removes `.tmp-<pid>-*` entries whose
  `startToken(pid).state === 'gone'`: a file is unlinked; a directory has its regular files
  unlinked, then is removed with `rmdir` (never recursive below one level). Live and unknown pids
  are kept.

## 4. scripts/lib/canonical.mjs (new)

`canonicalJson(value) -> string` (plain objects with sorted keys, arrays in order, strings,
safe integers, booleans, null; no whitespace; throws `not-canonical: <why>` otherwise) and
`sha256Hex(data: Buffer | string) -> string`. 0c-3's `itemDigest` and stage 1 import them.

## 5. scripts/lib/loop-md.mjs (new)

`frontList(text, key) -> string[]`: the strict block-list grammar of 0c-1's `verifyCommands`
(same quoting, comments, indentation rule; an empty item is refused); errors `bad-loop-md`,
`no-<key>`, `bad-<key>: …`. `loop-lock.mjs`'s `verifyCommands(text)` = `frontList(text,
'verify')`, with identical messages (existing tests unchanged).

## 6. scripts/lib/loop-scope.mjs (new; the scope owner; no policy)

- `parseScope(loopMdText) -> string[]` (`frontList(text, 'scope')`).
- `checkScope(raw) -> {state:'ok', entries} | {state:'whole', entries} | {state:'invalid',
  problems:[{entry, why:'absolute'|'dotdot'}]}`. Canonical form: trimmed, leading `./` segments
  stripped, repeated `/` collapsed, trailing `/` stripped. Anything canonicalizing to `''` or `.`
  (and `/` alone) is a whole-repository spelling; another leading `/` is `absolute`; any `..`
  component is `dotdot`. A list with any absolute or `..` entry is `invalid` even when it also
  holds a whole spelling; otherwise any whole spelling makes it `whole`. `ok` entries are sorted
  and deduplicated. Never throws on content.
- `inScope(path, entries, {root}) -> boolean`: `path === e || path.startsWith(e + '/')` for some
  entry, and the real path of `root/path` lies inside `realpath(root)` (a symlink, dangling or
  not, is judged by its link target; for a missing path the nearest existing ancestor is
  resolved). Every scope marking calls it with `root = W`.
- `scopeDigest(entries) -> sha256Hex(canonicalJson(entries))`.
- `markScope(paths, loopMdText, {root}) -> {state, entries, digest, outOfScope, warnings}`: the
  0c-2 marking policy of R17 and R7 (`.tech-lead/` always out). Used by `saveFor`, `check` and
  `commit`.
Tests cover every §11 scope case now.

## 7. scripts/lib/loop-proc.mjs (extend)

Move 0c-1's ancestry helper here unchanged: `ancestry(pid = process.pid) -> {state:'ok', pids} |
{state:'unknown', detail}`; `sweepOthers(dirs)`: an unknown ancestry is returned as is, else
`cwdSweep(dirs, {exclude: pids})`. `loop-lock` uses it for the reclaim sweep (unknown -> held
`sweep-unknown`) and exec's post-run sweep (unknown -> `lingering`), as today.

## 8. scripts/lib/changes.mjs (new; the change-set owner)

Paths are raw bytes between git calls; in JSON a path is a string when valid UTF-8, else
`{"b64": "…"}`. Temporary indexes live in `tempDir(<V>/patches)` and are removed in `finally`.

- `openWorkTree(P, {env}) -> wt = {P, R, S, V, W, store}`: clone layout only (0c-4 adds
  `legacy`); `lstat(W/.git)` a real directory; `store = <V>/patches` (created). Else `REFUSED`
  `layout`.
- `recordRules(wt, {base}) -> rules = {v:1, mode:'recorded', base, ignores:[{path, oid}],
  excludes_file:{path, sha256, b64} | null, info_exclude:{sha256, b64}}`: `ignores` = every file
  named `.gitignore` in the working tree (tracked or not, any depth; found by a filesystem walk
  that skips `.git`), each stored with `hash-object -w --no-filters`; the excludes path from
  `config --path --get core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else
  `~/.config/git/ignore`, refused (`excludes-file-in-work-area`) when its real path lies under
  `<V>` or `<R>`; `info_exclude` = bytes of `<W>/.git/info/exclude` (missing = empty). Called once,
  by `check --after deps` (after dependency preparation, before any dispatch).
- `currentRules(wt)` (mode `current`): the same read at the moment of use; allowed only for a
  record without recorded rules (no dispatch ran in it). `baseRules(wt, base)` (mode `base`):
  base `.gitignore` blobs only, the clone's (empty) info/exclude and the current excludes file;
  used for leftovers with no record.
- `listUntracked(wt, {base, rules})`: TB = temp index `read-tree <base>`, then for each rules
  ignore file in directory `d` an entry `d/<nonce>` (mode 100644, that blob) added with
  `update-index --index-info` and `--skip-worktree` (`nonce = '.tlx-' + 12 random hex`); the
  excludes and info bytes written to two temp files; `ls-files -z -o --exclude-from=<excludes>
  --exclude-from=<info> --exclude-per-directory=<nonce>` on TB (no `--exclude-standard`); refuse
  (`REFUSED tampered`) if any `<d>/<nonce>` exists in the work tree. Git reads each recorded
  ignore file from its skip-worktree entry, never from the working tree.
- `collect(wt, {base, rules, also = []}) -> {base, head, headMoved, tracked, untracked, hidden,
  obstructed, unsavable, indexOnly}`:
  1. TA = temp index `read-tree <base>`, `update-index -q --refresh`; tracked = `diff-index -z
     --name-only --no-renames --ignore-submodules=none <base>` on TA (work tree vs base,
     independent of HEAD: loop04).
  2. untracked = `listUntracked` under `rules`; standard = `ls-files -z -o --exclude-standard` on
     TA; `hidden` = untracked minus standard.
  3. obstructed (R21): for each tracked path that is a file or symlink in the base and a directory
     in the work tree, every file below it found by a filesystem walk (ignored or not), added to
     untracked.
  4. each untracked entry ending in `/` is `nested-repo`; others are lstat'ed: regular file or
     symlink savable; fifo, socket or device `special-file`; EACCES `unreadable`.
  5. `head = rev-parse HEAD`; `headMoved = head !== base`.
  6. `indexOnly` (R20): on a copy of the real index refreshed with `update-index -q --refresh`,
     the paths in `diff-files --name-only -z` (index differs from the work tree) that are also in
     `diff-index --cached --name-only -z <oid>` for the base and for every oid in `also`.
- `captureTree(wt, {base, paths}) -> {tree}` (saves; R19): temp index from base; each path's
  content stored with `hash-object -w --no-filters` (a symlink: its target text via `--stdin`),
  mode 100755 when the exec bit is set, 100644 otherwise, 120000 for a symlink; added with
  `update-index --index-info`; a deleted path removed (`update-index --force-remove`);
  `write-tree`.
- `stageTree(wt, {base, paths}) -> {tree}` (commits): temp index from base, `update-index --add
  --remove --replace -z --stdin` (git's normal check-in conversion), `write-tree`.
- `manifest(wt, base, tree) -> [{path, kind:'added'|'modified'|'deleted'|'mode-changed'|
  'type-changed', old_mode, mode, oid, size, binary}]`.
- `touched(wt, {base, rules = null}) -> {paths, hidden, unsavable, indexOnly, headMoved, tree,
  digest}` (check, commit, deps-dirty; R2): tracked plus git's standard untracked listing
  (`--exclude-standard`); `hidden` reported (from `rules` when given); `tree =
  stageTree(paths).tree`; `digest = sha256Hex(canonicalJson({base, tree, paths}))`.

## 9. scripts/lib/run-record.mjs (new; owner of the run record)

One file per write-capable firing, `<V>/run/<N>.json`, through `atomic.mjs` only (`createExclusive`
once, `writeReplace` after; fsynced). Callers hold the lock. A holder M may write recovery fields
into its own record and into older records g < M; never into g > M.

```
{"v":1,"generation":N,
 "phase":"preparing|prepared|intent|committed|saved|resetting|clean",
 "pre_head":"<tip at creation>|null","branch":"…|null","head_ref":"…|null","base":"<H0>|null",
 "now_sha256":"<sha256 of nowLine(STATE.md), the Now item line>|null",
 "rules":null|{…recordRules…},"refs":{"<ref>":"<sha>"},"meta_sha":"…|null",
 "intent":null|{"tree":"T","parent":"H0","commit":"C"},"commit":null|{"sha":"C"},
 "saves":[{"sha":"<64hex>","why":"…"}],"reset_sha":null|"<64hex>",
 "delegate_commits":["<sha>"],
 "recovery":null|{"by":M,"base":"…","rewind":null|{"from":"<tip>","to":"<base>"},
                  "bundles":["<64hex>"],"reset_sha":null|"<64hex>",
                  "step":"rewind-intent|rewound|saved|resetting|done",
                  "note":null|"superseded|clone-missing"},
 "created_at":"…","updated_at":"…"}
```

Exports: `recordFile`, `readRecord` (schema-checked; `corrupt: <file>`), `listRecords`
(ascending; corrupt throws), `createRecord -> boolean`, `updateRecord`, `deleteRecord`,
`maxRecordGeneration(paths)` (from file names, tolerant), `isResolved(rec)` (only stored fields:
phase `clean`, or `recovery.step === 'done'`), `committedSha(rec)` (`rec.commit?.sha ??
rec.intent?.commit ?? null`), `vettedTip({records, ledger, branch, tip, inBase}) -> boolean` (a
record's committed sha, a sha any ledger row names as a commit, a tip adopted at creation, or
contained in the base; the one predicate every bundle write, rotation and chaining uses), and the
pure `cloneVerdict(rec | null, facts)`.

`cloneVerdict` judges only the newest unresolved record (older records are reported `resolved` or
`superseded` without consulting the clone). `facts = {exists, valid, symbolic, headRef, tip,
dirty, indexDirty, isAncestor(a, b)}`. Rules in order:
1. no clone -> `no-clone`; invalid clone or detached HEAD -> `unknown`.
2. `rec === null` -> `leftovers` (dirty or indexDirty; base = tip; rules mode `base`) or `clean`.
3. Unfinished recovery first: step `rewind-intent`: tip === `rewind.from` -> `rewind`, tip ===
   `rewind.to` -> `leftovers` against `rewind.to`, else `unknown`; step `rewound` -> `leftovers`
   against `recovery.base`; step `saved` -> `resume` (last of `recovery.bundles`); step
   `resetting` -> `resume-reset` (`recovery.reset_sha`, relaxed precondition).
4. phase `saved` -> `resume` (last of `saves`); phase `resetting` -> `resume-reset` (`reset_sha`).
5. `headRef !== rec.head_ref` (when `head_ref` is set) -> `unknown`.
6. phase `intent` or `committed`: tip === `committedSha(rec)` -> `committed` (residue is leftovers
   against it); tip === `rec.base` -> `leftovers` (or `clean`); `isAncestor(rec.base, tip)` ->
   `delegate-commit`; else `unknown`.
7. phase `prepared`: tip === base -> `leftovers` / `clean`; `isAncestor(base, tip)` ->
   `delegate-commit`; else `unknown`.
8. phase `preparing`: `leftovers` against the tip (rules: `current` when no dispatch ran) or
   `clean`.
9. phase `clean` -> `clean`, or `leftovers` against base if dirty.

## 10. scripts/lib/fault.mjs (new; test-only effect)

`fault(point)`: when `process.env.TECH_LEAD_FAULT === point`, `process.kill(process.pid,
'SIGKILL')` (no cleanup runs). Points are named `<helper>:<step>` (§19).

## 11. scripts/reflex-bundle.mjs (new; owner of recovery bundles)

Bundle file `<V>/patches/<sha>.patch`, `sha = sha256Hex(whole file)`. Line 1:
`TECH-LEAD-RECOVERY v1 <canonicalJson(header)>`; the rest is exact output of `git diff-tree -r -p
--binary --full-index --no-renames --no-color --no-ext-diff --no-textconv --no-relative
-O/dev/null -U3 --src-prefix=a/ --dst-prefix=b/ --diff-algorithm=myers <base> <tree>` (`git
apply` skips the header line). Header: `{v:1, why, generation, source:{generation}, base, head,
tree, item_digest, item_id:null, rules:{mode, sha}, scope:{state, entries, digest},
files:[{path, kind, old_mode, mode, oid, size, binary, in_scope, hidden, obstructed}]}`
(`rules.sha` = sha256 of the canonical rules object). No timestamps. `why`: `clean-clone |
delegate-flagged | codex | attempt-failed | pause` (stage 3 adds `accept | verify | red-base`;
0c-4 adds `migration`).

- `saveFor(paths, {saver, source, base, rules, why, itemDigest = null, also = []}) -> result`:
  refuses `clone-invalid` unless `checkClone(W)` is clean; `collect`; `indexOnly` non-empty ->
  `REFUSED index-only {paths}` (R20); any unsavable -> `REFUSED unsavable {paths}`; nothing
  changed -> `{state:'empty', base, head, indexDirty}`; `captureTree`; a changed gitlink ->
  `unsavable gitlink`; `manifest`; `markScope`; stream header + patch to a temp file, fsync
  (`fault 'save:after-write'`); size cap -> `too-large {bytes, largest}`; apply check: temp index
  `read-tree <base>`, `apply --cached --binary --whitespace=nowarn`, `write-tree` must equal the
  captured tree, else exit 2 (`fault 'save:after-check'`); `commitExclusive` (INTEGRITY ->
  `tampered`) (`fault 'save:after-link'`). Result `{state:'saved', sha, file, base, head, tree,
  item_digest, scope, files, out_of_scope (<=50), hidden (<=50), paths (<=50), more, bytes,
  reused, warnings}`.
- CLI `save <P> --generation <N> --why <why> [--item-digest <64hex>]`: assertHeld; N's record must
  have phase `prepared` or `saved` and recorded rules (else `no-record`); base and rules from it;
  `saveFor`; on `saved` append `{sha, why}` to `saves` and set phase `saved` (`fault
  'save:after-record'`) before printing. A re-save while `saved` appends again.
- CLI `verify <P> --sha <64hex>`: the file's sha, magic, header `v === 1`, base exists; replay onto
  base gives `header.tree`; the diff-tree paths equal the header's. Exit 3 `tampered` /
  `base-unknown`.
- `resetFor(paths, {holder, record, sha, relaxed = false})` and CLI `reset <P> --generation <N>
  --sha <64hex>`: assertHeld; the sha must be in the record's `saves` or `recovery.bundles`
  (`not-anchored`); `verify` (`tampered`); HEAD === header base (`head-moved`); `index.lock` ->
  `index-locked`; `sweepOthers([W])` finds a process or cannot run -> `busy {procs}`; precondition:
  `collect` under the header's rules: `indexOnly` empty (else `index-only`), and every changed path
  is in the bundle with its current entry equal to the bundle tree's or the base's (`relaxed`
  accepts any current state for a path the bundle lists, which a reset killed mid-write leaves;
  else `unsaved {paths}`) (`fault 'reset:after-check'`); record `reset_sha` (own record: phase
  `resetting`; older record: `recovery.step 'resetting'`) (`fault 'reset:after-intent'`);
  assertHeld again; `read-tree <base>` (index only) when the real index differs from base; unlink
  each untracked path one at a time (regular file or symlink by lstat, no symlinked ancestor, real
  parent under `realpath(W)`), then `rmdir` emptied directories not in base (`fault
  'reset:after-unlink-one'`); `read-tree --reset -u <base>` (`fault 'reset:after-read-tree'`);
  post-check clean (else exit 2 `partial: true`); record phase `clean` or `recovery.step`
  advanced (`fault 'reset:after-record'`). Exit 0 `{state:'reset', removed (<=50), restored
  (<=50), more}`.
- `resetEmpty(paths, {holder, record, base, also})`: for an `empty` save with a dirty index:
  assertHeld; HEAD === base; no `index.lock`; `indexOnly` empty (else `index-only`); `read-tree
  <base>` (index only); post-check `diff-index --cached --quiet <base>`.
- CLI `apply <P> --generation <N> --sha <64hex> [--item-digest <64hex>]` (no 0c-2 prose caller):
  verify; refuse `out-of-scope {paths}`, `scope-changed`, `digest-mismatch`, `moved-base`,
  `dirty`; `apply --check --binary`, then `apply --binary`; the recaptured tree must equal
  `header.tree`.
- Save never writes the real index, HEAD, refs, `refs/stash` or the working tree.

## 12. scripts/loop-start.mjs (extend)

- `validPrefix(prefix)`: each `/` segment matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`, is not `.`/`..`,
  does not end in `.lock`.
- `branchRef` exported; `resolveBase(R, base) -> {base, baseRef}` (today's lookup order and
  `defaultBase`) through `safeGit`; `chainStart(git, prefix, baseRef, {retired = [], vetted}) ->
  {startPoint, chainedFrom}` (git runner injected): it skips dated branches contained in the base,
  those comparable with a retired tip not contained in the base (R11), and those `vetted` rejects.
- `startPoint(repo, prefix, base)` and the CLI keep their output, now through `safeGit`.

## 13. scripts/loop-clone.mjs (new; owner of `<W>`)

### 13.1 scripts/lib/clone-check.mjs

`checkClone(W) -> {problems}` (read-only): `.git` not a real directory; any of `.git/{commondir,
gitdir, config.worktree, worktrees/, modules/, shallow, info/grafts, objects/info/alternates,
objects/info/http-alternates}`; `.git/info/` present and not empty; a config key (`git config
--file <W>/.git/config --no-includes --list -z`) outside `core.repositoryformatversion,
core.filemode, core.bare (false), core.logallrefupdates, core.ignorecase,
core.precomposeunicode, core.symlinks, core.hookspath, extensions.objectformat,
extensions.refstorage`; a ref outside `refs/heads/<seg>(/<seg>)*/<YYYY-MM-DD>`,
`refs/remotes/origin/**`, `refs/tags/**`, `refs/tech-lead/base`, `refs/tech-lead/retired/**`;
HEAD not a symbolic ref to a dated branch. `.git/hooks/` contents and `core.hookspath` are
allowed (dependency installs such as husky, lefthook or pre-commit write them; every helper forces
`core.hooksPath=/dev/null`, so no hook ever runs). `cloneMeta(W)` = sha256 over the config bytes
minus `core.hookspath`, the `.git/info` listing and the presence of each forbidden special file.
`refsSnapshot(W) -> {refs}` (every ref).

### 13.2 CLI

| Command | Exit 0 | Exit 3 `state` |
|---|---|---|
| `prepare <P> --generation <N> --prefix <p> [--base <b>] [--date YYYY-MM-DD]` | `{state:'ready', W, branch, base, baseSha, head, startPoint, chainedFrom, created, rotated, retiredReset, baseAhead, adopted, bundles, recovered, notes}` | `not-holder`, `not-quiet`, `clone-invalid {problems}`, `no-base`, `infra {detail}`, `busy {procs}`, `save-failed {detail}`, `index-only {paths}`, `attempt-open`, `corrupt`, `tampered {detail}` |
| `deps <P> --generation <N> [--mark \| --clear]` | `{fresh, marker, current, lockfiles}` / `{marked}` / `{cleared}` | `not-holder`, `no-attempt` |
| `check <P> --generation <N> --after deps\|dispatch\|verify` | `{state:'ok', after, head, delegateCommitted, delegateCommits, unstaged, touched, hidden, out_of_scope, scope, digest}` | `not-holder`, `no-attempt`, `no-rules`, `clone-invalid`, `tampered {detail}`, `deps-dirty {paths}`, `unsavable {paths}`, `index-only {paths}`, `corrupt` |
| `commit <P> --generation <N> --digest <64hex> --subject-file <file>` | `{state:'committed', sha, branch, bundle, bundleError}` or `{state:'unchanged'}` | `not-holder`, `no-attempt`, `work-changed`, `out-of-scope {paths}`, `tampered`, `clone-invalid`, `commit-failed {detail}` |
| `bundle <P> --generation <N> --branch <b>` | `{state:'bundled', bundle}` / `{state:'current'}` | `not-holder`, `unvetted` |
| `close <P> --generation <N>` | `{state:'closed', closed, kept:[{generation, dirty, reason}], bundleError?}` | `not-holder`, `corrupt` |
| `git <P> -- <subcommand> [args…]` | git's own exit and output | refusal: exit 2, last stderr line `loop-clone git: {"state":"refused","detail":…}` |

`git` passthrough: no lock; refused unless `checkClone` is clean; read-only allowlist (status,
diff, log, show, rev-parse, ls-files, rev-list, merge-base, cat-file, for-each-ref, blame, grep,
shortlog, describe); inserts `--no-ext-diff --no-textconv` right after the subcommand for diff,
log and show and `--no-textconv` for blame, nothing for the others; refuses `--output*`,
`--ext-diff`, `--textconv`, `--filters`, `-O*`, `--open-files-in-pager*`, `--upload-pack*`,
`--receive-pack*`, `--exec*`.

### 13.3 prepare (once per firing, before the first write-capable dispatch; a §7 retry never re-runs it)

1. Validate prefix and date (UTC today unless `--date`, tests only); assertHeld; `chdir(V)`; N's
   record must not exist (`attempt-open`). `sweepTemps` under `<V>/out`, `<V>/patches`, `<V>/run`;
   remove `<V>/clone.tmp-*` directories whose pid is gone (R18) (`fault 'prepare:after-temps'`).
2. `<W>` missing: every unresolved record g < N gets `recovery {by:N, step:'done',
   note:'clone-missing'}` (a note "clone missing: generation g's uncommitted work was not saved"),
   then create (13.4) and go to 5.
3. Integrity and quiet before any write: `checkClone` (`clone-invalid`); `quiesce(W)` (not quiet ->
   `not-quiet`); `checkClone` again; `sweepOthers([W])` (a process -> `busy`, unknown -> `infra`).
   The newest record on disk (any phase) must match `refsSnapshot(W)` on every ref except its
   `head_ref` and the refs it lists as its own commits (else `tampered`, naming each ref, nothing
   changed). Remove stale git lock files (`index.lock`, `HEAD.lock`, `config.lock`,
   `packed-refs.lock`, `refs/**/*.lock`) (`fault 'prepare:after-locks'`).
4. `createRecord` N phase `preparing` with `pre_head` = HEAD's tip (`fault
   'prepare:after-preparing'`). Then resolve leftovers (spec §7.5 clean clone, amended): r = the
   newest unresolved record (N's own when none older); every other unresolved record g < N gets
   `recovery {by:N, step:'done', note:'superseded'}`. On `cloneVerdict(r, facts)`:
   - `unknown` -> `clone-invalid` (nothing changed beyond the records above);
   - `clean` -> r resolved;
   - `committed`: write r phase `committed` with `commit {sha: tip}`; residue is handled as
     `leftovers` against that commit with `also: [r.base]`;
   - `delegate-commit`: write r.recovery `{by:N, base:r.base, rewind:{from:tip, to:r.base},
     bundles:[], step:'rewind-intent'}` (`fault 'recover:after-rewind-intent'`), CAS `update-ref
     <head_ref> <r.base> <tip>`, `read-tree <r.base>` after the index-only check (work tree kept),
     step `rewound` (`fault 'recover:after-rewind'`); continue as `leftovers` against `r.base`
     with `also: [tip]`;
   - `rewind` (a resumed rewind-intent): repeat the CAS and continue as above;
   - `leftovers`: rules = `r.rules` when recorded, `currentRules` when r is `preparing` or
     `prepared` without rules, `baseRules` for no record; `saveFor({saver:N,
     source:r.generation (null for no record), base, rules, why:'clean-clone', also})`:
     `saved` -> append the sha to `r.recovery.bundles`, step `saved` (`fault
     'recover:after-save'`), then `resetFor` (step `resetting`, then `done`) (`fault
     'recover:after-reset'`); `empty` with a dirty index -> `resetEmpty`, step `done`; `empty` ->
     step `done`; a refusal (`unsavable`, `too-large`, `index-only`, `tampered`, I/O) ->
     `save-failed` / `index-only` with nothing removed;
   - `resume`: `resetFor` with the recorded sha; `unsaved` -> save again (append), then reset;
     `resume-reset`: `resetFor(relaxed:true)`.
   Every arm ends with r resolved by an explicit write (`recovery.step 'done'`, or phase `clean`
   for N's own record). Status must be clean and no unresolved record g < N may remain (else
   `infra`).
5. Refresh from `<P>` (13.5), bundle sync (13.7), rotation (13.6); a git failure -> `infra`, a base
   the fetch cannot find -> `no-base` (`fault 'refresh:after-fetch'`, `fault 'rotate:after-switch'`).
6. `updateRecord` N: phase `prepared`, `branch`, `head_ref`, `base = HEAD`, `rules: null`,
   `refs = refsSnapshot(W).refs`, `meta_sha`, `now_sha256` (`fault 'prepare:after-record'`). Print
   `ready` with `recovered: [{generation (source), sha, files, out_of_scope, hidden,
   rewound_from}]` for `## Last run` and this firing's ledger row.

### 13.4 Create `<W>`

`git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT` in `<P>` must work (else `infra` "no git
identity in <P>"); a shallow `<P>` -> `infra`; `resolveBase(R, base)` (`no-base`); `tmp =
<V>/clone.tmp-<pid>-<8 hex>` created mode 0700; `cloneRepo(R, tmp, {templateDir:
<V>/run/empty-template})` (`fault 'clone:after-clone'`); normalize: remove `remote.origin` and every
`branch.*` section, delete `refs/remotes/origin/HEAD`; refresh with the extra refspec
`+refs/remotes/tech-lead/*:refs/tech-lead/adopt/*`; adopt (13.8); rotate; delete the non-dated
`refs/heads/*` and `refs/tech-lead/adopt/*`; `checkClone(tmp)` (problems -> remove tmp,
`clone-invalid`); `fault 'clone:before-rename'`; `rename(tmp, W)`. A note when `<P>` has
non-sample hooks, `core.hooksPath`, `.husky/`, `.pre-commit-config.yaml` or `lefthook.yml`:
"project git hooks do not run on loop commits (spec §7.6); add their checks to verify:".

### 13.5 Refresh

`workGit(W, ['fetch', '-q', '--no-tags', '--prune', '--no-recurse-submodules',
'--no-write-fetch-head', R, '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*',
'+refs/tech-lead/retired/*:refs/tech-lead/retired/*', '+<baseRefP>:refs/tech-lead/base'])`;
`baseSha = rev-parse refs/tech-lead/base` after the fetch (the base at fetch time).

### 13.6 Rotation (R11)

Today's branch `b = <prefix>/<date>`:
- HEAD already on `b`, or `refs/heads/b` exists: when its tip is comparable with a retired tip not
  contained in the base, or not `vettedTip`, reset it: `switch -q --no-track -C b <startPoint>`
  from `chainStart` (`retiredReset: true`; the rejected tip stays in the retired ref and the
  `.prev` bundle). Otherwise keep it (switch to it when needed); `baseAhead` reported, never
  rebased.
- Else `chainStart(gitW, prefix, 'refs/tech-lead/base', {retired, vetted})`, then `switch -q
  --no-track -c b <startPoint>`.
- After a rotation, `gc --auto` once (`-c gc.auto=6700 -c gc.autoDetach=false`; WORK_OVERRIDES
  already forbid `.git/info/refs`).

### 13.7 Bundle sync and writeBundle

For each dated `refs/heads/*` with commits beyond the base, not contained in it, not retired and
`vettedTip`: rewrite `<V>/out/<prefix>/<date>.bundle` when it is missing, its sidecar
`<date>.bundle.json` (`{tip, sha256}`) is missing or names another tip, the file's sha256 differs
from the sidecar, or a prerequisite is unreachable from `refs/tech-lead/base`. A branch that fails
`vettedTip` is skipped with a note. Write: temp `<dir>/.tmp-<pid>-<hex>.bundle`, `bundle create -q
<tmp> refs/heads/<branch> ^refs/tech-lead/base` (empty range -> `{empty:true}`), `bundle verify
-q`, sha256; an existing file whose tip is not an ancestor of the new tip is renamed `.prev-<UTC
stamp>`; `fault 'bundle:before-rename'`; rename; then the sidecar (`writeReplace`). Returns
`{file, tip, sha256, bytes, why}`.

### 13.8 Adoption (creation only; 0c-4's migration calls it again)

For each dated name under the prefix: candidates `refs/remotes/origin/<name>` and
`refs/tech-lead/adopt/<name>`; one is taken, or the descendant of two; diverged copies are not
adopted (a note); create-only `update-ref refs/heads/<name> <sha> <zero-oid>`. Adopted tips are
vetted (recorded in N's record `refs`). When `<W>` has the name: never move it.

### 13.9 deps, check, commit, bundle, close

- `deps`: marker `<W>/.git/tech-lead-deps.ok` holding `<branch> sha256:<hex>` over the root
  lockfiles present (the set of today's `worktree.md` step 4); `--mark`, `--clear`; `fresh` when
  the content matches.
- `check --after X`: assertHeld; N's record phase `prepared` (else `no-attempt`); `checkClone`;
  `cloneMeta !== meta_sha` -> `tampered` (with `--after deps`: re-record `meta_sha` instead, since
  an install may set `core.hookspath`); HEAD not symbolic to `head_ref` -> `tampered`; tip !== base
  -> append to `delegate_commits`, CAS `update-ref <head_ref> <base> <tip>`, then (after the
  index-only check with `also: [tip]`) `read-tree <base>`, `delegateCommitted: true` (`fault
  'check:after-rewind'`), update the record; refs other than `head_ref` differ from the record ->
  `tampered`; `indexOnly` non-empty -> `index-only`; real index !== base -> `read-tree <base>`,
  `unstaged: true`; `touched(wt, {base})`; unsavable -> `unsavable`. `--after deps`: any touched
  path -> `deps-dirty`; else `recordRules` into the record (the rules are recorded here, after
  dependency preparation and before any dispatch). `--after dispatch|verify`: rules must be
  recorded (`no-rules`); `hidden` comes from the recorded rules; `out_of_scope` from `markScope`.
  Print `ok`.
- `commit`: assertHeld; N's record phase `prepared`; re-verify meta, HEAD and refs (a moved tip ->
  `tampered`, "check was not run"); `t = touched(wt, {base})`; `t.digest !== --digest` ->
  `work-changed`; empty -> `unchanged` (phase `clean`); any out-of-scope -> `out-of-scope`; `T =
  t.tree`; message = first line of the subject file (control characters removed, at most 200
  chars), a blank line, `Tech-Lead-Generation: <N>` (`commitMessage({subject, generation, item =
  null})`; 0c-3 adds `Tech-Lead-Item:`); `C = commit-tree T -p H0 -F -` with the message on stdin
  and `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` from `<P>`'s `git var` idents; record
  `intent {tree:T, parent:H0, commit:C}` (`fault 'commit:after-intent'`); `read-tree C` (index
  only; the work tree already matches); CAS `update-ref <head_ref> C H0` (failure -> `read-tree
  H0`, intent cleared, `commit-failed`) (`fault 'commit:after-update-ref'`); record phase
  `committed {sha: C}` and `refs` updated (`fault 'commit:after-record'`); `writeBundle` (an error
  is `bundleError`; the commit stands).
- `bundle --branch b`: writes the bundle only when `vettedTip`; else `unvetted`.
- `close`: `ledgerShas(S)`; for each record g <= N: a committed record's bundle is made fresh
  first (an error -> `bundleError`, not blocking); a resolved record (or N's own committed or clean
  record) whose shas (commit, saves, recovery bundles) all appear in the ledger, and whose `refs`
  still match the clone, is deleted (`fault 'close:after-delete-one'`); N's own `prepared` record
  with a clean tree at base is deleted; anything else is reported in `kept` (`dirty: true` for a
  dirty own record) with exit 0. Every firing runs it at §8 (a firing that never prepared closes
  only older records). When `<W>` failed `checkClone` or quiesce in this firing, `close` writes no
  bundle and reads nothing in `<W>`: it only deletes records that need no clone fact.

## 14. scripts/loop-recover.mjs (extend; the single planner; read-only)

CLI `node <T>/scripts/loop-recover.mjs <P> --generation <N> [--reclaimed <g>]` (`--worktree`
removed). It writes nothing (git through `workGit` with optional locks off; the legacy worktree
through `safeGit --no-optional-locks`). Exit 0:

```
{generation, reclaimed, now, now_sha256,
 clone:{exists, valid, problems, head, branch, dirty:{staged, tracked, untracked}, locks},
 records:[{generation, phase, verdict, sha, ledgered}],
 finish:null|{generation, sha}, recovered:null|{generations, commits, bundles, task},
 write_bundles:[branch], legacy:{worktree:{exists, staged, tracked, untracked}},
 actions:[…], notes:[…]}
```

Actions, in this order: `finish-commit`, `requeue-now`, `ledger-recovered`, `write-bundle`,
`note-leftovers`.
- `finish-commit`: the newest unresolved record reads `committed`, `## Now` holds an item,
  `sha256(nowLine) === rec.now_sha256`, and neither a `## Done` line (full sha, or a 7+ hex prefix)
  nor a ledger row names that commit. The main session moves the Now item to `## Done` with the
  sha in one Edit (no title search; otherwise `requeue-now` plus a note).
- `requeue-now`: Now holds an item and `finish-commit` does not apply.
- `ledger-recovered`: some record's commit, save or recovery sha appears in no ledger row; this
  firing's single row gets `recovered`.
- `write-bundle`: a branch with a committed record has a missing or stale bundle and `vettedTip`;
  the main session runs `loop-clone.mjs bundle`.
- `note-leftovers`: the newest unresolved record reads leftovers, delegate-commit, rewind or resume.
Exit 2 `{state:'error', detail}` (incident, paused, outcome skipped, stop the runner, as 0c-1)
with `corrupt`, `record-from-the-future` (g >= N), `tampered: <file>` (a referenced patch missing
or with another sha), `clone-invalid`, `unknown-tip` (the newest unresolved record reads
`unknown`). Older records are reported `resolved` or `superseded` without consulting the clone.

## 15. scripts/loop-review.mjs (new; owner terminal only; never named by skills/loop/**)

- `paths <P>` -> `{V, W, out}` (read-only, no TTY needed).
- `fetch <P> [--branch <b>] [--trust-unrecorded]` (TTY on stdin and stdout, else exit 2
  `needs-terminal`): each `<V>/out/**/*.bundle` (not `.tmp-*`, `.prev-*`) must have exactly one
  head `refs/heads/<branch>` matching its path; its tip must be in `ledgerShas` (commits,
  recovered commits, bundle tips), already in `<P>`, or `--trust-unrecorded`; `bundle verify -q`;
  then `git -C <R> -c fetch.fsckObjects=true -c transfer.fsckObjects=true fetch --no-tags
  --no-write-fetch-head --no-recurse-submodules <file> refs/heads/<b>:refs/remotes/tech-lead/<b>`
  (non-forced). All through `safeGit`. Exit 0 `{state:'fetched', results}`; 3 `refused`; 2 usage.
- `retire <P> <branch>` (TTY; the owner types the branch name): `git -C <R> update-ref
  refs/tech-lead/retired/<branch> <tip>` (the tip of `refs/remotes/tech-lead/<branch>`, else the
  bundle's tip); it notes any other dated branch whose tip descends from it.

## 16. Small changes to 0c-1 modules

- `loop-lock.mjs`: `acquire` prints `W: paths.W`; `N = max(top, ledgerFloor(S),
  maxRecordGeneration(paths)) + 1`; the reclaim and exec sweeps use `sweepOthers` (dirs stay
  `[<S>/worktree, <V>]`); `verifyCommands` wraps `frontList`; `ledgerFloor` re-exported from
  `ledger.mjs`; usage text drops "(no W …)".
- `loop-recover.mjs`: `nowLine` and `PLACEHOLDER` move to `loop-state.mjs` and are re-exported.
- `loop-codex.mjs`: comments and usage say "clone".
- `loop-text.mjs`: LABEL adds `recovery`.

## 17. Layout under `<V>`

```
<V>/identity.json  lock/  clone/ (0700, <W>)  clone.tmp-<pid>-<hex>/ (0700)
<V>/out/<prefix>/<date>.bundle  + <date>.bundle.json  + .prev-<UTC stamp>
<V>/run/<N>.json   run/empty-template/
<V>/patches/<sha>.patch   patches/.tmp-*
<W>/.git/tech-lead-deps.ok
```

## 18. Ledger and STATE.md

- Ledger row (no new key inside `"panel"`): `bundles: [{branch, tip, file (relative to <V>),
  sha256, why:'commit'|'regenerated'}] | null`; `saves: [{sha, why, files, out_of_scope}] | null`
  (every bundle this firing saved, `prepare`'s clean-clone saves included); `recovered:
  {generations, action, commits, bundles, task} | null`; `commits` holds only this firing's own
  commits.
- `## Needs decision` delegate-flagged entry: `**Recovery:** <64hex> · base <oid> · item-digest
  none · scope <digest>`. `## Blocked` item: sub-bullet `  - recovery: <64hex>`. `## Last run`
  notes each saved bundle (`saved <why> bundle <sha12> (<n> files, <k> out of scope, <h> hidden)`),
  recovered work, delegate commits, hidden paths and bundle errors. `## Now` placeholder stays
  `(empty)`.

## 19. The firing with the clone; persistence boundaries

Prose order:
1. §1: acquire (prints `W`); read state; `loop-recover.mjs <P> --generation <N> [--reclaimed
   <g>]`; act (finish-commit or requeue-now Edit, `loop-clone.mjs bundle` per write-bundle, notes;
   `recovered` carried to the §8 row).
2. §2-§4 unchanged.
3. §5 write-capable dispatch: `prepare` (once per firing; its `recovered` saves go to the §8 row and
   `## Last run`); `deps`; the install through `loop-lock exec … --label deps --cwd <W>` when not
   fresh; `check --after deps`; `deps --mark`; `dispatch open`; the Agent dispatch (or Codex start,
   wait, quiesce with `--cwd <W>`); `dispatch close`; `check --after dispatch`.
4. §6: delegate-flagged -> Save and reset (`delegate-flagged`). Else the scope rail on `check`'s
   `out_of_scope` (non-empty -> attempt failure); verify: for each K, `exec … --verify K`, then
   `check --after verify`; a changed digest restarts verification from K = 0 once, a second change
   is an attempt failure (R22); `commit --digest <the last check's digest>`; the item to `## Done`
   with the sha.
5. §7: first failure keeps the attempt (no new `prepare`); second failure -> Save and reset
   (`attempt-failed`), then Block with the `recovery:` sub-bullet. Codex not completed or result
   unreadable (after a quiet quiesce) -> Save and reset (`codex`). `check`/`commit` `tampered` or
   `work-changed` -> Save and reset (`pause`), then pause. Touch-nothing pauses (no save, no reset;
   the next `prepare` saves the leftovers): `clone-invalid`, Codex `quiet: false`, exec
   `lingering`, a lock error after a dispatch, `unsavable`, `index-only`, `busy`, a failed save.
6. §8: `## Last run` and `## Now` `(empty)`; the ledger append; `loop-clone.mjs close <P>
   --generation <N>` (its `kept`, `bundleError` or exit 2 go only to the summary; they write no
   second row and never block the release); release, last (both inside §8's existing step 3).

Save and reset (named procedure; replaces §7 "Reset"): (1) `reflex-bundle.mjs save <P>
--generation <N> --why <why>`: `empty` -> done (a dirty index is reset by the next `check` or
`prepare`); `not-holder` -> Lost lock; any other failure -> no reset, incident, `paused: true`,
item back unchanged, outcome `halted`; (2) one Edit writes the sha at the caller's place together
with the item's section move; (3) `reflex-bundle.mjs reset <P> --generation <N> --sha <sha>`:
`unsaved` -> repeat from (1) once; `busy` -> no reset, pause (the next `prepare` resets); a second
refusal, `tampered`, `index-locked`, `index-only` or `partial` -> pause with an incident.

Fault points: `prepare:after-temps`, `prepare:after-locks`, `prepare:after-preparing`,
`recover:after-rewind-intent`, `recover:after-rewind`, `recover:after-save`, `recover:after-reset`,
`clone:after-clone`, `clone:before-rename`, `refresh:after-fetch`, `rotate:after-switch`,
`bundle:before-rename`, `prepare:after-record`, `check:after-rewind`, `commit:after-intent`,
`commit:after-update-ref`, `commit:after-record`, `close:after-delete-one`, `save:after-write`,
`save:after-check`, `save:after-link`, `save:after-record`, `reset:after-check`,
`reset:after-intent`, `reset:after-unlink-one`, `reset:after-read-tree`, `reset:after-record`.
Driver stops (`tests/fixtures/firing-driver.mjs` extended): `acquired`, `picked`, `prepared`,
`deps`, `dispatched`, `dispatched-commit`, `checked`, `verified`, `saved`, `saved-state`,
`committed`, `done`, `ledger`, `closed`. A planted half-written file inside a reset covers a kill
during `read-tree -u` itself.

Invariants (asserted after the recovering firing, and again after a third firing): I1 no work
lost: a commit holds the edits, or applying the anchored bundles onto their base reproduces the
pre-kill working tree byte-exactly (an out-of-scope file, an exec bit, a symlink, a file hidden by
a delegate `.gitignore` edit, CRLF bytes, a file in an obstructing directory); I2 `<W>` clean at
the expected tip, no `.lock` left; I3 `## Now` `(empty)`, the item in the expected section; I4 one
ledger row per completed firing (an interrupted firing's generation may be a gap), every commit
and bundle sha in some row, generations strictly increasing; I5 every branch with loop commits has
a verified bundle and no bundle holds a delegate commit or a retired tip; I6 no `refs/stash`, and
`<P>` byte- and time-identical (tree, `.git`, refs, config, index) except the governance files
under `<S>`; I7 killing the recovering firing again gives the same end state, and once a bundle
sha is recorded in a run record it is reused (an earlier kill gives one new anchored bundle; the
unanchored file is an orphan); I8 no run record left except as expected, and no unresolved record
older than the newest.

Matrix (one test or subtest per row): 1 after acquire (0c-1); 2 after pick; 3 temps and stale
locks; 4 clone before rename; 5 mid-fetch; 6 mid-switch (planted half checkout and index.lock); 7
deps exec group alive; 8 after prepared, then two more firings that commit (the commit stays on
the branch and in the live bundle); 9 delegate edits of every kind; 10 plus a delegate commit
(rewound, never bundled); 11 verify artifacts; 12-17 the recovering prepare killed at each
recover:* and reset:* point; 18-19 save killed before and after link (a new anchored bundle; the
earlier file is an orphan); 20 saved, STATE not written; 21 STATE written, no reset; 22 reset
partial, including a half-written file; 23 checked but not committed; 24 commit:after-intent; 25
commit:after-update-ref (finish-commit, ledger-recovered, write-bundle; the stale index is reset);
26 the same with the Now line edited; 27 bundle before rename / bundled; 28 Done written, no
ledger row; 29 after the ledger; 30 after close; 31 the recovering firing killed after its §1
Edit; 32 a double interruption across a date change; 33 a double interruption with two commits on
one branch; 34 a no-record dirty clone (a stray writer after a normal release); 35 a set-aside
clone with unresolved records of the same and an earlier day; 36 a staged-then-reverted change
(index-only pause, nothing lost); 37 finish-commit with a byte-identical second Now line.
Live children: exec verify group alive; an unrecorded process in `<W>` (held child-live); a
process in `<W>` after a normal release (`busy`); a writer between save and reset (`unsaved`,
re-save); a live Codex job (quiesce or held); same process with an open dispatch. Tamper: a
recorded patch byte-flipped, deleted or replaced (planner exit 2, reset refuses, `<W>` unchanged);
a corrupt or future run record; a store collision; a tampered delivery bundle (the sidecar
mismatch regenerates it); a ref changed in `<W>` between firings (`tampered`).

## 20. Prose

- `skills/loop/SKILL.md`: §1 step 1 drops `<W>` = `<S>/worktree`; step 3 takes `<W>` from
  acquire's `W` and says the main session runs git in `<W>` only through `loop-clone.mjs` (reads
  through `loop-clone.mjs git <P> -- …`), keeping `LOOP.md` out of §1 before the acquire; the Lost
  lock list adds `loop-clone.mjs` and `reflex-bundle.mjs` exit 3 `"state": "not-holder"` (the
  existing `release` and `holder-unknown` wording verbatim); step 5 the new planner line and its
  five actions; §5 "Prepare the clone (`references/clone.md`)", `check --after dispatch` after
  every dispatch and after a quiet Codex quiesce; the high-stakes panel snapshot (steps 2 and 6)
  uses `git -c diff.autoRefreshIndex=false diff HEAD --binary …` so it never writes `<P>/.git/index`;
  §6.1 Save and reset; §6.2 touched paths and `out_of_scope` from `check`, `.tech-lead/` out of
  scope (R7), `hidden` paths noted; §6.3 keep the exec line verbatim, add `check --after verify`
  and the R22 restart rule, drop the `diff --cached`/`restore --staged` asserts; §6.4 the subject
  to `<S>/briefs/<slug>.subject`, `loop-clone.mjs commit`, the hooks sentence; §7 Save and reset
  and the touch-nothing list; §8 `close` after the ledger append, before the release, inside step
  3; Safety rails: no git in `<W>` except through the helpers; files in `<V>` created and removed
  only by the helpers; edits in `<W>` discarded only by Save and reset; never `checkout -- …`,
  `restore --worktree`, `git clean`, `reset --hard` in `<W>`; the loop never writes `<P>`'s tree or
  `.git` outside `<S>`; drop the `U` line.
- `skills/loop/references/clone.md` (new) replaces `worktree.md` (`git rm`; every link updated):
  paths; `prepare` and how its output goes into `## Last run` and the ledger row; step 4
  `**Dependencies**` holding only the `exec … --label deps --cwd <W> --timeout-ms 540000 --
  <install>` line and its outcomes (`deps`, `check --after deps` and `deps --mark` sit in steps 3
  and 5); `check` after every untrusted execution; the refusal table (§13 states -> loop action);
  the delegate contract (`cd <W> && …`, absolute paths under `<W>`, never read or write `<P>` or
  its `.tech-lead/`, never touch `<W>/.git`, no state-changing git, ignore a committed `.tech-lead/`
  copy, no `isolation: "worktree"`); one line pointing at the README review flow.
- `skills/loop/references/loop-templates.md`: ledger fields; the `**Recovery:**` entry line; the
  Blocked `recovery:` sub-bullet; the marker sentence; infra incidents name an invalid clone and a
  failed save. The `.gitignore` block and `bootstrap.md` step 5 stay untouched (0c-4).
- `README.md`: where commits land; "Reviewing loop work" (`loop-review.mjs fetch`, `git log
  <base>..tech-lead/<branch>`, merge, retire; never run git inside the clone; clearing `~/.cache`
  deletes unfetched work); Troubleshooting: the corrupt-clone set-aside (`loop-lock.mjs status`,
  fetch, `mv <W> <V>/clone.broken-<stamp>`, unpause); "clone: save-failed" (status, move the named
  paths out of `<W>` with plain `mv`, unpause); "recovery planner: tampered/corrupt/
  record-from-the-future" (status, fetch, move the named run record to `<V>/run.broken-<stamp>/`,
  unpause, replace any stale `recovery:` sha in STATE.md); "index-only" (inspect with `loop-clone.mjs
  git`, then the save-failed steps); the work-area table; troubleshooting rows name the clone (keep
  `child-live` and `sweep-unknown` backticked); "Upgrading to 0.5.0"; the helpers list; the allow
  list names the clone path.
- `scripts/loop-start.mjs`, `scripts/loop-codex.mjs` comments: "clone".

## 21. checks (`scripts/checks/loop.mjs`; each with a mutation test in tests/check.test.mjs)

- Point the shared `WORKTREE` constant at `skills/loop/references/clone.md` (both checks that read
  step 4 "Dependencies": the deps-exec check and the exited/lingering exec-rule check); rename their
  check names; move the worktree.md tests in tests/check.test.mjs (deps-exec, timeout rows,
  `LOOP_WORKTREE`, the "worktree.md step 4" assertions, the git-stash append) to clone.md anchors.
- SKILL.md and clone.md contain no `git -C <W>`, no `worktree add`, no "`<W>` = `<S>/worktree`".
- Every `loop-clone.mjs` command in skills/ except `git`, and every `reflex-bundle.mjs save|reset|
  apply`, carries `--generation <N>`.
- §8 names `loop-clone.mjs close <P> --generation <N>` after "Append exactly one ledger entry" and
  before the release; the existing "release is the last command" check stays.
- §1 step 5 names `loop-recover.mjs <P> --generation <N>`.
- skills/** never names `loop-review.mjs`.
- skills/loop/** has no `checkout -- `, `restore --worktree`, `restore -W`, `git clean` or
  `reset --hard` except on a line that forbids it.
- The Save and reset procedure orders `reflex-bundle.mjs save`, the STATE Edit, then
  `reflex-bundle.mjs reset`.
- The panel snapshot line carries `diff.autoRefreshIndex=false`.

## 22. Tests (real temp repos and processes; hermetic git env as the 0c-1 lock tests; no OS mocks)

git-safe (options, scrub additions incl. identity dates, workGit refuses a gitfile, hostile global
config runs no hook, fsmonitor or external diff, cwd is `<W>`); atomic (fsync paths, tempFile,
tempDir, commitExclusive identical vs different, sweepTemps files and directories, live vs dead);
canonical; loop-md (verifyCommands messages unchanged); loop-scope (every §11 case, invalid beats
whole, a symlink out of `<W>` under an explicit scope and under `./`); loop-state, ledger (moved
functions unchanged); loop-proc (ancestry export incl. the unknown path: acquire held
`sweep-unknown`, exec `lingering`); changes (every change kind incl. CRLF and filters with raw
capture; the replay against a tracked `.gitignore` edit, a new nested `.gitignore`, an info/exclude
edit and a deleted `.gitignore`; deps-created self-ignored directories (venv, `.husky/_`,
`.pytest_cache`) ignored under recorded rules and absent from `touched`; hidden vs standard;
negations; precedence; base and current modes; the nonce refusal; obstructed directories; index-only
detection incl. the commit-finalize exception; unsavable kinds; the temp-index allocator);
run-record (schema, every verdict and precedence rule, isResolved only from stored fields,
committedSha, vettedTip, maxRecordGeneration); clone-check (each tamper case; husky's
`core.hookspath` and `.git/hooks` allowed; a fresh clone clean); reflex-bundle (round trip of every
kind byte-exact; re-save; hostile config same sha and nothing run; diff driver attribute with a
histogram config gives the same sha; no stash, index, HEAD or ref change; tamper of every kind;
reset `unsaved`, `not-anchored`, `head-moved`, `busy`, `index-only`, relaxed resume of a half-written
file, symlinked ancestor never followed; resetEmpty; fencing; size cap; apply refusals and the §11
contract); loop-start (resolveBase + chainStart equal startPoint; validPrefix; retired comparable
skip D1<-D2<-D3; vetted skip); loop-clone (create: full clone, no remote, alternates or info, 0700
before content, `<P>` byte-identical incl. its index; loop12 inside the clone; refresh with a base
that advances during it; chaining across days, after a merge and a squash merge; adoption incl.
diverged; legacy coexistence with a dirty `<S>/worktree` left byte-identical; stale lock removal
only after an empty sweep; every prepare arm; loop04; tamper cases incl. a ref changed between
firings; deps marker, husky install not `deps-dirty`, a lockfile rewrite `deps-dirty`; commit with
odd names, `work-changed`, one trailer, no Co-Authored-By, `<P>`'s identity even with inherited
`GIT_AUTHOR_*`, parent H0, hooks not run, `unchanged`; bundles verify in a copy of `<P>`, one head,
base prerequisite, chained bundle, sidecar, `.prev` kept, regenerated after a base rewrite or a
corrupted file; a forced repack after rotation leaves checkClone clean; retire resets today's
branch; close in every state; passthrough flags per subcommand and refusals; fencing of every
mutating command; quiesce not quiet leaves `<W>` untouched); loop-recover (every verdict to actions;
finish-commit binding and the already-done condition; ledger-recovered; write-bundle withheld for
delegate-commit; older records `resolved`; the never-writes snapshot extended to `<V>/run`,
`<V>/patches`, `<V>/out`, `<W>/.git`); loop-review (TTY refusal, unrecorded tip, fsck fetch, corrupt
bundle, non-fast-forward, missing prerequisite, retire); loop-lock (W printed, floor above run
records); the §19 matrix, live-child and tamper tables; a check mutation test per §21 check.
Per-test timeouts as 0c-1; darwin-only sweep cases skipped elsewhere; three full-suite runs with no
leaked `sleep 120`.

## 23. Residual risks (named in the plan)

A forged run record before stage 2 (R3); a delegate that forgets `cd <W>` writes `<P>` undetected
before stage 2; project hooks no longer run; `<P>`'s repository config (autocrlf, filters),
submodule contents and LFS objects are not carried into the clone; a commit applies the owner's
check-in conversion (a save does not: R19); disk use doubles and a huge first clone can pass 540 s
(an `infra` pause); a purged cache loses unfetched work; a git upgrade writing new config keys gives
a false `clone-invalid`; git lock removal relies on the cwd sweep; `.prev` bundles, orphaned and
anchored bundles accumulate in `<V>`; writes to ignored paths outside obstructing directories, or
inside an uninitialized submodule path, are neither saved nor reset; a delegate can keep a file out
of a commit (never out of a save) by hiding it with a new ignore rule (R2); the replay relies on git
reading a skip-worktree per-directory exclude file from the index (pinned by a test); §15's
lock-integrity residual is unchanged.

## 24. For later stages

0c-3: passes `item` to `commitMessage`, owns `ID_RE` and `itemDigest` (imports `canonical.mjs`),
extends `loop-state.mjs` with the item grammar (keeping the `recovery:` label), adds `item_id` to
the run record (`v:2`; the planner prefers id equality over `now_sha256`). 0c-4: imports
`loop-scope.mjs` and adds the CLI, bootstrap/migration/§2 gates and refusals; adds the `legacy`
layout to `changes.mjs` and the `migration` why; calls `ensureClone`/`adoptBranches`/`checkClone`
to retire `<S>/worktree` without `--force`; owns the `.gitignore`/exclude lines and bootstrap.
Stage 1: moving the ledger into `<V>` changes `ledger.mjs` (floor, shas) for every reader at once;
content bundles join `reflex-bundle.mjs`. Stage 2: §7.8 manifest (from `checkClone`, `cloneMeta`,
`refsSnapshot`), mirroring the run record outside `<V>`, the open-file sweep, `denyWrite` on
`<W>/.git/hooks` and `config`, runner `cd <V>`, Codex in the sandbox. Stage 3: the release path
extends `apply` with §7.5's moved-base allowance (if `header.base..HEAD` touches none of the
bundle's paths and no verify-config file, apply onto HEAD and check each bundle path against
`header.tree`; else `moved-base` and re-flag) and reuses `check` and `commit`.

---

## Addendum (2026-10-03): rulings from the prototype review

Amendment A11 is now spec revision 7 (§7.5 clean clone, decision log). The prototype was reviewed
by Codex (four module groups) and a five-lens Claude workflow with a skeptic per finding; the
rulings below were added for the fix rounds and bind the landed code. The landed code is the
reference where this brief and it differ; the plan's Appendix B lists those differences.

## New rulings (binding for this fix pass; the plan records them)

- R24 Git version: helpers that rely on attribute isolation feature-test it once per process
  (`GIT_ATTR_SOURCE` honoured, git 2.40+); on a git that fails the test they refuse
  (`infra`, detail `git-too-old: needs git 2.40 or newer`) instead of running unisolated.
- R25 Ignore rules survive close. `close` writes the newest closed record's recorded `rules`
  into the run anchor (`<V>/run/refs.json` becomes `{v:2, generation, refs, rules}`; carry the
  previous rules forward when the newest record has none). A prepare that finds no unresolved
  record lists leftovers under the anchored rules (`recorded`), under `current` rules when the
  anchor holds `rules: null`, and under base rules only when no anchor exists. `close` also keeps
  (does not delete) an own `committed` record whose tree, judged under its recorded rules against
  its commit, still holds untracked or hidden files (`kept` reason `hidden`), so the next prepare
  saves them (R2).
- R26 Submodules and nested repositories: no helper ever makes git run inside a nested
  repository. Change detection uses `--ignore-submodules=dirty` (commit-level gitlink changes are
  still seen and stay unsavable); the legacy-worktree and clone status reads neutralize filter
  drivers the same way `collect` does.
- R27 Retire never drops a rejection. A second `retire` of a branch at a different tip keeps the
  earlier tip under its own ref (`refs/tech-lead/retired/<branch>@<sha12>`) before writing the new
  one; chaining and bundle sync treat every `refs/tech-lead/retired/**` tip as retired.
- R28 Vetting is explicit. A record's refs snapshot never vets a tip. The creating prepare stores
  the tips it adopted in a new record field `adopted: [{ref, tip}]`; `vettedTip` accepts a
  record's committed sha, a ledgered commit or bundle tip, an `adopted` entry, or containment in
  the base. The prepare tamper check skips only a record whose `head_ref` is null (it holds no
  snapshot); otherwise it compares with the newer of that record and the run anchor.
- R29 Saves see raw bytes. Save enumeration and the reset precondition include every tracked
  path whose raw working-tree bytes or mode differ from what a checkout of the base writes
  (`cat-file --batch --filters` with filter drivers neutralized and attributes from the base),
  besides git's own diff; commits keep git's normal conversion-aware view.
- R30 Rotation never overwrites ignored files: every rotation `switch` passes
  `--no-overwrite-ignore`; a collision refuses `infra` naming the paths (leftovers were already
  saved earlier in the same prepare).
- R31 Lock loss mid-write: every helper that publishes or destroys (delivery publication and
  sidecar, reset's intent, unlinks, rmdirs, read-tree, record writes) re-checks the lock right
  before the step and propagates `NOT_HOLDER` / `HOLDER_UNKNOWN` as such (never as `partial` or a
  branch `error`). Delivery functions take a required `guard()` callback for this.

## Ruling amendments

- R29a: a tracked file whose raw bytes equal the base blob is not listed even when they differ from
  what a checkout writes (the bytes already have a durable home in the base; listing them would
  stall every save). This is the deliberate exception to R29's "every tracked path".
- R32: adopted-tip continuity. `close` keeps the creating record (reason `adopted`) until each of its
  `adopted` tips is named by a ledger commit or bundle tip, or is contained in the base.
- R31 (sharpened): a guard check must sit immediately before the write it protects, with no git
  call or other blocking work between them; compute every git-derived value first, then check, then
  write. A `not-holder` from delivery can leave a published bundle without its sidecar; prose must
  say so (it no longer promises that nothing was published).

