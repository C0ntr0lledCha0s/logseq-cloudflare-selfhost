import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "upstream-test.sh");

// A stand-in for `clojure -M:cljs watch db-sync-test`: it records each start, and on every change
// under src/ prints "Compiling ..." and then "Build completed." (copying src/a.cljs to
// worker/dist/built, as a build would) or "Build failure:" when the source says BROKEN.
const WATCH_STUB = `#!/usr/bin/env bash
echo "$$" >> "$STUB_DIR/watch-starts"
last=""
while true; do
  cur=$(find src -type f -printf '%T@ %p\\n' 2>/dev/null | sort | md5sum)
  if [ "$cur" != "$last" ]; then
    last="$cur"
    echo "[:db-sync-test] Compiling ..."
    sleep "\${STUB_BUILD_SECS:-0.3}"
    if grep -rq BROKEN src; then
      echo "[:db-sync-test] Build failure:"
      echo "------ ERROR -------"
      echo " File: src/a.cljs:1:1 BROKEN is not a form"
    else
      mkdir -p worker/dist && cp src/a.cljs worker/dist/built
      echo "[:db-sync-test] Build completed. (1 files, 1 compiled, 0 warnings, 0.30s)"
    fi
  fi
  sleep 0.1
done
`;
// A stand-in for `node worker/dist/worker-test.js`: prints its args and the build it ran against.
const RUN_STUB = `#!/usr/bin/env bash
echo "RUN ARGS: [$*]"
echo "BUILT: $(cat worker/dist/built 2>/dev/null)"
echo "Ran \${STUB_RAN:-3} tests containing 5 assertions."
exit "\${STUB_RUN_EXIT:-0}"
`;
const COMPILE_STUB = `#!/usr/bin/env bash
echo "COMPILE ONE-SHOT"
mkdir -p worker/dist && cp src/a.cljs worker/dist/built
`;

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "upstream-test-"));
  const checkout = join(tmp, "up");
  const dir = join(checkout, "deps", "db-sync");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.cljs"), "v1\n");
  const stubs = join(tmp, "stubs");
  mkdirSync(stubs);
  for (const [name, body] of [
    ["watch", WATCH_STUB],
    ["run", RUN_STUB],
    ["compile", COMPILE_STUB],
  ]) {
    writeFileSync(join(stubs, name), body);
    chmodSync(join(stubs, name), 0o755);
  }
  const env = {
    STUB_DIR: tmp,
    UPSTREAM_TEST_WATCH_CMD: join(stubs, "watch"),
    UPSTREAM_TEST_RUN_CMD: join(stubs, "run"),
    UPSTREAM_TEST_COMPILE_CMD: join(stubs, "compile"),
    UPSTREAM_TEST_TIMEOUT: "20",
  };
  const starts = () =>
    existsSync(join(tmp, "watch-starts"))
      ? readFileSync(join(tmp, "watch-starts"), "utf8").trim().split("\n").length
      : 0;
  const pidfile = join(dir, "tmp", "lane-watch", "watch.pid");
  const cleanup = () => {
    spawnSync(script, [checkout, "--stop"], { env: { ...process.env, ...env } });
    rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, checkout, dir, env, starts, pidfile, cleanup };
}

