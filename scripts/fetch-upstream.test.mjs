import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "fetch-upstream.sh");
const skip = process.env.OFFLINE === "1" ? "OFFLINE=1" : false;
const patchedFile =
  "deps/db-sync/src/logseq/db_sync/worker/handler/personal_access_token.cljs";

function run(dest, env = {}) {
  return spawnSync(script, [dest], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("applies patches at UPSTREAM_REF", { skip }, () => {
  const dest = join(mkdtempSync(join(tmpdir(), "fetch-up-")), "up");
  const r = run(dest);
  assert.equal(r.status, 0, r.stderr);
  const src = readFileSync(join(dest, patchedFile), "utf8");
  assert.ok(!src.includes("rtc_2025_07_10"));
  assert.ok(!src.includes("api.logseq.com"));
});

test("fails cleanly when a patch does not apply", { skip }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "fetch-up-"));
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
