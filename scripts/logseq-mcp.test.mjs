import { test as nodeTest } from "node:test";

/** Every test fails after 20 s rather than hanging on a CLI that waits forever. */
const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "logseq-mcp.mjs");

/** A token in the real shape (`lsct_` + 43 base64url characters). Not a real secret. */
const TOKEN = "lsct_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const SESSION = "session-abc-123";

/**
 * A stub MCP server on 127.0.0.1. `onCall(rpc, req, res)` answers `tools/call`; `initialize` and
 * the initialized notification get the usual answers, with `mcp-session-id: SESSION` set on
 * initialize. Every request is recorded with its headers and JSON-RPC body.
 */
async function stub(onCall, { onInitialize } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, headers: req.headers, rpc });
    if (onInitialize && rpc?.method === "initialize") return onInitialize(rpc, req, res);
    if (rpc?.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": SESSION });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } },
        }),
      );
      return;
    }
    if (rpc?.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    return onCall(rpc, req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const close = () =>
    new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
  return { url, requests, close };
}

/** Run the CLI asynchronously (the stub runs in this process, so spawnSync would deadlock). */
function run(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const textResult = (id, text, isError = false) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
});

/** Asserts the token appears in neither stream. */
function assertNoToken(out, label) {
  assert.ok(!out.stdout.includes(TOKEN), `${label}: token in stdout: ${out.stdout}`);
  assert.ok(!out.stderr.includes(TOKEN), `${label}: token in stderr: ${out.stderr}`);
}

test("calls a tool, prints its text, sends Bearer, initialize first and echoes mcp-session-id", async () => {
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "work (read-write)\nnotes (read)")));
  try {
    const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: s.url });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "work (read-write)\nnotes (read)\n");
    assertNoToken(out, "success");

    assert.deepEqual(
      s.requests.map((r) => r.rpc.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    for (const r of s.requests) {
      assert.equal(r.method, "POST");
      assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
      assert.match(r.headers.accept, /application\/json/);
      assert.match(r.headers.accept, /text\/event-stream/);
    }
    assert.equal(s.requests[0].headers["mcp-session-id"], undefined, "initialize carries no session yet");
    assert.equal(s.requests[1].headers["mcp-session-id"], SESSION);
    assert.equal(s.requests[2].headers["mcp-session-id"], SESSION);
    assert.deepEqual(s.requests[2].rpc.params, { name: "list_graphs", arguments: {} });
  } finally {
    await s.close();
  }
});

test("passes JSON args through and sends no session header when the server sets none", async () => {
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "page body")), {
    onInitialize: (rpc, _req, res) =>
      json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }),
  });
  try {
    const out = await run(["get_page", '{"graph":"work","page":"Inbox"}'], {
      LOGSEQ_SERVICE_TOKEN: TOKEN,
      LOGSEQ_MCP_URL: s.url,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "page body\n");
    assert.deepEqual(s.requests[2].rpc.params, { name: "get_page", arguments: { graph: "work", page: "Inbox" } });
    for (const r of s.requests) assert.equal(r.headers["mcp-session-id"], undefined);
  } finally {
    await s.close();
  }
});

