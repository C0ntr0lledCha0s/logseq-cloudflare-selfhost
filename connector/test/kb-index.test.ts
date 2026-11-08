import { KB_INDEX_CRON } from "../src/crons";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { mcpHandler } from "../src/mcp";
import {
  KB_INDEX_MAX_AGE_MS,
  KB_INDEX_VERSION,
  type KbIndexEntry,
  type KbTitlesRecord,
  freshTitles,
  kbGroup,
  loadTitles,
} from "../src/tools/kb-index";
import type { GraphAccess } from "../src/tools/semantic";

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
  aliases?: string[],
): KbIndexEntry {
  return {
    uuid: `00000000-0000-0000-0000-${String(title.length).padStart(12, "0")}`,
    title,
    tags: tags.map((t) => ({ uuid: `tag-${t}`, title: t })),
    classes,
    "reference-count": refs,
    "updated-at": DAY,
    ...(summary === undefined ? {} : { summary }),
    // An entry built without aliases has no key at all, like an answer from a server before patch 0036.
    ...(aliases === undefined ? {} : { aliases }),
  };
}

const PAGES: KbIndexEntry[] = [
  entry("Acme", ["Company"], ["Company", "Organization"], 30, "A client.", ["ACME Ltd", "Acme Corp"]),
  entry("Health", ["Area"], ["Area"], 3, "Keeping fit.", []),
  entry("Jane Doe", ["BusinessPerson"], ["BusinessPerson", "Person"], 8, "Account lead at Acme.", ["JD"]),
  entry("Kickoff", ["Business Meeting"], ["Business Meeting", "Event"], 2, "First meeting.", []),
  entry("Loose note", [], [], 0),
  entry("Roadmap", ["Project"], ["Project"], 12, "Plan for [[Acme]].", []),
  entry("Side project", ["Project"], ["Project"], 1, "x".repeat(400), []),
  entry("Style guide", ["Article"], ["Article", "CreativeWork"], 1, "How we write.", []),
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

  it("renders the same text as before the cache carried aliases", async () => {
    // Pasted from what the tool rendered for this fixture before version 2 (stage 3 of the
    // suggest-links plan): aliases are cached for suggest_links but never shown by kb_index.
    const result = await callTool("kb_index", { graph: "work" });
    expect(result.text.replace(/built \S+Z/, "built <T>")).toBe(
      [
        "Knowledge index of graph 'work': 8 pages, built <T> (just now). It is rebuilt hourly and when pages are created, renamed or deleted through this connector; pass refresh: true to rebuild it now. Journals, built-in pages and pages tagged private are left out. Read a page with get_page_outline using the UUID in parentheses.",
        "",
        "## Project (2)",
        `- Roadmap [Project] — 12 refs, updated 2026-11-01 — Plan for [[Acme]]. (${PAGES[5].uuid})`,
        `- Side project [Project] — 1 ref, updated 2026-11-01 — ${"x".repeat(239)}… (${PAGES[6].uuid})`,
        "",
        "## Organization (1)",
        `- Acme [Company] — 30 refs, updated 2026-11-01 — A client. (${PAGES[0].uuid})`,
        "",
        "## Person (1)",
        `- Jane Doe [BusinessPerson] — 8 refs, updated 2026-11-01 — Account lead at Acme. (${PAGES[2].uuid})`,
        "",
        "## Area (1)",
        `- Health [Area] — 3 refs, updated 2026-11-01 — Keeping fit. (${PAGES[1].uuid})`,
        "",
        "## Resource (1)",
        `- Style guide [Article] — 1 ref, updated 2026-11-01 — How we write. (${PAGES[7].uuid})`,
        "",
        "## Other (2)",
        `- Kickoff [Business Meeting] — 2 refs, updated 2026-11-01 — First meeting. (${PAGES[3].uuid})`,
        `- Loose note — 0 refs, updated 2026-11-01 (${PAGES[4].uuid})`,
      ].join("\n"),
    );
    // The cached render is the same text.
    const cached = await callTool("kb_index", { graph: "work" });
    expect(cached.text.replace(/built \S+Z \([^)]*\)/, "")).toBe(result.text.replace(/built \S+Z \([^)]*\)/, ""));
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

  it("marks the cache dirty when promote_page_to_tag succeeds, and passes its refusals through without marking it", async () => {
    // The mark is written in a waitUntil the tool registers while its response streams, after
    // callTool's waitOnExecutionContext, so a success is awaited with waitFor. A refusal never
    // registers one: runTool throws before onSuccess.
    const dirty = async () => (await env.KB_INDEX_KV.list({ prefix: "kb-index-dirty:" })).keys.map((k) => k.name);
    const promote = () => callTool("promote_page_to_tag", { graph: "work", "page-id": "p1" });
    for (const [status, error] of [
      [400, 'page-id: "Journal Day" (p1) is a journal; journals can\'t become tags'],
      [409, 'page-id: "Recipe" is already a tag (p1); use update_tag to change it'],
    ] as const) {
      syncHandler = () => Response.json({ error }, { status });
      expect(await promote()).toEqual({ isError: true, text: error });
      expect(await dirty()).toEqual([]);
    }

    syncRequests = [];
    syncHandler = () =>
      Response.json({
        uuid: "p1",
        ident: "user.class/Recipe-abcdefgh",
        title: "Recipe",
        extends: [{ uuid: "root", title: "Root Tag" }],
        properties: [],
        promoted: { blocks: 3, references: 2 },
      });
    const promoted = await promote();
    expect(promoted.isError).toBe(false);
    // The summary item, ending with the audit entry line, comes before the server's JSON.
    expect(JSON.parse(promoted.text.replace(/^[\s\S]*?Logged as audit entry \d+\n/, "")).promoted).toEqual({ blocks: 3, references: 2 });
    // The page is read first, as promote_page_to_tag's audit before-snapshot (getPage), then promoted.
    expect(syncRequests.map((u) => u.pathname)).toEqual([`/api/v1/graphs/${WORK_ID}/pages/p1`, `/api/v1/graphs/${WORK_ID}/pages/p1/promote-to-tag`]);
    await vi.waitFor(async () => expect(await dirty()).toEqual(["kb-index-dirty:work"]));
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

function access(e: Env = testEnv()): GraphAccess {
  return { env: e, resolve: (alias) => store().resolve(alias) };
}

async function kvJson<T>(key: string): Promise<T | null> {
  return JSON.parse((await env.KB_INDEX_KV.get(key)) ?? "null") as T | null;
}

/** The titles key PAGES give: uuid, title and aliases per page, `[]` where the server sent none. */
const TITLES = PAGES.map((p) => [p.uuid, p.title, p.aliases ?? []]);

describe("titles key", () => {
  it("a rebuild writes the record and the titles key, both version 2 with the same builtAt", async () => {
    await callTool("kb_index", { graph: "work" });
    const record = await kvJson<{ graphId: string; builtAt: number; version: number }>("kb-index:work");
    const titles = await kvJson<KbTitlesRecord>("kb-index-titles:work");
    expect(record?.version).toBe(KB_INDEX_VERSION);
    expect(KB_INDEX_VERSION).toBe(2);
    expect(titles).toEqual({ graphId: WORK_ID, builtAt: record?.builtAt, version: 2, pages: TITLES });
    // "Loose note" came without an aliases key (a server before patch 0036): the titles key says [].
    expect(titles?.pages[4]).toEqual([PAGES[4].uuid, "Loose note", []]);
    // A rebuild on refresh rewrites both, again with one builtAt.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await callTool("kb_index", { graph: "work", refresh: true });
    const record2 = await kvJson<{ builtAt: number }>("kb-index:work");
    const titles2 = await kvJson<KbTitlesRecord>("kb-index-titles:work");
    expect(record2!.builtAt).toBeGreaterThan(record!.builtAt);
    expect(titles2?.builtAt).toBe(record2?.builtAt);
  });

  it("a record cached before version 2 rebuilds on first use", async () => {
    await callTool("kb_index", { graph: "work" });
    const key = "kb-index:work";
    const { version: _version, ...record } = (await kvJson<Record<string, unknown>>(key))!;
    for (const old of [record, { ...record, version: 1 }]) {
      await env.KB_INDEX_KV.put(key, JSON.stringify({ ...old, builtAt: Date.now() }));
      syncRequests = [];
      await callTool("kb_index", { graph: "work" });
      expect(syncRequests).toHaveLength(3);
      expect((await kvJson<{ version: number }>(key))?.version).toBe(2);
    }
    // A version-2 record is served from the cache.
    syncRequests = [];
    await callTool("kb_index", { graph: "work" });
    expect(syncRequests).toHaveLength(0);
  });

  describe("freshTitles", () => {
    const key = "kb-index-titles:work";
    const now = Date.UTC(2026, 10, 8, 12);
    const stored = (over: Record<string, unknown> = {}) =>
      env.KB_INDEX_KV.put(key, JSON.stringify({ graphId: WORK_ID, builtAt: now - 1000, version: 2, pages: TITLES, ...over }));

    it("serves a clean, young key for the same graph with no sync call", async () => {
      await stored();
      // A dirty mark from before the build does not make it stale; nor does an age of exactly the maximum.
      await env.KB_INDEX_KV.put("kb-index-dirty:work", String(now - 1001));
      expect((await freshTitles(access(), "work", now))?.pages).toEqual(TITLES);
      expect(await freshTitles(access(), "work", now - 1000 + KB_INDEX_MAX_AGE_MS)).not.toBeNull();
      expect(syncRequests).toHaveLength(0);
    });

    it("returns null for a key that is missing", async () => {
      expect(await freshTitles(access(), "work", now)).toBeNull();
    });

    it("returns null for a key built for another graph", async () => {
      await stored({ graphId: NOTES_ID });
      expect(await freshTitles(access(), "work", now)).toBeNull();
    });

    it("returns null for a key without version 2", async () => {
      await stored({ version: undefined });
      expect(await freshTitles(access(), "work", now)).toBeNull();
      await stored({ version: 1 });
      expect(await freshTitles(access(), "work", now)).toBeNull();
    });

    it("returns null for a key older than the maximum age", async () => {
      await stored();
      expect(await freshTitles(access(), "work", now - 1000 + KB_INDEX_MAX_AGE_MS + 1)).toBeNull();
    });

    it("returns null for a key marked dirty at or after its builtAt", async () => {
      await stored();
      for (const at of [now - 1000, now - 500]) {
        await env.KB_INDEX_KV.put("kb-index-dirty:work", String(at));
        expect(await freshTitles(access(), "work", now)).toBeNull();
      }
    });
  });

  describe("loadTitles", () => {
    it("serves a fresh titles key without a rebuild", async () => {
      await callTool("kb_index", { graph: "work" });
      syncRequests = [];
      const titles = await loadTitles(access(), "work", Date.now());
      expect(titles.pages).toEqual(TITLES);
      expect(syncRequests).toHaveLength(0);
    });

    it("rebuilds and rewrites both keys when the titles key is missing beside a fresh record", async () => {
      await callTool("kb_index", { graph: "work" });
      await env.KB_INDEX_KV.delete("kb-index-titles:work");
      syncRequests = [];
      const titles = await loadTitles(access(), "work", Date.now());
      expect(syncRequests).toHaveLength(3);
      expect(titles.pages).toEqual(TITLES);
      const record = await kvJson<{ builtAt: number }>("kb-index:work");
      expect(await kvJson<KbTitlesRecord>("kb-index-titles:work")).toEqual(titles);
      expect(titles.builtAt).toBe(record?.builtAt);
    });

    it("rebuilds when the titles key is older than the record and stale by the shared rule", async () => {
      await callTool("kb_index", { graph: "work" });
      const record = (await kvJson<{ builtAt: number }>("kb-index:work"))!;
      const titlesKey = "kb-index-titles:work";
      const titles = (await kvJson<KbTitlesRecord>(titlesKey))!;
      // A page changed after the titles were built and before the record was (a titles write that
      // failed): the record is clean, the titles key is dirty.
      for (const older of [
        { builtAt: record.builtAt - 2000, dirtyAt: record.builtAt - 1000 },
        // Or the titles key is past the maximum age while the record is young.
        { builtAt: record.builtAt - KB_INDEX_MAX_AGE_MS - 60_000, dirtyAt: null },
      ]) {
        await env.KB_INDEX_KV.put(titlesKey, JSON.stringify({ ...titles, builtAt: older.builtAt, pages: [] }));
        if (older.dirtyAt === null) await env.KB_INDEX_KV.delete("kb-index-dirty:work");
        else await env.KB_INDEX_KV.put("kb-index-dirty:work", String(older.dirtyAt));
        syncRequests = [];
        const loaded = await loadTitles(access(), "work", Date.now());
        expect(syncRequests).toHaveLength(3);
        expect(loaded.pages).toEqual(TITLES);
        const rebuilt = (await kvJson<{ builtAt: number }>("kb-index:work"))!;
        expect((await kvJson<KbTitlesRecord>(titlesKey))?.builtAt).toBe(rebuilt.builtAt);
        expect(rebuilt.builtAt).toBe(loaded.builtAt);
      }
    });

    it("rebuilds when the titles key holds another graph", async () => {
      await callTool("kb_index", { graph: "work" });
      const titlesKey = "kb-index-titles:work";
      await env.KB_INDEX_KV.put(titlesKey, JSON.stringify({ ...(await kvJson<KbTitlesRecord>(titlesKey)), graphId: NOTES_ID }));
      syncRequests = [];
      const loaded = await loadTitles(access(), "work", Date.now());
      expect(syncRequests).toHaveLength(3);
      expect(loaded.graphId).toBe(WORK_ID);
    });
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
    await expect(connector.scheduled!(createScheduledController({ cron: KB_INDEX_CRON }), testEnv(), ctx)).rejects.toThrow(
      "kb index refresh failed for 1 of 2 graphs",
    );
    await waitOnExecutionContext(ctx);

    const record = JSON.parse((await env.KB_INDEX_KV.get("kb-index:work")) ?? "null");
    expect(record.graphId).toBe(WORK_ID);
    expect(record.pages).toHaveLength(8);
    expect(await env.KB_INDEX_KV.get("kb-index:notes")).toBeNull();
    // The cron writes the titles key beside the record, with the same builtAt.
    const titles = JSON.parse((await env.KB_INDEX_KV.get("kb-index-titles:work")) ?? "null");
    expect(titles).toEqual({ graphId: WORK_ID, builtAt: record.builtAt, version: 2, pages: TITLES });
    expect(await env.KB_INDEX_KV.get("kb-index-titles:notes")).toBeNull();
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
    await connector.scheduled!(createScheduledController({ cron: KB_INDEX_CRON }), testEnv(), ctx);
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

describe("scheduled", () => {
  it("refuses a cron it doesn't know", async () => {
    const connector = createConnector({ githubFetch: () => Promise.reject(new Error("no GitHub in tests")) });
    await expect(
      connector.scheduled!(createScheduledController({ cron: "*/5 * * * *" }), testEnv(), createExecutionContext()),
    ).rejects.toThrow('unexpected cron "*/5 * * * *"');
  });
});
