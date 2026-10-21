# Logseq DB sync on your own Cloudflare account — design

Date: 2026-10-21
Owner: C0ntr0lledCha0s
Repo: `logseq-cloudflare-selfhost` (new, separate from the Logseq fork)

Decisions marked **(owner)** were made by the repo owner. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them.

## 1. Intent and why

The owner wants **remote Claude Code sessions to read and write their Logseq DB graph**.

Logseq's semantic REST API is served by the db-sync worker. Calling it from outside the app needs a personal access token (`logseq_pat_…`), and the upstream server only lets accounts in Logseq's internal Cognito groups `team` / `rtc_2025_07_10` create one. The owner's account is not in either group (checked: there is no "Personal Access Tokens" tab in Settings when no custom server is set). Logseq's hosted service is therefore closed to them.

Self-hosting the sync server on the owner's own Cloudflare account, with one small build-time patch, fixes that. As a side benefit, the graph data lives on infrastructure the owner controls.

The deliverable is a new GitHub repo containing:

- infrastructure-as-code;
- a build/deploy pipeline;
- a clear step-by-step guide.

**Logseq itself is not changed.** The repo pins an upstream commit and applies its patch at build time.

**Client builds (owner): nightly on every device.**

- PATs arrived in upstream on 2026-10-10 (d24abc91df, #13019). That is after the latest release, `2.0.2` (2026-10-07), which has neither the PAT endpoints, the PAT settings tab, nor migration 0007.
- The server must therefore be built from master/nightly. All of the owner's clients (desktop and mobile) run nightly builds so they match it.

**Repo visibility (owner): public.**

## 2. Goals, non-goals, anti-goals

**Goals (v1)**

- Deploy the upstream `deps/db-sync` Cloudflare worker to the owner's account at `https://sync.example.com` **(owner)**.
- Desktop and mobile Logseq sync through it using the owner's existing Logseq account. Login stays with Logseq's Cognito **(owner, confirmed by source)**.
- The owner can create a PAT in the desktop app. A remote Claude Code session can then use the REST API with that PAT **(owner)**.
- Repeatable, reviewable deploys:
  - OpenTofu for the stateful Cloudflare resources **(owner: OpenTofu, not Terraform)**;
  - wrangler for code;
  - GitHub Actions to run both.
- A one-switch `plan = free | paid` setting. v1 starts on the **Workers Free plan** **(owner)**.
- Pulling upstream changes is routine:
  - a weekly bump PR;
  - fail-fast checks;
  - migrations applied before deploy.
- Scheduled backups of the D1 index, graph snapshots and assets.

**Non-goals (v1)** — tracked in the backlog (section 13):

- The publish server (`deps/publish`) **(owner: backlog)**.
- A user allow-list **(owner: backlog)**. The owner will first test whether a different Logseq account can use the server.
- MCP. It needs the paid plan (Dynamic Workers). Claude uses the REST API first **(owner)**.
- Replacing Cognito or running our own identity provider. That would need a client fork.
- The Node.js / Docker self-host route. `yshalsager/logseq-selfhost` already covers it.

**Anti-goals** (would make this a failure even if it "works"):

- Committing secrets, or putting them in OpenTofu state unencrypted.
- Setting `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`. It allows impersonating any user (upstream `deps/db-sync/src/logseq/db_sync/worker/auth.cljs:59-87`). The pipeline must hard-fail if this variable appears in the generated config.
- Silent drift from upstream: deploying a build where the patch half-applied, or where upstream added a binding we didn't provide.
- A fork of Logseq to maintain. Patches stay tiny and few.
- Using OpenTofu `destroy` or replacement in a way that can delete D1/R2 data.

## 3. Verified facts from upstream (authority: source at the pinned commit)

All facts below are from `logseq/logseq` master as of 2026-10-21 (`69da7e2215b336cc5123dafb2a1686996e39596c`, the owner's fork HEAD). That is the **initial pin (call)**.

**Build**

- `deps/db-sync`, `pnpm release` = `clojure -M:cljs release db-sync`.
- Output: `worker/dist/worker/main.js`.
- `deps.edn` uses `:local/root` deps on `../common`, `../db` and `../outliner`, so a **full upstream checkout is required**.
- Toolchain: Java, the Clojure CLI, Node 22 and pnpm 10.33.0 (`packageManager`).
- `pnpm build:api-docs` also runs and needs `redocly` (a devDependency). It produces `worker/dist/api-docs.generated.mjs`, which `worker/entry.mjs` imports.

**Deploy entry**

- `worker/wrangler.toml` sets `main = "entry.mjs"`, `compatibility_date = "2026-07-11"` and `nodejs_compat`.
- `entry.mjs` wraps the cljs worker and adds `/mcp`, `/openapi.json` and `/api-docs`.

**Bindings**

| Binding | What it is | Requirement |
|---|---|---|
| `LOGSEQ_SYNC_DO` | DO class `SyncDO`, sqlite. DO migration `tag="v1" new_sqlite_classes=["SyncDO"]` | Required |
| `LOGSEQ_SYNC_ASSETS` | R2 bucket | Required |
| `DB` | D1 database | Required |
| `SEMANTIC_READ_RATE_LIMITER` (120/60s), `SEMANTIC_WRITE_RATE_LIMITER` (20/60s) | Rate limiters | Required for `/api/v1/*`, else 503 "rate limiter unavailable" (`dispatch.cljs:91-93,144-149`) |
| `LOADER` | Worker Loader | Only for `/mcp` (`entry.mjs:73-79`) |
| `CF_VERSION_METADATA` | Version metadata | — |

- The `[limits] cpu_ms = 300000` setting is paid-only.

**Vars and secrets**

- **Required vars:**
  - `COGNITO_ISSUER = https://cognito-idp.us-east-1.amazonaws.com/us-east-1_dtagLnju8`
  - `COGNITO_JWKS_URL = <issuer>/.well-known/jwks.json`
  - `COGNITO_CLIENT_ID = 69cs1lgme7p8kbgld8n5kseii6`
- **Secrets:**
  - `ASSET_LINK_SECRET`: HMAC for signed asset links.
  - `DB_SYNC_ADMIN_TOKEN`: header `x-db-sync-admin-token`. It bypasses graph access checks and is used by the backup script.
- **Sentry:** disabled when `SENTRY_DSN` is blank (`src/logseq/db_sync/sentry.cljs:11-15`), so we omit all `SENTRY_*`.
- **Omitted:** `COGNITO_CLIENT_IDS` and `OPENAI_APPS_CHALLENGE` **(call)**.

**D1 migrations**

- Files: `worker/migrations/0001…0007`.
- Applied with `wrangler d1 migrations apply <db> --remote`. The worker does not create schema at runtime.

**Auth**

- JWTs are verified against the env vars above, using RS256, `iss`, `aud`/`client_id`, `exp` and `kid`.
- The semantic API requires scope `logseq/read` / `logseq/write` (`dispatch.cljs:117`). Cognito desktop tokens don't carry these scopes; PATs do.

**The PAT gate (the thing we patch)**

- File: `src/logseq/db_sync/worker/handler/personal_access_token.cljs:13-47`.
- `<rtc-user?` requires `cognito:groups` ∩ `#{"team" "rtc_2025_07_10"}`.
- With no groups claim, it POSTs the caller's bearer token to `https://api.logseq.com/file-sync/user_info`.

**Client side**

- The desktop/web PAT tab shows whenever a custom sync URL is set. Upstream code:
  - `src/main/frontend/handler/user.cljs:357-361` (`rtc-group?`);
  - `src/main/frontend/components/settings.cljs:1780`.
- So **no client patch is needed**.
- The custom sync URL is set in Settings → Advanced → Sync Server URL (desktop/web) and Settings → Sync Server URL (mobile).
- `logout` clears localStorage, which **erases the custom URL** (`user.cljs:308-311`).
- The client still calls `api.logseq.com/file-sync/user_info` on login. That's fine, because we keep Logseq accounts.

**Other**

- `GET /health` returns `{"ok":true}` (`dispatch.cljs:201`).
- Backup helper: `worker/scripts/download_graph_db.js --base-url <url> --graph-id <id> --admin-token <t>` calls `GET /sync/<graph>/snapshot/download`.
- No upstream workflow deploys the workers (the `deploy-*.yml` workflows deploy the web app only).

**Prior art**

- `yshalsager/logseq-selfhost` (AGPL-3.0): Docker, Node adapter, and the worker run under local wrangler.
- Patterns we borrow (ideas only, no code):
  - an `UPSTREAM_REF` file;
  - a weekly bump workflow;
  - smoke tests.
- Forum report (discuss.logseq.com t/34881 post 6) confirms OAuth-based MCP from Claude fails against Logseq's Cognito. That's why we use PATs.

## 4. Architecture

```
Logseq desktop / mobile ──(Cognito id-token, wss + https)──▶ sync.example.com
Remote Claude Code ───────(Bearer logseq_pat_…, https)─────▶        │  (Workers custom domain)
                                                                    ▼
                                                     Worker "logseq-sync" (entry.mjs + cljs)
                                                       ├─ DO SyncDO (one sqlite DO per graph)
                                                       ├─ D1 logseq-sync-index
                                                       ├─ R2 logseq-sync-assets
                                                       └─ rate limiters (namespace 1001/1002)
Login: Logseq's Cognito (unchanged) — JWKS fetched by the worker.
Backups: GitHub Actions (scheduled) ──▶ R2 logseq-sync-backups (+ lifecycle expiry)
```

**Ownership split (call):**

- **OpenTofu owns stateful, long-lived resources:**
  - D1 `logseq-sync-index`;
  - R2 `logseq-sync-assets`;
  - R2 `logseq-sync-backups`, with a lifecycle rule expiring objects after 90 days **(call)**.

  All of these get `lifecycle { prevent_destroy = true }`.
- **wrangler owns everything tied to a code version:**
  - the script;
  - DO class and migrations;
  - bindings;
  - vars and secrets;
  - the custom domain, via `routes = [{ pattern = "sync.example.com", custom_domain = true }]`.

  Reason: `cloudflare_workers_custom_domain` needs the script to exist first, which creates an awkward two-phase apply. wrangler already handles it declaratively.
- `workers_dev = false` and `preview_urls = false`, so the only public entry point is the custom domain **(call)**.
- The zone `example.com` already exists on Cloudflare (verified: the zone exists on Cloudflare). It is referenced as data, never managed.

## 5. Repo layout (call)

```
logseq-cloudflare-selfhost/
  README.md                      # the step-by-step guide (section 11)
  LICENSE                        # AGPL-3.0-or-later (call: patches are derived from AGPL Logseq code)
  UPSTREAM_REF                   # pinned logseq/logseq commit SHA, one line
  config/settings.json           # plan, hostname, resource names, rate-limit namespace ids
  config/expected-bindings.json  # binding/var names we expect upstream's wrangler.toml to declare
  patches/0001-pat-gate-allow-authenticated-users.patch
  infra/                         # OpenTofu: providers.tf, backend.tf, encryption.tf, main.tf, outputs.tf
  scripts/
    fetch-upstream.sh            # clone logseq/logseq at UPSTREAM_REF, apply patches (git apply --check first)
    check-upstream-bindings.mjs  # compare upstream wrangler.toml to expected-bindings.json; fail on diff
    render-wrangler.mjs          # settings.json + tofu outputs → wrangler.toml written into upstream/deps/db-sync/worker/
    smoke-test.sh
    backup.sh
  skills/logseq-rest-api/SKILL.md  # vendored copy from upstream .agents/skills, for remote Claude sessions
  .github/workflows/
    ci.yml          # PRs: fetch+patch, binding check, build, render, `wrangler deploy --dry-run`
    deploy.yml      # main / manual: tofu apply → build → migrations → deploy → secrets → smoke test
    bump-upstream.yml  # weekly: update UPSTREAM_REF to logseq/logseq master HEAD, open PR
    backup.yml      # daily
  mise.toml         # pins java, clojure, node 22, pnpm 10.33.0, opentofu, for local runs
  docs/superpowers/specs/  # this document
```

- `UPSTREAM_REF` tracks **`logseq/logseq` master** directly, not the owner's fork **(call)**.
- The rendered `wrangler.toml` **replaces** upstream's file inside the checkout. That way `main = "entry.mjs"` and the default `migrations_dir` resolve unchanged.

## 6. The patch

`patches/0001-pat-gate-allow-authenticated-users.patch` changes only `deps/db-sync/src/logseq/db_sync/worker/handler/personal_access_token.cljs`:

- **Removed:**
  - the `rtc-groups` check;
  - the `user-info-url` fetch (so no tokens are sent to `api.logseq.com` by the server).
- **New rule:** any caller with a verified Cognito JWT may create, list and revoke their own PATs **(call)**. This matches the server being open to any Logseq account in v1. The backlog allow-list would restrict both together.
- **Fail-fast:** `fetch-upstream.sh` runs `git apply --check` and aborts the build if the patch doesn't apply cleanly. There is no `--3way` and no fuzz.
- **Tests:** ideally extend or adjust the upstream unit test for this handler in the same patch, if one exists. Left to the builder.
- **Upstream PR:** optional and later — make the allowed groups an env var. That would let the repo drop the patch.

## 7. Plan switch

`config/settings.json` → `"plan": "free" | "paid"`, default **`"free"` (owner)**. `render-wrangler.mjs` does:

| | free | paid |
|---|---|---|
| `[limits] cpu_ms = 300000` | omitted | included |
| `[[worker_loaders]] binding = "LOADER"` | omitted | included |
| smoke test `/mcp` | skipped | required |
| rate limiters, DO, D1, R2, version_metadata | included | included |

- Switching to paid also requires subscribing to Workers Paid ($5/mo) in the dashboard. The guide covers this.
- **Free-plan facts:**
  - The front worker gets 10 ms CPU per request.
  - DOs get 30 s per request/message.
  - Daily caps: 100k Worker requests, D1 100k row writes / 5M reads.
  - D1 Time Travel covers 7 days (30 on paid).
- **Signals to move to paid:** CPU-exceeded errors in worker logs, or wanting MCP.

## 8. OpenTofu

- **Provider:** `cloudflare/cloudflare` (v5) from the OpenTofu registry. OpenTofu ≥ 1.10.
- **State backend:** S3 backend pointed at an R2 bucket `logseq-selfhost-tofu-state`.
  - The bucket is created **manually once** during bootstrap, since it can't manage itself.
  - Use `skip_credentials_validation`, `skip_region_validation`, `skip_requesting_account_id`, `skip_s3_checksum` and `use_path_style`, plus the R2 endpoint.
  - Locking: `use_lockfile = true` if R2 honours conditional writes (spike item S4). Otherwise no locking. That's acceptable for a single operator, and CI serialises deploys with a `concurrency` group.
- **State encryption:** OpenTofu native `encryption` block, `pbkdf2` key provider, passphrase from `TF_VAR`/env (`TOFU_ENCRYPTION_PASSPHRASE`), covering both state and plan. State holds no secrets today, but encryption is on from day one.
- **Inputs:** `cloudflare_account_id`. **Outputs:** `d1_database_id`, bucket names.
- `prevent_destroy` on all data resources.

## 9. Secrets

**Manual bootstrap** (documented in the guide):

1. Cloudflare API token, scoped to the account and the zone:
   - Workers Scripts:Edit;
   - Workers Routes:Edit (zone);
   - D1:Edit;
   - Workers R2 Storage:Edit;
   - DNS:Edit (zone, for custom domain records);
   - Account Settings:Read.

   The builder verifies the minimal set during the spike.
2. R2 S3 API credentials (access key id and secret). These are used by the OpenTofu backend and by backups for asset copying.
3. Three generated values (`openssl rand -hex 32`):
   - `ASSET_LINK_SECRET`;
   - `DB_SYNC_ADMIN_TOKEN`;
   - `TOFU_ENCRYPTION_PASSPHRASE`.

**Storage**

- **GitHub Actions secrets:**
  - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
  - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`;
  - `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN`, `TOFU_ENCRYPTION_PASSPHRASE`.
- **Worker secrets:** set on each deploy with `wrangler secret bulk` from the GitHub secrets. This is idempotent.
- Nothing secret is in the repo, the rendered toml, or logs.
- `render-wrangler.mjs` refuses to emit `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS` or any `SENTRY_*` key.

## 10. Pipelines, upgrades, backups

**ci.yml (PRs)**

1. Fetch upstream at `UPSTREAM_REF` (shallow fetch of that SHA, full tree).
2. Patch check.
3. `check-upstream-bindings`: fail if upstream's `wrangler.toml` declares a binding, var, DO class, or `[[migrations]]` tag not listed in `expected-bindings.json`. This forces a human look at new upstream requirements.
4. `pnpm install --frozen-lockfile` in `deps/db-sync`.
5. `pnpm release`.
6. `pnpm build:api-docs`.
7. Render the toml.
8. `wrangler deploy --dry-run`.

**deploy.yml (push to main, manual dispatch)**

1. `concurrency: deploy`.
2. `tofu apply`.
3. Build (as in CI).
4. Render the toml with tofu outputs.
5. `wrangler d1 migrations apply logseq-sync-index --remote`. This runs **before** deploy; upstream migrations are additive.
6. `wrangler deploy`.
7. `wrangler secret bulk`.
8. `smoke-test.sh`.

**Rollback:**

- Code: `wrangler rollback`.
- Schema: D1 Time Travel restore.

**bump-upstream.yml (weekly + manual)**

1. Resolve `logseq/logseq` master HEAD.
2. Write `UPSTREAM_REF`.
3. **Run the CI checks inline**: call `ci.yml` as a reusable workflow against the new ref. **(call)** A PR opened with the default `GITHUB_TOKEN` does not trigger `ci.yml`, so the gate must run here. No extra credential is needed.
4. Open a PR with the default token. The PR body:
   - states the CI result;
   - lists the upstream commits touching `deps/db-sync` (`git log --oneline <old>..<new> -- deps/db-sync`);
   - highlights any new files under `worker/migrations/`.

   If CI failed, the PR still opens, marked as failing, so the owner sees why.
5. The owner merges, and the merge deploys.

**Public-repo safeguards (call)**

- `deploy.yml` and `backup.yml` run only on `push` to `main`, `schedule` or `workflow_dispatch`, never on `pull_request` / `pull_request_target`.
- Their secrets live in a GitHub **environment** `production`, restricted to the `main` branch.
- `ci.yml` uses no secrets. `wrangler deploy --dry-run` needs no auth. Fork PRs therefore never see secrets.
- Logs never print graph ids, user ids, tokens or bucket object keys. `backup.sh` logs counts only and masks values with `::add-mask::` where unavoidable.

**smoke-test.sh**

- `GET /health` returns `{"ok":true}`.
- `GET /openapi.json` returns 200.
- `GET /api/v1/graphs` without a token returns 401.
- If the `SMOKE_PAT` secret is set: `GET /api/v1/graphs` with the PAT returns 200.
- Paid only: `/mcp` responds.

**backup.yml (daily, call)**

1. `wrangler d1 export logseq-sync-index --remote --output index-<date>.sql`.
2. List graph ids with `wrangler d1 execute … --command "select graph_id from graphs" --json`. For each one, run upstream `download_graph_db.js --base-url https://sync.example.com` with the admin token.
3. Mirror `logseq-sync-assets` into `logseq-sync-backups/assets/` with rclone, using the R2 S3 credentials.
4. Upload steps 1–2 to `logseq-sync-backups/<date>/`.

**Restore story** (documented honestly):

- **D1:** Time Travel, or import the SQL export.
- **Graphs:** the real restore path is re-uploading from a desktop client, which holds a full local copy. Snapshots are for inspection and disaster recovery, since upstream has no "import snapshot into DO" tool.
- **Assets:** copy back from the backup bucket.
- Backups live in the same Cloudflare account. Account-level loss is mitigated only by the clients' local copies. Noted as accepted for v1 **(call)**.

## 11. The guide (README) — required sections

1. **What you get and what still depends on Logseq.** Login, `user_info`, and the Cognito JWKS still do.
2. **Costs.** Free plan: $0 within the caps. Paid: $5/mo.
3. **Bootstrap.** Manual steps from section 9, the state bucket, and GitHub secrets.
4. **First deploy.** Run `deploy.yml`, then verify the smoke test.
5. **Point clients at it.**
   - Desktop/web: Settings → Advanced → Sync Server URL = `https://sync.example.com`.
   - Mobile: Settings → Sync Server URL.
   - **Re-enter after any logout.**
   - Create or upload a graph **without end-to-end encryption** for Claude use. Encrypted graphs work for sync, but REST writes then need client-side encryption.
0. **Install nightly Logseq builds on every device** (desktop and mobile), and say where to get them. A release build (≤ 2.0.2) predates PATs.
6. **Create a PAT.** Settings → Personal Access Tokens, permission `both`, expiry ≤ 1 year.
   - Store it as `SMOKE_PAT` if you want the authenticated smoke test.
   - **Fallback (call):** if the tab isn't available, create the PAT with `curl -X POST https://sync.example.com/api/v1/personal-access-tokens`, using the Cognito `id-token` from a logged-in desktop session (devtools → localStorage `id-token`). The builder confirms the request body against upstream `personal_access_token.cljs`.
7. **Use from remote Claude Code.**
   - Put `LOGSEQ_PAT` and `LOGSEQ_BASE_URL` in the cloud environment's secrets/env.
   - Allow outbound network access to `sync.example.com` in the environment's network settings.
   - Add the vendored `skills/logseq-rest-api` to the repo the session works in.
   - Include a curl example (`GET /api/v1/graphs`).
8. **Upgrades.** What the weekly PR shows, what to look at, how to merge, and how to roll back.
9. **Backups and restore.**
10. **Switching to paid / enabling MCP.**
11. **Security notes.**
    - Any Logseq account can currently use the server (allow-list in the backlog).
    - Never set `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`.
    - The admin token is all-powerful; how to rotate secrets.
12. **Troubleshooting.**
    - CPU-exceeded errors.
    - 503 "rate limiter unavailable".
    - Clients drifting back to Logseq Sync after logout.
    - The PAT tab is missing because no custom URL is set.

## 12. Risks and the phase-0 spike

The builder's **first task is a manual spike on the owner's account, on the Free plan**. It resolves these before writing the pipelines:

- **S1:** Does `wrangler deploy` succeed on Free with the rendered toml (no `limits`, no `worker_loaders`)? Does importing `@cloudflare/codemode` without a `LOADER` binding break anything outside `/mcp`?
- **S2:** Are rate-limit bindings available on Free? Cloudflare's docs list no plan restriction, but this is unverified. If not, the REST API returns 503 on Free and the plan default has to change. **That decision goes back to the owner.**
- **S3:** Can a real graph (the owner's) do its first upload, then sync and assets, without front-worker CPU-exceeded errors on Free? Does `snapshot/download` (used by backups) stay within limits?
- **S4:** Does R2 support OpenTofu's `use_lockfile` conditional writes?
- **S5:** Do the owner's nightly desktop and mobile builds sync against a server built from the pinned master commit? Clients are nightly by owner decision, so a release-client mismatch is not a concern. Pinning to a release tag is **not** an option, because it has no PATs.
  - If a nightly client is older or newer than the pinned server in a way that breaks sync, move `UPSTREAM_REF` closer to the client's nightly commit.
  - **Mobile risk:** nightly builds are easy on Android but harder on iOS (TestFlight, if Logseq offers one). The guide should say what the owner does if iOS can't run nightly.

Other risks:

- Upstream can change protocol, bindings or migrations at any time. That's mitigated by the binding check, the pinned ref and the bump PR.
- Logseq could change its Cognito pool or client id. The fix is updating the three vars.
- The server is open to any Logseq account until the allow-list exists. The owner will test this.

## 13. Backlog

1. Publish server at `publish.example.com`. Note: mobile has no publish URL setting; rendered pages load from `asset.logseq.com` and jsdelivr.
2. A user allow-list (Cognito `sub`) on all authenticated routes, fail-closed. It depends on the owner's test of whether a second Logseq account can use the server.
3. MCP after switching to paid.
4. An upstream PR making the PAT groups configurable, so the patch can be dropped.
5. Off-account backup copy.

## 14. Left to the builder

- Exact GitHub Actions versions and setup actions (Java distribution/version, Clojure CLI install, pnpm via corepack or `pnpm/action-setup`).
- The minimal API-token permission set (verified during the spike).
- Script implementation details, logging, and how `render-wrangler.mjs` is tested. A small snapshot test of rendered free/paid output is expected.
- The wrangler version: whatever upstream `deps/db-sync` pins, so it's ≥ 4.36 for rate limits.

## 15. Acceptance (v1 done)

1. `deploy.yml` runs green from a clean account plus the bootstrap steps, and the smoke test passes.
2. Desktop and mobile sync a new unencrypted graph through `sync.example.com`. Edits appear on the other device.
3. The owner creates a PAT in a nightly desktop build (or via the curl fallback). This proves the patch, because the unpatched server would refuse.
4. `curl -H "Authorization: Bearer $PAT" https://sync.example.com/api/v1/graphs` lists the graph.
5. A page created through REST appears in desktop.
6. A remote Claude Code session, following the README, reads and writes the graph.
7. `backup.yml` produces a D1 export, graph snapshots and an assets mirror in `logseq-sync-backups`.
8. A bump PR to a newer upstream SHA passes CI or fails with a clear message.
