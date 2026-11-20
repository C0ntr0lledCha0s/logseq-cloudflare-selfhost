---
title: A report can be half fixed by a later patch and half a documented design choice; check the spec, connector_help and pinned tests before treating an acceptance line as a defect
area: api
tags: [not-a-bug, stale-issue, already-fixed, design-decision, quote, code-block, math, verbatim-title, refresh-refs, display-type, owner-decision]
seen:
  - 2026-11-20 – item 37 (update_block and refresh_refs said to escape #word in code, math and quote blocks; lane found code and math fixed by patch 0037 and quote deliberate)
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

Item 37 (found 2026-11-06) said a code or math block holding an unknown `#word` such as `#include` was stored escaped by `update_block` and `refresh_refs`, and that `refresh_refs` candidates did not skip display-typed blocks. The brief's acceptance lines included "refresh_refs skips display-typed blocks (code, math and quote)".

## Cause

No defect on HEAD for code and math. Patch 0037 (design dated 2026-11-08, after the item was found) added `verbatim-title?` (`#{:code :math}`), so `prepare-block-title!` returns the title as sent. `refresh-change` prepares with the block's display type, so a code or math block yields no change and is never listed. `refresh-candidates` still has no display-type filter, which looks like the gap, but it never matters for those two types.

Quote is different on purpose. The spec says a quote "skips only the heading step and keeps tag and ref handling, because the app renders a quote's markdown", `connector_help` says the same, and `headings-0024-for-typed-blocks-test` pins the quote escape. The app's `wrap-parse-block` parses refs for every display type, so an unescaped `#word` in a quote becomes a tag at its next edit in Logseq. The acceptance line "refresh_refs skips quote" would reverse that decision, so it is the owner's call, not a bug fix.

Legacy data is a third layer: titles escaped before 0037 keep their `\#`, and `refresh_refs` never unescapes them (a verbatim prepare equals the stored title).

## Fix

None. The lane closed the code and math lines as already met by 0037 and left the quote question and the legacy escapes to the owner. If the owner wants verbatim quotes, add `:quote` to `verbatim-title?` (or a refresh-only skip), update `connector_help`, the 0037 spec note, README §11.8 and the pinned test, and accept the stray tag at the quote's next app edit.

## How to catch it next time

- When an item's date precedes a patch that touches the same tool, read that patch's spec before the handler. Compare the date with the spec's date.
- Split a multi-part acceptance list by type or case and probe each part through `handle-http` (here code, math and quote gave three different answers).
- Before treating a "should skip X" line as a defect, grep the spec, `connector_help` and the tests for a sentence that says X is handled on purpose. A pinned test that asserts the current behaviour means a decision, not a bug.
- Report the decision as a question for the owner with its trade-off, and do not write a patch for it unattended.
- Same family as [a 500 that predates its fix deploy](a-500-that-does-not-reproduce-on-head-may-predate-its-fix-deploy.md), [a count misread from the summary line](a-count-that-reads-wrong-may-be-the-summary-line-not-the-handler.md) and [server writes skip the client pipeline](server-writes-skip-client-pipeline-display-type-tag.md).
