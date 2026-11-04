import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "deploy-connector.sh");

const SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY", "CONNECTOR_HOSTNAME", "CONNECTOR_ENABLED",
  "SEMANTIC_SEARCH_ENABLED",
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

const CONNECTOR = { workerName: "logseq-connector", d1DatabaseName: "logseq-connector" };
const VALID_ENV = {
  CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct", GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csecret",
  OWNER_GITHUB_USER_ID: "1234567", COOKIE_ENCRYPTION_KEY: "a".repeat(64), GRAPH_TOKEN_KEY: "b".repeat(64),
  CONNECTOR_HOSTNAME: "mcp.example.com",
};

test("a disabled connector is a no-op that needs no env", { timeout: 60000 }, async () => {
  for (const enabled of ["false", ""]) {
    const r = await runWith(CONNECTOR, { CONNECTOR_ENABLED: enabled });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "connector disabled", JSON.stringify(enabled));
  }
});

test("enabled connector with missing env fails naming only the variable", { timeout: 60000 }, async () => {
  const r = await runWith(CONNECTOR, { CONNECTOR_ENABLED: "true", CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GITHUB_CLIENT_ID/);
  assert.doesNotMatch(r.stdout + r.stderr, /tok|acct/);
});

test("a CONNECTOR_ENABLED other than true or false fails", { timeout: 60000 }, async () => {
  for (const enabled of ["yes", "TRUE", "1"]) {
    const r = await runWith(CONNECTOR, { CONNECTOR_ENABLED: enabled });
    assert.equal(r.status, 1, enabled);
    assert.match(r.stderr, /CONNECTOR_ENABLED must be true or false/, enabled);
  }
});

test("an enabled connector with no d1DatabaseName setting fails", { timeout: 60000 }, async () => {
  const r = await runWith({ workerName: "logseq-connector" }, { ...VALID_ENV, CONNECTOR_ENABLED: "true" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing setting: connector\.d1DatabaseName/);
});

test("the settings override requires the test switch", { timeout: 60000 }, async () => {
  const r = await runWith(CONNECTOR, { DEPLOY_CONNECTOR_TEST: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /test-only/);
});


/** Runs with a `tofu` stub first on PATH that records whether it was called and then fails. */
async function runWithTofuStub(env) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-connector-tofu-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const marker = join(dir, "tofu-called");
    writeFileSync(join(bin, "tofu"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(bin, "tofu"), 0o755);
    const r = await runWith(CONNECTOR, { ...VALID_ENV, CONNECTOR_ENABLED: "true", ...env, PATH: `${bin}:${process.env.PATH}` });
    return { ...r, tofuCalled: existsSync(marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, env, pattern] of [
  ["uppercase CONNECTOR_HOSTNAME", { CONNECTOR_HOSTNAME: "MCP.example.com" }, /CONNECTOR_HOSTNAME must be lowercase/],
  ["CONNECTOR_HOSTNAME with a scheme", { CONNECTOR_HOSTNAME: "https://mcp.example.com" }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME with a port", { CONNECTOR_HOSTNAME: "mcp.example.com:443" }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME with a trailing dot", { CONNECTOR_HOSTNAME: "mcp.example.com." }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["single-label CONNECTOR_HOSTNAME", { CONNECTOR_HOSTNAME: "localhost" }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME over 253 characters", { CONNECTOR_HOSTNAME: `${Array(4).fill("a".repeat(63)).join(".")}.com` }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["OWNER_GITHUB_USER_ID with a leading zero", { OWNER_GITHUB_USER_ID: "01234" }, /OWNER_GITHUB_USER_ID must be a positive integer/],
  ["OWNER_GITHUB_USER_ID of zero", { OWNER_GITHUB_USER_ID: "0" }, /OWNER_GITHUB_USER_ID must be a positive integer/],
  ["non-numeric OWNER_GITHUB_USER_ID", { OWNER_GITHUB_USER_ID: "octocat" }, /OWNER_GITHUB_USER_ID must be a positive integer/],
]) {
  test(`enabled connector with ${name} fails before rendering or deploying`, { timeout: 60000 }, async () => {
    const r = await runWithTofuStub(env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(r.tofuCalled, false, "tofu must not run");
  });
}

test("valid connector inputs pass the checks and reach tofu", { timeout: 60000 }, async () => {
  const r = await runWithTofuStub({});
  assert.equal(r.status, 1);
  assert.equal(r.tofuCalled, true);
  assert.doesNotMatch(r.stderr, /CONNECTOR_HOSTNAME|OWNER_GITHUB_USER_ID/);
});

test("a SEMANTIC_SEARCH_ENABLED other than true or false fails before tofu", { timeout: 60000 }, async () => {
  for (const enabled of ["yes", "TRUE", "1"]) {
    const r = await runWithTofuStub({ SEMANTIC_SEARCH_ENABLED: enabled });
    assert.equal(r.status, 1, enabled);
    assert.match(r.stderr, /SEMANTIC_SEARCH_ENABLED must be true or false/, enabled);
    assert.equal(r.tofuCalled, false, enabled);
  }
});

test("SEMANTIC_SEARCH_ENABLED true, false or unset passes the checks and reaches tofu", { timeout: 60000 }, async () => {
  for (const enabled of ["true", "false", ""]) {
    const r = await runWithTofuStub({ SEMANTIC_SEARCH_ENABLED: enabled });
    assert.equal(r.tofuCalled, true, JSON.stringify(enabled));
    assert.doesNotMatch(r.stderr, /SEMANTIC_SEARCH_ENABLED/);
  }
});

test("a disabled connector ignores SEMANTIC_SEARCH_ENABLED", { timeout: 60000 }, async () => {
  const r = await runWith(CONNECTOR, { CONNECTOR_ENABLED: "false", SEMANTIC_SEARCH_ENABLED: "true" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "connector disabled");
});

test("the deploy passes the semantic search switch to the renderer", () => {
  const body = readFileSync(script, "utf8");
  assert.match(body, /--semantic-search "\$semantic_search"/);
});
