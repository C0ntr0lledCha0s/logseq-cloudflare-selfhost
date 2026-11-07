// Query terms for semantic search's ranking (design 2026-11-07, sections 3.2, 3.3 and 3.6). Pure
// functions, no I/O. The stopword list is shared with the test embedder, so changing it changes the
// offline eval's baseline.
import { KEYWORD_TERMS } from "./config";

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
