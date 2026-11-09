import { describe, expect, it } from "vitest";
import manifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import {
  ALWAYS_DELETE,
  DELETE_RULES,
  DRY_RUN_TOOLS,
  declaredDryRun,
  deleteReason,
  noDeleteMessage,
} from "../src/tools/deletes.mjs";
import { ANNOTATIONS, type OpenApiSpec, graphOperations } from "../src/tools/spec.mjs";

// The delete table (spec 2026-11-08-service-token-write-no-delete-design.md §3.4 and §3.5). Nothing calls
// it yet; these tests pin it to the manifest, ANNOTATIONS and the vendored openapi.

const writeTools = manifest.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
const readTools = manifest.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
const kindOf = (tool: string) => Object.keys((DELETE_RULES as Record<string, object>)[tool])[0];

const ALWAYS = [
  "batch_delete_block_property",
  "delete_block",
  "delete_block_property",
  "delete_blocks",
  "delete_page",
  "delete_property",
  "delete_tag",
];

/**
 * Spec §3.4's table for every `destructiveHint: true` tool, as built: step 0 (handler probes on
 * 2026-11-08) showed `update_tag` properties.remove/set and `batch_insert_block_trees` empty entry
 * properties leave every holder's value, so both are `never` (deletes.mjs header quotes the answers).
 */
const DESTRUCTIVE_KINDS: Record<string, "always" | "when" | "never"> = {
  batch_delete_block_property: "always",
  batch_insert_block_trees: "never",
  batch_set_block_property: "when",
  delete_block: "always",
  delete_block_property: "always",
  delete_blocks: "always",
  delete_page: "always",
  delete_property: "always",
  delete_tag: "always",
  promote_page_to_tag: "never",
  refresh_refs: "never",
  set_block_property: "when",
  // Patch 0038: a remove takes the page off the favourites list; an add removes nothing.
  set_page_favorite: "when",
  // Patch 0038: a reorder rewrites which page each slot links and keeps every slot.
  reorder_favorites: "never",
  update_block: "never",
  update_page: "never",
  update_property: "when",
  update_tag: "never",
};

