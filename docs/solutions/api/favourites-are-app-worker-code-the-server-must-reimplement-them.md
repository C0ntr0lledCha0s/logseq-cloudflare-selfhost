---
title: Page favourites are app worker code, not a db-sync API, so the server must reimplement them
area: api
tags: [favourites, favorites, "$$$favorites", block-link, reorder, upstream-capability, spike]
seen:
  - 2026-11-09 – spike "page favourites through the connector" (read-only, nothing run)
  - 2026-11-09 – feature "page favourites connector tools", patch 0038 (built; the unverified items below are now settled)
promoted_to: ["CLAUDE.md Gotchas"]
---

Full findings and the build sketch: [the spike write-up](../../spikes/2026-11-09-page-favourites-through-the-connector.md). The design and what was built are in [the spec](../../superpowers/specs/2026-11-09-page-favourites-connector-tools-design.md) (section 12, *As built*). This entry keeps the facts a later lane should not research again.

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

Patch 0038 plus `list_favorites`, `set_page_favorite` and `reorder_favorites`. A removal retracts a link block with nothing in its place, so the delete table counts it as a delete (`favorite === false`), and `write-no-delete` tokens are refused it. Reorder is a `never` delete.

Settled by real-outliner tests on a `create_graph` db (the spike's *unverified* items):

- Add and reorder do not change the target's `:block/updated-at`. Only the new slot and the favourites page (the insert touches its parent) change, so nothing is re-embedded and Workers AI and Vectorize cost 0.
- `save-block` keeps a changed `:block/link` but leaves `:block/refs` alone, because the client refs pipeline never runs on the server. Reorder sets each rewritten slot's refs itself. An add leaves refs empty, so backlinks and the feed are unchanged.
- With the stamp header on, `:stamp?` is stripped from the creator and the slot carries no `editedBy`. An ordinary edit with the same header is stamped, so the test needs both halves.
- `:bottom? true` sorts a new slot after the last sibling even when the graph's max key is elsewhere.
- Reorder must re-point the first *live* slots (those linking a visible page, later duplicates included), not only the visible ones. Otherwise a duplicate sitting between visible slots lands in front of its page's new slot and the list reads back in another order.

Cost per write: about 3 D1 rows written, 2 read and 2 to 3 Worker requests. At 300 writes a day that is 900 rows written (0.9% of 100k), about 600 read and 900 requests (0.9% of 100k). No migration.

## How to catch it next time

- Before searching for an upstream function to call, grep `src/main/frontend/worker` as well as `deps/`; some app behaviour only exists there.
- Reimplement with `atomic-write!` and seeded order keys, and refuse what the app skips silently. The app's `{}` insert opts put a new favourite at the top (`get-target-block`, `core.cljs:933-938`, and `get-block-orders`, `:715-722`); `:bottom? true` would append, the opposite order.
- On E2EE graphs the page's name and title are encrypted: find `$$$favorites` by its deterministic uuid, never by name, and never create it there (an upsert by that uuid would overwrite the encrypted name with plaintext).
- Test on a graph built by `create_graph` with the real outliner. Still *unverified*: whether the target's `:block/updated-at` changes (it would re-embed the page), whether `stamp-tx` stamps the block, and whether older or uploaded graphs lack `$$$favorites`.
- Every refusal must cover both directions of a toggle. The first build gated the hidden-page refusal on `favorite: true`, so `favorite: false` on a hidden page, or on `$$$favorites` by uuid, answered 200 with the title (and would have deleted a hidden page's slots) while the title selector answered 404. A recycled page is the one deliberate exception, so `delete_page`'s leftover can be cleared.
- Read the result back inside the `atomic-write!`, before commit. A read-back after commit that answers 500 leaves the write stored. Prove it with a stubbed wrong result and assert nothing was stored.
