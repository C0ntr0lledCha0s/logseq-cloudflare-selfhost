import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import { AuditLog } from "../src/audit/log";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_PLAN, snapshotClassFor } from "../src/audit/snapshot";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import outline from "./fixtures/audit/get-blocks-outline.json";
import outlineTruncated from "./fixtures/audit/get-blocks-outline-truncated.json";
import summary from "./fixtures/audit/get-blocks-summary.json";
import summaryE2ee from "./fixtures/audit/get-blocks-summary-e2ee.json";
import e2ee409 from "./fixtures/audit/e2ee-outline-409.json";
import pageOutline from "./fixtures/audit/get-page-outline.json";
import pageOutlineTruncated from "./fixtures/audit/get-page-outline-truncated.json";
import page from "./fixtures/audit/get-page.json";
import tag from "./fixtures/audit/get-tag.json";
import property from "./fixtures/audit/get-property.json";
import refreshRefs from "./fixtures/audit/refresh-refs.json";

// Before-snapshots (design 2026-11-07-connector-write-audit-log §3.4; plan stage 3). The real
// generated tools, real D1 and the real audited() path; only the sync server is faked, at HTTP level.
//
// The getBlocks view=outline fixtures carry `markdown`, `block-count` and `truncated` per entry, the
// keys upstream's semantic_bulk_test.cljs (get-blocks-reads-many-entities-in-one-call-test) asserts on
// that view, which CI's upstream suite runs on every push. `truncated: true` is read from page-outline
// (semantic.cljs), which sets it once the shared 2,000-block budget runs out with children left.

const WORK_TOKEN = "logseq_pat_WorkToken123";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const GRAPH = `/api/v1/graphs/${WORK_ID}`;
const B1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B3 = "aaaaaaaa-0000-4000-8000-000000000003";
const J5 = "00000001-2026-1105-0000-000000000000";
const TAG = "cccccccc-0000-4000-8000-000000000001";
const PROP = "bbbbbbbb-0000-4000-8000-000000000001";
/** listFavorites' answer (patch 0038): the visible favourites in sidebar order. */
const favorites = {
  favorites: [
    { uuid: J5, title: "Nov 5th, 2026", kind: "journal" },
    { uuid: TAG, title: "Meeting", kind: "tag" },
  ],
};

interface SyncCall {
  method: string;
  path: string;
  ids: string | null;
  view: string | null;
  body: string;
}

let syncCalls: SyncCall[];
let syncHandler: (request: Request, url: URL) => Response | Promise<Response>;
let consoleSpies: MockInstance[];

function testEnv(): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      syncCalls.push({
        method: request.method,
        path: url.pathname,
        ids: url.searchParams.get("ids"),
        view: url.searchParams.get("view"),
        body: await request.clone().text(),
      });
      return syncHandler(request, url);
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync } as Env;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await env.DB.exec("DELETE FROM audit_log");
  await new GraphStore(env.DB, env.GRAPH_TOKEN_KEY).add({
    alias: "work",
    graphId: WORK_ID,
    graphName: "My Work Graph",
    mode: "write",
    permission: "both",
    expiresAt: null,
    token: WORK_TOKEN,
  });
  syncCalls = [];
  syncHandler = () => Response.json({ error: "unexpected sync call" }, { status: 500 });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

/** tools/call through mcpHandler, as the connector serves it. */
async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const e = testEnv();
  const request = new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { graph: "work", ...args } } }),
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
  expect(json.error, name).toBeUndefined();
  return { isError: json.result.isError === true, text: json.result.content.map((c: { text: string }) => c.text).join("\n") };
}

interface Row {
  id: number;
  status: string;
  error: string | null;
  dry_run: number;
  before: string | null;
  pages: string | null;
  targets: string | null;
}

/** Calls once and answers the result and the one audit row it left. */
async function audited(name: string, args: Record<string, unknown>): Promise<{ result: { isError: boolean; text: string }; row: Row }> {
  const last = (await env.DB.prepare("SELECT max(id) AS id FROM audit_log").first<{ id: number | null }>())?.id ?? 0;
  const result = await call(name, args);
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE id > ? ORDER BY id").bind(last).all<Row>();
  expect(results, `${name}: rows for one call`).toHaveLength(1);
  return { result, row: results[0] };
}

function before(row: Row): any {
  return row.before === null ? null : JSON.parse(row.before);
}

function writes(): SyncCall[] {
  return syncCalls.filter((c) => c.method !== "GET");
}

function gets(): SyncCall[] {
  return syncCalls.filter((c) => c.method === "GET");
}

/** A fake sync server: `get` answers GETs by path, every other request answers `write`. */
function serve(get: (path: string, url: URL) => Response, write: () => Response = () => Response.json({ ok: true })): void {
  syncHandler = (request, url) => (request.method === "GET" ? get(url.pathname.slice(GRAPH.length), url) : write());
}

/** One answer for each pre-read path, for tools that read before they write. */
function fixtures(path: string, url: URL): Response {
  if (path === "/blocks") return Response.json(url.searchParams.get("view") === "outline" ? outline : summary);
  if (path.endsWith("/outline")) return Response.json(pageOutline);
  if (path.startsWith("/pages/")) return Response.json(page);
  if (path.startsWith("/tags/")) return Response.json(tag);
  if (path.startsWith("/properties/")) return Response.json(property);
  if (path === "/favorites") return Response.json(favorites);
  return Response.json({ error: `no fixture for ${path}` }, { status: 404 });
}

const ALL_WRITES = committedManifest.filter((e) => !e.annotations.readOnlyHint).map((e) => e.name);

