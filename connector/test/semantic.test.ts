import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { mcpHandler } from "../src/mcp";
import { ConfigError } from "../src/config";
import {
  DIMENSIONS,
  PAGES_PER_RUN,
  KEYWORD_TERMS,
  PAGE_SIZE,
  RANKED_QUERY_WORDS,
  type SemanticBindings,
  semanticBindings,
  workersAiEmbedder,
} from "../src/semantic/config";
import { documentText, parseFeedPage, toDocument, vectorId } from "../src/semantic/document";
import { runIndexer } from "../src/semantic/indexer";
import { STOPWORDS, contentWords, distinctiveTerms, mergeKeywordLists, wordCount } from "../src/semantic/ranking";
import { reciprocalRankFusion } from "../src/semantic/rrf";
import { SemanticStore } from "../src/semantic/store";
import { type OpenApiSpec, SEMANTIC_TOOLS, graphOperations } from "../src/tools/spec.mjs";
import { CraftedEmbedder, FakeEmbedder, FakeGraph, FakeVectorIndex, axis, fakeEmbed, fakeSync, unitAt } from "./semantic-fakes";

const ORIGIN = "https://mcp.example.com";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const HOME_ID = "33333333-3333-3333-3333-333333333333";
const WORK_TOKEN = "logseq_pat_WorkToken123";
const HOME_TOKEN = "logseq_pat_HomeToken789";

let work: FakeGraph;
let home: FakeGraph;
let embedder: FakeEmbedder;
let index: FakeVectorIndex;
let consoleSpies: MockInstance[];

function graphs(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

function semanticStore(): SemanticStore {
  return new SemanticStore(env.DB);
}

function bindings(maxVectors = 10_000): SemanticBindings {
  return { embedder, index, maxVectors };
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, SYNC: fakeSync([work, home]), ...overrides } as Env;
}

/** The env a deploy with semantic search renders: AI, VECTORIZE and the cap, backed by the fakes. */
function semanticEnv(maxVectors = "10000"): Env {
  const ai = {
    run: async (_model: string, input: { text: string[] }) => ({
      shape: [input.text.length, DIMENSIONS],
      data: await embedder.embed(input.text),
    }),
  } as unknown as Ai;
  return testEnv({ AI: ai, VECTORIZE: index as unknown as Vectorize, SEMANTIC_MAX_VECTORS: maxVectors });
}

function run(maxVectors?: number, e: Env = testEnv()) {
  return runIndexer({ env: e, graphs: graphs(), store: semanticStore(), bindings: bindings(maxVectors) });
}

async function runUntilReady(graphId = WORK_ID, maxRuns = 20): Promise<number> {
  for (let i = 1; i <= maxRuns; i++) {
    await run();
    await expireLeases();
    if ((await semanticStore().state(graphId))?.status === "ready") return i;
  }
  throw new Error("index never became ready");
}

/** Leases outlive a test's back-to-back runs; the real cron is a minute apart. */
async function expireLeases(): Promise<void> {
  await env.DB.exec("UPDATE semantic_state SET lease_until = 0");
}

async function rows(graphId = WORK_ID): Promise<{ block_uuid: string; tags: string; hash: string }[]> {
  const { results } = await env.DB.prepare("SELECT block_uuid, tags, hash FROM semantic_blocks WHERE graph_id = ? ORDER BY block_uuid")
    .bind(graphId)
    .all<{ block_uuid: string; tags: string; hash: string }>();
  return results;
}

