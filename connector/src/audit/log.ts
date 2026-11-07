import type { CallToolResult } from "@modelcontextprotocol/server";
import { auditRetentionDays } from "../config";
import { ToolError, lookupGraph, resolveGraph, withCallGraphs } from "../tools/common";
import { type AffectedTarget, describeWrite, takeReason } from "../tools/readable";
import type { GraphAccess } from "../tools/semantic";

/**
 * The owner-only write log (design 2026-11-07-connector-write-audit-log §3.2, §3.6). A write call
 * inserts a `pending` row with `begin`, runs, and completes it with `finish`. Each statement's D1 cost
 * is pinned by test/audit-log.test.ts from D1's own meta:
 *
 *   begin   INSERT                2 written (row and index entry), 0 read
 *   finish  UPDATE by primary key 1 written, 1 read
 *   get     SELECT by primary key 1 read
 *   probe   SELECT … LIMIT 0      0 read
 *   purge   oldest-row probe 1 read; with old rows, a DELETE over at most PURGE_BATCH ids
 *           (at most 501 more read, 1 written per row deleted)
 */

/** Rows the outcome UPDATE by primary key writes, and reads. */
export const AUDIT_UPDATE_ROWS = 1;
/** The most rows one purge run deletes. */
export const PURGE_BATCH = 500;

const DAY_MS = 86_400_000;

export type AuditStatus = "pending" | "ok" | "error" | "refused";

/** One audit_log row (§3.2). JSON columns are kept as the stored text. */
export interface AuditRow {
  id: number;
  at: number;
  graphId: string | null;
  alias: string;
  tool: string;
  kind: "write" | "read";
  status: AuditStatus;
  dryRun: boolean;
  reason: string | null;
  client: string | null;
  session: string | null;
  /** JSON array of the UUIDs or selectors the call named. */
  addressed: string | null;
  /** Lower-cased page titles and UUIDs, '\n'-joined. */
  pages: string | null;
  /** JSON AffectedTarget[]. */
  targets: string | null;
  /** JSON {source, truncated?, e2ee?, error?, data}. */
  before: string | null;
  error: string | null;
  rowsWritten: number | null;
  rowsRead: number | null;
}

/** What `begin` stores in the pending row. */
export interface AuditBegin {
  at: number;
  graphId: string | null;
  alias: string;
  tool: string;
  dryRun: boolean;
  reason: string | null;
  client: string | null;
  session: string | null;
  addressed: string[];
  /** The before-snapshot as JSON text, stored without re-parsing; null when there is none. */
  before: string | null;
}

/** What `finish` records about the outcome. */
export interface AuditFinish {
  status: Exclude<AuditStatus, "pending">;
  error: string | null;
  targets: AffectedTarget[] | null;
  /** Page titles and UUIDs the call touched; stored lower-cased and '\n'-joined. */
  pages: string[];
}

export interface PurgeResult {
  deleted: number;
  rowsRead: number;
  rowsWritten: number;
}

interface Row {
  id: number;
  at: number;
  graph_id: string | null;
  alias: string;
  tool: string;
  kind: "write" | "read";
  status: AuditStatus;
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

function toAuditRow(row: Row): AuditRow {
  return {
    id: row.id,
    at: row.at,
    graphId: row.graph_id,
    alias: row.alias,
    tool: row.tool,
    kind: row.kind,
    status: row.status,
    dryRun: row.dry_run === 1,
    reason: row.reason,
    client: row.client,
    session: row.session,
    addressed: row.addressed,
    pages: row.pages,
    targets: row.targets,
    before: row.before,
    error: row.error,
    rowsWritten: row.rows_written,
    rowsRead: row.rows_read,
  };
}

const NO_SUCH_TABLE = /no such table: audit_log(?![A-Za-z0-9_])/;

/**
 * The audit_log table over D1. Every statement uses `run` or `all`, whose results carry D1's meta,
 * so each cost can be measured. One instance per isolate: `finish` reads the cost `begin` measured
 * for the same row from memory, so a row's own cost is stored without another statement.
 */
export class AuditLog {
  private readonly insertCost = new Map<number, { written: number; read: number }>();
  /** Set once a probe found the table; a missing table is probed again on the next write. */
  private present = false;

  constructor(private readonly db: D1Database) {}

  /** `probe`, run once per instance (one per isolate) while it answers "ok". */
  async ready(): Promise<"ok" | "missing"> {
    if (this.present) return "ok";
    const found = await this.probe();
    if (found === "ok") this.present = true;
    return found;
  }

  /** "missing" when migration 0004 has not been applied; any other error is rethrown. Reads 0 rows. */
  async probe(): Promise<"ok" | "missing"> {
    try {
      await this.db.prepare("SELECT 1 FROM audit_log LIMIT 0").run();
      return "ok";
    } catch (error) {
      if (error instanceof Error && NO_SUCH_TABLE.test(error.message)) return "missing";
      throw error;
    }
  }

