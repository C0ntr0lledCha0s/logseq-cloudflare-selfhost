# Service token access "write, no deletes": implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a third service-token access value, `write-no-delete`, ranked `read < write-no-delete < write`. A `write-no-delete` token can create, insert, move and overwrite, and every call that deletes is refused before anything reaches the sync server, named, audited as refused, with 0 sync calls. The wizard offers the three values and treats moving up as widening. Claude Code's settings allow every `logseq-service` tool except the seven delete tools, so in an interactive session a delete still prompts.

**The owner's question ("no deletes means only delete on approval, right?").** The approved spec answers it in §1 and this plan builds exactly that: a `write-no-delete` token refuses every delete outright and has no approval path of its own. A delete still happens only with the owner's approval, given outside the token: in the Logseq app, through claude.ai (OAuth, which asks before destructive tools), or by answering Claude Code's prompt for one of the seven delete tools, which Stage 5 keeps out of the allow list. A queue of delete requests for later approval is out of scope (spec §10). No stage adds an approval path on the token, and the refusal tells an unattended session to dry-run, report and leave the delete to the owner.

**Architecture:**
- **Connector only.** No patch (spec header). `scripts/check.sh` runs without `--upstream` in every stage.
- **One delete table.** `connector/src/tools/deletes.mjs` classifies every write tool as `always`, `when(args)` or `never`, and holds the dry-run declarations and the refusal text. Both enforcement points and the Claude Code allow list derive from it (spec §3.4, §3.8).
- **Scope in one place.** `scopedResolve` works out the effective mode and marks the graph with `deletesRefusedBy`; `audited()` refuses from the table; `request()` in `semantic.ts` is a backstop for HTTP `DELETE` (spec §3.3, §3.5). No tool checks access itself (REVIEW.md *Security*, "Scope lives in one place").
- **Order, and why it is safe at every commit:** the table first (nothing calls it); then migration 0008 and the type, with `verifyServiceToken` still accepting only `read` and `write`, so a `write-no-delete` row cannot authenticate before it is enforced; then scope and enforcement, which is the commit that lets a `write-no-delete` token in; then the wizard, which lets the owner create one; then settings and docs. No commit ever gives a `write-no-delete` row full write.

**Tech stack:** TypeScript connector with vitest in `@cloudflare/vitest-pool-workers` (real D1 in workerd, migrations applied by `connector/test/apply-migrations.ts`, the `SYNC` binding faked at HTTP level and counting requests, `mcpHandler` and `createConnector().fetch` run for real). The scripts' node tests (`npm test`) for the settings wiring.

**Spec:** `docs/superpowers/specs/2026-11-08-service-token-write-no-delete-design.md`. Read it first. It is the authority; section numbers below (§3.4 and so on) are the spec's. The spec is approved as written, so its §11 proposals stand: refuse outright with approval elsewhere; the seven delete tools stay out of the `logseq-service` allow list; an overwrite is not a delete; `update_tag` `properties.remove` and `properties.set` are refused until a handler run shows values survive; declared dry runs are allowed.

## Global constraints

- **Names, exactly:**
  - migration `connector/migrations/0008_service_token_write_no_delete.sql`, the statements in spec §3.6 (explicit column lists both sides, OR-chain CHECK, inline `UNIQUE` on `name`, `service_tokens_hash` recreated);
  - `ServiceTokenAccess = "read" | "write-no-delete" | "write"`, `MODE_RANK = { read: 0, "write-no-delete": 1, write: 2 } as const` and `rank(access)` in `connector/src/auth/service-tokens.ts`, the only place the order is defined;
  - `ResolvedGraph.deletesRefusedBy?: string` in `connector/src/graphs.ts`;
  - `effectiveMode(graph, scope): GraphMode | "write-no-delete"` exported from `connector/src/tools/common.ts`; `RequestScope`'s service variant takes `access: ServiceTokenAccess`;
  - `connector/src/tools/deletes.mjs` exporting `DELETE_RULES`, `deleteReason(tool, args)`, `ALWAYS_DELETE` (the seven `always` tool names, derived from `DELETE_RULES`), `DRY_RUN_TOOLS`, `declaredDryRun(tool, args)` and `noDeleteMessage(by, tool, alias, why, dryRunnable)`; plain JS with JSDoc. It imports nothing from `connector/vendor/` or `spec.mjs` (both need the vendored build), so `scripts/logseq-mcp.test.mjs` can import it under `npm test` with no vendor present;
  - log status `"no-delete"`, added to `REFUSALS` in `connector/src/audit/log.ts`.