describe("the delete table", () => {
  it("classifies every write tool in the manifest, and no read tool", () => {
    expect(writeTools.length).toBeGreaterThan(20);
    expect(Object.keys(DELETE_RULES).sort()).toEqual([...writeTools].sort());
    for (const tool of writeTools) {
      expect(["always", "when", "never"], tool).toContain(kindOf(tool));
      const rule = (DELETE_RULES as Record<string, Record<string, unknown>>)[tool];
      const value = Object.values(rule)[0];
      expect(Object.keys(rule), tool).toHaveLength(1);
      if (kindOf(tool) === "when") expect(typeof value, tool).toBe("function");
      else expect(typeof value === "string" && value.length > 0, `${tool} carries its reason`).toBe(true);
    }
    expect(readTools).toContain("connector_help");
    for (const tool of readTools) {
      expect(Object.hasOwn(DELETE_RULES, tool), tool).toBe(false);
      expect(() => deleteReason(tool, {}), tool).toThrow(`unclassified write tool: ${tool}`);
    }
  });

  it("throws for a tool it does not know, and for an inherited name", () => {
    expect(() => deleteReason("no_such_tool", {})).toThrow("unclassified write tool: no_such_tool");
    expect(() => deleteReason("toString", {})).toThrow("unclassified write tool: toString");
    expect(() => deleteReason("__proto__", {})).toThrow("unclassified write tool: __proto__");
  });

  it("matches ANNOTATIONS: every destructive entry with its spec §3.4 rule kind", () => {
    const destructive = Object.entries(ANNOTATIONS)
      .filter(([, hints]) => hints.destructiveHint)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual(Object.keys(DESTRUCTIVE_KINDS).sort());
    for (const [tool, kind] of Object.entries(DESTRUCTIVE_KINDS)) expect(kindOf(tool), tool).toBe(kind);
    // Additive writes (not destructive) are never deletes.
    for (const [tool, hints] of Object.entries(ANNOTATIONS)) {
      if (!hints.readOnlyHint && !hints.destructiveHint) expect(kindOf(tool), tool).toBe("never");
    }
  });

  it("refuses the seven always tools whatever their arguments; ALWAYS_DELETE is exactly those", () => {
    expect([...ALWAYS_DELETE].sort()).toEqual(ALWAYS);
    expect(Object.isFrozen(ALWAYS_DELETE)).toBe(true);
    const argSets: Record<string, unknown>[] = [
      {},
      { graph: "notes" },
      { graph: "notes", "dry-run": true },
      { graph: "notes", body: { "dry-run": true, uuids: ["b1"] } },
      { graph: "notes", body: { entries: [] } },
    ];
    for (const tool of ALWAYS) {
      for (const args of argSets) {
        const why = deleteReason(tool, args);
        expect(typeof why === "string" && why.length > 5, `${tool} ${JSON.stringify(args)}`).toBe(true);
      }
    }
    expect(deleteReason("delete_page", {})).toBe("deletes the page and its blocks");
    expect(deleteReason("delete_block", {})).toBe("deletes the block and its children");
    expect(deleteReason("delete_blocks", {})).toBe("deletes the blocks and their children");
    expect(deleteReason("delete_property", {})).toBe("deletes the property and its values");
  });

  it("returns null for every never tool, with representative arguments", () => {
    const representative: Record<string, Record<string, unknown>> = {
      update_block: { graph: "notes", "block-id": "b1", body: { title: "New text" } },
      update_page: { graph: "notes", "page-id": "Plans", body: { title: "Plans 2026" } },
      refresh_refs: { graph: "notes", body: { apply: true } },
      promote_page_to_tag: { graph: "notes", "page-id": "Person", body: { extends: ["Agent"] } },
      move_blocks: { graph: "notes", body: { "block-ids": ["b1"], "target-id": "b2" } },
      batch_move_blocks: { graph: "notes", body: { moves: [{ "block-ids": ["b1"], "target-id": "b2" }] } },
      save_document: { graph: "notes", page: "Plans", file_name: "a.pdf", content_base64: "AA==" },
      save_file_from_url: { graph: "notes", page: "Plans", url: "https://example.com/a.pdf" },
      insert_block_children: { graph: "notes", "block-id": "b1", body: { blocks: [{ title: "x", properties: { Venue: [] } }] } },
      insert_block_tree: { graph: "notes", body: { "target-id": "b1", blocks: [{ title: "x", properties: { Venue: "" } }] } },
      capture_to_today: { graph: "notes", body: { blocks: [{ title: "x" }] } },
      create_page: { graph: "notes", body: { title: "Plans" } },
      create_tag: { graph: "notes", body: { title: "Event", properties: ["Venue"] } },
      create_task: { graph: "notes", body: { title: "Call", "page-id": "Plans" } },
      create_property: { graph: "notes", body: { title: "Venue", type: "default" } },
      // Step 0: holders keep their values when a tag drops a property.
      update_tag: { graph: "notes", "tag-id": "Event", body: { properties: { remove: ["Venue"] } } },
      // Step 0: an empty value in an entry's properties leaves the target's value.
      batch_insert_block_trees: { graph: "notes", body: { entries: [{ "target-id": "b1", properties: { Venue: [] } }] } },
      reorder_favorites: { graph: "notes", body: { "page-ids": ["Ideas", "Plans"] } },
    };
    const never = writeTools.filter((t) => kindOf(t) === "never").sort();
    expect(Object.keys(representative).sort()).toEqual(never);
    for (const [tool, args] of Object.entries(representative)) {
      expect(deleteReason(tool, args), tool).toBeNull();
      expect(deleteReason(tool, {}), tool).toBeNull();
    }
  });
});

