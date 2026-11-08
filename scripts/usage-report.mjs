#!/usr/bin/env node
// Usage: usage-report.mjs --settings <settings.json> [--threshold 0.7]
// Env: CLOUDFLARE_API_TOKEN (Account Analytics Read; D1 Read too for the audit log), CLOUDFLARE_ACCOUNT_ID,
// and optionally CONNECTOR_D1_DATABASE_ID (the connector's D1 database).
// Prints the account's usage of each Workers Free plan allowance as a markdown table, and appends
// it to $GITHUB_STEP_SUMMARY when that is set. Daily allowances count from 00:00 UTC, when
// Cloudflare resets them. With CONNECTOR_D1_DATABASE_ID set, an Audit log section follows: one
// aggregate query over the connector's audit_log table and the database's size. Exits 1 when any
// allowance is at or above the threshold, when its recent rate would pass the limit before the
// allowance resets, or when the Audit log section couldn't be read.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The Workers Free plan allowances. All are account-wide; `period` is when Cloudflare resets them. */
export const FREE_LIMITS = [
  { key: "workers.requests", label: "Workers requests", period: "day", limit: 100_000 },
  { key: "do.requests", label: "Durable Object requests", period: "day", limit: 100_000 },
  { key: "do.duration", label: "Durable Object duration (GB-s)", period: "day", limit: 13_000 },
  { key: "do.rowsRead", label: "Durable Object SQLite rows read", period: "day", limit: 5_000_000 },
  { key: "do.rowsWritten", label: "Durable Object SQLite rows written", period: "day", limit: 100_000 },
  { key: "d1.rowsRead", label: "D1 rows read", period: "day", limit: 5_000_000 },
  { key: "d1.rowsWritten", label: "D1 rows written", period: "day", limit: 100_000 },
  { key: "kv.read", label: "KV reads", period: "day", limit: 100_000 },
  { key: "kv.write", label: "KV writes", period: "day", limit: 1_000 },
  { key: "kv.delete", label: "KV deletes", period: "day", limit: 1_000 },
  { key: "kv.list", label: "KV lists", period: "day", limit: 1_000 },
  { key: "ai.neurons", label: "Workers AI neurons", period: "day", limit: 10_000 },
  { key: "vectorize.stored", label: "Vectorize stored dimensions", period: "total", limit: 5_000_000 },
  { key: "vectorize.queried", label: "Vectorize queried dimensions", period: "month", limit: 30_000_000 },
];

/**
 * A daily allowance is projected as today's usage plus the last hour's rate for the rest of the day,
 * so a fix (or a new spike) shows in the next run rather than diluted in the day's average. The hour
 * ends a few minutes ago because the analytics lag behind by a minute or two.
 */
export const RECENT_MS = 3_600_000;
export const ANALYTICS_LAG_MS = 300_000;

/** The monthly allowance is projected from the month's average, which is too noisy before this share. */
export const MIN_PROJECTION_SHARE = 1 / 8;

const API = "https://api.cloudflare.com/client/v4";
const GRAPHQL = `${API}/graphql`;

/** The Free plan's size limit for one D1 database. */
export const D1_DATABASE_LIMIT_BYTES = 500_000_000;

/**
 * The connector database's latest size: the newest daily group from the last few days, since the
 * storage dataset is daily and today's may not be reported yet.
 */
const STORAGE_DAYS = 3;
const STORAGE = `
    d1Storage: d1StorageAdaptiveGroups(limit: 1, orderBy: [date_DESC], filter: {databaseId: $database, date_geq: $storageSince, date_leq: $day}) { max { databaseSizeBytes } dimensions { date } }`;

export const QUERY = `query Usage($account: string!, $start: Time!, $end: Time!, $day: Date!, $monthStart: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end}) {
      sum { requests errors } dimensions { scriptName }
    }
    doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
    doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { duration rowsRead rowsWritten } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: {datetimeMinute_geq: $start, datetimeMinute_lt: $end}) { sum { rowsRead rowsWritten } }
    kv: kvOperationsAdaptiveGroups(limit: 10, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } dimensions { actionType } }
    ai: aiInferenceAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { totalNeurons } }
    vectorStorage: vectorizeV2StorageAdaptiveGroups(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end}) { max { storedVectorDimensions } dimensions { indexName } }
    vectorQueries: vectorizeV2QueriesAdaptiveGroups(limit: 1, filter: {date_geq: $monthStart, date_leq: $day}) { sum { queriedVectorDimensions } }
  } }
}`;

