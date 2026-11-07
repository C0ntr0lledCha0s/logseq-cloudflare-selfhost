import { auditRetentionDays } from "../config";
import type { AffectedTarget } from "../tools/readable";

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

  constructor(private readonly db: D1Database) {}

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
