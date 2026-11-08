# Semantic search ranking: similarity scores, short-block noise and the keyword leg: design

Date: 2026-11-07
Issue: Connector #27 (semantic search ranking: similarity scores, short-block noise, keyword leg). Labels: enhancement, retrieval. Follows item 2 (semantic search), which is done.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0034 applied. This work adds no patch and no migration.
Branch: stacked on Phase 3 (`claude/relaxed-maxwell-s4r8o4-phase3`, PR 39), which is not merged yet.

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

The 2026-11-06 retest of semantic search (item 2) found three problems:

1. A hit carries only its fused reciprocal rank fusion (RRF) score, so Claude can't tell a close match from a weak one.
2. Bare one- or two-word blocks (a heading such as "Dashboards") outrank the block that answers a multi-word question.
3. The keyword leg runs `search_graph` on the whole natural-language phrase. A substring match on "stock level reporting dashboard" finds nothing, so the leg adds nothing to the merge.

This design fixes all three at query time, in the connector only. The indexer, the stored vectors, the D1 schema, the sync server and the model stay the same, so nothing needs a reindex and one deploy reverts any rule.

Acceptance (issue and brief):

1. Each hit shows its semantic similarity and its keyword rank, if any.
2. "stock level reporting dashboard" returns the target dashboard in the top 3. The repo fixture uses example data ("Northwind warehouse"), not the owner's page names.
3. One- or two-word blocks no longer take the top spot for multi-word queries.
4. The question set lives in the repo and runs after each ranking change.
5. Recall@5 and MRR are reported before and after, in this spec and in the PR.
6. The tool description, `connector_help`, `tools-manifest.json`, README 11.8 and 11.11, and the Logseq skill note are updated.
7. The Free plan budget is stated: neurons per query and per indexer run, Vectorize dimensions, D1 rows (section 5).

## 2. Context

**What the indexer embeds.** The issue asks to verify that the indexer embeds `page title > breadcrumb > block text`. It does: `documentText` in `connector/src/semantic/document.ts` joins the page title, each ancestor cut to 120 characters, and the block text with ` > `, cut to 1,500 characters. Nothing to change there.

**What the query path throws away.** The Vectorize index is cosine (design 2026-11-04, section 5), and `index.query` returns `matches[].score`, the cosine similarity. `semanticMatches` in `connector/src/tools/semantic-search.ts` keeps only `matches.map((m) => m.id)`. `reciprocalRankFusion` (`connector/src/semantic/rrf.ts`) already returns each id's 1-based rank per list (`ranks`). So showing similarity and ranks is plumbing, with no extra calls.

**The keyword leg.** `keywordResults` sends the whole `q` to `searchGraph` (`types=blocks,pages`, `limit` 50). `searchGraph` is a case-insensitive substring match on titles, so a question of several words only matches a block that contains that exact phrase.

