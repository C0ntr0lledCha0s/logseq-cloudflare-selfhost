---
title: A handler that calls delete-blocks! must count what refers to the blocks, and a ref property's referrer is the holder, not its hidden value block
area: api
tags: [convert-values, delete-blocks, references, embed, block-link, hidden-value-block, acknowledge-references, dry-run, destructive]
seen:
  - 2026-11-07 – item 26 defect 4, patch 0030 (round 1 r1-tests-1, round 2 skeptic refuted r2-correctness-1)
  - 2026-11-22 – blank-blocks-sync-status, patch 0056 (r1-correctness-1, r1-integrity-1): `deleteBlankBlocks` counted referrers through `reference-attributes`, which drops Logseq's own properties, so a blank block that a comment thread, reaction, view or history entry pointed at was listed and deleted with the comments under it
promoted_to: ["REVIEW.md", "CLAUDE.md Gotchas"]
---

## Symptom

`updateProperty` with `convert_values: true` returned 200 and deleted the old text value blocks even when other blocks referred to them. A `[[uuid]]` in a title was flattened to plain text, an embed (`:block/link`) became an empty block, and another property's value pointing at the block was dropped. The dry run gave only `{values, holders}`, so the owner had nothing to approve against.

## Cause

Patch 0026's `validate-conversion` read only the converted property's own `:avet` datoms, and `convert-values!` called `outliner-core/delete-blocks!`. Neither the outliner nor the db layer refuses a delete because of references. The `ldb/transact!` delete hook rewrites `[[uuid]]` referrers to the block's title and retracts `:block/refs`, and `retractEntity` silently drops `:block/link` and ref-property values. The reference-counting helpers from patch 0011 (`reference-attributes`, `referrer-ids`, `block-reference-count`) existed but were not called on this path.

Two traps while fixing it:
- The converted property's own attribute is in `reference-attributes`, so it must be left out or every holder counts as a referrer of its own value.
- When another node property holds the link, `referrer-ids` returns that property's hidden value block, not a block the owner can see. The refusal must name the blocks that hold that value (through the property's `:avet` datoms, or the block the value sits under when nothing holds it), and count those, deduplicated.

## Fix

Patch 0030 adds `acknowledge-references` to updateProperty, a `deleted` and `referenced` count in the `converted` response (dry run included), and a 409 naming the property and the count when referenced value blocks would go and the flag is absent. A call that needs both this flag and `acknowledge-holders` names both. Nothing is written on refusal.

## How to catch it next time

- Any handler path that deletes blocks the caller did not name individually needs a reference count, a dry-run count and an acknowledgement, the way item 12's deletes have. Grep new `delete-blocks!` calls in a patch for it.
- Test one referrer per mechanism: `[[uuid]]` title, block ref, embed (`:block/link`), a node property value, a cardinality-many node property value, plus a case where the only link is the converted property itself (expect 0).
- Pin the refusal body shape (which keys are present) and the singular and plural wording, not only the status. Round 1's mutations survived until the shape was asserted.
- `reference-attributes` leaves out Logseq's own (internal) ref properties: `:logseq.property.comments/blocks`, `:logseq.property.reaction/target`, `:logseq.property/view-for`, `:logseq.property.history/block`. A guard built on it alone misses them, and `delete-blocks!` then removes the target together with the comments, reactions and views under it. Patch 0056 reads the built-in properties of type node or entity that the graph's schema holds (`internal-reference-targets`, once a call, not per leaf: the per-leaf version took the dry run at the caps to 744 ms against a 500 ms bound, 398 ms once). Filter by the schema, or a dry run answers 500 (`Attribute ... should be marked as :db/index true`). Test one blank leaf per internal property, and mutate each away.
- Known limit, not a defect of this fix: `((uuid))` text written through the API gets no `:block/refs` (the pipeline only parses `[[uuid]]`), and neither upstream's delete hook nor this guard sees it. The app writes `[[uuid]]` for block refs and embeds, so a skeptic refuted this as pre-existing and not reachable from the app. If it recurs in another lane, add it to Known false positives.
