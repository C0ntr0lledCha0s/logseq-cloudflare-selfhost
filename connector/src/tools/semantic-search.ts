import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEFAULT_HALF_LIFE_DAYS,
  DIMENSIONS,
  EMBEDDING_MODEL,
  KEYWORD_LIMIT,
  KEYWORD_TERM_LIMIT,
  RANKED_QUERY_WORDS,
  SEMANTIC_TOP_K,
  SIGNALS_LIMIT,
  type SemanticBindings,
} from "../semantic/config";
import { BindingError } from "../semantic/indexer";
import {
  type KeywordResult,
  type MemoryFactors,
  type RankingSignal,
  applyMemoryRanking,
  contentWords,
  demoteShortBlocks,
  distinctiveTerms,
  mergeKeywordLists,
  memoryFactors,
  phraseFirst,
} from "../semantic/ranking";
import { reciprocalRankFusion } from "../semantic/rrf";
import type { SemanticStore, StoredBlock } from "../semantic/store";
import type { OnSuccess } from "./readable";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";
import { ToolError, runTool, textResult } from "./common";
import { type GraphAccess, graphFetch, resolveGraph } from "./semantic";

export const SEMANTIC_HELP =
  "For questions about meaning rather than exact words (\"what did we decide about pricing?\"), use semantic_search: it combines meaning-based and title search. Each hit's similarity is its cosine similarity to the query from the @cf/baai/bge-small-en-v1.5 model (higher is closer; null when only title search found it), and semantic-rank and keyword-rank are its place in each search. Judge a match by similarity and keyword-rank rather than score, and compare similarities within one search rather than against a fixed number. In a question of three or more content words (words of three or more letters other than common ones such as what, did, about; so the pricing question above has two), one- and two-word blocks rank lower by meaning (their similarity is reported unchanged), and title search looks for its three longest words separately as well as the whole phrase, keeping a title only when it holds the whole phrase or at least two of those words (an exact or containing title stays first), so put the distinctive words in the question. Pass min_similarity to drop weak meaning matches; below-min-similarity says how many it dropped. semantic_index_status says how much of a graph is indexed. Blocks tagged #private are never indexed. rank defaults to \"relevance\", which is the order above and unchanged. For the current state of something (\"what is the starter tier price now?\"), pass rank: \"memory\": each hit's score becomes relevance x recency x importance, where relevance is the relevance-mode score, recency is 0.5 ^ (age in days / half_life_days) floored at 0.5 (1 when the block has no updated-at; half_life_days 1-3650, default 90), and importance is 1 + 0.1 x log2(1 + references from other pages), capped at 1.5, then halved once if the hit is a done or canceled task, carries one of demote_tags (up to 10, on the block, an ancestor or its page, case-insensitive) or has one of demote_property's values ({property: ident, values: 1-10 titles}, on the block, else its page, case-insensitive). So recency runs 0.5 to 1 and importance 0.5 to 1.5. Memory mode re-orders every candidate before applying limit, never drops one, and reports relevance, recency, importance, updated-at, reference-count and demoted-by on each hit, with rank and half-life-days at the top; read relevance beside score to see why a hit moved. Recency is the block's own last edit (an edit to a child does not count). A hit deleted since it was indexed gets recency 1 and importance 1. demote_tags only sees indexed blocks' tags, so a title-only hit outside the index is never demoted by tag (demote_property still applies). Use relevance mode for what was decided back then; memory mode for what holds now. half_life_days, demote_tags and demote_property without rank: \"memory\" are refused, and a failed lookup of the ranking signals fails the call as ranking signals: <reason>.";

/** One hybrid search hit. Keyword-only hits outside the index carry just their title and resource. */
export interface SearchHit {
  uuid: string;
  resource: string;
  page?: string;
  "page-id"?: string;
  breadcrumb?: string[];
  text: string;
  score: number;
  "found-by": string[];
  /** Raw cosine similarity from the index at 3 dp, or null when the semantic leg did not return the hit. */
  similarity: number | null;
  /** 1-based rank in each leg's list as fused (after the tag filter and min_similarity), or null. */
  "semantic-rank": number | null;
  "keyword-rank": number | null;
  /** Memory mode only: the RRF score at 5 dp (score is then the product). */
  relevance?: number;
  /** Memory mode only, at 3 dp: 0.5 to 1. */
  recency?: number;
  /** Memory mode only, at 3 dp: 0.5 to 1.5. */
  importance?: number;
  /** Memory mode only: the block's or page's own last edit as ISO, or null. */
  "updated-at"?: string | null;
  "reference-count"?: number;
  "demoted-by"?: string[];
}

