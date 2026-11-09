---
title: A scan cap alone does not bound a caller-supplied Datalog query; each cost axis needs its own cap, and fixtures must be graph-sized
area: api
tags: [datalog_query, run_named_query, caps, join-fanout, recursion, allow-list, cpu, 1102, private, read-only, scale-test]
seen:
  - 2026-11-09 – item 40, patch 0039, stages 1 to 4 and review rounds 1 and 2 (s-2-1, s-3-1, s-4-1, r1-correctness-1; r1-correctness-1 closed in round 2)
  - 2026-11-09 – item 40, review rounds 3 and 4 (not, rule and rule-tree routes past the per-construct caps) and the safe-caller-datalog-queries spike, which measured the rule-tree route and a one-budget fuel counter
promoted_to: ["REVIEW.md Cost"]
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

r1-correctness-1, `(str ?x)` on a whole-collection input repeated per joined row, was closed with both remedies, because the value cap only sees the collections rows return. While `run-query`'s `d/q` runs, the allowed entries of Datascript's `query-fns` and `aggregates` are wrapped (the `join-tuples` pattern: outside a query they call straight through). A function given a collection answers 422 naming it unless it only looks into one (`count`, `contains?`, `get` and 17 others, deny by default), and aggregates other than `count`, `count-distinct` and `distinct` refuse collection values. Every character of text a function or aggregate returns counts toward a text cap of 5,000,000 per query, except from functions that pass a value through (`identity`, `get-else`, `max` and the like). Datascript returns aggregates lazily, so the result is realised inside the guarded window; without that, the aggregate guards never fire. The 2 s query now stops in about 50 ms. A re-check found two more routes, closed the same way: cljs's `clojure.string/trimr` is a regex that is quadratic on a run of spaces followed by something else (3.3 s over 300 rows of a 3,990-character input), so inside a query it runs as `trimEnd`, and a test times every allowed `clojure.string` function on that input; and predicates, which build nothing, were counted by no cap (105 `includes?` clauses over 5,000 rows, 650 ms), so every guarded call now counts toward a call cap of 20,000. A third re-check found `not`, `not-join`, `or-join` and rule bodies doing relation work no cap counted when their inner clauses matched nothing (nots nested through rules 10 × 10 × 10 × 10: 26 s from a 739-character query). That was closed at the relation layer rather than per clause: Datascript's `hash-join`, `subtract-rel`, `sum-rel` and `prod-rel` each charge the rows they walk to a work cap of 200,000. Read-only text predicates on long text (`includes?`, `index-of`) still cost their length per row, about 60 ms at 2,400 rows (README backlog item 25).

## How to catch it next time

- For any endpoint that runs caller-written queries, list every cost driver (read, join, recursion, value size, sort, serialise) and ask which cap bounds each. Try one adversarial query per driver that is cheap on the others, and record the time and rows next to the cap.
- Treat every allow-listed function as a size question: can its result be larger than its arguments, and can it be chained in a loop? Probe with 20 chained clauses. Then ask what it costs on its own, once per joined row, with the largest argument an input can carry: a function that returns something small (`=`, `pos?`, `index-of`) can still print or walk a large argument.
- Allowed string functions can hide a regex: check how the platform implements each (cljs `trimr` is `goog.string.trimRight`), and time each on a long run of whitespace followed by a non-space.
- Per-construct caps keep leaking: each review round found the next construct (functions, predicates, then negation, unions and rules) that did work the existing counters didn't see. Count work where all constructs meet, at the relation operations the engine runs, and treat a per-clause rule as defence in depth only. A wall-clock deadline is no substitute: Workers freeze `Date.now()` during synchronous work.
- Every per-row operation needs a counter, including those that return nothing large: a predicate's calls are a cost driver of their own.
- A guard installed in a library's lookup table fires only when the library calls through it inside the guarded window. Check what the library returns lazily (Datascript's aggregates) and realise it inside.
- Before claiming a vetted query "stays within the caps", run it against a graph with thousands of unrelated blocks, not only the fixtures that exercise it.
- Count find elements structurally, not with `flatten`, when comparing against `:keys`.
- Private filtering by `d/filter` hides rows from the query. Other read tools (`list_tags`, `get_tag`) already show private-tagged tags' titles, so an echo of a tag title in `run_named_query` params is not a new leak (one skeptic refuted it as pre-existing; one refutation, not yet a known false positive).
- Reads logged to the audit log cost 2 D1 rows written and none read per call (hash of the query text, never the text); that is the arithmetic to repeat if another read tool is logged.

## Measured by the spike (patch 0039 at `7d04944`)

Full numbers and the options compared are in `docs/spikes/2026-11-09-safe-caller-datalog-queries.md`.

- Rule trees are the route the caps do not see. `expand-rule` costs 50 to 65 microseconds per frame, while the work cap charges about 0.25 microseconds per leaf. A 5x10 tree (10^5 leaves) took 5.5 s with 1 datom scanned, and larger trees ran about 10 s to the work cap. Refusing caller `rules` removes it, and the four named queries still work because their rules are server data.
- A prototype single fuel counter (rule frames 250, clauses 20, one per relation row, 5 per function call) stopped every hostile case tried in 24 to 192 ms with overhead between -10 % and +8 % (15 cases, Node, dev build). A 60-deep ancestors chain used half the 200,000 budget, so the weights need calibrating. That it closes the class is inferred, not proved; value amplification was not run against it.
- Cooperative yielding does not work: `d/q` is one synchronous reduce with no resumable state, so no input gate opens until it ends. Wall-clock deadlines do not work either, because `Date.now()` is frozen.
- Count work at the engine's own steps (frames, clauses, relation ops, calls) in one budget, then keep the scan, value and text caps for the per-step cost.
