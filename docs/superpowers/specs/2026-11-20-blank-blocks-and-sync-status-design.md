# Blank-block cleanup and graph sync status: design

Date: 2026-11-20
Issue: none (brief supplied directly by the owner: "a tool that takes a list of pages and deletes any blank or empty blocks found there. Also a tool to return sync status"). Areas: patch, connector, semantic, docs.
Upstream: `logseq/logseq` at `UPSTREAM_REF` (`e7e9c97`), `deps/db-sync`, with patches 0001 to 0040 on `origin/main`. This work adds two patches. Their numbers depend on merge order: PRs 59 to 74 hold patches 0041 to 0049 and plan 0050 to 0054, so these are likely **0055** (sync status) and **0056** (blank blocks). They are renumbered on rebase. Shipped patches (0040 and earlier) are never edited.
Branch: `feat/blank-blocks-and-sync-status`, from `d25f2cf` (`origin/main`, includes PR 57). Not stacked on any unmerged PR.
Builds on: `2026-11-08-service-token-write-no-delete-design.md` ("the no-delete design", which owns the delete table), `2026-11-07-connector-write-audit-log-design.md` (audit snapshots), `2026-11-04-semantic-search-design.md` (`semantic_index_status`), `2026-11-09-page-favourites-connector-tools-design.md` (the recent pattern: a semantic patch with generated tools).

Decisions marked **(brief)** come from the brief. Decisions marked **(call)** were made while writing this design. The design panel chose the "safety" proposal: a server-side, in-transaction blank-block delete with a mandatory dry-run-then-ids handshake, and a read-only sync-status route folded with the semantic index state in one hand-written tool. Grafted from the other proposals: whole-call refusal naming `page-ids[i]`, including a duplicate found only after resolution (minimal); a stamped blank block as a test case (minimal); compact, capped dry-run output (cost); `last-written-at` read from `tx_log` by primary key (cost). Considered and not taken: memoising Tool B's counts by `t` (cost, minimal) is kept as the fallback if the CPU bench fails (section 7). The decisions most worth a second look are in section 11.

**What was run for this spec.** Nothing beyond reading source. This spec states no bug cause, so there was nothing to reproduce. `.upstream` currently holds unmerged work (patches 0041 to 0048 and an uncommitted change), so every upstream line reference below was read with `git show 03352db:<path>`, the `.upstream` commit holding upstream plus patches 0001 to 0040, which is what `origin/main` builds. Behaviour that no test has shown yet is marked **unverified**, and section 8 names the test that settles it.

**A correction to the panel.** Two judges said nothing rebuilds the presence atom after the Durable Object hibernates, so a read of `presence/online-users` would count 0 clients after a wake. That is not what the code says. The DO constructor (`worker.cljs:39-44`) walks `(.getWebSockets state)`, reads each socket's serialised attachment with `presence/attachment->user` and puts the user back in the atom. `add-presence!` and `update-presence!` (`presence.cljs:42-60`) write the attachment on every change, `editing-block-uuid` included. So the atom is correct after a wake, and this design reads presence through it rather than adding a second reader over `getWebSockets`. A test still constructs a DO from attachments only, to pin this (section 8).

## 1. Goal

The owner wants two connector tools:

- **`delete_blank_blocks`** (Tool A) takes a list of pages and deletes the empty leaf blocks on them, so Claude can tidy pages after imports, captures and edits that leave empty bullets behind.
- **`get_sync_status`** (Tool B) answers, in one read-only call, where a graph's sync log stands, how big it is, how many clients are connected, and how far behind the semantic index is.

Acceptance (brief):

