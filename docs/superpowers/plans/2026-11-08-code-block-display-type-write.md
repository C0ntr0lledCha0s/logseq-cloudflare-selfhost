# Code blocks: set display type and code language from the connector: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stages 1 to 3, `scripts/check.sh` in Stage 4), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every block write path takes `display-type` (`code`, `math`, `quote`) and `lang` as strings and stores them as the app does (the keyword, the matching class tag, lang only on code); a block whose whole title is one ```` ``` ```` or `$$` fence becomes a code or math block on insert and update, with a `convert-fences=false` opt-out; code and math titles are stored verbatim (no heading step, no `#` escaping, no refs), which closes the `#include` backlog item; reads report both fields; and a write that does not read back fails the whole call. A ```` ```query ```` fence stays text and is listed under `kept`.

**Architecture:**
- **One upstream patch, `patches/0037-semantic-display-type-and-code-lang.patch`**, grown over Stages 1 to 3 and regenerated against the 0036 baseline each time, in `worker/handler/semantic.cljs`, `worker/routes/semantic.cljs` and a new test namespace. Each stage leaves a complete, passing patch.
- **Stage 1, the property paths:** set_block_property, batch_set_block_property, delete_block_property and batch_delete_block_property learn display type and lang, with `set-display-type!` mirroring the client pipeline (spec §2.2), the guards of spec §3.3, the read-back of §3.8 and the read fields of §3.9 (`block-response`, `block-detail-response`).
- **Stage 2, the tree and update paths:** explicit `display-type` and `lang` on `BlockTree` nodes and the `updateBlock` body, the same values inside `properties`, and verbatim titles (`prepare-block-title!` judged on the node's final type, `tree-block` passing it instead of `nil`).
- **Stage 3, fences:** `standalone-display-block` ported to the handler with the `gp-mldoc` it already requires, the `convert-fences` flag, `kept`, `dry-run` on insert_block_tree and insert_block_children, and `get_page_outline` rendering.
- **Stage 4, the contract:** tool descriptions, `connector_help`, `readable.ts`, manifest, connector tests. No connector logic changes.
- **No migration, no D1, KV, Vectorize or semantic-index change.** Converted blocks reach the indexer through the existing block-changes feed.
- **Order:** the narrowest write path first (one value per call, no titles), then the paths that carry titles, then the parse that infers a type from a title, then the text Claude reads. Each stage is usable on its own: after Stage 1 a block can be made a code block with set_block_property.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real `sync-handler/handle-http` on a real conn via `with-graph`, as `semantic_headings_test.cljs` does); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-11-08-code-block-display-type-write-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) are the spec's. Spec §9 lists five stages with the failing tests as a stage of their own; this plan folds each stage's tests into it, because a commit of failing upstream tests would turn the gate red, and moves the docs to the lane's docs step (see the end).

## Global constraints

