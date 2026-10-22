# Logseq DB sync on Cloudflare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public repo that builds upstream Logseq's `deps/db-sync` worker with one patch and deploys it to the owner's Cloudflare account at `https://sync.example.com`. OpenTofu manages the stateful resources, wrangler deploys the code, and GitHub Actions handles CI, deploys, the weekly upstream bump and daily backups. A README guide is included.

**Architecture:**

- `scripts/fetch-upstream.sh` checks out `logseq/logseq` at `UPSTREAM_REF` and applies `patches/*.patch`, failing fast.
- `scripts/check-upstream-bindings.mjs` fails if upstream's `wrangler.toml` changes shape.
- `scripts/render-wrangler.mjs` turns upstream's toml + `config/settings.json` + OpenTofu outputs into our toml, written over upstream's. That way `entry.mjs` and `migrations/` resolve unchanged.
- OpenTofu (`infra/`) owns D1 + R2, with `prevent_destroy`.
- wrangler owns the script, DO, custom domain and secrets.

**Tech Stack:**

- OpenTofu ≥ 1.10 with the `cloudflare/cloudflare` v5 provider;
- wrangler (the version upstream's `deps/db-sync/package.json` pins, currently `^4.151.1`);
- Node 22 with `node:test` and `smol-toml`;
- bash;
- GitHub Actions;
- upstream build: Java 21, Clojure CLI, pnpm 10.33.0;
- rclone (backups).

**Spec:** `docs/superpowers/specs/2026-10-21-logseq-cloudflare-selfhost-design.md`. Read it first; section numbers below refer to it.

## Global Constraints

**Repo and upstream**

- Repo root: the repository checkout, default branch `main`.
- GitHub: `C0ntr0lledCha0s/logseq-cloudflare-selfhost`, **public**.
- License: AGPL-3.0-or-later.
- Upstream: `https://github.com/logseq/logseq.git`.
- Initial `UPSTREAM_REF`: `69da7e2215b336cc5123dafb2a1686996e39596c`. The bump tracks `master`.

**Server settings**

- Hostname: `sync.example.com`. The zone `example.com` already exists on Cloudflare and is never managed by this repo.
- Worker name `logseq-sync`. D1 `logseq-sync-index`. R2 `logseq-sync-assets` and `logseq-sync-backups`.
- OpenTofu state bucket: `logseq-selfhost-tofu-state`, created manually.
- Rate-limit namespaces: `SEMANTIC_READ_RATE_LIMITER` → `"1001"` (120/60s), `SEMANTIC_WRITE_RATE_LIMITER` → `"1002"` (20/60s).
- `plan` ∈ `{"free","paid"}`, default `"free"`.
  - Free omits `[limits]` and `[[worker_loaders]]`.
  - Paid keeps them and adds the `/mcp` smoke check.
- Cognito vars are copied from upstream, unchanged.

**Safety rules**

- Never emit `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`, any `SENTRY_*`, `COGNITO_CLIENT_IDS` or `OPENAI_APPS_CHALLENGE`.
- `workers_dev = false`, `preview_urls = false`. The route is `{ pattern = hostname, custom_domain = true }`.
- Secrets never appear in the repo, the rendered toml, or logs. Logs never print graph ids, user ids or tokens.
- `deploy.yml` / `backup.yml` never run on `pull_request*`. Their secrets live in the GitHub environment `production`, restricted to `main`. `ci.yml` uses no secrets.
- **Commits:** concise imperative subjects (`feat:`, `fix:`, `docs:`, `ci:`). Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Outward-facing actions need the owner's explicit go-ahead in the session at that moment:** creating or pushing the GitHub repo, any `tofu apply`, `wrangler deploy`, `wrangler secret`, or remote D1 command.

## Review Focus

1. **Upstream adds a required binding or var** (e.g. a new secret or KV namespace). Expected: the binding check fails and names it. It must not deploy a worker that 500s. *Test in Task 3.*
2. **Upstream's top-level `[vars]` gains a forbidden key** (e.g. `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`). Expected: render throws. It must not silently drop the key and deploy. *Test in Task 4.*
3. **The patch no longer applies after a bump.** Expected: `fetch-upstream.sh` exits non-zero, names the patch, and leaves no half-applied tree. *Test in Task 2.*
4. **One graph's snapshot download fails during backup.** Expected: the D1 export is still uploaded, the job exits non-zero, and logs give counts only. *Test in Task 10.*
5. **The deployed server accepts unauthenticated `/api/v1/graphs`** (auth broken). Expected: the smoke test fails. *Test in Task 5.*

---

### Task 1: Repo skeleton and Node test harness

**Files:**
- Create:
  - `README.md` (title + one paragraph; the full guide is Task 11)
  - `LICENSE` (AGPL-3.0 text)
  - `UPSTREAM_REF`
  - `config/settings.json`
  - `mise.toml`
  - `package.json`
  - `.gitignore`

**Interfaces:**
- The hostname is deliberately not in settings (the repo is public): it is the required `SYNC_HOSTNAME` setting (env var locally, `production` environment secret in Actions).
- Produces `config/settings.json`, consumed by Tasks 4, 6 and 10:
  ```json
  {"plan":"free","workerName":"logseq-sync",
   "d1DatabaseName":"logseq-sync-index","assetsBucket":"logseq-sync-assets","backupsBucket":"logseq-sync-backups",
   "backupRetentionDays":90,
   "rateLimitNamespaces":{"SEMANTIC_READ_RATE_LIMITER":"1001","SEMANTIC_WRITE_RATE_LIMITER":"1002"}}
  ```
- Produces `UPSTREAM_REF`: one line, the 40-char SHA, trailing newline.
- `package.json`:
  - `"type":"module"`, `"private":true`;
  - dependency `smol-toml`;
  - script `"test": "node --test scripts/"`.
- `mise.toml` pins:
  - node 22;
  - pnpm 10.33.0;
  - java temurin-21;
  - clojure (latest stable);
  - opentofu 1.10.x or newer.
- `.gitignore`: `node_modules/`, `.upstream/`, `infra/.terraform/`, `*.tfplan`, `wrangler.rendered.toml`, `backup-out/`, `.env.local`, `infra/backend.hcl`, `tofu-output.json`.

- [ ] **Step 1:** Create the files above. Run `npm install` to create `package-lock.json`.
- [ ] **Step 2:** Run `npm test`. Expected: exits 0 with "no tests" (an empty suite is fine).
- [ ] **Step 3: Commit** `chore: scaffold repo`.

### Task 2: Fetch upstream and the PAT-gate patch

**Files:**
- Create:
  - `scripts/fetch-upstream.sh`
  - `scripts/build.sh`
  - `patches/0001-pat-gate-allow-authenticated-users.patch`
  - `scripts/fetch-upstream.test.mjs`

**Interfaces:**
- `scripts/fetch-upstream.sh <dest-dir> [ref]`:
  - `ref` defaults to the contents of `UPSTREAM_REF`.
  - Clones `logseq/logseq` at `ref` into `<dest-dir>` (fresh dir; it refuses if the dir is non-empty), using `git init` + `git fetch --depth 1 origin <ref>` + `git checkout FETCH_HEAD`.
  - For each `patches/*.patch` in lexical order, runs `git apply --check` and then `git apply`.
  - On a failed check, it prints `patch failed: <name>`, deletes `<dest-dir>`, and exits 1.
- `scripts/build.sh <upstream-dir>`: in `<upstream-dir>/deps/db-sync`, runs:
  1. `pnpm install --frozen-lockfile`
  2. `pnpm clean`
  3. `pnpm release`
  4. `pnpm build:api-docs`

  It exits non-zero on any failure (`set -euo pipefail`). Afterwards, `worker/dist/worker/main.js` and `worker/dist/api-docs.generated.mjs` exist.
- **Patch content** (spec §6). It changes two upstream files, both under `deps/db-sync/`:
  - **`src/logseq/db_sync/worker/handler/personal_access_token.cljs`:**
    - Delete `rtc-groups`, `user-info-url`, `claims-groups` and `<rtc-user?`.
    - In `<handle-authenticated`, remove the `p/let [rtc-user? …]` and the `(not rtc-user?) (http/forbidden)` branch. Any verified JWT with a string `sub` proceeds.
    - Drop now-unused requires (`clojure.set`).
  - **`test/logseq/db_sync/worker_dispatch_test.cljs`:**
    - Replace `pat-management-requires-rtc-group-login-jwt-test` with `pat-management-allows-any-authenticated-user-test`.
    - Claims are `#js {"sub" "user-1"}`, with no groups.
    - `"DB"` is stubbed so `index/<personal-access-tokens-list` resolves `[]`. Redef that fn, as other PAT tests do.
    - `js/fetch` is redefined to throw `"no outbound fetch"`.
    - Assert status `200` and body `{:tokens []}`.
    - Keep `rtc-claims` if other tests still use it; otherwise remove it.

- [ ] **Step 1: Write the failing script test** `scripts/fetch-upstream.test.mjs` (`node:test`). These tests hit the network and are skipped when `OFFLINE=1`.
  - `test("applies patches at UPSTREAM_REF")`: run the script into a temp dir. Assert exit 0. Assert the patched file does not contain `"rtc_2025_07_10"` and does not contain `"api.logseq.com"`.
  - `test("fails cleanly when a patch does not apply")`: copy `patches/` to a temp patches dir with an extra `0002-bad.patch` whose context can't match. Point the script at it via an env override `PATCHES_DIR`. Assert exit 1, stderr contains `patch failed: 0002-bad.patch`, and the dest dir does not exist.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (the script doesn't exist).
