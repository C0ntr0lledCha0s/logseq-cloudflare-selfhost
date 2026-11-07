import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import committedManifest from "../tools-manifest.json";
import {
  generateServiceToken,
  hashServiceToken,
  ServiceTokenStore,
  TOKEN_PATTERN,
  TOUCH_INTERVAL_MS,
} from "../src/auth/service-tokens";
import { timingSafeEqual } from "../src/crypto";
import { GraphStore } from "../src/graphs";
import { isolateTools, mcpHandler } from "../src/mcp";
import { type RequestScope, lookupGraph, requestScope, withCallGraphs } from "../src/tools/common";

interface Measured {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The real D1 binding, recording each statement's own `meta`. Only `run` and `all` carry meta,
 * so `first` and `raw` throw: a store statement that used them could not be costed.
 */
function metered(db: D1Database = env.DB): { db: D1Database; measured: Measured[] } {
  const measured: Measured[] = [];
  const statement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => statement(stmt.bind(...values), sql),
      run: async () => record(sql, await stmt.run()),
      all: async () => record(sql, await stmt.all()),
      first: () => {
        throw new Error("first() has no meta");
      },
      raw: () => {
        throw new Error("raw() has no meta");
      },
    }) as unknown as D1PreparedStatement;
  const record = <T extends D1Result>(sql: string, result: T): T => {
    measured.push({ sql, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    return result;
  };
  return {
    db: { prepare: (sql: string) => statement(db.prepare(sql), sql) } as unknown as D1Database,
    measured,
  };
}

const OWNER = 4242;
const WORK = "11111111-1111-1111-1111-111111111111";
const NOTES = "22222222-2222-2222-2222-222222222222";
const T0 = Date.UTC(2026, 10, 7, 9, 0, 0);
const DAY = 86_400_000;

function newToken(name: string, overrides: Partial<Parameters<ServiceTokenStore["create"]>[0]> = {}) {
  return {
    name,
    ownerId: OWNER,
    graphIds: [WORK],
    access: "read" as const,
    createdAt: T0,
    expiresAt: T0 + 90 * DAY,
    ...overrides,
  };
}

/** A raw INSERT, bypassing the store, so each CHECK can be tried on its own. */
function rawInsert(values: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: crypto.randomUUID(),
    name: `raw-${crypto.randomUUID().slice(0, 8)}`,
    token_hash: "0".repeat(64),
    owner_id: OWNER,
    graph_ids: JSON.stringify([WORK]),
    access: "read",
    created_at: T0,
    expires_at: T0 + DAY,
    ...values,
  };
  return env.DB.prepare(
    "INSERT INTO service_tokens (id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.name, row.token_hash, row.owner_id, row.graph_ids, row.access, row.created_at, row.expires_at)
    .run();
}

async function allColumns(): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare("SELECT * FROM service_tokens").all<Record<string, unknown>>()).results;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM service_tokens");
});

const GRAPH_IDS_CHECK = "json_valid(graph_ids) AND json_type(graph_ids) = 'array'";

