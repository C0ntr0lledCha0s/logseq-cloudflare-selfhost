import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf } from "./cloudflare-api.mjs";
import { findZone, runDoctor } from "./doctor.mjs";
import { cfStub, runScript, stubGh } from "./test-helpers.mjs";
import { permissionLabels, readConfig } from "./token-link.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PAGE = "dash.cloudflare.com/?to=/:account/api-tokens";
const REPO = "example/logseq-selfhost";
const ORIGIN = `https://github.com/${REPO}.git`;
// The repo a fork was made from: `gh repo view` with no repo argument names it in a clone with an `upstream` remote.
const PARENT = "upstream-owner/logseq-selfhost";
const SECRETS = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE", "ASSET_LINK_SECRET",
  "DB_SYNC_ADMIN_TOKEN", "DB_SYNC_ALLOWED_USERS", "SYNC_HOSTNAME",
];
const CONNECTOR_SECRETS = [
  "CONNECTOR_HOSTNAME", "CONNECTOR_GITHUB_CLIENT_ID", "CONNECTOR_GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY",
];
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = 1_700_000_000_000;

const ok = (result) => ({ success: true, errors: [], result });
const fail = (code, message) => ({ success: false, errors: [{ code, message }], result: null });
const zone = (name, status = "active") => ({ id: `zone-${name}`, name, status });

/** A Cloudflare account where every check passes, for `sync.example.com` (and `mcp.example.com`). */
function greenRoutes(overrides = {}) {
  return {
    "GET /accounts/acct/tokens/verify": () => [200, ok({ status: "active" })],
    "GET /accounts/acct/d1/database": () => [200, ok([])],
    "GET /accounts/acct/r2/buckets": () => [200, ok({ buckets: [] })],
    "GET /accounts/acct/workers/subdomain": () => [200, ok({ subdomain: "logseq-abc" })],
    "GET /accounts/acct/storage/kv/namespaces": () => [200, ok([])],
    "GET /accounts/acct/vectorize/v2/indexes": () => [200, ok([])],
    "POST /accounts/acct/workers/observability/telemetry/query": () => [200, ok({ events: { events: [] } })],
    "GET /zones": (req) => [200, ok(req.query.name === "example.com" ? [zone("example.com")] : [])],
    "GET /zones/zone-example.com/dns_records": () => [200, ok([])],
    "GET /accounts/acct/workers/domains": () => [200, ok([])],
    ...overrides,
  };
}

const POLICIES = `repos/${REPO}/environments/production/deployment-branch-policies`;
const policies = (...list) => JSON.stringify({ total_count: list.length, branch_policies: list.map((p, i) => ({ id: i + 1, ...p })) });
const MAIN_POLICY = { name: "main", type: "branch" };

/** `gh variable list --json name,value` output holding CONNECTOR_ENABLED, or nothing when `value` is undefined. */
const variableList = (value) => JSON.stringify(value === undefined ? [] : [{ name: "CONNECTOR_ENABLED", value }]);

/** A fake `gh` for a repo where every check passes. `rules` are [argv prefix, { status, stdout }]. */
function greenGh({ secrets = SECRETS, fork = false, envVariable, repoVariable, workflows, extra = [] } = {}) {
  const all = workflows ?? [
    { name: "backup", state: "active" },
    { name: "usage", state: "active" },
    { name: fork ? "sync-upstream" : "bump-upstream", state: "active" },
  ];
  const rules = [
    ...extra,
    [`repo view ${ORIGIN} --json nameWithOwner,isFork`, { status: 0, stdout: JSON.stringify({ nameWithOwner: REPO, isFork: fork }) }],
    ["repo view", { status: 0, stdout: JSON.stringify({ nameWithOwner: PARENT, isFork: false }) }],
    [`api repos/${REPO}/actions/permissions`, { status: 0, stdout: JSON.stringify({ enabled: true }) }],
    // Before the environment's own rule, which is a prefix of it.
    [`api ${POLICIES}?per_page=100`, { status: 0, stdout: policies(MAIN_POLICY) }],
    [
      `api repos/${REPO}/environments/production`,
      { status: 0, stdout: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }) },
    ],
    [`secret list -R ${REPO} --env production`, { status: 0, stdout: JSON.stringify(secrets.map((name) => ({ name }))) }],
    [`variable list --env production --json name,value -R ${REPO}`, { status: 0, stdout: variableList(envVariable) }],
    [`variable list --json name,value -R ${REPO}`, { status: 0, stdout: variableList(repoVariable) }],
    [`workflow list -R ${REPO} --all`, { status: 0, stdout: JSON.stringify(all) }],
  ];
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const line = args.join(" ");
    const rule = rules.find(([prefix]) => line.startsWith(prefix));
    if (!rule) throw new Error(`unstubbed gh call: ${line}`);
    return rule[1];
  };
  return { gh, calls };
}

function repoDir({ mode = 0o600, envLocal = "# placeholder\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  mkdirSync(join(dir, "config"));
  copyFileSync(join(root, "config", "settings.json"), join(dir, "config", "settings.json"));
  if (envLocal !== null) {
    writeFileSync(join(dir, ".env.local"), envLocal);
    chmodSync(join(dir, ".env.local"), mode);
  }
  return dir;
}

const baseEnv = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "tok",
  SYNC_HOSTNAME: "sync.example.com",
  DB_SYNC_ALLOWED_USERS: USER,
};

