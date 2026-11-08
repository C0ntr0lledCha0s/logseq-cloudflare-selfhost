---
title: update_block adds refs from the new title but never retracts the old ones, so a title that drops a link keeps its backlink
area: api
tags: [update_block, block-refs, backlinks, save-block, stale-refs, refresh_refs, false-positive-check]
seen:
  - 2026-11-08 – item 31, patch 0037, review round 2 (r2-correctness-1, refuted as pre-existing)
promoted_to: []
---

## Symptom

A block `see [[Example]]` updated to `plain text` still appears in `get_page_backlinks` for Example. A review finding claimed this was new in patch 0037 for code and math titles (a verbatim title adds no refs, so the old ones stay). A skeptic showed the same on the base.

## Cause

The handler builds `:block/refs` from the new title's links only and passes it to `outliner-core/save-block!`. `-save` retracts only `:block/warning`, and `remove-orphaned-refs-when-save` cleans orphaned pages, not the block's own ref datoms. The app avoids this because `wrap-parse-block` always sends a fresh `:block/refs` computed from the parsed content. Nothing on the server rebuilds refs after a save.

## Fix

None yet; it is a backlog item for `update_block` as a whole (retract content refs and keep tags and property-value refs, for example through `outliner-core/rebuild-block-refs`). Patch 0037's `update-code-block-include-test` asserts "refs unchanged" on purpose.

## How to catch it next time

- Before accepting "this change made X stale", run the same input with a plain-text control block on the base path. The probe that refuted this finding used three blocks, two converted and one plain, and all three kept the old ref.
- Any new title path in a handler should say what it does to `:block/refs`, because the outliner will not do it.
- If this is raised again as a new defect of a verbatim path, treat it as the same pre-existing item; a second refutation makes it a Known false positive.
