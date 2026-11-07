# Property choices and class restrictions: design

Date: 2026-11-06
Issue: Connector #26 (manage property choice sets and node-property class restrictions), with the set-up gaps folded in from the old item 19
Upstream: `logseq/logseq` at `UPSTREAM_REF`, `deps/db-sync`, with patches 0001 to 0025 applied. This work is patch 0026.
Branch: stacked on Phase 1 (PR #37, not merged)

Decisions marked **(issue)** come from the issue. Decisions marked **(call)** were made while writing this design. The owner can overturn any of them; the ones most worth a second look are in section 11.

## 1. Goal

Let Claude set up a property's schema through the connector, so that nothing in the owner's graph schema has to be finished by hand in the app:

1. Add, rename, re-icon, reorder and retire a property's choices (closed values), and get each choice's UUID back.
2. Turn a free-text property that already has values into a choice property, pointing each holder at the matching choice.
3. Set or clear the classes a node property accepts, so that the app's picker offers only, say, Client pages for `for-client`, and the connector refuses anything else.
4. Create a property with its choices and classes in one call.
5. Create or update a tag with the tags it extends and its tag properties, adding or removing one tag property without touching the others (folded from item 19).

Acceptance (issue):

1. Adding a choice to an existing property returns its UUID, and it appears in the app's picker.
2. A node property restricted to Client accepts only Client-tagged pages, through the connector and in the app.
3. `create_property` can define a choice property with its values in one call.
4. Retiring a choice in use is refused without the acknowledgement flag.
5. `connector_help` and the logseq-kb skill document the new options.
6. A property created with choices shows them in the app's picker, and adding one tag property leaves the other tag properties in place.
7. Contract: tool descriptions, `connector_help`, `tools-manifest.json`, README §11.8 and the Logseq skill note in the PR body are updated.

## 2. Context

**What exists today.** `create_property` and `update_property` take only `title`, `type` and `cardinality` (`properties-create` and `properties-update` in `worker/handler/semantic.cljs` call `outliner-property/upsert-property!` and nothing else). `update_tag` takes only a `title`, and `create_tag` answers `{uuid, title}`. So every choice list and class restriction has had to be set up by hand. The 2026-11-06 backfill stopped on this: a Proposal choice on `project-status`, choices for the new `grade` property, and restricting `for-client` to Client, `for-service` to Service, `engagement-partner` to Employee and `service-line` to Portfolio. Several more properties still need choices (`quadrant`, `activity-status`, `context`, `read-status`, `research-status`, `activity-type`, `platform`, `price-range`).

**Why it can't be done with the tools that exist.**

- A choice is a closed-value block: `:block/closed-value-property` and `:block/parent` pointing at the property, an order key, and its title (or `:logseq.property/value` for a number). Only the outliner's `upsert-closed-value!` and `delete-closed-value!` (`deps/outliner/src/logseq/outliner/property.cljs:1215` and `:1291`) build and remove them as the app does, and the semantic API reaches neither.
- The class restriction, `:logseq.property/classes`, is a hidden built-in. `resolve-property` refuses hidden properties, so `set_block_property` can't write it.
- Upstream allows choices only on `default`, `number` and `url` properties (`closed-value-property-types`, `db/frontend/property/type.cljs:30`). Classes only mean something on a `node` property.

**What patch 0021 already gives us.** Choice titles resolve only among the property's own choices (`resolve-choice`, `semantic.cljs:773`), and a value given by title is checked against `:logseq.property/classes` (`title-candidates`, `:694`). A value given by UUID, ident or db id is not: `resolve-ref-entity` goes straight to `d/entity` (`:733-737`), and the outliner's `:node` validator only checks that the entity has a title. So today a non-Client page set by UUID on a Client-restricted property is accepted. Acceptance 2 is false through the connector until that is closed.

**Learnings that shape this design.**

- `docs/solutions/api/title-resolves-outside-allowed-values.md`: the outliner does not check closed values or a property's classes on server writes, so the handler has to.
- `docs/solutions/sync/order-key-not-seeded-for-server-writes.md`: every server path that creates or moves blocks needs keys after the seeded process-wide max. `build-closed-value-tx` (`property.cljs:1201-1204`) takes its key from the property's own last choice, not that max.
- `docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`: one call is one transaction with one tx id.
- `docs/solutions/api/read-hid-built-in-properties.md`: check the read path before trusting a write. `property-response` lists choices in datom order, not editor order, and omits icons and classes, so a reorder or a restriction can't be seen to land.
- `docs/solutions/api/one-error-for-every-failure.md`: each refusal names its entry and reason.
- `patches/0011-semantic-write-guards.patch`: the `acknowledge-*` and `dry-run` query flags on deletes, and the 409 that names what would be lost.

## 3. Design

**Approach (call).** Add optional fields to the four endpoints that already exist (`createProperty`, `updateProperty`, `createTag`, `updateTag`), all in patch 0026. There are no new routes and no new MCP tools. The connector generates its tools from the vendored OpenAPI document, so once the patch extends the spec, `create_property`, `update_property`, `create_tag` and `update_tag` gain the inputs on their own. The connector change is text: HINTS, `connector_help` and the regenerated manifest.

Rejected: a separate `manage_property_choices` tool (more surface for Claude to choose between, and the property and its choices would be written by different calls with different tx ids); Design 2's op-tagged list with per-op results (size L, more to carry across upstream bumps); Design 3's incremental conversion at 500 holders per call (leaves a property half-converted between calls, against "refuse the whole call up front").

### 3.1 Patch 0026 layout

- `worker/handler/semantic.cljs`: `properties-create`, `properties-update`, `tags-create`, `tags-update`, `prepare-ref-property-value`, `property-response`, `tag-response`, and the new helpers below.
- `worker/routes/semantic.cljs`: the OpenAPI document (`openapi-document`, which the build bakes into `worker/dist`) gains the request and response fields in section 4. The spec is generated from the routes file, not edited as a JSON file.
- `test/logseq/db_sync/semantic_property_schema_test.cljs`: new, real outliner on a real conn.

### 3.2 Validate everything, then write once

Every handler that takes the new fields works in two phases:

1. **Resolve and validate** against `@conn`, collecting the first refusal for each entry. Nothing is written if any entry is refused. The checks:
   - Choices are allowed only when the property's type is `default`, `number` or `url`; classes only when it is `node`. A call that changes `type` and adds choices or classes in the same request is judged on the new type, and a property with existing values can't change type in the same call as `convert_values` (refused: `type: change the type and convert values in separate calls`).
   - A choice reference (`choice` in `update`, entries in `order` and `retire`) resolves with `resolve-choice` and no scope, so it never leaves the property's own choices. Unknown: `choices.update 1: no choice "Foo" on project-status`.
   - Titles are trimmed and checked for duplicates up front, against the existing choices and within the request, ignoring case: `choices.add 2: "Active" is already a choice on project-status`. We don't rely on the outliner's `Choice already exists.` notification, though `rejecting` still turns it into a 400 if it fires.
   - A number property's choice title must parse as a number; a URL property's must be a URL (the same check `upsert-closed-value!` runs, run first so the entry can be named).
   - `order` must name every choice exactly once: `choices.order: missing "Done"` or `choices.order 3: "Active" is listed twice`.
   - Retiring a built-in choice (Status, Priority) is refused here, not left to the outliner's throw: `choices.retire 0: "Done" is built in and can't be retired`.
   - A class or tag selector (UUID, ident or title) must resolve to a tag: `classes.add 1: no tag "Clinet"`. A tag property selector must resolve to a non-hidden property: `properties.add 0: no property "for-clinet"`.
   - `extends` may not name the tag itself or one of its descendants: `extends 0: Client already extends Organisation through Company`.
   - An icon must be `{type: "emoji" | "tabler-icon", id}` with a non-blank `id`.
   - On an E2EE graph, `choices` and `convert_values` are refused (choice titles would be stored in plaintext), the same as text values today. Class and tag-property edits carry no text and are allowed.
2. **Write** in one `atomic-write!` (`semantic.cljs:1350`), which wraps `ldb/batch-transact-with-temp-conn!` from patch 0018. Every outliner call for the request (the `upsert-property!`, each `upsert-closed-value!`, each `class-add-property!`) runs inside it, so the call commits as one tx id. The outliner functions call `batch-transact-with-temp-conn!` themselves; nested use is supported (`db/src/logseq/db.cljs:272`), and test 9 proves the single tx id.

### 3.3 Choices

**Create.** `createProperty` with `choices: [{title, icon?, description?}]` creates the property with `upsert-property!`, then calls `upsert-closed-value!` for each choice in the order given.

**Order keys (graft from Design 2).** `upsert-closed-value!` keys a new choice after the property's last choice, which can repeat a key held elsewhere. After each new choice is built, the handler sets its `:block/order` to `(db-order/gen-key)`, which takes the next key after the process-wide max that `handle` already seeds. Keys are therefore unique and increase in the order given. A reorder does the same: it assigns a fresh `(db-order/gen-key)` to each choice in the requested sequence.

**Update.** `updateProperty` takes `choices: {add?, update?, order?, retire?}`, applied in that order within the one transaction (so `order` may name a choice added in the same call by its title):

- `add: [{title, icon?, description?}]`: as on create.
- `update: [{choice, title?, icon?, description?}]`: `upsert-closed-value!` with the choice's `id`. Giving `icon: null` clears it.
- `order: [choice, …]`: a full permutation, re-keyed as above.
- `retire: [choice, …]`: see 3.4.

**Read-back (graft from Design 3).** `property-response` lists choices through `property-choices`, so in editor order, and each choice gains `icon` and `description` when set. Properties of type `node` gain `classes: [{uuid, title, ident}]`. After a write the handler re-reads the property from `@conn` and checks that every added or renamed title, the requested order and the requested classes are present; if one isn't, it answers 500 naming what is missing rather than reporting success. In practice this is a guard against outliner changes on an upstream bump.

### 3.4 Retiring a choice

The holders of a choice are counted with one `:avet` datom range on the property's ident and the choice's id.

- No holders: the choice is removed with `delete-closed-value!`.
- Holders and no `acknowledge-holders=true`: 409, nothing written, and the message names the count and the flag, in the 0011 style: `choices.retire 0: "Proposal" is held by 4 blocks; set acknowledge-holders=true to remove it from them, or dry-run=true to preview`. The body lists `{choice, title, holders}` for each retired choice that has holders.
- With `acknowledge-holders=true` (graft from Design 2): the handler first retracts each holder's datom for that choice explicitly, then calls `delete-closed-value!`. It does not rely on the outliner's delete to clean up dangling refs. After the write it checks that no holder still points at the choice.
- `dry-run=true` runs the same work on `dry-run-conn` and returns the same response shape, with nothing stored.

Both flags are query parameters on `updateProperty`, as on the delete endpoints (call; see section 11).

### 3.5 Converting text values to choices

`updateProperty` with `convert_values: true` turns a `default`-type property whose holders have text value blocks into a choice property, using the choices that exist after this call's `add`:

1. One `:avet` scan of the property's datoms collects every holder and its value blocks.
2. Each distinct value text is matched to a choice title: exactly first, then ignoring case.
3. If any text matches no choice, the whole call is refused, listing every unmatched text: `convert_values: no choice matches "Paused", "On hold"; add them under choices.add in the same call`. Nothing is written.
4. Otherwise each holder's datom for an old value block is retracted and one for the matching choice added (a cardinality-many holder with "Active" and "active" ends with one ref), and the old value blocks are deleted with `outliner-core/delete-blocks`.
5. The response carries `converted: {values, holders}`. On dry-run it also carries the mapping table (graft from Design 2): `[{text, choice: {uuid, title}, holders}]`, one row per distinct text, no holder lists.

`convert_values` on a property that already has choices but no text values is a no-op that answers `converted: {values: 0, holders: 0}`. Number and URL properties are out of scope for conversion (section 10).

Rejected: upstream's `add-existing-values-to-closed-values!`, which the app uses to promote existing values. It turns each existing value block into a choice, so the twelve blocks that each say "Active" would become twelve "Active" choices, and "active" another. Matching onto named choices is what the owner's backfill needs.

### 3.6 Class restrictions

`createProperty` takes `classes: [tag selector]`. `updateProperty` takes `classes: {set: […]}`, `{add: […]}` or `{remove: […]}`; exactly one key, and `{set: []}` clears the restriction. They write `:logseq.property/classes` directly in the transaction (the attribute is hidden from `set_block_property`, but the handler writes datoms itself).

Setting a restriction doesn't change existing values. The response reports `out_of_class: <count>` for holders whose value is not an instance of any of the classes, so the caller can see what the app's picker would now refuse (call; a gate is an open question).

**Enforcing it on UUID, ident and number values (the key change for acceptance 2).** `prepare-ref-property-value` gains the same check `title-candidates` makes: when the property has `:logseq.property/classes` and the value was given by UUID, ident or db id, the resolved entity must satisfy `db-db/class-instance?` for at least one of them. Otherwise the value is refused with the existing wording, `no #Client object <uuid>`. Because `set_block_property`, `batch_set_block_property`, `insert_block_tree` and `batch_insert_block_trees` all go through `prepare-ref-property-value`, one check covers them all. The app enforces the restriction through its own picker once the attribute is set.

### 3.7 Tags

- `createTag` takes `extends: [tag selector]` and `properties: [property selector]`.
- `updateTag` takes `title?`, `extends: [tag selector]` (replaces the set; it must name at least one tag) and `properties: {add | remove | set: [property selector]}`. At least one field is required, so `title` is no longer mandatory.
- Tag properties go through `class-add-property!` and `class-remove-property!`. `add` and `remove` leave the tag's other properties in place (folded item 19). `set` adds what is missing and removes what is not listed, and `class-remove-property!` already skips built-in class properties; the test asserts that.
- `:logseq.property.class/extends` is written with `set-block-property!`.
- `tag-response` gains `extends: [{uuid, title}]` and `properties: [{uuid, title, ident}]`, and `createTag` answers with the full `tag-response` instead of `{uuid, title}`.

### 3.8 Not done

Resolving node-property titles against entities created earlier in the same `batch_insert_block_trees` call (the issue's optional extra) is left out; it touches the tree preparation, not the schema endpoints.

## 4. Tool contract

No new tools, none renamed. Every new input is optional, so existing calls keep their meaning, except for the class check in the last bullet.

- **`create_property`** adds `choices: [{title, icon?, description?}]` and `classes: [tag UUID | ident | title]`. Output: `PropertyResponse`, whose `choices` carry `uuid`, `title`, `icon?` and `description?` in editor order, plus `classes` for a node property.
- **`update_property`**:
  - adds `choices: {add?: [{title, icon?, description?}], update?: [{choice, title?, icon?, description?}], order?: [choice], retire?: [choice]}`, where `choice` is a UUID, ident or title of one of the property's own choices;
  - adds `classes: {set | add | remove: [tag selector]}`;
  - adds `convert_values: boolean`;
  - adds query flags `dry-run` and `acknowledge-holders`;
  - output: `PropertyResponse` plus `retired: [{uuid, title, holders}]`, `converted: {values, holders}` and `out_of_class` when relevant. On dry-run the same shape with `dry-run: true` and the conversion mapping, nothing written.
  - refusals: 400 naming the entry (`choices.retire 0: no choice "X" on project-status`, `classes: grade is not a node property`, `choices: for-client is a node property and can't have choices`, `convert_values: no choice matches "a", "b"`); 409 for a retire with holders and no `acknowledge-holders`.
- **`create_tag`** adds `extends: [tag selector]` and `properties: [property selector]`, and now answers with the full `TagResponse`.
- **`update_tag`**: `title` becomes optional (at least one field required); adds `extends: [tag selector]` (set) and `properties: {add | remove | set: [property selector]}`. `TagResponse` gains `extends` and `properties`.
- **`set_block_property`, `batch_set_block_property`, `insert_block_tree`, `batch_insert_block_trees`**: behaviour change only. A UUID or ident value that isn't an instance of the property's classes is now refused, as a title already was.

Connector changes:

- HINTS in `connector/src/tools/semantic.ts` for the four tools: give a property its choices and classes when creating it; choices for `default`, `number` and `url`, classes for `node`; retire needs `acknowledge-holders` and `dry-run` previews; `convert_values` refuses unmatched text, so add those as choices in the same call; tag properties take `add` and `remove`.
- A `connector_help` paragraph in `connector/src/tools/handwritten.ts` saying the same, plus the E2EE refusal and the stricter class check.
- `npm --prefix connector run update:manifest`.
- `kb_index`: `KB_INDEX_WRITE_TOOLS` already holds `update_tag`. `create_tag` only creates a tag with no objects, so it needs no invalidation. The plan checks whether `kb-index` caches property values; if it does, `update_property` joins the set (a conversion changes holders' values).
- README §11.8, and the Logseq skill note in the PR body: create properties with choices and classes in one call, retire with acknowledgement after a dry run, convert free-text properties with `convert_values`, use `properties.add` for tag properties, and expect UUID values outside a property's classes to be refused.

## 5. Cost on the Free plan

- **D1:** none. All the work is in the sync Durable Object's in-memory DataScript; nothing in this change reads or writes D1.
- **Worker requests:** one per call, and one rate-limited write. The 2026-11-06 backfill is about 15 properties and 4 tags, so about 20 requests, 0.02% of the 100k daily cap.
- **CPU:** the connector front Worker only forwards. The DO does the work: a retire counts holders with one `:avet` range per retired choice, and a conversion scans the property's datoms once, O(holders), in memory.
- **Workers AI and Vectorize:** the semantic cron indexer sees changed blocks through the block-changes feed. A conversion over N holders re-embeds at most N small blocks once (plus the new choice blocks), so tens of neurons for the backfill against the 10k daily cap. Stored dimensions change only by the few new choice blocks.
- **Response size:** counts and a mapping table with one row per distinct text, never holder lists, so responses stay small for Claude's context.

## 6. Safety

- **Nothing half-written.** Every request validates all entries first and then writes one transaction with one tx id; a failure anywhere writes nothing.
- **No silent loss.** Retiring a choice with holders needs `acknowledge-holders=true`; the 409 names the count. Conversion refuses when any text is unmatched. Both have `dry-run`.
- **No silent success.** Each write re-reads the property or tag and checks every requested choice, order and class is there.
- **Errors name the entry and reason** for every refusal path in 3.2.
- **Built-ins are protected.** Built-in choices can't be retired, and tag `set` never removes built-in class properties.
- **Behaviour change, stated.** The UUID and ident class check refuses writes that work today. It is called out in `connector_help` and the skill note, and `get_graph_health` is unchanged.
- **E2EE graphs** refuse `choices` and `convert_values`.
- **Path parameters** for `updateProperty` and `updateTag` keep the re-encoding from patch 0016 (qualified idents contain `/`).

## 7. Risks

| Risk | Mitigation |
|---|---|
| `upsert-closed-value!` repeats an order key held elsewhere | Re-key each new choice with `(db-order/gen-key)` after the seeded max; test 2 asserts unique, increasing keys |
| Several outliner calls commit under different tx ids | One `atomic-write!`; test 9 |
| A wrong conversion match loses text | Exact then case-insensitive only; refuse on any unmatched text; dry-run mapping; test 5 checks every holder reads back its choice |
| `upsert-closed-value!` returns nil or throws a notification | Validation runs first; `rejecting` turns any notification into a 400 |
| The stricter class check breaks values the owner set by UUID | Intended; documented in the skill note; `out_of_class` shows how many existing values are affected |
| An upstream bump changes the closed-value or class-property functions | The read-back check and the real-outliner tests fail loudly; CI runs upstream's suite on every bump |
| The OpenAPI `oneOf` for `classes` and `properties` converts badly to the generated zod schema | The shapes are objects with one array key each (no array-or-object union); the manifest check shows the generated schema |

## 8. Testing

All tests are real-outliner db-sync tests in `semantic_property_schema_test.cljs`, run through the handler on a real conn. No stubs (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Each is first seen to fail on 0025 alone, and the failure is quoted in the PR.

1. `create_property` with three choices returns three UUIDs. The db shows `:block/closed-value-property` and parent equal to the property, distinct increasing `:block/order`, and `db-property/scoped-closed-values` (what the app's picker reads) lists them. `getProperty` lists them in order.
2. `choices.add` on a property that has choices returns the new UUID, ordered after the existing ones; its key is unique against a page with many blocks (0008).
3. `update` renames and re-icons a choice and the change reads back; `order` changes the read-back order; an incomplete or repeated `order` is refused naming the entry.
4. `retire` of a choice with two holders, without the flag: 409 naming the count, db unchanged. With `acknowledge-holders=true`: the choice is gone and neither holder has a value. With `dry-run=true`: the same response, db unchanged (compare before and after).
5. `convert_values`: holders with "Active", "active" and "Done" and choices Active and Done end pointing at the choices, with the old value blocks deleted. With an extra "Paused" the call is refused listing "Paused", and nothing changes. Dry-run returns the mapping.
6. `classes.set` Client: a non-Client page by title is refused (0021); by UUID and by ident it is now refused; a Client page by UUID is accepted and reads back; the same holds through `batch_set_block_property` and `insert_block_tree`. `classes.remove` clears the restriction. `classes` on a `default` property is refused.
7. `update_tag` `properties.add` on a tag with two properties gives three; `remove` of one leaves the others; `set` keeps built-in class properties. `create_tag` with `extends` and `properties` reads back through `getTag`. An `extends` cycle is refused.
8. Each refusal path in 3.2 answers with its entry and reason. Retiring a built-in Status choice is refused. Choices on an E2EE graph are refused.
9. One `create_property` with choices, and one `update_property` with add, order and retire, each produce a single tx id in the sync log.
10. Mutation check (`docs/solutions/testing/untested-rules-survive-mutation.md`): flipping the class check, the holder count and the unmatched-text refusal each makes a test fail.

Connector: vitest checks that the generated tools expose the new fields (through the tools-manifest check) and the `connector_help` text.

## 9. Rollout and verification

1. Build patch 0026 on top of 0025 with the `add-upstream-patch` skill; vendor the regenerated `openapi.json` and `semantic_api_tools.mjs`; update the connector text with `add-connector-tool`.
2. `scripts/check.sh --upstream` on HEAD; the PR names the commit and repeats what was skipped. CI also runs upstream's db-sync suite, including the new tests.
3. The PR is stacked on Phase 1 (PR #37) and merges after it. Merging to main deploys.
4. After deploy, on the live graph:
   - add a Proposal choice to `project-status` through the connector, and see it in the app's picker with the UUID returned (acceptance 1);
   - restrict `for-client` to Client, and confirm the app's picker offers only Client pages and that `set_block_property` with a non-Client page UUID is refused (acceptance 2);
   - create `grade` with its choices in one call and see them in the picker (acceptances 3 and 6).
5. Run the backfill: dry-run each conversion first, then the real call.
6. Update README §11.8, and give the Logseq skill note in the PR body.

## 10. Out of scope

- The 500 when promoting an empty page into a tag (item 16).
- Resolving node-property titles against entities created earlier in the same batch.
- Changing a property's type with existing values (e.g. text to node).
- Converting `number` or `url` properties' existing values to choices.
- Choices scoped to tags (`:logseq.property/choice-classes`) and choice-level `exclude` rules.
- `replace-with` on retire (re-pointing holders to another choice in the same call); see section 11.
- A graph-health reason for values outside a property's classes.

## 11. Open questions for the owner

1. **`replace-with` on retire.** Should retiring a choice be able to move its holders to another choice in the same transaction (e.g. retire "In review" into "Active"), instead of clearing them? It is a small addition, but it is another rule to test. Today you would convert by hand, then retire.
2. **Restricting a property that already has out-of-class values.** This design writes the restriction and reports `out_of_class`. Would you rather it refused with a 409 unless acknowledged, like a retire?
3. **The stricter check on UUID values.** Do you know of values set by UUID that sit outside a property's intended class (e.g. a non-Client page in `for-client`)? Those writes will now be refused once the class is set; the `out_of_class` count will show them.
4. **Flag placement.** `dry-run` and `acknowledge-holders` are query flags here, as on the delete endpoints. The bulk endpoints take `dry-run` in the body. Keep the delete convention for `update_property`, or follow the bulk one?
5. **Case-insensitive matching in conversion.** "active" maps to the choice "Active". Is that what you want for every property in the backfill, or should conversion match exactly only?
6. **Icons.** Choices take `{type: "emoji" | "tabler-icon", id}`. Is that enough, or do you want to set colours too?

## As built

Patch 0026 follows this design: the four existing endpoints gain optional fields, there are no new routes or tools, and every call validates all its fields, writes in one `atomic-write!` and reads the result back (500 if it didn't land). The tools manifest did not change, because the new inputs come from the generated OpenAPI. The differences:

- **Renames may chain, and cycles are refused (3.3).** The design applied `choices.update` entries as listed. As built, `validate-choices` puts each rename after the rename of the choice that holds its new title, so a chain works in any order. Titles are compared exactly as stored, as `upsert-closed-value!` compares them. Renames that pass titles round a cycle (a swap, a three-way rotation) are refused before anything is written, naming the entry and the cycle.
- **`choices.order` names the titles the call leaves (3.3).** A title that a rename frees and an add or another rename takes names its new owner. A title the call frees and nothing takes still names its old choice.
- **The default-value choice counts as held (3.4).** Retiring the choice that is the property's default value would have cleared the default with no 409. It is now marked `default: true`, needs `acknowledge-holders=true`, and the dry run and 200 response report `default: true`.
- **Built-in properties keep their classes (3.6).** `classes` on a built-in property (Assignee's Page restriction, for instance) is refused for set, add, remove and `set: []`, because the handler's raw transact skipped the outliner's built-in guard.
- **`out_of_class` skips empty placeholders (3.6).** Holders left at Logseq's empty placeholder are not counted, on cardinality one and many.
- **Conversion is stricter than 3.5.** `convert_values` also refuses a property that has a default value, and a text value block with child blocks (naming its holder and the count), because `delete-blocks!` removes children and keeps a lone default-value block. Holders of the empty placeholder are left as they are. It converts only value blocks the property itself made, and skips only the property's own choices, so another property's value block or choice as a holder is a 400. The dry-run mapping is as designed.
- **Tags refuse hidden built-in parents (3.7).** `extends` naming a built-in tag that the app's picker hides (`ldb/extends-hidden-tags`: Tag, Page, Journal, Property, Query, Template and others) is refused, as well as a self-extension or a descendant. Properties take `add`, `remove` or `set` as designed, and `set` keeps built-in properties.
- **Flags.** `dry-run` and `acknowledge-holders` stayed query parameters (open question 4).

Not built, and now on the README backlog: `replace-with` on retire (open question 1), and resolving node-property titles against entities created earlier in the same `batch_insert_block_trees` call (3.8). The empty-page-into-a-tag 500 belongs to item 16.
