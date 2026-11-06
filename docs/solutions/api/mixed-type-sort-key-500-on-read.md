---
title: A sort key that mixes types makes a valid stored value unreadable (HTTP 500), and the same pass found bare integers read as db ids
area: api
tags: [read-500, sort-by, compare, block-order, node-property, many-cardinality, entity-properties-response, db-id, number-text, silent-success]
seen:
  - 2026-11-06 – item 23, patch 0022
promoted_to: []
---

## Symptom

`batch_set_block_property` appended a second page to a node (many) property such as `about` and returned `updated: 1`. Then `get_block`, `get_blocks` and `get_page_outline` on that block and its journal page all returned HTTP 500. Setting one page fixed the reads; setting both broke them again. Each page read fine alone, and a text link to either was fine.

## Cause

`entity-properties-response` (patch 0002) sorted a many-valued property with `(sort-by #(or (:block/order %) (:db/id %)) v)`. The key is a string for entities that have `:block/order` (blocks, property entities, pages under Library or a namespace parent) and a number for those that don't (plain and journal pages). cljs `compare` throws `Cannot compare a0 to 204` on that mix. Single values never reach the comparator and same-kind pairs compare fine, which is why it looked like it depended on the pair. The write and stored data were valid; only the response builder failed, and one bad block 500ed a whole outline or bulk read.

Related finds in the same lane:
- A default-type property given a page UUID reached the outliner's validator and came back as a 500 "Schema validation failed", not a refusal naming the entry.
- A number property given a JSON integer read it as a db id (`resolve-ref-entity`: `(number? value) (d/entity db value)`), silently storing another block's value block. Patch 0022 added `number-text` for number properties only; the same bare-integer-as-db-id read is still open for node and default-type properties (a node property given `150` stored db id 150, not the page titled "150").

## Fix

Patch 0022: a total sort key (ordered values by order key, then unordered by db id), refusal up front by type with entry and property named, and `number-text` for number properties. The bare-integer case for node and text properties and the `isFinite` guard test were open at the end of the lane.

## How to catch it next time

- Any `sort-by`, `compare` or `max` over entities needs a key of one type. Grep for `(or (:block/order` and similar fallbacks, and test a list that mixes every kind (plain page, journal, Library or namespace page, block, property entity).
- A "write OK, read 500" report is a read-path bug first: reproduce through the real handler with the owner's exact sequence and read the stack.
- A new read-side builder needs a case per value kind, and should fail soft per value rather than 500 the block.
- Never let a bare JSON number reach a db-id lookup for API input; resolve it as text or a title, or refuse it.
