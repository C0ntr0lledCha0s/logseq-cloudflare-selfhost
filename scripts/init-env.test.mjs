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
const CONNECTOR_INPUTS = {
  CONNECTOR_HOSTNAME: "mcp.example.com",
  GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
  GITHUB_CLIENT_SECRET: "ghsecret0123456789abcdef0123456789abcdef01",
  OWNER_GITHUB_USER_ID: "1234567",
};
const ALLOWED = "DB_SYNC_ALLOWED_USERS";
// Made-up Logseq user IDs (never real ones).
const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ORIGINAL_NAMES = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE",
  "ASSET_LINK_SECRET", "DB_SYNC_ADMIN_TOKEN", "SYNC_HOSTNAME",
];
// GitHub rejects secret names starting with GITHUB_, so --push sets these two under a CONNECTOR_ prefix.
const pushedName = (n) => (n === "GITHUB_CLIENT_ID" || n === "GITHUB_CLIENT_SECRET" ? `CONNECTOR_${n}` : n);
const CONNECTOR_NAMES = [
  "CONNECTOR_HOSTNAME", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY",
];
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
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", SYNC_HOSTNAME: "",
        CONNECTOR_HOSTNAME: "", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "", OWNER_GITHUB_USER_ID: "",
        DB_SYNC_ALLOWED_USERS: "",
        ...env,
      },
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
      "ASSET_LINK_SECRET", "DB_SYNC_ADMIN_TOKEN", "SYNC_HOSTNAME", "DB_SYNC_ALLOWED_USERS",
    ];
    assert.equal(calls.length, names.length);
    assert.equal(calls.length, 7);
    assert.match(r.stdout, /Pushed 7 secrets/);
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

const HEX64 = /^[0-9a-f]{64}$/;
const SIX_ORIGINAL = [
  `CLOUDFLARE_API_TOKEN=${TOKEN}`, `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}`,
  `TOFU_ENCRYPTION_PASSPHRASE=${"a".repeat(64)}`, `ASSET_LINK_SECRET=${"b".repeat(64)}`,
  `DB_SYNC_ADMIN_TOKEN=${"c".repeat(64)}`, `SYNC_HOSTNAME=${HOST}`,
];
// An existing .env.local, with a comment, an optional name and odd spacing that must survive.
const ALLOWED_LINE = "DB_SYNC_ALLOWED_USERS=none";
const EXISTING = `# my local secrets\n${SIX_ORIGINAL.join("\n")}\n${ALLOWED_LINE}\n\nSMOKE_PAT=logseq_pat_x  \n# PAT_WORK=\n`;
const writeExisting = (dir, text, mode = 0o644) => {
  writeFileSync(join(dir, ".env.local"), text);
  chmodSync(join(dir, ".env.local"), mode);
};
const secretsOf = (env) =>
  Object.entries(env).filter(([k, v]) => v && /TOKEN|SECRET|KEY|PASSPHRASE/.test(k)).map(([, v]) => v);

test("fresh run is unchanged: asks for no connector values and writes none", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir, [], CONNECTOR_INPUTS);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = parseEnv(dir);
    for (const name of CONNECTOR_NAMES) assert.equal(name in env, false, name);
    assert.ok(!readFileSync(join(dir, ".env.local"), "utf8").includes(CONNECTOR_INPUTS.GITHUB_CLIENT_SECRET));
  });
});

test("--add-missing appends only missing names, preserves existing bytes, mode 600", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    // Original inputs are in the environment too but must be ignored: those names exist.
    const r = await run(dir, ["--add-missing"], { ...CONNECTOR_INPUTS, SYNC_HOSTNAME: "other.example.com" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    assert.ok(after.startsWith(EXISTING), "existing bytes changed");
    assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600);
    const appended = after.slice(EXISTING.length);
    assert.match(appended, /^\n# --- added by scripts\/init-env.sh --add-missing ---\n/);
    const lines = appended.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    assert.deepEqual(lines.map((l) => l.split("=")[0]), CONNECTOR_NAMES);
    const env = parseEnv(dir);
    assert.equal(env.SYNC_HOSTNAME, HOST);
    for (const k of ["CONNECTOR_HOSTNAME", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "OWNER_GITHUB_USER_ID"]) {
      assert.equal(env[k], CONNECTOR_INPUTS[k]);
    }
    assert.match(env.COOKIE_ENCRYPTION_KEY, HEX64);
    assert.match(env.GRAPH_TOKEN_KEY, HEX64);
    assert.notEqual(env.COOKIE_ENCRYPTION_KEY, env.GRAPH_TOKEN_KEY);
    for (const v of secretsOf(env)) {
      assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "secret leaked to output");
    }
  });
});

