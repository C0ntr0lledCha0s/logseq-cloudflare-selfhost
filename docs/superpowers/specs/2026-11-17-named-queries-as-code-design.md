# Named queries as code, and a width cap on function bindings: design

Date: 2026-11-17
Issue: item 40 on the tracker ("Read-only Datalog query tool, named queries, change feed and schema export"), status Backlog. Areas: patch, connector, docs, scripts.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0040. This work changes patch 0039, which is not yet merged (PR 52), and adds no patch.
Branch: `claude/relaxed-maxwell-s4r8o4-queries`, at `18da2e9` ("stop meetings-without-decision on a deep outline at a rule cap"), 0 commits behind `origin/main`.
Builds on: `2026-11-09-datalog-query-named-queries-design.md` ("the query design", sections 3.4 to 3.10, 5, 8 and 12 As built), its plan `docs/superpowers/plans/2026-11-09-datalog-query-named-queries.md`, `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md` and `docs/spikes/2026-11-09-safe-caller-datalog-queries.md` (on branch `claude/relaxed-maxwell-s4r8o4-query-safety` only).

Decisions marked **(owner)** come from the owner's decision of 2026-11-17 in the brief. Decisions marked **(call)** were made while writing this design. The design panel chose the "named" proposal: the four named queries become Clojure that walks Datascript's indexes under named bounds, and `datalog_query` gains a width cap. No ideas were grafted from other proposals. The decisions most worth a second look are in section 11.

**What was run for this spec.** The review findings were reproduced against the release bundle that `.upstream` holds for `18da2e9` (built 2026-11-17 00:03 from the patched source, checked line for line against `patches/0039-semantic-datalog-query.patch`). A throwaway script in the scratchpad used `loadReleaseSyncDO` from `scripts/release-query-check.mjs`, built fixtures through `SyncDO.fetch` (`/semantic/pages`, `/semantic/tags`, `/semantic/block-trees`, `/semantic/block-properties/batch-set`) and called the real `/semantic/named-queries/:name` and `/semantic/query` handlers. `scripts/release-query-check.mjs` itself passed all seven checks first. Times are Node, warm, one run each. What came back:

| Case | Fixture | Answer |
|---|---|---|
| F2, `meetings-without-decision` | 10 meetings, 200 decisions 6 levels down on another page | **422** after 202 ms: `query stopped after joining 20,000 rows (the join cap); a join through a shared value, such as two blocks with the same tag, matches every pair, so bind one side or narrow it with a tag, page or attribute value` |
| F2 | 20 meetings, each with 3 decisions 40 levels below it | **422** after 123 ms, the same join-cap message (review 2 saw the call cap at this size; which cap trips first depends on the layout) |
| F2 | 10 × 200, 50 × 40 and 5 × 400, decisions at the top level of another page, 5,000 filler blocks | 200 after 137, 99 and 100 ms. **Not reproduced at depth 1**: the product of meetings and decisions only reaches the join cap once the walk has several levels |
| F3, `pages-missing-property` | 700 pages tagged with one tag, none with the property, 5,000 filler blocks | **422** after 34 ms: `query stopped after scanning 20,000 datoms (the scan cap); narrow it with a tag, page or attribute value, or use a named query` |
| F3, `open-tasks-by-client` | 150 open tasks across 3 node clients set on each task, 5,000 filler blocks | 200 after 43 ms. **Not reproduced** at this size and layout (see below for the page-level case) |
| F1, `datalog_query` | 175 `[(identity ?t) ?rN]` clauses over the 100 blocks of one page | 200 after **1,929 ms** (review 2: 1.48 to 1.64 s) |
| Nit, scan-cap log | the `pages-missing-property` scan-cap 422 above, with `console.error` captured | **Not reproduced**: no `console.error` call |
| Nit, `/` in a title | `POST /semantic/pages {"title": "a/b repro"}` | **500** `server error`, `debug-message` `#error {:message "Page name can't include \"/\"." ...}`, and one `console.error` from `[logseq.db-sync.worker.handler.sync] {:db-sync/http-error ...}` |

A second run on a fresh graph added three cases. `open-tasks-by-client` with 150 open tasks on 30 pages, the client set on each page (node property, 3 clients): 200 after 74 ms, so **not reproduced** at page level either. A `datalog_query` that hits the scan cap (`[:find (count ?b) :where [?b :block/title ?t] [(clojure.string/includes? ?t "zzz")]]` over 21,000 blocks): 422 after 38 ms, with `console.error`, `warn`, `log` and `info` all captured and **none called**. `projects-untouched` over 21,000 blocks answered 200 after 15 ms, but the fixture had no stale page (pages cannot be backdated through the API, and `days` is at least 1), so it says nothing about backlog 24; the 422 above about 20,000 blocks is taken from the query design's As built notes and README backlog 24, **not reproduced here**.

