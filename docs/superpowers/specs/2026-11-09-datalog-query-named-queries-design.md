# Read-only Datalog query and named queries: design

Date: 2026-11-09
Issue: item 40 on the tracker ("Read-only Datalog query tool and named query library"), status Backlog. Areas: patch, connector, semantic, docs, scripts.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0038. This work adds patch 0039.
Branch: `claude/relaxed-maxwell-s4r8o4-queries`, from `6d9da57` (patch 0038, favourites, PR 47), 0 commits behind `origin/main`.
Builds on: `2026-11-07-connector-write-audit-log-design.md` ("the audit design", item 28), `2026-11-09-page-favourites-connector-tools-design.md` (the shape of a semantic-API patch with generated tools), `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md` and `docs/solutions/connector/per-item-summary-blows-result-cap.md`.

Decisions marked **(brief)** come from the owner's brief or the tracker item. Decisions marked **(call)** were made while writing this design. The design panel chose the "minimal" proposal: two read routes in patch 0039, run against a filtered Datascript db, with generated connector tools and no hand-written tool code. No ideas were grafted from other proposals. The decisions most worth a second look are in section 11.

**What was run for this spec.** This spec states no bug cause, so there was nothing to reproduce. Source was read in `.upstream` and the vendored Datascript on 2026-11-09, and the owner's tags and properties were listed read-only through the connector (`list_tags`, `list_properties`) to check the named queries' defaults. Facts checked that way:

- Datascript is Logseq's fork at `3f141af`. Its `built_ins/query-fns` (`built_ins.cljc:81`) includes `rand`, `rand-int`, `range`, `re-find`, `re-matches`, `re-seq`, `re-pattern`, `clojure.string/join`, `replace` and `split`.
- In ClojureScript `resolve-sym` returns `nil` (`query.cljc:504-507`). A function or predicate symbol therefore resolves only from `query-fns` or from a variable bound in the query's inputs; anything else raises `Unknown function '…` or `Unknown predicate '…` (`query.cljc:515, 531`). So `transact!` cannot be called by name today. The allow-list in 3.3 is still needed, to shut out the CPU-heavy built-ins and input-bound functions, and to name the refusal clearly.
- `d/filter` (`core.cljc:246`) proxies every operation to the original db and applies the predicate on each access, uncached.
- `handler/semantic.cljs` is 5,552 lines. `dispatch-handle` is at :5503. The insights reads refuse E2EE with 409 (`semantic.cljs:2526, 2778` and the comment at :4803).
- `graph-insights/class-lineage-fn` (`graph_insights.cljs:164`) maps a class to itself plus every class it **extends** (upwards), memoised per request. `excluded-page?` (:180) uses it to test "tagged with, or with a tag extending, a class titled X". The private rule in 3.4 uses the same test.
- `AuditLog.recordRead` (`connector/src/audit/log.ts:436`) hard-codes both `tool = 'get_activity_log'` and `status = 'ok'`. Migration 0004 allows `kind IN ('write','read')`, and `tool` is free text.
- `RESULT_CHAR_LIMIT` is 150,000 characters (`connector/src/tools/common.ts`). `registerGraphTools` (`connector/src/tools/semantic.ts:269`) sends a read straight to the handler with no audit row.

Behaviour that no test has shown yet is marked **unverified**, and section 8 names the test that settles it.

## 1. Goal

Claude should be able to run Datalog against a graph from a claude.ai chat, with no desktop app, tunnel or CLI. The queries the owner wants (projects untouched for N days, meetings with no recorded decision, open tasks by client, pages missing a required property) take many tool calls today. Patch 0039 adds a guarded `datalog_query` and a small library of vetted named queries, `run_named_query`, to the semantic API. The connector exposes both as generated read tools.

Acceptance (tracker item 40 and the brief):

