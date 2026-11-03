import { McpServer } from "@modelcontextprotocol/server";
import { type StatelessMcpHandler, createMcpHandler } from "agents/mcp/server";
import openapi from "../vendor/openapi.json";
import { GraphStore } from "./graphs";
import { ToolError } from "./tools/common";
import { registerHandwrittenTools } from "./tools/handwritten";
import { type GraphAccess, registerGraphTools } from "./tools/semantic";
import type { OpenApiSpec } from "./tools/spec.mjs";

/** The sync server's OpenAPI document at UPSTREAM_REF, vendored by scripts/vendor-upstream-api.sh and bundled. */
const spec = openapi as unknown as OpenApiSpec;

function graphAccess(env: Env, store: GraphStore): GraphAccess {
  return {
    env,
    async resolve(alias) {
      const graph = await store.get(alias);
      if (!graph) {
        throw new ToolError(`unknown graph '${alias}' — call list_graphs for the connected aliases`, "unknown-graph");
      }
      return { graphId: graph.graphId, pat: await store.token(alias), mode: graph.mode };
    },
    touch: (alias) => store.touch(alias),
  };
}

/** The MCP endpoint for one request: a fresh server whose tools read the graphs from D1 as they are now. */
export function mcpHandler(env: Env): StatelessMcpHandler {
  return createMcpHandler(
    () => {
      const store = new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
      const server = new McpServer({ name: "logseq-connector", version: "0.0.0" });
      registerHandwrittenTools(server, env, store);
      registerGraphTools(server, spec, graphAccess(env, store));
      return server;
    },
    // The Worker already answers 421 for any host but CONNECTOR_HOSTNAME (src/index.ts).
    { route: "/mcp" },
  );
}

/** The provider's `apiHandler`: only reached with a valid access token for this host's `/mcp`. */
export const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return mcpHandler(env)(request, env, ctx);
  },
};
