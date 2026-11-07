# Property choices and class restrictions: implementation plan

> **For agentic workers:** build this stage by stage, in order. Each stage starts with its failing tests, ends with `scripts/check.sh --upstream` green on HEAD, and is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude can set up a property's schema through the connector: add, rename, re-icon, reorder and retire choices; convert a free-text property to choices; restrict a node property to classes (enforced for values given by UUID or ident too); create a property with its choices and classes in one call; and give a tag the tags it extends and its tag properties, adding or removing one without touching the others.

**Architecture:**
- **One upstream patch, `patches/0026-semantic-property-choices-and-class-restrictions.patch`,** on top of 0001 to 0025. It adds optional fields to the four endpoints that already exist (`createProperty`, `updateProperty`, `createTag`, `updateTag`), widens `PropertyResponse` and `TagResponse`, and adds the class check to `prepare-ref-property-value`. No new routes, so no new or renamed tools.
- **Each stage regenerates patch 0026 as a whole** from a baseline at 0025 (the patch is unmerged, so amending it is allowed; `add-upstream-patch` *Rules*). After stage N the patch holds stages 1 to N.
- **The connector** gains its new inputs from the re-vendored OpenAPI document. Its own changes are text: `HINTS` in `connector/src/tools/semantic.ts`, `CONNECTOR_HELP` in `connector/src/tools/handwritten.ts`, and tests in `connector/test/tools.test.ts`.

