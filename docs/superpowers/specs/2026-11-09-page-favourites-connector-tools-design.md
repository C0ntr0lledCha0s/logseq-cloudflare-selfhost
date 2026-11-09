# Page favourites through the connector: design

Date: 2026-11-09
Issue: none (brief supplied directly by the owner). Areas: patch, connector, semantic, docs.
Upstream: `logseq/logseq` at `UPSTREAM_REF` (`e7e9c97`), `deps/db-sync`, with patches 0001 to 0037. This work adds patch 0038.
Branch: `claude/relaxed-maxwell-s4r8o4-favourites`, from `0bdbcc2`. Patch 0037 (code blocks, PR 46) is on this branch but not yet on `origin/main`, so this work is stacked on PR 46.
Builds on: the spike `docs/spikes/2026-11-09-page-favourites-through-the-connector.md` ("the spike") and its *Challenge* section, `docs/solutions/api/favourites-are-app-worker-code-the-server-must-reimplement-them.md`, and `2026-11-08-service-token-write-no-delete-design.md` ("the no-delete design", which owns the delete table).

Decisions marked **(brief)** come from the brief. Decisions marked **(call)** were made while writing this design. The design panel chose the "named" proposal (three semantic endpoints in patch 0038, generated connector tools, append at the bottom, slot-rewrite reorder, lookup by uuid, no favourite writes on E2EE graphs). No ideas were grafted from other proposals. The decisions most worth a second look are in section 11.

**What was run for this spec.** Nothing beyond reading source. This spec states no bug cause, so there was nothing to reproduce. Every line reference below was checked against `.upstream` on 2026-11-09 (`semantic.cljs` :344, :1817, :1868, :2131, :2481, :3047, :5239; `page_menu.cljs` :106-111; `header.cljs` :185-201; `frontend.util.entity/page?` :49-54). Behaviour that no test has shown yet is marked **unverified**, and section 8 names the test that settles each one before the connector stage starts.

## 1. Goal

The owner wants Claude to read, add, remove and reorder the favourites list in a graph. Today the connector cannot do any of these, because favourites are app worker code and `deps/db-sync` has no favourites API. Patch 0038 reimplements the three operations in the semantic handler, and the connector exposes them as three generated tools: `list_favorites`, `set_page_favorite` and `reorder_favorites`.

Acceptance (brief):

1. Patch 0038 is added under `patches/` and applies after 0037 via `scripts/fetch-upstream.sh`. `scripts/check.sh --upstream` passes.
2. A favourite added by Claude is appended at the **bottom** (`:bottom? true`), shown by a real-outliner test that checks sibling order under `$$$favorites` (not the graph-wide max key). The tool text says this differs from the app, which puts a new favourite at the top.
3. `$$$favorites` is found by its deterministic uuid, never by name. On an E2EE graph the handler refuses and never creates the page.
4. Real-outliner tests settle and pin: whether add and reorder bump the target's `:block/updated-at`; that `save-block` keeps a changed `:block/link` and updates `:block/refs`; that backlinks and the semantic feed are unchanged; and whether the favourite block is stamped with `editedBy`.
5. Add is idempotent ("already a favourite"), and removing a non-favourite answers "was not a favourite". Each write runs in one `atomic-write!` with one tx id.
6. The target policy matches what the app UI offers (traced from `page_menu.cljs`, `header.cljs` and `entity/page?`). Other kinds (hidden, recycled, non-page, uuid-named) are refused, naming the reason.
7. `list_favorites` skips link-less and recycled targets, dedupes, and returns an empty list when the page is missing.
8. `reorder_favorites` refuses a list that is not a permutation, naming each entry (`entry 2: ... is not a favourite`, `missing: ...`, `entry 3: duplicate of entry 1`).
9. Delete table: `set_page_favorite` is a `when` delete (`favorite === false`) and accepts dry-run; `reorder_favorites` is `never`. `write-no-delete` tokens refuse remove and allow add and reorder. `read` tokens allow only `list_favorites`.
10. The audit snapshot source (`getFavorites`) reads the hidden page the same way the write resolves it. `tools-manifest.json` is regenerated, and `connector_help` and README §11.8 are updated.
11. Each new test was seen to fail without its code, and the PR quotes the failure. The PR body has the Logseq skill note and states which checks ran on HEAD and which were skipped.
12. No D1 migration. The Free plan cost per write stays near 3 D1 rows written, 2 rows read and 2 to 3 Worker requests.

