---
title: A keyword property and its class tag are kept in step by the client pipeline, so a server write must set both and read both back
area: api
tags: [display-type, keyword-property, code-block, class-tag, client-pipeline, rtc, json-keyword, lang, patch-0037]
seen:
  - 2026-11-08 – item 31, patch 0037
promoted_to: []
---

## Symptom

Code, queries and Mermaid written by Claude landed as plain text inside ``` fences, and about 30 blocks needed converting by hand. `set_block_property` of `logseq.property.node/display-type` was refused with `should be a Clojure keyword` for both `"code"` and `":code"`, and so was `properties` on `insert_block_tree`.

## Cause

Three separate things, each hidden by the one before.

- JSON cannot carry a keyword. `display-type` is not a ref property, so `prepare-property-value` passed the string straight to the type check. The value has to be converted on the server, against the allowed set (`code`, `math`, `quote`), and refused up front otherwise.
- The app keeps the block's class tag (Code-block, Math-block, Quote-block) and `display-type` in step in `pipeline.cljs` (`add-missing-properties-to-typed-display-blocks`). The step returns early for RTC and download transactions, so a server write gets neither the tag nor the keyword's side effects. A write of only the keyword leaves search and markdown export disagreeing with the render, and switching code to quote leaves the old tag.
- Every title-rewriting step of the write must know the block is verbatim: heading prefix, `#tag` escaping, tag and link resolution. `tree-block` prepared the title with no block, before the node's properties existed, so the type had to be resolved first.

## Fix

Patch 0037 converts `display-type` and `lang` from strings on every write path, sets the matching class tag and removes the other two (as the pipeline would), retracts `lang` unless the type is code, treats a whole-block ``` or `$$` fence as the type, stores a code or math title exactly as sent, and reports both fields on reads. Writing Code, Math or Quote directly as tags is refused with a pointer to `display-type`, and `final-tags` keeps a held display class under a replacing tag list.

## How to catch it next time

- When a property is hidden or keyword-typed, find the pipeline step that keeps it consistent with other datoms (`pipeline.cljs`) and check whether it runs for server transactions. If not, the handler mirrors it.
- Assert type, tag and lang together in every test, including the switch (code to quote) and delete cases, and read them back through `get_block`.
- Test a title with `# comment`, `#include <x>` and `[[Example]]` on every route, insert and update.
- Open at the end of the lane: deleting `Tags` on a code block (`delete_block_property`, batch) removes the class tag and leaves `display-type` set (tag and type drift). Check this first if the drift is reported.
