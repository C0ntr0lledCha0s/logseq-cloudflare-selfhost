import { connectorHostname } from "../config";
import type { GraphStore } from "../graphs";
import { SyncError, syncFetch } from "../sync";
import { DIMENSIONS, LEASE_MS, ORPHAN_BATCH, PAGES_PER_RUN, PAGE_SIZE, type SemanticBindings } from "./config";
import { type BlockDocument, type FeedPage, parseFeedPage, toDocument } from "./document";
import type { IndexState, SemanticStore, StoredBlock } from "./store";

// The cron indexer (design §4, §6). Each run deletes vectors of disconnected graphs, then reads at
// most PAGES_PER_RUN pages of the sync server's listBlockChanges feed across the connected graphs,
// least recently visited first. A page's vectors are written to Vectorize before its rows and cursor
// are committed to D1, so a failure part-way leaves the cursor where it was and the page is repeated;
// stored hashes make the repeat embed nothing it already has.

/** A failed Workers AI or Vectorize call: recorded on the graph and retried by the next run. */
export class BindingError extends Error {
  constructor(what: string, cause: unknown) {
    super(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BindingError";
  }
}

async function binding<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new BindingError(what, error);
  }
}

export interface IndexerDeps {
  env: Env;
  graphs: GraphStore;
  store: SemanticStore;
  bindings: SemanticBindings;
  now?: () => number;
}

export interface GraphRunReport {
  alias: string;
  status: IndexState["status"] | "leased" | "rate-limited";
  pages: number;
  embedded: number;
  deleted: number;
}

export interface RunReport {
  orphansDeleted: number;
  graphs: GraphRunReport[];
}

async function fetchFeed(env: Env, pat: string, state: IndexState): Promise<FeedPage> {
  const query: Record<string, string | number> = { limit: PAGE_SIZE };
  if (state.cursor !== null) query.cursor = state.cursor;
  if (state.t !== null) {
    if (state.epoch === null) throw new Error("index state has a position without an epoch");
    query.since = state.t;
    query.epoch = state.epoch;
  }
  const response = await syncFetch(env, pat, {
    method: "GET",
    path: `/api/v1/graphs/${encodeURIComponent(state.graphId)}/block-changes`,
    query,
  });
  return parseFeedPage(await response.json());
}

/** The state a graph restarts from: a full listing on the next page. */
function restart(state: IndexState): IndexState {
  return { ...state, epoch: null, t: null, pendingT: null, cursor: null, lastUuid: null, status: "building", error: null };
}

function sameState(a: IndexState, b: IndexState): boolean {
  return (
    a.epoch === b.epoch &&
    a.t === b.t &&
    a.pendingT === b.pendingT &&
    a.cursor === b.cursor &&
    a.lastUuid === b.lastUuid &&
    a.status === b.status &&
    a.error === b.error
  );
}

interface PageResult {
  state: IndexState;
  embedded: number;
  deleted: number;
  /** No further page is due this run: the listing finished, or the index is full. */
  done: boolean;
}

class Run {
  private dimensionsChecked = false;

  constructor(private readonly deps: IndexerDeps) {}

  private get index() {
    return this.deps.bindings.index;
  }

  /** Throws (a deploy error, not a graph's) when the bound index was created with other dimensions. */
  private async checkDimensions(): Promise<void> {
    if (this.dimensionsChecked) return;
    const info = await binding("Vectorize describe", () => this.index.describe());
    if (info.dimensions !== DIMENSIONS) {
      throw new Error(`the Vectorize index has ${info.dimensions} dimensions; semantic search needs ${DIMENSIONS}`);
    }
    this.dimensionsChecked = true;
  }

  async deleteOrphans(): Promise<number> {
    const ids = await this.deps.store.orphans(ORPHAN_BATCH);
    if (ids.length === 0) return 0;
    await this.checkDimensions();
    await binding("Vectorize delete", () => this.index.deleteByIds(ids));
    await this.deps.store.deleteVectors(ids);
    return ids.length;
  }

