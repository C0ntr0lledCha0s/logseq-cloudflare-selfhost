---
title: A scheduled job that force-pushes a branch people also push to wipes their fixes; force only over the bot's own commits
area: deploy
tags: [github-actions, bump-upstream, force-push, bump-branch, patches, workflow]
seen:
  - 2026-11-24 – LC-133 (PR 81's patch refresh replaced by the delayed Monday bump run on 2026-11-23)
promoted_to: []
---

## Symptom

A patch refresh pushed to the open bump PR's branch vanished. The PR showed one bare `chore: bump upstream` commit and CI went red again, so the refresh had to be pushed a second time.

## Cause

`bump-upstream.yml` rebuilt the bump branch from `main` (`git checkout -B`) and pushed it with `--force` on every run. The branch is also where a person or agent fixes the patches when upstream breaks them, so any run after the fix (the weekly cron, a delayed cron or a manual run) discarded it.

## Fix

`scripts/bump-branch.sh` lists the commits in `main..branch`. Only when each one has github-actions[bot] as both author and committer does it rebuild and force-push. Otherwise it keeps the branch, merges `main` in when it has moved on (no rebase), adds the new `UPSTREAM_REF` in a bot commit and pushes without force. On a merge conflict or a refused push it leaves the branch alone. Both non-force paths post a PR comment and a step summary. `scripts/bump-branch.test.mjs` runs the script against temporary git repositories, with origin set to refuse non-fast-forward pushes on the keep path.

## How to catch it next time

For any workflow that pushes, ask who else writes to that ref. A `--force` push needs a test that a commit someone else made survives a run.
