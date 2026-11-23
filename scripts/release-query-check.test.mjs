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

test("the blank-blocks fixture is deleteBlankBlocks at its caps: 5 pages of 2,000 blocks, 10,000 in all, half of them blank leaves", async () => {
  const { blankFixture, BLANK } = await import(script);
  const pages = blankFixture();
  assert.deepEqual(blankFixture(), pages, "the same on every build");
  assert.equal(BLANK.pages, 5);
  assert.equal(BLANK.blocksPerPage, 2000, "the per-page bound (max-outline-blocks)");
  assert.equal(pages.length, BLANK.pages);
  assert.equal(pages.reduce((n, p) => n + p.blocks.length, 0), 10_000, "the per-call bound (max-blank-scan)");
  for (const p of pages) {
    assert.equal(p.blocks.length, BLANK.blocksPerPage);
    assert.ok(p.blocks.every((b) => !b.children), "every block is a leaf");
    assert.equal(p.blocks.filter((b) => b.title.trim() === "").length, BLANK.blocksPerPage / 2, `${p.title}: half blank`);
    assert.ok(p.blocks.filter((b) => b.title.trim() !== "").every((b) => /^Release blank \d+ text \d+$/.test(b.title)));
  }
  assert.equal(new Set(pages.map((p) => p.title)).size, BLANK.pages, "each page once");
});

test("the dry-run bound at the caps is 500 ms", async () => {
  const { BLANK_MS } = await import(script);
  assert.equal(BLANK_MS, 500);
});

test("checkBlankDryRun passes a quick answer listing 100 of 5,000 across 5 pages, and fails a refusal, a wrong count or a slow answer", async () => {
  const { checkBlankDryRun, BLANK_MS } = await import(script);
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  const entry = (uuid, n) => ({ page: uuid, uuid, "would-delete": Array.from({ length: n }, (_, i) => ({ uuid: `${uuid}-${i}`, parent: uuid })), kept: { "has-children": 0, referenced: 0, "being-edited": 0, examples: [] }, "skipped-private": 0 });
  const good = { "dry-run": true, t: 9, total: 5000, listed: 100, pages: [entry("p1", 100), ...ids.slice(1).map((u) => entry(u, 0))], note: "…" };
  assert.match(await checkBlankDryRun(fakeStub({ status: 200, body: good }), ids), /median \d+ ms/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 422, body: { error: "page-ids[4]: the call is over 10000 blocks" } }), ids), /HTTP 422/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 200, body: { ...good, total: 4999 } }), ids), /total 4999, expected 5000/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 200, body: { ...good, listed: 99 } }), ids), /listed 99, expected 100/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 200, body: { ...good, pages: [entry("p1", 101), ...good.pages.slice(1)] } }), ids), /would-delete holds 101/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 200, body: { ...good, pages: [...good.pages].reverse() } }), ids), /pages in the order/);
  await assert.rejects(checkBlankDryRun(fakeStub({ status: 200, body: good, delay: BLANK_MS + 20 }), ids), /expected under 500 ms/);
});

test("the apply bound at the caps is 15 s, half the Durable Object's 30 s CPU limit", async () => {
  const { BLANK_APPLY_MS } = await import(script);
  assert.equal(BLANK_APPLY_MS, 15000);
});

/**
 * A fake SyncDO for deleteBlankBlocks at the caps: a dry run lists the next 100 blank leaves of the
 * first page, an apply answers `apply(round, ids)` (by default what the real apply answers for them).
 */
