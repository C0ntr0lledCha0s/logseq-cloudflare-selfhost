import type { CallToolResult } from "@modelcontextprotocol/server";
import { ALIAS_PATTERN } from "./spec.mjs";

const ALIAS = new RegExp(ALIAS_PATTERN);

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
 * Runs one tool call with the connector's logging: tool name, graph alias, status and duration only,
 * never arguments, results or tokens. A `ToolError` becomes an error result with its message; any
 * other error propagates to the MCP server, which reports it as a failed call.
 */
export async function runTool(
  name: string,
  alias: string | undefined,
  call: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  let status = "error";
  try {
    const result = await call();
    status = "ok";
    return result;
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    status = error.status;
    return { isError: true, content: [{ type: "text", text: error.message }] };
  } finally {
    console.log(`tool ${name} graph=${alias ?? "-"} status=${status} ms=${Date.now() - started}`);
  }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
