# Named queries as code, and a width cap on function bindings: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in every stage, since every stage changes `patches/`), and is one commit, pushed straight after. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the four named queries answer on a realistic graph, or refuse with a 422 the caller can act on. `run_named_query` stops running Datalog: patch 0039's `named_queries.cljs` becomes Clojure that walks Datascript's indexes under named, counted bounds, with a lazy `private?` in place of the private set. The rule machinery that only the named queries used goes. `datalog_query` gains a width cap that charges each function binding for the cells it copies, so 175 `[(identity ?t) ?rN]` clauses stop in milliseconds rather than answering after 1.5 to 1.9 s.

**Architecture:**
- **Patch 0039 only.** Every server change goes into `patches/0039-semantic-datalog-query.patch` (not yet merged, PR 52), regenerated against a 0001 to 0038 baseline in each stage. Patch 0040 (Datascript externs in `shadow-cljs.edn`) is unchanged and must still apply after it. No new patch, no migration, no stored state.
- **Stage 1, the parts every query walks on:** the counted index helpers (`datoms*`, `first-value*`), the bound charge and its `ex-info`, the `namedQueryBounds` test field, and a lazy `private?` proved equal to `private-ids`. Nothing calls them from a route yet, so the API does not change.
- **Stage 2, the four queries as code:** `handle-named-query` calls the code path; responses carry `plan` and `work` instead of `query`, `inputs` and `rules`; dry run returns the plan and bounds; refusals name the bound. The `runNamedQuery` OpenAPI text, the vendored API, `QUERIES_HELP` and `release-query-check.mjs` change with it, because the connector's tests read the vendored text and CI re-vendors on every push.
- **Stage 3, the rule machinery goes:** `rule-cap`, the `rule-gen-guards` hook, `rule-cap-levels`, rules in `run-query` and `query-args`, and the validator's rule paths. `datalog_query` still refuses rules with 400; its text drops the ancestor-walk wording.
- **Stage 4, the width cap:** a `bind-by-fn` hook charges rows × columns toward `width-cap`, with its 422, OpenAPI text and help line.
- **Stage 5, the release bundle and the numbers:** `release-query-check.mjs` seeds about 20,000 blocks and times every named query and the F1 shapes; `bench-datalog-query.mjs` gains named-query and width modes; the bounds and the width cap are set from the measurements; the scan-cap `console.error` check lands.
- **Stage 6, `/` in a page title:** `POST /semantic/pages` answers 400 naming the title and the character. Time-boxed to 30 minutes (spec §3.8); if it needs more than one place or touches namespace pages, the stage is dropped and the docs step lists it as a README backlog item.
- **Order:** the helpers and the privacy test first, because every query is only as private as `private?`; then the queries, which are the point; then the deletion, once nothing calls the rules; then the width cap, which is independent and small; then the bench, which needs all of the code to measure; the `/` fix last, because it may not happen.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`; the real `sync-handler/handle-http` on a `create_graph` conn, through the `request!`, `named!`, `insert!`, `set-tags!`, `bulk!`, `deep-chain!`, `age!` and `with-named` helpers already in `semantic_datalog_query_test.cljs`); Datascript (Logseq's fork, `3f141af`); the release bundle under Node through `loadReleaseSyncDO` in `scripts/release-query-check.mjs`; the TypeScript connector with vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-named-queries-as-code-design.md`. Read it first; it is the authority, and section numbers below (§3.4 and so on) are its own. Its build order (§9) runs the bench before the contract text; this plan moves each piece of contract text into the stage that changes the behaviour, for the reason under *Architecture*, and leaves README, the As built notes and the learning doc to the lane's docs step.

## Global constraints

- **Names, exactly:**
  - in `worker/named_queries.cljs` (namespace `logseq.db-sync.worker.named-queries`): `datoms*`, `first-value*`, `charge!`, `private?` (built per request by `private-fn`), `visible-ref?`, `default-bounds`, `run-named` (name, db, resolved params, bounds → `{:rows :work :plan}`), `plan-text`, and one function per query: `projects-untouched`, `meetings-without-decision`, `open-tasks-by-client`, `pages-missing-property`;
  - bound keys and their provisional values (spec §3.4, §5; Stage 5 sets them): `:meetings` 5,000, `:decisions` 20,000, `:ancestor-steps` 50,000, `:tagged` 20,000, `:page-blocks` 20,000, `:tasks` 50,000, `:open-tasks` 5,000, `:reads` 100,000; the bound `ex-info` key `::bound` with `{:query :bound :value}`;
  - in `worker/handler/datalog.cljs`: `shape-response` (limit, byte cap, notes, `rows` last), factored out of `run-query`; `width-cap` (provisional 100,000) and its hook beside `join-tuples`; `last-run` gains `:width` and `:named-work`;
  - Durable Object test fields `namedQueryBounds` (a JS object of bound names to numbers) and `datalogWidthCap`, read the way `test-cap` reads `datalogScanCap`; no request can set either;
  - response keys `name`, `params`, `columns`, `total-rows`, `returned`, `truncated`, `plan`, `work`, `rows` (last); dry run `{name, params, plan, bounds, dry-run: true}`.
