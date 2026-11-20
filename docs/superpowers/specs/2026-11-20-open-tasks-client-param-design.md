# A client param for open-tasks-by-client: design

Date: 2026-11-20
Issue: item 52 on the tracker ("A client param for open-tasks-by-client", Priority Low, labels enhancement and queries, found 2026-11-17 in the PR 52 review). Areas: patch, connector, docs. Tier: standard.
Branch: `feat/open-tasks-client-param`, at `f3d5413` ("docs(spec): changes-schema-health-checks"), stacked on `feat/changes-schema-health` (item 50, PR 73) and `feat/query-blocks` (item 49, PR 72). It is 0 commits behind `feat/changes-schema-health`.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0049. This work adds one patch, **0054** if built after items 49 and 50 (section 3.1 explains the numbering).
Builds on: patch 0039 (`named_queries.cljs`, `handler/datalog.cljs` `resolve-params`, the `runNamedQuery` route), patches 0021, 0026 and 0031 (`title-candidates`), patch 0046 (`shared-title-error`), the named-queries-as-code spec (`2026-11-17-named-queries-as-code-design.md`, open question 3), `docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`, `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/api/title-resolves-outside-allowed-values.md`, `docs/solutions/api/bare-page-ref-resolves-to-the-oldest-entity-by-name.md`, `docs/solutions/api/new-selector-form-needs-every-lookup-site.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md` and `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`.

The design panel chose the "minimal" proposal: resolve one client entity up front, then walk from that client (its holders and the blocks on its pages) instead of from every Task. No ideas were grafted from other proposals. Decisions marked **(call)** were made while writing this spec; the ones most worth a second look are in section 11.

**What was checked for this spec, at `f3d5413`.** This is an enhancement, not a bug, so there is no cause to reproduce. Two facts the design rests on were checked by running code, not only by reading it. A throwaway `deftest` (`zz-client-param-repro-test`, appended to `semantic_datalog_query_test.cljs` in `.upstream`, run with `scripts/upstream-test.sh .upstream semantic-datalog-query`, then removed and the file restored) used the existing `with-named` fixture, which writes everything through the real handler. Its output:

```
REPRO client param 400 {:error "params.client: not a param of open-tasks-by-client (params: client_property)"}
REPRO prop :user.property/forClient-MF0n_A2R valueType :db.type/ref index true rschema-index? true
REPRO avet holders of zq Acme ["zq Fresh Project" "zq Client Work"] aevt count 2
REPRO titles zq Acme 1 name zq acme 1
Ran 100 tests containing 2194 assertions.
0 failures, 0 errors.
```

So, on HEAD:

1. A `client` param is refused today with 400 `params.client: not a param of open-tasks-by-client (params: client_property)`. A caller who guesses the param gets a clear refusal, never all clients. This is the failure the first new test quotes.
2. A node property created through `POST /semantic/properties` is a ref attribute with `:db/index true`, and the `:avet` index on it returns exactly the holders the `:aevt` scan finds (2 and 2). Upstream's `build-new-property` (`deps/db/src/logseq/db/sqlite/util.cljs`) sets `:db/index true` on every new property, and Datascript indexes every `:db.type/ref` attribute in `:avet` whatever `:db/index` says (`datascript/db.cljc` line 877, `:db.type/ref [:db.type/ref :db/index]`). So an `:avet` read of a ref property's holders is sound on graphs made by the API and, from that Datascript rule, on graphs uploaded from the app. The upload-path case was read from source, **not run**; section 8 test 5 runs it.

Everything else in section 2 was read from `patches/0039-semantic-datalog-query.patch`, `patches/0021-semantic-choice-values-scoped-to-property.patch`, `patches/0046-semantic-tags-title-shared-class-refused.patch`, `connector/src/tools/handwritten.ts`, `connector/src/tools/semantic.ts` and `README.md`, not run.

## 1. Goal

Let `run_named_query` list one client's open tasks, so `open-tasks-by-client` can be narrowed on a large graph, and its 422 can say "give a client" instead of only "close tasks or use `datalog_query`".

Acceptance (the brief):

1. With `client` set, only that client's open tasks come back, within the same bounds (`tasks`, `open-tasks`, `reads`) and the same scan and width caps.
2. The tool text, `connector_help` (`QUERIES_HELP`) and README §11.8 say so, and the open-tasks refusal advises giving a client.
3. An unknown client, or a title that several entities share (a class and a page, or several pages), is refused up front in the style of patches 0036 and 0046 (`title-candidates`), naming the candidates, and never silently widens to all clients.

