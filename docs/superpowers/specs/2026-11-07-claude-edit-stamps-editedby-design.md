# Mark Claude's edits in the graph: `editedBy` stamps and a Claude Activity page: design

Date: 2026-11-07
Issue: Connector #29 (mark Claude's edits in the graph: editedBy property and Claude Activity page). Labels: enhancement, observability. Pairs with item 28.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0033 applied. This work is patch 0034.
Branch: stacked on Phase 3 (`claude/relaxed-maxwell-s4r8o4-phase3`), after item 17 (patch 0028, `connector/src/tools/readable.ts`) and item 28 (migration 0004, `connector/src/audit`), neither merged yet.

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. Ideas taken from the design panel's other proposals are marked **(graft)**. The owner can overturn any of them; the ones most worth a second look are in section 11.

This is a feature, so the spec states no bug cause. The code facts in section 2 were checked by reading the patched tree in `.upstream/` at this branch's HEAD (`1bda9e2`), not by running it. Where a fact is still unchecked it says so and the build's first stage checks it (section 9).

## 1. Goal

Let the owner see, while browsing in Logseq, which blocks Claude created or last changed. Item 28's audit log answers "what did Claude change" from a chat, but it lives in D1, outside the graph.

1. Every block the connector creates or changes is stamped `editedBy` = `claude` and `claudeEditedAt` = the write's time, in the same transaction as the write **(issue)**.
2. A **Claude Activity** page lists stamped blocks, newest first, with a last-day and a last-week view **(issue)**.
3. Both properties are hidden in normal block view **(issue)**.
4. A per-graph setting turns stamping off; existing stamps stay **(issue)**.

Acceptance (issue):

1. A block written through the connector carries `editedBy` claude and `claudeEditedAt`.
2. The Claude Activity page lists it straight away.
3. The properties do not clutter normal block view.
4. Stamping adds no extra calls against the ~20 writes a minute limit.
5. Turning the setting off stops stamping and leaves existing stamps alone.

## 2. Context

**Why the connector alone can't do it.** Only the BlockTree inputs (`insert_block_tree`, `insert_block_children`, `batch_insert_block_trees`, `capture_to_today`) take `properties`. `update_block` takes only `title`, and the property, move and batch-move tools take no extra properties, so stamping them from the connector would be a second rate-limited write, which acceptance 4 rules out. The stamp has to be added on the server, inside the write's own transaction.

