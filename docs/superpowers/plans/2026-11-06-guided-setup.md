# Guided Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user, comfortable in a terminal, goes from a fork to a deployed, owner-claimed sync server. They do a short browser checklist, then run `scripts/setup.sh`.

**Architecture:** Small, separately tested pieces, joined up by a bash orchestrator:

- **Node modules** call the Cloudflare API through one shared client, and edit `.env.local` safely.
- **Bash wrappers** load `.env.local` and drive `gh`.
- **The deploy workflow** creates the account prerequisites on its first run.
- **Forks** get updates through a weekly PR from their parent.

**Tech Stack:** bash, Node 22 (ESM, built-in `fetch` and `node:test`, no new npm dependencies), the GitHub CLI (`gh`), the Cloudflare REST API, and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-06-guided-setup-design.md`. Read it with this plan; decisions D1–D12 are cited by number.

## Global Constraints

- **Secrets never appear in argv, logs or output.** Values travel on stdin or in the environment. In GitHub Actions, derived identifiers are masked with `::add-mask::`.
- **No owner identifiers in the repo or in Actions output:** no hostnames, account ID, user IDs or emails. Docs and tests use `sync.example.com`, `mcp.example.com`, account `acct` and token `tok`.
- **Test-only API overrides.** New Node scripts reach Cloudflare at `https://api.cloudflare.com/client/v4`. `CF_API_BASE` overrides it **only** when `CF_API_TEST=1`, and only with `https://…` or `http://127.0.0.1:<port>`. Anything else is an error that names the rule, and the default base is never silently used instead.
- **Script shape.** Every new script has a `*.test.mjs` beside it, run by `npm test` (`node --test "scripts/*.test.mjs"`). Bash scripts start with `set -euo pipefail`.
- **Test environment.** Tests set `GITHUB_ACTIONS: ""` unless they test Actions behaviour.
- **Never touch the user's real files.** Tests never use the real `.env.local` or the real `gh`: they use temp dirs and a stubbed `gh` on `PATH`.
- **`.env.local` handling.** It stays mode 600. Only `DB_SYNC_ALLOWED_USERS` and `CONNECTOR_ENABLED` are ever rewritten in place, each after a timestamped backup (spec anti-goals).
- **Pinned actions.** Workflow actions are pinned by full SHA with a version comment, copied from the existing workflows. `permissions` are minimal per job.
- **Commits:**
  - Format: `type(scope): what changed`, with scopes `deploy`, `infra` or `docs`.
  - The body says what the tests prove.
  - It ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - No agent name appears anywhere else.
- **Writing:** UK/NZ English, plain sentences.
- **The gate:** `scripts/check.sh` passes at the end of every task.

## Review Focus

1. **Hostnames at any depth, in any case.** `sync.a.example.co.uk` must find the zone `example.co.uk`, by trying ever shorter suffixes, not just dropping the first label. Upper case, a trailing dot or surrounding spaces are a `FAIL` with a message, never a lookup of the wrong name. The test lives in Task 4.
2. **Real `.env.local` files are messy.** A line may be written `export NAME=…` or indented, and a value may be quoted. Rewriting one line must leave every other byte identical, keep mode 600, and fail when the name is absent, rather than append. The test lives in Task 3.
3. **A setup interrupted half-way.** Re-running after some secrets were pushed pushes only the missing ones, and never regenerates `.env.local`. The test lives in Task 6.
4. **`gh` logged in as someone without admin rights on the repo.** A 403 from creating the environment or ruleset must name the cause ("needs admin on `<repo>`; `gh auth status` shows who you are"), not dump an API error. The test lives in Task 6.
5. **Strangers in the refusal log.** Several refusals from the same person are offered once. Every prompt defaults to No. Declining everyone writes nothing. The test lives in Task 5.

---

### Task 1: Shared Cloudflare client, test helpers, and `ensure-account.mjs` in the deploy

**Files:**
- Create: `scripts/cloudflare-api.mjs`
- Create: `scripts/test-helpers.mjs`. It isn't a `*.test.mjs`, so `npm test` doesn't run it.
- Create: `scripts/ensure-account.mjs` and `scripts/ensure-account.test.mjs`
- Create: `scripts/cloudflare-api.test.mjs`
- Modify: `scripts/allowed-users.mjs` (import `readEnvelope` instead of defining it)
- Modify: `.github/workflows/deploy.yml` (a new step before `Tofu init`)
- Modify: `scripts/deploy-workflow.test.mjs`

**Interfaces:**

- **Produces, in `scripts/cloudflare-api.mjs`:**
  - `DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4"`
  - `class CfError extends Error { status: number; codes: number[] }`
  - `apiBaseFromEnv(env): string` returns `env.CF_API_BASE` only when `env.CF_API_TEST === "1"` and the URL matches `^(https://\S+|http://127\.0\.0\.1:\d+)$`. Otherwise it returns `DEFAULT_API_BASE` when `CF_API_BASE` is unset, and throws `Error("CF_API_BASE is test-only and requires CF_API_TEST=1")` (or `"... must be https:// or http://127.0.0.1:<port>"`) when it is set.
  - `readEnvelope(res, label = "Cloudflare API"): Promise<object>`, moved verbatim from `allowed-users.mjs`, whose call sites pass `"D1 API"` so their messages don't change. On failure it throws a `CfError` carrying the HTTP status and the numeric `errors[].code` values.
  - `cf({ apiBase, apiToken, method = "GET", path, query, body, fetchImpl = fetch }): Promise<object>` returns the whole parsed envelope (`result`, `result_info`). `query` is an object turned into URL parameters, and `body` is JSON-encoded. The token never appears in any error message.
- **Produces, in `scripts/test-helpers.mjs`:**
  - `stubGh(dir, rules): { bin: string, log: string, calls(): Array<{argv: string[], stdin: string}> }` writes a Node `gh` stub into `dir/bin`.
    - Each rule is `{ match: string[], stdout?: string, exit?: number }`. The first rule whose `match` is a prefix of argv applies.
    - **An unmatched call** exits 1, with `unstubbed gh call: <argv>` on stderr.
  - `cfStub(routes): Promise<{ base: string, requests: Array<{method, path, query, body}>, close(): Promise<void> }>` starts an HTTP server on `127.0.0.1`.
    - Each route is keyed `"METHOD /path"`, without the query string. A route is a function `(req) => [status, json]`.
    - **An unmatched route** returns `404 {success:false, errors:[{code:7003, message:"no route"}]}`.
  - `runScript(file, args, { env, input, cwd }): Promise<{ status, stdout, stderr }>` spawns `file` with `{ ...process.env, GITHUB_ACTIONS: "", ...env }`, and writes `input` to stdin.
- **Produces, in `scripts/ensure-account.mjs`:**
  - `STATE_BUCKET = "logseq-selfhost-tofu-state"`
  - `ensureAccount({ accountId, apiToken, apiBase, fetchImpl, randomHex }): Promise<{ bucket: "created" | "present", subdomain: "created" | "present" }>`
  - **CLI:** `node scripts/ensure-account.mjs` reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment. It prints `state bucket: created|present` and `workers.dev subdomain: created|present`, and exits 1 with the message on error.