/** Spec §3.4's table: each tool with a pre-read, one call, and the GET it must make first. */
const PRE_READS: Record<string, { args: Record<string, unknown>; path: string; ids?: string; view?: string; source: string }> = {
  update_block: { args: { "block-id": B1, body: { title: "New title" } }, path: "/blocks", ids: B1, view: "summary", source: "getBlocks" },
  set_block_property: { args: { "block-id": B1, "property-id": "Venue", body: { value: "Library" } }, path: "/blocks", ids: B1, view: "summary", source: "getBlocks" },
  delete_block_property: { args: { "block-id": B1, "property-id": "Venue" }, path: "/blocks", ids: B1, view: "summary", source: "getBlocks" },
  batch_set_block_property: {
    args: { body: { entries: [{ "block-id": B1, "property-id": "Venue", value: 1 }, { "block-id": B2, "property-id": "Venue", value: 2 }] } },
    path: "/blocks",
    ids: `${B1},${B2}`,
    view: "summary",
    source: "getBlocks",
  },
  batch_delete_block_property: {
    args: { body: { entries: [{ "block-id": B2, "property-id": "Venue" }, { "block-id": B1, "property-id": "Venue" }] } },
    path: "/blocks",
    ids: `${B2},${B1}`,
    view: "summary",
    source: "getBlocks",
  },
  move_blocks: { args: { body: { "block-ids": [B1, B2], "target-id": J5, position: "first-child" } }, path: "/blocks", ids: `${B1},${B2}`, view: "summary", source: "getBlocks" },
  batch_move_blocks: {
    args: { body: { moves: [{ "block-ids": [B2], "target-id": J5, position: "last-child" }, { "block-ids": [B1], "target-id": B2, position: "after" }] } },
    path: "/blocks",
    ids: `${B2},${B1}`,
    view: "summary",
    source: "getBlocks",
  },
  batch_insert_block_trees: {
    args: {
      body: {
        entries: [
          { page: "Meeting", blocks: [{ title: "Agenda" }] },
          { "target-id": B2, blocks: [{ title: "Child" }] },
          { "target-id": B1, properties: { Venue: "Library" } },
        ],
      },
    },
    path: "/blocks",
    ids: B1,
    view: "summary",
    source: "getBlocks",
  },
  delete_block: { args: { "block-id": B1 }, path: "/blocks", ids: B1, view: "outline", source: "getBlocks" },
  delete_blocks: { args: { body: { "block-ids": [B1, B2] } }, path: "/blocks", ids: `${B1},${B2}`, view: "outline", source: "getBlocks" },
  delete_page: { args: { "page-id": J5 }, path: `/pages/${J5}/outline`, source: "getPageOutline" },
  update_page: { args: { "page-id": J5, body: { title: "Notes" } }, path: `/pages/${J5}`, source: "getPage" },
  promote_page_to_tag: { args: { "page-id": J5 }, path: `/pages/${J5}`, source: "getPage" },
  update_tag: { args: { "tag-id": TAG, body: { title: "Meetings" } }, path: `/tags/${TAG}`, source: "getTag" },
  delete_tag: { args: { "tag-id": TAG }, path: `/tags/${TAG}`, source: "getTag" },
  update_property: { args: { "property-id": PROP, body: { title: "Place" } }, path: `/properties/${PROP}`, source: "getProperty" },
  delete_property: { args: { "property-id": PROP }, path: `/properties/${PROP}`, source: "getProperty" },
  // A remove's before-snapshot is the whole list, read as the write finds the page (by its fixed uuid).
  set_page_favorite: { args: { "page-id": J5, body: { favorite: false } }, path: "/favorites", source: "getFavorites" },
  // A reorder's before-snapshot is the whole list in its old order.
  reorder_favorites: { args: { body: { "page-ids": [TAG, J5] } }, path: "/favorites", source: "getFavorites" },
};

/** Writes that overwrite nothing, so read nothing first. */
const NO_PRE_READ: Record<string, Record<string, unknown>> = {
  insert_block_children: { "block-id": B1, body: { position: "append", blocks: [{ title: "Child" }] } },
  insert_block_tree: { body: { "target-id": B1, blocks: [{ title: "Child" }] } },
  capture_to_today: { body: { blocks: [{ title: "Note" }] } },
  create_task: { body: { title: "Call Sam" } },
  create_page: { body: { title: "Standup" } },
  create_tag: { body: { title: "Meeting" } },
  create_property: { body: { title: "Venue" } },
  refresh_refs: { body: { "page-id": J5, apply: true } },
  // Entries with blocks only, on a block or a page, overwrite nothing.
  batch_insert_block_trees: { body: { entries: [{ page: "Meeting", blocks: [{ title: "Agenda" }] }, { "target-id": B1, blocks: [{ title: "Child" }] }] } },
};

/** Each tool that has a dry run, and where it takes the flag. */
const DRY_RUNS: Record<string, "query" | "body"> = {
  delete_page: "query",
  promote_page_to_tag: "query",
  move_blocks: "query",
  delete_tag: "query",
  update_property: "query",
  delete_property: "query",
  delete_blocks: "body",
  batch_move_blocks: "body",
  batch_insert_block_trees: "body",
  set_page_favorite: "body",
  reorder_favorites: "body",
};

describe("snapshot plan", () => {
  it("every write has a snapshot plan; an unknown name throws", () => {
    expect(Object.keys(SNAPSHOT_PLAN).sort()).toEqual([...ALL_WRITES].sort());
    for (const name of ALL_WRITES) expect(() => snapshotClassFor(name), name).not.toThrow();
    expect(() => snapshotClassFor("delete_everything")).toThrow("no snapshot plan for tool delete_everything");
    // The table in §3.4, by source.
    const sources = Object.fromEntries(ALL_WRITES.map((name) => [name, (snapshotClassFor(name) as { source: string }).source]));
    expect(sources).toEqual({
      ...Object.fromEntries(Object.entries(PRE_READS).map(([name, p]) => [name, p.source])),
      insert_block_children: "none",
      insert_block_tree: "none",
      capture_to_today: "none",
      create_task: "none",
      create_page: "none",
      create_tag: "none",
      create_property: "none",
      save_document: "none",
      save_file_from_url: "none",
      refresh_refs: "refresh_refs",
    });
  });
});

