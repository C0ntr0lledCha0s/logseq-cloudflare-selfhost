import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript, stubGh } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enableSh = join(root, "scripts", "enable-connector.sh");
const REPO = "example/logseq-selfhost";
const ORIGIN = `https://github.com/${REPO}.git`;
// The repo a fork was made from: `gh repo view` with no repo argument names it in a clone with an `upstream` remote.
const PARENT = "upstream-owner/logseq-selfhost";
const PARENT_URL = `https://github.com/${PARENT}.git`;
const NOT_FOUND = "gh: Not Found (HTTP 404)\n";
const FORBIDDEN = "gh: Resource not accessible by personal access token (HTTP 403)\n";
const CONNECTOR_NAMES = ["CONNECTOR_HOSTNAME", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "OWNER_GITHUB_USER_ID"];

const baseEnv = (connectorEnabled = "false") =>
  `CLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_ACCOUNT_ID=acct\nSYNC_HOSTNAME=sync.example.com\nCONNECTOR_ENABLED=${connectorEnabled}\n`;

// Stub scripts record `<name> <args>` in $ENABLE_STUB_LOG, the connector inputs init-env.sh was
// called with in $ENABLE_STUB_LOG.env, and the CONNECTOR_ENABLED line doctor.sh saw in
// $ENABLE_STUB_LOG.doctor. A call whose logged line starts with an entry of `failing` exits 1.
const stub = (name, failing) => `#!/usr/bin/env bash
echo "${name} $*" >> "$ENABLE_STUB_LOG"
if [ "${name}" = "init-env.sh" ]; then
  for n in ${CONNECTOR_NAMES.join(" ")}; do echo "$n=\${!n:-}" >> "$ENABLE_STUB_LOG.env"; done
fi
if [ "${name}" = "doctor.sh" ]; then
  grep '^CONNECTOR_ENABLED=' "$(dirname "$0")/../.env.local" >> "$ENABLE_STUB_LOG.doctor"
fi
${failing.map((f) => `case "${name} $*" in ${JSON.stringify(f)}*) exit 1 ;; esac`).join("\n")}
`;

/** A temp git repo root: stub scripts, the real env-file.mjs and lib/gh.sh, a .env.local (or none), and an origin (plus an upstream when given). */
function makeRoot({ envLocal, failing = [], upstream = null }) {
  const dir = mkdtempSync(join(tmpdir(), "enable-connector-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  for (const name of ["init-env.sh", "doctor.sh", "run-deploy.sh"]) {
    writeFileSync(join(dir, "scripts", name), stub(name, failing));
    chmodSync(join(dir, "scripts", name), 0o755);
  }
  for (const name of ["env-file.mjs", "lib/gh.sh"]) copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
  if (envLocal !== null) {
    writeFileSync(join(dir, ".env.local"), envLocal);
    chmodSync(join(dir, ".env.local"), 0o600);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: dir });
  if (upstream !== null) execFileSync("git", ["remote", "add", "upstream", upstream], { cwd: dir });
  return dir;
}

// The `CONNECTOR_ENABLED` variable lists, environment and repository level, as `gh variable list --json name,value`.
const ENV_VARIABLES = ["variable", "list", "--env", "production", "--json", "name,value", "-R", REPO];
const REPO_VARIABLES = ["variable", "list", "--json", "name,value", "-R", REPO];
const listed = (value) => `${JSON.stringify(value === undefined ? [] : [{ name: "CONNECTOR_ENABLED", value }])}\n`;
const envVariable = (value) => ({ match: ENV_VARIABLES, stdout: listed(value) });
const repoVariable = (value) => ({ match: REPO_VARIABLES, stdout: listed(value) });

// The production secrets of a finished setup whose connector secrets are pushed too.
const ALL_SECRETS = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE", "ASSET_LINK_SECRET",
  "DB_SYNC_ADMIN_TOKEN", "DB_SYNC_ALLOWED_USERS", "SYNC_HOSTNAME",
  "CONNECTOR_HOSTNAME", "CONNECTOR_GITHUB_CLIENT_ID", "CONNECTOR_GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY",
];
const SECRET_LIST = ["secret", "list", "--env", "production", "--json", "name", "-R", REPO];
const secretList = (names) => ({ match: SECRET_LIST, stdout: `${JSON.stringify(names.map((name) => ({ name })))}\n` });

