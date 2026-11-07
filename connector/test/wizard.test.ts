import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createSession } from "../src/auth/session";
import { GraphStore } from "../src/graphs";
import { createConnector } from "../src/index";
import { SyncError, inspectToken, syncFetch } from "../src/sync";

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

async function harness() {
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
  const testEnv = { ...env, SYNC: sync } as Env;
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
  async function page(path: string, form?: Record<string, string>): Promise<{ res: Response; html: string }> {
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

const OTHER_RECORD = {
  alias: "other",
  graphId: OTHER_GRAPH_ID,
  graphName: "Other",
  mode: "read" as const,
  permission: "read" as const,
  expiresAt: null,
  token: OTHER_TOKEN,
};
