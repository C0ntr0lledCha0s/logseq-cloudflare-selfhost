import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { mcpHandler } from "../src/mcp";
import { KB_INDEX_MAX_AGE_MS, type KbIndexEntry, kbGroup } from "../src/tools/kb-index";

const ORIGIN = "https://mcp.example.com";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const NOTES_ID = "22222222-2222-2222-2222-222222222222";
const DAY = Date.UTC(2026, 10, 1);

type SyncHandler = (request: Request) => Response | Promise<Response>;
let syncHandler: SyncHandler;
let syncRequests: URL[];
let consoleSpies: MockInstance[];

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

function testEnv(): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      syncRequests.push(new URL(request.url));
      return syncHandler(request);
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync } as Env;
}

function entry(
  title: string,
  tags: string[],
  classes: string[],
  refs: number,
  summary?: string,
): KbIndexEntry {
  return {
    uuid: `00000000-0000-0000-0000-${String(title.length).padStart(12, "0")}`,
    title,
    tags: tags.map((t) => ({ uuid: `tag-${t}`, title: t })),
    classes,
    "reference-count": refs,
    "updated-at": DAY,
    ...(summary === undefined ? {} : { summary }),
  };
}

const PAGES: KbIndexEntry[] = [
  entry("Acme", ["Company"], ["Company", "Organization"], 30, "A client."),
  entry("Health", ["Area"], ["Area"], 3, "Keeping fit."),
  entry("Jane Doe", ["BusinessPerson"], ["BusinessPerson", "Person"], 8, "Account lead at Acme."),
  entry("Kickoff", ["Business Meeting"], ["Business Meeting", "Event"], 2, "First meeting."),
  entry("Loose note", [], [], 0),
  entry("Roadmap", ["Project"], ["Project"], 12, "Plan for [[Acme]]."),
  entry("Side project", ["Project"], ["Project"], 1, "x".repeat(400)),
  entry("Style guide", ["Article"], ["Article", "CreativeWork"], 1, "How we write."),
];

/** Serves PAGES in pages of three, like the sync server's listKnowledgeIndex. */
function serveIndex(pages: KbIndexEntry[] = PAGES): SyncHandler {
  return (request) => {
    const url = new URL(request.url);
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const next = start + 3;
    return Response.json({
      pages: pages.slice(start, next),
      ...(next < pages.length ? { "next-cursor": String(next) } : {}),
    });
  };
}