function blankStub({ apply, delay = 0, listed = 100 } = {}) {
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  let round = 0;
  const sent = [];
  const entry = (uuid, n, from = 0) => ({ page: uuid, uuid, "would-delete": Array.from({ length: n }, (_, i) => ({ uuid: `${uuid}-${from + i}`, parent: uuid })), kept: { "has-children": 0, referenced: 0, "being-edited": 0, examples: [] }, "skipped-private": 0 });
  const real = (r, blockIds) => ({
    deleted: blockIds.length,
    t: 9 + r,
    pages: ids.map((uuid, i) => ({ page: uuid, uuid, deleted: i === 0 ? blockIds.length : 0, "remaining-blocks": i === 0 ? 2000 - 100 * r : 2000 })),
  });
  return {
    ids,
    sent,
    stub: {
      async fetch(request) {
        const body = await request.json();
        sent.push(body);
        if (body["dry-run"] === true) {
          const total = 5000 - 100 * round;
          return Response.json({ "dry-run": true, t: 9 + round, total, listed, pages: [entry("p1", listed, 100 * round), ...ids.slice(1).map((u) => entry(u, 0))], note: "…" });
        }
        round += 1;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const answer = (apply ?? ((r, b) => ({ status: 200, body: real(r, b) })))(round, body["block-ids"], real);
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      },
    },
  };
}

test("checkBlankApply passes three applies of the 100 ids each dry run listed, and fails a refusal, a wrong count, a short listing or a slow answer", async () => {
  const { checkBlankApply, BLANK_APPLY_MS } = await import(script);
  const good = blankStub();
  assert.match(await checkBlankApply(good.stub, good.ids), /median \d+ ms/);
  const applies = good.sent.filter((b) => b["dry-run"] !== true);
  assert.equal(applies.length, 3, "three applies");
  for (const [i, body] of applies.entries()) {
    assert.deepEqual(body["page-ids"], good.ids);
    assert.equal(body["block-ids"].length, 100);
    assert.deepEqual(body["block-ids"], Array.from({ length: 100 }, (_, j) => `p1-${100 * i + 99 - j}`), "the listed ids, in reverse order");
  }
  assert.equal(good.sent.at(-1)["dry-run"], true, "a dry run after the last apply");
  const failing = [
    [{ apply: () => ({ status: 409, body: { error: "block-ids[3]: referenced" } }) }, /apply 1: HTTP 409: .*block-ids\[3\]: referenced/],
    [{ apply: (r, b, real) => ({ status: 200, body: { ...real(r, b), deleted: 99 } }) }, /apply 1: deleted 99, expected 100/],
    [{ apply: (r, b, real) => ({ status: 200, body: { ...real(r, b), pages: real(r, b).pages.reverse() } }) }, /apply 1: pages in the order/],
    [{ apply: (r, b, real) => ({ status: 200, body: { ...real(r, b), pages: real(r, b).pages.map((p, i) => (i === 1 ? { ...p, deleted: 1 } : p)) } }) }, /apply 1: deleted 100, 1, 0, 0, 0 per page/],
    [{ apply: (r, b, real) => ({ status: 200, body: { ...real(r, b), pages: real(r, b).pages.map((p, i) => (i === 0 ? { ...p, "remaining-blocks": 2000 } : p)) } }) }, /apply 1: remaining-blocks 2000, 2000, 2000, 2000, 2000, expected 1900, 2000/],
    [{ listed: 99 }, /dry run 1: listed 99, expected 100/],
    [{ apply: (r, b, real) => ({ status: 500, body: { error: "1 of 100 deleted blocks were not removed: x", "not-removed": ["x"] } }) }, /apply 1: HTTP 500/],
  ];
  for (const [opts, error] of failing) {
    const { stub, ids } = blankStub(opts);
    await assert.rejects(checkBlankApply(stub, ids), error);
  }
  // A slow answer, against a 50 ms bound so the test doesn't wait BLANK_APPLY_MS three times.
  const slow = blankStub({ delay: 70 });
  await assert.rejects(checkBlankApply(slow.stub, slow.ids, 50), /expected under 50 ms/);
  const quick = blankStub();
  assert.match(await checkBlankApply(quick.stub, quick.ids, 50), /median \d+ ms/);
  assert.ok(BLANK_APPLY_MS > 50);
});

