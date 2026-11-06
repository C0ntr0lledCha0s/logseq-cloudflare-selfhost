# Guided setup: design

**Status:** approved by the owner, 2026-11-06
**Repo:** `logseq-cloudflare-selfhost`

Decisions marked *(owner)* are the owner's. Every other decision is the designer's call.

## Intent

A new user currently performs about 20 manual actions to get from nothing to a syncing graph. Most of them are copy-paste commands from README section 1. Each is a chance to stop. Some of the stops are hard to recover from:

- a missing token permission, which shows up only as `10000: Authentication error` several steps later;
- R2 not enabled yet;
- no `workers.dev` subdomain;
- a mismatched `CONNECTOR_ENABLED` setting, which makes OpenTofu plan a destroy.

The allow-list (PR #36) added one more stretch, and it's the most confusing one:

1. sign in;
2. be refused;
3. find your ID in a log;
4. edit `.env.local`;
5. push the secret;
6. redeploy;
7. sign in again.

The goal is a setup that a person comfortable in a terminal can finish without already knowing GitHub, Cloudflare or DNS. The setup is a short list of browser steps that can't be automated, plus **one command**. The tooling checks what it can before changing anything, tells the user exactly what to click when it can't proceed, and can be re-run safely after any failure.

## Audience *(owner)*

The audience is someone **comfortable on the command line** who may be new to:

- GitHub (no account, never used `gh`);
- Cloudflare (no account);
- owning a domain.

They are not expected to read OpenTofu, wrangler or GitHub Actions configuration. They are expected to install a CLI tool from a link and paste a value when asked.

A no-terminal path is out of scope. It was considered, using Cloudflare's Deploy button, and set aside, because self-hosting this already assumes a terminal *(owner)*.

## Goals

1. **One command after the browser steps.** `scripts/setup.sh` goes from a fresh clone to a deployed server and a claimed owner.
2. **Fewer local tools.** Setup needs only `git`, `gh`, Node 22+ and `openssl`. mise, Java, Clojure and OpenTofu are needed only for deploying from your own machine (the "Advanced" path).
3. **Problems are found before anything changes.** `scripts/doctor.sh` checks the Cloudflare account, the token, the domain and the GitHub repo. Each failure names what to fix and where.
4. **No log reading to claim ownership.** After the first refused sign-in, the user confirms "is this you?" and the tooling does the rest. The same command adds another person later.
5. **The connector in one command** after its OAuth app exists: `scripts/enable-connector.sh`.
6. **A "Before you start" guide.** It covers getting a GitHub account, a Cloudflare account and a domain, with links to each provider's own guide.
7. **Re-runnable.** Every script is idempotent: re-running after a failure continues, and on a working install it changes nothing.

## Non-goals

- A browser-only or no-terminal setup, or a Deploy-to-Cloudflare button *(owner)*.
- Building the server somewhere other than GitHub Actions or the user's machine, or publishing prebuilt bundles.
- A fork bumping `UPSTREAM_REF` on its own (D12).
- Moving the allow-list into D1, granting access by sharing a graph, or connecting graphs to the connector without a PAT. Each is a separate design.
- Automating the Logseq client: installing nightly builds, entering the server URL, signing in.
- Changing how an existing install deploys. The owner's install keeps working with no action.

## Anti-goals

- **No secret printed, logged or put in argv.** The rules in `init-env.sh`, `with-r2-credentials.sh` and `allowed-users.mjs` hold for every new script:
  - values travel on stdin or in the environment;
  - in Actions, derived identifiers are masked.
- **No owner identifiers in the repo or in public Actions logs.** That covers the hostname, account ID, user IDs and emails.
- **No silent changes to someone else's repo.** `setup.sh` changes only the GitHub repo that owns the checkout, names it, and asks before the first change.
- **No destructive action without the user asking.** Setup never deletes, rotates or regenerates an existing secret, resource or file, and never rewrites `.env.local` lines it didn't create. There are two exceptions, each keeping a timestamped backup of the file:
  - `DB_SYNC_ALLOWED_USERS`, which `allow-user.sh` edits (D5);
  - `CONNECTOR_ENABLED`, which `enable-connector.sh` sets to `true` (D7).
- **No "first to sign in becomes owner".** A stranger could claim a freshly deployed server first. Claiming always needs the person at the terminal to confirm an email address they recognise.

## Constraints

- **Existing tooling stays the single code path.** Setup orchestrates `init-env.sh`, `deploy.yml`, `deploy.sh` and `allowed-users.mjs`; it doesn't re-implement them.
  - Secrets still reach GitHub only through `init-env`'s stdin-based push.
  - Deploys still run `deploy.sh` (in Actions, after OpenTofu).
- **The `production` environment and its `main`-only branch policy stay** as the place secrets live (README 1.8).
- **Scripts are bash or Node,** each with a `*.test.mjs` beside it, stubbing `gh` and the Cloudflare API the way the existing tests do (`stubGh`; test-only API base overrides that require a `*_TEST=1` switch).
- **The Cloudflare API is called with the existing account-owned token.** No new credential.
- **The repo's writing rules apply:** UK/NZ English, plain sentences, `sync.example.com` and `mcp.example.com` in docs.

## Decisions

### D1. Two paths: guided (default) and advanced

The README leads with the **guided path**:

1. "Before you start" (D9).
2. The browser steps that can't be automated (D2).
3. `scripts/setup.sh`.
4. Point Logseq at the server and sign in.

Today's section 1, the local OpenTofu and build steps, becomes **"Advanced: set up and deploy from your machine"**. It isn't removed, because local deploys and debugging need it.

The guided path deploys through GitHub Actions only. Its first deploy is the same `deploy` workflow a merge to `main` runs.

### D2. The browser steps, in order

These can't be automated. The README lists them as one numbered checklist, and `doctor.sh` checks each one:

1. **GitHub:** have an account and copy this repo (D9 explains fork versus template). Then enable Actions on the copy.
2. **Cloudflare:** have an account, and a domain active on it (D9).
3. **Cloudflare:** add a payment method and enable R2 (README 1.2).
4. **Cloudflare:** create the API token (D8 covers the link that pre-fills it).
5. **Locally:** install `gh` and run `gh auth login`.

The `workers.dev` subdomain (today's 1.3) leaves this list: the tooling creates it (D3).

### D3. Account bootstrap moves into an idempotent script the deploy runs

A new `scripts/ensure-account.mjs` makes sure the account-level prerequisites exist. It uses the Cloudflare API with the existing token, and it:

- **creates the OpenTofu state bucket** `logseq-selfhost-tofu-state` if it's missing. That replaces today's 1.6, which needs a local wrangler binary.
- **creates the `workers.dev` subdomain** if the account has none. That replaces today's 1.3.
- **stops with a clear message if R2 isn't enabled,** for example "R2 isn't enabled on this account. Enable it at dash.cloudflare.com → R2 (a payment method is required), then re-run." The docs describe enabling R2 only as a dashboard checkout, with no API. A call made before R2 is enabled fails with `10042 NotEntitled` ([R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)).

The calls it uses:

- **Bucket:** `POST /accounts/{id}/r2/buckets`, needing Workers R2 Storage Write.
- **Subdomain:** `GET` and `PUT /accounts/{id}/workers/subdomain`, needing Workers Scripts Write ([subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/)).

`deploy.yml` runs it as a new step before `Tofu init`. `setup.sh` doesn't run it directly; the first deploy does. A local deploy can also run it.

With the bucket and subdomain handled, the first OpenTofu run happens in Actions. `deploy.yml` already handles a first-ever run (`tofu output` printing `{}`). So the guided path never runs tofu locally, and never needs `infra/backend.hcl` on the user's machine.

### D4. `scripts/setup.sh`: one command, resumable

`setup.sh` runs these stages in order. Each stage first checks whether its work is already done, and skips it if so. A failure stops with what to fix, and re-running continues from the failed stage.

1. **Local prerequisites.**
   - `gh` is installed and logged in, with the scopes the later stages need. `gh auth login`'s defaults (`repo`, `read:org`, `gist`) are expected to be enough for a repo the user owns. The builder confirms this against a real fork, and `setup.sh` names any missing scope with the `gh auth refresh -s …` command.
   - Node is 22 or newer, and `openssl` is on `PATH`.
   - The checkout is a git clone with a GitHub `origin`.
2. **Which repo.** It prints the repo that owns the checkout (`gh repo view`) and asks "Set up `<owner>/<repo>`? [y/N]". It warns if that is the original project rather than the user's copy. With `--yes`, it doesn't ask.
3. **Values.**
   - If `.env.local` is missing **and the `production` environment holds none of the secrets**, it runs `init-env.sh`, which prompts for the token, account ID and hostname and generates the rest.
   - If `.env.local` is missing but `production` already holds secrets, this is an existing install on a new machine, or a lost file. It stops: "This repo is already set up. Restore `.env.local` from your password manager (or copy it from your other machine), then re-run." Generating fresh values here would leave the user with a `TOFU_ENCRYPTION_PASSPHRASE` that can't decrypt the state, and secrets that don't match the deployed ones, because stage 6 never overwrites existing secrets.
   - If `.env.local` exists, it loads the file as is.
   - It reminds the user to save `TOFU_ENCRYPTION_PASSPHRASE` in a password manager, and waits for Enter.
4. **Checks.** It runs `doctor.sh` (D6) and stops on any failure.
5. **GitHub repo settings.** Each of these is created only if missing, using the commands README 1.8 lists today:
   - the `production` environment;
   - its `main`-only branch policy;
   - the `protect-main` ruleset;
   - the workflow permission that lets the bump workflow open PRs;
   - whether Actions is enabled. If it isn't, setup prints the exact page to click and waits. GitHub's docs don't say whether the API can enable a new fork's workflows, so the builder checks that. If it can't, the "click to enable" prompt is the path.
   - **the scheduled workflows,** enabled with `gh workflow enable`: `backup` and `usage`, plus `sync-upstream` on a fork or `bump-upstream` on the original (D12). GitHub disables scheduled workflows on a new public fork, so without this a fork would never back up or bump upstream ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows): "When a public repository is forked, scheduled workflows are disabled by default").
