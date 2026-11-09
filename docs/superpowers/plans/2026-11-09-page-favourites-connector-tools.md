# Page favourites through the connector: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stages 1 to 3, `scripts/check.sh` in Stage 4), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can read, add, remove and reorder the favourites list in a graph. Patch 0038 adds `GET /favorites`, `PUT /pages/:page-id/favorite` and `PUT /favorites` to the semantic handler, reimplementing the app worker's favourites code with the guards the app leaves out (no silent skips, permutation check, lookup by uuid, no E2EE writes). The connector exposes them as the generated tools `list_favorites`, `set_page_favorite` and `reorder_favorites`, classified in every connector table, with a remove counted as a delete.

**Architecture:**
- **One upstream patch, `patches/0038-semantic-page-favorites.patch`**, grown over Stages 1 to 3 and regenerated against the 0037 baseline each time, in `worker/handler/semantic.cljs`, `worker/routes/semantic.cljs` and a new test namespace. Each stage leaves a complete, passing patch.
- **Each patch stage classifies its own tool in the connector.** The connector generates a tool for every operation in the vendored openapi, and `ANNOTATIONS`, `DELETE_RULES`, `SNAPSHOT_PLAN` and `readable.ts` each throw for an unclassified tool. CI rebuilds the vendor from `patches/` on every push, so a stage that adds a route and leaves the connector for later would be red on CI even if the local vendor were stale. Each of Stages 1 to 3 therefore re-vendors and adds that one tool's connector entries, tests and manifest line. This keeps every commit green and each tool reviewable with its server half.
- **Stage 1, the read:** `favorites-page` (by deterministic uuid), `favorite-slots`, `visible-favorites`, `GET /favorites`, and `list_favorites` in the connector.
- **Stage 2, add and remove:** `PUT /pages/:page-id/favorite`, its target policy and refusals, the E2EE refusal, the guarded create path, read-back, and the pins on `:block/updated-at`, refs, the semantic feed and `editedBy`. Then `set_page_favorite` in the connector with its `when` delete rule, dry run, the new `getFavorites` snapshot source and the access tests. **This stage has the owner stop point** (spec §5, §9): if adding a favourite bumps the target's `:block/updated-at`, the build stops there.
- **Stage 3, reorder:** `PUT /favorites`, the permutation check, the slot-rewrite with `save-block`, and the `save-block` link and refs pins. Then `reorder_favorites` in the connector as a `never` delete.
- **Stage 4, the contract:** the Favourites paragraph in `connector_help`, the readable summary text, and help tests. README §11.8, the patch list in README §1 and the `docs/solutions` update are the lane's docs step (see the end).
- **No migration, no D1, KV, Vectorize or semantic-index change** (spec §5). The favourite block is hidden and has an empty title, so the block-changes feed never lists it.
- **Order:** the read first, because both writes read back through it and the audit snapshot mirrors it; then the write whose cost question can stop the build; then the write that depends on the same pins; then the text Claude reads.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real `sync-handler/handle-http` on a real conn built by `create_graph`, via `with-graph` as `semantic_promote_page_to_tag_test.cljs` does); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-11-09-page-favourites-connector-tools-design.md`. Read it first. It is the authority; section numbers below (§3.4 and so on) are the spec's. Spec §9's build order puts all handler tests first and the connector after the re-vendor; this plan folds each endpoint's connector entries into the stage that adds the endpoint, for the reason under *Architecture*, and still settles every pin (spec §8 item 9) before the connector entry that depends on it is written.

## Global constraints

- **Names, exactly:**
  - patch `patches/0038-semantic-page-favorites.patch`; upstream test namespace `logseq.db-sync.semantic-favorites-test` in `deps/db-sync/test/logseq/db_sync/semantic_favorites_test.cljs`, required from `test_runner.cljs` after `semantic-display-type-test`;
  - in `worker/handler/semantic.cljs`: `favorites-page-uuid` (`(common-uuid/gen-uuid :builtin-block-uuid "$$$favorites")`), `favorites-page`, `favorite-slots`, `visible-favorites`, `favorite-response` (`{uuid, title, kind}`), `favourite-refusal` (the spec's name, in `promotion-refusal`'s shape), `favorites-page-tx` (the reimplemented `build-favorites-page`), `ensure-favorites-page!`, `read-back-favorites!`, and a `favorite-handlers` dispatch set beside `capture-and-tag-handlers`;
  - handler keys `:semantic/favorites-list`, `:semantic/pages-favorite`, `:semantic/favorites-reorder`; operation ids `listFavorites` (`GET /api/v1/graphs/:graph-id/favorites`, `logseq/read`, rate class read), `setPageFavorite` (`PUT /api/v1/graphs/:graph-id/pages/:page-id/favorite`, `logseq/write`, rate class write), `reorderFavorites` (`PUT /api/v1/graphs/:graph-id/favorites`, `logseq/write`, rate class write);
  - connector tools `list_favorites`, `set_page_favorite`, `reorder_favorites`; snapshot source `"getFavorites"`.
- **Messages, in the spec's wording (§3.4, §3.5, §4):**
  - `favourites can't be changed on E2EE graphs; the favourites page and its blocks are encrypted` (400);
  - `page-id: no page X` (404, unknown or hidden);
  - `page-id: "T" (uuid) is in the Recycle bin`, `… is a block, not a page`, `… is an asset`, `… has a uuid name` (400, add only);
  - an unknown body field refused naming it (`favourite: not a field; the body takes favorite and dry-run`), and `favorite: must be true or false`;
  - `graph has a $$$favorites page with an unexpected uuid; nothing was changed` (409);
  - `page-ids: entry 2: "X" (uuid) is not a favourite; entry 3: duplicate of entry 1; missing: "Y" (uuid), "Z" (uuid)` (400, every problem in one message, entries numbered from 0 as every batch refusal in this handler is);
  - `favourite did not read back` (500);
  - results `added`, `removed`, `already a favourite`, `was not a favourite`.
