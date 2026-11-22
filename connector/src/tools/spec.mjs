// @ts-check
// The sync server's OpenAPI document as the connector exposes it: which operations become tools,
// their names, and the committed tools manifest. Plain JavaScript so that
// scripts/check-tools-manifest.mjs can run it under Node without a build step.
import { resolveOpenApiRefs } from "../../vendor/semantic_api_tools.mjs";

/**
 * @typedef {{ name: string, in: string, required?: boolean, description?: string, schema?: unknown }} OpenApiParameter
 * @typedef {{ operationId?: string, summary?: string, description?: string, parameters?: OpenApiParameter[], [key: string]: unknown }} OpenApiOperation
 * @typedef {{ paths: Record<string, Record<string, OpenApiOperation>>, [key: string]: unknown }} OpenApiSpec
 * @typedef {{ operationId: string, name: string, method: string, path: string, operation: OpenApiOperation }} GraphOperation
 * @typedef {{ name: string, method: string | null, path: string | null, annotations: ToolHints, firstLine: string }} ManifestEntry
 */

/** A connected graph's alias, as the connector's GraphStore enforces it. */
export const ALIAS_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
export const GRAPH_PARAM_DESCRIPTION = "Graph alias from list_graphs";
/** Tools registered by hand rather than from the spec; listed here so the manifest covers them. */
export const HANDWRITTEN_TOOLS = [
  "connector_help",
  "get_activity_log",
  "kb_index",
  "list_graphs",
  "read_file",
  "save_document",
  "save_file_from_url",
  "semantic_index_status",
  "semantic_search",
  "suggest_links",
];
/** Hand-written tools registered only when semantic search is configured (src/semantic/config.ts). */
export const SEMANTIC_TOOLS = ["semantic_index_status", "semantic_search"];

/**
 * @typedef {{ readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }} ToolHints
 */

// The four classes of spec section 4 (docs/superpowers/specs/2026-11-07-readable-tool-calls-reason-targets-design.md).
// Annotations are static per tool, so a tool that can lose data in any mode is destructive in every
// mode (update_property, refresh_refs, and batch_insert_block_trees, whose entry properties replace an
// existing target's values). Only save_file_from_url reaches outside the owner's graphs.
/** Reads: change nothing, so repeating them is harmless. */
const READ = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
/** Writes that overwrite or remove data, where a second identical call changes something more or is refused. */
const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
/** Deletes and sets: overwrite or remove data, and a second identical call has no further effect. */
const DESTRUCTIVE_IDEMPOTENT = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
/** Writes that add or move without overwriting; a second call adds again. */
const ADDITIVE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

/**
 * Every tool's MCP annotations, generated and hand-written alike. They replace upstream's hints, which
 * the generator derives from the HTTP method and which mark POST and PATCH writes that lose data as
 * non-destructive. A tool missing here fails `annotationsFor`, so the manifest and the Worker refuse it.
 * @type {Readonly<Record<string, Readonly<ToolHints>>>}
 */
