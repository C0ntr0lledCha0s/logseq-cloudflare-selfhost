# Edit a service token's graphs, mode and expiry: design

Date: 2026-11-08
Issue: none (owner request: "add a way to edit the existing service tokens so I can add the additional test graph to the token. Is that secure or breaking best practice?"). Areas: connector, migrations, docs.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`. This work adds no patch.
Branch: `claude/relaxed-maxwell-s4r8o4-scopeedit`, from `origin/main` at `498c62a`.
Builds on: `docs/superpowers/specs/2026-11-07-service-token-cloud-sessions-design.md` (called "the service-token design" below), and migration 0006.

Decisions marked **(brief)** come from the brief. Decisions marked **(call)** were made while writing this design. The design panel chose the "minimal" proposal and no ideas were grafted from the others. The owner can overturn any decision; the ones most worth a second look are in section 11.

## 1. Goal

A service token's graphs, mode and expiry are fixed when it is created. To give a token one more graph (the owner's test graph, today), the owner must create a new token, replace the `LOGSEQ_SERVICE_TOKEN` secret in every cloud environment that holds it, and revoke the old one. This design lets the owner widen or narrow an active token in place from the wizard, without changing the token string.

**Is it secure, or against best practice?** Editing a credential's scope after it is issued is accepted practice when it is done carefully. GitHub fine-grained personal access tokens let the owner change a token's repositories and permissions after creation, and Cloudflare API tokens can be edited the same way. The real risk is that the token is already sitting in a cloud secret, so a quiet widening grants more to something that is already running, and a token that may have leaked would gain access too. The design closes that off with these controls:

- only the owner's signed-in wizard session, with CSRF, can edit a token; no MCP tool can, and a bearer cannot reach the routes;
- any widening (a new graph, or read-only to read-write) shows a confirm page naming exactly what the token gains, and applies only after confirmation;
- expiry can only get shorter, never longer;
- revoked and expired tokens cannot be edited;
- every edit writes an audit row (who, which token, before and after), and `/tokens` shows a last-changed time;
- the token string and its hash never change. An edit is not a rotation. If the secret may have leaked, revoke it and issue a new one instead.

Re-issuing a token for every change remains the safest choice for rotation, and it stays available. Editing trades that for not having to replace the secret in each environment.

Acceptance (brief):

1. `POST /tokens/:id/edit` needs the owner session and CSRF, like revoke. A bearer or a non-owner cannot reach it, and no MCP tool edits tokens.
2. The owner can add or remove graphs and switch mode between read-only and read-write on an active token. The token string and hash are unchanged.
3. Widening (adding a graph or moving to read-write) shows a confirm step naming exactly what the token gains and applies only after confirmation. Narrowing applies at once.
4. Expiry may be shortened but never extended past the stored `expires_at`. The form and the server both refuse an extension and say to issue a new token.
5. A revoked or expired token cannot be edited, and the refusal says which.
6. Unknown or disconnected graph ids and an empty graph list are refused up front, naming the field. Nothing is partly applied.
7. An `audit_log` row records who, the token name, and the before and after graphs and mode, without any token or hash. `/tokens` shows the last-changed time.
8. A narrowed or downgraded token loses access on its very next `/mcp` request: the token row is read by hash on every request and no per-isolate cache holds its scope. A test through the real Worker verifies and pins this.
9. A token never exceeds a graph's own mode (the existing `scopedResolve` rule still holds after an edit).
10. D1 rows read and written per edit and per `/mcp` request are counted and pinned with `meta.rows_read` and `meta.rows_written`. A request still reads 1 row and writes 0.
11. Regression tests run through the real Worker routes and SQL and are seen to fail before the change.
12. README §11.12 documents editing, the widening confirm, the expiry rule and the cost. REVIEW.md *Security* and *Cost* are checked. Docs and tests use example data only (`mcp.example.com`).

## 2. Context

**Token rows are immutable today apart from two columns.** `ServiceTokenStore` (`connector/src/auth/service-tokens.ts`) has `create`, `get`, `list`, `nameInUse`, `remove`, `findByHash`, `revoke`, `revokeForGraph` and `touch`. Only `revoke`, `revokeForGraph` (`revoked_at`) and `touch` (`last_used_at`) ever update a row. `PUBLIC_COLUMNS` and `ServiceTokenRow` deliberately carry no hash.

**Scope is read from D1 on every request.** `verifyServiceToken` checks the bearer's shape, reads the row by `token_hash` (`findByHash`), compares the hash in constant time, refuses revoked, expired and previous-owner tokens, and returns `ServiceProps` with `graphIds` and `access` taken from that read. `mcpApiHandler` puts them into the request scope, and `scopedResolve` (`connector/src/tools/common.ts:128-140`) applies them inside `access.resolve`. `mcp.ts` keeps an isolate-level `GraphAccess` and tool set, but no token or scope cache. So a narrowed token should lose access on its next request with no new code. The design still pins this with a test (8.1), because a cache added later would silently undo it.

**There is no last-changed column.** Migration 0006 created `service_tokens` with `created_at`, `expires_at`, `last_used_at` and `revoked_at`, and no `updated_at`. Reading a last-changed time from `audit_log` instead would add reads to every `/tokens` list and would disappear when the audit purge removes the row.

**`audit_log` is shaped for tool calls.** Migration 0004: `alias` and `tool` are `NOT NULL`, `kind` is `'write'` or `'read'`, `status` is an OR-chain CHECK, `graph_id` is nullable, and the one index is `(graph_id, at)`. Every read path in `AuditLog` (`get`, `lookup`, `query`) filters `WHERE graph_id = ?`, so a row with `graph_id` NULL is never returned to `get_activity_log`, under OAuth or under a scoped service token. `targets` is read back as `AffectedTarget[]` and `before` as `{source, truncated?, e2ee?, error?, data}`. `AuditLog.ready()` probes for the table and reads 0 rows.

**The wizard already has the pieces.** `connector/src/wizard/routes.ts` has `withSession` (owner cookie session), `withForm` (session plus CSRF, then the form), `TOKEN_REVOKE` (a UUID-shaped path regex), `parseTokenForm` (each refusal names its field: `graph: choose at least one graph.`, `graph: a chosen graph is not connected. Reload the page and choose again.`, `access: choose read-only or read-write.`), and `readBackMismatch`, which `createToken` uses to compare the stored row with the form and delete the row on a mismatch. `views.ts` has `tokenListPage`, `tokenSection` (with a Revoke button and a Last used line) and `newTokenPage`. The owner session (`OwnerSession`, `auth/session.ts`) carries `githubUserId` only.

**Disconnect revokes tokens.** `disconnectGraph` calls `revokeForGraph(graphId)`, which revokes every unrevoked token whose `graph_ids` contains the graph. So an active token only ever names connected graphs, and an edit racing a disconnect must not revive the token or re-add the graph.

**Measured D1 cost of the new statements.** A throwaway test (now deleted) in the connector's vitest pool, on real D1 with migrations 0001 to 0006 applied, ran the migration and statements this design proposes on a `service_tokens` table holding 20 rows. Output:

```
ALTER read=22 written=1
UPDATE-hit changes=1 read=1 written=1
UPDATE-stale changes=0 read=1 written=0
UPDATE-unknown changes=0 read=0 written=0
GET read=1 row={"id":"id3","name":"n3","owner_id":1,"graph_ids":"[\"a\"]","access":"read","created_at":1,"expires_at":8000000000000,"last_used_at":null,"revoked_at":null,"updated_at":5}
FINDBYHASH read=1 written=0
LIST20 read=20
AUDIT-null-graph read=0 written=2
```

`ALTER` ran on an empty table, so its 22 reads are schema rows, not data; it runs once. The conditional `UPDATE` reads its one row by primary key whether or not the guard matches, and writes only when it does. `findByHash` and the list are unchanged by the new column. An `audit_log` insert with `graph_id` NULL still writes its `(graph_id, at)` index entry, so it writes 2.

## 3. Design

### 3.1 Layout

| File | Change |
|---|---|
| `connector/migrations/0007_service_token_updated_at.sql` | New. One nullable column. |
| `connector/src/auth/service-tokens.ts` | `updatedAt` on `ServiceTokenRow`, `PUBLIC_COLUMNS` and `toRow`. New `update()`. `findByHash` and `verifyServiceToken` unchanged. |
| `connector/src/wizard/routes.ts` | `TOKEN_EDIT` regex, `GET` and `POST /tokens/:id/edit`, `parseTokenEditForm`, the diff, the widening confirm, read-back and fail-closed revoke. |
| `connector/src/wizard/views.ts` | `editTokenPage`, `tokenEditConfirmPage`, an Edit link and a Last changed line in `tokenSection`. |
| `connector/src/audit/log.ts` | `AuditLog.recordTokenEdit`. |
| `connector/test/service-tokens.test.ts`, `connector/test/wizard.test.ts` | Tests (section 8). |
| `README.md` §11.12 and §11.10, this repo's service-token design (addendum), `REVIEW.md` checked | Docs. |

No change to `mcp.ts`, `scopedResolve`, `verifyServiceToken`, the tools, `connector_help` or `tools-manifest.json`.

### 3.2 Migration 0007 (brief)

```sql
ALTER TABLE service_tokens ADD COLUMN updated_at INTEGER;
```

Nullable, no default, no backfill, no index and no trigger. Existing rows read NULL, shown as "never". The header comment records the measured cost (section 2) and why the column lives on the row rather than being read from `audit_log`: the list would pay extra reads, and the time would vanish with the audit purge. Follow the `add-d1-migration` skill: a migration test in the same style as 0006's checks that the column exists and that existing rows keep their values.

### 3.3 `ServiceTokenStore.update` (brief)

```ts
interface TokenScope { graphIds: string[]; access: ServiceTokenAccess; expiresAt: number }
update(id: string, before: TokenScope, after: TokenScope, now: number): Promise<boolean>
```

One statement:

```sql
UPDATE service_tokens
   SET graph_ids = ?, access = ?, expires_at = ?, updated_at = ?
 WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
   AND graph_ids = ? AND access = ? AND expires_at = ?