1. A Datalog query runs from a claude.ai chat with no desktop app or tunnel.
2. An over-cap query never answers 500 or fails on a CPU limit. A result over the row or byte cap is truncated with a note naming the cap. A query that hits the scan cap is refused with 422 and a note naming the cap, since Datascript cannot yield partial rows once it stops (section 3.5).
3. Pages tagged private never appear in results, and neither do blocks tagged private, blocks on a private page or blocks under a private block (the brief extends the tracker's "pages").
4. Each named query runs in one call. `connector_help` and the logseq-kb skill note list them.
5. The tool is read-only by construction. A write form, a function that is not on the allow-list and a function bound through inputs are refused, and a test proves the db is unchanged after each.
6. Pull patterns are bounded. `(pull ?b [*])` across the graph returns at most `limit` rows, with a note naming the cap.
7. E2EE behaviour is defined and tested.
8. Each call is accounted for: a decision on whether reads are logged, and the D1 rows read and written per call.
9. The query representation is reusable by the follow-up that turns query fences into Query blocks (README backlog 21).
10. `tools-manifest.json`, `connector_help`, the tool descriptions and README §11.8 are updated, and the PR body carries a Logseq skill note.

Tracker criterion 5 ("the weekly review uses the change feed and the extended health checks") is **out of scope** by the brief. Section 10 moves it to a follow-up item, and section 11 asks the owner to confirm.

## 2. Context

**What Claude can do today.** The semantic API answers fixed questions: `list_tag_objects`, `list_tasks`, `get_page_backlinks`, `kb_index`, `get_graph_health` and `semantic_search`. A question that joins tags, properties, time and structure ("tasks not done whose page's client is X") takes several calls and client-side joins, and Claude often gets the join wrong. The Logseq CLI answers such questions with Datalog, but only on the desktop. Upstream logseq PR 13622 (`datascriptQuery`) is the precedent for exposing Datalog over an API; this design keeps the idea and adds the guards a public, Free-plan Worker needs.

**The db.** The semantic handlers read the graph's Datascript db (`@conn`) in the graph's Durable Object. Datascript's query engine runs synchronously and has no timeout or work limit. `d/filter` gives a view in which every datom is checked against a predicate before any index, query or pull sees it.

**Why a wall-clock timeout cannot work.** The Worker clock (`Date.now`, `performance.now`) does not advance during synchronous CPU work, so a deadline checked inside the query would never fire (`docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`). The limit has to count work instead.

**Private content.** The semantic indexer keeps out any block tagged `private` (any case) and everything under it, and anything on a private page (`connector/src/semantic/document.ts:38`, `PRIVATE_TAG`). `kb_index` excludes pages tagged with, or with a tag extending, a class whose title is in its excluded set. The owner's graph has a user tag titled Private.

**E2EE.** On an E2EE graph titles are stored as `[iv ciphertext]` packages (README, near line 391). Structure, tags, property values and refs are plain. Every read that depends on titles or text already refuses E2EE with 409.

**The owner's schema (checked read-only for the defaults).** Project and Decision exist as tags. There is no tag titled Meeting; the meeting tag is titled Business Meeting. Tasks use the built-in Task tag and `:logseq.property/status`. The client of a piece of work is a node property titled `forClient`, limited to the Client tag; there is no property titled `client`. No graph name, ident suffix or uuid from the owner's graph appears in this spec or in any file the work adds.

**Connector plumbing.** Generated tools need an `ANNOTATIONS` entry in `spec.mjs`. A POST without one would be treated as a write and need `reason`. Reads skip `audited()` and leave no audit row today; only `get_activity_log` records its own reads.

## 3. Design

### 3.1 Layout

| Layer | File | Change |
|---|---|---|
| Routes | patch 0039: `worker/routes/semantic.cljs` | two POST routes, `logseq/read`, rate class read, openapi summaries and schemas |
| Handler | patch 0039: new `worker/handler/datalog.cljs` | parse, validate, private filter, scan cap, pull rewrite, sort, truncate, serialise |
| Named queries | patch 0039: new `worker/named_queries.cljs` | four queries as data |
| Wiring | patch 0039: `worker/handler/semantic.cljs` | `dispatch-handle` entries only, so the 5,552-line file barely grows |
| Tests | patch 0039: new test namespace and runner entry | real outliner on a `create_graph` db |
| Vendor | `connector/vendor/openapi.json`, `semantic_api_tools.mjs` | regenerated |
| Annotations | `connector/src/tools/spec.mjs` | `datalog_query: READ`, `run_named_query: READ` |
| Audit | `connector/src/audit/log.ts`, `connector/src/tools/semantic.ts` | `recordRead(tool, status, …)`; `LOGGED_READS` in `registerGraphTools` |
| Contract | `connector_help` (`handwritten.ts`), `tools-manifest.json`, README §11.8 | Queries paragraph, regenerated manifest, entry, cost line, troubleshooting rows |
| Bench | `scripts/bench-datalog-query.mjs` and `.test.mjs` | times the scan cap cold and warm |

### 3.2 Routes (brief)

Both are POST because the query text can be long, and both are reads:

- `POST /api/v1/graphs/:graph-id/query`, operationId `datalogQuery`, tool `datalog_query`.
- `POST /api/v1/graphs/:graph-id/named-queries/:name`, operationId `runNamedQuery`, tool `run_named_query`.

The `:name` path parameter is a plain slug (`[a-z-]+`), so the qualified-ident re-encoding trap does not apply, but the route test still calls it through the router.

### 3.3 Read-only by construction (call)

Three layers.

1. **Only a db value reaches the query.** The handler runs `d/q` and `d/pull` on `(d/filter @conn pred)` and never passes `conn`. Nothing a query can name reaches a transact.
2. **Parse without evaluating, then validate.** The query, inputs and rules are read with `cljs.reader/read-string` (the EDN reader, which does not evaluate code; tagged literals are limited to `#uuid` and `#inst`). Before anything runs, a static validator walks the parsed form:
   - Map form keys are limited to `:find :in :where :keys :strs :syms :with`; the vector form is converted to the map form first. `:rules` comes only from the `rules` field.
   - `:in` starts with `$` (or is omitted); any other `$`-prefixed source is refused. `%` is allowed only when `rules` is given.
   - In every function or predicate clause, including those inside `or`, `or-join`, `not`, `not-join` and rule bodies, the function is a symbol on an explicit allow-list. A `?var` in function position is refused, which shuts out functions bound through inputs.
   - The allow-list is `query-fns` minus `rand`, `rand-int`, `range`, `re-pattern`, `re-find`, `re-matches`, `re-seq` (CPU with no datom cost, and ReDoS), minus the `clojure.string` functions that build large strings (`join`, `replace`, `replace-first`, `split`, `split-lines`, `escape`, `reverse`), minus `meta`, `pr-str`, `print-str`, `println-str` and `prn-str`. It keeps `includes?`, `starts-with?`, `ends-with?`, `lower-case`, `upper-case`, `blank?`, the comparisons, arithmetic, `get-else`, `get-some`, `missing?`, `ground`, `tuple`, `untuple`, `count` and the type predicates.
   - Transaction-shaped values anywhere in the query, inputs or rules (`:db/add`, `:db/retract`, `:db.fn/*`, `:db/retractEntity`, a map with `:db/id`) are refused.
   - A `pull` whose pattern is not a literal vector is refused.
3. **A test proves it.** After each refused query, `max-tx` and the datom count are the same as before.

Each refusal names where and why, for example `where 2: function transact! is not allowed (allowed: =, <, …)`, `where 3: ?f is a variable in function position; functions can't be passed as inputs` or `query: :db/add is a write form; datalog_query is read-only` (`docs/solutions/api/one-error-for-every-failure.md`).

**Allow-list drift.** A test asserts that every allowed symbol is a key of `query-fns`, so a Datascript bump that renames one fails the `bump-upstream` workflow. Because the list is deny-by-default, a new built-in stays refused until it is added on purpose.

### 3.4 Private exclusion with one filter (call)

Per request, the handler builds a set of private entity ids:

- **private classes:** classes whose title is `private` in any case;
- **private entities:** every page or block whose tags, through `class-lineage-fn`, include a private class (the `excluded-page?` test, applied to blocks too);
- every block whose `:block/page` is a private page;
- every descendant (through `:block/_parent`) of a private block;
- every property value entity owned by one of the above (it has `:block/parent` or `:block/page` pointing into the set, so the two rules above catch it; a test pins this).

It also builds the set of ref attributes from the schema. The `d/filter` predicate drops a datom when its `e` is private, or when its attribute is a ref and its `v` is private. A private page's title, its blocks and the fact that something links to it never appear in results, in pulls (including reverse refs such as `:block/_refs`), in `missing?` or `get-else`, or in aggregates such as `count`. This matches the semantic indexer's rule ("tagged private, or under a private block or page") and extends `kb_index`'s page rule to blocks.

What it does not hide: a public block's raw `:block/title` that contains a `[[uuid]]` ref to a private page still shows the uuid string, but not the title. This is the same as `get_block` today. The private classes themselves stay visible, so `[:find ?t :where [?t :block/title "Private"]]` returns the tag, but not what it tags.

Building the set costs O(private pages + their blocks + private subtrees) per request. If the bench shows it matters on a large graph, the set can be cached per tx id in the Durable Object; this design does not cache it.

### 3.5 A scan cap in place of a timeout (call)

The filter predicate also counts every datom it is asked about. Past `scan-cap` it throws `(ex-info … {::scan-cap n})`. The handler answers that with 422:

```
query stopped after scanning 50,000 datoms (the scan cap); narrow it with a tag, page or attribute value, or use a named query
```

It is never a 500. The cap is a constant set from the bench (section 7, risk 1); 50,000 is the starting point. The counter is per request, not per process.

**Cross products.** A cross product grows without scanning more datoms, so a static check refuses it. Where-clause variables are grouped with union-find, treating rule-call arguments and `or-join`/`not-join` variable lists as joins. More than one group answers 400: `where: clauses 1 and 3 share no variable (a cross product); join them through a shared variable`.

The 422 is a refusal, not a partial result. Acceptance 2's "truncated result with a clear note" holds for the row and byte caps (3.6); for the scan cap the note is in the 422.

### 3.6 Bounded pulls and results (call)

Before running, each `(pull ?x pattern)` in `:find` is rewritten to the bare `?x`. Then the handler:

1. runs the query on the filtered db;
2. sorts the tuples deterministically: entity ids, then values, with a type rank (nil, boolean, number, string, keyword, uuid, other) so mixed types never make `compare` throw;
3. cuts them to `limit` (default 50, maximum 200, the same as the other semantic reads);
4. pulls only the kept rows, on the filtered db.

So `(pull ?b [*])` across the graph costs at most 200 pulls. The pull pattern is validated first: nesting depth at most 2; no recursion (`...` or a recursion number); a many-cardinality attribute takes `(limit :attr n)` with n at most 50, and gets limit 50 when none is given. A larger limit is refused naming the attribute.

Rows are then added to the response until its JSON would pass `byte-cap`, 100,000 characters. That is below the connector's `RESULT_CHAR_LIMIT` of 150,000, so the connector never cuts the JSON mid-row (`docs/solutions/connector/per-item-summary-blows-result-cap.md`).

Scalar finds (`?x .`), collection finds (`[?x ...]`) and aggregate finds pass through the same cut. Output turns keywords into strings without the colon (`"block/title"`), uuids into strings and `{:db/id n}` into numbers. The tool text says to pull `:block/uuid` and `:block/title` to get handles for the other tools.

### 3.7 E2EE (call)

Both routes answer 409 `datalog_query is unavailable on an E2EE graph (titles are ciphertext)` before parsing, as the insights reads do. Structure-only queries could work there, but every useful one filters or returns titles, and a query over ciphertext that silently matches nothing would be a silent wrong answer. Section 11 asks the owner whether structure-only queries on E2EE graphs are wanted.

### 3.8 Dry run (call)

`dry-run: true` parses, validates and resolves parameters, and answers `{dry-run: true, query, inputs, rules}` as EDN strings without building the private set or running the query. For a named query it shows the exact Datalog it would run.

### 3.9 Named queries (brief, with defaults checked)

The queries are data in `worker/named_queries.cljs`. Each is a map in the shape of Logseq's advanced query, `{:title :query :rules :params}`. Each param has a name, a type (`:tag`, `:property`, `:days`, `:int`), a default and bounds. The handler resolves params with the semantic API's existing resolvers:

- a tag resolves by title, case-insensitive, then expands to itself plus every class extending it;
- a property resolves by ident or title;
- days must be 1 to 3650 and become a cutoff in milliseconds.

The resolved values become positional `:in` values (a cutoff, a collection of class ids, a property ident). The same validator, filter, scan cap and limits then apply, so a named query cannot get round any guard. A test runs the validator over every entry. Errors name the param: `params.tag: no tag titled Projet`, `params.days: must be 1-3650`. A default that does not resolve answers 400 naming the param, never empty rows.

| Name | Params (default) | Finds |
|---|---|---|
| `projects-untouched` | `tag` (Project), `days` (30) | Pages tagged `tag` whose own `:block/updated-at` is before the cutoff and with no block on the page updated since (`not-join`). |
| `meetings-without-decision` | `meeting_tag` (Business Meeting), `decision_tag` (Decision), `days` (90) | Pages or blocks tagged `meeting_tag`, created within `days`, with no block on the page, or below the meeting block through a recursive `child` rule, tagged `decision_tag`. |
| `open-tasks-by-client` | `client_property` (forClient) | Blocks tagged Task whose status is not Done or Canceled, with the client from the task's own property or, failing that, its page's. Rows are sorted by client title. |
| `pages-missing-property` | `tag` (required), `property` (required) | Pages tagged `tag` where `[(missing? $ ?p ?prop)]`. |

The defaults Business Meeting and forClient differ from the tracker's examples (Meeting, client) because the owner's graph has no tag or property with those titles. `meetings-without-decision` gains a `days` window (call) so it does not walk every meeting ever held; section 11 asks about it. The tool text says the defaults can be overridden.

**Reusable representation (brief).** Every response carries `query` and `inputs` as EDN strings. That `{:query … :inputs …}` pair is what the backlog-21 lane writes into a Query block's value. Named query entries use the advanced-query map shape for the same reason.

### 3.10 Audit (call: reads are logged)

Reads of the whole graph are worth a record: a query can read anything that is not private, and the owner already reviews `get_activity_log`. So both tools write one audit row per call.

- `AuditLog.recordRead(graphId, alias, addressed, rowsRead)` becomes `recordRead(tool, status, graphId, alias, addressed, rowsRead)`. `get_activity_log`'s two calls pass `'get_activity_log', 'ok'`, so its rows are unchanged.
- `registerGraphTools` gets a `LOGGED_READS` set (`datalog_query`, `run_named_query`). After a call in the set it records one `kind='read'` row, status `ok` or `error`.
- `addressed` holds `named:<name>` plus the param names, or `datalog:<first 12 hex of the SHA-256 of the query text>`. Never the query text or param values, keeping migration 0004's rule against raw arguments.
- `rows_read` is 0, since the query reads the Durable Object, not D1.
- A failed audit insert is logged to Workers Logs and the result is still returned, as `get_activity_log` does.

No migration is needed: the `kind` CHECK already allows `'read'`, and `tool` and `status` are free text.

### 3.11 Contract (brief)

- `spec.mjs` ANNOTATIONS: both tools READ. Without this, POST would mark them as writes and require `reason`.
- The tool descriptions come from the patch's operation summaries. They state the caps, the private rule, E2EE, that pulls should ask for `:block/uuid` and `:block/title`, and that named queries are preferred.
- `connector_help` gets a Queries paragraph (section 4).
- `npm --prefix connector run update:manifest` regenerates `tools-manifest.json`.
- README §11.8 gets a query entry and a cost line; troubleshooting gets rows for the 422 and the 409.
- The PR body carries the Logseq skill note (section 4).

## 4. Tool contract

**`datalog_query`** (READ; `POST /api/v1/graphs/{graph-id}/query`). Inputs:

| Field | Type | Rule |
|---|---|---|
| `graph` | alias | required |
| `query` | EDN string | the vector or map form, at most 4,000 characters |
| `inputs` | EDN vector string | optional; values bound to `:in` after `$`, at most 20 entries; `#uuid` and keywords allowed |
| `rules` | EDN vector string | optional; bound to `%` |
| `limit` | integer | 1 to 200, default 50 |
| `dry-run` | boolean | optional |

Output: `{columns, rows, total-rows, returned, truncated?: {by: "limit" | "byte-cap", note}, query, inputs}`. The note reads, for example, `returned 50 of 1,234 rows (limit 50, maximum 200); narrow the query or add a :where clause`. A dry run answers `{dry-run: true, query, inputs, rules}`.

Refusals:

- 400 naming the clause and reason: a function not on the allow-list, a variable in function position, a write form, a cross product, a bad pull pattern (depth, recursion, many-attribute limit), a non-default source, a parse error with its position, or an `inputs`/`:in` count mismatch;
- 422 when the scan cap is hit, naming the cap;
- 409 on an E2EE graph.

**`run_named_query`** (READ; `POST /api/v1/graphs/{graph-id}/named-queries/{name}`). Inputs: `graph`; `name`, one of `projects-untouched`, `meetings-without-decision`, `open-tasks-by-client`, `pages-missing-property`; `params`, an object per query (section 3.9); `limit`; `dry-run`. Output: the same shape as `datalog_query`, plus `name` and the resolved `params` (titles and idents, not ids). Refusals: 400 `params.<name>: <reason>`; 404 for an unknown name, listing the names; plus the `datalog_query` refusals.

**Changed (internal).** `AuditLog.recordRead` takes `tool` and `status` first.

**`connector_help` Queries paragraph (draft).** "`datalog_query` runs a read-only Datalog query (EDN, at most 4,000 characters) against the graph. Prefer `run_named_query` when one fits: `projects-untouched`, `meetings-without-decision`, `open-tasks-by-client` and `pages-missing-property`, each with defaults you can override. Results are cut to `limit` rows (default 50, maximum 200) and about 100,000 characters, and `truncated` says which cap applied. A query that scans more than 50,000 datoms is refused (422): narrow it with a tag, page or attribute value. Pull `:block/uuid` and `:block/title` to get handles for the other tools. Only pure functions are allowed (comparisons, arithmetic, `get-else`, `missing?`, `includes?`, `starts-with?`, `lower-case` and the like; no regex, `range` or `rand`), and clauses must share variables. Anything tagged Private, on a private page or under a private block is left out. Unavailable on E2EE graphs. `dry-run: true` shows the query without running it."

**Logseq skill note (for the PR body).** Claude can now query the graph with Datalog. For weekly reviews, use `run_named_query` (`projects-untouched`, `meetings-without-decision`, `open-tasks-by-client`, `pages-missing-property`) before writing fresh Datalog. Meetings are tagged Business Meeting and clients are set with `forClient`; pass other tags or properties as params. Private content never appears in results. Each query is logged in `get_activity_log`.

## 5. Cost on the Free plan

| Per call | Worker requests | D1 rows read | D1 rows written | AI neurons, Vectorize, KV |
|---|---|---|---|---|
| `datalog_query` or `run_named_query` | 2 (connector, sync Worker via the binding) | about 1 (graph token lookup) | 2 (the read row and its `(graph_id, at)` index entry) | 0 |
| Dry run | 2 | about 1 | 2 | 0 |
| Refused (400, 409, 422) | 2 | about 1 | 2 | 0 |

At 1,000 queries a day that is 2,000 requests (2% of 100k), 2,000 rows written (2% of 100k) and about 1,000 rows read (0.02% of 5M). The hourly audit purge removes the rows after `auditRetentionDays`. No cron work and no stored state beyond the audit rows.

**CPU.** The work runs in the sync Worker's graph Durable Object, not the front Worker. It is bounded by `scan-cap` filtered datoms, the private-set build, a sort of at most `row-cap` rows (a join can match far more rows than it scans datoms, so past the row cap the query answers 422 before the sort; *as built in stage 3's review: 2,500 rows*), at most 200 pulls (depth 2, at most 50 values per many-attribute) and a 100,000-character serialisation. The connector's front Worker only forwards JSON. Whether the Durable Object's request on the Free plan has the same 10 ms CPU limit as the front Worker is **unverified** here; README records the slowest 1% of requests at up to 92 ms without rejection. The bench (section 8) times the scan cap cold and warm at 5,000 and 20,000 pages, and the cap is set so the warm worst case stays near the observed tolerated tail. On Paid the cap can rise.

