import type { CallToolResult } from "@modelcontextprotocol/server";
import { auditRetentionDays } from "../config";
import { ToolError, lookupGraph, resolveGraph, withCallGraphs } from "../tools/common";
import { type AffectedTarget, describeWrite, takeReason } from "../tools/readable";
import type { TokenScope } from "../auth/service-tokens";
import type { GraphAccess } from "../tools/semantic";
import { DRY_RUN_TOOLS, declaredDryRun, deleteReason, noDeleteMessage } from "../tools/deletes.mjs";
import { type Snapshot, SnapshotRefusal, refreshRefsBefore, snapshotClassFor, takeSnapshot } from "./snapshot";

/**
 * The owner-only write log (design 2026-11-07-connector-write-audit-log §3.2, §3.6). A write call
 * inserts a `pending` row with `begin`, runs, and completes it with `finish`. Each statement's D1 cost
 * is pinned by test/audit-log.test.ts from D1's own meta:
 *
 *   begin   INSERT                2 written (row and index entry), 0 read
 *   finish  UPDATE by primary key 1 written, 1 read
 *   get     SELECT by primary key 1 read
 *   query   an aggregate over at most QUERY_SCAN_CAP - 1 - limit rows of the (graph_id, at) index,
 *           then at most `limit` rows by primary key: at most QUERY_SCAN_CAP read. With
 *           includeSnapshot the scan is `limit` rows shorter, and the snapshots that fit the result
 *           are read by primary key after the page: still at most QUERY_SCAN_CAP
 *   recordRead INSERT of a kind = 'read' row, 2 written (READ_ROW_WRITES), 0 read
 *   recordTokenEdit INSERT of a token_edit row with graph_id NULL, 2 written, 0 read; the
 *           wizard's form (tokenEditStatement with `applied`) also reads the token row: 1 read
 *   probe   SELECT … LIMIT 0      0 read
 *   purge   oldest-row probe 1 read; with old rows, a DELETE over at most PURGE_BATCH ids
 *           (at most 501 more read, 1 written per row deleted)
 *
 * A delete refused for a write-no-delete token (status `no-delete`) costs what a read-only refusal
 * does: begin and finish, no snapshot read and no sync request. The delete check itself reads nothing.
 */

/** Rows the outcome UPDATE by primary key writes, and reads. */
export const AUDIT_UPDATE_ROWS = 1;
/** The most rows one purge run deletes. */
export const PURGE_BATCH = 500;
/** The most rows one `query` reads: it scans this many less its page size, then reads the page by id. */
export const QUERY_SCAN_CAP = 500;
/** Rows a `recordRead` INSERT writes (the row and its index entry), stored on the row it inserts. */
export const READ_ROW_WRITES = 2;

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
  /** Page titles and UUIDs known before the write (from the call and its snapshot), so a pending row is found by page. */
  pages?: string[];
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
  /** A snapshot known only after the write (refresh_refs' own before-text); when absent, `before` is kept. */
  before?: string | null;
}

/** A position in the log, newest first: rows strictly older than `(at, id)` come next. */
export interface AuditCursor {
  at: number;
  id: number;
}

/** One `query` (design §3.5): a window, optional filters, a page size and where to resume. */
export interface AuditQuery {
  /** Inclusive, ms since the epoch. */
  since: number;
  /** Exclusive, ms since the epoch. */
  until: number;
  /** A page UUID or title, matched as one whole line of `pages`, ignoring case. */
  page?: string;
  tool?: string;
  session?: string;
  /** A status; `ok` leaves dry runs out, and `dry-run` is every dry run whatever its status. */
  status?: AuditStatus | "dry-run";
  limit: number;
  cursor?: AuditCursor;
  includeSnapshot?: boolean;
  /**
   * With includeSnapshot, the most snapshot characters fetched: the page stops before the entry whose
   * snapshot would pass it (the first entry is always returned), and the cursor resumes there.
   */
  snapshotChars?: number;
}

