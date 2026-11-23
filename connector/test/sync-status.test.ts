// get_sync_status (plan docs/superpowers/plans/2026-11-22-blank-blocks-sync-status-tools.md stage 2,
// spec docs/superpowers/specs/2026-11-20-blank-blocks-and-sync-status-design.md §3.3, §4, §5, §6).
// The real tool runs through mcpHandler on real D1; only SYNC (the sync server) is stubbed, and AI and
// VECTORIZE where semantic search is on, each recording every call so a test can say none was made.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import { READ_ROW_WRITES } from "../src/audit/log";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { CONNECTOR_HELP } from "../src/tools/handwritten";
import { SYNC_STATUS_HELP } from "../src/tools/sync-status";
import { FIRST_LINES, HANDWRITTEN_TOOLS, SEMANTIC_TOOLS, annotationsFor } from "../src/tools/spec.mjs";

const ORIGIN = "https://mcp.example.com";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const WORK_TOKEN = "logseq_pat_WorkToken123";

/** A route answer as patch 0055 gives it (SyncStatusResponse). */
const ROUTE = {
  t: 120,
  "last-written-at": "2026-11-20T09:15:00.000Z",
  "last-op": "delete-blocks",
  checksum: "abc123",
  "page-count": 14,
  "block-count": 230,
  "counts-include-private": false,
  e2ee: false,
  clients: { connected: 3, users: 2, own: 2, others: 1, editing: 1 },
};

/** The route's fields as the tool copies them, after `graph`. */
const SYNC_FIELDS = {
  t: 120,
  "last-written-at": "2026-11-20T09:15:00.000Z",
  "last-op": "delete-blocks",
  "block-count": 230,
  "page-count": 14,
  "counts-include-private": false,
  e2ee: false,
  checksum: "abc123",
  clients: { connected: 3, users: 2, own: 2, others: 1, editing: 1 },
};

let route: unknown;
let routeStatus: number;
let syncRequests: { method: string; path: string }[];
let vectorizeCalls: string[];
let aiCalls: number;
let consoleSpies: MockInstance[];

function sync(): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      syncRequests.push({ method: request.method, path: url.pathname });
      if (request.headers.get("Authorization") !== `Bearer ${WORK_TOKEN}`) return Response.json({ error: "unauthorised" }, { status: 401 });
      if (request.method !== "GET" || url.pathname !== `/api/v1/graphs/${WORK_ID}/sync-status`) {
        return Response.json({ error: `unexpected sync call ${request.method} ${url.pathname}` }, { status: 599 });
      }
      return Response.json(route, { status: routeStatus });
    },
  } as unknown as Fetcher;
}

/** A Vectorize binding that records each method called and answers nothing useful. */
function vectorize(): Vectorize {
  return new Proxy({} as Vectorize, {
    get: (_target, prop) => async () => {
      vectorizeCalls.push(String(prop));
      return { dimensions: 384, vectorCount: 0, matches: [] };
    },
  });
}

/** The env without semantic search: no AI or VECTORIZE binding. */
function plainEnv(db: D1Database = env.DB): Env {
  return { ...env, DB: db, SYNC: sync(), AI: undefined, VECTORIZE: undefined, SEMANTIC_MAX_VECTORS: undefined } as unknown as Env;
}

/** The env with semantic search on; AI and VECTORIZE record any call. */
function semanticEnv(db: D1Database = env.DB): Env {
  const ai = { run: async () => { aiCalls += 1; return { shape: [0, 384], data: [] }; } } as unknown as Ai;
  return { ...env, DB: db, SYNC: sync(), AI: ai, VECTORIZE: vectorize(), SEMANTIC_MAX_VECTORS: "10000" } as Env;
}

async function rpc(e: Env, method: string, params: unknown): Promise<any> {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ctx = createExecutionContext();
  const res = await mcpHandler(e, ctx)(request, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 1)
    : JSON.parse(text);
  expect(json.error).toBeUndefined();
  return json.result;
}

