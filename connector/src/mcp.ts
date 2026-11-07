import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import settings from "../../config/settings.json";
import openapi from "../vendor/openapi.json";
import { type AuditContext, AuditLog, userAgentFamily } from "./audit/log";
import { isOwner } from "./auth/github";
import type { GrantProps } from "./auth/routes";
import { type ServiceProps, ServiceTokenStore, TOUCH_INTERVAL_MS } from "./auth/service-tokens";
import { GraphStore } from "./graphs";
import { registerActivityLogTool } from "./tools/activity-log";
import { registerAssetTools } from "./tools/assets";
import { type RequestScope, logTool, requestScope, scopedResolve } from "./tools/common";
import { registerHandwrittenTools } from "./tools/handwritten";
import type { OnSuccess } from "./tools/readable";
import { KB_INDEX_WRITE_TOOLS, markKbIndexDirty, registerKbIndexTool } from "./tools/kb-index";
import { type GraphAccess, type GraphTool, buildGraphTools, registerGraphTools } from "./tools/semantic";
import { type SemanticBindings, semanticBindings } from "./semantic/config";
import { SemanticStore } from "./semantic/store";
import { registerSemanticTools } from "./tools/semantic-search";
import type { OpenApiSpec } from "./tools/spec.mjs";

/** The sync server's OpenAPI document at UPSTREAM_REF, vendored by scripts/vendor-upstream-api.sh and bundled. */
const spec = openapi as unknown as OpenApiSpec;
/**
 * The owner's time zone, from the committed config/settings.json (bundled, as it holds no secret);
 * get_activity_log reads and shows dates in it. UTC when unset, as on the sync server.
 */
const TIME_ZONE: string = (settings as { timeZone?: string }).timeZone ?? "UTC";

interface IsolateTools {
  store: GraphStore;
  access: GraphAccess;
  graphTools: GraphTool[];
  /** The audit log; it probes for its table once per isolate. */
  audit: AuditLog;
  /** Null while semantic search is off (no AI and VECTORIZE bindings). */
  semantic: { store: SemanticStore; bindings: SemanticBindings } | null;
}

/**
 * Per isolate: the env object is the same for every request an isolate serves, so the store and the
 * built graph tools are made once. Each request still gets its own server (it binds one transport).
 */
const isolates = new WeakMap<Env, IsolateTools>();

/**
 * The isolate's tools. `access.resolve` applies the request's scope (`scopedResolve`), so it only
 * works inside `requestScope.run`; exported for the fail-closed test.
 */
export function isolateTools(env: Env): IsolateTools {
  let tools = isolates.get(env);
  if (!tools) {
    const store = new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
    const access: GraphAccess = { env, resolve: (alias) => scopedResolve(store, alias) };
    const bindings = semanticBindings(env);
    const semantic = bindings ? { store: new SemanticStore(env.DB), bindings } : null;
    tools = { store, access, graphTools: buildGraphTools(spec, access), audit: new AuditLog(env.DB), semantic };
    isolates.set(env, tools);
  }
  return tools;
}

/** Records a use after the response; a failure is logged and never reaches the tool result. */
async function touch(store: GraphStore, tool: string, alias: string): Promise<void> {
  const started = Date.now();
  try {
    await store.touch(alias);
  } catch {
    logTool(tool, alias, "touch-failed", started);
  }
}

/** Marks the alias's kb_index cache dirty; a failure is logged and never reaches the tool result. */
async function markDirty(env: Env, tool: string, alias: string): Promise<void> {
  const started = Date.now();
  try {
    await markKbIndexDirty(env, alias);
  } catch {
    logTool(tool, alias, "kb-index-dirty-failed", started);
  }
}

/** Records a service token's use after the response; a failure is logged by id and never reaches the result. */
async function touchServiceToken(env: Env, id: string, now: number): Promise<void> {
  try {
    await new ServiceTokenStore(env.DB).touch(id, now);
  } catch {
    console.error(`service-token-touch-failed id=${id}`);
  }
}

export type { ServiceProps };

/** Who sent a request, as the audit log stores it (design §3.8). Neither is a token. */
export interface Caller {
  client: string | null;
  session: string | null;
}

/** The caller of an MCP request: its User-Agent family and its `mcp-session-id` header. */
export function callerOf(request: Request): Caller {
  return { client: userAgentFamily(request.headers.get("User-Agent")), session: request.headers.get("mcp-session-id") };
}

/**
 * One request's MCP handler. Only the call form is exposed: the SDK handler's `fetch` and `notify`
 * would run outside `requestScope.run`.
 */
export type McpRequestHandler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

/**
 * The MCP endpoint for one request: a fresh server whose tools read the graphs from D1 as they are
 * now. Every write is logged to audit_log with `caller`'s client and session (null when not given).
 * The request runs inside `requestScope.run(scope, …)`: OAuth by default; a service token's scope
 * limits every graph tool and list_graphs to its graphs and mode.
 */
export function mcpHandler(
  env: Env,
  ctx: ExecutionContext,
  caller: Caller = { client: null, session: null },
  scope: RequestScope = { kind: "oauth" },
): McpRequestHandler {
  const { store, access, graphTools, audit: log, semantic } = isolateTools(env);
  const audit: AuditContext = { log, access, ...caller };
  // audited() logs each write's reason and targets; onSuccess only records the use.
  const onSuccess: OnSuccess = (tool, alias) => {
    ctx.waitUntil(touch(store, tool, alias));
    if (KB_INDEX_WRITE_TOOLS.has(tool)) ctx.waitUntil(markDirty(env, tool, alias));
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "logseq-connector", version: "0.0.0" });
      registerHandwrittenTools(server, env, store, semantic !== null);
      registerActivityLogTool(server, { log, access, timeZone: TIME_ZONE });
      registerGraphTools(server, graphTools, onSuccess, audit);
      registerAssetTools(server, access, onSuccess, audit);
      registerKbIndexTool(server, access, onSuccess);
      if (semantic) registerSemanticTools(server, { access, ...semantic }, onSuccess);
      return server;
    },
    // The Worker already answers 421 for any host but CONNECTOR_HOSTNAME (src/index.ts).
    { route: "/mcp" },
  );
  return (request, handlerEnv, handlerCtx) => requestScope.run(scope, () => handler(request, handlerEnv, handlerCtx));
}

/**
 * The provider's `apiHandler`: only reached with a valid access token for this host's `/mcp`, either
 * an OAuth grant or a service token (src/auth/service-tokens.ts). The owner is checked again on every
 * request, for both, so changing OWNER_GITHUB_USER_ID revokes existing grants.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OAuth props are the decrypted GrantProps stored with the grant (src/auth/routes.ts); service
    // props come from verifyServiceToken.
    const props = ctx.props as GrantProps | ServiceProps;
    if (!isOwner(props.githubUserId, env)) return new Response("Forbidden", { status: 403 });
    if ("kind" in props && props.kind === "service") {
      const now = Date.now();
      // At most one write an hour per token; the UPDATE's own condition settles a race between isolates.
      if (props.lastUsedAt === null || props.lastUsedAt < now - TOUCH_INTERVAL_MS) {
        ctx.waitUntil(touchServiceToken(env, props.tokenId, now));
      }
      const caller: Caller = { client: `service:${props.name}`, session: request.headers.get("mcp-session-id") };
      const scope: RequestScope = { kind: "service", name: props.name, graphIds: new Set(props.graphIds), access: props.access };
      return mcpHandler(env, ctx, caller, scope)(request, env, ctx);
    }
    return mcpHandler(env, ctx, callerOf(request))(request, env, ctx);
  },
};
