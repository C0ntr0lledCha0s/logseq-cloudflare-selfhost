import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "check.sh");

// A fake repository root plus stub npm/node/pnpm/tofu that log their arguments and exit with
// the status named in STUB_FAIL_<tool> (0 when unset).
function setup({ vendor = false, upstream = false, nodeModules = true } = {}) {
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
  const log = join(dir, "calls.log");
  for (const tool of ["npm", "node", "pnpm", "tofu"]) {
    const stub = join(bin, tool);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "${tool} $*" >> "${log}"\nexit "\${STUB_FAIL_${tool}:-0}"\n`,
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