/** QUERY with the connector database's size added, for the daily call when the database is known. */
const STORAGE_QUERY = QUERY.replace("$monthStart: Date!)", "$monthStart: Date!, $database: string!, $storageSince: Date!)").replace(
  "{ sum { queriedVectorDimensions } }\n",
  `{ sum { queriedVectorDimensions } }${STORAGE}\n`,
);

/**
 * The Audit log section's one query (spec 2026-11-07-connector-write-audit-log-design.md §3.7): it
 * reads every row of audit_log once. `?1` is today's start in ms, like `at`. Each sum is null on an
 * empty table. Bytes are counted as stored (UTF-8), not as characters.
 */
export const AUDIT_SQL = `SELECT count(*) AS entries,
  sum(at >= ?1) AS today,
  sum(rows_written) AS rows_written,
  sum(CASE WHEN kind = 'read' THEN rows_read END) AS rows_read,
  sum(length(CAST(before AS BLOB))) AS before_bytes,
  sum(length(CAST(targets AS BLOB))) AS target_bytes
FROM audit_log`;

const DAY_MS = 86_400_000;

/**
 * The current UTC day and month: their starts, the share of each that has passed at `now`, and the
 * recent hour whose rate projects the daily allowances.
 */
export function periods(now) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const recentEnd = new Date(now.getTime() - ANALYTICS_LAG_MS);
  return {
    dayStart,
    monthStart,
    recent: { start: new Date(recentEnd.getTime() - RECENT_MS), end: recentEnd },
    dayLeftHours: (DAY_MS - (now - dayStart)) / RECENT_MS,
    share: {
      day: (now - dayStart) / DAY_MS,
      month: (now - monthStart) / (monthEnd - monthStart),
    },
  };
}

/**
 * Runs QUERY with the time-windowed datasets over [start, end) and the monthly Vectorize queries up
 * to `now`; returns the account's datasets.
 */
