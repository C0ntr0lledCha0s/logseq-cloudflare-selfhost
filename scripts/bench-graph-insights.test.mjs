import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "bench-graph-insights.mjs");

// The bench builds its graph with upstream db-sync's compiled test build from .upstream (the real
// handle-http and the Datascript it runs on) and times the release bundle (scripts/build.sh). Without
// both it cannot run, so these tests say so and skip; scripts/check.sh names each skipped test in a
// WARNING line.
const build = join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker-test.js");
const bundle = join(root, ".upstream", "deps", "db-sync", "worker", "dist", "worker", "main.js");
const skip = !existsSync(bundle)
  ? ".upstream release bundle missing: scripts/build.sh .upstream"
  : !existsSync(build)
    ? ".upstream/deps/db-sync/worker/dist/worker-test.js missing: compile upstream's test build with scripts/upstream-test.sh .upstream (scripts/build.sh alone removes it)"
    : false;

const SHAPES = ["health-default", "broken-refs", "missing-tag-properties", "changes", "schema"];
const HEALTH_CHECKS = [
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

const runBench = (args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

test("the bench's caps are the spec's: 5,000 and 20,000 pages, 20,000 changes, and x1.65 for Cloudflare", async () => {
  const { DEFAULT_PAGES, DEFAULT_CHANGES, CF_FACTOR, SHAPES: exported } = await import(script);
  assert.deepEqual(DEFAULT_PAGES, [5_000, 20_000]);
  assert.equal(DEFAULT_CHANGES, 20_000);
  assert.equal(CF_FACTOR, 1.65);
  assert.deepEqual(exported, SHAPES);
});

test("the fixture is the same on every run, holds exactly `changes` stamps in its window, and expects three pairs", async () => {
  const { makeFixture, PAIRS } = await import(script);
  const a = makeFixture(300, 1, { changes: 500 });
  assert.deepEqual(makeFixture(300, 1, { changes: 500 }), a);
  assert.notDeepEqual(makeFixture(300, 2, { changes: 500 }), a);
  assert.equal(a.pages.length, 300);
  assert.equal(PAIRS.length, 3);
  const stamps = [...a.pages, ...a.pages.flatMap((p) => p.blocks.flatMap((b) => [b, ...b.children]))].map((e) => e.updated);
  const inWindow = stamps.filter((t) => t > a.window.since && t <= a.window.until);
  assert.equal(inWindow.length, 500, "exactly `changes` entities are stamped inside the window");
  // Each count the shapes check has material: none of the expected counts is empty.
  const e = a.expected;
  assert.ok(e["broken-refs"].count > 0, "some blocks link a missing uuid");
  assert.ok(e["missing-tag-properties"].count > 0, "some tagged objects lack an expected property");
  assert.ok(e["missing-tag-properties"].count < a.pages.length * 5, "and some hold them");
  assert.ok(e.changes.pages > 0 && e.changes.created > 0 && e.changes.updated > 0 && e.changes["page-changed"] > 0);
  assert.ok(e.schema["project-objects"] > 0 && e.schema["owner-values"] > 0);
  assert.ok(a.pages.some((p) => p.tags.includes("private")), "some pages are Private, so the filter has work");
  assert.throws(() => makeFixture(10, 1, { changes: 10_000 }), /10,000 changes need more than the \d+ pages and blocks/);
});

test("every shape answers 200 with the counts the fixture expects, on a small seeded graph (shape and counts, never times)", { skip, timeout: 300_000 }, () => {
  const run = runBench(["--pages", "120", "--changes", "400", "--runs", "1", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.build, "release", "timed in the bundle deploy ships");
  assert.equal(out.cf_factor, 1.65);
  assert.equal(out.changes, 400);
  assert.deepEqual(out.records.map((r) => r.shape), SHAPES);
  for (const r of out.records) {
    assert.equal(r.status, 200, `${r.shape}: ${JSON.stringify(r.error)}`);
    assert.equal(r.pages, 120);
    assert.deepEqual(r.counts, r.expected, `${r.shape}: the response's counts are the fixture's`);
    for (const k of ["cold_ms", "warm_ms", "cf_cold_ms", "cf_warm_ms"]) assert.equal(typeof r[k], "number", `${r.shape}: ${k}`);
  }
  const by = Object.fromEntries(out.records.map((r) => [r.shape, r]));
  assert.deepEqual(Object.keys(by["health-default"].counts.checks), HEALTH_CHECKS, "the default call runs every check");
  assert.equal(by["missing-tag-properties"].counts["pairs-from"], "settings", "the stored pairs, as deploy sets them");
  assert.equal(by["missing-tag-properties"].counts.pairs, 3);
  assert.equal(by["health-default"].counts.checks["broken-refs"], by["broken-refs"].counts.count);
  assert.ok(by["broken-refs"].counts.count > 0);
});

test("failedRecords names a record with another status or other counts, and passes the rest", async () => {
  const { failedRecords } = await import(script);
  const ok = { shape: "schema", status: 200, counts: { tags: 5, "stage-usage": [1, 2] }, expected: { tags: 5, "stage-usage": [1, 2] } };
  assert.deepEqual(failedRecords([ok]), []);
  const status = { ...ok, shape: "changes", status: 422 };
  const counts = { ...ok, shape: "broken-refs", counts: { tags: 5, "stage-usage": [2, 1] } };
  const none = { ...ok, shape: "health-default", status: 500, counts: undefined };
  assert.deepEqual(failedRecords([ok, status, counts, none]).map((r) => r.shape), ["changes", "broken-refs", "health-default"]);
});

test("each shape's cold run starts on a new SyncDO that loads the graph from storage", { skip, timeout: 300_000 }, () => {
  const run = runBench(["--pages", "80", "--changes", "200", "--runs", "1", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  for (const r of JSON.parse(run.stdout).records) {
    assert.ok(r.nodes_loaded_cold > 0, `${r.shape}: the cold run read ${r.nodes_loaded_cold} nodes from the kvs table`);
  }
});

test("text output prints a row per shape and size with cold, warm and the x1.65 figures", { skip, timeout: 300_000 }, () => {
  const run = runBench(["--pages", "60,90", "--changes", "150", "--runs", "1"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /cold_ms +warm_ms +cf_cold +cf_warm/);
  for (const shape of SHAPES) {
    for (const pages of [60, 90]) assert.match(run.stdout, new RegExp(`^${shape} +${pages} +150 +200 `, "m"));
  }
});

test("skips with a reason naming the missing build when .upstream's db-sync output is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bgi-test-"));
  try {
    const json = runBench(["--upstream", dir, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.match(JSON.parse(json.stdout).skipped, /worker-test\.js is missing/);
    const text = runBench(["--upstream", dir]);
    assert.match(text.stdout, /^skipped: .*worker-test\.js is missing/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad --pages, --changes or --runs is refused naming the flag, and so is an unknown argument", () => {
  for (const [args, flag] of [
    [["--pages", "0"], /--pages needs a whole number/],
    [["--pages", "5000,x"], /--pages needs a whole number/],
    [["--changes", "-1"], /--changes needs a whole number/],
    [["--runs", "1.5"], /--runs needs a whole number/],
    [["--nope"], /unknown argument --nope/],
  ]) {
    const r = runBench(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, flag);
  }
});
