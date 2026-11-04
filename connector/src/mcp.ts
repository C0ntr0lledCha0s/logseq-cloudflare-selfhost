import { McpServer } from "@modelcontextprotocol/server";
import { type StatelessMcpHandler, createMcpHandler } from "agents/mcp/server";
import openapi from "../vendor/openapi.json";
import { isOwner } from "./auth/github";
import type { GrantProps } from "./auth/routes";
import { GraphStore } from "./graphs";
import { registerAssetTools } from "./tools/assets";
import { logTool } from "./tools/common";
import { registerHandwrittenTools } from "./tools/handwritten";
import { KB_INDEX_WRITE_TOOLS, markKbIndexDirty, registerKbIndexTool } from "./tools/kb-index";
import { type GraphAccess, type GraphTool, buildGraphTools, registerGraphTools } from "./tools/semantic";
import type { OpenApiSpec } from "./tools/spec.mjs";

/** The sync server's OpenAPI document at UPSTREAM_REF, vendored by scripts/vendor-upstream-api.sh and bundled. */
const spec = openapi as unknown as OpenApiSpec;

interface IsolateTools {
  store: GraphStore;
  access: GraphAccess;
  graphTools: GraphTool[];
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
    tools = { store, access, graphTools: buildGraphTools(spec, access) };
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

/** The MCP endpoint for one request: a fresh server whose tools read the graphs from D1 as they are now. */
export function mcpHandler(env: Env, ctx: ExecutionContext): StatelessMcpHandler {
  const { store, access, graphTools } = isolateTools(env);
  const onSuccess = (tool: string, alias: string) => {
    ctx.waitUntil(touch(store, tool, alias));
    if (KB_INDEX_WRITE_TOOLS.has(tool)) ctx.waitUntil(markDirty(env, tool, alias));
  };
  return createMcpHandler(
    () => {
      const server = new McpServer({ name: "logseq-connector", version: "0.0.0" });
      registerHandwrittenTools(server, env, store);
      registerGraphTools(server, graphTools, onSuccess);
      registerAssetTools(server, access, onSuccess);
      registerKbIndexTool(server, access, onSuccess);
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
    return mcpHandler(env, ctx)(request, env, ctx);
  },
};