async function clearKv(): Promise<void> {
  const { keys } = await env.KB_INDEX_KV.list();
  await Promise.all(keys.map((k) => env.KB_INDEX_KV.delete(k.name)));
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await clearKv();
  for (const [alias, graphId, mode] of [
    ["work", WORK_ID, "write"],
    ["notes", NOTES_ID, "read"],
  ] as const) {
    await store().add({
      alias,
      graphId,
      graphName: alias,
      mode,
      permission: mode === "write" ? "both" : "read",
      expiresAt: null,
      token: `logseq_pat_${alias}Token123`,
    });
  }
  syncRequests = [];
  syncHandler = serveIndex();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function logged(): string[] {
  return consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  e: Env = testEnv(),
): Promise<{ isError: boolean; text: string }> {
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ctx = createExecutionContext();
  const res = await mcpHandler(e, ctx)(request, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((msg) => msg.id === 1)
    : JSON.parse(text);
  expect(json.error).toBeUndefined();
  return {
    isError: json.result.isError === true,
    text: json.result.content.map((c: { text: string }) => c.text).join("\n"),
  };
}

function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${heading} (`));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).filter((l) => l !== "");
}

describe("kbGroup", () => {
  it("puts a page in the first bucket its tags or their ancestors name, else Other", () => {
    expect(kbGroup(entry("p", ["Project"], ["Project"], 0))).toBe("Project");
    expect(kbGroup(entry("o", ["Company"], ["Company", "Organization"], 0))).toBe("Organization");
    expect(kbGroup(entry("o", ["Organisation"], ["Organisation"], 0))).toBe("Organization");
    expect(kbGroup(entry("p", ["BusinessPerson"], ["BusinessPerson", "Person"], 0))).toBe("Person");
    expect(kbGroup(entry("a", ["Area"], ["Area"], 0))).toBe("Area");
    expect(kbGroup(entry("r", ["Resource"], ["Resource"], 0))).toBe("Resource");
    expect(kbGroup(entry("r", ["Book"], ["Book", "CreativeWork"], 0))).toBe("Resource");
    expect(kbGroup(entry("m", ["Business Meeting"], ["Business Meeting", "Event"], 0))).toBe("Other");
    expect(kbGroup(entry("u", [], [], 0))).toBe("Other");
    // Project wins over Organization, as the buckets are tried in order.
    expect(kbGroup(entry("x", ["Company", "Project"], ["Company", "Organization", "Project"], 0))).toBe("Project");
  });
});

describe("kb_index", () => {
  it("builds the index from every page of the sync server's knowledge index, grouped by class", async () => {
    const result = await callTool("kb_index", { graph: "work" });

    expect(result.isError).toBe(false);
    expect(syncRequests.map((u) => u.pathname)).toEqual([
      `/api/v1/graphs/${WORK_ID}/knowledge-index`,
      `/api/v1/graphs/${WORK_ID}/knowledge-index`,
      `/api/v1/graphs/${WORK_ID}/knowledge-index`,
    ]);
    for (const url of syncRequests) {
      expect(url.searchParams.get("exclude-tags")).toBe("private");
      expect(url.searchParams.get("limit")).toBe("200");
    }
    expect(syncRequests.map((u) => u.searchParams.get("cursor"))).toEqual([null, "3", "6"]);

    const text = result.text;
    expect(text.split("\n")[0]).toMatch(/^Knowledge index of graph 'work': 8 pages, built \S+Z \(just now\)\./);
    expect(text).toContain("refresh: true");
    expect(section(text, "Project")).toEqual([
      "## Project (2)",
      `- Roadmap [Project] — 12 refs, updated 2026-11-01 — Plan for [[Acme]]. (${PAGES[5].uuid})`,
      `- Side project [Project] — 1 ref, updated 2026-11-01 — ${"x".repeat(239)}… (${PAGES[6].uuid})`,
    ]);
    expect(section(text, "Organization")[1]).toContain("- Acme [Company] — 30 refs");
    expect(section(text, "Person")[1]).toContain("- Jane Doe [BusinessPerson]");
    expect(section(text, "Area")[1]).toContain("- Health [Area]");
    expect(section(text, "Resource")[1]).toContain("- Style guide [Article]");
    expect(section(text, "Other")).toEqual([
      "## Other (2)",
      `- Kickoff [Business Meeting] — 2 refs, updated 2026-11-01 — First meeting. (${PAGES[3].uuid})`,
      `- Loose note — 0 refs, updated 2026-11-01 (${PAGES[4].uuid})`,
    ]);
    // Buckets come in a fixed order.
    const headings = text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.split(" (")[0]);
    expect(headings).toEqual(["## Project", "## Organization", "## Person", "## Area", "## Resource", "## Other"]);
  });

  it("serves later calls from the KV cache until a page is created, renamed or deleted", async () => {
    await callTool("kb_index", { graph: "work" });
    syncRequests = [];

    const cached = await callTool("kb_index", { graph: "work" });
    expect(cached.isError).toBe(false);
    expect(syncRequests).toHaveLength(0);

    // The notes graph has its own cache.
    await callTool("kb_index", { graph: "notes" });
    expect(new Set(syncRequests.map((u) => u.pathname))).toEqual(new Set([`/api/v1/graphs/${NOTES_ID}/knowledge-index`]));

    syncRequests = [];
    syncHandler = (request) =>
      new URL(request.url).pathname.endsWith("/pages")
        ? Response.json({ uuid: "p1", kind: "page", title: "New page" }, { status: 201 })
        : serveIndex([...PAGES, entry("New page", [], [], 0)])(request);
    expect((await callTool("create_page", { graph: "work", body: { title: "New page" } })).isError).toBe(false);
    expect(syncRequests).toHaveLength(1);

    const rebuilt = await callTool("kb_index", { graph: "work" });
    expect(rebuilt.text).toContain("- New page — 0 refs");
    expect(rebuilt.text.split("\n")[0]).toContain("9 pages");
    expect(syncRequests).toHaveLength(4);

    // Other writes, such as editing a block, leave the cache to the hourly rebuild.
    syncRequests = [];
    syncHandler = () => Response.json({ uuid: "b1", kind: "block", title: "x" });
    await callTool("update_block", { graph: "work", "block-id": "b1", body: { title: "x" } });
    syncHandler = serveIndex();
    await callTool("kb_index", { graph: "work" });
    expect(syncRequests).toHaveLength(1);
  });

  it("rebuilds when asked, when the cache is older than two cron periods, or when it holds another graph", async () => {
    await callTool("kb_index", { graph: "work" });
    syncRequests = [];
    await callTool("kb_index", { graph: "work", refresh: true });
    expect(syncRequests).toHaveLength(3);

    const key = "kb-index:work";
    const record = JSON.parse((await env.KB_INDEX_KV.get(key)) ?? "null");
    await env.KB_INDEX_KV.put(key, JSON.stringify({ ...record, builtAt: Date.now() - KB_INDEX_MAX_AGE_MS - 1000 }));
    syncRequests = [];
    await callTool("kb_index", { graph: "work" });
    expect(syncRequests).toHaveLength(3);

    await env.KB_INDEX_KV.put(key, JSON.stringify({ ...record, graphId: NOTES_ID, builtAt: Date.now() }));
    syncRequests = [];
    const result = await callTool("kb_index", { graph: "work" });
    expect(syncRequests).toHaveLength(3);
    expect(syncRequests[0].pathname).toBe(`/api/v1/graphs/${WORK_ID}/knowledge-index`);
    expect(result.text).toContain("(just now)");
  });

  it("reports the cache's age", async () => {
    await callTool("kb_index", { graph: "work" });
    const key = "kb-index:work";
    const record = JSON.parse((await env.KB_INDEX_KV.get(key)) ?? "null");
    await env.KB_INDEX_KV.put(key, JSON.stringify({ ...record, builtAt: Date.now() - 42 * 60_000 }));
    const result = await callTool("kb_index", { graph: "work" });
    expect(result.text.split("\n")[0]).toMatch(/\(42 min ago\)/);
  });

  it("filters by tag or ancestor class and caps each group at limit", async () => {
    const tagged = await callTool("kb_index", { graph: "work", tag: "organization" });
    expect(tagged.text.split("\n")[0]).toContain("1 of 8 pages tagged 'organization'");
    expect(section(tagged.text, "Organization")).toHaveLength(2);
    expect(section(tagged.text, "Project")).toEqual([]);

    const limited = await callTool("kb_index", { graph: "work", limit: 1 });
    expect(section(limited.text, "Project")).toEqual([
      "## Project (2, showing 1)",
      `- Roadmap [Project] — 12 refs, updated 2026-11-01 — Plan for [[Acme]]. (${PAGES[5].uuid})`,
    ]);
    expect(limited.text).toContain("limit");
  });

  it("passes on sync server errors with the connector's messages", async () => {
    syncHandler = () => Response.json({ error: "graph insights are unavailable for E2EE graphs" }, { status: 409 });
    const result = await callTool("kb_index", { graph: "work" });
    expect(result).toEqual({
      isError: true,
      text: "graph insights are unavailable for E2EE graphs",
    });

    const unknown = await callTool("kb_index", { graph: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown graph 'nope'");
  });

  it("refuses an index that does not end within the page budget", async () => {
    syncHandler = () => Response.json({ pages: [], "next-cursor": "again" });
    const result = await callTool("kb_index", { graph: "work" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("more than");
  });
});

describe("cron", () => {
  it("rebuilds every graph's index, logs each, and fails after trying them all when one fails", async () => {
    syncHandler = (request) =>
      new URL(request.url).pathname.includes(NOTES_ID)
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : serveIndex()(request);
    const connector = createConnector({ githubFetch: () => Promise.reject(new Error("no GitHub in tests")) });
    const ctx = createExecutionContext();
    await expect(connector.scheduled!(createScheduledController(), testEnv(), ctx)).rejects.toThrow(
      "kb index refresh failed for 1 of 2 graphs",
    );
    await waitOnExecutionContext(ctx);

    const record = JSON.parse((await env.KB_INDEX_KV.get("kb-index:work")) ?? "null");
    expect(record.graphId).toBe(WORK_ID);
    expect(record.pages).toHaveLength(8);
    expect(await env.KB_INDEX_KV.get("kb-index:notes")).toBeNull();
    const lines = logged().map((l) => l.replace(/ms=\d+/, "ms=N")).sort();
    expect(lines).toEqual([
      "kb-index graph=notes status=http-401 ms=N",
      "kb-index graph=work status=ok pages=8 ms=N",
    ]);
  });

  it("skips E2EE graphs, which have no server-side index", async () => {
    syncHandler = (request) =>
      new URL(request.url).pathname.includes(NOTES_ID)
        ? Response.json({ error: "graph insights are unavailable for E2EE graphs" }, { status: 409 })
        : serveIndex()(request);
    const connector = createConnector({ githubFetch: () => Promise.reject(new Error("no GitHub in tests")) });
    const ctx = createExecutionContext();
    await connector.scheduled!(createScheduledController(), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(logged().map((l) => l.replace(/ms=\d+/, "ms=N")).sort()).toEqual([
      "kb-index graph=notes status=skipped-e2ee ms=N",
      "kb-index graph=work status=ok pages=8 ms=N",
    ]);
  });
});

describe("connector_help", () => {
  it("says to call kb_index first for broad topics", async () => {
    const result = await callTool("connector_help", {});
    expect(result.text).toContain("kb_index");
    expect(result.text).toMatch(/broad/);
  });
});

describe("tool list", () => {
  it("offers kb_index, get_page_backlinks and get_graph_health, and not the raw knowledge index", async () => {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const e = testEnv();
    const ctx = createExecutionContext();
    const res = await mcpHandler(e, ctx)(request, e, ctx);
    await waitOnExecutionContext(ctx);
    const text = await res.text();
    const message = text.includes("data: ")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6))
      : JSON.parse(text);
    const tools: { name: string; annotations: { readOnlyHint?: boolean } }[] = message.result.tools;
    const names = tools.map((t) => t.name);
    for (const name of ["kb_index", "get_page_backlinks", "get_graph_health"]) expect(names).toContain(name);
    expect(names).not.toContain("list_knowledge_index");
    expect(tools.find((t) => t.name === "kb_index")?.annotations.readOnlyHint).toBe(true);
  });
});
