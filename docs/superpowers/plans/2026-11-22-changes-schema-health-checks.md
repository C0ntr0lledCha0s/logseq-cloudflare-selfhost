# Change feed, schema export and deeper health checks: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with the gate green on HEAD (`scripts/check.sh --upstream` in every stage that changes `patches/`, plain `scripts/check.sh` otherwise), and is one commit, pushed straight after. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** three read-only reads for the owner's weekly review and daily digest. `get_graph_health` gains `broken-refs` and `missing-tag-properties`, and every check, old and new, leaves out Private and Recycle-bin content. `list_changes_since` (new) lists what changed in a time window, grouped by page. `get_graph_schema` (new) lists the graph's tags and properties with types, choices and usage counts in one call. All three refuse E2EE graphs, write nothing and stay inside the Free plan's budgets.

**Architecture:**
- **Three patches, one per part.** `patches/0051-semantic-health-broken-refs-missing-tag-properties.patch` (Stages 1 to 3), `patches/0052-semantic-changes-since-feed.patch` (Stage 4) and `patches/0053-semantic-graph-schema-export.patch` (Stage 5). Each is a diff against the tree with the patches before it applied, so the owner can drop 0053 (or 0052 and 0053) without the others. Patch 0050 (item 49, PR 72) is never renumbered; if PR 72 is dropped or reordered, these become 0050 to 0052 before merge (spec §3.1, §12 decision 6).
- **Stage 1, Private and Recycle bin in the old checks** (spec §12 decision 4): the seven existing checks drop `private-ids`, built once per request. No new check, no new parameter.
- **Stage 2, `broken-refs`:** one pass over stored titles with `db-content/id-ref-pattern`.
- **Stage 3, `missing-tag-properties`:** only the expected tag-property pairs, from a `tag-properties` input or a stored default in `config/settings.json` (the decision below).
- **Stage 4, `list_changes_since`:** `GET /changes`, an index range over `:block/updated-at`, grouped by page, with `since` and `until` read as epoch ms, an ISO date or an ISO datetime in the Worker's `TIMEZONE`.
- **Stage 5, `get_graph_schema`:** `GET /schema`, tags and properties with counts.
- **Stage 6, the release bundle and the CPU numbers:** a bench at the caps and a release-bundle check of the three routes. Scripts only, no patch change.
- **Order:** the Private fix first, because both new checks reuse its per-request private set and its tests pin the filter every later stage relies on; then the two checks, smallest first; then the feed, which the digest needs most; the schema export, which is the most separable; the bench last, because it measures the finished code.

**Decision: where the expected tag-property pairs live** (spec §12 decision 2, left to the build). Both an input and a stored default, with no D1 table:
- **Input:** `tag-properties` on `getGraphHealth`, a JSON array of `{"tag": …, "property": …}` objects (each a title, UUID or ident, resolved as `get_tag` and `get_property` resolve them), 1 to 50 pairs. Given, it replaces the stored default for that call.
- **Stored default:** `config/settings.json` gains `"health": {"expectedTagProperties": [{"tag": "…", "property": "…"}]}`. `scripts/render-wrangler.mjs` checks its shape (an array of at most 50 objects with two non-empty strings) and writes it, JSON-encoded, into the sync Worker's `HEALTH_TAG_PROPERTIES` variable, as it writes `TIMEZONE`. The handler reads it from `(.-env self)`. The owner edits it in the repo, and merging deploys it. The committed default is `[]`, since tag names are the owner's data and never go in the repo; the README says to set it in the owner's checkout (docs step). This keeps the tier at `standard`: no migration, no stored state, no new table.
- **Every pair is checked before the scan,** input or stored: the tag must be a user tag, the property a user property that the tag or a tag it extends lists (`:logseq.property.class/properties` read from `:eavt` datoms) and has no `:logseq.property/default-value`. A pair that fails refuses the call with 400, naming it (`tag-properties[1]: …` for input, `HEALTH_TAG_PROPERTIES[1] (config/settings.json health.expectedTagProperties): …` for the stored default). A broken stored pair (a tag renamed in the app) therefore stops calls that run this check, loudly, with the way out in the message; other checks still run when `checks` leaves this one out.
- **No pairs** (no input, stored `[]` or unset): the check answers `{"count": 0, "items": [], "note": "no expected tag-property pairs: pass tag-properties or set health.expectedTagProperties in config/settings.json"}` and lists nothing.
- The check's result always names what it used: `pairs: [{tag: {uuid, title}, property: {ident, title}}]` and `pairs-from: "input" | "settings" | "none"`.

**Decision: Private content in the old checks.** An entity in `private-ids` (tagged Private, or with a class extending one, in the Recycle bin, or under one of those) is never an item and never a member of a duplicate group. Usage by a Private object still counts as usage: a tag only Private objects carry is in use, so `orphan-tags` doesn't list it (listing it would invite a delete that strips the Private objects' tag). `mismatched-choice-values` drops a Private holder; `orphan-choices` drops a choice that is itself private. A duplicate-title group that drops below two members is not reported.

**Decision: `since` and `until`.** `parse-time-bound` (Stage 4) accepts:
- digits only: epoch ms;
- `YYYY-MM-DD`: local midnight of that date in the owner's zone (`owner-time-zone`);
- `YYYY-MM-DDTHH:MM[:SS[.sss]]` with `Z` or `±HH:MM`: that instant; with no offset: that local time in the owner's zone.
A date that doesn't exist (`2026-02-30`) is refused, by round trip. A local time in a daylight-saving gap takes the offset after the change. One `Intl.DateTimeFormat` per request, never per entry (`per-entry-intl-formatters-burn-the-cpu-budget.md`). An invalid `TIMEZONE` answers the existing 500 only when a date form needs it; epoch ms still works. The response echoes both bounds as ms and names `time-zone`.

