# Blank-block cleanup and graph sync status: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stages 1, 3 and 4, `scripts/check.sh` in Stages 2 and 5), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two connector tools in one PR, built in stages. `get_sync_status` answers, in one read-only call, a graph's latest `t`, last write, block and page counts, clients online (as counts) and the semantic index's lag. `delete_blank_blocks` deletes the empty leaf blocks on up to 20 named pages, through a dry run that lists block ids and an apply that takes exactly those ids and re-judges each inside one transaction.

**Architecture:**
- **Two upstream patches.** `patches/0055-semantic-sync-status.patch` (Stage 1) adds `GET /api/v1/graphs/:graph-id/sync-status` and a presence-summary helper. `patches/0056-semantic-delete-blank-blocks.patch` (Stages 3 and 4) adds `POST /api/v1/graphs/:graph-id/blank-blocks/delete` and reuses that helper for its editing check. 0056 is generated against a baseline that already holds 0055, so each patch is reviewable alone and 0056 applies only after 0055.
- **Stage 1, the sync-status route:** patch 0055 and its upstream tests, with `getSyncStatus` added to `EXCLUDED_OPERATIONS` in the same commit, so the vendored API changes and the generated tool set does not.
- **Stage 2, the `get_sync_status` tool:** the semantic status builder moves out of `semantic-search.ts` into a shared function (no change to `semantic_index_status`), and a hand-written `src/tools/sync-status.ts` folds the route and the semantic state into one answer. Its `connector_help` line lands here, so the tool ships complete.
- **Stage 3, the blank predicate and the dry run:** patch 0056 with page resolution, the allow-list predicate and the dry run. The apply answers 400 without `block-ids` (the final behaviour) and 501 `apply is not built yet` with them. `deleteBlankBlocks` sits in `EXCLUDED_OPERATIONS` for this stage, so no half-built tool reaches Claude.
- **Stage 4, the apply and the tool:** the in-transaction re-judge, one `delete-blocks!` call, `confirm-removed!`, the replay test and the release-bundle checks. The exclusion is removed, and `delete_blank_blocks` is classified in every connector table (`ANNOTATIONS`, `FIRST_LINES`, `DELETE_RULES`, `DRY_RUN_TOOLS`, `readable.ts`, `SNAPSHOT_PLAN`) with its access and audit tests.
- **Stage 5, the contract:** `connector_help`'s deletes paragraph and `write-no-delete` list gain `delete_blank_blocks`, with the count-claims test over every count both tools' text states.
- **No migration, no new D1 table, no Vectorize or Workers AI use** (spec §3.3, §5). Deleted blocks reach the semantic cron as ordinary deletes.
- **Order** (spec §12 answer 1): `get_sync_status` first, because it is read-only and adds the presence helper Tool A reuses; then Tool A's riskiest judgement (the predicate) before its write; then the write; then the text Claude reads. Every stage leaves the gate green and could ship alone.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real `sync-handler/handle-http` on a real conn, with the `with-graph` and request helpers copied from `semantic_favorites_test.cljs`); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers`; Node for `scripts/release-query-check.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-20-blank-blocks-and-sync-status-design.md`. Read it first, including §12 (the owner's answers). It is the authority; section numbers below (§3.4 and so on) are the spec's. The spec's line numbers refer to `.upstream` commit `03352db` (patches 0001 to 0040). This branch carries patches 0001 to 0049, so the line numbers in *Read before starting* below were re-read on that baseline; re-read the source before relying on any of them.

## Global constraints

- **Names, exactly:**
  - patches `patches/0055-semantic-sync-status.patch` and `patches/0056-semantic-delete-blank-blocks.patch`;
  - upstream test namespaces `logseq.db-sync.semantic-sync-status-test` (`deps/db-sync/test/logseq/db_sync/semantic_sync_status_test.cljs`) and `logseq.db-sync.semantic-delete-blank-blocks-test` (`semantic_delete_blank_blocks_test.cljs`), each required from `test_runner.cljs` after the last semantic namespace;
  - in `worker/presence.cljs`: `presence-summary` (`[self caller-user-id]` → `{:connected :users :own :others :editing}`) and `editing-block-uuids` (`[self]` → a set of UUIDs), both reading the presence atom (`presence*`), never `getWebSockets`;
  - in `worker/handler/semantic.cljs`: `sync-status` (the response builder), `counted-page-ids`, `block-count`; and for Tool A `blank-attribute-allow-list`, `blank-candidate` (returns `nil` for a candidate or a reason keyword), `resolve-blank-pages` (the step 1 refusals), `blank-dry-run` and `apply-blank-deletes!`;
  - handler keys `:semantic/sync-status` and `:semantic/blank-blocks-delete`; operation ids `getSyncStatus` (`GET /api/v1/graphs/:graph-id/sync-status`, `logseq/read`, rate class read) and `deleteBlankBlocks` (`POST /api/v1/graphs/:graph-id/blank-blocks/delete`, `logseq/write`, rate class write, handled in `handle-bulk` next to `:semantic/blocks-delete-many`);
  - connector tools `get_sync_status` (hand-written, `connector/src/tools/sync-status.ts`, in `HANDWRITTEN_TOOLS`, not `SEMANTIC_TOOLS`) and `delete_blank_blocks` (generated); the shared builder `semanticStatusPart` in a new `connector/src/semantic/status.ts`.