describe("pre-reads", () => {
  it("each tool in §3.4's table reads its snapshot with one GET before the write, and stores it", async () => {
    for (const [name, p] of Object.entries(PRE_READS)) {
      syncCalls = [];
      serve(fixtures);
      const { result, row } = await audited(name, p.args);
      expect(result.isError, `${name}: ${result.text}`).toBe(false);
      expect(row.status, name).toBe("ok");
      // At most one extra request per write, and it comes first.
      expect(syncCalls.map((c) => c.method), name).toEqual(["GET", expect.not.stringMatching(/^GET$/)]);
      expect({ path: syncCalls[0].path, ids: syncCalls[0].ids, view: syncCalls[0].view }, name).toEqual({
        path: GRAPH + p.path,
        ids: p.ids ?? null,
        view: p.view ?? null,
      });
      const snap = before(row);
      expect(snap.source, name).toBe(p.source);
      expect(snap.error, name).toBeUndefined();
      expect(snap.truncated, name).toBeUndefined();
      expect(snap.e2ee, name).toBeUndefined();
      expect(snap.data, name).toEqual(
        p.source === "getBlocks"
          ? p.view === "outline"
            ? outline
            : summary
          : { getPageOutline: pageOutline, getPage: page, getTag: tag, getProperty: property, getFavorites: favorites }[p.source],
      );
    }
  });

  it("property, move and update_property snapshots keep title, properties, parent-id, order and the schema", async () => {
    serve(fixtures);
    const set = before((await audited("set_block_property", PRE_READS.set_block_property.args)).row);
    expect(set.data.blocks[0]).toMatchObject({ uuid: B1, title: "Agenda", "parent-id": J5, order: "a0", properties: [{ title: "Venue", value: "Town Hall" }] });
    const moved = before((await audited("batch_move_blocks", PRE_READS.batch_move_blocks.args)).row);
    expect(moved.data.blocks.map((b: any) => [b.uuid, b["parent-id"], b.order])).toEqual([
      [B1, J5, "a0"],
      [B2, B1, "a1"],
    ]);
    const schema = before((await audited("update_property", PRE_READS.update_property.args)).row);
    expect(schema.data).toMatchObject({ title: "Venue", type: "default", cardinality: "one", choices: [{ title: "Town Hall" }, { title: "Library" }], classes: [{ title: "Meeting" }] });
  });

  it("batch moves read each moved block once, in call order, for chains, swaps and reversed entries", async () => {
    const move = (pairs: [string, string][]) => ({ body: { moves: pairs.map(([b, t]) => ({ "block-ids": [b], "target-id": t, position: "after" })) } });
    const cases: [Record<string, unknown>, string][] = [
      [move([[B1, B2], [B2, B3]]), `${B1},${B2}`],
      [move([[B2, B3], [B1, B2]]), `${B2},${B1}`],
      [move([[B1, B2], [B2, B1]]), `${B1},${B2}`],
      // The same block named twice, once upper-cased: getBlocks refuses a duplicate id, so it is read once.
      [{ body: { moves: [{ "block-ids": [B1, B3], "target-id": J5, position: "first-child" }, { "block-ids": [B1.toUpperCase()], "target-id": B3, position: "after" }] } }, `${B1},${B3}`],
    ];
    for (const [args, ids] of cases) {
      syncCalls = [];
      serve(fixtures);
      const { row } = await audited("batch_move_blocks", args);
      expect(row.status).toBe("ok");
      expect(gets().map((c) => c.ids)).toEqual([ids]);
    }
  });

  it("selectors: only UUIDs go to getBlocks; titles, dates, idents and '..' are left to the write", async () => {
    // A title, a journal date and '..' can't name a block for getBlocks (which takes UUIDs only), and
    // the write itself refuses what doesn't exist.
    serve(fixtures);
    syncCalls = [];
    await audited("batch_set_block_property", {
      body: { entries: [{ "block-id": "Meeting", "property-id": "Venue", value: 1 }, { "block-id": "2026-11-05", "property-id": "Venue", value: 1 }, { "block-id": B2, "property-id": "Venue", value: 1 }] },
    });
    expect(gets().map((c) => c.ids)).toEqual([B2]);
    // Nothing that could be a block: no pre-read at all.
    syncCalls = [];
    const { row } = await audited("update_block", { "block-id": "Meeting", body: { title: "x" } });
    expect(gets()).toEqual([]);
    expect(row.before).toBeNull();
    // '..' is refused by the handler, before any request, as it was before snapshots.
    syncCalls = [];
    const dots = await audited("delete_block", { "block-id": ".." });
    expect(dots.row).toMatchObject({ status: "refused", error: "path arguments may not be '.' or '..'" });
    expect(syncCalls).toEqual([]);
    for (const [name, key] of [["delete_page", "page-id"], ["update_tag", "tag-id"], ["delete_property", "property-id"]] as const) {
      syncCalls = [];
      const refused = await audited(name, { [key]: "..", ...(name === "update_tag" ? { body: {} } : {}) });
      expect(refused.row.status, name).toBe("refused");
      expect(syncCalls, name).toEqual([]);
    }
    // Page, tag and property selectors go to the read as given, encoded once: a title with '/', a
    // journal date and a qualified ident.
    const paths: [string, Record<string, unknown>, string][] = [
      ["delete_page", { "page-id": "Projects/Logseq" }, "/pages/Projects%2FLogseq/outline"],
      ["update_page", { "page-id": "2026-11-05", body: { title: "x" } }, "/pages/2026-11-05"],
      ["delete_property", { "property-id": "user.property/venue-x1" }, "/properties/user.property%2Fvenue-x1"],
      ["update_tag", { "tag-id": "Meeting", body: {} }, "/tags/Meeting"],
    ];
    for (const [name, args, path] of paths) {
      syncCalls = [];
      await audited(name, args);
      expect(new URL(`https://x${syncCalls[0].path}`).pathname, name).toBe(new URL(`https://x${GRAPH}${path}`).pathname);
      expect(syncCalls.map((c) => c.method)[0], name).toBe("GET");
    }
  });

  it("over 100 blocks: the first 100 are read, and the snapshot says it is truncated", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    serve(fixtures);
    const moves = [many.slice(0, 51), many.slice(51)].map((ids) => ({ "block-ids": ids, "target-id": J5, position: "last-child" }));
    const { row } = await audited("batch_move_blocks", { body: { moves } });
    expect(row.status).toBe("ok");
    expect(gets()).toHaveLength(1);
    expect(gets()[0].ids).toBe(many.slice(0, 100).join(","));
    expect(before(row)).toMatchObject({ source: "getBlocks", truncated: true });
  });

  it("a non-delete snapshot over the cap is cut down to the blocks' summaries, marked truncated", async () => {
    const big = structuredClone(summary);
    big.blocks[0].properties[0].value = "x".repeat(SNAPSHOT_MAX_BYTES);
    serve(() => Response.json(big));
    const { row } = await audited("update_block", PRE_READS.update_block.args);
    expect(row.status).toBe("ok");
    const snap = before(row);
    expect(snap).toMatchObject({ source: "getBlocks", truncated: true });
    expect(snap.data.blocks).toEqual([
      { uuid: B1, kind: "block", title: "Agenda", order: "a0", "parent-id": J5, "page-id": J5 },
      { uuid: B2, kind: "block", title: "Actions", order: "a1", "parent-id": B1, "page-id": J5 },
    ]);
    expect(row.before!.length).toBeLessThan(SNAPSHOT_MAX_BYTES);
    // A page, tag or property read over the cap keeps its identity and title.
    serve(() => Response.json({ ...page, properties: [{ ident: "user.property/notes", title: "Notes", value: "x".repeat(SNAPSHOT_MAX_BYTES) }] }));
    const pageRow = (await audited("update_page", PRE_READS.update_page.args)).row;
    expect(before(pageRow)).toEqual({ source: "getPage", truncated: true, data: { uuid: J5, kind: "page", title: "Notes" } });
  });

  it("a cut-down snapshot still over the cap keeps only its source, with data null", async () => {
    // One title over the cap, and two titles that are over it together: pick() keeps titles.
    const one = structuredClone(summary);
    one.blocks[0].title = "x".repeat(SNAPSHOT_MAX_BYTES);
    const two = structuredClone(summary);
    two.blocks[0].title = "x".repeat(SNAPSHOT_MAX_BYTES / 2);
    two.blocks[1].title = "y".repeat(SNAPSHOT_MAX_BYTES / 2);
    for (const response of [one, two]) {
      serve(() => Response.json(response));
      const { row } = await audited("update_block", PRE_READS.update_block.args);
      expect(row.status).toBe("ok");
      expect(before(row)).toEqual({ source: "getBlocks", truncated: true, data: null });
      expect(new TextEncoder().encode(row.before!).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    }
    // A page whose title alone is over the cap.
    serve(() => Response.json({ ...page, title: "p".repeat(SNAPSHOT_MAX_BYTES) }));
    const pageRow = (await audited("update_page", PRE_READS.update_page.args)).row;
    expect(before(pageRow)).toEqual({ source: "getPage", truncated: true, data: null });
  });

  it("batch_insert_block_trees reads each page an entry sets properties on by title, date or page, once each", async () => {
    // target-id takes a block UUID or a page selector; page takes a title or a date (and creates a
    // missing page). Each entry with properties overwrites the values it sets on what it names.
    const args = {
      body: {
        entries: [
          { "target-id": "Meeting", properties: { Status: "Done" } },
          { page: "2026-11-05", properties: { Venue: "Library" } },
          { "target-id": B1, properties: { Venue: "Library" } },
          // The same page again, in another case: read once.
          { page: "meeting", properties: { Venue: "Library" } },
          // Blocks only, and a page that doesn't exist yet: nothing overwritten, or nothing to read.
          { page: "Agenda", blocks: [{ title: "Item" }] },
          { page: "Brand new", properties: { Venue: "Library" } },
          // A page UUID as target-id goes to getBlocks with the block UUIDs.
          { "target-id": J5, properties: { Venue: "Library" } },
        ],
      },
    };
    serve((path, url) => (path === "/pages/Brand%20new" ? Response.json({ error: "page not found: Brand new" }, { status: 404 }) : fixtures(path, url)));
    const { result, row } = await audited("batch_insert_block_trees", args);
    expect(result.isError, result.text).toBe(false);
    expect(row.status).toBe("ok");
    expect(gets().map((c) => [c.path.slice(GRAPH.length), c.ids])).toEqual([
      ["/blocks", `${B1},${J5}`],
      ["/pages/Meeting", null],
      ["/pages/2026-11-05", null],
      ["/pages/Brand%20new", null],
    ]);
    expect(writes()).toHaveLength(1);
    expect(before(row)).toEqual({
      source: "getBlocks",
      data: summary,
      pages: [
        { page: "Meeting", source: "getPage", data: page },
        { page: "2026-11-05", source: "getPage", data: page },
        { page: "Brand new", source: "getPage", error: "sync server error (HTTP 404): page not found: Brand new" },
      ],
    });

    // Page selectors only: no getBlocks read.
    syncCalls = [];
    serve(fixtures);
    const pagesOnly = await audited("batch_insert_block_trees", { body: { entries: [{ page: "2026-11-05", properties: { Venue: "Library" } }] } });
    expect(gets().map((c) => c.path.slice(GRAPH.length))).toEqual(["/pages/2026-11-05"]);
    expect(before(pagesOnly.row)).toEqual({ source: "getBlocks", data: null, pages: [{ page: "2026-11-05", source: "getPage", data: page }] });

    // A dry run reads nothing.
    syncCalls = [];
    const dry = await audited("batch_insert_block_trees", { body: { ...args.body, "dry-run": true } });
    expect(gets()).toEqual([]);
    expect(dry.row).toMatchObject({ dry_run: 1, before: null });
  });

  it("batch_insert_block_trees reads at most 10 pages, marks the rest cut, and cuts down pages over the cap", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ page: `Page ${i}`, properties: { Venue: "Library" } }));
    serve(fixtures);
    const { row } = await audited("batch_insert_block_trees", { body: { entries } });
    expect(gets().map((c) => c.path.slice(GRAPH.length))).toEqual(entries.slice(0, 10).map((e) => `/pages/${encodeURIComponent(e.page)}`));
    const snap = before(row);
    expect(snap).toMatchObject({ source: "getBlocks", truncated: true, data: null });
    expect(snap.pages).toHaveLength(10);

    syncCalls = [];
    serve((path, url) => (path.startsWith("/pages/") ? Response.json({ ...page, properties: [{ title: "Notes", value: "x".repeat(SNAPSHOT_MAX_BYTES) }] }) : fixtures(path, url)));
    const big = await audited("batch_insert_block_trees", { body: { entries: [{ page: "Meeting", properties: { Venue: "Library" } }, { "target-id": B1, properties: { Venue: "Library" } }] } });
    const cut = before(big.row);
    expect(cut).toEqual({
      source: "getBlocks",
      truncated: true,
      data: { blocks: summary.blocks.map((b) => ({ uuid: b.uuid, kind: b.kind, title: b.title, order: b.order, "parent-id": b["parent-id"], "page-id": b["page-id"] })), missing: [] },
      pages: [{ page: "Meeting", source: "getPage", data: { uuid: J5, kind: "page", title: "Notes" } }],
    });
    expect(new TextEncoder().encode(big.row.before!).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);

    // A page title over the cap: cut-down still doesn't fit, so every read keeps only its source.
    syncCalls = [];
    serve((path, url) => (path.startsWith("/pages/") ? Response.json({ ...page, title: "p".repeat(SNAPSHOT_MAX_BYTES) }) : fixtures(path, url)));
    const huge = await audited("batch_insert_block_trees", { body: { entries: [{ page: "Meeting", properties: { Venue: "Library" } }, { "target-id": B1, properties: { Venue: "Library" } }] } });
    expect(huge.row.status).toBe("ok");
    expect(before(huge.row)).toEqual({ source: "getBlocks", truncated: true, data: null, pages: [{ page: "Meeting", source: "getPage", data: null }] });
    expect(new TextEncoder().encode(huge.row.before!).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });

  it("refresh_refs stores its own response's before-text, and nothing when it only previews", async () => {
    serve(fixtures, () => Response.json(refreshRefs));
    const { row } = await audited("refresh_refs", { body: { "page-id": J5, apply: true } });
    expect(gets()).toEqual([]);
    expect(before(row)).toEqual({ source: "refresh_refs", data: [{ uuid: B1, "page-id": J5, before: "Call Sam #Followup" }] });
    serve(fixtures, () => Response.json({ ...refreshRefs, applied: false }));
    expect((await audited("refresh_refs", { body: { "page-id": J5 } })).row.before).toBeNull();
  });

  it("no pre-read for inserts, creates, asset saves, refresh_refs or dry runs other than deletes'", async () => {
    for (const [name, args] of Object.entries(NO_PRE_READ)) {
      syncCalls = [];
      serve(fixtures, () => Response.json({ applied: false, changed: [] }));
      const { row } = await audited(name, args);
      expect(row.status, name).toBe("ok");
      expect(syncCalls.map((c) => c.method), name).toEqual(["POST"]);
      expect(row.before, name).toBeNull();
    }
    for (const [name, where] of Object.entries(DRY_RUNS)) {
      const args = PRE_READS[name].args;
      const dry = where === "query" ? { ...args, "dry-run": true } : { ...args, body: { ...(args.body as object), "dry-run": true } };
      syncCalls = [];
      serve(fixtures, () => Response.json({ "dry-run": true }));
      const { row } = await audited(name, dry);
      expect(row, name).toMatchObject({ status: "ok", dry_run: 1, before: null });
      // A delete's dry run reads what the real call would, to refuse it the same way; it stores nothing.
      const deletes = (snapshotClassFor(name) as { delete?: unknown }).delete !== undefined;
      expect(gets().length, name).toBe(deletes ? 1 : 0);
      expect(writes(), name).toHaveLength(1);
    }
    // save_document: its upload is the only request.
    syncCalls = [];
    syncHandler = () => Response.json({ uuid: "a1", "page-id": J5, "page-title": "Nov 5th, 2026" }, { status: 201 });
    const doc = await audited("save_document", { fileName: "a.md", text: "a" });
    expect(doc.row.status).toBe("ok");
    expect(gets()).toEqual([]);
    expect(doc.row.before).toBeNull();
  });
});

