# Tool routing hints as each description's first line: design

Date: 2026-11-20
Issue: item 68 on the tracker ("Make each tool description's first line a routing hint"), raised as the follow-up to item 57. Areas: connector, docs.
Branch: `feat/tool-routing-hints`, at `5506eac` ("docs(learnings): item 51 do-cpu-probe analytics fix…"), stacked on PR 70 (`fix/do-cpu-probe-analytics`) and the bug-fix stack PRs 59 to 69, 0 commits behind it.
Upstream: `logseq/logseq` at `UPSTREAM_REF` (`e7e9c97`), `deps/db-sync`, with patches 0001 to 0049. This work adds no patch and changes none.
Builds on: `2026-11-07-readable-tool-calls-reason-targets-design.md` (the `ANNOTATIONS` table, which this copies), `2026-11-17-named-queries-as-code-design.md` (format), `docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md` and `docs/solutions/connector/an-issue-found-in-review-may-be-fixed-by-the-work-it-was-found-in.md` (tools/list equality with the manifest and `ANNOTATIONS` is already pinned in `connector/test/tools.test.ts`).

The design panel chose the "minimal" proposal: one table of first lines beside `spec.mjs`, applied where each description is built, recorded in the manifest. No ideas were grafted from other proposals. Decisions marked **(call)** were made while writing this spec; the ones most worth a second look are in section 11.

**What was checked for this spec, at `5506eac`.** There is no bug to reproduce, but the problem's claim was checked against the code. `description(op)` in `connector/src/tools/semantic.ts` (line 126) puts `op.operation.summary` first and joins the rest with `"\n\n"`, so a generated tool's first line is the OpenAPI summary. A throwaway Node script in the scratchpad ran `graphOperations` (from `spec.mjs`) over `connector/vendor/openapi.json`:

- 47 generated operations, every one with a summary and a description. Summaries average 20 characters and range from `List tags` (9) to `Insert block trees into several pages` (37). None says when to choose the tool: `Create a page`, `Get a page`, `List pages`, `Search graph resources`, `Run a read-only Datalog query`.
- 10 hand-written tools (`HANDWRITTEN_TOOLS` in `spec.mjs`), registered by 10 `registerTool` calls in `handwritten.ts` (2), `kb-index.ts` (1), `semantic-search.ts` (2), `assets.ts` (3), `activity-log.ts` (1) and `suggest-links.ts` (1). Their descriptions are one paragraph with no newline, so the whole paragraph is the "first line".
- `tools-manifest.json` has **57** entries. The winning proposal said 61 tools and 11 hand-written calls; the real numbers are 57 and 10, and this spec uses them.
- No test or source asserts a summary string (`Create a page`, `List DB tasks` and the like), so dropping the summaries breaks no existing assertion.

The draft first lines in section 3.6 were checked by the same script against the rules in section 4: all 57 present, no orphans, at most 100 characters (longest 100, mean 87.8), no digits, each ending with a full stop, and every snake_case word a registered tool.

## 1. Goal

claude.ai lists a connector's tools with each description cut to its first line, and loads the full text only after a tool search. Claude picks between similar tools (`get_page` and `get_page_outline`, `search_graph`, `semantic_search` and `kb_index`, `move_blocks` and `batch_move_blocks`) from that line alone. Today the line is a bare OpenAPI summary or the start of a long paragraph. Each tool's first line should instead say when to choose it over its neighbours.

Acceptance (the brief):

1. Every tool's description starts with its own first line from a table in the connector, short enough to survive claude.ai's cut, checked by a test through tools/list.
2. A tool with no first line fails the test, so new tools must add one.
3. README §11.8 records that claude.ai attaches the server instructions to a tool result rather than loading them up front, and how each app delivers them.
4. `tools-manifest.json` and its check stay consistent (regenerated with `npm --prefix connector run update:manifest`).
5. The spec states the length budget with its source (a real limit found, or an explicit assumption) and the Free-plan cost of a larger tools/list response.
6. `connector_help` text and the PR's Logseq skill note are updated if description behaviour changes.

## 2. Context

