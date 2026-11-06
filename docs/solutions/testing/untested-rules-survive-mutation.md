---
title: Each rule a fix adds needs a test case where that rule decides the outcome
area: testing
tags: [mutation, regression-test, ranking, scope, test-gap, test-that-never-failed]
seen:
  - 2026-11-06 – item 25, patch 0019, review round 3 (r3-tests-1, r3-tests-2)
promoted_to: []
---

## Symptom

Patch 0019's tests failed without the fix, as REVIEW.md asks, yet seven of the rules the fix added and documented (pages before blocks, class match, user over built-in, hidden excluded, tags from the `Tags` property, the Task scope in `create_task`, the scope for batch entry properties) could each be removed with a one-line edit and the full db-sync suite (301 tests) stayed green.

## Cause

"The test failed before the fix" was checked for the fix as a whole, not for each rule. Every lookup in the tests left at most one candidate after the earlier filters, so the ranking rules never chose anything. No test set tags through a `Tags` key or used a tag-scoped choice on the task and batch paths, so a nil scope behaved the same as the real one.

## Fix

None in the lane yet: the findings were open at the end. The reviewers' suggested cases are in the PR (a page and a block sharing a title, a class-tagged and an untagged page, a built-in and a user page, a recycled page, `Tags`-set scope, a scoped Status on `create_task`, a scoped choice on a batch entry's page properties).

## How to catch it next time

- For each branch or rule the change adds, make the one-line mutation that removes it in a scratch copy and run the suite. A survivor is an untested rule.
- Build each case so that, without the rule, at least two candidates remain or the scope is the only thing that rejects the value.
- When the description, `connector_help` or README promises a rule to Claude, there is a test that fails if it goes.
