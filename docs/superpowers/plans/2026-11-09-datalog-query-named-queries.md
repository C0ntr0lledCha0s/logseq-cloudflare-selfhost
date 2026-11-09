# Read-only Datalog query and named queries: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stages 1 to 4, `scripts/check.sh` in Stages 5 and 6), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can run read-only Datalog against a graph from a claude.ai chat. Patch 0039 adds `POST /query` (`datalog_query`) and `POST /named-queries/:name` (`run_named_query`) to the semantic API. Both run on a `d/filter` view of the db that hides private content and counts scanned datoms, after a static validator has refused write forms, unlisted functions, input-bound functions, cross products and unbounded pulls. The connector exposes both as generated READ tools and records one `kind='read'` audit row per call.

**Architecture:**
- **One upstream patch, `patches/0039-semantic-datalog-query.patch`**, grown over Stages 1 to 4 and regenerated against the 0038 baseline each time. It adds `worker/handler/datalog.cljs` (parse, validate, private filter, scan cap, pull rewrite, sort, truncate, serialise), `worker/named_queries.cljs` (the library, as data), the two routes in `worker/routes/semantic.cljs`, `dispatch-handle` entries only in `worker/handler/semantic.cljs`, and one new test namespace. Each stage leaves a complete, passing patch.
- **Each route stage classifies its own tool in the connector.** The connector generates a tool for every operation in the vendored openapi, and `annotationsFor` throws for a tool with no `ANNOTATIONS` entry; without `READ`, a POST would also be taken for a write and need `reason`. CI rebuilds the vendor from `patches/` on every push, so the stage that adds a route also re-vendors, adds the `ANNOTATIONS` entry and regenerates the manifest. Read tools need no `DELETE_RULES`, `SNAPSHOT_PLAN` or `readable.ts` entry (those throw only for write tools); Stage 1 has a test that says so.
- **Stage 1, read-only and private:** the `datalog_query` route, EDN parsing, the static validator, the private filter, the E2EE refusal, dry run, and a plain run with sort and `limit`. These are the guards every later stage relies on, so they land together.
- **Stage 2, caps:** the scan cap (422), the pull rewrite and pattern bounds, the byte cap, and the `truncated` notes.
- **Stage 3, the bench:** `scripts/bench-datalog-query.mjs` times the scan cap, the private-set build and the worst shapes of spec risk 1; the patch's `scan-cap` constant is set from it, and a rule-depth or `or`-branch limit is added only if a shape is over budget.
- **Stage 4, named queries:** `named_queries.cljs`, param resolution, the `run_named_query` route and its connector entry.
- **Stage 5, audit:** `recordRead(tool, status, …)` and `LOGGED_READS` in `registerGraphTools`.
- **Stage 6, the contract:** the Queries paragraph in `connector_help` and its tests. README §11.8 and the `docs/solutions` write-up are the lane's docs step (see the end).
- **No migration** (spec §3.10): migration 0004's `kind` CHECK already allows `'read'`, and `tool` and `status` are free text. No KV, Vectorize, Workers AI or semantic-index change.
- **Order:** the guards first, because a query that runs before they exist could write or leak; then the caps that keep it inside the CPU budget; then the bench that sets the cap's number before anything else is built on it; then the library, which reuses every guard; then the connector's accounting; then the text Claude reads.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real `sync-handler/handle-http` on a real conn built by `create_graph`, via the `with-graph` and request helpers of `semantic_promote_page_to_tag_test.cljs` and `semantic_favorites_test.cljs`); Datascript (Logseq's fork, `3f141af`); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers`; Node for the bench.

**Spec:** `docs/superpowers/specs/2026-11-09-datalog-query-named-queries-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) are the spec's. Spec §9's build order puts every handler test before the bench and the connector after the re-vendor; this plan folds each route's `ANNOTATIONS` entry into the stage that adds the route, for the reason under *Architecture*, and keeps the audit change (§3.10) and the help text (§3.11) as their own stages after the patch is complete.

## Global constraints

- **Names, exactly:**
  - patch `patches/0039-semantic-datalog-query.patch`; upstream test namespace `logseq.db-sync.semantic-datalog-query-test` in `deps/db-sync/test/logseq/db_sync/semantic_datalog_query_test.cljs`, required from `test_runner.cljs` after `semantic-favorites-test`;
  - new namespaces `logseq.db-sync.worker.handler.datalog` (`worker/handler/datalog.cljs`) and `logseq.db-sync.worker.named-queries` (`worker/named_queries.cljs`);
  - in `datalog.cljs`: `parse-edn` (`cljs.reader/read-string` with `:readers` limited to `uuid` and `inst`), `normalise-query` (vector form to map form), `allowed-fns` (a set, deny-by-default), `validate-query` (returns `nil` or the first refusal string per clause, collecting every clause's refusal into one message), `private-ids`, `ref-attrs`, `query-filter` (the `d/filter` predicate with the scan counter), `rewrite-pulls`, `validate-pull-pattern`, `type-rank`, `sort-rows`, `serialise`, `run-query`, and constants `scan-cap` (50,000 until Stage 3), `byte-cap` (100,000), `default-limit` (50), `max-limit` (200), `max-query-chars` (4,000), `max-inputs` (20), `max-pull-depth` (2), `many-attr-limit` (50);
  - handler keys `:semantic/datalog-query` and `:semantic/named-query`; operation ids `datalogQuery` (`POST /api/v1/graphs/:graph-id/query`) and `runNamedQuery` (`POST /api/v1/graphs/:graph-id/named-queries/:name`), both `logseq/read`, rate class read;
  - named queries `projects-untouched`, `meetings-without-decision`, `open-tasks-by-client`, `pages-missing-property`;
  - connector tools `datalog_query`, `run_named_query`; the set `LOGGED_READS` in `connector/src/tools/semantic.ts`.
- **Messages, in the spec's wording (§3.3, §3.5, §3.6, §3.7, §3.9, §4):**
  - `where 2: function transact! is not allowed (allowed: =, <, …)`; `where 3: ?f is a variable in function position; functions can't be passed as inputs`; `query: :db/add is a write form; datalog_query is read-only` (400);
  - `where: clauses 1 and 3 share no variable (a cross product); join them through a shared variable` (400);
  - `query stopped after scanning 50,000 datoms (the scan cap); narrow it with a tag, page or attribute value, or use a named query` (422; the number follows the constant);
  - `returned 50 of 1,234 rows (limit 50, maximum 200); narrow the query or add a :where clause` (the `limit` note), and a matching `byte-cap` note naming 100,000 characters;
  - `datalog_query is unavailable on an E2EE graph (titles are ciphertext)` (409), also for `run_named_query`;
  - `params.tag: no tag titled Projet`, `params.days: must be 1-3650` (400); an unknown name answers 404 listing the four names;
  - a parse error names its position; an `inputs`/`:in` mismatch names both counts; a pull refusal names the attribute or the depth.
- **Every check runs before the query runs.** E2EE first, then parse, then validate, then (for named queries) params. A refused call never builds the private set and never touches the scan counter.
- **Read-only by construction** (spec §3.3): only `(d/filter @conn pred)` reaches `d/q` and `d/pull`; no code path in `datalog.cljs` names `conn`, `transact!` or `atomic-write!`. A test checks `max-tx` and the datom count after every refusal.
- **No 500 for a caller's query.** Every exception from parse, validation, the scan counter or Datascript's own `Unknown function`/`Insufficient bindings` errors is mapped to a named 400 or 422. A 500 is reserved for a bug, and a test runs the mixed-type sort that would otherwise throw.
- **No silent wrong answer.** A truncated result says which cap applied; the scan cap refuses rather than returning partial rows; E2EE refuses rather than matching nothing; a named query default that does not resolve is a 400, never empty rows.
- **Free plan** (spec §5): each call costs 2 Worker requests, about 1 D1 row read (graph token) and, from Stage 5, 2 D1 rows written (the read row and its index entry); 0 neurons, 0 Vectorize dimensions, 0 KV. Each stage's commit body states its cost per call.
- **Tests run the real thing.** Every upstream test goes through `handle-http`, the real outliner and a `create_graph` db, with fixtures built by real writes (tags through the real tag path, recycled pages through `deletePage`). No test stubs Datascript or the filter (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Every new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Example data only (`Example`, `Projects`, `Business Meeting`, `forClient`, `sync.example.com`, `mcp.example.com`, alias `test`).
- **Contract with Claude.** The openapi summaries and descriptions land with the behaviour, in the stage that adds or changes it (spec §3.11): caps, the private rule, E2EE, pulling `:block/uuid` and `:block/title` for handles, and the preference for named queries. Run `npm --prefix connector run update:manifest` in Stages 1 and 4 (a tool is added) and in any stage whose description change moves the manifest, and say in the commit body what changed in it.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page uuids, ident suffixes, hostnames or tokens. The defaults Business Meeting and forClient are tag and property titles the spec already records; nothing else from the owner's graph goes into a file.

### Working on patch 0039 (Stages 1 to 4)

Follow the `add-upstream-patch` skill. The branch's latest patch is 0038 (PR 47). Once, before Stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0038
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0038"
git -C .upstream tag -f baseline
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                    # the vendor matches 0038 before anything is added
```

At the end of each of Stages 1 to 4:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-datalog-query|semantic-private-tags|e2ee-semantic'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0039-semantic-datalog-query.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 39 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/`, the vendored files, `scripts/` and the connector carry the change. To see an upstream test fail before the stage's code, stash the handler change (`git -C .upstream stash push -- deps/db-sync/src`), run, and pop. To see a connector test fail first, write it before the connector entry and run `npm --prefix connector test -- <file>` against the freshly vendored tool (it fails as a tool with no annotations).

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost (Workers Free plan)*, *Security* and *Contract and docs*.
- `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md` (why a wall-clock timeout cannot fire), `docs/solutions/connector/per-item-summary-blows-result-cap.md` (why `byte-cap` sits under `RESULT_CHAR_LIMIT`), `docs/solutions/api/one-error-for-every-failure.md`, `docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`, `docs/solutions/api/read-hid-built-in-properties.md`, `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`, `docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`, `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`.
- Datascript (`.upstream/node_modules/datascript` or the vendored fork): `built_ins.cljc` `query-fns` (`:81`), `query.cljc` `resolve-sym` and the `Unknown function`/`Unknown predicate` throws (`:504-531`), `core.cljc` `filter` (`:246`).
- `worker/graph_insights.cljs`: `class-lineage-fn` (`:164`) and `excluded-page?` (`:180`); the private rule reuses the first.
- `worker/handler/semantic.cljs`: `dispatch-handle` (about `:5503`), `handle` and its `graph-e2ee` param (`:5529`, `:5539`), the insights reads' E2EE 409 (`:2526`, `:2778`), the tag and property resolvers the named queries reuse, and the `limit` parsing other reads use.
- `worker/routes/semantic.cljs`: a read route's parameters, request schema and responses to copy (the `listFavorites` route from 0038), and `dry-run-schema`.
- Tests: `semantic_favorites_test.cljs` and `semantic_promote_page_to_tag_test.cljs` (helpers), `semantic_private_tags_test.cljs` (private-tag fixtures), `e2ee_semantic_test.cljs` (an E2EE graph).
- Connector: `connector/src/tools/spec.mjs` (`ANNOTATIONS`, `annotationsFor`), `connector/src/tools/semantic.ts` (`registerGraphTools`, `:269`), `connector/src/audit/log.ts` (`recordRead`, `:436`; `READ_ROW_WRITES`), `connector/src/tools/activity-log.ts` (the two `recordRead` calls, `:276`, `:301`, and the listing's `kind = 'write'` filter), `connector/src/tools/common.ts` (`RESULT_CHAR_LIMIT`), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`), `scripts/usage-report.mjs` (the `kind = 'read'` sum), and the tests `tools.test.ts`, `activity-log.test.ts`, `audit-log.test.ts`, `service-tokens.test.ts`.
- The bench precedent: `scripts/bench-suggest-links.mjs` and its `.test.mjs` (seeded fixture, medians after a warm-up, skip with a reason when a build is missing).

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A write form hidden inside `or-join`, `not`, a rule body in `rules`, or nested in an `inputs` collection** (`[[:db/add 1 :block/title "x"]]`): refused, db unchanged (Stage 1).
2. **A function symbol written with a namespace (`datascript.core/transact!`, `clojure.string/join`) or as a string:** refused naming the clause (Stage 1).
3. **A rule call whose name is not defined in `rules`, and a rule that recurses on itself:** the first is a 400 naming the rule; the second runs under the scan cap and answers rows or 422, never a 500 (Stage 1 for the name, Stage 2 for the recursion).
4. **`:in [$ $2]`, `:in [$ %]` with no `rules`, and `rules` with no `%` in `:in`:** each refused naming the source or the rules (Stage 1).
5. **The vector form with `:with` and `:keys`:** normalised and run; the columns follow `:keys` (Stage 1).
6. **A tag titled `PRIVATE` or `private` (case), and a tag extending a tag extending Private:** both hide what they tag (Stage 1).
7. **A private block's child that is itself tagged with a public tag, and a property value entity whose owner is private:** hidden (Stage 1).
8. **A public block whose `:block/title` holds `[[uuid]]` of a private page:** the row returns with the uuid string and never the private title (spec §3.4, documented, not hidden) (Stage 1).
9. **`[:find ?t :where [?t :block/title "Private"]]`:** returns the tag itself, as the spec says (Stage 1).
10. **`limit` 0, 201, `"50"` and absent:** 0 and 201 refused naming the range; a string refused; absent gives 50 (Stage 1).
11. **A query of exactly 4,000 characters and one of 4,001; `inputs` of 20 and 21 entries:** the first of each pair runs, the second is refused naming the limit (Stage 1).
12. **Scalar (`?x .`), collection (`[?x ...]`) and aggregate (`(count ?b)`) finds:** each shaped as `{columns, rows}` and cut the same way (Stage 2).
13. **`(pull ?b [{:block/parent [{:block/parent [:block/title]}]}])` (depth 3), `[:block/parent ...]`, `{:block/_parent 3}`, and `(limit :block/refs 51)`:** each refused naming the attribute or depth; a many attribute with no `limit` returns at most 50 values (Stage 2).
14. **A single row larger than `byte-cap`:** answers zero rows with `truncated.by = "byte-cap"` and the note, not a cut row (Stage 2).
15. **A query that finishes at exactly `scan-cap` datoms, and one at `scan-cap` + 1:** the first answers rows, the second 422 (Stage 2).
16. **`params.days` 0, 3651, `"30"`; an unknown param name; `pages-missing-property` with no `tag` or no `property`:** each a 400 naming `params.<name>` (Stage 4).
17. **A tag param in another case than stored, and a title two tags share ignoring case:** resolved as the existing resolver does, the second a 409 with candidates or the resolver's own refusal (Stage 4).
18. **`run_named_query` with `name` `Projects-Untouched` or `projects_untouched`:** 404 listing the names (no case folding, the slug is exact) (Stage 4).
19. **Two audit rows from two quick calls with the same query text:** both carry the same `datalog:<hash>` (Stage 5).
20. **A `run_named_query` call refused by the server with 404:** one audit row, `status='error'`, `addressed` `named:<given name>` with no param values (Stage 5).

---

### Stage 1: Patch 0039, `datalog_query` read-only and private

**Goal:** `POST /query` parses the query, inputs and rules as EDN, refuses anything that could write or call an unlisted function, runs on a filtered db that hides private content, sorts the rows deterministically and cuts them to `limit`. E2EE answers 409 and `dry-run` answers the parsed EDN without running. The connector has `datalog_query` as a READ tool. Lands spec §3.2 (`datalogQuery`), §3.3, §3.4, §3.6 steps 2 and 3 (sort and `limit`), §3.7, §3.8, §4 (`datalog_query` inputs, the `limit` note and the 400 and 409 refusals), §8 items 1, 2, 4, 5 and 7, and acceptance 1, 3, 5 and 7.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/src/logseq/db_sync/worker/handler/datalog.cljs`; `deps/db-sync/test/logseq/db_sync/semantic_datalog_query_test.cljs`, required in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `:semantic/datalog-query` in `dispatch-handle`, calling into `datalog.cljs`; nothing else.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `datalogQuery` route; summary and description (read-only, allowed functions in brief, clauses must share variables, private content hidden, E2EE refused, `limit` 1 to 200, default 50, pull `:block/uuid` and `:block/title` for handles, prefer named queries once Stage 4 lands); request schema `{query: string ≤ 4000, inputs?: string, rules?: string, limit?: integer 1..200, dry-run?: boolean}` with no additional properties; response schema `DatalogQueryResponse` (`{columns, rows, total-rows, returned, truncated?, query, inputs}`) and the dry-run shape; 400 and 409 described.
- Create: `patches/0039-semantic-datalog-query.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`); `connector/src/tools/spec.mjs` (`datalog_query: READ`, with a comment naming patch 0039 and why a POST is a read); `connector/tools-manifest.json` (via `update:manifest`); `connector/test/tools.test.ts`, `connector/test/service-tokens.test.ts`.

**Interfaces produced:** `(parse-edn field s)`, `(validate-query q rules)`, `(private-ids db)`, `(query-filter db private ref-attrs counter)`, `(sort-rows rows)` and `(run-query db {:query :inputs :rules :limit})` returning `{:columns :rows :total-rows :returned :truncated}`. Stage 2 adds the caps inside `run-query`; Stage 4 calls `validate-query` and `run-query` with resolved params.

- [ ] **Step 1: Write the failing tests**, each through `handle-http` on a `create_graph` db:
  - `read-only-refusals` (spec §8 item 1): `[:find ?b :where [(transact! ?b)]]`, `[:db/add …]` in `inputs`, a `?f` bound through `inputs` and called, and `range`, `re-find`, `rand` and `clojure.string/join` each answer 400 naming the clause; review focus 1 and 2. After each, `max-tx` and the datom count are unchanged.
  - `allow-list-exists`: every symbol in `allowed-fns` is a key of Datascript's `query-fns`, and none of the spec's removed symbols is in it.
  - `source-and-rules` (review focus 3 name half, 4): the refusals named; a valid rule in `rules` with `%` runs.
  - `cross-product` (spec §3.5): two clause groups with no shared variable answer the 400; a rule call and an `or-join` that join them are accepted.
  - `forms` (review focus 5, 10, 11): the vector and map forms give the same rows; unknown map keys (`:rules` in the query, `:timeout`) refused naming the key; the length and count limits.
  - `private` (spec §8 item 2): fixtures are a page tagged Private; a page tagged a tag extending Private; a block tagged private on a public page, with a child; a property value on a private page; a public block that refs the private page. Queries by title, a `count` aggregate, `missing?`, `get-else`, a pull with `:block/_refs` and `(pull ?b [*])` never return them, and the count equals the public total; review focus 6 to 9.
  - `sort-and-limit`: rows come back in the same order on two runs; 60 matching pages with no `limit` give 50 rows, `total-rows` 60, `truncated.by = "limit"` and the note; a find over mixed value types (`:block/title` strings, `:block/order`, a nil from `get-else`) sorts without throwing (spec risk 5).
  - `e2ee` (spec §8 item 4, `datalog_query` half): with `graph-e2ee=true`, 409 with the message before parsing (a malformed query also answers 409).
  - `dry-run` (spec §8 item 5): answers `{dry-run: true, query, inputs, rules}` as EDN strings; the scan counter is 0 and the private set is never built (assert through a counter the handler exposes to tests, or by the absence of the private-set build in a probe atom; whichever the code makes possible without stubbing Datascript).
  - `parse-errors` (spec §8 item 7): malformed EDN names the field and position; a reader tag other than `#uuid` or `#inst` is refused; an `inputs`/`:in` mismatch names both counts.
  - `reached-through-handle`: the route is dispatched by `handle`, `logseq/read`, rate class read.
- Connector (vitest):
  - `tools.test.ts`: `datalog_query` is generated with `{graph, query, inputs?, rules?, limit?, dry-run?}` and READ annotations, takes no `reason`, and has no `DELETE_RULES`, `SNAPSHOT_PLAN` or `readable.ts` entry (a read never needs one).
  - `service-tokens.test.ts`: a `read` token is allowed `datalog_query`.
- [ ] **Step 2: Run on the 0038 baseline** and keep the failures (today: no route, 404; the connector has no such tool).
- [ ] **Step 3: Implement** as spec §3.3, §3.4, §3.6 steps 2 and 3, §3.7 and §3.8. Map Datascript's own `Unknown function`, `Unknown predicate` and `Insufficient bindings` errors to 400 naming the clause, in case one slips past the validator.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** drop each removed symbol from the deny list in turn (one test fails per symbol group); allow `?var` in function position; skip the write-form scan of `inputs`; skip it inside `not-join`; pass `@conn` instead of the filtered db; drop the ref-attribute `v` check (the `:block/_refs` pull leaks); drop the descendant walk; drop the `class-lineage-fn` expansion; compare the private title case-sensitively; skip the cross-product check; sort without the type rank; check E2EE after parsing. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): read-only datalog_query on a filtered db`. Body: the quoted baseline failures, the mutation results, the manifest gained `datalog_query`, and cost (2 Worker requests, about 1 D1 row read, 0 written until Stage 5; 0 neurons).

**Done when:** all 39 patches apply from scratch, the new namespace and the whole db-sync suite pass, `datalog_query` is in the vendored API and the manifest as READ, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0039, the scan cap, bounded pulls and the byte cap

**Goal:** a query never answers 500 or runs past its work budget. The filter counts datoms and the handler answers 422 at `scan-cap`; pulls in `:find` are rewritten to their variable, validated, and run only on the kept rows; the response stops adding rows before `byte-cap`; output is serialised as the spec says. Lands spec §3.5 (scan cap), §3.6 (all), §4 (the output shape, the `byte-cap` note and the 422), §8 item 3, and acceptance 2 and 6.

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: the scan counter inside `query-filter` throwing `(ex-info … {::scan-cap n})`, mapped to 422; `rewrite-pulls` and `validate-pull-pattern` (depth ≤ 2, no `...` or recursion number, many attributes take `(limit :attr n)` with n ≤ 50, defaulting to 50); pulls run after the cut, on the filtered db; `serialise` (keywords without the colon, uuids as strings, `{:db/id n}` as numbers); the byte-cap loop; scalar, collection and aggregate finds through the same cut.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the description gains the caps (scan cap, pull limits, about 100,000 characters) and the 422; response schema `truncated: {by: "limit" | "byte-cap", note}`.
- Modify: `patches/0039-…`, the vendored files, `connector/tools-manifest.json` (if the description change moves it).
- Modify: `connector/test/tools.test.ts` (the description names the scan cap and the 422).

- [ ] **Step 1: Write the failing tests** (spec §8 item 3):
  - `scan-cap`: a graph above the cap (generated through the real outliner in one batch) answers 422 naming the cap for an unconstrained `[:find ?b :where [?b :block/title]]`, never 500; review focus 15 with a test-only lower cap passed through the handler's options, not a redefined constant.
  - `scan-cap-is-per-request`: two calls under the cap in a row both answer rows.
  - `rule-recursion` (review focus 3, recursion half): a self-recursive rule answers rows or 422, never 500.
  - `pull-star-bounded` (acceptance 6): `(pull ?b [*])` across the graph returns 50 rows, `truncated.by = "limit"` and `total-rows`; the number of pulls equals the rows returned.
  - `pull-pattern-refusals` (review focus 13).
  - `byte-cap`: long titles give `truncated.by = "byte-cap"` with the JSON under 100,000 characters and whole rows only; review focus 14.
  - `find-shapes` (review focus 12).
  - `serialisation`: a keyword attribute comes back as `"block/title"`, a uuid as a string, a ref as a number.
- Connector: `tools.test.ts` asserts the `datalog_query` description names the scan cap and `truncated`.
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.5 and §3.6.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** count only matching datoms instead of every datom asked about; reset the counter per clause; let the cap exception escape as 500; pull before the cut; skip the depth check; allow `...`; skip the default many-attribute limit; let a row be cut mid-way by the byte cap; set `byte-cap` to `RESULT_CHAR_LIMIT`. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): bound datalog_query by a scan cap, pull limits and a byte cap`. Body: the quoted failures, the mutation results, whether the manifest changed, and cost (as Stage 1; at most 200 pulls of depth 2, at most 50 values per many attribute).

**Done when:** no test can make the route answer 500, every cap is named in its note or refusal, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 3: The bench and the scan cap's number

**Goal:** the scan cap is set from measurement, not guessed. `scripts/bench-datalog-query.mjs` runs the built handler under Node against a generated N-page graph and times the private-set build, the scan cap reached by an unconstrained query, and the worst shapes of spec risk 1 (a wide `or-join`, a recursive rule over a small set, a `not-join` fan-out, `(pull ?b [*])` at `limit` 200), cold and warm, at 5,000 and 20,000 pages. `scan-cap` is set so the warm worst case stays near the tail the README records (up to 92 ms tolerated); if a shape the cap does not count is over budget, the validator gains a rule-depth or `or`-branch limit rather than a higher cap (spec risk 1). Lands spec §3.5 (the number), §5 (CPU), §7 risks 1, 3 and 8, and §8 *Scripts*.

**Files:**
- Create: `scripts/bench-datalog-query.mjs` (after `bench-suggest-links.mjs`: a seeded fixture, medians over `--runs` after one warm-up, `--pages`, `--json`; it loads the built `deps/db-sync` output from `.upstream` and calls `run-query` and `private-ids` directly, so the numbers exclude HTTP), and `scripts/bench-datalog-query.test.mjs`.
- Modify (in `.upstream`, if the numbers require it): `worker/handler/datalog.cljs` (`scan-cap`; a new limit if a shape is over budget, with its 400 message naming the limit) and the matching test in `semantic_datalog_query_test.cljs`.
- Modify: `patches/0039-…` and the vendored files if the description's number changed.

- [ ] **Step 1: Write the failing tests:** `bench-datalog-query.test.mjs` checks the output shape only: the seeded fixture is the same for the same size; `--json` gives one record per shape and size with `cold_ms`, `warm_ms`, `datoms_scanned` and `outcome` (`rows` or `scan-cap`); it skips with a reason naming the missing build when `.upstream`'s db-sync output is absent (as `bench-suggest-links.test.mjs` does). If a new limit is added, its upstream test (the shape refused with 400 naming the limit) is written first too.
- [ ] **Step 2: Run** and keep the failures (no script).
- [ ] **Step 3: Implement the bench, run it, and set the cap.** Record the table (shape × pages × cold/warm) and the reasoning for the chosen `scan-cap`. State any shape still over budget and what limit was added for it. Note whether the storage-backed Datascript loaded lazily during the scan (spec risk 3), as observed.
- [ ] **Step 4: Run the patch workflow above** (the patch changes if the cap or a limit changed; if neither did, say so and run `scripts/check.sh --upstream` anyway). **Mutation check:** in the test, drop a shape from the output; break the seed. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `perf(api): bench datalog_query and set the scan cap`. Body: the bench table, the chosen cap and why, any added limit with its quoted failing test, and that Node on a developer machine is a guide to, not a measure of, the Durable Object on Cloudflare (spec §5's unverified CPU limit stays unverified until the live check).

**Done when:** the bench runs at both sizes, the cap in the patch matches the commit body, the scripts' unit tests pass (or skip with a reason), and `scripts/check.sh --upstream` is green.

---

### Stage 4: Patch 0039, named queries and `run_named_query`

**Goal:** four vetted queries run in one call each, with params resolved by the semantic API's existing resolvers and every guard from Stages 1 to 3 applied. The connector has `run_named_query` as a READ tool. Lands spec §3.2 (`runNamedQuery`), §3.9, §4 (`run_named_query`), §7 risk 6, §8 item 6, and acceptance 4 (the server half) and 9.

**Files:**
- Create (in `.upstream`): `worker/named_queries.cljs`: the four entries as `{:title :query :rules :params}` maps in the advanced-query shape, each param `{:name :type :default :bounds}`.
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: `resolve-params` (tag by title, case-insensitive, expanded to itself plus every class extending it; property by ident or title; days 1 to 3650 to a cutoff in ms; int with bounds), then `validate-query` and `run-query`; the response adds `name` and the resolved `params` as titles and idents; dry run shows the exact Datalog and inputs. `worker/handler/semantic.cljs`: `:semantic/named-query` in `dispatch-handle`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `runNamedQuery` route with `:name` as a path parameter (`[a-z-]+`), description listing the four queries, their params and defaults, and that defaults can be overridden; request schema `{params?: object, limit?, dry-run?}`; 400, 404 and 409 described. The `datalogQuery` description now says to prefer `run_named_query`.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`.
- Modify: `patches/0039-…`, the vendored files, `connector/src/tools/spec.mjs` (`run_named_query: READ`), `connector/tools-manifest.json`, `connector/test/tools.test.ts`, `connector/test/service-tokens.test.ts`.

**Interfaces produced:** `named-queries` (the map by name) and the response's `{:query :inputs}` EDN pair, which the backlog-21 lane will write into a Query block.

- [ ] **Step 1: Write the failing tests** (spec §8 item 6), through `handle-http` and the router (so the `:name` path parameter is decoded as in production):
  - `projects-untouched`: with `days=30`, a stale project page is returned and a project whose child block was edited within the window is not; a page tagged a tag extending Project is included.
  - `meetings-without-decision`: a meeting page with no decision, a meeting block whose grandchild is tagged Decision (excluded, through the recursive `child` rule), a meeting with a Decision block elsewhere on its page (excluded), and a meeting older than `days` (excluded).
  - `open-tasks-by-client`: tasks with status Todo, Doing, Done and Canceled; client on the task itself, on its page only, and on neither; rows sorted by client title, Done and Canceled absent.
  - `pages-missing-property`: pages tagged `tag` with and without `property`.
  - `private-in-named`: a private project page is never returned by `projects-untouched`.
  - `params-refusals` (review focus 16, 17): each named; a default that no longer resolves (fixture without a Business Meeting tag) answers 400 naming `params.meeting_tag`, never empty rows.
  - `unknown-name` (review focus 18): 404 listing the four names.
  - `every-entry-validates`: `validate-query` passes every entry with its defaults' shapes.
  - `named-dry-run`: shows the Datalog and resolved inputs; runs nothing.
  - `named-e2ee`: 409 (spec §8 item 4, `run_named_query` half).
- Connector: `tools.test.ts`: `run_named_query` is generated with `{graph, name, params?, limit?, dry-run?}`, READ, no `reason`; `service-tokens.test.ts`: a `read` token is allowed it.
- [ ] **Step 2: Run on the Stage 3 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.9.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** skip the class expansion of a tag param; compare tag titles case-sensitively; accept `days` 0; let an unresolved default return empty rows; drop the `not-join` from `projects-untouched` (a fresh child edit no longer saves it); drop the recursive `child` rule (a grandchild decision is missed); include Done tasks; run a named query on the unfiltered db. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): named queries, run_named_query`. Body: the quoted failures, the mutation results, the manifest gained `run_named_query`, and cost (as `datalog_query`).

**Done when:** each named query runs in one call on fixtures with known answers, every entry passes the validator, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 5: The connector records each query as a read

**Goal:** each `datalog_query` and `run_named_query` call writes one `kind='read'` audit row naming the tool, the status and a hash or the query's name, never the query text or param values. `get_activity_log`'s own read rows are unchanged. Lands spec §3.10, §4 (*Changed (internal)*), §5 (the D1 writes), §8 *Connector*, and acceptance 8.

**Files:**
- Modify: `connector/src/audit/log.ts`: `recordRead(tool, status, graphId, alias, addressed, rowsRead)`, binding `tool` and `status` instead of the literals; the file's header comment on read rows.
- Modify: `connector/src/tools/activity-log.ts`: both calls pass `'get_activity_log', 'ok'`; the comment at `:12` ("listings never show") stays true and is not changed.
- Modify: `connector/src/tools/semantic.ts`: `LOGGED_READS` (`datalog_query`, `run_named_query`); in `registerGraphTools`'s read branch, after the handler returns or throws, record one row with status `ok` or `error`, `addressed` `named:<name>` plus the param names, or `datalog:<first 12 hex of the SHA-256 of the query text>` (Web Crypto `crypto.subtle.digest`), and `rowsRead` 0; a failed insert is logged to Workers Logs and the result (or error) is still returned unchanged.
- Modify: `connector/test/semantic.test.ts` or `connector/test/audit-log.test.ts` (whichever holds `registerGraphTools` tests), `connector/test/activity-log.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - one `datalog_query` call inserts exactly one row with `kind='read'`, `tool='datalog_query'`, `status='ok'` and `addressed` `["datalog:<12 hex>"]`; the stored row contains no part of the query text; the D1 meta shows `READ_ROW_WRITES` (2) rows written and 0 read; review focus 19;
  - one `run_named_query` call records `named:projects-untouched` and the param names, never their values;
  - a server error records `status='error'` (review focus 20), and the tool's error result is unchanged;
  - an audit insert failure (the D1 binding made to throw for the insert) still returns the result;
  - a read tool outside `LOGGED_READS` (`get_page`) records no row;
  - every name in `LOGGED_READS` is a READ tool in `ANNOTATIONS` (a drift guard);
  - `get_activity_log`'s two read rows are unchanged by the signature change (the existing `recordRead's INSERT writes READ_ROW_WRITES rows, measured` test is updated to the new call and still passes);
  - `get_activity_log` listings still show only `kind='write'` rows, so a query's row does not appear in the listing (see *Owner questions* below).
- [ ] **Step 2: Run on the Stage 4 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.10.
- [ ] **Step 4: Run** `npm --prefix connector test`, `npm --prefix connector run typecheck` and `scripts/check.sh`. **Mutation check:** log the query text in `addressed`; record `ok` on error; drop the record on error; let an insert failure throw; record every read; keep the literal `'get_activity_log'` in the INSERT. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): record each datalog query as a read in the audit log`. Body: the quoted failures, the mutation results, cost (2 D1 rows written per query; at 1,000 queries a day, 2% of the 100k daily writes; 0 rows read by the insert), and that `scripts/usage-report.mjs`'s "D1 rows read by get_activity_log" line stays true because these rows carry `rows_read` 0.

**Done when:** every query call leaves exactly one read row, `get_activity_log` is unchanged, and `scripts/check.sh` is green.

---

### Stage 6: The connector contract

**Goal:** Claude's help text describes queries as Stages 1 to 5 built them. Lands spec §3.11 (`connector_help`), §4 (the Queries paragraph) and acceptance 4 (help half) and 10 (help half).

**Files:**
- Modify: `connector/src/tools/handwritten.ts`: `CONNECTOR_HELP` gains the Queries paragraph of spec §4, with the scan cap's number from Stage 3 and any limit Stage 3 added; "Each query is logged" phrased as what Stage 5 does (recorded as a read; see *Owner questions*).
- Modify: `connector/test/tools.test.ts` (help assertions); `connector/tools-manifest.json` only if `check:manifest` says so (it should not: help text is not in the manifest).

- [ ] **Step 1: Write the failing tests:** `CONNECTOR_HELP` names `datalog_query` and `run_named_query`; lists the four named queries; says to prefer a named query; states `limit` (default 50, maximum 200), the byte cap and `truncated`; the scan cap's number and the 422; pulling `:block/uuid` and `:block/title`; pure functions only, with no regex, `range` or `rand`; clauses must share variables; private content is left out; unavailable on E2EE graphs; `dry-run: true`. One assertion each, so dropping one fails. The two tools' generated descriptions carry the openapi text (caps, private, E2EE).
- [ ] **Step 2: Run and keep the failures** (the description assertions pass already from Stages 1 to 4's vendor; record which, since only the help assertions can fail first).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate:** `npm --prefix connector run check:manifest` (say whether it changed) and `scripts/check.sh`. **Mutation check:** drop each help phrase; change the scan cap's number in the help. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): describe datalog queries to Claude`. Body: the failures seen, which description tests passed before the change and why, the manifest result, and cost (none: text only).

**Done when:** the help and the tool descriptions match the server's behaviour and the bench's cap, the manifest check passes, and `scripts/check.sh` is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §1 gains patch 0039 in the list of patches; README §11.8 gains a queries entry (the two tools, the caps and their numbers, the private rule, E2EE refused, dry run, the audit row) and a cost line (2 Worker requests, about 1 D1 row read, 2 written per call); the tool list gains both tools; troubleshooting gets rows for the 422 (narrow the query or use a named query) and the 409 (E2EE). Write `docs/solutions` entries for what the build taught, at least the bench's numbers and the filter-below-the-engine approach to private content (for example `docs/solutions/api/datalog-guards-count-work-not-time.md`). Consider a REVIEW.md *Security* line if the review finds a recurring class (for example, a read path that bypasses the private filter).
- **PR body:** each stage's first failures, the mutation results, the bench table and the chosen cap, the commit `scripts/check.sh --upstream` ran on and what it skipped, that `tools-manifest.json` gained two tools, the cost table from spec §5, and the Logseq skill note from spec §4, corrected for what Stage 5 does: Claude can now query the graph with Datalog; for weekly reviews use `run_named_query` (`projects-untouched`, `meetings-without-decision`, `open-tasks-by-client`, `pages-missing-property`) before writing fresh Datalog; meetings are tagged Business Meeting and clients are set with `forClient`, and other tags or properties can be passed as params; private content never appears in results; each query is recorded in the audit log as a read.
- **Live check** (spec §9, after merge): on the test graph (alias `test`), the six steps of spec §9, with step 5 read as "the audit log holds a read row per call" (see below); record outcomes and the observed CPU tail, not page names.
- **Owner questions.** Spec §11 stays open; none blocks a stage, but answers change these places: question 1 (scope) is a new tracker item; question 2 (log reads) removes Stage 5 if the answer is no; question 3 changes the defaults in Stage 4; question 4 adds titles to `private-ids` in Stage 1; question 5 would lift the 409 for structure-only queries in a later item; question 6 is settled by Stage 3's numbers; question 7 is the owner's call. **One gap the plan found in the spec:** `get_activity_log`'s listing filters `kind = 'write'` (`connector/src/audit/log.ts:332`, and `activity-log.ts:12` says read rows are never shown), so spec §9 step 5 and the skill note's "each query is logged in `get_activity_log`" would not hold as written. This plan records the rows (usage report and audit table) without changing the listing, and Stage 5 pins that. If the owner wants queries listed in `get_activity_log`, that is a change to the listing's filter and scan cap (`QUERY_SCAN_CAP`), with its own D1 read count, and goes in a follow-up stage or item; raise it with question 2.
