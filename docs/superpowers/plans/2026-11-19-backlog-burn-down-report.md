# Overnight backlog burn-down: report

This run follows `docs/superpowers/plans/2026-11-19-backlog-burn-down.md`. The branches are stacked, each cut from the one before it, and every PR is a draft against main. Nothing was merged or deployed, and nothing was written to the owner's graph. Each item ends with a Logseq write-back in draft, ready for the owner to apply.

## Summary

| Item | Status | Branch | PR | HEAD |
|---|---|---|---|---|
| 67 (formerly 27): edit-stamp precheck | ready | `fix/edit-stamp-orphaned-choice` | [#59](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59) | `0b7b2a4` |
| 38: removing one tag returns 500 | ready (two passes) | `fix/tags-reset-keeps-builtins` | [#60](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60) | `4abb221` |
| 43: Page as a tags value answers 500 | running | `fix/page-tag-value-refused` | – | – |

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

**Logseq write-back (draft, not applied).** These go on the item's task block:

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

**Logseq write-back (draft, not applied):**

1. `batch_set_block_property` on the task: Status In Review, phase `review`, branch `fix/tags-reset-keeps-builtins`, pr-url `https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/60`.
2. A child note:

```
- **Built 2026-11-19** – PR 60 (patch 0042). The Tags reset 500 was fixed by patch 0027 (deployed 2026-11-07). Deleting Tags on a page or journal now keeps Page/Journal and answers 200; delete_block_property and its batch form take an optional `value` that removes one value of a many-valued property; bad entries answer 400 naming the entry.
  - Verified on 4abb221 (scripts/check.sh --upstream green; tofu fmt skipped). Not yet checked live (service token is write-no-delete).
  - Open: r2-integrity-1 (value delete can remove a built-in class property from a built-in tag).
```
