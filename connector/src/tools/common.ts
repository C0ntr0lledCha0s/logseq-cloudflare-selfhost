import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ServiceTokenAccess } from "../auth/service-tokens";
import type { GraphStore, ResolvedGraph } from "../graphs";
import type { GraphAccess } from "./semantic";
import { ALIAS_PATTERN } from "./spec.mjs";

const ALIAS = new RegExp(ALIAS_PATTERN);

/** claude.ai's limit on one tool result, in characters; longer text is truncated with a notice. */
export const RESULT_CHAR_LIMIT = 150_000;

/** A refusal or mapped sync error whose message is meant for Claude. `status` goes to the log. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** A string that is a valid graph alias, or undefined. */
export function aliasArg(args: unknown): string | undefined {
  const graph = (args as { graph?: unknown } | undefined)?.graph;
  return typeof graph === "string" && ALIAS.test(graph) ? graph : undefined;
}

/**
 * The connector's only log line about tools: never arguments, results, tokens or hostnames. For a
 * write, `reasonGiven` adds `reason=yes|no`, never the reason's text, which may quote private notes.
 */
export function logTool(name: string, alias: string | undefined, status: string, started: number, reasonGiven?: boolean): void {
  const reason = reasonGiven === undefined ? "" : ` reason=${reasonGiven ? "yes" : "no"}`;
  console.log(`tool ${name} graph=${alias ?? "-"} status=${status}${reason} ms=${Date.now() - started}`);
}

/**
 * Truncates the result's text content to `RESULT_CHAR_LIMIT` characters in total, notice included.
 * `notice` builds the notice from the total; by default it is the read path's "request less".
 */
export function capResult(
  result: CallToolResult,
  notice: (total: number) => string = (total) =>
    `\n\n[truncated: the result had ${total} characters and the limit is ${RESULT_CHAR_LIMIT}; request less, e.g. a smaller limit with the cursor, or a narrower query]`,
): CallToolResult {
  const texts = result.content.filter((c) => c.type === "text");
  const total = texts.reduce((n, c) => n + c.text.length, 0);
  if (total <= RESULT_CHAR_LIMIT) return result;
  const cut = notice(total);
  let budget = RESULT_CHAR_LIMIT - cut.length;
  const content: CallToolResult["content"] = [];
  for (const item of result.content) {
    if (item.type !== "text") {
      content.push(item);
    } else if (item.text.length <= budget) {
      content.push(item);
      budget -= item.text.length;
    } else if (budget >= 0) {
      content.push({ ...item, text: item.text.slice(0, budget) + cut });
      budget = -1;
    }
  }
  return { ...result, content };
}

/**
 * Runs one tool call with the connector's logging and result cap. A `ToolError` becomes an error
 * result with its message; any other error propagates to the MCP server, which reports it as a failed call.
 * Writes pass `reasonGiven`, so the log line says whether the call gave a reason.
 */
export async function runTool(
  name: string,
  alias: string | undefined,
  call: () => Promise<CallToolResult>,
  reasonGiven?: boolean,
): Promise<CallToolResult> {
  const started = Date.now();
  let status = "error";
  try {
    const result = capResult(await call());
    status = "ok";
    return result;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    status = error.status;
    return { isError: true, content: [{ type: "text", text: error.message }] };
  } finally {
    logTool(name, alias, status, started, reasonGiven);
  }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** The graphs one tool call has looked up, by alias, so the audit wrapper and the handler share one D1 read. */
const callGraphs = new AsyncLocalStorage<Map<string, ResolvedGraph | null>>();

/** Runs `fn` as one tool call: within it, each alias is read from D1 at most once. */
export function withCallGraphs<T>(fn: () => Promise<T>): Promise<T> {
  return callGraphs.run(new Map(), fn);
}

/**
 * Who a request acts for. OAuth reaches every connected graph at its own mode; a service token
 * reaches only the graphs whose ids it lists, and `access: "read"` lowers each to read-only.
 * `write-no-delete` cannot arrive yet: verifyServiceToken refuses it until its deletes are enforced.
 */
export type RequestScope =
  | { kind: "oauth" }
  | { kind: "service"; name: string; graphIds: ReadonlySet<string>; access: ServiceTokenAccess };

/** The scope of the MCP request being served; `mcpHandler` runs every request inside `requestScope.run`. */
export const requestScope = new AsyncLocalStorage<RequestScope>();

/**
 * The current request's scope. Throws when none is visible, so a tool callback that ran outside the
 * request's context fails closed instead of reaching every graph (an unset scope never means OAuth).
 */
export function currentScope(): RequestScope {
  const scope = requestScope.getStore();
  if (scope === undefined) throw new Error("no request scope: refusing to resolve a graph outside an MCP request");
  return scope;
}

/**
 * `store.resolve(alias)` under the current request's scope. A service scope refuses a graph whose id
 * it doesn't list (`out-of-scope`, naming the aliases it covers, read only on this refusal) and, when
 * read-only, returns the graph as read-only with `readOnlyBy` set. Null stays null (unknown alias).
 * It throws rather than returning, so `lookupGraph` never caches a graph the scope refused.
 */
export async function scopedResolve(store: GraphStore, alias: string): Promise<ResolvedGraph | null> {
  const scope = currentScope();
  const graph = await store.resolve(alias);
  if (graph === null || scope.kind === "oauth") return graph;
  if (!scope.graphIds.has(graph.graphId)) {
    const covered = await store.aliasesFor([...scope.graphIds]);
    throw new ToolError(
      `graph '${alias}' is outside service token '${scope.name}''s scope (it covers: ${covered.length > 0 ? covered.join(", ") : "none"})`,
      "out-of-scope",
    );
  }
  if (scope.access === "read") return { ...graph, mode: "read", readOnlyBy: `service token '${scope.name}'` };
  return graph;
}

/** The graph behind `alias`, or null for an unknown alias; read once per tool call (`withCallGraphs`). */
export async function lookupGraph(access: GraphAccess, alias: string): Promise<ResolvedGraph | null> {
  const seen = callGraphs.getStore();
  if (seen?.has(alias)) return seen.get(alias) ?? null;
  const graph = await access.resolve(alias);
  seen?.set(alias, graph);
  return graph;
}

/**
 * The graph behind `alias` for one tool call. Throws `ToolError` for an unknown alias, an alias
 * outside a service token's scope, and a write on a read-only graph (naming the token when a
 * read-only token made it so), before anything reaches the sync server.
 */
export async function resolveGraph(access: GraphAccess, alias: string, write: boolean): Promise<ResolvedGraph> {
  const graph = await lookupGraph(access, alias);
  if (!graph) {
    throw new ToolError(`unknown graph '${alias}' — call list_graphs for the connected aliases`, "unknown-graph");
  }
  if (graph.mode !== "read" && graph.mode !== "write") throw new Error(`graph '${alias}' has an invalid mode`);
  if (graph.mode === "read" && write) {
    const by = graph.readOnlyBy === undefined ? "" : ` (${graph.readOnlyBy} is read-only)`;
    throw new ToolError(`graph '${alias}' is read-only${by}`, "read-only");
  }
  return graph;
}
