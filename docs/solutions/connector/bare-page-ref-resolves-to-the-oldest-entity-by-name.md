---
title: A bare [[Title]] resolves to the oldest entity with that name, so write [[uuid]] for a page you verified
area: connector
tags: [links, resolve-page-ref, uuid, title, tag, journal, suggest_links, verify]
seen:
  - 2026-11-08 – item 22 (suggest_links), review round 2 (r2-integrity-1)
promoted_to: []
---

## Symptom

`suggest_links` named a page by title and UUID, and its `verify` step confirmed that page exists. The suggested `[[Title]]` could still link to a different entity when a tag, property or journal shared the page's name (the app allows a page and a tag to share one).

## Cause

On write the server resolves a bare `[[Title]]` with `resolve-page-ref!`, which takes the oldest entity with that `:block/name`. The older tag won. What the tool checked and what the write did used different selectors.

## Fix

Links are emitted as `[[<page uuid>]]`, the form the server stores, for titles and aliases alike. Logseq displays it as the page title. The draft's own `[[<uuid>]]` links count as already linked. A renamed page keeps its UUID, which also closed the stale-title risk.

## How to catch it next time

Any tool that proposes text for a later write should emit the same selector it verified (a UUID), not a name the server will resolve afresh. Test with a decoy tag older than the page that shares its name. See also `connector/audit-pre-read-must-mirror-the-write.md`.