  async page(pat: string, state: IndexState): Promise<PageResult> {
    const { store, bindings, env } = this.deps;
    const full = state.t === null;
    const first = state.cursor === null;
    const page = await fetchFeed(env, pat, state);
    if (!full && page.epoch !== state.epoch) throw new Error("listBlockChanges answered another epoch without 410");
    if (page.nextCursor !== null && page.blocks.length === 0 && full) {
      throw new Error("listBlockChanges returned an empty page with a cursor");
    }

    const docs = await Promise.all(page.blocks.map((b) => toDocument(state.graphId, b)));
    const lastUuid = page.blocks.length > 0 ? page.blocks[page.blocks.length - 1].uuid : null;
    // A full listing is in UUID order, so this page covers (previous page's last UUID, this page's
    // last UUID], or everything after it on the last page. Stored rows in that range that the page
    // didn't list are gone from the graph.
    const range = full ? { lo: first ? null : state.lastUuid, hi: page.nextCursor === null ? null : lastUuid } : null;
    const { rows, inRange } = await store.lookup(
      state.graphId,
      [...docs.map((d) => d.uuid), ...page.removed],
      range,
    );
    const stored = new Map<string, StoredBlock>([...rows, ...inRange].map((r) => [r.uuid, r]));
    const kept = docs.filter((d) => !d.private);
    const listed = new Set(kept.map((d) => d.uuid));
    const deletes = new Set<string>();
    for (const uuid of [...docs.filter((d) => d.private).map((d) => d.uuid), ...page.removed]) {
      const row = stored.get(uuid);
      if (row) deletes.add(row.vectorId);
    }
    for (const row of inRange) if (!listed.has(row.uuid)) deletes.add(row.vectorId);
    // Embed only blocks whose document changed; a change of tags or page alone rewrites the row.
    const changed: BlockDocument[] = kept.filter((d) => stored.get(d.uuid)?.hash !== d.hash);
    const relabelled = kept.filter((d) => {
      const row = stored.get(d.uuid);
      return row !== undefined && row.hash === d.hash && (row.pageId !== d.pageId || row.tags.join("\n") !== d.tags.join("\n"));
    });
    const added = changed.filter((d) => !stored.has(d.uuid)).length;

    const total = added > 0 ? await store.total() : 0;
    if (added > 0 && total - deletes.size + added > bindings.maxVectors) {
      const error = `index is full: ${total} of ${bindings.maxVectors} vectors stored and this page adds ${added}; raise connector.semanticSearch.maxVectors (README 11.11)`;
      const capped: IndexState = { ...state, status: "full", error };
      if (!sameState(state, capped)) await store.save(capped);
      return { state: capped, embedded: 0, deleted: 0, done: true };
    }

    if (changed.length > 0 || deletes.size > 0) await this.checkDimensions();
    if (changed.length > 0) {
      const vectors = await binding("Workers AI embedding", () => bindings.embedder.embed(changed.map((d) => d.document)));
      await binding("Vectorize upsert", () =>
        this.index.upsert(changed.map((d, i) => ({ id: d.vectorId, values: vectors[i], namespace: state.graphId }))),
      );
    }
    if (deletes.size > 0) await binding("Vectorize delete", () => this.index.deleteByIds([...deletes]));

    const pendingT = first ? page.t : state.pendingT;
    const finished = page.nextCursor === null;
    const next: IndexState = {
      ...state,
      epoch: full && first ? page.epoch : state.epoch,
      t: finished ? pendingT : state.t,
      pendingT: finished ? null : pendingT,
      cursor: page.nextCursor,
      lastUuid: full && !finished ? lastUuid : null,
      error: null,
    };
    next.status = next.t !== null && next.cursor === null ? "ready" : "building";
    const upserts = [...changed, ...relabelled];
    if (upserts.length > 0 || deletes.size > 0 || !sameState(state, next)) {
      next.indexedAt = new Date(this.now()).toISOString();
      await store.commit({ upserts, deleteVectorIds: [...deletes], state: next });
    }
    return { state: next, embedded: changed.length, deleted: deletes.size, done: finished };
  }

  now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function syncErrorState(state: IndexState, error: SyncError, alias: string, env: Env): IndexState | "rate-limited" {
  if (error.status === 409) return { ...state, status: "skipped-e2ee", error: "end-to-end encrypted graphs are not indexed" };
  if (error.status === 429) return "rate-limited";
  if (error.status === 401 || error.status === 403) {
    return {
      ...state,
      status: "error",
      error: `token for graph '${alias}' expired or lacks permission — reconnect it at https://${connectorHostname(env)}/graphs`,
    };
  }
  return { ...state, status: "error", error: `sync server error (HTTP ${error.status}): ${error.message}` };
}

/** One cron run. Throws only for deploy or programmer errors; a graph's own failure is recorded on it. */
export async function runIndexer(deps: IndexerDeps): Promise<RunReport> {
  const run = new Run(deps);
  const report: RunReport = { orphansDeleted: await run.deleteOrphans(), graphs: [] };
  const leases = new Map((await deps.store.states()).map((s) => [s.graphId, s.leaseUntil]));
  const graphs = (await deps.graphs.list()).sort(
    (a, b) => (leases.get(a.graphId) ?? 0) - (leases.get(b.graphId) ?? 0),
  );
  let pagesLeft = PAGES_PER_RUN;
  for (const graph of graphs) {
    if (pagesLeft === 0) break;
    const started = Date.now();
    const now = run.now();
    const result: GraphRunReport = { alias: graph.alias, status: "leased", pages: 0, embedded: 0, deleted: 0 };
    report.graphs.push(result);
    let state = await deps.store.lease(graph.graphId, now, now + LEASE_MS);
    if (state === null) continue;
    const resolved = await deps.graphs.resolve(graph.alias);
    if (resolved === null) continue; // disconnected since the list; its rows go as orphans
    while (pagesLeft > 0) {
      pagesLeft -= 1;
      result.pages += 1;
      try {
        const page = await run.page(resolved.pat, state);
        state = page.state;
        result.embedded += page.embedded;
        result.deleted += page.deleted;
        if (page.done) break;
      } catch (error) {
        let next: IndexState | "rate-limited";
        if (error instanceof SyncError && error.status === 410) {
          next = restart(state);
        } else if (error instanceof SyncError) {
          next = syncErrorState(state, error, graph.alias, deps.env);
        } else if (error instanceof BindingError) {
          next = { ...state, status: "error", error: error.message };
        } else {
          throw error;
        }
        if (next === "rate-limited") {
          result.status = "rate-limited";
          break;
        }
        if (!sameState(state, next)) await deps.store.save(next);
        state = next;
        if (next.status !== "building") break;
      }
    }
    if (result.status !== "rate-limited") result.status = state.status;
    console.log(
      `semantic index graph=${graph.alias} status=${result.status} pages=${result.pages} embedded=${result.embedded} deleted=${result.deleted} ms=${Date.now() - started}`,
    );
  }
  return report;
}
