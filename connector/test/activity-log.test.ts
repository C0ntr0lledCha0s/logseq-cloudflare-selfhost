import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import committedManifest from "../tools-manifest.json";
import settings from "../../config/settings.json";
import { AuditLog, QUERY_SCAN_CAP, READ_ROW_WRITES } from "../src/audit/log";
import { SNAPSHOT_MAX_BYTES, snapshotClassFor } from "../src/audit/snapshot";
import { RESULT_CHAR_LIMIT } from "../src/tools/common";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { CONNECTOR_HELP } from "../src/tools/handwritten";
import { CONTEXT_TOOLS, NO_CONTEXT_TOOLS } from "../src/tools/readable";
import outline from "./fixtures/audit/get-blocks-outline.json";
import summary from "./fixtures/audit/get-blocks-summary.json";

// get_activity_log (design 2026-11-07-connector-write-audit-log §3.5 and §4; plan stage 4). The real
// tool through mcpHandler, real D1 and, where entries are written by a call, the real audited() path;
// only the sync server is faked, at HTTP level. Dates are read in config/settings.json's timeZone
// (Pacific/Auckland, UTC+13 in November).

const WORK_TOKEN = "logseq_pat_WorkToken123";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const B1 = "aaaaaaaa-0000-4000-8000-000000000001";
const B2 = "aaaaaaaa-0000-4000-8000-000000000002";
const NOTES = "00000002-0000-4000-8000-00000000000a";
const MEETING = "00000002-0000-4000-8000-00000000000b";
const DAY = 86_400_000;
const REASON = "tidy duplicate notes";

let syncCalls: { method: string; path: string }[];
let writeResponse: () => Response;
/** Answers a GET the default fake doesn't, by path under the graph; undefined falls through. */
let readResponse: (path: string) => Response | undefined;
let consoleSpies: MockInstance[];

function testEnv(): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      syncCalls.push({ method: request.method, path: url.pathname });
      const read = request.method === "GET" ? readResponse(url.pathname.slice(`/api/v1/graphs/${WORK_ID}`.length)) : undefined;
      if (read !== undefined) return read;
      if (request.method === "GET" && url.pathname.endsWith("/blocks")) {
        return Response.json(url.searchParams.get("view") === "outline" ? outline : summary);
      }
      if (request.method === "GET") return Response.json({ error: "no fixture" }, { status: 404 });
      return writeResponse();
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync } as Env;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await env.DB.exec("DELETE FROM audit_log");
  const store = new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
  for (const [alias, graphId] of [
    ["work", WORK_ID],
    ["home", OTHER_ID],
  ]) {
    await store.add({ alias, graphId, graphName: alias, mode: "write", permission: "both", expiresAt: null, token: WORK_TOKEN });
  }
  syncCalls = [];
  writeResponse = () => Response.json({ error: "unexpected write" }, { status: 500 });
  readResponse = () => undefined;
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  const e = testEnv();
  const request = new Request("https://mcp.example.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
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
  expect(json.error, method).toBeUndefined();
  return json.result;
}

/** tools/call on graph `work` (or the given one), as the connector serves it. */
async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; content: string[] }> {
  const result = await rpc("tools/call", { name, arguments: { graph: "work", ...args } });
  const content = result.content.map((c: { text: string }) => c.text);
  return { isError: result.isError === true, text: content.join("\n"), content };
}

interface Listing {
  isError: boolean;
  text: string;
  /** The summary lines, one per entry. */
  lines: string[];
  json: { entries: any[]; "next-cursor": string | null; scanned: number };
}

async function activity(args: Record<string, unknown> = {}): Promise<Listing> {
  const { isError, text, content } = await call("get_activity_log", args);
  if (isError) return { isError, text, lines: [], json: { entries: [], "next-cursor": null, scanned: 0 } };
  expect(content, text).toHaveLength(2);
  const lines = content[0].split("\n").filter((l) => /^- /.test(l)).map((l) => l.slice(2));
  return { isError, text, lines, json: JSON.parse(content[1]) };
}

interface Seed {
  at: number;
  graph_id?: string;
  tool?: string;
  kind?: "write" | "read";
  status?: "pending" | "ok" | "error" | "refused";
  dry_run?: 0 | 1;
  reason?: string | null;
  session?: string | null;
  pages?: string | null;
  targets?: unknown[] | null;
  before?: unknown;
  error?: string | null;
}

/** Inserts one row as audited() would leave it and answers its id. */
async function row(s: Seed): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, dry_run, reason, client, session, addressed, pages, targets, before, error)
     VALUES (?, ?, 'work', ?, ?, ?, ?, ?, 'claude-ai', ?, '[]', ?, ?, ?, ?)`,
  )
    .bind(
      s.at,
      s.graph_id ?? WORK_ID,
      s.tool ?? "update_block",
      s.kind ?? "write",
      s.status ?? "ok",
      s.dry_run ?? 0,
      s.reason ?? null,
      s.session ?? null,
      s.pages ?? null,
      s.targets === undefined || s.targets === null ? null : JSON.stringify(s.targets),
      s.before === undefined ? null : JSON.stringify(s.before),
      s.error ?? null,
    )
    .run();
  return result.meta.last_row_id;
}

/** Seeds `n` plain write rows at `at - i` (i from 0), newest first in id order reversed, with one INSERT. */
async function bulk(n: number, at: number): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < ?1)
     INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, pages)
     SELECT ?2 - i, ?3, 'work', 'update_block', 'write', 'ok', 'meeting' FROM k`,
  )
    .bind(n, at, WORK_ID)
    .run();
}

function target(page: string, pageUuid: string, breadcrumb: string[], snippet: string, uuid = B1): Record<string, unknown> {
  return { uuid, kind: "block", role: "affected", pageUuid, pageTitle: page, breadcrumb, snippet };
}