**Tier.** `standard`, as the intake suggested: no D1 table (the stored pairs are a Worker variable), no migration, no auth or token change, no write path.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`; the real `sync-handler/handle-http` on a `sqlite-export/create-conn` graph through `request!`, as `semantic_index_health_test.cljs` does); Datascript (Logseq's fork); Node scripts with `node:test`; the TypeScript connector with vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-changes-schema-health-design.md`. Read it first; it is the authority, and section numbers below (§3.3 and so on) are its own. **Section 12 overrides sections 6, 7, 10 and 11:** all three parts ship in this PR (decision 1); `missing-tag-properties` checks only expected pairs (decision 2, replacing §3.2's "every user property the tag lists"); a move as `page-changed` is enough (decision 3); the old checks are fixed here, not sent to the backlog (decision 4, replacing §6's *Private content*, §7 risk 4 and the §10 line); `since` also takes ISO dates (decision 5, replacing §3.3's "ms only" and §7 risk 8). This plan moves each piece of contract text into the stage whose behaviour it describes, because the connector's tests read the vendored OpenAPI and CI re-vendors on every push. README §11.8, the spec's As built section, the learning doc and the PR's Logseq skill note are the lane's docs step.

## Global constraints

- **Names, exactly:**
  - in `worker/handler/semantic.cljs`: `health-checks` gains `"broken-refs"` and `"missing-tag-properties"` (appended, in that order); `parse-tag-property-pairs` (raw JSON, label → `{:pairs [...]}` or `{:error "…"}`), `resolve-tag-property-pairs` (db, pairs, label → resolved pairs or `{:error "…"}`), `expected-tag-properties` (self, url, db → `{:pairs … :from "input"|"settings"|"none"}` or `{:error …}`), `max-tag-property-pairs` (50); `parse-time-bound` (raw, time-zone, formatter → ms, `::invalid` or nil), `max-changes` (20,000), `default-blocks-per-page` (10), `max-blocks-per-page` (50), `handle-changes-since`; `schema-sections` (`["tags" "properties"]`), `handle-graph-schema`;
  - in `worker/graph_insights.cljs`: `broken-refs` (db, private → `[{:holder :target-uuid :reason}]`) and `missing-tag-properties` (db, private, pairs → `[{:holder :tag :missing}]`);
  - in `worker/handler/datalog.cljs`: `private-ids` keeps its one-argument arity unchanged; Stage 4 adds `(private-ids db {:recycle-bin? false})`, the Private-tag set alone, for the `recycled` count;
  - handlers `:semantic/changes-since` and `:semantic/graph-schema`; operationIds `listChangesSince` and `getGraphSchema`; tools `list_changes_since` and `get_graph_schema`;
  - Worker variable `HEALTH_TAG_PROPERTIES`; settings key `health.expectedTagProperties`;
  - test namespaces, each registered in `test_runner.cljs`: `semantic_graph_health_private_test.cljs` (Stage 1), `semantic_graph_health_refs_test.cljs` (Stage 2), `semantic_graph_health_tag_properties_test.cljs` (Stage 3), `semantic_changes_since_test.cljs` (Stage 4), `semantic_graph_schema_test.cljs` (Stage 5).
- **Messages, in the spec's wording (§3, §4), plus the ones this plan adds.** Every 400 names its parameter or entry:
  - health: `invalid checks` (unchanged), `cursor needs exactly one check` (unchanged); `invalid tag-properties: give a JSON array of {"tag": …, "property": …}`; `tag-properties: give 1 to 50 pairs (got N)`; `tag-properties needs the missing-tag-properties check`; per pair `<label>[N]: tag <x> not found`, `<label>[N]: <Tag> is a built-in tag`, `<label>[N]: property <x> not found`, `<label>[N]: <property> is a built-in property`, `<label>[N]: <Tag> doesn't list <property> (nor does a tag it extends)`, `<label>[N]: <property> has a default value, so it always reads as set`;
  - feed: `invalid since: give epoch ms, an ISO date (2026-11-16) or an ISO datetime`, the same for `until`, `until must be after since`, `invalid limit`, `invalid blocks-per-page: give 1 to 50`, `invalid cursor`, `cursor belongs to another since`, `cursor belongs to another until`; 422 `too many changes in that window (N); pass a later since or an until`;
  - schema: `invalid sections`, `cursor needs exactly one section`, `invalid built-in: give true or false`, `invalid limit`, `invalid cursor`;
  - E2EE, all three: 409 `graph insights are unavailable for E2EE graphs` (the existing text), checked before any parameter.
- **Read-only.** No route writes. Every E2EE and refusal test asserts the datom count and `max-tx` are unchanged.
- **Datoms, not entity sets.** `class/properties`, `class/extends`, `block/tags` and `closed-value-property` are read from `:eavt`/`:avet` datoms, and every new test also runs once on an upload-path graph (`semantic_uploaded_graph_schema_test` fixture; CLAUDE.md gotcha).
- **One private set per request.** `datalog/private-ids` is built once in the handler and passed down; no per-datom `hidden-id?` walk in new code.
- **Complete counts, capped lists.** Every list keeps a complete `count` and a `next-cursor`; per-page `blocks` keep complete `created` and `updated` counts (`per-item-summary-blows-result-cap.md`). The feed ends with `"next-cursor": null` on its last page (CLAUDE.md gotcha); health and schema keep their existing shape (no key when there is no next page).
- **Caps in tool text come from code.** OpenAPI descriptions build each number from the handler's constant (`(str … max-changes …)`), and an upstream test asserts the description holds the constant's value. `connector_help` names no caps; it points at the tool (`count-claims-in-tool-text-must-come-from-the-implementation.md`).
- **Tests run the real thing.** Through `handle-http` and the router on a real conn built by real writes (outliner calls or the semantic write routes); no stubbed reader. Each new test is first seen to fail on the stage's starting tree; keep the failure text for the PR. Where a test can't fail first (a case the starting tree already handles, such as a Recycle-bin item that `hidden-id?` already drops), say so in the commit body. Example data only (`Book`, `zz …` titles, `sync.example.com`, alias `test`). The owner's graph is never written, and no graph name or page UUID goes in any file.
- **Free plan** (spec §5): per call 2 Worker requests, 0 D1 rows beyond the connector's existing auth lookup, 0 written (these are generated GET tools, not in `LOGGED_READS`), 0 neurons, 0 Vectorize, no cron or indexer change. Each commit body states that and the Durable Object CPU its tests printed; Stage 6 measures it properly.
- **Contract with Claude.** In the stage whose behaviour it describes: the OpenAPI text, a re-vendor (`scripts/vendor-upstream-api.sh .upstream`), `connector_help` (`connector/src/tools/handwritten.ts`, the `get_graph_health` sentence at about `:60`), `FIRST_LINES` and the `READ` annotation map in `connector/src/tools/spec.mjs` (about `:79` and `:243`), their tests in `connector/test/tools.test.ts` and `connector/test/kb-index.test.ts`, and `npm --prefix connector run update:manifest` (57 tools today; 58 after Stage 4, 59 after Stage 5). Each commit body says whether the manifest and `FIRST_LINES` changed.
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`, `deploy`, `scripts`), with a body giving the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwX8CrBEu9tbeGDmDgu
  ```

  Push after every commit (`git push`; the branch already tracks `origin/feat/changes-schema-health`).
- **Never commit** the owner's graph name, page names, tag names, uuids, hostnames or tokens. `config/settings.json` keeps `expectedTagProperties: []`.

### Working on patches 0051 to 0053

Follow the `add-upstream-patch` skill. The intake found `.upstream` at "baseline: patches 0001-0049" with 0050's files staged, so start from a fresh checkout that matches `patches/` on HEAD. Once, before Stage 1:

```bash
SCRATCH=<the session's scratchpad>
scripts/upstream-test.sh --stop 2>/dev/null || true                 # a warm watch breaks after build.sh
rm -rf .upstream && scripts/fetch-upstream.sh .upstream            # patches 0001-0050
git -C .upstream add -A && git -C .upstream commit -qm "baseline: patches 0001-0050"
git -C .upstream tag -f p0050
scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run check:manifest                          # the vendor matches HEAD's patches
scripts/check.sh --upstream                                        # green on the starting tree
```

**Re-confirm the reproduction on HEAD** (the spec was checked at `c7bb092`; HEAD is `dcb256e`, with patch 0050 merged in). Add the spec's throwaway namespace `zz-changes-repro-test` (not committed): the page A / page B fixture of the spec's preamble, then `checks=broken-refs`, `GET …/changes`, `GET …/schema`, a move, a tag and a heading set through `set_block_property`, and a title edit, printing the stamp each bumps. Add one line: a page tagged with a user class `Private` that has no tag, and `checks=pages-without-tags`. Run `scripts/upstream-test.sh .upstream zz-changes-repro`, keep the output for the PR, and delete the namespace. Expected: the spec's seven lines, `schema route 404`, and the Private page listed by `pages-without-tags`. If any line differs, stop and report it before Stage 1 (CLAUDE.md: a report may already be fixed).

Each patch has its own base tag in `.upstream`: 0051 is `git diff p0050`, 0052 is `git diff p0051`, 0053 is `git diff p0052`. At the end of a stage:

```bash
scripts/build.sh .upstream                                          # dev test build and the release bundle
scripts/upstream-test.sh .upstream '<this stage's namespaces>|semantic-index-health|semantic-uploaded-graph-schema|e2ee-semantic'
(cd .upstream/deps/db-sync && pnpm test)                            # the whole suite
git -C .upstream add -A
git -C .upstream diff --cached <base tag> > patches/<this stage's patch>
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"     # every patch applies from scratch
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector run update:manifest
scripts/check.sh --upstream                                         # runs release-query-check.mjs too
```

After Stage 3's commit: `git -C .upstream commit -qm "0051" && git -C .upstream tag -f p0051`. After Stage 4's: the same with `0052` and `p0052`. To change an earlier patch later (a review finding), edit it on a scratch checkout of its base tag with it applied, regenerate it against that tag, then rebuild `.upstream` from scratch with `scripts/fetch-upstream.sh` and re-tag; the from-scratch apply proves the later patches still fit. To keep that cheap, 0052 and 0053 add their code in new sections of `semantic.cljs` (after `handle-block-changes` and after `handle-insights`), new route entries and new OpenAPI entries, and touch 0051's lines only in `dispatch-handle`.

To see an upstream test fail first, write it, then stash the source change (`git -C .upstream stash push -- deps/db-sync/src`), rebuild, run, and pop. If `scripts/upstream-test.sh` is running as a watch, stop it (`--stop`) before `scripts/build.sh` and start it again after (CLAUDE.md gotcha). `scripts/check.sh` prints a WARNING for each scripts test that skipped itself; a stage is not green while one names a test this plan relies on.

### Read before starting

- `REVIEW.md`, sections *Gates and tests*, *API and patches* (especially *A many attribute is read from datoms* and *A new input form or refusal reaches every site*), *Cost* and *Contract and docs*.
- `docs/solutions/cost/durable-object-cpu-limit-on-free.md`, `docs/solutions/cost/per-request-scan-of-a-cached-index-needs-a-cpu-bench-at-the-cap.md`, `docs/solutions/cost/d1-reads-from-indexer-scans.md`, `docs/solutions/cost/per-entry-intl-formatters-burn-the-cpu-budget.md`, `docs/solutions/api/an-optional-narrowing-argument-must-refuse-not-widen.md`, `docs/solutions/connector/per-item-summary-blows-result-cap.md`, `docs/solutions/connector/count-claims-in-tool-text-must-come-from-the-implementation.md`, `docs/solutions/sync/uploaded-graph-keeps-the-apps-schema-drift.md`, `docs/solutions/sync/tx-meta-listener-keeps-the-last-outliner-op.md`, `docs/solutions/api/read-hid-built-in-properties.md`, `docs/solutions/testing/a-test-that-skips-on-build-state-hides-a-red-gate.md`.
- In `worker/handler/semantic.cljs` (line numbers on the 0050 tree): `default-limit`/`max-limit` (`:37`), `tag-response`, `tag-detail-response`, `property-response` (`:96` to `:134`), `parse-limit` and `pagination-options` (`:215`, `:270`), `parse-timestamp` and the time filters (`:276` to `:296`), `owner-time-zone` and `invalid-time-zone-response` (`:704`, `:715`), `context-snippet` (`:2605`), `handle-block-changes` and its 410 (about `:3250`), `page-ref-response` and `holder-response` (`:5449`, `:5455`), `title-key`, `paginate-by`, `health-checks`, `health-check`, `handle-insights` (`:5490` to `:5630`), `dispatch-handle` (about `:6165`) and `handle` (about `:6190`).
- In `worker/graph_insights.cljs`: `hidden-id?`, `visible-ids`, `tagged-ids`, `built-in-id?`, `value-block-property`, `class-lineage-fn`, and the seven checks (`:196` to `:290`). In `worker/handler/datalog.cljs`: `private-ids` (`:529`). In `deps/db/src/logseq/db/frontend/content.cljs`: `id-ref-pattern` (`:11`) and the stored ref forms around it (spec §7 risk 9).
- In `worker/routes/semantic.cljs`: the `getGraphHealth` route (`:22`), description (`:170`) and response schema (`:599`, `:698`).
- `scripts/render-wrangler.mjs` (`TIMEZONE` at about `:95`) and its test; `scripts/bench-datalog-query.mjs` and `scripts/release-query-check.mjs` (the release-bundle loader).
- Tests: `semantic_index_health_test.cljs` (`request!`, the health fixture), `semantic_uploaded_graph_schema_test.cljs`, `e2ee_semantic_test.cljs`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A tag whose only objects are Private, and a property whose only values are on Private holders:** not listed by `orphan-tags` or `orphan-properties` (in use), while a tag tagged Private itself is not listed either (Stage 1).
2. **A duplicate-title pair where one page is Private, and a triple where one is in the Recycle bin:** the pair is not reported; the triple is reported with two members (Stage 1).
3. **A Private class extended by another class:** objects of the subclass are private for every check (Stage 1).
4. **A block under a Private page (not tagged itself) holding a mismatched choice:** left out (Stage 1).
5. **`[[uuid]]` and `((uuid))` in one title, the same missing target twice in one title, a ref in a property value block's title, and an uppercase uuid:** one item per holder and target, value block reported as its owner block, case-insensitive match (Stage 2).
6. **A ref to a page in the Recycle bin, and to a block whose page is in the bin:** both `in-recycle-bin` (Stage 2).
7. **A ref to a Private target (tagged Private, not in the bin) from a visible holder:** not listed. Reason `missing` would be false, and the spec allows only `missing` and `in-recycle-bin`, so a ref the owner can't see the target of is not a broken ref (Stage 2).
8. **`tag-properties` given as `[]`, as a non-array, with 51 pairs, with a duplicate pair, and with the same property under two tags:** refused, refused, refused, de-duplicated, both checked (Stage 3).
9. **A property inherited through `extends` two levels up, on an object tagged with the subclass:** checked; an object with the empty placeholder counts as missing (Stage 3).
10. **A stored pair whose tag was renamed in the app, with `checks=orphan-tags` only:** the call succeeds (the pair is read only when its check runs) (Stage 3).
11. **`since` as `2026-09-27` with `TIMEZONE=Pacific/Auckland` (the day NZ daylight saving starts), `2026-04-05` (ends), `2026-11-16T09:00` (local), `2026-11-16T09:00:00Z`, `2026-11-16T09:00+13:00`, `2026-02-30`, `1e12`, `-1`, `  17000 `, an empty value and no value:** right ms for the first five; refused naming `since` for the rest (Stage 4).
12. **A block edited and then moved to another page within the window:** listed once, under its current page; the old page shows `page-changed` (Stage 4).
13. **A property value block changed and its owner block also edited:** one block entry, not two (Stage 4).
14. **Exactly 20,000 datoms in the window and 20,001:** the first answers, the second answers 422 naming 20,001 without realising the rest (Stage 4).
15. **A cursor reused with a different `since`, with `until` omitted, and with `until` different:** refused, taken from the cursor, refused (Stage 4).
16. **A tag, a property and a journal edited in the window:** a tag and a property are listed as their own group with `kind`; built-ins never (Stage 4).
17. **A choice used only by Private holders:** `usage-count` 0; a property used only by Private holders: `value-count` 0 (Stage 5).
18. **`sections=tags,tags`, `sections=` (empty), `built-in=yes`:** de-duplicated, refused, refused (Stage 5).

---

### Stage 1: Patch 0051, Private and Recycle bin left out of the old health checks

**Goal:** every existing `get_graph_health` check leaves out Private and Recycle-bin content, with one regression test per check that fails without the fix. No new check or parameter. Lands spec §12 decision 4 and acceptance line 4.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `handle-insights`' graph-health branch builds `(datalog/private-ids db)` once and passes it in `options`; `health-check` removes private entities before `paginate-by` in every branch (items for the tag, property, page and choice checks; holders for `mismatched-choice-values`; members for `duplicate-titles`, then drops groups under two). The private set is built only when the call runs a check (always true today; keep the build inside the branch, not in `handle-insights`' shared prelude, so backlinks and the index are unchanged).
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `getGraphHealth` description gains "Private content and the Recycle bin are left out; a tag or property used only by Private objects is in use."
- Create (in `.upstream`): `test/logseq/db_sync/semantic_graph_health_private_test.cljs`, registered in `test_runner.cljs`.
- Create: `patches/0051-semantic-health-broken-refs-missing-tag-properties.patch`.
- Modify: `connector/vendor/openapi.json`, `connector/vendor/semantic_api_tools.mjs`, `connector/src/tools/handwritten.ts` (the `get_graph_health` sentence: "Private content and the Recycle bin are left out."), `connector/test/tools.test.ts` (a phrase check for that sentence and the vendored description).