**Childlessness is not known at query time.** The issue suggests down-weighting short *childless* blocks. `FeedBlock` (patch 0014's feed) has no child count, and neither does `semantic_blocks`. A childless test would need a patch to the feed and a reindex. This design uses length alone (section 3.2).

**Baseline, measured on HEAD (`c0e0fd4`).** `npx vitest run test/semantic-eval.test.ts --silent=false --disableConsoleIntercept` on the committed fixture (10 questions, fake embedder) prints:

```
semantic eval: 10 questions, top 5
  When is the car's warrant of fitness due?    keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  What did we decide about pricing?            keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  When does Atlas ship?                        keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  Why did the release slip?                    keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=0.25
  Are we hiring?                               keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  What caused the incident?                    keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  kids dentist                                 keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=0.50
  Queenstown                                   keyword recall=1.00 rr=1.00  hybrid recall=1.00 rr=1.00
  How much is the holiday going to cost?       keyword recall=0.00 rr=0.00  hybrid recall=1.00 rr=1.00
  rego                                         keyword recall=1.00 rr=1.00  hybrid recall=1.00 rr=1.00
  mean keyword recall@5=0.20 MRR=0.20
  mean hybrid  recall@5=1.00 MRR=0.88
```

These match the numbers recorded in the 2026-11-04 design, section 11. The test asserts only that hybrid beats keyword-only, so it locks nothing in. (Without `--disableConsoleIntercept` the pool swallows the table.)

**Reproduction of the short-block win and the empty keyword leg (offline).** A throwaway copy of the eval (now deleted) added a page "Warehouse reporting" with five top-level blocks: "Dashboards", "Reports", "Stock on hand dashboard for the Northwind warehouse, refreshed nightly", "Sales by region report, sent to the team every Monday" and "Reorder levels reviewed each quarter". It ran two questions through the real `semantic_search` tool on HEAD and printed each hit's text, fused score and `found-by`:

```
REPRO stock level reporting dashboard [["Dashboards",0.01639,["semantic"]],["Stock on hand dashboard for the Northwind warehouse, refreshed nightly",0.01613,["semantic"]],["Reports",0.01587,["semantic"]],["Kids' school photos on Thursday",0.01563,["semantic"]],["Reorder levels reviewed each quarter",0.01538,["semantic"]]]
REPRO weekly sales report for the regions [["Sales by region report, sent to the team every Monday",0.01639,["semantic"]],["Reports",0.01613,["semantic"]],["Rego renewal paid online, $120",0.01587,["semantic"]],["Dashboards",0.01563,["semantic"]],["Reorder levels reviewed each quarter",0.01538,["semantic"]]]
```

So, reproduced offline on HEAD:

- The one-word block "Dashboards" takes rank 1 for "stock level reporting dashboard". The target is rank 2.
- Every hit says `found-by: ["semantic"]`. The keyword leg found nothing for either question.

The fake embedder's cosines for that question, computed with a copy of `fakeEmbed` over the stored documents (`Warehouse reporting > <text>`): "Dashboards" 0.577, target 0.452, "Reports" 0.447, "Reorder levels…" 0.378. The fake is a hashed bag of stemmed words, so a short document whose two words both appear in the query scores high, which is the same shape as the live effect. Two things follow:

- The target is already in the top 3 offline on HEAD, so acceptance 2 does not fail offline. The short-block assertion (rank 1) does fail. The live graph put the target lower than this; why the live ranking is worse than the fake's is not reproduced here (a guess: bge-small scores a short heading close to any query about its topic, which the fake does not model).
- A weight of 0.85 on the short block gives 0.577 × 0.85 = 0.490, still above the target's 0.452. The break-even weight on this fixture is 0.452 / 0.577 = 0.78. Section 3.2 takes this into account.

**Learnings that shape this design.**

- `docs/solutions/testing/untested-rules-survive-mutation.md` and REVIEW.md: each ranking rule needs a test that fails when the rule is mutated, with a decoy so the rule alone decides the outcome.
- `docs/solutions/cost/d1-reads-from-indexer-scans.md` and REVIEW.md *Cost*: no scans, count rows per request. This design adds no D1 query.
- `docs/superpowers/specs/2026-11-04-semantic-search-design.md`: the model, the index, the eval fixture and the cost model this builds on.

## 3. Design

All changes are in `connector/src/tools/semantic-search.ts`, a new pure module `connector/src/semantic/ranking.ts`, and constants in `connector/src/semantic/config.ts`. **(call)**

### 3.1 Similarity and ranks on every hit

`semanticMatches` returns `{id, similarity}[]` instead of ids. `hybridSearch` keeps a map from block uuid to raw similarity. Each `SearchHit` gains:

- `similarity`: the raw cosine from Vectorize, rounded to 3 decimal places, or `null` when the semantic leg didn't return the block. A keyword hit that is in the index but outside the semantic top 50 also has `null`, because its similarity was never computed.
- `semantic-rank`: 1-based rank in the semantic list after the short-block rule (3.2) and `min_similarity` (3.4), or `null`.
- `keyword-rank`: 1-based rank in the merged keyword list (3.3), or `null`.

The fused `score` and `found-by` stay, so existing callers keep working. Ranks come from `reciprocalRankFusion`'s `ranks`, which are the ranks the fusion actually used, after the tag filter.

### 3.2 Short blocks lose the top spot

`demoteShortBlocks(semantic, textOf, query)` in `ranking.ts` applies when the query has at least 3 content words (the tokeniser in 3.3, stopwords removed). A block whose stored `text` has `SHORT_BLOCK_WORDS` (2) words or fewer has its similarity multiplied by `SHORT_BLOCK_WEIGHT` for ordering only. The semantic list is re-sorted by the adjusted value, ties kept in vector order, before fusion. The hit still reports its raw similarity. The rule reads the stored text that `blocksFor` already returns, so it adds no D1 rows.

Words in the block are counted on the stored `text` only (not the page title or breadcrumb), split on whitespace, so "Dashboards" is 1 word and "Stock on hand" is 3.

**Weight (call).** The panel proposed 0.85. The reproduction shows 0.85 does not move "Dashboards" below the target on the fixture (0.490 against 0.452; break-even 0.78). Two ways to read that:

- With the multi-term keyword leg (3.3), the target wins anyway: it matches "stock" and "dashboard" (keyword rank 1), while "Dashboards" matches only "dashboard" (keyword rank 3, after the page "Warehouse reporting", which matched "reporting"). RRF gives the target 1/62 + 1/61 = 0.03252 and "Dashboards" 1/61 + 1/63 = 0.03227. But then the short-block rule decides nothing on the fixture, and a mutation of it would survive the eval.
- So the starting value is **0.75**, which moves the short block below the target on the semantic leg alone (0.433 against 0.452). The unit test in section 8 (a) pins the rule with crafted vectors either way. The live check (section 9) confirms or adjusts it, and the owner can choose 0.85 (question 1).

Queries of 2 content words or fewer are left alone, so a search for "Dashboards" still returns a "Dashboards" block first.

**Why not fold short blocks into the parent's embedding (call).** Folding changes what the indexer embeds, changes every affected `hash` and forces a re-embed: on a 13,000-block graph at about 40 tokens a block that is about 960 neurons, inside a day's 10,000, but the build itself runs at 100 blocks a minute, so over 2 hours of degraded search, and a revert needs another full re-embed. A short parent is already in each child's breadcrumb, so its children carry its meaning. Childlessness would need a patch to 0014's feed. This is revisited only if the live check shows the length rule fails.

### 3.3 A keyword leg that finds something for questions

`distinctiveTerms(q)` in `ranking.ts`:

1. lowercase, split on runs of non-alphanumerics;
2. drop stopwords (one shared list in `ranking.ts`; `test/semantic-fakes.ts` imports it, see 3.6);
3. drop words under 3 characters, and de-duplicate;
4. keep the `KEYWORD_TERMS` (3) longest, ties by first appearance. Length stands in for distinctiveness: inverse document frequency would need a D1 scan. **(call)**

If the query has 2 content words or fewer, the leg runs `searchGraph` once on the whole phrase, as today, so "rego" and "Queenstown" behave as now. Otherwise it runs `searchGraph` once per term and once on the whole phrase, in parallel, each with `limit` `KEYWORD_TERM_LIMIT` (20). The whole-phrase search keeps the case single words can't reach: `searchGraph` ranks an exact title first only when the needle is the whole title, and fills a capped list in title order, so a page titled "Project status meeting" can be missing from every term's 20 (review round 1, r1-correctness-1).

`mergeKeywordLists(lists)` orders uuids by the number of term lists that contain them (more first), then by their best single rank, then by first appearance across the lists in term order. `phraseFirst(phrase, merged)` then puts the whole-phrase list ahead of the merged term lists, with a uuid in both counted once at its phrase rank, and caps the result at `KEYWORD_LIMIT` (50) before `blocksFor`, so the D1 bind list never grows past today's 50 + 50. The term lists are merged before fusion, so RRF still sees two lists, `semantic` and `keyword`, and the RRF constant and maths are unchanged.

A failed term or phrase search fails the call, as a failed keyword search does today, and the error names the term (or the phrase): `keyword search for "dashboard": <reason>` (CLAUDE.md, errors name the entry and reason). With several failing, it names the first in term order, then the phrase.

For "stock level reporting dashboard" the terms are `reporting`, `dashboard`, `stock` (9, 9, 5 characters; `stock` before `level` by first appearance).

### 3.4 Optional `min_similarity`

A new optional argument, 0 to 1, no default. Semantic-leg hits whose raw similarity is below it are dropped before the short-block rule and fusion. Keyword-only hits are kept, because they have no similarity. When the argument is given, the response gains `"below-min-similarity": n`, the number of semantic hits it dropped, so a filter that empties the list says so rather than returning a silent empty result.

No default floor **(call)**: bge-small's cosine scores tend to bunch (the panel's estimate is mostly 0.5 to 0.85; not yet measured), so a floor chosen offline could hide good hits on the live graph. Section 9 records the live distribution, and a default can be added later from that evidence (question 2).

