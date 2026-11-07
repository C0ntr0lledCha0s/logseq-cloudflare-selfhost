# Connector write audit log with before-snapshots and `get_activity_log`: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every write, move and delete call the connector runs is logged to an owner-only D1 table, with its reason, readable targets and, for updates, moves, property changes and deletes, a before-snapshot of what it overwrote. A read-only `get_activity_log` tool answers "what did Claude change this week" in one call. Entries are kept 90 days, and the usage report shows the log's reads, writes and storage.

**Architecture:**
- **Connector only.** No patch, no R2, no new cron trigger, no digest (spec §3, *Approach*). `scripts/check.sh` runs without `--upstream` in every stage.
- **Write-ahead log.** `audited()` inserts a `pending` row holding the before-snapshot, runs the existing handler, then updates the row by id with the outcome. A write whose pending row can't be stored is refused before any request reaches the sync server.
- **One new store and two new modules:** `connector/src/audit/log.ts` (`AuditLog` and `audited()`), `connector/src/audit/snapshot.ts` (`SNAPSHOT_PLAN` and the pre-read), and the tool `connector/src/tools/activity-log.ts`.
- **Item 17 is reused, not rebuilt.** Targets come from `describeWrite` and `toAffectedTargets` in `connector/src/tools/readable.ts`; the reason from `takeReason`; the guard-table pattern from `contextClassFor`.
- **Order:** storage first (nothing calls it yet), then the wrapper with no snapshots, then snapshots, then the reading tool, then the usage report. Every stage leaves writes working and the gate green.

**Tech stack:** TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1 in workerd, migrations applied by `connector/test/apply-migrations.ts`, the `SYNC` binding faked at the HTTP level as `tools.test.ts` does); Node `node:test` for `scripts/`.

