import { ConfigError } from "../config";

/** The embedding model. Changing it (or its dimensions) needs a new Vectorize index and a full rebuild. */
export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
export const DIMENSIONS = 384;
/** Blocks per feed page, and so per embedding call. */
export const PAGE_SIZE = 50;
/** Feed pages per cron run across all graphs: keeps a run inside Workers Free's CPU and subrequest limits. */
export const PAGES_PER_RUN = 2;
/** How long a run holds a graph. Shorter than the one-minute cron, so a finished run never blocks the next. */
export const LEASE_MS = 50_000;
/** Vectors of disconnected graphs deleted per run. */
export const ORPHAN_BATCH = 500;
/** Nearest neighbours fetched per query (Vectorize allows 100 without values or metadata). */
export const SEMANTIC_TOP_K = 50;
/** Keyword results fetched per query. */
export const KEYWORD_LIMIT = 50;
/** Content words a query needs before the ranking rules for multi-word questions apply. */
export const RANKED_QUERY_WORDS = 3;
/** Blocks of this many words or fewer are "short" for multi-word questions. */
export const SHORT_BLOCK_WORDS = 2;
/** A short block's similarity is multiplied by this, for ordering only, in a multi-word question's semantic list. */
export const SHORT_BLOCK_WEIGHT = 0.75;
/** Distinctive terms the keyword leg searches for a multi-word question. */
export const KEYWORD_TERMS = 3;
/** Keyword results fetched per distinctive term; the merged list is capped at `KEYWORD_LIMIT`. */
export const KEYWORD_TERM_LIMIT = 20;
/** A term search's hit joins the keyword list only when this many of the terms found it; one word of a question matches too many unrelated titles. */
export const KEYWORD_TERM_MATCHES = 2;

/** Turns texts into vectors of `DIMENSIONS` numbers, one per text, in order. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** The part of the Vectorize binding the connector uses. */
export type VectorIndex = Pick<Vectorize, "describe" | "query" | "upsert" | "deleteByIds">;

export interface SemanticBindings {
  embedder: Embedder;
  index: VectorIndex;
  maxVectors: number;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Workers AI as an `Embedder`. Throws unless the model returns one vector of the right size per text. */
export function workersAiEmbedder(ai: Ai): Embedder {
  return {
    async embed(texts) {
      const output = (await ai.run(EMBEDDING_MODEL, { text: texts })) as { data?: unknown };
      const data = output.data;
      if (
        !Array.isArray(data) ||
        data.length !== texts.length ||
        !data.every((v) => Array.isArray(v) && v.length === DIMENSIONS)
      ) {
        throw new Error(`${EMBEDDING_MODEL} returned an unexpected shape`);
      }
      return data as number[][];
    },
  };
}

/**
 * Semantic search's bindings, or null when it is off (none of AI, VECTORIZE and
 * SEMANTIC_MAX_VECTORS set). Throws `ConfigError` when only some are set or the cap is malformed,
 * so a half-rendered deploy fails closed like a missing secret.
 */
export function semanticBindings(env: Env): SemanticBindings | null {
  const present = [env.AI, env.VECTORIZE, env.SEMANTIC_MAX_VECTORS].filter((v) => v !== undefined).length;
  if (present === 0) return null;
  if (present !== 3 || !env.AI || !env.VECTORIZE || env.SEMANTIC_MAX_VECTORS === undefined) {
    throw new ConfigError("semantic search needs AI, VECTORIZE and SEMANTIC_MAX_VECTORS together");
  }
  if (!POSITIVE_INTEGER.test(env.SEMANTIC_MAX_VECTORS)) {
    throw new ConfigError("SEMANTIC_MAX_VECTORS must be a positive integer");
  }
  return {
    embedder: workersAiEmbedder(env.AI),
    index: env.VECTORIZE,
    maxVectors: Number(env.SEMANTIC_MAX_VECTORS),
  };
}
