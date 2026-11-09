---
title: A per-request scan of a cached index went over the 10 ms CPU budget, and tests could not see it
area: cost
tags: [cpu, 10ms, worker, cold-start, kb-index, suggest_links, bench, json-parse, text-limit]
seen:
  - 2026-11-08 – item 22 (suggest_links), review rounds 1 and 2 (r1-light-1, still open at the end, left to the backlog)
  - 2026-11-09 – item 40 (datalog_query), stages 3 and 4: the bench at 5,000 pages showed a join-fan-out shape (7,034 datoms scanned) costing more than one that scanned the full 20,000, and a named query hit the scan cap only with thousands of filler blocks; see api/a-scan-cap-alone-does-not-bound-a-caller-supplied-query.md
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
