---
title: Server-side writes must seed the max order key the way clients do on load
area: sync
tags: [order-key, fractional-index, server-write, value-block, reorder]
seen:
  - 2026-11-04 – item 8, patch 0008, PR #19
promoted_to: ["CLAUDE.md Gotchas", "REVIEW.md"]
---

## Symptom

Setting Description on a page gave its value block the order key `a1V`, which section 1 already held. A client then moved section 1 below section 6.

## Cause

Clients seed the process-wide max order key when they load a graph. The Worker never did, so blocks it created (text and URL property values, and new pages written through the API) could get a key that already existed.

## Fix

Patch 0008 seeds the max order key before server writes. A live re-check gave the new value block `c0Ry`, above every existing key.

## How to catch it next time

Any new server-side path that creates blocks needs a test asserting the new block's order key is unique and greater than the existing ones, and a live check on a page that already has many blocks.
