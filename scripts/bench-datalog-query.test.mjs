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
  "rule-recursive",
  "rule-deep-chain",
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
  // refs for the not-join, and a deep chain of blocks for the recursive rule.
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
    assert.ok(["rows", "scan-cap", "refused"].includes(r.outcome), `${where}: outcome ${r.outcome}`);
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
  // Work the cap does not count: a recursive rule down a 60-block chain reads a few datoms per
  // level, and a self-join on the chain's tag returns far more rows than the datoms it reads.
  assert.equal(at("rule-deep-chain", 300).outcome, "rows");
  assert.equal(at("rule-deep-chain", 300).total_rows, 60);
  assert.ok(at("rule-deep-chain", 300).datoms_scanned < 1000, "the chain reads few datoms");
  assert.equal(at("join-fanout", 300).outcome, "rows");
  assert.equal(at("join-fanout", 300).total_rows, 3600, "60 × 60 rows");
  assert.ok(at("join-fanout", 300).total_rows > at("join-fanout", 300).datoms_scanned, "rows outgrow the datoms read");
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
