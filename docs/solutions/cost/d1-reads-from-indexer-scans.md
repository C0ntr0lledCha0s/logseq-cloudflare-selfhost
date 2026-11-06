---
title: Cron jobs that scan tables or never finish burn the Free plan's D1 reads
area: cost
tags: [d1, rows-read, cron, count, cursor, pagination, free-plan, indexer]
seen:
  - 2026-11-05 – item 18, PRs #27 and #31 (semantic indexer)
promoted_to: ["CLAUDE.md Conventions", "REVIEW.md"]
---

## Symptom

After semantic search went live, the indexer failed every minute and read about 5,000 D1 rows a run. That projects to about 7M a day, over the Free plan's 5M. Nothing alerted, and it was found by hand. Going over would have stopped sign-ins and graph tokens, which live in the same database.

## Cause

- The block feed's last page has a null next-cursor, and the indexer treated that as "not done", so the build never finished and re-ran.
- Finding disconnected graphs read every block row.
- `count(*)` in the cap check, `semantic_search` and `semantic_index_status` scanned every row (D1 bills rows scanned).

## Fix

- PR #27 reads the last page and finds graphs through `semantic_state`, which reads 2 rows.
- PR #31 adds per-graph block counts kept by triggers (migration 0003). An idle run now reads about 10 rows.
- PR #28 added `scripts/usage-report.mjs` and the `usage` workflow, which alerts at 70% or on a projected overrun.

## How to catch it next time

For every query a change adds to a request path or cron, write down the rows read per call and the calls per day, and multiply. Pagination loops need a test for the last page.
