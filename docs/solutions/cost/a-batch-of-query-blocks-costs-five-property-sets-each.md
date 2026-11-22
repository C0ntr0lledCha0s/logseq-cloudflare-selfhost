---
title: A Query block write costs five outliner property sets, and a batch of 100 at the 4,000-character cap takes about 2.3 s of CPU
area: cost
tags: [query-block, bench, cpu, durable-object, batch, outliner, property-set, capture-to-today]
seen:
  - 2026-11-22 – item 49, patch 0050, stage 5 (bench) and review (capture_to_today checks each query three times)
promoted_to: []
---

## Symptom

The spec guessed four property sets per Query block. The built path does five (tag, query, display type, lang, and the `claudeQueryBlock` marker), plus creating the marker property once per graph.

## Cause

Each set goes through the outliner, which is the expensive part. Parsing and checking the query text is cheap by comparison.

## Fix

`scripts/bench-datalog-query.mjs --query-block` (warm median of 5, release bundle, Node 22, developer machine): 100 Query nodes of 4,000 characters store in about 2.3 s (2.6 s cold). Parse and static check about 0.6 s, writes about 1.6 s. It guides the cost and is not a Durable Object measurement. Free-plan Durable Objects get about 30 s per request (`docs/solutions/cost/durable-object-cpu-limit-on-free.md`), so a full batch fits with room; the front Worker's 10 ms is not involved because the work runs in the DO. Review also noted `capture_to_today` parses and checks each query three times (deferred as a cost nit).

## How to catch it next time

- Count the outliner calls a new write adds per entry and run the bench at the documented cap, with parse, check and write reported apart.
- A spec's call count is a guess until the built path is counted. Re-state it in the spec's As built section.
