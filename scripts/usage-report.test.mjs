import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_LIMITS, assess, fetchAuditLog, measure, periods, usageReport } from "./usage-report.mjs";

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

// --- The Audit log section (spec 2026-11-07-connector-write-audit-log-design.md §3.7) ---

const DB_ID = "11111111-2222-3333-4444-555555555555";
const D1_QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/acct/d1/database/${DB_ID}/query`;
const migration = readFileSync(join(root, "connector", "migrations", "0004_audit_log.sql"), "utf8");

/** A real SQLite database with migration 0004 applied and `rows` inserted, the way D1 would hold them. */
async function auditDb(rows) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const insert = db.prepare(
    `INSERT INTO audit_log (at, graph_id, alias, tool, kind, status, before, targets, rows_written, rows_read)
     VALUES (?, 'g1', 'work', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(r.at, r.tool, r.kind, r.status, r.before ?? null, r.targets ?? null, r.rowsWritten ?? null, r.rowsRead ?? null);
  return db;
}

/**
 * A fetch that answers GraphQL with `day` (the daily call) or `recent` (the recent hour), and the D1
 * query API by running the posted SQL on `db`, in the D1 REST API's envelope. `d1Status` replaces the
 * D1 answer with an error status.
 */
function routedFetch({ day, recent = answer(recentAccount()), db, d1Status }) {
  const calls = { graphql: [], d1: [] };
  const fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      calls.graphql.push({ url, init, body: request });
      const daily = request.variables.start.endsWith("T00:00:00.000Z");
      return new Response(JSON.stringify(daily ? day : recent), { status: 200 });
    }
    calls.d1.push({ url, init, body: request });
    if (d1Status) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }), { status: d1Status });
    }
    const results = db.prepare(request.sql).all(...(request.params ?? []));
    return new Response(
      JSON.stringify({ success: true, errors: [], messages: [], result: [{ success: true, results, meta: { rows_read: 1, rows_written: 0 } }] }),
      { status: 200 },
    );
  };
  return { fetch, calls };
}

const TODAY = NOON.getTime();
const YESTERDAY = NOON.getTime() - 86_400_000;
const DAY_START = Date.parse("2026-11-05T00:00:00Z");
/** Three writes (one at exactly 00:00 UTC today, one yesterday) and two get_activity_log reads. */
const AUDIT_ROWS = [
  { at: YESTERDAY, tool: "delete_blocks", kind: "write", status: "ok", before: "é".repeat(500), targets: "[]", rowsWritten: 3, rowsRead: 1 },
  { at: DAY_START, tool: "update_block", kind: "write", status: "ok", before: "x".repeat(1_000), targets: "y".repeat(98), rowsWritten: 3, rowsRead: 1 },
  { at: TODAY, tool: "create_page", kind: "write", status: "refused", rowsWritten: 3, rowsRead: 1 },
  { at: TODAY, tool: "get_activity_log", kind: "read", status: "ok", rowsWritten: 2, rowsRead: 40 },
  { at: YESTERDAY, tool: "get_activity_log", kind: "read", status: "ok", rowsWritten: 2, rowsRead: 460 },
];
const withStorage = (bytes) => account({ d1Storage: bytes === undefined ? [] : [{ max: { databaseSizeBytes: bytes }, dimensions: { date: "2026-11-05" } }] });
/** usageReport's arguments; pass `databaseId` explicitly (undefined included) to replace DB_ID. */
const auditArgs = (fetch, ...id) => ({ accountId: "acct", token: "tok", databaseId: id.length ? id[0] : DB_ID, now: NOON, threshold: 0.7, fetch });
/** The report's Audit log section, from its heading to the end. */
const auditSection = (report) => report.slice(report.indexOf("### Audit log"));

