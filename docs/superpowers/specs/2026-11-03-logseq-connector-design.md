# Logseq connector for Claude — design

Date: 2026-11-03
Owner: C0ntr0lledCha0s
Repo: `logseq-cloudflare-selfhost` (this repo), alongside the sync server

Decisions marked **(owner)** were made by the owner. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them.

## 1. Intent and why

The owner wants to **prompt Claude, in claude.ai or in a Claude Code remote (cloud) session, and have it work in any of their Logseq graphs** with no per-session setup **(owner)**. The main uses **(owner)** are:

- turning transcripts and meeting notes into Logseq-style pages: structured blocks, `[[links]]`, tags, tasks and journal entries;
- keeping notes and documents (pages, blocks, attached files);
- helping with memory flashcards;
- generally, "full connector functionality".

The self-hosted sync server is already live (see the 2026-10-21 design and `docs/spike-results.md`). It exposes a REST API authenticated by graph-scoped personal access tokens (PATs). Claude can't use it directly from claude.ai:

- claude.ai connectors need a remote MCP server with an OAuth sign-in;
- upstream's built-in `/mcp` needs the paid plan and Logseq's Cognito sign-in, which rejects Claude's callback.

The deliverable is a **second Worker, the "connector"**. It is a remote MCP server that the owner adds once as a claude.ai custom connector. It holds the PATs and calls the sync server privately.

**All graphs used with the connector are unencrypted (owner).** This followed research showing that Logseq's E2EE only protects the server copy. It doesn't protect devices, and the connector would need graph keys to read encrypted graphs.

## 2. Goals, non-goals, anti-goals

**Goals**

- **One connector, added once.** It works in claude.ai on web, desktop and mobile, and in Claude Code cloud sessions, which inherit claude.ai connectors. Per-session setup is just enabling it.
- **Only the owner can use it.** Sign-in is OAuth via GitHub, restricted to the owner's GitHub user ID.
- **Full functionality.**
  - One tool per sync-server REST operation, covering pages, blocks, block trees, moves, properties (single and batch), tags, tasks, capture-to-today, search and assets.
  - A `list_graphs` tool.
  - Claude addresses graphs **by name**, not ID.
- **A "Connect a graph" wizard (owner).** It's a web page on the connector, behind the same GitHub sign-in. The owner pastes a PAT created in Logseq.
  - The connector validates the PAT against the sync server and shows the graph name, permission and expiry.
  - It refuses E2EE graphs and stores the PAT encrypted.
  - The same page manages graphs: rename (the name Claude uses), read-only or read-write, replace the token, disconnect, and expiry warnings within 30 days.
- **Least privilege by default (call).** Every tool carries MCP annotations:
  - `GET` operations are `readOnlyHint: true`, so they run without prompting;
  - `DELETE` operations are `destructiveHint: true`, so they always prompt;
  - other writes are non-destructive.
  A graph marked read-only rejects write tools at the connector.
- **Stays current with upstream.** Tools are generated at build time from the sync server's OpenAPI document at the pinned `UPSTREAM_REF`. The weekly bump PR therefore updates tools automatically, and CI fails if generation breaks.
- **Same operational model as the sync server.** Free plan, OpenTofu for stateful resources, wrangler for code, GitHub Actions deploy on merge to `main`, no owner identifiers in the repo.

**Non-goals**

- E2EE graphs (refused by the wizard).
- Multiple users or sharing.
- Writing flashcard review results back into Logseq's spaced-repetition schedule. Reviews happen in Logseq. Claude may quiz in chat by reading cards.
- iOS (no nightly app).
- Upstream's `/mcp` endpoint (stays unused; the free plan has no Worker Loader).
- Replacing the sync server's PAT mechanism.

**Anti-goals** (failure even if it "works")

