import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import { GraphStore } from "../src/graphs";
import { AuditLog, userAgentFamily } from "../src/audit/log";
import { mcpApiHandler, mcpHandler } from "../src/mcp";
import { RESULT_CHAR_LIMIT, capResult } from "../src/tools/common";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { registerAssetTools } from "../src/tools/assets";
import { CODE_BLOCKS_HELP, CONNECTOR_HELP } from "../src/tools/handwritten";
import { buildGraphTools, registerGraphTools } from "../src/tools/semantic";
import { CONTEXT_TOOLS, NO_CONTEXT_TOOLS, toAffectedTargets } from "../src/tools/readable";
import { DELETE_RULES, DRY_RUN_TOOLS } from "../src/tools/deletes.mjs";
import { SNAPSHOT_PLAN } from "../src/audit/snapshot";
import deleteBlocksFixture from "./fixtures/readable/delete-blocks.json";
import {
  ANNOTATIONS,
  type OpenApiSpec,
  SEMANTIC_TOOLS,
  annotationsFor,
  buildManifest,
  checkManifest,
} from "../src/tools/spec.mjs";

const ORIGIN = "https://mcp.example.com";
const WORK_TOKEN = "logseq_pat_WorkToken123";
const NOTES_TOKEN = "logseq_pat_NotesToken456";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const NOTES_ID = "22222222-2222-2222-2222-222222222222";

type SyncHandler = (request: Request) => Response | Promise<Response>;
let syncHandler: SyncHandler;
let syncRequests: { method: string; url: string; auth: string | null; body: string; stamp: string | null }[];
let consoleSpies: MockInstance[];

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function testEnv(overrides: Partial<Env> = {}): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      syncRequests.push({
        method: request.method,
        url: request.url,
        auth: request.headers.get("Authorization"),
        body: await request.clone().text(),
        stamp: request.headers.get("x-logseq-edit-stamp"),
      });
      return syncHandler(request);
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync, ...overrides } as Env;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await store().add({
    alias: "work",
    graphId: WORK_ID,
    graphName: "My Work Graph",
    mode: "write",
    permission: "both",
    expiresAt: dateIn(10),
    token: WORK_TOKEN,
  });
  await store().add({
    alias: "notes",
    graphId: NOTES_ID,
    graphName: "Notes",
    mode: "read",
    permission: "read",
    expiresAt: null,
    token: NOTES_TOKEN,
  });
  syncRequests = [];
  syncHandler = () => Response.json({ error: "unexpected sync call" }, { status: 500 });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function logged(): string[] {
  return consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
}

type Handler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

/** One JSON-RPC call to an MCP handler; returns the `result` member. */
async function rpc(
  handler: Handler,
  method: string,
  params: unknown,
  e: Env = testEnv(),
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ctx = createExecutionContext();
  const res = await handler(request, e, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((msg) => msg.id === 1)
    : JSON.parse(text);
  expect(json.error).toBeUndefined();
  return json.result;
}

function connector(e: Env = testEnv()): Handler {
  return (request, _env, ctx) => mcpHandler(e, ctx)(request, e, ctx);
}

/** The server's JSON in a write's joined text: what follows the summary's audit entry line. */
function writeJson(text: string): unknown {
  expect(text).toMatch(/(^|\n)Logged as audit entry \d+\n/);
  return JSON.parse(text.replace(/^[\s\S]*?Logged as audit entry \d+\n/, ""));
}

async function listTools(): Promise<any[]> {
  return (await rpc(connector(), "tools/list", {})).tools;
}

async function callTool(name: string, args: Record<string, unknown>, handler: Handler = connector()) {
  const result = await rpc(handler, "tools/call", { name, arguments: args });
  return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

const spec = openapi as unknown as OpenApiSpec;

describe("tool list", () => {
  it("contains snake_case operationId names for pages/blocks/tasks/tags/properties/search and excludes e2ee, createAsset, getAsset, listGraphs", async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      "list_pages",
      "create_page",
      "get_page",
      "update_page",
      "delete_page",
      "list_page_blocks",
      "get_block",
      "get_blocks",
      "update_block",
      "delete_blocks",
      "insert_block_tree",
      "insert_block_children",
      "move_blocks",
      "batch_move_blocks",
      "batch_insert_block_trees",
      "set_block_property",
      "batch_set_block_property",
      "capture_to_today",
      "list_tasks",
      "create_task",
      "list_tags",
      "create_tag",
      "list_tag_objects",
      "list_properties",
      "create_property",
      "search_graph",
      "list_assets",
      "list_graphs",
      "connector_help",
      "save_document",
      "save_file_from_url",
      "read_file",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(name).not.toMatch(/e2ee/);
    }
    expect(names).not.toContain("create_asset");
    expect(names).not.toContain("get_asset");
    expect(names.filter((n) => n === "list_graphs")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);

    // Every generated tool takes the alias as `graph`, never a raw `graph-id`.
    const listGraphs = tools.find((t) => t.name === "list_graphs");
    expect(listGraphs.inputSchema.properties ?? {}).toEqual({});
    for (const tool of tools.filter((t) => !["list_graphs", "connector_help"].includes(t.name))) {
      expect(tool.inputSchema.properties).not.toHaveProperty("graph-id");
      expect(tool.inputSchema.properties.graph.description).toBe("Graph alias from list_graphs");
      expect(tool.inputSchema.required).toContain("graph");
    }
  });

  it("matches the committed tools-manifest.json, less the semantic search tools while those are off", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual(committedManifest.map((e) => e.name).filter((n) => !SEMANTIC_TOOLS.includes(n)));
  });
});

const HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** A server built as mcpHandler builds it with semantic search on (tools/list never calls AI or Vectorize). */
function semanticOnEnv(): Env {
  return testEnv({ AI: {} as Ai, VECTORIZE: {} as Vectorize, SEMANTIC_MAX_VECTORS: "10000" });
}

/** A copy of the spec with one more graph operation, which no annotations entry covers. */
function specWithFakeOperation(): OpenApiSpec {
  const changed = structuredClone(spec);
  changed.paths["/api/v1/graphs/{graph-id}/fake"] = {
    get: {
      operationId: "fakeOperation",
      summary: "Fake",
      parameters: [{ name: "graph-id", in: "path", required: true, schema: { type: "string" } }],
    },
  };
  return changed;
}

/** Spec section 4's classes, from the tool's name and method, independent of the table under test. */
const READ_HANDWRITTEN = ["get_activity_log", "connector_help", "list_graphs", "kb_index", "semantic_search", "semantic_index_status", "read_file", "suggest_links"];
// Reads sent as POST because their input can be long (patch 0039).
const READ_NOT_GET = ["datalog_query"];
const DESTRUCTIVE_NAMED = [
  "batch_delete_block_property",
  "update_page",
  "update_block",
  "update_tag",
  "update_property",
  "set_block_property",
  "batch_set_block_property",
  "refresh_refs",
  "promote_page_to_tag",
  // favorite=false removes the page from the favourites list (patch 0038).
  "set_page_favorite",
  // It overwrites which page each favourite slot links (patch 0038).
  "reorder_favorites",
  // Its entries' properties replace an existing target's values.
  "batch_insert_block_trees",
];
const ADDITIVE_NAMED = [
  "capture_to_today",
  "move_blocks",
  "batch_move_blocks",
  "save_document",
  "save_file_from_url",
];

function expectedHints(name: string, method: string | null) {
  const classes: string[] = [];
  if (method === "GET" || READ_HANDWRITTEN.includes(name) || READ_NOT_GET.includes(name)) classes.push("read");
  if (name.startsWith("delete_") || DESTRUCTIVE_NAMED.includes(name)) classes.push("destructive");
  if (/^(create|insert)_/.test(name) || ADDITIVE_NAMED.includes(name)) classes.push("additive");
  // A new tool must be classified on purpose, and no tool may sit in two classes.
  expect(classes, `${name} is in exactly one class`).toHaveLength(1);
  const openWorldHint = name === "save_file_from_url";
  if (classes[0] === "read") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
  if (classes[0] === "additive") return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint };
  // reorder_favorites overwrites the whole order: repeating it changes nothing (spec 2026-11-09 §3.7).
  const idempotentHint = /^(batch_)?(delete|set)_/.test(name) || name === "reorder_favorites";
  return { readOnlyHint: false, destructiveHint: true, idempotentHint, openWorldHint };
}

