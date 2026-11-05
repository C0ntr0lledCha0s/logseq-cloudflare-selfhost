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

/**
 * A fetch that records the requests and answers each with `body` (as JSON), or with `recentBody`
 * when it asks for the recent hour rather than the day.
 */
function fakeFetch(body, status = 200, recentBody = body) {
  const calls = [];
  const fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, init, body: request });
    const daily = request.variables.start.endsWith("T00:00:00.000Z");
    return new Response(JSON.stringify(daily ? body : recentBody), { status });
  };
  return { fetch, calls };
}

/** A GraphQL answer holding `a`. */
const answer = (a) => ({ data: { viewer: { accounts: [a] } } });
/** The recent hour: a tenth of the day fixture's daily counts. */
const recentAccount = () =>
  account({
    workers: [{ dimensions: { scriptName: "logseq-sync" }, sum: { requests: 100, errors: 0 } }],
    d1: [{ sum: { rowsRead: 10_000, rowsWritten: 50 } }],
  });

const NOON = new Date("2026-11-05T12:00:00Z");

test("periods measure the UTC day and month and the recent hour", () => {
  const p = periods(NOON);
  assert.equal(p.dayStart.toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(p.monthStart.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(p.share.day, 0.5);
  assert.equal(p.share.month, (4 * 24 + 12) / (30 * 24));
  assert.equal(p.dayLeftHours, 12);
  assert.deepEqual([p.recent.start.toISOString(), p.recent.end.toISOString()], ["2026-11-05T10:55:00.000Z", "2026-11-05T11:55:00.000Z"]);
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

const HALF = { share: { day: 0.5, month: 0.5 }, dayLeftHours: 12, threshold: 0.7 };
const QUIET_HOUR = measure(account({ d1: [{ sum: { rowsRead: 10_000, rowsWritten: 0 } }] }));

test("a daily projection continues the last hour's rate, not the day's average", () => {
  const byKey = (usage, recent = {}) =>
    Object.fromEntries(assess({ ...measure(account()), ...usage }, { ...QUIET_HOUR, ...recent }, HALF).map((r) => [r.key, r]));

  const quiet = byKey({});
  assert.ok(Object.values(quiet).every((r) => !r.alert));
  assert.equal(quiet["d1.rowsRead"].projected, 1_000_000 + 12 * 10_000);
  assert.equal(quiet["vectorize.stored"].projected, null);
  assert.equal(quiet["vectorize.queried"].projected, 130_560, "the month's average");

  // A morning of heavy reads that has since stopped: the day's average would project 5.4M.
  assert.equal(byKey({ "d1.rowsRead": 2_700_000 })["d1.rowsRead"].alert, false);
  // A spike in the last hour.
  assert.equal(byKey({}, { "d1.rowsRead": 400_000 })["d1.rowsRead"].alert, true, "on course for 5.8M");
  assert.equal(byKey({ "d1.rowsRead": 3_500_000 })["d1.rowsRead"].alert, true, "70% used");
  assert.equal(byKey({ "d1.rowsRead": 4_880_000 })["d1.rowsRead"].alert, true, "on course for exactly the limit is at 98%, past 70%");
  assert.equal(byKey({ "vectorize.stored": 3_500_000 })["vectorize.stored"].alert, true, "a stored total alerts at the threshold");
});

test("the monthly projection waits for an eighth of the month", () => {
  const usage = { ...measure(account()), "vectorize.queried": 4_000_000 };
  const row = (month) =>
    assess(usage, QUIET_HOUR, { ...HALF, share: { day: 0.5, month } }).find((r) => r.key === "vectorize.queried");
  assert.deepEqual([row(0.1).projected, row(0.1).alert], [null, false]);
  assert.deepEqual([row(0.125).projected, row(0.125).alert], [32_000_000, true]);
});

test("a missing measurement is an error, not zero", () => {
  const usage = measure(account());
  delete usage["d1.rowsRead"];
  assert.throws(() => assess(usage, QUIET_HOUR, HALF), /no usage measured for d1\.rowsRead/);
  assert.throws(() => assess(measure(account()), usage, HALF), /no usage measured for d1\.rowsRead/);
});

test("the report queries today and the recent hour in UTC and lists every allowance and Worker", async () => {
  const { fetch, calls } = fakeFetch(answer(account()), 200, answer(recentAccount()));
  const { report, alert } = await usageReport({ accountId: "acct", token: "tok", now: NOON, threshold: 0.7, fetch });
  assert.equal(alert, false);
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  const day = { account: "acct", day: "2026-11-05", monthStart: "2026-11-01" };
  assert.deepEqual(
    calls.map((c) => c.body.variables),
    [
      { ...day, start: "2026-11-05T00:00:00.000Z", end: "2026-11-05T12:00:00.000Z" },
      { ...day, start: "2026-11-05T10:55:00.000Z", end: "2026-11-05T11:55:00.000Z" },
    ],
  );
  for (const { label } of FREE_LIMITS) assert.match(report, new RegExp(`\\| ${label.replace(/[()]/g, "\\$&")} \\|`));
  assert.match(report, /\| ✅ \| D1 rows read \| 1,000,000 today \| 5,000,000 \| 20% \| 1,120,000 \(22%\) \|/);
  assert.match(report, /- logseq-connector: 3 of 400 requests\n- logseq-sync: 0 of 600 requests/);
  assert.match(report, /All allowances are within bounds\./);
});

test("the report names the allowances that alert", async () => {
  const spike = account({ ...recentAccount(), d1: [{ sum: { rowsRead: 400_000, rowsWritten: 0 } }] });
  const { fetch } = fakeFetch(answer(account()), 200, answer(spike));
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
