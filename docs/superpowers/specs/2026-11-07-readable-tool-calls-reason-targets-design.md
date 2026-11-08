# Readable tool calls: reason, named targets and readable results: design

Date: 2026-11-07
Issue: Connector #17 (readable tool calls: reason on writes, named targets, readable results). Labels: enhancement, usability, safety.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0027 applied. This work is patch 0028.
Branch: stacked on Phases 1 and 2 (PRs #37 and #38, not merged)

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Make a write or delete tool call readable before the owner approves it, and its result readable after. The claude.ai tool-call card shows only the raw arguments, and for writes those are mostly UUIDs. On 2026-11-05 a delete of two blocks showed only two UUIDs. The connector can't change how the card is drawn; it can only change the arguments, the tool descriptions, the annotations and the results.

1. Every write and delete tool takes an optional plain-text `reason`, and `connector_help` asks Claude to fill it.
2. A write can name its page target by title or journal date, and a block-targeted write can carry a `target-label` ("Nov 5th, 2026 > Notes") that the server checks against the real target before it writes anything.
3. Results name what changed: page title, breadcrumb and a short snippet beside each UUID.
4. Dry-runs of the large operations (`delete_blocks`, `delete_page`, `move_blocks`, `batch_move_blocks`, `batch_insert_block_trees`) say in words what would happen.
5. Every tool carries correct `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations, so claude.ai asks for approval on the calls that can lose data.

Acceptance (issue):

1. Every write and delete tool accepts an optional plain-text `reason`, and `connector_help` asks Claude to fill it.
2. A write can name its target by page title or journal date wherever a page UUID is accepted. A block-targeted write accepts an optional `target-label` (e.g. "Nov 5th, 2026 > Notes") checked against the resolved target. A mismatched label writes nothing and says why.
3. Write, move and delete results list the page title, breadcrumb of parent blocks and the first ~80 characters of each affected block, alongside the UUIDs. `verbose=false` stays compact but titles are not optional.
4. A `delete_blocks` dry-run lists each block's page, breadcrumb, snippet and descendant count. `delete_page`, `move_blocks` and batch writes also give a readable dry-run summary (pages, snippets, child and reference counts).
5. All tools carry correct `readOnlyHint`, `destructiveHint` and `idempotentHint` annotations.
6. The logseq-kb skill note is drafted in the PR body so the owner's skill fills `reason` and `target-label` on every write.
7. The title and breadcrumb lookup is a shared helper that item 28 (audit log) can reuse.
8. Errors name the entry and reason. Contract text is updated: tool descriptions, `connector_help`, `tools-manifest.json`, README §11.8.
9. Stays inside the Free-plan request and CPU budget: prefer connector-side work from data already in responses, and count extra upstream calls per request.

## 2. Context

**What the tools return today.** The write responses carry counts and UUIDs only: `DeleteBlocksResponse`, `MoveBlocksResponse` and `InsertedBlocksResponse` have no page title, breadcrumb or text. So acceptance 3 can't be met from data already in responses (acceptance 9's preference); the data has to come from the server.

**How targets are found.** `find-entity` and `find-visible-entity` (`worker/handler/semantic.cljs:323` and `:327` on the patched tree) take a UUID only. No write accepts a title or a journal date.

**How annotations are set.** The generated tools take their annotations from upstream's generator, purely by HTTP method (`connector/vendor/semantic_api_tools.mjs:89-93`): GET is read-only, DELETE is destructive, GET/PUT/DELETE/HEAD are idempotent, and every tool is `openWorldHint: true`. That marks several data-losing calls as non-destructive: `batch_delete_block_property` (POST), `update_property` with `choices.retire` or `convert_values` (PATCH), `update_block` (PATCH, overwrites content), `batch_set_block_property` (POST) and `refresh_refs` (POST, rewrites refs when applying). The hand-written tools (`handwritten.ts`, `kb-index.ts`, `semantic-search.ts`, `assets.ts`) set their own, inline.

**Dry-runs that exist.** `delete_page` (query `dry-run`), `delete_blocks`, `batch_move_blocks` and `batch_insert_block_trees` (body `dry-run`), plus `update_property`, `delete_property`, `delete_tag` and `promote_page_to_tag`. `move_blocks` and `delete_block` have none. Dry-runs run on `dry-run-conn` (`semantic.cljs:1199`), a throwaway copy, and answer counts.

**What can be reused.** Patch 0014 (block-changes feed) already has `feed-text` (a block's text with references shown as titles) and `feed-ancestors` (the ancestors below the page, outermost first), at `semantic.cljs:3517` and `:3520`. `block-response` (`:71`) does the same reference-to-title conversion for reads. `atomic-write!` (`:1448`) runs a handler's writes as one transaction with one tx id.

**Where the connector hooks in.** `mcpHandler` (`connector/src/mcp.ts:70`) passes `onSuccess(tool, alias)` to each tool group; it touches the sign-in record and marks the KB index dirty. Item 28 (audit log) needs the same hook to carry the reason and the targets.

**Learnings that shape this design.**

- `docs/solutions/api/one-error-for-every-failure.md`: each refusal names its entry and reason.
- `docs/solutions/api/qualified-ident-path-params-404.md`: the router decodes path parameters, so a title containing `/` must be forwarded encoded (patch 0016 does this); title selectors need a test for it.
- `docs/solutions/api/read-hid-built-in-properties.md`: check the read path before trusting a write. The move read-back is checked against `get_page_outline`.
- `docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`: the label check and the write are one transaction with one tx id.
- `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`: the handler, not the outliner, must enforce its own guards.
- `docs/solutions/testing/stubbed-outliner-hid-block-placement.md` and `untested-rules-survive-mutation.md`: tests run the real handler and outliner, and the label rules are mutation-tested.
- `docs/solutions/cost/d1-reads-from-indexer-scans.md` and REVIEW.md *Cost*: count rows and calls per request.
- REVIEW.md *Destructive operations keep their guards*: the `acknowledge-*` flags and existing dry-runs stay as they are.

## 3. Design

**Approach (call).** Everything that decides *what* gets changed happens on the sync server, inside the same `atomic-write!` and db snapshot as the write: title and date resolution, the `target-label` check, and the context of a deleted block (which only exists before the delete). A connector-side pre-read would leave a gap between the check and the write, and would cost one to four extra upstream calls per write. The connector adds what doesn't need the graph: `reason`, the annotations, and the plain-text summary.

Rejected: a connector-only layer that wraps the generated write tools and reads context with extra `get_blocks` calls (no patch, but a check-then-write gap on `target-label`, title resolution through `search_graph` that sees only the top results and so can miss a duplicate title, a guessed journal title format instead of `:block/journal-day`, a `WRITE_CONTEXT` table that must mirror every upstream write, and tests against recorded shapes rather than the real handler). Taken from it: the guard test that every tool has an annotations and context entry, and degrading a failed context read after a completed write to "context unavailable". A lighter server design that labels only addressed entities and reuses 0014's walker is the basis for 3.2 and 3.5; its looser label rule (no minimum segment length, title before date) is not taken.

### 3.1 Patch 0028 layout

- `worker/handler/semantic.cljs`: one new section, placed before the first handler, holding `block-context`, `resolve-page-selector` and `check-target-labels`. `feed-text` and `feed-ancestors` move from 0014's section into it, so the feed and the new helper share one walker. Call sites in the handlers stay small (one call each) to limit conflicts with 0011, 0012, 0026 and 0027 on `bump-upstream`.
- `worker/routes/semantic.cljs`: the OpenAPI document gains the `BlockContext` schema, the `target-label` query parameter, the per-entry `target-label` fields, `delete_blocks`'s `labels`, `move_blocks`'s `dry-run`, and the response fields in section 4.
- Upstream db-sync tests for everything in section 8.

### 3.2 Shared helper: `block-context`

`(block-context db entity)` returns:

```
{uuid, kind ("block" | "page" | "journal"),
 page {uuid, title},
 breadcrumb [up to 5 nearest ancestors below the page, outermost first, each an 80-character snippet],
 snippet  (first line, 80 characters, references shown as titles via feed-text),
 descendants (count, only where the caller asks)}
```

It is pure and reads only the snapshot it is given. For a page, `breadcrumb` is empty and `snippet` is the title. On an E2EE graph titles and text are encrypted, so `page.title`, `breadcrumb` and `snippet` are left out and `e2ee: true` is set; the connector says so in words (risk 6).

**Only addressed entities get a context (call, graft).** A delete gives one per block named in the call, with a descendant count, not one per removed descendant. An insert gives one for the target and a snippet for each top-level inserted block, with its descendant count, not one per node of a 50-block tree. This keeps `verbose=false` results small and still names every block the caller pointed at.

### 3.3 Page selectors: `resolve-page-selector`

Used for every `{page-id}` path parameter, every `target-id`, and `create_task`'s `page-id` **(issue: "wherever a page UUID is accepted")**. In order:

1. A UUID resolves as today.
2. An ISO date (`YYYY-MM-DD`) looks up the journal through one `:avet :block/journal-day` read. If a non-journal page also has that exact title, the call is refused with 409 as ambiguous, so neither silently wins (call).
3. An exact title through the `:block/name` index, then a unique case-insensitive title.

Hidden pages and pages in the Recycle bin are excluded. Several matches answer 409 and list each candidate's UUID and title. No match answers 404 naming what was tried (`page-id: no journal for 2026-11-05 and no page titled "2026-11-05"`). A selector never creates a page; `capture_to_today` and `batch_insert_block_trees`'s create-if-missing keep their own rules. On an E2EE graph a title or date selector is refused with the existing E2EE wording. Titles containing `/` or `%` reach the handler intact because patch 0016 re-encodes path parameters, and a test pins it.

### 3.4 `target-label`

Accepted on the single-target block writes as a query parameter (`insert_block_children`, `insert_block_tree`, `update_block`, `delete_block`, `set_block_property`, `delete_block_property`, `move_blocks` against its `target-id`), as a per-entry field in the batches (`batch_insert_block_trees`, `batch_move_blocks`, `batch_set_block_property`, `batch_delete_block_property`), and as `labels` on `delete_blocks`, an array parallel to `block-ids` (a length mismatch is refused).

**Matching (call).** The label is split on ` > ` and each segment is trimmed.

- The first segment must equal the page title, case-insensitively.
- The remaining segments match, from the last one backwards, the target's own snippet and then its nearest ancestors in order. Ancestors above the topmost segment may be left out, so "Nov 5th, 2026 > Notes" fits a `Notes` block at any depth. A page target takes the page-only form.
- Each such segment must be a case-insensitive prefix of the snippet it matches and at least 3 characters long, unless the snippet itself is shorter, in which case it must equal it. Empty segments are refused.
- A label with more segments than the target has levels is a mismatch.
- As built (review round 2): a block whose first line is empty is named by its page and parent blocks alone, since an empty segment is refused. What a mismatch reports as found leaves out an empty target line, and an empty parent line with the blocks above it, so the found text is always a label that fits. A batch insert entry's `page` given as a YYYY-MM-DD is checked against the journal it names (an existing one, or the title the new journal gets), not the date text.

Every label in the call is checked before any mutation, inside the transaction. Any mismatch refuses the whole call with 409 and writes nothing. The message lists each failing entry with what was given and what was found: `entry 2: target-label "Nov 5th, 2026 > Notes" does not match target "Nov 5th, 2026 > Meeting > Agenda"`. The label is a guard only; it never selects a target.

### 3.5 Context in responses

- **Deletes** (`delete_block`, `delete_blocks`, `delete_page`): `affected` is built from the before-snapshot, with descendant counts from the removed set the handler already computes. After the transaction the server confirms each UUID is gone and lists any that remain under `not-removed` with a 500, so a delete never reports success it didn't have (no silent success).
- **Moves** (`move_blocks`, `batch_move_blocks`): each moved block gets `from` (before-snapshot) and `to` (read back from the db after the transaction) breadcrumbs.
- **Inserts and `capture_to_today`:** `target` holds the page and breadcrumb; each top-level inserted block gets a snippet and descendant count, even when `verbose=false`. The page title is always present.
- **Property writes:** a `target` context per entry.
- **Page and tag writes** (`create_page`, `update_page`, `update_tag`, `create_tag`, property tools): the response already names the title; no context is added (call).

Context read after a committed write (the move's `to`, an insert's target) is computed in a `try`. If it fails, the write stands and the response carries `context: "unavailable"` with the reason, rather than answering an error for a write that happened (graft).

### 3.6 Dry-runs

- `delete_blocks` and `delete_page`: per-block context, descendant and reference counts; for a page also its block count and the first three root snippets.
- `move_blocks` (new `dry-run` query flag, call) and `batch_move_blocks`: `from` and `to` breadcrumbs computed on `dry-run-conn`.
- `batch_insert_block_trees`: per entry, the target context, whether the page would be created, and the block count.

Every dry-run is computed by the server on the throwaway connection, so the summary is what the write would do, not a connector preview. The connector never shows a summary it did not get from the server.

### 3.7 Connector

1. **`src/tools/readable.ts` (new, shared with item 28).** `toAffectedTargets(response)` normalises the server's `BlockContext` fields into typed `AffectedTarget` records, and `summarise(targets)` writes one line each, eliding the breadcrumb to the first and last two segments: `Nov 5th, 2026 > … > Notes > "Call Sam about…" (+3 children)`. It does no fetches.
2. **`reason`.** `buildGraphTools` adds an optional `reason` (plain string, at most 200 characters; longer is refused, not truncated) to every non-read tool's schema, and the hand-written write tools (`save_document`, `save_file_from_url`) add it too. The connector strips it before calling upstream, so it never reaches the server. The result's summary repeats it (`Reason: tidy duplicate notes`), so the owner sees it beside the outcome.
3. **Logging (call, deviates from the issue's note).** The log line stays argument-free and records `reason=yes|no` only, because a reason may quote private graph text and Workers logs are kept outside the owner's control. The full text goes to item 28's owner-only D1 log when that lands.
4. **`onSuccess(tool, alias, {reason, targets})`.** `mcp.ts` widens the hook so item 28 can store the reason and the `AffectedTarget`s. Today's uses (touch, KB-index dirty) ignore the new argument.
5. **Results.** A plain-text summary content item goes first, ahead of the existing JSON item: `Deleted 2 blocks on Nov 5th, 2026: Notes > "Call Sam…" (+3); Notes > "Book flights" (+0). Reason: …`. A dry-run summary starts `Dry run, nothing changed:`.
6. **Annotations.** An explicit `ANNOTATIONS` table in `spec.mjs` replaces upstream's method-derived hints for every generated and hand-written tool (section 4 lists the classes). The build fails if any tool has no entry, and the annotations are written into `tools-manifest.json` so CI checks them as part of the contract.
7. **Context table guard (graft).** Every non-read tool in the manifest is listed in `readable.ts` as either producing context or `no-context` (with the reason, e.g. `create_property`); a tool in neither fails a test.
8. **Contract text.** The guidance on `reason`, `target-label`, title selectors and dry-runs goes once into `connector_help`, not into 25 descriptions, to keep `tools/list` small (graft). Each description gains one short clause naming its new inputs and output fields.

## 4. Tool contract

**`reason` (all write and delete tools).** Optional string, at most 200 characters. Stripped by the connector; repeated in the result summary; not sent upstream.

**Page selectors.** Every `{page-id}` path parameter, every `target-id`, and `create_task`'s `page-id` accept a UUID, an exact page title, or an ISO journal date. Ambiguity answers 409 with the candidates. Refused on E2EE graphs.

**`target-label`.**

| Where | How |
|---|---|
| `insert_block_children`, `insert_block_tree`, `update_block`, `delete_block`, `set_block_property`, `delete_block_property`, `move_blocks` | query `target-label` |
| `batch_insert_block_trees`, `batch_move_blocks`, `batch_set_block_property`, `batch_delete_block_property` | per-entry `target-label` |
| `delete_blocks` | body `labels`, parallel to `block-ids` |

A mismatch answers 409, writes nothing, and names each failing entry with the given and found labels.

**Responses.** `BlockContext` is `{uuid, kind, page{uuid,title}, breadcrumb[], snippet, descendants?, references?, e2ee?}`.

- Deletes: `affected: BlockContext[]`, plus `not-removed` if any UUID survived.
- Moves: `affected[]` each with `from` and `to` breadcrumbs.
- Inserts and `capture_to_today`: `target: BlockContext` and a snippet and descendant count per top-level block, even with `verbose=false`.
- Property writes: `target` per entry.
- `context: "unavailable"` with a reason when a post-write read failed.
- Dry-runs of `delete_blocks`, `delete_page`, `move_blocks` (new flag), `batch_move_blocks` and `batch_insert_block_trees` return the same structures, plus `would-create` and block counts.
- The connector adds a leading plain-text summary content item.

**Annotations (call).**

| Class | Tools | Hints |
|---|---|---|
| Read | every GET, `connector_help`, `list_graphs`, `kb_index`, `semantic_search`, `semantic_index_status`, `read_file`, `list_assets` | read-only, idempotent |
| Destructive | every `delete_*`, `batch_delete_block_property`, `update_page`, `update_block`, `update_tag`, `update_property`, `set_block_property`, `batch_set_block_property`, `refresh_refs`, `promote_page_to_tag`, `batch_insert_block_trees` | destructive; idempotent for deletes and `set_*` |
| Additive write | `create_*`, `insert_*`, `capture_to_today`, `move_blocks`, `batch_move_blocks`, `save_document`, `save_file_from_url` | not read-only, not destructive, not idempotent |

`openWorldHint` is false for every graph tool and true for `save_file_from_url`, which fetches an outside URL. Annotations are static per tool, so `refresh_refs` and `update_property` are destructive even in their harmless modes.

As built (review round 2): `batch_insert_block_trees` moved from additive to destructive (not idempotent), because an entry that names an existing page or block and gives properties replaces that target's values, the same write `batch_set_block_property` makes.

**Internal.** `readable.ts` exports `toAffectedTargets(response)` and `summarise(targets)`. `onSuccess(tool, alias, {reason, targets})`.

## 5. Cost on the Free plan

- **Worker requests:** none extra. Resolution, the label check and context are computed in the sync-server request that does the write.
- **D1:** 0 rows read or written; `reason` is not stored until item 28.
- **Workers AI and Vectorize:** none.
- **Sync-server CPU per call, bounded:** at most 100 addressed blocks × (5 ancestors + 1) entity reads, about 600 datom reads; snippets capped at 80 characters; descendant counts reuse the removed set the delete handler already computes; a title is one `:block/name` index read and a date one `:avet :block/journal-day` read.
- **Connector CPU (10 ms budget):** one extra walk of the JSON and a string join per result, well under 1 ms for 100 entries.
- **Result size:** about 20 KB for a 100-block delete, under the 150 KB cap. `tools/list` grows by about 3 KB (the `reason` and `target-label` fields and annotations), because the guidance lives once in `connector_help`.
- **Per day:** request, row and neuron counts unchanged.

## 6. Safety

- The label check and title resolution run in the same transaction and snapshot as the write, so nothing can change between check and write. A mismatch writes nothing, and the test compares the db datom for datom.
- Batches stay all-or-nothing with one tx id: entry 0 valid and entry 1 mismatched writes nothing.
- A selector never guesses: ambiguity, hidden pages and Recycle bin pages are refused or not found, and an ISO date that is also another page's title is refused.
- Delete context comes from the before-snapshot, and a test asserts it is non-empty, because context read after the delete would be empty and look like success.
- Deleted UUIDs are read back; any that remain are reported.
- The existing guards (`acknowledge-*`, dry-runs, 0011's write guards) are untouched.
- `reason` never reaches the server or the logs; only a yes/no flag is logged.
- Marking `update_*` and `set_*` destructive makes claude.ai ask for approval more often. That is the intended trade, and the skill note says so.

## 7. Risks

1. **Loose labels.** A short prefix could fit the wrong block. Mitigated by the exact page segment, the 3-character minimum, and refusing empty segments; mutation tests pin each rule.
2. **Title selectors on `delete_page`.** Colliding titles could hit the wrong page. Ambiguity is refused with UUIDs and exact matches win, and `connector_help` tells Claude to dry-run any delete named by title.
3. **More approval prompts** from the wider destructive set (section 6).
4. **Titles with `/` or `%`** depend on 0016's re-encoding; a test covers both.
5. **Before-snapshot choice.** Taking delete context after the transaction would give empty context; a test and a mutant guard it.
6. **E2EE graphs** get context without titles or text. The summary says "titles unavailable on an E2EE graph" instead of showing UUID-only lines as if they were complete.
7. **Logging deviation.** Not logging reason text departs from the issue's note; the owner must accept that the full text lives only in item 28's D1 log.
8. **Rebase conflicts.** The patch touches many handlers alongside 0011, 0012, 0026 and 0027. Helpers live in one new section and call sites stay to one line where possible.
9. **Stacking.** Built on unmerged PRs #37 and #38; any change there to these tools' descriptions or the manifest must be re-merged.

## 8. Testing

Each regression test is seen to fail first, and runs the real handler and outliner (no stubs).

**Upstream db-sync tests in patch 0028** (`scripts/check.sh --upstream` and CI):

1. **Label mismatch.** For each single-target write and each batch, a wrong `target-label` answers 409 naming the entry, and the db equals its state before the call datom for datom. Batches: entry 0 valid, entry 1 mismatched, nothing written. `delete_blocks` with a `labels` length mismatch is refused.
2. **Label match** for the page-only form, a multi-segment form, a form that omits upper ancestors, and a target whose snippet is under 3 characters.
3. **Resolution.** Exact title, case-insensitive title, ISO journal date, ambiguous title (409 with UUIDs), a date that is also another page's title (409), hidden and recycled pages (404), titles containing `/` and `%`, and an E2EE graph (refused).
4. **Delete context.** `delete_blocks` real and dry-run results give page title, breadcrumb, snippet with references shown as titles, and descendant count; context is non-empty after a real delete; every UUID is confirmed gone.
5. **Moves.** `from` and `to` match `get_page_outline` before and after; `move_blocks` dry-run leaves the graph unchanged.
6. **Dry-runs.** `delete_page` gives the block count and root snippets; `batch_insert_block_trees` gives `would-create`; the graph is unchanged after both.
7. **Unavailable context.** A forced failure in the post-write context read keeps the write and answers `context: "unavailable"`.

**Connector vitest:**

1. Every manifest tool has an annotations entry; a fake tool with none fails. Expected hints for `batch_delete_block_property`, `update_property` and `update_block` (destructive), the GETs (read-only), and `save_file_from_url` (`openWorldHint: true`).
2. Every non-read tool has a context or `no-context` entry in `readable.ts`.
3. `reason` over 200 characters is refused; a spy on `syncFetch` shows `reason` absent from the body and query.
4. The log line contains `reason=yes` and never the text.
5. `readable.ts` summarises recorded server responses, including breadcrumb elision, the E2EE case and `context: "unavailable"`.
6. `onSuccess` receives the reason and the targets.

**Other checks:** `update:manifest` and the manifest check cover the annotations. Mutation testing flips the label comparison, the 3-character minimum, the ancestor depth cap and the before-snapshot choice; each mutant must be killed.

## 9. Rollout and verification

1. Land patch 0028 with its upstream tests; re-vendor `openapi.json` and `semantic_api_tools.mjs`.
2. Land the connector changes, regenerate `tools-manifest.json`, and run `scripts/check.sh --upstream` on HEAD; the PR names that commit and repeats what was skipped.
3. Merge to main deploys. On the owner's graph, through claude.ai:
   - Insert a block under a journal by date with a correct `target-label`, then with a wrong one, and see the 409 and that nothing was written.
   - Dry-run then run `delete_blocks` on two scratch blocks and check the card and result name their page, breadcrumb and text.
   - Move a block and check `to` against the app.
   - Check claude.ai now asks for approval on `update_block` and `batch_delete_block_property`.
4. Update README §11.8 and `connector_help`, and give the logseq-kb skill note in the PR body: fill `reason` on every write, give `target-label` as "Page > parent > …", dry-run large deletes and moves and show the summary, expect more approval prompts.

## 10. Out of scope

- The audit log itself (item 28); this only provides `readable.ts` and the `onSuccess` payload.
- The interactive preview card with Apply and Cancel buttons (a later item that builds on these dry-runs).
- Changing how claude.ai draws the tool-call card.
- Block selectors by text (the label is a guard, never a way to find a block).
- Titles and snippets on E2EE graphs.
- Dry-runs for `delete_block`, single property writes and page or tag updates.
- Per-call annotations that depend on arguments (MCP annotations are per tool).

## 11. Open questions for the owner

1. **Logging the reason.** The issue's note says the Worker logs the reason. This design logs only `reason=yes|no` and keeps the text for item 28's owner-only D1 log, because reasons may quote private notes. Is that acceptable?
2. **Moves as destructive.** `move_blocks` and `batch_move_blocks` are marked additive, so claude.ai won't always ask before a move. Should moves ask for approval too?
3. **Approval prompts.** `update_block`, `update_page` and `set_block_property` become destructive and will prompt more often. Is that the trade you want, or should only deletes, retires and batch property writes be destructive?
4. **Selectors on reads.** Page titles and dates are accepted on every `{page-id}`, reads included. Would you rather limit it to writes?
5. **ISO date that is also a page title.** This design refuses it as ambiguous. Would you rather the journal win?
6. **Label strictness.** Segments are prefixes of at least 3 characters, and upper ancestors may be left out. Should the label instead have to give the full path from the page?
7. **Insert results.** Only the target and the top-level inserted blocks get context, not every node of a tree. Is that enough for acceptance 3?
8. **`reason` length.** 200 characters, refused if longer. Is that the right limit, and should `reason` ever be required on deletes?
9. **E2EE.** Title and date selectors are refused and results carry no titles there. Do you use an E2EE graph where you need this?

## 12. As built

The result follows the design. These are the places it differs or is more exact. The round 2 notes in sections 3.4 and 4 still apply.

**Patch 0028.**

- The helper section holds more than section 3.1 lists: `block-context`, `confirm-removed!`, `with-context-or-unavailable`, `resolve-page-selector` (with `iso-journal-day`, `visible-pages`, `titled-pages`, `selector-refusal` and `with-page-selector`) and the label helpers (`check-target-labels`, and `check-labels!`, which throws so a write that calls it first inside its transaction changes nothing). `feed-text` and `feed-ancestors` moved into it as planned.
- A move's `from` and `to` are `{page, breadcrumb}` records, not bare breadcrumbs. `to` is read back after the transaction.
- A context read that fails after a committed write answers `context: "unavailable"` with the server's message in `context-reason`.
- A delete UUID that survives answers 500 with `{error, not-removed}`. A hidden or Recycle-bin page counts as removed.
- Selectors never match tag entities, as well as hidden and Recycle-bin pages. On an E2EE graph a title, date or `target-label` is refused with 400, since titles can't be compared. A selector that names nothing answers 404 and lists what was tried; an ambiguous one answers 409 with `candidates` (UUID and title).
- A `delete_page` dry run answers `references`, `blocks` (the blocks on the page, not counting property values) and `roots` (the first three root snippets in page order). A `delete_blocks` dry run adds `references` to each block's context. In a `batch_insert_block_trees` dry run, `would-create` is present only when it is true, not `false` otherwise. Dry runs of `delete_block`, single property writes and page or tag updates stay out of scope.
- The `deletePage` 200 schema is now `anyOf`, because a dry-run body fits both branches.
- Only addressed entities get a context, as designed. `descendants` is given for the blocks a delete names and for each top-level inserted block, and omitted elsewhere.

**Connector.**

- `reason` is trimmed and measured in code points. An empty or all-space reason counts as none, and `reasonGiven` agrees, so the log line says `reason=no`. A reason that isn't a string, or is over 200 code points, is a `ToolError` with status `refused`, raised before graph resolution or any fetch. `registerGraphTools` throws at build if an upstream operation already takes a `reason`.
- The summary is one text item that leads the result, with `Reason: …` as its last line (section 3.7 item 5 gave the reason on the same item but not its position). The server's JSON follows it unchanged.
- `capWriteResult` bounds a write's result. Over the cap, the JSON loses its indentation first, then the summary is cut with a notice that says the write was applied, and only then is the JSON truncated. A summary or cap failure can't fail a call after its write.
- `CONTEXT_TOOLS` maps each tool to a past and present verb for its summary line (`Deleted` and `delete`). `NO_CONTEXT_TOOLS` gives the reason for each tool without context. A manifest test requires every write tool to be in exactly one.
- `tools-manifest.json` records each tool's annotations and `checkManifest` compares them. It records no input schemas, so adding `reason` did not change it. `annotationsFor(name)` throws for a tool with no `ANNOTATIONS` entry, which fails both the manifest build and the Worker.

**Decisions in section 11.** Answers 1, 2 and 5 stand as designed: `reason=yes|no` only in logs, moves additive, and a date that is also a page title refused as ambiguous. Unconfirmed by the owner, so still open for review.
