import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScript, stubGh } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REPO = "owner/repo";
const ORIGIN = `https://github.com/${REPO}.git`;
// The repo a fork was made from: `gh repo view` with no repo argument names it in a clone with an `upstream` remote.
const PARENT = "upstream-owner/repo";
const RUN_URL = "https://github.com/owner/repo/actions/runs/4242";
const LIST = ["run", "list", "-R", REPO, "--workflow", "deploy.yml"];
const json = (value) => `${JSON.stringify(value)}\n`;
// A run created long after the script starts, and one created long before it.
const NEW_RUN = [{ databaseId: 4242, createdAt: "2099-01-01T00:00:00Z", url: RUN_URL }];
const OLD_RUN = [{ databaseId: 1, createdAt: "2000-01-01T00:00:00Z", url: "https://github.com/owner/repo/actions/runs/1" }];

const rules = (...extra) => [
  { match: ["repo", "view", ORIGIN, "--json", "nameWithOwner"], stdout: `${REPO}\n` },
  { match: ["repo", "view"], stdout: `${PARENT}\n` },
  ...extra,
];
const dispatched = (runs) => ({ match: [...LIST, "--event", "workflow_dispatch"], stdout: json(runs) });
const latestOnMain = (runs) => ({ match: [...LIST, "--branch", "main"], stdout: json(runs) });

/**
 * Runs the real run-deploy.sh from a temp clone whose `origin` is REPO and whose `upstream` is the
 * parent repo, so the repo it targets comes from origin and nowhere else.
 */
async function withGh(ghRules, fn) {
  const dir = mkdtempSync(join(tmpdir(), "run-deploy-"));
  try {
    mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
    for (const name of ["run-deploy.sh", "lib/gh.sh"]) copyFileSync(join(root, "scripts", name), join(dir, "scripts", name));
    chmodSync(join(dir, "scripts", "run-deploy.sh"), 0o755);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: dir });
    execFileSync("git", ["remote", "add", "upstream", `https://github.com/${PARENT}.git`], { cwd: dir });
    const gh = stubGh(dir, ghRules);
    const run = (args = [], env = {}) =>
      runScript(join(dir, "scripts", "run-deploy.sh"), args, {
        env: { PATH: `${gh.bin}:${process.env.PATH}`, RUN_DEPLOY_TEST: "1", RUN_DEPLOY_POLL_SECONDS: "0", ...env },
      });
    return await fn(run, gh);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argvs = (gh) => gh.calls().map((c) => c.argv.join(" "));
const started = (gh) => argvs(gh).some((a) => a.startsWith("workflow run deploy.yml"));

test("a successful run prints the URL and exits 0", { timeout: 30000 }, async () => {
  const ghRules = rules({ match: ["workflow", "run"] }, dispatched(NEW_RUN), { match: ["run", "watch"] });
  await withGh(ghRules, async (run, gh) => {
    const r = await run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`deploy: succeeded \\(${RUN_URL}\\)`));
    const calls = argvs(gh);
    assert.ok(calls.includes(`workflow run deploy.yml -R ${REPO} --ref main`), calls.join("\n"));
    assert.ok(calls.includes(`run watch 4242 -R ${REPO} --exit-status`), calls.join("\n"));
    assert.ok(calls.includes(`run list -R ${REPO} --workflow deploy.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt,url`), calls.join("\n"));
  });
});