1. Tool A takes a list of pages (UUID or title) and deletes only empty leaf blocks: an empty or whitespace-only title, no child blocks, no user properties or tags.
2. A blank block that has children is kept. It is not deleted, its children are not lifted, and it is listed in the result.
3. Tool A has a dry run showing, per page and per block, what would be deleted. It requires a reason, and it reads back after the delete.
4. An unknown or ambiguous page refuses the whole call up front with an error naming the page and the reason, and nothing is written.
5. The spec decides patch (one transaction in the semantic handler) versus connector-side composition over `list_page_blocks` and `delete_blocks`, justified against REVIEW.md (*Destructive operations keep their guards*), *No silent success* and the batch single-tx-id gotcha (section 3.1).
6. The spec decides value blocks, property blocks, Code/Math/Quote display-type blocks with empty text, a page's pre-block, journals, E2EE graphs, Private content and a cap on pages per call, with Free plan cost counted (sections 3.4, 5).
7. Tool B is read-only and returns, for one graph: the latest tx (`t`), the last-written time, block and page counts, connected clients from presence, and the `semantic_index_status` state folded in.
8. Tool B runs no full checksum recompute.
9. The spec states what presence identifies (user, device, client kind), and that tokens and other users' details on a shared graph are not exposed (section 6).
10. The spec counts Durable Object CPU and D1 rows read per call for each tool against the Free plan (section 5).
11. The spec says whether the tools ship in one PR or two, and weighs them separately (section 3.1).
12. Every new tool has a first line of at most 100 characters (`FIRST_LINES` in `spec.mjs`).
13. Tool text, `connector_help`, `tools-manifest.json`, README §11.8 and the Logseq skill note are updated, and the patch numbers depend on merge order.
14. The spec is committed here and the lane stops for approval with nothing built.
15. No live write is made. Any live check uses only the graph alias `test`. The owner's graph name and page UUIDs are not copied into any file.

## 2. Context

**What deletes do today.** `deleteBlock` (`:semantic/blocks-delete`, `semantic.cljs:2807`) and `deleteBlocks` (`:semantic/blocks-delete-many`, `:4743`) call `outliner-core/delete-blocks!` inside one `atomic-write!` (`:2501`), so a delete is one authored transaction with one tx id. Both take the block's descendants with it (`ldb/get-block-full-children-ids`), and both then run `confirm-removed!` (`:2103`), which answers 500 naming any survivor. `deleteBlocks` counts the references a delete breaks only on a dry run (`block-reference-count`, `:4760-4766`) and never refuses because of them. It refuses pages, tags and properties by kind. `check-labels!` (`:2302`) is the guard that a target still reads as the label the caller saw. Its refusal carries its own status, and `rejecting` (`:1624`) answers it. `dry-run-option` (`:1615`) reads a body `dry-run` that defaults to false.

**What a page read offers.** `resolve-page-selector` (`:2151`) resolves a UUID, a `YYYY-MM-DD` journal date or a title, hides hidden and recycled pages, and answers 409 with candidates for an ambiguous title. `max-outline-blocks` (`:411`) bounds an outline read at 2,000 blocks. `referrer-ids` (`:2402`) finds the visible entities that link to, embed, alias or hold an entity as a property value. `datalog/private-ids` (`datalog.cljs:529`) is every entity tagged Private (or a class extending it), every entity in the Recycle bin, and everything on or under one of those. `list-pages` (`:483`) is the entities tagged Page or Journal.

**What the sync DO stores.** `storage.cljs:30-44`: `kvs` (the datascript store), `tx_log (t INTEGER primary key, tx, created_at, outliner_op, tx_id)` and `sync_meta (key, value)`. `get-t` and `get-checksum` (`:60-72`) are single `sync_meta` reads by key. `sync-handler/t-now` and `current-checksum` (`sync.cljs:58-64`) wrap them. The checksum is kept up to date as transactions land. `checksum/diagnostics` is the route that recomputes, and Tool B never calls it. A graph uploaded from a snapshot may have `t` above 0 and no `tx_log` row at that `t`, so `last-written-at` can be null.

**What presence holds.** `presence/claims->user` (`presence.cljs:6-19`) keeps the JWT's `sub` (user id), `email`, `username` and `name`. A `presence` message adds `editing-block-uuid` (`ws.cljs:24-30`). Nothing else is recorded: no device, no platform, no app version, no client kind. The connector's own HTTP calls are not WebSockets and never appear. The atom survives hibernation as described above.

