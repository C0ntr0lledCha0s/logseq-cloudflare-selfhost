---
title: "Pending measurement: the Free plan's Durable Object CPU limit and what a CPU-limit kill does"
area: cost
tags: [cpu, durable-object, free-plan, cpu-limit, exceededCpu, websocket, datalog, do-cpu-probe]
seen:
  - 2026-11-16 – probe built (`.github/workflows/do-cpu-probe.yml`); not yet run
promoted_to: []
---

This entry is a placeholder. Fill it in from the first run of the `do-cpu-probe` workflow (README → Costs → *Measuring the Durable Object CPU limit*). Until then, nothing here is measured: do not quote a Free plan DO CPU limit from this file.

## Symptom

A datalog query runs synchronously inside the graph's sync Durable Object. Cloudflare's docs disagree on how long it may run on Free: `durable-objects/platform/limits` says "CPU per request: 30 seconds (default)", while the Durable Objects FAQ says they have "the same per invocation CPU limits as any Workers do", which is 10 ms on Free. Past 30 s there is only a "heightened chance" of eviction. Background: `docs/spikes/2026-11-09-safe-caller-datalog-queries.md`, Follow-up 4.

## Cause

To record from the run (copy the step summary's table and the JSON artefact's key figures):

- **The limit.** The most CPU a completed run used, and the least CPU at which a run failed (the summary's *Limit* lines), with the run date and the run's link.
- **What the caller sees.** The HTTP status and the response or error text for a killed run, and the error flags (`retryable`, `overloaded`, `durableObjectReset`).
- **The DO's memory.** Whether the marker survived a kill (`DO memory` column).
- **WebSocket clients.** Whether a connected client was dropped, and with which close code.
- **Analytics.** The `status` values analytics reported for killed runs, which CPU field answered (`sum.cpuTime`, the quantiles, or none), and the iterations per ms on Cloudflare against the runner.

## Fix

To decide once measured: whether the datalog caps in the query-safety spike can stay as designed, or whether a long limit or dropped WebSocket clients strengthen the case for a separate replica.

## How to catch it next time

Re-run `do-cpu-probe` after a Cloudflare limits change or a move to Workers Paid, and compare with the figures recorded here.
