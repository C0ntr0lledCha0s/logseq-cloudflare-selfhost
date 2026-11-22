---
title: When a narrowed walk charges a bound before it filters, the 422 must say what was counted and give advice that can clear that bound
area: api
tags: [named-query, open-tasks-by-client, client, bound, 422, advice, candidates, error-text, contract]
seen:
  - 2026-11-22 – item 52, patch 0054, review (three should-fix findings, deferred; none refuted)
promoted_to: []
---

## Symptom

`open-tasks-by-client` with `client` set walks from the client (blocks holding the client, plus the blocks on its pages) and keeps the tasks whose own client, else their page's, is that client. Review found the refusal text still read as if the bound counted the client's tasks:

- The `open-tasks` bound is charged to every open Task candidate on the walk, including a task that has its own client B on one of the target's pages. The 422 said "more than N open tasks of <client>", so it could refuse a client whose own tasks are within the bound.
- The `tasks` bound's advice was to mark finished tasks Done or Canceled. Finished tasks do not count towards a Task-scan bound, so the advice cannot clear it.

## Cause

Narrowing the walk changed what the bound counts, from "Task blocks in the graph" to "candidates reached from the client". The message text and advice were written per bound before the narrowing and then given a client-flavoured variant (`:client {:advice ... :open-tasks [... "open tasks of <client>" ...]}`) without checking what each counter now counts. The acceptance text asked for the client 422 to name "what the bound counted (blocks holding the client or on its pages)", which is a statement about candidates, and the open-tasks variant drifted from it.

## Fix

Left for a follow-up at the time of writing. The wording to aim for: with a client, name the candidates ("blocks holding <client> or on its pages"), and advise something that lowers that count (a more specific client, or the `datalog_query` fallback), not marking tasks Done.

## How to catch it next time

- When a change narrows a walk, list each bound and say in one line what its counter counts now. Then read every message and piece of advice for that bound against the line.
- Test the refusal with a decoy that is counted but not returned (a task with another client on the target's page) and assert the message does not claim the count belongs to the target.
- For each piece of advice, ask whether following it lowers the counter that stopped the call.