- [ ] **Step 3:** Write `fetch-upstream.sh` (it honours `PATCHES_DIR`, default `patches`). Write the patch by editing a scratch upstream checkout and using `git diff > patches/0001-…patch`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Run `mise install`, then `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream`. Then, in `.upstream/deps/db-sync`, run `pnpm test`. Expected: the upstream suite passes, including `pat-management-allows-any-authenticated-user-test`, and the dist files above exist.
  - If `pnpm release` needs npm installs in sibling `deps/*`, add them to `build.sh` and note why in a comment.
- [ ] **Step 6: Commit** `feat: fetch upstream and patch PAT group gate`.

### Task 3: Upstream binding check

**Files:**
- Create:
  - `config/expected-bindings.json`
  - `scripts/check-upstream-bindings.mjs`
  - `scripts/check-upstream-bindings.test.mjs`
  - `scripts/fixtures/upstream-wrangler.toml` (a verbatim copy of upstream `deps/db-sync/worker/wrangler.toml` at the pinned ref)

**Interfaces:**
- `export function collectShape(tomlText: string): string[]`. It returns sorted, unique entries for the **top-level (non-`env`) part only**:
  - `toplevel:<key>` for every top-level key;
  - `durable_object:<name>`;
  - `do_class:<class_name>`;
  - `do_migration:<tag>`;
  - `r2:<binding>`;
  - `d1:<binding>`;
  - `worker_loader:<binding>`;
  - `ratelimit:<name>`;
  - `version_metadata:<binding>`;
  - `var:<KEY>`.