## 2. Context

**The data model.** Favourites are one hidden page whose name and title are the string `"$$$favorites"` (`common-config/favorites-page-name`). It has no `:db/ident`. `create_graph`'s private `build-favorites-page` (`create_graph.cljs:195-201`) creates it at graph creation with the deterministic uuid `(common-uuid/gen-uuid :builtin-block-uuid "$$$favorites")`, `:block/tags [:logseq.class/Page]`, `:logseq.property/hide? true`, `:logseq.property/built-in? true` and timestamps. Each favourite is a child block built by `ldb/build-favorite-tx`: `{:block/link [:block/uuid <page-uuid>] :block/title ""}`. The outliner adds `:block/parent`, `:block/page` and `:block/order`. The order is the ordinary fractional key, read with `ldb/sort-by-order`.

**The operations are app code.** `set-page-favorite`, `reorder-favorites` and `get-favorite-pages` live in the app's db worker (`src/main/frontend/worker/handler/graph.cljs:15-117`), which `deps/db-sync` does not depend on. The app:

- adds with `:insert-blocks` and `{}` opts, which puts the new block at the **top** (`get-target-block`, `core.cljs:933-938`, then `get-block-orders`, `:715-722`, makes a key before the first child);
- removes with `:delete-blocks`, a hard retract with no Recycle step;
- reorders by rewriting `:block/link` on the block in each slot with `:save-block`, so order keys never change;
- silently does nothing when `$$$favorites` is missing, silently skips unresolvable uuids in a reorder, and does not check the reorder list is a permutation.

Copied as is, each silent case would be a silent success here, which `CLAUDE.md` forbids.

**What the handler already has.** `handle` seeds the process-wide max order key before every dispatch (`semantic.cljs:5239`, `docs/solutions/sync/order-key-not-seeded-for-server-writes.md`). `atomic-write!` (:2481) runs a mutation as one authored transaction with one tx id, or on a throwaway copy for a dry run (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). `find-visible-entity` (:344) hides hidden and recycled entities. `resolve-page-selector` (:2131) resolves a uuid or title and answers 409 with candidates for an ambiguous title. `promotion-refusal` (:3047) is the in-repo shape for refusals that name `page-id` and the reason. `ensure-activity-page!` (:1868) is the precedent for a handler that creates a hidden page in a write's tx-conn.

**What the outliner does not check.** It does not validate `:block/link` (the pipeline only adds the target to `:block/refs`, `pipeline.cljs:120-124`), so every target rule is the handler's (`docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`). Its `delete-page!` does not touch favourites (the app unfavourites in the frontend, `handler/common/page.cljs:244-248`), so `delete_page` through the connector leaves the favourite block in place, linking a recycled page. The favourite block has no `:block/tags`, so the private-tag 500 (`docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`) does not apply.

**The stamp.** When the graph's "Mark Claude's edits" setting is on, the connector sends a header and the handler flags the creator `:stamp?` (:1904, never on E2EE). `stamp-target?` (:1817) accepts any entity with `:block/page` and no `:logseq.property/created-from-property`, which a favourite block satisfies. Whether its added datoms qualify under `stamp-qualifying-attributes` (:1797) is **unverified**. If they do, a hidden, empty-titled block would carry `editedBy` and `claudeEditedAt` and could appear in the Claude Activity page's query.

