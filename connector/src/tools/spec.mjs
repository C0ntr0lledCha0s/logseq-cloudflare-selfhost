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
 * @typedef {{ name: string, method: string | null, path: string | null }} ManifestEntry
 */

/** A connected graph's alias, as the connector's GraphStore enforces it. */
export const ALIAS_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
export const GRAPH_PARAM_DESCRIPTION = "Graph alias from list_graphs";
/** Tools registered by hand rather than from the spec; listed here so the manifest covers them. */
export const HANDWRITTEN_TOOLS = ["connector_help", "list_graphs"];

const GRAPH_PREFIX = "/api/v1/graphs/{graph-id}/";
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
/** Replaced by hand-written tools (assets, list_graphs). `/e2ee/` paths are dropped too. */
const EXCLUDED_OPERATIONS = new Set(["createAsset", "getAsset", "listGraphs"]);
/** Argument names the upstream generator reserves or the connector adds. */
const RESERVED_PARAMETERS = new Set(["graph", "body"]);

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
 * so upstream substitutes the alias and the connector maps it back to the graph ID).
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
    const parameters = [graphParam, ...(operation.parameters ?? []).filter((p) => p.name !== "graph-id")];
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
    ...graphOperations(spec).map(({ name, method, path }) => ({ name, method, path })),
    ...HANDWRITTEN_TOOLS.map((name) => ({ name, method: null, path: null })),
  ];
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {ManifestEntry[]} manifest */
export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** @param {ManifestEntry} entry */
function describeEntry(entry) {
  return entry.method === null ? `${entry.name} (hand-written)` : `${entry.name} ${entry.method} ${entry.path}`;
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
