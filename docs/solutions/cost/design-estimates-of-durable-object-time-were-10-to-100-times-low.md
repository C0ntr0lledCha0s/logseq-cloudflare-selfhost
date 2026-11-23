---
title: Design estimates of Durable Object time for a bounded read and a bounded delete were 10 to 100 times low; bench at the caps before the spec's number is quoted
area: cost
tags: [durable-object, cpu, bench, estimate, list-pages, delete-blocks, release-bundle, caps, free-plan]
seen:
  - 2026-11-22 – blank-blocks-sync-status (patches 0055 and 0056), stages 1 to 5 and review round 1 (r1-light-1)
  - 2026-11-23 – blank-blocks-sync-status, review round 2 (r2-correctness-2, r2-light-1; fixed): the once-a-call scan of internal reference targets was cheap at the caps but read the whole graph, so a one-page dry run cost 59 to 74 ms beside 100,000 blocks; a bench at the caps alone did not show it
promoted_to: []
---

## Symptom

The design said `get_sync_status` counts take 5 to 20 ms at 50,000 entities and a blank-block apply takes "tens of milliseconds". Measured on the release bundle: the counts took a median of 468 ms at 100,000 entities, a dry run over 5 pages of 2,000 blocks 311 ms, and an apply of 100 non-adjacent ids 4,188 ms. D1 arithmetic had been right (9 rows read and 3 written for the status call, which came out as measured), so the error was only in Durable Object time.

## Cause

The estimates priced the new code and ignored what it calls. The counts cost `list-pages`, which every `list_pages` call already pays (a bare `listPages limit 1` on the same graph took 541 ms). The apply cost is the outliner's `delete-blocks!` over 100 non-adjacent blocks, which `delete_blocks` pays too. Neither is visible from reading the new handler, and the dev build cannot show it because Closure renames and inlines differently.

Two bench traps on the way:
- A per-leaf scan of all the internal reference attributes took the dry run at the caps to 744 ms against its 500 ms bound. Reading the targets once per call gave 398 ms, but that read every `:block/parent`, `:block/page` and created-by-ref datom in the graph, so a one-page dry run beside 100,000 blocks took 59 to 74 ms. Review round 2 narrowed the set to the four properties that can target a content block and reads them per leaf from `:avet` datoms: 7 to 8 ms on that graph, and a median of 357 ms at the caps.
- The dev build loads once a process: a second dev seed after a release bundle had run failed to transact. `release-query-check.mjs` now seeds every graph before the first release bundle (`seededDatabase`).

## Fix

`SYNC_STATUS_MS` (750 ms, median of three warm runs, cold run reported but not bounded) and `BLANK_APPLY_MS` (15 s, half the 30 s limit from `cost/durable-object-cpu-limit-on-free.md`) bound both in `scripts/release-query-check.mjs`. 468 ms at the 1.65 ratio is about 0.8 s of Durable Object CPU, far inside 30 s, so the spec's memoise-or-omit fallback was dropped.

## How to catch it next time

- A spec's time estimate for a path that wraps an existing call is the existing call's measured time plus the new work. Time the existing call on the same fixture first (`listPages limit 1`, `delete_blocks` of the same count).
- Bench the release bundle at the caps and bound the median of three warm runs, with the cold run reported apart. Bench a small call on a large graph too (`BLANK_LARGE_MS`): a per-call scan of the graph is cheap at the caps' fixture and only shows when the graph is large. Test the bound itself with per-call delays, or the median rule is untested (`testing/untested-rules-survive-mutation.md`).
- Compare the figure with the Durable Object limit, not the Worker's 10 ms: the front Worker only forwards.
