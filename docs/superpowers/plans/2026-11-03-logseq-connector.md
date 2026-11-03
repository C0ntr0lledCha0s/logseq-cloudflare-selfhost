# Logseq Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second Cloudflare Worker, `logseq-connector`. It is a remote MCP server with a GitHub sign-in locked to the owner, so that claude.ai and Claude Code cloud sessions can read and write the owner's unencrypted Logseq graphs. It includes a "Connect a graph" wizard and three file tools.

**Architecture:**

- A TypeScript Worker under `connector/`, using `@cloudflare/workers-oauth-provider`, with a GitHub upstream sign-in and a numeric-ID allow-list.
- MCP is served by `createMcpHandler` (stateless), with tools registered at runtime from the sync server's `openapi.json`, reusing upstream's `semantic_api_tools.mjs`.
- Graph tokens (PATs) are AES-GCM encrypted in a D1 database.
- Every sync call goes over a service binding `SYNC` to the existing `logseq-sync` Worker.
- It is optional behind `connector.enabled` in `config/settings.json`, and deployed by the existing pipeline.

**Tech Stack:**

- TypeScript and Node 22;
- `agents` (`agents/mcp/server` → `createMcpHandler`), `@modelcontextprotocol/server` v2, `@cloudflare/workers-oauth-provider` 1.x, `zod` v4;
- `vitest` with `@cloudflare/vitest-pool-workers`;
- wrangler: the version upstream `deps/db-sync` pins;
- OpenTofu (`cloudflare/cloudflare` v5);
- GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-logseq-connector-design.md`. Read it first; section numbers below refer to it. Also read `docs/spike-results.md` and the README for existing conventions.

## Global Constraints

**Branching**

- Start from `main` after PR #3 (final-review fixes) and PR #6 (this design) are merged. Branch: `feat/connector`.

**Naming and placeholders**

- Worker name `logseq-connector`. D1 `logseq-connector`. KV namespace binding `OAUTH_KV`. Service binding `SYNC` → service `logseq-sync`.
- Hostname from `CONNECTOR_HOSTNAME`, which is never committed. Docs and tests use `mcp.example.com` and `sync.example.com`.

**Secrets**

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OWNER_GITHUB_USER_ID` (numeric), `COOKIE_ENCRYPTION_KEY`, `GRAPH_TOKEN_KEY` (32 bytes as 64 hex chars), `CONNECTOR_HOSTNAME`.
- They live in `.env.local` and the `production` environment, and are never committed or printed.

**Graphs**

- Only unencrypted graphs. A PAT for a graph with `graph-e2ee?: true` is refused.
- Claude addresses a graph by `alias`: `^[a-z0-9][a-z0-9-]{0,39}$`, unique.
- Graph `mode` is `"read"` or `"write"`. Write tools on a `read` graph are refused before any sync call.

**Tool annotations**

- GET → `readOnlyHint: true`.
- DELETE → `destructiveHint: true`.
- Everything else → `readOnlyHint: false, destructiveHint: false`.

**OAuth**

- Redirect URIs allowed only: `https://claude.ai/api/mcp/auth_callback`, `http://localhost:<any>/…` and `http://127.0.0.1:<any>/…`.
- Both DCR (`/register`) and CIMD are enabled. CIMD needs compatibility flag `global_fetch_strictly_public`.

**Size limits**

- Tool argument and result caps target claude.ai's ~150,000 characters per result.
- `save_file_from_url` cap: 25 MiB. Content types allowed: `text/*`, `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/json`, `application/vnd.openxmlformats-officedocument.*`.

**Fail-fast and logging**

- No defaults that mask invalid state.
- Logs carry the tool name, graph alias, status and duration only. Never arguments, results, tokens or hostnames.

**`connector.enabled`**

- `false` (the default on merge): CI builds and tests the connector, but OpenTofu and deploy skip it.
- `true`: every connector secret is required, and a missing one fails the deploy.

**Outward actions**

- Owner go-ahead is needed at the time for: creating the GitHub OAuth app, adding token permissions, `tofu apply`, any deploy, claude.ai connector setup, and pushing or opening PRs.

**Commits**