- **Behaviour (spec D3):**
  - **Bucket.** `GET /accounts/{id}/r2/buckets` with `name_contains=logseq-selfhost-tofu-state`, then an exact match on `result.buckets[].name`. Missing means `POST /accounts/{id}/r2/buckets {"name": STATE_BUCKET}`.
  - **R2 not enabled.** Error code `10042` on either call means it throws `R2 isn't enabled on this account. Enable it at dash.cloudflare.com → R2 (a payment method is required), then re-run.`
  - **Subdomain.** `GET /accounts/{id}/workers/subdomain`. A non-empty `result.subdomain` means present. An HTTP 404, or an empty or missing `result.subdomain`, means missing, so it calls `PUT` with `{"subdomain": "logseq-" + randomHex(8)}`. Any other error is thrown. Task 10 confirms the real "none yet" response live.

- [ ] **Step 1: Write the failing tests** in `scripts/cloudflare-api.test.mjs` and `scripts/ensure-account.test.mjs`, using `cfStub`:
  - `apiBaseFromEnv`:
    - returns the default with nothing set;
    - throws on `CF_API_BASE` without `CF_API_TEST=1`;
    - throws on `http://example.com` even with the switch;
    - accepts `http://127.0.0.1:1234` with the switch.
  - `cf` sends `Authorization: Bearer tok`. On an error envelope `{errors:[{code:10042,message:"x"}]}` with status 403, it throws a `CfError` with `status === 403` and `codes` `[10042]`, and with a message that doesn't contain `tok`.
  - `ensureAccount`, bucket and subdomain both missing: it makes exactly one POST with body `{name:"logseq-selfhost-tofu-state"}` and one PUT whose `subdomain` matches `/^logseq-[0-9a-f]{8}$/`, and returns `{bucket:"created", subdomain:"created"}`.
  - `ensureAccount`, both present (the list returns that bucket; the subdomain returns `{subdomain:"existing"}`): no POST or PUT, and it returns `"present"` twice.
  - `ensureAccount`, a bucket named `logseq-selfhost-tofu-state-old` only: that isn't an exact match, so it creates the bucket.
  - The R2 list returning 10042: it rejects with the message above, and makes no PUT.
  - The CLI via `runScript` with `CF_API_TEST=1`, `CF_API_BASE=<stub>`, `CLOUDFLARE_ACCOUNT_ID=acct` and `CLOUDFLARE_API_TOKEN=tok`: exit 0. Its two lines match `/^state bucket: (created|present)$/m` and `/^workers.dev subdomain: (created|present)$/m`, and the output contains neither `acct` nor `tok`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/cloudflare-api.test.mjs scripts/ensure-account.test.mjs`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 3: Implement** `scripts/cloudflare-api.mjs`, `scripts/test-helpers.mjs` and `scripts/ensure-account.mjs` as specified. Change `allowed-users.mjs` to `import { readEnvelope } from "./cloudflare-api.mjs"`; its existing tests must still pass unchanged.
- [ ] **Step 4: Wire it into the deploy.** In `deploy.yml`, add a step `Ensure account prerequisites` immediately before `Tofu init`:
  - env `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from secrets, nothing else;
  - `run: node scripts/ensure-account.mjs`.
  
  In `deploy-workflow.test.mjs`, assert that this step exists, comes before `Tofu init`, and has exactly those two secrets.
- [ ] **Step 5: Run `npm test`.** Expected: all pass, including `allowed-users.test.mjs` and `list-users.test.mjs` unchanged.
- [ ] **Step 6: Commit.** Message: `feat(deploy): create the state bucket and workers.dev subdomain on first deploy`.

### Task 2: `init-env.sh --push-only` and `scripts/run-deploy.sh`

**Files:**
- Modify: `scripts/init-env.sh`, `scripts/init-env.test.mjs`
- Create: `scripts/run-deploy.sh`, `scripts/run-deploy.test.mjs`

**Interfaces:**

- **Consumes:** `stubGh` and `runScript` from Task 1.
- **Produces, `init-env.sh --push-only NAME…`:**
  - It reads `.env.local` (the same repo-root rules and test overrides as today), and pushes exactly the named values to the `production` environment of the checkout's repo. It uses the existing loop: stdin only, and the `GITHUB_CLIENT_*` → `CONNECTOR_GITHUB_CLIENT_*` mapping.
  - **Allowed names** are the six original names, the six connector names, `DB_SYNC_ALLOWED_USERS` and `SMOKE_PAT`. Any other name exits 2 with `init-env: --push-only: unknown name X`.
  - **A name missing or empty in `.env.local`** exits 1 naming it, and pushes nothing (all names are checked before any push).
  - **It can't be combined** with `--add-missing` or `--push`.
  - **Success** prints `Pushed N secrets to the GitHub production environment.`
- **Produces, `scripts/run-deploy.sh [--if-not-green]`:**
  1. With `--if-not-green`, it first asks `gh run list -R <repo> --workflow deploy.yml --branch main --limit 1 --json conclusion,status`. A completed run with conclusion `success` prints `deploy: the latest run on main succeeded; nothing to do`, and the script exits 0.
  2. Otherwise it records the time, runs `gh workflow run deploy.yml -R <repo> --ref main`, then polls `gh run list -R <repo> --workflow deploy.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt,url` every 3 s, for at most 60 s, until a run created at or after that time appears.
  3. It then runs `gh run watch <id> -R <repo> --exit-status`.
  4. **On success** it prints `deploy: succeeded (<url>)`, exit 0.
  5. **On failure** it prints `deploy: failed at step "<step name>" (<url>)` and exits 1. The step name is the first step with conclusion `failure`, from `gh run view <id> -R <repo> --json jobs,url`. It never prints run logs.
  6. **No run appearing within 60 s** prints `deploy: the run didn't start; check the Actions tab at https://github.com/<repo>/actions` and exits 1.
  
  `<repo>` comes from `gh repo view --json nameWithOwner -q .nameWithOwner`, run in the repo root. A test-only `RUN_DEPLOY_POLL_SECONDS` overrides the poll interval only with `RUN_DEPLOY_TEST=1`.

