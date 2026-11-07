# Service tokens for unattended cloud sessions: design

Date: 2026-11-07
Issue: service token for unattended cloud sessions (Phase 3 brief). Areas: connector, migrations, scripts, docs.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0034 applied. This work adds no patch.
Branch: stacked on Phase 3 (`claude/relaxed-maxwell-s4r8o4-phase3`), after item 28 (write audit log, migration 0004) and item 29 (edit stamps, patch 0034 and migration 0005). Neither is merged yet.

Decisions marked **(brief)** come from the brief. Decisions marked **(call)** were made while writing this design. Ideas taken from the design panel's other proposals are marked **(graft)**. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Claude Code cloud sessions and scheduled tasks have no browser, so they cannot complete the connector's OAuth consent flow. Give them a credential they can carry as an environment secret: scoped to named graphs and to read or read-write, revocable, expiring, and owned by the same single owner as every OAuth grant.

Acceptance (brief):

1. `/mcp` accepts a service token as a Bearer credential tied to the owner. D1 stores only its hash. The token is shown once, at creation.
2. A token is scoped to named graphs and to read-only or read-write. A read-only token cannot call any write tool.
3. A token has an expiry, a last-used time and a revoke path in the wizard. Managing tokens is owner-only, behind the existing sign-in and allow-list.
4. An expired or revoked token is refused with an error that names the reason and never echoes the token.
5. Writes made with a service token are audited (item 28) and stamped (item 29) like OAuth writes, with the client recorded as the token's name.
6. The hash compare is constant-time. No token appears in logs, errors or the audit log.
7. A service token cannot create, list or revoke tokens: there is no token management over `/mcp`.
8. Rate limits on service-token calls match OAuth.
9. D1 rows read and written per request are counted and kept minimal. Last-used updates are throttled.
10. Migration 0006 adds an index for the token-hash lookup, and is tested.
11. A checked-in `.mcp.json` reads the token from an environment variable, and `.claude/settings.json` gains `enabledMcpjsonServers` and `permissions.allow` for the connector's tools.
12. Docs cover adding the token as a cloud environment secret and allowing `mcp.example.com` in the network policy.
13. `scripts/logseq-mcp.mjs` calls a tool from bash, has `scripts/logseq-mcp.test.mjs`, and never prints the token.
14. Tool text, `connector_help`, `tools-manifest.json`, README §11.8 and the Logseq skill note change if tool behaviour changes.
15. Regression tests run the real handler and SQL and were seen to fail without the change. `scripts/check.sh` passes on HEAD.

## 2. Context

**The OAuth library already has a hook for other bearer tokens.** `@cloudflare/workers-oauth-provider` is pinned at 1.2.4 (`connector/package.json`). In `handleApiRequest` (`node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js:4464`) the provider looks a bearer up in `OAUTH_KV` only when it splits into three colon-separated parts. When no issued token matches and the bearer is not in the issued format (`isIssuedTokenFormat`, `:5322`), it calls the resource server's `resolveExternalToken({token, request, env})`. A `null` result becomes the generic 401 `Invalid access token`. A thrown `ExternalTokenError` (exported, `:5029`) becomes a structured 401 carrying our description. A returned `{audience, props}` must have an `audience` equal to the configured resource (`isExactResource`), and then `ctx.props = ext.props` and the request reaches `apiHandler`. The connector's `providerOptions` (`connector/src/index.ts:30`) does not set the hook today.

I checked this with a throwaway test (now deleted) that built `new OAuthProvider({...providerOptions("mcp.example.com", …), resolveExternalToken, apiHandler: echo-props})` in the connector's vitest pool and sent four bearers:

```
lsct_okAAAA  200 null {"props":{"kind":"service","name":"ci"}}
lsct_revBBBB 401 "Bearer realm=\"OAuth\", resource_metadata=\"https://mcp.example.com/.well-known/oauth-protected-resource/mcp\", error=\"invalid_token\"" {"error":"invalid_token","error_description":"service token 'ci' was revoked"}
lsct_unkCCC  401 (same header) {"error":"invalid_token","error_description":"Invalid access token"}
a:b:c        401 (same header) {"error":"invalid_token","error_description":"Invalid access token"}
resolver saw lsct_okA,lsct_rev,lsct_unk,a:b:c
```

