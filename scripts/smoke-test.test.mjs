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
  if (method === "POST" && url === "/mcp") return reply(404, "{}");
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
      env: { ...process.env, SMOKE_PAT: "", ...env },
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
    assert.match(r.stdout, /^ok upstream-mcp-off$/m);
    assert.doesNotMatch(r.stdout, /pat-graphs/);
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
    req.url === "/api/v1/graphs" && req.headers.authorization === "Bearer logseq_pat_secret"
      ? (res.writeHead(403), res.end("{}"))
      : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL pat-graphs: 403/);
    assert.ok(!(r.stdout + r.stderr).includes("logseq_pat_secret"));
  });
});

test("checks upstream /mcp is gone", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok upstream-mcp-off$/m);
  });
});

test("fails when upstream /mcp still answers", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === "/mcp" ? (res.writeHead(200), res.end("{}")) : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL upstream-mcp-off: 200/);
  });
});

test("connection refused is a FAIL, not a crash", { timeout: 120000 }, async () => {
  const r = await run("http://127.0.0.1:1");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL health: 000/);
});

test("requires a base url", { timeout: 120000 }, async () => {
  const r = await spawnScript([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test("refuses a garbage bearer token", { timeout: 120000 }, async () => {
  const seen = [];
  const h = (req, res) => {
    if (req.url === "/api/v1/graphs") seen.push(req.headers.authorization);
    return healthy(req, res);
  };
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok jwt-garbage-refused$/m);
    assert.ok(seen.includes("Bearer not-a-jwt"));
  });
});

test("fails when a garbage bearer token is accepted", { timeout: 120000 }, async () => {
  const h = (req, res) =>
    req.url === "/api/v1/graphs" && req.headers.authorization === "Bearer not-a-jwt"
      ? (res.writeHead(200), res.end("[]"))
      : healthy(req, res);
  await withStub(h, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL jwt-garbage-refused: 200/);
  });
});

test("notes when SMOKE_PAT is unset", { timeout: 120000 }, async () => {
  await withStub(healthy, async (base) => {
    const r = await run(base);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^note: SMOKE_PAT is not set, so the allow-list was not checked end to end$/m);
    const withPat = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.doesNotMatch(withPat.stdout, /note: SMOKE_PAT/);
  });
});

// A stub with graphs behind the PAT: queries answers POST /api/v1/graphs/<id>/query per graph id.
function withGraphs(graphs, queries, seen = []) {
  return (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
    };
    if (req.method === "GET" && req.url === "/api/v1/graphs" && req.headers.authorization === "Bearer logseq_pat_secret") {
      return reply(200, JSON.stringify({ graphs, "user-rsa-keys-exists?": false }));
    }
    const m = req.method === "POST" && req.url.match(/^\/api\/v1\/graphs\/([^/]+)\/query$/);
    if (m) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ graph: m[1], auth: req.headers.authorization, body: JSON.parse(body) });
        const [code, out] = queries[m[1]] ?? [404, "{}"];
        reply(code, JSON.stringify(out));
      });
      return;
    }
    return healthy(req, res);
  };
}

const graph = (id, extra = {}) => ({ "graph-id": id, "graph-e2ee?": false, "graph-ready-for-use?": true, ...extra });
const tagRows = { columns: ["?id"], rows: [["logseq.class/Tag"]] };

test("with a PAT, a datalog query returns a value bound by a data pattern", { timeout: 120000 }, async () => {
  const seen = [];
  await withStub(withGraphs([graph("g1")], { g1: [200, tagRows] }, seen), async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok datalog-query$/m);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer logseq_pat_secret");
    assert.match(seen[0].body.query, /:db\/ident \?id/);
    assert.ok(!(r.stdout + r.stderr).includes("logseq_pat_secret"));
  });
});

test("fails when the datalog query's bound value comes back null (release build without externs)", { timeout: 120000 }, async () => {
  await withStub(withGraphs([graph("g1")], { g1: [200, { columns: ["?id"], rows: [[null]] }] }), async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL datalog-query: rows .*null/m);
  });
});

test("fails when the datalog query answers an error", { timeout: 120000 }, async () => {
  await withStub(withGraphs([graph("g1")], { g1: [500, { error: "server error" }] }), async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^FAIL datalog-query: 500$/m);
  });
});

test("the datalog query skips E2EE and unready graphs and a graph the PAT can't read", { timeout: 120000 }, async () => {
  const seen = [];
  const graphs = [graph("enc", { "graph-e2ee?": true }), graph("new", { "graph-ready-for-use?": false }), graph("other"), graph("mine")];
  await withStub(withGraphs(graphs, { other: [403, { error: "forbidden" }], mine: [200, tagRows] }, seen), async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok datalog-query$/m);
    assert.deepEqual(seen.map((s) => s.graph), ["other", "mine"]);
  });
});

test("notes when no graph can be queried", { timeout: 120000 }, async () => {
  await withStub(withGraphs([graph("enc", { "graph-e2ee?": true })], {}), async (base) => {
    const r = await run(base, { SMOKE_PAT: "logseq_pat_secret" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^note: no graph this PAT can read, so datalog-query was not checked$/m);
    assert.doesNotMatch(r.stdout, /datalog-query$/m);
  });
});
