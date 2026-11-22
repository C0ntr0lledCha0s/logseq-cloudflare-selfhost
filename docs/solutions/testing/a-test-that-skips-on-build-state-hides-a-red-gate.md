---
title: A test that skips depending on which build ran last can leave the gate green while the test is broken
area: testing
tags: [skip, release-bundle, bench, build.sh, gate, stale-bundle, scripts-test]
seen:
  - 2026-11-17 – item 40, patch 0039, stage 2 (s-2-1, s-2-2)
  - 2026-11-22 – item 49, patch 0050, stage 4 (s-4-2): `scripts/build.sh` then `scripts/check.sh --upstream` exited 0 with a WARNING naming 9 skipped tests (7 bench, 2 release-bundle), because build.sh had deleted `worker/dist/worker-test.js`. The builder's 389 passed, 0 skipped came from a separate rebuild, not from the gate
promoted_to: ["CLAUDE.md Gotchas"]
---

## Symptom

At the end of stage 2 the builder reported the scripts unit tests red (309 of 310) and `scripts/check.sh --upstream` red. `bench-datalog-query.test.mjs` expected rows from the rule-deep-chain shape and got a scan-cap 422. Earlier gates had been green because that test skips when `build.sh` ran last, so it had not executed. The same stage checked the release bundle by timestamp (built 02:31, last source change 02:18) instead of rebuilding, and the commit was left unpushed.

## Cause

Some checks depend on build artefacts in the working tree (the dev build versus the release bundle). A test that skips when the wrong artefact is present passes by not running, and which artefact is present depends on the last command anyone ran. "Bundle is newer than the sources" is also weak evidence: a patch regenerated after a stash can differ from what was built.

## Fix

The stage's shapes were updated and the gate re-run; the stage was not reported done until both checks ran on the committed HEAD (closed in review round 2).

## How to catch it next time

- When a stage changes what a bench or release check exercises, run both build modes in turn and read the output for "skipped". A skip is not a pass; `scripts/check.sh` already names skipped checks, so repeat them in the stage report.
- Rebuild with `scripts/build.sh` on the committed HEAD before quoting a release-bundle result, and quote the SHA. Do not infer freshness from file times.
- A stage is done when the gate is green on a pushed HEAD, not before.

- Second sighting (item 49): the gate's exit code stays 0 with skips. A stage quotes the gate only when its output has no WARNING line, with the SHA. After `build.sh`, run `scripts/upstream-test.sh .upstream <regex>` to rebuild `worker-test.js` before the gate.