  /** Inserts the pending row and answers its id. */
  async begin(entry: AuditBegin): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, dry_run, reason, client, session, addressed, before)
         VALUES (?, ?, ?, ?, 'write', 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.at,
        entry.graphId,
        entry.alias,
        entry.tool,
        entry.dryRun ? 1 : 0,
        entry.reason,
        entry.client,
        entry.session,
        JSON.stringify(entry.addressed),
        entry.before,
      )
      .run();
    const id = result.meta.last_row_id;
    this.insertCost.set(id, { written: result.meta.rows_written, read: result.meta.rows_read });
    return id;
  }

  /** Records the outcome on the row `begin` inserted, with the row's own D1 cost. Throws when no row has that id. */
  async finish(id: number, outcome: AuditFinish): Promise<void> {
    const insert = this.insertCost.get(id);
    const pages = outcome.pages.length === 0 ? null : outcome.pages.map((p) => p.toLowerCase()).join("\n");
    const result = await this.db
      .prepare(
        `UPDATE audit_log SET status = ?, error = ?, targets = ?, pages = ?, rows_written = ?, rows_read = ? WHERE id = ?`,
      )
      .bind(
        outcome.status,
        outcome.error,
        outcome.targets === null ? null : JSON.stringify(outcome.targets),
        pages,
        insert === undefined ? null : insert.written + AUDIT_UPDATE_ROWS,
        insert === undefined ? null : insert.read + AUDIT_UPDATE_ROWS,
        id,
      )
      .run();
    this.insertCost.delete(id);
    if (result.meta.changes !== 1) throw new Error(`audit entry ${id} not found`);
  }

  /** One row by id, or null when it doesn't exist or belongs to another graph. Reads 1 row. */
  async get(graphId: string, id: number): Promise<AuditRow | null> {
    const { results } = await this.db
      .prepare("SELECT * FROM audit_log WHERE id = ? AND graph_id = ?")
      .bind(id, graphId)
      .all<Row>();
    return results[0] === undefined ? null : toAuditRow(results[0]);
  }

  /**
   * Deletes the oldest rows older than `cutoff` (ms) among the PURGE_BATCH ids from the oldest, and
   * keeps a row at exactly the cutoff. The oldest-row probe comes first: a DELETE that searched for old
   * rows would read the whole table when nothing is old enough (3,002 rows over 3,001, measured). The
   * DELETE walks an id range from the oldest id rather than `id IN (SELECT … LIMIT 500)`, which
   * measured 2,000 rows read to delete 500; the range reads at most 501.
   */
  async purge(cutoff: number): Promise<PurgeResult> {
    const oldest = await this.db.prepare("SELECT id, at FROM audit_log ORDER BY id LIMIT 1").all<{ id: number; at: number }>();
    const rowsRead = oldest.meta.rows_read;
    const first = oldest.results[0];
    if (first === undefined || first.at >= cutoff) return { deleted: 0, rowsRead, rowsWritten: 0 };
    const result = await this.db
      .prepare("DELETE FROM audit_log WHERE id < ? AND at < ?")
      .bind(first.id + PURGE_BATCH, cutoff)
      .run();
    return {
      deleted: result.meta.changes,
      rowsRead: rowsRead + result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    };
  }
}

/** The hourly purge: removes entries older than AUDIT_RETENTION_DAYS (default 90) before `now`. */
export async function purgeAuditLog(env: Env, now: number): Promise<PurgeResult> {
  const cutoff = now - auditRetentionDays(env) * DAY_MS;
  return new AuditLog(env.DB).purge(cutoff);
}

/** What `audited()` needs for one request: the isolate's log and graphs, and who is calling. */
export interface AuditContext {
  log: AuditLog;
  access: GraphAccess;
  /** The User-Agent family (`userAgentFamily`), or null when no request named one. */
  client: string | null;
  /** The request's `mcp-session-id` header, or null. */
  session: string | null;
}

/** A write that ran: its result (summary first, ending with the entry line), and item 17's outcome. */
export interface AuditedWrite {
  result: CallToolResult;
  reason: string | undefined;
  targets: AffectedTarget[];
}

export const AUDIT_MIGRATION_MISSING = "audit log unavailable: migration 0004 has not been applied; nothing was written";

/** ToolError statuses that are refusals rather than failures: the call was turned down as given. */
const REFUSALS = new Set(["refused", "unknown-graph", "read-only"]);