Two things follow. The reason travels in the JSON body's `error_description`, not in `WWW-Authenticate`, so tests assert on the body. And `a:b:c` reached the resolver too, because it fails the issued-format check after the KV miss; the resolver must refuse anything that is not a service token by shape, which it does (3.2).

**One place resolves every graph.** `isolateTools` (`connector/src/mcp.ts:44`) builds one `GraphAccess` per isolate, `{env, resolve: (alias) => store.resolve(alias)}`, and builds the OpenAPI tools around it once (`buildGraphTools(spec, access)`). Every graph-addressed tool reaches a graph through `lookupGraph` or `resolveGraph` (`connector/src/tools/common.ts:113-139`), which call `access.resolve`: the generated tools (`semantic.ts:159`, write when `method !== "GET"`), the asset tools (`assets.ts:223,310,346`), `kb_index`, `semantic_search`, `get_activity_log`, the audit wrapper (`audit/log.ts:599-601`) and the snapshot reader (`audit/snapshot.ts:228`). The only tool that reads graphs another way is `list_graphs` (`handwritten.ts:68`, `store.list()`). The kb-index cron also calls `store.list()` (`kb-index.ts:231`), but it runs outside any request.

**Request-scoped state already uses AsyncLocalStorage.** `common.ts` keeps `callGraphs` in an `AsyncLocalStorage` so the audit wrapper and the handler share one D1 read per call. Whether a store set around the whole MCP handler is visible inside a tool callback depends on the `agents` (0.32.0) stateless handler and the MCP SDK (`@modelcontextprotocol/server` 2.4.0). I checked it with a throwaway test (now deleted): a tool registered on a fresh `McpServer` behind `createMcpHandler`, called with `als.run("scoped", () => handler(req, env, ctx))`, answered `store=scoped`. So the store reaches the callback on these versions. Risk 2 covers a future version that breaks this.

**The owner check runs on every request.** `mcpApiHandler` (`mcp.ts:125`) answers 403 `Forbidden` unless `isOwner(props.githubUserId, env)`, so changing `OWNER_GITHUB_USER_ID` revokes every OAuth grant at once.

**Audit and stamps.** `audited()` (`audit/log.ts`) records `client` and `session` from the `Caller` that `mcpHandler` receives (`callerOf`: the User-Agent family and `mcp-session-id`). `audit_log.client` is free `TEXT`. Refusals from `lookupGraph` and `resolveGraph` are caught and stored; a `ToolError` whose status is in `REFUSALS` (`refused`, `unknown-graph`, `read-only`, `audit/log.ts:477`) is stored as `refused`, anything else as `error`. Edit stamps come from `editStampHeaders` on the resolved graph (item 29), so they need nothing from the caller.

**Rate limits.** The connector has no limiter of its own (`grep -rni ratelimit connector/src` finds only the 429 mapping in `semantic.ts:117` and the wizard). Both OAuth and service-token calls reach the sync server with the graph's PAT, which the sync server limits to 120 reads and 20 writes per minute. So the limits match by construction.

**Constant-time compare.** `auth/session.ts:75` has a private `timingSafeEqual(a, b)` over `crypto.subtle.timingSafeEqual`.

**D1 cost of the statements this design uses.** Measured in the connector's vitest pool (real D1 in workerd) with a throwaway test (now deleted), on a table shaped like `service_tokens` (TEXT primary key, unique `name`, unique index on `token_hash`) holding 20 rows:

```
insert w=4 r=0
select-hit r=1 n=1
select-miss r=0
touch w=1 r=1
touch-noop w=0 r=1
revoke w=1 r=1
list r=40 n=20          (ORDER BY created_at, which sorts in a temp b-tree)
graph_ids '{}' refused: CHECK constraint failed: json_valid(graph_ids) AND json_type(graph_ids) = 'array'
access 'admin' refused: CHECK constraint failed: access = 'read' OR access = 'write'
```

An insert writes 4 rows (the row and three index entries), not 2. A lookup by the unique hash reads 1 row on a hit and 0 on a miss. The conditional touch reads 1 row whether or not it writes. A listing ordered by an unindexed column reads twice the rows, so the wizard lists `ORDER BY name`, which the unique index on `name` serves (section 5).

