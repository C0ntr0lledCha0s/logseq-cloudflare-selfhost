---
title: When a write seems to drop a value, check the read path before the write
area: api
tags: [read-path, built-in-properties, status, false-bug, investigation]
seen:
  - 2026-11-06 – item 19, patch 0017, PR #33 (Status "dropped" on insert)
promoted_to: ["CLAUDE.md Gotchas", "REVIEW.md", ".claude/agents/investigator.md method"]
---

## Symptom

A task inserted with Tags and Status seemed to have the Tags but no Status, and no error was returned.

## Cause

The insert stored Status all along. `get_block` and `get_page` left out every built-in `logseq.*` property, so a Done task read as having no properties.

## Fix

Patch 0017 returns the built-ins Logseq marks public (Status, Priority and Deadline among them). A live test inserted Task plus Status four ways, and all four stored the value.

## How to catch it next time

An investigation confirms the stored state with a second, independent read (the outline, a different tool or a direct db query) before it concludes the write is wrong.
