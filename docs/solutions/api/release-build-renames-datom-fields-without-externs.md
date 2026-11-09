---
title: The release bundle renames Datom fields unless the build lists Datascript's externs, so a query that passes on the dev build returns nulls in production
area: api
tags: [datalog_query, release-build, advanced-compilation, externs, shadow-cljs, ci, datascript]
seen:
  - 2026-11-09 – item 40, safe-caller-datalog-queries spike (found at patch 0039 `7d04944`; not yet fixed when recorded)
promoted_to: []
---

## Symptom

`datalog_query` on the deployed build answers 200, but every variable bound to a datom value is `null`. A tag self-join returned 0 rows where the dev build returned 841, and a `clojure.string/includes?` query answered 400 `Cannot read properties of undefined (reading 'indexOf')`. All the dev-build tests passed.

## Cause

The `:db-sync` build in `deps/db-sync/shadow-cljs.edn` has no `:externs ["datascript/externs.js"]`, unlike upstream's app builds (`shadow-cljs.edn:28-32`). Advanced compilation renames the Datom field `v` (`case "v":return a.ka`), while Datascript's `lookup-pattern-db` reads tuple fields by the strings `"e" "a" "v" "tx"`. Upstream db-sync has no other server-side `d/q`, so nothing had exposed it. CI builds the release bundle but never queries it, and `scripts/smoke-test.sh` calls no semantic route.

## Fix

Not applied when recorded. The spike's follow-up is to add the externs entry through patch 0039 (or its own patch) and a CI step that runs a datalog query against the release bundle, which must fail without the fix. Check the patch history for what shipped. Details: `docs/spikes/2026-11-09-safe-caller-datalog-queries.md`, finding 0.

## How to catch it next time

- Any new server code that reads library data structures by string or property name (`d/q`, `d/pull`, datom accessors) needs a test against the release bundle, not only the `:node-test` build. Dev builds do not rename.
- Run one real query through the release `SyncDO.fetch()` and assert a non-null value, with the build step in CI.
- Before blaming the handler for wrong results that only appear deployed, compare the dev and release answers for the same query.