export async function fetchUsage({ accountId, token, start, end, now, databaseId, fetch = globalThis.fetch }) {
  const { monthStart } = periods(now);
  const date = (d) => d.toISOString().slice(0, 10);
  const variables = {
    account: accountId,
    start: start.toISOString(),
    end: end.toISOString(),
    day: date(now),
    monthStart: date(monthStart),
  };
  if (databaseId) {
    variables.database = databaseId;
    variables.storageSince = date(new Date(now.getTime() - (STORAGE_DAYS - 1) * DAY_MS));
  }
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: databaseId ? STORAGE_QUERY : QUERY, variables }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cloudflare analytics failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  const body = JSON.parse(text);
  if (body.errors?.length) {
    throw new Error(`Cloudflare analytics failed: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new Error(`Cloudflare analytics returned no data for account ${accountId}`);
  return account;
}

/**
 * Runs AUDIT_SQL on the connector database through the D1 REST query API and returns its totals,
 * with each null sum (an empty table) as 0. A 403 names the D1 Read permission the token lacks.
 */
export async function fetchAuditLog({ accountId, databaseId, token, now, fetch = globalThis.fetch }) {
  const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: AUDIT_SQL, params: [periods(now).dayStart.getTime()] }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Reported below with the raw text.
  }
  const messages = body?.errors?.map((e) => e.message).join("; ");
  if (response.status === 403) {
    throw new Error(`D1 query failed: HTTP 403. The token needs the D1 Read permission (Account → D1 → Read) for database ${databaseId}. ${messages || text.slice(0, 200)}`.trim());
  }
  if (!response.ok || body?.success === false) {
    throw new Error(`D1 query failed: HTTP ${response.status} ${messages || text.slice(0, 500)}`.trim());
  }
  const row = body?.result?.[0]?.results?.[0];
  if (!row) throw new Error(`D1 query failed: no result row from database ${databaseId}`);
  const n = (v) => v ?? 0;
  return {
    entries: n(row.entries),
    today: n(row.today),
    rowsWritten: n(row.rows_written),
    rowsRead: n(row.rows_read),
    bytes: n(row.before_bytes) + n(row.target_bytes),
  };
}

const total = (groups, pick) => groups.reduce((n, g) => n + pick(g), 0);

/** Each allowance's usage from fetchUsage's datasets, keyed like FREE_LIMITS. An empty dataset is no usage. */
export function measure(account) {
  const kv = (action) => total(account.kv.filter((g) => g.dimensions.actionType === action), (g) => g.sum.requests);
  return {
    "workers.requests": total(account.workers, (g) => g.sum.requests),
    "do.requests": total(account.doInvocations, (g) => g.sum.requests),
    "do.duration": total(account.doPeriodic, (g) => g.sum.duration),
    "do.rowsRead": total(account.doPeriodic, (g) => g.sum.rowsRead),
    "do.rowsWritten": total(account.doPeriodic, (g) => g.sum.rowsWritten),
    "d1.rowsRead": total(account.d1, (g) => g.sum.rowsRead),
    "d1.rowsWritten": total(account.d1, (g) => g.sum.rowsWritten),
    "kv.read": kv("read"),
    "kv.write": kv("write"),
    "kv.delete": kv("delete"),
    "kv.list": kv("list"),
    "ai.neurons": total(account.ai, (g) => g.sum.totalNeurons),
    "vectorize.stored": total(account.vectorStorage, (g) => g.max.storedVectorDimensions),
    "vectorize.queried": total(account.vectorQueries, (g) => g.sum.queriedVectorDimensions),
  };
}

/**
 * One row per allowance, with `projected` at the end of its period: a daily allowance's usage plus
 * the `recent` hour's usage for each hour left, the monthly one's average so far (null before
 * MIN_PROJECTION_SHARE of the month), and null for a stored total. A row alerts when its usage
 * reaches `threshold` of the limit or its projection passes the limit.
 */
export function assess(usage, recent, { share, dayLeftHours, threshold }) {
  const measured = (from, key) => {
    if (typeof from[key] !== "number") throw new Error(`no usage measured for ${key}`);
    return from[key];
  };
  return FREE_LIMITS.map(({ key, label, period, limit }) => {
    const used = measured(usage, key);
    let projected = null;
    if (period === "day") projected = used + measured(recent, key) * dayLeftHours;
    if (period === "month" && share.month >= MIN_PROJECTION_SHARE) projected = used / share.month;
    const alert = used >= threshold * limit || (projected !== null && projected > limit);
    return { key, label, period, limit, used, projected, alert };
  });
}

const number = (n) => Math.round(n).toLocaleString("en-US");
const percent = (n, limit) => `${Math.round((100 * n) / limit)}%`;
const PERIOD = { day: "today", month: "this month", total: "stored" };

const megabytes = (n) => `${(n / 1_000_000).toFixed(1)} MB`;

/**
 * The Audit log section: `{skipped}` names why it wasn't read, `{error}` why it failed, otherwise the
 * totals and the database size (`storage`, the newest d1StorageAdaptiveGroups group, or undefined).
 */
export function formatAuditSection(audit) {
  const lines = ["### Audit log", ""];
  if (audit.skipped) return [...lines, `Skipped: ${audit.skipped}.`].join("\n") + "\n";
  if (audit.error) return [...lines, `Failed: ${audit.error}`].join("\n") + "\n";
  const { totals, storage } = audit;
  lines.push(
    storage
      ? `Connector database: ${megabytes(storage.max.databaseSizeBytes)} of ${megabytes(D1_DATABASE_LIMIT_BYTES).replace(".0", "")} (${percent(storage.max.databaseSizeBytes, D1_DATABASE_LIMIT_BYTES)}), as of ${storage.dimensions.date}.`
      : "Connector database: size not reported yet.",
    "",
    "Over the entries kept (the hourly purge removes them after `connector.auditRetentionDays`):",
    "",
    "| | |",
    "|---|---|",
    `| Entries kept | ${number(totals.entries)} |`,
    `| Entries today | ${number(totals.today)} |`,
    `| D1 rows written by the log | ${number(totals.rowsWritten)} |`,
    `| D1 rows read by get_activity_log | ${number(totals.rowsRead)} |`,
    `| Snapshot and target bytes | ${number(totals.bytes)} |`,
  );
  return lines.join("\n") + "\n";
}

/** The rows as a markdown report, with each Worker's errors today below the table. */
export function formatReport({ rows, now, threshold, workers }) {
  const lines = [
    `## Cloudflare usage at ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Workers Free plan allowances. Alerts at ${Math.round(threshold * 100)}% of a limit, or when the projection passes it. Daily projections continue the last hour's rate to 00:00 UTC.`,
    "",
    "| | Allowance | Used | Limit | Share | Projected |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const projected = r.projected === null ? "" : `${number(r.projected)} (${percent(r.projected, r.limit)})`;
    lines.push(
      `| ${r.alert ? "⚠️" : "✅"} | ${r.label} | ${number(r.used)} ${PERIOD[r.period]} | ${number(r.limit)} | ${percent(r.used, r.limit)} | ${projected} |`,
    );
  }
  lines.push("", "Worker errors today:");
  for (const w of [...workers].sort((a, b) => a.dimensions.scriptName.localeCompare(b.dimensions.scriptName))) {
    lines.push(`- ${w.dimensions.scriptName}: ${number(w.sum.errors)} of ${number(w.sum.requests)} requests`);
  }
  const alerts = rows.filter((r) => r.alert);
  lines.push("", alerts.length ? `**${alerts.length} allowance(s) need attention:** ${alerts.map((r) => r.label).join(", ")}.` : "All allowances are within bounds.");
  return lines.join("\n") + "\n";
}

