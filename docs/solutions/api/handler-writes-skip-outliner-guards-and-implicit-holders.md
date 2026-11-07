---
title: Raw transacts skip the outliner's guards, and delete-blocks! or holder counts miss implicit holders
area: api
tags: [built-in, raw-transact, delete-blocks, default-value, placeholder, destructive, retire]
seen:
  - 2026-11-06 – item 26, patch 0026, review rounds 1 and 2 (r1-correctness, r2-correctness-1, r2-integrity-1)
  - 2026-11-07 – item 17, patch 0028, review round 3 (r3-correctness-1): delete summaries counted a block's hidden property value blocks as children ("+1 child" on a leaf holding Owner: Ann), because ldb/get-block-full-children-ids includes them
promoted_to: ["REVIEW.md"]
---

## Symptom

Four ways one feature misbehaved, each found by review and not by the stage tests:
- `classes` on Assignee (a built-in property) could be replaced or cleared.
- Retiring the choice that was the property's default value counted 0 holders, passed without a 409 and cleared the default.
- `convert_values` answered 500 over a committed conversion, because deleting an old text value block also deleted the blocks under it, and a lone value of a property with a default is kept instead of deleted.
- `out_of_class` counted holders whose value was Logseq's empty placeholder.

## Cause

The handler wrote classes with a raw `transact`, so the outliner's built-in check never ran. Holder counts came from `:avet` over the property, which does not see a default value stored on the property itself. `delete-blocks!` has side effects beyond the named block (children, the lone-default exception), and the empty placeholder looks like a value in a scan.

## Fix

Refuse `classes` on built-in properties up front (set, add, remove, `set: []`, by ident or UUID, dry run included). Mark a default-value choice `default: true`, so it needs `acknowledge-holders`. Refuse a value block with children or a property with a default in `convert_values`. Skip empty placeholders in counts.

## How to catch it next time

- Any new write that bypasses the outliner (raw transact) needs its own built-in and ownership checks, tested on a built-in property.
- For a destructive call, list every place a reference can live (holder datoms, the default value, placeholders, child blocks) and give each a test.
- After the write, read back through the real read path, and give the read-back a tamper test that makes it answer 500.

## Also: counts shown to the owner

`ldb/get-block-full-children-ids` includes the hidden value blocks of text, URL and number properties. A count the owner reads ("2 children") must walk `:block/parent` and skip blocks created from a property (patch 0028, `child-block-count`). Keep the full set for what is actually removed and for the read-back.
