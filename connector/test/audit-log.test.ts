import { type D1Migration, createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AUDIT_UPDATE_ROWS, AuditLog, PURGE_BATCH, purgeAuditLog } from "../src/audit/log";
import { ConfigError, auditRetentionDays } from "../src/config";
import { KB_INDEX_CRON } from "../src/crons";
import { GraphStore } from "../src/graphs";
import { ServiceTokenStore, type TokenScope, hashServiceToken } from "../src/auth/service-tokens";
import { createConnector } from "../src/index";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12);
const CUTOFF = NOW - 90 * DAY_MS;
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

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

/** A DB whose statements on audit_log fail with a non-table error; everything else is the real D1. */
function failingAuditDb(message = "D1_ERROR: network connection lost"): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("audit_log")) {
            return {
              bind() {
                return this;
              },
              run: () => Promise.reject(new Error(message)),
              all: () => Promise.reject(new Error(message)),
            };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Seeds `n` rows at `at + i` (i from 0), in id order, with one recursive INSERT. */
async function seed(n: number, at: number, graphId = WORK_ID): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < ?1)
     INSERT INTO audit_log (at, graph_id, alias, tool, kind, status)
     SELECT ?2 + i, ?3, 'work', 'update_block', 'write', 'ok' FROM k`,
  )
    .bind(n, at, graphId)
    .run();
}

async function ats(): Promise<number[]> {
  const { results } = await env.DB.prepare("SELECT at FROM audit_log ORDER BY id").all<{ at: number }>();
  return results.map((r) => r.at);
}

const PENDING = {
  at: NOW,
  graphId: WORK_ID,
  alias: "work",
  tool: "delete_blocks",
  dryRun: false,
  reason: "Tidy the Meeting page",
  client: "claude-ai",
  session: "session-1",
  addressed: ["66666666-6666-6666-6666-666666666666"],
  before: JSON.stringify({ source: "getBlocks", data: { blocks: [] } }),
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM audit_log");
});

describe("AuditLog costs and rows", () => {
  it("begin then finish costs 3 rows written and 1 read, and the row records that cost", async () => {
    const { db, measured } = metered();
    const log = new AuditLog(db);
    const id = await log.begin(PENDING);
    await log.finish(id, {
      status: "ok",
      error: null,
      targets: [{ uuid: "66666666-6666-6666-6666-666666666666", "page-title": "Meeting" } as never],
      pages: ["Meeting", "77777777-7777-7777-7777-777777777777"],
    });
    expect(measured.map((m) => [m.rowsWritten, m.rowsRead])).toEqual([
      [2, 0],
      [AUDIT_UPDATE_ROWS, 1],
    ]);
    const written = measured.reduce((n, m) => n + m.rowsWritten, 0);
    const read = measured.reduce((n, m) => n + m.rowsRead, 0);
    expect([written, read]).toEqual([3, 1]);

    const row = await new AuditLog(env.DB).get(WORK_ID, id);
    expect(row).toMatchObject({
      id,
      at: NOW,
      graphId: WORK_ID,
      alias: "work",
      tool: "delete_blocks",
      kind: "write",
      status: "ok",
      dryRun: false,
      reason: "Tidy the Meeting page",
      client: "claude-ai",
      session: "session-1",
      addressed: JSON.stringify(PENDING.addressed),
      before: PENDING.before,
      error: null,
      pages: "meeting\n77777777-7777-7777-7777-777777777777",
      rowsWritten: written,
      rowsRead: read,
    });
    expect(JSON.parse(row!.targets!)).toEqual([{ uuid: "66666666-6666-6666-6666-666666666666", "page-title": "Meeting" }]);
  });

  it("a row left pending holds the snapshot with status pending, and a dry run with an error", async () => {
    const log = new AuditLog(env.DB);
    const pending = await log.begin(PENDING);
    expect(await log.get(WORK_ID, pending)).toMatchObject({ status: "pending", before: PENDING.before, targets: null });

    const dry = await log.begin({ ...PENDING, dryRun: true, before: null, graphId: null, addressed: [] });
    await log.finish(dry, { status: "refused", error: "unknown graph 'nope'", targets: null, pages: [] });
    const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(dry).all();
    expect(results[0]).toMatchObject({ dry_run: 1, graph_id: null, status: "refused", error: "unknown graph 'nope'", pages: null, targets: null });
  });

  it("the table refuses a kind or status outside its CHECKs", async () => {
    const insert = (kind: string, status: string) =>
      env.DB.prepare("INSERT INTO audit_log (at, alias, tool, kind, status) VALUES (1, 'work', 'update_block', ?, ?)")
        .bind(kind, status)
        .run();
    for (const status of ["pending", "ok", "error", "refused"]) await expect(insert("write", status)).resolves.toBeDefined();
    await expect(insert("read", "ok")).resolves.toBeDefined();
    for (const [kind, status] of [["write", "done"], ["write", "OK"], ["delete", "ok"]]) {
      await expect(insert(kind!, status!), `${kind} ${status}`).rejects.toThrow(/CHECK constraint failed/);
    }
  });

  it("finish of an id that has no row throws instead of succeeding silently", async () => {
    await expect(new AuditLog(env.DB).finish(424242, { status: "ok", error: null, targets: null, pages: [] })).rejects.toThrow(
      "audit entry 424242 not found",
    );
  });

  it("probe reads 0 rows on a table with rows", async () => {
    await seed(50, NOW);
    const { db, measured } = metered();
    expect(await new AuditLog(db).probe()).toBe("ok");
    expect(measured.map((m) => m.rowsRead)).toEqual([0]);
  });

  it("probe answers missing when the table was dropped", async () => {
    await env.DB.exec("DROP TABLE audit_log");
    try {
      expect(await new AuditLog(env.DB).probe()).toBe("missing");
    } finally {
      const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
      const audit = migrations.find((m) => m.name.startsWith("0004_"))!;
      for (const query of audit.queries) await env.DB.prepare(query).run();
    }
    expect(await new AuditLog(env.DB).probe()).toBe("ok");
  });

  it("probe rethrows any other error, and a missing table of another name", async () => {
    await expect(new AuditLog(failingAuditDb()).probe()).rejects.toThrow("network connection lost");
    await expect(
      new AuditLog(failingAuditDb("D1_ERROR: no such table: audit_log_old: SQLITE_ERROR")).probe(),
    ).rejects.toThrow("audit_log_old");
  });

  it("get reads one row by id; another graph's id or an unknown id answers null", async () => {
    await seed(200, NOW);
    await seed(1, NOW, OTHER_ID);
    const { results } = await env.DB.prepare("SELECT id, graph_id FROM audit_log ORDER BY id").all<{ id: number; graph_id: string }>();
    const mine = results[100]!.id;
    const theirs = results.find((r) => r.graph_id === OTHER_ID)!.id;

    const { db, measured } = metered();
    const log = new AuditLog(db);
    expect((await log.get(WORK_ID, mine))?.id).toBe(mine);
    expect(await log.get(WORK_ID, theirs)).toBeNull();
    expect(await log.get(WORK_ID, 999_999)).toBeNull();
    expect(measured.map((m) => m.rowsRead)).toEqual([1, 1, 1]);
  });
});

describe("recordTokenEdit", () => {
  // Spec 2026-11-08-edit-service-token-scope §3.6: one row per applied edit, outside every graph's log.
  const OWNER = 1001;
  const THIRD_ID = "33333333-3333-3333-3333-333333333333";
  const BEFORE: TokenScope = { graphIds: [WORK_ID, OTHER_ID], access: "write", expiresAt: NOW + 30 * DAY_MS };
  const AFTER: TokenScope = { graphIds: [THIRD_ID, WORK_ID], access: "read", expiresAt: NOW + 7 * DAY_MS };

  async function rawRow(id: number): Promise<Record<string, unknown>> {
    const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(id).all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    return results[0]!;
  }

  it("writes one row as spec §3.6, reading 0 rows and writing 2", async () => {
    const { db, measured } = metered();
    const id = await new AuditLog(db).recordTokenEdit({ at: NOW, name: "ci", ownerId: OWNER, before: BEFORE, after: AFTER });
    expect(measured.map((m) => [m.rowsRead, m.rowsWritten])).toEqual([[0, 2]]);
    const { results } = await env.DB.prepare("SELECT count(*) AS n FROM audit_log").all<{ n: number }>();
    expect(results[0]!.n).toBe(1);
    expect(await rawRow(id)).toEqual({
      id,
      at: NOW,
      graph_id: null,
      alias: "service:ci",
      tool: "token_edit",
      kind: "write",
      status: "ok",
      dry_run: 0,
      reason: null,
      client: "wizard",
      session: `github:${OWNER}`,
      addressed: null,
      pages: null,
      targets: null,
      before: JSON.stringify({
        source: "service_tokens",
        data: {
          before: { graphIds: [WORK_ID, OTHER_ID], access: "write", expiresAt: NOW + 30 * DAY_MS },
          after: { graphIds: [THIRD_ID, WORK_ID], access: "read", expiresAt: NOW + 7 * DAY_MS },
          added: [THIRD_ID],
          removed: [OTHER_ID],
        },
      }),
      error: null,
      rows_written: null,
      rows_read: null,
    });
  });

  it("added and removed are computed by set, in the order given, for each kind of graph change", async () => {
    const scope = (graphIds: string[]): TokenScope => ({ graphIds, access: "read", expiresAt: NOW + DAY_MS });
    const cases: [string, string[], string[], string[], string[]][] = [
      ["add one", [WORK_ID], [WORK_ID, OTHER_ID], [OTHER_ID], []],
      ["remove one", [WORK_ID, OTHER_ID], [WORK_ID], [], [OTHER_ID]],
      ["swap", [WORK_ID], [OTHER_ID], [OTHER_ID], [WORK_ID]],
      ["reorder only", [WORK_ID, OTHER_ID, THIRD_ID], [THIRD_ID, OTHER_ID, WORK_ID], [], []],
      ["add two, in the after order", [WORK_ID], [THIRD_ID, WORK_ID, OTHER_ID], [THIRD_ID, OTHER_ID], []],
      ["remove two, in the before order", [THIRD_ID, WORK_ID, OTHER_ID], [WORK_ID], [], [THIRD_ID, OTHER_ID]],
      ["chain: add and remove in reversed order", [OTHER_ID, WORK_ID], [THIRD_ID, OTHER_ID], [THIRD_ID], [WORK_ID]],
      ["a repeated id counts once", [WORK_ID, WORK_ID], [WORK_ID, OTHER_ID, OTHER_ID], [OTHER_ID], []],
      ["no graph change (access or expiry only)", [WORK_ID], [WORK_ID], [], []],
    ];
    const log = new AuditLog(env.DB);
    for (const [label, before, after, added, removed] of cases) {
      const id = await log.recordTokenEdit({ at: NOW, name: "ci", ownerId: OWNER, before: scope(before), after: scope(after) });
      const data = JSON.parse((await rawRow(id)).before as string).data;
      expect([data.added, data.removed], label).toEqual([added, removed]);
      expect([data.before.graphIds, data.after.graphIds], label).toEqual([before, after]);
    }
  });

  it("keeps only graphIds, access and expiresAt from each scope", async () => {
    const row = { ...BEFORE, id: "x", tokenHash: "f".repeat(64), token: "lsct_extra" } as TokenScope;
    const id = await new AuditLog(env.DB).recordTokenEdit({ at: NOW, name: "ci", ownerId: OWNER, before: row, after: row });
    const data = JSON.parse((await rawRow(id)).before as string).data;
    expect(Object.keys(data.before)).toEqual(["graphIds", "access", "expiresAt"]);
    expect(Object.keys(data.after)).toEqual(["graphIds", "access", "expiresAt"]);
  });

  it("holds no secret: no column contains the token or its hash", async () => {
    await env.DB.exec("DELETE FROM service_tokens");
    const store = new ServiceTokenStore(env.DB);
    const { id: tokenId, token } = await store.create({
      name: "nightly",
      ownerId: OWNER,
      graphIds: BEFORE.graphIds,
      access: BEFORE.access,
      createdAt: NOW - DAY_MS,
      expiresAt: BEFORE.expiresAt,
    });
    const hash = await hashServiceToken(token);
    const stored = await store.get(tokenId);
    const id = await new AuditLog(env.DB).recordTokenEdit({ at: NOW, name: stored!.name, ownerId: stored!.ownerId, before: stored!, after: AFTER });
    const row = await rawRow(id);
    expect(row.alias).toBe("service:nightly");
    for (const [column, value] of Object.entries(row)) {
      const text = String(value);
      expect(text, column).not.toContain(token);
      expect(text, column).not.toContain(token.slice(5));
      expect(text, column).not.toContain(hash);
      expect(text, column).not.toMatch(/lsct_/);
    }
  });

  it("targets stays NULL, so a reader parsing targets as AffectedTarget[] sees none", async () => {
    const id = await new AuditLog(env.DB).recordTokenEdit({ at: NOW, name: "ci", ownerId: OWNER, before: BEFORE, after: AFTER });
    const { results } = await env.DB.prepare("SELECT targets, addressed, pages FROM audit_log WHERE id = ?").bind(id).all();
    expect(results[0]).toEqual({ targets: null, addressed: null, pages: null });
  });

  it("no reader returns it: get, lookup and query for every graph it names, and any other", async () => {
    const log = new AuditLog(env.DB);
    const id = await log.recordTokenEdit({ at: NOW, name: "ci", ownerId: OWNER, before: BEFORE, after: AFTER });
    // A neighbour on each graph, so the readers are seen to return rows.
    const neighbours = new Map<string, number>();
    for (const graphId of [WORK_ID, OTHER_ID, THIRD_ID]) neighbours.set(graphId, await log.begin({ ...PENDING, graphId, at: NOW }));
    for (const graphId of [WORK_ID, OTHER_ID, THIRD_ID, "44444444-4444-4444-4444-444444444444", ""]) {
      expect(await log.get(graphId, id), graphId).toBeNull();
      expect((await log.lookup(graphId, id)).row, graphId).toBeNull();
      for (const status of [undefined, "ok", "pending"] as const) {
        const page = await log.query(graphId, { since: 0, until: NOW + DAY_MS, limit: 50, status, includeSnapshot: true });
        expect(page.entries.map((e) => e.id), `${graphId} ${status}`).not.toContain(id);
      }
      for (const filter of [{ tool: "token_edit" }, { session: `github:${OWNER}` }]) {
        const page = await log.query(graphId, { since: 0, until: NOW + DAY_MS, limit: 50, ...filter });
        expect(page.entries, `${graphId} ${JSON.stringify(filter)}`).toEqual([]);
      }
      const neighbour = neighbours.get(graphId);
      if (neighbour !== undefined) {
        const page = await log.query(graphId, { since: 0, until: NOW + DAY_MS, limit: 50 });
        expect(page.entries.map((e) => e.id), graphId).toEqual([neighbour]);
      }
    }
  });
});

describe("purge", () => {
  it("with nothing old reads 1 row over 3,001 recent rows", async () => {
    await seed(3001, NOW - DAY_MS);
    const { db, measured } = metered();
    expect(await new AuditLog(db).purge(CUTOFF)).toEqual({ deleted: 0, rowsRead: 1, rowsWritten: 0 });
    expect(measured.reduce((n, m) => n + m.rowsRead, 0)).toBe(1);
    expect((await ats()).length).toBe(3001);
  });

  it("with the oldest row exactly at the cutoff reads 1 row and keeps it", async () => {
    await seed(1, CUTOFF);
    await seed(700, NOW - DAY_MS);
    const { db, measured } = metered();
    expect(await new AuditLog(db).purge(CUTOFF)).toEqual({ deleted: 0, rowsRead: 1, rowsWritten: 0 });
    expect(measured).toHaveLength(1);
  });

  it("on an empty table reads 1 row and deletes nothing", async () => {
    expect(await new AuditLog(env.DB).purge(CUTOFF)).toEqual({ deleted: 0, rowsRead: 1, rowsWritten: 0 });
  });

  it("deletes only rows strictly past the cutoff, oldest first, at most 500 per run", async () => {
    const hundred = NOW - 100 * DAY_MS;
    await seed(600, hundred);
    await seed(1, NOW - 91 * DAY_MS);
    await seed(1, CUTOFF);
    await seed(1, NOW - 89 * DAY_MS);
    const log = new AuditLog(env.DB);

    const { db, measured } = metered();
    const first = await new AuditLog(db).purge(CUTOFF);
    // Measured: the probe reads 1, the id-range DELETE reads 501 and writes 1 per row deleted.
    expect(first).toEqual({ deleted: PURGE_BATCH, rowsRead: 2 + PURGE_BATCH, rowsWritten: PURGE_BATCH });
    expect(measured.map((m) => [m.rowsRead, m.rowsWritten])).toEqual([
      [1, 0],
      [1 + PURGE_BATCH, PURGE_BATCH],
    ]);
    const afterFirst = await ats();
    expect(afterFirst).toHaveLength(103);
    expect(afterFirst[0]).toBe(hundred + 500);

    const second = await log.purge(CUTOFF);
    expect(second).toEqual({ deleted: 101, rowsRead: 1 + 103, rowsWritten: 101 });
    expect(await ats()).toEqual([CUTOFF, NOW - 89 * DAY_MS]);

    expect(await log.purge(CUTOFF)).toEqual({ deleted: 0, rowsRead: 1, rowsWritten: 0 });
  });

  it("purgeAuditLog takes the cutoff from AUDIT_RETENTION_DAYS", async () => {
    await seed(1, NOW - 31 * DAY_MS);
    await seed(1, NOW - 30 * DAY_MS);
    const result = await purgeAuditLog({ ...env, AUDIT_RETENTION_DAYS: "30" } as Env, NOW);
    expect(result.deleted).toBe(1);
    expect(await ats()).toEqual([NOW - 30 * DAY_MS]);
  });
});

describe("auditRetentionDays", () => {
  it("defaults to 90 and accepts 1 to 365", () => {
    expect(auditRetentionDays({} as Env)).toBe(90);
    for (const [raw, days] of [
      ["1", 1],
      ["90", 90],
      ["365", 365],
    ] as const) {
      expect(auditRetentionDays({ AUDIT_RETENTION_DAYS: raw } as Env)).toBe(days);
    }
  });

  it("refuses 0, 366 and anything that is not a whole number, naming AUDIT_RETENTION_DAYS", () => {
    for (const raw of ["0", "366", "ninety", "", "1.5", "-1", " 90", "090", "1e2", "9007199254740993"]) {
      expect(() => auditRetentionDays({ AUDIT_RETENTION_DAYS: raw } as Env), raw).toThrow(ConfigError);
      expect(() => auditRetentionDays({ AUDIT_RETENTION_DAYS: raw } as Env), raw).toThrow(
        "AUDIT_RETENTION_DAYS must be a whole number of days from 1 to 365",
      );
    }
  });
});

describe("hourly cron", () => {
  let consoleSpies: MockInstance[];

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.KB_INDEX_KV.delete("kb-index:work");
    await new GraphStore(env.DB, env.GRAPH_TOKEN_KEY).add({
      alias: "work",
      graphId: WORK_ID,
      graphName: "work",
      mode: "write",
      permission: "both",
      expiresAt: null,
      token: "logseq_pat_workToken123",
    });
    consoleSpies = (["log", "error"] as const).map((m) => vi.spyOn(console, m));
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  function cronEnv(sync: (request: Request) => Response, over: Partial<Env> = {}): Env {
    const fetcher = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => sync(new Request(input, init)) };
    return { ...env, SYNC: fetcher as unknown as Fetcher, ...over } as Env;
  }

  function logged(): string[] {
    return consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
  }

  async function runCron(e: Env): Promise<void> {
    const connector = createConnector({ githubFetch: () => Promise.reject(new Error("no GitHub in tests")) });
    const ctx = createExecutionContext();
    try {
      await connector.scheduled!(createScheduledController({ cron: KB_INDEX_CRON, scheduledTime: NOW }), e, ctx);
    } finally {
      await waitOnExecutionContext(ctx);
    }
  }

  it("runs the purge even when the KB index refresh fails, and still surfaces the KB error", async () => {
    await seed(3, Date.now() - 200 * DAY_MS);
    await seed(2, Date.now() - DAY_MS);
    const e = cronEnv(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(runCron(e)).rejects.toThrow("kb index refresh failed for 1 of 1 graphs");
    expect(await ats()).toHaveLength(2);
    expect(logged().some((l) => /^audit-purge deleted=3 /.test(l))).toBe(true);
  });

  it("runs the KB index refresh when the purge fails, then surfaces the purge error", async () => {
    const kb: string[] = [];
    const e = cronEnv(
      (request) => {
        kb.push(new URL(request.url).pathname);
        return Response.json({ pages: [] });
      },
      { DB: failingAuditDb() },
    );
    await expect(runCron(e)).rejects.toThrow("network connection lost");
    expect(kb.length).toBeGreaterThan(0);
    expect(await env.KB_INDEX_KV.get("kb-index:work")).not.toBeNull();
    expect(logged()).toContain("audit-purge failed: D1_ERROR: network connection lost");
  });

  it("a malformed retention setting fails the purge, not the KB index refresh", async () => {
    await seed(1, Date.now() - 200 * DAY_MS);
    const e = cronEnv(() => Response.json({ pages: [] }), { AUDIT_RETENTION_DAYS: "0" } as Partial<Env>);
    await expect(runCron(e)).rejects.toThrow("AUDIT_RETENTION_DAYS");
    expect(await env.KB_INDEX_KV.get("kb-index:work")).not.toBeNull();
    expect(await ats()).toHaveLength(1);
  });
});
