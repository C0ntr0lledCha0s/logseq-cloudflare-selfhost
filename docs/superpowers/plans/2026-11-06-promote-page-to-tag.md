# Promote a page to a tag: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh --upstream` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can turn an existing page into a tag in place with `promote_page_to_tag`: the page keeps its UUID, title, blocks, properties and every reference, gains the Tag class and a `:db/ident`, loses Page, and can extend other tags in the same call. Journals, built-ins, properties, recycled, namespaced and non-page entities, existing tags and a title another tag holds are refused with nothing written. Setting a page's `tags` to Tag stops answering 500 and answers 400 pointing at the new tool, and `create_tag`'s 409 for a page names it too.

**Architecture:**
- **One upstream patch, `patches/0027-semantic-promote-page-to-tag.patch`,** on top of 0001 to 0026. It adds one route (`promotePageToTag`), one handler (`:semantic/pages-promote-to-tag`) with its helpers, a refusal of Tag as a `tags` value in `prepare-property-value`, and a hint in `title-taken-response`. The handler copies the app's `convert-page-to-tag-tx` and guards, and reuses patch 0026's `validate-tag-schema`, `write-tag-schema!`, `expected-tag-schema` and `verify-tag-schema!`.
- **Each stage regenerates patch 0027 as a whole** from a baseline at 0026 (the patch is unmerged, so amending it is allowed; `add-upstream-patch` *Rules*). After stage N the patch holds stages 1 to N.
- **The connector** gets `promote_page_to_tag` from the re-vendored OpenAPI document with no hand-written handler. Its own changes are text and one set entry: `HINTS` in `connector/src/tools/semantic.ts`, `CONNECTOR_HELP` in `connector/src/tools/handwritten.ts`, `KB_INDEX_WRITE_TOOLS` in `connector/src/tools/kb-index.ts`, `connector/tools-manifest.json`, and tests in `connector/test/tools.test.ts` and `connector/test/kb-index.test.ts`.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real outliner on a real conn); TypeScript connector with vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-11-06-promote-page-to-tag-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) and test numbers (test 4 and so on) are the spec's.

## Global constraints

- **Names, exactly:**
  - the patch is `patches/0027-semantic-promote-page-to-tag.patch`;
  - the new upstream test namespace is `logseq.db-sync.semantic-promote-page-to-tag-test` in `deps/db-sync/test/logseq/db_sync/semantic_promote_page_to_tag_test.cljs`, required from `test_runner.cljs` after `semantic-property-schema-test`;
  - the route is `POST /api/v1/graphs/:graph-id/pages/:page-id/promote-to-tag`, handler `:semantic/pages-promote-to-tag`, operationId `promotePageToTag`, scope `logseq/write`, rate class `:write`, so the generated tool is `promote_page_to_tag`;
  - request: body `{extends?: [string]}`; query `dry-run` declared with the existing `dry-run-parameter` in `worker/routes/semantic.cljs` (spec §11 question 1: the query flag is kept unless the owner says otherwise);
  - response: `tag-detail-response` fields (`uuid`, `ident`, `title`, `extends`, `properties`) plus `promoted: {blocks, references}`, and `dry-run: true` on a dry run;
  - private helpers in `worker/handler/semantic.cljs`: `promotion-refusal`, `promote-tx`, `promotion-counts`, `verify-promotion!`, `pages-promote-to-tag`;
  - the `existing[]` flag on `createTag`'s 409 is `promote`.
