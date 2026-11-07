import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { RESULT_CHAR_LIMIT, capResult } from "../src/tools/common";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { registerAssetTools } from "../src/tools/assets";
import { buildGraphTools, registerGraphTools } from "../src/tools/semantic";
import { toAffectedTargets } from "../src/tools/readable";
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
let syncRequests: { method: string; url: string; auth: string | null; body: string }[];
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
async function rpc(handler: Handler, method: string, params: unknown, e: Env = testEnv()): Promise<any> {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
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
const READ_HANDWRITTEN = ["connector_help", "list_graphs", "kb_index", "semantic_search", "semantic_index_status", "read_file"];
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
];
const ADDITIVE_NAMED = [
  "batch_insert_block_trees",
  "capture_to_today",
  "move_blocks",
  "batch_move_blocks",
  "save_document",
  "save_file_from_url",
];

function expectedHints(name: string, method: string | null) {
  const classes: string[] = [];
  if (method === "GET" || READ_HANDWRITTEN.includes(name)) classes.push("read");
  if (name.startsWith("delete_") || DESTRUCTIVE_NAMED.includes(name)) classes.push("destructive");
  if (/^(create|insert)_/.test(name) || ADDITIVE_NAMED.includes(name)) classes.push("additive");
  // A new tool must be classified on purpose, and no tool may sit in two classes.
  expect(classes, `${name} is in exactly one class`).toHaveLength(1);
  const openWorldHint = name === "save_file_from_url";
  if (classes[0] === "read") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint };
  if (classes[0] === "additive") return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint };
  const idempotentHint = /^(batch_)?(delete|set)_/.test(name);
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
    ]) {
      expect(ANNOTATIONS[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const name of ["delete_blocks", "delete_page", "set_block_property", "batch_set_block_property"]) {
      expect(ANNOTATIONS[name].idempotentHint, name).toBe(true);
    }
    for (const name of ["update_block", "move_blocks", "save_document"]) {
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
        registerGraphTools(server, tools, onSuccess);
        registerAssetTools(server, access, onSuccess);
        return server;
      },
      { route: "/mcp" },
    )(request, e, ctx);
  };
}

/** A sync stub answering every call with an empty JSON object, and uploads like createAsset. */
function acceptEverything(): void {
  syncHandler = (request) =>
    new URL(request.url).pathname.endsWith("/assets")
      ? Response.json({ uuid: "a1", "page-id": PAGE_UUID, "page-title": "Nov 5th, 2026" }, { status: 201 })
      : Response.json({ ok: true });
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
      // The request is exactly the one the call makes without a reason.
      expect(sentWith, name).toEqual(sentWithout);
      expect(sentWith, name).toHaveLength(1);
      expect(new URL(sentWith[0].url).searchParams.has("reason"), name).toBe(false);
      expect(sentWith[0].url, name).not.toContain("tidy");
      expect(sentWith[0].body, name).not.toContain("tidy");
      expect(sentWith[0].body, name).not.toContain("reason");
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
      expect(ok.content[0].text).toBe(`Reason: ${reason}`);
    }
    expect(syncRequests).toHaveLength(2);
  });

  it("reason is repeated as the first content item, ahead of the unchanged result", async () => {
    syncHandler = () => Response.json({ uuid: "b1", title: "New title" });
    const args = { graph: "work", "block-id": "b1", body: { title: "New title" } };
    const without = await callContent("update_block", args);
    expect(without.content).toHaveLength(1);
    const withReason = await callContent("update_block", { ...args, reason: `  ${REASON} ` });
    expect(withReason).toEqual({
      isError: false,
      content: [{ type: "text", text: `Reason: ${REASON}` }, ...without.content],
    });
    // No reason, an empty one or one of only spaces leaves the result as it was.
    for (const reason of ["", "   "]) {
      expect(await callContent("update_block", { ...args, reason }), JSON.stringify(reason)).toEqual(without);
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
    syncHandler = () => Response.json(deleted);
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
    expect(result.content[0].text.endsWith(`\nReason: ${REASON}`)).toBe(true);
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
    expect(JSON.parse(result.text)).toEqual({ id: "p1", title: "Standup [[Ann]]" });
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0]).toEqual({
      method: "POST",
      url: `https://sync.internal/api/v1/graphs/${WORK_ID}/pages`,
      auth: `Bearer ${WORK_TOKEN}`,
      body: JSON.stringify({ title: "Standup [[Ann]]" }),
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
    expect(JSON.parse(result.text)).toMatchObject({ promoted: { blocks: 3, references: 2 }, "dry-run": true });
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
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0].method).toBe("POST");
    expect(new URL(syncRequests[0].url).pathname).toBe(`/api/v1/graphs/${WORK_ID}/pages/p1/promote-to-tag`);
    expect(syncRequests[0].body).toBe("");
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
    expect(help).toContain(
      "A tags list replaces only user tags: Page, Tag, Journal and the other built-in type tags an entity holds are kept",
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
      "every page-id, every target-id and create_task's page-id",
      "candidates",
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
