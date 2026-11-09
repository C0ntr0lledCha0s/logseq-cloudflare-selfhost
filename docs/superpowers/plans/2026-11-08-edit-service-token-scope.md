# Edit a service token's graphs, mode and expiry: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the owner can edit an active service token's graphs, mode and expiry from the `/tokens` wizard without changing the token string. Narrowing applies at once. Widening (a new graph, a graph swap, or read-only to read-write) applies only after a confirm page that names each gain. Expiry can only get shorter. Every applied edit is read back, writes one `audit_log` row and sets a new `updated_at`, which `/tokens` shows as "Last changed".

**Architecture:**
- **Connector only.** No patch (spec §3.1). `scripts/check.sh` runs without `--upstream` in every stage.
- **No change to the request path.** `verifyServiceToken`, `findByHash`, `scopedResolve`, `mcp.ts`, the tools, `connector_help` and `tools-manifest.json` stay as they are. Scope is already read from D1 on every `/mcp` request, so an edit takes effect on the next call. Stage 3 pins that with a test through the real Worker (spec §8.1).
- **One guarded write.** `ServiceTokenStore.update` is one conditional `UPDATE` whose `WHERE` holds `revoked_at IS NULL`, `expires_at > now` and the stored before-values. A second tab or a disconnect landing in between makes it miss, and the edit fails closed (spec §3.3).
- **Order:** storage first (nothing calls it), then the audit row (nothing calls it), then the edit routes for narrowing and shortening only (widening is refused, writing nothing), then the widening confirm, then the `/tokens` list's Edit link and Last changed line. A widening is never applied without its confirm in any stage, and every stage leaves the gate green.

**Tech stack:** TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1 in workerd, migrations applied by `connector/test/apply-migrations.ts`, the `SYNC` binding faked at HTTP level, the Worker run for real through `createConnector().fetch` as `wizard.test.ts`'s `service tokens` block does).

**Spec:** `docs/superpowers/specs/2026-11-08-edit-service-token-scope-design.md`. Read it first. It is the authority; section numbers below (§3.5 and so on) are the spec's. The owner answered its §11 questions as the spec proposes: confirm on widening with no recent-sign-in step; expiry only shortens; history stays in `audit_log` plus `updated_at`; narrowing applies at once and a swap counts as widening. Nothing in this plan adds a step-up sign-in or a history table.

## Global constraints

- **Names, exactly:**
  - migration `connector/migrations/0007_service_token_updated_at.sql`, one statement `ALTER TABLE service_tokens ADD COLUMN updated_at INTEGER;` (nullable, no default, no backfill, no index, no trigger);
  - `ServiceTokenRow.updatedAt: number | null`; `updated_at` joins `PUBLIC_COLUMNS` and `toRow`;
  - `TokenScope { graphIds: string[]; access: ServiceTokenAccess; expiresAt: number }`, exported from `connector/src/auth/service-tokens.ts`;
  - `ServiceTokenStore.update(id, before: TokenScope, after: TokenScope, now): Promise<boolean>`;
  - `AuditLog.recordTokenEdit({at, name, ownerId, before, after}): Promise<number>` in `connector/src/audit/log.ts`;
  - wizard: `TOKEN_EDIT = /^\/tokens\/(<uuid>)\/edit$/` (same UUID shape as `TOKEN_REVOKE`), `GET /tokens/:id/edit` through `withSession`, `POST /tokens/:id/edit` through `withForm`; `parseTokenEditForm(form, connected, row, now)`; form fields `graph` (repeated), `access`, `expires_days` (optional), `csrf`, and on the confirm page `confirm=1` and `base`;
  - views: `editTokenPage`, `tokenEditConfirmPage`, and in `tokenSection` an Edit link and a `Last changed` line.
