# Overnight backlog burn-down: report

This run follows `docs/superpowers/plans/2026-11-19-backlog-burn-down.md`. The branches are stacked, each cut from the one before it, and every PR is a draft against main. Nothing was merged or deployed. At the owner's request (2026-11-19, evening), the issue tasks in Logseq are updated as each lane finishes: Status, phase, branch and pr-url, plus a dated Built note. The write-backs below were applied for items 67, 38, 43 and 33 (audit entries 293 and 294); later items say whether theirs was applied.

## Morning summary (2026-11-20)

The queue is finished. Nothing was merged or deployed.

- **Fixes ready for review (12 draft PRs, CI green on each):** PRs 59 to 70 cover items 67, 38, 43, 33, 45, 36, 34, 53, 44, 35, 48 and 51. They form one stack, so merge them in order, starting with 59. Each PR's body lists its open minor should-fix findings and its proposed backlog items. Items 51's live analytics check and every PR's live verification are still to do after deploy.
- **Calls for you on fix PRs:**
  - PR 65 (item 34) refuses another block's value UUID rather than copying the value.
  - PR 68 (item 35) refuses a `#` heading prefix in page titles.
  - PR 69 (item 48) drops the session filter rather than hashing grants.
- **Already fixed, nothing to build (close in Logseq):**
  - 46: fixed by 2376d5a, on main.
  - 39: the count was right; the summary line was probably misread.
  - 37: code and math were fixed by 0037; quote escaping is by design.
  - 47: fixed by 0045 in PR 63.
  - 56: fixed by fa88b69, on main.
  - Their learnings commits ride along in the next PR in the stack.
- **Specs awaiting approval (4 draft PRs, nothing built):**
  - PR 71: item 68, routing hints
  - PR 72: item 49, Query blocks
  - PR 73: item 50, change feed, schema export and health checks
  - PR 74: item 52, client param
  - Each lists its open questions in section 11. To build one, rerun `lane-feature` with `args.spec`.
- **Patch numbers:** the fixes use 0041 to 0049. The specs plan 0050 (item 49), 0051 to 0053 (item 50) and 0054 (item 52), in that merge order.
- **Incidents:**
  - The container restarted once during item 44. Its lane resumed from its cache with nothing lost.
  - Item 51's first run returned a self-contradicting "blocked" at intake, and a fresh rerun went through.
  - `search_graph` returned HTTP 500 "dispatch error" twice around 02:50Z and then recovered.

## Summary

