import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "smoke-test.sh");

const healthy = (req, res) => {
  const { method, url } = req;
  const reply = (code, body = "") => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };
  if (method === "GET" && url === "/health") return reply(200, '{"ok":true}');
  if (method === "GET" && url === "/openapi.json") return reply(200, "{}");
  if (method === "GET" && url === "/api/v1/graphs") {
    return req.headers.authorization === "Bearer logseq_pat_secret"
      ? reply(200, "[]")
      : reply(401, "{}");
  }
  if (method === "POST" && url === "/mcp") return reply(401, "{}");
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

function spawnScript(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, args, {
      cwd: root,
      env: { ...process.env, SMOKE_PAT: "", PLAN: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const run = (base, env) => spawnScript([base], env);

test("passes against a healthy stub", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base + "/");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok health$/m);
    assert.match(r.stdout, /^ok openapi$/m);
    assert.match(r.stdout, /^ok unauthenticated-graphs$/m);
    assert.doesNotMatch(r.stdout, /pat-graphs|mcp-unauthenticated/);
  });
});

test("fails when unauthenticated graphs list is 200", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === "/api/v1/graphs" ? (res.writeHead(200), res.end("[]")) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL unauthenticated-graphs: 200/);
  });
});

test("fails when health body is wrong", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === "/health" ? (res.writeHead(200), res.end('{"ok":false}')) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL health: body/);
  });
});

test("never prints the PAT and checks it", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok pat-graphs$/m);
    assert.ok(!(r.stdout + r.stderr).includes("logseq_pat_secret"));
  });
});

test("fails when the PAT is rejected without leaking it", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === "/api/v1/graphs" && req.headers.authorization
      ? (res.writeHead(403), res.end("{}"))
      : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL pat-graphs: 403/);
    assert.ok(!(r.stdout + r.stderr).includes("logseq_pat_secret"));
  });
});

test("paid plan checks /mcp is 401", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base, { PLAN: "paid" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok mcp-unauthenticated$/m);
  });
  const h = (req, res) =>
    req.url === "/mcp" ? (res.writeHead(404), res.end()) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base, { PLAN: "paid" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL mcp-unauthenticated: 404/);
  });
});

test("connection refused is a FAIL, not a crash", { timeout: 120000 }, async () => {
  const r = await run("http://127.0.0.1:1");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL health: 000/);
});

test("rejects an invalid PLAN with exit 2", { timeout: 120000 }, async () => {
  const r = await run("http://127.0.0.1:1", { PLAN: "enterprise" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test("requires a base url", { timeout: 120000 }, async () => {
  const r = await spawnScript([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});