- **Every check runs before anything is written.** A failure refuses the whole call, naming `page-id`, the field or each entry.
- **One transaction, one tx id.** Each write, including the create path, runs inside one `atomic-write!` (`semantic.cljs:2481`) with `(dissoc creator :stamp?)` (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). `handle` already seeds the max order key before dispatch (`:5239`); a test proves the new handlers are reached through that path.
- **No silent success.** A missing page is created or refused, never skipped; a non-permutation is refused up front; every real write is re-read from `@conn` after commit and a mismatch answers 500.
- **Lookup by uuid only.** No code in this patch reads `:block/name "$$$favorites"` except the 409 guard before the create path.
- **Free plan** (spec §5): a write costs about 2 D1 rows read, 3 rows written and 3 Worker requests (front Worker, the `getFavorites` before-snapshot, the write); `list_favorites` about 1 row read, 0 written, 2 requests; 0 neurons and 0 Vectorize dimensions. Each stage's commit body states its cost per call.
- **Tests run the real thing.** Every upstream test goes through `handle-http`, the real outliner and a `create_graph` db; only the read-back mismatch test (Stage 2) stubs a step, and is labelled so (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Every new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Example data only (`Example`, `Projects`, `sync.example.com`, alias `test`).
- **Contract with Claude.** Upstream route descriptions land with the behaviour (spec §3.6). Run `npm --prefix connector run update:manifest` in each of Stages 1 to 3 (a tool is added) and say in the commit body that the manifest gained exactly one tool.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page uuids, hostnames or tokens.

### Working on patch 0038 (Stages 1 to 3)

Follow the `add-upstream-patch` skill. Patch 0037 (PR 46) is on this branch but not on `origin/main`; if 0037 changes before this merges, rebase and regenerate 0038 against the new baseline (spec risk 9). Once, before Stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0037
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0037"
git -C .upstream tag -f baseline
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                    # the vendor matches 0037 before anything is added
```

At the end of each of Stages 1 to 3:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-favorites|semantic-edit-stamps|semantic-block-changes|semantic-promote-page-to-tag'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0038-semantic-page-favorites.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 38 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/`, the vendored files and the connector carry the change. To see an upstream test fail before the stage's code, stash the handler change (`git -C .upstream stash push -- deps/db-sync/src`), run, and pop. To see a connector test fail first, write it before the connector entry and run `npm --prefix connector test -- <file>` against the freshly vendored tool (it fails as an unclassified tool or a wrong rule).

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Sync*, *Cost (Workers Free plan)*, *Security* and *Contract and docs*.
- The spike `docs/spikes/2026-11-09-page-favourites-through-the-connector.md` and its *Challenge* section; `docs/solutions/api/favourites-are-app-worker-code-the-server-must-reimplement-them.md`.
- `worker/handler/semantic.cljs` (line numbers on the 0037 baseline, checked by the spec): `find-visible-entity` (`:344`), `rejecting` and `dry-run-conn` (`:1621`, `:1640`), `stamp-qualifying-attributes` and `stamp-target?` (`:1797`, `:1817`), `ensure-activity-page!` (`:1868`, the precedent for a hidden page created in a write's tx-conn), `resolve-page-selector` (`:2131`), `atomic-write!` (`:2481`), `promotion-refusal` and the promote handler (`:3047`, `:3222`), the handler sets and `handle` (`:5125`-`:5240`).
- `worker/routes/semantic.cljs`: the `promotePageToTag` route, description, parameters, request schema and responses (`:31`, `:172`, `:303`, `:433`, `:630`, `:649`), and `dry-run-schema`.
- Upstream app code the patch mirrors (read, not required by the worker): `src/main/frontend/worker/handler/graph.cljs:15-117` (`set-page-favorite`, `reorder-favorites`, `get-favorite-pages`), `deps/db/src/logseq/db.cljs` `build-favorite-tx`, `deps/db/src/logseq/db/sqlite/create_graph.cljs:195-201` (`build-favorites-page`), `src/main/frontend/components/page_menu.cljs:106-111`, `src/main/frontend/components/header.cljs:185-201`, `src/main/frontend/util/entity.cljs:49-54` (`page?`), `deps/outliner/src/logseq/outliner/core.cljs` `get-target-block` and `get-block-orders` (`:715-722`, `:933-938`), `deps/outliner/src/logseq/outliner/pipeline.cljs:120-124`.
- Tests: `semantic_promote_page_to_tag_test.cljs` (the `with-graph` and request helpers to copy), `semantic_edit_stamps_test.cljs` (the stamp header), `semantic_block_changes_test.cljs` (the feed), `e2ee_semantic_test.cljs` (an E2EE graph).
- `docs/solutions/sync/order-key-not-seeded-for-server-writes.md`, `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`, `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`, `docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`, `docs/solutions/cost/d1-reads-from-indexer-scans.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`, the no-delete design `docs/superpowers/specs/2026-11-08-service-token-write-no-delete-design.md`, and the previous plan, `docs/superpowers/plans/2026-11-08-code-block-display-type-write.md`.
- Connector: `connector/src/tools/spec.mjs` (`ANNOTATIONS`), `connector/src/tools/deletes.mjs` (`DELETE_RULES`, `DRY_RUN_TOOLS`, `deleteReason`, `declaredDryRun`), `connector/src/audit/snapshot.ts` (`SnapshotSource`, `SNAPSHOT_PLAN`, the e2ee fallback at `:419`), `connector/src/tools/readable.ts` (`NO_CONTEXT_TOOLS`), `connector/src/auth/access.ts`, `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`), and the tests `deletes.test.ts`, `audit-snapshot.test.ts`, `service-tokens.test.ts`, `readable.test.ts`, `tools.test.ts`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **`page-id` `"$$$favorites"`** (the hidden page's own title): 404, never favourited (Stage 2).
2. **A visible built-in page, a journal, a tag and a property:** each accepted, as the page menu allows (spec §3.4 step 3) (Stage 2).
3. **A title in another case than the stored one, and a title two pages share ignoring case:** resolved as `resolve-page-selector` resolves it; the second answers 409 with candidates (Stage 2).
4. **Remove of a recycled target:** clears every slot linking it (spec §3.4 step 4); add of the same page is refused naming the Recycle bin (Stage 2).
5. **`favourite` (UK spelling) and `favorite: "true"` in the body:** refused naming the field, nothing written (Stage 2).
6. **Dry run of an add on a graph without `$$$favorites`:** the body shows the add, and afterwards the page still does not exist (Stage 2).
7. **First favourite on an empty `$$$favorites`:** a key is generated and the read-back lists one page (Stage 2).
8. **Add on a graph whose max order key sits on an ordinary page:** the new slot sorts after the last favourite and its key is unique graph-wide (spec risk 2) (Stage 2).
9. **List on an E2EE graph:** the page is found by uuid and the uuids and kinds come back; titles come back as the other list endpoints return them on E2EE (Stage 1).
10. **An impostor page named `$$$favorites` under another uuid while the real page exists:** list ignores it, and writes go to the real page (Stage 1 for list, Stage 2 for writes).
11. **Reorder with the current order:** answers the list and writes no tx (Stage 3).
12. **Reorder naming one page by uuid and again by title:** `entry 1: duplicate of entry 0` (Stage 3).
13. **Reorder with an empty list:** refused with `missing: …` when favourites exist; a 200 no-op when there are none (Stage 3).
14. **Reorder with a hidden slot between two visible ones:** the hidden slot keeps its link and key, and only visible slots are rewritten (Stage 3).
15. **The stamp header on for a reorder:** the rewritten slots carry no `editedBy` (Stage 3).
16. **`set_page_favorite` with no `body`, or `body.favorite` missing, for a `write-no-delete` token:** not a delete by the table (the server refuses the shape), so it reaches the server and answers its 400 (Stage 2).

---

### Stage 1: Patch 0038, finding the page and `list_favorites`

**Goal:** `GET /favorites` returns the visible favourites in sidebar order, found by the deterministic uuid; the connector has `list_favorites`. Lands spec §3.2, §3.3, §3.6 (list half), §4 (`list_favorites`), §8 items 5 (list half), 6 (list half) and 7 (list half), and acceptance 3 (lookup half) and 7.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/test/logseq/db_sync/semantic_favorites_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `favorites-page-uuid`, `favorites-page`, `favorite-slots` (children sorted with `ldb/sort-by-order`), `visible-favorites` (keeps a slot only when its `:block/link` resolves to an entity neither recycled nor hidden, drops later duplicates), `favorite-response` (`kind` as the other endpoints name it: page, journal, tag, property); the `:semantic/favorites-list` handler; `favorite-handlers` and its dispatch in `handle`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `listFavorites` route, description (sidebar order; skipped slots; empty when the page is missing; works on E2EE) and response schema `FavoritesResponse` (`{favorites: [{uuid, title, kind}]}`).
- Create: `patches/0038-semantic-page-favorites.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`); `connector/src/tools/spec.mjs` (`list_favorites: READ`); `connector/tools-manifest.json` (via `update:manifest`); `connector/test/tools.test.ts`, `connector/test/service-tokens.test.ts`.

**Interfaces produced:** `(visible-favorites db)` returning ordered `[{:slot slot-entity :target target-entity}]`, and `(favorite-response target)`. Stages 2 and 3 read back through them, and the connector's `getFavorites` source (Stage 2) reads the route they serve.

- [ ] **Step 1: Write the failing tests**, each through `handle-http` on a `create_graph` db:
  - `list-in-sidebar-order`: three favourites built with `ldb/build-favorite-tx` through the outliner list in sibling order with `uuid`, `title` and `kind`.
  - `list-skips-hidden-slots` (spec §8 item 7, list half): a link-less slot, a slot whose target is recycled (through the real `deletePage`), and a second slot linking the same page are each left out; restoring the recycled page brings it back.
  - `list-missing-page-is-empty` (spec §8 item 6, list half): with `$$$favorites` retracted, `{favorites: []}` and 200.
  - `list-by-uuid-not-name` (spec §8 item 5, list half): the real page's `:block/name` changed in the fixture still lists; an impostor page named `$$$favorites` under another uuid is ignored (review focus 10).
  - `list-e2ee` (review focus 9): on an E2EE fixture the page is found and uuids and kinds come back.
  - `list-kinds`: a journal, a tag and a property favourite report their kinds.
- Connector (vitest):
  - `tools.test.ts`: `list_favorites` is generated with `{graph}` input and READ annotations.
  - `service-tokens.test.ts` (or the access test that covers read tokens): a `read` token is allowed `list_favorites`.
- [ ] **Step 2: Run on the 0037 baseline** and keep the failures (today: no route, 404; the connector has no such tool).
- [ ] **Step 3: Implement** as spec §3.2 and §3.3.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** look the page up by name; keep recycled targets; keep hidden targets; keep duplicates; keep link-less slots; sort by db id instead of order; answer 404 when the page is missing. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): list a graph's favourites through the semantic API`. Body: the quoted baseline failure, the mutation results, the manifest gained `list_favorites`, and cost (a read: about 1 D1 row read, 2 Worker requests, no audit row).