### 3.5 Evaluation in the repo

`connector/test/fixtures/semantic-eval.json` and `connector/test/semantic-eval.test.ts` change as follows **(issue)**:

- Add the "Warehouse reporting" page from the reproduction, with the same five blocks.
- Add the questions "stock level reporting dashboard" (`expected` the stock-on-hand block, `top: 3`) and "weekly sales report for the regions" (`expected` the sales block), the second as a case where "Reports" competes.
- Each question can carry `top`, the rank its first expected block must reach. The test asserts it.
- For each question with 3 or more content words, the rank-1 hit must not be a block of 2 words or fewer. On HEAD this fails for "stock level reporting dashboard" (quoted in section 2), and the PR quotes the failure.
- Add a `baseline` object to the fixture: the HEAD numbers on the extended fixture (keyword and hybrid recall@5 and MRR), recorded before any ranking code changes. After the change the test asserts hybrid recall@5 and MRR are each at least the post-change values, stored as `floor`, so a later ranking change can't regress silently. The existing "hybrid beats keyword" and "no private block by meaning" assertions stay.
- The printed table gains each question's top hit and its `similarity`.

### 3.6 Shared stopwords

The stopword list moves from `test/semantic-fakes.ts` to `ranking.ts` and the fake imports it. Changing that list would change the fake embedder and so the baseline. So the move is its own commit, the eval is re-run after it, and the baseline is recorded after the move (risk 6).