export const ANNOTATIONS = Object.freeze({
  batch_delete_block_property: DESTRUCTIVE_IDEMPOTENT,
  batch_insert_block_trees: DESTRUCTIVE,
  batch_move_blocks: ADDITIVE,
  batch_set_block_property: DESTRUCTIVE_IDEMPOTENT,
  capture_to_today: ADDITIVE,
  connector_help: READ,
  create_page: ADDITIVE,
  create_property: ADDITIVE,
  create_tag: ADDITIVE,
  create_task: ADDITIVE,
  // Patch 0039: a POST only because the query can be long; it runs on a read-only view of the graph.
  datalog_query: READ,
  delete_block: DESTRUCTIVE_IDEMPOTENT,
  delete_block_property: DESTRUCTIVE_IDEMPOTENT,
  delete_blocks: DESTRUCTIVE_IDEMPOTENT,
  delete_page: DESTRUCTIVE_IDEMPOTENT,
  delete_property: DESTRUCTIVE_IDEMPOTENT,
  delete_tag: DESTRUCTIVE_IDEMPOTENT,
  get_activity_log: READ,
  get_block: READ,
  get_blocks: READ,
  get_graph_health: READ,
  get_page: READ,
  get_page_backlinks: READ,
  get_page_outline: READ,
  get_property: READ,
  get_tag: READ,
  insert_block_children: ADDITIVE,
  insert_block_tree: ADDITIVE,
  kb_index: READ,
  list_assets: READ,
  list_favorites: READ,
  list_graphs: READ,
  list_page_blocks: READ,
  list_page_references: READ,
  list_pages: READ,
  list_properties: READ,
  list_tag_objects: READ,
  list_tags: READ,
  list_tasks: READ,
  move_blocks: ADDITIVE,
  promote_page_to_tag: DESTRUCTIVE,
  read_file: READ,
  refresh_refs: DESTRUCTIVE,
  // Patch 0039: a POST like datalog_query; it runs a vetted query on the same read-only view.
  run_named_query: READ,
  save_document: ADDITIVE,
  save_file_from_url: Object.freeze({ ...ADDITIVE, openWorldHint: true }),
  search_graph: READ,
  semantic_index_status: READ,
  semantic_search: READ,
  suggest_links: READ,
  set_block_property: DESTRUCTIVE_IDEMPOTENT,
  // Patch 0038: favorite=false removes the page from the list; a re-send changes nothing.
  set_page_favorite: DESTRUCTIVE_IDEMPOTENT,
  // Patch 0038: overwrites the favourites' order (which page each slot links); a re-send changes nothing.
  reorder_favorites: DESTRUCTIVE_IDEMPOTENT,
  update_block: DESTRUCTIVE,
  update_page: DESTRUCTIVE,
  update_property: DESTRUCTIVE,
  update_tag: DESTRUCTIVE,
});

/**
 * The annotations of the tool `name`. Throws for a tool with no entry.
 * @param {string} name
 * @returns {ToolHints}
 */
export function annotationsFor(name) {
  if (!Object.hasOwn(ANNOTATIONS, name)) throw new Error(`no annotations for tool ${name}`);
  return { ...ANNOTATIONS[name] };
}

const GRAPH_PREFIX = "/api/v1/graphs/{graph-id}/";
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
/**
 * Replaced by hand-written tools (read_file, save_*, list_graphs, kb_index), or, for listBlockChanges,
 * the semantic indexer's feed rather than something Claude needs. `/e2ee/` paths are dropped too.
 */
const EXCLUDED_OPERATIONS = new Set(["createAsset", "getAsset", "listGraphs", "listKnowledgeIndex", "listBlockChanges"]);
/** Argument names the upstream generator reserves or the connector adds. */
const RESERVED_PARAMETERS = new Set(["graph", "body"]);
/**
 * Write operations that echo the inserted blocks take `verbose`, true by default. The connector
 * defaults it to false: Claude already has the titles it sent, and only needs the UUIDs back.
 */
const COMPACT_NOTE =
  "Defaults to false here: the result is the inserted blocks' UUIDs, nested as inserted, and a count. Pass true to get their titles back.";

/**
 * A `verbose` query parameter with the connector's default. The generated tool's input schema
 * applies it, so a call that leaves `verbose` out sends verbose=false.
 * @param {OpenApiParameter} param
 * @returns {OpenApiParameter}
 */
function compactByDefault(param) {
  if (param.name !== "verbose" || param.in !== "query") return param;
  const schema = /** @type {Record<string, unknown>} */ (param.schema);
  if (schema?.type !== "boolean") throw new Error("the verbose parameter is not a boolean");
  return { ...param, schema: { ...schema, default: false }, description: [param.description, COMPACT_NOTE].filter(Boolean).join(" ") };
}

