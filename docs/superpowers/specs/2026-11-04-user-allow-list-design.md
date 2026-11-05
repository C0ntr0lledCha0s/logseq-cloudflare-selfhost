# User allow-list for the sync server: design

**Status:** design, awaiting approval
**Repo:** `logseq-cloudflare-selfhost`
**Upstream:** `logseq/logseq` at `UPSTREAM_REF` (currently `e7e9c97c7f`), `deps/db-sync`

The owner skipped the brainstorming questions, so every decision below is the designer's call unless it is marked as the owner's.

## Intent

The self-hosted sync server (`logseq-sync`) accepts **anyone with a Logseq account**. Logseq's sign-in service (Cognito) proves who someone is, but the server never checks *whether* that person should use it.

A stranger who finds the hostname can sign in with their own free Logseq account and then:

- create graphs;
- upload assets;
- create personal access tokens (PATs);
- use the REST API.

The hostname isn't secret: every HTTPS certificate is published in Certificate Transparency logs.

Strangers can't read the owner's graphs, because per-graph access checks stop them. What they can do:

- spend the account's Workers Free plan allowances (requests, Durable Object time, D1 and R2), which could throttle the owner's own sync;
- on the paid plan, run up the owner's bill.

Separately, upstream's own MCP endpoint (`POST /mcp`) answers **anyone, with no token at all**, on both plans. It loads the API spec and builds an MCP server for every request before any identity check: an unauthenticated `tools/list` against the live Free-plan server returned 200 on 2026-11-05. On the paid plan, its code-mode `execute` tool also runs sandboxed code in a Worker Loader. The allow-list can't cover this, because no identity is involved. The connector already does this endpoint's job for the owner, so D11 turns the endpoint off.

The fix is an allow-list of Logseq user IDs: every signed-in request must belong to a listed user. The connector already works this way for GitHub sign-in (only `OWNER_GITHUB_USER_ID`). This brings the sync server to the same standard.

## Goals

1. **Only listed Logseq users get in.** Every request authenticated by a Logseq sign-in token (JWT) or a PAT is accepted only if the token's user is on the list. That covers sync, WebSockets, assets, E2EE keys, PAT management, the REST API and the graph index routes.
2. **Fail closed.** If the list is missing, empty, malformed or set to `none`, the server refuses every user. It never lets everyone in.
3. **The list stays private.** It never appears in the public repo or in Actions logs. It's held like the other identifiers: `.env.local` locally, a secret in the GitHub `production` environment, and a Worker secret on Cloudflare.
4. **Finding your ID is easy,** for the existing install and for a fresh fork.
5. **The rollout can't lock the owner out.** That covers a deploy with a missing list, a mistyped list, and the moment the new code goes live (D4, D5). One case is only partly covered: a list naming a different known account (D4).
6. **Upstream's `/mcp` endpoint is off on both plans** (D11, the owner's decision).

## Non-goals

- **Deleting what strangers already created.** The tooling shows who has used the server. Cleanup stays a manual, documented option.
- **Per-graph or per-route permissions.** Graph membership and PAT scopes already handle that.
- **An admin UI or API for editing the list.** The list changes by updating a secret and redeploying.
- **Upstream's Node server** (`deps/db-sync/src/logseq/db_sync/node/`). It shares `auth.cljs`, so the patch must not break its build, but it isn't deployed or tested here.
- **Rate limiting or abuse detection.**

## Anti-goals

These would make the feature a failure even if it technically worked:

- **The owner's own sync or the connector stops working** after the rollout.
- **Any route still accepts a signed-in user who isn't on the list,** including WebSocket upgrades and the REST API.
- **A misconfiguration lets everyone in.**
- **A user ID or email appears in the public repo or a public Actions log.**
- **The check adds a second JWT verification** or other per-request CPU cost that matters on the Free plan's 10 ms limit.
- **A big patch** that fights every upstream bump.

## Constraints

- **Cognito user IDs (`sub`) are UUIDs.** A PAT carries the user ID of the account that created it (`personal_access_tokens.user_id`), so one check covers both kinds of token.
- **No other identity path.** At `UPSTREAM_REF`, every identity decision goes through two functions in `deps/db-sync/src/logseq/db_sync/worker/auth.cljs`:
  - **`auth-claims`** verifies the JWT, or returns unverified claims when `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS` is on.
  - **`semantic-auth-claims`** looks up a PAT, or falls back to `auth-claims`.

  The other uses of `unsafe-jwt-claims` only touch activity tracking and presence, after access has already been granted. The builder must re-confirm this at the current ref.