**Interfaces produced:** `(:private options)` in `health-check`, a set of entity ids. Stages 2 and 3 pass it to their checks.

- [ ] **Step 1: Write the failing tests**, each through `handle-http` with `checks=<one check>`, on a graph with a user class `Private` (and `zz Secret` extending it):
  - `orphan-tags-leaves-out-private`: a tag tagged Private and unused; a tag in the Recycle bin; neither listed. A tag only a Private object carries: not listed (review focus 1).
  - `orphan-properties-leaves-out-private`: a property tagged Private with no values; one in the bin; one whose only value is on a Private holder (not listed, in use).
  - `duplicate-titles-leaves-out-private`: review focus 2.
  - `pages-without-summary-leaves-out-private` and `pages-without-tags-leaves-out-private`: a Private page (it has the Private tag, so give `pages-without-tags` a page tagged `zz Secret`, whose tag is not Private by title, review focus 3), a page in the bin, a block-level case that doesn't apply (pages only); none listed.
  - `mismatched-choice-values-leaves-out-private`: a mismatched value on a Private holder and on a block under a Private page (review focus 4); neither listed; a visible one still is.
  - `orphan-choices-leaves-out-private`: a stranded choice that is itself under a Private parent; not listed.
  - `default-call-leaves-out-private`: the default all-checks call on the same graph lists none of the above in any check, and each count matches its items.
  - `private-filter-upload-path`: `pages-without-tags` and `orphan-tags` on an upload-path graph.
