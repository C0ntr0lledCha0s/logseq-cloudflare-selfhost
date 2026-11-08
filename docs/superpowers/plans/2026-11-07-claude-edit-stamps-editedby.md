# Mark Claude's edits in the graph: `editedBy` stamps and a Claude Activity page: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in the patch stages, `scripts/check.sh` in the connector stages), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every block the connector creates or changes is stamped `editedBy` = `claude` and `claudeEditedAt` = the write's time, in the write's own transaction, with no extra request, D1 row or rate-limited write. Both properties are hidden in block view. A **Claude Activity** page lists stamped blocks newest first, with a last-day and a last-week view. A per-graph wizard checkbox turns stamping off and leaves existing stamps alone.

**Architecture:**
- **One upstream patch, `patches/0034-semantic-claude-edit-stamps.patch`,** on top of 0001 to 0033, built over Stages 1 to 3. `request-creator` reads `x-logseq-edit-stamp`; `authored-write!` (`semantic.cljs:1359`) runs `ensure-stamp-schema!`, the Activity page step and `stamp-tx` in the same `tx-conn` as the mutation and its authorship datoms, so all share one tx id. No new route and no OpenAPI change, so the vendored API and the manifest's names, methods and paths do not change.
- **Each patch stage regenerates 0034 as a whole** from a baseline at 0033 (the patch is unmerged, so amending it is allowed; `add-upstream-patch` *Rules*). After stage N the patch holds Stages 1 to N.
- **The connector** (Stages 4 and 5): migration `0005_graph_edit_stamps.sql`, `editStamps` on the row `Graphs.resolve()` already reads, the header on non-GET `graphFetch` calls from `request()` and the asset write, and a checkbox on the wizard's edit form. `audited()` (item 28) and `readable.ts` (item 17) are untouched.
- **Order:** the switch and the schema first (nothing is stamped yet), then the stamp itself, then the Activity page, then the connector sends the header, then the owner's switch and the contract text. Until Stage 4 no client sends the header, so live behaviour for Claude changes only by Stage 2's refusal of the stamp properties.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real handler and outliner on a real conn); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1, migrations applied by `connector/test/apply-migrations.ts`, the `SYNC` binding faked at HTTP level as `tools.test.ts` does).

**Spec:** `docs/superpowers/specs/2026-11-07-claude-edit-stamps-editedby-design.md`. Read it first. It is the authority; section numbers below (§3.2 and so on) are the spec's, and "step N" means a numbered step of §3.2.

## Global constraints

- **Names, exactly:**
  - the patch is `patches/0034-semantic-claude-edit-stamps.patch`;
  - the new upstream test namespace is `logseq.db-sync.semantic-edit-stamps-test` in `deps/db-sync/test/logseq/db_sync/semantic_edit_stamps_test.cljs`, required from `test_runner.cljs` after `semantic-readable-writes-test`;
  - the header is `x-logseq-edit-stamp`, value exactly `claude`; the creator map key is `:stamp?`;
  - in `worker/handler/semantic.cljs`, one new section placed just before `authored-write!`: `stamp-header-value`, `stamp-property-idents`, `editedby-choice-uuid` (a fixed UUID literal, derived once and written in the patch), `check-stamp-schema` (returns the 409 or nil), `ensure-stamp-schema!`, `ensure-activity-page!`, `stamp-target?`, `stamp-tx`;
  - idents `:user.property/claude-editedBy` (title `editedBy`, closed value `claude`) and `:user.property/claude-editedAt` (title `claudeEditedAt`, type `:datetime`), or the `:plugin.property.claude/` fallback if Stage 1 finds the fixed `:user.property/` idents fail db validation;
  - the page title is `Claude Activity`;
  - migration `connector/migrations/0005_graph_edit_stamps.sql`, column `graphs.edit_stamps INTEGER NOT NULL DEFAULT 1`; `ResolvedGraph.editStamps`, `GraphRecord.editStamps`, `GraphPatch.editStamps`; the wizard form field `edit_stamps`.