/** `semantic_search`'s arguments after zod; the ranking options are optional for direct callers. */
export interface HybridSearchArgs {
  graph: string;
  q: string;
  limit: number;
  tag?: string;
  min_similarity?: number;
  rank?: "relevance" | "memory";
  half_life_days?: number;
  demote_tags?: string[];
  demote_property?: { property: string; values: string[] };
}

export interface HybridSearchResult {
  rank?: "memory";
  "half-life-days"?: number;
  results: SearchHit[];
  index: { status: string; blocks: number };
  "below-min-similarity"?: number;
}

interface SemanticMatch {
  id: string;
  similarity: number;
}

export interface HybridSearchDeps {
  access: GraphAccess;
  store: SemanticStore;
  bindings: SemanticBindings;
  /** The clock memory ranking measures age against; `Date.now` by default. */
  now?: () => number;
}

async function searchGraph(access: GraphAccess, alias: string, graphId: string, pat: string, q: string, limit: number) {
  const response = await graphFetch(access, alias, pat, {
    method: "GET",
    path: `/api/v1/graphs/${encodeURIComponent(graphId)}/search`,
    query: { q, types: "blocks,pages", limit },
  });
  const body = (await response.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) throw new Error("searchGraph returned no results array");
  return body.results as KeywordResult[];
}

/**
 * `getBlocks` `view=signals` (patch 0035) for the candidates, in one request: each found uuid's
 * signal; a uuid the server lists under `missing` is absent. A failure fails the call as
 * `ranking signals: <reason>`, keeping a sync error's `ToolError` status.
 */
async function fetchSignals(
  access: GraphAccess,
  alias: string,
  graphId: string,
  pat: string,
  uuids: string[],
  property: string | undefined,
): Promise<Map<string, RankingSignal>> {
  try {
    const response = await graphFetch(access, alias, pat, {
      method: "GET",
      path: `/api/v1/graphs/${encodeURIComponent(graphId)}/blocks`,
      query: { ids: uuids.join(","), view: "signals", ...(property === undefined ? {} : { property }) },
    });
    const body = (await response.json()) as { blocks?: unknown };
    if (!Array.isArray(body.blocks)) throw new Error("getBlocks returned no blocks array");
    const signals = new Map<string, RankingSignal>();
    for (const b of body.blocks as Record<string, unknown>[]) {
      signals.set(String(b.uuid), {
        updatedAt: typeof b["updated-at"] === "number" ? b["updated-at"] : null,
        referenceCount: typeof b["reference-count"] === "number" ? b["reference-count"] : 0,
        status: typeof b.status === "string" ? b.status : null,
        propertyValues: Array.isArray(b["property-values"]) ? (b["property-values"] as unknown[]).map(String) : null,
      });
    }
    return signals;
  } catch (error) {
    const text = `ranking signals: ${error instanceof Error ? error.message : String(error)}`;
    throw error instanceof ToolError ? new ToolError(text, error.status) : new Error(text, { cause: error });
  }
}

/**
 * Refuses a memory-only option given without `rank: "memory"`, in argument order, so an option is
 * never silently ignored (design 2026-11-08 section 3.6). An empty `demote_tags` is a no-op either way.
 */
function refuseIgnoredOptions(args: HybridSearchArgs): void {
  if (args.rank === "memory") return;
  const given: [string, boolean][] = [
    ["half_life_days", args.half_life_days !== undefined],
    ["demote_tags", (args.demote_tags?.length ?? 0) > 0],
    ["demote_property", args.demote_property !== undefined],
  ];
  const first = given.find(([, present]) => present);
  if (first) throw new ToolError(`${first[0]} needs rank: "memory"`, "refused");
}

/**
 * The keyword leg. A query of fewer than `RANKED_QUERY_WORDS` content words is searched as one
 * phrase. A longer one is searched once per distinctive term and once as the whole phrase, in
 * parallel: the term lists are merged (a uuid only one term found is dropped) and the phrase list goes ahead of them, so an exact title
 * keeps rank 1. A failed search fails the call, naming the first failing one (terms, then phrase).
 */
