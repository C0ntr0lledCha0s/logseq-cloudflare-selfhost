# suggest_links: link existing pages in content Claude writes: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in Stage 1, `scripts/check.sh` in Stages 2 to 6), and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a new read-only hand-written tool, `suggest_links`, takes draft markdown and returns the `[[links]]` it could carry to pages that already exist: each suggestion gives the matched span, the page's title and UUID, and why (title or alias). It returns `linked_text`, the draft with the links applied, for Claude to write with the tools it already has. It never writes, never suggests a private page, the page being written or a stoplisted title, and never matches inside links, URLs, code, math or quotes. Optional `related: true` adds up to 5 pages close in meaning.

**Architecture:**
- **One upstream patch, `patches/0036-semantic-knowledge-index-aliases.patch`** (Stage 1). `listKnowledgeIndex` entries gain `aliases: string[]` (visible alias targets' titles, sorted, always present). Additive; `kb_index` output does not change.
- **No migration, no new index, no D1 table.** The candidate set is the `kb_index` cache in `KB_INDEX_KV`, which already leaves out journals, tags, properties and pages tagged private.
- **Pure matcher** in `connector/src/tools/suggest-links.ts` (`matchLinks`, `applyLinks`, `resolvePageRef`) over a slim titles list, sharing item 27's tokeniser through a new `wordSpans` in `connector/src/semantic/ranking.ts` (Stage 2). It does no I/O.
- **kb-index cache version 2** (Stage 3): the record carries `version: 2`, and `rebuildKbIndex` also writes `kb-index-titles:<alias>` (`[[uuid, title, aliases], …]`) from the same fetch, with the same `builtAt`. One freshness rule serves both keys.
- **The tool** (Stage 4) reads the titles key (2 KV reads warm), matches, verifies the suggested UUIDs with one `getBlocks` `view=signals` call (patch 0035), applies the surviving links and answers. **Related by meaning** (Stage 5) is one embedding, one Vectorize query and one D1 primary-key read, registered only when semantic search is on.
- **Order:** the server field first (nothing reads it yet), then the pure matcher (nothing calls it), then the cache that feeds it (the `kb_index` tool unchanged), then the tool, then `related`, then the CPU bench and the REVIEW.md cost line.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real handler on a real conn); TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real KV and D1, the real `SemanticStore`, `FakeVectorIndex`, `FakeEmbedder` and `FakeGraph` from `connector/test/semantic-fakes.ts`, the `SYNC` binding faked at HTTP level); a Node script with `node --test` for the bench.

