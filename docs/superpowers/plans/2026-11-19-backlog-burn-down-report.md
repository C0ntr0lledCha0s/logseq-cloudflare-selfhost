# Overnight backlog burn-down: report

This run follows `docs/superpowers/plans/2026-11-19-backlog-burn-down.md`. The branches are stacked, each cut from the one before it, and every PR is a draft against main. Nothing was merged or deployed, and nothing was written to the owner's graph. Each item ends with a Logseq write-back in draft, ready for the owner to apply.

## Summary

| Item | Status | Branch | PR | HEAD |
|---|---|---|---|---|
| 67 (formerly 27): edit-stamp precheck | ready | `fix/edit-stamp-orphaned-choice` | [#59](https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost/pull/59) | `0b7b2a4` |
| 38: removing one tag returns 500 | running | `fix/tags-reset-keeps-builtins` | – | – |

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