```

- The last three conditions hold the stored before-values the diff was computed from. Two tabs, or a disconnect's `revokeForGraph` landing between the load and the write, make the guard miss, so the edit fails closed rather than overwriting a newer state or reviving a revoked token.
- `graph_ids` is compared as JSON text. The before-value is `JSON.stringify(row.graphIds)` from the parsed row, which round-trips exactly because `create` and `update` both write `JSON.stringify` of an array of strings. A mismatch can only cause a spurious "changed since", which fails closed.
- It answers `meta.changes > 0`. There is no `token_hash` in `SET` and the method takes no token, so an edit cannot rotate or leak the secret.
- `after.expiresAt <= before.expiresAt` is checked by the caller (3.5) and asserted again here, throwing if violated, so a future caller cannot extend a token by mistake **(call)**.

### 3.4 Routes

`TOKEN_EDIT = /^\/tokens\/(<uuid>)\/edit$/`, the same UUID shape as `TOKEN_REVOKE`, routed beside it:

- `GET /tokens/:id/edit` through `withSession`.
- `POST /tokens/:id/edit` through `withForm`, so the session and CSRF are checked before anything is read.

`GET` loads the row. Unknown id: 404 `No service token has that id.` Revoked: 409 `Service token '<name>' was revoked on YYYY-MM-DD; it cannot be edited. Issue a new token.` Expired: 409 `Service token '<name>' expired on YYYY-MM-DD; it cannot be edited. Issue a new token.` A token whose `owner_id` is not the current owner is refused the same way, 409 `… belongs to a previous owner; it cannot be edited.`, because `verifyServiceToken` would refuse it anyway and an edit would only mislead **(call)**. Otherwise it renders `editTokenPage`: the name (read-only text), graph checkboxes from `GraphStore.list()` with the current ones ticked, read-only or read-write, and an optional "Shorten expiry to N days from now" field that is blank by default, with the current expiry date shown beside it.

### 3.5 The edit POST, in order

1. **Load and refuse.** Load the row with `get(id)` and refuse exactly as `GET` does. Check `AuditLog.ready()`; if `audit_log` is missing, answer 503 `audit log is missing (apply migration 0004); nothing was changed.` An edit never applies without its audit row.
2. **Parse.** `parseTokenEditForm(form, connected, row, now)` reuses `parseTokenForm`'s graph and access checks and their messages. `expires_days` blank keeps `row.expiresAt`. Otherwise it must be a whole number from 1 to `MAX_EXPIRY_DAYS`, and `now + days * DAY_MS` must not exceed `row.expiresAt`, or it answers 400 `expires_days: that would extend the expiry past YYYY-MM-DD. A token's expiry can only be shortened; issue a new token instead.` Every check runs before any write, so nothing is partly applied.
3. **Diff.** Compute added graph ids, removed graph ids, the access change and the expiry change against the stored row. Graph order follows the form. If nothing changed, redirect 303 to `/tokens` and write nothing.
4. **Widening needs a confirm.** Widening is any added graph, or read to write. Unless the form carries `confirm=1` and a `base` field equal to the stored `{graphIds, access, expiresAt}`, render `tokenEditConfirmPage` with status 200 and write nothing. A mixed edit (one graph swapped for another) is a widening. The page:
   - lists each gain by current alias, for example "gains read-write on test-graph";
   - marks a graph whose own mode is read-only as "effective: read only (the graph is read-only)", because `scopedResolve` still caps it;
   - lists each loss;
   - says that editing does not rotate the token, and that a token which may have leaked should be revoked and re-issued instead;
   - re-posts the same fields as hidden inputs, plus `confirm=1`, `base` and the CSRF token.

   No sealing is needed. The confirming POST is checked for CSRF and re-runs steps 1 to 3 in full, and `update()`'s before-value guard makes a stale confirm fail closed. When `base` no longer matches the stored row, the confirm page is shown again with the current values and a line saying the token changed since the page was opened.

   A pure narrowing (graphs removed, write to read, a shorter expiry, or any mix of these) applies at once.
