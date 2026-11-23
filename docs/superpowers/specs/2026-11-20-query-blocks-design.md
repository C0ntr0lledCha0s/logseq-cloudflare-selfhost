# Query blocks from a query fence or a query field: design

Date: 2026-11-20
Issue: item 49 on the tracker ("Query blocks: a query fence or query field makes a real Query block"), split from item 31's acceptance 3. Areas: patch, connector, docs.
Branch: `feat/query-blocks`, at `2f6998e` ("docs(spec): tool-routing-hints-first-line"), stacked on `feat/tool-routing-hints` (item 68, PR 71), PR 70 and the bug-fix stack PRs 59 to 69, 0 commits behind it.
Upstream: `logseq/logseq` at `UPSTREAM_REF` (`e7e9c97`), `deps/db-sync`, with patches 0001 to 0049. This work adds patch **0050**.
Builds on: `2026-11-08-code-block-display-type-write-design.md` (patch 0037, the fence handling that keeps ```query as text), `2026-11-09-datalog-query-named-queries-design.md` and `2026-11-17-named-queries-as-code-design.md` (patch 0039, datalog_query's parser, validator and refusals), patch 0034's `ensure-activity-page!` (the server already writes two Query blocks this way), `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/api/title-resolves-outside-allowed-values.md`, `docs/solutions/api/read-hid-built-in-properties.md`, and README backlog item 21.

The design panel chose the "minimal" proposal: reuse datalog_query's static checks on the stored query text, write the block the way patch 0034 and the app's advanced-query command already do, and close the other paths that could store an unchecked query. No ideas were grafted from other proposals. Decisions marked **(call)** were made while writing this spec; the ones most worth a second look are in section 11.

**What was checked for this spec, at `2f6998e`.** A throwaway test namespace (`zz-query-block-repro-test`, not committed, removed after the run) drove the real handler through `sync-handler/handle-http` against a fresh graph in `.upstream`, using `scripts/upstream-test.sh .upstream zz-query-block-repro`. Its output:

```
REPRO fence status 201 kept [{:path "blocks[0]", :reason "query fences stay text; a Query block is not supported yet"}]
REPRO fence stored tags () query prop nil
REPRO put query status 200 {:updated true, ...}
REPRO put tags status 200 {:updated true, ...}
REPRO holder tags (:logseq.class/Query) query value title "{:query [:find ?b :in $ % :where (task ?b #{\"TODO\"})] :rules []}" display nil
REPRO update value block status 200 {..., :title "{:query [:find ?b :where (page-ref ?b ?p)]}", ...}
REPRO get_block {:properties [{:ident "logseq.property/query", :title "Query", :type "default", :value "{:query [:find ?b :in $ % :where (task ?b #{\"TODO\"})] :rules []}"}], :tags [{... :ident "logseq.class/Query", :title "Query"}]}
```

So, reproduced on HEAD:

1. **The problem.** An advanced-query fence (```` ```query\n{:query [:find (pull ?b [*]) :where …]}\n``` ````) sent to `insert_block_tree` answers 201 and is listed under `kept`; the block has no tags and no `:logseq.property/query`. The cause is the `"Src"` branch of `fence-display-block` in `semantic.cljs` (patch 0037), which returns `{:kept query-fence-reason}` for any fence whose language is `query`.
2. **A gap the design must close (found while checking, not in the brief).** Today `set_block_property` already writes `logseq.property/query` with any text, including `:rules`, `%` and a rule call, and `block/tags` already accepts `logseq.class/Query`. `update_block` on the query's value block rewrites the text with a rule call (`page-ref`) and answers 200. So Claude can already make an unchecked Query block in three calls. The value block was written without display-type `:code`, so the app would not show it as an advanced query editor; whether it runs is section 2's `query-result`, which reads any map as advanced. Running it in the app was not checked (no live graph write).
3. **get_block** shows `logseq.property/query` as its text under `value` (not as a uuid and title, as the panel's proposal assumed). The value block's uuid is not shown there.

The app-side claims in section 2 were read from upstream source at `e7e9c97` (`deps/db/src/logseq/db/frontend/class.cljs` and `property.cljs`, `src/main/frontend/commands.cljs`, `handler/editor.cljs`, `components/block.cljs`, `components/query.cljs`, `db/query_custom.cljs`, `worker/handler/query.cljs`). They were not run in the app.

## 1. Goal

A query Claude writes through the connector should run in the owner's app as a Query block, not sit as fence text until the owner converts it by hand. It must stay as safe as `datalog_query`: read-only and no rules.

Acceptance (the brief):

1. A query fence inserted through the connector runs as a Query block in the app.
2. A query `datalog_query` would refuse is refused on insert, naming the node.
3. `connector_help` documents it; a regression test through the real handler, seen to fail first.

## 2. Context

**How the app makes a Query block.** `:logseq.class/Query` is a built-in class with schema property `:logseq.property/query`. It is in `block-kind-tags`, not in `private-tags` (Page, Property, Tag, Asset, Journal, Whiteboard, Pdf-annotation), so the outliner's private-tag notification (CLAUDE.md gotcha) does not fire for it; the repro tagged a block Query with a 200. `:logseq.property/query` is `{:type :default :public? true :hide? true :view-context :block}`, so its value is a value block (`:logseq.property/created-from-property` = query) whose title holds the query text.

- The `/advanced query` command (`commands.cljs` `advanced-query-steps`) sets `:block/tags :logseq.class/Query`, sets `:logseq.property/query ""`, then sets `:logseq.property.node/display-type :code` and `:logseq.property.code/lang "clojure"` on the value block.
- The `/query` command (`editor.cljs` `run-query-command!`) tags the block Query, moves the block's title into the value block and saves the block's own title as `""`. It sets no display type: that is a simple query.
- At render (`block.cljs` `query-result`), the app reads the value block's title with `common-util/safe-read-string`. A map runs as an advanced query; anything else runs as a DSL query. The editor shows the query as a Clojure code block only when the value block's display type is `:code`.
- An advanced map runs through `query-custom/custom-query`. It goes to the DSL path unless `(:query m)` is a **vector whose first element is `:find`**, and the worker's `execute-custom-query` refuses anything else with "Invalid custom query". So a map-form `:query {:find … :where …}`, which `datalog_query` accepts, does not run in the app. (Read from source, not run.)
- The worker's `add-query-rules` finds calls to the app's built-in DSL rules (`task`, `page-ref` and the rest) in `:where` and adds those rules itself, plus any `:rules` the map holds.
- `:inputs` are resolved on the client: keywords such as `:current-page`, `:today`, `:-7d-ms` and `:query-page` become values, and a string input is re-read as EDN (`query-input-value`). `resolve-page-ref-equality` rewrites `(= ?x "[[page]]")` into `(contains? ?x "page")`.
- `:view` is evaluated with SCI (`components/query.cljs`, `sci/eval-string`), and `:result-transform` is either a keyword looked up in the repo config or a form the app runs on the results. Both run as code in the owner's app.
- Other keys the app reads: `:title`, `:collapsed?`, `:group-by-page?`, `:remove-block-children?`, `:breadcrumb-show?`.

**What the server already does.** Patch 0034's `ensure-activity-page!` (`semantic.cljs` around line 2127) writes two advanced Query blocks on the Claude Activity page exactly like the app's command: tag, query text, then `:code` and `"clojure"` on the value block. `semantic-edit-stamps-test` pins that text. So the write itself is proven on the server.

**What datalog_query checks** (patch 0039, `datalog.cljs`). Before it runs a query: `parse-edn` (one EDN form, only `#uuid` and `#inst` tags, nothing evaluated), `write-form-errors` (no `:db/add` and friends, no `:db.fn/*`, no map with `:db/id`), `normalise-query` (only `:find :in :where :keys :strs :syms :with`; `:rules` gets `no-caller-rules`), `validate-query` (`:in` starts with `$`, no other source, no `%`; inputs count matches `:in`; every `:where` clause checked: functions only from `allowed-fns`, joining functions take at most one variable, every rule call refused, cross products refused), `fn-bindings-refusal` (at most 12 function bindings, a 422), `max-query-chars` 4,000 and `max-inputs` 20. At run time it adds the scan, join, text, call, work, width and row caps and the Private filter.

## 3. Design

All server changes are in patch 0050. The connector has no code change (section 3.8).

### 3.1 `check-query-block` in datalog.cljs (call)

A new public function `check-query-block [text]` returns `{:ok text}` or `{:error message}`. It reuses the existing private helpers (made callable within the namespace) and adds a key allow-list:

1. `text` is a string of at most `max-query-chars` (4,000) characters, counted over the whole map.
2. `parse-edn "query" text` reads one form, which must be a map. Otherwise `query: give an EDN map {:query [:find … :where …] :inputs […]}`.
3. Keys. Allowed: `:query` (required), `:inputs` (a vector of at most `max-inputs` values), `:title` (a string), and the booleans `:collapsed?`, `:group-by-page?`, `:remove-block-children?` and `:breadcrumb-show?`. Refused with a reason each:
   - `:rules`: `no-caller-rules`.
   - `:result-transform` and `:view`: `:<key> is not accepted; it runs as code in the app`.
   - any other key: `:<key> is not accepted (keys: :query, :inputs, :title, :collapsed?, :group-by-page?, :remove-block-children?, :breadcrumb-show?)`.
   - `:title` not a string, a flag not a boolean, `:inputs` not a vector: named.
4. **`:query` must be a vector starting with `:find`** (call). This is stricter than `datalog_query`, which also takes the map form, because the app runs only the vector form (section 2). Refusal: `query: give :query as a vector [:find … :where …]; the app runs only that form`.
5. Then the same checks `checked-query` applies, in its order: `write-form-errors` on the whole map, `normalise-query`, `validate-query` with the `:inputs` vector, and `fn-bindings-refusal` (its 422 message, answered here as a 400 since nothing runs).
6. Inputs. Literal values and keywords are accepted as given, since the client resolves keywords such as `:current-page`, `:today` and `:-7d-ms`. `validate-query` already matches their count to `:in`.

So a query block passes exactly the static checks `datalog_query` applies before it runs a query, plus the key allow-list and the vector-form rule.

### 3.2 Fences

In `fence-display-block` (patch 0037), the `query` branch reads the fence's inner text. When the trimmed inner text starts with `{`, it returns `{:type :query :text inner}`. Any other query fence is a simple query and stays text under `kept`, with the new reason `only an advanced query ({:query [...]}) becomes a Query block; a simple query stays text`. The query check runs in `prepare-tree` (3.3), not here, so a malformed advanced fence is **refused** with its path and reason, not kept.

`update_block` does not make Query blocks: a ```query fence in its title stays text, with the reason `update_block doesn't make Query blocks; insert one`. `convert-fences=false` keeps a query fence as text like any other fence. Nothing converts on an E2EE graph, as now.

### 3.3 The `query` field on insert nodes (call)

Tree nodes on `insert_block_tree`, `insert_block_children`, `batch_insert_block_trees` and `capture_to_today` take an optional `query` string. `prepare-tree` runs `check-query-block` on a node's query (from the field or a converted fence) and returns `{:error "<path>: query: <message>"}`, which answers 400 before anything is written. Also refused, each naming the node's path:

- a `query` field and a ```query fence on one node: `query: given both as a field and as a fence`;
- `query` together with `display-type`, `lang`, or the same in `properties`: `query: a Query block takes no display-type or lang`;
- `query` with `logseq.class/Query`, Code, Math or Quote among its tags: `query: the Query tag is set by the query field`;
- `query` on an E2EE graph: `query: not on an E2EE graph`.

A fence-made Query block gets the title `""`, as `run-query-command!` leaves it. A query-field node keeps its title as a caption (call), which the app shows above the results.

### 3.4 One write: `set-query-block!`

A helper `set-query-block! conn block-id text` is pulled out of `ensure-activity-page!`, which then calls it, so there is one copy of the write. It sets `:block/tags :logseq.class/Query`, `:logseq.property/query text`, and on the value block `display-type :code` and `lang "clojure"`. `insert-tree!` calls it after the node's properties and display, for fresh blocks only (a reused uuid is left as it is, as now).

Read-back inside the transaction through `unverified!`, naming the node's path, answers 500 if any of these doesn't hold: the block's tags include Query; the value block's title equals `text`; its display type is `:code`; its lang is `"clojure"`. The value block is read through `:eavt` datoms, not only the entity, per the upload-path gotcha.

### 3.5 Closing the other paths (call)

The repro shows that the property paths and `update_block` can store an unchecked query today. Patch 0050 closes them:

- `set-property-refusal` refuses `:logseq.property/query` with `logseq.property/query can't be set here; use the query field on an insert node`. It already serves `set_block_property`, `batch_set_block_property` and a node's `properties`, so one change covers all three. Review must confirm `capture_to_today`, `create_task` and `save_document` either share it or never write this property.
- `block/tags` with `logseq.class/Query` through the property paths is refused with `Query can't be given as a tag; use the query field on an insert node`, as Code, Math and Quote are refused today (one way in, so tag and query can't drift).
- `update_block` on a block whose `:logseq.property/created-from-property` is `:logseq.property/query` runs `check-query-block` on the new title, and refuses with `title: query: <message>` (400). A valid map is stored, and display-type and lang stay as they are.
- Existing Query blocks the owner made in the app are not touched by any of this until Claude edits their value block through `update_block`. Then the check applies. An owner's simple query (DSL text) on a value block would be refused by that check; see section 11, question 4.

### 3.6 Responses

A fence-made Query block is marked `converted: "query"`. Every Query block an insert makes carries `query` (the stored text) in its response, also with `verbose=false`, because it is news to the caller. `dry-run: true` on `insert_block_tree`, `insert_block_children` and `batch_insert_block_trees` shows conversions, kept fences and refusals without writing. `capture_to_today` has no dry-run today and gets none.

### 3.7 What read-only and no rules mean on the owner's client

The query runs in the owner's app, not on the server. The spec says this plainly in `connector_help` and README §11.8:

- **Read-only** holds on the client too: Datascript's `q` cannot write. The write-form check is defence in depth, and keeps a stored query readable as a query.
- **No rules** means Claude cannot send rules or rule calls: no `:rules`, no `%` in `:in`, no rule call in `:where`. The app adds its built-in DSL rules only for rule calls it finds, so a query that passes the check gets none.
- **No code.** `:view` and `:result-transform` are refused, because the app runs them.
- **No runtime caps.** The scan, join, text, call, work, width and row caps, and the 12-binding cap's purpose of bounding work, apply only when `datalog_query` runs a query on the server. A statically valid but costly query (a large self-join with no cross product) can slow or freeze the owner's app tab whenever the page is open.
- **No Private filter.** The app runs the query over the owner's whole graph, Private included, and shows the results there. The connector never reads the results, so nothing Private reaches Claude through this.

### 3.8 Connector and docs

No connector code changes: the tree node schema comes from the vendored OpenAPI. Text changes:

- `connector/src/tools/handwritten.ts` `connector_help` Code, math and quote section (line 12): replace "```query fences stay text, as a Query block is not supported yet" with the new rules (advanced query fence or `query` field makes a Query block; the checks; simple queries stay text; it runs in the app without the server caps or the Private filter). The Queries paragraph (line 24) gains one sentence pointing at it.
- `connector/src/tools/semantic.ts` `FENCE_HINT` (line 86): "```query fences stay text" becomes "an advanced ```query fence (or a node's query field) becomes a Query block, checked as datalog_query checks a query; a simple query fence stays text, listed under kept".
- Patch 0050's OpenAPI: the `query` field on tree nodes; descriptions of `insertBlockTree`, `insertBlockChildren`, `batchInsertBlockTrees`, `captureToToday`, `updateBlock` and `setBlockProperty`.
- Re-vendor (`scripts/vendor-upstream-api.sh .upstream`), then `npm --prefix connector run update:manifest`.
- README §11.8: the "Fences become blocks" bullet, and backlog item 21 narrowed to simple queries.
- The PR's Logseq skill note: the owner's skill can now ask for Query blocks with an advanced map, and should not tell Claude to write `{{query}}` or DSL text expecting it to run.

## 4. Tool contract

No tool is added, removed or renamed.

**insert_block_tree, insert_block_children, batch_insert_block_trees, capture_to_today.** Each tree node takes an optional `query`: a string holding one EDN map, at most 4,000 characters, of the form `{:query [:find … :where …] :inputs […]? :title "…"? :collapsed? bool? :group-by-page? bool? :remove-block-children? bool? :breadcrumb-show? bool?}`.

- A node with `query`, or whose whole title is a ```query fence holding such a map, becomes a block tagged Query whose `logseq.property/query` value holds the text as a Clojure code block. A fence-made block has title `""` and `converted: "query"`; a field-made block keeps its title.
- Every Query block in the response has `query` (the stored text), also with `verbose=false`.
- A refused query answers **400** `<path>: query: <reason>` and writes nothing. Examples:
  - `blocks[0]: query: where 2: (task …) calls a rule; datalog_query takes no rules, …`
  - `blocks[0].children[1]: query: :result-transform is not accepted; it runs as code in the app`
  - `blocks[0]: query: give :query as a vector [:find … :where …]; the app runs only that form`
  - `entries[2].blocks[0]: query: inputs: 1 value given, but :in binds 2 after $`
- Also refused, naming the node: query as both field and fence; query with display-type, lang or the Query, Code, Math or Quote tag; query on an E2EE graph.
- A ```query fence whose body isn't a map stays text under `kept` with `only an advanced query ({:query [...]}) becomes a Query block; a simple query stays text`.

**update_block.** A ```query fence in the title stays text under `kept` with `update_block doesn't make Query blocks; insert one`. On a Query block's value block, the new title must pass the same check (`title: query: <reason>`, 400).

**set_block_property, batch_set_block_property, properties on insert nodes and batch entries.** `logseq.property/query` is refused (`… use the query field on an insert node`), and so is `logseq.class/Query` as a tag. A batch names the entry (`entry 3: …`).

**get_block, get_blocks.** Unchanged: they show `logseq.property/query` with its text and the Query tag.

## 5. Cost on the Free plan

- **D1:** no rows read or written beyond what an insert already costs (the token lookup and the audit row). Per day, unchanged. No migration.
- **Workers AI and Vectorize:** none.
- **Worker requests:** unchanged, 2 per insert call (front Worker and Durable Object).
- **Front Worker CPU (10 ms):** no new work; the check runs in the Durable Object.
- **Durable Object CPU:** one EDN parse and static validation of at most 4,000 characters per query node, with a tree walk over the parsed form. This is the same work `datalog_query`'s dry run does before it runs anything, well under a millisecond; the build measures it at 4,000 characters with 100 query nodes in one batch (the batch cap) and records the time, per REVIEW.md *CPU is 10 ms per request* and `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`. The query is never run on the server, so none of `datalog_query`'s runtime cost is added.
- **Writes:** about 4 extra outliner property sets per Query block (tag, value block, display type, lang), the same as each Activity page block in patch 0034. 100 Query blocks in one batch is 400 extra sets in one transaction, comparable to a 100-block insert with properties.
- **No cron or indexer change.** The semantic indexer sees the new blocks as it sees any block (a Query block's own title is often `""`).

## 6. Safety

- **Refuse up front.** Every check runs in `prepare-tree` before any write; a refused node fails the whole call, as for properties and display today.
- **Read-back.** `set-query-block!` reads the tag, value text, display type and lang back inside the transaction and answers 500 naming the node if any differs.
- **Dry run.** Covers the three tree tools that have it.
- **One way in.** The property paths and the Query tag are refused; `update_block` on a value block is checked. So there is no path that stores an unchecked query through the connector (review confirms this, risk 5).
- **E2EE.** Refused, since titles are ciphertext and the server can't check the text.
- **Order keys.** The new block and its value block are created after `handle` seeds the max order key, as for patch 0034; a test asserts distinct keys.
- **No graph writes for this spec.** Nothing was written to the owner's graph.

## 7. Risks

1. **No runtime cap on the client.** A statically valid but costly query can freeze the owner's app tab whenever its page is open, and the owner would have to edit or delete it from a slow page. Options (section 11, question 1): accept it; or add a server check-run under `datalog_query`'s caps when every input is a literal (about the cost of one `datalog_query` call, up to roughly 100 ms of DO CPU, and it can't resolve `:current-page` and similar).
2. **Private content shows in the app.** The query runs over the whole graph on the owner's client. The connector never reads the results.
3. **Simple queries stay text.** The app expands DSL text with its own rules on the client; that parser isn't in db-sync, so the server can't check it. A simple query Claude writes still needs converting by hand.
4. **"A query datalog_query would refuse"** is read as its static 400 refusals plus the 12-binding 422, which are checked before a query runs. Its runtime 422s depend on the graph and the client's inputs and aren't reproduced on insert.
5. **Bypass through another path.** Review must check every writer of `:logseq.property/query` and of `:block/tags`: `set_block_property`, `batch_set_block_property`, node and batch `properties`, `capture_to_today`, `create_task`, `save_document`, `update_page`, `promote_page_to_tag`.
6. **The vector-form rule may be wrong.** It is read from `query_custom.cljs` and `worker/handler/query.cljs`, not run. If the app normalises map-form queries elsewhere, the rule is merely stricter than needed. The owner's manual check (section 9) confirms the vector form runs.
7. **Value-block drift.** If an outliner bump changes how `:default` values are stored, the read-back fails with a 500, not silently. The tests read the value through `:eavt`.
8. **Helper extraction.** Moving `ensure-activity-page!`'s write into `set-query-block!` changes only where the code lives. `semantic-edit-stamps-test` pins the Activity query text and must stay green.
9. **Owner queries refused on edit.** With the `update_block` guard, Claude can't edit an owner's simple query value block, or an advanced one holding `:view` or rules. That is the intended direction (no unchecked query written by Claude), but it is a new refusal on existing content.
10. **Contract surface.** `connector_help`, `FENCE_HINT`, the OpenAPI descriptions, `tools-manifest.json`, README §11.8 and the skill note must all say that ```query no longer always stays text. Missing one is a known REVIEW.md defect class.

## 8. Testing

A new upstream namespace, `deps/db-sync/test/logseq/db_sync/semantic_query_block_test.cljs`, drives the real handler with `request!` (through `sync-handler/handle-http`) against a real conn from `sqlite-export/create-conn`, as `semantic_display_type_test.cljs` does. Run with `scripts/upstream-test.sh .upstream semantic-query-block` while building and `scripts/check.sh --upstream` as the gate.

a. **Fence converts**, on each of insert_block_tree, insert_block_children, batch and capture: the fence ```` ```query\n{:query [:find (pull ?b [*]) :where [?b :block/tags ?t] [?t :block/title "Book"]]}\n``` ```` gives a block whose tags include `:logseq.class/Query` and whose title is `""`. Its `:logseq.property/query` value block, read from `:eavt`, has the inner text as title, display type `:code` and lang `"clojure"`. The response has `converted "query"` and `query`. `common-util/safe-read-string` of the stored title is a map whose `:query` is a vector starting with `:find` (the app's own test, from `query-result` and `execute-custom-query`). Order keys are distinct.
b. **Field converts** the same way and keeps the caption title; `verbose=false` still returns `query`.
c. **Refusals** answer 400, name the path, and leave the datom count unchanged: `:rules`; a rule call `(task ?b)`; `%` in `:in`; `:result-transform`; `:view`; an unknown key; a write form (`:db/retract`, a map with `:db/id`); a function off the allow-list (`re-find`); a cross product; 13 function bindings; over 4,000 characters; an inputs count mismatch; `:inputs` not a vector; a non-map; map-form `:query`; field and fence on one node; query with display-type; query with the Query tag; E2EE (in `e2ee_semantic_test.cljs` style).
d. **Simple fences stay text.** The existing `query-fence-kept-test` (`(task todo)`) keeps its paths with the new reason, and `update_block` keeps an advanced fence with its reason.
e. **Dry run** returns the conversion and `query` and leaves the graph unchanged.
f. **Closed paths.** `set_block_property` and `batch_set_block_property` with `logseq.property/query` and with the Query tag are refused (these are the repro's two 200s turned into 400s). `update_block` on the value block with a rule call is refused (the repro's third 200); with a valid map it is stored and keeps `:code`.
g. **Activity page.** `semantic-edit-stamps-test` passes unchanged after the helper extraction.
h. **Upload-path graph.** One fence insert on a `semantic_uploaded_graph_schema_test` style fixture.

**Seen to fail.** Write (a) for insert_block_tree, (c) for `:rules` and (f) first, run them on the 0049 tree and quote the failures in the PR. Expected from the repro: (a) fails with the block untagged and `kept` holding `query fences stay text; a Query block is not supported yet`; (f) fails with status 200 where 400 is expected.

**Connector.** vitest: `connector_help` and the four tools' descriptions mention Query blocks, and `FENCE_HINT` no longer says query fences always stay text; the tools-manifest check passes after `update:manifest`.

**Release bundle.** `scripts/release-query-check.mjs` on the bundle from `scripts/build.sh`, because the new code calls `datalog.cljs`'s reader and validator, and Closure renaming has broken that area before.

Run `scripts/check.sh --upstream` on the final commit and repeat in the PR what it skipped.

## 9. Rollout and verification

1. Merge to main deploys the sync server and the connector (`deploy` workflow). No migration, no switch.
2. After deploy, the owner inserts one Query block through Claude on a test page (for example the Book query in 8a), opens the page in the app, and checks that the results render and the query shows as a Clojure code block. This is the only check that the app runs what the server stores; record it under an As built section of this spec.
3. The owner also opens a page with the Claude Activity queries to confirm they still render after the helper extraction.
4. Record the measured DO CPU for a 100-node batch of 4,000-character queries under As built.

## 10. Out of scope

- Simple queries: `{{query …}}` text and DSL query fences stay text.
- Running or previewing a query's results on insert (see risk 1 for the check-run option).
- Converting existing ```query text blocks in the graph.
- `update_block` turning a block into a Query block, or removing a Query block's query (delete the block instead).
- `:view`, `:result-transform`, `:rules` and keyword result transforms from the repo config.
- Query table settings (`logseq.property.table/*`, as patch 0034 sets sorting), and Cards blocks (which extend Query).
- Changes to `datalog_query` itself.

## 11. Open questions for the owner

1. **Runtime cost in the app.** A query that passes the static checks can still be slow when its page opens, with no server cap. Accept that, or add a server check-run under `datalog_query`'s caps for queries whose inputs are all literals (about one `datalog_query` call's CPU per Query block, and queries using `:current-page` or `:today` can't be checked)?
2. **Private content.** The query runs in your app over the whole graph, so a Query block Claude writes can list blocks tagged Private there (Claude never sees the results). Acceptable?
3. **Simple queries out of scope.** Simple (DSL) queries stay text, because the server can't check that the app's expansion uses no rules. Is that the right line, or do you want a follow-up for a small checked subset (for example `(task …)` and `(property …)`)?
4. **Editing your own queries.** With the update_block guard, Claude can't change a Query block's text unless the result passes the check, so it can't edit your simple queries or advanced ones with `:view` or rules. Fine, or should the guard apply only to Query blocks Claude created?
5. **Caption title.** A `query` field keeps the node's title as a caption; a fence-made block gets `""`, as the app's `/query` command leaves it. Keep both?
6. **Query tag refused as a tag.** Setting `logseq.class/Query` through the property paths is refused so tag and query can't drift. That also stops Claude tagging a block Query and leaving you to fill in the query. Agreed?
7. **Spec file name.** The lane's driver note named this file `2026-11-20-query-blocks-design.md`; the stage that wrote it was told `2026-11-20-query-blocks-design.md`, which is what was used. Rename if you prefer the shorter name.

## 12. Owner's decisions (2026-11-22)

The owner answered section 11 on PR 72. These replace the open questions; the build follows them.

1. **Runtime cost:** accepted. No server check-run; the static checks are the only gate.
2. **Private content:** acceptable. A Query block may list Private blocks in the owner's app.
3. **Simple queries:** out of scope, as proposed. They stay text under kept.
4. **Editing Query blocks:** Claude may only update Query blocks it created. `update_block` on a Query block Claude did not create is refused, naming the block; a Query block Claude created may be updated, and its new text passes the same check. How "Claude created it" is known (for example the edit stamps, which exist only when "Mark Claude's edits" is on, or a marker the patch sets at creation) is a build-stage decision; with no way to tell, the write is refused.
5. **Caption title:** not answered; the spec's proposal stands (a `query` field keeps the node's title as a caption, a fence-made block gets `""`).
6. **Query tag:** refused through the property paths, so tag and query can't drift.
7. **File name:** shortened to `2026-11-20-query-blocks-design.md`.

The owner's comment numbered six answers; answers 5 ("no drift") and 6 ("shorten it") match questions 6 and 7, so question 5 is read as unanswered.

## 13. As built

Built as patch 0050 (plan: `docs/superpowers/plans/2026-11-22-query-blocks-fence-and-field.md`). The design held except for the points below.

- **How "created by Claude" is known (decision 4).** A hidden checkbox property, `claudeQueryBlock` (ident `user.property/claude-queryBlock`), set to `true` on the Query block (not its value block) by `set-query-block!` on insert. It is created in the owner's graph on first use, so this adds a schema entity. The edit stamps were rejected: they mean "Claude edited", exist only when "Mark Claude's edits" is on, and `created-by-ref` names the owner for both the app and the connector. A property in the marker's way refuses the insert with a 409. The Activity page's blocks are not marked. Known limit: a copy of a marked block keeps the marker, and the owner can set it by hand; both only widen what Claude may edit to blocks the owner chose.
- **`update_block` guard (changes section 3.5).** The refusal is a 409, not a 400: `update_block changes only Query blocks Claude created` for an unmarked block, and `can't tell whether Claude created this Query block, so it isn't changed` when the marker or the holder can't be found. The guard covers the Query block's caption as well as its query. On a marked block, a new query text must pass `check-query-block` (`title: query: …`, 400), with no `display-type` or `lang`.
- **Property paths (extends section 3.5).** Besides `logseq.property/query` and the Query tag, the paths refuse the marker (`claudeQueryBlock is set by the server and can't be written`) and refuse `display-type` and `lang` on a Query block's value block, because either one stops the app reading the query as advanced code. The delete paths refuse removing the Query tag or the query (`delete the block instead`). Sending the tag a Query block already holds, or a reset tag list, keeps the tag instead of refusing.
- **Cost (section 5).** Each Query block adds about five outliner property sets (tag, query, display type, lang, marker), not four, plus the marker property's creation once per graph.
- **Measured CPU (section 9, item 4).** `scripts/bench-datalog-query.mjs --query-block`, warm median of 5 runs, Node v22.23.5 on a developer machine, release bundle: a batch of 100 Query nodes of 4,000 characters stores in about 2.3 s (2.6 s cold); parsing and checking alone take about 0.6 s of that, and the writes about 1.6 s. This guides the cost but is not a Durable Object measurement on Cloudflare.
- **Release bundle.** `scripts/release-query-check.mjs` now inserts the Book query as a fence and as a field through the release bundle and reads both back, and checks that a `:rules` query is refused.
- **Not yet done.** The owner's manual check in the app (section 9, items 2 and 3) waits for the deploy. Record its result here.
