# Code blocks: set display type and code language from the connector: design

Date: 2026-11-08
Issue: 31, "Code blocks: set display-type and code language from the connector". Labels: enhancement, blocks. Status Backlog. Seen 2026-11-05.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0036 applied. This work adds patch 0037 and no migration.
Branch: `claude/relaxed-maxwell-s4r8o4-phase5`, stacked on phase 4 (items 27, memory ranking and 22), 2 commits behind `origin/main`, at `cdf54b4`.
Tier: intake suggested standard. The design needs patch 0037, so the build runs `scripts/check.sh --upstream` and upstream's db-sync suite.

Decisions marked **(issue)** come from the issue. Decisions marked **(brief)** come from the owner's brief, which overrides the issue where they differ. Decisions marked **(panel)** come from the design panel's winning design ("named"); no grafts were offered and no judges' notes came with it. Decisions marked **(call)** were made while writing this spec. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

The connector cannot make a code, math or quote block. The block type lives in `logseq.property.node/display-type`, which is keyword-typed, and JSON cannot carry a keyword, so the server refuses every value. Queries, scripts and Mermaid diagrams that Claude writes therefore land as plain text wrapped in ```` ``` ```` fences, and the owner converts them by hand (about 30 blocks when the issue was written).

This design lets every block write path take the display type and the code language as strings, converts a block whose whole title is one fence into a real code (or math) block, and makes reads report both.

Acceptance (issue and brief):

1. A block inserted with display type "code" and a language renders as a code block in the app. **(issue, criterion 1)**
2. Display type (code, math, quote) and code language are accepted as strings on insert_block_tree, insert_block_children, batch_insert_block_trees, update_block, set_block_property and batch_set_block_property, and converted to keywords on the server. An unknown value is refused up front, naming the entry. **(brief)**
3. A block whose whole title is one ```` ``` ```` fence (with a language, including mermaid) becomes a code block on insert, with an opt-out. A fence inside other text stays text. **(issue, criterion 2)**
4. Reads report display type and language.
5. `#include` in a code block is stored as written, including through update_block on an existing code block (the backlog item).
6. Patch 0024's heading-prefix conversion does not apply to code, math or quote blocks.
7. Private tags are still refused up front, and a write the server accepts reads back (no silent success).
8. `connector_help`, the tool descriptions, `tools-manifest.json` and README 11.8 describe it **(issue, criterion 4)**, with a Logseq skill note in the PR body.
9. Regression tests run through the real handler and outliner, were seen to fail first, and use example data only.
10. A ```` ```query ```` fence becoming a Query block **(issue, criterion 3)** is out of scope (section 3.7 and section 10). It is reported, not silently left.

## 2. Context

### 2.1 Reproduced on HEAD

A throwaway deftest (deleted after the run, not committed) ran against the patched upstream in `.upstream/` through the real `sync-handler/handle-http`, as `semantic_headings_test.cljs` does. It was compiled with `clojure -M:cljs compile db-sync-test` and run with `node worker/dist/worker-test.js zz-repro`. Output, verbatim:

```
REPRO put code: {:status 400, :body {:error "Node Display Type: \"code\" should be a Clojure keyword"}}
REPRO put :code: {:status 400, :body {:error "Node Display Type: \":code\" should be a Clojure keyword"}}
REPRO tree with props: {:status 400, :body {:error "blocks[0]: logseq.property.node/display-type: \"code\" should be a Clojure keyword"}}
REPRO tree plain stored: {:block/title "comment\n\\#include <stdio.h>", :logseq.property/heading 1}
REPRO update code block: 200 {:block/title "# comment\n\\#include <stdio.h>", :logseq.property.node/display-type :code}
REPRO fence stored: {:block/title "```python\nprint(1)\n```"}
```

What each line shows:

- **set_block_property refuses both spellings.** `"code"` and `":code"` are both refused with `should be a Clojure keyword`. The message comes from `deps/db/src/logseq/db/frontend/property/type.cljs:187`, reached through `refused-by-type` in `prepare-property-value`, because display type is not a ref property and the value is passed on as the JSON string.
- **insert_block_tree refuses it in `properties` too**, naming the node (`blocks[0]: …`).
- **An inserted title is heading-stripped and escaped.** `# comment\n#include <stdio.h>` is stored as `comment\n\#include <stdio.h>` with heading 1. `tree-block` calls `prepare-block-title!` with block `nil`, before the node's properties exist, so even once display type can be set on insert, the title would be stripped and escaped first. That last step is read from the code (`tree-block`, `insert-tree!`); it could not be run, because the display type cannot be set on insert today.
- **update_block on an existing code block escapes `#include`** (the backlog item). The block was made by the outliner with display type `:code`. The heading step was skipped (`reads-heading?`), but `escape-unresolved-inline-tags` still turned `#include` into `\#include`.
- **A whole-block fence stays text**, with no display type or lang.