describe("migration 0006", () => {
  it("applies after 0005 and creates service_tokens with a unique service_tokens_hash index", async () => {
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map(
      (r) => r.name,
    );
    expect(applied.indexOf("0006_service_tokens.sql")).toBe(applied.indexOf("0005_graph_edit_stamps.sql") + 1);
    const indexes = (await env.DB.prepare("PRAGMA index_list(service_tokens)").all<{ name: string; unique: number }>()).results;
    const hashIndex = indexes.find((i) => i.name === "service_tokens_hash");
    expect(hashIndex?.unique).toBe(1);
    const columns = (await env.DB.prepare("PRAGMA index_info(service_tokens_hash)").all<{ name: string }>()).results;
    expect(columns.map((c) => c.name)).toEqual(["token_hash"]);
  });

  it("accepts a well-formed row of either access, with empty or several graphs", async () => {
    await rawInsert({ access: "read" });
    await rawInsert({ access: "write", token_hash: "1".repeat(64), graph_ids: JSON.stringify([WORK, NOTES]) });
    await rawInsert({ token_hash: "2".repeat(64), graph_ids: "[]", expires_at: T0 + 1 });
    expect(await allColumns()).toHaveLength(3);
  });

  it.each([
    ["access 'admin'", { access: "admin" }, "access = 'read' OR access = 'write'"],
    ["access ''", { access: "" }, "access = 'read' OR access = 'write'"],
    ["access 'READ'", { access: "READ" }, "access = 'read' OR access = 'write'"],
    ["graph_ids '{}'", { graph_ids: "{}" }, GRAPH_IDS_CHECK],
    ["graph_ids 'x'", { graph_ids: "x" }, GRAPH_IDS_CHECK],
    ["graph_ids '\"work\"'", { graph_ids: '"work"' }, GRAPH_IDS_CHECK],
    ["graph_ids '3'", { graph_ids: "3" }, GRAPH_IDS_CHECK],
    ["expires_at = created_at", { expires_at: T0 }, "expires_at > created_at"],
    ["expires_at < created_at", { expires_at: T0 - 1 }, "expires_at > created_at"],
  ])("refuses %s by its CHECK", async (_label, values, check) => {
    await expect(rawInsert(values)).rejects.toThrow(`CHECK constraint failed: ${check}`);
    expect(await allColumns()).toHaveLength(0);
  });

  it("refuses a duplicate name and a duplicate token_hash", async () => {
    await rawInsert({ name: "ci", token_hash: "a".repeat(64) });
    await expect(rawInsert({ name: "ci", token_hash: "b".repeat(64) })).rejects.toThrow(
      "UNIQUE constraint failed: service_tokens.name",
    );
    await expect(rawInsert({ name: "nightly", token_hash: "a".repeat(64) })).rejects.toThrow(
      "UNIQUE constraint failed: service_tokens.token_hash",
    );
    expect(await allColumns()).toHaveLength(1);
  });
});

describe("generateServiceToken", () => {
  it("makes 48-character lsct_ tokens that match TOKEN_PATTERN, have no colon and are distinct", () => {
    const tokens = Array.from({ length: 100 }, () => generateServiceToken());
    for (const token of tokens) {
      expect(token).toMatch(TOKEN_PATTERN);
      expect(token).toHaveLength(48);
      expect(token.startsWith("lsct_")).toBe(true);
      expect(token).not.toContain(":");
    }
    expect(new Set(tokens).size).toBe(100);
  });

  it("TOKEN_PATTERN refuses near misses", () => {
    const body = "A".repeat(43);
    for (const bad of [`lsct_${body}A`, `lsct_${body.slice(1)}`, `LSCT_${body}`, `lsct_${body.slice(1)}=`, `lsct_${body.slice(1)}:`, `a:b:c`, ``]) {
      expect(TOKEN_PATTERN.test(bad)).toBe(false);
    }
    expect(TOKEN_PATTERN.test(`lsct_${"-_aZ09".repeat(7)}A`)).toBe(true);
  });
});