So F2 (at depth) and the `pages-missing-property` part of F3 are reproduced, F1 is reproduced, the `/` 500 is reproduced, and the `open-tasks-by-client` 422, the `projects-untouched` 422 and the scan-cap `console.error` are not. Section 8 asks each scale test to find a layout that fails first; where none does, the test stays as a guard and the PR says it was never red.

Source read for this spec:

- Datascript is Logseq's fork at `3f141af`. `bind-by-fn` (`query.cljc:524-545`) calls the function once per tuple of the production relation and, for each result, builds a one-row `Relation`, joins it with `prod-rel` to the bound value and folds the results with `sum-rel`. Each of those copies the whole tuple. So the copy grows with rows × columns, and the columns grow by one per function binding. That the total therefore grows with rows × clauses² is review 2's model; this spec measured one point on it (above), not the curve.
- `meetings-without-decision`'s `not-join [?m ?decision-tags]` (`named_queries.cljs`) receives `?m` already bound to every meeting in the window, so the body's `[?d :block/tags ?decision-tag]` and `(above ?d ?m)` run over the product of meetings and decisions, and each level of the walk up carries that product. That is consistent with the table: depth 1 passes at 10 × 200, depth 6 does not. The `days` param bounds only the meetings.
- `private-ids` (`handler/datalog.cljs:650`) walks `d/datoms :avet :block/page id` and `:avet :block/parent id` from every private root. So the AVET index does lead from a page to its blocks and from a block to its children, for ref attributes, which is what section 3.3's walks rely on. README backlog 24's "no index leads from a page to its blocks" is about Datalog: a pattern joined to two or more bound rows scans the attribute instead of seeking.
- The cause of the `pages-missing-property` scan-cap 422 with one tag and no extending tags is **a guess**: the named query's docstring says only a tag with extending tags scans `:block/tags`, yet one tag over 700 pages scanned 20,000 datoms. Section 3.3 does not depend on the cause, because the code path replaces the query.
- The `/` 500 comes from the outliner's page-name check, thrown inside page creation and wrapped by the sync handler's generic error response, which also logs it with `console.error`. That 500 path is one source of a `console.error` per request; whether review 2's scan-cap log had another source is **unverified** (section 3.8).

Behaviour that no test has shown yet is marked **unverified**, and section 8 names the test that settles it.

## 1. Goal

The four named queries should answer on the owner's real graph, or refuse with a message the caller can act on. Today they run as Datalog under caps written for caller-supplied queries, so on realistic graphs they answer a generic 422 that advises binding one side of a join, which a `run_named_query` caller cannot do. Separately, `datalog_query` spends 1.5 to 1.9 s on a query of many function bindings, because no cap counts how wide a row is.

Acceptance (the brief):

1. Each named query answers 200 with the right rows on a realistic owner graph (for example 20,000 blocks, hundreds of meetings and decisions, hundreds of open tasks, thousands of tagged pages) within about 100 ms in the release bundle.
2. Review 2's F2 sizes (10 meetings × 200 decisions, 50 × 40, 5 × 400, and 20 meetings with 3 decisions at depth 40) and F3 sizes (`open-tasks-by-client` above 120 open tasks, `pages-missing-property` above 600 tagged pages, `projects-untouched` above 20,000 blocks) answer 200 with the correct rows.
3. Each named query has explicit named bounds. Going past one answers 422 naming the bound and how to narrow (a smaller `days`, a narrower tag), never a generic cap message. Work is counted in the code paths, not by `Date.now`.
4. Results match the current Datalog versions on the existing fixtures (a parity test), including tag inheritance (a tag also matches the tags extending it) and the ancestor walk (a decision anywhere under a meeting, at any realistic depth).
5. `run_named_query` keeps its name, its four query names, params and defaults, private page and block exclusion, the E2EE 409, the read audit row and its response shape, except as section 4 says. Dry run describes the plan instead of showing Datalog.
6. The F1 shapes (175 function-binding clauses over 100 blocks, 99 over 200 rows, 20 bound `includes?` over 500 rows) answer a named 422 quickly (target under about 100 ms), and the all-caps worst case stays near the accepted 184 ms. The rule cap's 52/53-level behaviour no longer applies to named queries, and `datalog_query` refuses rules as it does now.
7. Tests run through the real `/semantic/named-queries/:name` handler and the release bundle (`scripts/release-query-check.mjs`), each seen to fail first, with scale tests at realistic sizes that record timings.
8. A scan-cap 422 in the release bundle logs no `console.error` with a stack trace. The 500 on `POST /semantic/pages` with `/` in the title is fixed if trivial, otherwise listed as backlog.
9. Contract text is updated: OpenAPI, `QUERIES_HELP` and its tests, README §11.8, §11.10 and backlog 23 to 25, the query design's As built notes, the learning doc `a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `tools-manifest.json` if tool text changes, and a Logseq skill note in the PR body.
10. The PR's verification names the commit its checks ran on and repeats what `scripts/check.sh --upstream` skipped.

## 2. Context

