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

Applied in the review-fix commit after the lane (findings r1-integrity-1, r1-integrity-2, r1-light-1, r2-correctness-1). The confirm page carries the shown expiry as an absolute `expires_at` and the confirm stores that value. The edit page carries `opened_at`, and a day count counts from it, so a re-sent form asks for the same expiry; a form asking for what is already stored redirects with no write. The guarded UPDATE and the audit INSERT go in one `db.batch`, the INSERT as `INSERT … SELECT … WHERE EXISTS` on the token row holding the new values and `updated_at`, so a guard miss inserts nothing and a failed INSERT rolls the UPDATE back (a test renames the audit table in the INSERT and checks the token is unchanged and the answer is 500). The four copies of the widening rule were left as they are (r2-light-2, skipped).

## How to catch it next time

Ask of every two-step flow: is the confirmed value the displayed value, byte for byte? Test a re-post after the clock moved. For every write plus audit, ask what is stored if the second statement fails.

Cost worth keeping (measured): an applied edit reads 4 + N rows since the fix (3 + N before it, plus the EXISTS check's 1 read) (N graphs checked) and writes 3 (token row 1, audit insert 2, because a NULL `graph_id` row still writes its `(graph_id, at)` index entry); a guard miss reads 1 and writes 0; migration 0007's `ALTER` reads 22 schema rows and writes 1 once.