describe("annotations", () => {
  it("every tool has annotations (and annotationsFor of an unknown tool throws)", () => {
    const names = committedManifest.map((e) => e.name);
    for (const name of names) {
      expect(Object.keys(ANNOTATIONS[name] ?? {}).sort(), name).toEqual([...HINT_KEYS].sort());
      for (const key of HINT_KEYS) expect(typeof ANNOTATIONS[name][key], `${name}.${key}`).toBe("boolean");
      expect(annotationsFor(name)).toEqual(ANNOTATIONS[name]);
    }
    // No stale entries for tools that no longer exist.
    expect(Object.keys(ANNOTATIONS).sort()).toEqual([...names].sort());
    expect(() => annotationsFor("not_a_tool")).toThrow("no annotations for tool not_a_tool");
    // Inherited keys are not entries.
    expect(() => annotationsFor("toString")).toThrow("no annotations for tool toString");
    // A generated tool with no entry fails the build: the manifest and the isolate's tools both refuse it.
    const changed = specWithFakeOperation();
    expect(() => buildManifest(changed)).toThrow("no annotations for tool fake_operation");
    expect(() => buildGraphTools(changed, { env: testEnv(), resolve: async () => null })).toThrow(
      "no annotations for tool fake_operation",
    );
  });

  it("registered tools use the table (semantic on)", async () => {
    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(committedManifest.map((e) => e.name));
    const differing = tools
      .filter((t: { name: string; annotations: unknown }) => JSON.stringify(t.annotations) !== JSON.stringify(ANNOTATIONS[t.name]))
      .map((t: { name: string }) => t.name);
    expect(differing).toEqual([]);
    for (const tool of tools) expect(tool.annotations, tool.name).toEqual(ANNOTATIONS[tool.name]);
  });

  it("expected hints: destructive writes, idempotent deletes and sets, read-only reads, open world for URL fetches only", async () => {
    const methods = new Map(committedManifest.map((e) => [e.name, e.method]));
    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    const counts = { read: 0, destructive: 0, additive: 0 };
    const wrong: Record<string, string> = {};
    for (const tool of tools) {
      const want = expectedHints(tool.name, methods.get(tool.name) ?? null);
      const got = tool.annotations ?? {};
      const off = HINT_KEYS.filter((k) => got[k] !== want[k]).map((k) => `${k}=${got[k]}`);
      if (off.length > 0) wrong[tool.name] = off.join(" ");
    }
    expect(wrong).toEqual({});
    for (const tool of tools) {
      const want = expectedHints(tool.name, methods.get(tool.name) ?? null);
      expect(tool.annotations, tool.name).toEqual(want);
      expect(ANNOTATIONS[tool.name], tool.name).toEqual(want);
      counts[want.readOnlyHint ? "read" : want.destructiveHint ? "destructive" : "additive"] += 1;
    }
    expect(counts.read).toBeGreaterThan(15);
    expect(counts.destructive).toBeGreaterThan(10);
    expect(counts.additive).toBeGreaterThan(8);
    // The data-losing calls the HTTP method hid, named one by one.
    for (const name of [
      "batch_delete_block_property",
      "update_property",
      "update_block",
      "set_block_property",
      "refresh_refs",
      "promote_page_to_tag",
      "batch_insert_block_trees",
    ]) {
      expect(ANNOTATIONS[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const name of ["delete_blocks", "delete_page", "set_block_property", "batch_set_block_property"]) {
      expect(ANNOTATIONS[name].idempotentHint, name).toBe(true);
    }
    for (const name of ["update_block", "move_blocks", "save_document", "batch_insert_block_trees"]) {
      expect(ANNOTATIONS[name].idempotentHint, name).toBe(false);
    }
    expect(Object.keys(ANNOTATIONS).filter((name) => ANNOTATIONS[name].openWorldHint)).toEqual(["save_file_from_url"]);
  });
});

const REASON = "tidy duplicate notes";
const PAGE_UUID = "55555555-5555-4555-8555-555555555555";

/** One write per input shape the generated tools have: a body object, a body list, no body, query flags, path and body. */
const WRITE_CALLS: [string, Record<string, unknown>][] = [
  ["update_block", { graph: "work", "block-id": "b1", body: { title: "New title" } }],
  ["delete_blocks", { graph: "work", body: { "block-ids": ["b1", "b2"] } }],
  ["delete_block", { graph: "work", "block-id": "b1" }],
  ["delete_page", { graph: "work", "page-id": PAGE_UUID, "dry-run": true }],
  ["create_page", { graph: "work", body: { title: "Standup" } }],
  ["set_block_property", { graph: "work", "block-id": "b1", "property-id": "p1", body: { value: 1 } }],
  ["move_blocks", { graph: "work", body: { "block-ids": ["b1"], "target-id": "b2", position: "after" } }],
  ["capture_to_today", { graph: "work", body: { blocks: [{ title: "Note" }] } }],
  ["promote_page_to_tag", { graph: "work", "page-id": PAGE_UUID }],
];

/** tools/call with the result's content items kept apart. */
async function callContent(name: string, args: Record<string, unknown>, handler: Handler = connector()) {
  const result = await rpc(handler, "tools/call", { name, arguments: args });
  return { isError: result.isError === true, content: result.content as { type: string; text: string }[] };
}

/** A server registered as mcpHandler registers the writing tools, with `onSuccess` observed. */
function observedConnector(onSuccess: (...args: unknown[]) => void): Handler {
  return (request, _env, ctx) => {
    const e = testEnv();
    const access = { env: e, resolve: (alias: string) => store().resolve(alias) };
    const tools = buildGraphTools(spec, access);
    return createMcpHandler(
      () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        const audit = { log: new AuditLog(e.DB), access, client: null, session: null };
        registerGraphTools(server, tools, onSuccess, audit);
        registerAssetTools(server, access, onSuccess, audit);
        return server;
      },
      { route: "/mcp" },
    )(request, e, ctx);
  };
}

/** A sync stub answering every call with an empty JSON object, and uploads like createAsset. */
function acceptEverything(): void {
  syncHandler = preReadsEmpty((request) =>
    new URL(request.url).pathname.endsWith("/assets")
      ? Response.json({ uuid: "a1", "page-id": PAGE_UUID, "page-title": "Nov 5th, 2026" }, { status: 201 })
      : Response.json({ ok: true }),
  );
}

/**
 * `handler` for writes, with each before-snapshot GET (audit stage 3) answered by a valid, empty
 * snapshot: getBlocks finds each id as an empty block (a delete of a block the read lists as missing
 * is refused), and a page, tag or property read finds an empty entity. test/audit-snapshot.test.ts
 * covers the snapshots themselves.
 */
function preReadsEmpty(handler: SyncHandler): SyncHandler {
  return (request) => {
    if (request.method !== "GET") return handler(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/blocks")) {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return Response.json({ blocks: ids.map((uuid) => ({ uuid, kind: "block", title: "", markdown: "", "block-count": 0, truncated: false })), missing: [] });
    }
    return Response.json({ uuid: PAGE_UUID, kind: "page", title: "Notes", markdown: "", "block-count": 0, truncated: false });
  };
}

/** The requests that weren't before-snapshot reads. */
function writeRequests(): typeof syncRequests {
  return syncRequests.filter((r) => r.method !== "GET");
}

describe("reason", () => {
  it("reason in every write schema, none on reads", async () => {
    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    const writes = tools.filter((t: { annotations: { readOnlyHint: boolean } }) => !t.annotations.readOnlyHint);
    const reads = tools.filter((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint);
    expect(writes.length).toBeGreaterThan(20);
    expect(reads.length).toBeGreaterThan(15);
    const missing = writes.filter((t: any) => t.inputSchema.properties?.reason === undefined).map((t: any) => t.name);
    expect(missing).toEqual([]);
    for (const tool of writes) {
      const reason = tool.inputSchema.properties.reason;
      expect(reason.type, tool.name).toBe("string");
      expect(reason.description, tool.name).toContain("at most 200 characters");
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("reason");
    }
    for (const name of ["save_document", "save_file_from_url", "delete_block", "delete_page", "update_block"]) {
      expect(writes.map((t: { name: string }) => t.name), name).toContain(name);
    }
    const onReads = reads.filter((t: any) => t.inputSchema.properties?.reason !== undefined).map((t: any) => t.name);
    expect(onReads).toEqual([]);
  });

  it("reason never reaches the server, whatever the write's shape", async () => {
    acceptEverything();
    for (const [name, args] of WRITE_CALLS) {
      syncRequests = [];
      const withReason = await callContent(name, { ...args, reason: REASON });
      expect(withReason.isError, name).toBe(false);
      const sentWith = syncRequests.map(({ method, url, body }) => ({ method, url, body }));
      syncRequests = [];
      await callContent(name, args);
      const sentWithout = syncRequests.map(({ method, url, body }) => ({ method, url, body }));
      // The requests are exactly the ones the call makes without a reason: one write, after at most
      // one before-snapshot read, and none of them carries the reason.
      expect(sentWith, name).toEqual(sentWithout);
      expect(sentWith.filter((r) => r.method !== "GET"), name).toHaveLength(1);
      expect(sentWith.length, name).toBeLessThanOrEqual(2);
      for (const sent of sentWith) {
        expect(new URL(sent.url).searchParams.has("reason"), name).toBe(false);
        expect(sent.url, name).not.toContain("tidy");
        expect(sent.body, name).not.toContain("tidy");
        expect(sent.body, name).not.toContain("reason");
      }
    }
  });

  it("reason over 200 characters is refused before any fetch", async () => {
    acceptEverything();
    for (const reason of ["x".repeat(201), "🙂".repeat(201)]) {
      for (const [name, args] of [...WRITE_CALLS, ["delete_block", { graph: "nope", "block-id": "b1" }] as const]) {
        const result = await callContent(name, { ...args, reason });
        expect(result, name).toEqual({
          isError: true,
          content: [{ type: "text", text: "reason is 201 characters; at most 200 are accepted — shorten it" }],
        });
      }
    }
    expect(syncRequests).toHaveLength(0);
    // Exactly 200 characters, emoji counted as one each, is accepted.
    for (const reason of ["x".repeat(200), "🙂".repeat(200)]) {
      const ok = await callContent("delete_block", { graph: "work", "block-id": "b1", reason });
      expect(ok.isError).toBe(false);
      expect(ok.content[0].text).toMatch(new RegExp(`^Reason: ${reason}\nLogged as audit entry \\d+$`, "u"));
    }
    expect(syncRequests).toHaveLength(2);
  });

  it("reason is repeated as the first content item, ahead of the unchanged result", async () => {
    syncHandler = () => Response.json({ uuid: "b1", title: "New title" });
    const args = { graph: "work", "block-id": "b1", body: { title: "New title" } };
    // Every write's summary ends with its audit entry line; the server's result follows unchanged.
    const entry = (text: string) => Number(/Logged as audit entry (\d+)$/.exec(text)?.[1]);
    const without = await callContent("update_block", args);
    expect(without.content).toHaveLength(2);
    const id = entry(without.content[0].text);
    expect(without.content[0].text).toBe(`Logged as audit entry ${id}`);
    const withReason = await callContent("update_block", { ...args, reason: `  ${REASON} ` });
    expect(withReason).toEqual({
      isError: false,
      content: [{ type: "text", text: `Reason: ${REASON}\nLogged as audit entry ${id + 1}` }, without.content[1]],
    });
    // No reason, an empty one or one of only spaces leaves the summary without a reason line.
    for (const [i, reason] of ["", "   "].entries()) {
      expect(await callContent("update_block", { ...args, reason }), JSON.stringify(reason)).toEqual({
        isError: false,
        content: [{ type: "text", text: `Logged as audit entry ${id + 2 + i}` }, without.content[1]],
      });
    }
    // A write the server refuses carries only the refusal.
    syncHandler = () => Response.json({ error: "block not found" }, { status: 409 });
    expect(await callContent("update_block", { ...args, reason: REASON })).toEqual({
      isError: true,
      content: [{ type: "text", text: "block not found" }],
    });
  });

  it("log carries reason=yes|no, never the text", async () => {
    acceptEverything();
    await callContent("update_block", { graph: "work", "block-id": "b1", body: { title: "x" }, reason: REASON });
    await callContent("update_block", { graph: "work", "block-id": "b1", body: { title: "x" } });
    await callContent("update_block", { graph: "work", "block-id": "b1", body: { title: "x" }, reason: " " });
    await callContent("delete_block", { graph: "work", "block-id": "b1", reason: "y".repeat(201) });
    await callContent("delete_block", { graph: "notes", "block-id": "b1", reason: REASON });
    await callContent("get_page", { graph: "work", "page-id": "p1" });
    // A read given a reason anyway: the schema has none, so it is dropped and not logged.
    await callContent("get_page", { graph: "work", "page-id": "p1", reason: REASON });
    const lines = logged().map((line) => line.replace(/ms=\d+$/, "ms=N"));
    expect(lines).toEqual([
      "tool update_block graph=work status=ok reason=yes ms=N",
      "tool update_block graph=work status=ok reason=no ms=N",
      "tool update_block graph=work status=ok reason=no ms=N",
      "tool delete_block graph=work status=refused reason=yes ms=N",
      "tool delete_block graph=notes status=read-only reason=yes ms=N",
      "tool get_page graph=work status=ok ms=N",
      "tool get_page graph=work status=ok ms=N",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("tidy");
      expect(line).not.toContain("yyy");
    }
  });

  it("onSuccess receives {reason, targets: []} on writes and nothing more on reads", async () => {
    acceptEverything();
    const onSuccess = vi.fn();
    const handler = observedConnector(onSuccess);
    await callContent("update_block", { graph: "work", "block-id": "b1", body: { title: "x" }, reason: REASON }, handler);
    await callContent("delete_page", { graph: "work", "page-id": PAGE_UUID }, handler);
    await callContent("save_document", { graph: "work", fileName: "a.md", text: "a", reason: REASON }, handler);
    await callContent("get_page", { graph: "work", "page-id": "p1" }, handler);
    // Refused calls never reach onSuccess.
    await callContent("delete_block", { graph: "work", "block-id": "b1", reason: "x".repeat(201) }, handler);
    syncHandler = () => Response.json({ error: "no" }, { status: 409 });
    await callContent("delete_block", { graph: "work", "block-id": "b1", reason: REASON }, handler);
    expect(onSuccess.mock.calls).toEqual([
      ["update_block", "work", { reason: REASON, targets: [] }],
      ["delete_page", "work", { reason: undefined, targets: [] }],
      ["save_document", "work", { reason: REASON, targets: [] }],
      ["get_page", "work"],
    ]);
    expect(Object.keys(onSuccess.mock.calls[1][2])).toEqual(["reason", "targets"]);
  });

  it("onSuccess receives the targets the server names, and the summary leads the result", async () => {
    const deleted = deleteBlocksFixture.response;
    syncHandler = preReadsEmpty(() => Response.json(deleted));
    const onSuccess = vi.fn();
    const handler = observedConnector(onSuccess);
    const result = await callContent(
      "delete_blocks",
      { graph: "work", body: { "block-ids": deleted.affected.map((a) => a.uuid) }, reason: REASON },
      handler,
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const [tool, alias, outcome] = onSuccess.mock.calls[0];
    expect([tool, alias, outcome.reason]).toEqual(["delete_blocks", "work", REASON]);
    expect(outcome.targets).toEqual(toAffectedTargets(deleted));
    expect(outcome.targets.map((t: { uuid: string; pageTitle: string }) => [t.uuid, t.pageTitle])).toEqual(
      deleted.affected.map((a) => [a.uuid, "Nov 5th, 2026"]),
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toMatch(/^Deleted 3 blocks:\n- Nov 5th, 2026 > Meeting > Agenda > "Call Sam/);
    expect(result.content[0].text).toMatch(new RegExp(`\nReason: ${REASON}\nLogged as audit entry \\d+$`));
    // The server's JSON follows, unchanged.
    expect(JSON.parse(result.content[1].text)).toEqual(deleted);
    expect(result.content).toHaveLength(2);
  });

  it("a generated operation that already takes a reason stops the build", () => {
    const changed = structuredClone(spec);
    const op = changed.paths["/api/v1/graphs/{graph-id}/blocks/{block-id}"].delete;
    op.parameters = [...(op.parameters ?? []), { name: "reason", in: "query", schema: { type: "string" } }];
    expect(() => buildGraphTools(changed, { env: testEnv(), resolve: async () => null })).toThrow(
      "deleteBlock already takes a reason argument; the connector's reason would hide it",
    );
  });
});

describe("target-label", () => {
  const SINGLE = [
    "insert_block_children",
    "insert_block_tree",
    "update_block",
    "delete_block",
    "set_block_property",
    "delete_block_property",
    "move_blocks",
  ];
  const BATCHES: Array<[string, string]> = [
    ["batch_insert_block_trees", "entries"],
    ["batch_move_blocks", "moves"],
    ["batch_set_block_property", "entries"],
    ["batch_delete_block_property", "entries"],
  ];

  it("the single-target writes take target-label, each batch entry takes one, and delete_blocks takes labels", async () => {
    const tools = await listTools();
    const tool = (name: string) => tools.find((t: any) => t.name === name);
    for (const name of SINGLE) {
      const label = tool(name).inputSchema.properties["target-label"];
      expect(label?.type, name).toBe("string");
      expect(label.description, name).toContain("never used to find it");
      expect(tool(name).inputSchema.required ?? [], name).not.toContain("target-label");
    }
    for (const [name, field] of BATCHES) {
      const entry = tool(name).inputSchema.properties.body.properties[field].items;
      expect(entry.properties["target-label"]?.type, name).toBe("string");
      expect(entry.required ?? [], name).not.toContain("target-label");
    }
    const labels = tool("delete_blocks").inputSchema.properties.body.properties.labels;
    expect(labels?.type).toBe("array");
    expect(labels.items.type).toBe("string");
    expect(tool("delete_blocks").description).toContain("labels");
  });

  it("target-label reaches the server as a query parameter, and a mismatch comes back as the server words it", async () => {
    const refusal = 'target-label "Nov 5th, 2026 > Notes" does not match target "Nov 5th, 2026 > Meeting > Agenda"';
    syncHandler = () => Response.json({ error: refusal }, { status: 409 });
    const result = await callTool("update_block", {
      graph: "work",
      "block-id": "b1",
      "target-label": "Nov 5th, 2026 > Notes",
      body: { title: "Renamed" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(refusal);
    expect(syncRequests).toHaveLength(1);
    expect(new URL(syncRequests[0].url).searchParams.get("target-label")).toBe("Nov 5th, 2026 > Notes");
    expect(JSON.parse(syncRequests[0].body)).toEqual({ title: "Renamed" });

    syncRequests = [];
    syncHandler = () => Response.json({ deleted: 1, "total-removed": 1, affected: [] });
    const labels = ["Nov 5th, 2026 > Notes"];
    await callTool("delete_blocks", { graph: "work", body: { "block-ids": ["b1"], labels } });
    expect(JSON.parse(syncRequests[0].body)).toMatchObject({ "block-ids": ["b1"], labels });
  });
});

describe("routing", () => {
  it("create_page on alias routes to /api/v1/graphs/<graph-id>/pages with that graph's PAT", async () => {
    syncHandler = () => Response.json({ id: "p1", title: "Standup [[Ann]]" }, { status: 201 });
    const before = await store().get("work");
    expect(before?.lastUsedAt).toBeNull();

    const result = await callTool("create_page", { graph: "work", body: { title: "Standup [[Ann]]" } });

    expect(result.isError).toBe(false);
    expect(writeJson(result.text)).toEqual({ id: "p1", title: "Standup [[Ann]]" });
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0]).toEqual({
      method: "POST",
      url: `https://sync.internal/api/v1/graphs/${WORK_ID}/pages`,
      auth: `Bearer ${WORK_TOKEN}`,
      body: JSON.stringify({ title: "Standup [[Ann]]" }),
      stamp: "claude",
    });
    expect((await store().get("work"))?.lastUsedAt).not.toBeNull();
    expect((await store().get("notes"))?.lastUsedAt).toBeNull();

    // Logs carry the tool, alias, status and duration only.
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^tool create_page graph=work status=ok reason=no ms=\d+$/);
  });

  it("passes other path and query arguments through and reads with the read-only graph's own PAT", async () => {
    syncHandler = () => Response.json({ pages: [] });
    const result = await callTool("list_page_blocks", { graph: "notes", "page-id": "a b/c", limit: 5 });
    expect(result.isError).toBe(false);
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0].method).toBe("GET");
    expect(syncRequests[0].url).toBe(`https://sync.internal/api/v1/graphs/${NOTES_ID}/pages/a%20b%2Fc/blocks?limit=5`);
    expect(syncRequests[0].auth).toBe(`Bearer ${NOTES_TOKEN}`);
  });

  it("forwards a page title with / and % whole, so the server's page selector gets it back intact", async () => {
    syncHandler = (request) => {
      const segment = new URL(request.url).pathname.split("/")[6];
      return Response.json({ uuid: "33333333-3333-3333-3333-333333333333", title: decodeURIComponent(segment) });
    };
    for (const [title, encoded] of [
      ["Projects/Alpha", "Projects%2FAlpha"],
      ["100% Done", "100%25%20Done"],
    ]) {
      const result = await callTool("get_page", { graph: "notes", "page-id": title });
      expect(result.isError).toBe(false);
      expect(syncRequests.at(-1)?.url).toBe(`https://sync.internal/api/v1/graphs/${NOTES_ID}/pages/${encoded}`);
      expect(JSON.parse(result.text).title).toBe(title);
    }
  });

  it("unknown alias fails without any sync call", async () => {
    const unknown = await callTool("get_page", { graph: "nope", "page-id": "p1" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown graph 'nope'");

    // An alias removed just before the call is unknown too.
    const handler = connector();
    await store().remove("work");
    const removed = await callTool("create_page", { graph: "work", body: { title: "x" } }, handler);
    expect(removed.isError).toBe(true);
    expect(removed.text).toContain("unknown graph 'work'");

    // A malformed alias never reaches the store or the sync server.
    for (const graph of ["../work", "Work", "work/pages", "", "-work"]) {
      const bad = await callTool("get_page", { graph, "page-id": "p1" });
      expect(bad.isError, graph).toBe(true);
    }
    expect(syncRequests).toHaveLength(0);
  });

  it("dot-segment and empty path arguments are refused without a sync call", async () => {
    for (const pageId of ["..", "."]) {
      const result = await callTool("get_page", { graph: "work", "page-id": pageId });
      expect(result).toEqual({ isError: true, text: "path arguments may not be '.' or '..'" });
    }
    const empty = await callTool("get_page", { graph: "work", "page-id": "" });
    expect(empty).toEqual({ isError: true, text: "path arguments may not be empty" });
    expect(syncRequests).toHaveLength(0);
  });

  it("bulk tools: get_blocks reads with ids, delete_blocks sends its body with DELETE", async () => {
    syncHandler = () => Response.json({ blocks: [], missing: [] });
    const read = await callTool("get_blocks", { graph: "notes", ids: "b1,b2", view: "outline" });
    expect(read.isError).toBe(false);
    expect(syncRequests[0].method).toBe("GET");
    expect(syncRequests[0].url).toBe(`https://sync.internal/api/v1/graphs/${NOTES_ID}/blocks?ids=b1%2Cb2&view=outline`);

    syncRequests = [];
    syncHandler = () => Response.json({ deleted: 2, "total-removed": 3, "dry-run": true });
    const deleted = await callTool("delete_blocks", { graph: "work", body: { "block-ids": ["b1", "b2"], "dry-run": true } });
    expect(deleted.isError).toBe(false);
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0].method).toBe("DELETE");
    expect(syncRequests[0].url).toBe(`https://sync.internal/api/v1/graphs/${WORK_ID}/blocks`);
    expect(JSON.parse(syncRequests[0].body)).toEqual({ "block-ids": ["b1", "b2"], "dry-run": true });

    const tools = await listTools();
    expect(tools.find((t) => t.name === "delete_blocks").annotations.destructiveHint).toBe(true);
  });

  it("get_blocks takes view=signals and a property, and forwards both (patch 0035)", async () => {
    syncHandler = () => Response.json({ blocks: [], missing: [] });
    const read = await callTool("get_blocks", {
      graph: "notes",
      ids: "b1,b2",
      view: "signals",
      property: "user.property/project-status",
    });
    expect(read.isError, read.text).toBe(false);
    expect(syncRequests).toHaveLength(1);
    const url = new URL(syncRequests[0].url);
    expect(url.pathname).toBe(`/api/v1/graphs/${NOTES_ID}/blocks`);
    expect(url.searchParams.get("view")).toBe("signals");
    expect(url.searchParams.get("property")).toBe("user.property/project-status");

    const tool = (await listTools()).find((t) => t.name === "get_blocks");
    expect(tool.inputSchema.properties.view.enum).toEqual(["summary", "outline", "signals"]);
    expect(tool.inputSchema.properties.property.description).toContain("view=signals only");
    expect(tool.description).toContain("stopping at 1000");
  });

  it("write tools that echo inserted blocks default to verbose=false; verbose: true asks for titles", async () => {
    syncHandler = () => Response.json({ blocks: [{ uuid: "b1" }], count: 1 }, { status: 201 });
    const tree = { "target-id": "p1", blocks: [{ title: "Note" }] };
    const compact = await callTool("insert_block_tree", { graph: "work", body: tree });
    expect(compact.isError).toBe(false);
    expect(new URL(syncRequests[0].url).searchParams.get("verbose")).toBe("false");

    syncRequests = [];
    await callTool("insert_block_tree", { graph: "work", verbose: true, body: tree });
    expect(new URL(syncRequests[0].url).searchParams.get("verbose")).toBe("true");

    const tools = await listTools();
    for (const name of ["insert_block_tree", "insert_block_children", "capture_to_today", "batch_insert_block_trees"]) {
      const verbose = tools.find((t) => t.name === name).inputSchema.properties.verbose;
      expect(verbose.default, name).toBe(false);
      expect(verbose.description, name).toContain("Defaults to false here");
    }
  });

  it("write tool on read-mode graph refused without sync call", async () => {
    for (const [name, args] of [
      ["create_page", { graph: "notes", body: { title: "x" } }],
      ["delete_block", { graph: "notes", "block-id": "b1" }],
      ["set_block_property", { graph: "notes", "block-id": "b1", "property-id": "p1", body: { value: 1 } }],
      ["delete_blocks", { graph: "notes", body: { "block-ids": ["b1"] } }],
      ["batch_insert_block_trees", { graph: "notes", body: { entries: [{ page: "P", blocks: [{ title: "x" }] }] } }],
    ] as const) {
      const result = await callTool(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text).toBe("graph 'notes' is read-only");
    }
    expect(syncRequests).toHaveLength(0);
  });

  it("a read sent as POST runs on a read-mode graph: datalog_query reaches the sync server, while a POST write next to it is refused", async () => {
    syncHandler = () => Response.json({ columns: [], rows: [], "total-rows": 0, returned: 0, query: "[]", inputs: "[]" });
    const read = await callTool("datalog_query", { graph: "notes", body: { query: "[:find ?t :where [?e :block/title ?t]]" } });
    expect(read.isError, read.text).toBe(false);
    expect(syncRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["POST", `/api/v1/graphs/${NOTES_ID}/query`]]);
    const write = await callTool("create_page", { graph: "notes", body: { title: "x" } });
    expect(write).toMatchObject({ isError: true, text: "graph 'notes' is read-only" });
    expect(syncRequests).toHaveLength(1);
  });
});

describe("errors", () => {
  it("401 maps to reconnect message, 429 maps to retry message using Retry-After and makes exactly one sync call", async () => {
    for (const status of [401, 403]) {
      syncRequests = [];
      syncHandler = () => Response.json({ error: "unauthorized" }, { status });
      const result = await callTool("get_page", { graph: "work", "page-id": "p1" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        "token for graph 'work' expired or lacks permission — reconnect it at https://mcp.example.com/graphs",
      );
      expect(syncRequests).toHaveLength(1);
    }

    syncRequests = [];
    syncHandler = () => Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "17" } });
    const limited = await callTool("create_page", { graph: "work", body: { title: "x" } });
    expect(limited.isError).toBe(true);
    expect(limited.text).toBe("rate limited — retry after 17 s");
    expect(syncRequests).toHaveLength(1);

    syncRequests = [];
    syncHandler = () => Response.json({ error: "slow down" }, { status: 429 });
    const noHeader = await callTool("create_page", { graph: "work", body: { title: "x" } });
    expect(noHeader.text).toBe("rate limited — retry after 60 s");
    expect(syncRequests).toHaveLength(1);
    expect((await store().get("work"))?.lastUsedAt).toBeNull();

    expect(logged().at(-1)).toMatch(/^tool create_page graph=work status=http-429 reason=no ms=\d+$/);
  });

  it("400 maps to the server's message", async () => {
    syncHandler = () => Response.json({ error: "title is required" }, { status: 400 });
    const result = await callTool("create_page", { graph: "work", body: { title: "" } });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("title is required");
  });

  it("409 maps to the server's message", async () => {
    const message = 'title "Inbox" is already used by page "Inbox" (p1); nothing was created.';
    syncHandler = () => Response.json({ error: message, existing: [] }, { status: 409 });
    const result = await callTool("create_page", { graph: "work", body: { title: "Inbox" } });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(message);
  });

  it("a failing touch does not mask the tool result", async () => {
    syncHandler = () => Response.json({ ok: true });
    // The store's D1 answers every query except the last-used update.
    const db = {
      prepare(sql: string) {
        if (sql.startsWith("UPDATE graphs SET last_used_at")) throw new Error("D1 unavailable");
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
    const result = await callTool("get_page", { graph: "work", "page-id": "p1" }, connector(testEnv({ DB: db })));
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ ok: true });
    // The touch runs alongside the response, so the two lines may come in either order.
    const lines = logged().map((line) => line.replace(/ms=\d+$/, "ms=N")).sort();
    expect(lines).toEqual([
      "tool get_page graph=work status=ok ms=N",
      "tool get_page graph=work status=touch-failed ms=N",
    ]);
  });

  it("caps result text at 150,000 characters with a truncation notice", async () => {
    syncHandler = () => Response.json({ pages: [{ title: "x".repeat(200_000) }] });
    const result = await callTool("list_pages", { graph: "work" });
    expect(result.isError).toBe(false);
    expect(result.text).toHaveLength(RESULT_CHAR_LIMIT);
    expect(result.text).toMatch(/\[truncated: the result had \d+ characters and the limit is 150000; .*\]$/);

    // Across several items: text after the cut is dropped, other content is kept.
    const capped = capResult({
      content: [
        { type: "text", text: "a".repeat(100_000) },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "b".repeat(100_000) },
        { type: "text", text: "c" },
      ],
    });
    expect(capped.content.map((c) => c.type)).toEqual(["text", "image", "text"]);
    const texts = capped.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
    expect(texts.join("")).toHaveLength(RESULT_CHAR_LIMIT);
    expect(capResult({ content: [{ type: "text", text: "short" }] })).toEqual({ content: [{ type: "text", text: "short" }] });
  });
});