// The three secrets whose value the deployment already depends on: --add-missing never generates them.
const STATE_SECRETS = {
  TOFU_ENCRYPTION_PASSPHRASE: /OpenTofu state/,
  ASSET_LINK_SECRET: /deployed sync Worker/,
  DB_SYNC_ADMIN_TOKEN: /deployed sync Worker/,
};

test("--add-missing fills missing prompted original names too and handles no trailing newline", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const state = SIX_ORIGINAL.filter((l) => l.split("=")[0] in STATE_SECRETS);
    const existing = `${state.join("\n")}\n${ALLOWED_LINE}\nSMOKE_PAT=keep`;
    writeExisting(dir, existing);
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    assert.ok(after.startsWith(existing + "\n"));
    const added = after.slice(existing.length).split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    assert.deepEqual(added, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "SYNC_HOSTNAME", ...CONNECTOR_NAMES]);
    const env = parseEnv(dir);
    assert.equal(env.SMOKE_PAT, "keep");
    assert.equal(env.CLOUDFLARE_API_TOKEN, TOKEN);
    assert.equal(env.SYNC_HOSTNAME, HOST);
    for (const k of ["COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY"]) assert.match(env[k], HEX64, k);
    for (const name of [...ORIGINAL_NAMES, ...CONNECTOR_NAMES]) assert.ok(name in env, name);
    assert.match(r.stdout, /password manager/);
  });
});

for (const [missing, why] of Object.entries(STATE_SECRETS)) {
  test(`--add-missing --push refuses, writing and pushing nothing, when ${missing} is missing`, { timeout: 60000 }, async () => {
    await withDir(async (dir) => {
      const existing = `${SIX_ORIGINAL.filter((l) => !l.startsWith(`${missing}=`)).join("\n")}\n`;
      writeExisting(dir, existing);
      const { bin, log } = stubGh(dir);
      const r = await run(dir, ["--add-missing", "--push"], { ...CONNECTOR_INPUTS, PATH: `${bin}:${process.env.PATH}` });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`${missing} is missing from \\.env\\.local — restore it from your password manager`));
      assert.match(r.stderr, why);
      assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), existing);
      assert.equal(existsSync(log), false, "gh must not be called");
    });
  });
}

test("--add-missing names every missing state secret at once", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, "SMOKE_PAT=keep\n");
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.notEqual(r.status, 0);
    for (const name of Object.keys(STATE_SECRETS)) assert.match(r.stderr, new RegExp(`${name} is missing`));
    assert.match(r.stderr, /nothing was written or pushed/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "SMOKE_PAT=keep\n");
  });
});

test("--add-missing with nothing missing leaves the file alone", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const full = `${EXISTING}${CONNECTOR_NAMES.map((n) => `${n}=v`).join("\n")}\n`;
    writeExisting(dir, full);
    const { bin, log } = stubGh(dir);
    const r = await run(dir, ["--add-missing", "--push"], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), full);
    assert.match(r.stdout, /nothing missing/);
    assert.equal(existsSync(log), false, "gh must not be called when nothing is missing");
  });
});

test("--add-missing --push pushes only added names with -R", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const { bin, log } = stubGh(dir);
    const elsewhere = mkdtempSync(join(tmpdir(), "init-env-cwd-"));
    const r = await run(dir, ["--add-missing", "--push"], { ...CONNECTOR_INPUTS, PATH: `${bin}:${process.env.PATH}` }, elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const env = parseEnv(dir);
    const all = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(all[0].argv.slice(0, 2), ["repo", "view"]);
    assert.deepEqual(all[1].argv, ["api", "repos/expected/repo/environments/production"]);
    const calls = all.slice(2);
    assert.equal(calls.length, CONNECTOR_NAMES.length);
    calls.forEach((c, i) => {
      assert.deepEqual(c.argv, ["secret", "set", pushedName(CONNECTOR_NAMES[i]), "-R", "expected/repo", "--env", "production"]);
      assert.equal(c.stdin, env[CONNECTOR_NAMES[i]]);
      assert.ok(!c.argv.join(" ").includes(env[CONNECTOR_NAMES[i]]), "value in argv");
    });
    assert.match(r.stdout, /Pushed 6 secrets/);
    const pushed = calls.map((c) => c.argv[2]);
    assert.ok(pushed.includes("CONNECTOR_GITHUB_CLIENT_ID") && pushed.includes("CONNECTOR_GITHUB_CLIENT_SECRET"));
    assert.ok(pushed.every((n) => !n.startsWith("GITHUB_")), "GitHub rejects GITHUB_-prefixed secret names");
    for (const v of secretsOf(env)) {
      assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), "secret leaked to output");
    }
  });
});

