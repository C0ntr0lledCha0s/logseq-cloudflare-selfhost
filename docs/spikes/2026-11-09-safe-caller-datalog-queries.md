# Spike: running caller-written Datalog queries safely against a live graph

Date: 2026-11-09. Issue 40. Branch `claude/relaxed-maxwell-s4r8o4-queries`, patch 0039 at HEAD `7d04944`. Measurements ran in the session scratchpad against builds of that commit (dev `:node-test` build and the `pnpm release` bundle, Node 22, Cloudflare modules stubbed, better-sqlite3 in place of DO storage). No repo code was changed and nothing was written to Logseq. The scratchpad scripts are not committed; their names are given so the runs can be repeated.

Every claim is marked **verified** (code read, test or measurement at `7d04944`) or **inferred**. Cloudflare docs could not be fetched in this session (`developers.cloudflare.com` was blocked by the proxy: `ENOTFOUND` and `CONNECT tunnel failed, 403`). Every Cloudflare figure below therefore comes from search-result snippets or the repo's own records, and is marked inferred.

## Questions

1. **Isolation.** What does a separate per-graph query DO holding a read-only replica take? What are the real Free plan DO limits, and how does a CPU-limit kill reach the caller?
2. **Other venues.** A Worker loading a snapshot per query, Containers, the nightly R2 backup, a desktop or headless CLI replica.
3. **A bounded engine.** A fuel counter inside Datascript's query loop, cooperative yielding, an interpreter with fuel.
4. **A restricted language.** No caller rules, non-recursive rules, a whitelist or small DSL, static cost estimates. What do the owner's real queries lose? How do other systems do it?
5. **Other engines and data paths.** SQL in the DO's SQLite, D1, a precomputed index.
6. **Recommendation.** Rank the options and propose a staged path.

## Short answer

**Revisit free-form `datalog_query`; build named queries now; build a fuel counter next.**

A finding outranks the question. **`datalog_query` does not work in the deployed build** (verified). The release bundle renames the Datom field `v`, because the `:db-sync` build in `deps/db-sync/shadow-cljs.edn` has no `:externs ["datascript/externs.js"]`, unlike upstream's app builds. Every variable bound to a datom value comes back `nil`. CI runs only the dev build, so no test sees it. This must be fixed, with a release-build query check, before item 40 merges, whatever is chosen below.

On safety: per-construct caps shrink the class but do not close it. The rule-tree route still costs 5.5 s at 10^5 leaves and about 10 s at the work cap (verified). Nothing on the Free plan cuts a synchronous query short apart from counting work ourselves (inferred: no timeout, interrupt or progress handler was found in DO SQLite or D1). The staged path is:

- **With the item 40 PR.** Fix the release build and add a release-build query test. Ship `run_named_query`. Either drop `datalog_query` from this PR, or ship it with caller `rules` refused. Refusing rules removes the only route measured past the caps, and all four named queries keep working, because their rules are server data, not caller input (verified).
- **Next.** One fuel counter at rule expansion, clause resolution, relation operations and function calls, replacing the separate join, work and call counters. In the prototype it stopped every hostile case tried in 24 to 192 ms, with overhead inside noise (verified on 15 cases). Whether it closes the class is inferred, not proved.
- **Later, if the owner wants full isolation.** A replica DO of the same class. All the parts exist, but the snapshot carries no `t`, and every replicated write is paid for twice in rows.
- **Don't build.** A Worker loading a snapshot per query, Containers, and queries over the R2 backup or a SQL translation.

The owner should decide whether free-form Datalog is worth keeping at all. The repo records no ad-hoc use beyond the four named queries.

## Comparison

Safety: **closes** means a runaway cannot block sync or reset the sync DO; **bounds** means CPU is capped by construction, given a calibrated budget; **shrinks** means it removes known routes only.

