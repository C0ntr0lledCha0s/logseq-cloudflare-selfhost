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
  PAGE_SIZE,
  type SemanticBindings,
  semanticBindings,
  workersAiEmbedder,
} from "../src/semantic/config";
import { documentText, parseFeedPage, toDocument, vectorId } from "../src/semantic/document";
import { runIndexer } from "../src/semantic/indexer";
import { reciprocalRankFusion } from "../src/semantic/rrf";
import { SemanticStore } from "../src/semantic/store";
import { type OpenApiSpec, SEMANTIC_TOOLS, graphOperations } from "../src/tools/spec.mjs";
import { FakeEmbedder, FakeGraph, FakeVectorIndex, fakeEmbed, fakeSync } from "./semantic-fakes";

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

it("fake embeddings put synonyms near each other", () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  expect(dot(fakeEmbed("car service"), fakeEmbed("vehicle servicing"))).toBeGreaterThan(0.9);
  expect(dot(fakeEmbed("car service"), fakeEmbed("birthday cake"))).toBe(0);
});
