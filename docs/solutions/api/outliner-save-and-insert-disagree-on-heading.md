---
title: The outliner's save strips a heading prefix and the insert keeps it, so a server write must convert the prefix itself
area: api
tags: [heading, page-title, tag-title, block-kind, name-not-block-text, markdown-prefix, save-block, insert-blocks, clear-markdown-heading, display-type, two-write-paths, update_block, patch-0024]
seen:
  - 2026-11-06 – item 32 (update_block dropped a leading "## "), patch 0024
  - 2026-11-08 – item 31, patch 0037: the display-type exemption covered only the heading step; `escape-unresolved-inline-tags` still turned `#include` into `\#include` on update_block of a code block, and tree inserts ran the title steps before the node's display type existed. Every title-rewriting step needs the exemption, and the type must be known before the title is prepared
  - 2026-11-20 – item 35, patch 0049: the exemption keyed only on display type, so `update_block` on a page, tag or property (final display type nil) still stripped `# ` and set `logseq.property/heading` on the page entity. The fence step in the same handler was already limited to `block-kind "block"`; the heading step was not. `update_page` and `update_tag` called `save-block!` with the raw title, so `-save` dropped the prefix silently (or the page-title validator answered 500)
promoted_to: ["REVIEW.md"]
---

## Symptom

`update_block` with the title `## Section` stored `Section` and no heading. `insert_block_tree` with the same title kept `## Section` as plain text. A later write of `logseq.property/heading` returned "updated" but `get_block` could not show it.

## Cause

The two paths call different outliner functions. `save-block!` reaches `-save`, which runs `common-util/clear-markdown-heading` (`^#+\s+`, any number of hashes) on every title that has no display type, and sets no property. `insert-blocks!` never reaches `-save`, so the prefix stays. Upstream expects the caller to convert first: the app's `wrap-parse-block` and the graph-parser exporter strip a 1 to 6 `#` prefix and set `:logseq.property/heading`. The semantic handler did neither, so the level was lost on update and left as text on insert. A literal `## X` title still renders as a heading in the app (`:block.temp/heading`), which is why inserted blocks looked right. Two further traps:

- `get_block`, `get_blocks` and `get_page_outline` did not show the heading property, so even a correct write could not be verified through the API (the same shape as `read-hid-built-in-properties`).
- The first version of the fix ran the heading step on every title. Code, math and quote blocks (a display type) hold text where `# comment` is a comment, and the outliner's own `-save` skips them. Review found the fix stripped those lines and set a heading on them.

## Fix

Patch 0024. `prepare-block-title!` takes the block being written. Unless the block has a display type, it reads `^(#{1,6})\s+`, strips it and returns `:logseq.property/heading` with the title attributes, so `update_block`, every insert tool, `capture_to_today`, `create_task` and `refresh_refs` store the app's form. A title with no prefix keeps the existing heading. Seven or more `#`, or `#` with nothing after it, is not a heading, and its first `#` is stored escaped so `-save` cannot strip it. The reads show the level (`get_page_outline` as the `## ` prefix).

## How to catch it next time

- When two write tools do the same job through different outliner calls (`save-block!` against `insert-blocks!`), list what each call normalises (`-save` rewrites titles, `insert-blocks!` doesn't) and test both with the same input, asserting the stored entity.
- When a fix mirrors a rule the upstream app applies, find the guard the upstream applies with it (here the display-type check) and copy that too. Test a code, math or quote block with a `# ` line.
- Test the whole class: levels 1 to 6, a tab separator, leading whitespace, 7 hashes, `##Nospace`, `Plain ## mid` and `#tag word`.
- A stored value must read back through the public read tools, or the next bug report cannot be checked.

## Pages, tags and properties (patch 0049)

A page, tag or property title is a name, not block text, and the outliner refuses `#` in a page name (`validate-page-title-characters`; `create_page` already answers 400). So "store as sent" is not available for these: patch 0049 adds `name-heading-refusal`, and `update_block` (kind page, tag or property), `update_page` and `update_tag` answer 400 for a title that starts with `#` to `######` plus whitespace, naming `#` and the title, with nothing written. Without it the same input gave three outcomes by route: heading property on the page, prefix dropped silently, or 500. To remove a heading, delete `logseq.property/heading` with `delete_block_property`; a title with no prefix keeps it.

- A title step in a shared handler needs two guards: the display type (verbatim blocks) and `block-kind` (names). When you add or find one, check both, and check each sibling route that writes the same field (`update_block`, `update_page`, `update_tag`, `create_*`, `promote_page_to_tag`).
- A refusal rule must read the prefix the way the converter does (`markdown-heading`, with tab and leading whitespace), or a form slips past it to `-save`.
- Test the write route with a page, a tag and a property, and read the entity back with `get_page` as well as from datoms.