### 3.7 Contract text

- `semantic_search` description: hits carry `similarity`, `semantic-rank` and `keyword-rank`; multi-word questions search their distinctive words; `min_similarity` drops weak meaning matches.
- `SEMANTIC_HELP` (part of `connector_help`): how to read `similarity` for `@cf/baai/bge-small-en-v1.5`, with the bands from the live check (section 9). The text names the model, because the bands change with it.
- `tools-manifest.json` via `npm --prefix connector run update:manifest`.
- README 11.11 (how ranking works) and 11.8 (what Claude can do).
- Logseq skill note in the PR body: read `similarity` and `keyword-rank` rather than `score` to judge a match; pass `min_similarity` when only strong matches are wanted; a long question is title-searched by its longest words and as a whole phrase (an exact title stays first), so put the distinctive word in it.

## 4. Tool contract

`semantic_search` changes. No tool is added or removed, and `semantic_index_status` is unchanged.

**Input:** `graph`, `q`, `limit` and `tag` as now, plus:

| Argument | Type | Meaning |
|---|---|---|
| `min_similarity` | number, 0 to 1, optional, no default | Drop meaning matches below this cosine similarity before merging. Keyword-only hits are kept. |

zod refuses values below 0 or above 1.

**Output:** each hit keeps `uuid`, `resource`, `page`, `page-id`, `breadcrumb`, `text`, `score` (fused RRF) and `found-by`, and adds:

```json
{ "similarity": 0.812, "semantic-rank": 1, "keyword-rank": 2 }
```

with `null` for a leg that didn't return the hit. The top level keeps `results` and `index`, and adds `"below-min-similarity": n` only when `min_similarity` is given.

**Behaviour changes:**

- (a) For a query of 3 or more content words, the keyword leg searches up to 3 distinctive words, each separately, and the whole phrase. Phrase matches come first; the word lists follow, merged by the number of words matched, then best rank. Queries of 2 content words or fewer search the whole phrase, as today.
- (b) For a query of 3 or more content words, blocks of 2 words or fewer are ordered by similarity × 0.75 in the meaning leg. The reported `similarity` is the raw value.
- (c) A failed word search answers an error naming the word.

