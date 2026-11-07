import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf } from "./cloudflare-api.mjs";
import { chooseMode, findRefusals, nextList, parseRefusal, writeAllowedUsers } from "./allow-user.mjs";
import { cfStub, runScript, stubGh } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "allow-user.sh");

const SUB = "11111111-2222-4333-8444-555555555555";
const SUB_B = "99999999-2222-4333-8444-555555555555";
const SUB_C = "88888888-2222-4333-8444-555555555555";
const KNOWN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const KNOWN_B = "bbbbbbbb-0000-4000-8000-000000000002";
const REPO = "example/repo";
const ORIGIN = `https://github.com/${REPO}.git`;
const RUN_URL = "https://github.com/example/repo/actions/runs/4242";
const TELEMETRY = "POST /accounts/acct/workers/observability/telemetry/query";

const ok = (result) => ({ success: true, errors: [], result });
const textEvent = (sub, email) => ({
  $metadata: { message: `[logseq.db-sync.worker.auth] :db-sync/user-not-allowed {:sub "${sub}", :email "${email}"}` },
});
const objectEvent = (sub, email) => ({ $metadata: { message: "user-not-allowed" }, source: { sub, email } });
const events = (...list) => [200, ok({ events: { events: list } })];

test("parseRefusal reads a text message and an object source alike", () => {
  const want = { sub: SUB, email: "a@example.com" };
  assert.deepEqual(parseRefusal(textEvent(SUB, "a@example.com")), want);
  assert.deepEqual(parseRefusal(objectEvent(SUB, "a@example.com")), want);
});

test("parseRefusal gives a null email when there is none, and null for other events", () => {
  assert.deepEqual(parseRefusal({ message: `user-not-allowed {:sub "${SUB}"}` }), { sub: SUB, email: null });
  assert.equal(parseRefusal({ message: `some other event ${SUB}` }), null, "not a refusal");
  assert.equal(parseRefusal({ message: "user-not-allowed without an id" }), null, "no sub");
});

test("parseRefusal does not take a UUID typed into the email address as the sub", () => {
  const email = `${SUB_B}@example.com`;
  const event = { message: `user-not-allowed {:email "${email}", :sub "${SUB}"}` };
  assert.deepEqual(parseRefusal(event), { sub: SUB, email });
});

test("parseRefusal takes the sub from its own key, not from another UUID earlier in the event", () => {
  const other = "99999999-8888-4777-8666-555555555555";
  const want = { sub: SUB, email: "a@example.com" };
  const scriptVersion = { scriptName: "logseq-sync", scriptVersion: { id: other }, requestId: other };
  assert.deepEqual(parseRefusal({ $workers: scriptVersion, ...textEvent(SUB, "a@example.com") }), want);
  assert.deepEqual(parseRefusal({ $workers: scriptVersion, ...objectEvent(SUB, "a@example.com") }), want);
  // The sub comes before the email in some events and after it in others.
  assert.deepEqual(parseRefusal({ $workers: scriptVersion, message: `user-not-allowed {:email "a@example.com", :sub "${SUB}"}` }), want);
});

test("parseRefusal reads a map logged as an embedded JSON string and tolerates whitespace", () => {
  const want = { sub: SUB, email: "a@example.com" };
  const embedded = JSON.stringify({ sub: SUB, email: "a@example.com" });
  assert.deepEqual(parseRefusal({ $metadata: { message: `user-not-allowed ${embedded}` } }), want);
  const pretty = JSON.stringify({ sub: SUB, email: "a@example.com" }, null, 2);
  assert.deepEqual(parseRefusal({ message: `user-not-allowed ${pretty}` }), want);
  assert.deepEqual(parseRefusal({ message: `user-not-allowed {:sub   "${SUB}",\n :email  "a@example.com"}` }), want);
  assert.deepEqual(parseRefusal(JSON.parse(`{"message":"user-not-allowed","source":{"sub" : "${SUB}", "email" :"a@example.com"}}`)), want);
});

