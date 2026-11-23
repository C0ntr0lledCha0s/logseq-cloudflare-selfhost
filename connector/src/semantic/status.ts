// The semantic index's state for one graph, as semantic_index_status and get_sync_status report it
// (spec docs/superpowers/specs/2026-11-20-blank-blocks-and-sync-status-design.md §3.3). Neither the
// fields nor their fallbacks differ between the two tools, so they are built here once. Vectorize's
// describe() is semantic_index_status's own, not part of this.
import type { IndexState, SemanticStore } from "./store";

/** The fields both tools share, from the graph's state row (null before the indexer first ran). */
export interface StatusFields {
  status: string;
  "indexed-blocks": number;
  "indexed-at": string | null;
  error: string | null;
}

/** get_sync_status's `semantic` part. */
export interface SemanticStatusPart extends StatusFields {
  /** `semantic_state.t`: the sync t the last complete listing reached; null until one completes. */
  "index-t": number | null;
  /** Sync t minus index t; null when either is null, negative when the index is ahead (a reset graph). */
  "behind-by": number | null;
}

export function statusFields(state: IndexState | null, counts: { graph: number }): StatusFields {
  return {
    status: state?.status ?? "not started",
    "indexed-blocks": counts.graph,
    "indexed-at": state?.indexedAt ?? null,
    error: state?.error ?? null,
  };
}

/** How many sync transactions the index has not seen. Never clamped: a negative value is reported as is. */
export function behindBy(syncT: number | null, indexT: number | null): number | null {
  return syncT === null || indexT === null ? null : syncT - indexT;
}

/**
 * The semantic part for `graphId` at sync t `syncT`: the state row by primary key and the counts
 * query (about one row read per graph in semantic_state), no Vectorize or Workers AI call.
 */
export async function semanticStatusPart(store: SemanticStore, graphId: string, syncT: number | null): Promise<SemanticStatusPart> {
  const [state, counts] = await Promise.all([store.state(graphId), store.counts(graphId)]);
  const fields = statusFields(state, counts);
  const indexT = state?.t ?? null;
  return {
    status: fields.status,
    "indexed-blocks": fields["indexed-blocks"],
    "indexed-at": fields["indexed-at"],
    "index-t": indexT,
    "behind-by": behindBy(syncT, indexT),
    error: fields.error,
  };
}