- **Caps, one constant each, read by every test and by the tool text** (spec §3.4, §12 answer 5): 20 pages per call (`max-blank-pages`), 100 block ids per apply and 100 listed in a dry run (`max-blank-deletes`), 2,000 blocks per page (`max-outline-blocks`, existing), 10,000 blocks per call (`max-blank-scan`), 20 kept examples per page (`max-kept-examples`).
- **Messages, in the spec's wording (§3.4, §4):** `page-ids[i]: page not found` (404); `page-ids[i]: ambiguous title` with candidates (409); `page-ids[i]: same page as page-ids[j]` (400); `page-ids[i]: is a whiteboard`, `is a tag`, `is a property`, `is Private` (400); `blank blocks can't be judged on E2EE graphs: titles are ciphertext` (409); `page-ids: 1 to 20 pages` (400); `page-ids[i]: over 2000 blocks` and `page-ids[i]: the call is over 10000 blocks` (422); `block-ids is required unless dry-run is true` (400); `block-ids[i]: not a UUID`, `duplicate of block-ids[j]` (400), `block not found` (404); `block-ids[i]: no longer blank (it has text)`, `has children`, `referenced`, `being edited in the app`, `not on a listed page`, `not a plain block` (409); an unknown body field `X: not a field; the body takes page-ids, dry-run and block-ids` (400); reasons `has children`, `referenced`, `being edited`.
- **Every check runs before anything is written.** A refusal names the entry (`page-ids[i]` or `block-ids[i]`) and the reason, and the db and `t` are unchanged.
- **One transaction, one tx id.** The apply runs inside one `atomic-write! conn creator false :delete-blocks` with one `outliner-core/delete-blocks!` call (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). `handle` seeds the max order key before dispatch; a test reaches the handler through `handle`.
- **No silent success.** The apply reads back through `confirm-removed!` (500 naming survivors). `get_sync_status` never returns a field it could not read as a made-up value: unknown is `null`.
- **Exposure** (spec §6): `get_sync_status` returns counts only. No user id, email, username, name, editing block UUID, token, header or JWT content, in the route or the tool. A string-search test pins it on both.
- **Free plan** (spec §5): `get_sync_status` costs about 6 D1 rows read, 2 written (the read audit) and 2 Worker requests per call; `delete_blank_blocks` about 1 row read, 3 written, 2 Worker requests for a dry run and 3 for an apply (the `getBlocks` snapshot). 0 neurons, 0 Vectorize dimensions. Each stage's commit body states its cost per call.
- **Tests run the real thing.** Every upstream test goes through `handle-http`, the real outliner and a real graph; a test that stubs a step says so in its name and comment (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Every new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Example data only (`Example`, `Projects`, `sync.example.com`, alias `test`; the presence fixture's users are `user-a@example.com` and `user-b@example.com`).
- **Contract with Claude.** Upstream route descriptions land with the behaviour. Run `npm --prefix connector run update:manifest` in Stages 2 and 4 (a tool is added) and say in the commit body that the manifest gained exactly one tool; Stages 1 and 3 run `check:manifest` and say it is unchanged.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `semantic`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page UUIDs, hostnames or tokens. No live writes; a live check uses only alias `test`.

### Working on patches 0055 and 0056 (Stages 1, 3 and 4)

Follow the `add-upstream-patch` skill. `.upstream` currently holds another session's uncommitted work on top of a `baseline: patches 0001-0049` commit, so **move it aside rather than delete it**, then fetch fresh. Once, before Stage 1:

```bash
git -C .upstream status --short                                 # if anything is listed, keep it:
mv .upstream "$SCRATCH/upstream-before-blank-blocks"            # (only if it exists)
scripts/fetch-upstream.sh .upstream                             # applies 0001-0049
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0049"
git -C .upstream tag -f baseline
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                       # the vendor matches 0049 before anything is added
```

At the end of each patch stage (for Stage 1, `N=0055-semantic-sync-status`, `BASE=baseline`; for Stages 3 and 4, `N=0056-semantic-delete-blank-blocks`, `BASE=baseline-0055`):

```bash
scripts/upstream-test.sh .upstream 'semantic-sync-status|semantic-delete-blank-blocks|semantic-edit-stamps|semantic-uploaded-graph-schema'
(cd .upstream/deps/db-sync && pnpm test)                        # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached "$BASE" > "patches/$N.patch"
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"  # every patch applies from scratch
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                       # Stages 1 and 3: unchanged; Stage 4: update:manifest
scripts/upstream-test.sh .upstream --stop                       # build.sh removed worker-test.js (CLAUDE.md gotcha)
scripts/check.sh --upstream                                     # read every WARNING line: a skipped test proves nothing
```

After Stage 1's commit, freeze 0055 as the baseline for 0056:

```bash
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0049 + 0055"
git -C .upstream tag -f baseline-0055
```

Patch numbers follow spec §12 answer 8. Patches 0050 to 0054 are in other PRs; if they merge first, rename and regenerate on rebase, and never edit a shipped patch. `$SCRATCH` is the session's scratchpad. To see an upstream test fail before the stage's code, stash the handler change (`git -C .upstream stash push -- deps/db-sync/src`), run, and pop. To see a connector test fail first, write it before the connector code and run `npm --prefix connector test -- <file>`.

### Read before starting

- `REVIEW.md`, sections *Destructive operations keep their guards*, *API and patches*, *Sync*, *Cost (Workers Free plan)*, *Security* and *Contract and docs*.
- Spec §2 to §8 and §12; the no-delete design (`2026-11-08-service-token-write-no-delete-design.md`, which owns the delete table), the audit-log design (`2026-11-07-connector-write-audit-log-design.md`), the semantic search design (`2026-11-04-semantic-search-design.md`), and the previous plan, `docs/superpowers/plans/2026-11-09-page-favourites-connector-tools.md` (the stage and patch workflow this plan copies).
- `worker/handler/semantic.cljs` on the 0049 baseline (line numbers checked for this plan): `block-kind` (`:75`), `max-outline-blocks` (`:411`), `broadcast-change!` (`:480`), `list-pages` (`:483`), `dry-run-option`, `rejecting`, `dry-run-conn` (`:1831`, `:1840`, `:1859`), `request-creator` (`:2176`, the `x-logseq-sync-actor` claims; `:uuid` is the JWT `sub`), `confirm-removed!` (`:2378`), `resolve-page-selector` (`:2426`), `check-labels!` (`:2577`, the refusal shape `rejecting` answers), `referrer-ids` (`:2677`), `atomic-write!` (`:2776`), `handle-bulk` and `:semantic/blocks-delete-many` (`:5044`, `:5061`), the handler sets and `handle` (`:5805`, `:5892`).
- `worker/handler/datalog.cljs` `private-ids` (`:531`); `worker/presence.cljs` (`claims->user`, `attachment->user`, `presence*`, `online-users`, `add-presence!`, `update-presence!`); `worker.cljs` (the DO constructor rebuilding presence from `getWebSockets` attachments); `worker/dispatch.cljs:66` (where the actor header is set); `storage.cljs` (`get-t`, `get-checksum`, the `tx_log` table).
- Tests: `semantic_favorites_test.cljs` (helpers to copy), `worker_handler_ws_test.cljs` (sockets and attachments), `e2ee_semantic_test.cljs`, `semantic_uploaded_graph_schema_test.cljs` (an upload-path graph), `semantic_edit_stamps_test.cljs` (Claude's stamps), `semantic_delete_property_value_test.cljs`.
- `docs/solutions`: `sync/batch-replayed-with-mixed-tx-ids.md`, `sync/order-key-not-seeded-for-server-writes.md`, `sync/uploaded-graph-keeps-the-apps-schema-drift.md`, `sync/tx-meta-listener-keeps-the-last-outliner-op.md`, `sync/snapshot-is-kvs-only-and-tx-log-has-no-author.md`, `api/convert-values-deleted-referenced-value-blocks.md`, `api/an-optional-narrowing-argument-must-refuse-not-widen.md`, `api/new-selector-form-needs-every-lookup-site.md`, `api/an-up-front-refusal-must-follow-the-outliners-branches.md`, `api/authorship-stamps-ride-the-write-transaction.md`, `api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `connector/audit-pre-read-must-mirror-the-write.md`, `connector/two-step-edit-applies-what-it-showed-and-audits-with-it.md`, `connector/count-claims-in-tool-text-must-come-from-the-implementation.md`, `cost/durable-object-cpu-limit-on-free.md`, `cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `cost/d1-statement-shapes-read-more-than-they-return.md`, `cost/d1-reads-from-indexer-scans.md`, `testing/untested-rules-survive-mutation.md`, `testing/a-test-that-skips-on-build-state-hides-a-red-gate.md`.
- Connector: `src/tools/spec.mjs` (`HANDWRITTEN_TOOLS`, `SEMANTIC_TOOLS`, `EXCLUDED_OPERATIONS`, `ANNOTATIONS`, `FIRST_LINES`), `src/tools/deletes.mjs` (`DELETE_RULES`, `DRY_RUN_TOOLS`, `bodyOf`), `src/audit/snapshot.ts` (`SNAPSHOT_PLAN`, the `getBlocks` source and its id cap), `src/audit/log.ts` (`recordRead`), `src/tools/readable.ts`, `src/tools/semantic-search.ts` (`semantic_index_status`, `:444-478`), `src/tools/suggest-links.ts` (a hand-written tool registered with and without semantic), `src/semantic/store.ts` (`state`, `counts`), `src/mcp.ts` (registration, `:138-165`), `src/tools/handwritten.ts` (`CONNECTOR_HELP`), and the tests `tools.test.ts`, `semantic.test.ts`, `semantic-fakes.ts`, `deletes.test.ts`, `audit-snapshot.test.ts`, `service-tokens.test.ts`, `readable.test.ts`.
- `scripts/release-query-check.mjs` and its test (the release-bundle harness both benches extend).

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A service-token call to `getSyncStatus`:** what `request-creator` holds for it decides whether `own` can be computed (spec §3.2, unverified). Settled first in Stage 1; if the actor header carries no user id for service tokens, `own` and `others` are dropped from route, tool and text, and the commit body says so.
2. **A graph uploaded from a snapshot with `t` above 0 and no `tx_log` row:** `last-written-at` and `last-op` are `null`, not an error (Stage 1).
3. **A socket with an attachment but no user** (a client that never sent claims): counted in `connected`, not in `users` (Stage 1).
4. **The same user on two sockets:** `users` 1, `connected` 2 (Stage 1).
5. **A graph with semantic configured but never indexed:** `semantic.status` `"not started"`, `index-t` and `behind-by` `null` (Stage 2).
6. **`index-t` above the sync `t`** (a reset graph): `behind-by` is reported as computed (negative), not clamped, and the tool text says what a negative value means (Stage 2).
7. **A page selector as a `YYYY-MM-DD` journal date and in another case than the stored title:** resolved as `resolve-page-selector` resolves it (Stage 3; REVIEW.md *A new input form or refusal reaches every site*).
8. **The same page by UUID and by title in one call:** `page-ids[1]: same page as page-ids[0]` (Stage 3).
9. **A blank leaf that is a page's only block, on today's journal:** a candidate (spec §12 answer 4) unless a socket reports it as editing (Stage 3).
10. **A non-breaking space (U+00A0) and a tab-only title:** blank, as `string/blank?` judges them; a zero-width space (U+200B) is content (Stage 3). The test states each code point.
11. **`dry-run: "true"` (a string), `page-ids` as a single string, `block-ids: []`:** each refused 400 naming the field, nothing written (Stages 3 and 4; `docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`).
12. **A dry run listing exactly 100 and one listing 101 candidates:** `listed` is 100 in both, `total` 100 and 101, and the note says to run again only in the second (Stage 3).
13. **An apply naming a block whose parent is another listed block** (cannot happen for a true leaf; a guessed id): refused by the predicate as `has children` (Stage 4).
14. **An apply whose ids are listed in a different order from the dry run, across pages:** the same set is deleted and the replay matches (Stage 4).
15. **An apply whose block was moved to an unlisted page after the dry run:** `block-ids[i]: not on a listed page` (Stage 4).
16. **`delete_blank_blocks` with no `body`, or `body.dry-run` missing, for a `write-no-delete` token:** treated as a delete by the table (only `dry-run === true` is exempt), so refused before any sync request (Stage 4).

---

### Stage 1: Patch 0055, the sync-status route

**Goal:** `GET /sync-status` answers `t`, `last-written-at`, `last-op`, `checksum` (stored, never recomputed), `page-count`, `block-count`, `counts-include-private`, `e2ee` and `clients {connected, users, own, others, editing}`. The connector excludes the operation, so no tool changes yet. Lands spec §3.2, §5 (Tool B's DO cost), §6 (presence exposure) and §8 PR 1's upstream items, and acceptance lines on the route's fields, exposure and presence after a rebuild.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/test/logseq/db_sync/semantic_sync_status_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/presence.cljs`: `presence-summary` and `editing-block-uuids`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `counted-page-ids` (`list-pages` minus hidden pages and `private-ids`), `block-count` (one pass over `:aevt :block/page` datoms, counting a block whose page is counted and which is not in `private-ids`; no entity reads), `sync-status`, the `:semantic/sync-status` handler and its dispatch in `handle`. `t` and `checksum` come from `storage/get-t` and `storage/get-checksum`; `last-written-at` and `last-op` from `select created_at, outliner_op from tx_log where t = ?`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `getSyncStatus` route, its description (counts only; checksum as stored, never recomputed; presence carries no device or client kind; counts include Private content on E2EE graphs) and response schema `SyncStatusResponse`.
- Create: `patches/0055-semantic-sync-status.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`); `connector/src/tools/spec.mjs` (`getSyncStatus` in `EXCLUDED_OPERATIONS`); `connector/test/tools.test.ts`.