**What the connector has.** `semantic_index_status` (`semantic-search.ts:444-478`) reads `deps.store.state(graphId)`, `deps.store.counts(graphId)` and `index.describe()`, and is registered only when semantic search is configured (`SEMANTIC_TOOLS`, `spec.mjs:32`). Generated tools come from the vendored `openapi.json`. `EXCLUDED_OPERATIONS` (`spec.mjs:137`) keeps an operation out of the generated set. Each tool needs an `ANNOTATIONS` entry, a `FIRST_LINES` entry (`spec.mjs:243`, at most 100 characters), a `DELETE_RULES` entry and, for a dry-run tool, a `DRY_RUN_TOOLS` entry (`deletes.mjs`), a `readable.ts` classification, and for a write a `SNAPSHOT_PLAN` entry (`audit/snapshot.ts`).

## 3. Design

### 3.1 Layout, patch versus composition, and delivery

**Tool A is a patch (call).** The alternative was composing it in the connector: page through `list_page_blocks` for each page, pick the blank leaves, then call `deleteBlocks`. It loses on four counts:

- The common blank block is the one the owner just made by pressing Enter in the app. A composed delete reads in one request and deletes in another. Anything typed or nested in between is lost, because `deleteBlocks` takes descendants and does not refuse on references (section 2). REVIEW.md *Destructive operations keep their guards* asks for the guard and the write in one place.
- The paginated reads expose neither the raw attribute set the predicate needs nor presence.
- *No silent success* and the single-tx-id gotcha are met by one `atomic-write!` with a re-check inside it. A composed tool can only re-check before its delete request, not inside it.
- Composition costs 1 + N + (pages) sync requests and sits near the 50-subrequest ceiling at 10 pages. The patch costs one.

**Tool B is a patch plus a hand-written tool (brief, call).** `t`, `tx_log` and presence live only inside the DO, so a route is unavoidable. The connector tool is hand-written because it folds in D1 state the sync server cannot see.

**Two PRs, Tool B first (call).**

- **PR 1: `get_sync_status`.** Patch 0055 (`semantic-sync-status`), hand-written tool. Read-only, size S to M. Its review is about exposure (section 6) and the count's CPU (section 5). It adds the presence-summary helper that Tool A's editing check reuses.
- **PR 2: `delete_blank_blocks`.** Patch 0056 (`semantic-delete-blank-blocks`), generated tool. Destructive, size L. It needs its own review rounds and skeptics on the predicate and the replay.

They share no state, so either can be dropped without the other.

### 3.2 Tool B route: `GET /api/v1/graphs/:graph-id/sync-status`

Patch 0055 adds the route to `routes/semantic.cljs` with operation id `getSyncStatus`, `:scope "logseq/read"`, `:rate-class :read`, handled in `handler/semantic.cljs`. It reads:

| Field | Source | Cost |
|---|---|---|
| `t` | `storage/get-t` | 1 `sync_meta` row |
| `last-written-at`, `last-op` | `select created_at, outliner_op from tx_log where t = ?` (primary key) | 1 row; null when no row holds that `t` |
| `checksum` | `storage/get-checksum`, as stored (null when none) | 1 `sync_meta` row; never recomputed |
| `page-count` | `list-pages`, minus hidden pages and `private-ids` | O(pages) |
| `block-count` | `:aevt :block/page` datoms whose page is in the counted set and whose block is not in `private-ids` | O(blocks), no entity reads |
| `e2ee` | the request context's `e2ee?` | none |
| `clients` | the presence atom's values | O(sockets) |

`private-ids` includes the Recycle bin, so both counts match what other reads show. On an E2EE graph the counts still work, because they read no titles. `private-ids` matches class titles, which are ciphertext there. On E2EE graphs the counts therefore include Private content, and the response says so with `counts-include-private: true` **(call)**.

`clients` is `{connected, users, own, others, editing}`:

- `connected` is the number of sockets.
- `users` is the number of distinct user ids.
- `own` is the sockets whose user id is the caller's, from the same request context `creator` is built from. This is **unverified** until the plan confirms that the context carries the owner's user id for a service token. If it doesn't, `own` and `others` are dropped and `users` stays.
- `others` is `connected - own`.
- `editing` is the sockets that report an `editing-block-uuid`.

