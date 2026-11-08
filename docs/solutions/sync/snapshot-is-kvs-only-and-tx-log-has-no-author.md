---
title: A backup snapshot is raw Datascript storage, and tx_log is never pruned, is wiped on import and has no author
area: sync
tags: [backup, snapshot, kvs, tx_log, history, retention, authorship, restore, r2, spike]
seen:
  - 2026-11-07 – item 30 spike, docs/spikes/2026-11-07-diffable-graph-history.md
promoted_to: []
---

## Symptom

Someone proposes "diff yesterday's backup against today's" or "a per-page change history from the sync log", and assumes the SQLite snapshot has page tables, that `tx_log` is short-lived or compacted, or that it records who made an edit.

## Cause

Read from the code at `UPSTREAM_REF` (nothing here was run against a real graph):

- The file `download_graph_db.js` writes holds only `kvs(addr, content, addresses)`: transit-encoded Datascript storage nodes. There is no page or block table, so SQL cannot list pages. A reader has to restore a Datascript db (upstream's `sqlite_cli.cljs` `open-db!`, `dump_datoms.cljs`).
- `tx_log` (`t`, `tx`, `created_at`, `outliner_op`, `tx_id`) is never pruned. Only `reset-import!` on a snapshot import and an admin reset delete it, so any import wipes all history and patch 0014's feed answers 410. It grows without bound.
- `tx_log` has no client or user column. The sending socket is used only for broadcast. Only patch 0034's stamps mark Claude's writes, so the app and other clients cannot be told apart.
- `normalize-datom` keeps `:db/retract` with the old value, so overwrites probably carry it, but a deleted entity may appear only as `retractEntity`. Inferred; no real row was decoded.
- Not settled: the owner's real snapshot size, `tx_log` size and tx rate, and whether the desktop app keeps page history for DB graphs (not found in `.upstream`). The Free plan R2 figures were from memory, as developers.cloudflare.com was unreachable.

## Fix

None needed; this is a recorded finding. The spike recommends "revisit". A diff of the backups would run in GitHub Actions after `backup.sh` (no Worker CPU, requests or D1 rows). The Worker's 10 ms CPU rules out reading snapshots there. Readable history belongs in R2 under `daily/<date>/`, not a git repo, because the repository is public and its Actions logs would expose titles.

## How to catch it next time

- Before designing history, restore, or a diff over backups, read this entry and the spike, then measure first: `rclone size` on `daily/` and on one snapshot, and the `tx_log` row count.
- Any step that runs in the public repo's Actions must log counts only, never page titles or content.
- Per-page restore needs a round-trip test through the semantic write API that checks uuids, order keys and property value blocks on read-back.
