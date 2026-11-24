# Recovery actions

The loop reads this file at SKILL.md §1 step 5, before it takes the first of
the recovery planner's `actions` (never when `actions` is empty).
Placeholders are those of SKILL.md §1, and a § number or a section name
(Item edits) without a file name is SKILL.md's.

- `clear-now`: `## Now` holds one item, and an identical copy of it
  (same id, title, notes and decision, the same `blocked-by:`,
  `decided:` and `no-change-ok:` lines, the same origin lines as
  written, and every other line under the header the same; only the
  header form and the line a move writes, such as a `status:` or
  `recovery:` line, may differ) is in
  `clear.section`, so an interrupted firing stopped inside a move,
  after the insertion and before the deletion (Item edits). The other copy is the item. Apply
  `clear.edits` in order, one Edit each (Item edits, Applying edits):
  they delete that one block from `## Now`, never anything else there.
  Then run
  `node <T>/scripts/loop-items.mjs check <P> --expect <clear.expect_sha256>`,
  and note "cleared interrupted move of <clear.id>" in `## Last run`.
  Then confirm the other copy as a move is confirmed (Item edits, steps
  1 and 5): `node <T>/scripts/loop-items.mjs digest <P> --item <clear.id>`,
  then
  `node <T>/scripts/loop-items.mjs check <P> --item <clear.id>@<clear.section>:<item_digest>`.
- `now-conflict`: the `## Now` item's id is carried elsewhere too, but
  the copies are not one item moved halfway: they differ (a person
  amended one: its title, notes or decision, `digest-differs`; its
  `blocked-by:`, `blocked-by-differs`; an origin line,
  `origin-differs`; its `decided:` or `no-change-ok:` line,
  `decided-differs`, `no-change-ok-differs`; or, with none of those,
  any other line under the header, such as a field added or changed,
  `block-differs`), `## Now` holds another
  block as well (`several-now-items`), the id has more than one other
  carrier (`several-carriers`), or a line that does not read as that
  item carries it (an `id:` line of an unparsed block, `raw-carrier`).
  `conflict.reasons` says which, and `conflict.carriers` lists where
  each copy is. It is an
  item-edit incident (Item edits), named by `conflict.id` and
  `conflict.reasons`: edit no item and keep every copy (a prerequisite
  added to one copy included). The incident
  ends the firing here, so the actions listed after it are not taken
  (the next firing's planner lists them again). A person decides which
  copy is the item (README, Troubleshooting).
- `finish-commit`: an interrupted firing committed the `## Now` item but
  stopped before its bookkeeping (the planner matched the run record's
  item id and digest, and its `## Now` line; for a record an older
  release wrote, the line alone), and the item has no item problem (a
  `## Now` item with one, such as a second `notes:` line the digest does
  not read, gets `requeue-now` instead, so a person can correct it).
  Move that item to the top
  of `## Done` (Item edits), in its format, with `finish.sha` in the sha
  slot (no title search); the check takes `finish.item_id` and
  `finish.item_digest`.
- `requeue-now`: `## Now` holds an item, so a prior firing was
  interrupted. Move that item back to the top of `## Backlog` (Item
  edits), keeping its whole block, its recorded `status:` and `class:`
  included. Fold a "recovered stale Now" note into this firing's
  `## Last run` and into its single ledger entry. One firing, one entry.
- `ledger-recovered`: a commit or bundle of an interrupted firing is in
  no ledger entry. This firing's single entry carries the planner's
  `recovered` as its `recovered` field (its `item_id` and `item_origin`
  included), with `action` set to the `## Now` action taken
  (`finish-commit`, `requeue-now`, or null; null after `clear-now`).
- `write-bundle`: for each branch in `write_bundles`, rewrite its
  delivery bundle:

  ```
  node <T>/scripts/loop-clone.mjs bundle <P> --generation <N> --branch <branch>
  ```

  `bundled`: add its `bundle` to the ledger entry's `bundles`. `current`:
  nothing to do. Anything else (`unvetted`, exit 2): note it in
  `## Last run`.
- `note-leftovers`: `<W>` holds work that an interrupted firing left.
  Note it in `## Last run`. Do not touch `<W>` here: the next clone
  preparation (`clone.md` step 1) saves it to a recovery
  bundle and resets `<W>`.
