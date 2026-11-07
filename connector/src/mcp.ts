import { McpServer } from "@modelcontextprotocol/server";
import { type StatelessMcpHandler, createMcpHandler } from "agents/mcp/server";
import settings from "../../config/settings.json";
import openapi from "../vendor/openapi.json";
import { type AuditContext, AuditLog, userAgentFamily } from "./audit/log";
import { isOwner } from "./auth/github";
import type { GrantProps } from "./auth/routes";
import { GraphStore } from "./graphs";
import { registerActivityLogTool } from "./tools/activity-log";
import { registerAssetTools } from "./tools/assets";
import { logTool } from "./tools/common";
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

function isolateTools(env: Env): IsolateTools {
  let tools = isolates.get(env);
  if (!tools) {
    const store = new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
    const access: GraphAccess = { env, resolve: (alias) => store.resolve(alias) };
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
 * The MCP endpoint for one request: a fresh server whose tools read the graphs from D1 as they are
 * now. Every write is logged to audit_log with `caller`'s client and session (null when not given).
 */
export function mcpHandler(env: Env, ctx: ExecutionContext, caller: Caller = { client: null, session: null }): StatelessMcpHandler {
  const { store, access, graphTools, audit: log, semantic } = isolateTools(env);
  const audit: AuditContext = { log, access, ...caller };
  // audited() logs each write's reason and targets; onSuccess only records the use.
  const onSuccess: OnSuccess = (tool, alias) => {
    ctx.waitUntil(touch(store, tool, alias));
    if (KB_INDEX_WRITE_TOOLS.has(tool)) ctx.waitUntil(markDirty(env, tool, alias));
  };
  return createMcpHandler(
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
}

/**
 * The provider's `apiHandler`: only reached with a valid access token for this host's `/mcp`. The
 * owner is checked again on every request, so changing OWNER_GITHUB_USER_ID revokes existing grants.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The provider sets props to the decrypted GrantProps stored with the grant (src/auth/routes.ts).
    const props = ctx.props as GrantProps;
    if (!isOwner(props.githubUserId, env)) return new Response("Forbidden", { status: 403 });
    return mcpHandler(env, ctx, callerOf(request))(request, env, ctx);
  },
};