describe("delete snapshots", () => {
  it("delete subtree reads back: delete_blocks stores both blocks' full outlines, read before the delete", async () => {
    serve(fixtures);
    const { result, row } = await audited("delete_blocks", PRE_READS.delete_blocks.args);
    expect(result.isError).toBe(false);
    expect(syncCalls.map((c) => [c.method, c.view])).toEqual([
      ["GET", "outline"],
      ["DELETE", null],
    ]);
    const stored = await new AuditLog(env.DB).get(WORK_ID, row.id);
    const snap = JSON.parse(stored!.before!);
    expect(snap.source).toBe("getBlocks");
    expect(snap.data.blocks.map((b: any) => [b.uuid, b.markdown, b["block-count"], b.truncated])).toEqual([
      [B1, "- Budget\n  - Q3 numbers\n    venue:: Town Hall\n- [TODO] Book the room", 3, false],
      [B2, "- Call Sam about [[Notes]]", 1, false],
    ]);
  });

  it("truncated delete refused naming the entry, nothing sent to the delete endpoint, row refused", async () => {
    const message = (i: number, id: string) => `entry ${i}: ${id} has more descendants than the 2,000-block snapshot budget; delete it in parts`;
    const cases: [Record<string, unknown>, unknown, string][] = [
      // Each block fits the budget alone; together they don't, and the entry where truncated first shows is named.
      [{ body: { "block-ids": [B1, B2] } }, outlineTruncated, message(1, B2)],
      // Reversed: the server reads B2 first and runs out on B1.
      [{ body: { "block-ids": [B2, B1] } }, { ...outlineTruncated, blocks: [{ ...outlineTruncated.blocks[1], truncated: false }, { ...outlineTruncated.blocks[0], truncated: true }] }, message(1, B1)],
      // A title before it, which getBlocks isn't asked for: the entry is counted in the call's block-ids, not the read's ids.
      [{ body: { "block-ids": ["Meeting", B2] } }, { blocks: [outlineTruncated.blocks[1]], missing: [] }, message(1, B2)],
      // Given upper-cased, named as given.
      [{ body: { "block-ids": [B2.toUpperCase()] } }, { blocks: [outlineTruncated.blocks[1]], missing: [] }, message(0, B2.toUpperCase())],
    ];
    for (const [args, response, error] of cases) {
      syncCalls = [];
      serve(() => Response.json(response));
      const { result, row } = await audited("delete_blocks", args);
      expect(result).toEqual({ isError: true, text: error });
      expect(writes()).toEqual([]);
      expect(row).toMatchObject({ status: "refused", error, before: null });
    }
    syncCalls = [];
    serve(() => Response.json({ blocks: [outlineTruncated.blocks[1]], missing: [] }));
    const single = await audited("delete_block", { "block-id": B2 });
    expect(single.row).toMatchObject({ status: "refused", error: message(0, B2) });
    expect(writes()).toEqual([]);
  });

  it("oversized (over 100 KB) delete refused naming the entry; exactly 100 KB goes ahead", async () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(100 * 1024);
    const block = { ...outline.blocks[1], markdown: "" };
    const empty = JSON.stringify({ blocks: [outline.blocks[0], block], missing: [] }).length;
    const sized = (bytes: number) => JSON.stringify({ blocks: [outline.blocks[0], { ...block, markdown: "x".repeat(bytes - empty) }], missing: [] });
    syncCalls = [];
    serve(() => new Response(sized(SNAPSHOT_MAX_BYTES + 1), { headers: { "Content-Type": "application/json" } }));
    const over = await audited("delete_blocks", PRE_READS.delete_blocks.args);
    const error = `entry 1: ${B2} takes the snapshot over 100 KB (102,401 bytes); delete it in parts`;
    expect(over.result).toEqual({ isError: true, text: error });
    expect(over.row).toMatchObject({ status: "refused", error });
    expect(writes()).toEqual([]);

    syncCalls = [];
    serve(() => new Response(sized(SNAPSHOT_MAX_BYTES), { headers: { "Content-Type": "application/json" } }));
    const at = await audited("delete_blocks", PRE_READS.delete_blocks.args);
    expect(at.row.status).toBe("ok");
    expect(writes()).toHaveLength(1);
    expect(before(at.row).data.blocks[1].markdown).toHaveLength(SNAPSHOT_MAX_BYTES - empty);

    // Bytes, not characters: 'é' is two bytes in UTF-8.
    syncCalls = [];
    const wide = JSON.stringify({ ...pageOutline, markdown: "é".repeat(SNAPSHOT_MAX_BYTES / 2) });
    serve(() => new Response(wide, { headers: { "Content-Type": "application/json" } }));
    const page = await audited("delete_page", PRE_READS.delete_page.args);
    expect(page.row.status).toBe("refused");
    expect(page.row.error).toMatch(new RegExp(`^entry 0: ${J5} takes the snapshot over 100 KB \\(\\d{3},\\d{3} bytes\\); delete it in parts$`));
    expect(writes()).toEqual([]);

    // The entry whose subtree takes the running total over the cap is named, not the last one:
    // entry 0 alone is over it, and entry 1 is small.
    for (const [ids, blocks, named] of [
      [[B1, B2], [{ ...outline.blocks[0], markdown: "x".repeat(SNAPSHOT_MAX_BYTES) }, outline.blocks[1]], `entry 0: ${B1}`],
      // Neither alone is over the cap; together they are, at entry 1 of three.
      [
        [B1, B2, B3],
        [
          { ...outline.blocks[0], markdown: "x".repeat(SNAPSHOT_MAX_BYTES / 2) },
          { ...outline.blocks[1], markdown: "y".repeat(SNAPSHOT_MAX_BYTES / 2) },
          { ...outline.blocks[1], uuid: B3, markdown: "z" },
        ],
        `entry 1: ${B2}`,
      ],
    ] as const) {
      syncCalls = [];
      serve(() => Response.json({ blocks, missing: [] }));
      const refused = await audited("delete_blocks", { body: { "block-ids": ids } });
      expect(refused.row.status).toBe("refused");
      expect(refused.row.error).toMatch(new RegExp(`^${named} takes the snapshot over 100 KB \\(\\d{3},\\d{3} bytes\\); delete it in parts$`));
      expect(writes()).toEqual([]);
    }
  });

  it("delete_page snapshot and its truncated refusal", async () => {
    serve(fixtures);
    const { row } = await audited("delete_page", PRE_READS.delete_page.args);
    expect(row.status).toBe("ok");
    expect(syncCalls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${GRAPH}/pages/${J5}/outline`],
      ["DELETE", `${GRAPH}/pages/${J5}`],
    ]);
    expect(before(row)).toEqual({ source: "getPageOutline", data: pageOutline });

    syncCalls = [];
    serve(() => Response.json(pageOutlineTruncated));
    const error = `entry 0: ${J5} has more descendants than the 2,000-block snapshot budget; delete it in parts`;
    const refused = await audited("delete_page", { "page-id": "Nov 5th, 2026" });
    expect(refused.result).toEqual({ isError: true, text: error });
    expect(refused.row).toMatchObject({ status: "refused", error });
    expect(writes()).toEqual([]);
  });

  it("E2EE delete falls back to summaries with e2ee:true and proceeds", async () => {
    serve((path, url) =>
      path === "/blocks" && url.searchParams.get("view") === "summary"
        ? Response.json(summaryE2ee)
        : path === `/pages/${J5}`
          ? Response.json(page)
          : Response.json(e2ee409, { status: 409 }),
    );
    const { row } = await audited("delete_block", { "block-id": B1 });
    expect(row.status).toBe("ok");
    expect(syncCalls.map((c) => [c.method, c.view])).toEqual([
      ["GET", "outline"],
      ["GET", "summary"],
      ["DELETE", null],
    ]);
    expect(before(row)).toEqual({ source: "getBlocks", e2ee: true, data: summaryE2ee });

    syncCalls = [];
    const pageRow = (await audited("delete_page", { "page-id": J5 })).row;
    expect(pageRow.status).toBe("ok");
    expect(syncCalls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${GRAPH}/pages/${J5}/outline`],
      ["GET", `${GRAPH}/pages/${J5}`],
      ["DELETE", `${GRAPH}/pages/${J5}`],
    ]);
    expect(before(pageRow)).toEqual({ source: "getPage", e2ee: true, data: page });

    // The fallback read failing refuses the delete.
    syncCalls = [];
    serve(() => Response.json(e2ee409, { status: 409 }));
    const failed = await audited("delete_blocks", PRE_READS.delete_blocks.args);
    expect(failed.row).toMatchObject({ status: "refused", error: "audit snapshot failed: outlines are unavailable for E2EE graphs; nothing was deleted" });
    expect(writes()).toEqual([]);
  });

  it("a UUID the read lists as missing (hidden, in the Recycle bin or gone) refuses the delete, naming the entry", async () => {
    // getBlocks hides a block under a deleted or hidden ancestor, but the delete still finds it, so
    // a delete of what can't be read is refused, as a page's 404 is.
    const message = (i: number, id: string) => `entry ${i}: ${id} can't be read (hidden, in the Recycle bin or not found); nothing was deleted`;
    const cases: [string, Record<string, unknown>, unknown, string][] = [
      ["delete_blocks", { body: { "block-ids": [B1, B3] } }, { blocks: [outline.blocks[0]], missing: [B3] }, message(1, B3)],
      ["delete_block", { "block-id": B1 }, { blocks: [], missing: [B1] }, message(0, B1)],
      // The same delete sent again: every block is gone. The first is named.
      ["delete_blocks", PRE_READS.delete_blocks.args, { blocks: [], missing: [B1, B2] }, message(0, B1)],
      // Given upper-cased and listed as given, or listed lower-cased: named as the call gave it.
      ["delete_blocks", { body: { "block-ids": [B1, B3.toUpperCase()] } }, { blocks: [outline.blocks[0]], missing: [B3.toUpperCase()] }, message(1, B3.toUpperCase())],
      ["delete_blocks", { body: { "block-ids": [B1, B3.toUpperCase()] } }, { blocks: [outline.blocks[0]], missing: [B3] }, message(1, B3.toUpperCase())],
      // A title before it, which isn't read: the entry is counted in the call's block-ids.
      ["delete_blocks", { body: { "block-ids": ["Meeting", B3] } }, { blocks: [], missing: [B3] }, message(1, B3)],
    ];
    for (const [name, args, response, error] of cases) {
      syncCalls = [];
      serve(() => Response.json(response));
      const { result, row } = await audited(name, args);
      expect(result, name).toEqual({ isError: true, text: error });
      expect(row, name).toMatchObject({ status: "refused", error, before: null });
      expect(writes(), name).toEqual([]);
    }
    // On an E2EE graph the summary read's missing refuses too.
    syncCalls = [];
    serve((path, url) => (url.searchParams.get("view") === "summary" ? Response.json({ blocks: [], missing: [B1] }) : Response.json(e2ee409, { status: 409 })));
    const e2ee = await audited("delete_block", { "block-id": B1 });
    expect(e2ee.row).toMatchObject({ status: "refused", error: message(0, B1) });
    expect(writes()).toEqual([]);
  });

  it("an outline read that fails with anything but 409 refuses the delete, even when the summary read would answer", async () => {
    // Only E2EE's 409 falls back to summaries: any other failure means the subtree can't be read.
    for (const [status, error] of [
      [500, "boom"],
      [404, "not found"],
      [503, "unavailable"],
    ] as const) {
      for (const [name, args] of [
        ["delete_block", PRE_READS.delete_block.args],
        ["delete_blocks", PRE_READS.delete_blocks.args],
        ["delete_page", PRE_READS.delete_page.args],
      ] as const) {
        syncCalls = [];
        serve((path, url) => (url.searchParams.get("view") === "outline" || path.endsWith("/outline") ? Response.json({ error }, { status }) : fixtures(path, url)));
        const { result, row } = await audited(name, args);
        const text = `audit snapshot failed: sync server error (HTTP ${status}): ${error}; nothing was deleted`;
        expect(result, `${name} ${status}`).toEqual({ isError: true, text });
        expect(row, `${name} ${status}`).toMatchObject({ status: "refused", error: text, before: null });
        expect(gets(), `${name} ${status}`).toHaveLength(1);
        expect(writes(), `${name} ${status}`).toEqual([]);
      }
    }
  });

  it("leaf blocks, empty pages and a full 2,000-block budget still go ahead", async () => {
    const cases: [string, Record<string, unknown>, unknown][] = [
      // A leaf block: nothing under it.
      ["delete_block", { "block-id": B1 }, { blocks: [{ ...outline.blocks[0], markdown: "", "block-count": 0 }], missing: [] }],
      // Exactly the budget, not over it.
      ["delete_blocks", PRE_READS.delete_blocks.args, { blocks: [{ ...outline.blocks[0], "block-count": 1999 }, { ...outline.blocks[1], "block-count": 1 }], missing: [] }],
      // An empty page.
      ["delete_page", { "page-id": J5 }, { ...pageOutline, markdown: "", "block-count": 0 }],
    ];
    for (const [name, args, response] of cases) {
      syncCalls = [];
      serve(() => Response.json(response));
      const { result, row } = await audited(name, args);
      expect(result.isError, `${name}: ${result.text}`).toBe(false);
      expect(row.status, name).toBe("ok");
      expect(writes(), name).toHaveLength(1);
      expect(before(row).data, name).toEqual(response);
    }
  });

  it("pre-read failure refuses a delete and stores before.error on update_block", async () => {
    const boom = "sync server error (HTTP 500): boom";
    for (const [name, args] of [
      ["delete_blocks", PRE_READS.delete_blocks.args],
      ["delete_block", PRE_READS.delete_block.args],
      ["delete_page", PRE_READS.delete_page.args],
      ["delete_tag", PRE_READS.delete_tag.args],
      ["delete_property", PRE_READS.delete_property.args],
    ] as const) {
      syncCalls = [];
      serve(() => Response.json({ error: "boom" }, { status: 500 }));
      const { result, row } = await audited(name, args);
      const error = `audit snapshot failed: ${boom}; nothing was deleted`;
      expect(result, name).toEqual({ isError: true, text: error });
      expect(row, name).toMatchObject({ status: "refused", error, before: null });
      expect(writes(), name).toEqual([]);
    }
    // A page that isn't there (or is hidden from reads) can't be snapshotted either.
    syncCalls = [];
    serve(() => Response.json({ error: "not found" }, { status: 404 }));
    expect((await audited("delete_page", { "page-id": J5 })).row).toMatchObject({ status: "refused", error: "audit snapshot failed: sync server error (HTTP 404): not found; nothing was deleted" });
    expect(writes()).toEqual([]);
    // A response that isn't JSON, or a getBlocks answer without its blocks, is a failure too.
    for (const bad of [() => new Response("<html>", { status: 200 }), () => Response.json({ ok: true })]) {
      syncCalls = [];
      serve(bad);
      const { row } = await audited("delete_blocks", PRE_READS.delete_blocks.args);
      expect(row.status).toBe("refused");
      expect(row.error).toMatch(/^audit snapshot failed: .+; nothing was deleted$/);
      expect(writes()).toEqual([]);
    }

    // Any other write goes ahead and keeps the failure as its snapshot.
    for (const [name, source] of [
      ["update_block", "getBlocks"],
      ["update_page", "getPage"],
      ["update_property", "getProperty"],
      ["batch_move_blocks", "getBlocks"],
    ] as const) {
      syncCalls = [];
      serve(() => Response.json({ error: "boom" }, { status: 500 }));
      const { result, row } = await audited(name, PRE_READS[name].args);
      expect(result.isError, name).toBe(false);
      expect(row.status, name).toBe("ok");
      expect(writes(), name).toHaveLength(1);
      expect(before(row), name).toEqual({ source, error: boom });
    }
  });
});