describe("hand-written tools", () => {
  it("list_graphs exposes no token", async () => {
    const result = await callTool("list_graphs", {});
    expect(result.isError).toBe(false);
    for (const secret of [WORK_TOKEN, NOTES_TOKEN, "logseq_pat_", WORK_ID, NOTES_ID]) {
      expect(result.text).not.toContain(secret);
    }
    const graphs = JSON.parse(result.text);
    expect(graphs).toEqual([
      { alias: "notes", graphName: "Notes", mode: "read", expiresAt: null, expiryWarning: null },
      {
        alias: "work",
        graphName: "My Work Graph",
        mode: "write",
        expiresAt: dateIn(10),
        expiryWarning: expect.stringMatching(/^token expires in (9|10) days — replace it at https:\/\/mcp\.example\.com\/graphs$/),
      },
    ]);
    expect(syncRequests).toHaveLength(0);
  });

  it("create_property and update_property take a node property's classes, and say how", async () => {
    const tools = await listTools();
    const create = tools.find((t) => t.name === "create_property");
    const update = tools.find((t) => t.name === "update_property");
    expect(create.inputSchema.properties.body.properties.classes.type).toBe("array");
    expect(Object.keys(update.inputSchema.properties.body.properties.classes.properties).sort()).toEqual(["add", "remove", "set"]);
    expect(create.description).toContain("Give a node property its classes when creating it");
    expect(update.description).toContain("exactly one of set, add or remove");
    expect(update.description).toContain("{set: []}");
    expect(update.description).toContain("out_of_class");
    expect(update.description).toContain("holders left empty aren't counted");
    expect(update.description).toContain("A built-in property's classes, such as Assignee's, can't be changed");
  });

  it("create_property and update_property take choices, and say how", async () => {
    const tools = await listTools();
    const create = tools.find((t) => t.name === "create_property");
    const update = tools.find((t) => t.name === "update_property");
    const created = create.inputSchema.properties.body.properties.choices;
    expect(created.type).toBe("array");
    expect(created.items.required).toEqual(["title"]);
    expect(Object.keys(created.items.properties.icon.properties).sort()).toEqual(["id", "type"]);
    const choices = update.inputSchema.properties.body.properties.choices;
    expect(Object.keys(choices.properties).sort()).toEqual(["add", "order", "retire", "update"]);
    expect(choices.properties.update.items.required).toEqual(["choice"]);
    const icon = choices.properties.update.items.properties.icon;
    expect(icon.anyOf.map((s: { type: string }) => s.type).sort()).toEqual(["null", "object"]);
    expect(choices.properties.order.items.type).toBe("string");
    expect(create.description).toContain("Give a property its choices when creating it");
    expect(update.description).toContain("choices.add, choices.update and choices.order");
    expect(update.description).toContain("icon: null");
  });

  it("update_property retires choices behind acknowledge-holders and previews with dry-run", async () => {
    const tools = await listTools();
    const update = tools.find((t) => t.name === "update_property");
    expect(update.inputSchema.properties["dry-run"].type).toBe("boolean");
    expect(update.inputSchema.properties["acknowledge-holders"].type).toBe("boolean");
    expect(update.inputSchema.properties.body.properties.choices.properties.retire.items.type).toBe("string");
    expect(update.description).toContain("choices.retire");
    expect(update.description).toContain("run it with dry-run first");
    expect(update.description).toContain("only acknowledge a loss the user agreed to");
    expect(update.description).toContain("the choice that is the property's default value");
  });

  it("update_property converts text values with convert_values, and says how", async () => {
    const tools = await listTools();
    const update = tools.find((t) => t.name === "update_property");
    expect(update.inputSchema.properties.body.properties.convert_values.type).toBe("boolean");
    expect(update.description).toContain("convert_values: true turns a free-text (default) property into a choice property");
    expect(update.description).toContain("add those choices under choices.add in the same call");
    expect(update.description).toContain("dry-run shows the mapping");
  });

  it("update_property guards converted value blocks other blocks refer to behind acknowledge-references", async () => {
    const tools = await listTools();
    const update = tools.find((t) => t.name === "update_property");
    expect(update.inputSchema.properties["acknowledge-references"].type).toBe("boolean");
    expect(update.description).toContain("converted.referenced");
    expect(update.description).toContain("unless acknowledge-references is true");
  });

  it("create_tag and update_tag take extends and tag properties, and update_tag no longer needs a title", async () => {
    const tools = await listTools();
    const create = tools.find((t) => t.name === "create_tag");
    const update = tools.find((t) => t.name === "update_tag");
    expect(create.inputSchema.properties.body.properties.extends.type).toBe("array");
    expect(create.inputSchema.properties.body.properties.properties.type).toBe("array");
    const body = update.inputSchema.properties.body;
    expect(body.required ?? []).not.toContain("title");
    expect(body.properties.extends.type).toBe("array");
    expect(Object.keys(body.properties.properties.properties).sort()).toEqual(["add", "remove", "set"]);
    expect(create.description).toContain("extends and properties in the same call");
    expect(update.description).toContain("properties.add or properties.remove");
    expect(update.description).toContain("set replaces");
  });

  it("promote_page_to_tag takes a page's UUID, needs no body, and says what it keeps and refuses", async () => {
    const tools = await listTools();
    const promote = tools.find((t) => t.name === "promote_page_to_tag");
    expect(promote).toBeDefined();
    expect(promote.inputSchema.required.sort()).toEqual(["graph", "page-id"]);
    expect(promote.inputSchema.properties["page-id"].type).toBe("string");
    expect(promote.inputSchema.properties.body.type).toBe("object");
    expect(promote.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(promote.description).toContain(
      "Turns an existing page into a tag in place: its UUID, blocks, properties and references are kept, and links to it stay links (they aren't tagged).",
    );
    expect(promote.description).toContain("Refuses journals, built-ins, properties, namespaced pages and existing tags.");
    expect(promote.description).toContain("Setting a page's tags to Tag is refused; use this instead.");
    expect(committedManifest.find((e) => e.name === "promote_page_to_tag")).toMatchObject({
      method: "POST",
      path: "/api/v1/graphs/{graph-id}/pages/{page-id}/promote-to-tag",
    });
  });

  it("promote_page_to_tag takes extends and a dry-run flag, and says to dry-run a well-linked page first", async () => {
    const tools = await listTools();
    const promote = tools.find((t) => t.name === "promote_page_to_tag");
    expect(promote.inputSchema.properties["dry-run"].type).toBe("boolean");
    expect(promote.inputSchema.properties.body.properties.extends.type).toBe("array");
    expect(promote.inputSchema.properties.body.additionalProperties).toBe(false);
    expect(promote.description).toContain(
      "Run with dry-run first on a page with many references and show the user the counts.",
    );
    expect(promote.description).toContain("Give extends to set the tags it extends in the same call");
  });

  it("move_blocks takes a dry-run flag, sends it in the query and leads with the server's dry-run summary", async () => {
    const tools = await listTools();
    const move = tools.find((t) => t.name === "move_blocks");
    expect(move.inputSchema.properties["dry-run"].type).toBe("boolean");
    expect(move.description).toContain("dry-run: true previews from and to");
    const page = { uuid: PAGE_UUID, title: "Nov 5th, 2026" };
    syncHandler = () =>
      Response.json({ uuids: ["b1"], moved: true, "dry-run": true,
        affected: [{ uuid: "b1", kind: "block", snippet: "Notes", from: { page, breadcrumb: [] }, to: { page, breadcrumb: ["Meeting"] } }] });
    const result = await callTool("move_blocks", {
      graph: "work",
      "dry-run": true,
      reason: "check before moving",
      body: { "block-ids": ["b1"], "target-id": "b2", position: "last-child" },
    });
    expect(result.isError).toBe(false);
    expect(result.text.split("\n").slice(0, 3)).toEqual([
      "Dry run, nothing changed: would move 1 block:",
      '- "Notes" from Nov 5th, 2026 to Nov 5th, 2026 > Meeting',
      "Reason: check before moving",
    ]);
    const url = new URL(syncRequests[0].url);
    expect(url.pathname).toBe(`/api/v1/graphs/${WORK_ID}/block-moves`);
    expect(url.searchParams.get("dry-run")).toBe("true");
    expect(JSON.parse(syncRequests[0].body)).toEqual({ "block-ids": ["b1"], "target-id": "b2", position: "last-child" });
  });

  it("connector_help asks for a dry run of large deletes and moves, shown to the user before the real call", async () => {
    const help = (await callTool("connector_help", {})).text;
    expect(help).toContain(
      "Pass dry-run: true to check a large delete, move or insert first (move_blocks takes it too): it names each block the write would touch by page, breadcrumb and snippet, with its descendant and reference counts, a page's block count and first blocks, and the pages an insert would create, and changes nothing. Show the user that summary before the real call.",
    );
  });

  it("list_favorites is generated from listFavorites: a GET read on {graph} alone, annotated READ, reaching /favorites", async () => {
    const tools = await listTools();
    const list = tools.find((t) => t.name === "list_favorites");
    expect(list).toBeDefined();
    expect(Object.keys(list.inputSchema.properties)).toEqual(["graph"]);
    expect(list.inputSchema.required).toEqual(["graph"]);
    expect(list.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(list.description).toContain("in sidebar order");
    expect(list.description).toContain("Recycle bin");
    expect(committedManifest.find((e) => e.name === "list_favorites")).toMatchObject({
      method: "GET",
      path: "/api/v1/graphs/{graph-id}/favorites",
    });
    syncHandler = () => Response.json({ favorites: [{ uuid: PAGE_UUID, title: "Projects", kind: "page" }] });
    const result = await callTool("list_favorites", { graph: "work" });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ favorites: [{ uuid: PAGE_UUID, title: "Projects", kind: "page" }] });
    expect(syncRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["GET", `/api/v1/graphs/${WORK_ID}/favorites`]]);
  });

  it("datalog_query is generated from datalogQuery: a POST of {query, inputs?, rules?, limit?, dry-run?} annotated READ, with no reason and no write tables", async () => {
    const tools = await listTools();
    const query = tools.find((t) => t.name === "datalog_query");
    expect(query).toBeDefined();
    expect(query.inputSchema.required).toEqual(expect.arrayContaining(["graph", "body"]));
    expect(query.inputSchema.properties.body.required).toEqual(["query"]);
    expect(Object.keys(query.inputSchema.properties.body.properties).sort()).toEqual(["dry-run", "inputs", "limit", "query", "rules"]);
    expect(query.inputSchema.properties.reason).toBeUndefined();
    // A POST is taken for a write unless ANNOTATIONS says otherwise (patch 0039: POST only because the query can be long).
    expect(query.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const phrase of ["read-only", "Private", "E2EE", ":block/uuid", "share a variable", "default 50"]) {
      expect(query.description, phrase).toContain(phrase);
    }
    // Patch 0039 stage 2: the caps Claude has to work within, and how a cut result says so.
    for (const phrase of ["scan cap", "20,000 datoms", "422", "truncated", "byte-cap", "100,000 characters", "at most 2 levels deep", "at most 50 values", "left recursion", "row cap", "2,500 rows"]) {
      expect(query.description, phrase).toContain(phrase);
    }
    // A read never needs a delete rule, a snapshot plan or a context class: those tables throw only for write tools.
    for (const table of [DELETE_RULES, DRY_RUN_TOOLS, SNAPSHOT_PLAN, CONTEXT_TOOLS, NO_CONTEXT_TOOLS]) {
      expect(Object.hasOwn(table, "datalog_query")).toBe(false);
    }
    expect(committedManifest.find((e) => e.name === "datalog_query")).toMatchObject({
      method: "POST",
      path: "/api/v1/graphs/{graph-id}/query",
      annotations: { readOnlyHint: true },
    });
    const rows = { columns: ["?t"], rows: [["Projects"]], "total-rows": 1, returned: 1, query: "[:find ?t]", inputs: "[]" };
    syncHandler = () => Response.json(rows);
    const body = { query: "[:find ?t :where [?e :block/title ?t]]", limit: 10 };
    const result = await callTool("datalog_query", { graph: "work", body });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toEqual(rows);
    expect(syncRequests.map((r) => [r.method, new URL(r.url).pathname, JSON.parse(r.body)])).toEqual([
      ["POST", `/api/v1/graphs/${WORK_ID}/query`, { ...body, "dry-run": false }],
    ]);
  });

  it("set_page_favorite is generated from setPageFavorite: a PUT of {favorite, dry-run?} on page-id, annotated destructive and idempotent", async () => {
    const tools = await listTools();
    const set = tools.find((t) => t.name === "set_page_favorite");
    expect(set).toBeDefined();
    expect(set.inputSchema.required).toEqual(expect.arrayContaining(["graph", "page-id", "body"]));
    expect(set.inputSchema.properties.body.required).toEqual(["favorite"]);
    expect(Object.keys(set.inputSchema.properties.body.properties).sort()).toEqual(["dry-run", "favorite"]);
    expect(set.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    for (const phrase of ["appended at the bottom", "adds a new favourite at the top", "Unavailable for E2EE graphs", "already a favourite", "was not a favourite"]) {
      expect(set.description, phrase).toContain(phrase);
    }
    expect(committedManifest.find((e) => e.name === "set_page_favorite")).toMatchObject({
      method: "PUT",
      path: "/api/v1/graphs/{graph-id}/pages/{page-id}/favorite",
    });
    const listed = { favorites: [{ uuid: PAGE_UUID, title: "Projects", kind: "page" }] };
    syncHandler = (request) =>
      request.method === "GET" ? Response.json(listed) : Response.json({ result: "added", page: listed.favorites[0], ...listed });
    const result = await callTool("set_page_favorite", { graph: "work", "page-id": PAGE_UUID, body: { favorite: true } });
    expect(result.isError, result.text).toBe(false);
    expect(writeJson(result.text)).toMatchObject({ result: "added", favorites: listed.favorites });
    expect(syncRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", `/api/v1/graphs/${WORK_ID}/favorites`],
      ["PUT", `/api/v1/graphs/${WORK_ID}/pages/${PAGE_UUID}/favorite`],
    ]);
    // The generated schema fills dry-run's default.
    expect(JSON.parse(syncRequests[1].body)).toEqual({ favorite: true, "dry-run": false });
  });

  it("reorder_favorites is generated from reorderFavorites: a PUT of {page-ids, dry-run?} on the graph, annotated destructive and idempotent", async () => {
    const tools = await listTools();
    const reorder = tools.find((t) => t.name === "reorder_favorites");
    expect(reorder).toBeDefined();
    expect(reorder.inputSchema.required).toEqual(expect.arrayContaining(["graph", "body"]));
    expect(Object.keys(reorder.inputSchema.properties).sort()).toEqual(expect.not.arrayContaining(["page-id"]));
    expect(reorder.inputSchema.properties.body.required).toEqual(["page-ids"]);
    expect(Object.keys(reorder.inputSchema.properties.body.properties).sort()).toEqual(["dry-run", "page-ids"]);
    expect(reorder.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    for (const phrase of ["full list", "call listFavorites first", "order keys are unchanged", "never deleted", "not a favourite", "duplicate", "missing", "Unavailable for E2EE graphs"]) {
      expect(reorder.description, phrase).toContain(phrase);
    }
    expect(committedManifest.find((e) => e.name === "reorder_favorites")).toMatchObject({ method: "PUT", path: "/api/v1/graphs/{graph-id}/favorites" });
    const listed = { favorites: [{ uuid: PAGE_UUID, title: "Projects", kind: "page" }, { uuid: NOTES_PAGE, title: "Notes", kind: "page" }] };
    syncHandler = (request) => (request.method === "GET" ? Response.json(listed) : Response.json({ favorites: [...listed.favorites].reverse() }));
    const result = await callTool("reorder_favorites", { graph: "work", body: { "page-ids": [NOTES_PAGE, PAGE_UUID] } });
    expect(result.isError, result.text).toBe(false);
    expect(writeJson(result.text)).toMatchObject({ favorites: [...listed.favorites].reverse() });
    expect(syncRequests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", `/api/v1/graphs/${WORK_ID}/favorites`],
      ["PUT", `/api/v1/graphs/${WORK_ID}/favorites`],
    ]);
    // The generated schema fills dry-run's default; the list goes as given, in order.
    expect(JSON.parse(syncRequests[1].body)).toEqual({ "page-ids": [NOTES_PAGE, PAGE_UUID], "dry-run": false });
  });

  it("promote_page_to_tag sends extends in the body and dry-run in the query", async () => {
    syncHandler = () =>
      Response.json({ uuid: "p1", ident: "user.class/Recipe-x", title: "Recipe", extends: [], properties: [],
        promoted: { blocks: 3, references: 2 }, "dry-run": true });
    const result = await callTool("promote_page_to_tag", {
      graph: "work",
      "page-id": "p1",
      "dry-run": true,
      body: { extends: ["Food"] },
    });
    expect(result.isError).toBe(false);
    expect(writeJson(result.text)).toMatchObject({ promoted: { blocks: 3, references: 2 }, "dry-run": true });
    const url = new URL(syncRequests[0].url);
    expect(url.pathname).toBe(`/api/v1/graphs/${WORK_ID}/pages/p1/promote-to-tag`);
    expect(url.searchParams.get("dry-run")).toBe("true");
    expect(JSON.parse(syncRequests[0].body)).toEqual({ extends: ["Food"] });
  });

  it("promote_page_to_tag sends no body unless given one, and passes the server's refusal through", async () => {
    syncHandler = () =>
      Response.json({ error: 'page-id: "Notes" (p1) is namespaced under Library' }, { status: 400 });
    const refused = await callTool("promote_page_to_tag", { graph: "work", "page-id": "p1" });
    expect(refused).toEqual({ isError: true, text: 'page-id: "Notes" (p1) is namespaced under Library' });
    expect(writeRequests()).toHaveLength(1);
    expect(writeRequests()[0].method).toBe("POST");
    expect(new URL(writeRequests()[0].url).pathname).toBe(`/api/v1/graphs/${WORK_ID}/pages/p1/promote-to-tag`);
    expect(writeRequests()[0].body).toBe("");
  });

  it("create_tag and connector_help point at promote_page_to_tag when a page holds the title", async () => {
    const tools = await listTools();
    const create = tools.find((t) => t.name === "create_tag");
    expect(create.description).toContain(
      "If a page already has the title, the 409 names it; promote_page_to_tag converts that page.",
    );
    const help = (await callTool("connector_help", {})).text;
    expect(help).toContain(
      "when create_tag is refused because a page has the title, promote_page_to_tag converts that page, keeping its blocks and references",
    );
    expect(help).toContain("Setting a page's tags to Tag is refused");
    expect(help).toContain("The other built-in type tags (Journal, Whiteboard, PDF Annotation, Property, Asset) are set by Logseq itself");
    expect(help).toContain("as is Journal on a journal that a batch insert creates by its date or journal title");
    expect(help).toContain(
      "A tags list replaces only user tags: Page, Tag, Journal and the other built-in type tags an entity holds are kept",
    );
  });

  it("connector_help says the edit-stamp properties are set by the server and refused by the property tools", async () => {
    const help = (await callTool("connector_help", {})).text;
    expect(help).toContain(
      "editedBy and claudeEditedAt are set by the server; set_block_property, batch_set_block_property, delete_block_property and batch_delete_block_property refuse them, naming the entry",
    );
  });

  it("connector_help returns the usage conventions", async () => {
    const result = await callTool("connector_help", {});
    expect(result.isError).toBe(false);
    for (const phrase of [
      "list_graphs",
      "insert_block_tree",
      "[[Page]]",
      "create_task",
      "capture_to_today",
      "Card",
      "without searching first",
      "acknowledge-",
      "batch_insert_block_trees",
      "get_blocks",
      "delete_blocks",
      "batch_move_blocks",
      "verbose",
      "dry-run",
      "owner's time zone",
      "page-title",
      "capture_to_today always writes to today",
      "insert_block_tree with that journal's date (YYYY-MM-DD) or UUID as target-id",
      "journal date",
      "every page-id (refresh_refs' included), every target-id and create_task's page-id",
      "refused with an error naming each one's title and UUID",
      "fails with an error naming the UUID of any block still there afterwards",
      "a dry run whose context can't be read fails instead",
      "the summary starts Cleared today's journal",
      "never creates a page",
      "Titles and dates are refused on E2EE graphs",
      "dry-run any delete you name by title",
      "create_task with page-id",
      "delete_page on today's journal",
      "restricted to classes",
      "properties.add",
      "choices.add",
      "choices.retire",
      "convert_values",
      "choices and convert_values are refused on E2EE graphs",
      "are marked destructive, so claude.ai asks before running them",
      "Give every write and delete a reason",
      "at most 200 characters",
      "never sent to or stored on the graph",
      "target-label",
      "Page > parent > ... > block",
      "checked against the real target, never used to find it",
      "a mismatch writes nothing",
      "labels, parallel to block-ids",
    ]) {
      expect(result.text).toContain(phrase);
    }
    // capture_to_today takes no page, so the help must not tell Claude to pass one.
    expect(result.text).not.toContain("pass that journal page");
  });
});

