---
title: UUID selectors already resolve in any case, because cljs `uuid` lower-cases and `uuid-string?` is case-insensitive
area: api
tags: [uuid, case, not-a-bug, parse-uuid, uuid-string, selector, path-param, false-premise]
seen:
  - 2026-11-07 – item 26 defect 5 (bug lane, closed as not a bug, no patch 0032)
promoted_to: []
---

## Symptom

A brief said an uppercase or mixed-case UUID string was "not found or treated as a title" at every semantic API lookup (block, page, property, class, choice, target-id, tags values, node values, path params). It guessed that `common-util/uuid-string?` and `(uuid ...)` disagree on case.

## Cause

There was no defect. Every UUID lookup in `deps/db-sync/.../handler/semantic.cljs` goes through one of three parse points, and each ignores case:

- `cljs.core/uuid` lower-cases its input (`(UUID. (.toLowerCase s) nil)`), so `[:block/uuid parsed]` lookups always use the canonical lowercase UUID.
- `parse-uuid` uses a `[0-9a-fA-F]` regex and then calls `uuid`.
- `common-util/uuid-string?` uses `(?i)^...$` (`deps/common/src/logseq/common/util.cljs`).

The only places that keep the raw string are `parse-ids` (strings go on to `find-visible-entity`, which calls `uuid`, and are echoed back in `missing`) and the server-made block-changes cursor. Batch bookkeeping is keyed by db id, so mixed case within one batch also works. In the connector, path segments pass through as given, `assets.ts` uses `[0-9a-fA-F]`, zod 4's `format: 'uuid'` accepts any case, and the semantic index, `semantic_search` and `kb_index` only handle UUIDs the server returned (lowercase).

The brief was written from a code-reading guess ("about 25 raw uses, they may disagree"), not from a request that was seen to fail.

## Fix

None. The lane recorded the outcome and, at most, a guard test that pins today's behaviour. Do not add per-site `string/lower-case` calls.

## How to catch it next time

- Before enumerating sites for a "fix the class" brief, send one real request through `sync-handler/handle-http` per site kind with the suspect input (here, an uppercased UUID). A few minutes of repro would have settled it before any site-by-site reading.
- For identifier-case claims, check what the parse primitive does (`uuid`, `parse-uuid`, `uuid-string?`) before looking at call sites. If the primitive normalises, the call sites cannot disagree.
- A repro that passes is still worth keeping as a guard test: it fails if a later change swaps `uuid` for a raw string comparison.
- Caveat left open: `[[UUID]]` refs inside free text go through the graph-parser, were not traced, and are not a semantic API lookup site.
