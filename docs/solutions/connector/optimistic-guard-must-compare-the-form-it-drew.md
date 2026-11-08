---
title: An optimistic-concurrency guard must compare against the values the form was drawn from, on every submit, not the row read at POST time
area: connector
tags: [lost-update, stale-form, two-tabs, before-value-guard, base-field, service-token, wizard, skeptic-wrong-checkout]
seen:
  - 2026-11-08 – edit-service-token-scope, review round 2 (r2-integrity-1, wrongly refuted; kept in should_fix_deferred)
promoted_to: []
---

## Symptom

A token covered graph A read-only. In tab 1 the owner opened the edit form. In tab 2 they added graph B, raised the token to read-write and confirmed. Back in tab 1 they shortened the expiry and saved. The save answered 303 and the confirmed widening was silently undone (B and write access gone), with no "changed since you opened this page" and no confirm page.

## Cause

`submitTokenEdit` built `before` from the row it read in the same POST, then guarded the UPDATE on that `before`. The guard therefore only caught a change between the read and the UPDATE (milliseconds), never between rendering the form and submitting it. The hidden `base` field existed only on the confirm page, and was checked only for widenings. Tab 1's old scope looked like a narrowing of the current row, so it applied at once. A test ("replaying the first page afterwards only narrows, so it applies at once") pinned this as expected behaviour, and the spec and the `update()` docstring claimed "no lost updates".

## Fix

Not applied in the lane (deferred as should-fix). The remedy: put the scope the form was drawn from in a hidden `base` field on the edit form too. On every POST, narrowings included, refuse (409, or show the confirm page again) when `base` is missing or differs from the stored row, and diff against `base`. Flip the chain test to expect the refusal and add the two-tab test.

## How to catch it next time

- For any form that edits stored state, ask "what is the guard's before-value read from?" If the answer is "the row, in this request", it is not a stale-form guard.
- Write the two-tab test (open form, change state elsewhere, submit the old form) for each edit route. Distrust a test whose name says a stale replay "just applies".
- When a design says "fails closed" or "no lost updates", the plan needs the test that shows it.
- Process: a skeptic refuted this finding because it read the main checkout (a different branch, where `submitTokenEdit` did not exist) instead of the lane's worktree. A refutation that says "the cited file or line does not exist" means the wrong tree was read; re-run it against the lane's HEAD sha before dropping the finding.