**Interfaces produced:** `(presence/presence-summary self caller-user-id)` and `(presence/editing-block-uuids self)` (Stage 3 reuses the second); `getSyncStatus` in the vendored openapi (Stage 2 calls it).

- [ ] **Step 1: Settle review focus 1 first.** Read `dispatch.cljs:66` and the connector's service-token path to the sync server, then write `own-for-service-token`: a request with a service token's actor header reaches the handler with the owner's user id. If it does not, record what the header holds, drop `own` and `others` from the design (spec §3.2's fallback), and carry that through every later step and the PR body.
- [ ] **Step 2: Write the failing tests**, each through `handle-http`:
  - `t-and-last-write-follow-a-write`: after a `deleteBlock`, `t` rises, `last-op` is `"delete-blocks"` and `last-written-at` is that `tx_log` row's time as ISO.
  - `last-written-at-null-on-upload` (review focus 2): an upload-path graph with no `tx_log` row at its `t`.
  - `counts-exclude-hidden-recycled-private`: a fixture with a hidden page, a recycled page, a Private page, a Private block on a public page and blocks under it; the counts equal a hand count of what `list_pages` and `list_page_blocks` show. `counts-include-private` is false.
  - `counts-on-e2ee`: on the E2EE fixture the counts include the Private content and `counts-include-private` is true.
  - `clients-after-rebuild`: a DO constructed from socket attachments only (simulated wake, as the constructor rebuilds presence), with user A on two sockets (one editing a block) and user B on one, and the caller as user A: `{connected 3, users 2, own 2, others 1, editing 1}` (review focus 4). A socket with an attachment but no user counts in `connected` only (review focus 3).
  - `no-identities-in-json`: the response JSON contains neither user's id, email, username or name, nor the editing block's UUID (a string search over the raw body).
  - `checksum-not-recomputed` (**stubs a step; labelled**): with the checksum recompute redefined to throw, the route answers the stored checksum, and `null` on a graph with none.
  - `read-only`: `t` and the `tx_log` row count are unchanged by the call; a `read` scope is enough and the route is reached through `handle`.