/** `gh` rules for a connector that is off (the variable is unset at both levels). `over` rules come first, so they win. */
const ghRules = (over = []) => [
  ...over,
  { match: ["repo", "view", ORIGIN, "--json", "nameWithOwner"], stdout: `${REPO}\n` },
  // gh's own choice in a clone with an `upstream` remote.
  { match: ["repo", "view"], stdout: `${PARENT}\n` },
  envVariable(),
  repoVariable(),
  secretList(ALL_SECRETS),
  // What gh 2.87.3 says for an unset variable, with or without --env: no "HTTP 404".
  { match: ["variable", "get"], stderr: "variable CONNECTOR_ENABLED was not found\n", exit: 1 },
  { match: ["api", "user", "-q", ".id"], stdout: "12345\n" },
  { match: ["api", "user", "-q", ".login"], stdout: "octocat\n" },
  { match: ["variable", "set"] },
];

/** Runs enable-connector.sh in a temp root. Returns the result, the stub-script log, the inputs init-env.sh saw and the `gh` calls. */
async function enable({ input = "mcp.example.com\nclient-id\nclient-secret\n", rules = ghRules(), envLocal = baseEnv(), failing = [], upstream = null, env = {} } = {}) {
  const dir = makeRoot({ envLocal, failing, upstream });
  const gh = stubGh(dir, rules);
  const log = join(dir, "stub.log");
  const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  try {
    const out = await runScript(enableSh, [], {
      cwd: dir,
      input,
      env: {
        PATH: `${gh.bin}:${process.env.PATH}`,
        ENABLE_CONNECTOR_TEST: "1",
        ENABLE_CONNECTOR_REPO_ROOT: dir,
        ENABLE_STUB_LOG: log,
        ...env,
      },
    });
    return {
      ...out,
      scripts: lines(log),
      inputs: Object.fromEntries(lines(`${log}.env`).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
      ghCalls: gh.calls().map((c) => c.argv),
      doctorSaw: lines(`${log}.doctor`),
      envLocal: existsSync(join(dir, ".env.local")) ? readFileSync(join(dir, ".env.local"), "utf8") : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const variableSets = (calls) => calls.filter((a) => a[0] === "variable" && a[1] === "set");

test("a first run takes the hostname and OAuth details, pushes secrets, turns the connector on, checks, then deploys", async () => {
  const out = await enable();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "doctor.sh ", "run-deploy.sh "]);
  assert.deepEqual(out.inputs, {
    CONNECTOR_HOSTNAME: "mcp.example.com",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    OWNER_GITHUB_USER_ID: "12345",
  });
  assert.ok(out.envLocal.endsWith("CONNECTOR_ENABLED=true\n"), out.envLocal);
  assert.deepEqual(variableSets(out.ghCalls), [["variable", "set", "CONNECTOR_ENABLED", "--env", "production", "--body", "true", "-R", REPO]]);
  assert.ok(out.stdout.includes("Owner: octocat (from gh)"), out.stdout);
  assert.ok(out.stdout.includes("Homepage URL:                https://mcp.example.com\n"), out.stdout);
  assert.ok(out.stdout.includes("Authorization callback URL:  https://mcp.example.com/callback\n"), out.stdout);
  assert.ok(out.stdout.includes("https://mcp.example.com/mcp"), out.stdout);
  assert.ok(!(out.stdout + out.stderr).includes("client-secret"), "the client secret is never printed");
  assert.ok(!out.ghCalls.flat().includes("client-secret"), "the client secret is never a gh argument");
});

test("a fork clone with an upstream remote turns the connector on in the origin repo, never the parent", async () => {
  const out = await enable({ upstream: PARENT_URL });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const views = out.ghCalls.filter((a) => a[0] === "repo" && a[1] === "view");
  assert.deepEqual(views.map((a) => a[2]), [ORIGIN]);
  assert.ok(!out.ghCalls.flat().some((arg) => arg.includes(PARENT)), JSON.stringify(out.ghCalls));
  for (const call of out.ghCalls.filter((a) => a[0] === "variable")) assert.equal(call[call.indexOf("-R") + 1], REPO, call.join(" "));
});

test("the hostname is lower-cased and the OAuth details can come from the environment, without prompts", async () => {
  const out = await enable({
    input: "",
    env: { CONNECTOR_HOSTNAME: "MCP.Example.com", GITHUB_CLIENT_ID: "env-id", GITHUB_CLIENT_SECRET: "env-secret" },
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.inputs.CONNECTOR_HOSTNAME, "mcp.example.com");
  assert.equal(out.inputs.GITHUB_CLIENT_ID, "env-id");
  assert.equal(out.inputs.GITHUB_CLIENT_SECRET, "env-secret");
  assert.ok(!(out.stdout + out.stderr).includes("env-secret"));
});

test("a hostname outside the sync server's domain is refused before anything changes", async () => {
  const out = await enable({ input: "mcp.other.org\n" });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("the connector hostname must be in the same domain as example.com"), out.stderr);
  assert.deepEqual(out.scripts, []);
  assert.deepEqual(variableSets(out.ghCalls), []);
  assert.ok(out.envLocal.includes("CONNECTOR_ENABLED=false"), "the setting is untouched");
});

test("a hostname that only ends with the domain's text, not a dot and the domain, is refused", async () => {
  const out = await enable({ input: "mcpexample.com\n" });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("same domain"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

const alreadyOn = (extra = {}) => ({
  envLocal: `${baseEnv("true")}CONNECTOR_HOSTNAME=mcp.example.com\n`,
  rules: ghRules([envVariable("true")]),
  ...extra,
});

test("when the connector is already on in .env.local and on GitHub, it checks, deploys only if the last deploy isn't green, and prints the next steps", async () => {
  const out = await enable(alreadyOn());
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes("the connector is already on"), out.stdout);
  assert.deepEqual(out.scripts, ["doctor.sh ", "run-deploy.sh --if-not-green"]);
  assert.deepEqual(variableSets(out.ghCalls), []);
  assert.deepEqual(out.ghCalls.map((a) => a.slice(0, 2).join(" ")), ["repo view", "variable list", "variable list", "secret list"]);
  assert.ok(out.stdout.includes("https://mcp.example.com/mcp"), out.stdout);
});

test("already on with a failing doctor exits 1 without deploying, and says a re-run continues", async () => {
  const out = await enable(alreadyOn({ failing: ["doctor.sh"] }));
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["doctor.sh "]);
  assert.ok(out.stderr.includes("fix the FAIL lines above, then re-run scripts/enable-connector.sh"), out.stderr);
  assert.ok(!out.stderr.includes("already on"), out.stderr);
});

test("already on with a failing deploy exits 1 and prints no next steps", async () => {
  const out = await enable(alreadyOn({ failing: ["run-deploy.sh"] }));
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["doctor.sh ", "run-deploy.sh --if-not-green"]);
  assert.ok(!out.stdout.includes("https://mcp.example.com/mcp"), out.stdout);
});

test("already on but no CONNECTOR_HOSTNAME in .env.local stops before any check", async () => {
  const out = await enable(alreadyOn({ envLocal: baseEnv("true") }));
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("CONNECTOR_HOSTNAME isn't set in .env.local"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("on in .env.local but unset on GitHub carries on and sets the variable", async () => {
  const out = await enable({ envLocal: baseEnv("true") });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(variableSets(out.ghCalls).length, 1);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "doctor.sh ", "run-deploy.sh "]);
});

test("the variable is read from the lists, never with gh variable get, whose 'was not found' isn't a 404", async () => {
  const out = await enable();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(!out.ghCalls.some((a) => a[0] === "variable" && a[1] === "get"), JSON.stringify(out.ghCalls));
  assert.deepEqual(out.ghCalls.filter((a) => a[0] === "variable" && a[1] === "list"), [ENV_VARIABLES, REPO_VARIABLES]);
});

test("no production environment yet (a 404 listing its variables) counts as unset there", async () => {
  const out = await enable({ rules: ghRules([{ match: ENV_VARIABLES, stderr: NOT_FOUND, exit: 1 }]) });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(variableSets(out.ghCalls).length, 1);
});

test("the repository variable counts when the environment has none, as the deploy reads it", async () => {
  const out = await enable(alreadyOn({ rules: ghRules([repoVariable("true")]) }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes("the connector is already on"), out.stdout);
  assert.deepEqual(out.scripts, ["doctor.sh ", "run-deploy.sh --if-not-green"]);
});

test("the environment variable wins over the repository one, so false there means off", async () => {
  const out = await enable(alreadyOn({ rules: ghRules([envVariable("false"), repoVariable("true")]) }));
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(!out.stdout.includes("the connector is already on"), out.stdout);
  assert.deepEqual(variableSets(out.ghCalls).length, 1);
});

test("on on GitHub but off in .env.local carries on and corrects the file", async () => {
  const out = await enable({ rules: ghRules([envVariable("true")]) });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.envLocal.endsWith("CONNECTOR_ENABLED=true\n"), out.envLocal);
});

test("a failing doctor turns both switches back off, stops before the deploy, and says a re-run continues", async () => {
  const out = await enable({ failing: ["doctor.sh"] });
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "doctor.sh "]);
  assert.deepEqual(out.doctorSaw, ["CONNECTOR_ENABLED=true"], "the checks ran with the switch on");
  assert.deepEqual(variableSets(out.ghCalls), [
    ["variable", "set", "CONNECTOR_ENABLED", "--env", "production", "--body", "true", "-R", REPO],
    ["variable", "set", "CONNECTOR_ENABLED", "--env", "production", "--body", "false", "-R", REPO],
  ]);
  assert.equal(out.envLocal, baseEnv("false"), ".env.local is as it was");
  assert.ok(out.stderr.includes("fix the FAIL lines above, then re-run scripts/enable-connector.sh"), out.stderr);
  assert.ok(out.stderr.includes("switched the connector off again"), out.stderr);
});

test("a failing doctor puts back the .env.local line's own old value, whatever it was", async () => {
  // On locally but unset on GitHub: the full path runs, and the file goes back to true.
  const envLocal = `${baseEnv("true")}# keep me\n`;
  const out = await enable({ envLocal, failing: ["doctor.sh"] });
  assert.equal(out.status, 1);
  assert.equal(out.envLocal, envLocal);
  assert.deepEqual(variableSets(out.ghCalls).map((a) => a[6]), ["true", "false"]);
  assert.ok(!out.scripts.some((l) => l.startsWith("run-deploy.sh")), "no deploy");
});

test("connector secrets missing on GitHub are pushed from .env.local, on the already-on path too", async () => {
  // An earlier run appended every value, then its push failed part-way: init-env --add-missing now finds nothing to add.
  const present = ALL_SECRETS.filter((n) => n !== "CONNECTOR_GITHUB_CLIENT_SECRET" && n !== "GRAPH_TOKEN_KEY");
  const values = `CONNECTOR_HOSTNAME=mcp.example.com\nGITHUB_CLIENT_ID=file-id\nGITHUB_CLIENT_SECRET=file-secret\nOWNER_GITHUB_USER_ID=777\n`;

  const on = await enable({ input: "", envLocal: `${baseEnv("true")}${values}`, rules: ghRules([envVariable("true"), secretList(present)]) });
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.deepEqual(on.scripts, ["init-env.sh --push-only GITHUB_CLIENT_SECRET GRAPH_TOKEN_KEY", "doctor.sh ", "run-deploy.sh --if-not-green"]);

  const off = await enable({ input: "", envLocal: `${baseEnv()}${values}`, rules: ghRules([secretList(present)]) });
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.deepEqual(off.scripts, [
    "init-env.sh --add-missing --push",
    "init-env.sh --push-only GITHUB_CLIENT_SECRET GRAPH_TOKEN_KEY",
    "doctor.sh ",
    "run-deploy.sh ",
  ]);
  assert.ok(!(on.stdout + on.stderr + off.stdout + off.stderr).includes("file-secret"));
});

test("a failed push of the missing connector secrets stops before the switches change", async () => {
  const present = ALL_SECRETS.filter((n) => n !== "GRAPH_TOKEN_KEY");
  const out = await enable({ rules: ghRules([secretList(present)]), failing: ["init-env.sh --push-only"] });
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "init-env.sh --push-only GRAPH_TOKEN_KEY"]);
  assert.deepEqual(variableSets(out.ghCalls), []);
  assert.ok(out.envLocal.includes("CONNECTOR_ENABLED=false"));
});

