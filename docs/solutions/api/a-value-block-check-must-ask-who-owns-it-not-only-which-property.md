---
title: A check that a value block belongs to the property must also ask which block owns it, because a text or URL value block dies with its holder
area: api
tags: [value-block, ownership, shared-ref, uuid, text-property, url-property, delete-blocks, silent-loss, refused-by-type, own-values-only]
seen:
  - 2026-11-19 – item 34 (connector #34), patch 0047; one skeptic first refuted it because the app's picker shares values, the second confirmed
promoted_to: []
---

## Symptom

Setting block B's text or URL property to the UUID of a value block that belongs to block A returned 200 on all four write paths (set, batch-set, insert tree, batch insert trees). Deleting A then deleted that value block, and B's property read empty with no error. A string value was safe: it always got its own value block.

## Cause

`refused-by-type` (`own-values-only?`, patches 0022 and 0044) asked only that the value block's `:logseq.property/created-from-property` is this property. That proves the type, not the owner. A text or URL value block made from a string is parented to its holder (`find-or-create-property-value`), so it is deleted with the holder, and `retractEntity` drops other blocks' refs to it silently. `free-text-value?` leaves UUID strings out on purpose (a UUID "keeps referencing an existing value"), so the UUID went straight to `resolve-ref-entity`. Number value blocks and default-value blocks are parented to the property and survive, so the same input is safe for them. The same reasoning applied to the earlier bare-db-id fix (0044): each new input form needs the ownership test, not just the type test.

## Fix

Patch 0047 gives `refused-by-type` the write's scope. An own value whose `:block/parent` is neither the property nor the block or page being written is refused 400, naming the entry, the UUID and its holder, with nothing written. Re-sending the block's own value, a default-value block and a number value stay accepted. Refuse rather than copy was a design call recorded for the owner to overrule: the app's editor makes a per-holder value block for one block and shares only when several blocks are edited at once.

## How to catch it next time

- When a guard checks that a referenced entity "belongs to" something, ask which lifecycle it has. A hidden child owned by another block is deleted with it.
- Test: set B to A's value UUID on every write path, then delete A and read B. A test that only asserts the 200 or the stored ref will pass.
- Include the controls that must stay accepted (own value, default-value block, number) so the rule is seen to decide.
- Open: a number given as a number on an imported graph can still share another holder's value block (backlog r1-correctness-1).