- Connector (vitest): `tools.test.ts`: `getSyncStatus` is in the vendored openapi and no generated tool comes from it.
- [ ] **Step 3: Run on the baseline** and keep the failures (no route, 404; the connector test fails as a generated `get_sync_status` would collide with Stage 2's hand-written one, or as the exclusion is missing).
- [ ] **Step 4: Implement** as spec §3.2.
- [ ] **Step 5: Run the patch workflow above.** **Mutation check:** count `getWebSockets` sockets instead of the atom (the rebuild test still passes only if the constructor works, so also: skip the constructor's rebuild); count hidden pages; count Private blocks on a non-E2EE graph; set `counts-include-private` false on E2EE; return the first user's email; call the recompute; throw when no `tx_log` row exists; count sockets for `users`. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): report a graph's sync status through the semantic API`. Body: what review focus 1 showed, the quoted baseline failures, the mutation results, the manifest unchanged (operation excluded), and cost (2 `sync_meta` reads, 1 `tx_log` read by primary key, one O(entities) pass; 0 D1 rows).

**Done when:** all patches through 0055 apply from scratch, the new namespace and the whole db-sync suite pass, `getSyncStatus` is vendored and excluded, the manifest is unchanged, and `scripts/check.sh --upstream` is green.

---

### Stage 2: The `get_sync_status` connector tool

**Goal:** One read-only tool returns the route's fields plus `semantic {status, indexed-blocks, indexed-at, index-t, behind-by, error}` or `null` with `semantic-note`. `semantic_index_status` is unchanged. Lands spec §3.3, §4 (`get_sync_status`), §5 (Tool B's D1 cost) and §8 PR 1's connector items.