- `export function checkUpstreamBindings(tomlText: string, expected: string[]): {ok: boolean, unexpected: string[], missing: string[]}`.
- CLI: `node scripts/check-upstream-bindings.mjs <upstream wrangler.toml>`.
  - It reads `config/expected-bindings.json` (a JSON array of strings).
  - It prints `unexpected: …` / `missing: …` lines and exits 1 if not ok, or prints `upstream bindings OK` and exits 0.
- `expected-bindings.json` = `collectShape(fixture)`, generated once and committed.

- [ ] **Step 1: Write failing tests:**
  - `test("pinned upstream toml matches expected")`: `ok === true`.
  - `test("new top-level binding kind is unexpected")`: fixture + `[[kv_namespaces]]\nbinding = "KV"\nid = "x"`. `unexpected` includes `toplevel:kv_namespaces`.
  - `test("new var is unexpected")`: add `NEW_SECRET_THING = "x"` under `[vars]`. `unexpected` includes `var:NEW_SECRET_THING`.
  - `test("new DO migration tag is unexpected")`: add a `[[migrations]] tag = "v2"`. `unexpected` includes `do_migration:v2`.
  - `test("removed binding is missing")`: remove the `[[r2_buckets]]` table. `missing` includes `r2:LOGSEQ_SYNC_ASSETS`.
  - `test("env sections are ignored")`: add `[env.foo.vars] X = "1"`. `ok === true`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement with `smol-toml` `parse`. Generate and commit `expected-bindings.json`.