/** Runs the doctor against a Cloudflare stub. Returns the results, the exit code and what was called. */
async function doctor({ env = {}, routes = greenRoutes(), gh = greenGh(), repo = repoDir(), originUrl = ORIGIN } = {}) {
  const stub = await cfStub(routes);
  try {
    const cfCall = (opts) => cf({ apiBase: stub.base, apiToken: "tok", ...opts });
    const outcome = await runDoctor({ env: { ...baseEnv, ...env }, cfCall, gh: gh.gh, originUrl, now: NOW, repoRoot: repo });
    return { ...outcome, requests: stub.requests, ghCalls: gh.calls };
  } finally {
    await stub.close();
  }
}

const named = (results, name) => results.filter((r) => r.name === name);
const only = (results, name) => {
  const found = named(results, name);
  assert.equal(found.length, 1, `expected one "${name}" result, got ${JSON.stringify(found)}`);
  return found[0];
};
const levelOf = (results, name) => only(results, name).level;

const GREEN_NAMES = [
  "hostname", "token", "perm:d1", "perm:r2", "perm:workers", "perm:zone", "perm:observability", "r2-enabled",
  "zone", "dns", "actions", "environment", "secrets", "connector-setting", "schedules", "env-mode", "allowed-users",
];

test("all green: every check is ok and the exit code is 0", async () => {
  const { results, exitCode } = await doctor();
  assert.deepEqual(
    results.filter((r) => r.level !== "ok"),
    [],
  );
  for (const name of GREEN_NAMES) assert.equal(levelOf(results, name), "ok", name);
  // The checks that only apply with the connector or semantic search stay out.
  for (const name of ["perm:kv", "perm:vectorize", "connector-hostname", "connector-zone", "connector-dns"]) {
    assert.equal(named(results, name).length, 0, name);
  }
  assert.equal(exitCode, 0);
});

test("the token and every permission check use the account and the harmless call named for it", async () => {
  const { requests } = await doctor();
  const seen = requests.map((r) => `${r.method} ${r.path}`);
  for (const line of [
    "GET /accounts/acct/tokens/verify",
    "GET /accounts/acct/d1/database",
    "GET /accounts/acct/r2/buckets",
    "GET /accounts/acct/workers/subdomain",
  ]) {
    assert.ok(seen.includes(line), line);
  }
  assert.equal(requests.find((r) => r.path === "/accounts/acct/d1/database").query.per_page, "1");
  const obs = requests.find((r) => r.path.endsWith("/workers/observability/telemetry/query"));
  assert.deepEqual(obs.body, { queryId: "doctor", timeframe: { from: NOW - 60000, to: NOW }, view: "events", limit: 1, dry: true });
});

test("perm:workers treats a 404 for the workers.dev subdomain as ok", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/workers/subdomain": () => [404, fail(10007, "no subdomain")] });
  const { results } = await doctor({ routes });
  assert.equal(levelOf(results, "perm:workers"), "ok");
});

test("perm:kv and perm:vectorize run only when the connector and semantic search are on", async () => {
  const { results, exitCode } = await doctor({
    env: { CONNECTOR_ENABLED: "true", SEMANTIC_SEARCH_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
    gh: greenGh({ secrets: [...SECRETS, ...CONNECTOR_SECRETS], envVariable: "true" }),
  });
  assert.equal(levelOf(results, "perm:kv"), "ok");
  assert.equal(levelOf(results, "perm:vectorize"), "ok");
  assert.equal(exitCode, 0);
});

test("a missing KV permission is a FAIL that names it and carries the token link", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/storage/kv/namespaces": () => [403, fail(10000, "Authentication error")] });
  const { results, exitCode } = await doctor({
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
    routes,
    gh: greenGh({ secrets: [...SECRETS, ...CONNECTOR_SECRETS], envVariable: "true" }),
  });
  const kv = only(results, "perm:kv");
  assert.equal(kv.level, "FAIL");
  assert.ok(kv.detail.includes("Workers KV Storage Edit"), kv.detail);
  assert.ok(kv.detail.includes(TOKEN_PAGE), kv.detail);
  assert.equal(exitCode, 1);
});

test("the labels the doctor names are the ones on the token link", () => {
  const labels = permissionLabels(readConfig());
  for (const label of [
    "D1 Edit", "Workers R2 Storage Edit", "Workers Scripts Edit", "Workers KV Storage Edit",
    "Zone Read", "Workers Observability Write", "Vectorize Write",
  ]) {
    assert.ok(labels.includes(label), label);
  }
});

test("a disabled or expired token is a FAIL with the token link, and stops the Cloudflare checks", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/tokens/verify": () => [200, ok({ status: "expired" })] });
  const { results, exitCode, requests } = await doctor({ routes });
  const token = only(results, "token");
  assert.equal(token.level, "FAIL");
  assert.ok(token.detail.includes("expired"), token.detail);
  assert.ok(token.detail.includes(TOKEN_PAGE), token.detail);
  assert.equal(named(results, "perm:d1").length, 0);
  assert.deepEqual(requests.map((r) => r.path), ["/accounts/acct/tokens/verify"]);
  // The GitHub and local checks still run.
  assert.equal(levelOf(results, "actions"), "ok");
  assert.equal(exitCode, 1);
});

