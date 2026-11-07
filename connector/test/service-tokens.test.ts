import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  generateServiceToken,
  hashServiceToken,
  ServiceTokenStore,
  TOKEN_PATTERN,
  TOUCH_INTERVAL_MS,
} from "../src/auth/service-tokens";
import { timingSafeEqual } from "../src/crypto";

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