## 2. Context: what already exists

**`open-tasks-by-client`** (patch 0039, `named_queries.cljs`). One param, `client_property` (type `:property`, default `forClient`, allowed types default, url, date, node, asset, entity, class, page, property). It reads every entity tagged `:logseq.class/Task` through `:avet :block/tags`, charging each to `:tasks` (10,000). For each one whose status isn't Done or Canceled and that isn't private, it charges `:open-tasks` (2,000) and takes the task's own visible `client_property` values, else its page's, else `""`. Rows are `[client-title task]`, de-duplicated, sorted by client title. Every datom read goes through `datoms*` or `first-value*` and counts toward `:reads` (30,000).

**Its refusals** (`stops` table): `:tasks` says "list one client's tasks with datalog_query"; `:open-tasks` says "mark finished tasks Done or Canceled, or list one client's tasks with datalog_query"; `:reads` says "list one client's tasks with datalog_query". None can say "give a client", because there is no such param. README backlog 24 records this.

**`resolve-params`** (`handler/datalog.cljs`). A `for` over the entry's params; each type has its own resolver (`:tag`, `:property`, `:days`) that returns `{:input :echo}` or `{:error "params.<name>: …"}`. Resolvers do not see one another's results. Unknown params are refused (repro line 1). dry-run resolves params and returns `{name, params, plan, bounds, dry-run}` without reading.

**Title resolution elsewhere.** `title-candidates` (patch 0021, extended by 0026 and 0031) resolves a ref property value by exact `:avet :block/title`, else by `:avet :block/name` (lower case). It drops other properties' choices and value blocks and hidden entities, then ranks pages over blocks and user entities over built-ins. Patch 0046's `shared-title-error` words the refusal: `"Acme" matches 2 entities (uuid, uuid); give the one you mean by UUID`.

**Connector.** `run_named_query` is hand-written (`handwritten.ts`) and passes `params` through. Its audit row (`semantic.ts` line 312) records `named:<name>` and `param:<name>` for each param name, so `param:client` appears with no code change. `QUERIES_HELP` and the vendored OpenAPI description carry the contract text.

## 3. Design

### 3.1 Shape and numbering

One new patch, `NNNN-semantic-open-tasks-client-param.patch`, changing three files patch 0039 added or touched: `named_queries.cljs`, `handler/datalog.cljs` and `routes/semantic.cljs`, plus the 0039 test namespace (`semantic_datalog_query_test.cljs`).

**Numbering (call).** On this branch `patches/` ends at 0049. Item 49 (PR 72) plans 0050 and item 50 (PR 73) plans 0051 to 0053, so this is **0054** if built after both. If built alone it is 0050; if item 49 is dropped it is 0053. Renumber before merge so `scripts/fetch-upstream.sh` applies in order. Item 50's patches touch `graph_insights.cljs` and `handler/semantic.cljs`, not `named_queries.cljs`, so no hunk conflict is expected; this is to be confirmed when rebasing.

### 3.2 Resolving the client (`handler/datalog.cljs`)

Add a param type `:client` with no default, declared after `client_property`:

```
:params [{:name "client_property" :type :property :default "forClient" :types #{…}}
         {:name "client" :type :client :of "client_property"}]
```

`resolve-params` becomes a `reduce` that passes the inputs resolved so far, so the client resolver can see `client_property`'s ident and type. Absent `client` resolves to no input and no echo, and the walk is the one that runs today.

The client resolver refuses, each message naming `params.client`, and never falls back to all clients:

- **Not a string, empty, or null:** `params.client: must be a client title or UUID (a string)`. A JSON `null` is "given", not "absent" (`an-optional-narrowing-argument-must-refuse-not-widen.md`).
- **A text client property:** when `client_property` resolved to a `:default` or `:url` property, `params.client: forClient is a default property, whose values are per-block text; give client_property as a node or date property, or list one client's tasks with datalog_query`. A default property's values are value blocks, one per holder, so no single entity stands for the client. **(call)**: this keeps the change small; section 11 asks whether text clients are needed.
- **A UUID:** it must name an entity that isn't hidden, private or in the Recycle bin (`private-fn`, as the walk uses). Otherwise `params.client: no client with UUID <uuid>`. A private entity reads as unknown, so its existence is not disclosed.
- **A title:** candidates are the entities whose `:block/title` is exactly the value (`:avet`), else whose `:block/name` is the lower-cased value, the lookup order `title-candidates` uses. Dropped: hidden entities, other properties' choices and value blocks (as `title-candidates` drops them), and private or recycled entities, so a private title is never named.
  - None: `params.client: no page, tag or block titled "X"`.
  - One: that entity.
  - Two or more: refused with no ranking **(call)**, unlike `title-candidates`, which prefers pages and user entities. A ranking that picks the wrong client returns the wrong client's tasks with a 200, which is the silent narrowing this issue must not add. Wording follows 0046, with each candidate's kind so the caller can choose: `params.client: "Acme" matches 2 entities (Acme: page 6650…, Acme: tag 6651…); give the one you mean by UUID`, oldest first.

The resolved input is the client's eid. The echo is `params.client {title, uuid}`, so the caller sees which entity was used. dry-run therefore shows the resolved client, the plan and the bounds, and reads nothing.

Resolution reads are uncounted, as the tag and property resolvers' are: a few `:avet` datoms and a privacy walk per candidate, typically under 20.

### 3.3 Walking from the client (`named_queries.cljs`)

With the current Task scan plus a filter, a graph with more than 10,000 Task blocks would still stop at `:tasks` whatever client is given, so "give a client" would be bad advice. With `client` (eid `c`) present, the walk starts from the client instead:

1. **Holders:** `datoms* :avet client_property c`, the blocks and pages that hold `c` as a value (repro line 3 shows this read works).
2. **Blocks on client pages:** for each holder that is a page (no `:block/page`), its blocks through `datoms* :avet :block/page p`.
3. Each candidate from 1 and 2, de-duplicated, is charged to `:tasks`. It is kept when:
   - it is tagged Task (an `:eavt` read of `:block/tags` for `:logseq.class/Task`, Task only, as now);
   - its status is not Done or Canceled, and it is not private (then charged to `:open-tasks`);
   - its effective clients include `c`: its own visible values, else its page's, exactly as now. A task with its own client B on a page whose client is `c` is excluded, as in the full listing.
4. Rows stay `[client-title task]` with `c`'s title, under the same `:reads` backstop, scan and width caps, sort, limit and byte cap.

A holder that is a block does not pass its client to its child blocks, because the full listing doesn't either (only the page does). So the client run's rows equal the full run's rows filtered to `c` (the parity test in section 8).

Without `client`, the code path is unchanged.

### 3.4 Refusals and plan text

- **Without a client**, the `stops` advice for `:tasks`, `:open-tasks` and `:reads` becomes "give a client (params.client), or mark finished tasks Done or Canceled". The `datalog_query` advice stays only where a client can't be given: a text `client_property`.
- **With a client**, `bump!`'s ex-data carries `:client` (the title) from ctx, and `bound-message` says what was counted: `open-tasks-by-client stopped after 10,000 blocks holding zq Acme or on its pages (its tasks bound); mark zq Acme's finished tasks Done or Canceled, or list one of its pages' tasks with datalog_query`. The `:tasks` bound counts candidate blocks here, not Task blocks, and the text must say which, or the caller misreads the advice.
- **`plan-text`** gets a client branch: "1. Read the blocks and pages whose forClient is zq Acme, and the blocks on each such page, each counted (tasks bound 10,000). 2. Keep those tagged Task whose status isn't Done or Canceled and that aren't private, each counted (open-tasks bound 2,000). 3. Keep each whose own forClient values, else its page's, include zq Acme. 4. One row per task." plus the existing reads sentence.

### 3.5 Contract text