/**
 * `insertBlockTree` → `insert_block_tree`.
 * @param {string} operationId
 */
export function snakeCase(operationId) {
  return operationId.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * The operations that become graph tools, with `$ref`s resolved. Throws on any shape the connector
 * does not understand, so a sync-server bump that adds one fails CI instead of shipping a broken tool.
 * @param {OpenApiSpec} spec
 * @returns {GraphOperation[]}
 */
export function graphOperations(spec) {
  /** @type {OpenApiSpec} */
  const resolved = resolveOpenApiRefs(spec, spec);
  /** @type {GraphOperation[]} */
  const ops = [];
  const names = new Set();
  for (const [path, pathItem] of Object.entries(resolved.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) throw new Error(`unsupported key '${method}' on path ${path}`);
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(operationId)) {
        throw new Error(`operation ${method.toUpperCase()} ${path} has no camelCase operationId`);
      }
      if (EXCLUDED_OPERATIONS.has(operationId) || path.includes("/e2ee/")) continue;
      if (!path.startsWith(GRAPH_PREFIX) || path.indexOf("{graph-id}") !== path.lastIndexOf("{graph-id}")) {
        throw new Error(`operation ${operationId} is not under ${GRAPH_PREFIX}`);
      }
      const params = operation.parameters ?? [];
      const graphParams = params.filter((p) => p.name === "graph-id");
      if (graphParams.length !== 1 || graphParams[0].in !== "path") {
        throw new Error(`operation ${operationId} needs exactly one graph-id path parameter`);
      }
      const reserved = params.find((p) => RESERVED_PARAMETERS.has(p.name));
      if (reserved) throw new Error(`operation ${operationId} has a parameter named '${reserved.name}'`);
      const name = snakeCase(operationId);
      if (names.has(name) || HANDWRITTEN_TOOLS.includes(name)) throw new Error(`duplicate tool name ${name}`);
      names.add(name);
      ops.push({ operationId, name, method: method.toUpperCase(), path, operation });
    }
  }
  return ops;
}

/**
 * The spec handed to upstream's `registerSemanticApiTools`: only the graph operations, each with the
 * `graph-id` path parameter replaced by a required `graph` alias (the path template becomes `{graph}`,
 * so upstream substitutes the alias and the connector maps it back to the graph ID), and `verbose`
 * defaulting to false.
 * @param {OpenApiSpec} spec
 * @returns {OpenApiSpec}
 */
export function transformSpec(spec) {
  /** @type {Record<string, Record<string, OpenApiOperation>>} */
  const paths = {};
  for (const { method, path, operation } of graphOperations(spec)) {
    const graphParam = {
      name: "graph",
      in: "path",
      required: true,
      description: GRAPH_PARAM_DESCRIPTION,
      schema: { type: "string", pattern: ALIAS_PATTERN },
    };
    const parameters = [
      graphParam,
      ...(operation.parameters ?? []).filter((p) => p.name !== "graph-id").map(compactByDefault),
    ];
    const aliasPath = path.replace("{graph-id}", "{graph}");
    paths[aliasPath] = { ...paths[aliasPath], [method.toLowerCase()]: { ...operation, parameters } };
  }
  return { ...spec, paths };
}

/**
 * The first line of every tool's description: what the tool is for and when to choose it, in at most
 * 100 characters. claude.ai lists a connector's tools with each description cut to its first line and
 * loads the rest only after a tool search, so this line carries the routing hint (item 58). The
 * connector puts it first in every description (src/mcp.ts); a tool missing here fails `firstLineFor`.
 * @type {Readonly<Record<string, string>>}
 */