The tool stays read-only; its annotations don't change.

## 5. Cost on the Free plan

Per query:

| Resource | Today | After | Notes |
|---|---|---|---|
| Workers AI | 1 query embedding | same | about 20 tokens × 1,841 neurons per million, about 0.04 neurons; 50 queries a day is about 2 neurons of 10,000 |
| Vectorize | 1 query, topK 50, no values or metadata | same | queried dimensions unchanged |
| Vectorize storage | 384 per block, cap 13,020 blocks in 5M | same | no new vectors |
| D1 rows read | `blocksFor` ≤ 50 vector ids + ≤ 50 keyword uuids via indexes, `state` 1, `counts` per graph | same | merged keyword list capped at 50 before the read; no new query, no scan |
| D1 rows written | 0 | 0 | |
| Subrequests | 1 AI + 1 Vectorize + 1 sync + D1 | up to 4 sync calls (3 terms + the phrase) instead of 1, only for 3+ content-word queries | at most about 9 of the 50 allowed |
| Worker requests | 1 front + 1 sync | worst case 1 front + 4 sync | if service-binding calls count against the 100k daily cap (not confirmed, question 3), 50 queries a day add about 150 requests |
| CPU | | + tokenising and re-sorting ≤ 100 ids | well under 1 ms |

Per indexer run: unchanged. No extra neurons, rows or vectors, and no reindex.

## 6. Safety

- **Read-only.** `semantic_search` writes nothing, so dry-run and read-back don't apply. Nothing stored changes; a bad rule is reverted by one deploy.
- **Private blocks.** Unchanged: private blocks are never embedded, so they can't come back by meaning. Keyword hits are what `search_graph` already returns. Searching several words instead of one phrase can return more keyword hits, but only ones `search_graph` would return for those words, which Claude can already call. The eval's "no private block by meaning" assertion stays.
- **Rate limit.** The sync server limits semantic API reads to 120 a minute per token, operation and graph. A 3-term query uses 4 (3 terms + the phrase). At Claude's pace this is far from the limit; a 429 on a term answers the error naming the term.
- **No silent empty result.** `below-min-similarity` says how many hits a floor removed.

## 7. Risks

1. **The fake embedder may not show the live effect.** A hashed bag of words with a synonym table is not bge-small. The eval can pass offline while the live graph still misranks. Mitigation: the live check in section 9, before and after, recorded here labelled offline and live.
2. **Weight and cut-off tuned on a small fixture.** 0.75 and 2 words could demote a genuinely short answer, such as an exact title block. Mitigation: the rule applies only to queries of 3+ content words, the keyword leg still ranks an exact title match first, and each threshold has a boundary test.
3. **Longest is a crude stand-in for distinctive.** A long common word ("everything") can crowd out a short distinctive one ("WOF"), and a 6-word question loses half its words. The skill note tells Claude to put the distinctive word in the question.
4. **More sync calls.** Up to 4 `searchGraph` calls per query (3 terms + the phrase), in parallel; latency is the slowest of the four. Whether they count against the daily request cap is not confirmed (question 3).
5. **Model-specific bands.** The similarity bands in `connector_help` hold for bge-small only; a model change must update them, which is why the text names the model.
6. **Stopword move shifts the baseline.** Moving the list (3.6) is its own commit, and the baseline is recorded after it.

## 8. Testing

Test first, in the real Worker pool, with no stubs inside the ranking path:

