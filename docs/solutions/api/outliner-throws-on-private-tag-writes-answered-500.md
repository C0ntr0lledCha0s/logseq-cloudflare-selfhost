---
title: The outliner throws when Tag or Page is set or removed through :block/tags, and an unrefused throw answers 500
area: api
tags: [tags, private-tags, tag-class, 500, outliner-throw, replace-write, idempotent, does-not-reproduce]
seen:
  - 2026-11-06 – item 16, patch 0027, stage 1 finding s-1-1 (review round 1)
promoted_to: []
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
