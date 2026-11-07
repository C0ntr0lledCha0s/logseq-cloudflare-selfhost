# Connector write audit log with before-snapshots and `get_activity_log`: design

Date: 2026-11-07
Issue: Connector #28 (write audit log of connector writes, with before-snapshots and `get_activity_log`). Labels: enhancement, safety, observability.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0032 applied. This work adds no patch.
Branch: stacked on Phase 3 (`claude/relaxed-maxwell-s4r8o4-phase3`), after item 17 (patch 0028 and `connector/src/tools/readable.ts`), which is not merged yet.

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. Ideas taken from the design panel's other proposals are marked **(graft)**. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Give the owner one place to answer "what did Claude change?", with readable targets, and a way to see what an update, move or delete overwrote. Logseq can't tell which edits came from Claude, and claude.ai tool cards are spread across chats and show mostly UUIDs.

1. The connector logs every write, move and delete call to an owner-only D1 table, with the time, tool, graph, client, session, the `reason` argument (item 17), and the affected pages and blocks by UUID, page title, breadcrumb and snippet.
2. Before an update, move, property change or delete, the connector stores a before-snapshot: the previous title, properties, parent and order, and the whole subtree for a block delete.
3. A read-only `get_activity_log` tool reads the log back, filtered by time range, page, tool, session and status, with an option to include the before-snapshot.
4. Entries are kept 90 days, like backups, and the usage report covers the log's reads, writes and storage.

Acceptance (issue and brief):

1. Every write, move and delete call produces one log entry, including failed calls and dry runs (marked as such).
2. A deleted block's whole subtree can be read back from the log.
3. `get_activity_log` answers "what did Claude change this week" in one call, with page titles and snippets, not just UUIDs.
4. If logging fails, the write is refused or the failure is reported; writes are never silently unlogged.
5. The usage report covers the log's D1 reads, writes and storage.
6. (Brief) Item 17's readable-write-context helper is reused, not rebuilt.
7. (Brief) D1 rows written per tool call and rows read per audit query are counted and within the Free plan budget; retention is bounded (90 days).
8. (Brief) No secrets or tokens are ever stored in the log.

## 2. Context

**One choke point for writes.** `registerGraphTools` (`connector/src/tools/semantic.ts:192`) runs every generated tool through `runTool`; for a non-read tool it calls `takeReason(args)`, the handler, `describeWrite(tool, result, reason)` and `onSuccess(tool, alias, {reason, targets})`, then `capWriteResult(withSummary(...))`. `registerAssetTools` (`connector/src/tools/assets.ts:264`) does the same for `save_document` and `save_file_from_url`. `onSuccess` in `mcpHandler` (`connector/src/mcp.ts`) already receives the reason and targets "for item 28's audit log" and ignores them today. `onSuccess` only runs after the sync server accepted a call, so failed and refused calls never reach it; the log needs to wrap the whole call, not hang off `onSuccess`.

**What item 17 gives us.** `readable.ts` exports `toAffectedTargets(response)` (typed `AffectedTarget` records: page uuid and title, breadcrumb, snippet, descendants, `from`/`to` for moves), `summarise`, `describeWrite`, and a guard table (`CONTEXT_TOOLS`, `NO_CONTEXT_TOOLS`, `contextClassFor`) that fails a test when a non-read tool has no entry. Patch 0028 builds delete context from the before-snapshot inside `atomic-write!`, so delete responses already name what was deleted, but only the addressed blocks, not their subtrees.

**Read endpoints the snapshot can use.** `getBlocks` (`GET /graphs/{graph-id}/blocks?ids=…&view=summary|outline`, up to 100 UUIDs) returns `BlockDetailResponse` for each: `uuid`, `kind`, `title`, `order`, `parent-id`, `page-id`, `tags` and `properties`, and lists unknown UUIDs under `missing`. With `view=outline`, each entry also carries `markdown`, `block-count` and `truncated` from `page-outline`, sharing one 2000-block budget across the response. I checked this in the patched tree rather than trusting the OpenAPI schema: `bulk-read-response` (`.upstream/deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs:3679`) merges `page-outline`'s `{:markdown :block-count :truncated}` into each block, and `page-outline` (`:405`) sets `truncated` as soon as the budget runs out with children left. The `BlocksResponse` schema in `openapi.json` doesn't list these three fields; the connector must read them anyway (risk 2). `view=outline` answers 409 on E2EE graphs (`:3945`). `getPageOutline`, `getPage`, `getTag` and `getProperty` cover pages, tags and properties.

**Grant props.** `ctx.props` is the decrypted `GrantProps` (`githubUserId`, `login`) only (`connector/src/auth/routes.ts:36`); workers-oauth-provider keeps the OAuth client id on the grant but doesn't expose it to the API handler. The stateless MCP handler from `agents` allows and exposes an `mcp-session-id` header but issues none itself.

**Cron.** `scheduled` in `connector/src/index.ts:76` already has an hourly `KB_INDEX_CRON` case. No new trigger is needed for retention.

**D1 cost of the statements this design uses.** Measured in the connector's vitest pool (real D1 in workerd) with a throwaway test, now deleted, on a table shaped like `audit_log` with one `(graph_id, at)` index and 3,001 recent rows:

```
insert written=2 read=0
update written=1 read=1
purge-as-proposed nothing-old written=0 read=3002
oldest-probe read=1
window-capped read=500 n=0
window-uncapped read=3001 n=1
```

So a pending INSERT costs 2 rows written, the outcome UPDATE by primary key 1 written and 1 read. Two of the panel's first ideas would have scanned: `DELETE … WHERE id IN (SELECT id … WHERE at < ? ORDER BY id LIMIT 500)` reads the whole table when nothing is old enough (3,002 rows, every hour), and a filtered window query reads every row in the window. Sections 3.6 and 3.5 use the probe and the capped inner query instead.

**Learnings that shape this design.**

- `docs/solutions/api/one-error-for-every-failure.md`: a refusal names its entry and reason; the log stores that message, not a generic one.
- `docs/solutions/cost/d1-reads-from-indexer-scans.md` and REVIEW.md *Cost*: count rows per request and per cron run, no scans, feeds end with a null cursor.
- `docs/superpowers/specs/2026-11-07-readable-tool-calls-reason-targets-design.md` §3.7: the reason stays out of Workers logs and goes to this owner-only log.
- `docs/superpowers/specs/2026-11-04-semantic-search-design.md`: the pattern for D1 state shared with sign-ins and graph tokens, and the hourly cron's budget.
- REVIEW.md *Destructive operations keep their guards*: the `acknowledge-*` flags and dry-runs stay as they are; the log adds to them.

## 3. Design

**Approach (call).** Everything lives in the connector. There is no patch, no R2, no new cron trigger and no digest; undo stays out of scope. The log is written ahead: a `pending` row goes in before the write, holding the before-snapshot, and is finished after it. A write whose pending row can't be stored is refused.

Rejected:

- **Server-side snapshot in a patch (0033).** Taking the snapshot from the pre-transaction db inside `atomic-write!` would be exact (no gap between snapshot and write) and restorable (UUIDs, order keys, hidden value blocks). It means an `audit` flag on every semantic write handler, stacked on unmerged 0028 to 0032, so `bump-upstream` conflicts are likely, and a write response that carries up to 1 MB of `before` for the connector to parse under the 10 ms CPU limit. It is the right path if the owner later wants `restore_from_log` (section 10).
- **Log after the write.** Two rows per write and no extra request, but a Worker crash or the D1 daily cap between the commit and the insert leaves an applied, unlogged write with nothing reported, which acceptance 4 forbids.
- **R2 for large snapshots.** Snapshots are capped at 100 KB (3.4), so D1 holds them all; a second store adds a binding, a second retention rule and a second failure mode.

### 3.1 Layout

| Path | Change |
|---|---|
| `connector/migrations/0004_audit_log.sql` | New `audit_log` table and one index (3.2). |
| `connector/src/audit/log.ts` (new) | `AuditLog` (`probe`, `begin`, `finish`, `query`, `get`, `purge`) over `env.DB`, and the `audited()` wrapper. |
| `connector/src/audit/snapshot.ts` (new) | `SNAPSHOT_PLAN` per tool, the pre-read through `graphFetch`, size cap and truncation refusal. |
| `connector/src/tools/semantic.ts` | `registerGraphTools` runs each non-read tool through `audited()`. `onSuccess` is unchanged. |
| `connector/src/tools/assets.ts` | `save_document` and `save_file_from_url` run through `audited()`. |
| `connector/src/tools/activity-log.ts` (new) | The `get_activity_log` tool. |
| `connector/src/tools/spec.mjs` | Annotations entry for `get_activity_log` (read-only, idempotent). |
| `connector/src/mcp.ts` | Builds one `AuditLog` per isolate; passes `client` and `session` from the request into the registrations. |
| `connector/src/index.ts` | Calls `purgeAuditLog` in the `KB_INDEX_CRON` case. |
| `connector/src/config.ts`, `config/settings.json` | `connector.auditRetentionDays` (default 90, bounded 1 to 365). |
| `connector/src/tools/handwritten.ts` | `connector_help` text. |
| `connector/tools-manifest.json` | Regenerated with `update:manifest`. |
| `scripts/usage-report.mjs`, `scripts/usage-report.test.mjs`, `.github/workflows/usage.yml` | Audit log section (3.7). |
| README §11.8 and the usage section | Contract and the usage token's new D1 Read permission. |

