# Backlog burn-down (overnight run, 2026-11-19)

This plan works through the open items on the Logseq Connector Issues page. Each item runs through its own lane while the owner is away. Nothing merges or deploys, and nothing is written to Logseq overnight.

## How it runs

- **One lane at a time.** The container has 4 CPUs and a lane already runs two agents at once, so lanes run one after another. Each lane is the saved workflow (`lane-bug`, or `lane-feature` up to its spec) and gets the item as a `brief`. The brief is the item's text from the issues page, so the lanes make no Logseq calls. This also gets round the page's duplicate item numbers: there are two items 27 and two items 58.
- **Logseq access.** The issues page was read once, up front, with the allow-listed read tools. The service token (`logseq-service`) reaches only the `test` graph, in write mode. Investigators may use it to reproduce a bug against production on `test`. The owner's graph gets no writes. Each lane's draft *Built* note and Status change goes into the morning report, for the owner to approve.
- **Branches.** Each item gets its own branch, cut from the previous item's branch (a stack), so patch numbers don't collide and the PRs merge in order. Branches are pushed. PRs are opened only if the owner asked for them, and never merged: merging to main deploys.
- **Between lanes.** After each lane, the driver checks that the tree is clean and the gate on HEAD is green, pushes, stops any warm upstream compiler, and starts the next item. A lane that ends `needs-human`, `blocked` or `blocked-security` is recorded and skipped, and the queue goes on. A later item that depends on it waits.
- **Tiers.** Intake suggests a tier, and the driver overrides it to `full` for any item that repairs, converts or deletes stored data.

## Not overnight

These need the owner, or live outside this repo:

- **58 (merge or close PRs and branches).** Merging deploys. PR 48 (the upstream bump) needs the owner's review.
- **59 (logseq-kb skill notes).** The owner's own skill, not this repo.
- **60 (lane retro proposals).** The owner decides each one.
- **61 (owner decisions and live checks).** Owner answers, and live checks after a deploy.
- **3, 4, 5, 6, 30, 41, 42.** Low-priority features and the CLI bridges. Each needs a design decision.
- **Folded and schema-library follow-ups.** Not connector work.

## Queue

Bugs come first, in priority order. A feature lane stops at its spec, so features come last and leave specs for the morning.

| # | Item | Lane, tier | Why here |
|---|---|---|---|
| 1 | 27 – edit-stamp precheck blocks all writes after an orphaned `claude` choice | bug, full (repairs schema) | High, Todo. Edit stamps are off on the owner's graph until it's fixed. |
| 2 | 38 – removing one tag answers 500 (Tags reset keeps built-ins; clear entry errors) | bug, standard | High. The "remove one value" option on `delete_block_property` is a contract change, so the lane may split it out as a feature. |
| 3 | 43 – Page as a tags value answers 500 | bug, quick | Same code path as 38, so it runs straight after. |
| 4 | 33 – a bare JSON number is read as a db id | bug, standard | High. Silent wrong data. |
| 5 | 45 – a batch's class check reads classes and extends from before the batch | bug, standard | High. Silent wrong data. |
| 6 | 36 – a Tags title takes the first class with that title | bug, standard | Medium. Same resolver family as 25. |
| 7 | 34 – a text or URL value set by another block's value UUID is shared | bug, full (stored values) | Medium. Data loss on delete. |
| 8 | 53 – one rejected sync request aborts a whole semantic indexer run | bug, standard | Medium. |
| 9 | 46 – mark `batch_insert_block_trees` destructive | bug, quick | Medium. Annotation only. |
| 10 | 44, 39, 35, 37, 47, 48, 56, 51 | bug, quick or standard | Low. Run while time remains. |
| 11 | 58 (second) – routing-hint first lines for tool descriptions | feature, to spec | Status Doing. |
| 12 | 49, 50, 52 | feature, to spec | If time remains. |

The minor bundles (62–66) aren't queued. They need sorting into separate items first, which the morning report proposes.

## Morning report

The driver writes `docs/superpowers/plans/2026-11-19-backlog-burn-down-report.md` and commits it on the session branch (`claude/cool-bardeen-4whxkv`). For each item it gives:

- the status and branch, the HEAD SHA, and what the gate skipped
- the regression tests, with their failures from before the fix
- the open and backlog findings
- the retro proposals
- the drafted Logseq write-back

## Guard rails

- No merges, deploys or `scripts/deploy*.sh`. No force-pushes.
- No writes to the owner's graph. Writes to the `test` graph go through the service token only, to reproduce bugs.
- Graph names and page UUIDs stay out of commits.
- The driver claims a check only when it saw that check pass on HEAD.