- **Error wording is the spec's (§3.3, §3.7, §4),** for example `page-id: "Journal Day" (<uuid>) is a journal; journals can't become tags`, `page-id: "Recipe" is already a tag (<uuid>); use update_tag to change it`, `tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>`, and `entry 1: tags: ...` in batches. Every refusal names its field or entry and the reason, the first per field kept, joined with `; ` (`docs/solutions/api/one-error-for-every-failure.md`).
- **Validate everything, then write once** (§3.3, `docs/solutions/api/validate-final-state-apply-in-order.md`). Every check runs against `@conn` before the write. The write is one `atomic-write!` (`semantic.cljs:1401`) with `:outliner-op :save-block`, so one call is one tx id (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). A refused call and a dry run leave `(:max-tx @conn)` and the datom count unchanged; every refusal test asserts both.
- **Copy the app's guards, not just its transaction** (`docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`). `promote-tx` is the two steps of `convert-page-to-tag-tx` (`.upstream/src/main/frontend/worker/handler/property.cljs:296`) with a comment naming that file and line; `promotion-refusal` holds the guards of `convert-page-to-tag!` (`.upstream/src/main/frontend/handler/db_based/page.cljs:37`) plus the spec's additions.
- **No silent success.** `verify-promotion!` re-reads the entity by UUID and answers 500 through `unverified!` (`:2098`) naming what is missing (§3.5).
- **Tests run the real outliner** on a real conn through the handler entry point the other `semantic_*_test.cljs` files use, on a graph from `build-db-initial-data`. The only stub is spec test 12's `with-redefs` on the transact step, which proves the read-back is wired (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Each new test is first seen to fail; keep the failure text for the PR.
- **Path parameters** keep patch 0016's re-encoding; the route resolves `page-id` with `find-visible-entity` as the other `pages/:page-id` routes do (`docs/solutions/api/qualified-ident-path-params-404.md`).
- **Check the read path before the write** (`docs/solutions/api/read-hid-built-in-properties.md`): the promotion tests read the result back through `getTag`, `listTags` and `listTagObjects`, not only through the conn.
- **Free plan.** Nothing here reads or writes D1. The connector's only storage write is the existing KV dirty mark for the KB index on success. In the DO: one `:avet :block/name` range for the title conflict, and two counts (children, `:block/_refs`) taken before and after the write (§5).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a graph name, page UUID or hostname. Tests and docs use `sync.example.com` and `mcp.example.com`, and invented page titles such as Recipe, Restaurant and Food.

### Working on patch 0027 (every stage)

Follow the `add-upstream-patch` skill. Once, before stage 1 (the current `.upstream` baseline commit is at 0025, so it is rebuilt at 0026):

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0026
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0026"
git -C .upstream tag -f baseline
```

In every stage, after the code and tests pass:

