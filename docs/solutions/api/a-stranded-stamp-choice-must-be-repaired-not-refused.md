---
title: A claude choice whose property was deleted is stranded; repair it and list it in graph health, because refusing every write is not a recovery path
area: api
tags: [edit-stamps, closed-value, retractEntity, orphan-choices, graph-health, precheck, error-text]
seen:
  - 2026-11-19 – item 27, patch 0041
promoted_to: []
---

## Symptom

"Mark Claude's edits" blocked every write on one graph with a 409 naming the claude choice's UUID. The choice itself returns 404 from `get_block` because closed values are hidden, so the owner could not inspect or remove it, and a service token did not help.

## Cause

The reported text (`held by a choice of  ()`) was the cardinality drift in `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`, not a stranded choice. The lane still found real stranded cases that the precheck handled badly:

- The `editedBy` property deleted with `:db/retractEntity` leaves its choice with no owner datom. The precheck then answered `held by a block` and refused every later flagged write, by design, with no repair action.
- A re-parented choice can clash with an existing order key.
- `orphan-choices` cannot list an ownerless choice by walking from a property, because there is no property to start from.

## Fix

Patch 0041: the precheck treats a choice with no owner as stranded and re-parents it to `editedBy` with a fresh order key, also when it is the duplicate claude choice. It refuses, naming the choice and the reason, only when the re-parent is unsafe. `get_graph_health` has an `orphan-choices` check, with a complete count and cursor paging. Its text, `connector_help`, the manifest and README 11.8 say which ownerless choices it cannot list.

## How to catch it next time

- A "held by X" refusal on every write needs an up-front repair or a named repair action, and a health check that lists what it stands on.
- Test each way the owner can be missing: nameless, all datoms retracted, no owner datom, deleted property. Quote which branch prints which message.
- Two tests that cannot fail were found in review (value order of the check, and editedBy's title sharing the choice's tx). A guard test still needs a reverted-fix run that fails.