**Done when:** all 38 patches apply from scratch, the new namespace and the whole db-sync suite pass, `list_favorites` is in the vendored API and the manifest, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0038, add and remove with `set_page_favorite`

**Goal:** `PUT /pages/:page-id/favorite` adds a page at the bottom of the list or removes every slot linking it, with the app UI's target policy, idempotent no-ops, the E2EE refusal, the guarded create path, dry run and read-back; the four unverified behaviours are pinned. The connector has `set_page_favorite` as a `when` delete with a `getFavorites` before-snapshot. Lands spec §3.4, §3.6 (set half), §3.7 (set half), §4 (`set_page_favorite`), §6, §7 risks 1, 2, 4 and 5, §8 items 1 to 6, 9 (add half) and 10, and acceptance 2, 3, 4 (add half), 5, 6, 9 (set half), 10 (snapshot) and 12.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - the `:semantic/pages-favorite` handler: body checks (`favorite` required boolean, `dry-run` optional, any other field refused naming it); E2EE refusal before anything else is read; `resolve-page-selector`; for add, `favourite-refusal` for unknown or hidden (404), recycled, block, asset and uuid-named (400), allowing exactly `entity/page?` kinds with a non-uuid `:block/name`; for remove, resolve by uuid even when recycled and skip the kind checks;
  - idempotent no-ops (`already a favourite`, `was not a favourite`) that write no tx;
  - `favorites-page-tx` and `ensure-favorites-page!`: on a non-E2EE graph with no page at the uuid, refuse 409 if any entity holds `:block/name "$$$favorites"`, else transact `create_graph`'s attributes inside the same `atomic-write!`;
  - the write: `outliner-core/insert-blocks!` with `[(ldb/build-favorite-tx uuid)]`, the page as target and `{:sibling? false :bottom? true}`; or `outliner-core/delete-blocks!` on every slot linking the target; outliner-op `:insert-blocks` or `:delete-blocks`; creator with `:stamp?` removed;
  - `read-back-favorites!`: the mutation returns `visible-favorites` from the tx-conn; a real write re-reads from `@conn` after commit and answers 500 `favourite did not read back` when the target's presence differs from the request;
  - dry run on `dry-run-conn`, answering the real body with `dry-run: true`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `setPageFavorite` route; its description (appended at the bottom, unlike the app, which adds at the top; `page-id` is a uuid or a title; what is refused and with which status; unavailable for E2EE graphs; `delete_page` hides the favourite and a restore brings it back; removing a favourite never touches the page); request schema `{favorite: boolean, dry-run?: boolean}` with no additional properties; responses 400, 404, 409 and 500 described.
