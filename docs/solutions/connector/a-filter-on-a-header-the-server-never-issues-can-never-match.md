---
title: A filter on a value the server never issues can never match, and tests that inject the value hide it
area: connector
tags: [audit-log, get_activity_log, session, mcp-session-id, silent-empty, old-callers, zod, stateless]
seen:
  - 2026-11-20 – item 48 (get_activity_log session filter), branch fix/audit-log-session-filter
promoted_to: []
---

## Symptom

`get_activity_log` took a `session` input and answered "No entries" for every value. Every MCP write row had `session` NULL.

## Cause

`audit_log.session` was copied from the `mcp-session-id` request header. The MCP handler (agents SDK `createMcpHandler`) is stateless: it sets `sessionIdGenerator: undefined` and refuses one, so `initialize` never returns that header. Streamable HTTP clients echo the header only if the server issued it, so claude.ai and Claude Code never sent one. `session = ?` cannot match NULL. The only non-null values (`github:<ownerId>` on wizard token_edit rows) have `graph_id` NULL and sit outside the graph-scoped query. The tests passed because they hand-inserted rows with a session or put `mcp-session-id` on the request themselves, so none reached the handler the way a real client does.

## Fix

Option (b): the handler refuses `session` by name ("no longer supported; MCP calls carry no session id"), the filter is gone from `AuditQuery` and the SQL, and the always-null column stays (no migration). Not chosen: a grant or token hash, because one OAuth grant spans many conversations, so the key would mean grant, not session, and it needs an HMAC key and auth changes. The input stays in the schema only so it can refuse: zod strips unknown keys on a plain `z.object`, so deleting it would have turned an old `session: 'x'` call from an empty result into an unfiltered listing.

## How to catch it next time

- For any input that filters on a stored value, ask where the value is first written and by whom. If it comes from a client header or body, check that real clients send it.
- Drive the real handler the way a client does (no optional header) and assert the stored value. Add a guard test that `initialize` returns no `mcp-session-id`, so the premise fails loudly if the SDK changes.
- When removing an input, check what zod does with the old key. A silent strip is a behaviour change (REVIEW.md, *Old callers*).
- Tool text that says "no entry could match" must stay true when a client does send the header (deferred should-fix at the end of this lane: the `id` description still said "The other inputs are ignored", and the refusal wording over-claims for a client that sends `mcp-session-id`).
