---
title: A title or UUID resolver must drop built-in hidden pages explicitly, because the privacy check does not cover them
area: api
tags: [resolver, candidates, hide, private, recycle, favorites, views, client, named-query, title-resolves]
seen:
  - 2026-11-22 – item 52, patch 0054, review round 1 (r1-tests-1)
promoted_to: []
---

## Symptom

The new `client` param of `open-tasks-by-client` resolves a title or UUID to an entity. Review round 1 found that removing the `hidden?` check from the candidate search, or from the UUID branch, left every test green, and a client of `Recycle` answered 200 and echoed the page.

## Cause

The Recycle, `$$$favorites` and `$$$views` pages carry `hide?` but no `deleted-at` and no Private tag. A resolver that drops "private or recycled" entities through `private?` therefore still accepts them. The title path and the UUID path are separate branches, so each needs the check.

## Fix

The resolver drops hidden entities by title and by UUID. `named-client-refusals-test` gives each of the three pages by title and by UUID and expects the no-title or no-UUID 400.

## How to catch it next time

- For any new resolver, list the entities that are hidden but not private (the built-in pages) and give each one by title and by UUID in the refusal table.
- Mutate each branch of the resolver away and run the suite (see `testing/untested-rules-survive-mutation.md`). Here the mutant answered 200 echoing Recycle.
- If a third resolver hits this, promote it to a REVIEW.md rule next to *Titles resolve inside the allowed set*.
