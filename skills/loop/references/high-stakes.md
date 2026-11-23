# High-stakes items

The loop reads this file at SKILL.md §5 for a `high-stakes` item, at any
level: these are the loop specifics of the panel protocol
(`../../../references/panel-protocol.md`). Placeholders are those of
SKILL.md §1, and a § number or a section name (Safety rails) without a file
name is SKILL.md's.

1. **Brief.** Write it to `<S>/briefs/<id>-panel.md`, with option ids.
   Pass `briefPath` as an absolute path.
2. **Snapshot the project content**, excluding `.tech-lead/`.
   `diff.autoRefreshIndex=false` keeps the snapshot from rewriting
   `<P>/.git/index`:

   ```
   (cd <P> && { git rev-parse HEAD; git -c diff.autoRefreshIndex=false diff HEAD --binary -- . ':(exclude).tech-lead'; git ls-files -o --exclude-standard -z -- . ':(exclude).tech-lead' | xargs -0 shasum; } | shasum)
   ```

3. **Run the seats,** each dispatch bracketed by a dispatch record (§1
   step 3):
   - Workflow opted in → `Workflow({name: "tech-lead:panel-seats", args:
     {briefPath, options}})`;
   - otherwise, or if the workflow is "not found" → the protocol's Agent
     form.
4. **Upsert `## Needs decision`.** Write the synthesis using the template
   format, headed `### <id> · <title>`, recording each seat's model and
   the `agreement`. Each seat's line is seat-written text, so it goes
   through `loop-text.mjs line` first (Safety rails). Replace any existing
   entry whose heading has this item's id; never append a second one.
5. **Set outcomes.** Mark the item `status: waiting-decision`, and record
   outcome `needs-decision`.
6. **Re-take the snapshot,** with the same command. If it differs, the
   project changed during the panel. The cause may be a seat, or the
   user's own concurrent edits.
   - Put a warning in the `## Needs decision` entry and in `## Last run`.
   - Set `paused: true`, so a human looks before the loop continues.
   - Never revert the user's tree.

The loop never executes a high-stakes decision itself. The panel runs at
every level, including L1.
