import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import committedManifest from "../tools-manifest.json";
import {
  generateServiceToken,
  hashServiceToken,
  MODE_RANK,
  rank,
  type ServiceTokenAccess,
  ServiceTokenStore,
  TOKEN_PATTERN,
  type TokenScope,
  TOUCH_INTERVAL_MS,
} from "../src/auth/service-tokens";
import { timingSafeEqual } from "../src/crypto";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { type ServiceProps, isolateTools, mcpApiHandler, mcpHandler } from "../src/mcp";
import { type RequestScope, lookupGraph, requestScope, withCallGraphs } from "../src/tools/common";
import { ALWAYS_DELETE, DRY_RUN_TOOLS, deleteReason } from "../src/tools/deletes.mjs";

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
/** The access CHECK as the latest migration (0008) left it; the 0006 block runs against that table. */
const ACCESS_CHECK = "access = 'read' OR access = 'write-no-delete' OR access = 'write'";
/** Migration 0008's statements' [rows read, rows written] with two rows, measured from D1 meta (the header quotes it). */
const MIGRATION_0008_COST: [number, number][] = [
  [1, 4], // CREATE TABLE service_tokens_new
  [2, 6], // INSERT ... SELECT: each row and its primary-key and name index entries
  [27, 0], // DROP TABLE service_tokens
  [86, 12], // ALTER TABLE ... RENAME: schema rows rewritten
  [6, 3], // CREATE UNIQUE INDEX service_tokens_hash
];

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
    ["access 'admin'", { access: "admin" }, ACCESS_CHECK],
    ["access ''", { access: "" }, ACCESS_CHECK],
    ["access 'READ'", { access: "READ" }, ACCESS_CHECK],
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
      updatedAt: null,
    });
    expect(listed.every((r) => r.updatedAt === null)).toBe(true);
    expect(m.measured[1]).toMatchObject({ rowsRead: 1, rowsWritten: 0 });
    expect(await s.get("no-such-id")).toBeNull();
    for (const row of [...listed, got]) {
      expect(Object.keys(row!)).not.toContain("tokenHash");
      expect(Object.keys(row!)).not.toContain("token_hash");
      expect(JSON.stringify(row)).not.toMatch(/[0-9a-f]{64}/);
    }
  });
});

/** Migration files as the tests apply them (vitest.config.ts injects TEST_MIGRATIONS). */
function migration(prefix: string): string[] {
  const all = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  const found = all.find((m) => m.name.startsWith(prefix));
  if (!found) throw new Error(`no migration ${prefix}`);
  return found.queries;
}