test("parses SSE responses, including an event split across writes and CRLF lines", async () => {
  const sse = (res) => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const cases = {
    "one write": (rpc, _req, res) => {
      sse(res);
      res.end(`event: message\ndata: ${JSON.stringify(textResult(rpc.id, "from sse"))}\n\n`);
    },
    "split mid-JSON": (rpc, _req, res) => {
      sse(res);
      const event = `event: message\ndata: ${JSON.stringify(textResult(rpc.id, "from sse"))}\n\n`;
      const cut = Math.floor(event.length / 2);
      res.write(event.slice(0, cut));
      setTimeout(() => res.end(event.slice(cut)), 50);
    },
    "split between the newlines, CRLF, a notification first": (rpc, _req, res) => {
      sse(res);
      res.write(`: keep-alive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\r\n\r\n`);
      res.write(`id: 7\r\nevent: message\r\ndata: ${JSON.stringify(textResult(rpc.id, "from sse"))}\r\n`);
      setTimeout(() => res.end("\r\n"), 50);
    },
    "data split over two data lines": (rpc, _req, res) => {
      sse(res);
      const body = JSON.stringify(textResult(rpc.id, "from sse"));
      const cut = body.indexOf(",");
      res.end(`data: ${body.slice(0, cut)}\ndata: ${body.slice(cut)}\n\n`);
    },
    "stream left open after the answer": (rpc, _req, res) => {
      sse(res);
      res.write(`data: ${JSON.stringify(textResult(rpc.id, "from sse"))}\n\n`);
      const timer = setTimeout(() => res.end(), 10_000);
      res.on("close", () => clearTimeout(timer));
    },
  };
  for (const [label, onCall] of Object.entries(cases)) {
    const s = await stub(onCall);
    try {
      const started = Date.now();
      const out = await run(["search_graph", '{"graph":"work","query":"x"}'], {
        LOGSEQ_SERVICE_TOKEN: TOKEN,
        LOGSEQ_MCP_URL: s.url,
      });
      assert.ok(Date.now() - started < 5_000, `${label}: stops reading once the answer arrives`);
      assert.equal(out.status, 0, `${label}: ${out.stderr}`);
      assert.equal(out.stdout, "from sse\n", label);
    } finally {
      await s.close();
    }
  }
});

test("an SSE initialize answer is parsed too", async () => {
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "ok")), {
    onInitialize: (rpc, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": SESSION });
      const event = `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: {} } })}\n\n`;
      res.write(event.slice(0, 10));
      setTimeout(() => res.end(event.slice(10)), 30);
    },
  });
  try {
    const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: s.url });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "ok\n");
    assert.equal(s.requests[2].headers["mcp-session-id"], SESSION);
  } finally {
    await s.close();
  }
});

/** Failure cases, each answering the server's message; `echo` cases put the bearer in the error. */
const failures = [
  {
    label: "401 with a JSON error_description",
    onCall: (_rpc, _req, res) =>
      json(res, 401, { error: "invalid_token", error_description: "service token 'ci' was revoked" }, {
        "www-authenticate": 'Bearer error="invalid_token"',
      }),
    expect: [/401/, /service token 'ci' was revoked/],
  },
  {
    label: "401 on initialize",
    onInitialize: (_rpc, _req, res) =>
      json(res, 401, { error: "invalid_token", error_description: "service token 'ci' expired on 2026-10-01" }),
    expect: [/401/, /expired on 2026-10-01/],
    calls: 1,
  },
  {
    label: "500 with a plain-text body",
    onCall: (_rpc, _req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal failure");
    },
    expect: [/500/, /internal failure/],
  },
  {
    label: "a JSON-RPC error",
    onCall: (rpc, _req, res) =>
      json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "Unknown tool: nope" } }),
    expect: [/-32602/, /Unknown tool: nope/],
  },
  {
    label: "a tool result with isError",
    onCall: (rpc, _req, res) =>
      json(res, 200, textResult(rpc.id, "graph 'work' is read-only (service token 'ci' is read-only)", true)),
    expect: [/graph 'work' is read-only \(service token 'ci' is read-only\)/],
  },
  {
    label: "a JSON-RPC error inside SSE",
    onCall: (rpc, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "boom" } })}\n\n`);
    },
    expect: [/boom/],
  },
  {
    label: "an SSE stream that ends without the answer",
    onCall: (_rpc, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`);
    },
    expect: [/no answer/i],
  },
  {
    label: "a body that is not JSON",
    onCall: (_rpc, _req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>proxy</html>");
    },
    expect: [/not JSON/i],
  },
  {
    label: "401 echoing the bearer in error_description",
    onCall: (_rpc, req, res) =>
      json(res, 401, { error: "invalid_token", error_description: `bad header: ${req.headers.authorization}` }),
    expect: [/401/, /bad header: Bearer lsct_…/],
  },
  {
    label: "a JSON-RPC error echoing the bearer",
    onCall: (rpc, req, res) =>
      json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: `saw ${req.headers.authorization} twice: ${TOKEN}` } }),
    expect: [/saw Bearer lsct_… twice: lsct_…/],
  },
  {
    label: "a plain-text 403 echoing the bearer",
    onCall: (_rpc, req, res) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`forbidden for ${req.headers.authorization}`);
    },
    expect: [/403/, /forbidden for Bearer lsct_…/],
  },
];