test("a token the API rejects is a FAIL with the token link", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/tokens/verify": () => [401, fail(1000, "Invalid API Token")] });
  const { results } = await doctor({ routes });
  const token = only(results, "token");
  assert.equal(token.level, "FAIL");
  assert.ok(token.detail.includes("Invalid API Token"), token.detail);
  assert.ok(token.detail.includes(TOKEN_PAGE), token.detail);
});

test("findZone tries each suffix from the parent down and stops at the first exact match", async () => {
  const stub = await cfStub({
    "GET /zones": (req) => [200, ok(req.query.name === "example.co.uk" ? [zone("example.co.uk", "pending")] : [])],
  });
  try {
    const cfCall = (opts) => cf({ apiBase: stub.base, apiToken: "tok", ...opts });
    const found = await findZone("sync.a.example.co.uk", cfCall);
    assert.deepEqual(found, { id: "zone-example.co.uk", name: "example.co.uk", status: "pending" });
    assert.deepEqual(stub.requests.map((r) => r.query.name), ["a.example.co.uk", "example.co.uk"]);
  } finally {
    await stub.close();
  }
});

test("findZone ignores a result whose name isn't the one asked for, and returns null when nothing matches", async () => {
  const stub = await cfStub({ "GET /zones": () => [200, ok([zone("other.example")])] });
  try {
    const cfCall = (opts) => cf({ apiBase: stub.base, apiToken: "tok", ...opts });
    assert.equal(await findZone("sync.a.example.co.uk", cfCall), null);
    assert.deepEqual(stub.requests.map((r) => r.query.name), ["a.example.co.uk", "example.co.uk", "co.uk", "sync.a.example.co.uk"]);
  } finally {
    await stub.close();
  }
});

test("findZone finds a zone whose apex is the hostname itself", async () => {
  const stub = await cfStub({ "GET /zones": (req) => [200, ok(req.query.name === "example.com" ? [zone("example.com")] : [])] });
  try {
    const cfCall = (opts) => cf({ apiBase: stub.base, apiToken: "tok", ...opts });
    assert.equal((await findZone("example.com", cfCall)).name, "example.com");
  } finally {
    await stub.close();
  }
});

test("a hostname that isn't lower case is a FAIL, and no zone lookup is made for it", async () => {
  const { results, exitCode, requests } = await doctor({ env: { SYNC_HOSTNAME: "Sync.Example.com" } });
  assert.equal(levelOf(results, "hostname"), "FAIL");
  assert.equal(requests.filter((r) => r.path === "/zones").length, 0);
  assert.equal(named(results, "zone").length, 0);
  assert.equal(named(results, "dns").length, 0);
  assert.equal(levelOf(results, "perm:zone"), "warn");
  assert.equal(exitCode, 1);
});

test("a hostname with a trailing dot, surrounding space or no value is a FAIL", async () => {
  for (const value of ["sync.example.com.", " sync.example.com", ""]) {
    const { results } = await doctor({ env: { SYNC_HOSTNAME: value } });
    assert.equal(levelOf(results, "hostname"), "FAIL", JSON.stringify(value));
  }
});

test("a pending zone is a FAIL that says so", async () => {
  const routes = greenRoutes({ "GET /zones": () => [200, ok([zone("example.com", "pending")])] });
  const { results, exitCode } = await doctor({ routes });
  const result = only(results, "zone");
  assert.equal(result.level, "FAIL");
  assert.ok(result.detail.includes("pending"), result.detail);
  assert.ok(result.detail.includes("nameservers"), result.detail);
  assert.equal(exitCode, 1);
});

test("a hostname that isn't in any zone on the account is a FAIL", async () => {
  const routes = greenRoutes({ "GET /zones": () => [200, ok([])] });
  const { results } = await doctor({ routes });
  const result = only(results, "zone");
  assert.equal(result.level, "FAIL");
  assert.ok(result.detail.includes("isn't in a zone on this account"), result.detail);
  assert.equal(named(results, "dns").length, 0);
});

test("a DNS record at the hostname with no custom domain is a FAIL: a deploy would replace it", async () => {
  const routes = greenRoutes({
    "GET /zones/zone-example.com/dns_records": () => [200, ok([{ type: "A", name: "sync.example.com", content: "192.0.2.1" }])],
  });
  const { results, exitCode, requests } = await doctor({ routes });
  const dns = only(results, "dns");
  assert.equal(dns.level, "FAIL");
  assert.ok(dns.detail.includes("would replace"), dns.detail);
  assert.ok(dns.detail.includes("in use"), dns.detail);
  assert.ok(!dns.detail.includes("192.0.2.1"), "the record's content isn't printed");
  assert.equal(exitCode, 1);
  assert.equal(requests.find((r) => r.path.endsWith("/dns_records")).query.name, "sync.example.com");
});

