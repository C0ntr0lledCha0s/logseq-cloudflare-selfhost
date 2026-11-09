---
title: Free plan Durable Object CPU limit and CPU-kill behaviour were never verified; the datalog spike's figures are snippets, plus measured sizes that are safe to reuse
area: cost
tags: [durable-objects, cpu-limit, 1102, free-plan, replica, datalog_query, unverified]
seen:
  - 2026-11-09 – item 40, safe-caller-datalog-queries spike
promoted_to: []
---

## Symptom

A design question (can a runaway query be isolated from sync? how bad is a CPU kill?) could not be answered from docs, because `developers.cloudflare.com` was blocked by the session's proxy (`ENOTFOUND`, `CONNECT tunnel failed, 403`). Every Cloudflare figure came from search snippets.

## Cause

Platform limits move and are easy to misremember. The spike's snippet figures are not facts: DO CPU per invocation 30 s by default (raisable to 5 min with `limits.cpu_ms`; whether Free differs was not shown; `scripts/render-wrangler.mjs` deletes `limits` on Free), per-object storage on Free (snippets disagree: 1, 5 or 10 GB), Containers Paid only, and no progress, interrupt or timeout API in DO SQL or D1 (absence not proved). What a CPU kill returns to the caller, and whether it drops WebSocket clients, was not tested.

## Fix

None needed in code. A later lane that depends on these must fetch the docs from a session that can reach them, and run a throwaway busy-loop DO on Free, recording the status, error text, `wrangler tail` output and whether sync clients drop. Update this entry with the result.

## How to catch it next time

- Label each platform figure verified (current docs cited, or a measurement with a commit) or inferred, and do not copy an inferred figure into a rule or a spec as fact.
- Measured at `7d04944`, safe to reuse (Node, release build, better-sqlite3 for DO storage): a loaded Datascript db costs 259 to 266 bytes per datom on EAVT alone (5,000 pages +79 MB, 20,000 pages +314 MB, against 128 MB); creating a page writes 1 kvs, 1 tx_log and 2 sync_meta rows and inserting 20 blocks writes 147 kvs rows; 1,000 pages is 12,339 kvs rows (8.1 MB) and kvs has no GC; a cold snapshot restore is 92 to 240 ms and a full load 518 ms at 5,000 pages; the snapshot carries no `t`, so a replica cannot tell which `t` it matches. A query blocks the graph's own DO for its whole run (`idFromName(graph-id)`, so only that graph).
- Full reasoning and the options compared: `docs/spikes/2026-11-09-safe-caller-datalog-queries.md`.