- **Names, exactly:**
  - patch `patches/0037-semantic-display-type-and-code-lang.patch`; upstream test namespace `logseq.db-sync.semantic-display-type-test` in `deps/db-sync/test/logseq/db_sync/semantic_display_type_test.cljs`, required from `test_runner.cljs` after `semantic-knowledge-index-aliases-test`;
  - in `worker/handler/semantic.cljs`: `display-type-values` (`#{:code :math :quote}`, rendered in messages in that order), `display-type-classes` (`{:code :logseq.class/Code-block :math :logseq.class/Math-block :quote :logseq.class/Quote-block}`), `parse-display-type`, `valid-lang?` (1 to 40 characters, no whitespace, case kept), `set-display-type!`, `clear-display-type!`, `verbatim-title?` (code or math), `fence-display-block` (Stage 3), `read-back-display!`;
  - request fields `display-type` and `lang` on `BlockTree` nodes and the `updateBlock` body; query flag `convert-fences` (default true) on insertBlockTree, insertBlockChildren, batchInsertBlockTrees, updateBlock and capture; body field `dry-run` on insertBlockTree and insertBlockChildren (**plan call:** a body field with the existing `dry-run-schema`, as batchInsertBlockTrees takes it, so the three insert tools agree; the spec's "dry-run=true" names the value, not where it goes);
  - response keys `display-type` and `lang` (on blocks, when set), `converted: "fence"` (per node), `kept: [{path, reason}]` (per call), `warnings` (set_block_property).
- **Messages, in the spec's wording (§3.1, §3.3, §4):**
  - `display-type: "cod" is not one of code, math, quote` (prefixed by the entry or path, `blocks[0].children[1]: …` or `entry 2: …`, as every refusal here is);
  - `lang: must be 1 to 40 characters with no spaces`;
  - `entry 2: lang needs display-type code`;
  - `entry 0: display-type applies to blocks, not a page` (and `a tag`, `a property`, `an asset`);
  - `blocks[1]: display-type given twice ("code", "math")`, and the same for `lang`;
  - `Code: set it with display-type code, not as a tag` (Math and Quote likewise);
  - `Status: takes a keyword; only display-type can be set as text`;
  - `blocks[0]: fence is code but display-type is "quote"` (Stage 3, spec §3.6);
  - `convert-fences must be true or false`;
  - kept reason `query fences stay text; a Query block is not supported yet`;
  - set_block_property warning: `title holds \# escapes from earlier writes; to store it verbatim, call update_block with the title and display-type together`.
- **Every check runs before anything is written.** A failure refuses the whole call with 400, naming the entry or node path. Final-state checks (lang needs code) are judged on the batch's final state, as `*final-tags*` judges tags.
- **One transaction, one tx id.** Every new datom goes through `outliner-property` inside the existing `atomic-write!`, `authored-write!` or batch transaction, so patch 0034's edit stamps apply (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`).
- **No silent success.** `read-back-display!` re-reads each written block inside the transaction and throws through `rejecting` on a mismatch (spec §3.8).
- **Free plan** (spec §5): 0 extra Worker requests, D1 rows, neurons or Vectorize dimensions per call. Server CPU: a string check per title, an mldoc parse only when the trimmed title starts and ends with ```` ``` ```` or `$$`, up to five datoms per typed block. Each stage's commit body states this.
- **Tests run the real thing.** Every upstream test goes through `handle-http`, the outliner and a real graph; only the read-back mismatch test (Stage 1) stubs a step, and is labelled so. Every new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Example data only (`Example`, `stdio.h`, `print(1)`, `E=mc^2`, `sync.example.com`).
- **Contract with Claude.** Upstream route descriptions change in the stage that changes the behaviour; the connector's text changes in Stage 4. Run `npm --prefix connector run check:manifest` after each re-vendor and say in the commit whether it changed (the manifest holds names, paths and annotations, so it should not).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page UUIDs, hostnames or tokens.

### Working on patch 0037 (Stages 1 to 3)

Follow the `add-upstream-patch` skill. Once, before Stage 1 (`.upstream` may hold 0036's work uncommitted on a 0035 baseline; start clean):

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0036
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0036"
git -C .upstream tag -f baseline
```

At the end of each of Stages 1 to 3:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-display-type|semantic-headings|semantic-private-tags|semantic-batch-class-check|semantic-edit-stamps'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0037-semantic-display-type-and-code-lang.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 37 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/` and the vendored files carry the change. To see a test fail before the stage's fix, stash the handler change (`git -C .upstream stash push -- deps/db-sync/src`), run, and pop.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Contract and docs*, *Tests* and *Cost*.
- `worker/handler/semantic.cljs`: `block-response` (`:72`), `entity-properties-response` (`:175`), `block-detail-response` (`:188`), `outline-heading-level` and `outline-children` (`:397`-`:430`), `escape-unresolved-inline-tags` (`:560`), `reads-heading?` and `prepare-block-title!` (`:596`, `:603`), `*final-tags*` (`:744`), `refused-by-type` (`:951`), `tag-value-refusal` (`:985`), `prepare-property-value` (`:1019`), `set-prepared-tags!` (`:1060`), `final-tags` (`:1128`), `prepare-tree`, `tree-block`, `insert-tree!` (`:1166`-`:1255`), `rejecting` and `dry-run-conn` (`:1255`, `:1274`), `authored-write!` (`:1567`), `atomic-write!` (`:2115`), `refresh-refs` (`:2289`), `handle-blocks` (`:2318`), `handle-block-properties` (`:2460`), `handle-capture-and-tags` (`:2700`). Line numbers are on the 0036 baseline.
- `worker/routes/semantic.cljs`: `heading-note`, `value-notes`, `request-schema` (`updateBlock`, the `BlockTree` schema, `batchInsertBlockTrees`), `dry-run-schema`.
- Upstream app code the patch mirrors (read, not required by the worker): `src/main/frontend/worker/pipeline.cljs` `add-missing-properties-to-typed-display-blocks`, `src/main/frontend/format/block.cljs` `standalone-display-block`, `deps/db/src/logseq/db/frontend/class.cljs` (the three classes), `deps/db/src/logseq/db/frontend/property.cljs` (display type and `logseq.property.code/lang`).
- Tests: `semantic_headings_test.cljs` (the `with-graph` and request helpers to copy), `semantic_private_tags_test.cljs`, `semantic_batch_class_check_test.cljs`.
- `docs/solutions/api/outliner-save-and-insert-disagree-on-heading.md`, `handler-writes-skip-outliner-guards-and-implicit-holders.md`, `title-resolves-outside-allowed-values.md`, `outliner-throws-on-private-tag-writes-answered-500.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`, and the previous plan, `docs/superpowers/plans/2026-11-08-suggest-links-existing-pages.md`.
- Connector: `connector/src/tools/semantic.ts` (the overrides for the seven tools), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`, the heading sentence at `:36`), `connector/src/tools/readable.ts`, `connector/test/tools.test.ts`, `connector/test/readable.test.ts`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **`" Code "` and `":CODE"`:** trimmed and lower-cased, accepted; `"::code"`, `":foo/bar"` and `"code "` inside a longer word (`"codes"`) refused (Stage 1).
2. **display type set by title (`"Node Display Type"`) and by ident**, on set_block_property and inside a node's `properties`: both resolve to the same branch (Stages 1 and 2).
3. **A batch that sets lang, then display type code, on the same block:** accepted (final state). **A batch that sets code with lang, then quote:** lang is retracted, and the read-back sees no lang (Stage 1).
4. **Setting the same type twice:** no duplicate tag, no second heading retract, and one tx (Stage 1).
5. **`set_block_property` of `block/tags` with `[Code, Example]` on a block that already holds Code:** the held Code is a no-op, Example is added; on a block without it, refused (Stage 1).
6. **A reset tag list on a code block that leaves out Code:** Code is kept, as private tags are (Stage 1).
7. **lang on a quote block, and lang `""`, `"py thon"`, 41 characters:** refused with their messages (Stage 1).
8. **A node with `display-type: "code"` and `properties: {"Node Display Type": ":code"}`:** the same value twice is accepted; `"math"` in one and `"code"` in the other is refused naming the path (Stage 2).
9. **update_block on a code block with a title that starts `# ` and holds `[[Example]]`:** stored verbatim, heading not set, `:block/refs` unchanged and no Example page created (Stage 2).
10. **update_block with `display-type: "quote"` on a code block:** lang and Code-block go, Quote-block comes, and the title's `#tag` is now resolved as quote titles are (Stage 2).
11. **A child of a code node:** the child is an ordinary block (types do not inherit) (Stage 2).
12. **A fence with a trailing newline and leading spaces, and ```` ```Python ````:** converted, lang kept as `Python` (Stage 3).
13. **Four backticks, ```` ```` ````, and a ```` ``` ```` fence whose body holds another ```` ``` ````:** follow mldoc's one-`Src` rule; whatever it parses to more than one node stays text (Stage 3).
14. **`$$` with text after it on the same line, and `$x$`:** stay text (Stage 3).
15. **A ```` ```query ```` fence inside batch_insert_block_trees entry 3, child 2:** listed under `kept` with path `entries[3].blocks[0].children[2]` and written as text (Stage 3).

---

### Stage 1: Patch 0037, display type and lang on the property paths

**Goal:** set_block_property, batch_set_block_property, delete_block_property and batch_delete_block_property write and remove display type and lang as the app does; every other keyword property refuses text with the reworded message; reads report both fields; writes read back. Lands spec §3.1, §3.3, §3.4, §3.8 (read-back and warning), §3.9 (block responses) and §8 items 4, 5 and 9, and acceptance 2 (property paths), 4 and 7.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/test/logseq/db_sync/semantic_display_type_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `display-type-values`, `display-type-classes`, `parse-display-type`, `valid-lang?`;
  - `prepare-property-value` gains branches for `:logseq.property.node/display-type` and `:logseq.property.code/lang`, ahead of `refused-by-type`; `refused-by-type` rewords the `:keyword` case;
  - a guard that display type and lang apply to blocks only (page, tag, property, asset refused);
  - `tag-value-refusal` refuses the three classes as tag values with the pointer message, no-op when held; `set-prepared-tags!` under reset keeps them;
  - `set-display-type!` and `clear-display-type!` (spec §3.4), called from the property set and delete paths;
  - the lang-needs-code check on the final state, using the batch's ordered writes as `final-tags` does;
  - `read-back-display!`, called after each write inside the transaction;
  - the set_block_property `warnings` when a text block with `\#` in its stored title becomes code or math;
  - `block-response` and `block-detail-response` add `display-type` (the keyword's name) and `lang` when set.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: setBlockProperty, batchSetBlockProperty and the delete descriptions name display type and lang; the block response schema adds both.
- Create: `patches/0037-semantic-display-type-and-code-lang.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`).

**Interfaces produced:** `set-display-type! [conn block type-kw lang]` and `clear-display-type! [conn block]`, both inside a caller's transaction; `display-type` and `lang` on every block response.

- [ ] **Step 1: Write the failing tests** (spec §8 items 4, 5 and 9), each through `handle-http` on a real graph:
  - `set-display-type-each-value`: `"code"`, `"math"`, `"quote"` and `":code"` on set_block_property each store the keyword and exactly the matching class tag; get_block reports `display-type` (review focus 1, 2: once by ident, once by title).
  - `set-display-type-refuses-unknown`: `"cod"`, `""`, `5`, `":foo/bar"`, `"codes"`, each 400 with `display-type: "…" is not one of code, math, quote`; the block unchanged.
  - `other-keyword-property-refuses-text`: a user keyword property (or a built-in keyword property that is not display type) given `"x"` answers `<title>: takes a keyword; only display-type can be set as text`.
  - `display-type-on-a-page-refused`, and on a tag and a property.
  - `lang`: on a code block stored as given (`mermaid`, `Python`); on a text block, a math block and a quote block refused `lang needs display-type code` (review focus 7); `""`, `"py thon"` and 41 characters refused.
  - `batch-lang-before-type`: batch_set_block_property with lang then display type code on one block succeeds (review focus 3); entry numbers in refusals match the request order.
  - `switch-code-to-quote`: lang and Code-block retracted, Quote-block added (review focus 3).
  - `same-type-twice`: one class tag, no error (review focus 4).
  - `heading-retracted`: a block with `logseq.property/heading 2` set to code loses the heading.
  - `delete-display-type`: delete_block_property and batch_delete_block_property remove display type, the class tag and lang.
  - `class-tags-refused`: `block/tags` with Code-block refused with the pointer message; held Code-block is a no-op (review focus 5); a reset tag list on a code block keeps Code-block (review focus 6); a private tag (Journal) still refused as patch 0029 refuses it.
  - `escape-warning`: a text block stored with `\#include` set to code answers `warnings` with the update_block hint, and the title is unchanged.
  - `edit-stamps`: the set carries patch 0034's stamps and one tx id (one transaction in the tx log).
  - `read-back-mismatch-rejects` (**stubs a step; labelled**): with `set-display-type!` redefined to skip the keyword, the call answers an error naming the entry and nothing is committed.
  - `get-blocks-reports-type`: get_blocks and list_page_blocks carry `display-type` and `lang`; a plain block carries neither key.
- [ ] **Step 2: Run on the 0036 baseline** and keep the failures (today: `should be a Clojure keyword`, spec §2.1; no `display-type` key in reads).
- [ ] **Step 3: Implement** as spec §3.1, §3.3, §3.4, §3.8 and §3.9 for these paths.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** accept any keyword (drop the table check); skip the class tag in `set-display-type!`; skip removing the other two classes; keep lang on a switch to quote; judge lang on the current state, not the final one; drop the reset-keeps rule; skip the read-back. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): accept display-type and code lang as text on block properties`. Body: the quoted baseline failure, what each guard refuses, the mutation results, `check:manifest` unchanged, and cost (no connector change; up to five datoms and one entity read per typed block on the server).

**Done when:** all 37 patches apply from scratch, the new namespace and the whole db-sync suite pass, the vendored API shows the new response fields, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0037, explicit fields on trees and update_block, verbatim titles

**Goal:** insert_block_tree, insert_block_children, batch_insert_block_trees, capture_to_today and update_block take `display-type` and `lang` as fields and inside `properties`; code and math titles are stored exactly as sent on insert, update and refresh_refs; quote titles skip only the heading step. Lands spec §3.2, §3.5, §8 items 1, 2, 3 and 7, and acceptance 1, 2 (tree and update paths), 5 and 6.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `prepare-tree` reads each node's `display-type` and `lang` and the same keys inside `properties`, merges them (same value accepted, different refused naming the path), and validates with Stage 1's helpers;
  - `tree-block` passes the node's final type to `prepare-block-title!` instead of `nil`; `insert-tree!` calls `set-display-type!` for typed nodes inside the insert transaction;
  - `prepare-block-title!` takes the final type: code and math return `{:block/title title}` with no heading, no inline-tag resolution or escaping, no refs and no tags (`verbatim-title?`); quote skips only `markdown-heading`; `reads-heading?` reads the final type;
  - `:semantic/blocks-update` reads the body's `display-type` and `lang`, judges the title on the final type (the body's, else the stored block's), and writes the title and type in one transaction;
  - `:semantic/capture` passes nodes through the same `prepare-tree`;
  - if the outliner derives refs from a code title on its own (spec risk 2), strip them after the outliner call and say so in the commit body;
  - `read-back-display!` on every block these paths write.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `BlockTree` schema gains `display-type` (enum `code`, `math`, `quote`) and `lang` (string, `minLength` 1, `maxLength` 40); `updateBlock`'s body gains both; `heading-note` and the insert and update descriptions say code and math titles are verbatim and how display type is given.
- Modify: `patches/0037-…`, `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`.

- [ ] **Step 1: Write the failing tests** (spec §8 items 1, 2, 3 and 7):
  - `insert-tree-code-verbatim` (spec §8 item 1): `display-type: "code"`, `lang: "python"`, title `# comment\n#include <stdio.h>\n[[Example]]`: stored `:code`, lang `python`, Code-block tag, title byte-equal to the input, no heading, no `:block/refs`, no page named Example (review focus 9's insert half).
  - the same through `properties` with `"code"` and with `":code"`, by ident and by title (review focus 2); through insert_block_children; through batch_insert_block_trees (two entries, the second with a refused value: nothing written, `entries[1].blocks[0]: …`); through capture_to_today.
  - `given-twice` (review focus 8).
  - `lang-on-a-plain-node-refused` with its path; `type-not-inherited` (review focus 11).
  - `update-code-block-include` (the backlog item, spec §8 item 3): update_block on a code block with `#include <stdio.h>` stores it verbatim (baseline: `\#include`, spec §2.1); review focus 9's update half.
  - `update-converts-text-to-math`: update_block with `display-type: "math"` and a `# ` title keeps the `# ` line and sets Math-block.
  - `update-code-to-quote` (review focus 10).
  - `headings-0024` (spec §8 item 7): code, math and quote blocks with a `# ` line keep it on insert, update and `refresh_refs apply=true`; a quote's `#Example` tag is still resolved; a code title's is not.
  - `private-tag-in-properties-still-refused` (patch 0029 regression on the tree path).
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures (today: unknown fields ignored or refused by the schema, titles stripped and escaped).
- [ ] **Step 3: Implement** as spec §3.2 and §3.5.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** pass `nil` again in `tree-block`; resolve refs on code titles; escape tags on code titles; apply the heading step to quote; let the `properties` value win over a conflicting field silently; let a child inherit the parent's type. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): write code, math and quote blocks verbatim from trees and update_block`. Body: the quoted failures (the `\#include` line from spec §2.1 among them), what the refs test showed (spec risk 2), the mutation results, `check:manifest` (unchanged; the generated input schemas changed), and cost (no connector change; no extra parse).