test("parseRefusal gives null when a UUID is present but no sub key anchors it", () => {
  assert.equal(parseRefusal({ message: `user-not-allowed ${SUB}` }), null);
  assert.equal(parseRefusal({ message: `user-not-allowed {:id "${SUB}"}` }), null);
  assert.equal(parseRefusal({ message: "user-not-allowed", $workers: { scriptVersion: { id: SUB } } }), null);
  assert.equal(parseRefusal({ message: `user-not-allowed {:subject "${SUB}"}` }), null);
  assert.equal(parseRefusal({ message: `user-not-allowed {:sub "not-a-uuid", :id "${SUB}"}` }), null);
});

test("findRefusals asks for the refusal events of the sync Worker and keeps one per sub", async () => {
  const stub = await cfStub({
    [TELEMETRY]: () =>
      events(textEvent(SUB, "a@example.com"), objectEvent(SUB, "a@example.com"), textEvent(SUB, "a@example.com"),
        textEvent(SUB_B, "b@example.com"), { message: "something else" }),
  });
  try {
    const cfCall = (opts) => cf({ apiBase: stub.base, apiToken: "tok", ...opts });
    const found = await findRefusals({ cfCall, accountId: "acct", workerName: "logseq-sync", fromMs: 1000, toMs: 2000 });
    assert.deepEqual(found, [{ sub: SUB, email: "a@example.com" }, { sub: SUB_B, email: "b@example.com" }]);
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(stub.requests[0].body, {
      queryId: "allow-user",
      timeframe: { from: 1000, to: 2000 },
      view: "events",
      limit: 100,
      dry: true,
      parameters: {
        filters: [
          { key: "$metadata.message", operation: "includes", type: "string", value: "user-not-allowed" },
          { key: "$workers.scriptName", operation: "eq", type: "string", value: "logseq-sync" },
        ],
      },
    });
  } finally {
    await stub.close();
  }
});

test("chooseMode picks owner or add, and refuses each wrong combination with the spec message", () => {
  assert.equal(chooseMode({ owner: true, localList: "none", knownUsers: 0 }), "owner");
  assert.equal(chooseMode({ owner: false, localList: KNOWN_A, knownUsers: 1 }), "add");
  const stale = /^\.env\.local looks out of date: the server has 2 users but DB_SYNC_ALLOWED_USERS is none here\. Restore the current \.env\.local \(password manager or your other machine\), then re-run\.$/;
  assert.throws(() => chooseMode({ owner: true, localList: "none", knownUsers: 2 }), { message: stale });
  assert.throws(() => chooseMode({ owner: false, localList: "none", knownUsers: 2 }), { message: stale });
  assert.throws(
    () => chooseMode({ owner: false, localList: "none", knownUsers: 0 }),
    { message: "the list is none: run scripts/allow-user.sh --owner to claim the server first" },
  );
  // After a deploy that failed, the local list is already the owner's while the server still refuses them.
  const claimed = "the server is already claimed; run scripts/allow-user.sh without --owner to add someone. If the last deploy failed, run scripts/run-deploy.sh";
  assert.throws(() => chooseMode({ owner: true, localList: KNOWN_A, knownUsers: 1 }), { message: claimed });
  assert.throws(() => chooseMode({ owner: true, localList: KNOWN_A, knownUsers: 0 }), { message: claimed });
});

test("nextList replaces none in owner mode, appends in add mode, and never lists a sub twice", () => {
  assert.equal(nextList("owner", "none", SUB), SUB);
  assert.equal(nextList("add", KNOWN_A, SUB), `${KNOWN_A},${SUB}`);
  assert.equal(nextList("add", `${KNOWN_A},${SUB}`, SUB), `${KNOWN_A},${SUB}`);
});

