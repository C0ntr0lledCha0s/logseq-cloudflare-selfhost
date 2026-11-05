import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_LIMITS, assess, measure, periods, usageReport } from "./usage-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "usage-report.mjs");

/** The shape Cloudflare's GraphQL API returns, trimmed to what the report reads. */
function account(overrides = {}) {
  return {
    workers: [
      { dimensions: { scriptName: "logseq-sync" }, sum: { requests: 600, errors: 0 } },
      { dimensions: { scriptName: "logseq-connector" }, sum: { requests: 400, errors: 3 } },
    ],
    doInvocations: [{ sum: { requests: 900 } }],
    doPeriodic: [{ sum: { duration: 40.5, rowsRead: 200_000, rowsWritten: 4_000 } }],
    d1: [{ sum: { rowsRead: 1_000_000, rowsWritten: 500 } }],
    kv: [
      { dimensions: { actionType: "read" }, sum: { requests: 100 } },
      { dimensions: { actionType: "write" }, sum: { requests: 20 } },
    ],
    ai: [],
    vectorStorage: [{ dimensions: { indexName: "blocks" }, max: { storedVectorDimensions: 1_939_200 } }],
    vectorQueries: [{ sum: { queriedVectorDimensions: 65_280 } }],
    ...overrides,
  };
}

/** A fetch that answers every call with `body` (as JSON) and records the requests. */
function fakeFetch(body, status = 200) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const NOON = new Date("2026-11-05T12:00:00Z");

