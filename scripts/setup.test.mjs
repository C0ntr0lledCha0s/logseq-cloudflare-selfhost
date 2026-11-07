import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript, stubGh } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupSh = join(root, "scripts", "setup.sh");
const REPO = "example/logseq-selfhost";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const SECRETS = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE", "ASSET_LINK_SECRET",
  "DB_SYNC_ADMIN_TOKEN", "DB_SYNC_ALLOWED_USERS", "SYNC_HOSTNAME",
];
const ORIGIN = `https://github.com/${REPO}.git`;
// The repo a fork was made from. `gh repo view` with no repo argument names it when the clone has an
// `upstream` remote, so the stub answers with it unless the origin URL is passed.
const PARENT = "upstream-owner/logseq-selfhost";
const PARENT_URL = `https://github.com/${PARENT}.git`;
const NOT_FOUND = "gh: Not Found (HTTP 404)\n";
const FORBIDDEN = "gh: Resource not accessible by personal access token (HTTP 403)\n";

// Stub scripts record `<name> <args>` in $SETUP_STUB_LOG. A fresh `init-env.sh` (no --push-only)
// writes the .env.local that the later stages read.
const stubScript = (name, extra = "") => `#!/usr/bin/env bash
echo "${name} $*" >> "$SETUP_STUB_LOG"
${extra}`;
const initEnvWrites = `if [ "\${1:-}" != "--push-only" ]; then
  umask 077
  {
    for n in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID TOFU_ENCRYPTION_PASSPHRASE ASSET_LINK_SECRET DB_SYNC_ADMIN_TOKEN; do
      echo "$n=placeholder"
    done
    echo "SYNC_HOSTNAME=sync.example.com"
    echo "DB_SYNC_ALLOWED_USERS=none"
  } > "$(dirname "$0")/../.env.local"
fi
`;

