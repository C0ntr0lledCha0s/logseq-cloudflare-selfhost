---
title: A wrangler `[vars]` entry is printed in the public deploy log, so owner-private values must be secrets
area: deploy
tags: [wrangler, vars, secrets, deploy-log, render-wrangler, secrets-file, privacy, HEALTH_TAG_PROPERTIES]
seen:
  - 2026-11-23 – item 50 (change feed, schema export, health checks), review round 2 (r2-tests-3, r2-correctness-1, r2-light-1)
promoted_to: []
---

## Symptom

The plan stored the owner's expected tag-property pairs (`HEALTH_TAG_PROPERTIES`) as a plain Worker variable, rendered from `config/settings.json` by `render-wrangler.mjs`. Tests and the stage checks were green. Review round 2 found the problem in the CI log, not in any test.

## Cause

`wrangler deploy` prints each variable's name and the start of its value (the first 37 characters) in its binding list. This repo's deploy runs in public GitHub Actions, so the owner's tag and property names would sit in the run log. A secret is listed as `(hidden)`. Nothing in the unit tests looks at deploy output, so a variable and a secret were indistinguishable to them.

## Fix

`render-wrangler.mjs` takes the pairs from the `HEALTH_TAG_PROPERTIES` GitHub secret (else `health.expectedTagProperties` in `config/settings.json`, committed as `[]`) and writes them to a `--secrets-out` file. `deploy.sh` merges that into the secrets file passed to `wrangler deploy --secrets-file`. The value is always sent (`[]` for none), so a deploy replaces what the Worker held. `deploy.test.mjs` runs the real `deploy.sh` with the variable in its environment and checks the secrets file, the rendered toml and the log, so dropping the CLI's `process.env` read fails a test.

## How to catch it next time

- Before a value goes into `[vars]`, ask whether the owner would mind it in a public log: graph content names (tags, properties, titles), alias names, account details. If so, it is a secret.
- Test the deploy path with the real `deploy.sh`, and assert the rendered toml has no `[vars]` line for the value and the log never prints it.
- Settings in `config/settings.json` are committed, so they can hold only non-secret switches. A list of the owner's own names belongs in a secret with a committed empty default.