test("the sync-status fixture is 100,000 entities: 2,000 pages of 49 blocks, with Private and recycled pages the counts leave out", async () => {
  const { syncStatusFixture, SYNC_STATUS } = await import(script);
  const f = syncStatusFixture();
  assert.deepEqual(syncStatusFixture(), f, "the same on every build");
  assert.equal(SYNC_STATUS.pages, 2000);
  assert.equal(SYNC_STATUS.blocksPerPage, 49);
  assert.equal(f.entities, 100_000, "the spec's bench size (section 8)");
  assert.equal(f.pages.length + f.pages.reduce((n, p) => n + p.blocks.length, 0), f.entities);
  assert.equal(f.pages.filter((p) => p.private).length, 200, "every 10th page is tagged Private");
  assert.equal(f.pages.filter((p) => p.recycled).length, 100, "every 20th page, offset 5, is in the Recycle bin");
  assert.ok(!f.pages.some((p) => p.private && p.recycled));
  assert.deepEqual(f.counted, { pages: 1700, blocks: 1700 * 49 }, "what getSyncStatus counts: the rest");
  assert.equal(new Set(f.pages.flatMap((p) => [p.uuid, ...p.blocks])).size, f.entities, "every uuid once");
});

test("the sync-status bound at 100,000 entities is 750 ms", async () => {
  const { SYNC_STATUS_MS } = await import(script);
  assert.equal(SYNC_STATUS_MS, 750);
});

test("checkSyncStatus passes quick counts that grew by the fixture's, and fails a refusal, a wrong count or a slow answer", async () => {
  const { checkSyncStatus, SYNC_STATUS_MS } = await import(script);
  const baseline = { "page-count": 7, "block-count": 30 };
  const added = { pages: 1700, blocks: 83_300 };
  const good = { t: 4, "page-count": 1707, "block-count": 83_330, clients: { connected: 0 } };
  assert.match(await checkSyncStatus(fakeStub({ status: 200, body: good }), baseline, added), /median \d+ ms/);
  await assert.rejects(checkSyncStatus(fakeStub({ status: 500, body: { error: "boom" } }), baseline, added), /HTTP 500/);
  await assert.rejects(checkSyncStatus(fakeStub({ status: 200, body: { ...good, "page-count": 1907 } }), baseline, added), /page-count 1907, expected 1707/);
  await assert.rejects(checkSyncStatus(fakeStub({ status: 200, body: { ...good, "block-count": 98_030 } }), baseline, added), /block-count 98030, expected 83330/);
  await assert.rejects(checkSyncStatus(fakeStub({ status: 200, body: good, delay: SYNC_STATUS_MS + 20 }), baseline, added), /expected under 750 ms/);
  const slow = fakeStub({ status: 200, body: good, delay: 70 });
  await assert.rejects(checkSyncStatus(slow, baseline, added, 50), /expected under 50 ms/);
});

