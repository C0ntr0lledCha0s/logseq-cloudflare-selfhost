import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Made-up IDs and email: never real ones.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const EMAIL = "owner@example.com";
const REFUSAL = "error: list prints user IDs and emails, so it never runs in GitHub Actions";

/** A repo copy holding just what list-users.sh needs, so a .env.local can be planted without touching the real one. */
function repoCopy({ envLocal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "list-users-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "config"));
  for (const f of ["list-users.sh", "allowed-users.mjs"]) copyFileSync(join(root, "scripts", f), join(dir, "scripts", f));
  chmodSync(join(dir, "scripts", "list-users.sh"), 0o755);
  copyFileSync(join(root, "config", "settings.json"), join(dir, "config", "settings.json"));
  if (envLocal !== undefined) writeFileSync(join(dir, ".env.local"), envLocal);
  return dir;
}

async function withStub(fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/accounts/acct/d1/database?")) {
      res.end(JSON.stringify({ success: true, errors: [], result: [{ uuid: "uuid-1", name: "logseq-sync-index" }] }));
    } else if (req.url === "/accounts/acct/d1/database/uuid-1/query") {
      const rows = [{ id: A, email: EMAIL, username: "owner", graphs: 1 }, { id: B, email: null, username: null, graphs: 0 }];
      res.end(JSON.stringify({ success: true, errors: [], result: [{ results: rows, success: true, meta: {} }] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function listUsers(dir, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(join(dir, "scripts", "list-users.sh"), [], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        GITHUB_ACTIONS: "", DEPLOY_SYNC_TEST: "", ALLOWED_USERS_API_BASE: "",
        CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "", DB_SYNC_ALLOWED_USERS: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function withRepo(opts, fn) {
  const dir = repoCopy(opts);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("list-users.sh is executable", () => {
  assert.equal(statSync(join(root, "scripts", "list-users.sh")).mode & 0o111, 0o111);
});

test("in GitHub Actions it refuses with the list message and makes no request", { timeout: 60000 }, async () => {
  await withStub(async (base, requests) => {
    await withRepo({ envLocal: `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nDB_SYNC_ALLOWED_USERS=${A}\n` }, async (dir) => {
      const r = await listUsers(dir, {
        GITHUB_ACTIONS: "true", DEPLOY_SYNC_TEST: "1", ALLOWED_USERS_API_BASE: base,
        CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok",
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.stderr.trim(), REFUSAL);
      assert.equal(r.stdout, "");
      assert.deepEqual(requests, []);
    });
  });
});

test("locally it prints the user table from the environment", { timeout: 60000 }, async () => {
  await withStub(async (base, requests) => {
    await withRepo({}, async (dir) => {
      const r = await listUsers(dir, {
        DEPLOY_SYNC_TEST: "1", ALLOWED_USERS_API_BASE: base,
        CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", DB_SYNC_ALLOWED_USERS: A,
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const lines = r.stdout.trimEnd().split("\n");
      assert.match(lines[0], /^id\s+email\s+username\s+graphs\s+listed$/);
      assert.match(lines[1], new RegExp(`^${A}\\s+${EMAIL}\\s+owner\\s+1\\s+yes$`));
      assert.match(lines[2], new RegExp(`^${B}\\s+-\\s+-\\s+0\\s+no$`));
      assert.equal(requests.length, 2);
      // The D1 name comes from config/settings.json.
      assert.equal(requests[0].url, "/accounts/acct/d1/database?name=logseq-sync-index");
    });
  });
});

test("it reads .env.local, and a value already in the environment wins over it", { timeout: 60000 }, async () => {
  await withStub(async (base, requests) => {
    await withRepo({ envLocal: `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=from-file\nDB_SYNC_ALLOWED_USERS=${A}\n` }, async (dir) => {
      // Nothing but the stub's address comes from the caller: the rest is the file's.
      const fromFile = await listUsers(dir, { DEPLOY_SYNC_TEST: "1", ALLOWED_USERS_API_BASE: base });
      assert.equal(fromFile.status, 0, fromFile.stdout + fromFile.stderr);
      assert.match(fromFile.stdout, new RegExp(`^${A}\\s.*\\syes$`, "m"));
      assert.match(fromFile.stdout, new RegExp(`^${B}\\s.*\\sno$`, "m"));
      assert.equal(requests[0].auth, "Bearer from-file");

      // The caller's values override the file's.
      const overridden = await listUsers(dir, {
        DEPLOY_SYNC_TEST: "1", ALLOWED_USERS_API_BASE: base,
        CLOUDFLARE_API_TOKEN: "from-env", DB_SYNC_ALLOWED_USERS: B,
      });
      assert.equal(overridden.status, 0, overridden.stdout + overridden.stderr);
      assert.match(overridden.stdout, new RegExp(`^${A}\\s.*\\sno$`, "m"));
      assert.match(overridden.stdout, new RegExp(`^${B}\\s.*\\syes$`, "m"));
      assert.equal(requests[2].auth, "Bearer from-env");
    });
  });
});

test("it exits non-zero with an error line when the API is unreachable", { timeout: 60000 }, async () => {
  await withRepo({}, async (dir) => {
    // Nothing listens on port 1.
    const r = await listUsers(dir, {
      DEPLOY_SYNC_TEST: "1", ALLOWED_USERS_API_BASE: "http://127.0.0.1:1",
      CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", DB_SYNC_ALLOWED_USERS: A,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /^error: /m);
  });
});
