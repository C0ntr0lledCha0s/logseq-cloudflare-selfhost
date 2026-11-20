# Change feed, schema export and deeper health checks: design

Date: 2026-11-20
Issue: item 50 on the tracker ("Change feed, schema export and deeper health checks"), split from item 40's acceptance 5. Areas: patch, connector, semantic, docs.
Branch: `feat/changes-schema-health`, at `c7bb092` ("docs(spec): query-fence-makes-query-block"), stacked on `feat/query-blocks` (item 49, PR 72), `feat/tool-routing-hints` (PR 71), PR 70 and the bug-fix stack PRs 59 to 69. It is 0 commits behind `feat/query-blocks` and 2 behind `origin/main`, as expected for a stack.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0049. This work adds patches **0051, 0052 and 0053** (section 3.1 explains the numbering).
Builds on: patch 0013 (`getGraphHealth`, `graph_insights.cljs`), patch 0014 (`listBlockChanges`, the indexer's feed), patches 0017, 0021, 0024 and 0037 (the health checks added since), patch 0041 (`orphan-choices`), patch 0039 (`datalog_query`, its `scan-cap` and `private-ids`), `docs/solutions/cost/durable-object-cpu-limit-on-free.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`, `docs/solutions/connector/per-item-summary-blows-result-cap.md`, `docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md` and `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`.

The design panel chose the "minimal" proposal: three read-only routes in the Durable Object, one small patch each, surfaced as generated tools. No ideas were grafted from other proposals. Decisions marked **(call)** were made while writing this spec; the ones most worth a second look are in section 11.

**What was checked for this spec, at `c7bb092`.** A throwaway test namespace (`zz-changes-repro-test`, not committed, removed after the run, with `test_runner.cljs` restored) drove the real handler through `sync-handler/handle-http` against a fresh graph in `.upstream`, using `scripts/upstream-test.sh .upstream zz-changes-repro`. A page A held three blocks made by the outliner, the third titled `see [[<uuid with no entity>]]`; a page B was empty. Its output:

```
REPRO health broken-refs 400 {"error":"invalid checks"}
REPRO changes route 404 {"error":"not found"}
REPRO move 200 block updated-at bumped? false source page bumped? true target page bumped? true
REPRO tag via property 200 {"updated":true,...} block bumped? true page bumped? false
REPRO heading via property 200 {"updated":true,...} block bumped? true page bumped? false
REPRO title edit 200 block bumped? true page bumped? true
REPRO broken ref stored title "see [[b2839da8-f7c6-4b7f-9119-c80ca7b1bcf6]]" ghost entity? false
```

So, on HEAD:

1. `get_graph_health` has no `broken-refs` check (`invalid checks`), and there is no change-feed route (404). These are the gaps, not bugs.
2. A block whose `[[uuid]]` target has no entity is stored and kept as it is, with nothing to report it.
3. **`:block/updated-at` is not a complete "what changed" signal** (found while checking, not in the brief). `move_blocks` does not bump the moved block's `updated-at`, but bumps both pages'. A property set (`block/tags`, `logseq.property/heading`) bumps the block's but **not** its page's. A title edit bumps both. So neither "pages with updated-after" nor "blocks with updated-after" alone gives the full picture, and the feed (3.3) reads both and says which one it saw.

Everything else in section 2 was read from source at `c7bb092` (`.upstream/deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`, `graph_insights.cljs`, `handler/datalog.cljs`, `routes/semantic.cljs`, `deps/db/src/logseq/db/frontend/schema.cljs`, `connector/src/tools/spec.mjs` and `handwritten.ts`), not run. The DO CPU figures in section 5 are estimates until the bench runs.

## 1. Goal

Give the owner's weekly review and daily digest three reads they lack: what changed since a point in time, grouped by page; one call that lists the graph's tags and properties with types, choices and usage counts; and two more health checks, broken refs and tagged objects missing their tag's properties. All three are read-only and stay inside the Free plan's budgets.

Acceptance (the brief):

1. The weekly review uses the change feed and the extended health checks.
2. Each read stays within the Free plan's D1 and CPU budgets, counted in the PR.
3. This spec is committed and the lane stops for owner approval (no build).
4. The spec states what already exists and adds only what is missing.
5. The spec weighs the three parts separately and says whether to split them.
6. The spec counts Durable Object CPU per request and any D1 rows for each read.
7. The spec notes the patch numbering clash with item 49 (0050 vs 0051).
8. The owner's graph is never written; no graph name or page UUIDs are copied into any file.

## 2. Context: what already exists

**Patch 0014, `listBlockChanges`.** The semantic indexer's feed (`GET /semantic/block-changes`). It walks the tx log by graph `t` plus an epoch, lists changed blocks in UUID order, is not grouped by page and takes no time-of-day `since`. It answers 410 (`changes since that point are no longer available; list again without since`) when more than `max-feed-txs` (5,000) txs or `max-feed-changes` (20,000) changes have piled up. It is in `EXCLUDED_OPERATIONS` in `connector/src/tools/spec.mjs`, so Claude can't call it. Its cursor is a `t`, not a time, so "since Monday" can't be asked of it. This design reuses its helpers where they fit, not its route.

**`updated-after` and `created-after`.** `list_pages`, `search_graph`, `list_tasks`, `list_tags` and `list_properties` take them as filters, and `get_graph_health` uses them only to narrow its two page checks. They narrow a list; they don't say what changed, whether a block was created or edited, or how many. The repro shows that a page's `updated-at` misses property sets on its blocks, and a block's misses moves.

**`get_activity_log`** lists the connector's own writes (and deletes), not edits made in the app.

**`get_graph_health`** (patch 0013, extended by 0017, 0021, 0024, 0037 and 0041). `health-checks` in `handler/semantic.cljs` (line 5201) is `orphan-tags`, `orphan-properties`, `duplicate-titles`, `pages-without-summary`, `pages-without-tags`, `mismatched-choice-values` and `orphan-choices`. `mismatched-choice-values` already reports a value that is another property's choice (reason `another-propertys-choice`, `graph_insights.cljs` line 234), so the brief's "choice values that belong to another property" is covered and **this design leaves that check unchanged**. No check reports broken refs, and none reports tagged objects that lack their tag's properties. None of the current checks leaves out Private content (no `private-ids` or `hidden-id?` call in the health handler).

**`list_properties`** returns type, cardinality, choices and node classes. **`list_tags`** returns uuid, ident and title; `get_tag` adds extends and properties one tag at a time. Neither gives usage counts. **`kb_index`** covers pages, not the schema.

**`datalog_query`** could answer some of this, but its `scan-cap` (`handler/datalog.cljs` line 54, 20,000 datoms) stops any whole-graph count on a real graph with a 422. So every part here is a DO-side handler, not a connector-side query.

**Tools today.** `tools-manifest.json` lists 57 tools.

## 3. Design

### 3.1 Shape and numbering

Each part is a GET handler in the Durable Object, in its own patch, so the owner can drop one without the others. All three go in one PR, one build stage and one commit per patch. They write nothing, so they need no dry run or read-back. The front Worker only forwards them.

**Numbering (call).** Item 49's spec (PR 72, which this branch is stacked on) plans patch 0050, so these are:

| Patch | Part | Priority |
|---|---|---|
| `0051-semantic-health-broken-refs-missing-tag-properties.patch` | (c) two new health checks | must build |
| `0052-semantic-changes-since-feed.patch` | (a) change feed | must build |
| `0053-semantic-graph-schema-export.patch` | (b) schema export | optional |

If item 49 lands without a patch, or PR 72 is dropped or reordered, renumber to 0050 to 0052 before merge; otherwise `scripts/fetch-upstream.sh` applies them in the wrong order or a number is reused.

All three share only `private-ids` (from `datalog.cljs`, built once per request) and the existing `paginate-by`. They refuse E2EE graphs with 409, as health does, and name the parameter in every 400.

### 3.2 (c) Patch 0051: two new health checks

Built first, since it is the smallest and the review needs it most. `graph_insights.cljs` gets two functions; `health-checks` and the `getGraphHealth` description and `checks` parameter text gain two entries.

**`broken-refs`.** One pass over the `:block/title` datoms (`:aevt`). A regex finds the `[[uuid]]` and `((uuid))` refs in each stored title (the repro shows refs are stored as `[[uuid]]`). For each target:

- no entity for the uuid: reason `missing`;
- an entity with `:logseq.property/deleted-at`: reason `in-recycle-bin`.

Holders in `private-ids` (Private, or in the Recycle bin) are skipped, so a block in the bin that points at another block in the bin is not listed. Each item is the holder's response (uuid, kind, title, page) plus `target-uuid` and `reason`, sorted by holder uuid then target, through `paginate-by`. Title text only: refs held as property values are ref-typed and can't point at a missing entity (a retract removes the datom), so they aren't scanned.

**`missing-tag-properties`.** For each user class, the user properties in its `:logseq.property.class/properties` plus those of the classes it extends (`class-lineage-fn`), read from `:eavt` datoms, never entity sets (the upload-path gotcha). Left out:

- properties with a `:logseq.property/default-value` (they always read as set);
- built-in classes and built-in properties, so Task's Status, Scheduled and Deadline never count.

For each visible, non-private object tagged with the class, a property counts as missing when the object has no `:eavt` datom for it or holds Logseq's empty placeholder (as `mismatched-choice-values` already detects it). One item per holder and tag: holder response, `tag {uuid, title}` and `missing [{ident, title}]`, in holder-uuid order.

Both run in the default all-checks call. Limits, cursors and the `created-after` / `updated-after` behaviour match the other checks: the time filters still narrow only the two page checks.

### 3.3 (a) Patch 0052: the change feed

New route `GET /api/v1/graphs/{graph-id}/changes`, operationId `listChangesSince`, so the generated tool is `list_changes_since`.

**Parameters.**

- `since` (ms since the epoch, required). A missing, empty or non-digit value answers 400 `invalid since` and never falls back to a full listing (`an-optional-narrowing-argument-must-refuse-not-widen`). ms, because `created-after` already takes ms; the tool text gives an example.
- `until` (ms, default now). Must be greater than `since`: `until must be after since`.
- `limit` (pages, default 50, 1 to 200, the existing pagination options).
- `blocks-per-page` (default 10, 1 to 50).
- `cursor`.

**How it reads.** `d/index-range db :block/updated-at (inc since) until`. The attribute is indexed (`schema.cljs` line 86, `:block/updated-at {:db/index true}`), so the read costs the number of changed entities, not the size of the graph. If more than `max-changes` (20,000, the same figure as `scan-cap` and `max-feed-changes`) datoms fall in the window, it answers 422 `too many changes in that window (N); pass a later since or an until`, naming the count. It then:

- drops `private-ids`, hidden ids and built-in entities;
- maps a property value block to its owner block (so a property set shows as a change on its block, which the repro shows is where the stamp lands);
- groups by `:block/page`; a page that is itself in the range (the repro shows a move bumps both pages but not the block) is its own group with `page-changed true` and possibly no blocks.

**Response.** `{since, until, pages:[{page:{uuid, title, kind}, latest-updated-at, page-changed, created, updated, blocks:[{uuid, change: "created"|"updated", updated-at, snippet}]}], recycled, next-cursor?}`.

- `change` is `created` when `:block/created-at` > `since`, else `updated`.
- `snippet` is `context-snippet` (first line, 80 characters, `handler/semantic.cljs` line 2324) of the block's title, with `[[uuid]]` refs shown as titles as the delete context shows them.
- `blocks` holds at most `blocks-per-page` entries, newest first, and `created` and `updated` are always complete counts (`per-item-summary-blows-result-cap`).
- `recycled` counts entities given `:logseq.property/deleted-at` in the window (read from that attribute's datoms, filtered by its value). They are not listed under their page, since they are now private.

**Order and paging.** Pages by `latest-updated-at` descending, then page uuid. The cursor encodes `[until, last-key]`, so paging stays stable while the graph keeps changing; a cursor whose `until` differs from the call's answers 400 `cursor belongs to another until`. A caller that wants "everything since the last run" stores this run's `until` and passes it as the next `since`.

**What the feed can't see**, said in the tool text:

- Permanent deletes leave nothing to report; `get_activity_log` lists the connector's own deletes.
- A move shows as `page-changed` on both pages, not as a change on the moved block (repro).
- Any other outliner op that bumps neither the block nor its page is invisible. The build tests which of the connector's write tools bump which stamp (section 8) and the tool text names the ones that don't.

### 3.4 (b) Patch 0053: the schema export

New route `GET /api/v1/graphs/{graph-id}/schema`, operationId `getGraphSchema`, so the generated tool is `get_graph_schema`.

**Parameters.** `sections` (comma list of `tags`, `properties`; default both; any other value is `invalid sections`), `built-in` (default false; true adds built-in tags and properties), `limit` (1 to 200 per section), `cursor` (needs exactly one section: `cursor needs exactly one section`, the health pattern).

**Tags.** Each item is the existing tag-detail response (uuid, ident, title, extends, properties) plus `object-count`: the `:avet :block/tags` datoms for the class, minus `private-ids`. The private set is built once per request, so there is no per-datom `hidden-id?` walk.

**Properties.** Each item is the existing property response (uuid, ident, title, type, cardinality, choices, classes) plus:

- `value-count`: the `:aevt` datoms for its ident, minus private holders;
- `usage-count` on each choice: the `:avet` datoms whose value is the choice;
- `used-by-tags [{uuid, title}]`: the classes whose `class/properties` hold it, read from `:eavt` datoms.

Items in title-key order through `paginate-by`. `list_properties` and `list_tags` stay unchanged.

**Why one call and not counts on `list_properties` / `list_tags` (call).** Adding counts to the two list tools would cost a whole-graph count on every list call, including the many that only need a title or ident, and would still leave the reviewer stitching two calls and `get_tag` per tag. One opt-in call keeps the cost where it is asked for. If the owner prefers counts on the list tools behind a flag, (b) splits into its own item (section 11).

### 3.5 Weighing the three parts

| Part | Need | Overlap with what exists | Cost | Recommendation |
|---|---|---|---|---|
| (c) health checks | Broken refs and missing tag properties are invisible today | none (`mismatched-choice-values` stays) | one title pass and an eavt walk | build first |
| (a) change feed | The digest can't say what changed, and updated-after on pages misses property sets (repro) | `listBlockChanges` has the data but not the shape; filters narrow but don't report | an index range, bounded by the window | build |
| (b) schema export | Drift review wants all of it in one place | `list_properties` gives most fields; counts are new | counts over tag and property datoms | optional; split if the owner prefers |

They share no code beyond `private-ids` and `paginate-by`, so splitting costs nothing. The recommendation is one PR with (c) and (a), and (b) in the same PR only if the owner approves it here.

### 3.6 Connector and docs

No hand-written connector code. Re-vendor (`scripts/vendor-upstream-api.sh .upstream`) so the generator picks up the two GET tools, which get read-only annotations. Then:

- `connector/src/tools/handwritten.ts` `connector_help`: the `get_graph_health` sentence (line 59) gains the two checks, and one sentence each for `list_changes_since` and `get_graph_schema`.
- `npm --prefix connector run update:manifest`: 57 to 59 tools (58 if (b) is dropped).
- README §11.8: the three reads, and the 0013 bullet in section 4's list gains the two checks.
- The tool texts state each cap by naming the server constant's value as the code sets it, generated or checked by a test, not typed by hand (`count-claims-in-tool-text-must-come-from-the-implementation`).
- The PR's **Logseq skill note**: the weekly review and daily digest call `list_changes_since` with `since` set to the previous run's `until` (and store the new `until`), and call `get_graph_health` with the two new checks. This is how acceptance 1 is met: the review lives in the owner's skill, so the PR supplies the note for the owner to apply.

## 4. Tool contract

**CHANGED `get_graph_health` (`getGraphHealth`).** `checks` also accepts `broken-refs` and `missing-tag-properties`; both run by default.

- `broken-refs` item: `{uuid, kind, title, page-id, page-title, target-uuid, reason: "missing"|"in-recycle-bin"}`.
- `missing-tag-properties` item: `{uuid, kind, title, page-id, page-title, tag: {uuid, title}, missing: [{ident, title}]}`.
- Each check gives a complete count and `next-cursor`, as today. `invalid checks` still refuses any other name.

**NEW `list_changes_since` (`listChangesSince`, `GET /api/v1/graphs/{graph-id}/changes`).**

- Inputs: `graph`, `since` (ms, required), `until?` (ms, default now), `limit?` (pages, 1 to 200, default 50), `blocks-per-page?` (1 to 50, default 10), `cursor?`.
- Output: `{since, until, pages: [{page: {uuid, title, kind}, latest-updated-at, page-changed, created, updated, blocks: [{uuid, change, updated-at, snippet}]}], recycled, next-cursor?}`.
- Refusals: 400 `invalid since`, `invalid until`, `until must be after since`, `cursor belongs to another until`; 422 `too many changes in that window (N); pass a later since or an until`; 409 on E2EE graphs.

**NEW `get_graph_schema` (`getGraphSchema`, `GET /api/v1/graphs/{graph-id}/schema`).**

- Inputs: `graph`, `sections?` (`"tags,properties"`, default both), `built-in?` (default false), `limit?` (1 to 200), `cursor?` (exactly one section).
- Output: `{tags: {count, items: [{uuid, ident, title, extends, properties, object-count}], next-cursor?}, properties: {count, items: [{uuid, ident, title, type, cardinality, choices?: [{uuid, title, value, usage-count}], classes?, value-count, used-by-tags: [{uuid, title}]}], next-cursor?}}`.
- Refusals: 400 `invalid sections`, `cursor needs exactly one section`; 409 on E2EE graphs.

**Unchanged:** `list_properties`, `list_tags`, `get_tag`, `kb_index`, `listBlockChanges` (still excluded from the tools) and `mismatched-choice-values`.

## 5. Cost on the Free plan

**D1:** 0 rows read and 0 written per call beyond the connector's existing per-request auth lookup. These are generated GET tools, not in `LOGGED_READS`, so they write no audit row. No cron work, no migration, the indexer is untouched.

**Worker requests:** 2 per call (front Worker and Durable Object), as for every semantic read. A weekly review is about 1 schema call, 1 or 2 health calls and 1 to 4 change-feed pages, under 20 requests a week; a daily digest is 2 to 4 a day. Negligible against 100,000 a day.

**Front Worker CPU (10 ms):** forwarding only, well under 1 ms. **Vectorize and Workers AI:** none.

**Durable Object CPU per request** (estimates; the build replaces them with bench figures from the release bundle, multiplied by about 1.65 for Cloudflare as `durable-object-cpu-limit-on-free.md` records):

| Read | Work | Estimate at 5,000 pages |
|---|---|---|
| `private-ids` (shared, once per request) | measured in `datalog.cljs` | about 47 ms |
| `broken-refs` | one regex pass over about 50,000 titles | tens of ms |
| `missing-tag-properties` | tagged objects x expected properties, eavt lookups | under 20 ms |
| `list_changes_since` at the 20,000-change cap | index range, grouping, snippets for at most limit x blocks-per-page = 10,000 blocks | under 100 ms |
| `get_graph_schema` | counts over user tag and property datoms | under 50 ms |
| default all-checks health call | existing checks plus the two new ones | under 300 ms |

All are two orders of magnitude below the DO's roughly 30 s limit. They are sized to keep sync responsive, since a long read holds up the graph's WebSocket clients. Per `per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, a new `scripts/bench-graph-insights.mjs` (with a `.test.mjs` that checks shape and counts, never times) runs each check and route on the release bundle at 5,000 and 20,000 pages and at the 20,000-change cap, reporting first-call and warm times. The PR records the figures and the per-call totals.

## 6. Safety

- **Read-only.** Three GET routes with `logseq/read` scope and `:read` rate class. Nothing is written, so there is no dry run, read-back or order-key concern.
- **Refuse, don't widen.** A bad `since`, `until`, `sections` or cursor answers 400 naming the parameter; the feed never falls back to a full listing.
- **Bounded.** The feed refuses windows over 20,000 changes with the count; every list is capped per item with complete counts.
- **Private content.** All three new reads drop `private-ids` (Private and the Recycle bin). The existing health checks don't; that gap is sent to the backlog, not widened here (section 7, risk 4).
- **E2EE.** 409, as health does: titles are ciphertext.
- **The owner's graph.** Never written. Tests use fixtures and `sync.example.com`; no graph name or page UUID appears in any file.

## 7. Risks

1. **Large responses.** The default health run now returns 9 checks. A digest that passes a large limit can near the connector's result cap. Every list is capped and keeps complete counts, and the tool text recommends `checks=` for a narrow run.
2. **`missing-tag-properties` can be noisy.** On a graph that uses tag properties loosely it can list most tagged objects. Built-ins and properties with a default are excluded. Section 11 asks whether to add a `tags` filter now.
3. **Upload-path schema drift.** A graph uploaded from the app can store `class/properties` or `closed-value-property` with another cardinality. The new code reads datoms, never entity sets, and each test runs once on an upload-path graph.
4. **Private content in old checks.** The new checks filter private holders and the old ones don't, so one health call mixes both behaviours. Sent to the backlog.
5. **`updated-at` semantics.** The repro shows a move bumps pages but not the block, and a property set bumps the block but not its page. Other ops may bump neither. The feed reads both and the tool text says what it can't see; the tests pin each write tool's behaviour.
6. **Cursor boundary.** The cursor pins `until`. A digest that doesn't store `until` as its next `since` can miss or double-count edits at the boundary. The skill note says this.
7. **Patch numbering.** 0051 to 0053 assume item 49 holds 0050 (section 3.1).
8. **Dates.** `since` is ms; Claude must convert. The tool text gives an example, and a non-digit value is refused rather than misread.
9. **`[[uuid]]` regex.** If titles can hold a ref form other than `[[uuid]]` and `((uuid))` (for example a tag written `#[[uuid]]`), the check must match it too. The build reads `db-content` in upstream for the stored forms (a guess that these two are all; not checked).

## 8. Testing

Each test runs the real handler (`request!` through `sync-handler/handle-http`) on a real conn from `sqlite-export/create-conn`, as `semantic_index_health_test.cljs` and `semantic_display_type_test.cljs` do, and once on an upload-path graph (`semantic_uploaded_graph_schema_test` style). Run with `scripts/upstream-test.sh .upstream <ns>` while building, `scripts/check.sh --upstream` as the gate.

**Seen to fail first** (quote in the PR). From the repro: `checks=broken-refs` answers 400 `invalid checks`; `GET /semantic/changes` answers 404 `not found`; `GET /semantic/schema` is expected to answer 404 too.

a. **`broken-refs`** (additions to `semantic_index_health_test.cljs` or a new `semantic_graph_health_refs_test.cljs`): a `[[uuid]]` with no entity (`missing`), a `((uuid))` whose target is in the Recycle bin (`in-recycle-bin`), a private holder (left out), a valid ref (not listed), and paging with a cursor.
b. **`missing-tag-properties`**: a user tag with two user properties; one object has both, one lacks one, one holds the empty placeholder. An inherited property through `extends`; a property with a default (not reported); a Task with no Deadline (not reported); a private holder (left out).
c. **`list_changes_since`** (new `semantic_changes_since_test.cljs`): a block created, a block edited, a block edited before `since` (not listed); a property set on a block, reported on the block and its page's group (the repro's case); a property value block, reported as its owner; a move, reported as `page-changed` on both pages; a private page (left out); a block moved to the Recycle bin (counted in `recycled`). Grouping and order across two pages; the `blocks-per-page` cap with complete counts; a cursor pinned to `until` (an edit made between pages does not shift page 2); the refusals (missing `since`, `since` ≥ `until`, a cursor with another `until`, the 422 at the cap with the count named, 409 on E2EE). One test per connector write tool records which stamps it bumps, so the tool text's list of blind spots comes from a test.
d. **`get_graph_schema`** (new `semantic_graph_schema_test.cljs`): `object-count` excludes private objects; a choice's `usage-count`; a property's `value-count`; `used-by-tags`; `built-in=false` hiding built-ins; a cursor with two sections refused; an unknown section refused.
e. **Routes and OpenAPI**: operationIds, parameters, and the 400, 409 and 422 responses in the spec.

**Connector.** vitest: the two generated tools register with read-only annotations and their exact names; `connector_help` mentions them and the two checks; the tools-manifest check passes after `update:manifest`.

**Release bundle.** `scripts/release-query-check.mjs` and the new bench run on the bundle from `scripts/build.sh`, since the checks call into `datalog.cljs` (`private-ids`), where Closure renaming has broken things before.

Run `scripts/check.sh --upstream` on the final commit, name that commit in the PR, and repeat what it skipped.

## 9. Rollout and verification

1. Merge to main deploys the sync server and the connector. No migration, no switch.
2. After deploy, the owner runs `get_graph_health` with `checks=broken-refs,missing-tag-properties` on their graph and reads the counts. If `missing-tag-properties` is noisy, that answers section 11 question 2.
3. The owner runs `list_changes_since` with `since` set to a week ago and compares it with what they remember editing, including a move and a property change.
4. The owner applies the skill note, and the next weekly review and daily digest use the feed and the new checks (acceptance 1).
5. Record the bench figures and the measured DO CPU of a default health call on the owner's graph (from the Workers analytics, as `durable-object-cpu-limit-on-free.md` describes) under an As built section of this spec.

## 10. Out of scope

- Changes to `mismatched-choice-values` (it already covers another property's choice) and `orphan-choices`.
- Filtering Private content in the existing health checks (backlog).
- Exposing `listBlockChanges` as a tool, or changing it.
- Counts on `list_properties` and `list_tags`.
- Reporting permanent deletes made in the app (nothing is left to read).
- A per-tag filter on `missing-tag-properties` (unless the owner asks, section 11).
- Repairing broken refs; this only reports them.
- Writing to the owner's Logseq skill (the PR supplies the note).

## 11. Open questions for the owner

1. **Split (b)?** The schema export is ranked optional. Build all three in one PR, or ship (c) and (a) and move (b) to its own item, perhaps as counts on `list_properties` behind a flag?
2. **`missing-tag-properties` noise.** It reports every user property a tag lists, unless the property has a default. If you use tag properties as optional fields, it may list most objects. Add a `tags` filter (or a "required" marker) now, or wait for the first run?
3. **What counts as a change.** The repro shows a move bumps only the pages and a property set only the block. The feed reports both, a move as `page-changed` with no block. Is that enough for the digest, or do you want moves named per block (which needs the tx log, like `listBlockChanges`, and costs more)?
4. **Private in old checks.** The new checks leave out Private and Recycle bin content; the old ones don't. Send that to the backlog as proposed, or fix it in this PR?
5. **`since` in ms.** Keep ms to match `created-after`, or also accept an ISO date (`2026-11-16`) read in the Worker's `TIMEZONE`?
6. **Patch numbers.** These are 0051 to 0053 on the assumption that item 49 takes 0050. If you drop or reorder PR 72, they become 0050 to 0052.
7. **Spec file name.** The brief named this file `2026-11-20-changes-schema-health-design.md`; the stage that wrote it was told `2026-11-20-changes-schema-health-checks-design.md`, which is what was used. Rename if you prefer the shorter name.
