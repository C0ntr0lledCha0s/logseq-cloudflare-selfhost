import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DIMENSIONS,
  EMBEDDING_MODEL,
  KEYWORD_LIMIT,
  SEMANTIC_TOP_K,
  type SemanticBindings,
} from "../semantic/config";
import { BindingError } from "../semantic/indexer";
import { reciprocalRankFusion } from "../semantic/rrf";
import type { SemanticStore, StoredBlock } from "../semantic/store";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";
import { ToolError, runTool, textResult } from "./common";
import { type GraphAccess, graphFetch, resolveGraph } from "./semantic";

export const SEMANTIC_HELP =
  "For questions about meaning rather than exact words (\"what did we decide about pricing?\"), use semantic_search: it combines meaning-based and title search. semantic_index_status says how much of a graph is indexed. Blocks tagged #private are never indexed.";

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
}

interface KeywordResult {
  uuid: string;
  title: string;
  resource: string;
}

export interface HybridSearchDeps {
  access: GraphAccess;
  store: SemanticStore;
  bindings: SemanticBindings;
}

async function keywordResults(access: GraphAccess, alias: string, graphId: string, pat: string, q: string) {
  const response = await graphFetch(access, alias, pat, {
    method: "GET",
    path: `/api/v1/graphs/${encodeURIComponent(graphId)}/search`,
    query: { q, types: "blocks,pages", limit: KEYWORD_LIMIT },
  });
  const body = (await response.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) throw new Error("searchGraph returned no results array");
  return body.results as KeywordResult[];
}

async function semanticMatches(bindings: SemanticBindings, graphId: string, q: string): Promise<string[]> {
  try {
    const [vector] = await bindings.embedder.embed([q]);
    const { matches } = await bindings.index.query(vector, { topK: SEMANTIC_TOP_K, namespace: graphId });
    return matches.map((m) => m.id);
  } catch (error) {
    throw new BindingError("semantic query", error);
  }
}

/**
 * `semantic_search`: nearest blocks by embedding, and `searchGraph` on the same query, merged by
 * reciprocal rank fusion. With `tag`, only indexed blocks carrying that tag (on themselves, an
 * ancestor or their page) are kept, from both sides.
 */
export async function hybridSearch(
  deps: HybridSearchDeps,
  args: { graph: string; q: string; limit: number; tag?: string },
): Promise<{ results: SearchHit[]; index: { status: string; blocks: number } }> {
  const graph = await resolveGraph(deps.access, args.graph, false);
  const [vectorIds, keyword] = await Promise.all([
    semanticMatches(deps.bindings, graph.graphId, args.q),
    keywordResults(deps.access, args.graph, graph.graphId, graph.pat, args.q),
  ]);
  const [blocks, state, counts] = await Promise.all([
    deps.store.blocksFor(graph.graphId, vectorIds, keyword.map((k) => k.uuid)),
    deps.store.state(graph.graphId),
    deps.store.counts(graph.graphId),
  ]);
  const byVector = new Map(blocks.map((b) => [b.vectorId, b]));
  const byUuid = new Map(blocks.map((b) => [b.uuid, b]));
  const tag = args.tag?.toLowerCase();
  const allowed = (uuid: string) => tag === undefined || (byUuid.get(uuid)?.tags.includes(tag) ?? false);
  // A vector whose row is gone was deleted moments ago (Vectorize mutations are asynchronous).
  const semanticUuids = vectorIds.flatMap((id) => byVector.get(id)?.uuid ?? []).filter(allowed);
  const keywordUuids = keyword.map((k) => k.uuid).filter(allowed);
  const keywordByUuid = new Map(keyword.map((k) => [k.uuid, k]));
  const fused = reciprocalRankFusion({ semantic: semanticUuids, keyword: keywordUuids }).slice(0, args.limit);
  const results = fused.map(({ id, score, ranks }): SearchHit => {
    const stored: StoredBlock | undefined = byUuid.get(id);
    const foundBy = Object.keys(ranks);
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
      };
    }
    const hit = keywordByUuid.get(id);
    if (!hit) throw new Error("fused a result from neither list");
    return { uuid: id, resource: hit.resource, text: hit.title, score: Number(score.toFixed(5)), "found-by": foundBy };
  });
  return { results, index: { status: state?.status ?? "not started", blocks: counts.graph } };
}

/** `semantic_search` and `semantic_index_status`; registered only when semantic search is configured. */
export function registerSemanticTools(
  server: McpServer,
  deps: HybridSearchDeps,
  onSuccess: (tool: string, alias: string) => void,
): void {
  const graph = z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION);

  server.registerTool(
    "semantic_search",
    {
      description:
        "Search a graph by meaning and by title at once: the blocks nearest the query by embedding, merged with search_graph's title matches (reciprocal rank fusion). Use it for questions and topics rather than exact words. Each hit has its page, breadcrumb and text, and which search found it. Blocks tagged #private (or under a #private block or page) are not indexed.",
      inputSchema: z.object({
        graph,
        q: z.string().min(1).max(500).describe("What to look for, in plain words"),
        limit: z.number().int().min(1).max(50).default(10).describe("Results to return (1-50, default 10)"),
        tag: z.string().min(1).optional().describe("Only indexed blocks with this tag (on the block, an ancestor or its page)"),
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
