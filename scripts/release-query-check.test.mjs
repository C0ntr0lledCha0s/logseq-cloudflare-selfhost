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

test("the release bundle returns the values data patterns bind, in datalog_query and run_named_query, and answers a decision 180 levels down", { skip, timeout: 300_000 }, () => {
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
test("fails, naming each check, on a bundle whose Datom field v is renamed", { skip, timeout: 300_000 }, () => {
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