- Concise imperative subjects (`feat(connector): …`, `ci: …`, `docs: …`).
- Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A wizard-pasted token with stray whitespace or a newline.** It should be trimmed once. A token with inner whitespace or non-`[A-Za-z0-9_-]` characters is rejected with a clear message, not stored. *Test in Task 3.*
2. **Redirects in `save_file_from_url`** (`https://public` → `http://169.254.169.254` or `https://localhost`). Every hop is re-checked against the SSRF rules, and the call fails. *Test in Task 6.*
3. **A tool call naming an unknown or disconnected alias**, including one removed seconds ago. It fails immediately with "graph 'x' is not connected — see /graphs" and makes no sync call. D1 is strongly consistent. *Test in Task 5.*
4. **A sign-in by a second GitHub account,** through `/mcp` OAuth or `/graphs`. It's refused before any token or session is issued. *Test in Task 2.*
5. **A sync `429` during a long `insertBlockTree` or batch write.** The tool returns "rate limited — retry after N s" using `Retry-After`, and never silently retries writes. *Test in Task 5.*

---

### Task 1: Connector scaffold, settings flag and config renderer

**Files:**
- Create:
  - `connector/package.json`, `connector/package-lock.json`, `connector/tsconfig.json`, `connector/vitest.config.ts`
  - `connector/src/index.ts` (placeholder fetch returning 404 except `GET /health` → `{"ok":true}`)
  - `connector/wrangler.template.jsonc`
  - `scripts/render-connector-wrangler.mjs`, `scripts/render-connector-wrangler.test.mjs`
  - `scripts/vendor-upstream-api.sh`
- Modify:
  - `config/settings.json` (add `"connector":{"enabled":false,"workerName":"logseq-connector","d1DatabaseName":"logseq-connector"}`)
  - `.gitignore` (add `connector/vendor/`, `connector/.wrangler/`, `connector/node_modules/`)

**Interfaces:**
- **`renderConnectorWrangler({template, settings, hostname, tofuOutputs})`** in `scripts/render-connector-wrangler.mjs`.
  - `template`: a JSONC string. `settings`: `config/settings.json`. `tofuOutputs`: `{connector_oauth_kv_id, connector_d1_id}`. Returns a JSON string.
  - Sets `name = settings.connector.workerName`, `routes = [{pattern: hostname, custom_domain: true}]`, `workers_dev = false`, `preview_urls = false`.
  - Bindings: `kv_namespaces = [{binding:"OAUTH_KV", id}]`, `d1_databases = [{binding:"DB", database_name, database_id, migrations_dir:"migrations"}]`, `services = [{binding:"SYNC", service: settings.workerName}]`.
  - Template keeps `compatibility_flags: ["nodejs_compat","global_fetch_strictly_public"]`.
  - Throws `missing <name>` on any empty input. Throws if `settings.connector.enabled !== true` (rendering means deploying).
- **CLI:** `node scripts/render-connector-wrangler.mjs --template connector/wrangler.template.jsonc --settings config/settings.json --hostname <h> --tofu-outputs <tofu-output.json> --out <path>`.
  - Reads `.connector_oauth_kv_id.value` and `.connector_d1_id.value`.
- **`scripts/vendor-upstream-api.sh <upstream-dir>`** copies into `connector/vendor/`:
  - `deps/db-sync/worker/semantic_api_tools.mjs`
  - `deps/db-sync/worker/dist/openapi.json`

  It fails if either is missing (upstream must be built first). It writes `connector/vendor/UPSTREAM_REF`.

- [ ] **Step 1:** Write `scripts/render-connector-wrangler.test.mjs`:
  - `test("renders hostname, bindings and no workers.dev")`: parsed output has `workers_dev === false` and `routes[0]` deep-equals `{pattern:"mcp.example.com",custom_domain:true}`. `services[0]` deep-equals `{binding:"SYNC",service:"logseq-sync"}`. `kv_namespaces[0].binding === "OAUTH_KV"`. `d1_databases[0].database_name === "logseq-connector"`. `compatibility_flags` includes `"global_fetch_strictly_public"`.
  - `test("throws when connector disabled")`.
  - `test("throws on missing kv/d1 id or hostname")`.