async function readRows(): Promise<{ id: number; tool: string; status: string; rows_read: number; rows_written: number; addressed: string }[]> {
  const { results } = await env.DB.prepare("SELECT * FROM audit_log WHERE kind = 'read' ORDER BY id").all<any>();
  return results;
}

/** One affected block on a page, as a write response names it. */
function affected(page: string, pageUuid: string, breadcrumb: string[], snippet: string, uuid: string, extra: Record<string, unknown> = {}) {
  return { uuid, kind: "block", page: { uuid: pageUuid, title: page }, breadcrumb, snippet, ...extra };
}

describe("listing", () => {
  it("this week in one call: the last 7 days, newest first, each line with page, breadcrumb, snippet and reason", async () => {
    // Real writes through audited(): each tool call leaves one row, which is then dated.
    const dated: [number, number][] = [];
    const write = async (name: string, args: Record<string, unknown>, response: () => Response, daysAgo: number) => {
      writeResponse = response;
      await call(name, { reason: REASON, ...args });
      const { id } = (await env.DB.prepare("SELECT max(id) AS id FROM audit_log WHERE kind = 'write'").first<{ id: number }>())!;
      dated.push([id, daysAgo]);
    };
    await write(
      "delete_blocks",
      { body: { "block-ids": [B1, B2] } },
      () =>
        Response.json({
          deleted: 3,
          affected: [
            affected("Notes", NOTES, ["Meeting"], "Call Sam about the contract", B1, { descendants: 3 }),
            affected("Notes", NOTES, [], "Second", B2),
            affected("Notes", NOTES, [], "Third", "aaaaaaaa-0000-4000-8000-000000000003"),
          ],
        }),
      0.1,
    );
    await write(
      "set_block_property",
      { "block-id": B1, "property-id": "Venue", body: { value: "Library" } },
      () => Response.json({ updated: true, target: affected("Meeting", MEETING, ["Agenda"], "Book the room", B1) }),
      1,
    );
    await write(
      "move_blocks",
      { body: { "block-ids": [B2], "target-id": MEETING, position: "first-child" } },
      () =>
        Response.json({
          moved: true,
          affected: [{ uuid: B2, kind: "block", snippet: "Book flights", from: { page: { uuid: NOTES, title: "Notes" }, breadcrumb: [] }, to: { page: { uuid: MEETING, title: "Meeting" }, breadcrumb: ["Agenda"] } }],
        }),
      3,
    );
    await write(
      "delete_blocks",
      { body: { "block-ids": [B1], "dry-run": true } },
      () => Response.json({ deleted: 1, "dry-run": true, affected: [affected("Notes", NOTES, [], "Dry", B1, { descendants: 0 })] }),
      6.5,
    );
    await write("delete_blocks", { body: { "block-ids": [B1] } }, () => Response.json({ error: "block-ids[0]: block not found" }, { status: 409 }), 6.9);
    await write("set_block_property", { "block-id": B1, "property-id": "Venue", body: { value: "Old" } }, () => Response.json({ updated: true }), 8);
    await write("set_block_property", { "block-id": B1, "property-id": "Venue", body: { value: "Older" } }, () => Response.json({ updated: true }), 9.5);
    const now = Date.now();
    for (const [id, daysAgo] of dated) await env.DB.prepare("UPDATE audit_log SET at = ? WHERE id = ?").bind(now - daysAgo * DAY, id).run();

    const first = await activity();
    expect(first.isError, first.text).toBe(false);
    const ids = dated.filter(([, d]) => d < 7).map(([id]) => id);
    expect(first.json.entries.map((e) => e.id)).toEqual(ids);
    expect(first.json["next-cursor"]).toBeNull();
    const when = String.raw`[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4} \d{2}:\d{2}`;
    const expected = [
      `delete_blocks ok: Notes > Meeting > "Call Sam about the contract" (+3 children) (+2 more). Reason: ${REASON}`,
      `set_block_property ok: Meeting > Agenda > "Book the room". Reason: ${REASON}`,
      `move_blocks ok: "Book flights" from Notes to Meeting > Agenda. Reason: ${REASON}`,
      `delete_blocks dry run: Notes > "Dry" (+0 children). Reason: ${REASON}`,
    ];
    expect(first.lines.slice(0, 4)).toEqual(expected.map((e) => expect.stringMatching(new RegExp(`^${when} ${escape(e)}$`))));
    expect(first.lines[4]).toMatch(new RegExp(`^${when} delete_blocks error: .*block not found.*\\. Reason: ${REASON}$`));
    expect(first.lines).toHaveLength(5);
    const entry = first.json.entries[0];
    expect(Object.keys(entry).sort()).toEqual(["addressed", "at", "client", "dry_run", "error", "id", "reason", "session", "status", "targets", "tool"]);
    expect(entry.addressed).toEqual([B1, B2]);
    expect(entry).toMatchObject({ tool: "delete_blocks", status: "ok", dry_run: false, reason: REASON, error: null });
    expect(entry.targets[0]).toMatchObject({ uuid: B1, pageTitle: "Notes", breadcrumb: ["Meeting"], snippet: "Call Sam about the contract" });
    expect(new Date(entry.at).getTime()).toBeGreaterThan(now - DAY);

    // A re-send of the same listing answers the same entries.
    const again = await activity();
    expect(again.json.entries.map((e) => e.id)).toEqual(ids);
  });

  it("dates are read in the owner's time zone; a day runs midnight to midnight there, and the line shows local time", async () => {
    expect(settings.timeZone).toBe("Pacific/Auckland");
    // 2026-11-05 in Auckland (UTC+13) is 2026-11-04T11:00Z up to 2026-11-05T11:00Z.
    const start = Date.UTC(2026, 10, 4, 11);
    const before = await row({ at: start - 1, tool: "create_page" });
    const first = await row({ at: start, tool: "update_block" });
    const local = await row({ at: Date.UTC(2026, 10, 5, 1, 2), tool: "delete_blocks", targets: [target("Notes", NOTES, [], "x")] });
    const last = await row({ at: start + DAY - 1, tool: "move_blocks" });
    const after = await row({ at: start + DAY, tool: "create_tag" });

    const day = await activity({ since: "2026-11-05", until: "2026-11-05" });
    expect(day.json.entries.map((e) => e.id)).toEqual([last, local, first]);
    expect(day.lines[1]).toBe('Nov 5th, 2026 14:02 delete_blocks ok: Notes > "x"');
    expect(day.lines[2]).toBe("Nov 5th, 2026 00:00 update_block ok");

    // A datetime without an offset is local; with Z or an offset it is that instant; until is exclusive.
    const cases: [Record<string, string>, number[]][] = [
      [{ since: "2026-11-05T14:02", until: "2026-11-05T14:03" }, [local]],
      [{ since: "2026-11-05T14:02:00", until: "2026-11-05T14:02:00.001" }, [local]],
      [{ since: "2026-11-05T01:02:00Z", until: "2026-11-05T01:02:00.001Z" }, [local]],
      [{ since: "2026-11-05T14:02:00+13:00", until: "2026-11-05T14:03+13:00" }, [local]],
      [{ since: "2026-11-04", until: "2026-11-04" }, [before]],
      [{ since: "2026-11-06", until: "2026-11-06" }, [after]],
      [{ since: "2026-11-04T11:00:00Z", until: "2026-11-05T11:00:00Z" }, [last, local, first]],
    ];
    for (const [args, ids] of cases) {
      const got = await activity(args);
      expect(got.isError, `${JSON.stringify(args)}: ${got.text}`).toBe(false);
      expect(got.json.entries.map((e) => e.id), JSON.stringify(args)).toEqual(ids);
    }

    // until alone ends a 7-day window there.
    const toFifth = await activity({ until: "2026-11-05" });
    expect(toFifth.json.entries.map((e) => e.id)).toEqual([last, local, first, before]);
  });
});