describe("hashServiceToken", () => {
  it("is SHA-256 as lower-case hex", async () => {
    // FIPS 180-2 test vector.
    expect(await hashServiceToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const fixed = `lsct_${"A".repeat(43)}`;
    const hash = await hashServiceToken(fixed);
    expect(hash).toBe("8dde0dbb5c8f01f8ea8489eb2c6bad2fd831c1223d1f7784b83f2845a5f8297b");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("timingSafeEqual (crypto.ts)", () => {
  it("compares equal, unequal and unequal-length strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
  });
});

describe("ServiceTokenStore", () => {
  it("create returns the token once, stores only its hash, and writes 4 rows", async () => {
    const m = metered();
    const { id, token } = await new ServiceTokenStore(m.db).create(newToken("ci", { graphIds: [WORK, NOTES], access: "write" }));
    expect(token).toMatch(TOKEN_PATTERN);
    expect(m.measured).toHaveLength(1);
    expect(m.measured[0]).toMatchObject({ rowsWritten: 4, rowsRead: 0 });
    const rows = await allColumns();
    expect(rows).toHaveLength(1);
    for (const value of Object.values(rows[0])) {
      expect(String(value)).not.toContain(token);
      expect(String(value)).not.toContain(token.slice(5));
    }
    expect(rows[0]).toMatchObject({
      id,
      name: "ci",
      token_hash: await hashServiceToken(token),
      owner_id: OWNER,
      graph_ids: JSON.stringify([WORK, NOTES]),
      access: "write",
      created_at: T0,
      expires_at: T0 + 90 * DAY,
      last_used_at: null,
      revoked_at: null,
    });
  });

  it("create gives distinct ids and tokens, and refuses a duplicate name", async () => {
    const s = new ServiceTokenStore(env.DB);
    const a = await s.create(newToken("ci"));
    const b = await s.create(newToken("nightly"));
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    await expect(s.create(newToken("ci"))).rejects.toThrow("UNIQUE constraint failed: service_tokens.name");
    expect(await allColumns()).toHaveLength(2);
  });

  it("findByHash reads 1 row on a hit and 0 on a miss", async () => {
    const { id, token } = await new ServiceTokenStore(env.DB).create(newToken("ci"));
    await new ServiceTokenStore(env.DB).create(newToken("nightly"));
    const m = metered();
    const s = new ServiceTokenStore(m.db);
    const hash = await hashServiceToken(token);
    const hit = await s.findByHash(hash);
    expect(hit).toEqual({
      id,
      name: "ci",
      tokenHash: hash,
      ownerId: OWNER,
      graphIds: [WORK],
      access: "read",
      expiresAt: T0 + 90 * DAY,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(await s.findByHash(await hashServiceToken(generateServiceToken()))).toBeNull();
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([
      [1, 0],
      [0, 0],
    ]);
  });

  it("touch is throttled: writes 1, then 0 within the hour (reading 1), then 1 after TOUCH_INTERVAL_MS", async () => {
    const { id } = await new ServiceTokenStore(env.DB).create(newToken("ci"));
    const m = metered();
    const s = new ServiceTokenStore(m.db);
    expect(await s.touch(id, T0 + 1000)).toBe(true);
    expect(await s.touch(id, T0 + 1000 + 60_000)).toBe(false);
    // Exactly one interval later is still inside the hour (strict `<`); a millisecond more writes.
    expect(await s.touch(id, T0 + 1000 + TOUCH_INTERVAL_MS)).toBe(false);
    expect(await s.touch(id, T0 + 1000 + TOUCH_INTERVAL_MS + 1)).toBe(true);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([
      [1, 1],
      [1, 0],
      [1, 0],
      [1, 1],
    ]);
    const [row] = await allColumns();
    expect(row.last_used_at).toBe(T0 + 1000 + TOUCH_INTERVAL_MS + 1);
    expect(TOUCH_INTERVAL_MS).toBe(3_600_000);
  });

  it("two touches racing in the same hour write once (review focus 8), and an unknown id writes nothing", async () => {
    const { id } = await new ServiceTokenStore(env.DB).create(newToken("ci"));
    const a = new ServiceTokenStore(env.DB);
    const b = new ServiceTokenStore(env.DB);
    const results = await Promise.all([a.touch(id, T0 + 5), b.touch(id, T0 + 6)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await a.touch("no-such-id", T0)).toBe(false);
  });

  it("revoke writes 1 and reads 1; a second revoke changes nothing and keeps the first revoked_at", async () => {
    const { id } = await new ServiceTokenStore(env.DB).create(newToken("ci"));
    const { id: other } = await new ServiceTokenStore(env.DB).create(newToken("nightly"));
    const m = metered();
    const s = new ServiceTokenStore(m.db);
    expect(await s.revoke(id, T0 + 10)).toBe(true);
    expect(await s.revoke(id, T0 + 20)).toBe(false);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect((await s.get(id))?.revokedAt).toBe(T0 + 10);
    expect((await s.get(other))?.revokedAt).toBeNull();
    expect(await s.revoke("no-such-id", T0)).toBe(false);
  });

  it("get and list never return token_hash; list is ordered by name and reads about one row per token", async () => {
    const seed = new ServiceTokenStore(env.DB);
    const names = ["nightly", "ci", "zeta", "backup", "m-1"];
    const ids: Record<string, string> = {};
    for (const name of names) ids[name] = (await seed.create(newToken(name, { createdAt: T0 + names.indexOf(name) }))).id;
    const m = metered();
    const s = new ServiceTokenStore(m.db);
    const listed = await s.list();
    expect(listed.map((r) => r.name)).toEqual([...names].sort());
    expect(m.measured[0].rowsRead).toBeLessThanOrEqual(names.length + 1);
    expect(m.measured[0].rowsWritten).toBe(0);
    const got = await s.get(ids.ci);
    expect(got).toEqual({
      id: ids.ci,
      name: "ci",
      ownerId: OWNER,
      graphIds: [WORK],
      access: "read",
      createdAt: T0 + 1,
      expiresAt: T0 + 90 * DAY,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(m.measured[1]).toMatchObject({ rowsRead: 1, rowsWritten: 0 });
    expect(await s.get("no-such-id")).toBeNull();
    for (const row of [...listed, got]) {
      expect(Object.keys(row!)).not.toContain("tokenHash");
      expect(Object.keys(row!)).not.toContain("token_hash");
      expect(JSON.stringify(row)).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Scope: a service token's graph ids and access, applied where every tool resolves its graph.
// ---------------------------------------------------------------------------------------------

const ARCHIVE = "33333333-3333-3333-3333-333333333333";
const GONE = "44444444-4444-4444-4444-444444444444";
const B1 = "55555555-5555-4555-8555-555555555555";
const PAGE = "66666666-6666-4666-8666-666666666666";

/** A read-only token covering `work`; and a read-write one covering `work` and `archive` (connected read-only). */
const READ_CI: RequestScope = { kind: "service", name: "ci", graphIds: new Set([WORK]), access: "read" };
const WRITE_NIGHTLY: RequestScope = { kind: "service", name: "nightly", graphIds: new Set([WORK, ARCHIVE]), access: "write" };
const SERVICE_CALLER = { client: "service:ci", session: "session-ci" };

let syncCalls: { method: string; url: string }[];
/** save_file_from_url's public fetch: answered with a small text file, and counted. */
let publicFetch: MockInstance;

function graphStore(db: D1Database = env.DB): GraphStore {
  return new GraphStore(db, env.GRAPH_TOKEN_KEY);
}

/** The test env with a SYNC stub that counts calls (answering an empty page or block), and semantic search on. */
function scopeEnv(overrides: Partial<Env> = {}): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      syncCalls.push({ method: request.method, url: request.url });
      return Response.json({ uuid: PAGE, kind: "page", title: "Notes", markdown: "", "block-count": 0, truncated: false, blocks: [], missing: [] });
    },
  } as unknown as Fetcher;
  // AI and VECTORIZE only need to exist for semantic_search and semantic_index_status to be registered.
  return { ...env, SYNC: sync, AI: {} as Ai, VECTORIZE: {} as Vectorize, SEMANTIC_MAX_VECTORS: "10000", ...overrides } as Env;
}

/** One JSON-RPC call through `mcpHandler`, with the scope given or (undefined) the default. */
async function rpc(method: string, params: unknown, scope?: RequestScope, e: Env = scopeEnv()): Promise<any> {
  const request = new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ctx = createExecutionContext();
  const handler = scope === undefined ? mcpHandler(e, ctx) : mcpHandler(e, ctx, SERVICE_CALLER, scope);
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

async function call(name: string, args: Record<string, unknown>, scope?: RequestScope, e?: Env): Promise<{ isError: boolean; text: string }> {
  const result = await rpc("tools/call", { name, arguments: args }, scope, e);
  return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

async function tools(scope?: RequestScope): Promise<any[]> {
  return (await rpc("tools/list", {}, scope)).tools;
}

/**
 * The smallest arguments a JSON schema accepts: required members only, the first enum value, one
 * item for an array. Strings are a UUID, so they are accepted as ids, titles and selectors alike.
 */
function sample(schema: any, key = ""): unknown {
  if (schema === undefined || schema === null) return B1;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  for (const union of ["anyOf", "oneOf"]) if (Array.isArray(schema[union])) return sample(schema[union][0], key);
  if (Array.isArray(schema.allOf)) return sample(schema.allOf[0], key);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object" || (type === undefined && schema.properties)) {
    const out: Record<string, unknown> = {};
    for (const k of schema.required ?? []) out[k] = sample(schema.properties?.[k], k);
    return out;
  }
  if (type === "array") return [sample(schema.items, key)];
  if (type === "integer" || type === "number") return Math.max(1, schema.minimum ?? 1);
  if (type === "boolean") return true;
  if (schema.format === "uri" || key === "url") return "https://files.example.com/a.pdf";
  if (key === "fileName") return "a.md";
  if (key === "title") return "Standup";
  return B1;
}

function argsFor(tool: any, graph: string): Record<string, unknown> {
  return { ...(sample(tool.inputSchema, "") as Record<string, unknown>), graph };
}

async function auditRows(): Promise<{ tool: string; alias: string; status: string; client: string | null; error: string | null }[]> {
  return (await env.DB.prepare("SELECT tool, alias, status, client, error FROM audit_log ORDER BY id").all<any>()).results;
}

const WRITES_IN_MANIFEST = committedManifest.filter((e) => !e.annotations.readOnlyHint).map((e) => e.name).sort();

describe("scope", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.DB.exec("DELETE FROM audit_log");
    const base = { permission: "both" as const, expiresAt: null };
    await graphStore().add({ ...base, alias: "work", graphId: WORK, graphName: "Work", mode: "write", token: "logseq_pat_Work1" });
    await graphStore().add({ ...base, alias: "notes", graphId: NOTES, graphName: "Notes", mode: "write", token: "logseq_pat_Notes2" });
    await graphStore().add({ ...base, alias: "archive", graphId: ARCHIVE, graphName: "Archive", mode: "read", token: "logseq_pat_Archive3" });
    syncCalls = [];
    publicFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("a", { headers: { "Content-Type": "text/plain" } }));
  });

  afterEach(() => {
    publicFetch.mockRestore();
  });

  it("read-only scope refuses every write tool the server registers, naming the token, with 0 sync calls and a refused audit row", async () => {
    const writes = (await tools(READ_CI)).filter((t) => t.annotations?.readOnlyHint !== true);
    // Walked from the server mcpHandler builds, so a new write tool is covered without listing it here.
    expect(writes.map((t) => t.name).sort()).toEqual(WRITES_IN_MANIFEST);
    for (const tool of writes) {
      const result = await call(tool.name, argsFor(tool, "work"), READ_CI);
      expect(result, tool.name).toEqual({ isError: true, text: "graph 'work' is read-only (service token 'ci' is read-only)" });
    }
    expect(syncCalls).toEqual([]);
    expect(publicFetch).not.toHaveBeenCalled();
    const rows = await auditRows();
    expect(rows.map((r) => r.tool).sort()).toEqual(WRITES_IN_MANIFEST);
    for (const row of rows) {
      expect(row, row.tool).toEqual({
        tool: row.tool,
        alias: "work",
        status: "refused",
        client: "service:ci",
        error: "graph 'work' is read-only (service token 'ci' is read-only)",
      });
    }
  });

  it("read-only scope still reads its graph: a read tool reaches the sync server and answers", async () => {
    const result = await call("get_page", { graph: "work", "page-id": PAGE }, READ_CI);
    expect(result.isError, result.text).toBe(false);
    expect(syncCalls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("out of scope: a read and a write tool are refused listing the covered aliases; the write's audit row is refused", async () => {
    const message = "graph 'notes' is outside service token 'ci''s scope (it covers: work)";
    expect(await call("get_page", { graph: "notes", "page-id": PAGE }, READ_CI)).toEqual({ isError: true, text: message });
    expect(await call("update_block", { graph: "notes", "block-id": B1, body: { title: "x" } }, READ_CI)).toEqual({ isError: true, text: message });
    // A read-write token is refused the same way: scope comes before mode.
    expect(await call("update_block", { graph: "notes", "block-id": B1, body: { title: "x" } }, WRITE_NIGHTLY)).toEqual({
      isError: true,
      text: "graph 'notes' is outside service token 'nightly''s scope (it covers: archive, work)",
    });
    expect(syncCalls).toEqual([]);
    expect(await auditRows()).toEqual([
      { tool: "update_block", alias: "notes", status: "refused", client: "service:ci", error: message },
      {
        tool: "update_block",
        alias: "notes",
        status: "refused",
        client: "service:ci",
        error: "graph 'notes' is outside service token 'nightly''s scope (it covers: archive, work)",
      },
    ]);
  });

  it("a second lookup of an out-of-scope alias in the same call refuses too: nothing unscoped is cached (review focus 4)", async () => {
    const { access } = isolateTools(scopeEnv());
    const seen: string[] = [];
    await requestScope.run(READ_CI, () =>
      withCallGraphs(async () => {
        for (let i = 0; i < 2; i += 1) {
          try {
            await lookupGraph(access, "notes");
            seen.push("resolved");
          } catch (error) {
            seen.push((error as Error).message);
          }
        }
      }),
    );
    expect(seen).toEqual([
      "graph 'notes' is outside service token 'ci''s scope (it covers: work)",
      "graph 'notes' is outside service token 'ci''s scope (it covers: work)",
    ]);
  });

  it("every tool that takes a graph honours the scope: an out-of-scope alias reaches no sync call", async () => {
    const graphTools = (await tools(WRITE_NIGHTLY)).filter((t) => t.inputSchema.properties?.graph !== undefined);
    expect(graphTools.length).toBeGreaterThanOrEqual(committedManifest.length - 2);
    for (const tool of graphTools) {
      const result = await call(tool.name, argsFor(tool, "notes"), WRITE_NIGHTLY);
      expect(result, tool.name).toEqual({ isError: true, text: "graph 'notes' is outside service token 'nightly''s scope (it covers: archive, work)" });
    }
    expect(syncCalls).toEqual([]);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("effective mode: a read-write token on a graph connected read-only gets the plain message (review focus 6), and writes to a read-write graph", async () => {
    const update = (graph: string) => ({ graph, "block-id": B1, body: { title: "x" } });
    expect(await call("update_block", update("archive"), WRITE_NIGHTLY)).toEqual({ isError: true, text: "graph 'archive' is read-only" });
    expect(syncCalls).toEqual([]);
    // A read-only token on the same graph names itself: it lowers the mode too.
    const readArchive: RequestScope = { kind: "service", name: "ci", graphIds: new Set([ARCHIVE]), access: "read" };
    expect(await call("update_block", update("archive"), readArchive)).toEqual({
      isError: true,
      text: "graph 'archive' is read-only (service token 'ci' is read-only)",
    });
    expect(syncCalls).toEqual([]);
    const written = await call("update_block", update("work"), WRITE_NIGHTLY);
    expect(written.isError, written.text).toBe(false);
    expect(syncCalls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("scope is held by graph id: after a rename the new alias is in scope and the old one unknown (review focus 5)", async () => {
    await graphStore().update("work", { alias: "work2" });
    const read = await call("get_page", { graph: "work2", "page-id": PAGE }, READ_CI);
    expect(read.isError, read.text).toBe(false);
    expect(await call("get_page", { graph: "work", "page-id": PAGE }, READ_CI)).toEqual({
      isError: true,
      text: "unknown graph 'work' — call list_graphs for the connected aliases",
    });
    expect(await call("get_page", { graph: "notes", "page-id": PAGE }, READ_CI)).toEqual({
      isError: true,
      text: "graph 'notes' is outside service token 'ci''s scope (it covers: work2)",
    });
  });

  it("list_graphs returns only the scoped graphs with their effective mode; a deleted graph's id is ignored (review focus 7)", async () => {
    const listed = async (scope?: RequestScope) =>
      JSON.parse((await call("list_graphs", {}, scope)).text).map((g: { alias: string; mode: string }) => [g.alias, g.mode]);
    const withGone: RequestScope = { kind: "service", name: "ci", graphIds: new Set([GONE, WORK]), access: "read" };
    expect(await listed(withGone)).toEqual([["work", "read"]]);
    expect(await listed(WRITE_NIGHTLY)).toEqual([
      ["archive", "read"],
      ["work", "write"],
    ]);
    // The out-of-scope message lists only aliases that still exist.
    expect(await call("get_page", { graph: "notes", "page-id": PAGE }, withGone)).toEqual({
      isError: true,
      text: "graph 'notes' is outside service token 'ci''s scope (it covers: work)",
    });
    // Every id gone: nothing listed, and the message says so.
    const allGone: RequestScope = { kind: "service", name: "ci", graphIds: new Set([GONE]), access: "read" };
    expect(await listed(allGone)).toEqual([]);
    expect(await call("get_page", { graph: "work", "page-id": PAGE }, allGone)).toEqual({
      isError: true,
      text: "graph 'work' is outside service token 'ci''s scope (it covers: none)",
    });
    expect(syncCalls).toEqual([]);
  });

  it("what already works still works in scope: every read tool under a read-only token, every write and a re-send under a read-write one", async () => {
    const SCOPE_REFUSAL = /is read-only|outside service token|unknown graph|no request scope/;
    const listed = await tools(READ_CI);
    const reads = listed.filter((t) => t.annotations?.readOnlyHint === true && t.inputSchema.properties?.graph !== undefined);
    expect(reads.length).toBeGreaterThan(15);
    for (const tool of reads) {
      // The stub's answers don't fit every read (and AI is a stub), so a read may still fail; never for its scope.
      const result = await call(tool.name, argsFor(tool, "work"), READ_CI);
      expect(result.text, tool.name).not.toMatch(SCOPE_REFUSAL);
    }
    const writes = (await tools(WRITE_NIGHTLY)).filter((t) => t.annotations?.readOnlyHint !== true);
    expect(writes.map((t) => t.name).sort()).toEqual(WRITES_IN_MANIFEST);
    for (const tool of writes) {
      const result = await call(tool.name, argsFor(tool, "work"), WRITE_NIGHTLY);
      expect(result.text, tool.name).not.toMatch(SCOPE_REFUSAL);
    }
    // The same write sent twice in a row, under the same token, is written twice.
    syncCalls = [];
    for (let i = 0; i < 2; i += 1) {
      const again = await call("update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, WRITE_NIGHTLY);
      expect(again.isError, again.text).toBe(false);
    }
    expect(syncCalls.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["PATCH", "PATCH"]);
  });

  it("the order of a token's graph ids never matters: list_graphs and the covered list are ordered by alias", async () => {
    const forward: RequestScope = { kind: "service", name: "nightly", graphIds: new Set([WORK, ARCHIVE]), access: "write" };
    const reversed: RequestScope = { kind: "service", name: "nightly", graphIds: new Set([ARCHIVE, WORK]), access: "write" };
    for (const scope of [forward, reversed]) {
      const graphs = JSON.parse((await call("list_graphs", {}, scope)).text).map((g: { alias: string }) => g.alias);
      expect(graphs).toEqual(["archive", "work"]);
      expect((await call("get_page", { graph: "notes", "page-id": PAGE }, scope)).text).toBe(
        "graph 'notes' is outside service token 'nightly''s scope (it covers: archive, work)",
      );
    }
  });

  it("OAuth unchanged: mcpHandler with no scope lists every graph with its own mode and writes to any read-write graph", async () => {
    const graphs = JSON.parse((await call("list_graphs", {})).text).map((g: { alias: string; mode: string }) => [g.alias, g.mode]);
    expect(graphs).toEqual([
      ["archive", "read"],
      ["notes", "write"],
      ["work", "write"],
    ]);
    const written = await call("update_block", { graph: "notes", "block-id": B1, body: { title: "x" } });
    expect(written.isError, written.text).toBe(false);
    expect(await call("update_block", { graph: "archive", "block-id": B1, body: { title: "x" } })).toEqual({
      isError: true,
      text: "graph 'archive' is read-only",
    });
    // The explicit OAuth scope is the default.
    const explicit = await call("get_page", { graph: "notes", "page-id": PAGE }, { kind: "oauth" });
    expect(explicit.isError, explicit.text).toBe(false);
  });

  it("fail closed: the isolate's access.resolve outside requestScope.run throws rather than resolving unscoped", async () => {
    const { access } = isolateTools(scopeEnv());
    await expect(access.resolve("work")).rejects.toThrow("no request scope");
    await expect(requestScope.run({ kind: "oauth" }, () => access.resolve("work"))).resolves.toMatchObject({ graphId: WORK, mode: "write" });
  });

  it("cost: an in-scope call reads the same D1 rows as under OAuth; only the refusal adds the alias read", async () => {
    const run = async (args: Record<string, unknown>, scope?: RequestScope) => {
      const { db, measured } = meteredFirst();
      await call("get_page", args, scope, scopeEnv({ DB: db }));
      return measured.map((m) => [m.sql.replace(/\s+/g, " ").trim(), m.rowsRead, m.rowsWritten]);
    };
    const inScope = { graph: "work", "page-id": PAGE };
    expect(await run(inScope, READ_CI)).toEqual(await run(inScope));
    const outOfScope = { graph: "notes", "page-id": PAGE };
    const oauth = await run(outOfScope);
    const refused = await run(outOfScope, READ_CI);
    // OAuth reads the graph row once (a read records no use).
    expect(oauth.map(([sql]) => sql)).toEqual([expect.stringMatching(/^SELECT graph_id, mode, token_ct/)]);
    expect(refused).toEqual([oauth[0], [expect.stringMatching(/^SELECT alias FROM graphs WHERE graph_id IN \(\?\) ORDER BY alias$/), 1, 0]]);
  });
});

/** `metered`, also answering `first` from `all` so `GraphStore.resolve` is counted from the same meta. */
function meteredFirst(): { db: D1Database; measured: Measured[] } {
  const measured: Measured[] = [];
  const statement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => statement(stmt.bind(...values), sql),
      run: async () => record(sql, await stmt.run()),
      all: async () => record(sql, await stmt.all()),
      first: async (column?: string) => {
        const row = (record(sql, await stmt.all()).results[0] ?? null) as Record<string, unknown> | null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      raw: () => {
        throw new Error("raw() has no meta");
      },
    }) as unknown as D1PreparedStatement;
  const record = <T extends D1Result>(sql: string, result: T): T => {
    measured.push({ sql, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    return result;
  };
  return { db: { prepare: (sql: string) => statement(env.DB.prepare(sql), sql) } as unknown as D1Database, measured };
}