- Modify: `patches/0038-…`, `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`, `connector/tools-manifest.json`.
- Modify: `connector/src/tools/spec.mjs` (`set_page_favorite: DESTRUCTIVE_IDEMPOTENT`); `connector/src/tools/deletes.mjs` (`set_page_favorite: { when: (args) => bodyOf(args)?.favorite === false ? "removes the page from the favourites list" : null }`, in the file's existing `when` shape, and `DRY_RUN_TOOLS.set_page_favorite = "body"`); `connector/src/audit/snapshot.ts` (`"getFavorites"` in `SnapshotSource`; the request builder for path `favorites`; `SNAPSHOT_PLAN.set_page_favorite = {source: "getFavorites", read: favorites, delete: {e2ee: () => null}, keep: "the ordered favourites list"}`); `connector/src/tools/readable.ts` (`NO_CONTEXT_TOOLS.set_page_favorite`: "the response names the page and returns the whole list").
- Modify: `connector/test/deletes.test.ts`, `connector/test/audit-snapshot.test.ts`, `connector/test/service-tokens.test.ts`, `connector/test/readable.test.ts`, `connector/test/tools.test.ts`.

**Interfaces produced:** `favourite-refusal`, `ensure-favorites-page!` and `read-back-favorites!` (Stage 3 reuses the first and last); the `getFavorites` snapshot source and its request builder (Stage 3 reuses both).

- [ ] **Step 1: Write the pin tests first** (spec §8 item 9, add half; spec §5 and §9 make the first one a stop point):
  - `add-does-not-bump-target-updated-at`: the target's `:block/updated-at` is the same before and after an add. **If it moves, stop: record the observed value and the tx that set it, commit nothing further, and take spec §11 question 6 to the owner before Step 2.**
  - `add-refs-and-backlinks`: the favourite block's `:block/refs` holds the target (the pipeline adds it); `getPageBacklinks` on the target answers the same groups and counts before and after (a hidden page's block must not appear as a reference; if it does, record it and say so in the commit body and the PR).
  - `add-not-in-feed`: the block-changes feed after an add lists no favourite block and does not re-list the target.
  - `add-no-edit-stamp`: with the stamp header on and the graph's mark setting on, the favourite block carries no `editedBy` or `claudeEditedAt`, and the Claude Activity query does not list it (spec risk 1).