## 6. Safety

- **Read-only by construction.** No `conn` reaches the query, the EDN reader evaluates nothing, and the validator refuses write forms, unlisted functions and input-bound functions. A test checks `max-tx` and the datom count after each refusal.
- **Private content stays out** of results, pulls, reverse refs and aggregates, because the filter runs below the query engine.
- **No silent success or silent wrong answer.** Over-cap results say which cap applied; the scan cap answers 422; E2EE answers 409 instead of matching nothing; a named query default that does not resolve answers 400.
- **Errors name the entry and reason**: the clause number, the param name or the cap.
- **No query text in D1.** The audit row holds a hash or the named query's name.
- **Example data only.** Tests and docs use `sync.example.com`, `mcp.example.com` and example aliases. No graph name, ident suffix or uuid from the owner's graphs appears in any file.

## 7. Risks

1. **CPU on Free.** The scan cap counts datoms, not join work. Join and predicate work that scans few datoms (a wide `or-join`, a recursive rule over a small set, `not-join` fan-out) still costs CPU the cap does not count. The cross-product refusal and the removal of `range`, regex and `rand` narrow this but do not close it. The bench must time the worst shapes at the cap; if a shape exceeds the budget, add a rule-depth or `or` branch limit rather than raise the cap.
2. **Private leaks through derived values.** Covered for aggregates by filtering below the query. A raw title holding a `[[uuid]]` to a private page shows the uuid (not the title). Property value entities owned by private blocks must be in the set; tests cover a property value on a private page and a child of a private block on a public page.
3. **Storage-backed Datascript.** Logseq's fork may load storage lazily during a big scan, adding I/O and memory the scan cap does not count. **Unverified**; the bench on a large graph shows it.
4. **Allow-list drift** on a Datascript bump. Deny-by-default plus the existence test (3.3).
5. **Sort cost and mixed types.** Deterministic truncation sorts the whole result before the cut, bounded by the scan cap. Mixed-type `compare` would throw a 500 without the type rank; a test runs a find over mixed value types.
6. **Named query defaults** are checked against the owner's current schema. A renamed tag gives a 400 naming the param, never empty rows.
7. **Audit writes.** Logging every query adds 2 D1 writes per call. A loop of queries could take a visible share of the 100k writes a day. The tool text steers to named queries and `limit`, and the usage report already counts `kind='read'` rows. Section 11 asks whether reads should be logged at all.
8. **`d/filter` is uncached.** Every index access runs the predicate, which does a set lookup and a schema check. The bench includes this overhead.