describe("refusals keep the pages their read found", () => {
  const big = (bytes: number) => JSON.stringify({ blocks: [outline.blocks[0], { ...outline.blocks[1], markdown: "x".repeat(bytes) }], missing: [] });
  const J5_LOWER = J5.toLowerCase();

  it("a block or page delete refused after its read, and an errored update_block, are found by the page they read", async () => {
    const cases: [string, string, Record<string, unknown>, () => Response, () => Response][] = [
      ["truncated", "delete_blocks", PRE_READS.delete_blocks.args, () => Response.json(outlineTruncated), () => Response.json({ ok: true })],
      ["over 100 KB", "delete_blocks", PRE_READS.delete_blocks.args, () => new Response(big(SNAPSHOT_MAX_BYTES), { headers: { "Content-Type": "application/json" } }), () => Response.json({ ok: true })],
      ["one block missing", "delete_blocks", { body: { "block-ids": [B1, B3] } }, () => Response.json({ blocks: [outline.blocks[0]], missing: [B3] }), () => Response.json({ ok: true })],
      ["single truncated", "delete_block", { "block-id": B2 }, () => Response.json({ blocks: [outlineTruncated.blocks[1]], missing: [] }), () => Response.json({ ok: true })],
      ["page truncated, by title", "delete_page", { "page-id": "Nov 5th, 2026" }, () => Response.json(pageOutlineTruncated), () => Response.json({ ok: true })],
      ["sync 500 on the write", "update_block", PRE_READS.update_block.args, () => Response.json(summary), () => Response.json({ error: "boom" }, { status: 500 })],
    ];
    const ids: number[] = [];
    for (const [label, name, args, read, write] of cases) {
      syncCalls = [];
      serve(read, write);
      const { result, row } = await audited(name, args);
      expect(result.isError, label).toBe(true);
      expect(row.status, label).toBe(name === "update_block" ? "error" : "refused");
      expect((row.pages ?? "").split("\n"), label).toContain(J5_LOWER);
      ids.push(row.id);
    }
    // A refused page delete names the page its read returned, by title.
    const pageRow = await new AuditLog(env.DB).get(WORK_ID, ids[4]);
    expect(JSON.parse(pageRow!.targets!)[0]).toMatchObject({ uuid: J5, pageTitle: pageOutlineTruncated.title });
    const listed = await call("get_activity_log", { page: J5 });
    for (const id of ids) expect(listed.text, `entry ${id}`).toContain(`"id":${id},`);
  });
});

