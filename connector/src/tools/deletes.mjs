// @ts-check
// Which write calls delete data: one table for every write tool, the operations that declare a dry run,
// and the refusal a `write-no-delete` service token gives (spec
// docs/superpowers/specs/2026-11-08-service-token-write-no-delete-design.md §3.4, §3.5, §4).
// Plain JavaScript that imports nothing, so scripts' node tests can read it without the vendored build.
//
// What counts as a delete: a call that removes an entity (page, block, tag, property, choice, value
// block), or removes a value from a block without putting another in its place. An overwrite (new text,
// a new value, a new tag list) is not a delete: the audit log's before-snapshot keeps what it replaced,
// so the owner can restore it. A move is not a delete.
//
// Evidence for the `when` rules, and for the two rules step 0 relaxed. Step 0 ran on 2026-11-08 against
// upstream at UPSTREAM_REF with patches 0001 to 0034, through the real `sync-handler/handle-http` (a
// throwaway test namespace, not committed):
// - set_block_property on a block holding a value: "" answered 400 on text ("property value must resolve
//   to an existing entity by UUID, ident, or title"), number ("Count: \"\" should be a finite number")
//   and checkbox ("Done: \"\" should be a boolean"), and the value stayed. [] answered 200 and removed the
//   value of a text and a number property; on a checkbox it answered 400. null answered 400 ("missing
//   property value"); the vendored PropertyValue schema admits no null anyway. Rule: "", [], a list of
//   only "", and null are refused; whitespace (" ") is stored as text and allowed.
// - batch_set_block_property: [] answered 200 and removed the value when isResetExistingValues was true
//   (cardinality one and many); without it, [] left a cardinality-one value. The rule refuses an empty
//   value either way, as set_block_property does: an empty value in a batch is never needed to write.
// - update_property: a type change with a holder answered 400 ("This property's type can't be changed
//   because it has existing data."), one to many answered 200 keeping the value, many to one with a
//   holder answered 400. So type and cardinality changes are not deletes. convert_values deletes the old
//   text value blocks (docs/solutions/api/convert-values-deleted-referenced-value-blocks.md) and
//   choices.retire removes choices and the values blocks hold (the openapi says so), so both are refused.
// - update_tag (spec: guess, relaxed by step 0): properties.remove ["Venue"] and then properties.set []
//   answered 200, and the holder kept its Venue and Count values, in the database and in get_block.
//   properties.set ["Topics"] dropping Count also kept the holder's values. So update_tag is `never`.
// - batch_insert_block_trees (spec: guess, relaxed by step 0): an entry targeting an existing block with
//   properties {"Venue": []} answered 201 and the block kept its value; so did {"Topics": [], "Tags": [],
//   "Venue": []} on a block holding a cardinality-many value, a tag and a cardinality-one value, and a
//   page target. {"Count": ""} answered 400 and kept the value. A nested block reused by its uuid with
//   properties {"Venue": []} kept its value (the openapi: "A block reused by its uuid keeps its
//   properties"); new blocks have no value to lose. So batch_insert_block_trees is `never`.
// Re-check this table when a vendor bump adds a body field to a write tool.

/**
 * @typedef {{ always: string } | { when: (args: Record<string, unknown>) => string | null } | { never: string }} DeleteRule
 */

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : undefined;
}

/** @param {Record<string, unknown>} args */
function bodyOf(args) {
  return record(args.body);
}

/**
 * A value that sets nothing: "", null, or a list holding nothing but "".
 * @param {unknown} value
 */
function isEmptyValue(value) {
  if (value === "" || value === null) return true;
  return Array.isArray(value) && value.every((item) => item === "");
}

const EMPTY_VALUE = "an empty value removes the property";