- [ ] **Step 2:** Run `OFFLINE=1 npm test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the renderer and the template. Scaffold `connector/` with exact dependency pins in the lockfile. `npm --prefix connector test` runs vitest with the workers pool; one health test asserts `GET /health` → 200 `{"ok":true}`.
- [ ] **Step 4:** Run `OFFLINE=1 npm test && npm --prefix connector ci && npm --prefix connector test`. Expected: all PASS.
- [ ] **Step 5:** Run `scripts/vendor-upstream-api.sh .upstream`. Expected: both files are present in `connector/vendor/`.
- [ ] **Step 6: Commit** `feat(connector): scaffold worker, settings flag and config renderer`.

### Task 2: OAuth provider with GitHub sign-in and an owner-only allow-list

**Files:**
- Create:
  - `connector/src/auth/github.ts`, `connector/src/auth/session.ts`
  - `connector/test/auth.test.ts`
- Modify: `connector/src/index.ts`

**Interfaces:**
- **`index.ts`** exports `default new OAuthProvider({...})` with:
  - `apiRoute: "/mcp"` (handler from Task 5, which is a stub returning a fixed `ping` tool until then);
  - `defaultHandler` (GitHub routes + wizard);
  - `authorizeEndpoint: "/authorize"`, `tokenEndpoint: "/token"`, `clientRegistrationEndpoint: "/register"`, `clientIdMetadataDocumentEnabled: true`;
  - resource metadata whose `resource` is exactly `https://<host>/mcp`.
  - Redirect-URI validation per Global Constraints.
- **`isOwner(githubUserId: number, env: Env): boolean`** compares against `Number(env.OWNER_GITHUB_USER_ID)`. It throws at startup if that is not a positive integer.
- **`completeAuthorization`** props are `{ githubUserId: number, login: string }`.
- **`session.ts`:**
  - `createSession(env, githubUserId): Promise<string>`: an encrypted `HttpOnly; Secure; SameSite=Lax` cookie value, 8 h expiry, keyed by `COOKIE_ENCRYPTION_KEY`.
  - `requireOwnerSession(request, env): Promise<{githubUserId:number}|Response>`, which returns a redirect to `/login` otherwise.
  - `csrfToken(session)` and `checkCsrf(request, session)`.
- **Routes:**
  - `/login` → GitHub authorize;
  - `/callback` → exchange code, fetch `https://api.github.com/user`, then `isOwner`, else 403 page;
  - `/logout`.
- GitHub calls are made through an injectable `fetch`, so tests can stub `api.github.com` and `github.com/login/oauth/access_token`.

- [ ] **Step 1: Write failing tests** in `connector/test/auth.test.ts` (vitest workers pool, stubbed GitHub):
  - `unauthenticated POST /mcp returns 401 with WWW-Authenticate resource_metadata`.
  - `protected resource metadata resource equals https://mcp.example.com/mcp`.
  - `rejects redirect_uri outside allow-list at /register`, using `https://evil.example/cb`.
  - `owner GitHub id completes authorization and receives a code`.
  - `second GitHub account is refused at /callback with 403 and no code or session issued` (Review Focus 4).
  - `/graphs without session redirects to /login`.
  - `CSRF token required on POST`.
- [ ] **Step 2:** Run `npm --prefix connector test`. Expected: FAIL.
- [ ] **Step 3:** Implement, following the `cloudflare/ai` `demos/remote-mcp-github-oauth` flow (`beginConsent` → `approveConsent` → `beginUpstream` → `finishUpstream` → `completeAuthorization`), with the `isOwner` gate before `completeAuthorization`.
- [ ] **Step 4:** Run `npm --prefix connector test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(connector): GitHub sign-in restricted to the owner`.

### Task 3: Graph store (D1 and encrypted tokens)

**Files:**
- Create:
  - `connector/migrations/0001_graphs.sql`
  - `connector/src/graphs.ts`
  - `connector/test/graphs.test.ts`

