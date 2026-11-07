# Spike: diffable graph history (item 30)

Date: 2026-11-07. Issue: item 30, *Diffable graph history: what changed between days* (Low, enhancement and ops). Builds on items 28 (audit log) and 29 (Claude edit stamps), both In Review on this branch.

## Questions

1. What does item 30 still add once items 28 and 29 exist?
2. Option A: can the daily backups be diffed per page outside the Worker, and how would one page be restored?
3. Option B: can the sync server's `tx_log` serve a change feed with history, and can it tell who made an edit?
4. Option C: what does doing nothing lose against the issue's acceptance criteria?
5. What does each option cost on the Free plan, and where would a `graph_diff` tool run?
6. How are private-tagged pages kept out, and where should readable history live?
7. Does Logseq's own page history cover DB graphs?
8. Build, don't build or revisit, and how does this relate to item 41 (EDN export and import)?

## Short answer

**Revisit.** Cost does not block this: a diff run in GitHub Actions, next to the existing backup, uses no Worker requests, no Worker CPU and no D1 rows, and a handful of R2 operations a day. What blocks it is that the daily snapshot is raw Datascript storage (`kvs` rows), so nothing in the repo can yet read a page out of it, and a single-page restore has no proven path. Both are unmeasured. The `tx_log` route (B) is the wrong base: it needs a new patch, its reads are unindexed scans on the shared Durable Object row budget, it is wiped by any snapshot import, and it cannot tell the app from another client either.

Build the small version below once two cheap checks pass (real snapshot size, and a page export that reads back), or sooner if the owner loses an app edit that items 28 and 29 could not show. If item 41 lands first, use its per-page EDN export as the input instead of writing a snapshot reader.

## Findings

### 1. What item 30 adds beyond 28 and 29

Item 28 logs only calls made through the connector. Its before-snapshots are cut-down `getBlocks`/`getPage` JSON, capped at 100 KB (`SNAPSHOT_MAX_BYTES` in `connector/src/audit/snapshot.ts`), purged after 90 days (`auditRetentionDays`), and undo is out of scope (`docs/superpowers/specs/2026-11-07-connector-write-audit-log-design.md`). Item 29 stamps Claude's writes only, and app edits leave the stamp in place (`docs/superpowers/specs/2026-11-07-claude-edit-stamps-editedby-design.md`, section 3.3).

Neither sees:

- the owner's own edits in the desktop or web app;
- edits from any other sync client;
- what a page looked like on a given day, as a source for restoring it.

Item 30 adds those three. For Claude's own edits it overlaps with 28.

### 2. Option A: diff the daily backups