**Files:**
- Create: `connector/src/semantic/status.ts`: `semanticStatusPart(store, graphId, syncT)` returning the semantic part (no Vectorize `describe()`), and the fields `semantic_index_status` shares.
- Modify: `connector/src/tools/semantic-search.ts`: `semantic_index_status` builds its common fields through `status.ts`; its output is byte-identical.
- Create: `connector/src/tools/sync-status.ts`: `registerSyncStatusTool(server, access, semantic, onSuccess, audit)`; resolves the graph as other read tools do, calls `getSyncStatus` (one sync request), folds in `semanticStatusPart` when `semantic` is non-null, records the read with `recordRead`, and never copies a field the route does not return.
- Modify: `connector/src/mcp.ts` (register it unconditionally, beside `registerSuggestLinksTool`); `connector/src/tools/spec.mjs` (`get_sync_status` in `HANDWRITTEN_TOOLS`, `READ` in `ANNOTATIONS`, `FIRST_LINES` from spec §4, 96 characters); `connector/src/tools/readable.ts` (classified as a read); `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP` gains a status line: what `get_sync_status` answers, that clients are counts only with no device kind, and that `behind-by` is how many sync transactions the index has not seen); `connector/tools-manifest.json` (via `update:manifest`).
- Create: `connector/test/sync-status.test.ts`. Modify: `connector/test/semantic.test.ts`, `connector/test/tools.test.ts`, `connector/test/readable.test.ts`, `connector/test/service-tokens.test.ts`.

- [ ] **Step 1: Write the pin test first:** `semantic.test.ts` captures `semantic_index_status`'s JSON on the fakes before the refactor (`semantic_index_status output is unchanged`). It passes on the starting tree and must still pass after the move; say so in the commit body.
- [ ] **Step 2: Write the failing tests:**
  - `sync-status.test.ts`: the tool returns the route's fields and the semantic part; `index-t` is `semantic_state.t` and `behind-by` is sync `t` minus it; `null` when either is null (review focus 5); negative when the index is ahead (review focus 6).
  - Without semantic bindings: the tool is registered, `semantic` is `null` and `semantic-note` is `semantic search not configured`.
  - Exposure: the tool's JSON contains no user id, email, name or block UUID from a fixture route answer that wrongly carried one in an unknown field (the tool copies named fields only).
  - Cost: D1 rows read and written per call, from `meta`, pinned (about 6 and 2; `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`), and exactly one sync request and no Vectorize call.
  - `tools.test.ts`: `get_sync_status` is listed, `READ`, first line at most 100 characters; `CONNECTOR_HELP` names it.
  - `service-tokens.test.ts`: a `read` token is allowed it; `readable.test.ts`: it is classified.
- [ ] **Step 3: Run on the Stage 1 tree** and keep the failures.
- [ ] **Step 4: Implement** as spec §3.3.
- [ ] **Step 5: Run** `npm --prefix connector run update:manifest` (one tool added) and `scripts/check.sh`. **Mutation check:** register it only with semantic; compute `behind-by` the other way round; clamp it at 0; call `describe()`; spread the route's JSON into the answer instead of naming fields; skip `recordRead`. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(connector): get_sync_status folds sync and semantic index state`. Body: the failures, the unchanged `semantic_index_status` pin, the mutation results, the manifest gained `get_sync_status`, and cost (about 6 D1 rows read, 2 written, 2 Worker requests per call; 0 neurons).

