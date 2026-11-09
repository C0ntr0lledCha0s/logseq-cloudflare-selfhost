---
title: A new input form or refusal rule (journal date, reserved ident) must reach every site that takes that input, not just the first
area: api
tags: [selector, journal-date, ldb/get-page, target-label, dry-run, batch-insert, reserved-ident, prepare-properties, every-route]
seen:
  - 2026-11-07 – item 17, patch 0028, review round 2 (r2-correctness-1)
  - 2026-11-07 – item 29, patch 0034, review round 1 (r1-correctness-1): the stamp-property refusal covered the property tools but not the insert routes' properties
  - 2026-11-09 – page favourites, patch 0038, stage 2 check (s-stage-2-1): a toggle's `favorite: false` skipped the hidden-page refusal that `favorite: true` had
promoted_to: ["REVIEW.md"]
---

## Symptom

A batch_insert_block_trees entry whose page was a journal date (`2026-11-05`) was reported by its dry run as "would create" a journal that already existed, and `target-label` was checked against the date text, so the journal's own title was refused while the date text passed.

## Cause

Page selectors by title or journal date were added to the shared resolver, but `insert-page` still looked the page up with `ldb/get-page`, which misses a date. `outliner-page/create!` does map the date to the existing journal, so the write was right and only the lookup, the created flag and the label check were wrong. Three places held their own copy of "find the page".

## Fix

`insert-page` resolves the date to its journal first and uses that for the lookup, the label check and the created flag. A journal the entry will create is checked against the title it will get (`int->journal-title` in the graph's date format). Test: `batch-insert-journal-date-page-test`, plus a choice-values test that tags journals by date, date then UUID and UUID then date.

## How to catch it next time

When an input form is added, `git grep` the lookups the old form went through (`ldb/get-page`, `get-page`) and test every consumer with the new form: the write, the dry run, the label check and the created flag. Test the same page named two ways in one batch.

Same shape for refusals: a rule added to one route (refuse the reserved stamp idents in the property tools) missed the insert routes, which build properties through `prepare-properties`. List every route that accepts the input, flagged and unflagged, and test each with each form of it (title, ident, UUID). See `authorship-stamps-ride-the-write-transaction.md`.

## Also: the other direction of a toggle

A set/unset tool is two routes through one handler. `set_page_favorite` refused a hidden target only when `favorite` was true, so a remove answered 200 and disclosed the title. When adding a refusal, test it with each value of the flag (add and remove, set and clear), by uuid and by title, and check nothing was written. (`docs/solutions/api/favourites-are-app-worker-code-the-server-must-reimplement-them.md`)