- **Messages, in the spec's wording (§3.6, §3.9), numbers from the constants:**
  - `meetings-without-decision stopped after 5,000 meetings created within days (its meetings bound); give a smaller days or a narrower meeting_tag`
  - `projects-untouched stopped after reading 20,000 blocks on pages not updated within days (its page-blocks bound); give a narrower tag or a larger days`
  - `open-tasks-by-client found more than 5,000 open tasks (its open-tasks bound); mark finished tasks Done or Canceled, or list one client's tasks with datalog_query`
  - `pages-missing-property stopped after 20,000 tagged pages and blocks (its tagged bound); give a narrower tag`
  - one message per remaining bound in the same form (query, what it counted, the number, `(its <bound> bound)`, the narrowing), and the `reads` backstop naming itself with the query's own narrowing;
  - `query stopped after function bindings copied 100,000 values (the width cap): each function binding copies every column of every row, so many bindings over many rows cost rows x columns; bind fewer values with functions or narrow the rows first`
- **No clock.** No code in `named_queries.cljs` or the width hook reads `js/Date`, `Date.now` or `performance.now` to bound work (`docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`). `resolve-params` keeps its single `Date.now` for the `days` cutoff.
- **Read-only by construction.** The code path takes a db value (`@conn`) and never the conn. A test checks `max-tx` and the datom count after every named query, refused or not.
- **No silent wrong answer.** A bound refuses the whole call; it never returns the rows found so far. A default the graph lacks stays a 400 naming the param.
- **Free plan** (spec §5): per call 2 Worker requests, about 1 D1 row read (graph token), 2 D1 rows written (the audit row and its index entry), 0 neurons, 0 Vectorize, 0 KV, unchanged from the query design. Each commit body states it, with the Durable Object CPU the stage's tests measured.
- **Tests run the real thing.** Through `handle-http` and the router on a `create_graph` db built by real writes; no stubbed Datascript, outliner or filter (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Each new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Where a test cannot fail first (a guard for a case the spec did not reproduce), say so in the commit body and the PR. Example data only (`Project`, `Business Meeting`, `Decision`, `forClient`, `zq …` titles, `sync.example.com`, alias `test`).
- **Contract with Claude.** OpenAPI text changes in the stage whose behaviour it describes, and that stage re-vendors, updates `QUERIES_HELP` and its tests in `connector/test/tools.test.ts`, and runs `npm --prefix connector run update:manifest` (the manifest holds names, paths and annotations, so it should not change; say so in the commit body).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `scripts`), with a body giving the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

  Push after every commit (`git push`), as the brief asks.
- **Never commit** the owner's graph name, page names, uuids, ident suffixes, hostnames or tokens.

### Working on patch 0039

Follow the `add-upstream-patch` skill, with one difference: 0039 is not the last patch, so the baseline stops at 0038 and 0040 is applied on top for building only. Once, before Stage 1 (the `.upstream` checkout and its `baseline` commit date from 2026-11-09 and may be stale):

```bash
SCRATCH=<the session's scratchpad>
rm -rf "$SCRATCH/p38" && mkdir "$SCRATCH/p38"
for p in patches/*.patch; do case "$p" in *0039-*|*0040-*) ;; *) cp "$p" "$SCRATCH/p38/";; esac; done
rm -rf .upstream && PATCHES_DIR="$SCRATCH/p38" scripts/fetch-upstream.sh .upstream   # 0001-0038
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0038"
git -C .upstream tag -f baseline
git -C .upstream apply "$PWD/patches/0039-semantic-datalog-query.patch" "$PWD/patches/0040-db-sync-release-build-datascript-externs.patch"
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest            # the vendor matches 18da2e9's patches
scripts/check.sh --upstream                          # green on the starting tree, before any change
```

At the end of each stage:

```bash
scripts/build.sh .upstream                                    # dev test build and the release bundle
scripts/upstream-test.sh .upstream 'semantic-datalog-query|semantic-private-tags|e2ee-semantic'
(cd .upstream/deps/db-sync && pnpm test)                      # the whole suite
git -C .upstream add -A
git -C .upstream diff --cached baseline -- . ':(exclude)deps/db-sync/shadow-cljs.edn' \
  > patches/0039-semantic-datalog-query.patch                   # 0040's file stays out of 0039
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 40 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream                                   # runs release-query-check.mjs too
```

