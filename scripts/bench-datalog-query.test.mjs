import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "bench-datalog-query.mjs");

// The bench loads upstream db-sync's compiled test build from .upstream (the handler and the
// Datascript it runs on). Without that build it cannot run, so these tests say so and skip.
const build = join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker-test.js");
const skip = existsSync(build)
  ? false
  : ".upstream/deps/db-sync/worker/dist/worker-test.js missing: compile upstream's test build with scripts/upstream-test.sh .upstream (scripts/build.sh alone removes it)";

const SHAPES = [
  "private-set",
  "scan-cap",
  "or-join-wide",
  "not-join-fanout",
  "join-fanout",
  "pull-star-200",
];

test("the seeded fixture is identical for the same size and differs for another seed", async () => {
  const { makeFixture } = await import(script);
  const a = makeFixture(300);
  assert.deepEqual(makeFixture(300), a);
  assert.notDeepEqual(makeFixture(300, 2), a);
  assert.equal(a.pages.length, 300);
  for (const page of a.pages) {
    assert.match(page.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(typeof page.title, "string");
    assert.ok(Array.isArray(page.blocks));
  }
  // Every shape needs its fixture: private pages for the private set, tagged pages for the pull,
  // refs for the not-join, and a deep chain of blocks for the self-join on its tag.
  assert.ok(a.pages.some((p) => p.tags.includes("Private")), "some pages are private");
  assert.ok(a.pages.some((p) => p.tags.includes("Bench Project")), "some pages are projects");
  assert.ok(a.pages.some((p) => p.blocks.some((b) => b.refs.length > 0)), "some blocks ref pages");
  assert.ok(a.chain.length >= 50, "a chain at least 50 blocks deep");
  const titles = new Set(a.pages.map((p) => p.title.toLowerCase()));
  assert.equal(titles.size, a.pages.length, "page titles are unique");
});

test("--json gives one record per shape and size with cold_ms, warm_ms, datoms_scanned and outcome", { skip }, async () => {
  const run = spawnSync(process.execPath, [script, "--pages", "150,300", "--runs", "2", "--scan-cap", "3000", "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  const { SHAPES: exported } = await import(script);
  assert.deepEqual(exported, SHAPES);

  assert.equal(out.scan_cap, 3000);
  assert.equal(out.runs, 2);
  assert.equal(out.records.length, SHAPES.length * 2);
  for (const pages of [150, 300]) {
    const shapes = out.records.filter((r) => r.pages === pages).map((r) => r.shape);
    assert.deepEqual(shapes, SHAPES, `one record per shape at ${pages} pages`);
  }
  for (const r of out.records) {
    const where = `${r.shape} at ${r.pages}`;
    for (const k of ["cold_ms", "warm_ms"]) {
      assert.equal(typeof r[k], "number", `${where}: ${k}`);
      assert.ok(r[k] >= 0, `${where}: ${k}`);
    }
    assert.ok(Number.isInteger(r.datoms_scanned), `${where}: datoms_scanned`);
    assert.ok(["rows", "scan-cap", "join-cap", "value-cap", "row-cap", "refused"].includes(r.outcome), `${where}: outcome ${r.outcome}`);
    // The filter throws on the datom after the cap, so no run counts more than cap + 1.
    assert.ok(r.datoms_scanned <= 3001, `${where}: scanned ${r.datoms_scanned}`);
  }
  const at = (shape, pages) => out.records.find((r) => r.shape === shape && r.pages === pages);
  // An unconstrained [?e ?a ?v] reads every datom, so it stops at the cap.
  assert.equal(at("scan-cap", 300).outcome, "scan-cap");
  assert.equal(at("scan-cap", 300).datoms_scanned, 3001);
  // The private set is built on the unfiltered db: no datom goes through the filter.
  assert.equal(at("private-set", 300).datoms_scanned, 0);
  assert.ok(at("private-set", 300).rows > 0, "the fixture's private pages are found");
  // The pull returns rows on the tagged pages and is cut to limit 200 only when there are more.
  assert.equal(at("pull-star-200", 150).outcome, "rows");
  assert.ok(at("pull-star-200", 150).rows <= 200);
  // Work the scan cap does not count: a self-join on the chain's tag matches far more rows than
  // the datoms it reads, which the row cap (2,500) refuses before the sort (each refusal kind is
  // named by its own outcome, never reported as the scan cap). datalog_query takes no rules (patch
  // 0039 stage 3), so the bench has no rule shapes.
  assert.ok(!SHAPES.some((s) => s.startsWith("rule-")), "no rule shapes");
  assert.equal(at("join-fanout", 300).outcome, "row-cap");
  assert.match(at("join-fanout", 300).error, /^query matched 3,600 rows, more than the row cap of 2,500;/, "60 × 60 rows");
  assert.ok(at("join-fanout", 300).datoms_scanned < 3600, "rows outgrow the datoms read");
});

test("each shape's cold run starts from a freshly restored conn, whatever ran before it", { skip }, () => {
  const run = (shapes) => {
    const r = spawnSync(process.execPath, [script, "--pages", "150", "--runs", "1", "--json", ...shapes], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).records;
  };
  const all = run([]);
  const alone = run(["--shapes", "pull-star-200"]);
  assert.deepEqual(alone.map((r) => r.shape), ["pull-star-200"]);
  const inAll = all.find((r) => r.shape === "pull-star-200");
  assert.ok(alone[0].nodes_loaded_cold > 0, "the cold run loads nodes from storage");
  assert.equal(inAll.nodes_loaded_cold, alone[0].nodes_loaded_cold, "no node was loaded by an earlier shape");
});

test("an unknown --shapes name is refused naming the shapes", () => {
  const run = spawnSync(process.execPath, [script, "--shapes", "nope"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--shapes: unknown shape nope \(shapes: private-set, scan-cap,/);
});

test("text output prints a table naming every shape and both sizes", { skip }, () => {
  const run = spawnSync(process.execPath, [script, "--pages", "150", "--runs", "1"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const shape of SHAPES) assert.match(run.stdout, new RegExp(`${shape}\\s+150\\s`));
  assert.match(run.stdout, /scan cap 20,000/, "the cap is read from the build");
});

test("skips with a reason naming the missing build when .upstream's db-sync output is absent", () => {
  const empty = mkdtempSync(join(tmpdir(), "bench-datalog-empty-"));
  try {
    const run = spawnSync(process.execPath, [script, "--upstream", empty, "--pages", "150", "--json"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.match(out.skipped, /deps\/db-sync\/worker\/dist\/worker-test\.js/);
    assert.match(out.skipped, /scripts\/upstream-test\.sh/);
    const text = spawnSync(process.execPath, [script, "--upstream", empty], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^skipped: .*worker-test\.js/m);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a bad --pages is refused with the flag named", () => {
  const run = spawnSync(process.execPath, [script, "--pages", "zero"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--pages/);
});

// Named-query and width modes (named queries as code, stage 5)
// =============================================================

const NAMED = ["projects-untouched", "meetings-without-decision", "open-tasks-by-client", "pages-missing-property"];
const NAMED_BOUNDS = {
  "projects-untouched": ["tagged", "page-blocks", "reads"],
  "meetings-without-decision": ["meetings", "decisions", "ancestor-steps", "reads"],
  "open-tasks-by-client": ["tasks", "open-tasks", "reads"],
  "pages-missing-property": ["tagged", "reads"],
};
/** open-tasks-by-client with params.client at the cap (patch 0054), after the full runs at each size. */
const CLIENT_RUNS = ["client-page", "client-tasks"];
const WIDTH = ["f1-identity-175", "f1-identity-99", "f1-includes-20", "three-bindings"];

test("the fixture carries meetings, decisions under them, tasks with statuses and, when asked, the width pages, the same on every run", async () => {
  const { makeFixture, WIDTH_SHAPES } = await import(script);
  const a = makeFixture(300);
  const blocks = a.pages.flatMap((p) => p.blocks);
  const meetings = blocks.filter((b) => b.tags.includes("Bench Meeting"));
  assert.ok(meetings.length >= 10, `meetings: ${meetings.length}`);
  assert.ok(meetings.some((m) => m.children.some((c) => c.tags.includes("Bench Decision"))), "a meeting with a decision below it");
  assert.ok(meetings.some((m) => !m.children.some((c) => c.tags.includes("Bench Decision"))), "a meeting with none");
  const statuses = new Set(blocks.filter((b) => b.task).map((b) => b.task));
  assert.deepEqual([...statuses].sort(), ["canceled", "doing", "done", "todo"]);
  assert.deepEqual(a.width, [], "no width pages unless asked");
  assert.ok(a.tags.some((t) => t.title === "Bench Meeting") && a.tags.some((t) => t.title === "Bench Decision"));
  // The named-query extras come from their own stream, so the shapes' fixture is what it was.
  const before = makeFixture(300);
  for (const p of before.pages) for (const b of p.blocks) delete b.task;
  assert.deepEqual(a.chain, before.chain);
  assert.deepEqual(a.pages.map((p) => [p.uuid, p.title, p.tags]), before.pages.map((p) => [p.uuid, p.title, p.tags]));

  const w = makeFixture(300, 1, { width: true });
  assert.deepEqual(w.width.map((p) => p.blocks.length), WIDTH_SHAPES.map((s) => s.blocks));
  assert.deepEqual(makeFixture(300, 1, { width: true }), w);
  assert.deepEqual(w.pages, a.pages, "the width pages leave the rest of the fixture alone");
});

test("the width shapes are the F1 shapes and the 3-binding query, each a count over one page's blocks", async () => {
  const { WIDTH_SHAPES, widthQuery } = await import(script);
  assert.deepEqual(WIDTH_SHAPES.map((s) => s.shape), WIDTH);
  assert.deepEqual(WIDTH_SHAPES.map((s) => s.blocks), [100, 200, 500, 2500]);
  const count = (q, re) => (q.match(re) ?? []).length;
  const [i175, i99, inc20, three] = WIDTH_SHAPES.map((s) => widthQuery(s, `Page ${s.blocks}`));
  assert.equal(count(i175, /\[\(identity \?t\) \?r\d+\]/g), 175);
  assert.equal(count(i99, /\[\(identity \?t\) \?r\d+\]/g), 99);
  assert.equal(count(inc20, /\[\(clojure\.string\/includes\? \?t "block"\) \?b\d+\]/g), 20);
  assert.equal(count(three, /\[\((identity|clojure\.string\/lower-case|get-else) /g), 3, "the title's get-else and two more");
  for (const q of [i175, i99, inc20, three]) {
    assert.ok(q.length <= 4000, `${q.length} characters, within the query length limit`);
    // The page by :block/name (indexed) and each title with get-else, so nothing scans every title.
    assert.match(q, /^\[:find \(count \?e\) \. :where \[\?p :block\/name "page \d+"\] \[\?e :block\/page \?p\] \[\(get-else \$ \?e :block\/title ""\) \?t\] /);
  }
});

test("--named --json gives one record per named query and size, with work for each of its bounds and ms cold and warm", { skip, timeout: 300_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--named", "--pages", "150,300", "--runs", "2", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.mode, "named");
  assert.equal(out.runs, 2);
  assert.deepEqual(Object.keys(out.bounds).sort(), ["ancestor-steps", "decisions", "items", "meetings", "open-tasks", "page-blocks", "reads", "tagged", "tasks"]);
  assert.equal(out.records.length, (NAMED.length + CLIENT_RUNS.length) * 2);
  for (const pages of [150, 300]) {
    const at = out.records.filter((r) => r.pages === pages);
    assert.deepEqual(at.map((r) => r.query), [...NAMED, "open-tasks-by-client", "open-tasks-by-client"]);
    assert.deepEqual(at.map((r) => r.run), [...NAMED.map(() => "full"), ...CLIENT_RUNS]);
  }
  for (const r of out.records.filter((x) => x.run === "full")) {
    const where = `${r.query} at ${r.pages}`;
    for (const k of ["cold_ms", "warm_ms"]) assert.ok(typeof r[k] === "number" && r[k] >= 0, `${where}: ${k}`);
    assert.equal(r.outcome, "rows", `${where}: ${r.error}`);
    assert.ok(Number.isInteger(r.rows) && r.rows > 0, `${where}: rows ${r.rows}`);
    assert.deepEqual(Object.keys(r.work).sort(), [...NAMED_BOUNDS[r.query]].sort(), `${where}: work names its bounds`);
    for (const [bound, n] of Object.entries(r.work)) assert.ok(Number.isInteger(n) && n > 0, `${where}: ${bound} ${n}`);
  }
  const at = (q, pages) => out.records.find((r) => r.query === q && r.pages === pages);
  // Every Bench Project page is older than 30 days, so the walk reads all of their blocks.
  assert.ok(at("projects-untouched", 300).work["page-blocks"] > at("projects-untouched", 150).work["page-blocks"]);
  assert.ok(at("meetings-without-decision", 300).work["ancestor-steps"] > 0);
});

// Patch 0054: open-tasks-by-client with params.client, at the cap
// ===============================================================


test("the client fixture is a page of more than 10,000 blocks holding one client and more than 2,000 open tasks holding another, the same on every run, leaving the rest alone", async () => {
  const { makeFixture, CLIENT_RUNS: exported, CLIENT_PAGE_BLOCKS, CLIENT_TASKS } = await import(script);
  assert.deepEqual(exported, CLIENT_RUNS);
  assert.ok(CLIENT_PAGE_BLOCKS > 10_000, `${CLIENT_PAGE_BLOCKS} blocks: past the tasks bound`);
  assert.ok(CLIENT_TASKS > 2_000, `${CLIENT_TASKS} tasks: past the open-tasks bound`);
  const a = makeFixture(300, 1, { clients: true });
  assert.deepEqual(makeFixture(300, 1, { clients: true }), a);
  assert.deepEqual(makeFixture(300).clients, [], "no client pages unless asked");
  const plain = makeFixture(300);
  assert.deepEqual(a.pages, plain.pages, "the client pages leave the rest of the fixture alone");
  assert.deepEqual(a.chain, plain.chain);
  assert.deepEqual(a.tags, plain.tags);
  assert.deepEqual(a.clients.map((c) => c.run), CLIENT_RUNS);
  const uuids = new Set([...a.pages.map((p) => p.uuid), ...a.clients.flatMap((c) => [c.client.uuid, ...c.pages.map((p) => p.uuid)])]);
  assert.equal(uuids.size, a.pages.length + a.clients.reduce((n, c) => n + 1 + c.pages.length, 0), "no uuid repeats");

  const [onPage, held] = a.clients;
  // client-page: one page holds the client, and the walk reaches its blocks, more than the tasks bound.
  assert.equal(onPage.pages.length, 1);
  assert.deepEqual(onPage.pages[0].refs, [onPage.client.uuid]);
  assert.equal(onPage.pages[0].blocks.length, CLIENT_PAGE_BLOCKS);
  assert.ok(onPage.pages[0].blocks.every((b) => b.refs.length === 0), "its blocks take the page's client");
  assert.ok(onPage.pages[0].blocks.some((b) => b.task) && onPage.pages[0].blocks.some((b) => !b.task));
  // client-tasks: open tasks that each hold the client, more than the open-tasks bound, on pages that don't.
  const tasks = held.pages.flatMap((p) => p.blocks);
  assert.equal(tasks.length, CLIENT_TASKS);
  assert.ok(held.pages.every((p) => p.refs.length === 0));
  assert.ok(tasks.every((t) => (t.task === "todo" || t.task === "doing") && t.refs.length === 1 && t.refs[0] === held.client.uuid));
  assert.notEqual(onPage.client.title, held.client.title);
});

test("--named runs open-tasks-by-client with params.client at the cap: a client page past the tasks bound and a client held past the open-tasks or reads bound, each 422 naming the client", { skip, timeout: 300_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--named", "--pages", "150", "--runs", "1", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  const client = out.records.filter((r) => r.run !== "full");
  assert.deepEqual(client.map((r) => r.run), CLIENT_RUNS);
  const [onPage, held] = client;
  for (const r of client) {
    assert.equal(r.query, "open-tasks-by-client");
    assert.equal(r.pages, 150);
    assert.ok(Number.isInteger(r.datoms) && r.datoms > 0);
    for (const k of ["cold_ms", "warm_ms"]) assert.ok(typeof r[k] === "number" && r[k] >= 0, `${r.run}: ${k}`);
    assert.equal(typeof r.client, "string", `${r.run}: names its client`);
    assert.deepEqual(Object.keys(r.work).sort(), ["open-tasks", "reads", "tasks"], `${r.run}: work names its bounds`);
    assert.equal(r.outcome, "bound", `${r.run}: ${r.outcome}`);
    assert.equal(r.rows, 0);
  }
  assert.equal(onPage.bound, "tasks");
  assert.equal(onPage.work.tasks, out.bounds.tasks + 1, "stopped one past the tasks bound");
  assert.equal(onPage.error, `open-tasks-by-client stopped after 10,000 blocks holding ${onPage.client} or on its pages (its tasks bound); list one of its pages' tasks with datalog_query`);
  assert.ok(["open-tasks", "reads"].includes(held.bound), held.bound);
  assert.ok(held.work[held.bound] === out.bounds[held.bound] + 1, `stopped one past the ${held.bound} bound: ${JSON.stringify(held.work)}`);
  assert.match(held.error, new RegExp(`^open-tasks-by-client (found more than 2,000 open tasks of ${held.client} \\(its open-tasks bound\\)|stopped after 30,000 reads \\(its reads bound, the backstop over every read\\)); mark ${held.client}'s finished tasks`));
  assert.notEqual(onPage.client, held.client);
});

test("--bounds stops a named query at the bound it names, and --bounds refuses an unknown bound", { skip, timeout: 300_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--named", "--pages", "150", "--runs", "1", "--bounds", "reads=50,tagged=40000", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.bounds.reads, 50);
  assert.equal(out.bounds.tagged, 40000);
  for (const r of out.records) {
    assert.equal(r.outcome, "bound", `${r.query}: ${r.outcome}`);
    assert.equal(r.bound, "reads", r.query);
    assert.equal(r.work.reads, 51, `${r.query}: stopped one past the bound`);
  }
  const bad = spawnSync(process.execPath, [script, "--named", "--bounds", "nope=1"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--bounds: unknown bound nope \(bounds: meetings, decisions, ancestor-steps, tagged, page-blocks, tasks, open-tasks, items, reads\)/);
  const notWhole = spawnSync(process.execPath, [script, "--named", "--bounds", "reads=x"], { encoding: "utf8" });
  assert.equal(notWhole.status, 2);
  assert.match(notWhole.stderr, /--bounds: reads needs a whole number/);
});

test("--width --json gives one record per width shape with the width charged, the F1 shapes refused by the width cap before running and the 3-binding query answered", { skip, timeout: 300_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--width", "--pages", "150", "--runs", "2", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.mode, "width");
  assert.ok(Number.isInteger(out.width_cap) && out.width_cap > 0);
  assert.deepEqual(out.records.map((r) => r.shape), WIDTH);
  for (const r of out.records) {
    for (const k of ["cold_ms", "warm_ms"]) assert.ok(typeof r[k] === "number" && r[k] >= 0, `${r.shape}: ${k}`);
    assert.ok(Number.isInteger(r.width) && r.width >= 0, `${r.shape}: width ${r.width}`);
  }
  const at = (shape) => out.records.find((r) => r.shape === shape);
  for (const shape of WIDTH.slice(0, 3)) {
    assert.equal(at(shape).outcome, "width-cap", `${shape}: ${at(shape).error}`);
    // More than 12 function bindings: refused before anything runs, so nothing is charged.
    assert.match(at(shape).error, /^query has \d+ function bindings, more than the 12 the width cap allows/);
    assert.equal(at(shape).width, 0, `${shape}: charged nothing`);
  }
  assert.equal(at("three-bindings").outcome, "rows");
  // ?p and ?e are bound before the title's get-else adds ?t, and each binding after adds a column:
  // the upstream suite's legitimate 3-binding query charges the same 30,000.
  assert.equal(at("three-bindings").width, 2500 * (3 + 4 + 5));

  const lowered = spawnSync(process.execPath, [script, "--width", "--pages", "150", "--runs", "1", "--width-cap", "20000", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(lowered.status, 0, lowered.stderr);
  const r2 = JSON.parse(lowered.stdout);
  assert.equal(r2.width_cap, 20000);
  const three = r2.records.find((r) => r.shape === "three-bindings");
  assert.equal(three.outcome, "width-cap", "a lower --width-cap stops the 3-binding query while it runs");
  assert.ok(three.width > 20000, `charged past the cap: ${three.width}`);
});

test("--named and --width skip naming the missing build, and refuse being given together", () => {
  const empty = mkdtempSync(join(tmpdir(), "bench-datalog-empty-"));
  try {
    for (const mode of ["--named", "--width"]) {
      const run = spawnSync(process.execPath, [script, mode, "--upstream", empty, "--json"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(JSON.parse(run.stdout).skipped, /deps\/db-sync\/worker\/dist\/worker-test\.js.*scripts\/upstream-test\.sh/);
    }
    const both = spawnSync(process.execPath, [script, "--named", "--width"], { encoding: "utf8" });
    assert.equal(both.status, 2);
    assert.match(both.stderr, /give one of --named, --width or --query-block/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("text output in --named and --width prints a row per query or shape", { skip, timeout: 300_000 }, () => {
  const named = spawnSync(process.execPath, [script, "--named", "--pages", "150", "--runs", "1"], { encoding: "utf8" });
  assert.equal(named.status, 0, named.stderr);
  for (const q of NAMED) assert.match(named.stdout, new RegExp(`^${q}\\s+full\\s+150\\s`, "m"));
  for (const run of ["client-page", "client-tasks"]) assert.match(named.stdout, new RegExp(`^open-tasks-by-client\\s+${run}\\s+150\\s.*\\b(tasks|open-tasks|reads)!`, "m"));
  assert.match(named.stdout, /named queries bench: bounds .*reads 30,000/, "the bounds are read from the build");
  const width = spawnSync(process.execPath, [script, "--width", "--pages", "150", "--runs", "1"], { encoding: "utf8" });
  assert.equal(width.status, 0, width.stderr);
  for (const s of WIDTH) assert.match(width.stdout, new RegExp(`^${s}\\s+150\\s`, "m"));
  assert.match(width.stdout, /width cap 100,000/);
});

// Query-block mode (patch 0050 stage 5, spec 2026-11-20 §5 and §9 item 4)
// ========================================================================

// The batch runs through the release bundle's SyncDO.fetch (what deploy ships); check-query-block
// alone runs in the dev test build, which the release bundle's renamed names can't be called from.
const releaseBundle = join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker", "main.js");
const skipQueryBlock = skip || (existsSync(releaseBundle) ? false : ".upstream release bundle missing: scripts/build.sh .upstream");
const QUERY_STEPS = ["check-1", "parse-100", "insert-100", "write-100"];

test("queryBlockText makes 4,000-character advanced queries, distinct per node, and a refused one that only the function-binding cap stops", async () => {
  const { queryBlockText, QUERY_BLOCK_CHARS, QUERY_BLOCK_NODES } = await import(script);
  assert.equal(QUERY_BLOCK_CHARS, 4000);
  assert.equal(QUERY_BLOCK_NODES, 100);
  const texts = Array.from({ length: 100 }, (_, i) => queryBlockText(i));
  for (const t of texts) {
    assert.equal(t.length, 4000);
    assert.match(t, /^\{:query \[:find \(pull \?b \[\*\]\) :where \[\?b :block\/tags \?t\] \[\?t :block\/title "Book"\] /);
    assert.doesNotMatch(t, /\[\(identity/, "no function binding in a stored query");
    assert.ok((t.match(/\[\?b :block\/refs \?r\d+\]/g) ?? []).length >= 50, "clause-heavy: the validator walks many clauses");
    assert.match(t, /\(not \[/, "a not clause");
  }
  assert.equal(new Set(texts).size, 100);
  const refused = queryBlockText(99, { refused: true });
  assert.equal(refused.length, 4000);
  assert.equal((refused.match(/\[\(identity \?t\) \?f\d+\]/g) ?? []).length, 13, "one more function binding than the 12 allowed");
});

test("--query-block --json times check-query-block and a 100-node batch of 4,000-character queries, cold and warm, with parse and write apart", { skip: skipQueryBlock, timeout: 600_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--query-block", "--runs", "1", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.mode, "query-block");
  assert.equal(out.runs, 1);
  assert.equal(out.query_chars, 4000);
  assert.equal(out.nodes, 100);
  assert.equal(typeof out.node, "string");
  assert.deepEqual(out.records.map((r) => r.step), QUERY_STEPS);
  for (const r of out.records) {
    for (const k of ["cold_ms", "warm_ms"]) assert.ok(typeof r[k] === "number" && r[k] >= 0, `${r.step}: ${k} ${r[k]}`);
    assert.equal(typeof r.build, "string", `${r.step}: build`);
  }
  const at = (step) => out.records.find((r) => r.step === step);
  assert.deepEqual([at("check-1").nodes, at("parse-100").nodes, at("insert-100").nodes, at("write-100").nodes], [1, 100, 100, 100]);
  assert.equal(at("check-1").build, "dev");
  assert.equal(at("check-1").outcome, "ok");
  assert.equal(at("parse-100").build, "release");
  assert.equal(at("parse-100").status, 400, "every node parsed and checked, the last refused, nothing written");
  assert.match(at("parse-100").error, /^entries\[0\]\.blocks\[99\]: query: query has 13 function bindings, more than the 12 the width cap allows/);
  assert.equal(at("insert-100").status, 201);
  assert.equal(at("insert-100").stored, 100, "all 100 Query blocks stored");
  // write = insert − parse, for the cold pair and for the warm runs.
  assert.ok(Math.abs(at("write-100").cold_ms - (at("insert-100").cold_ms - at("parse-100").cold_ms)) <= 0.02);
  assert.equal(at("write-100").build, "release");
});

test("--query-block text output prints a row per step with cold and warm ms", { skip: skipQueryBlock, timeout: 600_000 }, () => {
  const run = spawnSync(process.execPath, [script, "--query-block", "--runs", "1"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^query-block bench: 100 nodes of 4,000 characters, warm median of 1 run/m);
  assert.match(run.stdout, /^step\s+build\s+nodes\s+cold_ms\s+warm_ms\s+outcome/m);
  for (const step of QUERY_STEPS) assert.match(run.stdout, new RegExp(`^${step}\\s+(dev|release)\\s+\\d+\\s+\\d+\\.\\d\\s+\\d+\\.\\d\\s`, "m"));
});

test("--query-block skips naming a missing build, and is refused beside --named or --width", () => {
  const empty = mkdtempSync(join(tmpdir(), "bench-datalog-empty-"));
  try {
    const run = spawnSync(process.execPath, [script, "--query-block", "--upstream", empty, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(JSON.parse(run.stdout).skipped, /worker-test\.js|worker\/main\.js/);
    for (const other of ["--named", "--width"]) {
      const both = spawnSync(process.execPath, [script, "--query-block", other], { encoding: "utf8" });
      assert.equal(both.status, 2);
      assert.match(both.stderr, /give one of --named, --width or --query-block/);
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
