import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ServiceTokenStore, hashServiceToken } from "../src/auth/service-tokens";
import { createSession } from "../src/auth/session";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { mcpHandler } from "../src/mcp";
import { tokenListPage } from "../src/wizard/views";
import { SyncError, inspectToken, syncFetch } from "../src/sync";
import committedManifest from "../tools-manifest.json";

const ORIGIN = "https://mcp.example.com";
const OWNER_ID = 1001;
const TOKEN = "logseq_pat_WorkToken123";
const OTHER_TOKEN = "logseq_pat_OtherToken456";
const GRAPH_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_GRAPH_ID = "22222222-2222-2222-2222-222222222222";

interface StubGraph {
  "graph-id": string;
  "graph-name": string;
  "graph-e2ee?": boolean;
}

/** What the stubbed sync server answers for each token; anything else is a 401 like upstream's. */
type SyncHandler = (request: Request) => Response | Promise<Response>;
let syncHandler: SyncHandler;
let syncRequests: Request[];

function syncForTokens(graphs: Record<string, StubGraph[]>): SyncHandler {
  return (request) => {
    const url = new URL(request.url);
    if (url.origin !== "https://sync.internal" || url.pathname !== "/api/v1/graphs" || request.method !== "GET") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
    const list = graphs[token];
    if (!list) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ graphs: list.map((g) => ({ ...g, "created-at": 1, "updated-at": 2 })) });
  };
}

const WORK: StubGraph = { "graph-id": GRAPH_ID, "graph-name": "My Work Graph", "graph-e2ee?": false };
const OTHER: StubGraph = { "graph-id": OTHER_GRAPH_ID, "graph-name": "Other", "graph-e2ee?": false };

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

/** A date `days` from today (UTC) as YYYY-MM-DD. */
function dateIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every body and log line the wizard produced during a test, for the no-token assertions. */
let transcript: string[];
let consoleSpies: MockInstance[];

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await env.DB.exec("DELETE FROM service_tokens");
  syncRequests = [];
  syncHandler = syncForTokens({ [TOKEN]: [WORK], [OTHER_TOKEN]: [OTHER] });
  transcript = [];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function logged(): string[] {
  return consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
}