test("checkSyncStatus bounds the median of the three warm runs, not the fastest or the slowest", async () => {
  const { checkSyncStatus } = await import(script);
  const baseline = { "page-count": 7, "block-count": 30 };
  const added = { pages: 1700, blocks: 83_300 };
  const good = { t: 4, "page-count": 1707, "block-count": 83_330, clients: { connected: 0 } };
  // The first call is the cold run and is not bounded; the next three are the warm runs.
  const twoSlow = fakeStub({ status: 200, body: good, delay: [0, 5, 90, 90] });
  await assert.rejects(checkSyncStatus(twoSlow, baseline, added, 50), /expected under 50 ms/, "two of three warm runs over the bound fail");
  const oneSlow = fakeStub({ status: 200, body: good, delay: [0, 90, 5, 5] });
  assert.match(await checkSyncStatus(oneSlow, baseline, added, 50), /median \d+ ms/, "one slow warm run of three passes");
  const coldSlow = fakeStub({ status: 200, body: good, delay: [90, 5, 5, 90] });
  assert.match(await checkSyncStatus(coldSlow, baseline, added, 50), /median \d+ ms/, "a slow cold run is not bounded");
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

// A stand-in for the SyncDO that answers every fetch with `status` and `body`, after `delay` ms
// (a number for every call, or an array of per-call delays, the last repeating), calling `log`
// first; the checks below only read the response, so each can be shown to fail.
const fakeStub = ({ status, body, delay = 0, log } = {}) => {
  let calls = 0;
  return {
    async fetch() {
      log?.();
      const ms = Array.isArray(delay) ? delay[Math.min(calls, delay.length - 1)] : delay;
      calls += 1;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return new Response(JSON.stringify(body), { status });
    },
  };
};
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

// Patch 0054: open-tasks-by-client with params.client
// ====================================================

test("the scale fixture's client rows are the full run's rows of one client: its own tasks and its pages', not a task whose own client is another", async () => {
  const { scaleFixture, CLIENT, SCALE } = await import(script);
  assert.equal(CLIENT, SCALE.clients[0]);
  const { expected } = scaleFixture(1_762_646_400_000);
  const { client } = expected["open-tasks-by-client"];
  assert.equal(client.title, CLIENT);
  assert.ok(client.rows.length >= 20, `${client.rows.length} rows`);
  assert.ok(client.rows.every(([c]) => c === CLIENT), "every row is the client's");
  assert.deepEqual(scaleFixture(0).expected["open-tasks-by-client"].client, client, "the same on every build");
  const titles = client.rows.map(([, t]) => t);
  // Release tasks 0 is held by Release Client A (its page's client); its task 0 has its own client B.
  assert.ok(titles.includes("Release task 0.1"), "a task that takes its page's client");
  assert.ok(!titles.includes("Release task 0.0"), "a task whose own client is another stays out");
  assert.ok(titles.some((t) => Number(t.split(" ")[2].split(".")[0]) % 2 === 1), "a task that holds the client itself");
  const order = titles.map((t) => t.split(" ")[2].split(".").map(Number));
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]), "in creation order, as the handler sorts one client's rows");
  // The first 200 of the full run hold rows of other clients too, so the client case is no slice of them.
  assert.ok(expected["open-tasks-by-client"].rows.some(([c]) => c !== CLIENT));
});

test("clientBoundMessage gives the client-worded 422 of each bound, and the advice to give a client without one, the tasks bound's advice its own", async () => {
  const { clientBoundMessage } = await import(script);
  const advice = "mark zq Acme's finished tasks Done or Canceled, or list one of its pages' tasks with datalog_query";
  assert.equal(clientBoundMessage("tasks", 10_000, "zq Acme"), "open-tasks-by-client stopped after 10,000 blocks holding zq Acme or on its pages (its tasks bound); list one of its pages' tasks with datalog_query");
  assert.equal(clientBoundMessage("open-tasks", 1, "zq Acme"), `open-tasks-by-client found more than 1 open tasks of zq Acme (its open-tasks bound); ${advice}`);
  assert.equal(clientBoundMessage("reads", 30_000, "zq Acme"), `open-tasks-by-client stopped after 30,000 reads (its reads bound, the backstop over every read); ${advice}`);
  assert.equal(clientBoundMessage("tasks", 3), "open-tasks-by-client stopped after 3 blocks tagged Task (its tasks bound); give a client (params.client)");
  assert.equal(clientBoundMessage("open-tasks", 3), "open-tasks-by-client found more than 3 open tasks (its open-tasks bound); give a client (params.client), or mark finished tasks Done or Canceled");
  assert.throws(() => clientBoundMessage("meetings", 3, "zq Acme"), /no bound meetings/);
});

test("sharedTitleMessage names each entity a shared title matches, with its kind and UUID, in the order given", async () => {
  const { sharedTitleMessage } = await import(script);
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  assert.equal(
    sharedTitleMessage("zq Shared", [{ kind: "tag", uuid: a }, { kind: "block", uuid: b }]),
    `params.client: "zq Shared" matches 2 entities (zq Shared: tag ${a}, zq Shared: block ${b}); give the one you mean by UUID`,
  );
});