All five are counts. The response holds no user id, email, username, name, block UUID or token.

### 3.3 Tool B connector: `get_sync_status`

A new `connector/src/tools/sync-status.ts` registers `get_sync_status({graph})` in `HANDWRITTEN_TOOLS`, not `SEMANTIC_TOOLS`, so it exists whether or not semantic search is configured. It:

1. resolves the graph as other read tools do;
2. calls `getSyncStatus` (one sync request);
3. when semantic search is configured, builds the semantic part with the same function `semantic_index_status` uses. That builder moves out of `semantic-search.ts` into a shared function, minus the Vectorize `describe()` call, which status doesn't need. The part is `{status, indexed-blocks, indexed-at, index-t, behind-by, error}`, where `index-t` is `semantic_state.t` and `behind-by` is the sync `t` minus `index-t` (null when either is null). When semantic search is not configured, `semantic` is null and `semantic-note` says "semantic search not configured".

`getSyncStatus` goes in `EXCLUDED_OPERATIONS`, so Claude sees one tool. `semantic_index_status` is unchanged in behaviour. No D1 table or migration is added.

### 3.4 Tool A route: `POST /api/v1/graphs/:graph-id/blank-blocks/delete`

Patch 0056 adds the route to `routes/semantic.cljs` with operation id `deleteBlankBlocks`, `:scope "logseq/write"`, `:rate-class :write`, handled in `handle-bulk` next to `:semantic/blocks-delete-many`.

**Body.** `{page-ids: [1..20 selectors], dry-run?: boolean, block-ids?: [1..100 UUIDs]}`. Any other field is refused with 400 naming it. `dry-run` defaults to false, as `dry-run-option` does everywhere else, so the connector's `declaredDryRun` and the server agree. The safety comes from `block-ids` instead: **an apply without `block-ids` is refused** (400 `block-ids is required unless dry-run is true`). This departs from the panel's "dry run is the default" (section 11, question 2).

**Step 1: resolve the pages, refusing the whole call (brief, graft).** Each `page-ids[i]` goes through `resolve-page-selector`. Any of the following refuses the call, naming the entry, before anything is read or written:

- `page-ids[i]: page not found` (404). A hidden or recycled page reads as not found.
- `page-ids[i]: ambiguous title`, with candidates (409).
- `page-ids[i]: same page as page-ids[j]` (400), when two selectors resolve to one page.
- `page-ids[i]: is a whiteboard`, `is a tag` or `is a property` (400).
- `page-ids[i]: is Private` (400), when the page is in `private-ids`.
- An E2EE graph (409, `blank blocks can't be judged on E2EE graphs: titles are ciphertext`).
- More than 20 pages, or none (400).

**Step 2: the blank predicate (allow-list, call).** A block is a delete candidate only when **all** of these hold. Anything unexpected keeps the block.

- `block-kind` is `"block"`.
- `:block/title` is nil or `string/blank?`. A zero-width space counts as content.
- It has no `:block/_parent` children.
- `:block/tags` is empty, so an empty Task is kept.
- Every attribute it holds is in a fixed set: `:block/uuid`, `:block/parent`, `:block/page`, `:block/order`, `:block/title`, `:block/created-at`, `:block/updated-at`, `:block/tx-id`, `:logseq.property/created-by-ref`, and the Claude stamps `:user.property/claude-editedBy` and `:user.property/claude-editedAt` (patch 0034). A blank block Claude made is still blank. The set is pinned by a test on both a server-created and an upload-path graph (section 8). The names are taken from `initial_data.cljs:463` and `malli_schema.cljs:291`. That a plain block carries nothing else is **unverified**.
- `referrer-ids` is empty, which covers a `((ref))` or embed of the empty block.
- It is not in `private-ids` (on or under a Private page or block, or in the Recycle bin).
- No connected client reports it as its `editing-block-uuid`.

What the rule decides:

| Case | Outcome | Why |
|---|---|---|
| Property value block (`created-from-property`) | kept, silently | attribute outside the set; deleting it would orphan a value |
| Closed-value choice (`closed-value-property`) | kept, silently | attribute outside the set |
| A property block, a tag or a page | never a candidate | `block-kind` is not `"block"` |
| Pre-block (`:block/pre-block?`) | kept, silently | attribute outside the set |
| Empty Code, Math or Quote block | kept, silently | `:logseq.property.node/display-type` is a property, so the block was made on purpose |
| Empty heading | kept, silently | `:logseq.property/heading` is a property |
| Empty Task, or any tagged block | kept, silently | tags |
| Blank block with children | kept, listed with reason `has children`; children not lifted | brief |
| Blank leaf that something references | kept, listed with reason `referenced` | a delete would break the link |
| Blank leaf a client is editing | kept, listed with reason `being edited` | the owner just pressed Enter |
| Blank leaf on or under Private | kept, counted only in `skipped-private` | Private content never comes back |
| Journal pages, today's included | allowed | the editing check protects the owner's cursor |

A page may end with no blocks. The app shows it as an empty page and may add an empty block when it is opened. The tool text says so.

**Step 3: dry run (`dry-run: true`).** The handler walks each page's blocks through `:block/page` datoms. It stops with 422 naming `page-ids[i]` past 2,000 blocks on one page (`max-outline-blocks`) or 10,000 in the call. It writes nothing. The answer is compact (graft):

```
{dry-run: true, t, total, listed, pages: [{page, uuid,
   would-delete: [{uuid, parent}],
   kept: {has-children: n, referenced: n, being-edited: n, examples: [{uuid, reason}] (first 20)},
   skipped-private: n}],
 note: "pass these block-ids with dry-run false to delete them"}
```