6. **Secrets.**
   - **Missing secrets are pushed.** It compares secret *names* in `production` (`gh secret list --env production`, which never shows values) with the required names, and pushes the missing ones from `.env.local`, through `init-env`'s push code.
   - **Existing secrets aren't overwritten.** `--repush` pushes every value again, for after an edit to `.env.local`.
   - **The push code becomes callable.** This needs a small refactor: `init-env.sh` gains a `--push-only <names…>` mode. Values still go through stdin only.
7. **First deploy.** This stage is already done if the latest `deploy` run on `main` succeeded. Otherwise it starts the `deploy` workflow (`gh workflow run deploy.yml --ref main`), finds the run, and follows it to the end (`gh run watch --exit-status`). On failure it prints the failed step's name and the run's URL. It never prints the log, which is public anyway and holds no secrets.
8. **Next steps.** It prints the server URL to enter in Logseq, says the first sign-in will be refused, and starts `allow-user.sh --owner` (D5) to wait for that sign-in.

`setup.sh` on an install that's already working finds every stage done, deploys nothing unless `--deploy` is given, and exits 0.

### D5. `scripts/allow-user.sh`: claim the server, and add people later

A new `scripts/allow-user.sh` replaces the log-reading part of README 9.1. It has two modes.

**Owner mode (`--owner`), on a fresh install where the list is `none`:**