**Done when:** `get_sync_status` works with and without semantic config, `semantic_index_status` is unchanged, the D1 cost is pinned, the manifest has one more tool, and `scripts/check.sh` is green. The PR could ship here.

---

### Stage 3: Patch 0056, page resolution, the blank predicate and the dry run

**Goal:** `POST /blank-blocks/delete` with `dry-run: true` resolves the pages (refusing the whole call naming `page-ids[i]`), judges every block with the allow-list predicate and answers the compact dry-run shape without writing. An apply without `block-ids` answers 400; an apply with them answers 501 until Stage 4. `deleteBlankBlocks` is excluded in the connector. Lands spec §3.4 steps 1 to 3, the decision table, §6 (Private, E2EE) and §8 PR 2's predicate, dry-run and page-refusal items.

**Files:**
- Create (in `.upstream`): `deps/db-sync/test/logseq/db_sync/semantic_delete_blank_blocks_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: the cap constants; body checks (unknown fields, types, `page-ids` 1 to 20, `block-ids` required unless `dry-run` is true); `resolve-blank-pages` (E2EE refusal first, then each selector through `resolve-page-selector`, then duplicate-after-resolution, kind and Private checks, every refusal naming `page-ids[i]`); `blank-attribute-allow-list` (spec §3.4 step 2: `:block/uuid`, `:block/parent`, `:block/page`, `:block/order`, `:block/title`, `:block/created-at`, `:block/updated-at`, `:block/tx-id`, `:logseq.property/created-by-ref`, `:user.property/claude-editedBy`, `:user.property/claude-editedAt`); `blank-candidate` reading attributes from `:eavt` datoms (not entity cardinality, for upload-path graphs), `:block/_parent`, `:block/tags`, `referrer-ids`, `private-ids` and `presence/editing-block-uuids`, returning `nil` or `:has-children`, `:referenced`, `:being-edited`, `:private` or a silent-keep reason; `blank-dry-run` walking each page's `:block/page` datoms in request order with the 2,000 and 10,000 bounds (422 naming `page-ids[i]`), filling `would-delete` up to 100 across the call; the `:semantic/blank-blocks-delete` handler in `handle-bulk`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `deleteBlankBlocks` route, request schema (no additional properties), the dry-run and apply response schemas, and the description (what is blank, what is kept and listed, the caps, the handshake, Private counted only, E2EE refused, a page may end empty and the app may add a block back).
- Create: `patches/0056-semantic-delete-blank-blocks.patch` (against `baseline-0055`).
- Modify: the vendored files; `connector/src/tools/spec.mjs` (`deleteBlankBlocks` in `EXCLUDED_OPERATIONS`); `connector/test/tools.test.ts`.

**Interfaces produced:** `resolve-blank-pages` and `blank-candidate` (Stage 4's apply re-judges with exactly these, on the transaction's db).

- [ ] **Step 1: Pin the allow-list first** (spec §7 risk 2): `plain-block-attributes`: a blank block made by the server and one on an upload-path graph (and one made through `insert_block_tree` with Claude's stamp header on) each hold only attributes in `blank-attribute-allow-list`. **If either holds an attribute outside the set, stop: record it and the graph origin, and decide with the spec's rule (built-in bookkeeping joins the set; anything a user set does not) before Step 2. Say which in the commit body.**
- [ ] **Step 2: Write the failing tests** (spec §8 PR 2), on a server-created graph and on an upload-path graph:
  - `predicate`: one fixture page holds an empty leaf and a whitespace-only leaf (would-delete); a zero-width-space leaf, a non-breaking-space leaf and a tab-only leaf (review focus 10); a blank parent with a child (kept, `has children`, child untouched); an empty Task; empty blocks with a user property, a heading, and each of Code, Math and Quote; a property value block and a closed-value choice; a pre-block; a `((ref))` to and an embed of an empty block (kept, `referenced`); an empty leaf under a Private block (`skipped-private`); a recycled block (absent); a blank leaf a socket attachment marks as editing (kept, `being edited`); and a blank leaf carrying only Claude's stamps (would-delete). The silent keeps appear nowhere in the answer.
  - `dry-run-writes-nothing`: `t` and the `tx_log` row count are unchanged; the shape matches spec §3.4 step 3, with `examples` capped at 20 per page.
  - `dry-run-listing-cap` (review focus 12).
  - `todays-journal` (review focus 9).
  - `page-refusals`: not found (and a hidden and a recycled page), ambiguous (with candidates), same page twice (review focus 8), whiteboard, tag, property, Private, E2EE (409), 0 and 21 pages, a page over 2,000 blocks and a call over 10,000 (422); each by UUID, title and journal date where the form applies (review focus 7), each naming `page-ids[i]`, with `t` unchanged.
  - `body-refusals` (review focus 11): unknown field, `dry-run: "true"`, `page-ids` as a string, an apply with no `block-ids` (400), each naming the field.
  - `apply-not-built-yet`: an apply with `block-ids` answers 501 and writes nothing (removed in Stage 4; it keeps Stage 3 shippable).
- Connector: `tools.test.ts`: `deleteBlankBlocks` is vendored and generates no tool.
- [ ] **Step 3: Run on the Stage 2 tree** (patch 0056 stashed) and keep the failures.
- [ ] **Step 4: Implement** as spec §3.4 steps 1 to 3.
- [ ] **Step 5: Run the patch workflow above** and add the dry run at the caps to `scripts/release-query-check.mjs`: a page of 2,000 blocks and 5 pages for 10,000 scanned, with half the leaves blank, through `SyncDO.fetch` on the release bundle; it checks the answer and that it returns within a stated bound, and prints the timing. Extend `release-query-check.test.mjs` for the new check. **Mutation check:** drop each predicate clause in turn (title, children, tags, allow-list, referrers, Private, editing); use `string/trim` emptiness that treats U+200B as blank; read attributes from the entity instead of datoms; skip the duplicate-after-resolution check; allow whiteboards; skip the E2EE refusal; count the 10,000 bound per page; list more than 100. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): judge blank blocks on named pages with a dry run`. Body: what the allow-list pin showed on each graph origin, the quoted failures, the mutation results, the release-bundle timing at the caps, the manifest unchanged, and cost (one walk of at most 10,000 blocks, `referrer-ids` only for blank candidates; 0 D1 rows).

