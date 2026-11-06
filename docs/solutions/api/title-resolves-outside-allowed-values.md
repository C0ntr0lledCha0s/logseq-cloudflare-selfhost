---
title: A value given by title must resolve only among the property's allowed values, because nothing downstream checks
area: api
tags: [identifiers, titles, closed-values, choices, node-property, classes, value-blocks, url, silent-success, resolve-ref-entity, title-candidates]
seen:
  - 2026-11-06 – item 25, patch 0021 (relationship-status "active" stored project-status's "active" choice)
  - 2026-11-06 – item 25, review rounds 2 and 3 (r2-correctness-1, r3-correctness-1, r3-integrity-1): the fix's own title ranking repeated the class
  - 2026-11-06 – item 23, patch 0022, review round 3 (r3-correctness-1): a bare JSON integer is still read as a db id for node and text properties
promoted_to: ["REVIEW.md", "CLAUDE.md Gotchas"]
---

## Symptom

`set_block_property`, `batch_set_block_property`, `insert_block_tree` and `batch_insert_block_trees` set a property with choices to a title such as "active" and returned success. The UI and `get_block` showed "active", but the stored value was another property's choice, so queries and filters on the target property missed it. A title only one property used ("prospect") worked, and so did a choice UUID. A plain block's title was also accepted as a "choice".

## Cause

- `resolve-ref-entity` in upstream `deps/db-sync/.../handler/semantic.cljs` resolves a string with `(d/datoms db :avet :block/title value)` over the whole graph and takes `first`. AVET sorts equal titles by entity id, so the oldest entity with that title wins. The only filter was for `:block/tags`. `resolve-property-choice` (task status and priority) had the same first-match-then-check-owner shape, so a shared status title returned "invalid task status".
- The outliner does not catch it. `get-property-value-schema` calls `validate-property-value` without `:closed-values-validate?`, and `*closed-values-validate?*` defaults to false ("we can't ensure this when merging updates from server"). Only the full-db validator binds it. The remaining type check ("a block with a title") passes for any choice or plain block.
- `GET` returns only the value's uuid and title, so the read hid the wrong owner.
- The same class came back inside the fix. The new `title-candidates` ranking applied "pages first" before the property's `:logseq.property/classes`, so an untagged page beat the tagged object the property is limited to (r3-correctness-1). Its new ambiguity check counted the property's own value blocks as rivals, but the outliner creates a fresh value block per holder for `:default` and `:url` properties, so a URL already set on two blocks could no longer be set on a third (r3-integrity-1).

## Fix

Patch 0021 (`patches/0021-semantic-choice-values-scoped-to-property.patch`): for a property with choices, every input form (UUID, db id, ident, title, case-insensitive) resolves only among `:block/_closed-value-property` of that property, scoped to the block's tags, and anything else is refused with an error that names the property, the entry and the valid choices. `resolve-property-choice` looks inside the property first. Node properties skip other properties' choices and value blocks and refuse a title several pages share. `get_graph_health` flags values whose choice belongs to another property. Two review findings were still open when the lane ended (class order and URL value blocks); see the lane's PR.

## How to catch it next time

- For any title lookup, ask what the allowed set is (the property's choices, its classes, its own value blocks, pages) and resolve inside that set first. Never take `first` of a graph-wide title match.
- Test with a decoy: two properties (or a page and a block, or a tagged and an untagged object) sharing a title, with the decoy created first so it has the lower entity id.
- For each new preference or ambiguity rule, list the inputs that are legitimately duplicated (value blocks per holder, URLs, journal titles) and test one.
- Don't rely on the outliner to validate a server write against closed values or classes: it doesn't.