**One choke point on the server.** Every semantic write goes through `authored-write!` (`.upstream/deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs:1359`), either directly (create page, save block, batch set and remove property, create task, capture's `ensure-today-page!` and insert, at `:1913`, `:1957`, `:2108`, `:2251`, `:2314`, `:2335`, `:2477`, `:2640`, `:2714`, `:2723`) or through `atomic-write!` (`:1890`, used for inserts, saves, deletes, moves, property removal, property and tag upserts and the batch routes at `:3974` to `:4014`). `authored-write!` already runs the mutation and an authorship transaction (`created-by-tx`, `:1332`) inside one `ldb/batch-transact-with-temp-conn!` call, so both land with one tx id. A dry run passes `dry-run-conn`, a throwaway copy, so anything added there is discarded with it.

**The actor header.** `request-creator` (`:1325`) builds the creator map from `x-logseq-sync-actor`. `dispatch.cljs:61-67` copies the incoming request with `platform/request` and overwrites only that header, so any other header the connector sends reaches the DO. (Read, not run; the build's first stage checks it with a test, section 8.)

**Moves don't re-key siblings.** The panel's safety judge cited `semantic.cljs:3191-3193` as move code that re-keys many blocks' `:block/order`. Those lines are in the property update handler and re-key a property's closed values (choices), not blocks. The outliner's `move-block` (`deps/outliner/src/logseq/outliner/core.cljs:1414-1442`) writes `:block/parent` and `:block/order` for the moved block only, `:block/page` for its children when the page changes, and `:block/updated-at` for the source and target pages. Inserts key only the inserted blocks (`core.cljs:735-744`). So siblings of a moved or inserted block get no datom at all, and a same-parent move changes only the moved block's `:block/order`. Section 3.2 uses this.

**Hiding a property.** `:logseq.property/hide?` on a property is the "Hide this property" flag. `property-with-position?` (`deps/outliner/src/logseq/outliner/property.cljs:1153`) leaves such a property out of a block's property area. `update_property` can't set it (the handler allows only some flags, and on built-ins only hide-empty-value and description), so the patch must set it when it creates the property. `entity-util/hidden?` (`deps/db/src/logseq/db/frontend/entity_util.cljs:69`) is then true for the property entity, which also drops it from the semantic API's `list_properties`. (It does not drop it from `get_block`, which lists every user property; Stage 2 leaves the two stamp idents out of the reads by name, section 12.)

**The semantic index.** The indexer embeds a block only when its document hash changes (`connector/src/semantic/indexer.ts:150`), and the document holds no properties (`connector/src/semantic/document.ts`). A stamp always rides with a real change in the same transaction. So stamps cost no extra neurons, whether or not they touch `:block/updated-at`.

**Connector side.** `Graphs.resolve()` (`connector/src/graphs.ts:119`) reads one `graphs` row by primary key for every tool call. `graphFetch` (`connector/src/tools/semantic.ts:99`) is the one path every generated tool and the asset tools (`connector/src/tools/assets.ts`) use, and `SyncRequest` already has `headers` (`connector/src/sync.ts:15`). The wizard's graph edit form posts to `editGraph` (`connector/src/wizard/routes.ts:240`), which saves through `Graphs.update`.

**Learnings that shape this design.**

- `docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`: the stamp must share the write's one tx id.
- `docs/solutions/sync/order-key-not-seeded-for-server-writes.md`: the Activity page's query blocks need order keys after the seeded max.
- `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`: a handler that writes outside `authored-write!` would silently not stamp; the tests cover every write route.
- `docs/solutions/api/title-resolves-outside-allowed-values.md`: the `claude` choice is found by its fixed UUID among the property's own closed values, never by title.
- `docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`: refusals still answer 4xx naming the entry, with no stamp left behind.
- `docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`: item 28's snapshots and targets are not changed by the stamp; the audit entry describes the caller's change, not the stamp.
- `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`: the setting rides on the row `resolve()` already reads, so no new statement.

## 3. Design

**Approach (call).** One hook in `authored-write!`, switched on by a request header the connector sends when the graph's setting is on. The header is the only connector change on the request path; `audited()` and item 17's helpers are untouched.

Rejected:

- **Connector-side second write.** A `batch_set_block_property` after each write. Breaks acceptance 4, has a gap between write and stamp, and can't stamp in the same tx.
- **Explicit setup step and opt-in default (the panel's "safety" design).** A setup route, a `configure_edit_stamps` MCP tool, read-back fields in every write response and a 409 on schema drift. Sound, but size L, it lets Claude turn its own stamps off, and it widens the contract surface for a Low-priority issue. Its target-rule care, ident lookup and decoy check are grafted below.
- **`config/settings.json` for the switch.** It is repo-wide and needs a deploy to change; the issue asks for a per-graph setting the owner can flip.

### 3.1 Layout

| Path | Change |
|---|---|
| `patches/0034-semantic-claude-edit-stamps.patch` | `request-creator` reads `x-logseq-edit-stamp`; `stamp-tx` and `ensure-stamp-schema!` in `semantic.cljs`; the stamp-property write refusal; db-sync tests. |
| `connector/migrations/0005_graph_edit_stamps.sql` | `ALTER TABLE graphs ADD COLUMN edit_stamps INTEGER NOT NULL DEFAULT 1`. |
| `connector/src/graphs.ts` | `resolve()` and `RECORD_COLUMNS` select `edit_stamps`; `ResolvedGraph.editStamps`, `GraphRecord.editStamps`; `GraphPatch` takes it. |
| `connector/src/tools/semantic.ts` | `request()` adds the header on non-GET calls when `editStamps` is true. |
| `connector/src/tools/assets.ts` | The asset write path does the same. |
| `connector/src/wizard/routes.ts`, `views.ts` | A "Mark Claude's edits in the graph" checkbox on the edit form. |
| `connector/src/tools/handwritten.ts` | `connector_help` text (section 4). |
| `connector/src/tools/semantic.ts` (`HINTS`) | One shared sentence on the stamping tools (section 4). |
| `connector/tools-manifest.json` | Regenerated with `update:manifest` if it carries descriptions. |
| README §11.8 | Contract text. |

### 3.2 Patch 0034: the stamp

1. **The flag.** `request-creator` also reads `x-logseq-edit-stamp`. Only the exact value `claude` is accepted, and the header is ignored on E2EE graphs (the choice title and page would be plaintext in an encrypted graph). The creator map gains `:stamp? true`, so no handler signature changes.
2. **Targets.** In `authored-write!`, after the authorship datoms and in the same `tx-conn`, `stamp-tx` runs over `before`, `@tx-conn` and `@tx-data` when `:stamp?` is set. An entity is a target when:
   - in the after-db it has `:block/uuid` and `:block/page`, and it is not a page, tag, property, closed value (`:block/closed-value-property`) or property value block (`:logseq.property/created-from-property`); and
   - an added datom on it has an attribute in the **qualifying set**: `:block/title`, `:block/parent`, `:block/order`, `:block/tags`, `:block/link`, or a property attribute (`:user.property/*`, `:logseq.property/*`, `:plugin.property/*`) other than the two stamp attributes, `:logseq.property/created-by-ref` and the derived ones; or a retracted datom on it has a property attribute (so `delete_block_property` stamps the holder).

   Not qualifying: `:block/page` (children carried by a cross-page move), `:block/refs`, `:block/path-refs`, `:block/updated-at`, `:block/created-at`, `:block/tx-id` and the stamp attributes themselves.

   **Order-only changes (graft, adapted).** The safety and cost judges asked that order-only changes be excluded so re-keyed siblings aren't stamped. Section 2 shows the outliner never re-keys siblings, and a same-parent move changes only the moved block's `:block/order`, so excluding order-only changes would miss real moves. Instead `:block/order` qualifies, and a test pins that siblings of a moved, inserted and reordered block carry no stamp, with a mutation that adds a sibling re-key (section 8). If a future upstream re-keys siblings, that test fails.
3. **The datoms.** Each target gets `[:db/add e :user.property/claude-editedBy <choice id>]` and `[:db/add e :user.property/claude-editedAt now-ms]`, transacted in the same `tx-conn`, so they share the write's tx id. Deleted blocks have no entity in the after-db and are not stamped (item 28 covers deletes).
4. **Schema, once per graph.** `ensure-stamp-schema!` runs in the same `tx-conn` before `stamp-tx` when `:stamp?` is set and the schema is missing:
   - `:user.property/claude-editedBy`, title `editedBy`, type `:default` with one closed value `claude` that has a fixed UUID (derived once and written in the patch), cardinality one, `:logseq.property/hide? true`.
   - `:user.property/claude-editedAt`, title `claudeEditedAt`, type `:datetime`, `:logseq.property/hide? true`.
   - The fixed idents skip upstream's random ident suffix on purpose, so every write can find them. The build checks that db validation accepts a `:user.property/` ident without the suffix; if it doesn't, the fallback is a `:plugin.property.claude/` namespace.
   - **Lookups by ident and UUID (graft).** The choice is found by its fixed UUID and must have `:block/closed-value-property` equal to the `editedBy` property; never by title.
   - **Conflicts refuse (graft).** If either ident is held by something other than a property of the right type with cardinality one, the choice UUID is held by anything but an `editedBy` choice, `editedBy` has another `claude` choice while the fixed one is missing, or a different property already holds the title `editedBy` or `claudeEditedAt` (compared as `:block/name`; pages and tags don't count), the write answers 409 before anything is transacted: `edit stamps: property editedBy (<ident>) is not the stamp property; rename it or turn off "Mark Claude's edits" for this graph`. This stops the stamp writing into an owner's decoy property. The owner can always unblock writes by turning the setting off in the wizard. A missing choice is not a conflict: it is re-added under its fixed UUID (as built, section 12).
   - If the owner deleted the properties, the next stamped write recreates them, hidden again. If the owner unhid one, `hide?` is not re-asserted on later writes (graft from the cost design).
5. **The Claude Activity page.** In the same step, if no page, tag or property holds the title "Claude Activity" (compared by `:block/name`), the patch creates the page with two query blocks: last day and last week, each an advanced query for blocks whose `editedBy` is the `claude` choice and whose `claudeEditedAt` is within the window, sorted by `claudeEditedAt` descending, as a table. Their order keys come after the seeded max (gotcha 1). If the title is taken, the page is skipped and stamping goes on; `connector_help` says how to recreate it (rename the other page, then make any connector write). The page itself is a page, so it carries no stamp. The query text is pinned against `UPSTREAM_REF` in a db-sync test and checked in the app (risk 3).
6. **What the response says.** Nothing changes in responses. The handler builds its response from its own result, so the schema and page are not reported as the caller's change, and item 17's targets and item 28's audit entry describe only what the caller asked for. A test pins this for the first stamped write.
7. **No forged or cleared stamps (graft from the safety design).** `set_block_property`, `batch_set_block_property`, `delete_block_property` and `batch_delete_block_property` refuse the two stamp properties, naming the entry: `entry 0: editedBy is set by the server and can't be written`. This holds with or without the header, so neither Claude nor another API client can mark a block as Claude's or remove the mark through the semantic API. The owner can still edit or delete them in the app.

### 3.3 Later edits in the app (issue decision)

**The stamp stays (call).** App edits reach the server through sync, not the semantic handlers, and clearing the stamp there would be a much larger patch in the sync path. So `claudeEditedAt` means "last changed by Claude", and Logseq's own updated-at still shows later edits. A later write through the connector moves `claudeEditedAt` forward. `connector_help` and README §11.8 say so.

### 3.4 Connector

1. **Migration 0005** adds `edit_stamps INTEGER NOT NULL DEFAULT 1`, so stamping is on for existing graphs after deploy (section 11, question 1).
2. **`Graphs.resolve()`** selects `edit_stamps` in the statement it already runs; `ResolvedGraph` gains `editStamps: boolean`. `RECORD_COLUMNS` gains it for `list`/`get`, so the wizard shows the current value.
3. **The header.** `request()` adds `x-logseq-edit-stamp: claude` to `graphFetch`'s `headers` when `req.method !== "GET"` and `graph.editStamps`. The asset write path does the same. Item 28's snapshot pre-reads are GETs and carry no header.
4. **The switch** is a checkbox, "Mark Claude's edits in the graph", on the wizard's existing edit form, saved by `editGraph` through `Graphs.update`. It is not an MCP tool, so Claude can't turn its own stamps off **(graft, judged)**. Turning it off stops the header; existing stamps, the properties and the Activity page stay as they are.

## 4. Tool contract

No tool is added, removed or renamed, and no input schema changes.

- **Descriptions.** The stamping tools (`insert_block_tree`, `insert_block_children`, `batch_insert_block_trees`, `capture_to_today`, `create_task`, `update_block`, `set_block_property`, `batch_set_block_property`, `delete_block_property`, `batch_delete_block_property`, `move_blocks`, `batch_move_blocks`, `refresh_refs`, `save_document`, `save_file_from_url` where the asset write creates a block) gain one shared sentence through `HINTS`: "When edit stamps are on for the graph, each block this call creates or changes is stamped editedBy=claude and claudeEditedAt (hidden properties, listed on the Claude Activity page)." Section 11, question 4 asks whether this should live only in `connector_help`, as item 17 and item 28 chose, to keep `tools/list` small.
- **New refusal.** The property tools refuse `editedBy` and `claudeEditedAt` (3.2 step 7). A write can answer 409 for a conflicting stamp property (3.2 step 4).
- **`connector_help`** gains a short section: what is stamped (blocks, not pages, tags or properties; not deletes), that the stamp survives the owner's later edits, that E2EE graphs are not stamped, that the owner turns it off in the wizard, and how to recreate the Activity page.
- **README §11.8** and the PR's **Logseq skill note** get matching text. The skill note tells the owner's skill not to set `editedBy` or `claudeEditedAt` by hand, and to point the owner at the Claude Activity page (in the app) or `get_activity_log` (in chat) for "what did Claude change".
- **Server API.** A new optional request header `x-logseq-edit-stamp: claude`. Responses don't change. Stamped blocks show the two properties only where hidden properties are shown today; the semantic API's `get_block` leaves them out (section 2).

## 5. Cost on the Free plan

| Per write call | Change |
|---|---|
| Worker requests | 0 extra; the header rides on the existing request |
| Rate-limited writes | 0 extra (acceptance 4) |
| D1 rows read | 0 extra; `edit_stamps` is a column of the row `resolve()` already reads by primary key (pinned by a `meta.rows_read` test) |
| D1 rows written | 0 |
| Workers AI neurons | 0; the document hash ignores properties (section 2) |
| DO datoms | 2 per stamped block, so a 100-block tree adds 200 datoms to one tx |
| CPU on the DO | one pass over the tx's datoms; no extra query per block |

Once per graph: about 30 datoms for the two properties, the closed value and the page with two query blocks. Migration 0005 is a one-time ALTER on a table of a few rows. Daily totals against 100k requests, 5M rows read, 100k rows written and 10k neurons are unchanged. The connector's 10 ms CPU budget gains one header set.

## 6. Safety

- **Same transaction.** The stamp shares the write's tx id; a refused or failed write leaves no stamp, and a dry run's stamps are discarded with its throwaway connection.
- **Labels, not proof.** Any PAT holder can send the header; it only marks their own write as Claude's. The docs say the stamp is a label.
- **No forging through the API.** Property writes naming the stamp properties are refused (3.2 step 7).
- **No writing into a decoy.** A conflicting property refuses the write with a 409 naming it and the way out (3.2 step 4).
- **Claude can't turn stamping off.** The switch is in the wizard only.
- **E2EE.** Not stamped; documented, not refused.
- **Guards unchanged.** Closed-value, private-tag, `acknowledge-*` and dry-run behaviour stay as they are; tests check they still refuse with the entry named.

## 7. Risks

1. **New trusted logic in every write.** The target rule must leave out pages, tags, properties, closed values and property value blocks, and still catch moves and property deletes. A handler writing outside `authored-write!` would silently not stamp; the route-by-route test (8.1) catches it.
2. **Hidden properties in queries.** `hide?` makes `entity-util/hidden?` true for the property. Advanced queries over the idents should still return rows, but simple `(property …)` queries and the property picker may skip it. Checked in the app at stage 1. Fallback: `hide-empty-value` plus `:logseq.property/ui-position :block-below`, accepting a compact visible property (section 11, question 2).
3. **Query text across Logseq versions.** Time inputs (`:-1d`, `:-7d`) and advanced-query syntax differ between DB versions. The text is pinned against `UPSTREAM_REF` and checked in the app; the fallback is a sorted table with no time window.
4. **Fixed idents.** `:user.property/` idents without the random suffix may fail db validation; fallback `:plugin.property.claude/`.
5. **Lazy schema in a content write** makes the first stamped write's tx larger and adds a page the caller didn't name. Responses don't report it (3.2 step 6), but the sync log will show it.
6. **409 on a conflicting property** blocks every connector write on that graph until the owner renames it or turns stamping off. Deliberate; the message names both ways out.
7. **Upstream bumps.** The hook sits in `authored-write!`, which patches 0011 and 0026 to 0028 also touch; `bump-upstream` may conflict there.
8. **Unchecked: header survives dispatch and the DO hop.** Read, not run; 8.1 tests it end to end.

## 8. Testing

Each test is first run against the code without the change and seen to fail; the failure is quoted in the PR.

**8.1 Upstream db-sync suite (patch 0034): real handlers, real outliner, no stubs.**

- Every write route with `x-logseq-edit-stamp: claude`: insert tree, insert children, batch insert, capture, create task, update block, set, batch set, delete and batch delete property, move (same parent and new parent, same page and cross-page), batch move, `refresh_refs` apply, and the asset write. Each touched block reads back with `editedBy` = the `claude` choice and a `claudeEditedAt` inside the call's time window, and the stamp datoms share the write's tx id.
- **Not stamped:** siblings of a moved, inserted and reordered block; children carried by a cross-page move; pages, tags, property entities, closed values and property value blocks. A mutation that adds a sibling re-key to the move, or drops the property-value exclusion, makes a test fail.
- Without the header nothing is stamped; a header value other than `claude` is ignored; a dry run leaves no stamp; an E2EE graph is not stamped.
- **Schema:** the first stamped write creates both properties (hidden, choice holding `claude` by the fixed UUID, datetime) and the Activity page once; a second creates nothing; a taken "Claude Activity" title is left alone and the write still stamps; deleted properties are recreated; an unhidden property stays unhidden; a decoy `editedBy` property, a wrong-type ident and a choice UUID under another property each answer 409 with nothing transacted.
- **Responses:** the first stamped write's response is byte-for-byte what it is without the header.
- **Refusals:** a private-tag and a closed-value refusal still answer 4xx naming the entry and leave no stamp. Property writes naming `editedBy` or `claudeEditedAt` are refused naming the entry, with and without the header.
- **Query:** the pinned query text, run against the db, returns a just-stamped block first and leaves out one stamped eight days ago from the week view.
- **Dispatch:** a request through `dispatch` carrying the header reaches the DO handler with it.

**8.2 Connector vitest (workers pool, real D1).**

- Migration 0005 defaults `edit_stamps` to 1.
- `Graphs.resolve()` returns `editStamps`, and D1 `meta.rows_read` is still 1.
- **Every write tool sends the header (graft).** A test parametrised over `tools-manifest.json`'s non-read tools, plus `save_document` and `save_file_from_url`, calls each with `editStamps` on and asserts the header reaches the `SYNC` binding stub; with it off, asserts it doesn't. GET calls, including item 28's snapshot pre-reads, never carry it. This catches a `graphFetch` call site that drops the header.
- The wizard checkbox saves through `Graphs.update` and shows the current value; unticking it stops the header on the next call.
- `audited()` entries for a stamped write are unchanged.

**8.3 Manual check in the Logseq app**, recorded in the PR: the properties are hidden in block view; both Activity queries list a just-written block, newest first; a moved block appears; the owner editing a stamped block keeps the stamp.

**Gate:** `scripts/check.sh --upstream` on HEAD.

## 9. Rollout and verification

1. **Stage 1 (checks before code).** In the db-sync test harness: that the header survives dispatch, that fixed `:user.property/` idents validate, that a `hide?` property is still matched by an advanced query, and which query time inputs `UPSTREAM_REF` supports. Each result goes into this spec's "As built" notes; a failed check switches to the named fallback.
2. Patch 0034 with its tests, then migration 0005 and the connector change, then the wizard, then contract text.
3. Merge items 17 and 28 first. Merging to main applies migration 0005 before deploying the Worker; the sync server deploys with the patch in the same workflow. If the Worker deploys before the sync server, the header is ignored and nothing breaks.
4. After deploy, on a scratch page: insert a block, update another, move one, set and delete a property. Check each carries the stamp (in the app with hidden properties shown), the Activity page lists them newest first, and block view shows no extra properties. Untick the wizard box, write again, and check the new block has no stamp and the old ones still do.
5. Compare the next usage report's Worker requests and D1 rows with the day before; they should not move.
6. The PR's verification section names the commit the checks ran on and what `scripts/check.sh` skipped.

## 10. Out of scope

- Deleted content and prior text (item 28's audit log covers them).
- Stamping pages, tags and properties.
- Clearing or updating the stamp when the owner edits in the app.
- E2EE graphs.
- A `get_claude_activity` tool; `get_activity_log` answers in chat.
- An MCP tool for the setting.

## 11. Open questions for the owner

1. **Default.** On for every graph after deploy (this design), or off until you tick the box in the wizard?
2. **Hidden or compact.** If a hidden property drops out of simple queries or the property picker in the app, is a visible but compact property (hide when empty, shown below the block) acceptable, or should the Activity page rely on advanced queries only?
3. **Stamp after your edits.** Keep the stamp when you edit a Claude-stamped block in the app (this design), or is clearing it worth a larger patch in the sync path?
4. **Where the contract text lives.** One sentence on each stamping tool's description (this design), or only in `connector_help`, as items 17 and 28 did, to keep `tools/list` small?
5. **Conflicts.** Refuse every write with a 409 when an `editedBy` property that isn't the stamp property exists (this design), or skip stamping and say so in the result?
6. **Activity page title taken.** Skip the page quietly when you already have a "Claude Activity" page (this design), or refuse the first stamped write until the title is free?

## 12. As built

Notes from the build, newest stage last. Each says what was checked and how.

### Stage 1: the flag, the schema and the checks before code

**Probes (section 9, step 1),** each a test in `semantic_edit_stamps_test.cljs`, run against `UPSTREAM_REF` with patches 0001 to 0034:

1. **The header survives dispatch** (`header-survives-dispatch-test`). A `PATCH` through `dispatch/handle-worker-fetch` carrying `x-logseq-edit-stamp: claude` and a spoofed actor reaches the DO with the stamp header unchanged and the actor header rewritten from the token's claims, and the DO's real handler creates the schema. Risk 8 is closed.
2. **Fixed `:user.property/` idents validate** (`fixed-user-property-ident-validates-test`). `upsert-property!` given `:user.property/claude-editedBy` keeps the ident without a random suffix, `upsert-closed-value!` keeps a caller-chosen UUID, and `validate-db` reports no errors for the two properties and the choice. The `:plugin.property.claude/` fallback is not needed (risk 4 closed).
3. **A `hide?` property still matches an advanced query** (`hidden-property-still-matches-an-advanced-query-test`). With `:logseq.property/hide? true` on both properties, a raw datalog query over the idents and the query DSL's `property` rule both return the stamped block. Neither rule reads `hide?`. Whether the app's simple-query builder and property picker list a hidden property is still for the manual check in the app (risk 2, section 8.3).
4. **Query time inputs** (`query-time-inputs-test`, `logseq.db.frontend.inputs/resolve-input`). `:-1d`, `:-7d`, `:today` and the deprecated `:1d-before` resolve to a `YYYYMMDD` day, for journal days. `:-1d-ms`, `:-7d-ms`, `:right-now-ms`, `:start-of-today-ms` and `:1d-before-ms` resolve to epoch milliseconds, which is what `claudeEditedAt` holds, so Stage 3 uses `:-1d-ms` and `:-7d-ms`. They are local midnight 1 and 7 days back (`[0 0 0 0]` for a backward offset), not a rolling 24 hours: the "last day" view runs from yesterday 00:00 and the "last week" view from 00:00 seven days back, in the zone of whoever runs the query (the app resolves inputs where the query runs). There is no hour unit (`:-1h-ms` comes back unresolved). Risk 3 stands only for the app check.

**Choices made while building:**

- **The flag.** `request-creator` sets `:stamp? true` only when a creator is built from the actor header, the graph isn't E2EE, and every `x-logseq-edit-stamp` value is exactly `claude` (`Headers` joins repeats with `", "`, so `claude` sent twice flags, and `claude` with any other value doesn't). `Headers` trims whitespace around a value before the handler sees it, so ` claude` can't be told apart from `claude` and flags too (review focus 2 asked for it to be ignored; it can't be).
- **Where the conflict check runs.** `authored-write!` checks the graph before the mutation (so a conflict refuses before the write runs, and even a flagged rename of the decoy is refused; the owner renames it in the app or turns stamping off), and checks again on the write's own result inside the `tx-conn` (so a call that would itself make a decoy, such as creating a property titled `editedBy`, is refused whole). The refusal is thrown and answered as a 409 by `handle`; the asset upload route, which catches every error as a 500, passes it through and still removes the uploaded file.
- **A deleted choice is re-added,** under the fixed UUID, in the write's transaction (plan review focus 4), rather than refused as the spec first said. A refusal is kept for an `editedBy` that already has another `claude` choice, since re-adding would collide with it.
- **Deleting the properties in the app.** `outliner-page/delete!` won't delete a hidden property, so the owner unhides it first. The next flagged write recreates whatever is missing, hidden again. A property the owner unhid and kept stays unhidden.
- **Authorship.** The schema is created after the authorship datoms, so `created-by-ref` describes only what the caller's write created.

**Cost.** A few dozen datoms once per graph (two properties and the choice); per flagged write, two ident lookups, one UUID lookup and two `:block/name` index reads, before and again after the mutation. No Worker request, D1 row or neuron.

### Stage 2: the stamp and the refusal

**What is stamped.** `stamp-tx` runs in `authored-write!`'s `tx-conn`, after the authorship datoms and `ensure-stamp-schema!`, over the write's `tx-data`, and its datoms are transacted there, so they share the write's tx id. Each entity gets two datoms however many of its datoms qualify. A datom qualifies when:

- it adds `:block/title`, `:block/parent` or `:block/order`; or
- it adds or retracts `:block/tags`, or a property attribute: one whose namespace contains `.property`, which is upstream's own test in `db-property/property?` (`user-property-namespace?`). That covers user (`user.property`), library (`schema.property`), plugin (`plugin.property.*`) and every built-in namespace (`logseq.property`, `logseq.property.code` and the rest).

An entity is a target when, in the after-db, it has `:block/page` and no `:logseq.property/created-from-property`.

**Changes from section 3.2, each found by a test or a mutation:**

- **Tags removed by retraction stamp the block.** `delete_block_property` on Tags and a reset to fewer tags only retract `:block/tags`. With the spec's set (tags qualifying only when added) the block wasn't stamped, though 3.2 says a property delete stamps its holder. `:block/tags` now qualifies both ways, as a property attribute does.
- **Property attributes by upstream's rule, not three namespaces.** A library property (`schema.property/genre`) and a built-in in a sub-namespace (`logseq.property.code/lang`) changed the block without stamping it under `user.property/*`, `logseq.property/*` and `plugin.property*`.
- **Dropped as unreachable.** Mutations showed these rules change no outcome, so they were removed: `:block/link` (no write changes it alone), the `:block/uuid`, page, tag, property and closed-value checks (pages, tags and properties have no `:block/page`; closed values carry `created-from-property`), and the exclusion of the stamp attributes and `created-by-ref` (stamps are added after `tx-data` is read; `created-by-ref` is only added to a block whose UUID or first title is added in the same write). Tests pin each outcome: `createPage`, `createTag`, `createProperty` with choices and the schema's own choice are never stamped.
- **Reads leave the stamps out by ident.** `hide?` doesn't drop a property from `get_block`, `get_blocks` or `get_page_outline` (they list every user property). `shown-property?` now leaves out the two stamp idents, and only those: a property the owner hides is still listed.
- **`now`** is read once per flagged write, in `authored-write!`; the authorship datoms keep their own clock read.

**The refusal.** `set_block_property` and `delete_block_property` answer 400 `entry 0: editedBy is set by the server and can't be written` (or `claudeEditedAt`) once the property resolves to a stamp ident, by title, ident or UUID, with or without the header. In `batch_set_block_property` and `batch_delete_block_property` the check is in `batch-entries-error`, so the first refused entry is named and nothing is written. A property whose title only starts like a stamp property (`editedByMe`), re-sends, resets and other property writes on a stamped block still succeed, and the stamp survives them.

**Not stamped, out of scope.** `delete_page`, `delete_tag` and `delete_property` write through `outliner-page/delete!` outside `authored-write!`, so their holders, which lose a tag or a value, are not stamped (they get no authorship either). Insert inputs (`properties` on a BlockTree node) can still name the stamp properties; on a flagged write the stamp overwrites them, on an unflagged one they stay. Both are backlog items.

**Mutation check** (one line each, in a scratch copy): leaving out `:block/title`, `:block/parent`, `:block/order`, tag retractions, property attributes, property retractions, the `:block/page` check or the value-block exclusion, transacting the stamp outside the `tx-conn`, or removing the refusal from the single set, the single delete or the batch check each fails a test. `:block/parent` survived until a test moved a block whose new order key equals its old one.

**Cost.** Two datoms per stamped block and one pass over the write's datoms, with an entity read for each distinct entity a qualifying datom names. No query per block, no Worker request, D1 row or neuron.

### Stage 3: the Claude Activity page

**What is created.** `ensure-activity-page!` runs in `authored-write!`'s `tx-conn` on a flagged write, after the stamps are transacted (so the page's own blocks are never stamped), and only when nothing holds the `:block/name` `claude activity`. It creates the page with `outliner-page/create!` and two blocks, "Edited by Claude since yesterday" and "Edited by Claude in the last 7 days", each made as the app's advanced-query command makes one: tagged Query, the query text in the `:logseq.property/query` value block shown as code (`display-type :code`, `lang clojure`), plus `table/sorting` `[{:id :user.property/claude-editedAt :asc? false}]`. The query block is the view the app's table reads its sorting from (`query/view.cljs` passes the block's UUID), so newest first comes from the view, not the query. The view is a table because that is View Type's default; setting it explicitly changed no outcome (a mutation removing it survived), so it was dropped. Everything shares the write's tx id; a second flagged write adds nothing.

**The query text** (pinned in `semantic-edit-stamps-test`; the week view differs only in `:-7d-ms`):

```clojure
{:query [:find (pull ?b [*])
         :in $ ?since
         :where
         [?b :user.property/claude-editedBy ?by]
         [?by :block/uuid #uuid "3072a652-18e8-4dcb-bb37-e1aa38c8e3e9"]
         [?b :user.property/claude-editedAt ?at]
         [(>= ?at ?since)]]
 :inputs [:-1d-ms]
 :remove-block-children? false}
```

The choice is matched by its fixed UUID, never its title. `:remove-block-children?` is false so a stamped child of a stamped block is listed too. With the inputs Stage 1 recorded, the day view runs from local midnight yesterday and the week view from local midnight seven days back: a block stamped now, 23 hours or exactly 24 hours ago is in both, six days ago only in the week view, eight days ago in neither. The test runs the stored text as the app's `execute-custom-query` does (read, resolve inputs, `d/q`) and orders the rows with `logseq.db.common.view/get-view-data` over the query block, under UTC, Los Angeles and Auckland.

**Order keys.** The two blocks are keyed with `db-order/gen-key` after the graph's max key (seeded by `handle`) and inserted with `:keep-block-order? true`; inserting into the empty page without it would key them `a0` and `a1`, below an existing high key.

**A taken title.** Anything holding the `:block/name` (a page whose title differs only in case, a page, a tag, a property) skips the page step, and the write still stamps. A block titled Claude Activity doesn't hold a name and doesn't count. A Claude Activity page in the recycle bin still holds its name, so the page isn't recreated while it is there; the owner restores it or empties the bin (stage 4's `connector_help` text should say so).

**Mutation check** (one line each, in a scratch copy): no title check, comparing `:block/title` instead of `:block/name`, no kept order, ascending sort, creating the page before the stamps, no Query tag, no code display, the week query using `:-1d-ms`, dropping the choice clause or the window clause, and creating the page on unflagged writes each fail a test.

**Cost.** About 40 datoms once per graph (the page, two blocks and their two query value blocks with their properties); per flagged write, one `:block/name` index read. No Worker request, D1 row or neuron.