1. It prints: "In Logseq, set the sync server to `https://<host>` and sign in. You'll be refused; that's expected. Waiting for the sign-in…"
2. It finds refused sign-ins in the sync Worker's stored logs: the `db-sync/user-not-allowed` event, which carries `sub` and `email`. The search covers the last 30 minutes and then polls every 10 seconds.
   - **How:** the Workers Observability query API, `POST /accounts/{id}/workers/observability/telemetry/query` ([API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)).
   - **Why it works:** upstream's `wrangler.toml` already turns Workers Logs on for the sync Worker (`[observability] enabled = true`).
   - **Why not a live tail:** stored logs find a sign-in that happened before the script started, and one HTTP API is a single code path with no `wrangler` binary.
   - **The token needs Workers Observability Write,** the only permission the API page lists, although the call only reads. D8 adds it. On a token without it, `allow-user.sh` names the permission to add, and `doctor` warns.
   - **The builder confirms** that the event reaches Workers Logs with both fields, and how to filter on it.
3. For each distinct email, it asks "Allow `<email>`? [y/N]". IDs aren't shown unless `--show-ids` is given.
4. When the user says yes:
   - it writes the ID into `DB_SYNC_ALLOWED_USERS` in `.env.local`, keeping a timestamped backup of the file;
   - it checks the new value with `allowed-users.mjs check-format`;
   - it pushes the one secret through `init-env --push-only`;
   - it runs and follows the deploy, as in D4 stage 7.
