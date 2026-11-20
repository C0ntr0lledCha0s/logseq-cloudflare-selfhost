---
title: A reported 500 that does not reproduce on HEAD may come from a deploy older than its fix; check deploy history before building a fix
area: api
tags: [does-not-reproduce, not-a-bug, stale-deploy, tags, private-tags, reset, 500, deploy-history, regression-test]
seen:
  - 2026-11-19 – item 38 (Tags reset answered 500; fixed by patch 0027 and deployed 2026-11-07, lane found no bug on HEAD)
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

Item 38 said `batch_set_block_property` on Tags with `isResetExistingValues` and `[CourseInstance]` (or `[Page, CourseInstance]`) answered HTTP 500 and wrote nothing. The issue text guessed that a reset which removes or re-sends Page "still seems to reach" the outliner's "Can't remove private tags" guard.

## Cause

There was no bug on HEAD. The 500 was the one patch 0027 already fixed: before it, a reset called `remove-block-property!` on `:block/tags`, which throws "Can't remove private tags: :logseq.class/Page." on every page. Patch 0027 reached main in PR #38 and its deploy succeeded on 2026-11-07. The report came from a server deployed before that. Since then `set-prepared-tags!` removes one user tag at a time through `delete-property-value!`, which never reaches the private-tag guard. On HEAD, through `handle-http`, every reset variant answered 200 and left `#{Page CourseInstance}`: `[CourseInstance]`, `[Page, CourseInstance]`, the same on a page with a child block, property id `Tags` and `block/tags`, a single PUT reset, a journal and a tag target.

Two things made the report look current. The quoted message matched a real, still-reachable 500 (a whole-property delete of Tags, see below), and the issue's own wording was a guess about the route, not an observed trace. The first investigator took that match as the root cause and was refuted: the quoted message proved the guard, not the route.

## Fix

None for the reset. A hypothesis that the delete route was the root cause was refuted for this report, but its finding stands as separate work: `DELETE .../properties/Tags` and the batch form call `remove-prepared-property!`, which still answers 500 on any entity holding a private tag (Page, Journal), and neither delete route takes a value, so one value of a many-valued property cannot be removed. That belongs in its own lane (new patch, tool text, `connector_help`, manifest, README 11.8).

## How to catch it next time

- When a report quotes an error message that an earlier entry already fixed, run `git log -S'<message>'` or read the matching `docs/solutions` entry, then compare the fix's merge date with the `deploy.yml` run (`gh run list --workflow deploy.yml`) before reading handler code. A report older than that deploy is the likeliest explanation.
- Ask the owner for the date and exact call of the failing request when it cannot be reproduced. Do not widen the fix to cover a guess.
- Reproduce the exact reported call through `handle-http` on HEAD first. A different route that throws the same message (here, delete instead of reset) is a separate defect, not the reported one. Record it, and do not let it stand in for the root cause.
- Committed tests missed the real shape: the reset tests used pages that held no user tag, so `delete-property-value!` on `:block/tags` was never run. When closing a not-a-bug, add a guard for the shape that was reported (a page with an existing user tag reset to another), built through the API, and say in the PR that it passes today.