## 8. Testing

Each test is written first and seen to fail before its code exists, and the PR quotes the failure.

**Patch 0039**, through the real `sync-handler/handle-http` on a graph built by `create_graph`, with the real outliner and no stubs:

1. **Read-only.** `[:find ?b :where [(transact! ?b)]]`, a `[:db/add …]` in inputs, a `?f` bound through inputs, and `range`, `re-find` and `rand` are each refused with 400 naming the clause. After each, `max-tx` and the datom count are unchanged. Every allow-listed symbol is a key of `query-fns`.
2. **Private.** Fixtures: a page tagged Private; a page tagged a tag that extends Private; a block tagged private on a public page, with a child; a property value on a private page; a public block that refs the private page. Queries by title, a `count` aggregate, `missing?`, a pull with `:block/_refs` and `(pull ?b [*])` never return them, and the count equals the public total.
3. **Caps.** A graph above the scan cap answers 422 naming the cap, never 500. `(pull ?b [*])` across the graph returns 50 rows with `truncated.by = "limit"` and the total. Long titles give `truncated.by = "byte-cap"` with JSON under 100,000 characters. A cross product and `...` recursion in a pull answer 400. A many-attribute limit above 50 is refused. A find over mixed value types sorts without throwing.
4. **E2EE.** Both routes on a graph with `graph-e2ee=true` answer 409.
5. **Dry run.** Returns the EDN and runs nothing; the scan counter stays at 0.
6. **Named queries.** Each runs on fixtures with known answers; for example `projects-untouched` with `days=30` returns the stale project and not the one with a fresh child block edit. Bad params name `params.<name>`. An unknown name answers 404 listing the names. Every entry passes the validator.
7. **Parse errors.** Malformed EDN names the position; an `inputs`/`:in` count mismatch names both counts.

