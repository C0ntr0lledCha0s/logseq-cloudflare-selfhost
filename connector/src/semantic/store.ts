import type { BlockDocument } from "./document";

export type IndexStatus = "building" | "ready" | "full" | "error" | "skipped-e2ee";

/** The indexer's position for one graph (table semantic_state). */
export interface IndexState {
  graphId: string;
  /** listBlockChanges epoch of the last full listing; null before one starts. */
  epoch: string | null;
  /** Feed position after the last complete listing; null until a full listing completes. */
  t: number | null;
  /** Position the listing in progress started at. */
  pendingT: number | null;
  /** next-cursor of the listing in progress; null between listings. */
  cursor: string | null;
  /** Last block UUID of the full listing in progress, the lower end of the next page's range. */
  lastUuid: string | null;
  status: IndexStatus;
  error: string | null;
  leaseUntil: number;
  indexedAt: string | null;
}

/** A stored block, as semantic_search returns it. */
export interface StoredBlock {
  vectorId: string;
  graphId: string;
  uuid: string;
  pageId: string;
  pageTitle: string;
  breadcrumb: string[];
  text: string;
  tags: string[];
  hash: string;
}

interface StateRow {
  graph_id: string;
  epoch: string | null;
  t: number | null;
  pending_t: number | null;
  cursor: string | null;
  last_uuid: string | null;
  status: IndexStatus;
  error: string | null;
  lease_until: number;
  indexed_at: string | null;
}

interface BlockRow {
  vector_id: string;
  graph_id: string;
  block_uuid: string;
  page_uuid: string;
  page_title: string;
  breadcrumb: string;
  text: string;
  tags: string;
  hash: string;
}

function toState(row: StateRow): IndexState {
  return {
    graphId: row.graph_id,
    epoch: row.epoch,
    t: row.t,
    pendingT: row.pending_t,
    cursor: row.cursor,
    lastUuid: row.last_uuid,
    status: row.status,
    error: row.error,
    leaseUntil: row.lease_until,
    indexedAt: row.indexed_at,
  };
}

function toBlock(row: BlockRow): StoredBlock {
  return {
    vectorId: row.vector_id,
    graphId: row.graph_id,
    uuid: row.block_uuid,
    pageId: row.page_uuid,
    pageTitle: row.page_title,
    breadcrumb: JSON.parse(row.breadcrumb) as string[],
    text: row.text,
    tags: JSON.parse(row.tags) as string[],
    hash: row.hash,
  };
}

/** A fresh graph: nothing listed yet. */
export function initialState(graphId: string): IndexState {
  return {
    graphId,
    epoch: null,
    t: null,
    pendingT: null,
    cursor: null,
    lastUuid: null,
    status: "building",
    error: null,
    leaseUntil: 0,
    indexedAt: null,
  };
}

const BLOCK_COLUMNS = "vector_id, graph_id, block_uuid, page_uuid, page_title, breadcrumb, text, tags, hash";

/** What one feed page changes, written in one D1 batch with the graph's new state. */
export interface PageCommit {
  upserts: BlockDocument[];
  deleteVectorIds: string[];
  state: IndexState;
}

/** The semantic_* tables in the connector's D1 database. Every call is one D1 round trip. */
export class SemanticStore {
  constructor(private readonly db: D1Database) {}

  async states(): Promise<IndexState[]> {
    const { results } = await this.db.prepare("SELECT * FROM semantic_state").all<StateRow>();
    return results.map(toState);
  }

  async state(graphId: string): Promise<IndexState | null> {
    const row = await this.db.prepare("SELECT * FROM semantic_state WHERE graph_id = ?").bind(graphId).first<StateRow>();
    return row ? toState(row) : null;
  }

  /**
   * Takes the graph for `LEASE_MS` from `now` unless another run holds it, creating its state on
   * first use. Returns the state, or null when the graph is leased elsewhere.
   */
  async lease(graphId: string, now: number, until: number): Promise<IndexState | null> {
    const fresh = initialState(graphId);
    const row = await this.db
      .prepare(
        `INSERT INTO semantic_state (graph_id, status, lease_until) VALUES (?, ?, ?)
         ON CONFLICT(graph_id) DO UPDATE SET lease_until = excluded.lease_until
         WHERE semantic_state.lease_until <= ?
         RETURNING *`,
      )
      .bind(graphId, fresh.status, until, now)
      .first<StateRow>();
    return row ? toState(row) : null;
  }