async function keywordResults(access: GraphAccess, alias: string, graphId: string, pat: string, q: string) {
  if (contentWords(q).length < RANKED_QUERY_WORDS) return searchGraph(access, alias, graphId, pat, q, KEYWORD_LIMIT);
  const needles = [...distinctiveTerms(q), q];
  const settled = await Promise.allSettled(needles.map((t) => searchGraph(access, alias, graphId, pat, t, KEYWORD_TERM_LIMIT)));
  const lists: KeywordResult[][] = [];
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      lists.push(outcome.value);
      continue;
    }
    const reason: unknown = outcome.reason;
    const text = `keyword search for "${needles[i]}": ${reason instanceof Error ? reason.message : String(reason)}`;
    throw reason instanceof ToolError ? new ToolError(text, reason.status) : new Error(text, { cause: reason });
  }
  const phrase = lists.pop() ?? [];
  return phraseFirst(phrase, mergeKeywordLists(lists));
}

async function semanticMatches(bindings: SemanticBindings, graphId: string, q: string): Promise<SemanticMatch[]> {
  try {
    const [vector] = await bindings.embedder.embed([q]);
    const { matches } = await bindings.index.query(vector, { topK: SEMANTIC_TOP_K, namespace: graphId });
    return matches.map((m) => ({ id: m.id, similarity: m.score }));
  } catch (error) {
    throw new BindingError("semantic query", error);
  }
}

/**
 * `semantic_search`: nearest blocks by embedding, and the keyword leg (`searchGraph` on the query, or
 * on its distinctive terms), merged by reciprocal rank fusion. With `tag`, only indexed blocks carrying that tag (on themselves, an
 * ancestor or their page) are kept, from both sides. With `min_similarity`, semantic hits whose raw
 * similarity is below it are dropped after the deleted-row and tag filters, and counted. With
 * `rank: "memory"`, one `view=signals` request fetches the candidates' ranking signals and the whole
 * fused list is re-ordered by relevance x recency x importance before `limit` is applied.
 */
