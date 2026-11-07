---
title: Promote a page to a tag by copying the app's convert-page-to-tag transaction, with guards ordered so each can fire
area: api
tags: [promote-page-to-tag, convert-page-to-tag, atomic-write, dry-run, find-entity, recycle-bin, namespaced]
seen:
  - 2026-11-06 – item 16, patch 0027
promoted_to: []
---

## Symptom

`create_tag` refuses a title an existing page holds (409, item 11), so a page could not become a tag. Nothing in the API did what the app's "Convert to tag" menu does.

## Cause

The conversion is not a plain write. The app's `convert-page-to-tag-tx` (`src/main/frontend/worker/handler/property.cljs`) gives the page the Tag class and a unique ident, and removes its page-ness while keeping UUID, blocks, properties and references. The app also refuses a title another tag uses, a namespaced page (the ident and the namespace would disagree) and built-ins. Redoing this by hand would drift from the app.

## Fix

Patch 0027 `promote_page_to_tag` reuses that transaction, runs it in `atomic-write!` (one tx id), and reuses 0026's `extends` validation and read-back. `dry-run=true` runs the same code on `dry-run-conn` and answers the same body with `dry-run: true`. The design panel's three options differed mainly on reusing the app transaction versus writing datoms; the reuse option scored highest (8 against 7.5 and 6.5) because the invariants are the app's own.

Traps found on the way:
- Look the id up with `find-entity`, not `find-visible-entity`. The Recycle bin guard can only run if the page is found, and with the visible lookup it would be a 404.
- Order the guards: Recycle bin, hidden, journal, built-in, property, already a tag (409), not a plain page, namespaced, title conflict (409). A body refusal (400) meeting a 404 or 409 answers 400.
- The `create_tag` 409 hint must use the same predicate as the promotion refusal, so it never points at a page the tool would refuse.

## How to catch it next time

- When the app has a menu action for a conversion, find its worker function first and copy its transaction. Test the app's invariants (UUID, blocks, references, ident, one tx id) against the real handler.
- Give each guard a case where only that guard decides the outcome, asserting `(:max-tx @conn)` and the datom count are unchanged.
