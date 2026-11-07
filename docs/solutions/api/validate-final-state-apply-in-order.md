---
title: Validating a batch on its final state while applying it in request order refuses valid-looking calls with a generic error
area: api
tags: [validation, rename, choices, ordering, errors, batch]
seen:
  - 2026-11-06 – item 26, patch 0026, stage S3 finding s-S3-1
promoted_to: []
---

## Symptom

`updateProperty` with `choices.update [{choice:'Backlog', title:'Active'}, {choice:'Active', title:'Done2'}]` passed validation, then answered 400 `Choice already exists.` naming no entry. A swap of two titles did the same. The reverse-order chain succeeded, so the outcome depended on entry order.

## Cause

`validate-choices` judged title uniqueness on the final state (Active is freed by the second entry), but `apply-choices!` applied entries one at a time, and upstream's `upsert-closed-value!` checks duplicates against the current state. Validation and application used different models of the same rule, so the apply step threw its own unnamed error.

## Fix

Patch 0026 orders each rename after the rename of the choice that holds its new title, so a chain works in any order. Renames that pass titles round a cycle are refused before any write, naming the entry and the cycle. Title comparison matches the case-sensitive one upstream uses.

## How to catch it next time

- When validation is a pure function of the final state, check that the apply step can reach that state step by step. Test chains, swaps and rotations in both orders.
- Every refusal that can come from the apply step must name the entry. A bare upstream message after validation passed means the two disagree.
