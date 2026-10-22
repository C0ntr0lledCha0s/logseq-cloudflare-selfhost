import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "with-r2-credentials.sh");

const TOKEN = "cf_token_value_abc123";
const ACCOUNT = "acct123";
const TOKEN_ID = "token-id-xyz";
const expectedSecret = createHash("sha256").update(TOKEN).digest("hex");

const verifyHandler = (result) => (req, res) => {
  const ok =
    req.method === "GET" &&
    req.url === `/accounts/${ACCOUNT}/tokens/verify` &&
    req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 404, { "content-type": "application/json" });
  res.end(ok ? JSON.stringify(result) : "{}");
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

function run(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, args, {
      cwd: root,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
        GITHUB_ACTIONS: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const printer = [
  "node",
  "-e",
  `const c = require("crypto");
const e = process.env;
console.log(JSON.stringify({
  aws: e.AWS_ACCESS_KEY_ID,
  awsSecretSha: c.createHash("sha256").update(e.AWS_SECRET_ACCESS_KEY).digest("hex"),
  r2: e.R2_ACCESS_KEY_ID,
  r2SecretSha: c.createHash("sha256").update(e.R2_SECRET_ACCESS_KEY).digest("hex"),
  secretLen: e.AWS_SECRET_ACCESS_KEY.length,
  same: e.AWS_SECRET_ACCESS_KEY === e.R2_SECRET_ACCESS_KEY,
}));`,
];

const success = { success: true, result: { id: TOKEN_ID, status: "active" } };

test("passes derived credentials to the wrapped command", { timeout: 60000 }, async () => {
  await withStub(verifyHandler(success), async (base) => {
    const r = await run(printer, { CF_API_BASE: base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    const secretSha = createHash("sha256").update(expectedSecret).digest("hex");
    assert.equal(out.aws, TOKEN_ID);
    assert.equal(out.r2, TOKEN_ID);
    assert.equal(out.awsSecretSha, secretSha);
    assert.equal(out.r2SecretSha, secretSha);
    assert.equal(out.secretLen, 64);
    assert.equal(out.same, true);
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  });
});

test("fails when verify reports success=false", { timeout: 60000 }, async () => {
  await withStub(verifyHandler({ success: false, result: { id: TOKEN_ID } }), async (base) => {
    const r = await run(printer, { CF_API_BASE: base });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /verify/);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes(TOKEN));
  });
});

test("fails when verify returns no id", { timeout: 60000 }, async () => {
  await withStub(verifyHandler({ success: true, result: {} }), async (base) => {
    const r = await run(printer, { CF_API_BASE: base });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no token id/);
  });
});

test("fails when verify is unreachable", { timeout: 60000 }, async () => {
  const r = await run(printer, { CF_API_BASE: "http://127.0.0.1:1" });
  assert.notEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
});

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  test(`fails when ${name} is missing`, { timeout: 60000 }, async () => {
    const r = await run(printer, { [name]: undefined, CF_API_BASE: "http://127.0.0.1:1" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(name));
  });
}

test("requires a command", { timeout: 60000 }, async () => {
  const r = await run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test("masks derived values in GitHub Actions, never the token", { timeout: 60000 }, async () => {
  await withStub(verifyHandler(success), async (base) => {
    const r = await run(["true"], { CF_API_BASE: base, GITHUB_ACTIONS: "true" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`::add-mask::${expectedSecret}`));
    assert.ok(r.stdout.includes(`::add-mask::${TOKEN_ID}`));
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  });
});
