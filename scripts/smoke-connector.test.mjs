import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "smoke-connector.sh");

const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

const healthy = (req, res) => {
  const { method, url } = req;
  const reply = (code, body = "", headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(body);
  };
  if (method === "GET" && url === METADATA_PATH) {
    return reply(200, JSON.stringify({ resource: `http://${req.headers.host}/mcp` }));
  }
  if (method === "POST" && url === "/mcp") {
    return reply(401, "{}", {
      "www-authenticate": `Bearer resource_metadata="http://${req.headers.host}${METADATA_PATH}"`,
    });
  }
  if (method === "GET" && url === "/graphs") return reply(302, "", { location: "/login" });
  return reply(404);
};

async function withStub(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

function spawnScript(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, args, { cwd: root, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const run = (base) => spawnScript([base]);

test("passes against a healthy stub", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base + "/");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok oauth-metadata$/m);
    assert.match(r.stdout, /^ok mcp-unauthenticated$/m);
    assert.match(r.stdout, /^ok wizard-requires-login$/m);
  });
});

test("fails when unauthenticated /mcp is 200", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.method === "POST" && req.url === "/mcp" ? (res.writeHead(200), res.end("{}")) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL mcp-unauthenticated: 200/);
  });
});

test("fails when unauthenticated /mcp 401 has no WWW-Authenticate", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.method === "POST" && req.url === "/mcp" ? (res.writeHead(401), res.end("{}")) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL mcp-unauthenticated: no WWW-Authenticate/);
  });
});

test("fails when the metadata resource is wrong", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === METADATA_PATH
      ? (res.writeHead(200, { "content-type": "application/json" }),
        res.end(JSON.stringify({ resource: "https://elsewhere.example.com/mcp" })))
      : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL oauth-metadata: resource/);
  });
});

test("fails when the metadata is not served", { timeout: 120000 }, async () => {
  const h = (req, res) => (req.url === METADATA_PATH ? (res.writeHead(404), res.end()) : healthy(req, res));
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL oauth-metadata: 404/);
  });
});

test("fails when /graphs does not redirect to /login", { timeout: 120000 }, async () => {
  const h = (req, res) => (req.url === "/graphs" ? (res.writeHead(200), res.end("<html>")) : healthy(req, res));
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL wizard-requires-login: 200/);
  });
  const wrong = (req, res) =>
    req.url === "/graphs" ? (res.writeHead(302, { location: "/elsewhere" }), res.end()) : healthy(req, res);
  await withStub(wrong, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL wizard-requires-login: location/);
  });
});

test("connection refused is a FAIL, not a crash", { timeout: 120000 }, async () => {
  const r = await run("http://127.0.0.1:1");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL oauth-metadata: 000/);
});

test("requires a base url", { timeout: 120000 }, async () => {
  const r = await spawnScript([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});
