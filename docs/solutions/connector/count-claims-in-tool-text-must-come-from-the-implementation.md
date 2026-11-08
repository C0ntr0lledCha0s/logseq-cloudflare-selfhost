---
title: Tool text that says what a count includes was written from the spec, and five reviewers found it wrong against the code
area: connector
tags: [contract, tool-description, connector_help, reference-count, docs-drift, readme]
seen:
  - 2026-11-08 – semantic-search recency and importance ranking, review round 1 and 2 (should-fix, deferred)
promoted_to: []
---

## Symptom

The `semantic_search` description, `connector_help` and the memory-mode docs said importance counts "references from other pages". Reviewers flagged the same sentence several times: for a block hit the signals view's `reference-count` also counts referrers on the block's own page and its own children. The spec's own wording (not the entity itself, not a block on its own page) was not what the patch's walk did for a block. Two related should-fix items were deferred: README 11.8 and 11.11 omit some new arguments, and the signals view returns `property-values: [""]` for the empty placeholder and skips the page fallback.

## Cause

The contract text was copied from the design's intent. Nobody ran a case (a block referenced from its own page) and read the number back before writing what the number means.

## Fix

Open at the end of the lane. Correct the sentence to what the view counts, or change the walk, and make README 11.8 and 11.11 list `rank`, `half_life_days`, `demote_tags`, `demote_property` and `updated_after`.

## How to catch it next time

For each sentence in tool text that defines a count or a filter, point to the test that pins it with a decoy (same-page referrer, child referrer). If there is none, write the sentence from the test's output, not the spec. A stub view in a fake (`semantic-fakes.ts` serves signals from fixtures) hides this, since the fake never computes a count.