const clientUuid = "00000000-0000-4000-8000-0000000000c1";
const taskEntity = (title) => ({ "block/uuid": "00000000-0000-4000-8000-000000000001", "block/title": title });
const clientBody = (rows, extra = {}) => ({
  name: "open-tasks-by-client",
  params: { client_property: { title: "releaseClient", type: "node" }, client: { title: "zq Acme", uuid: clientUuid } },
  "total-rows": rows.length,
  plan: "1. … (tasks bound 10,000) … (open-tasks bound 2,000) … (reads bound 30,000)",
  work: { tasks: 9, "open-tasks": 3, reads: 40 },
  rows: rows.map(([c, t]) => [c, taskEntity(t)]),
  ...extra,
});

test("expectClientRun passes the client's rows and echo, and fails a wrong echo, the right count of wrong rows, a total off by one or a missing bound", async () => {
  const { expectClientRun } = await import(script);
  const rows = [["zq Acme", "t1"], ["zq Acme", "t2"]];
  const want = { title: "zq Acme", uuid: clientUuid, rows };
  assert.doesNotThrow(() => expectClientRun(clientBody(rows), want));
  const echo = (client) => clientBody(rows, { params: { ...clientBody(rows).params, client } });
  assert.throws(() => expectClientRun(echo(undefined), want), /params\.client echo undefined, expected/);
  assert.throws(() => expectClientRun(echo({ title: "zq Acme" }), want), /params\.client echo \{"title":"zq Acme"\}, expected/);
  assert.throws(() => expectClientRun(echo({ title: "zq Beta", uuid: clientUuid }), want), /params\.client echo/);
  assert.throws(() => expectClientRun(echo({ title: "zq Acme", uuid: "00000000-0000-4000-8000-0000000000c2" }), want), /params\.client echo/);
  assert.throws(() => expectClientRun(clientBody([["zq Acme", "t1"], ["zq Acme", "t3"]]), want), /rows .*expected/);
  assert.throws(() => expectClientRun(clientBody([["zq Acme", "t2"], ["zq Acme", "t1"]]), want), /rows .*expected/);
  assert.throws(() => expectClientRun(clientBody(rows, { "total-rows": 3 }), want), /total-rows 3, expected 2/);
  assert.throws(() => expectClientRun(clientBody(rows, { work: { tasks: 9, reads: 40 } }), want), /work has no open-tasks count/);
});

test("expectRefusal passes the exact status and message with no rows, and fails another status, another message or a body with rows", async () => {
  const { expectRefusal } = await import(script);
  const res = (status, json) => ({ status, json, text: JSON.stringify(json) });
  assert.doesNotThrow(() => expectRefusal(res(400, { error: "params.client: x" }), 400, "params.client: x"));
  assert.throws(() => expectRefusal(res(200, { rows: [] }), 400, "params.client: x"), /HTTP 200, expected 400/);
  assert.throws(() => expectRefusal(res(422, { error: "params.client: x" }), 400, "params.client: x"), /HTTP 422, expected 400/);
  assert.throws(() => expectRefusal(res(400, { error: "params.client: y" }), 400, "params.client: x"), /error "params\.client: y", expected "params\.client: x"/);
  assert.throws(() => expectRefusal(res(400, { error: "params.client: x", rows: [] }), 400, "params.client: x"), /the refusal carries rows/);
});

// A stand-in for the SyncDO's named-query route: answers open-tasks-by-client's lowered bounds with
// `message(bound, value, client)`, as the release bundle would, reading namedQueryBounds off itself.
const boundStub = (message) => ({
  seen: [],
  async fetch(request) {
    const { params } = await request.json();
    const bounds = this.namedQueryBounds ?? {};
    this.seen.push({ ...bounds });
    const [bound, value] = Object.entries(bounds)[0] ?? [];
    if (!bound) return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: message(bound, value, params.client) }), { status: 422 });
  },
});