- [ ] **Step 2: Write the remaining failing tests** (spec §8 items 1 to 6 and 10):
  - `add-appends-at-bottom` (spec §8 item 1): with favourites `[A B C]` and the graph's max order key on an ordinary page's block, sibling order is `[A B C new]`, the new key is unique graph-wide, and every datom of the call carries one tx id (review focus 7, 8).
  - `add-idempotent` and `remove-not-a-favourite` (spec §8 item 2): no tx written; results as named.
  - `remove-takes-duplicates` (spec §8 item 3): two slots linking one page both go, in one tx.
  - `refusals` (spec §8 item 4): the hidden built-in page and `"$$$favorites"` 404 (review focus 1); recycled 400 naming the Recycle bin; a block 400; a uuid-named page 400; an asset 400; an ambiguous title 409 with candidates (review focus 3); `favourite` and `favorite: "true"` 400 naming the field (review focus 5); each with the db unchanged.
  - `allowed-kinds` (review focus 2): a visible built-in page, a journal, a tag and a property are each added.
  - `remove-recycled-target` (review focus 4).
  - `e2ee-refuses-every-write`: add and remove on an E2EE fixture answer 400 with the message, and the entity count is unchanged.
  - `impostor-name` (spec §8 item 5, write half): with the real page missing and a page named `$$$favorites` under another uuid, add answers 409 and nothing is created; with the real page present, the add goes to it (review focus 10).
  - `missing-page-created` (spec §8 item 6, write half): with no page at the uuid, an add creates it with the same attributes as a `create_graph` page (compared attribute by attribute, timestamps excepted) in the same tx as the insert (spec risk 5).
  - `dry-run` (spec §8 item 10): add, remove and the create path answer the real body with `dry-run: true`, and the db is unchanged afterwards (review focus 6).
  - `read-back-mismatch-rejects` (**stubs a step; labelled**): with `outliner-core/insert-blocks!` redefined to write nothing, the call answers 500 `favourite did not read back`.
  - `seeded-order-key`: the handler is reached through `handle`, so a server-written favourite after a client-written block with a high key does not reuse it (`docs/solutions/sync/order-key-not-seeded-for-server-writes.md`).
