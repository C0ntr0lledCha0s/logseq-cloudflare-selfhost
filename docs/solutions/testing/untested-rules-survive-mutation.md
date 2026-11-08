---
title: Each rule a fix adds needs a test case where that rule decides the outcome
area: testing
tags: [mutation, regression-test, ranking, scope, test-gap, test-that-never-failed]
seen:
  - 2026-11-06 – item 25, patch 0021, review round 3 (r3-tests-1, r3-tests-2)
  - 2026-11-06 – item 23, patch 0022, review round 3 (r3-tests-1): removing `(js/isFinite n)` from `number-text` left 312 tests green, so "NaN" was stored and read back as null
  - 2026-11-06 – item 26, patch 0026, review round 3 (r3-tests-1): weakening `own?` or `choice?` in convert_values left the suite green; fixed with a test that points a holder at another property's value block and at another property's choice
  - 2026-11-07 – item 17, patch 0028, review rounds 1 to 3 (r1-tests-1, r2-tests-1, r2-tests-2, r3-tests-1): the batch-insert dry run's "fail when the context read fails" rule, the label segment floor and separator guards, and the journal-date lookup in batch insert each survived mutation until a test made them decide the outcome
  - 2026-11-07 – item 26 defect 4, patch 0030, round 1 (r1-tests-1): four convert_values reference rules survived mutation until tests pinned the 409 body shape (references-only has no `retired`, retire-only has no `converted`) and the singular wording
  - 2026-11-07 – item 26 defects 1 and 2, patch 0031, round 1 (r1-tests-1): the isResetExistingValues rule (a single tag adds, only a list replaces) in the final-tags overlay left the namespace green when mutated; a test where that rule alone decides the outcome killed it
  - 2026-11-07 – item 28, rounds 1 to 3 (r1-tests-1 to 3, r3-tests-1): the snapshot cap, the first-entry-returned-whole rule and the audit page filters needed tests where that rule alone decided the outcome; each new rule was then mutated in a scratch copy
  - 2026-11-07 – service-token-cloud-sessions, round 1 (r1-tests-1, r1-tests-2): the wizard read-back check compared only the length of `graph_ids`, so a swapped, duplicated or different single graph passed, and nothing pinned that a token shows as expired at exactly `expires_at`; tests that tamper without changing the length and sit on the boundary killed both
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
