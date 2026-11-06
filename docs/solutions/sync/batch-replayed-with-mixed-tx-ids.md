---
title: A batched write must reach the sync log as one transaction with one tx id
area: sync
tags: [batch, transaction, tx-id, normalize-tx-data, sync-log, client-replay, extends]
seen:
  - 2026-11-06 – item 21, patch 0018, PR #34
promoted_to: ["CLAUDE.md Gotchas", "REVIEW.md"]
---

## Symptom

A reset batch moving two tags (Business, Department) from Root to Organization left Department under both Root and Organization in the desktop app. The server stored the right values and returned `updated: 2`.

## Cause

A batch runs on a temporary copy of the graph and replays its datoms into the graph in one transaction, but each datom kept the copy's tx id. `normalize-tx-data` keeps one change per entity, attribute, value and tx id, sorted by tx id. Department's last Root retract carried an earlier id than the add it undid, so clients replayed "retract Root, then add Root".

## Fix

Patch 0018 replays the batch's changes without their tx ids. Two tests (the normalizer, and the API call replayed on a client copy) fail without it. A first attempt that changed the sync log ordering broke two desktop sync tests and was dropped.

## How to catch it next time

- Check a write's result where the client sees it (replay the sync log on a client copy), not only the server's db.
- Any batch test needs at least two entries touching the same attribute, with defaults that get re-added (Root, for example).