describe("set_page_favorite (patch 0038)", () => {
  it("add and remove each read the whole favourites list first, with one GET of /favorites, and store it", async () => {
    for (const favorite of [true, false]) {
      syncCalls = [];
      serve(fixtures, () => Response.json({ result: favorite ? "added" : "removed", favorites: [] }));
      const { result, row } = await audited("set_page_favorite", { "page-id": J5, body: { favorite } });
      expect(result.isError, result.text).toBe(false);
      expect(syncCalls.map((c) => [c.method, c.path]), String(favorite)).toEqual([
        ["GET", `${GRAPH}/favorites`],
        ["PUT", `${GRAPH}/pages/${J5}/favorite`],
      ]);
      expect(before(row), String(favorite)).toEqual({ source: "getFavorites", data: favorites });
      expect(row.status).toBe("ok");
    }
  });

  it("on an E2EE graph the list reads as on any other (the page is found by uuid): no fallback read, the list is the snapshot", async () => {
    // listFavorites answers on E2EE graphs; the write itself is refused there by the server.
    serve(fixtures, () => Response.json({ error: "favourites can't be changed on E2EE graphs; the favourites page and its blocks are encrypted" }, { status: 400 }));
    const { row } = await audited("set_page_favorite", { "page-id": J5, body: { favorite: false } });
    expect(gets().map((c) => c.path)).toEqual([`${GRAPH}/favorites`]);
    expect(before(row)).toEqual({ source: "getFavorites", data: favorites });
    expect(row.status).toBe("error");
  });

  it("a remove whose list can't be read is refused, nothing sent to the write; a 409 has no fallback", async () => {
    for (const status of [500, 409]) {
      syncCalls = [];
      serve(() => Response.json({ error: "boom" }, { status }));
      const { result, row } = await audited("set_page_favorite", { "page-id": J5, body: { favorite: false } });
      expect(result.isError).toBe(true);
      expect(row, String(status)).toMatchObject({ status: "refused" });
      expect(row.error, String(status)).toMatch(/^audit snapshot failed: .*boom; nothing was deleted$/);
      expect(gets(), String(status)).toHaveLength(1);
      expect(writes(), String(status)).toEqual([]);
    }
  });

  it("a remove's dry run reads the list to be refused as the real call would be, and keeps nothing", async () => {
    serve(fixtures, () => Response.json({ result: "removed", favorites: [], "dry-run": true }));
    const { row } = await audited("set_page_favorite", { "page-id": J5, body: { favorite: false, "dry-run": true } });
    expect(row).toMatchObject({ status: "ok", dry_run: 1, before: null });
    expect(syncCalls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(syncCalls[1].body)).toEqual({ favorite: false, "dry-run": true });
  });
});

