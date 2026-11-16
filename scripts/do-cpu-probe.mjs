#!/usr/bin/env node
// Usage: do-cpu-probe.mjs <command> [options]
//   validate  --durations <ms,ms,...> --websocket <true|false>
//   calibrate --out <calibration.json>
//   preflight
//   deploy-log <log file> --status <wrangler exit code> --name <worker name> --url-out <file>
//   run       --url-file <file> --calibration <file> --durations <ms,...> --websocket <true|false>
//             --name <worker name> --out <results.json> [--analytics-wait <s>]
//   teardown  --name <worker name>
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (preflight, run, teardown), PROBE_KEY (run),
// GITHUB_STEP_SUMMARY (optional).
//
// The driver for .github/workflows/do-cpu-probe.yml, which measures the Free plan's Durable Object
// CPU limit and what a CPU-limit kill does (README "Measuring the Durable Object CPU limit"). It
// calibrates the probe's busy loop in Node, then asks the deployed probe DO for a fixed amount of
// work per target duration, records what the caller sees (HTTP status, latency, body or error,
// whether the DO's memory survived, whether a WebSocket client was dropped), and reads the DO's
// actual CPU per invocation from the GraphQL Analytics API. It prints no request headers, and
// scrubs the probe's workers.dev host and key from everything it prints or saves.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { burn } from "./do-cpu-probe/burn.mjs";

const API = "https://api.cloudflare.com/client/v4";
const GRAPHQL = `${API}/graphql`;

/** Input limits: the probe stays small (dozens of requests) and each run well below the job's timeout. */
export const MAX_DURATION_MS = 120_000;
export const MAX_POINTS = 20;

/** Pauses around each burn, so the mark and state requests land in other seconds than the burn in analytics. */
export const GAP_MS = 3_000;
/** How long one burn request may take before the client gives up (well past the 120 s maximum). */
export const BURN_TIMEOUT_MS = 180_000;
/** The probe's workers.dev route can take a little while to answer after the first deploy. */
export const HEALTH_ATTEMPTS = 30;
export const HEALTH_INTERVAL_MS = 2_000;
/** Analytics lag by a minute or so: the first read waits this long, then polls every ANALYTICS_POLL_MS. */
export const ANALYTICS_FIRST_WAIT_MS = 30_000;
export const ANALYTICS_POLL_MS = 20_000;
export const ANALYTICS_WAIT_S = 240;