| Option | Safety | Owner value | Free plan cost | Build effort | Upstream-bump maintenance | Freshness | Failure behaviour | Call |
|---|---|---|---|---|---|---|---|---|
| A. As built (per-construct caps) | Shrinks | High | ~2 requests, 1 row read, 2 written per call | Done | Six `set!` hooks plus two tables | Live | Rule tree: 5.5 to 10 s blocking sync | Don't ship as is |
| B. Caller rules refused, caps kept | Shrinks (removes the measured route) | High minus recursion | Same as A | Small validator change | Same as A | Live | Known routes stop at 60 to 300 ms (verified for not, not-join and or-join shapes) | **Build now** |
| C. Named queries only | Closes for callers (fixed shapes; graph size still matters) | Medium: the four uses | Same as A | Done | Low | Live | Bounded by graph size (backlog 24) | **Build now** |
| D. Fuel counter (one budget, weighted steps) | Bounds (inferred) | High | Same as A; overhead -10 % to +8 % | Small to medium | Four more hook points; weights recalibrated per bump | Live | Stops in 24 to 192 ms on all hostile cases tried | **Build next** |
| E. Replica query DO (same class, other name) | Closes (inferred) | High | Bootstrap rewrites all kvs rows; each write paid again | Medium to large | Sync code and storage format | Lags by one pull | A kill resets only the replica (inferred) | Revisit |
| F. Worker loads a snapshot per query | Closes | High | Fails: 10 ms CPU against a 92 to 518 ms load | Medium | Medium | Snapshot | CPU kill on every real graph | Don't build |
| G. Containers | Closes | High | Paid only ($5 a month and usage) | Large | High | Depends on log follow | Container restarts | Don't build; revisit on Paid |
| H. Queries over the nightly R2 backup | Closes | Low (up to 24 h stale) | $0 in Actions | Medium | Low | Up to 24 h | Not interactive; public Actions logs | Don't build |
| I. Desktop or headless CLI replica | Closes | Claude Code on the owner's machine only | $0 Cloudflare; an always-on host | Medium | High (young CLI) | WebSocket lag | Pins the local process | Revisit, power-user only |
| J. Whitelist or small DSL | Closes | Medium | Same as A | Medium | Low | Live | Bounded shapes | Revisit after C is used |
| K. SQL in DO SQLite or D1 | n/a: no datoms table | High | High in rows read | Large (second schema) | High | Live or indexed | DO CPU limit only | Don't build |
| L. Precomputed index (kb_index-style) | Moves the risk to a cron | Medium | ~0.5 % to 5 % of daily D1 writes (inferred) | Medium per query | Medium | Up to an hour | Refresh still runs Datalog in the sync DO | Revisit per query |

## Findings

### 0. The deployed build returns nil values (blocks item 40)

- **Verified.** In the release bundle at `7d04944`, the datom accessor reads `case "v":return a.ka` (`.upstream/deps/db-sync/worker/dist/worker/main.js`). Datascript's `lookup-pattern-db` reads tuple fields by the strings `"e" "a" "v" "tx"` (`datascript/query.cljc:415`).
- **Verified by measurement**, driving the real release `SyncDO.fetch()` (scratchpad `exp/release-do6.mjs`, `release-do2-main.mjs`). After creating a page through the API, `[:find ?t :where [?e :block/name "hello page"] [?e :block/title ?t]]` returns `[[null]]`. A tag self-join returns 0 rows where the dev build returns 841. A `clojure.string/includes?` query answers 400 `Cannot read properties of undefined (reading 'indexOf')`.
- **Verified by bisect** (`exp/bisect.sh`, variants A, F, G, H). Removing the `set!` hooks or the private filter does not help. Adding `:externs ["datascript/externs.js"]` to the `:db-sync` build in a scratch copy gives `case "v":return a.v`, and the results match the dev build.
- **Cause.** `.upstream/shadow-cljs.edn:28-32` sets externs for the app builds; `deps/db-sync/shadow-cljs.edn` does not. Upstream db-sync has no other server-side `d/q`, so nothing else exposed it. CI builds the release bundle but never queries it (`.github/workflows/ci.yml:65-78`), and `scripts/smoke-test.sh` calls no semantic route.
- **Not checked.** workerd itself, the full `semantic_datalog_query_test` suite against a release build, and whether `:externs` changes anything else in the bundle.

