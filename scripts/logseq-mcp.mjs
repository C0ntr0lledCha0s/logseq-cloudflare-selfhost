#!/usr/bin/env node
// Calls one logseq-connector MCP tool from bash, for sessions where the MCP server is not loaded.
//
//   LOGSEQ_SERVICE_TOKEN=lsct_… node scripts/logseq-mcp.mjs <tool> ['<json args>']
//
// It sends `initialize`, then `notifications/initialized`, then `tools/call`, passing back the
// `mcp-session-id` the server sets, and prints the tool's text content. It reads JSON and SSE
// answers. It exits 1 on an HTTP error, a JSON-RPC error or a tool result with `isError`, and 2 on
// a usage error. The token is read only from the environment, never from an argument (so it never
// shows in `ps`), and every line printed goes through redact().
//
// Node 20 or later, no dependencies.

import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://mcp.example.com/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const USAGE =
  "usage: node scripts/logseq-mcp.mjs <tool> ['<json args>']\n" +
  `Reads the token from LOGSEQ_SERVICE_TOKEN and the server from LOGSEQ_MCP_URL (default ${DEFAULT_URL}).`;
/** Any service token's shape, so a token other than ours is not printed either. */
const TOKEN_SHAPE = /lsct_[A-Za-z0-9_-]{43}/g;
const MASK = "lsct_…";

/** Replaces the token's value, and anything shaped like a service token, with `lsct_…`. */
export function redact(text, token) {
  let out = String(text);
  if (token) out = out.split(token).join(MASK);
  return out.replace(TOKEN_SHAPE, MASK);
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Server messages are shown, but a long HTML page is cut short. */
const clip = (text) => {
  const t = String(text).trim();
  return t.length > 500 ? `${t.slice(0, 500)}…` : t;
};

/** The message an HTTP error body carries: OAuth's error_description, a JSON-RPC error, or the text. */
function httpMessage(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error_description === "string") return parsed.error_description;
      if (parsed.error && typeof parsed.error === "object" && parsed.error.message) return parsed.error.message;
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // Not JSON: show the text.
  }
  return clip(body) || "(no body)";
}

/** Yields each SSE event's data (its `data:` lines joined), however the stream is chunked. */
async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    if (data.length) yield data.join("\n");
  } finally {
    reader.cancel().catch(() => {});
  }
}

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${what}: the answer is not JSON: ${clip(text)}`);
  }
};

/** Posts one JSON-RPC message. Answers `{message, sessionId}`; `message` is null for a notification. */
async function post(url, token, sessionId, rpc) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (rpc.method !== "initialize") headers["mcp-protocol-version"] = PROTOCOL_VERSION;

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(rpc) });
  } catch (error) {
    const cause = error?.cause?.message ?? error?.cause?.code ?? error?.message ?? String(error);
    throw new CliError(`${rpc.method}: cannot reach ${url}: ${cause}`);
  }
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CliError(`${rpc.method}: HTTP ${response.status}: ${httpMessage(body)}`);
  }
  if (rpc.id === undefined) {
    await response.body?.cancel().catch(() => {});
    return { message: null, sessionId: nextSession };
  }

  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for await (const data of sseData(response.body)) {
      const message = parseJson(data, rpc.method);
      if (message && message.id === rpc.id) return { message, sessionId: nextSession };
    }
    throw new CliError(`${rpc.method}: the event stream ended with no answer`);
  }
  return { message: parseJson(await response.text(), rpc.method), sessionId: nextSession };
}

/** The JSON-RPC result, or a CliError naming the JSON-RPC error. */
function resultOf(method, message) {
  if (message.error) {
    const { code, message: text } = message.error;
    throw new CliError(`${method}: JSON-RPC error ${code}: ${text}`);
  }
  if (!message.result) throw new CliError(`${method}: the answer has no result`);
  return message.result;
}

const textOf = (result) =>
  (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** Runs the CLI. Answers the lines to print and the exit code; never prints itself. */
export async function main(argv, env) {
  const token = (env.LOGSEQ_SERVICE_TOKEN ?? "").trim();
  const [tool, rawArgs, ...extra] = argv;
  if (!token) throw new CliError(`LOGSEQ_SERVICE_TOKEN is not set.\n${USAGE}`, 2);
  if (!tool || extra.length) throw new CliError(USAGE, 2);
  let args = {};
  if (rawArgs !== undefined) {
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      throw new CliError(`the args are not JSON (${error.message}).\n${USAGE}`, 2);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new CliError(`the args must be a JSON object.\n${USAGE}`, 2);
    }
  }
  const url = env.LOGSEQ_MCP_URL || DEFAULT_URL;

  const init = await post(url, token, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "logseq-mcp-cli", version: "1.0.0" },
    },
  });
  resultOf("initialize", init.message);
  const notified = await post(url, token, init.sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
  const call = await post(url, token, notified.sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  const result = resultOf("tools/call", call.message);
  if (result.isError) throw new CliError(`${tool}: ${textOf(result) || "the tool failed"}`);
  return textOf(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = (process.env.LOGSEQ_SERVICE_TOKEN ?? "").trim();
  const print = (stream, text) => stream.write(`${redact(text, token)}\n`);
  try {
    print(process.stdout, await main(process.argv.slice(2), process.env));
  } catch (error) {
    print(process.stderr, error instanceof CliError ? error.message : `unexpected error: ${error?.stack ?? error}`);
    process.exitCode = error instanceof CliError ? error.code : 1;
  }
}