- **Some requests carry no user and must stay unaffected:**
  - `/health` and `/openapi.json`;
  - requests with the admin token (`x-db-sync-admin-token`, used by `backup.yml`);
  - signed asset links;
  - CORS `OPTIONS` requests.
- **The connector reaches the sync server with the owner's PATs,** over a service binding. It must keep working unchanged.
- **Everything uses existing patterns:**
  - a build-time patch in `patches/`, like `0001-pat-gate-allow-authenticated-users.patch`;
  - deploy steps in `scripts/deploy.sh`;
  - secrets through `scripts/init-env.sh` and the `production` environment;
  - Actions hardening as in `deploy.yml`.
- **Owner identifiers stay private.** They never go in the repo or a public Actions log, as the repo already requires for the domain, account ID and D1 IDs.

## Decisions

Each of these is the designer's call.

### D1. Enforce inside the sync server, at the two identity functions

A new patch, `patches/0016-allowed-users.patch`, changes `auth.cljs`:

- After `auth-claims` has produced claims (verified, or unverified when that flag is on), it returns `nil` unless the claims' `sub` is on the list.
- `semantic-auth-claims` does the same for the PAT branch, checking the PAT's `user-id`.

Every caller already treats `nil` as "not authenticated", so all routes are covered without touching them. The check is a set lookup after the existing verification, so it adds no CPU worth counting.

The allowed set is parsed from the environment once per isolate, or cached by its raw string. It is never re-parsed per request in a way that costs CPU.

Rejected alternatives:
- **A front Worker or gateway.** It would need its own JWT verification (a second verify, extra CPU) and a separate deploy.
- **A gate in `dispatch.cljs`.** It would need to resolve identity itself, which duplicates the verification.

### D2. Refused users get the same `401 unauthorized` as a bad token

This keeps the patch small, doesn't change any caller, and tells a stranger nothing.

To make it diagnosable, each refusal logs one warning (`db-sync/user-not-allowed`) with the refused user's `sub` and, when the claims carry it, `email`. This goes to the Worker's private logs (Workers Logs, `wrangler tail`), never to Actions. It's also how a fresh install finds its owner's ID (D6).

### D3. The list is a Worker secret, `DB_SYNC_ALLOWED_USERS`

- **Format:** comma-separated Cognito user IDs (lowercase UUIDs). Whitespace around entries is ignored.
- **`none`:** an explicit "nobody", used to bootstrap a fresh install.
- **Same name everywhere:** in `.env.local`, as a secret in the GitHub `production` environment, and as a Worker secret.
- **Fail closed at runtime:** the Worker treats `none`, empty, missing or any malformed entry as an empty list, and logs an error when the value is present but malformed.

### D4. `deploy.sh` checks the value before deploying anything

**Format check.** The deploy fails, before any `wrangler` call, unless `DB_SYNC_ALLOWED_USERS` is `none` or a valid comma-separated list of UUIDs. In Actions, a missing secret arrives as an empty string, so a forgotten secret stops the deploy and never ships a server that refuses the owner.

**Known-user check.** This catches a well-formed list that's wrong, such as a mistyped UUID.
1. Before deploying, `deploy.sh` reads the user IDs from the sync server's D1 `users` table.
2. If the table has any users and **none** of the listed IDs is among them, the deploy fails before anything is deployed.
   - A typo in a one-person list is caught this way.
   - So is `none` on an install that already has users.
3. If some listed IDs aren't in the table yet, for example someone being added who hasn't signed in, it only warns.
4. It also warns when users who own graphs aren't on the list.
5. It prints **counts only, never an ID or email.** It compares the IDs locally (in `node`), not inside SQL that wrangler might echo.

A fresh install, whose `users` table is empty, passes with `none` and gets a printed warning that every user will be refused.

**What still gets through, the designer's call:**
- A list that names a *different* known account, such as the owner's second Logseq account instead of the main one, passes these checks.
- The smoke test's `pat-graphs` check (D8) catches that after the switch-over when `SMOKE_PAT` is set.
- There is **no automatic rollback**. Recovery is to fix the secret and redeploy, or `wrangler rollback`; the README documents both. Automatic rollback was rejected: a smoke failure can have other causes, such as a certificate still being issued, and rolling back would add a second, untested path through the deploy.

