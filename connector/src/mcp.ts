import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

// Placeholder MCP endpoint: one read-only `ping` tool. The graph tools replace it.
const handler = createMcpHandler(
  () => {
    const server = new McpServer({ name: "logseq-connector", version: "0.0.0" });
    server.registerTool(
      "ping",
      { description: "Check that the connector is reachable.", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    return server;
  },
  { route: "/mcp" },
);

/** The provider's `apiHandler`: only reached with a valid access token for this host's `/mcp`. */
export const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler(request, env, ctx);
  },
};
