# suggest_links: link existing pages in content Claude writes: design

Date: 2026-11-08
Issue: 22, "suggest_links: link existing pages in content Claude writes". Labels: enhancement, linking. Priority Medium. Depends on item 27 (shared stopword list and tokeniser), memory ranking and item 2 (semantic search), which are all done on this branch.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0035 applied. This work adds patch 0036 and no migration.
Branch: `claude/relaxed-maxwell-s4r8o4-phase4`, stacked on the earlier phases, 2 commits behind `origin/main`, at `c210e53`.
Tier: intake suggested standard. The design needs patch 0036, so the build runs as **full** (`scripts/check.sh --upstream` and upstream's db-sync suite).

Decisions marked **(issue)** come from the issue. Decisions marked **(brief)** come from the owner's brief, which overrides the issue where they differ. Decisions marked **(panel)** come from the design panel's winning design ("named"); no grafts were offered. Decisions marked **(call)** were made while writing this spec, including where it corrects the panel after reading the code. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Logseq's editor plugins that link unlinked references run only on edits made in the app. Notes Claude writes through the connector therefore keep plain-text mentions of pages that already exist: a stand-up note says "Operational Intelligence" where the graph has a page of that name, and the page's backlinks never show the note.

This design adds a read-only tool, `suggest_links`, that takes draft text and returns the `[[links]]` it could carry: each suggestion gives the matched span, the page's title and UUID, and why it matched. It also returns the draft with the links applied (`linked_text`), so Claude can show or diff it and then write it with the tools it already has. The tool writes nothing.

Acceptance (issue and brief):

1. Draft text containing an existing page's title (case-insensitive, whole word) returns a suggestion with the matched span, page title, page UUID and a reason. The longest title wins over a shorter one it contains ("Workflow Intelligence" over "Workflow").
2. Alias matches are returned and say they matched an alias.
3. Text already inside a `[[link]]`, a URL, inline code, a code block, a math span or a quote is never matched.
4. Pages tagged private, and the page being written, are never suggested.
5. Short or common titles (a stoplist built on item 27's `STOPWORDS`) are not suggested.
6. The tool is read-only: it makes no write calls, and the manifest marks it read-only.
7. Semantic matches, if included, are bounded in neurons and sync calls per call; the Free plan budget and the front Worker's 10 ms CPU limit are stated and tested or counted.
8. Tests use example data only (`sync.example.com`, example pages) and were seen to fail before the implementation.
9. Tool description, `connector_help`, `tools-manifest.json`, README 11.8 and the Logseq skill note in the PR body are updated.
10. `scripts/check.sh` passes on HEAD, and the PR's verification names the commit and any skipped checks.

**(brief)** The issue proposed an apply mode (the tool writes the links) and a graph-wide mode (scan existing pages). The brief makes the tool read-only, so apply mode is out. The panel left graph-wide mode out too (section 10).

## 2. Context

This is a feature, not a bug, so there is no failure to reproduce. Every fact below was checked by reading the code on HEAD (`c210e53`) and the patched upstream in `.upstream/`; none was run. Where a fact decides the design, the file is named.

**kb_index already holds the candidate set.** `connector/src/tools/kb-index.ts` pages through the sync server's `listKnowledgeIndex` (patch 0013) 200 pages a request, at most 100 requests (20,000 pages; more is refused, not truncated), and caches the result per graph alias in `KB_INDEX_KV` under `kb-index:<alias>` as `{graphId, builtAt, pages}`. `freshRecord` accepts the cache only for the same graph id, under two hours old (`KB_INDEX_MAX_AGE_MS`) and not dirty (`kb-index-dirty:<alias>`, written after `create_page`, `update_page`, `delete_page`, `promote_page_to_tag`, `update_tag` and `delete_tag`). The hourly cron (`refreshAllKbIndexes`) rebuilds every graph's record.

**What is in the index.** `knowledge-index-pages` in `graph_insights.cljs` takes `user-page-ids`: entities tagged `:logseq.class/Page` that are visible (`hidden-id?` drops anything hidden or in the Recycle bin, itself or through a parent), not built in, and not server-created author pages. It then drops pages tagged with, or with a tag extending, a class in `exclude-tags`; kb_index passes `KB_INDEX_PRIVATE_TAGS` = `["private"]`. Journals are tagged Journal, not Page, so they are not in it. Tags (classes) and properties are tagged Tag and Property, so they are not in it either, unless an entity also carries the Page tag. The panel's risk that user classes such as Project would be suggested is therefore probably wrong; Stage 1 confirms it with a test (section 8).

So the private-page rule (acceptance 4) costs nothing: a private page never reaches the cache, and `suggest_links` agrees with `kb_index` on what is private.

**The index has no aliases.** `knowledge-index-entry` (patch 0013) emits `uuid`, `title`, `tags`, `classes`, `reference-count`, `created-at`, `updated-at` and an optional `summary`. It does not read `:block/alias`. The connector's `KbIndexEntry` matches it. Alias matching (acceptance 2) therefore needs the server to send aliases, which is patch 0036.

**A full record is too big to parse per call.** A record carries a summary of up to 240 characters a page, tags and classes. At 20,000 pages that is several MB of JSON, and `JSON.parse` of that alone would use the front Worker's 10 ms CPU (`docs/solutions/cost/per-entry-intl-formatters-burn-the-cpu-budget.md` is the last time a per-entry cost did). The matcher needs only uuid, title and aliases.

**getBlocks can verify a cached UUID cheaply.** Patch 0035 added `view=signals` to `getBlocks`: up to 100 UUIDs a call, per entity only uuid, updated-at, reference count and status, with no title or text. `bulk-read-response` resolves each id with `find-visible-entity`, which uses `entity-util/hidden?`; that is true for hidden entities and for anything with `:logseq.property/deleted-at` on it or a parent. So a page deleted or moved to the Recycle bin since the cache was built comes back under `missing`, and the call does not fail. Patch 0035's `signals-shape-missing-and-limits-test` covers unknown and hidden UUIDs under `missing`. This settles the panel's open risk about getBlocks refusing on a missing UUID.

**The tokeniser to share.** `connector/src/semantic/ranking.ts` exports `STOPWORDS` (47 words) and `contentWords`, which lower-cases and splits on `/[^\p{L}\p{N}]+/u`. It returns words, not offsets, so it cannot place a span.

**Semantic search is optional.** `mcp.ts` registers the semantic tools only when `semanticBindings(env)` finds the AI and Vectorize bindings; `isolateTools` then builds a `SemanticStore` over D1. `suggest_links` follows the same rule for its related leg.

**KV budget.** The Free plan allows 100,000 KV reads and 1,000 KV writes a day, account-wide. The cron writes one `kb-index:` key per graph an hour, 24 a day per graph.

## 3. Design

### 3.1 Patch 0036: aliases on knowledge-index entries (panel)

`patches/0036-semantic-knowledge-index-aliases.patch` changes `knowledge-index-entry` to add `:aliases`: the titles of the page's `:block/alias` targets that are visible (not hidden, not recycled), sorted, and `[]` when there are none. The key is always present, so the connector can tell a version-2 server answer from an old one. It updates the `listKnowledgeIndex` OpenAPI description to name the field and adds it to the response schema.

The deftest (in the db-sync suite, which CI runs): a page with two aliases lists both titles, sorted; a page with none has `[]`; an alias target that is hidden or in the Recycle bin is left out. The OpenAPI description test is updated.

`connector/vendor/openapi.json` is regenerated by `vendor-upstream-api.sh`. `kb_index` output does not change.

### 3.2 kb_index cache: version 2 and a titles key (panel)

`KbIndexEntry` gains `aliases?: string[]`. `KbIndexRecord` gains `version: 2`. `freshRecord` treats a record without `version: 2` as stale, so a record cached before the deploy rebuilds on first use instead of silently matching no aliases for up to two hours. That costs one rebuild per graph, once: `ceil(pages / 200)` sync requests.

`rebuildKbIndex` also writes a slim key, `kb-index-titles:<alias>`:

```
{ graphId, builtAt, version: 2, pages: [[uuid, title, aliases], ...] }
```

About 60 bytes a page, so about 1.2 MB at 20,000 pages. Both keys come from one fetch and carry the same `builtAt`.

A new `freshTitles(access, alias, now)` reads the titles key and the dirty key and accepts the titles under the same rules as `freshRecord`: same graph id, `version: 2`, under the max age, and not dirty since `builtAt`. Otherwise `suggest_links` calls `rebuildKbIndex`, which rewrites both keys, and uses the titles from the record it returns. **(call)** Because both readers apply the same rules to the same `builtAt`, a failed write of one key shows up as a stale key and a rebuild, not as the two keys drifting apart. The titles key gets the same `expirationTtl` as the record.

*As built (Stage 3):* one `isFresh` rule in `kb-index.ts` serves `freshRecord` and `freshTitles`, each reading its key and the dirty key (2 KV reads). A rebuild writes the titles key first and the record second, so a failed write never leaves a record newer than its titles. A titles key older than the record is rebuilt when the shared rule makes it stale (dirty since its `builtAt`, or past the max age), not merely for being older: comparing the two `builtAt`s would cost a third KV read of the large record on every warm call.

**(call)** An alias page is a page in its own right (tagged Page), so it is also in the index as its own entry. When a page's title equals (ignoring case) an alias of another page in the index, the standalone entry is dropped as a candidate and the title only matches as the alias of its target. Otherwise "OI" would give an ambiguous suggestion between the alias page and its target.

### 3.3 The matcher (panel)

A pure function in `connector/src/tools/suggest-links.ts`, with no I/O, unit-tested on its own:

```ts
matchLinks(text: string, titles: TitlesPage[], opts: { exclude: Set<string>; limit: number }): MatchResult
```

**a. Masking.** One linear scan marks protected ranges, which no match may touch:

- fenced code (```` ``` ````), and `#+BEGIN_SRC`, `#+BEGIN_QUOTE` and `#+BEGIN_EXPORT` blocks up to their `#+END_`;
- inline `` `code` ``;
- `$$…$$` and `\(…\)` math. A single `$` is left alone so prices still match (risk in section 7);
- lines whose content, after the outline's `- ` and indentation, starts with `>`;
- `[[…]]` links, `#tag` and `#[[…]]`, `((block refs))` and `{{macros}}`;
- markdown links `[text](url)`, both parts;
- bare URLs (`scheme://…` and `www.…`, to the next whitespace);
- property keys before `::`.

*As built (review round 1):* inline code closes on a run of as many backticks as opened it, so ``` ``code with `x` inside`` ``` is one range. A match is also refused when the rest of its run of non-space characters holds `@`, `/`, `\`, `_` or a `.` before a letter or digit, so a title is never linked inside an email address (`jane@acme.com`), a bare domain (`acme.com/pricing`), a path (`~/code/react`, `.github/workflows/workflow.yml`) or an identifier (`acme_api_key`). This is a rule on the match, not a mask, so a title with a dot of its own (`Node.js`) still matches; punctuation inside the match is the title's own.

Every `[[Title]]` or `#[[Title]]` or `#Title` in the draft also goes into an already-linked set, matched ignoring case against titles and aliases. A page already linked anywhere in the draft is never suggested and is listed under `already_linked`.

**b. Tokenising.** A new export in `semantic/ranking.ts`:

```ts
wordSpans(text: string): { word: string; start: number; end: number }[]
```

It matches `/[\p{L}\p{N}]+/gu`, the same character class `contentWords` splits on, so item 27's tokeniser and `STOPWORDS` stay shared. `start` and `end` are JavaScript (UTF-16) string offsets into the original text; `word` is that slice lower-cased. **(call)** Offsets are taken before lower-casing, because `toLowerCase` can change a string's length (`İ` becomes two code units), which would shift every later span. `contentWords` is unchanged, so semantic search ranking does not move.

**c. Candidate map, sized by the draft.** The draft's distinct lower-case words form a Set. For each title and alias, the first word is found with a cheap scan (no regex); only if it is in the Set is the title tokenised with `wordSpans` and added to a map keyed by its first word. Matching cost then grows with the draft and the titles that could match it, not with the graph. Titles that tokenise to nothing (all punctuation or emoji) are skipped. An exported counter records how many titles were tokenised, so a test can assert the bound (section 8).

*As built (Stage 2):* the counter is `MatchResult.tokenised`, not module state. The first-word scan is a loop over ASCII names; a name with a non-ASCII character before its first word ends uses one regex (`firstWord` in `ranking.ts`, the same character class). The first words of the draft's `[[link]]` texts also join the Set, so a link to an alias finds its page.

*As built (review round 1, cost):* the walk over every title and alias hashes each name's first word (and second, when it has one) in an ASCII loop that allocates nothing, and drops the name unless the hash of its first word is among the draft's words and the hash of its first two words is among the pairs of words next to each other in the draft (unmasked, or in a `[[link]]`'s text). A name that passes has its first word checked exactly before it is tokenised; a hash collision only costs one tokenisation, and `fits` checks every word. A one-word ASCII name skips the regex. `tokenised` counts the names past the first-word check, so it stays within the first-word bound and, for ASCII names, within the pair bound.

**d. Stoplist** (an exported constant; each rule has its own test). A title or alias is never suggested if:

1. every word in it is in `STOPWORDS`;
2. it is a single word shorter than 4 characters;
3. it is all digits;
4. it is a single word in `COMMON_TITLES`: note, notes, meeting, meetings, task, tasks, todo, done, doing, later, now, idea, ideas, summary, today, tomorrow, yesterday, project, projects, person, people, area, areas, resource, resources, page, journal, tag, inbox, draft, archive, misc, general, home, index, test.

Multi-word titles that contain a stopword, such as "Head of Sales", still match. The number skipped this way is returned as `skipped_stoplist` (a count, not a list).

*As built (Stage 2, call):* rule 2 applies to page titles, not aliases. An alias is a short name the owner chose for the page, and section 3.7's own example suggests `[[OI]]`, which rule 2 would stop. `skipped_stoplist` counts the distinct stoplisted titles and aliases the draft mentions outside masks.

**e. Matching.** Leftmost-longest over the unmasked words: at each word position the longest candidate wins, by word count and then by characters, so "Workflow Intelligence" beats "Workflow". A match must cover consecutive words with no masked range and no line break between them, and the characters between its words must be only spaces, hyphens or similar joiners. Because tokens are whole words, "Workflows" does not match "Workflow". Matching ignores case.

*As built (review round 1):* a gap the title fills with joiners takes any joiners in the draft; a gap with other characters (`Node.js`, `R&D Budget`, `Q3/Q4 Planning`, `Project: Apollo`) takes exactly those characters, so a title matches its own wording and "node js" does not match `Node.js`. Candidates are grouped by their words and these gaps (a joiner gap counts as one space), so `Node.js` and `Node JS` are two candidates, not one ambiguous one. A curly apostrophe does not match a straight one.

*As built (Stage 2):* candidates are grouped by their lower-cased words, so two candidates that match at the same position with the same word count have the same words and are one candidate; the character tie-break never decides. The joiners are space, tab, no-break space, `-`, U+2010 and U+2011. A match whose span holds an excluded or already-linked page still takes the span, so a shorter title inside it is not suggested instead.

**f. Once per page (issue).** Only the first unmasked mention of each page is suggested; later mentions are counted in `also_mentioned`. This is the plain-text form of the issue's "once per parent chain" rule; a draft has no block tree to walk. **(call)** Claude can call the tool once per block if it wants per-block links.

**g. Exclusions and ambiguity.** The excluded pages (section 3.5) and already-linked pages are dropped. When two or more pages have titles that are equal ignoring case, the span gives an `ambiguous` entry listing every UUID and title, and no single link; `linked_text` leaves it unlinked. Claude must choose; the tool never guesses.

*As built (Stage 2):* "equal" is equal words (ignoring case and joiners), the same grouping matching uses. Each ambiguous span is listed once. The alias-page rule (section 3.2) runs before exclusion, so excluding a page never promotes its standalone alias page. Excluded pages are removed before ambiguity is judged: if one of two "Sprint" pages is excluded, the other is suggested. A link in the draft counts as already linked when its text equals a title or alias ignoring case only (so `#Workflow-Intelligence` does not link "Workflow Intelligence").

### 3.4 Verify: read back stale UUIDs (panel)

The cache can be up to two hours old, and the owner may delete pages in the app, which the dirty key does not see. With `verify: true` (the default), and at least one suggestion, the tool makes one `getBlocks` call with `view=signals` and the suggestions' page UUIDs (at most 50 suggestions plus 5 related pages, under the 100 cap). Any UUID under `missing` (deleted, hidden or in the Recycle bin) is removed from the suggestions, `related` and `linked_text`, and listed under `dropped_stale` with its cached title. This follows `docs/solutions/semantic/stale-vector-ids-must-not-reach-strict-endpoints.md`.

**(call)** `view=signals` rather than the default view, because it returns no titles, properties or text, so the response is small and it costs the sync Worker less. A page renamed in the app since the cache was built is not caught, because signals has no title, and a `[[link]]` to the old title would not reach the page. A rename through the connector (`update_page`) marks the cache dirty at once; one in the app is picked up by the next hourly cron. This is a stated limit (section 7, risk 6).

If `getBlocks` fails, the call fails: `verify: getBlocks failed: <reason>`. It never returns unverified UUIDs as if verified. With `verify: false` the call is skipped and the summary line says the UUIDs come from an index of the stated age.

### 3.5 Inputs: the page being written and exclusions (panel)

`page` names the page being written, as a UUID or a title. It is resolved against the cached titles, with no sync call: an exact UUID, else an exact title, else one title equal ignoring case. If two pages share the title, the call is refused (section 3.8). If no page matches, the call goes ahead and the summary says nothing was excluded, because the page may be new or a journal (journals are not in the index, so they can never be suggested anyway).

`exclude` takes up to 50 UUIDs or titles, resolved the same way; an unknown entry is a note, not an error.

### 3.6 Related by meaning, optional (panel)

`related: true` (default false) adds a section of pages that are close in meaning but not named in the draft. The argument is in the schema only when semantic search is on (the bindings exist); otherwise the tool is registered without it, and a call that passes it anyway gets `related: semantic search is off on this connector`.

It makes:

1. one Workers AI embedding of the first 2,000 characters of the draft with masked ranges removed;
2. one Vectorize query, topK 20, returning no values or metadata;
3. one D1 read of those vector ids through `SemanticStore.blocksFor`, by primary key.

Hits are grouped by page UUID and kept only if the page is in the titles record, so private pages and journals stay out. Pages already suggested, already linked or excluded are removed. At most 5 pages are returned, each with its best similarity and the reason "related by meaning", and no span. Related pages never go into `linked_text`; they go through verify with the suggestions.

### 3.7 Output (panel)

A plain first line, then JSON:

```
3 link suggestions for graph "work" (index built 14:02, 23 min ago); 1 already linked; 0 dropped as stale
{
  "graph": "work",
  "index_built_at": "2026-11-08T14:02:00Z",
  "suggestions": [
    { "span": { "start": 12, "end": 33, "line": 1, "text": "Workflow Intelligence" },
      "page": { "uuid": "…", "title": "Workflow Intelligence" },
      "link": "[[Workflow Intelligence]]",
      "reason": "title",
      "also_mentioned": 1 },
    { "span": { "start": 58, "end": 60, "line": 2, "text": "OI" },
      "page": { "uuid": "…", "title": "Operational Intelligence" },
      "link": "[[<uuid of Operational Intelligence>]]",
      "reason": "alias ‘OI’ of Operational Intelligence",
      "also_mentioned": 0 }
  ],
  "ambiguous": [ { "span": {…}, "candidates": [ { "uuid": "…", "title": "Sprint" }, … ] } ],
  "related": [ { "page": { "uuid": "…", "title": "…" }, "similarity": 0.71, "reason": "related by meaning" } ],
  "already_linked": ["Weekly Review"],
  "dropped_stale": [],
  "skipped_stoplist": 4,
  "truncated": false,
  "linked_text": "…the draft with each suggestion's span replaced by its link…"
}
```

`link` keeps the draft's own words: a title match links the page's title as stored (`[[Workflow Intelligence]]`, which Logseq resolves ignoring case), and an alias match links the alias (`[[OI]]`), which Logseq resolves to the target. **(call)** Using the stored title rather than the draft's casing keeps the link pointing at the existing page, not at a new page in a different case.

*As built (review round 2, r2-integrity-1):* a bare `[[Title]]` is resolved on write by `resolve-page-ref!`, which takes the oldest entity with that `:block/name`. A tag, property or journal with the same name as an index page (the app allows a page and a tag to share one) is older in that case, so the link pointed at it, not at the UUID the suggestion named and verify checked. `link` is now `[[<page uuid>]]` for titles and aliases alike, the form the server stores links in, so the written ref is exactly the suggested page; Logseq shows it as the page's title. The draft's own `[[<uuid>]]` links count as already linked. This also closes risk 6 below: a renamed page keeps its UUID.

*As built (review round 2, r2-correctness-1):* a title's characters before its first word and after its last (the `)` of `Alice (Engineering)`, the `.` of `Example Ltd.`, the `?` of `What is OI?`) must appear in the draft next to the words, and the span covers them, so `linked_text` neither doubles them nor links text that lacks them. Two titles with the same words and different end punctuation are different candidates; the one with more of its own punctuation is tried first.

`linked_text` is the dry run: the draft with every non-ambiguous, verified suggestion applied at its span, spliced from the end backwards so offsets stay valid. Claude shows it or diffs it, then writes it with `update_block` or `insert_block_tree`. The tool writes nothing, makes no audit entry and does not mark the index dirty. Suggestions are in draft order; `truncated` is true when more than `limit` were found.

Result size: 20,000 characters of `linked_text`, 50 suggestions and 5 related pages stay well under the 150,000-character result cap (`docs/solutions/connector/per-item-summary-blows-result-cap.md`); the summary line names counts only, not every page.

### 3.8 Errors (panel)

Each names the input and the reason:

- `text: 31,204 characters is over the 10,000 limit`
- `page: 2 pages are titled ‘Sprint’ (Sprint 6f1c…, Sprint 9a02…); pass the UUID`
- `exclude: 51 entries is over the 50 limit`
- `related: semantic search is off on this connector`
- `suggest_links needs the knowledge index, which is unavailable for E2EE graphs` (the existing `http-409` path from `listKnowledgeIndex`)
- `verify: getBlocks failed: <reason>`
- the knowledge index's own `too-large` refusal over 20,000 pages, unchanged.

A `page` or `exclude` entry that names no page in the index is a note in the summary (`page: no page ‘X’ in the index (journals and pages tagged private are not in it); nothing was excluded`), not an error.

### 3.9 Contract text

- Tool description: what it does, that it is read-only, that it only suggests pages in the knowledge index (no journals, no pages tagged private), once per page, and that `linked_text` is for Claude to write with `update_block` or `insert_block_tree` after the owner sees it.
- `CONNECTOR_HELP` gains one sentence: after writing notes, call `suggest_links` on the text to link pages that already exist. `SEMANTIC_HELP` describes `related` when semantic search is on.
- Counts in the text (20,000 characters, 50 suggestions, 5 related) come from the exported constants, per `docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md`.
- README 11.8 gets a `suggest_links` entry. The PR body carries the Logseq skill note: when to call it (after drafting, before writing) and that it never writes.

## 4. Tool contract

New tool `suggest_links`, hand-written, registered in `mcp.ts` next to `kb_index` as `registerSuggestLinksTool(server, access, semantic, onSuccess)`. Annotations READ (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`) in `spec.mjs`'s `HANDWRITTEN_TOOLS`. It takes no `reason` argument, because it is not a write.

| Input | Type | Default | Notes |
|---|---|---|---|
| `graph` | alias, `ALIAS_PATTERN` | required | |
| `text` | string, 1 to 10,000 characters (20,000 before review round 1) | required | The draft markdown; a longer draft is sent in parts. |
| `page` | UUID or title | none | The page being written; excluded. |
| `exclude` | up to 50 UUIDs or titles | `[]` | Never suggested. |
| `limit` | 1 to 50 | 25 | Suggestions returned, in draft order. |
| `verify` | boolean | true | One `getBlocks view=signals` read-back. |
| `related` | boolean | false | Only when semantic search is on. |

Output: section 3.7.

Changed: `listKnowledgeIndex` entries gain `aliases: string[]` (additive). `kb_index` output is unchanged. The `KB_INDEX_KV` record goes to version 2, and a sibling key `kb-index-titles:<alias>` is added.

## 5. Cost on the Free plan

Per call, warm cache, defaults (verify on, related off):

| Resource | Per call | Cap a day |
|---|---|---|
| Worker requests | 1 to the connector, plus 1 to the sync Worker when there is at least one suggestion | 100,000 |
| KV reads | 2 (titles, dirty) | 100,000 |
| KV writes | 0 | 1,000 |
| D1 rows read | about 1 (the graph-token row `resolveGraph` already reads) | 5,000,000 |
| D1 rows written | 0 | 100,000 |
| Neurons | 0 | 10,000 |

Cold, stale or dirty cache: the same rebuild `kb_index` does, `ceil(pages / 200)` sync requests (10 for 2,000 pages) and 2 KV writes.

**Cron.** The titles key doubles the cron's KV writes: 48 a day per graph instead of 24, against 1,000 a day account-wide. Five graphs use 240. This goes into REVIEW.md *Cost* as a line under KV.

**related: true** adds 1 Workers AI embedding (2,000 characters is about 500 tokens; `bge-small-en-v1.5` at about 1,841 neurons per million tokens is about 1 neuron), 1 Vectorize query (topK 20, 384 dimensions queried, nothing stored) and about 20 D1 rows read by primary key.

At 200 calls a day: about 200 to 400 Worker requests, about 400 KV reads, about 200 D1 rows read (about 4,200 with related on every call), 0 rows written and up to about 200 neurons. All are far under the caps.

**CPU on the 10 ms front Worker.** Time grows with the draft length plus the number of titles whose first word is in the draft. The largest cost is `JSON.parse` of the titles key, about 1.2 MB at 20,000 pages. Text is capped at 20,000 characters, there are no per-entry `Intl` formatters, and the regexes are built once at module load. In the workers test pool, `performance.now` does not advance during CPU work, so vitest cannot measure CPU. A Node bench script (`scripts/bench-suggest-links.mjs`, with its `*.test.mjs`) reports parse and match time on a 20,000-page fixture, and the PR quotes it against the 10 ms budget. **(call)** If the bench is over budget at 20,000 pages, the fallback is to store the titles key split by first letter of the first word and read only the keys for the draft's letters; that is not built unless the bench needs it.

*As built (review round 1):* the bench was over budget (about 45 ms at 20,000 pages with a 20,000-character draft), and most of it was `matchLinks`, not the parse, so splitting the key by letter would not have fixed it. The matcher now rules names out by hashed first-word and first-two-word checks (section 3.3 c) and walks `titles` with indexed loops, and `TEXT_LIMIT` is 10,000 characters. The bench (Node v22, 20,000 pages, titles key 1,329 KiB, 10,000-character draft, median of 20 runs) gives `JSON.parse` 4.5 to 5.3 ms, `matchLinks` 4.0 to 4.5 ms, total 8.8 to 9.8 ms; 5,000 pages total about 4 ms. The first, cold run is still over (16 to 21 ms at 20,000 pages), and the parse is now about half the cost, so the margin at 20,000 pages is thin; a smaller titles-key format is the next step if production shows 1102 errors.

*As built (review round 2):* `page` and `exclude` were resolved with three passes over the index per reference (80 ms for 51 references at 20,000 pages, r2-correctness-3). `pageResolver` now resolves them all in one pass, hashing a title only when its length is a reference's, and the bench times it with a UUID and 50 unknown titles: about 1 ms at 20,000 pages. The first, cold call is still over the budget at large graphs; on this machine it is 7 to 10 ms even at 200 pages, so it is the cost of a fresh isolate compiling the matcher more than of the page count. The cold call is left for the backlog with the titles-key format.

## 6. Safety

- **Read-only.** No write call, no audit entry, no dirty mark. A tool test asserts every request the sync mock sees is a knowledge-index GET or the `getBlocks` read, and the manifest entry has `readOnlyHint: true`.
- **Private pages.** Never in the candidate set, because the index excludes them server-side, and related hits must be in the titles record.
- **Stale UUIDs.** Verified before they are returned, unless `verify: false`, which the summary states.
- **No guessing.** Duplicate titles give `ambiguous`, never a link; an ambiguous `page` is refused.
- **No secrets.** The tool returns titles and UUIDs only from the index Claude can already read with `kb_index`.

## 7. Risks

1. **Cache shape change.** Without the version bump, records cached before the deploy would miss aliases silently for up to two hours. The version-2 check forces one rebuild per graph.
2. **Two keys can disagree.** Covered by `freshTitles` applying the same rules to the same `builtAt` (section 3.2).
3. **Masking heuristics.** A single `$` is not treated as math, so a Logseq inline `$x$` span could be matched. A `>` not at the start of a line is not a quote. Each mask rule has its own test, so a mutation run shows any rule left untested (`docs/solutions/testing/untested-rules-survive-mutation.md`).
4. **Dictionary-word titles.** Single-word titles of 4 or more letters ("Apollo", "Delta") will match ordinary prose. Once per page, the stoplist and Claude's review of `linked_text` limit the harm; false positives remain likely on graphs with such titles.
5. **CPU at 20,000 pages.** Measured by the bench, not by vitest (section 5).
6. **Renamed pages.** *(Closed in review round 2: links are written as `[[<uuid>]]`.)* `view=signals` has no title, so a page renamed in the app since the cache was built is verified as present under its old title, and the suggested link names the old title. Logseq would then create a new page by that name when the text is written. The window is at most an hour (cron) and closes at once for renames through the connector. A later option is to compare titles with the default `getBlocks` view, at a higher sync cost.
7. **UTF-16 offsets.** Spans must be JavaScript string indices so `linked_text` splices exactly for macrons and emoji; tests include "Māori Health" and an emoji before a title.
8. **Class pages.** Section 2 reads the index as excluding tags and properties. If a Stage 1 test shows a user class does reach it, `COMMON_TITLES` covers the common single words, and the help text will say so.

## 8. Testing

Tests first, seen to fail, with the failures quoted in the PR. Example data only: `sync.example.com`; pages Workflow Intelligence, Workflow, Operational Intelligence (alias OI), Head of Sales, Māori Health, Sprint (twice), and Secret Plans tagged private.

1. **Matcher unit tests** (pure, the real code, no stubs): a case-insensitive whole-word hit with exact offsets; "Workflows" not matching "Workflow"; longest wins at the same position; an alias hit with the "alias … of …" reason and the `[[OI]]` link; an alias page not giving an ambiguous suggestion against its target; one test per mask rule (existing `[[link]]`, `#tag`, `#[[tag]]`, bare URL, `www.` URL, markdown link text and URL, inline code, ```` ``` ```` fence, `#+BEGIN_SRC`, `$$math$$`, `\(math\)`, a `>` quote line, `#+BEGIN_QUOTE`, a property key, `((ref))`, `{{macro}}`); a single-`$` price still matching; no match across a line break or a masked range; once per page with `also_mentioned`; an already-linked page skipped and listed; each stoplist rule with a near miss that does match ("Head of Sales"); exclusion by UUID and by title; an ambiguous duplicate title listing both UUIDs and left out of `linked_text`; non-ASCII and emoji offsets; `linked_text` equal to the draft with exactly the non-ambiguous spans replaced; and a test of `wordSpans` with a character whose lower case is longer. Mutation check: deleting any mask or stoplist rule fails at least one test.
2. **Tool tests through the MCP server** (as `kb-index.test.ts` does), with a fetch mock of `sync.example.com`: a warm cache answers with 0 sync calls when there are no suggestions and exactly 1 `getBlocks` when there are; a version-1 or stale record triggers a rebuild that writes both keys; a titles key whose `builtAt` differs from the dirty rule rebuilds; no request is a write, and the manifest entry is read-only; verify drops a page `getBlocks` lists under `missing` and lists it under `dropped_stale`; `getBlocks` failing fails the call with the named error; a private-tagged page (absent from the exclude-tags response) is never suggested; E2EE 409 gives the readable error; text over the limit, an ambiguous `page`, and `related` with semantic off each give their named error; `related: true` makes exactly 1 AI call and 1 Vectorize query (counted on the fakes in `semantic-fakes.ts`) and returns at most 5 pages, all in the index, none already suggested.
3. **kb-index tests**: the version-2 record, the titles key, and `kb_index` output unchanged.
4. **Cost and CPU**: with a 20,000-page titles fixture, the tokenised-titles counter is at most the number of titles whose first word is in the draft. The Node bench reports parse and match time.
5. **Patch 0036 deftest** in the db-sync suite (section 3.1), and the OpenAPI description test.
6. **Class pages** (section 2): a deftest or fixture check that a user class is not in the knowledge index; if it is, the spec's risk 8 applies and the help text says so.
7. `scripts/check.sh --upstream` on HEAD.

## 9. Rollout and verification

Stages, one commit each:

1. Patch 0036 with its deftest, vendored `openapi.json`.
2. `wordSpans` and the matcher with its unit tests (seen to fail first).
3. kb-index version 2 and the titles key, with their tests.
4. The tool: registration, verify, related, errors, tool tests, manifest (`npm --prefix connector run update:manifest`).
5. The bench script and its test.
6. Contract text: description, `CONNECTOR_HELP`, `SEMANTIC_HELP`, README 11.8, REVIEW.md *Cost* line on KV writes.

Deploy is by merge to main. On first use after deploy, each graph rebuilds its index once (version 2). The PR's verification section names the commit `scripts/check.sh --upstream` ran on, repeats what it skipped, quotes the failing tests from before the implementation, and quotes the bench numbers against 10 ms. After deploy, the owner can check one call on a real graph: a draft naming two existing pages and one alias returns three suggestions and `dropped_stale: []`.

## 10. Out of scope

- **Apply mode (brief).** The tool never writes; Claude writes `linked_text` with existing tools.
- **Graph-wide mode.** Scanning existing pages for unlinked mentions costs a block read per page; it belongs in a later item, perhaps as a `get_graph_health` check.
- **Fuzzy, stemmed or plural matching.** Only whole words, ignoring case.
- **Per-block "once per parent chain".** The draft has no tree; Claude can call per block.
- **Linking to tags (`#Tag`) or properties.** Only pages in the knowledge index are candidates.
- **Journal links.** Journals are not in the index; dates are not suggested.
- **A new index, D1 table or migration.**

## 11. Open questions for the owner

1. **Default for `verify`.** On (one extra sync call per call with suggestions) is the panel's choice. Is the extra request worth it, or would you rather the index's age be stated and verify be opt-in?
2. **`COMMON_TITLES`.** Is the list in section 3.3 right for your graph? Are there single-word page titles you use often in prose ("Delta", "Apollo") that you want left out by default, or should that be the `exclude` argument's job?
3. **Ambiguous titles.** Two pages with the same title give `ambiguous` and no link. Would you rather it prefer the page with more references?
4. **Renamed pages (risk 6).** Is an hour's window acceptable, or should verify compare titles at a higher sync cost?
5. **Single `$` math.** Should inline `$x$` be masked, at the cost of prices such as "$40 for Workflow" losing the match?
6. **KV writes.** The titles key doubles the cron's KV writes to 48 a day per graph. Fine for your number of graphs?
7. **Graph-wide mode.** Do you want it as a later item, and if so as a `get_graph_health` check or a separate tool?
