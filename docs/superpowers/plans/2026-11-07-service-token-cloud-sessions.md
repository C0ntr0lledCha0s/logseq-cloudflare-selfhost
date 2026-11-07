# Service tokens for unattended cloud sessions: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code cloud sessions and scheduled tasks reach the connector's `/mcp` with a service token: an `lsct_` bearer the owner creates in the wizard, stored only as a SHA-256 hash in D1, scoped to named graphs and to read-only or read-write, expiring, revocable and bound to the current owner. Its writes are audited with client `service:<name>` and stamped like OAuth writes. A checked-in `.mcp.json` and a dependency-free CLI let a session use it.

**Architecture:**
- **Connector only.** No patch (spec §3, *Approach*). `scripts/check.sh` runs without `--upstream` in every stage.
- **One auth path.** Tokens enter through `@cloudflare/workers-oauth-provider`'s `resolveExternalToken` hook (1.2.4, pinned), so the provider's 401 shape, audience check and CORS apply. `mcpApiHandler` gains a `kind === "service"` branch beside OAuth's.
- **Scope at one place.** Every graph-addressed tool reaches a graph through `access.resolve`. A request-scoped `AsyncLocalStorage` (`requestScope` in `connector/src/tools/common.ts`) carries `{kind: "oauth"}` or `{kind: "service", …}`, and the isolate's `resolve` becomes `scopedResolve`, which refuses out-of-scope graphs and lowers the effective mode for a read-only token. `list_graphs` filters by the same scope.
- **Order:** storage first (nothing reads it), then the scope (testable by passing a scope straight to `mcpHandler`, while nothing in production sets one), then the hook that accepts tokens (so a token is never accepted before its scope is enforced), then the wizard that creates them, then the Claude Code wiring and CLI. Every stage leaves OAuth working and the gate green.

**Tech stack:** TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1 in workerd, migrations applied by `connector/test/apply-migrations.ts`, the `SYNC` binding faked at HTTP level as `tools.test.ts` does, the provider run for real through `createConnector().fetch`); Node `node:test` for `scripts/`.

**Spec:** `docs/superpowers/specs/2026-11-07-service-token-cloud-sessions-design.md`. Read it first. It is the authority; section numbers below (§3.3 and so on) are the spec's.

## Global constraints

- **Names, exactly:**
  - migration `connector/migrations/0006_service_tokens.sql`, table `service_tokens`, unique index `service_tokens_hash` on `(token_hash)`, columns and CHECKs as §3.6 (OR chains, never `IN`);
  - `connector/src/auth/service-tokens.ts` exports `TOKEN_PATTERN = /^lsct_[A-Za-z0-9_-]{43}$/`, `generateServiceToken()`, `hashServiceToken(token)` (SHA-256, lower-case hex), `verifyServiceToken(env, token, now)`, `ServiceTokenStore` (`list`, `create`, `get`, `revoke`, `touch`), `TOUCH_INTERVAL_MS = 3_600_000`, `MAX_EXPIRY_DAYS = 365`, `DEFAULT_EXPIRY_DAYS = 90`;
  - `connector/src/crypto.ts` exports `timingSafeEqual(a, b)`; `auth/session.ts` imports it (one copy);
  - `connector/src/tools/common.ts` exports `requestScope`, `RequestScope` (`{kind: "oauth"} | {kind: "service"; name; graphIds: Set<string>; access: "read" | "write"}`) and `scopedResolve(store, alias)`; the new `ToolError` status is `out-of-scope`;
  - `ResolvedGraph` gains optional `readOnlyBy?: string`;
  - `connector/src/mcp.ts` exports `ServiceProps` beside `GrantProps`; `mcpHandler(env, ctx, caller, scope = {kind: "oauth"})`;
  - wizard routes `GET /tokens`, `GET` and `POST /tokens/new` (fields `name`, repeated `graph`, `access`, `expires_days`, `csrf`), `POST /tokens/:id/revoke`;
  - `.mcp.json` server `logseq-service`; env `LOGSEQ_SERVICE_TOKEN`, `LOGSEQ_MCP_HOST`, `LOGSEQ_MCP_URL`;
  - `scripts/logseq-mcp.mjs` and `scripts/logseq-mcp.test.mjs`.
