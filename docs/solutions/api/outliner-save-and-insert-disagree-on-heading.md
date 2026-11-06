---
title: The outliner's save strips a heading prefix and the insert keeps it, so a server write must convert the prefix itself
area: api
tags: [heading, markdown-prefix, save-block, insert-blocks, clear-markdown-heading, display-type, two-write-paths, update_block, patch-0022]
seen:
  - 2026-11-06 – item 32 (update_block dropped a leading "## "), patch 0022
promoted_to: []
---

## Symptom

`update_block` with the title `## Section` stored `Section` and no heading. `insert_block_tree` with the same title kept `## Section` as plain text. A later write of `logseq.property/heading` returned "updated" but `get_block` could not show it.

## Cause

The two paths call different outliner functions. `save-block!` reaches `-save`, which runs `common-util/clear-markdown-heading` (`^#+\s+`, any number of hashes) on every title that has no display type, and sets no property. `insert-blocks!` never reaches `-save`, so the prefix stays. Upstream expects the caller to convert first: the app's `wrap-parse-block` and the graph-parser exporter strip a 1 to 6 `#` prefix and set `:logseq.property/heading`. The semantic handler did neither, so the level was lost on update and left as text on insert. A literal `## X` title still renders as a heading in the app (`:block.temp/heading`), which is why inserted blocks looked right. Two further traps:

- `get_block`, `get_blocks` and `get_page_outline` did not show the heading property, so even a correct write could not be verified through the API (the same shape as `read-hid-built-in-properties`).
- The first version of the fix ran the heading step on every title. Code, math and quote blocks (a display type) hold text where `# comment` is a comment, and the outliner's own `-save` skips them. Review found the fix stripped those lines and set a heading on them.

## Fix

Patch 0022. `prepare-block-title!` takes the block being written. Unless the block has a display type, it reads `^(#{1,6})\s+`, strips it and returns `:logseq.property/heading` with the title attributes, so `update_block`, every insert tool, `capture_to_today`, `create_task` and `refresh_refs` store the app's form. A title with no prefix keeps the existing heading. Seven or more `#`, or `#` with nothing after it, is not a heading, and its first `#` is stored escaped so `-save` cannot strip it. The reads show the level (`get_page_outline` as the `## ` prefix).

## How to catch it next time

- When two write tools do the same job through different outliner calls (`save-block!` against `insert-blocks!`), list what each call normalises (`-save` rewrites titles, `insert-blocks!` doesn't) and test both with the same input, asserting the stored entity.
- When a fix mirrors a rule the upstream app applies, find the guard the upstream applies with it (here the display-type check) and copy that too. Test a code, math or quote block with a `# ` line.
- Test the whole class: levels 1 to 6, a tab separator, leading whitespace, 7 hashes, `##Nospace`, `Plain ## mid` and `#tag word`.
- A stored value must read back through the public read tools, or the next bug report cannot be checked.
