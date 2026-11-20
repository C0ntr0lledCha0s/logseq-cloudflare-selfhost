import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INVOCATION_SELECTIONS,
  MAX_DURATION_MS,
  MAX_POINTS,
  MAX_REPEATS,
  bracketLimit,
  calibrate,
  cell,
  deleteScript,
  describeSocket,
  explainCloudflareError,
  fetchSubdomain,
  invocationsQuery,
  isoSecond,
  iterationsFor,
  main,
  median,
  parseBoolean,
  parseDeployUrl,
  parseDurations,
  parseRepeats,
  readAnalytics,
  renderSummary,
  runProbe,
  runVerdict,
  runWindow,
  scrub,
  summariseGroups,
  workerdRate,
} from "./do-cpu-probe.mjs";
import { BLOCK, burn } from "./do-cpu-probe/burn.mjs";
import worker, { ProbeDO } from "./do-cpu-probe/worker.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "do-cpu-probe.yml"), "utf8");

const PROBE = "https://do-cpu-probe-7-1.acme-sub.workers.dev";
const KEY = "k3y-0123456789abcdef";
const noWait = async () => {};

// ---------------------------------------------------------------------------------------------
// A fake Durable Object namespace that runs the real ProbeDO. `killAbove` makes a burn of more
// iterations than that throw as a CPU-limit kill would, and resets the instance, as Cloudflare does.

function probeEnv({ killAbove = Infinity, onKill = () => {} } = {}) {
  const ns = {
    instance: new ProbeDO({ acceptWebSocket() {} }, {}),
    idFromName: (name) => name,
    get: () => ({
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/burn" && Number(url.searchParams.get("iterations")) > killAbove) {
          ns.instance = new ProbeDO({ acceptWebSocket() {} }, {});
          onKill();
          const error = new Error("Durable Object's isolate exceeded its CPU time limit and was reset.");
          error.retryable = false;
          error.durableObjectReset = true;
          throw error;
        }
        return ns.instance.fetch(request);
      },
    }),
  };
  return { PROBE: ns, PROBE_KEY: KEY };
}

/** A fetch that sends probe-host requests to the real Worker, and others to `cloudflare(url, init)`. */
function fakeFetch(env, cloudflare = () => new Response("{}", { status: 404 })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.toString(), method: init.method ?? "GET", body: init.body });
    if (u.origin === PROBE) return worker.fetch(new Request(u), env);
    return cloudflare(u, init);
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------------------------
// Inputs

test("parseDurations accepts the default list and the limits", () => {
  assert.deepEqual(parseDurations("5,50,200,500,2000,5000,15000,35000"), [5, 50, 200, 500, 2000, 5000, 15000, 35000]);
  assert.deepEqual(parseDurations(" 1 , 120000 "), [1, MAX_DURATION_MS]);
  assert.equal(parseDurations(Array(MAX_POINTS).fill("10").join(",")).length, MAX_POINTS);
});

test("parseDurations refuses each kind of bad entry, naming it", () => {
  const cases = [
    ["120001", /entry 0 \(120001\): above the 120000 ms maximum/],
    ["5,999999", /entry 1 \(999999\): above/],
    ["0", /entry 0 \(0\): must be at least 1 ms/],
    ["abc", /entry 0 \("abc"\): not a whole number/],
    ["5,,6", /entry 1 \(""\): not a whole number/],
    ["-5", /entry 0 \("-5"\): not a whole number/],
    ["2.5", /entry 0 \("2.5"\): not a whole number/],
    ["1e3", /entry 0 \("1e3"\): not a whole number/],
    ["", /at least one duration/],
    [Array(MAX_POINTS + 1).fill("10").join(","), /21 points given, at most 20 allowed/],
  ];
  for (const [input, message] of cases) assert.throws(() => parseDurations(input), message, JSON.stringify(input));
});

test("parseBoolean takes only true or false", () => {
  assert.equal(parseBoolean("websocket", "true"), true);
  assert.equal(parseBoolean("websocket", "false"), false);
  for (const v of ["yes", "TRUE", "", undefined, "1"]) assert.throws(() => parseBoolean("websocket", v), /websocket: must be true or false/);
});

// ---------------------------------------------------------------------------------------------
// Calibration maths

test("burn is deterministic and depends on the iteration count across block boundaries", () => {
  assert.equal(burn(0), 0x811c9dc5);
  assert.equal(burn(1000), burn(1000));
  assert.notEqual(burn(1000), burn(1001));
  assert.notEqual(burn(BLOCK), burn(BLOCK + 1));
  assert.ok(Number.isInteger(burn(BLOCK + 7)) && burn(BLOCK + 7) >= 0);
});

test("calibrate measures iterations per ms of CPU from the clock it is given", () => {
  // A fake CPU clock: 1,000 iterations take 1 ms.
  let iterationsDone = 0;
  const c = calibrate({ burnFn: (n) => (iterationsDone += n), cpuNow: () => iterationsDone / 1000, samples: 5, sampleMs: 200 });
  assert.equal(c.iterationsPerMs, 1000);
  assert.equal(c.samples.length, 5);
  assert.equal(c.sampleIterations, 200_000);
});

test("calibrate takes the median sample, so one slow sample does not move it", () => {
  let t = 0;
  let call = 0;
  // Calls: warm-up, growth (one at 50 ms), then five samples; the third sample is 4× slower.
  const c = calibrate({
    burnFn: (n) => {
      call += 1;
      t += call === 5 ? (4 * n) / 1000 : n / 1000;
    },
    cpuNow: () => t,
    sampleMs: 100,
  });
  assert.equal(c.iterationsPerMs, 1000);
});

