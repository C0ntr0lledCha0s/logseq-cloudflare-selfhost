# Overnight backlog burn-down: report

This run follows `docs/superpowers/plans/2026-11-19-backlog-burn-down.md`. The branches are stacked, each cut from the one before it, and every PR is a draft against main. Nothing was merged or deployed. At the owner's request (2026-11-19, evening), the issue tasks in Logseq are updated as each lane finishes: Status, phase, branch and pr-url, plus a dated Built note. The write-backs below were applied for items 67, 38, 43 and 33 (audit entries 293 and 294); later items say whether theirs was applied.

## Summary

| Item | Status | Branch | PR | HEAD |
|---|---|---|---|---|
| 67 (formerly 27): edit-stamp precheck | ready | `fix/edit-stamp-orphaned-choice` | [#59](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59) | `0b7b2a4` |
| 38: removing one tag returns 500 | ready (two passes) | `fix/tags-reset-keeps-builtins` | [#60](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60) | `4abb221` |
| 43: Page as a tags value answers 500 | ready | `fix/page-tag-value-refused` | [#61](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/61) | `df57c67` |
| 33: JSON number read as a db id | ready | `fix/json-number-not-db-id` | [#62](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/62) | `6a629b8` |
| 45: batch class check uses stale classes | running | `fix/batch-class-check-final-state` | – | – |

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