test("a failing deploy exits 1 and says a re-run continues", async () => {
  const out = await enable({ failing: ["run-deploy.sh"] });
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "doctor.sh ", "run-deploy.sh "]);
  assert.ok(out.stderr.includes("the deploy didn't succeed"), out.stderr);
  assert.ok(out.stderr.includes("re-run scripts/enable-connector.sh"), out.stderr);
  assert.ok(!out.stdout.includes("https://mcp.example.com/mcp"), "no next steps after a failed deploy");
});

test("a failing init-env stops before the setting changes", async () => {
  const out = await enable({ failing: ["init-env.sh"] });
  assert.equal(out.status, 1);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push"]);
  assert.deepEqual(variableSets(out.ghCalls), []);
  assert.ok(out.envLocal.includes("CONNECTOR_ENABLED=false"));
});

test("values already in .env.local are used, not asked for or looked up again", async () => {
  const envLocal = `${baseEnv()}CONNECTOR_HOSTNAME=mcp.example.com\nGITHUB_CLIENT_ID=file-id\nGITHUB_CLIENT_SECRET=file-secret\nOWNER_GITHUB_USER_ID=777\n`;
  const out = await enable({ input: "", envLocal, rules: ghRules([{ match: ["api", "user"], stderr: "unstubbed", exit: 1 }]) });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.scripts, ["init-env.sh --add-missing --push", "doctor.sh ", "run-deploy.sh "]);
  assert.ok(!out.ghCalls.some((a) => a[0] === "api"), "gh api user isn't called");
  assert.ok(out.stdout.includes("https://mcp.example.com/mcp"), out.stdout);
  assert.ok(!(out.stdout + out.stderr).includes("file-secret"));
});

