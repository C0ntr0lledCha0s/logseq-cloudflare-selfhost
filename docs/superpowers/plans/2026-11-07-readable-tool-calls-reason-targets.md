# Readable tool calls: reason, named targets and readable results: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh --upstream` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a write or delete tool call is readable before the owner approves it and after it runs. Every write takes an optional `reason`; page targets can be named by title or journal date; block-targeted writes take a `target-label` that the server checks inside the write's transaction; results and the large dry-runs name the page, breadcrumb and snippet of what changed; and every tool carries correct `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations.

**Architecture:**
- **Two connector-only stages first** (annotations, then `reason`). They need no patch and land the parts of the contract claude.ai reads before the call: the approval prompt and the reason.
- **One upstream patch, `patches/0028-semantic-readable-write-context.patch`,** on top of 0001 to 0027, built over Stages 3 to 6. It adds one helper section to `worker/handler/semantic.cljs` (`block-context`, `resolve-page-selector`, `check-target-labels`, with 0014's `feed-text` and `feed-ancestors` moved into it), one-line call sites in the write handlers, and the OpenAPI changes in `worker/routes/semantic.cljs`. No new routes, so the manifest's names, methods and paths do not change.
- **Each patch stage regenerates 0028 as a whole** from a baseline at 0027 (the patch is unmerged, so amending it is allowed; `add-upstream-patch` *Rules*). After stage N the patch holds stages 3 to N.
- **The connector** gains `src/tools/readable.ts` (shared with item 28's audit log), an `ANNOTATIONS` table in `src/tools/spec.mjs`, the `reason` field and its stripping in `buildGraphTools` / `registerGraphTools`, a wider `onSuccess` in `src/mcp.ts`, and text in `HINTS` and `CONNECTOR_HELP`.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real outliner on a real conn); TypeScript connector with vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-11-07-readable-tool-calls-reason-targets-design.md`. Read it first. It is the authority; section numbers below (§3.4 and so on) and test numbers ("upstream test 3", "connector test 2") are the spec's.

## Global constraints

- **Names, exactly:**
  - the patch is `patches/0028-semantic-readable-write-context.patch`;
  - the new upstream test namespace is `logseq.db-sync.semantic-readable-writes-test` in `deps/db-sync/test/logseq/db_sync/semantic_readable_writes_test.cljs`, required from `test_runner.cljs` after `semantic-promote-page-to-tag-test`;
  - helpers in `worker/handler/semantic.cljs`, in one new section placed before the first handler: `block-context`, `resolve-page-selector`, `check-target-labels`, `label-matches?`, `confirm-removed!`, and the moved `feed-text` and `feed-ancestors`;
  - OpenAPI: schema `BlockContext`; query parameter `target-label`; per-entry field `target-label` in the four batches; body field `labels` on `deleteBlocks`; query flag `dry-run` on `moveBlocks`, declared with the existing `dry-run-parameter`;
  - response fields: `affected`, `not-removed`, `target`, `from`, `to`, `would-create`, `context` (only ever `"unavailable"`, with `context-reason`);
  - connector: `src/tools/readable.ts` exports `AffectedTarget`, `toAffectedTargets(response)`, `summarise(targets, opts)`, `CONTEXT_TOOLS` and `NO_CONTEXT_TOOLS`; `src/tools/spec.mjs` exports `ANNOTATIONS`; the tool argument is `reason`.
- **Decide on the server, inside the write** (§3). Title and date resolution, the label check and delete context all run against the same snapshot as the write, inside `atomic-write!` (`semantic.cljs:1448`), so one call is one tx id (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`). The connector makes no extra upstream call in any stage.
- **Errors name the entry and reason** in the spec's wording: `entry 2: target-label "Nov 5th, 2026 > Notes" does not match target "Nov 5th, 2026 > Meeting > Agenda"`, `page-id: no journal for 2026-11-05 and no page titled "2026-11-05"`, `labels: 3 labels for 2 block-ids` (`docs/solutions/api/one-error-for-every-failure.md`).
- **No silent success.** A delete confirms every UUID is gone and lists survivors under `not-removed` with a 500 (§3.5). A post-write context read that fails answers `context: "unavailable"` and keeps the write; it never turns a committed write into an error, and never shows empty context as if complete.
- **Delete context comes from the before-snapshot** (§6, risk 5). After the delete the entities are gone, so context read then is empty and looks like success.
- **The existing guards stay** (REVIEW.md *Destructive operations keep their guards*): `acknowledge-*` flags, existing dry-runs, 0011's write guards and 0012's bulk limits are untouched. A test in each patch stage re-runs one guarded refusal through the changed handler.
- **Tests run the real handler and outliner** through the handler entry point the other `semantic_*_test.cljs` files use, on a graph from `build-db-initial-data`. The only stub is upstream test 7's forced failure of the post-write context read. Each new test is first seen to fail; keep the failure text for the PR (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`).
- **Check the read path** (`docs/solutions/api/read-hid-built-in-properties.md`): move `to` breadcrumbs are compared with `getPageOutline`, inserted snippets with `getBlock`.
- **Path parameters** keep patch 0016's re-encoding; selector tests use titles containing `/` and `%` (`docs/solutions/api/qualified-ident-path-params-404.md`).
- **Free plan** (§5, REVIEW.md *Cost*). No D1 rows read or written, no Workers AI or Vectorize use, no extra Worker or upstream requests. In the DO: at most 100 addressed blocks × 6 entity reads per call, one `:block/name` read per title selector, one `:avet :block/journal-day` read per date. Each patch stage's commit body states its added reads per call.
- **Contract with Claude.** A stage that changes a tool's inputs or outputs updates its `HINTS` clause and `CONNECTOR_HELP` in the same commit. Guidance on `reason`, `target-label`, selectors and dry-runs lives once in `CONNECTOR_HELP` (§3.7 item 8); each description gains one short clause at most.
- **Logging.** The connector's log line stays argument-free; it gains `reason=yes|no` only (§3.7 item 3).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a graph name, page UUID or hostname. Tests and docs use `sync.example.com` and `mcp.example.com`, and invented titles such as "Nov 5th, 2026", Notes, Meeting and Agenda.

### Working on patch 0028 (Stages 3 to 6)

Follow the `add-upstream-patch` skill. Once, before Stage 3:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0027
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0027"
git -C .upstream tag -f baseline
```

In every patch stage, after the code and tests pass:

```bash
scripts/build.sh .upstream
(cd .upstream/deps/db-sync && pnpm test)                     # or the namespace filter from patch 0023
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0028-semantic-readable-write-context.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 28 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
node connector/scripts/check-tools-manifest.mjs               # names, methods, paths and annotations unchanged
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `connector/vendor/` is not committed; CI rebuilds it from the patches, so connector tests that read new OpenAPI fields pass in CI only if the patch carries them.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Contract and docs*, *Destructive operations keep their guards* and *Cost*.
- `patches/0011-semantic-write-guards.patch` (`dry-run-conn`, the 409 wording), `patches/0012-semantic-bulk-operations.patch` (`delete_blocks`, the batches), `patches/0014-*` (`feed-text`, `feed-ancestors`) and `patches/0016-*` (path re-encoding). Patch 0028 must not undo any of them.
- `connector/src/tools/semantic.ts`, `spec.mjs`, `common.ts` and `connector/src/mcp.ts`.
- The `docs/solutions` entries listed in spec §2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A tool with no annotations entry**, including a hand-written one registered only when semantic search is on (`semantic_search`), fails the build, not just the manifest check (Stage 1).
2. **`reason` given to a tool whose upstream body is a top-level array or has no body** (`delete_block`, `delete_page`): it still never reaches the query or body (Stage 2).
3. **`delete_blocks` naming a block and its own descendant** in the same call: two `affected` entries, descendant counts from the before-snapshot, no double count, and no false `not-removed` (Stage 3).
4. **A block whose text is only a reference**, `[[Meeting]]`: its snippet is the referenced title, not a UUID (Stage 3).
5. **A title that is also an ISO date of another page's journal**, and **a title that differs only in case from another page** (Stage 4).
6. **A label segment shorter than 3 characters against a snippet that is itself shorter** ("Q4" for a block "Q4"), and a label with more segments than the target has levels (Stage 5).
7. **Batch entry 0 valid and entry 1 mismatched** in each of the four batches: nothing written, one 409 naming entry 1 only (Stage 5).
8. **A `move_blocks` dry-run** that moves a block under its own former sibling: `to` is computed on `dry-run-conn`, and the live graph is unchanged (Stage 6).
9. **An E2EE graph**: context without titles or text, `e2ee: true`, and the connector summary says "titles unavailable on an E2EE graph" (Stages 3 and 4).

---

### Stage 1: Annotations on every tool, checked by the build and the manifest

**Goal:** every tool carries the hints in spec §4 *Annotations*, from one table, so claude.ai asks for approval before the calls that can lose data. Lands acceptance 5. Connector only.

**Files:**
- Modify: `connector/src/tools/spec.mjs`: new exported `ANNOTATIONS: Record<string, ToolAnnotations>` built from four class constants (`READ`, `DESTRUCTIVE`, `DESTRUCTIVE_IDEMPOTENT`, `ADDITIVE`) and a per-tool map covering every manifest name; `buildManifest` writes each entry's `annotations`; `checkManifest` compares them; new `annotationsFor(name)` that throws `no annotations for tool <name>`.
- Modify: `connector/src/tools/semantic.ts`: `buildGraphTools` sets `config.annotations` from `annotationsFor(op.name)` and ignores the generator's method-derived hints (`connector/vendor/semantic_api_tools.mjs:89-93`).
- Modify: `handwritten.ts`, `kb-index.ts`, `semantic-search.ts`, `assets.ts`: replace the inline annotation objects with `annotationsFor("<name>")`.
- Modify: `connector/tools-manifest.json` (regenerated with `npm --prefix connector run update:manifest`).
- Modify: `connector/test/tools.test.ts`.

**Interfaces produced:**
- `ManifestEntry` gains `annotations: {readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`.
- `annotationsFor(name: string): ToolAnnotations`, used by every registration path.

- [ ] **Step 1: Write the failing tests** (connector test 1) in `tools.test.ts`:
  - `every tool has annotations`: every name in the manifest has an `ANNOTATIONS` entry with all four hints as booleans; `annotationsFor("not_a_tool")` throws.
  - `registered tools use the table`: list the tools on a server built as `mcpHandler` builds it (semantic on) and compare each one's annotations with `ANNOTATIONS`.
  - `expected hints`: `batch_delete_block_property`, `update_property`, `update_block`, `set_block_property`, `refresh_refs` and `promote_page_to_tag` are destructive and not read-only; `delete_*` and `set_*` are idempotent; every GET plus `connector_help`, `list_graphs`, `kb_index`, `semantic_search`, `semantic_index_status`, `read_file` and `list_assets` are read-only and idempotent; `move_blocks`, `batch_move_blocks`, `insert_*`, `create_*`, `capture_to_today`, `save_document` and `save_file_from_url` are neither read-only nor destructive nor idempotent; `openWorldHint` is true for `save_file_from_url` only.
  - `manifest records annotations`: `checkManifest` reports a difference when a committed entry's `destructiveHint` differs from the table.

- [ ] **Step 2: Run** `npm --prefix connector test -- tools` and keep the failures (generator hints mark `batch_delete_block_property` non-destructive; `save_file_from_url` and graph tools disagree on `openWorldHint`; the manifest has no `annotations`).

- [ ] **Step 3: Implement** as §3.7 item 6. Annotations are static per tool, so `refresh_refs` and `update_property` are destructive in every mode (§4).

- [ ] **Step 4: Contract.** `npm --prefix connector run update:manifest`. `CONNECTOR_HELP` gains one sentence: tools that overwrite or remove data are marked destructive, so claude.ai asks before running them. No `HINTS` change.

- [ ] **Step 5: Run the gate:** `scripts/check.sh` (no patch change in this stage).

- [ ] **Step 6: Mutation check:** change `batch_delete_block_property` to `ADDITIVE` and confirm `expected hints` fails; drop one tool from `ANNOTATIONS` and confirm `every tool has annotations` and the build fail. Revert.

- [ ] **Step 7: Commit.** `feat(connector): set read-only, destructive and idempotent hints on every tool from one table`.

**Done when:** every tool's annotations come from `ANNOTATIONS`, the manifest records and checks them, a missing entry fails the build, and the gate is green.

---

### Stage 2: `reason` on every write, stripped before the server, flagged in the log

**Goal:** every non-read tool accepts an optional `reason` (at most 200 characters, refused if longer); the connector removes it before calling upstream, logs `reason=yes|no`, puts `Reason: …` in a leading text content item, and passes it to `onSuccess`. Lands acceptance 1. Connector only.

**Files:**
- Create: `connector/src/tools/readable.ts` with `REASON_MAX = 200`, `reasonSchema` (zod optional string, max 200, with the description from §4), `takeReason(args) -> {reason, rest}`, a first `summarise(targets, {reason, dryRun})` that, with no targets yet, returns `Reason: …` or nothing, and the `WriteOutcome` type `{reason?: string, targets: AffectedTarget[]}` (`targets` is always `[]` in this stage).
- Modify: `connector/src/tools/semantic.ts`: `buildGraphTools` extends the input schema of every tool whose annotations are not read-only with `reason`; `registerGraphTools` calls `takeReason` before `tool.handler(rest)`, prepends the summary item when non-empty, and calls `onSuccess(tool, alias, outcome)`.
- Modify: `connector/src/tools/assets.ts` (`save_document`, `save_file_from_url`): same.
- Modify: `connector/src/tools/common.ts`: `runTool` and `logTool` take an optional `reasonGiven: boolean` and append ` reason=yes|no` for non-read tools.
- Modify: `connector/src/mcp.ts`, `kb-index.ts`, `semantic-search.ts`: `onSuccess: (tool, alias, outcome?: WriteOutcome) => void`; today's uses ignore `outcome`.
- Modify: `connector/test/tools.test.ts`, `connector/test/assets.test.ts`; create `connector/test/readable.test.ts`.

**Interfaces produced:** `WriteOutcome` and the widened `onSuccess`, which item 28 consumes.

- [ ] **Step 1: Write the failing tests** (connector tests 3, 4 and 6):
  - `reason in every write schema`: every non-read tool's input schema has an optional string `reason`; no read-only tool has one.
  - `reason never reaches the server`: with a spy on `syncFetch`, `update_block`, `delete_blocks`, `delete_block` and `delete_page` called with `reason: "tidy duplicate notes"` send no `reason` in the query or body; `save_document` likewise.
  - `reason over 200 characters is refused`: 201 characters answers an error naming `reason` and the limit, and `syncFetch` is not called.
  - `reason is repeated in the result`: the first content item is `Reason: tidy duplicate notes`, followed by the unchanged JSON item; with no reason the result is unchanged.
  - `log carries a flag, never the text`: capture `console.log`; the line has `reason=yes` and does not contain the reason text; a call without one has `reason=no`; a read has neither.
  - `onSuccess receives the reason`: a spy `onSuccess` gets `(tool, alias, {reason, targets: []})`.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.7 items 2 to 4. The refusal is a `ToolError` with status `refused`, raised before graph resolution so nothing is sent.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: fill `reason` on every write and delete with one plain sentence on why; it is shown with the result and never stored on the graph. `tools-manifest.json` is unchanged (the manifest records no input schemas); `tools/list` size grows by about 1 KB, noted in the commit body.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** stop stripping `reason` and confirm `reason never reaches the server` fails; log the text instead of the flag and confirm the log test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): take a reason on every write and show it with the result`.

**Done when:** every write takes `reason`, the server never sees it, the log shows only a flag, the result repeats it, `onSuccess` gets it, and the gate is green.

---

### Stage 3: `block-context` and readable results for deletes, moves, inserts and property writes

**Goal:** the server answers each write with the page title, breadcrumb and snippet of what it touched (§3.2, §3.5), deletes confirm every UUID is gone, and the connector turns that into a one-line-per-target summary. Lands acceptances 3 and 7 and the shared helper. First stage of patch 0028.

**Files:**
- Create: `patches/0028-semantic-readable-write-context.patch`. Inside upstream it changes:
  - `deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`: the new helper section with `block-context` and `confirm-removed!`; `feed-text` and `feed-ancestors` move into it from 0014's section (the feed calls the moved functions, unchanged); one call each in `delete-block`, `delete-blocks`, `delete-page`, `move-blocks`, `batch-move-blocks`, `insert-block-children`, `insert-block-tree`, `batch-insert-block-trees`, `capture-to-today`, `create-task`, `set-block-property`, `delete-block-property`, `batch-set-block-property`, `batch-delete-block-property`, `update-block`.
  - `deps/db-sync/src/logseq/db_sync/worker/routes/semantic.cljs`: `BlockContext` schema; `affected`, `not-removed`, `target`, `from`, `to`, `context`, `context-reason` on the response schemas named in §4.
  - `deps/db-sync/test/logseq/db_sync/semantic_readable_writes_test.cljs` (new) and `test_runner.cljs`.
- Modify: `connector/src/tools/readable.ts`: `AffectedTarget`, `toAffectedTargets(response)`, the full `summarise` (breadcrumb elided to the first and last two segments; `+N children`; `Dry run, nothing changed:` prefix; E2EE and `context: "unavailable"` lines), `CONTEXT_TOOLS` and `NO_CONTEXT_TOOLS` (each with the reason, e.g. `create_property: the response already names the title`).
- Modify: `connector/src/tools/semantic.ts` (`registerGraphTools` builds the summary from the parsed JSON item and passes `targets` to `onSuccess`), `assets.ts` if it produces targets.
- Modify: `connector/test/readable.test.ts`, `connector/test/tools.test.ts`; create `connector/test/fixtures/readable/*.json` (one response per shape, checked against the vendored `BlockContext` schema by a test).

**Interfaces produced (used by later stages and item 28):**
- `(block-context db entity {:descendants? bool}) -> {:uuid :kind :page {:uuid :title} :breadcrumb [snippet…] :snippet :descendants? :e2ee?}`, pure, at most 5 ancestors, 80-character snippets with references shown as titles.
- `(confirm-removed! db uuids) -> nil | throws ex-info {:status 500 :not-removed [uuid…]}`.
- `(with-context-or-unavailable f) -> map`: runs a post-write context read in `try` and answers `{:context "unavailable" :context-reason msg}` on failure.
- `AffectedTarget` = `{uuid, kind, pageTitle?, breadcrumb, snippet?, descendants?, from?, to?, e2ee?}`.

- [ ] **Step 1: Write the failing tests.** Upstream (tests 4, 5, 7 and the delete/insert halves of 6), on a journal "Nov 5th, 2026" with `Meeting > Agenda > "Call Sam about the contract renewal before Friday's review meeting with the board"` (longer than 80 characters, three children) and a block `[[Meeting]]`:
  - `delete-blocks-context-test`: `affected` gives page title, breadcrumb `["Meeting", "Agenda"]`, an 80-character snippet and `descendants: 3`; the `[[Meeting]]` block's snippet is `Meeting`; the context is non-empty (before-snapshot); every UUID is gone afterwards.
  - `delete-block-and-descendant-test` (review focus 3).
  - `delete-page-context-test`: `affected` names the page.
  - `delete-not-removed-test`: a forced survivor (the only redef besides test 7, on the outliner's delete step) answers 500 with `not-removed`.
  - `move-from-to-test`: `from` and `to` match `getPageOutline` before and after, for `move_blocks` and `batch_move_blocks`.
  - `insert-context-verbose-false-test`: `insert_block_tree` and `batch_insert_block_trees` with `verbose=false` give `target` with page title and breadcrumb, and one snippet and descendant count per top-level block, each matching `getBlock`; `capture_to_today` and `create_task` give the journal's title.
  - `property-write-context-test`: each `set_block_property` and batch entry has a `target`.
  - `context-unavailable-test` (test 7): a `with-redefs` failure in the post-write read keeps the write (read back) and answers `context: "unavailable"`.
  - `e2ee-context-test`: `e2ee: true` and no title, breadcrumb or snippet.
  - `guards-unchanged-test`: a `delete_page` with references and no acknowledge flag is still refused with 0011's wording.
  - `feed-unchanged-test`: the block-changes feed's `breadcrumb` and `text` for one block are what they were before the move of `feed-text`.

  Connector (tests 2, 5, 6):
  - `readable.test.ts`: `summarise` on each fixture gives the spec's lines (`Deleted 2 blocks on Nov 5th, 2026: Notes > "Call Sam…" (+3); …`), breadcrumb elision at 6 segments, the E2EE line, the unavailable line, and `Reason:` last.
  - `every write tool is classified`: every non-read manifest tool is in exactly one of `CONTEXT_TOOLS` and `NO_CONTEXT_TOOLS`; a fake tool in neither fails.
  - `onSuccess receives targets`: `delete_blocks` through a stubbed `syncFetch` returning a fixture passes two `AffectedTarget`s.

- [ ] **Step 2: Run both suites and keep the failures.**

- [ ] **Step 3: Implement** as §3.2 and §3.5. Delete handlers take context from `@conn` before `atomic-write!` and descendant counts from the removed set they already compute; move `from` before, `to` after through `with-context-or-unavailable`. Only addressed entities get a context (§3.2).

- [ ] **Step 4: Contract.** `HINTS` for `delete_blocks`, `move_blocks` and `insert_block_tree`: one clause naming `affected`, `from`/`to` and `target`. `CONNECTOR_HELP`: results start with a plain summary naming page, breadcrumb and snippet; show it to the user after a write. README §11.8 is the docs stage's.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate** (procedure above).

- [ ] **Step 6: Mutation check:** take delete context after the transaction and confirm `delete-blocks-context-test` fails; raise the ancestor cap to unbounded and lower it to 0 and confirm a test fails each way; drop `confirm-removed!` and confirm `delete-not-removed-test` fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): name the page, breadcrumb and snippet of each block a write touched`. Body: added DO reads per call (§5).

**Done when:** deletes, moves, inserts and property writes answer readable context (even with `verbose=false`), deletes confirm removal, the connector's summary leads the result, and the gate is green.

---

### Stage 4: Page selectors by title or journal date

**Goal:** every `{page-id}` path parameter, every `target-id` and `create_task`'s `page-id` accept a UUID, an exact title (then a unique case-insensitive title) or an ISO journal date (§3.3). Lands acceptance 2's first half.

**Files:**
- Modify (inside patch 0028): `semantic.cljs`: `resolve-page-selector` in the helper section; the `pages/:page-id` handlers, the `target-id` resolution in the insert and move handlers, and `create-task` call it instead of `find-visible-entity` for page positions. `routes/semantic.cljs`: the descriptions of `page-id` and `target-id` say what they accept.
- Modify: `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`), `connector/test/tools.test.ts`.

**Interfaces produced:** `(resolve-page-selector db selector field) -> {:ok entity} | {:status 404|409 :error "page-id: …" :candidates [{uuid title}]?}`.

- [ ] **Step 1: Write the failing tests** (upstream test 3), with pages "Projects/Alpha", "100% Done", "Notes" and "notes2", a journal for 2026-11-05, a page titled "2026-11-06" plus a journal for that date, a hidden page and a page in the Recycle bin:
  - `selector-uuid-unchanged-test`.
  - `selector-exact-and-case-insensitive-test`: "Notes" and "notes" both resolve to Notes; two pages differing only in case answer 409 listing both UUIDs and titles.
  - `selector-journal-date-test`: `insert_block_tree` with `target-id "2026-11-05"` writes under the journal; `2026-11-04` answers 404 with `page-id: no journal for 2026-11-04 and no page titled "2026-11-04"` (or `target-id:` as the field).
  - `selector-date-also-title-test`: "2026-11-06" answers 409 as ambiguous.
  - `selector-hidden-and-recycled-test`: both 404.
  - `selector-slash-and-percent-test`: `get_page` and `delete_page` (dry-run) with "Projects/Alpha" and "100% Done" URL-encoded in the path.
  - `selector-e2ee-refused-test`.
  - `selector-never-creates-test`: an unknown title answers 404 and creates nothing; `capture_to_today` and `batch_insert_block_trees`'s create-if-missing behave as before.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.3, in order: UUID, ISO date (one `:avet :block/journal-day` read, then the ambiguity check), exact `:block/name`, unique case-insensitive. Exclude hidden and recycled pages.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: page targets take a UUID, an exact title or a `YYYY-MM-DD` journal date; ambiguity answers the candidates; dry-run any delete named by title (risk 2). `tools.test.ts`: `connector_help` contains `"journal date"`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** let the journal win over a same-titled page and confirm `selector-date-also-title-test` fails; make the case-insensitive step pick the first match and confirm the ambiguity test fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): accept a page title or journal date wherever a page UUID is accepted`.

**Done when:** titles and dates resolve or are refused with named candidates, `/` and `%` titles work in paths, nothing is created by a selector, and the gate is green.

---

### Stage 5: `target-label`, checked inside the write

**Goal:** single-target block writes take a `target-label` query parameter, the four batches a per-entry field, and `delete_blocks` a `labels` array; any mismatch refuses the whole call with 409 and writes nothing (§3.4). Lands acceptance 2's second half.

**Files:**
- Modify (inside patch 0028): `semantic.cljs`: `label-matches?` and `check-target-labels` in the helper section, using `block-context`; one call per handler named in §4's table, inside `atomic-write!` before any mutation. `routes/semantic.cljs`: `target-label` query parameter on the seven single-target operations, the per-entry field on the four batch schemas, `labels` on `deleteBlocks`.
- Modify: `connector/src/tools/semantic.ts` (`HINTS` clause on `delete_blocks` naming `labels`), `handwritten.ts`, `connector/test/tools.test.ts`.

**Interfaces produced:** `(check-target-labels db [{:entry i :entity e :label s}…]) -> nil | {:status 409 :error "entry 2: target-label … does not match target …; entry 4: …"}`.

- [ ] **Step 1: Write the failing tests** (upstream tests 1 and 2):
  - `label-mismatch-single-target-test`: for each of the seven single-target writes, a wrong label answers 409 naming what was given and found, and the db equals its state before the call datom for datom.
  - `label-mismatch-batch-test`: for each batch, entry 0 valid and entry 1 mismatched answers 409 naming entry 1 only, and nothing is written (review focus 7).
  - `labels-length-mismatch-test`: `delete_blocks` with 3 labels for 2 block-ids is refused.
  - `label-match-forms-test`: page-only form on a page target; `Nov 5th, 2026 > Meeting > Agenda > Call Sam`; `Nov 5th, 2026 > Agenda` (upper ancestors omitted); `Nov 5th, 2026 > Q4` on a block "Q4"; case-insensitive page segment.
  - `label-refusals-test`: an empty segment; a 2-character prefix of a longer snippet; more segments than levels; a page segment that is only a prefix of the title.
  - `label-is-a-guard-only-test`: a label that would match a different block does not redirect the write.
  - `label-one-transaction-test`: a matched batch produces one tx id.

  Connector: `insert_block_children`, `update_block` and `delete_block` schemas have `target-label`; `delete_blocks` has `labels`; each batch entry schema has `target-label`.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.4: split on ` > `, trim, exact case-insensitive page segment, remaining segments matched from the last backwards against the target's snippet then its ancestors, each a case-insensitive prefix of at least 3 characters unless the snippet is shorter (then equal). Collect every failing entry before refusing.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: give `target-label` as "Page > parent > … > block" on block-targeted writes; it is checked, never used to find the block; a mismatch writes nothing. `HINTS.delete_blocks`: `labels` is parallel to `block-ids`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check** (`docs/solutions/testing/untested-rules-survive-mutation.md`): make the comparison case-sensitive; change the minimum to 1 and to 4; allow extra segments; check labels after the first mutation instead of before. Each mutant must fail a test. Revert.

- [ ] **Step 7: Commit.** `feat(api): check a write's target-label against its target before writing`.

**Done when:** every label form in §3.4 matches or is refused as specified, a mismatch anywhere in a batch writes nothing, and the gate is green.

---

### Stage 6: Readable dry-runs for deletes, moves and batch inserts

**Goal:** `delete_blocks`, `delete_page`, `move_blocks` (new `dry-run` flag), `batch_move_blocks` and `batch_insert_block_trees` dry-runs answer the same structures as their writes, computed on `dry-run-conn`, plus descendant and reference counts, `would-create` and block counts (§3.6). Lands acceptance 4.

**Files:**
- Modify (inside patch 0028): `semantic.cljs` (the five handlers' dry-run branches use `block-context` on `dry-run-conn`; `move-blocks` gains the dry-run branch; `delete-page` adds its block count and first three root snippets; `delete-blocks` adds reference counts). `routes/semantic.cljs`: `dry-run` on `moveBlocks`; `would-create`, `references`, `blocks`, `roots` on the dry-run responses.
- Modify: `connector/src/tools/semantic.ts` (`HINTS` for `move_blocks`), `readable.ts` (dry-run lines), `handwritten.ts`, tests.

- [ ] **Step 1: Write the failing tests** (upstream tests 5 and 6, connector test 5's dry-run cases):
  - `delete-blocks-dry-run-context-test`: per-block page, breadcrumb, snippet, descendant and reference counts; db unchanged.
  - `delete-page-dry-run-test`: block count and three root snippets; db unchanged; the acknowledge refusal still applies to the real call.
  - `move-blocks-dry-run-test`: `from` and `to` as a real move would give (compared with a real move on a copy), live graph unchanged; the review focus 8 case.
  - `batch-move-dry-run-test` and `batch-insert-dry-run-test` (`would-create` true for a missing journal, block counts; graph unchanged).
  - Connector: `summarise` on dry-run fixtures starts `Dry run, nothing changed:` and lists counts; `move_blocks` has `dry-run` in its schema.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.6. The connector shows only summaries the server returned (§3.6, last paragraph).

- [ ] **Step 4: Contract.** `CONNECTOR_HELP`: dry-run large deletes and moves and show the summary before the real call. `HINTS.move_blocks`: `dry-run` previews `from` and `to`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** compute the move dry-run's `to` from `@conn` instead of `dry-run-conn` and confirm `move-blocks-dry-run-test` fails; drop the reference count and confirm the delete dry-run test fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): describe what a delete, move or batch insert would change in its dry run`.

**Done when:** each of the five dry-runs names pages, breadcrumbs, snippets and counts, changes nothing, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 gains a paragraph on `reason`, title and date selectors, `target-label`, readable results and dry-runs, and the approval prompts on destructive tools; the README's patch list gains a 0028 bullet in the style of the 0027 one.
- **PR body:** the logseq-kb skill note (spec §9 step 4: fill `reason` on every write, give `target-label` as "Page > parent > …", dry-run large deletes and moves and show the summary, expect more approval prompts), the failures each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped. The PR is stacked on PRs #37 and #38; risk 9 applies if either changes these tools' descriptions or the manifest.
- **After deploy** (spec §9 step 3): insert under a journal by date with a right and a wrong `target-label`; dry-run then run `delete_blocks` on two scratch blocks; move a block and check `to` in the app; confirm claude.ai asks before `update_block` and `batch_delete_block_property`.
- **Owner questions** in spec §11 stay open; none blocks a stage. Questions 2 and 3 change only `ANNOTATIONS` (Stage 1); question 4 limits Stage 4's call sites; question 5 flips one rule in Stage 4; question 6 tightens `label-matches?` in Stage 5; question 8 changes `REASON_MAX` in Stage 2. Any change lands before the PR merges.
