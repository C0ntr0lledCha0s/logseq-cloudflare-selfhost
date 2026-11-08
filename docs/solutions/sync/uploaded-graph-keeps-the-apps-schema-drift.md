---
title: A graph uploaded from the app keeps the app's stored schema, where a many attribute can be cardinality one; read it from datoms and repair it on open
area: sync
tags: [schema, cardinality, upload, snapshot, closed-value-property, edit-stamps, convert-values, datoms, check-and-fix-schema]
seen:
  - 2026-11-08 – edit stamp 409 hotfix, patch 0034 amended
promoted_to: ["REVIEW.md"]
---

## Symptom

On a graph first synced from the Logseq app, the first flagged write succeeded and every later one answered `409 edit stamps: the claude choice's UUID (3072a652-18e8-4dcb-bb37-e1aa38c8e3e9) is held by a choice of  (), not by editedBy`. The owner and its ident were empty. The same graph also failed `convert_values` and showed no owner in the graph-health `mismatched-choice-values` check. Graphs created on the server did not show any of this, so the server's own tests passed.

## Cause

The app's upload (`<prepare-upload-temp-sqlite!`) builds a temporary connection with the client's `(d/schema @source-conn)` and re-adds every datom with `{:initial-db? true}`. The built-in property entity for `:block/closed-value-property` carries `[30 :db/cardinality :db.cardinality/one]`, because `built-in-properties` gives it no `:cardinality :many`. The datascript fork treats that datom as a schema entry and overwrites the attribute's cardinality to one. The uploaded rows hold that schema, and the server's `storage/open-conn` restores it (`d/restore-conn` ignores the `db-schema/schema` argument). The app repairs this on every open with `frontend.worker.db.fix/check-and-fix-schema!`. The server never ran it.

The stored datoms were correct. Only reads changed: `(:block/closed-value-property choice)` returned one entity instead of a set, so `(map :db/ident …)` and `first` walked the owner entity's attribute pairs and gave nil.

## Fix

Patch 0034 (amended, no new number, because the repair and the stamp ship together):

- `storage/repair-schema!` compares the built-in attributes' schema with `db-schema/schema` in memory and transacts one logged tx only when they differ. It is called by the semantic and sync `ensure-conn!`, not by `open-conn`, so the read-only node scripts never write. It is skipped while `snapshot-uploading?` is set, because the graph is incomplete then. It costs no D1 rows.
- `choice-owners` reads a choice's owners from `:eavt` datoms. `stamp-choice-conflict`, `convert_values`' `choice?` and the health check's `value-property` use it, so they are right before the first open repairs the schema.

## How to catch it next time

- Test on a graph built through the upload path (conn created with the client's full schema, then `storage/open-conn`), as well as a server-created one. A graph made by the server's own `create-conn` has the right schema and hides this.
- Don't read a many attribute through an entity set when a datoms read gives the same answer. Reverse reads (`:block/_closed-value-property`) always return a set and are safe.
- Check `(:schema @conn)` for the attribute when a many attribute misbehaves on one graph only.
- Data effect: before this fix, `convert_values` on an uploaded graph could delete the property's own choice and answer 500 (the choice was not recognised as the property's own). The owner may want to check past `convert_values` calls on uploaded graphs in the audit log.
- The repair runs on the first request after deploy. A connection opened during a multi-chunk upload stays unrepaired until the Durable Object restarts; the datom reads cover stamps meanwhile.