test("failures exit 1 with the status and the server's message, and never print the token", async () => {
  for (const f of failures) {
    const s = await stub(f.onCall, { onInitialize: f.onInitialize });
    try {
      const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: s.url });
      assert.equal(out.status, 1, `${f.label}: status ${out.status}, stderr ${out.stderr}`);
      for (const re of f.expect) assert.match(out.stderr, re, f.label);
      assert.equal(out.stdout, "", `${f.label}: nothing on stdout`);
      assertNoToken(out, f.label);
      if (f.calls) assert.equal(s.requests.length, f.calls, `${f.label}: stops after the failure`);
    } finally {
      await s.close();
    }
  }
});

/** True when stdout or stderr holds 10 or more characters of the token's secret part in a row. */
function leaksTokenPrefix(out, token) {
  const secret = token.replace(/^lsct_/, "");
  for (let i = 0; i + 10 <= secret.length; i++) {
    const piece = secret.slice(i, i + 10);
    if (out.stdout.includes(piece) || out.stderr.includes(piece)) return true;
  }
  return false;
}

test("a long non-JSON body is redacted before it is cut, so a bearer at the cut leaks no part of the token", async () => {
  // The bearer starts at character 471 and runs past character 500, where the message is cut.
  const echo = (req) => `${"x".repeat(470)} ${req.headers.authorization} ${"z".repeat(100)} more`;
  const cases = {
    "502 with a text body": (_rpc, req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end(echo(req));
    },
    "200 whose body is not JSON": (_rpc, req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(echo(req));
    },
    "SSE whose data is not JSON": (_rpc, req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${echo(req)}\n\n`);
    },
  };
  // A token in the service-token shape, and one that is not (so only the token's own value redacts it).
  const tokens = { shaped: TOKEN, unshaped: "plain-secret-" + "Q".repeat(40) };
  const runs = Object.entries(tokens).flatMap(([kind, token]) =>
    Object.entries(cases).map(([label, onCall]) => [`${label}, ${kind} token`, token, onCall]),
  );
  for (const [label, token, onCall] of runs) {
    const s = await stub(onCall);
    try {
      const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: token, LOGSEQ_MCP_URL: s.url });
      assert.equal(out.status, 1, `${label}: ${out.stderr}`);
      assert.ok(!leaksTokenPrefix(out, token), `${label}: part of the token printed: ${out.stderr}`);
      assert.match(out.stderr, /Bearer lsct_…/, `${label}: the bearer is masked`);
      assert.match(out.stderr, /…\n$/, `${label}: the message is cut short`);
      assert.doesNotMatch(out.stderr, / more/, `${label}: text past the cut is not printed`);
    } finally {
      await s.close();
    }
  }
});

test("a body of 2,000 characters is cut to 500", async () => {
  const s = await stub((_rpc, _req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("y".repeat(2000));
  });
  try {
    const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: s.url });
    assert.equal(out.status, 1);
    assert.equal(out.stderr, `tools/call: HTTP 502: ${"y".repeat(500)}…\n`);
  } finally {
    await s.close();
  }
});

test("the server comes from LOGSEQ_MCP_URL, else https://$LOGSEQ_MCP_HOST/mcp as in .mcp.json, else the default", async () => {
  // Port 9 on 127.0.0.1 has nothing listening, so each run fails naming the URL it tried.
  const cases = [
    { label: "host only", env: { LOGSEQ_MCP_HOST: "127.0.0.1:9" }, url: "https://127.0.0.1:9/mcp" },
    { label: "host with spaces", env: { LOGSEQ_MCP_HOST: " 127.0.0.1:9 " }, url: "https://127.0.0.1:9/mcp" },
    {
      label: "URL wins over host",
      env: { LOGSEQ_MCP_HOST: "127.0.0.1:9", LOGSEQ_MCP_URL: "http://127.0.0.1:9/other" },
      url: "http://127.0.0.1:9/other",
    },
    { label: "blank URL falls back to host", env: { LOGSEQ_MCP_HOST: "127.0.0.1:9", LOGSEQ_MCP_URL: "  " }, url: "https://127.0.0.1:9/mcp" },
    { label: "empty URL falls back to host", env: { LOGSEQ_MCP_HOST: "127.0.0.1:9", LOGSEQ_MCP_URL: "" }, url: "https://127.0.0.1:9/mcp" },
  ];
  for (const c of cases) {
    const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, ...c.env });
    assert.equal(out.status, 1, `${c.label}: ${out.stderr}`);
    assert.ok(out.stderr.startsWith(`initialize: cannot reach ${c.url}: `), `${c.label}: ${out.stderr}`);
    assertNoToken(out, c.label);
  }
  const { serverUrl } = await import("./logseq-mcp.mjs");
  assert.equal(serverUrl({}), "https://mcp.example.com/mcp", "neither set: the default, like .mcp.json");
  assert.equal(serverUrl({ LOGSEQ_MCP_HOST: "" }), "https://mcp.example.com/mcp", "an empty host: the default");
  assert.equal(serverUrl({ LOGSEQ_MCP_HOST: "mcp.home.example" }), "https://mcp.home.example/mcp");
});

test("a non-https LOGSEQ_MCP_URL is refused before the token is sent, except on localhost", async () => {
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "ok")));
  // 127.0.0.2 is not one of the allowed loopback names, so the stub would see the bearer if it went out.
  const plain = s.url.replace("127.0.0.1", "127.0.0.2");
  try {
    for (const url of [plain, "ftp://127.0.0.2/mcp", "not a url"]) {
      const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: url });
      assert.equal(out.status, 2, `${url}: ${out.stderr}`);
      assert.match(out.stderr, /LOGSEQ_MCP_URL must be an https:\/\/ URL/, url);
      assertNoToken(out, url);
    }
  } finally {
    await s.close();
  }
  assert.equal(s.requests.length, 0, "nothing reached a server");
  const { serverUrl } = await import("./logseq-mcp.mjs");
  assert.equal(serverUrl({ LOGSEQ_MCP_URL: "http://127.0.0.1:8787/mcp" }), "http://127.0.0.1:8787/mcp", "localhost may use http");
  assert.equal(serverUrl({ LOGSEQ_MCP_URL: "http://localhost:8787/mcp" }), "http://localhost:8787/mcp");
  assert.equal(serverUrl({ LOGSEQ_MCP_URL: "https://mcp.example.com/mcp" }), "https://mcp.example.com/mcp");
});

test("a server that cannot be reached exits 1", async () => {
  const s = await stub(() => {});
  const url = s.url;
  await s.close();
  const out = await run(["list_graphs"], { LOGSEQ_SERVICE_TOKEN: TOKEN, LOGSEQ_MCP_URL: url });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /127\.0\.0\.1/);
  assertNoToken(out, "unreachable");
});

test("the token inside JSON args, echoed in the tool's text, is redacted on stdout", async () => {
  const s = await stub((rpc, _req, res) =>
    json(res, 200, textResult(rpc.id, `you sent ${JSON.stringify(rpc.params.arguments)}\nand ${TOKEN}`)),
  );
  try {
    const out = await run(["search_graph", JSON.stringify({ graph: "work", query: TOKEN })], {
      LOGSEQ_SERVICE_TOKEN: TOKEN,
      LOGSEQ_MCP_URL: s.url,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, `you sent {"graph":"work","query":"lsct_…"}\nand lsct_…\n`);
    assertNoToken(out, "token in args");
  } finally {
    await s.close();
  }
});

test("the token inside JSON args is redacted when the call fails as well", async () => {
  const s = await stub((rpc, _req, res) =>
    json(res, 200, textResult(rpc.id, `no page named ${rpc.params.arguments.page}`, true)),
  );
  try {
    const out = await run(["get_page", JSON.stringify({ graph: "work", page: TOKEN })], {
      LOGSEQ_SERVICE_TOKEN: TOKEN,
      LOGSEQ_MCP_URL: s.url,
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /no page named lsct_…/);
    assertNoToken(out, "token in args, failing");
  } finally {
    await s.close();
  }
});

test("usage errors exit 2, name LOGSEQ_SERVICE_TOKEN and send nothing", async () => {
  // The stub answers, so a CLI that sends anyway exits 0 here rather than hanging.
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "sent")));
  try {
    const cases = [
      { label: "no token", args: ["list_graphs"], env: {} },
      { label: "empty token", args: ["list_graphs"], env: { LOGSEQ_SERVICE_TOKEN: "" } },
      { label: "blank token", args: ["list_graphs"], env: { LOGSEQ_SERVICE_TOKEN: "  " } },
      { label: "no tool", args: [], env: { LOGSEQ_SERVICE_TOKEN: TOKEN } },
      { label: "args not JSON", args: ["get_page", "{graph: work}"], env: { LOGSEQ_SERVICE_TOKEN: TOKEN } },
      { label: "args not an object", args: ["get_page", "[1,2]"], env: { LOGSEQ_SERVICE_TOKEN: TOKEN } },
      { label: "args null", args: ["get_page", "null"], env: { LOGSEQ_SERVICE_TOKEN: TOKEN } },
      { label: "too many arguments", args: ["get_page", "{}", "extra"], env: { LOGSEQ_SERVICE_TOKEN: TOKEN } },
      {
        label: "args not JSON, holding the token",
        args: ["get_page", `{page: ${TOKEN}}`],
        env: { LOGSEQ_SERVICE_TOKEN: TOKEN },
      },
    ];
    for (const c of cases) {
      const out = await run(c.args, { LOGSEQ_MCP_URL: s.url, ...c.env });
      assert.equal(out.status, 2, `${c.label}: ${out.stderr}`);
      assert.match(out.stderr, /usage: node scripts\/logseq-mcp\.mjs <tool> \['<json args>'\]/, c.label);
      assert.match(out.stderr, /LOGSEQ_SERVICE_TOKEN/, c.label);
      assert.equal(out.stdout, "", c.label);
      assertNoToken(out, c.label);
    }
    assert.equal(s.requests.length, 0, "no request was sent");
  } finally {
    await s.close();
  }
});

test("LOGSEQ_TOKEN_FROM_PROXY=1 with no token calls the tool with no Authorization header, for the proxy to add", async () => {
  // A cloud environment can hold the token as a network secret: its proxy adds the bearer to
  // requests for the connector's host, so the session never sees the token.
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "work (read-write)")));
  try {
    const out = await run(["list_graphs"], {
      LOGSEQ_TOKEN_FROM_PROXY: "1",
      NODE_USE_ENV_PROXY: "1",
      LOGSEQ_MCP_URL: s.url,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "work (read-write)\n");
    assert.deepEqual(
      s.requests.map((r) => r.rpc.method),
      ["initialize", "notifications/initialized", "tools/call"],
    );
    for (const r of s.requests) assert.equal(r.headers.authorization, undefined, `${r.rpc.method} sent an Authorization header`);
  } finally {
    await s.close();
  }
});

test("a token in LOGSEQ_SERVICE_TOKEN is still sent when LOGSEQ_TOKEN_FROM_PROXY=1", async () => {
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "ok")));
  try {
    const out = await run(["list_graphs"], {
      LOGSEQ_SERVICE_TOKEN: TOKEN,
      LOGSEQ_TOKEN_FROM_PROXY: "1",
      LOGSEQ_MCP_URL: s.url,
    });
    assert.equal(out.status, 0, out.stderr);
    for (const r of s.requests) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
    assertNoToken(out, "token and proxy flag");
  } finally {
    await s.close();
  }
});

test("LOGSEQ_TOKEN_FROM_PROXY=1 without NODE_USE_ENV_PROXY=1 exits 2 naming it and sends nothing", async () => {
  // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1, so the request would bypass the
  // proxy that adds the token. Values other than "1" do not turn proxy mode on.
  const s = await stub((rpc, _req, res) => json(res, 200, textResult(rpc.id, "sent")));
  try {
    const cases = [
      { label: "no NODE_USE_ENV_PROXY", env: { LOGSEQ_TOKEN_FROM_PROXY: "1" }, expect: /NODE_USE_ENV_PROXY=1/ },
      {
        label: "NODE_USE_ENV_PROXY=0",
        env: { LOGSEQ_TOKEN_FROM_PROXY: "1", NODE_USE_ENV_PROXY: "0" },
        expect: /NODE_USE_ENV_PROXY=1/,
      },
      { label: "flag not 1", env: { LOGSEQ_TOKEN_FROM_PROXY: "true", NODE_USE_ENV_PROXY: "1" }, expect: /LOGSEQ_TOKEN_FROM_PROXY=1/ },
    ];
    for (const c of cases) {
      const out = await run(["list_graphs"], { LOGSEQ_MCP_URL: s.url, ...c.env });
      assert.equal(out.status, 2, `${c.label}: ${out.stderr}`);
      assert.match(out.stderr, c.expect, c.label);
      assert.equal(out.stdout, "", c.label);
    }
    assert.equal(s.requests.length, 0, "no request was sent");
  } finally {
    await s.close();
  }
});

test("redact replaces every occurrence of the token and any other token-shaped value", async () => {
  const { redact } = await import("./logseq-mcp.mjs");
  const other = "lsct_" + "z".repeat(43);
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a lsct_… b lsct_…");
  assert.equal(redact(`other ${other}`, TOKEN), "other lsct_…");
  assert.equal(redact("nothing here", TOKEN), "nothing here");
  assert.equal(redact(`${TOKEN}`, ""), "lsct_…", "an empty token value still redacts token shapes");
  assert.equal(redact("plain", ""), "plain", "an empty token value leaves other text alone");
  assert.equal(redact("short-tok and short-tok", "short-tok"), "lsct_… and lsct_…");
});

test("wiring: .mcp.json reads the host and token from the environment and holds no secret", () => {
  const raw = readFileSync(join(root, ".mcp.json"), "utf8");
  const mcp = JSON.parse(raw);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["logseq-service"]);
  assert.deepEqual(mcp.mcpServers["logseq-service"], {
    type: "http",
    url: "https://${LOGSEQ_MCP_HOST:-mcp.example.com}/mcp",
    headers: { Authorization: "Bearer ${LOGSEQ_SERVICE_TOKEN}" },
  });
  assert.doesNotMatch(raw, /lsct_/);
});

test("wiring: settings enable logseq-service and allow exactly the read tools allowed for mcp__Logseq__", () => {
  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "connector", "tools-manifest.json"), "utf8"));
  const readOnly = new Map(manifest.map((t) => [t.name, t.annotations.readOnlyHint === true]));
  const allow = settings.permissions.allow;

  assert.deepEqual(settings.enabledMcpjsonServers, ["logseq-service"]);

  const tools = (prefix) =>
    allow
      .filter((a) => a.startsWith(prefix))
      .map((a) => a.slice(prefix.length))
      .sort();
  const logseq = tools("mcp__Logseq__");
  const service = tools("mcp__logseq-service__");
  assert.ok(logseq.length > 0);
  assert.deepEqual(service, logseq, "the same tools are allowed under both servers");
  for (const t of service) {
    assert.ok(readOnly.has(t), `${t} is a tool in tools-manifest.json`);
    assert.equal(readOnly.get(t), true, `${t} is read-only`);
  }
  for (const a of allow) {
    assert.notEqual(a, "mcp__logseq-service", "no server-wide allow");
    assert.doesNotMatch(a, /^mcp__logseq-service__.*[*:]/, "no wildcard allow");
  }

  // The existing deny list and hooks are kept.
  assert.ok(settings.permissions.deny.includes("Read(./.env.local)"));
  assert.ok(settings.hooks.SessionStart.length > 0);
});
