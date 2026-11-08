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
| [api/validate-final-state-apply-in-order](api/validate-final-state-apply-in-order.md) | Validation and apply must share one model of state: final-state validation refused valid renames, and class checks on the pre-batch snapshot refused valid batches and stored invalid ones |
| [api/handler-writes-skip-outliner-guards-and-implicit-holders](api/handler-writes-skip-outliner-guards-and-implicit-holders.md) | Raw transacts skip built-in guards; delete-blocks!, default values and placeholders hide holders |
| [api/outliner-throws-on-private-tag-writes-answered-500](api/outliner-throws-on-private-tag-writes-answered-500.md) | Setting or removing any private tag (Tag, Journal, Whiteboard, Property, Asset, Page) via `:block/tags` throws in the outliner (500 unless pre-empted); refuse the whole family up front and keep a re-send a no-op |
| [api/promote-page-to-tag-copy-the-apps-transaction](api/promote-page-to-tag-copy-the-apps-transaction.md) | Promote a page by copying the app's convert-page-to-tag transaction; look up with `find-entity` so the Recycle bin guard can fire |
| [api/new-selector-form-needs-every-lookup-site](api/new-selector-form-needs-every-lookup-site.md) | A new page selector (journal date) or refusal rule (reserved stamp idents) must reach every lookup, route, label check and created flag, not only the first |
| [connector/per-item-summary-blows-result-cap](connector/per-item-summary-blows-result-cap.md) | A summary repeating every item pushes a 100-entry write past the result cap; cap the list and keep the JSON whole |
| [api/convert-values-deleted-referenced-value-blocks](api/convert-values-deleted-referenced-value-blocks.md) | A handler that deletes blocks must count and gate on their referrers; a ref property's referrer is the holder, not its hidden value block |
| [api/uuid-case-is-already-normalised-by-cljs-uuid](api/uuid-case-is-already-normalised-by-cljs-uuid.md) | Not a bug: `uuid`, `parse-uuid` and `uuid-string?` all ignore case, so uppercase UUIDs already resolve; repro one request per site kind before enumerating sites |
| [api/property-classes-accepted-root-the-picker-hides](api/property-classes-accepted-root-the-picker-hides.md) | A value the app's picker never offers (Root as a property class) was accepted and meant different things; copy the picker's exclusions, keep remove open |
| [connector/audit-pre-read-must-mirror-the-write](connector/audit-pre-read-must-mirror-the-write.md) | A snapshot or dry-run pre-read must resolve selectors, refuse and keep what it learnt exactly as the write does |
| [cost/d1-statement-shapes-read-more-than-they-return](cost/d1-statement-shapes-read-more-than-they-return.md) | Windows, IN subqueries and a second index bound read many times the rows they return; measure `meta.rows_read` |
| [cost/per-entry-intl-formatters-burn-the-cpu-budget](cost/per-entry-intl-formatters-burn-the-cpu-budget.md) | A formatter built per list entry cost about 10 ms for 200 entries; cache it |
| [sync/tx-meta-listener-keeps-the-last-outliner-op](sync/tx-meta-listener-keeps-the-last-outliner-op.md) | A listener that keeps the last `:outliner-op` mislabels the commit when a later helper transacts on the same conn; capture only while the mutation runs |
| [api/authorship-stamps-ride-the-write-transaction](api/authorship-stamps-ride-the-write-transaction.md) | Stamp inside the write's transaction from its own datoms, via a header at zero extra cost; verify a judge's cited line before ranking on it |
| [connector/redact-the-secret-before-you-cut-the-message](connector/redact-the-secret-before-you-cut-the-message.md) | Redact a secret before truncating text that holds it; test with a value that is not token-shaped; keep CLI and `.mcp.json` variable names in step |
| [cost/bearer-lookup-by-hash-costs-one-row](cost/bearer-lookup-by-hash-costs-one-row.md) | Shape-check before D1, look up on the hash index (1 row), throttle `last_used` to once an hour |
| [sync/snapshot-is-kvs-only-and-tx-log-has-no-author](sync/snapshot-is-kvs-only-and-tx-log-has-no-author.md) | A backup snapshot is raw `kvs` storage (no page tables); `tx_log` is never pruned, is wiped on import and has no author column; item 30 spike, revisit |
| [connector/optimistic-guard-must-compare-the-form-it-drew](connector/optimistic-guard-must-compare-the-form-it-drew.md) | A stale-form guard compares against the values the form was drawn from, on every submit; a guard that reads the row at POST time lets an old tab undo a newer change; a skeptic that read the wrong checkout refuted a real finding |
| [connector/two-step-edit-applies-what-it-showed-and-audits-with-it](connector/two-step-edit-applies-what-it-showed-and-audits-with-it.md) | A confirm step applies the value it showed (absolute expiry, not days recounted); the change and its audit row commit together; per-edit D1 cost |