describe("update_property", () => {
  const call = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    deleteReason("update_property", { graph: "notes", "property-id": "Status", ...extra, body });

  it("refuses convert_values: true and a non-empty choices.retire", () => {
    expect(call({ convert_values: true })).toBe("with convert_values deletes the property's old text value blocks");
    expect(call({ convert_values: true, choices: { add: [{ title: "a" }] } })).toMatch(/convert_values/);
    expect(call({ choices: { retire: ["x"] } })).toBe("with choices.retire removes choices and the values blocks hold");
    expect(call({ choices: { add: [{ title: "y" }], retire: ["x", "z"] } })).toMatch(/choices\.retire/);
    // A retire the schema would refuse (not a list) is still treated as a retire.
    expect(call({ choices: { retire: "x" } })).toMatch(/choices\.retire/);
    // An acknowledge flag or dry-run does not change what the call is.
    expect(call({ convert_values: true }, { "acknowledge-references": true })).toMatch(/convert_values/);
    expect(call({ choices: { retire: ["x"] } }, { "dry-run": true })).toMatch(/choices\.retire/);
  });

  it("allows convert_values false or absent, an empty retire, renames, choices and classes changes, type and cardinality", () => {
    const allowed: Record<string, unknown>[] = [
      {},
      { convert_values: false },
      { convert_values: false, type: "number" },
      { choices: { retire: [] } },
      { choices: { retire: [] }, convert_values: false },
      { title: "Project status" },
      { choices: { add: [{ title: "paused" }] } },
      { choices: { update: [{ choice: "active", title: "Active", icon: null }] } },
      { choices: { order: ["paused", "active"] } },
      { classes: { set: [] } },
      { classes: { add: ["Project"] } },
      { classes: { remove: ["Project"] } },
      { type: "number" },
      { type: "date" },
      { cardinality: "db.cardinality/many" },
      { cardinality: "db.cardinality/one" },
    ];
    for (const body of allowed) expect(call(body), JSON.stringify(body)).toBeNull();
    expect(deleteReason("update_property", { graph: "notes", "property-id": "Status" })).toBeNull();
  });
});

describe("set_block_property and batch_set_block_property", () => {
  const set = (value: unknown) =>
    deleteReason("set_block_property", { graph: "notes", "block-id": "b1", "property-id": "Venue", body: { value } });

  // A representative value of every kind that reaches the property resolver: text, number, checkbox,
  // url, a date or datetime (a timestamp or a journal page), a node by title or UUID, a choice, a bare
  // integer (entity id), an ident, Tags as a list, and whitespace (stored as text).
  const STORED: unknown[] = [
    "Hall",
    " ",
    [" "],
    0,
    3.5,
    -1,
    false,
    true,
    "https://example.com",
    ["https://example.com", "https://example.org"],
    1762560000000,
    "2026-11-08",
    "Plans",
    "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    "active",
    "logseq.property/status.todo",
    "TODO",
    42,
    ["Person", "Agent"],
    [0],
  ];

  it("refuses an empty value: \"\", [], a list of only \"\", and null", () => {
    for (const value of ["", [], [""], ["", ""], null]) {
      expect(set(value), JSON.stringify(value)).toBe("with an empty value removes the property");
    }
  });

  it("allows every stored value kind", () => {
    for (const value of STORED) expect(set(value), JSON.stringify(value)).toBeNull();
    expect(set(undefined)).toBeNull();
  });

  const batch = (values: unknown[], extra: Record<string, unknown> = {}) =>
    deleteReason("batch_set_block_property", {
      graph: "notes",
      body: { ...extra, entries: values.map((value, i) => ({ "block-id": `b${i}`, "property-id": "Venue", value })) },
    });

  it("names the first entry with an empty value, wherever it sits", () => {
    expect(batch(["Hall", 3, []])).toBe("entry 2: an empty value removes the property");
    expect(batch(["", "Hall"])).toBe("entry 0: an empty value removes the property");
    expect(batch(["Hall", null, ""])).toBe("entry 1: an empty value removes the property");
    expect(batch(["Hall", "Room", [""]])).toBe("entry 2: an empty value removes the property");
    // Reversed order and a swap name the entry where it now sits.
    expect(batch([[], 3, "Hall"])).toBe("entry 0: an empty value removes the property");
    expect(batch([3, [], "Hall"])).toBe("entry 1: an empty value removes the property");
    expect(batch(["Hall", 3, []], { isResetExistingValues: true })).toBe("entry 2: an empty value removes the property");
  });

  it("allows a batch of stored values in any order, an empty batch, and malformed entries", () => {
    expect(batch(STORED)).toBeNull();
    expect(batch([...STORED].reverse())).toBeNull();
    expect(batch(STORED, { isResetExistingValues: true })).toBeNull();
    expect(batch([])).toBeNull();
    expect(deleteReason("batch_set_block_property", { graph: "notes", body: {} })).toBeNull();
    expect(deleteReason("batch_set_block_property", { graph: "notes", body: { entries: [null, "x", 3] } })).toBeNull();
  });
});