### D5. No moment where the new code runs without the list

On an existing install, the Worker must never serve requests with the new code and no `DB_SYNC_ALLOWED_USERS`. A 401 storm could sign the owner's Logseq clients out. Today `deploy.sh` runs `wrangler deploy` *then* `wrangler secret bulk`; that order has to change for this secret.

**Settled at planning (2026-11-05):** `deploy.sh` runs `wrangler deploy --secrets-file <file>` with all three of its secrets (`ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN`, `DB_SYNC_ALLOWED_USERS`), and the separate `wrangler secret bulk` step goes. The pinned wrangler's (4.151.1) help confirms the file is additive: secrets left out of it are kept, not deleted. Code and secrets arrive as one version, so a first-ever deploy works the same way.

### D6. Finding your user ID: `scripts/list-users.sh`

A new local-only script lists every user in the sync server's D1 `users` table:
- the user ID, email and username;
- how many graphs they own;
- whether they're on the current `DB_SYNC_ALLOWED_USERS` (read from the environment).

It also serves as the audit of who has already used the server.

Because it prints identifiers and emails, it refuses to run when `GITHUB_ACTIONS=true`. It is never called from a workflow.

- **An existing install** has the owner's row already (the server stores users on first sign-in), so the owner copies their ID from this list.
- **Without the script:** the Cloudflare dashboard's D1 console (Storage & Databases → D1 → the sync database → Console) runs `SELECT id, email FROM users`, from any browser. The README gives this as the no-install route.
- **A fresh install** deploys with `none`. The owner signs in once from Logseq, gets refused, and reads their ID from the `db-sync/user-not-allowed` log line (`wrangler tail` or Workers Logs). Then they set the list and redeploy. The README documents both paths.

### D7. Secrets tooling

- **`.env.local.example`** gains `DB_SYNC_ALLOWED_USERS=none` with a comment.
- **A fresh `scripts/init-env.sh`** writes `none`, and with `--push` sets it in the `production` environment alongside the other required secrets. It becomes required: seven instead of six.
- **`--add-missing`** prompts for it when it's absent from `.env.local`, accepting `none` or a list. It validates the value with the same rule as `deploy.sh`, and suggests running `scripts/list-users.sh` first.
- **`deploy.yml`** passes the secret to the **Deploy** step only.
- **The README's secrets table and the 1.8 push loop** include it.

### D8. Smoke test

- **`scripts/smoke-test.sh`** already checks, with `SMOKE_PAT`, that a PAT can list graphs (`pat-graphs`). With the allow-list in place, that check also proves the owner is still allowed, so keep it.
- **Without `SMOKE_PAT`,** print a note that the allow-list wasn't checked end to end. Don't fail on it.
- **New check `jwt-garbage-refused`:** a request with a non-PAT bearer token that isn't a valid JWT must be refused, so the smoke test proves authenticated routes still reject bad tokens.

### D9. Tests

**In the patch, in upstream's style:** cljs tests next to upstream's db-sync worker tests, covering:
- a JWT for an allowed user is accepted, and one for an unlisted user is refused, on at least the sync access path, the REST API path and the PAT-management path;
- a PAT owned by an allowed user is accepted, and one owned by an unlisted user is refused;
- `none`, an empty value, an unset value and a malformed value each refuse everyone;
- the admin token, signed asset links and `/health` are unaffected.

**The patch may edit upstream's existing tests,** as `0001` already does. Failing closed breaks upstream tests that call the real `auth-claims` or `semantic-auth-claims` with an env that has no list. Examples:
- `worker_auth_test.cljs`: `auth-claims-uses-jwt-verification-test` and the unverified-claims fallback test;
- `worker_dispatch_test.cljs`: the PAT permission and PAT-management tests.

Those tests get `DB_SYNC_ALLOWED_USERS` added to their env. To keep the patch small, add it through a shared test helper or fixture where one exists, rather than editing every call site.

