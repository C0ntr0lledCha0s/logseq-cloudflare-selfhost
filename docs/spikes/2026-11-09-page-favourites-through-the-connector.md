# Spike: page favourites through the connector

Date: 2026-11-09. Stacked on patch 0037 (code blocks, PR 46), so a build would be patch 0038 plus connector tools. Research read upstream at the patched checkout (`.upstream`, base `UPSTREAM_REF` e7e9c97 plus patches 0001 to 0037) and this repo's connector. **No tests or builds were run.** Everything below comes from reading source and design docs. Items marked *inferred* were not seen in code.

## Questions

1. Where do the `$$$favorites` page, the favourite block shape and the set, reorder and list functions live, and do they run inside `deps/db-sync`?
2. Can the semantic handler add, remove and reorder safely: one tx id, seeded order key, ordinary sync txs, a missing favourites page, duplicates, odd targets, outliner guards?
3. What tool shape, delete-table class and service-token modes fit?
4. What does it cost on the Free plan, and does it touch the semantic index, kb-index, audit log or D1 schema?
5. Build, don't build or revisit?

## Short answer

**Build, as a small feature.** The data model is simple and stable (one hidden page whose child blocks carry `:block/link`), and the handler already has what a safe write needs: order-key seeding on every request, `atomic-write!` for one tx id, and `find-visible-entity` for target checks. The cost is a few D1 rows per call and nothing on Workers AI or Vectorize. There is no upstream API to call, so patch 0038 must reimplement about 30 lines of the app's worker code. Four behaviours need a test, and one needs the owner to decide, before the spec is fixed (see *Risks*).

## Findings

### 1. Data model and upstream functions

- **Page.** Name and title are the string `"$$$favorites"` (`common-config/favorites-page-name`, `deps/common/src/logseq/common/config.cljs:62`). It has no `:db/ident`. `build-favorites-page` creates it at graph creation (`deps/db/src/logseq/db/sqlite/create_graph.cljs:195-201`, added to the hidden pages at `:260`) with a deterministic uuid `(common-uuid/gen-uuid :builtin-block-uuid "$$$favorites")`, `:block/tags [:logseq.class/Page]`, `:logseq.property/hide? true`, `:logseq.property/built-in? true`, and timestamps.
- **Favourite block.** `ldb/build-favorite-tx` (`deps/db/src/logseq/db/frontend/db.cljs:36-40`) gives `{:block/link [:block/uuid <page-uuid>] :block/title ""}`. The outliner insert adds `:block/parent`, `:block/page` and `:block/order`. Order is the ordinary fractional key, read with `ldb/sort-by-order`.
- **Operations.** They live in the app's db worker, not in `deps/db` or `deps/outliner`: `src/main/frontend/worker/handler/graph.cljs` has `favorite-block` (:20), `:thread-api/get-favorite-pages` (:34, drops `ldb/recycled?` targets), `favorite-page-ops` (:68, `:insert-blocks` under the page with opts `{}`), `unfavorite-page-ops` (:76, `:delete-blocks`), `:thread-api/set-page-favorite` (:81, idempotent), `reorder-favorites-ops` (:100) and `:thread-api/reorder-favorites` (:111). Other readers: `initial_data.cljs:375` `get-favorites` and `render_resource/basic.cljs:33-63`. The plugin API only reads (`logseq.api.app/get_current_graph_favorites`). Nothing in `cli/` touches favourites.
- **Not reachable from db-sync.** `deps/db-sync/deps.edn` depends only on common, db and outliner, and a grep for `favorite` in `deps/db-sync/src` and `test` finds nothing. The handler must reimplement the three ops. It can reuse `ldb/build-favorite-tx`, `favorites-page-name`, `ldb/get-page`, `ldb/sort-by-order` and the outliner's `insert-blocks!`, `delete-blocks!` and `save-block`.

### 2. Safe server writes