- [ ] **Step 1: Write the failing tests.**
  - **`init-env.test.mjs`, new `--push-only` tests:**
    - pushes `DB_SYNC_ALLOWED_USERS` alone: one `gh secret set DB_SYNC_ALLOWED_USERS … --env production` call whose stdin is the file's value;
    - maps `GITHUB_CLIENT_ID` to `CONNECTOR_GITHUB_CLIENT_ID`;
    - an unknown name exits 2 with no `gh secret` call;
    - one empty name among two exits 1 with no `gh secret` call;
    - `--push-only` with `--push` exits 2.
  - **`run-deploy.test.mjs`**, with a stub `gh` whose `run list` rule returns a run created after the start:
    - success: prints `deploy: succeeded`, exit 0, and the calls include `workflow run deploy.yml` and `run watch <id>`;
    - watch exits 1 and `run view` returns a jobs JSON with a failed step `Deploy`: it prints `failed at step "Deploy"`, exit 1;
    - `--if-not-green` with a latest run `{status:"completed",conclusion:"success"}`: no `workflow run` call, exit 0;
    - `--if-not-green` with a latest run that failed: it starts a new run;
    - no new run appears, with `RUN_DEPLOY_TEST=1` and `RUN_DEPLOY_POLL_SECONDS=0`: the "didn't start" message, exit 1, and the test finishes in under 5 s.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/init-env.test.mjs scripts/run-deploy.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement both.** In `init-env.sh`, reuse the existing push loop by setting `add_names` from the arguments. Don't copy the loop.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): push named secrets and follow a deploy run from the terminal`.

### Task 3: Editing `.env.local` and the token link

**Files:**
- Create: `scripts/env-file.mjs`, `scripts/env-file.test.mjs`
- Create: `config/token-permissions.json`, `scripts/token-link.mjs`, `scripts/token-link.test.mjs`
- Modify: `.gitignore` (add `.env.local.bak-*`)

**Interfaces:**

- **Produces, `scripts/env-file.mjs`:**
  - `readEnvValue(path, name): string | undefined` returns the value of the first `NAME=`, `export NAME=` or indented `NAME=` line. It strips one pair of surrounding single or double quotes.
  - `setEnvLine(path, name, value, { now = new Date() } = {}): string` and its backup:
    - **Backup:** it first copies the file to `<path>.bak-YYYYMMDDHHMMSS` (from `now`, UTC) with mode 600.
    - **Rewrite:** it replaces only the first matching line, keeping that line's `export ` prefix and indentation. It writes `NAME=value` with no quotes, and refuses a value that contains whitespace, a quote, `$` or a newline.
    - **Atomic write:** it writes to a temp file in the same directory with mode 600, then renames it over the original.
    - **Result:** it returns the backup path. It throws `NAME is not in <path>; add it with scripts/init-env.sh --add-missing` when no line matches.
  - **CLI:** `node scripts/env-file.mjs get NAME` prints the value. `node scripts/env-file.mjs set NAME` takes the new value from the environment variable `ENV_FILE_VALUE`, never argv, and prints `<name> updated (backup: <basename>)`. The file is `.env.local` at the repo root, unless `ENV_FILE_PATH` is set together with `ENV_FILE_TEST=1`.
- **Produces, `config/token-permissions.json`:**
  - `{ "name": "logseq-selfhost", "permissions": [ … ] }`. Each entry is either `{ "key": <short key>, "type": "edit"|"read" }` or `{ "id": <group id>, "label": <human name> }`.
  - **Short keys:** `workers_scripts` edit, `d1` edit, `workers_r2` edit, `workers_kv_storage` edit, `workers_routes` edit, `dns` edit.
  - **IDs, each with `"verified": false`,** until Task 10 confirms them:
    - Zone Read `c8fed203ed3043cba015a93ad1616f1f`, labelled `"Zone Read"`;
    - Workers Observability Write `66c1ed49f4ed46098b75696a6d4ee3c9`, labelled `"Workers Observability Write"`;
    - Vectorize Write `64156ba5be47441096c83c7fc17c488b`, labelled `"Vectorize Write"`.
  - **Note for the implementer:** the Observability and Vectorize IDs come from a third-party snapshot, and the Zone Read ID is unverified too. Keep them, flagged, exactly as given.
- **Produces, `scripts/token-link.mjs`:**
  - `tokenLink(config = readConfig()): string` returns `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<encodeURIComponent(JSON of [{key,type}] and [{key:id}])>&name=<encoded name>`. Per Cloudflare's docs, an ID goes in `key`.
  - `permissionLabels(config): string[]` returns human names for the README and for messages.
  - **CLI:** prints the link.

- [ ] **Step 1: Write the failing tests.**
  - **`env-file.test.mjs`:**
    - rewrites `DB_SYNC_ALLOWED_USERS=none` in a fixture mixing `export A=1`, `  B='x y'`, a comment and a blank line. Only that line changes, the rest is byte-identical, the mode stays `0o600`, and a backup named `.env.local.bak-20261106093000` exists (with `now = new Date("2026-11-06T09:30:00Z")`) with the old content;
    - keeps `export ` on `export CONNECTOR_ENABLED=false` → `export CONNECTOR_ENABLED=true`;
    - throws with the `--add-missing` hint when the name is absent, and writes no backup or file;
    - refuses the value `a b` and the value `$x`;
    - `readEnvValue` returns `x y` for `B='x y'`;
    - the CLI `set` gets its value from `ENV_FILE_VALUE`, and its output doesn't contain the value.
  - **`token-link.test.mjs`:**
    - the link starts with `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=`;
    - decoding `permissionGroupKeys` gives an array containing `{key:"workers_scripts",type:"edit"}` and `{key:"66c1ed49f4ed46098b75696a6d4ee3c9"}`;
    - `name=logseq-selfhost`;
    - the JSON file parses, and every entry has `key`+`type` or `id`+`label`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/env-file.test.mjs scripts/token-link.test.mjs`.
- [ ] **Step 3: Implement** as specified, and add `.env.local.bak-*` to `.gitignore`.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): edit .env.local lines safely and build the token link`.

### Task 4: `scripts/doctor.sh`

**Files:**
- Create: `scripts/doctor.mjs`, `scripts/doctor.sh` (mode 755), `scripts/doctor.test.mjs`

**Interfaces:**

- **Consumes:** `cf`, `CfError` and `apiBaseFromEnv` (Task 1); `tokenLink` (Task 3); `parseAllowedUsers` from `allowed-users.mjs`; `stubGh` and `cfStub` (Task 1).
- **Produces, `scripts/doctor.mjs`:**
  - `findZone(hostname, cfCall): Promise<{ id, name, status } | null>`. It tries `GET /zones?name=<suffix>` for each suffix of `hostname` from the parent domain downwards. For `sync.a.example.co.uk` that is `a.example.co.uk`, then `example.co.uk`, then `co.uk`. It returns the first exact `name` match.
  - `runDoctor({ env, cfCall, gh, now }): Promise<{ results: Array<{ level: "ok"|"warn"|"FAIL", name: string, detail: string }>, exitCode: 0|1 }>`. `gh(args): { status, stdout }` is injected; the CLI uses `spawnSync("gh", args)`.
  - **CLI:** `node scripts/doctor.mjs` prints each result as `<level padded to 4> <name>: <detail>`, then `doctor: N failed, M warnings`, and exits `exitCode`.