async function harness(overrides: Partial<Env> = {}) {
  const worker = createConnector({
    githubFetch: async () => {
      throw new Error("no GitHub calls in wizard tests");
    },
  });
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      syncRequests.push(request.clone());
      return syncHandler(request);
    },
  } as unknown as Fetcher;
  const testEnv = { ...env, SYNC: sync, ...overrides } as Env;
  const cookie = (await createSession(env, OWNER_ID)).split(";")[0];

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    const request = new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
    const ctx = createExecutionContext();
    const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** GET or form POST; records the body text in the transcript and returns it alongside. */
  async function page(path: string, form?: Record<string, string> | string[][]): Promise<{ res: Response; html: string }> {
    const res = await call(path, form ? { method: "POST", body: new URLSearchParams(form) } : {});
    const html = await res.text();
    transcript.push(html, JSON.stringify([...res.headers]));
    return { res, html };
  }

  const list = await page("/graphs");
  expect(list.res.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(list.html)?.[1];
  expect(csrf).toBeTruthy();
  return { call, page, csrf: csrf!, testEnv };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function hidden(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
}

/** Pastes `token` at /graphs/new and returns the confirm page. */
async function submitToken(h: Harness, token = TOKEN) {
  return h.page("/graphs/new", { csrf: h.csrf, token });
}

async function connect(h: Harness, overrides: Record<string, string> = {}) {
  const inspected = await submitToken(h);
  expect(inspected.res.status).toBe(200);
  const pending = hidden(inspected.html, "pending");
  expect(pending).toBeTruthy();
  return h.page("/graphs/confirm", {
    csrf: h.csrf,
    pending: pending!,
    alias: hidden(inspected.html, "alias")!,
    mode: "write",
    permission: "both",
    expires: dateIn(200),
    ...overrides,
  });
}

function assertNoToken() {
  const everything = [...transcript, ...logged()].join("\n");
  for (const token of [TOKEN, OTHER_TOKEN, "WorkToken123", "OtherToken456"]) {
    expect(everything).not.toContain(token);
  }
}

describe("sync client", () => {
  it("syncFetch sends the PAT to sync.internal with query and JSON body", async () => {
    syncHandler = () => Response.json({ ok: true });
    const h = await harness();
    await syncFetch(h.testEnv, TOKEN, {
      method: "POST",
      path: "/api/v1/graphs/g/pages",
      query: { limit: 5, flag: true },
      json: { title: "x" },
    });
    const [req] = syncRequests.slice(-1);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://sync.internal/api/v1/graphs/g/pages");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("flag")).toBe("true");
    expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(await req.json()).toEqual({ title: "x" });
  });

  it("syncFetch throws SyncError with the body's error and Retry-After", async () => {
    syncHandler = () =>
      Response.json({ error: "rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
    const h = await harness();
    const error = await syncFetch(h.testEnv, TOKEN, { method: "GET", path: "/api/v1/graphs" }).catch((e) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ status: 429, message: "rate limit exceeded", retryAfter: 60 });
  });

  it("inspectToken requires exactly one graph with an explicit e2ee flag", async () => {
    const h = await harness();
    expect(await inspectToken(h.testEnv, TOKEN)).toEqual({ graphId: GRAPH_ID, graphName: "My Work Graph", e2ee: false });
    syncHandler = syncForTokens({ [TOKEN]: [WORK, OTHER] });
    await expect(inspectToken(h.testEnv, TOKEN)).rejects.toThrow(/exactly one graph/);
    syncHandler = syncForTokens({ [TOKEN]: [] });
    await expect(inspectToken(h.testEnv, TOKEN)).rejects.toThrow(/exactly one graph/);
    syncHandler = () => Response.json({ graphs: [{ "graph-id": GRAPH_ID, "graph-name": "x" }] });
    await expect(inspectToken(h.testEnv, TOKEN)).rejects.toThrow(/incomplete/);
  });
});

describe("connect a graph", () => {
  it("GET /graphs/new shows Logseq instructions and an empty token field", async () => {
    const h = await harness();
    const { res, html } = await h.page("/graphs/new");
    expect(res.status).toBe(200);
    expect(html).toContain("Personal Access Tokens");
    expect(html).toMatch(/<input[^>]*name="token"/);
    expect(html).not.toMatch(/name="token"[^>]*value=/);
  });

  it("connect flow stores graph with alias from name and mode write", async () => {
    const h = await harness();
    const inspected = await submitToken(h, `${TOKEN}\n`);
    expect(inspected.res.status).toBe(200);
    expect(inspected.html).toContain("My Work Graph");
    expect(hidden(inspected.html, "alias")).toBe("my-work-graph");
    expect(syncRequests).toHaveLength(1);
    expect(syncRequests[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);

    const expires = dateIn(200);
    const confirmed = await h.page("/graphs/confirm", {
      csrf: h.csrf,
      pending: hidden(inspected.html, "pending")!,
      alias: "my-work-graph",
      mode: "write",
      permission: "both",
      expires,
    });
    expect(confirmed.res.status).toBe(303);
    expect(confirmed.res.headers.get("Location")).toBe("/graphs");

    expect(await store().get("my-work-graph")).toEqual({
      alias: "my-work-graph",
      graphId: GRAPH_ID,
      graphName: "My Work Graph",
      mode: "write",
      permission: "both",
      expiresAt: expires,
      lastUsedAt: null,
      // A newly connected graph starts with edit stamps on (migration 0005's default).
      editStamps: true,
    });
    expect(await store().token("my-work-graph")).toBe(TOKEN);

    const list = await h.page("/graphs");
    expect(list.html).toContain("my-work-graph");
    expect(list.html).toContain("My Work Graph");
    expect(list.html).toContain("read-write");
    expect(list.html).toContain(expires);
    assertNoToken();
  });

  it("an edited alias is normalized and an unknown expiry is stored as null", async () => {
    const h = await harness();
    const res = await connect(h, { alias: "Day Job", mode: "read", permission: "read", expires: "", expires_unknown: "1" });
    expect(res.res.status).toBe(303);
    expect(await store().get("day-job")).toMatchObject({ mode: "read", permission: "read", expiresAt: null });
  });

  it("E2EE graph refused with explanation and nothing stored", async () => {
    syncHandler = syncForTokens({ [TOKEN]: [{ ...WORK, "graph-e2ee?": true }] });
    const h = await harness();
    const { res, html } = await submitToken(h);
    expect(res.status).toBe(422);
    expect(html).toMatch(/end-to-end encrypted/i);
    expect(html).toMatch(/can(&#39;|’)t read/i);
    expect(html).not.toContain('name="pending"');
    expect(await store().list()).toEqual([]);
    assertNoToken();
  });

  it("invalid or expired token shows error from sync and nothing stored", async () => {
    const h = await harness();
    const refused = await submitToken(h, "logseq_pat_unknown");
    expect(refused.res.status).toBe(400);
    expect(refused.html).toContain("unauthorized");
    expect(refused.html).not.toContain('name="pending"');

    const before = syncRequests.length;
    const malformed = await submitToken(h, "logseq_pat_has space");
    expect(malformed.res.status).toBe(400);
    expect(malformed.html).toContain("unexpected characters");
    expect(syncRequests.length).toBe(before);

    syncHandler = syncForTokens({ [TOKEN]: [WORK, OTHER] });
    const many = await submitToken(h);
    expect(many.res.status).toBe(400);
    expect(many.html).toContain("exactly one graph");

    expect(await store().list()).toEqual([]);
    expect(refused.html + malformed.html).not.toContain("logseq_pat_");
  });

  it("a graph that is already connected is refused at inspection", async () => {
    const h = await harness();
    await connect(h);
    const again = await submitToken(h);
    expect(again.res.status).toBe(409);
    expect(again.html).toContain("my-work-graph");
    expect(again.html).not.toContain('name="pending"');
  });

  it("confirm validates mode, permission, alias and expiry, keeping the pending field", async () => {
    const h = await harness();
    const cases: [Record<string, string>, RegExp][] = [
      [{ mode: "write", permission: "read" }, /read-only token/i],
      [{ mode: "admin" }, /mode/i],
      [{ permission: "write" }, /permission/i],
      [{ alias: "!!!" }, /alias/i],
      [{ expires: "2027-13-01" }, /date/i],
      [{ expires: "03/11/2027" }, /date/i],
      [{ expires: "2020-01-01" }, /passed/i],
      [{ expires: "" }, /expiry/i],
      [{ expires: dateIn(100), expires_unknown: "1" }, /not both/i],
    ];
    for (const [overrides, message] of cases) {
      const res = await connect(h, overrides);
      expect(res.res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.html, JSON.stringify(overrides)).toMatch(message);
      expect(hidden(res.html, "pending"), JSON.stringify(overrides)).toBeTruthy();
    }
    expect(await store().list()).toEqual([]);
    assertNoToken();
  });

  it("an alias already in use is refused at confirm", async () => {
    const h = await harness();
    await store().add({
      alias: "taken",
      graphId: "33333333-3333-3333-3333-333333333333",
      graphName: "Taken",
      mode: "read",
      permission: "read",
      expiresAt: null,
      token: "logseq_pat_x",
    });
    const res = await connect(h, { alias: "taken" });
    expect(res.res.status).toBe(409);
    expect((await store().list()).map((g) => g.alias)).toEqual(["taken"]);
  });

  it("a tampered, expired or other-session pending field is refused", async () => {
    const h = await harness();
    const inspected = await submitToken(h);
    const pending = hidden(inspected.html, "pending")!;
    const form = { csrf: h.csrf, alias: "work", mode: "write", permission: "both", expires: dateIn(100) };

    const tampered = await h.page("/graphs/confirm", { ...form, pending: pending.slice(0, -2) + "AA" });
    expect(tampered.res.status).toBe(400);

    const other = await harness();
    const crossed = await other.page("/graphs/confirm", { ...form, csrf: other.csrf, pending });
    expect(crossed.res.status).toBe(400);

    const later = Date.now() + 10 * 60 * 1000 + 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const expired = await h.page("/graphs/confirm", { ...form, pending });
      expect(expired.res.status).toBe(400);
      expect(expired.html).toMatch(/expired/i);
    } finally {
      spy.mockRestore();
    }
    expect(await store().list()).toEqual([]);
  });
});

describe("manage connected graphs", () => {
  it("disconnect removes access", async () => {
    const h = await harness();
    await connect(h);
    const { res, html } = await h.page("/graphs/my-work-graph/disconnect", { csrf: h.csrf });
    expect(res.status).toBe(200);
    expect(html).toMatch(/revoke/i);
    expect(await store().get("my-work-graph")).toBeNull();
    await expect(store().token("my-work-graph")).rejects.toThrow();
    assertNoToken();
  });

  it("edit to read mode persists", async () => {
    const h = await harness();
    await connect(h);
    const expires = dateIn(50);
    const { res } = await h.page("/graphs/my-work-graph/edit", {
      csrf: h.csrf,
      alias: "Work",
      mode: "read",
      expires,
    });
    expect(res.status).toBe(303);
    expect(await store().get("my-work-graph")).toBeNull();
    expect(await store().get("work")).toMatchObject({ mode: "read", expiresAt: expires, permission: "both" });
    expect(await store().token("work")).toBe(TOKEN);
  });

  it("edit refuses write mode on a read-only token and a taken alias", async () => {
    const h = await harness();
    await connect(h, { mode: "read", permission: "read" });
    const write = await h.page("/graphs/my-work-graph/edit", {
      csrf: h.csrf,
      alias: "my-work-graph",
      mode: "write",
      expires_unknown: "1",
    });
    expect(write.res.status).toBe(400);
    await store().add({ ...OTHER_RECORD });
    const taken = await h.page("/graphs/my-work-graph/edit", {
      csrf: h.csrf,
      alias: "other",
      mode: "read",
      expires_unknown: "1",
    });
    expect(taken.res.status).toBe(409);
    expect(await store().get("my-work-graph")).toMatchObject({ mode: "read" });
  });

  it("replace token with different graph refused", async () => {
    const h = await harness();
    await connect(h);
    const refused = await h.page("/graphs/my-work-graph/token", {
      csrf: h.csrf,
      token: OTHER_TOKEN,
      permission: "both",
      expires: dateIn(300),
    });
    expect(refused.res.status).toBe(400);
    expect(refused.html).toMatch(/different graph/i);
    expect(await store().token("my-work-graph")).toBe(TOKEN);

    const NEW_TOKEN = "logseq_pat_NewWorkToken789";
    syncHandler = syncForTokens({ [NEW_TOKEN]: [WORK] });
    const expires = dateIn(300);
    const replaced = await h.page("/graphs/my-work-graph/token", {
      csrf: h.csrf,
      token: NEW_TOKEN,
      permission: "both",
      expires,
    });
    expect(replaced.res.status).toBe(303);
    expect(await store().token("my-work-graph")).toBe(NEW_TOKEN);
    expect((await store().get("my-work-graph"))!.expiresAt).toBe(expires);
    expect([...transcript, ...logged()].join("\n")).not.toContain("NewWorkToken789");
    assertNoToken();
  });

  it("expiry within 30 days shows warning", async () => {
    await store().add({ ...OTHER_RECORD, alias: "soon", expiresAt: dateIn(10) });
    await store().add({ ...OTHER_RECORD, alias: "later", graphId: "g-later", expiresAt: dateIn(90) });
    await store().add({ ...OTHER_RECORD, alias: "unknown", graphId: "g-unknown", expiresAt: null });
    const h = await harness();
    const { html } = await h.page("/graphs");
    const section = (alias: string) => html.slice(html.indexOf(`id="graph-${alias}"`)).split("</section>")[0];
    expect(section("soon")).toMatch(/expires in 10 days/i);
    expect(section("later")).not.toMatch(/expires in/i);
    expect(section("unknown")).toMatch(/unknown/i);
    expect(section("unknown")).not.toMatch(/expires in/i);
  });

  it("an unknown alias is a 404", async () => {
    const h = await harness();
    for (const action of ["edit", "token", "disconnect"]) {
      const { res } = await h.page(`/graphs/missing/${action}`, { csrf: h.csrf, alias: "x", mode: "read" });
      expect(res.status, action).toBe(404);
    }
  });

  it("every POST requires the session's CSRF token", async () => {
    const h = await harness();
    await connect(h);
    const other = await harness();
    for (const path of [
      "/graphs/new",
      "/graphs/confirm",
      "/graphs/my-work-graph/edit",
      "/graphs/my-work-graph/token",
      "/graphs/my-work-graph/disconnect",
    ]) {
      const missing = await h.page(path, { token: TOKEN, alias: "x", mode: "read" });
      expect(missing.res.status, path).toBe(403);
      const crossed = await h.page(path, { csrf: other.csrf, token: TOKEN, alias: "x", mode: "read" });
      expect(crossed.res.status, path).toBe(403);
      const json = await h.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(json.status, path).toBe(403);
    }
    expect(await store().get("my-work-graph")).not.toBeNull();
    assertNoToken();
  });

  it("wizard pages require the owner's session", async () => {
    const h = await harness();
    const worker = createConnector({ githubFetch: async () => new Response(null, { status: 500 }) });
    const intruder = (await createSession(env, 2002)).split(";")[0];
    for (const [path, method] of [
      ["/graphs", "GET"],
      ["/graphs/new", "GET"],
      ["/graphs/new", "POST"],
      ["/graphs/confirm", "POST"],
      ["/graphs/x/edit", "POST"],
      ["/graphs/x/token", "POST"],
      ["/graphs/x/disconnect", "POST"],
    ]) {
      for (const cookie of [intruder, ""]) {
        const request = new Request(`${ORIGIN}${path}`, {
          method,
          headers: { Cookie: cookie },
          body: method === "POST" ? new URLSearchParams({ csrf: h.csrf, token: TOKEN }) : undefined,
          redirect: "manual",
        });
        const ctx = createExecutionContext();
        const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, h.testEnv, ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status, `${method} ${path}`).toBe(302);
        expect(res.headers.get("Location")).toBe("/login");
      }
    }
    expect(syncRequests).toEqual([]);
  });

  it("token never appears in any response body", async () => {
    const h = await harness();
    await h.page("/graphs/new");
    await submitToken(h);
    await connect(h, { mode: "write", permission: "read" });
    await connect(h);
    await submitToken(h);
    await h.page("/graphs");
    await h.page("/graphs/my-work-graph/token", { csrf: h.csrf, token: OTHER_TOKEN, permission: "both", expires: dateIn(30) });
    await h.page("/graphs/my-work-graph/token", { csrf: h.csrf, token: TOKEN, permission: "both", expires: "bad" });
    await h.page("/graphs/my-work-graph/token", { csrf: h.csrf, token: TOKEN, permission: "both", expires: dateIn(30) });
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, alias: TOKEN + "x".repeat(30), mode: "read", expires_unknown: "1" });
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, alias: "work", mode: "read", expires_unknown: "1" });
    await h.page("/graphs");
    await h.page("/graphs/work/disconnect", { csrf: h.csrf });
    syncHandler = syncForTokens({ [TOKEN]: [{ ...WORK, "graph-e2ee?": true }] });
    await submitToken(h);
    syncHandler = () => Response.json({ error: "rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
    await submitToken(h);
    expect(transcript.length).toBeGreaterThan(20);
    assertNoToken();
  });
});

describe("edit stamps switch", () => {
  const LABEL = "Mark Claude's edits in the graph";
  const BLOCK = "33333333-3333-3333-3333-333333333333";

  /** The edit form of one graph's section on /graphs. */
  async function editForm(h: Harness, alias: string): Promise<string> {
    const { html } = await h.page("/graphs");
    const section = html.slice(html.indexOf(`id="graph-${alias}"`)).split("</section>")[0];
    return section.slice(section.indexOf(`action="/graphs/${alias}/edit"`)).split("</form>")[0];
  }

  function stampBox(form: string): string | undefined {
    return /<input type="checkbox" name="edit_stamps"[^>]*>/.exec(form)?.[0];
  }

  /** The edit form's fields as the browser would post them, keeping alias, mode and expiry. */
  function sameFields(alias: string, expires: string, stamps: boolean): Record<string, string> {
    return { alias, mode: "write", expires, ...(stamps ? { edit_stamps: "1" } : {}) };
  }

  /** One MCP JSON-RPC call through the connector's own handler, with the wizard tests' sync fake. */
  async function rpc(testEnv: Env, method: string, params: unknown): Promise<any> {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const ctx = createExecutionContext();
    const res = await mcpHandler(testEnv, ctx)(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = res.headers.get("Content-Type")?.includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 1)
      : JSON.parse(text);
    expect(json.error).toBeUndefined();
    return json.result;
  }

  /** Calls update_block and returns the edit-stamp header of each non-GET request it sent. */
  async function updateBlockStamps(h: Harness, alias: string): Promise<(string | null)[]> {
    const tokens = syncForTokens({ [TOKEN]: [WORK], [OTHER_TOKEN]: [OTHER] });
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/graphs") return tokens(request);
      if (request.method === "GET") {
        return Response.json({ uuid: BLOCK, kind: "block", title: "Old", markdown: "Old", "block-count": 0, truncated: false });
      }
      return Response.json({ uuid: BLOCK, kind: "block", title: "New title" });
    };
    syncRequests = [];
    const result = await rpc(h.testEnv, "tools/call", {
      name: "update_block",
      arguments: { graph: alias, "block-id": BLOCK, body: { title: "New title" } },
    });
    expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
    const writes = syncRequests.filter((r) => r.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    return writes.map((r) => r.headers.get("x-logseq-edit-stamp"));
  }

  it("edit form shows the checkbox ticked by default and unticked after saving 0", async () => {
    const h = await harness();
    await connect(h);
    const form = await editForm(h, "my-work-graph");
    expect(form).toContain(LABEL);
    expect(stampBox(form)).toBe('<input type="checkbox" name="edit_stamps" value="1" checked>');
    expect(await store().get("my-work-graph")).toMatchObject({ editStamps: true });

    const expires = (await store().get("my-work-graph"))!.expiresAt!;
    const saved = await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("my-work-graph", expires, false) });
    expect(saved.res.status).toBe(303);
    expect(await store().get("my-work-graph")).toMatchObject({ editStamps: false });
    expect(stampBox(await editForm(h, "my-work-graph"))).toBe('<input type="checkbox" name="edit_stamps" value="1">');

    // Any value other than the box's own "1" is unticked, as the expiry's "unknown" box is.
    for (const [value, on] of [["1", true], ["0", false], ["1", true], ["on", false]] as const) {
      const res = await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("my-work-graph", expires, false), edit_stamps: value });
      expect(res.res.status, value).toBe(303);
      expect((await store().get("my-work-graph"))!.editStamps, value).toBe(on);
    }
  });

  it("posting the form unticked stops the header on the next update_block; ticking it brings it back", async () => {
    const h = await harness();
    await connect(h);
    const expires = (await store().get("my-work-graph"))!.expiresAt!;
    expect(await updateBlockStamps(h, "my-work-graph")).toEqual(["claude"]);

    const off = await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("my-work-graph", expires, false) });
    expect(off.res.status).toBe(303);
    expect(await updateBlockStamps(h, "my-work-graph")).toEqual([null]);

    const on = await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("my-work-graph", expires, true) });
    expect(on.res.status).toBe(303);
    expect(await updateBlockStamps(h, "my-work-graph")).toEqual(["claude"]);

    // The switch follows the graph through a rename in the same save.
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("work", expires, false) });
    expect(await updateBlockStamps(h, "work")).toEqual([null]);
  });

  it("the form needs the owner session and CSRF token; no MCP tool's input schema names edit_stamps or editStamps", async () => {
    const h = await harness();
    await connect(h);
    const expires = (await store().get("my-work-graph"))!.expiresAt!;
    const other = await harness();
    const unticked = sameFields("my-work-graph", expires, false);
    expect((await h.page("/graphs/my-work-graph/edit", unticked)).res.status).toBe(403);
    expect((await h.page("/graphs/my-work-graph/edit", { csrf: other.csrf, ...unticked })).res.status).toBe(403);
    const worker = createConnector({ githubFetch: async () => new Response(null, { status: 500 }) });
    const intruder = (await createSession(env, 2002)).split(";")[0];
    for (const cookie of [intruder, ""]) {
      const request = new Request(`${ORIGIN}/graphs/my-work-graph/edit`, {
        method: "POST",
        headers: { Cookie: cookie },
        body: new URLSearchParams({ csrf: h.csrf, ...unticked }),
        redirect: "manual",
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, h.testEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(302);
    }
    // A refused save (taken alias) changes nothing, the box included.
    await store().add({ ...OTHER_RECORD });
    expect((await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...unticked, alias: "other" })).res.status).toBe(409);
    expect(await store().get("my-work-graph")).toMatchObject({ editStamps: true });

    // No tool, with semantic search off or on, takes the setting as an input.
    const semanticOn = { AI: {} as Ai, VECTORIZE: {} as Vectorize, SEMANTIC_MAX_VECTORS: "10000" };
    for (const extra of [{}, semanticOn]) {
      const { tools } = await rpc({ ...h.testEnv, ...extra } as Env, "tools/list", {});
      expect(tools.length).toBeGreaterThan(20);
      for (const tool of tools) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/edit_?stamps?/i);
    }
  });

  it("a save that only flips the box leaves the other fields unchanged", async () => {
    const h = await harness();
    await connect(h);
    const before = (await store().get("my-work-graph"))!;
    const fields = sameFields("my-work-graph", before.expiresAt!, false);
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...fields });
    expect(await store().get("my-work-graph")).toEqual({ ...before, editStamps: false });
    // Re-sending the same unticked save is a no-op that still succeeds.
    expect((await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...fields })).res.status).toBe(303);
    expect(await store().get("my-work-graph")).toEqual({ ...before, editStamps: false });
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, ...sameFields("my-work-graph", before.expiresAt!, true) });
    expect(await store().get("my-work-graph")).toEqual(before);
    expect(await store().token("my-work-graph")).toBe(TOKEN);
    // A save that changes the other fields with the box ticked keeps stamping on.
    await h.page("/graphs/my-work-graph/edit", { csrf: h.csrf, alias: "my-work-graph", mode: "read", expires_unknown: "1", edit_stamps: "1" });
    expect(await store().get("my-work-graph")).toEqual({ ...before, mode: "read", expiresAt: null, editStamps: true });
    assertNoToken();
  });
});

