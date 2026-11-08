---
title: Stamp authorship inside the write's own transaction, keyed on the datoms it produced; a flag header costs nothing
area: api
tags: [edit-stamps, editedBy, claudeEditedAt, authored-write, header, stamp-tx, cost, design-panel, reserved-ident]
seen:
  - 2026-11-07 – item 29, patch 0034, design panel and review round 1 (r1-correctness-1)
promoted_to: []
---

## Symptom

Not a defect. The question was how to mark blocks Claude wrote without a second call (the limit is about 20 writes a minute) and without stamping blocks Claude did not change.

## Cause

A connector-side extra call doubles the writes and is not atomic. A stamp rule based on "everything the write touched" stamps siblings, children or re-keyed blocks. One design judge claimed the move code re-keys many blocks' `:block/order` (`semantic.cljs:3191-3193`). Reading the code showed those lines re-key a property's choices, and the outliner's `move-block` writes only the moved block. The claim sounded right and was wrong, and it drove that judge's ranking.

## Fix

The connector sends `x-logseq-edit-stamp: claude` on non-GET calls when the graph's `edit_stamps` column is on. The flag rides the existing request and the `graphs` row `resolve()` already reads, so there are no extra Worker requests, D1 rows read or written, or neurons (the semantic document hash ignores properties). The server's `authored-write!` stamps in the same transaction, from the write's tx-data: an entity is stamped when a datom adds title, parent or order, or changes tags or a property, and it is a real block (not a property value block). Tests pin that siblings of a moved, inserted or reordered block carry no stamp, with a mutation that adds a sibling re-key.

## How to catch it next time

- When a design judge cites a line number to rank an option, open the line before accepting it. Probe the claim with a test (one test settled it here).
- Derive "what this call changed" from the datoms the write produced and pin the negative cases (siblings, children, value blocks) with a mutation.
- A reserved property ident must be refused on every route that accepts properties, flagged or not. Review round 1 found `prepare-properties`, used by inserts, never checked the stamp idents, so an unflagged insert could store `editedBy=claude`. See `new-selector-form-needs-every-lookup-site.md` for the same shape.
- Deletes and `update_property` stamp the blocks whose values they remove. That is accurate, but docs said otherwise. Describe what a derived rule does, not what was intended.