- **One tx id.** `atomic-write!` (`handler/semantic.cljs:2481`) wraps `authored-write!` (:1933) and `ldb/batch-transact-with-temp-conn!`, the path batch writes already use (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). Changes reach clients as ordinary sync txs (`broadcast-change!`, :477).
- **Order key.** `handle` runs `(db-order/reset-max-key! (db-order/get-max-order db))` before every dispatch (:5239), so a new favourite takes a key above the graph-wide max (`docs/solutions/sync/order-key-not-seeded-for-server-writes.md`). Whether the app's `{}` insert opts append or prepend is **not verified** (`deps/outliner/src/logseq/outliner/core.cljs:898-935`). The handler should pass `:bottom? true`, as `insert-tree!` (:1546) does, and a test must pin it.
- **Reorder.** The app does not move blocks. It walks the existing blocks in order and, where slot *i* links to a different page from the requested *i*th page, rewrites that block's `:block/link` with `:save-block`. Order keys never change, so no seeding is needed. The app silently skips unresolvable uuids and does not check the list is a permutation of the current favourites; the server must refuse that up front.
- **Remove.** `delete-blocks` hard-retracts the link block (`core.cljs:575-587`), with no Recycle step. The page is untouched. The block is not built-in, so the built-in refusal (`core.cljs:1317-1345`) does not fire.
- **Missing `$$$favorites`.** The app silently does nothing (`when-let` in `graph.cljs:68-73` and `:100-117`). Here that would be a silent success. The handler should create the page on the write's tx-conn with the `create_graph` attributes, following `ensure-activity-page!` (:1868), and reads should return an empty list. That is a raw transact, so its checks are hand-written (`docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`). Whether uploaded or older graphs ever lack the page is **unknown** (`docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md` says drift happens).
- **Duplicates.** Copy the app's check (`graph.cljs:20-26`, `:81-95`): add of a favourite and remove of a non-favourite change nothing, and the result says so (`already a favourite`, `was not a favourite`).
- **Targets.** `find-visible-entity` (:344) hides hidden and recycled entities. The promote-to-tag refusals (:3050-3070) are the in-repo pattern for 404 hidden, 400 recycled, built-in and non-page. The outliner does not validate `:block/link`; the pipeline only adds the target to `:block/refs` (`pipeline.cljs:120-124`). So every target rule is the handler's. Whether the app UI lets journals, tags, properties, classes or whiteboards be favourited is **unknown**; the worker only checks that the uuid resolves, and the page menu checks `entity/page?` and `:block/name`.
- **Private-tag 500.** Not reached: the favourite block has no `:block/tags` (`docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`).
- **Deleted pages.** Outliner `delete-page!` does not touch favourites (only a TODO at `deps/outliner/src/logseq/outliner/page.cljs:127`). The app unfavourites in the frontend (`handler/common/page.cljs:244-248`), which the server never runs. So `delete_page` through the connector leaves the favourite block; reads must drop recycled targets, and restoring the page brings the favourite back. What a permanent purge leaves behind (an empty, link-less block or nothing) is **unknown**.
- **Backlinks.** The favourited page gains a ref from a hidden block. `indexed-reference-response` removes hidden referrers (:328, :2370), so backlinks should not change (*inferred*; needs a test).

### 3. Tool shape, delete table and access modes

Proposed (not decided):

| Tool | Arguments | Result |
|---|---|---|
| `list_favorites` | `graph` | Ordered list: title, uuid, kind. Skips recycled targets. Empty list if the page is missing. |
| `set_page_favorite` | `graph`, `page` (uuid or title, via `resolve-page-selector` :2131), `favorite: true\|false`, `reason`, `dry-run` | `added`, `removed`, `already a favourite` or `was not a favourite`, then the read-back list. |
| `reorder_favorites` | `graph`, `pages[]` (the full desired order) | The read-back list. Refuses a list that is not a permutation: `entry 2: "X" is not a favourite`, `missing: "Y"`, `entry 3: duplicate of entry 1`. |

A single `set_favorites` (desired list, server diffs) would be smaller but cannot classify add and remove separately.