/** What each Cloudflare permission is for, named in failure messages (README 1.1 has the full token). */
export const PERMISSIONS = {
  scripts: "Account → Workers Scripts Edit (included in Workers Admin, which the deploy token has per README 1.1)",
  analytics: "Account → Account Analytics Read",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Inputs

/**
 * Parses the comma-separated target durations in ms. Each must be a whole number from 1 to
 * MAX_DURATION_MS, and there may be 1 to MAX_POINTS of them. Throws naming the entry and reason.
 */
export function parseDurations(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("durations: give at least one duration in ms, e.g. 5,50,200");
  const entries = raw.split(",").map((s) => s.trim());
  if (entries.length > MAX_POINTS) {
    throw new Error(`durations: ${entries.length} points given, at most ${MAX_POINTS} allowed`);
  }
  return entries.map((entry, i) => {
    if (!/^\d+$/.test(entry)) throw new Error(`durations: entry ${i} (${JSON.stringify(entry)}): not a whole number of milliseconds`);
    const ms = Number(entry);
    if (ms < 1) throw new Error(`durations: entry ${i} (${entry}): must be at least 1 ms`);
    if (ms > MAX_DURATION_MS) throw new Error(`durations: entry ${i} (${entry}): above the ${MAX_DURATION_MS} ms maximum`);
    return ms;
  });
}

/** Parses a workflow boolean input, which arrives as the string "true" or "false". */
export function parseBoolean(name, text) {
  if (text === "true" || text === true) return true;
  if (text === "false" || text === false) return false;
  throw new Error(`${name}: must be true or false, got ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------------------------
// Calibration

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The iteration count that should take `ms` of CPU at `rate` iterations per ms (at least 1). */
export function iterationsFor(ms, rate) {
  if (!(rate > 0)) throw new Error(`calibration: iterations per ms must be positive, got ${rate}`);
  return Math.max(1, Math.round(ms * rate));
}

/** Process CPU time in ms (user + system). The loop is single-threaded, so this is its CPU. */
export function processCpuMs() {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/**
 * Measures the burn loop's iterations per ms of CPU in this process: warm the JIT, grow a probe
 * size until one call takes at least 50 ms, then time `samples` calls of about `sampleMs` each and
 * take the median rate.
 */
export function calibrate({ burnFn = burn, cpuNow = processCpuMs, samples = 5, sampleMs = 200 } = {}) {
  burnFn(5_000_000);
  let n = 1_000_000;
  let took;
  for (;;) {
    const t = cpuNow();
    burnFn(n);
    took = cpuNow() - t;
    if (took >= 50 || n >= 1e10) break;
    n *= 2;
  }
  const sampleIterations = Math.max(1, Math.round((n * sampleMs) / Math.max(took, 1e-3)));
  const rates = [];
  for (let i = 0; i < samples; i++) {
    const t = cpuNow();
    burnFn(sampleIterations);
    rates.push(sampleIterations / Math.max(cpuNow() - t, 1e-3));
  }
  return { iterationsPerMs: median(rates), samples: rates, sampleIterations };
}

/**
 * The loop's rate on Cloudflare, from runs that completed with an analytics CPU figure of at least
 * `minCpuMs` (shorter runs are dominated by request overhead): the median of iterations / CPU ms.
 */
export function workerdRate(runs, minCpuMs = 20) {
  const rates = runs
    .filter((r) => r.outcome === "completed" && r.analytics?.cpuMs >= minCpuMs)
    .map((r) => r.iterations / r.analytics.cpuMs);
  return median(rates);
}

/**
 * Brackets the CPU limit from the runs: the most CPU a completed run used, and the least CPU (or,
 * without analytics, the smallest target) at which a run failed.
 */
export function bracketLimit(runs) {
  const cpu = (r) => r.analytics?.cpuMs ?? null;
  const done = runs.filter((r) => r.outcome === "completed");
  const failed = runs.filter((r) => r.outcome !== "completed");
  const maxDone = done.length ? Math.max(...done.map((r) => cpu(r) ?? r.targetMs)) : null;
  const minFailed = failed.length ? Math.min(...failed.map((r) => cpu(r) ?? r.targetMs)) : null;
  return { maxCompletedMs: maxDone, minFailedMs: minFailed };
}

// ---------------------------------------------------------------------------------------------
// Text handling

/** Replaces each secret (the probe's key, host, subdomain) in `text`, longest first. */
export function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const [value, label] of [...secrets].filter(([v]) => v).sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(value).join(label);
  }
  return out;
}

/** A Markdown table cell: one line, pipes escaped, at most `max` characters. */
export function cell(text, max = 160) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/\|/g, "\\|") || "–";
}

/** The probe's host and the account's workers.dev subdomain from wrangler deploy's output. */
export function parseDeployUrl(log, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(log).match(new RegExp(`https://(${escaped})\\.([a-z0-9-]+)\\.workers\\.dev`, "i"));
  if (!m) return null;
  return { url: `https://${m[1]}.${m[2]}.workers.dev`, host: `${m[1]}.${m[2]}.workers.dev`, subdomain: m[2] };
}

/**
 * Explains a Cloudflare failure (wrangler output or an API error body) in terms of what to fix:
 * the missing permission, the missing workers.dev subdomain, or the plan. Null when unrecognised.
 */
export function explainCloudflareError(text) {
  const s = String(text ?? "");
  if (/\b10063\b|need a workers\.dev subdomain|workers\.dev subdomain.*not found|\b10007\b.*subdomain/i.test(s)) {
    return "The account has no workers.dev subdomain. Open Workers & Pages in the dashboard once to create it (README 1.3).";
  }
  if (/\b10000\b|Authentication error|\bHTTP 403\b|\b403 Forbidden\b|not authorized|permission/i.test(s)) {
    return `The token was refused. Deploying and deleting the probe needs ${PERMISSIONS.scripts}; the CPU figures need ${PERMISSIONS.analytics}.`;
  }
  if (/new_sqlite_classes|SQLite|\b10097\b|\b10074\b/i.test(s)) {
    return "Cloudflare refused the Durable Object migration. The probe uses new_sqlite_classes, which the Free plan needs; check the message above.";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Cloudflare REST and GraphQL

async function cfJson(fetch, url, { token, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Reported with the raw text.
  }
  const messages = json?.errors?.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("; ");
  return { status: response.status, ok: response.ok && json?.success !== false, json, text, messages };
}

/** The account's workers.dev subdomain. Throws naming the permission or setup step that is missing. */
export async function fetchSubdomain({ accountId, token, fetch = globalThis.fetch }) {
  const r = await cfJson(fetch, `${API}/accounts/${accountId}/workers/subdomain`, { token });
  if (r.ok && r.json?.result?.subdomain) return r.json.result.subdomain;
  const detail = `HTTP ${r.status} ${r.messages || r.text.slice(0, 200)}`.trim();
  if (r.status === 404 || /10007/.test(detail)) {
    throw new Error(`workers.dev subdomain lookup failed: ${detail}. The account has no workers.dev subdomain: open Workers & Pages in the dashboard once (README 1.3).`);
  }
  if (r.status === 401 || r.status === 403 || /\b10000\b/.test(detail)) {
    throw new Error(`workers.dev subdomain lookup failed: ${detail}. The token needs ${PERMISSIONS.scripts} to deploy, read and delete the probe.`);
  }
  throw new Error(`workers.dev subdomain lookup failed: ${detail}`);
}

/** The probe's Durable Object namespace id (for the periodic CPU query), or null when not listed. */
export async function findNamespace({ accountId, token, name, fetch = globalThis.fetch }) {
  for (let page = 1; page <= 10; page++) {
    const r = await cfJson(fetch, `${API}/accounts/${accountId}/workers/durable_objects/namespaces?per_page=100&page=${page}`, { token });
    if (!r.ok) throw new Error(`Durable Object namespace lookup failed: HTTP ${r.status} ${r.messages || r.text.slice(0, 200)}`);
    const found = (r.json?.result ?? []).find((ns) => ns.script === name);
    if (found) return found.id;
    if (page >= (r.json?.result_info?.total_pages ?? 1)) return null;
  }
  return null;
}

/**
 * Deletes the probe Worker through the API (with its Durable Object namespace: force=true). It
 * runs after `wrangler delete`, so "already gone" is the usual answer. Throws naming the permission
 * when refused.
 */
export async function deleteScript({ accountId, token, name, fetch = globalThis.fetch }) {
  const r = await cfJson(fetch, `${API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}?force=true`, { token, method: "DELETE" });
  if (r.ok) return "deleted by the API (wrangler delete had not removed it)";
  const detail = `HTTP ${r.status} ${r.messages || r.text.slice(0, 200)}`.trim();
  if (r.status === 404 || /\b10007\b/.test(detail)) return "already gone";
  if (r.status === 401 || r.status === 403 || /\b10000\b/.test(detail)) {
    throw new Error(`deleting ${name} failed: ${detail}. The token needs ${PERMISSIONS.scripts}. Delete it by hand: Workers & Pages → ${name} → Settings → Delete.`);
  }
  throw new Error(`deleting ${name} failed: ${detail}. Delete it by hand: Workers & Pages → ${name} → Settings → Delete.`);
}

/** Thrown when the analytics API refuses the token, so the fallbacks stop. */
export class AnalyticsPermissionError extends Error {}

/** Runs one GraphQL query. Returns { data, errors }; throws AnalyticsPermissionError when refused. */
export async function graphql({ token, query, variables, fetch = globalThis.fetch }) {
  const r = await cfJson(fetch, GRAPHQL, { token, method: "POST", body: { query, variables } });
  const errors = (r.json?.errors ?? []).map((e) => e.message);
  const refused = r.status === 401 || r.status === 403 || errors.some((m) => /not authori[sz]ed|authentication|permission|access denied/i.test(m));
  if (refused) {
    throw new AnalyticsPermissionError(
      `analytics refused: HTTP ${r.status} ${errors.join("; ") || r.text.slice(0, 200)}. The token needs ${PERMISSIONS.analytics}.`,
    );
  }
  if (!r.json) throw new Error(`analytics failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return { data: r.json.data ?? null, errors };
}

/**
 * Field selections for the per-run invocation query, tried in order: Cloudflare's docs do not say
 * which CPU field durableObjectsInvocationsAdaptiveGroups has, so the probe asks for `sum.cpuTime`,
 * then the CPU quantiles, then no CPU field (wall time only), and records which one answered.
 */
export const INVOCATION_SELECTIONS = [
  { name: "sum.cpuTime", select: "sum { requests errors wallTime cpuTime } dimensions { status }" },
  { name: "quantiles.cpuTimeP99", select: "sum { requests errors wallTime } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { status }" },
  { name: "none (wall time only)", select: "sum { requests errors wallTime } dimensions { status }" },
];

/** The same for the whole probe's periodic DO totals (durableObjectsPeriodicGroups). */
export const PERIODIC_SELECTIONS = [
  { name: "cpuTime, exceeded errors", select: "sum { cpuTime activeTime exceededCpuErrors exceededMemoryErrors }" },
  { name: "cpuTime", select: "sum { cpuTime activeTime }" },
];

/** An ISO time at whole seconds: rounded down, or up with `ceil`. */
export function isoSecond(ms, { ceil = false } = {}) {
  const s = ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  return new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The analytics window of one burn: from the second it started to a second after it ended. The
 * mark and state requests sit GAP_MS outside it, so only the burn (and any WebSocket close it
 * caused) falls inside.
 */
export function runWindow(run) {
  return { start: isoSecond(run.startedAt), end: isoSecond(run.endedAt + 1000, { ceil: true }) };
}

/** The per-run invocation query: one aliased group set per run, filtered to the probe script. */
export function invocationsQuery({ accountId, script, runs, selection }) {
  const params = ["$account: string!", "$script: string!"];
  const variables = { account: accountId, script };
  const fields = runs.map((run, i) => {
    const w = runWindow(run);
    params.push(`$s${i}: Time!`, `$e${i}: Time!`);
    variables[`s${i}`] = w.start;
    variables[`e${i}`] = w.end;
    return `    r${i}: durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: {scriptName: $script, datetime_geq: $s${i}, datetime_leq: $e${i}}) { ${selection.select} }`;
  });
  const query = `query Probe(${params.join(", ")}) {\n  viewer { accounts(filter: {accountTag: $account}) {\n${fields.join("\n")}\n  } }\n}`;
  return { query, variables };
}

/** The periodic totals query over the whole probe, filtered to the probe's namespace. */
export function periodicQuery({ accountId, namespaceId, start, end, selection }) {
  return {
    query: `query ProbePeriodic($account: string!, $ns: string!, $start: Time!, $end: Time!) {\n  viewer { accounts(filter: {accountTag: $account}) {\n    periodic: durableObjectsPeriodicGroups(limit: 1, filter: {namespaceId: $ns, datetime_geq: $start, datetime_leq: $end}) { ${selection.select} }\n  } }\n}`,
    variables: { account: accountId, ns: namespaceId, start: isoSecond(start), end: isoSecond(end, { ceil: true }) },
  };
}

/**
 * One run's figures from its invocation groups. Times are in microseconds in the API and in ms here.
 * CPU comes from sum.cpuTime, or else the p99 quantile (exact when the window holds one invocation).
 */
export function summariseGroups(groups) {
  if (!groups?.length) return null;
  let requests = 0;
  let errors = 0;
  let wallUs = 0;
  let cpuUs = null;
  let cpuSource = null;
  const statuses = {};
  for (const g of groups) {
    const n = g.sum?.requests ?? 0;
    requests += n;
    errors += g.sum?.errors ?? 0;
    wallUs += g.sum?.wallTime ?? 0;
    const status = g.dimensions?.status ?? "unknown";
    statuses[status] = (statuses[status] ?? 0) + n;
    if (g.sum?.cpuTime != null) {
      cpuUs = (cpuUs ?? 0) + g.sum.cpuTime;
      cpuSource = "sum.cpuTime";
    } else if (g.quantiles?.cpuTimeP99 != null) {
      cpuUs = Math.max(cpuUs ?? 0, g.quantiles.cpuTimeP99);
      cpuSource = "quantiles.cpuTimeP99";
    }
  }
  return {
    requests,
    errors,
    statuses,
    wallMs: wallUs / 1000,
    cpuMs: cpuUs == null ? null : cpuUs / 1000,
    cpuSource,
  };
}

/** Tries each selection in turn until one has no GraphQL errors. Returns { selection, data, tried }. */
export async function queryWithFallback({ token, selections, build, fetch }) {
  const tried = [];
  for (const selection of selections) {
    const { query, variables } = build(selection);
    const { data, errors } = await graphql({ token, query, variables, fetch });
    if (!errors.length && data) return { selection: selection.name, data, tried };
    tried.push({ selection: selection.name, errors });
  }
  return { selection: null, data: null, tried };
}

/**
 * Reads each run's invocations, polling until every run has at least one invocation reported or
 * `waitS` runs out. Fills run.analytics in place; returns notes for the summary.
 */
export async function readAnalytics({ accountId, token, script, runs, namespaceId, startedAt, endedAt, fetch = globalThis.fetch, wait = sleep, waitS = ANALYTICS_WAIT_S, now = Date.now }) {
  const notes = [];
  const result = { invocationSelection: null, periodic: null, periodicSelection: null, errors: [] };
  if (!runs.length) return result;
  const deadline = now() + waitS * 1000;
  await wait(ANALYTICS_FIRST_WAIT_MS);
  let selections = INVOCATION_SELECTIONS;
  for (;;) {
    let answer;
    try {
      answer = await queryWithFallback({ token, selections, fetch, build: (selection) => invocationsQuery({ accountId, script, runs, selection }) });
    } catch (error) {
      result.errors.push(error.message);
      return result;
    }
    for (const t of answer.tried) result.errors.push(`invocations (${t.selection}): ${t.errors.join("; ")}`);
    if (!answer.data) break;
    result.invocationSelection = answer.selection;
    // Keep to the selection that answered for later polls.
    selections = INVOCATION_SELECTIONS.filter((s) => s.name === answer.selection);
    const account = answer.data.viewer?.accounts?.[0] ?? {};
    runs.forEach((run, i) => {
      run.analytics = summariseGroups(account[`r${i}`]);
    });
    const missing = runs.filter((r) => !r.analytics).length;
    if (!missing) break;
    if (now() + ANALYTICS_POLL_MS > deadline) {
      notes.push(`${missing} run(s) had no invocation in analytics after ${waitS} s; their analytics columns are empty.`);
      break;
    }
    await wait(ANALYTICS_POLL_MS);
  }
  if (namespaceId) {
    try {
      const answer = await queryWithFallback({
        token,
        selections: PERIODIC_SELECTIONS,
        fetch,
        build: (selection) => periodicQuery({ accountId, namespaceId, start: startedAt, end: endedAt + 60_000, selection }),
      });
      for (const t of answer.tried) result.errors.push(`periodic (${t.selection}): ${t.errors.join("; ")}`);
      result.periodicSelection = answer.selection;
      result.periodic = answer.data?.viewer?.accounts?.[0]?.periodic?.[0]?.sum ?? null;
    } catch (error) {
      result.errors.push(error.message);
    }
  } else {
    notes.push("The probe's Durable Object namespace was not found, so the periodic CPU total was not read.");
  }
  result.notes = notes;
  return result;
}

// ---------------------------------------------------------------------------------------------
// The probe

/** One HTTP request to the probe. Returns status, latency and body (or the error), never headers. */
export async function call({ baseUrl, path, params = {}, key, timeoutMs = 30_000, fetch = globalThis.fetch, now = Date.now }) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (key) url.searchParams.set("key", key);
  const start = now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Not JSON: Cloudflare's own error pages are HTML or text.
    }
    return { status: response.status, ms: now() - start, body: body.slice(0, 2000), json };
  } catch (error) {
    return { status: null, ms: now() - start, error: `${error?.name ?? "Error"}: ${error?.message ?? error}`, json: null };
  }
}

/**
 * Watches one WebSocket to the probe DO: records open, close and error events with their times,
 * and answers whether it was closed in a window and whether it still replies to a ping.
 */
export class SocketWatch {
  constructor({ url, WebSocketImpl = globalThis.WebSocket, now = Date.now }) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.events = [];
    this.socket = null;
    this.waiters = new Map();
    this.connects = 0;
  }

  get isOpen() {
    return this.socket?.readyState === 1;
  }

  connect(timeoutMs = 15_000) {
    this.connects += 1;
    return new Promise((done) => {
      let settled = false;
      const finish = (ok) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          done(ok);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      let socket;
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        this.events.push({ at: this.now(), type: "error", message: String(error?.message ?? error) });
        finish(false);
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.events.push({ at: this.now(), type: "open" });
        finish(true);
      });
      socket.addEventListener("message", (event) => {
        const text = String(event.data);
        const m = text.match(/^pong:([^:]+):(.*)$/);
        if (m && this.waiters.has(m[1])) {
          this.waiters.get(m[1])({ ok: true, bootId: m[2] });
          this.waiters.delete(m[1]);
        }
      });
      socket.addEventListener("error", (event) => {
        this.events.push({ at: this.now(), type: "error", message: String(event?.message ?? event?.error?.message ?? "error") });
        finish(false);
      });
      socket.addEventListener("close", (event) => {
        this.events.push({ at: this.now(), type: "close", code: event.code, reason: event.reason ?? "", wasClean: event.wasClean ?? null });
        for (const resolveWaiter of this.waiters.values()) resolveWaiter({ ok: false, closed: true });
        this.waiters.clear();
        finish(false);
      });
    });
  }

  /**
   * The first close event recorded after the first `index` events, or null. Runs pass the event
   * count from before their burn, so a close from an earlier run (even in the same millisecond)
   * never counts against a later one.
   */
  closeAfter(index) {
    return this.events.slice(index).find((e) => e.type === "close") ?? null;
  }

  ping(id, timeoutMs = 5_000) {
    if (!this.isOpen) return Promise.resolve({ ok: false, closed: true });
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        done({ ok: false, timeout: true });
      }, timeoutMs);
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        done(r);
      });
      try {
        this.socket.send(`ping:${id}`);
      } catch (error) {
        clearTimeout(timer);
        this.waiters.delete(id);
        done({ ok: false, error: String(error?.message ?? error) });
      }
    });
  }

  close() {
    try {
      this.socket?.close(1000, "probe finished");
    } catch {
      // Already closed.
    }
  }
}

/** Describes what happened to the WebSocket during one run, for the table. */
export function describeSocket({ enabled, connected, closed, pong }) {
  if (!enabled) return "off";
  if (!connected) return "could not connect";
  if (closed) return `dropped: close ${closed.code}${closed.reason ? ` ${closed.reason}` : ""}`;
  if (pong?.ok) return "kept";
  if (pong?.timeout) return "open, no pong";
  return "closed";
}

/** Polls /health until the probe answers 200. Returns the attempts used, or throws. */
export async function waitForHealth({ baseUrl, fetch = globalThis.fetch, wait = sleep, attempts = HEALTH_ATTEMPTS }) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await call({ baseUrl, path: "/health", fetch });
    if (last.status === 200) return i;
    await wait(HEALTH_INTERVAL_MS);
  }
  throw new Error(`the probe did not answer /health with 200 after ${attempts} attempts (last: ${last.status ?? last.error})`);
}

/**
 * Runs each target duration against the probe: mark the DO's memory, burn, check the memory and
 * the WebSocket. Returns one record per target.
 */
export async function runProbe({ baseUrl, key, durations, rate, websocket, fetch = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, wait = sleep, now = Date.now, log = () => {} }) {
  const runs = [];
  let watch = null;
  if (websocket) {
    const wsUrl = new URL("/ws", baseUrl);
    wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";
    wsUrl.searchParams.set("key", key);
    watch = new SocketWatch({ url: wsUrl.toString(), WebSocketImpl, now });
  }
  for (const [i, targetMs] of durations.entries()) {
    const iterations = iterationsFor(targetMs, rate);
    const token = `run-${i}-${Math.random().toString(36).slice(2, 10)}`;
    let connected = false;
    if (watch) connected = watch.isOpen || (await watch.connect());
    const before = await call({ baseUrl, path: "/mark", params: { token }, key, fetch, now });
    await wait(GAP_MS);
    const eventsBefore = watch ? watch.events.length : 0;
    const startedAt = now();
    const burnResult = await call({ baseUrl, path: "/burn", params: { iterations }, key, timeoutMs: BURN_TIMEOUT_MS, fetch, now });
    const endedAt = now();
    await wait(GAP_MS);
    const closed = watch && connected ? watch.closeAfter(eventsBefore) : null;
    const pong = watch && connected && !closed ? await watch.ping(String(i)) : null;
    const after = await call({ baseUrl, path: "/state", key, fetch, now });
    const completed = burnResult.status === 200 && burnResult.json?.checksum != null;
    const run = {
      targetMs,
      iterations,
      startedAt,
      endedAt,
      outcome: completed ? "completed" : "failed",
      http: burnResult.status,
      latencyMs: burnResult.ms,
      response: burnResult.error ?? burnResult.body,
      stateKept: before.json?.marker === token && after.json?.marker === token,
      state: { before: before.json ?? { status: before.status, error: before.error ?? before.body }, after: after.json ?? { status: after.status, error: after.error ?? after.body } },
      websocket: describeSocket({ enabled: Boolean(watch), connected, closed, pong }),
      analytics: null,
    };
    runs.push(run);
    log(`target ${targetMs} ms: HTTP ${run.http ?? "none"} in ${run.latencyMs} ms, ${run.outcome}, state ${run.stateKept ? "kept" : "reset"}, WebSocket ${run.websocket}`);
  }
  if (watch) watch.close();
  return { runs, websocketEvents: watch?.events ?? [], websocketConnects: watch?.connects ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Output

const fmt = (n, digits = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("en-NZ", { maximumFractionDigits: digits }));

/** The Markdown report for $GITHUB_STEP_SUMMARY. */
export function renderSummary(result) {
  const { calibration, runs, analytics = {}, websocket } = result;
  const lines = [
    "## Durable Object CPU probe",
    "",
    `Worker \`${result.name}\`, ${runs.length} run(s), WebSocket client ${websocket ? "on" : "off"}. Analytics CPU per invocation: ${analytics.invocationSelection ?? "not available"}.`,
    "",
    "| Target ms | Iterations | HTTP | Latency ms | DO status (analytics) | CPU ms (analytics) | Wall ms (analytics) | DO memory | WebSocket | Response or error |",
    "|---:|---:|---:|---:|---|---:|---:|---|---|---|",
  ];
  for (const r of runs) {
    const statuses = r.analytics ? Object.entries(r.analytics.statuses).map(([s, n]) => `${s}×${n}`).join(", ") : null;
    lines.push(
      `| ${fmt(r.targetMs)} | ${fmt(r.iterations)} | ${r.http ?? "none"} | ${fmt(r.latencyMs)} | ${cell(statuses)} | ${fmt(r.analytics?.cpuMs, 1)} | ${fmt(r.analytics?.wallMs, 1)} | ${r.stateKept ? "kept" : "reset"} | ${cell(r.websocket)} | ${cell(r.response)} |`,
    );
  }
  const bracket = bracketLimit(runs);
  const wRate = workerdRate(runs);
  lines.push(
    "",
    "**Calibration.**",
    `- Node ${calibration.node ?? ""} on ${calibration.cpu ?? "the runner"}: ${fmt(calibration.iterationsPerMs)} iterations per ms of CPU (median of ${calibration.samples?.length ?? 0} samples). Iterations = target ms × this rate.`,
    `- On Cloudflare, from completed runs with analytics CPU of 20 ms or more: ${wRate == null ? "not available" : `${fmt(wRate)} iterations per ms (${fmt(wRate / calibration.iterationsPerMs, 2)}× the runner)`}.`,
    "",
    "**Limit.**",
    `- Most CPU a completed run used: ${bracket.maxCompletedMs == null ? "none completed" : `${fmt(bracket.maxCompletedMs, 1)} ms`}.`,
    `- Least CPU at which a run failed: ${bracket.minFailedMs == null ? "none failed" : `${fmt(bracket.minFailedMs, 1)} ms`}.`,
    "- Both use the analytics CPU where it was reported, and the target otherwise.",
  );
  if (analytics.periodic) {
    const p = analytics.periodic;
    lines.push(
      "",
      `**Periodic DO totals (whole probe).** CPU ${fmt((p.cpuTime ?? 0) / 1000, 1)} ms, active ${fmt((p.activeTime ?? 0) / 1000, 1)} ms${p.exceededCpuErrors != null ? `, exceeded-CPU errors ${p.exceededCpuErrors}` : ""}${p.exceededMemoryErrors != null ? `, exceeded-memory errors ${p.exceededMemoryErrors}` : ""}.`,
    );
  }
  const notes = [...(result.notes ?? []), ...(analytics.notes ?? []), ...(analytics.errors ?? []).map((e) => `Analytics: ${e}`)];
  if (notes.length) lines.push("", "**Notes.**", ...notes.map((n) => `- ${cell(n, 400)}`));
  lines.push(
    "",
    "How to read it: *DO memory* is `reset` when the counter set before the run was gone after it (the DO instance restarted). *WebSocket* is `dropped` with the close code when the connected client was closed during the run. CPU and wall times come from `durableObjectsInvocationsAdaptiveGroups`, reported in microseconds and shown in ms.",
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// CLI

function need(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`${missing.join(", ")} must be set`);
  return names.map((n) => env[n]);
}

/** Runs one command. Returns the exit code; output goes through `out` and `err`. */
export async function main(argv, { env = process.env, fetch = globalThis.fetch, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), WebSocketImpl = globalThis.WebSocket, wait = sleep } = {}) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      durations: { type: "string" },
      websocket: { type: "string" },
      out: { type: "string" },
      status: { type: "string" },
      name: { type: "string" },
      "url-out": { type: "string" },
      "url-file": { type: "string" },
      calibration: { type: "string" },
      "analytics-wait": { type: "string" },
    },
  });
  try {
    switch (command) {
      case "validate": {
        const durations = parseDurations(values.durations);
        const websocket = parseBoolean("websocket", values.websocket);
        out(`durations: ${durations.join(", ")} ms (${durations.length} runs); WebSocket client: ${websocket ? "on" : "off"}\n`);
        return 0;
      }
      case "calibrate": {
        const c = calibrate();
        const result = { ...c, node: process.version, cpu: cpus()[0]?.model ?? null };
        if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
        out(`calibration: ${Math.round(result.iterationsPerMs).toLocaleString("en-NZ")} iterations per ms on ${result.cpu} (Node ${result.node}); samples ${result.samples.map((s) => Math.round(s)).join(", ")}\n`);
        return 0;
      }
      case "preflight": {
        const [token, accountId] = need(env, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
        const subdomain = await fetchSubdomain({ accountId, token, fetch });
        out(`::add-mask::${subdomain}\n`);
        out("workers.dev subdomain: found\n");
        try {
          const now = Date.now();
          const { errors } = await graphql({
            token,
            fetch,
            query: "query Check($account: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: {accountTag: $account}) { durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } } } } }",
            variables: { account: accountId, start: isoSecond(now - 3_600_000), end: isoSecond(now) },
          });
          out(errors.length ? `::warning::analytics answered with errors: ${errors.join("; ")}\n` : "analytics: readable\n");
        } catch (error) {
          out(`::warning::${error.message} The probe still runs, but the table will have no CPU figures.\n`);
        }
        return 0;
      }
      case "deploy-log": {
        const [file] = positionals;
        if (!file || !values.name || !values["url-out"] || values.status == null) throw new Error("deploy-log needs <log file> --status --name --url-out");
        const log = readFileSync(file, "utf8");
        const found = parseDeployUrl(log, values.name);
        // Mask first: GitHub hides a value only in lines printed after its ::add-mask::.
        if (found) out(`::add-mask::${found.host}\n::add-mask::${found.subdomain}\n`);
        out(found ? scrub(log, [[found.host, "<probe-host>"], [found.subdomain, "<subdomain>"]]) : log);
        if (values.status !== "0") {
          const why = explainCloudflareError(log);
          out(`::error::wrangler deploy failed (exit ${values.status}).${why ? ` ${why}` : ""}\n`);
          return 1;
        }
        if (!found) {
          out("::error::wrangler deploy succeeded but printed no workers.dev URL for the probe. Is the account's workers.dev subdomain enabled (README 1.3)?\n");
          return 1;
        }
        writeFileSync(values["url-out"], found.url);
        return 0;
      }
      case "run": {
        const [token, accountId, key] = need(env, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PROBE_KEY"]);
        if (!values["url-file"] || !values.calibration || !values.name || !values.out) throw new Error("run needs --url-file --calibration --name --out");
        const durations = parseDurations(values.durations);
        const websocket = parseBoolean("websocket", values.websocket);
        const baseUrl = readFileSync(values["url-file"], "utf8").trim();
        const calibration = JSON.parse(readFileSync(values.calibration, "utf8"));
        const host = new URL(baseUrl).host;
        const secrets = [[key, "<key>"], [host, "<probe-host>"], [host.split(".")[1], "<subdomain>"]];
        const say = (s) => out(scrub(s, secrets) + "\n");
        const waitS = values["analytics-wait"] ? Number(values["analytics-wait"]) : ANALYTICS_WAIT_S;

        const attempts = await waitForHealth({ baseUrl, fetch, wait });
        say(`probe reachable after ${attempts} health check(s)`);
        let namespaceId = null;
        const notes = [];
        try {
          namespaceId = await findNamespace({ accountId, token, name: values.name, fetch });
        } catch (error) {
          notes.push(error.message);
        }
        const startedAt = Date.now();
        const probe = await runProbe({ baseUrl, key, durations, rate: calibration.iterationsPerMs, websocket, fetch, WebSocketImpl, wait, log: say });
        const endedAt = Date.now();
        say("reading analytics (they lag by a minute or two)…");
        const analytics = await readAnalytics({ accountId, token, script: values.name, runs: probe.runs, namespaceId, startedAt, endedAt, fetch, wait, waitS });
        const result = {
          name: values.name,
          ranAt: new Date(startedAt).toISOString(),
          websocket,
          calibration,
          runs: probe.runs,
          websocketEvents: probe.websocketEvents,
          websocketConnects: probe.websocketConnects,
          analytics,
          notes,
        };
        const json = scrub(JSON.stringify(result, null, 2), secrets);
        writeFileSync(values.out, json);
        const summary = scrub(renderSummary(result), secrets);
        out(summary);
        if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
        return 0;
      }
      case "teardown": {
        const [token, accountId] = need(env, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
        if (!values.name) throw new Error("teardown needs --name");
        const outcome = await deleteScript({ accountId, token, name: values.name, fetch });
        out(`probe worker ${values.name}: ${outcome}\n`);
        return 0;
      }
      default:
        err(`usage: do-cpu-probe.mjs validate|calibrate|preflight|deploy-log|run|teardown [options]\n`);
        return 2;
    }
  } catch (error) {
    out(`::error::${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
