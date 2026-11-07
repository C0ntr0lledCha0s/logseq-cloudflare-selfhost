---
title: Each rule a fix adds needs a test case where that rule decides the outcome
area: testing
tags: [mutation, regression-test, ranking, scope, test-gap, test-that-never-failed]
seen:
  - 2026-11-06 – item 25, patch 0021, review round 3 (r3-tests-1, r3-tests-2)
  - 2026-11-06 – item 23, patch 0022, review round 3 (r3-tests-1): removing `(js/isFinite n)` from `number-text` left 312 tests green, so "NaN" was stored and read back as null
  - 2026-11-06 – item 26, patch 0026, review round 3 (r3-tests-1): weakening `own?` or `choice?` in convert_values left the suite green; fixed with a test that points a holder at another property's value block and at another property's choice
promoted_to: ["REVIEW.md"]
---

## Symptom

Patch 0021's tests failed without the fix, as REVIEW.md asks, yet seven of the rules the fix added and documented (pages before blocks, class match, user over built-in, hidden excluded, tags from the `Tags` property, the Task scope in `create_task`, the scope for batch entry properties) could each be removed with a one-line edit and the full db-sync suite (301 tests) stayed green.

## Cause

"The test failed before the fix" was checked for the fix as a whole, not for each rule. Every lookup in the tests left at most one candidate after the earlier filters, so the ranking rules never chose anything. No test set tags through a `Tags` key or used a tag-scoped choice on the task and batch paths, so a nil scope behaved the same as the real one.

## Fix

None in the lane yet: the findings were open at the end. The reviewers' suggested cases are in the PR (a page and a block sharing a title, a class-tagged and an untagged page, a built-in and a user page, a recycled page, `Tags`-set scope, a scoped Status on `create_task`, a scoped choice on a batch entry's page properties).

## How to catch it next time

- For each branch or rule the change adds, make the one-line mutation that removes it in a scratch copy and run the suite. A survivor is an untested rule.
- Build each case so that, without the rule, at least two candidates remain or the scope is the only thing that rejects the value.
- A rule that scopes by owner (this property's value blocks, this property's choices) needs a decoy owned by another property that would be matched if the scope were dropped.
- When the description, `connector_help` or README promises a rule to Claude, there is a test that fails if it goes.
