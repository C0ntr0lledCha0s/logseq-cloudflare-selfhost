---
title: A confirm step must apply exactly what it showed, and the change and its audit row must commit together
area: connector
tags: [confirm-page, expiry, relative-days, audit-log, atomicity, batch, service-token, contract]
seen:
  - 2026-11-08 – edit-service-token-scope (should-fix items, deferred)
promoted_to: []
---

## Symptom

- The widening confirm page showed one shortened expiry, but the confirm re-post applied a later one.
- A double-submitted or retried expiry edit applied, then answered 400 "would extend the expiry".
- An edit that was applied could have no `audit_log` row.

## Cause

- The form carries "days from now". The confirm re-post recounts days from the time of the re-post, so the shown date and the applied date differ by the owner's think time. A retry recounts again and can land after the stored date.
- The UPDATE and the audit INSERT are separate statements, so a failure between them leaves a change with no history.

## Fix

Not applied in the lane (deferred). Remedy: carry the computed absolute `expires_at` as a hidden field on the confirm page and apply that value; treat a re-send that already matches the stored value as a no-op redirect; send the UPDATE and the audit INSERT in one `db.batch` (or write the audit row first and refuse when it fails). The same "writes one rule four times" smell (the added-graph rule inline, in `isWidening`, in the confirm page and in `recordTokenEdit`) wants one helper that returns the diff.

## How to catch it next time

Ask of every two-step flow: is the confirmed value the displayed value, byte for byte? Test a re-post after the clock moved. For every write plus audit, ask what is stored if the second statement fails.

Cost worth keeping (measured in the lane's design): an applied edit reads about 3 + N rows (N graphs checked) and writes 3 (token row 1, audit insert 2, because a NULL `graph_id` row still writes its `(graph_id, at)` index entry); a guard miss reads 1 and writes 0; migration 0007's `ALTER` reads 22 schema rows and writes 1 once.