5. **Update.** `update(id, before, after, now)`. When it answers false, one `get(id)` says why: 409 revoked on YYYY-MM-DD, expired on YYYY-MM-DD, or `changed since you opened this page; reload and edit again.`
6. **Read back.** `get(id)`, compared with `readBackMismatch` (name, graphs in order, access, expiry). On a mismatch, revoke the token and answer 500 `<field>: the stored token did not match the form, so it was revoked. Issue a new token.` It revokes rather than deletes, so the token stays listed and the audit row still has something to name. There is no silent success.
7. **Audit.** `AuditLog.recordTokenEdit` (3.6).
8. **Done.** Redirect 303 to `/tokens` with `Cache-Control: no-store`.

### 3.6 The audit row

`AuditLog.recordTokenEdit({at, name, ownerId, before, after})` inserts one row in the existing table, with no new table and no migration:

| Column | Value |
|---|---|
| `graph_id` | NULL, so no `get_activity_log` call, under any token, ever returns it |
| `alias` | `service:<name>`, matching the client value service-token writes already record |
| `tool` | `token_edit` |
| `kind`, `status` | `write`, `ok` |
| `client` | `wizard` |
| `session` | `github:<owner id>` |
| `before` | `{"source":"service_tokens","data":{"before":{graphIds, access, expiresAt},"after":{…},"added":[…],"removed":[…]}}` |
| `targets`, `addressed`, `pages` | NULL |

