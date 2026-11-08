---
title: A bearer check should cost one indexed row read and nothing for a bearer that is not ours
area: cost
tags: [d1, auth, service-token, rows-read, throttle, free-plan]
seen:
  - 2026-11-07 – service-token-cloud-sessions (design panel and spec section 5)
promoted_to: []
---

## Symptom

A new credential checked on every `/mcp` request could add D1 reads per call and a write per call for `last_used`, on a plan capped at 5M rows read and 100k rows written a day.

## Cause

The cost is decided by statement shape, not by intent. The three design candidates (hash index, primary-key id lookup, a per-request access object) all came to about one row read per request, so the judges' disagreement was about fit and risk, not Free-plan cost.

## Fix

- Check the token's shape first. A malformed or OAuth-looking bearer returns the generic 401 without touching D1 (0 rows).
- Look up by the unique index on `token_hash` (migration 0006): 1 row read, and the verify read returns `last_used_at`.
- Throttle `last_used_at`: write only when it is null or over an hour old, with a conditional `UPDATE ... AND (last_used_at IS NULL OR last_used_at < ?)` inside `ctx.waitUntil`, so racing isolates write once. At most one write per token per hour.
- Use OR chains in CHECKs, not `IN` lists (see `d1-statement-shapes-read-more-than-they-return.md`).
- Arithmetic worth keeping: 2,000 cloud-session requests a day on one token is about 2,000 rows read and 24 rows written. Creating a token writes 4 rows (plus a 1-row read-back); revoking reads 1 and writes 1.

## How to catch it next time

Pin the cost in a test with `meta.rows_read` and `meta.rows_written` (verify reads 1 and writes 0; create writes 4; a repeat inside the hour writes 0), and have a malformed bearer assert 0 reads.