- **PATs reaching Claude or a conversation.** No tool ever returns a token. The wizard is the only place a token is entered, and never in chat.
- **Anyone but the owner using the connector**, including other GitHub users and other Logseq accounts.
- **Graph content in logs.** Log tool name, graph alias and status only.
- **Owner identifiers committed:** domain, account ID, GitHub user ID, graph names.
- **Patching more of Logseq.**

## 3. Verified facts this design relies on

All of these come from research on 2026-11-03.

**Claude side** (claude.com/docs/connectors/*, code.claude.com/docs/en/mcp.md, cloud-environments.md)

- **Connectors.** Custom connectors use Streamable HTTP. They are available on Free (one custom connector), Pro, Max, Ultra, Team and Enterprise.
- **Auth.** OAuth 2.1 with PKCE S256. Client registration can use Claude's CIMD, DCR, or a fixed client ID and secret.
  - Discovery is RFC 9728 protected-resource metadata, served via `401` with `WWW-Authenticate: Bearer resource_metadata=…`. Its `resource` must exactly match the server URL, and only the first `authorization_servers` entry is used.
  - The authorization server must provide RFC 8414 (or OIDC) metadata.
  - The token endpoint accepts form-urlencoded bodies.
  - Timeouts: 10 s for discovery, registration and token calls; 30 s for refresh.
- **Callbacks.** `https://claude.ai/api/mcp/auth_callback` for the hosted apps. Claude Code uses a loopback redirect on any port.
- **Egress.** Anthropic's egress range is 160.79.104.0/21. Allow it in any Cloudflare WAF or bot rule.
- **Limits.** About 150k characters per tool result and a 240 s per-call timeout on claude.ai. Claude Code warns at 10k tokens and caps at 25k by default.
- **Claude Code cloud sessions** receive claude.ai connectors from the host. They are enabled per session, and the traffic goes via Anthropic, so the environment needs no network allow-list.
- **Annotations.** `readOnlyHint` and `destructiveHint` drive auto-permissions in the connector directory. Whether they do so for unlisted custom connectors is **unverified**. Users can set per-tool Always allow, Needs approval or Blocked either way.

**Cloudflare side** (developers.cloudflare.com/agents/*, github.com/cloudflare/workers-oauth-provider, github.com/cloudflare/ai/tree/main/demos)

- **Recommended stack.** `createMcpHandler` (`agents/mcp/server`) with MCP SDK v2 (`@modelcontextprotocol/server`). It is stateless, needs no Durable Objects, and fits the Free plan. `McpAgent` is deprecated and feature-frozen.
- **Auth library.** `@cloudflare/workers-oauth-provider` supports DCR (`clientRegistrationEndpoint`) and CIMD (`clientIdMetadataDocumentEnabled`, which requires the compatibility flag `global_fetch_strictly_public`). It stores grants and tokens hashed in KV (`OAUTH_KV`). The user identity reaches tools via `getMcpAuthContext()`, from the `props` passed to `completeAuthorization()`.
- **Template.** `cloudflare/ai` `demos/remote-mcp-github-oauth` uses a GitHub upstream sign-in. There's no built-in single-user setting, so the allow-list check goes in `/callback` before `completeAuthorization()`.
- **Service bindings.** Same account only, no extra cost, no documented Free-plan restriction. Whether a target with `workers_dev = false` works is **unverified** (spike C1).
- **KV Free limits.** 100k reads/day, 1k writes/day, 1 GB. Ample for one user.

**Logseq side** (source at `UPSTREAM_REF`)

- **REST API.** 39 operations, listed in `GET /openapi.json` (upstream `deps/db-sync`, built by `pnpm build:api-docs`).
- **Rate limits.** 120 reads/min and 20 writes/min.
- **Page links on plain graphs.** The server extracts `[[Page]]` references from titles written via the API (`deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs:338`).
- **Flashcards.** A block becomes a flashcard when tagged with the built-in class `:logseq.class/Card` (`deps/db/src/logseq/db/frontend/class.cljs:58-60`). The schedule lives in `:logseq.property.fsrs/*`. Tagging via the REST API is **unverified** (spike C4).
- **PATs** are graph-scoped (`read`, `write` or `both`) and expire in at most one year. Logseq issues them only from a signed-in client, so the connector can't mint them.
- **E2EE detection.** `GET /api/v1/graphs` returns `graph-e2ee?` per graph.

## 4. Architecture

```
claude.ai (web/desktop/mobile) ─┐
Claude Code cloud session ──────┤  (via Anthropic, 160.79.104.0/21)
                                ▼
            https://mcp.example.com   — Worker "logseq-connector"
              ├─ /mcp                  MCP (Streamable HTTP), OAuth-protected
              ├─ /.well-known/…        RFC 9728 / RFC 8414 metadata
              ├─ /authorize /token /register (/callback → GitHub)
              ├─ /graphs               "Connect a graph" wizard (GitHub-session protected)
              ├─ KV OAUTH_KV           OAuth grants/tokens (hashed)
              ├─ D1 logseq-connector   connected graphs: alias, graph-id, mode, expiry, PAT (AES-GCM encrypted)
              └─ service binding SYNC ─▶ Worker "logseq-sync" (existing; /api/v1/*, PAT bearer)
Owner's browser ──(GitHub login)──▶ /graphs wizard
```

- **Hostname.** `CONNECTOR_HOSTNAME` (e.g. `mcp.example.com`), a custom domain in the same zone. It is never committed: it lives in `.env.local` and the `production` secret `CONNECTOR_HOSTNAME`, the same pattern as `SYNC_HOSTNAME` **(call)**. `workers_dev = false`.
- **One Worker (call)** using the single-Worker `OAuthProvider` layout from the template. Cloudflare's two-Worker auth/resource split is unnecessary for one user. The builder may split it if the library's current guidance requires it.
- **Calls to the sync server** go over the service binding `SYNC`, with `Authorization: Bearer <PAT>`, and never over the public hostname. If spike C1 shows bindings can't reach a `workers_dev = false` custom-domain Worker, fall back to `fetch("https://$SYNC_HOSTNAME/…")`. **The owner decides that fallback.**
- **Stateless MCP (call):** `createMcpHandler` with no Durable Objects.

## 5. Identity and sessions

- **GitHub OAuth app.** The owner creates it once, with callback `https://<CONNECTOR_HOSTNAME>/callback`. Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `COOKIE_ENCRYPTION_KEY` (generated).
- **Allow-list.** `OWNER_GITHUB_USER_ID` is a secret holding the numeric ID, so it isn't committed. `/callback` rejects any other user ID **before** `completeAuthorization()`, and the wizard's own session check does the same. The comparison uses the numeric ID, not the username, because usernames can change **(call)**.
- **MCP client registration.** Enable both DCR and CIMD, which claude.ai supports either way. Allow only redirect URIs `https://claude.ai/api/mcp/auth_callback` and loopback (`http://localhost:*`, `http://127.0.0.1:*`) **(call)**.
- **The wizard** uses the same GitHub sign-in with a signed, encrypted, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie, and CSRF protection on every state-changing form **(call)**.

## 6. The "Connect a graph" wizard

At `/graphs`, behind the GitHub sign-in. All state changes are POST with CSRF.

1. **List** the connected graphs. Each shows its alias, the Logseq graph name, read-only or read-write, the token's permission and expiry, and last-used time. Expiry within 30 days shows a warning.
2. **Connect a graph.** The page shows instructions: Logseq (nightly) → Settings → Personal Access Tokens → create a token for the graph, permission `both` (or `read` for read-only use). Then the owner pastes the token. The connector:
   1. calls `GET /api/v1/graphs` through `SYNC` with the PAT;
   2. expects exactly one graph (PATs are graph-scoped);
   3. **refuses** the graph if `graph-e2ee?` is true;
   4. records the graph ID, graph name and permission, plus the expiry the owner enters (see 5);
   5. shows a confirmation screen with an editable alias (default: the graph name, slugged) and a read-only or read-write choice;
   6. saves.
3. **Edit** the alias or mode, **replace** the token (re-validated, and it must be the same graph ID), and **disconnect**, which deletes the stored token. The page reminds the owner to also revoke the token in Logseq.
4. **Token storage.** Graphs live in a **D1 database** `logseq-connector` (table `graphs`), not KV. KV is eventually consistent for about 60 s across locations, and disconnect, read-only and token replacement must take effect immediately **(call, from builder check)**. Each PAT is AES-GCM encrypted with a random IV, under the key `GRAPH_TOKEN_KEY` (a 32-byte secret, generated). The key ID is stored alongside, to allow rotation later. No row ever holds a plaintext token. **Tokens are never displayed again after saving (call).** Schema changes go through D1 migrations under `connector/migrations/`, applied before deploy, the same pattern as the sync server.
5. **Expiry.** A PAT can't read its own expiry (the token-list endpoint needs a Logseq sign-in). So the wizard asks for the expiry date shown in Logseq when the token was created, or records "unknown".

## 7. MCP tools

- **Generated at build time** from the sync server's OpenAPI document: `worker/dist/openapi.json` from the upstream build at `UPSTREAM_REF`, the same artifact deployed to the sync server.
  - Each operation becomes one tool, named after its `operationId` in snake_case, e.g. `create_page`.
  - The input schema comes from the path and query parameters plus the request body, except `graph-id`, which is replaced by a required `graph` (alias) string.
  - The description comes from the OpenAPI summary.
  - Annotations come from the HTTP method (section 2).
  - The generator lives in `connector/scripts/`. CI runs it and fails on unknown shapes.
- **Excluded:** `/e2ee/*` operations (no encrypted graphs) and `createAsset`/`getAsset`, which are replaced by the asset tools below **(call)**. The generated `listGraphs` is dropped in favour of the hand-written `list_graphs`.
- **Reuse:** start from upstream's OpenAPI-to-MCP generator `deps/db-sync/worker/semantic_api_tools.mjs` at `UPSTREAM_REF`, rather than writing one from scratch **(call)**.
- **Asset tools (owner: all three in v1).** They are hand-written, because `createAsset` needs a raw `application/octet-stream` body with an exact `size` and SHA-256 `checksum` (`deps/db-sync/src/logseq/db_sync/worker/routes/semantic.cljs`, `asset-upload-parameters`), and `getAsset` returns only a 5-minute signed URL (`worker/asset_link.cljs`).
  - **`save_document`**: takes text (Markdown or plain, utf-8) or base64 bytes, a file name, and an optional page to attach to. The connector computes the size and checksum and calls `createAsset` through `SYNC`. Input is capped by claude.ai's argument limit of about 150k characters; reject anything larger with a clear message.
  - **`save_file_from_url`**: takes an `https://` URL, a file name and an optional page. The connector fetches the URL server-side with SSRF protection: https only, no private, loopback, link-local or Cloudflare-internal addresses, and redirects capped and re-checked. It enforces a size cap (the builder picks one; suggest 25 MiB) and an allow-list of content types, streams the file while hashing, then uploads.
  - **`read_file`**: takes the asset's block UUID. The connector calls `getAsset`, fetches the bytes through `SYNC`, and returns them as MCP content: text for text types (truncated with a notice beyond the result limits), image content for images, and a short description otherwise. Claude never needs to open the signed link.
- **Hand-written tools:**
  - `list_graphs`: aliases, Logseq names, modes and expiry status, and nothing secret.
  - `connector_help`: one paragraph on usage conventions (see below), so Claude writes well-formed Logseq content.
- **Routing.** The tool resolves the alias to a graph ID and PAT, calls `SYNC`, and returns the JSON body. Errors are mapped to clear text:
  - `401`/`403`: "token for graph X expired or lacks permission — reconnect it at /graphs";
  - `429`: rate-limited, retry after N s;
  - `400`: the server's message.
- **Read-only graphs** reject write tools before any call.
- **Result size.** Large list results are paginated using the API's own pagination, so claude.ai results stay under about 150k characters and Claude Code results under its token caps.
- **Usage conventions** (`connector_help` and tool descriptions):
  - prefer `insertBlockTree` for whole meeting notes, which is one write call instead of many;
  - use `[[Page]]` in titles for links;
  - tasks via `createTask`;
  - today's journal via `captureToToday`;
  - flashcards via the Card tag (see spike C4).

Rate limits (20 writes/min) make batching important for transcripts.

## 8. Repo layout (call)

```
connector/
  package.json, package-lock.json, tsconfig.json
  wrangler.template.jsonc        # rendered with hostname + KV ids + service binding, like render-wrangler for the sync server
  src/index.ts                   # OAuthProvider + routes
  src/github.ts                  # upstream GitHub sign-in + allow-list
  src/wizard/*.ts                # /graphs pages (server-rendered HTML, no client framework)
  src/graphs.ts                  # D1 graphs store, AES-GCM token crypto
  src/tools/assets.ts            # save_document, save_file_from_url, read_file
  migrations/                    # connector D1 migrations
  src/tools/generated.ts         # generated from openapi.json (committed? see 11)
  src/tools/handwritten.ts
  scripts/generate-tools.mjs
  test/*.test.ts                 # vitest + @cloudflare/vitest-pool-workers (builder may choose)
infra/                           # + KV OAUTH_KV and D1 logseq-connector (count = connector.enabled), prevent_destroy
scripts/render-connector-wrangler.mjs
.github/workflows/deploy.yml     # + connector deploy after sync deploy; ci.yml + connector build/test/dry-run
```

**TypeScript (call).** The Cloudflare SDKs and template are TypeScript, and the connector doesn't touch upstream ClojureScript.

## 9. Secrets and config additions

| Name | Where | Source |
|---|---|---|
| `CONNECTOR_HOSTNAME` | `.env.local`, `production` secret | owner (e.g. `mcp.example.com`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `.env.local`, `production` secret → Worker secrets | owner creates GitHub OAuth app |
| `OWNER_GITHUB_USER_ID` | `.env.local`, `production` secret → Worker secret | owner (numeric id; `gh api user -q .id`) |
| `COOKIE_ENCRYPTION_KEY`, `GRAPH_TOKEN_KEY` | `.env.local`, `production` secret → Worker secrets | generated by `scripts/init-env.sh` |

- **`init-env.sh`** gains the new prompts and generators. `--push` includes them.
- **The Cloudflare API token needs KV permissions (call):** Account → Workers KV Storage Write and Read, for `OAUTH_KV`. OpenTofu creates the KV namespace and the connector D1 database (`prevent_destroy` on both). README 1.1 and `.env.local.example` are updated.
- **`init-env.sh --add-missing` (call, from builder check).** It works on an existing `.env.local`: it prompts only for missing inputs, generates only missing secrets, never overwrites existing values, and with `--push` pushes only the newly added names. A fresh run behaves as before.

## 10. Operations

- **Optional component (call, from builder check).** `config/settings.json` gains `"connector": {"enabled": false}`. When it's `false`, CI still builds and tests the connector, but `deploy.yml` skips deploying it and OpenTofu skips its resources (`count`). When it's `true`, every connector secret is required, and a missing one fails the deploy loudly. The flag is explicit, not inferred from whether secrets are present. The owner sets it to `true` only after creating the GitHub OAuth app, adding the KV permissions to the token, and pushing the new secrets, so merging the connector never breaks an existing deploy.
- **Deploy.** `deploy.yml` deploys the sync server first, then the connector (when enabled). The connector deploy renders its config, `wrangler deploy`s it, sets secrets with `secret bulk`, and smoke-tests it:
  - `GET /.well-known/oauth-protected-resource` returns 200 with the exact `resource`;
  - unauthenticated `POST /mcp` returns 401 with `WWW-Authenticate`;
  - `/graphs` without a session redirects to GitHub.
- **Upstream bumps** regenerate the tools in CI. New or removed operations show up in the bump PR's diff if `generated.ts` is committed (section 11).
- **Backups.** The connector D1 holds only aliases, IDs, modes and encrypted PATs. PATs can be re-issued from Logseq, so it isn't backed up **(call)**; the README says so. D1 Time Travel covers accidents.
- **Logs.** Tool name, graph alias, status and duration only. No arguments, results or tokens.

## 11. Open points left to the builder

- Whether `src/tools/generated.ts` is committed, giving a reviewable diff in bump PRs (recommended), or generated at build time only.
- The exact current versions of `agents`, `@modelcontextprotocol/server` and `@cloudflare/workers-oauth-provider`, pinned in `package-lock.json`.
- The test framework and HTML templating approach.

## 12. Phase-0 spikes (before building the full thing)

- **C1. Service binding.** A tiny Worker binds to `logseq-sync` and calls `GET /health`. Does it work while the target has `workers_dev = false` and only a custom domain? If not, **the owner decides** on the public-URL fallback.
- **C2. claude.ai end to end.** A minimal connector built from `remote-mcp-github-oauth`, with the allow-list and one `echo` tool, deployed to `CONNECTOR_HOSTNAME`:
  - add it as a custom connector in claude.ai;
  - confirm the sign-in, that another GitHub account is refused, and that the tool runs;
  - check which client registration claude.ai used (CIMD or DCR).
- **C3. Claude Code cloud session.** Enable the C2 connector in a Claude Code web session and confirm the tool runs with no environment setup.
- **C4. Card tagging.** Via the REST API with a PAT on a plain graph, tag a block with `Card` (`setBlockProperty` on `:block/tags`, or the tags endpoints). Confirm it appears in Logseq's flashcard review.
- **C5. Assets.** Test `save_document` (Markdown), `save_file_from_url` (a public PDF) and `read_file` (text and image) against a plain graph, through the service binding. Check that the asset shows in Logseq, and whether `getAsset`'s signed URL is fetchable through `SYNC`, given the URL's origin comes from the request. Note the practical size limits.
- **C6. Annotations.** Do `readOnlyHint` and `destructiveHint` change claude.ai's prompting for an unlisted custom connector?

Record the results in `docs/spike-results.md` under a "Connector" heading.

## 13. Acceptance

1. **claude.ai (web and mobile):** with the connector enabled, "list my Logseq graphs" returns the connected graphs by alias.
2. **A pasted meeting transcript** becomes a meeting page with structured blocks, `[[links]]` to people and projects, tasks for actions, and a journal entry. It is visible in the Logseq desktop app after sync.
3. **"Make flashcards from this page"** creates Card-tagged blocks that appear in Logseq's flashcard review.
4. **A Claude Code cloud session**, with the connector enabled and nothing else configured, reads and edits a page.
5. **The wizard:**
   - connecting a plain graph works;
   - an E2EE graph's token is refused;
   - a graph set to read-only blocks writes;
   - disconnecting removes access immediately.
6. **A second GitHub account** can't sign in to `/mcp` or `/graphs`.
7. **No PAT, hostname, account ID or graph name** appears in the repo or in public Actions logs.
8. **The deploy smoke checks pass** in `deploy.yml`.
9. **Files:** a Markdown document Claude writes and a PDF from a URL are both attached to a page and visible in Logseq, and Claude can read back a stored text file and an image.
10. **Optional flag:** with `connector.enabled = false`, deploys behave exactly as before.