describe("tools manifest", () => {
  it("manifest check passes on committed manifest and fails after adding a fake operation", () => {
    expect(checkManifest(committedManifest, spec)).toEqual([]);

    const [first, ...rest] = committedManifest;
    expect(checkManifest(rest, spec)).toEqual([
      "+ batch_delete_block_property POST /api/v1/graphs/{graph-id}/block-properties/batch-delete [destructive idempotent]",
    ]);
    expect(first.name).toBe("batch_delete_block_property");
    // An operation with no annotations entry stops the manifest from being built at all.
    expect(() => buildManifest(specWithFakeOperation())).toThrow("no annotations for tool fake_operation");
  });

  it("manifest records annotations (checkManifest flags a differing destructiveHint)", () => {
    for (const entry of committedManifest as { name: string; annotations?: unknown }[]) {
      expect(entry.annotations, `${entry.name} records annotations`).toBeDefined();
      expect(entry.annotations, entry.name).toEqual(ANNOTATIONS[entry.name]);
    }
    const flipped = structuredClone(committedManifest) as { name: string; annotations: Record<string, boolean> }[];
    flipped.find((e) => e.name === "update_block")!.annotations.destructiveHint = false;
    expect(checkManifest(flipped, spec)).toEqual([
      "+ update_block PATCH /api/v1/graphs/{graph-id}/blocks/{block-id} [destructive]",
      "- update_block PATCH /api/v1/graphs/{graph-id}/blocks/{block-id} [no hints]",
    ]);
    // A committed manifest from before annotations were recorded is stale.
    const bare = committedManifest.map(({ name, method, path }) => ({ name, method, path }));
    expect(checkManifest(bare, spec)).toContain("- update_block PATCH /api/v1/graphs/{graph-id}/blocks/{block-id} [annotations missing]");
  });

  it("refuses operations it does not understand", () => {
    const noGraph = structuredClone(spec);
    noGraph.paths["/api/v1/other"] = { get: { operationId: "otherThing", summary: "x" } };
    expect(() => buildManifest(noGraph)).toThrow(/otherThing/);
  });
});