/** Escapes a string for a RegExp. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("filters", () => {
  it("page by UUID or by title in any case, never a prefix, a substring or a LIKE pattern", async () => {
    const now = Date.now() - 1000;
    const notes = await row({ at: now - 5, pages: `notes\n${NOTES}`, targets: [target("Notes", NOTES, [], "a")] });
    const meeting = await row({ at: now - 4, pages: `meeting\n${MEETING}` });
    const both = await row({ at: now - 3, pages: `notes\n${NOTES}\nmeeting\n${MEETING}` });
    const journal = await row({ at: now - 2, pages: "nov 5th, 2026\n00000001-2026-1105-0000-000000000000" });
    const decoy = await row({ at: now - 1, pages: "100axdone\nnotes archive" });
    const wild = await row({ at: now, pages: "100%_done" });
    const cases: [string, number[]][] = [
      [NOTES, [both, notes]],
      [NOTES.toUpperCase(), [both, notes]],
      ["Notes", [both, notes]],
      ["NOTES", [both, notes]],
      ["note", []],
      ["otes", []],
      ["notes archive", [decoy]],
      ["Meeting", [both, meeting]],
      [MEETING, [both, meeting]],
      ["Nov 5th, 2026", [journal]],
      ["100%_done", [wild]],
      ["100%", []],
      ["%", []],
      ["_", []],
      ["notes\nmeeting", []],
    ];
    for (const [page, ids] of cases) {
      const got = await activity({ page });
      expect(got.isError, got.text).toBe(false);
      expect(got.json.entries.map((e) => e.id), JSON.stringify(page)).toEqual(ids);
    }
    expect((await activity()).json.entries).toHaveLength(6);
  });

  it("tool, session and each status, dry-run included; pending shows as outcome unknown", async () => {
    const now = Date.now() - 1000;
    const ok = await row({ at: now - 7, tool: "update_block", session: "s-1", reason: "fix typo" });
    const dry = await row({ at: now - 6, tool: "delete_blocks", dry_run: 1, session: "s-1" });
    const err = await row({ at: now - 5, tool: "delete_blocks", status: "error", error: "entry 0: block not found\nsecond line" });
    const refused = await row({ at: now - 4, tool: "move_blocks", status: "refused", error: "reason: at most 200 characters", session: "s-2" });
    const refusedDry = await row({ at: now - 3, tool: "delete_page", status: "refused", dry_run: 1, error: "unknown page" });
    const pending = await row({ at: now - 2, tool: "update_block", status: "pending", session: "s-2" });
    const cases: [Record<string, unknown>, number[]][] = [
      [{ tool: "delete_blocks" }, [err, dry]],
      [{ tool: "update_block" }, [pending, ok]],
      [{ tool: "update" }, []],
      [{ session: "s-1" }, [dry, ok]],
      [{ session: "s-2" }, [pending, refused]],
      [{ status: "ok" }, [ok]],
      [{ status: "dry-run" }, [refusedDry, dry]],
      [{ status: "error" }, [err]],
      [{ status: "refused" }, [refusedDry, refused]],
      [{ status: "pending" }, [pending]],
      [{ status: "refused", tool: "delete_page" }, [refusedDry]],
      [{ status: "ok", session: "s-2" }, []],
    ];
    for (const [args, ids] of cases) {
      const got = await activity(args);
      expect(got.isError, got.text).toBe(false);
      expect(got.json.entries.map((e) => e.id), JSON.stringify(args)).toEqual(ids);
    }
    const all = await activity();
    const byId = new Map(all.json.entries.map((e, i) => [e.id, all.lines[i]]));
    expect(byId.get(pending)).toMatch(/ update_block outcome unknown$/);
    expect(byId.get(refusedDry)).toMatch(/ delete_page refused \(dry run\): unknown page$/);
    expect(byId.get(refused)).toMatch(/ move_blocks refused: reason: at most 200 characters$/);
    expect(byId.get(err)).toMatch(/ delete_blocks error: entry 0: block not found second line$/);
    expect(byId.get(dry)).toMatch(/ delete_blocks dry run$/);
    expect(byId.get(ok)).toMatch(/ update_block ok\. Reason: fix typo$/);
    expect(all.json.entries.find((e) => e.id === pending).status).toBe("pending");
    expect(all.json.entries.find((e) => e.id === dry)).toMatchObject({ status: "ok", dry_run: true });
  });

  it("a refresh_refs preview (apply omitted or false) is a dry run; with apply true it is an applied write", async () => {
    const changed = { changed: [{ uuid: B1, "page-id": NOTES, before: "Call Sam #Followup", after: "Call Sam #[[Followup]]" }] };
    const ids: Record<string, number> = {};
    for (const [label, body, applied] of [
      ["omitted", { "page-id": NOTES }, false],
      ["false", { "page-id": NOTES, apply: false }, false],
      ["whole graph", {}, false],
      ["true", { "page-id": NOTES, apply: true }, true],
    ] as const) {
      writeResponse = () => Response.json({ applied, ...changed });
      const result = await call("refresh_refs", { reason: "check links", body });
      expect(result.isError, result.text).toBe(false);
      ids[label] = Number(/Logged as audit entry (\d+)/.exec(result.text)![1]);
    }
    const all = await activity();
    const line = (id: number) => all.lines[all.json.entries.findIndex((e) => e.id === id)];
    for (const label of ["omitted", "false", "whole graph"]) {
      expect(line(ids[label]), label).toMatch(/ refresh_refs dry run(:|\.)/);
      expect(all.json.entries.find((e) => e.id === ids[label]), label).toMatchObject({ status: "ok", dry_run: true });
    }
    expect(line(ids.true)).toMatch(/ refresh_refs ok(:|\.)/);
    expect((await activity({ status: "ok" })).json.entries.map((e) => e.id)).toEqual([ids.true]);
    expect((await activity({ status: "dry-run" })).json.entries.map((e) => e.id)).toEqual([ids["whole graph"], ids.false, ids.omitted]);
  });

  it("entries whose response names no target are found by page and name what they addressed", async () => {
    const PAGE = { uuid: NOTES, kind: "page", title: "Notes", tags: [], properties: [] };
    readResponse = (path) => (path === `/pages/${NOTES}` || path === "/pages/Notes" ? Response.json(PAGE) : undefined);
    const write = async (name: string, args: Record<string, unknown>, response: () => Response) => {
      writeResponse = response;
      const result = await call(name, args);
      return { result, id: (await env.DB.prepare("SELECT max(id) AS id FROM audit_log WHERE kind = 'write'").first<{ id: number }>())!.id };
    };
    // update_page and promote_page_to_tag name no target; the page is known from the call and its snapshot.
    const renamed = await write("update_page", { "page-id": NOTES, body: { title: "Notes 2" }, reason: "rename" }, () => Response.json({ uuid: NOTES, title: "Notes 2" }));
    expect(renamed.result.isError, renamed.result.text).toBe(false);
    const promoted = await write("promote_page_to_tag", { "page-id": "Notes" }, () => Response.json({ uuid: NOTES, title: "Notes" }));
    // refresh_refs on one page, by its UUID.
    const refreshed = await write("refresh_refs", { body: { "page-id": NOTES, apply: true } }, () => Response.json({ applied: true, changed: [] }));
    // A delete_page the sync server refuses, and one refused before anything is read (the reason is too long).
    const refusedDelete = await write("delete_page", { "page-id": MEETING }, () => Response.json({ error: "x" }, { status: 500 }));
    const tooLong = await write("delete_page", { "page-id": "Meeting", reason: "r".repeat(201) }, () => Response.json({}));
    expect(tooLong.result.isError).toBe(true);
    // A tag write names no page; its tag is shown as addressed.
    const tagged = await write("update_tag", { "tag-id": "Followup", body: { title: "Follow-up" } }, () => Response.json({ uuid: "t", title: "Follow-up" }));

    const byPage = async (page: string) => (await activity({ page })).json.entries.map((e) => e.id);
    expect(await byPage(NOTES)).toEqual([refreshed.id, promoted.id, renamed.id]);
    expect(await byPage("notes")).toEqual([promoted.id, renamed.id]);
    expect(await byPage(MEETING)).toEqual([refusedDelete.id]);
    expect(await byPage("Meeting")).toEqual([tooLong.id]);

    const all = await activity();
    const line = (id: number) => all.lines[all.json.entries.findIndex((e) => e.id === id)];
    const json = (id: number) => all.json.entries.find((e) => e.id === id);
    expect(line(renamed.id)).toMatch(/ update_page ok: page "Notes"\. Reason: rename$/);
    expect(line(promoted.id)).toMatch(/ promote_page_to_tag ok: page "Notes"$/);
    expect(line(refreshed.id)).toMatch(new RegExp(` refresh_refs ok: ${NOTES}$`));
    expect(line(refusedDelete.id)).toMatch(new RegExp(` delete_page refused: audit snapshot failed: .*: ${MEETING}$`));
    expect(line(tooLong.id)).toMatch(/ delete_page refused: reason is 201 characters.*: Meeting$/);
    expect(line(tagged.id)).toMatch(/ update_tag ok: Followup$/);
    expect(json(renamed.id).addressed).toEqual([NOTES]);
    expect(json(tagged.id).addressed).toEqual(["Followup"]);
  });

  it("a call refused before any read is found by each page it names: page-id, page, and a target-id given as a title or date", async () => {
    // A reason over 200 characters refuses every call before anything is read or written.
    const long = "r".repeat(201);
    const cases: [string, Record<string, unknown>, string[]][] = [
      ["delete_page", { "page-id": "Meeting" }, ["meeting"]],
      ["refresh_refs", { body: { "page-id": NOTES, apply: true } }, [NOTES]],
      ["batch_insert_block_trees", { body: { entries: [{ page: "2026-11-05", properties: { Venue: "Library" } }, { "target-id": "Ideas", blocks: [{ title: "x" }] }] } }, ["2026-11-05", "ideas"]],
      ["insert_block_tree", { body: { "target-id": "2026-11-06", blocks: [{ title: "x" }] } }, ["2026-11-06"]],
      ["batch_move_blocks", { body: { moves: [{ "block-ids": [B1], "target-id": "Archive", position: "last-child" }] } }, ["archive"]],
      // A UUID target-id may be a block, so it isn't taken as a page; nor is a block-id.
      ["move_blocks", { body: { "block-ids": [B1], "target-id": B2, position: "after" } }, []],
      ["update_block", { "block-id": B1, body: { title: "x" } }, []],
    ];
    for (const [name, args, pages] of cases) {
      const result = await call(name, { ...args, reason: long });
      expect(result.isError, name).toBe(true);
      const stored = await env.DB.prepare("SELECT status, pages FROM audit_log WHERE kind = 'write' ORDER BY id DESC LIMIT 1").first<{ status: string; pages: string | null }>();
      expect(stored!.status, name).toBe("refused");
      expect(stored!.pages === null ? [] : stored!.pages.split("\n").sort(), name).toEqual([...pages].sort());
    }
    expect(syncCalls).toEqual([]);
    expect((await activity({ page: "Archive" })).json.entries.map((e) => e.tool)).toEqual(["batch_move_blocks"]);
  });

  it("other graphs' entries and read rows never appear", async () => {
    const now = Date.now() - 1000;
    const mine = await row({ at: now - 2 });
    await row({ at: now - 1, graph_id: OTHER_ID });
    await row({ at: now, kind: "read", tool: "get_activity_log" });
    expect((await activity()).json.entries.map((e) => e.id)).toEqual([mine]);
    const home = await call("get_activity_log", { graph: "home" });
    expect(JSON.parse(home.content[1]).entries).toHaveLength(1);
  });
});

describe("cursor", () => {
  it("over 1,200 rows finds 3 spread matches, ends with null, never reads more than 500 rows per call", async () => {
    const top = Date.now() - 10_000;
    await bulk(1200, top);
    // Newest-first positions 100, 700 and 1150. A call with the default limit of 50 scans 449 rows,
    // so each scan holds one, and resuming after the last match instead of the last row scanned
    // would scan rows 101 to 549, find nothing and end there.
    const marked = [100, 700, 1150].map((n) => top - n);
    await env.DB.prepare(`UPDATE audit_log SET pages = 'notes' WHERE at IN (${marked.join(",")})`).run();
    const found: number[] = [];
    const scanned: number[] = [];
    let cursor: string | null | undefined;
    let calls = 0;
    do {
      const page = await activity({ page: "Notes", ...(cursor ? { cursor } : {}) });
      expect(page.isError, page.text).toBe(false);
      found.push(...page.json.entries.map((e) => new Date(e.at).getTime()));
      scanned.push(page.json.scanned);
      cursor = page.json["next-cursor"];
      calls += 1;
    } while (cursor !== null && calls < 10);
    expect(found).toEqual(marked);
    expect(scanned).toEqual([449, 449, 302]);
    expect(cursor).toBeNull();
    const reads = await readRows();
    expect(reads).toHaveLength(3);
    for (const r of reads) expect(r.rows_read).toBeLessThanOrEqual(QUERY_SCAN_CAP);
  });

  it("a page cut by limit resumes after its last entry; rows sharing a time are each returned once", async () => {
    const at = Date.now() - 1000;
    const ids: number[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await row({ at, pages: "notes" }));
    for (let i = 0; i < 3; i += 1) ids.push(await row({ at: at - 1 - i, pages: i === 1 ? "notes" : "meeting" }));
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const page = await activity({ page: "notes", limit: 2, ...(cursor ? { cursor } : {}) });
      pages.push(page.json.entries.map((e) => e.id));
      cursor = page.json["next-cursor"];
    } while (cursor !== null && pages.length < 10);
    expect(pages.flat()).toEqual([ids[3], ids[2], ids[1], ids[0], ids[5]]);
    expect(pages[0]).toEqual([ids[3], ids[2]]);
    expect(pages.at(-1)).not.toEqual([]);
  });

  it("an empty window answers no entries and a null cursor; a bad cursor is refused naming it", async () => {
    const empty = await activity();
    expect(empty.json).toEqual({ entries: [], "next-cursor": null, scanned: 0 });
    expect(empty.text).toContain("No entries");
    for (const cursor of ["abc", "1.2.3", "-1.5", "12", ""]) {
      const bad = await call("get_activity_log", { cursor });
      expect(bad.isError, cursor).toBe(true);
      expect(bad.text, cursor).toMatch(/cursor/);
    }
  });

  it("the query itself reads at most 500 rows over a larger window, and reports what it read", async () => {
    const top = Date.now();
    await bulk(3001, top);
    const measured: { sql: string; rowsRead: number }[] = [];
    const db = {
      prepare: (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          ({
            bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
            all: async () => {
              const r = await stmt.all();
              measured.push({ sql, rowsRead: r.meta.rows_read });
              return r;
            },
            run: async () => {
              const r = await stmt.run();
              measured.push({ sql, rowsRead: r.meta.rows_read });
              return r;
            },
          }) as unknown as D1PreparedStatement;
        return wrap(env.DB.prepare(sql));
      },
    } as unknown as D1Database;
    const log = new AuditLog(db);
    const window = { since: top - 10 * DAY, until: top + 1 };
    const sum = () => measured.reduce((n, m) => n + m.rowsRead, 0);

    // No match: the scan alone, 499 less the page size (one row is kept for a cursor's own row).
    const none = await log.query(WORK_ID, { ...window, page: "nothing", limit: 50 });
    expect(measured.map((m) => m.rowsRead)).toEqual([449]);
    expect(none).toMatchObject({ entries: [], scanned: 449, rowsRead: 449 });
    expect(none.nextCursor).toEqual({ at: top - 448, id: 449 });

    // Every row matches and the page is the largest: 299 scanned and 200 read by id.
    measured.length = 0;
    const full = await log.query(WORK_ID, { ...window, limit: 200 });
    expect(full.entries).toHaveLength(200);
    expect(full.entries[0]).toMatchObject({ at: top, id: 1, tool: "update_block", pages: "meeting", before: null });
    expect(measured.map((m) => m.rowsRead)).toEqual([299, 200]);
    expect(full.rowsRead).toBe(QUERY_SCAN_CAP - 1);
    expect(full.nextCursor).toEqual({ at: top - 199, id: 200 });

    // From the middle of the window: the scan starts at the cursor, not at the newest row, and reads
    // the cursor's own row as well: 1 + 449 + 50 rows.
    measured.length = 0;
    const mid = await log.query(WORK_ID, { ...window, limit: 50, cursor: { at: top - 2000, id: 2001 } });
    expect(mid.entries.map((e) => e.at)).toEqual(Array.from({ length: 50 }, (_, i) => top - 2001 - i));
    expect(measured.map((m) => m.rowsRead)).toEqual([450, 50]);
    expect(mid.rowsRead).toBe(QUERY_SCAN_CAP);

    // A cursor past the window's end reads from the end: until is exclusive.
    measured.length = 0;
    const capped = await log.query(WORK_ID, { since: top - 10 * DAY, until: top - 5, limit: 1, cursor: { at: top, id: 1 } });
    expect(capped.entries.map((e) => e.at)).toEqual([top - 6]);
  });
});

describe("snapshots", () => {
  it("listings omit before; include_snapshot adds it; id returns one entry with its snapshot, reading 1 row", async () => {
    const now = Date.now() - 1000;
    const snap = { source: "getBlocks", data: { blocks: [{ uuid: B1, title: "Agenda" }] } };
    const id = await row({ at: now, tool: "update_block", before: snap });
    await row({ at: now - 1, tool: "create_page" });

    const plain = await activity();
    expect(plain.json.entries).toHaveLength(2);
    for (const e of plain.json.entries) expect(e).not.toHaveProperty("before");

    // The store leaves the snapshot's text in D1 unless asked for it, not only out of the JSON.
    const window = { since: now - DAY, until: now + 1, limit: 10 };
    expect((await new AuditLog(env.DB).query(WORK_ID, window)).entries.map((e) => e.before)).toEqual([null, null]);
    expect((await new AuditLog(env.DB).query(WORK_ID, { ...window, includeSnapshot: true })).entries[0].before).toBe(JSON.stringify(snap));

    const withSnap = await activity({ include_snapshot: true });
    expect(withSnap.json.entries[0].before).toEqual(snap);
    expect(withSnap.json.entries[1].before).toBeNull();

    const one = await activity({ id, tool: "create_page", status: "error", since: "2020-01-01" });
    expect(one.isError, one.text).toBe(false);
    expect(one.json.entries).toHaveLength(1);
    expect(one.json.entries[0]).toMatchObject({ id, tool: "update_block", before: snap });
    expect(one.json["next-cursor"]).toBeNull();
    expect((await readRows()).at(-1)).toMatchObject({ rows_read: 1, rows_written: READ_ROW_WRITES });
  });

  it("a deleted subtree reads back through the tool", async () => {
    writeResponse = () => Response.json({ deleted: 2, affected: [affected("Notes", NOTES, [], "Agenda", B1), affected("Notes", NOTES, [], "Actions", B2)] });
    const deleted = await call("delete_blocks", { reason: REASON, body: { "block-ids": [B1, B2] } });
    expect(deleted.isError, deleted.text).toBe(false);
    const id = Number(/Logged as audit entry (\d+)/.exec(deleted.text)![1]);
    const one = await activity({ id });
    const before = one.json.entries[0].before;
    expect(before.source).toBe("getBlocks");
    expect(before.data.blocks.map((b: any) => [b.uuid, b.markdown])).toEqual([
      [B1, "- Budget\n  - Q3 numbers\n    venue:: Town Hall\n- [TODO] Book the room"],
      [B2, "- Call Sam about [[Notes]]"],
    ]);
    expect(one.lines[0]).toMatch(/ delete_blocks ok: Notes > "Agenda" \(\+1 more\)\. Reason: tidy duplicate notes$/);
  });
});

describe("large snapshots", () => {
  const delete100 = (i: number, size: number) => ({
    source: "getBlocks",
    data: { blocks: [{ uuid: B1, markdown: String(i).repeat(size) }], missing: [] },
  });
  const many = Array.from({ length: 100 }, (_, i) => target(`Page ${i} ${"t".repeat(80)}`, NOTES, ["Parent", "Child"], "s".repeat(80), `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`));

  it("a snapshot at the cap, with 100 targets, reads back whole by id", async () => {
    const now = Date.now() - 1000;
    // At the cap in UTF-8 bytes, less the wrapper.
    const snap = delete100(7, SNAPSHOT_MAX_BYTES - JSON.stringify(delete100(7, 0)).length);
    expect(new TextEncoder().encode(JSON.stringify(snap)).length).toBe(SNAPSHOT_MAX_BYTES);
    const id = await row({ at: now, tool: "delete_blocks", before: snap, targets: many, reason: "r".repeat(200), error: null });
    const { content, isError } = await call("get_activity_log", { id });
    expect(isError).toBe(false);
    expect(content.join("").length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const entry = JSON.parse(content[1]).entries[0];
    expect(entry.before).toEqual(snap);
    expect(entry.id).toBe(id);
  });

  it("an entry whose targets alone are over the result cap keeps its first target and its whole snapshot", async () => {
    const now = Date.now() - 1000;
    const snap = delete100(3, 50_000);
    const huge = Array.from({ length: 400 }, (_, i) => target(`Page ${i} ${"t".repeat(200)}`, NOTES, ["Parent"], "s".repeat(200), `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`));
    expect(JSON.stringify(huge).length).toBeGreaterThan(RESULT_CHAR_LIMIT);
    const id = await row({ at: now, tool: "delete_blocks", before: snap, targets: huge });
    const { content, isError } = await call("get_activity_log", { id });
    expect(isError).toBe(false);
    expect(content.join("").length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const entry = JSON.parse(content[1]).entries[0];
    expect(entry.before).toEqual(snap);
    expect(entry.targets).toEqual([huge[0]]);
    expect(entry["targets-omitted"]).toBe(399);
    // A listing shows it too, and a small entry keeps all its targets.
    await row({ at: now - 1, tool: "update_block", targets: many.slice(0, 3) });
    const listed = await activity({ include_snapshot: true });
    expect(listed.json.entries.map((e) => [e.targets.length, e["targets-omitted"]])).toEqual([
      [1, 399],
      [3, undefined],
    ]);
  });

  it("include_snapshot listings stop before the result cap; next-cursor, in both parts, reads the rest", async () => {
    const now = Date.now() - 1000;
    const size = 40_000;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.unshift(await row({ at: now - 10 + i, tool: "delete_blocks", before: delete100(i, size), targets: many }));
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const { content, isError } = await call("get_activity_log", { include_snapshot: true, ...(cursor ? { cursor } : {}) });
      expect(isError).toBe(false);
      expect(content.join("").length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
      const json = JSON.parse(content[1]);
      expect(json.entries.length).toBeGreaterThan(0);
      for (const e of json.entries) expect(e.before.data.blocks[0].markdown).toHaveLength(size);
      seen.push(...json.entries.map((e: { id: number }) => e.id));
      cursor = json["next-cursor"] ?? undefined;
      if (cursor === undefined) break;
      expect(content[0]).toContain(`next-cursor: ${cursor}`);
    }
    expect(seen).toEqual(ids);
  });
});

describe("snapshot cost", () => {
  it("include_snapshot fetches only the snapshots that fit one result, not every entry's on the page", async () => {
    const top = Date.now() - 1000;
    // 200 deletes, each with a 95,000-character before: one fits a result, two don't.
    await env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < 200)
       INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, pages, before)
       SELECT ?1 - i, ?2, 'work', 'delete_blocks', 'write', 'ok', 'notes',
              '{"source":"getBlocks","data":"' || replace(hex(zeroblob(47500)), '0', 'x') || '"}' FROM k`,
    )
      .bind(top, WORK_ID)
      .run();
    const fetched: { rowsRead: number; chars: number }[] = [];
    const db = {
      prepare: (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          ({
            bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
            all: async () => {
              const r = await stmt.all<Record<string, unknown>>();
              const chars = r.results.reduce((n, row) => n + (typeof row.before === "string" ? row.before.length : 0), 0);
              fetched.push({ rowsRead: r.meta.rows_read, chars });
              return r;
            },
          }) as unknown as D1PreparedStatement;
        return wrap(env.DB.prepare(sql));
      },
    } as unknown as D1Database;
    const budget = RESULT_CHAR_LIMIT - 2_000;
    const page = await new AuditLog(db).query(WORK_ID, { since: top - DAY, until: top + 1, limit: 200, includeSnapshot: true, snapshotChars: budget });
    expect(page.entries.map((e) => e.at)).toEqual([top]);
    expect(page.entries[0].before).toHaveLength(95_000 + '{"source":"getBlocks","data":""}'.length);
    expect(page.nextCursor).toEqual({ at: top, id: page.entries[0].id });
    expect(fetched.reduce((n, f) => n + f.chars, 0)).toBeLessThanOrEqual(budget);
    expect(page.rowsRead).toBeLessThanOrEqual(QUERY_SCAN_CAP);

    // Through the tool: one entry per call, each call within the read budget, and the cursor reads on.
    const first = await activity({ include_snapshot: true, limit: 200 });
    expect(first.json.entries).toHaveLength(1);
    // D1's own count: the scan, the page, and one snapshot (not one per entry on the page).
    const scan = QUERY_SCAN_CAP - 1 - 2 * 200;
    expect((await readRows())[0].rows_read).toBe(scan + scan + 1);
    const second = await activity({ include_snapshot: true, limit: 200, cursor: first.json["next-cursor"] });
    expect(second.json.entries.map((e) => new Date(e.at).getTime())).toEqual([top - 1]);
    for (const r of await readRows()) expect(r.rows_read).toBeLessThanOrEqual(QUERY_SCAN_CAP);
  });

  it("with small snapshots, the largest page and its snapshot fetch still read at most 500 rows", async () => {
    const top = Date.now() - 1000;
    await env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i + 1 < 600)
       INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, pages, before)
       SELECT ?1 - i, ?2, 'work', 'update_block', 'write', 'ok', 'notes', '{"source":"getBlocks","data":null}' FROM k`,
    )
      .bind(top, WORK_ID)
      .run();
    const page = await new AuditLog(env.DB).query(WORK_ID, { since: top - DAY, until: top + 1, limit: 200, includeSnapshot: true, snapshotChars: RESULT_CHAR_LIMIT });
    // The scan is `limit` rows shorter with include_snapshot, keeping room for the snapshot fetch.
    const scan = QUERY_SCAN_CAP - 1 - 2 * 200;
    expect(page.entries).toHaveLength(scan);
    expect(page.entries.every((e) => e.before === '{"source":"getBlocks","data":null}')).toBe(true);
    expect(page.rowsRead).toBeLessThanOrEqual(QUERY_SCAN_CAP);
    // Entries without a snapshot cost no snapshot read.
    await env.DB.exec("UPDATE audit_log SET before = NULL");
    const none = await new AuditLog(env.DB).query(WORK_ID, { since: top - DAY, until: top + 1, limit: 200, includeSnapshot: true, snapshotChars: RESULT_CHAR_LIMIT });
    expect(none.entries).toHaveLength(scan);
    expect(none.rowsRead).toBe(2 * scan);
  });
});

describe("errors name the input", () => {
  it("dates, window, id, limit, cursor and graph", async () => {
    const other = await row({ at: Date.now() - 1000, graph_id: OTHER_ID });
    const readRow = await row({ at: Date.now() - 1000, kind: "read", tool: "get_activity_log" });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ since: "yesterday" }, /^since: not a date or datetime/],
      [{ since: "2026-02-30" }, /^since: not a date or datetime/],
      [{ since: "2026-11-05T25:00" }, /^since: not a date or datetime/],
      [{ since: "1730000000000" }, /^since: not a date or datetime/],
      [{ since: "" }, /^since: not a date or datetime/],
      [{ until: "2026-13-01" }, /^until: not a date or datetime/],
      [{ since: "2026-08-01", until: "2026-11-01" }, /^window: at most 92 days/],
      [{ since: "2026-11-05", until: "2026-11-04" }, /^window: since must be before until/],
      [{ id: 999_999 }, /^id 999999: no such entry for graph work$/],
      [{ id: other }, new RegExp(`^id ${other}: no such entry for graph work$`)],
      [{ id: readRow }, new RegExp(`^id ${readRow}: no such entry for graph work$`)],
      [{ limit: 201 }, /limit/],
      [{ limit: 0 }, /limit/],
      [{ status: "done" }, /status/],
      [{ graph: "nope" }, /unknown graph 'nope'/],
    ];
    for (const [args, message] of cases) {
      const got = await call("get_activity_log", args);
      expect(got.isError, JSON.stringify(args)).toBe(true);
      expect(got.text, JSON.stringify(args)).toMatch(message);
    }
  });

  it("windows of 92 calendar days are kept, across either daylight saving change; 93 are refused", async () => {
    // Auckland's clocks go forward on 2026-09-27 and back on 2026-04-05.
    const ok: Record<string, string>[] = [
      { since: "2026-08-01", until: "2026-10-31" },
      { since: "2026-02-01", until: "2026-05-03" },
      { since: "2026-02-01T00:00", until: "2026-05-04T00:00" },
    ];
    for (const args of ok) {
      const got = await activity(args);
      expect(got.isError, `${JSON.stringify(args)}: ${got.text}`).toBe(false);
    }
    for (const args of [
      { since: "2026-08-01", until: "2026-11-01" },
      { since: "2026-02-01", until: "2026-05-04" },
      { since: "2026-02-01T00:00", until: "2026-05-04T00:00:00.001" },
    ]) {
      const got = await call("get_activity_log", args);
      expect(got.isError, JSON.stringify(args)).toBe(true);
      expect(got.text).toMatch(/^window: at most 92 days/);
    }
  });
});

describe("its own cost", () => {
  it("each call adds one kind='read' row with what it read and 2 rows written, which listings never show", async () => {
    await bulk(10, Date.now() - 1000);
    await activity();
    await activity({ page: "meeting", limit: 3 });
    const first = await activity();
    await call("get_activity_log", { since: "yesterday" });
    const reads = await readRows();
    expect(reads).toHaveLength(3);
    for (const r of reads) {
      expect(r).toMatchObject({ tool: "get_activity_log", status: "ok", rows_written: READ_ROW_WRITES });
      expect(r.rows_read).toBeGreaterThanOrEqual(10);
    }
    expect(JSON.parse(reads[0].addressed)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*\/\d{4}-\d{2}-\d{2}T/)]);
    expect(first.json.entries).toHaveLength(10);
    expect(first.json.entries.every((e) => e.tool === "update_block")).toBe(true);
  });

  it("recordRead's INSERT writes READ_ROW_WRITES rows, measured", async () => {
    let written = -1;
    const db = {
      prepare: (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          ({
            bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
            run: async () => {
              const r = await stmt.run();
              written = r.meta.rows_written;
              return r;
            },
          }) as unknown as D1PreparedStatement;
        return wrap(env.DB.prepare(sql));
      },
    } as unknown as D1Database;
    await new AuditLog(db).recordRead(WORK_ID, "work", ["id:1"], 1);
    expect(written).toBe(READ_ROW_WRITES);
    expect(READ_ROW_WRITES).toBe(2);
  });
});

describe("contract", () => {
  it("get_activity_log is in the manifest read-only and idempotent, listed by tools/list, and outside the write tables", async () => {
    const entry = committedManifest.find((e) => e.name === "get_activity_log");
    const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    expect(entry).toEqual({ name: "get_activity_log", method: null, path: null, annotations: hints });
    const { tools } = await rpc("tools/list", {});
    const listed = tools.find((t: { name: string }) => t.name === "get_activity_log");
    expect(listed.annotations).toEqual(hints);
    expect(Object.keys(listed.inputSchema.properties).sort()).toEqual(
      ["cursor", "graph", "id", "include_snapshot", "limit", "page", "session", "since", "status", "tool", "until"].sort(),
    );
    expect(() => snapshotClassFor("get_activity_log")).toThrow();
    expect(CONTEXT_TOOLS).not.toHaveProperty("get_activity_log");
    expect(NO_CONTEXT_TOOLS).not.toHaveProperty("get_activity_log");
    expect(CONNECTOR_HELP).toContain("get_activity_log answers what changed and shows what an update, move or delete overwrote");
  });
});