5. It prints: "Sign in again. (Re-enter the server URL first if Logseq signed you out.)"

**Add mode (default), on an install that already has users:** it does the same, appending to the list instead of replacing `none`.

**Choosing the mode needs more than the local file,** because `.env.local` can be out of date and production secrets can't be read back. So `allow-user.sh` also counts the rows in the server's D1 `users` table, the same query as `list-users.sh`. A refused user is never recorded there, so with the list at `none` the table stays empty.
  - **Owner mode** requires the local list to be `none` and the table to be empty.
  - **A local `none` with users in the table** means `.env.local` is stale. It stops and asks the user to restore the current file, rather than replace the production list with one ID.
  - **Add mode** requires the local list not to be `none`. This is how the owner adds a partner or a second account: "Ask them to sign in, then run `scripts/allow-user.sh`."

**Safety:**

- **It refuses in GitHub Actions,** like `list-users.sh`, because it prints emails.
- **It only reads logs.** It never writes to D1, and never adds anyone the user didn't confirm.
- **Nothing is offered when there are no refusals.** If no refused sign-in appears within the wait (default 10 minutes, `--wait`), it says what to check: the server URL in Logseq, the nightly client, that the sign-in really went to this server.
- **Removing someone** stays manual (README 9.1). Removal is rare, and a mistake there locks a person out.

### D6. `scripts/doctor.sh`: check before changing anything

`doctor.sh` is read-only. It prints one line per check, `ok`, `FAIL` or `warn`, and exits 1 if any check fails. Every `FAIL` names the fix and the README step it belongs to. `setup.sh` runs it, the troubleshooting table points at it, and users can run it on its own at any time.

**Cloudflare checks** (with the `.env.local` token):

| Check | Failure says |
|---|---|
| The token is active: `GET /accounts/{id}/tokens/verify` ([API](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)) | the token is disabled or expired; create one with the link (D8) |
| Each permission works, tested individually. A permission that only the new token link adds (Zone Read, Workers Observability Write) is a `warn` that skips the checks needing it, on an install whose Worker is already deployed. It is a `FAIL` before the first deploy: there the DNS check (below) is what stops a deploy from taking over a hostname in use. The permissions the deploy already uses are always `FAIL`. A token can't list its own permissions without the Account API Tokens permission, so each is tested with a harmless read call: list D1 databases, list R2 buckets, read the workers.dev subdomain, list KV namespaces, list zones, and a zero-result observability query. | which permission is missing, and the token link (D8) to make a new token |
| R2 is enabled | enable R2 (D2 step 3) |
| The zone containing `SYNC_HOSTNAME` is on the account and `active` (`GET /zones?name=`, needing Zone Read). Custom domains need "an active Cloudflare zone" ([custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)), and a `pending` zone can't serve traffic yet | not on this account; or `pending`, meaning the nameservers haven't switched yet (D9) |
| `SYNC_HOSTNAME` has no DNS record, or only the custom-domain record of this Worker | a record exists, so the hostname is probably in use: choose another name, or delete the record if it's unused. **This is a `FAIL`, not a warning.** wrangler sends `override_existing_dns_record` as true when not run interactively (workers-sdk `publish-routes.ts`), so a deploy from Actions would silently replace the record. A website on that name would go down. |
| With the connector on: the same two checks for `CONNECTOR_HOSTNAME`, plus KV permission | as above |
| With semantic search on: Vectorize permission | add Vectorize Write |

