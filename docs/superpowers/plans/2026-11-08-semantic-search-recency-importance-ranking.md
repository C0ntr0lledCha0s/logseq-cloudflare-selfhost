# Semantic search memory ranking: recency, importance and demotion: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stage 1, `scripts/check.sh` in Stages 2 to 5), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `semantic_search` gains an opt-in `rank: "memory"` that multiplies the fused RRF score by a recency factor (from `updated-at`, with a half-life) and an importance factor (from the reference count, demoted once for done or canceled status, a `demote_tags` tag or a `demote_property` value). Old, archived and done items rank lower but stay in the results. Every memory hit reports its raw relevance beside the factors. `updated_after` filters candidates before fusion in either mode. The default, `rank: "relevance"`, is byte-for-byte today's output.

**Architecture:**
- **One upstream patch, `patches/0035-semantic-get-blocks-signals-view.patch`** (Stage 1). `getBlocks` gains `view=signals` and an optional `property` query parameter, returning per id only `uuid`, `updated-at`, `reference-count` (capped at 1,000), `status` and `property-values`. No new route; the OpenAPI `view` enum, a `property` parameter and a `SignalsResponse` schema change, so the generated `get_blocks` tool changes.
- **No migration, no indexer change, no reindex.** Signals are read at query time with one `getBlocks` call (spec §2: a stored reference count would go stale). D1 reads are unchanged.
- **Pure scoring** in `connector/src/semantic/ranking.ts` (`memoryFactors`, `applyMemoryRanking`), constants in `connector/src/semantic/config.ts`. `connector/src/tools/semantic-search.ts` fetches signals and wires them into `hybridSearch`.
- **RRF is unchanged.** Memory mode re-ranks the whole fused list after RRF and before `slice(limit)`.
- **Order:** the server view first (nothing calls it yet), then the fake signals route and the extended eval with its relevance-mode baseline on unchanged ranking code, then the pure scoring functions (not wired), then memory mode in the tool, then `updated_after`. The eval's numbers after Stage 4 show what memory mode alone did.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real handler on a real conn); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1, the real indexer and `SemanticStore`, `FakeVectorIndex`, `FakeEmbedder`/`CraftedEmbedder` and `FakeGraph` from `connector/test/semantic-fakes.ts`, the `SYNC` binding faked at HTTP level by `fakeSync`).

**Spec:** `docs/superpowers/specs/2026-11-08-semantic-search-recency-importance-ranking-design.md`. Read it first. It is the authority; section numbers below (§3.4 and so on) are the spec's.

## Global constraints

- **Names, exactly:**
  - patch `patches/0035-semantic-get-blocks-signals-view.patch`; upstream test namespace `logseq.db-sync.semantic-signals-view-test` in `deps/db-sync/test/logseq/db_sync/semantic_signals_view_test.cljs`, required from `test_runner.cljs` after `semantic-edit-stamps-test`; in `worker/handler/semantic.cljs`, `reference-count-cap` (1000), `capped-referrer-count`, `signals-response` and `signals-property`, placed next to `bulk-read-response`;
  - response fields `uuid`, `updated-at` (ms or `null`), `reference-count`, `status`, `property-values`; errors `property not found: <ident>` and `property needs view=signals` (400); the view check's message becomes `view must be summary, outline or signals`;
  - `config.ts` adds `RECENCY_FLOOR = 0.5`, `REF_WEIGHT = 0.1`, `IMPORTANCE_MAX = 1.5`, `DEMOTE_WEIGHT = 0.5`, `DEFAULT_HALF_LIFE_DAYS = 90`, `SIGNALS_LIMIT = 100`, `REFERENCE_COUNT_CAP = 1000`;
  - `ranking.ts` exports `RankingSignal`, `MemoryOptions`, `MemoryFactors`, `memoryFactors(signal, tags, opts)` and `applyMemoryRanking(fused, factorsOf)`;
  - tool arguments `rank`, `half_life_days`, `demote_tags`, `demote_property` (`{property, values}`), `updated_after`; hit fields `relevance`, `recency`, `importance`, `updated-at`, `reference-count`, `demoted-by`; top-level `rank`, `half-life-days`, `before-updated-after` (spec §3.5, §4).
