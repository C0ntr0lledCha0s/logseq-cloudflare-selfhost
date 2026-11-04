/** The usual reciprocal rank fusion constant (Cormack et al., 2009): damps the weight of the top ranks. */
export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
  /** 1-based rank in each list that contained the id, by list name. */
  ranks: Record<string, number>;
}

/**
 * Reciprocal rank fusion: each id scores the sum of 1 / (k + rank) over the lists that contain it.
 * Sorted by score, ties broken by the best single rank, then by first appearance across the lists in
 * order, so the result is deterministic. Duplicates within a list count at their first rank.
 */
export function reciprocalRankFusion(lists: Record<string, string[]>, k = RRF_K): Fused[] {
  const fused = new Map<string, Fused>();
  const order: string[] = [];
  for (const [name, ids] of Object.entries(lists)) {
    ids.forEach((id, index) => {
      let entry = fused.get(id);
      if (!entry) {
        entry = { id, score: 0, ranks: {} };
        fused.set(id, entry);
        order.push(id);
      }
      if (entry.ranks[name] !== undefined) return;
      entry.ranks[name] = index + 1;
      entry.score += 1 / (k + index + 1);
    });
  }
  const best = (f: Fused) => Math.min(...Object.values(f.ranks));
  return [...fused.values()].sort(
    (a, b) => b.score - a.score || best(a) - best(b) || order.indexOf(a.id) - order.indexOf(b.id),
  );
}