**GitHub checks** (with `gh`, names only):

| Check | Failure says |
|---|---|
| Actions enabled | where to enable it |
| The `production` environment exists and is restricted to `main` | run `setup.sh` |
| Every required secret name is present | which names are missing; `setup.sh` pushes them |
| `CONNECTOR_ENABLED` agrees between `.env.local` and the GitHub variable | the two values; OpenTofu would plan a destroy (README 11.5) |
| The scheduled workflows are enabled | `gh workflow enable …` (README 7) |

**Local checks:**

- `.env.local` has mode 600.
- `DB_SYNC_ALLOWED_USERS` passes `check-format`.

### D7. `scripts/enable-connector.sh`

This runs the existing README section 11 as one command, after one browser step: creating the GitHub OAuth app.

1. It asks for `CONNECTOR_HOSTNAME`, which must be in the same zone as the sync hostname. `doctor`'s hostname checks run on it.
2. It prints the link to GitHub's "New OAuth App" page and the three values to paste: name, homepage URL and callback URL. GitHub documents no way to pre-fill that form. Then it asks for the client ID and secret, reading the secret silently.
3. It reads `OWNER_GITHUB_USER_ID` from `gh api user -q .id`, instead of asking for it, and shows the login so the user can confirm it.
4. It runs `init-env --add-missing --push` with those values in the environment, so `init-env` asks nothing more.
5. It runs `doctor.sh` (KV permission, connector hostname). Then it sets `CONNECTOR_ENABLED=true` in two places:
   - **`.env.local`:** it rewrites the existing line, with a backup, because appending a second line would rely on the last one winning when the file is sourced;
   - **the `production` environment variable** (README 11.5), which wins over a repository variable.

   `doctor` compares the local value with the effective one: the environment variable if it's set, otherwise the repository variable, otherwise `false`.
6. It runs and follows the deploy, then prints the claude.ai steps (README 11.6) with the `https://<connector-host>/mcp` URL.

**Turning the connector off** stays manual. It needs a careful state removal, documented in README 11.5.

### D8. The Cloudflare API token

The dashboard supports a link that pre-fills an account-owned token's permissions and name ([token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)). The link has this form:

`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<url-encoded JSON>&name=<name>`

- **It only fills in the form.** The user still picks the account and zone and clicks create.
- **Some permissions have documented short keys:** `workers_scripts`, `d1`, `workers_r2`, `workers_kv_storage`, `workers_routes` and `dns`.
- **The rest need permission group IDs,** which account-token links accept. These are Zone Read, Workers Observability Write and Vectorize Write. The only list of IDs found so far is a third-party snapshot, so **the builder confirms each ID** by opening the link on a test account and checking what the form shows. The IDs then live in one committed file, `config/token-permissions.json`.