test("the same record is fine when the hostname is a custom domain of this Worker", async () => {
  const routes = greenRoutes({
    "GET /zones/zone-example.com/dns_records": () => [200, ok([{ type: "A", name: "sync.example.com" }])],
    "GET /accounts/acct/workers/domains": () => [200, ok([{ hostname: "sync.example.com", service: "logseq-sync", zone_id: "z" }])],
  });
  const { results, exitCode } = await doctor({ routes });
  assert.equal(levelOf(results, "dns"), "ok");
  assert.equal(exitCode, 0);
});

test("a custom domain that belongs to another Worker is still a FAIL", async () => {
  const routes = greenRoutes({
    "GET /zones/zone-example.com/dns_records": () => [200, ok([{ type: "A", name: "sync.example.com" }])],
    "GET /accounts/acct/workers/domains": () => [200, ok([{ hostname: "sync.example.com", service: "someone-else" }])],
  });
  const { results } = await doctor({ routes });
  assert.equal(levelOf(results, "dns"), "FAIL");
});

test("with the connector on, its hostname gets the same three checks against the connector Worker", async () => {
  const routes = greenRoutes({
    "GET /zones/zone-example.com/dns_records": (req) =>
      [200, ok(req.query.name === "mcp.example.com" ? [{ type: "CNAME", name: "mcp.example.com" }] : [])],
    "GET /accounts/acct/workers/domains": (req) =>
      [200, ok(req.query.hostname === "mcp.example.com" ? [{ hostname: "mcp.example.com", service: "logseq-connector" }] : [])],
  });
  const { results, exitCode } = await doctor({
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
    routes,
    gh: greenGh({ secrets: [...SECRETS, ...CONNECTOR_SECRETS], envVariable: "true" }),
  });
  for (const name of ["connector-hostname", "connector-zone", "connector-dns"]) assert.equal(levelOf(results, name), "ok", name);
  assert.equal(exitCode, 0);
});

test("a connector hostname with a record and no custom domain is a FAIL", async () => {
  const routes = greenRoutes({
    "GET /zones/zone-example.com/dns_records": (req) =>
      [200, ok(req.query.name === "mcp.example.com" ? [{ type: "A", name: "mcp.example.com" }] : [])],
  });
  const { results } = await doctor({
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
    routes,
    gh: greenGh({ secrets: [...SECRETS, ...CONNECTOR_SECRETS], envVariable: "true" }),
  });
  assert.equal(levelOf(results, "connector-dns"), "FAIL");
  assert.equal(levelOf(results, "dns"), "ok");
});

test("a bad connector hostname is a FAIL and skips its zone lookup", async () => {
  const { results, requests } = await doctor({
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "MCP.example.com" },
    gh: greenGh({ secrets: [...SECRETS, ...CONNECTOR_SECRETS], envVariable: "true" }),
  });
  assert.equal(levelOf(results, "connector-hostname"), "FAIL");
  assert.equal(named(results, "connector-zone").length, 0);
  assert.ok(!requests.some((r) => r.query?.name?.toLowerCase().startsWith("mcp.")));
});

const OBS_403 = { "POST /accounts/acct/workers/observability/telemetry/query": () => [403, fail(10000, "Authentication error")] };
const DEPLOYED = {
  "GET /accounts/acct/workers/domains": (req) =>
    [200, ok(req.query.service === "logseq-sync" ? [{ hostname: "sync.example.com", service: "logseq-sync" }] : [])],
};

test("perm:observability missing is a warn when the Worker is already deployed", async () => {
  const { results, exitCode, requests } = await doctor({ routes: greenRoutes({ ...OBS_403, ...DEPLOYED }) });
  const obs = only(results, "perm:observability");
  assert.equal(obs.level, "warn");
  assert.ok(obs.detail.includes("Workers Observability Write"), obs.detail);
  assert.ok(obs.detail.includes("allow-user.sh needs it"), obs.detail);
  assert.ok(obs.detail.includes(TOKEN_PAGE), obs.detail);
  assert.equal(exitCode, 0);
  const domains = requests.find((r) => r.path === "/accounts/acct/workers/domains" && r.query.service);
  assert.deepEqual(domains.query, { hostname: "sync.example.com", service: "logseq-sync" });
});

test("perm:observability missing is a FAIL before the first deploy", async () => {
  const { results, exitCode } = await doctor({ routes: greenRoutes(OBS_403) });
  const obs = only(results, "perm:observability");
  assert.equal(obs.level, "FAIL");
  assert.ok(obs.detail.includes(TOKEN_PAGE), obs.detail);
  assert.equal(exitCode, 1);
});

test("perm:zone missing is a warn that skips zone and dns when deployed, and a FAIL otherwise", async () => {
  const zones403 = { "GET /zones": () => [403, fail(9109, "Unauthorized to access requested resource")] };
  const deployed = await doctor({ routes: greenRoutes({ ...zones403, ...DEPLOYED }) });
  const warn = only(deployed.results, "perm:zone");
  assert.equal(warn.level, "warn");
  assert.ok(warn.detail.includes("skipped checks: zone, dns"), warn.detail);
  assert.ok(warn.detail.includes("Zone Read"), warn.detail);
  assert.ok(warn.detail.includes(TOKEN_PAGE), warn.detail);
  assert.equal(named(deployed.results, "zone").length, 0);
  assert.equal(named(deployed.results, "dns").length, 0);
  assert.equal(deployed.exitCode, 0);

  const fresh = await doctor({ routes: greenRoutes(zones403) });
  assert.equal(levelOf(fresh.results, "perm:zone"), "FAIL");
  assert.equal(fresh.exitCode, 1);
});

