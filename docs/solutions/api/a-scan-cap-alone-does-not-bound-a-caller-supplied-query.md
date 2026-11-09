---
title: A scan cap alone does not bound a caller-supplied Datalog query; each cost axis needs its own cap, and fixtures must be graph-sized
area: api
tags: [datalog_query, run_named_query, caps, join-fanout, recursion, allow-list, cpu, 1102, private, read-only, scale-test]
seen:
  - 2026-11-09 – item 40, patch 0039, stages 1 to 4 and review rounds 1 and 2 (s-2-1, s-3-1, s-4-1, r1-correctness-1; r1-correctness-1 still open at the end)
promoted_to: []
---

## Symptom

`datalog_query` counted the datoms a query read and refused past 20,000. The stage checks and review then found four ways to burn Durable Object CPU while staying far under that cap, each answered 200 or never answered:

- A left-recursive rule (`(under ?b ?p) <- (under ?b ?x) (under ?x ?p)`) read no datoms, so the scan cap never fired. It ran past 120 s.
- A self-join through a tag on 500 pages scanned a few thousand datoms and built 260,100 rows. 6.6 s of the 7 s went to `sort-rows`.
- A 571-character query chaining `[(vector ?v ?v) ?v2]` twenty times scanned 1 datom and returned 1 row. `sort-key` (`pr-str`) and the byte cap's serialiser then walked 2^20 leaves: 3.2 s and 865 MB. Allowed `str`, `+` and `keyword` do the same with one variable on a collection input (`(str ?x)` printed a 1,900-item input once per joined row: 1.7 s for 2,400 rows).
- The named query `meetings-without-decision` answered 422 (scan cap) on a graph with 4,000 filler blocks, although its tool text said named queries stay within the caps. Every fixture was tiny, so 52 tests passed.

Smaller finds from the same lane: the `:keys` column-count check used `flatten` on `:find`, so `(count ?e)` counted as 2 and valid queries were refused with a self-contradictory message; and the `:db/cas` refusal, the pull-source refusal in `:find` and the `:keys` count had no test (three mutations survived) although the commit message said each refusal had one.

## Cause

A cap measures one thing. Datascript's cost has several independent drivers: datoms read, rows built by joins, rule expansion depth, the size of values that functions build, and the sort and serialise that run after the query. Any driver without its own limit is the cheapest way round the others. The function allow-list is part of the same budget: a function that returns something larger than its arguments (collection constructors, `str` on a collection) lets one datom become an exponential value.

The second cause is test data. Caps and named queries were tuned on fixtures of a few dozen blocks, so nothing showed which query scales with the graph.

## Fix

Patch 0039 now has, each with a test where that rule alone decides the outcome: a scan cap (20,000 datoms), a join cap (20,000 rows counted by hooking Datascript's `join-tuples` and `-collect-tuples` while a query runs), a refusal of rules that recurse before a data pattern (one SCC pass), a row cap checked before the sort, a value cap that counts text inside input collections, 4,000-character limits on `query`, `inputs` and `rules`, collection constructors removed from the allow-list, and `str`, `+` and `keyword` limited to one variable. `meetings-without-decision` walks up from the (small) Decision-tagged set instead of down `:block/parent` per meeting. `scripts/bench-datalog-query.mjs` benches the worst shapes at 5,000 and 20,000 pages.

Still open at the end of the lane (r1-correctness-1): `(str ?x)` on a whole-collection input, repeated per joined row, is allowed and the value cap does not see it. Refuse `str`, `keyword` and `name` on a variable bound from an input collection, or give function results a character budget.

## How to catch it next time

- For any endpoint that runs caller-written queries, list every cost driver (read, join, recursion, value size, sort, serialise) and ask which cap bounds each. Try one adversarial query per driver that is cheap on the others, and record the time and rows next to the cap.
- Treat every allow-listed function as a size question: can its result be larger than its arguments, and can it be chained in a loop? Probe with 20 chained clauses.
- Before claiming a vetted query "stays within the caps", run it against a graph with thousands of unrelated blocks, not only the fixtures that exercise it.
- Count find elements structurally, not with `flatten`, when comparing against `:keys`.
- Private filtering by `d/filter` hides rows from the query. Other read tools (`list_tags`, `get_tag`) already show private-tagged tags' titles, so an echo of a tag title in `run_named_query` params is not a new leak (one skeptic refuted it as pre-existing; one refutation, not yet a known false positive).
- Reads logged to the audit log cost 2 D1 rows written and none read per call (hash of the query text, never the text); that is the arithmetic to repeat if another read tool is logged.
