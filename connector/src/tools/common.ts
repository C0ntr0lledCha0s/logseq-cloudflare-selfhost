import type { CallToolResult } from "@modelcontextprotocol/server";
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

/** Truncates the result's text content to `RESULT_CHAR_LIMIT` characters in total, notice included. */
export function capResult(result: CallToolResult): CallToolResult {
  const texts = result.content.filter((c) => c.type === "text");
  const total = texts.reduce((n, c) => n + c.text.length, 0);
  if (total <= RESULT_CHAR_LIMIT) return result;
  const notice = `\n\n[truncated: the result had ${total} characters and the limit is ${RESULT_CHAR_LIMIT}; request less, e.g. a smaller limit with the cursor, or a narrower query]`;
  let budget = RESULT_CHAR_LIMIT - notice.length;
  const content: CallToolResult["content"] = [];
  for (const item of result.content) {
    if (item.type !== "text") {
      content.push(item);
    } else if (item.text.length <= budget) {
      content.push(item);
      budget -= item.text.length;
    } else if (budget >= 0) {
      content.push({ ...item, text: item.text.slice(0, budget) + notice });
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
