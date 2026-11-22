# A client param for open-tasks-by-client: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in every stage that changes `patches/`, plain `scripts/check.sh` otherwise), and is one commit, pushed straight after. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run_named_query` `open-tasks-by-client` takes an optional `params.client` (a title or UUID) and lists only that client's open tasks, walking from the client rather than scanning every Task, so a large graph can be narrowed and the 422 can say "give a client". A given but unusable client answers 400 naming `params.client` and never widens to all clients.

**Architecture:**
- **One new patch, 0054.** `patches/0054-semantic-open-tasks-client-param.patch`, built on a baseline of patches 0001 to 0049 (all of `patches/` on this branch). It changes `worker/named_queries.cljs`, `worker/handler/datalog.cljs`, `worker/routes/semantic.cljs` and `test/logseq/db_sync/semantic_datalog_query_test.cljs` (plus, in Stage 2, `semantic_uploaded_graph_schema_test.cljs`). 0050 to 0053 are left for items 49 and 50 (PRs 72 and 73), so `scripts/fetch-upstream.sh` sees a gap in the numbers until they land; it applies `patches/*.patch` in glob order, so the gap is harmless. Renumber at merge if they land differently (spec §3.1, §12 answer 5). No migration, no stored state, no connector code.
- **Stage 1, resolve the client:** the `:client` param type, `resolve-params` as a `reduce`, every 400, the page-wins rule, the `{title, uuid}` echo and dry-run's echo. The run keeps today's Task scan and filters its rows to the client, so a client run is already correct (equal to the full run filtered) and never widens; only its cost and its 422 wording are still the full scan's. The `runNamedQuery` text names the param and its 400s, and the connector's help says so.
- **Stage 2, walk from the client:** with a client, the walk reads the client's holders and the blocks on its pages instead of every Task, charges candidates to `:tasks`, and `bound-message` and `plan-text` say what was counted. The upload-path test proves the `:avet` holder read on an app-made graph.
- **Stage 3, the advice without a client:** the `stops` advice for `:tasks`, `:open-tasks` and `:reads` says to give a client (params.client), except where a client can't be given (a default or url `client_property`), and the contract text follows.
- **Stage 4, the release bundle and the bench:** a client case in `scripts/release-query-check.mjs`, and `--named` client runs at the cap in `scripts/bench-datalog-query.mjs`, each with its `.test.mjs`.
- **Order:** resolution first, because every later stage relies on the client being exactly the entity the echo names; then the walk, which is the point and carries the main risk (an unindexed attribute returning zero rows); then the advice, which only makes sense once a client can actually narrow the walk; then the release and CPU proof, which needs all of the code.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`; the real `sync-handler/handle-http` on a `create_graph` conn, through the `with-named`, `named!`, `request!`, `insert!`, `set-tags!` and `bulk!` helpers already in `semantic_datalog_query_test.cljs`, and the upload helpers in `semantic_uploaded_graph_schema_test.cljs`); Datascript (Logseq's fork); the release bundle under Node through `loadReleaseSyncDO` in `scripts/release-query-check.mjs`; the TypeScript connector with vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-open-tasks-client-param-design.md`. Read it first; it is the authority, and section numbers below (§3.2 and so on) are its own. **Section 12 overrides the body where they differ:** a shared title is refused *unless exactly one candidate is a page*, in which case that page wins (this replaces §3.2's "refused with no ranking" and changes §8 test 2's class-plus-page case into a success); text clients stay refused; tasks match their own client, else their page's; exact title first, then page name ignoring case; patch 0054. README, the As built notes and the learning doc are the lane's docs step, after the stages.

## Global constraints

- **Names, exactly:**
  - in `worker/handler/datalog.cljs`: the param type `:client`, declared on `open-tasks-by-client` as `{:name "client" :type :client :of "client_property"}` after `client_property`; `resolve-client-param` (db, the resolved `client_property` input and its property type, param, value → `{:input eid :echo {:title :uuid}}`, `{:absent true}` or `{:error …}`); `client-candidates` (db, title, private? → the visible entities a title names); `resolve-params` as a `reduce` whose accumulator holds the inputs resolved so far by param name. An absent `client` gives no input key and no echo key, so the full run and its echo are byte-for-byte today's.
  - in `worker/named_queries.cljs`: `open-tasks-by-client` reads `:client` (an eid or nil) from its inputs; Stage 2 adds `client-candidates*` (the counted walk: holders, then blocks on holder pages, de-duplicated) beside it; ctx gains `:client-title` for `bump!`/`charge!`'s ex-data as `:client`; `stops` gains a `:client` entry per bound for `open-tasks-by-client`; `plan-text` gains a client branch.
  - response keys unchanged; `params` gains `client` `{title, uuid}` only when given.