`setup.sh`, `doctor` and the README print this link. It carries every permission the full setup can use, so one token covers enabling the connector and semantic search later, with no edit (today's 11.3 and 11.11 step 1). Compared with today's README 1.1 table, the token gains:

- **Zone Read** on the zone, for `doctor`'s zone checks;
- **Workers Observability Write** on the account, for `allow-user.sh`.

The README keeps the permissions table, updated, as the fallback if the link stops working.

**An inconsistency for the builder to settle.** README 1.1 says to grant "Workers Admin". Cloudflare's docs say Workers Admin is a role, and that "API tokens do not support platform-level Developer Platform permissions" ([Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/)). Meanwhile the token-permission names are "Workers Scripts Write/Edit". The link uses `workers_scripts` (edit). The builder checks which name the dashboard shows today, and corrects the table to match.

### D9. "Before you start": accounts and a domain

This is a new README section before the checklist. It's short, and links to the providers' own guides rather than describing their screens. The builder checks every link before it lands.

**GitHub**

- **An account,** and the `gh` CLI with `gh auth login`.
- **Use a public fork.** It is the only supported way on GitHub Free:
  - **It's public by necessity.** A fork of a public repo stays public ([about forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks): "You cannot change the visibility of a fork by itself"). The deploy relies on the `production` environment and its secrets, and GitHub Free offers environments only on public repos ([environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): "Users with GitHub Free plans can only configure environments for public repositories").
  - **Being public is safe here.** Nothing secret or identifying is ever committed; hostnames and IDs live in secrets.
  - **It keeps "Sync fork",** GitHub's button for pulling this project's fixes.
  - **Actions on a public repo use standard runners at no cost** ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
- **A private copy needs GitHub Pro or above,** for environments in a private repo. A "Use this template" copy can be private, but it starts with unrelated history, so it can't pull this project's fixes. The README mentions this in one line; it isn't a supported path.
- **Enable Actions on the fork** in its Actions tab. `setup.sh` checks this and enables the scheduled workflows itself (D4).

**Cloudflare**

- **An account on the Free plan.**
- **A payment method,** needed only to enable R2. Normal use stays inside the free allowances (README Costs).

**A domain.** The domain's DNS must be on Cloudflare, in a "full setup", and the zone must be `active`. Three routes:

- **Already have a domain on Cloudflare:** use a new subdomain, such as `sync.example.com`.
- **No domain:** buy one through Cloudflare Registrar. It charges the wholesale price with no markup, and the domain is on Cloudflare from the start. Not every ending is sold there.
- **A domain at another registrar:** add it to Cloudflare and change its nameservers at the registrar. Copy existing records first, especially email (MX). Cloudflare's import scan finds most, but check before switching. The zone shows `pending` until the change takes effect, sometimes for hours; `doctor` reports it. Buying a cheap second domain just for this is often simpler.

The partial (CNAME) setup isn't an option: it needs a Business plan or above, and isn't offered for Cloudflare Registrar domains ([partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)).

**Logseq.** Install a nightly build (README 0) on each device.

### D10. Tests

Each new script gets a `*.test.mjs`, in the style of the existing tests:

- **Stubs.** `gh` is stubbed on `PATH`. The Cloudflare API is a local stub server, reached through a test-only base URL that requires `*_TEST=1`.
- **Environment.** Tests clear `GITHUB_ACTIONS` unless they test Actions behaviour (the lesson from PR #36).

The tests must cover at least:

- **`ensure-account.mjs`:**
  - creates the bucket and subdomain only when missing;
  - stops with the R2 message on the not-enabled error;
  - never prints the token or account ID.
- **`setup.sh`:**
  - a fresh run calls every stage in order;
  - a second run on a finished install changes nothing (no `gh` write calls, no workflow run);
  - an existing `.env.local` is never regenerated;
  - the repo prompt defaults to no;
  - secrets are pushed by name only, and existing ones aren't overwritten without `--repush`.
- **`allow-user.sh`:**
  - offers each distinct refused email once;
  - writes, checks and pushes only after "y";
  - keeps a backup of `.env.local`;
  - replaces `none` in owner mode, and appends in add mode;
  - refuses in Actions;
  - does nothing when the wait ends with no refusal.
- **`doctor.sh`:** each check's ok and FAIL output, and the exit code.
- **`enable-connector.sh`:** reads the owner ID from `gh` and asks for nothing `init-env` would ask for again.
- **`init-env.sh --push-only`:** pushes exactly the named secrets, by stdin.

### D11. Existing installs

**Nothing changes for an install that already works.**

- **`deploy.yml`** gains the `ensure-account` step. It finds the bucket and subdomain present and does nothing. It only uses permissions every existing token already has: R2 Storage Write, and Workers Scripts for the subdomain. So no merge breaks an existing deploy.
- **No new token is required.** `doctor` warns about the two new permissions and skips the checks that need them (D6). `allow-user.sh` names the permission to add when it needs it.
- **The owner can run `doctor.sh`** any time. `setup.sh` on the owner's checkout finds every stage done.
- **`allow-user.sh` (add mode)** becomes the documented way to add someone. It replaces "edit `.env.local`, run the 1.8 loop, redeploy" in README 9.1.

### D12. How a fork gets updates: a weekly update PR *(owner)*

The original repo moves `UPSTREAM_REF` and `patches/` together, through its own `bump-upstream` PRs. A fork must take both together, from the original's `main`, never bumping on its own. Otherwise its patches stop applying.

**On a fork:**

- **A new `sync-upstream.yml` replaces `bump-upstream`.** It runs weekly, and on demand.
  1. It compares the fork's `main` with the parent repo's `main`. The parent is read from the GitHub API (`parent.full_name`), never hard-coded, so a fork of a fork follows its own parent.
  2. If the parent is ahead, it opens a PR into the fork's `main` carrying the parent's changes, or updates the one already open. Its body lists the incoming commits and the CI result, in the style of `bump-pr-body.sh`.
  3. The fork owner reviews and merges it. Merging deploys, as every merge to `main` does.
- **`bump-upstream.yml` does nothing on a fork:** its jobs gain `if: ${{ !github.event.repository.fork }}`. `sync-upstream.yml` does nothing on the original, with the opposite condition.
- **Conflicts** happen only if the fork changed tracked files. The PR shows them, and the README says to keep a fork unmodified and put local settings in GitHub variables and secrets.
- **"Sync fork" stays usable by hand,** but the README recommends the PR. The ruleset blocks direct pushes to `main` (builder to confirm), and the PR runs CI before the deploy.

**The constraint the builder must solve first.** The bump workflow's pattern doesn't carry over:

- The default `GITHUB_TOKEN` can't push a branch containing changes to `.github/workflows/`, and updates often contain them.
- A PR the default token opens doesn't trigger `pull_request` CI. `bump-upstream` works around that by dispatching `ci.yml` on its own branch. With no branch in the fork, there is nothing to dispatch on.

So the update PR's head must be the parent's `main` itself, which needs no push, and the required `check` status has to come another way. The candidate: `sync-upstream.yml` runs the `ci.yml` checks as a reusable workflow against the parent's head commit, then reports a `check` status on that commit. The ruleset requires `check` from GitHub Actions (`integration_id` 15368), so the status must count as that.

The builder runs a spike on a test fork before building. If no approach puts a passing `check` on the PR without a personal token:

- **The PR body still shows the CI result** the workflow got.
- **The owner merges with the admin bypass** the ruleset already allows through a pull request (`bypass_mode: pull_request`).
- **The README says so** in one line. No personal access token is ever required for updates.

**Upgrades for the owner's repo are unchanged.** `bump-upstream` there works as today.

## README

- **A new top:** "Quick start" with D9, the D2 checklist and `setup.sh`.
- **Sections 1 and 2** move under "Advanced: set up and deploy from your machine", trimmed where `ensure-account` and `setup.sh` replaced steps.
- **Section 3:** the first sign-in is refused, and `setup.sh` is waiting for it; otherwise run `scripts/allow-user.sh --owner`.
- **Section 9.1:** adding someone is `scripts/allow-user.sh`. The manual paths stay as the fallback.
- **Section 6 (Upgrades):** a fork merges its weekly update PR (D12). The bump PR text applies to the original repo only.
- **Section 11:** `enable-connector.sh` first. The manual steps stay as the fallback.
- **Troubleshooting:** most rows gain "`doctor.sh` checks this".

## Left to the builder

- Whether `setup.sh` is bash or Node. Likely bash for the orchestration and Node for the API calls, as today.
- The exact `gh` commands for each stage, within D4.
- How `allow-user.sh` reads logs, within D5's order of preference (query API first, then live tail).
- The harmless list call used for each permission check in D6.
- Message wording, following the repo's style.
- The `workers.dev` subdomain name `ensure-account` picks: random, and nothing identifying.
- A retry in the smoke test's first checks, so a fresh install doesn't fail while its certificate is still being issued.

## Open questions for the owner

None. The builder check raised four questions:

- **How forks get updates:** the owner chose the weekly update PR (D12).
- **The other three were the designer's calls,** recorded above:
  - a lost `.env.local` stops setup (D4 stage 3);
  - `allow-user.sh` chooses its mode by checking D1 (D5);
  - new token permissions only warn on existing installs (D6, D11);
  - `enable-connector.sh` rewrites the `CONNECTOR_ENABLED` line (D7).