**Spec:** `docs/superpowers/specs/2026-11-08-suggest-links-existing-pages-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) are the spec's.

## Global constraints

- **Names, exactly:**
  - patch `patches/0036-semantic-knowledge-index-aliases.patch`; upstream test namespace `logseq.db-sync.semantic-knowledge-index-aliases-test` in `deps/db-sync/test/logseq/db_sync/semantic_knowledge_index_aliases_test.cljs`, required from `test_runner.cljs` after `semantic-signals-view-test`; in `worker/handler/semantic.cljs`, a `knowledge-index-aliases` function used by `knowledge-index-entry`; response key `aliases`;
  - `ranking.ts` exports `wordSpans(text): { word: string; start: number; end: number }[]`; `contentWords` is unchanged;
  - `kb-index.ts` exports `KB_INDEX_VERSION = 2`, `KbTitlesPage = [uuid: string, title: string, aliases: string[]]`, `KbTitlesRecord = { graphId, builtAt, version: 2, pages: KbTitlesPage[] }`, `freshTitles(access, alias, now)` and `loadTitles(access, alias, now)` (fresh or rebuilt); `KbIndexEntry.aliases?: string[]`; `KbIndexRecord.version: 2`; keys `kb-index:<alias>` (unchanged) and `kb-index-titles:<alias>`;
  - `suggest-links.ts` exports `TEXT_LIMIT = 20_000`, `DEFAULT_LIMIT = 25`, `MAX_LIMIT = 50`, `EXCLUDE_LIMIT = 50`, `RELATED_LIMIT = 5`, `RELATED_TEXT_CHARS = 2_000`, `RELATED_TOP_K = 20`, `MIN_SINGLE_WORD_CHARS = 4`, `COMMON_TITLES` (spec §3.3 d, verbatim), `maskRanges(text)`, `matchLinks(text, titles, { exclude, limit })`, `applyLinks(text, suggestions)`, `resolvePageRef(titles, ref)`, `registerSuggestLinksTool(server, access, semantic, onSuccess)`;
  - output keys as spec §3.7: `graph`, `index_built_at`, `suggestions` (`span {start, end, line, text}`, `page {uuid, title}`, `link`, `reason`, `also_mentioned`), `ambiguous`, `related` (`page`, `similarity`, `reason`), `already_linked`, `dropped_stale`, `skipped_stoplist`, `truncated`, `linked_text`.
- **Messages, in the spec's wording (§3.8):** `text: 31,204 characters is over the 20,000 limit`; `page: 2 pages are titled ‘Sprint’ (Sprint 6f1c…, Sprint 9a02…); pass the UUID`; `exclude: 51 entries is over the 50 limit`; `related: semantic search is off on this connector`; `suggest_links needs the knowledge index, which is unavailable for E2EE graphs`; `verify: getBlocks failed: <reason>`; the knowledge index's `too-large` refusal unchanged. All input checks run before any KV or sync call. An unknown `page` or `exclude` entry is a note in the summary line, not an error.
- **Read-only.** No write call to the sync server, no audit entry, no dirty mark, no `reason` argument; `READ` annotations in `spec.mjs`. The only KV writes are the cache rebuild `kb_index` already does.
- **The tool never guesses.** Duplicate titles give `ambiguous` and no link; an ambiguous `page` is refused; a failed verify fails the call.
- **Counts in tool text come from the constants** (`docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md`): the description and help interpolate `TEXT_LIMIT`, `MAX_LIMIT`, `RELATED_LIMIT`, `EXCLUDE_LIMIT`, and a test asserts each number appears.
- **Free plan** (spec §5, REVIEW.md *Cost*). Warm cache, defaults: 2 KV reads, 0 KV writes, at most 1 sync call (`getBlocks` `view=signals`, only when there is a suggestion, at most 55 ids), about 1 D1 row (the graph-token row), 0 neurons. Cold or stale: the `kb_index` rebuild, `ceil(pages / 200)` sync calls and 2 KV writes. `related: true` adds 1 embedding (about 1 neuron), 1 Vectorize query (topK 20, no values or metadata) and at most 20 D1 rows by primary key. The cron's KV writes go from 24 to 48 a day per graph. Tests pin these counts on the fakes; each stage's commit body states its cost per call.
- **CPU.** No `Intl` formatter per entry, regexes built at module load, matching sized by the draft (spec §3.3 c). Stage 6's bench reports parse and match time at 20,000 pages against 10 ms; vitest cannot measure CPU in workerd.
- **Tests run the real thing.** Upstream tests use the real handler on a real conn. Matcher tests call the real functions. Tool tests go through the MCP server with real KV and D1; only the sync server, embedder and Vectorize are faked. Each mask and stoplist rule has a test with a decoy only that rule separates (`docs/solutions/testing/untested-rules-survive-mutation.md`). Each new test is first seen to fail; keep the failure text for the PR.
- **Contract with Claude.** The stage that adds or changes the tool updates its description, `CONNECTOR_HELP` or `SEMANTIC_HELP`, and runs `npm --prefix connector run update:manifest` (or `npm --prefix connector run check:manifest` to show it is unchanged; say which). README §11.8 is the docs stage's, after the build.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `semantic`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** the owner's graph name, page names, page UUIDs, hostnames or tokens. Fixtures use the spec's example pages (Workflow Intelligence, Workflow, Operational Intelligence with alias OI, Head of Sales, Māori Health, Sprint twice, Secret Plans tagged private) and `sync.example.com`.

### Working on patch 0036 (Stage 1)

Follow the `add-upstream-patch` skill. Once, before Stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0035
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0035"
git -C .upstream tag -f baseline
```

After the code and tests pass:

```bash
scripts/build.sh .upstream
scripts/upstream-test.sh .upstream 'semantic-knowledge-index-aliases|semantic-index-health'
(cd .upstream/deps/db-sync && pnpm test)                     # the whole suite before the commit
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0036-semantic-knowledge-index-aliases.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 36 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. `.upstream` is gitignored; only `patches/` and the vendored files carry the change.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Cost*, *Contract and docs*, *Tests* and *Connector*.
- `semantic.cljs`: `knowledge-index-entry` (`:4427`) and the `listKnowledgeIndex` handler with its `exclude-tags` filter (`:4468`), `hidden-id?`, `user-page-ids`; `routes/semantic.cljs` `listKnowledgeIndex` (`:133`, `:487`); `test/logseq/db_sync/semantic_index_health_test.cljs` (`semantic-knowledge-index-lists-summarised-pages-test`, `:192`).
- `connector/src/tools/kb-index.ts` (all of it), `connector/test/kb-index.test.ts`, `connector/src/tools/semantic-search.ts` (`fetchSignals`, `semanticMatches`, `registerSemanticTools`), `connector/src/semantic/ranking.ts` (`STOPWORDS`, `contentWords`), `connector/src/semantic/store.ts` (`blocksFor`), `connector/src/mcp.ts` (`isolateTools`, registration at `:133`), `connector/src/tools/spec.mjs` (`HANDWRITTEN_TOOLS`, annotations), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP`), `connector/test/tools.test.ts` (`READ_HANDWRITTEN`), `connector/test/semantic-fakes.ts`.
- `docs/solutions/semantic/stale-vector-ids-must-not-reach-strict-endpoints.md`, `docs/solutions/connector/per-item-summary-blows-result-cap.md`, `docs/solutions/cost/per-entry-intl-formatters-burn-the-cpu-budget.md`, `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`, `docs/solutions/testing/untested-rules-survive-mutation.md`, and the previous plan, `docs/superpowers/plans/2026-11-08-semantic-search-recency-importance-ranking.md`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **An alias whose target page is in the Recycle bin, and an alias page that is itself hidden:** the first page lists no alias for it; a visible page aliased by a recycled page still lists its own visible aliases (Stage 1).
2. **A user class (tagged Tag) and a property:** neither is in the knowledge index; if a class also tagged Page is, it is listed and spec risk 8 applies (Stage 1).
3. **`İstanbul Office` after an `İ` earlier in the draft:** `wordSpans` offsets index the original string, so `linked_text` splices the right characters (Stage 2).
4. **A title that tokenises to nothing (`🚀` or `---`):** skipped, never matches every position (Stage 2).
5. **"Workflow-Intelligence" and "Workflow  Intelligence" (two spaces):** both match "Workflow Intelligence" as joiners; "Workflow. Intelligence" and a line break between the words do not (Stage 2).
6. **A title that equals, ignoring case, another page's alias:** the standalone page is dropped; the span suggests the alias's target, not an ambiguous pair. Two pages whose aliases are equal: ambiguous (Stage 2).
7. **`[[workflow intelligence]]` in lower case earlier in the draft:** the page counts as already linked, so a later plain "Workflow Intelligence" is not suggested (Stage 2).
8. **An unterminated ```` ``` ```` fence or `#+BEGIN_SRC` with no `#+END_SRC`:** the mask runs to the end of the text (plan call: safer than matching code) (Stage 2).
9. **A record with `version: 2` but a titles key with an older `builtAt`, or a titles key missing while the record is fresh:** the tool rebuilds and writes both keys (Stage 3).
10. **An old server answer with no `aliases` key:** the titles key stores `[]` for that page; the next deploy's rebuild picks the aliases up (Stage 3).
11. **`page` given as a title that two pages share, and as the UUID of one of them:** the title is refused; the UUID excludes only that page (Stage 4).
12. **A draft whose only match is an ambiguous span:** no `getBlocks` call (nothing to verify), `linked_text` equals the draft (Stage 4).
13. **`limit: 2` with three matches, one of them stale:** `truncated` is true, verify runs on the 2 returned, the stale one is dropped, and the third is not promoted (plan call: verify after the limit, so the call stays one request) (Stage 4).
14. **A related hit on a journal block or on a private page:** not in the titles key, so not returned (Stage 5).