- **Produces, `scripts/doctor.sh`:** loads `.env.local` with the same caller-wins logic as `list-users.sh`, but for every name `doctor.mjs` reads. It then runs `exec node scripts/doctor.mjs`. If `.env.local` is missing it exits 1 with `doctor: no .env.local; run scripts/setup.sh first`.
- **Checks, in order (spec D6, with these exact `name`s):**
  - **`hostname`.** `SYNC_HOSTNAME` must equal its trimmed, lower-cased form and contain no trailing dot. Otherwise `FAIL`.
  - **`token`:** `GET /accounts/{id}/tokens/verify`, `result.status === "active"`. Otherwise `FAIL`, with the detail containing `tokenLink()`.
  - **Permission checks.** One check each, all on the account `CLOUDFLARE_ACCOUNT_ID`:

    | Name | Call |
    |---|---|
    | `perm:d1` | `GET /accounts/{id}/d1/database?per_page=1` |
    | `perm:r2` | `GET /accounts/{id}/r2/buckets?per_page=1` |
    | `perm:workers` | `GET /accounts/{id}/workers/subdomain`. A 404 counts as ok. |
    | `perm:kv` | `GET /accounts/{id}/storage/kv/namespaces?per_page=1`. Only when `CONNECTOR_ENABLED=true`. |
    | `perm:zone` | the `findZone` call |
    | `perm:observability` | `POST /accounts/{id}/workers/observability/telemetry/query` with `{queryId:"doctor", timeframe:{from: now-60000, to: now}, view:"events", limit:1, dry:true}` |
    | `perm:vectorize` | `GET /accounts/{id}/vectorize/v2/indexes`. Only when `SEMANTIC_SEARCH_ENABLED=true`. |

    - **What counts as missing.** HTTP 401 or 403, other than code `10042`, means the permission is missing, and the detail names it and contains `tokenLink()`.
    - **New permissions.** `perm:zone` and `perm:observability` are `warn` (detail `"… skipped checks: zone, dns"` or `"… allow-user.sh needs it"`) when the sync Worker is already deployed. That is, when `GET /accounts/{id}/workers/domains?hostname=<SYNC_HOSTNAME>&service=<workerName>` returns at least one result. Otherwise they are `FAIL`. Every other permission is always `FAIL`.
  - **`r2-enabled`.** `FAIL` when the `perm:r2` call returned code `10042`, with the D3 message.
  - **`zone`.** Run when the zone can be read. `FAIL` if `findZone` returns null (`<host> isn't in a zone on this account`), or if the status isn't `active` (`zone <name> is <status>: its nameservers haven't switched to Cloudflare yet (README "Before you start")`).
  - **`dns`.** Run when the zone can be read. Read `GET /zones/{zone}/dns_records?name=<host>` and `GET /accounts/{id}/workers/domains?hostname=<host>`.
    - **ok** when there are no records, or when a custom domain for `<host>` exists whose `service` is the Worker name from `config/settings.json` `workerName`.
    - **FAIL** otherwise, with the spec D6 text: the hostname is in use, and a deploy from Actions would replace the record.
  - **The connector's hostname.** When `CONNECTOR_ENABLED=true`, `hostname`, `zone` and `dns` run again for `CONNECTOR_HOSTNAME` (worker `connector.workerName`), named `connector-hostname`, `connector-zone` and `connector-dns`.
  - **GitHub checks.** These use `gh`, with the repo from `gh repo view`. `gh` failing to run is `FAIL github: gh isn't installed or logged in (gh auth login)`.

    | Name | Check |
    |---|---|
    | `actions` | `gh api repos/<r>/actions/permissions` → `enabled` |
    | `environment` | `gh api repos/<r>/environments/production` exists, and `deployment_branch_policy.custom_branch_policies` is true |
    | `secrets` | `gh secret list -R <r> --env production --json name`, compared with the required names: the seven in README 1.8, plus the six connector names (with `CONNECTOR_GITHUB_*`) when `CONNECTOR_ENABLED=true` |
    | `connector-setting` | the effective GitHub value: `gh variable get CONNECTOR_ENABLED -R <r> --env production`, else the repo-level `gh variable get CONNECTOR_ENABLED -R <r>`, else `false`. `FAIL` when it differs from the local `CONNECTOR_ENABLED` (default `false`), with both values and the README 11.5 pointer |
    | `schedules` | `gh workflow list -R <r> --all --json name,state`. `warn` for each of `backup`, `usage`, and `sync-upstream` (fork) or `bump-upstream` (not a fork, from `gh repo view --json isFork`) whose state isn't `active` |
  - **Local checks.**
    - **`env-mode`:** `.env.local` mode must be 600, else `FAIL` with `chmod 600 .env.local`.
    - **`allowed-users`:** `parseAllowedUsers(env.DB_SYNC_ALLOWED_USERS).ok`, else `FAIL` with its error.

- [ ] **Step 1: Write the failing tests** (`doctor.test.mjs`), with `cfStub` and an injected fake `gh`.
  - **All green:** a stub where everything is present, with `SYNC_HOSTNAME=sync.example.com` and zone `example.com` active. `exitCode` is 0, and every `name` above (minus the connector and vectorize ones) appears as `ok`.
  - **`findZone("sync.a.example.co.uk")`:** queries `a.example.co.uk`, then `example.co.uk`, and stops there.
  - **`SYNC_HOSTNAME="Sync.Example.com"`:** `hostname` is `FAIL`, and no zone lookup is made for it.
  - **Zone `pending`:** `zone` is `FAIL`, and the detail contains `pending`.
  - **DNS records:**
    - an `A` record at the hostname and no custom domain: `dns` is `FAIL`, and the detail contains `would replace`;
    - the same record plus a custom domain with `service: "logseq-sync"`: `dns` is ok.
  - **`perm:observability` returning 403:**
    - with the Worker deployed (domains returns one entry): `warn`, and `exitCode` 0;
    - not deployed: `FAIL`, and the detail contains `dash.cloudflare.com/?to=/:account/api-tokens`.
  - **The R2 list returning 403 with code 10042:** `r2-enabled` is `FAIL` with the D3 message, and `perm:r2` isn't also reported missing.
  - **`connector-setting`:** the environment variable `true` with local `false` gives `FAIL`, and the detail contains both values.
  - **`secrets`:** `SYNC_HOSTNAME` missing from `gh secret list` gives `FAIL`, and the detail contains the name `SYNC_HOSTNAME`.
  - **Secrets never leak:** the output never contains the token value `tok`, nor the account ID `acct`, in any test.
  - **`doctor.sh` with no `.env.local`** (via `runScript` with a temp repo root): exit 1 with the message above. The test override `DOCTOR_REPO_ROOT` is honoured only with `DOCTOR_TEST=1`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/doctor.test.mjs`.
- [ ] **Step 3: Implement** `doctor.mjs` and `doctor.sh`.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): add doctor.sh to check the account, domain and repo before setup`.

### Task 5: `scripts/allow-user.sh`

**Files:**
- Create: `scripts/allow-user.mjs`, `scripts/allow-user.sh` (mode 755), `scripts/allow-user.test.mjs`

**Interfaces:**