- **OpenAPI** (`routes/semantic.cljs`): the `runNamedQuery` description's `open-tasks-by-client` sentence gains `client` and the new advice; the 400 description already covers "a param that doesn't resolve"; the 422 description names the client form.
- **Connector:** `QUERIES_HELP` in `handwritten.ts`; the vendored `openapi.json` regenerated; `tools-manifest.json` via `npm --prefix connector run update:manifest` (its text hash changes, the shape doesn't). No connector code changes.
- **README:** §11.8 named queries (line 880), the refusal table row for `run_named_query` 422 (line 946), and backlog 24: remove only the `client` half. The "bounds tuned on a developer machine" half stays.
- **Logseq skill note** (PR body): "To list one client's open tasks, call `run_named_query` `open-tasks-by-client` with `params.client` set to the client's title or UUID. A 400 saying the title matches several entities lists them; retry with the UUID you mean. A 422 without a client now says to give one."

## 4. Tool contract

**CHANGED `run_named_query`, name `open-tasks-by-client`.** Shape unchanged; `params` gains optional `client` (string: a title or UUID; no default).

- **Success:** columns are still `[client, task]`. Only rows whose effective client (the task's own `client_property` values, else its page's) is the resolved entity come back. `params.client` echoes `{title, uuid}`.
- **dry-run:** returns `params` (client resolved), a `plan` naming the client, and `bounds`, with nothing read.
- **400**, each naming `params.client`: a non-string, empty or null client; an unknown title or UUID (private and recycled entities count as unknown); a title several visible entities share (each candidate with kind and UUID, oldest first, ending "give the one you mean by UUID"); a `client_property` that is a default or url property.
- **422:** without a client, the advice says to give one. With a client, it names what the bound counted (blocks holding the client or on its pages) and how to narrow further.

**Unchanged:** the other three named queries, `datalog_query`, every other tool.

## 5. Cost on the Free plan

**Account counters, per call:** no change. One connector Worker request and one sync DO request, as now. D1: the connector's existing one audit row per logged read (param names only), no new reads. No Workers AI neurons, no Vectorize. **Per day:** the same request count; narrowing should cut retries after a 422.

**Front Worker CPU (10 ms):** forwarding only, unchanged.

**Durable Object CPU per request.**

- Client resolution: a few `:avet` datoms and a privacy walk per candidate, typically under 20 reads, uncounted like the existing resolvers.
- The client walk reads at most each holder of the client, each block on the client's pages, and about 10 to 17 reads per open task (0039's figure). It stays capped by `:tasks` 10,000, `:open-tasks` 2,000 and `:reads` 30,000. 0039's bench measured each query stopping at the 30,000-read backstop after 90 to 120 ms on the release bundle, so this run is at worst the same, and usually far less than the full Task scan it replaces.
- CPU is bounded by counts, never the clock. Per `per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `scripts/bench-datalog-query.mjs --named` gains client runs at the cap: a client on one page with more than 10,000 blocks (stops on `:tasks`) and a client held by many tasks (stops on `:reads` or `:open-tasks`). The PR records both times and checks they stay at or under 0039's figures.

## 6. Safety

- **Read-only.** No write, no order key, no migration.
- **Refuse, don't widen.** A given but unusable `client` (wrong type, null, empty, unknown, shared, text property) answers 400 naming `params.client`, and each refusal test asserts no rows came back.
- **No silent narrowing.** A shared title is refused, never ranked, so a 200 always means the client the echo names.
- **Private content.** Private and recycled entities are not candidates, are not named in an ambiguity message, and resolve as unknown by UUID. The walk keeps 0039's `private?` check per task and `visible-values` per client.
- **E2EE.** 409 before any param resolves, as now.
- **The owner's graph.** Never written. Tests use fixtures; no graph name or page UUID appears in any file.

## 7. Risks

1. **AVET on a ref property.** If an attribute were not indexed, `:avet client_property c` would return nothing and the query would silently return zero rows. The repro shows the API path is indexed, and Datascript indexes every ref attribute; the upload-path test (section 8, test 5) confirms it on an app-made graph. If it fails there, the design must refuse or read `:aevt`, never return empty rows.
2. **What `:tasks` counts changes under a client.** Candidate blocks, not Task blocks. The 422 and plan text say which (3.4).
3. **Text client properties are excluded.** Owners with `forClient` as text get a 400 naming why and the `datalog_query` fallback. This is narrower than the issue's wording (section 11, question 1).
4. **Private decoys.** The ambiguity message must not leak a private entity's title or UUID; a test has a private decoy with the same title.
5. **A big client page.** A page with many blocks can exhaust `:tasks` with few real tasks. The refusal then advises `datalog_query` per page, which is honest but not a further narrowing.
6. **Release build renames.** The new `:client` branch and ex-data keys must run in `scripts/release-query-check.mjs`, since the dev build can't show Closure advanced-compilation breakage.
7. **Patch numbering.** 0054 assumes PRs 72 and 73 land first (3.1).
8. **Parity reference.** The 0039 test keeps the old Datalog as a parity reference; it must gain the client form, or the parity tests stop covering the client path.

## 8. Testing

Tests are written first and seen to fail on HEAD; the first failure is the repro's `params.client: not a param of open-tasks-by-client (params: client_property)`, quoted in the PR. They run in upstream's db-sync suite, with fixtures written through the real semantic handler (`with-named`), via `scripts/upstream-test.sh .upstream semantic-datalog-query` while building and `scripts/check.sh --upstream` as the gate.

1. **Narrowing.** On the existing fixture (zq Acme on the page zq Client Work, zq Beta on a task, a task with no client, Done and Canceled tasks): client `"zq Acme"` returns only `["zq Acme" "zq task page client"]`; `"zq Beta"` by title and by UUID returns only its own task; the task whose own client is zq Beta, on zq Acme's page, is not in zq Acme's rows. **Parity:** for each client, the client run's rows equal the full run's rows filtered to that client's title, and equal the 0039 Datalog reference with the client bound.
2. **Refusals**, each a 400 naming `params.client`, each asserting no rows:
   - a class `zq Acme` alongside the page `zq Acme`, listing both UUIDs with kinds;
   - two pages that match only by `:block/name` (a title given in a case neither has exactly), and a namespace child sharing its title with another page;
   - an unknown title, an unknown UUID, an empty string, `null` and a number;
   - a private decoy with the same title is neither listed nor counted, and a private client by UUID reads as "no client";
   - a recycled client;
   - `client` with a default-type `client_property`.
3. **Bounds**, lowered through the test caps: a graph with more Task blocks than the tasks bound refuses without a client, with advice containing "give a client"; the same graph succeeds with a client; with a client, a page with more blocks than the bound refuses with the client text; the `:open-tasks` and `:reads` refusals carry their advice; `work` counts equal the expected candidate counts.
4. **dry-run** echoes `params.client {title, uuid}` and a plan naming it, with `work` empty.
5. **Upload path.** The AVET holder read and test 1 on a graph uploaded from the app (`semantic_uploaded_graph_schema_test` style, `uploaded-graph-keeps-the-apps-schema-drift.md`).
6. **Release build.** A client case in `scripts/release-query-check.mjs`, and `--named` client runs at the cap in `bench-datalog-query.mjs` (each with its `.test.mjs` checking shape, not time).
7. **Connector** (`connector/test/tools.test.ts`): the `run_named_query` description and `QUERIES_HELP` mention `params.client`; a 400 body passes through verbatim; the audit row shows `param:client`. Then `update:manifest` and the tools-manifest check.

Run `scripts/check.sh --upstream` on the final commit, name that commit in the PR, and repeat what it skipped.

## 9. Rollout and verification

1. Merge to main deploys the sync server and the connector. No migration, no switch.
2. After deploy, the owner runs `run_named_query` `open-tasks-by-client` with `dry-run: true` and `params.client` set to one client, and checks the echo names the right entity.
3. The owner runs it without dry-run and compares the rows with the full listing filtered to that client.
4. The owner applies the skill note.
5. Record the bench figures under an As built section of this spec.

## 10. Out of scope

- Text (default or url) client properties as a `client` target (section 11, question 1).
- Several clients in one call, or a client prefix or search.
- Inheriting a client from a parent block (the full listing doesn't either).
- Changing the bounds or the other three named queries.
- Ranking shared titles (refused instead).
- Writing to the owner's Logseq skill (the PR supplies the note).

## 11. Open questions for the owner

1. **Text clients.** `client` is refused when `client_property` is a default or url property. Is `forClient` a node property on your graph, or do you need text clients matched by value text (a value-block title scan, which costs a full read of that property's values)?
2. **Shared titles refused, not ranked.** A title that a page and a tag share is refused with both UUIDs, unlike property writes, which prefer the page. Is a retry by UUID acceptable, or should a page win when exactly one candidate is a page?
3. **Inherited clients.** A task matches when its own client, else its page's, is the client, as the full listing does. Should a task under a block that holds the client also match? That would change the full listing too.
4. **Case-only matches.** Lookup is exact title first, then page name ignoring case, as `title-candidates` does; so `Acme` picks the page titled exactly `Acme` even when a page `acme` exists. Keep that, or refuse whenever the case-insensitive name matches more than one?
5. **Patch number.** 0054 assumes PRs 72 and 73 merge first; 0050 if built alone, 0053 if item 49 is dropped.