---

### Stage 1: Patch 0036, aliases on knowledge-index entries

**Goal:** the sync server's `listKnowledgeIndex` answers each entry with `aliases` as spec §3.1. Nothing in the connector reads it yet. Lands spec §3.1 and §8 items 5 and 6.

**Files:**
- Create (in `.upstream`, carried by the patch): `deps/db-sync/test/logseq/db_sync/semantic_knowledge_index_aliases_test.cljs`; require it in `test_runner.cljs`.
- Modify (in `.upstream`): `worker/handler/semantic.cljs` (`knowledge-index-aliases`: the titles of `:block/alias` targets, dropping any `hidden-id?` target, sorted; `knowledge-index-entry` adds `:aliases`); `routes/semantic.cljs` (the `listKnowledgeIndex` description names `aliases`, and the response schema adds it); the test that pins that description, if one does (find it with `grep -rn listKnowledgeIndex deps/db-sync/test`).
- Create: `patches/0036-semantic-knowledge-index-aliases.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs` (via `vendor-upstream-api.sh`), `connector/tools-manifest.json` only if the check says so (`listKnowledgeIndex` is replaced by `kb_index`, so it should not).

**Interfaces produced:** `aliases: string[]` on every `listKnowledgeIndex` entry.

- [ ] **Step 1: Write the failing tests** on a real conn through the real handler:
  - `lists visible aliases sorted`: a page with aliases "OI" and "Ops Intel" lists `["OI", "Ops Intel"]`; a page with none lists `[]` (the key is present).
  - `drops hidden and recycled alias targets` (review focus 1): an alias page moved to the Recycle bin and one under a hidden parent are left out.
  - `alias pages are entries in their own right`: the alias page "OI" is itself an entry (spec §3.2 call depends on it).
  - `classes and properties are not entries` (review focus 2, spec §8 item 6): a user class Project (tagged Tag) and a user property are absent; a page tagged Project is present.
  - `exclude-tags still applies`: a page tagged private is absent and so are its aliases' mentions of it.
