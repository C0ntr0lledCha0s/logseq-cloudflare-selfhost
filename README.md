# logseq-cloudflare-selfhost

Run Logseq's DB sync server (the upstream `deps/db-sync` Cloudflare Worker) on your own Cloudflare account, at a hostname you control such as `https://sync.example.com`. Your Logseq clients sync through it. Remote agents such as Claude Code can read and write your graph through its REST API using a personal access token (PAT).

The repo does not fork Logseq. It pins an upstream commit (`UPSTREAM_REF`), applies one small patch at build time (`patches/`), and deploys with OpenTofu, wrangler and GitHub Actions.

## Contents

- [What you get](#what-you-get)
- [Costs](#costs)
- [Prerequisites](#prerequisites)
- [0. Install nightly Logseq on every device](#0-install-nightly-logseq-on-every-device)
- [1. Bootstrap](#1-bootstrap)
- [2. First deploy](#2-first-deploy)
- [3. Point your clients at the server](#3-point-your-clients-at-the-server)
- [4. Create a personal access token](#4-create-a-personal-access-token)
- [5. Use it from remote Claude Code](#5-use-it-from-remote-claude-code)
- [6. Upgrades](#6-upgrades)
- [7. Backups and restore](#7-backups-and-restore)
- [8. Switching to the paid plan and MCP](#8-switching-to-the-paid-plan-and-mcp)
- [9. Security notes](#9-security-notes)
- [10. Troubleshooting](#10-troubleshooting)
- [Backlog](#backlog)
- [Licence and credits](#licence-and-credits)

## What you get

- **A sync server you own.** The Worker, its Durable Objects (one per graph), the D1 index database and the R2 asset bucket all live in your Cloudflare account. The only public entry point is your custom domain: `workers.dev` and preview URLs are turned off.
- **PATs for your own account.** Upstream only lets accounts in Logseq's internal groups create PATs. The patch in `patches/0001-pat-gate-allow-authenticated-users.patch` lets any signed-in account create, list and revoke its own PATs. That is what makes the REST API usable from scripts and agents.
- **Repeatable deploys.** OpenTofu manages the D1 database and R2 buckets. wrangler deploys the code, bindings, secrets and custom domain. GitHub Actions runs CI, deploys on merge to `main`, opens a weekly upstream bump PR, and takes daily backups.

**What still depends on Logseq the company:**

- **Login.** You still sign in with your Logseq account. Logseq's Cognito user pool issues the tokens, and the Worker fetches Cognito's public keys (JWKS) to verify them.
- **The client's `user_info` call.** On login, the app still calls `api.logseq.com` for account info.
- **Client builds.** You run Logseq's nightly apps. You don't build your own.

Your graph content is not sent to Logseq. The patched server no longer calls `api.logseq.com` at all.

## Costs

| Plan | Price | Notes |
|---|---|---|
| Workers Free (default) | $0 within the free allowances | Verified working, including the REST API and its rate limiters. Daily caps include 100k Worker requests, 100k D1 row writes and 5M D1 row reads. The front Worker gets 10 ms CPU per request. D1 Time Travel covers 7 days. |
| Workers Paid | $5/month plus usage beyond the included amounts | Raises the CPU limit (the config sets 300 s) and enables MCP (Worker Loader). D1 Time Travel covers 30 days. |

R2 is billed separately. It has a monthly free tier, but Cloudflare asks for a payment method before you can enable it. Check Cloudflare's current pricing pages for the exact allowances.

## Prerequisites

- **A Cloudflare account** with a zone (`example.com`) already active on it. The sync hostname (`sync.example.com`) must be in that zone and should not already have a DNS record: wrangler creates the record and the certificate.
- **A payment method** on the Cloudflare account, so R2 can be enabled.
- **A GitHub fork or copy of this repo** (for example `C0ntr0lledCha0s/logseq-cloudflare-selfhost`), with Actions enabled and `main` as the default branch.
- **Locally:** `git`, `curl`, `openssl`, the GitHub CLI `gh`, and [mise](https://mise.jdx.dev). mise installs the pinned toolchain from `mise.toml`: Node 22, pnpm 10.33.0, Java (Temurin 21), the Clojure CLI, OpenTofu 1.10 and rclone.

```bash
git clone https://github.com/C0ntr0lledCha0s/logseq-cloudflare-selfhost.git
cd logseq-cloudflare-selfhost
mise trust && mise install
eval "$(mise activate bash)"   # or zsh; puts node, pnpm, tofu, rclone on PATH
npm ci
```

The commands below assume mise is activated in your shell. Where a command runs through `scripts/with-r2-credentials.sh`, the wrapper itself needs `node` and `curl` on `PATH`.

## 0. Install nightly Logseq on every device

PATs, their settings tab and the matching D1 migration arrived upstream on 2026-10-10. The latest release, 2.0.2 (2026-10-07), predates them. The server is therefore built from upstream `master`, and **every client must run a nightly build** to match it.

| Client | Where to get it | Status |
|---|---|---|
| Desktop (macOS, Windows, Linux) | The `nightly` pre-release on [github.com/logseq/logseq/releases](https://github.com/logseq/logseq/releases/tag/nightly) | Verified |
| Android | The APK attached to the same `nightly` release | Verified |
| Web | Logseq's nightly web build | Verified |
| iOS | No nightly build exists. The App Store release predates PATs. | Untested |

If you rely on iOS, you can't use this server from it until a release ships with PAT support.

## 1. Bootstrap

You do this once. Steps 1.1 to 1.3 happen in the Cloudflare dashboard.

### 1.1 Create the Cloudflare API token

This one account-owned token is the only Cloudflare credential. Create it under **Manage Account → Account API Tokens → Create Token → Custom token**. It needs **two policies**:

| Policy | Resources | Permissions |
|---|---|---|
| Account | Your account | **Workers Admin**; **D1** Write + Read; **Workers R2 Storage** Write + Read |
| Zone | The zone `example.com` | **Workers Routes** Write + Read; **DNS** Write + Read |

- **Why Workers Admin.** It replaces the legacy "Workers Scripts Edit" permission. You need Admin rather than Editor because the first deploy creates the Worker. Scope it to all Workers, because custom domains don't support per-Worker roles.
- **Why two policies.** A token with only the zone policy gives D1 and R2 nothing, and every call fails with `10000: Authentication error`.
- **DNS Write** was granted in the verified setup. It may not be needed, but that hasn't been proven either way.

You don't create separate R2 S3 keys. `scripts/with-r2-credentials.sh` derives them from this token: the access key ID is the token's ID, and the secret is the SHA-256 of the token value. It exports them only to the command it wraps. There are no `R2_*` or `AWS_*` secrets anywhere.

### 1.2 Enable R2

In the dashboard, open **R2** and enable it. This needs a payment method on file. Until you do, R2 API calls fail with `10042: Please enable R2 through the Cloudflare Dashboard`.

For a few minutes after you enable it, connections to `<account-id>.r2.cloudflarestorage.com` fail with a TLS handshake error, because the endpoint isn't provisioned yet. Wait, then retry.

### 1.3 Create the workers.dev subdomain

Open **Workers & Pages** in the dashboard once. That creates your account's `workers.dev` subdomain. Without it, the first deploy fails with `10063: You need a workers.dev subdomain`. The Worker itself doesn't use `workers.dev`.

### 1.4 Fill in `.env.local`

`.env.local` holds the same values the GitHub `production` environment holds, so you can run everything from your machine. It is git-ignored.

```bash
cp .env.local.example .env.local && chmod 600 .env.local
openssl rand -hex 32   # run three times: one value each for ASSET_LINK_SECRET,
                       # DB_SYNC_ADMIN_TOKEN and TOFU_ENCRYPTION_PASSPHRASE
```

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from 1.1 |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Account home → Account ID (`<account-id>`) |
| `ASSET_LINK_SECRET` | Generated. The HMAC key for signed asset links. |
| `DB_SYNC_ADMIN_TOKEN` | Generated. Admin header token. It bypasses graph access checks, and backups use it. |
| `TOFU_ENCRYPTION_PASSPHRASE` | Generated. Encrypts the OpenTofu state and plans. **Store it in a password manager**: without it, the state can't be decrypted. |
| `SYNC_HOSTNAME` | `sync.example.com` (no scheme). It is never committed. |
| `SMOKE_PAT` | Optional. Leave it empty until you have a PAT (section 4). |

**If a value contains `$`, single-quote it** (`NAME='va$lue'`). Otherwise the shell expands it when the file is sourced. The generated hex values are safe as they are.

Load it into each new shell that runs the commands below. OpenTofu reads its two inputs from `TF_VAR_*`:

```bash
set -a && . ./.env.local && set +a
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" \
       TF_VAR_tofu_encryption_passphrase="$TOFU_ENCRYPTION_PASSPHRASE"
```

### 1.5 Fetch and build upstream

This clones `logseq/logseq` at `UPSTREAM_REF` into `.upstream/`, applies the patch, checks that upstream's Worker bindings match `config/expected-bindings.json`, and builds the Worker. It also installs the wrangler version upstream pins, which the next steps use. The first build takes a while.

```bash
scripts/fetch-upstream.sh .upstream        # refuses a non-empty dir: rm -rf .upstream first to refetch
node scripts/check-upstream-bindings.mjs .upstream/deps/db-sync/worker/wrangler.toml
scripts/build.sh .upstream
```

### 1.6 Create the OpenTofu state bucket

OpenTofu keeps its state in an R2 bucket. The bucket can't manage itself, so you create it once by hand. The name `logseq-selfhost-tofu-state` is fixed in `infra/backend.hcl.example` and `deploy.yml`.

```bash
.upstream/deps/db-sync/node_modules/.bin/wrangler r2 bucket create logseq-selfhost-tofu-state
# optional: --location weur|eeur|apac|wnam|enam|oc
```

### 1.7 Initialise and apply OpenTofu

```bash
sed "s/<ACCOUNT_ID>/$CLOUDFLARE_ACCOUNT_ID/" infra/backend.hcl.example > infra/backend.hcl

scripts/with-r2-credentials.sh mise exec -- tofu -chdir=infra init -backend-config=backend.hcl
scripts/with-r2-credentials.sh mise exec -- tofu -chdir=infra plan -out=bootstrap.tfplan
scripts/with-r2-credentials.sh mise exec -- tofu -chdir=infra apply bootstrap.tfplan
```

This creates:

- the D1 database `logseq-sync-index`;
- the R2 buckets `logseq-sync-assets` and `logseq-sync-backups`;
- a lifecycle rule that expires backups after 90 days.

All three resources have `prevent_destroy`. Names and retention come from `config/settings.json`.

`tofu apply` without a plan file asks you to type `yes` interactively. Planning to a file and applying that file, as above, avoids the prompt. Plan files are encrypted too, and `*.tfplan` is git-ignored.

### 1.8 Set up the GitHub `production` environment

`deploy.yml` and `backup.yml` read their secrets from a GitHub environment called `production`. Restrict it to `main`, so no other branch or pull request can use them. Run these from inside your clone; `gh` fills in `{owner}/{repo}`:

```bash
gh api -X PUT 'repos/{owner}/{repo}/environments/production' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST 'repos/{owner}/{repo}/environments/production/deployment-branch-policies' \
  -f name=main -f type=branch
```

Then add the secrets:

| Secret | Required |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Yes |
| `TOFU_ENCRYPTION_PASSPHRASE` | Yes |
| `ASSET_LINK_SECRET` | Yes |
| `DB_SYNC_ADMIN_TOKEN` | Yes |
| `SYNC_HOSTNAME` | Yes |
| `SMOKE_PAT` | Optional. It enables the authenticated smoke check. |

`gh secret set NAME --env production` prompts for the value, so it never lands in your shell history. To copy the values from `.env.local` after loading it as in 1.4 (bash):

```bash
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE \
            ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN SYNC_HOSTNAME; do
  printf '%s' "${!name}" | gh secret set "$name" --env production
done
```

## 2. First deploy

You can deploy either from your machine or from GitHub Actions. Both run the same script, `scripts/deploy.sh`, which:

1. reads the OpenTofu outputs (the D1 database ID);
2. renders upstream's `wrangler.toml` for your account, hostname and plan (`scripts/render-wrangler.mjs`);
3. applies D1 migrations (`wrangler d1 migrations apply logseq-sync-index --remote`) **before** deploying;
4. runs `wrangler deploy`, which also attaches the custom domain;
5. sets `ASSET_LINK_SECRET` and `DB_SYNC_ADMIN_TOKEN` with `wrangler secret bulk`;
6. runs `scripts/smoke-test.sh https://$SYNC_HOSTNAME`.

**From your machine**, with `.env.local` loaded and steps 1.5 and 1.7 done:

```bash
scripts/with-r2-credentials.sh mise exec -- scripts/deploy.sh
```

**From GitHub Actions:** merge to `main`, or run the `deploy` workflow manually (Actions → deploy → Run workflow). The workflow runs `tofu init`, `tofu apply -auto-approve`, fetches, checks and builds upstream, then runs `deploy.sh`.

A passing smoke test prints:

```
ok health
ok openapi
ok unauthenticated-graphs
ok pat-graphs              # only when SMOKE_PAT is set
ok mcp-unauthenticated     # only on the paid plan
```

You can check by hand too: `curl https://sync.example.com/health` returns `{"ok":true}`.

## 3. Point your clients at the server

On each device, running a nightly build (section 0):

- **Desktop and web:** Settings → Advanced → Sync Server URL = `https://sync.example.com`.
- **Mobile:** Settings → Sync Server URL = `https://sync.example.com`.

Then sign in with your Logseq account and create or upload a graph.

**Logging out clears the custom URL.** The client goes back to Logseq's hosted sync. Re-enter the URL after every logout, before you sign in again.

### Encrypted or unencrypted graph?

When you create a graph for sync, you choose whether it is end-to-end encrypted (E2EE). Both sync fine. They differ in who can read the content and in what an agent can do with it.

**"Unencrypted" here means:**

- **Readable at rest on your Cloudflare account by:**
  - anyone with your Cloudflare API token or dashboard access;
  - anyone with a PAT for that graph, or with the `DB_SYNC_ADMIN_TOKEN`;
  - the deployed code;
  - Cloudflare itself.
- **Protected** in transit by TLS, and at rest by Cloudflare's disk encryption.
- **Not sent to Logseq the company.** Other Logseq users can't read your graph either.

**With E2EE,** the server stores page and block titles as ciphertext. Structure is still visible to the server: ordering, tags, property values and references.

**For agent use, choose an unencrypted graph.** On an E2EE graph, the REST API returns titles as `[iv ciphertext]` packages. Server-side search only matches ciphertext, so a plaintext search returns nothing. Writes also need client-side encryption. A client-side decryption MCP is on the backlog.

## 4. Create a personal access token

The **Personal Access Tokens** tab appears in Settings once a custom sync server URL is set (section 3). Each token:

- is **graph-scoped**: one token per graph;
- has permission `read`, `write` or `both`;
- expires after at most one year.

For an agent that reads and writes, choose `both`. The token (`logseq_pat_…`) is shown once. Store it in a password manager.

If you want the authenticated smoke check, store the PAT as `SMOKE_PAT`: in `.env.local`, and with `gh secret set SMOKE_PAT --env production`.

**Fallback without the tab.** You can create a PAT over HTTP using the Cognito ID token from a signed-in client. Find it in the desktop or web devtools: Application → Local Storage → `id-token`. Then:

```bash
read -rs ID_TOKEN   # paste the id-token, then Enter

# Find the graph's id
curl -H "Authorization: Bearer $ID_TOKEN" https://sync.example.com/graphs

# Create the token (expires-at is optional; the default and maximum is one year)
curl -X POST https://sync.example.com/api/v1/personal-access-tokens \
  -H "Authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"graph-id":"…","permission":"both"}'
```

Two more calls on the same path, both with the ID token:

- `GET /api/v1/personal-access-tokens` lists your tokens;
- `DELETE /api/v1/personal-access-tokens/<id>` revokes one.

## 5. Use it from remote Claude Code

In the cloud environment the remote session runs in:

1. **Add the secrets as environment variables:**
   - `LOGSEQ_PAT`: the `logseq_pat_…` token from section 4;
   - `LOGSEQ_BASE_URL`: `https://sync.example.com`.
2. **Allow outbound network access** to `sync.example.com` in the environment's network settings. With a restrictive network policy, add the hostname to the allowed domains.
3. **Add the skill** to the repo the session works in. Copy `skills/logseq-rest-api/SKILL.md` from this repo to `.claude/skills/logseq-rest-api/SKILL.md` there. It's a vendored copy of upstream's skill, and it documents the API's operations, request shapes and E2EE behaviour.

Check access from the session:

```bash
curl -H "Authorization: Bearer $LOGSEQ_PAT" "$LOGSEQ_BASE_URL/api/v1/graphs"
```

`GET $LOGSEQ_BASE_URL/openapi.json` describes all operations. Rate limits are 120 reads and 20 writes per minute per token.

A write round trip has been verified on an unencrypted graph: `createPage` and `insertBlockChildren` from the REST API appeared in both the desktop and web apps through sync.

## 6. Upgrades

`UPSTREAM_REF` pins the upstream `logseq/logseq` commit the server is built from. Every Monday, `bump-upstream.yml`:

1. compares it with upstream `master`;
2. if they differ, runs the full CI build against the new commit (`ci.yml`);
3. opens or updates one PR titled `chore: bump upstream to <sha>`, on a `bump/upstream-<sha>` branch.

You can also run it from Actions → bump-upstream → Run workflow.

**The PR body shows:**

- the CI result. A failing bump still opens a PR, so you can see why it failed;
- the upstream commits that touch `deps/db-sync`;
- any **new D1 migrations**.

**What to look at before merging:**

- **CI failure.** Common causes:
  - the patch no longer applies (`patch failed: 0001-…`);
  - upstream added or removed a binding or var (`unexpected:` / `missing:` from `check-upstream-bindings.mjs`).

  Check what changed upstream, then update the patch, `config/expected-bindings.json` or `render-wrangler.mjs` in a normal PR.
- **New migrations.** They're applied before the new code deploys, and upstream migrations have so far been additive. Read them anyway.
- **Client compatibility.** Keep your nightly clients updated. If a client stops syncing after a bump, update the client or move `UPSTREAM_REF` closer to the client's nightly commit.

**Merging** the PR to `main` deploys it.

**Rolling back code.** List the Worker's versions and roll back to the previous one. Then revert the bump commit on `main`, so the next deploy doesn't roll forward again. Run this from the repo root with `.env.local` loaded:

```bash
W=.upstream/deps/db-sync/node_modules/.bin/wrangler
$W versions list --name logseq-sync
$W rollback <version-id> --name logseq-sync -m "roll back upstream bump"
```

**Rolling back the database.** If a migration went wrong, restore D1 with Time Travel. It covers 7 days on Free and 30 on Paid:

```bash
$W d1 time-travel info logseq-sync-index --timestamp 2026-10-21T12:00:00Z
$W d1 time-travel restore logseq-sync-index --timestamp 2026-10-21T12:00:00Z
```

## 7. Backups and restore

`backup.yml` runs daily at 14:00 UTC, and on demand. It uses the `production` environment and writes to `logseq-sync-backups/<YYYY-MM-DD>/`:

| What | How | Where |
|---|---|---|
| D1 index | `wrangler d1 export … --remote` | `<date>/index.sql` |
| Graph snapshots | Upstream `download_graph_db.js`, using the admin token, one per graph | `<date>/graphs/<n>.sqlite`, plus `<date>/graphs/index.json` mapping `n` to the graph ID |
| Assets | `rclone sync` of `logseq-sync-assets` | `assets/` (a mirror, not dated) |

The lifecycle rule deletes objects older than 90 days (`backupRetentionDays`). The logs show counts only, never graph IDs. The job fails if any part fails.

To run a backup locally, with `.env.local` loaded and `.upstream` built:

```bash
WRANGLER="$PWD/.upstream/deps/db-sync/node_modules/.bin/wrangler" \
  scripts/with-r2-credentials.sh mise exec -- scripts/backup.sh backup-out
```

**Restore:**

- **Graphs.** The real restore path is re-uploading the graph from a desktop client, which holds a full local copy. Upstream has no tool that imports a snapshot back into a Durable Object. The snapshots are SQLite files for inspection and last-resort recovery.
- **D1.** Use Time Travel (section 6) within its window. Beyond that, load an `index.sql` export into a fresh, empty D1 database with `wrangler d1 execute <database> --remote --file index.sql`. The export contains the schema, so it won't load over the existing tables.
- **Assets.** Copy them back from `logseq-sync-backups/assets/` to `logseq-sync-assets`, for example with rclone using the derived R2 credentials.

**Limits.** Backups live in the same Cloudflare account. If you lose the account, only your clients' local copies remain. An off-account copy is on the backlog.

## 8. Switching to the paid plan and MCP

`config/settings.json` has `"plan": "free"` by default. Free is verified working, including the REST API and its rate limiters. The paid plan adds:

- `[limits] cpu_ms = 300000` (300 s);
- the Worker Loader binding (`LOADER`) that `/mcp` needs.

To switch:

1. In the Cloudflare dashboard, subscribe to **Workers Paid**. Do this first: the paid config uses limits and bindings the Free plan doesn't offer.
2. Set `"plan": "paid"` in `config/settings.json` in a PR.
3. Merge it to `main`. The deploy renders the paid config, and the smoke test adds the `mcp-unauthenticated` check: `POST /mcp` without a token must return 401.

MCP on this server hasn't been verified end to end yet. To go back, set `"plan": "free"` and merge.

## 9. Security notes

- **Any Logseq account can use your server** today: sign in, create graphs and create PATs for them. Users can't read each other's graphs, but they do use your quota and storage. A user allow-list is on the backlog.
- **Never set `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`.** It lets anyone impersonate any user. `render-wrangler.mjs` refuses to render a config containing it, or any `SENTRY_*` var.
- **`DB_SYNC_ADMIN_TOKEN` bypasses graph access checks.** It can read every graph. Keep it only in `.env.local` and the `production` environment.
- **The Cloudflare API token** controls everything here, including the derived R2 keys. Treat it like a root password.
- **PATs** are graph-scoped. Give agents the narrowest permission that works, and revoke unused tokens in Settings.
- **Secrets stay out of the repo and the logs.** The repo, the rendered `wrangler.toml` and the logs hold no secrets. The OpenTofu state and plans are encrypted. `deploy.yml` and `backup.yml` never run on pull requests, and `ci.yml` uses no secrets, so fork PRs can't reach them.
- **Your hostname is public.** Certificate transparency logs publish it, and internet scanners start probing a new hostname within hours. You'll see requests for paths like `/.env` in the Worker logs. They're harmless, but expected. Keeping `SYNC_HOSTNAME` out of the repo only avoids advertising it.

**Rotating secrets:**

| Secret | How |
|---|---|
| `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` | Generate a new value. Update `.env.local` and the `production` secret, then redeploy: every deploy re-sets them. Rotating `ASSET_LINK_SECRET` invalidates asset links signed earlier. |
| `CLOUDFLARE_API_TOKEN` | Roll it in the dashboard, then update `.env.local` and the secret. The derived R2 keys change with it automatically. |
| `TOFU_ENCRYPTION_PASSPHRASE` | Changing it needs an OpenTofu key migration (a `fallback` key in `infra/encryption.tf`). Don't just swap the value. |
| A PAT | Revoke it in Settings → Personal Access Tokens and create a new one. Update `LOGSEQ_PAT` and `SMOKE_PAT`. |

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `10000: Authentication error` from D1 or R2 calls | The token's policy doesn't cover account resources. Add the account policy from 1.1. |
| `10042: Please enable R2 through the Cloudflare Dashboard` | Enable R2 (1.2). |
| TLS handshake failure on `<account-id>.r2.cloudflarestorage.com` | You enabled R2 in the last few minutes. Wait and retry. |
| `10063: You need a workers.dev subdomain` | Open Workers & Pages in the dashboard once (1.3). |
| A secret value is wrong or truncated after `. ./.env.local` | It contains `$`. Single-quote it. |
| `with-r2-credentials: CLOUDFLARE_API_TOKEN has unexpected characters` | Stray whitespace, a newline or quotes around the token in `.env.local` or the GitHub secret. |
| `Error acquiring the state lock` | Another `tofu` run, or a cancelled one, holds the lock. Wait for it to finish. If you're sure none is running, use `tofu force-unlock <id>`. |
| `fetch-upstream.sh`: `refusing: .upstream is not empty` | Run `rm -rf .upstream` and fetch again. |
| No Personal Access Tokens tab in Settings | No custom sync server URL is set, or the client isn't a nightly build. Set the URL (section 3). |
| The client syncs to Logseq's servers again | You logged out, which clears the custom URL. Re-enter it, then sign in. |
| `exceededCpu` / "Worker exceeded CPU time limit" in the Worker logs, or sync stalls on large graphs | The Free plan's 10 ms CPU per request is too little. Switch to paid (section 8). |
| `503 {"error":"rate limiter unavailable"}` from `/api/v1/*` | The rate-limit bindings are missing from the deployed config. Check that `rateLimitNamespaces` in `config/settings.json` names both limiters and that `check-upstream-bindings` passes, then redeploy. |
| `429 rate limit exceeded` | The per-token limit is 120 reads or 20 writes per minute. Slow down. |
| `403 forbidden` from the REST API | The PAT belongs to a different graph, or its permission doesn't cover the operation. |
| Smoke test `FAIL health 000` right after the first deploy | The custom domain's certificate is still being issued. Wait a few minutes and re-run `scripts/smoke-test.sh https://sync.example.com`. |

## Backlog

1. **A publish server** at `publish.example.com`. Mobile has no publish URL setting, and rendered pages load from `asset.logseq.com` and jsdelivr.
2. **A user allow-list** by Cognito `sub` on all authenticated routes, failing closed.
3. **MCP** after switching to paid: verify it end to end.
4. **An upstream PR** making the PAT groups configurable, so the patch can be dropped.
5. **An off-account backup copy.**
6. **A client-side decryption MCP** for E2EE graphs, so agents can work with encrypted graphs.
7. **Confirm the minimal token permissions**, in particular whether DNS Write is needed.
8. **Measure a large real graph against the Free CPU limits:** first upload, asset sync and snapshot download.

## Licence and credits

Licensed under **AGPL-3.0-or-later** (see `LICENSE`). The patch is derived from Logseq's AGPL code.

- **[Logseq](https://github.com/logseq/logseq)** wrote the sync server, the clients and the REST API skill vendored in `skills/logseq-rest-api/`. This repo only builds, patches and deploys upstream code.
- **[yshalsager/logseq-selfhost](https://github.com/yshalsager/logseq-selfhost)** had the idea of a pinned upstream ref with a weekly bump. It covers the Docker/Node self-host route. No code was copied from it.
