# Solutions: what past work taught us

This is where the compound loop writes. Every lane reads it at intake, before investigating or designing, and the compound stage adds to it when a lane finishes. The idea is that each bug or feature should make the next one cheaper.

## How it is used

- **At intake**, the lane greps this folder for the area and symptoms and passes the matching files to the investigators, designers and reviewers.
- **At the compound stage**, the compounder either writes a new entry or updates an existing one, adding to its `seen` list rather than duplicating it. It then checks the promotion rule.
- **Promotion rule.** When a lesson has been seen twice, it stops being a note and becomes a rule: a defect class in `REVIEW.md` (for something review should always check), or a line in `CLAUDE.md` → *Gotchas* (for a trap anyone changing the code would hit). The entry records where it was promoted (`promoted_to`). Changes to the lanes themselves (workflows, agents, skills) are proposed by the retro and applied only when the owner agrees.
- **Refuted review findings** that keep coming back are recorded under *Known false positives* in `REVIEW.md`, so reviewers stop spending effort on the same non-issue.

The entries below were seeded from the issues fixed before the lanes existed. Several are already promoted because the lesson had already cost more than one fix, or was serious enough to check every time.

## Layout

One file per lesson, under a folder for its area: `api/`, `sync/`, `connector/`, `semantic/`, `cost/`, `testing/`, `deploy/` and `infra/`. The filename names the lesson, not the issue number. Use `_template.md`.

## Index

| Entry | Lesson |
|---|---|
| [testing/stubbed-outliner-hid-block-placement](testing/stubbed-outliner-hid-block-placement.md) | Tests that stub the outliner or datoms can't see where blocks land |
| [sync/order-key-not-seeded-for-server-writes](sync/order-key-not-seeded-for-server-writes.md) | Server-side writes must seed the max order key the way clients do |
| [api/qualified-ident-path-params-404](api/qualified-ident-path-params-404.md) | Decoded path params must be re-encoded when forwarded |
| [sync/batch-replayed-with-mixed-tx-ids](sync/batch-replayed-with-mixed-tx-ids.md) | A batch must reach the sync log as one transaction |
| [api/read-hid-built-in-properties](api/read-hid-built-in-properties.md) | "The write dropped it" was the read hiding it; check the read path first |
| [api/one-error-for-every-failure](api/one-error-for-every-failure.md) | One generic error for many causes makes a malformed call look like a server bug |
| [cost/d1-reads-from-indexer-scans](cost/d1-reads-from-indexer-scans.md) | Cron jobs that scan or never finish burn the Free plan's D1 reads |
| [api/title-resolves-outside-allowed-values](api/title-resolves-outside-allowed-values.md) | A title must resolve only among the property's allowed values; the outliner won't check |
| [testing/untested-rules-survive-mutation](testing/untested-rules-survive-mutation.md) | Each rule a fix adds needs a case where that rule decides the outcome |
| [api/mixed-type-sort-key-500-on-read](api/mixed-type-sort-key-500-on-read.md) | A sort key mixing order strings and db ids made valid node values unreadable (500) |
| [api/outliner-save-and-insert-disagree-on-heading](api/outliner-save-and-insert-disagree-on-heading.md) | `save-block!` strips a `## ` prefix without setting the heading and `insert-blocks!` keeps it; convert the prefix on every write, except for display-type blocks |
| [api/today-resolved-from-worker-clock](api/today-resolved-from-worker-clock.md) | "Today" comes from an explicit owner time zone; Workers run in UTC and `js/Date` local getters are wrong there |