### 3.2 Schema

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,           -- grows with time; the purge relies on it
  at INTEGER NOT NULL,              -- ms since the epoch, set by the Worker at begin
  graph_id TEXT,                    -- null when the alias didn't resolve
  alias TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('write','read')),
  status TEXT NOT NULL CHECK(status IN ('pending','ok','error','refused')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  client TEXT,
  session TEXT,
  addressed TEXT,                   -- JSON array of the UUIDs or selectors the call named
  pages TEXT,                       -- lower-cased page titles and UUIDs, '\n'-joined, for the page filter
  targets TEXT,                     -- JSON AffectedTarget[] from item 17's describeWrite
  before TEXT,                      -- JSON {source, truncated?, e2ee?, error?, data}
  error TEXT,                       -- the ToolError message, which names the entry and reason
  rows_written INTEGER,             -- this entry's own D1 cost (3.7)
  rows_read INTEGER
);
CREATE INDEX audit_log_graph_at ON audit_log(graph_id, at);
```

`id` has no `AUTOINCREMENT`; SQLite gives `max(id) + 1`, and the purge only ever removes the oldest rows, so `id` order and `at` order agree (within clock skew between isolates, a few milliseconds).

**Nothing but these columns is stored (graft).** The row never holds the raw tool arguments: only `reason`, the addressed UUIDs or selectors, item 17's targets, the server's error text and the snapshot the server returned. Block text a write sends is not stored; what it overwrote is, in `before`. This keeps tokens and headers out by construction, rather than by pattern-matching redaction.

### 3.3 The write path: `audited()`

`audited(ctx, tool, alias, args, run)` wraps each write call. Read tools are not logged as writes.

1. **Probe once per isolate (graft).** The first write in an isolate runs `SELECT 1 FROM audit_log LIMIT 0` (0 rows read). If the table is missing, every write in that isolate is refused with `audit log unavailable: migration 0004 has not been applied; nothing was written`. A deploy that skipped the migration then refuses writes up front, with a message that says why, instead of failing on each INSERT.
2. **Validate** the alias and reason as today. A refused reason, an unknown alias or a read-only graph is still logged, with `status = 'refused'` and the refusal text (acceptance 1).
3. **Before-snapshot** (3.4), skipped for dry runs. A dry run is logged with `dry_run = 1`; its targets come from the server's dry-run response, which item 17 already makes readable.
4. **`begin`: INSERT the pending row** with the time, tool, graph id, alias, client, session, reason, `dry_run`, addressed UUIDs and `before`. If this INSERT throws, the write is refused with `audit log unavailable: <reason>; nothing was written`, and no request reaches the sync server (acceptance 4).
5. **Run the write** through the existing handler.
6. **`finish`: UPDATE the row by id** with the status (`ok`, `error` or `refused`), the error text, the targets from `describeWrite`/`toAffectedTargets`, and `pages` (each target's page title and UUID, lower-cased). This reuses item 17's helper rather than building a second one (acceptance 6). If the UPDATE fails, the write stands, and the result gains a leading line `Audit log entry <id> could not be completed: <reason>`. The pending row already holds the snapshot, so a delete's subtree is not lost.
7. **Result.** Each write's result gains one line, `Logged as audit entry <id>`, so Claude can cite it.

A row left `pending` because the Worker died between steps 4 and 6 is shown by `get_activity_log` as `outcome unknown`, never hidden. It is not reconciled automatically.

### 3.4 Snapshots

`SNAPSHOT_PLAN` in `snapshot.ts` maps each non-read tool to what to read before it writes. The pre-read uses the same `resolveGraph` and `graphFetch` path as the tools, so it carries the same graph token and goes to the same Worker.

| Tools | Pre-read | What it keeps |
|---|---|---|
| `update_block`, `set_block_property`, `delete_block_property`, `batch_set_block_property`, `batch_delete_block_property`, `move_blocks`, `batch_move_blocks` | one `getBlocks`, `ids` = the addressed UUIDs, `view=summary` | title, tags, properties, `parent-id`, `order`, `page-id` |
| `delete_block`, `delete_blocks` | one `getBlocks`, `view=outline` | the above plus each block's subtree as a markdown outline (acceptance 2) |
| `delete_page` | `getPageOutline` | the page, its properties and its whole outline |
| `update_page` | `getPage` | title, tags, properties |
| `update_tag`, `delete_tag`, `promote_page_to_tag` | `getTag` (or `getPage` before a promote) | title, properties, extends, tag properties |
| `update_property`, `delete_property` | `getProperty` | type, cardinality, choices, classes |
| `batch_insert_block_trees` | `getBlocks` for entries with a UUID `target-id` and properties, and `getPage` for each page an entry with properties names by title or date (`target-id` or `page`), since those replace existing values | as for property writes, and each page's title, tags and properties |
| `refresh_refs` | none | its response already lists each block's text before and after; that is stored as `before` |
| inserts, creates, `capture_to_today`, `create_task`, `save_document`, `save_file_from_url` | none | nothing is overwritten |

A guard test, like item 17's `contextClassFor`, fails when a non-read tool in `tools-manifest.json` has no `SNAPSHOT_PLAN` entry (graft from the panel's minimal design).

Rules:

- **Deletes that can't be snapshotted are refused (call).** A `delete_block` or `delete_blocks` whose outline comes back with `truncated: true` on any entry, or whose snapshot is over 100 KB, is refused before the delete is sent, naming the entry: `entry 3: <uuid> has more descendants than the 2,000-block snapshot budget; delete it in parts`. This keeps acceptance 2 true and follows the repo's "refuse up front" rule. Several blocks in one `delete_blocks` share the 2000-block budget, so a call may need splitting even when each block alone would fit. `delete_page` follows the same rule on `getPageOutline`'s `truncated`.
- **Non-delete snapshots over the cap** are stored cut down to the addressed blocks' summaries, with `truncated: true`.
- **Pre-read failures.** A block delete whose read doesn't return a block it names (listed under `missing`) is refused, naming the entry by its index in the call: `entry 1: <uuid> can't be read (hidden, in the Recycle bin or not found); nothing was deleted`. `getBlocks` hides a block under a deleted (Recycle bin) or hidden ancestor, but the delete still finds it, so the write would not refuse it itself; this matches the page delete's 404 below (review round 1). Any other pre-read failure on a delete refuses the delete (`audit snapshot failed: <reason>; nothing was deleted`). On other writes the failure is stored as `before: {error}` and the write proceeds.
- **E2EE graphs.** `view=outline` and `getPageOutline` answer 409, so deletes store the summary view of the addressed blocks (ciphertext titles) with `e2ee: true`. The subtree can't be read back on E2EE graphs; this is a documented exception to acceptance 2 (section 11, question 3).
- **The snapshot is best-effort.** It is a separate read before the write, so a Logseq client edit between the two is missed. The docs say so.

