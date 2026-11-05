#!/usr/bin/env node
// Usage: usage-report.mjs --settings <settings.json> [--threshold 0.7]
// Env: CLOUDFLARE_API_TOKEN (Account Analytics Read is enough), CLOUDFLARE_ACCOUNT_ID.
// Prints the account's usage of each Workers Free plan allowance as a markdown table, and appends
// it to $GITHUB_STEP_SUMMARY when that is set. Daily allowances count from 00:00 UTC, when
// Cloudflare resets them. Exits 1 when any allowance is at or above the threshold, or when today's
// rate so far would pass the limit before the day (or month) ends.
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

/** A projection from less than this share of the period is too noisy to alert on. */
export const MIN_PROJECTION_SHARE = 1 / 8;

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

export const QUERY = `query Usage($account: string!, $start: Time!, $end: Time!, $day: Date!, $monthStart: Date!) {
  viewer { accounts(filter: {accountTag: $account}) {
    workers: workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end}) {
      sum { requests errors } dimensions { scriptName }
    }
    doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
    doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { duration rowsRead rowsWritten } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date: $day}) { sum { rowsRead rowsWritten } }
    kv: kvOperationsAdaptiveGroups(limit: 10, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } dimensions { actionType } }
    ai: aiInferenceAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { totalNeurons } }
    vectorStorage: vectorizeV2StorageAdaptiveGroups(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end}) { max { storedVectorDimensions } dimensions { indexName } }
    vectorQueries: vectorizeV2QueriesAdaptiveGroups(limit: 1, filter: {date_geq: $monthStart, date_leq: $day}) { sum { queriedVectorDimensions } }
  } }
}`;

const DAY_MS = 86_400_000;

/** The current UTC day and month: their starts and the share of each that has passed at `now`. */
export function periods(now) {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    dayStart,
    monthStart,
    share: {
      day: (now - dayStart) / DAY_MS,
      month: (now - monthStart) / (monthEnd - monthStart),
    },
  };
}

/** Runs QUERY for the UTC day up to `now`; returns the account's datasets. */
export async function fetchUsage({ accountId, token, now, fetch = globalThis.fetch }) {
  const { dayStart, monthStart } = periods(now);
  const date = (d) => d.toISOString().slice(0, 10);
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        account: accountId,
        start: dayStart.toISOString(),
        end: now.toISOString(),
        day: date(now),
        monthStart: date(monthStart),
      },
    }),
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
 * One row per allowance. `projected` extends the rate so far to the end of the period; it is null
 * for stored totals, and too early to trust before MIN_PROJECTION_SHARE of the period has passed.
 * A row alerts when its usage reaches `threshold` of the limit or its trusted projection passes it.
 */
export function assess(usage, { share, threshold }) {
  return FREE_LIMITS.map(({ key, label, period, limit }) => {
    const used = usage[key];
    if (typeof used !== "number") throw new Error(`no usage measured for ${key}`);
    const projected = period === "total" ? null : used / share[period];
    const trusted = projected !== null && share[period] >= MIN_PROJECTION_SHARE;
    const alert = used >= threshold * limit || (trusted && projected > limit);
    return { key, label, period, limit, used, projected: trusted ? projected : null, alert };
  });
}

const number = (n) => Math.round(n).toLocaleString("en-US");
const percent = (n, limit) => `${Math.round((100 * n) / limit)}%`;
const PERIOD = { day: "today", month: "this month", total: "stored" };

/** The rows as a markdown report, with each Worker's errors today below the table. */
export function formatReport({ rows, now, threshold, workers }) {
  const lines = [
    `## Cloudflare usage at ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Workers Free plan allowances. Alerts at ${Math.round(threshold * 100)}% of a limit, or when the rate so far passes the limit before it resets.`,
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

/** Fetches, assesses and formats; returns the report and whether any allowance alerts. */
export async function usageReport({ accountId, token, now, threshold, fetch }) {
  const account = await fetchUsage({ accountId, token, now, fetch });
  const rows = assess(measure(account), { share: periods(now).share, threshold });
  return { report: formatReport({ rows, now, threshold, workers: account.workers }), alert: rows.some((r) => r.alert) };
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
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, GITHUB_STEP_SUMMARY: summary } = process.env;
  if (!token || !accountId) {
    console.error("usage-report: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(1);
  }
  const { report, alert } = await usageReport({ accountId, token, now: new Date(), threshold });
  process.stdout.write(report);
  if (summary) appendFileSync(summary, report);
  process.exit(alert ? 1 : 0);
}