- **Messages, in the spec's wording** (§4):
  - `service token '<name>' may not delete (write, no deletes): <tool> on graph '<alias>' <why>. Run it with dry-run=true to see what it would delete, and leave the delete to the owner.`
  - for a tool with no declared dry run the last sentence is only `Leave the delete to the owner.`
  - batch rules name the entry: `... batch_set_block_property on graph 'notes' entry 2: an empty value removes the property. Leave the delete to the owner.` (step 0 made `batch_insert_block_trees` a never rule, so it has no entry message)
  - wizard: `access: choose read-only, read-write without deletes, or read-write.` (create and edit share it through `parseGraphsAndAccess`).
  The message names the token's name, never the token or its hash (`docs/solutions/connector/redact-the-secret-before-you-cut-the-message.md`).
- **Refuse the whole call up front** (CLAUDE.md, *No silent success*). The no-delete check runs before `takeSnapshot`, so a refused call makes no snapshot GET and no sync request. Each refusal test counts sync requests and asserts 0.
- **Fail closed.** A write tool with no `DELETE_RULES` entry makes `deleteReason` throw (the call fails and is audited as an error) and the coverage test fails in CI first. `verifyServiceToken` refuses a row whose `access` it does not accept (the generic invalid-token result). An unknown access value fails the CHECK, the wizard parse and the type.
- **Overwrites are not deletes** (spec §3.4). The `never` rules carry their reason in the table, and Stage 3's tests show each `never` tool succeeds on a `write-no-delete` token.
- **Free plan** (spec §5, REVIEW.md *Cost*, `docs/solutions/cost/bearer-lookup-by-hash-costs-one-row.md`). A `/mcp` request still reads 1 D1 row and writes 0 before the tool runs (plus the hourly `touch`); the delete check reads and writes nothing; a refused delete's audit rows equal a read-only refusal's. Migration 0008 is measured from D1 `meta` on Miniflare and the figures go in its header. Each stage's commit body states its rows per request.
- **Tests run the real thing.** Real D1, the real Worker routes, the real `audited()`, `scopedResolve` and `request()`. Only the sync server and GitHub are faked. Each rule is first seen to fail with the rule removed, and each failure text is kept for the PR (`docs/solutions/testing/untested-rules-survive-mutation.md`).
- **Contract with Claude.** No tool is added, removed or renamed, and no input schema changes, so `tools-manifest.json` stays byte-identical (`update:manifest` and the manifest check confirm it in every stage). `connector_help` changes in Stage 3, with README §11.8 and line 814.
- **Example data only.** `mcp.example.com`, aliases `work`, `notes` and `test`, token names such as `worker`, `ci` and `nightly`. Test tokens are generated at run time. No path, fixture, form value or test name contains `tok` built from a token (keep existing file names the spec fixes). No graph name or page UUID in any file.
- **Commits** follow `type(scope): what changed` (scope `connector`, or `deploy` for settings), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

### Read before starting

