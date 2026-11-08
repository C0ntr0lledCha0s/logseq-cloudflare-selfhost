# Semantic search ranking: similarity scores, short-block noise and the keyword leg: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every `semantic_search` hit shows its raw cosine similarity and its rank in each leg; an optional `min_similarity` drops weak meaning matches and says how many it dropped; one- or two-word blocks stop taking the top spot for multi-word questions; and the keyword leg searches a question's distinctive words instead of the whole phrase. The offline eval lives in the repo, records a baseline and a floor, and runs after every ranking change.

**Architecture:**
- **Connector only, query time only.** No patch, no migration, no change to the indexer, the stored vectors, the model or the sync server (spec §1, §3). Nothing needs a reindex, and one deploy reverts any rule. `scripts/check.sh` runs without `--upstream` in every stage.
- **One new pure module**, `connector/src/semantic/ranking.ts`, holds the tokeniser, the stopwords and the ranking rules. `connector/src/tools/semantic-search.ts` wires them into `hybridSearch`. Constants go in `connector/src/semantic/config.ts`.
- **RRF is unchanged.** `reciprocalRankFusion` still sees two lists, `semantic` and `keyword`, with `RRF_K = 60`. The short-block rule reorders the semantic list before fusion; the per-term keyword lists are merged into one list before fusion.
- **Order:** the stopword move first (it changes nothing, and must be proven to change nothing), then the extended eval and its baseline on unchanged ranking code, then the scores (plumbing, no ranking change), then each ranking rule in its own stage, so the eval's numbers after each stage show what that rule alone did.

**Tech stack:** TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1 in workerd, the real indexer, `FakeVectorIndex`, `FakeEmbedder` and `FakeGraph` from `connector/test/semantic-fakes.ts`, the `SYNC` binding faked at the HTTP level by `fakeSync`).

**Spec:** `docs/superpowers/specs/2026-11-07-semantic-search-ranking-quality-design.md`. Read it first. It is the authority; section numbers below (§3.2 and so on) and test letters ("spec test (a)") are the spec's §8.2 list.

## Global constraints

- **Names, exactly:**
  - `connector/src/semantic/ranking.ts` exports `STOPWORDS`, `contentWords(q)`, `distinctiveTerms(q)`, `wordCount(text)`, `demoteShortBlocks(semantic, textOf, query)` and `mergeKeywordLists(lists)`;
  - `connector/src/semantic/config.ts` adds `SHORT_BLOCK_WORDS = 2`, `SHORT_BLOCK_WEIGHT = 0.75`, `RANKED_QUERY_WORDS = 3`, `KEYWORD_TERMS = 3`, `KEYWORD_TERM_LIMIT = 20`; `KEYWORD_LIMIT = 50` stays and now caps the merged keyword list;
  - hit fields `similarity`, `semantic-rank`, `keyword-rank`; tool argument `min_similarity`; top-level field `below-min-similarity` (spec §4).
