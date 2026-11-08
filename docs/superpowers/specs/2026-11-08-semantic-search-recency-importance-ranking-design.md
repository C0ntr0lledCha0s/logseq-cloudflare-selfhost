# Semantic search memory ranking: recency, importance and demotion: design

Date: 2026-11-08
Issue: "Ranked retrieval and memory decay for semantic_search" (no item number yet). Labels: enhancement, retrieval. Follows item 27 (semantic search ranking) and item 2 (semantic search), which are both done.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0034 applied. This work adds patch 0035 and no migration.
Branch: `claude/relaxed-maxwell-s4r8o4-phase4`, stacked on the earlier phases, 2 commits behind `origin/main` at `21ee74d`.
Tier: intake suggested standard. The design needs patch 0035, so the build runs as **full** (`scripts/check.sh --upstream` and upstream's db-sync suite).

Decisions marked **(issue)** come from the issue. Decisions marked **(panel)** come from the design panel's winning design ("minimal"). Decisions marked **(call)** were made while writing this spec, including where it changes a panel number; the arithmetic is in section 3.4. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Agents that use the graph as memory get stale or superseded notes back as the graph grows. An old "pricing v1" block is as close by meaning to "what is our pricing?" as the current "pricing v2", and `semantic_search` has no way to prefer the newer one, the one other notes point at, or the one not marked done or archived.

This design adds an opt-in ranking mode to `semantic_search`, `rank: "memory"`, that multiplies the fused relevance score by a recency factor and an importance factor. Old, archived, superseded or completed items rank lower but stay in the results. Each hit shows its raw relevance next to the factors, so Claude can see why a hit moved. The default mode is unchanged.

Acceptance (issue):

1. `semantic_search` gains an opt-in scoring mode that multiplies relevance by recency and importance. The default stays as it is unless the eval shows a clear default win.
2. Recency comes from updated-at, with a configurable half-life. Importance comes from reference counts (backlinks) and active-against-archived signals.
3. Archived, superseded or completed items rank lower but remain findable (demoted, not filtered).
4. Each hit reports raw relevance (similarity, semantic-rank, keyword-rank) beside the final score and the recency and importance factors.
5. Optional filters before ranking (tag, updated-after), if cheap.
6. Signals use generic Logseq data (updated-at, references, tags, the built-in status). Graph-specific ones (a project-status property, an Archives tag) are optional arguments; no owner property ident is hardcoded.
7. `connector/test/fixtures/semantic-eval.json` gains stale-against-current cases with example data only. Recall@5 and MRR are reported before and after, and the baseline and floor are updated.
8. The Free plan cost per query is stated: extra sync calls, D1 rows read, Workers AI neurons; no new per-query scans.
9. Regression tests run the real code and were seen to fail without the change; each ranking rule has a mutation-resistant test with a decoy.
10. Tool description, `connector_help`, `tools-manifest.json`, README 11.8 and 11.11, and a Logseq skill note in the PR body are updated.
11. `scripts/check.sh --upstream` passes on HEAD; the PR names the commit and what was skipped.

## 2. Context

Everything in this section was checked by reading the code on HEAD (`21ee74d`) or running it. There is no bug to reproduce: this is a feature, and the facts below are why the design needs a patch.

**The query path today.** `hybridSearch` in `connector/src/tools/semantic-search.ts` runs the vector leg (Vectorize, top 50) and the keyword leg (`searchGraph`, at most 50 after `phraseFirst` and `mergeKeywordLists`) in parallel. It then reads each candidate's stored row with `store.blocksFor`, maps vector ids to block uuids, applies the `tag` filter and `min_similarity`, runs `demoteShortBlocks`, fuses with `reciprocalRankFusion` (`RRF_K` = 60) and slices to `limit`. Each hit carries `similarity`, `semantic-rank`, `keyword-rank`, `score` (the RRF score) and `found-by`.

**What D1 holds.** A `semantic_blocks` row holds the uuid, vector id, page, breadcrumb, text and the inherited tags, lowercased (the page's, the ancestors' and the block's own). It holds no updated-at and no reference count.

**Updated-at reaches the connector and is dropped.** Patch 0014's `feed-block-response` sends `:updated-at (:block/updated-at block)`. `parseFeedPage` in `connector/src/semantic/document.ts` builds `FeedBlock` without it. Storing it would need migration 0007 and a full reindex to fill old rows, and every block edit already re-sends the block, so it would stay current. Reference counts are different (next paragraph), so storing updated-at alone would still leave importance needing a sync call.

**A stored reference count would go stale.** `changed-uuids` in the patched handler adds, for a touched entity, only that entity, its subtree when a feed attribute changed, and its referrers when its *title* changed. When block B gains a reference to A, the tx log touches B, so the feed re-sends B and not A. A count stored on A's row would not move. The count has to be read at query time.

**`getBlocks` has neither signal.** `bulk-read-response` returns `block-detail-response` per entity: `block-response` (`uuid`, `kind`, `title`, `order`, `parent-id`, `page-id`, children) plus tags and properties. There is no `updated-at` and no reference count. Status is there, inside `properties` (`entity-properties-response`), but with every other property and the block's title, which is more than ranking needs.

**A reference count already exists upstream.** `referrer-ids` (with `reference-attributes` read once per request) counts visible entities, other than the entity and its own blocks, that link to it, embed it, alias it or hold it as a user or library property value. `get_page_backlinks` and the delete dry run's `references` use the same definition, so a new count built on it means the same thing in every tool.

**`graphFetch` reads no D1.** It calls `syncFetch` with the PAT that `resolveGraph` already returned. One more sync call adds no D1 rows.

**Baseline on HEAD (`21ee74d`).** `npx vitest run test/semantic-eval.test.ts --silent=false --disableConsoleIntercept` on the committed fixture (12 questions, fake embedder):

```
semantic eval: 12 questions, top 5
  ...
  mean keyword recall@5=0.17 MRR=0.17
  mean hybrid  recall@5=1.00 MRR=0.85
```

This matches the fixture's recorded `baseline` and `floor` (hybrid recall 1.00, MRR 0.85). The relevance-mode numbers must not move.

**What the fixture can't show yet.** The fixture has no updated-at, reference counts or status, and the fake sync server has no `getBlocks` route, so no stale-against-current case can be written against HEAD. The claim that relevance mode puts a stale near-duplicate first is therefore not reproduced here; it is the owner's report, and the new eval cases (3.7) will show it for relevance mode in Stage 1, before any ranking code changes.

**Learnings that shape this design.**

- `docs/solutions/testing/untested-rules-survive-mutation.md` and REVIEW.md: each rule needs a decoy test that fails when the rule is mutated.
- `docs/solutions/cost/d1-reads-from-indexer-scans.md` and `d1-statement-shapes-read-more-than-they-return.md`: no new D1 query; the signals come from the sync server.
- `docs/solutions/semantic/loose-keyword-hits-fuse-as-high-as-meaning.md`: RRF weights a keyword rank the same as a semantic rank. The same compression decides how strong the new factors are (3.4).
- `docs/superpowers/specs/2026-11-07-semantic-search-ranking-quality-design.md`: the pipeline, the eval's `baseline` and `floor`, and the habit of recording offline and live numbers.

## 3. Design

### 3.1 Patch 0035: `getBlocks` `view=signals` (panel)

`patches/0035-semantic-get-blocks-signals-view.patch` adds a third value to `getBlocks`'s `view` query parameter, `signals`, and an optional `property` query parameter (an ident such as `user.property/project-status`).

- Same limits as today: up to 100 ids (`max-batch-size`), no duplicates, missing uuids under `missing`.
- For each found entity it returns only:
  - `uuid`
  - `updated-at`: `:block/updated-at` in milliseconds, or `null`
  - `reference-count`: `(count (referrer-ids db e attributes))`, with `reference-attributes` read once per request, capped at `REFERENCE_COUNT_CAP` (1,000) **(call)**. The cap is stated in the schema. Section 7 risk 3 explains why it is needed and how the count stops early.
  - `status`: the name of the built-in `:logseq.property/status` value's ident (`"done"`, `"canceled"`, `"todo"`, `"doing"`, ...), or `null`. This is generic Logseq data, not an owner ident.
  - `property-values`: when `property` is given, the value titles of that property on the entity, or on the entity's page when the entity has none; `[]` when neither has a value; `null` when `property` is not given.
- An unknown `property` answers 400 `property not found: <ident>`. Giving `property` with another view answers 400 `property needs view=signals`.
- The view returns no title or text, so it works on E2EE graphs. (The semantic index skips E2EE graphs, so semantic search never calls it there; the generated `get_blocks` tool can.)
- The OpenAPI spec gains `signals` in the `view` enum, the `property` parameter and a `SignalsResponse` schema. The operation's summary text says what the view returns and that `reference-count` stops at 1,000.

The patch includes db-sync tests (section 8).

### 3.2 New arguments to `semantic_search` (panel)

| Argument | Type | Modes | Meaning |
|---|---|---|---|
| `rank` | `"relevance"` or `"memory"`, default `"relevance"` | both | `relevance` is today's order, byte for byte. `memory` multiplies by recency and importance. |
| `half_life_days` | integer, 1 to 3650, default 90 | memory only | Age at which recency halves. |
| `demote_tags` | up to 10 tag names | memory only | Demote hits carrying any of these tags, on the block, an ancestor or its page, case-insensitive. Matched against the stored tags `blocksFor` already read. |
| `demote_property` | `{property: ident, values: 1 to 10 titles}` | memory only | Demote hits whose value of that property (on the block, else its page) is one of these titles, case-insensitive. |
| `updated_after` | ISO date or date-time | both | Drop candidates last updated before this, or with no updated-at, before fusion. |

The existing `tag` argument stays the cheap pre-filter, and it runs first.

### 3.3 Order of operations

1. Vector and keyword legs, in parallel (unchanged).
2. `blocksFor`, `state`, `counts` (unchanged).
3. **Signals**, only when `rank` is `memory`, or `updated_after` or `demote_property` is given: one `getBlocks` call with `view=signals` on the union of the semantic and keyword candidate uuids that survived the deleted-row filter (at most 100, the endpoint's cap; one call), with `property` when `demote_property` is given. It needs the uuids, so it runs after `blocksFor`, not in parallel with it. That adds one round trip of latency to memory queries only.
4. Filters: `tag`, then `updated_after`, then `min_similarity`. Each filtered list keeps its order. `updated_after` counts what it dropped in `before-updated-after`.
5. `demoteShortBlocks`, then RRF over everything (unchanged). Ranks stay "as fused after the filters", as documented now.
6. **Memory re-rank**, in memory mode only: `applyMemoryRanking` over the whole fused list (not the first `limit`), then a stable re-sort by final score, then `slice(limit)`. A hit that is 11th by relevance and first by memory comes back at `limit` 10.

As built (plan Stage 4): the semantic candidates are the vector matches that still have a stored row, in vector order and before the `tag` filter, then the keyword candidates in keyword order; repeats are sent once, and no request is made when both lists are empty.

A signals call that fails fails the whole call: `ranking signals: <reason>` (CLAUDE.md, errors name the entry and reason), the same way a failed keyword search is named. The search never falls back to relevance order without saying so.

A uuid under `missing` (deleted since it was indexed) gets `updated-at: null` and `reference-count: 0`, so neutral recency and base importance. It is not dropped, which matches what relevance mode does with it today, except that `updated_after` drops it, because its updated-at is unknown. The help text says so.

### 3.4 Scoring (panel shape, call on the numbers)

Pure functions `memoryFactors` and `applyMemoryRanking` go in `connector/src/semantic/ranking.ts`, with their constants in `connector/src/semantic/config.ts`.

```
age_days   = (now - updated-at) / 86_400_000
recency    = 1                                         if updated-at is null or in the future
           = max(RECENCY_FLOOR, 0.5 ^ (age_days / half_life_days))   otherwise
importance = min(IMPORTANCE_MAX, 1 + REF_WEIGHT * log2(1 + reference-count))
             * (DEMOTE_WEIGHT if any demotion rule matched, else 1)
score      = relevance * recency * importance          (relevance is the RRF score)
```

Demotion rules: `status:done`, `status:canceled`, `tag:<name>` for each matching `demote_tags` entry, `property:<value>` for each matching `demote_property` value. Every matching rule is listed in `demoted-by`, but the weight applies once, however many match **(call; the panel applied 0.5 once per rule kind, up to 0.125)**. Archived and done is still just "demoted", and a triple-matched hit doesn't sink below every other candidate.

**Why the panel's numbers change (call).** RRF scores are compressed. With `RRF_K` = 60, a hit found by one leg scores 1/61 = 0.01639 at rank 1 and 1/110 = 0.00909 at rank 50, a ratio of 1.8. Rank 1 against rank 10 is 1/61 against 1/70, a ratio of 1.15. Found by both legs at rank 1, a hit scores 2/61 = 0.03279. Any factor below about 0.55 therefore beats every relevance difference except the "found by both legs" one. With the panel's numbers:

- `RECENCY_FLOOR` 0.25: a fully aged hit at rank 1 in both legs scores 0.03279 × 0.25 = 0.00820, below a fresh hit at rank 50 in one leg (0.00909). The panel's test "the floor keeps a strongly relevant old hit above a fresh weak one" cannot pass. With **0.5**, the same old hit scores 0.01639, which ties a fresh rank-1 one-leg hit and beats every fresh one-leg hit from rank 2 down.
- `REF_WEIGHT` 0.25 with `IMPORTANCE_MAX` 2: 15 references double the score, which outweighs the whole rank 1 to rank 50 spread (1.8). With **REF_WEIGHT 0.1 and IMPORTANCE_MAX 1.5** (reached at 31 references; 3 references give 1.2, 7 give 1.3), a well-linked note moves up a few places rather than to the top.
- `DEMOTE_WEIGHT` stays **0.5** and `DEFAULT_HALF_LIFE_DAYS` stays **90**.

Ranges, then: `recency` 0.5 to 1, `importance` 0.5 to 1.5. Even so, memory mode is mostly decided by the factors, and relevance breaks ties among hits of similar age and links: at a 90-day half-life, an 18-day-old hit (recency 0.87) drops below a fresh hit 9 places further down one leg. This is the intended effect for memory questions and the reason it isn't the default (question 1). The unit tests pin each constant against these boundaries (section 8).

Nothing is filtered by scoring. Every candidate RRF returned is still there, and `limit` up to 50 reaches it.

### 3.5 Hit fields

Relevance mode: unchanged, including `score` (RRF). The response gains `before-updated-after` only when `updated_after` is given.

Memory mode: each hit keeps `similarity`, `semantic-rank`, `keyword-rank` and `found-by`, and gains:

```json
{
  "score": 0.00976,
  "relevance": 0.03252,
  "recency": 0.5,
  "importance": 0.6,
  "updated-at": "2024-03-01T09:12:00.000Z",
  "reference-count": 3,
  "demoted-by": ["status:done", "tag:archives"]
}
```

`score` becomes the final product (5 dp), `relevance` is the RRF score (5 dp), the factors are at 3 dp. The response gains `"rank": "memory"` and `"half-life-days": n` at the top level, so a reader of the output knows which order it is.

### 3.6 Guards (panel)

The tool is read-only, so there is no dry run or read-back to add. Its "no silent success" equivalent is to refuse an argument that would be ignored, and to say when a filter removed hits:

- `half_life_days needs rank: "memory"`; likewise `demote_tags needs rank: "memory"` and `demote_property needs rank: "memory"`. Checked before any call, in argument order.
- `updated_after: not an ISO date` when `Date.parse` fails or the string isn't `YYYY-MM-DD` or a full ISO date-time.
- As built (plan Stage 4): an empty `demote_tags` (`[]`) demotes nothing and is accepted in either mode, so a caller that always sends the field isn't refused; `half_life_days` and `demote_property` are refused whenever they are given.
- As built (plan Stage 5): a full ISO date-time needs seconds and `Z` or a `±hh:mm` offset (fractional seconds are allowed), so `2026-11-08T10:00` is refused; the date part must exist (`2026-02-30` and `2027-02-29` are refused). `before-updated-after` counts each dropped hit once, whichever legs found it, and only hits the `tag` filter kept. In relevance mode `updated_after` makes the same single signals request as memory mode, with no `property`, and `score` stays the RRF score.
- `ranking signals: <reason>` for a failed signals call, including `ranking signals: property not found: user.property/x`.
- `before-updated-after: n`, so a filter that empties the list says so.

### 3.7 Evaluation

`connector/test/fixtures/semantic-eval.json`, `semantic-fakes.ts` and `semantic-eval.test.ts` change as follows **(issue)**:

- A document can carry an optional `signals` block: `updated-at`, `reference-count`, `status`, and `properties` (`{ident: [titles]}`). `FakeGraph` serves `GET .../blocks?view=signals` from it, with the same `missing`, cap and `property not found` behaviour as the patch, and records requests so tests can count them.
- The eval has a fixed `now`, so ages don't drift with the clock.
- A question can carry `rank`, `demote_tags`, `demote_property` and `half_life_days`.
- New stale-against-current cases, example data only, each a near-duplicate pair so only recency or importance can order it:
  - "Pricing" page: a superseded "Pricing v1: starter tier at $12 a month" (400 days old, 0 references) and a current "Pricing v2: starter tier at $15 a month" (10 days old, 3 references). Question: "what is the starter tier price?", memory mode, expected v2 first.
  - A done task "Renew the domain name" and an open one "Renew the domain name before it lapses", both recent. Memory mode, expected the open one first.
  - An old page tagged `#Archives` ("Office move plan, archived") and a current "Office move plan". Memory mode with `demote_tags: ["Archives"]`, expected the current one first.
  - One "old decision" question in memory mode whose only answer is 2 years old, to show the floor keeps it in the top 5.
- Each case is run in both modes. The report prints recall@5 and MRR per mode. Relevance mode on the old questions must equal the recorded `baseline` (proof the default is untouched). Memory mode gets its own `baseline` (Stage 1 numbers, before the ranking code) and `floor` (after).
- Stage 1 records the relevance-mode numbers on the extended fixture before any ranking code changes, and quotes in the PR that the stale-against-current cases fail their `top` in relevance mode.
- As built (plan Stage 2): ages are `age-days`, which the fake turns into `updated-at` against each request's `Date.now()`, in place of a fixed `now`. The pricing pair sits on a page titled "Price list" with texts "Starter tier v1: $12 a month" and "Starter tier v2: $15 a month", because a page or block containing "pricing" is a keyword hit for the old question "What did we decide about pricing?" and would move the old baseline (with the wording above, the old hybrid MRR drops from 0.85 to 0.81). The office pair sits on pages "Office move plan (archived)" (tagged `Archives`) and "Office move plan (current)"; the archived block reads "Plan: move to the Queen Street office in April", so relevance mode ranks it above the current "Move to the Queen Street office in June" rather than tying. The old decision reads "We decided to keep the books in Xero rather than switch to MYOB" (730 days). In relevance mode the current twin ranks 3rd (pricing) and 2nd (domain, office); the old decision ranks 1st.

### 3.8 Contract text

- `semantic_search` description: the `rank`, `half_life_days`, `demote_tags`, `demote_property` and `updated_after` arguments, that demotion never filters, and the new hit fields.
- `SEMANTIC_HELP` (`connector_help`): the formula, the ranges, that the default is unchanged, how to read `relevance` against `score`, that deleted-since-indexed hits get neutral factors, and when to use memory mode (current state of something) against relevance mode (what was decided back then).
- `get_blocks` (generated): `view=signals` and `property`, from the patched OpenAPI.
- `tools-manifest.json` via `npm --prefix connector run update:manifest`. Item 27 found the manifest lists name, method, path and annotations only, so it may not change; the PR says which.
- README 11.8 (what Claude can do) and 11.11 (how ranking works, and the cost of a memory query).
- Logseq skill note in the PR body.

## 4. Tool contract

**`semantic_search` input:** `graph`, `q`, `limit`, `tag` and `min_similarity` as now, plus the arguments in 3.2. zod refuses `half_life_days` outside 1 to 3650 or not an integer, more than 10 `demote_tags`, an empty tag name, and `demote_property` with 0 or more than 10 values.

**Output:** relevance mode is unchanged apart from `before-updated-after` when `updated_after` is given. Memory mode adds to each hit `relevance`, `recency` (0.5 to 1), `importance` (0.5 to 1.5), `updated-at` (ISO or `null`), `reference-count` (0 to 1,000) and `demoted-by` (string array), makes `score` the final product, and adds `rank` and `half-life-days` at the top level.

**Errors:**

- `half_life_days needs rank: "memory"` (and the same for `demote_tags` and `demote_property`)
- `updated_after: not an ISO date`
- `ranking signals: <reason>`, including `ranking signals: property not found: <ident>`

**`get_blocks` (generated)** gains `view=signals` and `property`, returning `{blocks: [{uuid, updated-at, reference-count, status, property-values}], missing}`. Errors: `property not found: <ident>` (400), `property needs view=signals` (400).

Both tools stay read-only; annotations don't change.

## 5. Cost on the Free plan

Per query:

| Resource | Relevance mode, no `updated_after` or `demote_property` | Memory mode, or `updated_after` |
|---|---|---|
| Sync Worker requests | 1 or 4 keyword calls (unchanged) | +1 (`getBlocks` `view=signals`, at most 100 ids) |
| D1 rows read | `blocksFor` (at most 100 via indexes), `state` 1, `counts` per graph (unchanged) | +0: tags come from the `blocksFor` rows, and `graphFetch` reuses `resolveGraph`'s PAT with no D1 lookup (checked in 2) |
| D1 rows written | 0 | 0 |
| Workers AI neurons | 1 query embedding, about 0.04 neurons (unchanged) | +0 |
| Vectorize | 1 query, topK 50 (unchanged) | +0 |
| Vectorize storage | unchanged | unchanged: no new vectors or dimensions |
| Front Worker CPU | unchanged | + at most 100 factor products, a `log2` each and a sort: well under 1 ms of the 10 ms |
| Subrequests | at most about 9 of 50 | +1 |

No per-query scan. Per id the sync server reads the avet datoms of each reference attribute for that entity, which grows with that entity's referrers, not with the graph, and stops at the cap. The work happens on the sync Durable Object, not the front Worker.

Per day: if service-binding calls count against the 100k daily Worker requests (item 27's question 3, still open), 1,000 memory queries a day add 1,000 requests, 1% of the cap. The semantic API's rate limit (120 reads a minute per token, operation and graph) counts `getBlocks` separately from `search`.

Per indexer run: unchanged. No migration, no reindex, no storage change.

## 6. Safety

- **Read-only.** Neither tool writes. Nothing stored changes, so one deploy reverts the connector side. The patch adds a read view only.
- **Private blocks.** Unchanged. Signals are read for candidates the two legs already returned; `view=signals` returns no text, and `getBlocks` already applies `find-visible-entity`.
- **No silent fallback.** A failed signals call fails the call by name; an argument that would be ignored is refused; `before-updated-after` counts what the filter dropped.
- **No owner data.** No property ident, tag or page name is hardcoded. Tests and fixtures use example data and `sync.example.com`.

## 7. Risks

1. **The weights are guesses.** The eval on synthetic data shows each rule works, not that 0.5, 0.1, 1.5 and 90 days suit the owner's graph. Mitigation: memory mode is opt-in, `half_life_days` is an argument, every factor is reported, and section 9 records a live check.
2. **Patch 0035 re-tiers the work to full.** It needs `--upstream` checks and upstream's db-sync suite, and an upstream bump could conflict around `block-detail-response`, `bulk-read-response` or `referrer-ids`.
3. **Heavily referenced entities.** `referrer-ids` builds a set per id; for a tag page with thousands of referrers, 100 such ids could be slow on the sync Durable Object. Mitigation: the signals view counts with a bounded walk over the avet datoms and stops at 1,000 distinct visible referrers; importance saturates at 31. The patch test seeds an entity with more than 1,000 referrers and checks the cap.
4. **`updated-at` is a block's own stamp.** An edit to a child doesn't touch its parent, and edit stamps (patch 0034) or a `refresh_refs` run may bump `updated-at` without a meaningful change, which makes an old note look fresh. The help text says recency is the block's own last edit.
5. **Pages and blocks get different signals.** A keyword-only page hit gets page-level `updated-at` and references, and blocks get block-level ones, so a page with many backlinks can outrank blocks. The reported factors make it visible.
6. **`demote_tags` only sees indexed hits.** A keyword-only hit outside the index has no stored tags, so `demote_tags` can't match it (`demote_property` can, because it comes from the signals call). The help text says so (question 4).
7. **One more round trip.** The signals call can't start until `blocksFor` returns, so memory queries are slower by one sync call.
8. **Generated tool change.** `view=signals` changes `get_blocks`' schema; the manifest check and the README tool list change in the same commit.

## 8. Testing

Test first. Each new test is seen to fail before its change, and the failure is quoted in the PR.

**Upstream (patch 0035, in upstream's db-sync suite, real handler and real datascript DB):**

- `reference-count` counts a referrer on another page and leaves out the entity's own child that refers to it. Decoy: a hidden referrer, which is not counted.
- `reference-count` stops at 1,000 with more referrers seeded.
- `status` is `"done"` for a done task and `null` for a plain block.
- `property-values` comes from the block when it has the property and from its page when it doesn't (decoy: a sibling with another value).
- An unknown `property` answers 400 `property not found: <ident>`; `property` with `view=summary` answers 400.
- `missing` lists unknown uuids; `updated-at` is the entity's `:block/updated-at`.
- Each is run on the unpatched tree first and seen to fail (quote the failure: today `view=signals` answers 400 `view must be summary or outline`).

**Connector unit tests (`ranking.ts`, pure functions; one test per rule with a decoy only that rule separates):**

- Half-life: a hit exactly one half-life old scores 0.5 × an otherwise equal fresh one; a mutation of the base or the divisor fails it.
- Floor: a hit 10 half-lives old at rank 1 in both legs stays above a fresh hit at rank 2 in one leg (0.01639 against 0.01613); fails with a floor of 0.25.
- Null or future `updated-at`: recency 1.
- References: with all else equal, 3 references rank above 0; importance is 1.5 at 31 and at 500 references (saturation); fails if `REF_WEIGHT` or `IMPORTANCE_MAX` changes.
- Status `done` and `canceled` demote; decoy `todo` and `doing` don't.
- `demote_tags` matches a tag inherited from the page, case-insensitively; decoy: `archive` against `archives` doesn't match.
- `demote_property` matches case-insensitively; decoy: another value doesn't.
- Several rules apply the weight once and list every rule in `demoted-by`.
- Ties keep RRF order (stable sort).

**`hybridSearch` tests through `semantic-fakes` (`FakeGraph` with the new signals route, the real `SemanticStore` on miniflare D1, `FakeVectorIndex`):**

- Relevance mode makes no signals request (count them) and its output equals today's for the same fixture.
- Memory mode makes exactly one signals request, with the union of candidates (at most 100 ids).
- `updated_after` drops and counts before fusion, so `semantic-rank` and `keyword-rank` renumber; it drops a `missing` uuid.
- Each guard error has its exact text.
- A signals 500 fails the call with `ranking signals: ...`; an unknown property gives `ranking signals: property not found: ...`.
- The slice comes after the re-rank: a hit 11th by relevance and first by memory is returned at `limit` 10.

**Mutation pass.** For each constant, comparison and branch (`RECENCY_FLOOR`, `REF_WEIGHT`, `IMPORTANCE_MAX`, `DEMOTE_WEIGHT`, the default half-life, the null and future check, the once-only demotion, the status list, case folding, slice order, filter order), make the one-line mutation in a scratch copy and confirm a test fails. List the results in the PR.

**Eval.** Relevance-mode numbers on the old questions equal `baseline`; memory-mode recall@5 and MRR meet the new `floor`.

Then `scripts/check.sh --upstream` on HEAD, and the PR repeats what it skipped.

## 9. Rollout and verification

1. Merge to main deploys the sync Worker (with patch 0035) and the connector. The patch adds a view and changes nothing existing, so order of deploy doesn't matter; the connector's memory mode answers `ranking signals: view must be summary or outline` until the sync Worker has the patch.
2. Live check, read-only, against the owner's graph: three questions the owner picks where a stale and a current note both exist, each run in relevance and memory mode at `limit` 5. Record the rank of the current note and each hit's factors, without page names. Also call `get_blocks` with `view=signals` on 100 ids and record its latency.
3. Watch the next day's usage report: Worker requests and D1 rows read should not move noticeably.
4. Record the live rows in the results table below.

Revert: redeploy the previous connector; the patch can stay, as nothing else calls the view.

### Results

To be filled in by the build:

| Run | Mode | Hybrid recall@5 | Hybrid MRR |
|---|---|---|---|
| Offline, current fixture, HEAD `21ee74d` | relevance | 1.00 | 0.85 |
| Offline, extended fixture, before ranking code (Stage 2) | relevance | old 12: 1.00; memory 4: 1.00 | old 12: 0.85; memory 4: 0.58 |
| Offline, extended fixture, after (Stage 4) | relevance | old 12: 1.00; memory 4: 1.00 | old 12: 0.85; memory 4: 0.58 |
| Offline, extended fixture, after (Stage 4) | memory | memory 4: 1.00 | memory 4: 0.875 (pricing, domain and office current twins rank 1; the old decision ranks 2) |
| Live, after | relevance and memory | | |

## 10. Out of scope

- **A periodic consolidation routine and weekly-review queries** **(issue)**.
- **Storing updated-at or reference counts in D1** (migration 0007). Updated-at could be stored cheaply, but references can't stay correct (section 2), so the signals call is needed anyway.
- **Making memory mode the default.** Only if the eval and the live check both show a clear win (question 1).
- **Filtering on status or tags** beyond the existing `tag` argument. Demotion, not filtering, is the point.
- **Created-at, or recency from the newest descendant.** Possible later as an option.
- **Changing what the indexer embeds or the RRF constant.**

## 11. Open questions for the owner

1. **Weights.** The panel proposed a recency floor of 0.25 and importance up to 2 (0.25 per doubling of references). Because RRF scores span less than 2× across the top 50, those would let age and links override relevance entirely, so this spec uses a floor of 0.5, 0.1 per doubling and a cap of 1.5 (3.4). Keep these, or do you want memory mode to lean harder on recency?
2. **Default half-life.** 90 days, or something else for how you use the graph (30 for work notes, 365 for reference material)?
3. **Default mode.** Keep `relevance` as the default even if the offline eval favours `memory`? This spec says yes until the live check agrees.
4. **`demote_tags` on title-only hits.** A page found only by title search, and not in the index, can't be matched by `demote_tags`. Is that acceptable, or should the signals view also return tags (a few more bytes per id, no extra call)?
5. **Reference cap.** Is a cap of 1,000 referrers acceptable for `get_blocks`' new view, given importance stops rising at 31?
6. **Archived marker.** Your graph's archive signal: a tag, a property value, or both? The tool takes either as an argument; the skill note will name yours, and the repo won't.
7. **Live check.** Is a read-only before-and-after check on three of your questions acceptable, recording ranks and factors but no page names?
