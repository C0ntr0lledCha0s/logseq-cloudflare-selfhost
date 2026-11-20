---
title: "The Free plan's Durable Object CPU limit is about 30 s per request, not 10 ms"
area: cost
tags: [cpu, durable-object, free-plan, cpu-limit, exceededCpu, websocket, datalog, do-cpu-probe]
seen:
  - 2026-11-16 – probe built (`.github/workflows/do-cpu-probe.yml`)
  - 2026-11-19 – first run, workflow run 44481130870 (8 targets, WebSocket client on)
  - 2026-11-20 – analytics query and repeat count fixed in the probe (Connector #51); live rerun pending
promoted_to: []
---

## Symptom

A datalog query runs synchronously inside the graph's sync Durable Object. Cloudflare's docs disagree on how long it may run on Free: `durable-objects/platform/limits` says "CPU per request: 30 seconds (default)", while the Durable Objects FAQ says they have "the same per invocation CPU limits as any Workers do", which is 10 ms on Free. The query caps in patch 0039 were sized without knowing which applies. Background: `docs/spikes/2026-11-09-safe-caller-datalog-queries.md`, Follow-up 4.

## Cause

Measured on the owner's Free account on 2026-11-19 (`do-cpu-probe` run 44481130870, a throwaway Worker and SQLite-backed DO on workers.dev, deleted at the end of the run). Each target is a fixed amount of busy work, sized from the loop's rate on the GitHub runner (644,408 iterations per ms on an Intel Xeon 6975P-C, Node 22).

| Target ms (runner CPU) | HTTP | Latency ms | Outcome | DO memory | WebSocket |
|---:|---:|---:|---|---|---|
| 5 | 200 | 128 | completed | kept | kept |
| 50 | 200 | 855 | completed | kept | kept |
| 200 | 200 | 327 | completed | reset | dropped (1006) |
| 500 | 200 | 786 | completed | kept | kept |
| 2,000 | 200 | 3,235 | completed | kept | kept |
| 5,000 | 200 | 8,501 | completed | reset | kept |
| 15,000 | 200 | 25,301 | completed | reset | kept |
| 35,000 | 502 | 35,584 | killed | reset | dropped (1006) |

- **The limit is about 30 s of CPU per request, not 10 ms.** A request that burned the runner's 15,000 ms of work completed after 25.3 s on Cloudflare. The 35,000 ms target was killed after 35.6 s. From 500 ms upwards, latency runs about 1.6 to 1.7 times the runner target, so the loop runs at roughly 380,000 to 410,000 iterations per ms on Cloudflare, and the completed 15,000 ms run used about 25 s of CPU. The killed run would have needed about 59 s. That brackets the limit between about 25 s and about 35 s, which fits the documented 30 s default. The 10 ms Workers figure does not apply to a DO request.
- **What the caller sees.** HTTP 502 with `{"error": "Durable Object exceeded its CPU time limit and was reset.", "remote": true, "retryable": null, "overloaded": true, "durableObjectReset": true}`. The connector maps a 5xx without the server's own message to `the sync server stopped the request …; a query may have hit the CPU limit` (patch 0039 era, `connector/src/sync.ts`).
- **The DO's memory.** A kill resets the instance: in-memory state is gone and the next request boots a new instance (new `bootId`). For the sync DO that means reloading the graph.
- **WebSocket clients.** The kill dropped the connected client with close code 1006. For the sync DO that drops every connected Logseq client of that graph, which then reconnects.
- **Resets without a kill.** The instance also restarted after three completed runs (200 ms, 5 s and 15 s), and the 200 ms run dropped the WebSocket. Runs were about 7 s apart. These look like ordinary DO restarts or evictions, not CPU kills, but one run can't separate them. Clients must already survive a reconnect.
- **Analytics answered nothing.** No invocation appeared in `durableObjectsInvocationsAdaptiveGroups` within 240 s, and `sum.cpuTime` is an unknown field. The CPU figures above therefore come from latency on a single-threaded busy loop, which tracks CPU closely but isn't Cloudflare's own CPU number.

## Fix

- **The query caps can stay as designed.** The worst cases measured in the release bundle (about 184 ms for `datalog_query` with every cap near its limit, about 127 ms for a named query at the reads backstop) are two orders of magnitude below the kill. At the runner-to-Cloudflare ratio above they are perhaps 200 to 300 ms on Cloudflare, still far inside it. The caps exist to keep sync responsive, not to avoid the kill.
- **The fuel counter loses urgency.** It no longer guards against a 10 ms limit. It stays the route to bring caller rules back safely (README backlog 23), so keep it as a backlog item, not a blocker.
- **The Paid plan buys nothing for queries.** Its main gain here would be the front Worker's 10 ms CPU limit, which this probe did not test.
- **Probe follow-ups (done, not yet run live):** the probe now reads CPU from the `cpuTimeP99` quantile of `durableObjectsInvocationsAdaptiveGroups` (the dataset has no `sum.cpuTime`), says what an unfiltered read of the account and the periodic totals found when no invocation is reported, and takes a `repeats` input (default 3, at most 5) that runs each target several times. Each run gets a verdict: `kept`, `restart` (the burn completed but the instance changed), `kill` (the CPU-limit error) or `error`, and the *Limit* bracket takes its failed side only from kills. The unit tests pin this against stubbed GraphQL answers, so the live behaviour of the query is unconfirmed until the rerun below.

## How to catch it next time

Re-run `do-cpu-probe` (Actions → do-cpu-probe, defaults) after a Cloudflare limits change or a move to Workers Paid, and compare the latency bracket with the table here. The first rerun after the probe fix is still owed: run it with the defaults, check that the CPU ms column is filled from analytics for completed runs (if it is still empty, read the summary notes, which say what the unfiltered read found), and use the *Repeats* line to see whether restarts after completed runs recur (an ordinary restart) or only the long targets are killed. Remember that runner milliseconds are not Cloudflare milliseconds: the same work took about 1.65 times longer on Cloudflare, so release-bundle timings from a fast machine understate DO CPU by roughly that much.
