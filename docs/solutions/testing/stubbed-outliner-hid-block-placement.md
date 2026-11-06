---
title: Tests that stub the outliner or read raw datoms can't see where blocks really land
area: testing
tags: [stub, outliner, move, placement, datoms, property-values, regression-test]
seen:
  - 2026-11-04 – item 14, PR #20 (move_blocks before/after nested the block inside the target)
  - 2026-11-04 – item 15, PR #21 (list_page_blocks listed property value blocks as top-level blocks)
promoted_to: ["CLAUDE.md Conventions", "REVIEW.md"]
---

## Symptom

`move_blocks` with `after` made the moved block the target's first child, and `before` did the same. In a separate bug, `list_page_blocks` showed a page's Description value as a body block. The existing tests passed in both cases.

## Cause

- **Move.** Upstream mapped before/after to the outliner's `:top?`/`:bottom?` options, which address the target's children. The test stubbed the outliner, so it only checked which options were passed, never where the block ended up.
- **Listing.** The page's top level was read from datoms, which include value blocks created from a property. The outline and the children listing use `:block/_parent`, which leaves them out.

## Fix

Patch 0009 (before/after become siblings, and before/after on a page is refused) and patch 0010 (skip blocks with `logseq.property/created-from-property`). Both tests now run the real handler and read the result back.

## How to catch it next time

- A test for a write asserts the stored state (parent, order, siblings) through a real read, not the arguments passed to a collaborator.
- When two reads of the same thing exist (outline, children, page listing), check that they agree.
