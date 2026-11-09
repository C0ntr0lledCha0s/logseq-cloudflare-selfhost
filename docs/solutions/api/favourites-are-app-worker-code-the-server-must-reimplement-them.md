---
title: Page favourites are app worker code, not a db-sync API, so the server must reimplement them
area: api
tags: [favourites, favorites, "$$$favorites", block-link, reorder, upstream-capability, spike]
seen:
  - 2026-11-09 – spike "page favourites through the connector" (read-only, nothing run)
promoted_to: []
---

Full findings and the build sketch: [the spike write-up](../../spikes/2026-11-09-page-favourites-through-the-connector.md). This entry keeps only the facts a later lane should not research again. The spike read source and ran no tests, so items marked *unverified* still need a test.

## Symptom

The connector had no way to list, add, remove or reorder favourite pages, and a first look for an upstream function to call finds nothing in `deps/db-sync`.

## Cause

- Favourites are one hidden page named `$$$favorites` (`common-config/favorites-page-name`) with a deterministic builtin uuid, created at graph creation by `create_graph`. Each favourite is a child block with `:block/link` to the page and an empty title, ordered by `:block/order`. `ldb/build-favorite-tx` builds the block.
- The operations (`set-page-favorite`, `reorder-favorites`, `get-favorite-pages`) live in the app's db worker (`src/main/frontend/worker/handler/graph.cljs`), not in `deps/db`, `deps/outliner` or `deps/db-sync`. db-sync cannot call them.
- Reorder in the app does not move blocks. It rewrites `:block/link` on the block in each slot, so order keys never change.
- The app silently does nothing when `$$$favorites` is missing, skips unresolvable uuids in a reorder and does not check the list is a permutation. Copied as is, each would be a silent success here.
- The outliner does not validate `:block/link`, and its `delete-page!` does not remove favourites (the app does it in the frontend). So every target rule is the handler's, and `delete_page` leaves a dangling favourite that reads must filter out.
- The favourite block has no `:block/tags`, so the private-tag 500 does not apply.

## Fix

None yet. The spike's call is build, as patch 0038 plus `list_favorites`, `set_page_favorite` and `reorder_favorites`. A removal retracts a link block with nothing in its place, so the delete table counts it as a delete (`favorite === false`), and `write-no-delete` tokens must be refused it.

## How to catch it next time

- Before searching for an upstream function to call, grep `src/main/frontend/worker` as well as `deps/`; some app behaviour only exists there.
- Reimplement with `atomic-write!` and seeded order keys, and refuse what the app skips silently. The app's `{}` insert opts put a new favourite at the top (`get-target-block`, `core.cljs:933-938`, and `get-block-orders`, `:715-722`); `:bottom? true` would append, the opposite order.
- On E2EE graphs the page's name and title are encrypted: find `$$$favorites` by its deterministic uuid, never by name, and never create it there (an upsert by that uuid would overwrite the encrypted name with plaintext).
- Test on a graph built by `create_graph` with the real outliner. Still *unverified*: whether the target's `:block/updated-at` changes (it would re-embed the page), whether `stamp-tx` stamps the block, and whether older or uploaded graphs lack `$$$favorites`.