**Done when:** every write path in spec §1 acceptance 2 takes both fields, the 0024 tests pass for all three types, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0037, fence conversion, `kept`, dry run and the outline

**Goal:** a whole-block ```` ``` ```` or `$$` fence becomes a code or math block on insert_block_tree, insert_block_children, batch_insert_block_trees, capture_to_today and update_block unless `convert-fences=false`; ```` ```query ```` fences stay text and are listed under `kept`; insert_block_tree and insert_block_children take `dry-run`; `get_page_outline` renders the three types. Lands spec §3.6, §3.7, §3.8 (dry run), §3.9 (outline), §8 items 6 and 8, and acceptance 3 and 10.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`:
  - `fence-display-block [title]`: on a plain graph only, trims, string-checks the start and end (```` ``` ```` … ```` ``` ````, or `$$` … `$$`), then parses with `gp-mldoc` and accepts only exactly one `Src` (code, its language as lang, `query` returned as kept) or `Displayed_Math` (math) node, returning the inner lines, as the app's `standalone-display-block`;
  - `prepare-tree` and the update path call it after reading the explicit fields: no explicit type, or the same type, converts; a different explicit type refuses; a query fence adds `{path reason}` to the call's `kept`; each converted node is marked `converted: "fence"` in the response;
  - `convert-fences` read with `flag-param` (absent is true, `::invalid` refused before any write);
  - insertBlockTree and insertBlockChildren read the body's `dry-run` with `dry-run-option` and run on `dry-run-conn`, answering the real call's body with `dry-run: true`; preview nodes carry `display-type`, `lang` and `converted`;
  - `outline-children` (and its line builder) renders code as an indented ```` ```lang ```` fence, math as `$$…$$`, quote as `> ` lines, never with a heading prefix.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `convert-fences` query parameter on the five operations; `dry-run` on insertBlockTree and insertBlockChildren; `kept` and `converted` in the response schemas; descriptions say Mermaid is highlighted code and query fences stay text; the getPageOutline description names the three renderings.
