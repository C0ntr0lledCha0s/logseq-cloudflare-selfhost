---
title: A pre-write read for an audit log must resolve, check and fail exactly as the write does
area: connector
tags: [audit-log, snapshot, pre-read, dry-run, resolver, refusal, get_activity_log]
seen:
  - 2026-11-07 – item 28, patch 0033, review rounds 2 and 3 (r2-correctness-1, r2-correctness-2, r3-integrity-1)
promoted_to: []
---

## Symptom

Three review findings, one shape. `update_tag` by qualified ident logged only an error and then went ahead, because the snapshot read (`getTag`) took a UUID only. A delete's dry run answered ok for a delete the real call then refused (too large, or a block the read hides), because the dry run skipped the snapshot read. A delete refused after its read lost the pages that read had returned, so the page filter of `get_activity_log` never found it.

## Cause

The connector took the before-snapshot with its own read, written separately from the write's handler. Each difference between the two paths is a place where the log and the write disagree: which selectors resolve (UUID, ident, title, date), which cases refuse, and what is kept when one refuses. Failing the read was also treated as "log the error and carry on" in one path, which let an unsnapshotted write through.

## Fix

Patch 0033 makes `tags-get` resolve what `find-tag` resolves (UUID or qualified ident) and still answer 404 for hidden tags, a property's ident, a title or an unknown ident. Delete dry runs make the same read and checks as the real call and keep no snapshot. `takeSnapshot` throws a `SnapshotRefusal` carrying the pages the read learnt, and `audited()` stores them.

## How to catch it next time

- For each write tool, list every selector the write accepts and run the snapshot read with each one. A new selector form in the write needs the same in the pre-read.
- A dry run must take every read and make every refusal the real call does. Test: for each refusal the real call has, the dry run refuses too.
- A refusal after a read must keep what the read learnt, and a test finds the refused entry through each filter.
- If the pre-read can fail, the write is refused, never sent with only the error stored (acceptance 4: no silent unlogged write).