**Interfaces:**
- **Table `graphs`:** `alias TEXT PRIMARY KEY`, `graph_id TEXT NOT NULL UNIQUE`, `graph_name TEXT NOT NULL`, `mode TEXT NOT NULL CHECK(mode IN ('read','write'))`, `permission TEXT NOT NULL CHECK(permission IN ('read','write','both'))`, `expires_at TEXT`, `token_ct TEXT NOT NULL`, `token_iv TEXT NOT NULL`, `key_id TEXT NOT NULL`, `created_at TEXT NOT NULL`, `last_used_at TEXT`.
- **`type GraphRecord`** = `{alias, graphId, graphName, mode:'read'|'write', permission:'read'|'write'|'both', expiresAt:string|null, lastUsedAt:string|null}`. It has no token field.
- **`normalizeToken(raw: string): string`** trims once. It throws `"token has unexpected characters (stray whitespace or newline?)"` unless the result matches `^logseq_pat_[A-Za-z0-9_-]+$`.
- **`normalizeAlias(raw: string): string`** lowercases, replaces non-alphanumerics with `-`, collapses repeats, then validates against the Global Constraints regex.
- **`class GraphStore`**:
  - `constructor(db: D1Database, keyHex: string)`;
  - `list(): Promise<GraphRecord[]>`, `get(alias): Promise<GraphRecord|null>`, `token(alias): Promise<string>` (decrypts; throws if absent);
  - `add(rec: Omit<GraphRecord,'lastUsedAt'> & {token:string})` (rejects duplicate alias or graph ID);
  - `update(alias, patch: Partial<Pick<GraphRecord,'alias'|'mode'|'expiresAt'>>)`;
  - `replaceToken(alias, token, graphId)` (throws if `graphId` differs);
  - `remove(alias)`, `touch(alias)`.
  - Encryption: AES-GCM, 12-byte random IV, key from `GRAPH_TOKEN_KEY` hex, `key_id = "k1"`.

- [ ] **Step 1: Write failing tests** (D1 via the workers pool, migrations applied):
  - `token round-trips encrypted; token_ct differs from plaintext and between two adds of same token`.
  - `normalizeToken trims one trailing newline and rejects inner whitespace and bad chars` (Review Focus 1).
  - `duplicate alias or graph_id rejected`.
  - `replaceToken refuses a different graph id`.
  - `remove then get returns null immediately`.
  - `list never exposes token fields`.
- [ ] **Step 2:** Run `npm --prefix connector test`. Expected: FAIL. **Step 3:** Implement. **Step 4:** Expected: PASS.
- [ ] **Step 5: Commit** `feat(connector): encrypted graph token store in D1`.

### Task 4: "Connect a graph" wizard

**Files:**
- Create:
  - `connector/src/sync.ts`
  - `connector/src/wizard/routes.ts`, `connector/src/wizard/views.ts`
  - `connector/test/wizard.test.ts`
- Modify: `connector/src/index.ts` (mount routes under the `defaultHandler`)

**Interfaces:**
- **`syncFetch(env, pat: string, req: {method:string, path:string, query?:Record<string,string|number|boolean>, json?:unknown, body?:BodyInit, headers?:Record<string,string>}): Promise<Response>`.**
  - Builds `new Request("https://sync.internal" + path + qs, …)` with `authorization: Bearer <pat>`, and calls `env.SYNC.fetch`.
  - Throws a typed `SyncError {status, message, retryAfter?}` for non-2xx responses, using the body's `error` field.
- **`inspectToken(env, pat): Promise<{graphId, graphName, e2ee:boolean}>`** calls `GET /api/v1/graphs`. It requires exactly one graph and throws otherwise.
- **Routes** (all behind `requireOwnerSession`; POSTs need `checkCsrf`):
  - `GET /graphs`: list, with an expiry warning when `expiresAt` is within 30 days.
  - `GET /graphs/new`: Logseq instructions plus a token field.
  - `POST /graphs/new`: normalize, inspect, refuse E2EE, then render the confirm form (alias defaults to `normalizeAlias(graphName)`, mode, expiry date).
  - `POST /graphs/confirm`: the token is carried in a short-lived encrypted hidden field (session key), never echoed. Saves via `GraphStore.add`.
  - `POST /graphs/:alias/edit` (alias, mode, expiry), `POST /graphs/:alias/token` (replace), `POST /graphs/:alias/disconnect`.
- **Views:** server-rendered HTML strings, escaped, with no client framework. The token value never appears in any rendered page.