### 2.2 What the app does

Read from the code; not run.

- `logseq.property.node/display-type` (title "Node Display Type") has type `:keyword`, is hidden and not public (`deps/db/src/logseq/db/frontend/property.cljs`). `logseq.property.code/lang` is a hidden `:string`.
- The app sets only `:code`, `:math` and `:quote` (`commands.cljs`, `events.cljs :editor/upsert-type-block`) and renders a block on its display type alone (`block.cljs block-title`).
- Each type has a built-in class: `logseq.class/Code-block` (title "Code"), `Math-block` ("Math") and `Quote-block` ("Quote"), all `hide-from-node`, in `deps/db/src/logseq/db/frontend/class.cljs`. They are in `block-kind-tags`.
- The client pipeline (`src/main/frontend/worker/pipeline.cljs`, `add-missing-properties-to-typed-display-blocks`) keeps tag and display type in step: setting display type adds the class tag; adding the class tag sets display type (and, for code, the last-used lang); removing the class tag retracts display type. It returns early for RTC and download transactions (`rtc-tx-or-download-graph?`), so it never runs for a server write. The graph-parser exporter sets the tag and display type together. The server has to mirror the pipeline itself, the same lesson as patch 0024 (`docs/solutions/api/outliner-save-and-insert-disagree-on-heading.md`).
- The app's own fence rule is `frontend/format/block.cljs standalone-display-block`: a trimmed title matching ```` ^```.*```$ ```` (or `^\$\$.*\$\$$`) that mldoc parses to exactly one `Src` (or `Displayed_Math`) node becomes the inner lines plus display type plus lang. That code is in `src/main`, which the worker cannot reach, so the patch ports it with the `gp-mldoc` the handler already requires.

### 2.3 Related learnings

- `docs/solutions/api/outliner-save-and-insert-disagree-on-heading.md`: display-type blocks are exempt from heading conversion; test code, math and quote with a `# ` line.
- `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`: the handler must apply what the outliner or client would.
- `docs/solutions/api/title-resolves-outside-allowed-values.md`: the outliner does not check closed values on server writes, so the handler checks the allowed set itself.
- `docs/solutions/api/outliner-throws-on-private-tag-writes-answered-500.md`: refuse private tags up front, naming the entry.
- `docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`: a batch is one transaction with one tx id.
- `docs/superpowers/specs/2026-11-08-suggest-links-existing-pages-design.md`: `suggest_links` already treats fences and code blocks as no-match zones.
- Patches 0024 (heading prefix) and 0034 (edit stamps) both mention display type.

## 3. Design

All server work is one new patch, `patches/0037-semantic-display-type-and-code-lang.patch`, in `deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`, the semantic routes' OpenAPI and a new test namespace. The connector picks up the changed OpenAPI and changes only tool text. There is no D1, semantic-index or migration change. **(panel)**

### 3.1 Allowed values (panel)

- One table, `display-type-values`: `code`, `math`, `quote`. These are the three the app sets.
- `prepare-property-value` gains a branch for `:logseq.property.node/display-type`. It takes `"code"` or `":code"` (trimmed, lower-cased), turns it into a keyword and checks it against the table. Anything else (`"cod"`, `""`, a number, `":foo/bar"`) is refused: `display-type: "cod" is not one of code, math, quote`. The server never builds a keyword that is not in the table.
- Any other `:keyword`-typed property keeps the outliner's refusal, reworded: `<title>: takes a keyword; only display-type can be set as text`. **(panel)** This narrows the issue's "any keyword property" wording to display type (section 11, question 1).
- `logseq.property.code/lang` is checked as a string of 1 to 40 characters with no whitespace, case kept (for example `mermaid`, `python`, `clojure`, `sql`). The app accepts any CodeMirror mode name, so there is no allowlist of languages.

