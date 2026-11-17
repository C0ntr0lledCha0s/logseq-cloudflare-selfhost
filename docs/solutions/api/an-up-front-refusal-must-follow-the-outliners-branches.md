---
title: An up-front refusal placed before the outliner's create must follow the outliner's own branches (restore versus create) and its journal rules
area: api
tags: [createPage, refusal, recycle-bin, restore, title, slash, journal, outliner-create, handler-guard]
seen:
  - 2026-11-17 – item 40, patch 0039, stage 6 (s-6-1); the journal-format and createTag/batch asymmetries were deferred as should-fix
promoted_to: []
---

## Symptom

Stage 6 added a refusal so `POST /semantic/pages` with a title holding "/" answers a named 400 instead of a 500. It also blocked a case that worked before: a page titled `zq/probe` (a namespace page from the app or a file-graph import) deleted into the Recycle bin could no longer be restored by creating it again. It answered 400 and the page stayed in the bin. The README and the createPage text both promise that restore. The stage's tests covered neither a recycled slash-titled page nor a restore.

## Cause

The outliner's `create!` has two branches. A new page is validated for its characters. A recycled page with the same `:block/name` is restored and never validated (`outliner/page.cljs`, new-page branch around line 483, restore branch around lines 445 to 455). The handler's holder check treats a recycled page as hidden, so the 409 branch is skipped and control reaches the new check, which fires on the restore case. The check re-implemented half of the outliner's decision and got the other half wrong.

Two related gaps were left as should-fix: the "/" check ignores the graph's journal title format, so it refuses journal titles the outliner would create (for example a lower-case weekday in a graph whose format is `E, MM/dd/yyyy`); and createTag and batch inserts get the same refusal as a 400 only through `rejecting`, a second path for the same rule.

## Fix

Look up the recycled holder by `:block/name` first and call `page-title-character-refusal` only when there is none. Add a test that recycles a slash-titled page and expects 201. Fixed in `4ae1ee5`.

## How to catch it next time

- Before adding a refusal ahead of an outliner call, read the outliner function and list every branch (new, restore, existing, journal). Say which branches the refusal applies to, and test each: one test per branch, including a recycled entity and a journal title.
- Prefer letting the outliner's own throw be translated to a named 400 (as `rejecting` does) over a second copy of its rule. If a copy is needed, it needs a mutation test where it alone decides the outcome.
- Reproduce a suspected regression with a probe through the real handler with the new refusal switched off, as the stage reviewer did; the before and after output settles it.
