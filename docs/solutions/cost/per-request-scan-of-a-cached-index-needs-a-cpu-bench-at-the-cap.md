---
title: A per-request scan of a cached index went over the 10 ms CPU budget, and tests could not see it
area: cost
tags: [cpu, 10ms, worker, cold-start, kb-index, suggest_links, bench, json-parse, text-limit]
seen:
  - 2026-11-08 – item 22 (suggest_links), review rounds 1 and 2 (r1-light-1, still open at the end, left to the backlog)
  - 2026-11-09 – item 40 (datalog_query), stages 3 and 4: the bench at 5,000 pages showed a join-fan-out shape (7,034 datoms scanned) costing more than one that scanned the full 20,000, and a named query hit the scan cap only with thousands of filler blocks; see api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md
  - 2026-11-23 – item 50 (health, changes and schema reads): the spec estimated under 300 ms for default health at 5,000 pages; the bench, run only in the last build stage, showed 1.5 to 2.9 s at 5,000 and 6.4 to 12.4 s at 20,000 (x1.65 applied), and seven of ten figures passed 1 s
  - 2026-11-23 – item 50, s-stage-6-2: the owner chose a cheaper default check set and a lower change cap; per-check figures showed three pre-existing checks over 1 s alone at 20,000 pages, and a per-request floor of about 450 ms cold there
promoted_to: ["REVIEW.md"]
---

## Symptom

`suggest_links` matches a draft against every page title in the cached `kb-index-titles:` KV key. Vitest passed, and the design had a plan for CPU (split the key by first letter if it was slow). A Node bench of the real module showed 45 ms at 20,000 pages with a 20,000-character draft, against 10 ms of CPU per request on the Free plan. A Worker over the limit fails with error 1102.

## Cause

Three costs, and the planned fix addressed the smallest:

- `JSON.parse` of the titles key: about 4 to 5 ms at 20,000 pages (1.3 MiB). Splitting the key by letter would cut only this.
- The matcher: about 40 ms. It walked every title and tokenised each one whose first word appeared in the draft, so cost grew with titles times draft length. A profile put it in matcher self time, candidate building and garbage collection, and none in the parse.
- The first call in a fresh isolate: 7 to 10 ms even at 200 pages, and 15 to 24 ms at 20,000, whatever the draft length. That is compile and warm-up cost. Lowering the input limit does not change it.

Workerd CPU cannot be measured in vitest, so no test failed.

## Fix

Review round 1 made the matcher rule titles out by hashed first-word and first-two-word checks, walk with indexed loops, and cut `TEXT_LIMIT` from 20,000 to 10,000. Round 2 resolved `page` and `exclude` in one pass (80 ms down to about 1 ms for 51 references). Warm calls at 20,000 pages ended near 9 to 13 ms, on the line. The cold first call stays over at large graphs. It is open in the backlog; the next step is a titles-key format that is pre-tokenised and grouped by first word at rebuild time, when the cron has CPU to spare. `scripts/bench-suggest-links.mjs` is the measuring tool, and its test checks shape and counts but never a time.

## How to catch it next time

- For any request path that loops over an index or a draft, run a Node bench of the real module at the index cap and the input cap, and report parse, work and first-call time separately. Do it in the design stage, not after the build.
- Profile before choosing the fallback. The planned fix targeted 4 of 45 ms.
- Treat the first call in a fresh isolate as its own number. A warm median hides it.
- Prefer moving work to the cron (pre-tokenise, pre-group) over trimming the request path.
- Tool text must state the limits the bench supports (input size, page count), not the ones the code merely allows.
- Put the bench in the first build stage, on the first handler, not the last stage after all three routes are built. In item 50 the caps and the estimate were fixed in the spec, three patches were built on them, and the bench then failed the stop condition with no cheap way back. A spec estimate of a scan's CPU is a guess until a bench has run (it was 20 to 40 times low).
- Item 50 figures to size against: a default `get_graph_health` running all nine checks cost about 12 s cold and 6.6 s warm at 20,000 pages, `broken-refs` about 6.5 s, a 20,000-change `list_changes_since` about 4.5 to 5.4 s, and `get_graph_schema` stayed under 660 ms. All sit under the Durable Object's roughly 30 s limit (`durable-object-cpu-limit-on-free.md`) but far above 1 s.
- Bench each part of a composite read alone, not only the composite. Item 50's first bench timed the default health call and the two new checks, so the review assumed the new checks were the cost. Timing every check alone showed three of the seven older checks over 1 s at 20,000 pages (`pages-without-summary` about 6 s, `pages-without-tags` 2.4 s, `duplicate-titles` 1.4 s). The fix (s-stage-6-2) made the default call run only the four checks that fit together (686 to 700 ms cold at 20,000 pages) and the other five run only when named, and lowered the feed's cap from 20,000 to 2,500 changes (711 to 728 ms cold at 5,000 pages).
- Find the per-request floor before you lower a cap. At 20,000 pages every graph-wide read costs about 450 ms cold before it does its own work (the private set and the first read of a woken graph), so a feed of 1,000 changes still took 1,154 ms: no change cap meets the line there. A cap bounds the work a caller asks for, not the work every call does. What is still over is README Backlog item 32.
- When a stage's done_when says to stop if a figure passes a line, the stage does not commit as done. The stage checker caught this one (s-stage-6-2), and it stayed open through every review round because it needs the owner.
