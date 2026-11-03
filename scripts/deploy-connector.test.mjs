import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "deploy-connector.sh");

const SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY", "CONNECTOR_HOSTNAME",
];

async function runWith(connector, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-connector-"));
  try {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ workerName: "logseq-sync", connector }));
    const clean = Object.fromEntries(SECRET_NAMES.map((n) => [n, ""]));
    return await new Promise((resolveRun, reject) => {
      const child = spawn(script, [], {
        cwd: root,
        env: {
          ...process.env,
          ...clean,
          DEPLOY_CONNECTOR_TEST: "1",
          DEPLOY_CONNECTOR_SETTINGS: settings,
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("disabled connector is a no-op that needs no env", { timeout: 60000 }, async () => {
  const r = await runWith({ enabled: false, workerName: "logseq-connector", d1DatabaseName: "logseq-connector" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "connector disabled");
});

test("enabled connector with missing env fails naming only the variable", { timeout: 60000 }, async () => {
  const enabled = { enabled: true, workerName: "logseq-connector", d1DatabaseName: "logseq-connector" };
  const r = await runWith(enabled, { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_CLIENT_ID/);
  assert.doesNotMatch(r.stdout + r.stderr, /tok|acct/);
});

test("a missing or non-boolean enabled key fails", { timeout: 60000 }, async () => {
  const missing = await runWith({ workerName: "logseq-connector" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing setting: connector\.enabled/);
  const bad = await runWith({ enabled: "yes" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be true or false/);
});

test("the settings override requires the test switch", { timeout: 60000 }, async () => {
  const r = await runWith({ enabled: false }, { DEPLOY_CONNECTOR_TEST: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test-only/);
});