test("a permission the deploy already uses is always a FAIL, even when deployed", async () => {
  const routes = greenRoutes({ ...DEPLOYED, "GET /accounts/acct/d1/database": () => [403, fail(10000, "Authentication error")] });
  const { results, exitCode } = await doctor({ routes });
  const d1 = only(results, "perm:d1");
  assert.equal(d1.level, "FAIL");
  assert.ok(d1.detail.includes("D1 Edit"), d1.detail);
  assert.ok(d1.detail.includes(TOKEN_PAGE), d1.detail);
  assert.equal(exitCode, 1);
});

test("a 401 counts as a missing permission too", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/d1/database": () => [401, fail(10000, "Authentication error")] });
  const { results } = await doctor({ routes });
  assert.ok(only(results, "perm:d1").detail.includes(TOKEN_PAGE));
});

test("R2 not enabled (10042) is the r2-enabled FAIL, and perm:r2 isn't reported as missing", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/r2/buckets": () => [403, fail(10042, "Please enable R2 through the Cloudflare Dashboard.")] });
  const { results, exitCode } = await doctor({ routes });
  const r2 = only(results, "r2-enabled");
  assert.equal(r2.level, "FAIL");
  assert.ok(r2.detail.includes("R2 isn't enabled on this account. Enable it at dash.cloudflare.com → R2"), r2.detail);
  assert.notEqual(levelOf(results, "perm:r2"), "FAIL");
  assert.ok(!only(results, "perm:r2").detail.includes(TOKEN_PAGE));
  assert.equal(exitCode, 1);
});

test("a call that fails for another reason is a FAIL that says what the API said", async () => {
  const routes = greenRoutes({ "GET /accounts/acct/d1/database": () => [500, fail(1, "boom")] });
  const { results } = await doctor({ routes });
  const d1 = only(results, "perm:d1");
  assert.equal(d1.level, "FAIL");
  assert.ok(d1.detail.includes("boom"), d1.detail);
  assert.ok(!d1.detail.includes(TOKEN_PAGE), "not a missing-permission message");
});

test("missing Cloudflare credentials are a FAIL on token, with no Cloudflare calls", async () => {
  const { results, requests, exitCode } = await doctor({ env: { CLOUDFLARE_API_TOKEN: "" } });
  assert.equal(levelOf(results, "token"), "FAIL");
  assert.equal(requests.length, 0);
  assert.equal(exitCode, 1);
});

test("a missing secret name is a FAIL that names it", async () => {
  const secrets = SECRETS.filter((name) => name !== "SYNC_HOSTNAME");
  const { results, exitCode } = await doctor({ gh: greenGh({ secrets }) });
  const result = only(results, "secrets");
  assert.equal(result.level, "FAIL");
  assert.ok(result.detail.includes("SYNC_HOSTNAME"), result.detail);
  assert.ok(result.detail.includes("setup.sh"), result.detail);
  assert.equal(exitCode, 1);
});

test("with the connector on, the six connector secret names are required too", async () => {
  const { results } = await doctor({
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
    gh: greenGh({ secrets: SECRETS, envVariable: "true" }),
  });
  const result = only(results, "secrets");
  assert.equal(result.level, "FAIL");
  for (const name of CONNECTOR_SECRETS) assert.ok(result.detail.includes(name), name);
});

test("secrets are listed by name from the production environment, never read", async () => {
  const gh = greenGh();
  await doctor({ gh });
  const call = gh.calls.find((args) => args[0] === "secret");
  assert.deepEqual(call, ["secret", "list", "-R", REPO, "--env", "production", "--json", "name"]);
});

test("connector-setting fails when the GitHub variable and .env.local disagree, and shows both", async () => {
  const { results, exitCode } = await doctor({
    gh: greenGh({ envVariable: "true" }),
    env: { CONNECTOR_ENABLED: "false" },
  });
  const setting = only(results, "connector-setting");
  assert.equal(setting.level, "FAIL");
  assert.ok(setting.detail.includes("true") && setting.detail.includes("false"), setting.detail);
  assert.ok(setting.detail.includes("README 11.5"), setting.detail);
  assert.equal(exitCode, 1);
});

test("connector-setting: the environment variable wins over the repository one, and unset means false", async () => {
  const envWins = await doctor({ gh: greenGh({ envVariable: "false", repoVariable: "true" }) });
  assert.equal(levelOf(envWins.results, "connector-setting"), "ok");

  const repoLevel = await doctor({
    gh: greenGh({ repoVariable: "true", secrets: [...SECRETS, ...CONNECTOR_SECRETS] }),
    env: { CONNECTOR_ENABLED: "true", CONNECTOR_HOSTNAME: "mcp.example.com" },
  });
  assert.equal(levelOf(repoLevel.results, "connector-setting"), "ok");

  const unsetBoth = await doctor({ env: { CONNECTOR_ENABLED: "" } });
  assert.equal(levelOf(unsetBoth.results, "connector-setting"), "ok");

  const emptyVariable = await doctor({ gh: greenGh({ envVariable: "" }) });
  assert.equal(levelOf(emptyVariable.results, "connector-setting"), "ok");
});