**E2EE graphs.** On E2EE graphs `:block/name` and `:block/title` are encrypted (`worker/sync/const.cljs:25-27`; `crypt_test.cljs:1348` encrypts `$$$favorites`). A lookup by name finds nothing, and creating the page with its deterministic uuid would upsert onto the existing page and overwrite its encrypted name with plaintext.

**What the app UI offers as a favourite (target policy, traced).** `page_menu.cljs:106-111` offers "Add to favorites" only when `(entity/page? page)` holds and `:block/name` is set and is not a uuid string. `entity/page?` (`frontend/util/entity.cljs:49-54`) is internal page, journal, class (tag) or property. The menu does not refuse built-in pages, tags or properties that are visible. `header.cljs:185-201` also offers favourite on a non-page (a zoomed-in block) by uuid.

**Connector plumbing.** Tools are generated from the vendored `openapi.json`. Each tool needs an `ANNOTATIONS` entry (`connector/src/tools/spec.mjs`), a `DELETE_RULES` entry (`connector/src/tools/deletes.mjs`), a `SNAPSHOT_PLAN` entry (`connector/src/audit/snapshot.ts`) and a `readable.ts` classification; each throws for an unclassified tool. `SnapshotSource` (`snapshot.ts:27`) is `"getBlocks" | "getPageOutline" | "getPage" | "getTag" | "getProperty" | "refresh_refs"`. `getPage` cannot read a hidden page, so a new source is needed (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`). The access modes are `read`, `write-no-delete` and `write` (`connector/src/auth/access.ts`).

## 3. Design

### 3.1 Layout

| Layer | File | Change |
|---|---|---|
| Handler | patch 0038: `deps/db-sync/.../handler/semantic.cljs` | `favorites-page`, `visible-favorites`, `favourite-refusal`, list, set and reorder handlers, guarded create |
| Routes | patch 0038: `deps/db-sync/.../routes/semantic.cljs` | three routes, openapi descriptions, request and response schemas |
| Tests | patch 0038: new test namespace, runner entry | real outliner on a `create_graph` db |
| Vendor | `connector/vendor/openapi.json`, `semantic_api_tools.mjs` | regenerated after 0038 |
| Annotations | `connector/src/tools/spec.mjs` | three entries |
| Delete table | `connector/src/tools/deletes.mjs` | two rules, two `DRY_RUN_TOOLS` entries |
| Audit | `connector/src/audit/snapshot.ts` | `getFavorites` source and two `SNAPSHOT_PLAN` entries |
| Readable | `connector/src/tools/readable.ts` | two `NO_CONTEXT_TOOLS` entries |
| Contract | `connector_help`, `connector/tools-manifest.json`, README §11.8 | text, regenerated manifest |
| Docs | `docs/solutions/api/favourites-...md`, PR body | update the entry, Logseq skill note |

Patch 0038 is laid out like 0027: handler functions, routes, openapi text, a test namespace and its runner entry. There is no hand-written connector tool code.

### 3.2 Finding the page and its slots (brief)

- `favorites-page` is `(d/entity db [:block/uuid (common-uuid/gen-uuid :builtin-block-uuid "$$$favorites")])`. It is never looked up by name, so it works on E2EE graphs and survives a rename of `:block/name`.
- `favorite-slots` is the page's children, sorted with `ldb/sort-by-order`.
- `visible-favorites` keeps a slot only when its `:block/link` resolves to an entity that is neither recycled nor hidden, and drops a later slot linking a page an earlier slot already links.

This one function serves `GET /favorites`, the read-back after each write, the reorder permutation check and the connector's before-snapshot, so the audit pre-read mirrors the write.

### 3.3 `GET /favorites` (brief)

`listFavorites`, scope `logseq/read`, rate class read. Returns `{favorites: [{uuid, title, kind}]}` in sidebar order. If the page is missing it returns `{favorites: []}`. On an E2EE graph it lists uuids and kinds, with titles as the other list endpoints return them there.

### 3.4 `PUT /pages/:page-id/favorite` (brief, with calls noted)

`setPageFavorite`, scope `logseq/write`, rate class write. Body `{favorite: boolean (required), dry-run?: boolean}`. Any other body field is refused, naming it. Steps, in order:

1. **E2EE (call).** On an E2EE graph, answer 400 "favourites can't be changed on E2EE graphs; the favourites page and its blocks are encrypted" and write nothing. `promotePageToTag` is the precedent ("Unavailable for E2EE graphs"). This is stricter than the brief's "refuse rather than create" (section 11, question 2).
2. **Resolve** `page-id` with `resolve-page-selector` (uuid or title; 409 with candidates when a title is ambiguous).
3. **Add refusals (call, traced from the app UI).** Each names `page-id` and the reason, in `promotion-refusal`'s shape:
   - 404 when the id names nothing or something hidden;
   - 400 when the target is in the Recycle bin;
   - 400 "is a block, not a page";
   - 400 for an asset;
   - 400 for a page whose `:block/name` is a uuid string.

   Add allows exactly what `page_menu.cljs` allows: `entity/page?` (internal page, journal, class, property) with a non-uuid `:block/name`. That includes visible built-in pages, tags and properties, because the menu does not refuse them. The header menu also offers favourite on a zoomed-in block; this design refuses blocks on purpose, since the feature is page favourites, and the tool text says so (section 11, question 3).
4. **Remove** resolves by uuid even when the target is recycled, so a dangling favourite left by `delete_page` can be cleared. Remove skips the kind checks.
5. **Idempotent.** Adding a page that is already a favourite answers 200 `{result: "already a favourite"}`. Removing a page that is not a favourite answers 200 `{result: "was not a favourite"}`. Neither writes, and neither leaves a before-snapshot diff.
6. **Missing page, non-E2EE (call, droppable).** Inside the same `atomic-write!`, transact a reimplementation of `build-favorites-page` (the upstream function is private) with block timestamps. Before that, refuse 409 when any entity already holds `:block/name "$$$favorites"` under another uuid ("graph has a $$$favorites page with an unexpected uuid; nothing was changed"). If review judges the create path unsafe, this step is dropped and a missing page answers 409 instead; nothing else changes (section 11, question 4).
7. **Write.** `atomic-write!` with `(dissoc creator :stamp?)` and outliner-op `:insert-blocks` or `:delete-blocks`. Add calls `outliner-core/insert-blocks!` with `[(ldb/build-favorite-tx uuid)]`, the page as target and `{:sibling? false :bottom? true}`. Remove calls `outliner-core/delete-blocks!` on every slot that links the target, duplicates included, so a remove really removes it.
8. **Read-back.** The mutation returns `visible-favorites` from the tx-conn. For a real write, it is re-read from `@conn` after commit. If the target's presence does not match the request, answer 500 "favourite did not read back" (no silent success).

Response: `{result: "added" | "removed" | "already a favourite" | "was not a favourite", page: {uuid, title, kind}, favorites: [...], dry-run?: true}`. `handle` already seeds the order key before dispatch.

**Why the bottom (brief).** The app prepends. The brief chose append, so that a list Claude builds reads in the order Claude added it. The tool text says so, and section 11, question 1 asks the owner to confirm.

### 3.5 `PUT /favorites` (brief)

`reorderFavorites`, scope `logseq/write`, rate class write. Body `{page-ids: [uuid | title, ...], dry-run?: boolean}`. Refused on E2EE as in 3.4.

1. Resolve every entry with `resolve-page-selector`. Collect all problems before writing anything, and answer one 400 listing them all:

   ```
   page-ids: entry 2: "X" (uuid) is not a favourite; entry 3: duplicate of entry 1; missing: "Y" (uuid), "Z" (uuid)
   ```

   The check is against `visible-favorites`. An empty list is refused when favourites exist.
2. **Write.** Walk only the visible slots in order. Where slot *i* links a different page from entry *i*, `save-block` that slot with `:block/link` set to the new page, all inside one `atomic-write!` (outliner-op `:save-block`). Order keys are unchanged, so nothing new needs seeding.
3. **Hidden slots** (link-less, recycled target, duplicate) keep their key and link and are never deleted. That keeps reorder truly `never` a delete.
4. **Read-back.** Response `{favorites: [...], dry-run?}`, re-read after commit; 500 when the read-back order differs from the request.

### 3.6 Routes and openapi text

In `routes/semantic.cljs`, following `promotePageToTag` (:32, :172, :303). The descriptions say: a new favourite is appended at the bottom, unlike the app, which adds at the top; `page-id` is a uuid or a title; the refusals and their statuses; unavailable for E2EE graphs; `delete_page` leaves the favourite hidden, and restoring the page brings it back; removing a favourite never touches the page.

### 3.7 Connector

Tools are generated from the vendored openapi. Changes:

- **`spec.mjs` ANNOTATIONS.** `list_favorites` READ; `set_page_favorite` DESTRUCTIVE_IDEMPOTENT; `reorder_favorites` DESTRUCTIVE_IDEMPOTENT (it overwrites the order, and repeating the call changes nothing).
- **`deletes.mjs` DELETE_RULES.** `set_page_favorite`: `when` `body.favorite === false`, reason "removes the page from the favourites list". `reorder_favorites`: `never`, reason "rewrites which page each favourite slot links; the permutation check removes nothing".
- **`DRY_RUN_TOOLS`.** `set_page_favorite: "body"`, `reorder_favorites: "body"`.
- **`snapshot.ts`.** Add `"getFavorites"` to `SnapshotSource`. `SNAPSHOT_PLAN` for both writes is `{source: "getFavorites", read: () => ({source, path: "favorites"}), keep: "the ordered favourites list"}`. `set_page_favorite` also gets `delete: {e2ee: () => null}`, since the server refuses E2EE and the whole list is small enough to read in full.
- **`readable.ts` NO_CONTEXT_TOOLS.** Both writes ("the response names the page and returns the whole list").
- **Access.** Unchanged code. `write-no-delete` refuses remove through `deletesRefusedBy`; `read` tokens resolve read-only, so only `list_favorites` passes.
- **`KB_INDEX_WRITE_TOOLS`.** Not added: the page is hidden, and no title, tag or membership changes.
- **`connector_help`** gets a Favourites paragraph (section 4). Run `npm --prefix connector run update:manifest`, update README §11.8, and put the Logseq skill note in the PR body.

## 4. Tool contract

**`list_favorites`** `{graph}`. Read access. Returns `{favorites: [{uuid, title, kind}]}` in sidebar order. Link-less slots, slots whose target is recycled or hidden, and duplicate slots are skipped. The list is empty when `$$$favorites` is missing.

**`set_page_favorite`** `{graph, page-id (uuid or title; uuid only on E2EE, which is refused anyway), body: {favorite: boolean, dry-run?: boolean}, reason}`. Returns `{result: "added" | "removed" | "already a favourite" | "was not a favourite", page: {uuid, title, kind}, favorites: [...read back], dry-run?: true}`. Errors:

- 400 on E2EE graphs;
- 404 `page-id: no page X` for missing or hidden ids;
- 400 (add only) `page-id: "T" (uuid) is in the Recycle bin`, `is a block, not a page`, `is an asset`, `has a uuid name`;
- 400 for any other body field, naming it;
- 409 for an ambiguous title (with candidates), or for a `$$$favorites` name held under an unexpected uuid;
- 500 `did not read back`.

A remove is a delete: `write-no-delete` tokens refuse it, and it accepts dry-run.

**`reorder_favorites`** `{graph, body: {page-ids: [uuid | title, ...] (the full order), dry-run?}, reason}`. Returns `{favorites: [...read back], dry-run?}`. A list that is not a permutation is refused with one 400 listing every problem. Allowed for `write-no-delete`.

**Server routes.** `GET /api/v1/graphs/:graph-id/favorites` (`listFavorites`, `logseq/read`); `PUT /api/v1/graphs/:graph-id/pages/:page-id/favorite` (`setPageFavorite`, `logseq/write`, rate class write); `PUT /api/v1/graphs/:graph-id/favorites` (`reorderFavorites`, `logseq/write`, rate class write).

**`connector_help` Favourites paragraph (draft).** "Favourites are the pages in the sidebar's Favorites list. `list_favorites` reads them in order. `set_page_favorite` with `favorite: true` adds a page (a page, journal, tag or property, never a block) at the bottom of the list, unlike the app, which adds at the top; `favorite: false` removes it, which counts as a delete, so a no-delete token can't do it (a dry run can). `reorder_favorites` takes the full list in the new order; call `list_favorites` first. Deleting a page hides its favourite, and restoring the page brings it back. Unavailable on E2EE graphs."

**Logseq skill note (for the PR body).** Favourites can now be read and edited. Call `list_favorites` before reordering and pass the full list. Claude adds new favourites at the bottom. Removing a favourite is a delete for `write-no-delete` tokens (dry-run allowed). Deleting a page leaves its favourite hidden until the page is restored.

## 5. Cost on the Free plan

No D1 migration and no new D1 query. Favourites live in the graph's Durable Object, and `audit_log.tool` is `TEXT` with no `CHECK` (migration 0004).

| Path | D1 rows read | D1 rows written | Worker requests | AI, Vectorize |
|---|---|---|---|---|
| Add, remove or reorder | about 2 (graph token about 1, finish 1) | 3 (audit begin 2, finish 1) | 3 (front Worker, `getFavorites` before-snapshot through the sync binding, the write) | 0 |
| No-op ("already a favourite") | about 2 | 3 | 3 | 0 |
| Dry run | about 2 | 3 | 2 to 3 | 0 |
| `list_favorites` | about 1 | 0 (reads leave no audit row) | 2 (front Worker, DO) | 0 |
| Refused remove on `write-no-delete` | as a read-only refusal today | as today | 1 (no snapshot, no sync) | 0 |

The read-back happens inside the write's own response, so it adds no request. At a heavy 300 writes a day that is 900 rows written (0.9% of 100k), about 600 rows read (0.01% of 5M) and 900 requests (0.9% of 100k).

**Semantic index.** The feed lists a block only if it is not hidden and its title is not blank (patch 0014). The favourite block fails both, and `:block/link` is not a feed trigger attribute, so Workers AI and Vectorize cost 0. **Unverified:** if a test shows that add or the link rewrite bumps the target's `:block/updated-at`, each call re-embeds that page (a few neurons) and the cron indexer reads its usual per-change rows (`docs/solutions/cost/d1-reads-from-indexer-scans.md`). That is the spike's don't-build trigger: the build stops at that test and takes the result back to the owner before the connector stage.

**Front Worker CPU** is JSON forwarding of tens of items, well inside 10 ms (not measured).

## 6. Safety

- **One transaction.** Add, remove and reorder each run in one `atomic-write!` with one tx id, including the create path when it is kept.
- **No silent success.** A missing page is created or refused, never skipped. A reorder that is not a permutation is refused up front. Every real write is read back, and a mismatch answers 500.
- **Errors name the entry and reason.** Single-target refusals name `page-id`; reorder lists every bad entry in one message.
- **No E2EE writes.** The page is found by uuid, so reads work, but no write reaches an E2EE graph. This rules out overwriting an encrypted name with plaintext.
- **The page is never matched by name.** A `$$$favorites` name held under another uuid answers 409, so the handler never writes to a page it did not expect.
- **No stamp on hidden blocks.** `:stamp?` is stripped from the creator for these writes, so the favourite block cannot appear in the Claude Activity page (pinned by a test).
- **Deletes stay classified.** Remove is a `when` delete, and reorder never deletes, because hidden slots are kept, not cleaned up.
- **Example data only.** Tests and docs use `sync.example.com`, `mcp.example.com` and example aliases. No graph name or page uuid from the owner's graphs appears in any file.

## 7. Risks

1. **`editedBy` on the favourite block.** `stamp-target?` accepts it. The design strips `:stamp?`; a test shows the block carries no `editedBy` and the activity query does not list it.
2. **`:bottom? true` on a page target.** The new slot must sort after the last existing sibling, not merely be unique. The test checks sibling order with three existing favourites, on a graph whose max key is elsewhere.
3. **`save-block` with a changed `:block/link`.** It must keep the new link and replace `:block/refs` (old target out, new in). Stale refs would make backlinks or the refs-based feed drift. **Unverified**; a real-outliner test settles it before the connector stage.
4. **The target's `:block/updated-at`.** If the refs pipeline bumps it on add or reorder, every call re-embeds a page. Test gate; a failure goes back to the owner.
5. **The create path** is a raw transact of a reimplemented private upstream map, so its shape can drift from `create_graph`. A test compares it with a `create_graph` page's attributes, and the stage is droppable (409 instead).
6. **E2EE is stricter than the brief.** All favourite writes are refused on E2EE graphs, not only the create. Whether an unencrypted empty block title breaks E2EE clients is unknown, so this stays closed until the owner asks (section 11, question 2).
7. **Remove takes duplicates with it.** The before-snapshot lists only the deduped list, so a duplicate slot's removal is not recorded on its own. Acceptable, since the duplicate links the same page.
8. **Upstream drift.** Upstream may move favourites into `deps/outliner` or rename the worker functions. The data shape is also used by the exporter and `initial_data.cljs`, and the patch's `create_graph`-based tests would show a change on a bump.
9. **Patch 0037 is unmerged (PR 46).** 0038 must be rebased if 0037 changes, and vendor and `.upstream` must be rebuilt after adding 0038.
10. **Whether real graphs ever lack `$$$favorites` is unknown.** If every graph has it, the create path is dead code (section 11, question 4).

## 8. Testing

Each test is written first and seen to fail before its code exists, and the PR quotes the failure.

**Patch 0038**, through the real `sync-handler/handle-http` on a graph built by `create_graph`, with the real outliner and no stubs:

1. **Append at the bottom.** Sibling order under `$$$favorites` is `[A B C new]`, one tx id across all datoms, and the new key is unique.
2. **Idempotent.** Adding a favourite writes no tx and answers "already a favourite". Removing a non-favourite answers "was not a favourite".
3. **Duplicates.** Removing a page with two slots removes both, in one tx.
4. **Refusals.** A hidden built-in page answers 404; a recycled page 400 naming the Recycle bin; a block 400 "is a block, not a page"; a uuid-named page 400; an asset 400; an ambiguous title 409 with candidates; an unknown body field 400 naming it. On E2EE every write answers 400 and the page count is unchanged.
5. **Lookup by uuid.** Renaming the page's `:block/name` in the fixture still finds it; a `$$$favorites` name under another uuid answers 409.
6. **Missing page.** It is created with `create_graph`'s attributes in the same tx as the insert. `GET` on a missing page returns `[]`.
7. **List.** Skips a link-less slot, a recycled target and a duplicate. `delete_page` of a favourite hides it, and restoring the page brings it back. Remove of a recycled target clears the slot.
8. **Reorder.** A valid permutation rewrites links, keys are unchanged, and the read-back order equals the request. Not-a-favourite, duplicate and missing entries are all named in one 400, and the db is unchanged. Hidden slots keep their links.
9. **Pins** (each settles an **unverified** item before the connector stage): the target's `:block/updated-at` is unchanged on add and reorder (or record the observed value and stop for the owner); the old and new targets' `:block/refs` and `get_page_backlinks` are as expected; the semantic feed lists no favourite block and does not re-list the target; with the stamp header on, the favourite block carries no `editedBy` or `claudeEditedAt`.
10. **Dry run.** Returns the same body with `dry-run: true`, and the db is unchanged.

**Connector (vitest):**

- `deletes.test`: `set_page_favorite {favorite: false}` returns a reason, `{favorite: true}` returns null, reorder returns null; `DRY_RUN_TOOLS` matches the vendored openapi; a mutation pass removes each new rule in turn and a test fails.
- Access tests: a `write-no-delete` token is refused remove (0 sync calls, audit row `refused`) and passes add and reorder; a `read` token passes only `list_favorites`.
- Snapshot test: the `getFavorites` plan reads the `favorites` path, and a remove's before-snapshot holds the list.
- The annotations and context-class tests cover the new tools; the manifest check passes after `update:manifest`.

Finally, `scripts/check.sh --upstream` on HEAD, naming the SHA and what it skipped.

## 9. Rollout and verification

**Build order.** (1) Patch 0038 handler tests 1 to 10, with test 9's pins settled first; stop for the owner if `:block/updated-at` moves. (2) Rebuild `.upstream`, re-vendor. (3) Connector entries and tests. (4) `connector_help`, manifest, README §11.8, the `docs/solutions` entry. (5) `scripts/check.sh --upstream` on HEAD.

**After merge** (`deploy` applies the patch and the Worker; no migration):

1. On the test graph (example alias `test`): `list_favorites` matches the app's sidebar.
2. `set_page_favorite` adds a page; the app shows it at the bottom of Favorites after sync.
3. `reorder_favorites` with the list reversed; the app shows the new order.
4. `set_page_favorite {favorite: false}` with `dry-run: true` answers without writing; then for real. A `write-no-delete` token is refused the remove.
5. `delete_page` on a favourite: `list_favorites` hides it; restore it and it is back.
6. `get_activity_log` shows the three writes; the Claude Activity page does not list the favourite blocks.
7. The next day's usage report: D1 rows, Worker requests and neurons are flat.

**Rollback.** Revert the Worker and the patch. Favourite blocks written by the server are ordinary app data, and the app reads them as before.

## 10. Out of scope

- Favouriting blocks (the header menu's zoomed-in case).
- Removing a favourite when `delete_page` runs (reads filter it instead, and a restore brings it back).
- Cleaning up hidden slots (link-less, duplicates) on reorder.
- Favourite writes on E2EE graphs.
- A single `set_favorites` tool that diffs a desired list (it cannot class add and remove separately for the delete table).
- Any D1 migration, kb-index change or semantic index change.

## 11. Open questions for the owner

1. **Bottom or top?** Claude appends new favourites at the bottom; the app puts them at the top. Is bottom what you want?
2. **E2EE graphs.** All favourite writes are refused there, not only the create path. Do you want writes allowed on E2EE graphs when `$$$favorites` exists, once we know an unencrypted empty block title is safe for E2EE clients?
3. **Target policy.** Add allows what the app's page menu allows: pages, journals, tags and properties, including visible built-in ones, but not blocks, assets or uuid-named pages. Should built-in pages, tags or properties be refused, or blocks allowed as the header menu does?
4. **Create path.** If a non-E2EE graph has no `$$$favorites`, the handler creates it. Do you prefer a 409 refusal instead? A read-only check of your graphs (through the backup snapshot) would show whether any lacks the page.
5. **Dangling favourites.** `delete_page` leaves the favourite hidden and restoring the page brings it back. Should `delete_page` remove it instead, as the app does?
6. **If favouriting bumps the target's `:block/updated-at`**, each call would re-embed one page (a few neurons). Build anyway and document it, or stop?