The winning proposal put the after-values in `targets`. This design keeps them inside `before.data` instead **(call)**, because `targets` is parsed as `AffectedTarget[]` elsewhere and a differently shaped value there would be a trap for any future reader that does not filter by graph. The row holds no token and no hash. It is subject to the normal audit purge (`AUDIT_RETENTION_DAYS`); `updated_at` on the token row is the durable last-changed record (section 11, question 3).

### 3.7 Views

`tokenSection` gains:
- an **Edit** link to `/tokens/:id/edit`, shown only for active tokens (the same `tokenStatus` the page already computes);
- a `Last changed` line: `updated_at` in UTC, or "never".

### 3.8 Docs

- README §11.12 gains a step between "Use it" and "Revoke": editing a token, the widening confirm, expiry only shortens, editing does not rotate the secret (revoke and re-issue if it may have leaked), scope changes apply to running sessions on their next call, and the cost.
- README §11.10's row for `graph 'x' is read-only (service token 'y' is read-only)` changes from "create a read-write token" to "edit the token to read-write at `/tokens` (11.12)". The row for an out-of-scope graph gains the same hint.
- The service-token design gets a short addendum pointing here.
- REVIEW.md *Security* and *Cost* are read against the diff; no new line is expected, because scope still lives only in `scopedResolve`.
- `connector_help`, tool descriptions and `tools-manifest.json` are unchanged.

