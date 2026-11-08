// Offline evaluation of hybrid search against keyword-only (design §11, acceptance 3). The fixture
// graph is indexed by the real indexer; keyword-only is searchGraph's behaviour (the whole query as a
// substring of a title); hybrid is the semantic_search tool. The embedder is a deterministic fake, so
// this checks the pipeline and the fusion, not the quality of the real model.
// The fixture's floor is the least hybrid recall@5 and MRR accepted; a ranking change raises it to its
// new numbers and never lowers it silently. A question's top is the rank its first expected block must reach.
// Run: npx vitest run test/semantic-eval.test.ts --silent=false --disableConsoleIntercept   (prints the table)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fixture from "./fixtures/semantic-eval.json";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { DIMENSIONS, RANKED_QUERY_WORDS, SHORT_BLOCK_WORDS } from "../src/semantic/config";
import { runIndexer } from "../src/semantic/indexer";
import { contentWords, wordCount } from "../src/semantic/ranking";
import { SemanticStore } from "../src/semantic/store";
import { FakeEmbedder, FakeGraph, FakeVectorIndex, fakeSync } from "./semantic-fakes";

const GRAPH_ID = "44444444-4444-4444-4444-444444444444";
const TOKEN = "logseq_pat_EvalToken000";
const K = 5;

interface FixtureBlock {
  key: string;
  text: string;
  tags?: string[];
  children?: FixtureBlock[];
}

interface Question {
  q: string;
  expected: string[];
  /** The rank the first expected block must reach; defaults to K. */
  top?: number;
}

interface Measures {
  keyword: { recall: number; mrr: number };
  hybrid: { recall: number; mrr: number };
}

const questions = fixture.questions as Question[];
const floor = fixture.floor as Measures;

const graph = new FakeGraph(GRAPH_ID, TOKEN);
const embedder = new FakeEmbedder();
const index = new FakeVectorIndex();
const keyToUuid = new Map<string, string>();

function addBlocks(pageId: string, blocks: FixtureBlock[], parent?: string): void {
  for (const block of blocks) {
    const uuid = graph.addBlock(pageId, block.text, { parent, tags: block.tags ?? [] });
    keyToUuid.set(block.key, uuid);
    addBlocks(pageId, block.children ?? [], uuid);
  }
}

function evalEnv(): Env {
  const ai = {
    run: async (_model: string, input: { text: string[] }) => ({
      shape: [input.text.length, DIMENSIONS],
      data: await embedder.embed(input.text),
    }),
  } as unknown as Ai;
  return { ...env, SYNC: fakeSync([graph]), AI: ai, VECTORIZE: index as unknown as Vectorize, SEMANTIC_MAX_VECTORS: "1000" } as Env;
}

interface Hit {
  uuid: string;
  text: string;
  "found-by": string[];
  similarity: number | null;
}

async function semanticSearch(q: string): Promise<Hit[]> {
  const e = evalEnv();
  const request = new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "semantic_search", arguments: { graph: "eval", q, limit: K } } }),
  });
  const ctx = createExecutionContext();
  const res = await mcpHandler(e, ctx)(request, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const message = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 1)
    : JSON.parse(text);
  expect(message.result.isError ?? false).toBe(false);
  return JSON.parse(message.result.content[0].text).results;
}

async function keywordSearch(q: string): Promise<string[]> {
  const body = (await graph.search(new URL(`https://sync.internal/search?q=${encodeURIComponent(q)}&limit=${K}`)).json()) as {
    results: { uuid: string }[];
  };
  return body.results.map((r) => r.uuid);
}

interface Score {
  recall: number;
  reciprocalRank: number;
}