1. On HEAD, run the eval and record the baseline (section 2 has it for the current fixture). After the stopword move, extend the fixture (3.5), run again on HEAD and record `baseline`. Watch the short-block assertion fail, and quote the failure in the PR.
2. In `connector/test/semantic.test.ts`, test each rule through `hybridSearch` with the real `SemanticStore` on D1, `FakeVectorIndex` and `FakeGraph`, each with a decoy so the rule alone decides the outcome (`docs/solutions/testing/untested-rules-survive-mutation.md`):
   - (a) A 2-word block outranks a 3-word block on raw similarity, and drops below it for a 3-content-word query; it doesn't drop for a 2-content-word query; a 3-word block is not demoted. Pins the query threshold, the word-count boundary and the weight (vectors chosen so 0.75 flips the order and 0.85 doesn't).
   - (b) A hit's `similarity` equals the fake index's cosine at 3 dp; `keyword-rank` is null for a semantic-only hit; `similarity` and `semantic-rank` are null for a keyword-only hit.
   - (c) `distinctiveTerms`: stopwords dropped, words under 3 characters dropped, at most 3 terms, the longest kept, ties by first appearance, duplicates removed.
   - (d) A uuid matched by 2 terms ranks above one matched by 1 term at a better single rank; the merged list is capped at 50 (seed more than 50 matches); `FakeGraph.searchRequests` shows one request per term, then one for the whole phrase, each with `limit=20`; a whole-phrase title match keeps keyword-rank 1 when each term matches more than 20 earlier-sorting titles.
   - (e) A 2-content-word query sends exactly one search request, with the whole phrase.
   - (f) `min_similarity` drops a semantic hit just below the value and keeps one exactly at it (pins `<` against `<=`), keeps a keyword-only hit, reports `below-min-similarity`, and zod refuses -0.1 and 1.1.
   - (g) A failed term search (`FakeGraph.failStatus`) answers an error that names the term.
3. Mutation pass: for each rule (weight, both thresholds, term count, term limit, merge order, cap, floor comparison, null handling), make the one-line mutation in a scratch copy and confirm a test fails. List the results in the PR.
4. After the change, the eval asserts recall@5 and MRR at or above the recorded floor and every question's `top`. Before and after numbers go in section 12 and the PR.
5. `scripts/check.sh` on HEAD, including typecheck and the tools-manifest check; the PR names its skips.

## 9. Rollout and verification

1. Before deploying, run each fixture question in its live form against the owner's graph through `semantic_search` (read-only), with `limit` 5. Record the top-3 results and their RRF scores, without the owner's page names. Similarity isn't shown yet, so the live baseline is ranks only.
2. Deploy (merge to main).
3. Run the same questions again. Record recall@5 and MRR, the top-3 results, and the similarity of each hit, then summarise the distribution (min, quartiles, max, and the similarity of the expected hit against the best wrong one). Use it to write the bands in `SEMANTIC_HELP` and to decide whether a default floor is worth adding.
4. Check the owner's original question returns the dashboard in the top 3 and that no 1- or 2-word block is first for a 3+ word question.
5. Watch the usage report for the next day: Worker requests and D1 rows read should not move noticeably.

Revert: redeploy the previous connector. Nothing stored changed.

## 10. Out of scope

- **bge-base-en-v1.5 (768 dimensions).** It halves the Free plan's block cap (13,020 to 6,510) and needs a new index and a full rebuild. Revisited only if the live question set still misses after these query-time rules.
- **Folding short blocks into the parent's embedding**, and anything that changes what the indexer embeds (3.2).
- **A child count in the feed** (a patch to 0014), unless the length rule fails live.
- **IDF-weighted term choice**, which needs per-term counts in D1.
- **A default `min_similarity`**, until the live distribution is known.
- **Embedding the page title separately** or re-ranking with a cross-encoder (more neurons per query).

## 11. Open questions for the owner

1. **Short-block weight.** The panel proposed 0.85; the fixture needs 0.78 or less for the rule to change the order on its own, so this spec starts at 0.75. Keep 0.75, or take 0.85 and rely on the keyword leg for the fixture's question?
2. **Default floor.** Leave `min_similarity` with no default until the live distribution is recorded, or set one (for example 0.5) now?
3. **Request cap.** Do service-binding calls from the connector to the sync Worker count against the account's 100k daily Worker requests? If they do, the worst case is about 100 more a day at 50 queries. Acceptable?
4. **Live check.** Is running the fixture questions against your graph before and after the deploy acceptable? The spec records only ranks and scores, not page names.
5. **Term count.** Three distinctive words per question, or more (each extra word is one more sync call per query)?

