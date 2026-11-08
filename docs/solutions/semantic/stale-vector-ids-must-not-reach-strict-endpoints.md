---
title: Candidates read from Vectorize can outlive their D1 row; filter to rows that exist before sending ids to an endpoint that validates them
area: semantic
tags: [vectorize, deleted-row, signals, stale-id, ids-list, mutation-test]
seen:
  - 2026-11-08 – semantic-search recency and importance ranking, round 1 (r1-tests-1)
promoted_to: []
---

## Symptom

Nothing failed in the suite. A block deleted since it was indexed still has a vector until Vectorize catches up. Sending its vector id to `getBlocks view=signals` answers 400 `ids must be a comma-separated list of UUIDs`, so every memory-mode or `updated_after` search would fail with `ranking signals: ...` until the vector went.

## Cause

The semantic candidates are vector ids mapped to block uuids through `blocksFor`. A vector with no row maps to nothing. Code that fell back to the vector id (`uuid ?? m.id`) passed the filter and nothing tested a deleted row in the new modes.

## Fix

The signals candidates are only vectors that still have a stored row (`uuid ?? []`). The test indexes a block, deletes its row, runs memory mode and `updated_after`, and asserts no tool error, empty results, and that every id sent to the signals view is a UUID. Under the mutation both cases fail.

## How to catch it next time

For any new call that takes ids from the vector leg, ask what a vector with no row does, and mutate the filter in a scratch copy. The server's own `missing` list covers deleted blocks only after the uuid is valid.