*As built:* `prepare-property-value` takes the same text for `logseq.property.code/lang` as the explicit field, so lang through `properties`, `set_block_property` and `batch_set_block_property` follows one rule.

### 3.2 Explicit fields (panel)

- The OpenAPI `BlockTree` node gains optional `display-type` (enum `code`, `math`, `quote`) and `lang`. So insert_block_tree, insert_block_children, every batch_insert_block_trees entry and capture_to_today get them on every node.
- The `updateBlock` body gains the same two fields.
- The same values are also accepted through a node's `properties`, keyed by the ident or the title, and through set_block_property and batch_set_block_property.
- `prepare-tree` merges the two forms. A node that gives both with different values is refused, naming the path: `blocks[0].children[1]: display-type given twice ("code", "math")`. The same value twice is accepted.

*As built:* a child never takes its parent's type, so `lang` on a plain child of a code node is refused naming the child's path. Values given in `properties` and in the field are compared after conversion, so `"code"` and `":code"` count as the same value. A retried typed insert (same UUID, same fields) is a no-op, not a duplicate.

### 3.3 Cross-field guards (panel)

All are checked before anything is written. A failure refuses the whole call, naming the entry or node path.

- `lang` needs a final display type of code: `entry 2: lang needs display-type code`. It is judged on the block's state after the call or batch, as `*final-tags*` judges tags, so a batch that sets lang before display type in the same call succeeds.
- The same rule holds for display-type and lang in a `batch_insert_block_trees` entry's own `properties` on an existing block, judged across every entry and named by entry: `entries[1]: lang needs display-type code`. Those writes read back too, naming the entry.
- A display-type entry swaps the block's display class, so a batch's class check counts it as a tag write (`final-tags`): a property limited to Code takes a block the same batch makes code, and refuses one the same batch makes math, in either entry order. This holds for `batch_set_block_property` and for batch insert entry properties.
- Display type is refused on a page, tag, property or asset: `entry 0: display-type applies to blocks, not a page`.
- Writing `Code-block`, `Math-block` or `Quote-block` directly as a `:block/tags` value is refused with a pointer: `Code: set it with display-type code, not as a tag`. A block that already holds that tag gets a no-op, as `tag-value-refusal` already does for held private tags. **(call)** The app accepts tagging as a second way in (section 2.2); the server refuses it so there is one way to write a type, and the tag and display type cannot drift (section 11, question 4).
- `set-prepared-tags!` under reset keeps these three classes, as it keeps private tags, so writing back a block's tag list cannot strip its type tag.
- Private tags keep patch 0029's refusal.

### 3.4 Writing the type (panel)

A new `set-display-type!` does what the client pipeline would:

- sets the display-type keyword;
- adds the matching class tag and removes the other two;
- retracts `lang` when the type is not code;
- retracts `logseq.property/heading`, because a heading on a code, math or quote block is not rendered and would read back misleadingly (section 11, question 3).

`delete_block_property` and `batch_delete_block_property` on display type also retract the class tag and lang.

Each step goes through `outliner-property` inside the existing `atomic-write!`, `authored-write!` and batch transaction, so a call is one transaction with one tx id and gets patch 0034's edit stamps.

The server does not copy the client's "last used lang" (`:logseq.kv/latest-code-lang`) onto a code block written without one. **(call)** A block with no lang renders as plain code; Claude can say the language when it knows it.

*As built:* a class tag the block already holds is never added a second time (`held-class-tag-never-re-added-test`). A write that sets a block's type through `set_block_property` keeps the stored title, as designed; the `warnings` array (on the single and batch responses, each warning naming its entry) is how the caller learns that `\#` escapes were kept.

### 3.5 Verbatim titles (panel)

`prepare-block-title!` takes the node's final display type: from the explicit field, the property, the fence conversion or the stored block, in that order of precedence (an explicit value that conflicts with a fence is refused, section 3.6).