**Why the caps don't fit fixed queries.** The query design bounded `datalog_query` with caps that count Datascript's work (datoms scanned, rows joined, function calls, relation work, rule guards), because a caller can write any shape and only counting stops all of them. A named query's shape is fixed. Its cost depends on the graph (how many meetings, how deep the decisions, how many stale pages), and when a cap stops it the message talks about joins and bindings the caller never wrote. Each fix so far (walking up with `get-some`, the rule cap at 52 levels, backlog 24) moved the limit rather than removed it.

**Owner decision (2026-11-17).** Compute the four named queries in the sync server in Clojure by walking Datascript's indexes (`d/datoms`, entity navigation), not as Datalog. Each has its own named bounds and refuses with a 422 naming the bound and how to narrow it. Keep the tool's name, query names, params, defaults, privacy, E2EE 409, audit row and response shape unless this spec says otherwise. Keep the change inside patch 0039.

**The Worker clock.** `Date.now` and `performance.now` do not advance during synchronous CPU work in a Worker, so a deadline cannot stop a walk (`docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`). Bounds count reads and candidates.

**Privacy today.** `run-query` builds `private-ids` (every private root and its descendants and page blocks) and runs the query over `d/filter` with it. The private set costs 47 ms at 5,000 pages and 209 ms at 20,000 (README backlog 23), so a named query that builds it cannot meet a 100 ms target on a 20,000-page graph.

**Who reads the Datalog echo.** Responses carry `query`, `inputs` and `rules` as EDN. The query design kept them for README backlog 21 (query fences as Query blocks). Nothing reads them yet.

## 3. Design

### 3.1 Layout (call)

Everything stays in patch 0039.

| File (in `deps/db-sync`) | Change |
|---|---|
| `src/logseq/db_sync/worker/named_queries.cljs` | Rewritten: four functions, the counted index helpers, lazy `private?`, the bounds, plan text. No Datalog. |
| `src/logseq/db_sync/worker/handler/datalog.cljs` | `handle-named-query` calls the code path. `shape-response` (limit, byte cap, notes, `rows-last`) is factored out of `run-query`, which still uses it. The rule cap, the `rule-gen-guards` hook, `rule-cap-levels`, rules in `run-query` and `query-args`, and the validator's rule paths are removed. A width cap is added (section 3.9). |
| `src/logseq/db_sync/worker/routes/semantic.cljs` | OpenAPI text for `runNamedQuery` (description, 422, `NamedQueryResponse`) and `datalogQuery` (width cap; no rule-cap or ancestor-rule wording). |
| `test/logseq/db_sync/semantic_datalog_query_test.cljs` | Parity, scale, bound, contract and width-cap tests (section 8). |
| `src/logseq/db_sync/worker/handler/semantic.cljs` | Possibly: refuse `/` in a new page title (section 3.8). |

### 3.2 Counted reads and named bounds (owner)

`ctx` carries the db, a `reads` counter, a per-bound counter map and the query's bounds. Every datom access goes through two helpers:

- `datoms*` wraps `d/datoms` (AVET or EAVT) as a lazy sequence that charges one read per datom realised;
- `first-value*` returns the first value of an attribute for an entity and charges one read.

Each query also charges its candidate bounds explicitly where it visits a candidate. A charge that passes a bound throws `{::bound name}`, which the handler turns into the 422 of section 3.6. `reads` is a backstop over everything, privacy walks included: provisional 100,000. No code path reads the clock.

The bounds are named per query, so a refusal can say what to narrow. Their values are provisional until the bench (section 8, step 6) sets them; section 5 has the arithmetic.

`resolve-params` is reused unchanged: a tag by uuid, ident or title expanded to itself plus every class extending it, a property by uuid, ident or title with its type check, `days` within 1 to 3,650 and turned into a cutoff. So names, params, defaults and the 400 `params.<name>` messages stay as they are.

### 3.3 Privacy without the private set (call)

`private?` is memoised per request and gives the same answer as `(contains? (private-ids db) e)` for each entity a query touches:

- `e` is a root when it has `:logseq.property/deleted-at` (the Recycle bin), or a tag whose lineage (`graph-insights/class-lineage-fn`, memoised per class) includes a class titled `private` in any case;
- `e` is private when it is a root, or when its `:block/parent` or its `:block/page` is private.

The walk up is iterative and counted against `reads`. Memoisation makes each distinct ancestor cost one walk per request. `visible-ref?` is `(not (private? v))`, applied wherever `d/filter` used to hide a ref datom: tags, client values, property values. `private-ids` and `query-filter` stay for `datalog_query`, which is unchanged.

### 3.4 The four queries (owner, with the shapes a call)

Rows are `[sort-key eid]` until section 3.5 shapes them.