describe("a tags list or placeholder that sets nothing (review r1-integrity-1)", () => {
  // A tags list replaces the target's user tags and keeps the built-in type tags it holds, so a list of
  // only type tags (["Page"], ["logseq.class/Journal"]) removes every user tag with nothing in its
  // place, as [] does. The empty placeholder ident stores the value the outliner uses for a removed one.
  const set = (propertyId: string, value: unknown) =>
    deleteReason("set_block_property", { graph: "notes", "block-id": "b1", "property-id": propertyId, body: { value } });
  const batch = (propertyId: string, value: unknown) =>
    deleteReason("batch_set_block_property", {
      graph: "notes",
      body: { isResetExistingValues: true, entries: [{ "block-id": "b1", "property-id": "Venue", value: "Hall" }, { "block-id": "b2", "property-id": propertyId, value }] },
    });
  const TAGS_IDS = ["block/tags", ":block/tags", "Tags", "tags", "logseq.property/tags"];
  const TYPE_ONLY: unknown[] = [
    ["Page"],
    ["page"],
    ["Journal"],
    ["Tag", "Page"],
    ["Property"],
    ["Asset"],
    ["Whiteboard"],
    ["PDF Annotation"],
    ["logseq.class/Page"],
    ["logseq.class/Journal"],
    "Page",
  ];

  it("refuses a tags list of only built-in type tags, under every name for Tags", () => {
    for (const id of TAGS_IDS) {
      for (const value of TYPE_ONLY) {
        expect(set(id, value), `${id} ${JSON.stringify(value)}`).toBe("with an empty value removes the property");
        expect(batch(id, value), `${id} ${JSON.stringify(value)}`).toBe("entry 1: an empty value removes the property");
      }
    }
  });

  it("allows a tags list holding a user tag, and a type tag name on another property", () => {
    for (const id of TAGS_IDS) {
      expect(set(id, ["Page", "Food"])).toBeNull();
      expect(set(id, ["Person"])).toBeNull();
      expect(set(id, "Food")).toBeNull();
    }
    expect(set("Venue", ["Page"])).toBeNull();
    expect(set("Venue", "Journal")).toBeNull();
  });

  it("refuses the empty placeholder ident on any property", () => {
    for (const value of ["logseq.property/empty-placeholder", ["logseq.property/empty-placeholder"], ":logseq.property/empty-placeholder"]) {
      expect(set("Venue", value), JSON.stringify(value)).toBe("with an empty value removes the property");
      expect(batch("Venue", value), JSON.stringify(value)).toBe("entry 1: an empty value removes the property");
    }
  });
});

describe("reorder_favorites (patch 0038)", () => {
  const args = (body: unknown) => ({ graph: "notes", body, reason: "tidy the sidebar" });

  it("is never a delete: a full list, a shorter one, an empty one or a dry run (the server refuses a list that isn't the whole set, and keeps every slot)", () => {
    for (const body of [
      { "page-ids": ["Plans", "Ideas"] },
      { "page-ids": ["Ideas", "Plans"], "dry-run": false },
      { "page-ids": ["Plans"] },
      { "page-ids": [] },
      { "page-ids": ["Plans", "Ideas"], "dry-run": true },
      {},
      undefined,
    ]) {
      expect(deleteReason("reorder_favorites", args(body)), JSON.stringify(body)).toBeNull();
    }
    expect(DELETE_RULES.reorder_favorites).toEqual({ never: "rewrites which page each favourite slot links; the permutation check removes nothing" });
  });

  it("declares its dry run in the body", () => {
    expect(declaredDryRun("reorder_favorites", args({ "page-ids": [], "dry-run": true }))).toBe(true);
    expect(declaredDryRun("reorder_favorites", { ...args({ "page-ids": [] }), "dry-run": true })).toBe(false);
  });
});