**Learnings that shape this design.**

- REVIEW.md *Cost*, *Security*, *Contract and docs*, *Gates and tests*.
- `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md` and the comment in `0004_audit_log.sql`: an `IN (...)` list of three or more values makes D1 bill an extra row; CHECKs use OR chains.
- `docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`: the audit wrapper's checks run in the same order as the handler's, so a refusal reads the same in both.
- `docs/solutions/api/authorship-stamps-ride-the-write-transaction.md`: stamps are applied by the server from the header, so a new caller kind needs no stamp change.
- `docs/solutions/testing/untested-rules-survive-mutation.md`: each rule (shape, hash match, revoked, expired, owner, scope, read-only, throttle) gets a test that fails when the rule is removed.

## 3. Design

**Approach (call).** Everything lives in the connector, with no patch. It reuses three things that exist: the OAuth library's `resolveExternalToken` hook, the single place where every tool resolves a graph, and the wizard's owner session and CSRF scaffolding. A service token is one more way to arrive at `mcpApiHandler` with `ctx.props`; from there it is the same request path as OAuth, with a scope applied at graph resolution.

Rejected:

- **A second auth path in front of the provider** (route `Bearer lsct_…` in `index.ts` before `OAuthProvider.fetch`). It would have to reproduce the provider's 401 shape, `WWW-Authenticate`, CORS and audience rules by hand and catch every `/mcp` path variant; a miss falls through to a bare OAuth 401 with the reason lost. The hook gives all of this for free.
- **Looking the token up by a public id on the primary key, then comparing the hash.** Equally cheap (1 row read), and it lets the refusal order be "id, then hash". But the brief asks for an index on the hash, and with 256 random bits behind the hash, the timing of SQLite's index compare reveals nothing useful. Section 6 pins the order that matters instead: no reason is given until the hash has matched.
- **A per-request `GraphAccess`.** The generated tools are built once per isolate around the isolate's `access` (`mcp.ts:51`). A per-request access would mean rebuilding them from the OpenAPI spec on every request, against the 10 ms CPU budget, or changing `buildGraphTools` to take access per call. The request-scoped store in `common.ts` reaches the same place without either.

### 3.1 Layout

| Path | Change |
|---|---|
| `connector/migrations/0006_service_tokens.sql` | New `service_tokens` table and unique index on `token_hash` (3.6). |
| `connector/src/auth/service-tokens.ts` (new) | `TOKEN_PATTERN`, `generateServiceToken`, `hashServiceToken`, `verifyServiceToken`, and `ServiceTokenStore` (`list`, `create`, `get`, `revoke`, `touch`). |
| `connector/src/crypto.ts` | `timingSafeEqual(a, b)` moves here from `auth/session.ts`, which imports it (one copy). |
| `connector/src/index.ts` | `resolveExternalToken` in `providerOptions`. |
| `connector/src/mcp.ts` | `ServiceProps` beside `GrantProps`; the `kind === "service"` branch in `mcpApiHandler`; `mcpHandler` takes an optional scope and runs the handler inside `requestScope.run`; the scoped `resolve` in `isolateTools`. |
| `connector/src/tools/common.ts` | `requestScope` AsyncLocalStorage, `scopedResolve`, the `out-of-scope` refusal, and the read-only message naming the token. |
| `connector/src/graphs.ts` | Optional `readOnlyBy` on `ResolvedGraph`. |
| `connector/src/audit/log.ts` | `out-of-scope` added to `REFUSALS`. |
| `connector/src/tools/handwritten.ts` | `list_graphs` filtered by scope and showing the effective mode; one `connector_help` sentence. |
| `connector/src/wizard/routes.ts`, `views.ts` | `/tokens`, `/tokens/new`, `/tokens/:id/revoke`; a link from the graph list. |
| `connector/test/service-tokens.test.ts` (new), `wizard.test.ts`, `graphs.test.ts` | Section 8. |
| `.mcp.json` (new), `.claude/settings.json` | 3.8. |
| `scripts/logseq-mcp.mjs`, `scripts/logseq-mcp.test.mjs` (new) | 3.9. |
| README (new section, §11.6, §11.8, §11.9) | 3.10. |