- **Messages, in the spec's wording (§3.2, §3.4), each naming `params.client`:**
  - `params.client: must be a client title or UUID (a string)` (null, empty, number, any non-string);
  - `params.client: no client with UUID <uuid>` (unknown, hidden, private or recycled);
  - `params.client: no page, tag or block titled "<title>"` (no visible candidate);
  - `params.client: "<title>" matches <n> entities (<title>: <kind> <uuid>, …); give the one you mean by UUID`, oldest (`:db/id`) first, kinds `page`, `tag`, `property` or `block`; only when there is no page candidate or more than one;
  - `params.client: <property> is a <default|url> property, whose values are per-block text; give client_property as a node or date property, or list one client's tasks with datalog_query`;
  - Stage 2, with a client: `open-tasks-by-client stopped after <n> blocks holding <title> or on its pages (its tasks bound); mark <title>'s finished tasks Done or Canceled, or list one of its pages' tasks with datalog_query`, and the same form for `:open-tasks` (`found more than <n> open tasks of <title> (its open-tasks bound)`) and `:reads`;
  - Stage 3, without a client: the advice for `:tasks`, `:open-tasks` and `:reads` is `give a client (params.client), or mark finished tasks Done or Canceled`.
- **Refuse, don't widen** (`docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`). `{"client": null}` is given, not absent: the resolver checks `contains?`, not the value. Every refusal test asserts the status, the exact message and that the body has no `rows`.
- **Private stays private.** Private, hidden and recycled entities are never candidates, never named in an ambiguity message and never counted toward it; a private client by UUID reads exactly like an unknown UUID. Use the request's `private-fn` from `named_queries.cljs` (one per request), not a fresh `private-ids` set.
- **Choices and value blocks are not clients.** Drop an entity with `:block/closed-value-property` and one with `:logseq.property/created-from-property`, as `title-candidates` drops another property's (`docs/solutions/api/title-resolves-outside-allowed-values.md`). `title-candidates` is private to `handler/semantic.cljs`, so the client lookup is its own function in `datalog.cljs` with the same lookup order; do not export or change `title-candidates`.
- **No clock, bounded by counts.** No new `Date.now`. Resolution reads are uncounted, as the tag and property resolvers' are; the walk charges every read through `datoms*` and `first-value*`.
- **Read-only by construction.** The run takes `@conn`. The existing `named-read-only` check (max-tx and datom count) runs on the client form too.
- **Free plan** (spec §5): per call 2 Worker requests, about 1 D1 row read (graph token), 2 D1 rows written (audit row and its index entry), 0 neurons, 0 Vectorize, unchanged. Each commit body states it, with the Durable Object CPU the stage's tests or bench measured.
- **Tests run the real thing.** Through `handle-http` on a graph built by real semantic writes; no stubbed Datascript or filter. Each new test is first seen to fail on the stage's starting tree; keep the failure text for the PR (Stage 1's first is `params.client: not a param of open-tasks-by-client (params: client_property)`). Where a test cannot fail first (a guard), say so in the commit body. Example data only (`forClient`, `zq …` titles, `sync.example.com`, alias `test`).
- **Contract with Claude.** OpenAPI text changes in the stage whose behaviour it describes; that stage re-vendors (`scripts/vendor-upstream-api.sh .upstream`), updates `QUERIES_HELP` and its checks in `connector/test/tools.test.ts`, and runs `npm --prefix connector run update:manifest` (names and shapes are unchanged, so expect at most a text hash change; say which in the commit body).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `scripts`), with a body giving the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

  Push after every commit (`git push`), as the brief asks.
- **Never** read or write the owner's Logseq graph, and never commit its name, page names, UUIDs, ident suffixes, hostnames or tokens.

### Working on patch 0054

Follow the `add-upstream-patch` skill. 0054 is the last patch, so the baseline is every patch on the branch. The `.upstream` checkout predates patches 0040 to 0049, so rebuild it once, before Stage 1:

```bash
SCRATCH=<the session's scratchpad>
rm -rf .upstream && scripts/fetch-upstream.sh .upstream           # patches 0001-0049
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0049"
git -C .upstream tag -f baseline
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                           # the vendor matches the branch's patches
scripts/check.sh --upstream                                         # green on the starting tree
```

At the end of each stage that changes the patch:

```bash
scripts/build.sh .upstream                                          # dev test build and the release bundle
scripts/upstream-test.sh .upstream 'semantic-datalog-query|semantic-uploaded-graph|semantic-private-tags'
git -C .upstream add -A
git -C .upstream diff --cached baseline > patches/0054-semantic-open-tasks-client-param.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all patches, 0054 last, apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream                                         # upstream suite and release-query-check.mjs
```

To see an upstream test fail first, write it, stash the source change (`git -C .upstream stash push -- deps/db-sync/src`), rebuild, run, and pop. If a `scripts/upstream-test.sh` watch is running, stop it (`--stop`) after any `scripts/build.sh` and start it again (CLAUDE.md gotcha on `pnpm clean`). The release check reads the bundle as `scripts/build.sh` last built it, so rebuild before quoting its output.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost (Workers Free plan)* and *Contract and docs*.
- `docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`, `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/api/title-resolves-outside-allowed-values.md`, `docs/solutions/api/new-selector-form-needs-every-lookup-site.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`. (The spec also cites `docs/solutions/api/bare-page-ref-resolves-to-the-oldest-entity-by-name.md`, which is not on this branch; its point, never pick one of several same-named entities silently, is carried by the constraints above.)
- `worker/named_queries.cljs`: `default-bounds` (`:tasks` 10,000, `:open-tasks` 2,000, `:reads` 30,000), `charge!`, `datoms*`, `first-value*`, `private-fn`, `visible-values`, `open-tasks-by-client`, `stops`, `bound-message`, `plan-text`, the registry entry and `run-named`.
- `worker/handler/datalog.cljs`: `resolve-tag-param`, `resolve-property-param`, `resolve-days-param`, `resolve-params`, `handle-named-query` and its dry run. `worker/handler/semantic.cljs`: `title-candidates` and `resolve-ref-entity` (lookup order and the 0046 wording). `worker/routes/semantic.cljs`: `runNamedQuery`.
- Tests: `semantic_datalog_query_test.cljs` from `legacy-named-queries` (about `:1981`), `with-named`, `named-open-tasks-by-client-test`, `named-params-refusals-test`, `named-client-property-kinds-test`, `named-client-from-text-property-test`, `named-client-many-test`, `named-dry-run-test`, `named-bounds-field-test`, `named-parity-test`, `named-review-focus-test`; `semantic_uploaded_graph_schema_test.cljs`.
- `scripts/release-query-check.mjs` (the `open-tasks-by-client` check, about `:496`) and `scripts/bench-datalog-query.mjs` (`NAMED_QUERIES`, `namedInputs`, the `--named` mode) with their `.test.mjs`.
- Connector: `QUERIES_HELP` in `connector/src/tools/handwritten.ts` and the `run_named_query` blocks of `connector/test/tools.test.ts` (about `:1318` to `:1400` and `:2700` to `:2720`).

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **`{"client": null}`, `""`, `"   "`, `0` and `["zq Acme"]`:** each a 400 with the type message, no rows (Stage 1). Whitespace-only is a title with no candidate, so it answers "no page, tag or block titled" (Stage 1).
2. **A UUID string in another case (`6650…` upper-cased):** resolves as the UUID does (Stage 1); a malformed UUID-like string falls through to the title lookup and answers "no … titled" (Stage 1).
3. **A page and a tag sharing the title:** the page wins (§12 answer 2), and the echo's `uuid` is the page's. **Two pages by `:block/name` only** (`Zq Acme` and `ZQ ACME`, given as `zq acme`): refused, both named. **A tag and a block sharing it, no page:** refused, both named (Stage 1).
4. **An exact-title match and a case-only page match** (`zq Acme` exact on a block, `ZQ ACME` a page): the exact match is the only candidate tier, so the block wins alone and the page is not considered (§12 answer 4) (Stage 1).
5. **A private page and a public tag sharing the title:** the tag is the single candidate and wins; the message for an unknown client never names the private page (Stage 1).
6. **A choice of `forClient` or a value block titled like the client:** never a candidate (Stage 1).
7. **The client property's ident or `:db/ident` keyword given as `client`:** a title lookup, not an ident lookup; no candidate unless something carries that title (Stage 1).
8. **A task holding the client itself and also on the client's page:** one row, charged to `:tasks` once (the candidate set is de-duplicated) (Stage 2).
9. **A holder that is a block with Task-tagged children:** the children are not candidates (no inheritance, §12 answer 3); their rows appear only if their page holds the client (Stage 2).
10. **A task with two clients, one of them the target:** one row under the target's title only, not under the other client (Stage 2, parity).
11. **The client is itself a Task block** (a task used as a client): its holders are candidates; it is a row only if it is an open task whose own or page client is itself (Stage 2).
12. **A client with no holders:** 200 with no rows and `work` `:tasks` 0 (Stage 2).
13. **The tasks bound reached exactly, and one more, with a client:** at the bound 200; one more the client-worded 422 (Stage 2).
14. **`client` with a `date` `client_property`:** resolves a journal page by title and walks it (Stage 2), as a node property does.
15. **A text `client_property` and no client:** the 422 advice still points to `datalog_query`, not to `params.client` (Stage 3).