describe("migration 0007", () => {
  it("applies right after 0006 and adds updated_at as a nullable INTEGER with no default", async () => {
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map(
      (r) => r.name,
    );
    expect(applied.indexOf("0007_service_token_updated_at.sql")).toBe(applied.indexOf("0006_service_tokens.sql") + 1);
    const columns = (
      await env.DB.prepare("PRAGMA table_info(service_tokens)").all<{ name: string; type: string; notnull: number; dflt_value: unknown }>()
    ).results;
    expect(columns.find((c) => c.name === "updated_at")).toEqual(
      expect.objectContaining({ name: "updated_at", type: "INTEGER", notnull: 0, dflt_value: null }),
    );
  });

  it("keeps every value of a row that existed before it, and that row reads updated_at NULL", async () => {
    // Rebuild service_tokens as 0006 left it, holding a row the Worker wrote before 0007, then apply 0007.
    const { id, token } = await new ServiceTokenStore(env.DB).create(newToken("ci", { graphIds: [NOTES, WORK], access: "write" }));
    await new ServiceTokenStore(env.DB).touch(id, T0 + 5);
    await new ServiceTokenStore(env.DB).revoke(id, T0 + 6);
    const COLUMNS_0006 = "id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at";
    const old = (await env.DB.prepare(`SELECT ${COLUMNS_0006} FROM service_tokens`).all<Record<string, unknown>>()).results[0];
    await env.DB.exec("DROP TABLE service_tokens");
    for (const query of migration("0006_")) await env.DB.prepare(query).run();
    await env.DB.prepare(`INSERT INTO service_tokens (${COLUMNS_0006}) VALUES (${COLUMNS_0006.split(", ").map(() => "?").join(", ")})`)
      .bind(...COLUMNS_0006.split(", ").map((c) => old[c] ?? null))
      .run();
    for (const query of migration("0007_")) await env.DB.prepare(query).run();
    const rows = await allColumns();
    expect(rows).toEqual([{ ...old, updated_at: null }]);
    const s = new ServiceTokenStore(env.DB);
    expect(await s.get(id)).toMatchObject({ graphIds: [NOTES, WORK], lastUsedAt: T0 + 5, revokedAt: T0 + 6, updatedAt: null });
    expect((await s.findByHash(await hashServiceToken(token)))?.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------------------------
// Migration 0008: service_tokens rebuilt so access may also be 'write-no-delete'.
// ---------------------------------------------------------------------------------------------

const COLUMNS_0007 = "id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at";

/** Rows as a deployed 0007 table could hold them: every nullable column set, and one left null. */
const ROWS_0007: Record<string, unknown>[] = [
  { id: "id-read", name: "ci", token_hash: "a".repeat(64), owner_id: OWNER, graph_ids: JSON.stringify([WORK]), access: "read", created_at: T0, expires_at: T0 + 90 * DAY, last_used_at: T0 + 5, revoked_at: T0 + 6, updated_at: T0 + 4 },
  { id: "id-write", name: "nightly", token_hash: "b".repeat(64), owner_id: OWNER, graph_ids: JSON.stringify([NOTES, WORK]), access: "write", created_at: T0 + 1, expires_at: T0 + 30 * DAY, last_used_at: T0 + 7, revoked_at: T0 + 8, updated_at: T0 + 9 },
];
const ROW_UNUSED = { id: "id-unused", name: "backup", token_hash: "c".repeat(64), owner_id: OWNER, graph_ids: "[]", access: "write", created_at: T0, expires_at: T0 + 1, last_used_at: null, revoked_at: null, updated_at: null };

/** Rebuilds service_tokens as 0006 and 0007 left it (not as 0008 does), holding `rows`. */
async function rebuildAs0007(rows: Record<string, unknown>[]) {
  await env.DB.exec("DROP TABLE service_tokens");
  for (const query of [...migration("0006_"), ...migration("0007_")]) await env.DB.prepare(query).run();
  const cols = COLUMNS_0007.split(", ");
  for (const row of rows) {
    await env.DB.prepare(`INSERT INTO service_tokens (${COLUMNS_0007}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => row[c] ?? null))
      .run();
  }
}

/** Applies 0008 to the table as it stands, statement by statement, and returns each statement's D1 cost. */
async function apply0008(): Promise<[number, number][]> {
  const cost: [number, number][] = [];
  for (const query of migration("0008_")) {
    const { meta } = await env.DB.prepare(query).run();
    cost.push([meta.rows_read, meta.rows_written]);
  }
  return cost;
}

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

async function tableInfo(): Promise<ColumnInfo[]> {
  return (await env.DB.prepare("PRAGMA table_info(service_tokens)").all<ColumnInfo>()).results;
}

/** Each index as (origin, unique, columns), plus its name unless SQLite named it (autoindex names follow the table). */
async function indexes(): Promise<{ name: string; origin: string; unique: number; columns: string[] }[]> {
  const list = (await env.DB.prepare("PRAGMA index_list(service_tokens)").all<{ name: string; origin: string; unique: number }>()).results;
  const out = [];
  for (const index of list) {
    const columns = (await env.DB.prepare(`PRAGMA index_info(${index.name})`).all<{ name: string }>()).results.map((c) => c.name);
    out.push({ name: index.name.startsWith("sqlite_autoindex_") ? "(auto)" : index.name, origin: index.origin, unique: index.unique, columns });
  }
  return out.sort((a, b) => a.columns.join().localeCompare(b.columns.join()));
}

const ACCESS_CHECK_0008 = "access = 'read' OR access = 'write-no-delete' OR access = 'write'";

describe("migration 0008", () => {
  it("applies right after 0007", async () => {
    const applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map(
      (r) => r.name,
    );
    expect(applied.indexOf("0008_service_token_write_no_delete.sql")).toBe(applied.indexOf("0007_service_token_updated_at.sql") + 1);
  });

  it("keeps every value of every read and write row, updated_at, last_used_at and revoked_at included", async () => {
    await rebuildAs0007([...ROWS_0007, ROW_UNUSED]);
    const before = (await env.DB.prepare(`SELECT ${COLUMNS_0007} FROM service_tokens ORDER BY id`).all()).results;
    expect(before).toHaveLength(3);
    await apply0008();
    const after = (await env.DB.prepare("SELECT * FROM service_tokens ORDER BY id").all()).results;
    expect(after).toEqual(before);
    // The column order of SELECT * is unchanged, so toRow and PUBLIC_COLUMNS see the same row.
    expect(after.map((r) => Object.keys(r))).toEqual(before.map(() => COLUMNS_0007.split(", ")));
    const s = new ServiceTokenStore(env.DB);
    expect(await s.get("id-read")).toMatchObject({ access: "read", lastUsedAt: T0 + 5, revokedAt: T0 + 6, updatedAt: T0 + 4 });
    expect(await s.get("id-write")).toMatchObject({ access: "write", graphIds: [NOTES, WORK], lastUsedAt: T0 + 7, revokedAt: T0 + 8, updatedAt: T0 + 9 });
    expect((await s.findByHash("b".repeat(64)))?.id).toBe("id-write");
  });

  it("keeps the same columns in the same order, and the same indexes, as 0006 plus 0007", async () => {
    await rebuildAs0007([]);
    const columnsBefore = await tableInfo();
    const indexesBefore = await indexes();
    await apply0008();
    expect(await tableInfo()).toEqual(columnsBefore);
    expect(columnsBefore.map((c) => c.name).join(", ")).toBe(COLUMNS_0007);
    expect(await indexes()).toEqual(indexesBefore);
    expect(indexesBefore).toEqual([
      { name: "(auto)", origin: "pk", unique: 1, columns: ["id"] },
      { name: "(auto)", origin: "u", unique: 1, columns: ["name"] },
      { name: "service_tokens_hash", origin: "c", unique: 1, columns: ["token_hash"] },
    ]);
  });

  it("takes write-no-delete beside read and write, and its CHECK refuses anything else", async () => {
    await rawInsert({ access: "read", token_hash: "1".repeat(64) });
    await rawInsert({ access: "write-no-delete", token_hash: "2".repeat(64) });
    await rawInsert({ access: "write", token_hash: "3".repeat(64) });
    expect((await allColumns()).map((r) => r.access).sort()).toEqual(["read", "write", "write-no-delete"]);
    for (const access of ["delete", "", "Write-No-Delete", "write-no-deletes", "write no delete", "write-no-delete ", "no-delete", "1"]) {
      await expect(rawInsert({ access, token_hash: "4".repeat(64) }), access).rejects.toThrow(`CHECK constraint failed: ${ACCESS_CHECK_0008}`);
    }
    expect(await allColumns()).toHaveLength(3);
  });

  it("refuses a duplicate token_hash and a duplicate name after the rebuild", async () => {
    await rebuildAs0007(ROWS_0007);
    await apply0008();
    await expect(rawInsert({ name: "other", token_hash: "a".repeat(64) })).rejects.toThrow("UNIQUE constraint failed: service_tokens.token_hash");
    await expect(rawInsert({ name: "ci", token_hash: "f".repeat(64) })).rejects.toThrow("UNIQUE constraint failed: service_tokens.name");
    expect(await allColumns()).toHaveLength(2);
  });

  it("cost: measured from D1 meta with two rows, as the migration's header records", async () => {
    await rebuildAs0007(ROWS_0007);
    // CREATE, INSERT ... SELECT, DROP, RENAME, CREATE UNIQUE INDEX.
    expect(await apply0008()).toEqual(MIGRATION_0008_COST);
  });
});

describe("ServiceTokenAccess and rank", () => {
  it("ranks read < write-no-delete < write, and MODE_RANK has exactly those keys", () => {
    expect(Object.keys(MODE_RANK)).toEqual(["read", "write-no-delete", "write"]);
    expect(rank("read")).toBeLessThan(rank("write-no-delete"));
    expect(rank("write-no-delete")).toBeLessThan(rank("write"));
  });

  it("an unknown access has no rank: it throws rather than ranking as anything", () => {
    for (const access of ["delete", "", "WRITE", "toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(() => rank(access as ServiceTokenAccess), access).toThrow(`unknown service token access '${access}'`);
    }
  });

  it("the store round-trips write-no-delete through create, get, list and update; findByHash still reads 1 and writes 0", async () => {
    const s = new ServiceTokenStore(env.DB);
    const { id, token } = await s.create(newToken("worker", { access: "write-no-delete" }));
    expect((await s.get(id))?.access).toBe("write-no-delete");
    expect((await s.list()).map((r) => [r.name, r.access])).toEqual([["worker", "write-no-delete"]]);
    const m = metered();
    expect((await new ServiceTokenStore(m.db).findByHash(await hashServiceToken(token)))?.access).toBe("write-no-delete");
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[1, 0]]);
    // Replace-style edits through the guarded UPDATE: down to write-no-delete, up to write, and back.
    const base = { graphIds: [WORK], expiresAt: T0 + 90 * DAY };
    expect(await s.update(id, { ...base, access: "write-no-delete" }, { ...base, access: "write" }, T0 + 1)).toBe(true);
    expect(await s.update(id, { ...base, access: "write" }, { ...base, access: "write-no-delete" }, T0 + 2)).toBe(true);
    expect(await s.update(id, { ...base, access: "write-no-delete" }, { ...base, access: "read" }, T0 + 3)).toBe(true);
    expect(await s.update(id, { ...base, access: "read" }, { ...base, access: "write-no-delete" }, T0 + 4)).toBe(true);
    // A re-send of the stored values still applies.
    expect(await s.update(id, { ...base, access: "write-no-delete" }, { ...base, access: "write-no-delete" }, T0 + 5)).toBe(true);
    expect(await s.get(id)).toMatchObject({ access: "write-no-delete", updatedAt: T0 + 5 });
  });
});

describe("ServiceTokenStore.update", () => {
  const NOW = T0 + DAY;
  const ARCHIVE_ID = "33333333-3333-3333-3333-333333333333";

  function scope(row: { graphIds: string[]; access: ServiceTokenAccess; expiresAt: number }): TokenScope {
    return { graphIds: [...row.graphIds], access: row.access, expiresAt: row.expiresAt };
  }

  async function hashOf(id: string): Promise<unknown> {
    return (await env.DB.prepare("SELECT token_hash FROM service_tokens WHERE id = ?").bind(id).all()).results[0]?.token_hash;
  }

  /** A write token on WORK and NOTES, as the wizard would create it; and its scope as `get` reads it. */
  async function seed(overrides: Partial<Parameters<ServiceTokenStore["create"]>[0]> = {}) {
    const created = await new ServiceTokenStore(env.DB).create(
      newToken("ci", { graphIds: [WORK, NOTES], access: "write", ...overrides }),
    );
    const row = (await new ServiceTokenStore(env.DB).get(created.id))!;
    return { ...created, row, before: scope(row), hash: await hashOf(created.id) };
  }

  /** The hash is untouched, and the token from `create` still finds its own row by hash. */
  async function expectSameToken(id: string, token: string, hash: unknown) {
    expect(await hashOf(id)).toBe(hash);
    expect(hash).toBe(await hashServiceToken(token));
    expect((await new ServiceTokenStore(env.DB).findByHash(await hashServiceToken(token)))?.id).toBe(id);
  }

  it("applies a new scope, stamps updated_at, keeps token_hash, and reads 1 and writes 1", async () => {
    const t = await seed();
    const m = metered();
    const after: TokenScope = { graphIds: [NOTES], access: "read", expiresAt: t.row.expiresAt - DAY };
    expect(await new ServiceTokenStore(m.db).update(t.id, t.before, after, NOW)).toBe(true);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[1, 1]]);
    expect(m.measured[0].sql).not.toContain("token_hash");
    expect(await new ServiceTokenStore(env.DB).get(t.id)).toEqual({ ...t.row, ...after, updatedAt: NOW });
    await expectSameToken(t.id, t.token, t.hash);
    for (const value of Object.values((await allColumns())[0])) expect(String(value)).not.toContain(t.token);
  });

  it("stores the graphs in the order given (reversed, a swap, a widening): the order is the caller's", async () => {
    const t = await seed();
    const s = new ServiceTokenStore(env.DB);
    let before = t.before;
    for (const graphIds of [[NOTES, WORK], [WORK, NOTES], [ARCHIVE_ID, NOTES, WORK], [WORK]]) {
      const after = { ...before, graphIds };
      expect(await s.update(t.id, before, after, NOW + graphIds.length)).toBe(true);
      expect((await s.get(t.id))?.graphIds).toEqual(graphIds);
      before = after;
    }
    await expectSameToken(t.id, t.token, t.hash);
  });

  it("a chain of edits each applies from the last stored values; replaying an earlier edit misses", async () => {
    const t = await seed();
    const s = new ServiceTokenStore(env.DB);
    const first: TokenScope = { ...t.before, graphIds: [WORK] };
    const second: TokenScope = { ...first, access: "read" };
    const third: TokenScope = { ...second, expiresAt: second.expiresAt - DAY };
    expect(await s.update(t.id, t.before, first, NOW + 1)).toBe(true);
    expect(await s.update(t.id, first, second, NOW + 2)).toBe(true);
    expect(await s.update(t.id, second, third, NOW + 3)).toBe(true);
    // The first edit again (a second tab), and the steps out of order: each guard sees newer values.
    const m = metered();
    const stale = new ServiceTokenStore(m.db);
    expect(await stale.update(t.id, t.before, first, NOW + 4)).toBe(false);
    expect(await stale.update(t.id, first, second, NOW + 5)).toBe(false);
    expect(await stale.update(t.id, second, third, NOW + 6)).toBe(false);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(await s.get(t.id)).toEqual({ ...t.row, ...third, updatedAt: NOW + 3 });
    await expectSameToken(t.id, t.token, t.hash);
  });

  it("a re-send of the stored values (after equal to before) still applies and stamps updated_at", async () => {
    const t = await seed();
    const s = new ServiceTokenStore(env.DB);
    expect(await s.update(t.id, t.before, t.before, NOW)).toBe(true);
    expect(await s.update(t.id, t.before, t.before, NOW + 1)).toBe(true);
    expect(await s.get(t.id)).toEqual({ ...t.row, updatedAt: NOW + 1 });
    await expectSameToken(t.id, t.token, t.hash);
  });

  it("applies a millisecond before expiry, on a token already used and one already edited", async () => {
    const t = await seed();
    const s = new ServiceTokenStore(env.DB);
    await s.touch(t.id, NOW);
    const after = { ...t.before, access: "read" as const };
    expect(await s.update(t.id, t.before, after, t.row.expiresAt - 1)).toBe(true);
    expect(await s.get(t.id)).toEqual({ ...t.row, ...after, lastUsedAt: NOW, updatedAt: t.row.expiresAt - 1 });
  });

  const misses: [string, (t: Awaited<ReturnType<typeof seed>>) => Promise<{ before: TokenScope; now?: number }>][] = [
    ["revoked", async (t) => (await new ServiceTokenStore(env.DB).revoke(t.id, NOW - 1), { before: t.before })],
    ["expired exactly now", async (t) => ({ before: t.before, now: t.row.expiresAt })],
    ["expired a millisecond ago", async (t) => ({ before: t.before, now: t.row.expiresAt + 1 })],
    ["stored graphs differ (another graph)", async (t) => ({ before: { ...t.before, graphIds: [WORK] } })],
    ["stored graphs differ (the same graphs in another order)", async (t) => ({ before: { ...t.before, graphIds: [NOTES, WORK] } })],
    ["stored graphs differ (a duplicate)", async (t) => ({ before: { ...t.before, graphIds: [WORK, NOTES, NOTES] } })],
    ["stored access differs", async (t) => ({ before: { ...t.before, access: "read" } })],
    ["stored expiry differs (later)", async (t) => ({ before: { ...t.before, expiresAt: t.before.expiresAt + 1 } })],
    ["stored expiry differs (earlier)", async (t) => ({ before: { ...t.before, expiresAt: t.before.expiresAt - 1 } })],
  ];

  it.each(misses)("fails closed when %s: false, reads 1, writes 0, the row and hash unchanged", async (_label, arrange) => {
    const t = await seed();
    const { before, now = NOW } = await arrange(t);
    const stored = await allColumns();
    const after: TokenScope = { graphIds: [WORK], access: "read", expiresAt: Math.min(before.expiresAt, t.before.expiresAt) - DAY };
    const m = metered();
    expect(await new ServiceTokenStore(m.db).update(t.id, before, after, now)).toBe(false);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[1, 0]]);
    expect(await allColumns()).toEqual(stored);
    await expectSameToken(t.id, t.token, t.hash);
  });

  it("an unknown id reads 0 and writes 0, and leaves other rows alone", async () => {
    const t = await seed();
    const stored = await allColumns();
    const m = metered();
    const after = { ...t.before, access: "read" as const };
    expect(await new ServiceTokenStore(m.db).update(crypto.randomUUID(), t.before, after, NOW)).toBe(false);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[0, 0]]);
    expect(await allColumns()).toEqual(stored);
  });

  it("only the named row changes when another token holds the same scope", async () => {
    const t = await seed();
    const other = await new ServiceTokenStore(env.DB).create(newToken("nightly", { graphIds: [WORK, NOTES], access: "write" }));
    const otherBefore = (await allColumns()).find((r) => r.id === other.id);
    expect(await new ServiceTokenStore(env.DB).update(t.id, t.before, { ...t.before, access: "read" }, NOW)).toBe(true);
    expect((await allColumns()).find((r) => r.id === other.id)).toEqual(otherBefore);
  });

  it("never extends expiry: a later after.expiresAt throws before any statement; an equal or earlier one is allowed", async () => {
    const t = await seed();
    const stored = await allColumns();
    const m = metered();
    const s = new ServiceTokenStore(m.db);
    for (const later of [t.before.expiresAt + 1, t.before.expiresAt + 365 * DAY]) {
      await expect(s.update(t.id, t.before, { ...t.before, graphIds: [WORK], expiresAt: later }, NOW)).rejects.toThrow(
        /expir/,
      );
    }
    // Even when the guard would miss anyway (stale before), the assertion answers first.
    const staleBefore = { ...t.before, expiresAt: t.before.expiresAt - DAY };
    await expect(s.update(t.id, staleBefore, { ...staleBefore, expiresAt: staleBefore.expiresAt + 1 }, NOW)).rejects.toThrow(
      /expir/,
    );
    expect(m.measured).toEqual([]);
    expect(await allColumns()).toEqual(stored);
    expect(await s.update(t.id, t.before, { ...t.before, graphIds: [WORK] }, NOW)).toBe(true);
    const shorter = { graphIds: [WORK], access: "write" as const, expiresAt: t.before.expiresAt - 1 };
    expect(await s.update(t.id, { ...t.before, graphIds: [WORK] }, shorter, NOW + 1)).toBe(true);
    expect(await new ServiceTokenStore(env.DB).get(t.id)).toEqual({ ...t.row, ...shorter, updatedAt: NOW + 1 });
    await expectSameToken(t.id, t.token, t.hash);
  });

  it("findByHash still reads 1 and writes 0 on a hit after 0007 and after an update", async () => {
    const t = await seed();
    await new ServiceTokenStore(env.DB).update(t.id, t.before, { ...t.before, access: "read" }, NOW);
    const m = metered();
    const hit = await new ServiceTokenStore(m.db).findByHash(await hashServiceToken(t.token));
    expect(hit).toMatchObject({ id: t.id, access: "read", graphIds: [WORK, NOTES] });
    expect(Object.keys(hit!)).not.toContain("updatedAt");
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[1, 0]]);
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

  it("read-only scope reads the favourites list: list_favorites reaches the sync server with one GET and writes no audit row", async () => {
    const result = await call("list_favorites", { graph: "work" }, READ_CI);
    expect(result.isError, result.text).toBe(false);
    expect(syncCalls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([["GET", `/api/v1/graphs/${WORK}/favorites`]]);
    expect(await auditRows()).toEqual([]);
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

// ---------------------------------------------------------------------------------------------
// HTTP: a service token through the real provider (createConnector().fetch) to /mcp.
// ---------------------------------------------------------------------------------------------

/** OWNER_GITHUB_USER_ID in wrangler.test.jsonc. */
const HTTP_OWNER = 1001;
const GENERIC = { error: "invalid_token", error_description: "Invalid access token" };

interface HttpSyncCall {
  method: string;
  url: string;
  stamp: string | null;
}

let httpSync: HttpSyncCall[];
let httpConsole: MockInstance[];

/** Every statement whose SQL matches `filter` is run through `meta`; others go to the real binding untouched. */
function meter(
  filter: RegExp,
  base: D1Database = env.DB,
  alter: (sql: string, result: D1Result) => D1Result = (_sql, r) => r,
): { db: D1Database; measured: Measured[] } {
  const measured: Measured[] = [];
  const record = <T extends D1Result>(sql: string, result: T): T => {
    measured.push({ sql: sql.replace(/\s+/g, " ").trim(), rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    return alter(sql, result) as T;
  };
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
  const db = new Proxy(base, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => (filter.test(sql) ? statement(target.prepare(sql), sql) : target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, measured };
}

function httpEnv(overrides: Partial<Env> = {}): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      httpSync.push({ method: request.method, url: request.url, stamp: request.headers.get("x-logseq-edit-stamp") });
      return Response.json({ uuid: PAGE, kind: "page", title: "Notes", markdown: "", "block-count": 0, truncated: false, blocks: [], missing: [] });
    },
  } as unknown as Fetcher;
  // AI and VECTORIZE only need to exist for the semantic tools to be registered.
  return { ...env, SYNC: sync, AI: {} as Ai, VECTORIZE: {} as Vectorize, SEMANTIC_MAX_VECTORS: "10000", ...overrides } as Env;
}

interface HttpResult {
  status: number;
  headers: [string, string][];
  body: string;
  json: any;
}

/** One JSON-RPC request to https://mcp.example.com/mcp through the real Worker, with `bearer`. */
async function post(
  bearer: string,
  method: string,
  params: unknown = {},
  { e = httpEnv(), session }: { e?: Env; session?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (session) headers["mcp-session-id"] = session;
  const request = new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const connector = createConnector({ githubFetch: () => Promise.reject(new Error("no GitHub in tests")) });
  const ctx = createExecutionContext();
  const res = await connector.fetch!(request as Request<unknown, IncomingRequestCfProperties>, e, ctx);
  await waitOnExecutionContext(ctx);
  const body = await res.text();
  let json: any = null;
  if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
    json = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .find((msg) => msg.id === 1);
  } else if (body) {
    json = JSON.parse(body);
  }
  return { status: res.status, headers: [...res.headers], body, json };
}

async function httpCall(bearer: string, name: string, args: Record<string, unknown>, opts: { e?: Env; session?: string } = {}) {
  const res = await post(bearer, "tools/call", { name, arguments: args }, opts);
  expect(res.status, res.body).toBe(200);
  const result = res.json.result;
  return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

function consoleText(): string {
  return httpConsole.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" ")).join("\n");
}

/** The token is nowhere in a response or the console: not whole, and not its secret part. */
function expectNoToken(res: HttpResult, token: string) {
  const secret = token.startsWith("lsct_") && token.length > 20 ? token.slice(5) : token;
  for (const text of [res.body, JSON.stringify(res.headers), consoleText()]) {
    expect(text).not.toContain(token);
    expect(text).not.toContain(secret);
  }
}

async function makeToken(name: string, overrides: Partial<Parameters<ServiceTokenStore["create"]>[0]> = {}) {
  const now = Date.now();
  return new ServiceTokenStore(env.DB).create({
    name,
    ownerId: HTTP_OWNER,
    graphIds: [WORK],
    access: "write",
    createdAt: now - DAY,
    expiresAt: now + 90 * DAY,
    ...overrides,
  });
}

async function lastUsed(id: string): Promise<number | null> {
  return (await new ServiceTokenStore(env.DB).get(id))!.lastUsedAt;
}

describe("HTTP", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.DB.exec("DELETE FROM audit_log");
    const base = { permission: "both" as const, expiresAt: null };
    await graphStore().add({ ...base, alias: "work", graphId: WORK, graphName: "Work", mode: "write", token: "logseq_pat_Work1" });
    await graphStore().add({ ...base, alias: "notes", graphId: NOTES, graphName: "Notes", mode: "write", token: "logseq_pat_Notes2" });
    httpSync = [];
    httpConsole = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  });

  afterEach(() => {
    for (const spy of httpConsole) spy.mockRestore();
    vi.restoreAllMocks();
  });

  it("a valid read-write token reaches initialize and tools/list at /mcp", async () => {
    const { token } = await makeToken("ci");
    const init = await post(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status, init.body).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("logseq-connector");
    const listed = await post(token, "tools/list");
    expect(listed.status, listed.body).toBe(200);
    expect(listed.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(committedManifest.map((t) => t.name).sort());
    expectNoToken(init, token);
    expectNoToken(listed, token);
  });

  it("an unknown token of the right shape, a malformed bearer and a:b:c get the generic 401; none reads a D1 row", async () => {
    await makeToken("ci");
    for (const bearer of [generateServiceToken(), `lsct_${"A".repeat(42)}`, "lsct_short", "not-a-token", "a:b:c", `lsct_${"A".repeat(43)}:x:y`]) {
      const m = meter(/./);
      const res = await post(bearer, "tools/list", {}, { e: httpEnv({ DB: m.db }) });
      expect(res.status, bearer).toBe(401);
      expect(res.json, bearer).toEqual(GENERIC);
      // A right-shaped token is looked up by hash (a miss reads 0 rows); anything else never reaches D1.
      const expected = TOKEN_PATTERN.test(bearer) ? [[expect.stringMatching(/FROM service_tokens WHERE token_hash = \?$/), 0, 0]] : [];
      expect(m.measured.map((x) => [x.sql, x.rowsRead, x.rowsWritten]), bearer).toEqual(expected);
      expectNoToken(res, bearer);
    }
    expect(httpSync).toEqual([]);
  });

  it("revoked, expired and previous-owner tokens get 401 naming the reason and the token; the token is in no output", async () => {
    const now = Date.now();
    const revoked = await makeToken("ci");
    await new ServiceTokenStore(env.DB).revoke(revoked.id, now - 1000);
    const expiresAt = Date.UTC(2026, 0, 2, 3, 4, 5);
    const expired = await makeToken("nightly", { createdAt: expiresAt - DAY, expiresAt });
    const previous = await makeToken("backup", { ownerId: 2002 });
    const cases: [string, string][] = [
      [revoked.token, "service token 'ci' was revoked"],
      [expired.token, "service token 'nightly' expired on 2026-01-02"],
      [previous.token, "service token 'backup' belongs to a previous owner"],
    ];
    for (const [token, description] of cases) {
      const res = await post(token, "tools/list");
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: "invalid_token", error_description: description });
      expect(new Headers(res.headers).get("WWW-Authenticate")).toContain('error="invalid_token"');
      expectNoToken(res, token);
    }
    expect(httpSync).toEqual([]);
    // Nothing refused is recorded as used.
    for (const { id } of [revoked, expired, previous]) expect(await lastUsed(id)).toBeNull();
  });

  it("reasons come in order: revoked before expired before previous owner", async () => {
    const now = Date.now();
    const all = await makeToken("ci", { ownerId: 2002, createdAt: now - 2 * DAY, expiresAt: now - DAY });
    await new ServiceTokenStore(env.DB).revoke(all.id, now - 1000);
    expect((await post(all.token, "tools/list")).json.error_description).toBe("service token 'ci' was revoked");
    const expiredOther = await makeToken("nightly", { ownerId: 2002, createdAt: Date.UTC(2026, 0, 1), expiresAt: Date.UTC(2026, 0, 3) });
    expect((await post(expiredOther.token, "tools/list")).json.error_description).toBe("service token 'nightly' expired on 2026-01-03");
  });

  it("expiry boundary: expires_at = now is refused, now + 1 accepted (review focus 3)", async () => {
    const now = Date.UTC(2026, 10, 7, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const atNow = await makeToken("ci", { createdAt: now - DAY, expiresAt: now });
    const later = await makeToken("nightly", { createdAt: now - DAY, expiresAt: now + 1 });
    const refused = await post(atNow.token, "tools/list");
    expect(refused.status).toBe(401);
    expect(refused.json.error_description).toBe("service token 'ci' expired on 2026-11-07");
    expect((await post(later.token, "tools/list")).status).toBe(200);
  });

  it("a token touched a minute ago that has since expired is refused: the throttle never skips verification (review focus 2)", async () => {
    const t = Date.UTC(2026, 10, 7, 12, 0, 0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(t);
    const { id, token } = await makeToken("ci", { createdAt: t - DAY, expiresAt: t + 30_000 });
    expect((await post(token, "tools/list")).status).toBe(200);
    expect(await lastUsed(id)).toBe(t);
    clock.mockReturnValue(t + 60_000);
    const res = await post(token, "tools/list");
    expect(res.status).toBe(401);
    expect(res.json.error_description).toBe("service token 'ci' expired on 2026-11-07");
  });

  it("order pin: a different right-shaped token gets the generic 401 while a revoked token is stored", async () => {
    const revoked = await makeToken("ci");
    await new ServiceTokenStore(env.DB).revoke(revoked.id, Date.now());
    // Only the holder of the real token learns a reason; nothing else is revealed, not even with one row stored.
    for (const bearer of [generateServiceToken(), `${revoked.token.slice(0, -1)}${revoked.token.endsWith("A") ? "B" : "A"}`]) {
      const res = await post(bearer, "tools/list");
      expect(res.status).toBe(401);
      expect(res.json).toEqual(GENERIC);
      expect(res.body).not.toContain("ci");
    }
  });

  it("hash compare: a row found whose token_hash differs (test DB wrapper) gets the generic 401", async () => {
    const { token } = await makeToken("ci");
    const revoked = await makeToken("nightly");
    await new ServiceTokenStore(env.DB).revoke(revoked.id, Date.now());
    const tamper = (sql: string, result: D1Result) =>
      /WHERE token_hash = \?/.test(sql)
        ? ({ ...result, results: result.results.map((r) => ({ ...(r as object), token_hash: "f".repeat(64) })) } as D1Result)
        : result;
    for (const bearer of [token, revoked.token]) {
      const m = meter(/service_tokens/, env.DB, tamper);
      const res = await post(bearer, "tools/list", {}, { e: httpEnv({ DB: m.db }) });
      expect(res.status).toBe(401);
      expect(res.json).toEqual(GENERIC);
    }
  });

  it("owner backstop: service props for another owner reaching mcpApiHandler get 403", async () => {
    const props: ServiceProps = {
      kind: "service",
      tokenId: "t1",
      name: "ci",
      githubUserId: 2002,
      graphIds: [WORK],
      access: "write",
      lastUsedAt: Date.now(),
    };
    const ctx = createExecutionContext();
    (ctx as unknown as { props: unknown }).props = props;
    const res = await mcpApiHandler.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      httpEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
    // The same props for the owner pass.
    const ownCtx = createExecutionContext();
    (ownCtx as unknown as { props: unknown }).props = { ...props, githubUserId: HTTP_OWNER };
    const own = await mcpApiHandler.fetch(
      new Request("https://mcp.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      httpEnv(),
      ownCtx,
    );
    await waitOnExecutionContext(ownCtx);
    expect(own.status).toBe(200);
  });

  it("a write is audited with client service:ci and the session id sent, and carries x-logseq-edit-stamp: claude", async () => {
    const { token } = await makeToken("ci");
    const written = await httpCall(token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, { session: "session-42" });
    expect(written.isError, written.text).toBe(false);
    const writes = httpSync.filter((c) => c.method !== "GET");
    expect(writes.map((c) => [c.method, c.stamp])).toEqual([["PATCH", "claude"]]);
    const rows = (await env.DB.prepare("SELECT tool, alias, status, client, session FROM audit_log ORDER BY id").all()).results;
    expect(rows).toEqual([{ tool: "update_block", alias: "work", status: "ok", client: "service:ci", session: "session-42" }]);
    // The same write sent again is written again.
    const again = await httpCall(token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, { session: "session-42" });
    expect(again.isError, again.text).toBe(false);
    expect(httpSync.filter((c) => c.method !== "GET")).toHaveLength(2);
  });

  it("read-only token through HTTP: a write is refused naming the token with 0 sync calls; a read reaches the sync server", async () => {
    const { token } = await makeToken("ci", { access: "read" });
    expect(await httpCall(token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } })).toEqual({
      isError: true,
      text: "graph 'work' is read-only (service token 'ci' is read-only)",
    });
    expect(httpSync).toEqual([]);
    const listed = await httpCall(token, "list_graphs", {});
    expect(JSON.parse(listed.text).map((g: { alias: string; mode: string }) => [g.alias, g.mode])).toEqual([["work", "read"]]);
    const read = await httpCall(token, "get_page", { graph: "work", "page-id": PAGE });
    expect(read.isError, read.text).toBe(false);
    expect(httpSync.map((c) => c.method)).toEqual(["GET"]);
    const rows = (await env.DB.prepare("SELECT tool, status, client FROM audit_log WHERE kind = 'write'").all()).results;
    expect(rows).toEqual([{ tool: "update_block", status: "refused", client: "service:ci" }]);
  });

  it("out of scope through HTTP: the scope reaches the tool callback (risk 2)", async () => {
    const { token } = await makeToken("ci");
    const message = "graph 'notes' is outside service token 'ci''s scope (it covers: work)";
    expect(await httpCall(token, "get_page", { graph: "notes", "page-id": PAGE })).toEqual({ isError: true, text: message });
    expect(await httpCall(token, "update_block", { graph: "notes", "block-id": B1, body: { title: "x" } })).toEqual({ isError: true, text: message });
    expect(httpSync).toEqual([]);
  });

  it("last_used_at: the first request writes it, a second within the hour issues no touch, one after the hour writes again", async () => {
    const t = Date.UTC(2026, 10, 7, 12, 0, 0);
    const clock = vi.spyOn(Date, "now").mockReturnValue(t);
    const { id, token } = await makeToken("ci", { createdAt: t - DAY, expiresAt: t + 90 * DAY });
    const run = async (at: number) => {
      clock.mockReturnValue(at);
      const m = meter(/service_tokens/);
      const res = await post(token, "tools/list", {}, { e: httpEnv({ DB: m.db }) });
      expect(res.status).toBe(200);
      return m.measured.map((x) => [x.sql.split(" ")[0], x.rowsRead, x.rowsWritten]);
    };
    expect(await run(t)).toEqual([
      ["SELECT", 1, 0],
      ["UPDATE", 1, 1],
    ]);
    expect(await lastUsed(id)).toBe(t);
    // Within the hour: the verify read only, and no UPDATE is even sent.
    expect(await run(t + 60_000)).toEqual([["SELECT", 1, 0]]);
    expect(await run(t + TOUCH_INTERVAL_MS)).toEqual([["SELECT", 1, 0]]);
    expect(await lastUsed(id)).toBe(t);
    expect(await run(t + TOUCH_INTERVAL_MS + 1)).toEqual([
      ["SELECT", 1, 0],
      ["UPDATE", 1, 1],
    ]);
    expect(await lastUsed(id)).toBe(t + TOUCH_INTERVAL_MS + 1);
  });

  it("a failed touch is logged by id and never reaches the response", async () => {
    const { id, token } = await makeToken("ci");
    const failing = meter(/service_tokens/, env.DB, (sql, result) => {
      if (sql.startsWith("UPDATE")) throw new Error("D1_ERROR: touch failed");
      return result;
    });
    const res = await post(token, "tools/list", {}, { e: httpEnv({ DB: failing.db }) });
    expect(res.status).toBe(200);
    expect(consoleText()).toContain(`service-token-touch-failed id=${id}`);
    expectNoToken(res, token);
  });

  it("a D1 failure in verify answers non-200 and leaks no token", async () => {
    const { token } = await makeToken("ci");
    const failing = meter(/service_tokens/, env.DB, () => {
      throw new Error("D1_ERROR: network connection lost");
    });
    // The provider rethrows anything that is not an ExternalTokenError, so the runtime answers 500;
    // what it would print is this error, which carries D1's message and no token.
    const thrown = await post(token, "tools/list", {}, { e: httpEnv({ DB: failing.db }) }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    const text = `${(thrown as Error).message}\n${(thrown as Error).stack}`;
    expect((thrown as Error).message).toBe("D1_ERROR: network connection lost");
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(5));
    expect(consoleText()).not.toContain(token);
    expect(consoleText()).not.toContain(token.slice(5));
    expect(httpSync).toEqual([]);
  });

  it("no column of service_tokens or audit_log contains any token, after writes, refusals and reasons", async () => {
    const write = await makeToken("ci");
    const read = await makeToken("nightly", { access: "read" });
    const revoked = await makeToken("backup");
    await new ServiceTokenStore(env.DB).revoke(revoked.id, Date.now());
    await httpCall(write.token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } }, { session: "s1" });
    await httpCall(read.token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } });
    await httpCall(write.token, "update_block", { graph: "notes", "block-id": B1, body: { title: "x" } });
    expect((await post(revoked.token, "tools/list")).status).toBe(401);
    const tokens = [write.token, read.token, revoked.token];
    const audit = (await env.DB.prepare("SELECT * FROM audit_log").all<Record<string, unknown>>()).results;
    expect(audit.length).toBe(3);
    for (const row of [...(await allColumns()), ...audit]) {
      for (const value of Object.values(row)) {
        for (const token of tokens) {
          expect(String(value)).not.toContain(token);
          expect(String(value)).not.toContain(token.slice(5));
        }
      }
    }
  });

  it("cost: a known token's verify reads 1 row and writes 0, and scope adds no D1 read", async () => {
    const { id, token } = await makeToken("ci");
    await new ServiceTokenStore(env.DB).touch(id, Date.now());
    const m = meter(/service_tokens/);
    const res = await post(token, "tools/call", { name: "get_page", arguments: { graph: "work", "page-id": PAGE } }, { e: httpEnv({ DB: m.db }) });
    expect(res.status).toBe(200);
    expect(m.measured.map((x) => [x.sql, x.rowsRead, x.rowsWritten])).toEqual([
      [expect.stringMatching(/^SELECT .* FROM service_tokens WHERE token_hash = \?$/), 1, 0],
    ]);
  });

  it("write-no-delete authenticates at /mcp (Stage 2 refused it): 1 read and a touch, and its delete is refused with no sync call", async () => {
    const { id, token } = await makeToken("worker", { access: "write-no-delete" });
    for (const [method, params, error] of [
      ["tools/list", {}, false],
      ["tools/call", { name: "get_page", arguments: { graph: "work", "page-id": PAGE } }, false],
      ["tools/call", { name: "update_block", arguments: { graph: "work", "block-id": B1, body: { title: "x" } } }, false],
      ["tools/call", { name: "delete_block", arguments: { graph: "work", "block-id": B1 } }, true],
    ] as const) {
      const m = meter(/service_tokens/);
      const res = await post(token, method, params, { e: httpEnv({ DB: m.db }) });
      expect(res.status, method).toBe(200);
      if (method === "tools/call") expect(res.json.result.isError === true, params.name).toBe(error);
      expect(m.measured[0], method).toMatchObject({ rowsRead: 1, rowsWritten: 0 });
      expectNoToken(res, token);
    }
    expect(await lastUsed(id)).not.toBeNull();
    expect(httpSync.filter((s) => s.method === "DELETE")).toEqual([]);
    expect(httpSync.map((s) => s.method)).toContain("PATCH");
  });

  it("what already authenticates still does: read and write tokens, after migration 0008's rebuild and after an edit", async () => {
    const read = await makeToken("ci", { access: "read" });
    const write = await makeToken("nightly", { access: "write" });
    const edited = await makeToken("backup", { access: "write-no-delete" });
    const row = (await new ServiceTokenStore(env.DB).get(edited.id))!;
    const scopeOf = (access: ServiceTokenAccess) => ({ graphIds: row.graphIds, access, expiresAt: row.expiresAt });
    // Edited up to write: the access it now holds is accepted.
    expect(await new ServiceTokenStore(env.DB).update(edited.id, scopeOf("write-no-delete"), scopeOf("write"), Date.now())).toBe(true);
    // The rows go through the rebuild as a deploy would run it.
    const kept = (await env.DB.prepare(`SELECT ${COLUMNS_0007} FROM service_tokens`).all()).results;
    await rebuildAs0007(kept);
    await apply0008();
    for (const [t, access] of [[read, "read"], [write, "write"], [edited, "write"]] as const) {
      const res = await post(t.token, "tools/list");
      expect(res.status, access).toBe(200);
      expect(await lastUsed(t.id), access).not.toBeNull();
    }
    expect((await httpCall(write.token, "update_block", { graph: "work", "block-id": B1, body: { title: "x" } })).isError).toBe(false);
    expect((await httpCall(read.token, "get_page", { graph: "work", "page-id": PAGE })).isError).toBe(false);
    // And an edit back down to write-no-delete takes effect on the next request: it still authenticates, and deletes are refused.
    expect(await new ServiceTokenStore(env.DB).update(edited.id, scopeOf("write"), scopeOf("write-no-delete"), Date.now())).toBe(true);
    expect((await post(edited.token, "tools/list")).status).toBe(200);
    const refused = await httpCall(edited.token, "delete_block", { graph: "work", "block-id": B1 });
    expect(refused.text).toBe("service token 'backup' may not delete (write, no deletes): delete_block on graph 'work' deletes the block and its children. Leave the delete to the owner.");
  });

  it.each(["delete", "", "admin", "READ", "write ", "toString", "__proto__"])(
    "unknown access %j (the CHECK bypassed) fails closed: the generic 401, not write",
    async (access) => {
      const { id, token } = await makeToken("ci", { access: "write" });
      await env.DB.exec("PRAGMA ignore_check_constraints = ON");
      try {
        await env.DB.prepare("UPDATE service_tokens SET access = ? WHERE id = ?").bind(access, id).run();
      } finally {
        await env.DB.exec("PRAGMA ignore_check_constraints = OFF");
      }
      expect((await env.DB.prepare("SELECT access FROM service_tokens WHERE id = ?").bind(id).all()).results[0].access).toBe(access);
      const res = await post(token, "tools/call", { name: "update_block", arguments: { graph: "work", "block-id": B1, body: { title: "x" } } });
      expect(res.status).toBe(401);
      expect(res.json).toEqual(GENERIC);
      expect(await lastUsed(id)).toBeNull();
      expect(httpSync).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// write-no-delete (spec 2026-11-08-service-token-write-no-delete §3.3, §3.5, §4, §8.1, §8.2).
// ---------------------------------------------------------------------------------------------

/** A write-no-delete token covering `notes` (read-write) and `archive` (connected read-only). */
const WORKER: RequestScope = { kind: "service", name: "worker", graphIds: new Set([NOTES, ARCHIVE]), access: "write-no-delete" };
const WRITE_NOTES: RequestScope = { kind: "service", name: "nightly", graphIds: new Set([NOTES]), access: "write" };
const READ_NOTES: RequestScope = { kind: "service", name: "ci", graphIds: new Set([NOTES]), access: "read" };

interface NdSyncCall {
  method: string;
  url: string;
  body: string;
}
let ndSync: NdSyncCall[];

/** The test env with a SYNC stub recording method, URL and body (answering an empty page), and semantic search on. */
function ndEnv(overrides: Partial<Env> = {}): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      ndSync.push({ method: request.method, url: request.url, body: request.method === "GET" ? "" : await request.text() });
      // B1 is found by a getBlocks read, so a delete's snapshot is whole and the delete itself is sent.
      return Response.json({ uuid: PAGE, kind: "page", title: "Notes", markdown: "", "block-count": 0, truncated: false, blocks: [{ uuid: B1, title: "a" }], missing: [] });
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync, AI: {} as Ai, VECTORIZE: {} as Vectorize, SEMANTIC_MAX_VECTORS: "10000", ...overrides } as Env;
}

const ndCall = (name: string, args: Record<string, unknown>, scope?: RequestScope) => call(name, args, scope, ndEnv());

async function ndAuditRows(): Promise<{ tool: string; alias: string; status: string; error: string | null; dry_run: number }[]> {
  return (await env.DB.prepare("SELECT tool, alias, status, error, dry_run FROM audit_log ORDER BY id").all<any>()).results;
}

const DRY = "Run it with dry-run=true to see what it would delete, and leave the delete to the owner.";
const LEAVE = "Leave the delete to the owner.";
const by = "service token 'worker' may not delete (write, no deletes):";

/** Each refused tool and argument (spec §4(a)), with the exact refusal on `notes`. */
const REFUSED: [string, string, Record<string, unknown>, string][] = [
  ["delete_page", "", { "page-id": PAGE }, `${by} delete_page on graph 'notes' deletes the page and its blocks. ${DRY}`],
  ["delete_block", "", { "block-id": B1 }, `${by} delete_block on graph 'notes' deletes the block and its children. ${LEAVE}`],
  ["delete_blocks", "", { body: { "block-ids": [B1] } }, `${by} delete_blocks on graph 'notes' deletes the blocks and their children. ${DRY}`],
  ["delete_tag", "", { "tag-id": B1 }, `${by} delete_tag on graph 'notes' deletes the tag, and its holders lose it. ${DRY}`],
  ["delete_property", "", { "property-id": "Venue" }, `${by} delete_property on graph 'notes' deletes the property and its values. ${DRY}`],
  [
    "delete_block_property",
    "",
    { "block-id": B1, "property-id": "Venue" },
    `${by} delete_block_property on graph 'notes' removes a property value. ${LEAVE}`,
  ],
  [
    "batch_delete_block_property",
    "",
    { body: { entries: [{ "block-id": B1, "property-id": "Venue" }] } },
    `${by} batch_delete_block_property on graph 'notes' removes property values. ${LEAVE}`,
  ],
  [
    "update_property",
    "convert_values",
    { "property-id": "Venue", body: { type: "node", convert_values: true } },
    `${by} update_property on graph 'notes' with convert_values deletes the property's old text value blocks. ${DRY}`,
  ],
  [
    "update_property",
    "choices.retire",
    { "property-id": "Venue", body: { choices: { retire: ["Old hall"] } } },
    `${by} update_property on graph 'notes' with choices.retire removes choices and the values blocks hold. ${DRY}`,
  ],
  [
    "set_block_property",
    '""',
    { "block-id": B1, "property-id": "Venue", body: { value: "" } },
    `${by} set_block_property on graph 'notes' with an empty value removes the property. ${LEAVE}`,
  ],
  [
    "set_block_property",
    "[]",
    { "block-id": B1, "property-id": "Venue", body: { value: [] } },
    `${by} set_block_property on graph 'notes' with an empty value removes the property. ${LEAVE}`,
  ],
  [
    "set_block_property",
    '[""]',
    { "block-id": B1, "property-id": "Venue", body: { value: [""] } },
    `${by} set_block_property on graph 'notes' with an empty value removes the property. ${LEAVE}`,
  ],
  [
    "batch_set_block_property",
    "entry 2 []",
    {
      body: {
        entries: [
          { "block-id": B1, "property-id": "Venue", value: "Hall" },
          { "block-id": B1, "property-id": "Count", value: 3 },
          { "block-id": B1, "property-id": "Topics", value: [] },
        ],
      },
    },
    `${by} batch_set_block_property on graph 'notes' entry 2: an empty value removes the property. ${LEAVE}`,
  ],
];

/** A batch_set entry: an empty one, or one holding a value. */
const entry = (property: string, value: unknown) => ({ "block-id": B1, "property-id": property, value });

describe("write-no-delete", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.DB.exec("DELETE FROM audit_log");
    const base = { permission: "both" as const, expiresAt: null };
    await graphStore().add({ ...base, alias: "work", graphId: WORK, graphName: "Work", mode: "write", token: "logseq_pat_Work1" });
    await graphStore().add({ ...base, alias: "notes", graphId: NOTES, graphName: "Notes", mode: "write", token: "logseq_pat_Notes2" });
    await graphStore().add({ ...base, alias: "archive", graphId: ARCHIVE, graphName: "Archive", mode: "read", token: "logseq_pat_Archive3" });
    ndSync = [];
    publicFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("a", { headers: { "Content-Type": "text/plain" } }));
  });

  afterEach(() => {
    publicFetch.mockRestore();
  });

  it.each(REFUSED)("refuses %s (%s): the exact message, 0 sync calls, an audit row refused with it", async (tool, _arg, args, message) => {
    expect(await ndCall(tool, { graph: "notes", ...args }, WORKER)).toEqual({ isError: true, text: message });
    expect(ndSync).toEqual([]);
    expect(await ndAuditRows()).toEqual([{ tool, alias: "notes", status: "refused", error: message, dry_run: 0 }]);
  });

  it("a reason given with a refused delete is still refused, and the reason is kept on the row", async () => {
    const message = REFUSED[1][3];
    expect(await ndCall("delete_block", { graph: "notes", "block-id": B1, reason: "tidy up" }, WORKER)).toEqual({ isError: true, text: message });
    expect(ndSync).toEqual([]);
    const row = (await env.DB.prepare("SELECT status, reason FROM audit_log").all<any>()).results;
    expect(row).toEqual([{ status: "refused", reason: "tidy up" }]);
  });

  it.each([
    ["the first", [entry("Topics", []), entry("Venue", "Hall"), entry("Count", 3)], 0],
    ["the middle", [entry("Venue", "Hall"), entry("Topics", ""), entry("Count", 3)], 1],
    ["the last (reversed)", [entry("Count", 3), entry("Venue", "Hall"), entry("Topics", [""])], 2],
    ["two (the first is named)", [entry("Venue", "Hall"), entry("Topics", []), entry("Count", "")], 1],
  ] as const)("batch_set_block_property with %s entry empty names that entry", async (_label, entries, index) => {
    const text = `${by} batch_set_block_property on graph 'notes' entry ${index}: an empty value removes the property. ${LEAVE}`;
    expect(await ndCall("batch_set_block_property", { graph: "notes", body: { entries } }, WORKER)).toEqual({ isError: true, text });
    expect(ndSync).toEqual([]);
  });

  it("batch_set_block_property with no empty entry, in any order and with isResetExistingValues, reaches sync", async () => {
    const a = entry("Venue", "Hall");
    const b = entry("Count", 0);
    const c = entry("Topics", ["x"]);
    for (const entries of [[a, b, c], [c, b, a], [b, a, c], [a, a]]) {
      for (const body of [{ entries }, { entries, isResetExistingValues: true }]) {
        ndSync = [];
        const result = await ndCall("batch_set_block_property", { graph: "notes", body }, WORKER);
        expect(result.text).not.toContain("may not delete");
        expect(ndSync.map((s) => s.method)).toContain("POST");
      }
    }
  });

  it.each(REFUSED)("a write token still runs %s (%s): it reaches the sync server", async (tool, _arg, args) => {
    const result = await ndCall(tool, { graph: "notes", ...args }, WRITE_NOTES);
    expect(result.text).not.toContain("may not delete");
    const method = committedManifest.find((e) => e.name === tool)!.method;
    expect(ndSync.map((s) => s.method)).toContain(method);
  });

  it("OAuth is unaffected: delete_page and an empty set_block_property reach the sync server", async () => {
    for (const [tool, args] of [
      ["delete_page", { "page-id": PAGE }],
      ["set_block_property", { "block-id": B1, "property-id": "Venue", body: { value: [] } }],
    ] as const) {
      ndSync = [];
      const result = await ndCall(tool, { graph: "notes", ...args });
      expect(result.text).not.toContain("may not delete");
      expect(ndSync.map((s) => s.method)).toContain(committedManifest.find((e) => e.name === tool)!.method);
    }
  });

  it("what already works still works: never-rule tools, overwrites, no-ops and re-sends reach the sync server", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["update_block", { "block-id": B1, body: { title: "new text" } }],
      ["update_block", { "block-id": B1, body: { title: "new text" } }], // a re-send
      ["update_page", { "page-id": PAGE, body: { title: "Renamed" } }],
      ["move_blocks", { body: { "block-ids": [B1], "target-id": PAGE, position: "last-child" } }],
      ["batch_move_blocks", { body: { moves: [{ "block-ids": [B1], "target-id": PAGE, position: "last-child" }] } }],
      ["insert_block_tree", { body: { "target-id": PAGE, blocks: [{ title: "a" }] } }],
      ["insert_block_children", { "block-id": B1, body: { position: "append", blocks: [{ title: "a" }] } }],
      ["batch_insert_block_trees", { body: { entries: [{ page: "Notes", blocks: [{ title: "a" }], properties: { Venue: "Hall" } }] } }],
      ["batch_insert_block_trees", { body: { entries: [{ "target-id": B1, blocks: [{ title: "a" }], properties: { Venue: [] } }] } }],
      ["promote_page_to_tag", { "page-id": PAGE }],
      ["refresh_refs", { body: { "page-id": PAGE, apply: true } }],
      ["update_tag", { "tag-id": B1, body: { title: "Meeting" } }],
      ["update_tag", { "tag-id": B1, body: { properties: { remove: ["Venue"] } } }],
      ["update_tag", { "tag-id": B1, body: { properties: { set: [] } } }],
      ["update_property", { "property-id": "Venue", body: { title: "Place" } }],
      ["update_property", { "property-id": "Venue", body: { cardinality: "db.cardinality/many", convert_values: false } }],
      ["update_property", { "property-id": "Venue", body: { choices: { retire: [] } } }],
      ["update_property", { "property-id": "Venue", body: { choices: { add: [{ title: "Hall" }] } } }],
      ["set_block_property", { "block-id": B1, "property-id": "Venue", body: { value: "Hall" } }],
      ["set_block_property", { "block-id": B1, "property-id": "Venue", body: { value: " " } }],
      ["set_block_property", { "block-id": B1, "property-id": "Count", body: { value: 0 } }],
      ["set_block_property", { "block-id": B1, "property-id": "Done", body: { value: false } }],
      ["set_block_property", { "block-id": B1, "property-id": "Topics", body: { value: [" "] } }],
      ["set_block_property", { "block-id": B1, "property-id": "Topics", body: { value: ["a", "b"] } }],
      ["create_page", { body: { title: "Standup" } }],
      ["create_tag", { body: { title: "Meeting" } }],
      ["create_property", { body: { title: "Venue" } }],
    ];
    const listed = new Map((await tools(WORKER)).map((t) => [t.name, t]));
    for (const [tool, args] of cases) {
      ndSync = [];
      const base = argsFor(listed.get(tool), "notes");
      const result = await ndCall(tool, { ...base, ...args, graph: "notes" }, WORKER);
      expect(result.text, `${tool} ${JSON.stringify(args)}`).not.toContain("may not delete");
      expect(ndSync.filter((s) => s.method !== "GET").length, `${tool} ${JSON.stringify(args)}: ${result.text}`).toBeGreaterThan(0);
    }
  });

  it("every never-rule tool, with the smallest arguments its schema takes, is not refused as a delete", async () => {
    const listed = (await tools(WORKER)).filter((t) => t.annotations?.readOnlyHint !== true);
    const never = listed.filter((t) => !["delete_page", "delete_block", "delete_blocks", "delete_tag", "delete_property", "delete_block_property", "batch_delete_block_property"].includes(t.name));
    expect(never.length).toBe(WRITES_IN_MANIFEST.length - 7);
    for (const tool of never) {
      const result = await ndCall(tool.name, argsFor(tool, "notes"), WORKER);
      expect(result.text, tool.name).not.toContain("may not delete");
    }
    // save_document's stub arguments may be refused for their own reasons; never as a delete.
    expect((await ndAuditRows()).filter((r) => r.error?.includes("may not delete"))).toEqual([]);
  });

  it.each([
    ["delete_page", { "page-id": PAGE, "dry-run": true }, "DELETE", "query"],
    ["delete_tag", { "tag-id": B1, "dry-run": true }, "DELETE", "query"],
    ["delete_property", { "property-id": "Venue", "dry-run": true }, "DELETE", "query"],
    ["delete_blocks", { body: { "block-ids": [B1], "dry-run": true } }, "DELETE", "body"],
    ["update_property", { "property-id": "Venue", "dry-run": true, body: { convert_values: true } }, "PATCH", "query"],
    ["update_property", { "property-id": "Venue", "dry-run": true, body: { choices: { retire: ["Old hall"] } } }, "PATCH", "query"],
  ] as const)("a declared dry run of %s passes: it reaches sync with dry-run=true and is audited dry_run = 1", async (tool, args, method, where) => {
    const result = await ndCall(tool, { graph: "notes", ...args }, WORKER);
    expect(result.text).not.toContain("may not delete");
    const sent = ndSync.filter((s) => s.method === method);
    expect(sent).toHaveLength(1);
    if (where === "query") expect(new URL(sent[0].url).searchParams.get("dry-run")).toBe("true");
    else expect(JSON.parse(sent[0].body)["dry-run"]).toBe(true);
    expect((await ndAuditRows()).map((r) => [r.tool, r.status, r.dry_run])).toEqual([[tool, expect.not.stringMatching(/refused/), 1]]);
  });

  it.each([
    ["delete_page with dry-run in the body", "delete_page", { "page-id": PAGE, body: { "dry-run": true } }],
    ["delete_blocks with dry-run in the query", "delete_blocks", { "dry-run": true, body: { "block-ids": [B1] } }],
    ["delete_block, which declares no dry run", "delete_block", { "block-id": B1, "dry-run": true }],
    ["set_block_property, which declares no dry run", "set_block_property", { "block-id": B1, "property-id": "Venue", "dry-run": true, body: { value: [] } }],
    ["update_property with dry-run in the body", "update_property", { "property-id": "Venue", body: { convert_values: true, "dry-run": true } }],
    ["delete_page with dry-run false", "delete_page", { "page-id": PAGE, "dry-run": false }],
  ] as const)("an undeclared dry run is refused: %s", async (_label, tool, args) => {
    const result = await ndCall(tool, { graph: "notes", ...args }, WORKER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^service token 'worker' may not delete \(write, no deletes\): /);
    expect(ndSync).toEqual([]);
  });

  it("dry-run as the string 'true' is not a dry run: refused with 0 sync calls", async () => {
    for (const [tool, args] of [
      ["delete_page", { "page-id": PAGE, "dry-run": "true" }],
      ["delete_blocks", { body: { "block-ids": [B1], "dry-run": "true" } }],
    ] as const) {
      const result = await ndCall(tool, { graph: "notes", ...args }, WORKER);
      expect(result.isError, tool).toBe(true);
    }
    expect(ndSync).toEqual([]);
  });

  it("read stays read: a read token refuses as before; write-no-delete on a read-only graph answers read-only naming the token", async () => {
    expect(await ndCall("delete_page", { graph: "notes", "page-id": PAGE }, READ_NOTES)).toEqual({
      isError: true,
      text: "graph 'notes' is read-only (service token 'ci' is read-only)",
    });
    for (const [tool, args] of [
      ["delete_page", { "page-id": PAGE }],
      ["update_block", { "block-id": B1, body: { title: "x" } }],
      ["delete_page", { "page-id": PAGE, "dry-run": true }],
    ] as const) {
      expect(await ndCall(tool, { graph: "archive", ...args }, WORKER), tool).toEqual({
        isError: true,
        text: "graph 'archive' is read-only (service token 'worker' is read-only)",
      });
    }
    expect(ndSync).toEqual([]);
    // The same token writes to its read-write graph.
    const written = await ndCall("update_block", { graph: "notes", "block-id": B1, body: { title: "x" } }, WORKER);
    expect(written.text).not.toMatch(/read-only|may not delete/);
    expect(ndSync.map((s) => s.method)).toContain("PATCH");
  });

  it("list_graphs shows the effective mode: read, write-no-delete and write, with the read-only graph capping each", async () => {
    const listed = async (scope?: RequestScope) =>
      JSON.parse((await ndCall("list_graphs", {}, scope)).text).map((g: { alias: string; mode: string }) => [g.alias, g.mode]);
    expect(await listed(WORKER)).toEqual([
      ["archive", "read"],
      ["notes", "write-no-delete"],
    ]);
    expect(await listed({ ...WRITE_NOTES, graphIds: new Set([NOTES, ARCHIVE]) })).toEqual([
      ["archive", "read"],
      ["notes", "write"],
    ]);
    expect(await listed({ ...READ_NOTES, graphIds: new Set([NOTES, ARCHIVE]) })).toEqual([
      ["archive", "read"],
      ["notes", "read"],
    ]);
    expect(await listed()).toEqual([
      ["archive", "read"],
      ["notes", "write"],
      ["work", "write"],
    ]);
  });

  it("backstop: request() refuses every HTTP DELETE route on a write-no-delete graph, sent round audited(), with 0 sync calls", async () => {
    const { graphTools } = isolateTools(ndEnv());
    const handler = (name: string) => graphTools.find((t) => t.name === name)!.handler;
    const direct = (scope: RequestScope, name: string, args: Record<string, unknown>) =>
      requestScope.run(scope, () => withCallGraphs(() => handler(name)({ graph: "notes", ...args })));
    for (const [tool, , args, message] of REFUSED.filter(([t]) => committedManifest.find((e) => e.name === t)!.method === "DELETE")) {
      await expect(direct(WORKER, tool, args), tool).rejects.toThrow(message);
      await expect(direct(WORKER, tool, args), tool).rejects.toMatchObject({ status: "no-delete" });
    }
    expect(ndSync).toEqual([]);
    // A declared dry run gets through, in the query and in the body.
    await direct(WORKER, "delete_page", { "page-id": PAGE, "dry-run": true });
    await direct(WORKER, "delete_blocks", { body: { "block-ids": [B1], "dry-run": true } });
    expect(ndSync.map((s) => s.method)).toEqual(["DELETE", "DELETE"]);
    // Undeclared places are not dry runs.
    await expect(direct(WORKER, "delete_blocks", { "dry-run": true, body: { "block-ids": [B1] } })).rejects.toMatchObject({ status: "no-delete" });
    await expect(direct(WORKER, "delete_block", { "block-id": B1, "dry-run": true })).rejects.toMatchObject({ status: "no-delete" });
    expect(ndSync).toHaveLength(2);
    // A write token and OAuth reach the sync server.
    await direct(WRITE_NOTES, "delete_block", { "block-id": B1 });
    await direct({ kind: "oauth" }, "delete_block", { "block-id": B1 });
    expect(ndSync.map((s) => s.method)).toEqual(["DELETE", "DELETE", "DELETE", "DELETE"]);
  });

  it("cost: a repeated lookupGraph in one call reads nothing, and sees the same deletesRefusedBy", async () => {
    const m = meteredFirst();
    const { access } = isolateTools(ndEnv({ DB: m.db }));
    const seen = await requestScope.run(WORKER, () =>
      withCallGraphs(async () => [await lookupGraph(access, "notes"), await lookupGraph(access, "notes")]),
    );
    expect(seen.map((g) => g?.deletesRefusedBy)).toEqual(["service token 'worker'", "service token 'worker'"]);
    expect(seen.map((g) => g?.mode)).toEqual(["write", "write"]);
    expect(m.measured.map((x) => [x.rowsRead, x.rowsWritten])).toEqual([[1, 0]]);
  });

  it("cost: a refused delete's audit rows read and write what a read-only refusal's do", async () => {
    const audit = async (scope: RequestScope) => {
      const m = meter(/audit_log/);
      const result = await call("delete_block", { graph: "notes", "block-id": B1 }, scope, ndEnv({ DB: m.db }));
      expect(result.isError).toBe(true);
      return m.measured.map((x) => [x.sql, x.rowsRead, x.rowsWritten]);
    };
    const readOnly = await audit(READ_NOTES);
    expect(readOnly.length).toBeGreaterThanOrEqual(2);
    expect(await audit(WORKER)).toEqual(readOnly);
    expect(ndSync).toEqual([]);
  });

  it("connector_help and list_graphs' description describe the refusal: every always-delete tool, the dry runs, and leaving it to the owner", async () => {
    const help = (await ndCall("connector_help", {}, WORKER)).text;
    for (const tool of [...ALWAYS_DELETE, "convert_values", "choices.retire", "set_block_property", "batch_set_block_property"]) {
      expect(help, tool).toContain(tool);
    }
    for (const [tool] of Object.entries(DRY_RUN_TOOLS).filter(([t]) => deleteReason(t, { body: { convert_values: true } }) !== null)) {
      expect(help, tool).toContain(tool);
    }
    expect(help).toContain("Don't retry a refused delete: report what it would delete and leave the delete to the owner.");
    const listGraphs = (await tools(WORKER)).find((t) => t.name === "list_graphs");
    expect(listGraphs.description).toContain("read, write-no-delete or write");
  });

  it("a write token and a read token never get deletesRefusedBy; OAuth never does", async () => {
    const { access } = isolateTools(ndEnv());
    for (const scope of [WRITE_NOTES, READ_NOTES, { kind: "oauth" } as RequestScope]) {
      const graph = await requestScope.run(scope, () => withCallGraphs(() => lookupGraph(access, "notes")));
      expect(graph?.deletesRefusedBy, JSON.stringify(scope.kind)).toBeUndefined();
    }
  });
});