/** A temp repo root: stub scripts, the real helpers setup.sh calls, the ruleset, and a GitHub origin. */
function makeRoot({ envLocal = null, origin = ORIGIN, upstream = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  mkdirSync(join(dir, "config"));
  mkdirSync(join(dir, ".github", "rulesets"), { recursive: true });
  for (const [name, extra] of [["init-env.sh", initEnvWrites], ["doctor.sh", ""], ["run-deploy.sh", ""], ["allow-user.sh", ""]]) {
    writeFileSync(join(dir, "scripts", name), stubScript(name, extra));
    chmodSync(join(dir, "scripts", name), 0o755);
  }
  for (const name of ["token-link.mjs", "env-file.mjs", "lib/gh.sh"]) copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
  copyFileSync(join(root, "config", "token-permissions.json"), join(dir, "config", "token-permissions.json"));
  copyFileSync(join(root, ".github", "rulesets", "protect-main.json"), join(dir, ".github", "rulesets", "protect-main.json"));
  if (envLocal !== null) {
    writeFileSync(join(dir, ".env.local"), envLocal);
    chmodSync(join(dir, ".env.local"), 0o600);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (origin !== null) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  if (upstream !== null) execFileSync("git", ["remote", "add", "upstream", upstream], { cwd: dir });
  return dir;
}

const finishedEnv = `${SECRETS.map((n) => (n === "DB_SYNC_ALLOWED_USERS" ? `${n}=${USER}` : n === "SYNC_HOSTNAME" ? `${n}=sync.example.com` : `${n}=placeholder`)).join("\n")}\n`;
const workflowList = (state) =>
  JSON.stringify(["backup", "usage", "sync-upstream", "bump-upstream", "deploy"].map((n) => ({ path: `.github/workflows/${n}.yml`, state })));

/**
 * The `gh` rules for a finished install (everything present and enabled). `over` rules come first,
 * so they win. A fresh install is `fresh()`.
 */
function ghRules({ fork = true, over = [] } = {}) {
  return [
    ...over,
    { match: ["auth", "status"], stdout: "Logged in to github.com\n  - Token scopes: 'gist', 'read:org', 'repo'\n" },
    { match: ["repo", "view", ORIGIN, "--json", "nameWithOwner"], stdout: `${REPO}\n` },
    { match: ["repo", "view", REPO, "--json", "isFork"], stdout: `${fork}\n` },
    // gh's own choice in a clone with an `upstream` remote.
    { match: ["repo", "view"], stdout: `${PARENT}\n` },
    { match: ["api", "user"], stdout: "octocat\n" },
    { match: ["secret", "list"], stdout: JSON.stringify(SECRETS.map((name) => ({ name }))) },
    {
      match: ["api", `repos/${REPO}/environments/production`],
      stdout: JSON.stringify({ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
    },
    { match: ["api", `repos/${REPO}/rulesets`], stdout: "Protect main\n" },
    { match: ["api", `repos/${REPO}/actions/permissions/workflow`], stdout: "true\n" },
    { match: ["api", `repos/${REPO}/actions/permissions`], stdout: "true\n" },
    { match: ["workflow", "list"], stdout: workflowList("active") },
    // Writes. Every one succeeds unless a test overrides it; the log shows which were made.
    { match: ["api", "-X"] },
    { match: ["workflow", "enable"] },
  ];
}

const freshRules = (opts = {}) =>
  ghRules({
    ...opts,
    over: [
      ...(opts.over ?? []),
      { match: ["secret", "list"], stdout: "[]" },
      { match: ["api", `repos/${REPO}/environments/production`], stderr: NOT_FOUND, exit: 1 },
      { match: ["api", `repos/${REPO}/rulesets`], stdout: "" },
      { match: ["api", `repos/${REPO}/actions/permissions/workflow`], stdout: "false\n" },
      { match: ["workflow", "list"], stdout: workflowList("disabled_fork") },
    ],
  });

/** Runs setup.sh in a temp root. Returns the result, the stub-script log and the `gh` calls. */
async function setup({ args = ["--yes"], input = "", rules = ghRules(), envLocal = null, origin, upstream, env = {} } = {}) {
  const dir = makeRoot({ envLocal, origin, upstream });
  const gh = stubGh(dir, rules);
  const log = join(dir, "stub.log");
  try {
    const out = await runScript(setupSh, args, {
      cwd: dir,
      input,
      env: {
        PATH: `${gh.bin}:${process.env.PATH}`,
        SETUP_TEST: "1",
        SETUP_REPO_ROOT: dir,
        SETUP_STUB_LOG: log,
        ...env,
      },
    });
    return {
      ...out,
      dir,
      scripts: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
      ghCalls: gh.calls().map((c) => c.argv),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const writes = (calls) => calls.filter((a) => a[0] === "api" && a[1] === "-X").map((a) => `${a[2]} ${a[3]}`);
const enables = (calls) => calls.filter((a) => a[0] === "workflow" && a[1] === "enable").map((a) => a[2]);
const pushes = (scripts) => scripts.filter((l) => l.startsWith("init-env.sh --push-only"));

test("a fresh run sets everything up, in order, and ends by claiming the owner", async () => {
  const out = await setup({ rules: freshRules() });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.scripts, [
    "init-env.sh ",
    "doctor.sh ",
    `init-env.sh --push-only ${SECRETS.join(" ")}`,
    "run-deploy.sh --if-not-green",
    "allow-user.sh --owner",
  ]);
  assert.deepEqual(writes(out.ghCalls), [
    `PUT repos/${REPO}/environments/production`,
    `POST repos/${REPO}/environments/production/deployment-branch-policies`,
    `POST repos/${REPO}/rulesets`,
    `PUT repos/${REPO}/actions/permissions/workflow`,
  ]);
  const put = out.ghCalls.find((a) => a[2] === "PUT" && a[3].endsWith("/environments/production"));
  assert.ok(put.join(" ").includes("deployment_branch_policy[custom_branch_policies]=true"), put.join(" "));
  const policy = out.ghCalls.find((a) => a[3]?.endsWith("/deployment-branch-policies"));
  assert.ok(policy.join(" ").includes("name=main"), policy.join(" "));
  const ruleset = out.ghCalls.find((a) => a[3]?.endsWith("/rulesets"));
  assert.deepEqual(ruleset.slice(4), ["--input", ".github/rulesets/protect-main.json"]);
  const permission = out.ghCalls.find((a) => a[3]?.endsWith("/actions/permissions/workflow"));
  assert.ok(permission.join(" ").includes("can_approve_pull_request_reviews=true"), permission.join(" "));
  assert.deepEqual(enables(out.ghCalls), ["backup.yml", "usage.yml", "sync-upstream.yml"]);
  for (const call of out.ghCalls.filter((a) => a[1] === "enable")) assert.deepEqual(call.slice(3), ["-R", REPO]);
  for (let n = 1; n <= 8; n++) assert.ok(out.stdout.includes(`== ${n}. `), `stage ${n}: ${out.stdout}`);
  assert.ok(out.stdout.includes("Create the Cloudflare API token with this link, then paste it below:"), out.stdout);
  assert.ok(out.stdout.includes("https://dash.cloudflare.com/?to=/:account/api-tokens"), out.stdout);
  assert.ok(out.stdout.includes("Your server is at https://sync.example.com."), out.stdout);
  assert.ok(!out.stdout.includes("placeholder"), "no secret value is printed");
});

test("the repo is named, and a repo that isn't a fork gets bump-upstream and a warning", async () => {
  const fork = await setup({ rules: ghRules({ fork: true }), envLocal: finishedEnv });
  assert.ok(fork.stdout.includes(`This will set up ${REPO} (GitHub) and deploy to your Cloudflare account.`), fork.stdout);
  assert.ok(!fork.stdout.includes("not a fork"), fork.stdout);

  const rules = ghRules({ fork: false, over: [{ match: ["workflow", "list"], stdout: workflowList("disabled_manually") }] });
  const original = await setup({ rules, envLocal: finishedEnv });
  assert.equal(original.status, 0, original.stdout + original.stderr);
  assert.ok(original.stdout.includes(`Note: ${REPO} is not a fork. If you meant to set up your own copy, fork it first (README "Before you start").`), original.stdout);
  assert.deepEqual(enables(original.ghCalls), ["backup.yml", "usage.yml", "bump-upstream.yml"]);
});

test("a fork clone with an upstream remote sets up the origin repo, never the parent", async () => {
  const out = await setup({ envLocal: finishedEnv, upstream: PARENT_URL });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes(`This will set up ${REPO} (GitHub)`), out.stdout);
  const views = out.ghCalls.filter((a) => a[0] === "repo" && a[1] === "view");
  assert.deepEqual(views.map((a) => a[2]), [ORIGIN, REPO]);
  assert.ok(!out.ghCalls.flat().some((arg) => arg.includes(PARENT)), JSON.stringify(out.ghCalls));
  for (const call of out.ghCalls.filter((a) => ["secret", "workflow"].includes(a[0]))) {
    assert.equal(call[call.indexOf("-R") + 1], REPO, call.join(" "));
  }
});

test("a second run on a finished install changes nothing and deploys only if not green", async () => {
  const out = await setup({ envLocal: finishedEnv });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(writes(out.ghCalls), []);
  assert.deepEqual(enables(out.ghCalls), []);
  assert.deepEqual(out.scripts, ["doctor.sh ", "run-deploy.sh --if-not-green"]);
  assert.ok(out.stdout.includes("Setup is complete. Run scripts/doctor.sh any time to check it."), out.stdout);
  assert.ok(!out.stdout.includes("allow-user"), out.stdout);
});

test("--deploy runs the deploy even when the last one was green", async () => {
  const out = await setup({ args: ["--yes", "--deploy"], envLocal: finishedEnv });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(out.scripts, ["doctor.sh ", "run-deploy.sh "]);
});

test("doctor runs with DOCTOR_SKIP_GITHUB=1, and a failing doctor stops setup before any GitHub change", async () => {
  const dir = makeRoot({ envLocal: finishedEnv });
  writeFileSync(
    join(dir, "scripts", "doctor.sh"),
    stubScript("doctor.sh", 'echo "skip=${DOCTOR_SKIP_GITHUB:-unset}" >> "$SETUP_STUB_LOG"\nexit 1\n'),
  );
  const gh = stubGh(dir, freshRules());
  const log = join(dir, "stub.log");
  try {
    const out = await runScript(setupSh, ["--yes"], {
      cwd: dir,
      env: { PATH: `${gh.bin}:${process.env.PATH}`, SETUP_TEST: "1", SETUP_REPO_ROOT: dir, SETUP_STUB_LOG: log },
    });
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("fix the FAIL lines above, then re-run scripts/setup.sh"), out.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["doctor.sh ", "skip=1"]);
    assert.deepEqual(writes(gh.calls().map((c) => c.argv)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no .env.local but secrets in production: stop and say to restore it, without running init-env", async () => {
  const rules = ghRules({ over: [{ match: ["secret", "list"], stdout: '[{"name":"SYNC_HOSTNAME"}]' }] });
  const out = await setup({ rules });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("already set up"), out.stderr);
  assert.ok(out.stderr.includes("Restore .env.local from your password manager"), out.stderr);
  assert.deepEqual(out.scripts, []);
  assert.deepEqual(writes(out.ghCalls), []);
});

test("no .env.local and no production environment yet counts as no secrets", async () => {
  const rules = freshRules({ over: [{ match: ["secret", "list"], stderr: NOT_FOUND, exit: 1 }] });
  const out = await setup({ rules });
  // The same stub answers stage 6's list with a 404 too, which is a real failure there.
  assert.equal(out.scripts[0], "init-env.sh ");
  assert.ok(out.stderr.includes("HTTP 404"), out.stderr);
  assert.equal(out.status, 1);
});

test("without --yes the repo prompt defaults to no: exit 1, 'nothing changed', no gh writes", async () => {
  const out = await setup({ args: [], input: "\n", rules: freshRules() });
  assert.equal(out.status, 1);
  assert.ok(out.stdout.includes(`Set up ${REPO}? [y/N] `), out.stdout);
  assert.ok(out.stderr.includes("nothing changed"), out.stderr);
  assert.deepEqual(writes(out.ghCalls), []);
  assert.deepEqual(enables(out.ghCalls), []);
  assert.deepEqual(out.scripts, []);
});

test("without --yes, y goes on and the passphrase reminder waits for Enter", async () => {
  const out = await setup({ args: [], input: "y\n\n", rules: ghRules(), envLocal: finishedEnv });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(
    out.stdout.includes("Save TOFU_ENCRYPTION_PASSPHRASE from .env.local in your password manager now. Press Enter when done."),
    out.stdout,
  );
  const yes = await setup({ args: [], input: "yes\n\n", rules: ghRules(), envLocal: finishedEnv });
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
});

test("--yes skips the repo prompt and the passphrase wait", async () => {
  const out = await setup({ envLocal: finishedEnv });
  assert.ok(!out.stdout.includes("[y/N]"), out.stdout);
  assert.ok(!out.stdout.includes("Press Enter"), out.stdout);
});

test("partial push: only the missing names are pushed, and --repush pushes all seven", async () => {
  const five = SECRETS.slice(0, 5);
  const rules = ghRules({ over: [{ match: ["secret", "list"], stdout: JSON.stringify(five.map((name) => ({ name }))) }] });
  const partial = await setup({ rules, envLocal: finishedEnv });
  assert.equal(partial.status, 0, partial.stdout + partial.stderr);
  assert.deepEqual(pushes(partial.scripts), [`init-env.sh --push-only ${SECRETS.slice(5).join(" ")}`]);

  const repush = await setup({ args: ["--yes", "--repush"], envLocal: finishedEnv });
  assert.equal(repush.status, 0, repush.stdout + repush.stderr);
  assert.deepEqual(pushes(repush.scripts), [`init-env.sh --push-only ${SECRETS.join(" ")}`]);
});

test("a name outside the required seven is neither counted nor pushed", async () => {
  const names = [...SECRETS, "SMOKE_PAT", "CONNECTOR_HOSTNAME"];
  const rules = ghRules({ over: [{ match: ["secret", "list"], stdout: JSON.stringify(names.map((name) => ({ name }))) }] });
  const out = await setup({ rules, envLocal: finishedEnv });
  assert.deepEqual(pushes(out.scripts), []);
});

test("a 403 from the environment PUT stops with the admin message and the login", async () => {
  const rules = freshRules({
    over: [{ match: ["api", "-X", "PUT", `repos/${REPO}/environments/production`], stderr: FORBIDDEN, exit: 1 }],
  });
  const out = await setup({ rules });
  assert.equal(out.status, 1);
  assert.ok(
    out.stderr.includes(`gh is logged in as octocat (gh api user -q .login), which can't change settings on ${REPO}: it needs admin on the repo.`),
    out.stderr,
  );
  assert.ok(out.ghCalls.some((a) => a[0] === "api" && a[1] === "user"));
  assert.deepEqual(out.scripts, ["init-env.sh ", "doctor.sh "]);
});

test("a 403 reading the ruleset list is the same admin message", async () => {
  const rules = ghRules({ over: [{ match: ["api", `repos/${REPO}/rulesets`], stderr: FORBIDDEN, exit: 1 }] });
  const out = await setup({ rules, envLocal: finishedEnv });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("it needs admin on the repo."), out.stderr);
});

test("another gh failure stops with gh's own message", async () => {
  const rules = ghRules({
    over: [{ match: ["api", `repos/${REPO}/environments/production`], stderr: "gh: Server Error (HTTP 502)\n", exit: 1 }],
  });
  const out = await setup({ rules, envLocal: finishedEnv });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("Server Error (HTTP 502)"), out.stderr);
  assert.ok(!out.stderr.includes("needs admin on"), out.stderr);
  assert.deepEqual(writes(out.ghCalls), []);
});

test("Actions disabled: print the page, wait for Enter, check again, and stop if it is still disabled", async () => {
  // The stub can't change its answer, so Actions stays disabled after Enter.
  const rules = ghRules({ over: [{ match: ["api", `repos/${REPO}/actions/permissions`], stdout: "false\n" }] });
  const out = await setup({ rules, envLocal: finishedEnv, input: "\n" });
  assert.equal(out.status, 1);
  assert.ok(
    out.stdout.includes(`Enable Actions: open https://github.com/${REPO}/actions and click the green button. Press Enter when done.`),
    out.stdout,
  );
  assert.ok(out.stderr.includes("Actions is still disabled"), out.stderr);
  const checks = out.ghCalls.filter((a) => a[0] === "api" && a[1] === `repos/${REPO}/actions/permissions`);
  assert.equal(checks.length, 2, "it checks again after Enter");
  assert.deepEqual(out.scripts, ["doctor.sh "]);
});

test("a workflow that isn't listed is skipped with a note, not enabled and not an error", async () => {
  const only = JSON.stringify([{ path: ".github/workflows/backup.yml", state: "disabled_fork" }, { path: ".github/workflows/usage.yml", state: "active" }]);
  const out = await setup({ rules: ghRules({ over: [{ match: ["workflow", "list"], stdout: only }] }), envLocal: finishedEnv });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(enables(out.ghCalls), ["backup.yml"]);
  assert.ok(out.stdout.includes("sync-upstream.yml: not in this repo yet, skipped"), out.stdout);
});

test("gh auth status failing stops with the install and login message", async () => {
  const rules = ghRules({ over: [{ match: ["auth", "status"], exit: 1 }] });
  const out = await setup({ rules });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("install gh (https://cli.github.com) and run gh auth login"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("gh missing from PATH stops with the same message", async () => {
  const dir = makeRoot();
  const bin = join(dir, "nogh");
  mkdirSync(bin);
  // A PATH with bash and dirname only: nothing else can be found, gh included.
  for (const tool of ["bash", "dirname"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  }
  try {
    const out = await runScript(join(bin, "bash"), [setupSh, "--yes"], {
      cwd: dir,
      env: { PATH: bin, SETUP_TEST: "1", SETUP_REPO_ROOT: dir, SETUP_STUB_LOG: join(dir, "stub.log") },
    });
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("install gh (https://cli.github.com) and run gh auth login"), out.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a token without the repo scope stops with the refresh command", async () => {
  const rules = ghRules({ over: [{ match: ["auth", "status"], stdout: "  - Token scopes: 'gist', 'read:org'\n" }] });
  const out = await setup({ rules });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("gh needs the repo scope: run gh auth refresh -s repo"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("a token with no scopes line (fine-grained) is left to the later 403 handling", async () => {
  const rules = ghRules({ over: [{ match: ["auth", "status"], stdout: "Logged in to github.com\n" }] });
  const out = await setup({ rules, envLocal: finishedEnv });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test("an origin that isn't on github.com stops before anything is read or changed", async () => {
  const out = await setup({ origin: "https://git.example.com/me/repo.git" });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("origin"), out.stderr);
  assert.ok(out.stderr.includes("github.com"), out.stderr);
  assert.deepEqual(out.scripts, []);
});

test("a checkout with no origin stops the same way", async () => {
  const out = await setup({ origin: null });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("github.com"), out.stderr);
});

test("a name that appears twice in .env.local is refused, not guessed", async () => {
  const out = await setup({ envLocal: `${finishedEnv}DB_SYNC_ALLOWED_USERS=none\n` });
  assert.equal(out.status, 1);
  assert.ok(out.stderr.includes("appears 2 times"), out.stderr);
  assert.deepEqual(out.scripts.filter((l) => l.startsWith("allow-user")), []);
});

test("SETUP_REPO_ROOT is refused without SETUP_TEST=1, and unknown arguments are a usage error", async () => {
  const refused = await runScript(setupSh, ["--yes"], { env: { SETUP_REPO_ROOT: tmpdir(), SETUP_TEST: "" } });
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes("SETUP_REPO_ROOT is test-only and requires SETUP_TEST=1"), refused.stderr);
  const usage = await runScript(setupSh, ["--nope"], {});
  assert.equal(usage.status, 2);
  assert.ok(usage.stderr.includes("usage: setup.sh"), usage.stderr);
});

test("setup.sh is executable and starts with set -euo pipefail", () => {
  assert.ok(statSync(setupSh).mode & 0o100);
  assert.ok(readFileSync(setupSh, "utf8").split("\n").includes("set -euo pipefail"));
});