**CI must run these tests (settled at planning, 2026-11-05):** CI runs upstream's **full** db-sync suite (`pnpm test` in `deps/db-sync`) with all patches applied, after the build. With `0001`–`0015` it passes today (289 tests, 0 failures, about 33 seconds), and upstream's runner has no namespace filter, so the full suite is both simpler and cheaper than a focused one.

**Script tests (`node:test`, `npm test`) cover:**
- the `deploy.sh` value check;
- the order of secret-setting and deploying;
- `init-env.sh`'s new name in both modes;
- `list-users.sh` refusing to run in Actions;
- the smoke-test changes.

### D10. Rollout for the existing install

The PR description and README give the owner these steps, in order:

1. Run `scripts/list-users.sh` locally and find your own row. Note any other users: those are strangers, or your own second account.
2. Add your ID (and any other account you use, such as a second Logseq login) to `.env.local` as `DB_SYNC_ALLOWED_USERS`.
3. Run `scripts/init-env.sh --add-missing --push`, or push it with the 1.8 loop.
4. Merge. The deploy checks the value (D4), sets it without a gap (D5), and the smoke test's `pat-graphs` confirms you still get in.
5. Optional: remove strangers' graphs with the admin delete route (`DELETE /admin/graphs/<graph-id>` with `x-db-sync-admin-token`). The README documents this as a manual step, and nothing does it automatically.

### D11. Turn off upstream's `/mcp` endpoint, on both plans (owner's decision)

The owner decided this on 2026-11-05. The connector replaces this endpoint. What upstream's endpoint has that the connector doesn't:
- code mode (`search` and `execute`);
- the E2EE helper operations;
- `upload_asset` for ChatGPT attachments;
- an MCP App image viewer.

The owner accepts losing these. The connector already returns images to Claude as image content through `read_file`.

- **A small patch, `patches/0017-remove-upstream-mcp.patch`, to `deps/db-sync/worker/entry.mjs`,** kept separate from the auth patch, removes the routes `/mcp`, `/mcp/icon.png`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
  - Those paths then fall through to the sync worker, which must answer them with its normal not-found response and no MCP work. The builder confirms the status code.
  - Everything else in `entry.mjs` stays as upstream has it.
- **`render-wrangler.mjs` drops `worker_loaders` on both plans.** The paid plan then differs from Free only in `[limits]`. Nothing else may bind `LOADER`.
- **The smoke test checks this on both plans.** Replace the paid-only `mcp-unauthenticated` check with `upstream-mcp-off`: `POST /mcp` with a `tools/list` body returns the not-found status.
- **The connector is unaffected.** It calls `/api/v1/...` over the service binding, never `/mcp`. The builder confirms this.
- **Tests:** a `node:test` check that rendering for either plan has no `worker_loaders`, and the smoke-test check above. The `entry.mjs` change is small enough that the smoke test is its test. Upstream's `entry_test.mjs` cases for `/mcp` may be removed or changed by the patch.
- **README section 8** becomes "Switching to the paid plan". It drops the MCP text and says why upstream's `/mcp` is off: anyone could call it, and the connector replaces it.

## README

Add a new subsection under **9. Security notes**, called "Who can use your server":
- what the list does;
- how to find your ID (both paths in D6);
- how to add someone;
- that removing someone takes effect on the next deploy;
- the fresh-install `none` bootstrap.

Also update:
- the secrets tables (1.4, 1.8);
- **Troubleshooting:** add a row for "everything returns 401 after a deploy". Check `DB_SYNC_ALLOWED_USERS` and the `db-sync/user-not-allowed` log;
- **Backlog:** remove item 2.
- **Section 8:** as in D11.

## Left to the builder

- **Where the check sits in `auth.cljs`:** inside the two functions or in a small helper they share, and how the parsed set is cached.
- **The exact log fields and level,** within D2.
- **The D5 mechanism.**
- **How CI runs the patch's tests** (D9).
- **The exact not-found status for the removed `/mcp` routes** (D11).
- **How `list-users.sh` queries D1:** `wrangler d1 execute --remote --json` or the D1 HTTP API. It must not print anything when run in Actions.
- **Wording of messages and README text,** following the repo's existing style.

## Open questions for the owner

None blocking. D11 (turn off upstream's `/mcp` on both plans) is the owner's answer to the one question the builder check raised. The design assumes the list is just the owner's own Logseq account (or accounts). It supports more people, but adding them is a manual secret change, with no invite flow.