- **Messages, in the spec's wording:** `half_life_days needs rank: "memory"` (and `demote_tags`, `demote_property` likewise, checked in argument order before any call); `updated_after: not an ISO date`; `ranking signals: <reason>`, keeping the sync failure's `ToolError` code as `keyword search for "<term>"` does.
- **Relevance mode is untouched.** Without `rank: "memory"`, `updated_after` or `demote_property`, no signals request is made and the output is identical to HEAD's. A test compares the JSON of a relevance call before and after for the same fixture.
- **Raw values are reported; the product only orders.** `relevance` is the RRF score at 5 dp; `score` in memory mode is the final product at 5 dp; `recency` and `importance` at 3 dp. The sort uses unrounded values and is stable, so ties keep RRF order.
- **Demotion applies once.** Every matching rule is listed in `demoted-by` (`status:done`, `status:canceled`, `tag:<name as given>`, `property:<value as given>`), but `DEMOTE_WEIGHT` multiplies once (spec §3.4, call).
- **Time is an input.** `memoryFactors` takes `now` in `MemoryOptions`; `HybridSearchDeps` gains `now?: () => number` (default `Date.now`). The eval fixture states ages as `age-days`, and `FakeGraph` turns them into `updated-at` against the request's `Date.now()`, so ages never drift (plan call; this is spec §3.7's "fixed now" without faking the clock in workerd).
- **Free plan** (spec §5, REVIEW.md *Cost*). Memory mode, `updated_after` or `demote_property` adds exactly one sync call (`getBlocks` `view=signals`, at most 100 ids, one call), 0 D1 rows, 0 neurons, 0 Vectorize calls. Tests pin it with `FakeGraph.signalsRequests`, `searchRequests`, `FakeVectorIndex.queries` and `FakeEmbedder.calls`, and a D1 statement count that shows `blocksFor`, `state` and `counts` are still the only reads. Each stage's commit body states its cost per query.
- **Tests run the real thing.** Upstream tests use the real handler and a real datascript conn. Connector ranking tests go through `hybridSearch` or the `semantic_search` tool with the real `SemanticStore` on D1 and the real indexer; only the embedder, Vectorize and the sync server are faked. The pure-function tests in Stage 3 pin the arithmetic; Stage 4 proves the wiring. Each rule's test has a decoy that only that rule separates (`docs/solutions/testing/untested-rules-survive-mutation.md`). Each new test is first seen to fail; keep the failure text for the PR.
- **The eval is a gate.** Relevance-mode numbers on the 12 old questions equal the recorded `baseline` (1.00, 0.85) in every stage. From Stage 2, the memory questions carry their own `baseline` and `floor`; a stage raises `floor` and never lowers it without saying why. Run it with `npx vitest run test/semantic-eval.test.ts --silent=false --disableConsoleIntercept` (from `connector/`) and paste the table into the commit body.
- **Contract with Claude.** A stage that changes a tool's input or output updates its description and `SEMANTIC_HELP` in the same commit and runs `npm --prefix connector run update:manifest` (or `node connector/scripts/check-tools-manifest.mjs` to show it is unchanged; say which). README §11.8 and §11.11 are the docs stage's, after the build.
- **Commits** follow `type(scope): what changed` (scopes `api`, `semantic`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page UUIDs, property idents, hostnames or tokens. Fixtures use example data ("Pricing", "Office move plan", `user.property/project-status`); docs use `sync.example.com` and `mcp.example.com`.

### Working on patch 0035 (Stage 1)

Follow the `add-upstream-patch` skill. Once, before Stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0034
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0034"
git -C .upstream tag -f baseline
```

After the code and tests pass:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-signals-view|semantic-bulk|semantic-private-tags'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0035-semantic-get-blocks-signals-view.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 35 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/` and the vendored files carry the change.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost*, *Contract and docs*, *Tests* and *Connector*.
- `semantic.cljs`: `max-batch-size` (`:1244`), `reference-attributes` and `referrer-ids` (`:2006`), `bulk-read-response`, `block-detail-response`, the `getBlocks` handler and its view check (`:4184`); `test/logseq/db_sync/semantic_bulk_test.cljs` (its `ids-path` and `request!` helpers, and the `view=tree` refusal at `:116`).
- `connector/src/tools/semantic-search.ts` (all of it), `connector/src/semantic/ranking.ts`, `rrf.ts`, `config.ts`, `store.ts` (`blocksFor`, `StoredBlock.tags`).
- `connector/test/semantic-fakes.ts` (`FakeGraph`, `failStatus`, `searchRequests`, `fakeSync`'s route regex, `CraftedEmbedder`), `connector/test/semantic.test.ts` (`callTool`, `runUntilReady`, `semanticEnv`), `connector/test/semantic-eval.test.ts` and its fixture.
- `docs/solutions/testing/untested-rules-survive-mutation.md`, `docs/solutions/semantic/loose-keyword-hits-fuse-as-high-as-meaning.md`, `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`, and the previous plan, `docs/superpowers/plans/2026-11-07-semantic-search-ranking-quality.md`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **An entity's own child refers to it, and a hidden block refers to it:** neither counts; a referrer on another page does (Stage 1).
2. **An entity with more than 1,000 referrers:** `reference-count` is exactly 1,000, and the walk stops early (the test checks the count, the code review checks the early stop) (Stage 1).
3. **`property` given with a block that has no value but whose page has one, and a sibling with another value:** the block reports its page's value, the sibling its own (Stage 1).
4. **`property` naming a page or a tag, not a property:** 400 `property not found: <ident>` (Stage 1).
5. **The same uuid in both legs:** it is sent to the signals call once; the union is de-duplicated and capped at `SIGNALS_LIMIT`, semantic candidates first (Stage 4).
6. **A uuid under `missing`:** neutral recency (1) and base importance (1, unless a stored tag demotes it), not dropped in memory mode; dropped by `updated_after` (Stages 4 and 5).
7. **`updated-at` in the future** (clock skew): recency 1, not above 1 (Stage 3).
8. **`reference-count` 0:** importance is exactly 1 (`log2(1)` is 0), not `NaN` or 0 (Stage 3).
9. **`demote_tags: ["Archives"]` against a stored tag `archives` inherited from the page, and a decoy `archive`:** the first matches (stored tags are lowercased, the argument is lowercased once), the second does not (Stage 3).
10. **A hit that is 11th by relevance and 1st by memory at `limit` 10:** returned, because the slice comes after the re-rank (Stage 4).
11. **`half_life_days: 30` with `rank` omitted:** refused before any sync or Vectorize call (Stage 4).
12. **`updated_after` that is `2026-02-30`, `yesterday` or `2026-11-08T10:00` (no zone):** the first two refused; the third accepted only if the regex for a full ISO date-time allows it; pin whichever the spec's "full ISO date-time" means (plan call: require seconds and a `Z` or offset) (Stage 5).
13. **`updated_after` removes every semantic hit:** `results` holds keyword hits only, ranks renumber, `before-updated-after` counts the drops from both legs (Stage 5).

---

### Stage 1: Patch 0035, `getBlocks` `view=signals`

**Goal:** the sync server answers `GET /api/v1/graphs/{graph-id}/blocks?ids=…&view=signals[&property=…]` as spec §3.1. Nothing in the connector calls it yet; the generated `get_blocks` tool gains the enum value and parameter. Lands spec §3.1 and the patch half of §8.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/test/logseq/db_sync/semantic_signals_view_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs` (the view check, `signals-response`, `capped-referrer-count` as a bounded walk over each reference attribute's avet datoms that stops at `reference-count-cap` distinct visible referrers, using the same visibility and own-block exclusions as `referrer-ids`, `signals-property`); the OpenAPI source for `getBlocks` (enum, `property`, `SignalsResponse`, summary text naming the 1,000 cap).
- Create: `patches/0035-semantic-get-blocks-signals-view.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`), `connector/tools-manifest.json` if the check says so.

**Interfaces produced:** `view=signals`, `property`, the response `{blocks: [{uuid, updated-at, reference-count, status, property-values}], missing}`.

- [ ] **Step 1: Write the failing tests** (spec §8, upstream), on a real conn through the real handler:
  - `counts referrers on other pages only`: entity A; a block on another page referring to A (counted); A's own child referring to A (not counted, review focus 1); a referrer inside a hidden/`#private` subtree as `referrer-ids` treats it (not counted). `reference-count` is 1.
  - `the count stops at 1000`: seed 1,005 referrers; `reference-count` is 1000 (review focus 2).
  - `status`: a done task gives `"done"`, a canceled one `"canceled"`, a plain block `null`.
  - `property-values`: a block with the property gives its titles; a block without it on a page that has it gives the page's titles; a sibling with another value gives its own (review focus 3); no `property` gives `null`; neither has a value gives `[]`.
  - `refusals`: unknown ident, a page ident and a tag ident each answer 400 `property not found: <ident>` (review focus 4); `property` with `view=summary` answers 400 `property needs view=signals`; `view=tree` answers `view must be summary, outline or signals`.
  - `missing and updated-at`: an unknown uuid is under `missing`; `updated-at` equals `(:block/updated-at (d/entity …))`; more than 100 ids answers the existing limit error.
  - `no text`: the response has no `title` or `properties` key, so an E2EE graph's request answers the view too.
- [ ] **Step 2: Run on the unpatched tree** and keep the failures (today: 400 `view must be summary or outline`).
- [ ] **Step 3: Implement** as spec §3.1. Read `reference-attributes` once per request. Update `semantic_bulk_test.cljs`'s expected view message.
- [ ] **Step 4: Contract.** The OpenAPI summary carries the text; regenerate the vendored API and the manifest. The connector's tool tests (`tools.test.ts`) must pass with the new `get_blocks` schema; if a snapshot of tool schemas exists, update it in this commit.
- [ ] **Step 5: Run the patch workflow above, then the gate:** `scripts/check.sh --upstream`. **Mutation check:** drop the cap; count the entity's own blocks; drop the visibility check; read the property from the page first; return `[]` instead of `null` with no `property`. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(api): add view=signals to getBlocks for ranking signals`. Body: the quoted unpatched failure, the cap and why (spec risk 3), and that nothing calls it yet (cost: none until Stage 4).

**Done when:** all 35 patches apply from scratch, the new upstream namespace passes in the whole db-sync suite, the vendored API and `get_blocks` show `signals` and `property`, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Fake signals route and the extended eval, measured on unchanged ranking

**Goal:** `FakeGraph` serves `view=signals` with the patch's behaviour; the eval fixture holds the stale-against-current cases; relevance-mode numbers on the extended fixture are recorded as the memory questions' `baseline` and `floor`, before any ranking code. Lands the "before" half of acceptance 7 and spec §3.7's Stage 1 requirement.

**Files:**
- Modify: `connector/test/semantic-fakes.ts`:
  - `FakeBlock` and `FakePage` gain optional `signals: { ageDays?: number | null; referenceCount?: number; status?: string | null; properties?: Record<string, string[]> }`;
  - `FakeGraph.signalsRequests: URL[]`, `failSignals: number | null`;
  - `fakeSync`'s route regex adds `blocks`; `GET …/blocks?view=signals` answers as the patch does: ids split on `,`, at most 100, `missing` for unknown ids, `updated-at` = `Date.now() - ageDays * 86_400_000` (or `null`), `reference-count` capped at 1,000, `status`, `property-values` from the block then its page, `null` without `property`, 400 `property not found: <ident>` when no block or page in the graph declares that ident (plan call: the fake has no schema, so "declared" means present in some `properties` map or listed in `FakeGraph.properties`); any other `view` answers 599 so an accidental call fails loudly.
- Modify: `connector/test/fixtures/semantic-eval.json`: the four cases of spec §3.7 (pages "Pricing", "Domain renewals", "Office move plan" and an "old decision" page; keys such as `pricing-v1`, `pricing-v2`, `domain-done`, `domain-open`, `office-archived`, `office-current`, `old-decision`), each with `signals`; questions in a new `memory` list carrying `rank: "memory"` and, for the office case, `demote_tags: ["Archives"]`; top-level `memory: { baseline, floor }` beside the existing `baseline` and `floor`.
- Modify: `connector/test/semantic-eval.test.ts`: runs the old questions as now and the memory questions in relevance mode (it sends no `rank` yet; the arguments are read from the fixture and sent from Stage 4); prints a second table for the memory questions; asserts the old questions still meet `baseline` exactly; asserts each memory question's `top` in a test declared `it.fails(...)` with a comment naming Stage 4.
- Modify: `connector/test/semantic.test.ts`: a `describe("fake signals view")` block testing the fake itself against the patch's contract.
- Modify: the spec's §9 results table, row "Offline, extended fixture, before ranking code".

- [ ] **Step 1: Write the failing tests.** The fake's contract tests (missing, cap, page fallback, `null` without `property`, `property not found`, 599 for another view) fail with no route. The eval's memory-question `top` test is first a plain `it(...)`; keep its failure (the stale v1, done and archived blocks at or above their current twins in relevance mode) for the PR.
- [ ] **Step 2: Record the baseline.** Copy the memory questions' relevance-mode recall@5 and MRR into `memory.baseline` and `memory.floor` (identical in this stage) at 2 dp, and into the spec's table. Confirm the old questions still print 1.00 and 0.85. Then mark the `top` test `it.fails`.
- [ ] **Step 3: Implement.** Test code and fixture only; no source change.
- [ ] **Step 4: Contract.** None.
- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** make the fake read the page's property before the block's; drop the 100-id limit; raise `memory.floor` MRR by 0.01. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `test(semantic): add stale-against-current eval cases and a fake signals view`. Body: both eval tables, the quoted `top` failures, and that relevance numbers on the old questions are unchanged.

**Done when:** the fake matches the patch's contract under test, the fixture holds the four cases, the memory baseline is recorded from unchanged code, the known-failing `top` test is marked, and the gate is green.

---

### Stage 3: The scoring functions

**Goal:** `memoryFactors` and `applyMemoryRanking` exist and are pinned against every boundary in spec §3.4. Nothing calls them; the eval is unchanged. Lands spec §3.4 and the unit half of §8.

**Files:**
- Modify: `connector/src/semantic/config.ts` (the seven constants above).
- Modify: `connector/src/semantic/ranking.ts`:
  ```ts
  export interface RankingSignal { updatedAt: number | null; referenceCount: number; status: string | null; propertyValues: string[] | null }
  export interface MemoryOptions { now: number; halfLifeDays: number; demoteTags: readonly string[]; demoteValues: readonly string[] }
  export interface MemoryFactors { recency: number; importance: number; demotedBy: string[] }
  export function memoryFactors(signal: RankingSignal | undefined, storedTags: readonly string[], opts: MemoryOptions): MemoryFactors
  export function applyMemoryRanking<T extends { id: string; score: number }>(fused: readonly T[], factorsOf: (id: string) => MemoryFactors): (T & MemoryFactors & { relevance: number; final: number })[]
  ```
  An `undefined` signal (a uuid under `missing`) is `{updatedAt: null, referenceCount: 0, status: null, propertyValues: null}`. Matching lowercases both sides once; `demoted-by` keeps the caller's spelling.
- Modify: `connector/test/semantic.test.ts` (new `describe("memory ranking")` block).

- [ ] **Step 1: Write the failing tests** (spec §8, connector unit tests), each with a decoy only its rule separates:
  - `half-life`: a hit exactly `halfLifeDays` old has recency 0.5 × a fresh one's at 90 and at 30 days; fails if the base or divisor changes.
  - `floor`: a hit 10 half-lives old with RRF score 2/61 stays above a fresh hit with 1/62 (0.01639 against 0.01613); fails with a floor of 0.25.
  - `null and future updated-at give recency 1` (review focus 7).
  - `references`: equal relevance, 3 references above 0 (importance 1.2 against 1, to 3 dp); 0 references give exactly 1 (review focus 8); 31 and 500 both give 1.5; fails if `REF_WEIGHT` is 0.25 or `IMPORTANCE_MAX` 2.
  - `status`: `done` and `canceled` demote; `todo` and `doing` don't.
  - `demote tags`: `["Archives"]` matches stored `archives` (inherited from the page; the stored list already holds it); `archive` does not match `archives` (review focus 9).
  - `demote property`: values match `propertyValues` case-insensitively; another value doesn't; `propertyValues: null` never matches.
  - `once only`: status done, a matching tag and a matching value give importance 0.5 × base, not 0.125 ×, and `demotedBy` lists all three in rule order (status, tags, property).
  - `stable`: two hits with equal final scores keep RRF order; `relevance` is the input score, `final` the product.
- [ ] **Step 2: Run and keep the failures** (no exports).
- [ ] **Step 3: Implement** as spec §3.4. `Math.max(RECENCY_FLOOR, 0.5 ** (age / halfLife))`; `Math.min(IMPORTANCE_MAX, 1 + REF_WEIGHT * Math.log2(1 + count))`.
- [ ] **Step 4: Run the eval** and confirm both tables equal Stage 2's.
- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** each constant (floor 0.25, weight 0.25, max 2, demote 0.25, half-life 30 as default); `>` to `>=` on the future check; demotion per rule instead of once; drop `canceled` from the status list; remove the lowercasing of the argument; unstable sort (`b.final - a.final || Math.random() - 0.5`). Confirm a test fails for each; keep the list for the PR. Revert.
- [ ] **Step 6: Commit.** `feat(semantic): add memory ranking factors for recency, references and demotion`. Body: the arithmetic of spec §3.4 the tests pin, the mutation results, no behaviour or cost change.

**Done when:** each rule and constant is pinned, nothing calls the functions, the eval is unchanged, and the gate is green.

---

### Stage 4: `rank: "memory"` in `semantic_search`

**Goal:** `semantic_search` accepts `rank`, `half_life_days`, `demote_tags` and `demote_property`; memory mode makes one signals call, re-ranks the whole fused list, then slices; hits report the factors. Lands acceptances 1 to 4 and 6, and the "after" half of 7.

**Files:**
- Modify: `connector/src/tools/semantic-search.ts`:
  - `fetchSignals(access, alias, graphId, pat, uuids, property?)`: one `graphFetch` `GET /api/v1/graphs/{id}/blocks` with `ids` joined by `,`, `view=signals` and `property`; any failure is rethrown as `ranking signals: <reason>` with the sync `ToolError` code kept;
  - `hybridSearch` args gain `rank`, `half_life_days`, `demote_tags`, `demote_property`; the guards run first, before `resolveGraph`; after `blocksFor`, when `rank === "memory"` or `demote_property` is given, the union of surviving semantic uuids then keyword uuids, de-duplicated and capped at `SIGNALS_LIMIT` (review focus 5), goes to `fetchSignals`; after RRF (no slice), `applyMemoryRanking` with `storedTags` from `byUuid`, then `slice(limit)` (review focus 10);
  - `SearchHit` gains the optional memory fields; the response gains `rank: "memory"` and `half-life-days`;
  - `HybridSearchDeps.now?: () => number`;
  - `inputSchema` per spec §4 (`rank` enum default `"relevance"`, `half_life_days` int 1 to 3650, `demote_tags` up to 10 non-empty strings, `demote_property` `{property: string, values: 1 to 10 strings}`);
  - the description and `SEMANTIC_HELP` per spec §3.8 (formula, ranges, default unchanged, `relevance` against `score`, missing uuids neutral, `demote_tags` only sees indexed hits, recency is the block's own last edit, when to use each mode).
- Modify: `connector/test/semantic.test.ts`, `connector/test/semantic-eval.test.ts` (memory questions sent with their `rank` and options; the `top` test becomes `it(...)`; `memory.floor` raised), `connector/tools-manifest.json` via `update:manifest`, the spec's §9 table ("after" rows for both modes).

- [ ] **Step 1: Write the failing tests** (spec §8, `hybridSearch` tests), through the tool with real D1 and the real indexer:
  - `relevance mode is unchanged`: `signalsRequests` is empty and the JSON equals a call made with no new arguments, for a fixture with signals.
  - `memory mode makes one signals request with the candidate union`: a uuid in both legs appears once (review focus 5); with 60 semantic and 50 keyword candidates the request carries 100 ids, semantic first.
  - `the slice comes after the re-rank`: crafted cosines put a fresh, referenced block 11th by relevance and stale blocks above it; at `limit` 10 it is returned first (review focus 10).
  - `hit fields`: `score` is the product at 5 dp, `relevance` the RRF score, `recency`, `importance`, `updated-at` as ISO, `reference-count`, `demoted-by`; top-level `rank` and `half-life-days`.
  - `missing uuids get neutral factors and stay`: a block deleted on the fake after indexing (review focus 6).
  - `demote_property` reaches the request as `property` and demotes; `demote_tags` demotes an indexed hit by a page tag.
  - `guards`: `half_life_days`, `demote_tags`, `demote_property` without `rank: "memory"` each answer their exact message, with `FakeEmbedder.calls`, `FakeVectorIndex.queries` and `searchRequests` all 0 (review focus 11); zod refuses `half_life_days` 0, 3651 and 1.5, 11 tags, an empty tag and 0 or 11 values.
  - `a failing signals call fails the call`: `failSignals = 500` answers `ranking signals: …`; an unknown `property` answers `ranking signals: property not found: user.property/x`.
  - Cost: one embedding, one Vectorize query, the same search requests as relevance mode, one signals request, and the D1 statement count unchanged.
- [ ] **Step 2: Run and keep the failures.** The eval's `it.fails` test now passes once the memory arguments are sent; vitest reports it, which is the signal to flip it.
- [ ] **Step 3: Implement** as spec §3.3 steps 3 and 6, §3.5 and §3.6.
- [ ] **Step 4: Eval.** Flip the `top` test to `it(...)`. Each stale-against-current case has its current block first in memory mode, and the old-decision case is still in the top 5. Old questions in relevance mode print 1.00 and 0.85. Raise `memory.floor` to the new numbers and fill the spec's "after" rows.
- [ ] **Step 5: Contract.** Description, `SEMANTIC_HELP`, manifest (say whether it changed).
- [ ] **Step 6: Run the gate:** `scripts/check.sh`. **Mutation check:** slice before the re-rank; send only semantic candidates; skip the de-duplication; fall back to relevance on a signals failure; read tags from the signals instead of `blocksFor`; call signals in relevance mode. Confirm a test fails for each. Revert.
- [ ] **Step 7: Commit.** `feat(semantic): add rank: "memory" to semantic_search`. Body: both eval tables before and after, the failures seen, and cost per memory query (+1 sync call, 0 D1 rows, 0 neurons, 0 Vectorize; CPU one sort of at most 100).

**Done when:** memory mode re-ranks as specified with one signals call, relevance mode is unchanged and makes none, the eval's memory floor is raised with every case passing, the contract text and manifest match, and the gate is green.

---

### Stage 5: `updated_after`

**Goal:** `updated_after` drops candidates last updated before the date, or with no updated-at, in either mode, after the `tag` filter and before `min_similarity`, and counts them in `before-updated-after`. Lands acceptance 5.

**Files:**
- Modify: `connector/src/tools/semantic-search.ts`: parse and validate `updated_after` before any call (`YYYY-MM-DD` as midnight UTC, or a full ISO date-time with seconds and `Z` or an offset; `Date.parse` must succeed and round-trip the date part, so `2026-02-30` is refused); request signals when it is given in relevance mode too; filter both legs in order `tag`, `updated_after`, `min_similarity`; `before-updated-after` counts the drops from both legs, only when the argument is given; the description and `SEMANTIC_HELP` sentence; regenerate the manifest.
- Modify: `connector/test/semantic.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `drops before fusion and renumbers ranks`: an old semantic hit ranked 1 and an old keyword hit ranked 1 are dropped; the next hits report `semantic-rank` 1 and `keyword-rank` 1; `before-updated-after` is 2.
  - `drops a missing uuid` (review focus 6) and `keeps a hit updated exactly at the boundary` (`>=`).
  - `runs after tag and before min_similarity`: a hit removed by `tag` is not counted in `before-updated-after`; a hit removed by `updated_after` is not counted in `below-min-similarity`.
  - `in relevance mode it makes one signals request and leaves score as RRF`; without it, none.
  - `empties the semantic leg` (review focus 13).
  - `validation`: `2026-02-30`, `yesterday` and `2026-11-08T10:00` answer `updated_after: not an ISO date` with no sync call; `2026-11-08` and `2026-11-08T10:00:00Z` are accepted (review focus 12).
- [ ] **Step 2: Run and keep the failures.**
- [ ] **Step 3: Implement** as spec §3.3 step 4 and §3.6.
- [ ] **Step 4: Eval.** Unchanged from Stage 4 (no question uses `updated_after`); confirm.
- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** `>=` to `>`; keep `null` updated-at; filter after fusion; count tag-filtered hits; filter only the semantic leg. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(semantic): add updated_after to semantic_search`. Body: the failures seen, and cost: +1 sync call when given, 0 D1 rows.

**Done when:** the filter and its count behave as specified in both modes, the validation is pinned, the contract text and manifest match, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 (what Claude can do with `rank`, `half_life_days`, `demote_tags`, `demote_property`, `updated_after`, and `get_blocks` `view=signals`) and §11.11 (the formula and ranges, the order of operations, the reported fields, and the cost: per memory query +1 sync call, 0 D1 rows, 0 neurons, 0 Vectorize; per indexer run unchanged; no new vectors). README's list of patches gains 0035.
- **PR body:** before and after recall@5 and MRR for both modes (spec §9 table), Stage 1's unpatched failure and each stage's first failures, the mutation results from every stage, the commit the checks ran on, what `scripts/check.sh --upstream` skipped, whether `tools-manifest.json` changed, and the Logseq skill note (use `rank: "memory"` for "what is the current state of X", relevance for "what was decided back then"; pass the graph's archive tag as `demote_tags` and its project-status values as `demote_property`, named in the owner's skill, not the repo; read `relevance` beside `score` to see why a hit moved). The PR is stacked on the phase 3 branch and merges after it.
- **Live check** (spec §9): after deploy, three owner-picked questions in both modes at `limit` 5, recording the current note's rank and each hit's factors without page names, and one `get_blocks` `view=signals` call on 100 ids with its latency. Watch the next usage report.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 changes Stage 3's constants and the boundary tests' numbers; question 2 changes `DEFAULT_HALF_LIFE_DAYS`; question 4 (tags from the signals view) would add a field in Stage 1 and change Stage 4's tag source; question 5 changes `reference-count-cap`. Any change lands before the PR merges.