- **Messages, in the spec's wording** (§3.2 steps 4 and 7):
  - `edit stamps: property editedBy (<ident>) is not the stamp property; rename it or turn off "Mark Claude's edits" for this graph` (409; the same shape names `claudeEditedAt` when that one conflicts);
  - `entry 0: editedBy is set by the server and can't be written` (and `claudeEditedAt`), with the real entry index on batches.
- **One transaction, one tx id** (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). Schema, page and stamp datoms are transacted inside the same `ldb/batch-transact-with-temp-conn!` call as the mutation. Every route test asserts the stamp datoms' tx equals the write's. A dry run's stamps vanish with `dry-run-conn`.
- **Order keys after the seeded max** for the Activity page's query blocks (`docs/solutions/sync/order-key-not-seeded-for-server-writes.md`).
- **Lookups by ident and UUID, never by title** (`docs/solutions/api/title-resolves-outside-allowed-values.md`). The `claude` choice is found by its fixed UUID and must have `:block/closed-value-property` equal to `editedBy`. Tests create a decoy first.
- **Refusals stay refusals** (`docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`). A refused write answers 4xx naming the entry and leaves no stamp, no schema and no page.
- **Responses do not change** (§3.2 step 6). Item 17's `affected`/targets and item 28's audit rows describe only what the caller asked for (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`).
- **The existing guards stay** (REVIEW.md *Destructive operations keep their guards*): `acknowledge-*`, dry runs, `target-label`, closed-value and private-tag checks, 0011's write guards and 0012's bulk limits are untouched. Each patch stage re-runs one guarded refusal with the header set.
- **Free plan** (§5, REVIEW.md *Cost*). 0 extra Worker requests, 0 extra rate-limited writes, 0 extra D1 rows read or written per call (pinned from D1's `meta`), 0 neurons. In the DO: one pass over the tx's datoms and 2 datoms per stamped block; about 30 datoms once per graph. Each commit body states its added cost.
- **Tests run the real handler and outliner** through `sync-handler/handle-http` (as the other `semantic_*_test.cljs` files do) on a graph from `build-db-initial-data`, and real D1 in the connector. No stub of the outliner. Each new test is first seen to fail; keep the failure text for the PR (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`).
- **Check the read path** (`docs/solutions/api/read-hid-built-in-properties.md`). Hidden properties drop out of `get_block` and `list_properties`, so upstream tests read stamps from the db (`d/entity`), not from the semantic read API, and one test pins that `get_block` leaves them out.
- **Contract with Claude.** A stage that changes what Claude sees updates `CONNECTOR_HELP` (and, in Stage 4, the shared `HINTS` sentence) in the same commit. `tools-manifest.json` carries no descriptions, so it changes only if a check says so; run `node connector/scripts/check-tools-manifest.mjs` in every stage.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `docs`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a graph name, page UUID, hostname or token. Tests and docs use `sync.example.com`, `mcp.example.com`, the alias `work`, and invented titles such as "Nov 5th, 2026", Notes and Meeting.

### Working on patch 0034 (Stages 1 to 3)