test("connector-setting: a failure reading the variables is a FAIL, not an unset variable", async () => {
  const failures = [
    ["variable", { status: 1, stdout: "", stderr: "error connecting to api.github.com\n" }],
    [`variable list --env production`, { status: 1, stdout: "", stderr: "gh: Resource not accessible by personal access token (HTTP 403)\n" }],
    [`variable list --json`, { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }],
    ["variable", { status: 0, stdout: "not json" }],
  ];
  for (const failure of failures) {
    const { results, exitCode } = await doctor({ gh: greenGh({ extra: [failure] }) });
    const setting = only(results, "connector-setting");
    assert.equal(setting.level, "FAIL", JSON.stringify(failure));
    assert.ok(setting.detail.includes("gh variable list"), setting.detail);
    assert.equal(exitCode, 1);
  }
});

test("connector-setting: no production environment (a 404 listing its variables) falls back to the repository variable", async () => {
  const missingEnv = [`variable list --env production`, { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }];
  const { results } = await doctor({
    gh: greenGh({ repoVariable: "true", extra: [missingEnv] }),
    env: { CONNECTOR_ENABLED: "false" },
  });
  const setting = only(results, "connector-setting");
  assert.equal(setting.level, "FAIL");
  assert.ok(setting.detail.startsWith("CONNECTOR_ENABLED is true on GitHub but false in .env.local"), setting.detail);
});

test("a workflow that isn't active is a warn, and a missing one too", async () => {
  const workflows = [{ name: "backup", state: "disabled_fork" }, { name: "usage", state: "active" }];
  const { results, exitCode } = await doctor({ gh: greenGh({ workflows }) });
  const schedules = named(results, "schedules");
  assert.deepEqual(schedules.map((r) => r.level), ["warn", "warn"]);
  assert.ok(schedules[0].detail.includes("backup") && schedules[0].detail.includes("disabled_fork"), schedules[0].detail);
  assert.ok(schedules[0].detail.includes("gh workflow enable backup"), schedules[0].detail);
  assert.ok(schedules[1].detail.includes("bump-upstream"), schedules[1].detail);
  assert.equal(exitCode, 0);
});

test("a fork is checked for sync-upstream, not bump-upstream", async () => {
  const workflows = [
    { name: "backup", state: "active" },
    { name: "usage", state: "active" },
    { name: "bump-upstream", state: "disabled_manually" },
    { name: "sync-upstream", state: "active" },
  ];
  const fork = await doctor({ gh: greenGh({ fork: true, workflows }) });
  assert.equal(levelOf(fork.results, "schedules"), "ok");
  const original = await doctor({ gh: greenGh({ fork: false, workflows }) });
  const [warning] = named(original.results, "schedules");
  assert.equal(warning.level, "warn");
  assert.ok(warning.detail.includes("bump-upstream"), warning.detail);
});

test("GitHub Actions disabled is a FAIL that says where to enable it", async () => {
  const gh = greenGh({
    extra: [[`api repos/${REPO}/actions/permissions`, { status: 0, stdout: JSON.stringify({ enabled: false }) }]],
  });
  const { results, exitCode } = await doctor({ gh });
  const actions = only(results, "actions");
  assert.equal(actions.level, "FAIL");
  assert.ok(actions.detail.includes("Settings"), actions.detail);
  assert.equal(exitCode, 1);
});

test("an environment with no branch restriction is a FAIL, and so is a missing one", async () => {
  const open = await doctor({
    gh: greenGh({
      extra: [[`api repos/${REPO}/environments/production`, { status: 0, stdout: JSON.stringify({ deployment_branch_policy: null }) }]],
    }),
  });
  assert.equal(levelOf(open.results, "environment"), "FAIL");
  assert.ok(only(open.results, "environment").detail.includes("setup.sh"));

  const missing = await doctor({ gh: greenGh({ extra: [[`api repos/${REPO}/environments/production`, { status: 1, stdout: "" }]] }) });
  assert.equal(levelOf(missing.results, "environment"), "FAIL");
});

test("a restricted environment with no main branch policy is a FAIL: every deploy of main would be refused", async () => {
  for (const listed of [[], [{ name: "release", type: "branch" }], [{ name: "main", type: "tag" }]]) {
    const gh = greenGh({ extra: [[`api ${POLICIES}?per_page=100`, { status: 0, stdout: policies(...listed) }]] });
    const { results, exitCode } = await doctor({ gh });
    const environment = only(results, "environment");
    assert.equal(environment.level, "FAIL", JSON.stringify(listed));
    assert.ok(environment.detail.includes("main"), environment.detail);
    assert.ok(environment.detail.includes("scripts/setup.sh"), environment.detail);
    assert.equal(exitCode, 1);
  }
  const unreadable = await doctor({ gh: greenGh({ extra: [[`api ${POLICIES}`, { status: 1, stdout: "" }]] }) });
  assert.equal(levelOf(unreadable.results, "environment"), "FAIL");
});

