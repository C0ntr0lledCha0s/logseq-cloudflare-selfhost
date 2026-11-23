import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "release-query-check.mjs");
const upstream = join(root, ".upstream");
const bundle = join(upstream, "deps", "db-sync", "worker", "dist", "worker", "main.js");
const devBuild = join(upstream, "deps", "db-sync", "worker", "dist", "worker-test.js");

// The integration tests need both of upstream's builds: the release bundle (scripts/build.sh) and
// the dev test build that seeds the built-in graph (pnpm test or scripts/upstream-test.sh after it).
// CI and check.sh --upstream run the script itself after both are built.
const skip = !existsSync(bundle)
  ? ".upstream release bundle missing: scripts/build.sh .upstream"
  : !existsSync(devBuild)
    ? ".upstream/deps/db-sync/worker/dist/worker-test.js missing: run pnpm test in .upstream/deps/db-sync after scripts/build.sh"
    : false;

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("release-query-check-"));

test("points the bundle's Cloudflare, Sentry and mldoc imports at stubs and leaves path alone", async () => {
  const { rewriteImports } = await import(script);
  const src =
    'import*as a from"mldoc";import*as b from"cloudflare:workers";import*as c from"@sentry/cloudflare";import*as d from"path";var x=from","';
  const out = rewriteImports(src);
  assert.match(out, /from"\.\/stub-0\.mjs"/);
  assert.match(out, /from"\.\/stub-1\.mjs"/);
  assert.match(out, /from"\.\/stub-2\.mjs"/);
  assert.match(out, /from"path"/);
  assert.match(out, /from","/, "a string that merely starts with from is untouched");
  assert.doesNotMatch(out, /from"(mldoc|cloudflare:workers|@sentry\/cloudflare)"/);
});

test("refuses a bundle whose imports changed, naming the import", async () => {
  const { rewriteImports } = await import(script);
  assert.throws(() => rewriteImports('import*as a from"mldoc";import*as c from"@sentry/cloudflare";'), /cloudflare:workers/);
});

test("assertPlanAndWork accepts plan and work naming each bound, and refuses a missing one or a Datalog echo", async () => {
  const { assertPlanAndWork, MEETING_BOUNDS } = await import(script);
  const plan = "1. … (meetings bound 5,000) … (decisions bound 20,000) … (ancestor-steps bound 50,000) … (reads bound 100,000)";
  const work = { meetings: 1, decisions: 2, "ancestor-steps": 3, reads: 9 };
  assert.doesNotThrow(() => assertPlanAndWork({ plan, work }, MEETING_BOUNDS));
  assert.throws(() => assertPlanAndWork({ plan: plan.replace("(decisions bound", "(x"), work }, MEETING_BOUNDS), /plan does not name the decisions bound/);
  assert.throws(() => assertPlanAndWork({ plan, work: { ...work, reads: undefined } }, MEETING_BOUNDS), /work has no reads count/);
  assert.throws(() => assertPlanAndWork({ plan, work, query: "[:find]" }, MEETING_BOUNDS), /still carries query/);
  assert.throws(() => assertPlanAndWork({ plan, work, rules: "[]" }, MEETING_BOUNDS), /still carries rules/);
});

test("the timing bounds are the spec's: 300 ms for a named query at scale, 100 ms for an F1 shape's width-cap 422", async () => {
  const { NAMED_MS, F1_MS } = await import(script);
  assert.equal(NAMED_MS, 300);
  assert.equal(F1_MS, 100);
});