- `REVIEW.md`, sections *Security* ("Scope lives in one place"), *Cost*, *Contract and docs*, *Gates and tests*.
- `connector/src/tools/common.ts` (`RequestScope`, `currentScope`, `scopedResolve`, `lookupGraph`, `resolveGraph`), `connector/src/audit/log.ts` (`audited`, `REFUSALS`, `isDryRun`, `takeSnapshot`, `snapshotClassFor`), `connector/src/tools/semantic.ts` (`request`), `connector/src/tools/spec.mjs` (`ANNOTATIONS`), `connector/src/tools/handwritten.ts` (`list_graphs`, `connector_help`), `connector/src/auth/service-tokens.ts` (`verifyServiceToken`, `findByHash`), `connector/src/mcp.ts` (`ServiceProps`), `connector/src/wizard/routes.ts` (`parseGraphsAndAccess`, the redisplay values near lines 463 and 574, `isWidening`), `connector/src/wizard/views.ts`.
- `connector/migrations/0006_service_tokens.sql` and `0007_service_token_updated_at.sql`; the `add-d1-migration` skill.
- `connector/test/service-tokens.test.ts`, `connector/test/wizard.test.ts` (PR 43's edit tests), `connector/test/tools.test.ts` (the dry-run cases), `scripts/logseq-mcp.test.mjs` (the wiring test near line 512).
- `docs/solutions/api/convert-values-deleted-referenced-value-blocks.md`, `docs/solutions/api/handler-writes-skip-outliner-guards-and-implicit-holders.md`, `docs/solutions/connector/two-step-edit-applies-what-it-showed-and-audits-with-it.md`, `docs/solutions/connector/optimistic-guard-must-compare-the-form-it-drew.md`, `docs/solutions/connector/audit-pre-read-must-mirror-the-write.md`.
- The parked draft `claude/relaxed-maxwell-s4r8o4-graphmode-old-draft` (`ca61b72`) for its delete table and handler notes only. Do not merge or cherry-pick it.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **`dry-run` as the string `"true"`, or `true` in the wrong place** (body for a query-declared tool, query for a body-declared one, or on a tool that declares none such as `delete_block`): not a declared dry run, so refused (Stage 1 unit, Stage 3 route).
2. **`choices.retire: []`** (empty list) on `update_property`: not a delete, allowed; one entry: refused (Stage 1).
3. **`convert_values: false`**, or absent, with a type change: allowed (Stage 1).
4. **`set_block_property` with `" "`, `[" "]`, `0` or `false`:** stored values, allowed; `""` and `[]` refused. If the vendored schema admits `null` for `value`, `null` is classed as empty and refused, and a test pins it; if the schema refuses `null`, a test pins that the schema refusal arrives first (Stage 1).
5. **A batch where only the last entry is empty:** refused, naming that entry's index, not entry 0 (Stage 1, Stage 3).
6. **`batch_insert_block_trees` with nested children whose own `properties` hold `[]`:** step 0 showed `[]` leaves an existing target's value and a reused block keeps its properties, so the tool is `never` and these are allowed. Originally: the rule walks every entry's `properties` as the spec says; whether nested trees carry `properties` that target existing blocks is checked against the vendored schema and the rule's header says which (Stage 1).
7. **`update_tag` with `properties.add` only, or `title` only:** allowed. Step 0 showed holders keep their values after `remove` and `set`, so those are allowed too and the tool is `never` (Stage 1, Stage 3).
8. **A `write-no-delete` token covering two graphs, one connected read-only:** the read-only one answers the read-only refusal naming the token; the other refuses deletes and allows writes; `list_graphs` shows `read` and `write-no-delete` (Stage 3).
9. **The token's access edited between two `/mcp` requests** (write to write-no-delete, and back up through the confirm): the next request sees the new access, with no per-isolate cache (Stage 4).
10. **A refused delete inside one tool call that also resolves the graph twice:** the second `lookupGraph` is served from the per-call cache, so the check sees the same `deletesRefusedBy` and no extra D1 read (Stage 3).
11. **A `write-no-delete` row reaching code from before Stage 3:** cannot authenticate (Stage 2), so rollback order in the README (revoke first) is the only route to an over-wide token (Stage 5 docs).

---

### Stage 1: The delete table

**Goal:** `connector/src/tools/deletes.mjs` with every write tool classified, the dry-run declarations and the refusal text, each pinned against the manifest, `ANNOTATIONS` and the vendored openapi. Nothing calls it yet, so behaviour for the owner and Claude is unchanged. Lands spec §3.4, the helpers of §3.5, and tests §8.3.

**Files:**
- Create: `connector/src/tools/deletes.mjs`. Header comment: what counts as a delete (spec §3.4's definition), why overwrites and moves are not, the evidence for each `when` rule marked **reported** or **guess** as in spec §2, and the step 0 outcome. One `DELETE_RULES` entry per tool whose `ANNOTATIONS` entry has `readOnlyHint: false`, exactly as the spec §3.4 table. `deleteReason` throws `unclassified write tool: <tool>` for a tool with no entry. `declaredDryRun` checks `args["dry-run"] === true` for the query-declared tools and `args.body?.["dry-run"] === true` for the body-declared ones.
- Create: `connector/test/deletes.test.ts`.

**Interfaces produced:** `DELETE_RULES`, `deleteReason`, `ALWAYS_DELETE`, `DRY_RUN_TOOLS`, `declaredDryRun`, `noDeleteMessage`.

- [ ] **Step 0: Handler evidence** (spec §8 step 0). If `.upstream/deps/db-sync` exists or can be built (`scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream`), run each probe in spec §8 step 0 through `sync-handler/handle-http` and quote each answer in the `deletes.mjs` header. Relax `update_tag` to `never` only if a holder's value survives `properties.remove` and `set`; relax `batch_insert_block_trees` only if `[]` leaves the target's value. If the build is not available in the session, keep both rules as deletes (the conservative side), write "not re-run on <date>: no .upstream build" in the header, and list it under open items in the PR. Never relax a rule without a quoted handler answer.

- [ ] **Step 1: Write the failing tests** (`deletes.test.ts`):
  - `every write tool is classified`: for each `tools-manifest.json` tool with `readOnlyHint: false`, `DELETE_RULES` has an entry; no read tool (including `connector_help`) has one; `deleteReason("no_such_tool", {})` throws.
  - `every destructive ANNOTATIONS entry is in the table`: the test holds the spec §3.4 list of `destructiveHint: true` tools with their rule kind and checks it equals `ANNOTATIONS` filtered the same way and `DELETE_RULES`' kinds, so a new destructive tool or a changed rule fails here.
  - `always`: each of `delete_page`, `delete_block`, `delete_blocks`, `delete_tag`, `delete_property`, `delete_block_property`, `batch_delete_block_property` returns its reason for any args; `ALWAYS_DELETE` is exactly those seven.
  - `when`, one case each way: `update_property` with `convert_values: true` (in `body`) and with `choices.retire: ["x"]` refused; with `convert_values: false`, `choices.retire: []`, a rename, `add`, `update`, `order`, `classes`, a type change and a cardinality change allowed (review focus 2, 3). `set_block_property` with `""` and `[]` refused; `" "`, `[" "]`, `0`, `false` allowed; `null` per review focus 4. `batch_set_block_property` with entries 0 and 1 valued and entry 2 `[]` names `entry 2` (review focus 5). `batch_insert_block_trees` and `update_tag` are `never` after step 0 (review focus 6, 7), so `entries[0].properties` holding `[]` and `properties.remove` return null.
  - `never`: each `never` tool returns null for representative args, including `update_block` with new text and properties and `save_document`.
  - `dry runs match the openapi`: `DRY_RUN_TOOLS` equals the operations in `connector/vendor/openapi.json` that declare `dry-run`, split into query and body exactly as spec §2 lists, mapped to tool names through the generated tool table. `declaredDryRun` is false for `"true"` as a string, for the wrong place, and for a tool with no declaration (review focus 1).
  - `create_property has no convert_values`: the vendored `createProperty` schema declares no `convert_values`.
  - `messages`: `noDeleteMessage` produces the spec §4 texts for a dry-runnable tool, a non-dry-runnable one and a batch entry, with `worker` and `notes`.

- [ ] **Step 2: Run** `npm --prefix connector test -- deletes`; keep the failures (module not found).

- [ ] **Step 3: Implement** as spec §3.4 and §3.5.

- [ ] **Step 4: Contract.** None for Claude. Run `npm --prefix connector run update:manifest` and confirm `git diff connector/tools-manifest.json` is empty.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check**, one at a time: delete the `update_tag` entry (coverage test fails; it is a `never` entry after step 0); change `delete_block` to `never`; drop the `choices.retire` condition; make the empty check `=== ""` only; make `declaredDryRun` accept a truthy value; move `delete_blocks` to the query list. Confirm a test fails each time. Revert.

- [ ] **Step 7: Commit.** `feat(connector): classify every write tool as a delete or not in one table`. Body: the definition of a delete, the rule kinds, which rules are reported and which are guesses (and step 0's outcome), the openapi pins; no caller yet, so no behaviour change and 0 D1 rows.

**Done when:** every write tool has a rule with its reason, the table matches `ANNOTATIONS` and the openapi, each rule is seen to fail when removed, and the gate is green.

---

### Stage 2: Migration 0008 and the access value

**Goal:** `service_tokens.access` accepts `write-no-delete`, existing rows and `updated_at` survive the rebuild, and the type and rank exist. `verifyServiceToken` still accepts only `read` and `write`, so a `write-no-delete` row cannot authenticate until Stage 3 enforces it, and an unknown value is refused. Lands spec §3.2, §3.6, §9's fail-closed rule, and tests §8.4.

**Files:**
- Create: `connector/migrations/0008_service_token_write_no_delete.sql` as spec §3.6. Header comment: why a rebuild (SQLite cannot alter a CHECK), why an OR chain and not `IN` (0004's header), the column list matching 0006 plus 0007, the hash index recreated, and the measured cost from this stage's test. Follow the `add-d1-migration` skill.
- Modify: `connector/src/auth/service-tokens.ts`: the type, `MODE_RANK`, `rank()`; `verifyServiceToken` refuses (generic invalid-token result) a row whose access is not `read` or `write`, with a comment that Stage 3 widens it to every `MODE_RANK` key.
- Modify: `connector/src/tools/common.ts`: `RequestScope`'s service `access` becomes `ServiceTokenAccess`, so `mcp.ts` typechecks. `scopedResolve` is unchanged in behaviour (the new value cannot arrive yet).
- Modify only if typecheck requires it: a switch over access in `wizard/views.ts` gains the "read-write, no deletes" label. The forms do not offer the value yet.
- Modify: `connector/test/service-tokens.test.ts` (a `migration 0008` block and `verifyServiceToken` cases).

**Interfaces produced:** `ServiceTokenAccess` (three values), `MODE_RANK`, `rank`.

- [ ] **Step 1: Write the failing tests:**
  - `migration 0008 keeps rows` (spec §8.4): rebuild `service_tokens` as 0007 left it from `TEST_MIGRATIONS` (as the 0007 test does), insert a `read` and a `write` row with `updated_at`, `last_used_at` and `revoked_at` set, apply 0008's queries, and read every column back unchanged.
  - `migration 0008 schema`: `d1_migrations` lists it right after 0007; `PRAGMA table_info` shows the same columns in the same order as before; `PRAGMA index_list(service_tokens)` shows `service_tokens_hash` (unique) and the `name` unique index; inserting `write-no-delete` succeeds; `delete` and `''` fail the CHECK; a duplicate hash and a duplicate name are refused.
  - `migration 0008 cost`: D1 `meta` for the rebuild with the two rows, recorded in the header.
  - `store round-trips write-no-delete`: `create` with `access: "write-no-delete"` then `get` and `list` return it; `findByHash` still reads 1 and writes 0.
  - `write-no-delete cannot authenticate yet`: a `write-no-delete` token answers the generic invalid-token result at `/mcp`, with no row written by `touch`. Stage 3 flips this test.
  - `unknown access fails closed`: a row with access `delete` (written with the CHECK bypassed: `PRAGMA ignore_check_constraints = ON` if Miniflare's D1 accepts it, otherwise a test-only table copy without the CHECK swapped in and restored, as the migration tests rebuild tables) answers the generic invalid-token result, not write.

- [ ] **Step 2: Run** `npm --prefix connector test -- service-tokens`; keep the failures (CHECK constraint failed, no such migration, the token authenticating with full write in the unknown-access case).

- [ ] **Step 3: Implement** as spec §3.2 and §3.6.

- [ ] **Step 4: Contract.** None for Claude; `tools-manifest.json` unchanged.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** leave `updated_at` out of the `INSERT ... SELECT` (row test fails); drop the `CREATE UNIQUE INDEX` (index test and duplicate-hash test fail); remove the access check in `verifyServiceToken` (both authentication tests fail). Revert.

- [ ] **Step 7: Commit.** `feat(connector): allow write-no-delete in service_tokens, refused until enforced`. Body: why the rebuild, the measured migration cost, rows kept, the index kept, `/mcp` still 1 read and 0 writes, and why the new value cannot authenticate in this commit.

**Done when:** migration 0008 keeps every row and index, the CHECK takes the three values, an unknown or not-yet-enforced access cannot authenticate, and the gate is green.

---

### Stage 3: Scope and enforcement

**Goal:** a `write-no-delete` token authenticates and gets writes without deletes. `scopedResolve` sets `deletesRefusedBy` from `effectiveMode`; `audited()` refuses from the table before the snapshot; `request()` backstops HTTP `DELETE`; `list_graphs` shows the effective mode; `connector_help`, README §11.8 and line 814 describe the refusal. Lands acceptances 1 (effective mode), 2, 3 and 5, spec §3.3, §3.5, §4, and tests §8.1 and §8.2.

**Files:**
- Modify: `connector/src/graphs.ts`: `deletesRefusedBy?: string` on `ResolvedGraph`.
- Modify: `connector/src/tools/common.ts`: `effectiveMode` (the lower-ranked of the graph's mode and the token's access; OAuth gives the graph's mode); `scopedResolve` as spec §3.3's four cases.
- Modify: `connector/src/auth/service-tokens.ts`: `verifyServiceToken` accepts every `MODE_RANK` key (`Object.hasOwn`), still refusing anything else.
- Modify: `connector/src/audit/log.ts`: the check straight after `resolveGraph(ctx.access, alias, true)` inside the same `try` (spec §3.5); `"no-delete"` joins `REFUSALS`; the header's cost table gains the refused-delete line.
- Modify: `connector/src/tools/semantic.ts`: in `request()`, an HTTP `DELETE` on a graph with `deletesRefusedBy` throws the same `ToolError` unless the request carries the declared dry run (query for `deletePage`, `deleteTag`, `deleteProperty`; body for `deleteBlocks`).
- Modify: `connector/src/tools/handwritten.ts`: `list_graphs` uses `effectiveMode`; its description's "read or write mode" names the three values; `connector_help`'s service-token paragraph says which calls `write-no-delete` refuses, that a declared dry run is allowed, and "don't retry; report what it would delete and leave it to the owner".
- Modify: `README.md` §11.8 (the refusal's text) and line 814 (the same paragraph as `connector_help`).
- Modify: `connector/test/service-tokens.test.ts` (an `HTTP write-no-delete` block), and flip Stage 2's `cannot authenticate yet` test.

**Interfaces produced:** `effectiveMode`, `ResolvedGraph.deletesRefusedBy`, log status `no-delete`.

- [ ] **Step 1: Write the failing tests** (through `mcpHandler` with real D1 and a fake sync fetch that counts requests; token `worker` on alias `notes`):
  - `refuses every delete` (spec §8.1): one table-driven case per refused tool and argument in spec §4(a), each giving `isError` with the exact message (token, alias, tool, entry where there is one), 0 sync requests, and an `audit_log` row with status `refused` holding the message.
  - `a write token still deletes`: the same calls on a `write` token reach the sync fake.
  - `never tools work`: `update_block`, `move_blocks`, `save_document`, `batch_insert_block_trees` with non-empty properties, `promote_page_to_tag`, `refresh_refs`, `update_tag` with `title`, and `insert_block_tree` succeed on `write-no-delete`.
  - `declared dry runs pass`: `delete_page` with `dry-run: true` (query), `delete_blocks` with `body["dry-run"]: true`, and `update_property` with `convert_values: true` and query `dry-run: true` reach sync with `dry-run=true` and audit `dry_run = 1`; a `dry-run` key in an undeclared place, and `"true"` as a string, are refused (review focus 1).
  - `read stays read`: a `read` token refuses writes with the existing message; a `write-no-delete` token on a graph connected read-only answers the read-only refusal naming the token (review focus 8).
  - `list_graphs` shows `write-no-delete`, `write` and `read`, including the read-only-graph cap.
  - `OAuth unaffected`: the same `delete_page` under OAuth reaches sync.
  - `backstop` (spec §8.2): `request()` called directly with a graph carrying `deletesRefusedBy` refuses an HTTP `DELETE` with the same message and makes 0 sync requests, and lets `deletePage` with `dry-run=true` through.
  - `cost`: D1 `meta` for a `/mcp` request on a `write-no-delete` token: 1 row read and 0 written before the tool runs; a refused delete's audit rows read and written equal a read-only refusal's; a repeated `lookupGraph` in the same call reads nothing (review focus 10).

- [ ] **Step 2: Run** `npm --prefix connector test -- service-tokens`; keep the failures (the token refused as invalid, then each delete reaching sync).

- [ ] **Step 3: Implement** as spec §3.3 and §3.5.

- [ ] **Step 4: Contract.** `connector_help`, the `list_graphs` description, README §11.8 and line 814. Run `npm --prefix connector run update:manifest` and confirm `tools-manifest.json` is unchanged (descriptions it records, if any, must still match; if the manifest records the `list_graphs` description, commit the regenerated manifest and say so in the body).

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check**, one at a time: move the check after `takeSnapshot` (0-sync-calls assertion fails); leave `"no-delete"` out of `REFUSALS` (audit status test fails); make `scopedResolve` set `deletesRefusedBy` for `write` too (write-token test fails); make `effectiveMode` ignore the graph's mode (read-only-graph cap fails); drop the backstop (backstop test fails); skip `declaredDryRun` in `audited()` (dry-run test fails). Revert.

- [ ] **Step 7: Commit.** `feat(connector): refuse deletes on write-no-delete service tokens`. Body: where the check sits and why (scope in one place, before the snapshot), the backstop, dry runs allowed only where declared, `list_graphs` effective mode; `/mcp` still 1 read and 0 writes; a refused delete costs what a read-only refusal costs and makes no sync call.

**Done when:** a `write-no-delete` token writes but every classified delete is refused, named, audited and makes no sync call, declared dry runs pass, `read`, `write` and OAuth behave as before, and the gate is green.

---

### Stage 4: Wizard

**Goal:** the owner can create a `write-no-delete` token and edit a token's access among the three values. Moving up needs the confirm page; moving down applies at once. The list shows the access. PR 43's guarantees hold. Lands acceptance 4, spec §3.7 and tests §8.5.

**Files:**
- Modify: `connector/src/wizard/routes.ts`: `parseGraphsAndAccess` accepts the three values with the new message; the redisplay values near lines 463 and 574 accept the three; `isWidening` becomes `added graph || rank(after.access) > rank(before.access)`; the confirm diff carries the access change for the confirm lines.
- Modify: `connector/src/wizard/views.ts`: three radios in rank order ("Read only", "Read and write, no deletes", "Read and write") on create and edit; the confirm lines "gains write, no deletes on <alias>", "gains deletes on <alias>", "gains read-write on <alias>" and "loses deletes on <alias>", with the existing "effective: read only (the graph is read-only)"; the list and detail tag "read-only", "read-write, no deletes" or "read-write".
- Modify: `connector/test/wizard.test.ts`.

**Interfaces produced:** none new.

- [ ] **Step 1: Write the failing tests** (through `createConnector().fetch`):
  - `create write-no-delete`: `POST /tokens/new` with `access=write-no-delete` stores it, the list shows "read-write, no deletes", and the token's first `/mcp` `delete_block` call is refused with the Stage 3 message.
  - `six ordered pairs` (spec §7 risk 8): read to write-no-delete, write-no-delete to write and read to write each show the confirm page with the right gain line and write nothing until confirmed; write to write-no-delete, write to read and write-no-delete to read apply at once (303, one `token_edit` audit row with the access as text).
  - `narrowing confirm that also raises`: removing a graph while raising write-no-delete to write shows the confirm page with "gains deletes" and the loss.
  - `graph caps`: raising to write-no-delete on a graph connected read-only shows "effective: read only".
  - `next request sees the edit` (review focus 9): after write to write-no-delete, the next `/mcp` `delete_page` is refused; after confirming back to write, the next one reaches sync.
  - `unknown value`: `access=delete` on create and on edit answers 400 with the new message, writing nothing.
  - PR 43's stale-form, guard and read-back tests pass unchanged.

- [ ] **Step 2: Run** `npm --prefix connector test -- wizard`; keep the failures.

- [ ] **Step 3: Implement** as spec §3.7.

- [ ] **Step 4: Contract.** None for Claude.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** compare `after.access !== before.access && after.access === "write"` (the old rule shape) in `isWidening` and confirm the read to write-no-delete and write-no-delete to write tests fail; swap two `MODE_RANK` values and confirm a pair test fails. Revert.

- [ ] **Step 7: Commit.** `feat(connector): offer write-no-delete in the service token wizard`. Body: the three values, widening by rank, the confirm lines; wizard D1 costs unchanged (spec §5).

**Done when:** the owner can create and edit `write-no-delete` tokens, every move up needs the confirm, PR 43's tests pass, and the gate is green.

---

### Stage 5: Claude Code settings and docs

**Goal:** Claude Code allows every `logseq-service` tool except the seven delete tools, so an unattended session writes without prompts and an interactive session still prompts before a delete; README §11.12 documents the access values and the three recipes. Lands acceptance 8 and spec §3.8, §3.9, tests §8.6.

**Files:**
- Modify: `.claude/settings.json`: the `mcp__logseq-service__*` entries become every `tools-manifest.json` name minus `ALWAYS_DELETE`, written out explicitly and sorted. No server-wide `mcp__logseq-service` rule, no wildcard. The `mcp__Logseq__` list is unchanged.
- Modify: `scripts/logseq-mcp.test.mjs`: the wiring test as spec §3.8 (allow list equals manifest names minus `ALWAYS_DELETE`, imported from `connector/src/tools/deletes.mjs`; every name is in the manifest; no server-wide or wildcard rule; the `mcp__Logseq__` list is still read-only; `.mcp.json`, deny list and hooks assertions unchanged). Rename the test to say what it now checks.
- Modify: `README.md` §11.12: the three access values and what `write-no-delete` does and does not stop (overwrites are allowed and restorable from the audit log); the **cloud worker**, **connector dev** and **use from another repo** recipes with `mcp.example.com` and the aliases `notes` and `test`; the "delete only with your approval" paragraph from spec §1; the rollback note (revoke `write-no-delete` tokens before reverting the Worker). §11.10 troubleshooting gains a row for the no-delete refusal.
- Modify: `.claude/skills/add-connector-tool/SKILL.md` (or the file the skill uses): a new or changed write tool, or a vendor bump that adds a body field to one, needs its `deletes.mjs` rule checked (spec §7 risk 3).
- Modify: `REVIEW.md` only if the build learned a defect class (for example, a delete reachable through an argument of a tool annotated additive). Otherwise unchanged, and the PR says so.

**Interfaces produced:** none.

- [ ] **Step 1: Write the failing test:** the new wiring test, which fails against today's read-only list.

- [ ] **Step 2: Run** `npm test`; keep the failure.

- [ ] **Step 3: Implement** the settings list (generate it with a one-off node command from the manifest and `ALWAYS_DELETE`; do not commit a generator unless the test needs it) and the docs.

- [ ] **Step 4: Contract.** Check README §11.8, §11.12 and `connector_help` agree on the refusal text and the recipes. Draft the PR's Logseq skill note: under the worker token, deletes come back refused; the skill should dry-run where it can, report what it would delete, and leave the delete to the owner.

- [ ] **Step 5: Run the gate:** `scripts/check.sh`.

- [ ] **Step 6: Mutation check:** add `mcp__logseq-service__delete_page` to the allow list, and separately add `mcp__logseq-service`, and confirm the wiring test fails each time. Revert.

- [ ] **Step 7: Commit.** `docs(connector): allow non-delete logseq-service tools and document write-no-delete tokens`. Body: why the seven delete tools still prompt (the owner's approval), the recipes, no runtime cost.

**Done when:** the allow list is exactly the manifest minus the delete tools and the test pins it, README §11.12 has the values and three recipes with example data only, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **PR body:** the answer to the owner's question (refuse outright; approval happens in the app, through claude.ai or at Claude Code's prompt; an approval queue is a possible follow-up), the Logseq skill note, Stage 1 step 0's outcome for the two guessed rules, the failure each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped (`--upstream` is not run, since no patch changes).
- **After deploy** (spec §9): migration 0008 applies and existing tokens keep their access; create a `write-no-delete` token on `notes`; from a cloud session `list_graphs` shows `write-no-delete`, `insert_block_tree` works, `delete_block` is refused, `delete_page` with `dry-run=true` answers, `get_activity_log` shows the refusal; the next day's usage report is flat.