### 3.2 The token and its verification

**Format (call).** `lsct_` followed by the base64url encoding of 32 random bytes from `crypto.getRandomValues`: 48 characters, matching `TOKEN_PATTERN = /^lsct_[A-Za-z0-9_-]{43}$/`. It has no colon, so the provider never looks it up in KV. The prefix makes it recognisable to secret scanners and in a pasted environment.

**Hash (call).** SHA-256 of the whole token, as lower-case hex. A slow hash adds nothing for a 256-bit random secret and would cost CPU on every request.

**`verifyServiceToken(env, token)`**, in this order:

1. **Shape (graft).** If `token` does not match `TOKEN_PATTERN`, return `null` (generic 401) without touching D1. A malformed or OAuth-looking bearer costs 0 rows.
2. **Hash and lookup.** `SELECT id, name, token_hash, owner_id, graph_ids, access, expires_at, last_used_at, revoked_at FROM service_tokens WHERE token_hash = ?`. No row: return `null` (generic 401).
3. **Constant-time compare.** `timingSafeEqual(row.token_hash, computed)`; on a mismatch return `null`. This is belt and braces over the index lookup, and it keeps the rule visible and testable.
4. **Reasons, only after the hash matched (graft).** Because the row was found by the full hash, only the holder of the real token can learn a reason. In order:
   - `revoked_at` set: throw `ExternalTokenError("invalid_token", {description: "service token '<name>' was revoked", statusCode: 401})`;
   - `expires_at <= now`: `"service token '<name>' expired on YYYY-MM-DD"` (UTC date);
   - `owner_id` is not the current owner (`isOwner(row.owner_id, env)`): `"service token '<name>' belongs to a previous owner"`. This names the reason that `mcpApiHandler`'s bare 403 does not.
   The description never contains the token or its hash.
5. Return `{audience: "https://<host>/mcp", props: {kind: "service", tokenId, name, githubUserId: owner_id, graphIds, access, lastUsedAt}}`.

`mcpApiHandler` keeps `isOwner(props.githubUserId, env)` for both kinds, as a backstop.

**Logging.** `onError` already logs only `oauth error <status> <code>`. `verifyServiceToken` logs nothing on the success path and never the token, the hash or the description's name on failure. A D1 error inside the hook propagates as an unexpected error (the provider rethrows anything that is not an `ExternalTokenError`), which the runtime answers 500; the test in section 8 asserts that the token is not in that output either.

### 3.3 The caller and the scope

In `mcpApiHandler`, when `props.kind === "service"`:

- the caller becomes `{client: "service:<name>", session: request.headers.get("mcp-session-id")}`;
- the scope `{name, graphIds: new Set(graphIds), access}` is passed to `mcpHandler`, which runs the stateless handler inside `requestScope.run(scope, …)`;
- `ctx.waitUntil(touch(...))` runs the throttled last-used update (3.5).

OAuth requests are unchanged: no scope, and `callerOf(request)` as today.

**Enforced once, at `access.resolve` (call).** In `isolateTools`, `resolve` becomes `scopedResolve(store, alias)`:

1. Read `requestScope.getStore()`. When it is undefined and the current request is a service request, throw (fail closed, risk 2). The request kind is carried in the same store as a `{kind: "oauth"}` or `{kind: "service", …}` value, so "unset" can only mean the store did not reach the callback, never "OAuth".
2. `graph = await store.resolve(alias)`. Null stays null (unknown alias).
3. If the scope is a service scope and `graph.graphId` is not in `graphIds`, throw `ToolError("graph '<alias>' is outside service token '<name>''s scope (it covers: <aliases>)", "out-of-scope")`. Scope is held by `graph_id`, so renaming an alias in the wizard keeps the token's scope. The covered aliases (graft) are read only on this refusal path, with one `SELECT alias FROM graphs WHERE graph_id IN (…)` ordered by alias.
4. If the token is read-only, return `{...graph, mode: "read", readOnlyBy: "service token '<name>'"}`. The effective mode is the lower of the graph's and the token's (graft): a read-write token on a graph connected read-only stays read-only, and a read-only token never upgrades anything.