- [ ] **Step 4:** Run `npm test`, then `node scripts/check-upstream-bindings.mjs .upstream/deps/db-sync/worker/wrangler.toml`. Expected: PASS, then `upstream bindings OK`.
- [ ] **Step 5: Commit** `feat: fail on upstream wrangler binding drift`.

### Task 4: Render our wrangler.toml

**Files:**
- Create:
  - `scripts/render-wrangler.mjs`
  - `scripts/render-wrangler.test.mjs`

**Interfaces:**
- Consumes the Task 1 `settings.json` shape and the Task 3 fixture.
- `export function renderWrangler({upstreamToml: string, settings: object, tofuOutputs: {d1_database_id: string}, hostname: string}): string`. Starting from the parsed upstream toml:
  1. Drop `env`.
  2. Set `name = settings.workerName`, `workers_dev = false`, `preview_urls = false`, `routes = [{pattern: hostname, custom_domain: true}]`.
  3. R2 `LOGSEQ_SYNC_ASSETS`: set `bucket_name = settings.assetsBucket`.
  4. D1 `DB`: set `database_name = settings.d1DatabaseName`, `database_id = tofuOutputs.d1_database_id`.
  5. Rate limiters: set each `namespace_id` from `settings.rateLimitNamespaces[name]`. Throw if a name is missing from settings.
  6. If `settings.plan === "free"`, delete `limits` and `worker_loaders`. If `"paid"`, keep them. Throw on any other value.
  7. Throw `forbidden var: <KEY>` if `vars` contains `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS` or any key starting with `SENTRY_`. Delete `COGNITO_CLIENT_IDS` and `OPENAI_APPS_CHALLENGE` if present.
  8. Stringify with `smol-toml`.

  Everything else is kept as upstream has it: `main`, `compatibility_date`, `compatibility_flags`, `observability`, DO bindings, `migrations`, `version_metadata`, and the Cognito vars.
- CLI: `node scripts/render-wrangler.mjs --upstream <toml> --settings config/settings.json --tofu-outputs <tofu-output.json> --out <path> --hostname <host>`.
  - `<tofu-output.json>` is `tofu output -json`, so it reads `.d1_database_id.value`.
  - The CLI also accepts `--plan` to override `settings.plan`.

- [ ] **Step 1: Write failing tests** against the fixture, with `d1_database_id: "00000000-0000-0000-0000-000000000000"`:
  - `test("free plan drops limits and worker_loaders")`: the parsed output has no `limits` / `worker_loaders`, and still has `ratelimits` (length 2), `durable_objects`, `version_metadata`.
  - `test("paid plan keeps limits and worker_loaders")`: `limits.cpu_ms === 300000` and `worker_loaders[0].binding === "LOADER"`.
  - `test("names, ids and domain come from settings")`:
    - `name === "logseq-sync"`, `workers_dev === false`;
    - `routes[0]` deep-equals `{pattern:"sync.example.com", custom_domain:true}`;
    - the bucket, the D1 name/id, and namespace ids `"1001"` / `"1002"` match;
    - no `env` key;
    - `main === "entry.mjs"`.
  - `test("forbidden vars throw")`: add `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS = "true"` to fixture `[vars]`. It throws `/forbidden var: DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS/`. Same for `SENTRY_DSN`.
  - `test("unknown plan throws")`: `plan: "pro"` throws.
  - `test("unknown rate limiter throws")`: settings without `SEMANTIC_WRITE_RATE_LIMITER` throws.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Copy the rendered toml into `.upstream/deps/db-sync/worker/wrangler.toml` (render with a fake D1 id). Then, in `.upstream/deps/db-sync/worker`, run `pnpm exec wrangler deploy --dry-run --outdir /tmp/x` for both plans. Expected: success on both, with no auth needed.
- [ ] **Step 6: Commit** `feat: render wrangler config from upstream and settings`.

### Task 5: Smoke test