## 12. Results

To be filled in by the build:

| Run | Keyword recall@5 | Keyword MRR | Hybrid recall@5 | Hybrid MRR |
|---|---|---|---|---|
| Offline, current fixture, HEAD `c0e0fd4` | 0.20 | 0.20 | 1.00 | 0.88 |
| Offline, extended fixture (12 questions), before: ranking code of `86cb347` | 0.17 | 0.17 | 1.00 | 0.85 |
| Offline, extended fixture, after Stage 4 (short-block rule) | 0.17 | 0.17 | 1.00 | 0.90 (0.896) |
| Offline, extended fixture, after Stage 5 (distinctive-term keyword leg) | 0.17 | 0.17 | 1.00 | 0.90 (0.896) |
| Offline, fixture with five decoy titles, Stage 5 (`3cf9a63`) | 0.17 | 0.17 | 1.00 | 0.78 |
| Offline, fixture with five decoy titles, whole-phrase keyword leg only (pre-Stage 5) | 0.17 | 0.17 | 1.00 | 0.84 |
| Offline, fixture with five decoy titles, after review round 2 (two-term rule) | 0.17 | 0.17 | 1.00 | 0.85 (0.854) |
| Offline, original pages, after review round 2 | 0.17 | 0.17 | 1.00 | 0.90 |
| Live, before | | | | |
| Live, after | | | | |

After Stage 5 every question keeps the rank it had after Stage 4, so the floor stays at MRR 0.89 (0.90 would sit above the measured 0.896). The keyword columns measure `searchGraph` on the whole phrase, which this design does not change. The keyword leg now contributes to the multi-word questions: for "stock level reporting dashboard" the target is found by both legs (`semantic.test.ts`, "the warehouse question finds its target through both legs").

Review round 2 found that a title holding one word of a question ("Carpooling" for "car", "Fitness plan" for "fitness") took keyword rank 1, which reciprocal rank fusion weights the same as semantic rank 1, so on a graph with such titles the WOF answer fell from rank 1 to rank 3. The fixture now has five such decoy pages, and the WOF question must reach rank 1. The term lists now keep only uuids that at least two terms found (`KEYWORD_TERM_MATCHES`); whole-phrase matches are kept as before. With the decoys the floor's MRR is 0.85, lowered on purpose because the holiday question's decoy is also its nearest block by meaning in the fake embedder; the original pages alone still give 0.90. The rule costs no extra calls, rows or neurons.

## 13. As built

The build follows sections 3 and 4. Where the result differs from the design:

- **Keyword-term filter (section 3.3).** The design merged every term list. Review round 2 found that a title holding one word of a question took keyword rank 1, which reciprocal rank fusion weights the same as semantic rank 1. `mergeKeywordLists` therefore keeps only uuids that at least `KEYWORD_TERM_MATCHES` (2) terms found. Whole-phrase matches are kept as before and come first (`phraseFirst`), so a title matching only one word of a question is left out of the keyword list. The tool description and `SEMANTIC_HELP` say so.
- **Fixture (section 3.5).** The fixture gained five decoy "Notes for ... later" pages, each holding one word of a question. The recorded floor is hybrid MRR 0.85, lowered on purpose from 0.89; the original pages alone still give 0.90 (section 12).
- **Short-block weight (section 3.2).** Kept at 0.75, as the design started. The live check (section 9) has not been run, so the weight is unconfirmed on the owner's graph.
- **Similarity bands (sections 3.7 and 9).** `SEMANTIC_HELP` says to compare similarities within one search rather than against a fixed number, and gives no bands, because the live distribution has not been recorded. The live rows in section 12 are empty for the same reason.
- **Manifest.** `tools-manifest.json` did not change. It lists each tool's name, method, path and annotations, not its description or arguments, and `update:manifest` rewrote it unchanged.
- **Cost (section 5).** As designed: no new D1 query, row, vector or neuron. The multi-word keyword leg makes up to 4 `search_graph` calls (3 terms and the phrase).
- **Contract text.** Updated in the tool description, `SEMANTIC_HELP`, README 11.8 and 11.11.
