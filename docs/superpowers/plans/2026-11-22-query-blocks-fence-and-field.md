# Query blocks from a query fence or a query field: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in every stage, since every stage changes `patches/`), and is one commit, pushed straight after. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a query Claude writes through an insert tool runs in the owner's app as a real Query block: tagged `logseq.class/Query`, with `logseq.property/query` holding the text as a Clojure code block. It comes from an advanced-query ```query fence or from a node's new `query` field, and it passes the same static checks `datalog_query` applies before it runs a query (read-only, no rules, no code). The paths that can store an unchecked query today are closed, and `update_block` may change only the Query blocks Claude created.

**Architecture:**
- **Patch 0050 only.** Every server change goes into a new `patches/0050-semantic-query-blocks.patch`, regenerated against a 0001 to 0049 baseline in each stage. It is the last patch, so nothing is applied on top of it. No migration, no D1 change, no new tool.
- **Stage 1, the check and the write, with no route change:** `check-query-block` in `datalog.cljs`, and `set-query-block!` pulled out of `ensure-activity-page!`, which then calls it. No request reaches the new check yet, and the Activity page is written exactly as before.
- **Stage 2, inserts make Query blocks:** the fence branch and the `query` field in `prepare-tree`, the write and read-back in `insert-tree!`, the refusals naming the node, `query` and `converted: "query"` in responses, the dry run, and `update_block`'s new kept reason (the fence change reaches `update_block` too, so it lands here). The OpenAPI text, `FENCE_HINT`, `connector_help`, the vendored API and the connector tests change with it.
- **Stage 3, the property paths are closed:** `logseq.property/query` and the Query tag are refused through `set_block_property`, `batch_set_block_property`, node `properties` and batch-entry `properties`; Query becomes a tag the server never removes (so a reset can't strand the query), the batch `final-tags` overlay follows, and the delete paths refuse removing the Query tag or the query.
- **Stage 4, "created by Claude" and the `update_block` guard:** a hidden marker property set at creation (the decision below), and `update_block` on a Query block or its value block refused unless the marker says Claude created it; a Claude-made value block's new text passes `check-query-block`.
- **Stage 5, the release bundle and the CPU number:** `scripts/release-query-check.mjs` inserts a Query block through the release bundle, and a bench measures 100 query nodes of 4,000 characters in one batch (spec §5, §9 item 4).
- **Order:** the check first, because every later stage calls it and it can be reviewed as a pure function; then the insert path, which is the point; then the closed paths, so no unchecked route is left beside the checked one; then the guard, which needs the marker the insert path sets; the bench last, because it measures the finished code.

**Decision: how "created by Claude" is known** (spec §12 decision 4, left to the build). A marker the patch sets at creation, not the edit stamps:
- The stamps exist only when "Mark Claude's edits" is on, and `editedBy` is set on any block a Claude write touches (a move, a property), so it means "Claude edited", not "Claude created". The block's `:logseq.property/created-by-ref` names the signed-in actor, which is the owner for both the app and the connector, so it can't tell them apart either.
- The marker is a hidden checkbox property, ident `:user.property/claude-queryBlock`, title `claudeQueryBlock`, cardinality one, created on first use inside the write's transaction the way `ensure-stamp-schema!` creates the stamp properties, and set to `true` on the Query block (the tagged block, not its value block) by `set-query-block!` when the insert path asks for it. The Activity page's two blocks are not marked: the server pins their text, so Claude may not edit them.
- A property in the marker's way (its ident holding a property of another type or cardinality, or another property titled `claudeQueryBlock`) refuses the insert with a 409 naming it, before anything is stored, as `check-stamp-schema` does for the stamps.
- The guard reads the marker from `:eavt` datoms. It allows the write only when the marker property exists and the Query block holds `true`. A value block whose holder can't be found (no `:logseq.property/query` datom points at it), or more than one holder, is refused as "can't tell".
- The marker is refused through every property write path (Stage 4), so only `set-query-block!` writes it. Deleting it through `delete_block_property` only makes a block "not Claude's", which is the stricter direction, so that stays allowed.
- Known limits, for the commit body and the PR: the owner can copy a marked block in the app, and the copy keeps the marker; the owner can set the marker in the app. Both only widen what Claude may edit to blocks the owner chose.

**Tier.** The intake suggested `standard` and asked for a recheck if the marker became a stored property. It does: Stage 4 adds a hidden property to the owner's graph on first use. There is still no migration, no deletion and no conversion of stored data, and the stamps set the precedent, but it is a new schema entity in the owner's graph, so this plan recommends the lane run it as `full`. The lane decides.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`; the real `sync-handler/handle-http` on a `sqlite-export/create-conn` graph through `request!`, as `semantic_display_type_test.cljs` does); Datascript (Logseq's fork); the release bundle under Node through `loadReleaseSyncDO` in `scripts/release-query-check.mjs`; the TypeScript connector with vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-query-blocks-design.md`. Read it first; it is the authority, and section numbers below (§3.4 and so on) are its own. **Section 12 overrides section 11 and changes §3.5 and §4:** `update_block` may change only Query blocks Claude created (decision 4), and the Query tag is refused through the property paths (decision 6). Decision 5 was not answered, so the caption rule in §3.3 stands. The spec's build order puts all contract text in one place; this plan moves each piece of contract text into the stage whose behaviour it describes, because the connector's tests read the vendored OpenAPI and CI re-vendors on every push, and leaves README §11.8 (the "Fences become blocks" bullet and backlog item 21), the spec's As built section and the learning doc to the lane's docs step.

## Global constraints

- **Names, exactly:**
  - in `worker/handler/datalog.cljs`: `check-query-block` (public; text → `{:ok text :form m}` or `{:error message}`), `query-block-keys` (`:query :inputs :title :collapsed? :group-by-page? :remove-block-children? :breadcrumb-show?`) and `query-block-flags` (the four booleans). It calls the existing `parse-edn`, `write-form-errors`, `normalise-query`, `validate-query` and `fn-bindings-refusal`, and the constants `max-query-chars` (4,000) and `max-inputs` (20). No existing function changes behaviour for `datalog_query`;
  - in `worker/handler/semantic.cljs`: `set-query-block!` (`conn block-id text {:mark? bool}`), `read-back-query-block` (`db block-id text mark?` → a list of reasons, empty when it stored), `query-node-refusal`, `simple-query-fence-reason`, `update-query-fence-reason`, `query-marker-ident` (`:user.property/claude-queryBlock`), `check-query-marker-schema`, `ensure-query-marker-schema!`, `query-holder` (value block → the one block whose `:logseq.property/query` points at it, or nil), `claude-query-block?` (db, entity → `:yes`, `:no` or `:unknown`), `query-block-refusal` (the `update_block` guard); prepared-node keys `::query` (the text) and `::query-from` (`:field` or `:fence`);
  - response keys `query` (the stored text, on every Query block an insert makes, also with `verbose=false`) and `converted: "query"` (fence-made only);
  - the new test namespace `deps/db-sync/test/logseq/db_sync/semantic_query_block_test.cljs` (`logseq.db-sync.semantic-query-block-test`), registered in `test_runner.cljs`, run with `scripts/upstream-test.sh .upstream semantic-query-block`.
- **Messages, in the spec's wording (§3.1 to §3.5, §4).** `check-query-block` returns every reason starting with `query: ` exactly once (a validator reason that already starts with `query: ` is not prefixed again, so no `query: query:`). Callers add only the path or entry:
  - `<path>: query: <reason>` on insert (`blocks[0]: …`, `blocks[0].children[1]: …`, `entries[2].blocks[0]: …`), and `title: query: <reason>` on `update_block`;
  - `query: give an EDN map {:query [:find … :where …] :inputs […]}`; `query: give :query as a vector [:find … :where …]; the app runs only that form`; `query: :<key> is not accepted; it runs as code in the app` (`:view`, `:result-transform`); `query: :<key> is not accepted (keys: :query, :inputs, :title, :collapsed?, :group-by-page?, :remove-block-children?, :breadcrumb-show?)`; `:rules` gets `no-caller-rules`; `query: at most 4,000 characters (got N)`; `query: :inputs must be a vector`, `query: :title must be a string`, `query: :<flag> must be true or false`;
  - `query: given both as a field and as a fence`; `query: a Query block takes no display-type or lang`; `query: the Query tag is set by the query field`; `query: not on an E2EE graph`;
  - kept reasons: `only an advanced query ({:query [...]}) becomes a Query block; a simple query stays text` (insert) and `update_block doesn't make Query blocks; insert one` (update);
  - property paths: `logseq.property/query can't be set here; use the query field on an insert node`; `Query can't be given as a tag; use the query field on an insert node`; on delete, `Query: a Query block keeps its tag; delete the block instead` and `logseq.property/query: a Query block keeps its query; delete the block instead`; the marker, `claudeQueryBlock is set by the server and can't be written`;
  - the guard, 409: `block <uuid>: update_block changes only Query blocks Claude created` and `block <uuid>: can't tell whether Claude created this Query block, so it isn't changed`;
  - the marker conflict, 409: `query blocks: property <title> (<ident>) is in the way of claudeQueryBlock; rename it in the app`.
- **Refuse up front, write nothing.** Every query check runs in `prepare-tree` (or before `atomic-write!` on update) before any write. A refused call leaves the datom count and `max-tx` unchanged; each refusal test asserts both.
- **One write.** Only `set-query-block!` writes the Query tag, `logseq.property/query`, the value block's display type and lang, and the marker. A test greps nothing; review checks every writer (spec §7 risk 5).
- **Read-back in the transaction.** `set-query-block!`'s caller passes `read-back-query-block`'s reasons to `unverified!`, prefixed with the node's path: tags include Query; the value block's title equals the text; its display type is `:code`; its lang is `"clojure"`; with `:mark? true`, the marker is `true`. The value block is found through `:eavt` (`(d/datoms db :eavt block-id :logseq.property/query)`), not only the entity (the upload-path gotcha).
- **Order keys.** New blocks are made after `handle` seeds the max order key; Stage 2 asserts distinct keys on a page that already has blocks.
- **Tests run the real thing.** Through `handle-http` and the router on a real conn built by real writes; no stubbed outliner, validator or reader (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Each new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Where a test can't fail first (a guard for a case the starting tree already refuses for another reason, or a pure refactor's pin), say so in the commit body. Example data only (`Book`, `zq …` titles, `sync.example.com`, alias `test`). The owner's graph is never written; any live check uses only the graph alias `test`.
- **Free plan** (spec §5): per insert call 2 Worker requests, about 1 D1 row read and 2 written (unchanged), 0 neurons, 0 Vectorize, 0 KV; no cron or indexer change. Each Query block adds about 5 outliner property sets (tag, query, display type, lang, marker) in the same transaction, plus the marker property's upsert once per graph. Each commit body states the cost and the Durable Object CPU its tests measured.
- **Contract with Claude.** OpenAPI text changes in the stage whose behaviour it describes, and that stage re-vendors (`scripts/vendor-upstream-api.sh .upstream`), updates `connector_help`, `FENCE_HINT` and their tests in `connector/test/tools.test.ts`, and runs `npm --prefix connector run update:manifest`. The manifest holds names, paths and annotations, so it should not change; say so in the commit body. `FIRST_LINES` in `connector/src/tools/spec.mjs` is not expected to change (no first line mentions fences or properties of this kind); confirm it in each stage and say so.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `scripts`), with a body giving the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwX8CrBEu9tbeGDmDgu
  ```

  Push after every commit (`git push`).
- **Never commit** the owner's graph name, page names, uuids, hostnames or tokens.

### Working on patch 0050

Follow the `add-upstream-patch` skill. The intake found `.upstream` at its "0048 baseline" commit with 0049's files uncommitted, not checked against `patches/` on HEAD, so start from a fresh checkout. Once, before Stage 1:

```bash
SCRATCH=<the session's scratchpad>
rm -rf .upstream && scripts/fetch-upstream.sh .upstream            # patches 0001-0049
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0049"
git -C .upstream tag -f baseline
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                          # the vendor matches HEAD's patches
scripts/check.sh --upstream                                        # green on the starting tree
```

**Re-confirm the reproduction on HEAD** (the spec was written at `2f6998e`; HEAD is `d3683d1`, with origin/main merged in). Add the spec's throwaway namespace `zz-query-block-repro-test` (not committed): insert the Book fence of spec §8a through `insert_block_tree`, then `set_block_property` with `logseq.property/query` holding `:rules` and a rule call, `block/tags` with `logseq.class/Query`, and `update_block` on the value block with `(page-ref ?b ?p)`. Run `scripts/upstream-test.sh .upstream zz-query-block-repro`, keep the output for the PR, and delete the namespace. Expected as in the spec: 201 with `kept` and no tags, then three 200s. If any line differs, stop and report it before Stage 1 (CLAUDE.md: a report may already be fixed).

At the end of each stage:

```bash
scripts/build.sh .upstream                                          # dev test build and the release bundle
scripts/upstream-test.sh .upstream 'semantic-query-block|semantic-display-type|semantic-edit-stamps|semantic-datalog-query|e2ee-semantic'
(cd .upstream/deps/db-sync && pnpm test)                            # the whole suite
git -C .upstream add -A
git -C .upstream diff --cached baseline > patches/0050-semantic-query-blocks.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"     # all 50 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream                                         # runs release-query-check.mjs too
```

To see an upstream test fail first, write it, then stash the source change (`git -C .upstream stash push -- deps/db-sync/src`), rebuild, run, and pop. If `scripts/upstream-test.sh` is running as a watch, stop it (`--stop`) before `scripts/build.sh` and start it again after, since `pnpm clean` deletes `worker-test.js` (CLAUDE.md gotcha). `scripts/check.sh` prints a WARNING for each scripts test that skipped itself; a stage is not green while one names a test this plan relies on.

### Read before starting

- `REVIEW.md`, sections *Gates and tests*, *API and patches* (especially *A batch check sees the batch*, *Refuse the whole family, keep the retry*, *A new input form or refusal reaches every site*, *Verbatim blocks skip every title step*, *A many attribute is read from datoms*), *Sync* (*A write keeps its own op*), *Cost* and *Contract and docs*.
- `docs/solutions/api/title-resolves-outside-allowed-values.md`, `docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`, `docs/solutions/api/validate-final-state-apply-in-order.md`, `docs/solutions/api/read-hid-built-in-properties.md`, `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`, `docs/solutions/testing/a-test-that-skips-on-build-state-hides-a-red-gate.md`, `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`.
- The display-type design and plan (`2026-11-08-code-block-display-type-write*`, patch 0037), the query designs (`2026-11-09-datalog-query-named-queries-design.md`, `2026-11-17-named-queries-as-code-design.md`, patch 0039) and the edit-stamps code in patch 0034.
- In `worker/handler/semantic.cljs` (line numbers on the 0049 tree): `query-fence-reason` and `fence-display-block` (`:1030`, `:1038`), the tag refusals in the class branch of property resolution (`:1195` to `:1211`), `prepare-property-value` (`:1214`), `kept-tag?` and `set-prepared-tags!` (`:1263`, `:1276`), the delete-value checks (`:1495` to `:1506`), the batch `final-tags` overlay (`:1625` to `:1650`), `prepare-properties` and its `set-property-refusal` call (`:1651` to `:1670`), `node-display`, `prepare-tree`, `tree-block`, `set-node-display!`, `insert-tree!`, `tree-response` (`:1679` to `:1825`), the stamp schema code and `ensure-activity-page!` (`:1920` to `:2150`), `stamp-property-refusal` and `set-property-refusal` (`:2150` to `:2175`), `authored-write!` (`:2213`), `insert-tree-response` (`:2895`), `:semantic/blocks-update` (`:3008`), the property routes (`:3197` to `:3310`, including the delete path's `stamp-property-refusal` at `:3240`), capture (`:3490`), `create_task` (`:3657`), `unverified!` (`:3869`) and the batch insert entries (`:4892` to `:5030`).
- In `worker/handler/datalog.cljs`: `parse-edn` (`:222`), `write-form-errors` (`:254`), `normalise-query` (`:276`), `validate-query` (`:498`), `fn-bindings-refusal` (`:1076`), `checked-query` and `parse-request` (`:1117` to `:1150`).
- Tests: `semantic_display_type_test.cljs` (`request!`, `query-fence-kept-test`), `semantic_edit_stamps_test.cljs` (the pinned Activity text), `semantic_uploaded_graph_schema_test.cljs` (the upload-path fixture), `e2ee_semantic_test.cljs`, `semantic_batch_class_check_test.cljs`.
- Connector: `FENCE_HINT` (`connector/src/tools/semantic.ts:85`), the Code, math and quote section and the Queries paragraph of `connector_help` (`connector/src/tools/handwritten.ts:12` and `:24`), and the `CODE_BLOCKS_HELP` phrase list in `connector/test/tools.test.ts` (about `:2625` to `:2645`, which pins "```query fences stay text").

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A fence with surrounding whitespace, CRLF line endings, or `query` in another case (```QUERY):** converts as the trimmed text, and the stored text has no trailing newline (Stage 2).
2. **A ```query fence whose body is `{` but not a valid map (`{:query`), or a map with no `:query`:** refused 400 naming the node, not kept (§3.2) (Stage 2).
3. **A ```query fence with `(task todo)`, `"text"` or an empty body:** kept with the simple-query reason; the existing `query-fence-kept-test` keeps its paths (Stage 2).
4. **`convert-fences=false` with an advanced fence:** kept as text with no refusal, even if the map is invalid; a `query` field on the same call still converts (Stage 2).
5. **A node given a `uuid` that already exists (a retried insert):** reused as it is, no Query write, no `query` or `converted` in the response (Stage 2).
6. **A Query node with children, and a Query node nested as a child:** children insert under the Query block, and paths name the nested node (`blocks[0].children[0]`) (Stage 2).
7. **`query` given as a non-string (a number, a map, `null`):** refused naming the node as `query: give an EDN map …`, never a 500 (Stage 2).
8. **Exactly 4,000 characters, and 4,001:** the first converts, the second is refused (Stage 1 for the function, Stage 2 through a route).
9. **`:inputs` holding a keyword (`:current-page`), a string and a number, and 20 and 21 inputs:** keywords stored as given; 21 refused (Stage 1).
10. **A map-form `:query {:find … :where …}` that `datalog_query` accepts:** refused with the vector-form reason (Stage 1).
11. **A `:title` inside the map and a caption title on the node:** both stored; the map's `:title` is not checked against the caption (Stage 2).
12. **A batch with a valid Query entry before an invalid one:** nothing is written, and the error names the second entry's path (Stage 2).
13. **A reset tag list (`batch_set_block_property` with `block/tags` `[]` or a list without Query) on a Query block:** the Query tag stays and the call succeeds; the same list with Query is a no-op, not a refusal (held, as a held display class is) (Stage 3).
14. **The batch class check after a reset on a Query block:** `final-tags` keeps Query, so a property whose classes include Query is judged as the apply step leaves it (Stage 3).
15. **`delete_block_property` and `batch_delete_block_property` of the Query tag and of `logseq.property/query` on a Query block:** refused naming the entry; deleting another tag from a Query block still works (Stage 3).
16. **Query given by title, UUID and ident (`Query`, its uuid, `logseq.class/Query`), alone and in a list with a valid tag, on `set_block_property`, a batch entry, a node's `properties` and a batch entry's page `properties`:** each refused naming the entry, nothing written (Stage 3).
17. **`update_block` on the Query block's own title (the caption) when Claude made it:** allowed, no query check; a ```query fence in it stays text under `kept` with the update reason (Stage 4).
18. **`update_block` with `display-type` or `lang` on a Claude-made value block:** refused naming the block (`title: query: a Query block takes no display-type or lang`), so its code display can't be changed (Stage 4).
19. **The marker removed with `delete_block_property`, the marker property deleted, and a value block with two holders:** the guard answers "doesn't change" or "can't tell", never 200 (Stage 4).
20. **A marker property already in the graph as a text property, and another property titled `claudeQueryBlock`:** the insert answers the 409 naming it and stores nothing (Stage 4).
21. **Marking with edit stamps on and off:** the marker is set either way; with stamps on, the Query block is stamped and the value block is not (it is not a stamp target), and the write's `:outliner-op` is unchanged (tx-meta asserted, first use included) (Stage 4).
22. **The Activity page's blocks:** never marked, so `update_block` on them is refused; their pinned text is unchanged (Stages 1 and 4).

---

### Stage 1: Patch 0050, `check-query-block` and `set-query-block!`

**Goal:** the check every later stage calls exists and is proved against `datalog_query`'s own refusals, and the one write of a Query block is a helper that the Activity page already uses. No route changes behaviour. Lands spec §3.1, §3.4 (the helper, without the insert caller), §7 risks 6 and 8, and §8 g.

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: add `query-block-keys`, `query-block-flags` and `check-query-block`, in this order: string and length (`max-query-chars` over the whole text); `parse-edn "query"`; a map; the key allow-list (`:rules` → `no-caller-rules`, `:view` and `:result-transform` → runs as code, others → the key list); `:title` a string, flags booleans, `:inputs` a vector of at most `max-inputs`; `:query` a vector starting with `:find`; then `write-form-errors` on the whole map, `normalise-query`, `validate-query` with the inputs, and `fn-bindings-refusal` (its message, answered as a plain reason). All reasons for one text are joined with `; `, as `checked-query` joins them.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: add `set-query-block!` and `read-back-query-block`; `ensure-activity-page!` calls `set-query-block!` with `{:mark? false}` and keeps its table-sorting datom. The `:mark?` option is accepted but writes nothing until Stage 4 (a `mark? true` call in this stage is not made by any caller).
- Create (in `.upstream`): `test/logseq/db_sync/semantic_query_block_test.cljs`, registered in `test_runner.cljs`.
- Create: `patches/0050-semantic-query-blocks.patch`.

**Interfaces produced:** `(check-query-block text)` → `{:ok text :form m}` / `{:error "query: …"}`; `(set-query-block! conn block-id text {:mark? false})`; `(read-back-query-block db block-id text mark?)` → reasons. Stage 2 calls all three.

- [ ] **Step 1: Write the failing tests:**
  - `check-query-block-accepts`: the Book query of spec §8a; the Activity page's own text (`activity-query-text :-1d-ms`, read from the namespace's var); a query with `:inputs [:current-page "x" 3]` and matching `:in`; every allowed flag; 4,000 characters exactly (padding inside a string literal). Each returns `{:ok text}`.
  - `check-query-block-refuses`: one case per spec §8c refusal that is about the text (`:rules`; a rule call `(task ?b)`; `%` in `:in`; `:result-transform`; `:view`; an unknown key; `:db/retract`; a map with `:db/id`; `re-find`; a cross product; 13 function bindings; 4,001 characters; an inputs count mismatch; `:inputs` not a vector; 21 inputs; a non-map; map-form `:query`; a `#js` reader tag; two forms; `:title 3`; `:collapsed? "yes"`). Each asserts the exact reason and that it starts with `query: ` once.
  - `check-query-block-agrees-with-datalog-query`: for every case above whose reason is not new to query blocks (the key list, vector form and flags are new), the same `:query` and `:inputs` sent to `datalog_query` through `handle-http` with `dry-run: true` is refused too (400 or the 12-binding 422), and each accepted case's `:query` is accepted by the dry run. This pins "a query `datalog_query` would refuse" to the real handler, not to a copy of its rules.
  - `activity-page-unchanged`: run `semantic-edit-stamps-test`'s first-flagged-write case and assert, from `:eavt`, that each Activity block's tags, value text, display type, lang and sorting are what they were (spec §8g). This can't fail first on a pure refactor; it pins the extraction (say so in the body).
