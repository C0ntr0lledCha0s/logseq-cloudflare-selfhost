---
title: A sort key that mixes types makes a valid stored value unreadable (HTTP 500), and the same pass found bare integers read as db ids
area: api
tags: [json-number, text-property, read-500, sort-by, compare, block-order, node-property, many-cardinality, entity-properties-response, db-id, number-text, silent-success]
seen:
  - 2026-11-06 – item 23, patch 0022
  - 2026-11-19 – item 33, patch 0044 (the open bare-integer half, closed)
promoted_to: ["REVIEW.md"]
---

## Symptom

`batch_set_block_property` appended a second page to a node (many) property such as `about` and returned `updated: 1`. Then `get_block`, `get_blocks` and `get_page_outline` on that block and its journal page all returned HTTP 500. Setting one page fixed the reads; setting both broke them again. Each page read fine alone, and a text link to either was fine.

## Cause

`entity-properties-response` (patch 0002) sorted a many-valued property with `(sort-by #(or (:block/order %) (:db/id %)) v)`. The key is a string for entities that have `:block/order` (blocks, property entities, pages under Library or a namespace parent) and a number for those that don't (plain and journal pages). cljs `compare` throws `Cannot compare a0 to 204` on that mix. Single values never reach the comparator and same-kind pairs compare fine, which is why it looked like it depended on the pair. The write and stored data were valid; only the response builder failed, and one bad block 500ed a whole outline or bulk read.

Related finds in the same lane:
- A default-type property given a page UUID reached the outliner's validator and came back as a 500 "Schema validation failed", not a refusal naming the entry.
- A number property given a JSON integer read it as a db id (`resolve-ref-entity`: `(number? value) (d/entity db value)`), silently storing another block's value block. Patch 0022 added `number-text` for number properties only; the same bare-integer-as-db-id read stayed open for node and default-type properties (a node property given `150` stored db id 150, not the page titled "150") until patch 0044.

## Fix

Patch 0022: a total sort key (ordered values by order key, then unordered by db id), refusal up front by type with entry and property named, and `number-text` for number properties. The bare-integer case for node and text properties was open at the end of the lane.

Patch 0044 closed it. `resolve-ref-entity` turns a number into its text and looks it up as a title (scoped as a string title is), a text property stores it as text, and a number that matches nothing is refused up front, naming the entry and asking for a UUID. It covers set, batch set, insert tree and batch insert trees. The `isFinite` guard is unreachable over HTTP, since JSON can't carry a non-finite number, so it has no test (a mutation check removing it left the suite green again, see `testing/untested-rules-survive-mutation.md`).

Known gaps left open by patch 0044 (review backlog and deferred, not fixed):
- A `[[N]]` in a block title still resolves to the entity with db id N. Same class, different lookup site (r1-correctness-2).
- A text property given a JSON integer above 2^53, or a number of 1e21 or more, stores `(str n)` of the already-rounded double, so the text differs from what the caller sent. JSON parsing loses the digits before the handler sees them; refuse or require a string for those.
- Earlier patches' tests (0027, 0031) sent a db id as a supported value form and expected it accepted. Fixing the resolver meant rewriting those tests, so grep older tests for `:db-id` forms when closing a lookup rule.

## How to catch it next time

- Any `sort-by`, `compare` or `max` over entities needs a key of one type. Grep for `(or (:block/order` and similar fallbacks, and test a list that mixes every kind (plain page, journal, Library or namespace page, block, property entity).
- A "write OK, read 500" report is a read-path bug first: reproduce through the real handler with the owner's exact sequence and read the stack.
- A new read-side builder needs a case per value kind, and should fail soft per value rather than 500 the block.
- Never let a bare JSON number reach a db-id lookup for API input; resolve it as text or a title, or refuse it. When you close a lookup form, grep every other site that takes a user string or number into an entity (title refs, tags, class checks) and older tests that rely on the old form.