function score(ranked: string[], expected: string[]): Score {
  const top = ranked.slice(0, K);
  const found = expected.filter((uuid) => top.includes(uuid)).length;
  const first = top.findIndex((uuid) => expected.includes(uuid));
  return { recall: found / expected.length, reciprocalRank: first === -1 ? 0 : 1 / (first + 1) };
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

describe("semantic search evaluation", () => {
  beforeAll(async () => {
    await env.DB.exec("DELETE FROM graphs; DELETE FROM semantic_blocks; DELETE FROM semantic_state;");
    await new GraphStore(env.DB, env.GRAPH_TOKEN_KEY).add({
      alias: "eval", graphId: GRAPH_ID, graphName: "Eval", mode: "read", permission: "read", expiresAt: null, token: TOKEN,
    });
    for (const page of fixture.pages) addBlocks(graph.addPage(page.title, page.tags ?? []), page.blocks as FixtureBlock[]);
    const deps = { env: evalEnv(), graphs: new GraphStore(env.DB, env.GRAPH_TOKEN_KEY), store: new SemanticStore(env.DB) };
    for (let i = 0; i < 5; i++) {
      await runIndexer({ ...deps, bindings: { embedder, index, maxVectors: 1000 } });
      await env.DB.exec("UPDATE semantic_state SET lease_until = 0");
    }
    expect((await deps.store.state(GRAPH_ID))?.status).toBe("ready");
  });

  interface Row {
    q: string;
    top: number;
    hits: Hit[];
    /** 1-based rank of the first expected block in the hybrid results, or null when it is not in the top K. */
    rank: number | null;
    keyword: Score;
    hybrid: Score;
  }
  const rows: Row[] = [];
  let summary: Measures;

  beforeAll(async () => {
    for (const { q, expected, top } of questions) {
      const expectedUuids = expected.map((key) => {
        const uuid = keyToUuid.get(key);
        if (!uuid) throw new Error(`fixture names an unknown block ${key}`);
        return uuid;
      });
      const hits = await semanticSearch(q);
      const at = hits.findIndex((h) => expectedUuids.includes(h.uuid));
      rows.push({
        q,
        top: top ?? K,
        hits,
        rank: at === -1 ? null : at + 1,
        keyword: score(await keywordSearch(q), expectedUuids),
        hybrid: score(hits.map((h) => h.uuid), expectedUuids),
      });
    }
    summary = {
      keyword: { recall: mean(rows.map((r) => r.keyword.recall)), mrr: mean(rows.map((r) => r.keyword.reciprocalRank)) },
      hybrid: { recall: mean(rows.map((r) => r.hybrid.recall)), mrr: mean(rows.map((r) => r.hybrid.reciprocalRank)) },
    };
    console.info(
      [
        `semantic eval: ${rows.length} questions, top ${K}`,
        ...rows.map(
          (r) =>
            `  ${r.q.padEnd(44)} keyword recall=${r.keyword.recall.toFixed(2)} rr=${r.keyword.reciprocalRank.toFixed(2)}  hybrid recall=${r.hybrid.recall.toFixed(2)} rr=${r.hybrid.reciprocalRank.toFixed(2)}  top hit: ${(r.hits[0]?.text ?? "(none)").slice(0, 40)} (similarity ${r.hits[0]?.similarity ?? "null"})`,
        ),
        `  mean keyword recall@${K}=${summary.keyword.recall.toFixed(2)} MRR=${summary.keyword.mrr.toFixed(2)}`,
        `  mean hybrid  recall@${K}=${summary.hybrid.recall.toFixed(2)} MRR=${summary.hybrid.mrr.toFixed(2)}`,
      ].join("\n"),
    );
  });

  it("hybrid beats keyword-only on recall@5 and MRR, and never surfaces a private block by meaning", () => {
    const privateUuids = new Set(fixture.private.map((key) => keyToUuid.get(key)));
    for (const r of rows) {
      for (const hit of r.hits) {
        if (hit["found-by"].includes("semantic")) expect(privateUuids.has(hit.uuid), r.q).toBe(false);
      }
    }
    expect(summary.hybrid.recall).toBeGreaterThan(summary.keyword.recall);
    expect(summary.hybrid.mrr).toBeGreaterThan(summary.keyword.mrr);
    // Hybrid keeps what keyword search already finds.
    for (const r of rows) expect(r.hybrid.recall, r.q).toBeGreaterThanOrEqual(r.keyword.recall);
  });

  it("each question's first expected block reaches its top rank", () => {
    for (const r of rows) {
      expect(r.rank, r.q).not.toBeNull();
      expect(r.rank, r.q).toBeLessThanOrEqual(r.top);
    }
  });

  it("hybrid recall@5 and MRR stay at or above the fixture's floor", () => {
    expect(summary.hybrid.recall).toBeGreaterThanOrEqual(floor.hybrid.recall);
    expect(summary.hybrid.mrr).toBeGreaterThanOrEqual(floor.hybrid.mrr);
  });

  // The short-block rule (design 2026-11-07 section 3.2). Before it, "Dashboards" was rank 1 for
  // "stock level reporting dashboard".
  it("no block of 2 words or fewer is rank 1 for a question of 3 or more content words", () => {
    const ranked = rows.filter((r) => contentWords(r.q).length >= RANKED_QUERY_WORDS);
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      const first = r.hits[0];
      expect(first, r.q).toBeDefined();
      expect(wordCount(first.text), `${r.q}: rank 1 is "${first.text}"`).toBeGreaterThan(SHORT_BLOCK_WORDS);
    }
  });
});