- **Consumes:**
  - `cf` and `apiBaseFromEnv` (Task 1);
  - `readEnvValue` and `setEnvLine` (Task 3);
  - `parseAllowedUsers` and `fetchUsers` from `allowed-users.mjs`;
  - `init-env.sh --push-only DB_SYNC_ALLOWED_USERS` and `run-deploy.sh` (Task 2).
- **Produces, `scripts/allow-user.mjs`:**
  - `parseRefusal(event): { sub, email } | null`. It applies to an event whose `JSON.stringify` contains `user-not-allowed`.
    - **`sub`:** the first match of `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/`.
    - **`email`:** the first match of `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/`, or `null`.
    - The exact log shape is confirmed live in Task 10. This parser deliberately reads the whole serialised event, so it works whether glogi logs the map as text or as an object.
  - `findRefusals({ cfCall, accountId, workerName, fromMs, toMs }): Promise<Array<{ sub, email }>>`. One `POST /accounts/{id}/workers/observability/telemetry/query` with this body:

    ```
    {queryId:"allow-user", timeframe:{from:fromMs,to:toMs}, view:"events", limit:100, dry:true,
     parameters:{filters:[
       {key:"$metadata.message", operation:"includes", type:"string", value:"user-not-allowed"},
       {key:"$workers.scriptName", operation:"eq", type:"string", value:workerName}]}}
    ```

    It reads `result.events.events`, keeps what `parseRefusal` accepts, and de-duplicates by `sub`, keeping the first.
  - `chooseMode({ owner, localList, knownUsers }): "owner" | "add"` throws `Error` with the spec D5 messages:
    - **Owner mode** requires `localList` to be `none` and `knownUsers` to be 0.
    - **A local `none` with `knownUsers > 0`** throws `.env.local looks out of date: the server has N users but DB_SYNC_ALLOWED_USERS is none here. Restore the current .env.local (password manager or your other machine), then re-run.`
    - **Add mode** requires `localList` not to be `none`. Otherwise it throws `the list is none: run scripts/allow-user.sh --owner to claim the server first`.
    - **`--owner` with a non-`none` list** throws `the server is already claimed; run scripts/allow-user.sh without --owner to add someone`.
  - `nextList(mode, localList, sub): string`. Owner mode gives `sub`. Add mode gives `localList + "," + sub`, unchanged if `sub` is already listed.
  - **CLI:** `node scripts/allow-user.mjs [--owner] [--wait <minutes, default 10>] [--show-ids]`, run through `allow-user.sh`.
    1. **Refuse in Actions:** if `GITHUB_ACTIONS=true`, print `error: allow-user prints emails, so it never runs in GitHub Actions` and exit 1, before reading anything.
    2. **Choose the mode:** `fetchUsers` for the D1 count, then `chooseMode`.
    3. **Find refusals:** print the waiting message (spec D5 step 1, with `https://<SYNC_HOSTNAME>`). Query once over the last 30 minutes, then every 10 s (`ALLOW_USER_POLL_SECONDS` is a test override, honoured only with `ALLOW_USER_TEST=1`) until a refusal not yet listed appears, or `--wait` ends. Each poll covers from the previous poll's start, minus 60 s overlap.
    4. **Confirm:** for each new refusal, prompt `Allow <email or "an account with no email">? [y/N] ` on stderr, and read a line from stdin. Only `y` or `yes` (any case) accepts. With `--show-ids`, the ID is shown in brackets.
    5. **After the first acceptance:**
       1. `setEnvLine(.env.local, "DB_SYNC_ALLOWED_USERS", nextList(...))`;
       2. `parseAllowedUsers` on the result (fail means stop, with the file restored from the backup);
       3. spawn `scripts/init-env.sh --push-only DB_SYNC_ALLOWED_USERS`;
       4. spawn `scripts/run-deploy.sh`;
       5. print `Sign in again. (Re-enter the server URL first if Logseq signed you out.)`.

       Only one person is added per run.
    6. **No acceptance before `--wait` ends:** print the spec D5 "what to check" text and exit 1, with nothing written.
    7. **A 401 or 403 from the query** prints `the token can't read Workers Logs: add "Workers Observability Write" to it, or make a new token with <tokenLink()>`, and exits 1.
- **Produces, `scripts/allow-user.sh`:** an Actions check first, the same as `list-users.sh`, then `.env.local` loading with caller-wins, then `exec node scripts/allow-user.mjs "$@"`.

- [ ] **Step 1: Write the failing tests** (`allow-user.test.mjs`). Unit tests cover the exported functions; CLI tests use `runScript` with a temp repo root (`ALLOW_USER_REPO_ROOT` with `ALLOW_USER_TEST=1`), `cfStub` for the telemetry and D1 calls, and a `stubGh`.
  - **`parseRefusal`** on two fixtures returns `{sub:"11111111-2222-4333-8444-555555555555", email:"a@example.com"}` for both:
    - a text message `[logseq.db-sync.worker.auth] :db-sync/user-not-allowed {:sub "11111111-2222-4333-8444-555555555555", :email "a@example.com"}`;
    - an object source `{"$metadata":{"message":"user-not-allowed"},"source":{"sub":"11111111-…","email":"a@example.com"}}`.
  - **`findRefusals`:** three events for the same sub and one for another give two results. The request body has both filters and `view:"events"`.
  - **`chooseMode`:** all four branches, with the exact messages.
  - **`nextList`:**
    - `("owner","none",S)` gives `S`;
    - `("add","A",S)` gives `"A,"+S`;
    - `("add","A,"+S,S)` gives `"A,"+S`.
  - **CLI, owner mode,** input `y\n`, one refusal, empty D1 users:
    - `.env.local` now has `DB_SYNC_ALLOWED_USERS=<sub>`, and a `.bak-` file exists;
    - the `gh` stub log shows `secret set DB_SYNC_ALLOWED_USERS` with stdin `<sub>`, then `workflow run deploy.yml`;
    - stdout contains `Sign in again`.
  - **CLI, two distinct people, input `\n\n`:** both prompts appear, nothing is written, there are no `gh secret` calls, and it exits 1 after `--wait 0`.
  - **CLI, local `none` with 2 D1 users:** exit 1 with `looks out of date`, and no telemetry query is made.
  - **CLI with `GITHUB_ACTIONS=true`:** exit 1 with the Actions message, and zero stub requests.
  - **CLI, the telemetry query answering 403:** the message contains `Workers Observability Write`, exit 1.
  - **No secret leaks:** no test's output contains `tok`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/allow-user.test.mjs`.
