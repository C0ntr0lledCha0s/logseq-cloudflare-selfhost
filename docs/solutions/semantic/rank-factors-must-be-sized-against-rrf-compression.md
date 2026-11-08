---
title: A multiplier applied to an RRF score has to be sized against how compressed RRF scores are, or it decides the whole order
area: semantic
tags: [ranking, rrf, recency, importance, memory-mode, constants, boundary-tests]
seen:
  - 2026-11-08 – semantic-search recency and importance ranking (memory mode), spec section 3.4
promoted_to: []
---

## Symptom

The design panel proposed recency floor 0.25, importance up to 2 (0.25 per log2 of references) and a 0.5 demotion per rule kind. On paper these look mild. Applied to the fused score they would have made relevance irrelevant.

## Cause

RRF scores are compressed. With `RRF_K` 60 a one-leg hit scores 1/61 = 0.01639 at rank 1 and 1/110 = 0.00909 at rank 50, a ratio of 1.8. Rank 1 against rank 10 is 1.15. Found by both legs at rank 1 it scores 0.03279. So any factor below about 0.55 outweighs every relevance difference except "found by both legs".

- A floor of 0.25 puts a fully aged, both-legs rank-1 hit (0.0082) under a fresh rank-50 one-leg hit (0.00909). The panel's own test, "the floor keeps a strongly relevant old hit above a fresh weak one", could not pass.
- 15 references doubling the score outweighs the whole rank 1 to 50 spread.
- Stacking 0.5 per demotion rule sinks a triple-matched hit below every other candidate.

## Fix

Constants in `connector/src/semantic/config.ts` were chosen from this arithmetic: `RECENCY_FLOOR` 0.5, `REF_WEIGHT` 0.1 with `IMPORTANCE_MAX` 1.5, `DEMOTE_WEIGHT` 0.5 applied once however many rules match. Unit tests pin each constant against the boundary it was sized for (spec 3.4 and section 8).

## How to catch it next time

Before choosing a multiplier on a fused score, compute the score at rank 1 and rank 50 for one leg and both legs, and the ratio the factor must stay inside. Write the boundary as a test (old strong hit stays above fresh weak hit), not just the constant. Even sized this way memory mode is mostly decided by the factors, which is why it is opt-in.