  /**
   * Stored rows for these block UUIDs, and the rows in the UUID range (lo, hi] when given. Both use
   * the (graph_id, block_uuid) index, so a run reads only the rows it needs (D1 bills rows read).
   */
  async lookup(
    graphId: string,
    uuids: string[],
    range: { lo: string | null; hi: string | null } | null,
  ): Promise<{ rows: StoredBlock[]; inRange: StoredBlock[] }> {
    const statements = [
      this.db
        .prepare(
          `SELECT ${BLOCK_COLUMNS} FROM semantic_blocks
           WHERE graph_id = ? AND block_uuid IN (SELECT value FROM json_each(?))`,
        )
        .bind(graphId, JSON.stringify(uuids)),
    ];
    if (range) {
      const upper = range.hi === null ? "" : " AND block_uuid <= ?";
      const args = range.hi === null ? [graphId, range.lo ?? ""] : [graphId, range.lo ?? "", range.hi];
      statements.push(
        this.db
          .prepare(`SELECT ${BLOCK_COLUMNS} FROM semantic_blocks WHERE graph_id = ? AND block_uuid > ?${upper}`)
          .bind(...args),
      );
    }
    const [rows, inRange] = await this.db.batch(statements);
    return {
      rows: (rows.results as BlockRow[]).map(toBlock),
      inRange: inRange ? (inRange.results as BlockRow[]).map(toBlock) : [],
    };
  }

  /** Vectors stored across all graphs. Reads every row, so call it only when a page adds vectors. */
  async total(): Promise<number> {
    const row = await this.db.prepare("SELECT count(*) AS n FROM semantic_blocks").first<{ n: number }>();
    if (row === null) throw new Error("count(*) returned no row");
    return row.n;
  }

  /** The page's block writes and deletes and the graph's new state, atomically. */
  async commit({ upserts, deleteVectorIds, state }: PageCommit): Promise<void> {
    const statements = upserts.map((d) =>
      this.db
        .prepare(
          `INSERT INTO semantic_blocks (${BLOCK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(vector_id) DO UPDATE SET page_uuid = excluded.page_uuid, page_title = excluded.page_title,
             breadcrumb = excluded.breadcrumb, text = excluded.text, tags = excluded.tags, hash = excluded.hash`,
        )
        .bind(
          d.vectorId,
          state.graphId,
          d.uuid,
          d.pageId,
          d.pageTitle,
          JSON.stringify(d.breadcrumb),
          d.text,
          JSON.stringify(d.tags),
          d.hash,
        ),
    );
    if (deleteVectorIds.length > 0) {
      statements.push(
        this.db
          .prepare("DELETE FROM semantic_blocks WHERE vector_id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(deleteVectorIds)),
      );
    }
    statements.push(this.saveStatement(state));
    await this.db.batch(statements);
  }

  async save(state: IndexState): Promise<void> {
    await this.saveStatement(state).run();
  }

  private saveStatement(s: IndexState): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE semantic_state SET epoch = ?, t = ?, pending_t = ?, cursor = ?, last_uuid = ?, status = ?, error = ?,
           indexed_at = ? WHERE graph_id = ?`,
      )
      .bind(s.epoch, s.t, s.pendingT, s.cursor, s.lastUuid, s.status, s.error, s.indexedAt, s.graphId);
  }

  /**
   * Up to `limit` vector IDs of graphs that are no longer connected, after dropping the state of
   * disconnected graphs that have no rows left.
   */
  async orphans(limit: number): Promise<string[]> {
    const [, orphans] = await this.db.batch([
      this.db.prepare(
        `DELETE FROM semantic_state WHERE graph_id NOT IN (SELECT graph_id FROM graphs)
         AND NOT EXISTS (SELECT 1 FROM semantic_blocks b WHERE b.graph_id = semantic_state.graph_id)`,
      ),
      // Every graph with stored rows has a state row (lease creates it before any write, and it is
      // dropped above only once no rows are left), so pick the disconnected graphs from the few state
      // rows and reach their blocks through the (graph_id, block_uuid) index. Filtering the blocks
      // directly, or as a JOIN, scans every block on every run (measured on D1: 2 rows read vs 10,100).
      this.db
        .prepare(
          `SELECT vector_id FROM semantic_blocks WHERE graph_id IN
             (SELECT graph_id FROM semantic_state WHERE graph_id NOT IN (SELECT graph_id FROM graphs))
           LIMIT ?`,
        )
        .bind(limit),
    ]);
    return (orphans.results as { vector_id: string }[]).map((r) => r.vector_id);
  }

  async deleteVectors(vectorIds: string[]): Promise<void> {
    await this.db
      .prepare("DELETE FROM semantic_blocks WHERE vector_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(vectorIds))
      .run();
  }

  /** Stored blocks of one graph by vector ID, and by block UUID, in one round trip. */
  async blocksFor(graphId: string, vectorIds: string[], uuids: string[]): Promise<StoredBlock[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${BLOCK_COLUMNS} FROM semantic_blocks WHERE graph_id = ?
         AND (vector_id IN (SELECT value FROM json_each(?)) OR block_uuid IN (SELECT value FROM json_each(?)))`,
      )
      .bind(graphId, JSON.stringify(vectorIds), JSON.stringify(uuids))
      .all<BlockRow>();
    return results.map(toBlock);
  }

  /** Indexed blocks of one graph, and of all graphs. */
  async counts(graphId: string): Promise<{ graph: number; total: number }> {
    const row = await this.db
      .prepare(
        "SELECT (SELECT count(*) FROM semantic_blocks WHERE graph_id = ?) AS graph, (SELECT count(*) FROM semantic_blocks) AS total",
      )
      .bind(graphId)
      .first<{ graph: number; total: number }>();
    if (!row) throw new Error("count query returned no row");
    return row;
  }
}