**How each app shows tools.** The brief, from item 57, says claude.ai shows each tool by the first line of its description and loads the full description after a tool search, and that it attaches the server instructions (`SERVER_INSTRUCTIONS`, sent in the MCP `initialize` result) to a tool result rather than putting them in context up front. This spec takes that as the owner's observation; it was not reproduced here, because claude.ai's client is not reachable from this session. Claude Code puts the server instructions in the session's context at start and defers tool schemas behind its tool search; in this session's Claude Code build, deferred MCP tools are listed by name only, with no description at all. README §11.8 currently says "Whether claude.ai uses server instructions is not yet checked."

So on claude.ai, until a tool has been called, the only routing Claude sees is the tool names and first lines. The routing bullets in `SERVER_INSTRUCTIONS` (kb_index first, search_graph for exact words, semantic_search for meaning, list_tasks for tasks, run_named_query before datalog_query) arrive late, and `connector_help` only when called.

**Where descriptions are built.** Generated tools: `buildGraphTools` in `semantic.ts` records each operation from upstream's `registerSemanticApiTools` and sets `description: description(op)`, once per isolate. Hand-written tools: each `registerTool` call passes a literal string (or `SUGGEST_LINKS_DESCRIPTION`), per request that builds a server. Annotations already follow a central-table pattern: `ANNOTATIONS` and `annotationsFor(name)` in `spec.mjs`, which throws for a missing tool, and `buildManifest` records them, so a missing entry fails both the Worker and `check:manifest`.

**No documented limit.** Neither the repo, the MCP specification (which has no list-view limit) nor anything checked for this spec gives claude.ai's cut length. Section 3.4 sets the budget as an assumption.

## 3. Design

### 3.1 The table (call)

A new plain-JavaScript module, `connector/src/tools/first-lines.mjs`, beside `spec.mjs`, so `scripts/check-tools-manifest.mjs` can import it under Node without a build step, as it does `spec.mjs`. It exports:

- `FIRST_LINE_MAX = 100`, the length budget (3.4).
- `FIRST_LINES`, a frozen record keyed by tool name, one routing sentence for each of the 57 tools, generated and hand-written, including `semantic_search` and `semantic_index_status`.
- `firstLineFor(name)`, which returns the line or throws `no first line for tool <name>`, as `annotationsFor` does.
- `withFirstLine(name, rest)`, which returns `` `${firstLineFor(name)}\n\n${rest}` ``.

Each line says when to pick the tool, usually by naming the neighbour to use instead (`get_page: One page's tags and properties only; to read its blocks use get_page_outline.`). Lines carry no counts or limits, which stay in the body where constants feed them (`count-claims-in-tool-text-must-come-from-the-implementation.md`).

### 3.2 Generated tools (call)