/** The argument names whose string values name what a call addresses (UUIDs, titles, dates or idents). */
const ADDRESS_KEYS = ["block-id", "block-ids", "page-id", "target-id", "tag-id", "property-id", "page"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The UUIDs or selectors a call names, read only from the known argument names at the top level, in
 * `body` and in each of `body.entries` and `body.moves`. Never anything else: block text, property
 * values and other arguments stay out of the log.
 */
export function addressedBy(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const take = (holder: Record<string, unknown> | undefined) => {
    if (!holder) return;
    for (const key of ADDRESS_KEYS) {
      const value = holder[key];
      if (typeof value === "string") out.add(value);
      else if (Array.isArray(value)) for (const item of value) if (typeof item === "string") out.add(item);
    }
  };
  take(args);
  const body = record(args.body);
  take(body);
  for (const list of [body?.entries, body?.moves]) {
    if (Array.isArray(list)) for (const item of list) take(record(item));
  }
  return [...out];
}

/** A dry run takes `dry-run: true` as a query argument or in its body. */
function isDryRun(args: Record<string, unknown>): boolean {
  return args["dry-run"] === true || record(args.body)?.["dry-run"] === true;
}

/** Each page a write's targets name, by title and UUID, including where a move came from and went to. */
function pagesOf(targets: AffectedTarget[]): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    if (value !== undefined && value !== "") out.add(value);
  };
  for (const t of targets) {
    add(t.pageTitle);
    add(t.pageUuid);
    for (const loc of [t.from, t.to]) {
      add(loc?.pageTitle);
      add(loc?.pageUuid);
    }
  }
  return [...out];
}

/** The line a result gains when its entry could not be finished. */
function unfinished(id: number, error: unknown): string {
  return `Audit log entry ${id} could not be completed: ${messageOf(error)}`;
}

/**
 * Runs one write call with its audit entry (design §3.3): the probe (once per isolate), the reason
 * and graph checks, a `pending` row, the write, then the outcome on that row. A refusal before the
 * write is logged too. A pending row that can't be stored refuses the write before anything reaches
 * the sync server; an outcome that can't be stored leaves the write standing and leads the result
 * with a line saying so. `run` gets the arguments without `reason`. Throws what the call threw.
 */
export function audited(
  ctx: AuditContext,
  tool: string,
  alias: string,
  args: Record<string, unknown>,
  run: (rest: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<AuditedWrite> {
  return withCallGraphs(async () => {
    let probed: "ok" | "missing";
    try {
      probed = await ctx.log.ready();
    } catch (error) {
      throw new ToolError(`audit log unavailable: ${messageOf(error)}; nothing was written`, "audit-unavailable");
    }
    if (probed === "missing") throw new ToolError(AUDIT_MIGRATION_MISSING, "audit-unavailable");

    // The checks that ran before the handler today, in the same order, so a refusal reads as before.
    let graphId: string | null = null;
    let reason: string | undefined;
    let rest: Record<string, unknown> = args;
    let refusal: unknown;
    try {
      graphId = (await lookupGraph(ctx.access, alias))?.graphId ?? null;
      ({ reason, rest } = takeReason(args));
      await resolveGraph(ctx.access, alias, true);
    } catch (error) {
      refusal = error;
    }

    let id: number;
    try {
      id = await ctx.log.begin({
        at: Date.now(),
        graphId,
        alias,
        tool,
        dryRun: isDryRun(args),
        reason: reason ?? null,
        client: ctx.client,
        session: ctx.session,
        addressed: addressedBy(args),
        before: null,
      });
    } catch (error) {
      throw new ToolError(`audit log unavailable: ${messageOf(error)}; nothing was written`, "audit-unavailable");
    }

    const fail = async (error: unknown): Promise<unknown> => {
      const status = error instanceof ToolError && REFUSALS.has(error.status) ? "refused" : "error";
      try {
        await ctx.log.finish(id, { status, error: messageOf(error), targets: null, pages: [] });
      } catch (finishError) {
        if (error instanceof ToolError) return new ToolError(`${unfinished(id, finishError)}\n${error.message}`, error.status);
      }
      return error;
    };
    if (refusal !== undefined) throw await fail(refusal);

    let result: CallToolResult;
    try {
      result = await run(rest);
    } catch (error) {
      throw await fail(error);
    }

    const { targets, summary } = describeWrite(tool, result, reason);
    const lines: string[] = [];
    try {
      await ctx.log.finish(id, { status: "ok", error: null, targets, pages: pagesOf(targets) });
    } catch (error) {
      lines.push(unfinished(id, error));
    }
    if (summary !== "") lines.push(summary);
    lines.push(`Logged as audit entry ${id}`);
    return { result: { ...result, content: [{ type: "text", text: lines.join("\n") }, ...result.content] }, reason, targets };
  });
}

/** The short client family `client` stores: never the User-Agent itself (design §3.8). */
export function userAgentFamily(userAgent: string | null): "claude-ai" | "claude-code" | "other" {
  if (userAgent === null) return "other";
  if (/claude[-_ ]?(code|cli)/i.test(userAgent)) return "claude-code";
  if (/claude|anthropic/i.test(userAgent)) return "claude-ai";
  return "other";
}
