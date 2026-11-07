---
title: A temp-conn listener that keeps the last :outliner-op mislabels the commit when later helpers transact on the same conn
area: sync
tags: [tx-meta, outliner-op, authored-write, listen-db, transform-tx-meta, tx_log, schema-creation]
seen:
  - 2026-11-07 – item 29, patch 0034, stage 1 check (s-stage-1-1)
promoted_to: []
---

## Symptom

The first flagged write on a graph (the one that had to create the edit-stamp schema) reached `tx_log.outliner_op` as `:upsert-closed-value` instead of its own op (`:save-block`, `:delete-blocks`, move, batch). Pulling clients saw the wrong op, and sync's delete handling (`delete-outliner-ops`), `find_checksum_drift` and the pull feed all read that column. Nothing failed; the data looked fine in the db.

## Cause

`authored-write!` runs the mutation on a temporary conn, then replays it as one transaction. Its `:listen-db` callback keeps the last report that carries an `:outliner-op`, and `:transform-tx-meta` returns that. `ensure-stamp-schema!` ran after the mutation on the same conn, and `upsert-property!` and `upsert-closed-value!` each transact with their own op, so theirs was the last one kept. Any helper that transacts on the conn after the mutation, with its own op, overwrites the write's label this way.

## Fix

Patch 0034 stops capturing (a volatile `capture?` flag the listener checks) before `ensure-stamp-schema!` runs. `first-flagged-write-keeps-its-own-outliner-op-test` runs six write kinds unflagged and as a graph's first flagged write and checks both commit one transaction under the same op. It failed for all six before the fix. A probe that listened on the conn's tx-meta found it (`[:save-block :upsert-closed-value]`).

## How to catch it next time

- Anything that transacts on the temp conn after the mutation (schema, authorship, stamps, repairs) is a risk to the op label. Capture tx-meta only while the mutation runs, or write the extra datoms with the listener off.
- A test for "the write is unchanged" must assert `tx-meta` (op and tx id count) of the committed transaction, not only the resulting db. The db looks identical either way.
- Test the case where the helper has work to do (first use on a graph), not only the steady state where it is a no-op.