- [ ] **Step 3: Implement** `allow-user.mjs` and `allow-user.sh`.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): add allow-user.sh to claim the server and add people from the refusal log`.

### Task 6: `scripts/setup.sh`

**Files:**
- Create: `scripts/setup.sh` (mode 755), `scripts/setup.test.mjs`

**Interfaces:**

- **Consumes:**
  - `init-env.sh` and its `--push-only`, plus `run-deploy.sh [--if-not-green]` (Task 2);
  - `doctor.sh` (Task 4);
  - `allow-user.sh --owner` (Task 5);
  - `token-link.mjs` (Task 3);
  - `.github/rulesets/protect-main.json`.
- **Produces, `scripts/setup.sh [--yes] [--repush] [--deploy]`:** the stages of spec D4, in order. Each prints `== <n>. <title>` and either `done` (already in place) or what it did.
  1. **Prerequisites.**
     - `gh` must be on `PATH` and `gh auth status` must exit 0. Otherwise: `install gh (https://cli.github.com) and run gh auth login`.
     - **The token's scopes** must include `repo`, read from `gh auth status`'s "Token scopes" line. If that line is present without `repo`, stop with `gh needs the repo scope: run gh auth refresh -s repo`. Fine-grained tokens print no scopes line, so they are left to the 403 handling in stage 5. Task 10 item 4 confirms whether more scopes are needed.
     - `node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'`, and `openssl` on `PATH`.
     - `git remote get-url origin` must contain `github.com`.
  2. **Which repo.** Print `This will set up <repo> (GitHub) and deploy to your Cloudflare account.` If `gh repo view --json isFork -q .isFork` is `false`, also print `Note: <repo> is not a fork. If you meant to set up your own copy, fork it first (README "Before you start").` Then ask `Set up <repo>? [y/N] `, unless `--yes`. Anything but `y` or `yes` exits 1 with `nothing changed`.
  3. **Values.**
     - **No `.env.local`:** run `gh secret list -R <repo> --env production --json name` (a missing environment counts as no secrets).
       - **Any secret listed:** exit 1 with the spec D4 "already set up, restore `.env.local`" message.
       - **None listed:** print the token link (`node scripts/token-link.mjs`) with `Create the Cloudflare API token with this link, then paste it below:`, and run `scripts/init-env.sh`.
     - **Then the passphrase reminder:** print `Save TOFU_ENCRYPTION_PASSPHRASE from .env.local in your password manager now. Press Enter when done.` and read a line, unless `--yes`.
  4. **Checks.** `scripts/doctor.sh`. A non-zero exit stops with `fix the FAIL lines above, then re-run scripts/setup.sh`. Doctor's GitHub checks for the environment, secrets and schedules can't pass before stages 5 and 6, so setup runs doctor with `DOCTOR_SKIP_GITHUB=1`. `doctor.mjs` gains that flag: it skips the GitHub group and prints `skip github: setup.sh configures it next`.
  5. **GitHub settings.** Each item is created only if missing:
     - **Environment:** `gh api repos/<r>/environments/production`. A 404 means create it with the two README 1.8 calls, the environment and the `main` branch policy.
     - **Ruleset:** `gh api repos/<r>/rulesets --jq '.[].name'`. No `Protect main` means `gh api -X POST repos/<r>/rulesets --input .github/rulesets/protect-main.json`.
     - **Workflow permission:** `gh api repos/<r>/actions/permissions/workflow -q .can_approve_pull_request_reviews`. `false` means the README 1.8 PUT.
     - **Actions:** `gh api repos/<r>/actions/permissions -q .enabled`. `false` means print `Enable Actions: open https://github.com/<r>/actions and click the green button. Press Enter when done.`, read a line, and check again; still `false` exits 1.
     - **Schedules:** `gh workflow enable <file> -R <r>` for `backup.yml` and `usage.yml`, plus `sync-upstream.yml` on a fork or `bump-upstream.yml` otherwise. This happens only when `gh workflow list --all --json path,state` shows the workflow isn't `active`.
     - **A 403 from any of these** stops with `gh is logged in as <login> (gh api user -q .login), which can't change settings on <r>: it needs admin on the repo.`
  6. **Secrets.** Required = the seven names from README 1.8. The missing ones are the required names not in `gh secret list`, or all seven with `--repush`. If any are missing, run `scripts/init-env.sh --push-only <missing…>`; otherwise print `done`.
  7. **First deploy.** `scripts/run-deploy.sh --if-not-green`, or `scripts/run-deploy.sh` with `--deploy`.
  8. **Next steps.**
     - **List still `none`:** print `Your server is at https://<SYNC_HOSTNAME>.`, then `exec scripts/allow-user.sh --owner`.
     - **Otherwise:** print `Setup is complete. Run scripts/doctor.sh any time to check it.` and exit 0.
- **Test overrides,** each honoured only with `SETUP_TEST=1`: `SETUP_REPO_ROOT`, the root holding `.env.local` and the scripts it calls. The tests copy stub scripts into a temp root, so setup's calls to `init-env.sh`, `doctor.sh`, `run-deploy.sh` and `allow-user.sh` are recorded rather than run. The real scripts are tested in their own tasks.

- [ ] **Step 1: Write the failing tests** (`setup.test.mjs`). A temp root holds stub `scripts/*.sh` that append their name and args to a log, plus a `stubGh` with rules per scenario.
  - **Fresh run** (`--yes`, no `.env.local`, `secret list` empty, environment 404, no ruleset, `can_approve false`, Actions enabled, every workflow `disabled_fork`):
    - the stub-script log is `init-env.sh`, `doctor.sh`, `init-env.sh --push-only <7 names>`, `run-deploy.sh --if-not-green`, `allow-user.sh --owner`, in that order;
    - the `gh` log contains the environment PUT, the branch-policy POST, `rulesets` POST with `--input`, the workflow-permission PUT, and three `workflow enable` calls.
  - **Second run on a finished install** (everything present, `DB_SYNC_ALLOWED_USERS` set to a UUID, all workflows `active`, all seven secrets listed):
    - no `gh api -X PUT|POST`, no `workflow enable`, and no `init-env` call;
    - `run-deploy.sh --if-not-green` is called once;
    - it exits 0 with `Setup is complete`.
  - **No `.env.local`, but `gh secret list` returns `[{"name":"SYNC_HOSTNAME"}]`:** exit 1 with `already set up`, and `init-env.sh` isn't called.
  - **The repo prompt** without `--yes`, input `\n`: exit 1 with `nothing changed`, and no `gh` write calls.
  - **Partial push:** `secret list` returns five of the seven, so the push-only call names exactly the two missing ones. With `--repush`, it names all seven.
  - **A 403 from the environment PUT:** exit 1, with stderr containing `needs admin on` and the stubbed login.
  - **`gh auth status` failing:** exit 1 with `gh auth login`.
  - **`gh auth status` listing `Token scopes: 'gist', 'read:org'`:** exit 1 with `gh auth refresh -s repo`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/setup.test.mjs`.
- [ ] **Step 3: Implement** `setup.sh`, and add `DOCTOR_SKIP_GITHUB` to `doctor.mjs`, with a test in `doctor.test.mjs` that it skips the five GitHub checks.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): add setup.sh, one command from a fresh fork to a deployed server`.

### Task 7: `scripts/enable-connector.sh`

**Files:**
- Create: `scripts/enable-connector.sh` (mode 755), `scripts/enable-connector.test.mjs`

**Interfaces:**

- **Consumes:**
  - `init-env.sh --add-missing --push` (existing);
  - `doctor.sh` (Task 4);
  - `env-file.mjs set` (Task 3);
  - `run-deploy.sh` (Task 2).
- **Produces, `scripts/enable-connector.sh`** (spec D7). It needs `.env.local`, and refuses in Actions. Steps:
  1. **Already on?** If `CONNECTOR_ENABLED` is `true` in `.env.local` and the GitHub environment variable is `true`, print `the connector is already on` and exit 0.
  2. **Hostname.** Read `CONNECTOR_HOSTNAME` from the environment, or prompt for it. Lower-case it. It must end with `.` plus the zone part of `SYNC_HOSTNAME`, meaning `SYNC_HOSTNAME` minus its first label. Otherwise it exits 1 with `the connector hostname must be in the same domain as <SYNC_HOSTNAME minus first label>`.
  3. **OAuth app.** Print:

     ```
     Create a GitHub OAuth app at https://github.com/settings/applications/new with:
       Application name:            Logseq connector
       Homepage URL:                https://<CONNECTOR_HOSTNAME>
       Authorization callback URL:  https://<CONNECTOR_HOSTNAME>/callback
     ```

     Then read `GITHUB_CLIENT_ID` (prompt) and `GITHUB_CLIENT_SECRET` (prompt with `read -rs`), unless they're set in the environment.
  4. **Owner ID.** `OWNER_GITHUB_USER_ID` comes from `gh api user -q .id`. Print `Owner: <login> (from gh)`, with the login from `gh api user -q .login`.
  5. **Secrets.** Run `scripts/init-env.sh --add-missing --push` with the four values exported, so it prompts for nothing.
  6. **Settings and checks.**
     1. `CONNECTOR_ENABLED=true` through `env-file.mjs set` (value via `ENV_FILE_VALUE`);
     2. `gh variable set CONNECTOR_ENABLED --env production --body true -R <repo>`;
     3. `scripts/doctor.sh` (with the connector now on, its hostname, KV and secret checks run). A failure stops here with the fix, before any deploy.
  7. **Deploy:** `scripts/run-deploy.sh`.
  8. **Next steps:** print the README 11.6 claude.ai steps, with `https://<CONNECTOR_HOSTNAME>/mcp`.
- **Test override:** `ENABLE_CONNECTOR_REPO_ROOT`, honoured only with `ENABLE_CONNECTOR_TEST=1`. Stubbed scripts work as in Task 6.

- [ ] **Step 1: Write the failing tests** (`enable-connector.test.mjs`).
  - **Happy path,** with input `mcp.example.com\nclient-id\nclient-secret\n` and `SYNC_HOSTNAME=sync.example.com`:
    - the `init-env.sh --add-missing --push` stub is called with `OWNER_GITHUB_USER_ID=12345` in its environment (the stub records it), where `gh api user -q .id` was stubbed as `12345`;
    - `.env.local` ends with `CONNECTOR_ENABLED=true`;
    - the `gh` log has `variable set CONNECTOR_ENABLED --env production --body true`;
    - the order is init-env, doctor, run-deploy;
    - stdout contains `https://mcp.example.com/mcp`, and never `client-secret`.
  - **`mcp.other.org`:** exit 1 with `same domain`, and no init-env call.
  - **Already on in both places:** exit 0 with `already on`, and no other calls.
  - **The doctor stub exiting 1:** no `run-deploy.sh` call, exit 1.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/enable-connector.test.mjs`.
- [ ] **Step 3: Implement** `enable-connector.sh`.
- [ ] **Step 4: Run `npm test`.** Expected: all pass.
- [ ] **Step 5: Commit.** Message: `feat(deploy): add enable-connector.sh to turn the connector on in one command`.

### Task 8: Fork updates, plus a smoke-test retry

**Files:**
- Create: `.github/workflows/sync-upstream.yml`, `scripts/sync-upstream-workflow.test.mjs`
- Modify: `.github/workflows/bump-upstream.yml` (fork guard)
- Modify: `.github/workflows/ci.yml` (optional `repository` and `ref` inputs for `workflow_call`)
- Modify: `scripts/smoke-test.sh`, `scripts/smoke-test.test.mjs`

**Interfaces:**

- **`ci.yml`.** `workflow_call.inputs` gains `repository` (string, default `""`) and `ref` (string, default `""`). The `check` job's `actions/checkout` step gets `repository: ${{ inputs.repository || github.repository }}` and `ref: ${{ inputs.ref }}`. Push, PR and dispatch runs behave as before.
- **`bump-upstream.yml`.** Every job gains `if: ${{ !github.event.repository.fork }}`, combined with any existing `if` using `&&`. Keep `always()` where it already is.
- **`sync-upstream.yml`** (spec D12):
  - **Triggers:** `schedule: cron "0 4 * * 1"` and `workflow_dispatch`.
  - **Workflow permissions:** `contents: read`.
  - **Concurrency group:** `sync-upstream`.
  - **Job `resolve`** (`if: ${{ github.event.repository.fork }}`), with `GH_TOKEN: ${{ github.token }}`:
    1. Parent: `gh api repos/${{ github.repository }} -q .parent.full_name`.
    2. Parent SHA: `gh api repos/<parent>/commits/main -q .sha`.
    3. Ahead count: `gh api repos/${{ github.repository }}/compare/main...<parent-owner>:main -q .ahead_by`.
    4. Outputs `parent`, `sha` and `behind` (`true` when the count > 0).
  - **Job `check`** (needs `resolve`; `if: needs.resolve.outputs.behind == 'true'`; `permissions: contents: read`): `uses: ./.github/workflows/ci.yml` with `repository: <parent>` and `ref: <sha>`.
  - **Job `pr`** (needs both; `if: always() && needs.resolve.outputs.behind == 'true'`; `permissions: contents: read, pull-requests: write, statuses: write`):
    1. **Find an open PR** with `gh pr list -R ${{ github.repository }} --base main --state open --json number,headRepositoryOwner,headRefName`, filtered to head owner = the parent owner and head ref `main`.
    2. **Body.** Write it to a file: `Brings in <ahead_by> commits from <parent>@<sha:0:10>.`, then the CI result (`needs.check.result`), then a line saying merging deploys.
    3. **Create or update** the PR with that body: `gh pr create -R <repo> --base main --head <parent-owner>:main --title "chore: update from <parent>"`, or `gh pr edit`.
    4. **Report the status:** `gh api repos/${{ github.repository }}/statuses/<sha> -f state=<success|failure> -f context=check -f description="CI on the update"`. The state is `success` only when `needs.check.result == 'success'`.
  - **Pinning.** Every `uses:` is pinned by SHA, as in `bump-upstream.yml`.
- **`smoke-test.sh`.** The first `/health` request retries up to `SMOKE_HEALTH_ATTEMPTS` times (default 10), with `SMOKE_HEALTH_DELAY` seconds between attempts (default 15). The override is honoured only with `SMOKE_TEST=1`; the tests use 0. A 200 continues as today. After the last attempt, it fails with the last status, as today.

- [ ] **Step 1: Write the failing tests.**
  - **`sync-upstream-workflow.test.mjs`** parses the YAML text with simple line checks, in the style of `deploy-workflow.test.mjs`:
    - the triggers are `schedule` and `workflow_dispatch`;
    - `resolve` has `if: ${{ github.event.repository.fork }}`;
    - `check` uses `./.github/workflows/ci.yml` with `repository:` and `ref:`;
    - the `pr` job's permissions are exactly `contents: read`, `pull-requests: write` and `statuses: write`;
    - every `uses: ` line that isn't a local `./` path matches `@[0-9a-f]{40}`;
    - the file contains no `${{ secrets.` at all;
    - every job in `bump-upstream.yml` has an `if:` containing `!github.event.repository.fork`;
    - `ci.yml` declares `repository` and `ref` under `workflow_call.inputs`.
  - **`smoke-test.test.mjs`:** a stub server answering 503 twice, then 200 on `/health`, passes with `SMOKE_TEST=1`, `SMOKE_HEALTH_ATTEMPTS=3` and `SMOKE_HEALTH_DELAY=0`. With `SMOKE_HEALTH_ATTEMPTS=2`, it fails with `FAIL health: 503`.
- [ ] **Step 2: Run them and see them fail.** Run `node --test scripts/sync-upstream-workflow.test.mjs scripts/smoke-test.test.mjs`.
- [ ] **Step 3: Implement** the workflow, the guards, the `ci.yml` inputs and the retry.
- [ ] **Step 4: Run `npm test`.** Also run `actionlint` on the three workflows, if it's installed; otherwise note in the report that it wasn't run.
- [ ] **Step 5: Commit.** Message: `feat(deploy): give forks a weekly update PR and retry the first health check`.

### Task 9: README and repo docs

**Files:**
- Modify: `README.md`, `CLAUDE.md` (Map: the new scripts; Commands: `doctor.sh`), `.env.local.example` (comment lines only, if a pointer to `setup.sh` helps)

The README follows spec "README" and D1, D2, D8 and D9. Concretely:

- **A new "Quick start", right after "What you get" and "Costs":**
  1. **"Before you start"** (spec D9 text, with links). The builder opens every link and keeps only those that load and say what the text claims.
  2. **"Browser checklist"** (spec D2, 5 items). Item 4 is "run `node scripts/token-link.mjs` and open the link", with the permissions table below it as the fallback. The table follows `config/token-permissions.json`, and its first row uses the name the dashboard shows (spec D8 inconsistency; Task 10 confirms it).
  3. **"Run setup":** `git clone`, `npm ci`, `scripts/setup.sh`. Then what it does, in the spec D4 order, in plain words. What to expect: the refused first sign-in and the owner claim.
  4. **"If something fails":** `scripts/doctor.sh`, and re-run `setup.sh`.
- **Sections 1 and 2** move under one heading, `Advanced: set up and deploy from your machine`, with a first sentence saying the Quick start replaces them for most people.
  - **1.3** goes: the deploy creates the subdomain.
  - **1.6** becomes a note that the deploy creates the bucket, and that `node scripts/ensure-account.mjs` does it locally.
- **Section 3:** the refused first sign-in paragraph now says `setup.sh` is waiting for it, or run `scripts/allow-user.sh --owner`.
- **Section 6:** a new first paragraph on forks: the weekly "chore: update from …" PR, merging it deploys, keep the fork unmodified. It also covers the admin-bypass merge if the PR shows no `check` (spec D12 fallback). The bump text is marked "on the original repo".
- **Section 9.1:**
  - "Finding your user ID" leads with `scripts/allow-user.sh`;
  - "Adding someone" becomes "ask them to sign in, then run `scripts/allow-user.sh`";
  - the manual paths stay as the fallback.
- **Section 11:** 11.2–11.5 lead with `scripts/enable-connector.sh` after the OAuth app. The manual steps stay below, under "By hand".
- **Troubleshooting:** add `doctor.sh checks this` to the rows it covers (1.1, 1.2, 1.3, `pending` zone, `CONNECTOR_ENABLED`), plus new rows:
  - "`doctor`: the hostname is in use";
  - "`setup.sh`: already set up, restore `.env.local`";
  - "`allow-user`: no refusal seen".
- **The patch count and other counts** stay correct.

- [ ] **Step 1: Make the edits.** Load the repo's writing conventions from CLAUDE.md. No secret values, hostnames or IDs: use `sync.example.com` and `mcp.example.com`.
- [ ] **Step 2: Check the links and anchors.**
  - Run `grep -o '](#[^)]*)' README.md | sort -u` and check that each anchor matches a heading.
  - Run `grep -n 'example.com' README.md` and check that every hostname is a placeholder.
- [ ] **Step 3: Run `npm test`.** Expected: all pass. The README isn't tested, but scripts must not have regressed.
- [ ] **Step 4: Commit.** Message: `docs: lead the README with the guided setup`.

### Task 10: Live checks (the controller, with the owner, before merging)

This task isn't dispatched to a subagent. It touches real accounts, so the controller does it with the owner, who runs anything with outward effects. Each item records its result in the PR body, and any code change it forces is made and reviewed before merge.

1. **Token link.** The owner opens `node scripts/token-link.mjs` and confirms that the form shows all nine permissions, with the right names and scopes.
   - Correct any ID in `config/token-permissions.json` that shows the wrong permission, then set `"verified": true` on each.
   - Record the dashboard's name for the Workers Scripts permission, and fix the README table if it isn't "Workers Admin".
2. **Refusal log.** With a token that has Workers Observability Write, the owner signs in from a second Logseq account and is refused. Then run `scripts/allow-user.sh --wait 2` and answer `n`.
   - Confirm the refusal is offered with the right email.
   - If it isn't, capture one event from the telemetry query, with the email and sub redacted, to set the filter key and `parseRefusal`.
3. **`doctor.sh` on the owner's install.** It reports no `FAIL`. Warnings are fine and expected for the two new permissions on the old token.
4. **A test fork,** under a throwaway GitHub account or organisation, to settle the open GitHub questions:
   - Does `gh api repos/<fork>/actions/permissions` report `enabled: false` before the Actions click, and does setup's prompt cover it?
   - Does `sync-upstream`'s status call make the ruleset's required `check` pass? If not, record the admin-bypass fallback in the README (Task 9 already describes it).
   - Does "Sync fork" get blocked by the ruleset?
   - Are `gh auth login`'s default scopes enough for every `setup.sh` stage?
5. **The `workers.dev` subdomain response** on an account that has none, to confirm Task 1's "missing" detection. Use the test fork's Cloudflare account if one is available; otherwise record this as unverified in the PR.

- [ ] **Step 1:** Work through items 1–5 with the owner, and record each result.
- [ ] **Step 2:** Make any fixes as their own commits, each with its test, and re-run `scripts/check.sh`.
