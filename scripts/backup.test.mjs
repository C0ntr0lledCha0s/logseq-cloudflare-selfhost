import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "backup.sh");

const GRAPH_IDS = [
  "11111111-aaaa-4aaa-8aaa-111111111111",
  "22222222-bbbb-4bbb-8bbb-222222222222",
  "33333333-cccc-4ccc-8ccc-333333333333",
];

const wranglerStub = `#!/usr/bin/env bash
echo "wrangler $*" >> "$STUB_LOG"
if [ "$1 $2" = "d1 export" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--output" ] && echo "-- sql" > "$2"; shift; done
  [ -n "\${STUB_D1_EXPORT_FAIL:-}" ] && exit 1
  exit 0
fi
if [ "$1 $2" = "d1 execute" ]; then
  node -e 'console.log(JSON.stringify([{results: process.env.STUB_GRAPH_IDS.split(",").filter(Boolean).map((g) => ({graph_id: g})), success: true}]))'
  exit 0
fi
if [ "$1 $2" = "r2 object" ]; then
  echo "uploading $*"
  exit 0
fi
exit 2
`;

const nodeStub = `#!/usr/bin/env bash
case "\${1:-}" in
  *download_graph_db.js)
    echo "node $*" >> "$STUB_LOG"
    echo "DB_SYNC_ADMIN_TOKEN=\${DB_SYNC_ADMIN_TOKEN:-unset}" >> "$STUB_LOG"
    n=$(grep -c 'download_graph_db.js' "$STUB_LOG")
    echo "downloading $*" >&2
    if [ "$n" = "\${STUB_FAIL_DOWNLOAD:-0}" ]; then exit 1; fi
    out=""; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
    echo sqlite > "$out"
    exit 0 ;;
esac
exec "$REAL_NODE" "$@"
`;

const rcloneStub = `#!/usr/bin/env bash
echo "rclone $*" >> "$STUB_LOG"
echo "R2_ENDPOINT=\${RCLONE_CONFIG_R2_ENDPOINT:-unset}" >> "$STUB_LOG"
[ -n "\${STUB_RCLONE_FAIL:-}" ] && exit 1
exit 0
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "backup-test-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const out = join(dir, "out");
  writeFileSync(log, "");
  for (const [name, body] of [["wrangler", wranglerStub], ["node", nodeStub], ["rclone", rcloneStub]]) {
    const p = name === "wrangler" ? join(dir, name) : join(bin, name);
    if (name !== "wrangler") mkdirp(bin);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return { dir, bin, log, out };
}

import { mkdirSync } from "node:fs";
const mkdirp = (p) => mkdirSync(p, { recursive: true });

function run(ctx, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(script, [ctx.out], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${ctx.bin}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        WRANGLER: join(ctx.dir, "wrangler"),
        STUB_LOG: ctx.log,
        STUB_GRAPH_IDS: GRAPH_IDS.join(","),
        CLOUDFLARE_API_TOKEN: "cf-token-secret",
        CLOUDFLARE_ACCOUNT_ID: "acct123",
        DB_SYNC_ADMIN_TOKEN: "admin-token-secret",
        SYNC_HOSTNAME: "sync.example.com",
        R2_ACCESS_KEY_ID: "r2-key-id",
        R2_SECRET_ACCESS_KEY: "r2-secret",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr, log: readFileSync(ctx.log, "utf8") }));
  });
}

async function withCtx(fn) {
  const ctx = setup();
  try {
    return await fn(ctx);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
}

test("uploads d1 export before graphs", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.log.split("\n");
    const put = lines.findIndex((l) => /r2 object put.*index\.sql/.test(l));
    const dl = lines.findIndex((l) => l.includes("download_graph_db.js"));
    assert.ok(put >= 0, "index.sql upload missing");
    assert.ok(dl > put, "graph download happened before index.sql upload");
    assert.match(r.stdout, /backup: d1=ok graphs=3\/3 assets=ok/);
    assert.match(r.log, /logseq-sync-backups\/\d{4}-\d\d-\d\d\/graphs\/index\.json/);
    assert.match(r.log, /rclone sync r2:logseq-sync-assets r2:logseq-sync-backups\/assets/);
    assert.match(r.log, /R2_ENDPOINT=https:\/\/acct123\.r2\.cloudflarestorage\.com/);
    assert.match(r.log, /DB_SYNC_ADMIN_TOKEN=admin-token-secret/);
    assert.ok(!/--admin-token|admin-token-secret.*node|node.*admin-token-secret/.test(r.log));
  }));

test("one failed graph still exits 1 after uploading the rest", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { STUB_FAIL_DOWNLOAD: "2" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /graphs=2\/3/);
    const uploads = r.log.split("\n").filter((l) => /r2 object put.*graphs\/\d+\.sqlite/.test(l));
    assert.equal(uploads.length, 2);
  }));

test("never prints graph ids", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { STUB_FAIL_DOWNLOAD: "2" });
    const printed = r.stdout + r.stderr;
    for (const id of GRAPH_IDS) assert.ok(!printed.includes(id), "graph id leaked");
    for (const secret of ["admin-token-secret", "cf-token-secret", "r2-secret"]) {
      assert.ok(!printed.includes(secret), "secret leaked");
    }
  }));

test("zero graphs is valid", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { STUB_GRAPH_IDS: "" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /graphs=0\/0/);
  }));

test("failed d1 export still backs up the rest and exits 1", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { STUB_D1_EXPORT_FAIL: "1" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /d1=fail graphs=3\/3 assets=ok/);
  }));

test("failed asset sync exits 1", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { STUB_RCLONE_FAIL: "1" });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /assets=fail/);
  }));

test("requires WRANGLER", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { WRANGLER: "" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /WRANGLER/);
    assert.ok(!existsSync(join(ctx.out, "index.sql")));
  }));

test("fails fast when SYNC_HOSTNAME is unset", { timeout: 30000 }, () =>
  withCtx(async (ctx) => {
    const r = await run(ctx, { SYNC_HOSTNAME: "" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /SYNC_HOSTNAME/);
    assert.ok(!/download_graph_db|wrangler/.test(r.log));
  }));