## 4. Tool contract

No MCP tool is added, removed or renamed, and `tools-manifest.json` and `connector_help` are unchanged. What a tool sees under a service token can now change between two calls in one session: a graph removed from the token is refused with the existing out-of-scope message, `graph '<alias>' is outside service token '<name>''s scope (it covers: …)`, and a token moved to read-only refuses writes with `graph '<alias>' is read-only (service token '<name>' is read-only)`.

New HTTP surface, wizard only (owner cookie session; the POST also needs CSRF). A bearer gets the existing redirect to `/login`.

- `GET /tokens/:id/edit`: 200 with the form; 404 `No service token has that id.`; 409 for revoked, expired or previous-owner, naming which and the date.
- `POST /tokens/:id/edit`, fields `graph` (repeated graph id), `access` (`read` or `write`), `expires_days` (optional; blank keeps the stored expiry), `csrf`, and on the confirm page only `confirm=1` and `base` (JSON of the stored before-values).
  - 303 to `/tokens` when applied, or when nothing changed.
  - 200 with the confirm page when the edit widens and is not yet confirmed, or when `base` is stale.
  - 400 naming the field: `graph: choose at least one graph.`, `graph: a chosen graph is not connected. Reload the page and choose again.`, `access: choose read-only or read-write.`, `expires_days: a whole number of days from 1 to 365.`, `expires_days: that would extend the expiry past YYYY-MM-DD. A token's expiry can only be shortened; issue a new token instead.`
  - 403 without a valid CSRF token.
  - 409 revoked, expired, previous owner, or `changed since you opened this page; reload and edit again.`
  - 500 when the read-back mismatches; the token is revoked and the message says so.
  - 503 when `audit_log` is missing; nothing is changed.