export const FIRST_LINES = Object.freeze({
  batch_delete_block_property: "Remove property values from many blocks in one call; prefer it to repeated single deletes.",
  batch_insert_block_trees: "Build or fill several pages in one call, creating missing ones; best for multi-page writes.",
  batch_move_blocks: "Move many blocks to different places in one call; move_blocks suits a single destination.",
  batch_set_block_property: "Set tags and properties on many blocks or pages in one call; prefer it for more than one value.",
  capture_to_today: "Append notes to today's journal; use insert_block_tree for any other page or day.",
  connector_help: "The connector's writing rules: read once before the first write in a conversation.",
  create_page: "Create a page by title; a title already in use is refused, naming the existing page.",
  create_property: "Define a new property with its type, choices or classes; check list_properties first.",
  create_tag: "Create a tag (class) with what it extends and its properties; check list_tags first.",
  create_task: "Create a task with status, priority and dates; use it for every action item, never TODO text.",
  datalog_query: "Read-only Datalog for questions no other tool answers; try run_named_query first.",
  delete_block: "Delete one block and its children; use delete_blocks for several.",
  delete_block_property: "Remove one property value from a block or page.",
  delete_blocks: "Delete up to 100 blocks in one call; dry-run first and show the user what goes.",
  delete_page: "Move a page and its blocks to the Recycle bin; dry-run first to see its references.",
  delete_property: "Delete a property definition and its values; dry-run first to see what is lost.",
  delete_tag: "Delete a tag, which its holders lose; dry-run first to see the counts.",
  get_activity_log: "What the connector changed in a graph, newest first: the answer to 'what did you change?'",
  get_block: "One block or page by UUID with its tags and properties, without its children.",
  get_blocks: "Up to 100 blocks or pages by UUID in one call, optionally with their outlines.",
  get_graph_health: "Tidy-up report: unused tags and properties, duplicates, page gaps, broken refs, missing tag values.",
  get_page: "One page's tags and properties by UUID, title or date; get_page_outline reads its content.",
  get_page_backlinks: "How a page is used: links, tagged objects and property values pointing at it, with counts.",
  get_page_outline: "Read a whole page as markdown with tags, properties and links resolved; the usual way to read.",
  get_property: "A property's type, choices and classes; check it before setting a choice or node value.",
  get_tag: "A tag's properties, the tags it extends and the tags that extend it.",
  insert_block_children: "Add block trees under an existing block; insert_block_tree also takes a page as target.",
  insert_block_tree: "Write a whole note as one nested block tree on a page or under a block; the usual way to write.",
  kb_index: "Start here for broad questions: every page grouped by class, with its summary and UUID.",
  list_assets: "The graph's files and images, with the asset UUIDs read_file takes.",
  list_favorites: "The pages in the sidebar's Favorites list, in order.",
  list_graphs: "Call first: the connected graphs and the alias every other tool's graph argument takes.",
  list_page_blocks: "A page's top-level blocks, paginated; get_page_outline reads the whole tree at once.",
  list_page_references: "Blocks and pages that link to a page, paginated; get_page_backlinks gives grouped counts.",
  list_pages: "All pages, paginated, filterable by created or updated date; kb_index suits an overview.",
  list_properties: "Every property with its type; check here before creating a property.",
  list_tag_objects: "Every page or block with a given tag, paginated, such as all Person pages.",
  list_tags: "Every tag in the graph; check here before creating or applying a tag.",
  list_tasks: "Tasks filtered by status, priority or text: the way to answer what is outstanding.",
  move_blocks: "Move blocks under or beside a block or page; dry-run a large move first.",
  promote_page_to_tag: "Turn an existing page into a tag, keeping its blocks and references.",
  read_file: "Read a saved asset back by its UUID: text as text, images as images.",
  refresh_refs: "Re-apply link and tag handling to blocks written before it existed; dry-run unless applied.",
  reorder_favorites: "Set the order of the sidebar favourites; pass the full list from list_favorites.",
  run_named_query: "Four ready-made questions: stale projects, undecided meetings, open tasks, pages missing a value.",
  save_document: "Save text or a base64 file into the graph as an asset, linked from a page or the journal.",
  save_file_from_url: "Download a public https file into the graph as an asset, linked from a page or the journal.",
  search_graph: "Find pages, blocks, tags and properties by the exact words in their titles and text.",
  semantic_index_status: "How much of a graph the meaning-based search index covers.",
  semantic_search: "Find blocks by meaning as well as title words; use it when the exact words may differ.",
  set_block_property: "Set one tag or property on a block or page; batch_set_block_property sets several.",
  set_page_favorite: "Add a page to the sidebar favourites, or remove it.",
  suggest_links: "Before writing notes, find the words that should link to existing pages; never writes.",
  update_block: "Replace one block's text or display type; set_block_property changes its properties.",
  update_page: "Rename a page; set_block_property changes its tags and properties.",
  update_property: "Change a property's title, choices or classes, or convert its text values to choices.",
  update_tag: "Change a tag's title, the tags it extends or its properties.",
});

