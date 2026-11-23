---
title: A test that skips depending on which build ran last can leave the gate green while the test is broken
area: testing
tags: [skip, release-bundle, bench, build.sh, gate, stale-bundle, scripts-test]
seen:
  - 2026-11-17 – item 40, patch 0039, stage 2 (s-2-1, s-2-2)
  - 2026-11-22 – blank-blocks-sync-status, stage 1 (s-stage-1-2)
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

At the end of stage 2 the builder reported the scripts unit tests red (309 of 310) and `scripts/check.sh --upstream` red. `bench-datalog-query.test.mjs` expected rows from the rule-deep-chain shape and got a scan-cap 422. Earlier gates had been green because that test skips when `build.sh` ran last, so it had not executed. The same stage checked the release bundle by timestamp (built 02:31, last source change 02:18) instead of rebuilding, and the commit was left unpushed.

## Cause

Some checks depend on build artefacts in the working tree (the dev build versus the release bundle). A test that skips when the wrong artefact is present passes by not running, and which artefact is present depends on the last command anyone ran. "Bundle is newer than the sources" is also weak evidence: a patch regenerated after a stash can differ from what was built.

## Fix

The stage's shapes were updated and the gate re-run; the stage was not reported done until both checks ran on the committed HEAD (closed in review round 2).

It recurred on 2026-11-22: after `scripts/build.sh`, `scripts/check.sh --upstream` ran the scripts tests first, while `worker-test.js` was missing, and nine bench and release-bundle tests skipped. The upstream suite then rebuilt the file, too late. `check.sh` now runs the upstream suite and the release bundle query before the scripts tests when `--upstream` is set (`scripts/check.test.mjs` pins the order).

## How to catch it next time

- When a stage changes what a bench or release check exercises, run both build modes in turn and read the output for "skipped". A skip is not a pass; `scripts/check.sh` already names skipped checks, so repeat them in the stage report.
- Rebuild with `scripts/build.sh` on the committed HEAD before quoting a release-bundle result, and quote the SHA. Do not infer freshness from file times.
- A stage is done when the gate is green on a pushed HEAD, not before.
