---
title: A readable summary that repeats every item pushes a 100-block write past the result cap
area: connector
tags: [result-cap, summary, batch, verbose, tokens]
seen:
  - 2026-11-07 – item 17, patch 0028, review round 3 (r3-light-1)
  - 2026-11-07 – item 28, review rounds 1 and 2: a stored snapshot cap of 256 KB could not be read back whole under the 150,000-character result limit, and `get_activity_log` with `include_snapshot` fetched and re-serialised every snapshot on a page of which one result holds about one
promoted_to: ["REVIEW.md"]
---

## Symptom

A 100-block batch_move_blocks result listed every block in both the readable summary and the indented JSON. It passed the 150,000-character cap and was cut by the read path's "request less" notice, which implies the write failed when it had been applied.

## Cause

Readable text was added beside the JSON, so each item cost twice, and the cap logic only knew how to cut the whole body.

## Fix

The summary lists at most 20 blocks a section ("... and 80 more, listed in the JSON result") and cuts page titles to 80 code points. `capWriteResult` drops JSON indentation first, then cuts the summary and keeps the JSON whole. If the JSON alone is over, it is cut with a notice that the write was applied.

## How to catch it next time

Any tool that adds human-readable text to a bulk result needs a test at the batch limit (100 entries) with long titles, and the cap notice for a write must say the write happened.

Second sighting (item 28): anything stored for later read-back needs a size cap below the result limit (the audit snapshot cap is 100 KB), and a listing that includes stored blobs stops before the budget and resumes by cursor. Pick the cap from the result limit, not from storage.