Follow the `add-upstream-patch` skill. Once, before Stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0033
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0033"
git -C .upstream tag -f baseline
```

In every patch stage, after the code and tests pass:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-edit-stamps|semantic-write-guards|semantic-private-tags|semantic-readable-writes|worker-dispatch'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0034-semantic-claude-edit-stamps.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 34 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
node connector/scripts/check-tools-manifest.mjs               # unchanged: no route or OpenAPI change
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/` carries the change.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost*, *Contract and docs*, *Destructive operations keep their guards* and *Connector*.
- `semantic.cljs`: `request-creator` (`:1325`), `created-by-tx` (`:1332`), `authored-write!` (`:1359`), `atomic-write!` (`:1890`) and every caller listed in spec §2; `dispatch.cljs:61-67`.
- `deps/outliner/src/logseq/outliner/core.cljs` `move-block` (`:1414-1442`) and insert keying (`:735-744`); `outliner/property.cljs` `property-with-position?` (`:1153`); `db/frontend/entity_util.cljs` `hidden?` (`:69`).
- `patches/0011-*` (`dry-run-conn`, 409 wording), `0018-*` (replay on a client copy), `0026-*` to `0028-*` (they also touch `authored-write!`), `0029-*` (private-tag refusal), and the test files `semantic_write_guards_test.cljs`, `semantic_readable_writes_test.cljs` and `worker_dispatch_test.cljs`.
- Connector: `connector/src/graphs.ts`, `tools/semantic.ts` (`HINTS`, `graphFetch`, `request`), `tools/assets.ts`, `wizard/routes.ts` (`editGraph`) and `views.ts`, `audit/log.ts`, and the `add-d1-migration` skill.
- The `docs/solutions` entries listed in spec §2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A write with no creator** (`authored-write!` with `creator` nil skips the authorship transaction): the header alone must not stamp, and must not throw. Pin that `:stamp?` is read only from a creator built from a real actor (Stage 1).
2. **The header in another case or with whitespace** (`Claude`, ` claude`) is ignored, and a repeated header is ignored unless every value is exactly `claude` (Stage 1).
3. **A decoy:** an owner property titled `editedBy` created before the first stamped write, and a page (not property) titled `editedBy`. The first answers 409; the second does not conflict, because the check is over properties only (Stage 1).
4. **The owner deleted the `claude` choice but kept the property:** the choice is re-added under the same UUID, or the write answers 409 if that UUID now belongs to another entity (Stage 1).
5. **A block that is both inserted and has a child inserted under it in one batch:** each stamped once, two datoms each, not four (Stage 2).
6. **`batch_set_block_property` setting a property on a page and on a block:** only the block is stamped (Stage 2).
7. **`delete_block_property` on a block whose only change is a retraction:** the holder is stamped; a retraction of `:block/refs` alone is not a qualifying change (Stage 2).
8. **A batch where entry 1 names `claudeEditedAt` and entry 0 is valid:** nothing written, one refusal naming entry 1, with and without the header (Stage 2).
9. **A cross-page move of a block with three descendants:** the moved block is stamped; the descendants, which only gain `:block/page`, are not (Stage 2).
10. **"Claude Activity" taken by a tag, or by a page differing only in case:** the page step is skipped (compared by `:block/name`) and the write still stamps (Stage 3).
11. **A stamped block eight days old and one at exactly 24 hours:** the week view holds both, the day view only what the pinned time input includes; Stage 1 records which boundary `UPSTREAM_REF` uses (Stage 3).
12. **A GET with a body-like query and a DELETE with no body:** the GET never carries the header, the DELETE does (Stage 4).
13. **`edit_stamps` unticked in the wizard while a request is in flight in another isolate:** the next call re-reads the row through `resolve()`, so no cached value outlives the call (Stage 5).

---

### Stage 1: The stamp flag, the schema and the checks before code

**Goal:** settle spec §9 step 1's open facts with tests, then read the header into the creator map and create the two hidden stamp properties on the first flagged write, refusing conflicts with a 409. No block is stamped yet. Patch only.

**Files:**
- Create: `deps/db-sync/test/logseq/db_sync/semantic_edit_stamps_test.cljs`; modify `test_runner.cljs` to require it.
- Modify: `worker/handler/semantic.cljs`: `request-creator` sets `:stamp? true` when `x-logseq-edit-stamp` is exactly `claude` and the graph is not E2EE; the new section's `stamp-property-idents`, `editedby-choice-uuid`, `check-stamp-schema` and `ensure-stamp-schema!`; `authored-write!` calls `check-stamp-schema` before the mutation and `ensure-stamp-schema!` in the same `tx-conn` when `:stamp?` is set.
- Modify: the spec's "As built" notes (a new section at the end of the spec) with each probe's result and any fallback taken.

**Interfaces produced:** `(:stamp? creator)`; `ensure-stamp-schema! tx-conn` returning the two property entity ids and the choice id; `check-stamp-schema db` returning nil or an `{:status 409 :error …}` map.