test("audit section renders from a faked D1 query response", async () => {
  const { fetch, calls } = routedFetch({ day: answer(withStorage(2_000_000)), db: await auditDb(AUDIT_ROWS) });
  const { report, alert } = await usageReport(auditArgs(fetch));
  assert.equal(alert, false);
  assert.equal(calls.d1.length, 1, "one aggregate query a run");
  assert.equal(calls.d1[0].url, D1_QUERY_URL);
  assert.equal(calls.d1[0].init.method, "POST");
  assert.equal(calls.d1[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(calls.d1[0].body.params, [DAY_START], "today starts at 00:00 UTC, in ms like audit_log.at");
  const section = auditSection(report);
  assert.match(section, /\| Entries kept \| 5 \|/);
  assert.match(section, /\| Entries today \| 3 \|/, "an entry at exactly 00:00 UTC is today's");
  assert.match(section, /\| D1 rows written by the log \| 13 \|/);
  assert.match(section, /\| D1 rows read by get_activity_log \| 500 \|/, "only kind = 'read' rows count");
  // 500 two-byte characters + 1,000 + 2 + 98: bytes, not characters.
  assert.match(section, /\| Snapshot and target bytes \| 2,100 \|/);
});

test("empty table: null sums print as zeros", async () => {
  const { fetch } = routedFetch({ day: answer(withStorage(16_384)), db: await auditDb([]) });
  const { report, alert } = await usageReport(auditArgs(fetch));
  assert.equal(alert, false);
  const section = auditSection(report);
  for (const label of ["Entries kept", "Entries today", "D1 rows written by the log", "D1 rows read by get_activity_log", "Snapshot and target bytes"]) {
    assert.match(section, new RegExp(`\\| ${label} \\| 0 \\|`));
  }
  assert.doesNotMatch(section, /null|NaN|undefined/);
});

test("empty table: the totals are numbers, not nulls", async () => {
  const { fetch } = routedFetch({ db: await auditDb([]) });
  const totals = await fetchAuditLog({ accountId: "acct", databaseId: DB_ID, token: "tok", now: NOON, fetch });
  assert.deepEqual(totals, { entries: 0, today: 0, rowsWritten: 0, rowsRead: 0, bytes: 0 });
});

test("a D1 answer that isn't a result row fails the section, naming why", async () => {
  const answering = (d1Body) => async (url, init) => {
    if (url.endsWith("/graphql")) {
      const daily = JSON.parse(init.body).variables.start.endsWith("T00:00:00.000Z");
      return new Response(JSON.stringify(daily ? answer(withStorage(1)) : answer(recentAccount())));
    }
    return new Response(JSON.stringify(d1Body));
  };
  const cases = [
    [{ success: true, errors: [], result: [] }, /Failed: D1 query failed: no result row from database 11111111-/],
    [{ success: true, errors: [], result: [{ success: true, results: [] }] }, /Failed: D1 query failed: no result row from database 11111111-/],
    [{ success: false, errors: [{ code: 7500, message: "no such table: audit_log" }], result: null }, /Failed: D1 query failed: HTTP 200 no such table: audit_log/],
  ];
  for (const [body, message] of cases) {
    const { report, alert } = await usageReport(auditArgs(answering(body)));
    assert.equal(alert, true);
    assert.match(auditSection(report), message);
  }
});

test("database size from a faked GraphQL response shown against 500 MB", async () => {
  const { fetch, calls } = routedFetch({ day: answer(withStorage(123_456_789)), db: await auditDb(AUDIT_ROWS) });
  const { report } = await usageReport(auditArgs(fetch));
  const [daily, recent] = calls.graphql;
  assert.match(daily.body.query, /d1StorageAdaptiveGroups\(.*databaseId: \$database/);
  assert.equal(daily.body.variables.database, DB_ID);
  assert.doesNotMatch(recent.body.query, /d1StorageAdaptiveGroups/, "the recent hour doesn't need the size");
  assert.match(auditSection(report), /Connector database: 123\.5 MB of 500 MB \(25%\), as of 2026-11-05\./);

  const none = routedFetch({ day: answer(withStorage()), db: await auditDb(AUDIT_ROWS) });
  assert.match(auditSection((await usageReport(auditArgs(none.fetch))).report), /Connector database: size not reported yet\./);
});

test("no database id: section skipped with the reason, rest of report unchanged", async () => {
  const configured = routedFetch({ day: answer(withStorage(2_000_000)), db: await auditDb(AUDIT_ROWS) });
  const withId = await usageReport(auditArgs(configured.fetch));
  for (const databaseId of [undefined, ""]) {
    const bare = routedFetch({ day: answer(account()) });
    const { report, alert } = await usageReport(auditArgs(bare.fetch, databaseId));
    assert.equal(alert, false);
    assert.equal(bare.calls.d1.length, 0, "no D1 query");
    assert.ok(bare.calls.graphql.every((c) => !/d1StorageAdaptiveGroups/.test(c.body.query) && !("database" in c.body.variables)));
    assert.equal(auditSection(report), "### Audit log\n\nSkipped: CONNECTOR_D1_DATABASE_ID not set.\n");
    assert.equal(report.slice(0, report.indexOf("### Audit log")), withId.report.slice(0, withId.report.indexOf("### Audit log")));
  }
  // An alert from the allowances still alerts without the section.
  const spike = account({ ...recentAccount(), d1: [{ sum: { rowsRead: 400_000, rowsWritten: 0 } }] });
  const alerting = routedFetch({ day: answer(account()), recent: answer(spike) });
  assert.equal((await usageReport(auditArgs(alerting.fetch, undefined))).alert, true);
});

test("403 from the D1 query API names the D1 Read permission", async () => {
  const { fetch } = routedFetch({ day: answer(withStorage(2_000_000)), d1Status: 403 });
  const { report, alert } = await usageReport(auditArgs(fetch));
  assert.equal(alert, true, "a section that couldn't be read fails the run, so it isn't missed");
  assert.match(report, /\| ✅ \| D1 rows read \|/, "the allowances still render");
  assert.match(auditSection(report), /Failed: D1 query failed: HTTP 403\. The token needs the D1 Read permission \(Account → D1 → Read\)/);

  const other = routedFetch({ day: answer(withStorage(2_000_000)), d1Status: 500 });
  const failed = await usageReport(auditArgs(other.fetch));
  assert.equal(failed.alert, true);
  assert.match(auditSection(failed.report), /Failed: D1 query failed: HTTP 500 Authentication error/);
  assert.doesNotMatch(auditSection(failed.report), /D1 Read/);
});

test("usage workflow passes CONNECTOR_D1_DATABASE_ID", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "usage.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Report usage"));
  assert.match(step, /CONNECTOR_D1_DATABASE_ID: \$\{\{ vars\.CONNECTOR_D1_DATABASE_ID \}\}/);
});
