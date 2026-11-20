---
title: A reported wrong count may be a misread summary line, not the handler; read the history and prove the guard test by mutation
area: api
tags: [not-a-bug, delete-blocks, total-removed, descendants, summary-line, readable, mutation-proof, does-not-reproduce, stale-issue]
seen:
  - 2026-11-20 – item 39 (delete_blocks said to answer total-removed 2 for a childless block plus a block with one child; lane found no bug on HEAD or in history)
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

Item 39 said `delete_blocks` on two blocks, one childless and one with a single child, answered `deleted: 2` and `total-removed: 2` in both the dry run and the real call, although all three blocks were removed. The expected answer was `total-removed: 3` with a per-block descendant count.

## Cause

There was no code bug at HEAD, and none in the handler's history. `:semantic/blocks-delete-many` (patch 0012) builds `removed` from each requested block's id plus `ldb/get-block-full-children-ids`, a recursive walk over `:block/parent`, and answers `total-removed` as `(count removed)` in both modes. Each `affected` entry carries `descendants`. The first commit of the handler (d07f186) already did this, so no deployed version could have answered 2 for that shape. An uploaded graph keeps `:block/parent`, so the upload-path schema drift does not apply here.

The connector passes the server's JSON through unchanged. What it adds is a summary line in front of it (`readable.ts`, `describeWrite` and `summarise`): "Deleted 2 blocks: ... +1 child". The first number counts the requested blocks and a descendant shows only as "+1 child". A reader, or the model relaying it, can take that as "2 removed". The likeliest explanation is that wording, not the count. What the deployed build answered on the day of the report was not recorded, so that part stays unconfirmed.

## Fix

None to the handler. The lane added the brief's exact shape as a guard test through the real handler (blocks built by `POST /semantic/block-trees`, then `DELETE /semantic/blocks`): A with no children and B with one child, dry run and real call both answering `{:deleted 2 :total-removed 3}` with affected descendants `[0 1]`, and the child entity gone.

That test passes on HEAD, so it cannot be seen to fail without a fix. It was proved by mutation instead: replacing `(mapcat cons ids descendants)` with the requested ids alone makes it fail. Say so in the PR, in place of a quoted failure.

Optional follow-up, owner's call: have the summary line state the total (for example "Deleted 2 blocks (3 removed with descendants)") so the first number cannot be misread.

## How to catch it next time

- When a count looks wrong, split what the server answered from what the connector's summary said. Ask for the raw JSON field, not the prose, before reading the handler.
- Read the handler's first commit (`git log -p --reverse patches/<n>-*.patch`) before looking for a regression. If the first version counted correctly, no deploy could have answered otherwise.
- Look for an existing test that already pins the number with the same builder. Here `delete-blocks-removes-several-blocks-atomically-test` asserted `total-removed 4` and `5` through the real route, and `scripts/upstream-test.sh .upstream semantic-bulk` passed (13 tests, 119 assertions).
- A guard test written for a not-a-bug must show it bites. Name the mutation and the failure it caused.
- Same family as [a 500 that predates its fix deploy](a-500-that-does-not-reproduce-on-head-may-predate-its-fix-deploy.md), [uuid case](uuid-case-is-already-normalised-by-cljs-uuid.md) and [an issue found in review](../connector/an-issue-found-in-review-may-be-fixed-by-the-work-it-was-found-in.md). Four not-a-bug lanes now share the lesson "reproduce the exact claim on HEAD before investigating".