for (const [name, env, pattern] of [
  ["non-numeric OWNER_GITHUB_USER_ID", { OWNER_GITHUB_USER_ID: "octocat" }, /OWNER_GITHUB_USER_ID/],
  ["empty-ish OWNER_GITHUB_USER_ID with a space", { OWNER_GITHUB_USER_ID: "12 34" }, /OWNER_GITHUB_USER_ID/],
  ["OWNER_GITHUB_USER_ID with a leading zero", { OWNER_GITHUB_USER_ID: "01234" }, /OWNER_GITHUB_USER_ID must be a positive integer/],
  ["OWNER_GITHUB_USER_ID of zero", { OWNER_GITHUB_USER_ID: "0" }, /OWNER_GITHUB_USER_ID must be a positive integer/],
  ["CONNECTOR_HOSTNAME with scheme", { CONNECTOR_HOSTNAME: "https://mcp.example.com" }, /CONNECTOR_HOSTNAME/],
  ["CONNECTOR_HOSTNAME with slash", { CONNECTOR_HOSTNAME: "mcp.example.com/x" }, /CONNECTOR_HOSTNAME/],
  ["CONNECTOR_HOSTNAME with uppercase", { CONNECTOR_HOSTNAME: "MCP.Example.com" }, /CONNECTOR_HOSTNAME must be lowercase/],
  ["CONNECTOR_HOSTNAME with a port", { CONNECTOR_HOSTNAME: "mcp.example.com:443" }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME with a trailing dot", { CONNECTOR_HOSTNAME: "mcp.example.com." }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME with one label", { CONNECTOR_HOSTNAME: "localhost" }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME with a 64-character label", { CONNECTOR_HOSTNAME: `${"a".repeat(64)}.example.com` }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["CONNECTOR_HOSTNAME over 253 characters", { CONNECTOR_HOSTNAME: `${Array(4).fill("a".repeat(63)).join(".")}.com` }, /CONNECTOR_HOSTNAME must be a bare lowercase hostname/],
  ["GITHUB_CLIENT_SECRET with whitespace", { GITHUB_CLIENT_SECRET: "abc def" }, /GITHUB_CLIENT_SECRET/],
  ["GITHUB_CLIENT_ID with whitespace", { GITHUB_CLIENT_ID: "abc def" }, /GITHUB_CLIENT_ID/],
]) {
  test(`--add-missing rejects ${name}`, { timeout: 60000 }, async () => {
    await withDir(async (dir) => {
      writeExisting(dir, EXISTING);
      const r = await run(dir, ["--add-missing"], { ...CONNECTOR_INPUTS, ...env });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, pattern);
      assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), EXISTING);
      assert.ok(!r.stdout.includes(CONNECTOR_INPUTS.GITHUB_CLIENT_SECRET) && !r.stderr.includes(CONNECTOR_INPUTS.GITHUB_CLIENT_SECRET));
    });
  });
}

test("--add-missing needs an existing .env.local", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs an existing/);
    assert.equal(existsSync(join(dir, ".env.local")), false);
  });
});

test("--add-missing refuses a present-but-empty name instead of duplicating it", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const existing = `${SIX_ORIGINAL.join("\n")}\n${ALLOWED_LINE}\nGITHUB_CLIENT_ID=\n`;
    writeExisting(dir, existing);
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /GITHUB_CLIENT_ID is present but empty/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), existing);
  });
});

test("--add-missing without a terminal names the missing inputs", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const r = await run(dir, ["--add-missing"], { OWNER_GITHUB_USER_ID: "" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no terminal: export CONNECTOR_HOSTNAME, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, OWNER_GITHUB_USER_ID/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), EXISTING);
  });
});

test("rejects unknown arguments", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir, ["--nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: init-env.sh \[--add-missing\] \[--push\]/);
  });
});

function stubFailingOpenssl(dir) {
  const bin = join(dir, "badbin");
  mkdirSync(bin);
  writeFileSync(join(bin, "openssl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "openssl"), 0o755);
  return bin;
}

test("fresh run fails and writes nothing when key generation fails", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const bin = stubFailingOpenssl(dir);
    const r = await run(dir, [], { PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /openssl rand failed/);
    assert.equal(existsSync(join(dir, ".env.local")), false);
  });
});