- Connector (vitest):
  - `deletes.test.ts`: `set_page_favorite {favorite: false}` returns the reason; `{favorite: true}`, a missing body and a missing `favorite` return null (review focus 16); `DRY_RUN_TOOLS` matches the vendored openapi; the "matches ANNOTATIONS" test accepts it as a destructive `when` rule.
  - `service-tokens.test.ts`: a `write-no-delete` token is refused `{favorite: false}` with 0 sync calls and an audit row `refused`, and allowed `{favorite: false, dry-run: true}` and `{favorite: true}`; a `read` token is refused both.
  - `audit-snapshot.test.ts`: the plan reads path `favorites` with source `getFavorites`; a remove's before-snapshot holds the list; an E2EE graph's snapshot is the list (the read works there) and the e2ee fallback is never called.
  - `readable.test.ts`: `set_page_favorite` is classed no-context.
- [ ] **Step 3: Run on the Stage 1 tree** and keep the failures (no route; unclassified tool in the connector).
- [ ] **Step 4: Implement** as spec §3.4 and §3.7 (set half).
- [ ] **Step 5: Run the patch workflow above.** **Mutation check:** drop `:bottom? true`; skip the E2EE refusal; look the page up by name; skip the impostor 409; allow blocks; allow recycled targets on add; refuse recycled targets on remove; remove only the first duplicate slot; keep `:stamp?`; skip the read-back; write on dry run; in the connector, make the rule `always`, make it `never`, drop the dry-run entry, and point the snapshot at `getPage`. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): add and remove page favourites, set_page_favorite`. Body: the quoted baseline failures, what each pin showed (the `:block/updated-at`, refs, backlinks, feed and stamp results, stated as observed), the mutation results, the manifest gained `set_page_favorite`, and cost (about 2 D1 rows read, 3 written, 3 Worker requests per write; 0 neurons).

**Done when:** every pin is settled and recorded (or the build has stopped for the owner), every spec §8 item 1 to 6 and 10 passes, the whole db-sync suite passes, the connector refuses a no-delete remove before any sync call, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0038, reorder with `reorder_favorites`

**Goal:** `PUT /favorites` takes the full list in a new order, refuses anything that is not a permutation of the visible favourites in one message naming every problem, and rewrites the link of each visible slot whose page changes, keeping every order key and every hidden slot. The connector has `reorder_favorites` as a `never` delete. Lands spec §3.5, §3.6 (reorder half), §3.7 (reorder half), §4 (`reorder_favorites`), §7 risk 3, §8 items 8 and 9 (reorder half), and acceptance 4 (reorder half), 8 and 9 (reorder half).

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: the `:semantic/favorites-reorder` handler: body checks (`page-ids` required array, `dry-run` optional, any other field refused); E2EE refusal; every entry resolved with `resolve-page-selector`; problems collected (not a favourite, duplicate, missing) against `visible-favorites` and answered in one 400; the walk over visible slots that `save-block`s `:block/link` where it changes, inside one `atomic-write!` with outliner-op `:save-block` and `:stamp?` removed; no tx when nothing changes; read-back that answers 500 when the order differs; dry run.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `reorderFavorites` route, description (pass the full list, call listFavorites first, hidden slots are kept, order keys unchanged, unavailable for E2EE graphs), request schema and responses.
- Modify: `patches/0038-…`, the vendored files, `connector/tools-manifest.json`.
- Modify: `connector/src/tools/spec.mjs` (`reorder_favorites: DESTRUCTIVE_IDEMPOTENT`); `connector/src/tools/deletes.mjs` (`reorder_favorites: { never: "rewrites which page each favourite slot links; the permutation check removes nothing" }`, `DRY_RUN_TOOLS.reorder_favorites = "body"`); `connector/src/audit/snapshot.ts` (`SNAPSHOT_PLAN.reorder_favorites` with the Stage 2 source); `connector/src/tools/readable.ts` (`NO_CONTEXT_TOOLS.reorder_favorites`).
- Modify: `connector/test/deletes.test.ts`, `connector/test/audit-snapshot.test.ts`, `connector/test/service-tokens.test.ts`, `connector/test/readable.test.ts`, `connector/test/tools.test.ts`.

- [ ] **Step 1: Write the pin tests first** (spec §8 item 9, reorder half; spec risk 3):
  - `reorder-save-block-keeps-link-and-refs`: after a swap, each slot's `:block/link` is the new page and its `:block/refs` holds the new page and not the old one.
  - `reorder-does-not-bump-targets`: neither page's `:block/updated-at` moves. **If one does, stop as in Stage 2 and take it to the owner.**
  - `reorder-backlinks-and-feed`: `getPageBacklinks` for both pages and the block-changes feed are unchanged.
  - `reorder-no-edit-stamp` (review focus 15).
- [ ] **Step 2: Write the remaining failing tests** (spec §8 item 8):
  - `reorder-permutation`: reversing `[A B C]` rewrites links, order keys are byte-equal before and after, the read-back equals the request, one tx id.
  - `reorder-refusals`: one 400 naming not-a-favourite, duplicate (by uuid and by title, review focus 12) and missing entries together, with the db unchanged; an empty list with favourites refused, with none a 200 no-op (review focus 13); an unknown body field refused.
  - `reorder-keeps-hidden-slots` (review focus 14).
  - `reorder-same-order-writes-nothing` (review focus 11).
  - `reorder-e2ee-refused`, `reorder-dry-run` (db unchanged), and `reorder-read-back-mismatch` (**stubs a step; labelled**: the slot write redefined to skip one slot answers 500).
- Connector (vitest):
  - `deletes.test.ts`: `reorder_favorites` returns null with representative arguments (it joins the never tools' test); dry-run declared.
  - `service-tokens.test.ts`: a `write-no-delete` token is allowed `reorder_favorites`; a `read` token is refused.
  - `audit-snapshot.test.ts`: the reorder plan reads `favorites`.
  - `readable.test.ts`: classed no-context.
- [ ] **Step 3: Run on the Stage 2 tree** and keep the failures.
- [ ] **Step 4: Implement** as spec §3.5 and §3.7 (reorder half).
- [ ] **Step 5: Run the patch workflow above.** **Mutation check:** skip the permutation check (silently skip unknown entries as the app does); report only the first problem; allow duplicates; rewrite hidden slots; delete hidden slots; rewrite order keys instead of links; write a tx when nothing changes; keep `:stamp?`; skip the read-back; in the connector, classify reorder as `when` or `always`. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): reorder favourites, reorder_favorites`. Body: the quoted failures, what the pins showed, the mutation results, the manifest gained `reorder_favorites`, and cost (as Stage 2; at most one `save-block` per visible slot, tens of slots).