test("the scale fixture is about 20,000 blocks of meetings, decisions, tasks, tagged pages and stale projects, the same on every build", async () => {
  const { scaleFixture, SCALE } = await import(script);
  const now = 1_762_646_400_000;
  const a = scaleFixture(now);
  assert.deepEqual(scaleFixture(now), a);
  assert.ok(a.blocks >= 18_000 && a.blocks <= 22_000, `${a.blocks} blocks`);
  for (const batch of a.batches) assert.ok(batch.length >= 1 && batch.length <= 100, `a batch of ${batch.length} entries`);
  const pages = a.batches.flat().map((e) => e.page);
  assert.equal(new Set(pages).size, pages.length, "each page is one entry");
  const staleTitles = new Set(a.stale.map((p) => p.title));
  assert.equal(pages.filter((p) => staleTitles.has(p)).length, a.appended, "the API appends a block to some stale projects");
  assert.ok(a.appended > 0);
  const depth = (b) => 1 + Math.max(0, ...(b.children ?? []).map(depth));
  const trees = a.batches.flat().flatMap((e) => e.blocks ?? []);
  assert.ok(Math.max(...trees.map(depth)) >= 40, "a decision 40 levels below its meeting");
  assert.equal(a.stale.length, SCALE.staleProjects);
  assert.ok(a.stale.every((p) => p.updated < now - 30 * 86_400_000), "every stale project is older than 30 days");
  // The expected rows: some of each kind are left out, the rest are rows.
  const e = a.expected;
  assert.equal(e["projects-untouched"].length, 40, "10 stale projects have a fresh block");
  assert.deepEqual(e["projects-untouched"].map((r) => r[0]), [...e["projects-untouched"].map((r) => r[0])].sort((x, y) => x - y), "oldest first");
  assert.equal(e["meetings-without-decision"].length, 100);
  assert.ok(e["meetings-without-decision"].some((t) => /page meeting/.test(t)), "a page tagged meeting is a row");
  assert.ok(e["meetings-without-decision"].some((t) => a.beside.includes(t)), "a meeting with a decision beside it, not under it, is a row");
  assert.ok(e["open-tasks-by-client"].total > 200, "more open-task rows than one page of 200");
  assert.equal(e["open-tasks-by-client"].rows.length, 200);
  assert.ok(e["open-tasks-by-client"].rows.some(([c]) => c === ""), "a task with no client is a row under the empty client");
  const sorted = [...e["open-tasks-by-client"].rows].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  assert.deepEqual(e["open-tasks-by-client"].rows.map((r) => r[0]), sorted.map((r) => r[0]), "by client title");
  assert.equal(e["pages-missing-property"].length, 100);
  assert.ok(new Set(a.batches.flat().filter((x) => x.properties?.Tags?.includes(SCALE.titles.topic)).map((x) => x.page)).size >= 2000, "a few thousand tagged pages");
});