**Files:**
- Create:
  - `scripts/smoke-test.sh`
  - `scripts/smoke-test.test.mjs`

**Interfaces:**
- `scripts/smoke-test.sh <base-url>`, with env `SMOKE_PAT` (optional) and `PLAN` (`free`|`paid`, default `free`). It checks, in order:
  1. `GET /health` returns body `{"ok":true}`;
  2. `GET /openapi.json` returns 200;
  3. `GET /api/v1/graphs` with no auth returns **401**;
  4. if `SMOKE_PAT` is set, `GET /api/v1/graphs` with `Authorization: Bearer $SMOKE_PAT` returns 200;
  5. if `PLAN=paid`, `POST /mcp` with no auth returns 401. A 404/5xx is a failure.

  It prints `ok <check>` / `FAIL <check>: <status>` and never echoes the PAT. Exit 1 on the first failure.

- [ ] **Step 1: Write failing tests.** Each test starts a local `node:http` stub server on a random port.
  - `test("passes against a healthy stub")`: the stub returns the expected statuses. Exit 0.
  - `test("fails when unauthenticated graphs list is 200")`: exit 1, stdout contains `FAIL unauthenticated-graphs`.
  - `test("fails when health body is wrong")`: exit 1.
  - `test("never prints the PAT")`: `SMOKE_PAT=logseq_pat_secret`. Output does not contain `logseq_pat_secret`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement with `curl -sS -o … -w '%{http_code}'`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add deployment smoke test`.

### Task 6: OpenTofu infrastructure

**Files:**
- Create:
  - `infra/versions.tf` (OpenTofu ≥ 1.10, provider `cloudflare/cloudflare` `~> 5`)
  - `infra/backend.tf`
  - `infra/encryption.tf`
  - `infra/main.tf`
  - `infra/variables.tf`
  - `infra/outputs.tf`
  - `infra/backend.hcl.example`

**Interfaces:**
- `variables.tf`: `cloudflare_account_id` (string). The provider reads `CLOUDFLARE_API_TOKEN` from the environment.
- `main.tf`:
  - `locals { settings = jsondecode(file("${path.module}/../config/settings.json")) }`.
  - `cloudflare_d1_database.index`, named `local.settings.d1DatabaseName`.
  - `cloudflare_r2_bucket.assets` (`assetsBucket`) and `cloudflare_r2_bucket.backups` (`backupsBucket`).
  - An R2 lifecycle rule on `backups` deleting objects after `backupRetentionDays`.
  - `lifecycle { prevent_destroy = true }` on all three.
- `outputs.tf`: `d1_database_id`, `assets_bucket`, `backups_bucket`.
- `backend.tf`: `backend "s3" {}` (partial).
  - `backend.hcl.example` documents:
    - `bucket = "logseq-selfhost-tofu-state"`, `key = "logseq-sync/terraform.tfstate"`;
    - `endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }`, `region = "auto"`;
    - `skip_credentials_validation`, `skip_region_validation`, `skip_requesting_account_id`, `skip_metadata_api_check`, `skip_s3_checksum`;
    - `use_path_style = true`;
    - `use_lockfile` — set per spike result S4.
  - Credentials come from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, which hold the R2 S3 keys.
- `encryption.tf`:
  - `key_provider "pbkdf2" "main"`, with the passphrase from `var.tofu_encryption_passphrase` (sensitive), fed via `TF_VAR_tofu_encryption_passphrase`;
  - `method "aes_gcm"`;
  - `state` and `plan` both enforced.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** Run `tofu -chdir=infra init -backend=false && tofu -chdir=infra validate && tofu fmt -check -recursive infra`. Expected: `Success! The configuration is valid.` and no fmt diff.
- [ ] **Step 3: Commit** `feat: add OpenTofu resources for D1 and R2`.

### Task 7: Phase-0 spike on the owner's account (manual, gated)

Each step that touches Cloudflare needs the owner's go-ahead in the session. Record everything in `docs/spike-results.md`, with one heading per S-item: the result, the evidence (command + trimmed output, no secrets), and the decision taken.

**Files:**
- Create: `docs/spike-results.md`
- Modify:
  - `infra/backend.hcl.example` (S4)
  - `config/settings.json` (only if S2 forces a plan change, **after asking the owner**)

- [ ] **Step 1: Bootstrap with the owner** (spec §9). The owner:
  - creates the API token and the `logseq-selfhost-tofu-state` bucket;
  - creates the R2 S3 credentials;
  - generates `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` and `TOFU_ENCRYPTION_PASSPHRASE`.

  These go in a local, untracked `.env.local` (already gitignored). Note the token permissions that turned out to be required.
- [ ] **Step 2: S4.** Run `tofu init -backend-config=backend.hcl` with `use_lockfile = true`, then `tofu plan`. Then, in a second shell, run `tofu plan` during the first plan's lock. Expected: either a lock error (locking works; keep `true`) or no lock (set `false`, and rely on CI `concurrency`).
- [ ] **Step 3:** Run `tofu apply`. Expected: D1 and two buckets are created, and outputs are printed.
- [ ] **Step 4: S1.** Render the free toml with the real `d1_database_id`. Then run:
  1. `wrangler d1 migrations apply logseq-sync-index --remote`
  2. `wrangler deploy`
  3. `wrangler secret put` for both secrets

  Expected: the deploy succeeds and `scripts/smoke-test.sh https://sync.example.com` passes checks 1–3.
