import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "bump-branch.sh");

const BOT = ["github-actions[bot]", "41898283+github-actions[bot]@users.noreply.github.com"];
const HUMAN = ["Owner", "owner@example.com"];
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const BRANCH = "bump/upstream-aaaaaaaaaa";

let dir;
let origin;
let seed;
let work;

/** Runs git in `cwd` as `who` (author and committer), or as `author` with a different `committer`. */
function git(cwd, args, { author = HUMAN, committer = author } = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author[0],
      GIT_AUTHOR_EMAIL: author[1],
      GIT_COMMITTER_NAME: committer[0],
      GIT_COMMITTER_EMAIL: committer[1],
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function commitFile(cwd, file, content, message, who) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message], who);
  return git(cwd, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bump-branch-"));
  origin = join(dir, "origin.git");
  seed = join(dir, "seed");
  work = join(dir, "work");
  git(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  git(dir, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  commitFile(seed, "UPSTREAM_REF", `${OLD}\n`, "initial");
  commitFile(seed, "patches/0001-fix.patch", "line one\nline two\nline three\n", "add patch");
  git(seed, ["push", "-q", "origin", "main"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Starts the bump branch in the seed repo from main, with an earlier bot bump commit. */
function startBumpBranch() {
  git(seed, ["checkout", "-q", "-B", BRANCH, "main"]);
  return commitFile(seed, "UPSTREAM_REF", `${OLD.replace(/a/g, "c")}\n`, "chore: bump upstream", { author: BOT });
}

function push(ref) {
  git(seed, ["push", "-q", "--force", "origin", ref]);
}

function advanceMain(file = "README.md", content = "readme\n") {
  git(seed, ["checkout", "-q", "main"]);
  const sha = commitFile(seed, file, content, "main moves on");
  push("main");
  return sha;
}

/** Clones origin's main as actions/checkout does (full history) and runs the script there, as the workflow step does. */
function run() {
  git(dir, ["clone", "-q", "--branch", "main", origin, work]);
  const output = join(dir, "github-output");
  const note = join(dir, "note.md");
  writeFileSync(output, "");
  const r = spawnSync(script, [BRANCH, NEW, "main", note], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  let noteText = "";
  try {
    noteText = readFileSync(note, "utf8");
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, "utf8"), note: noteText };
}

const remoteTip = () => git(origin, ["rev-parse", `refs/heads/${BRANCH}`]);
const remoteFile = (file) => git(origin, ["show", `refs/heads/${BRANCH}:${file}`]);
const isAncestor = (a, b) => {
  try {
    git(origin, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
};

test("with no bump branch yet, it creates one from main with a bot commit", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^mode=force$/m);
  assert.equal(remoteFile("UPSTREAM_REF"), NEW);
  assert.equal(git(origin, ["rev-parse", `${remoteTip()}^`]), git(origin, ["rev-parse", "main"]));
  assert.equal(git(origin, ["log", "-1", "--format=%ae %ce", remoteTip()]), `${BOT[1]} ${BOT[1]}`);
  assert.equal(r.note, "");
});

test("a branch with only bot commits is rebuilt from main, as before", () => {
  const oldBump = startBumpBranch();
  push(BRANCH);
  advanceMain();
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^mode=force$/m);
  assert.equal(remoteFile("UPSTREAM_REF"), NEW);
  assert.equal(git(origin, ["rev-parse", `${remoteTip()}^`]), git(origin, ["rev-parse", "main"]));
  assert.ok(!isAncestor(oldBump, remoteTip()), "the old bot commit is replaced");
  assert.equal(r.note, "");
});

/** A patch refresh pushed to the bump branch by `author`, committed by `committer`. */
function handMadeCommit(author = HUMAN, committer = author) {
  startBumpBranch();
  const sha = commitFile(seed, "patches/0001-fix.patch", "line one\nline two refreshed\nline three\n", "fix(api): refresh patch", {
    author,
    committer,
  });
  push(BRANCH);
  // From here origin refuses any push that would drop a commit, as a force push would.
  git(origin, ["config", "receive.denyNonFastForwards", "true"]);
  return sha;
}

function assertKeptAndUpdated(r, kept) {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isAncestor(kept, remoteTip()), "the hand-made commit is still on the branch");
  assert.match(r.output, /^mode=merge$/m);
  assert.equal(remoteFile("UPSTREAM_REF"), NEW);
  assert.equal(remoteFile("patches/0001-fix.patch"), "line one\nline two refreshed\nline three");
  assert.equal(git(origin, ["log", "-1", "--format=%ae %ce", remoteTip()]), `${BOT[1]} ${BOT[1]}`);
  assert.match(r.note, /not made by github-actions\[bot\]/);
  assert.match(r.note, /bbbbbbbbbb/);
  assert.match(r.note, /patches may need refreshing/);
}

test("a hand-made commit is kept: UPSTREAM_REF is updated in a new commit on top, without a force push", () => {
  const kept = handMadeCommit();
  const r = run();
  assertKeptAndUpdated(r, kept);
  assert.equal(git(origin, ["rev-parse", `${remoteTip()}^`]), kept);
});

test("a bot-authored commit that a person committed (a rebase or amend) counts as hand-made", () => {
  const kept = handMadeCommit(BOT, HUMAN);
  assertKeptAndUpdated(run(), kept);
});

test("a person's commit committed by the bot (a cherry-pick) counts as hand-made", () => {
  const kept = handMadeCommit(HUMAN, BOT);
  assertKeptAndUpdated(run(), kept);
});

test("when main has moved on, main is merged into the kept branch (no rebase)", () => {
  const kept = handMadeCommit();
  const mainTip = advanceMain();
  const r = run();
  assertKeptAndUpdated(r, kept);
  assert.ok(isAncestor(mainTip, remoteTip()), "main is merged in");
  assert.equal(remoteFile("README.md"), "readme");
  assert.match(r.note, /merged/);
});

test("when merging main conflicts, the branch is left alone and the note says so", () => {
  handMadeCommit();
  advanceMain("patches/0001-fix.patch", "line one\nline two changed on main\nline three\n");
  const before = remoteTip();
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(), before, "the branch is untouched");
  assert.match(r.output, /^mode=skip$/m);
  assert.match(r.note, /not updated/);
  assert.match(r.note, /conflict/);
  assert.match(r.note, /bbbbbbbbbb/);
  assert.match(r.note, /patches may need refreshing/);
  assert.equal(git(work, ["status", "--porcelain"]), "", "no merge is left half done");
});

test("when origin refuses the push, nothing is lost and the note says the branch was not updated", () => {
  handMadeCommit();
  const before = remoteTip();
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteTip(), before);
  assert.match(r.output, /^mode=skip$/m);
  assert.match(r.note, /not updated/);
  assert.match(r.note, /push was refused/);
});

test("a re-run for the same upstream commit adds no empty commit", () => {
  const kept = handMadeCommit();
  assertKeptAndUpdated(run(), kept);
  const tip = remoteTip();
  rmSync(work, { recursive: true, force: true });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^mode=merge$/m);
  assert.equal(remoteTip(), tip);
});

test("it writes the branch it pushed to the step output", () => {
  handMadeCommit();
  const r = run();
  assert.match(r.output, new RegExp(`^branch=${BRANCH.replace(/[/]/g, "\\/")}$`, "m"));
});