To see an upstream test fail first, write it, then stash the source change (`git -C .upstream stash push -- deps/db-sync/src`), rebuild, run, and pop. The release check runs against the bundle as `scripts/build.sh` last built it, so rebuild before quoting its output.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost (Workers Free plan)* and *Contract and docs*.
- `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `docs/solutions/api/read-hid-built-in-properties.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`.
- The query design `docs/superpowers/specs/2026-11-09-datalog-query-named-queries-design.md` §3.4 to §3.10 and §12 (As built), and its plan.
- `worker/named_queries.cljs` (the four Datalog entries, their docstring and `above-rules`); `worker/handler/datalog.cljs`: `private-ids` (about `:650`), `query-filter`, `resolve-params`, `run-query` (about `:1118`), the `join-tuples` and `rule-gen-guards` hooks (about `:676` to `:830`), `rule-cap-levels` (`:949`), `test-cap` (`:1279`), `named-response` and `handle-named-query` (`:1402`); `worker/routes/semantic.cljs`: `runNamedQuery` and `datalogQuery`.
- Datascript `query.cljc`: `bind-by-fn` (`:524-545`), `prod-rel`, `sum-rel`, `join-tuples`; `graph_insights.cljs` `class-lineage-fn` (`:164`).
- Tests: `semantic_datalog_query_test.cljs` from `seed-named` (about `:2160`) to the end, `named-queries-at-scale-test`, `named-deep-outline-refused-test`, `rule-cap-depth-test`, `rule-cap-exact-test`, `caller-rules-refused-test`, `caps-documented-test`.
- `scripts/release-query-check.mjs` (`checks`, `deepChain`, `RULE_CAP_LEVELS`) and its `.test.mjs`; `scripts/bench-datalog-query.mjs` (`parseArgs`, `findBuild`, `loadBuild`) and its `.test.mjs`.
- Connector: `QUERIES_HELP` in `connector/src/tools/handwritten.ts` and the Queries block of `connector/test/tools.test.ts` (about `:2560` to `:2645`: phrase checks, and the cap numbers checked against the vendored descriptions).

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A meeting block that is itself tagged Decision, with no decision below it:** still a row (the `above` rule excluded the block itself) (Stage 2).
2. **A decision on a meeting's page but beside the meeting block, not under it:** the meeting block is still a row; a decision under a sibling meeting decides only that sibling (Stage 2).
3. **Two meetings on one page sharing an ancestor path, and a decision under a meeting nested under another meeting:** both meetings are decided, and the shared walk stops at the first ancestor already in `decided` without dropping the outer meeting (Stage 2).
4. **A decision whose parent chain passes through a private block, and a private decision under a public meeting:** the private decision does not decide the meeting; a public decision under a private block on a public meeting's page does, exactly as the old Datalog over `d/filter` answered (parity) (Stage 2).
5. **A tag extending a tag extending Private, and a tag titled `PRIVATE`:** `private?` agrees with `private-ids` (Stage 1).
6. **A block whose `:block/page` is private but whose parent chain is not (a moved block):** `private?` is true, as `private-ids` walks both (Stage 1).
7. **A task with two clients of the same title, and a client value that is private:** one row for the title; the private client is left out and, if it was the only one, the task falls back to its page's client, else `""`, as the Datalog did (Stage 2).
8. **A client value with no `:block/title`:** client `""` (Stage 2).
9. **A project page with only a private block edited within `days`:** still a row (a private block was hidden, so it never counted as fresh) (Stage 2).
10. **A page in the Recycle bin tagged Project, and a recycled decision under a meeting:** the first is never a row; the second does not decide the meeting (Stage 2).
11. **A bound reached exactly, and one more:** at the bound the query answers 200; one more answers the 422, and `work` in `last-run` shows the bound + 1 (Stage 2).
12. **`namedQueryBounds` naming an unknown bound or a non-number:** ignored the way `test-cap` ignores a bad value, never a 500 (Stage 1).
13. **A width charge on a query of only data patterns:** 0, so a large ordinary query is never refused by the width cap (Stage 4).
14. **The width cap reached exactly:** the query at exactly the cap answers 200; one cell more answers 422 (Stage 4).
15. **`dry-run: true` with a bound set to 0:** answers the plan, not the 422 (it reads nothing) (Stage 2).

---

### Stage 1: Patch 0039, counted index reads and a lazy `private?`

**Goal:** the pieces every named query walks on exist and are proved: counted reads that throw a named bound, test-settable bounds, and a per-request `private?` that agrees with `private-ids` on every entity. No route changes. Lands spec §3.2, §3.3, §6 (*Private content stays out*), §7 risks 1 (the `private?` half) and 2, and §8 item 2 (the `private?` test).

**Files:**
- Modify (in `.upstream`): `worker/named_queries.cljs`: add `default-bounds`, `datoms*` (lazy, one read charged per datom realised), `first-value*` (one read), `charge!` (bumps a named counter and throws `(ex-info … {::bound …})` past it, and bumps `:reads`), `private-fn` returning a memoised `private?` (Recycle-bin and private-lineage roots, then `:block/parent` and `:block/page` walked iteratively, each step charged to `:reads`, each class's lineage memoised), and `visible-ref?`. The Datalog entries stay for now.
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: `named-bounds` reads `namedQueryBounds` from the Durable Object beside `test-cap`, keeping only known names with non-negative whole numbers.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`.
- Modify: `patches/0039-semantic-datalog-query.patch`.

