# logseq-cloudflare-selfhost

Run Logseq's DB sync server (the upstream `deps/db-sync` Cloudflare Worker) on your own Cloudflare account, at a hostname you control such as `https://sync.example.com`. Your Logseq clients sync through it. Remote agents such as Claude Code can read and write your graph through its REST API using a personal access token (PAT). An optional second Worker, the connector, lets claude.ai and Claude Code cloud sessions work in your graphs with no per-session setup (section 11).

The repo does not fork Logseq. It pins an upstream commit (`UPSTREAM_REF`), applies twenty small patches at build time (`patches/`), and deploys with OpenTofu, wrangler and GitHub Actions.

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
- [8. Switching to the paid plan](#8-switching-to-the-paid-plan)
- [9. Security notes](#9-security-notes)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Use your graphs from Claude](#11-use-your-graphs-from-claude)
- [Backlog](#backlog)
- [Licence and credits](#licence-and-credits)

## What you get

- **A sync server you own.** The Worker, its Durable Objects (one per graph), the D1 index database and the R2 asset bucket all live in your Cloudflare account. The only public entry point is your custom domain: `workers.dev` and preview URLs are turned off.
- **PATs for your own account.** Upstream only lets accounts in Logseq's internal groups create PATs. The patch in `patches/0001-pat-gate-allow-authenticated-users.patch` lets any signed-in account create, list and revoke its own PATs. That is what makes the REST API usable from scripts and agents.
- **Property values in the REST API.** Upstream's `getPage` and `getBlock` return only a page's or block's title and position. `patches/0002-semantic-get-returns-tags-and-properties.patch` adds its tags and its user and library property values (e.g. `schema.property/genre`), so Claude can read them through the connector. 0017 adds the built-in ones (see below).
- **Pages as readable outlines.** `patches/0003-semantic-page-outline.patch` adds `getPageOutline` (the connector's `get_page_outline`). It returns a page's tags, its property values and its whole block tree as a markdown outline, in one call, with `[[links]]` shown as page titles instead of UUIDs. It refuses E2EE graphs.
- **Search that finds pages.** Upstream's `searchGraph` returns pages under the `blocks` type, sorted after every block that mentions them, and ignores unknown `types` values. `patches/0004-semantic-search-pages-and-ranking.patch` adds a `pages` type, rejects unknown types with a 400, and ranks an exact title match first, then pages, tags, properties and assets, then blocks.
- **Batch errors that say what's wrong.** Upstream's `batchSetBlockProperty` and `batchDeleteBlockProperty` answer every rejected batch with `invalid batch property entry`, whether `entries` is missing, isn't an array, or one entry names a block, property or value that doesn't exist. `patches/0005-semantic-batch-property-errors.patch` returns `entries must be a non-empty array` for the first case and `entry <index>: <reason>` for the others. A rejected batch still writes nothing.
- **Inline tags that tag.** Upstream stores `#Tag` in a block written through the API as plain text, so the block never gets the tag, unlike the same text typed in the editor. `patches/0006-semantic-inline-tags.patch` resolves `#Tag` and `#[[Multi Word Tag]]` in inserted and updated block titles to an existing tag (exact title first, then a unique case-insensitive match) and stores them as the editor does, as `#[[uuid]]` with the tag set on the block. Tags Logseq refuses inline (page, property and other built-in kinds) are skipped. Patch 0015 escapes any other `#` that would read as a tag.
- **Text property values.** Upstream accepts only an existing entity as the value of a text (default-type) property such as *Description*, so a plain string fails, and text that happens to match a page title links that page and then fails Logseq's schema check with a 500. `patches/0007-semantic-text-property-values.patch` stores a plain string, or an array of strings for a multi-value property, in a new value block as the editor does. Text is never looked up by title; a UUID still references an existing value. Properties with fixed choices, such as Status, are unchanged, and encrypted graphs still need an existing entity.
- **Order keys that don't collide.** Some outliner writes, such as property value blocks and new pages, take the next order key after a process-wide maximum. Clients seed that maximum from the graph when they load it; upstream's Worker never does, so API writes can reuse an order key a sibling already holds, and a client later moves one of the blocks. `patches/0008-seed-order-key-for-server-writes.patch` seeds it from the graph on every semantic API request. It also fixes `get-max-order`, which returned another attribute's value on a graph with no ordered blocks.
- **Moves that land where they say.** Upstream's `moveBlocks` maps `before` and `after` to outliner options that address the target's children, so `before` made the block the target's first child and `after` its last child (or first, when it had none). `patches/0009-semantic-move-before-after.patch` makes `after` the target's next sibling and `before` its previous sibling (the first child of its parent when it has none), and refuses `before` and `after` on a page.
- **Page blocks without property values.** A page's text and URL property values are stored as blocks under the page, and upstream's `listPageBlocks` returned them among the page's top-level blocks, although the outline and block children leave them out. `patches/0010-semantic-page-blocks-skip-property-values.patch` leaves them out of `listPageBlocks` too; they stay readable by UUID.
- **Writes that don't duplicate or destroy by surprise.** Upstream's `createPage` and `createTag` accept a title another page, tag or property already has, so a case variant becomes a second page and `createTag` silently turns a same-named page into a tag; its `deletePage`, `deleteTag` and `deleteProperty` act at once, however much links to what they delete. `patches/0011-semantic-write-guards.patch` refuses a title already used by a page, journal, tag or property, compared ignoring case as Logseq compares page names, with a 409 that names each one's kind, title and UUID (for `createTag`, patch 0027 adds a pointer to `promote_page_to_tag` when a page it can convert holds the title); a page in the Recycle bin is restored instead, and E2EE graphs aren't checked. The three deletes refuse with a 409 while they would lose references, tag holders, child tags or property values, unless the matching `acknowledge-references`, `acknowledge-holders`, `acknowledge-child-tags` or `acknowledge-values` query flag is `true`, and `dry-run=true` returns the counts without deleting. `deleteBlock` refuses pages, tags and properties, so the guards can't be bypassed.
- **Bulk operations.** Upstream reads, deletes and moves one item (or one target) per call, so routine work such as tagging a dozen people or filling several pages runs into the limit of 20 writes per minute. `patches/0012-semantic-bulk-operations.patch` adds `getBlocks` (up to 100 blocks or pages by UUID, with tags and properties, optionally with their trees as outlines), `deleteBlocks` (up to 100 blocks), `batchMoveBlocks` (up to 100 moves, each to its own target) and `batchInsertBlockTrees` (block trees and properties for several pages, naming a page by title creates it). Block tree nodes take a `properties` object, so a block gets its tags and property values as it is inserted. Each bulk write is one request, checks every entry first, and applies all of them or none; `dry-run` reports what would change without changing anything. `verbose=false` makes insert responses just the new blocks' UUIDs and a count.
- **Backlinks by relation, graph health and a knowledge index.** Upstream's `listPageReferences` is one flat list, and no operation reads the graph as a whole. `patches/0013-semantic-backlinks-health-knowledge-index.patch` adds three read operations, all refused on E2EE graphs. `getPageBacklinks` groups everything that points at a page, tag or property into text links, tagged objects, property values and other references, with a complete count for each. `getGraphHealth` lists tags and properties nothing uses, titles that collide ignoring case, and pages whose first block isn't a `**Summary:**` block or that have no tag, a page of each at a time. `listKnowledgeIndex` pages through the non-journal pages people wrote, with their tags and the classes those extend, summary, reference count and last update, and leaves out pages with an excluded tag. The connector's `kb_index` is built on it (11.8). On a synthetic graph of 3,000 pages and 30,000 blocks, each call took under half a second in a Node test run.
- **A change feed for a search index.** The API has no way to list the blocks that changed since a point, or to notice deletes. `patches/0014-semantic-block-changes-feed.patch` adds `listBlockChanges`: every content block with its page title, breadcrumb and tags, or, given an earlier response's `t` and `epoch`, only what changed since, read from the sync tx log, plus the UUIDs that went away. The connector's optional semantic search (11.11) uses it; it isn't a connector tool.
- **No stray tags from issue numbers.** Text such as `PR #15` or `PR#7` written through the API stays plain text only until the block is next edited in Logseq, when the editor turns `#15` into a new tag named `15` (or `21)`, since `)` belongs to the name). `patches/0015-semantic-escape-inline-tags-and-refresh-refs.patch` escapes every `#` that Logseq's own markdown parser (mldoc) would read as a tag, other than one 0006 resolved, as `\#`, which Logseq displays as `#` and never turns into a tag. Code spans, link labels and URL fragments are left alone. Each write's response lists the tags it escaped under `escaped`, even with `verbose=false`, and `updateBlock` now returns the stored title rather than echoing its input. It also adds `refreshRefs` (the connector's `refresh_refs`): it reruns this handling, and 0006's, on blocks already in the graph, for one page or the whole graph. It previews by default, applies with `apply: true`, returns each block's before and after text, handles at most 200 blocks per call and refuses E2EE graphs.
- **Property idents in paths.** Upstream's router decodes `logseq.property%2Fstatus` in a request path to `logseq.property/status`, then pastes it, unencoded, into the path it forwards to the graph's Durable Object. The `/` becomes an extra path segment, so `setBlockProperty`, `deleteBlockProperty`, `getProperty`, `updateProperty` and `deleteProperty` answered 404 for any property named by its ident, although the API documents idents as accepted. `patches/0016-semantic-forward-encoded-path-params.patch` encodes each path parameter again when forwarding.
- **Built-in property values that the editor shows.** Patch 0002 left every built-in `logseq.*` property out of `getPage`, `getBlock` and `getBlocks`, so a task's Status, Priority and Deadline, and a page's Description, never appeared: a Done task read as having no properties. `patches/0017-semantic-get-returns-public-built-in-properties.patch` returns the built-ins Logseq marks public, which are the ones the editor shows. Hidden built-ins (timestamps, creators and the like) are still left out. `getPageOutline` lists them as `key:: value` lines too, apart from Status, which is already the line's `[Status]` marker, and Heading, which it shows as the block's `## ` prefix (patch 0024).
- **Batched writes that sync as they were written.** A batched write (such as `batchSetBlockProperty` or a block tree insert with properties) runs on a temporary copy of the graph, then replays its changes into the graph in one transaction, but each change kept the copy's transaction id. The log clients replay keeps one change per entity, attribute, value and transaction id and sorts by transaction id, so a value removed, added back and removed again within a batch could log as "remove, then add", and clients kept a value the server had removed: resetting two tags' parent to Organization left the second tag under Root as well in the app, while the server was right. `patches/0018-batch-commits-as-one-transaction.patch` replays the changes without their transaction ids, so a batch is one transaction with one id. The desktop app runs its own batched edits through the same upstream code, which this patch can't reach.
- **A list of who may use the server.** Upstream lets any Logseq account sign in, create graphs and create PATs on your server. `patches/0019-allowed-users.patch` refuses every user who isn't in the secret `DB_SYNC_ALLOWED_USERS`, with a 401. A missing, empty or malformed list refuses everyone. Section 9 explains how to set it.
- **No unauthenticated MCP endpoint.** Upstream's `/mcp` answers anyone, with no token. `patches/0020-remove-upstream-mcp.patch` removes it, so the path now answers 404 (section 8). The connector (section 11) does its job.
- **Choice values that belong to their property.** Upstream resolves a value given by title against every entity in the graph with that title, so setting *Relationship status* to `active` could store *Project status*'s `active` choice, and any block whose title matched was accepted as a choice. A node property took the same first match, so `High` stored Priority's built-in *High* choice rather than the page *High*. `patches/0021-semantic-choice-values-scoped-to-property.patch` resolves a value of a property with choices only among that property's own choices that the block's tags allow (by UUID, ident, title ignoring case, or number) in `setBlockProperty`, `batchSetBlockProperty`, the block tree inserts, `captureToToday` and `createTask`, and refuses anything else with the valid choices listed. A title for any other ref property, such as a node property, never matches another property's choice or value block, prefers pages to blocks, and is refused with the candidates' UUIDs when several pages share it. A URL given to a URL property is stored in a value block of the block's own, as the editor does, so deleting or editing another block with the same URL never changes it, and never in a block whose text is the link. In `batchSetBlockProperty` with `isResetExistingValues`, a later entry is checked against the tags the write leaves: a list of tags replaces the block's tags and a single tag adds to them. A `mismatched-choice-values` check in `getGraphHealth` finds values stored before the fix: another property's choice (on a property with choices or a user property without them), something that isn't a choice, or a choice outside the holder's tags (values cleared to Logseq's empty placeholder are not flagged).
- **Node values of mixed kinds read back, and values a type can't take are refused.** `entity-properties-response` (patch 0002) sorted a many-valued property's values by `:block/order`, or by db id for entities without one, and comparing the two kinds threw `Cannot compare <string> to <number>`. Plain and journal pages have no order key; blocks, property entities and pages under the Library or a namespace do. So a node property holding one of each, such as `about` with a plain page and a namespace page, made `getBlock`, `getBlocks`, `getPage` and `getPageOutline` return HTTP 500, although the stored values were valid. `patches/0022-semantic-node-values-of-mixed-kinds-read.patch` lists values with an order key first, by order key, then the rest by db id. It also refuses, naming the entry and property, a value the property's type can't take (a page for a text property, a non-journal page for a date property, a UUID that isn't the property's own value block, a non-datetime for Deadline or a non-boolean for a checkbox), where these were server errors or stored another block's value. A number property without choices takes `3` or `"3"` as the number itself and never as a db id.
- **Upstream tests one namespace at a time.** Upstream's db-sync test runner ignores its arguments, so every run takes all ~312 tests (about 40 s). `patches/0023-db-sync-test-runner-namespace-filter.patch` makes `node worker/dist/worker-test.js <regex>` run only the namespaces whose name contains a match for the regex, such as `semantic-choice-values`. With no argument it runs everything, as before. `scripts/upstream-test.sh <checkout> [regex]` uses it against a warm `shadow-cljs watch`, so a one-namespace run after an edit takes seconds rather than a minute; `scripts/check.sh --upstream` still runs the whole suite.
- **Headings that keep their level.** `updateBlock` saved a title through the outliner's `save-block!`, which strips a leading `#` to `######` but leaves it to the caller to set `logseq.property/heading`, as the app does. The semantic handler didn't, so `update_block` with `## Section` lost both the prefix and the level, while the insert tools went through `insert-blocks!`, never reached that step and kept `## ` as text. `patches/0024-semantic-markdown-heading-prefix-to-property.patch` makes every write path store the title without the prefix and the level in `logseq.property/heading`, skips blocks with a display type (code, math, quote) so a `# comment` line stays, and makes `getPageOutline` show a level 1 to 6 heading as its `## ` prefix. 11.8 has the details.
- **Today in the owner's time zone.** Upstream works out today's journal from the Worker's local clock, which is UTC on Cloudflare, so a capture or a task made on a New Zealand morning landed on yesterday's journal. `patches/0025-semantic-today-in-owner-time-zone.patch` takes the date in the zone the Worker's `TIMEZONE` variable names (UTC when unset; an unknown zone refuses the write with a 500 before anything is written), for `captureToToday`, `createTask` with no `page-id` and `createAsset` with no `page-id`. All three answer with the page's `page-id` and `page-title`. `deletePage` decides which journal is today's in the same zone, because Logseq deletes today's journal's blocks and keeps the page instead of recycling it; before, on a New Zealand morning it hard-deleted yesterday's blocks. 11.8 has the details.
- **Property choices, class restrictions and tag set-up.** Upstream's `createProperty` and `updateProperty` take only a title, type and cardinality, and `createTag` and `updateTag` take no `extends` or tag properties, so every choice list and class restriction had to be set up in the app. `patches/0026-semantic-property-choices-and-class-restrictions.patch` adds `choices` (add, update, order, retire), `classes` and `convert_values` to the property endpoints, and `extends` and `properties` (add, remove or set) to the tag endpoints, with `acknowledge-holders` and `dry-run` query flags on `updateProperty`. It also refuses a UUID, ident or db id value that isn't an instance of a node property's classes, as a title already was. Each call checks every field first, writes once in one transaction and reads the result back, answering 500 if it didn't land. Section 11.8 describes the options.
- **Promoting a page to a tag.** `createTag` refuses a title a page already has, and `tags = Tag` on a page answered 500, so there was no way to turn a page into a tag. `patches/0027-semantic-promote-page-to-tag.patch` adds `promotePageToTag` (`POST /pages/:page-id/promote-to-tag`), which copies the app's "Convert to tag" transaction and guards, accepts `extends` and `dry-run`, and reads the result back. It also makes `tags = Tag` a 400 that names the tool, lets a re-sent Tag on an existing tag succeed as a no-op, and makes a tag replacement keep the built-in type tags the entity holds (Page, Tag, Journal, Property and the like) and remove only the user tags the list leaves out, as the app's tag editor does; removing Page or Tag answered 500. `createTag`'s 409 for a page now points at the new tool. Section 11.8 describes it.
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
| Workers Paid | $5/month plus usage beyond the included amounts | Raises the CPU limit (the config sets 300 s). D1 Time Travel covers 30 days. |

The connector's optional semantic search (11.11) runs on Free for graphs up to about 13,000 indexed blocks (the Free plan stores 5M Vectorize dimensions). A larger graph needs Workers Paid, where it adds under $0.01/month.

R2 is billed separately. It has a monthly free tier, but Cloudflare asks for a payment method before you can enable it. Check Cloudflare's current pricing pages for the exact allowances.

### Watching your usage

On the Free plan, going over a daily allowance makes requests fail until the allowance resets at 00:00 UTC; nothing is billed. The allowances are account-wide, so the sync server and the connector share them.

**In the dashboard:**

| Where | What it shows |
|---|---|
| **Workers & Pages → the Worker → Metrics** | Requests, errors and CPU time per Worker |
| **Workers & Pages → the Worker → Logs** | Each request and cron run; failures show as "Exception Thrown" |
| **Storage & Databases → D1 → the database → Metrics** | Rows read and written |
| **Storage & Databases → KV**, **Vectorize** | Operations, and stored vectors |
| **AI → Workers AI** | Neurons by model |
| **Compute → Durable Objects** | Requests, duration and SQLite rows |

**The usage report.** `scripts/usage-report.mjs` reads every Free allowance from Cloudflare's GraphQL Analytics API and prints a table with today's usage, its share of the limit, and a projection to 00:00 UTC that continues the last hour's rate (so a fix or a new spike shows in the next run). It exits 1 when an allowance is at 70% (`--threshold`) or its projection passes the limit. The `usage` workflow runs it at 03:00, 09:00, 15:00 and 21:00 UTC; a failed run emails you, and the table is on the run's summary page. It only knows the Free plan; on Workers Paid, use **Manage Account → Billing → Billable usage** instead.

To turn it on:

1. Create a second, read-only token under **Manage Account → Account API Tokens → Create Token → Custom token**, with one policy: **Account** → your account → **Account Analytics** Read. Every dataset the report reads (Workers, Durable Objects, D1, KV, Workers AI, Vectorize) is covered by that one permission. Keep it separate from the deploy token, which can change everything.
2. Store it as the `production` secret `CLOUDFLARE_ANALYTICS_TOKEN`, and set the variable `USAGE_REPORT_ENABLED` to `true`:

   ```bash
   gh secret set CLOUDFLARE_ANALYTICS_TOKEN --env production   # paste the token at the prompt
   gh variable set USAGE_REPORT_ENABLED --body true
   ```

3. Run it once: **Actions → usage → Run workflow**, or `gh workflow run usage.yml`.

To run it locally, with `.env.local` loaded (the deploy token can read analytics too): `node scripts/usage-report.mjs --settings config/settings.json`.

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
- **Vectorize** Write + Read is only used by the connector's optional semantic search (11.11), to create its index and deploy the binding.
- **DNS Write** was granted in the verified setup. It may not be needed, but that hasn't been proven either way.

You don't create separate R2 S3 keys. `scripts/with-r2-credentials.sh` derives them from this token: the access key ID is the token's ID, and the secret is the SHA-256 of the token value. It exports them only to the command it wraps. There are no `R2_*` or `AWS_*` secrets anywhere.

### 1.2 Enable R2

In the dashboard, open **R2** and enable it. This needs a payment method on file. Until you do, R2 API calls fail with `10042: Please enable R2 through the Cloudflare Dashboard`.

For a few minutes after you enable it, connections to `<account-id>.r2.cloudflarestorage.com` fail with a TLS handshake error, because the endpoint isn't provisioned yet. Wait, then retry.

### 1.3 Create the workers.dev subdomain

Open **Workers & Pages** in the dashboard once. That creates your account's `workers.dev` subdomain. Without it, the first deploy fails with `10063: You need a workers.dev subdomain`. The Worker itself doesn't use `workers.dev`.

### 1.4 Fill in `.env.local`

`.env.local` holds the same values the GitHub `production` environment holds, so you can run everything from your machine. It is git-ignored.

**You supply only three things: the Cloudflare API token, the Cloudflare account ID, and your hostname. Three more values are generated, and the allow-list starts as `none`.**

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
| `DB_SYNC_ALLOWED_USERS` | Logseq user IDs allowed to use the server, or `none`. Written as `none`; set your ID after your first sign-in (section 9). | Template |
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
| `DB_SYNC_ALLOWED_USERS` | Yes. `none` or your user ID(s) (section 9). The deploy stops without it. |
| `SYNC_HOSTNAME` | Yes |
| `SMOKE_PAT` | Optional. It enables the authenticated smoke check. |
| `CONNECTOR_HOSTNAME` | Only with the connector (section 11) |
| `CONNECTOR_GITHUB_CLIENT_ID` | Only with the connector. `.env.local` calls it `GITHUB_CLIENT_ID`. |
| `CONNECTOR_GITHUB_CLIENT_SECRET` | Only with the connector. `.env.local` calls it `GITHUB_CLIENT_SECRET`. |
| `OWNER_GITHUB_USER_ID` | Only with the connector |
| `COOKIE_ENCRYPTION_KEY` | Only with the connector |
| `GRAPH_TOKEN_KEY` | Only with the connector |
| `CLOUDFLARE_ANALYTICS_TOKEN` | Only with the usage report ([Watching your usage](#watching-your-usage)) |

**Two settings are variables, not secrets.** `CONNECTOR_ENABLED` turns the optional connector on (section 11), and `USAGE_REPORT_ENABLED` the usage report ([Watching your usage](#watching-your-usage)). Leave them unset for now: unset means off.

**Two secrets are renamed on the way.** GitHub forbids secret names that start with `GITHUB_`, so the OAuth app's client ID and secret are stored as `CONNECTOR_GITHUB_CLIENT_ID` and `CONNECTOR_GITHUB_CLIENT_SECRET`. `.env.local` keeps the `GITHUB_*` names, which are the names the connector Worker uses; `init-env.sh --push` and `deploy.yml` translate between them.

The easiest way is `scripts/init-env.sh --push`. It does 1.4 and then sets the seven required secrets above in the `production` environment of the repo that owns your checkout (it prints the repo name first and passes it to `gh` with `-R`), passing each value on stdin only. Run it after the `production` environment exists (the commands above) and `gh` is logged in. The connector's secrets are pushed later, by `scripts/init-env.sh --add-missing --push` (section 11).

If `.env.local` already exists, or a push failed part-way, load `.env.local` as in 1.4 and copy the values with this loop (bash). The values never land in your shell history or in `gh`'s arguments. Uncomment the second `names` line once the connector's values are in `.env.local`:

```bash
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # run inside this checkout
echo "Pushing to $repo"
names="CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN DB_SYNC_ALLOWED_USERS SYNC_HOSTNAME"
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

1. checks that `DB_SYNC_ALLOWED_USERS` is `none` or a list of user IDs, and stops before anything is deployed if it isn't (section 9);
2. reads the OpenTofu outputs (the D1 database ID);
3. renders upstream's `wrangler.toml` for your account, hostname and plan (`scripts/render-wrangler.mjs`);
4. applies D1 migrations (`wrangler d1 migrations apply logseq-sync-index --remote`) **before** deploying;
5. checks the list against the users the server already knows. It stops when none of the listed IDs is a known user, and warns when a listed ID hasn't signed in yet or a user who owns graphs isn't listed;
6. runs `wrangler deploy --secrets-file`, which ships the code and the three secrets (`ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN`, `DB_SYNC_ALLOWED_USERS`) together, and attaches the custom domain;
7. runs `scripts/smoke-test.sh https://$SYNC_HOSTNAME`.

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
ok jwt-garbage-refused
ok pat-graphs              # only when SMOKE_PAT is set; otherwise a note says so
ok upstream-mcp-off
```

You can check by hand too: `curl https://sync.example.com/health` returns `{"ok":true}`.

## 3. Point your clients at the server

On each device, running a nightly build (section 0):

- **Desktop and web:** Settings → Advanced → Sync Server URL = `https://sync.example.com`.
- **Mobile:** Settings → Sync Server URL = `https://sync.example.com`.

Then sign in with your Logseq account and create or upload a graph.

**On a new install, the first sign-in is refused.** The allow-list starts as `none`, which refuses everyone. Get your user ID as [9.1](#91-who-can-use-your-server) describes for a fresh install, set `DB_SYNC_ALLOWED_USERS`, push it and redeploy. Then sign in again. Re-enter the server URL first if the client signed you out.

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

**Scheduled workflows can stop silently.** GitHub disables `schedule` triggers in public repos after 60 days without repository activity. That would quietly stop the daily backup, the weekly bump and the usage report. Re-enable them in the Actions tab, or run `gh workflow enable backup.yml`, `gh workflow enable bump-upstream.yml` and `gh workflow enable usage.yml`. Check occasionally that the latest runs are recent.

**If rclone gets a 403 on its bucket check,** set `RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true` for the asset sync. That's the usual fix for R2 tokens that can't list buckets. The verified setup didn't need it, because the token from 1.1 can list buckets.

**Limits.** Backups live in the same Cloudflare account. If you lose the account, only your clients' local copies remain. An off-account copy is on the backlog.

## 8. Switching to the paid plan

`config/settings.json` has `"plan": "free"` by default. Free is verified working, including the REST API and its rate limiters. The paid plan only raises `[limits] cpu_ms` to 300000 (300 s).

To switch:

1. In the Cloudflare dashboard, subscribe to **Workers Paid**. Do this first: the paid config uses a limit the Free plan doesn't offer.
2. Set `"plan": "paid"` in `config/settings.json` in a PR.
3. Merge it to `main`. The deploy renders the paid config.

To go back, set `"plan": "free"` and merge.

**Upstream's own `/mcp` endpoint is off on both plans.** Anyone could call it without a token, so a patch (`patches/0020-remove-upstream-mcp.patch`) removes it, and the rendered config no longer binds the Worker Loader. `/mcp` on the sync server now answers 404, and the smoke test's `upstream-mcp-off` check, which runs on both plans, fails the deploy if it ever answers again. To use your graphs from claude.ai, use the connector (section 11) instead. It runs on the Free plan.

## 9. Security notes

- **Only the Logseq accounts you list can use your server.** Without a list, any Logseq account could sign in, create graphs and create PATs, and use your quota and storage. See 9.1.
- **Never set `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`.** It lets anyone impersonate any user. `render-wrangler.mjs` refuses to render a config containing it, or any `SENTRY_*` var.
- **`DB_SYNC_ADMIN_TOKEN` bypasses graph access checks.** It can read every graph. Keep it only in `.env.local` and the `production` environment.
- **The Cloudflare API token** controls everything here, including the derived R2 keys. Treat it like a root password.
- **PATs** are graph-scoped. Give agents the narrowest permission that works, and revoke unused tokens in Settings.
- **Secrets stay out of the repo and the logs.** The repo, the rendered `wrangler.toml` and the logs hold no secrets. The OpenTofu state and plans are encrypted. The OpenTofu outputs are marked sensitive, and `deploy.yml` and `deploy.sh` mask the D1 database id in Actions logs, so it and the other resource ids stay out of public run logs. `deploy.yml` and `backup.yml` never run on pull requests, and `ci.yml` uses no secrets, so fork PRs can't reach them.
- **Your hostname is public.** Certificate transparency logs publish it, and internet scanners start probing a new hostname within hours. You'll see requests for paths like `/.env` in the Worker logs. They're harmless, but expected. Keeping `SYNC_HOSTNAME` out of the repo only avoids advertising it.

### 9.1 Who can use your server

The Worker refuses every Logseq user who isn't in the secret `DB_SYNC_ALLOWED_USERS` (patch `0019-allowed-users.patch`). A refused user gets a plain 401 on every route that needs sign-in: syncing, the REST API and PAT management. The admin token, signed asset links and `/health` don't involve a user, so they work as before.

The value is `none`, or one or more Logseq user IDs separated by commas. Each ID is a lowercase UUID, and spaces around it are ignored. **It fails closed.** A missing, empty or malformed value refuses everyone, and so does `none`. `deploy.sh` stops before deploying anything if the value is malformed, so a typo can't ship. It also stops on `none` once anyone has signed in to the server, so `none` can't switch everyone off on an existing install.

**Finding your user ID.** Use any one of these:

- **`scripts/list-users.sh`** prints each user's ID, email, username, how many graphs they own and whether they're on your list. It needs `.env.local` (1.4), runs only on your machine, and refuses to run in GitHub Actions because it prints IDs and emails.
- **The Cloudflare dashboard.** Go to Storage & Databases → D1 → the sync database (`logseq-sync-index` by default) → Console, and run `SELECT id, email FROM users`.
- **On a fresh install,** no one has signed in yet, and a refused user is never recorded, so neither of the above shows you. Sign in once from Logseq. You are refused, and the Worker logs a `db-sync/user-not-allowed` warning with your user ID and email. Read it with `wrangler tail logseq-sync` (the default worker name; `config/settings.json` has `workerName`) or in Workers Logs in the dashboard. Then set the list and redeploy. You can also decode the `sub` claim of the `id-token` in the client's Local Storage (section 4 shows where it is): that is your user ID.

A fresh install starts with `DB_SYNC_ALLOWED_USERS=none`, so the first deploy passes and the server refuses everyone until you set your ID. The deploy prints a warning about that. It is expected.

**Adding someone.** Append their ID to the comma-separated list in `.env.local`, with no spaces, and in the `production` secret (reload `.env.local`, then push it with [the loop in 1.8](#18-set-up-the-github-production-environment)), then redeploy. If they haven't signed in yet, the deploy warns that a listed ID hasn't signed in. That is expected.

**Removing someone.** Take their ID out of both places and redeploy. It takes effect on the next deploy. Their graphs stay on the server (see the cleanup below).

**Rolling this out on an existing install.** Do these in order. **The secret must be in `production` before you merge the PR that brings the allow-list.** Otherwise the deploy stops at the format check. That stop is safe: nothing is deployed and the running server isn't touched. But you will have to fix it and run the deploy again.

1. Run `scripts/list-users.sh` and find your own row. Note any other users: they are either strangers or your own second account.
2. Put your ID, and the ID of any other account you use, in `.env.local` as `DB_SYNC_ALLOWED_USERS`, comma-separated. Write them with no spaces (`id1,id2`), because the shell sources the file.
3. Reload `.env.local` first (the `set -a` line in [1.4](#14-fill-in-envlocal)), so a shell with the old value doesn't push it. Then push it with [the loop in 1.8](#18-set-up-the-github-production-environment). (`init-env.sh --add-missing` only handles names missing from `.env.local`, so it won't push a value you added by hand.)
4. Merge. The deploy checks the value, ships it together with the code, and the smoke test's `pat-graphs` check (when `SMOKE_PAT` is set) confirms you still get in.
5. Optional. To remove a stranger's graph, call `DELETE /admin/graphs/<graph-id>` with the header `x-db-sync-admin-token: <DB_SYNC_ADMIN_TOKEN>`. This is manual: nothing does it for you, and it can't be undone.

**If you get locked out.** The deploy can't tell a list that names the wrong known account from the right one, so a mistake there can pass the checks. There is no automatic rollback. Fix the secret in `.env.local` and `production` and redeploy, or run `$W rollback --name logseq-sync` to put back the previous version of the Worker (`$W` is the wrangler path from [section 6](#6-upgrades), and `logseq-sync` is the `workerName` in `config/settings.json`). Right after the rollout, the previous version is the one without the allow-list, so rolling back re-opens the server to every Logseq account until you redeploy.

**Rotating secrets:**

| Secret | How |
|---|---|
| `ASSET_LINK_SECRET`, `DB_SYNC_ADMIN_TOKEN` | Generate a new value. Update `.env.local` and the `production` secret, then redeploy: every deploy re-sets them. Rotating `ASSET_LINK_SECRET` invalidates asset links signed earlier. |
| `DB_SYNC_ALLOWED_USERS` | Not a credential, so there is nothing to rotate. To change who may use the server, edit it in `.env.local` and the `production` secret, then redeploy (9.1). |
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
| `settings.timeZone is not an IANA time zone` at deploy, or `500 invalid TIMEZONE setting: <zone>` from a capture, task or upload with no page, or from deleting a journal | `timeZone` in `config/settings.json` (or the sync Worker's `TIMEZONE`) isn't a zone the runtime knows. Use an IANA name such as `Pacific/Auckland`. The server refuses before it writes anything, so no journal is created or changed. Other calls that name a page are unaffected. |
| `429 rate limit exceeded` | The limit is 120 reads or 20 writes per minute. Slow down. |
| `403 forbidden` from the REST API | The PAT belongs to a different graph, or its permission doesn't cover the operation. |
| Backups, the weekly bump or the usage report stopped running | GitHub disabled the `schedule` triggers after 60 days without repository activity. Re-enable in the Actions tab or `gh workflow enable backup.yml` / `gh workflow enable bump-upstream.yml` / `gh workflow enable usage.yml` (section 7). |
| The usage report fails with `not authorized` | `CLOUDFLARE_ANALYTICS_TOKEN` lacks **Account Analytics** Read, or belongs to another account ([Watching your usage](#watching-your-usage)). |
| Backup fails with 403 on the bucket check | The token can't list buckets. Set `RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true` (section 7), or give the token the R2 permissions from 1.1. |
| The bump workflow can't create its pull request | Enable **Allow GitHub Actions to create and approve pull requests** in Settings → Actions → General (1.8). |
| Local deploy rolled the server back | `.upstream` was older than `UPSTREAM_REF`. `rm -rf .upstream`, redo 1.5, deploy again (section 2). |
| Everything returns 401 after a deploy | The Worker refuses users who aren't in `DB_SYNC_ALLOWED_USERS`. Check the secret, and look for a `db-sync/user-not-allowed` warning in `wrangler tail logseq-sync` or Workers Logs: it names the refused user's ID. Fix the list and redeploy (9.1). |
| Deploy fails: `none of the N listed user IDs is a known user of this server` | A typo, the wrong account, or `none` on a server that already has users (`none of the 0 listed user IDs ...`). Run `scripts/list-users.sh`, correct `DB_SYNC_ALLOWED_USERS` in `.env.local` and the `production` secret, and deploy again. Nothing was deployed. |
| Deploy fails: `DB_SYNC_ALLOWED_USERS is empty or missing` | The secret isn't set in the `production` environment. Push it with [the loop in 1.8](#18-set-up-the-github-production-environment), then deploy again. Nothing was deployed. |
| Smoke test `FAIL health: 000` right after the first deploy | The custom domain's certificate is still being issued. Wait a few minutes and re-run `scripts/smoke-test.sh https://sync.example.com`. |

Connector problems are covered in section 11.

## 11. Use your graphs from Claude

The connector is an optional second Worker, `logseq-connector`, at its own hostname such as `https://mcp.example.com`. It is a remote MCP server that you add **once** as a custom connector in claude.ai. After that, claude.ai on web, desktop and mobile, and Claude Code cloud sessions, can read and write your graphs. The only per-session step is enabling it.

- **You sign in with GitHub**, and only your own GitHub account is accepted.
- **It holds your graph tokens.** You connect each graph once by pasting a PAT into the connector's `/graphs` page. Claude never sees a token: it names graphs by an alias you choose.
- **It calls the sync server privately**, over a Cloudflare service binding (`SYNC`) to `logseq-sync`, not over the public hostname.
- **Its tools are generated** from the sync server's OpenAPI document at `UPSTREAM_REF`. When an upstream bump adds, removes or changes an operation, CI flags it: run `npm --prefix connector run update:manifest` and commit the result.
- **It runs on the Workers Free plan.** It adds one Worker, a KV namespace for OAuth grants, a KV namespace caching each graph's `kb_index`, a small D1 database for the connected graphs and an hourly cron trigger that rebuilds the cache. One person's use stays well inside KV's free daily allowances. The file tools on large inputs, and `kb_index` on a graph of thousands of pages, are *(not yet verified)* against the Free plan's CPU time per request (11.8).

**Status.** The connector is deployed and in use: claude.ai, Claude Code cloud sessions and a local Claude Code have each signed in and read and written a graph. `docs/spike-results.md` records what was checked. Two things are still unmeasured: CPU time for the file tools on large inputs, and how claude.ai treats the tools' annotations (11.6, 11.8).

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

Edit the token from 1.1 and add **Workers KV Storage** Write + Read to its account policy. The connector's OAuth grants and its `kb_index` cache live in KV, and OpenTofu creates both namespaces with this token. Editing the policies doesn't change the token's value.

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

1. creates the KV namespaces `logseq-connector-oauth` and `logseq-connector-kb-index` and the D1 database `logseq-connector` (`tofu apply`). An install that enabled the connector before `kb_index` existed gets the second namespace on its next deploy, with no manual step;
2. deploys the sync server as before;
3. runs `scripts/deploy-connector.sh`, which renders the connector's config (`scripts/render-connector-wrangler.mjs`), applies its D1 migrations, runs `wrangler deploy` (which also attaches the custom domain and the hourly cron trigger), sets the Worker secrets with `wrangler secret bulk`, and runs `scripts/smoke-connector.sh https://$CONNECTOR_HOSTNAME`.

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

Calls from the connector to the sync server go over the service binding. It reaches `logseq-sync` even though `logseq-sync` has `workers_dev = false` and only a custom domain.

**Turning it off again needs manual teardown.** Once the resources exist, any OpenTofu run with the connector off (the variable unset or `false` in Actions, or `CONNECTOR_ENABLED` missing or `false` in your shell) plans to destroy the KV namespace and D1 database. `prevent_destroy` refuses that, which fails the whole deploy, the sync server's included. To turn it off, first remove the two resources from the OpenTofu state, then set the variable to `false` straight away (a deploy in between would try to create them again), and set `CONNECTOR_ENABLED=false` in `.env.local`:

```bash
scripts/with-r2-credentials.sh mise exec -- tofu -chdir=infra state rm \
  'cloudflare_workers_kv_namespace.connector_oauth[0]' 'cloudflare_d1_database.connector[0]'
```

The `kb_index` cache namespace `logseq-connector-kb-index` has no `prevent_destroy`: the next run with the connector off deletes it. Then delete the `logseq-connector` Worker, the KV namespace `logseq-connector-oauth` and the D1 database `logseq-connector` in the Cloudflare dashboard, remove the connector in claude.ai, and revoke the graph tokens in Logseq. This path hasn't been exercised yet.

### 11.6 Add it to claude.ai and Claude Code

**claude.ai**:

1. Open **Settings → Connectors → Add custom connector**.
2. Give it a name, such as `Logseq`, and the URL `https://mcp.example.com/mcp`. Leave the advanced OAuth client ID and secret empty: the connector lets claude.ai register itself.
3. Click **Connect**. The connector asks you to allow Claude access to your Logseq graphs, then sends you to GitHub. Sign in with the GitHub account whose ID is in `OWNER_GITHUB_USER_ID`. Any other account gets "This GitHub account is not allowed to use this connector."
4. Enable the connector in a conversation from its tools menu, then ask "list my Logseq graphs".

Every tool carries MCP annotations from one table (`ANNOTATIONS` in `connector/src/tools/spec.mjs`, recorded in `tools-manifest.json`): reads are read-only; deletes, updates, property sets, `refresh_refs` and `promote_page_to_tag` are destructive, since they can overwrite or remove data; deletes and sets are idempotent; and only `save_file_from_url`, which fetches an outside URL, is open-world. Whether claude.ai uses them to skip or force the approval prompt for a custom connector hasn't been checked. Either way you can set each tool to Always allow, Needs approval or Blocked in the connector's settings.

**Claude Code cloud sessions** inherit your claude.ai connectors. Enable the connector for the session. The traffic goes through Anthropic, so the environment needs no network allow-list, environment variables or skill for it. Section 5 stays available for raw REST access.

**Claude Code on your own machine** works too, because the connector accepts loopback redirect URIs: run `claude mcp add --transport http logseq https://mcp.example.com/mcp`, then `/mcp` in a session to sign in.

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
- **`connector_help`** gives Claude the conventions for well-formed Logseq content: `kb_index` first for broad topics, `insert_block_tree` for whole notes, the batch tools for work across many blocks or pages, `[[Page]]` links, `create_task` for tasks, `capture_to_today` for the journal, and a `**Summary:**` first block on new pages.
- **`kb_index`** returns a graph's knowledge-base index in one call: every non-journal page, grouped into Project, Organization, Person, Area, Resource and Other, with its tags, summary, reference count, last update and UUID, most referenced first. Arguments: `tag` keeps pages tagged with that class or a class extending it (ignoring case), `limit` caps each group (default 25, at most 100; group counts stay complete) and `refresh: true` rebuilds now.
  - **Grouping.** A page goes to the first group, in that order, that one of its tags or any class they extend names, ignoring case and spaces. Organization also takes `Organisation`, and Resource also takes schema.org's `CreativeWork` (articles, books, documents, guides, web sites). Anything else, such as `Business Meeting` (an Event), and untagged pages go to Other, with their tags shown.
  - **Left out:** journals, built-in pages, tags and properties, and every page tagged `private` (any capitalisation) or with a tag that extends it. The server drops them, so they never reach the cache. Create a `Private` tag and tag a page with it to keep the page out.
  - **Summary:** the text after `**Summary:**` in the page's first top-level block (property values don't count), with links shown as titles, cut to 240 characters.
  - **Cache.** The index comes from the sync server's `listKnowledgeIndex`, 200 pages a request, and is cached per alias in the `KB_INDEX_KV` namespace. The cron rebuilds every graph's index hourly. `create_page`, `update_page`, `delete_page`, `promote_page_to_tag`, `update_tag` and `delete_tag` through the connector mark it dirty, so the next call rebuilds it. A call also rebuilds a cache older than two hours, or one built for another graph under the same alias. Other edits, such as a new summary, show after the next hourly rebuild. The first line of every answer says when the index was built.
- **`get_page_backlinks`** shows how a page, tag or property is used: links in text, objects tagged with it, property values pointing at it (with the property) and other references, each with a complete count and up to `limit` of the most recently updated.
- **`get_graph_health`**, for a weekly review, returns counts and the first items of six checks: `orphan-tags`, `orphan-properties`, `duplicate-titles`, `pages-without-summary`, `pages-without-tags` and `mismatched-choice-values` (values that are not one of their property's own choices, with the property the value's choice belongs to and a `reason`: `another-propertys-choice`, including on a node property, `not-a-choice`, or `out-of-scope` for a choice the holder's tags don't allow; a value cleared to Logseq's empty placeholder is not flagged). `updated-after` narrows the page checks to recent pages, and `checks` with one check plus its `next-cursor` pages through it.
- **One tool per sync-server REST operation**, named after the operation in snake case. At the current `UPSTREAM_REF` that's pages (`list_pages`, `get_page`, `get_page_outline`, `create_page`, `update_page`, `delete_page`, `list_page_blocks`, `list_page_references`, `get_page_backlinks`), blocks (`get_block`, `get_blocks`, `update_block`, `delete_block`, `delete_blocks`, `insert_block_children`, `insert_block_tree`, `batch_insert_block_trees`, `move_blocks`, `batch_move_blocks`), properties (`list_properties`, `get_property`, `create_property`, `update_property`, `delete_property`, `set_block_property`, `delete_block_property`, `batch_set_block_property`, `batch_delete_block_property`), tags (`list_tags`, `get_tag`, `create_tag`, `update_tag`, `delete_tag`, `list_tag_objects`, `promote_page_to_tag`), tasks (`list_tasks`, `create_task`), `capture_to_today`, `refresh_refs`, `search_graph`, `get_graph_health` and `list_assets`. `listKnowledgeIndex` has no tool of its own: `kb_index` uses it. `connector/tools-manifest.json` has the full list.
- **With semantic search on (11.11):** `semantic_search` finds blocks by meaning and by title at once, and `semantic_index_status` says how much of a graph is indexed.
- **Files:**
  - `save_document` saves text (as UTF-8) or base64 bytes, at most 150,000 characters, under a file name whose extension sets the type;
  - `save_file_from_url` downloads a file and saves it. Only `https` on port 443, at most 25 MiB, and only `text/*`, PDF, PNG, JPEG, GIF, WebP, JSON and Office (`application/vnd.openxmlformats-officedocument.*`) files. Private, loopback, link-local and other internal addresses are refused, and each of at most 5 redirects is checked again;
  - both attach the file to a page you name by title or UUID, or to today's journal;
  - `read_file` reads a file back by its asset block UUID: text as text, PNG, JPEG, GIF and WebP images up to 3.75 MiB as images (when the file's first bytes match its extension), anything else as a one-line description.

  Saving and reading back small files works. Whether large files, such as a 25 MiB download or a 3.75 MiB image, stay inside the Workers Free plan's CPU time and memory per request hasn't been measured. If one fails with error 1102, switch to the paid plan (section 8).
- **Flashcards:** Claude tags a block with the `Card` tag, which makes it a flashcard in Logseq's review. Reviews stay in Logseq.

- **Every write says why.** Each tool that isn't a read (every write and delete, `save_document` and `save_file_from_url` included) takes an optional `reason`, a plain sentence of at most 200 characters (a longer one is refused before anything is sent), and `connector_help` asks Claude to fill it. claude.ai shows it with the call's arguments on the approval card. The connector takes it out of the arguments before calling the sync server, so it is never sent to or stored on the graph, and repeats it as the last line of the summary that leads the result (`Reason: tidy duplicate notes`), ahead of the server's answer. The log records only `reason=yes` or `reason=no`.
- **Results name what changed.** Deletes, moves, inserts, `capture_to_today`, `create_task`, `update_block` and the property writes answer the page title, the breadcrumb of parent blocks (up to five) and the first line (up to 80 characters, references shown as titles) of each block they touched, beside its UUID: under `affected` and `target` in the JSON, and as a plain summary line each at the top of the result (`Deleted 2 blocks:` then `- Nov 5th, 2026 > Meeting > Agenda > "Call Sam…" (+3 children)`). A move gives where each block was and is now. A delete names its blocks as they were before it ran, then reads every UUID back: one still there answers 500 under `not-removed`. `delete_block`, `delete_page` and `delete_block_property` now answer 200 with this body instead of an empty 204. If reading the context after a write fails, the write stands and the result says `context: unavailable`. E2EE graphs get UUIDs without titles or text, and the summary says so (`patches/0028-semantic-readable-write-context.patch`).
- **Writes check what they name.** `insert_block_children`, `insert_block_tree`, `update_block`, `delete_block`, `set_block_property`, `delete_block_property` and `move_blocks` (for its `target-id`) take an optional `target-label`, each entry of `batch_insert_block_trees`, `batch_move_blocks`, `batch_set_block_property` and `batch_delete_block_property` takes one, and `delete_blocks` takes `labels`, parallel to `block-ids` (a different length is refused). A label names the target as "Page > parent > … > block", such as `Nov 5th, 2026 > Meeting > Agenda`; a page target takes its title alone. The sync server checks every label in the call inside the write's own transaction, before changing anything: the page title must match in full, ignoring case, and each later segment must start the first line of the target or of one of its parent blocks, ignoring case, with at least 3 characters (or all of a shorter line); upper parent blocks may be left out. Any mismatch refuses the whole call with 409, naming each entry with what was given and what was found, and writes nothing. The label never chooses the target; the UUID or selector does. `target-label` is refused on E2EE graphs (`patches/0028-semantic-readable-write-context.patch`).

**Limits:**

- **Read-only graphs refuse every write tool** before anything reaches the sync server.
- **Results are capped at about 150,000 characters**, claude.ai's limit, and longer results end with a truncation notice. List tools are paginated: Claude passes the returned cursor to get the next page.
- **The sync server's rate limits apply:** 120 reads and 20 writes per minute. A call counts once however much it does, which is why the batch tools matter: `insert_block_tree` writes a whole block tree, with each block's properties, and `batch_insert_block_trees`, `batch_set_block_property`, `delete_blocks`, `batch_move_blocks` and `get_blocks` handle up to 100 items in one call.
- **Choice values must be the property's own.** `set_block_property`, `batch_set_block_property`, `insert_block_tree`, `insert_block_children`, `batch_insert_block_trees` and `capture_to_today` resolve a value of a property with choices (such as Status) only among that property's choices that the block's tags allow, by UUID, ident, title (ignoring case) or number. Anything else, including another property's choice with the same title, is refused with the valid choices listed. `create_task` resolves its `status` and `priority` the same way. A node property given a title takes the page with that title, never another property's choice, and a title several pages share is refused with their UUIDs. A node property limited to tags (its classes, which `create_property` and `update_property` set and `get_property` shows) takes only an object with one of those tags, or with a tag extending one, and refuses a title that only other entities have; since `patches/0026-semantic-property-choices-and-class-restrictions.patch` it also refuses a UUID, ident or db id of anything else (`no #Client object <uuid>`), on every write path. `update_property` changes a property's classes with exactly one of `set`, `add` or `remove` and answers `out_of_class`, the holders whose value the classes would now refuse (a holder left empty isn't counted); a built-in property's classes, such as Assignee's, can't be changed (`classes: Assignee is a built-in property and its classes can't be changed`), as in the app. A value the property doesn't take is refused before anything is written, naming the entry and the property: a page for a text property, a page that isn't a journal for a date property (in a list, every item is checked), a UUID for a text, URL or number property that isn't one of that property's own values (such as a content block or another property's value, which a later delete could have removed from its owner), and anything but epoch milliseconds for a datetime property such as Deadline or Scheduled, or anything but true or false for a checkbox. A number property given a number (`3` or `"3"`) stores that number, even when it matches the db id of another entity, and text that isn't a finite number, such as `"NaN"` or `"Infinity"`, is refused (`patches/0022-semantic-node-values-of-mixed-kinds-read.patch`; before it most of these failed with a server error, and a content block or another property's value was stored). In `batch_set_block_property` and `batch_insert_block_trees`, the tags an earlier entry gives a block or page count for the later entries for it (`patches/0021-semantic-choice-values-scoped-to-property.patch`).
- **Choices are set up in one call.** `create_property` takes `choices` (`[{title, icon?, description?}]`) for a text (`default`), `number` or `url` property and lists them in the order given. `update_property` takes `choices` with any of `add` (new choices, after the existing ones), `update` (a choice's new `title`, `icon` or `description`, named by UUID, ident or title; `icon: null` clears the icon, and a rename keeps the choice's UUID, place and icon; a rename may take a title another rename in the same call gives up, whatever order the entries come in, but renames that pass titles round a cycle, such as a swap, are refused, naming the entry and the cycle, so rename one to a spare title in a separate call first) `order` (every surviving choice exactly once, including one added in the same call, each by the title the call leaves it with: a title a rename frees and an add or another rename takes names the new owner, and a title the call frees and nothing takes still names its old choice) and `retire` (choices to remove). A retire whose choice blocks hold is refused with 409, naming each choice and its holder count, unless the query flag `acknowledge-holders=true` is set; then those blocks lose the value first and no ref to the choice is left. Retiring the choice that is the property's default value is refused the same way (`choices.retire 0: "Backlog" is the property's default value; set acknowledge-holders=true to clear the default, …`, with `default: true` in `retired`), because retiring it clears the default and every block relying on it stops showing it. `dry-run=true` answers what any `update_property` call would store, with `dry-run: true`, and stores nothing; Claude runs a retire that way first and acknowledges only a loss the user agreed to. Built-in choices (Status, Priority) can't be retired, and a choice can't be retired and also updated or ordered in the same call. Only the property's own choices count, so another property's choice with the same title is neither a match nor a duplicate. A title that is already a choice ignoring case (on the property or earlier in the call), a number property's title that isn't a number, a URL property's that isn't a URL, an icon that isn't `{type: "emoji" | "tabler-icon", id}`, choices on any other type (judged on the type the call leaves) and choices on an E2EE graph are refused, naming each entry, and nothing is written. Each new or reordered choice takes a fresh order key after the graph's highest, so it never shares a key with another block, and the whole call is one transaction. The response lists every choice with its UUID in editor order, plus `retired` (`{uuid, title, holders}` for each retired choice, with `default: true` for one that was the default), and the server reads them back, answering 500 if a title or the order didn't land, or a retired choice or a ref to it is still there.
- **Free-text values become choices with `convert_values`.** `update_property` with `convert_values: true` turns a text (`default`) property's free-text values into its choices. Each distinct text is matched, trimmed, to a choice the call leaves (after its `add`, `update` and `retire`): exactly first, then ignoring case, and only among the property's own choices. Every holder then holds that choice (once, on a `many` property, so "Active" and "active" end as one ref) and the old text value blocks are deleted, in the same transaction as the call's other changes. Text that matches no choice refuses the whole call, listing every such text (`convert_values: no choice matches "Paused", "On hold"; add them under choices.add in the same call`), as does a value that is neither text nor a choice, and nothing is written, not even that call's `choices.add`. A text value with child blocks under it is refused, naming its holder and the number of child blocks (`convert_values: <uuid> value "Active" has 2 child blocks; move or delete them first`), because deleting the value would delete them; so is a property with a default value (`convert_values: phase has a default value "Open"; clear it in the app's property settings first`). Holders whose value Logseq cleared to its empty placeholder keep it. `convert_values` on a `number`, `url`, `node` or other property, together with a type change, or on an E2EE graph is refused. The response adds `converted` (`{values, holders}`: text value blocks converted and blocks that held them); with `dry-run=true` it also gives `mapping`, one `{text, choice: {uuid, title}, holders}` row per distinct text. The server reads the holders back and answers 500 if one still points at an old value block or lacks its choice.
- **Tags are set up in one call.** `create_tag` takes `extends` (the tags it extends) and `properties` (its tag properties), and answers with both, as `get_tag` and `update_tag` do. `update_tag` needs no `title`: it takes any of `title`, `extends` (replaces the tags it extends, at least one) and `properties`, which is exactly one of `add` or `remove`, changing only the properties listed and keeping the others, or `set`, replacing the tag's own properties while built-in ones stay; removing a built-in one is refused. Each entry is a tag, or a visible property, by UUID, ident or title, and a tag can't extend itself or a tag that already extends it (`extends 0: Client already extends Organisation through Company`), nor a built-in tag the app hides from its extends picker, such as Tag, Page, Journal, Property, Query or Template (`extends 0: Tag is a built-in tag that other tags can't extend`). Every entry is checked before anything is written, the call is one transaction, and the tag is read back (`patches/0026-semantic-property-choices-and-class-restrictions.patch`). `update_tag` also takes the tag's ident in place of its UUID.
- **A page becomes a tag in place.** `promote_page_to_tag` takes `page-id` (a UUID, or a title or journal date as every `page-id` does) and optionally `extends` (tag UUIDs, idents or titles) and the query flag `dry-run=true`. The page keeps its UUID, blocks, properties and references, gains the Tag class and loses Page, so it appears under Tags and `#Name` tags a new block. Existing links to it stay links; they aren't turned into tags. Use it instead of `create_tag` plus moving the page's blocks, and never set a page's `tags` to Tag. The answer is the tag as `get_tag` shows it, plus `promoted` (`{blocks, references}`). Run it with `dry-run=true` first on a page with many references: it runs every check and the conversion, answers the same body with `dry-run: true`, but without `ident`, because the real call generates the tag's ident afresh (with a random suffix), and writes nothing. It refuses journals, built-in pages, properties, namespaced pages, whiteboards, assets, blocks that aren't pages, pages in the Recycle bin, pages that are already tags (409) and a title a tag already holds (409, naming that tag). `extends` follows the rules of `create_tag`, so a built-in tag such as Tag or Page and the page itself (`extends 0: Recipe can't extend itself`) are refused. All refusals are reported together, nothing is written when any applies, and the write is one transaction that is read back (500 if it didn't land). It isn't available on an E2EE graph. After promotion use `get_tag`, `list_tags` and `list_tag_objects`; `get_page` no longer reads it and it leaves `kb_index`, as for any tag. When `create_tag` is refused because a promotable page has the title, the 409 names the page and says to call `promote_page_to_tag` with its UUID. Setting a page's `tags` to Tag (`set_block_property`, `batch_set_block_property` or an insert's `properties`) is refused with 400 `Tags: Tag marks a page as a tag and can't be set as a value; use promote_page_to_tag on page <uuid>`, but sending Tag back to something that is already a tag succeeds and changes nothing. A write that replaces tags (`set_block_property` with a list, or `batch_set_block_property` with `isResetExistingValues`) keeps the built-in type tags the entity holds (Page on a page, Tag on a tag, Journal on a journal, Property on a property, Asset on an asset) and removes only the user tags the list leaves out, as the app's tag editor does: a page given `["Food"]` is a page tagged Food, and `[]` clears its user tags. These writes used to answer 500 (`Can't remove private tags`, `This page cannot be converted to a block`, `Can't remove tag with built-in #Tag`). `update_page` ignores a `tags` field (`patches/0027-semantic-promote-page-to-tag.patch`).
- **Headings are stored the app's way.** `update_block`, `insert_block_tree`, `insert_block_children`, `batch_insert_block_trees`, `capture_to_today` and `create_task` read a title that starts with `#` to `######` and whitespace (`## Section`) as a heading: the title is stored without the prefix and the level goes in `logseq.property/heading`, which `get_block` and `get_blocks` show as a property and `get_page_outline` shows as the `## ` prefix (`list_page_blocks` titles don't show it). `update_block` with a title that has no prefix keeps the block's heading. A code, math or quote block (one with a display type) keeps its title as given, `#` lines included, with no heading: `update_block` and `refresh_refs` leave a `# comment` line alone. Seven or more `#`, or `#` with nothing after it, is not a heading and is stored as text with the first `#` escaped. Before `patches/0024-semantic-markdown-heading-prefix-to-property.patch`, `update_block` dropped the prefix and the level, and the inserts kept the prefix as text.
- **Insert tools don't echo titles.** The connector defaults `verbose` to false on `insert_block_tree`, `insert_block_children`, `capture_to_today` and `batch_insert_block_trees`, so their results are the new blocks' UUIDs and a count rather than an echo of the titles Claude just sent, plus the target and each new top-level block named by page, breadcrumb and snippet. Claude passes `verbose: true` when it wants every title back.
- **Today is the owner's date.** `capture_to_today`, `create_task` with no `page-id`, and `save_document` and `save_file_from_url` with no `page` write to today's journal, where today is the date in `timeZone` from `config/settings.json` (an IANA zone, `Pacific/Auckland` here). The deploy sets it as the sync Worker's `TIMEZONE` variable and refuses a zone it doesn't know. Without it, today is the UTC date, because Workers run in UTC. Each of these results names the page it wrote to: `page-id` and `page-title` (such as `Nov 6th, 2026`), or `pageId` and `pageTitle` for the file tools. `capture_to_today` takes no page: to write to another day's journal, use `insert_block_tree` with that journal as `target-id`, `create_task` with `page-id`, or the file tools with `page`. `delete_page` uses the same date: on today's journal it deletes the blocks and keeps the page, as the app does, and any other journal moves to the Recycle bin with its blocks.

### 11.9 Security model

- **Owner only.** Both the MCP sign-in and the `/graphs` wizard accept only the GitHub user ID in `OWNER_GITHUB_USER_ID`. Any other account is refused before a grant or session is created. The ID is checked again on every MCP request, so changing `OWNER_GITHUB_USER_ID` and redeploying revokes the existing grants. OAuth codes go only to claude.ai's callback (`https://claude.ai/api/mcp/auth_callback`) or to loopback addresses (`localhost`, `127.0.0.1`).
- **Tokens are encrypted.** Each PAT is stored in the connector's D1 database with AES-GCM under `GRAPH_TOKEN_KEY`. No tool returns a token, and the wizard never shows one again. Treat `GRAPH_TOKEN_KEY` like the tokens themselves.
- **Only unencrypted graphs.** The wizard refuses end-to-end encrypted graphs. Everything in section 3 about unencrypted graphs applies, and the connector is one more piece of deployed code that can read them.
- **Narrow access per graph.** Connect a graph read-only, with a `read` token, when Claude only needs to read it.
- **Logs** hold the tool name, graph alias, status and duration only: never arguments, results, tokens or hostnames. A write's line also says `reason=yes` or `reason=no`, never the reason's text, which may quote private notes. The hourly `kb_index` rebuild logs one line per graph, such as `kb-index graph=work status=ok pages=812 ms=1530`. Workers Logs (observability, on for the connector) also record each request's URL and metadata, privately in your Cloudflare dashboard.
- **The `kb_index` cache holds page content.** `KB_INDEX_KV` stores each graph's page titles, tags, summaries and UUIDs, unencrypted like the graph itself, for up to 7 days after the last rebuild. Pages tagged `private` are never fetched. Disconnecting a graph doesn't delete its cache entry; it expires.
- **Not backed up.** `backup.yml` doesn't back up the connector's D1 database or the `kb_index` cache, which is rebuilt from the graphs. It holds only aliases, graph IDs, modes and encrypted tokens, and tokens can be re-issued in Logseq. D1 Time Travel covers accidents.
- **Key rotation** (section 9): rotating `GRAPH_TOKEN_KEY` makes every stored token unreadable, so you must replace the token for each graph. Rotating `COOKIE_ENCRYPTION_KEY` signs you out of the wizard.
- **Firewall rules.** If you put WAF, rate-limiting or bot rules in front of the connector's hostname, allow Anthropic's egress range `160.79.104.0/21`. claude.ai and Claude Code cloud sessions reach the connector from there.

### 11.10 Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `token for graph 'x' expired or lacks permission — reconnect it at https://mcp.example.com/graphs` | The sync server answered 401 or 403: the token expired, was revoked, or its permission doesn't cover the call. Create a new token in Logseq and use **Replace token** at `/graphs`. |
| `rate limited — retry after N s` | The sync server's limit of 120 reads or 20 writes per minute. Wait, and batch writes with `insert_block_tree` and the other batch tools. |
| `graph 'x' is read-only` | The graph is connected read-only. Switch it to read-write under **Edit** at `/graphs`. That needs a `both` token: if its token is `read`, replace it with a `both` token first. |
| `unknown graph 'x' — call list_graphs for the connected aliases` | No graph is connected under that alias: it was renamed or disconnected, or never connected. Check `/graphs`. |
| Every tool fails for every graph after rotating `GRAPH_TOKEN_KEY` | The stored tokens can't be decrypted any more. Replace each graph's token at `/graphs` (11.7). |
| GitHub shows "The `redirect_uri` is not associated with this application" | The OAuth app's **Authorization callback URL** isn't `https://<CONNECTOR_HOSTNAME>/callback`. Fix it in the app's settings on GitHub (11.2); nothing needs redeploying. |
| `421 Misdirected request` | The request reached the connector on a hostname other than `CONNECTOR_HOSTNAME`. Use exactly `https://<CONNECTOR_HOSTNAME>/mcp`, and check that the secret matches the custom domain. |
| `500 Server misconfigured` | A connector secret is missing or malformed. The Worker log says which: `connector misconfigured: invalid connector secrets: …`. `CONNECTOR_HOSTNAME` must be lowercase, the two keys must be 64 hex characters and `OWNER_GITHUB_USER_ID` must be a positive integer (no leading zeros). Fix the secret and redeploy. |
| "This GitHub account is not allowed to use this connector." | You signed in with another GitHub account, or `OWNER_GITHUB_USER_ID` is wrong. Check it with `gh api user -q .id`. |
| Smoke test `FAIL oauth-metadata: 000` | The custom domain's certificate is still being issued after the first deploy. Wait a few minutes and re-run `scripts/smoke-connector.sh https://mcp.example.com`. |
| Smoke test `FAIL oauth-metadata` with `421`, `500` or `resource` | `421` or `resource`: the URL you tested isn't `CONNECTOR_HOSTNAME`. `500`: see "Server misconfigured" above. |
| Deploy fails with `GITHUB_CLIENT_ID: parameter null or not set` (or another connector name) | The connector is enabled but a secret is missing from the `production` environment. If the name is missing from `.env.local` too, `scripts/init-env.sh --add-missing --push` adds and pushes it. Otherwise push it with the 1.8 loop: `--add-missing` only pushes names it adds. Remember the `CONNECTOR_GITHUB_*` names. |
| Creating `cloudflare_workers_kv_namespace.connector_oauth` fails with an authentication or permission error | The Cloudflare token lacks **Workers KV Storage** Write + Read (11.3). |
| `tofu apply` fails with `Instance cannot be destroyed` for the connector's KV namespace or D1 database | OpenTofu ran with the connector off while its resources exist. If you meant it to be on, set the `CONNECTOR_ENABLED` variable (Actions) or `CONNECTOR_ENABLED=true` in `.env.local` and `TF_VAR_connector_enabled` (local, 1.4), and re-run. To turn it off, follow "Turning it off" in 11.5. |
| The cron run fails with `kb index refresh failed for N of M graphs` | The `kb-index graph=… status=…` lines before it name the graph: `http-401` or `http-403` means its token expired (replace it at `/graphs`). The other graphs were still rebuilt. |
| `kb_index` answers `the knowledge index of 'x' has more than 20000 pages` | The connector refuses to cache a graph that large. Use `search_graph` and `list_pages` instead. |
| Deploy fails at **Read connector setting** with `The CONNECTOR_ENABLED variable must be true or false` | The variable holds something else, such as `True` or `yes`. Set it to exactly `true` or `false`, or delete it for off. |
| `409` from `create_tag`: `… to make page "X" a tag keeping its blocks and references, call promote_page_to_tag with page-id <uuid>` | A page already has the title. Call `promote_page_to_tag` with that UUID (with `dry-run=true` first) instead of creating a second item. No hint means the page can't be promoted (a built-in, a namespaced page, or a tag holds the title too). |
| `409`: `target-label "…" does not match target "…"` (or `entry N: …`) | The label given for the target doesn't fit the block or page the call names, which is read from the graph. Nothing was written. Check the call names the block you meant, then give its label as the message's "found" text shows it. |
| `400` with `Tags: Tag marks a page as a tag and can't be set as a value` | A write tried to set `tags` to Tag on a page, which used to answer 500. Use `promote_page_to_tag` on the page. |
| `can't become a tag: …` or `already a tag` from `promote_page_to_tag` | The page is a journal, built-in, property, namespaced page, Recycle-bin page or already a tag, or a tag holds its title. Nothing was written. The message names the reason and, for a title clash, the tag; rename one of them first. |
| `property value must resolve to one of X's choices (…)` | The value isn't one of that property's own choices, or the block's tags don't allow it (the message then says `for this block`). Use one of the listed choices, or its UUID from `get_property`. Before patch 0021 the same title could store another property's choice without an error; `get_graph_health` with `checks: mismatched-choice-values` lists values stored that way. |
| `"X" matches N entities (…)` | A node property was given a title that several pages share. Pass the UUID of the page you mean, from the list in the message. |
| `entry N: P: "<value>" should be a text block` (or `a journal date`, `a number`, `a finite number`, `a datetime`, `a boolean`) | The value is something property P's type doesn't take, such as a page for a text property, a date string for Deadline, or `"NaN"` or `"Infinity"` for a number property. Give text for a text property (or make P a node property to link a page), a journal page for a date property, a finite number for a number property, and epoch milliseconds for a datetime property. The insert tools say `blocks[0]: P: …` instead of `entry N: P: …`. |
| `entry N: P: "<uuid>" is not a value of P` | A text, URL or number property was given the UUID of a block that isn't one of P's own values, such as a content block or another property's value. Give the text, URL or number itself, or link the block in the block's text. |
| `get_block`, `get_blocks` or `get_page_outline` fail with a server error on a block whose node property holds several values | Fixed by patch 0022: a value set that mixed plain or journal pages with blocks, or with pages under the Library or a namespace, failed every read that shows properties. Deploy it; the stored values were never wrong. |
| `409` from `update_property`: `choices.retire N: "X" is held by M blocks; set acknowledge-holders=true …` | The choice is in use, or is the property's default value. Nothing was written. Run the call with `dry-run=true` to see the holders, then repeat it with `acknowledge-holders=true` only if losing the value from those blocks is intended. |
| `400` from `update_property`: `convert_values: no choice matches "A", "B"` | Some free-text values match none of the property's choices, even ignoring case. Nothing was written. Add those texts under `choices.add` in the same call, or edit the values, then repeat. |
| `400` with `the renames form a cycle` from `update_property` | Two or more `choices.update` renames pass titles round a loop, such as a swap. Rename one choice to a spare title in a separate call first. |

### 11.11 Semantic search (optional)

`search_graph` only matches the exact words of a title. Semantic search adds `semantic_search`, which also finds blocks by meaning ("what did we decide about pricing?"), and `semantic_index_status`. The design, with its sources and limits, is `docs/superpowers/specs/2026-11-04-semantic-search-design.md`.

- **How it works.** A second cron trigger on the connector runs every minute, next to the hourly `kb_index` one. Each run reads up to two pages of 50 changed blocks from the sync server (`listBlockChanges`, patch 0014), embeds each block as `page title > breadcrumb > block text` with Workers AI (`@cf/baai/bge-small-en-v1.5`, 384 dimensions), and stores the vectors in a Vectorize index, one namespace per graph. Only blocks whose text changed are embedded again. `semantic_search` embeds the question, takes the nearest blocks, runs `search_graph` with the same words, and merges the two lists by reciprocal rank fusion.
- **Private blocks stay out.** A block tagged `private` (any case), or under a block or page tagged `private`, is never embedded, and is removed from the index when it gets the tag. Encrypted graphs are never indexed. Block text, page titles, breadcrumbs and tags are stored in the connector's D1 database and Vectorize, in your account; disconnecting a graph deletes them on the next runs.
- **It's off until you turn it on.** Without the `AI` and `VECTORIZE` bindings the connector has no semantic tools and no indexer cron (the hourly `kb_index` cron runs either way).
- **Size and cost.** Building the index of a 13,000-block graph takes about two hours; changes after that show up within a minute or two. On Workers Free the index holds at most 13,000 blocks (`connector.semanticSearch.maxVectors` in `config/settings.json`); beyond that `semantic_index_status` says `full`. On Workers Paid, raise `maxVectors` (a 50,000-block graph costs under $0.01/month in Vectorize storage; embedding stays inside the free 10,000 neurons a day). Verified on Free with a 5,363-block graph: the build ran at about 100 blocks a minute and used about 1,700 Workers AI neurons in total, and its cron runs used 33–65 ms CPU, which Cloudflare didn't reject (as with the sync Worker, see Costs). Once built, an idle run reads about 10 D1 rows; watch the daily allowances with the usage report ([Watching your usage](#watching-your-usage)).

To turn it on, with the connector already on (11.5):

1. Add **Vectorize** Write + Read to the Cloudflare token's account policy (1.1).
2. Set the variable and deploy:

   ```bash
   gh variable set SEMANTIC_SEARCH_ENABLED --env production --body true
   gh workflow run deploy.yml
   ```

   Also set `SEMANTIC_SEARCH_ENABLED=true` in `.env.local` for local connector deploys. The deploy creates the Vectorize index named in `connector.semanticSearch.vectorizeIndexName` (384 dimensions, cosine) if it doesn't exist, and fails if an index with that name has another shape. OpenTofu can't manage it: the Cloudflare provider has no Vectorize resource.
3. In claude.ai, call `semantic_index_status` for a graph until it says `ready`.

**Turning it off.** Set the variable to `false` and deploy: the tools and the every-minute indexer cron go away. The index and the `semantic_blocks` and `semantic_state` rows stay; delete them with `npx wrangler vectorize delete logseq-connector-blocks` and `npx wrangler d1 execute logseq-connector --remote --command "DELETE FROM semantic_blocks; DELETE FROM semantic_state;"`.

| Symptom | Cause and fix |
|---|---|
| `semantic_index_status` says `full` | The index holds `maxVectors` blocks. On Workers Paid, raise `connector.semanticSearch.maxVectors`; on Free, tag pages you don't need searched `private`. |
| Status `error` with `Workers AI embedding failed` | Usually the free 10,000 neurons a day are used up. It resumes after midnight UTC. |
| Status `error` with `token for graph ... expired` | Replace the graph's token (11.7). |
| Deploy fails with `Vectorize index ... has N dimensions` | An index with that name was created with another shape. Delete it (`npx wrangler vectorize delete logseq-connector-blocks`), delete the `semantic_*` rows, and deploy again. |
| Deploy fails with `reading Vectorize index ... Authentication error` | The token lacks Vectorize Write + Read (step 1). |

## Backlog

1. **A publish server** at `publish.example.com`. Mobile has no publish URL setting, and rendered pages load from `asset.logseq.com` and jsdelivr.
2. **Finish checking the connector** and record the results in `docs/spike-results.md`: that a second GitHub account is refused, whether annotations change claude.ai's prompting, and the file tools' CPU time on large inputs.
3. **An upstream PR** making the PAT groups configurable, so the patch can be dropped.
4. **An off-account backup copy.**
5. **A client-side decryption MCP** for E2EE graphs, so agents can work with encrypted graphs.
6. **Confirm the minimal token permissions**, in particular whether DNS Write is needed.
7. **Measure a large real graph against the Free CPU limits:** first upload, asset sync and snapshot download.
8. **Scope Tags titles the same way.** A `Tags` value given by title still takes the first class with that title. Duplicate class titles are rare, but it is the pattern patch 0021 fixed for choices and node properties.
9. **Bare integers read as db ids.** `resolve-ref-entity` still reads a JSON integer given to a node, date or other ref property as a db id, so `about: 230` sets whatever entity has db id 230 if the type check accepts it. Patch 0022 closed this for number properties only.
10. **Escaping of unknown `#words` in code and math blocks.** `update_block` and `refresh_refs` still escape an unknown `#word` inside a code or math block's text (`echo #Unknownword` becomes `echo \#Unknownword`), and `refresh_refs` doesn't skip display-typed blocks. It predates patch 0024 and is the inline-tag class, not headings.
11. **Heading level in block lists.** `list_page_blocks` and the insert tools' responses (`block-response`) carry no heading level. `get_block`, `get_blocks` and `get_page_outline` show it. Adding a field changes a response schema shared by many operations.
12. **Page titles on task reads.** `capture_to_today`, `create_task` and the file tools name the journal they wrote to, but `list_tasks` and `get_block` still return only the page id. A response schema change shared by several operations.
13. **Fixed-offset time zones.** `timeZone` accepts `+13:00` as well as an IANA name because `Intl` does, but a fixed offset ignores daylight saving. Refuse it in `render-wrangler` and the server if it causes a mistake.
14. **Move holders when retiring a choice.** Retiring a choice with holders clears the value from them. A `replace-with` option would move them to another choice in the same transaction. Today, convert by hand and then retire.
15. **Titles of entities created in the same batch.** A node property in `batch_insert_block_trees` can't yet name, by title, a page created earlier in the same call.

## Licence and credits

Licensed under **AGPL-3.0-or-later** (see `LICENSE`). The patch is derived from Logseq's AGPL code.

- **[Logseq](https://github.com/logseq/logseq)** wrote the sync server, the clients and the REST API skill vendored in `skills/logseq-rest-api/`. This repo only builds, patches and deploys upstream code.
- **[yshalsager/logseq-selfhost](https://github.com/yshalsager/logseq-selfhost)** had the idea of a pinned upstream ref with a weekly bump. It covers the Docker/Node self-host route. No code was copied from it.