- [ ] **Step 2: Run on the starting tree** and keep the failures (the function does not exist).
- [ ] **Step 3: Implement** as spec §3.1 and §3.4.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** drop the vector-form rule; drop `write-form-errors`; skip `validate-query`; skip `fn-bindings-refusal`; let `:view` through; count characters after parsing instead of the raw text; check `:inputs` count only when `:in` has more than `$`; in `ensure-activity-page!`, skip the lang set. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): a static check for stored query text, and one Query-block write`. Body: the failures seen, the mutation results, that no route changed (no vendor or manifest change), and cost (none yet: no request reaches the check).

**Done when:** every case agrees with `datalog_query`'s dry run, the Activity page is stored as before, all 50 patches apply from scratch, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0050, inserts make Query blocks

**Goal:** an advanced ```query fence or a `query` field on a node of `insert_block_tree`, `insert_block_children`, `batch_insert_block_trees` or `capture_to_today` makes a Query block; a query `datalog_query` would refuse answers 400 naming the node and writes nothing. Lands spec §3.2, §3.3, §3.4 (the insert caller), §3.6, §4 (the four insert tools and `update_block`'s kept reason), §6, §8 a to e and h, and acceptance 1 to 4 and the fence half of 6.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `fence-display-block`: a `query` fence (any case) returns `{:type :query :text inner}` when the trimmed inner text starts with `{`, else `{:kept simple-query-fence-reason}`; `query-fence-reason` goes.
  - `prepare-tree`: a node's query comes from the field (string, else refused) or a converted `:query` fence; `query-node-refusal` checks, in order, both given, E2EE, `display-type`/`lang` (field or in `properties`), the Query, Code, Math or Quote tag in `properties` or as an inline `#tag` that resolves to one of them, then `check-query-block`; the node keeps `::query` and `::query-from`, a fence-made node's title becomes `""`, and a `:query` fence never reaches `node-display`.
  - `insert-tree!`: for a fresh block with `::query`, after its properties and display, `set-query-block!` with `{:mark? false}` (Stage 4 turns it on) and `unverified!` on `read-back-query-block`'s reasons with the node's path; the response gains `query`, and `converted "query"` for a fence.
  - `tree-response`: keeps `query` with `verbose=false`.
  - `:semantic/blocks-update`: a `:query` fence from `fence-display-block` is kept with `update-query-fence-reason`, never converted.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `query` field on the tree-node schema (a string, at most 4,000 characters, with the map form of spec §4); the descriptions of `insertBlockTree`, `insertBlockChildren`, `batchInsertBlockTrees`, `captureToToday` and `updateBlock` (what converts, the checks, the response fields, the refusals, simple queries kept, and that the query runs in the owner's app without the server caps or the Private filter, spec §3.7).
- Modify (in `.upstream`): `semantic_query_block_test.cljs`; `semantic_display_type_test.cljs` (`query-fence-kept-test`'s reason); `e2ee_semantic_test.cljs` (the E2EE refusal).
- Modify: `patches/0050-…`, `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`, `connector/src/tools/semantic.ts` (`FENCE_HINT` as spec §3.8), `connector/src/tools/handwritten.ts` (the Code, math and quote section's query sentence, and one sentence in the Queries paragraph pointing at it, as spec §3.8), `connector/test/tools.test.ts` (replace the "```query fences stay text" phrase with phrases for the advanced fence, the `query` field, "checked as datalog_query checks a query", "a simple query stays text", "runs in your app" and the lack of server caps; a check that `FENCE_HINT` no longer says query fences always stay text; the four tools' vendored descriptions mention Query blocks).

- [ ] **Step 1: Write the failing tests**, each through `handle-http`:
  - `fence-converts-<tool>` for each of the four tools (spec §8a): the Book fence on a page that already has blocks gives a block whose tags include `:logseq.class/Query` and whose title is `""`; its value block, read from `:eavt`, has the inner text, display type `:code` and lang `"clojure"`; the response has `converted "query"` and `query`; `common-util/safe-read-string` of the stored text is a map whose `:query` is a vector starting with `:find`; order keys are distinct across the page. Batch: two entries on one page, each with a Query node.
  - `field-converts` (§8b): a node with a caption title and a `query` field keeps the caption, has no `converted`, and `verbose=false` still returns `uuid` and `query`. Review focus 11.
  - `query-refusals` (§8c, through a route): `:rules`, a rule call, `:view`, map-form `:query` and 4,001 characters on `insert_block_tree` (path `blocks[0]`), one nested (`blocks[0].children[1]`), one in a batch (`entries[2].blocks[0]`) and one on capture; field and fence on one node; query with `display-type`, with `lang`, with `logseq.property.node/display-type` in `properties`; with Query, Code, Math or Quote in `properties` and as an inline `#Query`; a non-string field. Each 400 names the path and the reason, and the datom count and `max-tx` are unchanged. Review focus 2, 7, 8 and 12.
  - `query-e2ee` (in `e2ee_semantic_test.cljs`): a `query` field on an E2EE graph answers `blocks[0]: query: not on an E2EE graph`; a fence there is stored as sent (nothing converts on E2EE, as now).
  - `simple-fences-stay-text` (§8d): `query-fence-kept-test`'s `(task todo)` paths with the new reason; `"text"` and an empty fence kept; `convert-fences=false` keeps an advanced fence, valid or not, while a `query` field on the same call converts (review focus 3 and 4); `update_block` with an advanced fence keeps it with `update-query-fence-reason`.
  - `query-dry-run` (§8e): `dry-run: true` on `insert_block_tree`, `insert_block_children` and `batch_insert_block_trees` returns the conversion and `query`, and a refusal; the datom count is unchanged.
  - `query-fence-shapes`: review focus 1, 5 and 6.
  - `query-upload-path` (§8h): one fence insert on a `semantic_uploaded_graph_schema_test`-style graph reads back as above.
  - Connector (vitest): the new `CODE_BLOCKS_HELP` phrases and `FENCE_HINT`, red until the text changes.
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures. Expected from the repro: `fence-converts-insert_block_tree` fails with the block untagged and `kept` holding `query fences stay text; a Query block is not supported yet`; `query-refusals` fail with 201.
- [ ] **Step 3: Implement** as spec §3.2, §3.3, §3.4 and §3.6; then the route text, re-vendor and the connector text.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** treat any `query` fence as advanced (drop the `{` test); skip `check-query-block` for fences; skip it for fields; drop the both-given check; drop the display-type check; drop the tag check; drop the E2EE check; leave a fence-made title as the fence; drop `query` from the `verbose=false` response; skip `read-back-query-block`; set the Query block on a reused uuid. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): an advanced query fence or a query field makes a Query block`. Body: the quoted failures (the repro's 201 and `kept` turned into a Query block), the mutation results, the response change (`query`, `converted: "query"`), the kept reasons before and after, that the manifest and `FIRST_LINES` did not change, and cost (about 4 property sets per Query block in the insert's transaction; the DO CPU the 100-node test printed, to be measured properly in Stage 5).

**Done when:** each of the four tools makes a Query block that reads back from `:eavt`, every refusal names its path and writes nothing, simple fences stay text with the new reason, the connector text matches the vendored descriptions, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0050, close the property paths

**Goal:** no property write can store a query or a Query tag, or strand one by removing the tag or the query. Lands spec §3.5 (the first two bullets, with decision 6), §4 (`set_block_property`, `batch_set_block_property`, insert-node and batch-entry properties), §6 *One way in*, §7 risk 5, §8f (the property half), and acceptance 5.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `set-property-refusal` refuses `:logseq.property/query` (one change covers `set_block_property`, `batch_set_block_property`, node `properties` and batch-entry `properties`, which all reach it through `prepare-properties` or `batch-entries-error`).
  - The class branch of property resolution refuses Query as a tag value, by title, UUID or ident, unless the target already holds it (a held Query is a no-op, as a held display class is).
  - `kept-tag?` (and so `set-prepared-tags!` under reset) and the `final-tags` overlay's `kept?` keep Query, in step (CLAUDE.md gotcha: change them together, in request order).
  - The delete-value checks and the `delete_block_property` and `batch_delete_block_property` paths refuse the Query tag and `logseq.property/query` on a block that holds them.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the descriptions of `setBlockProperty`, `batchSetBlockProperty`, `deleteBlockProperty` and `batchDeleteBlockProperty` name the refusals.
- Modify (in `.upstream`): `semantic_query_block_test.cljs`; `semantic_batch_class_check_test.cljs` if the overlay test lives there.
- Modify: `patches/0050-…`, the vendored files, `connector_help` (the sentence "Code, Math and Quote can't be given as tags: use display-type" gains Query and the query field; a sentence that `logseq.property/query` is refused on the property tools), and their tests.

- [ ] **Step 1: Write the failing tests:**
  - `property-paths-refuse-query` (§8f, the repro's two 200s): `set_block_property` with `logseq.property/query` holding the repro's `:rules` text, and with a valid map, answers 400 `entry 0: logseq.property/query can't be set here; …`; the same in `batch_set_block_property` as entry 3 of a batch whose other entries are valid; in a node's `properties` and a batch entry's page `properties` naming the path. Nothing written in any case.
  - `property-paths-refuse-query-tag`: review focus 16, each case on a plain block and on a Query block made by Stage 2's insert (where a list holding Query and a new tag adds only the new tag).
  - `reset-keeps-query-tag`: review focus 13 on `set_block_property` and `batch_set_block_property`; the Query block still reads back as in Stage 2.
  - `batch-class-check-sees-kept-query`: review focus 14, with the tag entry before and after the set entry.
  - `delete-paths-keep-query`: review focus 15.
  - `other-writers`: `create_task`, `save_document`, `update_page` and `promote_page_to_tag` either reach `set-property-refusal` or never write `:logseq.property/query` or `:block/tags`; list each with the line that shows it in the commit body, and add a test for any that writes either (spec §7 risk 5).
  - Connector: the help phrases, red until the text changes.
- [ ] **Step 2: Run on the Stage 2 tree** and keep the failures (the repro's 200s).
- [ ] **Step 3: Implement** as spec §3.5.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** drop the `:logseq.property/query` case from `set-property-refusal`; drop the Query case from the tag refusal; refuse a held Query (drop the held exemption); drop Query from `kept-tag?`; drop it from the `final-tags` overlay only; drop the delete refusal for the tag; drop it for the query. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `fix(api): refuse the query property and the Query tag on the property paths`. Body: the quoted 200s now 400s, the list of other writers and what each does, the mutation results, that the manifest and `FIRST_LINES` did not change, and cost (none: refusals before any write).

**Done when:** every property path refuses the query and the Query tag naming the entry, a reset or delete can't strand a Query block, the overlay agrees with the apply step, and `scripts/check.sh --upstream` is green.

---

### Stage 4: Patch 0050, the marker and the `update_block` guard

**Goal:** a Query block Claude inserts carries the marker, and `update_block` may change only those: the Query block's caption freely, its value block only with text that passes `check-query-block`. Any other Query block, or one it can't tell, is refused naming the block. Lands spec §3.5 (the `update_block` bullets, with decision 4), §4 (`update_block`), §7 risk 9, §8f (the update half), and acceptance 6.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `check-query-marker-schema` and `ensure-query-marker-schema!`, following `check-stamp-schema` and `ensure-stamp-schema!` (hidden, checkbox, cardinality one, found by ident; another property with the title `claudeQueryBlock` compared as `:block/name` is in the way). The insert path runs the check before the write and inside the temp conn, as `authored-write!` does for stamps, and creates the property only when the call makes a Query block.
  - `set-query-block!` with `{:mark? true}` sets the marker to `true` on the Query block; `read-back-query-block` checks it. Stage 2's insert caller passes `{:mark? true}`; `ensure-activity-page!` keeps `false`.
  - `stamp-property-refusal`'s map, or `set-property-refusal`, refuses writing the marker on every property path.
  - `query-holder`, `claude-query-block?` and `query-block-refusal`. In `:semantic/blocks-update`, before `atomic-write!`: when the target is tagged Query or is a value block whose `:logseq.property/created-from-property` is `:logseq.property/query`, find the Query block (itself, or `query-holder` through `:avet`/`:vaet` datoms, never `:block/parent` alone), and refuse 409 unless `claude-query-block?` is `:yes`. For a value block, also refuse `display-type` and `lang`, and run `check-query-block` on the new title (`title: query: <reason>`, 400); a valid text is saved verbatim (the value block is `:code`, so no title step runs) and keeps its display type and lang, read back in the transaction.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: `updateBlock`'s description (only Query blocks Claude created; the check on a value block; the refusals); the insert tools' descriptions mention the hidden marker in one clause.
- Modify (in `.upstream`): `semantic_query_block_test.cljs`; `semantic_edit_stamps_test.cljs` if the stamp/marker interaction test sits better there.
- Modify: `patches/0050-…`, the vendored files, `connector_help` (one sentence: update_block changes only the Query blocks Claude made, and checks their new query; the owner's own Query blocks are refused), and their tests.

- [ ] **Step 1: Write the failing tests:**
  - `insert-marks-query-block`: a Stage 2 fence insert now has the marker `true` on the Query block (from `:eavt`) and not on the value block; the marker property exists, hidden, checkbox; a second insert creates no second property. Review focus 21, with stamps on and off and tx-meta asserted.
  - `marker-conflict`: review focus 20.
  - `marker-refused-on-property-paths`: `set_block_property` and a batch entry naming `user.property/claude-queryBlock` are refused naming the entry.
  - `update-own-query-block` (§8f, the repro's third 200 turned round): on a Claude-made Query block's value block, a rule call `(page-ref ?b ?p)` answers 400 `title: query: where 1: (page-ref …) calls a rule; …` and nothing changes; a valid map is stored and keeps `:code` and `"clojure"`. Review focus 17 and 18.
  - `update-owner-query-block`: a Query block built the way the app's `/advanced query` command builds it, unmarked (made with the outliner directly in the fixture, not through the API, since the API can no longer make one): `update_block` on its value block, with valid text, and on its caption, each answer 409 naming the block, and nothing changes. The Activity page's blocks the same (review focus 22).
  - `update-cant-tell`: review focus 19.
  - Connector: the help phrase, red until the text changes.
- [ ] **Step 2: Run on the Stage 3 tree** and keep the failures (`update_block` answers 200 on the owner's block and with the rule call).
- [ ] **Step 3: Implement** as the decision under *Architecture* and spec §3.5 with §12 decision 4.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** skip the guard for value blocks; skip it for the Query block's caption; treat `:unknown` as `:yes`; read the marker from the value block instead of the Query block; find the holder by `:block/parent`; skip `check-query-block` on a value-block update; let `display-type` through on a value block; mark the Activity page's blocks; skip the marker conflict check; drop the marker from the property-path refusal. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): update_block changes only the Query blocks Claude created`. Body: the decision on how "created by Claude" is known and why (stamps mean edited, and `created-by-ref` names the owner for both), its known limits (a copied block keeps the marker), the quoted 200s now refused, the mutation results, that the manifest and `FIRST_LINES` did not change, the tier note, and cost (one more property set per Query block; the marker property's upsert once per graph).

**Done when:** every Query block Claude inserts is marked and reads back so, the owner's and the Activity page's Query blocks can't be changed by `update_block`, a Claude-made value block takes only checked text, no path gives a 200 when it can't tell, and `scripts/check.sh --upstream` is green.

---

### Stage 5: The release bundle and the CPU number

**Goal:** the new code works in the release bundle, where Closure's advanced compilation has broken `datalog.cljs`'s reader before, and the Durable Object CPU of the worst insert is measured. Lands spec §5 (the CPU line), §8 *Release bundle*, and §9 item 4 (the number, for As built).

**Files:**
- Modify: `scripts/release-query-check.mjs` and `.test.mjs`: a check that inserts the Book fence and a `query` field through the bundle's `handle-http`, reads both back (tag, value text, `:code`, `"clojure"`, the marker), and that a `:rules` query is refused with its reason; it captures `console.error` as the existing checks do.
- Modify: `scripts/bench-datalog-query.mjs` and `.test.mjs`: a `query-block` mode timing `check-query-block` alone and a `batch_insert_block_trees` of 100 Query nodes of 4,000 characters each, cold and warm, parse and write reported apart.
- No patch change is expected. If the bundle exposes a renaming fault, the fix goes into patch 0050 here (for example an extern or a `^js` hint) and this stage runs the patch workflow.

- [ ] **Step 1: Write the failing tests:** the new release check, and the bench test's mode-field and output assertions, red until the mode and check exist.
- [ ] **Step 2: Run on the Stage 4 tree** after `scripts/build.sh .upstream`, and keep the failures.
- [ ] **Step 3: Implement**, then run the bench at the cap and record the table.
- [ ] **Step 4: Run the gate** (`scripts/check.sh --upstream` on a freshly built bundle; confirm it ran `release-query-check.mjs` and that no WARNING names it or the bench test). **Mutation check:** in the release check, drop the marker read-back; weaken the refusal check to a status only; in the bench test, drop a reported field. Confirm a check fails for each. Revert.
- [ ] **Step 5: Commit and push.** `test(scripts): check Query blocks in the release bundle and bench a full batch`. Body: the bench table (mode × cold and warm ms, parse and write apart), whether the release check was ever red and what fixed it, and that Node on a developer machine guides but does not measure the Durable Object on Cloudflare.

**Done when:** the release check passes on a freshly built bundle, the bench reports the 100-node batch, its number is in the commit body for the docs step's As built note, and `scripts/check.sh --upstream` is green with its skips listed.

---

## After the stages (the lane's docs step, not this plan)

- README §11.8: the "Fences become blocks" bullet (advanced fences and the `query` field make Query blocks; simple ones stay text; the closed paths; `update_block` only on Claude's Query blocks; no server caps or Private filter in the app), and backlog item 21 narrowed to simple queries.
- The spec's As built section: the marker decision, the CPU number from Stage 5, and the owner's manual check (spec §9 items 2 and 3) once deployed.
- The PR body: the quoted failures from each stage, the reproduction re-run on HEAD, `scripts/check.sh --upstream` on HEAD with its skips, and the Logseq skill note (the owner's skill can ask for Query blocks with an advanced map in a `query` field or fence; it should not tell Claude to write `{{query}}` or DSL text expecting it to run; Claude can't change the owner's own Query blocks; a hidden `claudeQueryBlock` property appears in the graph on first use).
