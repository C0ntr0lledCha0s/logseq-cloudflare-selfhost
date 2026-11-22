---
title: An issue logged while reviewing a change can be closed by that change's follow-up; replay or grep the exact claim on HEAD before opening a lane
area: connector
tags: [not-a-bug, flaky-timing, release-query-check, max-fn-bindings, stale-issue, already-fixed, annotations, destructiveHint, tools-manifest, tracker, review-gap, class-schema-refusal, patch-0045]
seen:
  - 2026-11-19 – item 46 (batch_insert_block_trees annotated additive; already DESTRUCTIVE at HEAD, lane found no bug)
  - 2026-11-20 – item 47 (set_block_property on a property's hidden classes stored Root; patch 0045 already refused it on every write path, lane found no bug)
  - 2026-11-20 – item 56 (F1 includes? timing check failed once at 103 ms at the PR 52 stage 6 gate; review round 1 of the same PR added max-fn-bindings, so the 422 now answers in 1 to 2 ms, lane found no bug)
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

Item 46 said `batch_insert_block_trees` was annotated additive (`destructiveHint` false) although an entry's properties overwrite values on an existing page or block, so claude.ai might not ask for approval.

## Cause

There was no bug at HEAD. The issue was logged during the review of an earlier item, and the annotation work that followed (commit 2376d5a, readable tool calls) already classed the tool DESTRUCTIVE in the `ANNOTATIONS` table (`connector/src/tools/spec.mjs`). The manifest, the Worker's generated tools (`annotationsFor(op.name)` in `semantic.ts`), `connector_help` and README 11.8 all agree, and 2376d5a is on `origin/main`, so the deployed connector has it. The tracker page was simply not updated. The siblings (`insert_block_tree`, `insert_block_children`, `capture_to_today`) stay additive because upstream `insert-tree!` sets properties only on blocks it creates and reuses an existing uuid unchanged.

## Fix

None. The lane recorded that the issue is already fixed and drafted an owner update so the issue can be closed. The existing tests in `connector/test/tools.test.ts` already pin the annotation (the explicit destructive loop, `DESTRUCTIVE_NAMED` with `expectedHints`, and equality of `tools/list` with the manifest and `ANNOTATIONS`).

## How to catch it next time

- For an annotation or tool-text claim, a one-line grep settles it: `grep -n '<tool>' connector/src/tools/spec.mjs` and the matching block of `connector/tools-manifest.json`. Do that at intake, before any investigators run.
- Compare the issue's date with `git log -S'<tool>' -- connector/src/tools/spec.mjs` and with `git merge-base --is-ancestor <commit> origin/main`. An issue that says "predates item N" is a prompt to check what item N and its follow-ups changed.
- Check that a test already pins the claimed state before writing a new one. Here one did, so no code or test change was needed.
- The part that code cannot show stays open: whether claude.ai acts on `destructiveHint` to ask for approval is unverified (README 11.8). Say so in the owner update.
- Same family as the other not-a-bug entries: [a 500 that predates its fix deploy](../api/a-500-that-does-not-reproduce-on-head-may-predate-its-fix-deploy.md) and [uuid case](../api/uuid-case-is-already-normalised-by-cljs-uuid.md). Three not-a-bug lanes now share the lesson "reproduce the exact claim on HEAD first".

## Second instance: item 47 (a review-gap note closed by a later patch)

Item 47 came from the review of patch 0032, which noted that `set_block_property` on a property's hidden `logseq.property/classes` still stored Root ([the 0032 entry](../api/property-classes-accepted-root-the-picker-hides.md)). Patch 0045 (e3dc341, `class-schema-refusal` and `set-property-refusal`) later refused `logseq.property/classes` and `logseq.property.class/extends` on the single set, batch set (both modes) and `prepare-properties` (every insert path). The tracker was not updated. Replaying the exact call through the real handler on HEAD answered 400 `entry 0: logseq.property/classes can't be set here; use update_property (classes)` and stored nothing. The refusal keys on the resolved `:db/ident` before value resolution, so the value (Root or any page) and the selector spelling do not matter.

Catch it faster:
- A "gap found in review of patch N" issue is a prompt to list the patches after N that touch the same handler (`git log --oneline -- patches/` then grep for the attribute) before replaying.
- Replay the exact call first (a scratch test through `handle-http`, not a read of the code). One replay settled this and gave a 400 with the entry-naming message the acceptance asked for.
- Keep the adjacent question separate. Other hidden schema properties (type, cardinality, closed values) are not in 0045's refusal map and were only probed, not proven open. Log them as their own item if a probe shows a write is stored.
- Optionally add a pin test with the exact reported value; it passes today, so say in the PR that it is a pin, not a failing test.

## Third instance: item 56 (a flaky timing check logged at a gate, fixed by review round 1 of the same PR)

Item 56 said `checkF1` in `scripts/release-query-check.mjs` failed once at a 103 ms median against `F1_MS = 100` and passed on rerun, and proposed widening the bound or taking more samples. The failure was real but belonged to code that no longer exists. At the stage 6 gate (f4ff06d) the 20-includes? F1 shape ran over 500 blocks until the width cap stopped it, and that commit's own message records the F1 shapes answering 422 after 88 to 145 ms. Three hours later review round 1 (fa88b69, finding s-2-1) added `max-fn-bindings = 12` to patch 0039, so every F1 shape is refused by `fn-bindings-refusal` before anything runs. On the release bundle as last built the 422 answers in 1 to 2 ms (20 rounds: max 3 ms single call, 0 of 20 over 100 ms), about 50 to 100 times under the bound. Widening `F1_MS` would only have loosened a check that already has that margin.

Catch it faster:
- A "flaky timing" issue is a claim about a code path at one commit. Find the commit the failure was seen at (the issue's date and gate), then `git log` the code under test since then. If a later commit changed what the measured path does, re-measure on HEAD before touching the bound.
- The gate commit message often already records the real numbers and the cause. Read it first: here it said 88 to 145 ms warm, so 103 ms was ordinary, not noise.
- Re-measure with the same release bundle without rebuilding (spread over 20 rounds of the check's own call pattern), and confirm the bundle contains the new code (grep the refusal text in `main.js`).
- A timing bound that sits at the edge of a measured spread is a sign the path is doing work it should refuse earlier. The fix that moved the number (an up-front refusal) was better than any change to the bound.