test("the repo comes from the origin remote, never the parent repo gh would pick", { timeout: 30000 }, async () => {
  const ghRules = rules({ match: ["workflow", "run"] }, dispatched(NEW_RUN), { match: ["run", "watch"] });
  await withGh(ghRules, async (run, gh) => {
    const r = await run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = gh.calls().map((c) => c.argv);
    assert.deepEqual(calls[0], ["repo", "view", ORIGIN, "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
    assert.ok(!calls.flat().some((arg) => arg.includes(PARENT)), JSON.stringify(calls));
    for (const call of calls.slice(1)) assert.equal(call[call.indexOf("-R") + 1], REPO, call.join(" "));
  });
});

test("a failed run names the first failed step and prints no logs", { timeout: 30000 }, async () => {
  const view = {
    url: RUN_URL,
    jobs: [
      {
        name: "deploy",
        conclusion: "failure",
        steps: [
          { name: "Set up job", conclusion: "success" },
          { name: "Deploy", conclusion: "failure" },
          { name: "Post checkout", conclusion: "failure" },
        ],
      },
    ],
  };
  const ghRules = rules(
    { match: ["workflow", "run"] },
    dispatched(NEW_RUN),
    { match: ["run", "watch"], exit: 1, stdout: "SECRET-LOG-LINE\n" },
    { match: ["run", "view", "4242", "-R", REPO, "--json", "jobs,url"], stdout: json(view) },
  );
  await withGh(ghRules, async (run) => {
    const r = await run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`deploy: failed at step "Deploy" \\(${RUN_URL}\\)`));
    assert.ok(!(r.stdout + r.stderr).includes("SECRET-LOG-LINE"), "run output is not printed");
  });
});

test("a failed run with no failed step still says it failed and gives the URL", { timeout: 30000 }, async () => {
  const ghRules = rules(
    { match: ["workflow", "run"] },
    dispatched(NEW_RUN),
    { match: ["run", "watch"], exit: 1 },
    { match: ["run", "view"], stdout: json({ url: RUN_URL, jobs: [{ name: "deploy", conclusion: "cancelled", steps: [] }] }) },
  );
  await withGh(ghRules, async (run) => {
    const r = await run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`deploy: failed.*${RUN_URL}`));
  });
});

test("--if-not-green does nothing when the latest run on main succeeded", { timeout: 30000 }, async () => {
  await withGh(rules(latestOnMain([{ status: "completed", conclusion: "success" }])), async (run, gh) => {
    const r = await run(["--if-not-green"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /deploy: the latest run on main succeeded; nothing to do/);
    assert.ok(!started(gh));
    assert.ok(argvs(gh).includes(`run list -R ${REPO} --workflow deploy.yml --branch main --limit 1 --json conclusion,status`));
  });
});

test("--if-not-green starts a run when the latest one failed", { timeout: 30000 }, async () => {
  const ghRules = rules(
    latestOnMain([{ status: "completed", conclusion: "failure" }]),
    { match: ["workflow", "run"] },
    dispatched(NEW_RUN),
    { match: ["run", "watch"] },
  );
  await withGh(ghRules, async (run, gh) => {
    const r = await run(["--if-not-green"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(started(gh));
    assert.match(r.stdout, /deploy: succeeded/);
  });
});

test("--if-not-green starts a run when the latest one is still in progress or there is none", { timeout: 30000 }, async () => {
  for (const latest of [[{ status: "in_progress", conclusion: "" }], []]) {
    const ghRules = rules(latestOnMain(latest), { match: ["workflow", "run"] }, dispatched(NEW_RUN), { match: ["run", "watch"] });
    await withGh(ghRules, async (run, gh) => {
      const r = await run(["--if-not-green"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(started(gh));
    });
  }
});

test("a run created before the start is ignored, and the script gives up with the Actions link", { timeout: 30000 }, async () => {
  const ghRules = rules({ match: ["workflow", "run"] }, dispatched(OLD_RUN));
  await withGh(ghRules, async (run, gh) => {
    const began = Date.now();
    const r = await run();
    assert.ok(Date.now() - began < 5000, "finishes quickly when the poll interval is zero");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /deploy: the run didn't start; check the Actions tab at https:\/\/github.com\/owner\/repo\/actions/);
    assert.ok(!argvs(gh).some((a) => a.startsWith("run watch")));
  });
});

test("the poll interval override is refused without RUN_DEPLOY_TEST=1", { timeout: 30000 }, async () => {
  await withGh(rules(), async (run, gh) => {
    const r = await run([], { RUN_DEPLOY_TEST: "" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RUN_DEPLOY_POLL_SECONDS is test-only and requires RUN_DEPLOY_TEST=1/);
    assert.ok(!started(gh));
  });
});

test("an unknown argument exits 2 with the usage", { timeout: 30000 }, async () => {
  await withGh(rules(), async (run) => {
    const r = await run(["--nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: run-deploy.sh \[--if-not-green\]/);
  });
});