**`projects-untouched (tag, days)`.** For each tag id, iterate AVET `:block/tags`, charging `tagged` (provisional 20,000). Keep entities with no `:block/page` (pages), not `private?`, whose `:block/updated-at` (default 0) is below the cutoff. For each such page, iterate AVET `:block/page page`, charging `page-blocks` (provisional 20,000), and stop at the first block whose `updated-at` is at or after the cutoff and that is not `private?`. Privacy is checked only for those fresh blocks, matching the Datalog, where a private block's datoms were hidden. A page with no such block is a row `[updated eid]`. The AVET seek from a page to its blocks replaces backlog 24's scan of every block's `:block/page`.

**`meetings-without-decision (meeting_tag, decision_tag, days)`.**

1. Candidates are entities tagged with any meeting tag (charging `meetings`, provisional 5,000) whose `:block/created-at` (default 0) is at or after the cutoff and that are not `private?`. With none, answer at once with no rows.
2. Let P be the candidates' pages: the meeting itself for a page, its `:block/page` for a block.
3. Iterate decision-tagged entities (charging `decisions`, provisional 20,000; about one seek each) and keep the non-private ones whose page is in P.
4. Walk each kept decision up `:block/parent` into one shared `decided` set, stopping at the first ancestor already in it (charging `ancestor-steps`, provisional 50,000). The decision itself is not added, only its proper ancestors, as the `above` rule required.
5. A candidate not in `decided` is a row `[created eid]`.

Because the walks share `decided`, cost grows with the distinct ancestors of the relevant decisions, not with meetings × decisions × depth, and a decision 40 or 180 levels down costs one step per level. The 52-level limit goes.

**`open-tasks-by-client (client_property)`.** Build the done-or-canceled set from AVET `:logseq.property/status` on the two status entities. Iterate AVET `:block/tags :logseq.class/Task` (Task only, no extending classes, as now), charging `tasks` (provisional 50,000; a set check each), and skip done, canceled and `private?` tasks. Charge each open task to `open-tasks` (provisional 5,000). Its clients are its visible values of the property, else its page's visible values, else `[""]`. A client's title is its `:block/title`, or `""` when it has none. Rows `[title eid]` are deduplicated, because Datalog returned a set, so two clients with the same title give one row, as now.

**`pages-missing-property (tag, property)`.** Iterate tagged entities (charging `tagged`, provisional 20,000), keeping pages that are not `private?` and have no visible value for the property. Row `[eid]`.

### 3.5 Response (call)

Rows sort with a typed comparator (number or string first, then eid), the same order `sort-rows` gives these types: oldest first for the two date queries, by client title for tasks, creation order for pages. `total-rows` counts every row. Rows are cut to `limit`, then `shape-response` applies the byte cap with the same notes as `datalog_query`. Only kept rows build `{block/uuid, block/title}` from the entity, as the pull did (a missing title is left out). `rows` stays last.

`name`, `params`, `columns`, `rows`, `total-rows`, `returned` and `truncated` are unchanged. `query`, `inputs` and `rules` (EDN) are replaced by:

- `plan`: plain text listing the steps and each bound, e.g. "1. meetings tagged Business Meeting (or a tag extending it) created in the last 90 days (meetings bound 5,000) ...";
- `work`: the count used against each bound, e.g. `{"meetings": 12, "decisions": 230, "ancestor-steps": 900, "reads": 3100}`.

The audit row is unchanged (connector side), and E2EE answers 409 before the name lookup, as now.

### 3.6 Refusals (owner)

A bound answers 422 naming the query, the bound and its value, and the narrowing:

- "meetings-without-decision stopped after 5,000 meetings created within days (its meetings bound); give a smaller days or a narrower meeting_tag"
- "projects-untouched stopped after reading 20,000 blocks on pages not updated within days (its page-blocks bound); give a narrower tag or a larger days"
- "open-tasks-by-client found more than 5,000 open tasks (its open-tasks bound); mark finished tasks Done or Canceled, or list one client's tasks with datalog_query"
- "pages-missing-property stopped after 20,000 tagged pages and blocks (its tagged bound); give a narrower tag"

The `reads` backstop names itself and the same per-query advice. No named query answers the scan, join, row, call, work or rule cap message any more.

### 3.7 Dry run (owner)

`dry-run: true` resolves the params and returns `{name, params, plan, bounds, dry-run: true}`. It reads nothing beyond param resolution, and `last-run` shows 0 reads.

### 3.8 The two nits (brief)

- **Scan-cap `console.error`.** Not reproduced on `18da2e9` (see the table above). Stage 1 repeats review 2's case (a `datalog_query` scan-cap 422 in the release bundle with 5,000 filler blocks) with `console.error`, `warn` and `log` captured. If it logs, the fix goes where it logs (Sentry capture or a logged re-throw in the request path), inside 0039. Either way, `release-query-check.mjs` gains a check that no `console.error` fires during a scan-cap 422, so a regression shows.
- **`/` in a page title (reproduced, 500).** The outliner refuses the name with `Page name can't include "/".` after the handler has started the write. The fix is a check before the write in the create-page path that answers 400 naming the title and the character, with its own test through the real handler, if that is the only path (create page, and any batch entry that creates a page by title). It gets at most 30 minutes in stage 1; if the check needs more than one place or touches namespace pages, it becomes a README backlog item instead.