- [ ] **Step 2: Run on the unpatched tree** and keep the failures (today: no `:aliases` key).
- [ ] **Step 3: Implement** as spec §3.1. Resolve alias titles from the entity, not a second query per page.
- [ ] **Step 4: Run the patch workflow above, then the gate:** `scripts/check.sh --upstream`. **Mutation check:** drop the visibility filter; drop the sort; emit `nil` instead of `[]`. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(api): list page aliases in the knowledge index`. Body: the quoted unpatched failure, what the class-page test showed (spec risk 8), and that nothing reads it yet (cost: none on the connector; the server reads one more attribute per page).

**Done when:** all 36 patches apply from scratch, the new namespace passes in the whole db-sync suite, the vendored API shows `aliases`, and `scripts/check.sh --upstream` is green.

---

### Stage 2: `wordSpans` and the pure matcher

**Goal:** `matchLinks`, `maskRanges`, `applyLinks` and `resolvePageRef` behave as spec §3.3 and §3.5 over a plain titles array. Nothing calls them yet. Lands acceptance 1, 2, 3 and 5 at unit level.

**Files:**
- Modify: `connector/src/semantic/ranking.ts` (`wordSpans`, sharing the character class with `contentWords` through one module-level constant).
- Create: `connector/src/tools/suggest-links.ts` (the constants, `maskRanges`, the candidate map, `matchLinks`, `applyLinks`, `resolvePageRef`; types `Suggestion`, `AmbiguousMatch`, `MatchResult` with `tokenised: number`). **Plan call:** the spec's "exported counter" is the `tokenised` field on `MatchResult`, not module state, because a module variable is shared by concurrent requests in one isolate.
- Create: `connector/test/suggest-links.test.ts`.

**Interfaces produced:** `matchLinks(text, titles: KbTitlesPage[], { exclude: Set<string>; limit: number }) → { suggestions, ambiguous, alreadyLinked, skippedStoplist, truncated, tokenised }`; `applyLinks(text, suggestions) → string`; `resolvePageRef(titles, ref) → { uuid } | { ambiguous: KbTitlesPage[] } | null`. `KbTitlesPage` is declared here and moved to `kb-index.ts` in Stage 3 (or declared there now with no other change; either way one definition).

- [ ] **Step 1: Write the failing tests** (spec §8 item 1), each on the real functions:
  - `wordSpans`: offsets for "Māori Health"; an emoji before a word; `İ` before a word (review focus 3); `word` is lower case and `text.slice(start, end)` is the original casing.
  - matching: case-insensitive whole word with exact `span`; "Workflows" does not match "Workflow"; "Workflow Intelligence" beats "Workflow" at the same position; joiners and non-joiners (review focus 5); no match across a masked range; a title of `🚀` skipped (review focus 4).
  - aliases: "OI" gives reason `alias ‘OI’ of Operational Intelligence` and link `[[OI]]`; the alias page and its target give one suggestion, not ambiguous (review focus 6).
  - one mask test each, with the same title outside the mask matching in the same draft: `[[link]]`, `#tag`, `#[[tag]]`, `((ref))`, `{{macro}}`, `[text](url)` text and URL, `scheme://` URL, `www.` URL, inline code, ```` ``` ```` fence, `#+BEGIN_SRC`, `#+BEGIN_QUOTE`, `#+BEGIN_EXPORT`, `$$…$$`, `\(…\)`, a `>` line after `- ` and indentation, a property key before `::`; a single-`$` price still matching; unterminated blocks (review focus 8).
  - already linked: `[[…]]`, `#[[…]]` and `#Title`, ignoring case (review focus 7), listed in `alreadyLinked`.
  - once per page: the first mention suggested, `also_mentioned` counts the rest.
  - stoplist, one test per rule with a near miss that matches: all-`STOPWORDS` title; a 3-letter single word against a 4-letter one; all digits against "Q3 Plan"; each `COMMON_TITLES` word against "Meeting Notes 2026"; "Head of Sales" matches; `skippedStoplist` counts distinct titles skipped.
  - exclusion by UUID; ambiguous "Sprint" lists both pages and is left out of `applyLinks`' output; `limit` sets `truncated`.
  - `applyLinks`: the draft with exactly the given spans replaced, spliced from the end; title matches link the stored title, alias matches the alias.
  - `resolvePageRef`: exact UUID, exact title, one title ignoring case, two titles ignoring case is ambiguous, none is `null`.
  - bound: with 20,000 generated titles and a 200-word draft, `tokenised` is at most the number of titles whose first word is in the draft.