describe("HTTP write-no-delete", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.DB.exec("DELETE FROM audit_log");
    const base = { permission: "both" as const, expiresAt: null };
    await graphStore().add({ ...base, alias: "notes", graphId: NOTES, graphName: "Notes", mode: "write", token: "logseq_pat_Notes2" });
    httpSync = [];
    httpConsole = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  });

  afterEach(() => {
    for (const spy of httpConsole) spy.mockRestore();
    vi.restoreAllMocks();
  });

  it("a write-no-delete token authenticates, writes, and has its delete refused naming it, with no sync call", async () => {
    const { id, token } = await makeToken("worker", { access: "write-no-delete", graphIds: [NOTES] });
    const list = await post(token, "tools/list");
    expect(list.status).toBe(200);
    expect(await lastUsed(id)).not.toBeNull();
    const written = await httpCall(token, "update_block", { graph: "notes", "block-id": B1, body: { title: "x" } });
    expect(written.isError, written.text).toBe(false);
    expect(httpSync.map((s) => s.method)).toContain("PATCH");
    httpSync = [];
    const refused = await httpCall(token, "delete_block", { graph: "notes", "block-id": B1 });
    expect(refused).toEqual({ isError: true, text: `${by} delete_block on graph 'notes' deletes the block and its children. ${LEAVE}` });
    expect(httpSync).toEqual([]);
    const rows = (await env.DB.prepare("SELECT tool, status, client, error FROM audit_log ORDER BY id").all<any>()).results;
    expect(rows.at(-1)).toEqual({ tool: "delete_block", status: "refused", client: "service:worker", error: refused.text });
    const listed = JSON.parse((await httpCall(token, "list_graphs", {})).text);
    expect(listed.map((g: { alias: string; mode: string }) => [g.alias, g.mode])).toEqual([["notes", "write-no-delete"]]);
  });

  it("cost: a write-no-delete token's /mcp request reads 1 service_tokens row and writes 0", async () => {
    const { id, token } = await makeToken("worker", { access: "write-no-delete", graphIds: [NOTES] });
    await new ServiceTokenStore(env.DB).touch(id, Date.now());
    for (const [name, args] of [
      ["get_page", { graph: "notes", "page-id": PAGE }],
      ["delete_block", { graph: "notes", "block-id": B1 }],
    ] as const) {
      const m = meter(/service_tokens/);
      const res = await post(token, "tools/call", { name, arguments: args }, { e: httpEnv({ DB: m.db }) });
      expect(res.status).toBe(200);
      expect(m.measured.map((x) => [x.sql, x.rowsRead, x.rowsWritten]), name).toEqual([
        [expect.stringMatching(/^SELECT .* FROM service_tokens WHERE token_hash = \?$/), 1, 0],
      ]);
    }
  });
});