- [ ] **Step 5: S2.** Create a PAT. Use a nightly desktop with the custom URL set (spec §11.5–6), or the curl fallback: `POST /api/v1/personal-access-tokens` with body `{"graph-id":"<id>","permission":"both"}` and `Authorization: Bearer <id-token>`. Then run the smoke test with `SMOKE_PAT`.
  - Expected: check 4 is 200.
  - If it returns **503 `rate limiter unavailable`**: **stop and ask the owner** whether to move to paid. Don't patch around it.
- [ ] **Step 6: S3.** The owner uploads their real (unencrypted) graph from nightly desktop, adds assets, and edits for a few minutes. Then run `wrangler tail` and the backup's snapshot download for that graph. Record any `exceededCpu` / `Worker exceeded CPU` events.
- [ ] **Step 7: S5.** The owner syncs a nightly mobile build (Android, and iOS if available) against the server. Record the client build versions and the result.
- [ ] **Step 8: Commit** `docs: record phase-0 spike results`, plus any `backend.hcl.example` or `settings.json` change.

### Task 8: CI and deploy workflows

**Files:**
- Create:
  - `.github/workflows/ci.yml`
  - `.github/workflows/deploy.yml`
  - `scripts/deploy.sh`

**Interfaces:**
- **`ci.yml`:**
  - Triggers: `pull_request`, `push` to non-main branches, and `workflow_call` with input `upstream_ref` (string, optional).
  - Jobs, without secrets:
    1. Set up mise.
    2. `npm ci && npm test`.
    3. `scripts/fetch-upstream.sh .upstream ${{ inputs.upstream_ref }}`.
    4. `node scripts/check-upstream-bindings.mjs .upstream/deps/db-sync/worker/wrangler.toml`.
    5. `scripts/build.sh .upstream`.
    6. Render both plans with a placeholder D1 id.
    7. `wrangler deploy --dry-run` for both.
    8. `tofu fmt -check` + `tofu validate` (`-backend=false`).
  - Cache `~/.m2`, `~/.gitlibs`, the pnpm store and `.upstream/deps/db-sync/.shadow-cljs`, keyed on `UPSTREAM_REF`.
  - Output `ci_result` (`success`/`failure`) for `workflow_call`.
- **`scripts/deploy.sh`** expects `.upstream` to be built, plus env `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN`, `SYNC_HOSTNAME`, optional `SMOKE_PAT`. It runs, in this order:
  1. `tofu output -json > tofu-output.json`;
  2. render into `.upstream/deps/db-sync/worker/wrangler.toml`;
  3. `wrangler d1 migrations apply <d1DatabaseName> --remote`;
  4. `wrangler deploy`;
  5. `wrangler secret bulk` from a JSON built in a temp file with mode 600 and deleted on exit;
  6. `scripts/smoke-test.sh https://<hostname>` with `PLAN` from settings.