test("a hostname already in .env.local that is outside the domain is refused", async () => {
  const out = await enable({ input: "", envLocal: `${baseEnv()}CONNECTOR_HOSTNAME=mcp.other.org\n` });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("same domain"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("a missing hostname, client ID or client secret stops with a message", async () => {
  for (const input of ["", "mcp.example.com\n", "mcp.example.com\nclient-id\n"]) {
    const out = await enable({ input });
    assert.equal(out.status, 1, JSON.stringify(input));
    assert.match(out.stderr, /is required/);
    assert.deepEqual(out.scripts, []);
  }
});

test("a .env.local with no CONNECTOR_ENABLED line stops before asking anything", async () => {
  const out = await enable({ envLocal: "SYNC_HOSTNAME=sync.example.com\n" });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("CONNECTOR_ENABLED isn't in .env.local"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("no .env.local points at setup.sh", async () => {
  const out = await enable({ envLocal: null });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("scripts/setup.sh"), out.stderr);
  assert.deepEqual(out.ghCalls, []);
});

test("a 403 from GitHub names the login and the admin requirement", async () => {
  const out = await enable({ rules: ghRules([{ match: ENV_VARIABLES, stderr: FORBIDDEN, exit: 1 }]) });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("octocat") && out.stderr.includes("admin"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("another gh failure stops with gh's own message", async () => {
  for (const match of [ENV_VARIABLES, REPO_VARIABLES]) {
    const out = await enable({ rules: ghRules([{ match, stderr: "gh: server error (HTTP 500)\n", exit: 1 }]) });
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("HTTP 500"), out.stderr);
    assert.deepEqual(out.scripts, []);
  }
  // A 404 for the repository itself is not "unset".
  const out = await enable({ rules: ghRules([{ match: REPO_VARIABLES, stderr: NOT_FOUND, exit: 1 }]) });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("HTTP 404"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("it refuses to run in GitHub Actions, before reading anything", async () => {
  const out = await enable({ env: { GITHUB_ACTIONS: "true" } });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("never runs in GitHub Actions"), out.stderr);
  assert.deepEqual(out.ghCalls, []);
  assert.deepEqual(out.scripts, []);
});

test("the root override is refused without the test flag", async () => {
  const out = await enable({ env: { ENABLE_CONNECTOR_TEST: "" } });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("test-only"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("an argument is refused", async () => {
  const dir = makeRoot({ envLocal: baseEnv() });
  try {
    const out = await runScript(enableSh, ["--yes"], { cwd: dir, env: { ENABLE_CONNECTOR_TEST: "1", ENABLE_CONNECTOR_REPO_ROOT: dir } });
    assert.equal(out.status, 2);
    assert.ok(out.stderr.includes("usage"), out.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