### 1. Isolation: a replica query DO

**Platform limits (all inferred: search snippets of `developers.cloudflare.com/durable-objects/platform/limits` and `/workers/platform/limits`, not fetched).**

- DO CPU per invocation: 30 s by default, raisable to 5 min with `limits.cpu_ms`. No Free-versus-Paid split was shown. If 30 s holds on Free, a runaway can block sync for up to 30 s before any kill. `scripts/render-wrangler.mjs:70-71` deletes `limits` on Free, so the repo sets nothing (verified).
- Front Worker on Free: 10 ms CPU, 128 MB memory, 100k requests a day, 50 subrequests (a 2026-02-11 changelog snippet also mentions 1,000 to Cloudflare services). Over CPU returns error 1102.
- SQLite DOs are on Free, and rows read and written count against the D1 allowances (5M and 100k a day). Per-object storage on Free: snippets disagree (1 GB, 10 GB, 5 GB per account).
- DO SQL: 100 bound parameters, 100 KB statements, 2 MB rows. No progress handler, interrupt or statement timeout was found (absence not proved).
- The only measurement is the S3 spike (`docs/spike-results.md:56-69`, verified): front Worker CPU up to 92 ms was accepted, and 150 DO requests showed no CPU outcome. A 5 to 10 s query is two orders of magnitude past anything observed.

**How a kill surfaces.** Untested. Snippets say "reset" means in-memory state, and stored data survives (inferred). Through the connector (verified by reading code): a non-2xx JSON answer becomes `sync server error (HTTP n): <message>`; a non-JSON body keeps only `sync server returned HTTP n` (`connector/src/sync.ts:51-71`); a rejected `env.SYNC.fetch` is rethrown with no mapped text (`tools/semantic.ts:154`, `tools/common.ts:73-91`). Either way `loggedRead` writes an `error` audit row. The real harm of a kill is that the sync DO reloads its Datascript db from SQLite (inferred).

**What a replica takes (verified from code unless marked).**