test("iterationsFor and median", () => {
  assert.equal(iterationsFor(50, 1234.5), 61_725);
  assert.equal(iterationsFor(1, 0.1), 1);
  assert.throws(() => iterationsFor(5, 0), /must be positive/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("workerdRate uses completed runs with enough CPU; bracketLimit brackets the kill", () => {
  const runs = [
    { targetMs: 5, iterations: 5_000, outcome: "completed", analytics: { cpuMs: 6 } },
    { targetMs: 50, iterations: 50_000, outcome: "completed", analytics: { cpuMs: 25 } },
    { targetMs: 200, iterations: 200_000, outcome: "completed", analytics: { cpuMs: 100 } },
    { targetMs: 500, iterations: 500_000, outcome: "failed", analytics: { cpuMs: 310 } },
    { targetMs: 2000, iterations: 2_000_000, outcome: "failed", analytics: null },
  ];
  assert.equal(workerdRate(runs), 2000);
  assert.deepEqual(bracketLimit(runs), { maxCompletedMs: 100, minFailedMs: 310 });
  assert.deepEqual(bracketLimit([{ targetMs: 40, outcome: "failed", analytics: null }]), { maxCompletedMs: null, minFailedMs: 40 });
  assert.equal(workerdRate([]), null);
});

// ---------------------------------------------------------------------------------------------
// The probe Worker and DO, run for real

test("the Worker answers /health without the key and refuses every DO route without it", async () => {
  const env = probeEnv();
  assert.equal((await worker.fetch(new Request(`${PROBE}/health`), env)).status, 200);
  for (const path of ["/mark", "/state", "/burn?iterations=5", "/ws"]) {
    assert.equal((await worker.fetch(new Request(`${PROBE}${path}`), env)).status, 403, path);
    assert.equal((await worker.fetch(new Request(`${PROBE}${path}${path.includes("?") ? "&" : "?"}key=wrong`), env)).status, 403, path);
  }
  assert.equal((await worker.fetch(new Request(`${PROBE}/other?key=${KEY}`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${PROBE}/state?key=${KEY}`), { ...env, PROBE_KEY: "" })).status, 403);
});

test("the DO keeps its marker across requests and burns the asked-for work", async () => {
  const env = probeEnv();
  const get = async (path) => (await worker.fetch(new Request(`${PROBE}${path}&key=${KEY}`), env)).json();
  const marked = await get("/mark?token=t1");
  const burned = await get("/burn?iterations=12345");
  const state = await get("/state?x=1");
  assert.equal(burned.checksum, burn(12345));
  assert.equal(burned.iterations, 12345);
  assert.equal(state.marker, "t1");
  assert.equal(state.bootId, marked.bootId);
  assert.equal(state.burns, 1);
});

test("the DO refuses a bad iteration count", async () => {
  const env = probeEnv();
  for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "99999999999999"]) {
    const r = await worker.fetch(new Request(`${PROBE}/burn?iterations=${encodeURIComponent(bad)}&key=${KEY}`), env);
    assert.equal(r.status, 400, bad);
    assert.match((await r.json()).error, /iterations must be a whole number/);
  }
});

test("a DO failure reaches the caller as 502 with the error's message and flags", async () => {
  const env = probeEnv({ killAbove: 10 });
  const r = await worker.fetch(new Request(`${PROBE}/burn?iterations=11&key=${KEY}`), env);
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.match(body.error, /exceeded its CPU time limit/);
  assert.equal(body.retryable, false);
  assert.equal(body.durableObjectReset, true);
  assert.equal(body.overloaded, null);
});

test("the DO answers a WebSocket ping with its bootId and ignores other messages", () => {
  const dob = new ProbeDO({ acceptWebSocket() {} }, {});
  const sent = [];
  dob.webSocketMessage({ send: (m) => sent.push(m) }, "ping:3");
  dob.webSocketMessage({ send: (m) => sent.push(m) }, "hello");
  assert.deepEqual(sent, [`pong:3:${dob.bootId}`]);
});

// ---------------------------------------------------------------------------------------------
// The driver against the real Worker

/** A fake WebSocket client wired to the probe: open on next tick, pong on ping, closable by a kill. */
function fakeSockets() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      sockets.push(this);
      setImmediate(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, event) {
      for (const fn of this.listeners[type] ?? []) fn(event);
    }
    send(text) {
      const id = text.slice(5);
      setImmediate(() => this.emit("message", { data: `pong:${id}:boot` }));
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", { code, reason, wasClean: code === 1000 });
    }
  }
  return { FakeWebSocket, sockets };
}

test("runProbe records a completed run with memory and WebSocket kept", async () => {
  const env = probeEnv();
  const { fetch } = fakeFetch(env);
  const { FakeWebSocket, sockets } = fakeSockets();
  const { runs, websocketConnects } = await runProbe({ baseUrl: PROBE, key: KEY, durations: [5, 50], rate: 100, websocket: true, fetch, WebSocketImpl: FakeWebSocket, wait: noWait });
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.outcome, "completed");
    assert.equal(r.http, 200);
    assert.equal(r.stateKept, true);
    assert.equal(r.websocket, "kept");
  }
  assert.equal(runs[1].iterations, 5000);
  assert.equal(websocketConnects, 1);
  assert.match(sockets[0].url, /^wss:\/\/do-cpu-probe-7-1\.acme-sub\.workers\.dev\/ws\?key=/);
});

test("runProbe records a kill: the error, the reset memory and the dropped WebSocket, then reconnects", async () => {
  const { FakeWebSocket, sockets } = fakeSockets();
  const env = probeEnv({ killAbove: 1000, onKill: () => sockets.at(-1).close(1006, "") });
  const { fetch } = fakeFetch(env);
  const { runs, websocketConnects } = await runProbe({ baseUrl: PROBE, key: KEY, durations: [5, 50, 5], rate: 100, websocket: true, fetch, WebSocketImpl: FakeWebSocket, wait: noWait });
  assert.deepEqual(runs.map((r) => r.outcome), ["completed", "failed", "completed"]);
  assert.equal(runs[1].http, 502);
  assert.match(runs[1].response, /exceeded its CPU time limit/);
  assert.equal(runs[1].stateKept, false);
  assert.equal(runs[1].websocket, "dropped: close 1006");
  assert.equal(runs[2].websocket, "kept");
  assert.equal(runs[2].stateKept, true);
  assert.equal(websocketConnects, 2);
});

test("runProbe without a WebSocket client and with a network error", async () => {
  const env = probeEnv();
  const { fetch: real } = fakeFetch(env);
  const fetch = async (url, init) => {
    if (new URL(url).pathname === "/burn") throw new TypeError("fetch failed");
    return real(url, init);
  };
  const { runs } = await runProbe({ baseUrl: PROBE, key: KEY, durations: [5], rate: 10, websocket: false, fetch, wait: noWait });
  assert.equal(runs[0].outcome, "failed");
  assert.equal(runs[0].http, null);
  assert.equal(runs[0].response, "TypeError: fetch failed");
  assert.equal(runs[0].websocket, "off");
});

test("describeSocket", () => {
  assert.equal(describeSocket({ enabled: false }), "off");
  assert.equal(describeSocket({ enabled: true, connected: false }), "could not connect");
  assert.equal(describeSocket({ enabled: true, connected: true, closed: { code: 1011, reason: "reset" } }), "dropped: close 1011 reset");
  assert.equal(describeSocket({ enabled: true, connected: true, pong: { ok: true } }), "kept");
  assert.equal(describeSocket({ enabled: true, connected: true, pong: { ok: false, timeout: true } }), "open, no pong");
});

// ---------------------------------------------------------------------------------------------
// Analytics

test("isoSecond and runWindow cover the burn and a second after it, at whole seconds", () => {
  const t0 = Date.UTC(2026, 10, 16, 10, 0, 5, 400);
  assert.equal(isoSecond(t0), "2026-11-16T10:00:05Z");
  assert.equal(isoSecond(t0, { ceil: true }), "2026-11-16T10:00:06Z");
  assert.deepEqual(runWindow({ startedAt: t0, endedAt: t0 + 35_200 }), { start: "2026-11-16T10:00:05Z", end: "2026-11-16T10:00:42Z" });
});

test("invocationsQuery filters each run's window to the probe script", () => {
  const runs = [{ startedAt: 0, endedAt: 1500 }, { startedAt: 10_000, endedAt: 10_100 }];
  const { query, variables } = invocationsQuery({ accountId: "acc", script: "do-cpu-probe-7-1", runs, selection: INVOCATION_SELECTIONS[0] });
  assert.match(query, /r0: durableObjectsInvocationsAdaptiveGroups\(limit: 20, filter: \{scriptName: \$script, datetime_geq: \$s0, datetime_leq: \$e0\}\)/);
  assert.match(query, /r1: .*sum \{ requests errors wallTime \} quantiles \{ cpuTimeP50 cpuTimeP99 \} dimensions \{ status \}/);
  assert.equal(variables.script, "do-cpu-probe-7-1");
  assert.equal(variables.s1, "1970-01-01T00:00:10Z");
  assert.equal(variables.e1, "1970-01-01T00:00:12Z");
});

test("summariseGroups converts microseconds and reads whichever CPU field answered", () => {
  assert.deepEqual(summariseGroups([{ sum: { requests: 1, errors: 0, wallTime: 52_000, cpuTime: 51_500 }, dimensions: { status: "success" } }]), {
    requests: 1,
    errors: 0,
    statuses: { success: 1 },
    wallMs: 52,
    cpuMs: 51.5,
    cpuSource: "sum.cpuTime",
  });
  const q = summariseGroups([
    { sum: { requests: 1, errors: 1, wallTime: 30_100_000 }, quantiles: { cpuTimeP50: 30_000_000, cpuTimeP99: 30_000_000 }, dimensions: { status: "exceededCpu" } },
    { sum: { requests: 1, errors: 0, wallTime: 900_000_000 }, quantiles: { cpuTimeP50: 2_000, cpuTimeP99: 2_000 }, dimensions: { status: "clientDisconnected" } },
  ]);
  assert.equal(q.cpuMs, 30_000);
  assert.equal(q.cpuSource, "quantiles.cpuTimeP99");
  assert.deepEqual(q.statuses, { exceededCpu: 1, clientDisconnected: 1 });
  assert.equal(q.errors, 1);
  const none = summariseGroups([{ sum: { requests: 1, errors: 0, wallTime: 7_000 }, dimensions: { status: "success" } }]);
  assert.equal(none.cpuMs, null);
  assert.equal(none.wallMs, 7);
  assert.equal(summariseGroups([]), null);
});

/** A fake GraphQL endpoint: refuses sum.cpuTime as an unknown field and answers the quantile query. */
function graphqlAnswer(groupsFor, { periodic = { cpuTime: 1_000, activeTime: 2_000, exceededCpuErrors: 1, exceededMemoryErrors: 0 }, refuseQuantiles = false } = {}) {
  const queries = [];
  const handler = async (url, init) => {
    if (url.pathname === "/client/v4/graphql") {
      const { query, variables } = JSON.parse(init.body);
      queries.push(query);
      if (query.includes("durableObjectsPeriodicGroups")) {
        return Response.json({ data: { viewer: { accounts: [{ periodic: [{ sum: periodic }] }] } }, errors: null });
      }
      if (/wallTime cpuTime/.test(query)) {
        return Response.json({ data: null, errors: [{ message: 'unknown field "cpuTime"' }] });
      }
      if (refuseQuantiles && /quantiles/.test(query)) {
        return Response.json({ data: null, errors: [{ message: 'unknown field "quantiles"' }] });
      }
      const account = {};
      for (const k of Object.keys(variables).filter((k) => /^s\d+$/.test(k))) account[`r${k.slice(1)}`] = groupsFor(Number(k.slice(1)));
      return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
    }
    if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
      return Response.json({ success: true, result: [{ id: "ns-other", script: "logseq-sync" }, { id: "ns-probe", script: "do-cpu-probe-7-1" }], result_info: { total_pages: 1 } });
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
  };
  return { handler, queries };
}

test("readAnalytics asks for the CPU quantiles first and fills each run", async () => {
  const runs = [
    { startedAt: 1_000, endedAt: 1_100, outcome: "completed", iterations: 1 },
    { startedAt: 9_000, endedAt: 40_000, outcome: "failed", iterations: 2 },
  ];
  const { handler, queries } = graphqlAnswer((i) => [
    { sum: { requests: 1, errors: i, wallTime: (i + 1) * 1000 }, quantiles: { cpuTimeP50: (i + 1) * 900, cpuTimeP99: (i + 1) * 900 }, dimensions: { status: i ? "exceededCpu" : "success" } },
  ]);
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "do-cpu-probe-7-1", runs, namespaceId: "ns-probe", startedAt: 0, endedAt: 41_000, fetch: (u, i) => handler(new URL(u), i), wait: noWait });
  assert.equal(a.invocationSelection, "quantiles.cpuTimeP99");
  assert.deepEqual(a.errors, []);
  assert.equal(runs[0].analytics.cpuMs, 0.9);
  assert.deepEqual(runs[1].analytics.statuses, { exceededCpu: 1 });
  assert.equal(a.periodic.exceededCpuErrors, 1);
  assert.equal(a.periodicSelection, "cpuTime, exceeded errors");
  assert.equal(queries.length, 2);
});

test("readAnalytics falls back to wall time only when the schema lacks the CPU quantiles", async () => {
  const runs = [{ startedAt: 1_000, endedAt: 1_100, outcome: "completed", iterations: 1 }];
  const { handler, queries } = graphqlAnswer(() => [{ sum: { requests: 1, errors: 0, wallTime: 4_000 }, dimensions: { status: "success" } }], { refuseQuantiles: true });
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: "ns-probe", startedAt: 0, endedAt: 2_000, fetch: (u, i) => handler(new URL(u), i), wait: noWait });
  assert.equal(a.invocationSelection, "none (wall time only)");
  assert.match(a.errors[0], /invocations \(quantiles\.cpuTimeP99\): unknown field "quantiles"/);
  assert.equal(runs[0].analytics.cpuMs, null);
  assert.equal(runs[0].analytics.wallMs, 4);
  assert.equal(queries.length, 3);
});

test("readAnalytics polls until every run is reported, then gives up with a note", async () => {
  const runs = [{ startedAt: 1_000, endedAt: 1_100 }, { startedAt: 9_000, endedAt: 9_100 }];
  let clock = 0;
  const { handler, queries } = graphqlAnswer((i) => (i === 0 ? [{ sum: { requests: 1, errors: 0, wallTime: 1 }, dimensions: { status: "success" } }] : []));
  const a = await readAnalytics({
    accountId: "acc",
    token: "t",
    script: "s",
    runs,
    namespaceId: null,
    startedAt: 0,
    endedAt: 10_000,
    fetch: (u, i) => handler(new URL(u), i),
    wait: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    waitS: 100,
  });
  assert.ok(runs[0].analytics);
  assert.equal(runs[1].analytics, null);
  assert.match(a.notes.join("\n"), /1 run\(s\) had no invocation in analytics after 100 s/);
  assert.match(a.notes.join("\n"), /namespace was not found/);
  // One query per poll: the quantile selection answers first time.
  assert.ok(queries.length >= 4 && queries.length <= 7, String(queries.length));
});

test("readAnalytics stops at a refused token and names the permission", async () => {
  const fetch = async () => Response.json({ data: null, errors: [{ message: "not authorized for that account" }] }, { status: 200 });
  const runs = [{ startedAt: 1, endedAt: 2 }];
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: "ns", startedAt: 0, endedAt: 3, fetch, wait: noWait });
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /The token needs Account → Account Analytics Read/);
  assert.equal(a.invocationSelection, null);
});

// ---------------------------------------------------------------------------------------------
// Cloudflare REST: subdomain, teardown and error text

function cfResponder(status, body) {
  return async () => new Response(JSON.stringify(body), { status });
}

test("fetchSubdomain names the permission or setup step that is missing", async () => {
  assert.equal(await fetchSubdomain({ accountId: "a", token: "t", fetch: cfResponder(200, { success: true, result: { subdomain: "acme-sub" } }) }), "acme-sub");
  await assert.rejects(
    fetchSubdomain({ accountId: "a", token: "t", fetch: cfResponder(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }) }),
    /10000: Authentication error\. The token needs Account → Workers Scripts Edit \(included in Workers Admin/,
  );
  await assert.rejects(
    fetchSubdomain({ accountId: "a", token: "t", fetch: cfResponder(404, { success: false, errors: [{ code: 10007, message: "workers.api.error.subdomain_not_found" }] }) }),
    /no workers\.dev subdomain: open Workers & Pages in the dashboard once \(README 1\.3\)/,
  );
});

test("deleteScript deletes, accepts already gone, and names the permission when refused", async () => {
  const seen = [];
  const ok = async (url, init) => {
    seen.push([init.method, String(url)]);
    return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
  };
  assert.match(await deleteScript({ accountId: "a", token: "t", name: "do-cpu-probe-7-1", fetch: ok }), /deleted by the API/);
  assert.deepEqual(seen, [["DELETE", "https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/do-cpu-probe-7-1?force=true"]]);
  assert.equal(await deleteScript({ accountId: "a", token: "t", name: "x", fetch: cfResponder(404, { success: false, errors: [{ code: 10007, message: "workers.api.error.script_not_found" }] }) }), "already gone");
  await assert.rejects(
    deleteScript({ accountId: "a", token: "t", name: "x", fetch: cfResponder(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }) }),
    /The token needs Account → Workers Scripts Edit.*Delete it by hand: Workers & Pages → x/,
  );
  await assert.rejects(deleteScript({ accountId: "a", token: "t", name: "x", fetch: cfResponder(500, { success: false, errors: [{ code: 10013, message: "boom" }] }) }), /HTTP 500 10013: boom/);
});

test("explainCloudflareError maps wrangler's failures to what to fix", () => {
  assert.match(explainCloudflareError("✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]"), /Workers Scripts Edit.*Account Analytics Read/);
  assert.match(explainCloudflareError("You need a workers.dev subdomain in order to proceed. [code: 10063]"), /README 1\.3/);
  assert.match(explainCloudflareError("Cannot apply new-class migration to class 'ProbeDO' ... new_sqlite_classes [code: 10097]"), /new_sqlite_classes/);
  assert.equal(explainCloudflareError("Something else entirely"), null);
});

test("parseDeployUrl finds the probe's own workers.dev URL", () => {
  const log = "Uploaded do-cpu-probe-7-1 (2.1 sec)\nDeployed do-cpu-probe-7-1 triggers (0.4 sec)\n  https://do-cpu-probe-7-1.acme-sub.workers.dev\nCurrent Version ID: abc";
  assert.deepEqual(parseDeployUrl(log, "do-cpu-probe-7-1"), { url: PROBE, host: "do-cpu-probe-7-1.acme-sub.workers.dev", subdomain: "acme-sub" });
  assert.equal(parseDeployUrl("https://other.acme-sub.workers.dev", "do-cpu-probe-7-1"), null);
});

test("scrub and cell", () => {
  assert.equal(scrub("a KEY b host.sub c sub", [["KEY", "<key>"], ["host.sub", "<host>"], ["sub", "<sub>"]]), "a <key> b <host> c <sub>");
  assert.equal(cell("a | b\nc"), "a \\| b c");
  assert.equal(cell("x".repeat(200), 10), `${"x".repeat(9)}…`);
  assert.equal(cell(""), "–");
});

// ---------------------------------------------------------------------------------------------
// Summary rendering

test("renderSummary shows each run, the calibration and the bracket", () => {
  const md = renderSummary({
    name: "do-cpu-probe-7-1",
    websocket: true,
    calibration: { iterationsPerMs: 1000, samples: [1, 2, 3, 4, 5], node: "v22.0.0", cpu: "Test CPU" },
    runs: [
      { targetMs: 50, iterations: 50_000, http: 200, latencyMs: 80, outcome: "completed", stateKept: true, websocket: "kept", response: '{"checksum":1}', analytics: { statuses: { success: 1 }, cpuMs: 25, wallMs: 26 } },
      { targetMs: 35_000, iterations: 35_000_000, http: 502, latencyMs: 30_150, outcome: "failed", stateKept: false, websocket: "dropped: close 1006", response: "Exceeded CPU | limit", analytics: { statuses: { exceededCpu: 1 }, cpuMs: 30_000.4, wallMs: 30_100 } },
    ],
    analytics: { invocationSelection: "sum.cpuTime", periodic: { cpuTime: 30_025_000, activeTime: 31_000_000, exceededCpuErrors: 1 }, errors: ["invocations (x): y"] },
    notes: [],
  });
  assert.match(md, /\| 50 \| 50,000 \| 200 \| 80 \| success×1 \| 25 \| 26 \| kept \| kept \| \{"checksum":1\} \|/);
  assert.match(md, /\| 35,000 \| 35,000,000 \| 502 \| 30,150 \| exceededCpu×1 \| 30,000\.4 \| 30,100 \| reset \| dropped: close 1006 \| Exceeded CPU \\\| limit \|/);
  assert.match(md, /1,000 iterations per ms of CPU \(median of 5 samples\)/);
  assert.match(md, /On Cloudflare.*2,000 iterations per ms \(2× the runner\)/);
  assert.match(md, /Most CPU a completed run used: 25 ms/);
  assert.match(md, /Least CPU at which a run failed: 30,000\.4 ms/);
  assert.match(md, /exceeded-CPU errors 1/);
  assert.match(md, /- Analytics: invocations \(x\): y/);
});

test("renderSummary with no analytics says so rather than inventing figures", () => {
  const md = renderSummary({
    name: "p",
    websocket: false,
    calibration: { iterationsPerMs: 10, samples: [10] },
    runs: [{ targetMs: 5, iterations: 50, http: null, latencyMs: 3, outcome: "failed", stateKept: false, websocket: "off", response: "TypeError: fetch failed", analytics: null }],
    analytics: {},
  });
  assert.match(md, /Analytics CPU per invocation: not available/);
  assert.match(md, /\| 5 \| 50 \| none \| 3 \| – \| – \| – \| reset \| off \| TypeError: fetch failed \|/);
  assert.match(md, /On Cloudflare.*not available/);
  assert.match(md, /none completed/);
});

// ---------------------------------------------------------------------------------------------
// The CLI

function tempDir() {
  return mkdtempSync(join(tmpdir(), "do-cpu-probe-"));
}

test("main run: the real Worker, analytics, JSON and summary, with the key and host scrubbed", async () => {
  const dir = tempDir();
  try {
    const env = probeEnv({ killAbove: 1000 });
    const { handler } = graphqlAnswer((i) => [{ sum: { requests: 1, errors: 0, wallTime: 1000 }, quantiles: { cpuTimeP50: 900, cpuTimeP99: 900 }, dimensions: { status: i ? "exceededCpu" : "success" } }]);
    const { fetch: real, calls } = fakeFetch(env, handler);
    // Some fetch errors quote the URL, which carries the key: the third run's burn fails that way.
    let burns = 0;
    const fetch = async (url, init) => {
      if (new URL(url).pathname === "/burn" && ++burns === 3) throw new TypeError(`fetch failed: ${url}`);
      return real(url, init);
    };
    writeFileSync(join(dir, "url"), `${PROBE}\n`);
    writeFileSync(join(dir, "cal.json"), JSON.stringify({ iterationsPerMs: 100, samples: [100], node: "v22", cpu: "c" }));
    let printed = "";
    const code = await main(
      ["run", "--url-file", join(dir, "url"), "--calibration", join(dir, "cal.json"), "--durations", "5,50,5", "--websocket", "false", "--name", "do-cpu-probe-7-1", "--out", join(dir, "out.json")],
      {
        env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc", PROBE_KEY: KEY, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
        fetch,
        out: (s) => (printed += s),
        wait: noWait,
      },
    );
    assert.equal(code, 0, printed);
    const saved = readFileSync(join(dir, "out.json"), "utf8");
    const summary = readFileSync(join(dir, "summary.md"), "utf8");
    for (const text of [saved, summary, printed]) {
      assert.ok(!text.includes(KEY), "key leaked");
      assert.ok(!text.includes("acme-sub"), "subdomain leaked");
    }
    const result = JSON.parse(saved);
    assert.deepEqual(result.runs.map((r) => r.outcome), ["completed", "failed", "failed"]);
    assert.match(result.runs[2].response, /^TypeError: fetch failed: https:\/\/<probe-host>\/burn\?iterations=500&key=<key>$/);
    assert.equal(result.runs[1].http, 502);
    assert.equal(result.analytics.invocationSelection, "quantiles.cpuTimeP99");
    assert.match(summary, /\| 50 \| 5,000 \| 502 \|/);
    // A few dozen requests at most: health, then mark, burn and state per run.
    assert.equal(calls.filter((c) => c.url.startsWith(PROBE)).length, 1 + 3 * 3 - 1);
    assert.ok(calls.every((c) => !("headers" in c)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main deploy-log masks the host before printing it, and explains a failed deploy", async () => {
  const dir = tempDir();
  try {
    const log = join(dir, "deploy.log");
    writeFileSync(log, `Uploaded do-cpu-probe-7-1\n  ${PROBE}\n`);
    let printed = "";
    const urlOut = join(dir, "url");
    assert.equal(await main(["deploy-log", log, "--status", "0", "--name", "do-cpu-probe-7-1", "--url-out", urlOut], { out: (s) => (printed += s) }), 0);
    const lines = printed.split("\n");
    assert.equal(lines[0], "::add-mask::do-cpu-probe-7-1.acme-sub.workers.dev");
    assert.equal(lines[1], "::add-mask::acme-sub");
    assert.ok(!lines.slice(2).join("\n").includes("acme-sub"));
    assert.equal(readFileSync(urlOut, "utf8"), PROBE);

    writeFileSync(log, "✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]\n");
    printed = "";
    assert.equal(await main(["deploy-log", log, "--status", "1", "--name", "do-cpu-probe-7-1", "--url-out", urlOut], { out: (s) => (printed += s) }), 1);
    assert.match(printed, /::error::wrangler deploy failed \(exit 1\)\. The token was refused\. Deploying and deleting the probe needs Account → Workers Scripts Edit/);

    writeFileSync(log, "Uploaded do-cpu-probe-7-1\nNo deploy targets\n");
    printed = "";
    assert.equal(await main(["deploy-log", log, "--status", "0", "--name", "do-cpu-probe-7-1", "--url-out", urlOut], { out: (s) => (printed += s) }), 1);
    assert.match(printed, /printed no workers\.dev URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main preflight masks the subdomain and warns when analytics are refused", async () => {
  let printed = "";
  const fetch = async (url) => {
    if (String(url).endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "acme-sub" } });
    return Response.json({ errors: [{ message: "not authorized" }] }, { status: 403 });
  };
  assert.equal(await main(["preflight"], { env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }, fetch, out: (s) => (printed += s) }), 0);
  assert.equal(printed.split("\n")[0], "::add-mask::acme-sub");
  assert.match(printed, /::warning::analytics refused: HTTP 403.*Account Analytics Read/);
  assert.equal(await main(["preflight"], { env: {}, fetch, out: (s) => (printed = s) }), 1);
  assert.match(printed, /CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID must be set/);
});

test("main teardown reports the outcome and fails when refused", async () => {
  let printed = "";
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
  assert.equal(await main(["teardown", "--name", "p"], { env, fetch: cfResponder(404, { success: false, errors: [{ code: 10007, message: "not found" }] }), out: (s) => (printed += s) }), 0);
  assert.match(printed, /probe worker p: already gone/);
  assert.equal(await main(["teardown", "--name", "p"], { env, fetch: cfResponder(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }), out: (s) => (printed = s) }), 1);
  assert.match(printed, /::error::deleting p failed.*Workers Scripts Edit/);
});

test("main validate refuses bad inputs before anything is deployed", async () => {
  let printed = "";
  assert.equal(await main(["validate", "--durations", "5,50", "--websocket", "true"], { out: (s) => (printed += s) }), 0);
  assert.match(printed, /durations: 5, 50 ms \(2 runs\); WebSocket client: on/);
  assert.equal(await main(["validate", "--durations", "200000", "--websocket", "true"], { out: (s) => (printed = s) }), 1);
  assert.match(printed, /::error::durations: entry 0 \(200000\): above the 120000 ms maximum/);
  assert.equal(await main(["nope"], { err: () => {} }), 2);
});

test("calibrate runs the real loop in Node and writes a positive rate", () => {
  const dir = tempDir();
  try {
    const out = join(dir, "cal.json");
    const r = spawnSync(process.execPath, [join(root, "scripts", "do-cpu-probe.mjs"), "calibrate", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const cal = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(cal.iterationsPerMs > 0);
    assert.equal(cal.samples.length, 5);
    assert.match(r.stdout, /iterations per ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// The workflow file

/** The lines of the job's step named `name`, up to the next step. */
function step(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step ${name} not found`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - ")) end += 1;
  return lines.slice(start, end);
}

test("the workflow runs only on workflow_dispatch, with the two inputs and their defaults", () => {
  const on = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  const triggers = on.split("\n").filter((l) => /^  [a-z_]+:/.test(l)).map((l) => l.trim());
  assert.deepEqual(triggers, ["workflow_dispatch:"]);
  assert.match(on, /durations:\n[\s\S]*?default: "5,50,200,500,2000,5000,15000,35000"/);
  assert.match(on, /websocket:\n[\s\S]*?type: boolean\n\s+default: true/);
  assert.equal(parseDurations("5,50,200,500,2000,5000,15000,35000").length, 8);
});

test("the workflow reads contents only, runs one at a time and names the probe per run", () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n\n/);
  assert.match(workflow, /\nconcurrency:\n  group: do-cpu-probe\n/);
  assert.match(workflow, /PROBE_NAME: do-cpu-probe-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test("the teardown and the upload always run, and teardown is the last step", () => {
  assert.ok(step("Delete the probe").includes("        if: always()"));
  assert.ok(step("Upload the results").includes("        if: always()"));
  const names = workflow.split("\n").filter((l) => l.startsWith("      - name: "));
  assert.equal(names.at(-1), "      - name: Delete the probe");
  const teardown = step("Delete the probe").join("\n");
  assert.match(teardown, /wrangler@\$WRANGLER_VERSION" delete "\$PROBE_NAME" --force/);
  assert.match(teardown, /node scripts\/do-cpu-probe\.mjs teardown --name "\$PROBE_NAME"/);
});

test("the workflow uses only the deploy secrets, only in env, and never echoes one", () => {
  const lines = workflow.split("\n");
  const secretLines = lines.filter((l) => l.includes("secrets."));
  assert.ok(secretLines.length > 0);
  for (const line of secretLines) {
    assert.match(line, /^ {10}(CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}|CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\})$/, line);
  }
  for (const line of lines) {
    if (/\b(echo|printf)\b/.test(line)) {
      assert.ok(!/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|secrets\./.test(line), line);
    }
  }
  // The probe key is masked before it is written anywhere.
  const key = step("Make the probe key").join("\n");
  assert.ok(key.indexOf('echo "::add-mask::$key"') < key.indexOf('echo "PROBE_KEY=$key"'));
});

test("the validate step refuses a bad duration list when run as GitHub would", () => {
  const lines = step("Validate inputs");
  const run = lines.find((l) => l.startsWith("        run: ")).slice("        run: ".length);
  for (const [durations, status] of [["5,50", 0], ["5,120001", 1], ["", 1]]) {
    const r = spawnSync("bash", ["-e", "-c", run], { cwd: root, env: { ...process.env, DURATIONS: durations, WEBSOCKET: "true", REPEATS: "3" }, encoding: "utf8" });
    assert.equal(r.status, status, `${durations}: ${r.stdout}${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Connector #51: repeats per target, so an ordinary restart can be told from a CPU kill, and an
// analytics query built on what the live run (44481130870) showed the schema exposes.

/**
 * The real Worker and DO behind a namespace that can also restart the instance after a burn that
 * completed (an eviction, not a kill): `restartAfter(iterations, nth)` is asked after the nth
 * completed burn of that size, and a true answer replaces the instance as Cloudflare does.
 */
function restartingEnv({ killAbove = Infinity, restartAfter = () => false } = {}) {
  const env = probeEnv({ killAbove });
  const seen = new Map();
  const inner = env.PROBE.get;
  env.PROBE.get = (id) => {
    const stub = inner(id);
    return {
      fetch: async (request) => {
        const response = await stub.fetch(request);
        const url = new URL(request.url);
        if (url.pathname === "/burn" && response.status === 200) {
          const iterations = Number(url.searchParams.get("iterations"));
          const nth = (seen.get(iterations) ?? 0) + 1;
          seen.set(iterations, nth);
          if (restartAfter(iterations, nth)) env.PROBE.instance = new ProbeDO({ acceptWebSocket() {} }, {});
        }
        return response;
      },
    };
  };
  return env;
}

const byTarget = (runs) => {
  const groups = new Map();
  for (const r of runs) groups.set(r.targetMs, [...(groups.get(r.targetMs) ?? []), r]);
  return groups;
};

test("main validate takes a repeat count and refuses each kind of bad one, naming it", async () => {
  let printed = "";
  assert.equal(await main(["validate", "--durations", "5,50", "--websocket", "true", "--repeats", "3"], { out: (s) => (printed += s) }), 0, printed);
  assert.match(printed, /3 repeats/);
  for (const bad of ["0", "-1", "1.5", "abc", "", "1000"]) {
    printed = "";
    assert.equal(await main(["validate", "--durations", "5", "--websocket", "true", "--repeats", bad], { out: (s) => (printed += s) }), 1, `${bad}: ${printed}`);
    assert.match(printed, /::error::repeats: /, bad);
  }
});

test("runProbe with repeats runs each target N times and classifies a restart after a completed burn as a restart, not a kill", async () => {
  // Target 5 at rate 100 is 500 iterations: the instance restarts after the second of them completes.
  const env = restartingEnv({ restartAfter: (iterations, nth) => iterations === 500 && nth === 2 });
  const { fetch } = fakeFetch(env);
  const { runs } = await runProbe({ baseUrl: PROBE, key: KEY, durations: [5, 50], repeats: 3, rate: 100, websocket: false, fetch, wait: noWait });
  assert.equal(runs.length, 6);
  const groups = byTarget(runs);
  for (const [target, rs] of groups) {
    assert.equal(rs.length, 3, `target ${target}`);
    assert.deepEqual(rs.map((r) => r.repeat), [0, 1, 2], `target ${target}`);
    assert.ok(rs.every((r) => r.outcome === "completed"), `target ${target}`);
  }
  assert.deepEqual(groups.get(5).map((r) => r.verdict), ["kept", "restart", "kept"]);
  assert.deepEqual(groups.get(50).map((r) => r.verdict), ["kept", "kept", "kept"]);
  const restarted = groups.get(5)[1];
  assert.equal(restarted.stateKept, false);
  assert.ok(restarted.bootBefore && restarted.bootAfter && restarted.bootBefore !== restarted.bootAfter, JSON.stringify(restarted));
  const kept = groups.get(5)[0];
  assert.equal(kept.bootBefore, kept.bootAfter);
  // The restart is not a failure, so the limit bracket ignores it.
  assert.deepEqual(bracketLimit(runs), { maxCompletedMs: 50, minFailedMs: null });
});

test("runProbe with repeats classifies every kind of failed burn: a CPU kill by message or by flag, and other errors", async () => {
  const env = probeEnv({ killAbove: 1000 });
  const { fetch: real } = fakeFetch(env);
  // Target 7 (700 iterations): first a 502 with only the reset flag, then a 500 that is no kill,
  // then a network error. Target 50 (5,000 iterations) is killed by the real namespace each time.
  let sevens = 0;
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/burn" && u.searchParams.get("iterations") === "700") {
      sevens += 1;
      if (sevens === 1) return Response.json({ error: "internal error", durableObjectReset: true }, { status: 502 });
      if (sevens === 2) return Response.json({ error: "something else broke" }, { status: 500 });
      throw new TypeError("fetch failed");
    }
    return real(url, init);
  };
  const { runs } = await runProbe({ baseUrl: PROBE, key: KEY, durations: [7, 50], repeats: 3, rate: 100, websocket: false, fetch, wait: noWait });
  const groups = byTarget(runs);
  assert.deepEqual(groups.get(7).map((r) => r.verdict), ["kill", "error", "error"]);
  assert.deepEqual(groups.get(50).map((r) => r.verdict), ["kill", "kill", "kill"]);
  assert.match(groups.get(50)[0].response, /exceeded its CPU time limit/);
});

test("bracketLimit takes the failed side only from CPU kills, not from restarts or other errors", () => {
  const runs = [
    { targetMs: 5, outcome: "completed", verdict: "restart", analytics: null },
    { targetMs: 10, outcome: "failed", verdict: "error", analytics: null },
    { targetMs: 15_000, outcome: "completed", verdict: "kept", analytics: null },
    { targetMs: 35_000, outcome: "failed", verdict: "kill", analytics: null },
  ];
  assert.deepEqual(bracketLimit(runs), { maxCompletedMs: 15_000, minFailedMs: 35_000 });
  assert.deepEqual(bracketLimit([{ targetMs: 10, outcome: "failed", verdict: "error", analytics: null }]), { maxCompletedMs: null, minFailedMs: null });
});

test("renderSummary sums up each target's repeats: completed, restarts and kills", () => {
  const run = (targetMs, repeat, verdict) => ({
    targetMs,
    repeat,
    verdict,
    iterations: targetMs * 10,
    http: verdict === "kill" ? 502 : verdict === "error" ? null : 200,
    latencyMs: targetMs,
    outcome: verdict === "kill" || verdict === "error" ? "failed" : "completed",
    stateKept: verdict === "kept",
    websocket: "off",
    response: "",
    analytics: null,
  });
  const md = renderSummary({
    name: "p",
    websocket: false,
    calibration: { iterationsPerMs: 10, samples: [10] },
    runs: [run(5, 0, "kept"), run(5, 1, "restart"), run(5, 2, "kept"), run(35_000, 0, "kill"), run(35_000, 1, "error")],
    analytics: {},
  });
  assert.match(md, /5 ms: 3 of 3 completed, 1 restarts?, 0 kills?/);
  assert.match(md, /35,000 ms: 0 of 2 completed, 0 restarts?, 1 kills?/);
});

test("the workflow has a repeats input (default 3) and passes it to validate and run", () => {
  const on = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.match(on, /repeats:\n[\s\S]*?default: "?3"?\n/);
  assert.ok(step("Validate inputs").join("\n").includes('--repeats "$REPEATS"'));
  assert.ok(step("Run the probe").join("\n").includes('--repeats "$REPEATS"'));
});

/** A GraphQL endpoint like the live run's: sum.cpuTime unknown on invocations, every group set empty. */
// `periodic` and `unfiltered` override the answer to that one query: "none" answers with no account,
// an { errors } object answers with those GraphQL errors and no data.
function liveLikeAnalytics({ accounts = "empty", periodic, unfiltered } = {}) {
  const queries = [];
  const noAccount = () => Response.json({ data: { viewer: { accounts: [] } }, errors: null });
  const override = (how) => (how === "none" ? noAccount() : Response.json({ data: null, errors: how.errors }));
  const fetch = async (u, init) => {
    const url = new URL(u);
    if (url.pathname !== "/client/v4/graphql") return Response.json({ success: false }, { status: 404 });
    const { query, variables } = JSON.parse(init.body);
    queries.push({ query, variables });
    if (accounts === "none") return noAccount();
    if (periodic && query.includes("durableObjectsPeriodicGroups")) return override(periodic);
    if (unfiltered && query.includes("ProbeUnfiltered")) return override(unfiltered);
    if (query.includes("durableObjectsPeriodicGroups")) return Response.json({ data: { viewer: { accounts: [{ periodic: [] }] } }, errors: null });
    if (/sum \{[^}]*cpuTime/.test(query) && query.includes("durableObjectsInvocationsAdaptiveGroups")) {
      return Response.json({ data: null, errors: [{ message: 'unknown field "cpuTime"' }] });
    }
    const account = {};
    for (const m of query.matchAll(/(\w+): durableObjects\w+/g)) account[m[1]] = [];
    return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
  };
  return { fetch, queries };
}

// The live run's times, with the default ANALYTICS_WAIT_S of 240 s.
const T0 = Date.parse("2026-11-19T07:38:45Z");
const T1 = Date.parse("2026-11-19T07:40:49Z");

async function readLiveLike(options) {
  const f = liveLikeAnalytics(options);
  let clock = T1;
  const runs = [{ startedAt: T0 + 5_000, endedAt: T0 + 5_128, outcome: "completed", iterations: 1 }];
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: "ns", startedAt: T0, endedAt: T1, fetch: f.fetch, wait: async (ms) => { clock += ms; }, now: () => clock });
  return { a, queries: f.queries, clock, text: [...(a.notes ?? []), ...a.errors].join("\n") };
}

test("the invocation query asks for CPU only through fields the dataset answered (quantiles), never sum.cpuTime", () => {
  for (const s of INVOCATION_SELECTIONS) assert.doesNotMatch(s.select, /sum \{[^}]*cpuTime/, s.name);
  assert.match(INVOCATION_SELECTIONS[0].select, /quantiles \{[^}]*cpuTimeP99/);
});

test("readAnalytics, when every invocation group is empty, reads the account without the script filter and says what it found", async () => {
  const { queries, text } = await readLiveLike();
  const diagnostic = queries.find(({ query }) => /durableObjectsInvocationsAdaptiveGroups\(/.test(query) && !/scriptName: \$script/.test(query));
  assert.ok(diagnostic, "expected an invocation read without the scriptName filter");
  assert.match(diagnostic.query, /dimensions \{[^}]*scriptName/);
  assert.match(text, /without the script filter/i);
});

test("readAnalytics reports an empty periodic answer, and its window reaches the time of the read", async () => {
  const { queries, text, clock } = await readLiveLike();
  const periodic = queries.filter(({ query }) => query.includes("durableObjectsPeriodicGroups"));
  assert.ok(periodic.length >= 1);
  assert.ok(Date.parse(periodic.at(-1).variables.end) >= clock - 1000, `periodic window ends ${periodic.at(-1).variables.end}, read at ${new Date(clock).toISOString()}`);
  assert.match(text, /periodic/i, `an empty periodic answer must be reported; got: ${text}`);
});

test("readAnalytics tells an answer with no account (the token cannot see it) from one with no rows yet", async () => {
  const none = await readLiveLike({ accounts: "none" });
  const empty = await readLiveLike({ accounts: "empty" });
  assert.match(none.text, /no account/i, none.text);
  assert.notEqual(none.text, empty.text);
});

test("readAnalytics names a refused unfiltered read as a query error, not as a missing account", async () => {
  const { text } = await readLiveLike({ unfiltered: { errors: [{ message: 'unknown field "scriptName"' }] } });
  assert.match(text, /without the script filter.*answered with errors: unknown field "scriptName"/i, text);
  assert.doesNotMatch(text, /no account/i, text);
});

test("readAnalytics names a periodic answer with no account as such, not as empty", async () => {
  const { text } = await readLiveLike({ periodic: "none" });
  assert.match(text, /periodic DO totals answer had no account/i, text);
  assert.doesNotMatch(text, /came back empty/i, text);
});

test("readAnalytics names an unfiltered answer with no account as such", async () => {
  const { text } = await readLiveLike({ unfiltered: "none" });
  assert.match(text, /without the script filter.*had no account for the account id/i, text);
  assert.doesNotMatch(text, /failed: /i, text);
});

test("parseRepeats takes 1 to MAX_REPEATS, defaults to 1 when absent, and names each refusal", () => {
  assert.equal(parseRepeats(undefined), 1);
  assert.equal(parseRepeats("1"), 1);
  assert.equal(parseRepeats(" 3 "), 3);
  assert.equal(parseRepeats(String(MAX_REPEATS)), MAX_REPEATS);
  assert.throws(() => parseRepeats(String(MAX_REPEATS + 1)), new RegExp(`repeats: ${MAX_REPEATS + 1} is above the maximum of ${MAX_REPEATS}`));
  assert.throws(() => parseRepeats("0"), /repeats: must be at least 1/);
  for (const bad of ["", "-1", "1.5", "1e1", "abc", "3x"]) assert.throws(() => parseRepeats(bad), /repeats: .* is not a whole number/, bad);
});

test("main names the option when a value starts with a dash, for any option", async () => {
  let printed = "";
  assert.equal(await main(["validate", "--durations", "-5", "--websocket", "true"], { out: (s) => (printed += s) }), 1);
  assert.match(printed, /^::error::durations: /);
});

test("runVerdict: kept only when the same instance kept the marker; kill by message or flag; else error", () => {
  const ok = { status: 200, json: { checksum: 1 } };
  assert.equal(runVerdict({ completed: true, stateKept: true, bootBefore: "a", bootAfter: "a", burnResult: ok }), "kept");
  // A new instance, whether or not the marker survived, and an unreadable state, are restarts.
  assert.equal(runVerdict({ completed: true, stateKept: true, bootBefore: "a", bootAfter: "b", burnResult: ok }), "restart");
  assert.equal(runVerdict({ completed: true, stateKept: false, bootBefore: "a", bootAfter: "a", burnResult: ok }), "restart");
  assert.equal(runVerdict({ completed: true, stateKept: false, bootBefore: "a", bootAfter: null, burnResult: ok }), "restart");
  const failed = (burnResult) => runVerdict({ completed: false, stateKept: false, bootBefore: "a", bootAfter: "b", burnResult });
  assert.equal(failed({ status: 503, body: "Error 1102: Durable Object exceeded its CPU time limit and was reset.", json: null }), "kill");
  assert.equal(failed({ status: 502, body: "{}", json: { error: "x", durableObjectReset: true } }), "kill");
  assert.equal(failed({ status: 502, body: "{}", json: { error: "x", durableObjectReset: false } }), "error");
  assert.equal(failed({ status: 500, body: "boom", json: null }), "error");
  assert.equal(failed({ status: null, error: "TypeError: fetch failed", json: null }), "error");
});

test("readAnalytics, when the unfiltered read finds the probe's script, names it so the filter is the suspect", async () => {
  const fetch = async (u, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("ProbeUnfiltered")) {
      return Response.json({ data: { viewer: { accounts: [{ all: [{ sum: { requests: 4 }, dimensions: { scriptName: "s" } }, { sum: { requests: 2 }, dimensions: { scriptName: "logseq-sync" } }] }] } }, errors: null });
    }
    if (query.includes("durableObjectsPeriodicGroups")) return Response.json({ data: { viewer: { accounts: [{ periodic: [{ sum: { cpuTime: 5, activeTime: 6 } }] }] } }, errors: null });
    return Response.json({ data: { viewer: { accounts: [{ r0: [], r1: [] }] } }, errors: null });
  };
  let clock = 0;
  const runs = [{ startedAt: 1_000, endedAt: 1_100 }, { startedAt: 5_000, endedAt: 5_100 }];
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: "ns", startedAt: 0, endedAt: 6_000, fetch, wait: async (ms) => { clock += ms; }, now: () => clock, waitS: 60 });
  const text = a.notes.join("\n");
  assert.match(text, /without the script filter.*had the probe×4, logseq-sync×2/i);
  // A periodic answer with rows is shown, not noted as empty.
  assert.equal(a.periodic.cpuTime, 5);
  assert.doesNotMatch(text, /periodic/i);
});

test("readAnalytics skips the unfiltered read when some runs were reported", async () => {
  const queries = [];
  const fetch = async (u, init) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return Response.json({ data: { viewer: { accounts: [{ r0: [{ sum: { requests: 1, errors: 0, wallTime: 1 }, dimensions: { status: "success" } }], r1: [] }] } }, errors: null });
  };
  let clock = 0;
  const runs = [{ startedAt: 1_000, endedAt: 1_100 }, { startedAt: 5_000, endedAt: 5_100 }];
  const a = await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: null, startedAt: 0, endedAt: 6_000, fetch, wait: async (ms) => { clock += ms; }, now: () => clock, waitS: 60 });
  assert.ok(!queries.some((q) => q.includes("ProbeUnfiltered")));
  assert.doesNotMatch(a.notes.join("\n"), /without the script filter/i);
});

test("readAnalytics stops polling at once when the answer has no account", async () => {
  const f = liveLikeAnalytics({ accounts: "none" });
  const runs = [{ startedAt: T0 + 5_000, endedAt: T0 + 5_128 }];
  await readAnalytics({ accountId: "acc", token: "t", script: "s", runs, namespaceId: null, startedAt: T0, endedAt: T1, fetch: f.fetch, wait: noWait, now: () => T1 });
  assert.equal(f.queries.length, 1);
});