**As built (stage 3).** Details the text above left open, settled in `connector/src/audit/snapshot.ts` and pinned by `connector/test/audit-snapshot.test.ts`:

- **Which deletes refuse.** Every tool named `delete_*` with a pre-read (`delete_block`, `delete_blocks`, `delete_page`, `delete_tag`, `delete_property`) refuses when its read fails, as "any other pre-read failure on a delete" says. Only the block and page deletes can be `truncated`. A 404 on the read (a page that is hidden or already in the Recycle bin, which `getPageOutline` doesn't show but `deletePage` still finds) refuses too: that page's subtree can't be read.
- **Only UUIDs go to `getBlocks`.** It takes UUIDs only and refuses a duplicate, so the read takes each UUID-shaped id once (ignoring case), in call order, and leaves titles, dates and `..` to the write, which refuses what doesn't exist. A call that names no UUID reads nothing. More than 100 blocks (a `batch_move_blocks` can name more) reads the first 100 and marks the snapshot `truncated`. Page, tag and property selectors are passed to their read as given, encoded once; `.`, `..` and empty ids read nothing, since the handler refuses them before any request.
- **E2EE fallback.** On the outline's 409 a block delete reads `getBlocks` summary and `delete_page` reads `getPage`, each with `e2ee: true`: two GETs, the only case over one. A failing fallback refuses the delete.
- **The oversized refusal** names the entry whose JSON takes the running total over 100 KB, counted in UTF-8 bytes: `entry 1: <uuid> takes the snapshot over 100 KB (102,401 bytes); delete it in parts`. Exactly 100 KB is kept. The cap was 256 KB until review round 1: `get_activity_log` returns a snapshot whole in one result, which claude.ai cuts at 150,000 characters, so a larger one couldn't be read back. A UTF-8 byte count is never below the character count, so 100 KB leaves the entry's other fields about 47,000 characters.
- **Only E2EE's 409 falls back to summaries.** Any other failure of a delete's outline read (500, 404, 503) refuses it, even when the summary read would answer.
- **`batch_insert_block_trees` page reads** (review round 1). `target-id` takes a page title or date as well as a UUID, and `page` names an existing page (or creates one); an entry with properties overwrites the values it sets either way. Each distinct page selector (ignoring case) among entries with properties is read with `getPage`, at most 10 per call (the rest mark the snapshot `truncated`), after the `getBlocks` read of the UUIDs. The row's `before` is then `{source: getBlocks, truncated?, error?, data, pages: [{page, source: getPage, data | error}]}`, with `data` null when no UUID carries properties; a page that doesn't exist yet stores its 404 as `error`. Over the cap every read is cut down to its summary, and past that every `data` is null.
- **Tag and property deletes** keep only the definition (`getTag`, `getProperty`), not the values or tags they remove from each holder. Snapshotting the holders is a backlog item; `connector_help` and README §11.8 say so.
- **`refresh_refs` previews are dry runs.** A `refresh_refs` call without `apply: true` writes nothing, so it is logged with `dry_run = 1` and listed as `dry run` (review round 1).
- **Calls refused for their input's shape** (the MCP SDK's `Input validation error`, such as an empty `block-ids` or a non-string `reason`) are refused before `audited()` runs, so they are not logged. Nothing reaches the graph; `connector_help` and README §11.8 say so.
- **Cut-down snapshots** keep `uuid`, `kind`, `title`, `order`, `parent-id` and `page-id` of each block (or of the page, tag or property); if that is still over the cap, `data` is null.
- **The read comes before `begin`** (step 3 before step 4), so when the INSERT fails the snapshot's GET has already reached the sync server; no write has.
- **`refresh_refs`** stores `{source: "refresh_refs", data: [{uuid, page-id, before}]}` from its response through `finish` (`before = coalesce(?, before)`, still 1 row written), and nothing for a preview (`applied: false`).

### 3.5 `get_activity_log`

A hand-written read tool in `connector/src/tools/activity-log.ts`, registered beside the other hand-written tools and checked against the graph alias like them.