/**
 * Fetches, assesses and formats; returns the report and whether it alerts: an allowance alerts, or
 * the Audit log section failed. Without `databaseId` the section is skipped and nothing is queried
 * for it.
 */
export async function usageReport({ accountId, token, databaseId, now, threshold, fetch }) {
  const p = periods(now);
  const auditTotals = databaseId
    ? fetchAuditLog({ accountId, databaseId, token, now, fetch }).then(
        (totals) => ({ totals }),
        (error) => ({ error: error.message }),
      )
    : Promise.resolve({ skipped: "CONNECTOR_D1_DATABASE_ID not set" });
  const [account, recent, audit] = await Promise.all([
    fetchUsage({ accountId, token, start: p.dayStart, end: now, now, databaseId, fetch }),
    fetchUsage({ accountId, token, start: p.recent.start, end: p.recent.end, now, fetch }),
    auditTotals,
  ]);
  if (audit.totals) audit.storage = account.d1Storage?.[0];
  const rows = assess(measure(account), measure(recent), { share: p.share, dayLeftHours: p.dayLeftHours, threshold });
  const report = `${formatReport({ rows, now, threshold, workers: account.workers })}\n${formatAuditSection(audit)}`;
  return { report, alert: rows.some((r) => r.alert) || Boolean(audit.error) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { settings: { type: "string" }, threshold: { type: "string", default: "0.7" } } });
  if (!values.settings) {
    console.error("usage: usage-report.mjs --settings <settings.json> [--threshold 0.7]");
    process.exit(2);
  }
  const threshold = Number(values.threshold);
  if (!(threshold > 0 && threshold <= 1)) {
    console.error(`--threshold must be a number in (0, 1], got ${values.threshold}`);
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(values.settings, "utf8")).plan;
  if (plan !== "free") {
    console.error(`usage-report knows only the Workers Free plan allowances, and settings.plan is ${plan}. On Workers Paid, watch Billing → Billable usage instead.`);
    process.exit(1);
  }
  const {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CONNECTOR_D1_DATABASE_ID: databaseId,
    GITHUB_STEP_SUMMARY: summary,
  } = process.env;
  if (!token || !accountId) {
    console.error("usage-report: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(1);
  }
  const { report, alert } = await usageReport({ accountId, token, databaseId, now: new Date(), threshold });
  process.stdout.write(report);
  if (summary) appendFileSync(summary, report);
  process.exit(alert ? 1 : 0);
}