test("checkClientBounds passes the client-worded 422 at each lowered bound, fails a bundle that drops the client's name, and restores the bounds", async () => {
  const { checkClientBounds, clientBoundMessage } = await import(script);
  const good = boundStub((bound, value, client) => clientBoundMessage(bound, value, client));
  await checkClientBounds(good, "releaseClient", "zq Acme");
  assert.deepEqual(good.seen.map((b) => Object.keys(b)), [["tasks"], ["tasks"], ["open-tasks"], ["reads"]], "the control without a client, then each bound with one");
  assert.equal(good.namedQueryBounds, undefined, "the defaults are back");
  // A release bundle that renamed or lost :client in the ex-data gives the generic advice.
  const renamed = boundStub((bound, value) => clientBoundMessage(bound, value));
  await assert.rejects(checkClientBounds(renamed, "releaseClient", "zq Acme"), /tasks bound with params\.client: error "open-tasks-by-client stopped after 3 blocks tagged Task/);
  assert.equal(renamed.namedQueryBounds, undefined, "the defaults are back after a failure");
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

test("the insights fixture's names, the nine health checks, the default four and the env deploy would give the Worker", async () => {
  const { INSIGHT, HEALTH_CHECKS, DEFAULT_HEALTH_CHECKS, insightEnv } = await import(script);
  assert.deepEqual(INSIGHT, { tag: "Release Insight Book", property: "release-insight-author", page: "Release Insight Page" });
  assert.deepEqual(HEALTH_CHECKS, ALL_CHECKS);
  // Review s-stage-6-2: a call without checks runs only these four.
  assert.deepEqual(DEFAULT_HEALTH_CHECKS, ["orphan-tags", "orphan-properties", "mismatched-choice-values", "orphan-choices"]);
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
    "at scale: open-tasks-by-client with params.client by title answers that client's rows of the full run and echoes it",
    "at scale: open-tasks-by-client with params.client by UUID answers that client's rows of the full run and echoes it",
    "at scale: open-tasks-by-client refuses a client title a tag and a block share, naming each",
    "at scale: open-tasks-by-client with params.client names the client in each bound's 422",
    "at scale: F1 175 identity clauses over 100 blocks answers the width-cap 422 within 100 ms",
    "at scale: F1 99 identity clauses over 200 blocks answers the width-cap 422 within 100 ms",
    "at scale: F1 20 bound includes? over 500 blocks answers the width-cap 422 within 100 ms",
    "at scale: a datalog_query scan-cap 422 logs nothing to the console",
    "seed deleteBlankBlocks' caps: 5 pages of 2000 blocks through SyncDO.fetch",
    "at the caps: a deleteBlankBlocks dry run over 10000 blocks lists 100 of 5000 within 500 ms",
    "at the caps: a deleteBlankBlocks apply of 100 listed ids over 10000 blocks deletes them within 15000 ms",
    "at 100,000 entities: getSyncStatus counts 1700 pages and 83300 blocks, leaving out Private and recycled ones, within 750 ms",
    "Query blocks: the Book fence and a query field insert through the release bundle, logging nothing",
    "Query blocks: both read back with the Query tag, the query text, :code, clojure and the marker",
    "Query blocks: a :rules query and a rule call are refused naming the node, store nothing and log nothing",
    "graph insights: seed a tag with an expected property, two tagged blocks and a broken ref through SyncDO.fetch",
    "graph insights: checks=broken-refs,missing-tag-properties with tag-properties answers the broken ref and the bare book",
    "graph insights: the default health call runs the four cheap checks",
    "graph insights: missing-tag-properties named alone checks the stored HEALTH_TAG_PROPERTIES pairs",
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

test("the one-page dry-run graph holds 100,000 plain blocks on 2,000 pages, each created by one user, the same on every build", async () => {
  const { blankLargeTx, BLANK_LARGE } = await import(script);
  const txs = blankLargeTx();
  assert.deepEqual(blankLargeTx(), txs, "the same on every build");
  assert.deepEqual(BLANK_LARGE, { pages: 2000, blocksPerPage: 50, pageBlocks: 20 });
  assert.equal(BLANK_LARGE.pages * BLANK_LARGE.blocksPerPage, 100_000, "100,000 blocks besides the page");
  assert.equal(txs.length, 1 + BLANK_LARGE.pages, "the user page, then one transaction per page");
  const blocks = txs.slice(1).flatMap((tx) => tx.match(/:block\/parent/g) ?? []);
  assert.equal(blocks.length, 100_000);
  const created = txs.slice(1).flatMap((tx) => tx.match(/:logseq\.property\/created-by-ref/g) ?? []);
  assert.equal(created.length, 100_000, "every block carries created-by-ref, as the app's blocks do");
  assert.ok(!txs.some((tx) => /deleted-at|Private/.test(tx)), "nothing Private or recycled: the time is the predicate's");
  const own = txs.flatMap((tx) => [...tx.matchAll(/\{:block\/uuid #uuid "([^"]+)"/g)].map((m) => m[1]));
  assert.equal(own.length, 102_001, "the user, 2,000 pages and 100,000 blocks");
  assert.equal(new Set(own).size, own.length, "every uuid once");
});

test("the one-page dry-run bound beside 100,000 other blocks is 25 ms", async () => {
  const { BLANK_LARGE_MS } = await import(script);
  assert.equal(BLANK_LARGE_MS, 25);
});

test("checkBlankOnLargeGraph passes a quick answer listing the page's 10 blank leaves, and fails a refusal, a wrong count, another page or a slow answer", async () => {
  const { checkBlankOnLargeGraph, BLANK_LARGE_MS } = await import(script);
  const entry = (uuid, n) => ({ page: "Release blank one page", uuid, "would-delete": Array.from({ length: n }, (_, i) => ({ uuid: `b-${i}`, parent: uuid })), kept: { "has-children": 0, referenced: 0, "in-template": 0, "being-edited": 0, examples: [] }, "skipped-private": 0 });
  const good = { "dry-run": true, t: 3, total: 10, listed: 10, pages: [entry("p1", 10)], note: "…" };
  assert.match(await checkBlankOnLargeGraph(fakeStub({ status: 200, body: good }), "p1"), /median \d+ ms/);
  await assert.rejects(checkBlankOnLargeGraph(fakeStub({ status: 404, body: { error: "page-ids[0]: page not found" } }), "p1"), /HTTP 404/);
  await assert.rejects(checkBlankOnLargeGraph(fakeStub({ status: 200, body: { ...good, total: 9 } }), "p1"), /total 9, expected 10/);
  await assert.rejects(checkBlankOnLargeGraph(fakeStub({ status: 200, body: { ...good, pages: [entry("p1", 9)] } }), "p1"), /would-delete holds/);
  await assert.rejects(checkBlankOnLargeGraph(fakeStub({ status: 200, body: { ...good, pages: [entry("p2", 10)] } }), "p1"), /would-delete holds/);
  await assert.rejects(checkBlankOnLargeGraph(fakeStub({ status: 200, body: good, delay: BLANK_LARGE_MS + 20 }), "p1"), /expected under 25 ms/);
  const twoSlow = fakeStub({ status: 200, body: good, delay: [0, 5, 60, 60] });
  await assert.rejects(checkBlankOnLargeGraph(twoSlow, "p1", 40), /expected under 40 ms/, "the median of the warm runs is bounded");
  const coldSlow = fakeStub({ status: 200, body: good, delay: [90, 0, 0, 0] });
  assert.match(await checkBlankOnLargeGraph(coldSlow, "p1", 40), /median \d+ ms/, "a slow cold run is not bounded");
});