test("the F1 queries are the three wide shapes over the fixture's width pages, each within the query length limit", async () => {
  const { f1Queries, scaleFixture } = await import(script);
  const qs = f1Queries();
  assert.deepEqual(qs.map((q) => q.blocks), [100, 200, 500]);
  assert.deepEqual(qs.map((q) => (q.query.match(/\[\((identity|clojure\.string\/includes\?) \?t/g) ?? []).length), [175, 99, 20]);
  const widthPages = scaleFixture(0).batches.flat().filter((e) => /^Release Width \d+$/.test(e.page));
  for (const q of qs) {
    assert.ok(q.query.length <= 4000, `${q.label}: ${q.query.length}`);
    const page = widthPages.find((p) => p.page === q.page);
    assert.ok(page, `${q.label}: the fixture has ${q.page}`);
    assert.equal(page.blocks.length, q.blocks);
    assert.ok(page.blocks.every((b) => b.title.includes("block")), "every block matches the includes? clause");
  }
});

test("captureConsole records error, warn, log and info while it runs and puts each back, even after a throw", async () => {
  const { captureConsole } = await import(script);
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  const { value, calls } = await captureConsole(async () => {
    console.error("e", 1);
    await new Promise((r) => setTimeout(r, 1));
    console.warn("w");
    console.log("l");
    console.info("i");
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(calls, [
    { level: "error", args: ["e", 1] },
    { level: "warn", args: ["w"] },
    { level: "log", args: ["l"] },
    { level: "info", args: ["i"] },
  ]);
  for (const k of Object.keys(original)) assert.equal(console[k], original[k], `console.${k} is put back`);
  await assert.rejects(captureConsole(() => { throw new Error("boom"); }), /boom/);
  for (const k of Object.keys(original)) assert.equal(console[k], original[k], `console.${k} is put back after a throw`);
});

test("assertRows compares the rows' cells, not their count", async () => {
  const { assertRows } = await import(script);
  assert.doesNotThrow(() => assertRows([["a"], ["b"]], [["a"], ["b"]]));
  assert.throws(() => assertRows([["a"], ["c"]], [["a"], ["b"]]), /rows \[\["a"\],\["c"\]\], expected \[\["a"\],\["b"\]\]/);
  assert.throws(() => assertRows([["b"], ["a"]], [["a"], ["b"]]), /expected/, "order counts");
});

// A stand-in for the SyncDO that answers every fetch with `status` and `body`, after `delay` ms,
// calling `log` first; the checks below only read the response, so each can be shown to fail.
const fakeStub = ({ status, body, delay = 0, log } = {}) => ({
  async fetch() {
    log?.();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return new Response(JSON.stringify(body), { status });
  },
});
const WIDTH_422 = { error: "query stopped after function bindings copied 100,000 values (the width cap): each function binding copies every column" };
const BINDINGS_422 = { error: "query has 176 function bindings, more than the 12 the width cap allows: each function binding copies every column" };
const SCAN_422 = { error: "query stopped after scanning 20,000 datoms (the scan cap); narrow it" };

test("each named query's check compares every row's cells, so the right count of wrong rows fails", async () => {
  const { NAMED_AT_SCALE, scaleFixture } = await import(script);
  const { expected } = scaleFixture(1_762_646_400_000);
  const entity = (title) => ({ "block/uuid": "00000000-0000-4000-8000-000000000001", "block/title": title });
  const bodies = {
    "projects-untouched": (rows) => ({ rows: rows.map(([t, title]) => [t, entity(title)]) }),
    "meetings-without-decision": (rows) => ({ rows: rows.map((title, i) => [1000 + i, entity(title)]) }),
    "open-tasks-by-client": ({ rows, total }) => ({ rows: rows.map(([c, title]) => [c, entity(title)]), "total-rows": total }),
    "pages-missing-property": (rows) => ({ rows: rows.map((title) => [entity(title)]) }),
  };
  const wrong = {
    "projects-untouched": (rows) => rows.map(([t, title], i) => [t, i === 3 ? `${title} (another)` : title]),
    "meetings-without-decision": (rows) => [...rows.slice(1), rows[0]],
    "open-tasks-by-client": ({ rows, total }) => ({ rows: rows.map(([c, title], i) => [i === 0 ? "Release Client Z" : c, title]), total }),
    "pages-missing-property": (rows) => rows.map((title, i) => (i === rows.length - 1 ? "Release topic 1" : title)),
  };
  for (const [query, { expect }] of Object.entries(NAMED_AT_SCALE)) {
    assert.doesNotThrow(() => expect(bodies[query](expected[query]), expected[query]), query);
    assert.throws(() => expect(bodies[query](wrong[query](expected[query])), expected[query]), /rows .*expected/, `${query}: same count, wrong rows`);
  }
  const tasks = expected["open-tasks-by-client"];
  assert.throws(() => NAMED_AT_SCALE["open-tasks-by-client"].expect(bodies["open-tasks-by-client"]({ ...tasks, total: tasks.total + 1 }), tasks), /total-rows/);
  const meetings = expected["meetings-without-decision"];
  const late = bodies["meetings-without-decision"](meetings);
  late.rows[0][0] = 99_999;
  assert.throws(() => NAMED_AT_SCALE["meetings-without-decision"].expect(late, meetings), /created-at is not oldest first/);
});

test("checkF1 passes a quick width-cap 422 and fails a 200, another cap's 422, or a slow 422", async () => {
  const { checkF1, F1_MS } = await import(script);
  assert.match(await checkF1(fakeStub({ status: 422, body: WIDTH_422 }), "[:find]"), /median \d+ ms/);
  assert.match(await checkF1(fakeStub({ status: 422, body: BINDINGS_422 }), "[:find]"), /median \d+ ms/);
  await assert.rejects(checkF1(fakeStub({ status: 422, body: { error: "query has 13 function calls (the call cap)" } }), "[:find]"), /HTTP 422/);
  await assert.rejects(checkF1(fakeStub({ status: 200, body: { rows: [[100]] } }), "[:find]"), /HTTP 200/);
  await assert.rejects(checkF1(fakeStub({ status: 422, body: SCAN_422 }), "[:find]"), /HTTP 422: .*scan cap/);
  await assert.rejects(checkF1(fakeStub({ status: 422, body: WIDTH_422, delay: F1_MS + 20 }), "[:find]"), /expected under 100 ms/);
});

test("checkScanCapQuiet passes a silent scan-cap 422 and fails one that logs, at any level, or another answer", async () => {
  const { checkScanCapQuiet } = await import(script);
  await checkScanCapQuiet(fakeStub({ status: 422, body: SCAN_422 }));
  for (const level of ["error", "warn", "log", "info"]) {
    await assert.rejects(
      checkScanCapQuiet(fakeStub({ status: 422, body: SCAN_422, log: () => console[level]("sentry stub:", "query stopped") })),
      new RegExp(`the refusal logged 1 time\\(s\\): console\\.${level}\\(sentry stub: query stopped\\)`),
    );
  }
  await assert.rejects(checkScanCapQuiet(fakeStub({ status: 200, body: { rows: [] } })), /expected the scan-cap 422, got HTTP 200/);
});

// Query blocks (patch 0050, spec 2026-11-20 §8 *Release bundle*)
// =============================================================

test("the Query-block fixture is the spec's Book fence and the same map as a query field", async () => {
  const { BOOK_QUERY, BOOK_FENCE, queryBlockNodes, QUERY_REFUSALS } = await import(script);
  assert.equal(BOOK_QUERY, '{:query [:find (pull ?b [*]) :where [?b :block/tags ?t] [?t :block/title "Book"]]}');
  assert.equal(BOOK_FENCE, "```query\n" + BOOK_QUERY + "\n```");
  const nodes = queryBlockNodes();
  assert.deepEqual(nodes.map((n) => n.from), ["fence", "field"]);
  assert.deepEqual(nodes[0].node, { uuid: nodes[0].node.uuid, title: BOOK_FENCE });
  assert.deepEqual(nodes[1].node, { uuid: nodes[1].node.uuid, title: "Release Query Caption", query: BOOK_QUERY });
  assert.deepEqual(nodes.map((n) => n.caption), ["", "Release Query Caption"]);
  assert.notEqual(nodes[0].node.uuid, nodes[1].node.uuid);
  // The class of refusal the release bundle must keep: rules given as a key, and a rule called in :where.
  assert.deepEqual(QUERY_REFUSALS.map((r) => r.label), [":rules", "a rule call"]);
  assert.match(QUERY_REFUSALS[0].query, /:rules \[\[/);
  assert.match(QUERY_REFUSALS[0].reason, /^query: :rules is not accepted; datalog_query takes no rules/);
  assert.match(QUERY_REFUSALS[1].reason, /^query: where \d+: \(task …\) calls a rule; datalog_query takes no rules/);
});

// What the release bundle stores for the spec's Book query, as queryBlockReadBack returns it.
const goodBlock = (caption = "") => ({
  tags: ["logseq.class/Query"],
  caption,
  text: '{:query [:find (pull ?b [*]) :where [?b :block/tags ?t] [?t :block/title "Book"]]}',
  displayType: "code",
  lang: "clojure",
  marker: true,
  valueMarker: false,
});

test("queryBlockReadBackErrors passes a stored Query block and names each gap: tag, caption, text, :code, clojure, the marker and a marker on the value block", async () => {
  const { queryBlockReadBackErrors, BOOK_QUERY } = await import(script);
  const want = { caption: "", text: BOOK_QUERY };
  assert.deepEqual(queryBlockReadBackErrors(goodBlock(), want), []);
  assert.deepEqual(queryBlockReadBackErrors({ ...goodBlock(), tags: ["logseq.class/Query", "user.class/Other"] }, want), [], "another tag beside Query is allowed");
  const cases = [
    [{ tags: [] }, /tags \[\] lack logseq\.class\/Query/],
    [{ caption: "x" }, /caption "x", expected ""/],
    [{ text: "{:query [:find ?b]}" }, /query text "\{:query \[:find \?b\]\}", expected/],
    [{ text: null }, /query text null/],
    [{ displayType: "none" }, /display type "none", expected "code"/],
    [{ lang: "" }, /lang "", expected "clojure"/],
    [{ marker: false }, /claudeQueryBlock false on the Query block, expected true/],
    [{ valueMarker: true }, /claudeQueryBlock true on the value block, expected none/],
  ];
  for (const [change, error] of cases) {
    const errors = queryBlockReadBackErrors({ ...goodBlock(), ...change }, want);
    assert.equal(errors.length, 1, `${JSON.stringify(change)}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], error);
  }
  assert.deepEqual(queryBlockReadBackErrors(undefined, want), ["no Query block read back (no logseq.property/query value block)"]);
});

test("queryRefusalError passes a 400 naming the node and the reason with nothing stored, and fails another status, another reason, a bare 400 or a stored block", async () => {
  const { queryRefusalError } = await import(script);
  const reason = "query: :rules is not accepted; datalog_query takes no rules, because …";
  const want = { path: "blocks[0]", reason };
  const res = (status, body) => ({ status, json: body, text: JSON.stringify(body) });
  assert.equal(queryRefusalError(res(400, { error: `blocks[0]: ${reason}` }), want, { stored: false }), null);
  assert.match(queryRefusalError(res(201, { blocks: [] }), want, { stored: false }), /HTTP 201/);
  assert.match(queryRefusalError(res(500, { error: `blocks[0]: ${reason}` }), want, { stored: false }), /HTTP 500/);
  assert.match(queryRefusalError(res(400, { error: "blocks[0]: query: at most 4,000 characters (got 4,001)" }), want, { stored: false }), /error "blocks\[0\]: query: at most/);
  assert.match(queryRefusalError(res(400, {}), want, { stored: false }), /error undefined/, "a 400 with no reason fails");
  assert.match(queryRefusalError(res(400, { error: `blocks[1]: ${reason}` }), want, { stored: false }), /expected "blocks\[0\]: query: :rules/, "the wrong node fails");
  assert.match(queryRefusalError(res(400, { error: `blocks[0]: ${reason}` }), want, { stored: true }), /the refused block was stored/);
});

// A stand-in SyncDO for the Query-block checks: an insert answers 201 echoing each node (converted
// "query" for a fence) unless a node's query has :rules or calls (task …), which answers 400 naming
// it; a block read answers `read` (404 by default). `log` runs on every request.
const queryStub = ({ read = 404, log } = {}) => ({
  async fetch(request) {
    log?.();
    const url = new URL(request.url);
    if (request.method === "GET") return new Response(JSON.stringify({ uuid: url.pathname.split("/").pop() }), { status: read });
    const { blocks } = await request.json();
    const bad = blocks.findIndex((b) => /:rules|\(task /.test(b.query ?? ""));
    if (bad >= 0) {
      const reason = /:rules/.test(blocks[bad].query)
        ? "query: :rules is not accepted; datalog_query takes no rules, because a tree of rules expands without reading data and can run for seconds before any cap stops it; …"
        : "query: where 2: (task …) calls a rule; datalog_query takes no rules, because a tree of rules expands without reading data and can run for seconds before any cap stops it; …";
      return new Response(JSON.stringify({ error: `blocks[${bad}]: ${reason}` }), { status: 400 });
    }
    const echo = blocks.map((b) => {
      const fence = b.title.startsWith("```query\n");
      return { uuid: b.uuid, title: fence ? "" : b.title, query: b.query ?? b.title.slice(9, -4), ...(fence ? { converted: "query" } : {}) };
    });
    return new Response(JSON.stringify({ blocks: echo }), { status: 201 });
  },
});
const queryCheck = async (name, stub) => {
  const { checks } = await import(script);
  const found = checks({ stub, pageUuid: "00000000-0000-4000-8000-0000000000aa" }).find(([n]) => n.startsWith(name));
  assert.ok(found, name);
  return found[1];
};

test("the Query-block insert check fails when the insert logs to the console, or answers without converted on the fence", async () => {
  const insert = "Query blocks: the Book fence and a query field insert";
  await (await queryCheck(insert, queryStub()))();
  for (const level of ["error", "warn", "log", "info"]) {
    await assert.rejects((await queryCheck(insert, queryStub({ log: () => console[level]("sentry stub:", "boom") })))(), new RegExp(`the insert logged \\d+ time\\(s\\): console\\.${level}\\(sentry stub: boom\\)`));
  }
  const noConvert = queryStub();
  const fetch = noConvert.fetch;
  noConvert.fetch = async (req) => {
    const res = await fetch(req);
    const body = await res.json();
    for (const b of body.blocks) delete b.converted;
    return new Response(JSON.stringify(body), { status: res.status });
  };
  await assert.rejects((await queryCheck(insert, noConvert))(), /blocks\[0\] \(fence\): converted undefined, expected "query"/);
});

test("the Query-block refusal check fails when a refused call stored a block, or logged", async () => {
  const refusal = "Query blocks: a :rules query and a rule call are refused";
  await (await queryCheck(refusal, queryStub()))();
  await assert.rejects((await queryCheck(refusal, queryStub({ read: 200 })))(), /:rules: the refused block was stored/);
  await assert.rejects((await queryCheck(refusal, queryStub({ log: () => console.error("x") })))(), /:rules: the refusal logged 1 time\(s\)/);
});

// Graph insights (patches 0051 to 0053, plan 2026-11-22 Stage 6)
// =============================================================

// What the release bundle answers for the insights fixture, as the checks read it.
const INS = {
  tagUuid: "00000000-0000-4000-8000-0000000000b1",
  propertyIdent: "user.property/release-insight-author-Ab12",
  page: "00000000-0000-4000-8000-0000000000b2",
  broken: "00000000-0000-4000-8000-0000000000b3",
  bare: "00000000-0000-4000-8000-0000000000b4",
  authored: "00000000-0000-4000-8000-0000000000b5",
  ghost: "00000000-0000-4000-8000-0000000000b6",
  since: 1_763_000_000_000,
};
const ALL_CHECKS = [
  "orphan-tags",
  "orphan-properties",
  "duplicate-titles",
  "pages-without-summary",
  "pages-without-tags",
  "mismatched-choice-values",
  "orphan-choices",
  "broken-refs",
  "missing-tag-properties",
];
const goodHealth = (from, checks = ["broken-refs", "missing-tag-properties"]) => {
  const out = {};
  for (const c of checks) out[c] = { count: 0, items: [] };
  out["broken-refs"] = {
    count: 1,
    items: [{ uuid: INS.broken, kind: "block", title: `Release insight broken [[${INS.ghost}]]`, "page-id": INS.page, "page-title": "Release Insight Page", "target-uuid": INS.ghost, reason: "missing" }],
  };
  out["missing-tag-properties"] = {
    count: 1,
    items: [{ uuid: INS.bare, kind: "block", title: "Release insight bare book", "page-id": INS.page, tag: { uuid: INS.tagUuid, title: "Release Insight Book" }, missing: [{ ident: INS.propertyIdent, title: "release-insight-author" }] }],
    pairs: [{ tag: { uuid: INS.tagUuid, title: "Release Insight Book" }, property: { ident: INS.propertyIdent, title: "release-insight-author" } }],
    "pairs-from": from,
  };
  return { checks: out };
};

test("the insights fixture's names, the nine health checks and the env deploy would give the Worker", async () => {
  const { INSIGHT, HEALTH_CHECKS, insightEnv } = await import(script);
  assert.deepEqual(INSIGHT, { tag: "Release Insight Book", property: "release-insight-author", page: "Release Insight Page" });
  assert.deepEqual(HEALTH_CHECKS, ALL_CHECKS);
  const env = insightEnv();
  assert.deepEqual(JSON.parse(env.HEALTH_TAG_PROPERTIES), [{ tag: "Release Insight Book", property: "release-insight-author" }]);
  assert.equal(env.TIMEZONE, "UTC");
});

test("healthInsightErrors passes the broken ref and the bare book, and names each gap", async () => {
  const { healthInsightErrors } = await import(script);
  assert.deepEqual(healthInsightErrors(goodHealth("input"), INS, { from: "input", checks: ["broken-refs", "missing-tag-properties"] }), []);
  assert.deepEqual(healthInsightErrors(goodHealth("settings", ALL_CHECKS), INS, { from: "settings", checks: ALL_CHECKS }), []);
  assert.deepEqual(healthInsightErrors(goodHealth("settings", [...ALL_CHECKS].reverse()), INS, { from: "settings", checks: ALL_CHECKS }), [], "a map's keys come in any order");
  const mutate = (f) => {
    const b = goodHealth("input");
    f(b.checks);
    return healthInsightErrors(b, INS, { from: "input", checks: ["broken-refs", "missing-tag-properties"] });
  };
  const cases = [
    [(c) => delete c["broken-refs"], /checks are \["missing-tag-properties"\], expected \["broken-refs","missing-tag-properties"\]/],
    [(c) => (c.extra = { count: 0, items: [] }), /checks are .*"extra"/],
    [(c) => (c["orphan-tags"] = { count: 0, items: [] }), /checks are \["broken-refs","missing-tag-properties","orphan-tags"\]/],
    [(c) => (c["broken-refs"].items[0].reason = "in-recycle-bin"), /broken-refs: no item for .*b3 -> .*b6 \(missing\)/],
    [(c) => (c["broken-refs"].items[0]["target-uuid"] = INS.bare), /broken-refs: no item for/],
    [(c) => (c["broken-refs"].count = 2), /broken-refs: count 2 with 1 items/],
    [(c) => (c["missing-tag-properties"].items[0].uuid = INS.authored), /missing-tag-properties: items .*b5.*, expected only .*b4/],
    [(c) => (c["missing-tag-properties"].items[0].missing = []), /missing-tag-properties: .*b4 misses \[\], expected \["release-insight-author"\]/],
    [(c) => (c["missing-tag-properties"].items[0].tag.title = "Other"), /missing-tag-properties: .*b4 under tag "Other"/],
    [(c) => (c["missing-tag-properties"]["pairs-from"] = "none"), /pairs-from "none", expected "input"/],
    [(c) => (c["missing-tag-properties"].pairs = []), /pairs \[\], expected one pair/],
    [(c) => (c["missing-tag-properties"].count = 0), /missing-tag-properties: count 0 with 1 items/],
  ];
  for (const [f, error] of cases) {
    const errors = mutate(f);
    assert.ok(errors.length >= 1, `${f}: no error`);
    assert.match(errors.join("; "), error, String(f));
  }
  assert.match(healthInsightErrors(undefined, INS, { from: "input", checks: ALL_CHECKS }).join(), /no checks in the answer/);
});

const goodChanges = () => ({
  since: INS.since,
  until: INS.since + 600_000,
  "time-zone": "UTC",
  pages: [
    {
      page: { uuid: INS.page, title: "Release Insight Page", kind: "page" },
      "latest-updated-at": INS.since + 500,
      "page-changed": true,
      created: 3,
      updated: 0,
      blocks: [INS.authored, INS.bare, INS.broken].map((uuid, i) => ({ uuid, change: "created", "updated-at": INS.since + 500 - i, snippet: "x" })),
    },
  ],
  recycled: 0,
  "next-cursor": null,
});

test("changesInsightErrors passes the page with its three new blocks from an ISO local since, and names each gap", async () => {
  const { changesInsightErrors } = await import(script);
  assert.deepEqual(changesInsightErrors(goodChanges(), INS), []);
  const cases = [
    [(b) => (b.since = INS.since + 60_000), /since \d+, expected 1763000000000 \(the ISO local time in UTC\)/],
    [(b) => (b["time-zone"] = "Pacific/Auckland"), /time-zone "Pacific\/Auckland", expected "UTC"/],
    [(b) => delete b["next-cursor"], /next-cursor undefined, expected null on the last page/],
    [(b) => (b.pages = []), /no page .*b2 among \[\]/],
    [(b) => (b.pages[0].created = 2), /created 2, expected 3/],
    [(b) => (b.pages[0].blocks = b.pages[0].blocks.slice(1)), /blocks \[.*\], expected .*b3.*b4.*b5/],
    [(b) => (b.pages[0].blocks[0].change = "updated"), /change "updated" for .*b5, expected "created"/],
    [(b) => (b.recycled = "0"), /recycled "0", expected a count/],
  ];
  for (const [f, error] of cases) {
    const b = goodChanges();
    f(b);
    assert.match(changesInsightErrors(b, INS).join("; "), error, String(f));
  }
});

const goodSchema = () => ({
  tags: {
    count: 2,
    items: [
      { uuid: INS.tagUuid, title: "Release Insight Book", extends: [], properties: [{ uuid: "p", ident: INS.propertyIdent, title: "release-insight-author" }], "object-count": 2 },
      { uuid: "t", title: "Release Check Tag", extends: [], properties: [], "object-count": 0 },
    ],
  },
  properties: {
    count: 1,
    items: [{ uuid: "p", ident: INS.propertyIdent, title: "release-insight-author", type: "default", cardinality: "one", choices: [], "value-count": 1, "used-by-tags": [{ uuid: INS.tagUuid, title: "Release Insight Book" }] }],
  },
});

test("schemaInsightErrors passes the tag with its property and two objects and the property with one value, and names each gap", async () => {
  const { schemaInsightErrors } = await import(script);
  assert.deepEqual(schemaInsightErrors(goodSchema(), INS), []);
  const cases = [
    [(b) => delete b.properties, /properties: no section/],
    [(b) => (b.tags.items = b.tags.items.slice(1)), /tags: no item titled "Release Insight Book"/],
    [(b) => (b.tags.items[0]["object-count"] = 3), /object-count 3, expected 2/],
    [(b) => (b.tags.items[0].properties = []), /tag properties \[\], expected \["release-insight-author"\]/],
    [(b) => (b.properties.items[0]["value-count"] = 0), /value-count 0, expected 1/],
    [(b) => (b.properties.items[0]["used-by-tags"] = []), /used-by-tags \[\], expected \["Release Insight Book"\]/],
    [(b) => (b.properties.items[0].type = undefined), /type undefined, expected "default"/],
    [(b) => (b.tags.count = "2"), /tags: count "2"/],
  ];
  for (const [f, error] of cases) {
    const b = goodSchema();
    f(b);
    assert.match(schemaInsightErrors(b, INS).join("; "), error, String(f));
  }
});

test("isoLocalMinute writes a UTC minute with no offset, a minute before the time given, and its epoch ms", async () => {
  const { isoLocalMinute } = await import(script);
  assert.deepEqual(isoLocalMinute(Date.UTC(2026, 10, 22, 9, 30, 45, 123)), { iso: "2026-11-22T09:29", ms: Date.UTC(2026, 10, 22, 9, 29) });
  assert.deepEqual(isoLocalMinute(Date.UTC(2026, 0, 1, 0, 0, 5)), { iso: "2025-12-31T23:59", ms: Date.UTC(2025, 11, 31, 23, 59) });
});

test("exits 2 naming the missing bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "rqc-test-"));
  try {
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /release bundle missing: .*main\.js.*scripts\/build\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the release bundle returns the values data patterns bind, in datalog_query and run_named_query, answers a decision 180 levels down, at scale answers every named query and stops every F1 shape in time without logging a scan-cap refusal, makes, reads back and refuses Query blocks, and answers the health, change-feed and schema reads", { skip, timeout: 600_000 }, () => {
  const before = leftovers();
  const r = spawnSync(process.execPath, [script, upstream], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of [
    "a value bound by a data pattern comes back (title)",
    "a uuid bound by a data pattern comes back",
    "a function takes the bound value (clojure.string/includes?)",
    "a join through a datom value matches (tag by title)",
    "run_named_query pages-missing-property returns the tag page",
    "run_named_query meetings-without-decision leaves out a meeting with a decision 10 levels down",
    "run_named_query meetings-without-decision leaves out a meeting with a decision 180 levels down, quickly",
    "seed about 20,000 blocks through SyncDO.fetch",
    "at scale: run_named_query projects-untouched answers its exact rows within 300 ms",
    "at scale: run_named_query meetings-without-decision answers its exact rows within 300 ms",
    "at scale: run_named_query open-tasks-by-client answers its exact rows within 300 ms",
    "at scale: run_named_query pages-missing-property answers its exact rows within 300 ms",
    "at scale: F1 175 identity clauses over 100 blocks answers the width-cap 422 within 100 ms",
    "at scale: F1 99 identity clauses over 200 blocks answers the width-cap 422 within 100 ms",
    "at scale: F1 20 bound includes? over 500 blocks answers the width-cap 422 within 100 ms",
    "at scale: a datalog_query scan-cap 422 logs nothing to the console",
    "Query blocks: the Book fence and a query field insert through the release bundle, logging nothing",
    "Query blocks: both read back with the Query tag, the query text, :code, clojure and the marker",
    "Query blocks: a :rules query and a rule call are refused naming the node, store nothing and log nothing",
    "graph insights: seed a tag with an expected property, two tagged blocks and a broken ref through SyncDO.fetch",
    "graph insights: checks=broken-refs,missing-tag-properties with tag-properties answers the broken ref and the bare book",
    "graph insights: the default health call runs every check, with the stored HEALTH_TAG_PROPERTIES pairs",
    "graph insights: list_changes_since from an ISO local time lists the page's three new blocks",
    "graph insights: get_graph_schema lists the tag with its property and objects, and the property with its value",
  ]) {
    assert.match(r.stdout, new RegExp(`^ok +${name.replace(/[()?/]/g, "\\$&")}$`, "m"));
  }
  assert.deepEqual(leftovers(), before, "the temporary copy is removed");
});

// The defect this guards against: advanced compilation without Datascript's externs renamed the
// Datom field v consistently in compiled code, but Datascript's query engine also reads a datom's
// fields by string (tuple["v"] in lookup-pattern-db), which then read undefined. Renaming every .v
// property access in the fixed bundle brings that back (74 accesses at 7d04944) and reproduces the
// same failures the unfixed bundle gave in datalog_query (run_named_query's checks failed too until
// the named queries ran as code).
test("fails, naming each check, on a bundle whose Datom field v is renamed", { skip, timeout: 600_000 }, () => {
  const source = readFileSync(bundle, "utf8");
  assert.match(source, /case "v":return \w+\.v\b/, "the bundle keeps the Datom field v (externs applied)");
  const dir = mkdtempSync(join(tmpdir(), "rqc-test-"));
  try {
    const broken = join(dir, "main.js");
    writeFileSync(broken, source.replace(/(?<=[\w$)\]])\.v(?![\w$])/g, ".renamed_v"));
    const r = spawnSync(process.execPath, [script, upstream, "--bundle", broken], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAILED a value bound by a data pattern comes back \(title\): rows \[\[null\]\]/m);
    assert.match(r.stdout, /^FAILED a uuid bound by a data pattern comes back: rows \[\[null\]\]/m);
    assert.match(r.stdout, /^FAILED a function takes the bound value .*HTTP 400/m);
    assert.match(r.stdout, /^FAILED a join through a datom value matches \(tag by title\): rows \[\]/m);
    // run_named_query walks the indexes as code and reads a datom's fields through its own lookup,
    // never by string, so the renamed field leaves its checks passing.
    assert.match(r.stdout, /^ok +run_named_query pages-missing-property returns the tag page$/m);
    assert.match(r.stdout, /^ok +run_named_query meetings-without-decision leaves out a meeting with a decision 180 levels down, quickly$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