**Interfaces produced:** `(datoms* ctx index & components)`, `(first-value* ctx e attr)`, `(charge! ctx bound n)`, `(private-fn ctx)` → `private?`, `(visible-ref? private? v)`, and `ctx` as `{:db :bounds :work (volatile map)}`. Stage 2 builds every query on them.

- [ ] **Step 1: Write the failing tests:**
  - `private-fn-matches-private-ids`: about 30 seeded graphs (a small PRNG in the test, 40 to 80 entities each), built through `handle-http` with pages, nested blocks, moved blocks, tags Private, `PRIVATE` and a tag extending a tag extending Private, and a recycled page and block (`deletePage`, `delete_block`). For every entity, `(private? e)` equals `(contains? (private-ids db) e)`. Review focus 5 and 6.
  - `counted-reads`: `datoms*` over a known AVET range charges exactly the datoms realised (taking 3 of 10 charges 3); `first-value*` charges 1; `charge!` past a bound of 2 throws with `{::bound {:bound :tagged :value 2}}`; every charge also bumps `:reads`, and `:reads` past its own bound throws naming `:reads`.
  - `private-fn-is-memoised`: asking about every block of a 40-level chain costs one walk per distinct ancestor (the `:reads` count is linear in the chain, not quadratic).
  - `named-bounds-field`: `namedQueryBounds` with `{tagged: 3}` gives `{:tagged 3}` over the defaults; unknown names, strings and negatives are dropped (review focus 12).
- [ ] **Step 2: Run on the starting tree** and keep the failures (the functions do not exist).
- [ ] **Step 3: Implement** as spec §3.2 and §3.3.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** drop the `:block/page` walk; drop the Recycle-bin root; compare the private title case-sensitively; skip `class-lineage-fn`; charge nothing in `datoms*`; charge `datoms*` up front for the whole range instead of per datom realised; make `charge!` throw at the bound instead of past it. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): counted index reads and a lazy private check for named queries`. Body: the failures seen, the mutation results, that no route changed (so no vendor or manifest change), and cost (none yet: no request reaches this code).

**Done when:** `private?` equals `private-ids` on every entity of every seeded graph, all 40 patches apply from scratch, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0039, the four named queries as code

**Goal:** `run_named_query` answers from code, not Datalog, at review 2's sizes and at any decision depth, and refuses only with a named bound. Lands spec §3.4, §3.5, §3.6, §3.7, §4 (`run_named_query`), §6, §7 risks 1 and 6, §8 items 1 to 4 and 8, and acceptance 2 to 5 (and 7 for the handler).

**Files:**
- Modify (in `.upstream`): `worker/named_queries.cljs`: the four query functions as spec §3.4 (each charging its bounds where it visits a candidate), `plan-text`, `run-named`; the Datalog entries become `{:title :description :columns :params :run}` (params unchanged). Remove `above-rules`. Rewrite the namespace docstring to say what each walk reads and which bound stops it.
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: factor `shape-response` out of `run-query` (unchanged behaviour for `datalog_query`); `handle-named-query` checks E2EE, the name and the params as now, then calls `run-named` on `@conn`, sorts with the typed comparator, cuts to `limit`, pulls `{block/uuid, block/title}` for the kept rows only, and answers through `shape-response` with `plan` and `work`; `::bound` maps to the §3.6 422; dry run returns `{name, params, plan, bounds, dry-run: true}`; `last-run :named-work` holds the counts.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `runNamedQuery` description (each query, its params and defaults, each bound and its number, "a decision at any depth", the 422 naming a bound), its 422 text, and `NamedQueryResponse` (`plan`, `work`; no `query`, `inputs` or `rules`); the dry-run schema.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`: keep the old Datalog entries and `above-rules` as test data (`legacy-named-queries`) for the parity test; update `named-projects-untouched-test` and the other named tests that assert `query`/`inputs`; replace `named-deep-outline-refused-test` with `named-deep-outline-answers-test`; `rule-cap-depth-test` and `rule-cap-exact-test` stay until Stage 3 if they run through `run-query` directly, and are deleted here if they go through the named route.
- Modify: `scripts/release-query-check.mjs` and `.test.mjs`: the 180-level decision now answers 200 with the meeting decided (no 422); drop `RULE_CAP_LEVELS` and the depth-52/53 checks; check `plan` and `work` in the named answer.
- Modify: `patches/0039-…`, `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`, `connector/src/tools/handwritten.ts` (`QUERIES_HELP`: spec §4's named-query paragraph; drop the 52-level sentence and "projects-untouched can reach the scan cap"), `connector/test/tools.test.ts` (phrase checks for `plan`, `work`, "at any depth", the 422 naming a bound; one bound number checked against `run_named_query`'s vendored description; remove the rule-cap and scan-cap-vs-`run_named_query` number checks and the `"the scan cap (20,000 datoms, 422)"` description phrase).

