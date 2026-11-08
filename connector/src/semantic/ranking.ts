// Query terms for semantic search's ranking (design 2026-11-07, sections 3.2, 3.3 and 3.6). Pure
// functions, no I/O. The stopword list is shared with the test embedder, so changing it changes the
// offline eval's baseline.
import { KEYWORD_LIMIT, KEYWORD_TERMS, RANKED_QUERY_WORDS, SHORT_BLOCK_WEIGHT, SHORT_BLOCK_WORDS } from "./config";

/** Words too common to say what a query is about. `test/semantic-fakes.ts` imports this list. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  "a an and are as at be by did do does for from has have how i in is it its me my of on or our the to was we were what when where which who why will with you your about after before should".split(
    " ",
  ),
);

/** Shorter words than this are dropped from a query's content words. */
const MIN_WORD_LENGTH = 3;

/**
 * A query's content words: lowercased, split on runs of non-alphanumerics, without stopwords or
 * words under 3 characters, de-duplicated (exact words only), in first-appearance order. Both
 * ranking rules count these, so they always agree on whether a query is "multi-word".
 */
export function contentWords(q: string): string[] {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const kept = words.filter((w) => w.length >= MIN_WORD_LENGTH && !STOPWORDS.has(w));
  return [...new Set(kept)];
}

/**
 * The `KEYWORD_TERMS` longest content words, longest first, ties by first appearance. Length
 * stands in for distinctiveness, because inverse document frequency would need a D1 scan.
 */
export function distinctiveTerms(q: string): string[] {
  const words = contentWords(q);
  return words
    .map((word, at) => ({ word, at }))
    .sort((a, b) => b.word.length - a.word.length || a.at - b.at)
    .slice(0, KEYWORD_TERMS)
    .map((t) => t.word);
}

/** Words in a block's stored text, split on whitespace ("Stock on hand" is 3). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

/**
 * The semantic list re-ordered for a query of `RANKED_QUERY_WORDS` or more content words: a block
 * whose stored text has `SHORT_BLOCK_WORDS` words or fewer is ordered by its similarity times
 * `SHORT_BLOCK_WEIGHT`. The sort is stable, so ties keep vector order, and each entry is returned
 * unchanged (its similarity stays raw). `textOf` gives the block's stored text, not its document.
 */
export function demoteShortBlocks<T extends { uuid: string; similarity: number }>(
  semantic: T[],
  textOf: (uuid: string) => string | undefined,
  query: string,
): T[] {
  if (contentWords(query).length < RANKED_QUERY_WORDS) return semantic;
  const weighted = semantic.map((hit) => {
    const text = textOf(hit.uuid);
    const short = text !== undefined && wordCount(text) <= SHORT_BLOCK_WORDS;
    return { hit, order: short ? hit.similarity * SHORT_BLOCK_WEIGHT : hit.similarity };
  });
  return weighted.sort((a, b) => b.order - a.order).map((w) => w.hit);
}

/** One `searchGraph` result, as the keyword leg uses it. */
export interface KeywordResult {
  uuid: string;
  title: string;
  resource: string;
}

/**
 * The term searches' lists merged into one keyword list: uuids in more lists first, then by best
 * single rank, then by first appearance across the lists in term order. A uuid repeated within one
 * list counts once. Capped at `KEYWORD_LIMIT`, so the D1 bind list never grows past one search's.
 */
export function mergeKeywordLists(lists: KeywordResult[][]): KeywordResult[] {
  const merged = new Map<string, { result: KeywordResult; lists: number; best: number; at: number }>();
  lists.forEach((list, l) => {
    const seen = new Set<string>();
    list.forEach((result, i) => {
      if (seen.has(result.uuid)) return;
      seen.add(result.uuid);
      const entry = merged.get(result.uuid);
      if (entry === undefined) merged.set(result.uuid, { result, lists: 1, best: i, at: merged.size });
      else {
        entry.lists += 1;
        entry.best = Math.min(entry.best, i);
      }
    });
  });
  return [...merged.values()]
    .sort((a, b) => b.lists - a.lists || a.best - b.best || a.at - b.at)
    .slice(0, KEYWORD_LIMIT)
    .map((e) => e.result);
}

/**
 * The whole-phrase search's list ahead of the merged term lists, so an exact or substring phrase
 * match keeps the rank `searchGraph` gave it. A uuid in both counts once, at its phrase rank. Capped
 * at `KEYWORD_LIMIT`, like the merge.
 */
export function phraseFirst(phrase: KeywordResult[], terms: KeywordResult[]): KeywordResult[] {
  const seen = new Set<string>();
  const out: KeywordResult[] = [];
  for (const result of [...phrase, ...terms]) {
    if (seen.has(result.uuid)) continue;
    seen.add(result.uuid);
    out.push(result);
  }
  return out.slice(0, KEYWORD_LIMIT);
}