/** Each state row's block count (migration 0003's triggers) equals its graph's rows. */
async function expectExactCounts(): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT graph_id, blocks, (SELECT count(*) FROM semantic_blocks b WHERE b.graph_id = s.graph_id) AS actual
     FROM semantic_state s`,
  ).all<{ graph_id: string; blocks: number; actual: number }>();
  for (const r of results) expect(r.blocks, r.graph_id).toBe(r.actual);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs; DELETE FROM semantic_blocks; DELETE FROM semantic_state;");
  work = new FakeGraph(WORK_ID, WORK_TOKEN);
  home = new FakeGraph(HOME_ID, HOME_TOKEN);
  embedder = new FakeEmbedder();
  index = new FakeVectorIndex();
  await graphs().add({
    alias: "work", graphId: WORK_ID, graphName: "Work", mode: "write", permission: "both", expiresAt: null, token: WORK_TOKEN,
  });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function logged(): string[] {
  return consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
}

describe("documents", () => {
  it("joins page, breadcrumb and text, cutting long ancestors and long documents", () => {
    expect(documentText({ pageTitle: "Projects", breadcrumb: ["Roadmap", "Q3"], text: "Ship v2" })).toBe(
      "Projects > Roadmap > Q3 > Ship v2",
    );
    const long = documentText({ pageTitle: "P", breadcrumb: ["x".repeat(500)], text: "y".repeat(5000) });
    expect(long.startsWith(`P > ${"x".repeat(120)}… > y`)).toBe(true);
    expect(long).toHaveLength(1500);
  });

  it("marks a block private when any inherited tag is 'private' in any case", async () => {
    const block = { uuid: "u", pageId: "p", pageTitle: "P", breadcrumb: [], text: "t" };
    expect((await toDocument(WORK_ID, { ...block, tags: ["PriVate"] })).private).toBe(true);
    expect((await toDocument(WORK_ID, { ...block, tags: ["privately", "work"] })).private).toBe(false);
  });

  it("derives a stable 32-character vector id per graph and block", async () => {
    const a = await vectorId(WORK_ID, "b1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await vectorId(WORK_ID, "b1")).toBe(a);
    expect(await vectorId(HOME_ID, "b1")).not.toBe(a);
  });

  it("reads the feed's last page, whose next-cursor is null as the sync server sends it", () => {
    // JSON as patch 0014 serialises a last page: Clojure nil becomes null, not a missing key.
    const last = JSON.parse('{"blocks":[],"removed":[],"next-cursor":null,"epoch":"e","t":7}');
    expect(parseFeedPage(last)).toEqual({ epoch: "e", t: 7, blocks: [], removed: [], nextCursor: null });
    expect(parseFeedPage({ ...last, "next-cursor": "c" }).nextCursor).toBe("c");
  });

  it("rejects a feed page of the wrong shape", () => {
    const ok = { epoch: "e", t: 1, blocks: [], removed: [], "next-cursor": null };
    expect(() => parseFeedPage(ok)).not.toThrow();
    expect(() => parseFeedPage({ ...ok, t: "1" })).toThrow(/unexpected shape/);
    expect(() => parseFeedPage({ ...ok, "next-cursor": 3 })).toThrow(/unexpected shape/);
    expect(() => parseFeedPage({ ...ok, blocks: [{ uuid: "u" }] })).toThrow(/malformed block/);
  });
});

describe("reciprocal rank fusion", () => {
  it("scores 1/(60+rank) summed over lists and ranks shared hits first", () => {
    const fused = reciprocalRankFusion({ semantic: ["a", "b", "c"], keyword: ["c", "d"] });
    // b and d tie on 1/62 and on best rank; b appeared first.
    expect(fused.map((f) => f.id)).toEqual(["c", "a", "b", "d"]);
    expect(fused[0].score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(fused[0].ranks).toEqual({ semantic: 3, keyword: 1 });
    expect(fused[1].ranks).toEqual({ semantic: 1 });
  });

  it("breaks ties by best rank, then by first appearance, and counts duplicates once", () => {
    const fused = reciprocalRankFusion({ semantic: ["x", "x", "y"], keyword: ["y", "x"] });
    expect(fused.map((f) => [f.id, f.ranks])).toEqual([
      ["x", { semantic: 1, keyword: 2 }],
      ["y", { semantic: 3, keyword: 1 }],
    ]);
    expect(reciprocalRankFusion({ a: ["p"], b: ["q"] }).map((f) => f.id)).toEqual(["p", "q"]);
  });
});

describe("ranking terms", () => {
  it("contentWords drops stopwords, short words and duplicates", () => {
    expect(contentWords("When is the car's warrant of fitness due?")).toEqual(["car", "warrant", "fitness", "due"]);
    // Two content words left after stopwords and short words: below RANKED_QUERY_WORDS.
    expect(contentWords("is it the WOF due")).toEqual(["wof", "due"]);
    expect(contentWords("is it the WOF due").length).toBeLessThan(RANKED_QUERY_WORDS);
    // Exact duplicates only: a plural is its own word.
    expect(contentWords("dashboard dashboards Dashboard")).toEqual(["dashboard", "dashboards"]);
    // Three characters is the minimum; two is dropped.
    expect(contentWords("gp vet tax")).toEqual(["vet", "tax"]);
    // Runs of any non-alphanumerics split words; digits are word characters.
    expect(contentWords("Q3-budget/2026 (draft)")).toEqual(["budget", "2026", "draft"]);
    // Letters outside ASCII are word characters, so a macron does not split a word.
    expect(contentWords("whānau hui at the marae")).toEqual(["whānau", "hui", "marae"]);
    expect(contentWords("")).toEqual([]);
    expect(contentWords("is it the")).toEqual([]);
  });

  it("distinctiveTerms keeps the three longest, ties by first appearance", () => {
    expect(KEYWORD_TERMS).toBe(3);
    // stock and level tie on 5 characters; stock appears first.
    expect(distinctiveTerms("stock level reporting dashboard")).toEqual(["reporting", "dashboard", "stock"]);
    // Reversed order: level now appears first, so it wins the tie.
    expect(distinctiveTerms("dashboard reporting level stock")).toEqual(["dashboard", "reporting", "level"]);
    expect(distinctiveTerms("When will the new hire start on the warehouse project?")).toEqual(["warehouse", "project", "start"]);
    expect(distinctiveTerms("kids dentist")).toEqual(["dentist", "kids"]);
    expect(distinctiveTerms("rego")).toEqual(["rego"]);
    expect(distinctiveTerms("is it the")).toEqual([]);
  });

  it("mergeKeywordLists: list count decides before entry order; ties follow term order when the lists are swapped or reversed", () => {
    const r = (uuid: string) => ({ uuid, title: uuid, resource: "blocks" });
    const lists = (...ids: string[][]) => ids.map((l) => l.map(r));
    const ids = (merged: { uuid: string }[]) => merged.map((m) => m.uuid);
    // s is in two lists at rank 2; a and b are each in one list at rank 1.
    const base = lists(["a", "s"], ["b", "s"], []);
    expect(ids(mergeKeywordLists(base))).toEqual(["s", "a", "b"]);
    expect(ids(mergeKeywordLists([base[1], base[0], base[2]]))).toEqual(["s", "b", "a"]);
    expect(ids(mergeKeywordLists([...base].reverse()))).toEqual(["s", "b", "a"]);
    // A chain: each list's rank-1 entry is the next list's rank-2 entry.
    expect(ids(mergeKeywordLists(lists(["a", "b"], ["b", "c"], ["c", "a"])))).toEqual(["a", "b", "c"]);
    expect(ids(mergeKeywordLists(lists(["c", "a"], ["b", "c"], ["a", "b"])))).toEqual(["c", "a", "b"]);
    expect(mergeKeywordLists([])).toEqual([]);
  });

  it("wordCount counts the stored text on whitespace", () => {
    expect(wordCount("Dashboards")).toBe(1);
    expect(wordCount("Stock on hand")).toBe(3);
    expect(wordCount("  two   words ")).toBe(2);
    expect(wordCount("line one\nline\ttwo")).toBe(4);
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });

  it("the fake embedder uses the shared stopwords", () => {
    expect(STOPWORDS.size).toBeGreaterThan(0);
    for (const word of STOPWORDS) {
      expect(fakeEmbed(`dashboard ${word}`), word).toEqual(fakeEmbed("dashboard"));
    }
    // And a word outside the list does change the vector.
    expect(fakeEmbed("dashboard warehouse")).not.toEqual(fakeEmbed("dashboard"));
  });
});

describe("configuration", () => {
  it("is off without bindings, on with all three, and a config error with some", () => {
    expect(semanticBindings(testEnv())).toBeNull();
    expect(semanticBindings(semanticEnv())?.maxVectors).toBe(10_000);
    expect(() => semanticBindings(testEnv({ AI: {} as Ai }))).toThrow(ConfigError);
    expect(() => semanticBindings(testEnv({ VECTORIZE: {} as Vectorize, AI: {} as Ai }))).toThrow(/together/);
    expect(() => semanticBindings(semanticEnv("0"))).toThrow(/positive integer/);
    expect(() => semanticBindings(semanticEnv("1e3"))).toThrow(/positive integer/);
  });

  it("answers 500 to every request when the bindings are only half there", async () => {
    const connector = createConnector({ githubFetch: async () => new Response(null, { status: 599 }) });
    const res = await connector.fetch!(
      new Request(`${ORIGIN}/health`) as Request<unknown, IncomingRequestCfProperties>,
      testEnv({ VECTORIZE: index as unknown as Vectorize }),
      createExecutionContext(),
    );
    expect(res.status).toBe(500);
    expect(logged().join("\n")).toContain("semantic search needs AI, VECTORIZE and SEMANTIC_MAX_VECTORS together");
  });

  it("the Workers AI embedder checks the model's output shape", async () => {
    const ok = workersAiEmbedder({ run: async () => ({ data: [new Array(DIMENSIONS).fill(0)] }) } as unknown as Ai);
    expect(await ok.embed(["x"])).toHaveLength(1);
    const short = workersAiEmbedder({ run: async () => ({ data: [[1, 2]] }) } as unknown as Ai);
    await expect(short.embed(["x"])).rejects.toThrow(/unexpected shape/);
    const missing = workersAiEmbedder({ run: async () => ({ data: [] }) } as unknown as Ai);
    await expect(missing.embed(["x"])).rejects.toThrow(/unexpected shape/);
  });

  it("the indexer's feed is not a tool", () => {
    const spec = structuredClone(openapi) as unknown as OpenApiSpec;
    spec.paths["/api/v1/graphs/{graph-id}/block-changes"] = {
      get: {
        operationId: "listBlockChanges",
        parameters: [{ name: "graph-id", in: "path", required: true, schema: { type: "string" } }],
      },
    };
    expect(graphOperations(spec).map((op) => op.operationId)).not.toContain("listBlockChanges");
  });
});

describe("indexer", () => {
  function seedWork(blocks: number): string[] {
    const page = work.addPage("Engineering log");
    return Array.from({ length: blocks }, (_, i) => work.addBlock(page, `Note ${i}: deployed service ${i}`));
  }

  it("builds the index in bounded runs, then reports ready", async () => {
    seedWork(120);
    const first = await run();
    expect(first.graphs).toEqual([{ alias: "work", status: "building", pages: PAGES_PER_RUN, embedded: 100, deleted: 0 }]);
    expect(embedder.calls.map((c) => c.length)).toEqual([PAGE_SIZE, PAGE_SIZE]);
    expect(work.feedRequests).toHaveLength(PAGES_PER_RUN);
    expect((await semanticStore().state(WORK_ID))?.status).toBe("building");

    await expireLeases();
    const second = await run();
    expect(second.graphs[0]).toMatchObject({ status: "ready", embedded: 20, pages: 1 });
    expect(index.vectors.size).toBe(120);
    const state = await semanticStore().state(WORK_ID);
    expect(state).toMatchObject({ status: "ready", t: work.t, epoch: work.epoch, cursor: null, pendingT: null, error: null });
    for (const v of index.vectors.values()) expect(v.namespace).toBe(WORK_ID);
    await expectExactCounts();
    expect(await semanticStore().counts(WORK_ID)).toEqual({ graph: 120, total: 120 });
    expect(logged().some((l) => /^semantic index graph=work status=ready pages=1 embedded=20 deleted=0 ms=\d+$/.test(l))).toBe(true);
  });

  it("stays within the Free plan's 50 subrequests per run", async () => {
    seedWork(300);
    await graphs().add({
      alias: "home", graphId: HOME_ID, graphName: "Home", mode: "read", permission: "read", expiresAt: null, token: HOME_TOKEN,
    });
    home.addBlock(home.addPage("Home"), "Book the WOF");
    const d1 = vi.spyOn(env.DB, "prepare");
    const batch = vi.spyOn(env.DB, "batch");
    await run();
    // D1 round trips are prepare().run/first/all or one batch; count each batch once and each prepared statement outside one.
    const d1Calls = d1.mock.calls.length - batch.mock.calls.reduce((n, [stmts]) => n + stmts.length, 0) + batch.mock.calls.length;
    const syncCalls = work.feedRequests.length + home.feedRequests.length;
    const bindingCalls = embedder.calls.length + index.upserts + index.deletes + 1; // + describe
    expect(d1Calls + syncCalls + bindingCalls).toBeLessThanOrEqual(30);
    d1.mockRestore();
    batch.mockRestore();
  });

  it("re-embeds only blocks whose text changed, and nothing when nothing did", async () => {
    const [a, b] = seedWork(3);
    await runUntilReady();
    embedder.calls = [];
    const before = await rows();

    await run();
    await expireLeases();
    expect(embedder.calls).toEqual([]);
    expect(work.feedRequests.at(-1)?.searchParams.get("since")).toBe(String(work.t));

    work.edit(a, "Note 0: rolled back service 0");
    work.tagBlock(b, "ops");
    await run();
    expect(embedder.embeddedTexts).toEqual(["Engineering log > Note 0: rolled back service 0"]);
    const after = await rows();
    expect(after.find((r) => r.block_uuid === b)?.tags).toBe('["ops"]');
    expect(after.find((r) => r.block_uuid === b)?.hash).toBe(before.find((r) => r.block_uuid === b)?.hash);
    expect(after.find((r) => r.block_uuid === a)?.hash).not.toBe(before.find((r) => r.block_uuid === a)?.hash);
  });

  it("re-embeds a renamed page's blocks and a moved breadcrumb", async () => {
    const page = work.addPage("Inbox");
    const parent = work.addBlock(page, "Groceries");
    const child = work.addBlock(page, "Milk", { parent });
    await runUntilReady();
    embedder.calls = [];
    work.renamePage(page, "Shopping");
    await run();
    expect(embedder.embeddedTexts.sort()).toEqual(["Shopping > Groceries", "Shopping > Groceries > Milk"]);
    await expireLeases();
    embedder.calls = [];
    work.edit(parent, "Supermarket");
    await run();
    expect(embedder.embeddedTexts.sort()).toEqual(["Shopping > Supermarket", "Shopping > Supermarket > Milk"]);
    expect(child).toBeTruthy();
  });

  it("never embeds private blocks and drops blocks that become private", async () => {
    const secrets = work.addPage("Passwords", ["Private"]);
    work.addBlock(secrets, "bank pin 1234");
    const journal = work.addPage("Journal");
    const diary = work.addBlock(journal, "Therapy notes", { tags: ["PRIVATE"] });
    work.addBlock(journal, "Feeling better", { parent: diary });
    const plan = work.addBlock(journal, "Plan the offsite");
    const detail = work.addBlock(journal, "Book the venue", { parent: plan });
    await runUntilReady();
    expect(embedder.embeddedTexts.sort()).toEqual(["Journal > Plan the offsite", "Journal > Plan the offsite > Book the venue"]);
    expect((await rows()).map((r) => r.block_uuid).sort()).toEqual([plan, detail].sort());

    work.tagBlock(plan, "private");
    await run();
    expect(await rows()).toEqual([]);
    expect(index.vectors.size).toBe(0);
  });

  it("deletes removed blocks, and stale rows found by a full listing after a reset", async () => {
    const [a, b, c] = seedWork(3);
    await runUntilReady();
    work.remove(a);
    await run();
    expect((await rows()).map((r) => r.block_uuid)).toEqual([b, c]);
    expect(index.vectors.size).toBe(2);

    await expireLeases();
    work.remove(b, { silently: true }); // gone in a re-uploaded snapshot: no change recorded
    work.reset();
    embedder.calls = [];
    await run();
    expect(work.feedRequests.at(-2)?.searchParams.get("since")).not.toBeNull(); // answered 410
    expect(work.feedRequests.at(-1)?.searchParams.get("since")).toBeNull(); // full listing
    expect((await rows()).map((r) => r.block_uuid)).toEqual([c]);
    expect(index.vectors.size).toBe(1);
    expect(embedder.calls).toEqual([]); // c's text is unchanged
    await expectExactCounts();
    expect(await semanticStore().state(WORK_ID)).toMatchObject({ status: "ready", epoch: "epoch-2", t: work.t });
  });

  it("sweeps stale rows across the pages of a full listing", async () => {
    const ids = seedWork(130);
    await runUntilReady();
    const gone = [ids[10], ids[75], ids[129]];
    for (const id of gone) work.remove(id, { silently: true });
    work.reset();
    await runUntilReady();
    expect((await rows()).map((r) => r.block_uuid)).toEqual(ids.filter((id) => !gone.includes(id)));
    expect(index.vectors.size).toBe(127);
    await expectExactCounts();
    expect(await semanticStore().total()).toBe(127);
  });

  it("stops at the vector cap and says so", async () => {
    seedWork(60);
    await run(40);
    const state = await semanticStore().state(WORK_ID);
    expect(state?.status).toBe("full");
    expect(state?.error).toMatch(/index is full: 0 of 40 vectors stored and this page adds 50/);
    expect(index.vectors.size).toBe(0);
    await expireLeases();
    await run(1000);
    expect(index.vectors.size).toBe(60);
    await expectExactCounts();
  });

  it("checks the cap against every graph's blocks without counting the blocks", async () => {
    seedWork(30);
    const page = home.addPage("Garden");
    for (let i = 0; i < 30; i++) home.addBlock(page, `Plant ${i}`);
    await graphs().add({
      alias: "home", graphId: HOME_ID, graphName: "Home", mode: "write", permission: "both", expiresAt: null, token: HOME_TOKEN,
    });
    await run(50);
    // Whichever graph runs second finds the first one's 30 blocks in the total.
    const states = await semanticStore().states();
    expect(states.map((s) => s.status).sort()).toEqual(["full", "ready"]);
    expect(states.find((s) => s.status === "full")?.error).toMatch(/index is full: 30 of 50 vectors stored and this page adds 30/);
    await expectExactCounts();
  });

  it("refuses a block row for a graph with no state row", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO semantic_blocks (vector_id, graph_id, block_uuid, page_uuid, page_title, breadcrumb, text, tags, hash) VALUES ('v', 'g', 'b', 'p', 'P', '[]', 't', '[]', 'h')",
      ).run(),
    ).rejects.toThrow(/semantic_blocks row without a semantic_state row/);
  });

  it("records token, encryption and model failures on the graph and recovers", async () => {
    seedWork(3);
    work.failStatus = 401;
    await run();
    let state = await semanticStore().state(WORK_ID);
    expect(state).toMatchObject({ status: "error" });
    expect(state?.error).toBe("token for graph 'work' expired or lacks permission — reconnect it at https://mcp.example.com/graphs");

    await expireLeases();
    work.failStatus = null;
    embedder.failWith = new Error("3036: daily neuron allocation exhausted");
    await run();
    state = await semanticStore().state(WORK_ID);
    expect(state?.status).toBe("error");
    expect(state?.error).toBe("Workers AI embedding failed: 3036: daily neuron allocation exhausted");
    expect(state?.cursor).toBeNull();
    expect(index.vectors.size).toBe(0);

    await expireLeases();
    embedder.failWith = null;
    await run();
    expect((await semanticStore().state(WORK_ID))?.status).toBe("ready");

    await expireLeases();
    work.e2ee = true;
    await run();
    expect(await semanticStore().state(WORK_ID)).toMatchObject({ status: "skipped-e2ee" });
  });

  it("stops for the run on a rate limit without changing the state", async () => {
    seedWork(3);
    work.failStatus = 429;
    const report = await run();
    expect(report.graphs[0].status).toBe("rate-limited");
    expect((await semanticStore().state(WORK_ID))?.status).toBe("building");
  });

  it("refuses an index with the wrong dimensions", async () => {
    seedWork(3);
    index.dimensions = 768;
    await expect(run()).rejects.toThrow("the Vectorize index has 768 dimensions; semantic search needs 384");
  });

  it("leaves a graph alone while another run holds its lease", async () => {
    seedWork(3);
    const held = await semanticStore().lease(WORK_ID, Date.now(), Date.now() + 50_000);
    expect(held?.status).toBe("building");
    const report = await run();
    expect(report.graphs[0].status).toBe("leased");
    expect(work.feedRequests).toHaveLength(0);
  });

  it("deletes a disconnected graph's vectors and state", async () => {
    seedWork(3);
    await runUntilReady();
    await graphs().remove("work");
    const report = await run();
    expect(report.orphansDeleted).toBe(3);
    expect(index.vectors.size).toBe(0);
    expect(await rows()).toEqual([]);
    await expectExactCounts();
    await run();
    expect(await semanticStore().state(WORK_ID)).toBeNull();
  });

  it("runs from the Worker's cron only when semantic search is configured", async () => {
    seedWork(3);
    const connector = createConnector({ githubFetch: async () => new Response(null, { status: 599 }) });
    const controller = { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
    await expect(connector.scheduled!(controller, testEnv(), createExecutionContext())).rejects.toThrow(
      /semantic search is not configured/,
    );
    await connector.scheduled!(controller, semanticEnv(), createExecutionContext());
    expect(index.vectors.size).toBe(3);
  });
});

type Handler = (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>;

async function rpc(e: Env, method: string, params: unknown): Promise<any> {
  const handler: Handler = (request, _env, ctx) => mcpHandler(e, ctx)(request, e, ctx);
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ctx = createExecutionContext();
  const res = await handler(request, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 1)
    : JSON.parse(text);
  expect(json.error).toBeUndefined();
  return json.result;
}

async function callTool(e: Env, name: string, args: Record<string, unknown>) {
  const result = await rpc(e, "tools/call", { name, arguments: args });
  return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

describe("tools", () => {
  it("are listed only when semantic search is configured, with help to match", async () => {
    const off = (await rpc(testEnv(), "tools/list", {})).tools.map((t: { name: string }) => t.name).sort();
    expect(off).toEqual(committedManifest.map((e) => e.name).filter((n) => !SEMANTIC_TOOLS.includes(n)));
    const onTools = (await rpc(semanticEnv(), "tools/list", {})).tools;
    expect(onTools.map((t: { name: string }) => t.name).sort()).toEqual(committedManifest.map((e) => e.name));
    for (const name of SEMANTIC_TOOLS) {
      const tool = onTools.find((t: { name: string }) => t.name === name);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.required).toContain("graph");
    }
    expect((await callTool(testEnv(), "connector_help", {})).text).not.toContain("semantic_search");
    expect((await callTool(semanticEnv(), "connector_help", {})).text).toContain("semantic_search");
  });

  it("semantic_search merges meaning and title matches and says which found each", async () => {
    const page = work.addPage("Car");
    const wof = work.addBlock(page, "Book the WOF before March");
    const tyres = work.addBlock(page, "Rotate the tyres at the mechanic");
    const other = work.addBlock(work.addPage("Recipes"), "Car-free Sunday lunch");
    await runUntilReady();

    const result = await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "car", limit: 5 });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.index).toEqual({ status: "ready", blocks: 3 });
    const byUuid = new Map(body.results.map((r: { uuid: string }) => [r.uuid, r]));
    expect(byUuid.get(page)).toMatchObject({ resource: "pages", text: "Car", "found-by": ["keyword"] });
    expect(byUuid.get(other)).toMatchObject({ page: "Recipes", text: "Car-free Sunday lunch" });
    expect((byUuid.get(other) as { "found-by": string[] })["found-by"]).toContain("keyword");
    expect(byUuid.get(wof)).toMatchObject({ page: "Car", breadcrumb: [], text: "Book the WOF before March" });
    expect((byUuid.get(wof) as { "found-by": string[] })["found-by"]).toContain("semantic");
    expect((byUuid.get(tyres) as { "found-by": string[] })["found-by"]).toContain("semantic");
    for (let i = 1; i < body.results.length; i++) expect(body.results[i - 1].score).toBeGreaterThanOrEqual(body.results[i].score);
    expect(home.searchRequests).toHaveLength(0);
    expect(work.searchRequests[0].searchParams.get("types")).toBe("blocks,pages");
    expect(logged().at(-1)).toMatch(/^tool semantic_search graph=work status=ok ms=\d+$/);
  });

  it("semantic_search filters by tag on both sides and limits results", async () => {
    const page = work.addPage("Trips", ["travel-plans"]);
    work.addBlock(page, "Flights to Queenstown booked");
    work.addBlock(work.addPage("Work"), "Queenstown offsite budget");
    await runUntilReady();
    const body = JSON.parse((await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "Queenstown", tag: "Travel-Plans" })).text);
    expect(body.results.map((r: { text: string }) => r.text)).toEqual(["Flights to Queenstown booked"]);
    const one = JSON.parse((await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "Queenstown", limit: 1 })).text);
    expect(one.results).toHaveLength(1);
  });

  it("semantic_search drops a vector whose row was just deleted", async () => {
    const a = work.addBlock(work.addPage("P"), "Quarterly budget review");
    await runUntilReady();
    await env.DB.exec("DELETE FROM semantic_blocks");
    const body = JSON.parse((await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "money" })).text);
    expect(body.results).toEqual([]);
    expect(index.vectors.size).toBe(1);
    expect(a).toBeTruthy();
  });

  it("semantic_search refuses an unknown graph and reports model failures as tool errors", async () => {
    const unknown = await callTool(semanticEnv(), "semantic_search", { graph: "nope", q: "x" });
    expect(unknown).toEqual({ isError: true, text: "unknown graph 'nope' — call list_graphs for the connected aliases" });
    embedder.failWith = new Error("model down");
    const failed = await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "x" });
    expect(failed).toEqual({ isError: true, text: "semantic query failed: model down" });
  });

  it("semantic_index_status reports the graph and the index", async () => {
    seedTwo();
    await runUntilReady();
    const status = JSON.parse((await callTool(semanticEnv("5000"), "semantic_index_status", { graph: "work" })).text);
    expect(status).toMatchObject({
      graph: "work",
      status: "ready",
      "indexed-blocks": 2,
      "listing-in-progress": null,
      error: null,
      index: { model: "@cf/baai/bge-small-en-v1.5", dimensions: 384, "expected-dimensions": 384, vectors: 2, "stored-blocks": 2, "max-vectors": 5000 },
    });
    expect(typeof status["indexed-at"]).toBe("string");
  });

  function seedTwo() {
    const page = work.addPage("P");
    work.addBlock(page, "one");
    work.addBlock(page, "two");
  }
});

describe("similarity and ranks", () => {
  // Crafted vectors: the query is axis 0, so a block's cosine is exactly the value given to `block`.
  // A block given null is orthogonal to the query and never comes back by meaning.
  const Q = "northwind";
  let crafted: CraftedEmbedder;

  beforeEach(() => {
    crafted = new CraftedEmbedder();
    embedder = crafted;
    crafted.vectors.set(Q, axis(0));
  });

  function block(pageTitle: string, pageId: string, text: string, cos: number | null): string {
    crafted.vectors.set(documentText({ pageTitle, breadcrumb: [], text }), cos === null ? axis(2) : unitAt(cos));
    return work.addBlock(pageId, text);
  }

  interface Body {
    results: { uuid: string; text: string; similarity: number | null; "semantic-rank": number | null; "keyword-rank": number | null; "found-by": string[] }[];
    index: unknown;
    "below-min-similarity"?: number;
  }

  async function search(args: Record<string, unknown> = {}): Promise<Body> {
    const result = await callTool(semanticEnv(), "semantic_search", { graph: "work", q: Q, limit: 50, ...args });
    expect(result.isError, result.text).toBe(false);
    return JSON.parse(result.text);
  }

  function hit(body: Body, uuid: string) {
    const found = body.results.find((r) => r.uuid === uuid);
    expect(found, uuid).toBeDefined();
    return found!;
  }

  it("similarity is the index's cosine at 3 dp, with the semantic rank", async () => {
    const stock = work.addPage("Stock");
    const top = block("Stock", stock, "Pallet count for aisle four", 0.8125);
    const second = block("Stock", stock, "Forklift service due", 0.5);
    await runUntilReady();
    const body = await search();
    expect(hit(body, top)).toMatchObject({ similarity: 0.813, "semantic-rank": 1, "found-by": ["semantic"] });
    expect(hit(body, second)).toMatchObject({ similarity: 0.5, "semantic-rank": 2 });
  });

  it("keyword-rank is null for a semantic-only hit; similarity and semantic-rank are null for a keyword-only hit", async () => {
    const page = work.addPage("Northwind warehouse");
    const meaning = block("Stock", work.addPage("Stock"), "Pallet count for aisle four", 0.7);
    await runUntilReady();
    const body = await search();
    expect(hit(body, page)).toMatchObject({ similarity: null, "semantic-rank": null, "keyword-rank": 1, "found-by": ["keyword"] });
    expect(hit(body, meaning)).toMatchObject({ similarity: 0.7, "semantic-rank": 1, "keyword-rank": null, "found-by": ["semantic"] });
  });

  it("an indexed keyword hit outside the semantic top 50 has null similarity, from one Vectorize query", async () => {
    const filler = work.addPage("Filler");
    for (let i = 0; i < 51; i++) block("Filler", filler, `filler line ${i}`, 0.9);
    const target = block("Accounts", work.addPage("Accounts"), "Northwind invoice", 0.1);
    await runUntilReady();
    expect((await rows()).map((r) => r.block_uuid)).toContain(target);
    index.queries = 0;
    crafted.calls = [];
    work.searchRequests = [];
    const body = await search();
    expect(hit(body, target)).toMatchObject({ similarity: null, "semantic-rank": null, "keyword-rank": 1, "found-by": ["keyword"] });
    expect(index.queries).toBe(1);
    expect(crafted.calls).toEqual([[Q]]);
    expect(work.searchRequests).toHaveLength(1);
  });

  it("ranks are after the tag filter", async () => {
    const trips = work.addPage("Trips", ["travel"]);
    block("Office", work.addPage("Office"), "Office hours", 0.9);
    const ferry = block("Trips", trips, "Ferry times", 0.8);
    await runUntilReady();
    const body = await search({ tag: "travel" });
    expect(body.results.map((r) => r.uuid)).toEqual([ferry]);
    expect(hit(body, ferry)).toMatchObject({ similarity: 0.8, "semantic-rank": 1 });
  });

  it("min_similarity drops below the value on the raw cosine, keeps one at it and keeps keyword-only hits", async () => {
    const stock = work.addPage("Stock");
    const kept = block("Stock", stock, "Pallet count for aisle four", 0.6);
    const dropped = block("Stock", stock, "Forklift service due", 0.5996);
    const decoy = block("Stock", stock, "Northwind decoy", null);
    await runUntilReady();

    const without = await search();
    expect(without).not.toHaveProperty("below-min-similarity");
    expect(hit(without, dropped)).toMatchObject({ similarity: 0.6, "semantic-rank": 2 });

    const body = await search({ min_similarity: 0.6 });
    expect(body["below-min-similarity"]).toBe(1);
    expect(body.results.map((r) => r.uuid).sort()).toEqual([kept, decoy].sort());
    expect(hit(body, kept)).toMatchObject({ similarity: 0.6, "semantic-rank": 1 });
    expect(hit(body, decoy)).toMatchObject({ similarity: null, "semantic-rank": null, "keyword-rank": 1 });
  });

  it("min_similarity 0 drops nothing and reports 0; tag-filtered and deleted rows are not counted", async () => {
    const trips = work.addPage("Trips", ["travel"]);
    const a = block("Trips", trips, "Ferry times", 0.3);
    const c = block("Trips", trips, "Hostel booking", 0.1);
    block("Office", work.addPage("Office"), "Office hours", 0.2);
    const gone = block("Gone", work.addPage("Gone"), "Old note", 0.05);
    await runUntilReady();
    await env.DB.prepare("DELETE FROM semantic_blocks WHERE block_uuid = ?").bind(gone).run();

    const zero = await search({ tag: "travel", min_similarity: 0 });
    expect(zero["below-min-similarity"]).toBe(0);
    expect(zero.results.map((r) => r.uuid)).toEqual([a, c]);

    const tagged = await search({ tag: "travel", min_similarity: 0.25 });
    expect(tagged.results.map((r) => r.uuid)).toEqual([a]);
    expect(tagged["below-min-similarity"]).toBe(1);

    const untagged = await search({ min_similarity: 0.25 });
    expect(untagged.results.map((r) => r.uuid)).toEqual([a]);
    expect(untagged["below-min-similarity"]).toBe(2);
  });

  it("zod refuses min_similarity outside 0 to 1, and the schema says so", async () => {
    block("Stock", work.addPage("Stock"), "Pallet count", 0.7);
    await runUntilReady();
    for (const value of [-0.1, 1.1]) {
      const result = await callTool(semanticEnv(), "semantic_search", { graph: "work", q: Q, min_similarity: value });
      expect(result.isError, String(value)).toBe(true);
      expect(result.text, String(value)).toContain("min_similarity");
    }
    expect((await search({ min_similarity: 1 }))["below-min-similarity"]).toBe(1);
    const tool = (await rpc(semanticEnv(), "tools/list", {})).tools.find((t: { name: string }) => t.name === "semantic_search");
    expect(tool.inputSchema.properties.min_similarity).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(tool.inputSchema.required).not.toContain("min_similarity");
  });

  describe("short blocks (design 2026-11-07 section 3.2)", () => {
    // Three content words, none of them in any block's or page's title, so the keyword leg's term
    // searches return nothing and the semantic order alone decides the results.
    const MULTI = "inventory level reporting";
    const order = (body: Body) => body.results.map((r) => r.uuid);

    function query(q: string): string {
      crafted.vectors.set(q, axis(0));
      return q;
    }

    it("a 2-word block at 0.58 drops below a 3-word block at 0.46 for a 3-content-word query, past a 0.50 decoy", async () => {
      const page = work.addPage("Warehouse");
      const short = block("Warehouse", page, "Stock dashboards", 0.58);
      const decoy = block("Warehouse", page, "Forklift service due Friday", 0.5);
      const target = block("Warehouse", page, "Stock on hand", 0.46);
      await runUntilReady();
      expect(contentWords(MULTI)).toHaveLength(3);
      // 0.58 x 0.75 = 0.435 < 0.46, while 0.58 x 0.85 = 0.493 would stay above it: the weight is pinned.
      const body = await search({ q: query(MULTI) });
      expect(order(body)).toEqual([decoy, target, short]);
      expect(body.results.every((r) => r["keyword-rank"] === null)).toBe(true);
      // Ordering only: the demoted block reports its raw cosine and its rank after the rule.
      expect(hit(body, short)).toMatchObject({ similarity: 0.58, "semantic-rank": 3 });
      expect(hit(body, target)).toMatchObject({ similarity: 0.46, "semantic-rank": 2 });
      // The floor compares the raw value: 0.58 passes 0.5 although its ordering value is 0.435.
      const floored = await search({ q: query(MULTI), min_similarity: 0.5 });
      expect(order(floored)).toEqual([decoy, short]);
      expect(floored["below-min-similarity"]).toBe(1);
      expect(hit(floored, short)).toMatchObject({ similarity: 0.58, "semantic-rank": 2 });
    });

    it("demotes 1-word and whitespace-padded 2-word blocks, and any query of 3 or more content words", async () => {
      const page = work.addPage("Warehouse");
      const one = block("Warehouse", page, "Dashboards", 0.58);
      const padded = block("Warehouse", page, "  Stock \t  dashboards ", 0.57);
      const target = block("Warehouse", page, "Stock on hand", 0.46);
      await runUntilReady();
      for (const q of [MULTI, "weekly inventory level reporting", "what is the inventory level reporting?"]) {
        expect(contentWords(q).length, q).toBeGreaterThanOrEqual(3);
        expect(order(await search({ q: query(q) })), q).toEqual([target, one, padded]);
      }
    });

    it("does not demote for a query of 2 content words, stopwords and short words aside", async () => {
      const page = work.addPage("Warehouse");
      const short = block("Warehouse", page, "Stock dashboards", 0.58);
      const decoy = block("Warehouse", page, "Forklift service due Friday", 0.5);
      const target = block("Warehouse", page, "Stock on hand", 0.46);
      await runUntilReady();
      for (const q of ["stock reporting", "is it the stock reporting of us?", "reporting"]) {
        expect(contentWords(q).length, q).toBeLessThan(3);
        expect(order(await search({ q: query(q) })), q).toEqual([short, decoy, target]);
      }
    });

    it("does not demote a 3-word block, whose text alone is counted (not the page title or breadcrumb)", async () => {
      const page = work.addPage("Warehouse");
      const three = block("Warehouse", page, "Stock on hand", 0.58);
      const decoy = block("Warehouse", page, "Forklift service due Friday", 0.5);
      const four = block("Warehouse", page, "Pallets in aisle four", 0.46);
      // A 2-word child: its document ("Northwind warehouse > Stock on hand > Reorder now") is long, its text is not.
      const parentTitle = "Northwind warehouse";
      const other = work.addPage(parentTitle);
      const parent = work.addBlock(other, "Stock on hand counts");
      crafted.vectors.set(documentText({ pageTitle: parentTitle, breadcrumb: [], text: "Stock on hand counts" }), axis(3));
      crafted.vectors.set(documentText({ pageTitle: parentTitle, breadcrumb: ["Stock on hand counts"], text: "Reorder now" }), unitAt(0.55));
      const child = work.addBlock(other, "Reorder now", { parent });
      await runUntilReady();
      expect(order(await search({ q: query(MULTI) }))).toEqual([three, decoy, four, child]);
    });

    it("ties after demotion keep vector order", async () => {
      const page = work.addPage("Warehouse");
      // 0.5 x 0.75 = 0.375 exactly, equal to the 3-word block's raw 0.375; vector order puts the short block first.
      const long = block("Warehouse", page, "Stock on hand", 0.375);
      const short = block("Warehouse", page, "Stock dashboards", 0.5);
      await runUntilReady();
      expect(order(await search({ q: query(MULTI) }))).toEqual([short, long]);
    });

    it("adds no D1 statement: the demoting search prepares the same statements as one that does not demote", async () => {
      const page = work.addPage("Warehouse");
      block("Warehouse", page, "Stock dashboards", 0.58);
      block("Warehouse", page, "Stock on hand", 0.46);
      await runUntilReady();
      const statements: string[] = [];
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") return (sql: string) => (statements.push(sql), target.prepare(sql));
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const run = async (q: string) => {
        statements.length = 0;
        const result = await callTool({ ...semanticEnv(), DB: db } as Env, "semantic_search", { graph: "work", q: query(q) });
        expect(result.isError, result.text).toBe(false);
        return [...statements];
      };
      const demoting = await run(MULTI);
      const plain = await run("stock reporting");
      expect(demoting).toEqual(plain);
      expect(demoting.filter((sql) => sql.includes("semantic_"))).toHaveLength(3);
    });
  });
});

describe("keyword leg (design 2026-11-07 section 3.3)", () => {
  interface Hit {
    uuid: string;
    text: string;
    "keyword-rank": number | null;
    "found-by": string[];
  }

  async function search(q: string, args: Record<string, unknown> = {}, e: Env = semanticEnv()): Promise<Hit[]> {
    const result = await callTool(e, "semantic_search", { graph: "work", q, limit: 50, ...args });
    expect(result.isError, result.text).toBe(false);
    return JSON.parse(result.text).results;
  }

  /** Each keyword hit's uuid in keyword-rank order. */
  function keywordOrder(hits: Hit[]): string[] {
    return hits
      .filter((h) => h["keyword-rank"] !== null)
      .sort((a, b) => a["keyword-rank"]! - b["keyword-rank"]!)
      .map((h) => h.uuid);
  }

  const requested = () => work.searchRequests.map((u) => [u.searchParams.get("q"), u.searchParams.get("limit"), u.searchParams.get("types")]);

  // "reporting dashboard stock": the terms are reporting, dashboard, stock (9, 9, 5 characters).
  const Q3 = "reporting dashboard stock";

  it("a uuid matched by 2 terms at rank 3 beats one matched by 1 term at rank 1, with a best-rank decoy", async () => {
    const misc = work.addPage("Misc");
    // searchGraph orders a term's blocks alphabetically, so the prefixes set each rank.
    const one = work.addBlock(misc, "aa reporting one"); // reporting rank 1
    const decoy = work.addBlock(misc, "bb reporting decoy"); // reporting rank 2, before x in first appearance
    const two = work.addBlock(misc, "cc reporting dashboard two"); // reporting rank 3, dashboard rank 3
    const x = work.addBlock(misc, "ab dashboard x"); // dashboard rank 1
    const y = work.addBlock(misc, "ac dashboard y"); // dashboard rank 2
    await runUntilReady();
    expect(distinctiveTerms(Q3)).toEqual(["reporting", "dashboard", "stock"]);
    // "stock" matches nothing; an empty term list is not a failure.
    expect(keywordOrder(await search(Q3))).toEqual([two, one, x, decoy, y]);
  });

  it("three lists beat two at any rank; a uuid repeated in one list counts once", async () => {
    const misc = work.addPage("Misc");
    const three = work.addBlock(misc, "zz reporting dashboard stock"); // last in all three lists
    const twoFirst = work.addBlock(misc, "aa reporting dashboard"); // reporting 1, dashboard 2
    // A page and a block sharing one uuid: twice in the stock list, once in the dashboard list.
    const repeated = work.addPage("Stock dashboard pp");
    work.addBlock(misc, "pp stock", { uuid: repeated });
    await runUntilReady();
    const hits = await search(Q3);
    expect(keywordOrder(hits)).toEqual([three, twoFirst, repeated]);
    expect(hits.filter((h) => h.uuid === repeated)).toHaveLength(1);
  });

  it("sends one request per term with limit=20 and types=blocks,pages, in term order", async () => {
    work.addBlock(work.addPage("Misc"), "Stock on hand dashboard");
    await runUntilReady();
    const cases: [string, string[]][] = [
      ["stock level reporting dashboard", ["reporting", "dashboard", "stock"]],
      ["When is the car's warrant of fitness due?", ["warrant", "fitness", "car"]],
      ["weekly regional sales figures for the northern warehouses", ["warehouses", "regional", "northern"]],
      ["Stock LEVEL dashboard", ["dashboard", "stock", "level"]],
    ];
    for (const [q, terms] of cases) {
      expect(distinctiveTerms(q), q).toEqual(terms);
      work.searchRequests = [];
      await search(q);
      expect(requested(), q).toEqual(terms.map((t) => [t, "20", "blocks,pages"]));
    }
  });

  it("caps the merged list at 50 before blocksFor and before the tag filter", async () => {
    const misc = work.addPage("Misc");
    const pad = (i: number) => String(i).padStart(2, "0");
    // 70 matching blocks; each term answers 20, so 60 distinct uuids reach the merge.
    const seeded = new Map<string, string>();
    for (const [term, n] of [["reporting", 24], ["dashboard", 23], ["stock", 23]] as const) {
      for (let i = 0; i < n; i++) {
        const text = `${term} item ${pad(i)}`;
        const tags = text === "reporting item 00" || text === "stock item 19" ? ["cut"] : [];
        seeded.set(text, work.addBlock(misc, text, { tags }));
      }
    }
    await runUntilReady();
    const binds: unknown[][] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("json_each")) return statement;
            return new Proxy(statement, {
              get(st, p) {
                if (p === "bind") return (...args: unknown[]) => (binds.push(args), st.bind(...args));
                const value = Reflect.get(st, p);
                return typeof value === "function" ? value.bind(st) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const e = { ...semanticEnv(), DB: db } as Env;
    const hits = await search(Q3, {}, e);
    expect(binds).toHaveLength(1);
    const keywordUuids = JSON.parse(binds[0][2] as string) as string[];
    expect(keywordUuids).toHaveLength(50);
    expect(Math.max(...hits.map((h) => h["keyword-rank"] ?? 0))).toBeLessThanOrEqual(50);
    // Merged order is rank 1 of each term in term order, then rank 2, ...: rank 17's stock block is 51st.
    expect(keywordUuids.at(-1)).toBe(seeded.get("dashboard item 16"));
    expect(keywordUuids).not.toContain(seeded.get("stock item 16"));
    // The tag filter runs after the cap: a tagged block past the cap is not a keyword hit.
    const tagged = await search(Q3, { tag: "cut" });
    expect(keywordOrder(tagged)).toEqual([seeded.get("reporting item 00")]);
    const late = tagged.find((h) => h.uuid === seeded.get("stock item 19"));
    expect(late?.["keyword-rank"] ?? null).toBeNull();
  });

  it("a query of 2 content words or fewer sends one whole-phrase request with limit 50", async () => {
    work.addBlock(work.addPage("Car"), "Is it the WOF due soon");
    await runUntilReady();
    for (const q of ["stock reporting", "is it the WOF due", "rego", "is it", "dashboard dashboards Dashboard", "Queenstown"]) {
      expect(contentWords(q).length, q).toBeLessThan(RANKED_QUERY_WORDS);
      work.searchRequests = [];
      await search(q);
      expect(requested(), q).toEqual([[q, "50", "blocks,pages"]]);
    }
  });

  it("a failed term names the term; with two failing, the first in term order", async () => {
    work.addBlock(work.addPage("Misc"), "Stock on hand dashboard");
    await runUntilReady();
    const q = "stock level reporting dashboard"; // terms: reporting, dashboard, stock

    work.failSearchFor = "dashboard";
    const one = await callTool(semanticEnv(), "semantic_search", { graph: "work", q });
    expect(one.isError).toBe(true);
    expect(one.text).toBe('keyword search for "dashboard": sync server error (HTTP 500): search for dashboard failed');
    expect(logged().at(-1)).toMatch(/^tool semantic_search graph=work status=http-500 ms=\d+$/);

    // dashboard answers 50 ms after stock, so the first failure in time is stock's.
    work.failSearchFor = ["stock", "dashboard"];
    work.searchDelays.set("dashboard", 50);
    const two = await callTool(semanticEnv(), "semantic_search", { graph: "work", q });
    expect(two.text).toMatch(/^keyword search for "dashboard": /);
    work.failSearchFor = ["stock"];
    expect((await callTool(semanticEnv(), "semantic_search", { graph: "work", q })).text).toMatch(/^keyword search for "stock": /);

    // Every request failing names the first term; a whole-phrase query keeps today's text.
    work.failSearchFor = null;
    work.failStatus = 503;
    expect((await callTool(semanticEnv(), "semantic_search", { graph: "work", q })).text).toMatch(/^keyword search for "reporting": sync server error \(HTTP 503\)/);
    expect((await callTool(semanticEnv(), "semantic_search", { graph: "work", q: "stock" })).text).toMatch(/^sync server error \(HTTP 503\)/);
  });

  it("the warehouse question finds its target through both legs", async () => {
    const page = work.addPage("Warehouse reporting");
    work.addBlock(page, "Dashboards");
    work.addBlock(page, "Reports");
    const target = work.addBlock(page, "Stock on hand dashboard for the Northwind warehouse, refreshed nightly");
    work.addBlock(page, "Sales by region report, sent to the team every Monday");
    work.addBlock(page, "Reorder levels reviewed each quarter");
    await runUntilReady();
    const hits = await search("stock level reporting dashboard", { limit: 5 });
    const found = hits.find((h) => h.uuid === target);
    expect(found).toBeDefined();
    expect(found!["keyword-rank"]).not.toBeNull();
    expect([...found!["found-by"]].sort()).toEqual(["keyword", "semantic"]);
    expect(hits[0].uuid).toBe(target);
  });
});

it("fake embeddings put synonyms near each other", () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  expect(dot(fakeEmbed("car service"), fakeEmbed("vehicle servicing"))).toBeGreaterThan(0.9);
  expect(dot(fakeEmbed("car service"), fakeEmbed("birthday cake"))).toBe(0);
});