**Done when:** every predicate case passes on both graph origins, the dry run writes nothing, every page refusal names its entry, the release-bundle check at the caps passes, the manifest is unchanged, and `scripts/check.sh --upstream` is green.

---

### Stage 4: Patch 0056, the apply and `delete_blank_blocks`

**Goal:** An apply with 1 to 100 `block-ids` re-judges each inside one `atomic-write!` and deletes them with one `delete-blocks!` call, then reads back. The connector exposes `delete_blank_blocks`, classified in every table: a `write-no-delete` token can dry-run but not apply, and the audit snapshot holds exactly the apply's ids. Lands spec §3.4 step 4, §3.5, §4 (`delete_blank_blocks`), §6, §7 risk 1 and §8 PR 2's apply, refusal, replay, release-bundle and connector items.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `block-ids` shape checks outside the transaction (1 to 100, UUIDs, no duplicates, each naming an entity: 400 or 404 naming `block-ids[i]`); `apply-blank-deletes!` inside `atomic-write! conn creator false :delete-blocks`, re-reading each block on the transaction's db, re-judging it with `blank-candidate`, checking its `:block/page` is a resolved page, throwing the first failure in `check-labels!`'s refusal shape (409 naming `block-ids[i]`), then one `outliner-core/delete-blocks!` with every block; then `broadcast-change!`, `confirm-removed!` and `{deleted, t, pages: [{page, uuid, deleted, remaining-blocks}]}`. Remove the 501.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the apply response schema and the 404, 409 and 500 descriptions.
- Modify: `patches/0056-…`, the vendored files, `connector/tools-manifest.json` (via `update:manifest`).
- Modify: `connector/src/tools/spec.mjs` (remove the exclusion; `delete_blank_blocks: DESTRUCTIVE_IDEMPOTENT`; `FIRST_LINES` from spec §4, 95 characters); `connector/src/tools/deletes.mjs` (`delete_blank_blocks: { when: (args) => (bodyOf(args)?.["dry-run"] === true ? null : "deletes blank blocks") }`, `DRY_RUN_TOOLS.delete_blank_blocks = "body"`); `connector/src/audit/snapshot.ts` (`SNAPSHOT_PLAN.delete_blank_blocks`: source `getBlocks`, the ids from `body.block-ids` only, uuid, page, parent, order and title, size-capped; no snapshot on a dry run); `connector/src/tools/readable.ts` (a target line naming the pages and the number of block ids).
- Modify: `connector/test/deletes.test.ts`, `connector/test/audit-snapshot.test.ts`, `connector/test/service-tokens.test.ts`, `connector/test/readable.test.ts`, `connector/test/tools.test.ts`.

- [ ] **Step 1: Write the replay test first** (spec §7 risk 1): `apply-replays-on-a-client-copy`: the dry run's ids from three non-adjacent leaves across two pages, applied in a shuffled order (review focus 14), write one `tx_log` row with one tx id and `outliner-op :delete-blocks`; replaying the log on a client copy gives the same blocks in the same order on both pages. **If the replay differs, switch to one `delete-blocks!` per page inside the same `atomic-write!` (still one tx id), as the spec's fallback, and say so in the commit body.**
- [ ] **Step 2: Write the remaining failing tests:**
  - `apply-deletes-dry-run-ids`: the answer's counts and `remaining-blocks`; the blocks are gone from `list_page_blocks`; reached through `handle` (the max order key seeded).
  - `apply-refusals`, each naming `block-ids[i]` with `t` unchanged: an id given text between dry run and apply; given a child; moved to an unlisted page (review focus 15); a guessed non-blank id; an id naming a block whose child is also listed (review focus 13); an id a socket now reports as editing; a page or property entity as an id (`not a plain block`); not a UUID, a duplicate, an unknown id (404), `block-ids: []` and 101 ids (400).
  - `apply-first-failure-refuses-all`: one bad id among good ones deletes nothing.
  - `confirm-removed-read-back` (**stubs a step; labelled**): with `delete-blocks!` redefined to skip one block, the call answers 500 naming it.
  - Remove `apply-not-built-yet`.
