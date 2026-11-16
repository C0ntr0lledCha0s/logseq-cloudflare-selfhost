import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const self = fileURLToPath(import.meta.url);
const script = join(root, "scripts", "fetch-upstream.sh");
const skip = process.env.OFFLINE === "1" ? "OFFLINE=1" : false;
const patchedFile =
  "deps/db-sync/src/logseq/db_sync/worker/handler/personal_access_token.cljs";

function run(dest, env = {}, args = []) {
  return spawnSync(script, [dest, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** A fresh fetch-up-* dir that is removed when the test ends, pass or fail. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-up-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("applies patches at UPSTREAM_REF", { skip }, (t) => {
  const dest = join(tempDir(t), "up");
  const r = run(dest);
  assert.equal(r.status, 0, r.stderr);
  const src = readFileSync(join(dest, patchedFile), "utf8");
  assert.ok(!src.includes("rtc_2025_07_10"));
  assert.ok(!src.includes("api.logseq.com"));
});

test("fails cleanly when a patch does not apply", { skip }, (t) => {
  const tmp = tempDir(t);
  const patches = join(tmp, "patches");
  cpSync(join(root, "patches"), patches, { recursive: true });
  writeFileSync(
    join(patches, "0002-bad.patch"),
    `--- a/${patchedFile}
+++ b/${patchedFile}
@@ -1,3 +1,3 @@
-this context can never match
+nor this
 neither this
 nor this one
`,
  );
  const dest = join(tmp, "up");
  const r = run(dest, { PATCHES_DIR: patches });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /patch failed: 0002-bad\.patch/);
  assert.equal(existsSync(dest), false);
});

test("removes dest when the fetch fails", { skip }, (t) => {
  const dest = join(tempDir(t), "up");
  const r = run(dest, {}, ["refs/heads/no-such-branch-for-fetch-upstream-test"]);
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(dest), false, "half-fetched dest left behind");
});

test("leaves an empty dest it was given empty when it fails", { skip }, (t) => {
  const dest = tempDir(t);
  const r = run(dest, {}, ["refs/heads/no-such-branch-for-fetch-upstream-test"]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(dest), []);
});

// Guards against the leak that filled a container's disk: 516 fetch-up-* dirs
// left in /tmp by earlier versions of these tests. Runs the failing-patch test
// in a child with TMPDIR pointed at a fresh dir and checks nothing remains.
test(
  "the failing-patch test leaves no fetch-up-* dir in TMPDIR",
  { skip: skip || (process.env.FETCH_UPSTREAM_CHILD === "1" ? "child run" : false) },
  (t) => {
    const fresh = mkdtempSync(join(tmpdir(), "fetch-up-leak-check-"));
    t.after(() => rmSync(fresh, { recursive: true, force: true }));
    // A child under node --test reports to its parent instead of stdout
    // unless NODE_TEST_CONTEXT is cleared.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const r = spawnSync(
      process.execPath,
      ["--test", "--test-name-pattern=fails cleanly when a patch does not apply", self],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...env, TMPDIR: fresh, FETCH_UPSTREAM_CHILD: "1" },
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass 1\b/, r.stdout);
    const left = readdirSync(fresh).filter((n) => n.startsWith("fetch-up-"));
    assert.deepEqual(left, [], `left behind in TMPDIR: ${left.join(", ")}`);
  },
);