`would-delete` lists at most 100 UUIDs across the call (the apply's cap), filled page by page in request order. `total` is the full count, `listed` the number listed. When `total` is above `listed`, the note says to run again after the apply. Other blank-looking blocks (value blocks, display types and so on) are not reported. The tool text says only plain blank leaves are candidates.

**Step 4: apply (`dry-run: false`, `block-ids` required).**

1. Outside the transaction, the same page resolution runs, then `block-ids` is checked for shape: 1 to 100 UUIDs, no duplicates, each one naming an entity. A bad entry answers 400 or 404 naming `block-ids[i]`.
2. Inside one `atomic-write! conn creator false :delete-blocks`, on the transaction's connection, every listed block is re-read and re-judged against the full predicate. It must also have its `:block/page` on one of the resolved pages. The first failure throws a refusal carrying status 409 (the same shape `check-labels!` uses, so `rejecting` answers it), naming the entry: `block-ids[3]: no longer blank (it has text)`, `block-ids[1]: has children`, `block-ids[4]: referenced`, `block-ids[2]: being edited in the app`, or `block-ids[5]: not on a listed page`. Nothing is written.
3. When every block passes, `outliner-core/delete-blocks!` runs **once** with all of them: one transaction, one tx id, `outliner-op :delete-blocks`.
4. Then `broadcast-change!`, `confirm-removed!` (500 naming survivors) and the answer `{deleted, t, pages: [{page, uuid, deleted, remaining-blocks}]}`.

A block that became blank after the dry run is never deleted, because it isn't listed. A block that stopped being blank refuses the call. A guessed or invented id can only ever delete a genuinely blank leaf on a named page.

### 3.5 Tool A connector: `delete_blank_blocks`

The tool is generated from `deleteBlankBlocks`. Alongside it:

- `ANNOTATIONS`: `DESTRUCTIVE_IDEMPOTENT`.
- `FIRST_LINES`: see section 4.
- `DELETE_RULES`: `delete_blank_blocks: { when: (args) => (bodyOf(args)?.["dry-run"] === true ? null : "deletes blank blocks") }`. A `write-no-delete` token can dry-run but not apply, and is refused before any sync request. A `read` token is refused by scope.
- `DRY_RUN_TOOLS`: `delete_blank_blocks: "body"`.
- `readable.ts`: a target line naming the pages and the number of block ids.
- `SNAPSHOT_PLAN`: the before-snapshot is a `getBlocks` read of exactly the apply's `block-ids` (uuid, page, parent, order, title), so the pre-read mirrors the write (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`). It is size-capped as other snapshots are. A dry run takes no snapshot.

## 4. Tool contract

**`delete_blank_blocks`** (new, generated, `DESTRUCTIVE_IDEMPOTENT`)

- First line (95 characters): `Delete empty leaf blocks from up to 20 pages: dry-run first, then pass the block ids it listed.`
- Input: `{graph, body: {page-ids: string[1..20] (UUID, title or YYYY-MM-DD), dry-run?: boolean (default false), block-ids?: string[1..100] (required unless dry-run is true)}, reason}`.
- Dry-run output: as in section 3.4, step 3.
- Apply output: `{deleted, t, pages: [{page, uuid, deleted, remaining-blocks}]}`.
- Errors, each naming the entry and the reason:
  - 400: a malformed, duplicate or over-cap entry in `page-ids` or `block-ids`; an unknown body field; a whiteboard, tag, property or Private page; an apply with no `block-ids`.
  - 404: a page or block not found.
  - 409: an ambiguous title (with candidates); an E2EE graph; a listed block that is no longer blank, has children, is referenced, is being edited or is not on a listed page.
  - 422: a page or call over the scan bound.
  - 500: blocks `confirm-removed!` found still present.
- Under a `write-no-delete` token: the dry run is allowed, the apply is refused by the connector.

**`get_sync_status`** (new, hand-written, `READ`)

- First line (96 characters): `A graph's sync state: latest t, last write, block and page counts, clients online, index status.`
- Input: `{graph}`.
- Output: `{graph, t, last-written-at (ISO or null), last-op, block-count, page-count, counts-include-private, e2ee, checksum (stored or null; never recomputed), clients: {connected, users, own, others, editing}, semantic: {status, indexed-blocks, indexed-at, index-t, behind-by, error} | null, semantic-note?}`.
- It never returns an email, name, user id, editing block UUID or token.

**Text to update in each PR:** the tool's openapi description (patch) and the connector tool description; `connector_help` (the deletes paragraph and the `write-no-delete` list for PR 2, a status line for PR 1), with a test that every count it states comes from the implementation's constants (`docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md`); `tools-manifest.json` via `npm --prefix connector run update:manifest`; README §11.8; and the Logseq skill note in the PR body.

## 5. Cost on the Free plan

**Tool A, per call** (a cleanup is a dry run plus an apply, so two calls):

- Worker requests: 1 front request and 1 DO subrequest. The apply adds 1 `getBlocks` subrequest for the audit snapshot.
- D1: 0 rows for the tool itself. The audit log writes 2 rows at the start, then reads 1 and writes 1 at the finish: about 3 written and 1 read per call.
- DO SQLite: one `tx_log` insert per apply.
- DO CPU: a walk of at most 10,000 blocks, and `referrer-ids` only for blank candidates (at most 100 on an apply). This is expected to be tens of milliseconds and is **unverified** until the bench in section 8, run on the release bundle at the caps, against the DO's 30 s CPU limit (`docs/solutions/cost/durable-object-cpu-limit-on-free.md`). The front Worker only forwards, well inside 10 ms.
- Per day, at a generous 50 cleanups (100 calls): about 300 D1 rows written and 100 read, 250 Worker requests. No Workers AI neurons and no Vectorize writes. Deleted blocks reach the semantic cron as ordinary deletes.

**Tool B, per call:**

- Worker requests: 1 front request and 1 DO subrequest. No Vectorize `describe()`.
- D1: `semantic_state` by primary key (1 row) and the existing `counts` query (about one row per graph in `semantic_state`, about 5), plus the read audit (`recordRead`, 2 written). About 6 read and 2 written. A test pins these from D1 `meta` (`docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`).
- DO: 2 `sync_meta` reads and 1 `tx_log` read by primary key, then the counts: `list-pages`, `private-ids` and one pass over `:block/page` datoms. That is O(entities), estimated at 5 to 20 ms for 50,000 entities and **unverified** until benched at 100,000.
- Per day, at 200 calls: about 1,200 D1 rows read, 400 written and 400 Worker requests.

Both tools together stay under 1% of every Free cap: 100k Worker requests, 5M D1 rows read, 100k written and 10k neurons a day.

## 6. Safety

- **Nothing outside the predicate is deleted.** Apply deletes only listed ids that pass the full predicate inside the transaction. A blank block with children is never a candidate, so `delete-blocks!` never takes descendants.
- **Nothing wider than shown.** An apply needs ids. Ids come from a dry run (or are refused unless they are genuinely blank leaves on named pages) (`docs/solutions/connector/two-step-edit-applies-what-it-showed-and-audits-with-it.md`).
- **One transaction, one tx id**, read back with `confirm-removed!` (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). The handler runs after `handle` seeds the max order key, as every semantic write does.
- **The block being typed in is kept.** The editing check reads the presence atom. It is only as fresh as the client's last `presence` message, so it is best-effort. The in-transaction re-check is the real guard against text typed after the dry run.
- **Private.** Private pages are refused by name. Private blocks are counted, not listed. The count shows that private content exists on the page. That is acceptable for an owner-only tool, and the tool text says so.
- **E2EE.** Tool A refuses, because titles are ciphertext. Tool B works and reads no titles.
- **Tokens.** `write-no-delete` tokens can dry-run Tool A but not apply it. `read` tokens can call Tool B only.
- **Presence exposure (brief).** Presence identifies a user by JWT claims only: user id, email, username and name, plus an optional editing block UUID. It carries no device, platform or client kind, so the tool can't say "desktop" or "mobile", and says so. Tool B returns counts only. On a shared graph another member shows up as a number in `users` and `others`, never by name or email, and their editing block is never named. No token, header or JWT content is returned. A test searches the JSON for the fixture's user id, email and name.

## 7. Risks

- **Several non-adjacent leaves across pages in one `delete-blocks!`.** The test replays the `tx_log` on a client copy and compares block order (REVIEW.md *Sync*). If it misbehaves, the fallback is one `delete-blocks!` per page inside the same `atomic-write!`, still one tx id.
- **Allow-list drift.** A new built-in attribute on plain blocks (a future stamp, or a leftover `:block/collapsed?`) would make every blank block look non-blank. That is safe but makes the tool useless. The pinned test on both graph origins catches it.
- **Upload-path schema drift** (`docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`). The predicate reads attributes from datoms, not entity cardinality, and runs on an upload-path fixture.
- **The count's CPU on a large graph.** If the bench at 100,000 entities is over budget, the fallback is a count memoised by `t` in the DO, cleared by snapshot upload and `admin/reset` (the cost proposal's idea), or omitting the counts past a bound with `counts: "omitted"`.
- **Stale `editing-block-uuid`.** A client that crashed without clearing it keeps a blank block protected until its socket closes. Safe, named in the tool text.
- **Today's journal.** Deleting its only blank block leaves it empty, and the app may add one back on open.
- **Patch numbers.** 0055 and 0056 depend on PRs 59 to 74 merging first, and are renumbered on rebase.
- **Claude skipping the dry run.** An invented id is refused unless it is a blank leaf on a named page.