describe("reorder_favorites (patch 0038)", () => {
  it("reads the whole favourites list first, with one GET of /favorites, and stores it as the old order", async () => {
    serve(fixtures, () => Response.json({ favorites: [...favorites.favorites].reverse() }));
    const { result, row } = await audited("reorder_favorites", { body: { "page-ids": [TAG, J5] } });
    expect(result.isError, result.text).toBe(false);
    expect(syncCalls.map((c) => [c.method, c.path])).toEqual([
      ["GET", `${GRAPH}/favorites`],
      ["PUT", `${GRAPH}/favorites`],
    ]);
    expect(before(row)).toEqual({ source: "getFavorites", data: favorites });
    expect(row.status).toBe("ok");
  });

  it("is not a delete: a list that can't be read is kept as the snapshot's error and the write goes ahead", async () => {
    serve(() => Response.json({ error: "boom" }, { status: 500 }), () => Response.json({ favorites: [] }));
    const { result, row } = await audited("reorder_favorites", { body: { "page-ids": [] } });
    expect(result.isError, result.text).toBe(false);
    expect(row.status).toBe("ok");
    expect(writes()).toHaveLength(1);
    expect(before(row)).toEqual({ source: "getFavorites", error: "sync server error (HTTP 500): boom" });
  });
});