test("gh not installed or not logged in is one FAIL, and no other GitHub check runs", async () => {
  const gh = { gh: () => ({ status: 127, stdout: "" }), calls: [] };
  const { results, exitCode } = await doctor({ gh });
  const github = only(results, "github");
  assert.equal(github.level, "FAIL");
  assert.equal(github.detail, "gh isn't installed or logged in (gh auth login)");
  for (const name of ["actions", "environment", "secrets", "connector-setting", "schedules"]) {
    assert.equal(named(results, name).length, 0, name);
  }
  // The Cloudflare and local checks still ran.
  assert.equal(levelOf(results, "token"), "ok");
  assert.equal(levelOf(results, "env-mode"), "ok");
  assert.equal(exitCode, 1);
});

test("DOCTOR_SKIP_GITHUB=1 skips the five GitHub checks, makes no gh call, and says so", async () => {
  const gh = greenGh();
  const { results, exitCode, ghCalls } = await doctor({ env: { DOCTOR_SKIP_GITHUB: "1" }, gh });
  assert.deepEqual(ghCalls, []);
  for (const name of ["actions", "environment", "secrets", "connector-setting", "schedules"]) {
    assert.equal(named(results, name).length, 0, name);
  }
  const skipped = only(results, "github");
  assert.deepEqual([skipped.level, skipped.detail], ["skip", "setup.sh configures it next"]);
  // The Cloudflare and local checks still ran, and a skip isn't a failure.
  assert.equal(levelOf(results, "token"), "ok");
  assert.equal(levelOf(results, "env-mode"), "ok");
  assert.equal(exitCode, 0);
});

test("DOCTOR_SKIP_GITHUB=1 prints `skip github: setup.sh configures it next` from the CLI", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const out = await runCli({ envLocal, env: { DOCTOR_SKIP_GITHUB: "1" } });
  assert.equal(out.status, 0, out.stdout);
  assert.ok(out.stdout.split("\n").includes("skip github: setup.sh configures it next"), out.stdout);
  assert.ok(out.stdout.includes("doctor: 0 failed, 0 warnings"), out.stdout);
});

test("env-mode: .env.local must be mode 600", async () => {
  const loose = await doctor({ repo: repoDir({ mode: 0o644 }) });
  const result = only(loose.results, "env-mode");
  assert.equal(result.level, "FAIL");
  assert.ok(result.detail.includes("chmod 600 .env.local"), result.detail);
  assert.equal(loose.exitCode, 1);

  const missing = await doctor({ repo: repoDir({ envLocal: null }) });
  assert.equal(levelOf(missing.results, "env-mode"), "FAIL");
});

test("allowed-users: a malformed list is a FAIL with the parser's message, and none is fine", async () => {
  const bad = await doctor({ env: { DB_SYNC_ALLOWED_USERS: "not-a-uuid" } });
  const result = only(bad.results, "allowed-users");
  assert.equal(result.level, "FAIL");
  assert.ok(result.detail.includes("entry 1 of 1"), result.detail);
  assert.ok(!result.detail.includes("not-a-uuid"), "the entry isn't echoed");

  const none = await doctor({ env: { DB_SYNC_ALLOWED_USERS: "none" } });
  assert.equal(levelOf(none.results, "allowed-users"), "ok");
});

test("results never contain the token, the account ID or a user ID, in any outcome", async () => {
  const scenarios = [
    {},
    { env: { SYNC_HOSTNAME: "Sync.Example.com" } },
    { routes: greenRoutes({ "GET /accounts/acct/tokens/verify": () => [200, ok({ status: "disabled" })] }) },
    { routes: greenRoutes({ "GET /accounts/acct/d1/database": () => [403, fail(10000, "Authentication error")] }) },
    { routes: greenRoutes({ "GET /zones": () => [200, ok([zone("example.com", "pending")])] }) },
    { routes: greenRoutes({ "GET /zones/zone-example.com/dns_records": () => [200, ok([{ type: "A", content: "192.0.2.1" }])] }) },
    { routes: greenRoutes(OBS_403) },
    { gh: greenGh({ envVariable: "true" }) },
    { gh: { gh: () => ({ status: 127, stdout: "" }), calls: [] } },
    { env: { DB_SYNC_ALLOWED_USERS: USER.replace("a", "A") } },
  ];
  for (const scenario of scenarios) {
    const { results } = await doctor(scenario);
    const text = JSON.stringify(results);
    assert.ok(!/\btok\b/.test(text), text);
    assert.ok(!/\bacct\b/.test(text), text);
    assert.ok(!text.includes(USER), text);
  }
});

// ---- doctor.sh and the CLI ----

const doctorSh = join(root, "scripts", "doctor.sh");

test("doctor.sh with no .env.local exits 1 and says to run setup", async () => {
  const dir = repoDir({ envLocal: null });
  const out = await runScript(doctorSh, [], { env: { DOCTOR_TEST: "1", DOCTOR_REPO_ROOT: dir } });
  assert.equal(out.status, 1);
  assert.equal(out.stderr.trim(), "doctor: no .env.local; run scripts/setup.sh first");
});

test("DOCTOR_REPO_ROOT is refused without DOCTOR_TEST=1", async () => {
  const dir = repoDir({ envLocal: null });
  const out = await runScript(doctorSh, [], { env: { DOCTOR_TEST: "", DOCTOR_REPO_ROOT: dir } });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("DOCTOR_REPO_ROOT is test-only and requires DOCTOR_TEST=1"), out.stderr);
});