/** @type {Readonly<Record<string, Readonly<DeleteRule>>>} */
export const DELETE_RULES = Object.freeze({
  delete_page: { always: "deletes the page and its blocks" },
  delete_block: { always: "deletes the block and its children" },
  delete_blocks: { always: "deletes the blocks and their children" },
  delete_tag: { always: "deletes the tag, and its holders lose it" },
  delete_property: { always: "deletes the property and its values" },
  delete_block_property: { always: "removes a property value" },
  batch_delete_block_property: { always: "removes property values" },

  update_property: {
    when: (args) => {
      const body = bodyOf(args);
      if (body?.convert_values === true) return "with convert_values deletes the property's old text value blocks";
      const retire = record(body?.choices)?.retire;
      if (retire !== undefined && !(Array.isArray(retire) && retire.length === 0)) {
        return "with choices.retire removes choices and the values blocks hold";
      }
      return null;
    },
  },
  set_block_property: {
    when: (args) => {
      const body = bodyOf(args);
      return body && Object.hasOwn(body, "value") && isEmptyValue(body.value) ? `with ${EMPTY_VALUE}` : null;
    },
  },
  batch_set_block_property: {
    when: (args) => {
      const entries = bodyOf(args)?.entries;
      if (!Array.isArray(entries)) return null;
      const index = entries.findIndex((entry) => {
        const e = record(entry);
        return e !== undefined && Object.hasOwn(e, "value") && isEmptyValue(e.value);
      });
      return index === -1 ? null : `entry ${index}: ${EMPTY_VALUE}`;
    },
  },

  update_block: { never: "overwrites the block's text; the before-snapshot keeps the old text" },
  update_page: { never: "overwrites the page's title; the before-snapshot keeps the old one" },
  refresh_refs: { never: "rewrites each changed block's text; the before-snapshot keeps it" },
  promote_page_to_tag: { never: "converts the page in place, keeping its UUID, blocks, values and references" },
  update_tag: { never: "changes the tag's title, extends or properties; holders keep their values (step 0)" },
  batch_insert_block_trees: { never: "adds blocks and sets values; an empty value leaves the target's value (step 0)" },
  move_blocks: { never: "moves blocks; nothing is removed" },
  batch_move_blocks: { never: "moves blocks; nothing is removed" },
  save_document: { never: "adds an asset block; nothing is overwritten" },
  save_file_from_url: { never: "adds an asset block; nothing is overwritten" },
  insert_block_children: { never: "adds blocks; a block reused by its uuid keeps its properties" },
  insert_block_tree: { never: "adds blocks; a block reused by its uuid keeps its properties" },
  capture_to_today: { never: "adds blocks to today's journal" },
  create_page: { never: "adds a page" },
  create_tag: { never: "adds a tag" },
  create_task: { never: "adds a task" },
  create_property: { never: "adds a property; it takes no convert_values" },
});

/**
 * Why the call `tool` with `args` deletes, or null when it deletes nothing. Throws for a tool with no
 * rule, so a new write tool cannot run unclassified.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
export function deleteReason(tool, args) {
  if (!Object.hasOwn(DELETE_RULES, tool)) throw new Error(`unclassified write tool: ${tool}`);
  const rule = DELETE_RULES[tool];
  if ("always" in rule) return rule.always;
  if ("when" in rule) return rule.when(args ?? {});
  return null;
}

/** The tools that delete whatever their arguments. */
export const ALWAYS_DELETE = Object.freeze(Object.keys(DELETE_RULES).filter((tool) => "always" in DELETE_RULES[tool]));

/**
 * The write tools whose operation declares `dry-run`, and where: as a query parameter (a top-level
 * argument) or in the JSON body. A test checks this against the vendored openapi.
 * @type {Readonly<Record<string, "query" | "body">>}
 */
export const DRY_RUN_TOOLS = Object.freeze({
  delete_page: "query",
  delete_tag: "query",
  delete_property: "query",
  update_property: "query",
  move_blocks: "query",
  promote_page_to_tag: "query",
  delete_blocks: "body",
  batch_move_blocks: "body",
  batch_insert_block_trees: "body",
});

/**
 * True only when `tool` declares a dry run and `dry-run` is the boolean true where it declares it, so
 * the request the sync server sees carries dry-run=true.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
export function declaredDryRun(tool, args) {
  if (!Object.hasOwn(DRY_RUN_TOOLS, tool)) return false;
  const holder = DRY_RUN_TOOLS[tool] === "query" ? args : bodyOf(args);
  return holder?.["dry-run"] === true;
}

/**
 * The refusal a `write-no-delete` token gives (spec §4).
 * @param {string} by who refuses, e.g. "service token 'worker'"
 * @param {string} tool
 * @param {string} alias
 * @param {string | null} why from deleteReason
 * @param {boolean} dryRunnable whether the tool declares a dry run
 */
export function noDeleteMessage(by, tool, alias, why, dryRunnable) {
  const next = dryRunnable
    ? "Run it with dry-run=true to see what it would delete, and leave the delete to the owner."
    : "Leave the delete to the owner.";
  return `${by} may not delete (write, no deletes): ${tool} on graph '${alias}' ${why}. ${next}`;
}