export async function hybridSearch(deps: HybridSearchDeps, args: HybridSearchArgs): Promise<HybridSearchResult> {
  refuseIgnoredOptions(args);
  const memory = args.rank === "memory";
  const graph = await resolveGraph(deps.access, args.graph, false);
  const [vectorMatches, keyword] = await Promise.all([
    semanticMatches(deps.bindings, graph.graphId, args.q),
    keywordResults(deps.access, args.graph, graph.graphId, graph.pat, args.q),
  ]);
  const [blocks, state, counts] = await Promise.all([
    deps.store.blocksFor(graph.graphId, vectorMatches.map((m) => m.id), keyword.map((k) => k.uuid)),
    deps.store.state(graph.graphId),
    deps.store.counts(graph.graphId),
  ]);
  const byVector = new Map(blocks.map((b) => [b.vectorId, b]));
  const byUuid = new Map(blocks.map((b) => [b.uuid, b]));
  // Memory mode: one signals request for the candidates that survived the deleted-row filter, semantic first.
  let signals = new Map<string, RankingSignal>();
  if (memory) {
    const candidates = [
      ...new Set([...vectorMatches.flatMap((m) => byVector.get(m.id)?.uuid ?? []), ...keyword.map((k) => k.uuid)]),
    ].slice(0, SIGNALS_LIMIT);
    if (candidates.length > 0) {
      signals = await fetchSignals(deps.access, args.graph, graph.graphId, graph.pat, candidates, args.demote_property?.property);
    }
  }
  const tag = args.tag?.toLowerCase();
  const allowed = (uuid: string) => tag === undefined || (byUuid.get(uuid)?.tags.includes(tag) ?? false);
  // A vector whose row is gone was deleted moments ago (Vectorize mutations are asynchronous).
  const semanticHits = vectorMatches
    .flatMap(({ id, similarity }) => {
      const uuid = byVector.get(id)?.uuid;
      return uuid === undefined ? [] : [{ uuid, similarity }];
    })
    .filter((h) => allowed(h.uuid));
  // The floor compares the raw value, so 0.5996 is below 0.6 although it is reported as 0.600.
  const min = args.min_similarity;
  const floored = min === undefined ? semanticHits : semanticHits.filter((h) => h.similarity >= min);
  // Short blocks are ordered lower for multi-word questions; reported similarities stay raw.
  const kept = demoteShortBlocks(floored, (uuid) => byUuid.get(uuid)?.text, args.q);
  const similarityOf = new Map<string, number>();
  for (const h of kept) if (!similarityOf.has(h.uuid)) similarityOf.set(h.uuid, h.similarity);
  const semanticUuids = kept.map((h) => h.uuid);
  const keywordUuids = keyword.map((k) => k.uuid).filter(allowed);
  const keywordByUuid = new Map(keyword.map((k) => [k.uuid, k]));
  const all = reciprocalRankFusion({ semantic: semanticUuids, keyword: keywordUuids });
  const halfLifeDays = args.half_life_days ?? DEFAULT_HALF_LIFE_DAYS;
  const options = {
    now: (deps.now ?? Date.now)(),
    halfLifeDays,
    demoteTags: args.demote_tags ?? [],
    demoteValues: args.demote_property?.values ?? [],
  };
  // The whole fused list is re-ranked before the slice, so a hit below `limit` by relevance can rise into it.
  const ranked: ((typeof all)[number] & Partial<MemoryFactors> & { relevance?: number; final?: number })[] = memory
    ? applyMemoryRanking(all, (id) => memoryFactors(signals.get(id), byUuid.get(id)?.tags ?? [], options))
    : all;
  const fused = ranked.slice(0, args.limit);
  const results = fused.map((entry): SearchHit => {
    const { id, ranks } = entry;
    const score = memory ? entry.final! : entry.score;
    const stored: StoredBlock | undefined = byUuid.get(id);
    const foundBy = Object.keys(ranks);
    const similarity = similarityOf.get(id);
    const legs = {
      similarity: similarity === undefined ? null : Number(similarity.toFixed(3)),
      "semantic-rank": ranks.semantic ?? null,
      "keyword-rank": ranks.keyword ?? null,
      ...(memory ? memoryFields(entry as MemoryFactors & { relevance: number }, signals.get(id)) : {}),
    };
    if (stored) {
      return {
        uuid: id,
        resource: "blocks",
        page: stored.pageTitle,
        "page-id": stored.pageId,
        breadcrumb: stored.breadcrumb,
        text: stored.text,
        score: Number(score.toFixed(5)),
        "found-by": foundBy,
        ...legs,
      };
    }
    const hit = keywordByUuid.get(id);
    if (!hit) throw new Error("fused a result from neither list");
    return { uuid: id, resource: hit.resource, text: hit.title, score: Number(score.toFixed(5)), "found-by": foundBy, ...legs };
  });
  const index = { status: state?.status ?? "not started", blocks: counts.graph };
  const head: Pick<HybridSearchResult, "rank" | "half-life-days"> = memory ? { rank: "memory", "half-life-days": halfLifeDays } : {};
  if (min === undefined) return { ...head, results, index };
  return { ...head, results, index, "below-min-similarity": semanticHits.length - floored.length };
}

/** A memory-mode hit's factors as reported: relevance at 5 dp, the factors at 3 dp, and the raw signal. */
function memoryFields(hit: MemoryFactors & { relevance: number }, signal: RankingSignal | undefined) {
  return {
    relevance: Number(hit.relevance.toFixed(5)),
    recency: Number(hit.recency.toFixed(3)),
    importance: Number(hit.importance.toFixed(3)),
    "updated-at": signal?.updatedAt == null ? null : new Date(signal.updatedAt).toISOString(),
    "reference-count": signal?.referenceCount ?? 0,
    "demoted-by": hit.demotedBy,
  };
}