```bash
scripts/build.sh .upstream
(cd .upstream/deps/db-sync && pnpm test)                     # or the namespace filter from patch 0023
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0027-semantic-promote-page-to-tag.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 27 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
node connector/scripts/check-tools-manifest.mjs
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. The manifest check is expected to report no change in Stages 1, 3 and 4. Stage 2 adds the route, so in Stage 2 it reports exactly one new tool, `promote_page_to_tag`, and `npm --prefix connector run update:manifest` is run and the result committed; any other difference means a route moved by mistake. `connector/vendor/` is not committed; CI rebuilds it from the patches, so connector tests that read the new tool pass in CI only if the patch carries the route.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Sync*, *Contract and docs* and *Cost*.
- `patches/0026-semantic-property-choices-and-class-restrictions.patch` (`extends-refusal`, `validate-tag-schema`, `write-tag-schema!`, `expected-tag-schema`, `verify-tag-schema!`, `tag-detail-response`) and `patches/0011-semantic-write-guards.patch` (`title-taken-response`, `title-holders`, `dry-run-conn`). Patch 0027 must not undo either.
- The app's conversion: `.upstream/src/main/frontend/handler/db_based/page.cljs:37` and `.upstream/src/main/frontend/worker/handler/property.cljs:296-310`, and upstream's `convert-page-to-tag-updates-worker-db-atomically` test, whose invariants Stage 2 re-asserts.
- The `docs/solutions` entries listed in spec §2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **Re-sending Tag on an entity that is already a tag, and a replace-style `tags` write that sends Page back.** Both must still succeed after the Tag refusal (Stage 1).
2. **Tag as a value in a batch where an earlier entry is valid.** The batch refuses as `entry 1:` and entry 0 is not written (Stage 1).
3. **Tag as a property value inside `insert_block_tree` on a new block** (no UUID clause in the message) (Stage 1).
4. **A page that is referenced by a node-property value, not only by a `[[link]]`.** The value still points at the same entity after promotion and counts in `references` (Stage 2).
5. **A page with other non-Page tags** (for example a page tagged #Food). They are kept; only Page is retracted (Stage 2).
6. **A tag whose title differs from the page's only by case** is a 409; a *page* with the same title ignoring case is not a conflict (Stage 2).
7. **A Library child** counts as namespaced and is refused (Stage 2).
8. **`extends` naming the page itself, by UUID as well as by title.** 0026's `extends-refusal` was written for an entity that is already a tag; it must refuse self-extension, and not throw, when the entity is still a page (Stage 3).
9. **A dry run with `extends`** writes nothing, including no parent (Stage 3).
10. **`createTag` where the holders are a page and a property** gives the hint for the page only (Stage 4).

---

### Stage 1: Reproduce the 500 from `tags = Tag` and refuse it with a 400

**Goal:** prove on the real handler where the 500 comes from, then refuse `:logseq.class/Tag` as a `:block/tags` value on an entity that is not already a tag, on every write path, with nothing written. This lands the regression half of acceptance 5 and the behaviour change in §3.7.

**Files:**
- Create: `patches/0027-semantic-promote-page-to-tag.patch`. Inside upstream it changes:
  - `deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`: `prepare-property-value` (`:957`) gains the Tag refusal (or the confirmed site does, see Step 3);
  - `deps/db-sync/test/logseq/db_sync/semantic_promote_page_to_tag_test.cljs` (new) and `test_runner.cljs`.
- No connector change. The 400's text names `promote_page_to_tag`, which lands in Stage 2 of the same PR; the commit body says so.

**Interfaces produced:**
- `(tag-value-refusal db target-entity resolved-values) -> nil | reason-string`, called from `prepare-property-value` when `property-ident` is `:block/tags`. `target-entity` is nil for a block or page being created.
- Test helpers in the new namespace, reused by later stages: `(seed-graph)` returning a conn from `build-db-initial-data` plus the handler context; `(snapshot conn) -> {:max-tx … :datoms n}`; `(call conn op path-params body query) -> {:status :body}`.

- [ ] **Step 1: Write the failing tests** (spec tests 1 to 3):
  - `set-tags-to-tag-on-empty-page-test`: an empty page "Restaurant"; `setBlockProperty` with property `tags` and value Tag. Before the fix it answers 500: quote the status and body in the test's docstring comment and keep it for the PR. After the fix it answers 400 with `tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>`, and `snapshot` is unchanged.
  - `set-tags-to-tag-on-page-with-blocks-test`: the same on a page with two blocks, to show whether a non-empty page fails the same way (spec §7, second risk). Record what it answered before the fix.
  - `batch-set-tags-to-tag-names-entry-test`: `batchSetBlockProperty` with entry 0 a valid `tags` write on another page and entry 1 `tags = Tag` on "Restaurant": 400 starting `entry 1: tags:`, and entry 0 is not written (snapshot unchanged).
  - `update-page-tags-to-tag-refused-test`: `updatePage` with `tags [Tag]` is refused the same way.
  - `insert-tree-with-tag-value-refused-test`: `insertBlockTree` with a node whose properties set `tags` to Tag is refused with the message without the `on page <uuid>` clause, and nothing is written.
  - `tags-page-and-existing-tag-still-allowed-test`: `updatePage` with `tags [Page, Food]` on a page succeeds and reads back; re-sending Tag through `updatePage` on an existing tag "Food" succeeds.

- [ ] **Step 2: Run the namespace** and keep the failures. Find the 500's origin from the stack the test runner prints (the hypothesis is a Tag-tagged entity with no `:db/ident` failing graph validation, §2). Write the confirmed cause in the commit body.

- [ ] **Step 3: Implement** as §3.7: in `prepare-property-value`, when `property-ident` is `:block/tags`, a resolved value is `:logseq.class/Tag`, and the target does not already hold Tag, refuse with the reason; the existing callers already prefix `entry N:` in batches through `batch-entries-error`. Page, Journal and a re-sent Tag stay allowed. If Step 2 shows the 500 comes from somewhere `prepare-property-value` does not cover, put the refusal at the confirmed site instead, keep the same wording, and record the change for the plan's as-built note.

- [ ] **Step 4: Regenerate the patch, re-vendor and run the gate** (procedure above). The manifest check reports no change.

- [ ] **Step 5: Mutation check** (`docs/solutions/testing/untested-rules-survive-mutation.md`): remove the refusal and confirm the first five tests fail; drop the "target already holds Tag" exception and confirm `tags-page-and-existing-tag-still-allowed-test` fails. Revert.

- [ ] **Step 6: Commit.** `fix(api): refuse Tag as a tags value instead of answering 500`.

**Done when:** `tags = Tag` on an empty page answers 400 naming `promote_page_to_tag` on all four write paths, nothing is written, Page and a re-sent Tag still work, the pre-fix 500 is quoted, and the gate is green.

---

### Stage 2: `promotePageToTag`: guards, the conversion, read-back and the tool

**Goal:** the new route converts a page in place, copying the app's transaction and guards, refuses every kind in §3.3 with nothing written, reads the result back, and answers the tag detail with `promoted` counts. The connector exposes `promote_page_to_tag` with its hint and marks the KB index dirty on success. This lands acceptances 1, 2, 3 and the promotion half of 5.

**Files:**
- Modify (inside patch 0027):
  - `semantic.cljs`: new `promotion-refusal`, `promote-tx`, `promotion-counts`, `verify-promotion!`, `pages-promote-to-tag`; dispatch from `handle-capture-and-tags` (`:1759`); the handler in `e2ee-gated-write-handlers` (`:3488`) and an explicit 400 on `e2ee?` inside the handler (`promote_page_to_tag isn't available on an E2EE graph`), because the gated set alone decrypts titles rather than refusing;
  - `routes/semantic.cljs`: the route, its OpenAPI summary and description (converts in place; links stay links and are not tagged; the refusals), request body schema with `additionalProperties: false` semantics enforced by the handler (`unknown field X`), the 200 response schema (the tag response plus `promoted`), and 400, 404 and 409 responses;
  - `semantic_promote_page_to_tag_test.cljs`.
