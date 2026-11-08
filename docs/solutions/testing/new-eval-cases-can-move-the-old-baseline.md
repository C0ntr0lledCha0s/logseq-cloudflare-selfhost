---
title: Words in new eval documents can match old questions and move the recorded baseline
area: testing
tags: [eval-fixture, baseline, floor, keyword-leg, recall, mrr]
seen:
  - 2026-11-08 – semantic-search recency and importance ranking, plan Stage 2
promoted_to: []
---

## Symptom

Adding stale-against-current pairs to `semantic-eval.json` with a page titled "Pricing" dropped the old hybrid MRR from 0.85 to 0.81, with no ranking code changed.

## Cause

The keyword leg matches page titles and block text. A new document containing "pricing" became a keyword hit for the existing question "What did we decide about pricing?" and displaced its answer.

## Fix

The pair moved to a page titled "Price list" with texts "Starter tier v1: $12 a month" and "Starter tier v2: $15 a month". Relevance-mode numbers on the old questions must equal the recorded `baseline`, which proves the default is untouched; memory mode has its own baseline and floor.

## How to catch it next time

After extending the fixture, run the old questions before any code change and compare to `baseline`. A moved number means the new documents leak into old questions; reword them.