**Tech stack:** ClojureScript in upstream `deps/db-sync` (shadow-cljs `:node-test`, the real outliner on a real conn); TypeScript connector with vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-11-06-property-choices-and-class-restrictions-design.md`. Read it first. It is the authority; section numbers below (§3.2 and so on) are the spec's.

## Global constraints

- **Names, exactly:**
  - the patch is `patches/0026-semantic-property-choices-and-class-restrictions.patch`;
  - the new upstream test namespace is `logseq.db-sync.semantic-property-schema-test` in `deps/db-sync/test/logseq/db_sync/semantic_property_schema_test.cljs`, required from `test_runner.cljs` beside `semantic-today-tz-test`;
  - request fields: `choices`, `classes`, `convert_values` (properties); `extends`, `properties` (tags);
  - query flags on `updateProperty`: `dry-run` and `acknowledge-holders`, declared with the existing `delete-flag-parameter` helper in `worker/routes/semantic.cljs` (spec §11 question 4: the delete convention is kept unless the owner says otherwise);
  - response fields: `choices[].icon`, `choices[].description`, `classes`, `retired`, `converted`, `out_of_class`, `dry-run`, `mapping` (properties); `extends`, `properties` (tags).
- **Validate everything, then write once** (§3.2). Every handler collects the first refusal per entry against `@conn` before writing; any refusal writes nothing. All writes for one request go through `atomic-write!` (`semantic.cljs:1350`), so one call is one tx id (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`).
- **Errors name the entry and reason,** in the spec's wording: `choices.add 2: "Active" is already a choice on project-status`, `classes.add 1: no tag "Clinet"`, `properties.add 0: no property "for-clinet"`, `extends 0: Client already extends Organisation through Company`. Never one generic message (`docs/solutions/api/one-error-for-every-failure.md`).
- **Name the allowed set for every lookup.** Choice references resolve with `resolve-choice` among the property's own choices only; class selectors only among tags; tag-property selectors only among non-hidden properties (`docs/solutions/api/title-resolves-outside-allowed-values.md`). Tests create a decoy first: a page or a choice on another property with the same title.
- **No silent success.** Every write re-reads the property or tag from `@conn` and answers 500 naming what is missing if a requested title, order, class, extends or tag property isn't there (§3.3 *Read-back*).
- **Order keys.** Every new or reordered choice gets `(db-order/gen-key)` after the seeded process-wide max, never the key `build-closed-value-tx` picks (`docs/solutions/sync/order-key-not-seeded-for-server-writes.md`).
- **Tests run the real outliner** on a real conn through `sync-handler/handle-http` (or the handler's request entry point the other `semantic_*_test.cljs` files use). No stubs (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`). Each new test is first seen to fail; keep the failure text for the PR.
- **Path parameters** for `updateProperty` and `updateTag` keep patch 0016's re-encoding; one test per stage that touches those routes uses a qualified ident (`user.property/…`) in the path.
- **Free plan.** Nothing here reads or writes D1. Holder counts use one `:avet` range per retired choice; conversion scans the property's datoms once. Responses carry counts and one mapping row per distinct text, never holder lists (§5).
- **Commits** follow `type(scope): what changed` (scopes `api`, `connector`), with a body that says the cause, the change and what the tests prove, and end with exactly:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015xpvwUXDcduYn1NQgryha5
  ```

- **Never commit** a graph name, page UUID or hostname. Tests and docs use `sync.example.com` and `mcp.example.com`.

### Working on patch 0026 (every stage)

Follow the `add-upstream-patch` skill. Once, before stage 1:

```bash
rm -rf .upstream && scripts/fetch-upstream.sh .upstream      # applies 0001-0025
git -C .upstream add -A && git -C .upstream commit -qm baseline
```

In every stage, after the code and tests pass:

```bash
scripts/build.sh .upstream
(cd .upstream/deps/db-sync && pnpm test)                     # or the namespace filter from patch 0023
git -C .upstream add -A && git -C .upstream diff --cached baseline > patches/0026-semantic-property-choices-and-class-restrictions.patch
rm -rf "$SCRATCH/up" && scripts/fetch-upstream.sh "$SCRATCH/up"   # all 26 patches apply from scratch
scripts/vendor-upstream-api.sh .upstream
node connector/scripts/check-tools-manifest.mjs               # expected: unchanged (no routes added)
scripts/check.sh --upstream
```

`$SCRATCH` is the session's scratchpad. The tools manifest records only name, method and path, so it should not change in any stage; if it does, a route moved by mistake. `connector/vendor/` is not committed; CI rebuilds it from the patches, so the connector tests that read new fields pass in CI only if the patch carries them.

### Read before starting

- `REVIEW.md`, sections *API and patches*, *Contract and docs* and *Cost*.
- `patches/0021-semantic-choice-values-scoped-to-property.patch` (`resolve-choice`, `property-choices`, `title-candidates`) and `patches/0011-semantic-write-guards.patch` (`loss-acknowledgements`, the 409 wording, `dry-run-conn`). Patch 0026 must not undo either.
- The `docs/solutions` entries listed in spec §2.

## Review focus

Inputs the spec implies that no headline test exercises. Each is pinned by a test in the stage named.

1. **A UUID value outside the classes through every write path.** `set_block_property`, `batch_set_block_property`, `insert_block_tree` and `batch_insert_block_trees` all refuse it, and a Client page given by UUID still succeeds (Stage 1).
2. **A title duplicated only by case, within the request and against existing choices,** and a choice title that matches a choice on *another* property (the decoy must not count as a duplicate) (Stage 3).
3. **`order` naming a choice added in the same call by its title,** and an `order` that is missing one or repeats one (Stage 3).
4. **Retire with holders on a cardinality-many property,** where one holder also holds a second choice that survives (Stage 4).
5. **Conversion where one cardinality-many holder has both "Active" and "active",** which ends with one ref, not two (Stage 5).
6. **`properties.set` on a tag that has built-in class properties:** they stay (Stage 2).
7. **A qualified ident in the `updateProperty` and `updateTag` paths** still resolves after the new body fields (Stages 1 and 2).

---

### Stage 1: Read-back of the schema, class restrictions, and the class check on UUID and ident values

**Goal:** `getProperty` shows what a schema write will store (choices in editor order with icon and description; `classes` on a node property), `createProperty` and `updateProperty` take `classes`, and a value given by UUID, ident or db id is refused when it isn't an instance of the property's classes. This stage lands acceptance 2 through the connector and lays down the validate-then-write shape the later stages extend.

**Files:**
- Create: `patches/0026-semantic-property-choices-and-class-restrictions.patch`. Inside upstream it changes:
  - `deps/db-sync/src/logseq/db_sync/worker/handler/semantic.cljs`: `property-choice-response` (adds `icon`, `description` when set), `property-response` (choices through `property-choices`, in editor order; `classes: [{uuid, title, ident}]` for `:node`), `prepare-ref-property-value` (class check), `properties-create`, `properties-update`, and new private helpers `resolve-tag-selector`, `validate-classes`, `class-tx`, `out-of-class-count`, `verify-property-schema!`;
  - `deps/db-sync/src/logseq/db_sync/worker/routes/semantic.cljs`: `createProperty` request gains `classes: [string]`; `updateProperty` request gains `classes: {set | add | remove: [string]}` (one object with three optional array keys, no `oneOf`); `PropertyResponse` gains `classes` and `out_of_class`, and choice items gain `icon` and `description`; the operation descriptions (line ~160) say what `classes` does and that UUID values outside them are refused;
  - `deps/db-sync/test/logseq/db_sync/semantic_property_schema_test.cljs` (new) and `test_runner.cljs`.
- Modify: `connector/src/tools/semantic.ts` (`HINTS` for `create_property`, `update_property`), `connector/src/tools/handwritten.ts` (`CONNECTOR_HELP` sentence), `connector/test/tools.test.ts`.

**Interfaces produced (used by later stages):**
- `(resolve-tag-selector db selector) -> entity | nil`: UUID, ident or title, only among class entities.
- `(validate-classes db property field selectors) -> {:ok [entity…]} | {:error "classes.add 1: no tag \"Clinet\""}`.
- `(verify-property-schema! db property-uuid expected) -> nil | throws ex-info {:status 500}` where `expected` is `{:titles #{…} :order [uuid…] :classes #{uuid…}}`, each key optional. Later stages add `:retired` and `:no-holders`.
- A request-level `refusal` accumulator: a vector of `{:entry "classes.add 1" :reason "…"}`, rendered as `entry: reason`, the first per entry, joined with `; `.

- [ ] **Step 1: Write the failing tests** in `semantic_property_schema_test.cljs`, on a graph with tags Client and Service, Client pages "Acme" and "Bolt", a Service page "Audit", and a decoy plain page titled "Acme Ltd":
  - `get-property-lists-choices-in-editor-order-test`: on a property with choices A, B, C whose datoms were written C, A, B but keyed A < B < C, `getProperty` lists A, B, C; a choice with an icon and description reads them back.
  - `classes-set-restricts-node-property-test` (spec test 6): `updateProperty for-client {classes: {set: ["Client"]}}` answers `classes` with Client; `setBlockProperty` with "Audit" by title is refused (0021, already passes), by UUID and by ident is refused with `no #Client object <uuid>`; "Acme" by UUID is accepted and reads back.
  - `class-check-covers-every-write-path-test`: the "Audit" UUID is refused through `batchSetBlockProperty` (naming its entry), `insertBlockTree` and `batchInsertBlockTrees`; nothing is written in each case.
  - `classes-add-and-remove-test`: `add: ["Service"]` then "Audit" by UUID is accepted; `remove: ["Client", "Service"]` clears it, and `{set: []}` on a restricted property clears it too.
  - `create-property-with-classes-test`: `createProperty {title "engagement-partner", type "node", classes ["Client"]}` reads back with `classes` through `getProperty`.
  - `out-of-class-reported-test`: a property with values Acme and Audit, then `classes.set ["Client"]` answers `out_of_class: 1` and leaves both values in place.
  - `classes-refusals-test`: `classes` on a `default` property: `classes: grade is not a node property`; an unknown tag: `classes.add 1: no tag "Clinet"`; the decoy page title "Acme Ltd" as a class is refused (not a tag); more than one of `set`, `add`, `remove`: `classes: give exactly one of set, add or remove`.
  - `update-property-qualified-ident-path-test`: `updateProperty` with `user.property/for-client` URL-encoded in the path applies `classes`.
  - `classes-write-is-one-transaction-test`: a `createProperty` with `classes` produces one tx id in the sync log.

- [ ] **Step 2: Run the namespace** and keep the failures (unknown keys ignored, `classes` missing from the response, UUID values accepted).

- [ ] **Step 3: Implement.**
  - `property-response` uses `property-choices` for order; `property-choice-response` adds `:icon` (`:logseq.property/icon`) and `:description` (`:logseq.property/description` title) when present.
  - The class check in `prepare-ref-property-value`: when the property has `:logseq.property/classes` and the value was not resolved through `title-candidates`, the entity must satisfy `db-db/class-instance?` for at least one class; otherwise refuse with the same wording `title-candidates` uses.
  - `classes` writes `:logseq.property/classes` datoms directly inside `atomic-write!` (it is hidden from `set_block_property`, but the handler writes its own datoms). `set` retracts what isn't listed.
  - `out-of-class-count` scans the property's `:avet` datoms once and counts holders whose value is an instance of none of the classes.
  - After the write, `verify-property-schema!` with `:classes`.

- [ ] **Step 4: Connector text and tests.**
  - `HINTS.create_property`: give a node property its classes when creating it. `HINTS.update_property`: `classes` takes exactly one of `set`, `add` or `remove`; `{set: []}` clears; `out_of_class` counts existing values the restriction would now refuse.
  - `CONNECTOR_HELP`: one sentence that a property restricted to classes refuses any value (by title, UUID or ident) that isn't tagged with one of them.
  - `tools.test.ts`: `create_property` and `update_property` input schemas have `classes`; `connector_help` contains `"restricted to classes"`.

- [ ] **Step 5: Regenerate the patch, re-vendor and run the gate** (procedure above). Confirm the manifest check reports no change.

- [ ] **Step 6: Mutation check** (`docs/solutions/testing/untested-rules-survive-mutation.md`): invert the `class-instance?` test in `prepare-ref-property-value` and confirm `classes-set-restricts-node-property-test` and `class-check-covers-every-write-path-test` fail; break `out-of-class-count` (return 0) and confirm `out-of-class-reported-test` fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): restrict node properties to classes and check UUID values against them`.

**Done when:** a non-Client page by UUID is refused on a Client-restricted property through all four write paths, `getProperty` shows choices in editor order and `classes`, and the gate is green.

---

### Stage 2: Tags take `extends` and tag properties, with add and remove modes

**Goal:** `createTag` and `updateTag` set the tags a tag extends and its tag properties; `properties.add` and `properties.remove` leave the tag's other properties in place (folded item 19); `TagResponse` shows both.

**Files:**
- Modify (inside patch 0026): `semantic.cljs` (`tag-response`, `tags-create`, `tags-update`, new `validate-extends`, `resolve-property-selector`, `verify-tag-schema!`); `routes/semantic.cljs` (`createTag` request: `extends`, `properties`; `updateTag` request: `required` drops `title`, adds `extends: [string]`, `properties: {add | remove | set: [string]}`; `createTag`'s 201 becomes the full `TagResponse`; `TagResponse` gains `extends` and `properties`; `updateTag`'s description stops saying it only renames); `semantic_property_schema_test.cljs`.
- Modify: `connector/src/tools/semantic.ts` (`HINTS` for `create_tag`, `update_tag`), `handwritten.ts`, `connector/test/tools.test.ts`.
- `connector/src/tools/kb-index.ts`: no change. `KB_INDEX_WRITE_TOOLS` already holds `update_tag` (an `extends` change moves pages between buckets), and `create_tag` makes a tag with no objects. Record this in the commit body.

**Interfaces produced:**
- `TagResponse`: `{uuid, ident, title, extends: [{uuid, title}], properties: [{uuid, title, ident}]}`.
- `(resolve-property-selector db selector)`: UUID, ident or title, only among non-hidden property entities (reuses `resolve-property`).

- [ ] **Step 1: Write the failing tests** (spec test 7), with tags Organisation, Company (extends Organisation) and Client (extends Company), and properties for-client, for-service and engagement-partner:
  - `update-tag-properties-add-keeps-others-test`: a tag with two tag properties, `properties: {add: ["engagement-partner"]}` gives three; `remove: ["for-service"]` leaves the other two; `getTag` agrees.
  - `update-tag-properties-set-keeps-built-ins-test`: on a tag that has a built-in class property, `set: ["for-client"]` keeps the built-in and leaves exactly one user property.
  - `create-tag-with-extends-and-properties-test`: `createTag {title "Portfolio", extends ["Organisation"], properties ["for-client"]}` answers the full `TagResponse` and reads back through `getTag`.
  - `update-tag-extends-replaces-test`: `extends ["Organisation"]` replaces the set; `extends []` is refused (`extends: name at least one tag`).
  - `extends-cycle-refused-test`: `updateTag Organisation {extends ["Client"]}` is refused with `extends 0: Client already extends Organisation through Company`; extending itself is refused; nothing changes.
  - `tag-refusals-test`: `properties.add 0: no property "for-clinet"`; a hidden built-in property as a tag property is refused; an empty `updateTag` body is refused (`give at least one of title, extends or properties`); a title-only `updateTag` still renames (existing behaviour).
  - `update-tag-qualified-ident-path-test` and `tag-write-is-one-transaction-test`.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement.** Validate every selector first. Inside one `atomic-write!`: `:logseq.property.class/extends` with `outliner-property/set-block-property!`; tag properties with `class-add-property!` and `class-remove-property!`; `set` adds what is missing and removes what isn't listed, relying on `class-remove-property!` skipping built-ins (asserted by the test). The cycle check walks `:logseq.property.class/extends` from each named tag and names the path. Then `verify-tag-schema!`.

- [ ] **Step 4: Connector.** `HINTS.update_tag`: use `properties.add` or `properties.remove` to change one tag property and keep the rest; `set` replaces the user properties; `extends` replaces the set. `HINTS.create_tag`: give the tag its `extends` and `properties` in the same call. `CONNECTOR_HELP` gets one sentence on tag properties' add and remove modes. `tools.test.ts`: `update_tag`'s schema no longer requires `title` and has `extends` and `properties`; `connector_help` contains `"properties.add"`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** make `add` behave as `set` and confirm `update-tag-properties-add-keeps-others-test` fails; remove the cycle check and confirm `extends-cycle-refused-test` fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): set a tag's extends and add or remove tag properties`.

**Done when:** adding one tag property leaves the others, `create_tag` answers the full tag with `extends` and `properties`, cycles are refused, and the gate is green.

---

### Stage 3: Choices on create and update: add, update and order

**Goal:** `createProperty` takes `choices`; `updateProperty` takes `choices.add`, `choices.update` and `choices.order`, each new or reordered choice keyed after the seeded max, every UUID returned, and the whole request in one tx id. This lands acceptances 1, 3 and 6.

**Files:**
- Modify (inside patch 0026): `semantic.cljs` (`properties-create`, `properties-update`, new `validate-choices`, `choice-tx!` around `outliner-property/upsert-closed-value!`, `rekey-choices!`); `routes/semantic.cljs` (`createProperty` request: `choices: [{title, icon?, description?}]`; `updateProperty` request: `choices: {add?, update?: [{choice, title?, icon?, description?}], order?: [string]}` (`retire` comes in Stage 4); an `Icon` schema `{type: "emoji" | "tabler-icon", id}`; descriptions); tests.
- Modify: connector `HINTS`, `CONNECTOR_HELP`, `tools.test.ts`.

**Interfaces produced:**
- `(validate-choices db property type request e2ee?) -> {:ok plan} | {:error …}` where `plan` is `{:add [{:title :icon :description}] :update [{:entity :title :icon :description}] :order [ref…]}` with refs that may name a choice added in the same request by title. Stages 4 and 5 extend `plan` with `:retire` and `:convert`.
- `(apply-choices! conn property plan) -> {:added [uuid…]}`, called inside `atomic-write!`.

- [ ] **Step 1: Write the failing tests** (spec tests 1, 2, 3, parts of 8 and 9), with a decoy property `quadrant` that already has a choice "Active":
  - `create-property-with-choices-test`: three choices return three UUIDs; each block has `:block/closed-value-property` and `:block/parent` equal to the property; `:block/order` keys are distinct and increasing; `db-property/scoped-closed-values` (what the app's picker reads) lists them; `getProperty` lists them in order with icon and description.
  - `choices-add-returns-uuid-and-unique-key-test`: on a page with 200 blocks written first (0008 shape), `choices.add ["Proposal"]` on `project-status` returns its UUID, it is ordered after the existing choices, and its key is not held by any other block.
  - `choices-update-and-order-test`: `update` renames and re-icons a choice and the change reads back; `icon: null` clears it; `order` changes the read-back order; `order` can name a choice added in the same call by its title.
  - `choices-refusals-test`, each naming its entry:
    - `choices.add 2: "Active" is already a choice on project-status` (case-insensitive, and within the request); "Active" is *not* refused because `quadrant` has it;
    - `choices.update 1: no choice "Foo" on project-status`;
    - `choices.order: missing "Done"` and `choices.order 3: "Active" is listed twice`;
    - a number property's non-numeric title and a URL property's non-URL title;
    - `choices: for-client is a node property and can't have choices`;
    - an icon with a blank `id` or an unknown `type`;
    - a type change and `choices` in the same call is judged on the new type.
  - `choices-refused-on-e2ee-graph-test`: `choices` on an E2EE graph is refused; `classes` there is still allowed.
  - `choices-write-is-one-transaction-test` (spec test 9, first half): one `createProperty` with choices produces one tx id in the sync log, and a client copy replaying it ends with the same choices in the same order (the 0018 replay pattern).

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.3: validate the whole request first (trimmed titles, duplicates ignoring case against the property's own choices and the request, the type rules, the number and URL parse that `upsert-closed-value!` runs, the full-permutation check for `order`, icons). Inside one `atomic-write!`: `upsert-property!` when `type` or `cardinality` changes, then each `upsert-closed-value!` in the given order, then `(db-order/gen-key)` on each new choice; `order` re-keys every choice in the requested sequence. `rejecting` still turns any outliner notification into a 400. Then `verify-property-schema!` with `:titles` and `:order`.

- [ ] **Step 4: Connector.** `HINTS.create_property`: give a property its choices when creating it; choices are for `default`, `number` and `url` properties, classes for `node`. `HINTS.update_property`: `choices.add`, `update` and `order` (a full list), applied in that order. `CONNECTOR_HELP`: extend the existing choices sentence (it starts "A property with choices") to say choices are added and reordered with `update_property`, and that each response lists the choices' UUIDs. `tools.test.ts`: both schemas have `choices`; `connector_help` contains `"choices.add"`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** drop the re-key and confirm `choices-add-returns-uuid-and-unique-key-test` fails; make duplicate detection case-sensitive and confirm the duplicate refusal fails; make duplicate detection cross-property and confirm the decoy case fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): create and update a property's choices with fresh order keys`.

**Done when:** a property created with choices shows them through `scoped-closed-values` in order, `choices.add` returns a UUID with a unique key, every refusal names its entry, and the gate is green.

---

### Stage 4: Retiring choices, with `acknowledge-holders` and `dry-run`

**Goal:** `choices.retire` removes a choice; one with holders is refused with a 409 naming the count unless `acknowledge-holders=true`; `dry-run=true` returns the same shape and stores nothing. This lands acceptance 4.

**Files:**
- Modify (inside patch 0026): `semantic.cljs` (`validate-choices` gains `:retire`; new `choice-holders` (one `:avet` range on the property's ident and the choice's db id) and `retire-choices!`; `properties-update` reads the two query flags and runs on `dry-run-conn` when dry); `routes/semantic.cljs` (`updateProperty` gains `choices.retire: [string]`, the `dry-run` and `acknowledge-holders` query parameters via `delete-flag-parameter`, a 409 response, and `retired` and `dry-run` on the response); tests.
- Modify: connector `HINTS`, `CONNECTOR_HELP`, `tools.test.ts`.

**Interfaces produced:**
- 409 body: `{error: "choices.retire 0: \"Proposal\" is held by 4 blocks; set acknowledge-holders=true to remove it from them, or dry-run=true to preview", retired: [{choice, title, holders}]}`.
- Success body adds `retired: [{uuid, title, holders}]`; with `dry-run=true` also `dry-run: true`.
- `(run-property-update conn request flags)`, the one function that both the real and the dry path call, so Stage 5's dry-run reuses it.

- [ ] **Step 1: Write the failing tests** (spec test 4, test 9 second half, parts of 8):
  - `retire-without-holders-test`: the choice is gone (`delete-closed-value!`), `getProperty` no longer lists it.
  - `retire-with-holders-refused-test`: two holders, no flag: 409 with the count and both flag names; a db snapshot before and after is equal.
  - `retire-with-acknowledge-test`: with `acknowledge-holders=true` the choice is gone and neither holder has a value; on a cardinality-many property, a holder that also held a surviving choice keeps it.
  - `retire-dry-run-test`: `dry-run=true` (with and without the acknowledge flag) answers the same shape with `dry-run: true`; the db is unchanged.
  - `retire-built-in-choice-refused-test`: retiring Status "Done" answers `choices.retire 0: "Done" is built in and can't be retired`.
  - `retire-unknown-choice-test`: `choices.retire 0: no choice "X" on project-status`, and a choice of the decoy property is not found.
  - `add-order-retire-one-transaction-test`: one `updateProperty` with `add`, `order` and `retire` produces one tx id and replays on a client copy to the same state.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.4: count holders per retired choice during validation; refuse with 409 when any has holders and the flag isn't set; otherwise, inside the same `atomic-write!` as the rest of the request, retract each holder's datom for that choice explicitly, then call `delete-closed-value!`. Apply `add`, `update`, `order`, `retire` in that order; `order` must then name only surviving choices. After the write, `verify-property-schema!` checks the choice is gone and no datom still points at it.

- [ ] **Step 4: Connector.** `HINTS.update_property`: retiring a choice that blocks hold needs `acknowledge-holders`; run with `dry-run` first and only acknowledge a loss the user agreed to. Extend the `CONNECTOR_HELP` sentence on `acknowledge-*` flags to name `update_property`'s `choices.retire`. `tools.test.ts`: `update_property`'s schema has `dry-run` and `acknowledge-holders`; `connector_help` contains `"choices.retire"`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** make `choice-holders` return 0 and confirm `retire-with-holders-refused-test` fails; drop the explicit holder retraction and confirm `retire-with-acknowledge-test` fails (or the read-back check fires). Revert.

- [ ] **Step 7: Commit.** `feat(api): retire property choices with acknowledge-holders and dry-run`.

**Done when:** a retire with holders is refused without the flag and stores nothing, the acknowledged retire leaves no dangling refs, dry-run changes nothing, and the gate is green.

---

### Stage 5: Converting text values to choices

**Goal:** `updateProperty` with `convert_values: true` points every holder of a free-text `default` property at the matching choice (exact, then ignoring case), deletes the old value blocks, and refuses the whole call when any text matches no choice.

**Files:**
- Modify (inside patch 0026): `semantic.cljs` (`validate-choices` gains `:convert`; new `conversion-plan` (one `:avet` scan: holder, value block, text) and `convert-values!`); `routes/semantic.cljs` (`convert_values: boolean`; `converted: {values, holders}`; `mapping: [{text, choice: {uuid, title}, holders}]` on dry-run; the description); tests.
- Modify: connector `HINTS`, `CONNECTOR_HELP`, `tools.test.ts`.

- [ ] **Step 1: Write the failing tests** (spec test 5):
  - `convert-values-test`: holders with "Active", "active" and "Done" and choices Active and Done (Done added by `choices.add` in the same call) end pointing at the choices; every holder reads back its choice through `getBlock`; the old value blocks are gone; `converted` is `{values: 3, holders: 3}`.
  - `convert-values-cardinality-many-dedupes-test`: a holder with "Active" and "active" ends with one ref.
  - `convert-values-unmatched-refused-test`: with an extra "Paused" and "On hold", the call is refused with `convert_values: no choice matches "Paused", "On hold"; add them under choices.add in the same call`, and a db snapshot is unchanged (including the `choices.add` in that call).
  - `convert-values-dry-run-mapping-test`: dry-run answers `mapping` with one row per distinct text and its holder count, and the db is unchanged.
  - `convert-values-no-op-test`: a property with choices and no text values answers `converted: {values: 0, holders: 0}`.
  - `convert-values-refusals-test`: a type change with `convert_values` (`type: change the type and convert values in separate calls`); `convert_values` on a `number`, `url` or `node` property; on an E2EE graph.
  - `convert-one-transaction-test`: one tx id, and a client replay matches.

- [ ] **Step 2: Run and keep the failures.**

- [ ] **Step 3: Implement** as §3.5, after `add` within the same request and transaction: build the mapping, refuse on any unmatched text listing all of them, then retract each holder's old ref, add the choice ref (once per holder per choice), and delete the old value blocks with `outliner-core/delete-blocks`. Verify after the write that no holder still points at an old value block.

- [ ] **Step 4: Connector.** `HINTS.update_property`: `convert_values` turns a free-text property into a choice property; text that matches no choice refuses the call, so add those choices under `choices.add` in the same call; dry-run shows the mapping. `CONNECTOR_HELP`: one sentence on the same, and that `choices` and `convert_values` are refused on E2EE graphs. `tools.test.ts`: `update_property`'s schema has `convert_values`; `connector_help` contains `"convert_values"`.

- [ ] **Step 5: Regenerate the patch, re-vendor, run the gate.**

- [ ] **Step 6: Mutation check:** drop the unmatched-text refusal and confirm `convert-values-unmatched-refused-test` fails; make matching exact-only and confirm `convert-values-test` fails. Revert.

- [ ] **Step 7: Commit.** `feat(api): convert a text property's values to its choices`.

**Done when:** every holder reads back its choice, unmatched text refuses the call and stores nothing, dry-run returns the mapping, and the gate is green.

---

## After the stages (the lane's later steps, not build stages)

- **Docs stage:** README §11.8 gains a property-schema paragraph (choices, classes and the stricter UUID check, retire with `acknowledge-holders` after a dry run, `convert_values`, tag `extends` and `properties.add`/`remove`), and the README's patch list gains a 0026 bullet in the style of the 0024 and 0025 ones.
- **PR body:** the Logseq skill note (spec §4 last bullet), the failures each new test showed before its stage's code, the commit the checks ran on, and what `scripts/check.sh` skipped. The PR is stacked on PR #37.
- **After deploy** (spec §9 step 4): add Proposal to `project-status` and see it in the app's picker; restrict `for-client` to Client and check the picker and a refused UUID; create `grade` with its choices; then the backfill, dry-run first.
- **Owner questions** in spec §11 stay open; none blocks a stage. If the owner chooses body flags (question 4) or a 409 for `out_of_class` (question 2), the change lands in Stage 4 or Stage 1's code respectively, before the PR merges.