- Modify: `connector/src/tools/semantic.ts` (`HINTS.promote_page_to_tag`, spec §4 wording without the dry-run sentence, which Stage 3 adds), `connector/src/tools/kb-index.ts` (`KB_INDEX_WRITE_TOOLS` gains `promote_page_to_tag`), `connector/tools-manifest.json` (via `update:manifest`), `connector/test/tools.test.ts`, `connector/test/kb-index.test.ts`.

**Interfaces produced:**
- `(promotion-refusal db page title-conflicts) -> nil | {:status 400|404|409 :error "page-id: …"}`.
- `(promote-tx db page) -> {:tx [...] :ident kw}`; calls `db-class/build-new-class` with the page's `:block/uuid`, `:block/title` and `:block/created-at`, and catches its user-facing ex-info as a 400 `page-id: "X" can't become a tag: <reason>`. It reads only the db, so validation calls it before the write.
- `(promotion-counts db page) -> {:blocks n :references n}` from `ldb/get-block-full-children-ids` and `:block/_refs`.
- `(verify-promotion! db uuid title snapshot) -> entity | throws` (500 via `unverified!`).
- `(run-promotion conn page body) -> response-body`, the one function the real and (in Stage 3) the dry path call.

- [ ] **Step 1: Write the failing tests** (spec tests 4 to 7, 9 without `extends`, 12):
  - `promote-referenced-page-keeps-everything-test` (test 4): "Recipe" with nested blocks, a user property value, a #Food tag, a `[[Recipe]]` link from another page's block, and a node-property value pointing at it. 200; UUID, title, `created-at`, child block ids, ref holder ids, property values and the Food tag are unchanged; tags hold Tag and not Page; the ident starts `user.class/Recipe` and equals the response's `ident`; `promoted` is `{blocks: 3, references: 2}` (or whatever the fixture holds, computed independently in the test).
  - `promoted-page-works-as-tag-test` (test 5, acceptance 2): `listTags` includes it and `getTag` answers it; a block inserted afterwards titled `Pasta #Recipe` has `:block/tags` Recipe and is listed by `listTagObjects`.
  - `promote-empty-page-test` (test 6, acceptance 5): "Restaurant" with no blocks promotes with 200 and `promoted {blocks: 0, references: 0}`.
  - `promotion-is-one-transaction-test` (test 7): every datom from the promotion carries one tx id in the sync log, and it matches upstream's `convert-page-to-tag-updates-worker-db-atomically` invariants (ident added, Tag added, Page retracted, same entity).
  - `promotion-refusals-test` (test 9), each asserting the status, that the message names the field and reason, and an unchanged `snapshot`: a journal (400); a built-in page (400); a property (400); an existing tag (409 naming `update_tag`); a namespaced page and a Library child (400 `is namespaced under …`); a recycled page (400); a whiteboard (400 `is a whiteboard, not a page`); a tag "recipe" when promoting "Recipe" (409 naming that tag's UUID), while a second *page* "recipe" is not a conflict; an unknown body field (400 `unknown field foo`); a missing page (404 `page-id: no page <id>`); an E2EE graph (400); a title `build-new-class` rejects (400 `can't become a tag:`).
  - `promote-path-param-test`: the page UUID in the path, URL-encoded as the connector sends it, resolves (0016).
  - `promotion-read-back-wired-test` (test 12): `with-redefs` on `promote-tx` to drop the ident datom gives a 500 naming the missing ident.
  - Connector, `tools.test.ts`: `promote_page_to_tag` is in the generated tool set with `page-id` and `extends` in its input schema and the hint in its description; it is in `tools-manifest.json`. `kb-index.test.ts`: a successful `promote_page_to_tag` call marks `kb-index-dirty:<alias>`; a 400 does not; a 400 and a 409 body pass through to the tool result unchanged.

- [ ] **Step 2: Run and keep the failures** (route 404, tool missing).

- [ ] **Step 3: Implement** as §3.2 to §3.6. In the handler: reject unknown body keys; resolve `page-id` with `find-visible-entity`; refuse on `e2ee?`; run `promotion-refusal`, then the title conflict (`title-holders` filtered to `tag?`, other than the page), then `promote-tx` (which can refuse); take `promotion-counts`; inside one `atomic-write!` transact `promote-tx`'s tx plus `[:db/retract page-id :block/tags :logseq.class/Page]` with `:outliner-op :save-block`; then `verify-promotion!` (UUID and title unchanged, Tag present and Page absent, `:db/ident` set, both counts equal the snapshot); answer `tag-detail-response` plus `promoted`. The max order key is already seeded by `handle`; the promotion creates no blocks.

- [ ] **Step 4: Connector.** `HINTS.promote_page_to_tag`: "Turns an existing page into a tag in place: its UUID, blocks, properties and references are kept, and links to it stay links (they aren't tagged). Refuses journals, built-ins, properties, namespaced pages and existing tags. Setting a page's tags to Tag is refused; use this instead." Add `promote_page_to_tag` to `KB_INDEX_WRITE_TOOLS`. Run `npm --prefix connector run update:manifest` and confirm the diff is the one new entry.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.** The manifest check now reports no difference against the committed manifest.

- [ ] **Step 6: Mutation check:** delete each guard in `promotion-refusal` in turn (journal, built-in, property, recycled, namespaced, non-page, already a tag) and the title-conflict check, and confirm a case in `promotion-refusals-test` fails for each; drop the Page retraction from the tx and confirm `promote-referenced-page-keeps-everything-test` or the read-back fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): promote an existing page to a tag in place` (the connector files are in the same commit, since the manifest must match the vendored API for the gate to pass).

**Done when:** a referenced page and an empty page promote with their blocks and references intact and work as a tag through `getTag`, `listTags` and an inline `#Recipe`, every refusal writes nothing, the tool is in the manifest, and the gate is green.

---

### Stage 3: `extends` on promotion, and `dry-run`

**Goal:** the promotion can give the new tag its parents in the same call, through 0026's validation and write, and `dry-run=true` answers the same body with `dry-run: true` and writes nothing. This lands the rest of acceptance 7.

**Files:**
- Modify (inside patch 0027): `semantic.cljs` (`pages-promote-to-tag` and `run-promotion` validate `extends` with `validate-tag-schema` against the page as `tag`, call `write-tag-schema!` inside the same `atomic-write!`, and call `verify-tag-schema!` with `(expected-tag-schema page parents nil)`; the dry path runs `run-promotion` on `dry-run-conn` (`:1160`)); `routes/semantic.cljs` (`extends` in the body schema and description, `dry-run-parameter` on the route, `dry-run` on the response); tests.
- Modify: `connector/src/tools/semantic.ts` (`HINTS.promote_page_to_tag` gains "Run with dry-run first on a page with many references and show the user the counts." and one clause on `extends`), `connector/test/tools.test.ts`.

- [ ] **Step 1: Write the failing tests** (spec tests 8 and 10):
  - `promote-with-extends-test`: with a tag Food, promoting "Recipe" with `extends ["Food"]` answers `extends` with Food, and `getTag` reads it back; without `extends` the tag extends Root.
  - `promote-extends-refusals-test`: `extends ["Tag"]` gives `extends 0: Tag is a built-in tag that other tags can't extend`; `extends ["Recipe"]` (itself, by title and by UUID) gives `extends 0: Recipe can't extend itself`; `extends []` gives `extends: name at least one tag`; `extends ["Food", "Fod"]` gives `extends 1: no tag "Fod"`; a page refusal and an `extends` refusal in one call are both reported, joined with `; `; snapshot unchanged in each.
  - `promote-dry-run-test`: `dry-run=true` answers the ident, `promoted` counts and `dry-run: true`, and the snapshot is unchanged; with `extends ["Food"]` the same, and Food has no new child.
  - `promote-dry-run-refusal-test`: a dry run on a journal answers the same 400 as the real call.
  - Connector: `promote_page_to_tag`'s input schema has `dry-run`; its description contains `dry-run`.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.3 (the `extends` bullet and write step 2) and §3.4. All refusals, page and `extends`, are collected before any write.

- [ ] **Step 4: Connector text** as above.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.** The manifest check reports no change (same route).

- [ ] **Step 6: Mutation check:** skip `validate-tag-schema` and confirm `promote-extends-refusals-test` fails; make the dry path use the real conn and confirm `promote-dry-run-test` fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): extends and dry-run on page promotion`.

**Done when:** `extends` sets and reads back the parents, 0026's refusals apply, a dry run writes nothing with or without `extends`, and the gate is green.

---

### Stage 4: Point `create_tag`'s 409 and `connector_help` at the tool

**Goal:** when `createTag` is refused because a plain page holds the title, the 409 names `promote_page_to_tag` and the page's UUID and flags that `existing[]` entry with `promote: true`; `connector_help` and the `create_tag` hint say the same. This lands acceptance 4 and the help part of acceptance 6.

**Files:**
- Modify (inside patch 0027): `semantic.cljs` (`title-taken-response` (`:1289`) gains an optional hint argument; `tags-create` passes it when a holder is a plain page, not a journal, tag or property; `pages-create` is unchanged); `routes/semantic.cljs` (`createTag`'s 409 description and the `existing[]` item schema gain `promote`); tests.
- Modify: `connector/src/tools/semantic.ts` (`HINTS.create_tag` gains "If a page already has the title, the 409 names it; promote_page_to_tag converts that page."), `connector/src/tools/handwritten.ts` (the line at `:21` gains "when create_tag is refused because a page has the title, promote_page_to_tag converts that page, keeping its blocks and references"; one sentence that setting `tags` to Tag is refused), `connector/test/tools.test.ts`.

- [ ] **Step 1: Write the failing tests** (spec test 11):
  - `create-tag-409-points-at-promotion-test`: with a page "Recipe", `createTag {title "recipe"}` answers 409; the message contains `promote_page_to_tag` and the page's UUID; `existing[0].promote` is true.
  - `create-tag-409-no-hint-for-other-holders-test`: when the holder is a tag, a journal or a property, the message has no `promote_page_to_tag` and no entry has `promote`; when the holders are a page and a property, only the page's entry has `promote: true`.
  - `create-page-409-unchanged-test`: `createPage` on a taken title answers the 0011 body exactly as before.
  - Connector: `connector_help` contains `promote_page_to_tag`; `create_tag`'s description contains `promote_page_to_tag`.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.8.

- [ ] **Step 4: Connector text** as above.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.** The manifest check reports no change.

- [ ] **Step 6: Mutation check** (spec test 13, the whole patch): drop the hint condition so every holder gets it and confirm `create-tag-409-no-hint-for-other-holders-test` fails; then re-run the Stage 1 and Stage 2 mutations once more on the final patch to confirm each guard and the Tag refusal is still pinned by a failing test. Revert.

- [ ] **Step 7: Commit.** `feat(api): point create_tag's 409 for a page at promote_page_to_tag`.