- [ ] **Step 2: Run on the starting tree** and keep the failures. Expected: every Private case is listed; the Recycle-bin cases already pass where `hidden-id?` drops them (record which in the commit body).
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** skip the filter in each of the seven branches in turn; filter duplicate groups before counting members instead of after; build `private-ids` without the extends lineage (pass a lineage that returns only the class). Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `fix(api): graph health leaves out Private and Recycle-bin content`. Body: the failures seen (one per check), the mutation results, which bin cases already passed, the usage decision, that the manifest and `FIRST_LINES` did not change, and cost (one `private-ids` per health call, about 47 ms at 5,000 pages per spec §5; the figure the default-call test printed).

**Done when:** every old check leaves out Private and Recycle-bin content with a test that failed first (or is named as already passing), all 51 patches apply from scratch, the whole db-sync suite passes, and `scripts/check.sh --upstream` is green.

---

### Stage 2: Patch 0051, the `broken-refs` check

**Goal:** `checks=broken-refs` lists every visible block or page whose stored title refers to a uuid with no entity or one in the Recycle bin. It runs in the default set. Lands spec §3.2 (`broken-refs`), §4 (its item) and acceptance lines 1 and 2.

**Files:**
- Modify (in `.upstream`): `worker/graph_insights.cljs`: `broken-refs`: one pass over `(d/datoms db :aevt :block/title)`, skipping holders in `private` and built-ins; `re-seq db-content/id-ref-pattern` on each title (check in `content.cljs` that it covers `[[uuid]]` and `((uuid))`, and the tag form if one is stored, spec §7 risk 9; add a test for each form it covers); for each distinct target, no entity is `missing`, an entity with `:logseq.property/deleted-at` on itself or a parent is `in-recycle-bin`, a target in `private` that isn't in the bin is not reported (review focus 7). A property value block's holder is its owner block (`value-block-property`).
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `health-checks` gains `"broken-refs"`; `health-check`'s branch pages by `[holder uuid, target uuid]` and answers `holder-response` plus `target-uuid` and `reason`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `checks` parameter and description list `broken-refs` and its item; the response schema's item.
- Modify (in `.upstream`): `semantic_graph_health_refs_test.cljs` (new); `semantic_index_health_test.cljs` (the default set now has eight checks).
- Modify: `patches/0051-…`, the vendored API, `handwritten.ts` (the `get_graph_health` sentence gains broken refs), `spec.mjs` (`FIRST_LINES.get_graph_health`: "A tidy-up report: unused tags and properties, duplicate titles, pages with no summary or tag, broken refs."), `connector/test/tools.test.ts`, `connector/test/kb-index.test.ts` if it pins the first line.

