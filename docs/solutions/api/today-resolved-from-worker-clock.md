---
title: "Today" must come from an explicit owner time zone, because Workers run in UTC and the process clock is the wrong one
area: api
tags: [time-zone, timezone, today, journal, journal-day, js-date, intl, utc, workers, capture-to-today, create-task, assets, clock]
seen:
  - 2026-11-06 – item 24, patch 0025 (create_task at 10:00 NZDT wrote to the previous day's journal)
promoted_to: []
---

## Symptom

`create_task` with no `page-id`, called at about 10am NZDT on 6 Nov, wrote to the "Nov 5th, 2026" journal. `capture_to_today` and an asset upload with no page did the same. It happened every day from 00:00 to about 13:00 NZ time. The write was correct for the day it computed, and the stored `:block/page :block/journal-day` was 20261105, so the read was not hiding anything.

## Cause

- Upstream's `today-journal-day` in `deps/db-sync/.../handler/semantic.cljs` built the day from `(js/Date.)` with `getFullYear`, `getMonth` and `getDate`. Those getters use the process zone, and a Cloudflare Worker is always UTC. Nothing in the server, connector, wrangler config, infra or `config/settings.json` named the owner's zone.
- One function, `ensure-today-page!`, served three paths (capture, task create with no page, asset upload with no page), so every default-to-today path shared the bug.
- The brief blamed patch 0012. It only carries the function as context lines; the code is upstream's. Check `git show HEAD:` in `.upstream` before assigning a layer.
- Neither response named the journal it wrote to, so the wrong day was only visible by opening the graph.

## Fix

Patch 0025 works out the date with `Intl.DateTimeFormat` in the zone from the sync Worker's `TIMEZONE` variable (UTC when unset or blank). An unknown zone is refused with a 500 before anything is written. `capture`, `createTask` and `createAsset` return `page-id` and `page-title`. `config/settings.json` has `timeZone` (Pacific/Auckland), which `render-wrangler` writes out as `vars.TIMEZONE`. `connector_help`, tool descriptions, the OpenAPI text and README 11.8 say which zone "today" uses.

## How to catch it next time

- Any code that reads the clock for a user-facing date (`js/Date`, `Date.now`, `new Date()` with local getters) needs an explicit zone argument. The local getters are never right on Workers.
- Test at an instant where the owner's date and the UTC date differ, in both directions, with the clock fixed in the test. Add an instant just past the owner's midnight and one in winter time (NZST) for the daylight-saving offset. Run the test under a process zone that is neither UTC nor the owner's, so it can't pass by accident. The lane's test reached its failure with `TZ=UTC` and passed with `TZ=Pacific/Auckland`, which proves only the process zone decides.
- Make the response name what was chosen (the journal title), so a wrong default is visible to the caller.