## 8. Testing

Each regression test is seen to fail before its code, and the PR quotes the failure.

**Upstream (`deps/db-sync`, through `handle-http` and the real outliner, run by `scripts/check.sh --upstream`):**

PR 1 (`getSyncStatus`):

- `t`, `last-written-at` and `last-op` follow a write.
- `last-written-at` is null on a graph uploaded with no `tx_log` row at its `t`.
- The counts leave out hidden, recycled and Private pages and blocks. On an E2EE fixture, `counts-include-private` is true.
- `clients` come back right on a DO constructed from socket attachments only (simulated wake), with two users, one of them editing.
- The JSON holds no user id, email, name or block UUID (a string search).
- A spy shows no checksum recompute.

PR 2 (`deleteBlankBlocks`):

- **The predicate.** One fixture page holds: an empty leaf; a whitespace-only leaf; a zero-width-space leaf (kept); a blank parent with a child (kept, not lifted, listed); an empty Task; empty blocks with a user property, a heading, and each of Code, Math and Quote; a property value block and a closed-value choice; a pre-block; a `((ref))` to and an embed of an empty block (kept, `referenced`); an empty leaf under a Private block (`skipped-private`); a recycled block; a blank leaf a socket attachment marks as editing (kept); and a blank leaf carrying only Claude's stamps (deleted, graft). Run on a server-created graph and on an upload-path graph.
- **Dry run writes nothing:** `t` is unchanged.
- **Apply** with the dry run's ids writes one `tx_log` row with one tx id and `:delete-blocks`. A replay of the log on a client copy gives the same block order.
- **Refused applies,** each naming `block-ids[i]` with nothing written: an id given text between dry run and apply (409); an id given a child (409); an id on an unlisted page (409); a guessed non-blank id (409); no `block-ids` (400).
- **Page refusals:** not found, ambiguous, duplicate after resolution, whiteboard, Private, E2EE (409), 21 pages, over the scan bound (422). Each selector form (UUID, title, journal date) is tested (REVIEW.md *A new input form or refusal reaches every site*).
- `confirm-removed!` read-back.
- **Release bundle:** `scripts/release-query-check.mjs`, and a Node bench of both handlers at the caps (10,000 blocks scanned; 100,000 entities counted), reported separately.