- **What a backup is.** `backup.yml` runs at 14:00 UTC in GitHub Actions. `scripts/backup.sh` writes `daily/<date>/` in the backups bucket: `index.sql` (D1 export), `graphs/<n>.sqlite` per graph (from upstream's `download_graph_db.js`), `graphs/index.json`, `assets-deleted/` and `backup.log`. A 90-day lifecycle rule expires it (`infra/main.tf`).
- **The snapshot is not a page table.** `download_graph_db.js` says the file "contains only: kvs(addr, content, addresses)": transit-encoded Datascript storage nodes. Plain SQL comparison cannot list pages. A reader has to restore a Datascript db from them. Upstream has the code for that (`deps/db/src/logseq/db/common/sqlite_cli.cljs` `open-db!`, `deps/db/script/dump_datoms.cljs`, and `logseq.db.sqlite.export`'s `:page` export), but nobody has run it on one of these snapshots. **Unverified.**
- **A cheaper input (inferred, not built).** A CI step could instead export each page through the existing semantic read API (`listKnowledgeIndex` to page through, `getBlocks` up to 100 pages a call) and diff the text against yesterday's export. This needs no ClojureScript build in the backup job. `listKnowledgeIndex` already leaves out pages with an excluded tag (README, patch 0013).
- **Granularity is one day.** Edits within the same 14:00-to-14:00 window collapse, and an edit reverted the same day does not show. No author is recorded.
- **Restoring one page.** README section 7 says upstream cannot import a snapshot into a Durable Object, and a server import would wipe `tx_log` and force clients to re-download anyway. The workable route is to read the past page from the export or snapshot and write it back through the semantic write API (`insert_block_tree` and friends). Whether this keeps uuids, order keys and property value blocks is **unproven**.
- **Size.** The real snapshot size and compressed size of the owner's graph are **unknown**. The run logs print no sizes. Run times today are about 60 to 90 s.

### 3. Option B: change feed from `tx_log`

- **What it holds.** In each graph's Durable Object SQLite, `tx_log` has `t` (primary key), `tx` (transit of normalised datoms), `created_at`, `outliner_op` and `tx_id` (`.upstream/deps/db-sync/src/logseq/db_sync/storage.cljs`).
- **Retention.** The upstream source never prunes it. It is deleted only by `reset-import!` on a snapshot import (`sync.cljs`, `delete from tx_log`) and by admin reset. So it would cover 90 days, grows without bound, and loses all history on an import or reset. Patch 0014's feed answers 410 in that case. Its real size is **unknown**.
- **Old values.** `normalize-datom` keeps `:db/retract` with the old value, so an overwrite probably carries the old value. A deleted entity may appear only as `retractEntity`, without its text. **Inferred from code; no real row was decoded.** Either way the history is datoms, not page-shaped content, so it has to be replayed onto a snapshot to show a page.
- **Patch 0014 is not enough.** It lists changed block UUIDs and attributes since a `t`, with current content only. It is capped at 5000 txs and 20000 changes per call, and uses `count(*)` over `tx_log`, which scans rows (`docs/solutions/cost/d1-reads-from-indexer-scans.md`). Per-page history would need a new patch: a time-range read grouped by page, with before and after values, a bound that avoids `count(*)`, and a re-baseline after each import.
- **Authorship.** There is no client or user column. The sending socket is used only for broadcast (`sync.cljs`, `handle-tx-batch!`). Only patch 0034's stamps mark Claude's writes. The app cannot be told from another client without a new column and a patch, and no design exists for that.

### 4. Option C: do nothing

Against the acceptance criteria: (1) not met for app or other-client edits, only Claude's writes via `get_activity_log`; (2) not met, because the only restore is the whole graph, by re-uploading from a desktop client's local copy (README section 7); (3) met trivially; (4) met. Manual recovery today is inspecting `daily/<date>/graphs/<n>.sqlite`, copying Claude's overwritten content back from the audit before-snapshots, and the app's Recycle, which restores deleted pages and blocks for 30 days but not edited content (`deps/outliner/src/logseq/outliner/recycle.cljs`).

### 5. Free plan cost and where the diff runs

See *Cost* below. A `graph_diff(from, to, page?)` tool that opened two snapshots inside the Worker does not fit. The front Worker gets 10 ms CPU, the S3 check already measured p99 at 50 ms (`docs/spike-results.md`), and the reader is ClojureScript that only exists in upstream. The diff must run in CI. The Worker can at most stream a finished report from R2.

### 6. Privacy and where history lives

The daily snapshots already hold every page, private-tagged ones included, unfiltered, in a private bucket in the same Cloudflare account. A report written to `daily/<date>/diff/` adds no new store and inherits the 90-day expiry. A git repo would be a second copy of client-work content in GitHub with no expiry. This repository is public, so it would have to be a separate repo with its own token. R2 is the better home.

Two rules follow for acceptance 3. The diff must drop private-tagged pages and their blocks before it writes anything. Because the repository is public, its Actions logs are public too, so the step must print counts only, never titles or content. The tag the owner uses for "private" is not in the repo. If it is the same tag as the `listKnowledgeIndex` excluded tag, the export route gets the filter for free. **Unchecked.** On an E2EE graph, a snapshot diff would show only ciphertext, and the semantic API refuses E2EE graphs.

### 7. Logseq's own page history

**Not found.** Searches of `.upstream/src`, `deps` and `docs` for page, version or file history find only undo and redo (ADR 0013, `frontend/handler/history.cljs`), a graph-view "time travel" control (`graph.cljs`), the file-graph importer's `version-files`, and the 30-day Recycle. The desktop app was not checked, so this is absence from code, not a confirmed negative.

## Comparison

| | A: diff daily backups (in CI) | B: `tx_log` change feed | C: nothing |
|---|---|---|---|
| Granularity | One day | Every transaction | None |
| Owner's app edits | Yes, not attributed | Yes, not attributed | No |
| Other clients | Yes, not attributed | Yes, not told from the app | No |
| Page restore from a past day | Through the write API; unproven | Replay onto a snapshot, then the write API; unproven | Whole graph only |
| Survives a snapshot import | Yes | No, history wiped | n/a |
| Private pages kept out | Filter in the diff step (or the excluded tag via the API) | New filter in a patch | Trivially |
| Effort | One CI step and a reader or export script | New upstream patch, a store, re-baselining | None |
| D1 rows / day | 0 | 0 in D1, unless history is stored there | 0 |
| DO rows read | 0 for a snapshot diff; bounded by graph size for the API export | Scales with all txs in the window, plus `count(*)` | 0 |
| Worker requests / CPU | 0 (snapshot) or about 60 to 100 requests (API export) | 1 or more per query, on the 10 ms front Worker | 0 |
| R2 | About 2 to 5 reads and 1 to 5 writes a day | None | None |

## Cost

All figures are per day for the one graph the latest backup reported (`graphs=1/1`). Free-tier R2 figures (10 GB-month, 1M Class A and 10M Class B a month) come from memory and third-party pages. developers.cloudflare.com was not reachable from this session, so they are **unverified**.

- **A, snapshot diff.** 0 Worker requests, 0 Worker CPU, 0 D1 rows, 0 DO requests beyond today's backup. R2: 1 GET for yesterday's snapshot (Class B) and 1 to 2 PUTs for the report (Class A). That is about 150 operations a month, well under 1% of the free tier. The report itself is KB to a few MB. Actions minutes are free because the repository is public. The extra run time is **unmeasured**.
- **A, API export.** If the graph has about 3,000 pages (the synthetic test size in patch 0013, not the owner's real count): about 30 `getBlocks` calls and about 30 index pages. That is 60 to 100 Worker requests, about 0.1% of the 100k cap, with 0 D1 rows. R2: one PUT per changed page plus a manifest. The semantic read rate limit was not read.
- **Storage, the real variable.** 10 GB over 90 days is about 111 MB a day for snapshot, `index.sql` and deleted assets together. Today's backups already use that budget, with or without item 30. The real size is **unknown**.
- **B.** Each 90-day per-page query reads every tx row in the window, plus the same again for `count(*)`. As an illustration only, at 2,000 txs a day that is about 360k DO rows a query, so about 14 queries would use the 5M daily cap. The real tx rate is **unknown**. Any history kept in D1 would cost 1 write per page change.
- **C.** 0.
- **Gap for acceptance 4.** `scripts/usage-report.mjs` has no R2 lines, so it cannot check R2 storage or operations today.

## Risks

- **Snapshot format churn.** The `kvs` format and the nbb and CLI scripts are internal upstream code. An upstream bump could break a reader without any error, so a test must pin it to `UPSTREAM_REF`.
- **Restore that looks right but isn't.** A page written back through the API may get new uuids or order keys, or lose property value blocks. That would break references to it, and nothing would report a failure. CLAUDE.md's "no silent success" rule applies.
- **Leaks through logs.** The repository is public, so its Actions logs are public. A diff step that prints titles would publish client work.
- **Re-import noise.** After a snapshot re-import or reset, every page looks changed, and B's history is gone.
- **R2 storage.** If the snapshot is larger than about 111 MB, the backups already exceed the free storage, whatever item 30 does.
- **E2EE graphs.** Both A and B would see only ciphertext.

## What would change the answer

- **Build now:** the owner loses an app edit that items 28 and 29 could not show; or a page export through the API is shown to read back and restore one page with its uuids.
- **Build on item 41:** item 41's scheduled per-page EDN export lands. That export is readable, page-shaped and importable, which makes it a better input than raw `kvs`.
- **Don't build:** the owner confirms that the desktop client keeps a usable page history for DB graphs.
- **Reconsider B:** upstream adds a client or author column to `tx_log`, or prunes it.

Smallest useful version, once built: a step in `backup.yml` that cannot fail the backup itself. It exports each page through the semantic API, without private-tagged pages. It diffs the export against yesterday's copy from R2 and writes `daily/<date>/diff/changes.json` and the changed pages back to R2. It logs counts only. It is tested on two real days.

Acceptance for that version: (1) met, at one-day granularity; (2) met by a script, or a Claude prompt, that writes a stored page back through the API, with uuids checked on read-back; (3) met by the filter, plus a test that a private-tagged page never reaches R2 or the log; (4) met if the R2 lines are added to the usage report.

Estimated cost: under 100 Worker requests, 0 D1 rows, under 10 R2 operations and a few MB of R2 a day.

## Follow-ups

1. **Measure the snapshot.** Run `rclone size` on `daily/` and on one `graphs/<n>.sqlite`, compressed and uncompressed, and record how many days fit 10 GB. (Ops, small.)
2. **Add R2 to the usage report.** Add R2 storage and Class A and B operations to `scripts/usage-report.mjs`, so acceptance 4 can be checked. (Small, worth doing regardless.)
3. **Check the private tag.** Confirm that the issue's private tag is the excluded tag `listKnowledgeIndex` leaves out, or say what predicate a diff would need. (Small.)
4. **Test a page round trip.** Export one page through `getBlocks`, write it to a scratch page through the write API, and compare uuids, order and property values. (Spike-sized; it gates the restore criterion.)
5. **Settle the order with item 41.** Decide whether item 30 waits for item 41's scheduled EDN export and reuses it. Record the decision on both items.
6. **Confirm the app has no page history.** The owner checks in the desktop app whether DB graphs show any page history. (Owner, a few minutes.)
7. **Record the durable facts.** Add a `docs/solutions` entry for the facts this spike settled: a snapshot is `kvs` only, `tx_log` is never pruned and is wiped on import, and `tx_log` has no author column.