async function callTool(e: Env, args: Record<string, unknown> = { graph: "work" }): Promise<{ isError: boolean; text: string }> {
  const result = await rpc(e, "tools/call", { name: "get_sync_status", arguments: args });
  return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

async function status(e: Env): Promise<any> {
  const result = await callTool(e);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text);
}

/** One semantic_state row for the work graph (other columns take what the indexer would leave). */
async function seedState(fields: { t: number | null; status: string; blocks: number; indexedAt?: string | null; error?: string | null; cursor?: string | null }, graphId = WORK_ID): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO semantic_state (graph_id, epoch, t, pending_t, cursor, last_uuid, status, error, lease_until, indexed_at, blocks)
     VALUES (?, 'e1', ?, NULL, ?, NULL, ?, ?, 0, ?, ?)`,
  )
    .bind(graphId, fields.t, fields.cursor ?? null, fields.status, fields.error ?? null, fields.indexedAt ?? null, fields.blocks)
    .run();
}

async function readRows(): Promise<{ tool: string; kind: string; status: string; graph_id: string | null; alias: string; addressed: string; rows_written: number }[]> {
  return (await env.DB.prepare("SELECT tool, kind, status, graph_id, alias, addressed, rows_written FROM audit_log ORDER BY id").all<any>()).results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs; DELETE FROM semantic_blocks; DELETE FROM semantic_state; DELETE FROM audit_log;");
  await new GraphStore(env.DB, env.GRAPH_TOKEN_KEY).add({
    alias: "work", graphId: WORK_ID, graphName: "Work", mode: "write", permission: "both", expiresAt: null, token: WORK_TOKEN,
  });
  route = structuredClone(ROUTE);
  routeStatus = 200;
  syncRequests = [];
  vectorizeCalls = [];
  aiCalls = 0;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("get_sync_status", () => {
  it("returns the route's fields and the semantic part, index-t from semantic_state.t and behind-by the difference", async () => {
    await seedState({ t: 100, status: "ready", blocks: 42, indexedAt: "2026-11-20T09:00:00.000Z" });
    const body = await status(semanticEnv());
    expect(body).toEqual({
      graph: "work",
      ...SYNC_FIELDS,
      semantic: { status: "ready", "indexed-blocks": 42, "indexed-at": "2026-11-20T09:00:00.000Z", "index-t": 100, "behind-by": 20, error: null },
    });
    // The keys come in the order spec §4 lists them.
    expect(Object.keys(body)).toEqual(["graph", ...Object.keys(SYNC_FIELDS), "semantic"]);
    expect(syncRequests).toEqual([{ method: "GET", path: `/api/v1/graphs/${WORK_ID}/sync-status` }]);
  });

  it("an index in error keeps its status and error, and its last t", async () => {
    await seedState({ t: 118, status: "error", blocks: 7, indexedAt: "2026-11-19T01:00:00.000Z", error: "token refused" });
    expect((await status(semanticEnv())).semantic).toEqual({
      status: "error", "indexed-blocks": 7, "indexed-at": "2026-11-19T01:00:00.000Z", "index-t": 118, "behind-by": 2, error: "token refused",
    });
  });

  it("a graph never indexed (review focus 5): not started, index-t and behind-by null", async () => {
    // Another graph's state row must not leak into this one's.
    await seedState({ t: 50, status: "ready", blocks: 9 }, OTHER_ID);
    expect((await status(semanticEnv())).semantic).toEqual({
      status: "not started", "indexed-blocks": 0, "indexed-at": null, "index-t": null, "behind-by": null, error: null,
    });
  });

  it("a first listing still in progress (state row, t null): index-t and behind-by null", async () => {
    await seedState({ t: null, status: "building", blocks: 3, cursor: "c1" });
    expect((await status(semanticEnv())).semantic).toMatchObject({ status: "building", "indexed-blocks": 3, "index-t": null, "behind-by": null });
  });

  it("an index ahead of the sync log (review focus 6, a reset graph): behind-by is negative, not clamped", async () => {
    await seedState({ t: 150, status: "ready", blocks: 1 });
    expect((await status(semanticEnv())).semantic).toMatchObject({ "index-t": 150, "behind-by": -30 });
  });

  it("an index exactly at the sync t: behind-by 0", async () => {
    await seedState({ t: 120, status: "ready", blocks: 1 });
    expect((await status(semanticEnv())).semantic).toMatchObject({ "index-t": 120, "behind-by": 0 });
  });

  it("behindBy is sync t minus index t, null when either is null, never clamped", async () => {
    // Imported here so the rest of the file runs on a tree without the module.
    const { behindBy } = await import("../src/semantic/status");
    expect(behindBy(120, 100)).toBe(20);
    expect(behindBy(100, 120)).toBe(-20);
    expect(behindBy(0, 0)).toBe(0);
    expect(behindBy(null, 100)).toBeNull();
    expect(behindBy(120, null)).toBeNull();
    expect(behindBy(null, null)).toBeNull();
  });

  it("a route answer with no t: t and behind-by are null, not made up", async () => {
    await seedState({ t: 100, status: "ready", blocks: 1 });
    delete (route as Record<string, unknown>).t;
    const body = await status(semanticEnv());
    expect(body.t).toBeNull();
    expect(body.semantic).toMatchObject({ "index-t": 100, "behind-by": null });
  });

  it("nulls the route answers as null stay null: last write, checksum, own and others", async () => {
    route = { ...ROUTE, "last-written-at": null, "last-op": null, checksum: null, clients: { connected: 0, users: 0, own: null, others: null, editing: 0 } };
    const body = await status(plainEnv());
    expect(body).toMatchObject({
      "last-written-at": null, "last-op": null, checksum: null, clients: { connected: 0, users: 0, own: null, others: null, editing: 0 },
    });
  });

  it("is registered without semantic bindings: semantic null with semantic-note", async () => {
    const names = (await rpc(plainEnv(), "tools/list", {})).tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_sync_status");
    expect(names).not.toContain("semantic_index_status");
    const body = await status(plainEnv());
    expect(body).toEqual({ graph: "work", ...SYNC_FIELDS, semantic: null, "semantic-note": "semantic search not configured" });
    expect(Object.keys(body).at(-1)).toBe("semantic-note");
    expect(syncRequests).toHaveLength(1);
  });

  it("with semantic search on, there is no semantic-note", async () => {
    expect(await status(semanticEnv())).not.toHaveProperty("semantic-note");
  });

  it("copies named fields only: an identity the route wrongly carried never reaches the answer", async () => {
    const leaks = {
      "user-id": "user-a-0001",
      email: "user-a@example.com",
      username: "usera",
      name: "User A",
      "editing-block-uuid": "66666666-6666-6666-6666-666666666666",
    };
    route = {
      ...ROUTE,
      ...leaks,
      users: [{ "user-id": "user-b-0002", email: "user-b@example.com", name: "User B" }],
      clients: { ...ROUTE.clients, ...leaks, sockets: [{ email: "user-b@example.com", "editing-block-uuid": "77777777-7777-7777-7777-777777777777" }] },
    };
    for (const e of [plainEnv(), semanticEnv()]) {
      const result = await callTool(e);
      expect(result.isError, result.text).toBe(false);
      for (const needle of ["user-a-0001", "user-b-0002", "user-a@example.com", "user-b@example.com", "usera", "User A", "User B", "66666666", "77777777", "sockets", WORK_TOKEN]) {
        expect(result.text, needle).not.toContain(needle);
      }
      expect(Object.keys(JSON.parse(result.text).clients)).toEqual(["connected", "users", "own", "others", "editing"]);
    }
  });

  it("refuses a route answer of the wrong shape, naming the field, rather than passing it on", async () => {
    for (const [field, value] of [
      ["t", "120"],
      ["block-count", -1],
      ["e2ee", "false"],
      ["clients", "3"],
      ["last-op", 7],
    ] as const) {
      route = { ...ROUTE, [field]: value };
      const result = await callTool(plainEnv());
      expect(result, field).toEqual({ isError: true, text: `getSyncStatus returned an invalid ${field}` });
    }
    route = { ...ROUTE, clients: { ...ROUTE.clients, editing: 1.5 } };
    expect(await callTool(plainEnv())).toEqual({ isError: true, text: "getSyncStatus returned an invalid clients.editing" });
    route = ["not", "an", "object"];
    expect(await callTool(plainEnv())).toEqual({ isError: true, text: "getSyncStatus returned no object" });
  });

  it("passes a sync error on and still records the read, as error", async () => {
    routeStatus = 404;
    route = { error: "not found" };
    const result = await callTool(semanticEnv());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("404");
    expect((await readRows()).map((r) => [r.tool, r.kind, r.status])).toEqual([["get_sync_status", "read", "error"]]);
  });

  it("refuses an unknown graph before any sync request", async () => {
    expect(await callTool(semanticEnv(), { graph: "nope" })).toEqual({ isError: true, text: "unknown graph 'nope' — call list_graphs for the connected aliases" });
    expect(syncRequests).toEqual([]);
    expect(await readRows()).toEqual([
      { tool: "get_sync_status", kind: "read", status: "error", graph_id: null, alias: "nope", addressed: "[]", rows_written: READ_ROW_WRITES },
    ]);
  });

  it("records one read row per call", async () => {
    await status(semanticEnv());
    await status(plainEnv());
    expect(await readRows()).toEqual([
      { tool: "get_sync_status", kind: "read", status: "ok", graph_id: WORK_ID, alias: "work", addressed: "[]", rows_written: READ_ROW_WRITES },
      { tool: "get_sync_status", kind: "read", status: "ok", graph_id: WORK_ID, alias: "work", addressed: "[]", rows_written: READ_ROW_WRITES },
    ]);
  });

  it("cost: one sync request, no Vectorize or Workers AI call, and the D1 rows read and written pinned from meta", async () => {
    // Five graphs' state rows, as on an owner's deploy, so the counts query reads what it would there.
    await seedState({ t: 100, status: "ready", blocks: 42 });
    for (let i = 0; i < 4; i += 1) await seedState({ t: 10, status: "ready", blocks: 1 }, `3333333${i}-3333-3333-3333-333333333333`);
    const measured: { sql: string; read: number; written: number }[] = [];
    const metered = metering(env.DB, measured);

    const body = await status(semanticEnv(metered));
    expect(body.semantic["behind-by"]).toBe(20);
    expect(syncRequests).toHaveLength(1);
    expect(vectorizeCalls).toEqual([]);
    expect(aiCalls).toBe(0);
    const shapes = measured.map((m) => [m.sql.replace(/\s+/g, " ").trim().slice(0, 40), m.read, m.written]);
    expect(shapes).toEqual([
      ["SELECT graph_id, mode, token_ct, token_i", 1, 0],
      ["SELECT * FROM semantic_state WHERE graph", 1, 0],
      ["SELECT coalesce((SELECT blocks FROM sema", 6, 0],
      // onSuccess's last_used_at touch (every read tool's), then the read row.
      ["UPDATE graphs SET last_used_at = ? WHERE", 1, 1],
      ["INSERT INTO audit_log (at, graph_id, ali", 0, READ_ROW_WRITES],
    ]);
    const total = measured.reduce((n, m) => ({ read: n.read + m.read, written: n.written + m.written }), { read: 0, written: 0 });
    expect(total).toEqual({ read: 9, written: 3 });

    // Without semantic search the two semantic_state reads go.
    measured.length = 0;
    syncRequests = [];
    await status(plainEnv(metered));
    expect(syncRequests).toHaveLength(1);
    expect(measured.map((m) => [m.sql.replace(/\s+/g, " ").trim().slice(0, 40), m.read, m.written])).toEqual([
      ["SELECT graph_id, mode, token_ct, token_i", 1, 0],
      ["UPDATE graphs SET last_used_at = ? WHERE", 1, 1],
      ["INSERT INTO audit_log (at, graph_id, ali", 0, READ_ROW_WRITES],
    ]);
  });
});

describe("get_sync_status in the contract", () => {
  it("is hand-written, not semantic, READ, with a first line of at most 100 characters, and in the manifest once", () => {
    expect(HANDWRITTEN_TOOLS).toContain("get_sync_status");
    expect(SEMANTIC_TOOLS).not.toContain("get_sync_status");
    expect(annotationsFor("get_sync_status")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const line = (FIRST_LINES as Record<string, string>).get_sync_status;
    expect(line).toBe("A graph's sync state: latest t, last write, block and page counts, clients online, index status.");
    expect(line.length).toBeLessThanOrEqual(100);
    expect(committedManifest.filter((e) => e.name === "get_sync_status")).toEqual([
      { name: "get_sync_status", method: null, path: null, annotations: annotationsFor("get_sync_status"), firstLine: line },
    ]);
  });

  it("connector_help names it: what it answers, clients as counts with no device kind, and what behind-by means", () => {
    expect(CONNECTOR_HELP).toContain(SYNC_STATUS_HELP);
    expect(SYNC_STATUS_HELP).toContain("get_sync_status");
    expect(SYNC_STATUS_HELP).toMatch(/counts only/);
    expect(SYNC_STATUS_HELP).toMatch(/no device or client kind/);
    expect(SYNC_STATUS_HELP).toMatch(/behind-by: how many sync transactions the semantic index has not seen/);
    expect(SYNC_STATUS_HELP).toMatch(/negative/);
  });

  it("says block-count takes in property value blocks, so it can be above what list_page_blocks shows (review r1-light-2)", async () => {
    const claim = "block-count counts the blocks on those pages, property value blocks included, so it can be higher than list_page_blocks shows; no hidden pages, Recycle bin or Private content";
    const tool = (await rpc(plainEnv(), "tools/list", {})).tools.find((t: { name: string }) => t.name === "get_sync_status");
    for (const [where, text] of [["connector_help", SYNC_STATUS_HELP], ["description", tool.description as string]]) {
      expect(text, where).toContain(claim);
      expect(text, where).toContain("page-count (the pages list_pages shows)");
      expect(text, where).not.toMatch(/as list_pages and list_page_blocks show|what list_pages and list_page_blocks show/);
    }
  });

  it("its description says behind-by and a negative value, and that clients are counts", async () => {
    const tool = (await rpc(plainEnv(), "tools/list", {})).tools.find((t: { name: string }) => t.name === "get_sync_status");
    expect(tool.description.split("\n")[0]).toBe((FIRST_LINES as Record<string, string>).get_sync_status);
    expect(tool.description).toMatch(/behind-by/);
    expect(tool.description).toMatch(/negative/);
    expect(tool.description).toMatch(/counts only/);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.inputSchema.required).toEqual(["graph"]);
  });
});

/**
 * A D1 database that records each statement's rows read and written from D1's own meta. `first` is
 * answered through `all`, whose meta the plain `first` does not return.
 */
function metering(db: D1Database, measured: { sql: string; read: number; written: number }[]): D1Database {
  const wrap = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...v: unknown[]) => wrap(sql, stmt.bind(...v)),
      first: async (column?: string) => {
        const r = await stmt.all<Record<string, unknown>>();
        measured.push({ sql, read: r.meta.rows_read, written: r.meta.rows_written });
        const row = r.results[0] ?? null;
        return column === undefined || row === null ? row : row[column];
      },
      all: async () => {
        const r = await stmt.all();
        measured.push({ sql, read: r.meta.rows_read, written: r.meta.rows_written });
        return r;
      },
      run: async () => {
        const r = await stmt.run();
        measured.push({ sql, read: r.meta.rows_read, written: r.meta.rows_written });
        return r;
      },
    }) as unknown as D1PreparedStatement;
  return {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (s: D1PreparedStatement[]) => db.batch(s),
    exec: (sql: string) => db.exec(sql),
  } as unknown as D1Database;
}