- [ ] **Step 1: Write the failing tests:**
  - `broken-refs-missing`: a block titled `see [[<uuid with no entity>]]` (the spec's repro, stored through the outliner); listed with `uuid`, `kind`, `title`, `page-id`, `page-title`, `target-uuid` and `reason "missing"`.
  - `broken-refs-in-recycle-bin`: a `((uuid))` to a block deleted through `delete_block` (recycled), and a `[[uuid]]` to a page recycled through `delete_page` and to a block on it (review focus 6).
  - `broken-refs-skips`: a valid ref (not listed); a holder that is Private, and one in the bin (not listed); a built-in page (not scanned).
  - `broken-refs-forms`: review focus 5, and a ref to a Private target (review focus 7).
  - `broken-refs-paging`: three broken holders, `limit=2`, the cursor returns the third; `count` is 3 on both pages; `checks=broken-refs,orphan-tags` with a cursor is refused (`cursor needs exactly one check`).
  - `broken-refs-default-set`: the default call includes `broken-refs`; `checks=broken-ref` (typo) still answers `invalid checks`.
  - `broken-refs-upload-path` and `broken-refs-e2ee` (409, nothing written, in `e2ee_semantic_test.cljs`).
  - Connector (vitest): the `get_graph_health` phrases and first line.
- [ ] **Step 2: Run on the Stage 1 tree** and keep the failures (`invalid checks`, as the spec's repro).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** match only `[[…]]`; treat an entity with deleted-at only on itself (not a parent) as in the bin; drop the private-holder skip; report a Private target as `missing`; drop de-duplication of a target within one title; report the value block, not its owner; leave `broken-refs` out of the default set. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): graph health reports broken refs`. Body: the failure seen, the ref forms `id-ref-pattern` covers (read from source), the Private-target decision (not listed), the mutation results, the manifest unchanged and `FIRST_LINES` changed, and cost (one title pass; the time the test printed on its fixture).

**Done when:** `broken-refs` reports each case with the item shape of spec §4, runs in the default set, pages with complete counts, and `scripts/check.sh --upstream` is green.

---

### Stage 3: Patch 0051, `missing-tag-properties` on the expected pairs

**Goal:** `checks=missing-tag-properties` lists visible objects tagged with a tag (or a subclass) that lack an expected property of it, for the pairs given in `tag-properties` or stored in `HEALTH_TAG_PROPERTIES`; an unknown pair is refused naming it; with no pairs it reports nothing and says why. Lands spec §3.2 (`missing-tag-properties`, as §12 decision 2 changes it), §4 (its item) and acceptance lines 1 and 3.

**Files:**
- Modify: `config/settings.json` (`"health": {"expectedTagProperties": []}`), `scripts/render-wrangler.mjs` (shape check and `HEALTH_TAG_PROPERTIES`, written whenever the key is present, `"[]"` included), `scripts/render-wrangler.test.mjs` (the variable rendered; each shape refusal names the entry: not an array, 51 entries, an entry missing `tag`, an empty `property`; absent key writes no variable).
- Modify (in `.upstream`): `worker/graph_insights.cljs`: `missing-tag-properties`: for each pair, the class and its subclasses (reverse lineage from `:logseq.property.class/extends` datoms); the objects tagged with any of them (`:avet :block/tags`), minus `private`; an object misses the property when it has no `:eavt` datom for its ident or holds `:logseq.property/empty-placeholder`. One result per object and tag, `missing` listing that tag's missing expected properties in title order.
- Modify (in `.upstream`): `worker/handler/semantic.cljs`: `health-checks` gains `"missing-tag-properties"`; `parse-tag-property-pairs`, `resolve-tag-property-pairs`, `expected-tag-properties` (input first, else `HEALTH_TAG_PROPERTIES` from `(.-env self)`, else none); `handle-insights` destructures `self`; the refusals are checked before any check runs; the branch pages by `[holder uuid, tag uuid]` and answers `holder-response` plus `tag {uuid, title}` and `missing [{ident, title}]`, and the check's result carries `pairs`, `pairs-from` and, with no pairs, `note`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the `tag-properties` query parameter (string, JSON, with the shape and the 50-pair cap from `max-tag-property-pairs`), the `checks` text, the description (only expected pairs; the stored default; nothing without pairs; refusals), the response schema.
- Modify (in `.upstream`): `semantic_graph_health_tag_properties_test.cljs` (new); `semantic_index_health_test.cljs` (nine checks in the default set; with no pairs the new check's `note`).
- Modify: `patches/0051-…`, the vendored API, `handwritten.ts` (one sentence: the check, `tag-properties`, the stored default, and that it reports nothing without pairs), `spec.mjs` (`FIRST_LINES.get_graph_health` gains "missing expected tag properties" within its length limit), the connector tests.

- [ ] **Step 1: Write the failing tests:**
  - render-wrangler (`node --test`): as listed under Files.
  - `missing-tag-properties-input` (spec §8b, narrowed): user tag `Book` lists `author`, `rating` and `notes`; pairs `Book/author` and `Book/rating`. One book has both (not listed), one lacks `rating`, one holds the placeholder for `author`, one lacks `notes` only (not listed: not expected). Items, `missing`, `pairs`, `pairs-from "input"`.
  - `missing-tag-properties-inherited`: review focus 9.
  - `missing-tag-properties-settings`: the same pairs through `HEALTH_TAG_PROPERTIES` on the test's `self` env (`pairs-from "settings"`); input given as well replaces it (`pairs-from "input"`).
  - `missing-tag-properties-no-pairs`: no input and no variable, and the variable `"[]"`: `count 0`, `items []`, the `note`, `pairs-from "none"`.
  - `missing-tag-properties-refusals`: each pair message under *Messages* (unknown tag, built-in tag such as `Task`, unknown property, built-in property such as Status, a property `Book` doesn't list, a property with a default), for input and for the stored variable (the label differs); review focus 8; `tag-properties` with `checks=orphan-tags` refused; each asserts nothing was written.
  - `missing-tag-properties-stored-pair-not-read`: review focus 10.
  - `missing-tag-properties-private`: a Private book and one in the bin, not listed.
  - `missing-tag-properties-upload-path`, `…-e2ee`.
  - Connector (vitest): the new `connector_help` sentence, first line and vendored `tag-properties` parameter.
- [ ] **Step 2: Run on the Stage 2 tree** and keep the failures (`invalid checks`; the render test fails on the missing variable).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** report every listed property instead of the pairs; read `class/properties` from the entity (run on the upload-path graph); skip subclasses; treat the placeholder as set; let a property with a default through; read the stored variable when input is given; refuse a broken stored pair when the check doesn't run; skip the `[]` refusal. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): graph health reports missing expected tag properties`. Body: the failures seen, the pairs decision (input and a settings default, no D1), the mutation results, that `config/settings.json` holds `[]`, the manifest unchanged, and cost (pairs × tagged objects `:eavt` lookups; the test's time). Then tag `.upstream` as `p0051`.

**Done when:** only expected pairs are checked, every bad pair is refused naming its entry and source, no pairs means a `note` and nothing listed, the render test covers the variable, and `scripts/check.sh --upstream` is green.

---

### Stage 4: Patch 0052, `list_changes_since`

**Goal:** `GET /api/v1/graphs/{graph-id}/changes` lists the pages changed in a window, newest first, each with `latest-updated-at`, `page-changed`, complete `created` and `updated` counts and at most `blocks-per-page` blocks; counts `recycled`; ends with a null `next-cursor`; refuses every bad parameter by name and a window over the cap with 422. Lands spec §3.3 (with §12 decisions 3 and 5), §4 (`list_changes_since`), §8c and acceptance lines 5 to 7 and 9.

**Files:**
- Modify (in `.upstream`): `worker/handler/datalog.cljs`: the `{:recycle-bin? false}` arity of `private-ids` (the one-argument arity is unchanged, so `datalog_query` is unchanged).
- Modify (in `.upstream`): `worker/handler/semantic.cljs`, in a new section after `handle-block-changes`: `parse-time-bound`, `max-changes`, `default-blocks-per-page`, `max-blocks-per-page`, `handle-changes-since`:
  - E2EE 409 first; then `since` (required), `until` (default now), `limit`, `blocks-per-page`, `cursor` (`[since until latest-updated-at page-uuid]`; `until` omitted with a cursor is taken from it);
  - `(d/index-range db :block/updated-at (inc since) until)`, taking at most `(inc max-changes)` datoms; over the cap, 422 with the count of what was taken, phrased "more than 20,000" when the take stopped at the cap (the test pins the wording);
  - drop `private-ids`, hidden ids (`:logseq.property/hide?`) and built-ins; a property value block maps to its owner; a page, tag, property or journal in the range is its own group with `page-changed true`; blocks group by `:block/page`, de-duplicated (review focus 12 and 13);
  - per page: `created` (`:block/created-at` > `since`) and `updated` counts, `blocks` newest first up to `blocks-per-page`, each `{uuid, change, updated-at, snippet}`, `snippet` from `context-snippet` of the title with refs shown as titles (the delete context's renderer);
  - `recycled`: `:logseq.property/deleted-at` datoms whose value is in the window (an `:avet` range if the attribute is indexed in `property.cljs`, else its `:aevt` datoms filtered by value; say which in the commit body), roots only, minus `(private-ids db {:recycle-bin? false})`;
  - pages in `[-latest-updated-at, page-uuid]` order, `limit` per call, `next-cursor` an encoded cursor or `null`;
  - the response `{since, until, time-zone, pages, recycled, next-cursor}`.
  - `dispatch-handle` routes `:semantic/changes-since` with `self` in context.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the route (`:semantic/changes-since`, `listChangesSince`, `logseq/read`, `:read`), parameters, description (the window forms with an example, the `TIMEZONE` reading, the grouping, the caps from the constants, the cursor rule, "store this run's until as the next since", and what the feed can't see: permanent deletes, a move shows only as `page-changed` on both pages, and each write tool the stamp test finds bumping neither stamp), the response schema and the 400, 409 and 422 responses.
- Create (in `.upstream`): `semantic_changes_since_test.cljs`, registered.
- Create: `patches/0052-semantic-changes-since-feed.patch` (`git diff p0051`).
- Modify: the vendored API; `spec.mjs` (`list_changes_since: READ`; `FIRST_LINES.list_changes_since`: "What changed in the graph since a time, grouped by page; for digests and reviews."); `handwritten.ts` (one sentence: use it for "what changed since…", pass the last run's `until` as `since`, a move shows as page-changed); `connector/test/tools.test.ts` and `kb-index.test.ts` (the tool is offered, read-only, named exactly; the help sentence); `tools-manifest.json` via `update:manifest` (58).

- [ ] **Step 1: Write the failing tests**, each through `handle-http`:
  - `changes-created-edited-old`: a block created and one edited after `since`, one edited before (not listed); `change` values; `created`/`updated` counts.
  - `changes-property-set`: tags and heading set through `set_block_property` on a block: listed as an `updated` block in its page's group with `page-changed false` (the repro's case).
  - `changes-value-block`: a property value block changed: reported as its owner (review focus 13).
  - `changes-move`: `move_blocks` from A to B: both pages `page-changed true`, no block entry for the moved block (spec §12 decision 3).
  - `changes-title-edit`: both a block entry and `page-changed true` (the repro shows both stamps).
  - `changes-private-and-bin`: a Private page's edits not listed; a block recycled with `delete_block` and a page with `delete_page` each add 1 to `recycled` and are not listed; a recycled Private block doesn't count.
  - `changes-order-and-caps`: two pages ordered by `latest-updated-at`; `blocks-per-page=2` on a page with five changes keeps counts 5; `limit=1` pages through with the cursor; the last page has `"next-cursor": null`; an edit made between page 1 and page 2 (after the pinned `until`) does not shift page 2 (spec §3.3).
  - `changes-since-forms`: review focus 11, with the test's env `TIMEZONE` set to `Pacific/Auckland` and to `UTC`; `time-zone` echoed; an invalid `TIMEZONE` with an ISO date answers 500, with ms answers 200.
  - `changes-refusals`: each feed message under *Messages*, review focus 15; 409 on E2EE; each asserts nothing was written.
  - `changes-cap`: review focus 14 (build the window by bumping `:block/updated-at` on existing blocks in one transaction, so the fixture stays fast; say so in the test).
  - `changes-kinds`: review focus 16.
  - `changes-write-tool-stamps`: one case per write tool the connector exposes that edits existing content (`update_block`, `update_page`, `set_block_property`, `batch_set_block_property`, `delete_block_property`, `batch_delete_block_property`, `move_blocks`, `batch_move_blocks`, `insert_block_children`, `update_tag`, `update_property`, `promote_page_to_tag`, `refresh_refs`, `set_page_favorite`), each recording whether the block's and the page's `updated-at` moved and whether the feed lists the change. The description's blind-spot list is built from this test's result; if a tool bumps neither, its name goes in the description and a test pins the sentence.
  - `changes-route-documented`: operationId, parameters, responses, and the description holds `max-changes`, `max-blocks-per-page` and `max-limit` as formatted numbers.
  - `changes-upload-path`.
  - Connector (vitest): as listed under Files.
- [ ] **Step 2: Run on the Stage 3 tree** and keep the failures (404 `not found`, as the repro).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** read only page stamps; read only block stamps; skip the owner mapping; drop the private filter; count `created` by `updated-at`; cap `created`/`updated` at `blocks-per-page`; realise the whole range before the cap; ignore the cursor's `until`; read a date in UTC instead of `TIMEZONE`; accept `2026-02-30`; omit `"next-cursor": null`. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): list_changes_since lists what changed in a window, by page`. Body: the 404 seen, the stamp table from `changes-write-tool-stamps`, the date decision, the mutation results, the manifest 57 to 58 and the new first line, and cost (an index range bounded by the window, plus `private-ids` twice; the time the cap test printed). Then tag `.upstream` as `p0052`.

**Done when:** each case of spec §8c passes through the real handler, every refusal names its parameter, the blind-spot sentence comes from the stamp test, all 52 patches apply from scratch, the connector offers `list_changes_since` read-only, and `scripts/check.sh --upstream` is green.

---

### Stage 5: Patch 0053, `get_graph_schema`

**Goal:** `GET /api/v1/graphs/{graph-id}/schema` returns tags and properties with their details and usage counts, Private usage left out, in one call, with `sections`, `built-in`, `limit` and a one-section `cursor`. Lands spec §3.4, §4 (`get_graph_schema`), §8d and acceptance lines 8 and 9.

**Files:**
- Modify (in `.upstream`): `worker/handler/semantic.cljs`, in a new section after `handle-insights`: `schema-sections`, `handle-graph-schema`: E2EE 409; `sections` (default both; de-duplicated; others refused), `built-in` (`true`/`false` only), `limit`, `cursor` (exactly one section); one `private-ids`; tags as `tag-detail-response` plus `object-count` (`:avet :block/tags` minus private); properties as `property-response` plus `value-count` (`:aevt` on the ident, minus private holders), `usage-count` on each choice (`:avet` on the ident with the choice's id, minus private holders) and `used-by-tags` (classes whose `class/properties` datoms hold it); both sections through `paginate-by` with `title-key`. `dispatch-handle` routes `:semantic/graph-schema`.
- Modify (in `.upstream`): `worker/routes/semantic.cljs`: the route (`getGraphSchema`, `logseq/read`, `:read`), parameters, description (what each count counts, Private left out, built-ins hidden by default, the cursor rule), response schema, 400 and 409.
- Create (in `.upstream`): `semantic_graph_schema_test.cljs`, registered.
- Create: `patches/0053-semantic-graph-schema-export.patch` (`git diff p0052`).
- Modify: the vendored API; `spec.mjs` (`get_graph_schema: READ`; `FIRST_LINES.get_graph_schema`: "Every tag and property with types, choices and usage counts, in one call."); `handwritten.ts` (one sentence: for a schema review, `get_graph_schema` instead of `list_tags` plus `get_tag` per tag); the connector tests; `tools-manifest.json` (59).

- [ ] **Step 1: Write the failing tests:**
  - `schema-tags`: two user tags, one extending the other with properties; `extends`, `properties`, `object-count` excluding a Private object and one in the bin.
  - `schema-properties`: a property with choices; `value-count`, each choice's `usage-count`, `used-by-tags`; review focus 17.
  - `schema-built-in`: `built-in=false` (default) hides Task and Status; `true` shows them.
  - `schema-paging`: `sections=tags&limit=1` pages with the cursor and complete `count`; a cursor with both sections refused.
  - `schema-refusals`: review focus 18; each schema message under *Messages*; 409 on E2EE; nothing written.
  - `schema-route-documented`, `schema-upload-path` (a `closed-value-property` stored as cardinality one still gives the choice its `usage-count`).
  - Connector (vitest): the tool is offered, read-only, named exactly; the help sentence.
- [ ] **Step 2: Run on the Stage 4 tree** and keep the failures (404).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the patch workflow.** **Mutation check:** count private objects; read `used-by-tags` from the entity; count a choice by title instead of id; show built-ins by default; accept a cursor with two sections. Confirm a test fails for each. Revert.
- [ ] **Step 5: Commit and push.** `feat(api): get_graph_schema lists tags and properties with usage counts`. Body: the 404 seen, the mutation results, the manifest 58 to 59 and the new first line, and cost (counts over user tag and property datoms plus one `private-ids`; the test's time).

**Done when:** the schema response matches spec §4, counts leave out Private holders, every refusal names its parameter, all 53 patches apply from scratch, and `scripts/check.sh --upstream` is green.

---

### Stage 6: The release bundle and the CPU numbers

**Goal:** the three reads work in the release bundle, and each has a measured Durable Object CPU figure at its cap on a Free-plan-sized graph (spec §5; acceptance line 10). Scripts only.

**Files:**
- Create: `scripts/bench-graph-insights.mjs` (built as `bench-datalog-query.mjs` is: the compiled test build from `.upstream`, a seeded graph of 5,000 and 20,000 pages stored through the DO's SQLite adapter, a fresh conn per shape for the cold run). Shapes: the default health call with three stored pairs, each new check alone, `list_changes_since` at 20,000 changes with `limit=200` and `blocks-per-page=50`, `get_graph_schema` with both sections at `limit=200`. Reports cold and warm ms, and the figure × 1.65 for Cloudflare (`durable-object-cpu-limit-on-free.md`). `--json` for the test.
- Create: `scripts/bench-graph-insights.test.mjs` (shape and counts only, never times: each shape answers 200 with the expected counts on a small seeded graph; skips with a named reason when `.upstream`'s build is missing, which `scripts/check.sh` reports as a WARNING).
- Modify: `scripts/release-query-check.mjs` and its test: one call to each new route and to `checks=broken-refs,missing-tag-properties` through the release bundle's `SyncDO.fetch`, asserting the response shape (Closure renaming broke `datalog.cljs` before, and every route now calls `private-ids`).

- [ ] **Step 1: Write the failing tests:** the bench test and the release-check additions, red until the scripts exist.
- [ ] **Step 2: Run** and keep the failures.
- [ ] **Step 3: Implement**, then `scripts/build.sh .upstream` and run the bench at both sizes, three runs each.
- [ ] **Step 4: Gate.** `npm test`, `scripts/check.sh --upstream` (no patch change, but the release check needs the fresh bundle). If a figure × 1.65 passes 1 s, stop and report it rather than raising a cap.
- [ ] **Step 5: Commit and push.** `test(scripts): bench and release check for the health, change-feed and schema reads`. Body: the bench table (cold and warm, both sizes, × 1.65), the per-call totals for a weekly review and a daily digest (spec §5), D1 rows per request (0 beyond auth), and what `scripts/check.sh` skipped.

**Done when:** the release check passes on a freshly built bundle, the bench reports every shape, the figures are in the commit body for the As built note, and `scripts/check.sh --upstream` is green with its skips listed.

---

## Review round 1 changes (supersede the lines above where they differ)

- **Where the stored pairs live.** CI deploys from the committed `config/settings.json`, which keeps `[]`, so the owner's pairs go in the `HEALTH_TAG_PROPERTIES` GitHub Actions variable. `deploy.yml` passes it to the Deploy step, and `render-wrangler.mjs` uses it, checked as the settings key is, in place of `health.expectedTagProperties` when it is set and not blank (r1-light-1).
- **Stored pairs serve every graph.** One Worker serves every graph, so a stored pair that doesn't resolve in a graph is skipped, not refused: the check answers `skipped` (`[{entry: "HEALTH_TAG_PROPERTIES[N]", reason}]`) and checks the rest. Input pairs still refuse with 400, and so does a malformed stored variable (r1-integrity-1). The stored-source label and the no-pairs note now name the GitHub variable.
- **`list_changes_since` and late syncs.** `:block/updated-at` is set by the device that made the edit and sync keeps it, so the tool text and `connector_help` tell callers to overlap windows (since = the last until less a margin, a day) and skip blocks already reported with the same uuid and updated-at, and list late-synced edits under what it can't see (r1-correctness-2, r1-integrity-2, r1-light-2).
- **Blocks on built-in pages.** A block is left out only when it, or its owner, is Private, binned, hidden or built-in. The extra page check dropped every block on the built-in Contents page; blocks on Private, binned and hidden pages are already in those sets (r1-correctness-1).

## After the stages (the lane's docs step, not this plan)

- README §11.8: the two new checks and the Private rule on `get_graph_health`; `list_changes_since` (window forms, `TIMEZONE`, the cursor, what it can't see); `get_graph_schema`; the `health.expectedTagProperties` setting and how to set it in the owner's checkout. README section 4's 0013 bullet gains the checks, with new bullets for 0051 to 0053.
- The spec's As built section: the pairs decision, the date decision, the Private-target rule for broken refs, the stamp table, the bench figures from Stage 6, and the owner's checks of spec §9 items 2 and 3 once deployed.
- The PR body: the reproduction re-run on HEAD, the quoted failures from each stage, `scripts/check.sh --upstream` on HEAD with its skips, the note that 0051 to 0053 become 0050 to 0052 if PR 72 is dropped, and the **Logseq skill note**: the weekly review and daily digest call `list_changes_since` with `since` set to the previous run's `until` (store the new `until`; an ISO date works for a first run), call `get_graph_health` with `broken-refs,missing-tag-properties` and the owner's expected pairs (or rely on the stored pairs in the `HEALTH_TAG_PROPERTIES` GitHub variable), overlap `list_changes_since` windows by a day and skip blocks already reported, use `get_graph_schema` for a drift review, and know that Private and Recycle-bin content no longer appears in any health check.