const OTHER_RECORD = {
  alias: "other",
  graphId: OTHER_GRAPH_ID,
  graphName: "Other",
  mode: "read" as const,
  permission: "read" as const,
  expiresAt: null,
  token: OTHER_TOKEN,
};

describe("service tokens", () => {
  const DAY = 86_400_000;
  const LSCT = /lsct_[A-Za-z0-9_-]{43}/g;
  const tokens = () => new ServiceTokenStore(env.DB);

  /** Two connected graphs: my-work-graph (read-write) and other (read-only). */
  async function twoGraphs(overrides: Partial<Env> = {}) {
    const h = await harness(overrides);
    await connect(h);
    await store().add({ ...OTHER_RECORD });
    return h;
  }

  /** The create form as the browser posts it; `graphs` are repeated `graph` fields. */
  function createForm(h: Harness, fields: Record<string, string> = {}, graphs: string[] = [GRAPH_ID]): string[][] {
    const base: Record<string, string> = { csrf: h.csrf, name: "ci", access: "read", expires_days: "90", ...fields };
    return [...Object.entries(base), ...graphs.map((id) => ["graph", id])];
  }

  async function rawRows(): Promise<Record<string, unknown>[]> {
    return (await env.DB.prepare("SELECT * FROM service_tokens ORDER BY name").all<Record<string, unknown>>()).results;
  }

  /** A worker request with no cookie, optionally carrying a bearer. */
  async function bare(h: Harness, path: string, method: string, headers: Record<string, string> = {}): Promise<Response> {
    const worker = createConnector({ githubFetch: async () => new Response(null, { status: 500 }) });
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: method === "POST" ? new URLSearchParams(createForm(h)) : undefined,
      redirect: "manual",
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, h.testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** One JSON-RPC request to /mcp through the real Worker with `bearer` and no cookie. */
  async function mcp(h: Harness, bearer: string, method: string, params: unknown = {}) {
    const worker = createConnector({ githubFetch: async () => new Response(null, { status: 500 }) });
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, h.testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const text = await res.text();
    transcript.push(text, JSON.stringify([...res.headers]));
    let json: any = null;
    if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
      json = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === 1);
    } else if (text) {
      json = JSON.parse(text);
    }
    return { status: res.status, json };
  }

  /** Creates a token through the wizard and returns it with the response. */
  async function create(h: Harness, fields: Record<string, string> = {}, graphs: string[] = [GRAPH_ID]) {
    const { res, html } = await h.page("/tokens/new", createForm(h, fields, graphs));
    expect(res.status, html).toBe(200);
    const found = html.match(LSCT) ?? [];
    expect(found).toHaveLength(1);
    return { res, html, token: found[0]! };
  }

  /** Every statement on service_tokens (or matching `metered`) through its own `meta`; others go to the real binding. */
  function meterTokens(alter: (sql: string, result: D1Result) => D1Result = (_s, r) => r, metered = /service_tokens/) {
    const measured: { sql: string; read: number; written: number }[] = [];
    const record = <T extends D1Result>(sql: string, result: T): T => {
      measured.push({ sql, read: result.meta.rows_read, written: result.meta.rows_written });
      return alter(sql, result) as T;
    };
    const statement = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
      ({
        bind: (...values: unknown[]) => statement(stmt.bind(...values), sql),
        run: async () => record(sql, await stmt.run()),
        all: async () => record(sql, await stmt.all()),
        first: () => {
          throw new Error("first() has no meta");
        },
        raw: () => {
          throw new Error("raw() has no meta");
        },
      }) as unknown as D1PreparedStatement;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => (metered.test(sql) ? statement(target.prepare(sql), sql) : target.prepare(sql));
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { db, measured };
  }

  it("disconnecting a graph revokes every token that covers it, so reconnecting it restores no token", async () => {
    const h = await twoGraphs();
    const work = await create(h, { name: "nightly", access: "write" });
    const both = await create(h, { name: "both", access: "read" }, [GRAPH_ID, OTHER_RECORD.graphId]);
    const other = await create(h, { name: "other-only", access: "read" }, [OTHER_RECORD.graphId]);
    expect((await mcp(h, work.token, "tools/list")).status).toBe(200);

    const { res, html } = await h.page("/graphs/my-work-graph/disconnect", { csrf: h.csrf });
    expect(res.status).toBe(200);
    expect(html).toMatch(/2 service tokens? .*revoked/i);
    await connect(h);

    const byName = Object.fromEntries((await tokens().list()).map((t) => [t.name, t]));
    expect(byName["nightly"]?.revokedAt).not.toBeNull();
    expect(byName["both"]?.revokedAt).not.toBeNull();
    expect(byName["other-only"]?.revokedAt).toBeNull();
    const refused = await mcp(h, work.token, "tools/list");
    expect(refused.status).toBe(401);
    expect(JSON.stringify(refused.json)).toContain("service token 'nightly' was revoked");
    expect((await mcp(h, both.token, "tools/list")).status).toBe(401);
    expect((await mcp(h, other.token, "tools/list")).status).toBe(200);
    assertNoToken();
  });

  it("/tokens and /tokens/new need the owner's session; a service-token bearer alone is sent to /login", async () => {
    const h = await harness();
    const { id, token } = await tokens().create({
      name: "ci",
      ownerId: OWNER_ID,
      graphIds: [GRAPH_ID],
      access: "write",
      createdAt: Date.now() - DAY,
      expiresAt: Date.now() + 90 * DAY,
    });
    const intruder = (await createSession(env, 2002)).split(";")[0];
    for (const [path, method] of [
      ["/tokens", "GET"],
      ["/tokens/new", "GET"],
      ["/tokens/new", "POST"],
      [`/tokens/${id}/revoke`, "POST"],
    ]) {
      for (const headers of [{}, { Cookie: intruder }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
        const res = await bare(h, path, method, headers);
        expect(res.status, `${method} ${path} ${Object.keys(headers)}`).toBe(302);
        expect(res.headers.get("Location")).toBe("/login");
      }
    }
    expect((await rawRows()).map((r) => [r.name, r.revoked_at])).toEqual([["ci", null]]);
  });

  it("a POST to /tokens/new or /tokens/:id/revoke without the session's CSRF token gets 403 and changes nothing", async () => {
    const h = await twoGraphs();
    const other = await harness();
    const { id } = await tokens().create({
      name: "nightly",
      ownerId: OWNER_ID,
      graphIds: [GRAPH_ID],
      access: "read",
      createdAt: Date.now() - DAY,
      expiresAt: Date.now() + DAY,
    });
    const before = await rawRows();
    for (const path of ["/tokens/new", `/tokens/${id}/revoke`]) {
      const form = createForm(h).filter(([k]) => k !== "csrf");
      expect((await h.page(path, form)).res.status, path).toBe(403);
      expect((await h.page(path, [["csrf", other.csrf], ...form])).res.status, path).toBe(403);
      const json = await h.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(json.status, path).toBe(403);
    }
    expect(await rawRows()).toEqual(before);
  });

  it("create stores only the hash, shows the token once with no-store, and the token reaches /mcp scoped to its graphs", async () => {
    const h = await twoGraphs();
    const t0 = Date.now();
    const { res, html, token } = await create(h, { name: "ci", access: "read", expires_days: "30" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(html.split(token)).toHaveLength(2);
    expect(html.split(token.slice(5))).toHaveLength(2);
    expect(html).toContain("LOGSEQ_SERVICE_TOKEN");
    const rows = await rawRows();
    expect(rows).toHaveLength(1);
    for (const [column, value] of Object.entries(rows[0])) {
      expect(String(value), column).not.toContain(token.slice(5));
    }
    expect(rows[0].token_hash).toBe(await hashServiceToken(token));
    expect(rows[0]).toMatchObject({ name: "ci", owner_id: OWNER_ID, graph_ids: JSON.stringify([GRAPH_ID]), access: "read" });
    const created = rows[0].created_at as number;
    expect(created).toBeGreaterThanOrEqual(t0);
    expect(rows[0].expires_at).toBe(created + 30 * DAY);

    // The new token reaches /mcp without a cookie, sees only its graph, and is read-only there.
    const listed = await mcp(h, token, "tools/call", { name: "list_graphs", arguments: {} });
    expect(listed.status).toBe(200);
    const text = listed.json.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain("my-work-graph");
    expect(text).not.toContain("other");

    // The token appears only on the create response: not in any later page, header or console line.
    const createPage = transcript.indexOf(html);
    await h.page("/tokens");
    await h.page("/tokens/new");
    await h.page("/graphs");
    const elsewhere = [...transcript.slice(0, createPage), ...transcript.slice(createPage + 1), ...logged()].join("\n");
    expect(elsewhere).not.toContain(token.slice(5));
    expect(logged().join("\n")).not.toContain(token.slice(5));
  });

  it("refusals name the field and insert nothing", async () => {
    const h = await twoGraphs();
    await create(h, { name: "taken" });
    const before = await rawRows();
    const cases: [Record<string, string>, string[], number, RegExp][] = [
      [{ name: "taken" }, [GRAPH_ID], 409, /^name: /],
      [{ name: "Bad Name" }, [GRAPH_ID], 400, /^name: /],
      [{ name: "" }, [GRAPH_ID], 400, /^name: /],
      [{ name: "x".repeat(41) }, [GRAPH_ID], 400, /^name: /],
      [{ name: "ci_1" }, [GRAPH_ID], 400, /^name: /],
      [{ name: "ci" }, [], 400, /^graph: /],
      [{ name: "ci" }, ["33333333-3333-3333-3333-333333333333"], 400, /^graph: /],
      [{ name: "ci" }, [GRAPH_ID, "my-work-graph"], 400, /^graph: /],
      [{ name: "ci", access: "admin" }, [GRAPH_ID], 400, /^access: /],
      [{ name: "ci", access: "" }, [GRAPH_ID], 400, /^access: /],
      [{ name: "ci", expires_days: "0" }, [GRAPH_ID], 400, /^expires_days: /],
      [{ name: "ci", expires_days: "366" }, [GRAPH_ID], 400, /^expires_days: /],
      [{ name: "ci", expires_days: "ninety" }, [GRAPH_ID], 400, /^expires_days: /],
      [{ name: "ci", expires_days: "1.5" }, [GRAPH_ID], 400, /^expires_days: /],
      [{ name: "ci", expires_days: "-5" }, [GRAPH_ID], 400, /^expires_days: /],
      [{ name: "ci", expires_days: "" }, [GRAPH_ID], 400, /^expires_days: /],
    ];
    for (const [fields, graphs, status, message] of cases) {
      const { res, html } = await h.page("/tokens/new", createForm(h, fields, graphs));
      const label = JSON.stringify([fields, graphs]);
      expect(res.status, label).toBe(status);
      const error = /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
      expect(error, label).toMatch(message);
      expect(html.match(LSCT), label).toBeNull();
    }
    expect(await rawRows()).toEqual(before);
  });

  it("inputs that already work still succeed: bounds 1 and 365, write access, both graphs in either order, a repeated graph, spaces around fields", async () => {
    const h = await twoGraphs();
    const ok: [Record<string, string>, string[], { graph_ids: string[]; access: string; days: number }][] = [
      [{ name: "a", expires_days: "1" }, [GRAPH_ID], { graph_ids: [GRAPH_ID], access: "read", days: 1 }],
      [{ name: "b", expires_days: "365", access: "write" }, [GRAPH_ID], { graph_ids: [GRAPH_ID], access: "write", days: 365 }],
      [{ name: "c" }, [GRAPH_ID, OTHER_GRAPH_ID], { graph_ids: [GRAPH_ID, OTHER_GRAPH_ID], access: "read", days: 90 }],
      [{ name: "d" }, [OTHER_GRAPH_ID, GRAPH_ID], { graph_ids: [OTHER_GRAPH_ID, GRAPH_ID], access: "read", days: 90 }],
      [{ name: "e" }, [GRAPH_ID, GRAPH_ID], { graph_ids: [GRAPH_ID], access: "read", days: 90 }],
      [{ name: " f-1 ", expires_days: " 7 " }, [GRAPH_ID], { graph_ids: [GRAPH_ID], access: "read", days: 7 }],
      [{ name: "x".repeat(40) }, [GRAPH_ID], { graph_ids: [GRAPH_ID], access: "read", days: 90 }],
    ];
    for (const [fields, graphs, want] of ok) {
      await create(h, fields, graphs);
      const name = fields.name.trim();
      const row = (await rawRows()).find((r) => r.name === name)!;
      expect(row, name).toBeTruthy();
      expect(JSON.parse(row.graph_ids as string), name).toEqual(want.graph_ids);
      expect(row.access, name).toBe(want.access);
      expect((row.expires_at as number) - (row.created_at as number), name).toBe(want.days * DAY);
    }
  });

  it("the form defaults to read-only and 90 days, with a box per connected graph showing its mode", async () => {
    const h = await twoGraphs();
    const { res, html } = await h.page("/tokens/new");
    expect(res.status).toBe(200);
    expect(html).toMatch(/<input type="radio" name="access" value="read" checked/);
    expect(html).not.toMatch(/<input type="radio" name="access" value="write"[^>]* checked/);
    expect(html).toMatch(/<input[^>]*name="expires_days"[^>]*value="90"/);
    expect(html).toMatch(new RegExp(`<input type="checkbox" name="graph" value="${GRAPH_ID}"`));
    expect(html).toMatch(new RegExp(`<input type="checkbox" name="graph" value="${OTHER_GRAPH_ID}"`));
    expect(html).toContain("my-work-graph");
    expect(html).toContain("read-write");
    expect(html).toContain("read-only");
    // The graph list links to the tokens page.
    expect((await h.page("/graphs")).html).toContain('href="/tokens"');
  });

  it("a refused form keeps the valid values and never echoes a bad name", async () => {
    const h = await twoGraphs();
    const { html } = await h.page("/tokens/new", createForm(h, { name: "<b>x", access: "write", expires_days: "30" }, [OTHER_GRAPH_ID]));
    expect(html).not.toContain("<b>x");
    expect(html).toMatch(/<input type="radio" name="access" value="write" checked/);
    expect(html).toMatch(/<input[^>]*name="expires_days"[^>]*value="30"/);
    expect(html).toMatch(new RegExp(`<input type="checkbox" name="graph" value="${OTHER_GRAPH_ID}" checked`));
    expect(html).not.toMatch(new RegExp(`<input type="checkbox" name="graph" value="${GRAPH_ID}" checked`));
  });

  it("the list shows names, current aliases, access and status; revoked and expired rows stay; no token_hash", async () => {
    const h = await twoGraphs();
    const now = Date.now();
    const base = { ownerId: OWNER_ID, access: "read" as const, createdAt: now - 10 * DAY };
    const active = await tokens().create({ ...base, name: "active", graphIds: [GRAPH_ID, OTHER_GRAPH_ID], expiresAt: now + DAY });
    await tokens().create({ ...base, name: "expired", graphIds: [GRAPH_ID], expiresAt: now - DAY });
    const revoked = await tokens().create({ ...base, name: "revoked", graphIds: [OTHER_GRAPH_ID], access: "write", expiresAt: now + DAY });
    await tokens().revoke(revoked.id, now - 1000);
    const gone = await tokens().create({ ...base, name: "gone", graphIds: ["44444444-4444-4444-4444-444444444444"], expiresAt: now + DAY });
    // A rename shows the current alias.
    await store().update("other", { alias: "renamed" });
    const { res, html } = await h.page("/tokens");
    expect(res.status).toBe(200);
    const row = (name: string) => html.slice(html.indexOf(`id="token-${name}"`)).split("</section>")[0];
    expect(row("active")).toContain("my-work-graph");
    expect(row("active")).toContain("renamed");
    expect(row("active")).not.toContain(">other<");
    expect(row("active")).toMatch(/active/);
    expect(row("active")).toContain(`action="/tokens/${active.id}/revoke"`);
    expect(row("expired")).toMatch(/expired/);
    expect(row("expired")).not.toContain("/revoke");
    expect(row("revoked")).toMatch(/revoked/);
    expect(row("revoked")).toContain("read-write");
    expect(row("revoked")).not.toContain("/revoke");
    expect(row("gone")).toContain("not connected");
    expect(row("gone")).toContain(`action="/tokens/${gone.id}/revoke"`);
    expect(html.indexOf('id="token-active"')).toBeLessThan(html.indexOf('id="token-expired"'));
    expect(html.indexOf('id="token-expired"')).toBeLessThan(html.indexOf('id="token-gone"'));
    expect(html.indexOf('id="token-gone"')).toBeLessThan(html.indexOf('id="token-revoked"'));
    expect(html).not.toMatch(/token_hash|tokenHash/);
    for (const r of await rawRows()) expect(html).not.toContain(r.token_hash as string);
    for (const t of [active, revoked, gone]) expect(html).not.toContain(t.token.slice(5));
  });

  it("the list shows a token as expired at exactly its expires_at, as verification refuses it, and active a millisecond before", async () => {
    const now = 1_800_000_000_000;
    const row = (name: string, expiresAt: number) => ({
      id: `id-${name}`,
      name,
      ownerId: OWNER_ID,
      graphIds: [GRAPH_ID],
      access: "read" as const,
      createdAt: now - DAY,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      updatedAt: null,
    });
    const html = await tokenListPage([row("at-now", now), row("just-before", now + 1)], [], "csrf", now).text();
    const section = (name: string) => html.slice(html.indexOf(`id="token-${name}"`)).split("</section>")[0];
    expect(section("at-now")).toMatch(/expired/);
    expect(section("at-now")).not.toContain("/revoke");
    expect(section("just-before")).not.toMatch(/expired/);
    expect(section("just-before")).toContain("/tokens/id-just-before/revoke");
  });

  it("revoke sets revoked_at, redirects to /tokens, and the token then gets the revoked 401; a second revoke keeps the first time", async () => {
    const h = await twoGraphs();
    const { token } = await create(h, { name: "ci" });
    expect((await mcp(h, token, "tools/list")).status).toBe(200);
    const id = (await rawRows())[0].id as string;
    const first = await h.page(`/tokens/${id}/revoke`, { csrf: h.csrf });
    expect(first.res.status).toBe(303);
    expect(first.res.headers.get("Location")).toBe("/tokens");
    const revokedAt = (await tokens().get(id))!.revokedAt;
    expect(revokedAt).not.toBeNull();
    const refused = await mcp(h, token, "tools/list");
    expect(refused.status).toBe(401);
    expect(refused.json).toEqual({ error: "invalid_token", error_description: "service token 'ci' was revoked" });
    // A re-send of the same revoke still succeeds and keeps the first time.
    await new Promise((r) => setTimeout(r, 5));
    const again = await h.page(`/tokens/${id}/revoke`, { csrf: h.csrf });
    expect(again.res.status).toBe(303);
    expect(again.res.headers.get("Location")).toBe("/tokens");
    expect((await tokens().get(id))!.revokedAt).toBe(revokedAt);
    // An expired token can still be revoked (a stale form); an unknown id is a 404.
    const expired = await tokens().create({
      name: "old",
      ownerId: OWNER_ID,
      graphIds: [GRAPH_ID],
      access: "read",
      createdAt: Date.now() - 2 * DAY,
      expiresAt: Date.now() - DAY,
    });
    expect((await h.page(`/tokens/${expired.id}/revoke`, { csrf: h.csrf })).res.status).toBe(303);
    expect((await tokens().get(expired.id))!.revokedAt).not.toBeNull();
    const unknown = await h.page(`/tokens/${crypto.randomUUID()}/revoke`, { csrf: h.csrf });
    expect(unknown.res.status).toBe(404);
  });

  it("cost: create reads 1 row and writes 4 on service_tokens; revoke reads 1 and writes 1", async () => {
    const m = meterTokens();
    const h = await twoGraphs({ DB: m.db });
    await create(h, { name: "ci" });
    expect(m.measured.reduce((n, x) => n + x.read, 0)).toBe(1);
    expect(m.measured.reduce((n, x) => n + x.written, 0)).toBe(4);
    const id = (await rawRows())[0].id as string;
    m.measured.length = 0;
    await h.page(`/tokens/${id}/revoke`, { csrf: h.csrf });
    expect(m.measured.map((x) => [x.read, x.written])).toEqual([[1, 1]]);
    // A refused form costs no service_tokens row.
    m.measured.length = 0;
    await h.page("/tokens/new", createForm(h, { name: "ci2", expires_days: "0" }));
    expect(m.measured).toEqual([]);
  });

  it("read-back: a stored row that differs from the form (test DB wrapper) is deleted and the create refused naming the field", async () => {
    const BOTH = [GRAPH_ID, OTHER_GRAPH_ID];
    // Graph tamperings that keep the length, as well as one that drops a graph.
    const tamperings: [string, (row: Record<string, unknown>) => Record<string, unknown> | null, string[]][] = [
      ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([GRAPH_ID]) }), BOTH],
      ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([OTHER_GRAPH_ID, GRAPH_ID]) }), BOTH],
      ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([GRAPH_ID, GRAPH_ID]) }), BOTH],
      ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([OTHER_GRAPH_ID]) }), [GRAPH_ID]],
      ["name", (r) => ({ ...r, name: "other-name" }), BOTH],
      ["access", (r) => ({ ...r, access: "write" }), BOTH],
      ["expires_days", (r) => ({ ...r, expires_at: (r.expires_at as number) + DAY }), BOTH],
      ["token", () => null, BOTH],
    ];
    for (const [field, tamper, graphIds] of tamperings) {
      const alter = (sql: string, result: D1Result) =>
        /FROM service_tokens WHERE id = \?/.test(sql)
          ? ({
              ...result,
              results: result.results.map((r) => tamper(r as Record<string, unknown>)).filter((r) => r !== null),
            } as D1Result)
          : result;
      const m = meterTokens(alter);
      const h = await twoGraphs({ DB: m.db });
      const { res, html } = await h.page("/tokens/new", createForm(h, { name: "ci" }, graphIds));
      expect(res.status, field).toBe(500);
      const error = /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
      expect(error, field).toMatch(new RegExp(`^${field}: `));
      expect(html.match(LSCT), field).toBeNull();
      expect(await rawRows(), field).toEqual([]);
      await env.DB.exec("DELETE FROM graphs");
    }
  });

  describe("edit a token's graphs, mode and expiry", () => {
    const A = GRAPH_ID;
    const B = OTHER_GRAPH_ID;
    const PAGE_ID = "66666666-6666-4666-8666-666666666666";
    const C = "77777777-7777-4777-8777-777777777777";
    const THIRD = { ...OTHER_RECORD, alias: "third", graphId: C, graphName: "Third", mode: "write" as const, permission: "both" as const, token: "logseq_pat_ThirdToken789" };
    const NOT_ROTATION = "Editing does not change the token. If it may have leaked, revoke it and issue a new one.";
    const CHANGED =
      "This token changed since you opened this page, or the page was not the one the wizard sent. The changes below are against its current values; check them and confirm again.";
    const EFFECTIVE = "effective: read only (the graph is read-only)";
    const RANGE = "expires_days: a whole number of days from 1 to 365.";
    const NOT_CONNECTED = "graph: a chosen graph is not connected. Reload the page and choose again.";
    const ACCESS = "access: choose read-only or read-write.";
    const extension = (expiresAt: number) =>
      `expires_days: that would extend the expiry past ${day(expiresAt)}. A token's expiry can only be shortened; issue a new token instead.`;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

    beforeEach(async () => {
      await env.DB.exec("DELETE FROM audit_log");
    });

    /** The edit form as the browser posts it; `graphs` are repeated `graph` fields. */
    function editForm(h: Harness, fields: Record<string, string> = {}, graphs: string[] = [A]): string[][] {
      const base: Record<string, string> = { csrf: h.csrf, access: "read", ...fields };
      return [...Object.entries(base), ...graphs.map((id) => ["graph", id])];
    }

    function edit(h: Harness, id: string, fields: Record<string, string> = {}, graphs: string[] = [A]) {
      return h.page(`/tokens/${id}/edit`, editForm(h, fields, graphs));
    }

    /** The refusal a page shows (its error box, or a message page's paragraph), with entities decoded. */
    function shown(html: string): string {
      const raw = /<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? /<\/h1>\s*<p>([^<]*)<\/p>/.exec(html)?.[1] ?? "";
      return raw.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
    }

    async function auditRows(): Promise<Record<string, unknown>[]> {
      return (await env.DB.prepare("SELECT * FROM audit_log ORDER BY id").all<Record<string, unknown>>()).results;
    }

    /** Every service_tokens row and every audit_log row, to show a refusal wrote nothing. */
    async function snap() {
      return { rows: await rawRows(), audit: await auditRows() };
    }

    /** A token stored directly: the owner's, read-write on both graphs, 30 days left, unless `scope` says otherwise. */
    async function stored(
      name: string,
      scope: { graphIds?: string[]; access?: "read" | "write"; expiresAt?: number; ownerId?: number } = {},
    ) {
      return tokens().create({
        name,
        ownerId: scope.ownerId ?? OWNER_ID,
        graphIds: scope.graphIds ?? [A, B],
        access: scope.access ?? "write",
        createdAt: Date.now() - 10 * DAY,
        expiresAt: scope.expiresAt ?? Date.now() + 30 * DAY,
      });
    }

    async function refused(
      page: { res: Response; html: string },
      status: number,
      message: string,
      before: Awaited<ReturnType<typeof snap>>,
      label = message,
    ) {
      expect(page.res.status, label).toBe(status);
      expect(shown(page.html), label).toBe(message);
      expect(page.html.match(LSCT), label).toBeNull();
      expect(await snap(), label).toEqual(before);
    }

    const decode = (raw: string) => raw.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));

    /** The edit form's hidden fields in page order, entities decoded: what the browser re-posts on Confirm. */
    function confirmFields(html: string): string[][] {
      const form = /<form[^>]*action="\/tokens\/[^"]+\/edit"[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
      return [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], decode(m[2])]);
    }

    /** The confirm page's gains and losses as plain text, in page order. */
    function changes(html: string): { gains: string[]; losses: string[] } {
      const list = (cls: string) => {
        const ul = new RegExp(`<ul class="${cls}">([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? "";
        return [...ul.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")).trim());
      };
      return { gains: list("gains"), losses: list("losses") };
    }

    /** A 200 confirm page with no write. */
    async function confirmShown(page: { res: Response; html: string }, before: Awaited<ReturnType<typeof snap>>, label = "") {
      expect(page.res.status, `${label} ${shown(page.html)}`).toBe(200);
      expect(page.html, label).toContain("<title>Confirm token changes");
      expect(page.html.match(LSCT), label).toBeNull();
      expect(await snap(), label).toEqual(before);
    }

    function applied(page: { res: Response; html: string }, label = "") {
      expect(page.res.status, `${label} ${shown(page.html)}`).toBe(303);
      expect(page.res.headers.get("Location"), label).toBe("/tokens");
      expect(page.res.headers.get("Cache-Control"), label).toBe("no-store");
    }

    /** A sync server that answers the token checks as before and every API call with an empty page. */
    function answerPages() {
      const tokenSync = syncHandler;
      syncHandler = (request) =>
        new URL(request.url).pathname === "/api/v1/graphs"
          ? tokenSync(request)
          : Response.json({ uuid: PAGE_ID, kind: "page", title: "Notes", markdown: "", "block-count": 0, truncated: false, blocks: [], missing: [] });
    }

    it("the next /mcp call after a narrowing refuses the removed graph, and a write after write-to-read (spec 8.1)", async () => {
      const h = await twoGraphs();
      answerPages();
      const { token } = await create(h, { name: "ci", access: "write" }, [A, B]);
      const id = (await rawRows())[0].id as string;
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await mcp(h, token, "tools/call", { name, arguments: args });
        expect(res.status).toBe(200);
        return {
          isError: res.json.result.isError === true,
          text: res.json.result.content.map((c: { text: string }) => c.text).join("\n"),
        };
      };
      const read = await call("get_page", { graph: "other", "page-id": PAGE_ID });
      expect(read.isError, read.text).toBe(false);
      applied(await edit(h, id, { access: "write" }, [A]));
      expect(await call("get_page", { graph: "other", "page-id": PAGE_ID })).toEqual({
        isError: true,
        text: "graph 'other' is outside service token 'ci''s scope (it covers: my-work-graph)",
      });
      const write = { graph: "my-work-graph", "block-id": PAGE_ID, body: { title: "x" } };
      expect((await call("update_block", write)).text).not.toContain("is read-only");
      applied(await edit(h, id, { access: "read" }, [A]));
      expect(await call("update_block", write)).toEqual({
        isError: true,
        text: "graph 'my-work-graph' is read-only (service token 'ci' is read-only)",
      });
      assertNoToken();
    });

    it("GET shows the name, ticks the current graphs and access, leaves the shorten field blank, and re-posting it unchanged writes nothing", async () => {
      const h = await twoGraphs();
      const gone = "44444444-4444-4444-4444-444444444444";
      const t = await stored("nightly", { graphIds: [A, gone], access: "write" });
      const row = (await tokens().get(t.id))!;
      const { res, html } = await h.page(`/tokens/${t.id}/edit`);
      expect(res.status).toBe(200);
      expect(html).toContain("nightly");
      expect(html).toContain(`action="/tokens/${t.id}/edit"`);
      expect(html).toMatch(new RegExp(`<input type="checkbox" name="graph" value="${A}" checked`));
      expect(html).toMatch(new RegExp(`<input type="checkbox" name="graph" value="${B}">`));
      expect(html).toContain(`${gone} (not connected`);
      expect(html).toMatch(/<input type="radio" name="access" value="write" checked/);
      expect(html).not.toMatch(/<input type="radio" name="access" value="read"[^>]* checked/);
      expect(html).toMatch(/<input[^>]*name="expires_days" value=""/);
      expect(html).toContain(day(row.expiresAt));
      expect(html.match(LSCT)).toBeNull();
      expect(html).not.toContain(t.token.slice(5));
      // The page's own fields, re-posted: the unconnected graph has no box, so dropping it is the only change.
      const before = await snap();
      applied(await h.page(`/tokens/${t.id}/edit`, [["csrf", hidden(html, "csrf")!], ["access", "write"], ["expires_days", ""], ["graph", A]]));
      expect((await tokens().get(t.id))!.graphIds).toEqual([A]);
      expect((await auditRows()).length).toBe(before.audit.length + 1);
      // And re-posting the same form again is no change.
      const after = await snap();
      applied(await h.page(`/tokens/${t.id}/edit`, [["csrf", h.csrf], ["access", "write"], ["expires_days", ""], ["graph", A]]));
      expect(await snap()).toEqual(after);
    });

    it("a narrowing applies in one POST: 303 to /tokens, updated_at set, expiry kept, one token_edit row each (spec 8.4)", async () => {
      const h = await twoGraphs();
      type Access = "read" | "write";
      const cases: [string, string[], Access, string[], Access, string[]][] = [
        ["remove-second", [A, B], "write", [A], "write", [A]],
        ["remove-first", [A, B], "read", [B], "read", [B]],
        ["reversed-pair", [B, A], "read", [A], "read", [A]],
        ["write-to-read", [A], "write", [A], "read", [A]],
        ["both-at-once", [A, B], "write", [B], "read", [B]],
      ];
      for (const [name, graphIds, access, form, next, want] of cases) {
        const t = await stored(name, { graphIds, access });
        const was = (await tokens().get(t.id))!;
        const t0 = Date.now();
        applied(await edit(h, t.id, { access: next }, form), name);
        const row = (await tokens().get(t.id))!;
        expect(row, name).toMatchObject({ graphIds: want, access: next, expiresAt: was.expiresAt, revokedAt: null });
        expect(row.updatedAt, name).toBeGreaterThanOrEqual(t0);
        expect(row.updatedAt, name).toBeLessThanOrEqual(Date.now());
        expect((await auditRows()).filter((r) => r.alias === `service:${name}`), name).toHaveLength(1);
      }
      // A chain: two narrowings in a row each apply, the second guarded on what the first stored.
      const t = await stored("chain", { graphIds: [A, B], access: "write" });
      applied(await edit(h, t.id, { access: "read" }, [A, B]));
      applied(await edit(h, t.id, { access: "read" }, [B]));
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [B], access: "read" });
      const chain = (await auditRows()).filter((r) => r.alias === "service:chain").map((r) => JSON.parse(r.before as string).data);
      expect(chain.map((d) => [d.before.graphIds, d.before.access, d.after.graphIds, d.after.access])).toEqual([
        [[A, B], "write", [A, B], "read"],
        [[A, B], "read", [B], "read"],
      ]);
    });

    it("a widening (an added graph, a swap, read to write, a narrowing with a raise) shows the confirm page and writes nothing; re-posting its fields applies it, and a re-send changes nothing (spec 8.2)", async () => {
      const h = await twoGraphs();
      type Access = "read" | "write";
      const shorter = expect.stringMatching(new RegExp(`^expiry shortened to ${day(Date.now() + 5 * DAY)} \\d{2}:\\d{2} UTC$`));
      // label, stored graphs and access, form graphs and access, extra fields, gains, losses
      const cases: [string, string[], Access, string[], Access, Record<string, string>, string[], unknown[]][] = [
        ["add-graph", [A], "read", [A, B], "read", {}, ["gains read-only on other"], []],
        ["add-graph-first", [A], "read", [B, A], "read", {}, ["gains read-only on other"], []],
        ["read-to-write", [A], "read", [A], "write", {}, ["gains read-write on my-work-graph"], []],
        ["swap", [A], "read", [B], "read", {}, ["gains read-only on other"], ["loses access to my-work-graph"]],
        ["swap-reversed", [B], "read", [A], "read", {}, ["gains read-only on my-work-graph"], ["loses access to other"]],
        ["narrow-and-raise", [A, B], "read", [A], "write", {}, ["gains read-write on my-work-graph"], ["loses access to other"]],
        ["add-and-drop-write", [A], "write", [A, B], "read", {}, ["gains read-only on other"], ["loses read-write on my-work-graph"]],
        ["swap-shorter-expiry", [A], "read", [B], "read", { expires_days: "5" }, ["gains read-only on other"], ["loses access to my-work-graph", shorter]],
      ];
      for (const [name, graphIds, access, form, next, extra, gains, losses] of cases) {
        const t = await stored(name, { graphIds, access });
        const before = await snap();
        const first = await edit(h, t.id, { access: next, ...extra }, form);
        await confirmShown(first, before, name);
        expect(changes(first.html), name).toEqual({ gains, losses });
        expect(first.html, name).not.toContain(CHANGED);
        applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(first.html)), name);
        const row = (await tokens().get(t.id))!;
        expect(row, name).toMatchObject({ graphIds: form, access: next, revokedAt: null });
        expect(row.updatedAt, name).not.toBeNull();
        expect((await auditRows()).filter((r) => r.alias === `service:${name}`), name).toHaveLength(1);
        if (extra.expires_days !== undefined) continue; // a re-sent day count counts from a later now: stage 3's extension refusal
        const after = await snap();
        applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(first.html)), `${name} re-sent`);
        expect(await snap(), `${name} re-sent`).toEqual(after);
      }
    });

    it("chains: two confirmed widenings in a row each guard on what the one before stored; replaying the first page afterwards only narrows, so it applies at once", async () => {
      const h = await twoGraphs();
      const t = await stored("chain", { graphIds: [A], access: "read" });
      const first = await edit(h, t.id, { access: "read" }, [A, B]);
      expect(first.res.status).toBe(200);
      applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(first.html)));
      const second = await edit(h, t.id, { access: "write" }, [A, B]);
      expect(second.res.status).toBe(200);
      expect(JSON.parse(decode(hidden(second.html, "base")!))).toMatchObject({ graphIds: [A, B], access: "read" });
      // The first page's base is stale now, but its fields only drop write, so they need no confirm.
      applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(second.html)));
      applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(first.html)));
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [A, B], access: "read" });
      const chain = (await auditRows()).map((r) => JSON.parse(r.before as string).data);
      expect(chain.map((d) => [d.before.graphIds, d.before.access, d.after.graphIds, d.after.access])).toEqual([
        [[A], "read", [A, B], "read"],
        [[A, B], "read", [A, B], "write"],
        [[A, B], "write", [A, B], "read"],
      ]);
    });

    it("after a confirmed widening the next /mcp call reaches the added graph, and a write works after a confirmed read to write (spec 8.1, 8.2)", async () => {
      const h = await twoGraphs();
      answerPages();
      await store().add({ ...THIRD });
      const { token } = await create(h, { name: "ci", access: "read" }, [A]);
      const id = (await rawRows())[0].id as string;
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await mcp(h, token, "tools/call", { name, arguments: args });
        expect(res.status).toBe(200);
        return {
          isError: res.json.result.isError === true,
          text: res.json.result.content.map((c: { text: string }) => c.text).join("\n"),
        };
      };
      const read = { graph: "third", "page-id": PAGE_ID };
      const outside = { isError: true, text: "graph 'third' is outside service token 'ci''s scope (it covers: my-work-graph)" };
      expect(await call("get_page", read)).toEqual(outside);
      const add = await edit(h, id, { access: "read" }, [A, C]);
      expect(add.res.status).toBe(200);
      expect(await call("get_page", read)).toEqual(outside);
      applied(await h.page(`/tokens/${id}/edit`, confirmFields(add.html)));
      expect((await call("get_page", read)).isError).toBe(false);
      const write = { graph: "third", "block-id": PAGE_ID, body: { title: "x" } };
      const readOnly = { isError: true, text: "graph 'third' is read-only (service token 'ci' is read-only)" };
      expect(await call("update_block", write)).toEqual(readOnly);
      const raise = await edit(h, id, { access: "write" }, [A, C]);
      expect(changes(raise.html).gains).toEqual(["gains read-write on my-work-graph", "gains read-write on third"]);
      expect(await call("update_block", write)).toEqual(readOnly);
      applied(await h.page(`/tokens/${id}/edit`, confirmFields(raise.html)));
      expect((await call("update_block", write)).text).not.toContain("is read-only");
      assertNoToken();
    });

    it("the confirm page names gains and losses by alias, says an edit is not a rotation, and re-posts the form with confirm=1, base and the CSRF token; it holds no token", async () => {
      const h = await twoGraphs();
      await store().add({ ...THIRD });
      const gone = "44444444-4444-4444-4444-444444444444";
      const t = await stored("ci", { graphIds: [A, B, gone], access: "read" });
      const row = (await tokens().get(t.id))!;
      const before = await snap();
      const page = await edit(h, t.id, { access: "write", expires_days: " 7 " }, [C, A]);
      await confirmShown(page, before);
      expect(page.html).toContain(`<span class="alias">ci</span>`);
      expect(changes(page.html)).toEqual({
        gains: ["gains read-write on third", "gains read-write on my-work-graph"],
        losses: ["loses access to other", `loses access to ${gone} (not connected)`, expect.stringMatching(/^expiry shortened to /)],
      });
      expect(page.html).toContain(NOT_ROTATION);
      expect(page.html).not.toContain(CHANGED);
      expect(page.html).toContain(`action="/tokens/${t.id}/edit"`);
      expect(page.html).toContain(`href="/tokens/${t.id}/edit"`);
      expect(confirmFields(page.html)).toEqual([
        ["csrf", h.csrf],
        ["access", "write"],
        ["expires_days", "7"],
        ["graph", C],
        ["graph", A],
        ["confirm", "1"],
        ["base", JSON.stringify({ graphIds: [A, B, gone], access: "read", expiresAt: row.expiresAt })],
      ]);
      expect(page.html).not.toContain(t.token.slice(5));
      expect(page.html).not.toContain((await rawRows())[0].token_hash as string);
    });

    it("a forged confirm (confirm=1 with no base, a base that is not JSON or not the stored values) or a confirm other than 1 shows the confirm page and writes nothing", async () => {
      const h = await twoGraphs();
      const t = await stored("ci", { graphIds: [A, B], access: "read" });
      const row = (await tokens().get(t.id))!;
      const good = { graphIds: [A, B], access: "read", expiresAt: row.expiresAt };
      const base = (value: unknown) => ({ confirm: "1", base: JSON.stringify(value) });
      const before = await snap();
      // label, fields, whether the changed-since line shows
      const cases: [string, Record<string, string>, boolean][] = [
        ["no base", { confirm: "1" }, true],
        ["empty base", { confirm: "1", base: "" }, true],
        ["not json", { confirm: "1", base: "not json" }, true],
        ["null", base(null), true],
        ["a number", base(42), true],
        ["a string", base("read"), true],
        ["an array", base([good]), true],
        ["no expiresAt", base({ graphIds: [A, B], access: "read" }), true],
        ["expiresAt as a string", base({ ...good, expiresAt: String(row.expiresAt) }), true],
        ["expiresAt a millisecond later", base({ ...good, expiresAt: row.expiresAt + 1 }), true],
        ["graphs reordered", base({ ...good, graphIds: [B, A] }), true],
        ["one graph missing", base({ ...good, graphIds: [A] }), true],
        ["graphs as a string", base({ ...good, graphIds: A }), true],
        ["graphs as JSON text", base({ ...good, graphIds: JSON.stringify([A, B]) }), true],
        ["access raised", base({ ...good, access: "write" }), true],
        ["no access", base({ graphIds: [A, B], expiresAt: row.expiresAt }), true],
        ["confirm=true", { confirm: "true", base: JSON.stringify(good) }, false],
        ["confirm empty", { confirm: "", base: JSON.stringify(good) }, false],
        ["no confirm", { base: JSON.stringify(good) }, false],
      ];
      for (const [label, fields, stale] of cases) {
        const page = await edit(h, t.id, { access: "write", ...fields }, [A, B]);
        await confirmShown(page, before, label);
        expect(page.html.includes(CHANGED), label).toBe(stale);
        expect(decode(hidden(page.html, "base") ?? ""), label).toBe(JSON.stringify(good));
      }
      // The control: the stored values as base, in any key order and with an extra key, apply.
      const reordered = { expiresAt: row.expiresAt, access: "read", graphIds: [A, B], note: "ignored" };
      applied(await edit(h, t.id, { access: "write", ...base(reordered) }, [A, B]));
      expect((await tokens().get(t.id))!.access).toBe("write");
    });

    it("a stale confirm (the token changed after the confirm page) shows the page again with a changed-since line and the current values, and writes nothing (spec 8.3)", async () => {
      const h = await twoGraphs();
      // The expiry was shortened in another tab.
      const t = await stored("ci", { graphIds: [A], access: "write" });
      const first = await edit(h, t.id, { access: "write" }, [A, B]);
      expect(first.res.status).toBe(200);
      applied(await edit(h, t.id, { access: "write", expires_days: "10" }, [A]));
      const shortened = (await tokens().get(t.id))!;
      let before = await snap();
      const again = await h.page(`/tokens/${t.id}/edit`, confirmFields(first.html));
      await confirmShown(again, before, "expiry");
      expect(again.html).toContain(CHANGED);
      expect(decode(hidden(again.html, "base")!)).toBe(JSON.stringify({ graphIds: [A], access: "write", expiresAt: shortened.expiresAt }));
      expect(changes(again.html)).toEqual({ gains: [`gains read-write on other; ${EFFECTIVE}`], losses: [] });
      // Confirming the page shown now applies it and keeps the shorter expiry.
      applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(again.html)));
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [A, B], access: "write", expiresAt: shortened.expiresAt });

      // A graph was removed in another tab: the re-post now adds it back and raises, against the current row.
      const u = await stored("nightly", { graphIds: [A, B], access: "read" });
      const raise = await edit(h, u.id, { access: "write" }, [A, B]);
      expect(changes(raise.html).gains).toEqual([`gains read-write on my-work-graph`, `gains read-write on other; ${EFFECTIVE}`]);
      applied(await edit(h, u.id, { access: "read" }, [A]));
      before = await snap();
      const stale = await h.page(`/tokens/${u.id}/edit`, confirmFields(raise.html));
      await confirmShown(stale, before, "graphs");
      expect(stale.html).toContain(CHANGED);
      expect(changes(stale.html)).toEqual({ gains: [`gains read-write on other; ${EFFECTIVE}`, "gains read-write on my-work-graph"], losses: [] });
      expect((await tokens().get(u.id))!).toMatchObject({ graphIds: [A], access: "read" });
    });

    it("a confirming POST that carries a graph the page did not show applies exactly what it carries, and the audit row names both added graphs", async () => {
      const h = await twoGraphs();
      await store().add({ ...THIRD });
      const t = await stored("ci", { graphIds: [A], access: "read" });
      const page = await edit(h, t.id, { access: "read" }, [A, B]);
      expect(changes(page.html).gains).toEqual(["gains read-only on other"]);
      // The POST is the owner's own CSRF-checked form, so the gains are recomputed from it, not from the page.
      applied(await h.page(`/tokens/${t.id}/edit`, [...confirmFields(page.html), ["graph", C]]));
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [A, B, C], access: "read" });
      const [audit] = await auditRows();
      expect(JSON.parse(audit.before as string).data).toMatchObject({ added: [B, C], removed: [] });
    });

    it("widening a read-write token to a read-only graph says effective read only, and after confirming a write there is refused with the plain message (spec 8.9)", async () => {
      const h = await twoGraphs();
      answerPages();
      const { token } = await create(h, { name: "ci", access: "write" }, [A]);
      const id = (await rawRows())[0].id as string;
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await mcp(h, token, "tools/call", { name, arguments: args });
        expect(res.status).toBe(200);
        return {
          isError: res.json.result.isError === true,
          text: res.json.result.content.map((c: { text: string }) => c.text).join("\n"),
        };
      };
      const page = await edit(h, id, { access: "write" }, [A, B]);
      expect(page.res.status).toBe(200);
      expect(changes(page.html)).toEqual({ gains: [`gains read-write on other; ${EFFECTIVE}`], losses: [] });
      applied(await h.page(`/tokens/${id}/edit`, confirmFields(page.html)));
      expect(await call("update_block", { graph: "other", "block-id": PAGE_ID, body: { title: "x" } })).toEqual({
        isError: true,
        text: "graph 'other' is read-only",
      });
      expect((await call("get_page", { graph: "other", "page-id": PAGE_ID })).isError).toBe(false);
      expect((await call("update_block", { graph: "my-work-graph", "block-id": PAGE_ID, body: { title: "x" } })).text).not.toContain("is read-only");
      assertNoToken();
    });

    it("confirm fields do not hold back what already applies at once: a narrowing, a shorter expiry, or no change, with confirm=1 and any base", async () => {
      const h = await twoGraphs();
      const t = await stored("ci", { graphIds: [A, B], access: "write" });
      const stale = JSON.stringify({ graphIds: [B], access: "read", expiresAt: 1 });
      applied(await edit(h, t.id, { access: "read", confirm: "1", base: "not json" }, [A, B]), "write to read");
      applied(await edit(h, t.id, { access: "read", confirm: "1", base: stale }, [B]), "remove a graph");
      applied(await edit(h, t.id, { access: "read", confirm: "1", expires_days: "5" }, [B]), "shorter expiry");
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [B], access: "read" });
      expect(await auditRows()).toHaveLength(3);
      const before = await snap();
      applied(await edit(h, t.id, { access: "read", confirm: "1", base: stale }, [B]), "no change");
      expect(await snap()).toEqual(before);
    });

    it("expiry: shorter applies, the exact stored expiry is no change, an extension is refused naming the date, blank keeps it, and out-of-range days get the range message (spec 8.5)", async () => {
      const h = await twoGraphs();
      const T = Date.now();
      const t = await stored("ci", { graphIds: [A], access: "write", expiresAt: T + 30 * DAY });
      const clock = vi.spyOn(Date, "now").mockReturnValue(T);
      try {
        const before = await snap();
        // Exactly the stored expiry, blank, spaces and an omitted field: nothing else changed, so no change.
        for (const days of ["30", " 30 ", "", " "]) applied(await edit(h, t.id, { access: "write", expires_days: days }, [A]), days);
        applied(await edit(h, t.id, { access: "write" }, [A]), "omitted");
        expect(await snap()).toEqual(before);
        // An extension, by a day or by a millisecond, is refused naming the stored date; with a narrowing too.
        await refused(await edit(h, t.id, { access: "write", expires_days: "31" }, [A]), 400, extension(T + 30 * DAY), before, "31");
        await refused(await edit(h, t.id, { access: "read", expires_days: "365" }, [A]), 400, extension(T + 30 * DAY), before, "365");
        clock.mockReturnValue(T + 1);
        await refused(await edit(h, t.id, { access: "write", expires_days: "30" }, [A]), 400, extension(T + 30 * DAY), before, "1 ms");
        clock.mockReturnValue(T);
        for (const days of ["0", "366", "1.5", "-1", "ninety", "1e1", "0x1"]) {
          await refused(await edit(h, t.id, { access: "write", expires_days: days }, [A]), 400, RANGE, before, days);
        }
        // Shorter applies (padding trimmed); then blank with a narrowing keeps the shorter expiry.
        applied(await edit(h, t.id, { access: "write", expires_days: " 10 " }, [A]));
        expect((await tokens().get(t.id))!).toMatchObject({ expiresAt: T + 10 * DAY, access: "write" });
        applied(await edit(h, t.id, { access: "read", expires_days: "" }, [A]));
        expect((await tokens().get(t.id))!).toMatchObject({ expiresAt: T + 10 * DAY, access: "read" });
        applied(await edit(h, t.id, { access: "read", expires_days: "1" }, [A]));
        expect((await tokens().get(t.id))!.expiresAt).toBe(T + DAY);
        expect(await auditRows()).toHaveLength(3);
        // A re-send of a shortening a second later would move the expiry later, so it is refused and writes nothing.
        clock.mockReturnValue(T + 1000);
        const now = await snap();
        await refused(await edit(h, t.id, { access: "read", expires_days: "1" }, [A]), 400, extension(T + DAY), now, "re-send");
      } finally {
        clock.mockRestore();
      }
    });

    it("refusals: 404 unknown, 409 revoked, expired and previous owner on GET and POST, 400 field errors, 403 CSRF, 503 audit_log missing; each writes nothing (spec 8.6)", async () => {
      const h = await twoGraphs();
      const other = await harness();
      const ci = await stored("ci");
      const old = await stored("old");
      const revokedAt = Date.now() - 1000;
      await tokens().revoke(old.id, revokedAt);
      const lapsedAt = Date.now() - DAY;
      const lapsed = await stored("lapsed", { expiresAt: lapsedAt });
      const inherited = await stored("inherited", { ownerId: 2002, graphIds: [B] });
      const before = await snap();
      const dead: [string, number, string][] = [
        [crypto.randomUUID(), 404, "No service token has that id."],
        [old.id, 409, `Service token 'old' was revoked on ${day(revokedAt)}; it cannot be edited. Issue a new token.`],
        [lapsed.id, 409, `Service token 'lapsed' expired on ${day(lapsedAt)}; it cannot be edited. Issue a new token.`],
        [inherited.id, 409, "Service token 'inherited' belongs to a previous owner; it cannot be edited."],
      ];
      for (const [id, status, message] of dead) {
        for (const [method, page] of [
          ["GET", await h.page(`/tokens/${id}/edit`)],
          ["POST", await edit(h, id, { access: "read" }, [A])],
        ] as const) {
          await refused(page, status, message, before, `${method} ${message}`);
          expect(page.html, message).not.toContain(B);
          expect(page.html, message).not.toContain('name="graph"');
        }
      }
      const fields: [Record<string, string>, string[], string][] = [
        [{ access: "read" }, [], "graph: choose at least one graph."],
        [{ access: "read" }, ["33333333-3333-3333-3333-333333333333"], NOT_CONNECTED],
        [{ access: "read" }, [A, "my-work-graph"], NOT_CONNECTED],
        [{ access: "admin" }, [A], ACCESS],
        [{ access: "" }, [A], ACCESS],
        [{ access: "read", expires_days: "0" }, [A], RANGE],
      ];
      for (const [f, graphs, message] of fields) {
        await refused(await edit(h, ci.id, f, graphs), 400, message, before, JSON.stringify([f, graphs]));
      }
      // CSRF: none, another session's, and a JSON body.
      const path = `/tokens/${ci.id}/edit`;
      const form = editForm(h, { access: "read" }, [A]).filter(([k]) => k !== "csrf");
      expect((await h.page(path, form)).res.status).toBe(403);
      expect((await h.page(path, [["csrf", other.csrf], ...form])).res.status).toBe(403);
      expect((await h.call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
      expect(await snap()).toEqual(before);
      // audit_log missing: the probe answers "no such table", so nothing is changed.
      const missing = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (!sql.includes("audit_log")) return target.prepare(sql);
              const fail = () => Promise.reject(new Error("D1_ERROR: no such table: audit_log: SQLITE_ERROR"));
              return { bind() { return this; }, run: fail, all: fail };
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const h2 = await harness({ DB: missing });
      await refused(await edit(h2, ci.id, { access: "read" }, [A]), 503, "audit log is missing (apply migration 0004); nothing was changed.", before);
      assertNoToken();
    });

    it("owner only: no session, another account's session and an lsct_ bearer are sent to /login; no MCP tool reads or edits tokens (spec 8.7)", async () => {
      const h = await twoGraphs();
      const { id, token } = await stored("ci");
      const intruder = (await createSession(env, 2002)).split(";")[0];
      const before = await snap();
      for (const method of ["GET", "POST"]) {
        for (const headers of [{}, { Cookie: intruder }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
          const res = await bare(h, `/tokens/${id}/edit`, method, headers);
          expect(res.status, `${method} ${Object.keys(headers)}`).toBe(302);
          expect(res.headers.get("Location")).toBe("/login");
        }
      }
      expect(await snap()).toEqual(before);
      expect(committedManifest.map((t: { name: string }) => t.name).filter((name: string) => /token/.test(name))).toEqual([]);
    });

    it("an edit is not a rotation: the same lsct_ string still authenticates and token_hash is unchanged (spec 8.8)", async () => {
      const h = await twoGraphs();
      const { token } = await create(h, { name: "ci", access: "write" }, [A, B]);
      const [row] = await rawRows();
      expect(row.token_hash).toBe(await hashServiceToken(token));
      applied(await edit(h, row.id as string, { access: "read", expires_days: "7" }, [A]));
      const [after] = await rawRows();
      expect(after.token_hash).toBe(row.token_hash);
      expect(after.updated_at).not.toBeNull();
      const init = await mcp(h, token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(init.status).toBe(200);
      expect(init.json.result.serverInfo).toBeTruthy();
      expect((await mcp(h, token, "tools/list")).status).toBe(200);
    });

    it("the same graphs reordered or repeated, with nothing else changed, is no change; with a change the stored order follows the form and has no duplicate", async () => {
      const h = await twoGraphs();
      const t = await stored("ci", { graphIds: [A, B], access: "write" });
      const before = await snap();
      for (const graphs of [[A, B], [B, A], [A, A, B], [B, A, B, A]]) {
        applied(await edit(h, t.id, { access: "write" }, graphs), JSON.stringify(graphs));
      }
      expect(await snap()).toEqual(before);
      expect((await tokens().get(t.id))!.updatedAt).toBeNull();
      applied(await edit(h, t.id, { access: "read" }, [B, A]));
      expect((await tokens().get(t.id))!.graphIds).toEqual([B, A]);
      applied(await edit(h, t.id, { access: "read" }, [B, B]));
      expect((await tokens().get(t.id))!.graphIds).toEqual([B]);
      expect(await auditRows()).toHaveLength(2);
      // A re-send of the last narrowing is now no change.
      const after = await snap();
      applied(await edit(h, t.id, { access: "read" }, [B, B]));
      expect(await snap()).toEqual(after);
    });

    it("the audit row: token_edit, graph_id NULL, service:<name>, wizard, before and after in before.data; no token or hash in any column or body (spec 8.10)", async () => {
      const h = await twoGraphs();
      const { token, html: createPage } = await create(h, { name: "ci", access: "write" }, [A, B]);
      const [row] = await rawRows();
      const hash = row.token_hash as string;
      applied(await edit(h, row.id as string, { access: "read" }, [A]));
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        graph_id: null,
        alias: "service:ci",
        tool: "token_edit",
        kind: "write",
        status: "ok",
        client: "wizard",
        session: `github:${OWNER_ID}`,
        targets: null,
        addressed: null,
        pages: null,
      });
      const expiresAt = row.expires_at as number;
      expect(JSON.parse(audit[0].before as string)).toEqual({
        source: "service_tokens",
        data: {
          before: { graphIds: [A, B], access: "write", expiresAt },
          after: { graphIds: [A], access: "read", expiresAt },
          added: [],
          removed: [B],
        },
      });
      for (const [column, value] of Object.entries(audit[0])) {
        expect(String(value), column).not.toContain(token.slice(5));
        expect(String(value), column).not.toContain(hash);
      }
      for (const [column, value] of Object.entries((await rawRows())[0])) {
        expect(String(value), column).not.toContain(token.slice(5));
      }
      await h.page(`/tokens/${row.id}/edit`);
      await h.page("/tokens");
      const bodies = transcript.filter((text) => text !== createPage).join("\n");
      expect(bodies).not.toContain(token.slice(5));
      expect(bodies).not.toContain(hash);
    });

    it("a disconnect between the GET and the POST answers 409 revoked and keeps the old graphs (spec 8.11)", async () => {
      const h = await twoGraphs();
      const t = await stored("ci", { graphIds: [A, B], access: "write" });
      expect((await h.page(`/tokens/${t.id}/edit`)).res.status).toBe(200);
      expect((await h.page("/graphs/other/disconnect", { csrf: h.csrf })).res.status).toBe(200);
      const revoked = (await tokens().get(t.id))!;
      expect(revoked.revokedAt).not.toBeNull();
      const before = await snap();
      await refused(
        await edit(h, t.id, { access: "write" }, [A]),
        409,
        `Service token 'ci' was revoked on ${day(revoked.revokedAt!)}; it cannot be edited. Issue a new token.`,
        before,
      );
      expect((await tokens().get(t.id))!).toMatchObject({ graphIds: [A, B], revokedAt: revoked.revokedAt, updatedAt: null });
    });

    it("a token that expires between the GET and the POST is refused 409 expired", async () => {
      const h = await twoGraphs();
      const t = await stored("ci", { graphIds: [A, B], access: "write" });
      expect((await h.page(`/tokens/${t.id}/edit`)).res.status).toBe(200);
      const lapsedAt = Date.now() - 1;
      await env.DB.prepare("UPDATE service_tokens SET expires_at = ? WHERE id = ?").bind(lapsedAt, t.id).run();
      const before = await snap();
      await refused(
        await edit(h, t.id, { access: "read" }, [A]),
        409,
        `Service token 'ci' expired on ${day(lapsedAt)}; it cannot be edited. Issue a new token.`,
        before,
      );
    });

    it("a guard miss (the row changed between the load and the UPDATE) answers 409 saying why, and writes nothing", async () => {
      const cases: [string, string, (id: string) => string][] = [
        ["UPDATE service_tokens SET access = 'read' WHERE id = ?", "changed", () => "Service token 'ci' changed since you opened this page; reload and edit again."],
        ["UPDATE service_tokens SET graph_ids = '[\"" + B + "\",\"" + A + "\"]' WHERE id = ?", "reordered", () => "Service token 'ci' changed since you opened this page; reload and edit again."],
        ["UPDATE service_tokens SET revoked_at = 1800000000000 WHERE id = ?", "revoked", () => `Service token 'ci' was revoked on ${day(1_800_000_000_000)}; it cannot be edited. Issue a new token.`],
      ];
      for (const [interloper, label, message] of cases) {
        await env.DB.exec("DELETE FROM service_tokens");
        const t = await stored("ci", { graphIds: [A, B], access: "write" });
        let ran = false;
        // Runs the interloper once, just before the edit's UPDATE.
        const db = new Proxy(env.DB, {
          get(target, prop) {
            if (prop === "prepare") {
              return (sql: string) => {
                if (ran || !/UPDATE service_tokens\s+SET graph_ids/.test(sql)) return target.prepare(sql);
                return {
                  bind: (...values: unknown[]) => ({
                    run: async () => {
                      ran = true;
                      await target.prepare(interloper).bind(t.id).run();
                      return target.prepare(sql).bind(...values).run();
                    },
                  }),
                };
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const h = await twoGraphs({ DB: db });
        const page = await edit(h, t.id, { access: "write" }, [A]);
        expect(ran, label).toBe(true);
        expect(page.res.status, label).toBe(409);
        expect(shown(page.html), label).toBe(message(t.id));
        const row = (await tokens().get(t.id))!;
        expect(row.updatedAt, label).toBeNull();
        expect(row.graphIds, label).toHaveLength(2);
        expect(await auditRows(), label).toEqual([]);
        await env.DB.exec("DELETE FROM graphs");
      }
    });

    it("read-back: a stored row that differs from the form (test DB wrapper) revokes the token and answers 500 naming the field, with no audit row (spec 8.14)", async () => {
      let tamper: (row: Record<string, unknown>) => Record<string, unknown> | null = (r) => r;
      let updated = false;
      const m = meterTokens((sql, result) => {
        if (/SET graph_ids/.test(sql)) updated = true;
        if (!updated || !/FROM service_tokens WHERE id = \?/.test(sql)) return result;
        return { ...result, results: result.results.map((r) => tamper(r as Record<string, unknown>)).filter((r) => r !== null) } as D1Result;
      });
      const h = await twoGraphs({ DB: m.db });
      const tamperings: [string, (row: Record<string, unknown>) => Record<string, unknown> | null][] = [
        ["access", (r) => ({ ...r, access: "write" })],
        ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([B, A]) })],
        ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([A]) })],
        ["graph", (r) => ({ ...r, graph_ids: JSON.stringify([A, A]) })],
        ["expires_days", (r) => ({ ...r, expires_at: (r.expires_at as number) + 1 })],
        ["name", (r) => ({ ...r, name: "other-name" })],
        ["token", () => null],
      ];
      for (const [i, [field, change]] of tamperings.entries()) {
        const t = await stored(`rb-${i}`, { graphIds: [A, B], access: "write" });
        tamper = change;
        updated = false;
        const page = await edit(h, t.id, { access: "read" }, [A, B]);
        expect(updated, field).toBe(true);
        expect(page.res.status, field).toBe(500);
        expect(shown(page.html), field).toBe(`${field}: the stored token did not match the form, so it was revoked. Issue a new token.`);
        expect((await tokens().get(t.id))!.revokedAt, field).not.toBeNull();
        expect(await auditRows(), field).toEqual([]);
      }
    });

    it("cost: an applied narrowing reads about 3 + N rows and writes 3; a refusal writes none; a widening's first POST reads 1 + N and writes none, and its confirm costs what a narrowing does", async () => {
      // Every statement the edit routes run: the token row, the graph list and the audit log.
      const m = meterTokens(undefined, /service_tokens|audit_log|FROM graphs ORDER BY/);
      const h = await twoGraphs({ DB: m.db });
      const t = await stored("ci", { graphIds: [A, B], access: "write" });
      const total = () => ({
        read: m.measured.reduce((n, x) => n + x.read, 0),
        written: m.measured.reduce((n, x) => n + x.written, 0),
      });
      const N = 2;
      m.measured.length = 0;
      expect((await h.page(`/tokens/${t.id}/edit`)).res.status).toBe(200);
      expect(total()).toEqual({ read: 1 + N, written: 0 });
      m.measured.length = 0;
      applied(await edit(h, t.id, { access: "read" }, [A, B]));
      expect(total()).toEqual({ read: 3 + N, written: 3 });
      for (const [fields, graphs] of [
        [{ access: "admin" }, [A]],
        [{ access: "read", expires_days: "365" }, [A]],
      ] as [Record<string, string>, string[]][]) {
        m.measured.length = 0;
        expect((await edit(h, t.id, fields, graphs)).res.status).toBe(400);
        expect(total().written, JSON.stringify(fields)).toBe(0);
        expect(total().read, JSON.stringify(fields)).toBeLessThanOrEqual(1 + N);
      }
      m.measured.length = 0;
      const widen = await edit(h, t.id, { access: "write" }, [A, B]);
      expect(widen.res.status).toBe(200);
      expect(total()).toEqual({ read: 1 + N, written: 0 });
      m.measured.length = 0;
      applied(await h.page(`/tokens/${t.id}/edit`, confirmFields(widen.html)));
      expect(total()).toEqual({ read: 3 + N, written: 3 });
    });
  });
});
