import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "deploy.sh");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** A local stub of the two Cloudflare D1 API calls the check-known step makes. */
async function withApiStub(users, fn) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/accounts/acct/d1/database?")) {
      res.end(JSON.stringify({ success: true, errors: [], result: [{ uuid: "uuid-1", name: "logseq-sync-index" }] }));
    } else if (req.url === "/accounts/acct/d1/database/uuid-1/query") {
      res.end(JSON.stringify({ success: true, errors: [], result: [{ results: users, success: true, meta: {} }] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/**
 * Runs the real deploy.sh against a temp upstream dir holding a stub wrangler (which logs its argv and,
 * on `deploy`, keeps a copy of the --secrets-file) and a stub tofu first on PATH.
 */
async function runDeploy(env, { apiBase = "http://127.0.0.1:1", users = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-sync-"));
  try {
    const upstream = join(dir, "upstream");
    mkdirSync(join(upstream, "deps", "db-sync", "worker"), { recursive: true });
    mkdirSync(join(upstream, "deps", "db-sync", "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    copyFileSync(join(root, "scripts", "fixtures", "upstream-wrangler.toml"), join(upstream, "deps", "db-sync", "worker", "wrangler.toml"));
    const log = join(dir, "wrangler.log");
    const secrets = join(dir, "secrets.json");
    const renderedToml = join(dir, "rendered.toml");

    const wrangler = join(upstream, "deps", "db-sync", "node_modules", ".bin", "wrangler");
    writeFileSync(
      wrangler,
      `#!/usr/bin/env bash
echo "$*" | sed -E 's|--secrets-file .*|--secrets-file <path>|' >> "$WRANGLER_LOG"
if [ "$1" = deploy ]; then
  while [ "$#" -gt 0 ]; do
    [ "$1" = --secrets-file ] && cp "$2" "$WRANGLER_SECRETS"
    shift
  done
  cp wrangler.toml "$WRANGLER_TOML"
fi
`,
    );
    chmodSync(wrangler, 0o755);
    const tofu = join(dir, "bin", "tofu");
    writeFileSync(tofu, `#!/usr/bin/env bash\necho '{"d1_database_id":{"value":"00000000-0000-0000-0000-000000000000"}}'\n`);
    chmodSync(tofu, 0o755);

    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(script, [], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          GITHUB_ACTIONS: "",
          CLOUDFLARE_API_TOKEN: "tok",
          CLOUDFLARE_ACCOUNT_ID: "acct",
          ASSET_LINK_SECRET: "asset-secret",
          DB_SYNC_ADMIN_TOKEN: "admin-token",
          SYNC_HOSTNAME: "sync.example.com",
          DB_SYNC_ALLOWED_USERS: A,
          DEPLOY_SYNC_TEST: "1",
          DEPLOY_SYNC_SKIP_SMOKE: "1",
          DEPLOY_SYNC_UPSTREAM: upstream,
          ALLOWED_USERS_API_BASE: apiBase,
          WRANGLER_LOG: log,
          WRANGLER_SECRETS: secrets,
          WRANGLER_TOML: renderedToml,
          HEALTH_TAG_PROPERTIES: "",
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
    return {
      ...result,
      calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : null,
      secrets: existsSync(secrets) ? JSON.parse(readFileSync(secrets, "utf8")) : null,
      toml: existsSync(renderedToml) ? parse(readFileSync(renderedToml, "utf8")) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("refuses a malformed list before any wrangler or tofu call", { timeout: 60000 }, async () => {
  const r = await runDeploy({ DB_SYNC_ALLOWED_USERS: "not-a-uuid" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DB_SYNC_ALLOWED_USERS entry 1 of 1/);
  assert.equal(r.calls, null);
  assert.ok(!existsSync(join(root, "tofu-output.json")));
});

test("refuses an empty list", { timeout: 60000 }, async () => {
  const r = await runDeploy({ DB_SYNC_ALLOWED_USERS: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DB_SYNC_ALLOWED_USERS is empty or missing/);
  assert.equal(r.calls, null);
});

test("deploys code and all the secrets together", { timeout: 60000 }, async () => {
  await withApiStub([{ id: A, email: null, username: null, graphs: 1 }], async (apiBase) => {
    const r = await runDeploy({ DB_SYNC_ALLOWED_USERS: `  ${A}\n` }, { apiBase });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, ["d1 migrations apply logseq-sync-index --remote", "deploy --secrets-file <path>"]);
    assert.deepEqual(r.secrets, {
      ASSET_LINK_SECRET: "asset-secret", DB_SYNC_ADMIN_TOKEN: "admin-token", DB_SYNC_ALLOWED_USERS: A,
      HEALTH_TAG_PROPERTIES: "[]",
    }, "with no HEALTH_TAG_PROPERTIES secret, the committed settings.json pairs ([]) go up as the secret");
    assert.ok(!r.calls.some((call) => call.includes("secret bulk")));
    assert.ok(!existsSync(join(root, "tofu-output.json")));
  });
});

// Reviews r2-tests-1, r2-tests-3, r2-correctness-1 and r2-light-1: the owner's tag-property pairs
// reach the Worker only through deploy.sh's environment, and wrangler deploy prints every [vars] value
// (the first 37 characters) in the public run log, so they go up in the secrets file, which it lists
// as "(hidden)", and never in [vars].
test("HEALTH_TAG_PROPERTIES goes up in the secrets file, never as a [vars] entry", { timeout: 60000 }, async () => {
  const pairs = [{ tag: "zz Medical", property: "zz doctor" }, { tag: "zz Book", property: "zz author" }];
  await withApiStub([{ id: A, email: null, username: null, graphs: 1 }], async (apiBase) => {
    const set = await runDeploy({ HEALTH_TAG_PROPERTIES: JSON.stringify(pairs) }, { apiBase });
    assert.equal(set.status, 0, set.stdout + set.stderr);
    assert.deepEqual(JSON.parse(set.secrets.HEALTH_TAG_PROPERTIES), pairs, "the environment's pairs, over settings.json's []");
    assert.equal("HEALTH_TAG_PROPERTIES" in (set.toml.vars ?? {}), false, "not a plain-text var");
    assert.ok(!(set.stdout + set.stderr).includes("zz Medical"), "the tag name is not printed");

    const unset = await runDeploy({}, { apiBase });
    assert.equal(unset.status, 0, unset.stdout + unset.stderr);
    assert.equal(unset.secrets.HEALTH_TAG_PROPERTIES, "[]", "settings.json's pairs when the environment has none");
    assert.equal("HEALTH_TAG_PROPERTIES" in (unset.toml.vars ?? {}), false);

    const malformed = await runDeploy({ HEALTH_TAG_PROPERTIES: "not json" }, { apiBase });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /the HEALTH_TAG_PROPERTIES secret is not JSON/);
    assert.equal(malformed.calls, null, "refused before any wrangler call");
  });
});

test("stops after migrations when no listed user is known", { timeout: 60000 }, async () => {
  await withApiStub([{ id: B, email: null, username: null, graphs: 1 }], async (apiBase) => {
    const r = await runDeploy({}, { apiBase });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /none of the 1 listed user IDs is a known user/);
    assert.deepEqual(r.calls, ["d1 migrations apply logseq-sync-index --remote"]);
    assert.equal(r.secrets, null);
  });
});

test("test hooks need DEPLOY_SYNC_TEST", { timeout: 60000 }, async () => {
  for (const hook of ["DEPLOY_SYNC_UPSTREAM", "DEPLOY_SYNC_SKIP_SMOKE"]) {
    // Only the hook under test is set; runDeploy's own defaults for the other one are blanked.
    const r = await runDeploy({
      DEPLOY_SYNC_TEST: "",
      DEPLOY_SYNC_UPSTREAM: "",
      DEPLOY_SYNC_SKIP_SMOKE: "",
      [hook]: hook === "DEPLOY_SYNC_SKIP_SMOKE" ? "1" : "/tmp/elsewhere",
    });
    assert.notEqual(r.status, 0, hook);
    assert.match(r.stderr, new RegExp(`deploy: ${hook} is test-only and requires DEPLOY_SYNC_TEST=1`), hook);
    assert.equal(r.calls, null, hook);
  }
});