describe("large write results", () => {
  const MOVES = { graph: "work", body: { moves: [{ "block-ids": ["b1"], "target-id": "b2", position: "after" }] } };

  /** A batch_move_blocks answer naming `n` moved blocks, each on a page titled `title` under `crumbs`. */
  function movedBody(n: number, title: string, crumbs: string[]) {
    const page = { uuid: PAGE_UUID, title };
    return {
      moved: n,
      affected: Array.from({ length: n }, (_, i) => ({
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        kind: "block",
        snippet: `Block ${i} `.padEnd(80, "s"),
        from: { page, breadcrumb: crumbs },
        to: { page, breadcrumb: crumbs },
      })),
    };
  }

  const total = (content: { text: string }[]) => content.reduce((n, c) => n + c.text.length, 0);

  it("a 100-block batch_move_blocks keeps its JSON whole and lists only the first 20 blocks in the summary", async () => {
    const cases: [string, string[]][] = [
      ["t".repeat(40), ["c".repeat(40), "d".repeat(40)]],
      ["t".repeat(40), Array.from({ length: 5 }, (_, i) => `${i}`.repeat(80))],
      ["t".repeat(300), ["c".repeat(60), "d".repeat(60)]],
    ];
    for (const [title, crumbs] of cases) {
      const body = movedBody(100, title, crumbs);
      syncHandler = () => Response.json(body);
      const { isError, content } = await callContent("batch_move_blocks", MOVES);
      const label = `${title.length}-char title, ${crumbs.length} crumbs`;
      expect(isError, label).toBe(false);
      expect(content, label).toHaveLength(2);
      expect(JSON.parse(content[1].text), label).toEqual(body);
      const lines = content[0].text.split("\n");
      expect(lines[0], label).toBe("Moved 100 blocks:");
      expect(lines.filter((l) => l.startsWith('- "')), label).toHaveLength(20);
      expect(lines, label).toContain("- … and 80 more, listed in the JSON result");
      expect(content[0].text, label).not.toContain("t".repeat(81));
      expect(total(content), label).toBeLessThan(RESULT_CHAR_LIMIT);
      expect(content.map((c) => c.text).join(""), label).not.toContain("[truncated");
    }
  });

  it("a write result still over the cap keeps its summary and says the write was applied, not to request less", async () => {
    const body = movedBody(100, "t".repeat(3000), ["c"]);
    syncHandler = () => Response.json(body);
    const { isError, content } = await callContent("batch_move_blocks", MOVES);
    expect(isError).toBe(false);
    expect(total(content)).toBe(RESULT_CHAR_LIMIT);
    expect(content[0].text.split("\n")[0]).toBe("Moved 100 blocks:");
    expect(content[0].text).toContain("- … and 80 more, listed in the JSON result");
    expect(content[1].text).toMatch(/\[truncated: the write was applied; its result had \d+ characters and the limit is 150000, so the JSON is cut\. Read the pages it names to see the outcome\.\]$/);
    expect(content[1].text).not.toContain("request less");
  });
});

// ---------------------------------------------------------------------------------------------
// Audit log (design 2026-11-07-connector-write-audit-log §3.3, §3.8; plan stage 2)
// ---------------------------------------------------------------------------------------------

const B1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B2 = "aaaaaaaa-0000-4000-8000-000000000002";
const P1 = "pppppppp-0000-4000-8000-000000000001";
const NOTES_PAGE = "66666666-6666-4666-8666-666666666666";

/**
 * One valid call per generated non-read tool. The keys must be exactly the manifest's generated
 * non-read tools, so a new write tool fails "one row per write call" until it is listed here.
 */
const AUDIT_CALLS: Record<string, Record<string, unknown>> = {
  create_page: { body: { title: "Standup" } },
  delete_page: { "page-id": PAGE_UUID },
  update_page: { "page-id": PAGE_UUID, body: { title: "Notes" } },
  promote_page_to_tag: { "page-id": PAGE_UUID },
  delete_blocks: { body: { "block-ids": [B1, B2] } },
  refresh_refs: { body: { "page-id": PAGE_UUID, apply: true } },
  update_block: { "block-id": B1, body: { title: "New title" } },
  delete_block: { "block-id": B1 },
  move_blocks: { body: { "block-ids": [B1], "target-id": B2, position: "after" } },
  batch_move_blocks: { body: { moves: [{ "block-ids": [B1], "target-id": B2, position: "after" }] } },
  insert_block_children: { "block-id": B1, body: { position: "append", blocks: [{ title: "Child" }] } },
  insert_block_tree: { body: { "target-id": B1, blocks: [{ title: "Child" }] } },
  batch_insert_block_trees: { body: { entries: [{ page: "Meeting", blocks: [{ title: "Agenda" }] }] } },
  set_block_property: { "block-id": B1, "property-id": P1, body: { value: 1 } },
  delete_block_property: { "block-id": B1, "property-id": P1 },
  batch_set_block_property: { body: { entries: [{ "block-id": B1, "property-id": P1, value: 1 }] } },
  batch_delete_block_property: { body: { entries: [{ "block-id": B2, "property-id": P1 }] } },
  capture_to_today: { body: { blocks: [{ title: "Note" }] } },
  create_task: { body: { title: "Call Sam" } },
  create_tag: { body: { title: "Meeting" } },
  update_tag: { "tag-id": "Meeting", body: {} },
  delete_tag: { "tag-id": "Meeting" },
  create_property: { body: { title: "Venue" } },
  update_property: { "property-id": "Venue", body: {} },
  delete_property: { "property-id": "Venue" },
  set_page_favorite: { "page-id": PAGE_UUID, body: { favorite: true } },
  reorder_favorites: { body: { "page-ids": [PAGE_UUID, NOTES_PAGE] } },
};

/** The selectors each call above names, as `addressed` stores them. */
const AUDIT_ADDRESSED: Record<string, string[]> = {
  create_page: [],
  delete_page: [PAGE_UUID],
  update_page: [PAGE_UUID],
  promote_page_to_tag: [PAGE_UUID],
  delete_blocks: [B1, B2],
  refresh_refs: [PAGE_UUID],
  update_block: [B1],
  delete_block: [B1],
  move_blocks: [B1, B2],
  batch_move_blocks: [B1, B2],
  insert_block_children: [B1],
  insert_block_tree: [B1],
  batch_insert_block_trees: ["Meeting"],
  set_block_property: [B1, P1],
  delete_block_property: [B1, P1],
  batch_set_block_property: [B1, P1],
  batch_delete_block_property: [B2, P1],
  capture_to_today: [],
  create_task: [],
  create_tag: [],
  update_tag: ["Meeting"],
  delete_tag: ["Meeting"],
  create_property: [],
  update_property: ["Venue"],
  delete_property: ["Venue"],
  set_page_favorite: [PAGE_UUID],
  // page-ids is not one of the audit log's address keys, so the entries aren't recorded as addressed.
  reorder_favorites: [],
};

/** Where each tool with a dry run takes its flag. */
const DRY_RUN_IN: Record<string, "query" | "body"> = {
  delete_page: "query",
  promote_page_to_tag: "query",
  move_blocks: "query",
  delete_tag: "query",
  update_property: "query",
  delete_property: "query",
  delete_blocks: "body",
  batch_move_blocks: "body",
  batch_insert_block_trees: "body",
  set_page_favorite: "body",
  reorder_favorites: "body",
};

/** A response naming one target and one affected block, as patch 0028's BlockContext does. */
const CONTEXT_RESPONSE = {
  target: { uuid: B2, kind: "block", page: { uuid: NOTES_PAGE, title: "Notes" }, breadcrumb: ["Meeting"], snippet: "Agenda" },
  affected: [
    {
      uuid: B1,
      kind: "block",
      page: { uuid: PAGE_UUID, title: "Nov 5th, 2026" },
      breadcrumb: [],
      snippet: "Call Sam",
      from: { page: { uuid: PAGE_UUID, title: "Nov 5th, 2026" }, breadcrumb: [] },
      to: { page: { uuid: NOTES_PAGE, title: "Notes" }, breadcrumb: ["Meeting"] },
    },
  ],
};

interface AuditDbRow {
  id: number;
  at: number;
  graph_id: string | null;
  alias: string;
  tool: string;
  kind: string;
  status: string;
  dry_run: number;
  reason: string | null;
  client: string | null;
  session: string | null;
  addressed: string | null;
  pages: string | null;
  targets: string | null;
  before: string | null;
  error: string | null;
  rows_written: number | null;
  rows_read: number | null;
}

async function auditRows(afterId = 0): Promise<AuditDbRow[]> {
  return (await env.DB.prepare("SELECT * FROM audit_log WHERE id > ? ORDER BY id").bind(afterId).all<AuditDbRow>()).results;
}

async function lastAuditId(): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").first<{ id: number }>();
  return row?.id ?? 0;
}

/** Calls once and answers the single audit row the call left (fails unless exactly one). */
async function callAudited(name: string, args: Record<string, unknown>, handler: Handler = connector()) {
  const before = await lastAuditId();
  const result = await callContent(name, args, handler);
  const rows = await auditRows(before);
  expect(rows, `${name}: rows for one call`).toHaveLength(1);
  return { result, row: rows[0] };
}

/** env.DB, with statements whose SQL matches `fails` rejecting with `message`. */
function dbFailing(fails: RegExp, message: string): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (!fails.test(sql)) return target.prepare(sql);
          const failing = {
            bind: () => failing,
            run: () => Promise.reject(new Error(message)),
            all: () => Promise.reject(new Error(message)),
            first: () => Promise.reject(new Error(message)),
          };
          return failing;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Restores migration 0004 after a test dropped audit_log. */