- [ ] **Step 1: Write the failing tests**, each through `handle-http` and the router:
  - `named-scale-meetings` (spec §8 item 1): 10 meetings × 200 decisions, 50 × 40 and 5 × 400, with the decisions 6 levels down under meetings on their own pages and on another page, plus 5,000 filler blocks (`bulk!`); 20 meetings each with 3 decisions 40 levels below (`deep-chain!`); one decision 180 levels below a meeting. Each answers 200 with the exact meeting rows, and prints its ms. Today the 6-level and 40-level cases answer the join-cap 422 (quote it).
  - `named-scale-f3`: 150 open tasks across 3 clients, task-level and page-level; 700 pages tagged one tag, none with the property (today the scan-cap 422; quote it); `projects-untouched` over 20,000 filler blocks with 50 stale project pages, their `updated-at` moved with `age!` and a fresh child on 10 of them. Each answers 200 with the exact rows and prints its ms. Where review 2's layout does not fail first (spec table: `open-tasks-by-client`, `projects-untouched`), try the layouts spec §8 item 1 names, quote whichever fails, or record that none did.
  - `named-parity`: each query's rows and order from the code path equal `legacy-named-queries` run with `d/q` over `(d/filter db (query-filter … (private-ids db) …))` on the `seed-named` fixture and on the 30 seeded graphs of Stage 1 extended with meetings, decisions at random depths, tasks of every status and clients on tasks and pages. Review focus 1 to 4 and 7 to 10 are fixtures in it, and each also has its own named assertion.
  - `named-bounds`: for each query and each of its bounds, `namedQueryBounds` set to a small number gives the 422 with the exact §3.6 message, the bound's number from the setting; at the bound it answers 200 (review focus 11); `last-run :named-work` shows bound + 1 for the refusal. The `reads` backstop has its own case.
  - `named-no-clock`: wrap `js/Date.now` in a counter for the call; the count equals the dry run's (param resolution only).
  - `named-read-only`: `max-tx` and the datom count unchanged after each query, answered and refused.
  - `named-contract` (spec §8 item 4): the response keys in order with `rows` last; `query`, `inputs` and `rules` absent; `plan` names each bound and its number; `work` holds a count per bound and `reads`; dry run has `plan` and `bounds`, no rows, 0 reads, and ignores a bound set to 0 (review focus 15); E2EE 409 before the name lookup; the 404, the params 400s, and the `limit` and byte-cap notes unchanged.
  - `named-response-documented`: the `runNamedQuery` description names each bound's number from `default-bounds` (as `caps-documented-test` does for the caps).
  - Connector (vitest): the `QUERIES_HELP` phrases and the bound number against the vendored description, red until `QUERIES_HELP` changes.
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.4 to §3.7, one query at a time, each to green on its scale and parity tests before the next: `pages-missing-property`, `projects-untouched`, `open-tasks-by-client`, then `meetings-without-decision`. Then the response, dry run and refusals; then the route text, re-vendor and `QUERIES_HELP`; then `release-query-check.mjs`.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** add the decision itself to `decided`; stop the shared walk one step early (at the ancestor's parent); skip `private?` on decisions; skip `private?` on fresh blocks in `projects-untouched`; check freshness with `>` instead of `>=`; use only the task's first client value; drop the dedupe of `[title task]`; skip the page fallback for clients; drop the extending tags from a tag param; return partial rows when a bound is hit; charge a bound after the work instead of before it; sort by eid only. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): run the named queries as code under named bounds`. Body: the quoted 422s from the scale tests and which sizes never went red, the measured ms per query in the dev build, the mutation results, the response change (`plan` and `work` in place of `query`, `inputs` and `rules`), that the manifest did not change, and cost (unchanged per call; no private-set build, so the 47 to 209 ms of README backlog 23 no longer applies to named queries).

**Done when:** every review 2 size answers 200 with the right rows, parity holds on every fixture and seeded graph, every bound answers its own 422, `release-query-check.mjs` passes on the rebuilt bundle, the help's numbers match the vendored text, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0039, remove the rule machinery

**Goal:** nothing is left that only the old named queries used. `datalog_query` refuses rules exactly as before, with a message that points to `run_named_query` without describing an ancestor walk. Lands spec §3.10, §4 (`datalog_query`'s rules refusal), §7 risk 7, and acceptance 6 (the rule-cap half).

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: remove `rule-cap`, the `rule-gen-guards` hook and its volatiles, `rule-cap-levels`, `rule-cap-message`, the `::rule-cap` mapping, `:rule-cap` in `run-query`'s options and `test-cap`'s field list (`datalogRuleCap`), rules in `run-query` and `query-args`, and the validator's rule paths (`rule-names`, `rules-errors`, `left-recursion-errors`, the `caller?` flag). The refusal of a `rules` field, `%` in `:in` and a rule call stays, with the new wording.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: `datalogQuery`'s description drops the ancestor-walk and rule-cap wording.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`: delete the tests of removed code (`rule-cap-depth-test`, `rule-cap-exact-test`, `rule-recursion-test`, `rule-left-recursion-refused-test`, `left-recursion-check-is-linear-test`, `rule-recursion-after-data-runs-test`, `rule-recursion-through-get-some-test`, as each turns out to test only removed code; list them in the commit body); keep `caller-rules-refused-test` and `source-and-rules-test` and update their message.
- Modify: `patches/0039-…`, the vendored files, `QUERIES_HELP` (the "for every ancestor use run_named_query (… its own rules)" clause becomes "for every ancestor use run_named_query's meetings-without-decision, or step up one level at a time"; the rules sentence is kept) and its tests.

