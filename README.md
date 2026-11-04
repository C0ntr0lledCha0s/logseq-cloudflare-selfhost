# logseq-cloudflare-selfhost

Run Logseq's DB sync server (the upstream `deps/db-sync` Cloudflare Worker) on your own Cloudflare account, at a hostname you control such as `https://sync.example.com`. Your Logseq clients sync through it. Remote agents such as Claude Code can read and write your graph through its REST API using a personal access token (PAT). An optional second Worker, the connector, lets claude.ai and Claude Code cloud sessions work in your graphs with no per-session setup (section 11).

The repo does not fork Logseq. It pins an upstream commit (`UPSTREAM_REF`), applies eleven small patches at build time (`patches/`), and deploys with OpenTofu, wrangler and GitHub Actions.

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
- [11. Use your graphs from Claude](#11-use-your-graphs-from-claude)
- [Backlog](#backlog)
- [Licence and credits](#licence-and-credits)

## What you get

- **A sync server you own.** The Worker, its Durable Objects (one per graph), the D1 index database and the R2 asset bucket all live in your Cloudflare account. The only public entry point is your custom domain: `workers.dev` and preview URLs are turned off.
- **PATs for your own account.** Upstream only lets accounts in Logseq's internal groups create PATs. The patch in `patches/0001-pat-gate-allow-authenticated-users.patch` lets any signed-in account create, list and revoke its own PATs. That is what makes the REST API usable from scripts and agents.
- **Property values in the REST API.** Upstream's `getPage` and `getBlock` return only a page's or block's title and position. `patches/0002-semantic-get-returns-tags-and-properties.patch` adds its tags and its user and library property values (e.g. `schema.property/genre`), so Claude can read them through the connector. Built-in `logseq.*` properties are left out.
- **Pages as readable outlines.** `patches/0003-semantic-page-outline.patch` adds `getPageOutline` (the connector's `get_page_outline`). It returns a page's tags, its property values and its whole block tree as a markdown outline, in one call, with `[[links]]` shown as page titles instead of UUIDs. It refuses E2EE graphs.
- **Search that finds pages.** Upstream's `searchGraph` returns pages under the `blocks` type, sorted after every block that mentions them, and ignores unknown `types` values. `patches/0004-semantic-search-pages-and-ranking.patch` adds a `pages` type, rejects unknown types with a 400, and ranks an exact title match first, then pages, tags, properties and assets, then blocks.
- **Batch errors that say what's wrong.** Upstream's `batchSetBlockProperty` and `batchDeleteBlockProperty` answer every rejected batch with `invalid batch property entry`, whether `entries` is missing, isn't an array, or one entry names a block, property or value that doesn't exist. `patches/0005-semantic-batch-property-errors.patch` returns `entries must be a non-empty array` for the first case and `entry <index>: <reason>` for the others. A rejected batch still writes nothing.
- **Inline tags that tag.** Upstream stores `#Tag` in a block written through the API as plain text, so the block never gets the tag, unlike the same text typed in the editor. `patches/0006-semantic-inline-tags.patch` resolves `#Tag` and `#[[Multi Word Tag]]` in inserted and updated block titles to an existing tag (exact title first, then a unique case-insensitive match) and stores them as the editor does, as `#[[uuid]]` with the tag set on the block. Anything else after a `#`, such as an issue number, a URL fragment or an unknown name, stays plain text, and tags Logseq refuses inline (page, property and other built-in kinds) are skipped.
- **Text property values.** Upstream accepts only an existing entity as the value of a text (default-type) property such as *Description*, so a plain string fails, and text that happens to match a page title links that page and then fails Logseq's schema check with a 500. `patches/0007-semantic-text-property-values.patch` stores a plain string, or an array of strings for a multi-value property, in a new value block as the editor does. Text is never looked up by title; a UUID still references an existing value. Properties with fixed choices, such as Status, are unchanged, and encrypted graphs still need an existing entity.
- **Order keys that don't collide.** Some outliner writes, such as property value blocks and new pages, take the next order key after a process-wide maximum. Clients seed that maximum from the graph when they load it; upstream's Worker never does, so API writes can reuse an order key a sibling already holds, and a client later moves one of the blocks. `patches/0008-seed-order-key-for-server-writes.patch` seeds it from the graph on every semantic API request. It also fixes `get-max-order`, which returned another attribute's value on a graph with no ordered blocks.
- **Moves that land where they say.** Upstream's `moveBlocks` maps `before` and `after` to outliner options that address the target's children, so `before` made the block the target's first child and `after` its last child (or first, when it had none). `patches/0009-semantic-move-before-after.patch` makes `after` the target's next sibling and `before` its previous sibling (the first child of its parent when it has none), and refuses `before` and `after` on a page.
- **Page blocks without property values.** A page's text and URL property values are stored as blocks under the page, and upstream's `listPageBlocks` returned them among the page's top-level blocks, although the outline and block children leave them out. `patches/0010-semantic-page-blocks-skip-property-values.patch` leaves them out of `listPageBlocks` too; they stay readable by UUID.
- **Writes that don't duplicate or destroy by surprise.** Upstream's `createPage` and `createTag` accept a title another page, tag or property already has, so a case variant becomes a second page and `createTag` silently turns a same-named page into a tag; its `deletePage`, `deleteTag` and `deleteProperty` act at once, however much links to what they delete. `patches/0011-semantic-write-guards.patch` refuses a title already used by a page, journal, tag or property, compared ignoring case as Logseq compares page names, with a 409 that names each one's kind, title and UUID; a page in the Recycle bin is restored instead, and E2EE graphs aren't checked. The three deletes refuse with a 409 while they would lose references, tag holders, child tags or property values, unless the matching `acknowledge-references`, `acknowledge-holders`, `acknowledge-child-tags` or `acknowledge-values` query flag is `true`, and `dry-run=true` returns the counts without deleting. `deleteBlock` refuses pages, tags and properties, so the guards can't be bypassed.
- **Repeatable deploys.** OpenTofu manages the D1 database and R2 buckets. wrangler deploys the code, bindings, secrets and custom domain. GitHub Actions runs CI, deploys on merge to `main`, opens a weekly upstream bump PR, and takes daily backups.

**What still depends on Logseq the company:**

- **Login.** You still sign in with your Logseq account. Logseq's Cognito user pool issues the tokens, and the Worker fetches Cognito's public keys (JWKS) to verify them.
- **The client's `user_info` call.** On login, the app still calls `api.logseq.com` for account info.
- **Client builds.** You run Logseq's nightly apps. You don't build your own.

Your graph content is not sent to Logseq. The patched server no longer calls `api.logseq.com` at all.

## Costs

| Plan | Price | Notes |
|---|---|---|
| Workers Free (default) | $0 within the free allowances | Verified working, including the REST API and its rate limiters. Daily caps include 100k Worker requests, 100k D1 row writes and 5M D1 row reads. The front Worker gets 10 ms CPU per request. In testing, the median request used 2.6 ms and the slowest 1% used up to 92 ms, but Cloudflare didn't reject them. Larger imports may hit the limit (see Troubleshooting). D1 Time Travel covers 7 days. |
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

The commands below assume mise is activated in your shell. `mise activate` only works in interactive shells. In scripts or other non-interactive shells, prefix commands with `mise exec --` instead, as several examples below do. Where a command runs through `scripts/with-r2-credentials.sh`, the wrapper itself needs `node` and `curl` on `PATH`.

## 0. Install nightly Logseq on every device

PATs, their settings tab and the matching D1 migration arrived upstream on 2026-10-10. The latest release, 2.0.2 (2026-10-07), predates them. The server is therefore built from upstream `master`, and **every client must run a nightly build** to match it.

| Client | Where to get it | Status |
|---|---|---|
| Desktop (macOS, Windows, Linux) | The `nightly` pre-release on [github.com/logseq/logseq/releases](https://github.com/logseq/logseq/releases/tag/nightly) | Verified |
| Android | The APK attached to the same `nightly` release | Verified |
| Web | `https://app.logseq.com` | Verified (signed in and synced against the self-hosted server via Settings → Advanced → Sync Server URL) |
| iOS | No nightly build exists. The App Store release predates PATs. | Untested |

If you rely on iOS, you can't use this server from it until a release ships with PAT support.

## 1. Bootstrap

You do this once. Steps 1.1 to 1.3 happen in the Cloudflare dashboard.

### 1.1 Create the Cloudflare API token

This one account-owned token is the only Cloudflare credential. Create it under **Manage Account → Account API Tokens → Create Token → Custom token**. It needs **two policies**:

| Policy | Resources | Permissions |
|---|---|---|
| Account | Your account | **Workers Admin**; **D1** Write + Read; **Workers R2 Storage** Write + Read; **Workers KV Storage** Write + Read |
| Zone | The zone `example.com` | **Workers Routes** Write + Read; **DNS** Write + Read |

- **Why Workers Admin.** It replaces the legacy "Workers Scripts Edit" permission. You need Admin rather than Editor because the first deploy creates the Worker. Scope it to all Workers, because custom domains don't support per-Worker roles.
- **Why two policies.** A token with only the zone policy gives D1 and R2 nothing, and every call fails with `10000: Authentication error`.
- **Workers KV Storage** is only used by the optional connector (section 11), for its OAuth store. Add it before you enable the connector; a token without it can't create the KV namespace.
- **DNS Write** was granted in the verified setup. It may not be needed, but that hasn't been proven either way.

You don't create separate R2 S3 keys. `scripts/with-r2-credentials.sh` derives them from this token: the access key ID is the token's ID, and the secret is the SHA-256 of the token value. It exports them only to the command it wraps. There are no `R2_*` or `AWS_*` secrets anywhere.

### 1.2 Enable R2

In the dashboard, open **R2** and enable it. This needs a payment method on file. Until you do, R2 API calls fail with `10042: Please enable R2 through the Cloudflare Dashboard`.

For a few minutes after you enable it, connections to `<account-id>.r2.cloudflarestorage.com` fail with a TLS handshake error, because the endpoint isn't provisioned yet. Wait, then retry.

### 1.3 Create the workers.dev subdomain

Open **Workers & Pages** in the dashboard once. That creates your account's `workers.dev` subdomain. Without it, the first deploy fails with `10063: You need a workers.dev subdomain`. The Worker itself doesn't use `workers.dev`.

### 1.4 Fill in `.env.local`

`.env.local` holds the same values the GitHub `production` environment holds, so you can run everything from your machine. It is git-ignored.

**You supply only three things: the Cloudflare API token, the Cloudflare account ID, and your hostname. The other three values are generated.**

```bash
scripts/init-env.sh
```

It asks for those three (the token is read silently), generates the rest with `openssl rand -hex 32`, writes `.env.local` with mode 600 and prints no secret values. It refuses to run if `.env.local` already exists, so move an old one aside first. To skip the prompts, export `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `SYNC_HOSTNAME` beforehand.

The optional connector's values aren't asked for here. You add them later with `scripts/init-env.sh --add-missing` (section 11).

**Copy `TOFU_ENCRYPTION_PASSPHRASE` from `.env.local` into a password manager now.** It encrypts the OpenTofu state and plans. Without it the state can't be decrypted.

| Name | Value | Source |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from 1.1 | You supply |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Account home → Account ID (`<account-id>`) | You supply |
| `SYNC_HOSTNAME` | A fully qualified hostname such as `sync.example.com` (no scheme). It is never committed. | You supply |
| `ASSET_LINK_SECRET` | The HMAC key for signed asset links. | Generated |
| `DB_SYNC_ADMIN_TOKEN` | Admin header token. It bypasses graph access checks, and backups use it. | Generated |
| `TOFU_ENCRYPTION_PASSPHRASE` | Encrypts the OpenTofu state and plans. | Generated |
| `SMOKE_PAT` | Optional. Leave it empty until you have a PAT (section 4). | Later |
| `CONNECTOR_ENABLED` | `false` until you turn the connector on (section 11). | Template |

Manual fallback: `cp .env.local.example .env.local && chmod 600 .env.local`, then fill it in, using `openssl rand -hex 32` for each generated value. **If you hand-edit a value containing `$`, single-quote it** (`NAME='va$lue'`), otherwise the shell expands it when the file is sourced. Generated hex values are safe as they are.

Load it into each new shell that runs the commands below. OpenTofu reads its three inputs from `TF_VAR_*`:

```bash
set -a && . ./.env.local && set +a
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID" \
       TF_VAR_tofu_encryption_passphrase="$TOFU_ENCRYPTION_PASSPHRASE" \
       TF_VAR_connector_enabled="${CONNECTOR_ENABLED:-false}"
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
- a lifecycle rule that expires dated backups (`daily/`) after 90 days.

All three resources have `prevent_destroy`. Names and retention come from `config/settings.json`. Once you enable the connector (section 11), OpenTofu also creates its KV namespace `logseq-connector-oauth` and D1 database `logseq-connector`, both with `prevent_destroy` too.

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

Because every push to `main` deploys, also protect `main` with the ruleset in [`.github/rulesets/protect-main.json`](.github/rulesets/protect-main.json). It blocks deletion and force pushes, requires a pull request, and requires the `check` CI job to pass. Repository admins can still bypass it through a pull request. The weekly bump PRs are opened with the default token, so their `pull_request` CI run waits for approval (it shows as "action required" and can be ignored). The bump workflow starts `ci` on the PR branch with `workflow_dispatch` instead, and that run supplies the required `check` status. Import it via **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, or:

```bash
gh api -X POST 'repos/{owner}/{repo}/rulesets' --input .github/rulesets/protect-main.json
```

Allow the weekly bump workflow to open its pull request: **Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create and approve pull requests"**. Or:

```bash
gh api -X PUT 'repos/{owner}/{repo}/actions/permissions/workflow' \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
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
| `CONNECTOR_HOSTNAME` | Only with the connector (section 11) |
| `CONNECTOR_GITHUB_CLIENT_ID` | Only with the connector. `.env.local` calls it `GITHUB_CLIENT_ID`. |
| `CONNECTOR_GITHUB_CLIENT_SECRET` | Only with the connector. `.env.local` calls it `GITHUB_CLIENT_SECRET`. |
| `OWNER_GITHUB_USER_ID` | Only with the connector |
| `COOKIE_ENCRYPTION_KEY` | Only with the connector |
| `GRAPH_TOKEN_KEY` | Only with the connector |

**One setting is a variable, not a secret.** `CONNECTOR_ENABLED` turns the optional connector on (section 11). Leave it unset for now: unset means off.

**Two secrets are renamed on the way.** GitHub forbids secret names that start with `GITHUB_`, so the OAuth app's client ID and secret are stored as `CONNECTOR_GITHUB_CLIENT_ID` and `CONNECTOR_GITHUB_CLIENT_SECRET`. `.env.local` keeps the `GITHUB_*` names, which are the names the connector Worker uses; `init-env.sh --push` and `deploy.yml` translate between them.

The easiest way is `scripts/init-env.sh --push`. It does 1.4 and then sets the six required secrets above in the `production` environment of the repo that owns your checkout (it prints the repo name first and passes it to `gh` with `-R`), passing each value on stdin only. Run it after the `production` environment exists (the commands above) and `gh` is logged in. The connector's secrets are pushed later, by `scripts/init-env.sh --add-missing --push` (section 11).

If `.env.local` already exists, or a push failed part-way, load `.env.local` as in 1.4 and copy the values with this loop (bash). The values never land in your shell history or in `gh`'s arguments. Uncomment the second `names` line once the connector's values are in `.env.local`:

```bash
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # run inside this checkout
echo "Pushing to $repo"
names="CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN SYNC_HOSTNAME"
# names="$names CONNECTOR_HOSTNAME GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET OWNER_GITHUB_USER_ID COOKIE_ENCRYPTION_KEY GRAPH_TOKEN_KEY"
for name in $names; do
  [ -n "${!name}" ] || { echo "$name is empty: load .env.local first" >&2; break; }
  secret="$name"
  case "$name" in GITHUB_CLIENT_ID | GITHUB_CLIENT_SECRET) secret="CONNECTOR_$name" ;; esac
  printf '%s' "${!name}" | gh secret set "$secret" --env production -R "$repo"
done
```

## 2. First deploy

You can deploy either from your machine or from GitHub Actions; both have been verified. Both run the same script, `scripts/deploy.sh`, which:

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

**A local deploy ships whatever is in your `.upstream` checkout.** After merging a bump PR, run `rm -rf .upstream` and redo 1.5 before deploying locally, or you'll roll the server back to the older upstream commit.

**From GitHub Actions:** merge to `main`, or run the `deploy` workflow manually (Actions → deploy → Run workflow). The workflow runs `tofu init`, `tofu apply -auto-approve`, fetches, checks and builds upstream, then runs `deploy.sh`. It then runs `scripts/deploy-connector.sh`, which prints `connector disabled` and does nothing until you enable the connector (section 11).

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

**Naming with several graphs.** Make one token per graph and name each `PAT_<GRAPH>` in upper snake case, for example `PAT_JOURNAL` and `PAT_WORK`, in your password manager and in `.env.local` (see the commented examples in `.env.local.example`). `SMOKE_PAT` is just whichever one of them the smoke test should use: in `.env.local`, and with `gh secret set SMOKE_PAT --env production`.

**Fallback without the tab.** You can create a PAT over HTTP using the Cognito ID token from a signed-in client. Find it in the desktop or web devtools: Application → Local Storage → `id-token`. Then:

The token goes to curl as a config file on stdin (`-K -`), so it never appears in the process list (`ps`). The repo's scripts do the same.

```bash
read -rs ID_TOKEN   # paste the id-token, then Enter

# Find the graph's id
printf 'header = "Authorization: Bearer %s"\n' "$ID_TOKEN" |
  curl -sS -K - https://sync.example.com/graphs

# Create the token (expires-at is optional; the default and maximum is one year)
printf 'header = "Authorization: Bearer %s"\n' "$ID_TOKEN" |
  curl -sS -K - -X POST https://sync.example.com/api/v1/personal-access-tokens \
    -H 'content-type: application/json' \
    -d '{"graph-id":"…","permission":"both"}'
```

Two more calls on the same path, both with the ID token:

- `GET /api/v1/personal-access-tokens` lists your tokens;
- `DELETE /api/v1/personal-access-tokens/<id>` revokes one.

## 5. Use it from remote Claude Code

This section gives a cloud session raw REST access with a PAT in its environment. The connector (section 11) is the alternative: it needs no secrets, network settings or skill in the environment, and also works in claude.ai.

In the cloud environment the remote session runs in:

1. **Add the secrets as environment variables:**
   - `LOGSEQ_PAT`: the `logseq_pat_…` token from section 4 for your default graph. With several graphs, add one `LOGSEQ_PAT_<GRAPH>` per graph instead (for example `LOGSEQ_PAT_JOURNAL`, matching `PAT_JOURNAL`);
   - `LOGSEQ_BASE_URL`: `https://sync.example.com`, shared by all of them.
2. **Allow outbound network access** to `sync.example.com` in the environment's network settings. With a restrictive network policy, add the hostname to the allowed domains.
3. **Add the skill** to the repo the session works in. Copy `skills/logseq-rest-api/SKILL.md` from this repo to `.claude/skills/logseq-rest-api/SKILL.md` there. It's a vendored copy of upstream's skill, and it documents the API's operations, request shapes and E2EE behaviour.

Check access from the session:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$LOGSEQ_PAT" |
  curl -sS -K - "$LOGSEQ_BASE_URL/api/v1/graphs"
```

The shorter `curl -H "Authorization: Bearer $LOGSEQ_PAT" "$LOGSEQ_BASE_URL/api/v1/graphs"` also works. The trade-off is that it puts the token on the command line, where other processes in the environment can see it in `ps`.

`GET $LOGSEQ_BASE_URL/openapi.json` describes all operations. Rate limits are 120 reads and 20 writes per minute.

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
  - upstream added or removed a binding or var (`unexpected:` / `missing:` from `check-upstream-bindings.mjs`);
  - the connector's generated tools changed (`check-tools-manifest.mjs` lists the differences): upstream added, removed or moved a REST operation.

  Check what changed upstream, then update the patch, `config/expected-bindings.json` or `render-wrangler.mjs` in a normal PR. For a tools change, review the new operations, then run `scripts/vendor-upstream-api.sh .upstream` against a built checkout of the new commit and `npm --prefix connector run update:manifest`, and commit `connector/tools-manifest.json`.
- **New migrations.** They're applied before the new code deploys, and upstream migrations have so far been additive. Read them anyway. `render-wrangler.mjs` refuses any Durable Object migration with `deleted_classes`, `renamed_classes` or `transferred_classes`, because graphs live in Durable Objects and those would destroy or move them; such a bump fails CI until you review it by hand.
- **Client compatibility.** Keep your nightly clients updated. If a client stops syncing after a bump, update the client or move `UPSTREAM_REF` closer to the client's nightly commit.

**Merging** the PR to `main` deploys it. Local deploys are different: `scripts/deploy.sh` ships your `.upstream` checkout, so after merging run `rm -rf .upstream` and redo 1.5 first (see section 2).

**Rolling back code.** List the Worker's versions and roll back to the previous one. Then revert the bump commit on `main`, so the next deploy doesn't roll forward again. Run this from the repo root with `.env.local` loaded:

```bash
W=.upstream/deps/db-sync/node_modules/.bin/wrangler
$W versions list --name logseq-sync
$W rollback <version-id> --name logseq-sync -m "roll back upstream bump"
```

**Rolling back the database.** If a migration went wrong, restore D1 with Time Travel. It covers 7 days on Free and 30 on Paid. These commands haven't been exercised on this setup yet. Pass the database name explicitly, as here, or run them from `.upstream/deps/db-sync/worker`, where the rendered `wrangler.toml` lives:

```bash
$W d1 time-travel info logseq-sync-index --timestamp 2026-10-21T12:00:00Z
$W d1 time-travel restore logseq-sync-index --timestamp 2026-10-21T12:00:00Z
```

## 7. Backups and restore

`backup.yml` runs daily at 14:00 UTC, and on demand (Actions → backup → Run workflow). A dispatched run has been verified: it printed `backup: d1=ok graphs=2/2 assets=ok`. It uses the `production` environment and writes to `logseq-sync-backups`:

| What | How | Where |
|---|---|---|
| D1 index | `wrangler d1 export … --remote` | `daily/<YYYY-MM-DD>/index.sql` |
| Graph snapshots | Upstream `download_graph_db.js`, using the admin token, one per graph | `daily/<date>/graphs/<n>.sqlite`, plus `daily/<date>/graphs/index.json` mapping `n` to the graph ID |
| Assets | `rclone sync` of `logseq-sync-assets`, with `--backup-dir` | `assets/` (a mirror, never expires); files deleted or overwritten in the live bucket are moved to `daily/<date>/assets-deleted/` |
| Run log | wrangler, rclone and download output | `daily/<date>/backup.log` (private; it contains graph IDs) |

The lifecycle rule deletes objects under `daily/` older than 90 days (`backupRetentionDays`). The `assets/` mirror is outside that prefix, so it never expires. The public run logs show counts only, never graph IDs. The job fails if any part fails, and then prints the bucket path of the uploaded `backup.log`, which is where to look to diagnose it.

Backups written before this layout sit at `<date>/` with no `daily/` prefix, so the lifecycle rule won't expire them. Once newer backups exist, delete them by hand.

To run a backup locally, with `.env.local` loaded and `.upstream` built:

```bash
WRANGLER="$PWD/.upstream/deps/db-sync/node_modules/.bin/wrangler" \
  scripts/with-r2-credentials.sh mise exec -- scripts/backup.sh backup-out
```

**Restore:**

- **Graphs.** The real restore path is re-uploading the graph from a desktop client, which holds a full local copy. Upstream has no tool that imports a snapshot back into a Durable Object. The snapshots are SQLite files for inspection and last-resort recovery.
- **D1.** Prefer Time Travel (section 6) while it's within its window. Treat the `index.sql` export as a last resort, and note that this path hasn't been exercised yet:
  - The export contains the schema, so it won't load over the existing tables. You'd load it into a fresh, empty database with `wrangler d1 execute <new-database> --remote --file index.sql`.
  - That new database has a new ID, which OpenTofu doesn't manage and the deploy doesn't point at.
  - Re-pointing means `tofu state rm` of the old database and `tofu import` of the new one. Only do this if you know OpenTofu well.
- **Assets.** Copy them back from `logseq-sync-backups/assets/` to `logseq-sync-assets`, for example with rclone using the derived R2 credentials. An asset deleted by accident or by an attacker is no longer in the mirror after the next backup, but it is kept in `daily/<date>/assets-deleted/` for the retention window; restore it from there.

**Scheduled workflows can stop silently.** GitHub disables `schedule` triggers in public repos after 60 days without repository activity. That would quietly stop both the daily backup and the weekly bump. Re-enable them in the Actions tab, or run `gh workflow enable backup.yml` and `gh workflow enable bump-upstream.yml`. Check occasionally that the latest runs are recent.

**If rclone gets a 403 on its bucket check,** set `RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true` for the asset sync. That's the usual fix for R2 tokens that can't list buckets. The verified setup didn't need it, because the token from 1.1 can list buckets.

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

This is upstream's own `/mcp` endpoint, which signs in with Logseq's Cognito and can't be added to claude.ai. To use your graphs from claude.ai, use the connector (section 11) instead. It runs on the Free plan.

## 9. Security notes

- **Any Logseq account can use your server** today: sign in, create graphs and create PATs for them. Users can't read each other's graphs, but they do use your quota and storage. A user allow-list is on the backlog.
- **Never set `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`.** It lets anyone impersonate any user. `render-wrangler.mjs` refuses to render a config containing it, or any `SENTRY_*` var.
- **`DB_SYNC_ADMIN_TOKEN` bypasses graph access checks.** It can read every graph. Keep it only in `.env.local` and the `production` environment.
- **The Cloudflare API token** controls everything here, including the derived R2 keys. Treat it like a root password.
- **PATs** are graph-scoped. Give agents the narrowest permission that works, and revoke unused tokens in Settings.
- **Secrets stay out of the repo and the logs.** The repo, the rendered `wrangler.toml` and the logs hold no secrets. The OpenTofu state and plans are encrypted. The OpenTofu outputs are marked sensitive, and `deploy.yml` and `deploy.sh` mask the D1 database id in Actions logs, so it and the other resource ids stay out of public run logs. `deploy.yml` and `backup.yml` never run on pull requests, and `ci.yml` uses no secrets, so fork PRs can't reach them.
- **Your hostname is public.** Certificate transparency logs publish it, and internet scanners start probing a new hostname within hours. You'll see requests for paths like `/.env` in the Worker logs. They're harmless, but expected. Keeping `SYNC_HOSTNAME` out of the repo only avoids advertising it.

**Rotating secrets:**

| Secret | How |
|---|---|
| `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` | Generate a new value. Update `.env.local` and the `production` secret, then redeploy: every deploy re-sets them. Rotating `ASSET_LINK_SECRET` invalidates asset links signed earlier. |
| `CLOUDFLARE_API_TOKEN` | Roll it in the dashboard, then update `.env.local` and the secret. The derived R2 keys change with it automatically. |
| `TOFU_ENCRYPTION_PASSPHRASE` | Changing it needs an OpenTofu key migration (a `fallback` key in `infra/encryption.tf`). Don't just swap the value. |
| A PAT | Revoke it in Settings → Personal Access Tokens and create a new one. Update `LOGSEQ_PAT` and `SMOKE_PAT`. For a graph connected to the connector, use **Replace token** at `/graphs` (section 11). |
| `COOKIE_ENCRYPTION_KEY` | Generate a new value (`openssl rand -hex 32`). Update `.env.local` and the `production` secret, then redeploy. It signs you out of the `/graphs` wizard, and sign-ins in progress must start again. |
| `GRAPH_TOKEN_KEY` | Generate a new value, update `.env.local` and the `production` secret, then redeploy. **Every stored graph token becomes unreadable**, and tools fail for every graph. Create a new token for each graph in Logseq and use **Replace token** at `/graphs`, or disconnect and reconnect each graph. Then revoke the old tokens in Logseq. |
| `CONNECTOR_GITHUB_CLIENT_SECRET` | Generate a new client secret in the GitHub OAuth app's settings. Update `GITHUB_CLIENT_SECRET` in `.env.local` and the `production` secret `CONNECTOR_GITHUB_CLIENT_SECRET`, redeploy, then delete the old secret in GitHub. |

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
| `429 rate limit exceeded` | The limit is 120 reads or 20 writes per minute. Slow down. |
| `403 forbidden` from the REST API | The PAT belongs to a different graph, or its permission doesn't cover the operation. |
| Backups or the weekly bump stopped running | GitHub disabled the `schedule` triggers after 60 days without repository activity. Re-enable in the Actions tab or `gh workflow enable backup.yml` / `gh workflow enable bump-upstream.yml` (section 7). |
| Backup fails with 403 on the bucket check | The token can't list buckets. Set `RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true` (section 7), or give the token the R2 permissions from 1.1. |
| The bump workflow can't create its pull request | Enable **Allow GitHub Actions to create and approve pull requests** in Settings → Actions → General (1.8). |
| Local deploy rolled the server back | `.upstream` was older than `UPSTREAM_REF`. `rm -rf .upstream`, redo 1.5, deploy again (section 2). |
| Smoke test `FAIL health: 000` right after the first deploy | The custom domain's certificate is still being issued. Wait a few minutes and re-run `scripts/smoke-test.sh https://sync.example.com`. |

Connector problems are covered in section 11.

## 11. Use your graphs from Claude

The connector is an optional second Worker, `logseq-connector`, at its own hostname such as `https://mcp.example.com`. It is a remote MCP server that you add **once** as a custom connector in claude.ai. After that, claude.ai on web, desktop and mobile, and Claude Code cloud sessions, can read and write your graphs. The only per-session step is enabling it.

- **You sign in with GitHub**, and only your own GitHub account is accepted.
- **It holds your graph tokens.** You connect each graph once by pasting a PAT into the connector's `/graphs` page. Claude never sees a token: it names graphs by an alias you choose.
- **It calls the sync server privately**, over a Cloudflare service binding (`SYNC`) to `logseq-sync`, not over the public hostname.
- **Its tools are generated** from the sync server's OpenAPI document at `UPSTREAM_REF`. When an upstream bump adds, removes or changes an operation, CI flags it: run `npm --prefix connector run update:manifest` and commit the result.
- **It runs on the Workers Free plan.** It adds one Worker, a KV namespace for OAuth grants and a small D1 database for the connected graphs. One person's use stays well inside KV's free daily allowances. The file tools on large inputs are *(not yet verified)* against the Free plan's CPU time per request (11.8).

**Status.** The connector is built and tested in CI, but it hasn't been used on a real account yet. Anything below marked *(not yet verified)* is still to be confirmed against a real deploy and recorded in `docs/spike-results.md`.

### 11.1 What you need

- **A hostname for the connector** in the same zone as the sync server, such as `mcp.example.com`. Use lowercase, and don't create a DNS record for it: the deploy attaches it as a custom domain, like `sync.example.com`. Like `SYNC_HOSTNAME`, it is never committed.
- **A GitHub account.** It's only used to sign you in. The connector reads only your public profile.
- **A claude.ai plan with custom connectors.** The Free plan allows one custom connector.
- **Unencrypted graphs.** The connector refuses end-to-end encrypted graphs (see "Encrypted or unencrypted graph?" in section 3).

### 11.2 Create the GitHub OAuth app

On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
|---|---|
| Application name | Anything, for example `Logseq connector` |
| Homepage URL | `https://mcp.example.com` |
| Authorization callback URL | `https://mcp.example.com/callback` |

Leave **Enable Device Flow** off. Register the app, note the **Client ID**, then **Generate a new client secret** and copy it straight away: GitHub shows it once.

The connector allows exactly one GitHub account, by its numeric user ID rather than the login, because logins can change. Get yours with:

```bash
gh api user -q .id
```

### 11.3 Add the KV permission to the Cloudflare token

Edit the token from 1.1 and add **Workers KV Storage** Write + Read to its account policy. The connector's OAuth grants live in KV, and OpenTofu creates the namespace with this token. Editing the policies doesn't change the token's value.

### 11.4 Add the connector's secrets

With `.env.local` from 1.4 in place and `gh` logged in, run:

```bash
scripts/init-env.sh --add-missing --push
```

It asks for the four values you supply, reading the client secret silently, and generates the two keys with `openssl rand -hex 32`. It appends them to `.env.local` in one marked block and never rewrites an existing line. With `--push`, it then sets only the names it just added in the `production` environment. To skip the prompts, export `CONNECTOR_HOSTNAME`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_GITHUB_USER_ID` first.

| `.env.local` name | `production` secret | Value | Source |
|---|---|---|---|
| `CONNECTOR_HOSTNAME` | `CONNECTOR_HOSTNAME` | A bare lowercase hostname such as `mcp.example.com` | You supply |
| `GITHUB_CLIENT_ID` | `CONNECTOR_GITHUB_CLIENT_ID` | The OAuth app's client ID | You supply |
| `GITHUB_CLIENT_SECRET` | `CONNECTOR_GITHUB_CLIENT_SECRET` | The OAuth app's client secret | You supply |
| `OWNER_GITHUB_USER_ID` | `OWNER_GITHUB_USER_ID` | Your numeric GitHub user ID | You supply |
| `COOKIE_ENCRYPTION_KEY` | `COOKIE_ENCRYPTION_KEY` | Encrypts the sign-in and wizard cookies | Generated |
| `GRAPH_TOKEN_KEY` | `GRAPH_TOKEN_KEY` | Encrypts the graph tokens the connector stores | Generated |

The two GitHub names change on the way because GitHub forbids secret names that start with `GITHUB_` (see 1.8).

- **Copy `GRAPH_TOKEN_KEY` and `COOKIE_ENCRYPTION_KEY` into your password manager.**
- **A name that's present but empty** in `.env.local` stops the script. Fill it in by hand.
- **A missing `TOFU_ENCRYPTION_PASSPHRASE`, `ASSET_LINK_SECRET` or `DB_SYNC_ADMIN_TOKEN`** stops the script before it writes or pushes anything. Restore the value from your password manager: `--add-missing` never generates these, because a new value wouldn't match the deployed one, and a new passphrase can't decrypt the OpenTofu state.
- **If the push fails,** `.env.local` has already been written. Load it and push with the loop in 1.8, with the connector line uncommented.

### 11.5 Turn it on

The connector is switched by `CONNECTOR_ENABLED`, a GitHub Actions **variable** (not a secret), so a fork turns it on without changing a committed file. `true` turns it on; unset, empty or `false` means off; any other value fails the deploy. While it's off, CI still builds and tests the connector, but OpenTofu and the deploy skip it.

**Turn it on only after** the GitHub OAuth app exists (11.2), the token has the KV permission (11.3) and the six secrets are in the `production` environment (11.4). Then set the variable and run the deploy:

```bash
gh variable set CONNECTOR_ENABLED --env production --body true
gh workflow run deploy.yml
```

A variable set in **Settings → Secrets and variables → Actions → Variables**, for the whole repository, works too. An environment variable wins over a repository one. Also set `CONNECTOR_ENABLED=true` in `.env.local`, so local OpenTofu runs agree with Actions (see "Turning it off" below for why that matters).

The deploy:

1. creates the KV namespace `logseq-connector-oauth` and the D1 database `logseq-connector` (`tofu apply`);
2. deploys the sync server as before;
3. runs `scripts/deploy-connector.sh`, which renders the connector's config (`scripts/render-connector-wrangler.mjs`), applies its D1 migrations, runs `wrangler deploy` (which also attaches the custom domain), sets the Worker secrets with `wrangler secret bulk`, and runs `scripts/smoke-connector.sh https://$CONNECTOR_HOSTNAME`.

With the connector on, every connector secret is required. A missing one fails the deploy, for example with `GITHUB_CLIENT_ID: parameter null or not set`. A passing smoke test prints:

```
ok oauth-metadata
ok mcp-unauthenticated
ok wizard-requires-login
```

You can also deploy the connector from your machine, with `CONNECTOR_ENABLED=true` in `.env.local`, loaded as in 1.4, step 1.5 done, and the plan and apply from 1.7 re-run so the connector's KV namespace and D1 database exist. Set the GitHub variable first: while it's off, the next Actions deploy would plan to destroy the resources and fail on `prevent_destroy`.

```bash
scripts/vendor-upstream-api.sh .upstream
npm --prefix connector ci
scripts/with-r2-credentials.sh mise exec -- scripts/deploy-connector.sh
```

Calls from the connector to the sync server go over the service binding. That a binding reaches `logseq-sync`, which has `workers_dev = false` and only a custom domain, is *(not yet verified)*.

**Turning it off again needs manual teardown.** Once the resources exist, any OpenTofu run with the connector off (the variable unset or `false` in Actions, or `CONNECTOR_ENABLED` missing or `false` in your shell) plans to destroy the KV namespace and D1 database. `prevent_destroy` refuses that, which fails the whole deploy, the sync server's included. To turn it off, first remove the two resources from the OpenTofu state, then set the variable to `false` straight away (a deploy in between would try to create them again), and set `CONNECTOR_ENABLED=false` in `.env.local`:

```bash
scripts/with-r2-credentials.sh mise exec -- tofu -chdir=infra state rm \
  'cloudflare_workers_kv_namespace.connector_oauth[0]' 'cloudflare_d1_database.connector[0]'
```

Then delete the `logseq-connector` Worker, the KV namespace `logseq-connector-oauth` and the D1 database `logseq-connector` in the Cloudflare dashboard, remove the connector in claude.ai, and revoke the graph tokens in Logseq. This path hasn't been exercised yet.

### 11.6 Add it to claude.ai and Claude Code

**claude.ai** *(not yet verified)*:

1. Open **Settings → Connectors → Add custom connector**.
2. Give it a name, such as `Logseq`, and the URL `https://mcp.example.com/mcp`. Leave the advanced OAuth client ID and secret empty: the connector lets claude.ai register itself.
3. Click **Connect**. The connector asks you to allow Claude access to your Logseq graphs, then sends you to GitHub. Sign in with the GitHub account whose ID is in `OWNER_GITHUB_USER_ID`. Any other account gets "This GitHub account is not allowed to use this connector."
4. Enable the connector in a conversation from its tools menu, then ask "list my Logseq graphs".

Every tool carries MCP annotations: read tools are marked read-only and delete tools destructive. Whether claude.ai uses them to skip or force the approval prompt for a custom connector is *(not yet verified)*. Either way you can set each tool to Always allow, Needs approval or Blocked in the connector's settings.

**Claude Code cloud sessions** inherit your claude.ai connectors *(not yet verified)*. Enable the connector for the session. The traffic goes through Anthropic, so the environment needs no network allow-list, environment variables or skill for it. Section 5 stays available for raw REST access.

**Claude Code on your own machine** should also work, because the connector accepts loopback redirect URIs *(not yet verified)*: run `claude mcp add --transport http logseq https://mcp.example.com/mcp`, then `/mcp` in a session to sign in.

### 11.7 Connect your graphs

Open `https://mcp.example.com/graphs` and sign in with GitHub. The session lasts 8 hours. Then **Connect a graph**:

1. In Logseq (nightly), open **Settings → Personal Access Tokens** and create a token for the graph (section 4). Choose permission **both** for read-write use, or **read** for read-only use. The connector doesn't accept `write`-only tokens. Note the expiry date Logseq shows.
2. Paste the token and click **Check token**. The connector checks it with the sync server, which must report exactly one graph.
   - **An end-to-end encrypted graph is refused** and nothing is saved. Revoke that token in Logseq.
   - A graph that's already connected is refused too; replace its token instead.
3. Confirm within 10 minutes:
   - **Alias**: how Claude names the graph. It defaults to the graph name, and must be 1–40 lowercase letters, digits or hyphens, starting with a letter or digit;
   - **What Claude may do**: read only, or read and write. A `read` token can only be connected read-only;
   - **Token permission**, as you chose it in Logseq;
   - **Token expiry**: the date Logseq showed, or "I don't know".

The token is stored encrypted and never shown again. The list shows each graph's alias, Logseq name, mode, token permission, expiry and last use. A token that expires within 30 days gets a warning, in the list and in `list_graphs`. For each graph you can:

- **Edit** its alias, mode or expiry;
- **Replace token**: create a new token for the same graph in Logseq, paste it, then revoke the old one in Logseq. A read-write graph needs a `both` token;
- **Disconnect**: Claude loses access at once and the stored token is deleted. **Also revoke the token in Logseq** (Settings → Personal Access Tokens), or it keeps working anywhere else it was copied.

### 11.8 What Claude can do

Claude addresses every graph by its alias, in each tool's `graph` argument.

- **`list_graphs`** lists the connected graphs: alias, Logseq name, mode and expiry status. Nothing secret.
- **`connector_help`** gives Claude the conventions for well-formed Logseq content: `insert_block_tree` for whole notes, `[[Page]]` links, `create_task` for tasks, `capture_to_today` for the journal.
- **One tool per sync-server REST operation**, named after the operation in snake case. At the current `UPSTREAM_REF` that's pages (`list_pages`, `get_page`, `get_page_outline`, `create_page`, `update_page`, `delete_page`, `list_page_blocks`, `list_page_references`), blocks (`get_block`, `update_block`, `delete_block`, `insert_block_children`, `insert_block_tree`, `move_blocks`), properties (`list_properties`, `get_property`, `create_property`, `update_property`, `delete_property`, `set_block_property`, `delete_block_property`, `batch_set_block_property`, `batch_delete_block_property`), tags (`list_tags`, `get_tag`, `create_tag`, `update_tag`, `delete_tag`, `list_tag_objects`), tasks (`list_tasks`, `create_task`), `capture_to_today`, `search_graph` and `list_assets`. `connector/tools-manifest.json` has the full list.
- **Files:**
  - `save_document` saves text (as UTF-8) or base64 bytes, at most 150,000 characters, under a file name whose extension sets the type;
  - `save_file_from_url` downloads a file and saves it. Only `https` on port 443, at most 25 MiB, and only `text/*`, PDF, PNG, JPEG, GIF, WebP, JSON and Office (`application/vnd.openxmlformats-officedocument.*`) files. Private, loopback, link-local and other internal addresses are refused, and each of at most 5 redirects is checked again;
  - both attach the file to a page you name by title or UUID, or to today's journal;
  - `read_file` reads a file back by its asset block UUID: text as text, PNG, JPEG, GIF and WebP images up to 3.75 MiB as images (when the file's first bytes match its extension), anything else as a one-line description.

  Saving and reading files end to end is *(not yet verified)*. So is whether large files, such as a 25 MiB download or a 3.75 MiB image, stay inside the Workers Free plan's CPU time and memory per request *(not yet verified)*.
- **Flashcards:** Claude tags a block with the `Card` tag, which makes it a flashcard in Logseq's review. That this works through the API is *(not yet verified)*. Reviews stay in Logseq.

**Limits:**

- **Read-only graphs refuse every write tool** before anything reaches the sync server.
- **Results are capped at about 150,000 characters**, claude.ai's limit, and longer results end with a truncation notice. List tools are paginated: Claude passes the returned cursor to get the next page.
- **The sync server's rate limits apply:** 120 reads and 20 writes per minute. That's why `insert_block_tree`, one call for a whole block tree, matters for meeting notes.

### 11.9 Security model

- **Owner only.** Both the MCP sign-in and the `/graphs` wizard accept only the GitHub user ID in `OWNER_GITHUB_USER_ID`. Any other account is refused before a grant or session is created. The ID is checked again on every MCP request, so changing `OWNER_GITHUB_USER_ID` and redeploying revokes the existing grants. OAuth codes go only to claude.ai's callback (`https://claude.ai/api/mcp/auth_callback`) or to loopback addresses (`localhost`, `127.0.0.1`).
- **Tokens are encrypted.** Each PAT is stored in the connector's D1 database with AES-GCM under `GRAPH_TOKEN_KEY`. No tool returns a token, and the wizard never shows one again. Treat `GRAPH_TOKEN_KEY` like the tokens themselves.
- **Only unencrypted graphs.** The wizard refuses end-to-end encrypted graphs. Everything in section 3 about unencrypted graphs applies, and the connector is one more piece of deployed code that can read them.
- **Narrow access per graph.** Connect a graph read-only, with a `read` token, when Claude only needs to read it.
- **Logs** hold the tool name, graph alias, status and duration only: never arguments, results, tokens or hostnames. Workers Logs (observability, on for the connector) also record each request's URL and metadata, privately in your Cloudflare dashboard.
- **Not backed up.** `backup.yml` doesn't back up the connector's D1 database. It holds only aliases, graph IDs, modes and encrypted tokens, and tokens can be re-issued in Logseq. D1 Time Travel covers accidents.
- **Key rotation** (section 9): rotating `GRAPH_TOKEN_KEY` makes every stored token unreadable, so you must replace the token for each graph. Rotating `COOKIE_ENCRYPTION_KEY` signs you out of the wizard.
- **Firewall rules.** If you put WAF, rate-limiting or bot rules in front of the connector's hostname, allow Anthropic's egress range `160.79.104.0/21`. claude.ai and Claude Code cloud sessions reach the connector from there.

### 11.10 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `token for graph 'x' expired or lacks permission — reconnect it at https://mcp.example.com/graphs` | The sync server answered 401 or 403: the token expired, was revoked, or its permission doesn't cover the call. Create a new token in Logseq and use **Replace token** at `/graphs`. |
| `rate limited — retry after N s` | The sync server's limit of 120 reads or 20 writes per minute. Wait, and batch writes with `insert_block_tree`. |
| `graph 'x' is read-only` | The graph is connected read-only. Switch it to read-write under **Edit** at `/graphs`. That needs a `both` token: if its token is `read`, replace it with a `both` token first. |
| `unknown graph 'x' — call list_graphs for the connected aliases` | No graph is connected under that alias: it was renamed or disconnected, or never connected. Check `/graphs`. |
| Every tool fails for every graph after rotating `GRAPH_TOKEN_KEY` | The stored tokens can't be decrypted any more. Replace each graph's token at `/graphs` (11.7). |
| `421 Misdirected request` | The request reached the connector on a hostname other than `CONNECTOR_HOSTNAME`. Use exactly `https://<CONNECTOR_HOSTNAME>/mcp`, and check that the secret matches the custom domain. |
| `500 Server misconfigured` | A connector secret is missing or malformed. The Worker log says which: `connector misconfigured: invalid connector secrets: …`. `CONNECTOR_HOSTNAME` must be lowercase, the two keys must be 64 hex characters and `OWNER_GITHUB_USER_ID` must be a positive integer (no leading zeros). Fix the secret and redeploy. |
| "This GitHub account is not allowed to use this connector." | You signed in with another GitHub account, or `OWNER_GITHUB_USER_ID` is wrong. Check it with `gh api user -q .id`. |
| Smoke test `FAIL oauth-metadata: 000` | The custom domain's certificate is still being issued after the first deploy. Wait a few minutes and re-run `scripts/smoke-connector.sh https://mcp.example.com`. |
| Smoke test `FAIL oauth-metadata` with `421`, `500` or `resource` | `421` or `resource`: the URL you tested isn't `CONNECTOR_HOSTNAME`. `500`: see "Server misconfigured" above. |
| Deploy fails with `GITHUB_CLIENT_ID: parameter null or not set` (or another connector name) | The connector is enabled but a secret is missing from the `production` environment. If the name is missing from `.env.local` too, `scripts/init-env.sh --add-missing --push` adds and pushes it. Otherwise push it with the 1.8 loop: `--add-missing` only pushes names it adds. Remember the `CONNECTOR_GITHUB_*` names. |
| Creating `cloudflare_workers_kv_namespace.connector_oauth` fails with an authentication or permission error | The Cloudflare token lacks **Workers KV Storage** Write + Read (11.3). |
| `tofu apply` fails with `Instance cannot be destroyed` for the connector's KV namespace or D1 database | OpenTofu ran with the connector off while its resources exist. If you meant it to be on, set the `CONNECTOR_ENABLED` variable (Actions) or `CONNECTOR_ENABLED=true` in `.env.local` and `TF_VAR_connector_enabled` (local, 1.4), and re-run. To turn it off, follow "Turning it off" in 11.5. |
| Deploy fails at **Read connector setting** with `The CONNECTOR_ENABLED variable must be true or false` | The variable holds something else, such as `True` or `yes`. Set it to exactly `true` or `false`, or delete it for off. |

## Backlog

1. **A publish server** at `publish.example.com`. Mobile has no publish URL setting, and rendered pages load from `asset.logseq.com` and jsdelivr.
2. **A user allow-list** by Cognito `sub` on all authenticated routes, failing closed.
3. **Verify the connector on a real account** and record the results in `docs/spike-results.md`: the service binding to a `workers_dev = false` Worker, claude.ai sign-in and a refused second GitHub account, Claude Code cloud sessions inheriting the connector, Card tagging for flashcards, the file tools end to end, and whether annotations change claude.ai's prompting.
4. **An upstream PR** making the PAT groups configurable, so the patch can be dropped.
5. **An off-account backup copy.**
6. **A client-side decryption MCP** for E2EE graphs, so agents can work with encrypted graphs.
7. **Confirm the minimal token permissions**, in particular whether DNS Write is needed.
8. **Measure a large real graph against the Free CPU limits:** first upload, asset sync and snapshot download.

## Licence and credits

Licensed under **AGPL-3.0-or-later** (see `LICENSE`). The patch is derived from Logseq's AGPL code.

- **[Logseq](https://github.com/logseq/logseq)** wrote the sync server, the clients and the REST API skill vendored in `skills/logseq-rest-api/`. This repo only builds, patches and deploys upstream code.
- **[yshalsager/logseq-selfhost](https://github.com/yshalsager/logseq-selfhost)** had the idea of a pinned upstream ref with a weekly bump. It covers the Docker/Node self-host route. No code was copied from it.