- **One tokeniser** (plan call, spec §3.2 and §3.3 read together). `contentWords(q)` lowercases, splits on runs of non-alphanumerics, drops `STOPWORDS`, drops words under 3 characters and de-duplicates, keeping first-appearance order. Both thresholds ("3 or more content words") count `contentWords(q).length`, so the short-block rule and the keyword leg always agree on whether a query is "multi-word". `distinctiveTerms(q)` is the `KEYWORD_TERMS` longest of `contentWords(q)`, ties by first appearance. `wordCount(text)` splits the block's stored `text` on whitespace (spec §3.2: "Stock on hand" is 3).
- **Messages, in the spec's wording:** `keyword search for "<term>": <reason>` (§3.3). zod's own range message for `min_similarity` outside 0 to 1.
- **Raw values are reported; adjusted values only order.** `similarity` is the Vectorize cosine rounded to 3 dp. The short-block weight and the `min_similarity` comparison use the unrounded value. `semantic-rank` and `keyword-rank` are the `ranks` `reciprocalRankFusion` used, so they are after the tag filter, the floor and the demotion.
- **Backwards compatible output.** `score` (fused RRF), `found-by`, `results` and `index` keep their names and meaning. `below-min-similarity` appears only when `min_similarity` is given.
- **Free plan** (spec §5, REVIEW.md *Cost*, `docs/solutions/cost/d1-reads-from-indexer-scans.md`). No new D1 query and no scan: the short-block rule reads the stored `text` that `blocksFor` already returns, and the merged keyword list is capped at 50 before `blocksFor`, so its bind list never passes today's 50 + 50. No extra neurons or Vectorize calls. The only new cost is up to 3 `searchGraph` calls instead of 1 for a query of 3+ content words (Stage 5). Tests pin the request counts from `FakeGraph.searchRequests`, `FakeVectorIndex.queries` and `FakeEmbedder.calls`. Each stage's commit body states its cost per query.
- **Tests run the real thing.** Ranking tests go through `hybridSearch` or the `semantic_search` tool with the real `SemanticStore` on D1 and the real indexer; only the embedder, Vectorize and the sync server are faked. Each rule's test has a decoy so the rule alone decides the outcome (`docs/solutions/testing/untested-rules-survive-mutation.md`). Each new test is first seen to fail; keep the failure text for the PR.
- **Crafted vectors.** Where a test needs exact cosines (weight, floor boundaries), add `CraftedEmbedder` to `semantic-fakes.ts`: a `FakeEmbedder` whose `vectors: Map<string, number[]>` answers a mapped text (the indexer embeds the document `Page > text`, so map keys are documents and query strings) and falls back to `fakeEmbed` otherwise. `FakeVectorIndex.query` takes the plain dot product, so unit vectors such as `[0.6, 0.8, 0, …]` against `[1, 0, …]` give exactly 0.6.
- **The eval is a gate.** From Stage 2 on, `semantic-eval.test.ts` asserts hybrid recall@5 and MRR are at least the fixture's `floor`, and every question's `top`. A stage that changes ranking raises `floor` to its new numbers; it never lowers it without saying why in the commit body. Run it with `npx vitest run test/semantic-eval.test.ts --silent=false --disableConsoleIntercept` (from `connector/`) so the table prints, and paste the table into the commit body.
- **Contract with Claude.** A stage that changes `semantic_search`'s input or output updates its description and `SEMANTIC_HELP` in the same commit, and runs `npm --prefix connector run update:manifest`. README §11.8 and §11.11 are the docs stage's (after the build).
- **Commits** follow `type(scope): what changed` (scopes `semantic`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page UUIDs, hostnames or tokens. The fixture uses example data ("Warehouse reporting", "Northwind warehouse"); docs use `sync.example.com` and `mcp.example.com`.

### Read before starting

- `REVIEW.md`, sections *Cost*, *Contract and docs*, *Tests* and *Connector*.
- `connector/src/tools/semantic-search.ts` (all of it), `connector/src/semantic/rrf.ts`, `config.ts`, `store.ts` (`blocksFor`, `StoredBlock`) and `document.ts` (`documentText`).
- `connector/test/semantic-fakes.ts` (`fakeEmbed`, `FakeVectorIndex.query`, `FakeGraph.search`, `failStatus`, `searchRequests`, `fakeSync`), `connector/test/semantic.test.ts` (the `tools` block and its `callTool`, `runUntilReady`, `semanticEnv` helpers) and `connector/test/semantic-eval.test.ts` with its fixture.
- `docs/solutions/testing/untested-rules-survive-mutation.md`, `docs/solutions/cost/d1-reads-from-indexer-scans.md`, and `docs/superpowers/specs/2026-11-04-semantic-search-design.md` §5 and §11.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A keyword hit that is in the index but outside the semantic top 50:** `similarity` and `semantic-rank` are `null`, not 0 and not a fresh lookup (Stage 3).
2. **A semantic hit removed by the tag filter:** it is not counted in `below-min-similarity`, which counts only hits the floor removed from what the caller would otherwise have seen (after deleted rows and the tag filter). Plan call; the spec says "the number of semantic hits it dropped" (Stage 3).
3. **`min_similarity: 0`:** valid, drops nothing, and still adds `below-min-similarity: 0` (Stage 3).
4. **A similarity that rounds to the floor but is below it** (raw 0.5996, floor 0.6): dropped, because the comparison uses the raw value (Stage 3).
5. **A short block that is an exact title match for a 3-word query** ("Stock on hand" searched as "stock on hand"): `wordCount` is 3, so it is not demoted; a 2-word block with the query's exact text is demoted on the semantic leg only, and its reported `similarity` stays raw (Stage 4).
6. **A query whose content words fall to 2 after stopwords and short words** ("is it the WOF due"): `wof`, `due` are 2 content words, so neither rule applies and one search request carries the whole phrase (Stages 4 and 5).
7. **Equal adjusted similarities after demotion:** ties keep vector order (stable sort), so the result is deterministic (Stage 4).
8. **A uuid that appears twice in one term list, or in all three:** counted once per list; three lists beat two at any rank (Stage 5).
9. **Two term searches failing in one call:** the error names the first failing term in term order, not whichever rejected first in time; use `Promise.allSettled` (Stage 5).
10. **The merged keyword list's cap with the tag filter:** the cap of 50 applies before `blocksFor` and before the tag filter, as today's `limit` 50 did, so a tag search can return fewer keyword hits than 50 but never reads more rows (Stage 5).
11. **Duplicate terms** ("dashboard dashboards Dashboard"): `contentWords` de-duplicates exact words only, so `dashboard` and `dashboards` are two terms; this is intended and pinned (Stage 1).

---

### Stage 1: Shared stopwords and the tokeniser

**Goal:** `ranking.ts` exists with the stopword list, `contentWords`, `distinctiveTerms` and `wordCount`; the fake embedder imports the list from it. Nothing in the tool calls the new functions yet, and the eval's numbers are unchanged (spec §3.6, risk 6).

**Files:**
- Create: `connector/src/semantic/ranking.ts` with `STOPWORDS` (the exact set now in `semantic-fakes.ts`, same words, same order), `contentWords`, `distinctiveTerms`, `wordCount`.
- Modify: `connector/src/semantic/config.ts` (`KEYWORD_TERMS`, `RANKED_QUERY_WORDS`).
- Modify: `connector/test/semantic-fakes.ts`: delete its `STOPWORDS` and import the one from `ranking.ts`. `fakeEmbed`'s own tokenising (`/[a-z0-9]+/g`, its stemmer and synonyms) does not change.
- Modify: `connector/test/semantic.test.ts` (new `describe("ranking terms")` block).

**Interfaces produced:** `STOPWORDS`, `contentWords`, `distinctiveTerms`, `wordCount`.

- [ ] **Step 1: Write the failing tests** (spec test (c)):
  - `contentWords drops stopwords, short words and duplicates`: "When is the car's warrant of fitness due?" gives `["car", "warrant", "fitness", "due"]`; "is it the WOF due" gives `["wof", "due"]` (review focus 6); "dashboard dashboards Dashboard" gives `["dashboard", "dashboards"]` (review focus 11).
  - `distinctiveTerms keeps the three longest, ties by first appearance`: "stock level reporting dashboard" gives `["reporting", "dashboard", "stock"]` (spec §3.3, `stock` before `level`); a 6-word question gives 3 terms; a 2-word query gives both.
  - `wordCount counts the stored text on whitespace`: "Dashboards" 1, "Stock on hand" 3, "  two   words " 2.
  - `the fake embedder uses the shared stopwords`: for every word in `STOPWORDS`, `fakeEmbed("dashboard " + word)` equals `fakeEmbed("dashboard")`. A second, private list in the fake that drifted from the shared one fails this.

- [ ] **Step 2: Run** `npm --prefix connector test -- semantic` and keep the failures (no module).

- [ ] **Step 3: Implement.** Keep the list's contents byte-for-byte; the move must not change the fake embedder.

- [ ] **Step 4: Run the eval** and confirm the table is identical to spec §2's (keyword recall@5 0.20, MRR 0.20; hybrid 1.00, 0.88, and the same per-question values). A difference means the list changed; fix it before going on.

- [ ] **Step 5: Contract.** None; the tool does not change.

- [ ] **Step 6: Run the gate:** `scripts/check.sh`. **Mutation check:** change the 3-character minimum to 2, the term count to 4, and the tie-break to last appearance, one at a time; confirm a test fails for each. Revert.

- [ ] **Step 7: Commit.** `refactor(semantic): share the stopword list and add the query tokeniser`. Body: the eval table, unchanged from spec §2; no cost change.

**Done when:** one stopword list exists, the tokeniser is pinned by tests, the eval prints the spec's baseline unchanged, and the gate is green.

---

### Stage 2: Extended eval fixture and its baseline

**Goal:** the fixture and the eval test carry the warehouse page, the two new questions, `top`, the short-block assertion, `baseline` and `floor`, measured on the unchanged ranking code. Lands acceptance 4 and the "before" half of acceptance 5.

**Files:**
- Modify: `connector/test/fixtures/semantic-eval.json`: page "Warehouse reporting" with the five blocks of spec §2 (keys `dashboards`, `reports`, `stock-dashboard`, `sales-report`, `reorder`); questions `{ "q": "stock level reporting dashboard", "expected": ["stock-dashboard"], "top": 3 }` and `{ "q": "weekly sales report for the regions", "expected": ["sales-report"] }`; top-level `baseline` and `floor` objects, each `{ "keyword": {"recall", "mrr"}, "hybrid": {"recall", "mrr"} }`.
- Modify: `connector/test/semantic-eval.test.ts`:
  - a question's `top` (default `K`) is the rank its first expected block must reach; asserted per question;
  - `floor`: `summary.hybrid.recall >= floor.hybrid.recall` and the same for MRR;
  - the short-block assertion as its own test: for each question with `contentWords(q).length >= RANKED_QUERY_WORDS`, the rank-1 hit's `text` has `wordCount > SHORT_BLOCK_WORDS`. In this stage it is declared `it.fails(...)`, so the gate stays green while it is known to fail; Stage 4 turns it into `it(...)`. (`SHORT_BLOCK_WORDS` is added to `config.ts` here.)
  - the table prints each question's top hit text, cut to 40 characters.
- Modify: the spec's §12 table: the "Offline, extended fixture, before" row.

- [ ] **Step 1: Write the failing tests.** Add the fixture page and questions and the assertions above, first as a plain `it(...)`. Run the eval and keep the short-block failure for the PR: it should name "stock level reporting dashboard" with "Dashboards" at rank 1 (spec §2's reproduction). Check the new `top: 3` assertion passes (the target is rank 2 offline).

- [ ] **Step 2: Record the baseline.** Copy the printed keyword and hybrid recall@5 and MRR into `baseline` and `floor` (identical in this stage) at 2 dp, and into the spec's §12 row. Then mark the short-block test `it.fails` with a comment naming Stage 4.

- [ ] **Step 3: Implement.** Test and fixture only; no source change except the `SHORT_BLOCK_WORDS` constant.

- [ ] **Step 4: Contract.** None.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** lower one question's expected rank by changing its `top` to 1 for "stock level reporting dashboard" and confirm the test fails; raise `floor.hybrid.mrr` by 0.01 and confirm it fails. Revert.

- [ ] **Step 6: Commit.** `test(semantic): extend the ranking eval with short-block and question cases and record the baseline`. Body: the eval table, the quoted short-block failure, and the baseline numbers.

**Done when:** the fixture holds the warehouse page and questions, `baseline` and `floor` are recorded from unchanged code, the short-block test is known to fail and marked so, and the gate is green.

---

### Stage 3: Similarity and ranks on every hit, and `min_similarity`

**Goal:** each hit carries `similarity`, `semantic-rank` and `keyword-rank`; `min_similarity` drops weak meaning matches and reports how many. Ranking order does not change unless `min_similarity` is given. Lands acceptance 1 and spec §3.1 and §3.4.

**Files:**
- Modify: `connector/src/tools/semantic-search.ts`:
  - `semanticMatches` returns `{ id, similarity }[]`;
  - `hybridSearch` takes `minSimilarity?: number`, keeps a map from block uuid to raw similarity, drops semantic hits below the floor after the deleted-row and tag filters (review focus 2), counts them, and builds `SearchHit` with the three new fields (`null` where a leg did not return the hit, review focus 1);
  - the response adds `"below-min-similarity"` only when the argument is given;
  - `semantic_search`'s `inputSchema` gains `min_similarity: z.number().min(0).max(1).optional()`, described as in spec §4;
  - the description and `SEMANTIC_HELP` per spec §3.7, without similarity bands (they come from the live check, spec §9 step 3; until then the help says the scores are cosine similarities from `@cf/baai/bge-small-en-v1.5`, higher is closer, and to compare hits within one search rather than against a fixed number).
- Modify: `connector/test/semantic-fakes.ts` (`CraftedEmbedder`), `connector/test/semantic.test.ts`, `connector/test/semantic-eval.test.ts` (the table prints the top hit's `similarity`).
- Modify: `connector/tools-manifest.json` via `npm --prefix connector run update:manifest`.

**Interfaces produced:** `SearchHit.similarity`, `SearchHit["semantic-rank"]`, `SearchHit["keyword-rank"]`; `hybridSearch`'s `min_similarity` argument.

- [ ] **Step 1: Write the failing tests** (spec tests (b) and (f)):
  - `similarity is the index's cosine at 3 dp`: with `CraftedEmbedder`, a block whose cosine to the query is 0.8125 reports `0.813` (rounding pinned), and `semantic-rank` 1.
  - `keyword-rank is null for a semantic-only hit; similarity and semantic-rank are null for a keyword-only hit`: a page title found only by `searchGraph`, and a block found only by meaning.
  - `an indexed keyword hit outside the semantic top 50 has null similarity`: seed 51 closer blocks so the keyword hit falls outside `SEMANTIC_TOP_K` (review focus 1); `FakeVectorIndex.queries` is still 1.
  - `ranks are after the tag filter`: with `tag`, a block that was second by vector but first after filtering reports `semantic-rank` 1.
  - `min_similarity drops below, keeps at`: crafted cosines 0.6 (kept), 0.5996 (dropped, review focus 4) and a keyword-only decoy (kept); `below-min-similarity` is 1; the response without the argument has no `below-min-similarity` key.
  - `min_similarity 0 drops nothing and reports 0` (review focus 3); `below-min-similarity` does not count a block the tag filter removed (review focus 2).
  - `zod refuses -0.1 and 1.1` through `callTool`, as tool errors.
  - `the manifest lists min_similarity` (the existing manifest check covers this once regenerated; confirm it fails before Step 4).
  - Cost: one embedding call, one Vectorize query and one search request per call, unchanged.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as spec §3.1 and §3.4. Compare `similarity < min` on the raw value. Do not change the order of `semanticUuids` except by removal.

- [ ] **Step 4: Contract.** Description and `SEMANTIC_HELP` as above; regenerate `tools-manifest.json`. The eval's numbers must equal Stage 2's (no ranking change); if they differ, the plumbing changed order.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** `<` to `<=`; round before comparing; report 0 instead of `null` for a missing leg; count tag-filtered hits in `below-min-similarity`; take `semantic-rank` from the unfiltered vector order. Confirm a test fails for each. Revert.

- [ ] **Step 6: Commit.** `feat(semantic): show similarity and per-leg ranks on each hit, and add min_similarity`. Body: the eval table (unchanged numbers), the failures seen, and cost per query unchanged (1 embedding, 1 Vectorize query, 1 search, D1 rows as before).

**Done when:** every hit reports its raw similarity and both ranks, the floor drops and counts exactly as the spec says, the manifest and help match, the eval is unchanged, and the gate is green.

---

### Stage 4: Short blocks lose the top spot

**Goal:** for a query of 3 or more content words, blocks of 2 words or fewer are ordered by similarity × 0.75 in the semantic leg. Lands acceptance 3 offline (spec §3.2).

**Files:**
- Modify: `connector/src/semantic/ranking.ts`: `demoteShortBlocks(semantic, textOf, query)`, returning the list re-sorted by adjusted similarity with a stable sort (review focus 7). The input is `{ uuid, similarity }[]` after the floor; `textOf(uuid)` reads the stored `text`.
- Modify: `connector/src/semantic/config.ts`: `SHORT_BLOCK_WEIGHT = 0.75`.
- Modify: `connector/src/tools/semantic-search.ts`: call it between the floor and fusion. Reported `similarity` stays raw.
- Modify: `connector/test/semantic.test.ts`; `connector/test/semantic-eval.test.ts` (the short-block test becomes `it(...)`); the fixture's `floor`.
- Modify: the tool description and `SEMANTIC_HELP` (one sentence: in a question of three or more words, one- or two-word blocks rank lower by meaning); regenerate the manifest.

- [ ] **Step 1: Write the failing tests** (spec test (a)), each through `hybridSearch` with `CraftedEmbedder`, real D1 and the real indexer:
  - `a 2-word block drops below a 3-word block for a 3-content-word query`: crafted cosines 0.58 for the 2-word block and 0.46 for the 3-word block (0.58 × 0.75 = 0.435 < 0.46, while 0.58 × 0.85 = 0.493 > 0.46, so 0.85 does not flip it and the weight is pinned). A third, unrelated decoy block sits between them on raw similarity at 0.50 so the test also checks the re-sort, not just a swap.
  - `it does not drop for a 2-content-word query`: same blocks, query of 2 content words; raw order kept.
  - `a 3-word block is not demoted`: the boundary of `SHORT_BLOCK_WORDS` (review focus 5).
  - `the reported similarity stays raw`: the demoted block still reports 0.58.
  - `ties keep vector order` (review focus 7).
  - Cost: no extra D1 statement (assert through `meta` or a statement count wrapper on `env.DB` that `blocksFor`, `state` and `counts` are the only reads).

- [ ] **Step 2: Run and keep the failures.** Also run the eval: the `it.fails` short-block test now passes, so vitest reports it as failing; that is the signal to flip it.

- [ ] **Step 3: Implement** as spec §3.2. Use `contentWords(q).length >= RANKED_QUERY_WORDS` and `wordCount(text) <= SHORT_BLOCK_WORDS`.

- [ ] **Step 4: Eval.** Flip the short-block test to `it(...)`. Run the eval; "stock level reporting dashboard" should now have the stock-on-hand block at rank 1 (spec §2: 0.433 against 0.452). Raise `floor` to the new numbers if they rose; if any number fell, say which question moved and why in the commit body.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** weight 0.85; `<= 2` to `< 2`; query threshold 3 to 2 and to 4; apply the weight to the reported similarity; count words over the document (`Page > text`) instead of `text`. Confirm a test fails for each. Revert.

- [ ] **Step 6: Commit.** `feat(semantic): rank one- and two-word blocks lower for multi-word questions`. Body: the eval table, before and after; no cost change (CPU: one sort of at most 50 ids).

**Done when:** the rule is pinned at its weight and both thresholds, the eval's short-block test passes as a plain test, the floor is raised, and the gate is green.

---

### Stage 5: A keyword leg that finds something for questions

**Goal:** for a query of 3 or more content words, the keyword leg runs `searchGraph` once per distinctive term (up to 3, `limit` 20 each, in parallel), merges the lists by number of terms matched, then best rank, then first appearance, and caps the result at 50 before `blocksFor`. Shorter queries keep today's single whole-phrase search. Lands spec §3.3 and acceptance 2 with the keyword leg contributing.

**Files:**
- Modify: `connector/src/semantic/ranking.ts`: `mergeKeywordLists(lists: KeywordResult[][])`, returning the merged, de-duplicated list capped at `KEYWORD_LIMIT` (review focus 8). Move the `KeywordResult` type here or export it from `semantic-search.ts`, whichever keeps imports one-way (`ranking.ts` must not import the tool module).
- Modify: `connector/src/semantic/config.ts`: `KEYWORD_TERM_LIMIT = 20`.
- Modify: `connector/src/tools/semantic-search.ts`: `keywordResults` takes the terms; with `contentWords(q).length < RANKED_QUERY_WORDS` it searches the whole `q` with `limit` 50, as today; otherwise one search per term via `Promise.allSettled`, and the first rejected term in term order answers `keyword search for "<term>": <reason>` (review focus 9), keeping today's `ToolError` code for the sync failure.
- Modify: `connector/test/semantic-fakes.ts`: `FakeGraph.failSearchFor: string | null`, which fails only the search whose `q` equals it (so test (g) can fail one term and not the others).
- Modify: `connector/test/semantic.test.ts`, the fixture's `floor`, the tool description and `SEMANTIC_HELP` (a long question is searched by its three longest words, so put the distinctive word in it); regenerate the manifest; the spec's §12 "after" row.

- [ ] **Step 1: Write the failing tests** (spec tests (d), (e) and (g)):
  - `a uuid matched by 2 terms ranks above one matched by 1 term at a better rank`: block A contains two of the terms and comes 3rd in each list; block B contains one term and comes 1st in its list; merged order is A, B. A decoy matched by one term at rank 2 checks the best-rank tie-break.
  - `three lists beat two at any rank` and `a uuid repeated in one list counts once` (review focus 8).
  - `one request per term, limit 20, types blocks,pages`: `FakeGraph.searchRequests` has 3 entries with `q` equal to the three `distinctiveTerms` and `limit=20`.
  - `the merged list is capped at 50`: seed 70 blocks matching the terms; `blocksFor` receives at most 50 keyword uuids (spy on the store or assert from D1 `meta` rows read), and the response has no keyword hit past the cap (review focus 10).
  - `a 2-content-word query sends one request with the whole phrase and limit 50` (spec test (e)); and "is it the WOF due" likewise (review focus 6).
  - `a failed term names the term`: `failSearchFor = "dashboard"` answers an error containing `keyword search for "dashboard":`; with two failing terms the first in term order is named (review focus 9). `failStatus` (all requests) still answers the same shape for the first term.
  - `the warehouse question finds the target through the keyword leg`: with the fake embedder, "stock level reporting dashboard" reports the stock-on-hand block with a non-null `keyword-rank` and `found-by` containing both legs.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as spec §3.3. Merge before the tag filter and before `blocksFor`, so RRF still sees two lists.

- [ ] **Step 4: Eval.** Run it; the keyword leg now contributes on multi-word questions. Raise `floor`; record "Offline, extended fixture, after" in the spec's §12 table. Note in the commit body any question whose rank changed, and confirm "stock level reporting dashboard" still has the target at rank 1 and "Queenstown" and "rego" are unchanged (single-word, whole-phrase path).

- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** order by best rank before term count; drop the cap; cap after `blocksFor`; term limit 20 to 50; term count 3 to 2; `Promise.all` instead of `allSettled` with ordered reporting (the two-failure test should catch an unordered name only if timing differs, so also check the name comes from term order by failing the second term only); search the whole phrase for every query. Confirm a test fails for each; list the results for the PR. Revert.

- [ ] **Step 6: Commit.** `feat(semantic): search a question's distinctive words in the keyword leg`. Body: the eval table, before and after; cost per query: up to 3 sync calls instead of 1 for 3+ content words (about 8 subrequests of 50; worst case 1 front + 3 sync Worker requests, spec §5 and question 3), D1 rows read unchanged (keyword bind list capped at 50), no neurons or Vectorize change.

**Done when:** the keyword leg is pinned by the tests above, the eval records the after numbers with the floor raised, the contract text matches, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.11 (how ranking works: raw similarity and per-leg ranks, the short-block rule, distinctive-term keyword search, `min_similarity`, the Free plan cost per query) and §11.8 (what Claude can do with `semantic_search` now). Spec §5's budget, restated: per query about 0.04 neurons, 1 Vectorize query of 384 dimensions, D1 rows as before, up to 3 sync calls; per indexer run unchanged; no new vectors.
- **PR body:** before and after recall@5 and MRR (offline from §12; live once measured), the Stage 2 short-block failure and each stage's first failures, the mutation results from Stages 1, 3, 4 and 5, the commit the checks ran on, what `scripts/check.sh` skipped, and the Logseq skill note (read `similarity` and `keyword-rank` rather than `score` to judge a match; pass `min_similarity` for only strong matches; a long question is searched by its longest words, so put the distinctive word in it). The PR is stacked on Phase 3 (PR 39) and merges after it.
- **Live check** (spec §9, owner question 4): before deploying, run the fixture questions in their live form with `limit` 5 and record ranks and RRF scores without page names; after deploying, record recall@5, MRR, the top 3 and each hit's similarity, summarise the distribution, write the similarity bands into `SEMANTIC_HELP` (naming the model) in a follow-up commit with the manifest regenerated, and decide on a default floor (question 2). Watch the next usage report for Worker requests and D1 rows read.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 changes `SHORT_BLOCK_WEIGHT` and Stage 4's crafted cosines (with 0.85 the fixture's short-block test relies on Stage 5's keyword leg, so Stage 4's eval flip would move to Stage 5); question 2 adds a default in Stage 3 or after the live check; question 3 may cap the term searches; question 5 changes `KEYWORD_TERMS` in Stages 1 and 5. Any change lands before the PR merges.
