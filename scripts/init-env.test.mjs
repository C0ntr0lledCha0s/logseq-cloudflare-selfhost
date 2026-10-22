import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "init-env.sh");

const TOKEN = "dummy_token-123";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const HOST = "sync.example.com";
const inputs = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  SYNC_HOSTNAME: HOST,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "init-env-"));
  copyFileSync(join(root, ".env.local.example"), join(dir, ".env.local.example"));
  return dir;
}

function stubGh(dir, { failOn } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh.log");
  // Node stub: appends one JSON line per call with argv and stdin.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const stdin = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + "\\n");
if (argv[0] === "repo") process.stdout.write("expected/repo\\n");
process.exit(argv[0] === "secret" && argv[2] === ${JSON.stringify(failOn ?? "")} ? 1 : 0);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}
function spawnScript(args, env, cwd = root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, args, {
      cwd,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", SYNC_HOSTNAME: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

const run = (dir, args = [], env = {}, cwd) =>
  spawnScript(args, { INIT_ENV_TEST: "1", INIT_ENV_REPO_ROOT: dir, ...inputs, ...env }, cwd);

const parseEnv = (dir) =>
  Object.fromEntries(
    readFileSync(join(dir, ".env.local"), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

async function withDir(fn) {
  const dir = fixture();
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writes a mode-600 .env.local with inputs and distinct generated secrets", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600);
    const env = parseEnv(dir);
    assert.equal(env.CLOUDFLARE_API_TOKEN, TOKEN);
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
    assert.equal(env.SYNC_HOSTNAME, HOST);
    assert.equal(env.SMOKE_PAT, "");
    const generated = [env.ASSET_LINK_SECRET, env.DB_SYNC_ADMIN_TOKEN, env.TOFU_ENCRYPTION_PASSPHRASE];
    for (const v of generated) assert.match(v, /^[0-9a-f]{64}$/);
    assert.equal(new Set(generated).size, 3);
    assert.match(r.stdout, /password manager/);
    for (const v of [TOKEN, ...generated]) {
      assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "secret leaked to output");
    }
  });
});

test("refuses when .env.local exists and leaves it untouched", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, ".env.local"), "KEEP=me\n");
    const r = await run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /already exists/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "KEEP=me\n");
  });
});

for (const [name, env, pattern] of [
  ["token", { CLOUDFLARE_API_TOKEN: "bad token!" }, /CLOUDFLARE_API_TOKEN/],
  ["account id", { CLOUDFLARE_ACCOUNT_ID: "XYZ" }, /CLOUDFLARE_ACCOUNT_ID/],
  ["hostname with scheme", { SYNC_HOSTNAME: "https://sync.example.com" }, /SYNC_HOSTNAME/],
  ["hostname with slash", { SYNC_HOSTNAME: "sync.example.com/x" }, /SYNC_HOSTNAME/],
  ["hostname with space", { SYNC_HOSTNAME: "sync example.com" }, /SYNC_HOSTNAME/],
]) {
  test(`rejects invalid ${name}`, { timeout: 60000 }, async () => {
    await withDir(async (dir) => {
      const r = await run(dir, [], env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, pattern);
      assert.equal(existsSync(join(dir, ".env.local")), false);
    });
  });
}

test("INIT_ENV_REPO_ROOT without INIT_ENV_TEST=1 is rejected", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await spawnScript([], { ...inputs, INIT_ENV_REPO_ROOT: dir, INIT_ENV_TEST: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /test-only/);
  });
});

test("--push sets each secret via gh with the value on stdin only", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const { bin, log } = stubGh(dir);
    const elsewhere = mkdtempSync(join(tmpdir(), "init-env-cwd-"));
    const r = await run(dir, ["--push"], { PATH: `${bin}:${process.env.PATH}` }, elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /expected\/repo/);
    const env = parseEnv(dir);
    const all = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(all[0].argv.slice(0, 2), ["repo", "view"]);
    assert.equal(realpathSync(all[0].cwd), realpathSync(dir), "repo derived from the checkout, not cwd");
    assert.deepEqual(all[1].argv, ["api", "repos/expected/repo/environments/production"]);
    const calls = all.slice(2);
    const names = [
      "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE",
      "ASSET_LINK_SECRET", "DB_SYNC_ADMIN_TOKEN", "SYNC_HOSTNAME",
    ];
    assert.equal(calls.length, names.length);
    calls.forEach((c, i) => {
      assert.deepEqual(c.argv, ["secret", "set", names[i], "-R", "expected/repo", "--env", "production"]);
      assert.equal(c.stdin, env[names[i]]);
      assert.ok(!c.argv.join(" ").includes(env[names[i]]), "value in argv");
    });
    for (const v of Object.values(env).filter(Boolean)) {
      assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "secret leaked to output");
    }
  });
});

test("--push fails fast when gh is missing", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    // A PATH holding only what the script needs before it reaches the gh check.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["bash", "dirname", "openssl"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`]).stdout.toString().trim();
      symlinkSync(found, join(bin, tool));
    }
    const r = await run(dir, ["--push"], { PATH: bin });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires the GitHub CLI/);
    assert.equal(existsSync(join(dir, ".env.local")), false);
  });
});

test("no terminal and missing inputs fails with a clear message", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir, [], { SYNC_HOSTNAME: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no terminal: export CLOUDFLARE_API_TOKEN/);
    assert.equal(existsSync(join(dir, ".env.local")), false);
  });
});

test("--push stops when gh fails", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const { bin, log } = stubGh(dir, { failOn: "CLOUDFLARE_ACCOUNT_ID" });
    const r = await run(dir, ["--push"], { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    const secretCalls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[0] === "secret");
    assert.equal(secretCalls.length, 2);
    assert.match(r.stderr, /re-run the push with the README 1\.8 loop/);
    assert.equal(existsSync(join(dir, ".env.local")), true);
  });
});