- [ ] **Step 2: Run and keep the failures** (module not found, then each assertion).
- [ ] **Step 3: Implement** as spec §3.3 a to g and §3.5. One linear scan for the masks, a sorted list of protected ranges, the draft's word Set, then the first-word scan of titles without regex.
- [ ] **Step 4: Run the gate:** `scripts/check.sh`. Semantic search tests must pass unchanged (`contentWords` did not move). **Mutation check:** delete each mask rule in turn; delete each stoplist rule; compare by characters before words; let `[[…]]` already-linked be case-sensitive; splice from the start. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): add the suggest_links matcher and wordSpans`. Body: the failures seen, the mutation results, and cost: none (not wired).

**Done when:** every rule in spec §3.3 has its own passing test, the mutation run is clean, and the gate is green.

---

### Stage 3: kb-index cache version 2 and the titles key

**Goal:** the cache carries aliases, records without `version: 2` rebuild, and every rebuild (tool or cron) writes `kb-index-titles:<alias>` beside the record. `kb_index` output is unchanged. Lands spec §3.2.

**Files:**
- Modify: `connector/src/tools/kb-index.ts`: `KbIndexEntry.aliases?`, `KB_INDEX_VERSION`, `KbIndexRecord.version`, `titlesKey`, `KbTitlesRecord`, `KbTitlesPage` (moved here if Stage 2 declared it in `suggest-links.ts`); `rebuildKbIndex` builds both values from one fetch and writes both with `RECORD_TTL_S`; one `isFresh(meta, graphId, dirty, now)` used by `freshRecord` and the new `freshTitles`; `loadTitles` returns `freshTitles` or the titles from `rebuildKbIndex`.
- Modify: `connector/test/kb-index.test.ts` (the knowledge-index fake answers with `aliases` on some entries and without the key on one).

- [ ] **Step 1: Write the failing tests** (spec §8 item 3):
  - `a rebuild writes both keys with the same builtAt`, and the titles key holds `[uuid, title, aliases]` per page, `[]` for an entry with no `aliases` key (review focus 10).
  - `a version-1 record rebuilds`: a record stored without `version` makes `kb_index` fetch the index again.
  - `freshTitles` rules, one test each: other graph id, no `version: 2`, older than `KB_INDEX_MAX_AGE_MS`, dirty at or after `builtAt`; each returns `null`; a clean, young, same-graph titles key is returned with 0 sync calls.
  - `loadTitles` rebuilds when the titles key is missing or older than the record (review focus 9), and the rebuild rewrites both.
  - `the cron writes both keys`: `refreshAllKbIndexes` leaves `kb-index-titles:` keys for each graph.
  - `kb_index output is unchanged`: the rendered text for the existing fixture equals the text HEAD rendered (pasted as the expected string before the change).
- [ ] **Step 2: Run and keep the failures.**
- [ ] **Step 3: Implement** as spec §3.2.
- [ ] **Step 4: Run the gate:** `scripts/check.sh`. **Mutation check:** drop the version check; give the titles key its own `builtAt`; skip the dirty check in `freshTitles`; write only the record in the cron. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit.** `feat(connector): cache page titles and aliases beside the kb_index record`. Body: the failures seen, and cost: one rebuild per graph on first use after deploy (`ceil(pages / 200)` sync calls), KV writes per rebuild 1 to 2, the cron's KV writes 24 to 48 a day per graph, 0 D1 rows.

**Done when:** both keys are written by every rebuild, both readers share one freshness rule, `kb_index` renders as before, and the gate is green.

---

### Stage 4: The `suggest_links` tool, with verify

**Goal:** `suggest_links` is registered for every connector, read-only, and answers spec §3.7 without `related`. Lands acceptance 1 to 6 end to end, spec §3.4, §3.5, §3.7, §3.8 and §4.

**Files:**
- Modify: `connector/src/tools/semantic-search.ts`: factor the request half of `fetchSignals` into an exported `requestSignals(access, alias, graphId, pat, uuids, property?) → { signals, missing }` that throws the sync error unwrapped; `fetchSignals` keeps its `ranking signals: <reason>` wrapping. `semantic_search` tests pass unchanged, which shows the refactor moved nothing.
- Modify: `connector/src/tools/suggest-links.ts`: `registerSuggestLinksTool(server, access, semantic, onSuccess)` with the zod schema of spec §4 (no `related` yet); input checks before any call; `loadTitles`; `resolvePageRef` for `page` and `exclude`; `matchLinks`; verify (`requestSignals` once, `view=signals`, only when there is a suggestion, wrapping errors as `verify: getBlocks failed: <reason>`; missing UUIDs go to `dropped_stale` with their cached title); `applyLinks`; the summary line (counts only, the index age, `verify: false` stated); the E2EE `http-409` mapped to the readable error; the description.
- Modify: `connector/src/mcp.ts` (register after `registerKbIndexTool`), `connector/src/tools/spec.mjs` (`HANDWRITTEN_TOOLS`, `suggest_links: READ`), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP` gains the sentence of spec §3.9), `connector/test/tools.test.ts` (`READ_HANDWRITTEN`), `connector/tools-manifest.json` via `update:manifest`.
- Modify: `connector/test/suggest-links.test.ts` (a `describe("suggest_links tool")` block through the MCP server, as `kb-index.test.ts` does).