`resolveGraph`'s write check then refuses with `graph '<alias>' is read-only (service token '<name>' is read-only)` when `readOnlyBy` is set, and with the existing `graph '<alias>' is read-only` otherwise. Every write, move, delete and asset-save tool goes through `resolveGraph(…, true)` before anything reaches the sync server, and the audit wrapper's pre-checks run the same `lookupGraph` and `resolveGraph`, so the refusal is stored as `refused` with client `service:<name>`. `out-of-scope` joins `REFUSALS` for that.

**`list_graphs`** filters `store.list()` to `graphIds` when a service scope is set, and shows the effective mode. It reads the same rows as today.

**Read-only tools stay listed (call).** The panel's cost proposal hid write tools from `tools/list` for a read-only token, which would save tool-definition tokens per session. It is not in this version: a hidden tool answers with the SDK's unknown-tool error, which is not audited and does not say why, and it relies on every tool's `readOnlyHint` being right as a second copy of the rule. Section 11 asks the owner.

### 3.4 Audit and stamps

Writes go through the same `audited()` and `graphFetch` paths. `audit_log.client` records `service:<name>`; the column is free `TEXT`, so no migration is needed. `get_activity_log` shows the client value as stored; its formatting is checked for the new value (section 8). Edit stamps ride `editStampHeaders` unchanged, so `editedBy=claude` and `claudeEditedAt` apply to service-token writes as to OAuth writes. The token's name is recorded in the audit log, not in the stamp.

### 3.5 Last-used time

The verify read returns `last_used_at`. Only when it is null or more than 1 hour old does `mcpApiHandler` call `ctx.waitUntil(store.touch(id, now))`, which runs `UPDATE service_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`. That is at most one write per token per hour; two isolates racing in the same hour write once, because the second UPDATE's condition fails. A failure is logged as `service-token-touch-failed id=<id>`, never with the token, and never reaches the tool result.

### 3.6 Migration 0006

```sql
CREATE TABLE service_tokens (
  id TEXT PRIMARY KEY,                       -- random, shown in the wizard and revoke URL; not a secret
  name TEXT NOT NULL UNIQUE,                 -- [a-z0-9-]{1,40}, checked by the wizard
  token_hash TEXT NOT NULL,                  -- SHA-256 hex of the token; the token itself is never stored
  owner_id INTEGER NOT NULL,
  graph_ids TEXT NOT NULL CHECK(json_valid(graph_ids) AND json_type(graph_ids) = 'array'),
  access TEXT NOT NULL CHECK(access = 'read' OR access = 'write'),
  created_at INTEGER NOT NULL,               -- ms since the epoch
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX service_tokens_hash ON service_tokens(token_hash);
```

The CHECKs use OR chains, not `IN`, following the 0004 lesson. There is no trigger and no backfill. The header comment states the measured costs from section 2, as 0004 and 0005 do.

### 3.7 The wizard

The wizard is cookie-session only (`withSession`, `withForm` with CSRF), so a bearer token can never reach it, and no MCP tool manages tokens.

- `GET /tokens`: name, graphs (by current alias), access, expiry, last used and status (active, expired, revoked), ordered by name. Linked from the graph list page.
- `GET /tokens/new`: a form with `name`, a checkbox per graph from `store.list()` showing each graph's mode, `access` defaulting to read-only (graft), and `expires_days` (default 90).
- `POST /tokens/new`: validates every field up front and refuses the whole form naming the field (`name: already in use`, `graph: at least one`, `expires_days: 1 to 365`). It generates the token, inserts the row, reads it back by id and compares the stored name, graph ids, access and expiry with what was submitted (graft); on a mismatch it deletes the row and refuses. It then answers one page with `Cache-Control: no-store` that shows the token once, with a copy button and the instruction to store it as `LOGSEQ_SERVICE_TOKEN`. The token is never put in a URL, cookie or log.
- `POST /tokens/:id/revoke`: sets `revoked_at` (`AND revoked_at IS NULL`), then redirects to `/tokens`.

Revoked and expired rows stay listed so the owner can see what existed; deleting rows is out of scope (section 10).

### 3.8 Claude Code wiring

`.mcp.json` (new, checked in, no secret):

