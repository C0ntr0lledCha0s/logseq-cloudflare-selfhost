---
title: A batch's validation and its apply step must use the same model of state, or valid calls are refused and invalid ones stored
area: api
tags: [validation, rename, choices, ordering, errors, batch, classes, tags, snapshot, overlay, final-state, class-refusal, title-candidates]
seen:
  - 2026-11-06 – item 26, patch 0026, stage S3 finding s-S3-1 (choice renames: validated on the final state, applied in order)
  - 2026-11-07 – item 26 defects 1 and 2, patch 0031 (class checks: validated on the pre-batch snapshot, applied in order)
promoted_to: ["REVIEW.md"]
---

## Symptom

`updateProperty` with `choices.update [{choice:'Backlog', title:'Active'}, {choice:'Active', title:'Done2'}]` passed validation, then answered 400 `Choice already exists.` naming no entry. A swap of two titles did the same. The reverse-order chain succeeded, so the outcome depended on entry order.

## Cause

`validate-choices` judged title uniqueness on the final state (Active is freed by the second entry), but `apply-choices!` applied entries one at a time, and upstream's `upsert-closed-value!` checks duplicates against the current state. Validation and application used different models of the same rule, so the apply step threw its own unnamed error.

## Fix

Patch 0026 orders each rename after the rename of the choice that holds its new title, so a chain works in any order. Renames that pass titles round a cycle are refused before any write, naming the entry and the cycle. Title comparison matches the case-sensitive one upstream uses.

## Second face: the pre-batch snapshot (patch 0031)

`title-candidates` (class filter) and `class-refusal` (value by UUID, ident or db id) read `:block/tags` of the value entity from the request's pre-batch `db`. The batch reducer tracked tags that earlier entries add, but fed them only into `scope` (the block receiving the value). So a batch that tags a page with the property's class and then sets the property to that page was refused in either entry order (`entry N: no #Client object ...`), and the converse, an earlier reset dropping the class from a page and a later entry setting the restricted property to it, was accepted and stored out of class, because the outliner does not check classes on server writes. The handler's class check is the only guard, so a wrong model fails in both directions.

Patch 0031 computes each entity's final tags for the whole batch first (`final-tags`, copying the tag-apply rule of `set-prepared-tags!`: a single tag adds, a list replaces the user tags and keeps private ones), then judges every set or insert entry against that overlay. `db-db/class-instance?` reads only `:block/tags` and the tags' parents, so an overlay map is enough. Batch insert has the same shape (`resolve-insert-entries`) and is covered.

Known gaps, left on the backlog: the overlay does not include the Task tag the outliner adds when a batch sets Status, Scheduled or Deadline (r1-correctness-1), and it judges final tags but still reads extends and the property's classes from before the batch (r2-integrity-1). `final-tags` is a second copy of the tag-apply rule and must stay in step with `set-prepared-tags!`.

## How to catch it next time

- When validation is a pure function of the final state, check that the apply step can reach that state step by step. Test chains, swaps and rotations in both orders.
- Any per-entry check inside a batch loop (classes, choices, uniqueness) must see what the other entries do. Ask which db the check reads. If it is the request's `db`, build an overlay of the batch's own changes first. Test the tag entry before and after the set entry, a chain of three, a value given by title, UUID, ident and db id, and the converse (a reset that removes the class must be refused, nothing written).
- Every refusal that can come from the apply step must name the entry. A bare upstream message after validation passed means the two disagree.