**Done when:** every spec §8 item 8 case passes, the reorder pins are recorded, the whole db-sync suite passes, a no-delete token can reorder, and `scripts/check.sh --upstream` is green.

---

### Stage 4: The connector contract

**Goal:** Claude's help text describes favourites as Stages 1 to 3 built them. Lands spec §3.7 (`connector_help`), §4 (help paragraph) and acceptance 10 (help half).

**Files:**
- Modify: `connector/src/tools/handwritten.ts`: `CONNECTOR_HELP` gains the Favourites paragraph of spec §4, adjusted to what the pins showed (if a pin recorded a backlink or a bumped timestamp that the owner accepted, the paragraph says so).
- Modify: `connector/test/tools.test.ts` (help assertions); `connector/tools-manifest.json` only if `check:manifest` says so (it should not: help text is not in the manifest).

- [ ] **Step 1: Write the failing tests:** `CONNECTOR_HELP` names `list_favorites`, `set_page_favorite` and `reorder_favorites`, says new favourites go at the bottom unlike the app, that `favorite: false` is a delete a no-delete token can't do (a dry run can), that reorder takes the full list after `list_favorites`, that `delete_page` hides a favourite and a restore brings it back, and that favourites are unavailable on E2EE graphs (one assertion each, so dropping one fails); the generated descriptions of the three tools carry the openapi text (bottom, E2EE).
- [ ] **Step 2: Run and keep the failures** (the description assertions pass already from Stages 1 to 3's vendor; record which, since only the help assertions can fail first).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate:** `npm --prefix connector run check:manifest` (say whether it changed) and `scripts/check.sh`. **Mutation check:** drop each help phrase. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): describe favourites to Claude`. Body: the failures seen, which description tests passed before the change and why, the manifest result, and cost (none: text only).

**Done when:** the help and the tool descriptions match the server's behaviour, the manifest check passes, and `scripts/check.sh` is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §1 gains patch 0038 in the list of patches; README §11.8 gains a favourites entry (the three tools, append at the bottom unlike the app, the target policy, the delete classification and dry run, hidden slots and `delete_page`, E2EE refused) and its tool list gains the three tools; the annotations paragraph names `set_page_favorite` and `reorder_favorites` among the destructive tools. Update `docs/solutions/api/favourites-are-app-worker-code-the-server-must-reimplement-them.md` with what the pins showed. Consider a REVIEW.md *API and patches* line if the lane finds a recurring class (for example, a reimplemented app-worker operation that silently skips what it can't resolve).
- **PR body:** each stage's first failures, every stage's pin results stated as observed, the mutation results, the commit `scripts/check.sh --upstream` ran on and what it skipped, that `tools-manifest.json` gained three tools, the cost table from spec §5, and the Logseq skill note from spec §4: favourites can now be read and edited; call `list_favorites` before reordering and pass the full list; Claude adds new favourites at the bottom; removing a favourite is a delete for `write-no-delete` tokens (dry run allowed); deleting a page leaves its favourite hidden until the page is restored. The PR is stacked on PR 46 (patch 0037) and merges after it.
- **Live check** (spec §9, after merge): on the test graph (alias `test`), the seven steps of spec §9; record outcomes, not page names.
- **Owner questions** in spec §11 stay open; only question 6 can block a stage (Stages 2 and 3 stop if the target's `:block/updated-at` moves). Question 1 (top instead of bottom) flips `:bottom? true` and the append test in Stage 2; question 2 would lift the E2EE refusal once a test shows an unencrypted empty title is safe; question 3 changes the kind checks in Stage 2's `favourite-refusal`; question 4 replaces `ensure-favorites-page!` with a 409 and drops `missing-page-created`; question 5 is a separate item on the tracker. Any change lands before the PR merges.
