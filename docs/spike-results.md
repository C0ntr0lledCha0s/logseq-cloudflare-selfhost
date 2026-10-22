# Phase-0 spike results

Run on the owner's Cloudflare account, Workers Free plan, on 2026-10-22, against upstream `69da7e2215b336cc5123dafb2a1686996e39596c`.

## Bootstrap

- **One account-owned API token** covers everything, and needs **two policies**:
  - **Account resources** (the account): Workers Admin, D1 Write (+Read), Workers R2 Storage Write (+Read).
  - **Zone resources** (`example.com`): Workers Routes Write (+Read), DNS Write (+Read).

  A single policy scoped only to the zone gives D1 and R2 nothing (`10000: Authentication error`).
- **The Workers role replaces a legacy permission:** Workers Admin replaces "Workers Scripts Edit". Admin rather than Editor because the first deploy creates the Worker, and the scope has to be all Workers because custom domains don't support per-Worker roles.
- **R2 must be enabled once in the dashboard** before any R2 API call. Until then, calls return `10042: Please enable R2 through the Cloudflare Dashboard`. Enabling it requires a payment method on file.
- **Expect a TLS handshake failure for a few minutes** right after enabling R2: the account's S3 endpoint `<account>.r2.cloudflarestorage.com` isn't provisioned yet. It then starts working with no action needed.
- **The account needs a `workers.dev` subdomain** before the first Worker deploy, otherwise `10063: You need a workers.dev subdomain`. Opening Workers & Pages in the dashboard once creates it. Our Worker still has `workers_dev = false`.
- **The R2 S3 credentials are derived from the same token:**
  - access key ID = the token's `id` (from `GET /accounts/<account>/tokens/verify`);
  - secret = SHA-256 of the token value.
- **The state bucket `logseq-selfhost-tofu-state`** was created with `wrangler r2 bucket create`. Its location is OC.
- **Gotcha:** if any value in `.env.local` contains `$`, single-quote it, otherwise the shell expands it when the file is sourced.

## S1 — Free-plan deploy

**Result: pass.**

- `wrangler deploy` succeeded with the free-plan config (no `[limits]`, no `[[worker_loaders]]`):
  - Worker startup time was 345 ms.
  - The upload was 4154.68 KiB, or 746.77 KiB gzipped.
  - The custom domain `sync.example.com` attached on the first deploy.
- All 7 D1 migrations applied.
- `ASSET_LINK_SECRET` and `DB_SYNC_ADMIN_TOKEN` were set with `wrangler secret bulk`.
- The smoke test passed `health`, `openapi` and `unauthenticated-graphs`.
- **Still open:** whether the token actually needs DNS Write. It was granted, so this run doesn't prove it either way.

## S2 — Rate limiters on Free / PAT path

**Result: pass.**

- **Creating the PAT works.** A nightly desktop build (`2.0.2-alpha+nightly.20261021`) created a `logseq_pat_` token against the self-hosted server, with permission `both`. That proves the PAT-gate patch: the unpatched server would have refused this account.
- **The REST API works on Free.** `GET /api/v1/graphs` with the PAT returned 200, and the full smoke test passed (`health`, `openapi`, `unauthenticated-graphs`, `pat-graphs`).
- **Rate-limit bindings work on Free.** There was no `503 rate limiter unavailable`.
- **Side-by-side read test.** Each graph has its own PAT, and both contain a "Hello World" block:

  | | E2EE graph | Unencrypted graph |
  |---|---|---|
  | `listPages` | Titles come back as `[iv ciphertext]` packages. Journal page titles stay plaintext. | Plaintext titles |
  | `searchGraph` "Hello World" | 0 results: the server only holds ciphertext | 1 result: the block, with its uuid, page id and order |

- **Write round-trip (unencrypted graph):**
  - `createPage` returned 201.
  - `insertBlockChildren` (append one block) returned 201.
  - `listPageBlocks` returned 200 with the block.
  - The new page and block appeared in both the nightly desktop app and the web app through sync.
- **Conclusion:** an unencrypted graph works directly for agent use. An E2EE graph needs client-side decryption (see the backlog item for a client-side MCP), and server-side search can never match its text.

## S3 — Real graph within Free CPU limits

Pending.

## S4 — R2 state locking

**Result: pass.**

- **Test:** I held the state lock with a cancelled `tofu apply` and ran a concurrent `tofu plan -lock-timeout=0s`. The plan failed with `Error acquiring the state lock`, so `use_lockfile = true` is enabled.
- **Follow-up fix:** the first plan after `tofu apply` proposed an in-place D1 update, because `read_replication` was unset. I pinned it to `{ mode = "disabled" }`, and the plan now shows no changes.

## S5 — Nightly clients against the pinned server

**Result: pass on desktop, web and Android.**

- The desktop nightly (`2.0.2-alpha+nightly.20261021`), the web app and the Android nightly APK from the same release all sync against the server built from the pinned upstream commit.
- No iOS nightly build exists, so iOS is untested. The App Store release predates PATs.
