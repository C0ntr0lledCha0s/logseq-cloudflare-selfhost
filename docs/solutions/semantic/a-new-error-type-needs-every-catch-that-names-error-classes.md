---
title: A new error type must be handled by every catch that names error classes, or one failure aborts a whole cron run
area: semantic
tags: [indexer, cron, catch, error-classes, SyncStoppedError, isolation, rethrow]
seen:
  - 2026-11-19 – item 53 (indexer aborted by a rejected sync request; the error type came from PR 52)
promoted_to: []
---

## Symptom

One rejected `env.SYNC.fetch` (the sync server stopped or reset mid-request) made the whole cron `runIndexer` throw. The failed graph stayed leased as `building` with no error saved, and every graph after it in the lease order was not visited in that run.

## Cause

PR 52 gave a rejected sync request its own type, `SyncStoppedError` (extends `Error`, not `SyncError`), and handled it in the tool path. The indexer's per-page catch lists classes (`SyncError` 410, other `SyncError`, `BindingError`) and ends in `else { throw error; }`. A new class that matches no branch reaches the rethrow, and in a loop over graphs a rethrow is a run-wide failure. The gap pre-dated PR 52 (the raw rejection was already a plain `Error`); the new type only made the missing branch visible, and its commit message said the indexer was unchanged.

## Fix

`indexer.ts` handles `SyncStoppedError` in the `BindingError` branch: state saved once as `error` with the message, the loop leaves that graph, the next graph runs, and the next run retries after the lease expires. No extra D1 reads over a sync server error.

## How to catch it next time

- When a change adds an error class or wraps a failure in a new type, grep every `catch` that tests `instanceof` on the neighbouring classes (`git grep "instanceof SyncError"`) and decide each one's branch. The commit message that says "X still sees Y as before" is the prompt to open X.
- In a per-item loop in a cron, a final `throw` is a decision to stop all remaining items. Test it with two items where the first fails, and assert the second still ran.
- Known open edge: a reset after the headers, while the feed body is being read, still throws from the body read and aborts the run (deferred from item 53). Any other non-`SyncError` failure (for example a 200 body that fails `parseFeedPage`) does the same.