---

### Stage 1: Patch 0054, resolve `params.client`

**Goal:** `open-tasks-by-client` accepts `client` and answers only that client's open tasks, or a 400 naming `params.client`. The run still scans every Task and filters to the client's rows, so the rows are already right; the walk changes in Stage 2. Lands spec §3.2 (with §12 answers 1, 2 and 4), §4 (success, dry-run echo and every 400), §6 (*Refuse, don't widen*, *Private content*), §7 risk 4, §8 tests 1, 2, 4 (the echo half) and 7, and acceptance 1 (rows), 3, 4, 5 (the echo) and 8 (the first failure).

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: the `:client` param on the registry entry's params (via `named_queries.cljs`); `client-candidates` and `resolve-client-param` as the constraints describe; `resolve-params` becomes a `reduce` over params that passes resolved inputs by name, so `:client` sees `client_property`'s ident and type; `:client` absent adds nothing. Dry run returns the echo.
- Modify (in `.upstream`): `worker/named_queries.cljs`: the registry entry's params gain `client`; `open-tasks-by-client` takes `:client` and, when present, keeps only rows whose client entity is it (compare entity ids, not titles, so two clients sharing a title stay apart); the namespace docstring names the param.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `runNamedQuery` description's `open-tasks-by-client` sentence names `client` (title or UUID; a page wins when exactly one candidate is a page; otherwise a shared title is refused) and the 400 description names the client refusals.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`; `legacy-named-queries` gains a client-bound form of the `open-tasks-by-client` Datalog (`:in $ ?client`, a `[?t ?prop ?client]` or page clause) for parity.
- Create: `patches/0054-semantic-open-tasks-client-param.patch`.
- Modify: `connector/vendor/openapi.json` and `connector/vendor/semantic_api_tools.mjs` (re-vendored), `QUERIES_HELP` in `connector/src/tools/handwritten.ts` (one sentence: "open-tasks-by-client takes params.client, a client's title or UUID, to list only that client's tasks; a title several entities share is refused naming each, unless exactly one is a page"), `connector/test/tools.test.ts`, `connector/tools-manifest.json` if its hash changes.

- [ ] **Step 1: Write the failing tests**, each through `handle-http`:
  - `named-client-narrowing-test` (spec §8 test 1): on the `with-named` fixture, client `"zq Acme"` returns only `["zq Acme" "zq task page client"]`; `"zq Beta"` by title and by UUID returns only its own task; the task whose own client is zq Beta on zq Acme's page is absent from zq Acme's rows. Its first failure on HEAD is the 400 `params.client: not a param of open-tasks-by-client (params: client_property)`; quote it.
  - `named-client-parity-test`: for every client on `with-named` and on the seeded graphs `named-parity-test` builds, the client run's rows equal the full run's rows filtered to that client's entity, and equal `legacy-named-queries`' client form run with `d/q` over the private-filtered db with the client bound.
  - `named-client-refusals-test` (spec §8 test 2 as changed by §12): each a 400 naming `params.client` with the exact message and no `rows`: `null`, `""`, a number, an array; an unknown title; an unknown UUID; two pages matching only by `:block/name`; a namespace child sharing its title with another page and no other page (both pages: refused); a tag and a block, no page; a private client by UUID (reads as "no client with UUID"); a recycled client page by UUID and by title; `client` with `client_property` a default property, and with a url property.
  - `named-client-page-wins-test`: a class `zq Acme` alongside the page `zq Acme` answers 200 with the page's tasks and the page's UUID in the echo; a private page decoy titled like a public tag leaves the tag as the single candidate and the private page is in no message (review focus 3 to 7).
  - `named-client-echo-test`: `params.client` is `{title, uuid}` of the resolved entity, and absent without a client (the full run's `params` is unchanged key for key); dry run echoes it with `work` empty (spec §8 test 4, echo half).
  - `named-client-read-only-test`: max-tx and datom count unchanged after each client run, answered and refused.
  - Connector (vitest): `QUERIES_HELP` and the vendored `run_named_query` description both mention `params.client`; a 400 body with `params.client: …` passes through verbatim; the audit row for a client call holds `param:client` (spec §8 test 7). Red until `QUERIES_HELP` changes.
- [ ] **Step 2: Run on the starting tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.2 with §12. `client-candidates`: exact `:avet :block/title`, else `:avet :block/name` of the lower-cased value; drop hidden, choice and value-block entities, then private and recycled ones (`private?` from `private-fn`). Then: none is "no … titled"; one wins; more than one with exactly one page (`nil` `:block/page`, not a class or property) gives the page; otherwise refuse, oldest first, each with its kind. A UUID string resolves by `[:block/uuid …]` and is "no client with UUID" when missing, hidden, private or recycled.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** treat `null` as absent; drop the `:block/name` fallback; check privacy before dropping choices (no visible change expected; confirm and say so) and drop the privacy check altogether; let the page win when two pages share the title; rank by user-over-built-in instead of refusing; compare rows by client title instead of eid; skip the text-property refusal. Confirm a test fails for each (except where noted) and revert.
- [ ] **Step 5: Commit and push.** `feat(api): a client param for open-tasks-by-client`. Body: the quoted first failure, each refusal message, the mutation results, that the walk is still the Task scan (Stage 2 changes it), the manifest change if any, and cost (unchanged per call; resolution is a handful of uncounted `:avet` reads).

**Done when:** every client case in §4 answers as specified, the client rows equal the filtered full run and the client-bound Datalog reference, every refusal returns no rows, the connector help and vendored text agree, all patches apply from scratch, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0054, walk from the client

**Goal:** a client run reads the client's holders and the blocks on its pages, not every Task, so a graph with more than 10,000 Task blocks answers a client query; its bounds, 422 and plan say what they counted. Lands spec §3.3, §3.4 (the with-client refusal and `plan-text`), §4 (dry-run plan, 422 with a client), §7 risks 1, 2, 5 and 8, §8 tests 1 (parity kept), 3 (with-client half), 4 (plan half) and 5, and acceptance 1 (bounds), 2, 5 (the plan), 6 (the with-client half) and 8 (the upload-path test).

**Files:**
- Modify (in `.upstream`): `worker/named_queries.cljs`: `client-candidates*` (`datoms* :avet client_property c` for holders; for each holder with no `:block/page`, `datoms* :avet :block/page p`; de-duplicated in a volatile set, each new candidate charged to `:tasks`); `open-tasks-by-client` with a client runs over it, keeping Task-tagged (an `:eavt` read of `:block/tags` for `:logseq.class/Task`), open, non-private candidates (charged to `:open-tasks`) whose effective clients include `c`; ctx carries `:client-title`, and `charge!`'s ex-data carries `:client`; `stops` gains the client wording per bound; `bound-message` uses it when `:client` is present; `plan-text` gets the client branch of §3.4.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the 422 description names the client form (blocks holding the client or on its pages).
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`, `semantic_uploaded_graph_schema_test.cljs`.
- Modify: `patches/0054-…`, the vendored files, `QUERIES_HELP` (one clause: with a client, the tasks bound counts the blocks holding the client or on its pages) and its test.

- [ ] **Step 1: Write the failing tests:**
  - `named-client-walk-test`: on a graph with more Task blocks than a lowered `:tasks` bound (`namedQueryBounds {tasks: 50}`, 60 tasks across three clients, 5 of them zq Acme's), the full run answers the 422 and the client run answers 200 with zq Acme's 5 rows; `work` `:tasks` equals the expected candidate count (holders plus blocks on holder pages, de-duplicated), not the Task count. Fails on the Stage 1 tree (the filtered scan still stops at `:tasks`).
  - `named-client-bounds-test` (spec §8 test 3, client half): a client page with more blocks than the lowered bound answers the exact client-worded `:tasks` 422; the `:open-tasks` and `:reads` 422s with a client carry their client wording; at each bound exactly, 200 (review focus 13); `last-run :named-work` shows bound + 1 on the refusal.
  - `named-client-dry-run-plan-test` (spec §8 test 4, plan half): the dry-run `plan` names the client's title and each bound with its number, with `work` empty and a bound set to 0 ignored.
  - `named-client-review-focus-test`: review focus 8 to 12 and 14 as fixtures, each asserting rows and `work`.
  - `named-client-parity-test` (from Stage 1) must stay green over the walk; extend its seeded graphs with tasks on client pages under non-task holder blocks and tasks holding a client and sitting on another client's page.
  - `uploaded-graph-client-walk-test` (spec §8 test 5, risk 1) in `semantic_uploaded_graph_schema_test.cljs`: on a graph uploaded in the app's shape, `forClient` created as the app creates it, `:avet` holders of a client equal the `:aevt` scan's, and the narrowing test's rows come back. If the `:avet` read returns fewer than `:aevt` there, stop: the design must read `:aevt` or refuse, never return empty rows; take it to the owner.
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures (the walk test's 422 is the quote).
- [ ] **Step 3: Implement** as spec §3.3 and §3.4 (with-client parts). Without a client the code path is unchanged; check by diff that the no-client branch of `open-tasks-by-client` is untouched apart from reading `:client`.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** skip the blocks on holder pages; also walk a holder block's children; drop the de-duplication; charge `:tasks` per Task only (not per candidate); skip the own-client-else-page rule (match a task on the client's page whose own client is B); drop `private?` on candidates; let a non-Task holder through; drop `:client` from the ex-data so the generic message shows. Confirm a test fails for each and revert.
- [ ] **Step 5: Commit and push.** `perf(api): walk open-tasks-by-client from the given client`. Body: the quoted 422 before, the candidate counts after, the upload-path result, the mutation results, the dev-build ms of the walk test, and cost (unchanged per call; DO reads fall from every Task to the client's holders and pages).

**Done when:** a client run answers past the Task count that stops the full run, parity holds on every fixture and seeded graph, the client 422s and plan name what they counted, the upload-path test passes, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0054, the refusals advise giving a client

**Goal:** a full run's `:tasks`, `:open-tasks` and `:reads` 422 says to give a client, so the caller has a narrowing that works. Lands spec §3.4 (without a client), §3.5 (the OpenAPI and connector text), §4 (422 without a client), and acceptance 6 (without-client half) and 7 (OpenAPI, vendored, `QUERIES_HELP`, manifest).

**Files:**
- Modify (in `.upstream`): `worker/named_queries.cljs`: `stops` for `open-tasks-by-client` without a client: advice `give a client (params.client), or mark finished tasks Done or Canceled` for each bound; when `client_property` is a default or url property (ctx carries its type from the resolved params) the advice stays `list one client's tasks with datalog_query`, since a client can't be given there.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the 422 description and the `open-tasks-by-client` sentence name the new advice.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`: the existing `named-bounds-field-test` and `named-scale-f3-test` expectations for `open-tasks-by-client`'s messages.
- Modify: `patches/0054-…`, the vendored files, `QUERIES_HELP` (the open-tasks refusal "says to give a client") and `connector/test/tools.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `named-client-advice-test`: with lowered bounds and no client, each of the three 422s ends with `give a client (params.client), or mark finished tasks Done or Canceled`; with a default `client_property` and no client, each ends with the `datalog_query` advice (review focus 15).
  - Update the exact-message assertions in the existing bound tests; they fail on the Stage 2 tree.
  - Connector: the vendored `run_named_query` 422 text and `QUERIES_HELP` both say "give a client".
- [ ] **Step 2: Run on the Stage 2 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.4.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** give the client advice for a text `client_property`; drop it from the `:reads` bound; use the client wording without a client. Confirm a test fails for each and revert.
- [ ] **Step 5: Commit and push.** `feat(api): open-tasks-by-client refusals advise giving a client`. Body: the messages before and after, the mutation results, the manifest change if any, and cost (none changed).

**Done when:** every open-tasks 422 without a client advises `params.client` except for a text client property, the help and vendored text agree, and `scripts/check.sh --upstream` is green.

---

### Stage 4: The release bundle and the bench

**Goal:** the client branch runs in the release bundle (where Closure's renames could break it) and stays within 0039's CPU at the cap. Lands spec §5 (Durable Object CPU), §7 risk 6, §8 test 6, and acceptance 8 (release check and bench) and 9.

**Files:**
- Modify: `scripts/release-query-check.mjs`: a client case: on the seeded fixture, `open-tasks-by-client` with `params.client` by title and by UUID returns exactly the full run's rows for that client and echoes `{title, uuid}`; a shared title answers the 400; a lowered bound with a client answers the client-worded 422 (checking `:client` survived as an ex-data key in the release bundle).
- Modify: `scripts/release-query-check.test.mjs`: the new exported helpers and expectations, without a build; the skip naming the missing bundle stays.
- Modify: `scripts/bench-datalog-query.mjs`: `--named` gains two client runs at the cap: a client on one page with more than 10,000 blocks (stops on `:tasks`), and a client held by many tasks (stops on `:open-tasks` or `:reads`); `namedInputs` resolves the client to its eid and echo as the handler does; output rows name the client run.
- Modify: `scripts/bench-datalog-query.test.mjs`: the client runs' output shape and fixture determinism (shape, not time).
- No patch change expected. If the release check finds a renamed key, fix it in 0054 and run the patch workflow.

- [ ] **Step 1: Write the failing tests:** the `.test.mjs` cases for the new helpers and modes, and the release client checks against the Stage 3 bundle (expected to pass; record that, or the failure if Closure renamed something).
- [ ] **Step 2: Run** and keep the failures (missing exports and modes).
- [ ] **Step 3: Implement, rebuild the bundle (`scripts/build.sh .upstream`) and run the bench** in the release bundle, cold and warm, for both client runs and the existing full `open-tasks-by-client` run. Each client run at the cap must stay at or under 0039's 90 to 120 ms; if one does not, stop and take the numbers to the owner (lowering a bound changes the contract text).
- [ ] **Step 4: Run** `scripts/check.sh --upstream` (it runs `release-query-check.mjs` on the bundle just built). **Mutation check:** drop the echo assertion; weaken the row check to a count; drop a field from the bench client output. Confirm a check fails for each and revert.
- [ ] **Step 5: Commit and push.** `test(scripts): client runs in the release check and the named-query bench`. Body: the bench table (run × cold and warm ms × `work`), that Node on a developer machine guides but does not measure the Durable Object on Cloudflare, and the commit `scripts/check.sh --upstream` ran on with what it skipped.

**Done when:** the release check's client case passes on a freshly built bundle, both bench client runs at the cap are at or under 0039's figures, and `scripts/check.sh --upstream` is green with its skips named.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §11.8 (the `open-tasks-by-client` sentence names `client`, the page-wins rule and the 400s), the `run_named_query` 422 table row (the advice is now to give a client; with a client the bound counts blocks holding it or on its pages), and backlog 24 (remove only the `client` half; the "bounds tuned on a developer machine" half stays). The spec's As built section records the bench figures and any deviation (the §12 page-wins rule replacing §3.2's "no ranking").
- **PR body:** each stage's first failure (Stage 1's quoted `params.client: not a param of open-tasks-by-client (params: client_property)`, Stage 2's 422), the mutation results, the upload-path result, the bench table, the commit `scripts/check.sh --upstream` ran on and what it skipped, whether `tools-manifest.json` changed, the cost table from spec §5, the patch numbering note (0054, with 0050 to 0053 reserved for PRs 72 and 73; renumber at merge if needed), and the **Logseq skill note**: "To list one client's open tasks, call `run_named_query` `open-tasks-by-client` with `params.client` set to the client's title or UUID. If a page and a tag share the title, the page is used; a 400 saying the title matches several entities lists them, so retry with the UUID you mean. A 422 without a client now says to give one."
- **Live check** (spec §9, after merge): dry run with a client and check the echo, then a real run compared with the full listing filtered; record outcomes and timings, not page names or UUIDs.
