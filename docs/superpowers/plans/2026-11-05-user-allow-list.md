# User allow-list and upstream `/mcp` removal: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sync server serves only Logseq users listed in a private secret, `DB_SYNC_ALLOWED_USERS`, failing closed. Upstream's unauthenticated `/mcp` endpoint is removed on both plans.

**Architecture:**
- **Patch `0016`** filters the two identity functions in upstream's `auth.cljs`.
- **Patch `0017`** removes the `/mcp` routes from upstream's `entry.mjs`.
- **A new Node module, `scripts/allowed-users.mjs`,** owns the value's format rule, the known-user check (it reads D1 through Cloudflare's HTTP API) and the local user listing.
- **`deploy.sh`** checks the value, then deploys the code and all three secrets in one `wrangler deploy --secrets-file`.

**Tech stack:**
- ClojureScript: upstream `deps/db-sync`, shadow-cljs `:node-test`.
- Bash.
- Node 22 ESM with `node:test`.
- GitHub Actions.
- wrangler 4.151.1, pinned by upstream.

**Spec:** `docs/superpowers/specs/2026-11-04-user-allow-list-design.md`. Read it first. It is the authority, and this plan argues from it.

## Global constraints

- **Names, exactly:**
  - the secret is `DB_SYNC_ALLOWED_USERS`;
  - the patches are `patches/0016-allowed-users.patch` and `patches/0017-remove-upstream-mcp.patch`;
  - the log events are `:db-sync/user-not-allowed` (warn) and `:db-sync/allowed-users-malformed` (error);
  - the smoke checks are `jwt-garbage-refused` and `upstream-mcp-off`.
- **The value's format:**
  - The literal `none` means nobody.
  - Otherwise it is one or more comma-separated entries. Each entry is trimmed and must match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
  - The whole value is trimmed first.
  - An empty entry (for example `a,,b` or a trailing comma) is malformed.
  - **The Worker (cljs) and `scripts/allowed-users.mjs` apply this rule identically.**
- **Never print a user ID or an email** from anything that runs in GitHub Actions, including error paths. Only `list` / `list-users.sh` print them, and they refuse to run when `GITHUB_ACTIONS=true`. Messages give counts and entry positions, never values.
- **Fail closed everywhere:**
  - The Worker treats a missing, empty, `none` or malformed list as nobody.
  - The deploy stops on a malformed value, on a D1 API error, or when no listed ID is known.
- **Test-only hooks** follow `deploy-connector.sh`'s precedent. They are honoured only with `DEPLOY_SYNC_TEST=1`, and fail fast otherwise.
- **Commits:**
  - short imperative subjects with a prefix (`feat:`, `fix:`, `docs:`, `ci:`);
  - end every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  - never mention an agent name anywhere else in the metadata.
- **Never commit** the hostname, account ID, D1 ID or any real user ID. Tests use made-up UUIDs.

### Working on an upstream patch (Tasks 1 and 2)

`patches/*.patch` are plain `git diff` output, applied in name order by `scripts/fetch-upstream.sh`. Don't use the repo's `.upstream/`, which is stale. To make a patch:

```bash
W="$(mktemp -d)/up"
scripts/fetch-upstream.sh "$W"     # applies every patch currently in patches/
git -C "$W" add -A && git -C "$W" -c user.name=x -c user.email=x commit -qm base
# ...edit and test inside $W/deps/db-sync...
git -C "$W" add -A && git -C "$W" diff --cached base > patches/00NN-name.patch
```

Afterwards, check that every patch applies from scratch with `scripts/fetch-upstream.sh "$(mktemp -d)/check"`.

Run upstream's tests from `$W/deps/db-sync`:

```bash
pnpm install --frozen-lockfile --ignore-workspace
PATH="$HOME/.local/bin:$PATH" pnpm test
```

On `main`'s patches this takes about 35 seconds and the baseline is `Ran 289 tests … 0 failures, 0 errors.`

## Review focus

These are the inputs the spec implies but no headline test exercises. Each one is pinned by a test in the task named.