- [ ] **Step 1: Write failing tests** (SYNC stubbed with a fetch handler):
  - `connect flow stores graph with alias from name and mode write`.
  - `E2EE graph refused with explanation and nothing stored`.
  - `invalid or expired token shows error from sync and nothing stored`.
  - `token never appears in any response body` (assert on every response in the flow).
  - `disconnect removes access` (followed by a store `get` → null).
  - `edit to read mode persists`.
  - `replace token with different graph refused`.
  - `expiry within 30 days shows warning`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(connector): connect-a-graph wizard`.

### Task 5: MCP tools for the REST API

**Files:**
- Create:
  - `connector/src/tools/semantic.ts`, `connector/src/tools/handwritten.ts`, `connector/src/mcp.ts`
  - `connector/tools-manifest.json`, `connector/scripts/check-tools-manifest.mjs`
  - `connector/test/tools.test.ts`

**Interfaces:**
- **`transformSpec(spec): spec`**:
  - drops operations whose path contains `/e2ee/`, and the operation IDs `createAsset`, `getAsset` and `listGraphs`;
  - in every remaining operation, removes the `graph-id` path parameter and adds a required string parameter `graph` (description: "Graph alias from list_graphs").
- **`registerGraphTools(server, spec, resolve: (alias) => Promise<{graphId, pat, mode}>)`**:
  - calls the vendored `registerSemanticApiTools(server, transformSpec(spec), request)`;
  - the `request` callback resolves `args.graph`, substitutes `{graph-id}` in the original path, refuses non-GET operations when `mode === "read"` with `graph '<alias>' is read-only`, and calls `syncFetch`.
  - Because the upstream helper doesn't pass args to `request`, wrap it: register through a server proxy that captures args per call. Any approach is fine if the tests pass.
- **Error text:**
  - `SyncError 401/403` → `token for graph '<alias>' expired or lacks permission — reconnect it at https://<host>/graphs`;
  - `429` → `rate limited — retry after <n> s` (from `Retry-After`, else 60), with no retry;
  - `400` → the server message.
- **Hand-written tools:**
  - `list_graphs` (readOnly) returns `[{alias, graphName, mode, expiresAt, expiryWarning}]`;
  - `connector_help` (readOnly) returns the usage conventions from spec §7 as fixed text.
- **`mcpHandler(env, ctx)`** in `mcp.ts` returns `createMcpHandler(server)`. It builds the server per request and loads the spec from `connector/vendor/openapi.json` (bundled).
- **`tools-manifest.json`:** a sorted array of `{name, method, path}` for every registered tool. `check-tools-manifest.mjs` regenerates it, and exits 1 with a diff when the committed file differs (a CI gate, so bump PRs show tool changes).

