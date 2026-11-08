# Service token access "write, no deletes": design

Date: 2026-11-08
Issue: none (owner request, relayed with the question: "When we say no deletes, we mean only delete on approval right?"). Areas: connector, migrations, docs, scripts.
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`. This work adds no patch.
Branch: `claude/relaxed-maxwell-s4r8o4-nodelete`, from `origin/main` at `89eba35` (PR 41 and PR 43 merged).
Builds on: `2026-11-07-service-token-cloud-sessions-design.md` ("the service-token design"), `2026-11-08-edit-service-token-scope-design.md` ("the edit design", PR 43), `2026-11-07-connector-write-audit-log-design.md` ("the audit design") and migrations 0006 and 0007.

Decisions marked **(brief)** come from the brief. Decisions marked **(call)** were made while writing this design. The design panel chose the "named" proposal (a third, token-wide access value enforced from one delete table). No ideas were grafted from other proposals. The parked draft on `claude/relaxed-maxwell-s4r8o4-graphmode-old-draft` (`ca61b72`, a per-graph variant that is not to be merged) was read for its delete table and its handler findings only. The decisions most worth a second look are in section 11.

## 1. Goal

An unattended Claude Code cloud session needs to read and write the owner's personal graph with no approval prompts, and must never delete there. A second token on the test graph keeps full write access for connector development. Today a service token is `read` or `write`, and `write` includes every delete.

This design adds a third access value, `write-no-delete`, ranked `read < write-no-delete < write`. A `write-no-delete` token can create, insert, move and overwrite. Every call that deletes is refused before anything reaches the sync server.

**The owner's question: does "no deletes" mean "delete only on approval"?** Not on the token. In this design a `write-no-delete` token refuses every delete outright. It has no way to ask for approval and no way to queue a delete for later. A delete still happens only with the owner's approval, but that approval happens outside the token:

- the owner deletes in the Logseq app;
- the owner asks Claude through the claude.ai connector (OAuth), which asks before any destructive tool;
- the owner runs an interactive Claude Code session. Section 3.8 keeps the seven delete tools out of `.claude/settings.json`'s allow list, so Claude Code prompts before each one. In an interactive session on a `write` token, that prompt is the approval.

An unattended session that hits a refused delete gets a message telling it to dry-run where it can, report what it would delete, and leave the delete to the owner. A queue of "delete requests" that the owner approves later is out of scope (section 10) and is named as a possible follow-up. If the owner wanted an approval path on the token itself, this design is the wrong one, and section 11 asks first.

Acceptance (brief, with the settings change in item 8 adjusted to the owner's question; see section 11, question 2):

1. `service_tokens.access` accepts `write-no-delete`. Migration 0008 rebuilds the table to relax the CHECK, keeping existing rows and `updated_at`. The effective mode never exceeds the graph's own mode, so a read-only graph stays read-only.
2. Enforcement lives in the single scope point (`scopedResolve`) and the audited write path, so every route is covered. One table decides what is a delete: `delete_page`, `delete_block`, `delete_blocks`, `delete_property`, `delete_tag`, `delete_block_property`, `batch_delete_block_property`, plus value-deleting arguments (`convert_values` and `choices.retire` on `update_property`, empty values) and any other tool or argument that deletes data. Each `ANNOTATIONS` destructive entry in `spec.mjs` is listed with the reason it is included or excluded.
3. A refusal names the token, the graph alias and the tool, is audited as refused, and makes 0 sync calls. Dry runs are allowed only where they write nothing, and the decision is stated (section 3.5). OAuth is unaffected. `list_graphs` shows the effective mode.
4. The wizard's create and edit pages offer read, write-no-delete and write. PR 43's widening rule treats `read < write-no-delete < write`, so moving up needs the confirm page. The list page shows the access. PR 43's guarantees and tests still pass.
5. D1 rows per `/mcp` request are unchanged: 1 read, 0 writes.
6. Tests go through the real Worker routes and D1, and each is seen to fail first.
7. Example data only (`mcp.example.com`, aliases `work`, `notes`, `test`). No path contains `tok`. No graph name or page UUID appears in any file.
8. Docs and settings: `.claude/settings.json` allows the `logseq-service` tools (section 3.8 says which); the wiring test in `scripts/logseq-mcp.test.mjs` changes to match; README §11.12 gains the access values and three recipes; `connector_help`, README §11.8 and line 814 describe the new refusal; `REVIEW.md` gains a class if one is learned; the PR body carries the Logseq skill note.
9. `scripts/check.sh` runs on HEAD, and the PR names its skipped checks.

## 2. Context

**Access is token-wide and two-valued.** `ServiceTokenAccess` in `connector/src/auth/service-tokens.ts` is `"read" | "write"`. `verifyServiceToken` reads the row by `token_hash` (`findByHash`, 1 row) and returns `ServiceProps` carrying `graphIds` and `access`. `mcp.ts` puts them into `RequestScope`, whose service variant is `{ kind: "service"; name; graphIds; access: "read" | "write" }` (`connector/src/tools/common.ts:111`).

**Scope is applied in one place.** `scopedResolve` (`common.ts:133-145`) refuses a graph outside the token (`out-of-scope`) and, for a read token, returns the graph with `mode: "read"` and `readOnlyBy: "service token '<name>'"`. `resolveGraph(access, alias, true)` then refuses a write on a read graph, naming the token. REVIEW.md *Security* ("Scope lives in one place") requires new scope rules to go here and not into individual tools.

**Every graph write goes through `audited()`.** `connector/src/audit/log.ts:636` runs, in order: the audit probe, `lookupGraph`, `takeReason`, `resolveGraph(..., true)`, then `isDryRun`, then the before-snapshot (`takeSnapshot`), then `log.begin`, then the write. A refusal in the first block skips the snapshot, and the row is begun and finished with status `refused` when the `ToolError` status is in `REFUSALS` (`log.ts:537`: `refused`, `unknown-graph`, `read-only`, `out-of-scope`). Generated tools, hand-written writes and the asset tools all call it. `isDryRun` (`log.ts:578`) accepts `dry-run` at the top level or in `body`, for any tool. That is fine for the audit flag, but too loose for letting a delete through (section 3.5).

**The CHECK blocks a new value.** Migration 0006 has `CHECK(access = 'read' OR access = 'write')`. SQLite cannot alter a CHECK, so the table has to be rebuilt. 0007 added `updated_at`, which the rebuild must keep. No other table references `service_tokens`: `grep -rn REFERENCES connector/migrations` finds nothing, and only `service-tokens.ts` and `audit/log.ts` name the table in code.

**The wizard parses access in three places.** `parseGraphsAndAccess` (`wizard/routes.ts:349-355`, shared by create and edit, refusing with `access: choose read-only or read-write.`), and the redisplay values at `routes.ts:463` and `routes.ts:574`. `isWidening` (`routes.ts:514`) is `added graph || (read -> write)`.

**Claude Code's settings allow only read tools on `logseq-service`.** `.claude/settings.json` enables the `logseq-service` server and allows nine read tools. The wiring test (`scripts/logseq-mcp.test.mjs:512`) asserts that the `mcp__logseq-service__` allow list equals the `mcp__Logseq__` list, that every entry is read-only in the manifest, and that there is no server-wide or wildcard rule.

**What the vendored openapi declares.** Measured from `connector/vendor/openapi.json`:

- `dry-run` as a query parameter: `deletePage`, `deleteTag`, `deleteProperty`, `updateProperty`, `moveBlocks`, `promotePageToTag`.
- `dry-run` in the JSON body: `deleteBlocks`, `batchMoveBlocks`, `batchInsertBlockTrees`.
- No dry run: `deleteBlock`, `deleteBlockProperty`, `batchDeleteBlockProperty`, `setBlockProperty`, `batchSetBlockProperty`, `updateTag`.
- `convert_values` appears only on `updateProperty`. `createProperty` has no such field.
- `batchInsertBlockTrees` entries take `properties` (`PropertyValues`), which the description says are set on the entry's target, so they replace an existing page's or block's values.
- `updateTag` takes `properties` with exactly one of `add`, `remove` or `set`. These change which properties the tag (class) carries, and `set` "replaces the tag's own properties".

**Handler behaviour (reported, not re-run here).** The parked draft's commit records running two rules against the real handler (upstream db-sync with the patches, through `sync-handler/handle-http`) on 2026-11-08:

- A type or cardinality change is not a delete. With a holder, a type change answered 400 ("This property's type can't be changed because it has existing data."), many to one answered 400, one to many answered 200 keeping the value, and choices survived with no holder.
- `""` answered 400 on text, number and checkbox properties. `[]` answered 200 and removed a text property's value through both `setBlockProperty` and batch-set.

This worktree has no `.upstream/deps/db-sync`, so neither was re-run for this spec. Both are marked **reported** below, and the build re-runs them (section 8, step 0). Two further rules have never been run against the handler and are marked **guess**: that `update_tag` `properties.remove` or `set` loses data, and that an empty value in a `batch_insert_block_trees` entry's `properties` removes the target's value.

## 3. Design

### 3.1 Layout

| File | Change |
|---|---|
| `connector/migrations/0008_service_token_write_no_delete.sql` | New. Rebuilds `service_tokens` with the wider CHECK. |
| `connector/src/auth/service-tokens.ts` | `ServiceTokenAccess` gains `"write-no-delete"`. `MODE_RANK` and `rank()` live here, the only place the order is defined. |
| `connector/src/graphs.ts` | `ResolvedGraph.deletesRefusedBy?: string`. |
| `connector/src/tools/common.ts` | `RequestScope` takes `ServiceTokenAccess`. New exported `effectiveMode(graph, scope)`. `scopedResolve` sets `deletesRefusedBy`. |
| `connector/src/tools/deletes.mjs` | New. `DELETE_RULES`, `deleteReason`, `DRY_RUN_TOOLS`, `declaredDryRun`, `noDeleteMessage`. Plain JS with JSDoc, like `spec.mjs`, so the scripts' node test can import it. |
| `connector/src/audit/log.ts` | The no-delete check after `resolveGraph`. `"no-delete"` joins `REFUSALS`. |
| `connector/src/tools/semantic.ts` | Backstop in `request()`: an HTTP `DELETE` on a graph with `deletesRefusedBy` is refused unless it is a declared dry run. |
| `connector/src/tools/handwritten.ts` | `list_graphs` uses `effectiveMode`. `connector_help` text. |
| `connector/src/mcp.ts` | `ServiceProps.access` type passes through. |
| `connector/src/wizard/routes.ts`, `views.ts` | Three values, rank-based widening, confirm lines, list tag. |
| `.claude/settings.json`, `scripts/logseq-mcp.test.mjs` | Allow list and its wiring test (section 3.8). |
| `README.md` §11.8, line 814, §11.12, troubleshooting; `REVIEW.md` if a class is learned | Docs. |
| `connector/test/service-tokens.test.ts`, `deletes.test.ts`, `wizard.test.ts`, migration test | Tests (section 8). |

`tools-manifest.json` does not change, because no tool name, schema or annotation changes.

### 3.2 The access value (brief)

```ts
export type ServiceTokenAccess = "read" | "write-no-delete" | "write";
export const MODE_RANK = { read: 0, "write-no-delete": 1, write: 2 } as const;
```

The access stays token-wide **(brief)**. The parked draft's per-graph modes were not taken: they need a new column or a JSON shape change and a larger wizard form. The two-token pattern (a `write-no-delete` token on the personal graph, a `write` token on the test graph) covers the owner's need. A token that names several graphs applies the same access to each, capped by each graph's own mode.

### 3.3 Scope in one place

```ts
export function effectiveMode(graph: ResolvedGraph, scope: RequestScope): GraphMode | "write-no-delete"
```

It is the lower-ranked of the graph's own mode and the token's access; under OAuth it is the graph's mode. `scopedResolve`:

- out of scope: refused as today;
- effective `read`: `{ ...graph, mode: "read", readOnlyBy: "service token '<name>'" }`, as today. A `write-no-delete` token on a read-only graph is read-only, and the read-only refusal names the token;
- effective `write-no-delete`: `{ ...graph, deletesRefusedBy: "service token '<name>'" }`. `mode` stays `write`, so every write check that exists today behaves as before;
- effective `write`: the graph unchanged.

OAuth never sets `deletesRefusedBy`. `lookupGraph`'s per-call cache stores the resolved graph, field included, so the check sees the same value the read-only check saw. No per-isolate cache holds scope (the edit design's acceptance 8 still holds, and its test still passes), so changing a token's access in the wizard takes effect on the next `/mcp` request.

`list_graphs` replaces its own `readOnly` flag (`handwritten.ts:76`) with `effectiveMode`, so each graph shows `read`, `write-no-delete` or `write`.

### 3.4 One delete table (brief)

`connector/src/tools/deletes.mjs` exports `DELETE_RULES`: one entry for every tool whose `ANNOTATIONS` entry has `readOnlyHint: false`. Each entry is one of:

- `{ always: why }`: the tool deletes whatever its arguments;
- `{ when: (args) => why | null }`: it deletes only with some arguments;
- `{ never: why }`: it deletes nothing, with the reason.

`deleteReason(tool, args)` returns the reason or null, and throws for a tool with no entry, as `snapshotClassFor` does. A new write tool cannot ship unclassified: the coverage test fails (section 8).

**What counts as a delete (call).** A call that removes an entity (page, block, tag, property, choice, value block) or removes a value from a block without putting another in its place. An overwrite (new text, a new value, a new tag list) is not a delete: the audit log's before-snapshot keeps what it replaced, so the owner can restore it. A move is not a delete. This line is the one the owner should check first (section 11, question 3).

| Tool | `ANNOTATIONS` | Rule | Reason |
|---|---|---|---|
| `delete_page` | destructive idempotent | always | Deletes the page and its blocks. On today's journal it clears the blocks and keeps the page, which is still a delete. |
| `delete_block` | destructive idempotent | always | Deletes the block and its children. |
| `delete_blocks` | destructive idempotent | always | Deletes the blocks and their children. |
| `delete_tag` | destructive idempotent | always | Deletes the tag; holders lose it. |
| `delete_property` | destructive idempotent | always | Deletes the property and its values. |
| `delete_block_property` | destructive idempotent | always | Removes a property value. |
| `batch_delete_block_property` | destructive idempotent | always | Removes property values. |
| `update_property` | destructive | when | `body.convert_values === true` deletes the old text value blocks (see `docs/solutions/api/convert-values-deleted-referenced-value-blocks.md`). A non-empty `body.choices.retire` removes choices and the values blocks hold. Renames, `add`, `update`, `order`, `classes` and type or cardinality changes are not deletes (type and cardinality: **reported**). |
| `set_block_property` | destructive idempotent | when | `body.value` is `""` or `[]`. `[]` removes the value (**reported**). `""` answered 400 (**reported**), so refusing it costs nothing and keeps the rule simple. Whitespace (`" "`) is stored as text and is allowed. |
| `batch_set_block_property` | destructive idempotent | when | Any `body.entries[N].value` is `""` or `[]`. The message names the first such entry: `entry 2: an empty value removes the property`. |
| `batch_insert_block_trees` | destructive | when | Any `body.entries[N].properties` holds a value that is `""` or `[]`, named as `entries[1]: an empty value removes the property`. **Guess**: an entry's properties are set on an existing target, so `[]` should remove its value as `setBlockProperty` does. The parked draft classed this tool as never and missed it. Non-empty properties are overwrites and are allowed. |
| `update_tag` | destructive | when | `body.properties.remove`, or `body.properties.set` (which drops the tag's own properties not listed). **Guess**, conservative: whether holders' values survive is not known. Step 0 of the build runs it. If values survive, the rule becomes never and the evidence goes in the file header. `title` and `extends` are overwrites. |
| `update_block` | destructive | never | Overwrites text and properties; the before-snapshot keeps the old ones. |
| `update_page` | destructive | never | Overwrites; the before-snapshot keeps the old values. |
| `refresh_refs` | destructive | never | Rewrites each changed block's text; the before-snapshot keeps it. |
| `promote_page_to_tag` | destructive | never | Converts a page in place, keeping its UUID, blocks, values and references. |
| `move_blocks`, `batch_move_blocks` | additive | never | Moves; nothing is removed. |
| `save_document`, `save_file_from_url` | additive | never | Add an asset block. Their snapshot plan is `NOTHING_OVERWRITTEN`, and neither takes an overwrite argument (checked in `assets.ts` and the manifest). |
| `insert_block_children`, `insert_block_tree`, `capture_to_today`, `create_page`, `create_tag`, `create_task`, `create_property` | additive | never | Add. `create_property` takes no `convert_values`; a test pins that against the vendored openapi. |

Read tools have no entry, and a test checks that none has one. `connector_help` is read-only.

`noDeleteMessage(by, tool, alias, why, dryRunnable)` builds the refusal text (section 4), so `audited()` and the backstop in `request()` say the same thing.

### 3.5 Enforcement and dry runs

**In `audited()`.** Straight after `await resolveGraph(ctx.access, alias, true)`, inside the same `try`:

```ts
const graph = await lookupGraph(ctx.access, alias);
const why = graph?.deletesRefusedBy ? deleteReason(tool, rest) : null;
if (why !== null && !declaredDryRun(tool, rest)) throw new ToolError(noDeleteMessage(...), "no-delete");
```

`"no-delete"` joins `REFUSALS`, so the row is finished with status `refused` and the message. The refusal is set before `takeSnapshot`, so no snapshot GET and no write reach the sync server. The `lookupGraph` call is served from the per-call cache, so it costs nothing.

**The backstop in `request()`** (`semantic.ts`). If the resolved graph has `deletesRefusedBy` and the HTTP method is `DELETE`, it throws the same `ToolError` unless the request carries a declared dry run (`dry-run=true` in the query for `deletePage`, `deleteTag` and `deleteProperty`; in the body for `deleteBlocks`). This catches a delete route that a future change sends round `audited()`. It is defence in depth, has its own test, and uses the same message helper. It cannot catch argument-level deletes (they are `PATCH`, `PUT` or `POST`), which is why the table check in `audited()` is the main one.

**Dry runs are allowed (call).** A refused tool or argument may run as a dry run, because a dry run writes nothing and tells the session what the delete would remove, which it can report to the owner. `declaredDryRun(tool, args)` is true only when `tool` is in `DRY_RUN_TOOLS` and `dry-run === true` sits where that operation declares it (query: `delete_page`, `delete_tag`, `delete_property`, `update_property`, `move_blocks`, `promote_page_to_tag`; body: `delete_blocks`, `batch_move_blocks`, `batch_insert_block_trees`). A `dry-run` key anywhere else does not count, so the request the server sees always carries `dry-run=true`. `DRY_RUN_TOOLS` is written out by hand, and a test checks it against the vendored openapi so it cannot drift.

`delete_block`, `delete_block_property`, `batch_delete_block_property`, `set_block_property`, `batch_set_block_property` and `update_tag` declare no dry run, so on a `write-no-delete` token those calls are refused outright when the table classes them as deletes.

A permitted dry run is audited with `dry_run = 1`. A delete's dry run still takes its check-only snapshot read, as today. This relies on upstream honouring `dry-run=true` and writing nothing, edit stamps included. The patches already depend on that for every dry run the connector offers.

### 3.6 Migration 0008 (brief)

`connector/migrations/0008_service_token_write_no_delete.sql`:

```sql
CREATE TABLE service_tokens_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  graph_ids TEXT NOT NULL CHECK(json_valid(graph_ids) AND json_type(graph_ids) = 'array'),
  access TEXT NOT NULL CHECK(access = 'read' OR access = 'write-no-delete' OR access = 'write'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  last_used_at INTEGER,
  revoked_at INTEGER,
  updated_at INTEGER
);
INSERT INTO service_tokens_new (id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at)
  SELECT id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at FROM service_tokens;