- **Messages, in the spec's wording** (§3.4, §3.5, §4). Each names its field or reason:
  - 404 `No service token has that id.`;
  - 409 `Service token '<name>' was revoked on YYYY-MM-DD; it cannot be edited. Issue a new token.`, `… expired on YYYY-MM-DD; …`, `… belongs to a previous owner; it cannot be edited.`, and `changed since you opened this page; reload and edit again.`;
  - 400 `graph: choose at least one graph.`, `graph: a chosen graph is not connected. Reload the page and choose again.`, `access: choose read-only or read-write.`, `expires_days: a whole number of days from 1 to 365.`, `expires_days: that would extend the expiry past YYYY-MM-DD. A token's expiry can only be shortened; issue a new token instead.`;
  - 500 `<field>: the stored token did not match the form, so it was revoked. Issue a new token.`;
  - 503 `audit log is missing (apply migration 0004); nothing was changed.`
  The graph and access messages are reused from `parseTokenForm`, not copied: factor the graph and access checks into one helper both parsers call.
- **Refuse the whole call up front** (CLAUDE.md, *No silent success*). Every check runs before the `UPDATE`. A refusal leaves the row, `updated_at` and `audit_log` unchanged, and each refusal test asserts all three.
- **Fail closed.** The `UPDATE` holds `revoked_at IS NULL AND expires_at > ?` and the before-values even though the route checks them first, so removing a route check never revives a token. `update()` throws if `after.expiresAt > before.expiresAt`, so no caller can extend a token.
- **Not a rotation.** `update()` takes no token and sets no `token_hash`. Tests assert the hash is unchanged and the same `lsct_` string still authenticates.
- **No token at rest or in output.** The audit row holds names and ids only. Tests scan every column of `service_tokens` and `audit_log`, and every response body, for the token and its hash (the existing `LSCT` regex and `transcript` pattern in `wizard.test.ts`). URLs and form fields name the row's UUID id, never the token: no path, fixture, form value or test name is built from a token or a prefix of one (the brief's "no path containing 'tok'" rule). The file names the spec fixes stay as they are.
- **Owner only.** No MCP tool reads or writes `service_tokens` beyond `verifyServiceToken` and `touch`. `tools-manifest.json` stays unchanged, and the manifest check in `scripts/check.sh` confirms it in every stage.
- **Free plan** (§5, REVIEW.md *Cost*, `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`, `docs/solutions/cost/bearer-lookup-by-hash-costs-one-row.md`). Tests pin from D1's `meta`: `update()` on a hit reads 1 and writes 1; a guard miss reads 1 and writes 0; an unknown id reads 0 and writes 0; `recordTokenEdit` reads 0 and writes 2; `findByHash` still reads 1 and writes 0 after 0007; `list()` still reads about one row per token. Per applied edit about 3 + N reads and 3 writes (N connected graphs); a widening's first POST about 1 + N reads and 0 writes. A `/mcp` request still reads 1 row and writes 0 (plus the hourly touch). Each stage's commit body states its rows per request.
- **Tests run the real thing.** Real D1, the real Worker through `createConnector().fetch`, the real wizard routes and SQL. Only the sync server and GitHub are faked. The one stub allowed is spec §8.14's read-back mismatch, where a test DB wrapper makes `get` return a different row. Each rule test is first seen to fail with the rule removed (confirm on widen, expiry never extends at both layers, revoked, expired and previous owner, CSRF, the before-value guard, read-back, audit-before-apply). Keep each failure text for the PR (`docs/solutions/testing/untested-rules-survive-mutation.md`).
- **Audit row mirrors the write** (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`). The before-values in the audit row are the ones the `UPDATE` guarded on, and the after-values are the ones read back, not the form's.
- **Contract with Claude.** No tool is added, removed or renamed; `connector_help`, tool descriptions and `tools-manifest.json` are unchanged.
- **Commits** follow `type(scope): what changed` (scope `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a token, graph name, page UUID, real hostname or database id. Tests and docs use `mcp.example.com`, the existing test graphs (`my-work-graph`, `other`) and token names such as `ci` and `nightly`. Test tokens are generated at run time.

### Read before starting

- `REVIEW.md`, sections *Cost*, *Security*, *Contract and docs*, *Gates and tests*.
- `connector/src/auth/service-tokens.ts` (`ServiceTokenStore`, `PUBLIC_COLUMNS`, `toRow`, `revoke`, `revokeForGraph`), `connector/src/wizard/routes.ts` (`withSession`, `withForm`, `TOKEN_REVOKE`, `parseTokenForm`, `readBackMismatch`, `createToken`, `revokeToken`, `disconnectGraph`, `wizardRoute`), `connector/src/wizard/views.ts` (`tokenStatus`, `tokenSection`, `tokenListPage`, `newTokenPage`), `connector/src/audit/log.ts` (`ready`, `begin`, `recordRead`, `get`, `lookup`, `query`, the cost table in the header comment).
- `connector/migrations/0004_audit_log.sql` and `0006_service_tokens.sql` for the header-comment style with measured costs; the `add-d1-migration` skill.
- `connector/test/service-tokens.test.ts` (`migration 0006`, `ServiceTokenStore`, `HTTP`) and `connector/test/wizard.test.ts` (`service tokens`: `twoGraphs`, `createForm`, `rawRows`, `bare`, `mcp`).
- The `docs/solutions` entries named above, and `docs/solutions/connector/redact-the-secret-before-you-cut-the-message.md`.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **The same graphs in a different order:** not a change. The diff is by set, so reordering alone redirects 303 and writes nothing; but when another field changes, the stored order follows the form and the read-back compares in order (Stage 3).
2. **A repeated `graph` value** (`graph=A&graph=A`): de-duplicated as `parseTokenForm` does, so it is not a widening and the stored array has no duplicate (Stage 3).
3. **`expires_days` that lands exactly on the stored expiry** (`now + days * DAY_MS === row.expiresAt`): allowed, and since nothing else changed it is no change at all. One millisecond past is refused (Stage 3).
4. **`expires_days` of `0`, `366`, `1.5`, `-1` or ` 7 `:** the first four refused with the range message; the padded one trimmed and accepted (Stage 3).
5. **A token that expires between the GET and the POST:** refused 409 expired on the POST, by the route; and with the route check removed, the `UPDATE`'s `expires_at > ?` still writes nothing (Stage 3).
6. **A forged `confirm=1` with no `base`, or a `base` that is not JSON:** treated as unconfirmed, so the confirm page is shown and nothing is written (Stage 4).
7. **A `base` that matches but the form widens further than the confirm page showed** (a third graph added to the re-post): the gains are recomputed from the stored row and the form, so the re-post applies exactly what it carries, and the audit row names all three. The confirm page's listed gains are what the owner confirmed only if the hidden fields are untouched; this is acceptable because the POST is the owner's own CSRF-checked form, and the test documents it (Stage 4).
8. **Widening to a graph connected read-only:** the confirm page says "effective: read only (the graph is read-only)", and after confirming a write tool on it is still refused with the plain read-only message (Stage 4).
9. **A narrowing that also shortens expiry, and a narrowing combined with a read-to-write raise:** the first applies at once; the second is a widening and needs the confirm (Stage 3, Stage 4).
10. **A previous owner's token reached by id:** both GET and POST refuse 409 without rendering its graphs (Stage 3).
11. **A `/tokens` page holding a revoked, an expired and an active token:** only the active one has an Edit link; all three show Last changed (Stage 5).

---

### Stage 1: Migration 0007 and `ServiceTokenStore.update`

**Goal:** the `updated_at` column, `updatedAt` on every row the store returns, and a guarded `update()` whose costs are pinned. Nothing calls `update()` yet, so behaviour for the owner and Claude is unchanged. Lands spec §3.2, §3.3, and tests §8.13 (store half) and §8.15.

**Files:**
- Create: `connector/migrations/0007_service_token_updated_at.sql`. Header comment: what the column is for, why it lives on the row rather than being read from `audit_log` (the list would pay extra reads, and the time would vanish with the audit purge), and the measured costs from spec §2 (the `ALTER` reads about 22 schema rows and writes 1 once; `findByHash` and the list are unchanged; the conditional `UPDATE` reads 1 by primary key, writes 1 on a hit and 0 on a miss). Follow the `add-d1-migration` skill.
- Modify: `connector/src/auth/service-tokens.ts`: `updated_at` in `Row`, `PUBLIC_COLUMNS` and `toRow`; `updatedAt` on `ServiceTokenRow`; `TokenScope`; `update()` as spec §3.3, one statement:

  ```sql
  UPDATE service_tokens
     SET graph_ids = ?, access = ?, expires_at = ?, updated_at = ?
   WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
     AND graph_ids = ? AND access = ? AND expires_at = ?
  ```

  with `JSON.stringify` of both graph arrays, `meta.changes > 0` as the answer, and a thrown `Error` before the statement when `after.expiresAt > before.expiresAt`. Extend the class's cost comment.
- Modify: `connector/test/service-tokens.test.ts` (a `migration 0007` block and `update` tests in the `ServiceTokenStore` block).
- Modify any test that deep-equals a `ServiceTokenRow` (search `connector/test` for `revokedAt:`) to expect `updatedAt: null`.

**Interfaces produced:** `TokenScope`, `ServiceTokenStore.update`, `ServiceTokenRow.updatedAt`.

- [ ] **Step 1: Write the failing tests:**
  - `migration 0007`: `d1_migrations` lists it right after `0006_service_tokens.sql`; `PRAGMA table_info(service_tokens)` lists `updated_at` as nullable `INTEGER` with no default. Existing rows: rebuild `service_tokens` as 0006 left it (its queries from `TEST_MIGRATIONS`, as `graphs.test.ts`'s migration-0005 test does), insert a row, apply 0007's queries, and check every other value is unchanged and `updated_at` reads NULL (the `add-d1-migration` skill, step 5).
  - `get and list return updatedAt`: NULL for a new token; still no `token_hash` in either.
  - `update applies and stamps`: on an active token, `update(id, before, after, now)` answers true; `get` shows the new graphs (in the given order), access, expiry and `updatedAt === now`; a raw `SELECT token_hash` is unchanged; `meta.rows_read` 1 and `meta.rows_written` 1 (spec §8.13).
  - `update fails closed`: false and the row unchanged, each with `meta.rows_written` 0, when the token is revoked, when `expires_at <= now`, when the stored graphs differ from `before.graphIds` (another order counts as different), when the stored access differs, and when the stored expiry differs. A guard miss reads 1. An unknown id reads 0 and writes 0.
  - `update never extends`: `after.expiresAt = before.expiresAt + 1` throws before any statement (no row changed), and equal expiry is allowed.
  - `findByHash after 0007`: still reads 1 and writes 0 on a hit (spec §8.13).
  - `update leaves the hash alone`: across every case above, a raw `SELECT token_hash` before and after is identical, and the token from `create` still matches through `findByHash(hashServiceToken(token))`.

- [ ] **Step 2: Run** `npm --prefix connector test -- service-tokens`; keep the failures (no such column, no method).

- [ ] **Step 3: Implement** as spec §3.2 and §3.3.

- [ ] **Step 4: Contract.** None for Claude.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** drop `revoked_at IS NULL` from the `WHERE` and confirm the revoked case fails; drop `AND graph_ids = ?` and confirm the stale-graphs case fails; remove the expiry assertion and confirm `update never extends` fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): add updated_at to service_tokens and a guarded scope update`. Body: the migration runs once (about 22 schema rows read, 1 written); `update()` reads 1 and writes 1 on a hit, reads 1 and writes 0 on a guard miss; `findByHash` and `list` unchanged; no token or hash in the method.

**Done when:** migration 0007 applies and keeps existing rows, `update()` writes only through its guard and never extends expiry, every cost is pinned from `meta`, and the gate is green.

---

### Stage 2: The `token_edit` audit row

**Goal:** `AuditLog.recordTokenEdit` inserts one `audit_log` row per edit, with `graph_id` NULL so no `get_activity_log` call ever returns it. Nothing calls it yet. Lands spec §3.6 and tests §8.10 (store half) and §8.13 (audit insert).

**Files:**
- Modify: `connector/src/audit/log.ts`: `recordTokenEdit({at, name, ownerId, before, after})`, one `INSERT` with `graph_id` NULL, `alias` `service:<name>`, `tool` `token_edit`, `kind` `write`, `status` `ok`, `client` `wizard`, `session` `github:<ownerId>`, `before` `{"source":"service_tokens","data":{"before":{graphIds, access, expiresAt},"after":{…},"added":[…],"removed":[…]}}`, and `targets`, `addressed`, `pages` NULL. It answers the new row's id. Add its line to the header cost table (0 read, 2 written).
- Modify: `connector/test/audit-log.test.ts` (a `recordTokenEdit` block).

**Interfaces produced:** `AuditLog.recordTokenEdit`.

- [ ] **Step 1: Write the failing tests:**
  - `writes one row as spec §3.6`: every column checked against the table above, `added` and `removed` computed by set and kept in the order given; `meta.rows_read` 0, `meta.rows_written` 2.
  - `no reader returns it`: `get`, `lookup` and `query` for any graph id never return the row, and a `get_activity_log` call through `mcpHandler` (OAuth, and under a service scope covering the graph) lists other rows but not this one.
  - `holds no secret`: given a store-created token, no column of the row contains the token or its hash.
  - `targets stays NULL`: a reader that parses `targets` as `AffectedTarget[]` sees NULL (spec §3.6 call).

- [ ] **Step 2: Run** `npm --prefix connector test -- audit-log`; keep the failures.

- [ ] **Step 3: Implement** as spec §3.6.

- [ ] **Step 4: Contract.** None. `get_activity_log`'s description is unchanged because it never sees the row.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** write the token's first graph id into `graph_id` and confirm `no reader returns it` fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): record service token edits in audit_log, out of every graph's activity log`. Body: 0 read and 2 written per edit (row and the `(graph_id, at)` index entry); `graph_id` NULL keeps it out of `get_activity_log`; the row is purged with the rest of the log after `AUDIT_RETENTION_DAYS`.

**Done when:** the row has the spec's shape, costs 0 read and 2 written, never appears in an activity log, holds no secret, and the gate is green.

---

### Stage 3: Edit routes for narrowing and shortening

**Goal:** `GET` and `POST /tokens/:id/edit` with every refusal, the diff, the update, the read-back and the audit row, for edits that only narrow (graphs removed, write to read, a shorter expiry, or a mix). A widening is refused with 400 `graph: adding graphs or raising to read-write needs the confirm step, which is not available yet; nothing was changed.` and writes nothing; Stage 4 replaces that refusal with the confirm page. No link to the edit page yet (Stage 5), so the owner reaches it only by URL. Lands acceptances 1, 2 (narrowing), 4, 5, 6, 7 and 8, and spec §3.4, §3.5 steps 1 to 3 and 5 to 8, and tests §8.1 (narrowing), §8.4 to §8.8, §8.10, §8.11, §8.14.

**Files:**
- Modify: `connector/src/wizard/routes.ts`: `TOKEN_EDIT`; `editTokenForm` (GET) and `submitTokenEdit` (POST) routed beside `TOKEN_REVOKE`; a shared `refuseUneditable(row, ownerId, now)` used by both and by the post-miss `get`; `parseTokenEditForm` sharing a graph-and-access helper with `parseTokenForm`; the diff (added, removed, access change, expiry change; no change redirects 303 and writes nothing); `AuditLog.ready()` checked before parsing; `update()`; read-back with `readBackMismatch` generalised to take `{name, graphIds, access, expiresAt}` so `createToken` and the edit share it; on a mismatch `revoke()` and 500; then `recordTokenEdit` with the guarded before-values and the read-back after-values; then 303 to `/tokens` with `Cache-Control: no-store`.
- Modify: `connector/src/wizard/views.ts`: `editTokenPage(csrf, row, graphs, values, status?, error?)`: name as text, graph checkboxes (current ticked), read-only or read-write, the optional "Shorten expiry to N days from now" field (blank by default) with the current expiry date beside it, and the refusal message when given. On a 400, echo only values that are already valid, as `createToken` does.
- Modify: `connector/test/wizard.test.ts` (an `edit service tokens` block inside or beside `service tokens`, reusing `twoGraphs`, `createForm`, `rawRows`, `bare` and `mcp`; add an `editForm(h, id, fields, graphs)` helper).

**Interfaces produced:** the edit routes; `editTokenPage`; the shared graph-and-access parser; `readBackMismatch` over a `TokenScope`-shaped value plus name.

- [ ] **Step 1: Write the failing tests** (all through the real Worker):
  - `next request sees a narrowing` (spec §8.1): create a read-write token on both graphs through `POST /tokens/new`; a `/mcp` read on `other` succeeds; edit to `my-work-graph` only (303); the very next `/mcp` call on `other` is refused with the out-of-scope message naming `other` and `ci`. Edit write to read; the next write on `my-work-graph` is refused as read-only naming the token.
  - `narrowing applies at once` (spec §8.4): removing a graph, and write to read, each answer 303 in one POST; `updated_at` is set; exactly one `token_edit` audit row each.
  - `widening is refused for now`: adding a graph, a swap, and read to write each answer 400 with the interim message; row, `updated_at` and `audit_log` unchanged.
  - `expiry` (spec §8.5, review focus 3, 4): a shorter expiry applies; landing exactly on the stored expiry is no change (303, nothing written); one day past answers 400 with the extension message and the stored date; blank keeps the stored expiry; `0`, `366`, `1.5` and `-1` answer the range message.
  - `refusals` (spec §8.6): unknown id 404 (GET and POST); revoked 409 with the date; expired 409 with the date; previous owner 409 without the token's graphs in the body (review focus 10); empty graph list; a graph id not connected; a bad access value; a missing or wrong CSRF token 403; `audit_log` dropped 503. Each asserts the message, an unchanged row and no new audit row.
  - `owner only` (spec §8.7): no session redirects to `/login` for GET and POST; an `lsct_` bearer with no cookie gets the same redirect; `tools-manifest.json` has no tool whose name contains `token`.
  - `token unchanged` (spec §8.8): after an edit the same `lsct_` string still answers `initialize` at `/mcp`, and `token_hash` is unchanged.
  - `no change writes nothing` (review focus 1, 2): the same graphs reordered, and a repeated `graph` value, answer 303 with `updated_at` still NULL and no audit row.
  - `audit row` (spec §8.10): one row with `tool = 'token_edit'`, `graph_id` NULL, `alias = 'service:ci'`, `client = 'wizard'`, before and after in `before.data`; the token and hash appear in no column and no response body.
  - `race with disconnect` (spec §8.11): GET the edit page, disconnect `other` through the wizard (which runs `revokeForGraph`), then POST a narrowing: 409 revoked, and the row keeps its old graphs and its first `revoked_at`.
  - `expired between GET and POST` (review focus 5): move the stored `expires_at` to the past, POST: 409 expired, nothing written.
  - `guard miss reports why`: change the stored access between the route's load and its `UPDATE` with a test DB wrapper that runs one statement before the `UPDATE`: 409 `changed since you opened this page; reload and edit again.`, nothing written.
  - `read-back mismatch` (spec §8.14): a test DB wrapper makes the read-back `get` return a different access; the answer is 500 naming `access`, the token is revoked, and no `token_edit` row is written.
  - `cost`: an applied narrowing reads about 3 + N and writes 3 (the `UPDATE` 1, the audit insert 2), counted from `meta` through a counting DB wrapper; a refusal writes 0.

- [ ] **Step 2: Run** `npm --prefix connector test -- wizard`; keep the failures (404 on the new routes).

- [ ] **Step 3: Implement** as spec §3.4 and §3.5, with the interim widening refusal in place of step 4.

- [ ] **Step 4: Contract.** None for Claude. A narrowed token's refusals use the existing messages.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check**, one at a time: remove the route's revoked check (the `UPDATE` guard must still refuse, so the revoked test must still see nothing written; then also drop `revoked_at IS NULL` and confirm it fails); remove the parser's extension check (the `update()` assertion must still refuse with no write); skip `ready()` (the 503 test fails); skip the read-back (the mismatch test fails); route POST through `withSession` instead of `withForm` (the CSRF test fails). Revert.

- [ ] **Step 7: Commit.** `feat(connector): edit a service token's graphs, mode and expiry in the wizard (narrowing only)`. Body: the routes, each refusal and its status; widening refused until the confirm lands; per applied edit about 3 + N reads and 3 writes, a refusal at most 2 + N reads and 0 writes; a `/mcp` request still reads 1 row.

**Done when:** a narrowing or shorter expiry applies through the real Worker and is seen on the very next `/mcp` call, every refusal writes nothing and names its reason, a widening writes nothing, and the gate is green.

---

### Stage 4: The widening confirm

**Goal:** a widening (an added graph, a swap, or read to write, with or without narrowing in the same edit) shows `tokenEditConfirmPage` and applies only on a re-post with `confirm=1` and a `base` equal to the stored before-values. A stale `base` shows the confirm page again with a "changed since" line. Replaces Stage 3's interim refusal. Lands acceptance 3 and 9, spec §3.5 step 4, and tests §8.1 (widening), §8.2, §8.3, §8.9.

**Files:**
- Modify: `connector/src/wizard/routes.ts`: in `submitTokenEdit`, `isWidening(diff)`; `base` parsed as JSON and compared field by field with the stored `{graphIds, access, expiresAt}` (anything unparseable is unconfirmed); unconfirmed or stale renders the confirm page with 200 and writes nothing; confirmed re-runs steps 1 to 3 in full and continues to the update. Remove the interim refusal.
- Modify: `connector/src/wizard/views.ts`: `tokenEditConfirmPage(csrf, row, diff, graphs, stale)`: each gain by current alias ("gains read-write on <alias>", "gains read-only on <alias>"), "effective: read only (the graph is read-only)" for a graph connected read-only, each loss, the not-a-rotation line ("Editing does not change the token. If it may have leaked, revoke it and issue a new one."), the "changed since you opened this page" line when stale, and hidden inputs re-posting `graph`, `access`, `expires_days`, `confirm=1`, `base` and the CSRF token. Every value is escaped.
- Modify: `connector/test/wizard.test.ts`: replace Stage 3's `widening is refused for now` with the tests below.

**Interfaces produced:** `tokenEditConfirmPage`.

- [ ] **Step 1: Write the failing tests:**
  - `widening needs confirmation` (spec §8.2): adding `other` without `confirm` answers 200 with the confirm page listing "gains … on other"; the row, `updated_at` and `audit_log` are unchanged. Re-posting the page's own hidden fields applies it (303), and the next `/mcp` call on `other` succeeds. Read to write behaves the same way. A swap and a narrowing plus a raise each show the confirm page (review focus 9).
  - `confirm page content`: names each gain and loss by alias, shows the not-a-rotation line, carries `confirm=1`, `base` and the CSRF token, and contains no `lsct_` string.
  - `forged confirm` (review focus 6): `confirm=1` with no `base`, and with `base` set to `not json`, each show the confirm page and write nothing.
  - `stale confirm` (spec §8.3): change the stored row (a narrowing in a second POST) between the confirm page and the confirming POST: the confirm page is shown again with the "changed since" line and the current values, and nothing from the stale confirm is written.
  - `re-post carries more than the page showed` (review focus 7): a confirming POST with a third graph id added applies what it carries, and the audit row's `added` names both graphs.
  - `graph mode still caps` (spec §8.9, review focus 8): a read-write token widened to `other` (connected read-only) shows "effective: read only"; after confirming, a write on `other` is refused with the plain `graph 'other' is read-only`, and a read succeeds.
  - `cost`: a widening's first POST reads about 1 + N and writes 0; the confirming POST matches an applied narrowing (about 3 + N read, 3 written).

- [ ] **Step 2: Run** `npm --prefix connector test -- wizard`; keep the failures (400 interim refusal where the confirm page is expected).

- [ ] **Step 3: Implement** as spec §3.5 step 4.

- [ ] **Step 4: Contract.** None for Claude.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** make `isWidening` ignore the access change and confirm the read-to-write test fails; skip the `base` comparison and confirm the stale test fails; treat a swap as narrowing (only count net graph additions) and confirm the swap test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): confirm before widening a service token`. Body: what counts as widening, why no sealing is needed (CSRF plus the full re-check plus the `UPDATE` guard), the stale path, and the cost of the confirm page (about 1 + N read, 0 written).

**Done when:** no widening applies without the confirm, a stale or forged confirm writes nothing, the graph's own mode still caps the token, and the gate is green.

---

### Stage 5: Edit link and Last changed on `/tokens`

**Goal:** `/tokens` shows each token's `Last changed` (UTC, or "never") and an Edit link on active tokens only. Lands acceptance 7's display half and test §8.12.

**Files:**
- Modify: `connector/src/wizard/views.ts`: `tokenSection` gains the `Last changed` line under `Last used` and, for `status === "active"`, an `<a href="/tokens/<id>/edit">Edit <name></a>` beside the Revoke button.
- Modify: `connector/test/wizard.test.ts`.

**Interfaces produced:** none.

- [ ] **Step 1: Write the failing tests:**
  - `last changed` (spec §8.12): `/tokens` shows `Last changed` "never" for a new token, and the edit's UTC time after a narrowing.
  - `edit link only on active tokens` (review focus 11): with a revoked, an expired and an active token listed, only the active one links to `/tokens/<its id>/edit`; all three show `Last changed`.
  - `list cost unchanged`: `GET /tokens` still reads about one `service_tokens` row per token (spec §5).

- [ ] **Step 2: Run** `npm --prefix connector test -- wizard`; keep the failures.

- [ ] **Step 3: Implement** as spec §3.7.

- [ ] **Step 4: Contract.** None for Claude.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** show the Edit link for every status and confirm the active-only test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): show last changed and an edit link on the service tokens page`. Body: no new read (the column is on the row), the link only on active tokens.

**Done when:** the owner can reach the edit page from `/tokens`, sees when each token last changed, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage** (spec §3.8): README §11.12 gains a step between "Use it" and "Revoke": editing a token, the widening confirm, expiry only shortens, editing does not rotate the secret (revoke and re-issue if it may have leaked), scope changes reach running sessions on their next call, and the cost. README §11.10's read-only row changes to "edit the token to read-write at `/tokens` (11.12)", and the out-of-scope row gains the same hint. The service-token design gets a short addendum pointing to this spec. REVIEW.md *Security* and *Cost* are read against the diff; no new line is expected. Example hostnames only.
- **PR body:** the Logseq skill note (spec §4: no tool changes; a cloud session's token can be narrowed while it runs, so a graph that worked may start answering out-of-scope or read-only, and the skill should report that rather than retry), the failure each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped (`--upstream` is not run, since no patch changes).
- **After deploy** (spec §9 steps 2 to 6): every existing token shows "Last changed: never"; edit the cloud-session token to add the test graph through the confirm page; a running session sees it without a secret change; remove it again and the next call is refused; one `token_edit` audit row per edit with no token in it.