test("--add-missing fails and leaves the file unchanged when key generation fails", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const bin = stubFailingOpenssl(dir);
    const r = await run(dir, ["--add-missing"], { ...CONNECTOR_INPUTS, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /openssl rand failed/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), EXISTING);
  });
});

test("--add-missing treats `export NAME=` and indented `NAME=` lines as present", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const existing = `${SIX_ORIGINAL.map((l) => `export ${l}`).join("\n")}\nexport ${ALLOWED_LINE}\n  CONNECTOR_HOSTNAME=mcp.example.com\nexport GITHUB_CLIENT_ID=abc\n`;
    writeExisting(dir, existing);
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    assert.ok(after.startsWith(existing));
    const added = after.slice(existing.length).split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    assert.deepEqual(added, ["GITHUB_CLIENT_SECRET", "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY"]);
  });
});

test("--add-missing treats an empty `export NAME=` line as present-but-empty", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const existing = `${SIX_ORIGINAL.join("\n")}\n${ALLOWED_LINE}\nexport GITHUB_CLIENT_ID=\n`;
    writeExisting(dir, existing);
    const r = await run(dir, ["--add-missing"], CONNECTOR_INPUTS);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /GITHUB_CLIENT_ID is present but empty/);
  });
});

test("--add-missing no-terminal message lists only the unset inputs", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const r = await run(dir, ["--add-missing"], { CONNECTOR_HOSTNAME: "mcp.example.com", GITHUB_CLIENT_ID: "abc" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no terminal: export GITHUB_CLIENT_SECRET, OWNER_GITHUB_USER_ID\n/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), EXISTING);
  });
});

test("--add-missing --push names the mapped secret when gh fails", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const { bin } = stubGh(dir, { failOn: "CONNECTOR_GITHUB_CLIENT_ID" });
    const r = await run(dir, ["--add-missing", "--push"], { ...CONNECTOR_INPUTS, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /failed to set CONNECTOR_GITHUB_CLIENT_ID/);
  });
});

test("--add-missing accepts a 253-character lowercase CONNECTOR_HOSTNAME", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, EXISTING);
    const host = `${Array(3).fill("a".repeat(63)).join(".")}.${"b".repeat(61)}`;
    assert.equal(host.length, 253);
    const r = await run(dir, ["--add-missing"], { ...CONNECTOR_INPUTS, CONNECTOR_HOSTNAME: host });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(parseEnv(dir).CONNECTOR_HOSTNAME, host);
  });
});

// --- DB_SYNC_ALLOWED_USERS ---

test("fresh run writes DB_SYNC_ALLOWED_USERS=none, whatever the environment holds, and says what to do next", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const r = await run(dir, [], { DB_SYNC_ALLOWED_USERS: USER_A });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(parseEnv(dir).DB_SYNC_ALLOWED_USERS, "none");
    assert.match(r.stdout, /db-sync\/user-not-allowed/);
    assert.match(r.stdout, /README section 9\.1/);
  });
});

test("fresh --push pushes DB_SYNC_ALLOWED_USERS as the seventh secret, with the file's value on stdin", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const { bin, log } = stubGh(dir);
    const r = await run(dir, ["--push"], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[0] === "secret");
    assert.equal(calls.length, 7);
    assert.deepEqual(calls[6].argv, ["secret", "set", ALLOWED, "-R", "expected/repo", "--env", "production"]);
    assert.equal(calls[6].stdin, "none");
  });
});

// A file with the six original names and nothing else: only DB_SYNC_ALLOWED_USERS is missing.
const SIX_ONLY = `${SIX_ORIGINAL.join("\n")}\n`;
const NO_CONNECTOR = { CONNECTOR_HOSTNAME: "x.example.com", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x", OWNER_GITHUB_USER_ID: "1" };
const CONNECTOR_PRESENT = `${CONNECTOR_NAMES.map((n) => `${n}=v`).join("\n")}\n`;

test("--add-missing appends DB_SYNC_ALLOWED_USERS from the environment, never generated, and pushes it", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const existing = SIX_ONLY + CONNECTOR_PRESENT;
    writeExisting(dir, existing);
    const { bin, log } = stubGh(dir);
    // Typed with a space, written without one: a space would break sourcing .env.local.
    const typed = `${USER_A}, ${USER_B}`;
    const list = `${USER_A},${USER_B}`;
    const r = await run(dir, ["--add-missing", "--push"], { DB_SYNC_ALLOWED_USERS: typed, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readFileSync(join(dir, ".env.local"), "utf8");
    assert.ok(after.startsWith(existing));
    assert.equal(after.slice(existing.length), `\n# --- added by scripts/init-env.sh --add-missing ---\nDB_SYNC_ALLOWED_USERS=${list}\n`);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.argv[0] === "secret");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["secret", "set", ALLOWED, "-R", "expected/repo", "--env", "production"]);
    assert.equal(calls[0].stdin, list);
    assert.match(r.stdout, /Pushed 1 secrets/);
  });
});