async function restoreAuditLog(): Promise<void> {
  await env.DB.exec("DROP TABLE IF EXISTS audit_log");
  const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  for (const query of migrations.find((m) => m.name.startsWith("0004_"))!.queries) await env.DB.prepare(query).run();
}

const GENERATED_WRITES = committedManifest.filter((e) => e.method !== null && !e.annotations.readOnlyHint).map((e) => e.name);
const ALL_WRITES = committedManifest.filter((e) => !e.annotations.readOnlyHint).map((e) => e.name);

describe("audit log", () => {
  it("lists a call for every generated write tool", () => {
    expect(Object.keys(AUDIT_CALLS).sort()).toEqual([...GENERATED_WRITES].sort());
  });

  // One test per tool: the loop as a single test took about 4 s locally and timed out on CI's 5 s default.
  it.each(GENERATED_WRITES)("one row per write call (%s): success, sync 409, refused reason, unknown alias, read-only graph and dry run", async (name) => {
    const args: Record<string, unknown> = { graph: "work", ...AUDIT_CALLS[name] };

    // Success: the row is ok, with the reason, the addressed selectors and describeWrite's targets.
    syncRequests = [];
    syncHandler = preReadsEmpty(() => Response.json(CONTEXT_RESPONSE));
    const ok = await callAudited(name, { ...args, reason: REASON });
    expect(ok.result.isError, name).toBe(false);
    expect(writeRequests(), name).toHaveLength(1);
    expect(ok.row, name).toMatchObject({
      graph_id: WORK_ID,
      alias: "work",
      tool: name,
      kind: "write",
      status: "ok",
      dry_run: 0,
      reason: REASON,
      error: null,
      rows_written: 3,
      rows_read: 1,
    });
    expect(JSON.parse(ok.row.addressed!), name).toEqual(AUDIT_ADDRESSED[name]);
    expect(JSON.parse(ok.row.targets!), name).toEqual(toAffectedTargets(CONTEXT_RESPONSE));
    // The targets' pages, and a page the call names by title (batch_insert_block_trees' page: Meeting).
    const named = name === "batch_insert_block_trees" ? ["meeting"] : [];
    expect(ok.row.pages!.split("\n").sort(), name).toEqual(["notes", "nov 5th, 2026", NOTES_PAGE, PAGE_UUID, ...named].sort());

    // Sync 409: an error row carrying the server's message, not ok and not two rows.
    syncRequests = [];
    syncHandler = preReadsEmpty(() => Response.json({ error: "entry 0: block not found" }, { status: 409 }));
    const conflict = await callAudited(name, args);
    expect(conflict.result.isError, name).toBe(true);
    expect(conflict.row, name).toMatchObject({ status: "error", error: "entry 0: block not found", reason: null, graph_id: WORK_ID });
    // Only what the call and its snapshot named (activity-log.test.ts covers finding it by page):
    // the page a page read returned, never a target the response would have named.
    for (const page of conflict.row.pages?.split("\n") ?? []) expect(ok.row.pages!.split("\n"), name).toContain(page);
    const known = conflict.row.targets === null ? [] : JSON.parse(conflict.row.targets);
    expect(known.map((t: { uuid: string; kind: string }) => [t.uuid, t.kind]), name).toEqual(known.length === 0 ? [] : [[PAGE_UUID, "page"]]);

    // Refusals before the handler: nothing reaches the sync server.
    syncRequests = [];
    syncHandler = () => Response.json(CONTEXT_RESPONSE);
    const long = await callAudited(name, { ...args, reason: "x".repeat(201) });
    expect(long.row, name).toMatchObject({
      status: "refused",
      error: "reason is 201 characters; at most 200 are accepted — shorten it",
      reason: null,
      graph_id: WORK_ID,
      dry_run: 0,
    });
    const unknown = await callAudited(name, { ...args, graph: "nope", reason: REASON });
    expect(unknown.row, name).toMatchObject({
      status: "refused",
      error: "unknown graph 'nope' — call list_graphs for the connected aliases",
      alias: "nope",
      graph_id: null,
      reason: REASON,
    });
    const readOnly = await callAudited(name, { ...args, graph: "notes" });
    expect(readOnly.row, name).toMatchObject({
      status: "refused",
      error: "graph 'notes' is read-only",
      alias: "notes",
      graph_id: NOTES_ID,
    });
    expect(syncRequests, name).toHaveLength(0);

    // Dry run, where the tool has one: dry_run = 1, targets from the dry-run response.
    const where = DRY_RUN_IN[name];
    if (where !== undefined) {
      const dry = { ...CONTEXT_RESPONSE, "dry-run": true };
      // A delete's dry run reads first, as its real call does, so the read is answered too.
      syncHandler = preReadsEmpty(() => Response.json(dry));
      const dryArgs =
        where === "query" ? { ...args, "dry-run": true } : { ...args, body: { ...(args.body as object), "dry-run": true } };
      const preview = await callAudited(name, dryArgs);
      expect(preview.row, name).toMatchObject({ status: "ok", dry_run: 1 });
      expect(JSON.parse(preview.row.targets!), name).toEqual(toAffectedTargets(dry));
      // dry-run: false is a real call.
      const real =
        where === "query" ? { ...args, "dry-run": false } : { ...args, body: { ...(args.body as object), "dry-run": false } };
      expect((await callAudited(name, real)).row.dry_run, name).toBe(0);
    }
  });

  it("a ToolError the handler throws before the request (a '.' path argument) is refused", async () => {
    const { result, row } = await callAudited("delete_block", { graph: "work", "block-id": ".." });
    expect(result.isError).toBe(true);
    expect(row).toMatchObject({ status: "refused", error: "path arguments may not be '.' or '..'" });
    expect(syncRequests).toHaveLength(0);
  });

  it("every write is audited: each non-read tool on a server built as mcpHandler builds it calls begin once", async () => {
    acceptEverything();
    const begin = vi.spyOn(AuditLog.prototype, "begin");
    try {
      const calls: [string, Record<string, unknown>][] = [
        ...GENERATED_WRITES.map((name) => [name, { graph: "work", ...AUDIT_CALLS[name] }] as [string, Record<string, unknown>]),
        ["save_document", { graph: "work", fileName: "a.md", text: "a" }],
        // Refused before any fetch, so no public fetch is needed; the call is still logged.
        ["save_file_from_url", { graph: "work", url: "https://example.com/a.txt", reason: "x".repeat(201) }],
      ];
      expect(calls.map(([name]) => name).sort()).toEqual([...ALL_WRITES].sort());
      for (const [name, args] of calls) await callContent(name, args, connector(semanticOnEnv()));
      // Reads never begin a row.
      await callContent("get_page", { graph: "work", "page-id": PAGE_UUID }, connector(semanticOnEnv()));
      await callContent("list_graphs", {}, connector(semanticOnEnv()));
      expect(begin.mock.calls.map(([entry]) => entry.tool).sort()).toEqual([...ALL_WRITES].sort());
    } finally {
      begin.mockRestore();
    }
  });

  it("INSERT fails: the write is refused, naming the reason, and nothing reaches the sync server", async () => {
    acceptEverything();
    const e = testEnv({ DB: dbFailing(/^\s*INSERT INTO audit_log/, "D1_ERROR: database is locked") });
    const before = await lastAuditId();
    for (const [name, args] of [
      ["update_block", { graph: "work", "block-id": B1, body: { title: "New title" }, reason: REASON }],
      ["delete_blocks", { graph: "work", body: { "block-ids": [B1] } }],
      ["save_document", { graph: "work", fileName: "a.md", text: "a" }],
      // A refusal can't be logged either; it says so rather than hiding the failure.
      ["delete_block", { graph: "notes", "block-id": B1 }],
    ] as const) {
      const result = await callContent(name, args, connector(e));
      expect(result, name).toEqual({
        isError: true,
        content: [{ type: "text", text: "audit log unavailable: D1_ERROR: database is locked; nothing was written" }],
      });
    }
    // Nothing is written. The before-snapshot (design §3.3 step 3) is read ahead of the INSERT that
    // stores it, so update_block's and delete_blocks' reads went out; nothing else did.
    expect(writeRequests()).toHaveLength(0);
    expect(syncRequests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(await auditRows(before)).toEqual([]);
  });

  it("UPDATE fails: the write stands, the row stays pending, and the result leads with the line", async () => {
    const e = testEnv({ DB: dbFailing(/^\s*UPDATE audit_log/, "D1_ERROR: network connection lost") });
    // The before-read names the block's page (upper-cased, as a server might): the pending row is
    // found by it, as begin stored it, since finish never ran.
    syncHandler = (request) =>
      request.method === "GET"
        ? Response.json({ blocks: [{ uuid: B1, kind: "block", title: "Agenda", "page-id": PAGE_UUID.toUpperCase() }], missing: [] })
        : Response.json(CONTEXT_RESPONSE);
    const before = await lastAuditId();
    const result = await callContent("update_block", { graph: "work", "block-id": B1, body: { title: "New title" }, reason: REASON }, connector(e));
    const rows = await auditRows(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", tool: "update_block", reason: REASON, targets: null, pages: PAGE_UUID });
    const byPage = await callContent("get_activity_log", { graph: "work", page: PAGE_UUID }, connector(e));
    expect(byPage.isError, byPage.content[0].text).toBe(false);
    expect(JSON.parse(byPage.content[1].text).entries.map((x: { id: number; status: string }) => [x.id, x.status])).toContainEqual([rows[0].id, "pending"]);
    expect(syncRequests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(result.isError).toBe(false);
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe(`Audit log entry ${rows[0].id} could not be completed: D1_ERROR: network connection lost`);
    expect(lines.at(-1)).toBe(`Logged as audit entry ${rows[0].id}`);
    expect(JSON.parse(result.content[1].text)).toEqual(CONTEXT_RESPONSE);

    // A refused or failed write whose row can't be finished says so ahead of its own error.
    syncHandler = () => Response.json({ error: "entry 0: block not found" }, { status: 409 });
    const failed = await callContent("update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, connector(e));
    const pending = (await auditRows(rows[0].id)).filter((r) => r.kind === "write")[0];
    expect(pending.status).toBe("pending");
    expect(failed).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `Audit log entry ${pending.id} could not be completed: D1_ERROR: network connection lost\nentry 0: block not found`,
        },
      ],
    });
  });

  it("migration missing: writes refused with the migration message, reads still work, probe cached only on success", async () => {
    acceptEverything();
    const probe = vi.spyOn(AuditLog.prototype, "probe");
    // One env is one isolate.
    const e = testEnv();
    try {
      await env.DB.exec("DROP TABLE audit_log");
      for (const [name, args] of [
        ["update_block", { graph: "work", "block-id": B1, body: { title: "x" } }],
        ["delete_block", { graph: "notes", "block-id": B1 }],
        ["save_document", { graph: "work", fileName: "a.md", text: "a" }],
      ] as const) {
        expect(await callContent(name, args, connector(e)), name).toEqual({
          isError: true,
          content: [{ type: "text", text: "audit log unavailable: migration 0004 has not been applied; nothing was written" }],
        });
      }
      expect(syncRequests).toHaveLength(0);
      // A missing table is probed again on each write, not cached.
      expect(probe).toHaveBeenCalledTimes(3);
      const read = await callContent("get_page", { graph: "work", "page-id": PAGE_UUID }, connector(e));
      expect(read.isError).toBe(false);
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      await restoreAuditLog();
    }
    // Once the migration is applied, the same isolate writes, and probes once for any number of writes.
    probe.mockClear();
    syncRequests = [];
    for (let i = 0; i < 3; i++) {
      const ok = await callContent("update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, connector(e));
      expect(ok.isError).toBe(false);
    }
    expect(writeRequests()).toHaveLength(3);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockRestore();
  });

  it("a probe that fails for another reason refuses the write with that reason", async () => {
    acceptEverything();
    const e = testEnv({ DB: dbFailing(/^SELECT 1 FROM audit_log/, "D1_ERROR: network connection lost") });
    const result = await callContent("update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, connector(e));
    expect(result.content[0].text).toBe("audit log unavailable: D1_ERROR: network connection lost; nothing was written");
    expect(syncRequests).toHaveLength(0);
  });

  it("result names the entry: the summary item ends with 'Logged as audit entry <id>' and the id reads back", async () => {
    // A write whose summary is otherwise empty (no context, no reason) gets the line on its own.
    syncHandler = () => Response.json({ id: "p1", title: "Standup" }, { status: 201 });
    const created = await callContent("create_page", { graph: "work", body: { title: "Standup" } });
    expect(created.isError).toBe(false);
    const id = Number(/^Logged as audit entry (\d+)$/.exec(created.content[0].text)?.[1]);
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(JSON.parse(created.content[1].text)).toEqual({ id: "p1", title: "Standup" });
    const row = await new AuditLog(env.DB).get(WORK_ID, id);
    expect(row).toMatchObject({ id, tool: "create_page", status: "ok", alias: "work" });

    // A write with a summary ends it with the line.
    syncHandler = () => Response.json(CONTEXT_RESPONSE);
    const moved = await callContent("move_blocks", { graph: "work", ...AUDIT_CALLS.move_blocks, reason: REASON });
    const text = moved.content[0].text;
    expect(text.startsWith("Moved 1 block:\n")).toBe(true);
    const next = Number(/\nReason: tidy duplicate notes\nLogged as audit entry (\d+)$/.exec(text)?.[1]);
    expect(next).toBe(id + 1);
    expect(await new AuditLog(env.DB).get(WORK_ID, next)).toMatchObject({ tool: "move_blocks", reason: REASON });

    // connector_help tells Claude so.
    const help = (await callContent("connector_help", {})).content[0].text;
    expect(help).toContain("Every write is logged with its reason");
    expect(help).toContain("Logged as audit entry <id>");
    expect(help).toContain("audit log unavailable: …; nothing was written");
  });

  it("one graph lookup per write: the handler reuses the graph audited() resolved", async () => {
    acceptEverything();
    let lookups = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/FROM graphs WHERE alias = \?/.test(sql)) lookups += 1;
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const e = testEnv({ DB: counting });
    await callContent("update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, connector(e));
    expect(lookups).toBe(1);
    lookups = 0;
    await callContent("save_document", { graph: "work", fileName: "a.md", text: "a" }, connector(e));
    expect(lookups).toBe(1);
  });

  it("no secrets: the PAT, the Authorization header, GRAPH_TOKEN_KEY and sent block text appear in no column", async () => {
    const BLOCK_TEXT = "CANARY-BLOCK-TEXT-7f3a";
    const BEARER = "CANARY-OAUTH-TOKEN-91c2";
    const before = await lastAuditId();
    const headers = { Authorization: `Bearer ${BEARER}`, "User-Agent": "claude-code/2.0.0", "mcp-session-id": "s-1" };
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(connector(), "tools/call", { name, arguments: args }, testEnv(), headers);
    syncHandler = () => Response.json(CONTEXT_RESPONSE);
    await call("update_block", { graph: "work", "block-id": B1, body: { title: BLOCK_TEXT }, reason: REASON });
    await call("insert_block_tree", { graph: "work", body: { "target-id": B1, blocks: [{ title: BLOCK_TEXT }] } });
    await call("update_block", { graph: "work", "block-id": B1, body: { title: BLOCK_TEXT }, reason: "x".repeat(201) });
    await call("update_block", { graph: "notes", "block-id": B1, body: { title: BLOCK_TEXT } });
    await call("save_document", { graph: "work", fileName: "a.md", text: BLOCK_TEXT });
    syncHandler = () => Response.json({ error: "entry 0: block not found" }, { status: 409 });
    await call("update_block", { graph: "work", "block-id": B1, body: { title: BLOCK_TEXT } });
    const rows = await auditRows(before);
    expect(rows).toHaveLength(6);
    const stored = JSON.stringify(rows);
    for (const secret of [WORK_TOKEN, NOTES_TOKEN, BEARER, env.GRAPH_TOKEN_KEY, BLOCK_TEXT]) {
      expect(stored, secret).not.toContain(secret);
    }
  });

  it("client and session: User-Agent families and mcp-session-id stored, or null", async () => {
    acceptEverything();
    const owner = (e: Env): Handler => (request, _env, ctx) => {
      (ctx as unknown as { props: unknown }).props = { githubUserId: 1001, login: "owner" };
      return mcpApiHandler.fetch(request, e, ctx);
    };
    const cases: [Record<string, string>, string, string | null][] = [
      [{ "User-Agent": "Claude-User (claude.ai)", "mcp-session-id": "s-ai" }, "claude-ai", "s-ai"],
      [{ "User-Agent": "claude-code/2.0.31 (cli)" }, "claude-code", null],
      [{ "User-Agent": "curl/8.5.0", "mcp-session-id": "s-curl" }, "other", "s-curl"],
      [{}, "other", null],
    ];
    for (const [headers, client, session] of cases) {
      const before = await lastAuditId();
      const e = testEnv();
      await rpc(owner(e), "tools/call", { name: "create_page", arguments: { graph: "work", body: { title: "x" } } }, e, headers);
      const [row] = await auditRows(before);
      expect({ client: row.client, session: row.session }, JSON.stringify(headers)).toEqual({ client, session });
    }
    // Called without a request's caller (as tests and scripts do), both are null.
    const [row] = await (async () => {
      const before = await lastAuditId();
      await callContent("create_page", { graph: "work", body: { title: "x" } });
      return auditRows(before);
    })();
    expect({ client: row.client, session: row.session }).toEqual({ client: null, session: null });
  });

  it("pages: each target's page title and UUID, lower-cased, for every kind of target the server names", async () => {
    const fixture = async (name: string) => (await import(`./fixtures/readable/${name}.json`)).default.response;
    const J5 = "00000001-2026-1105-0000-000000000000";
    const J6 = "00000001-2026-1106-0000-000000000000";
    const cases: [string, unknown, string[] | null][] = [
      // A move names only where each block was and is now; both pages count.
      ["move_blocks", await fixture("move-blocks"), ["nov 5th, 2026", J5]],
      ["batch_move_blocks", { affected: [{ uuid: B1, kind: "block", snippet: "x", from: { page: { uuid: J5, title: "Nov 5th, 2026" }, breadcrumb: [] }, to: { page: { uuid: NOTES_PAGE, title: "Notes" }, breadcrumb: [] } }] }, ["nov 5th, 2026", J5, "notes", NOTES_PAGE]],
      // A page or journal target names itself as its page; the call's page-id and the page its snapshot read count too.
      ["delete_page", await fixture("delete-page-today"), ["nov 6th, 2026", J6, PAGE_UUID, "notes"]],
      // E2EE: the page's UUID only, its title is encrypted.
      ["delete_blocks", await fixture("delete-blocks-e2ee"), [J5]],
      // Batch entries: each entry's target and affected blocks, and the page the call names by title.
      ["batch_insert_block_trees", await fixture("batch-insert-block-trees"), ["nov 5th, 2026", J5, "ideas", "5d0f4c7a-2222-4b4e-8c1e-000000000003", "meeting"]],
      // A response with no context names no page.
      ["create_page", { id: "p1", title: "Standup" }, null],
    ];
    for (const [name, response, pages] of cases) {
      syncHandler = preReadsEmpty(() => Response.json(response));
      const { row } = await callAudited(name, { graph: "work", ...AUDIT_CALLS[name] });
      expect(row.status, name).toBe("ok");
      expect(JSON.parse(row.targets!), name).toEqual(toAffectedTargets(response));
      expect(row.pages === null ? null : row.pages.split("\n").sort(), name).toEqual(pages === null ? null : [...pages].sort());
    }
  });

  it("status: refusals are refused; sync errors of every status, and unexpected failures, are error", async () => {
    const cases: [() => Response, string, string][] = [
      [() => Response.json({ error: "title: required" }, { status: 400 }), "error", "title: required"],
      [() => Response.json({ error: "no" }, { status: 401 }), "error", "token for graph 'work' expired or lacks permission — reconnect it at https://mcp.example.com/graphs"],
      [() => Response.json({ error: "slow" }, { status: 429, headers: { "Retry-After": "5" } }), "error", "rate limited — retry after 5 s"],
      [() => Response.json({ error: "boom" }, { status: 500 }), "error", "sync server error (HTTP 500): boom"],
    ];
    for (const [handler, status, error] of cases) {
      syncHandler = handler;
      const { result, row } = await callAudited("update_block", { graph: "work", ...AUDIT_CALLS.update_block });
      expect(result.isError, error).toBe(true);
      expect(row, error).toMatchObject({ status, error });
    }
    // A failure that is not a ToolError (here, a body that isn't JSON) still finishes its row.
    syncHandler = () => new Response("not json", { status: 200 });
    const before = await lastAuditId();
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_block", arguments: { graph: "work", ...AUDIT_CALLS.update_block } } }),
    });
    const ctx = createExecutionContext();
    const e = testEnv();
    await (await mcpHandler(e, ctx)(request, e, ctx)).text();
    await waitOnExecutionContext(ctx);
    const rows = await auditRows(before);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toMatch(/JSON/);
  });

  it("addressed keeps the call's order, for chained, swapped and reversed entries, and only names selectors", async () => {
    acceptEverything();
    const B3 = "aaaaaaaa-0000-4000-8000-000000000003";
    const move = (pairs: [string, string][]) => ({
      graph: "work",
      body: { moves: pairs.map(([from, to]) => ({ "block-ids": [from], "target-id": to, position: "after" })) },
    });
    const cases: [Record<string, unknown>, string[]][] = [
      // A chain, the same chain reversed, and a swap.
      [move([[B1, B2], [B2, B3]]), [B1, B2, B3]],
      [move([[B2, B3], [B1, B2]]), [B2, B3, B1]],
      [move([[B1, B2], [B2, B1]]), [B1, B2]],
    ];
    for (const [args, addressed] of cases) {
      const { row } = await callAudited("batch_move_blocks", args);
      expect(row.status).toBe("ok");
      expect(JSON.parse(row.addressed!)).toEqual(addressed);
    }
    // Each selector kind: a UUID, a title, a journal date and an ident; values and block text never.
    const entries = [
      { "block-id": B1, "property-id": "user.property/venue-x1", value: "Town Hall" },
      { "block-id": "2026-11-05", "property-id": "Venue", value: 3 },
    ];
    for (const list of [entries, [...entries].reverse()]) {
      const { row } = await callAudited("batch_set_block_property", { graph: "work", body: { entries: list } });
      const want = list.flatMap((e) => [e["block-id"], e["property-id"]]);
      expect(JSON.parse(row.addressed!)).toEqual(want);
      expect(row.addressed).not.toContain("Town Hall");
    }
  });

  it("a healthy log refuses nothing that worked before: re-sends, no-ops, replace-style writes, large batches and long reasons", async () => {
    acceptEverything();
    const hundred = Array.from({ length: 100 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const calls: [string, Record<string, unknown>][] = [
      // The same write sent twice, and an update that changes nothing.
      ["update_block", { graph: "work", "block-id": B1, body: { title: "Same" } }],
      ["update_block", { graph: "work", "block-id": B1, body: { title: "Same" } }],
      // Replace-style: a reset of existing values, and properties.set.
      ["batch_set_block_property", { graph: "work", body: { entries: [{ "block-id": B1, "property-id": P1, value: ["Food"] }], isResetExistingValues: true } }],
      ["update_tag", { graph: "work", "tag-id": "Meeting", body: { properties: { set: [] } } }],
      // The largest batch, and the longest reason (emoji count as one character each).
      ["delete_blocks", { graph: "work", body: { "block-ids": hundred }, reason: "🙂".repeat(200) }],
      ["delete_blocks", { graph: "work", body: { "block-ids": hundred, "dry-run": true } }],
      ["save_document", { graph: "work", fileName: "a.md", text: "a".repeat(1000) }],
    ];
    for (const [name, args] of calls) {
      syncRequests = [];
      const { result, row } = await callAudited(name, args);
      expect(result.isError, name).toBe(false);
      expect(writeRequests(), name).toHaveLength(1);
      expect(row.status, name).toBe("ok");
    }
  });

  it("userAgentFamily maps claude.ai, Claude Code and anything else", () => {
    expect(userAgentFamily("Claude-User (claude.ai)")).toBe("claude-ai");
    expect(userAgentFamily("claude-ai/1.0")).toBe("claude-ai");
    expect(userAgentFamily("Anthropic/1.0")).toBe("claude-ai");
    expect(userAgentFamily("claude-code/2.0.31")).toBe("claude-code");
    expect(userAgentFamily("claude-cli/2.0.31 (external, cli)")).toBe("claude-code");
    expect(userAgentFamily("Mozilla/5.0")).toBe("other");
    expect(userAgentFamily("curl/8.5.0")).toBe("other");
    expect(userAgentFamily(null)).toBe("other");
  });
});

// ---------------------------------------------------------------------------------------------
// Edit stamps (design 2026-11-07-claude-edit-stamps-editedby §3.4; plan stage 4)
// ---------------------------------------------------------------------------------------------

/** env.DB, recording each statement's own D1 `meta` (`first` is answered from `all`, the same query). */
function meteredDb(): { db: D1Database; measured: { sql: string; rowsRead: number; rowsWritten: number }[] } {
  const measured: { sql: string; rowsRead: number; rowsWritten: number }[] = [];
  const record = <T extends D1Result>(sql: string, result: T): T => {
    measured.push({ sql, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    return result;
  };
  const statement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => statement(stmt.bind(...values), sql),
      run: async () => record(sql, await stmt.run()),
      all: async () => record(sql, await stmt.all()),
      first: async (column?: string) => {
        const row = (record(sql, await stmt.all()).results[0] ?? null) as Record<string, unknown> | null;
        return column === undefined || row === null ? row : row[column];
      },
    }) as unknown as D1PreparedStatement;
  return { db: { prepare: (sql: string) => statement(env.DB.prepare(sql), sql) } as unknown as D1Database, measured };
}

/** Placeholder arguments for a tool's required inputs, from its input schema. */
function placeholderArgs(tool: { inputSchema: { properties?: Record<string, any>; required?: string[] } }): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of tool.inputSchema.required ?? []) {
    const schema = tool.inputSchema.properties?.[key] ?? {};
    if (key === "graph") args[key] = "work";
    else if (schema.type === "integer" || schema.type === "number") args[key] = 1;
    else if (schema.type === "boolean") args[key] = true;
    else if (schema.type === "array") args[key] = [B1];
    else if (schema.type === "object") args[key] = {};
    else args[key] = B1;
  }
  return args;
}

