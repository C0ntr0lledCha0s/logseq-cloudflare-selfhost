import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "bump-pr-body.sh");

let repo;
let oldSha;
let newSha;

const git = (...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args],
    { encoding: "utf8" },
  ).trim();

before(() => {
  repo = mkdtempSync(join(tmpdir(), "bump-body-"));
  git("init", "-q");
  mkdirSync(join(repo, "deps/db-sync/worker/migrations"), { recursive: true });
  writeFileSync(join(repo, "deps/db-sync/worker/migrations/0007_a.sql"), "-- a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  oldSha = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "deps/db-sync/worker/migrations/0008_x.sql"), "-- x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "add migration 0008");
  newSha = git("rev-parse", "HEAD");
});

after(() => rmSync(repo, { recursive: true, force: true }));

function run(ciResult) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, [oldSha, newSha, ciResult, repo], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "42",
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

test("lists new migrations", { timeout: 60000 }, async () => {
  const r = await run("success");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0008_x\.sql/);
  assert.doesNotMatch(r.stdout, /0007_a\.sql/);
  assert.match(r.stdout, /CI: ✅ passed/);
  assert.match(r.stdout, /add migration 0008/);
});

test("marks failed CI", { timeout: 60000 }, async () => {
  const r = await run("failure");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CI: ❌ failed/);
  assert.match(r.stdout, /https:\/\/github\.example\/o\/r\/actions\/runs\/42/);
});

test("rejects an unknown CI result", { timeout: 60000 }, async () => {
  const r = await run("bogus");
  assert.notEqual(r.status, 0);
});