describe("set_page_favorite (patch 0038)", () => {
  const args = (body: unknown) => ({ graph: "notes", "page-id": "Plans", body, reason: "tidy the sidebar" });

  it("is a delete with favorite: false, whatever else the body holds", () => {
    expect(deleteReason("set_page_favorite", args({ favorite: false }))).toBe("removes the page from the favourites list");
    expect(deleteReason("set_page_favorite", args({ favorite: false, "dry-run": true }))).toBe("removes the page from the favourites list");
    expect(deleteReason("set_page_favorite", args({ "dry-run": false, favorite: false }))).toBe("removes the page from the favourites list");
  });

  it("is not a delete with favorite: true, a missing body or a missing or non-boolean favorite (the server refuses the shape)", () => {
    for (const body of [{ favorite: true }, { favorite: true, "dry-run": true }, undefined, null, {}, { "dry-run": true }, { favourite: false }, { favorite: "false" }, { favorite: 0 }, { favorite: null }, [false], "false"]) {
      expect(deleteReason("set_page_favorite", args(body)), JSON.stringify(body)).toBeNull();
    }
    expect(deleteReason("set_page_favorite", { graph: "notes", "page-id": "Plans" })).toBeNull();
    // favorite outside the body is not the body's.
    expect(deleteReason("set_page_favorite", { graph: "notes", "page-id": "Plans", favorite: false })).toBeNull();
  });

  it("declares its dry run in the body, so a no-delete token may dry-run a remove", () => {
    expect(declaredDryRun("set_page_favorite", args({ favorite: false, "dry-run": true }))).toBe(true);
    expect(declaredDryRun("set_page_favorite", { ...args({ favorite: false }), "dry-run": true })).toBe(false);
    expect(declaredDryRun("set_page_favorite", args({ favorite: false, "dry-run": "true" }))).toBe(false);
  });
});