/** `semantic_search` and `semantic_index_status`; registered only when semantic search is configured. */
export function registerSemanticTools(
  server: McpServer,
  deps: HybridSearchDeps,
  onSuccess: OnSuccess,
): void {
  const graph = z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION);

  server.registerTool(
    "semantic_search",
    {
      description:
        "Search a graph by meaning and by title at once: the blocks nearest the query by embedding, merged with search_graph's title matches (reciprocal rank fusion). Use it for questions and topics rather than exact words. Each hit has its page, breadcrumb and text, which search found it, its similarity (cosine, 0 to 1, null for a title-only match) and its semantic-rank and keyword-rank (null when that search did not return it). For a query of three or more content words (words of three or more letters other than common ones such as what, did, about), one- and two-word blocks rank lower by meaning (similarity stays raw), and the title search runs on the whole phrase and once for each of its three longest words: titles containing the phrase come first, then titles matching two or more of the words, more first (a title matching only one of them is left out); a shorter query is title-searched as one phrase only. min_similarity drops meaning matches below that similarity and reports how many in below-min-similarity. Blocks tagged #private (or under a #private block or page) are not indexed. rank: \"memory\" (default \"relevance\", unchanged) re-orders all candidates by relevance x recency (0.5 to 1, halving every half_life_days, default 90) x importance (0.5 to 1.5: references from other pages raise it; a done or canceled task, a demote_tags tag or a demote_property value halves it once), then applies limit; it never filters. Each hit then has score (the product), relevance, recency, importance, updated-at, reference-count and demoted-by, and the response has rank and half-life-days. half_life_days, demote_tags and demote_property need rank: \"memory\"; connector_help has the details.",
      inputSchema: z.object({
        graph,
        q: z.string().min(1).max(500).describe("What to look for, in plain words"),
        limit: z.number().int().min(1).max(50).default(10).describe("Results to return (1-50, default 10)"),
        tag: z.string().min(1).optional().describe("Only indexed blocks with this tag (on the block, an ancestor or its page)"),
        min_similarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Drop meaning matches whose cosine similarity is below this (0 to 1, no default). Title-only matches are kept. The response then says how many were dropped in below-min-similarity",
          ),
        rank: z
          .enum(["relevance", "memory"])
          .default("relevance")
          .describe(
            "relevance (default): order by meaning and title match only. memory: multiply that by recency and importance, for the current state of something",
          ),
        half_life_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('rank "memory" only: age in days at which recency halves (1-3650, default 90)'),
        demote_tags: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe('rank "memory" only: halve the importance of indexed hits with any of these tags (on the block, an ancestor or its page), case-insensitive; up to 10'),
        demote_property: z
          .object({
            property: z.string().min(1).describe("Property ident, e.g. user.property/project-status"),
            values: z.array(z.string().min(1)).min(1).max(10).describe("Value titles that demote, case-insensitive (1-10)"),
          })
          .optional()
          .describe('rank "memory" only: halve the importance of hits whose value of this property (on the block, else its page) is one of these titles'),
      }),
      annotations: annotationsFor("semantic_search"),
    },
    (args) =>
      runTool("semantic_search", args.graph, async () => {
        try {
          const result = await hybridSearch(deps, args);
          onSuccess("semantic_search", args.graph);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          if (error instanceof BindingError) throw new ToolError(error.message, "binding-error");
          throw error;
        }
      }),
  );

  server.registerTool(
    "semantic_index_status",
    {
      description:
        "How much of a graph the semantic index holds: building, ready, full, error or skipped (end-to-end encrypted), the number of indexed blocks, when it last changed and any error.",
      inputSchema: z.object({ graph }),
      annotations: annotationsFor("semantic_index_status"),
    },
    (args) =>
      runTool("semantic_index_status", args.graph, async () => {
        const resolved = await resolveGraph(deps.access, args.graph, false);
        const [state, counts, info] = await Promise.all([
          deps.store.state(resolved.graphId),
          deps.store.counts(resolved.graphId),
          deps.bindings.index.describe(),
        ]);
        const listing = state?.cursor ? (state.t === null ? "full" : "changes") : null;
        const status = {
          graph: args.graph,
          status: state?.status ?? "not started",
          "indexed-blocks": counts.graph,
          "listing-in-progress": listing,
          "indexed-at": state?.indexedAt ?? null,
          error: state?.error ?? null,
          index: {
            model: EMBEDDING_MODEL,
            dimensions: info.dimensions,
            "expected-dimensions": DIMENSIONS,
            vectors: info.vectorCount,
            "stored-blocks": counts.total,
            "max-vectors": deps.bindings.maxVectors,
          },
        };
        return textResult(JSON.stringify(status, null, 2));
      }),
  );
}
