---
title: Redact a secret before truncating the text that holds it, and give the client and the docs one set of variable names
area: connector
tags: [secrets, redaction, truncation, cli, env-vars, service-token, docs-drift]
seen:
  - 2026-11-07 – service-token-cloud-sessions, review round 1 (r1-tests-1, r1-tests-2)
promoted_to: []
---

## Symptom

Two defects in `scripts/logseq-mcp.mjs`, both found by the round 1 tests lens.

1. A non-JSON server message was cut to 500 characters and then redacted. A bearer echoed across the cut left a partial token that matched neither the token's value nor the service-token shape, so it was printed.
2. The CLI read only `LOGSEQ_MCP_URL`, while `.mcp.json` and the docs used `LOGSEQ_MCP_HOST`. Following the documented setup sent the bearer to the default host, not the owner's.

## Cause

1. Redaction by exact value (and by shape) only works on the whole secret. Any step that slices the text first, such as `slice(0, 500)`, can leave a fragment that neither rule matches. The order of "cut" and "redact" is the bug, and a test that used a token-shaped value passed anyway, because the shape rule caught it.
2. Two consumers of one setting (the checked-in `.mcp.json` and the CLI fallback) were written from different notes, and nothing compared their variable names.

## Fix

`clip()` redacts first, then cuts, and every caller (HTTP error bodies, non-JSON answers, non-JSON SSE data) passes the token. `serverUrl()` takes `LOGSEQ_MCP_URL`, else `https://$LOGSEQ_MCP_HOST/mcp`, else the default, as `.mcp.json` does.

## How to catch it next time

- Test every path that prints server text with two secrets: one in the real shape and one that is not, so only the exact-value rule can redact it. Put the secret across the truncation boundary and pin the cut length.
- When a feature has a checked-in config and a script that read the same setting, grep both for the variable names and add a test that the documented setup reaches the documented host.
