---
title: A guard that sets an invariant on a block must be checked against every other path that can break it, including delete and type changes
area: api
tags: [query-block, invariant, display-type, lang, update-block, delete-block, property-paths, marker, guard-bypass, should-fix]
seen:
  - 2026-11-22 – item 49, patch 0050 (query blocks), review rounds 1 and 2 (r1-correctness-1, and about a dozen should-fix lines naming the same hole in different words)
promoted_to: []
---

## Symptom

Patch 0050 stores a Query block only when its value block is an advanced query as Clojure code (`logseq.property/query`, no `display-type`, no `lang`). The insert path and the property paths refused anything else. Review still found ways to leave that state without tripping a guard:

- `update_block` with a fence, a `display-type` or `set_block_property` turned a Claude-made Query block into a code, math or quote block that kept its Query tag.
- Changing the value block's `lang` or `display-type` made later `update_block` calls answer 500 for good.
- `delete_block` on the value block removed the query, which `delete_block_property` already refused to remove.

## Cause

The guards were written per input path (insert, set, batch set, delete property), each asking "may this call write the query?". The rule is about the stored state: "a Query block's value block stays plain Clojure code". Every other writer of that state (update_block's title step, the display-type property, delete of the hidden child) is a separate route into it. The same shape as `docs/solutions/api/new-selector-form-needs-every-lookup-site.md`, but for a stored invariant instead of an input form.

## Fix

Patch 0050 closes the property paths and the delete-property paths, and guards `update_block` with the marker. The remaining routes were logged as should-fix for the owner (they need a decision on whether `delete_block` of a value block should refuse, and whether the owner's own Query blocks are in scope).

## How to catch it next time

- Write the invariant as one sentence about stored state, then list every tool that can change the block, its hidden children and its tags. For each, ask whether it can break the sentence.
- Test the invariant by reading the block back after each route, not only that the guarded route refuses.
- When a stage adds a guard, search the review's open list for "same hole, other route" before adding a new finding. Twelve should-fix lines in this lane were three holes.