function run(args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, args, { cwd: root, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr, out: stdout + stderr }));
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("refuses bad arguments", async () => {
  const t = setup();
  try {
    for (const args of [[], [t.checkout, "a", "b"], [t.checkout, "--frobnicate"]]) {
      const r = await run(args, t.env);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.out}`);
      assert.match(r.stderr, /usage: upstream-test\.sh/);
    }
    const r = await run([join(t.tmp, "nowhere"), "x"], t.env);
    assert.equal(r.status, 2, r.out);
    assert.match(r.stderr, /deps\/db-sync/);
    assert.equal(t.starts(), 0);
  } finally {
    t.cleanup();
  }
});

test("starts the watch once, then reuses it", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const first = await run([t.checkout, "semantic-choice-values"], t.env);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /starting a watch/);
    assert.match(first.out, /RUN ARGS: \[semantic-choice-values\]/);
    assert.match(first.out, /BUILT: v1/);
    assert.ok(existsSync(t.pidfile));
    const pid = Number(readFileSync(t.pidfile, "utf8"));
    assert.ok(alive(pid), "the watch keeps running after the script exits");

    const second = await run([t.checkout], t.env);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /reusing the watch/);
    assert.match(second.out, /RUN ARGS: \[\]/, "no namespace runs everything");
    assert.equal(t.starts(), 1);
  } finally {
    t.cleanup();
  }
});

test("waits for a build that started after the latest source change", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    assert.equal((await run([t.checkout, "x"], t.env)).status, 0);
    writeFileSync(join(t.dir, "src", "a.cljs"), "v2\n");
    // A slow build: without waiting, the run would see v1.
    const r = await run([t.checkout, "x"], { ...t.env, STUB_BUILD_SECS: "1.5" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /BUILT: v2/);
    assert.equal(t.starts(), 1);
  } finally {
    t.cleanup();
  }
});

test("exits 1 with the compiler's error on a build failure, without running tests", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    assert.equal((await run([t.checkout, "x"], t.env)).status, 0);
    writeFileSync(join(t.dir, "src", "a.cljs"), "BROKEN\n");
    const r = await run([t.checkout, "x"], t.env);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Build failure/);
    assert.match(r.out, /BROKEN is not a form/);
    assert.doesNotMatch(r.out, /RUN ARGS/);

    // Fixing the source makes the next run green again on the same watch.
    writeFileSync(join(t.dir, "src", "a.cljs"), "v3\n");
    const fixed = await run([t.checkout, "x"], t.env);
    assert.equal(fixed.status, 0, fixed.out);
    assert.match(fixed.out, /BUILT: v3/);
  } finally {
    t.cleanup();
  }
});

test("passes the test runner's exit code through", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const r = await run([t.checkout, "x"], { ...t.env, STUB_RUN_EXIT: "1" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /RUN ARGS: \[x\]/);
  } finally {
    t.cleanup();
  }
});

test("fails when the namespace regex matches no tests", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const r = await run([t.checkout, "no-such-ns"], { ...t.env, STUB_RAN: "0" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no test namespace matches "no-such-ns"/);
  } finally {
    t.cleanup();
  }
});

test("--stop kills the watch and removes the pidfile", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    assert.equal((await run([t.checkout, "x"], t.env)).status, 0);
    const pid = Number(readFileSync(t.pidfile, "utf8"));
    const r = await run([t.checkout, "--stop"], t.env);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /stopped the watch/);
    assert.equal(existsSync(t.pidfile), false);
    assert.equal(alive(pid), false);
    const again = await run([t.checkout, "--stop"], t.env);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /no watch running/);
  } finally {
    t.cleanup();
  }
});

test("falls back to a one-shot compile when the watch can't start", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const r = await run([t.checkout, "x"], { ...t.env, UPSTREAM_TEST_WATCH_CMD: "echo no java here; exit 3" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /falling back to a one-shot compile/);
    assert.match(r.out, /no java here/);
    assert.match(r.out, /COMPILE ONE-SHOT/);
    assert.match(r.out, /RUN ARGS: \[x\]/);
    assert.equal(existsSync(t.pidfile), false);
  } finally {
    t.cleanup();
  }
});

test("times out with a clear message when no build finishes", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const r = await run([t.checkout, "x"], {
      ...t.env,
      UPSTREAM_TEST_WATCH_CMD: "while true; do sleep 1; done",
      UPSTREAM_TEST_TIMEOUT: "2",
    });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /timed out after 2s/);
    assert.doesNotMatch(r.out, /RUN ARGS/);
  } finally {
    t.cleanup();
  }
});

test("two callers racing on one checkout start one watch", { timeout: 60000 }, async () => {
  const t = setup();
  try {
    const [a, b] = await Promise.all([run([t.checkout, "x"], t.env), run([t.checkout, "y"], t.env)]);
    assert.equal(a.status, 0, a.out);
    assert.equal(b.status, 0, b.out);
    assert.equal(t.starts(), 1);
  } finally {
    t.cleanup();
  }
});