1. **The secret pasted with a trailing newline or spaces,** for example `"<uuid>\n"` from `gh secret set` reading a file. Both parsers trim it and accept it (Tasks 1 and 3).
2. **An uppercase UUID in the list.** The deploy's format check rejects it, naming the entry's position and saying "lowercase". It never reaches a Worker that would silently refuse the owner (Task 3).
3. **Claims with no string `sub`,** or a PAT row with a nil `user-id`. The result is refused (nil, so a 401), never an exception or a 500 (Task 1).
4. **The D1 API failing** (non-2xx, `success:false`, or a database that isn't found exactly once) during `check-known`. The deploy stops with the HTTP status and Cloudflare's error message. It never passes silently (Tasks 3 and 4).
5. **Nothing leaks in Actions.** The `check-format` and `check-known` output, including every error path, contains none of the fixture IDs or emails. In Actions, `check-format` emits `::add-mask::` for each listed ID before anything else (Task 3).

---

### Task 1: Patch 0016, the allow-list in the sync server, with CI running upstream's tests

**Files:**
- Create: `patches/0016-allowed-users.patch`. Inside upstream it changes:
  - `deps/db-sync/src/logseq/db_sync/worker/auth.cljs`;
  - a new test file, `deps/db-sync/test/logseq/db_sync/worker_allowed_users_test.cljs`;
  - `deps/db-sync/test/logseq/db_sync/test_runner.cljs` (requires the new namespace);
  - whichever existing upstream tests start failing (expected: `worker_auth_test.cljs`, `worker_dispatch_test.cljs`, possibly `node_server_test.cljs`).
- Modify: `.github/workflows/ci.yml`. A new step after **Build**, named `Upstream unit tests`, runs `cd .upstream/deps/db-sync && pnpm test`.

**Interfaces:**
- **Produces, in `logseq.db-sync.worker.auth`:**
  - `(parse-allowed-users raw) -> {:ids #{string} :malformed? boolean}`. `nil`, `""`, whitespace and `none` give `{:ids #{} :malformed? false}`. Any bad entry gives `{:ids #{} :malformed? true}`.
  - `auth-claims` and `semantic-auth-claims` keep their signatures. They now resolve to `nil` for a user who isn't listed.
- **The Worker reads the env key `"DB_SYNC_ALLOWED_USERS"`.**

- [ ] **Step 1: Write the failing tests** in `worker_allowed_users_test.cljs`, with constants `allowed-id "11111111-1111-4111-8111-111111111111"` and `other-id "22222222-2222-4222-8222-222222222222"`:
  - `parse-allowed-users-test`:
    - `"none"`, `""`, `nil` and `"  "` give an empty set and not malformed;
    - `(str allowed-id ", " other-id)` gives both;
    - `(str " " allowed-id "\n")` gives `#{allowed-id}`;
    - `(string/upper-case allowed-id)`, `(str allowed-id ",")`, `(str allowed-id ",," other-id)` and `"bob"` give an empty set and malformed.
  - `auth-claims-filters-by-allowed-users-test`: with `authorization/verify-jwt` redefined to resolve `#js {"sub" <sub> "email" "x@example.com"}`:
    - `allowed-id` with `#js {"DB_SYNC_ALLOWED_USERS" allowed-id}` returns claims whose `sub` is `allowed-id`;
    - `other-id` returns `nil`;
    - `allowed-id` with each of `#js {}`, `#js {"DB_SYNC_ALLOWED_USERS" "none"}` and `#js {"DB_SYNC_ALLOWED_USERS" "not-a-uuid"}` returns `nil`.
  - `auth-claims-unverified-fallback-is-filtered-test`: with `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS "true"` and `verify-jwt` rejecting with a non-recoverable error, an unlisted `sub` returns `nil`.
  - `auth-claims-without-string-sub-is-refused-test`: claims `#js {}` and `#js {"sub" 42}` return `nil` without throwing.
  - `semantic-auth-claims-pat-filtered-test`:
    - redefine `index/<personal-access-token-by-hash` to resolve `{:user-id <id> :permission "read" :expires-at <future> :id "pat-1" :graph-id "graph-1"}`, with `env #js {"DB" #js {} "DB_SYNC_ALLOWED_USERS" allowed-id}`;
    - a token `"logseq_pat_x"` owned by `allowed-id` returns claims;
    - one owned by `other-id` returns `nil`;
    - a nil `:user-id` returns `nil`.
  - `dispatch-refuses-unlisted-users-test`: drive `dispatch/handle-worker-fetch`, with `verify-jwt` redefined to an unlisted `sub`. Use the existing dispatch-test helpers for `DB` and `LOGSEQ_SYNC_DO` stubs. Expect 401 from each of:
    - `GET /sync/graph-1/snapshot/download` (sync access path);
    - `GET /api/v1/graphs` (REST path);
    - the PAT-management list route (find its path in `handler/personal_access_token.cljs`).
  - `dispatch-paths-without-a-user-are-unaffected-test`, with an env that has **no** list:
    - `GET /health` returns 200;
    - a `/sync/...` request carrying a valid `x-db-sync-admin-token` is forwarded (not 401);
    - a correctly signed asset link is served (not 401). Find the signer in `worker/asset_link.cljs`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm test` in `$W/deps/db-sync`. Expected: the new tests fail, because `parse-allowed-users` is undefined, or because claims come back for unlisted users.

- [ ] **Step 3: Implement it in `auth.cljs`:**
  - `parse-allowed-users` follows the global format rule.
  - A private per-isolate cache holds the last raw value and its parse, so a request never re-parses the same string.
  - When a present value is malformed, log `:db-sync/allowed-users-malformed` once per raw value, with `{:entries <count>}` and never the value.
  - A private `(allowed-claims claims env)` returns `claims` when `(aget claims "sub")` is a string in the set. Otherwise it logs `:db-sync/user-not-allowed {:sub <sub> :email <email-or-nil>}` at warn and returns `nil`. A nil `claims` returns `nil` with no log.
  - Apply it to the resolved value of `auth-claims`, covering both the verified and the unverified-fallback results. Rejections propagate unchanged.
  - Apply it to the claims that `semantic-auth-claims` builds in its PAT branch. The non-PAT branch already goes through `auth-claims`.
  - Logging uses `lambdaisland.glogi`, as `dispatch.cljs` does.

- [ ] **Step 4: Fix the existing upstream tests that now fail.**
  - These tests reach the real `auth-claims` or `semantic-auth-claims` with no list, for example `auth-claims-uses-jwt-verification-test` and the PAT dispatch tests.
  - Give their env `"DB_SYNC_ALLOWED_USERS"`. Where a test's `sub` or PAT `user-id` isn't a UUID, change it to a UUID constant shared within that test file.
  - Tests that redefine `auth/auth-claims` itself need no change.
  - Don't weaken any assertion.
  - Re-run until you see `0 failures, 0 errors` with the test count above 289.

- [ ] **Step 5: Write the patch and confirm it applies from scratch.** Use the procedure in Global constraints. All patches must apply in order and the fresh tree's `pnpm test` must pass.

- [ ] **Step 6: Add the CI step.** In `ci.yml`, after `Build`, add:

  ```yaml
  - name: Upstream unit tests
    run: cd .upstream/deps/db-sync && pnpm test
  ```

  Then run `npm test` (the repo's script tests) and confirm it still passes. `deploy-workflow.test.mjs` doesn't cover `ci.yml`.

- [ ] **Step 7: Commit.** Message: `feat: refuse Logseq users missing from DB_SYNC_ALLOWED_USERS`.

### Task 2: Patch 0017, remove upstream `/mcp`; drop the Worker Loader on both plans

**Files:**
- Create: `patches/0017-remove-upstream-mcp.patch`. It changes only `deps/db-sync/worker/entry.mjs`:
  - remove the `/mcp`, `/mcp/icon.png`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` branches;
  - remove `handleMcp`, `protectedResourceMetadata`, `semanticSpec` and the imports only they used.
  - Keep `semantic_api_tools.mjs` and every other upstream file, because `scripts/vendor-upstream-api.sh` copies `semantic_api_tools.mjs` for the connector.
- Modify: `scripts/render-wrangler.mjs`. Delete `cfg.worker_loaders` for both plans. `limits` still differs by plan.
- Modify: `scripts/render-wrangler.test.mjs`.
- Modify: `scripts/smoke-test.sh` and `scripts/smoke-test.test.mjs`. Replace the paid-only `mcp-unauthenticated` check with `upstream-mcp-off` on every run. With nothing left using it, remove `PLAN` from `smoke-test.sh`: its usage text, its validation and the test `rejects an invalid PLAN with exit 2`. Also remove the `PLAN="$plan"` prefix where `scripts/deploy.sh` calls it.
- Modify: `README.md` section 8, as spec D11 says.

**Interfaces:** none consumed. Produces the smoke check `upstream-mcp-off`, which Task 4's smoke edits sit beside.

- [ ] **Step 1: Write the failing tests:**
  - In `render-wrangler.test.mjs`, rename `paid plan keeps limits and worker_loaders` to `paid plan keeps limits and drops worker_loaders`. Assert `out.limits.cpu_ms === 300000` and `out.worker_loaders === undefined`.
  - In `smoke-test.test.mjs`, replace `paid plan checks /mcp is 401` with `checks upstream /mcp is gone`. The stub answers `POST /mcp` with 404, and the output contains `ok upstream-mcp-off`.
  - Add `fails when upstream /mcp still answers`: the stub answers 200, the exit is non-zero, and the output contains `FAIL upstream-mcp-off: 200`.

- [ ] **Step 2: Run `npm test`.** Expected: those three tests fail.

- [ ] **Step 3: Implement the render and smoke changes.** The smoke check is `expect_status upstream-mcp-off 404 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$base/mcp"`.

- [ ] **Step 4: Make patch 0017** (procedure in Global constraints).
  - Confirm `node --check deps/db-sync/worker/entry.mjs` passes.
  - Confirm the build is clean: `pnpm release && pnpm build:api-docs`.
  - Confirm `node --test worker/entry_test.mjs` still passes (it imports helpers, not `entry.mjs`).
  - Don't run or edit `mcp_transport_test.mjs`. It tests the removed endpoint and nothing here runs it. Record that in the commit body.

- [ ] **Step 5: Rewrite README section 8 as "Switching to the paid plan".**
  - The plan now only raises `[limits] cpu_ms`.
  - Upstream's `/mcp` is off on both plans, because anyone could call it without a token and the connector (section 11) replaces it.
  - Keep the switch steps.
  - Replace the smoke-check sentence with `upstream-mcp-off`, which runs on both plans.
  - Update the Contents link text.

- [ ] **Step 6: Run `npm test`** and the from-scratch patch check. Both must pass.

- [ ] **Step 7: Commit.** Message: `feat: remove upstream's unauthenticated /mcp endpoint`.

### Task 3: `scripts/allowed-users.mjs`, the format rule, the known-user check and the listing

**Files:**
- Create: `scripts/allowed-users.mjs`, as an ESM module and a CLI (`if (import.meta.url === pathToFileURL(process.argv[1]).href) main()`).
- Create: `scripts/allowed-users.test.mjs`.

**Interfaces (produced, used by Tasks 4 and 5):**
- `export function parseAllowedUsers(raw: string | undefined): { ok: true, ids: string[] } | { ok: false, error: string }`
  - `none` gives `{ ok: true, ids: [] }`.
  - Missing or empty is **not ok**, unlike the Worker: the deploy must not ship a forgotten secret. The error is `DB_SYNC_ALLOWED_USERS is empty or missing: set it to your Logseq user ID(s), or none (README section 9)`.
  - A bad entry gives `DB_SYNC_ALLOWED_USERS entry <i> of <n> is not a lowercase UUID`. When the entry is a UUID apart from its case, append `(use lowercase)`. Never include the value.
- `export function compareWithKnownUsers(ids: string[], users: {id: string, graphs: number}[]): { error: string | null, warnings: string[] }`
  - `users` non-empty and no listed ID among them gives the error `none of the <n> listed user IDs is a known user of this server (<m> known); check DB_SYNC_ALLOWED_USERS. Nothing was deployed`. With `ids` empty (`none`), `<n>` is 0.
  - `users` empty and `ids` empty gives the warning `no users have signed in yet, and every user will be refused until DB_SYNC_ALLOWED_USERS lists one (README section 9)`.
  - Listed IDs not in `users` give the warning `<k> of <n> listed user IDs haven't signed in to this server yet`.
  - Users with `graphs > 0` who aren't listed give the warning `<k> users who own graphs aren't on the list and will be refused`.
- `export async function fetchUsers({ accountId, apiToken, databaseName, apiBase = "https://api.cloudflare.com/client/v4", fetchImpl = fetch }): Promise<{id: string, email: string|null, username: string|null, graphs: number}[]>`
  - It calls `GET {apiBase}/accounts/{accountId}/d1/database?name={databaseName}` and keeps the `result` entries whose `name` equals `databaseName` exactly. Anything other than exactly one is an error.
  - Then it calls `POST {apiBase}/accounts/{accountId}/d1/database/{uuid}/query` with `{"sql": "SELECT u.id AS id, u.email AS email, u.username AS username, (SELECT count(*) FROM graphs g WHERE g.user_id = u.id) AS graphs FROM users u ORDER BY u.id"}` and returns `result[0].results`.
  - A non-2xx response or `success: false` throws `D1 API <status>: <errors[].message joined>`, never response rows.
  - Both requests send `Authorization: Bearer <apiToken>`.
- **CLI:** `node scripts/allowed-users.mjs <check-format|check-known|list> [--database <name>]`. It reads `DB_SYNC_ALLOWED_USERS`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment. `CLOUDFLARE_API_BASE` optionally overrides `apiBase`, which is how the tests point it at a local stub server.
  - **`check-format`:**
    - Exits 1 with the parse error on stderr.
    - When `GITHUB_ACTIONS=true`, first prints `::add-mask::<id>` to stdout for each parsed ID.
    - On success prints `DB_SYNC_ALLOWED_USERS: <n> user(s)`, or `DB_SYNC_ALLOWED_USERS: none (every user is refused)`.
  - **`check-known`:**
    - Parses (exits 1 on error), fetches and compares.
    - Prints each warning as `warning: <text>`, or as `::warning::<text>` when `GITHUB_ACTIONS=true`.
    - Exits 1 with `error: <text>` (or `::error::<text>`) on an error or a fetch failure.
    - Otherwise prints `allowed users: <n> listed, <k> known`.
  - **`list`:**
    - Exits 1 with `list prints user IDs and emails, so it never runs in GitHub Actions` when `GITHUB_ACTIONS=true`, before touching the network.
    - Prints one row per user: `id`, `email`, `username`, `graphs`, and `listed` (`yes` or `no`) against `DB_SYNC_ALLOWED_USERS`, as fixed-width columns with a header.
    - If the variable is missing or malformed, every row shows `no` and one note line says why.

- [ ] **Step 1: Write the failing tests** in `allowed-users.test.mjs`. Use made-up UUIDs `A = "11111111-1111-4111-8111-111111111111"`, `B = "22222222-2222-4222-8222-222222222222"` and `C = "33333333-3333-4333-8333-333333333333"`, and a fixture email `owner@example.com`.
  - `parseAllowedUsers`:
    - `"none"` gives no IDs;
    - `` `${A}, ${B}` `` gives both;
    - `` ` ${A}\n` `` gives `[A]`;
    - `""` and `undefined` give the empty-or-missing error;
    - `A.toUpperCase()` gives an error matching `/entry 1 of 1 .*use lowercase/` and not containing `A.toUpperCase()`;
    - `` `${A},` `` and `` `${A},,${B}` `` and `"bob"` are errors.
  - `compareWithKnownUsers`:
    - `([A], [{id:A,graphs:1}])` gives no error and no warnings;
    - `([B], [{id:A,graphs:1}])` gives an error that also produces the owner warning;
    - `([], [{id:A,graphs:0}])` gives an error;
    - `([], [])` gives no error and the "no users have signed in yet" warning;
    - `([A,C], [{id:A,graphs:1}])` gives the warning `1 of 2 listed user IDs haven't signed in to this server yet`;
    - `([A], [{id:A,graphs:1},{id:B,graphs:2}])` gives the warning `1 users who own graphs aren't on the list and will be refused`.
  - `fetchUsers` against an injected `fetchImpl`:
    - it picks the exact name match among `logseq-sync-index` and `logseq-sync-index-old`;
    - zero or two exact matches throw;
    - a 403 with `{"success":false,"errors":[{"message":"Authentication error"}]}` throws `D1 API 403: Authentication error`;
    - it returns the rows.
  - **CLI, by spawning `node scripts/allowed-users.mjs` against a local `node:http` stub server** set as `CLOUDFLARE_API_BASE`, whose rows contain A and B with `owner@example.com`:
    - `check-format` with `GITHUB_ACTIONS=true` prints `::add-mask::A` before the summary;
    - `check-known` with list `B` and rows `[A]` exits 1;
    - `check-known` with the stub returning 500 exits 1;
    - **in every `check-*` run, neither stdout nor stderr contains `A`, `B` or `owner@example.com`, apart from the `::add-mask::` lines;**
    - `list` with `GITHUB_ACTIONS=true` exits 1 and the stub records zero requests;
    - `list` locally prints both rows, with `listed` `yes` for the listed one.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail (module not found).

- [ ] **Step 3: Implement `scripts/allowed-users.mjs`** to the interfaces above. Use global `fetch`, and no new dependencies.

- [ ] **Step 4: Run `npm test`.** Expected: all pass.

- [ ] **Step 5: Commit.** Message: `feat: check DB_SYNC_ALLOWED_USERS against the server's users`.

### Task 4: `deploy.sh` and `deploy.yml`: check, then deploy code and secrets together; smoke-test additions

**Files:**
- Modify: `scripts/deploy.sh`.
- Create: `scripts/deploy.test.mjs`.
- Modify: `.github/workflows/deploy.yml`, adding `DB_SYNC_ALLOWED_USERS: ${{ secrets.DB_SYNC_ALLOWED_USERS }}` to the **Deploy** step's `env` only.
- Modify: `scripts/deploy-workflow.test.mjs`.
- Modify: `scripts/smoke-test.sh` and `scripts/smoke-test.test.mjs`.

**Interfaces:**
- **Consumes:** the Task 3 CLI (`check-format`; `check-known --database <name>`).
- **Test-only env, honoured only with `DEPLOY_SYNC_TEST=1`** (otherwise exit 1 naming the variable, as `deploy-connector.sh` does):
  - `DEPLOY_SYNC_UPSTREAM`: the upstream checkout dir, instead of `.upstream`. It must hold `deps/db-sync/worker/wrangler.toml` and `deps/db-sync/node_modules/.bin/wrangler`.
  - `DEPLOY_SYNC_SKIP_SMOKE=1`.

**The new order in `deploy.sh`:**
1. The required-env check. `DB_SYNC_ALLOWED_USERS` is added to the header comment but **not** to the `:?` list, so `check-format` gives the clear message.
2. `node scripts/allowed-users.mjs check-format`. This runs before `tofu` and before any wrangler call.
3. `tofu output`, the D1 mask, and the render, unchanged.
4. `wrangler d1 migrations apply`.
5. `node scripts/allowed-users.mjs check-known --database "$d1_name"`. It runs after migrations, so a first-ever deploy has a `users` table.
6. Write the `umask 077` temp secrets file with `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` and `DB_SYNC_ALLOWED_USERS` (trimmed), then run `wrangler deploy --secrets-file "$secrets_file"`. The `wrangler secret bulk` call is removed.
7. Run the smoke test, unless skipped.

- [ ] **Step 1: Write the failing tests:**
  - **`deploy.test.mjs`.** It builds a temp upstream dir (copy `scripts/fixtures/upstream-wrangler.toml` to `deps/db-sync/worker/wrangler.toml`). It adds a stub `wrangler` that appends its argv to a log and, on `deploy`, copies the `--secrets-file` contents next to the log. It puts a stub `tofu` first on `PATH` that prints `{"d1_database_id":{"value":"00000000-0000-0000-0000-000000000000"}}`. It sets `CLOUDFLARE_API_BASE` to a local stub server, sets `DEPLOY_SYNC_TEST=1` and `DEPLOY_SYNC_SKIP_SMOKE=1`, and gives dummy values for the other required env. Tests:
    - `refuses a malformed list before any wrangler or tofu call`: the value `not-a-uuid` exits non-zero, and the wrangler log doesn't exist.
    - `refuses an empty list`: the value `""` behaves the same way.
    - `deploys code and all three secrets together`: with a valid list known to the stub, the wrangler log is exactly `d1 migrations apply logseq-sync-index --remote` then `deploy --secrets-file <path>`. The captured secrets JSON has exactly the keys `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` and `DB_SYNC_ALLOWED_USERS`, and no `secret bulk` appears.
    - `stops after migrations when no listed user is known`: the log has the migrations line and no `deploy`.
    - `test hooks need DEPLOY_SYNC_TEST`: `DEPLOY_SYNC_UPSTREAM` without `DEPLOY_SYNC_TEST=1` exits non-zero.
  - **`deploy-workflow.test.mjs`:** the `Deploy` step's env maps `DB_SYNC_ALLOWED_USERS` to `${{ secrets.DB_SYNC_ALLOWED_USERS }}`, and no other step's env mentions it.
  - **`smoke-test.test.mjs`:**
    - `refuses a garbage bearer token`: the stub answers `GET /api/v1/graphs` carrying `Authorization: Bearer not-a-jwt` with 401, and the output has `ok jwt-garbage-refused`;
    - the same with 200 gives `FAIL jwt-garbage-refused: 200`;
    - `notes when SMOKE_PAT is unset`: the output contains `note: SMOKE_PAT is not set, so the allow-list was not checked end to end`, with exit 0.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail.

- [ ] **Step 3: Implement the `deploy.sh` order** and the hooks. Write the secrets file with `node`, reading values from `process.env`, as today.

- [ ] **Step 4: Implement the smoke-test additions.** The check is `jwt-garbage-refused`: `expect_status jwt-garbage-refused 401 -H 'Authorization: Bearer not-a-jwt' "$base/api/v1/graphs"`. The note goes in the `SMOKE_PAT`-unset branch.
  - **Use exactly `not-a-jwt`.** A three-part garbage token such as `aaa.bbb.ccc` makes upstream's JWT decoder throw a 500 today, which is outside this plan.

- [ ] **Step 5: Add the env line to `deploy.yml`.** Then run `npm test` and `mise exec actionlint -- actionlint`. Expected: both pass.

- [ ] **Step 6: Commit.** Message: `feat: deploy DB_SYNC_ALLOWED_USERS with the code, after checking it`.

### Task 5: Secrets tooling: `init-env.sh`, `.env.local.example`, `list-users.sh`

**Files:**
- Modify: `scripts/init-env.sh` and `scripts/init-env.test.mjs`.
- Modify: `.env.local.example`. After the `SYNC_HOSTNAME=` block, add a comment and the line `DB_SYNC_ALLOWED_USERS=none`. The comment says:
  - this is the Logseq user IDs allowed to use the server, comma-separated, or `none`;
  - find yours with `scripts/list-users.sh` (README section 9);
  - `none` refuses everyone.
- Create: `scripts/list-users.sh` (mode 755).
- Create: `scripts/list-users.test.mjs`.

**Interfaces:**
- **Consumes:** the Task 3 CLI (`check-format`, `list --database`).
- **`list-users.sh`, with no arguments:**
  1. Exits 1 with the same message as `list` when `GITHUB_ACTIONS=true`, before anything else.
  2. Sources `$repo_root/.env.local` with `set -a` when it exists.
  3. Reads `d1DatabaseName` from `config/settings.json`.
  4. Execs `node scripts/allowed-users.mjs list --database <name>`.

**`init-env.sh` behaviour:**
- **A fresh run** writes `DB_SYNC_ALLOWED_USERS=none` (the template already carries `none`, so the awk fill leaves it as is). With `--push`, it pushes it as the seventh secret. The closing summary and the `Next:` list gain a line: run `scripts/list-users.sh` after your first sign-in, then set your ID (README section 9).
- **`--add-missing`:**
  - `DB_SYNC_ALLOWED_USERS` joins the checked names, and is never generated.
  - When it's absent, the script takes it from the environment, or prompts: `Logseq user ID(s), comma-separated, or none (find yours with scripts/list-users.sh): `.
  - Without a terminal, it's listed in the `export …` error with the other unset inputs.
  - It validates the value with `DB_SYNC_ALLOWED_USERS="$value" node scripts/allowed-users.mjs check-format`. The value goes through the environment, never argv. On failure it prints that command's stderr and exits 1, having written and pushed nothing.
  - It is pushed under the same name.

- [ ] **Step 1: Write the failing tests:**
  - **`init-env.test.mjs`, following the file's existing patterns:**
    - a fresh run's `.env.local` contains `DB_SYNC_ALLOWED_USERS=none`;
    - a fresh `--push` run calls `gh secret set DB_SYNC_ALLOWED_USERS` (seven pushes);
    - `--add-missing` with `DB_SYNC_ALLOWED_USERS=<A>` in the env appends it;
    - `--add-missing` with `DB_SYNC_ALLOWED_USERS=bob` exits 1, leaves `.env.local` byte-identical and pushes nothing;
    - `--add-missing` with no terminal and the name unset lists `DB_SYNC_ALLOWED_USERS` in the error;
    - an `.env.local` that already has the name is left alone.
  - **`list-users.test.mjs`:**
    - with `GITHUB_ACTIONS=true`, exit 1, the refusal message, and no `.env.local` read (point `HOME` and the repo at a temp copy if needed, or assert that the stub server got no request);
    - locally, with `CLOUDFLARE_API_BASE` on a stub server, it prints the table.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests fail.

- [ ] **Step 3: Implement the `init-env.sh` changes, the template line and `list-users.sh`.**

- [ ] **Step 4: Run `npm test` and `shellcheck scripts/init-env.sh scripts/list-users.sh`** (if shellcheck is installed; otherwise note that in the report). Expected: pass.

- [ ] **Step 5: Commit.** Message: `feat: add DB_SYNC_ALLOWED_USERS to init-env and a local user listing`.

### Task 6: README

**Files:**
- Modify: `README.md`. Section 8 is already done in Task 2.

**The content, from spec sections D6, D10 and "README":**
- **1.4 table:**
  - add a `DB_SYNC_ALLOWED_USERS` row: "Logseq user IDs allowed to use the server, or `none`. Written as `none`; set your ID after your first sign-in (section 9)."
  - add the name to the snippet if the snippet lists names.
- **1.8:** add a table row (required: Yes), and add the name to the `names=` loop line.
- **Section 2's step list:** replace "sets `ASSET_LINK_SECRET` and `DB_SYNC_ADMIN_TOKEN` with `wrangler secret bulk`" with these steps:
  - checks `DB_SYNC_ALLOWED_USERS`;
  - applies migrations;
  - checks the list against known users;
  - deploys the code and the three secrets together.
- **Section 9:**
  - Replace the bullet "Any Logseq account can use your server …" with one pointing at the new subsection.
  - Add the subsection **"Who can use your server"** (`### 9.1`, or the README's existing heading style for subsections there), covering:
    - what the list does, and that it fails closed;
    - **finding your ID** three ways: `scripts/list-users.sh`; the Cloudflare dashboard D1 console with `SELECT id, email FROM users` on the sync database; and, on a fresh install, the refused sign-in's `db-sync/user-not-allowed` line in Workers Logs or `wrangler tail`;
    - adding someone: append their ID, update `.env.local` and the `production` secret, redeploy. If they haven't signed in yet, the deploy warns, which is expected;
    - removing someone takes effect on the next deploy;
    - **the existing-install rollout steps from D10, verbatim in substance.** Stress that the secret must be in `production` *before* merging the PR, or the deploy stops at the format check (safely, with nothing deployed);
    - the optional cleanup: `DELETE /admin/graphs/<graph-id>` with `x-db-sync-admin-token`;
    - recovery: fix the secret and redeploy, or `wrangler rollback`.
  - Rotation table: add a row. `DB_SYNC_ALLOWED_USERS` isn't a credential; change it in `.env.local` and `production`, then redeploy.
- **Section 10 troubleshooting rows:**
  - "Everything returns 401 after a deploy": check `DB_SYNC_ALLOWED_USERS` and the `db-sync/user-not-allowed` log.
  - "Deploy fails: none of the listed user IDs is a known user": a typo, or the wrong account. Run `scripts/list-users.sh`.
  - "Deploy fails: DB_SYNC_ALLOWED_USERS is empty or missing": push the secret (1.8).
- **Backlog:** delete item 2 and renumber.
- **Contents:** add the new subsection link if section 9 lists subsections.

- [ ] **Step 1: Make the edits.** Keep the README's voice: short sentences, second person, no IDs or real hostnames (`sync.example.com`).
- [ ] **Step 2: Check with `grep -n "allow-list\|wrangler secret bulk\|mcp-unauthenticated" README.md`.** Only intended mentions may remain: no stale "on the backlog" text, no `secret bulk`, no `mcp-unauthenticated`.
- [ ] **Step 3: Commit.** Message: `docs: explain the user allow-list and its rollout`.