### 3.9 Width cap for `datalog_query` (call)

A new counter beside the other hooks. While `run-query`'s `d/q` runs, `dq/bind-by-fn` is wrapped with `set!` (the `join-tuples` pattern). After each call it charges rows × columns of the relation it produced, which is the copy the per-row `prod-rel` and `sum-rel` make. Past the cap the query answers 422:

"query stopped after function bindings copied 100,000 values (the width cap): each function binding copies every column of every row, so many bindings over many rows cost rows x columns; bind fewer values with functions or narrow the rows first"

The provisional cap is 100,000 cells. At that value 175 clauses over 100 rows should stop near clause 45, 99 clauses over 200 rows near 31, and 20 bound `includes?` over 500 rows early; a legitimate 3-binding query over 2,500 rows at width 5 charges about 37,500. The bench sets the value so the F1 shapes stop in under 100 ms in the release bundle. The join, work and call caps are unchanged, so the 184 ms all-caps worst case can only fall. The test field is `datalogWidthCap`.

### 3.10 What is removed (call)

Named queries were the only users of `above-rules`, the rule cap, the `rule-gen-guards` hook, `rule-cap-levels` and its message, rules in `run-query` and `query-args`, and the validator's rule paths (`rule-names`, `rules-errors`, `left-recursion-errors`, the `caller?` flag). All go. `datalog_query` still refuses a `rules` field, `%` and rule calls with 400; its message now points to `run_named_query` without describing an ancestor walk in rules. Test bounds are set with a `namedQueryBounds` field on the Durable Object, following the `test-cap` pattern; no request can set them.

## 4. Tool contract

**`run_named_query`** keeps its name, method and path, the four names, params, defaults and day bounds, the 400 `params.<name>` errors, the 404 listing the names, the E2EE 409, `limit` 1 to 200 (default 50), the byte cap, `total-rows`, `returned`, `truncated {by, note}`, `rows` last, the row order and the pulled `{block/uuid, block/title}`.

Changes:

- `query`, `inputs` and `rules` are replaced by `plan` (string) and `work` (object of counts).
- Dry run returns `{name, params, plan, bounds, dry-run: true}` and reads nothing.
- 422 means only a named bound (section 3.6). The depth limit is gone.

**`datalog_query`** keeps its input, output and caps, and gains the width-cap 422. Its description and rules refusal drop the ancestor-walk wording.