test("periods measure the UTC day and month", () => {
  const p = periods(NOON);
  assert.equal(p.dayStart.toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(p.monthStart.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(p.share.day, 0.5);
  assert.equal(p.share.month, (4 * 24 + 12) / (30 * 24));
});

test("measure sums each dataset and treats an empty one as no usage", () => {
  const usage = measure(account());
  assert.deepEqual(Object.keys(usage).sort(), FREE_LIMITS.map((l) => l.key).sort());
  assert.equal(usage["workers.requests"], 1_000);
  assert.equal(usage["kv.read"], 100);
  assert.equal(usage["kv.delete"], 0);
  assert.equal(usage["ai.neurons"], 0);
  assert.equal(usage["vectorize.stored"], 1_939_200);
});

test("a row alerts at the threshold or when its projection passes the limit", () => {
  const share = { day: 0.5, month: 0.5 };
  const byKey = (usage) =>
    Object.fromEntries(assess({ ...measure(account()), ...usage }, { share, threshold: 0.7 }).map((r) => [r.key, r]));

  const quiet = byKey({});
  assert.ok(Object.values(quiet).every((r) => !r.alert));
  assert.equal(quiet["d1.rowsRead"].projected, 2_000_000);
  assert.equal(quiet["vectorize.stored"].projected, null);

  assert.equal(byKey({ "d1.rowsRead": 3_500_000 })["d1.rowsRead"].alert, true, "70% used");
  assert.equal(byKey({ "d1.rowsRead": 2_600_000 })["d1.rowsRead"].alert, true, "on course for 5.2M");
  assert.equal(byKey({ "d1.rowsRead": 2_500_000 })["d1.rowsRead"].alert, false, "on course for exactly the limit");
  assert.equal(byKey({ "vectorize.stored": 3_500_000 })["vectorize.stored"].alert, true, "a stored total alerts at the threshold");
});

test("a projection from early in the period is not trusted", () => {
  const usage = { ...measure(account()), "kv.write": 100 };
  const early = assess(usage, { share: { day: 0.1, month: 0.1 }, threshold: 0.7 }).find((r) => r.key === "kv.write");
  assert.equal(early.projected, null);
  assert.equal(early.alert, false);
  const later = assess(usage, { share: { day: 0.125, month: 0.125 }, threshold: 0.7 }).find((r) => r.key === "kv.write");
  assert.equal(later.projected, 800);
});

test("a missing measurement is an error, not zero", () => {
  const usage = measure(account());
  delete usage["d1.rowsRead"];
  assert.throws(() => assess(usage, { share: { day: 0.5, month: 0.5 }, threshold: 0.7 }), /no usage measured for d1\.rowsRead/);
});

test("the report queries today in UTC and lists every allowance and Worker", async () => {
  const { fetch, calls } = fakeFetch({ data: { viewer: { accounts: [account()] } } });
  const { report, alert } = await usageReport({ accountId: "acct", token: "tok", now: NOON, threshold: 0.7, fetch });
  assert.equal(alert, false);
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(calls[0].body.variables, {
    account: "acct",
    start: "2026-11-05T00:00:00.000Z",
    end: "2026-11-05T12:00:00.000Z",
    day: "2026-11-05",
    monthStart: "2026-11-01",
  });
  for (const { label } of FREE_LIMITS) assert.match(report, new RegExp(`\\| ${label.replace(/[()]/g, "\\$&")} \\|`));
  assert.match(report, /\| ✅ \| D1 rows read \| 1,000,000 today \| 5,000,000 \| 20% \| 2,000,000 \(40%\) \|/);
  assert.match(report, /- logseq-connector: 3 of 400 requests\n- logseq-sync: 0 of 600 requests/);
  assert.match(report, /All allowances are within bounds\./);
});

test("the report names the allowances that alert", async () => {
  const { fetch } = fakeFetch({ data: { viewer: { accounts: [account({ d1: [{ sum: { rowsRead: 2_600_000, rowsWritten: 0 } }] })] } } });
  const { report, alert } = await usageReport({ accountId: "acct", token: "tok", now: NOON, threshold: 0.7, fetch });
  assert.equal(alert, true);
  assert.match(report, /\| ⚠️ \| D1 rows read \|/);
  assert.match(report, /\*\*1 allowance\(s\) need attention:\*\* D1 rows read\./);
});

test("API failures are errors", async () => {
  const args = { accountId: "acct", token: "tok", now: NOON, threshold: 0.7 };
  await assert.rejects(usageReport({ ...args, fetch: fakeFetch({ errors: [{ message: "not authorized" }] }, 403).fetch }), /HTTP 403/);
  await assert.rejects(
    usageReport({ ...args, fetch: fakeFetch({ data: null, errors: [{ message: "not authorized for that account" }] }).fetch }),
    /Cloudflare analytics failed: not authorized for that account/,
  );
  await assert.rejects(usageReport({ ...args, fetch: fakeFetch({ data: { viewer: { accounts: [] } } }).fetch }), /no data for account acct/);
});

/** Runs the CLI with `settings` written to a temp file; no network is reached before these checks. */
function cli(args, settings, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "usage-report-"));
  try {
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify(settings));
    const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ...rest } = process.env;
    return spawnSync("node", [script, ...args.map((a) => (a === "SETTINGS" ? file : a))], { env: { ...rest, ...env }, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the CLI refuses a paid plan, a bad threshold and missing credentials", () => {
  const paid = cli(["--settings", "SETTINGS"], { plan: "paid" });
  assert.equal(paid.status, 1);
  assert.match(paid.stderr, /only the Workers Free plan allowances, and settings\.plan is paid/);

  const threshold = cli(["--settings", "SETTINGS", "--threshold", "70"], { plan: "free" });
  assert.equal(threshold.status, 2);

  const creds = cli(["--settings", "SETTINGS"], { plan: "free" });
  assert.equal(creds.status, 1);
  assert.match(creds.stderr, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required/);
});

test("the usage workflow runs the report with the analytics token, only when enabled", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "usage.yml"), "utf8");
  assert.match(workflow, /if: vars\.USAGE_REPORT_ENABLED == 'true'/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ANALYTICS_TOKEN \}\}/);
  assert.match(workflow, /run: node scripts\/usage-report\.mjs --settings config\/settings\.json/);
});
