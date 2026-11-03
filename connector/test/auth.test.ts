import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { isOwner } from "../src/auth/github";
import { createSession } from "../src/auth/session";
import { isAllowedRedirectUri } from "../src/auth/redirect-uris";
import { createConnector, providerOptions } from "../src/index";

const ORIGIN = "https://mcp.example.com";
const OWNER_ID = 1001;
const CLIENT_REDIRECT = "http://localhost:3000/callback";

type GitHubCall = { url: string; init?: RequestInit };

/** A stub for github.com and api.github.com; nothing leaves the test. */
function stubGitHub(user: { id: number; login: string }) {
  const calls: GitHubCall[] = [];
  const githubFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("code") !== "good-code") return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: "gho_stub", token_type: "bearer", scope: "" });
    }
    if (url === "https://api.github.com/user") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer gho_stub");
      return Response.json(user);
    }
    throw new Error(`unexpected GitHub call: ${url}`);
  };
  return { calls, githubFetch };
}

/** Minimal cookie jar: keeps name=value pairs from Set-Cookie, drops cleared ones. */
class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const cleared = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  names(): string[] {
    return [...this.cookies.keys()];
  }
}

function harness(
  user = { id: OWNER_ID, login: "owner" },
  envOverride: Partial<Env> = {},
  githubFetch?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const github = stubGitHub(user);
  const worker = createConnector({ githubFetch: githubFetch ?? github.githubFetch });
  const testEnv = { ...env, ...envOverride } as Env;
  const jar = new Jar();
  async function call(path: string, init: RequestInit = {}, useJar = true, origin = ORIGIN): Promise<Response> {
    const headers = new Headers(init.headers);
    if (useJar && jar.header()) headers.set("Cookie", jar.header());
    const request = new Request(`${origin}${path}`, { ...init, headers, redirect: "manual" });
    const ctx = createExecutionContext();
    const res = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    if (useJar) jar.take(res);
    return res;
  }
  return { call, jar, github, testEnv };
}

