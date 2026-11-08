---
title: A loose keyword leg fused by rank outweighs the meaning leg; test it with decoy pages and cap it before it is ranked
area: semantic
tags: [ranking, rrf, keyword-leg, search_graph, decoys, eval-fixture, title-search]
seen:
  - 2026-11-08 – item 27, semantic-search-ranking-quality, review rounds 1 and 2 (r1-correctness-1, r2-correctness-1)
promoted_to: []
---

## Symptom

Item 27 made the keyword leg search a question's distinctive words instead of the whole phrase, because `search_graph` on "stock level reporting dashboard" matched nothing. Two review rounds then found the new leg hurting results.

- Round 1: with three or more content words, only single-word title searches ran, each capped at 20. A page titled "Project status meeting" could be missing from every term's list, and pages are not embedded, so the meaning leg could not bring it back.
- Round 2: a title holding one word of the question ("Carpooling" for "car", "Fitness plan" for "fitness") took keyword rank 1. The WOF answer fell from rank 1 to rank 3.

## Cause

Reciprocal rank fusion weights rank 1 in the keyword list the same as rank 1 in the semantic list, whatever the match quality. So any rule that puts weak hits at the top of the keyword list gets the same pull as the best semantic hit.

`searchGraph` also fills a capped list in title order. It ranks an exact title first only when the needle is the whole title. A per-word search is therefore a lottery once the graph has more than the cap of titles containing that word.

The eval fixture did not show either problem. It had no pages that held one word of a question, so the first version of the rule scored the same as the fixed one.

## Fix

In `connector/src/semantic/ranking.ts`:

- The whole phrase is searched as well as the terms, and phrase hits go first (`phraseFirst`).
- `mergeKeywordLists` keeps only uuids that at least two term searches found (`KEYWORD_TERM_MATCHES`). Phrase matches are kept as before.
- The merged list is capped at 50 before the D1 read, so the bind list does not grow.

The fixture gained five decoy "Notes for ... later" pages, each holding one word of a question, and the WOF question must reach rank 1. The floor's hybrid MRR was lowered from 0.89 to 0.85 on purpose, because one decoy is also that question's nearest block by meaning in the fake embedder. The original pages alone still give 0.90.

## How to catch it next time

- When a new leg or signal is fused by rank, ask what its rank 1 looks like when it is wrong. Give the eval fixture decoys that match one word of a question, and a question whose answer only one leg finds.
- Check each rule's output order against the search primitive's real ordering and cap (`searchGraph` fills in title order), not an assumed relevance order.
- Mutate each ranking rule (the two-term minimum, phrase first, the cap) and confirm a case fails. See [untested-rules-survive-mutation](../testing/untested-rules-survive-mutation.md).
- Keep the user-facing wording in step with the rule's exact test. Review also deferred a contract finding: the description and `connector_help` said "three or more words" while the rule counts content words, so the help's own example question took the old path.