- [ ] **Step 1: Write failing tests:**
  - `tool list contains snake/operationId names for pages/blocks/tasks/tags/properties/search and excludes e2ee, createAsset, getAsset, listGraphs`.
  - `every GET tool readOnlyHint true, every DELETE destructiveHint true`.
  - `create_page on alias routes to /api/v1/graphs/<graph-id>/pages with that graph's PAT` (stub SYNC records the request).
  - `unknown alias fails without any sync call` (Review Focus 3, including an alias removed just before the call).
  - `write tool on read-mode graph refused without sync call`.
  - `401 maps to reconnect message, 429 maps to retry message using Retry-After and makes exactly one sync call` (Review Focus 5).
  - `list_graphs exposes no token`.
  - `manifest check passes on committed manifest and fails after adding a fake operation`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Generate and commit `tools-manifest.json`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(connector): MCP tools for the sync REST API`.

### Task 6: File tools

**Files:**
- Create:
  - `connector/src/tools/assets.ts`, `connector/src/net/safe-fetch.ts`
  - `connector/test/assets.test.ts`

**Interfaces:**
- **`save_document({graph, fileName, text?, base64?, page?})`** (not readOnly; exactly one of `text`/`base64`):
  - computes the size and the SHA-256 hex;
  - calls `POST /api/v1/graphs/<id>/assets` with the `createAsset` query parameters from the vendored spec (read the exact names there) and the body as `application/octet-stream`;
  - if `page` (a page title or UUID) is given, attaches the asset to that page per the API's parameter or a follow-up block insert;
  - rejects inputs over 150,000 characters with a clear message;
  - returns `{assetUuid, fileName, size}`.
- **`save_file_from_url({graph, url, fileName?, page?})`** uses `safeFetch(url, {maxBytes: 26214400, allowTypes})`:
  - `https:` only; every redirect hop re-checked (max 5);
  - hostname not `localhost`/`*.localhost`;
  - IP literals and resolved targets not loopback, private (RFC 1918), link-local, CGNAT, `0.0.0.0/8`, IPv6 ULA or link-local, or metadata (`169.254.169.254`);
  - content-type allow-list from Global Constraints;
  - streams while counting bytes and hashing, aborting past the cap;
  - then uploads as above.
- **`read_file({graph, assetUuid})`** (readOnly):
  - calls `getAsset`, then fetches the signed URL's path and query **through `SYNC`** (its origin is `sync.internal`);
  - returns `text` content for `text/*` and `application/json`, truncated at 150,000 characters with a notice;
  - returns `image` content (base64 and mimeType) for png/jpeg/gif/webp up to 5 MiB;
  - otherwise returns a one-line description `{fileName, type, size}`.

- [ ] **Step 1: Write failing tests:**
  - `save_document computes size and sha256 and sends octet-stream` (assert the stub's received query and body hash).
  - `save_document rejects both or neither of text/base64 and oversize input`.
  - `safeFetch rejects http:, localhost, 127.0.0.1, 10.0.0.1, 169.254.169.254, [::1], fd00::1`.
  - `safeFetch rejects https public URL that redirects to http://169.254.169.254 and to https://localhost` (Review Focus 2).
  - `safeFetch aborts past 25 MiB and rejects disallowed content type`.
  - `read_file returns text, image content, and description for other types; text truncated with notice`.
  - `read_file fetches signed URL through SYNC not public fetch`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(connector): document, URL and read-back file tools`.

### Task 7: Infra and secrets for an optional connector

**Files:**
- Modify:
  - `infra/main.tf`, `infra/outputs.tf`
  - `scripts/init-env.sh`, `scripts/init-env.test.mjs`
  - `.env.local.example`

**Interfaces:**
- **OpenTofu:**
  - `cloudflare_workers_kv_namespace.connector_oauth` (title `logseq-connector-oauth`) and `cloudflare_d1_database.connector` (name from `settings.connector.d1DatabaseName`, `read_replication = { mode = "disabled" }`).
  - Both have `count = local.settings.connector.enabled ? 1 : 0` and `prevent_destroy`.
  - Outputs `connector_oauth_kv_id` and `connector_d1_id` are `sensitive = true`, and `null` when disabled.
- **`init-env.sh --add-missing [--push]`:**
  - with an existing `.env.local`, it appends only the missing names among the original six plus `CONNECTOR_HOSTNAME`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OWNER_GITHUB_USER_ID`, `COOKIE_ENCRYPTION_KEY` and `GRAPH_TOKEN_KEY`;
  - it prompts for inputs (the GitHub client secret is read silently) and generates the two keys with `openssl rand -hex 32`;
  - it never changes existing lines;
  - with `--push`, it pushes only the newly added names to `production` with `-R <repo>`, as the existing push does.
  - Validation: `OWNER_GITHUB_USER_ID` is `^[0-9]+$`, and `CONNECTOR_HOSTNAME` uses the same FQDN rule as `SYNC_HOSTNAME`.
  - A fresh run (no `.env.local`) without `--add-missing` behaves as before and doesn't ask for connector values.

- [ ] **Step 1: Write failing tests** in `scripts/init-env.test.mjs`:
  - `--add-missing appends only missing names, preserves existing bytes, mode 600`.
  - `--add-missing --push pushes only added names with -R`.
  - `--add-missing rejects non-numeric OWNER_GITHUB_USER_ID`.
  - `fresh run unchanged` (the existing tests still pass).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Validate the tofu changes in a temp copy of `infra/` + `config/` (`init -backend=false`, `validate`, `fmt -check`) with `connector.enabled` both `false` and `true`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(infra): optional connector resources and add-missing env setup`.

### Task 8: CI and deploy wiring

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- Create: `scripts/deploy-connector.sh`, `scripts/smoke-connector.sh`, `scripts/smoke-connector.test.mjs`

**Interfaces:**
- **`ci.yml`:** after the upstream build, run `scripts/vendor-upstream-api.sh .upstream`, `npm --prefix connector ci`, `npm --prefix connector test`, `node connector/scripts/check-tools-manifest.mjs`, then render the connector config with placeholders (`--hostname mcp.example.com`, dummy IDs, a settings copy with `enabled: true`) and run `wrangler deploy --dry-run` from `connector/`. It uses no secrets, as now.
- **`scripts/deploy-connector.sh`** (no-op with the message `connector disabled` when `settings.connector.enabled` is false). Otherwise:
  1. requires all connector env;
  2. `tofu output -json`;
  3. emits `::add-mask::` for the KV and D1 IDs when `GITHUB_ACTIONS=true`;
  4. renders the config;
  5. `wrangler d1 migrations apply <d1> --remote`;
  6. `wrangler deploy`;
  7. `wrangler secret bulk` (the five Worker secrets, via a umask-077 temp file);
  8. runs `scripts/smoke-connector.sh https://$CONNECTOR_HOSTNAME`.
- **`smoke-connector.sh <base>`** checks:
  - `oauth-metadata`: `GET /.well-known/oauth-protected-resource/mcp` (or the path the library serves) returns 200 with `resource == <base>/mcp`;
  - `mcp-unauthenticated`: `POST /mcp` returns 401 with a `WWW-Authenticate` header;
  - `wizard-requires-login`: `GET /graphs` returns 302 to `/login`.

  Output format: `ok <name>` / `FAIL <name>: <status>`.
- **`deploy.yml`:** a new step after "Deploy", "Deploy connector", wrapped by `with-r2-credentials.sh`, with only the connector secrets plus the Cloudflare and tofu ones it needs. The existing tofu mask step also masks the connector IDs when present.

- [ ] **Step 1:** Write `scripts/smoke-connector.test.mjs`, following `smoke-test.test.mjs`'s stub-server pattern: a healthy stub passes; `200` on unauthenticated `/mcp` fails; a wrong `resource` fails.
- [ ] **Step 2:** FAIL. **Step 3:** Implement the scripts and the workflow changes. **Step 4:** `OFFLINE=1 npm test`, actionlint and shellcheck are clean. Locally, the dry-run render command from `ci.yml` succeeds.
- [ ] **Step 5: Commit** `ci: build, test and optionally deploy the connector`.

### Task 9: Phase-0 spikes and first deploy (owner-gated)

Record each result in `docs/spike-results.md` under `## Connector`, without identifiers. Each step that touches GitHub, Cloudflare or claude.ai needs the owner's go-ahead at that moment.

- [ ] **Step 1: Owner setup.** The owner:
  - creates a GitHub OAuth app (callback `https://<CONNECTOR_HOSTNAME>/callback`);
  - adds Workers KV Storage Read+Write to the Cloudflare token;
  - runs `scripts/init-env.sh --add-missing --push`;
  - sets `connector.enabled: true` in a PR.
- [ ] **Step 2: C1 (service binding).** After the merge deploys, a tool call (or the wizard's token check) reaches `logseq-sync` over `SYNC`. If the binding fails against the `workers_dev = false` target, **stop and ask the owner** about the public-URL fallback.
- [ ] **Step 3: C2 (claude.ai).** The owner adds the connector in claude.ai and signs in. Record:
  - which client registration was used (CIMD or DCR);
  - that `list_graphs` runs;
  - that a second GitHub account is refused.
- [ ] **Step 4:** The owner connects James through `/graphs`.
- [ ] **Step 5: C3 (Claude Code cloud session).** In a session with only the connector enabled, read a page and create a page in James.
- [ ] **Step 6: C4 (flashcards).** Through the tools, tag a block with `Card`, via `set_block_property` on `:block/tags` or the tag endpoints. Record which works, and that it appears in Logseq's flashcard review. Then update the `connector_help` text in a follow-up commit.
- [ ] **Step 7: C5 (files).** Test `save_document`, `save_file_from_url` (a public PDF) and `read_file` (text and image). Confirm the assets in Logseq.
- [ ] **Step 8: C6 (annotations).** Do read-only tools run without a prompt and deletes prompt, in claude.ai?
- [ ] **Step 9: Commit** `docs: record connector spike results`.

### Task 10: Guide and acceptance

**Files:**
- Modify: `README.md` (new section "11. Use your graphs from Claude", plus table-of-contents, secrets-table and token-permission updates), `docs/spike-results.md`

- [ ] **Step 1:** Write the README section:
  - what the connector is;
  - GitHub OAuth app setup;
  - the token permission addition;
  - `init-env.sh --add-missing --push`;
  - enabling it via `config/settings.json`;
  - adding it in claude.ai (Settings → Connectors → Add custom connector → `https://<CONNECTOR_HOSTNAME>/mcp`);
  - enabling it in Claude Code cloud sessions;
  - the wizard;
  - the file tools and their limits;
  - the Anthropic egress range `160.79.104.0/21` for any WAF rule;
  - the security model (owner-only; tokens encrypted; unencrypted graphs only);
  - troubleshooting for the reconnect, rate-limit and read-only messages.

  Use placeholders only, and check every command against the scripts.
- [ ] **Step 2:** Walk spec §13 acceptance items 1–10 with the owner, and record pass or fail under `## Connector acceptance` in `docs/spike-results.md`.
- [ ] **Step 3: Commit** `docs: guide for the Claude connector`.