- **`deploy.yml`:**
  - Triggers: `push` to `main`, and `workflow_dispatch`.
  - `environment: production`, `concurrency: {group: deploy, cancel-in-progress: false}`.
  - Steps:
    1. Set up mise.
    2. `npm ci`.
    3. `tofu init -backend-config` (written from secrets).
    4. `tofu apply -auto-approve`.
    5. Fetch + check + build.
    6. `scripts/deploy.sh`.
  - Secrets (environment `production`):
    - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
    - (no R2 secrets: `scripts/with-r2-credentials.sh` derives them from the token per step);
    - `TOFU_ENCRYPTION_PASSPHRASE`;
    - `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN`;
    - `SYNC_HOSTNAME` (only on the deploy and backup steps).
    - `SMOKE_PAT` (optional).

- [ ] **Step 1:** Write the files. Run `actionlint` (via `mise` or `go run`) and `shellcheck scripts/*.sh`. Expected: no findings.
- [ ] **Step 2: Commit** `ci: add build checks and deploy workflow`.
- [ ] **Step 3:** **With the owner's go-ahead**, create the public repo:
  1. `gh repo create C0ntr0lledCha0s/logseq-cloudflare-selfhost --public --source . --push`.
  2. Create the `production` environment restricted to `main`.
  3. The owner enters the secrets.
- [ ] **Step 4:** Open a PR from a branch with a trivial change. Expected: `ci.yml` is green and uses no secrets (check that the workflow file references none).
- [ ] **Step 5:** Merge. Expected: `deploy.yml` is green, including the smoke test with `SMOKE_PAT`.

### Task 9: Weekly upstream bump

**Files:**
- Create:
  - `.github/workflows/bump-upstream.yml`
  - `scripts/bump-pr-body.sh`

**Interfaces:**
- `scripts/bump-pr-body.sh <old-sha> <new-sha> <ci-result> <upstream-dir>` prints markdown to stdout:
  - a `CI: ✅ passed` / `CI: ❌ failed — see run <url from $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID>` line;
  - `git log --oneline <old>..<new> -- deps/db-sync`;
  - a **New D1 migrations** list (files added under `deps/db-sync/worker/migrations/`), or "none".
- **`bump-upstream.yml`:**
  - Triggers: `schedule` `0 3 * * 1` and `workflow_dispatch`.
  - Permissions: `contents: write`, `pull-requests: write`.
  - Job `resolve`: `git ls-remote https://github.com/logseq/logseq.git refs/heads/master`. If it equals `UPSTREAM_REF`, exit with no PR.
  - Job `check`: `uses: ./.github/workflows/ci.yml` with `upstream_ref`.
  - Job `pr` (`if: always()` after `check`): write `UPSTREAM_REF` on branch `bump/upstream-<short-sha>`, then `gh pr create`, or update the existing open bump PR, with the body from `bump-pr-body.sh`.

- [ ] **Step 1: Write a failing test** `scripts/bump-pr-body.test.mjs`. Build a temp git repo with two commits, the second adding `deps/db-sync/worker/migrations/0008_x.sql`.
  - `test("lists new migrations")`: stdout contains `0008_x.sql`.
  - `test("marks failed CI")`: with `failure`, stdout contains `CI: ❌ failed`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Run `actionlint`. Push, then trigger `workflow_dispatch`. Expected: either "already up to date" or a PR with the CI line and commit list.
- [ ] **Step 6: Commit** `ci: add weekly upstream bump`.

### Task 10: Backups

**Files:**
- Create:
  - `scripts/backup.sh`
  - `scripts/backup.test.mjs`
  - `.github/workflows/backup.yml`