async function s256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function register(call: ReturnType<typeof harness>["call"], redirectUris: string[]) {
  return call("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
}

/** Runs DCR → /authorize → consent → GitHub redirect, and returns what the callback needs. */
async function startAuthorization(h: ReturnType<typeof harness>) {
  const reg = await register(h.call, [CLIENT_REDIRECT]);
  expect(reg.status).toBe(201);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    state: "client-state",
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const consent = await h.call(`/authorize?${params}`);
  expect(consent.status).toBe(200);
  expect(consent.headers.get("X-Frame-Options")).toBe("DENY");
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();

  const approve = await h.call("/authorize", {
    method: "POST",
    body: new URLSearchParams({ handle: handle!, decision: "approve" }),
  });
  expect(approve.status).toBe(302);
  const githubUrl = new URL(approve.headers.get("Location")!);
  expect(githubUrl.origin + githubUrl.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(githubUrl.searchParams.get("client_id")).toBe("test-github-client-id");
  expect(githubUrl.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
  expect(githubUrl.searchParams.get("code_challenge_method")).toBe("S256");
  return { clientId, verifier, githubUrl };
}

async function grantKeysFor(userId: string): Promise<string[]> {
  const listed = await env.OAUTH_KV.list({ prefix: `grant:${userId}:` });
  return listed.keys.map((k) => k.name);
}

describe("protected resource", () => {
  it("unauthenticated POST /mcp returns 401 with WWW-Authenticate resource_metadata", async () => {
    const { call } = harness();
    const res = await call("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("protected resource metadata resource equals https://mcp.example.com/mcp", async () => {
    const { call } = harness();
    const res = await call("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://mcp.example.com/mcp");
    expect(body.authorization_servers).toEqual([ORIGIN]);
  });

  it("authorization server metadata advertises DCR and CIMD", async () => {
    const { call } = harness();
    const res = await call("/.well-known/oauth-authorization-server");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(body.client_id_metadata_document_supported).toBe(true);
  });

  it("a request for any other host gets 421 and nothing else happens", async () => {
    const { call } = harness();
    for (const [path, init] of [
      ["/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
      ["/.well-known/oauth-protected-resource/mcp", {}],
      ["/login", {}],
      ["/graphs", {}],
      ["/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ] as const) {
      const res = await call(path, init, false, "https://other.example.com");
      expect(res.status, path).toBe(421);
      expect(res.headers.get("Location"), path).toBeNull();
      expect(res.headers.getSetCookie(), path).toEqual([]);
    }
    // A different port on the right hostname is a different host too.
    expect((await call("/graphs", {}, false, "https://mcp.example.com:8443")).status).toBe(421);
  });

  it("GET /health answers for any host", async () => {
    const { call } = harness();
    const res = await call("/health", {}, false, "https://other.example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /health still answers", async () => {
    const { call } = harness();
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("redirect URI allow-list", () => {
  it("allows only claude.ai's callback and http loopback", () => {
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:3000/callback",
      "http://localhost/cb",
      "http://127.0.0.1:65535/a/b?x=1",
    ]) {
      expect(isAllowedRedirectUri(ok), ok).toBe(true);
    }
    for (const bad of [
      "https://evil.example/cb",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback?x=1",
      "https://claude.ai/other",
      "http://claude.ai/api/mcp/auth_callback",
      "https://localhost:3000/callback",
      "http://localhost.evil.example/cb",
      "http://user@localhost:3000/cb",
      "http://[::1]:3000/cb",
      "http://localhost:3000/cb#frag",
      "not a url",
    ]) {
      expect(isAllowedRedirectUri(bad), bad).toBe(false);
    }
  });

  it("rejects redirect_uri outside allow-list at /register", async () => {
    const { call } = harness();
    const res = await register(call, ["https://evil.example/cb"]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects /register when any one redirect_uri is outside the allow-list", async () => {
    const { call } = harness();
    const res = await register(call, ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"]);
    expect(res.status).toBe(400);
  });

  it("accepts claude.ai's callback at /register", async () => {
    const { call } = harness();
    const res = await register(call, ["https://claude.ai/api/mcp/auth_callback"]);
    expect(res.status).toBe(201);
  });

  it("rejects a client whose redirect_uri is outside the allow-list at /authorize, without redirecting", async () => {
    const { call, testEnv } = harness();
    // A client that bypassed DCR (as a CIMD document could): created directly in storage.
    const oauth = getOAuthApi(providerOptions("mcp.example.com", fetch), testEnv);
    const client = await oauth.createClient({
      redirectUris: ["https://evil.example/cb"],
      tokenEndpointAuthMethod: "none",
      clientName: "Evil",
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "https://evil.example/cb",
      state: "s",
      code_challenge: await s256("verifier-verifier-verifier-verifier-verifier"),
      code_challenge_method: "S256",
    });
    const res = await call(`/authorize?${params}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).not.toContain('name="handle"');
  });
});

describe("GitHub sign-in for MCP authorization", () => {
  it("owner GitHub id completes authorization and receives a code", async () => {
    const h = harness();
    const { githubUrl } = await startAuthorization(h);
    const callback = await h.call(
      `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`,
    );
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("code")).toMatch(/^1001:/);
    expect(back.searchParams.get("state")).toBe("client-state");

    // PKCE towards GitHub: the verifier sent at the token exchange matches the challenge.
    const tokenCall = h.github.calls.find((c) => c.url === "https://github.com/login/oauth/access_token")!;
    const sent = new URLSearchParams(String(tokenCall.init?.body));
    expect(sent.get("client_secret")).toBe("test-github-client-secret");
    expect(sent.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(await s256(sent.get("code_verifier")!)).toBe(githubUrl.searchParams.get("code_challenge"));
    // An MCP grant is not a wizard session.
    expect(callback.headers.getSetCookie().some((c) => c.startsWith("__Host-connector-session="))).toBe(false);
  });

  it("the issued token reaches the connector_help tool at /mcp", async () => {
    const h = harness();
    const { clientId, verifier, githubUrl } = await startAuthorization(h);
    const callback = await h.call(
      `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`,
    );
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const tokenRes = await h.call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

    const mcp = await h.call(
      "/mcp",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "connector_help", arguments: {} },
        }),
      },
      false,
    );
    expect(mcp.status).toBe(200);
    const text = await mcp.text();
    expect(text).toContain("insert_block_tree");
  });

  it("second GitHub account is refused at /callback with 403 and no code or session issued", async () => {
    const h = harness({ id: 2002, login: "intruder" });
    const { githubUrl } = await startAuthorization(h);
    const callback = await h.call(
      `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`,
    );
    expect(callback.status).toBe(403);
    expect(callback.headers.get("Location")).toBeNull();
    const body = await callback.text();
    expect(body).not.toContain("code=");
    expect(callback.headers.getSetCookie().some((c) => c.startsWith("__Host-connector-session="))).toBe(false);
    expect(await grantKeysFor("2002")).toEqual([]);
  });

  it("a replayed GitHub callback state is refused", async () => {
    const h = harness();
    const { githubUrl } = await startAuthorization(h);
    const query = `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`;
    expect((await h.call(query)).status).toBe(302);
    const replay = await h.call(query);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("Location")).toBeNull();
  });

  it("a failed GitHub token exchange issues no code", async () => {
    const h = harness();
    const { githubUrl } = await startAuthorization(h);
    const res = await h.call(
      `/callback?${new URLSearchParams({ code: "bad-code", state: githubUrl.searchParams.get("state")! })}`,
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).not.toContain("bad_verification_code");
  });

  it("a non-JSON GitHub response gives a clean 502 and logs nothing from it", async () => {
    const leak = "<html>secret-github-body</html>";
    const h = harness(undefined, {}, async () => new Response(leak, { status: 200 }));
    const { githubUrl } = await startAuthorization(h);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    try {
      const res = await h.call(
        `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`,
      );
      expect(res.status).toBe(502);
      expect(res.headers.get("Location")).toBeNull();
      expect(await res.text()).not.toContain("secret-github-body");
      const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
      expect(logged.join("\n")).not.toContain("secret-github-body");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("a GitHub network error gives a clean 502", async () => {
    const h = harness(undefined, {}, async () => {
      throw new TypeError("network down: secret-network-detail");
    });
    const { githubUrl } = await startAuthorization(h);
    const res = await h.call(
      `/callback?${new URLSearchParams({ code: "good-code", state: githubUrl.searchParams.get("state")! })}`,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret-network-detail");
  });

  it("a non-form POST /authorize is a 400 bad request page", async () => {
    const { call } = harness();
    for (const init of [
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "x" }) },
      { method: "POST", body: "handle=x" , headers: { "Content-Type": "text/plain" } },
      { method: "POST" },
    ]) {
      const res = await call("/authorize", init);
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    }
  });

  it("GitHub error at the callback returns access_denied to the client", async () => {
    const h = harness();
    const { githubUrl } = await startAuthorization(h);
    const res = await h.call(
      `/callback?${new URLSearchParams({ error: "access_denied", state: githubUrl.searchParams.get("state")! })}`,
    );
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });
});

describe("owner allow-list", () => {
  it("isOwner compares numeric ids", () => {
    expect(isOwner(1001, env)).toBe(true);
    expect(isOwner(1002, env)).toBe(false);
  });

  it("isOwner throws when OWNER_GITHUB_USER_ID is not a positive integer", () => {
    for (const bad of ["", "abc", "0", "-5", "1.5", "1e3", " 1001", "99999999999999999999"]) {
      expect(() => isOwner(1001, { ...env, OWNER_GITHUB_USER_ID: bad }), bad).toThrow();
    }
  });

  it("an invalid OWNER_GITHUB_USER_ID fails closed with a generic 500", async () => {
    for (const bad of ["abc", "0", "-1"]) {
      const h = harness(undefined, { OWNER_GITHUB_USER_ID: bad });
      for (const path of ["/login", "/authorize", "/callback?code=x&state=login.y", "/graphs"]) {
        const res = await h.call(path);
        expect(res.status, `${bad} ${path}`).toBe(500);
        const text = await res.text();
        expect(text).not.toContain(bad);
        expect(text).not.toContain("OWNER_GITHUB_USER_ID");
      }
    }
  });
});

describe("connector config", () => {
  it("an invalid CONNECTOR_HOSTNAME or GRAPH_TOKEN_KEY fails closed with a generic 500", async () => {
    const cases: [keyof Env, string][] = [
      ["CONNECTOR_HOSTNAME", ""],
      ["CONNECTOR_HOSTNAME", "MCP.example.com"],
      ["CONNECTOR_HOSTNAME", "https://mcp.example.com"],
      ["CONNECTOR_HOSTNAME", "mcp.example.com/"],
      ["CONNECTOR_HOSTNAME", "mcp.example.com:443"],
      ["CONNECTOR_HOSTNAME", "mcp.example.com."],
      ["CONNECTOR_HOSTNAME", "localhost"],
      ["CONNECTOR_HOSTNAME", "-mcp.example.com"],
      ["CONNECTOR_HOSTNAME", "mcp..example.com"],
      ["GRAPH_TOKEN_KEY", ""],
      ["GRAPH_TOKEN_KEY", "00".repeat(31)],
      ["GRAPH_TOKEN_KEY", "zz".repeat(32)],
    ];
    for (const [name, bad] of cases) {
      const h = harness(undefined, { [name]: bad });
      for (const path of ["/login", "/graphs", "/mcp"]) {
        const res = await h.call(path, {}, false);
        expect(res.status, `${name}=${bad} ${path}`).toBe(500);
        const text = await res.text();
        expect(text).not.toContain(name);
        if (bad !== "") expect(text).not.toContain(bad);
      }
    }
  });
});

describe("wizard session", () => {
  it("/graphs without session redirects to /login", async () => {
    const { call } = harness();
    const res = await call("/graphs");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("/graphs with a tampered session cookie redirects to /login", async () => {
    const { call } = harness();
    const cookie = (await createSession(env, OWNER_ID)).split(";")[0];
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    const res = await call("/graphs", { headers: { Cookie: tampered } }, false);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("/graphs refuses a session sealed for another GitHub account", async () => {
    const { call } = harness();
    const cookie = (await createSession(env, 2002)).split(";")[0];
    const res = await call("/graphs", { headers: { Cookie: cookie } }, false);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("/graphs refuses a session older than 8 h", async () => {
    const { call } = harness();
    const cookie = (await createSession(env, OWNER_ID)).split(";")[0];
    const later = Date.now() + 8 * 60 * 60 * 1000 + 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const res = await call("/graphs", { headers: { Cookie: cookie } }, false);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/login");
    } finally {
      spy.mockRestore();
    }
  });

  it("session cookie is HttpOnly, Secure, SameSite=Lax with an 8 h lifetime", async () => {
    const setCookie = await createSession(env, OWNER_ID);
    expect(setCookie).toMatch(/^__Host-connector-session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=28800");
  });

  it("/login → GitHub → /callback signs the owner in to /graphs", async () => {
    const h = harness();
    const grantsBefore = await grantKeysFor(String(OWNER_ID));
    const login = await h.call("/login");
    expect(login.status).toBe(302);
    const githubUrl = new URL(login.headers.get("Location")!);
    expect(githubUrl.origin + githubUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    const state = githubUrl.searchParams.get("state")!;
    expect(state.startsWith("login.")).toBe(true);

    const callback = await h.call(`/callback?${new URLSearchParams({ code: "good-code", state })}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/graphs");
    expect(h.jar.names()).toContain("__Host-connector-session");

    const graphs = await h.call("/graphs");
    expect(graphs.status).toBe(200);
    expect(await graphs.text()).toContain("<h1>Connected graphs</h1>");
    // Signing in to the wizard issues no OAuth grant (KV is shared across tests in this file).
    expect(await grantKeysFor(String(OWNER_ID))).toEqual(grantsBefore);
  });

  it("a non-owner wizard sign-in is refused with 403 and no session", async () => {
    const h = harness({ id: 2002, login: "intruder" });
    const login = await h.call("/login");
    const state = new URL(login.headers.get("Location")!).searchParams.get("state")!;
    const callback = await h.call(`/callback?${new URLSearchParams({ code: "good-code", state })}`);
    expect(callback.status).toBe(403);
    expect(h.jar.names()).not.toContain("__Host-connector-session");
  });

  it("a wizard callback whose state does not match the login cookie is refused", async () => {
    const h = harness();
    await h.call("/login");
    const callback = await h.call(`/callback?${new URLSearchParams({ code: "good-code", state: "login.forged" })}`);
    expect(callback.status).toBe(400);
    expect(h.jar.names()).not.toContain("__Host-connector-session");
    expect(h.github.calls).toEqual([]);
  });

  it("CSRF token required on POST", async () => {
    const h = harness();
    const cookie = (await createSession(env, OWNER_ID)).split(";")[0];
    const page = await h.call("/graphs", { headers: { Cookie: cookie } }, false);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
    expect(csrf).toBeTruthy();

    const missing = await h.call("/logout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams() }, false);
    expect(missing.status).toBe(403);
    const wrong = await h.call(
      "/logout",
      { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf: "x".repeat(csrf!.length) }) },
      false,
    );
    expect(wrong.status).toBe(403);

    // Another session's token does not carry over.
    const otherCookie = (await createSession(env, OWNER_ID)).split(";")[0];
    const crossed = await h.call(
      "/logout",
      { method: "POST", headers: { Cookie: otherCookie }, body: new URLSearchParams({ csrf: csrf! }) },
      false,
    );
    expect(crossed.status).toBe(403);

    const ok = await h.call("/logout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf: csrf! }) }, false);
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => /^__Host-connector-session=;.*Max-Age=0/.test(c))).toBe(true);
  });
});
