---
title: Inputs that multiply into a run time must be checked against the job's timeout, or a long run loses every result
area: cost
tags: [do-cpu-probe, timeout-minutes, validate, repeats, durations, results-written-at-end, workflow-input]
seen:
  - 2026-11-20 - item 51 (Connector #51): review flagged it eight times across two rounds, deferred as should-fix
promoted_to: []
---

## Symptom

`do-cpu-probe` gained a `repeats` input (default 3, at most 5) that runs each target several times. `validate` checks each input alone: durations against their own cap, repeats against `MAX_REPEATS`. It does not check the product. Long targets (the measured limit sits near 25 to 35 s per burn, plus a 3 s gap) times five repeats times several durations can pass `validate` and still exceed the job's `timeout-minutes: 30`. The job is then cancelled, and because the results file is only written at the end, every result is lost, including the runs that finished.

## Cause

Each input has its own cap, written when the probe ran one burn per target. Adding a multiplier made the run time the product of caps nobody had summed. The same shape applies to any workflow with a count input and a list input.

## Fix

Not applied in item 51 (deferred). The sketch: in `validate`, add up the worst-case time (sum of target latencies at the measured ratio plus gaps, times repeats) and refuse with the number and the job limit when it exceeds a margin under 30 minutes; and write partial results after each target so a timeout keeps what ran. Reviewers also noted that a failed `/mark` or `/state` read after a completed burn is counted as a `restart`, though nothing showed the instance changed; it should be its own verdict.

## How to catch it next time

When a change adds a count or repeat input to a script a workflow runs, ask what the largest accepted combination costs in wall time, and compare it with `timeout-minutes`. Add a unit test that the largest accepted input set fits and that one step past it is refused by name. Prefer incremental result writes for any long loop whose output is only read at the end.
