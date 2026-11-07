---
name: add-upstream-patch
description: Change the Logseq sync server or its semantic REST API (handlers, routes, outliner, sync) by adding a numbered patch under patches/. Use whenever a fix or feature needs code in upstream deps/db-sync, when an API tool misbehaves at the server, or when a lane's root cause is in the patch, upstream or sync layer.
---

# Add an upstream patch

The sync server is upstream `logseq/logseq` at the commit in `UPSTREAM_REF`. `scripts/fetch-upstream.sh` applies `patches/*.patch` in name order with `git apply`, and stops at the first patch that doesn't apply. CI and deploy build from that result.

## Steps

1. **Fresh checkout and baseline.**
   ```bash
   rm -rf .upstream && scripts/fetch-upstream.sh .upstream
   git -C .upstream add -A && git -C .upstream commit -qm baseline
   ```
   The baseline commit is what makes the next diff contain only your change.
2. **Find the code.** API handlers live in `deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`, routes in `.../worker/routes/semantic.cljs`, and forwarding in `.../worker/dispatch.cljs`. Read the existing patches for the area first (`grep -l <fn> patches/*.patch`): a later patch must not undo an earlier one.
3. **Test first,** in `deps/db-sync/test/logseq/db_sync/`, through `sync-handler/handle-http` or the real outliner. For anything touching transactions, also replay the result on a client copy (see `patches/0018-*`). Run it and keep the failure.
4. **Change the code,** then build and test:
   ```bash
   scripts/build.sh .upstream
   ```
   ```bash
   (cd .upstream/deps/db-sync && pnpm test)
   ```
5. **Write the patch** as the next number, with a name that says what it does:
   ```bash
   git -C .upstream diff > patches/00NN-semantic-what-it-does.patch
   ```
   Check that it applies on its own: `rm -rf /tmp/up && scripts/fetch-upstream.sh /tmp/up`.
6. **Re-vendor** if the OpenAPI document changed (new or changed operations), then update the manifest:
   ```bash
   scripts/vendor-upstream-api.sh .upstream
   ```
   ```bash
   npm --prefix connector run update:manifest
   ```
7. **Gate:** `scripts/check.sh --upstream`.

## Rules

- **Shipped patches are history.** Amend a patch only before its PR merges. After that, fix forward with a new patch.
- **One concern per patch.** A patch is the unit an upstream PR would take. Note in the PR body if the fix belongs upstream, since the owner keeps a fork for upstream PRs.
- **Don't edit `.upstream` and forget it.** It's gitignored, so only `patches/` carries the change.
- **Name the allowed set for every lookup.** A title or ident lookup resolves only inside a named set: the property's choices, its classes, its own value blocks, or pages. Don't rely on the outliner to check closed values on server writes. Tests need a decoy created first, and a value that is legitimately duplicated (a URL held by two blocks, a journal title). See `docs/solutions/api/title-resolves-outside-allowed-values.md`.
- **Copy the app's guard with its rule.** When a patch mirrors something the app does (heading conversion, tag handling), find the guard the app applies with it, such as a display-type check, and copy that too. When two write paths do the same job, test both with the same input (item 32).
- **Time-dependent tests run under two zones.** A test about "today" or a date must not depend on the process's zone. Run it under UTC and under a non-UTC zone, for example `UPSTREAM_TEST_RUN_CMD='env TZ=America/Los_Angeles node worker/dist/worker-test.js' scripts/upstream-test.sh .upstream <namespace-regex>`, and see it fail before the fix under both (item 24).
- **Errors name the entry and reason, and reads must show what writes stored.** See REVIEW.md, *API and patches*.
