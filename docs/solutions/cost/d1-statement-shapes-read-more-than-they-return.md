---
title: Measure D1 rows read per statement shape; windows, IN subqueries and a second bound on the index read far more than they return
area: cost
tags: [d1, rows-read, meta, window-function, delete, subquery, index, purge, audit-log]
seen:
  - 2026-11-07 – item 28, audit log read and purge statements
promoted_to: []
---

## Symptom

On paper each audit-log statement looked bounded. Run in the connector's vitest pool (real D1), several read many times more rows than the 500 they returned:

- `DELETE … WHERE id IN (SELECT id … ORDER BY id LIMIT 500)` read the whole table (3,002 rows) when nothing was old, and 2,000 rows to delete 500.
- A window function (`row_number`, `count(*) OVER ()`) read 1,501 to 3,002 rows for a 500-row scan; a materialised CTE 1,500.
- `at >= ? AND at < ?` plus a cursor made the planner bound the index range by the upper limit and read 2,500 rows for a 500-row page. A single `at <= ?` bound read 500.
- `IN (…)` and `json_each` cost two rows per id, and a batch of per-entry lookups spends one of the invocation's 50 D1 queries each. Compound `UNION ALL` of more than a few terms is refused.

## Cause

D1 bills rows scanned, not rows returned, and the planner's choice depends on the statement's shape. Reasoning from the SQL does not predict it.

## Fix

Probe the oldest row first, then `DELETE … WHERE id < ? AND at < ?` bound to the probed id plus 500 (at most 502 rows read). Use an aggregate scan with one upper bound on `at`. A test reads `meta.rows_read` and `meta.rows_written` from the real statements and pins them; the full-table read is the mutant it kills.

## How to catch it next time

Any new D1 statement gets a throwaway test on a table of realistic size (a few thousand rows, one index) that prints `meta.rows_read`, before it is chosen. Pin the number in the real test. Deletes: D1 counts one row written per row deleted, not per index entry. A table that grows each day needs a purge that costs one row read when nothing is old.