/**
 * @param {string} name
 * @returns {string}
 */
export function firstLineFor(name) {
  const line = FIRST_LINES[name];
  if (line === undefined) throw new Error(`no first line for tool ${name}: add it to FIRST_LINES in src/tools/spec.mjs`);
  return line;
}

/**
 * Every tool the connector registers, sorted by name. Hand-written tools have no single operation.
 * @param {OpenApiSpec} spec
 * @returns {ManifestEntry[]}
 */
export function buildManifest(spec) {
  /** @type {ManifestEntry[]} */
  const entries = [
    ...graphOperations(spec).map(({ name, method, path }) => ({ name, method, path, annotations: annotationsFor(name), firstLine: firstLineFor(name) })),
    ...HANDWRITTEN_TOOLS.map((name) => ({ name, method: null, path: null, annotations: annotationsFor(name), firstLine: firstLineFor(name) })),
  ];
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {ManifestEntry[]} manifest */
export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The hints an entry sets, e.g. `[destructive idempotent]`, so a changed hint shows in the diff. */
const HINT_LABELS = /** @type {const} */ ([
  ["readOnlyHint", "read-only"],
  ["destructiveHint", "destructive"],
  ["idempotentHint", "idempotent"],
  ["openWorldHint", "open-world"],
]);

/** @param {Partial<ManifestEntry>} entry */
function describeHints(entry) {
  const hints = entry.annotations;
  if (hints === undefined || hints === null || typeof hints !== "object") return "[annotations missing]";
  const set = HINT_LABELS.filter(([key]) => hints[key] === true).map(([, label]) => label);
  return `[${set.length > 0 ? set.join(" ") : "no hints"}]`;
}

/** @param {ManifestEntry} entry */
function describeEntry(entry) {
  const where = entry.method === null ? `${entry.name} (hand-written)` : `${entry.name} ${entry.method} ${entry.path}`;
  return `${where} ${describeHints(entry)} "${entry.firstLine ?? "(no first line)"}"`;
}

/**
 * Differences between a committed manifest and the one `spec` produces, one line each
 * (`+` added, `-` removed); empty when they match.
 * @param {unknown} committed
 * @param {OpenApiSpec} spec
 * @returns {string[]}
 */
export function checkManifest(committed, spec) {
  if (!Array.isArray(committed)) return ["committed manifest is not an array"];
  const expected = buildManifest(spec);
  const want = new Set(expected.map(describeEntry));
  const have = new Set(committed.map((e) => describeEntry(/** @type {ManifestEntry} */ (e))));
  const diff = [
    ...[...want].filter((line) => !have.has(line)).map((line) => `+ ${line}`),
    ...[...have].filter((line) => !want.has(line)).map((line) => `- ${line}`),
  ];
  if (diff.length === 0 && formatManifest(/** @type {ManifestEntry[]} */ (committed)) !== formatManifest(expected)) {
    diff.push("~ entries are out of order or carry extra fields");
  }
  return diff;
}