DROP TABLE service_tokens;
ALTER TABLE service_tokens_new RENAME TO service_tokens;
CREATE UNIQUE INDEX service_tokens_hash ON service_tokens(token_hash);
```

- The same columns in the same order as 0006 plus 0007, so `PUBLIC_COLUMNS`, `toRow` and `SELECT *` users see no change.
- The CHECK is an OR chain, as in 0006, never `IN (...)` (0004's header: `IN` bills an extra row on every INSERT and UPDATE).
- The `UNIQUE` on `name` stays inline. The hash index is recreated with the same name, because dropping the table drops it.
- Explicit column lists on both sides, so a column cannot shift.
- The header records the measured cost and why a rebuild is needed. It follows the `add-d1-migration` skill. `DROP` and `RENAME` inside a migration are tested on Miniflare's D1, the same engine `wrangler d1 migrations apply` uses.

### 3.7 Wizard

- **Create and edit forms.** Three radios, in rank order: "Read only" (`read`), "Read and write, no deletes" (`write-no-delete`), "Read and write" (`write`). `parseGraphsAndAccess` accepts the three values and refuses anything else with `access: choose read-only, read-write without deletes, or read-write.` The redisplay values at `routes.ts:463` and `574` accept the three.
- **Widening.** `isWidening` becomes `added graph || rank(after.access) > rank(before.access)`. Moving up needs the confirm page; moving down applies at once. The confirm lines read "gains write, no deletes on notes" (read to write-no-delete), "gains deletes on notes" (write-no-delete to write), "gains read-write on notes" (read to write), and on a narrowing confirm that also widens, "loses deletes on notes". Where the graph's own mode caps the result, the line adds "effective: read only (the graph is read-only)", as today.
- **Unchanged from PR 43.** The guarded `UPDATE` compares the stored before-values as drawn (`docs/solutions/connector/optimistic-guard-must-compare-the-form-it-drew.md`), the confirm applies exactly what it showed and audits with it (`two-step-edit-applies-what-it-showed-and-audits-with-it.md`), and stale confirms fail closed. `access` is already part of the `base` comparison, so a third value needs no new guard.
- **List and detail.** The access tag shows "read-only", "read-write, no deletes" or "read-write". The token-edit audit row's before and after carry the new value as text.

### 3.8 Claude Code settings (call, adjusts the brief)

The brief asked for `.claude/settings.json` to allow every `logseq-service` tool. The owner's question says deletes should need approval, so this design allows every tool in `tools-manifest.json` **except the seven `always` delete tools**. The list is explicit and generated from the manifest minus the `always` set in `deletes.mjs`. It is never a server-wide `mcp__logseq-service` rule or a wildcard, which the wiring test keeps forbidding.

The effect:

- unattended session on a `write-no-delete` token: writes run without prompts; deletes are refused by the Worker in any case;
- interactive session on a `write` token (the test graph): writes run without prompts; the seven delete tools prompt, and that prompt is the owner's approval;
- argument-level deletes (`convert_values`, `choices.retire`, empty values) run through allowed tools, so on a `write` token they run unprompted. The README says the `write` token is for the test graph only.

The `mcp__Logseq__` (claude.ai connector) allow list is unchanged. The wiring test's assertion that both lists are equal and read-only is replaced, for `logseq-service`, by: the allow list equals the manifest names minus `deletes.mjs`'s `always` set, every name is in the manifest, and there is no server-wide or wildcard rule.

### 3.9 Docs

- `connector_help` (`handwritten.ts`, the service-token paragraph) and README line 814 describe `write-no-delete`: which calls it refuses, that a declared dry run is allowed, and "don't retry; report what it would delete and leave it to the owner".
- README §11.8 gains the refusal's text. `tools-manifest.json` is unchanged, and `update:manifest` confirms it.
- README §11.12 gains the three access values, and three recipes, all with `mcp.example.com` and the aliases `work`, `notes` and `test`:
  - **cloud worker**: a `write-no-delete` token on `notes`, its secret in the cloud environment, no prompts;
  - **connector dev**: a `write` token on `test` only, never on a personal graph;
  - **use from another repo**: a `.mcp.json` and `.claude/settings.json` snippet, with the allow list minus the delete tools.
- The troubleshooting table gains a row for the no-delete refusal.
- The PR body carries the Logseq skill note: under the worker token, deletes come back refused; the skill should dry-run, report what it would delete, and leave the delete to the owner.

## 4. Tool contract

No tool is added or renamed and no input schema changes, so `tools-manifest.json` stays byte-identical. Changed behaviour:

**(a) Refusals.** Under a `write-no-delete` service token, on a graph whose own mode is write, every call `DELETE_RULES` classes as a delete (and that is not a declared dry run) answers `isError` with:

```
service token 'worker' may not delete (write, no deletes): delete_page on graph 'notes' deletes the page and its blocks. Run it with dry-run=true to see what it would delete, and leave the delete to the owner.
```

For a tool with no declared dry run, the last sentence is only `Leave the delete to the owner.` Batch rules name the entry (`... batch_set_block_property on graph 'notes' entry 2: an empty value removes the property. Leave the delete to the owner.`). The log status is `no-delete` and the audit row's status is `refused`, holding the message. No request reaches the sync server.

The calls refused are: `delete_page`, `delete_block`, `delete_blocks`, `delete_tag`, `delete_property`, `delete_block_property`, `batch_delete_block_property`; `update_property` with `convert_values: true` or a non-empty `choices.retire`; `set_block_property` with `""` or `[]`; `batch_set_block_property` or `batch_insert_block_trees` with an empty value in any entry; `update_tag` with `properties.remove` or `properties.set`.

**(b) Dry runs.** A declared dry run of any of those calls runs and is audited with `dry_run = 1`.

**(c) `list_graphs`.** `mode` is the effective mode: `"read" | "write-no-delete" | "write"`.

**(d) Unchanged.** OAuth (the claude.ai connector), `read` tokens and `write` tokens behave exactly as before.

**Wizard.** `POST /tokens` and `POST /tokens/:id/edit` accept `access=read|write-no-delete|write`; anything else is refused naming the field.

**Claude Code.** The `mcp__logseq-service__*` allow list is every manifest tool except the seven delete tools.

## 5. Cost on the Free plan

| Path | D1 rows read | D1 rows written | Other |
|---|---|---|---|
| `/mcp` request (bearer lookup) | 1 (`findByHash`), unchanged | 0 (`touch` at most 1 an hour per token, unchanged) | none |
| Delete check | 0 | 0 | Pure CPU: a table lookup and one pass over at most 100 entries, well under 1 ms of the 10 ms budget. 0 sync calls, 0 neurons, 0 Vectorize. |
| Refused delete | as a read-only refusal today: the audit probe (cached per isolate), plus the begin INSERT and finish UPDATE | as a read-only refusal today | No snapshot GET and no sync request, so cheaper than an allowed delete. The test pins the rows equal to a read-only refusal's. |
| Allowed dry run | as today | as today | as today |
| `list_graphs` | unchanged (`store.list`) | 0 | none |
| Wizard create | unchanged | 4 (row plus three index entries) | none |
| Wizard edit | 1 by primary key, unchanged | 1 on a hit, 0 on a guard miss | none |
| Wizard list | about one per token, unchanged | 0 | none |
| Migration 0008, once | about N rows plus schema rows | about N times 4 (row, primary key, unique name, hash index) plus schema rows | none |

With fewer than 20 tokens, migration 0008 writes under 200 rows against the 100k daily cap. The build measures it from D1 meta on Miniflare and records the figures in the migration header. No cron or semantic indexer change. Daily impact is about zero.

## 6. Safety

- **Scope stays in one place.** The mode is worked out in `scopedResolve`. Tools do not check access themselves.
- **Fail closed.** A write tool with no rule throws (the call fails and is audited as an error), and CI fails first. An unknown access value fails the CHECK, the wizard parse and the type.
- **No silent success.** A refused call says why and writes nothing. A dry run says it is a dry run.
- **Errors name the entry and reason.** Batch refusals name the entry.
- **The effective mode never exceeds the graph's.** A read-only graph caps every token to read.
- **No secrets in files.** Tests and docs use example aliases and `mcp.example.com`. The refusal names the token's name, never the token or its hash (`docs/solutions/connector/redact-the-secret-before-you-cut-the-message.md`).
- **The edit path stays owner-only.** No MCP tool changes a token's access.
- **What `write-no-delete` does not stop.** Overwrites: a session can replace a block's text or a property's value. The audit log's before-snapshot keeps the old values, so the owner can restore them, but nothing stops the overwrite. This is the designed boundary (section 3.4) and the README says so.

## 7. Risks

1. **The owner may expect an approval path on the token.** This design refuses outright and gets approval by keeping the delete tools prompting in Claude Code. Section 11, question 1 asks the owner to confirm.
2. **Argument-level deletes run unprompted on a `write` token**, because the tools that carry them are allowed. Only `write-no-delete` stops them. The README limits the `write` recipe to the test graph.
3. **Classification gaps.** A future upstream argument that deletes would pass. Mitigations: every write tool needs an entry or CI fails; a mutation test per rule (`docs/solutions/testing/untested-rules-survive-mutation.md`); a test that `create_property` declares no `convert_values`; and the table in section 3.4 lists every destructive entry with its reason. A vendor bump that adds a body field to a write tool should re-check the table. The build adds that line to the `add-connector-tool` skill.
4. **Two guessed rules.** `update_tag` `properties.remove`/`set` and `batch_insert_block_trees` empty properties are classed as deletes without a handler run. Over-refusing `update_tag` stops the worker tidying tag schemas; under-refusing loses data. Step 0 of the build runs both, and the outcome is recorded.
5. **Migration rebuild.** A missed column or index would lose `updated_at` or the unique hash index. The test writes every column, applies 0008 and reads every column back, and checks the index and the CHECK (section 8).
6. **Dry-run trust.** Allowing dry runs depends on upstream writing nothing on `dry-run=true`. Limited to operations that declare it, in the place they declare it.
7. **Two enforcement points can drift.** Both use `deletes.mjs` helpers, and each has its own test.
8. **Wizard rank bugs.** A rank bug could move `write-no-delete` to `write` without the confirm page. A test covers each of the six ordered pairs of access values.
9. **Rollback widens.** Old code treats any access other than `read` as write (section 9). Revoke `write-no-delete` tokens before reverting.
10. **Deviation from the brief.** The brief asked to allow every `logseq-service` tool. This design leaves out the seven delete tools to honour the owner's question. Section 11, question 2.

## 8. Testing

Every test is written first and seen to fail on base `89eba35`, and the failure is quoted in the PR.

**Step 0, before any code (call).** With `.upstream` built, re-run against the real handler: `setBlockProperty` with `""` and `[]` on a text property with a value; `updateProperty` type and cardinality changes with a holder; `updateTag` with `properties.remove` and `properties.set` on a tag whose holders hold values for the dropped property, then read a holder back; `batchInsertBlockTrees` with an entry whose `target-id` names an existing block holding a value and `properties` setting it to `[]`. Quote each answer in the `deletes.mjs` header and relax or keep each rule accordingly.

1. **`connector/test/service-tokens.test.ts`**, through `mcpHandler` with real Miniflare D1 and a fake sync fetch that counts requests:
   - one table-driven case per refused tool and argument (the seven always tools; `update_property` `convert_values`; `choices.retire`; `set_block_property` `""` and `[]`; `batch_set_block_property` entry 2 `[]`; `batch_insert_block_trees` `entries[1]` properties `[]`; `update_tag` `properties.remove` and `set`). On a `write-no-delete` token each gives `isError` with the exact message (token, alias `notes`, tool, entry), 0 sync calls, and an `audit_log` row with status `refused` and the message;
   - the same calls on a `write` token reach the sync fake;
   - never-rule tools (`update_block`, `move_blocks`, `save_document`, `batch_insert_block_trees` with non-empty properties, `promote_page_to_tag`, `refresh_refs`, `update_tag` with `title`) succeed on `write-no-delete`;
   - declared dry runs (`delete_page` query, `delete_blocks` body, `update_property` `convert_values` query) reach sync with `dry-run=true` and audit `dry_run = 1`; a `dry-run` key in an undeclared place is still refused;
   - a `read` token refuses writes as before; a read-only graph with a `write-no-delete` token answers read-only, naming the token;
   - `list_graphs` shows `write-no-delete`, `write` and `read` correctly, including the read-only-graph cap;
   - OAuth is unaffected: the same delete reaches sync;
   - D1 meta for the request: 1 row read and 0 written before the tool runs; a refused delete's audit rows equal a read-only refusal's.
2. **Backstop.** `request()` with `deletesRefusedBy` set refuses an HTTP `DELETE` when called directly, and lets a declared dry run through.
3. **`connector/test/deletes.test.ts`.** Every manifest tool with `readOnlyHint: false` has a rule and no read tool has one; `deleteReason` throws for an unknown tool; every `ANNOTATIONS` destructive entry is in section 3.4's table (the test holds the list); `DRY_RUN_TOOLS` matches the vendored openapi, query or body; `createProperty` declares no `convert_values`. A mutation pass removes each rule or condition in turn and checks a test fails.
4. **Migration.** Apply 0001 to 0007, insert `read` and `write` rows with `updated_at`, `last_used_at` and `revoked_at` set, apply 0008, and read back every column unchanged. Inserting `write-no-delete` succeeds; `delete` and `''` fail the CHECK; a duplicate hash and a duplicate name are refused; `PRAGMA index_list` shows `service_tokens_hash`. D1 meta is recorded for the header.
5. **`connector/test/wizard.test.ts`.** Create with `write-no-delete` stores it, and the list shows "read-write, no deletes". Edits read to write-no-delete, write-no-delete to write and read to write show the confirm page with the right gain line, and nothing is written until confirmed. Write to write-no-delete, write to read and write-no-delete to read apply at once. A read-only graph shows "effective: read only". An unknown access value is refused naming the field. PR 43's stale-form and guard tests still pass unchanged.
6. **`scripts/logseq-mcp.test.mjs`.** The `logseq-service` allow list equals the manifest names minus the `always` set; no server-wide or wildcard rule; the `.mcp.json` assertions unchanged.
7. `scripts/check.sh` on HEAD, naming the SHA and the skipped checks.

## 9. Rollout and verification

1. Merge to main; `deploy` applies migration 0008 and deploys the Worker. Existing tokens keep their access, because the rebuild copies every row.
2. In the wizard, create a `write-no-delete` token on `notes` (example alias). Check the list shows "read-write, no deletes".
3. From a cloud session holding it: `list_graphs` shows `write-no-delete`; `insert_block_tree` works; `delete_block` is refused with the message; `delete_page` with `dry-run=true` answers what it would delete; `get_activity_log` shows the refusal.
4. Edit an existing `write` token on `test` (example alias) and confirm nothing changed. Edit a `read` token to `write-no-delete` and check the confirm page appears.
5. Check the next day's usage report: D1 rows and Worker requests are flat.

Rollback: revert the Worker. Migration 0008 needs no reverse: the old code reads `read` and `write` from the rebuilt table. **Before rolling back, revoke every `write-no-delete` token.** The old `scopedResolve` (`common.ts:143`) checks only `scope.access === "read"`, and `verifyServiceToken` passes `row.access` through unchecked, so old code would give a `write-no-delete` token full write, deletes included. The README's rollback note says so.

So that a later unknown value cannot do the same, the new code fails closed **(call)**: `verifyServiceToken` refuses a row whose `access` is not a key of `MODE_RANK` (answering the generic invalid-token result, and the test pins it with a row written past the type), rather than treating it as write.

## 10. Out of scope

- **A delete approval queue.** A tool that records "please delete X" for the owner to approve later in the wizard or the app. A possible follow-up if the owner wants unattended sessions to propose deletes.
- Per-graph access on one token (the parked draft's approach).
- Refusing overwrites. `write-no-delete` stops deletes only.
- Changing the claude.ai connector (OAuth) or its allow list.
- Changing what upstream deletes, or any patch.

## 11. Open questions for the owner

1. **Is "refuse outright, approve elsewhere" what you meant by "no deletes"?** On a `write-no-delete` token, deletes are refused with no approval path. You approve a delete by doing it yourself, through claude.ai, or by answering Claude Code's prompt in an interactive session. If you want an unattended session to ask and wait for your approval, that is the approval queue in section 10 and a separate feature.
2. **Settings allow list.** The brief said allow every `logseq-service` tool. This design leaves the seven delete tools out, so Claude Code prompts before them. Do you agree, or do you want them allowed (so a `write` token on the test graph deletes without asking)?
3. **Is an overwrite a delete?** This design treats replacing text or a value as an overwrite (allowed, restorable from the audit log) and removing a value with nothing in its place as a delete (refused). Should the worker be stopped from overwriting too, for some tools?
4. **`update_tag` properties.** Until step 0 shows values survive, `properties.remove` and `properties.set` are refused on the worker token. Is that acceptable in the meantime?
5. **Dry runs.** Dry runs of deletes are allowed on the worker token so it can report what it would delete. Do you want them refused too?