**Interfaces:**
- `scripts/backup.sh <out-dir>`. It expects `.upstream` fetched and `pnpm install --frozen-lockfile` run in `.upstream/deps/db-sync`. No cljs build is needed, but `download_graph_db.js` requires `better-sqlite3` and `transit-js`. It also expects env:
  - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
  - `DB_SYNC_ADMIN_TOKEN`;
  - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (derived from the token by `scripts/with-r2-credentials.sh`, which wraps the call).

  It reads names from `config/settings.json` and the hostname from the required `SYNC_HOSTNAME` env var. With `DATE=$(date -u +%F)`:
  1. `wrangler d1 export <d1> --remote --output <out>/index.sql`, then upload to `<backupsBucket>/<DATE>/index.sql` (`wrangler r2 object put --remote`). **This runs first and uploads before anything else can fail.**
  2. List graph ids with `wrangler d1 execute <d1> --remote --json --command "select graph_id from graphs"`. For each id, run `node .upstream/deps/db-sync/worker/scripts/download_graph_db.js --base-url https://<hostname> --graph-id <id> --output <out>/graphs/<n>.sqlite` (with `DB_SYNC_ADMIN_TOKEN` in the env), then upload to `<DATE>/graphs/`.
     - Files are numbered `<n>`, not named by id, so ids never reach logs. Write a `graphs/index.json` mapping n→id, uploaded but never printed.
     - Count failures and continue.
  3. `rclone sync` from `:s3:<assetsBucket>` to `:s3:<backupsBucket>/assets`. Use the env-configured R2 remote (`RCLONE_CONFIG_R2_*`; provider Cloudflare, endpoint `https://<account>.r2.cloudflarestorage.com`).
  4. Print `backup: d1=ok graphs=<ok>/<total> assets=ok|fail`. Exit 1 if any part failed.
- **`backup.yml`:**
  - Triggers: `schedule` `0 14 * * *` (≈ 02:00–03:00 NZ) and `workflow_dispatch`.
  - `environment: production`.
  - Steps: set up mise + rclone, `scripts/fetch-upstream.sh .upstream`, `pnpm install --frozen-lockfile` in `.upstream/deps/db-sync`, `scripts/backup.sh backup-out`.

- [ ] **Step 1: Write failing tests.** Put stub `wrangler`, `node` and `rclone` executables on `PATH` in a temp dir. They record their args to a log, and their behaviour is controlled by env.
  - `test("uploads d1 export before graphs")`: in the args log, the `r2 object put … index.sql` line comes before any `download_graph_db.js` line.
  - `test("one failed graph still exits 1 after uploading the rest")`: 3 graphs, the 2nd download fails. Exit 1, stdout has `graphs=2/3`, and the log shows 2 graph uploads.
  - `test("never prints graph ids")`: graph ids are UUIDs, and stdout+stderr contain none of them.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** `actionlint`, then push. **With the owner's go-ahead**, trigger `workflow_dispatch`. Expected: green, and `logseq-sync-backups/<date>/` holds `index.sql`, `graphs/`, and `assets/`.
- [ ] **Step 6: Commit** `feat: add daily backups`.

### Task 11: The guide and the vendored REST skill

**Files:**
- Modify: `README.md`
- Create: `skills/logseq-rest-api/SKILL.md`, copied verbatim from upstream `.agents/skills/logseq-rest-api/SKILL.md` at `UPSTREAM_REF`, with a top note naming the source commit.

**Interfaces:** the README contains every section in spec §11, in that order, including item 0 (nightly builds). Concrete values:
- `https://sync.example.com`.
- The token permission list as finalised in `docs/spike-results.md`.
- The curl PAT fallback, with body `{"graph-id":"…","permission":"both"}`.
- The remote Claude Code setup:
  - env `LOGSEQ_PAT`, `LOGSEQ_BASE_URL`;
  - network allowance for the hostname;
  - `curl -H "Authorization: Bearer $LOGSEQ_PAT" "$LOGSEQ_BASE_URL/api/v1/graphs"`.
- Free → paid switch steps: subscribe to Workers Paid in the dashboard, set `"plan":"paid"`, merge, then expect the `/mcp` smoke check.
- Troubleshooting entries from spec §11.12.
- The backlog (spec §13).

- [ ] **Step 1:** Write it. Check every command in it against the scripts and workflows as built. Fix whichever of the two is wrong.
- [ ] **Step 2: Commit** `docs: write self-hosting guide`.

### Task 12: Acceptance

- [ ] **Step 1:** Walk spec §15 items 1–8 with the owner. Record pass/fail per item under a new `## Acceptance` heading in `docs/spike-results.md`. Item 6 (remote Claude Code session reads and writes) is done by the owner from a cloud session following the README only.
- [ ] **Step 2:** Fix any README gaps found, then commit `docs: record acceptance`.