test("writeAllowedUsers puts the file back when the new value is not a valid list", () => {
  const dir = mkdtempSync(join(tmpdir(), "allow-user-write-"));
  try {
    const file = join(dir, ".env.local");
    const body = `A=1\nDB_SYNC_ALLOWED_USERS=${KNOWN_A}\nB=2\n`;
    writeFileSync(file, body, { mode: 0o600 });
    assert.throws(() => writeAllowedUsers(file, "not-a-uuid"), /entry 1 of 1 is not a lowercase UUID/);
    assert.equal(readFileSync(file, "utf8"), body);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // A second edit within the same second would collide with the first backup's name.
    for (const name of readdirSync(dir)) if (name.includes(".bak-")) rmSync(join(dir, name));
    writeAllowedUsers(file, `${KNOWN_A},${SUB}`);
    assert.equal(readFileSync(file, "utf8"), `A=1\nDB_SYNC_ALLOWED_USERS=${KNOWN_A},${SUB}\nB=2\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CLI tests: the real allow-user.sh and allow-user.mjs against a temp repo root that holds the real
// init-env.sh and run-deploy.sh, a stubbed `gh` and a stubbed Cloudflare API.

const ENV_LOCAL = (list) =>
  `CLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_ACCOUNT_ID=acct\nSYNC_HOSTNAME=sync.example.com\nDB_SYNC_ALLOWED_USERS=${list}\n`;

const ghRules = (extra = []) => [
  ...extra,
  { match: ["repo", "view", ORIGIN, "--json", "nameWithOwner"], stdout: `${REPO}\n` },
  // gh's own choice in a fork clone with an `upstream` remote: the parent repo.
  { match: ["repo", "view"], stdout: "upstream-owner/repo\n" },
  { match: ["api", `repos/${REPO}/environments/production`] },
  { match: ["secret", "set"] },
  { match: ["workflow", "run"] },
  // run-deploy.sh reads the newest dispatched run before it dispatches: none yet.
  { match: ["run", "list", "-R", REPO, "--workflow", "deploy.yml", "--event", "workflow_dispatch", "--limit", "1"], stdout: "[]\n" },
  {
    match: ["run", "list"],
    stdout: `${JSON.stringify([{ databaseId: 4242, createdAt: "2099-01-01T00:00:00Z", url: RUN_URL }])}\n`,
  },
  { match: ["run", "watch"] },
];

/** The Cloudflare routes: D1 holds `users`, and each telemetry poll answers the next entry of `polls`. */
function routes({ users = [], polls = [[]], telemetry } = {}) {
  let poll = 0;
  return {
    "GET /accounts/acct/d1/database": () => [200, ok([{ name: "logseq-sync-index", uuid: "db1" }])],
    "POST /accounts/acct/d1/database/db1/query": () => [200, ok([{ results: users }])],
    [TELEMETRY]: telemetry ?? (() => events(...polls[Math.min(poll++, polls.length - 1)])),
  };
}

async function withCli({ list = "none", cfRoutes = routes(), gh = ghRules() }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "allow-user-"));
  const stub = await cfStub(cfRoutes);
  try {
    mkdirSync(join(dir, "config"));
    mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
    copyFileSync(join(root, "config", "settings.json"), join(dir, "config", "settings.json"));
    for (const name of ["init-env.sh", "run-deploy.sh", "lib/gh.sh"]) copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: dir });
    execFileSync("git", ["remote", "add", "upstream", "https://github.com/upstream-owner/repo.git"], { cwd: dir });
    writeFileSync(join(dir, ".env.local"), ENV_LOCAL(list), { mode: 0o600 });
    chmodSync(join(dir, ".env.local"), 0o600);
    const ghStub = stubGh(dir, gh);
    const run = async (args = [], { input = "", env = {} } = {}) => {
      const result = await runScript(script, args, {
        input,
        env: {
          PATH: `${ghStub.bin}:${process.env.PATH}`,
          ALLOW_USER_TEST: "1",
          ALLOW_USER_REPO_ROOT: dir,
          ALLOW_USER_POLL_SECONDS: "0.05",
          CF_API_TEST: "1",
          CF_API_BASE: stub.base,
          RUN_DEPLOY_TEST: "1",
          RUN_DEPLOY_POLL_SECONDS: "0",
          ...env,
        },
      });
      assert.ok(!/\btok\b/.test(result.stdout + result.stderr), "the API token never appears in output");
      return result;
    };
    const envLocal = () => readFileSync(join(dir, ".env.local"), "utf8");
    const backups = () => readdirSync(dir).filter((name) => name.startsWith(".env.local.bak-"));
    const secretCalls = () => ghStub.calls().filter((c) => c.argv[0] === "secret");
    const ghLine = (c) => c.argv.join(" ");
    return await fn({ run, dir, stub, envLocal, backups, secretCalls, gh: ghStub, ghLine });
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const A = textEvent(SUB, "a@example.com");
const B = objectEvent(SUB_B, "b@example.com");

test("owner mode: yes writes the sub, keeps a backup, pushes the secret, deploys and says to sign in again", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "y\n" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.envLocal(), ENV_LOCAL(SUB));
    assert.equal(statSync(join(t.dir, ".env.local")).mode & 0o777, 0o600);
    assert.equal(t.backups().length, 1);
    assert.equal(readFileSync(join(t.dir, t.backups()[0]), "utf8"), ENV_LOCAL("none"));
    const lines = t.gh.calls().map(t.ghLine);
    const push = lines.findIndex((l) => l.startsWith("secret set DB_SYNC_ALLOWED_USERS"));
    const deploy = lines.findIndex((l) => l.startsWith("workflow run deploy.yml"));
    assert.ok(push >= 0 && deploy > push, lines.join("\n"));
    assert.equal(t.secretCalls()[0].stdin, SUB);
    assert.match(r.stdout, /In Logseq, set the sync server to https:\/\/sync\.example\.com and sign in/);
    assert.match(r.stderr, /Allow a@example\.com\? \[y\/N\] /);
    assert.match(r.stdout, /Sign in again\. \(Re-enter the server URL first if Logseq signed you out\.\)/);
    assert.ok(!r.stdout.includes(SUB) && !r.stderr.includes(SUB), "the ID is not shown without --show-ids");
  });
});

test("add mode: an accepted sub is appended to the existing list", { timeout: 30000 }, async () => {
  await withCli({ list: KNOWN_A, cfRoutes: routes({ users: [{ id: KNOWN_A }], polls: [[A]] }) }, async (t) => {
    const r = await t.run(["--wait", "0"], { input: "YES\n" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.envLocal(), ENV_LOCAL(`${KNOWN_A},${SUB}`));
    assert.equal(t.secretCalls()[0].stdin, `${KNOWN_A},${SUB}`);
    assert.match(r.stdout, /Sign in again/);
  });
});

test("the telemetry query covers the last 30 minutes of the sync Worker named in settings.json", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A]] }) }, async (t) => {
    await t.run(["--owner", "--wait", "0"], { input: "n\n" });
    const [query] = t.stub.requests.filter((req) => req.path.endsWith("/telemetry/query"));
    assert.equal(query.body.timeframe.to - query.body.timeframe.from, 30 * 60 * 1000);
    assert.equal(query.body.parameters.filters[1].value, JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")).workerName);
  });
});

test("two distinct people, both declined by default: both are offered, nothing is written, exit 1", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A, B]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "\n\n" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Allow a@example\.com\? \[y\/N\] /);
    assert.match(r.stderr, /Allow b@example\.com\? \[y\/N\] /);
    assert.equal(t.envLocal(), ENV_LOCAL("none"));
    assert.deepEqual(t.backups(), []);
    assert.equal(t.secretCalls().length, 0);
    assert.equal(t.gh.calls().length, 0, "no gh call at all");
    assert.match(r.stderr, /No refused sign-in was accepted within 0 minutes/);
    assert.match(r.stderr, /https:\/\/sync\.example\.com/);
    assert.match(r.stderr, /nightly/);
    assert.ok(!r.stdout.includes("Sign in again"));
  });
});

test("answering anything but y or yes declines, and closing stdin declines", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A, B]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "maybe\n" });
    assert.equal(r.status, 1);
    assert.equal(t.envLocal(), ENV_LOCAL("none"));
    assert.match(r.stderr, /Allow b@example\.com\?/);
  });
});

test("only one person is added per run: after the first yes the second is not offered", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A, B]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "y\ny\n" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.envLocal(), ENV_LOCAL(SUB));
    assert.ok(!r.stderr.includes("b@example.com"), "the second person is never offered");
  });
});

test("declining the first and accepting the second adds the second", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A, B]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "n\ny\n" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.envLocal(), ENV_LOCAL(SUB_B));
  });
});

test("--show-ids shows the ID in brackets, and an account with no email is still offered", { timeout: 30000 }, async () => {
  const noEmail = { message: `user-not-allowed {:sub "${SUB_C}"}` };
  await withCli({ cfRoutes: routes({ polls: [[A, noEmail]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0", "--show-ids"], { input: "n\nn\n" });
    assert.match(r.stderr, new RegExp(`Allow a@example\\.com \\[${SUB}\\]\\? \\[y/N\\] `));
    assert.match(r.stderr, new RegExp(`Allow an account with no email \\[${SUB_C}\\]\\? \\[y/N\\] `));
  });
});

test("a person who is refused again on a later poll is offered once; a new person is offered when they appear", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A], [A], [A, B]] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0.1"], { input: "n\ny\n" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stderr.match(/Allow a@example\.com\?/g).length, 1);
    assert.equal(t.envLocal(), ENV_LOCAL(SUB_B));
    const polls = t.stub.requests.filter((req) => req.path.endsWith("/telemetry/query"));
    assert.equal(polls.length, 3);
    assert.equal(polls[0].body.timeframe.to - polls[0].body.timeframe.from, 30 * 60 * 1000);
    assert.equal(polls[1].body.timeframe.from, polls[0].body.timeframe.to - 60_000, "overlap of 60 s from the previous poll's start");
    assert.equal(polls[2].body.timeframe.from, polls[1].body.timeframe.to - 60_000);
  });
});

test("a local none with users on the server is stale: exit 1 and no log query", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ users: [{ id: KNOWN_A }, { id: KNOWN_B }], polls: [[A]] }) }, async (t) => {
    const r = await t.run(["--wait", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /looks out of date: the server has 2 users but DB_SYNC_ALLOWED_USERS is none here/);
    assert.equal(t.stub.requests.filter((req) => req.path.endsWith("/telemetry/query")).length, 0);
    assert.equal(t.envLocal(), ENV_LOCAL("none"));
  });
});

test("add mode on a list of none, and --owner on a claimed server, stop before the log query", { timeout: 30000 }, async () => {
  await withCli({}, async (t) => {
    const r = await t.run(["--wait", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the list is none: run scripts\/allow-user\.sh --owner to claim the server first/);
    assert.equal(t.stub.requests.filter((req) => req.path.endsWith("/telemetry/query")).length, 0);
  });
  await withCli({ list: KNOWN_A, cfRoutes: routes({ users: [{ id: KNOWN_A }] }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the server is already claimed; run scripts\/allow-user\.sh without --owner to add someone\. If the last deploy failed, run scripts\/run-deploy\.sh/);
    assert.equal(t.stub.requests.filter((req) => req.path.endsWith("/telemetry/query")).length, 0);
  });
});

test("in GitHub Actions it refuses before reading anything", async () => {
  await withCli({}, async (t) => {
    const r = await t.run(["--owner"], { env: { GITHUB_ACTIONS: "true" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /error: allow-user prints emails, so it never runs in GitHub Actions/);
    assert.equal(t.stub.requests.length, 0);
    assert.equal(t.gh.calls().length, 0);
  });
});

test("a 403 from the log query names the permission and the token link", async () => {
  const telemetry = () => [403, { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }];
  await withCli({ cfRoutes: routes({ telemetry }) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the token can't read Workers Logs: add "Workers Observability Write" to it, or make a new token with https:\/\/dash\.cloudflare\.com\/\?to=/);
    assert.equal(t.envLocal(), ENV_LOCAL("none"));
  });
});

test("a failed secret push puts .env.local back as it was, so it matches production, and does not deploy", { timeout: 30000 }, async () => {
  // Left with the new list, a setup.sh re-run would see the name present and the list not none, and say setup is complete.
  for (const [list, users, args] of [["none", [], ["--owner"]], [KNOWN_A, [{ id: KNOWN_A }], []]]) {
    await withCli({ list, cfRoutes: routes({ users, polls: [[A]] }), gh: ghRules([{ match: ["secret", "set"], exit: 1 }]) }, async (t) => {
      const r = await t.run([...args, "--wait", "0"], { input: "y\n" });
      assert.equal(r.status, 1);
      assert.equal(t.envLocal(), ENV_LOCAL(list));
      assert.equal(statSync(join(t.dir, ".env.local")).mode & 0o777, 0o600);
      assert.match(r.stderr, /the secret was not pushed, so \.env\.local is back as it was/);
      assert.match(r.stderr, /run scripts\/allow-user\.sh/);
      assert.ok(!t.gh.calls().some((c) => c.argv[0] === "workflow"), "no deploy");
      assert.ok(!r.stdout.includes("Sign in again"));
    });
  }
});

test("a failed deploy keeps the new list, says the secret is pushed and how to re-run it", { timeout: 30000 }, async () => {
  await withCli({ cfRoutes: routes({ polls: [[A]] }), gh: ghRules([{ match: ["run", "watch"], exit: 1 }, { match: ["run", "view"], stdout: "{\"jobs\":[]}" }]) }, async (t) => {
    const r = await t.run(["--owner", "--wait", "0"], { input: "y\n" });
    assert.equal(r.status, 1);
    assert.equal(t.envLocal(), ENV_LOCAL(SUB));
    assert.match(r.stderr, /scripts\/run-deploy\.sh/);
    assert.ok(!r.stdout.includes("Sign in again"));
  });
});

test("test-only overrides are refused without their test switch", async () => {
  await withCli({}, async (t) => {
    let r = await t.run(["--owner"], { env: { ALLOW_USER_TEST: "" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ALLOW_USER_REPO_ROOT is test-only and requires ALLOW_USER_TEST=1/);
    // The poll interval is checked by the Node script itself, so run it directly against the temp root.
    r = await runScript("node", [join(root, "scripts", "allow-user.mjs"), "--repo-root", t.dir, "--owner"], {
      env: { ALLOW_USER_POLL_SECONDS: "0", ALLOW_USER_TEST: "" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ALLOW_USER_POLL_SECONDS is test-only and requires ALLOW_USER_TEST=1/);
    assert.equal(t.stub.requests.length, 0);
  });
});

test("--wait must be a number of minutes", async () => {
  await withCli({}, async (t) => {
    const r = await t.run(["--owner", "--wait", "soon"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--wait must be a number of minutes/);
  });
});

test("it needs .env.local", async () => {
  await withCli({}, async (t) => {
    rmSync(join(t.dir, ".env.local"));
    const r = await t.run(["--owner"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \.env\.local/);
    assert.ok(!existsSync(join(t.dir, ".env.local")));
  });
});

test("the shell script is executable", () => {
  assert.ok((statSync(script).mode & 0o111) !== 0);
});
