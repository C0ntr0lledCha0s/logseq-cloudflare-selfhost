---
title: The outliner throws when any private tag (Tag, Journal, Whiteboard, Property, Asset, Page) is set or removed through :block/tags, and an unrefused throw answers 500
area: api
tags: [page-tag, held-tags, tags, private-tags, journal, new-journal, choice-scope, tag-class, 500, outliner-throw, replace-write, idempotent, does-not-reproduce]
seen:
  - 2026-11-06 – item 16, patch 0027, stage 1 finding s-1-1 (review round 1)
  - 2026-11-07 – item 26 follow-up, patch 0029, defect 6 (Journal and the other private tags still answered 500, or the outliner's bare 400 on tree inserts), review round 1 (r1-correctness-1)
  - 2026-11-19 – item 38 (reset report not reproducible on HEAD; the whole-property delete of Tags still answers 500 on Page and Journal holders)
  - 2026-11-19 – item 38, patch 0042 (the remove route fixed: a Tags delete keeps built-in tags and answers 200; a value delete refuses a private tag or display class by name)
  - 2026-11-19 – item 43, patch 0043 (Page as a tags value, the one private tag left unrefused, answered 500 or a bare 400 on every write path)
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

Page as a tags value is refused up front by the same held rule since patch 0043 (item 43): a block is pointed to the app's convert-to-page, and a journal, tag or property is refused, since the schema rejects Page on them. A page re-sending Page and a batch page entry that creates a page stay allowed.

Rules kept so retries work: a private tag the target already holds is a no-op, Asset on an asset stays allowed, and the remaining tags in a list still apply. The regression test pairs every refused case with that control.

## Third sighting (item 38) and its fix (patch 0042)

The reset route was fixed and deployed (see [a-500-that-does-not-reproduce-on-head-may-predate-its-fix-deploy](a-500-that-does-not-reproduce-on-head-may-predate-its-fix-deploy.md)). The remove route was not: `remove-prepared-property!` calls `remove-block-property!`, which runs `throw-error-if-removing-private-tag`, so deleting Tags (single or batch) on a page, journal, whiteboard, asset, tag or property page answered 500, and the batch error carried no entry index. The delete handlers wrapped the write in `answering-unverified` and `refusing-labels`, which pass a `:notification` on to the catch-all 500.

Patch 0042: a whole-property Tags delete never reaches `remove-block-property!`. It removes only the tags that fail the `kept?` rule `set-prepared-tags!` uses (private tag or display class) and answers 200 with the built-in tags kept. A value delete (new optional `value`) refuses a private tag or display class as the value with a 400 naming the entry. A plain block still loses every tag (pinned by a guard test). The test pairs each private-tag holder with the delete, since each holder type has its own private tag and the throw is certain for all of them.

Check the other direction when you fix one half: the set and remove routes shared the rule but not the code, and only the set half had the `kept?` predicate.

## Fourth sighting (item 43, patch 0043): key the rule on what the target holds, not what it is

Page had been left out of the refusal because the outliner skips it in `disallow-node-cant-tag-with-private-tags` ("validated by later fns"). Those later guards differ by target. A nested block gets the "parent is not a page" notification (500 on set and batch-set, a bare 400 on inserts). A top-level block passes that guard, but server writes skip the client pipeline's `toggle-page-and-block`, so the entity fails schema validation (`:block/name` missing, 500). A journal or tag page fails the schema ("should not have other built-in page tags when tagged with #Page", 500).

The brief proposed "refuse Page when the target is not a page". That would have left the journal and tag cases answering 500, because those are pages. The rule that works is "refuse Page unless the target already holds it" (its `:block/tags` plus the scope's `::held-tags`). That keeps a page re-sending Page a no-op and keeps a batch page entry that creates a page (it gets Page through `new-page-held-tags`).

Catch it: when a brief states the refusal rule in terms of target type, reproduce each target type (nested, top-level, journal, tag, property) through the real handler before writing the rule, and prefer the held-tags form that the earlier private-tag branches already use. Nothing was written in any failing case, so the defect was status and message only; the test still asserts max-tx and datom count are unchanged.