**Text that changes.** The `runNamedQuery` and `datalogQuery` OpenAPI descriptions and 422 text, `QUERIES_HELP` in `connector/src/tools/handwritten.ts` (named bounds in place of the rule cap's 2,000 units and 52 levels; the width cap added; the `query`/`inputs` echo replaced by `plan`), the vendored `openapi.json`, and README §11.8 (Queries, Caps, Audit and cost: "Each response carries `query` and `inputs`" changes) and §11.10. `tools-manifest.json` carries names, paths and annotations only, so it should not change; `npm --prefix connector run update:manifest` confirms. The audit row is unchanged: `named:<name>` plus `param:<name>`.

**Draft `QUERIES_HELP` named-query paragraph.** "`run_named_query` runs one of four fixed queries as server code, not Datalog: `projects-untouched`, `meetings-without-decision`, `open-tasks-by-client` and `pages-missing-property`. Each answer carries `plan` (the steps and their bounds) and `work` (what it counted). A query that passes one of its bounds answers 422 naming the bound and what to narrow, such as a smaller `days` or a narrower tag. A decision at any depth under a meeting counts."

**Logseq skill note (for the PR body).** Named-query answers no longer carry Datalog (`query`, `inputs`, `rules`); read `plan` to see what ran. `meetings-without-decision` has no depth limit. A 422 from a named query names a bound and says what to narrow; do it and call again rather than writing Datalog. `datalog_query` refuses many function bindings over many rows (the width cap).

## 5. Cost on the Free plan

| Per call | Worker requests | D1 rows read | D1 rows written | AI neurons, Vectorize, KV |
|---|---|---|---|---|
| `run_named_query`, `datalog_query` (ok, refused or dry run) | 2 (connector, sync Worker and Durable Object) | about 1 (graph token) | 2 (the audit row and its index entry) | 0 |

Unchanged from the query design. No cron, no D1 work, no stored state. 1,000 calls a day is 2,000 requests (2% of 100k) and 2,000 D1 rows written (2% of 100k).

**Durable Object CPU per call (provisional; the bench at 20,000 blocks sets it).**

- No private-set build (47 ms at 5,000 pages, 209 ms at 20,000). Lazy `private?` costs one or two EAVT seeks per touched entity and per distinct ancestor.
- `projects-untouched`: at most `tagged` (20,000, a contiguous AVET range) plus `page-blocks` (20,000 seeks), with an early exit at a fresh block.
- `meetings-without-decision`: about meetings + decisions seeks plus the distinct ancestors of the relevant decisions. The F2 sizes come to a few thousand reads.
- `open-tasks-by-client`: one AVET range over Task tags plus about 4 seeks per open task, at most 5,000 open tasks.
- `pages-missing-property`: about 3 seeks per tagged page.
- The `reads` backstop (100,000) bounds everything. At 0.5 to 1 µs a counted read that is under 100 ms; at 2 to 3 µs (possible for cljs Datascript in the release bundle) it is not, and the bench lowers the bounds.
- `datalog_query`: one multiply per function-binding clause; the F1 shapes stop within 100 ms; the 184 ms worst case cannot rise.

## 6. Safety

- **Read-only.** The code path calls `d/datoms` and entity reads on `@conn`'s db value and never touches the conn. A test checks `max-tx` and the datom count after each named query.
- **Private content stays out.** `private?` must equal `private-ids` on every entity; a test compares them on random graphs (section 8). Ref values to private entities are hidden, as `d/filter` hid them.
- **No silent wrong answer.** A bound answers 422 naming it, never a partial row set. A default the graph lacks answers 400, as now.
- **Errors name the reason**: the query, the bound, its value and the narrowing.
- **Example data only.** Tests and docs use example tags, pages and `sync.example.com`. No graph name, ident suffix or uuid from the owner's graphs.

## 7. Risks

1. **Parity drift from `d/filter` semantics.** A ref datom to a private entity was hidden (tags, clients, page values); private and Recycle-bin blocks on a visible page did not count as fresh or as decisions; `get-else` defaults were 0 or `""`; Datalog's set collapsed duplicate `[title task]` rows; `above` excluded the block itself. Each must be reproduced. Mitigation: the old Datalog stays in the test file and is compared on the fixtures and on about 30 seeded random graphs.
2. **Lazy `private?` disagreeing with `private-ids`** through parent and page chains or through classes extending a Private class. Mitigation: compare on every entity of the random graphs.
3. **Provisional bounds.** Seek cost in the release bundle may be 2 to 3 µs, not 1. The bench (release bundle through `SyncDO.fetch`, first call and warm) sets each bound, and section 12 will record the measured ms per bound. If 20,000 blocks cannot fit in 100 ms, `page-blocks` is lowered and the tool text says so.
4. **`projects-untouched` grows with blocks on stale pages.** Pages that pass the page filter are mostly untouched, so it walks all their blocks. Fallback if the bench shows a problem: collect touched pages from an AVET range on `:block/updated-at` at or after the cutoff, picked when stale candidates × average blocks exceeds recent blocks. Left out of the first build.
5. **`open-tasks-by-client` has no param to narrow.** Its refusal can only advise closing tasks or querying per client with `datalog_query`. 5,000 open tasks should be well above the owner's graph.
6. **Backlog 21 loses its input.** Named queries no longer have a Datalog form, so a Query block can reproduce only `datalog_query`. README backlog 21 and the query design's section 3.9 "Reusable representation" are updated to say so.
7. **A large deletion inside the patch.** Removing rule support may leave the no-caller-rules refusals looking untested to mutation review; their existing tests stay.
8. **The width hook.** A Datascript bump that renames or inlines `bind-by-fn` would remove the guard silently. A test asserts `last-run :width` is above 0 for a function-binding query, as the other hooks have.
9. **Overshoot.** The width charge comes after `bind-by-fn` returns, so one clause can overshoot the cap by at most rows (bounded by the join cap) × the query's variables. The bench checks it.
10. **The `console.error` source is unknown** (section 3.8). If it is in the request wrapper, keep the change inside 0039 if possible.

## 8. Testing

Each test is written first and seen to fail on `18da2e9`, and the PR quotes the failure. Tests go through the real `/semantic/named-queries/:name` and `/semantic/query` handlers in `semantic_datalog_query_test.cljs` (upstream db-sync suite, run by `scripts/check.sh --upstream`) and through the release bundle with `scripts/release-query-check.mjs`.

1. **Scale (red now with 422 where reproduced).** With `bulk!`, `set-tags!` and `deep-chain!`: 10 meetings × 200 decisions, 50 × 40 and 5 × 400, each with the decisions several levels down (at depth 1 they pass today, see the table above), and 20 meetings with 3 decisions at depth 40, plus a 180-level decision. F3: 150 open tasks across 3 clients, task-level and page-level; 700 tagged pages missing a property; `projects-untouched` over 20,000 filler blocks with 50 stale projects. Each asserts 200 and the exact rows, and prints its ms. The `open-tasks-by-client` and `projects-untouched` sizes did not fail in this spec's runs; stage 1 tries review 2's layouts (and, for `projects-untouched`, a fixture whose page `updated-at` is set in the test db) and quotes whichever fails, or records that none did.
2. **Parity.** The old named-query Datalog and the `above` rules stay in the test namespace and run with `d/q` over `datalog/query-filter` with `private-ids`. Rows and order are compared with the code path on the existing `with-named` fixtures (tag inheritance through Client Project and Key Decision, a grandchild decision, the fresh child edit, private and Recycle-bin pages and blocks, many-valued and page-level clients, text-property clients) and on about 30 seeded random graphs. A separate test checks `private?` against `private-ids` on every entity.
3. **Bounds.** For each query and each bound, set `namedQueryBounds` low, assert a 422 with the exact message (bound, value, narrowing), and that `last-run` stopped at bound + 1. A test asserts the named-query namespace never reads `js/Date` for work.
4. **Contract.** Response keys are `name`, `params`, `columns`, `total-rows`, `returned`, `truncated`, `plan`, `work` and `rows`, with `rows` last. Dry run has `plan` and `bounds`, no rows, and 0 reads. E2EE answers 409 before the name lookup. The 404, the params 400s and the limit and byte-cap notes are unchanged.
5. **F1.** 175 `[(identity ?t) ?rN]` clauses over 100 blocks, 99 over 200 rows and 20 bound `includes?` over 500 rows each answer the width-cap 422, under 150 ms in the dev build and 100 ms in the release check. A 3-binding query over 2,500 rows answers 200. `last-run :width` shows the hook was reached. The all-caps worst-case test keeps its time bound.
6. **Release bundle.** `release-query-check.mjs` seeds about 20,000 blocks through `SyncDO.fetch`, runs the four named queries at realistic sizes, prints the timings, and asserts 200, the right rows and a 300 ms bound (the measured times go in section 12). It runs the F1 shapes, asserts no `console.error` during a scan-cap 422, and drops `RULE_CAP_LEVELS`. Its `.test.mjs` covers the new helpers and constants. `bench-datalog-query.mjs` gains named-query and width-cap modes that set the bounds.
7. **`/` title** (if fixed): `POST /semantic/pages` with `a/b` answers 400 naming the title, through the real handler; seen as 500 first.
8. **Connector (vitest).** `QUERIES_HELP` cap numbers against the vendored OpenAPI text, the `LOGGED_READS` audit row unchanged, `update:manifest` with no diff.
9. `scripts/check.sh --upstream` on HEAD after `scripts/build.sh`, naming the commit and the skipped checks in the PR.

## 9. Rollout and verification

**Build order.** (1) Failing scale, parity and bound tests; the nits' repro. (2) Counted helpers, `private?` and its equality test. (3) The four queries, one at a time, each to green on scale and parity. (4) Response, dry run, refusals; remove the rule paths. (5) Width cap. (6) Rebuild `.upstream` (`scripts/fetch-upstream.sh`, `scripts/build.sh`), run the bench, set the bounds and the width cap, update `release-query-check.mjs`. (7) Re-vendor; `QUERIES_HELP`, OpenAPI text, README, As built, learning doc. (8) `scripts/check.sh --upstream` on HEAD. Each stage is one commit, pushed.

**After merge** (`deploy` applies the patch; no migration):

1. On the test graph (example alias `test`), each named query with its defaults answers 200 with `plan` and `work`.
2. `meetings-without-decision` with `days: 3650` answers 200 on the owner's graph.
3. `dry-run: true` returns the plan and no rows.
4. A `datalog_query` with 100 `[(identity ?t) ?rN]` clauses answers the width-cap 422 quickly.
5. The next day's usage report: requests and D1 writes up by about 2 per query, neurons flat.

**Rollback.** Revert the Worker and the patch. Nothing is stored.

## 10. Out of scope

- Caller rules in `datalog_query` (README backlog 23's fuel counter).
- Changing `datalog_query`'s existing caps beyond adding the width cap.
- A fifth named query, or owner-defined named queries.
- Query blocks (backlog 21), which now apply to `datalog_query` only.
- Structure-only queries on E2EE graphs.
- Caching the private set or results across requests.
- The `projects-untouched` updated-at index fallback (risk 4), unless the bench needs it.

## 11. Open questions for the owner

1. **The Datalog echo.** Removing `query`, `inputs` and `rules` from named-query answers means a named query can't be written into a Query block later (backlog 21). Is that acceptable, or should `plan` carry an equivalent Datalog string for reference only?
2. **Bound values.** The provisional bounds are 5,000 meetings in the window, 20,000 decisions, 20,000 tagged entities, 20,000 blocks on stale pages, 5,000 open tasks and 100,000 reads, to be set by the bench. Do any look low for your graph (for example more than 5,000 open tasks)?
3. **`open-tasks-by-client` narrowing.** It has no param to narrow by. Should it gain an optional `client` param, so its refusal can say "give a client"?
4. **Width cap.** 100,000 copied values refuses queries of many function bindings over many rows. Is it fine for `datalog_query` to refuse those, given the named queries no longer need them?
5. **The `/` title.** If the fix is not trivial, should it be a separate backlog item, or block this PR?
6. **Tracker.** Item 40's text predates the 2026-11-17 decision. Should `/lane` propose an update to it that records this design?

## 12. As built

The build follows sections 3 to 9: patch 0039 holds the four named queries as Clojure in `named_queries.cljs`, the rule machinery is gone, `datalog_query` has a width cap, and no patch was added. `tools-manifest.json` carries the names, paths and annotations of the two tools, as predicted, so only the generated OpenAPI text, `QUERIES_HELP` and README changed. Section 11's questions were not answered during the build, so each default stands (`plan` carries no Datalog, no `client` param, the `/` title fixed in this PR). The differences are below.

- **The bounds are lower than section 3.2 proposed.** The bench in the release bundle measured a counted read at about 4 us warm (3.6 to 4.8 us by query), not 0.5 to 1 us, so the provisional 100,000-read backstop allowed 360 to 480 ms per call, and `meetings-without-decision` on a 20,000-page graph took 801 ms unbounded. The defaults (`default-bounds`) are `meetings` 2,000, `decisions` 10,000, `ancestor-steps` 10,000, `tagged` 2,500, `page-blocks` 10,000, `tasks` 10,000, `open-tasks` 2,000 and `reads` 30,000, which is about 90 to 120 ms of counted reads. Each candidate bound sits where its query's usual reads per candidate reach about the same work, so the bound that names what to narrow fires before the backstop. The release fixture (2,400 tagged pages, 300 meetings, 400 tasks) sits under every bound. Section 5's expectation that 20,000 blocks fit in 100 ms held for the four queries on that fixture: 15 to 109 ms warm (`pages-missing-property` was the slowest, at about 108 ms, with 28,409 reads), inside the 300 ms the release check asserts, but a little over the 100 ms target for that one query. These timings are from a developer machine, not the Durable Object on Cloudflare (README backlog 24).
- **The width cap is 100,000 values and a query may have at most 12 function bindings.** The provisional 100,000 refused nothing early enough: the F1 shapes took 142 to 232 ms in the dev build, so the cap was lowered to 50,000 and then 40,000 (F1 median 70 to 79 ms in the release bundle). Review round 1 then found that a single cap also refused realistic per-row queries (6 `get-else` or `get-some` columns over 1,500 blocks charge 49,500). Patch 0039 now counts function-binding clauses at any depth (inside `not`, `not-join`, `or`, `or-join` and `and`; predicates excluded) and refuses a query of more than 12 with a 422 naming the width cap before anything runs, the private set included. That stops the F1 shapes (176, 100 and 21 bindings) in 2 to 13 ms in the release bundle. With them handled, the width cap was raised back to 100,000, so 6 columns over 1,500 or 2,000 blocks and 8 over 1,500 answer 200, and 12 bindings over 1,200 blocks still stop at the running charge. Both 422s say to fetch extra columns with `(pull ?b [...])`, which runs only on the kept rows. The test field is `datalogWidthCap`, as designed.
- **The `/` and `#` title refusal is built, with a restore exception.** `createPage` runs the outliner's own `validate-page-title-characters` on the title as it would store it, before any write, and answers 400 naming the character and the title (section 3.8 expected a 400 for `/`; `#` is the same validator and the same 500, so it is refused the same way). A page in the Recycle bin is not a title holder, so the first version refused a restore of a recycled page whose title holds `/`. The check now looks the title up as the outliner does (`ldb/page-exists?` on the sanitised title with the Page tag) and, for a recycled page, checks only `#`, so `createPage` restores it under its own title with 201. E2EE titles are ciphertext and are not checked.
- **The scan-cap `console.error` nit needed no fix.** As the spec expected, it did not reproduce on the release bundle. `release-query-check.mjs` still gains the check that a scan-cap 422 logs nothing to `console.error`, `warn`, `log` or `info`.
- **The bench and the release check are bigger than section 8 listed.** `release-query-check.mjs` seeds about 20,000 blocks through `SyncDO.fetch` (the API cannot backdate, so the dev build transacts the 50 stale projects into the stored graph before the bundle loads it), asserts each query's exact rows within 300 ms, each F1 shape's width-cap 422 within 100 ms (median of three warm runs) and the quiet scan-cap 422. `bench-datalog-query.mjs` gains `--named`/`--bounds` and `--width`/`--width-cap` modes. A rule-cap shape in the bench was filed as the scan cap until `runShape` was taught to name the rule cap, and then the rule cap was removed with the rule machinery.
- **Dry run answers `{name, params, plan, bounds, dry-run}`** and reads nothing. The response carries `plan` and `work` in place of `query`, `inputs` and `rules`, as designed. Parity with the old Datalog (kept in the test namespace as `legacy-named-queries`) holds on the existing fixtures, every property kind and 30 seeded graphs, and `private?` was checked against `private-ids` on every entity of those graphs.
- **README backlog 24 is replaced.** The scan of every block's `:block/page` it described is gone. The entry now records that the bounds are tuned on a developer machine and that `open-tasks-by-client` has no param to narrow by.
