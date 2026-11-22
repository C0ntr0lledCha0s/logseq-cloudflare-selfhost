---
title: When a narrowed walk charges a bound before it filters, the 422 must say what was counted and give advice that can clear that bound
area: api
tags: [named-query, open-tasks-by-client, client, bound, 422, advice, candidates, error-text, contract]
seen:
  - 2026-11-22 – item 52, patch 0054, review (three should-fix findings, deferred; none refuted)
  - 2026-11-22 – item 52, patch 0054, fixed before merge (r2-correctness-1, r2-light-1, r1-light-1)
promoted_to: []
---

## Symptom

`open-tasks-by-client` with `client` set walks from the client (blocks holding the client, plus the blocks on its pages) and keeps the tasks whose own client, else their page's, is that client. Review found the refusal text still read as if the bound counted the client's tasks:

- The `open-tasks` bound is charged to every open Task candidate on the walk, including a task that has its own client B on one of the target's pages. The 422 said "more than N open tasks of <client>", so it could refuse a client whose own tasks are within the bound.
- The `tasks` bound's advice was to mark finished tasks Done or Canceled. Finished tasks do not count towards a Task-scan bound, so the advice cannot clear it.

## Cause

Narrowing the walk changed what the bound counts, from "Task blocks in the graph" to "candidates reached from the client". The message text and advice were written per bound before the narrowing and then given a client-flavoured variant (`:client {:advice ... :open-tasks [... "open tasks of <client>" ...]}`) without checking what each counter now counts. The acceptance text asked for the client 422 to name "what the bound counted (blocks holding the client or on its pages)", which is a statement about candidates, and the open-tasks variant drifted from it.

## Fix

Fixed in patch 0054 before it merged, so the bounds now count what their 422 says:

- **r2-correctness-1.** With a client, `open-tasks-by-client` charges `:open-tasks` only after a task is found to match the client (its own client, else its page's). A task on the client's page whose own client is another one is still a candidate (`:tasks`) but no longer an open task of the client. In the `with-client-walk` fixture zq Beta's work is now `{:tasks 32 :open-tasks 30}`, and `{:open-tasks 30}` answers 200 with its 30 rows where it used to answer 422. The upload-path test (`uploaded-graph-client-walk-test`) shows the same drop, from 3 to 2.
- **r2-light-1.** With that, "more than N open tasks of <client>" is true. The dry-run plan now puts the `:open-tasks` count on the step that keeps the client's tasks (step 3), not on the status step, and the `runNamedQuery` description says the count is taken once a task is found to be the client's.
- **r1-light-1.** `:tasks` has its own advice, since it is charged before the status is read: "give a client (params.client)" without a client (a default or url `client_property` keeps "list one client's tasks with datalog_query"), and "list one of its pages' tasks with datalog_query" with one. "Mark finished tasks Done or Canceled" stays only on `:open-tasks` and `:reads`.

The exact-message tests, `scripts/release-query-check.mjs`'s `clientBoundMessage`, the bench test, the route description and its vendored copy, `QUERIES_HELP` and README §11.8 and the 422 troubleshooting row changed together.

## How to catch it next time

- When a change narrows a walk, list each bound and say in one line what its counter counts now. Then read every message and piece of advice for that bound against the line.
- Test the refusal with a decoy that is counted but not returned (a task with another client on the target's page) and assert the message does not claim the count belongs to the target.
- For each piece of advice, ask whether following it lowers the counter that stopped the call.