/** A page of entries, newest first, and the cursor to the rest of the window (null when it is exhausted). */
export interface AuditPage {
  entries: AuditRow[];
  nextCursor: AuditCursor | null;
  /** The rows the capped scan read from the window. */
  scanned: number;
  /** D1's own count of the rows both statements read. */
  rowsRead: number;
}

/** One applied service token edit (design 2026-11-08-edit-service-token-scope §3.6). */
export interface TokenEdit {
  at: number;
  /** The token's name; the row's alias is `service:<name>`. */
  name: string;
  /** The owner's GitHub user id; the row's session is `github:<ownerId>`. */
  ownerId: number;
  /** The values the guarded UPDATE matched on. */
  before: TokenScope;
  /** The values the edit stores. */
  after: TokenScope;
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

/** The `pages` column: lower-cased, '\n'-joined, each once; null when there are none. */
function joinPages(pages: string[]): string | null {
  const lower = [...new Set(pages.map((p) => p.toLowerCase()))];
  return lower.length === 0 ? null : lower.join("\n");
}

/** Ids from a scan, as integers, inlined as a VALUES list since D1 binds at most 100 values. */
function idList(ids: readonly (readonly number[])[]): string {
  return ids.map(([id]) => `(${Math.trunc(id)})`).join(", ");
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
        `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, dry_run, reason, client, session, addressed, pages, before)
         VALUES (?, ?, ?, ?, 'write', 'pending', ?, ?, ?, ?, ?, ?, ?)`,
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
        joinPages(entry.pages ?? []),
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
    const pages = joinPages(outcome.pages);
    const result = await this.db
      .prepare(
        `UPDATE audit_log SET status = ?, error = ?, targets = ?, pages = ?, before = coalesce(?, before), rows_written = ?, rows_read = ? WHERE id = ?`,
      )
      .bind(
        outcome.status,
        outcome.error,
        outcome.targets === null ? null : JSON.stringify(outcome.targets),
        pages,
        outcome.before ?? null,
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
    return (await this.lookup(graphId, id)).row;
  }

  /** `get`, with D1's count of the rows it read. */
  async lookup(graphId: string, id: number): Promise<{ row: AuditRow | null; rowsRead: number }> {
    const { results, meta } = await this.db
      .prepare("SELECT * FROM audit_log WHERE id = ? AND graph_id = ?")
      .bind(id, graphId)
      .all<Row>();
    return { row: results[0] === undefined ? null : toAuditRow(results[0]), rowsRead: meta.rows_read };
  }

  /**
   * One page of a graph's write entries, newest first (design §3.5), reading at most
   * QUERY_SCAN_CAP rows. Two statements, each measured from D1's meta:
   *
   * 1. An aggregate over the window and cursor, scanned over the (graph_id, at) index with
   *    `LIMIT QUERY_SCAN_CAP - 1 - limit`, newest first (the 1 is the cursor's own row, read and skipped). `kind` and the filters are applied outside the
   *    scan, so a read row or a selective filter costs nothing extra. It answers how many rows it
   *    scanned, the last one scanned, and the `(id, at)` of each match: one row read per row scanned.
   * 2. The first `limit` matches by primary key, joined from a `VALUES` list: one row read per entry.
   *
   * When the matches fill the page, the next page resumes after its last entry; otherwise after the
   * last row scanned, not the last row returned, so a match further down the window is never skipped.
   * The cursor is null once a scan comes back short. A window function or a materialised CTE would
   * do this in one statement, but each reads the scanned rows again from a temporary table (1,501
   * and 1,500 rows for a 500-row scan, measured). An `IN` list or `json_each` reads two rows per id,
   * D1 refuses a compound SELECT of more than a few terms, and a batch spends one of the invocation's
   * D1 queries per id.
   * Rows sharing the cursor's millisecond with a higher id are read and skipped, so a cursor inside a
   * run of rows with the same `at` reads that many more. `before` is selected only with `includeSnapshot`,
   * by a third statement after the page, and only for the entries whose snapshots fit `snapshotChars`
   * (their lengths come with the page), so a page of large snapshots never fetches more than one result holds.
   */
  async query(graphId: string, q: AuditQuery): Promise<AuditPage> {
    // The FILTER clause comes first in the statement's text, so its values are bound first.
    const filters: string[] = ["kind = 'write'"];
    const binds: unknown[] = [];
    if (q.page !== undefined) {
      filters.push("instr(char(10) || pages || char(10), char(10) || ? || char(10)) > 0");
      binds.push(q.page.toLowerCase());
    }
    if (q.tool !== undefined) {
      filters.push("tool = ?");
      binds.push(q.tool);
    }
    if (q.session !== undefined) {
      filters.push("session = ?");
      binds.push(q.session);
    }
    if (q.status === "dry-run") {
      filters.push("dry_run = 1");
    } else if (q.status === "ok") {
      filters.push("status = 'ok' AND dry_run = 0");
    } else if (q.status !== undefined) {
      filters.push("status = ?");
      binds.push(q.status);
    }
    // One upper bound on `at`: given two (until and the cursor), the planner bounds the index range by one only.
    const from = q.cursor !== undefined && q.cursor.at < q.until ? q.cursor : { at: q.until - 1, id: Number.MAX_SAFE_INTEGER };
    binds.push(graphId, q.since, from.at, from.at, from.id);
    // One row of the budget is the cursor's own row, which the scan reads and skips; with
    // includeSnapshot, another `limit` rows are kept for the snapshot fetch.
    const scanCap = QUERY_SCAN_CAP - 1 - q.limit * (q.includeSnapshot ? 2 : 1);
    const scan = await this.db
      .prepare(
        `SELECT count(*) AS scanned, min(printf('%015d.%015d', at, id)) AS last,
                json_group_array(json_array(id, at)) FILTER (WHERE ${filters.join(" AND ")}) AS hits
         FROM (
           SELECT id, at, kind, tool, session, status, dry_run, pages FROM audit_log
           WHERE graph_id = ? AND at >= ? AND at <= ? AND (at, id) < (?, ?)
           ORDER BY at DESC, id DESC LIMIT ${scanCap}
         )`,
      )
      .bind(...binds)
      .all<{ scanned: number; last: string | null; hits: string | null }>();
    const head = scan.results[0];
    const scanned = head?.scanned ?? 0;
    const hits = (JSON.parse(head?.hits ?? "[]") as [number, number][]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    let taken = hits.slice(0, q.limit);
    let nextCursor: AuditCursor | null = null;
    if (hits.length > q.limit) {
      const [id, at] = taken[taken.length - 1];
      nextCursor = { at, id };
    } else if (scanned >= scanCap && head?.last) {
      const [at, id] = head.last.split(".").map(Number);
      nextCursor = { at, id };
    }
    let rowsRead = scan.meta.rows_read;
    let entries: AuditRow[] = [];
    if (taken.length > 0) {
      // The snapshot's length, not the snapshot: it is fetched below only for the entries that fit.
      const columns = `a.id, a.at, a.graph_id, a.alias, a.tool, a.kind, a.status, a.dry_run, a.reason, a.client, a.session, a.addressed, a.pages, a.targets, ${
        q.includeSnapshot ? "length(a.before) AS before_chars" : "NULL AS before_chars"
      }, NULL AS before, a.error, a.rows_written, a.rows_read`;
      const fetched = await this.db
        .prepare(`SELECT ${columns} FROM (VALUES ${idList(taken)}) AS ids CROSS JOIN audit_log AS a ON a.id = ids.column1`)
        .all<Row & { before_chars: number | null }>();
      rowsRead += fetched.meta.rows_read;
      const byId = new Map(fetched.results.map((r) => [r.id, r]));
      let rows = taken.flatMap(([id]) => {
        const r = byId.get(id);
        return r === undefined ? [] : [r];
      });
      if (q.includeSnapshot) {
        // Entries newest first while their snapshots fit the budget; the cursor resumes after the last.
        const budget = q.snapshotChars ?? Number.POSITIVE_INFINITY;
        let used = 0;
        let kept = 0;
        while (kept < rows.length) {
          const chars = rows[kept].before_chars ?? 0;
          if (kept > 0 && used + chars > budget) break;
          used += chars;
          kept += 1;
        }
        if (kept < rows.length) {
          rows = rows.slice(0, kept);
          taken = taken.slice(0, kept);
          const last = rows[kept - 1];
          nextCursor = { at: last.at, id: last.id };
        }
        const withBefore = rows.filter((r) => r.before_chars !== null);
        if (withBefore.length > 0) {
          const snapshots = await this.db
            .prepare(`SELECT a.id, a.before FROM (VALUES ${idList(withBefore.map((r) => [r.id]))}) AS ids CROSS JOIN audit_log AS a ON a.id = ids.column1`)
            .all<{ id: number; before: string | null }>();
          rowsRead += snapshots.meta.rows_read;
          const befores = new Map(snapshots.results.map((r) => [r.id, r.before]));
          rows = rows.map((r) => ({ ...r, before: befores.get(r.id) ?? null }));
        }
      }
      entries = rows.map(toAuditRow);
    }
    return { entries, nextCursor, scanned, rowsRead };
  }

  /**
   * Records one get_activity_log call as a `kind = 'read'` row: the graph, the window or id it
   * read (`addressed`) and the rows its query read, so the usage report sees the log's read cost.
   */
  async recordRead(graphId: string, alias: string, addressed: string[], rowsRead: number): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, addressed, rows_written, rows_read)
         VALUES (?, ?, ?, 'get_activity_log', 'read', 'ok', ?, ?, ?)`,
      )
      .bind(Date.now(), graphId, alias, JSON.stringify(addressed), READ_ROW_WRITES, rowsRead)
      .run();
    return result.meta.last_row_id;
  }

  /**
   * Records one applied service token edit and answers the row's id. The wizard does not call it: it
   * batches tokenEditStatement with the token's UPDATE instead, so an edit never lands without its row.
   */
  async recordTokenEdit(edit: TokenEdit): Promise<number> {
    return (await this.tokenEditStatement(edit).run()).meta.last_row_id;
  }

  /**
   * The INSERT of one service token edit's row, unrun. `graph_id` is NULL, so no `get`, `lookup`,
   * `query` or get_activity_log call returns it. The scopes go inside `before.data`, not `targets`,
   * which readers parse as AffectedTarget[]; only the three scope fields are kept, so the row holds
   * names and ids and never the token or its hash. `added` and `removed` are by set, in the order the
   * after and before lists give.
   *
   * With `applied`, the row is inserted only when the token row holds `edit.after` with `updated_at`
   * = `applied.updatedAt`, which is what the edit's guarded UPDATE leaves when it wrote. Batched right
   * after that UPDATE, the pair commits or rolls back together, and a guard miss inserts nothing. The
   * check reads the token row by primary key: 1 row read.
   */
  tokenEditStatement(edit: TokenEdit, applied?: { tokenId: string; updatedAt: number }): D1PreparedStatement {
    const scope = (s: TokenScope) => ({ graphIds: s.graphIds, access: s.access, expiresAt: s.expiresAt });
    const had = new Set(edit.before.graphIds);
    const has = new Set(edit.after.graphIds);
    const data = {
      before: scope(edit.before),
      after: scope(edit.after),
      added: [...has].filter((g) => !had.has(g)),
      removed: [...had].filter((g) => !has.has(g)),
    };
    const values = [edit.at, `service:${edit.name}`, `github:${edit.ownerId}`, JSON.stringify({ source: "service_tokens", data })];
    const insert = `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, client, session, before)
         SELECT ?, NULL, ?, 'token_edit', 'write', 'ok', 'wizard', ?, ?`;
    if (!applied) return this.db.prepare(insert).bind(...values);
    return this.db
      .prepare(
        `${insert}
          WHERE EXISTS (SELECT 1 FROM service_tokens
                         WHERE id = ? AND updated_at = ? AND revoked_at IS NULL
                           AND graph_ids = ? AND access = ? AND expires_at = ?)`,
      )
      .bind(...values, applied.tokenId, applied.updatedAt, JSON.stringify(edit.after.graphIds), edit.after.access, edit.after.expiresAt);
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
const REFUSALS = new Set(["refused", "unknown-graph", "read-only", "out-of-scope", "no-delete"]);

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

/**
 * A dry run takes `dry-run: true` as a query argument or in its body. refresh_refs previews, writing
 * nothing, unless its body has `apply: true`.
 */
function isDryRun(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "refresh_refs" && record(args.body)?.apply !== true) return true;
  return args["dry-run"] === true || record(args.body)?.["dry-run"] === true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pages a call names, as given: each `page-id` and `page`, and each `target-id` that is a title
 * or date (a UUID there may be a block), at the top level, in `body` and in its entries and moves.
 */
export function pagesAddressed(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const take = (holder: Record<string, unknown> | undefined) => {
    if (!holder) return;
    for (const key of ["page-id", "page"]) if (typeof holder[key] === "string" && holder[key] !== "") out.add(holder[key]);
    const target = holder["target-id"];
    if (typeof target === "string" && target !== "" && !UUID.test(target)) out.add(target);
  };
  take(args);
  const body = record(args.body);
  take(body);
  for (const list of [body?.entries, body?.moves]) {
    if (Array.isArray(list)) for (const item of list) take(record(item));
  }
  return [...out];
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
 * and graph checks, the before-snapshot (§3.4; a delete's dry run reads and checks it but keeps none), a `pending` row holding it, the
 * write, then the outcome on that row. A refusal before the write is logged too, including a delete
 * whose snapshot can't be taken in full. A pending row that can't be stored refuses the write before anything reaches
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
  const plan = snapshotClassFor(tool);
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
      const graph = await resolveGraph(ctx.access, alias, true);
      // A write-no-delete token: a call the delete table classes as a delete is refused here, before
      // the snapshot, unless it is a dry run where its operation declares one (spec §3.5).
      const by = graph.deletesRefusedBy;
      const why = by === undefined ? null : deleteReason(tool, rest);
      if (by !== undefined && why !== null && !declaredDryRun(tool, rest)) {
        throw new ToolError(noDeleteMessage(by, tool, alias, why, Object.hasOwn(DRY_RUN_TOOLS, tool)), "no-delete");
      }
    } catch (error) {
      refusal = error;
    }

    const dryRun = isDryRun(tool, args);
    // A delete's dry run reads too, so it is refused as the real call would be; it keeps no snapshot.
    const reads = !dryRun || ("delete" in plan && plan.delete !== undefined);
    let snapshot: Snapshot = { before: null, pages: [] };
    if (refusal === undefined && reads) {
      try {
        snapshot = await takeSnapshot(ctx.access, alias, tool, rest);
        if (dryRun) snapshot = { ...snapshot, before: null };
      } catch (error) {
        refusal = error;
        if (error instanceof SnapshotRefusal) snapshot = error.snapshot;
      }
    }
    // Found by page whatever the outcome: the pages the call names and its snapshot read.
    const known = [...pagesAddressed(args), ...snapshot.pages, ...pagesOf(snapshot.subject ? [snapshot.subject] : [])];

    let id: number;
    try {
      id = await ctx.log.begin({
        at: Date.now(),
        graphId,
        alias,
        tool,
        dryRun,
        reason: reason ?? null,
        client: ctx.client,
        session: ctx.session,
        addressed: addressedBy(args),
        pages: known,
        before: snapshot.before,
      });
    } catch (error) {
      throw new ToolError(`audit log unavailable: ${messageOf(error)}; nothing was written`, "audit-unavailable");
    }

    const fail = async (error: unknown): Promise<unknown> => {
      const status = error instanceof ToolError && REFUSALS.has(error.status) ? "refused" : "error";
      try {
        await ctx.log.finish(id, { status, error: messageOf(error), targets: snapshot.subject ? [snapshot.subject] : null, pages: known });
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
    // A response that names nothing (update_page, promote_page_to_tag) is logged with the page its snapshot read.
    const logged = targets.length === 0 && snapshot.subject ? [snapshot.subject] : targets;
    const lines: string[] = [];
    try {
      const after = plan.source === "refresh_refs" ? refreshRefsBefore(result) : null;
      await ctx.log.finish(id, { status: "ok", error: null, targets: logged, pages: [...known, ...pagesOf(logged)], before: after });
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