- **Messages, in the spec's wording** (§3.2, §3.3, §3.7, §4):
  - `service token '<name>' was revoked`, `service token '<name>' expired on YYYY-MM-DD` (UTC), `service token '<name>' belongs to a previous owner` (401 `invalid_token`, in the body's `error_description`);
  - an unknown or malformed bearer gets the provider's generic `Invalid access token`;
  - `graph '<alias>' is outside service token '<name>''s scope (it covers: <aliases>)` (status `out-of-scope`);
  - `graph '<alias>' is read-only (service token '<name>' is read-only)`; the OAuth message `graph '<alias>' is read-only` is unchanged;
  - wizard: `name: already in use`, `graph: at least one`, `expires_days: 1 to 365`, each naming the field (CLAUDE.md, *Errors name the entry and reason*).
- **No reason without the secret** (§6). Shape check, then lookup by full hash, then constant-time compare; only then revoked, expired, previous owner, in that order. A wrong token of the right shape never learns a reason.
- **No token at rest or in output** (acceptance 6). D1 holds only the hash. The token, its hash and (on failure) its name never reach a log line. Tests scan response bodies, headers, captured `console` output and every column of `service_tokens` and `audit_log` for the token string.
- **Fail closed.** A service request whose scope is not visible inside `resolve` throws; `requestScope.getStore()` undefined inside `scopedResolve` is always an error, because `mcpHandler` always runs the handler inside `requestScope.run` (OAuth with `{kind: "oauth"}`).
- **No management over `/mcp`** (acceptance 7). No MCP tool reads or writes `service_tokens` except through `verifyServiceToken` and `touch`; wizard routes stay cookie-session and CSRF only.
- **OAuth unchanged.** Every existing test passes untouched in every stage; an OAuth call reads no `service_tokens` row.
- **Free plan** (§5, REVIEW.md *Cost*, `docs/solutions/cost/d1-statement-shapes-read-more-than-they-return.md`). Tests pin, from D1's `meta`: malformed bearer 0 rows read; unknown token 0 read; known token 1 read, 0 written; touch 1 read and at most 1 written, at most once per token per hour; create 4 written; revoke 1 read, 1 written; the wizard list `ORDER BY name` reads about one row per token (not twice). The scope check adds no D1 read; only the out-of-scope refusal reads the covered aliases. Each stage's commit body states its rows per request.
- **Tests run the real thing.** Real D1, the real provider through `createConnector().fetch`, the real generated tools; only the sync server and GitHub are faked. Each rule test is first seen to fail by removing that rule (shape, hash compare, revoked, expired, owner, scope, mode coercion, throttle, fail-closed); keep the failure text for the PR (`docs/solutions/testing/untested-rules-survive-mutation.md`).
- **Contract with Claude.** No tool is added, removed or renamed; `tools-manifest.json` stays unchanged and the manifest check confirms it in every stage. The one `connector_help` sentence (§4) lands in Stage 2 with the behaviour.
- **Commits** follow `type(scope): what changed` (scopes `connector`, `deploy`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a token, graph name, page UUID, real hostname or database id. Tests and docs use `mcp.example.com`, `sync.example.com`, aliases `work` and `notes`, and token names such as `ci` and `nightly`. Test tokens are generated at run time, never literal secrets (a fixed `lsct_` string of the right shape is fine where a test needs one, since it opens nothing).

### Read before starting

- `REVIEW.md`, sections *Cost*, *Security*, *Contract and docs*, *Gates and tests*.
- `connector/src/index.ts` (`providerOptions`, `createConnector`), `connector/src/mcp.ts` (`isolateTools`, `callerOf`, `mcpHandler`, `mcpApiHandler`), `connector/src/tools/common.ts` (`callGraphs`, `lookupGraph`, `resolveGraph`), `connector/src/graphs.ts` (`GraphStore.resolve`, `list`), `connector/src/tools/handwritten.ts` (`list_graphs`, `CONNECTOR_HELP`), `connector/src/audit/log.ts` (`REFUSALS`, `audited`), `connector/src/auth/session.ts` (`timingSafeEqual`, `withSession`, CSRF), `connector/src/wizard/routes.ts` and `views.ts`.
- `node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js`: `handleApiRequest`, `isIssuedTokenFormat`, `ExternalTokenError` (spec §2 gives the lines).
- `connector/migrations/0004_audit_log.sql` and `0005_graph_edit_stamps.sql` for the header-comment style with measured costs.
- The `docs/solutions` entries listed in spec §2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A bearer of three colon-separated parts** (`a:b:c`): it reaches the resolver after the KV miss and gets the generic 401 with 0 D1 rows read (Stage 3).
2. **A token that expires during the hour after its last touch:** expiry is checked on every request from the verify read, not from a cached value; the touch throttle never skips verification (Stage 3).
3. **`expires_at` exactly equal to now:** refused as expired (`<=`), one millisecond later than now accepted (Stage 3).
4. **The same alias looked up twice in one call** after the out-of-scope refusal: the `callGraphs` cache must not hold the unscoped graph, so the second lookup refuses too (Stage 2).
5. **An alias renamed in the wizard after the token was made:** scope is held by `graph_id`, so the new alias is in scope and the old one is unknown (Stage 2).
6. **A read-write token on a graph connected read-only:** refused with the plain `graph '<alias>' is read-only`, not the token message, because the token did not lower it (Stage 2).
7. **A graph deleted from the wizard while a token still lists its id:** `list_graphs` shows the remaining graphs; the out-of-scope message lists only aliases that still exist (Stage 2).
8. **Two isolates touching in the same hour:** the second UPDATE's condition fails and writes 0 rows (Stage 1, at the store; Stage 3, through the handler).
9. **A wizard form with a graph id that is not connected** (tampered checkbox value): refused naming `graph`, nothing inserted (Stage 4).
10. **Revoking an already revoked token:** `revoked_at` keeps its first value (Stage 4).
11. **An SSE response split across chunks, and a 401 with a JSON body:** the CLI parses both and never prints the token (Stage 5).
12. **The CLI given the token in its JSON args by mistake:** `redact()` still replaces it in anything echoed (Stage 5).

---

### Stage 1: Migration 0006 and the token store

**Goal:** the `service_tokens` table, its unique hash index, and a store whose statements have the measured costs. Token generation and hashing exist and are tested. `timingSafeEqual` moves to `crypto.ts`. Nothing accepts a token yet, so behaviour for Claude and the owner is unchanged. Lands acceptance 10 and the storage half of 1 and 9.

**Files:**
- Create: `connector/migrations/0006_service_tokens.sql` (§3.6 verbatim, with a header comment stating the measured costs from spec §2). Follow the `add-d1-migration` skill.
- Create: `connector/src/auth/service-tokens.ts` with `TOKEN_PATTERN`, `generateServiceToken()` (`lsct_` + base64url of 32 bytes from `crypto.getRandomValues`), `hashServiceToken(token)`, and `ServiceTokenStore`:
  - `create({name, ownerId, graphIds, access, createdAt, expiresAt})`: generates the id (random, not secret) and token, inserts the hash, returns `{id, token}`. The token is returned once and never stored.
  - `get(id)`: one row by primary key, without `token_hash`.
  - `list()`: `ORDER BY name` (served by the `name` unique index), without `token_hash`.
  - `revoke(id, now)`: `UPDATE … SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`; returns whether it changed a row.
  - `touch(id, now)`: `UPDATE … SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)` with `now - TOUCH_INTERVAL_MS`.
  - `findByHash(hash)`: the §3.2 step 2 SELECT (used by Stage 3's verify).
- Modify: `connector/src/crypto.ts` (gains `timingSafeEqual`), `connector/src/auth/session.ts` (imports it; its private copy is removed).
- Create: `connector/test/service-tokens.test.ts` (store and migration blocks; Stage 3 adds the HTTP blocks).

**Interfaces produced:** `ServiceTokenStore`, `ServiceTokenRow`, `TOKEN_PATTERN`, `generateServiceToken`, `hashServiceToken`, `timingSafeEqual` (from `crypto.ts`).

- [ ] **Step 1: Write the failing tests:**
  - `migration 0006`: applies after 0005; `PRAGMA index_list(service_tokens)` shows `service_tokens_hash` as unique; inserting `access = 'admin'`, `graph_ids = '{}'`, `graph_ids = 'x'` and `expires_at = created_at` are each refused by their CHECK; a duplicate `name` and a duplicate `token_hash` are refused.
  - `generated tokens`: match `TOKEN_PATTERN`, are 48 characters, contain no colon, and 100 of them are distinct.
  - `hash`: `hashServiceToken` matches a known SHA-256 vector for a fixed `lsct_` string, lower-case hex, 64 characters.
  - `create stores only the hash`: no column of the inserted row contains the returned token; `meta.rows_written` is 4.
  - `findByHash`: a hit reads 1 row; a miss reads 0.
  - `touch is throttled`: first touch writes 1; a second within the hour writes 0 and reads 1; one after `TOUCH_INTERVAL_MS` writes 1 (review focus 8).
  - `revoke`: writes 1 and reads 1; a second revoke changes nothing and keeps the first `revoked_at`.
  - `list` and `get` never return `token_hash`; `list` is ordered by name and `meta.rows_read` is at most the row count plus one.
  - `timingSafeEqual` from `crypto.ts`: equal, unequal and unequal-length strings; the existing `auth.test.ts` CSRF and state tests still pass through the moved helper.

- [ ] **Step 2: Run** `npm --prefix connector test -- service-tokens`; keep the failures (no such table, no module).

- [ ] **Step 3: Implement** as §3.2 (format, hash) and §3.6.

- [ ] **Step 4: Contract.** None for Claude.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** drop the touch's `last_used_at < ?` condition and confirm the throttle test fails; change the `access` CHECK to accept anything and confirm the migration test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): add the service_tokens table and its store`. Body: rows per statement (insert 4 written; hash lookup 1 read on a hit, 0 on a miss; touch 1 read and at most 1 written an hour; revoke 1 and 1; list about one read a row).

**Done when:** migration 0006 applies with its index and CHECKs, every statement's cost is pinned from `meta`, only the hash is stored, and the gate is green.

---

### Stage 2: Scope applied at graph resolution

**Goal:** a request scope that, when it is a service scope, refuses graphs outside its `graphIds`, lowers the effective mode for a read-only token, and filters `list_graphs`. `mcpHandler` takes the scope as an argument and always runs the handler inside `requestScope.run`; `mcpApiHandler` still passes `{kind: "oauth"}`, so production behaviour is unchanged until Stage 3. Lands acceptances 2 and 7 at the tool layer, and risk 3's guard.

**Files:**
- Modify: `connector/src/tools/common.ts`: `requestScope` (`AsyncLocalStorage<RequestScope>`), `scopedResolve(store, alias)` as §3.3 steps 1 to 4 (the covered-alias read only on the refusal path, one `SELECT alias FROM graphs WHERE graph_id IN (…) ORDER BY alias`, a `GraphStore` method); `resolveGraph`'s write check names the token when `readOnlyBy` is set. The refusal is thrown from inside `access.resolve`, so `lookupGraph` never caches an unscoped graph (review focus 4).
- Modify: `connector/src/graphs.ts`: `readOnlyBy?: string` on `ResolvedGraph`; `GraphStore.aliasesFor(graphIds)`.
- Modify: `connector/src/mcp.ts`: `isolateTools` builds `access.resolve` as `(alias) => scopedResolve(store, alias)`; `mcpHandler` gains `scope: RequestScope = {kind: "oauth"}` and wraps the stateless handler so each request runs inside `requestScope.run(scope, …)`; `registerHandwrittenTools` receives what it needs to filter `list_graphs`.
- Modify: `connector/src/tools/handwritten.ts`: `list_graphs` filters `store.list()` by the scope's `graphIds` and shows the effective mode; `CONNECTOR_HELP` gains the §4 sentence.
- Modify: `connector/src/audit/log.ts`: `out-of-scope` joins `REFUSALS` (an OR chain or `Set`, as the file does now).
- Modify: `connector/test/service-tokens.test.ts` (a *scope* block calling `mcpHandler(env, ctx, caller, scope)` with a real MCP `tools/call` request), `connector/test/graphs.test.ts` (`aliasesFor`), `connector/test/audit-log.test.ts` if it pins `REFUSALS`.

**Interfaces produced:** `RequestScope`, `requestScope`, `scopedResolve`, `mcpHandler`'s `scope` parameter.

- [ ] **Step 1: Write the failing tests:**
  - `read-only scope refuses every write tool`: walk every registered tool whose `readOnlyHint` is false (from the server `mcpHandler` builds, not a hand list, so new tools are covered automatically, risk 3), call each with in-scope alias `work` under `{kind: "service", name: "ci", graphIds: {work's id}, access: "read"}`, with a sync fetch stub that counts calls. Each answers `graph 'work' is read-only (service token 'ci' is read-only)`, the stub saw 0 calls, and the audit row has `status = 'refused'`.
  - `out of scope`: alias `notes` (connected, not in scope) for a read tool (`get_page`) and a write tool (`update_block`) answers the out-of-scope message listing `work`; the write's audit row is `refused`. A second lookup of `notes` in the same call also refuses (review focus 4).
  - `every graph tool honours the scope`: walk every registered tool that takes `graph`, call it with `notes`, and assert none reaches the sync stub (risk 3).
  - `effective mode`: a read-write scope on a graph connected read-only refuses a write with the plain OAuth message (review focus 6); a read-write scope on a read-write graph reaches the sync stub.
  - `scope by graph id`: rename `work` to `work2` in the store; `work2` is in scope and `work` is unknown (review focus 5).
  - `list_graphs`: under the scope it returns only `work`, with mode `read` for a read-only token; a deleted graph's id in `graphIds` is ignored and drops out of the covered list (review focus 7).
  - `OAuth unchanged`: `mcpHandler` with no scope argument lists every graph and writes as before; the existing `tools.test.ts` and `assets.test.ts` pass untouched.
  - `fail closed`: calling the isolate's `access.resolve` outside `requestScope.run` throws, not resolves.
  - `cost`: an in-scope call reads the same D1 rows as the same call under OAuth (from `meta` via a counting `DB` wrapper); only the refusal adds the alias read.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.3. Keep the audit wrapper's pre-check order equal to the handler's (`docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`): both go through `lookupGraph` then `resolveGraph`, so nothing extra is needed beyond `REFUSALS`.

- [ ] **Step 4: Contract.** `CONNECTOR_HELP` gains: "Under a service token, `list_graphs` shows only the token's graphs, other aliases are refused as outside its scope, and a read-only token refuses every write." `tools-manifest.json` is unchanged; confirm with `node connector/scripts/check-tools-manifest.mjs`.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** remove the scope check, then the mode coercion, then the fail-closed throw, one at a time, and confirm the out-of-scope, read-only and fail-closed tests each fail. Revert.

- [ ] **Step 7: Commit.** `feat(connector): apply a service token's graph scope and mode at graph resolution`. Body: no D1 read added on the in-scope path; the refusal reads the covered aliases (a handful); OAuth passes `{kind: "oauth"}` and is unchanged.

**Done when:** a service scope passed to `mcpHandler` limits every graph tool and `list_graphs`, a read-only scope refuses every write before the sync server, OAuth is unchanged, and the gate is green.

---

### Stage 3: `/mcp` accepts service tokens

**Goal:** the provider's `resolveExternalToken` hook verifies `lsct_` bearers, and `mcpApiHandler` runs a service request with its caller, scope and throttled touch. Lands acceptances 1, 4, 5, 6 and 8, and the request half of 9.

**Files:**
- Modify: `connector/src/auth/service-tokens.ts`: `verifyServiceToken(env, token, now)` as §3.2 steps 1 to 5, throwing `ExternalTokenError("invalid_token", {description, statusCode: 401})` for the three reasons and returning `null` otherwise. Logs nothing on success; never logs the token, the hash or the name.
- Modify: `connector/src/index.ts`: `providerOptions` sets `resolveExternalToken: ({token, env}) => verifyServiceToken(env, token, Date.now())`, with the audience `https://<host>/mcp` built from the same host the provider is pinned to.
- Modify: `connector/src/mcp.ts`: `ServiceProps` (`kind: "service"`, `tokenId`, `name`, `githubUserId`, `graphIds`, `access`, `lastUsedAt`); in `mcpApiHandler`, `isOwner` still runs for both kinds; for a service request the caller is `{client: "service:<name>", session: mcp-session-id}`, the scope is built from the props, and `ctx.waitUntil(touchServiceToken(...))` runs only when `lastUsedAt` is null or older than `TOUCH_INTERVAL_MS`. A touch failure logs `service-token-touch-failed id=<id>`.
- Modify: `connector/test/service-tokens.test.ts` (an *HTTP* block through the real `createConnector().fetch`, tokens created with Stage 1's store), `connector/test/activity-log.test.ts` (a `service:<name>` client in the output).

**Interfaces produced:** `verifyServiceToken`, `ServiceProps`.

- [ ] **Step 1: Write the failing tests** (spec §8, first list):
  - `valid token`: a read-write token for `work` gets 200 on `initialize` and `tools/list`.
  - `generic 401`: an unknown `lsct_` token of the right shape, a malformed bearer and `a:b:c` each get `Invalid access token`; the malformed one and `a:b:c` read 0 D1 rows (counting `DB` wrapper), the unknown one reads 0 (review focus 1).
  - `reasons`: revoked, expired and previous-owner tokens each get 401 with `error_description` naming the reason and the token's name; the token string is absent from the body, every header and captured `console` output.
  - `expiry boundary`: `expires_at = now` is refused, `now + 1` accepted (review focus 3); a token touched a minute ago that has since expired is refused (review focus 2).
  - `order pin`: with a revoked token `ci` stored, a different right-shaped token gets the generic 401, not the revoked reason.
  - `hash compare`: with `findByHash` made to return a row whose `token_hash` differs (a test-only `DB` wrapper), verify answers the generic 401. This is the mutation that removing `timingSafeEqual` must fail.
  - `owner backstop`: a props object with another owner reaching `mcpApiHandler` still gets 403.
  - `write audited and stamped`: a read-write token's `update_block` reaches the sync stub with `x-logseq-edit-stamp: claude`, and its `audit_log` row has `client = 'service:ci'` and the `mcp-session-id` sent.
  - `read-only through HTTP`: one write tool with a read-only token is refused naming the token and makes 0 sync calls (the full walk is Stage 2's; this proves the props reach the scope).
  - `out of scope through HTTP`: an out-of-scope alias is refused, proving the scope reaches the tool callback on these `agents` and MCP SDK versions (risk 2).
  - `last used`: first request writes `last_used_at`; a second within the hour writes nothing; one after the hour (fake clock) writes again.
  - `D1 failure in verify`: a `DB` wrapper that throws on the lookup gives a non-200 whose body, headers and captured console contain no token.
  - `no token anywhere`: after all of the above, no column of `service_tokens` or `audit_log` contains any token string.
  - `cost`: a known token's verify reads 1 row and writes 0; an OAuth request reads no `service_tokens` row.
  - `rate limits`: no connector limiter exists for either kind (assert there is no new limiter rather than a timing test); the commit body cites spec §2 *Rate limits*.
  - In `activity-log.test.ts`: an entry with `client = 'service:ci'` prints as stored.

- [ ] **Step 2: Run and keep the failures** (every service bearer gets the generic 401 today).

- [ ] **Step 3: Implement** as §3.2, §3.3 and §3.5.

- [ ] **Step 4: Contract.** None beyond Stage 2's sentence. Manifest unchanged.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** remove, one at a time, the shape check (malformed bearer reads a row), the hash compare, the revoked branch, the expired branch (or change `<=` to `<`), the owner branch and the touch throttle in `mcpApiHandler`; confirm a named test fails for each. Revert.

- [ ] **Step 7: Commit.** `feat(connector): accept scoped service tokens at /mcp`. Body: rows per request (malformed or unknown 0; known 1 read; touch at most 1 read and 1 write an hour per token; scope 0 extra), OAuth path unchanged (KV, no D1), and that a token is accepted only now that Stage 2's scope is in force.

**Done when:** a valid token reaches `/mcp` with its scope, every refusal reason is pinned and ordered, writes are audited as `service:<name>` and stamped, no token appears in any output, and the gate is green.

---

### Stage 4: Token management in the wizard

**Goal:** the owner lists, creates and revokes tokens in the wizard, behind the existing sign-in, allow-list and CSRF. The token is shown once. Lands acceptance 3 and the creation half of 1.

**Files:**
- Modify: `connector/src/wizard/routes.ts`: `GET /tokens`, `GET /tokens/new`, `POST /tokens/new`, `POST /tokens/:id/revoke`, all through `withSession` and (for POSTs) `withForm`, as §3.7. Create validates every field up front (`name` matches `[a-z0-9-]{1,40}` and is unused; at least one `graph`, each a connected graph id; `access` is `read` or `write`; `expires_days` 1 to 365), inserts, reads back by id and compares name, graph ids, access and expiry; on a mismatch it deletes the row and refuses.
- Modify: `connector/src/wizard/views.ts`: the list (name, graphs by current alias, access, expiry, last used, status active/expired/revoked, a revoke button per active row), the form (a checkbox per graph showing its mode, access defaulting to read-only, `expires_days` defaulting to 90), the show-once page (`Cache-Control: no-store`, copy button, store it as `LOGSEQ_SERVICE_TOKEN`, a note that a screenshot or restored tab can still hold it), and a link from the graph list.
- Modify: `connector/test/wizard.test.ts`.

**Interfaces produced:** the four wizard routes.

- [ ] **Step 1: Write the failing tests** (spec §8, wizard list):
  - `/tokens` and `/tokens/new` without a session redirect to `/login`; with only `Authorization: Bearer <valid service token>` and no cookie they also redirect (acceptance 7).
  - A POST to `/tokens/new` or `/tokens/:id/revoke` without CSRF gets 403 and changes nothing.
  - `create`: the row stores only the hash (no column contains the token); the response body contains the token exactly once; `Cache-Control: no-store`; the token is in no `Location`, `Set-Cookie` or console line; the new token then reaches `/mcp` (through `createConnector().fetch`).
  - `refusals name the field`: duplicate name, a bad name, no graphs, an unconnected graph id (review focus 9), `access=admin`, `expires_days` 0, 366 and `ninety`; each answers naming the field and inserts nothing.
  - `form defaults`: access is read-only and expiry 90 days.
  - `list`: shows each token by name with its graphs' current aliases and status; revoked and expired rows stay listed; no `token_hash` in the page.
  - `revoke`: sets `revoked_at`, redirects to `/tokens`, and the token then gets the revoked 401; revoking again keeps the first `revoked_at` (review focus 10).
  - `cost`: create writes 4 rows and reads 1 for the read-back; revoke reads 1 and writes 1.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.7, reusing the graph wizard's form and error rendering.

- [ ] **Step 4: Contract.** None for Claude (no MCP surface).

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** drop the `expires_days` upper bound, then the read-back comparison (make the insert drop a graph id in a test wrapper), and confirm the refusal and read-back tests fail. Revert.

- [ ] **Step 7: Commit.** `feat(connector): manage service tokens in the wizard`. Body: rows per create, list and revoke; owner-only through the existing session and allow-list; token shown once with `no-store`.

**Done when:** the owner can create, list and revoke tokens, every field is validated naming the field, the token appears exactly once and only on the create response, and the gate is green.

---

### Stage 5: Claude Code wiring and the CLI fallback

**Goal:** a checked-in `.mcp.json` that reads the token from the environment, settings that enable it and allow its read tools, and `scripts/logseq-mcp.mjs` for sessions where the MCP server is not loaded. Lands acceptances 11 and 13.

**Files:**
- Create: `.mcp.json` (§3.8 verbatim; no secret).
- Modify: `.claude/settings.json`: `"enabledMcpjsonServers": ["logseq-service"]`; a `permissions.allow` entry `mcp__logseq-service__<tool>` for each `mcp__Logseq__<tool>` already allowed (today `search_graph`, `get_page_outline`, `get_page`, `get_block`, `get_blocks`, `list_tasks`, `kb_index`, `semantic_search`, `list_graphs`). Write tools still prompt. Use the `update-config` conventions; keep the existing hooks and deny list.
- Create: `scripts/logseq-mcp.mjs` (§3.9): Node 20, no dependencies; reads `LOGSEQ_SERVICE_TOKEN` and `LOGSEQ_MCP_URL` (default `https://mcp.example.com/mcp`); `initialize`, then `notifications/initialized`, then `tools/call`, carrying `mcp-session-id`; parses JSON and SSE (`text/event-stream`, events split across chunks); prints the tool's text content; exits 1 with the status and server message on an HTTP error, a JSON-RPC error or `isError`; exits 2 with a usage line when the token or tool is missing. Every printed line goes through one `redact()`; the token is never an argument.
- Create: `scripts/logseq-mcp.test.mjs` (`node:test` with a `node:http` stub MCP server on `127.0.0.1`).
- Create or modify: a `scripts/` test that pins `.mcp.json` and the settings (`scripts/claude-wiring.test.mjs`, or a block in `logseq-mcp.test.mjs`), so `npm test` checks them.

**Interfaces produced:** the `logseq-service` MCP server entry; `node scripts/logseq-mcp.mjs <tool> ['<json args>']`.

- [ ] **Step 1: Write the failing tests:**
  - `calls a tool`: against the stub, `list_graphs` prints the stub's text and exits 0; the stub saw `Authorization: Bearer <token>`, `initialize` before `tools/call`, and the `mcp-session-id` it set echoed back.
  - `JSON and SSE`: both response types parse, including an SSE event split across two writes (review focus 11).
  - `failures exit non-zero`: 401 with a JSON `error_description` (printed), a JSON-RPC error and a tool result with `isError`; each exits 1 with the message.
  - `missing token`: exits 2 with a usage line naming `LOGSEQ_SERVICE_TOKEN`, and sends no request.
  - `never prints the token`: in every case above, and when the stub echoes the bearer back in its error text, and when the token is passed inside the JSON args (review focus 12), neither stdout nor stderr contains it.
  - `wiring`: `.mcp.json` parses, its URL and header use `${LOGSEQ_MCP_HOST:-mcp.example.com}` and `${LOGSEQ_SERVICE_TOKEN}`, and it contains no `lsct_` value; `.claude/settings.json` enables `logseq-service`, has a `mcp__logseq-service__` allow entry for every allowed `mcp__Logseq__` tool, and allows no `mcp__logseq-service__` write tool (checked against `connector/tools-manifest.json`'s read-only flags).

- [ ] **Step 2: Run** `npm test`; keep the failures (no script, no file).

- [ ] **Step 3: Implement** as §3.8 and §3.9.

- [ ] **Step 4: Contract.** None for the connector. The README section is the docs stage's (below).

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** bypass `redact()` on stderr and confirm the never-prints test fails; drop the session-id echo and confirm the call test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): wire Claude Code to the connector with a service token, plus a CLI fallback`. Body: no secret checked in; write tools still prompt; the CLI never takes the token as an argument and redacts every line.

**Done when:** a cloud session with `LOGSEQ_SERVICE_TOKEN` set loads `logseq-service` with its read tools allowed, the CLI calls a tool from bash without ever printing the token, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage** (§3.10): README gains *Service tokens for cloud sessions* in §11 (create a token in the wizard; add `LOGSEQ_SERVICE_TOKEN`, and `LOGSEQ_MCP_HOST` when not `mcp.example.com`, as a cloud environment secret; allow `mcp.example.com` in the environment's network policy; how `.mcp.json` picks them up and that a local session without the variable shows a failed `logseq-service` server; the CLI fallback; expiry and revoke). §11.6 gains a pointer to it; §11.8 gains the §4 sentence; §11.9 (security model) says tokens are hashed, scoped, expiring, owner-bound and cannot manage tokens. §9's rollout notes say migration 0006 applies before the Worker deploys. REVIEW.md *Security* gains the line from risk 3 (a tool that reads `store.list()` or `store.resolve()` directly escapes a service token's scope). Example hostnames only.
- **PR body:** the Logseq skill note (§4: cloud sessions reach the connector as `mcp__logseq-service__*` with the same tools and arguments; a read-only token's write refusal names the token, so report it rather than retry), the failures each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped. The PR is stacked on items 28 and 29 and merges with them (spec §9 step 1; risk 7: re-check `Caller`, `REFUSALS` and stamp wiring if either is reworked).
- **After deploy** (spec §9 steps 2 to 5): a read-only token for one graph in a cloud environment (`list_graphs` shows one graph; a write is refused naming the token; the CLI prints the same list); a read-write token used from a scheduled task (`get_activity_log` shows `service:<name>`; the block carries `editedBy`); revoke both and confirm the 401 names the reason.
- **Owner questions** in spec §11 stay open; none blocks a stage. Question 1 (hide write tools) would add a `tools/list` filter after Stage 3; question 2 changes Stage 4's expiry defaults and bounds; question 3 moves `enabledMcpjsonServers` out of Stage 5's `.claude/settings.json`; question 4 shortens Stage 2's out-of-scope message and drops `aliasesFor`; question 5 needs a change to patch 0034 and would be its own item. Any change lands before the PR merges.