describe("dry runs", () => {
  /** The write operations that declare `dry-run`, by where, read from the vendored openapi. */
  function declared(): Record<string, "query" | "body"> {
    const out: Record<string, "query" | "body"> = {};
    for (const { name, operation } of graphOperations(openapi as unknown as OpenApiSpec)) {
      const inQuery = (operation.parameters ?? []).some((p) => p.name === "dry-run" && p.in === "query");
      const body = operation.requestBody as
        | { content?: { "application/json"?: { schema?: { properties?: Record<string, unknown> } } } }
        | undefined;
      const inBody = Object.hasOwn(body?.content?.["application/json"]?.schema?.properties ?? {}, "dry-run");
      expect(inQuery && inBody, name).toBe(false);
      if (inQuery) out[name] = "query";
      if (inBody) out[name] = "body";
    }
    return out;
  }

  it("DRY_RUN_TOOLS matches the vendored openapi, query or body", () => {
    expect({ ...DRY_RUN_TOOLS }).toEqual(declared());
    expect(DRY_RUN_TOOLS).toEqual({
      delete_page: "query",
      delete_tag: "query",
      delete_property: "query",
      update_property: "query",
      move_blocks: "query",
      promote_page_to_tag: "query",
      delete_blocks: "body",
      batch_move_blocks: "body",
      batch_insert_block_trees: "body",
      // Patch 0037 (code blocks) gives the two tree inserts a dry run; both are `never` deletes.
      insert_block_children: "body",
      insert_block_tree: "body",
      // Patch 0038: a favourite's remove is a delete, so a no-delete token can still dry-run it.
      set_page_favorite: "body",
      reorder_favorites: "body",
    });
    expect(Object.isFrozen(DRY_RUN_TOOLS)).toBe(true);
  });

  it("is a declared dry run only with true in the declared place", () => {
    expect(declaredDryRun("delete_page", { graph: "notes", "page-id": "Plans", "dry-run": true })).toBe(true);
    expect(declaredDryRun("update_property", { "dry-run": true, body: { convert_values: true } })).toBe(true);
    expect(declaredDryRun("delete_blocks", { body: { uuids: ["b1"], "dry-run": true } })).toBe(true);
    expect(declaredDryRun("batch_insert_block_trees", { body: { entries: [], "dry-run": true } })).toBe(true);

    // Not true: a string, a number, false, absent.
    for (const v of ["true", 1, "1", false, null, undefined]) {
      expect(declaredDryRun("delete_page", { "dry-run": v }), String(v)).toBe(false);
      expect(declaredDryRun("delete_blocks", { body: { "dry-run": v } }), String(v)).toBe(false);
    }
    // The wrong place.
    expect(declaredDryRun("delete_page", { body: { "dry-run": true } })).toBe(false);
    expect(declaredDryRun("delete_tag", { body: { "dry-run": true } })).toBe(false);
    expect(declaredDryRun("update_property", { body: { "dry-run": true, convert_values: true } })).toBe(false);
    expect(declaredDryRun("delete_blocks", { "dry-run": true, body: { uuids: ["b1"] } })).toBe(false);
    expect(declaredDryRun("batch_move_blocks", { "dry-run": true })).toBe(false);
    // A tool that declares none, in either place.
    for (const tool of ["delete_block", "delete_block_property", "batch_delete_block_property", "set_block_property", "batch_set_block_property", "update_tag", "no_such_tool", "toString"]) {
      expect(declaredDryRun(tool, { "dry-run": true }), tool).toBe(false);
      expect(declaredDryRun(tool, { "dry-run": true, body: { "dry-run": true } }), tool).toBe(false);
    }
    expect(declaredDryRun("delete_page", {})).toBe(false);
  });

  it("createProperty declares no convert_values, and updateProperty does", () => {
    const ops = Object.fromEntries(graphOperations(openapi as unknown as OpenApiSpec).map((o) => [o.operationId, o.operation]));
    const props = (id: string) =>
      (ops[id].requestBody as { content: { "application/json": { schema: { properties: Record<string, unknown> } } } }).content[
        "application/json"
      ].schema.properties;
    expect(Object.keys(props("createProperty"))).not.toContain("convert_values");
    expect(Object.keys(props("updateProperty"))).toContain("convert_values");
    expect(JSON.stringify(ops.createProperty.parameters ?? [])).not.toContain("convert_values");
  });

  it("PropertyValue admits no null, so an empty value is \"\" or []", () => {
    const value = (openapi as unknown as { components: { schemas: Record<string, { oneOf: { type: string }[] }> } }).components.schemas
      .PropertyValue;
    expect(value.oneOf.map((s) => s.type).sort()).toEqual(["array", "boolean", "number", "string"]);
  });
});

describe("noDeleteMessage", () => {
  const by = "service token 'worker'";

  it("gives the spec §4 texts", () => {
    expect(noDeleteMessage(by, "delete_page", "notes", deleteReason("delete_page", {}), true)).toBe(
      "service token 'worker' may not delete (write, no deletes): delete_page on graph 'notes' deletes the page and its blocks. Run it with dry-run=true to see what it would delete, and leave the delete to the owner.",
    );
    expect(noDeleteMessage(by, "delete_block", "notes", deleteReason("delete_block", {}), false)).toBe(
      "service token 'worker' may not delete (write, no deletes): delete_block on graph 'notes' deletes the block and its children. Leave the delete to the owner.",
    );
    const why = deleteReason("batch_set_block_property", { body: { entries: [{ value: "a" }, { value: 1 }, { value: [] }] } });
    expect(noDeleteMessage(by, "batch_set_block_property", "notes", why, false)).toBe(
      "service token 'worker' may not delete (write, no deletes): batch_set_block_property on graph 'notes' entry 2: an empty value removes the property. Leave the delete to the owner.",
    );
  });
});
