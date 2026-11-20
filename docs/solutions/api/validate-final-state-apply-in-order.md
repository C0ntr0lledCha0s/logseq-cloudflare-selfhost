---
title: A batch's validation and its apply step must use the same model of state, or valid calls are refused and invalid ones stored
area: api
tags: [validation, class-schema, extends, refusal, patch-0045, rename, choices, ordering, errors, batch, classes, tags, snapshot, overlay, final-state, class-refusal, title-candidates]
seen:
  - 2026-11-06 – item 26, patch 0026, stage S3 finding s-S3-1 (choice renames: validated on the final state, applied in order)
  - 2026-11-07 – item 26 defects 1 and 2, patch 0031 (class checks: validated on the pre-batch snapshot, applied in order)
  - 2026-11-19 – item 45, patch 0045 (the rule's own inputs, a property's classes and a tag's extends, written inside the batch)
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

Known gaps, left on the backlog: the overlay did not include the Task tag the outliner adds when a batch sets Status, Scheduled or Deadline (r1-correctness-1, item 44; closed by patch 0048, which emits a `task-tag-write` per such entry in request order and lets `final-tags` add Task only where `should-add-task-tag-for-property?` would, and not for a Scheduled or Deadline write equal to the value the block holds at that point, which `set-block-property!` skips as a no-op), and it judges final tags but still reads extends and the property's classes from before the batch (r2-integrity-1). `final-tags` is a second copy of the tag-apply rule and must stay in step with `set-prepared-tags!`.

## Third face: the rule's own inputs (patch 0045)

Patch 0031 left one gap: an entry that writes `logseq.property/classes` or `logseq.property.class/extends` changes the very data the class check reads. With reset, entry 0 changing classes to Service and entry 1 setting the value to a Client page answered 200 and stored it out of class. Adding Service then using a Service page was falsely refused. The same write also bypassed `update_property`'s checks (a plain page stored as a class, Root, the out_of_class report).

Patch 0045 chose to refuse rather than extend the overlay. `class-schema-refusal` (combined with the stamp refusal in `set-property-refusal`) answers 400 on single set, batch-set and insert/target properties, names the entry and points to `update_property` or `update_tag`. An overlay would have copied the outliner's extends normalisation and left the validation bypass open. When a rule's inputs have their own validated write path, refuse them in the batch instead of modelling them.

Known gap: `delete_block_property` and `batch_delete_block_property` still change classes and extends, so help text and README saying "only update_property / update_tag" overstate it (deferred should-fix).

## How to catch it next time

- When validation is a pure function of the final state, check that the apply step can reach that state step by step. Test chains, swaps and rotations in both orders.
- Any per-entry check inside a batch loop (classes, choices, uniqueness) must see what the other entries do. Ask which db the check reads. If it is the request's `db`, build an overlay of the batch's own changes first. Test the tag entry before and after the set entry, a chain of three, a value given by title, UUID, ident and db id, and the converse (a reset that removes the class must be refused, nothing written).
- Ask which attributes the check itself reads (classes, extends). If a batch entry can write them, either overlay them or refuse the write and point to the tool that validates it. Cover every write path (set, batch-set, insert properties, and delete).
- Every refusal that can come from the apply step must name the entry. A bare upstream message after validation passed means the two disagree.