```json
{
  "mcpServers": {
    "logseq-service": {
      "type": "http",
      "url": "https://${LOGSEQ_MCP_HOST:-mcp.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${LOGSEQ_SERVICE_TOKEN}" }
    }
  }
}
```

`.claude/settings.json` gains `"enabledMcpjsonServers": ["logseq-service"]` and a `permissions.allow` entry `mcp__logseq-service__<tool>` for each read tool already allowed as `mcp__Logseq__<tool>`. Write tools still prompt.

### 3.9 CLI fallback

`scripts/logseq-mcp.mjs <tool> ['<json args>']` is a Node 20 script with no dependencies, for sessions where the MCP server is not loaded. It reads `LOGSEQ_SERVICE_TOKEN` and `LOGSEQ_MCP_URL` (default `https://mcp.example.com/mcp`), sends `initialize` then `tools/call` (passing back `mcp-session-id` when the server sets one, and parsing a JSON or SSE response), and prints the tool's text content. It exits 1 on an HTTP error, a JSON-RPC error or a tool result with `isError`, printing the status and the server's message. Every line it prints goes through one `redact()` that replaces the token's value with `lsct_…`. It never takes the token as an argument, so it never appears in `ps`.

### 3.10 Docs

- README: a new section "Service tokens for cloud sessions" in §11: create a token in the wizard; add `LOGSEQ_SERVICE_TOKEN` (and `LOGSEQ_MCP_HOST` when not `mcp.example.com`) as a cloud environment secret; allow `mcp.example.com` in the environment's network policy; how `.mcp.json` picks them up; the CLI fallback; revoke and expiry.
- README §11.6: one line pointing unattended sessions and scheduled tasks at the new section.
- README §11.8 and `connector_help`: one sentence (section 4).
- README §11.9 (security model): service tokens are hashed, scoped, expiring and owner-bound, and cannot manage tokens.
- `tools-manifest.json` is unchanged; `check-tools-manifest` confirms it.

## 4. Tool contract

No MCP tool is added, removed or renamed, and `tools-manifest.json` is unchanged. Behaviour changes only under a service token:

- `list_graphs` returns only the graphs in the token's scope, with the effective mode.
- Any tool given an alias outside the scope fails with `graph '<alias>' is outside service token '<name>''s scope (it covers: work, notes)` (status `out-of-scope`, audited as `refused` for writes).
- Every write, move, delete or asset-save tool on a read-only token fails with `graph '<alias>' is read-only (service token '<name>' is read-only)` before any sync call.
- A revoked, expired or previous-owner token gets HTTP 401 `invalid_token` with `error_description` `service token '<name>' was revoked`, `… expired on YYYY-MM-DD` or `… belongs to a previous owner`. An unknown or malformed token gets the generic `Invalid access token`.

`connector_help` and README §11.8 gain: "Under a service token, `list_graphs` shows only the token's graphs, other aliases are refused as outside its scope, and a read-only token refuses every write."

**Logseq skill note (PR body).** Cloud sessions and scheduled tasks reach the connector as `mcp__logseq-service__*` rather than `mcp__Logseq__*`; the tools and arguments are the same. A read-only token's write refusal names the token, so the skill should report it rather than retry.

New HTTP surface, wizard only (owner cookie session and CSRF): `GET /tokens`, `GET` and `POST /tokens/new` (fields `name`, repeated `graph`, `access`, `expires_days`, `csrf`), `POST /tokens/:id/revoke`.

CLI: `node scripts/logseq-mcp.mjs <tool> ['<json args>']`, env `LOGSEQ_SERVICE_TOKEN` and `LOGSEQ_MCP_URL`.

## 5. Cost on the Free plan

Per service-token MCP request (measured shapes from section 2):

| Step | Rows read | Rows written |
|---|---|---|
| Malformed bearer (shape check) | 0 | 0 |
| Verify, unknown token | 0 | 0 |
| Verify, known token | 1 | 0 |
| Touch, when last use is over an hour old | 1 | 1 |
| Scope check | 0 (uses the graph row `resolve` already reads) | 0 |
| Out-of-scope refusal only | the graphs in scope (a handful) | 0 |
| `list_graphs` | as today | 0 |
| Audit per write call | as today (item 28) | as today |