Internal: `ServiceTokenStore.update(id, before, after, now): Promise<boolean>`; `AuditLog.recordTokenEdit({at, name, ownerId, before, after}): Promise<number>` (the new row's id).

**Logseq skill note (PR body).** No tool changes. A cloud session's token can now be narrowed while the session runs, so a graph that worked earlier may start answering "outside service token's scope" or "read-only". The skill should report that refusal to the owner rather than retry.

## 5. Cost on the Free plan

Measured statement shapes from section 2, pinned in tests from `meta`.

Per service-token `/mcp` request (unchanged):

| Step | Rows read | Rows written |
|---|---|---|
| `findByHash` | 1 | 0 |
| Hourly `touch` | 1 | at most 1 per hour |

The new column has no index, so the lookup and the touch cost the same as before.

Per edit (owner only, rare), with N connected graphs:

| Step | Rows read | Rows written |
|---|---|---|
| Load the token (`get`) | 1 | 0 |
| `AuditLog.ready` (first time per isolate) | 0 | 0 |
| `GraphStore.list` | about N | 0 |
| Conditional `UPDATE` | 1 | 1 |
| Read-back `get` | 1 | 0 |
| Audit insert | 0 | 2 |
| **Applied edit** | **about 3 + N** | **3** |
| Widening, first POST (confirm page) | about 1 + N | 0 |
| Refusal | at most 1 + N (2 + N when the guard missed) | 0 |
| `GET /tokens/:id/edit` | about 1 + N | 0 |

`GET /tokens` is unchanged: about one row per token through the `name` index (20 rows read for 20 tokens, measured), because `updated_at` is on the same row.

Migration 0007 runs once: 22 rows read (schema) and 1 written, measured on an empty table.

Edits are manual owner actions, a few a month. Against 5M rows read and 100k written a day, the cost is negligible. No cron, Workers AI or Vectorize use, and the front Worker does no extra CPU-heavy work.

## 6. Safety

- **Owner only, CSRF on the write.** Both routes go through `withSession` and the POST through `withForm`. There is no MCP tool, and a bearer cannot reach the wizard.
- **Widening is explicit.** No gain applies without a confirm page that names it by alias, with the effective mode. The confirming POST is re-validated in full.
- **Expiry never grows.** Checked in the form parser and again in `update()`.
- **Dead tokens stay dead.** Revoked, expired and previous-owner tokens cannot be edited, and the `UPDATE`'s `revoked_at IS NULL AND expires_at > ?` conditions hold even if a check before it is removed.
- **No lost updates.** The before-value guard makes a race with another tab or a disconnect fail closed.
- **No silent success.** The row is read back and compared; a mismatch revokes the token.
- **No secret anywhere new.** `update()` takes no token and sets no hash, the audit row holds names and ids only, and tests scan every column of the audit row and the response bodies for the token and its hash.
- **The graph still caps the token.** `scopedResolve` is unchanged, so adding a read-only graph to a read-write token leaves that graph read-only.
- **Not a rotation.** The confirm page and README say to revoke and re-issue a token that may have leaked.

## 7. Risks

1. **Scope changes under a running cloud session.** A narrowed token starts refusing a graph mid-session. This is intended. The README says so, and the refusal still names the graph and the token.
2. **Widening a leaked secret.** Editing never rotates the token, so widening a leaked token widens the leak. The confirm page and README say to revoke and re-issue instead. A step-up re-sign-in before widening is a possible extra (section 11, question 4).
3. **Race with disconnect.** `revokeForGraph` can run between the owner's GET and POST, or between the POST's load and its `UPDATE`. The guard's `revoked_at IS NULL` and before-values make it fail closed (0 changes, reported as revoked), so it never revives a token or re-adds a disconnected graph. Test 8.11 covers it.
4. **Re-adding a reconnected graph.** A graph that was disconnected (revoking its tokens) and later reconnected can be added to a different, active token. That is a widening, shown on the confirm page, so the owner chooses it explicitly.
5. **JSON-text compare.** The guard compares `graph_ids` as text. A future writer that stored the array differently (spaces, another order) would make every edit of that row fail as "changed since" until reloaded. That fails closed, and both writers use `JSON.stringify`.
6. **Audit retention.** The before and after history is purged with the rest of `audit_log`. `updated_at` survives. A dedicated history table is the alternative (section 11, question 3).
7. **A cache added later.** If someone caches `ServiceProps` per isolate to save the 1-row read, a narrowed token would keep its old scope until the isolate dies. Test 8.1 fails in that case, and REVIEW.md's *Scope lives in one place* line already covers scope.
8. **Mutation survival.** Each rule (confirm on widen, expiry never extends, revoked and expired refused, CSRF, the before-value guard, read-back) needs its own test that fails when the rule is removed (`docs/solutions/testing/untested-rules-survive-mutation.md`).

## 8. Testing

All tests run in vitest-pool-workers against the real Worker (`createConnector().fetch` or `SELF.fetch`) and real D1 with migrations 0001 to 0007 applied. Each test is run first against the unchanged code, or with its rule removed, and seen to fail; the PR quotes the failures.

1. **Next-request effect.** Create a read-write token on graphs A and B through `POST /tokens/new`. A `/mcp` tool call on B succeeds. Edit the token to A only. The very next `/mcp` call on B is refused, naming B and the token. Edit write to read; the next write call on A is refused as read-only. This pins the absence of a scope cache.
2. **Widening needs confirmation.** Adding B without `confirm` answers 200 with the confirm page listing "gains … on B", and `get` shows the row unchanged. Re-posting with `confirm=1` and `base` applies it, and the next `/mcp` call on B succeeds. Read to write behaves the same way. A swap (remove A, add B) is treated as widening.
3. **Stale confirm.** Change the row between the confirm page and the confirming POST: the confirm page is shown again with a "changed since" line and nothing is written.
4. **Narrowing applies at once.** Removing a graph, or write to read, answers 303 in one POST.
5. **Expiry.** A shorter expiry applies. An extension answers 400 with the `expires_days` message and the row is unchanged. Blank keeps the stored expiry. Remove the parser check and the `update()` assertion still refuses.
6. **Refusals.** Each asserts the message, an unchanged row and no audit row: unknown id 404; revoked 409; expired 409; previous owner 409; an empty graph list; a graph id that is not connected; a bad access value; a missing CSRF token (403); `audit_log` missing (503).
7. **Owner only.** No session redirects to `/login`. An `lsct_` bearer with no cookie gets the same redirect. The tools manifest is unchanged (no token tool).
8. **Token unchanged.** The same `lsct_` string still authenticates after an edit, and a raw `SELECT token_hash` shows the hash unchanged.
9. **Graph mode still caps.** A read-write token edited to add a read-only graph still cannot write to it.
10. **Audit row.** Exactly one row with `tool = 'token_edit'`, `graph_id` NULL, `alias = 'service:<name>'`, `client = 'wizard'`, and the before and after values in `before.data`. A regex over every column finds neither the token nor its hash. `get_activity_log` for graph A does not return it.
11. **Race with disconnect.** Disconnect B (which runs `revokeForGraph`) between the GET and the POST: the POST answers 409 revoked and the token stays revoked with its old graphs.
12. **Last changed.** `/tokens` shows "never" before an edit and the edit's time after it, and the Edit link appears only on active tokens.
13. **Cost pins.** From `meta`: `update()` reads 1 and writes 1; a guard miss reads 1 and writes 0; the audit insert writes 2; `findByHash` still reads 1 and writes 0 after migration 0007.
14. **Read-back mismatch.** A unit test of the route helper with a stubbed `get` that returns a different row: the token is revoked and the answer is 500 naming the field.
15. **Migration 0007.** It applies after 0006, `updated_at` exists and is NULL on existing rows, and their other values are unchanged.

**Gate.** `scripts/check.sh` on HEAD, without `--upstream` since no patch changes. The manifest check must pass unchanged.

## 9. Rollout and verification

1. Merge to main. Deploy applies migration 0007, which only adds a nullable column.
2. At `https://mcp.example.com/tokens`, check every existing token shows "Last changed: never" and an Edit link if active.
3. Edit the cloud-session token to add the test graph. Check the confirm page names "gains … on <test graph>" with the right effective mode, then confirm.
4. In a running cloud session, without changing the secret, call `list_graphs`: the test graph appears. Make one call on it.
5. Remove the test graph again. The next call on it in the same session is refused as outside the token's scope.
6. Check one `token_edit` row per edit in D1 (`wrangler d1 execute … "SELECT tool, alias, client, before FROM audit_log WHERE tool = 'token_edit'"`), with no token in it.
7. Record in the PR the commit these checks ran on, and what `scripts/check.sh` skipped.

## 10. Out of scope

- Renaming a token. The name is in every `service:<name>` audit row, so a rename would split its history.
- Extending a token's expiry. Issue a new token instead.
- Editing revoked or expired tokens, or un-revoking.
- Rotating the token string in place.
- Token management over `/mcp` or any MCP tool.
- A dedicated token-history table (section 11, question 3).
- Any upstream patch.

## 11. Open questions for the owner

1. **Confirm on widening, or narrow-only?** This design lets the owner widen a token after a confirm page. The stricter choice is to allow only narrowing in place and require a new token for any widening, which is what you would have to do today. Confirm-on-widen solves your test-graph case without replacing the secret; narrow-only does not. Keep confirm-on-widen?
2. **Never extend expiry?** The design refuses any extension, so a token still has to be re-issued at least once a year (365 days at most). Allowing an extension up to 365 days from its creation date would be a middle way. Keep "shorten only"?
3. **History beyond audit retention.** The before and after values live in `audit_log` and are purged after `AUDIT_RETENTION_DAYS` (90 by default). `updated_at` keeps only the last time. Is that enough, or do you want a small `service_token_edits` table kept forever (a few rows a month)?
4. **Step-up before widening.** The wizard session lasts its normal lifetime. Should widening a token also require a sign-in within, say, the last 10 minutes, as GitHub does for sensitive settings? It adds a GitHub round trip to a rare action.
5. **Mixed edits.** A swap (remove one graph, add another) is treated as widening and needs the confirm. Should a confirm page also be shown for pure narrowing, so every scope change is reviewed the same way, or is applying narrowing at once right?
