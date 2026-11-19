---
title: An optional argument that narrows a delete must refuse when it cannot be applied, never fall back to the wider delete
area: api
tags: [delete, destructive, value, narrowing, whole-property-delete, uuid, malformed-json, batch, connector]
seen:
  - 2026-11-19 – item 38, patch 0042, review round 1 (r1-tests-1, r1-tests-2, r1-light-1)
promoted_to: []
---

## Symptom

Item 38 added an optional `value` to the property delete routes so one value of a many-valued property can be removed. Without `value` the call deletes the whole property. Review round 1 found the first cut let several bad inputs through as a whole-property delete answering 200: a misspelt or misplaced value, malformed JSON in the body (the connector parsed it, failed, and sent no value), and a UUID that matched a block whose text only read as that UUID.

## Cause

Two things made the narrow form fall back to the wide one. The absence of `value` is meaningful (delete everything), so any step that drops, fails to parse or fails to resolve `value` produces the wide delete without an error. And a UUID-looking value was matched against held values by text, so a value block whose title was that string counted as the target.

## Fix

Patch 0042 and the connector: a `value` that is present but does not resolve, is not held, or targets a property that is not cardinality many is refused with a 400 naming the entry (`entry N: ...`), at the server and in the connector. Malformed JSON is refused, not treated as no value. A UUID value matches only a held value with that UUID, or a value block of this property that points to it. Internal built-in properties such as `block/refs` are refused. Titles match exactly first, then ignoring case. A repeated value delete answers 400 (the value is no longer held), and the tool text, `connector_help` and README §11.8 say so.

## How to catch it next time

- For any optional argument that narrows a destructive call, test the argument present but wrong (misspelt, wrong property, not held, malformed body) and assert a 400 with the graph snapshot (max-tx and datom count) unchanged.
- Test the same input through the connector and the server, since either can drop the argument.
- Test a decoy whose text equals the UUID or title being matched.