test("--add-missing does not ask for the connector values when only DB_SYNC_ALLOWED_USERS is missing", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, SIX_ONLY + CONNECTOR_PRESENT);
    const r = await run(dir, ["--add-missing"], { DB_SYNC_ALLOWED_USERS: "none" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(join(dir, ".env.local"), "utf8"), /\nDB_SYNC_ALLOWED_USERS=none\n$/);
    assert.match(r.stdout, /db-sync\/user-not-allowed/);
  });
});

for (const [name, value] of [
  ["a non-UUID", "bob"],
  ["an uppercase UUID", USER_A.toUpperCase()],
  ["an empty entry", `${USER_A},,${USER_B}`],
  ["a trailing comma", `${USER_A},`],
]) {
  // GITHUB_ACTIONS=true switches check-format to `::error::` on stdout; init-env must still show the error.
  for (const actions of ["", "true"]) {
    test(`--add-missing --push rejects ${name} in DB_SYNC_ALLOWED_USERS, writing and pushing nothing (GITHUB_ACTIONS=${actions || "unset"})`, { timeout: 60000 }, async () => {
      await withDir(async (dir) => {
        const existing = SIX_ONLY + CONNECTOR_PRESENT;
        writeExisting(dir, existing);
        const { bin, log } = stubGh(dir);
        const r = await run(dir, ["--add-missing", "--push"], { DB_SYNC_ALLOWED_USERS: value, GITHUB_ACTIONS: actions, PATH: `${bin}:${process.env.PATH}` });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /^error: DB_SYNC_ALLOWED_USERS entry \d+ of \d+ is not a lowercase UUID/m);
        assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), existing, "file must be byte-identical");
        assert.equal(existsSync(log), false, "gh must not be called");
        assert.ok(!(r.stdout + r.stderr).includes(value), "the value must not be printed");
      });
    });
  }
}

test("--add-missing without a terminal lists DB_SYNC_ALLOWED_USERS with the other unset inputs", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, SIX_ONLY);
    const r = await run(dir, ["--add-missing"], { CONNECTOR_HOSTNAME: "mcp.example.com", GITHUB_CLIENT_ID: "abc" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no terminal: export GITHUB_CLIENT_SECRET, OWNER_GITHUB_USER_ID, DB_SYNC_ALLOWED_USERS\n/);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), SIX_ONLY);
  });
});

test("--add-missing leaves an existing DB_SYNC_ALLOWED_USERS line alone, even when the environment differs", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    const existing = `${SIX_ONLY}DB_SYNC_ALLOWED_USERS=${USER_B}\n${CONNECTOR_PRESENT}`;
    writeExisting(dir, existing);
    const { bin, log } = stubGh(dir);
    const r = await run(dir, ["--add-missing", "--push"], { DB_SYNC_ALLOWED_USERS: USER_A, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), existing);
    assert.equal(existsSync(log), false, "nothing was added, so nothing is pushed");
  });
});

test("a missing DB_SYNC_ALLOWED_USERS is never listed as something to restore from the password manager", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, `${SIX_ONLY.replace(/^TOFU_ENCRYPTION_PASSPHRASE=.*\n/m, "")}`);
    const r = await run(dir, ["--add-missing"], { ...NO_CONNECTOR, DB_SYNC_ALLOWED_USERS: "none" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TOFU_ENCRYPTION_PASSPHRASE is missing/);
    assert.ok(!/DB_SYNC_ALLOWED_USERS is missing/.test(r.stderr));
  });
});

test("--add-missing --push names DB_SYNC_ALLOWED_USERS when gh fails to set it", { timeout: 60000 }, async () => {
  await withDir(async (dir) => {
    writeExisting(dir, SIX_ONLY + CONNECTOR_PRESENT);
    const { bin } = stubGh(dir, { failOn: ALLOWED });
    const r = await run(dir, ["--add-missing", "--push"], { DB_SYNC_ALLOWED_USERS: USER_A, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /failed to set DB_SYNC_ALLOWED_USERS/);
  });
});