/** Each sync request of one call, with or without the graph's edit stamps, and the D1 cost of the call. */
async function stampedRun(name: string, args: Record<string, unknown>, editStamps: boolean) {
  await env.DB.prepare("UPDATE graphs SET edit_stamps = ? WHERE alias = 'work'").bind(editStamps ? 1 : 0).run();
  syncRequests = [];
  const { db, measured } = meteredDb();
  const before = await lastAuditId();
  const result = await callContent(name, args, connector(testEnv({ DB: db })));
  const rows = await auditRows(before);
  return { result, requests: syncRequests, measured, rows };
}

describe("edit stamps header", () => {
  it("every generated write sends x-logseq-edit-stamp: claude on each non-GET exactly when the graph's setting is on, with the same requests, D1 cost and audit row", async () => {
    let gets = 0;
    for (const name of GENERATED_WRITES) {
      const args = { graph: "work", ...AUDIT_CALLS[name], reason: REASON };
      syncHandler = preReadsEmpty(() => Response.json(CONTEXT_RESPONSE));
      const on = await stampedRun(name, args, true);
      const off = await stampedRun(name, args, false);
      expect(on.result.isError, name).toBe(false);
      expect(off.result.isError, name).toBe(false);

      // On: every non-GET carries the header with exactly "claude"; no GET (the audit pre-reads) does.
      const writes = on.requests.filter((r) => r.method !== "GET");
      expect(writes, name).toHaveLength(1);
      for (const r of on.requests) expect([r.method, r.stamp], name).toEqual([r.method, r.method === "GET" ? null : "claude"]);
      gets += on.requests.length - writes.length;
      // Off: nothing carries it.
      expect(off.requests.map((r) => r.stamp), name).toEqual(off.requests.map(() => null));

      // Otherwise identical: the same requests in the same order (so the same Worker requests and
      // rate-limited writes), the same D1 statements and rows, and the same audit row.
      const strip = (rs: typeof syncRequests) => rs.map(({ stamp: _stamp, ...rest }) => rest);
      expect(strip(on.requests), name).toEqual(strip(off.requests));
      expect(on.measured.map(({ sql, rowsRead, rowsWritten }) => [sql, rowsRead, rowsWritten]), name).toEqual(
        off.measured.map(({ sql, rowsRead, rowsWritten }) => [sql, rowsRead, rowsWritten]),
      );
      expect(on.rows, name).toHaveLength(1);
      expect(off.rows, name).toHaveLength(1);
      const { id: _a, at: _b, ...onRow } = on.rows[0];
      const { id: _c, at: _d, ...offRow } = off.rows[0];
      expect(onRow, name).toEqual(offRow);
    }
    // The GET assertion above is not vacuous: the deletes, updates, moves and property writes pre-read.
    expect(gets).toBeGreaterThan(10);
  });

  it("dry runs and refused writes: a dry run's request carries the header, a refusal before the request sends nothing", async () => {
    syncHandler = preReadsEmpty(() => Response.json({ ...CONTEXT_RESPONSE, "dry-run": true }));
    for (const [name, where] of Object.entries(DRY_RUN_IN)) {
      const base: Record<string, unknown> = { graph: "work", ...AUDIT_CALLS[name] };
      const args = where === "query" ? { ...base, "dry-run": true } : { ...base, body: { ...(base.body as object), "dry-run": true } };
      const on = await stampedRun(name, args, true);
      expect(on.result.isError, name).toBe(false);
      expect(on.requests.filter((r) => r.method !== "GET").map((r) => r.stamp), name).toEqual(["claude"]);
      expect(on.requests.filter((r) => r.method === "GET").map((r) => r.stamp), name).toEqual(
        on.requests.filter((r) => r.method === "GET").map(() => null),
      );
    }
    // A read-only graph and an over-long reason are refused before any request, stamps on or off.
    for (const args of [
      { graph: "notes", "block-id": B1, body: { title: "x" } },
      { graph: "work", "block-id": B1, body: { title: "x" }, reason: "x".repeat(201) },
    ]) {
      const on = await stampedRun("update_block", args, true);
      expect(on.result.isError).toBe(true);
      expect(on.requests).toEqual([]);
    }
  });

  it("a DELETE with no body carries the header; no read tool's GET ever does, whatever its query", async () => {
    acceptEverything();
    const del = await stampedRun("delete_block", { graph: "work", "block-id": B1 }, true);
    const deletes = del.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ body: "", stamp: "claude" });

    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    const generatedReads = committedManifest.filter((e) => e.method === "GET").map((e) => e.name);
    expect(generatedReads.length).toBeGreaterThan(15);
    let reads = 0;
    for (const name of generatedReads) {
      const tool = tools.find((t: { name: string }) => t.name === name);
      // Every optional query input too, so a body-like query (ids, filters, cursors) is sent.
      const args = { ...placeholderArgs(tool) };
      for (const [key, schema] of Object.entries<any>(tool.inputSchema.properties ?? {})) {
        if (key in args) continue;
        if (Array.isArray(schema.enum)) args[key] = schema.enum[0];
        else if (schema.type === "string") args[key] = "Meeting";
        else if (schema.type === "integer" || schema.type === "number") args[key] = 5;
        else if (schema.type === "boolean") args[key] = true;
      }
      const run = await stampedRun(name, args, true);
      expect(run.requests.length, `${name}: ${JSON.stringify(run.result)} ${JSON.stringify(args)}`).toBeGreaterThan(0);
      for (const r of run.requests) expect([r.method, r.stamp], name).toEqual(["GET", null]);
      reads += run.requests.length;
    }
    expect(reads).toBeGreaterThanOrEqual(generatedReads.length);
  });
});