- **Query.** One statement over the `(graph_id, at)` index, with the window and cursor in the inner query and the filters outside it, so no call reads more than 500 rows:

  ```sql
  SELECT … FROM (
    SELECT * FROM audit_log
    WHERE graph_id = ? AND kind = 'write' AND at >= ? AND (at, id) < (?, ?)
    ORDER BY at DESC, id DESC LIMIT 500
  ) WHERE <page, tool, session, status filters> LIMIT ?
  ```

  The page filter matches a page UUID exactly or a lower-cased title as a line of `pages`. The cursor is the `(at, id)` of the last row scanned, not the last row returned, so a selective filter pages through the window rather than missing rows; it is null when the window is exhausted.
- **Result.** A plain-text summary first, one line per entry: `Nov 5th, 2026 14:02 delete_blocks ok: Nov 5th, 2026 > Notes > "Call Sam…" (+3). Reason: tidy duplicate notes`, with `dry run`, `refused: <error>` or `outcome unknown` where they apply. Then the JSON entries. The default window is the last 7 days, so "what did Claude change this week" takes one call (acceptance 3).
- **Snapshots.** Listings leave `before` out (graft). `include_snapshot: true` adds it to each entry, and `id` fetches one entry with its snapshot by primary key (1 row read).
- **Its own cost.** Each call appends a `kind = 'read'` row with the tool name, the window and the `meta.rows_read` of its query (2 rows written). This is how the usage report sees the log's read cost (acceptance 5). Read rows are excluded from listings.

**As built (stage 4).** Measured from D1 meta in the connector's test pool (`connector/test/activity-log.test.ts`), the single statement above can't both stop at 500 rows read and return the last row scanned, so the query is two statements:

- **The scan** is an aggregate: `SELECT count(*), min(printf('%015d.%015d', at, id)), json_group_array(json_array(id, at)) FILTER (WHERE <kind and filters>) FROM (SELECT … WHERE graph_id = ? AND at >= ? AND at <= ? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT 499 - limit)`. It reads one row per row scanned and answers how many it scanned, the last one, and each match's `(id, at)`. `kind = 'write'` moved outside the scan with the other filters, so read rows cost nothing extra; `scanned` counts them. `at <= ?` is the cursor's `at` (or `until` less 1 ms), the only upper bound on `at`: given `at < until` as well, the planner bounded the index range by `until` and read every row above the cursor (2,500 rows for a 500-row page).
- **The page** is read by primary key: `SELECT … FROM (VALUES (id), …) AS ids CROSS JOIN audit_log AS a ON a.id = ids.column1`, one row read per entry, with the ids inlined as integers (D1 binds at most 100 values). `before` is selected only with `include_snapshot`.
- **Rejected, measured:** a window function (`row_number`, `count(*) OVER ()`) read 1,501 to 3,002 rows for a 500-row scan; a materialised CTE 1,500; `IN (…)` and `json_each` two rows per id; a compound `UNION ALL` of more than a few terms is refused by D1; a batch of lookups spends one of the invocation's 50 D1 queries per entry.
- **Cost:** at most 500 rows read per listing (499 less `limit` scanned, the cursor's own row read and skipped, and `limit` by id), plus any rows sharing the cursor's millisecond with a higher id. A lookup by `id` reads 1. Each call that reads the log writes 2 (its `kind = 'read'` row, whose `addressed` holds the window as an ISO interval or `id:<n>`). An input refused before any query (a bad date, a window over 92 days, a bad cursor) reads and records nothing. An `id` naming a read row answers `no such entry`.
- **The cursor** is `<at>.<id>`. When the matches fill the page it is the last entry returned; otherwise the last row scanned; null when the scan came back short.
- **Pages and addressed** (review round 1). `pages` also holds the pages the call names (`page-id`, `page`, and a `target-id` that is a title or date) and those its snapshot read (a page read's UUID and title, each block's `page-id`), from `begin`, so refused, failed and pending entries are found by page too. A write whose response names no target (`update_page`, `promote_page_to_tag`) stores the page its `getPage` read returned as its target, and so does a refused or failed call whose page was read. The JSON gains `addressed`, and a line with no target shows the first UUID or selector the call named.
- **Listings fit one result.** Entries are kept, newest first, while the text and JSON stay under 150,000 characters; when one is left out, `next-cursor` resumes after the last one kept, and the text part repeats it (`next-cursor: <cursor>`). An entry whose JSON alone wouldn't fit keeps only its first target, with `targets-omitted`.
- **The summary line** is `<when> <tool> <outcome>: <first target> (+N more). Reason: <reason>`, with the first target as item 17's summaries show it (`targetLine`, so a delete's own count reads `(+3 children)`), and the outcome `ok`, `dry run`, `refused: <error>`, `error: <error>` (error text on one line, cut at 200 characters), `refused (dry run): …` or `outcome unknown`. `status: ok` leaves dry runs out; `dry-run` lists every dry run whatever its status.
- **Dates:** a `YYYY-MM-DD` `until` covers that whole day (`until` is exclusive, so it is the next day's start). A window of 92 calendar days that spans the end of daylight saving is 92 days and an hour long, and is kept: the limit is 92 days plus one hour. The time zone is `timeZone` from `config/settings.json`, bundled into the connector (UTC when unset).

### 3.6 Retention

The hourly `KB_INDEX_CRON` case also calls `purgeAuditLog(env, cutoff)`, with the cutoff from `connector.auditRetentionDays` (default 90):

1. `SELECT at FROM audit_log ORDER BY id LIMIT 1` (1 row read). If the oldest row is newer than the cutoff, stop.
2. Otherwise `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY id LIMIT 500) AND at < ?`, which reads at most 500 rows and deletes the old ones among them, oldest first.

The probe matters: the measured alternative read the whole table every hour when nothing was old enough (section 2). A purge failure is logged and doesn't affect the KB index work in the same case.

**As built (stage 1).** Measured from D1 meta in the connector's test pool, two statements differ from the text above, and the costs in section 5 are corrected here:

- The DELETE is `DELETE FROM audit_log WHERE id < ? AND at < ?`, bound to the probed oldest id + 500. The `id IN (SELECT id … ORDER BY id LIMIT 500)` form read 2,000 rows to delete 500; the id range reads at most 501. A purge with old rows costs at most 502 rows read and writes 1 row per row deleted (D1 doesn't count index entries on DELETE), so at most 500, not 1,000. The probe also reads 1 row on an empty table. The probe selects `id, at` to bound the range.
- The `status` CHECK is written `status = 'pending' OR status = 'ok' OR status = 'error' OR status = 'refused'` rather than `IN (...)`. An `IN` list of three or more values builds an ephemeral table that D1 bills as one more row read on every INSERT and UPDATE (INSERT 2 written and 1 read, UPDATE 1 written and 2 read); the OR chain keeps the section 5 figures of 3 written and 1 read per write call. It accepts and refuses the same values.
- A purge failure is logged and rethrown after the KB index refresh ran, so the cron run shows as failed; a KB index failure is rethrown first.

### 3.7 Usage report

`scripts/usage-report.mjs` gains an *Audit log* section, from one aggregate query through the D1 REST query API:

```sql
SELECT count(*), sum(at >= ?today), sum(rows_written), sum(CASE WHEN kind = 'read' THEN rows_read END),
       sum(length(before)) + sum(length(targets))
FROM audit_log
```

It shows entries kept, entries today, rows written by the log, rows read by `get_activity_log`, and snapshot and target bytes. The GraphQL query gains `d1StorageAdaptiveGroups { max { databaseSizeBytes } }` for the connector database, shown against the 500 MB per-database limit. The query reads the table once a day (about 27k rows at 300 writes a day for 90 days); it runs from GitHub Actions, not the Worker.

**As built (stage 5).** The query names its columns and counts bytes as stored, `sum(length(CAST(before AS BLOB)))` and the same for `targets`, as two sums the script adds (SQLite's `length` of TEXT counts characters, and `null + n` is null in SQL). Every null sum on an empty table prints as 0. `?today` is 00:00 UTC in ms, and an entry at exactly 00:00 counts as today's. The size is the newest daily `d1StorageAdaptiveGroups` group of the last 3 days (`size not reported yet` when there is none), shown against 500,000,000 bytes, and only the daily GraphQL call asks for it. Without `CONNECTOR_D1_DATABASE_ID` neither the D1 query nor the size is requested. A failed D1 query (a 403 names D1 Read) prints `Failed: <reason>` in the section, keeps the allowances table, and makes the run exit 1. The size is shown, not alerted on.

`rows_written` on each entry is the INSERT's own `meta.rows_written`; the UPDATE's cost (1 row, since it changes no indexed column) is a constant added at insert time and pinned by a test that reads D1 `meta` in the vitest pool. The workflow's Cloudflare token needs **D1 Read** and the connector database id; the README says so.

### 3.8 Client and session

- `client` is a short User-Agent family (`claude-ai`, `claude-code`, `other`), since `ctx.props` doesn't carry the OAuth client id. Extending `GrantProps` with the client id at `completeAuthorization` would only take effect for new grants (section 11, question 4).
- `session` is the `mcp-session-id` request header when present, else null. claude.ai's stateless requests may not send one, so the session filter may often match nothing.

Neither is a token. The OAuth access token, the graph PAT and any other header are never read into the row.

## 4. Tool contract

**Added: `get_activity_log`** (`readOnlyHint: true`, `idempotentHint: true`, `destructiveHint: false`, `openWorldHint: false`).

| Input | Meaning |
|---|---|
| `graph` | Alias, required. |
| `since`, `until` | ISO datetime or `YYYY-MM-DD` in the owner's time zone (`config/settings.json` `timeZone`). Default: the last 7 days. A window over 92 days is refused. |
| `page` | Page UUID or title, matched against the pages each entry touched. |
| `tool` | Tool name. |
| `session` | Session id. |
| `status` | `ok`, `error`, `refused`, `pending` or `dry-run`. |
| `include_snapshot` | Boolean, default false. |
| `id` | One entry, returned with its snapshot. Other filters are ignored. |
| `limit` | Default 50, at most 200. |
| `cursor` | Opaque; from the previous result's `next-cursor`. |

Output: the plain-text summary, then

```
{entries: [{id, at, tool, status, dry_run, reason, client, session,
            targets: AffectedTarget[], error?,
            before?: {source: "getBlocks" | "getPageOutline" | "getPage" | "getTag" | "getProperty" | "refresh_refs",
                      truncated?, e2ee?, error?, data}}],
 "next-cursor": string | null, scanned: number}
```

Errors name the input: `since: not a date or datetime`, `window: at most 92 days`, `id 1234: no such entry for graph work`.

**Changed, inputs unchanged: every write tool** (each generated non-read tool, plus `save_document` and `save_file_from_url`).

- Each call is logged, including refused calls, failed calls and dry runs.
- The result gains `Logged as audit entry <id>`.
- A write is refused with `audit log unavailable: <reason>; nothing was written` when the pending row can't be written or the table is missing.
- `delete_block`, `delete_blocks` and `delete_page` are refused up front, naming the entry, when the subtree can't be snapshotted in full.
- The result gains `Audit log entry <id> could not be completed: <reason>` when the final update fails after the write was applied.

**Text.** `connector_help` gains: "Every write is logged with its reason; `get_activity_log` answers what changed and shows what an update, move or delete overwrote. Very large deletes are refused; delete in parts." The write tools' descriptions don't change (the guidance is in `connector_help`, as item 17 did, to keep `tools/list` small). `tools-manifest.json`, README §11.8 and the PR's Logseq skill note are updated; the skill note says to cite the audit entry id and to use `get_activity_log` for "what did you change" questions.

## 5. Cost on the Free plan

Daily account caps: 100k Worker requests, 5M D1 rows read, 100k D1 rows written, 10k neurons, 500 MB per D1 database.

| Operation | D1 rows written | D1 rows read | Other |
|---|---|---|---|
| Write call (measured) | 3: INSERT 2 (row and index), UPDATE 1 | 1 (the UPDATE's lookup) | 1 extra GET to the sync Worker for tools with a snapshot; none for inserts, creates, `refresh_refs`, asset saves or dry runs |
| First write in an isolate | 0 | 0 (probe, `LIMIT 0`) | |
| `get_activity_log` listing | 2 (its read row) | at most 500 (measured: the capped inner query read 500 of 3,001) | |
| `get_activity_log` by `id` | 2 | 1 | |
| Hourly purge, nothing old | 0 | 1 (measured) | |
| Hourly purge, old rows | up to 1,000 (500 rows and their index entries) | up to 500 | |
| Daily usage report | 0 | about count(audit_log), 27k at 300 writes a day | from GitHub Actions |

Daily totals at 300 writes a day: about 900 rows written for the log, about 600 for the purge in steady state, and a few thousand read. That is under 2% of 100k written and under 1% of 5M read. The snapshot GETs are reads, so they don't count against the sync server's write rate limit; if service-binding calls count as Worker requests, they add about one request per destructive write, which the usage report will show after deploy (risk 4).

Worst case at the sync write rate limit (20 a minute all day, 28,800 calls): about 86k log rows written plus the purge, which would breach 100k. The 100k Worker request cap is reached first, since each write is already at least two Worker invocations.

Storage: about 1 to 3 KB per typical entry, up to 100 KB for a delete snapshot. At 300 a day for 90 days with a 2 KB average, about 55 MB of the 500 MB per-database limit, shown by the usage report.

CPU: the snapshot is JSON from the sync server, stored as text without re-parsing beyond the size check and the `truncated` flags. A 100 KB `JSON.parse` is the largest added cost on the 10 ms budget; the cap keeps it bounded.

## 6. Safety

- **No secrets.** Raw arguments are never stored (3.2). `client` and `session` are not tokens (3.8). A test seeds a fake PAT, an `Authorization` header and a `GRAPH_TOKEN_KEY` value, runs writes and refusals, and greps every column of `SELECT *` for them.
- **Owner-only.** The log is read only through `get_activity_log`, behind the same sign-in and owner check as every tool, and only for the graph alias given. Reasons and snapshots hold private graph text; they never go to Workers logs (the log line stays `reason=yes|no`, as item 17 set).
- **No silent unlogged writes.** Write-ahead pending row, refusal when it can't be stored, a visible line when finishing fails, `outcome unknown` for orphaned rows (acceptance 4).
- **Guards unchanged.** `acknowledge-*` flags, dry runs and item 17's `target-label` checks are untouched; the log adds a refusal for deletes too large to snapshot.
- **D1 on the write path.** A D1 outage or the daily write cap now blocks graph writes, by design. Writes already depend on D1 for graph tokens.

## 7. Risks

1. **Best-effort snapshot.** A client edit between the pre-read and the write is missed. Acceptable for a one-owner audit log; documented. The patch route in section 3's rejected list closes it.
2. **Undocumented outline fields.** `getBlocks` `view=outline` returns `markdown`, `block-count` and `truncated` per block (checked in `bulk-read-response`), but the `BlocksResponse` schema doesn't list them. The connector reads them by name, and a test against the vendored generator pins the shape. A later patch could add them to the schema.
3. **Outline is readable, not restorable.** The markdown outline shows references as `[[titles]]`, folds properties into `key:: value` lines and leaves out hidden property-value blocks, UUIDs and order keys. Acceptance 2 (read back) holds; a future `restore_from_log` would need the server-side snapshot.
4. **Extra Worker request.** The snapshot GET may count toward the 100k daily Worker requests through the service binding. Check in the usage report after deploy.
5. **Large deletes refused.** A behaviour change; callers get an error naming the entry and asking them to delete in parts (section 11, question 2).
6. **Thin client and session.** Likely `claude-ai`/`claude-code` and mostly null sessions.
7. **Usage token.** The workflow's token needs D1 Read and the database id, an operator change the README must state.
8. **Orphaned pending rows** are shown, not reconciled.

## 8. Testing

All connector tests run in `@cloudflare/vitest-pool-workers` against real D1 with migrations applied by `test/apply-migrations.ts`, and against the real generated tools, with the `SYNC` binding faked at the HTTP level as `tools.test.ts` does. Each test is seen to fail before its code exists, and the failure is quoted in the PR.

1. **Acceptance 1.** A table-driven test over `tools-manifest.json` calls every non-read tool once in each of: success, sync 409, refused reason, read-only graph, dry run (where the tool has one). It asserts exactly one `audit_log` row per call with the right `status` and `dry_run`. A guard test asserts every non-read tool has a `SNAPSHOT_PLAN` entry, mutation-checked by removing one.
2. **Acceptance 2.** `delete_blocks` with a fake `getBlocks` outline response is read back through `get_activity_log(id, include_snapshot)` and contains the full outline. An outline with `truncated: true`, and one over 100 KB, are refused naming the entry, with nothing sent to the delete endpoint (asserted on the fake's request log). The `getBlocks` outline shape the fake returns is checked against `bulk-read-response` in a db-sync test run by CI's upstream suite, so the fake can't drift from the real handler.
3. **Acceptance 3.** Seeded entries over a week: the summary carries page titles, breadcrumbs, snippets and reasons; the page, tool, session and status filters work; a selective filter pages through a window larger than 500 rows; the cursor ends on null; `pending` rows show as `outcome unknown`.
4. **Acceptance 4.** A `DB` wrapper that throws on INSERT refuses the write with no request reaching the fake sync server. One that throws on UPDATE leaves the write applied and the result carrying the "could not be completed" line. A database without migration 0004 refuses writes with the migration message.
5. **Cost.** Tests read `meta.rows_written` and `meta.rows_read` from the real statements and pin 3 rows written per write, at most 500 rows read per listing, and 1 row read for a purge with nothing old (the measured full-table read in section 2 is the mutant this test kills).
6. **Purge.** Rows seeded at 89, 90 and 91 days: only those past the cutoff are deleted, at most 500 per run, oldest first.
7. **Secrets.** The canary test in section 6.
8. **Usage report.** `scripts/usage-report.test.mjs` renders the Audit log section from a faked D1 query response and the storage figure from a faked GraphQL response, including an empty table.
9. **Gate.** `scripts/check.sh` (no `--upstream`, since `patches/` doesn't change) and the tools-manifest check.

## 9. Rollout and verification

1. Merge item 17 first; this work builds on `readable.ts` and patch 0028.
2. Add the D1 Read permission to the usage workflow's token and the database id to its environment.
3. Merge to main: the deploy workflow applies migration 0004 before deploying the Worker. If the migration were skipped, the probe refuses writes with a clear message rather than failing silently.
4. After deploy, on a scratch page: run `update_block`, `move_blocks`, `delete_blocks` (dry run, then real) and a refused call; check `get_activity_log` shows each, with titles and the deleted subtree, and that each result named its entry id.
5. Check the next usage report shows the Audit log section and the database size, and compare Worker requests before and after (risk 4).
6. The PR's verification section names the commit the checks ran on and what `scripts/check.sh` skipped.

## 10. Out of scope

- `restore_from_log(entry-id, dry-run)`. It needs a restorable snapshot (UUIDs, order keys, hidden value blocks), which means the server-side snapshot from the pre-transaction db inside `atomic-write!` (patch). Revisit with that.
- The daily digest cron that writes a "Claude activity" summary into the journal. It would make the connector write to the graph unprompted and add a cron; `get_activity_log` answers the same question on demand.
- R2 storage for snapshots over 100 KB.
- Logging read tools beyond `get_activity_log`'s own cost row.
- Edits made in the Logseq app or by other API clients.
- Reconciling `pending` rows after a crash.

## 11. Open questions for the owner

1. **Daily digest.** Leave it out (this design), or add a journal summary under a "Claude activity" heading later as its own item?
2. **Large deletes.** Refuse deletes whose subtree can't be snapshotted in full (over 2,000 blocks or 256 KB, lowered to 100 KB in review round 1), as designed, or allow them with a truncated snapshot and a warning in the result?
3. **E2EE graphs.** Accept that a deleted subtree can't be read back on E2EE graphs (only the addressed blocks' encrypted summaries are kept), or refuse block deletes on E2EE graphs?
4. **Client id.** Is the User-Agent family enough for `client`, or should `GrantProps` carry the OAuth client id (new grants only, so a re-consent)?
5. **Snapshot compression.** Store snapshots as plain JSON text (this design, about 55 MB at 300 writes a day), or gzip them into a BLOB to roughly halve storage at some CPU cost on the 10 ms budget?
6. **Read-cost rows.** Keep the `kind = 'read'` row each `get_activity_log` call writes (2 rows, so the usage report can count the log's reads exactly), or drop it and report the log's reads as part of the account-wide D1 total?
7. **Retention.** 90 days by default, as for backups. Shorter or longer?