- **Addressing.** The front Worker uses `idFromName(graph-id)` (`worker/dispatch.cljs:28`). A replica can be the same `SyncDO` class under another name. That needs no new class or migration, so `config/expected-bindings.json` and `scripts/check-upstream-bindings.mjs` stay as they are. A second class would need a v2 migration and an expected-bindings edit.
- **Bootstrap.** `/snapshot/stream` streams `kvs` rows in batches of 10,000 (`handler/sync.cljs:205-236`). But the snapshot carries no `t`, checksum or tx_log, so a replica cannot tell which `t` it matches (`docs/solutions/sync/snapshot-is-kvs-only-and-tx-log-has-no-author.md`). Whether non-root kvs addresses are write-once is unknown; `on conflict(addr) do update` exists.
- **Following the log.** `handle-sync-pull` returns tx_log rows since `t` (`:718`, `fetch-tx-since` in `storage.cljs:130`), and `apply-tx!` replays them (`:633`). The primary broadcasts only to WebSocket clients, so freshness would be pull-on-query.
- **Rows.** Measured on the release build (`exp/writes.mjs`): creating a page writes 1 kvs + 1 tx_log + 2 sync_meta rows; inserting 20 blocks writes 147 kvs rows. A replica pays that again. 1,000 pages is 12,339 kvs rows (8.1 MB), and kvs has no GC (`storage.cljs:28`). A bootstrap at 1,000 pages is about 12 % of a day's 100k writes (inferred from the count).
- **Memory.** A fully loaded db measured 259 to 266 bytes per datom on EAVT alone (`exp/mem.mjs`): 5,000 pages is +79 MB, 20,000 pages +314 MB. That is a lower bound against 128 MB. Datascript loads B-tree nodes lazily (the bench's cold scan loads 2,259 of 21,365 nodes at 5,000 pages), so ordinary queries need not hold it all (verified). A runaway that walks the whole graph would hit the memory limit above about 8,000 pages (inferred).
- **Downsides.** Each replica runs the whole sync class, including the externs defect. Lag needs a rebuild path if history is trimmed.

### 2. Other venues

- **(a) Worker loading a snapshot per query.** Don't build. A cold restore is 92 to 240 ms and a full load 518 ms at 5,000 pages (bench and `exp/mem.mjs`, verified), against 10 ms CPU on the front Worker (inferred figure).
- **(b) Containers.** Don't build on Free. Snippets (inferred) say Paid only: $5 a month includes 25 GiB-hours of memory and 375 vCPU-minutes, with usage billing after that, and each container is backed by a DO. This would end the Free plan's hard-budget protection.
- **(c) Nightly R2 backup.** Don't build. `scripts/backup.sh` writes a kvs-only SQLite file per graph daily (verified). Answers would be up to 24 h stale. Restoring needs more than a Free Worker's CPU, so it would run in GitHub Actions, whose logs are public. An MCP call cannot wait on a workflow.
- **(d) Desktop or headless CLI replica.** Revisit, for Claude Code on the owner's machine only. The items 3 and 4 spike write-ups do not exist in any ref (a grep of all branches found only the spec's mention that item 3 "is replaced if this ships"); their conclusions are on the Logseq issues page, which was not read. Upstream's CLI has `sync download`, `sync start` and `query` (`.upstream/docs/cli/logseq-cli.md:218-262, 323-325`, verified). But it signs in with the owner's full Cognito refresh token, because PATs are not accepted on `/sync` (ADR 0023). Its `query` is an unbounded `d/q` (`frontend/worker/handler/query.cljs:18-21`), and `db_worker_node.cljs:451-453` sets every HTTP timeout to 0. claude.ai cannot reach it without a tunnel, which reverses README's "needs neither the desktop app nor a tunnel". Upstream's Node db-sync adapter exists but is a full server (ADR 0001 is still "Proposed").

### 3. A bounded engine

- **Datascript version (verified).** The Logseq fork `logseq/datascript` is pinned by sha `3f141af` in `deps/db-sync/deps.edn`, separately from `UPSTREAM_REF`. `query.cljc` is 994 lines. Patch 0039 already instruments it with `set!` on public vars (`datalog.cljs:651-790`), and those hooks fire in the release build (the work cap stopped the rule tree there at 9.4 to 10.1 s).
- **Why the caps miss rule trees (verified).** `expand-rule` does a `postwalk` per branch, plus `rule-gen-guards` and `split-guards`. That costs 50 to 65 µs per frame, while the work cap charges about one row (~0.25 µs) per leaf. A 5×10 tree (10^5 leaves) took 5,548 ms with 1 datom scanned and `work` 100,001; larger trees stop at the cap after 9.7 to 10.0 s (`exp/rule-tree.mjs`, `rule-tree2.mjs`). The review's exact "200 trees, 57 s" shape was not reproduced.
- **Fuel counter, CLJS (verified, `exp/fuel2.mjs`, dev build, 300-page graph, per-construct caps lifted).** One 200,000-unit budget charged 250 per rule frame (`rule-gen-guards`), 20 per clause (`-resolve-clause`, both arities), 1 per row in `hash-join`, `subtract-rel`, `prod-rel` and `sum-rel`, and 5 per row into `-call-fn`.

  | Hostile case | Before | With fuel |
  |---|---|---|
  | Rule tree 5×10 (10^5 leaves) | 5,548 ms | 138 to 192 ms |
  | Rule tree 10^7 leaves | 10,031 ms (work cap) | 81 ms |
  | 155 flat nots | 275 ms | 87 ms |
  | Nots through rules 10×10×10 | 1,590 ms | 59 ms |
  | 110 not-joins / 65 negated or-joins | bounded by work cap | 60 / 90 ms |

  Legitimate shapes still answer: an ancestors rule down a 60-deep chain spends 96k to 106k units (half the budget, so the clause weight needs tuning); a tag plus not-join spends 8.8k; pages missing a property 150; a three-level tag rule 2.4k. Warm median overhead over 15 runs was -10 % to +8 %.