- **Plumbing.** Routes in `routes/semantic.cljs` (pattern: `promotePageToTag`, :31-32, :172, :303), then vendor and `update:manifest`. Each tool needs an `ANNOTATIONS` entry (`connector/src/tools/spec.mjs:57-96`), a `DELETE_RULES` entry (`deletes.mjs:103-150`) and a `SNAPSHOT_PLAN` entry (`connector/src/audit/snapshot.ts:140-170`); all three throw for an unclassified tool. Also `readable.ts:92`.
- **Delete table.** A remove retracts a block with nothing in its place, which is the table's definition of a delete (`deletes.mjs:5-11`), even though no page is deleted. Classify `set_page_favorite` with a `when` rule like `set_block_property`'s: `favorite === false` is a delete ("removes the page from the favourites list"), add is not. `reorder_favorites` is `never` (it rewrites links; the permutation check means nothing is removed). Remove must accept `dry-run` (`DRY_RUN_TOOLS`, `deletes.mjs:183-195`).
- **Access modes.** The code has `read`, `write-no-delete` and `write` (`connector/src/auth/access.ts:6-9`); the brief's "edit" and "full" do not exist, and the edit-service-token-scope design is about editing a token's graphs, mode and expiry, not a new mode. So `read` allows only `list_favorites`; `write-no-delete` allows add and reorder and refuses remove through `deletesRefusedBy` (`common.ts:132-140`); `write` allows all.
- **Audit pre-read.** `getPage` cannot read the hidden page, so the snapshot source should be the new list endpoint (`getFavorites` added to `SnapshotSource`, `snapshot.ts:23`), resolved the same way as the write (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`).

### 4. Free plan cost

See *Cost*. No D1 migration: favourites live in the graph's Durable Object, and `audit_log.tool` is `TEXT` with no `CHECK` (migration 0004).

## Cost

Per write call (add, remove, reorder), from the audit log's pinned costs (`connector/src/audit/log.ts:10-27`, README:813):

| Item | Per call | 300 a day (heavy) | Cap |
|---|---|---|---|
| D1 rows written | 3 (begin 2, finish 1) | 900 (0.9%) | 100k |
| D1 rows read | about 2 (finish 1, graph token about 1) | about 600 | 5M |
| Worker requests | 2 (front Worker, sync binding); 3 for a remove with a before-snapshot GET | 600 to 900 (0.9% at most) | 100k |
| Workers AI, Vectorize | 0 | 0 | 10k neurons, 5M dims |

`list_favorites` writes no audit row (only `get_activity_log` records reads) and costs 1 to 2 requests and about 1 row read. Front Worker CPU is JSON forwarding for tens of items, well inside 10 ms (*inferred*, not measured). The Durable Object's own row and CPU cost per tx was not measured.

- **Semantic index.** The feed lists a block only if it is not hidden and its title is not blank (`semantic.cljs:4990-4997`, patch 0014 :51-52). A favourite block fails both. The feed's trigger attributes do not include `:block/link` (patch 0014 :32-36), so the target page is not re-embedded (*inferred*; a test must assert the target's `:block/updated-at` does not change).
- **kb-index.** Hidden entities are excluded (patch 0013). Favourites change no titles, tags or membership, so they stay out of `KB_INDEX_WRITE_TOOLS` (`kb-index.ts:62-69`).
- **Activity log.** New tools appear automatically once they leave audit rows. Whether `stamp-tx` stamps the favourite block with `editedBy` is **unknown** (`stamp-target?`, :1817); pin it with a test.

## Risks

1. The favourite logic is app code, not a published API, and could be renamed or reshaped upstream. The data shape is also used by the exporter (`graph_parser/exporter.cljs` `insert-favorites`) and `initial_data.cljs`, so it looks stable (*inferred*).
2. A missing `$$$favorites` page needs a create path, which is a raw transact with hand-written checks.
3. `delete_page` leaves a dangling favourite. Reads must filter it, or the patch must also remove it on delete (a design choice).
4. The insert position with `{}` is unverified; pass `:bottom? true`.
5. Remove as a delete needs dry-run support and a new snapshot source, or the audit log cannot show what was removed.
6. Target policy is unknown from the app side; a wrong policy would let Claude favourite something the app never offers.
7. E2EE graphs: behaviour unknown. Refuse title resolution there like other handlers, or accept uuids only.

## What would change the answer

- **To revisit:** if upstream moves favourites into `deps/outliner` or a published API, wait and call that instead of reimplementing. Also if the owner does not use favourites from Claude often enough to justify three more tools in the tool list.
- **To don't build:** if a test shows that favouriting bumps the target page's `:block/updated-at` and that cannot be avoided, since every favourite would then re-embed a page (neurons and D1 reads per `docs/solutions/cost/d1-reads-from-indexer-scans.md`). Or if clients mishandle a server-created `$$$favorites` page (for example, a second page with the same uuid on a graph that already has one locally).
- **Smaller build:** if `$$$favorites` turns out to exist on every graph, drop the create path and refuse instead.

## Follow-ups

1. **Owner decision: target policy.** Which kinds may be favourited (pages, journals, tags, properties, classes, whiteboards). Check what the app's UI offers before the spec fixes it.
2. **Check `$$$favorites` exists on the owner's graphs** (read-only, through an existing read path or the backup snapshot), to decide create-or-refuse.
3. **Patch 0038: favourites endpoints.** `GET /api/v1/graphs/:graph-id/favorites` (scope `logseq/read`), `PUT /pages/:page-id/favorite` with `{favorite: bool}` and `dry-run`, `PUT /favorites` with `{page-ids: []}` (scope `logseq/write`, rate class `write`). Handler: resolve and check the target, idempotent add and remove, create-if-missing, one `atomic-write!` with `insert-blocks!` (`:bottom? true`), `delete-blocks!` or link-rewriting `save-block`, then read back before answering. Use patch 0027's layout (handler, routes, test namespace, test runner).
4. **Patch 0038 tests**, on a db built with `create_graph` and the real outliner, each seen to fail first: new key unique and greater than existing keys; one tx id; add idempotent; remove of a non-favourite; recycled and hidden targets refused; missing page created (or refused); reorder permutation errors name the entry; target `:block/updated-at` unchanged; backlinks unchanged; feed unchanged; `editedBy` stamping pinned. Upstream's `db_core_test.cljs:3727-3800` uses a hand-built conn and is not a substitute.
5. **Decide what `delete_page` does to favourites** (leave and filter, or remove in the same tx), and test it.
6. **Connector tools:** `list_favorites`, `set_page_favorite`, `reorder_favorites` with `ANNOTATIONS`, `DELETE_RULES` (`when favorite === false`), `SNAPSHOT_PLAN` with a `getFavorites` source, `readable.ts`, `connector_help`, regenerated `tools-manifest.json` and README §11.8.
7. **Logseq skill note** for the PR: favourites can now be read and edited; call `list_favorites` before reordering and pass the full list; removing a favourite is a delete for `write-no-delete` tokens (dry-run allowed); deleting a page leaves its favourite hidden until the page is restored.
8. **docs/solutions entry:** "Favourites are app-worker code; the server must reimplement them", covering the page shape, link-rewrite reorder and the silent no-op when the page is missing.