| Item | Status | Branch | PR | HEAD |
|---|---|---|---|---|
| 67 (formerly 27): edit-stamp precheck | ready | `fix/edit-stamp-orphaned-choice` | [#59](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59) | `0b7b2a4` |
| 38: removing one tag returns 500 | ready (two passes) | `fix/tags-reset-keeps-builtins` | [#60](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60) | `4abb221` |
| 43: Page as a tags value answers 500 | ready | `fix/page-tag-value-refused` | [#61](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/61) | `df57c67` |
| 33: JSON number read as a db id | ready | `fix/json-number-not-db-id` | [#62](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/62) | `6a629b8` |
| 45: batch class check uses stale classes | ready | `fix/batch-class-check-final-state` | [#63](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/63) | `5d23b6e` |
| 36: Tags title takes the first class | ready | `fix/tags-title-scoped` | [#64](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/64) | `425a9da` |
| 34: value block shared by UUID | ready | `fix/value-block-by-uuid-copied` | [#65](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/65) | `0a75ac4` |
| 53: indexer stops on a rejected sync | ready | `fix/indexer-survives-rejected-sync` | [#66](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/66) | `7dd3e49` |
| 46: batch insert marked non-destructive | not a bug (already fixed) | `fix/batch-insert-destructive-hint` | – | `34357b6` |
| 44: batch ignores the Task tag Status adds | ready | `fix/batch-status-adds-task-tag` | [#67](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/67) | `fc0b4cc` |
| 39: delete_blocks under-counts descendants | not a bug | `fix/delete-blocks-counts-descendants` | – | `a689030` |
| 35: '# ' page title sets a heading | ready | `fix/page-title-no-heading` | [#68](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/68) | `712e319` |
| 37: code block #word escaped | not a bug | `fix/code-block-text-verbatim` | – | `3f190ea` |
| 47: set can write Root to a property's classes | not a bug (fixed by PR 63) | `fix/property-classes-write-refused` | – | `54d2a0c` |
| 48: activity log session filter never matches | ready | `fix/audit-log-session-filter` | [#69](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/69) | `ecdca09` |
| 56: flaky release-check timing | not a bug (already fixed) | `fix/release-check-timing-steady` | – | `829670c` |
| 51: CPU probe analytics find nothing | ready (not verified live) | `fix/do-cpu-probe-analytics` | [#70](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/70) | `5506eac` |
| 68 (formerly 58): routing hints | spec awaiting approval | `feat/tool-routing-hints` | [#71](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/71) | `2f6998e` |
| 49: Query blocks | spec awaiting approval | `feat/query-blocks` | [#72](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/72) | `c7bb092` |
| 50: change feed, schema export, health checks | spec awaiting approval | `feat/changes-schema-health` | [#73](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/73) | `f3d5413` |
| 52: client param for open-tasks-by-client | spec awaiting approval | `feat/open-tasks-client-param` | [#74](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/74) | `30d61ff` |

---

## Item 67 (formerly 27): edit-stamp precheck blocks all writes after an orphaned "claude" choice

- **Status:** ready, draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#59](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59), HEAD `0b7b2a4`, full tier.
- **Cause:** the choice wasn't orphaned. The `choice of  ()` 409 came from reading `:block/closed-value-property` as a set on an app-uploaded graph, where it is stored with cardinality one. Main already fixes this, in patch 0034 as amended (91b57c6, cb08ef0).
- **What the PR adds (patch 0041):**
  - The next stamped write re-parents a stranded claude choice, with a fresh order key. A choice counts as stranded when its owner was deleted, has no ident or title, or was removed with `:db/retractEntity`.
  - A stranded choice is refused only when editedBy already has its own claude choice.
  - `get_graph_health` gets a new `orphan-choices` check.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `0b7b2a4` and every check passed: 369 scripts tests and 783 db-sync tests. tofu fmt was skipped because tofu isn't installed. The overnight run didn't run it again; CI on the PR is the independent check.
- **Regression tests:** four tests failed before the fix, including the exact reported 409 text. Four guard tests are proved by mutation instead: all 11 mutants were caught.
- **Open findings:** two minor contract findings, both in connector_help wording (r2-light-1 and r2-light-2). The PR body lists them.
- **Backlog proposal:** orphaned blocks left after a raw `:db/retractEntity` (README backlog item 26, low).
- **Retro proposals:**
  - Check whether an issue is already fixed before giving it a full-tier lane.
  - Require a reverted-fix run for guard-only tests.
  - Write down when a fix gets a new patch and when it amends one.
- **Skill note:** keep "Mark Claude's edits" on once this is deployed, and add `orphan-choices` to the weekly review.

**Logseq write-back (applied).** These go on the item's task block:

1. `batch_set_block_property`: Status In Review, phase `review`, branch `fix/edit-stamp-orphaned-choice`, pr-url `https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59`.
2. A child note under the task:

```
- **Built 2026-11-19** – patch 0041 (PR 59), not an orphaned choice: the empty-owner 409 came from reading `:block/closed-value-property` as a set on an app-uploaded graph (cardinality one), already fixed on main by patch 0034 as amended. 0041 re-parents a stranded claude choice (owner deleted, nameless, or `:db/retractEntity`) on the next stamped write, refuses it only when editedBy already has its own claude choice, and adds an `orphan-choices` check to `get_graph_health`.
  - Verified on 0b7b2a4 (scripts/check.sh --upstream green; tofu fmt skipped). Not yet checked on the live graph.
  - Owner action: the "Mark Claude's edits" workaround can be dropped once deployed.
```

---

## Item 38: removing one tag from a page returns HTTP 500

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#60](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60), HEAD `4abb221`, stacked on PR 59.
- **First pass (not a bug).** The reported Tags reset 500 doesn't happen on HEAD. Patch 0027 fixed it and was deployed on 2026-11-07, so your 500s probably came from the server before that deploy. **Question for you:** when did you see them? If it was after 7 November, it's worth checking further.
- **Second pass (full tier).** This fixed a real 500 next to the reported one. Deleting Tags on any page or journal answered "Can't remove private tags". Patch 0042 changes three things:
  - A whole-property Tags delete keeps the built-in tags and answers 200.
  - `delete_block_property` and its batch form take an optional `value`, which removes just that value.
  - Bad or misplaced arguments are refused with a 400 naming the entry, instead of deleting more than asked.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `4abb221` and it passed: 805 db-sync tests and 369 scripts tests. tofu fmt was skipped.
- **Regression tests:** more than ten tests failed before the fix. The headline is `{:status 500 ... "Can't remove private tags: :logseq.class/Page."}`. All 12 mutants were caught.
- **Open should-fix findings (minor, your call):**
  - r2-integrity-1: a value delete can remove a built-in tag property from a built-in tag, such as Status from Task. `update_tag` refuses that change. This one is worth fixing before merge.
  - r2-correctness-1: an upper-case UUID is refused.
  - r2-tests-1: one refusal hint has no test.
- **Backlog proposals:** these are in README backlog item 27.
  - A whole-property delete of `block/refs` still answers 200.
  - The other write tools drop unknown arguments without saying so.
- **Skill note:**
  - Put `value` inside `body`.
  - To remove one tag, prefer a value delete over a reset.
  - A repeated value delete answers 400.
  - Drop the item 38 quirk row.

**Logseq write-back (applied):**

1. `batch_set_block_property` on the task: Status In Review, phase `review`, branch `fix/tags-reset-keeps-builtins`, pr-url `https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60`.
2. A child note:

```
- **Built 2026-11-19** – PR 60 (patch 0042). The Tags reset 500 was fixed by patch 0027 (deployed 2026-11-07). Deleting Tags on a page or journal now keeps Page/Journal and answers 200; delete_block_property and its batch form take an optional `value` that removes one value of a many-valued property; bad entries answer 400 naming the entry.
  - Verified on 4abb221 (scripts/check.sh --upstream green; tofu fmt skipped). Not yet checked live (service token is write-no-delete).
  - Open: r2-integrity-1 (value delete can remove a built-in class property from a built-in tag).
```

---

## Item 43: Page as a tags value answers 500

- **Status:** ready. It is draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#61](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/61), HEAD `df57c67`, quick tier, stacked on PR 60.
- **Cause:** `tag-value-refusal` refused every private tag except Page. Server writes then failed later in two ways:
  - On a nested block, the outliner refused the conversion.
  - On a top-level block, journal or tag page, the write failed with `:block/name` missing, because the client pipeline that converts a block to a page doesn't run on the server.
- **Fix (patch 0043):** Page is refused unless the target already holds it. The 400 names the entry or path, and nothing is written. Re-sending Page to a page still works. The rule depends on which tags the target already holds, not on what kind of block it is, which also covers journals and tag pages.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `df57c67` and it passed (809 db-sync tests). tofu fmt was skipped.
- **Regression tests:** 42 assertions failed before the fix, for example `{:status 500 ... "Can't convert this block to page since its parent is not a page."}`. All 3 mutants were killed.
- **Open findings:** none. No backlog proposals.
- **Retro:** test a refusal rule on every target type; record why the tier was lowered.
- **Skill note:** never put Page or Tag in Tags on something that doesn't already hold it. To turn a block into a page, use convert-to-page in the app; to turn a page into a tag, use `promote_page_to_tag`.

**Logseq write-back (applied):**

1. `batch_set_block_property` on the task: Status In Review, phase `review`, branch `fix/page-tag-value-refused`, pr-url `https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/61`.
2. A child note:

```
- **Built 2026-11-19** – PR 61 (patch 0043). Page as a tags value is refused with a 400 naming the entry unless the target already holds it (set, batch-set, reset and every insert path); nothing is written. Re-sending Page to a page still works.
  - Verified on df57c67 (scripts/check.sh --upstream green; tofu fmt skipped). Not yet checked live.
```

---

## Item 33: a bare JSON number was read as a db id

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#62](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/62), HEAD `6a629b8`, standard tier, stacked on PR 61.
- **Cause:** `resolve-ref-entity` (patch 0021) had a branch that turned any number into `d/entity`. Only choice and number properties caught numbers before it, so node, date, URL, text and Tags values on all four write paths took the db-id branch. For example, `topic = 150` stored the History block.
- **Fix (patch 0044):**
  - A text property stores a number as text.
  - Other properties resolve a number as a title.
  - A number that matches nothing is refused with a 400 that asks for a UUID.
  - README Backlog item 9 is closed.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `6a629b8` and it passed (817 db-sync tests, 369 scripts tests). tofu fmt was skipped.
- **Regression tests:** 7 tests failed before the fix (162 of 315 assertions). One example is `topic = 150 ... [{:id 150, :title "History block"}]`.
- **Should-fix findings left open (minor, your call):**
  - r1-correctness-1 / r1-integrity-1: a text property given an integer above 2^53 or 1e21 silently stores a different number as text. These were refused before.
  - r1-tests-1: the `isFinite` guard has no test.
- **Backlog proposal:** r1-correctness-2 (major, pre-existing upstream code). `[[N]]` in a block title still resolves to the entity with db id N.
- **Retro proposals:**
  - Quote README backlog headings instead of their numbers. The brief said item 10; it is item 9.
  - Claim mutation checks only for rules that were actually mutated.
  - When closing a lookup rule, grep the earlier patches' tests and sibling lookup sites.
- **Skill note:**
  - Numbers are now matched as titles or stored as text, so they no longer need quoting.
  - Name an existing entity by UUID, never by db id.
  - Until the backlog items are fixed, send integers above 2^53 as strings, and use `[[uuid]]` for numeric page titles in block titles.

**Logseq write-back (applied):**

1. `batch_set_block_property` on the task: Status In Review, phase `review`, branch `fix/json-number-not-db-id`, pr-url `https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/62`.
2. A child note:

```
- **Built 2026-11-19** – PR 62 (patch 0044). A bare JSON number is never a db id: a text property stores it as text; node, date, URL and Tags values resolve it as a title; an unmatched number is refused with a 400 asking for a UUID. Covers set, batch set, insert tree and batch insert trees.
  - Verified on 6a629b8 (scripts/check.sh --upstream green; tofu fmt skipped). Not yet checked live.
  - Open: integers above 2^53 stored as rounded text (r1-correctness-1); `[[N]]` in titles still resolves db id N (proposed backlog).
```

---

## Item 45: a batch that changes classes or extends stores out-of-class values

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#63](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/63), HEAD `5d23b6e`, standard tier, stacked on PR 62.
- **Cause:** patch 0031's batch class check overlaid only the final tags. It read the property's classes and the tags' extends from before the batch. That had three effects:
  - silent out-of-class stores
  - false refusals
  - a batch-set route that skipped update_property's own checks
- **Fix (patch 0045):** set, batch set and insert refuse writes to `logseq.property/classes` and `logseq.property.class/extends`. The refusal names the entry and points to update_property or update_tag, and nothing is written. Refusing was chosen over overlaying the final classes and extends.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `5d23b6e` and it passed (822 db-sync tests). tofu fmt was skipped.
- **Regression tests:** 43 failures before the fix, all in the 5 new tests. All 5 mutants were killed.
- **Open should-fix (minor):** r1-correctness-1 / r1-light-1. The help and README say only update_property and update_tag write these two properties, but the delete tools still reset extends and clear classes.
- **Backlog proposals:**
  - refuse the delete paths too
  - a single set of a many-valued property may add to its values instead of replacing them (needs a probe)
- **Skill note:** change classes with update_property and extends with update_tag, in their own call, before writing values that depend on them.
- **Logseq write-back:** applied (audit entries 295 and 296).

---

## Item 36: a Tags value given by title took the first class with that title

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#64](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/64), HEAD `425a9da`, standard tier, two review rounds, stacked on PR 63.
- **Cause:** the Tags string branch in `resolve-ref-entity` took `first` of the matching classes, so the oldest class won. Patch 0021 had moved the other ref properties onto `title-candidates`, but not Tags.
- **Fix (patch 0046):** a title that several visible classes share is refused with a 400 listing their UUIDs, on all four write paths. Hidden and recycled classes no longer match, and matching stays exact.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `425a9da` and it passed (828 db-sync tests). tofu fmt was skipped.
- **Regression tests:** 73 of 122 assertions failed before the fix. Mutating the filter guards gave 16 failures each.
- **Open should-fix (minor):** connector_help doesn't mention the Tags shared-title refusal.
- **Backlog proposals:**
  - major, pre-existing: `resolve-tag-selector` still takes the oldest class for a property's classes, a tag's extends and the named-query tag param.
  - minor: a user tag sharing a built-in title is refused with bare UUIDs, so you can't tell which is the built-in.
- **Skill note:** pass a tag's UUID when its title may be shared, such as namespace tags or a tag with a built-in title.
- **Logseq write-back:** applied (audit entries 297 and 298).

---

## Item 34: a text or URL value given as another block's value-block UUID was shared

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#65](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/65), HEAD `0a75ac4`, full tier, one review round, stacked on PR 64.
- **Cause:** `refused-by-type` checked only that a value block belonged to the property (patch 0022), never which block held it. B was given A's child value block, and deleting A removed B's value with no error.
- **Decide-first call (yours to overrule):** refuse rather than copy. The app's single-block editor always gives a block its own value block; only multi-block selection shares. A copy would drop children and can't work on E2EE graphs.
- **Fix (patch 0047):** a text, URL or number value whose parent is neither the property nor the block being written is refused with a 400 naming the entry, the UUID and its holder, on all four write paths.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `0a75ac4` and it passed (838 db-sync tests). tofu fmt was skipped.
- **Regression tests:** five new tests failed before the fix (12, 12, 8 and 12 failures across the paths). All five mutants were killed.
- **Open should-fix (minor):**
  - a block that already shares a value can't re-send it by UUID
  - the PropertyValue schema text and the E2EE advice were not updated
- **Backlog proposals:** major, pre-existing: a number given by value still reuses an imported graph's value block parented to its holder, so it is lost when the holder is deleted. Existing shared refs are still lost on delete (README backlog 28, added by this lane).
- **Skill note:** pass the text or URL itself, never another block's value-block UUID. Re-sending a block's own value UUID is fine.
- **Logseq write-back:** applied (audit entries 299 and 300).

---

## Item 53: one rejected sync request aborted a whole semantic indexer run

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#66](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/66), HEAD `7dd3e49`, standard tier, one review round, stacked on PR 65. Connector only, no patch.
- **Cause:** PR 52 wraps a rejected `env.SYNC.fetch` as `SyncStoppedError`. The indexer's per-page catch handled only `SyncError` and `BindingError` and rethrew anything else, so the run stopped. The failed graph stayed leased as `building` with no error, and later graphs were skipped.
- **Fix:** the `BindingError` branch also takes `SyncStoppedError`. It records the graph's error, moves on to the next graph and retries after the lease expires. No extra D1 reads (a test checks the statement count).
- **Gate:** the lane ran `scripts/check.sh` on `7dd3e49` and it passed (1017 connector tests). `--upstream` was not needed. tofu fmt was skipped.
- **Regression tests:** five tests through the real `runIndexer`, all failing before the fix. The mutant was killed.
- **Open should-fix (minor):** a reset after the headers, while the feed body is read, still aborts the run.
- **Backlog proposals:** that case, and other non-sync errors such as a malformed feed (README known limit 29, added by this lane).
- **Skill note:** none needed (cron-internal).
- **Logseq write-back:** applied (audit entries 301 and 302).

---

## Item 46: batch_insert_block_trees marked non-destructive

- **Status:** not a bug. It was already fixed on main by commit 2376d5a, the annotation work that followed the review that logged it. Quick tier.
- **Evidence:** `connector/src/tools/spec.mjs` classes the tool as DESTRUCTIVE. `tools-manifest.json`, connector_help and README 11.8 agree, and `connector/test/tools.test.ts` pins it (241 tests pass). `insert_block_tree` and `insert_block_children` rightly stay additive, because they reuse an existing block unchanged.
- **Commits:** one learnings note (`34357b6`, "an issue logged in review may already be fixed at HEAD"). It has no PR of its own and rides along in item 44's PR.
- **Your call:** close item 46. I left its Status alone and added a "Checked" note (audit entry 304).

---

## Item 44: a batch ignored the Task tag that setting Status adds

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#67](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/67), HEAD `fc0b4cc`, standard tier, two review rounds plus a targeted round. Stacked on item 46's learnings commit and PR 66. The container restarted mid-lane; the run resumed from its cache with nothing lost.
- **Cause:** the batch class check's `final-tags` overlay counted only explicit tag writes. The outliner also adds Task when Status, Scheduled or Deadline is set on a block whose tags don't provide them, so a Task-limited value pointing at that block was refused in validation.
- **Fix (patch 0048):** both batch paths emit an implicit-Task write in request order, which `final-tags` applies as the outliner would: no Task for a null or empty value, a Scheduled or Deadline already held, or a tag that provides the property. A later reset drops it again.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `fc0b4cc` and it passed (848 db-sync tests). tofu fmt was skipped.
- **Regression tests:** a new namespace with fail-before quotes on both paths. All six mutants (M1–M6) were killed.
- **Open should-fix (minor, all false refusals, nothing written):**
  - batch insert judges an entry's tags before its Status regardless of key order
  - a repeated Status after a tag reset is treated as a no-op
  - an earlier commit body over-claimed its mutation results
- **Learnings:** a new CLAUDE.md gotcha (`final-tags` copies the tag rules and the implicit Task rule; change them together) and a REVIEW.md rule.
- **Skill note:** drop any workaround that splits a batch because Status on an untagged block made a later Task-limited property fail.
- **Logseq write-back:** applied (audit entries 305 and 306).

---

## Item 39: delete_blocks under-counted descendants in total-removed

- **Status:** not a bug (confidence 0.85, one skeptic did not refute it). Standard tier.
- **Evidence:** since patch 0012 was first committed (d07f186), the handler has built `removed` from each block plus `get-block-full-children-ids` and answered `total-removed` as its size, in the dry run and in the real call. Each affected entry carries `descendants`. An existing test asserts `total-removed` 4 for blocks with 2 and 0 children, and the semantic-bulk suite passes on HEAD. The connector passes the count through unchanged. The likely cause of the report is that the summary line ("Deleted 2 blocks … +1 child") was read as the total.
- **Commits:** a learnings note (`a689030`) and a new CLAUDE.md gotcha (repro the exact call on HEAD and read the raw field before investigating; four lanes have now ended as not-a-bug). It has no PR of its own and rides along in item 35's PR.
- **Your call:** close item 39, or check the raw `total-removed` in the original response if you still have it. A "Checked" note was added (audit entry 308).

---

## Item 35: a '# ' page or tag title set the heading property on the page

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#68](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/68), HEAD `712e319`, quick tier, one review round, stacked on item 39's learnings commit and PR 67.
- **Cause:** in `update_block`, patch 0024's heading step only exempted code, math and quote blocks, not pages, tags or properties. `update_page` and `update_tag` had a second defect: the outliner silently dropped the prefix, or answered 500 when the prefix had leading whitespace.
- **Fix (patch 0049):** all three routes refuse such a title with a 400 that names `#` and the title, and write nothing. Refusing was chosen over stripping because the outliner refuses `#` in any page name, as `create_page` already does. Docs now say how to remove a heading: delete `logseq.property/heading`.
- **Gate:** the lane ran `scripts/check.sh --upstream` on `712e319` and it passed (856 db-sync tests). tofu fmt was skipped.
- **Regression tests:** six tests failed before the fix, plus a guard and a control. All three mutants were killed.
- **Open:** none.
- **Backlog proposals:**
  - README 30: a `#` elsewhere in a page title still answers 500
  - README 31: asset titles still take the heading step
  - no journal or E2EE test
- **Skill note:** don't send a `#` prefix in page, tag or property titles. To remove a block's heading, delete `logseq.property/heading`.
- **Logseq write-back:** applied (audit entries 313 and 315).

---

## Item 37: an unknown #word was escaped inside code and math blocks

- **Status:** not a bug (confidence 0.85). Quick tier.
- **Evidence:** a repro through the real handler on HEAD shows patch 0037 already keeps code and math titles verbatim on `update_block`, and that `refresh_refs` neither lists nor changes them. Existing tests pin this. Quote blocks still escape an unknown `#word`, which was a documented design choice (spec 2026-11-08). The app parses tags in a quote, so an unescaped `#word` would turn into a stray tag at the quote's next edit.
- **Commits:** a learnings note (`3f190ea`). It has no PR of its own and rides along in item 47's PR.
- **Your call:** close item 37, or log a feature if you want quote titles kept verbatim too. A "Checked" note was added (audit entry 320).

---

## Item 47: set_block_property could write Root to a property's classes

- **Status:** not a bug on this stack (confidence 0.95). It is already fixed by patch 0045 (PR 63, item 45). Quick tier.
- **Evidence:** the exact repro, replayed through the real handler on patches up to 0049, now answers 400 `entry 0: logseq.property/classes can't be set here; use update_property (classes)` and stores nothing. The same holds for batch set in either mode, batch insert, `insert_block_tree` and `insert_block_children`.
- **Commits:** a learnings note (`54d2a0c`). It has no PR of its own and rides along in item 48's PR.
- **Your call:** close item 47 once PR 63 merges and deploys. A "Checked" note was added (audit entry 324).

---

## Item 48: get_activity_log's session filter never matched

- **Status:** ready. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#69](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/69), HEAD `ecdca09`, standard tier, one review round. Stacked on items 47 and 37's learnings commits and PR 68. Connector only, no migration.
- **Cause:** the agents SDK MCP handler is stateless and never issues `mcp-session-id`, so claude.ai and Claude Code never send one. Every row's session is null, and the filter returned no entries for any value.
- **Fix:** the `session` input is refused by name, including when `id` is given, and the query no longer filters on it. The column stays.
- **Decide-first call (yours to overrule):** the lane dropped the filter rather than keying sessions by a grant hash. One OAuth grant spans many conversations, so the hash would group by grant, not session. It would also need an HMAC secret and a migration. `client` already tells callers apart.
- **Gate:** the lane ran `scripts/check.sh` on `ecdca09` and it passed (1019 connector tests). `--upstream` was not needed. tofu fmt was skipped.
- **Regression tests:** real-Worker tests on three lanes, which failed before the fix. A premise guard fails if the SDK ever starts issuing session ids. The mutant was killed.
- **Open should-fix (minor, wording):**
  - the `id` input's text still says the other inputs are ignored
  - the refusal over-claims that no entry could match
- **Skill note:** don't pass `session`. Use `client`, `tool`, `status` and the date range.
- **Logseq write-back:** applied (audit entries 333 and 334).

---

## Item 56: a flaky release-bundle timing check (F1, 100 ms)

- **Status:** not a bug any more (confidence 0.9). Quick tier.
- **Evidence:** the 103 ms median was seen at PR 52's stage 6 gate (f4ff06d). At that point the F1 shapes ran over the blocks until the width cap stopped them, at 88–145 ms. PR 52's own review round (fa88b69, s-2-1) added the 12-function-binding refusal, so the 422 now comes before anything runs. On the release bundle as last built, 20 rounds gave a median of 1–2 ms (max 3), and none came near 100 ms. Widening the bound would only loosen a check that already has about a 50× margin.
- **Commits:** a learnings note (`829670c`). It has no PR of its own and rides along in item 51's PR.
- **Your call:** close item 56. A "Checked" note was added (audit entry 337).

---

## Item 51: the CPU probe's analytics found no invocations and no CPU field

- **Status:** ready, but **acceptance 1 is not verified live**, because this session has no Cloudflare credentials. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#70](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/70), HEAD `5506eac`, standard tier, two review rounds. Stacked on item 56's learnings commit and PR 69. The first run stopped at intake with a self-contradicting "blocked" result, and a fresh rerun went through.
- **Cause:**
  - The probe made one burn per target, so it couldn't tell an ordinary restart from a CPU kill.
  - The `sum.cpuTime` error was noise from a fallback chain. Analytics came back empty because of the time window, the script filter or ingestion lag.
- **Fix:**
  - `--repeats` (workflow default 3, at most 5), with a verdict per run: kept, restart, kill or error. The limit bracket now comes from kills only.
  - CPU is read from the quantile fields.
  - The analytics window now reaches the time of the read.
  - When the answer is empty, the probe reads again without the script filter and says why nothing came back.
- **Gate:** the lane ran `scripts/check.sh` on `5506eac` and it passed (389 scripts tests). `--upstream` was not needed. tofu fmt was skipped.
- **Open should-fix (minor):**
  - repeats × durations can outrun the job's 30-minute timeout, and the results are written only at the end, so they are lost
  - a failed state read counts as a restart
  - one summary clause is unpinned
- **Owed:** rerun do-cpu-probe from Actions after merge and check the CPU column and the Repeats line.
- **Logseq write-back:** applied (audit entries 341 and 342).

---

## Item 68 (formerly 58): each tool description's first line as a routing hint

- **Status:** spec written, awaiting your approval. Nothing is built. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#71](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/71), spec `docs/superpowers/specs/2026-11-20-tool-routing-hints-first-line-design.md` (`2f6998e`).
- **Design:**
  - `connector/src/tools/first-lines.mjs` beside `spec.mjs` holds one routing sentence for each of the 57 tools. The spec includes draft lines for all of them.
  - Generated tools use the line in place of the OpenAPI summary, and hand-written tools wrap their description with it.
  - The manifest records each line, and a tools/list test fails for a missing or over-long line.
  - The budget is 100 characters. That is an assumption, not a measured limit.
  - Cost: about +4.1 KB per tools/list, with no D1 or AI cost.
- **Your calls (spec section 11):**
  - the budget
  - whether claude.ai attached the server instructions to a tool result, and on which surface
  - `search_graph` naming `semantic_search` when semantic search is off
  - whether to drop the OpenAPI summary or keep it as the second paragraph
  - the wording of the draft lines
  - the file name
- **To build:** rerun `lane-feature` with `args.spec`.
- **Logseq write-back:** pr-url and a spec note (audit entries 358 and 359). Status was left as it is.

---

## Item 49: a query fence or query field makes a real Query block

- **Status:** spec written, awaiting your approval. Nothing is built. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#72](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/72), spec `docs/superpowers/specs/2026-11-20-query-fence-makes-query-block-design.md` (`c7bb092`).
- **Design:**
  - Use the app's own Query block shape: the Query tag, plus `logseq.property/query` holding a code value entity with lang clojure. Patch 0034 already writes this shape for the Claude Activity page.
  - A new `check-query-block` reuses `datalog_query`'s static checks. Only `:query`, `:inputs`, `:title` and a few booleans are allowed. `:rules`, `:result-transform` and `:view` are refused.
  - An advanced-query fence, or a new `query` field on an insert node, makes the block. Simple (DSL) queries stay as text. E2EE graphs refuse it.
  - This is patch 0050, which clashes with item 50's number if both are built.
- **Your calls (spec section 11):**
  - runtime cost in the app, or a server check-run
  - whether Private blocks may show in the query's results in your app
  - simple queries out of scope
  - how far the `update_block` guard reaches over your own Query blocks
  - the caption title
  - refusing the Query tag on property writes
  - the file name
- **Logseq write-back:** pr-url and a spec note (audit entries 362 and 363).

---

## Item 50: change feed, schema export and deeper health checks

- **Status:** spec written, awaiting your approval. Nothing is built. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#73](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/73), spec `docs/superpowers/specs/2026-11-20-changes-schema-health-checks-design.md` (`f3d5413`).
- **Design:** three read-only Durable Object routes, one patch each. They are numbered from 0051 on the assumption that item 49 takes 0050.
  - 0051 adds `broken-refs` and `missing-tag-properties` to `get_graph_health`. "Choice from another property" is already covered by `mismatched-choice-values`.
  - 0052 adds `list_changes_since`: an index range on `:block/updated-at`, grouped by page, refused above 20,000 changes.
  - 0053 is optional and adds `get_graph_schema`.
  - None of them reads D1. Durable Object CPU is estimated, and a bench during the build replaces the estimate.
- **Your calls (spec section 11):**
  - split out the schema export
  - how noisy `missing-tag-properties` will be (add a filter or a "required" marker?)
  - whether moves need naming per block
  - Private and Recycle-bin content in the old checks
  - `since` in milliseconds or as an ISO date
  - the patch numbers
  - the file name
- **Logseq write-back:** pr-url and a spec note (audit entries 364 and 365).

---

## Item 52: a client param for open-tasks-by-client

- **Status:** spec written, awaiting your approval. Nothing is built. Draft PR [C0ntr0lledCha0s/logseq-cloudflare-selfhost#74](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/74), spec `docs/superpowers/specs/2026-11-20-open-tasks-client-param-design.md` (`30d61ff`).
- **Design:**
  - An optional `client` param (title or UUID), resolved before anything runs. An unknown, ambiguous, private or recycled client is refused and never widened to all clients.
  - With a client, the query walks from that client's referrers, so the same bounds hold where the full listing would refuse.
  - It is patch 0054 if items 49 and 50 merge first.
- **Your calls (spec section 11):**
  - whether `forClient` is a node property (text clients are refused)
  - shared page and tag titles are refused rather than preferring the page
  - whether a task inherits its client from a parent block
  - case-only matches
  - the patch number
- **Logseq write-back:** pr-url and a spec note (audit entries 366 and 367).
