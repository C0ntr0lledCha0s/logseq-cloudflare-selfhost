---
title: Building an Intl.DateTimeFormat per list entry cost about 10 ms of CPU for 200 entries
area: cost
tags: [cpu, 10ms, intl, datetimeformat, worker, list, get_activity_log]
seen:
  - 2026-11-07 – item 28, review round 3 (r3-light-1)
  - 2026-11-08 – item 22 (suggest_links): the same blind spot at a larger scale, a matcher over every cached title cost 45 ms; see per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md
promoted_to: ["REVIEW.md"]
---

## Symptom

`get_activity_log` formatted each entry's time with a new `Intl.DateTimeFormat`. For 200 entries that was about 10 ms of CPU, the whole per-request budget of the front Worker on the Free plan.

## Cause

Constructing a formatter is expensive; calling `format` on one is cheap. Per-entry construction in a loop is invisible in tests, which check output and not CPU.

## Fix

Cache formatters per use and time zone. A test counts constructions on a 200-entry page.

## How to catch it next time

In any code that renders a list inside a Worker, look for constructors in the loop (`Intl.*`, `RegExp`, `new URL`, JSON re-serialisation of large blobs). Test by counting constructions at the page limit.
