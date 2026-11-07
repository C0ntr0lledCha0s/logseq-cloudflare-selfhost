import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { GraphStore, normalizeAlias, normalizeToken } from "../src/graphs";

const TOKEN = "logseq_pat_abcDEF123_-xyz";
const BASE = {
  alias: "work",
  graphId: "11111111-1111-1111-1111-111111111111",
  graphName: "Work graph",
  mode: "write" as const,
  permission: "both" as const,
  expiresAt: null,
  token: TOKEN,
};

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
});

describe("normalizeToken", () => {
  it("trims one trailing newline and rejects inner whitespace and bad chars", () => {
    expect(normalizeToken(`${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeToken(`  ${TOKEN} \r\n`)).toBe(TOKEN);
    for (const bad of [`logseq_pat_ab cd`, `logseq_pat_ab\ncd`, `logseq_pat_ab$cd`, `logseq_pat_`, `other_abc`, ``]) {
      expect(() => normalizeToken(bad)).toThrow("token has unexpected characters (stray whitespace or newline?)");
    }
  });
});

describe("normalizeAlias", () => {
  it("lowercases, replaces non-alphanumerics with a hyphen and collapses repeats", () => {
    expect(normalizeAlias("My  Work_Graph")).toBe("my-work-graph");
    expect(normalizeAlias("a!!b")).toBe("a-b");
  });

  it("rejects values that do not match the alias pattern", () => {
    expect(() => normalizeAlias("")).toThrow();
    expect(() => normalizeAlias("--x")).toThrow();
    expect(() => normalizeAlias("a".repeat(41))).toThrow();
    expect(normalizeAlias("a".repeat(40))).toBe("a".repeat(40));
  });
});

describe("GraphStore", () => {
  it("token round-trips encrypted; token_ct differs from plaintext and between two adds of same token", async () => {
    const s = store();
    await s.add(BASE);
    await s.add({ ...BASE, alias: "second", graphId: "22222222-2222-2222-2222-222222222222" });
    expect(await s.token("work")).toBe(TOKEN);
    const rows = (await env.DB.prepare("SELECT alias, token_ct, token_iv, key_id FROM graphs ORDER BY alias").all<{
      alias: string;
      token_ct: string;
      token_iv: string;
      key_id: string;
    }>()).results;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.token_ct).not.toContain(TOKEN);
      expect(row.token_ct).not.toContain("logseq_pat");
      expect(row.key_id).toBe("k1");
    }
    expect(rows[0].token_ct).not.toBe(rows[1].token_ct);
    expect(rows[0].token_iv).not.toBe(rows[1].token_iv);
  });

  it("add trims a trailing newline from the token and rejects a malformed one", async () => {
    const s = store();
    await s.add({ ...BASE, token: `${TOKEN}\n` });
    expect(await s.token("work")).toBe(TOKEN);
    await expect(s.add({ ...BASE, alias: "other", graphId: "g2", token: "nope" })).rejects.toThrow("token has unexpected");
  });

  it("rejects a tampered ciphertext and a wrong key", async () => {
    const s = store();
    await s.add(BASE);
    await expect(new GraphStore(env.DB, "00".repeat(32)).token("work")).rejects.toThrow();
    await env.DB.exec("UPDATE graphs SET token_ct = 'AAAA' WHERE alias = 'work'");
    await expect(s.token("work")).rejects.toThrow();
  });

  it("a ciphertext copied onto another graph's row does not decrypt (graph id is bound as AAD)", async () => {
    const s = store();
    await s.add({ ...BASE, alias: "a", graphId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token: "logseq_pat_tokenA" });
    await s.add({ ...BASE, alias: "b", graphId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", token: "logseq_pat_tokenB" });
    await env.DB.exec(
      "UPDATE graphs SET token_ct = (SELECT token_ct FROM graphs WHERE alias = 'a'), token_iv = (SELECT token_iv FROM graphs WHERE alias = 'a') WHERE alias = 'b'",
    );
    expect(await s.token("a")).toBe("logseq_pat_tokenA");
    await expect(s.token("b")).rejects.toThrow();
  });

  it("constructor throws unless the key is 64 hex characters", () => {
    for (const bad of ["", "abcd", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
      expect(() => new GraphStore(env.DB, bad)).toThrow("GRAPH_TOKEN_KEY");
    }
  });

  it("duplicate alias or graph_id rejected", async () => {
    const s = store();
    await s.add(BASE);
    await expect(s.add({ ...BASE, graphId: "other-id" })).rejects.toThrow(/alias/);
    await expect(s.add({ ...BASE, alias: "other" })).rejects.toThrow(/graph/);
    expect(await s.list()).toHaveLength(1);
  });

  it("add rejects an invalid alias", async () => {
    await expect(store().add({ ...BASE, alias: "Not Valid" })).rejects.toThrow(/alias/);
  });

  it("replaceToken refuses a different graph id", async () => {
    const s = store();
    await s.add(BASE);
    const next = "logseq_pat_replacement";
    await expect(s.replaceToken("work", next, "99999999-9999-9999-9999-999999999999")).rejects.toThrow();
    expect(await s.token("work")).toBe(TOKEN);
    await s.replaceToken("work", `${next}\n`, BASE.graphId);
    expect(await s.token("work")).toBe(next);
  });

  it("remove then get returns null immediately", async () => {
    const s = store();
    await s.add(BASE);
    await s.remove("work");
    expect(await s.get("work")).toBeNull();
    await expect(s.token("work")).rejects.toThrow();
    await expect(s.remove("work")).rejects.toThrow();
  });

  it("list never exposes token fields", async () => {
    const s = store();
    await s.add(BASE);
    const [rec] = await s.list();
    expect(Object.keys(rec).sort()).toEqual(
      ["alias", "editStamps", "expiresAt", "graphId", "graphName", "lastUsedAt", "mode", "permission"].sort(),
    );
    expect(JSON.stringify(await s.list())).not.toContain("logseq_pat");
    expect(Object.keys((await s.get("work"))!)).not.toContain("token");
    expect(await s.get("missing")).toBeNull();
  });

  it("update changes mode, permission and expiresAt; renaming keeps uniqueness and normalizes", async () => {
    const s = store();
    await s.add(BASE);
    await s.add({ ...BASE, alias: "home", graphId: "g2" });
    await s.update("work", { mode: "read", permission: "read", expiresAt: "2027-01-01" });
    expect(await s.get("work")).toMatchObject({ mode: "read", permission: "read", expiresAt: "2027-01-01" });
    await s.update("work", { expiresAt: null });
    expect((await s.get("work"))!.expiresAt).toBeNull();

    await expect(s.update("work", { alias: "home" })).rejects.toThrow(/alias/);
    await expect(s.update("work", { alias: "--" })).rejects.toThrow();
    await s.update("work", { alias: "Work Graph 2" });
    expect(await s.get("work")).toBeNull();
    expect(await s.token("work-graph-2")).toBe(TOKEN);
    await expect(s.update("missing", { mode: "read" })).rejects.toThrow();
  });

  it("touch sets last_used_at to an ISO timestamp and throws for a missing alias", async () => {
    const s = store();
    await s.add(BASE);
    expect((await s.get("work"))!.lastUsedAt).toBeNull();
    await s.touch("work");
    const at = (await s.get("work"))!.lastUsedAt!;
    expect(new Date(at).toISOString()).toBe(at);
    await expect(s.touch("missing")).rejects.toThrow();
  });

  it("resolve returns the graph id, mode and decrypted token from one row, or null for an unknown alias", async () => {
    const s = store();
    await s.add({ ...BASE, mode: "read" });
    expect(await s.resolve("work")).toEqual({ graphId: BASE.graphId, mode: "read", pat: TOKEN, editStamps: true });
    expect(await s.resolve("missing")).toBeNull();
    await s.remove("work");
    expect(await s.resolve("work")).toBeNull();
  });
});

interface Measured {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The real D1 binding, recording each statement and its own `meta`. `first` is answered from `all`
 * (the same query), so a `first` statement is costed too.
 */
function metered(): { db: D1Database; measured: Measured[] } {
  const measured: Measured[] = [];
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

/** Migration files as the tests apply them (vitest.config.ts injects TEST_MIGRATIONS). */
function migration(prefix: string): string[] {
  const all = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  const found = all.find((m) => m.name.startsWith(prefix));
  if (!found) throw new Error(`no migration ${prefix}`);
  return found.queries;
}

describe("edit stamps setting", () => {
  it("migration 0005 defaults edit_stamps to 1 for a row that existed before it and for a new row", async () => {
    // Rebuild graphs as 0001 left it, holding a row the Worker wrote before 0005, then apply 0005.
    await store().add(BASE);
    const COLUMNS_0001 = "alias, graph_id, graph_name, mode, permission, expires_at, token_ct, token_iv, key_id, created_at, last_used_at";
    const old = await env.DB.prepare(`SELECT ${COLUMNS_0001} FROM graphs`).first<Record<string, unknown>>();
    await env.DB.exec("DROP TABLE graphs");
    for (const query of migration("0001_")) await env.DB.prepare(query).run();
    await env.DB.prepare(`INSERT INTO graphs (${COLUMNS_0001}) VALUES (${COLUMNS_0001.split(", ").map(() => "?").join(", ")})`)
      .bind(...COLUMNS_0001.split(", ").map((c) => old![c] ?? null))
      .run();
    for (const query of migration("0005_")) await env.DB.prepare(query).run();
    // A row inserted without the column, as add() writes it.
    await store().add({ ...BASE, alias: "home", graphId: "22222222-2222-2222-2222-222222222222" });
    const { results } = await env.DB.prepare("SELECT alias, edit_stamps FROM graphs ORDER BY alias").all();
    expect(results).toEqual([
      { alias: "home", edit_stamps: 1 },
      { alias: "work", edit_stamps: 1 },
    ]);
    // NOT NULL, and only 0 or 1.
    for (const bad of ["NULL", "2", "'yes'"]) {
      await expect(env.DB.exec(`UPDATE graphs SET edit_stamps = ${bad} WHERE alias = 'work'`), bad).rejects.toThrow();
    }
    expect(await store().resolve("work")).toMatchObject({ editStamps: true });
  });

  it("resolve returns editStamps from the one row it reads: one statement, meta.rows_read 1", async () => {
    await store().add(BASE);
    await store().add({ ...BASE, alias: "home", graphId: "22222222-2222-2222-2222-222222222222" });
    await env.DB.exec("UPDATE graphs SET edit_stamps = 0 WHERE alias = 'home'");
    for (const [alias, editStamps] of [["work", true], ["home", false]] as const) {
      const { db, measured } = metered();
      const resolved = await new GraphStore(db, env.GRAPH_TOKEN_KEY).resolve(alias);
      expect(resolved, alias).toEqual({ graphId: alias === "work" ? BASE.graphId : "22222222-2222-2222-2222-222222222222", mode: "write", pat: TOKEN, editStamps });
      expect(measured, alias).toHaveLength(1);
      expect(measured[0], alias).toMatchObject({ rowsRead: 1, rowsWritten: 0 });
    }
  });

  it("list and get return editStamps; update sets it and leaves the other fields", async () => {
    const s = store();
    await s.add(BASE);
    expect(await s.get("work")).toMatchObject({ editStamps: true });
    await s.update("work", { editStamps: false });
    expect((await s.get("work"))!.editStamps).toBe(false);
    expect(await s.list()).toEqual([
      { alias: "work", graphId: BASE.graphId, graphName: BASE.graphName, mode: "write", permission: "both", expiresAt: null, lastUsedAt: null, editStamps: false },
    ]);
    expect((await s.resolve("work"))!.editStamps).toBe(false);
    // A patch without editStamps keeps it; a patch with only editStamps keeps the rest.
    await s.update("work", { mode: "read" });
    expect(await s.get("work")).toMatchObject({ mode: "read", editStamps: false });
    await s.update("work", { editStamps: true });
    expect(await s.get("work")).toMatchObject({ mode: "read", permission: "both", editStamps: true });
    expect((await s.resolve("work"))!.editStamps).toBe(true);
  });
});

describe("aliasesFor (service token scope)", () => {
  const HOME = "22222222-2222-2222-2222-222222222222";
  const ARCHIVE = "33333333-3333-3333-3333-333333333333";
  const GONE = "44444444-4444-4444-4444-444444444444";

  it("names the connected graphs among the ids, ordered by alias, in one statement; unknown ids drop out", async () => {
    await store().add(BASE);
    await store().add({ ...BASE, alias: "home", graphId: HOME });
    await store().add({ ...BASE, alias: "archive", graphId: ARCHIVE });
    const { db, measured } = metered();
    const s = new GraphStore(db, env.GRAPH_TOKEN_KEY);
    // Order of the ids given never matters; a deleted graph's id (GONE) is ignored.
    expect(await s.aliasesFor([BASE.graphId, GONE, HOME])).toEqual(["home", "work"]);
    expect(await s.aliasesFor([HOME, BASE.graphId])).toEqual(["home", "work"]);
    expect(await s.aliasesFor([GONE])).toEqual([]);
    expect(measured).toHaveLength(3);
    for (const m of measured) expect(m.rowsWritten).toBe(0);
    // Searched through the graph_id index: a few rows per id given (index, row and the sort), never
    // a scan of the table. One id reads one row.
    expect(measured[0].rowsRead).toBeLessThanOrEqual(3 * 3);
    expect(measured[2].rowsRead).toBeLessThanOrEqual(3);
  });

  it("follows a renamed alias, since it reads by graph id; an empty list reads nothing", async () => {
    await store().add(BASE);
    await store().update("work", { alias: "work2" });
    const { db, measured } = metered();
    const s = new GraphStore(db, env.GRAPH_TOKEN_KEY);
    expect(await s.aliasesFor([BASE.graphId])).toEqual(["work2"]);
    expect(await s.aliasesFor([])).toEqual([]);
    expect(measured).toHaveLength(1);
  });
});