- **Code and math** titles are stored exactly as sent: no heading step, no inline-tag resolution or escaping, no `[[ref]]` resolution, and no `:block/refs` or `:block/tags` taken from the title. `#include <stdio.h>` stays as written on insert and on update_block, which closes the backlog item.
- **Quote** titles skip only the heading step and keep tag and ref handling, because the app renders a quote's markdown.
- `tree-block` passes the node's final type instead of `nil`, so the decision is made before the title is prepared.
- `refresh_refs` already passes the stored block, so it leaves code and math titles alone; a test pins this.

*As built:* the decision uses the block's final type in one helper, `verbatim-title?`, for every path. `refresh_refs` skips code and math titles and rewrites nothing on a quote block that has nothing left to change, so the pinned test (`headings-0024-for-typed-blocks-test`) covers all three types on insert, update and refresh. This closes README Backlog item 10 in full, including the `refresh_refs` half that the design did not name.

### 3.6 Fence conversion (issue, panel)

- On by default for insert_block_tree, insert_block_children, batch_insert_block_trees, update_block and capture_to_today. The query flag `convert-fences=false` turns it off. It is validated like `dry-run` (`true`, `false`, or refused).
- It runs only when the trimmed title starts and ends with ```` ``` ```` or `$$`. That is a string check before any mldoc parse, and the parse must give exactly one `Src` or `Displayed_Math` node, as the app's `standalone-display-block` requires.
- On update_block it runs only on a text block (no stored display type), with the app's guard: `parse-block` skips extraction for a block that already has a display type. A code, math or quote block's title is stored as sent, fence lines included, with its type and lang kept (review round 2).
- The result is the inner lines, display type code (or math) and the fence's language as lang. ```` ```mermaid ```` becomes a code block with lang `mermaid`. The app has no Mermaid renderer, so it shows as highlighted code, not a diagram; the help text says so.
- Text before or after a fence, two fences, or an unclosed fence stay text.
- An explicit display type on the same node wins only if it agrees; a conflict (a ```` ``` ```` fence with `display-type: "quote"`) is refused, naming the node.
- On an E2EE graph the title is ciphertext, so nothing is converted. Explicit fields still work there.

*As built:* a fence whose language is longer than 40 characters is also left as text and listed under `kept` with the reason `the fence's language must be 1 to 40 characters; kept as text`, because lang could not store it. The kept path is `blocks[0].children[1]` on a tree, `entries[3].blocks[0]` in a batch and `title` on update_block. Fence conversion on update_block is limited to a text block (review round 2, as noted above). `convert-fences` is a query parameter on the five operations; any value but `true` or `false` is refused before anything is written.

### 3.7 Query fences stay text (panel)

A ```` ```query ```` fence is left as text. The response lists it under `kept` as `{path, reason: "query fences stay text; a Query block is not supported yet"}`, so the outcome is visible. A real Query block needs the Query tag plus a `logseq.property/query` value entity with its own display type, and it runs Datalog on every client. It belongs in a follow-up with its own spec (section 10).

*As built:* as designed. The follow-up is left for the owner's answer to open question 5.

### 3.8 Dry run and read-back (panel)

- insert_block_tree and insert_block_children gain `dry-run=true`, using the existing `dry-run-conn`. batch_insert_block_trees already has it. Each preview node reports `display-type`, `lang` and `converted: "fence"` when a fence was converted.
- After every real write, the handler re-reads each written entity inside the transaction. If the stored display type or lang differs from what was prepared, it throws through `rejecting`: the whole call fails, nothing is committed, and the error names the entry. A successful response carries the stored `display-type` and `lang` for each block.
- set_block_property returns a warning, not a refusal, when it turns an existing text block into code or math and the stored title holds `\#` escapes from earlier writes. It suggests update_block with the title and display type together. The server cannot tell its own backslashes from the user's, so it does not remove them.

*As built:* `dry-run` on insert_block_tree and insert_block_children is a request body field, like the one on batch_insert_block_trees, not a query flag. The responses carry `display-type`, `lang` and `converted` on each block only when `verbose` is true, as the insert tools default `verbose` to false; `kept` is always present. Read-back covers insert, update, set and delete, and a mismatch answers 500 naming the entry. Tests for the tree and update paths and for delete stub the outliner to force the mismatch, as designed for the one negative test.

### 3.9 Reads (panel)

- `block-response` and `block-detail-response` (get_block, get_blocks, list_page_blocks, and the insert and update responses) gain top-level `display-type` and `lang` when set. `entity-properties-response` stays as it is.
- `get_page_outline` shows a code block as a ```` ```lang ```` fence indented under its bullet, math as `$$…$$` and quote as `> ` lines. The heading prefix is never shown on these.
- `connector/src/tools/readable.ts` shows the display type in a write's readable context.

*As built:* `get_page_outline` indents a code block's fence lines under its bullet and shows a quote block's lines with `> `. `readable.ts` adds `display-type X, lang Y` to a block's summary line only when the response carries them; a text block's line is unchanged.

### 3.10 Contract text

- Re-vendor `openapi.json` and `semantic_api_tools.mjs`, update the descriptions of update_block, insert_block_tree, insert_block_children, batch_insert_block_trees and set_block_property in `src/tools/semantic.ts`, and run `npm --prefix connector run update:manifest`.
- `connector_help` gains a section, "Code, math and quote blocks": the values, lang, fence conversion and its opt-out, verbatim titles, Mermaid (code, not a diagram), query fences (kept as text), and how to convert an existing block (update_block with the title and display type together).
- README §1 gains a bullet for patch 0037 and §11.8 an entry.
- Logseq skill note in the PR body: write code as `display-type: "code"` with a `lang`, not as ```` ``` ```` text; a whole-block fence is converted anyway; use `convert-fences=false` to keep a literal fence; query fences stay text.

*As built:* the OpenAPI changes are inside patch 0037 (stages 2 and 3), so the re-vendored files came with them. The connector-side work is the `CODE_BLOCKS_HELP` section of `connector_help`, the pointers in the five title-writing tools and the two property-set tools, and `readable.ts`. `tools-manifest.json` did not change, because it lists tool names, paths and annotations, and no tool was added, removed or renamed. README 1 and 11.8, its Backlog item 10 and the Logseq skill note were written in the docs stage; the `docs/solutions` write-up and the REVIEW.md line (section 3.11) are left to the compound step.

### 3.11 Docs and compound (panel)

- `docs/solutions/api/server-writes-skip-client-pipeline-display-type-tag.md`: the pipeline step returns early for RTC transactions, so server writes have to set the class tag themselves.
- A REVIEW.md *API and patches* line: a client-pipeline rule that skips `rtc-tx` must be mirrored by the server.

## 4. Tool contract

No tool is added or removed. Changed:

| Tool | Change |
|---|---|
| insert_block_tree, insert_block_children, batch_insert_block_trees | Each node takes `display-type` (`code`, `math`, `quote`) and `lang` (1 to 40 characters, no whitespace, only with code); also accepted in `properties` as text (`"code"` or `":code"`). Query: `convert-fences` (default true); `dry-run` on insert_block_tree and insert_block_children. Output per node: `display-type`, `lang`, `converted: "fence"`; response `kept: [{path, reason}]` for query fences. |
| update_block | Body gains `display-type` and `lang`; query `convert-fences`. Code and math titles stored verbatim. Response gains `display-type` and `lang`. |
| set_block_property, batch_set_block_property | `logseq.property.node/display-type` (or "Node Display Type") takes `"code"`, `"math"`, `"quote"`. `logseq.property.code/lang` takes a string, refused unless the final type is code. Setting the type sets the class tag, removes the others, retracts lang when not code and retracts the heading. May return `warnings`. The three classes are refused as `block/tags` values. |
| delete_block_property, batch_delete_block_property | Deleting display type also removes the class tag and lang. |
| capture_to_today | Honours `convert-fences`; nodes take the same fields. |
| get_block, get_blocks, list_page_blocks | Each block gains `display-type` and `lang` when set. |
| get_page_outline | Code as ```` ```lang ```` fences, math as `$$…$$`, quote as `> `. |

Errors name the entry or path and the reason:

- `blocks[0].children[1]: display-type: "cod" is not one of code, math, quote`
- `entry 2: lang needs display-type code`
- `entry 0: display-type applies to blocks, not a page`
- `blocks[1]: display-type given twice ("code", "math")`
- `Code: set it with display-type code, not as a tag`
- `Status: takes a keyword; only display-type can be set as text` (any other keyword property)

## 5. Cost on the Free plan

| Resource | Change per call | Cap a day |
|---|---|---|
| Worker requests | 0 (one request per tool call, as now) | 100,000 |
| D1 rows read | 0 | 5,000,000 |
| D1 rows written | 0 | 100,000 |
| Workers AI neurons | 0 | 10,000 |
| Vectorize dimensions stored | 0 | 5,000,000 |

**Sync server, per write.** Fence conversion is a string check on each title; mldoc parses a title only when it starts and ends with ```` ``` ```` or `$$`. The read-back is one in-memory DataScript entity read per written block. `set-display-type!` adds up to five datoms per block (the type, one tag added, up to two removed, the lang and heading retracts). Dry run uses the existing in-memory copy.

**Semantic indexer.** Converted blocks reach it once through the existing block-changes feed, as any edited block does. The fence markers are gone, so the embedded text is the same length or shorter and costs the same or fewer neurons.

**CPU.** The front (connector) Worker's 10 ms budget is unchanged: it only forwards. On the sync server, a 100-entry batch of fenced blocks costs 100 small mldoc parses, the same order as the tag-escaping parse every title already gets.

## 6. Safety

- **No arbitrary keywords.** Only the three values in the table become keywords; every other keyword property still refuses text.
- **No silent success.** Every write re-reads display type and lang inside the transaction and fails the whole call on a mismatch. Query fences that are not converted are listed under `kept`.
- **Up-front refusals.** Bad values, lang without code, display type on a page, the three type classes as tags, and private tags are all refused before anything is written, naming the entry.
- **No new refs from code.** A code or math title creates no page, ref or tag, so pasting code with `[[x]]` or `#include` cannot litter the graph.
- **E2EE.** Titles are never parsed for fences on an encrypted graph.
- **No deletions.** Converting a block keeps its UUID, children and other properties.

## 7. Risks

1. **Tag and type drift.** If the server forgot the class tag, the app would render the block but search and markdown mirroring would disagree. `set-display-type!` mirrors the pipeline; tests assert tag and display type together, including switching code to quote and deleting.
2. **Refs from the outliner.** If `save-block!` or `insert-blocks!` derive refs from the title on their own, `[[x]]` or `#include` inside code could still make a page or ref. A test asserts no new pages, no `:block/refs` and no extra tags after inserting and updating such a code block. If it fails, the patch strips them after the outliner call.
3. **Existing escapes.** Turning a text block into code keeps `\#` escapes the server added earlier. Mitigated by the warning and the help text (update_block with title and type together).
4. **Default-on fence conversion** changes what a whole-block fence written by the owner's skill becomes. The skill note and the opt-out cover it; a fence inside other text is never touched (tested).
5. **Heading retract** is a judgement call (section 11, question 3).
6. **Loose lang check.** A typo such as `pyhton` is stored and renders as plain code. Documented, not refused.
7. **Many write paths** (seven handlers and capture_to_today) must agree. One shared helper and one test per path guard against the drift patch 0024 found.
8. **Batch order.** Final-state checks must use the batch's final state, or setting lang before display type in one batch would be refused. A test covers it.

## 8. Testing

**Patch tests**, a new namespace `logseq.db-sync.semantic-display-type-test` added to the test runner, through the real `handle-http`, outliner and a real graph (`with-graph`, as `semantic_headings_test.cljs` does). Each is run before the fix and its failure quoted in the PR. Example data only.

1. insert_block_tree with `display-type: "code"`, `lang: "python"` and the title `# comment\n#include <stdio.h>\n[[Example]]`: stored `:code`, lang `python`, the Code-block tag, the title byte-equal to the input, no heading, no `:block/refs`, no new page. Before the fix: refused with `should be a Clojure keyword` (section 2.1).
2. The same through `properties` with `"code"` and `":code"`, through insert_block_children, through batch_insert_block_trees (and a dry run that writes nothing and reports the conversion) and through capture_to_today.
3. update_block on an existing code block with `#include` stores it verbatim (the backlog item; before the fix `\#include`, section 2.1). update_block with `display-type: "math"` converts a text block.
4. set_block_property and batch_set_block_property: `"code"`, `"math"` and `"quote"` each work; `"cod"`, `""`, `5` and `":foo/bar"` are refused naming the entry; lang without code is refused; lang before display type in one batch succeeds; code to quote removes lang and the Code-block tag; delete_block_property on display type removes the tag and lang; another keyword property given text gets the reworded refusal; display type on a page is refused.
5. A direct tag write of Code-block is refused; a reset tag list on a code block keeps Code-block; private tags are still refused (patch 0029 regression).
6. Fences: ```` ```mermaid ```` becomes code with lang `mermaid`; ```` ``` ```` with no language becomes code with no lang; `$$E=mc^2$$` becomes math; text before a fence, two fences and an unclosed fence stay text; `convert-fences=false` keeps the text; `convert-fences=maybe` is refused; ```` ```query ```` stays text and is listed under `kept`; a fence with a conflicting explicit display type is refused; on an E2EE graph nothing is converted.
7. Patch 0024: code, math and quote blocks with a `# ` line keep it on insert, update and refresh_refs.
8. Reads: get_block and get_blocks show display type and lang; get_page_outline shows the fence, `$$` and `> ` forms.
9. Read-back: a forced mismatch rejects the whole call with nothing committed. This is the one negative test that stubs the outliner, and it is labelled as such.

**Connector tests (vitest):** the generated tools carry the display-type enum and lang on `BlockTree` and update_block, `connector_help` has the new section, and the manifest check passes.

**Gate:** `scripts/check.sh --upstream` on HEAD.

## 9. Rollout and verification

Stages, one commit each:

1. Failing deftests (section 8), seen to fail, with the failures kept for the PR.
2. Patch 0037, part 1: allowed values, explicit fields, guards, `set-display-type!`, verbatim titles, read-back, reads.
3. Patch 0037, part 2: fence conversion, `kept`, dry run on the two insert tools, outline rendering.
4. OpenAPI in the patch, re-vendored `openapi.json` and `semantic_api_tools.mjs`, tool descriptions, `connector_help`, `readable.ts`, manifest, connector tests.
5. Docs: README §1 and §11.8, the `docs/solutions` write-up, the REVIEW.md line.

Deploy is by merge to main; nothing to migrate. The PR's verification section names the commit `scripts/check.sh --upstream` ran on, repeats what it skipped, and quotes the failures from stage 1. After deploy the owner can check on a real graph: insert one block with `display-type: "code"` and `lang: "python"` and one whole-block ```` ```mermaid ```` fence, then open the page in the app and see two code blocks. The roughly 30 existing fenced blocks can then be converted with update_block (title unchanged, fence conversion on), one batch per page; that is a manual step, not part of this work.

## 10. Out of scope

- **Query fences to Query blocks (issue criterion 3).** Not in the brief, and a Query block needs a query-value entity and a Query tag; a follow-up lane with its own spec.
- **Mermaid rendering.** The app has no Mermaid renderer; a ```` ```mermaid ```` block is highlighted code.
- **Other keyword properties as text.** Only display type.
- **Other display types** the app does not set (none known today).
- **Bulk conversion** of existing fenced blocks; the owner or Claude does it with update_block.
- **Removing old `\#` escapes** from existing blocks.
- **`latest-code-lang`** defaulting.
- **A D1 table, migration or semantic-index change.**

## 11. Open questions for the owner

1. **Other keyword properties.** The issue asked for any keyword-typed property to take a string. This design allows only display type and keeps refusing the rest. Do you have another keyword property you want written?
2. **Fence conversion on by default.** Is on-by-default right for update_block too, or only for inserts? On means rewriting one of the 30 fenced blocks with its current title converts it.
3. **Heading on a typed block.** Setting a type retracts `logseq.property/heading`. Would you rather keep it stored and hide it only in reads?
4. **Tagging with Code.** The app lets you tag a block with Code to make it a code block. The server refuses that and points to display type. Should it instead accept the tag and set the type, as the app does?
5. **Query fences.** Leave as text and report under `kept` for now, with a follow-up item for real Query blocks. Do you want that follow-up added to the issues page?
6. **Lang check.** Any 1 to 40 characters without whitespace. Do you want a short allowlist (python, clojure, sql, mermaid, bash, …) that refuses typos instead?