**Spec:** `docs/superpowers/specs/2026-11-07-connector-write-audit-log-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) and test numbers ("spec test 4") are the spec's.

## Global constraints

- **Names, exactly:**
  - migration `connector/migrations/0004_audit_log.sql`, table `audit_log`, index `audit_log_graph_at` on `(graph_id, at)`, columns as in §3.2;
  - `connector/src/audit/log.ts` exports `AuditLog` (methods `probe`, `begin`, `finish`, `query`, `get`, `purge`, `recordRead`), `audited`, `purgeAuditLog(env, now)`, `AUDIT_UPDATE_ROWS = 1`, `QUERY_SCAN_CAP = 500`, `PURGE_BATCH = 500`;
  - `connector/src/audit/snapshot.ts` exports `SNAPSHOT_PLAN`, `snapshotClassFor(name)`, `takeSnapshot(access, alias, tool, args)`, `SNAPSHOT_MAX_BYTES = 262_144`;
  - the tool is `get_activity_log`, in `connector/src/tools/activity-log.ts`, exporting `registerActivityLogTool`;
  - the setting is `connector.auditRetentionDays` in `config/settings.json`, rendered as the Worker var `AUDIT_RETENTION_DAYS` by `scripts/render-connector-wrangler.mjs` and read by `auditRetentionDays(env)` in `connector/src/config.ts` (default 90, refused outside 1 to 365).
- **Messages, in the spec's wording** (§3.3, §3.4, §4; `docs/solutions/api/one-error-for-every-failure.md`):
  - `audit log unavailable: migration 0004 has not been applied; nothing was written`
  - `audit log unavailable: <reason>; nothing was written`
  - `entry 3: <uuid> has more descendants than the 2,000-block snapshot budget; delete it in parts`
  - `audit snapshot failed: <reason>; nothing was deleted`
  - `Logged as audit entry <id>` and `Audit log entry <id> could not be completed: <reason>`
  - `since: not a date or datetime`, `window: at most 92 days`, `id 1234: no such entry for graph work`
- **No silent unlogged writes** (acceptance 4). Every non-read tool goes through `audited()`; a guard test fails when one doesn't. A failed `finish` never turns an applied write into an error; it adds the visible line instead.
- **Nothing but the §3.2 columns is stored.** Raw tool arguments, block text a write sends, the OAuth token, the graph PAT and request headers never reach a row (§3.2, §6). `client` is a User-Agent family, `session` the `mcp-session-id` header (§3.8).
- **The reason stays out of Workers logs.** The log line keeps item 17's `reason=yes|no`; the reason text goes only to `audit_log`.
- **The existing guards stay** (REVIEW.md *Destructive operations keep their guards*): `acknowledge-*` flags, dry runs and `target-label` checks are untouched. The only new refusal is a delete too large to snapshot (Stage 3).
- **Free plan** (§5, REVIEW.md *Cost*, `docs/solutions/cost/d1-reads-from-indexer-scans.md`). Tests pin, from D1's own `meta`: 3 rows written and 1 read per write call (INSERT 2, UPDATE 1); the probe reads 0; a listing reads at most 500; a lookup by id reads 1; a purge with nothing old reads 1; a purge with old rows reads at most 500. No `count(*)` and no unbounded scan in the Worker. A feed ends with a null cursor. Each stage's commit body states its rows per call.
- **Tests run the real thing.** Real D1 and the real generated tools; only the sync server is faked, at HTTP level. Each new test is first seen to fail; keep the failure text for the PR (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`).
- **Contract with Claude.** A stage that changes a tool's output or adds a tool updates `CONNECTOR_HELP` in the same commit. Write tools' descriptions do not change (§4, *Text*); the guidance lives once in `CONNECTOR_HELP`. `tools-manifest.json` is regenerated in the stage that adds `get_activity_log`.
- **Commits** follow `type(scope): what changed` (scopes `connector`, `deploy`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a graph name, page UUID, hostname, token or database id. Tests and docs use `sync.example.com`, `mcp.example.com`, the alias `work`, and invented titles such as "Nov 5th, 2026", Notes and Meeting.

### Read before starting

- `REVIEW.md`, sections *Cost*, *Contract and docs*, *Destructive operations keep their guards* and *Connector*.
- `connector/src/tools/readable.ts` (all of it), `semantic.ts` (`registerGraphTools`, `resolveGraph`, `graphFetch`), `assets.ts` (`registerAssetTools`), `common.ts` (`runTool`, `ToolError`), `connector/src/mcp.ts` (`isolateTools`, `mcpHandler`, `mcpApiHandler`) and `connector/src/index.ts` (`scheduled`).
- `connector/migrations/0002_semantic.sql` and `connector/src/semantic/store.ts` for how D1 state and its `meta` are handled.
- `.upstream/deps/db-sync/test/logseq/db_sync/semantic_bulk_test.cljs` (the `view=outline` assertions) and `semantic.cljs` `bulk-read-response` and `page-outline` (§2).
- The `docs/solutions` entries listed in spec §2.

### Where the spec's upstream test is covered without a patch

Spec test 2 asks that the `getBlocks` `view=outline` shape the fake returns be checked against `bulk-read-response` by CI's upstream suite. The existing `semantic_bulk_test.cljs` already asserts `markdown`, `block-count` and `truncated` (as `false`) per entry on that view, and CI runs it on every push. Stage 3's fixtures copy exactly those keys, and a connector test names that upstream test in a comment. `truncated: true` is not asserted upstream; it is read from `page-outline` (`semantic.cljs:405`). Adding an upstream assertion would mean amending a patch, which the spec rules out; the gap is noted in the PR body under risk 2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A refusal before the handler runs** (reason over 200 characters, unknown alias, read-only graph): one row, `status = 'refused'`, `graph_id` null for the unknown alias, and nothing sent to the sync server (Stage 2).
2. **A ToolError thrown by the handler after the server answered 409:** one row with `status = 'error'` and the server's message, not `ok` and not two rows (Stage 2).
3. **A dry run of a destructive tool:** `dry_run = 1`, no snapshot pre-read (asserted on the fake's request log), targets from the dry-run response (Stages 2 and 3).
4. **The probe in a new isolate after the table exists:** one probe per isolate, not per call; a failed probe is not cached as success (Stage 2).
5. **`delete_blocks` with two blocks that each fit the 2,000-block budget but not together:** refused naming the entry where `truncated` first appears; nothing sent to the delete endpoint (Stage 3).
6. **A UUID under `missing` in the pre-read:** the write still goes ahead, the server's refusal of that UUID is what the row records (Stage 3).
7. **A selective filter over a window of more than 500 rows:** the cursor is the last row scanned, not returned, so matching rows past the first 500 are found on the next page; the last page answers `next-cursor: null` (Stage 4).
8. **A page title containing a newline-like or case variant** ("notes" vs "Notes"): the page filter matches lines of `pages` exactly after lower-casing, so "note" does not match "notes" (Stage 4).
9. **Rows at exactly the cutoff:** a row at 90 days to the millisecond is kept; strictly older is purged (Stage 1).
10. **An empty `audit_log` in the usage report:** the section prints zeros, not `null` or `NaN` (Stage 5).

---

### Stage 1: The `audit_log` table, its store and the hourly purge

**Goal:** the table, its index and an `AuditLog` store whose statements have the measured costs, plus the retention setting and the purge in the hourly cron. Nothing writes to the log yet, so behaviour for Claude is unchanged.

**Files:**
- Create: `connector/migrations/0004_audit_log.sql` (§3.2, verbatim). Follow the `add-d1-migration` skill.
- Create: `connector/src/audit/log.ts` with `AuditLog`:
  - `probe(): Promise<"ok" | "missing">`: `SELECT 1 FROM audit_log LIMIT 0`; "missing" only for D1's `no such table` error, any other error rethrown.
  - `begin(row): Promise<number>`: INSERT with `at`, `graph_id`, `alias`, `tool`, `kind = 'write'`, `status = 'pending'`, `dry_run`, `reason`, `client`, `session`, `addressed`, `before`, and `rows_written = meta.rows_written + AUDIT_UPDATE_ROWS`, `rows_read = meta.rows_read`; returns `meta.last_row_id`.
  - `finish(id, {status, error, targets, pages})`: UPDATE by primary key.
  - `get(graphId, id)`: one row by primary key and graph.
  - `purge(cutoff)`: the §3.6 probe, then the capped DELETE; returns `{deleted, rowsRead, rowsWritten}`.
  - `purgeAuditLog(env, now)`: `purge(now - auditRetentionDays(env) * 86_400_000)`.
- Modify: `connector/src/config.ts` (`auditRetentionDays`), `config/settings.json` (`"auditRetentionDays": 90` under `connector`), `scripts/render-connector-wrangler.mjs` and its test (renders `AUDIT_RETENTION_DAYS`, refuses a template that sets it, refuses values outside 1 to 365), `connector/wrangler.test.jsonc` (`AUDIT_RETENTION_DAYS` under `vars`) and `connector/worker-configuration.d.ts` (the optional var on `Env`).
- Modify: `connector/src/index.ts`: the `KB_INDEX_CRON` case runs `refreshAllKbIndexes` and `purgeAuditLog` independently; each failure is logged, and a KB index failure is rethrown only after the purge ran.
- Create: `connector/test/audit-log.test.ts`.

**Interfaces produced:** `AuditLog`, `AuditRow` (the §3.2 columns), `purgeAuditLog`, `auditRetentionDays`.

- [ ] **Step 1: Write the failing tests** (spec tests 5 and 6, cost half):
  - `begin then finish costs 3 rows written, 1 read`: from each statement's `meta`; the row's own `rows_written` is 3.
  - `probe reads nothing`: `meta.rows_read` is 0 on a table with rows; on a database where `audit_log` was dropped it answers "missing"; a non-table error is rethrown.
  - `get reads one row`; another graph's id answers null.
  - `purge with nothing old reads 1 row`: 3,001 recent rows seeded; nothing deleted, `rowsRead` 1. This kills the `IN (SELECT … ORDER BY id LIMIT 500)`-only mutant, which reads 3,002.
  - `purge removes only rows past the cutoff, oldest first, at most 500`: rows at 89 days, exactly 90 days and 91 days, plus 600 rows at 100 days; the first run deletes 500 of the oldest; the second the rest and the 91-day row; the 90-day and 89-day rows stay (review focus 9).
  - `retention setting`: default 90; `"0"`, `"366"` and `"ninety"` refused with a message naming `AUDIT_RETENTION_DAYS`.
  - `cron runs the purge even when the KB index fails`: `scheduled` with `KB_INDEX_CRON`, a failing KB refresh, and old rows seeded: rows are purged and the KB error still surfaces.
  - In `render-connector-wrangler.test.mjs`: the var is rendered from settings and bounds are checked.

- [ ] **Step 2: Run** `npm --prefix connector test -- audit-log` and `npm test`; keep the failures (no such table, no module).

- [ ] **Step 3: Implement** as §3.2 and §3.6. `id INTEGER PRIMARY KEY` without `AUTOINCREMENT`.

- [ ] **Step 4: Contract.** None for Claude. README's settings table gains `connector.auditRetentionDays` (one row; the full docs are the docs stage's).

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** drop the purge's oldest-row probe and confirm `purge with nothing old reads 1 row` fails; change `<` to `<=` and confirm the cutoff test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): add the audit_log table, its store and a 90-day hourly purge`. Body: rows per statement and per cron run (purge: 1 read with nothing old, at most 500 read and 1,000 written otherwise).

**Done when:** migration 0004 applies, every statement's cost is pinned from `meta`, the hourly cron purges past the retention setting without scanning, and the gate is green.

---

### Stage 2: Every write runs through `audited()`

**Goal:** every non-read tool writes one row per call, including refusals, failures and dry runs; a write whose pending row can't be stored is refused; a failed finish is reported; the result names the entry. Snapshots are `null` in this stage. Lands acceptances 1, 4, 6 and 8.

**Files:**
- Modify: `connector/src/audit/log.ts`: `audited(ctx, tool, alias, args, run)` as §3.3 steps 1, 2, 4 to 7 (step 3 is Stage 3's). `ctx` is `{log: AuditLog, access: GraphAccess, client, session, snapshot?}`. The probe result is cached per isolate only when "ok". Status mapping: `ToolError` with code `refused` (reason, unknown alias, read-only graph, guards) is `refused`; any other thrown error, including a sync 4xx/5xx mapped to `ToolError`, is `error`; a resolved result is `ok`. `pages` is built from each target's page title (lower-cased) and page UUID, `\n`-joined.
- Modify: `connector/src/tools/semantic.ts`: `registerGraphTools` takes an `AuditContext` and runs each non-read tool through `audited()`, around `takeReason`, the handler and `describeWrite`, so a refused reason is logged too. `onSuccess` is unchanged.
- Modify: `connector/src/tools/assets.ts`: `save_document` and `save_file_from_url` likewise.
- Modify: `connector/src/mcp.ts`: `isolateTools` builds one `AuditLog` per isolate; `mcpApiHandler` derives `client` from the User-Agent (`claude-ai`, `claude-code`, `other`) and `session` from `mcp-session-id`, and passes both to `mcpHandler`. The graph resolution `audited()` needs for `graph_id` goes through `access.resolve`; if the handler resolves again, cache the result per request so a write costs no extra D1 read (check with `meta` and state the count in the commit body).
- Modify: `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`).
- Modify: `connector/test/tools.test.ts`, `connector/test/assets.test.ts`, `connector/test/audit-log.test.ts`.

**Interfaces produced:** `AuditContext`; `audited()`; `userAgentFamily(ua)`.

- [ ] **Step 1: Write the failing tests** (spec tests 1, 4 and 7):
  - `one row per write call`: table-driven over `tools-manifest.json`'s non-read tools plus the two asset tools. For each, call once for success, sync 409, refused reason (201 characters), unknown alias, read-only graph, and dry run where the schema has `dry-run`. Assert exactly one new row per call with the right `status`, `dry_run`, `tool`, `alias`, `reason` and, on success, `targets` equal to what `describeWrite` gives the same response (review focus 1, 2 and 3).
  - `every write is audited`: register tools on a server built as `mcpHandler` builds it with a spy `AuditLog`; every non-read tool calls `begin` once. A tool registered without the wrapper fails this test.
  - `INSERT fails, write refused`: a `DB` wrapper that throws on the INSERT answers `audit log unavailable: <reason>; nothing was written`, and the fake sync server saw no request.
  - `UPDATE fails, write stands`: a wrapper that throws on the UPDATE leaves the fake's write applied, the row `pending`, and the result's first line `Audit log entry <id> could not be completed: <reason>`.
  - `migration missing`: with `audit_log` dropped, a write is refused with the migration message and nothing is sent; reads still work; the probe runs once per isolate when it succeeds (review focus 4).
  - `result names the entry`: the summary item ends with `Logged as audit entry <id>` and the id reads back.
  - `no secrets in the log` (§6): seed a fake PAT, an `Authorization: Bearer` header, a `GRAPH_TOKEN_KEY` value and block text in `update_block`'s `content`; run successes and refusals; no column of `SELECT *` contains any of them.
  - `client and session`: User-Agents for claude.ai, Claude Code and curl map to the three families; `mcp-session-id` is stored when sent, null otherwise.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.3 and §3.8. Only the columns in §3.2 are bound; `addressed` is the UUIDs or selectors read from the known argument names (`block-id`, `block-ids`, `page-id`, `target-id`, entries' `block-id`), never whole arguments.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: "Every write is logged with its reason, and its result ends with the audit entry id. If the log can't be written, the write is refused." No description changes; the manifest is unchanged.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** log after the write instead of before and confirm `INSERT fails, write refused` fails; swallow the UPDATE error without the line and confirm `UPDATE fails, write stands` fails; store `JSON.stringify(args)` in `addressed` and confirm the secrets test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): log every write, refusal and dry run before it runs`. Body: 3 rows written and 1 read per write call, plus any graph-resolution read, measured.

**Done when:** every write call leaves exactly one row with the right status, an unloggable write is refused before the server sees it, a failed finish is visible in the result, nothing secret is stored, and the gate is green.

---

### Stage 3: Before-snapshots

**Goal:** before an update, move, property change or delete, `audited()` stores what it will overwrite; a block or page delete whose subtree can't be snapshotted in full is refused, naming the entry. Lands acceptance 2.

**Files:**
- Create: `connector/src/audit/snapshot.ts`: `SNAPSHOT_PLAN` (§3.4's table; each entry `{source, read(args) -> request | null, keep}` or `{source: "none", why}`), `snapshotClassFor(name)` that throws `no snapshot plan for tool <name>`, and `takeSnapshot` that issues one request through `resolveGraph`/`graphFetch`, parses only enough to check `truncated`, `missing` and the size, and returns `{source, truncated?, e2ee?, error?, data}` as text.
  - Block deletes use `getBlocks` with `view=outline`; on a 409 for E2EE they fall back to `view=summary` with `e2ee: true` (§3.4).
  - `delete_page` uses `getPageOutline`; `update_page` and `promote_page_to_tag` use `getPage`; tag tools use `getTag`; property tools use `getProperty`; `batch_insert_block_trees` reads `getBlocks` only for entries with a `target-id` and properties; `refresh_refs` stores its own response's before-text in `finish` with `source: "refresh_refs"`.
- Modify: `connector/src/audit/log.ts`: step 3 of §3.3, skipped for dry runs. Refusals and failures as §3.4 *Rules*: a delete with `truncated: true` on any entry, or over `SNAPSHOT_MAX_BYTES`, is refused before `begin`'s write request, and still logged as `refused`; a non-delete over the cap is cut down to the addressed blocks' summaries with `truncated: true`; a pre-read failure refuses a delete and is stored as `before: {error}` on other writes.
- Create: `connector/test/fixtures/audit/*.json` (`getBlocks` summary and outline, outline with `truncated: true`, E2EE 409, `getPageOutline`, `getPage`, `getTag`, `getProperty`), with the keys `semantic_bulk_test.cljs` asserts.
- Create: `connector/test/audit-snapshot.test.ts`.

**Interfaces produced:** `SNAPSHOT_PLAN`, `snapshotClassFor`, `takeSnapshot`, `Snapshot`.

- [ ] **Step 1: Write the failing tests** (spec test 2 and the guard half of test 1):
  - `every write has a snapshot plan`: every non-read tool in `tools-manifest.json` plus the asset tools has a `SNAPSHOT_PLAN` entry; a fake name throws.
  - `delete subtree reads back`: `delete_blocks` on two blocks with the outline fixture; `AuditLog.get(id)` holds both blocks' markdown outlines in full, and the fake saw the `getBlocks?…&view=outline` request before the delete.
  - `truncated delete refused`: outline with `truncated: true` on the second entry answers `entry 1: <uuid> has more descendants than the 2,000-block snapshot budget; delete it in parts`; the fake's request log has no delete; the row is `refused` (review focus 5).
  - `oversized delete refused`: an outline over 256 KB, same refusal shape with the size.
  - `delete_page snapshot` and its `truncated` refusal on `getPageOutline`.
  - `E2EE delete keeps summaries`: the outline 409 falls back to summary with `e2ee: true`, and the delete goes ahead.
  - `missing UUID does not stop the call`: the pre-read lists a UUID under `missing`; the delete is sent; the row records the server's refusal (review focus 6).
  - `pre-read failure`: a 500 on the pre-read refuses a delete with `audit snapshot failed: …; nothing was deleted`, and on `update_block` stores `before.error` and proceeds.
  - `property and move snapshots`: `set_block_property`, `batch_move_blocks` and `update_property` store title, properties, `parent-id`, `order` (or the property's schema) from their fixtures.
  - `no pre-read for inserts, creates, assets or dry runs`: the fake's request log shows only the write.
  - `a write costs at most one extra request`: per tool, the fake sees at most one GET before the write.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.4. Read `markdown`, `block-count` and `truncated` by name (risk 2). Store the server's JSON text; parse once for the checks.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: "Before an update, move, property change or delete, what it overwrote is kept in the log. A delete whose subtree is over 2,000 blocks is refused; delete it in parts." The manifest is unchanged.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** ignore `truncated` and confirm the truncated test fails; take the snapshot after the write and confirm `delete subtree reads back` fails (the fake answers 404 after a delete); take a snapshot on dry runs and confirm the no-pre-read test fails; remove one `SNAPSHOT_PLAN` entry and confirm the guard fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): keep a before-snapshot of what each update, move or delete overwrote`. Body: one extra GET to the sync Worker per destructive write, no extra D1 rows, CPU bounded by the 256 KB cap.

**Done when:** each tool in §3.4's table stores the snapshot it names, block and page deletes either store the whole subtree or are refused naming the entry, and the gate is green.

---

### Stage 4: `get_activity_log`

**Goal:** a read-only tool that answers "what did Claude change this week" in one call, with page titles, breadcrumbs, snippets and reasons, filters, a cursor and optional snapshots, and records its own read cost. Lands acceptance 3 and acceptance 2 through the tool.

**Files:**
- Modify: `connector/src/audit/log.ts`: `query(graphId, {since, until, page, tool, session, status, limit, cursor, includeSnapshot})` as the §3.5 SQL (window and cursor in the inner query with `LIMIT QUERY_SCAN_CAP`, filters outside, `before` selected only with `includeSnapshot`), returning `{entries, nextCursor, scanned, rowsRead}`; `recordRead(graphId, alias, args, rowsRead)` inserting a `kind = 'read'` row.
- Create: `connector/src/tools/activity-log.ts`: input schema as §4; dates parsed in `config/settings.json`'s `timeZone`; the 92-day window refusal; `id` lookups; the plain-text summary (one line per entry, as §3.5, with `dry run`, `refused: <error>`, `error: <error>` and `outcome unknown` for `pending`), then the JSON.
- Modify: `connector/src/tools/spec.mjs` (`ANNOTATIONS.get_activity_log`: read-only, idempotent, not destructive, not open-world), `connector/src/mcp.ts` (register it beside the hand-written tools), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`), `connector/tools-manifest.json` (`npm --prefix connector run update:manifest`).
- Create: `connector/test/activity-log.test.ts`.

**Interfaces produced:** `registerActivityLogTool(server, {log, access, timeZone})`; the output shape in §4.

- [ ] **Step 1: Write the failing tests** (spec test 3 and the cost half of test 5):
  - `this week in one call`: entries seeded over 10 days, written through the real `audited()` path with fixture responses; the default call returns the last 7 days only, newest first, and each summary line carries the page title, breadcrumb, snippet and `Reason:`.
  - `filters`: page by UUID and by title in another case; `tool`; `session`; each `status` including `dry-run` and `pending` (shown as `outcome unknown`). "note" does not match "Notes" (review focus 8).
  - `cursor over a large window`: 1,200 rows in the window with 3 matches spread across it; paging with `next-cursor` finds all 3 and ends with `null`; no page reads more than 500 rows (`meta.rows_read`) (review focus 7).
  - `snapshots`: listings omit `before`; `include_snapshot: true` adds it; `id` returns one entry with its snapshot and reads 1 row; the Stage 3 delete's subtree reads back through the tool (acceptance 2).
  - `errors name the input`: bad `since`, a 93-day window, an unknown `id`, `limit` 201, an `id` from another graph.
  - `read rows`: each call adds one `kind = 'read'` row with its `rows_read`, 2 rows written; read rows never appear in listings.
  - `annotations and manifest`: `get_activity_log` is in the manifest with the §4 hints; `tools/list` on a server built as `mcpHandler` builds it includes it; it is not in `SNAPSHOT_PLAN` or `CONTEXT_TOOLS` because it is read-only.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.5 and §4. The cursor encodes `(at, id)` of the last row scanned.

- [ ] **Step 4: Contract.** `npm --prefix connector run update:manifest`. `CONNECTOR_HELP` gains §4's sentence: "Every write is logged with its reason; `get_activity_log` answers what changed and shows what an update, move or delete overwrote. Very large deletes are refused; delete in parts." Fold Stage 2's and 3's sentences into it so the guidance appears once.

- [ ] **Step 5: Run the gate:** `scripts/check.sh` (includes the tools-manifest check).

- [ ] **Step 6: Mutation check:** move the filters into the inner query and confirm the cursor test fails on rows read; use the last returned row as the cursor and confirm the selective-filter test misses a match; drop `kind = 'write'` and confirm read rows appear. Revert.

- [ ] **Step 7: Commit.** `feat(connector): add get_activity_log to read back what Claude changed`. Body: at most 500 rows read and 2 written per listing; 1 read and 2 written per id lookup.

**Done when:** one default call answers this week's changes readably, filters and the cursor work over windows larger than the scan cap, snapshots read back, each call records its cost, the manifest lists the tool, and the gate is green.

---

### Stage 5: Usage report covers the audit log

**Goal:** the usage report shows entries kept, entries today, rows written by the log, rows read by `get_activity_log`, snapshot and target bytes, and the connector database's size against 500 MB. Lands acceptance 5.

**Files:**
- Modify: `scripts/usage-report.mjs`: `fetchAuditLog({accountId, databaseId, token, now, fetch})` posts §3.7's aggregate through the D1 REST query API (`/accounts/{id}/d1/database/{db}/query`); `QUERY` gains `d1StorageAdaptiveGroups { max { databaseSizeBytes } }` filtered to the connector database; `formatReport` gains an *Audit log* section. With no database id set, the section says "skipped: CONNECTOR_D1_DATABASE_ID not set" and the report still exits on the existing rules. A 403 from the query API says the token needs D1 Read.
- Modify: `scripts/usage-report.test.mjs`.
- Modify: `.github/workflows/usage.yml` (pass `CONNECTOR_D1_DATABASE_ID` from a `production` variable) and `scripts/deploy-workflow.test.mjs` if it pins the workflow's env.
- Modify: README *Watching your usage* (the token needs **D1 Read**; set `CONNECTOR_D1_DATABASE_ID`; what the section shows).

- [ ] **Step 1: Write the failing tests** (spec test 8):
  - `audit section from a faked D1 response`: entries, today, rows written, rows read and bytes render as numbers.
  - `empty table`: `sum` columns come back null; the section prints zeros (review focus 10).
  - `database size`: from a faked GraphQL response, shown against 500 MB with its share.
  - `no database id`: the section is skipped with the reason and the rest of the report is unchanged.
  - `403 from the query API`: the message names D1 Read.
  - The workflow passes the variable.

- [ ] **Step 2: Run** `npm test` and keep the failures.

- [ ] **Step 3: Implement** as §3.7.

- [ ] **Step 4: Contract.** None for Claude. README as above.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** drop the `kind = 'read'` condition from the rows-read sum and confirm the section test fails; treat null as missing and confirm the empty-table test fails. Revert.

- [ ] **Step 7: Commit.** `feat(deploy): report the audit log's rows and the connector database's size`. Body: one D1 query a run from GitHub Actions, reading about `count(audit_log)` rows; none from the Worker.

**Done when:** the report shows the audit log's reads, writes and storage, degrades with a named reason when not configured, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 gains a paragraph on the audit log (what is logged, `Logged as audit entry <id>`, the refusals, best-effort snapshots, E2EE exception, 90-day retention, `get_activity_log`'s inputs) and §9's rollout notes (migration 0004 applies before the Worker deploys; the usage token's D1 Read permission and database id).
- **PR body:** the Logseq skill note (cite the audit entry id after a write; use `get_activity_log` for "what did you change" questions; delete very large subtrees in parts), the failures each new test showed before its stage's code, the commit the checks ran on, what `scripts/check.sh` skipped, and the outline-shape note above (risk 2). The PR is stacked on item 17's; it must merge after it (spec §9 step 1).
- **After deploy** (spec §9 steps 4 and 5): on a scratch page run `update_block`, `move_blocks`, `delete_blocks` (dry run, then real) and a refused call; check `get_activity_log` shows each with titles and the deleted subtree; check the next usage report's Audit log section and compare Worker requests before and after (risk 4).
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 2 changes Stage 3's delete rule; question 3 adds an E2EE refusal in Stage 3; question 4 changes Stage 2's `client`; question 5 changes `before`'s storage in Stages 1 and 3; question 6 drops `recordRead` in Stage 4 and the rows-read figure in Stage 5; question 7 changes the default in Stage 1. Question 1 (digest) would be its own item. Any change lands before the PR merges.