/**
 * Runs doctor.sh against a Cloudflare stub and a stubbed `gh`, in a temp clone that holds .env.local.
 * The clone's `origin` is REPO and its `upstream` the parent, which gh picks when given no repo.
 */
async function runCli({ envLocal, env = {}, routes = greenRoutes(), mode = 0o600 } = {}) {
  const dir = repoDir({ envLocal, mode });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: dir });
  execFileSync("git", ["remote", "add", "upstream", `https://github.com/${PARENT}.git`], { cwd: dir });
  const ghDir = mkdtempSync(join(tmpdir(), "doctor-gh-"));
  const { bin, calls } = stubGh(ghDir, [
    { match: ["repo", "view", ORIGIN], stdout: JSON.stringify({ nameWithOwner: REPO, isFork: false }) },
    { match: ["repo", "view"], stdout: JSON.stringify({ nameWithOwner: PARENT, isFork: false }) },
    { match: ["api", `repos/${REPO}/actions/permissions`], stdout: JSON.stringify({ enabled: true }) },
    { match: ["api", `${POLICIES}?per_page=100`], stdout: policies(MAIN_POLICY) },
    {
      match: ["api", `repos/${REPO}/environments/production`],
      stdout: JSON.stringify({ deployment_branch_policy: { custom_branch_policies: true } }),
    },
    { match: ["secret", "list"], stdout: JSON.stringify(SECRETS.map((name) => ({ name }))) },
    { match: ["variable", "list"], stdout: "[]" },
    {
      match: ["workflow", "list"],
      stdout: JSON.stringify(["backup", "usage", "bump-upstream"].map((name) => ({ name, state: "active" }))),
    },
  ]);
  const stub = await cfStub(routes);
  try {
    const out = await runScript(doctorSh, [], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DOCTOR_TEST: "1", DOCTOR_REPO_ROOT: dir, CF_API_TEST: "1", CF_API_BASE: stub.base,
        CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "", SYNC_HOSTNAME: "", CONNECTOR_HOSTNAME: "",
        CONNECTOR_ENABLED: "", SEMANTIC_SEARCH_ENABLED: "", DB_SYNC_ALLOWED_USERS: "",
        ...env,
      },
    });
    return { ...out, requests: stub.requests, ghCalls: calls().map((c) => c.argv) };
  } finally {
    await stub.close();
  }
}

test("doctor.sh reads .env.local, prints one line per check and a summary, and exits 0 when all is well", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const out = await runCli({ envLocal });
  assert.equal(out.stderr, "");
  assert.equal(out.status, 0, out.stdout);
  const lines = out.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), "doctor: 0 failed, 0 warnings");
  assert.ok(lines.includes("ok   token: the token is active"), out.stdout);
  assert.ok(lines.every((line) => /^(ok  |warn|FAIL) \S+: .+$/.test(line) || line.startsWith("doctor: ")), out.stdout);
  assert.ok(!/\btok\b/.test(out.stdout) && !/\bacct\b/.test(out.stdout), out.stdout);
});

test("doctor.sh checks the repo the origin remote points at, never the parent gh would pick", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const out = await runCli({ envLocal });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.ghCalls[0], ["repo", "view", ORIGIN, "--json", "nameWithOwner,isFork"]);
  assert.ok(!out.ghCalls.flat().some((arg) => arg.includes(PARENT)), JSON.stringify(out.ghCalls));
});

test("a checkout with no origin remote is one github FAIL, and no gh call is made", async () => {
  const gh = greenGh();
  const { results, ghCalls } = await doctor({ gh, originUrl: "" });
  const github = only(results, "github");
  assert.equal(github.level, "FAIL");
  assert.ok(github.detail.includes("git remote get-url origin"), github.detail);
  assert.deepEqual(ghCalls, []);
});

test("doctor.sh: a value the caller already set wins over .env.local, and exit 1 follows a FAIL", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=Bad.Example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const failing = await runCli({ envLocal });
  assert.equal(failing.status, 1);
  assert.ok(failing.stdout.includes("FAIL hostname:"), failing.stdout);
  assert.ok(failing.stdout.includes("doctor: 1 failed, 1 warnings"), failing.stdout);

  const overridden = await runCli({ envLocal, env: { SYNC_HOSTNAME: "sync.example.com" } });
  assert.equal(overridden.status, 0, overridden.stdout);
  assert.ok(overridden.requests.some((r) => r.path === "/zones" && r.query.name === "example.com"));
});

test("doctor.sh: a .env.local with a loose mode is reported, not read as a reason to stop", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const out = await runCli({ envLocal, mode: 0o644 });
  assert.equal(out.status, 1);
  assert.ok(out.stdout.includes("FAIL env-mode:"), out.stdout);
});

test("the CLI refuses CF_API_BASE without CF_API_TEST=1 instead of using the default base", async () => {
  const envLocal = `CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${USER}\n`;
  const out = await runCli({ envLocal, env: { CF_API_TEST: "" } });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("CF_API_BASE is test-only and requires CF_API_TEST=1"), out.stderr);
  assert.equal(out.requests.length, 0);
});