const STAMP_SENTENCE =
  "When edit stamps are on for the graph, each block this call creates or changes is stamped editedBy=claude and claudeEditedAt (hidden properties, listed on the Claude Activity page).";
/** Spec §4's stamping tools, named independently of the source's list. */
const STAMPING_TOOLS = [
  "insert_block_tree",
  "insert_block_children",
  "batch_insert_block_trees",
  "capture_to_today",
  "create_task",
  "update_block",
  "set_block_property",
  "batch_set_block_property",
  "delete_block_property",
  "batch_delete_block_property",
  "move_blocks",
  "batch_move_blocks",
  "refresh_refs",
  "save_document",
  "save_file_from_url",
];

const HOLDER_STAMP_SENTENCE =
  "When edit stamps are on for the graph, each other block whose property value this call removes or converts (a value pointing at a deleted block, a retired choice, a text value converted to a choice) is stamped editedBy=claude and claudeEditedAt (hidden properties, listed on the Claude Activity page).";
/** The tools whose write stamps the blocks holding a value it removes or converts, not its own targets. */
const HOLDER_STAMPING_TOOLS = ["delete_block", "delete_blocks", "update_property"];

describe("edit stamps contract", () => {
  it("each tool that stamps the holders of a value it removes says so once; no other tool does", async () => {
    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    const holding = tools
      .filter((t: { description: string }) => t.description.includes(HOLDER_STAMP_SENTENCE))
      .map((t: { name: string }) => t.name);
    expect(holding.sort()).toEqual([...HOLDER_STAMPING_TOOLS].sort());
    for (const tool of tools) expect(tool.description.split(HOLDER_STAMP_SENTENCE).length, tool.name).toBeLessThanOrEqual(2);
  });

  it("each stamping tool's description holds the stamp sentence once; no other tool's does", async () => {
    const tools = (await rpc(connector(semanticOnEnv()), "tools/list", {}, semanticOnEnv())).tools;
    const holding = tools.filter((t: { description: string }) => t.description.includes(STAMP_SENTENCE)).map((t: { name: string }) => t.name);
    expect(holding.sort()).toEqual([...STAMPING_TOOLS].sort());
    for (const tool of tools) expect(tool.description.split(STAMP_SENTENCE).length, tool.name).toBeLessThanOrEqual(2);
    // No read tool carries it.
    for (const tool of tools.filter((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)) {
      expect(tool.description, tool.name).not.toContain("editedBy");
    }
  });

  it("connector_help holds the edit stamps section, once", async () => {
    const help = (await callTool("connector_help", {})).text;
    for (const phrase of [
      "When edit stamps are on for a graph (the default), the connector marks its writes",
      "each block a write creates or changes is stamped with two hidden properties, editedBy=claude and claudeEditedAt",
      "Pages, tags and properties are not stamped, nor are the blocks a delete removes",
      "delete_block, delete_blocks and update_property do stamp each other block whose property value they remove or convert",
      "The stamp stays when the owner later edits the block in the app",
      "E2EE graphs are not stamped",
      "The owner turns stamps off per graph on the connector's graph settings page; no tool can",
      "Claude Activity page",
      "Recycle bin",
      "answers 409 naming it until the owner renames it in the Logseq app (update_property can't: the rename is refused too)",
      "the properties of an insert (a BlockTree node's, or a batch_insert_block_trees entry's) refuse them too, naming the entry or node (entries[0]: editedBy is set by the server and can't be written)",
      "editedBy and claudeEditedAt are set by the server; set_block_property, batch_set_block_property, delete_block_property and batch_delete_block_property refuse them, naming the entry",
    ]) {
      expect(help, phrase).toContain(phrase);
    }
    expect(help.split("editedBy and claudeEditedAt are set by the server").length).toBe(2);
  });
});

// Patch 0037: code, math and quote blocks, as Claude reads about them in the tool list and connector_help.
describe("code, math and quote blocks", () => {
  const TREE_TOOLS = ["insert_block_tree", "insert_block_children", "batch_insert_block_trees", "capture_to_today"];
  const FENCE_TOOLS = [...TREE_TOOLS, "update_block"];
  const DESCRIBED_TOOLS = [...FENCE_TOOLS, "set_block_property", "batch_set_block_property"];

  /** The schema of a tree tool's top-level node. */
  function nodeSchema(tool: any): any {
    const body = tool.inputSchema.properties.body;
    return tool.name === "batch_insert_block_trees" ? body.properties.entries.items.properties.blocks.items : body.properties.blocks.items;
  }

  it("each tree tool's nodes take display-type, exactly code, math or quote, and lang; update_block's body takes both", async () => {
    const tools = await listTools();
    for (const name of TREE_TOOLS) {
      const node = nodeSchema(tools.find((t) => t.name === name));
      expect(node.properties["display-type"].enum, name).toEqual(["code", "math", "quote"]);
      expect(node.properties.lang.type, name).toBe("string");
      expect(node.properties.lang.maxLength, name).toBe(40);
    }
    const update = tools.find((t) => t.name === "update_block").inputSchema.properties.body.properties;
    expect(update["display-type"].enum).toEqual(["code", "math", "quote"]);
    expect(update.lang.type).toBe("string");
  });

  it("insert_block_tree and insert_block_children take dry-run; the five fence tools take convert-fences, default true", async () => {
    const tools = await listTools();
    for (const name of ["insert_block_tree", "insert_block_children"]) {
      expect(tools.find((t) => t.name === name).inputSchema.properties.body.properties["dry-run"].type, name).toBe("boolean");
    }
    for (const name of FENCE_TOOLS) {
      const flag = tools.find((t) => t.name === name).inputSchema.properties["convert-fences"];
      expect(flag?.type, name).toBe("boolean");
      expect(flag.default, name).toBe(true);
    }
  });

  it("display-type and lang reach the server on every node, at any depth and in either entry order, with convert-fences", async () => {
    syncHandler = preReadsEmpty(() => Response.json({ entries: [], count: 0 }, { status: 201 }));
    const chain = {
      title: "print(1)",
      "display-type": "code",
      lang: "python",
      children: [{ title: "E=mc^2", "display-type": "math", children: [{ title: "Example", "display-type": "quote" }] }],
    };
    const entries = [
      { page: "Example", blocks: [chain] },
      { page: "Example", blocks: [{ title: "```mermaid\ngraph TD\n```" }] },
    ];
    for (const order of [entries, [...entries].reverse()]) {
      syncRequests = [];
      const result = await callTool("batch_insert_block_trees", { graph: "work", "convert-fences": false, body: { entries: order } });
      expect(result.isError, result.text).toBe(false);
      const [write] = writeRequests();
      expect(new URL(write.url).searchParams.get("convert-fences")).toBe("false");
      expect(JSON.parse(write.body).entries.map((e: { blocks: unknown }) => e.blocks)).toEqual(order.map((e) => e.blocks));
    }
  });

  it("each changed description names display-type and points to connector_help's section", async () => {
    const tools = await listTools();
    for (const name of DESCRIBED_TOOLS) {
      const description = tools.find((t) => t.name === name).description;
      expect(description, name).toContain("display-type");
      expect(description, name).toContain("connector_help's Code, math and quote blocks");
    }
    for (const name of FENCE_TOOLS) {
      const description = tools.find((t) => t.name === name).description;
      expect(description, name).toContain("convert-fences");
      expect(description, name).toContain("kept");
    }
  });

  it("connector_help has the Code, math and quote blocks section", async () => {
    const help = (await callTool("connector_help", {})).text;
    expect(help).toContain(CODE_BLOCKS_HELP);
    expect(CODE_BLOCKS_HELP.startsWith("Code, math and quote blocks:")).toBe(true);
  });

  // One assertion per point, so dropping any one of them from the section fails.
  it.each([
    ["code", 'display-type: "code"'],
    ["math", '"math"'],
    ["quote", '"quote"'],
    ["lang", "lang is a code block's language"],
    ["lang only with code", "lang only with code"],
    ["fence conversion", "whole title is one ``` or $$ fence"],
    ["convert-fences", "convert-fences=false"],
    ["verbatim titles", "stored exactly as sent"],
    ["mermaid", "```mermaid is highlighted code"],
    ["query fences", "```query fences stay text"],
    ["kept", "listed under kept"],
    ["converting an existing block", "update_block with the title and display-type together"],
    ["the \\# warning", "\\# escapes"],
    ["quote keeps tag handling", "A quote block keeps tag and link handling"],
  ])("the section names %s", (_point, phrase) => {
    expect(CODE_BLOCKS_HELP).toContain(phrase);
  });

  it("the heading sentence agrees with the section: no heading for a code, math or quote block, and quote keeps tag handling", () => {
    expect(CONNECTOR_HELP).toContain("A code, math or quote block has no heading: its # lines are kept as given");
    expect(CONNECTOR_HELP).not.toContain("keeps its title as given, # lines included");
  });
});

// Patch 0038: favourites, as Claude reads about them in connector_help and the generated descriptions.
describe("favourites", () => {
  // One assertion per point, so dropping any one of them from the paragraph fails.
  it.each([
    ["list_favorites", "list_favorites reads them in sidebar order"],
    ["set_page_favorite", "set_page_favorite with favorite: true adds a page"],
    ["reorder_favorites", "reorder_favorites takes the full list in the new order"],
    ["what can be a favourite", "(a page, journal, tag or property, never a block; a tag or property by its UUID)"],
    ["bottom, unlike the app", "at the bottom of the list, unlike the app, which adds at the top"],
    ["remove is a delete", "favorite: false removes it, which counts as a delete, so a write-no-delete token can't do it"],
    ["a dry run is allowed", "(a dry run can)"],
    ["re-sends write nothing", "A re-send writes nothing"],
    ["list first", "call list_favorites first and pass every favourite once"],
    ["delete_page hides", "Deleting a page with delete_page hides its favourite"],
    ["restore brings back", "restoring the page from the Recycle bin brings it back in its place"],
    ["remove a deleted page's favourite", "remove a deleted page's favourite by its UUID"],
    ["writes refused on E2EE", "Adding, removing and reordering favourites are unavailable on E2EE graphs"],
    ["the list still reads on E2EE", "list_favorites still reads them there, with titles as stored"],
  ])("connector_help's Favourites paragraph says %s", async (_point, phrase) => {
    const help = (await callTool("connector_help", {})).text;
    expect(help).toContain(phrase);
  });

  it("connector_help holds the Favourites paragraph once", async () => {
    const help = (await callTool("connector_help", {})).text;
    expect(help.split("Favourites are the pages in the sidebar's Favorites list.").length).toBe(2);
  });

  // These carry the openapi text vendored in Stages 1 to 3, so they passed before this stage.
  it.each([
    ["list_favorites", ["in sidebar order", "Works on E2EE graphs"]],
    ["set_page_favorite", ["appended at the bottom of the list, unlike the app", "Unavailable for E2EE graphs (400)", "deletePage hides a favourite and restoring the page brings it back"]],
    ["reorder_favorites", ["Pass the full list", "call listFavorites first", "Unavailable for E2EE graphs (400)"]],
  ])("%s's generated description carries the openapi text", async (name, phrases) => {
    const tool = (await listTools()).find((t) => t.name === name);
    for (const phrase of phrases) expect(tool.description, phrase).toContain(phrase);
  });
});
