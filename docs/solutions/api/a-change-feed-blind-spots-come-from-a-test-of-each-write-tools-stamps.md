---
title: A change feed built on `:block/updated-at` misses what the stamp misses; record each write tool's stamps in a test and build the tool text from it
area: api
tags: [changes, list_changes_since, updated-at, move, property-set, stamps, late-sync, feed, broken-refs, code-blocks]
seen:
  - 2026-11-23 – item 50, patches 0051 and 0052 (spec section 2 repro, review round 2)
promoted_to: []
---

## Symptom

The owner wanted "what changed since" for a digest. `:block/updated-at` looked like the answer, but it is not a complete signal: a move bumps only the pages, and a property set bumps only the block.

## Cause

Each write path stamps a different set of entities, and the sync layer keeps whatever stamp the editing device wrote. Consequences found while building the feed:

- A feed over blocks alone misses moves. A feed over pages alone misses property sets (tags, heading). Report both, and say a move is `page-changed` with no block entry. The owner accepted that, so no tx-log reading was needed.
- `:block/updated-at` is set by the editing device, so an offline edit can arrive after the caller's last `until` with an older stamp. A caller that resumes at the last `until` loses it.
- `delete_block_property` shows only as a page change, and a favourite write (hidden favourites page) is invisible.

A second, smaller trap came with `broken-refs`: a `[[uuid]]` or `((uuid))` quoted inside a code or math block or an inline code span is not a link, and the scan listed it as a missing ref until review round 2 (r2-integrity-1). `db-content/id-ref-pattern` also covers only a lower-case `[[uuid]]`, so the pattern is built from `common-util/uuid-pattern` with both forms, case-insensitive.

## Fix

Patch 0052 reports pages and blocks and a `page-changed` flag. A test records which stamp (block, page, listed) each connector write tool bumps, and the tool text's list of blind spots and the late-sync advice (start at the last `until` less a margin, skip blocks already seen with the same `uuid` and `updated-at`) are built from that test. Patch 0051 skips code text in the ref scan, with tests for quote blocks, text after a closed span and text after an unclosed backtick, which are still scanned.

## How to catch it next time

- Before building a feed on a timestamp, write the repro that shows which write tools move it. Keep that table as a test, so a new write tool that stamps differently fails it.
- Any scanner for links in titles must say what is not a link (code, math, spans) and test each form.
- Tool text that lists blind spots should come from a test, as count claims should (`connector/count-claims-in-tool-text-must-come-from-the-implementation.md`).