`description(op)` begins with `firstLineFor(op.name)` in place of `op.operation.summary ?? \`${op.method} ${op.path}\``. The OpenAPI summary is dropped, because the first line replaces it and a second short line would only repeat it. The rest (the operation's description, `HINTS`, and the FENCE, DISPLAY_TYPE, CLASS_SCHEMA, STAMP and HOLDER_STAMP sentences) follows after `"\n\n"` as now. The fallback to `method path` goes too: a generated operation without a first line now throws inside `buildGraphTools`, which fails the Worker's first tools/list and the manifest build, never a silent default.

### 3.3 Hand-written tools (call)

The 10 `registerTool` calls each pass `description: withFirstLine("<name>", <existing text>)`. The existing text is kept word for word, so every current `toContain` assertion on it holds. The separator is a newline because claude.ai cuts at the first line; the old one-paragraph descriptions therefore no longer reach the list view, and their opening sentence is now the second paragraph.

### 3.4 Length budget (call, an assumption)

`FIRST_LINE_MAX = 100` characters. **This is an assumption, not a measured limit.** No claude.ai limit is documented in the repo or the MCP specification, and none was measured. 100 characters is about one line of claude.ai's tool list at desktop width. (The winning proposal also cited a roughly 120-character cut in Claude Code's deferred-tool listing; this session's Claude Code lists deferred MCP tools by name only, so that source is not used.) The constant is tunable. A closeout step asks the owner to look at the claude.ai connector tool list after deploy and say whether any line is cut; if one is, a follow-up lowers the constant and shortens the lines, and the test enforces the new budget.

The risk if claude.ai cuts at the first sentence rather than the first newline is small, because every line is one sentence. If it cuts by characters shorter than 100, the semicolon puts the "what" before the "instead use", so the first half still reads.

### 3.5 Manifest (call)

`buildManifest` adds `firstLine: firstLineFor(name)` to every entry, and `describeEntry` adds the line to the diff text. A changed or added line therefore shows in the `tools-manifest.json` diff of a PR, and `npm run check:manifest` fails until `npm --prefix connector run update:manifest` regenerates it. A missing entry makes `buildManifest` throw under plain Node, so `scripts/check.sh` fails even without vitest. The manifest grows by about 6 KB (57 lines plus keys); it is a repo file, not part of the Worker bundle.

### 3.6 The draft lines (call; wording for review)

Written against the descriptions at `5506eac`. The build may reword lines, within the rules in section 4; each tool name a line mentions is listed whenever that tool is (the two semantic tools are named only from each other and from `search_graph`, which is acceptable on a graph without semantic search because `SERVER_INSTRUCTIONS` already says "where listed"; see risk 4).

| Tool | First line | Length |
|---|---|---|
[] 57 avg 87.8 max 100
| `batch_delete_block_property` | Remove properties from many blocks in one write; for one block use delete_block_property. | 89 |
| `batch_insert_block_trees` | Build or fill several pages in one write, creating missing pages; for one target insert_block_tree. | 99 |
| `batch_move_blocks` | Move blocks to several different targets in one write; to one target use move_blocks. | 85 |
| `batch_set_block_property` | Tag or set properties on many existing blocks in one write; for one use set_block_property. | 91 |
| `capture_to_today` | Append notes to today's journal; for any other page use insert_block_tree. | 74 |
| `connector_help` | Writing rules for tags, properties, headings and batching; read once before the first write. | 92 |
| `create_page` | Make one empty page by title; to make a page with content, use batch_insert_block_trees. | 88 |
| `create_property` | Define a new property with its type, choices and classes; to change one use update_property. | 92 |
| `create_tag` | Define a new tag with its parents and properties; to convert a page use promote_page_to_tag. | 92 |
| `create_task` | Make a task on a page or today's journal, with status and dates; never write TODO text. | 87 |
| `datalog_query` | Ask a custom read-only Datalog question; try run_named_query first when one of its queries fits. | 96 |
| `delete_block` | Delete one block and its children; for several blocks use delete_blocks. | 72 |
| `delete_block_property` | Remove one property value from one block; for many blocks use batch_delete_block_property. | 90 |
| `delete_blocks` | Delete several blocks in one write, with a dry run; for a whole page use delete_page. | 85 |
| `delete_page` | Delete a page and all its blocks, with a dry run; to remove only some blocks use delete_blocks. | 95 |
| `delete_property` | Delete a property definition and its values everywhere; to remove a value use delete_block_property. | 100 |
| `delete_tag` | Delete a tag definition; to untag one block set its Tags with set_block_property. | 81 |
| `get_activity_log` | What the connector changed in this graph and why, newest first; not edits made in the app. | 90 |
| `get_block` | One block's tags and properties; for many blocks get_blocks, for a whole page get_page_outline. | 95 |
| `get_blocks` | Tags and properties for many blocks by UUID in one call; for one block get_block. | 81 |
| `get_graph_health` | Review the graph: unused tags and properties, duplicate titles, pages without a summary. | 88 |
| `get_page` | One page's tags and properties only; to read its blocks use get_page_outline. | 77 |
| `get_page_backlinks` | How a page is used, grouped by links, tags and property values; flat list: list_page_references. | 96 |
| `get_page_outline` | Read a whole page as markdown with its tags, properties and blocks; the usual way to read a page. | 97 |
| `get_property` | One property definition with its type, choices and classes; to list them all use list_properties. | 97 |
| `get_tag` | One tag definition: its parents and properties; for the objects tagged with it use list_tag_objects. | 100 |
| `insert_block_children` | Add child block trees under an existing block; for a whole note on a page use insert_block_tree. | 96 |
| `insert_block_tree` | Write a whole nested note to one page or block; for several pages use batch_insert_block_trees. | 95 |
| `kb_index` | Start here for broad questions: pages grouped by class with summaries; for exact words search_graph. | 100 |
| `list_assets` | Page through file assets by time; to read one use read_file. | 60 |
| `list_favorites` | The sidebar's favourite pages in order; to change them use set_page_favorite or reorder_favorites. | 98 |
| `list_graphs` | Call first: lists the graph aliases every other tool takes, and each graph's mode. | 82 |
| `list_page_blocks` | Page through a page's top-level blocks as data; to read the page use get_page_outline. | 86 |
| `list_page_references` | Flat list of what references a page; get_page_backlinks groups the same by kind with counts. | 92 |
| `list_pages` | Page through every page by title; for an overview with summaries use kb_index. | 78 |
| `list_properties` | Page through all property definitions; for one property use get_property. | 73 |
| `list_tag_objects` | Page through the blocks and pages tagged with a tag; for tasks use list_tasks. | 78 |
| `list_tags` | Page through all tag definitions; for one tag use get_tag. | 58 |
| `list_tasks` | Find tasks by status, priority or text; use this instead of search_graph for tasks. | 83 |
| `move_blocks` | Move blocks under one target, with a dry run; to several targets use batch_move_blocks. | 87 |
| `promote_page_to_tag` | Turn an existing page into a tag in place, keeping its links; create_tag refuses a used title. | 94 |
| `read_file` | Read a file asset back as text or an image; to find assets use list_assets. | 75 |
| `refresh_refs` | Repair blocks whose tags or links were stored as plain text; not needed after normal writes. | 92 |
| `reorder_favorites` | Set the order of the sidebar's favourites; to add or remove one use set_page_favorite. | 86 |
| `run_named_query` | Run one of the built-in named queries; for any other question about the data use datalog_query. | 95 |
| `save_document` | Save text or bytes you hold as a file asset, such as a transcript; for a URL use save_file_from_url. | 100 |
| `save_file_from_url` | Download a public https file into the graph as an asset; for text you hold use save_document. | 93 |
| `search_graph` | Find exact words in titles; for meaning use semantic_search, for an overview kb_index. | 86 |
| `semantic_index_status` | Whether the semantic index is ready and how much it holds; check when semantic_search seems thin. | 97 |
| `semantic_search` | Find blocks by meaning, merged with title matches; for exact words search_graph is cheaper. | 91 |
| `set_block_property` | Set one property, or Tags, on one block or page; for many blocks use batch_set_block_property. | 94 |
| `set_page_favorite` | Add or remove one page from the sidebar's favourites; to change the order use reorder_favorites. | 96 |
| `suggest_links` | Before writing a note, find existing pages it names so you can link them; writes nothing. | 89 |
| `update_block` | Change one block's text; for its properties use set_block_property. | 67 |
| `update_page` | Rename a page; for its properties use set_block_property, for its blocks the insert tools. | 90 |
| `update_property` | Change a property's choices, classes or type, with a dry run; to create one use create_property. | 96 |
| `update_tag` | Change a tag's parents or properties; to delete it use delete_tag. | 66 |

### 3.7 Docs (call)

README §11.8, beside the **Server instructions** bullet, gains a short bullet: each tool's description opens with a one-line routing hint from `connector/src/tools/first-lines.mjs`; claude.ai lists tools with only that line and loads the full text after a tool search; claude.ai attaches the server instructions to a tool result rather than loading them up front (as the owner observed, item 57), so until then the first lines carry the routing; Claude Code sends the instructions at session start and defers tool schemas behind its tool search; the budget is 100 characters, an assumption, checked by the owner after deploy. The existing "Whether claude.ai uses server instructions is not yet checked" sentence is replaced by that statement.

`connector_help`: **no change.** No tool's behaviour changes, only the opening of its description, and `connector_help` already says which tool to use when. `SERVER_INSTRUCTIONS`: no change. The PR's Logseq skill note says the owner's skill needs no change, and that it may cite the first lines as the authoritative one-line routing summary.

## 4. Tool contract

No tool is added, removed or renamed, and no input schema or annotation changes. For every tool, tools/list `description` equals `<FIRST_LINES[name]>\n\n<rest>`:

- Generated tools: `rest` is the operation description plus the existing hints. The OpenAPI summary is no longer in the description.
- Hand-written tools: `rest` is the existing description, unchanged.

Invariants, each enforced by a test:

- The first line is at most `FIRST_LINE_MAX` (100) characters, contains no newline and ends with a full stop.
- It contains no digits.
- Every snake_case word in it (`/\b[a-z]+(?:_[a-z]+)+\b/`, the same pattern the server instructions test uses) is a registered tool, so a line can't use other snake_case words.
- The keys of `FIRST_LINES` equal the keys of `ANNOTATIONS` and the registered tool names.

`tools-manifest.json` entries gain `firstLine: string`. Exports from `first-lines.mjs`: `FIRST_LINE_MAX: number`, `FIRST_LINES: Readonly<Record<string, string>>`, `firstLineFor(name): string` (throws `no first line for tool <name>`), `withFirstLine(name, rest): string`.

## 5. Cost on the Free plan

- D1: 0 rows read, 0 written, per call and per day. Workers AI: 0 neurons. Vectorize: 0 dimensions. KV: 0 reads or writes.
- Worker requests: none added; tools/list is one MCP request whether or not this lands.
- CPU: generated descriptions are built once per isolate in `buildGraphTools`. The 10 hand-written ones add one string concatenation each per request that builds a server, microseconds against the front Worker's 10 ms.
- Response size, estimated from the draft lines: 57 lines at a mean of 87.8 characters is about +5.0 KB; the 47 dropped summaries (mean 20 characters) are about -0.9 KB; the 10 hand-written separators add 20 bytes. Net about **+4.1 KB per tools/list**, roughly +1,000 tokens of Claude context once the full list loads, and the first lines are what claude.ai shows before that. The build stage measures the exact JSON byte size of tools/list before and after (with semantic search on) in the test run, and records both here under As built and in the PR.
- Bundle size grows by the same few KB, far under the Free plan's 3 MiB compressed Worker limit.

## 6. Safety

Nothing writes to a graph, stores state or touches auth, so a dry run, a guard or a read-back on the owner's graph does not apply. The read-back here is the test reading the real tools/list from the server as `mcpHandler` builds it. A missing first line fails closed: the Worker throws while building tools and the manifest check fails, rather than serving a tool with a default line. The lines are static text in the bundle; nothing from a graph reaches them.

## 7. Risks

1. **The budget is an assumption.** claude.ai may cut shorter than 100 characters, or by sentence. Mitigations: one sentence per line, the "what" before the semicolon, a tunable constant, and the owner's post-deploy check (section 9).
2. **Routing text in three places can drift.** `FIRST_LINES`, `SERVER_INSTRUCTIONS` and `connector_help` all say which tool to use when. A line could advise against what the instructions advise. Mitigations: the test that every tool a line names is registered; review checks the lines against the instructions' routing bullets (kb_index, search_graph, semantic_search, list_tasks, run_named_query versus datalog_query, create_task versus TODO text).
3. **Upstream wording is dropped.** A later upstream bump that changes an operation's meaning won't change its first line. A new or removed operation still fails `firstLineFor` and shows in the manifest diff; a changed meaning needs a look at the first line on each `bump-upstream` PR. The `bump-upstream` PR template or checklist should say so (section 9).
4. **Semantic tools are conditional.** `semantic_search` and `semantic_index_status` are registered only when semantic search is on. `search_graph`'s line names `semantic_search`; on a deployment with it off, Claude would see a name it can't call. Mitigation options are in section 11; the draft keeps the name because `SERVER_INSTRUCTIONS` already names it with "where listed".
5. **Stacked branch.** PRs 59 to 70 changed tool text (patches 0044 to 0049, `connector_help`). The lines were written against HEAD; a rebase could conflict in `semantic.ts` `HINTS` or the hand-written descriptions, and a changed tool may need its line re-read.
6. **Lines that make claims.** A line like `refresh_refs: … not needed after normal writes` or `semantic_search: … search_graph is cheaper` states behaviour. Review checks each claim against the body and the implementation, as the count-claims learning asks.

## 8. Testing

All checks run on the real server in `connector/test/tools.test.ts`, through tools/list from the server as `mcpHandler` builds it with `semanticOnEnv()`, so all 57 tools are covered. A new `describe("first lines")` block:

1. For each tool, `description.split("\n")[0] === FIRST_LINES[name]`, the second line is empty, and the remainder is non-empty and does not start with the line again.
2. Each line is at most `FIRST_LINE_MAX` characters, has no digits and ends with `.`. A failure names the tool and the length: `save_document: first line is 112 characters, budget 100`.
3. The keys of `FIRST_LINES` equal the keys of `ANNOTATIONS` and the registered names: no orphans, none missing.
4. Each snake_case word in a line is a registered tool.
5. Fail-closed: `firstLineFor("no_such_tool")` throws `no first line for tool no_such_tool`; `buildManifest` throws for a spec fixture with an extra operation, mirroring the existing annotations fail-closed test.
6. The existing manifest equality test and `check:manifest` under Node pass on the regenerated manifest, and a hand-edited `firstLine` in a copy of the committed manifest makes `checkManifest` report a `+`/`-` pair.
7. The existing description `toContain` assertions stay green, showing the body text is unchanged.

**Seen to fail.** Write tests 1 to 3 before the table and quote the failure on HEAD in the PR (expected along the lines of `create_page: expected 'Create a page' to be '<line>'`, or the import failing because `first-lines.mjs` doesn't exist yet; quote whichever it is). Then add the table and the two call sites.

Run `scripts/check.sh` on the final commit and repeat in the PR what it skipped. `--upstream` is not needed: `patches/` is untouched.

## 9. Rollout and verification

1. Merge to main deploys the connector (`deploy` workflow). Nothing to migrate or switch on.
2. After deploy, the owner opens claude.ai's connector tool list and reports whether any first line is cut, and where. If cut, a follow-up lowers `FIRST_LINE_MAX` and shortens lines.
3. The owner may also check one routing case in a fresh claude.ai chat (for example "what do I know about X" reaching `kb_index` before `search_graph`). This is a spot check, not a gate.
4. Add a line to the `bump-upstream` workflow's PR body (or `docs/lanes` checklist) asking the reviewer to re-read the first line of any operation whose upstream summary or description changed.
5. Record the measured tools/list sizes and the owner's check under an As built section of this spec.

## 10. Out of scope

- Rewriting description bodies, `HINTS`, `SERVER_INSTRUCTIONS` or `connector_help`.
- Renaming tools to route better, or merging neighbouring tools.
- Changing which tools are listed when semantic search is off, or per client.
- Measuring claude.ai's cut automatically; it is an owner check after deploy.
- Upstream's OpenAPI summaries (no patch changes them; the connector drops them).

## 11. Open questions for the owner

1. **Budget.** Is 100 characters right, given what you see in claude.ai's tool list? If you can see the list now, the longest current first lines (the hand-written paragraphs) show where it cuts.
2. **claude.ai and server instructions.** The README will say claude.ai attaches the server instructions to a tool result rather than loading them up front, on your observation from item 57. Is that what you saw, and on which surface (web, desktop, mobile)?
3. **Semantic names when semantic search is off.** `search_graph`'s line names `semantic_search`, which isn't listed when semantic search is off. Keep it (the server instructions already say "where listed"), add "where listed" to the line, or build that line from the semantic config?
4. **Dropping the OpenAPI summary.** Fine to drop upstream's summary from generated descriptions entirely, or keep it as the second paragraph?
5. **Wording.** Any of the 57 draft lines in 3.6 you'd route differently, especially `refresh_refs`, `get_activity_log` and `delete_tag`?
6. **Spec file name.** The lane's driver note named this file `2026-11-20-tool-routing-hints-design.md`; the stage that wrote it was told `2026-11-20-tool-routing-hints-first-line-design.md`, which is what was used. Rename if you prefer the shorter name.
