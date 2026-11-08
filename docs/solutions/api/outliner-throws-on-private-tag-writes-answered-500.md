---
title: The outliner throws when any private tag (Tag, Journal, Whiteboard, Property, Asset, Page) is set or removed through :block/tags, and an unrefused throw answers 500
area: api
tags: [tags, private-tags, journal, new-journal, choice-scope, tag-class, 500, outliner-throw, replace-write, idempotent, does-not-reproduce]
seen:
  - 2026-11-06 – item 16, patch 0027, stage 1 finding s-1-1 (review round 1)
  - 2026-11-07 – item 26 follow-up, patch 0029, defect 6 (Journal and the other private tags still answered 500, or the outliner's bare 400 on tree inserts), review round 1 (r1-correctness-1)
promoted_to: ["REVIEW.md", "CLAUDE.md Gotchas"]
---

## Symptom

Setting an empty page's `tags` to Tag answered HTTP 500 (item 26, folded into item 16). A page with blocks failed the same way, and so did re-sending Tag to something that was already a tag. The spec had guessed the cause was a tag left without a `:db/ident`. It wasn't.

## Cause

The outliner's own guard, `validate-tags-property` then `disallow-node-cant-tag-with-private-tags` (`deps/outliner/src/logseq/outliner/validate.cljs`), throws "Can't set tag with built-in #Tag" before anything is written. `setBlockProperty` and `batchSetBlockProperty` turned that throw into a 500. The tree inserts already answered 400, but with the outliner's bare text. The same guard also throws "Can't remove private tags" when a replace-style tags write (a list on `setBlockProperty`, or `isResetExistingValues`) clears Page or Tag first, so a harmless re-send of a tag's own tags could fail.

## Fix

Patch 0027: `tag-value-refusal` inside `prepare-property-value`, which every write path resolves tags through, refuses Tag as a value up front with a 400 that names the entry and points at `promote_page_to_tag`. Tag sent to something that is already a tag is a no-op that succeeds. `set-prepared-tags!` doesn't set a tag the entity holds and, under reset, removes only the tags the list leaves out.

## How to catch it next time

- Before you write a cause into a spec, reproduce the 500 and read the thrown message. The guess here was wrong, and the stage's first test (written to fail first) found the real guard.
- A stage's done_when can say "still works" for a case the new refusal catches. Review found this one: the first cut answered 400 for a re-sent Tag. Test the idempotent re-send of every value you start refusing, since a retry is the likely caller.
- When you refuse a value, list every write path that resolves it (set, batch set, reset, batch insert properties, tree insert). `updatePage` takes only a title, so it is not one; pin that with a test so a later stage can't depend on it silently.
- Any outliner validation that throws must be pre-empted by a handler check, or it answers 500.

## Second sighting (patch 0029)

Patch 0027 refused only Tag, so Journal, Whiteboard, PDF Annotation, Property and Asset (on a non-asset) still reached `disallow-node-cant-tag-with-private-tags`. The fix widened the refusal to every `ldb/private-tags` member except Page. The tree inserts answered 400 with no entry or path, so they needed the entry or path prefix too. Review round 1 found two regressions from the first cut of the widening:

- The choice scope for a tags write was worked out without the real target, so a private tag the target already held (a journal re-sending Journal) dropped the other tags in the list (Food) from scope. Resolve tags against the real target.
- A batch page entry that creates a journal gets Journal from `outliner-page/create!`, so a new journal may be sent Journal while other private tags stay refused. Count the tags the create will add.

Page as a tags value is still not refused up front (backlog r1-correctness-2).

Rules kept so retries work: a private tag the target already holds is a no-op, Asset on an asset stays allowed, and the remaining tags in a list still apply. The regression test pairs every refused case with that control.