**Done when:** `create_tag` on a page's title names the page and the new tool, other 409s are unchanged, `connector_help` mentions `promote_page_to_tag`, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 gains a paragraph on `promote_page_to_tag` (in place, references kept and not tagged, dry-run first on a well-linked page, refusals, `extends`), and on `tags = Tag` now answering 400. The README's patch list gains a 0027 bullet in the style of the 0025 and 0026 ones. The spec gains an as-built note if Stage 1 moved the refusal.
- **PR body:** the Logseq skill note (spec §4 last bullet: use `promote_page_to_tag` instead of `create_tag` plus moving blocks, dry-run first on a well-linked page, never set `tags` to Tag), the pre-fix 500 and the other failures each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped. The PR is stacked on PR #37 and item 26.
- **After deploy** (spec §9 step 4): promote Restaurant (empty) and see it under Tags in the app; dry-run then promote a referenced page and check its backlinks, blocks and that `#Name` tags a new block; `create_tag` with a page's title and see the pointer.
- **Owner questions** in spec §11 stay open; none blocks a stage. If the owner moves `dry-run` to the body (question 1) the change lands in Stage 3; refusing Property as a tags value (question 2) lands in Stage 1; an `out_of_class` count (question 3) or a title selector (question 5) lands in Stage 2, before the PR merges.
