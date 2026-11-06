---
title: Decoded path parameters must be re-encoded when forwarded internally
area: api
tags: [routing, path-params, encoding, ident, 404, dispatch]
seen:
  - 2026-11-06 – item 20, patch 0016, PR #33
promoted_to: ["CLAUDE.md Gotchas", "REVIEW.md"]
---

## Symptom

`set_block_property`, `delete_block_property`, `get_property`, `update_property` and `delete_property` returned 404 for `logseq.property/status`. UUIDs and titles worked, and batch calls (with the ID in the body) worked.

## Cause

The router decodes `logseq.property%2Fstatus` while matching the public route. `forward-semantic-request` in `worker/dispatch.cljs` then pasted the decoded value into the internal path, so the `/` added a path segment and no internal route matched.

## Fix

Patch 0016 encodes each path parameter again when it builds the internal path. A test sends `logseq.property%2Fstatus` through the public route.

## How to catch it next time

For any route with an ID in the path, test an ID containing `/`, `%` and spaces through the public entry point, not the internal handler.