describe("dry runs of deletes", () => {
  it("a delete dry run is refused as the real call would be, and keeps no snapshot", async () => {
    const truncated = `entry 1: ${B2} has more descendants than the 2,000-block snapshot budget; delete it in parts`;
    const missing = `entry 1: ${B3} can't be read (hidden, in the Recycle bin or not found); nothing was deleted`;
    const cases: [string, Record<string, unknown>, () => Response, RegExp | string][] = [
      ["delete_blocks", { body: { "block-ids": [B1, B2], "dry-run": true } }, () => Response.json(outlineTruncated), truncated],
      ["delete_blocks", { body: { "block-ids": [B1, B3], "dry-run": true } }, () => Response.json({ blocks: [outline.blocks[0]], missing: [B3] }), missing],
      [
        "delete_blocks",
        { body: { "block-ids": [B1, B2], "dry-run": true } },
        () => new Response(JSON.stringify({ blocks: [outline.blocks[0], { ...outline.blocks[1], markdown: "x".repeat(SNAPSHOT_MAX_BYTES) }], missing: [] }), { headers: { "Content-Type": "application/json" } }),
        /^entry 1: .+ takes the snapshot over 100 KB/,
      ],
      ["delete_page", { "page-id": J5, "dry-run": true }, () => Response.json(pageOutlineTruncated), `entry 0: ${J5} has more descendants than the 2,000-block snapshot budget; delete it in parts`],
      ["delete_tag", { "tag-id": TAG, "dry-run": true }, () => Response.json({ error: "boom" }, { status: 500 }), "audit snapshot failed: sync server error (HTTP 500): boom; nothing was deleted"],
      ["delete_property", { "property-id": PROP, "dry-run": true }, () => Response.json({ error: "boom" }, { status: 500 }), "audit snapshot failed: sync server error (HTTP 500): boom; nothing was deleted"],
    ];
    for (const [name, args, read, error] of cases) {
      syncCalls = [];
      serve(read, () => Response.json({ "dry-run": true }));
      const { result, row } = await audited(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toMatch(error);
      expect(row, name).toMatchObject({ status: "refused", dry_run: 1, before: null });
      expect(writes(), name).toEqual([]);
    }
    // The same dry run of a delete that fits goes ahead and stores nothing it read.
    syncCalls = [];
    serve(fixtures, () => Response.json({ "dry-run": true, deleted: 2 }));
    const ok = await audited("delete_blocks", { body: { "block-ids": [B1, B2], "dry-run": true } });
    expect(ok.row).toMatchObject({ status: "ok", dry_run: 1, before: null });
    expect(gets()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
  });
});

describe("refresh_refs snapshot size", () => {
  const P = "00000001-2026-1105-0000-000000000000";
  const changed = (n: number, chars: number, pageId = P) =>
    Array.from({ length: n }, (_, i) => ({ uuid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`, "page-id": pageId, before: `${i} ${"b".repeat(chars)}`, after: "a" }));

  it("over the cap keeps every block's uuid and page and the first texts whole, marked truncated, and reads back by id", async () => {
    const response = { applied: true, changed: changed(200, 960) };
    serve(fixtures, () => Response.json(response));
    const { row } = await audited("refresh_refs", { body: { apply: true } });
    expect(row.status).toBe("ok");
    expect(new TextEncoder().encode(row.before!).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    const snap = before(row);
    expect(snap).toMatchObject({ source: "refresh_refs", truncated: true });
    expect(snap.data.map((d: any) => [d.uuid, d["page-id"]])).toEqual(response.changed.map((c) => [c.uuid, c["page-id"]]));
    const kept = snap.data.filter((d: any) => d.before !== undefined);
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.map((d: any) => d.before)).toEqual(response.changed.slice(0, kept.length).map((c) => c.before));
    expect(snap.data.slice(kept.length).every((d: any) => d.before === undefined)).toBe(true);

    const back = await call("get_activity_log", { id: row.id });
    expect(back.isError).toBe(false);
    const json = JSON.parse(back.text.slice(back.text.indexOf('{"entries"')));
    expect(json.entries[0].before).toEqual(snap);

    // At the cap's side: a response that fits is stored as given, not marked truncated.
    serve(fixtures, () => Response.json({ applied: true, changed: changed(10, 100) }));
    expect(before((await audited("refresh_refs", { body: { apply: true } })).row).truncated).toBeUndefined();
    // Even the uuids and pages over the cap: data null.
    serve(fixtures, () => Response.json({ applied: true, changed: changed(2000, 10, "p".repeat(100)) }));
    const none = (await audited("refresh_refs", { body: { apply: true } })).row;
    expect(new TextEncoder().encode(none.before!).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(before(none)).toEqual({ source: "refresh_refs", truncated: true, data: null });
  });
});

describe("contract", () => {
  it("connector_help says what the log keeps and that a delete too large to snapshot is refused", async () => {
    const help = (await call("connector_help", {})).text;
    expect(help).toContain("Before an update, move, property change or delete, what it overwrote is kept in the log");
    expect(help).toContain(
      "A block or page delete whose subtree is over 2,000 blocks or 100 KB is refused, naming the entry (entry 1: <uuid> has more descendants than the 2,000-block snapshot budget; delete it in parts); delete it in parts",
    );
    expect(help).toContain("or that it can't read (hidden, in the Recycle bin or not found)");
    expect(help).toContain("A tag or property delete keeps only the definition, not the values or tags it removes from each node");
    expect(help).toContain("A call refused for its input's shape (Input validation error) never reaches the graph and is not logged");
    expect(help).toContain("audit snapshot failed: …; nothing was deleted");
    expect(help).toContain("a delete's dry run reads first and is refused exactly as the real call would be");
  });
});