**Connector (vitest pool-workers):**

- Both tools are READ, take no `reason` and are not routed through `audited()`.
- Each call inserts exactly one `kind='read'` row with `tool`, `status` and `addressed` set (a hash or a name, never the query text); the D1 meta shows 2 rows written and 0 read.
- An error from the server records `status='error'`.
- An audit insert failure still returns the result.
- `get_activity_log`'s own read rows are unchanged by the `recordRead` signature change.
- The manifest check and the `connector_help` snapshot pass.

**Scripts:** `bench-datalog-query.mjs` (after `bench-suggest-links.mjs`) runs the built handler under Node against a generated N-page graph and times the scan cap, the private-set build and the worst query shapes from risk 1, cold and warm, at 5,000 and 20,000 pages. Its `.test.mjs` checks the output shape only.

Finally, `scripts/check.sh --upstream` on HEAD, naming the SHA and what it skipped.

## 9. Rollout and verification

**Build order.** (1) Patch 0039 validator and filter tests (1, 2), then caps (3), then E2EE, dry run, named queries and parse errors. (2) The bench; set `scan-cap` from it and record the numbers in the PR. (3) Rebuild `.upstream`, re-vendor. (4) Connector annotations, `recordRead` change, `LOGGED_READS` and tests. (5) `connector_help`, manifest, README §11.8. (6) `scripts/check.sh --upstream` on HEAD.