- [ ] **Step 1: Write the failing tests** (spec §8 item 2):
  - `warm cache, no suggestions`: 0 sync calls, 2 KV reads.
  - `warm cache, suggestions`: exactly 1 sync call, a `getBlocks` `view=signals` GET carrying the suggested UUIDs; the output has every spec §3.7 key.
  - `read-only`: every request the sync fake sees is a knowledge-index GET or that `getBlocks` GET; no `kb-index-dirty:` key is written; the manifest entry is `READ`; no audit row is written.
  - `verify drops stale pages`: a UUID under `missing` is removed from `suggestions` and `linked_text` and listed in `dropped_stale`; `limit` with a stale page (review focus 13).
  - `verify failure fails the call` with `verify: getBlocks failed: …`; `verify: false` makes no call and the summary says so.
  - `private pages never suggested`: Secret Plans is absent from the exclude-tags response, so a draft naming it gets no suggestion.
  - `page` excluded by UUID and by title; ambiguous title refused naming both UUIDs; UUID of one duplicate accepted (review focus 11); unknown `page` is a note.
  - errors: text over `TEXT_LIMIT`, 51 `exclude` entries, E2EE 409, each with its message and 0 sync calls where the spec says so; `too-large` unchanged.
  - an ambiguous-only draft makes no `getBlocks` call (review focus 12).
  - `the description and help name the limits from the constants`.