**Connector (vitest pool-workers):**

- Each tool's first line is at most 100 characters.
- PR 2: the generated schema; under `write-no-delete`, a dry run passes and an apply is refused before any fetch; the audit snapshot holds exactly the apply's `block-ids`.
- PR 1: `get_sync_status` folds the semantic state in and computes `behind-by`; it returns `semantic: null` without semantic config and is registered without it; D1 rows read and written are pinned from `meta`; `semantic_index_status` output is unchanged.
- The `tools-manifest.json` check, and the `connector_help` count-claims test.

There are no live writes. An optional live dry run of Tool A, and a live Tool B call, use only alias `test`.

## 9. Rollout and verification

Each PR:

1. Add the patch (`add-upstream-patch`), then `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream`.
2. Add the connector side (`add-connector-tool`) and run `npm --prefix connector run update:manifest`.
3. Run `scripts/check.sh --upstream` on HEAD. The PR names the commit, quotes each test's failure before the fix, and repeats what the gate skipped.
4. Merge to main, which deploys.
5. After the deploy, call `get_sync_status` on `test`, or run a dry run of `delete_blank_blocks` on a scratch page in `test`, and compare it with `list_page_blocks`.

## 10. Out of scope

- Lifting the children of a blank parent, or merging blank runs.
- Deleting blank-looking value blocks, display-type blocks, headings or pre-blocks.
- A graph-wide sweep (all pages) in one call.
- Device or client-kind detection, which would need a client change to the presence message.
- Recomputing or diagnosing checksums.
- Per-user presence detail, or naming who is editing.
- Changing `deleteBlocks` to refuse on references (a separate item, if wanted).

## 11. Open questions for the owner

1. **Two PRs, `get_sync_status` first.** Is that order right, or do you want the cleanup tool first?
2. **The apply needs block ids, and `dry-run` defaults to false like every other tool.** A call can't delete without the ids a dry run listed. Do you want a one-step "just clean it" mode instead, which would delete whatever is blank at that moment and give up the "only what was shown" guarantee?
3. **What counts as blank.** Empty Code, Math or Quote blocks, empty headings and empty blocks carrying a property are kept. Should any of these be cleaned too?
4. **Today's journal.** It is allowed, with the block you are typing in protected. Would you rather exclude today's journal outright?
5. **Caps.** 20 pages and 100 deletions per call, with a 2,000-block bound per page. Are these right for how you'll use it?
6. **`own` versus `others` clients.** Is it useful to separate your own connections from other members', and is it acceptable that `others` shows that someone else is connected to a shared graph, as a count only?
7. **Counts on E2EE graphs** include Private content, flagged with `counts-include-private`. Is that acceptable, or should the counts be omitted there?
