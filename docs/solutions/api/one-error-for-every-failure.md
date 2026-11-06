---
title: One generic error for many causes makes a malformed call look like a server bug
area: api
tags: [errors, batch, validation, error-messages, does-not-reproduce]
seen:
  - 2026-11-04 – item 7, patch 0005, PR #15
promoted_to: ["CLAUDE.md Conventions", "REVIEW.md"]
---

## Symptom

`batch_set_block_property` returned `invalid batch property entry` for a single valid entry, while the same entry worked through `set_block_property`. Later it didn't reproduce.

## Cause

The handler returned the same message when `entries` was missing or not an array (for example, sent as a JSON string), when a block or property didn't resolve, and when a value didn't resolve. A malformed body looked like every entry being rejected.

## Fix

Patch 0005 gives a missing or non-array `entries` its own error, and each entry error names the index and reason (`entry 0: block not found`).

## How to catch it next time

- Review new error paths for distinct, specific messages.
- An investigation that can't reproduce a bug lists every input that produces the reported message before it closes the bug.