- [ ] **Step 1: Write the probe tests** (spec §9 step 1, risks 2, 3, 4 and 8). Each is a real test kept in the suite, not a throwaway:
  - `header survives dispatch`: a request through `dispatch` with `x-logseq-edit-stamp: claude` and a valid token reaches the DO handler with the header and the rewritten actor header both present.
  - `fixed user.property ident validates`: transact a property with ident `:user.property/claude-editedBy` and a closed value with a fixed UUID; db validation accepts it. If it doesn't, switch every name to `:plugin.property.claude/` and record why.
  - `hidden property still matches an advanced query`: a `hide? true` property set on a block is returned by an advanced query over its ident.
  - `time inputs`: which of `:-1d`, `:-7d`, `:today`, `:1d-before` the query engine at `UPSTREAM_REF` accepts; record the ones Stage 3 will use, or the no-window fallback (risk 3).
  Record each result in the spec's "As built" notes.

- [ ] **Step 2: Write the failing tests** (spec 8.1 *Schema* and the flag):
  - `the first stamped write creates the schema`: an `update_block` with the header; afterwards both idents exist, `editedBy` is `:default` with cardinality one and one closed value `claude` under the fixed UUID, `claudeEditedAt` is `:datetime`, both `hide? true`, and their datoms carry the write's tx id.
  - `a second stamped write creates nothing`: the datom count of the second write equals the same write without the header plus 0 schema datoms.
  - `without the header, with another value, on E2EE`: no schema is created (review focus 2; `e2ee_semantic_test.cljs`'s graph setup for E2EE).
  - `no creator`: the handler path with no actor header and the stamp header writes as before and creates nothing (review focus 1).
  - `conflicts answer 409 with nothing transacted`: a decoy property titled `editedBy`; `:user.property/claude-editedAt` already present as `:number`; the fixed UUID already used by a closed value of another property. Each answers 409 with the spec's message, and the db's max tx is unchanged. A page titled `editedBy` does not conflict (review focus 3).
  - `deleted properties are recreated, unhidden stays unhidden`: delete both, write, both back and hidden; set `hide?` false on one, write, it stays false. A deleted choice comes back under its UUID (review focus 4).
  - `dry run`: a `move_blocks` dry run with the header leaves no schema.
  - `guards unchanged`: a private-tag refusal (patch 0029) with the header still answers 4xx naming the entry and leaves no schema.

- [ ] **Step 3: Run** the namespace and keep the failures.

- [ ] **Step 4: Implement** as §3.2 steps 1 and 4. `check-stamp-schema` runs against the before-db so a conflict refuses before the mutation; `ensure-stamp-schema!` uses `d/entity` by ident and by `[:block/uuid editedby-choice-uuid]`, never a title lookup.

- [ ] **Step 5: Contract.** None for Claude: no client sends the header yet.

- [ ] **Step 6: Run the patch workflow above, then the gate:** `scripts/check.sh --upstream`.

- [ ] **Step 7: Mutation check:** look the choice up by title and confirm the decoy test fails; drop the E2EE check and confirm the E2EE test fails; move `ensure-stamp-schema!` outside the `tx-conn` and confirm the tx-id assertion fails. Revert.

- [ ] **Step 8: Commit.** `feat(api): read the edit-stamp header and create the hidden stamp properties`. Body: the probe results and any fallback; added cost (about 10 datoms once per graph; one ident and one UUID lookup per flagged write).

**Done when:** the four probes are recorded, a flagged write creates the hidden schema once in its own transaction, conflicts refuse before anything is written, unflagged and E2EE writes are untouched, and the gate is green.

---

### Stage 2: Stamp every block a flagged write creates or changes

**Goal:** `stamp-tx` adds `editedBy` and `claudeEditedAt` to each target of a flagged write, in the same tx, on every write route; siblings, carried children, pages, tags, properties, closed values and property value blocks are never stamped. The property tools refuse the stamp properties with or without the header. Lands acceptance 1 on the server.

**Files:**
- Modify: `worker/handler/semantic.cljs`: `stamp-target?` and `stamp-tx` (§3.2 steps 2 and 3); `authored-write!` calls `stamp-tx` over `before`, `@tx-conn` and `@tx-data` after the authorship datoms; the stamp-property refusal in the set, batch set, delete and batch delete property handlers, in the same place the private-tag refusal of patch 0029 runs (§3.2 step 7).
- Modify: `semantic_edit_stamps_test.cljs`.
- Modify (connector): `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`, the refusal only) and the matching assertion in `connector/test/tools.test.ts`.