- Connector (vitest):
  - `deletes.test.ts`: `dry-run: true` returns null; `false`, missing and no body return the reason (review focus 16); `DRY_RUN_TOOLS` matches the vendored openapi; the rule agrees with `ANNOTATIONS`.
  - `service-tokens.test.ts`: a `write-no-delete` token is allowed a dry run and refused an apply with 0 sync calls and an audit row `refused`; a `read` token is refused both.
  - `audit-snapshot.test.ts`: the apply's before-snapshot reads exactly `body.block-ids` from `getBlocks`; a dry run takes none.
  - `readable.test.ts`, `tools.test.ts`: classified; first line at most 100 characters; the generated schema has `page-ids`, `dry-run` and `block-ids` with the caps.
- [ ] **Step 3: Run on the Stage 3 tree** and keep the failures.
- [ ] **Step 4: Implement** as spec §3.4 step 4 and §3.5.
- [ ] **Step 5: Run the patch workflow above** (with `update:manifest`), and add an apply of 100 ids at the caps to `scripts/release-query-check.mjs` (checked answer and timing, printed). **Mutation check:** skip the in-transaction re-judge; re-judge on the outer db instead of the transaction's; skip the page check; call `delete-blocks!` once per block (several tx ids); skip `confirm-removed!`; drop the duplicate-id check; delete on dry run; in the connector, make the rule `always`, make it `never`, test `dry-run` truthy instead of `=== true`, drop the dry-run entry, and snapshot the pages instead of the ids. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): delete blank blocks by dry-run ids, delete_blank_blocks`. Body: what the replay test showed, the quoted failures, the mutation results, the release-bundle timings at the caps, the manifest gained `delete_blank_blocks`, and cost (about 1 D1 row read, 3 written, 3 Worker requests per apply; 2 for a dry run; 0 neurons).

**Done when:** the apply deletes exactly the re-judged ids in one tx id and replays correctly, every refusal names its entry with nothing written, a no-delete token is refused before any sync request, the snapshot mirrors the write, the release-bundle checks pass, and `scripts/check.sh --upstream` is green.

---

### Stage 5: The connector contract

**Goal:** Claude's help text describes `delete_blank_blocks` as built, and every count either tool's text states comes from the implementation. Lands spec §4 (text to update) and acceptance on `connector_help` and count claims.

**Files:**
- Modify: `connector/src/tools/handwritten.ts`: `CONNECTOR_HELP`'s deletes paragraph gains `delete_blank_blocks` (dry run first, then pass the ids it listed; only plain blank leaves; blank parents kept and listed; Private counted, not listed; E2EE refused; the caps), and the `write-no-delete` list names it (dry run allowed). The counts are interpolated from exported constants, not typed.
- Modify: `connector/src/tools/spec.mjs` or a small `connector/src/tools/blank-blocks.ts` exporting the caps the connector states (20, 100, 2,000), with a test that they equal the vendored openapi schema's `maxItems` and the route description's numbers.
- Modify: `connector/test/tools.test.ts` (help and count-claims assertions).

- [ ] **Step 1: Write the failing tests:** one assertion per help phrase (so dropping one fails); the count-claims test: every number in `get_sync_status`'s and `delete_blank_blocks`'s description and in their help text equals a constant read from the implementation or the vendored schema (`docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md`).
- [ ] **Step 2: Run and keep the failures** (record which description assertions already pass from Stage 4's vendor).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate:** `npm --prefix connector run check:manifest` (say whether it changed) and `scripts/check.sh`. **Mutation check:** drop each help phrase; change a cap constant without the text. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): describe delete_blank_blocks and pin its counts`. Body: the failures seen, the manifest result, and cost (none: text only).

**Done when:** the help and descriptions match the server's behaviour, the count-claims test passes, and `scripts/check.sh` is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §1 gains patches 0055 and 0056; README §11.8 gains entries for both tools (fields, counts only, no device kind, `behind-by`; the blank rule, what is kept, the handshake, caps, Private, E2EE, the `write-no-delete` rule) and its tool list gains both; the annotations paragraph names `delete_blank_blocks` among the destructive tools. Consider a `docs/solutions` entry on what the allow-list and replay pins showed.
- **PR body:** each stage's first failures, the pin results as observed (review focus 1, the allow-list, the replay), the mutation results, the release-bundle timings, the commit `scripts/check.sh --upstream` ran on and what it skipped, that `tools-manifest.json` gained two tools, the cost table from spec §5, the patch-numbering note (0050 to 0054 in other PRs), and the Logseq skill note: `get_sync_status` answers sync and index state in one call, with clients as counts; to tidy empty bullets, dry-run `delete_blank_blocks` on the pages, show the owner the summary, then pass the listed ids; blank parents, headings, display-type and property blocks are kept; a `write-no-delete` token can only dry-run it.
- **Live check** (spec §9, after merge): on alias `test` only, call `get_sync_status`, and dry-run `delete_blank_blocks` on a scratch page and compare with `list_page_blocks`. Record outcomes, not page names.
