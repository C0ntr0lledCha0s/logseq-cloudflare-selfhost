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
 * @typedef {{ name: string, method: string | null, path: string | null, annotations: ToolHints }} ManifestEntry
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
  save_document: ADDITIVE,
  save_file_from_url: Object.freeze({ ...ADDITIVE, openWorldHint: true }),
  search_graph: READ,
  semantic_index_status: READ,
  semantic_search: READ,
  suggest_links: READ,
  set_block_property: DESTRUCTIVE_IDEMPOTENT,
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
 * Every tool the connector registers, sorted by name. Hand-written tools have no single operation.
 * @param {OpenApiSpec} spec
 * @returns {ManifestEntry[]}
 */
export function buildManifest(spec) {
  /** @type {ManifestEntry[]} */
  const entries = [
    ...graphOperations(spec).map(({ name, method, path }) => ({ name, method, path, annotations: annotationsFor(name) })),
    ...HANDWRITTEN_TOOLS.map((name) => ({ name, method: null, path: null, annotations: annotationsFor(name) })),
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
  return `${where} ${describeHints(entry)}`;
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