**Interfaces produced:** `(stamp-tx before after tx-data now creator)` returning datoms; the refusal message.

- [ ] **Step 1: Write the failing tests** (spec 8.1, first four bullets and *Refusals* and *Responses*):
  - `every write route stamps`: table-driven over insert tree, insert children, batch insert, capture, create task, update block, set, batch set, delete and batch delete property, move (same parent and new parent, same page and cross-page), batch move, `refresh_refs` apply, and the asset write. Each touched block reads back with `editedBy` = the `claude` choice id and `claudeEditedAt` inside the call's time window, and the stamp datoms' tx is the write's.
  - `not stamped`: siblings of a moved, an inserted and a reordered block; descendants carried by a cross-page move (review focus 9); the page, a tag, a property entity, a closed value and a property value block touched by the writes above; a page in a mixed batch set (review focus 6).
  - `one stamp per block`: a block inserted with a child in the same batch carries two stamp datoms, not four (review focus 5).
  - `property delete stamps the holder`; a `:block/refs`-only retraction does not (review focus 7).
  - `a later write moves claudeEditedAt forward`.
  - `deleted blocks are not stamped` and `delete_blocks` answers as before.
  - `no header, other value, dry run, E2EE`: nothing stamped.
  - `responses unchanged`: for update block, insert tree and batch move, the response with the header (first stamped write, so schema is created) equals the response without it, after removing the volatile fields the existing tests already strip (§3.2 step 6).
  - `refusals leave no stamp`: a private-tag value and a closed-value mismatch with the header answer 4xx naming the entry; the target block has no stamp.
  - `stamp properties can't be written`: `set_block_property` and `delete_block_property` naming `editedBy` or `claudeEditedAt` (by title and by ident) answer 4xx with the spec's message; batch entry 1 naming one with entry 0 valid writes nothing and names entry 1 (review focus 8). With and without the header.
  - `get_block leaves the stamps out` (read path, §2).
  - `replay`: the stamped tx replayed on a client copy (as patch 0018's tests do) gives the same stamps.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.2 steps 2, 3 and 7. The qualifying set and the exclusions are one data literal so the test and the code read the same list. `now` is the same millisecond value the authorship datoms use.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP` gains: "`editedBy` and `claudeEditedAt` are set by the server; the property tools refuse them." The connector test asserts the sentence is present.

- [ ] **Step 5: Run the patch workflow, then the gate:** `scripts/check.sh --upstream`.

- [ ] **Step 6: Mutation check:** add a sibling re-key to the stamp target set (treat `:block/page` as qualifying, then separately stamp every entity with an order datom in the tx) and confirm the sibling and carried-children tests fail; drop the property value block exclusion and confirm `not stamped` fails; transact the stamp in a second `transact!` and confirm the tx-id assertion fails; remove the refusal from batch set only and confirm the batch test fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): stamp blocks a flagged write creates or changes with editedBy and claudeEditedAt`. Body: 2 datoms per stamped block, one pass over the tx's datoms, no extra query per block; the failures each test showed.

**Done when:** every write route stamps exactly its own blocks in its own tx, nothing else is stamped, responses are unchanged, the stamp properties can't be written through the API, and the gate is green.

---

### Stage 3: The Claude Activity page

**Goal:** the first flagged write also creates a **Claude Activity** page with a last-day and a last-week query block, newest `claudeEditedAt` first, as tables; a taken title is left alone. Lands acceptance 2 on the server.

**Files:**
- Modify: `worker/handler/semantic.cljs`: `ensure-activity-page!` in the same `tx-conn`, after `ensure-stamp-schema!`; query text as constants next to it, using the time inputs Stage 1 recorded.
- Modify: `semantic_edit_stamps_test.cljs`.

- [ ] **Step 1: Write the failing tests** (spec 8.1 *Schema* page bullets and *Query*):
  - `the first stamped write creates the page once`: page `Claude Activity` with two query blocks whose text equals the pinned constants; a second write adds nothing; the page itself carries no stamp.
  - `order keys after the seeded max`: the query blocks' `:block/order` sort after every existing order key on a graph seeded with keys near the top of the range.
  - `title taken`: a page `claude activity` (case differs) and, separately, a tag titled `Claude Activity` exist; the page step is skipped and the write still stamps (review focus 10).
  - `queries return the right rows`: run each pinned query against the db with blocks stamped now, 23 hours ago, exactly 24 hours ago and 8 days ago; the day view and week view hold what the recorded time inputs say, newest first; an unstamped block and one stamped with a decoy `editedBy` value are absent (review focus 11).
  - `responses unchanged` re-run with the page created.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.2 step 5. Order keys come from the same seeded generator the insert handlers use.

- [ ] **Step 4: Contract.** None yet (the header is still not sent).

- [ ] **Step 5: Run the patch workflow, then the gate:** `scripts/check.sh --upstream`.

- [ ] **Step 6: Mutation check:** compare the title with `:block/title` instead of `:block/name` and confirm the case test fails; reverse the sort and confirm the query test fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): create a Claude Activity page listing stamped blocks`. Body: about 20 datoms once per graph; the time inputs used.