The OAuth path is unchanged (KV, no D1). For 2,000 cloud-session requests a day on one token: about 2,000 rows read and 24 rows written, against 5M and 100k. Workers requests are unchanged, one per MCP POST. A SHA-256 of a 48-character string is far under the 10 ms CPU budget.

Wizard (owner only, rare): the token list reads about one row per token through the `name` index; creating writes 4 rows plus a 1-row read-back; revoking reads 1 and writes 1.

No cron, Workers AI or Vectorize use. The usage report needs no new section: the table is a few rows.

## 6. Safety

- **One auth path.** Service tokens enter through the provider's own hook, so its 401 shape, audience check and CORS apply.
- **No reason without the secret.** A reason is given only after the full hash matched a row; a wrong token of the right shape gets the generic 401, even when it guesses a revoked token's name. A test pins this order.
- **Owner-bound twice.** The verify step refuses a token whose `owner_id` is not the current owner, and `mcpApiHandler` still checks `isOwner`.
- **Scope fails closed.** A service request whose scope is not visible inside `resolve` throws rather than running unscoped.
- **Least privilege by default.** The wizard defaults to read-only and 90 days, caps expiry at 365 days, and a token can never raise a graph's own mode.
- **No token at rest or in output.** D1 holds only the hash. Tests scan response bodies, headers, captured console output and every `audit_log` and `service_tokens` column for the token string.
- **No management over `/mcp`.** Token routes are cookie-only; the MCP server registers no token tool.

## 7. Risks

1. **The hook's contract.** A future `workers-oauth-provider` that changes `isIssuedTokenFormat` or the hook would make service tokens fail closed (every call 401). The version is pinned at 1.2.4, and the integration tests go through the real `createConnector().fetch`, so a bump that breaks it fails CI.
2. **AsyncLocalStorage reach.** Scope depends on tool callbacks running inside `requestScope.run`. It does on `agents` 0.32.0 and `@modelcontextprotocol/server` 2.4.0 (section 2). If a later version dispatched outside the request's context, the fail-closed check (3.3) refuses every service call instead of running unscoped, and the out-of-scope test through the real handler fails.
3. **A future tool that bypasses `resolveGraph`.** A tool reading `store.list()` or `store.resolve()` directly would escape the scope. The test that walks every registered tool with `readOnlyHint: false` under a read-only token, and every graph tool with an out-of-scope alias, covers new tools automatically. REVIEW.md gains a line under *Security*.
4. **Server naming and an unset token.** `.mcp.json` adds `logseq-service` to every session in this repo. A local interactive session without `LOGSEQ_SERVICE_TOKEN` shows a failed MCP server (a 401 for `Bearer ` with an empty value). The README says so; if it is noisy, `enabledMcpjsonServers` can move into the cloud environment's settings (section 11).
5. **Show-once page.** The token page is `no-store`, but a screenshot or a browser restored from memory can still hold it. The page says so; revoking is one click.
6. **Audit client values.** `client` was `claude-ai`, `claude-code` or `other`; it can now also be `service:<name>`. `get_activity_log` prints it as stored, and section 8 checks its output.
7. **Items 28 and 29 are unmerged.** If either is reworked before merge, re-check the caller, `REFUSALS` and stamp wiring.

## 8. Testing

All connector tests run in vitest-pool-workers with the real migrations (`test/apply-migrations.ts`) and real D1. Each rule test is seen to fail first by removing that rule (the shape check, the hash compare, the revoked branch, the expired branch, the owner branch, the scope check, the mode coercion, the throttle), and the PR quotes the failures.

`test/service-tokens.test.ts`, through the real `createConnector().fetch`, so the provider and the hook run for real:

- A valid read-write token reaches `/mcp` `tools/list`.
- An unknown token of the right shape and a malformed bearer each get the generic 401; the malformed one reads 0 D1 rows.
- Revoked, expired and previous-owner tokens each get 401 with the reason and name in the body's `error_description`; the token string is absent from the body, the headers and captured console output.
- A wrong token of the right shape, sent while a revoked token exists, gets the generic 401, not the revoked reason (order pin).
- A read-only token calling each registered tool whose `readOnlyHint` is false, with a stubbed sync fetch that counts calls, gets the read-only refusal naming the token, makes zero sync calls, and leaves an audit row with `status = 'refused'` and `client = 'service:<name>'`.
- An alias outside the scope gets the out-of-scope refusal naming the covered aliases, for a read tool and a write tool.
- A read-write token on a graph connected read-only is refused as read-only (effective mode).
- `list_graphs` returns only scoped graphs.
- A read-write token's write reaches the sync stub with the `x-logseq-edit-stamp` header, and its audit row records `client = 'service:<name>'`.
- `last_used_at` is written on the first request and not again within the hour, and is written again after it (fake clock).
- A D1 failure inside verify: the token is absent from the response and console output.
- Cost pins: verify reads 1 row and writes 0 (`meta`); create writes 4.
- `get_activity_log` shows a `service:<name>` client.

Migration test (in `graphs.test.ts` or a new block): 0006 applies after 0005; `PRAGMA index_list(service_tokens)` shows the unique hash index; the `access`, `graph_ids` and `expires_at` CHECKs refuse bad values.

`test/wizard.test.ts`:

- `/tokens` without a session redirects to `/login`; with only a service-token bearer and no cookie, it also redirects.
- A POST without CSRF gets 403.
- Create stores only the hash: no column of the row contains the token; the response contains it exactly once and has `Cache-Control: no-store`.
- Create refuses a duplicate name, no graphs, and `expires_days` of 0 and 366, naming the field.
- The form defaults to read-only.
- Revoke sets `revoked_at`, and the token then gets the revoked 401.

`scripts/logseq-mcp.test.mjs` (node:test with a local `node:http` stub MCP server): calls a tool and prints its text; sends `Authorization: Bearer <token>`; handles JSON and SSE responses and `mcp-session-id`; exits non-zero on 401, a JSON-RPC error and a tool error; the token never appears in stdout or stderr in any case.

Finally, `scripts/check.sh` runs on HEAD; the manifest check passes unchanged.

## 9. Rollout and verification

1. Merge with items 28 and 29 (the stacked Phase 3 PR). Deploy runs migration 0006; it adds an empty table and touches nothing else.
2. In the wizard, create a read-only token for one graph, 30 days. Add it to a cloud environment as `LOGSEQ_SERVICE_TOKEN`, allow `mcp.example.com` in its network policy.
3. In a cloud session: `/mcp` shows `logseq-service` connected; `list_graphs` shows the one graph; a write tool is refused naming the token; `node scripts/logseq-mcp.mjs list_graphs` prints the same list.
4. Create a read-write token, run one write from a scheduled task, and check `get_activity_log` shows `service:<name>` and the block carries `editedBy`.
5. Revoke both and confirm the 401 names the reason.
6. Record the commit these ran on, and what `scripts/check.sh` skipped, in the PR.

## 10. Out of scope

- Deleting token rows (revoke is enough; a handful of rows costs nothing).
- Per-token rate limits or quotas beyond the sync server's.
- Token rotation in place (create a new token, then revoke the old one).
- Hiding write tools from `tools/list` for read-only tokens (section 11).
- Per-tool scopes finer than read or read-write.
- Any upstream patch.

## 11. Open questions for the owner

1. **Hide write tools for read-only tokens?** It would cut the tool definitions a read-only session pays for, at the cost of an unaudited unknown-tool error that does not say why. This design keeps them listed and refuses with a reason. Worth adding later as an optimisation on top of the refusal?
2. **Default and maximum expiry.** 90 days by default, 365 at most. Shorter for read-write tokens (for example 30 days)?
3. **`.mcp.json` in every session.** Checking it in means local sessions in this repo without the variable show a failed `logseq-service` server. Keep it in the repo, or put `enabledMcpjsonServers` only in the cloud environment's settings?
4. **Out-of-scope message.** It lists the aliases the token covers, which helps Claude correct itself but tells it the names of other graphs in scope. Keep, or just say "outside its scope"?
5. **Token name in stamps.** The audit log records `service:<name>`; the graph's `editedBy` stays `claude`. Should a service write stamp a distinct value (for example `claude-service`) so the app can tell scheduled edits apart? That would need a change to patch 0034.