- Modify: `patches/0037-…`, `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`.

- [ ] **Step 1: Write the failing tests** (spec §8 items 6 and 8):
  - ```` ```mermaid ```` becomes code with lang `mermaid` and the inner lines only; ```` ``` ```` with no language becomes code with no lang; `$$E=mc^2$$` becomes math; review focus 12, 13 and 14.
  - stays text: text before a fence, text after it, two fences, an unclosed fence; each also on update_block.
  - `convert-fences=false` keeps the fence as text on each of the five operations; `convert-fences=maybe` is refused, nothing written.
  - ```` ```query ```` stays text and is listed under `kept` with its path, single and batched (review focus 15).
  - a ```` ``` ```` fence with `display-type: "quote"` refused naming the node; with `display-type: "code"` accepted.
  - E2EE: a ciphertext title is never parsed (no conversion, no `kept`), and explicit fields still apply.
  - `dry-run`: insert_block_tree and insert_block_children with a fence answer `converted: "fence"` and the type, and the graph is unchanged afterwards; batch_insert_block_trees' dry run reports the same.
  - outline (spec §8 item 8): get_page_outline shows the code fence with its lang, the `$$` form and `> ` lines, and no `#` prefix on a typed block that had a heading line.
  - update_block on one of the old fenced text blocks with its title unchanged converts it (the owner's bulk conversion path, spec §9).
- [ ] **Step 2: Run on the Stage 2 tree** and keep the failures.
- [ ] **Step 3: Implement** as spec §3.6 to §3.9.
- [ ] **Step 4: Run the patch workflow above.** **Mutation check:** drop the string precheck (parse every title; the CPU claim then fails review, so pin it with a test that a title not starting with ```` ``` ```` or `$$` never reaches the parser, via a counting `with-redefs` on the parse, labelled); accept more than one `Src` node; convert query fences; ignore `convert-fences=false`; parse on E2EE; write on dry run. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): convert whole-block code and math fences on insert and update`. Body: the quoted failures, the mutation results, `check:manifest`, and cost (one mldoc parse per title that is a fence at both ends; dry run uses the existing in-memory copy).

**Done when:** every fence case in spec §8 item 6 passes, the outline renders all three types, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 4: The connector contract

**Goal:** Claude's tool text describes what Stages 1 to 3 built. Lands spec §3.10 (connector half) and acceptance 8 (except README, which is the docs step's).

**Files:**
- Modify: `connector/src/tools/semantic.ts`: the descriptions of insert_block_tree, insert_block_children, batch_insert_block_trees, capture_to_today, update_block, set_block_property and batch_set_block_property name `display-type`, `lang`, `convert-fences`, `kept` and the verbatim rule.
- Modify: `connector/src/tools/handwritten.ts`: `CONNECTOR_HELP` gains "Code, math and quote blocks" (the values, lang only with code, fence conversion and `convert-fences=false`, verbatim code and math titles, Mermaid is highlighted code not a diagram, query fences stay text and appear under `kept`, converting an existing block with update_block and the title and type together, the `\#` warning); the heading sentence at `:36` is reconciled with it (quote keeps tag handling).
- Modify: `connector/src/tools/readable.ts`: a write's readable context shows the block's display type when the response carries one.
- Modify: `connector/test/tools.test.ts`, `connector/test/readable.test.ts`; `connector/tools-manifest.json` only if `check:manifest` says so.

- [ ] **Step 1: Write the failing tests:**
  - the generated insert_block_tree, insert_block_children and batch_insert_block_trees input schemas carry `display-type` with exactly the enum `code`, `math`, `quote` and `lang` on every node, and update_block's carries both;
  - insert_block_tree and insert_block_children carry `dry-run`; the five operations carry `convert-fences`;
  - `CONNECTOR_HELP` has the section and names each of the three values, `lang`, `convert-fences`, `mermaid` and `kept` (one assertion each, so dropping one fails);
  - each changed description names `display-type`;
  - readable: an update_block result with `display-type: "code"` shows it in the summary; a plain block's summary is unchanged (the existing expected text).
- [ ] **Step 2: Run and keep the failures** (schema assertions pass already from Stages 2 and 3's vendor; record which ones did, since only the text and readable tests can fail first).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate:** `npm --prefix connector run check:manifest` (say whether it changed) and `scripts/check.sh`. **Mutation check:** drop each help phrase; drop the readable branch. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): describe code, math and quote blocks to Claude`. Body: the failures seen, which schema tests passed before the change and why, the manifest result, and cost (none: text only).

**Done when:** the help, descriptions and readable summaries match the server's behaviour, the manifest check passes, and `scripts/check.sh` is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs step:** README §1 gains patch 0037 in the list of patches; README §11.8 gains an entry (the fields, the three values, lang, fence conversion and its opt-out, verbatim titles, query fences kept, Mermaid as code, reads, the bulk conversion with update_block). `docs/solutions/api/server-writes-skip-client-pipeline-display-type-tag.md` (spec §3.11) and a REVIEW.md *API and patches* line: a client-pipeline rule that returns early for `rtc-tx` must be mirrored by the server.
- **PR body:** each stage's first failures (Stage 1's `should be a Clojure keyword` and Stage 2's `\#include` among them), every stage's mutation results, the commit `scripts/check.sh --upstream` ran on and what it skipped, whether `tools-manifest.json` changed, and the Logseq skill note: write code as `display-type: "code"` with a `lang`, not as ```` ``` ```` text; a whole-block fence is converted anyway; pass `convert-fences=false` to keep a literal fence; query fences stay text and come back under `kept`; Mermaid is stored as highlighted code; to convert an old fenced block, call update_block with its title (and the type if it is not a fence). The PR is stacked on the phase 4 branch and merges after it.
- **Live check** (spec §9): after deploy, insert one block with `display-type: "code"` and `lang: "python"` and one whole-block ```` ```mermaid ```` fence on a scratch page, open it in the app and see two code blocks; record the outcome, not page names.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 widens Stage 1's keyword branch; question 2 would turn conversion off by default on update_block in Stage 3 (flip its default and the bulk-conversion test); question 3 would drop the heading retract in Stage 1 and hide the heading in reads instead; question 4 would turn Stage 1's class-tag refusal into a call to `set-display-type!`; question 5 is a tracker item; question 6 would replace `valid-lang?` with an allowlist. Any change lands before the PR merges.