**Done when:** the page appears once with working day and week views, a taken title is respected, and the gate is green.

---

### Stage 4: The connector sends the header for graphs with stamping on

**Goal:** migration 0005 adds `edit_stamps` (default on); `Graphs.resolve()` returns it from the row it already reads; every non-GET call from `request()` and the asset write path sends `x-logseq-edit-stamp: claude` when it is on. Lands acceptances 1 and 4 end to end. Connector only; `scripts/check.sh` without `--upstream`.

**Files:**
- Create: `connector/migrations/0005_graph_edit_stamps.sql` (follow `add-d1-migration`).
- Modify: `connector/src/graphs.ts` (`resolve()`'s SELECT, `RECORD_COLUMNS`, `ResolvedGraph`, `GraphRecord`, `GraphPatch`, `update`).
- Modify: `connector/src/tools/semantic.ts` (`request()` sets the header on non-GET when `graph.editStamps`; the shared `HINTS` sentence on the stamping tools named in §4) and `connector/src/tools/assets.ts` (the POST write path).
- Modify: `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`, §4's section).
- Modify: `connector/test/graphs.test.ts`, `tools.test.ts`, `assets.test.ts`, `audit-log.test.ts`.

**Interfaces produced:** `ResolvedGraph.editStamps: boolean`; `GraphRecord.editStamps`; `GraphPatch.editStamps?`.

- [ ] **Step 1: Write the failing tests** (spec 8.2):
  - `migration 0005 defaults edit_stamps to 1` for a row inserted without it and for an existing row.
  - `resolve returns editStamps and reads one row`: `meta.rows_read` is still 1; `list` and `get` return it.
  - `every write tool sends the header`: parametrised over `tools-manifest.json`'s non-read tools plus `save_document` and `save_file_from_url`; with `editStamps` on, each non-GET request the fake `SYNC` sees carries `x-logseq-edit-stamp: claude`; with it off, none does. Every GET, including item 28's snapshot pre-reads, never carries it (review focus 12).
  - `no extra requests`: per write tool, the fake sees the same number of requests with stamping on and off.
  - `audit entries unchanged`: an `audited()` row for a stamped write equals the one for an unstamped write, ignoring `at` and `id`.
  - `contract`: `CONNECTOR_HELP` holds §4's section; each stamping tool's description holds the `HINTS` sentence and no read tool's does; `check-tools-manifest` passes.

- [ ] **Step 2: Run** `npm --prefix connector test -- graphs tools assets audit-log` and keep the failures.

- [ ] **Step 3: Implement** as §3.4 items 1 to 3. The header is set in the one place `request()` builds `SyncRequest.headers`, not per tool.

- [ ] **Step 4: Contract.** `HINTS` sentence and `CONNECTOR_HELP` section as §4 (what is stamped, not deletes, pages, tags or properties; the stamp survives the owner's later edits; E2EE graphs are not stamped; the owner turns it off in the wizard; how to recreate the Activity page). Fold Stage 2's refusal sentence into it so the guidance appears once. `npm --prefix connector run update:manifest` only if the check reports a change. Spec §11 question 4 is open; if the owner answers "help only", drop the `HINTS` sentence here.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** send the header on every method and confirm the GET assertion fails; read `editStamps` with a second SELECT and confirm the `rows_read` test fails; set the header in `semantic.ts` only and confirm the asset tool case fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): send the edit-stamp header for graphs with stamping on`. Body: 0 extra Worker requests, rate-limited writes, D1 rows or neurons per call, as measured; the migration is a one-time ALTER.

**Done when:** every write the connector sends carries the header exactly when the graph's setting is on, reads never do, costs are unchanged, the contract text is in place, and the gate is green.

---

### Stage 5: The owner's switch and the docs

**Goal:** a "Mark Claude's edits in the graph" checkbox on the wizard's edit form turns stamping off and on per graph; README §11.8 and the operations notes describe the feature. Lands acceptance 5. Connector and docs; `scripts/check.sh`.

**Files:**
- Modify: `connector/src/wizard/views.ts` (the checkbox on the edit form, ticked from `GraphRecord.editStamps`), `connector/src/wizard/routes.ts` (`editGraph` reads `edit_stamps` and saves it through `Graphs.update`; an unticked box saves 0).
- Modify: `connector/test/wizard.test.ts`.
- Modify: README §11.8 (contract text, the stamp is a label not proof, E2EE, how to turn it off, how to recreate the page) and the rollout notes (migration 0005 applies before the Worker; if the Worker deploys before the sync server, the header is ignored and nothing breaks).

- [ ] **Step 1: Write the failing tests:**
  - `edit form shows the current value`: ticked for a default graph, unticked after saving 0.
  - `unticking stops the header on the next call`: post the form unticked with a valid CSRF token, then call `update_block`; the fake sees no header. Tick it again; the header is back (review focus 13).
  - `the form needs the owner session and CSRF token`, as the existing edit-form tests do; the field is not settable through any MCP tool (list the tools and assert no input schema names `edit_stamps` or `editStamps`).
  - `other fields are unchanged` by a save that only flips the box.

- [ ] **Step 2: Run** `npm --prefix connector test -- wizard` and keep the failures.

- [ ] **Step 3: Implement** as §3.4 item 4.

- [ ] **Step 4: Contract.** README as above. No tool text changes.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** treat a missing checkbox field as "unchanged" instead of 0 and confirm the untick test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): add a per-graph switch for edit stamps to the wizard`. Body: 0 extra D1 reads per tool call; one row written per form save.

**Done when:** the owner can turn stamping off and on per graph from the wizard, Claude can't, existing stamps are left alone, the docs match, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** fill in the spec's "As built" notes beyond Stage 1's probes, and anything README §11.8 still lacks after review.
- **PR body:** the Logseq skill note (don't set `editedBy` or `claudeEditedAt` by hand; point the owner at the Claude Activity page in the app or `get_activity_log` in chat for "what did Claude change"), the failure each new test showed before its stage's code, the commit the checks ran on, what `scripts/check.sh` skipped, and that the PR is stacked on items 17 and 28 and must merge after them (spec §9 step 3).
- **Manual check in the Logseq app** (spec 8.3), recorded in the PR: properties hidden in block view; both Activity views list a just-written block newest first; a moved block appears; editing a stamped block in the app keeps the stamp. If a hidden property drops out of the Activity queries in the app, take risk 2's fallback (hide-empty-value with `:block-below`) as a Stage 1 amendment before merge.
- **After deploy** (spec §9 steps 4 and 5): on a scratch page insert, update, move, set and delete a property; check the stamps and the Activity page; untick the wizard box, write again, and check the new block is unstamped and the old ones still are; compare the next usage report's Worker requests and D1 rows with the day before.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 changes migration 0005's default (Stage 4); question 2 changes the schema step (Stage 1); question 3 would be its own item in the sync path; question 4 drops the `HINTS` sentence (Stage 4); question 5 turns the 409 into a skip with a note (Stage 1); question 6 turns the skipped page into a refusal (Stage 3). Any change lands before the PR merges.
