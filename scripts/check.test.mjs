import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "check.sh");

// A fake repository root plus stub npm/node/pnpm/tofu that log their arguments and exit with
// the status named in STUB_FAIL_<tool> (0 when unset), after printing STUB_OUT_<tool> when set.
function setup({ vendor = false, upstream = false, releaseBundle = false, nodeModules = true, stubs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-"));
  const root = join(dir, "repo");
  const bin = join(dir, "bin");
  mkdirSync(join(root, "connector"), { recursive: true });
  mkdirSync(bin);
  if (nodeModules) {
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "connector", "node_modules"));
  }
  if (vendor) {
    mkdirSync(join(root, "connector", "vendor"));
    writeFileSync(join(root, "connector", "vendor", "openapi.json"), "{}");
    writeFileSync(join(root, "connector", "vendor", "semantic_api_tools.mjs"), "");
  }
  if (upstream) mkdirSync(join(root, ".upstream", "deps", "db-sync"), { recursive: true });
  if (releaseBundle) {
    mkdirSync(join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker"), { recursive: true });
    writeFileSync(join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker", "main.js"), "");
  }
  const log = join(dir, "calls.log");
  for (const tool of ["npm", "node", "pnpm", "tofu"]) {
    const stub = join(bin, tool);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\n${stubs[tool] ?? ""}\n[ -n "\${STUB_OUT_${tool}:-}" ] && printf '%s\\n' "\${STUB_OUT_${tool}}"\nexit "\${STUB_FAIL_${tool}:-0}"\n`,
    );
    chmodSync(stub, 0o755);
  }
  const run = (args = [], env = {}) => {
    const r = spawnSync("bash", [script, ...args], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CHECK_ROOT: root, ...env },
      encoding: "utf8",
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {}
    return { ...r, calls };
  };
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("skips the connector checks and names the fix when connector/vendor is missing", () => {
  const { run, cleanup } = setup();
  try {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok +scripts unit tests/);
    assert.match(r.stdout, /skipped +connector tests.*vendor-upstream-api\.sh/);
    assert.doesNotMatch(r.calls, /--prefix connector test/);
  } finally {
    cleanup();
  }
});

test("runs the connector tests, typecheck and manifest check when vendored", () => {
  const { run, cleanup } = setup({ vendor: true });
  try {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.calls, /npm --prefix connector test/);
    assert.match(r.calls, /npm --prefix connector run typecheck/);
    assert.match(r.calls, /node connector\/scripts\/check-tools-manifest\.mjs/);
    assert.match(r.calls, /tofu -chdir=infra fmt -check -recursive/);
  } finally {
    cleanup();
  }
});

test("exits 1 and reports the failure when a check fails, and still runs the rest", () => {
  const { run, cleanup } = setup({ vendor: true });
  try {
    const r = run([], { STUB_FAIL_tofu: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED +tofu fmt/);
    assert.match(r.stdout, /ok +connector tests/);
  } finally {
    cleanup();
  }
});

test("--upstream runs upstream's suite, or says it is skipped without .upstream", () => {
  const withUpstream = setup({ upstream: true });
  const without = setup();
  try {
    const a = withUpstream.run(["--upstream"]);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.calls, /pnpm test/);
    const b = without.run(["--upstream"]);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /skipped +upstream db-sync tests/);
  } finally {
    withUpstream.cleanup();
    without.cleanup();
  }
});

test("--upstream queries the release bundle when it is built, or names the skip and the fix", () => {
  const built = setup({ upstream: true, releaseBundle: true });
  const unbuilt = setup({ upstream: true });
  try {
    const a = built.run(["--upstream"]);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.calls, /node scripts\/release-query-check\.mjs \.upstream/);
    assert.match(a.stdout, /ok +release bundle query check/);
    const failed = built.run(["--upstream"], { STUB_FAIL_node: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAILED +release bundle query check/);
    const b = unbuilt.run(["--upstream"]);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    assert.match(b.stdout, /skipped +release bundle query check .*scripts\/build\.sh \.upstream/);
    assert.doesNotMatch(b.calls, /release-query-check/);
    const before = failed.calls.length;
    const c = built.run([]);
    assert.doesNotMatch(c.calls.slice(before), /release-query-check/, "only with --upstream");
  } finally {
    built.cleanup();
    unbuilt.cleanup();
  }
});

test("installs dependencies when node_modules is missing", () => {
  const { run, cleanup } = setup({ nodeModules: false });
  try {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.calls, /^npm ci --silent$/m);
  } finally {
    cleanup();
  }
});

test("rejects unknown arguments", () => {
  const { run, cleanup } = setup();
  try {
    assert.equal(run(["--nope"]).status, 2);
  } finally {
    cleanup();
  }
});

test("names each skipped scripts test in a WARNING line, without failing the gate", () => {
  const { run, cleanup } = setup();
  try {
    const tap = [
      "TAP version 13",
      "ok 1 - parses the durations",
      "ok 2 - --named --json gives one record per named query # SKIP worker-test.js missing: run scripts/upstream-test.sh",
      "    ok 1 - a nested case # SKIP",
      "ok 3 - the release bundle returns the values # SKIP release bundle missing",
      "# skipped 3",
    ].join("\n");
    const r = run([], { STUB_OUT_npm: tap });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok       scripts unit tests$/m);
    assert.match(r.stdout, /^WARNING  scripts unit tests skipped 3 test\(s\); a skipped test proves nothing:$/m);
    assert.match(r.stdout, /^  - --named --json gives one record per named query \(worker-test\.js missing: run scripts\/upstream-test\.sh\)$/m);
    assert.match(r.stdout, /^  - a nested case$/m);
    assert.match(r.stdout, /^  - the release bundle returns the values \(release bundle missing\)$/m);
    assert.ok(r.stdout.indexOf("WARNING") > r.stdout.indexOf("== summary"), "the warning is in the summary");
  } finally {
    cleanup();
  }
});

test("prints no WARNING when no scripts test was skipped", () => {
  const { run, cleanup } = setup();
  try {
    const r = run([], { STUB_OUT_npm: "TAP version 13\nok 1 - parses the durations\n# skipped 0" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /WARNING/);
  } finally {
    cleanup();
  }
});

// scripts/build.sh deletes worker-test.js and upstream's suite rebuilds it, so with --upstream the
// gate runs that suite before the scripts tests that need it (CLAUDE.md gotcha; finding s-stage-1-2).
test("--upstream runs upstream's suite before the scripts tests, so a fresh build leaves no skipped test", () => {
  const workerTest = ".upstream/deps/db-sync/worker/dist/worker-test.js";
  const { run, cleanup } = setup({
    upstream: true,
    releaseBundle: true,
    stubs: {
      pnpm: `[ "$1" = test ] && mkdir -p "$(dirname "$CHECK_ROOT/${workerTest}")" && touch "$CHECK_ROOT/${workerTest}"`,
      npm: `if [ "$1" = test ]; then echo "TAP version 13"; if [ -f "$CHECK_ROOT/${workerTest}" ]; then echo "ok 1 - bench --json"; else echo "ok 1 - bench --json # SKIP worker-test.js missing"; fi; exit 0; fi`,
    },
  });
  try {
    const r = run(["--upstream"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /WARNING/, r.stdout);
    const calls = r.calls.split("\n");
    const upstreamAt = calls.indexOf("pnpm test");
    const scriptsAt = calls.indexOf("npm test");
    assert.ok(upstreamAt >= 0 && scriptsAt >= 0, r.calls);
    assert.ok(upstreamAt < scriptsAt, `upstream suite ran after the scripts tests:\n${r.calls}`);
    assert.match(r.stdout, /ok +upstream db-sync tests/);
    assert.match(r.stdout, /ok +release bundle query check/);
    assert.match(r.stdout, /ok +scripts unit tests/);
  } finally {
    cleanup();
  }
});