- **Fuel counter, JVM (verified, `scratchpad/exp2.clj`, 5-line change to a scratch copy of `query.cljc`).** Fuel tracks frame count; a 10×4 tree exhausts a 20,000 budget in 120 ms against 193 ms unbounded and growing tenfold per level.
- **Does it close the class?** Inferred, not proved. It moves the bound to "every Datascript step is a frame, a clause, a relation operation or a call, and each is charged". CPU is then at most the budget times the worst cost per step. That step cost still depends on the per-step caps (scan cap per lookup, text and value caps per call), which must stay. The weights are a calibration to redo on a Datascript bump or new hardware. Value amplification was not tried against it.
- **Source fork.** Copying `query.cljc` into db-sync's `src` would likely shadow the dependency (inferred, not tried), and `scripts/fetch-upstream.sh` patches only the logseq tree, so a fork must be re-merged by hand on every bump. Hooks are cheaper.
- **Cooperative yielding.** Not feasible without a new evaluator. `d/q` is a synchronous reduce, `solve-rule` is a loop with no resumable state, and `run-query` runs `d/q` and `doall` with no `await` (`datalog.cljs:1040+`, verified). No input gate opens during the query, so sync waits for all of it (verified by reading code). A runaway blocks only that graph's DO (`dispatch.cljs:28`).
- **Wall clock.** Not usable: Workers freeze `Date.now()` during synchronous work (the repo's spec, section 2; not re-checked against the docs).

### 4. A restricted language

**What the owner's uses need (verified from `worker/named_queries.cljs`).**

| Use | Needs | No caller rules | Non-recursive rules only | Whitelist / small DSL |
|---|---|---|---|---|
| Projects untouched | `not-join`, `get-else`, `missing?`, pull | Works (named) | Works | Needs a "newest block update per page" primitive |
| Meetings without decisions | Recursive `above` rule, `not-join` | Works (rule is server data) | Breaks unless unrolled to a fixed depth | Needs an ancestor primitive |
| Open tasks by client | `or-join` ×2, `not`, `get-else`, `missing?`, `ground` | Works (named) | Works | Needs or-joins over status and client |
| Pages missing a property | One pattern plus `missing?` | Works | Works | Works |
| Ancestors (ad hoc) | Recursive rule | Lost for callers | Lost beyond the unrolled depth | Only as a built-in |
| Tag inheritance | Done in the handler (`resolve-tag-param`, class lineage passed as inputs) | Works | Works | Works |
| Other ad-hoc questions | Unknown: the repo records none | Partly lost | Partly lost | Lost unless the DSL covers it |

So refusing caller rules loses only caller-written recursion. The four named queries run through the same validator with server-side rules (`datalog.cljs:1331`; test `every-entry-validates-test`).

**Other systems (all remembered, not verified this session).** Datomic has a per-query `:timeout` on `q`; it works because the JVM peer can interrupt a thread, which a synchronous Worker cannot. XTDB and Datalevin offer timeouts in the same way. Roam's query API is rate-limited, with a server-side timeout. Logseq's app runs `d/q` unbounded on the user's own machine (`:thread-api/q`, verified in code), and upstream's CLI checks only one thing (`cli/lib/query.ml` refuses `:db/id` as an attribute, verified). SQLite has `sqlite3_progress_handler` and `sqlite3_interrupt`, but no such API was found for DO SQL or D1 (inferred); D1 lists a 30 s maximum query duration (snippet). Each of these relies on preemption or a wall clock, which this runtime lacks. That is why counting work is the only in-process option here.

**Static cost estimation.** Not tried. Datalog's cost depends on the data and on how rules fan out, so a static estimate would be another per-construct heuristic (inferred).

### 5. Other engines and data paths

- **SQL over DO SQLite.** Not practical (verified from `storage.cljs:28-45`). The DO holds `kvs(addr, content, addresses)` of transit-encoded B-tree nodes, plus `tx_log` and `sync_meta`. There is no datoms table, so SQL cannot see datoms without a second, maintained schema, and every query would count rows read against the 5M daily cap. No progress or interrupt API was found (inferred).
- **D1.** Same problem: a second schema, plus D1 rows on every query and every write.
- **Precomputed index.** `kb_index` is page-level only (`connector/src/tools/kb-index.ts`), so it answers "pages missing a property" if values were added, but not "projects untouched" or "open tasks by client". Those need block-level state. An hourly refresh writing changed rows would be about 480 to 4,800 D1 writes a day (inferred), but the refresh itself still runs Datalog in the sync DO. It moves queries off the interactive path; it does not isolate them.

## Cost

Measured or taken from the spec at `7d04944`. Per call: 2 Worker requests, about 1 D1 row read, 2 D1 rows written, no AI or Vectorize. At 1,000 calls a day that is 2 % of requests and writes. The budget risk is a looping agent: 120 reads a minute × 2 requests reaches 100k requests in about 7 h, faster than the usage report's 6-hourly checks (`.github/workflows/usage.yml`). A 57 s runaway is about 7 GB-s of DO duration, 0.05 % of the 13,000 GB-s in `scripts/usage-report.mjs`. So a runaway costs availability (blocked sync, a reset), not budget. A fuel counter costs nothing extra to run. A replica costs a full kvs rewrite on bootstrap and the kvs rows of every write again.

## Risks

- Merging item 40 as it stands ships a tool that returns nulls in production (verified).
- Shipping free-form Datalog with caller rules leaves a measured 5 to 10 s sync block, and possibly up to 30 s if that is the Free DO CPU limit (inferred).
- Fuel weights are calibrated on one Node machine at 300 pages. On workerd hardware or a larger graph they may refuse legitimate recursion or allow too much.
- The hooks depend on Datascript's internal function names and arities. A fork bump that renames them fails the dev-build tests, but only a release-build test proves the deployed behaviour.
- Named queries on a large graph are still unbounded by shape (backlog 24, projects untouched).

## What would change the answer

- **Docs or a throwaway Free-plan DO showing a short CPU limit (for example 30 s or less) and a clean kill that keeps sync usable** would make the caps a softer problem. A long limit, or kills that drop WebSocket clients, would strengthen the case for a replica.
- **The owner relying on ad-hoc recursive queries** would push the fuel counter from "next" to "required before free-form ships".
- **The fuel counter failing on a value-amplification or workerd re-run** would push towards the replica DO.
- **A move to the Paid plan** would make Containers or `limits.cpu_ms` viable and reopen G.
- **Items 3 and 4 having concluded in favour of a local replica** would make I the default for Claude Code use.

## Follow-ups

1. **Fix the release build's Datascript externs (blocks item 40).** Add `:externs ["datascript/externs.js"]` to the `:db-sync` build in `deps/db-sync/shadow-cljs.edn`, through patch 0039 or its own patch. Add a CI step that runs a datalog query against the release bundle, plus a smoke-test call to `/query`. It must fail without the fix.
2. **Refuse caller `rules` in `datalog_query`, or drop the tool from the item 40 PR (owner decides).** Keep named queries. Update the tool description, `connector_help`, `tools-manifest.json` and README §11.8.
3. **Fuel counter.** Replace the join, work and call counters with one budget charged at rule frames, clause resolution, relation operations and calls. Calibrate the weights on the release build, add hostile and legitimate test cases, and keep the scan, value and text caps.
4. **Measure the Free plan DO CPU limit and kill behaviour.** Fetch the DO limits page. Run a busy-looping throwaway DO and record the status, error text, `wrangler tail` output and whether WebSocket clients drop. Record the result in `docs/solutions`.
5. **Map CPU-kill errors in the connector.** Give a non-JSON 5xx or a rejected `env.SYNC.fetch` a named message instead of a bare HTTP code or an unmapped throw.
6. **Replica DO design (revisit).** Only if 3 or 4 fall short. Settle the snapshot `t`, whether kvs addresses are write-once, and the row cost of bootstrap at the owner's graph size.
7. **A per-tool rate limit for the query tools.** Lower than the shared 120 reads a minute, so a looping agent takes longer than one usage-report interval to exhaust the daily requests.

## Verified versus inferred

| Claim | Status | Source |
|---|---|---|
| Release build returns nil for datom values; externs fix it | Verified | Bundle text; `exp/release-do*.mjs`, `bisect.sh` at `7d04944` |
| Rule tree 10^5 leaves 5.5 s; cap reached at ~10 s, dev and release | Verified | `exp/rule-tree*.mjs`, `release-do2-H.mjs` |
| Fuel counter stops hostile cases in 24 to 192 ms, overhead -10 % to +8 % | Verified (15 cases, Node) | `exp/fuel2.mjs`, `fuel-counts.json`, `exp2.clj` |
| Fuel counter closes the class | Inferred | Structure plus the cases above |
| Caller rules off keeps the four named queries working | Verified | `named_queries.cljs`, `datalog.cljs:1331` |
| Memory 259 to 266 B per datom (EAVT only) | Verified | `exp/mem.mjs` |
| Rows per write (1 or 147 kvs rows) | Verified | `exp/writes.mjs` |
| Query blocks the graph's sync DO for its whole run | Verified (code) | `semantic.cljs:40-47`, `datalog.cljs:1040+` |
| DO CPU 30 s default, Free split unknown | Inferred | Search snippet, docs not fetched |
| Front Worker 10 ms, 128 MB, 100k requests, error 1102 | Inferred (matches CLAUDE.md) | Search snippet |
| CPU kill text, status and scope | Unknown | Not tested |
| No progress or interrupt API in DO SQL or D1 | Inferred | Absent from snippets |
| Containers are Paid only, with the pricing above | Inferred | Search snippet |
| Datomic, XTDB, Datalevin and Roam timeouts | Inferred (remembered) | Not fetched |
| Items 3 and 4 spike conclusions | Unknown | No write-up in any ref |

## Related files

- `docs/solutions/api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md`
- `docs/superpowers/specs/2026-11-09-datalog-query-named-queries-design.md` (sections 2, 3.5, 3.9, 5, 10, 11)
- `patches/0039-semantic-datalog-query.patch` (`datalog.cljs`, `named_queries.cljs`; on the queries branch)
- `scripts/bench-datalog-query.mjs`
- `.upstream/deps/db-sync/shadow-cljs.edn`, `.upstream/shadow-cljs.edn:28-32`
- `.github/workflows/ci.yml:65-78`, `scripts/smoke-test.sh`, `scripts/build.sh`
- `connector/src/sync.ts`, `connector/src/tools/semantic.ts`, `connector/src/tools/common.ts`
- `config/expected-bindings.json`, `scripts/check-upstream-bindings.mjs`, `scripts/render-wrangler.mjs`
- `docs/spike-results.md` (S3)
- `docs/solutions/sync/snapshot-is-kvs-only-and-tx-log-has-no-author.md`
- `docs/solutions/cost/d1-reads-from-indexer-scans.md`
- README backlog items 21, 23, 24, 25