**After merge** (`deploy` applies the patch and the Worker; no migration):

1. On the test graph (example alias `test`): `datalog_query` with `[:find (pull ?p [:block/uuid :block/title]) :where [?p :block/tags ?t] [?t :block/title "Project"]]` returns the project pages.
2. `(pull ?b [*])` with no other clause answers rows with `truncated.by = "limit"`, or 422 naming the scan cap on a large graph, never 500.
3. A page tagged Private does not appear in a title query that would match it.
4. Each named query runs in one call with its defaults; `dry-run: true` shows its Datalog.
5. `get_activity_log` lists each call as a read with a hash or a name.
6. The next day's usage report: Worker requests and D1 writes are up by about 2 per query; neurons are flat.

**Rollback.** Revert the Worker and the patch. The tools write nothing to the graph; the audit rows are ordinary read rows.

## 10. Out of scope

- The change feed (`changes_since`), schema export and deeper `get_graph_health` checks from tracker item 40. Tracker criterion 5 (the weekly review uses them) moves to a follow-up item.
- Converting query fences into Query blocks (README backlog 21); this design only keeps the `{:query :inputs}` representation ready for it.
- Structure-only queries on E2EE graphs.
- Owner-defined named queries stored in the graph or D1; the library is code.
- Caching the private set or query results.
- Any D1 migration, kb-index change or semantic index change.
- Tracker item 3 (CLI bridge A). It is replaced if this ships, but closing it is the owner's call.

## 11. Open questions for the owner

1. **Scope.** The change feed, schema export and deeper health checks from item 40 are left for a follow-up, and with them criterion 5. Is that right, and should the follow-up be a new tracker item?
2. **Logging reads.** Each query writes one audit row (2 D1 rows). Do you want queries in `get_activity_log`, or should reads stay unlogged as other reads are?
3. **Named query defaults.** Your graph has Business Meeting rather than Meeting, and `forClient` rather than `client`. Are those the right defaults? Should `meetings-without-decision` look back 90 days by default?
4. **Private.** The rule hides anything tagged Private (any case, and tags that extend it), anything on a private page and anything under a private block. Should other tags also be hidden from queries?
5. **E2EE.** Both tools refuse E2EE graphs. Would structure-only queries there (tags, refs, dates, no titles) be useful?
6. **Scan cap.** It starts at 50,000 datoms and the bench sets the final number. On a large graph some broad questions will answer 422 and need narrowing. Is that acceptable, or would you rather have named queries cover those?
7. **Item 3 (CLI bridge A).** Close it once this ships?
