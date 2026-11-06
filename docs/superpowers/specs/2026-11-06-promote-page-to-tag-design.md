# Promote a page to a tag: design

Date: 2026-11-06
Issue: Connector #16 (promote an existing page to a tag), with the empty-page 500 folded in from the old item 19 and item 26 (Problem 2, acceptance 2)
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0026 applied. This work is patch 0027.
Branch: stacked on Phase 1 (PR #37, not merged), after item 26 (patch 0026)

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Give Claude one explicit way to turn an existing page into a tag, keeping everything that already points at it, and stop the server answering 500 when a page's tags are set to Tag.

1. Add `promote_page_to_tag`: the page keeps its UUID, title, blocks, properties and every reference, gains the Tag class (and a `:db/ident`), loses the Page class, and can optionally extend other tags in the same call.
2. Refuse, up front and with nothing written, journals, built-ins, properties, pages that are already tags, namespaced pages, and a title another tag already uses.
3. Point `create_tag`'s 409 for an existing page, and `connector_help`, at the new tool.
4. Turn the 500 from `tags = Tag` on a page into a 400 that names the new tool, with a regression test that fails without the fix on the real handler.

Acceptance (issue):

1. Promoting a referenced page keeps its blocks, properties and every reference.
2. The result works as a tag in Tags and as an inline `#Tag`.
3. Journals, built-ins, properties and existing tags are refused, and nothing is written.
4. `create_tag`'s 409 for an existing page, and `connector_help`, point at this tool.
5. (Folded from items 19 and 26.) An empty page can be turned into a tag through the connector without a server error, and the 500 when setting an empty page's tags to Tag has a regression test that fails without the fix, run against the real handler.
6. Contract: tool description, `connector_help`, `tools-manifest.json`, README §11.8 and the Logseq skill note in the PR body are updated.
7. Errors name the entry and reason; a rejected promotion writes nothing; a dry run writes nothing.

## 2. Context

**What exists today.** Item 11 (patch 0011) made `createTag` refuse a title that a page, journal, tag or property already uses, with a 409 from `title-taken-response` (`worker/handler/semantic.cljs:1289`). Before that, upstream's `createTag` turned a same-titled page into a tag as a side effect. So since item 11 there is no way through the connector to make "Recipe" a tag without losing the page's blocks and references. The only remaining route is `set_block_property` (or `update_page`) with `tags` set to Tag, which answers HTTP 500. The owner hit this on an empty page, Restaurant, during the item 26 backfill.

**How the app does it.** The page menu's "Convert to tag" calls `convert-page-to-tag!` (`.upstream/src/main/frontend/handler/db_based/page.cljs:37`). That refuses a title a tag already has, a namespaced page (one with `:block/parent`) and a built-in, then invokes `:thread-api/convert-page-to-tag` (`.upstream/src/main/frontend/worker/handler/property.cljs:306`). Its transaction, `convert-page-to-tag-tx` (`:296`), is two steps:

- `db-class/build-new-class` with the page's `:block/uuid`, `:block/title` and `:block/created-at`. That upserts onto the same entity a unique `user.class/...` `:db/ident` and `:block/tags :logseq.class/Tag`. `build-new-class` lives in `deps/db` (`class.cljs:211`), which db-sync loads. It throws a user-facing ex-info when the title can't become an ident.
- `[:db/retract page-id :block/tags :logseq.class/Page]`.

It is transacted with `:outliner-op :save-block`. The wrapper is in the frontend worker, which db-sync does not load, so patch 0027 copies the two-line tx (section 3.3).

**Probable cause of the 500 (to be proven in stage 1).** Setting `:block/tags` to Tag through `set-block-property!` adds Tag to the entity but never gives it a `:db/ident`. A Tag-tagged entity without an ident fails graph validation, which the handler does not catch as a refusal. This is a hypothesis. The build's first stage reproduces the 500 against the real handler and quotes it before any fix is written (section 8). If the cause turns out to be elsewhere, the refusal in 3.7 moves to the confirmed site.

**What patch 0026 gives us.** `validate-tag-schema` (`:2491`) with `extends-refusal` (`:2477`) refuses an `extends` that names a built-in tag the app hides from its extends picker (`ldb/extends-hidden-tags`: Tag, Page, Journal, Property, Query, Template and others), the tag itself, or a tag that already extends it. `write-tag-schema!`, `expected-tag-schema` and `verify-tag-schema!` write and read back a tag's parents. `atomic-write!` (`:1401`) runs a call as one transaction with one tx id, and `dry-run-conn` (`:1160`) runs it on a throwaway copy. `handle` (`:3540`) already seeds the process-wide max order key before every handler.

**Learnings that shape this design.**

- `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`: a handler that transacts directly skips the guards the app runs first, so the app's guards in `convert-page-to-tag!` are copied too.
- `docs/solutions/api/read-hid-built-in-properties.md`: check the read path before trusting a write. The read-back in 3.5 re-reads the tag the way `getTag` and `listTags` do.
- `docs/solutions/api/qualified-ident-path-params-404.md`: path parameters are decoded by the router and re-encoded when forwarded (patch 0016).
- `docs/solutions/api/validate-final-state-apply-in-order.md` and `docs/solutions/api/one-error-for-every-failure.md`: validate everything first, name each refused field with its reason, then write once.
- `docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`: one call is one transaction with one tx id.
- `docs/solutions/testing/stubbed-outliner-hid-block-placement.md` and `docs/solutions/testing/untested-rules-survive-mutation.md`: tests run the real outliner, and each guard is mutated to show a test fails.

## 3. Design

**Approach (call).** One new route and one new handler in patch 0027, which copy the app's own conversion and guards, reuse 0026's tag-schema helpers, and read the result back. The generic `tags = Tag` path is closed with a 400 that names the new tool, so the conversion happens in exactly one place. The connector gets the tool from the vendored OpenAPI with no hand-written handler; its change is text.

Rejected:

- Letting `tags = Tag` convert silently (item 11 removed hidden conversions; one explicit tool is easier for Claude to choose and for the owner to audit).
- Re-adding the conversion to `createTag` when a page holds the title (the same hidden conversion, and `create_tag` would mean two things).
- A full snapshot of child ids, ref holders and property pairs compared after the write (Design 2). The write is one atomic transaction on the same entity, so counts plus O(1) entity checks catch an outliner change on an upstream bump at a fraction of the code to keep in step. The tests check identity of blocks and references directly.

### 3.1 Patch 0027 layout

- `worker/handler/semantic.cljs`: new `pages-promote-to-tag` handler and its helpers (`promotion-refusal`, `promote-tx`, `verify-promotion!`), the `tags = Tag` refusal in `prepare-property-value` (`:957`), the hint in `title-taken-response`, and the new handler added to `e2ee-gated-write-handlers` (`:3488`).
- `worker/routes/semantic.cljs`: the route, its OpenAPI summary and description, and the `dry-run` query parameter (the same `dry-run-parameter` `deleteTag` uses).
- `test/logseq/db_sync/semantic_promote_page_to_tag_test.cljs`: new, real outliner on a real conn.

### 3.2 Route

`POST /api/v1/graphs/:graph-id/pages/:page-id/promote-to-tag`, handler `:semantic/pages-promote-to-tag`, operationId `promotePageToTag`, scope `logseq/write`, rate class `:write`. It is dispatched with the tag handlers in `handle-capture-and-tags` (`:1759`) so it can use 0026's helpers.

- `page-id` is resolved as the other `pages/:page-id` routes resolve it (`find-visible-entity`, so a UUID; hidden entities don't match). Path parameters are re-encoded as in patch 0016.
- Body: `{extends?: [tag selector]}`. Any other key is refused (`unknown field X`). An empty body is fine.
- Query: `dry-run=true` (call: the flag convention `deleteTag` and `deletePage` use, see section 11).

### 3.3 Validate everything, then write once

**Validate** against `@conn`. Every refusal is a 400 or 409 naming the field and reason, and all refusals are collected and joined with `; ` (the first refusal per field kept, as 0026 does). Nothing is written if any is found.

- `page-id`: no visible entity: 404 `page-id: no page <id>`.
- Refused kinds, each 400 `page-id: "X" (<uuid>) is ...`:
  - a journal: `is a journal; journals can't become tags`
  - a built-in (`ldb/built-in?`): `is built in`
  - a property: `is a property`
  - recycled (`:logseq.property/deleted-at`): `is in the Recycle bin`
  - namespaced (`:block/parent`, including a Library parent): `is namespaced under Y` (the app refuses these because the class ident and the namespace would disagree)
  - anything that isn't a plain page (`page?` and `ldb/internal-page?`, so not a whiteboard or asset): `is a <kind>, not a page`
- Already a tag (`tag?`): 409 `page-id: "X" is already a tag (<uuid>); use update_tag to change it`.
- Title conflict: a visible tag other than the page with the same title ignoring case (`title-holders` filtered to `tag?`): 409 with `title-taken-response`'s body shape, naming that tag and its UUID.
- `extends` goes through `validate-tag-schema` with the page as `tag`, so `extends-refusal` gives 0026's messages: `extends 0: Tag is a built-in tag that other tags can't extend`, `extends 0: Recipe can't extend itself`, `extends: name at least one tag`, and an unknown selector `extends 1: no tag "Fod"`.
- E2EE graphs: the handler is in `e2ee-gated-write-handlers`, and on an E2EE graph it refuses with 400 `promote_page_to_tag isn't available on an E2EE graph` (the ident would be derived from ciphertext). This matches how 0026 refuses `choices` on E2EE. It is listed on the backlog, not silently allowed.
- The ident: `build-new-class` is called during validation (it reads only the db), and its user-facing throw on a title that can't become an ident is caught and answered 400 `page-id: "X" can't become a tag: <reason>`, never 500.

**Snapshot** (counts only, call): the number of the page's child blocks (`ldb/get-block-full-children-ids`) and the number of `:block/_refs` holders.

**Write** in one `atomic-write!` (`dry-run?` honoured, `:outliner-op :save-block`, one tx id):

1. Transact the class tx and the Page retraction, copied from `convert-page-to-tag-tx` with a comment naming the source file and line. The page's other `:block/tags` (anything but Page) are left as they are.
2. When `extends` is given, `write-tag-schema!` against the page's db id. Without `extends`, the tag extends Root as any new tag does.

The max order key is already seeded by `handle`; the promotion creates no blocks, so it takes no new key.

### 3.4 Dry run

`dry-run=true` runs validation and the same write on `dry-run-conn`, then answers the 200 body (section 4) with `dry-run: true`, including the ident the tag would get and the counts. The real graph is untouched (call: the same shape as the real answer plus a flag, as the delete endpoints do, rather than a `would` wrapper).

### 3.5 Read-back

`verify-promotion!` re-reads the entity by UUID and, through `unverified!`, answers 500 naming what is missing unless:

- the UUID and title are unchanged;
- `:block/tags` holds Tag and not Page;
- `:db/ident` is set (its exact value is reported, not guessed: `build-new-class` de-duplicates);
- the child block count and the `:block/_refs` holder count equal the snapshot.

It then calls `verify-tag-schema!` with `(expected-tag-schema page parents nil)` when `extends` was given. The checks are O(1) on the entity plus two counts that are O(page blocks + references), in the DO. A 500 here means the outliner changed under us on an upstream bump; the write is atomic, so it can't be partial.

### 3.6 Response

200 with `tag-detail-response` (`uuid`, `ident`, `title`, `extends`, `properties`) plus `promoted: {blocks: n, references: n}`. `references` counts blocks and pages that link the page. They stay page references (`[[Recipe]]`); the conversion does not tag them. The description and help say so.

### 3.7 Closing the 500

In `prepare-property-value`, when `property-ident` is `:block/tags` and a resolved value is `:logseq.class/Tag`, and the target entity doesn't already hold Tag, the value is refused: `tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>` (for a new block or page, without the UUID clause). Every path goes through this one point: `set_block_property`, `batch_set_block_property` (via `batch-entries-error`, so it reads `entry N: tags: ...`), `update_page` tags, and tree inserts with properties. Nothing is written, and each path answers 400.

Only Tag is refused (call). Page and Journal stay allowed, because the outliner refuses removing a private tag (outliner `property.cljs:69-98`), so a replace-style `tags` write on a page legitimately sends Page back. Re-sending Tag on an entity that is already a tag is allowed for the same reason. Property is left to section 11.

If stage 1 shows the 500 comes from somewhere else, the fix moves to the confirmed site and this section is updated in the plan's as-built note.

### 3.8 createTag's 409

`title-taken-response` gains an optional hint. When `createTag`'s holders include a plain page (not a journal, tag or property), the message adds `; to make page "X" a tag keeping its blocks and references, call promote_page_to_tag with page-id <uuid>`, and that page's `existing[]` entry carries `promote: true`. `createPage`'s 409 is unchanged.

## 4. Tool contract

**Added: `promote_page_to_tag`** (generated from `promotePageToTag`).

- Inputs: graph alias; `page-id` (the page's UUID); body `extends?: [tag UUID | ident | title]`; query `dry-run?: boolean`.
- Output 200: `{uuid, ident, title, extends: [{uuid, title}], properties: [{uuid, title, ident}], promoted: {blocks, references}}`, plus `dry-run: true` on a dry run.
- 400, naming the field and reason: `page-id: "X" (<uuid>) is a journal; journals can't become tags`, `... is built in`, `... is a property`, `... is in the Recycle bin`, `... is namespaced under Y`, `... is a whiteboard, not a page`, `page-id: "X" can't become a tag: <reason>`, `extends 0: Tag is a built-in tag that other tags can't extend`, `extends 0: X can't extend itself`, `extends: name at least one tag`, `unknown field Z`, and the E2EE refusal.
- 409: the page is already a tag (UUID given; points at `update_tag`), or a tag already uses the title ignoring case (UUID given).
- 404: no visible page with that id.

**Changed.**

- `create_tag`: the 409 when a page holds the title names `promote_page_to_tag` and the page's UUID, and that `existing[]` entry has `promote: true`.
- `set_block_property`, `batch_set_block_property`, `update_page` and tree inserts with `tags` holding Tag (on an entity that isn't a tag): HTTP 500 before, now 400 `tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>` (`entry N:` in batches), nothing written.

**Connector.**

- HINTS entry in `connector/src/tools/semantic.ts` for `promote_page_to_tag`: "Turns an existing page into a tag in place: its UUID, blocks, properties and references are kept, and links to it stay links (they aren't tagged). Run with dry-run first on a page with many references and show the user the counts. Refuses journals, built-ins, properties, namespaced pages and existing tags. Setting a page's tags to Tag is refused; use this instead." The `create_tag` hint gains the 409 pointer.
- `connector_help`: the line at `handwritten.ts:21` gains "when create_tag is refused because a page has the title, promote_page_to_tag converts that page".
- `KB_INDEX_WRITE_TOOLS` in `connector/src/tools/kb-index.ts` gains `promote_page_to_tag`, because the page's kind changes.
- `npm --prefix connector run update:manifest`.
- README §11.8, and the Logseq skill note in the PR body: use `promote_page_to_tag` instead of `create_tag` plus moving blocks, dry-run first on a well-linked page, and never set `tags` to Tag.

## 5. Cost on the Free plan

- **Worker requests:** one front-Worker request and one sync DO request per call, as `update_tag`. Promotions are rare manual actions; even 20 a day is 40 requests, 0.04% of the 100k cap.
- **D1:** 0 rows read. At most the existing KB-index dirty mark on success; none on a refusal or dry run.
- **Workers AI and Vectorize:** 0 neurons and 0 new dimensions. The page's blocks keep their UUIDs and content, so the semantic indexer doesn't re-embed them; only the page entity appears in the changes feed, at most one row for the cron.
- **CPU:** the front Worker only forwards. In the DO: one `:avet :block/name` range for the title conflict, a walk of the page's children and its `:block/_refs` for the counts, done twice (snapshot and read-back), and doubled on a dry run. The `tags = Tag` refusal is one ident comparison per resolved tag value.
- **Response size:** a tag detail plus two counts, a few hundred bytes.

## 6. Safety

- **Nothing half-written.** Every check runs before the write; the write is one `atomic-write!` with one tx id.
- **No silent success.** `verify-promotion!` re-reads the entity and the counts and answers 500 naming what is missing.
- **Errors name the field and reason** for every path in 3.3, and the batch refusal names its entry.
- **The app's guards are kept** (duplicate tag title, namespaced, built-in), with journal, property, recycled, non-page and existing-tag refusals added.
- **Behaviour change, stated.** `tags = Tag` is now a 400 on every write path where it was a 500. It is called out in `connector_help` and the skill note.
- **E2EE graphs** are refused outright and the gap is on the backlog.
- **Path parameters** are re-encoded as in patch 0016.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The copied `convert-page-to-tag-tx` drifts from the app's on an upstream bump (for example, a default `extends` or new attributes) | A comment naming the source file; a test asserting the invariants of upstream's `convert-page-to-tag-updates-worker-db-atomically`; the read-back 500 |
| The cause of the 500 is assumed, not proven; non-empty pages may fail differently | Stage 1 reproduces and quotes it on the real handler before any fix; the refusal moves to the confirmed site if needed |
| Refusing Tag as a value breaks a caller that relied on it | That path errored or left an entity with no ident; the skill note and `connector_help` say so; Page, Journal and re-sending an existing Tag stay allowed |
| `build-new-class` throws on an odd title | Caught during validation and answered 400 naming the page; tested |
| Owners expect linked blocks to become objects of the tag | They don't, as in the app; the description, help and response say "references kept, not tagged" |
| A page held by a node property restricted to Page becomes out of class after promotion | Reported as an open question (section 11); not refused |
| Clients replaying an ident added to an existing entity | It is what the app itself syncs, in one tx; test 7 checks one tx id |

## 8. Testing

All db-sync tests are in `semantic_promote_page_to_tag_test.cljs` and run the real `semantic` handler on a graph seeded with `build-db-initial-data`, as 0011 and 0026 do. No stubbed outliner. Each is first seen to fail on 0026 alone, and the failure is quoted in the PR.

**Stage 1, failing tests before any fix.**

1. An empty page "Restaurant"; `set_block_property` `tags = Tag` answers 500 (quoted). After the fix: 400 with the `promote_page_to_tag` message, and `(:max-tx @conn)` and the datom count are unchanged.
2. The same through `batch_set_block_property` as entry 1 of 2: the message starts `entry 1:`, and entry 0 is not written either.
3. Through `update_page` tags, on a page: refused the same way. `update_page` with `tags [Page, X]` still succeeds, and re-sending Tag on an existing tag still succeeds.

**Stage 2, promotion.**

4. A page "Recipe" with nested blocks, a user property value, a backlink from another page's block, and a node-property value pointing at it. Promotion answers 200. The UUID, title, `created-at`, child block ids, ref holder ids and property values are unchanged; tags hold Tag and not Page; the ident is `user.class/Recipe...` and is the one in the response; `promoted` gives the right counts.
5. `listTags` includes it and `getTag` answers it. A block inserted afterwards titled "Pasta #Recipe" has `:block/tags` Recipe and is listed by `listTagObjects` (acceptance 2).
6. An empty page promotes with 200 (acceptance 5).
7. Every datom from a promotion carries one tx id.
8. `extends [Food]` sets the parent and reads back through `getTag`. `extends [Tag]`, `extends [itself]` and `extends []` are refused with 0026's messages.
9. Each refusal (journal, built-in page, property, existing tag, namespaced page, Library child, recycled page, whiteboard, a tag with the same title in different case, an unknown field, a missing page, an E2EE graph, a title `build-new-class` rejects) asserts the status, that the message names the reason, and that `(:max-tx @conn)` and the datom count are unchanged.
10. `dry-run=true` answers the ident and counts with `dry-run: true`, and `(:max-tx @conn)` is unchanged.
11. `createTag` on the page's title answers 409; the message names `promote_page_to_tag` and the page's UUID, and `existing[0].promote` is true. The hint is absent when the holder is a tag, journal or property.
12. Read-back wiring: `with-redefs` on the transact step to drop the ident gives a 500 naming the missing ident. This stubs only the write, to prove `verify-promotion!` runs; every other test uses the real path.
13. Mutation check: deleting each guard in 3.3 and the Tag refusal in 3.7 in turn makes a test fail.

**Connector (vitest-pool-workers).** The tool is in the generated set and in `tools-manifest.json` with the hint in its description; `connector_help` mentions `promote_page_to_tag`; a successful call marks the KB index dirty and a refusal does not; 400 and 409 texts pass through unchanged.

## 9. Rollout and verification

1. Build patch 0027 on 0026 with the `add-upstream-patch` skill, stage 1 first; vendor the regenerated `openapi.json` and `semantic_api_tools.mjs`; update the connector text with `add-connector-tool`.
2. `scripts/check.sh --upstream` on HEAD; the PR names the commit and repeats what was skipped. CI runs upstream's db-sync suite including the new tests.
3. The PR is stacked on Phase 1 (PR #37) and item 26, and merges after them. Merging to main deploys.
4. After deploy, on the live graph:
   - promote Restaurant (empty) and see it under Tags in the app (acceptance 5);
   - dry-run a referenced page, then promote it, and check its backlinks and blocks in the app and that `#Name` tags a new block (acceptances 1 and 2);
   - `create_tag` with a page's title and see the pointer (acceptance 4).
5. Update README §11.8, and give the Logseq skill note in the PR body.

## 10. Out of scope

- Promoting on E2EE graphs (backlog).
- Turning a tag back into a page (demotion).
- Turning references to the page into tag holders.
- Promoting namespaced pages, or several pages in one call.
- Changing the page's title as part of the promotion.
- A two-client sync test of the promotion; upstream's suite covers the app's conversion.

## 11. Open questions for the owner

1. **Dry-run flag placement.** This design takes `dry-run` as a query flag, as `deleteTag` and `deletePage` do. 0026 kept query flags on `update_property`; the bulk endpoints take it in the body. Keep the query flag?
2. **Property as a tag value.** Only Tag is refused in 3.7. Setting a page's tags to Property likely fails the same way. Refuse it too (pointing at `create_property`), or leave it until it is seen?
3. **Pages held by Page-restricted node properties.** After promotion such a page no longer has Page, so the app's picker would treat it as out of class for that property. Should the response count those holders (`out_of_class`), should the call refuse with a 409 unless acknowledged, or is it fine as it is?
4. **Linked blocks.** Links to the page stay links and don't become objects of the tag, as in the app. Do you want an option to tag them as well, or is that a separate job?
5. **Pages by title.** `page-id` takes a UUID, as the other page tools do. Would you like it to take an exact title too, refusing when more than one page matches?
6. **E2EE.** The call is refused on an E2EE graph. Is that acceptable for now, or do you use an E2EE graph where you need this?

## As built

- **Where the 500 came from (2, 3.7).** Not graph validation of a tag with no ident. The outliner's own guard refuses Tag as a tags value before anything is written: `validate-tags-property` calls `disallow-node-cant-tag-with-private-tags` (`deps/outliner/src/logseq/outliner/validate.cljs:257`), which throws `Can't set tag with built-in #Tag`, and `setBlockProperty` and `batchSetBlockProperty` answered that throw as a 500. A page with blocks failed the same way as an empty one. The tree inserts (`insertBlockTree`, `batchInsertBlockTrees`) already answered it as a 400, but with the outliner's bare text, no entry path and no pointer. The refusal stays in `prepare-property-value` (`tag-value-refusal`), as designed, because every write path resolves its tags there before the outliner runs.
- **`update_page` is not a tags path (3.7).** `updatePage` takes only `title` and ignores any other field, so it can't set tags. A page's own tags are written through `setBlockProperty`, `batchSetBlockProperty`, or a `batchInsertBlockTrees` entry's `properties` (on an existing page, or one the call creates); Stage 1 tests those four paths and tree-insert nodes.
- **Re-sending Tag on an existing tag is refused too (3.7).** The design kept it allowed because it assumed it worked. It didn't: the same outliner guard answered 500 (and, under `isResetExistingValues`, `Can't remove private tags: :logseq.class/Tag.`). It is now a 400 ending `<uuid> is already a tag`, with nothing written.
- **Wording.** The refusal is prefixed with the property as other value refusals are, so it reads `Tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>` (`entry N: Tags: …` in a batch, `blocks[1]: Tags: …` or `entries[0]: Tags: …` for inserts, where the prefix is the key as the caller wrote it). The UUID clause is given only when the target is an existing page; a new block or page, or an existing block that isn't a page, gets `…; use promote_page_to_tag`.
- **Page is allowed, but only additively.** Sending Page back on a page through a write that adds tags works. A write that replaces a page's tags (`setBlockProperty` with a list, or `isResetExistingValues` with a list) still answers 500 `Can't remove private tags: :logseq.class/Page.`, as before this patch; that is a separate defect, left for the backlog.