- [ ] **Step 1: Write the failing tests:**
  - `caller-rules-refused-test` asserts the new message for each of a `rules` field, `%` in `:in` and a rule call, and that it no longer mentions rules walking ancestors.
  - `no-rule-hook`: after a `datalog_query`, `last-run` has no `:rule-work`; `dq/rule-gen-guards` is Datascript's own function (identical before and after a query).
  - `caps-documented-test`: `datalogQuery`'s description no longer names a rule cap or a depth.
  - Connector: `QUERIES_HELP` no longer says "its own rules", and the `datalog_query` description check drops any rule phrase.
- [ ] **Step 2: Run on the Stage 2 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.10.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** let a rule call through when `rules` is absent; accept `%` in `:in` with an empty `rules`; drop the check for a `rules` field. Confirm a test fails for each (these refusals now have no other guard). Revert. Also confirm `grep -n 'rule-gen-guards\|rule-cap\|above-rules' .upstream/deps/db-sync/src` finds nothing.
- [ ] **Step 5: Commit and push.** `refactor(api): remove the rule cap and rule support from patch 0039`. Body: what was removed and which tests went with it, the refusal messages before and after, that the all-caps worst case is unchanged (the bench's number from `scripts/bench-datalog-query.mjs`, run before and after), the mutation results, and cost (none changed).

**Done when:** no rule code is left in the patch, every rule form `datalog_query` refused before is still refused with 400, the patch is smaller than Stage 2's, and `scripts/check.sh --upstream` is green.

---

### Stage 4: Patch 0039, the width cap on function bindings

**Goal:** a query of many function bindings over many rows answers a named 422 quickly instead of 200 after 1.5 s. Lands spec §3.9, §4 (`datalog_query`'s width cap), §5 (`datalog_query`), §7 risks 8 and 9, §8 item 5 (dev build), and acceptance 6.

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: `width-cap`; while `run-query`'s `d/q` runs, `dq/bind-by-fn` is wrapped with `set!` (restored in `finally`, as `join-tuples` is) and after each call charges `(count tuples) × (count attrs)` of the relation it returned; past the cap `(ex-info … {::width-cap n})` maps to the 422; `last-run :width`; `datalogWidthCap` in `test-cap`'s fields.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: `datalogQuery`'s description and 422 text name the width cap and its number in the form `copied 100,000 values (the width cap)`.
- Modify (in `.upstream`): `semantic_datalog_query_test.cljs`.
- Modify: `patches/0039-…`, the vendored files, `QUERIES_HELP` (one sentence on the width cap with its number) and `tools.test.ts` (the phrase, and the number against `datalog_query`'s vendored description, in the existing `it.each` of caps).

- [ ] **Step 1: Write the failing tests:**
  - `width-cap-f1`: 175 `[(identity ?t) ?rN]` clauses over the 100 blocks of one page, 99 over 200 rows, and 20 bound `clojure.string/includes?` over 500 rows each answer the 422 with the exact message, in under 150 ms in the dev build (today: 200 after about 1.9 s, then the join or call cap; quote the times).
  - `width-cap-legitimate`: a 3-binding query over 2,500 rows at width 5 answers 200; a query of only data patterns over the row cap's rows charges `:width` 0 (review focus 13).
  - `width-cap-exact` (review focus 14): with `datalogWidthCap` set to the fixture's measured width, 200; one less, 422.
  - `width-hook-reached` (risk 8): `last-run :width` is above 0 after a function-binding query, so a Datascript bump that renames `bind-by-fn` fails the test.
  - `width-cap-restored`: after a query (answered and refused), `dq/bind-by-fn` is Datascript's own function.
  - The all-caps worst-case test keeps its existing time bound.
  - `caps-documented-test` and the connector help check: the width cap's number from the constant.
- [ ] **Step 2: Run on the Stage 3 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.9.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** charge rows only (not × columns); charge before the call with the input relation; skip the restore in `finally`; compare with `>=` instead of `>`; reset the counter per clause. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `fix(api): cap the values function bindings copy in datalog_query`. Body: the quoted times before and after for each F1 shape (dev build), the overshoot observed (risk 9), the mutation results, that the manifest did not change, and cost (one multiply per function binding).

**Done when:** each F1 shape answers the width-cap 422 under 150 ms in the dev build, the legitimate query answers 200, the help's number matches the vendored text, and `scripts/check.sh --upstream` is green.

---

### Stage 5: The release bundle at scale, the bench, and the numbers

**Goal:** the bounds and the width cap are set from measurements in the release bundle, the named queries answer a realistic graph within about 100 ms there, and a scan-cap 422 is checked for `console.error`. Lands spec §3.8 (the `console.error` half), §5 (CPU), §7 risks 3, 4 and 9, §8 items 6 and 9, and acceptance 1, 6 (the release half), 7 and 8 (the log half).

**Files:**
- Modify: `scripts/release-query-check.mjs`: seed about 20,000 blocks through `SyncDO.fetch` (`/semantic/block-trees` in batches), with hundreds of meetings and decisions (some 40 levels deep), hundreds of open tasks across clients, a few thousand tagged pages and 50 stale project pages (their `updated-at` moved in the SQLite-backed store before the bundle reads it, since the API cannot backdate; say how in the file's header); run the four named queries and assert 200, the exact rows and a 300 ms bound, printing each time; run the three F1 shapes and assert the width-cap 422 under 100 ms; run a `datalog_query` scan-cap 422 with `console.error`, `warn`, `log` and `info` captured and assert none was called. Update the header comment.
- Modify: `scripts/release-query-check.test.mjs`: the new exported constants and helpers (fixture sizes, the timing bound, the F1 query builders, the console capture) without a build; the skip with a reason when the bundle is missing stays.
- Modify: `scripts/bench-datalog-query.mjs` and `.test.mjs`: `--named` (each query at `--pages` sizes, reporting `work` per bound and ms cold and warm) and `--width` (the F1 shapes and the 3-binding query, reporting `:width` and ms) modes, and `--bounds`/`--width-cap` to try values.
- Modify (in `.upstream`, only if the measurements require it): `default-bounds` and `width-cap` in the patch, and the tests whose numbers follow them; if the `console.error` repro logs, the fix where it logs (spec §3.8), inside 0039.
- Modify (only if a number changed): `patches/0039-…`, the vendored files, `QUERIES_HELP`.

- [ ] **Step 1: Write the failing tests:** the `.test.mjs` cases for the new helpers and modes (output shape, seeded fixture identical for the same size, skip naming the missing build); and the new release checks themselves, run against the Stage 4 bundle: the named queries and F1 shapes are expected to pass already, so record that, and record whether the `console.error` check went red (the spec did not reproduce it).
- [ ] **Step 2: Run** and keep the failures (missing exports and modes).
- [ ] **Step 3: Implement, run the bench in the release bundle at 5,000 and 20,000 blocks, and set the numbers.** Each bound is set so a query at the bound stays near 100 ms warm in the release bundle; the width cap so the F1 shapes stop under 100 ms and the all-caps worst case stays near 184 ms. If seek cost makes 20,000 `page-blocks` too slow, lower it and say so in the tool text (risk 3); the updated-at fallback of risk 4 is built only if the bench shows `projects-untouched` cannot meet the target otherwise, and then as its own step with its own test.
- [ ] **Step 4: Run the patch workflow** (the patch changes only if a number or the log fix changed; if not, say so and run `scripts/check.sh --upstream` anyway). **Mutation check:** in `release-query-check.mjs`, drop the console capture; weaken a row assertion to a count; in the bench test, drop a mode's field. Confirm a check fails for each. Revert.
- [ ] **Step 5: Commit and push.** `perf(api): set the named-query bounds and width cap from the release bundle`. Body: the bench table (query or shape × size × cold and warm ms × work), the chosen numbers and why, whether the `console.error` check was ever red and what fixed it, and that Node on a developer machine guides but does not measure the Durable Object on Cloudflare.

**Done when:** `release-query-check.mjs` passes on a freshly built bundle with every named query at realistic size under its bound and every F1 shape under 100 ms, the patch's numbers match the commit body and the help, and `scripts/check.sh --upstream` is green.

---

### Stage 6: Patch 0039, refuse `/` in a new page title (time-boxed)

**Goal:** `POST /semantic/pages {"title": "a/b"}` answers 400 naming the title and the character instead of 500 `server error` with a `console.error`. Lands spec §3.8 (the `/` half), §8 item 7, and acceptance 8 (the `/` half).

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: a check before the write in the create-page path (and in any batch entry that creates a page by title, if it shares the path), answering 400 `title: a page title can't include "/" (a/b)` in the house wording. Nothing else.
- Modify (in `.upstream`): the create-page test namespace (or `semantic_datalog_query_test.cljs` if no better home), and `routes/semantic.cljs` only if the 400 is not yet described.
- Modify: `patches/0039-…`, the vendored files if the route text changed.

- [ ] **Step 1: Write the failing test** through the real handler: `POST /semantic/pages` with `a/b` answers 400 naming the title, the db is unchanged, and no `console.error` fires; seen first as 500.
- [ ] **Step 2: Run** and keep the failure.
- [ ] **Step 3: Implement**, stopping at 30 minutes. If the check needs more than one place or reaches namespace pages, revert the stage, add nothing to the patch, and hand it to the docs step as a README backlog item (spec §11 question 5 lets the owner decide whether it blocks the PR).
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** check after the write; check only a leading `/`. Confirm the test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `fix(api): refuse a "/" in a new page title with 400`. Body: the quoted 500, the place of the check, and why it belongs in 0039 (the spec keeps all of this item's server change in one patch; note in the PR that it would be its own upstream PR).

**Done when:** the 400 is in place with its test, or the stage is recorded as dropped with its backlog line drafted; `scripts/check.sh --upstream` is green either way.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §11.8 (Queries, Caps, Audit and cost: named queries run as code with named bounds, `plan` and `work` in place of `query` and `inputs`, the width cap, no rule cap), §11.10, and backlog 21 (Query blocks now apply to `datalog_query` only), 23 (the private set no longer runs for named queries), 24 (closed: no index scan from a page to its blocks) and 25; the query design's §12 As built (this change, the measured ms per bound) and its §3.9 "Reusable representation"; `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md` (fixed shapes need fixed bounds, not caller caps; the width cap); a new `docs/solutions` entry if the build taught something new (for example, parity tests against the old Datalog as the oracle for a rewrite). Add the `/` backlog item if Stage 6 was dropped.
- **PR body:** each stage's first failures (the quoted 422s and times), the scale sizes that never went red, the mutation results, the bench table and the chosen numbers, the commit `scripts/check.sh --upstream` ran on and what it skipped, that `tools-manifest.json` did not change, the cost table from spec §5, and the Logseq skill note from spec §4: named-query answers no longer carry Datalog (`query`, `inputs`, `rules`), read `plan` to see what ran; `meetings-without-decision` has no depth limit; a 422 from a named query names a bound and says what to narrow, so narrow and call again rather than writing Datalog; `datalog_query` refuses many function bindings over many rows (the width cap).
- **Live check** (spec §9, after merge): the five steps on the test graph (alias `test`); record outcomes and timings, not page names.
- **Owner questions.** Spec §11 stays open; none blocks a stage, but answers change these places: question 1 (a Datalog echo in `plan`) adds a field in Stage 2's response; question 2 (bound values) changes Stage 5's numbers; question 3 (a `client` param) adds a param and a narrowing to Stage 2's `open-tasks-by-client`; question 4 (the width cap refusing those queries) is settled by Stage 4 unless the owner says no, which would drop Stage 4; question 5 decides whether a dropped Stage 6 blocks the PR; question 6 is a tracker update `/lane` drafts. **One caution on the spec:** §3.10 deletes the validator's rule paths (`rule-names`, `rules-errors`, `left-recursion-errors`, `caller?`) while `datalog_query` must still refuse a `rules` field, `%` and rule calls. If any of those refusals goes through one of the deleted functions today, Stage 3 keeps the part the refusal needs, says so in its commit body, and its mutation check proves the refusal still has a guard.
