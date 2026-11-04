# Semantic search for the connector — design

Date: 2026-11-04
Owner: C0ntr0lledCha0s
Issue: #2 (add `semantic_search` tool: Workers AI + Vectorize, hybrid with keyword search)

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them.

## 1. Intent

Logseq's built-in semantic search runs on the device only, so the connector can't use it. Claude, working through the connector, only has `search_graph`, a case-insensitive substring match on titles. A question such as "what did we decide about the release date?" finds nothing unless those exact words appear in a block.

The connector gets:

- **`semantic_search(graph, q, limit?, tag?)`**: embeds the query, finds the nearest blocks in a Vectorize index, runs `search_graph` with the same query, and merges the two rankings by reciprocal rank fusion (RRF) **(issue)**;
- **`semantic_index_status(graph)`**: what the index holds for a graph and how far the build is;
- **an indexer** on a cron trigger that keeps the index in step with the graph, re-embedding only the blocks whose text changed **(issue)**.

All of it is inert until the owner turns it on (section 9).

## 2. Verified facts this design relies on

Checked on 2026-11-04 against Cloudflare's docs.

| Fact | Source |
|---|---|
| Workers AI: 10,000 neurons/day free on **both** Free and Paid; $0.011 per 1,000 neurons above that (Paid only). | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Embedding prices per 1M input tokens: `bge-small-en-v1.5` 1,841 neurons ($0.020); `bge-base-en-v1.5` 6,058 ($0.067); `bge-large-en-v1.5` 18,582 ($0.204); `bge-m3` 1,075 ($0.012); `qwen3-embedding-0.6b` 1,075 ($0.012). | same |
| `bge-small-en-v1.5`: 384 dimensions, 512 input tokens, `text` is a string or an array of strings. | [model page](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/) |
| Vectorize Free: 5M **stored** dimensions, 30M queried dimensions/month, 100 indexes. Paid: 10M stored included then $0.05 per 100M; 50M queried/month included then $0.01 per 1M. Queried dimensions = (vectors in the index + queries) × dimensions. | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Vectorize limits: 1,536 dimensions max; IDs ≤ 64 bytes; namespaces ≤ 64 bytes (1,000 per index on Free); topK ≤ 100 without values/metadata (50 with); upsert ≤ 1,000 vectors per call from a Worker; mutations are asynchronous (seconds). | [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/), [client API](https://developers.cloudflare.com/vectorize/reference/client-api/) |
| Metadata filters cover string/number/boolean values only; array membership (a block's tags) is not documented. | [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) |
| Workers Free: 10 ms CPU per HTTP request **and per cron trigger**, 50 subrequests per invocation, 5 cron triggers per account, 100,000 requests/day. Paid: 30 s CPU for a cron under an hour's interval, 10,000 subrequests. Cron wall clock: 15 min on both. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Queues are on Workers Free (10,000 operations/day, 24 h retention) and Paid (1M/month included, $0.40/M). | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| The OpenTofu Cloudflare provider in use (5.28.1) has no Vectorize index resource; `wrangler vectorize create` makes one. | provider binary, wrangler docs |
| The sync server's semantic API rate limit is per token, operation and graph (120 reads/min). | `deps/db-sync/src/logseq/db_sync/worker/dispatch.cljs` |

Not verified: whether Workers AI and Vectorize binding calls count against the 50-subrequest limit (the docs name fetch, R2, KV and D1). The indexer assumes they do (section 6).

## 3. Can the existing API feed an index?

No, not efficiently or correctly:

- **No block-level change list.** `updated-after` exists on `listPages`, `listTags`, `listTagObjects`, `listProperties`, `listAssets`, `listTasks` and `searchGraph`, but not on blocks across a graph. `searchGraph` needs a substring `q`. Walking every page with `listPageBlocks` takes 5,000+ calls at 120 reads/min, about 40 minutes per pass.
- **Timestamps are client clocks.** `:block/updated-at` is written by whichever device made the change, so `updated-after` against the server's clock misses edits from a device whose clock is behind.
- **The indexed text changes without the block changing.** The text is `page title > breadcrumb > block text`, with `[[references]]` shown as titles. Renaming a page, an ancestor or a referenced page changes it, but not the block's `updated-at`.
- **Deletions leave nothing.** Logseq retracts deleted blocks; there are no tombstones to list.

The sync server does have an exact change log: the tx log behind client sync, one row per transaction with a monotonic `t`. So **`patches/0014-semantic-block-changes-feed.patch`** adds one read operation:

```
GET /api/v1/graphs/{graph-id}/block-changes?limit&cursor[&since&epoch]   (listBlockChanges, logseq/read)
→ { epoch, t, blocks: [{uuid, page-id, page-title, breadcrumb[], text, tags[], updated-at}], removed: [uuid], next-cursor? }
```

- **Without `since`**: every content block in UUID order, paged by UUID cursor (`d/index-range` on `:block/uuid`, so a page costs O(limit)). Content block: not a page, tag, property or asset; not a property value; not hidden or in the recycle bin; non-blank text.
- **With `since=t` and `epoch`**: the server reads the tx log after `t`, collects the touched entities and expands them: a change to a title, parent, page, tags, hide or delete flag reaches the entity's whole subtree (a page's: all its blocks); a title change also reaches the blocks that reference or are tagged with the entity. Touched UUIDs that are not content blocks now come back in `removed`. The list is sorted by UUID and paged the same way.
- **`text`** shows references as titles (`db-content/recur-replace-uuid-in-block-title`, as `getPageOutline` does). **`tags`** are the titles of the tags on the block, its ancestors and its page, so a `#private` page hides all its blocks.
- **`epoch`** is a random UUID kept in `sync_meta`. A snapshot re-upload or reset clears `sync_meta` and restarts `t`, so the next request with the old epoch, or a `since` ahead of `t`, answers **410**: list again without `since`. More than 5,000 transactions or 20,000 changed UUIDs since `t` also answer 410, because a full listing is cheaper.
- **E2EE graphs answer 409.** Their titles are ciphertext **(issue)**. The connector already refuses to connect E2EE graphs.

Tests: `deps/db-sync/test/logseq/db_sync/semantic_block_changes_test.cljs` (8 tests through `sync-handler/handle-http`). The connector excludes the operation from its generated tools (`EXCLUDED_OPERATIONS`): it's a feed for the indexer, not something Claude needs.

## 4. Data flow

```
cron (every minute) ─▶ connector.scheduled()
   ├─ D1 graphs ──────────────▶ each connected graph (alias, graph-id, PAT)
   ├─ SYNC.fetch block-changes ▶ page of ≤50 changed blocks + removed UUIDs
   ├─ filter: tag "private" (any case, inherited) → delete; blank → skipped by server
   ├─ D1 semantic_blocks ──────▶ stored hash per block → keep only blocks whose text changed
   ├─ AI.run(bge-small, texts) ─▶ 384-d vectors
   ├─ VECTORIZE.upsert(namespace = graph-id) / deleteByIds
   └─ D1 batch: rows + cursor (one write per changed block)

semantic_search(graph, q) ─┬─ AI.run(q) → VECTORIZE.query(topK 50, namespace) → D1 rows
                           └─ SYNC.fetch searchGraph(q, types=blocks,pages, limit 50)
                           → RRF (k = 60) → top `limit` with page, breadcrumb, text and which side found it
```

**Document text (call):** `Page title > ancestor > … > block text`, each ancestor cut to 120 characters and the whole cut to 1,500 characters (under the model's 512 tokens).

**Vector IDs (call):** the first 24 bytes of SHA-256(`graph-id:block-uuid`), base64url (32 characters). The issue asks for vectors keyed by block UUID; an ID derived from it, scoped by graph, avoids a clash when two graphs share block UUIDs (imports copy them), and needs no D1 round trip before an upsert. The namespace is the graph ID, so a query only sees its graph. D1 maps vector IDs back to blocks.

**Change detection (call):** the connector stores SHA-256 of each document. A block re-sent by the feed with unchanged text is not re-embedded; if only its tags or page changed, its row is rewritten without an embedding call. This is what makes acceptance (2) hold even when the server over-reports (an edit to a parent re-sends its children, whose breadcrumb did change, but a tag change on an ancestor re-sends text that did not).

**Deletes:** incremental pages carry `removed`. A full listing is in UUID order, so each page covers a UUID range; stored rows in that range that the page didn't return are stale and deleted. A disconnected graph's rows and vectors are deleted by the next runs.

## 5. Bindings and storage

| Binding | What | Provisioning |
|---|---|---|
| `AI` | Workers AI, `@cf/baai/bge-small-en-v1.5` | none (binding only) |
| `VECTORIZE` | index `logseq-connector-blocks`, 384 dimensions, cosine | by the deploy, `scripts/ensure-vectorize-index.mjs` (no OpenTofu resource) |
| `DB` (existing) | migration `0002_semantic.sql`: `semantic_blocks`, `semantic_state` | applied by the existing deploy |
| `SEMANTIC_MAX_VECTORS` (var) | cap on stored vectors, from `settings.connector.semanticSearch.maxVectors` | committed setting |
| cron `* * * * *` | the indexer | rendered |

No KV and no Queue **(call)**. The cursor and per-block hashes live in the connector's D1, next to the graphs. A Queue would spread work across invocations, but the cron already does that with a cursor in D1, and a Queue adds a resource to provision and a consumer to keep within limits for no gain at one user's scale.

**Model (call): `bge-small-en-v1.5`, 384 dimensions, cosine.** Storage is the binding constraint on Free: 5M stored dimensions is 13,020 vectors at 384 dimensions but only 6,510 at 768 (`bge-base`) and 4,882 at 1,024 (`bge-m3`, `qwen3-embedding`). It also fits a 50k-block build in one day's free neurons (section 7). `bge-m3` is cheaper per token and multilingual; switch to it if the graphs aren't English, on Paid. The model and dimensions are constants in `connector/src/semantic/config.ts`; changing them means a new index and a full rebuild.

## 6. Refresh within the limits

One cron invocation, every minute:

1. Delete up to 500 vectors and rows of disconnected graphs, if any.
2. For each graph, least recently indexed first: take a lease on its `semantic_state` row (one `UPDATE … RETURNING`, so overlapping runs never index the same graph), then read up to **2 feed pages of 50 blocks** in total across graphs.
3. Per page: feed (1), D1 reads (1), embed (1), Vectorize upsert (1), Vectorize delete (1), D1 batch write (1). Six subrequests; a run stays under 30 of the Free plan's 50, counting binding calls as subrequests.
4. A page's results are committed with its cursor in one D1 batch, after Vectorize accepted the vectors. A failure anywhere leaves the cursor where it was, and the next run repeats the page (hashes make that cheap).

CPU on Free is 10 ms per invocation. The expensive part is moving 384 floats per block through JSON twice (AI response, Vectorize request): about 20k numbers per 50-block page. Two pages per run is the estimate that fits; it is *(not yet verified)* on a real account. An idle run (nothing changed) is three D1 queries and one feed call per graph.

**Initial build time:** 100 blocks a minute, so a 13,000-block Free index takes about 2¼ hours and a 50,000-block Paid index about 8½ hours. Raising `PAGES_PER_RUN` on Paid shortens it.

**The cap:** before writing a page the indexer checks `stored − deleted + new ≤ SEMANTIC_MAX_VECTORS`. If not, the graph's status becomes `full` and its indexing stops at that page until the cap is raised or rows are freed. The committed default, 13,000, fits the Free plan's 5M stored dimensions (13,000 × 384 = 4.99M).

## 7. Cost for ~5,000 pages / ~50,000 blocks

Assumption: an average document (page title, breadcrumb, block text) of 40 tokens; double it if the graph has long blocks.

| Item | Free plan | Paid plan ($5/month base) |
|---|---|---|
| Initial embedding: 50k × 40 = 2M tokens × 1,841 neurons/M | 3,700 neurons: inside 10,000/day, $0 — but only 13,000 blocks fit the index (below) | 3,700 neurons, $0 |
| Ongoing embedding: ~500 changed blocks/day + ~50 queries/day | ~40 neurons/day, $0 | $0 |
| Vectorize storage: 50k × 384 = 19.2M dimensions | **over the 5M cap**: index at most ~13,000 blocks | 9.2M over the 10M included: **$0.005/month** |
| Vectorize queries: (50k + 1,500 queries) × 384 = 19.8M/month | n/a at 50k (13k: 5.6M, inside 30M) | inside 50M, $0 |
| D1: ~100k row writes for the initial build (row + unique index), ~50k reads per full re-listing, ~20 MB | 100k writes/day is the whole Free allowance: the build of a capped 13k index uses ~26k | inside Paid allowances |
| Cron invocations: 1,440/day + one feed call per graph per minute | 1.5% of 100k requests/day per graph | $0 |

**Bottom line:** on Workers Free, semantic search works for graphs up to about 13,000 indexed blocks at $0. A 50,000-block graph needs Workers Paid, where semantic search adds well under $0.01/month to the $5 base.

## 8. Privacy

- **`private` tags (issue).** A block is skipped when it, an ancestor or its page carries a tag titled `private` in any case. The feed returns the tag titles; the connector applies the rule, so the policy lives in one place. A block that becomes private is deleted from the index on the next run (the tag change expands to the subtree on the server).
- **E2EE graphs (issue)** are refused at connect time and the feed answers 409; the indexer records `skipped-e2ee` and never embeds.
- **Where content goes.** Block text goes to Workers AI (Cloudflare does not train on it) and stays in Vectorize and the connector's D1 (page title, breadcrumb, text, tags), all in the owner's account. Disconnecting a graph deletes its rows and vectors. Logs stay as they are: tool name, alias, status, duration.
- **Keyword hits** in `semantic_search` are exactly what `search_graph` returns, which Claude can already call; the private filter governs what is embedded and stored.

## 9. Turning it on, and staying inert until then

- **Code path:** the tools and the cron exist only when the Worker has `AI`, `VECTORIZE` and `SEMANTIC_MAX_VECTORS`. None of them → no semantic tools, and `scheduled` is never triggered (no cron is rendered). Some but not all → `500 Server misconfigured` on every request, like a missing secret.
- **Switch:** `SEMANTIC_SEARCH_ENABLED`, a GitHub variable like `CONNECTOR_ENABLED`. `true` needs `CONNECTOR_ENABLED=true`; unset or `false` is off; anything else fails the deploy. When on, `scripts/render-connector-wrangler.mjs` adds the two bindings, the cron and the cap.

What the owner provisions, once (README 11.11):

1. Add **Vectorize** Write + Read to the Cloudflare API token's account policy.
2. On a graph over ~13,000 blocks: subscribe to Workers Paid and raise `connector.semanticSearch.maxVectors` in `config/settings.json`.
3. `gh variable set SEMANTIC_SEARCH_ENABLED --env production --body true`, then run the deploy. It creates the index (384 dimensions, cosine) when it doesn't exist and fails on one with another shape.

## 10. Failure modes

| Failure | Behaviour |
|---|---|
| Token expired or revoked (401/403) | Graph status `error` with the reconnect hint; other graphs carry on; retried every run. |
| Rate limited (429) | The run stops for that graph; next minute retries. |
| Daily neurons exhausted (Free) / AI error | Status `error`, cursor not advanced; resumes after the daily reset. |
| Index cap reached | Status `full`; nothing new is inserted until the cap is raised. |
| Graph re-uploaded or reset, or far behind | Feed 410 → a full listing; hashes keep re-embedding to changed blocks only. |
| Vectorize index with the wrong dimensions | The run throws before embedding (`describe()` check); `semantic_index_status` shows it. |
| Vectorize mutation still in flight | A query may return a just-deleted vector; its D1 row is gone, so it's dropped from results. |
| Two runs overlap | The lease on `semantic_state` (50 s, under the cron interval) keeps them on different graphs. Writes are idempotent, so an expired lease costs only repeated work. |
| Connector turned off after use | The bindings and cron go away; D1 rows and the index stay until deleted by hand (README). |

## 11. Evaluation (acceptance 3)

`connector/test/fixtures/semantic-eval.json` is a small graph (6 pages, 23 blocks across work, family, holidays, reading and a private page) with 10 questions phrased the way a person asks, each with the blocks that answer it. `connector/test/semantic-eval.test.ts` indexes it with the real indexer against fakes, runs each question through keyword-only (`search_graph` semantics: the whole query as a case-insensitive substring of a title) and through `semantic_search`, and reports recall@5 and MRR. The embedder is a deterministic fake: hashed bag of words with a small synonym table, normalised to 384 dimensions. It stands in for a real model's main property — related words land near each other — so the test shows the merge and the pipeline are right, not how good `bge-small` is. The test asserts that hybrid beats keyword-only on both metrics, that hybrid never loses a hit keyword search had, and that no private block is ever found by meaning.

Result (`npx vitest run test/semantic-eval.test.ts --silent=false` prints the table): keyword-only recall@5 0.20, MRR 0.20 (it only answers the two one-word questions, "Queenstown" and "rego"); hybrid recall@5 1.00, MRR 0.88. The fake's synonym table was written alongside the questions, so read this as "the pipeline and fusion work", not as a measure of `bge-small`.

**Running it for real, once provisioned:** build a test graph from the fixture (one page per `pages` entry, the blocks nested as given, the `Passwords` page and the therapy block tagged `private`), connect it, and wait for `semantic_index_status` to say `ready`. Then in claude.ai ask each fixture question twice, telling Claude to use only `search_graph`, then only `semantic_search` with `limit` 5, and count the expected blocks in each top 5. Also ask "bank pin" and "therapy" and check that no private block comes back with `found-by` containing `semantic`. Record the table in `docs/spike-results.md`. Automating this is left out: it would need an OAuth client for the connector.

## 12. Deferred

- Property values (text properties such as *Description*) and page-level documents are not indexed; only content blocks are.
- Tag filtering is applied after retrieval (D1 rows), because Vectorize can't filter on an array. A rare tag may return fewer than `limit` results.
- No per-graph opt-out other than disconnecting it or tagging pages `private`.
- A model switch needs a manual index rebuild (delete the index and the `semantic_*` rows, recreate the index).