- [ ] **Step 2: Run and keep the failures** (tool not found).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Contract.** Description per spec §3.9; `CONNECTOR_HELP` sentence; `npm --prefix connector run update:manifest` (it changes: one tool added).
- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** skip verify; verify before the limit; return unverified UUIDs on a verify error; mark the cache dirty; drop the 409 mapping; let an ambiguous `page` pick the first. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(connector): add suggest_links, a read-only link suggester`. Body: the failures seen, mutation results, and cost per call (2 KV reads, at most 1 sync call, about 1 D1 row, 0 neurons; cold: the `kb_index` rebuild).

**Done when:** the tool answers every spec §3.7 key, makes only the reads stated, refuses every §3.8 case with its message, the manifest and help match, and the gate is green.

---

### Stage 5: `related: true`, pages close in meaning

**Goal:** with semantic search on, `related: true` adds at most `RELATED_LIMIT` pages close in meaning to the draft; with it off, the argument is absent from the schema and refused if passed. Lands spec §3.6 and acceptance 7.

**Files:**
- Modify: `connector/src/tools/suggest-links.ts`: the schema adds `related` only when `semantic` is not null; a passed `related` with semantic off answers `related: semantic search is off on this connector` (plan call: keep a passthrough check, since zod strips unknown keys silently); embed the first `RELATED_TEXT_CHARS` of the draft with masked ranges removed (reuse the embedding helper behind `semanticMatches`, exported if needed), query Vectorize with `RELATED_TOP_K` and no values or metadata, read `SemanticStore.blocksFor` for the ids, group by page UUID keeping the best similarity, keep pages in the titles key that are not suggested, ambiguous, already linked or excluded, cap at `RELATED_LIMIT`, and verify them with the suggestions in the same single `getBlocks` call. Related pages never enter `linked_text`.
- Modify: `connector/src/tools/semantic-search.ts` (`SEMANTIC_HELP` describes `related`), `connector/test/suggest-links.test.ts`, `connector/tools-manifest.json` via `update:manifest` if the check says so.

- [ ] **Step 1: Write the failing tests** with `semanticEnv`, `FakeEmbedder`, `FakeVectorIndex` and real D1:
  - `one embedding, one Vectorize query`: `FakeEmbedder.calls` 1, `FakeVectorIndex.queries` 1 with topK 20 and no values or metadata, and the D1 statement count shows one `blocksFor` read.
  - `at most 5 pages, all in the index, none already suggested`: 8 related pages in the fake, one also suggested, one a journal block and one private (review focus 14).
  - `the embedded text has masks removed and is at most 2,000 characters` (read from the fake's last input).
  - `related pages are verified in the same getBlocks call`: still exactly 1 sync call; a stale related page goes to `dropped_stale`.
  - `semantic off`: the schema has no `related`; passing it answers the message, with 0 KV and sync calls; `related: false` with semantic on makes no AI call.
- [ ] **Step 2: Run and keep the failures.**
- [ ] **Step 3: Implement** as spec §3.6.
- [ ] **Step 4: Contract.** `SEMANTIC_HELP`; the manifest (say whether it changed).
- [ ] **Step 5: Run the gate:** `scripts/check.sh`. **Mutation check:** drop the in-index filter; drop the already-suggested filter; skip masking before embedding; a second `getBlocks` call for related; no cap. Confirm a test fails for each. Revert.
- [ ] **Step 6: Commit.** `feat(semantic): add related pages to suggest_links`. Body: the failures seen, and cost per `related` call (1 embedding of about 500 tokens, about 1 neuron; 1 Vectorize query, 384 dimensions queried, none stored; at most 20 D1 rows by primary key; 0 extra sync calls).

**Done when:** `related` is bounded as stated and tested on the fakes, absent and refused with semantic off, and the gate is green.

---

### Stage 6: CPU bench and the REVIEW.md cost line

**Goal:** a Node bench reports `JSON.parse` of a 20,000-page titles key plus `matchLinks` on a 20,000-character draft, against the 10 ms budget, and REVIEW.md *Cost* records the KV-write arithmetic. Lands spec §5's CPU and cron lines and spec §8 item 4.

**Files:**
- Create: `scripts/bench-suggest-links.mjs` (generates a seeded 20,000-page fixture of example titles, about 1.2 MB serialised, and a draft; bundles `connector/src/tools/suggest-links.ts` with the `esbuild` already in `connector/node_modules` (a wrangler dependency) into a temporary directory and imports the bundle, because the connector's extensionless imports do not load under Node's type stripping; no other script imports connector code yet, so this is the first; if `connector/node_modules` is absent the test skips with that reason, as `check.sh` names its skips; prints parse and match medians over 20 runs; `--json` for machine output) and `scripts/bench-suggest-links.test.mjs` (runs it on a 500-page fixture and checks the output shape and that `tokenised` stays at most the first-word bound; it never asserts a time, so CI is not flaky).
- Modify: `REVIEW.md` *Cost*: a KV line (the titles key doubles the cron's KV writes to 48 a day per graph against 1,000 a day account-wide; any new KV key written by the cron must state its writes a day).

- [ ] **Step 1: Write the failing test** (`node --test scripts/bench-suggest-links.test.mjs`: the script is missing).
- [ ] **Step 2: Implement** the bench. Run it at 20,000 pages and record parse and match times. If the total is over 10 ms, stop and tell the lead: spec §5's fallback (titles split by first letter) is a design change, not this stage's.
- [ ] **Step 3: Run the gate:** `scripts/check.sh` (the bench test runs under `npm test`).
- [ ] **Step 4: Commit.** `chore(connector): bench suggest_links parse and match time`. Body: the bench numbers against 10 ms, the machine they ran on, and the REVIEW.md line.

**Done when:** the bench runs, its test passes without timing assertions, the numbers are in the commit body, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 gains a `suggest_links` entry (what it does, read-only, once per page, what is never matched, `verify`, `related`, cost per call and the cron's KV writes); README's list of patches gains 0036; §11.11 or the semantic section mentions `related` beside `semantic_search`.
- **PR body:** Stage 1's unpatched failure and each stage's first failures, the mutation results from every stage, the bench numbers against 10 ms, the commit the checks ran on, what `scripts/check.sh --upstream` skipped, that `tools-manifest.json` changed (one tool added), and the Logseq skill note: after drafting notes and before writing them, call `suggest_links` with the draft and the page being written; show the owner `linked_text` (or the suggestions) and write it with `update_block` or `insert_block_tree`; resolve `ambiguous` by asking; the tool never writes and only knows pages in the knowledge index (no journals, no pages tagged private). The PR is stacked on the phase 4 branch and merges after it.
- **Live check** (spec §9): after deploy, one call on a real graph with a draft naming two existing pages and one alias returns three suggestions and `dropped_stale: []`; record counts only, not page names. Watch the next usage report for KV writes.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 (verify default) changes Stage 4's default and its 0-call test; question 2 changes `COMMON_TITLES`; question 3 would replace `ambiguous` with a reference-count pick in Stage 2; question 4 would switch verify to the default `getBlocks` view; question 5 would add a single-`$` mask rule and flip the price test; question 6 is the REVIEW.md line's number; question 7 is a later item. Any change lands before the PR merges.
