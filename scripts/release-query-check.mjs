#!/usr/bin/env node
// Usage: release-query-check.mjs [upstream-dir] [--bundle <main.js>]   (default: .upstream and its bundle)
// Runs Datalog queries against the RELEASE bundle (`pnpm release`, Closure advanced compilation)
// that deploy ships, not the dev test build. The dev build can't show a renaming fault: without
// Datascript's externs, the release bundle renamed the Datom field `v`, so every variable bound to
// a datom's value came back nil (docs/spikes/2026-11-09-safe-caller-datalog-queries.md, Finding 0).
//
// It loads deps/db-sync/worker/dist/worker/main.js in Node with the Cloudflare modules stubbed and
// better-sqlite3 standing in for the Durable Object's SQLite. A new graph's built-in pages come from
// the client's first upload, which the bundle can't make, so the dev test build (worker-test.js,
// which `pnpm test` compiles) stores only that built-in graph in the SQLite first; everything after
// that runs in the release bundle. It creates a tag, a property and a page
// through SyncDO.fetch(), then runs datalog_query and run_named_query through SyncDO.fetch() and
// checks the values that come back. run_named_query runs as server code that walks the indexes, so
// it also runs meetings-without-decision over a decision 10 levels deep and one 180 levels deep:
// both answer, quickly, with the meeting decided (the Datalog it replaced stopped the deep one at a
// rule cap), and each answer carries plan and work.
//
// Query blocks (patch 0050) call datalog.cljs's reader and validator on the write path, so it also
// inserts the spec's Book query as a fence and as a query field through POST /semantic/block-trees,
// reads both back through datalog_query from their datoms (the Query tag, the value block's text,
// display type :code, lang "clojure", and the claudeQueryBlock marker on the Query block only), and
// sends a :rules query and a rule call beside a valid node: each must answer 400 naming the node and
// the reason, with neither node stored. The inserts and the refusals run with the console captured,
// and fail if anything was logged.
//
// It then seeds a graph at scale (scaleFixture, about 20,000 blocks) through SyncDO.fetch, in
// POST /semantic/block-trees/batch calls of 100 entries: 2,400 pages tagged Release Topic, 300
// meetings with decisions under them (30 of them 40 levels down) or beside them, 400 tasks across
// six clients, 100 fresh projects and the three pages the F1 shapes count over. The API stamps every
// write with the time it runs and can't backdate one, so the 50 stale projects (pages and blocks
// with an updated-at 60 to 109 days ago) are transacted by the dev build into the stored graph
// before the release bundle loads it, beside the built-in graph. On that graph it runs each named
// query twice and checks its exact rows and that each run answers within NAMED_MS (300 ms); runs
// each F1 shape (many function bindings over one page's blocks) and checks that it answers the
// width-cap 422 (more than 12 function bindings, refused before it runs) within F1_MS (100 ms, the median of three warm runs); and runs a datalog_query
// that stops at the scan cap with console.error, warn, log and info captured, failing if the
// refusal logged anything. It runs open-tasks-by-client with params.client (patch 0054): by title
// and by UUID it must answer exactly the full run's rows of that client and echo {title, uuid}; a
// title a tag and a block share must answer the 400 naming each; and with each of its bounds
// lowered (namedQueryBounds on the Durable Object) the 422 must name the client, which it can only
// do if the bundle kept the :client ex-data key. It prints each timing under its check. Node on a developer machine
// guides the numbers; it does not measure the Durable Object on Cloudflare.
//
// Exits 0 when every check passes, 1 when one fails (naming it), and 2 when either build is
// missing. Seeding takes about 100 s.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WIDTH_SHAPES, findBuild, loadBuild, widthQuery } from "./bench-datalog-query.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A named query at scale must answer within this many ms, and an F1 shape's width-cap 422 within F1_MS. */
export const NAMED_MS = 300;
export const F1_MS = 100;

export const PAGE_TITLE = "Release Check Page";
export const TAG_TITLE = "Release Check Tag";
export const PROPERTY_TITLE = "release-check-prop";

export function bundlePath(upstream) {
  return join(upstream, "deps", "db-sync", "worker", "dist", "worker", "main.js");
}

// The bundle's bare imports that Node can't load as they are. `path` is Node's own.
const STUBBED = ["cloudflare:workers", "@sentry/cloudflare", "mldoc"];

/** Points the bundle's Cloudflare, Sentry and mldoc imports at local stubs; refuses a bundle missing one. */
export function rewriteImports(source) {
  let out = source;
  for (const [i, spec] of STUBBED.entries()) {
    const from = `from"${spec}"`;
    if (!out.includes(from)) throw new Error(`the bundle has no import from "${spec}": the stubs need updating`);
    out = out.split(from).join(`from"./stub-${i}.mjs"`);
  }
  return out;
}

function stubs(dbSync) {
  const mldoc = pathToFileURL(createRequire(join(dbSync, "package.json")).resolve("mldoc")).href;
  return [
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n",
    "export const captureException = (e) => { console.error('sentry stub:', e?.message ?? e); };\n" +
      "export const withSentry = (_config, handler) => handler;\n",
    `import m from ${JSON.stringify(mldoc)};\nexport const Mldoc = m.Mldoc;\nexport default m;\n`,
  ];
}

/**
 * Stores the built-in graph (what a client's first upload holds) in the kvs table, with the dev
 * build, after transacting `preseed` (EDN transaction strings) into it.
 */
function seedBuiltInGraph(upstream, sql, preseed = []) {
  const build = findBuild(upstream);
  if (build.missing) throw new Error(build.missing);
  const { cljs, d, logseq, reader } = loadBuild(build);
  sql.exec("create table if not exists kvs (addr INTEGER primary key, content TEXT, addresses JSON)");
  const conn = logseq.db.sqlite.export$.create_conn();
  for (const tx of preseed) d.transact_BANG_.cljs$core$IFn$_invoke$arity$2(conn, reader.read_string.cljs$core$IFn$_invoke$arity$1(tx));
  d.store.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), logseq.db_sync.storage.new_sqlite_storage(sql));
}

/** Loads the release SyncDO over an in-memory SQLite holding a new graph. Call close() when done. */
export async function loadReleaseSyncDO(upstream, bundle = bundlePath(upstream), { preseed = [] } = {}) {
  const dbSync = join(upstream, "deps", "db-sync");
  const dir = mkdtempSync(join(tmpdir(), "release-query-check-"));
  try {
    writeFileSync(join(dir, "main.mjs"), rewriteImports(readFileSync(bundle, "utf8")));
    for (const [i, text] of stubs(dbSync).entries()) writeFileSync(join(dir, `stub-${i}.mjs`), text);
    const map = `${bundle}.map`;
    if (existsSync(map)) copyFileSync(map, join(dir, "main.mjs.map"));
    globalThis.WebSocketRequestResponsePair ??= class {};
    const { SyncDO } = await import(pathToFileURL(join(dir, "main.mjs")).href);
    const Database = createRequire(join(dbSync, "package.json"))("better-sqlite3");
    const db = new Database(":memory:");
    const sql = {
      exec(query, ...args) {
        const stmt = db.prepare(query);
        return stmt.reader ? stmt.all(...args) : (stmt.run(...args), []);
      },
    };
    const state = {
      storage: { sql, transactionSync: (f) => db.transaction(f)() },
      getWebSockets: () => [],
      setWebSocketAutoResponse() {},
    };
    seedBuiltInGraph(upstream, sql, preseed);
    const stub = new SyncDO(state, {});
    return {
      stub,
      close() {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Sends one request to the SyncDO: {status, text, json}. */
export async function call(stub, method, path, body) {
  const url = `http://localhost${path}${path.includes("?") ? "&" : "?"}graph-id=release-check`;
  const res = await stub.fetch(
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

// Query blocks
// ============

/** The spec's Book query (2026-11-20 §8a), as a fence and as a query field. */
export const BOOK_QUERY = '{:query [:find (pull ?b [*]) :where [?b :block/tags ?t] [?t :block/title "Book"]]}';
export const BOOK_FENCE = "```query\n" + BOOK_QUERY + "\n```";

/** The two Query-block nodes the check inserts: [{from, caption, node}], each with its own uuid. */
export function queryBlockNodes() {
  return [
    { from: "fence", caption: "", node: { uuid: randomUUID(), title: BOOK_FENCE } },
    { from: "field", caption: "Release Query Caption", node: { uuid: randomUUID(), title: "Release Query Caption", query: BOOK_QUERY } },
  ];
}

const NO_RULES =
  "datalog_query takes no rules, because a tree of rules expands without reading data and can run for seconds before any cap stops it";

/** Queries a Query block must refuse, each with the start of its reason: rules as a key, and a rule called in :where. */
export const QUERY_REFUSALS = [
  {
    label: ":rules",
    query: "{:query [:find ?b :where [?b :block/title]] :rules [[(r ?b) [?b :block/title]]]}",
    reason: `query: :rules is not accepted; ${NO_RULES}`,
  },
  {
    label: "a rule call",
    query: '{:query [:find ?b :where [?b :block/title] (task ?b #{"todo"})]}',
    reason: `query: where 2: (task …) calls a rule; ${NO_RULES}`,
  },
];

/**
 * Reads Query block `uuid` back through datalog_query on the release bundle, from its datoms:
 * {tags, caption, text, displayType, lang, marker, valueMarker}, or undefined when it holds no
 * logseq.property/query value block.
 */
export async function queryBlockReadBack(stub, uuid) {
  const inputs = `[#uuid ${JSON.stringify(uuid)}]`;
  const ask = async (query) => {
    const res = await call(stub, "POST", "/semantic/query", { query, inputs });
    if (res.status !== 200) throw new Error(`read back ${uuid}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json.rows;
  };
  const [row] = await ask(
    "[:find ?caption ?text ?dt ?lang ?m ?vm :in $ ?u :where [?b :block/uuid ?u] [(get-else $ ?b :block/title \"\") ?caption]" +
      " [?b :logseq.property/query ?v] [(get-else $ ?v :block/title \"\") ?text]" +
      " [(get-else $ ?v :logseq.property.node/display-type :none) ?dt] [(get-else $ ?v :logseq.property.code/lang \"\") ?lang]" +
      " [(get-else $ ?b :user.property/claude-queryBlock false) ?m] [(get-else $ ?v :user.property/claude-queryBlock false) ?vm]]",
  );
  if (!row) return undefined;
  const tags = (await ask("[:find ?tag :in $ ?u :where [?b :block/uuid ?u] [?b :block/tags ?t] [?t :db/ident ?tag]]")).map((r) => r[0]);
  const [caption, text, displayType, lang, marker, valueMarker] = row;
  return { tags, caption, text, displayType, lang, marker, valueMarker };
}

/** Each way `got` (queryBlockReadBack's answer) differs from a stored Query block of `caption` and `text`. */
export function queryBlockReadBackErrors(got, { caption, text }) {
  if (!got) return ["no Query block read back (no logseq.property/query value block)"];
  const str = JSON.stringify;
  const errors = [];
  if (!got.tags?.includes("logseq.class/Query")) errors.push(`tags ${str(got.tags)} lack logseq.class/Query`);
  if (got.caption !== caption) errors.push(`caption ${str(got.caption)}, expected ${str(caption)}`);
  if (got.text !== text) errors.push(`query text ${str(got.text)}, expected ${str(text)}`);
  if (got.displayType !== "code") errors.push(`display type ${str(got.displayType)}, expected "code"`);
  if (got.lang !== "clojure") errors.push(`lang ${str(got.lang)}, expected "clojure"`);
  if (got.marker !== true) errors.push(`claudeQueryBlock ${str(got.marker)} on the Query block, expected true`);
  if (got.valueMarker !== false) errors.push(`claudeQueryBlock ${str(got.valueMarker)} on the value block, expected none`);
  return errors;
}

/**
 * Why `res` is not the refusal of node `path` with `reason` (a 400 whose error is `<path>: <reason>…`),
 * or null when it is; `stored` says whether the refused node's uuid reads back as a block.
 */
export function queryRefusalError(res, { path, reason }, { stored }) {
  const want = `${path}: ${reason}`;
  if (res.status !== 400) return `HTTP ${res.status}, expected 400: ${res.text.slice(0, 300)}`;
  const error = res.json?.error;
  if (typeof error !== "string" || !error.startsWith(want)) return `error ${JSON.stringify(error)}, expected ${JSON.stringify(want)}…`;
  if (stored) return "the refused block was stored";
  return null;
}

/** Throws naming each console call recorded while `step` ran. */
function assertQuiet(step, calls) {
  if (calls.length) {
    throw new Error(`${step} logged ${calls.length} time(s): ${calls.map((c) => `console.${c.level}(${c.args.map(String).join(" ").slice(0, 200)})`).join("; ")}`);
  }
}

/** The Query-block checks: insert the fence and the field, read both back, refuse the rules class. */
function queryBlockChecks(ctx) {
  const { stub } = ctx;
  const inserted = () => {
    if (!ctx.queryBlocks) throw new Error("the Query blocks were not inserted");
    return ctx.queryBlocks;
  };
  return [
    [
      "Query blocks: the Book fence and a query field insert through the release bundle, logging nothing",
      async () => {
        const nodes = queryBlockNodes();
        const { value: res, calls } = await captureConsole(() =>
          call(stub, "POST", "/semantic/block-trees", { "target-id": ctx.pageUuid, blocks: nodes.map((n) => n.node) }),
        );
        if (res.status !== 201) throw new Error(`insert: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
        assertQuiet("the insert", calls);
        const blocks = res.json?.blocks ?? [];
        for (const [i, { from, node }] of nodes.entries()) {
          const b = blocks[i] ?? {};
          if (b.uuid !== node.uuid || b.query !== BOOK_QUERY) throw new Error(`blocks[${i}] (${from}): answered ${JSON.stringify(b).slice(0, 300)}`);
          const converted = from === "fence" ? "query" : undefined;
          if (b.converted !== converted) throw new Error(`blocks[${i}] (${from}): converted ${JSON.stringify(b.converted)}, expected ${JSON.stringify(converted)}`);
        }
        ctx.queryBlocks = nodes;
      },
    ],
    [
      "Query blocks: both read back with the Query tag, the query text, :code, clojure and the marker",
      async () => {
        for (const { from, caption, node } of inserted()) {
          const errors = queryBlockReadBackErrors(await queryBlockReadBack(stub, node.uuid), { caption, text: BOOK_QUERY });
          if (errors.length) throw new Error(`the ${from} block: ${errors.join("; ")}`);
        }
      },
    ],
    [
      "Query blocks: a :rules query and a rule call are refused naming the node, store nothing and log nothing",
      async () => {
        for (const { label, query, reason } of QUERY_REFUSALS) {
          const [valid, refused] = [randomUUID(), randomUUID()];
          const { value: res, calls } = await captureConsole(() =>
            call(stub, "POST", "/semantic/block-trees", {
              "target-id": ctx.pageUuid,
              blocks: [
                { uuid: valid, title: "Release Query Valid", query: BOOK_QUERY },
                { uuid: refused, title: "Release Query Refused", query },
              ],
            }),
          );
          // Refused up front: neither the refused node nor the valid one before it is stored.
          let stored = false;
          for (const uuid of [valid, refused]) {
            const got = await call(stub, "GET", `/semantic/blocks/${uuid}`);
            if (got.status !== 404) stored = true;
          }
          const error = queryRefusalError(res, { path: "blocks[1]", reason }, { stored });
          if (error) throw new Error(`${label}: ${error}`);
          assertQuiet(`${label}: the refusal`, calls);
        }
      },
    ],
  ];
}

// The graph at scale
// ==================

const DAY_MS = 86_400_000;

/** Sizes of the scale fixture: about 20,000 blocks with each named query's material at realistic size. */
export const SCALE = {
  titles: {
    topic: "Release Topic",
    meeting: "Release Meeting",
    decision: "Release Decision",
    project: "Release Project",
    note: "releaseNote",
    client: "releaseClient",
  },
  topicPages: 2400, // tagged Release Topic, each with 3 blocks of 1 child; every 24th lacks releaseNote
  meetingPages: 100, // each with 3 blocks tagged Release Meeting, of 3 notes each
  pageMeetings: 20, // pages tagged Release Meeting, half with a decision on them
  deepLevels: 40, // a decision this many levels below its meeting, for one meeting in ten
  clients: ["Release Client A", "Release Client B", "Release Client C", "Release Client D", "Release Client E", "Release Client F"],
  taskPages: 40, // each with 10 Tasks, a quarter each Todo, Doing, Done and Canceled
  tasksPerPage: 10,
  staleProjects: 50, // Release Project pages last updated 60 to 109 days ago, 20 blocks each
  staleBlocks: 20,
  freshProjects: 100, // Release Project pages created now, 5 blocks each
};
const STATUSES = ["Todo", "Doing", "Done", "Canceled"];

/** The client the params.client checks name: held by some task pages and, on others, by tasks themselves. */
export const CLIENT = SCALE.clients[0];
/** A title a tag and a block share, with no page of that title, so params.client can't resolve it. */
export const SHARED_CLIENT = "Release Shared Client";

/** The F1 shapes of the width cap, over the scale fixture's width pages: [{label, page, blocks, query}]. */
export function f1Queries() {
  const labels = ["175 identity clauses over 100 blocks", "99 identity clauses over 200 blocks", "20 bound includes? over 500 blocks"];
  return WIDTH_SHAPES.slice(0, 3).map((spec, i) => {
    const page = `Release Width ${spec.blocks}`;
    return { label: labels[i], page, blocks: spec.blocks, query: widthQuery(spec, page) };
  });
}

/** A uuid for the n-th preseeded entity (the stale projects are written before the bundle loads). */
const preseedUuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/**
 * The scale fixture as data, for a graph seeded at `now` (ms):
 * - `stale`: the stale projects, which the dev build writes into the stored graph before the
 *   release bundle loads it (the API stamps every write with the time it runs, so it can't make a
 *   page that is old): {title, uuid, updated, blocks: [{title, uuid, updated}]};
 * - `batches`: the entries for POST /semantic/block-trees/batch, in order, at most 100 a call;
 * - `expected`: each named query's rows, as titles (and the stale updated-at), in the order the
 *   handler sorts them;
 * - `blocks`: the blocks the fixture writes (value blocks the API adds for releaseNote not counted).
 */
export function scaleFixture(now) {
  const { titles } = SCALE;
  const entries = [];
  let blocks = 0;
  const count = (trees) => {
    for (const t of trees) {
      blocks++;
      count(t.children ?? []);
    }
    return trees;
  };

  // Stale projects: one in ten has a fresh block among its own (written fresh), one in ten gets a
  // block through the API; neither is a row. The rest are, oldest first.
  const stale = [];
  const expectedStale = [];
  const appendTo = [];
  let n = 0;
  for (let i = 0; i < SCALE.staleProjects; i++) {
    const updated = now - (60 + i) * DAY_MS;
    const title = `Release stale project ${i}`;
    const page = { title, uuid: preseedUuid(++n), updated, blocks: [] };
    for (let b = 0; b < SCALE.staleBlocks; b++) {
      const fresh = i % 10 === 3 && b === SCALE.staleBlocks - 1;
      page.blocks.push({ title: `${title} block ${b}`, uuid: preseedUuid(++n), updated: fresh ? now : updated });
    }
    blocks += SCALE.staleBlocks;
    stale.push(page);
    if (i % 10 === 7) appendTo.push(title);
    else if (i % 10 !== 3) expectedStale.push([updated, title]);
  }
  expectedStale.sort((a, b) => a[0] - b[0]);

  // Clients first, so the task entries can name them.
  for (const c of SCALE.clients) entries.push({ page: c, blocks: count([{ title: `${c} profile` }]) });

  // Tagged pages, every 24th without releaseNote.
  const missing = [];
  for (let i = 0; i < SCALE.topicPages; i++) {
    const page = `Release topic ${i}`;
    const lacks = i % 24 === 5;
    if (lacks) missing.push(page);
    entries.push({
      page,
      properties: { Tags: [titles.topic], ...(lacks ? {} : { [titles.note]: `note ${i}` }) },
      blocks: count(Array.from({ length: 3 }, (_, b) => ({ title: `${page} point ${b}`, children: [{ title: `${page} detail ${b}` }] }))),
    });
  }

  // Meetings: by k (0-299), none (a row); a decision under it; one 3 levels down; 40 levels down
  // (k % 10 = 3) or beside it on the page, not under it (k % 10 = 8, a row); under one of its notes.
  const meetingRows = [];
  const beside = [];
  for (let p = 0; p < SCALE.meetingPages; p++) {
    const trees = [];
    for (let m = 0; m < 3; m++) {
      const k = p * 3 + m;
      const title = `Release meeting ${k}`;
      const notes = Array.from({ length: 3 }, (_, j) => ({ title: `${title} note ${j}` }));
      const meeting = { title, properties: { Tags: [titles.meeting] }, children: notes };
      const decision = (d) => ({ title: `${title} decision${d ? ` ${d}` : ""}`, properties: { Tags: [titles.decision] } });
      trees.push(meeting);
      switch (k % 5) {
        case 0:
          meetingRows.push(title);
          break;
        case 1:
          notes.push(decision());
          break;
        case 2:
          notes.push({ title: `${title} topic`, children: [{ title: `${title} subtopic`, children: [decision()] }] });
          break;
        case 3:
          if (k % 10 === 3) {
            let chain = decision("deep");
            for (let level = SCALE.deepLevels - 1; level >= 1; level--) chain = { title: `${title} level ${level}`, children: [chain] };
            notes.push(chain);
          } else {
            trees.push(decision("beside"));
            meetingRows.push(title);
            beside.push(title);
          }
          break;
        case 4:
          notes[0].children = [decision()];
          break;
      }
    }
    entries.push({ page: `Release meetings ${p}`, blocks: count(trees) });
  }
  for (let i = 0; i < SCALE.pageMeetings; i++) {
    const page = `Release page meeting ${i}`;
    const decided = i % 2 === 0;
    if (!decided) meetingRows.push(page);
    entries.push({
      page,
      properties: { Tags: [titles.meeting] },
      blocks: count([
        { title: `${page} agenda`, children: decided ? [{ title: `${page} decision`, properties: { Tags: [titles.decision] } }] : [] },
        { title: `${page} notes` },
      ]),
    });
  }

  // Tasks: on even pages the page names a client and the first task its own; on odd pages each task
  // names one or two clients, or none (a row under the empty client).
  const taskRows = [];
  const client = (i) => SCALE.clients[i % SCALE.clients.length];
  for (let j = 0; j < SCALE.taskPages; j++) {
    const page = `Release tasks ${j}`;
    const pageClient = j % 2 === 0 ? [client(j)] : [];
    const trees = [];
    for (let k = 0; k < SCALE.tasksPerPage; k++) {
      const title = `Release task ${j}.${k}`;
      const status = STATUSES[(j + k) % 4];
      const own = j % 2 === 0 ? (k === 0 ? [client(j + 1)] : []) : k % 5 === 4 ? [] : k % 3 === 0 ? [client(k), client(k + 1)] : [client(k)];
      trees.push({ title, properties: { Tags: ["Task"], Status: status, ...(own.length ? { [titles.client]: own } : {}) } });
      if (status === "Todo" || status === "Doing") {
        const clients = own.length ? own : pageClient.length ? pageClient : [""];
        for (const c of new Set(clients)) taskRows.push([c, title, taskRows.length]);
      }
    }
    entries.push({ page, ...(pageClient.length ? { properties: { [titles.client]: pageClient } } : {}), blocks: count(trees) });
  }
  // By client title, then creation order (each task is created after the one before it).
  taskRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[2] - b[2]));
  const clientRows = taskRows.filter(([c]) => c === CLIENT).map(([c, t]) => [c, t]);

  // Fresh projects, and a block appended to some stale ones.
  for (let i = 0; i < SCALE.freshProjects; i++) {
    const page = `Release fresh project ${i}`;
    entries.push({ page, properties: { Tags: [titles.project] }, blocks: count(Array.from({ length: 5 }, (_, b) => ({ title: `${page} step ${b}` }))) });
  }
  for (const page of appendTo) entries.push({ page, blocks: count([{ title: `${page} fresh step` }]) });

  // The width pages the F1 shapes count over.
  for (const { page, blocks: size } of f1Queries()) {
    entries.push({ page, blocks: count(Array.from({ length: size }, (_, i) => ({ title: `${page} block ${i}` }))) });
  }

  const batches = [];
  for (let i = 0; i < entries.length; i += 100) batches.push(entries.slice(i, i + 100));
  return {
    stale,
    batches,
    appended: appendTo.length,
    beside,
    blocks,
    expected: {
      "projects-untouched": expectedStale,
      "meetings-without-decision": meetingRows,
      "open-tasks-by-client": {
        rows: taskRows.slice(0, 200).map(([c, t]) => [c, t]),
        total: taskRows.length,
        client: { title: CLIENT, rows: clientRows },
      },
      "pages-missing-property": missing,
    },
  };
}

/** EDN transactions writing the stale projects (tagged Release Project, a tag they create) at their own updated-at. */
function staleTx(fixture) {
  const str = JSON.stringify;
  const tag = ":user.class/ReleaseProject-check";
  const t0 = Math.min(...fixture.stale.map((p) => p.updated));
  const txs = [
    `[{:db/ident ${tag} :block/uuid #uuid ${str(preseedUuid(0))} :block/title ${str(SCALE.titles.project)} :block/name ${str(SCALE.titles.project.toLowerCase())} :block/tags #{:logseq.class/Tag} :logseq.property.class/extends #{:logseq.class/Root} :block/created-at ${t0} :block/updated-at ${t0}}]`,
  ];
  for (const p of fixture.stale) {
    const page = `{:block/uuid #uuid ${str(p.uuid)} :block/title ${str(p.title)} :block/name ${str(p.title.toLowerCase())} :block/tags #{:logseq.class/Page ${tag}} :block/created-at ${p.updated} :block/updated-at ${p.updated}}`;
    const blocks = p.blocks.map(
      (b, i) =>
        `{:block/uuid #uuid ${str(b.uuid)} :block/title ${str(b.title)} :block/page [:block/uuid #uuid ${str(p.uuid)}] :block/parent [:block/uuid #uuid ${str(p.uuid)}] :block/order ${str(`a${i.toString(36)}`)} :block/created-at ${p.updated} :block/updated-at ${b.updated}}`,
    );
    txs.push(`[${page}]`, `[${blocks.join(" ")}]`);
  }
  return txs;
}

/**
 * Calls `fn` with console.error, warn, log and info replaced by recorders, and puts each back when
 * it settles (or throws). Resolves to {value, calls: [{level, args}]}.
 */
export async function captureConsole(fn) {
  const levels = ["error", "warn", "log", "info"];
  const original = Object.fromEntries(levels.map((l) => [l, console[l]]));
  const calls = [];
  for (const level of levels) console[level] = (...args) => calls.push({ level, args });
  try {
    const value = await fn();
    return { value, calls };
  } finally {
    for (const level of levels) console[level] = original[level];
  }
}

/** A row as titles: an entity cell ({block/uuid, block/title}) by its title, any other cell as it is. */
const cells = (row) => row.map((c) => (c && typeof c === "object" ? c["block/title"] : c));

/** Seeds the scale fixture through SyncDO.fetch (the stale projects are already in the store). */
async function seedScale(stub, fixture) {
  const ok = (step, res) => {
    if (res.status < 200 || res.status > 299) throw new Error(`${step}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  const { titles } = SCALE;
  for (const title of [titles.topic, titles.meeting, titles.decision]) ok(`create tag ${title}`, await call(stub, "POST", "/semantic/tags", { title }));
  ok(`create property ${titles.note}`, await call(stub, "POST", "/semantic/properties", { title: titles.note, type: "default" }));
  ok(
    `create property ${titles.client}`,
    await call(stub, "POST", "/semantic/properties", { title: titles.client, type: "node", cardinality: "db.cardinality/many" }),
  );
  for (const [i, entries] of fixture.batches.entries()) ok(`batch ${i}`, await call(stub, "POST", "/semantic/block-trees/batch", { entries }));
}

/** Times a call `n` times (the first pays for compiling the code it runs): [{res, ms}, …]. */
async function timed(fn, n = 2) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fn();
    out.push({ res, ms: Math.round(performance.now() - start) });
  }
  return out;
}

/** The scale checks, run after the checks above on the same graph. */
function scaleChecks(ctx) {
  const { stub } = ctx;
  const seeded = () => {
    if (!ctx.scale) throw new Error("the scale fixture was not seeded");
    return ctx.scale;
  };
  const named = (query, params) => () =>
    call(stub, "POST", `/semantic/named-queries/${query}`, { params, limit: 200 });
  const namedCheck = (query, params, expect) => [
    `at scale: run_named_query ${query} answers its exact rows within ${NAMED_MS} ms`,
    async () => {
      const fixture = seeded();
      const runs = await timed(named(query, params));
      for (const { res } of runs) {
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
      }
      const body = runs[1].res.json;
      expect(body, fixture.expected[query]);
      const slow = runs.filter(({ ms }) => ms > NAMED_MS);
      const note = `${runs[0].ms} ms, then ${runs[1].ms} ms; ${body["total-rows"]} rows; work ${JSON.stringify(body.work)}`;
      if (slow.length) throw new Error(`answered after ${note}, expected under ${NAMED_MS} ms`);
      return note;
    },
  ];
  return [
    [
      "seed about 20,000 blocks through SyncDO.fetch",
      async () => {
        const start = performance.now();
        await seedScale(stub, ctx.fixture);
        ctx.scale = ctx.fixture;
        return `${ctx.fixture.blocks} blocks (${ctx.fixture.stale.length * SCALE.staleBlocks} of them written before the bundle loaded) in ${Math.round(performance.now() - start)} ms`;
      },
    ],
    ...Object.entries(NAMED_AT_SCALE).map(([query, { params, expect }]) => namedCheck(query, params, expect)),
    ...clientChecks(ctx, seeded),
    ...f1Queries().map(({ label, query: q }) => [
      `at scale: F1 ${label} answers the width-cap 422 within ${F1_MS} ms`,
      async () => {
        seeded();
        return checkF1(stub, q);
      },
    ]),
    [
      "at scale: a datalog_query scan-cap 422 logs nothing to the console",
      async () => {
        seeded();
        await checkScanCapQuiet(stub);
      },
    ],
  ];
}

/**
 * Each named query's params on the scale fixture, and the check of its answer against the
 * fixture's expected rows (each throws naming the difference): every row compared cell for cell.
 */
export const NAMED_AT_SCALE = {
  "projects-untouched": {
    params: { tag: SCALE.titles.project, days: 30 },
    expect: (body, expected) => assertRows(body.rows.map(cells), expected),
  },
  "meetings-without-decision": {
    params: { meeting_tag: SCALE.titles.meeting, decision_tag: SCALE.titles.decision, days: 90 },
    expect: (body, expected) => {
      assertRows(body.rows.map((r) => cells(r)[1]), expected);
      const created = body.rows.map((r) => r[0]);
      if (!created.every((t, i) => Number.isInteger(t) && (i === 0 || created[i - 1] <= t))) {
        throw new Error(`created-at is not oldest first: ${JSON.stringify(created.slice(0, 20))}`);
      }
    },
  },
  "open-tasks-by-client": {
    params: { client_property: SCALE.titles.client },
    expect: (body, expected) => {
      assertRows(body.rows.map(cells), expected.rows);
      if (body["total-rows"] !== expected.total) throw new Error(`total-rows ${body["total-rows"]}, expected ${expected.total}`);
    },
  },
  "pages-missing-property": {
    params: { tag: SCALE.titles.topic, property: SCALE.titles.note },
    expect: (body, expected) => assertRows(body.rows.map((r) => cells(r)[0]), expected),
  },
};

// open-tasks-by-client with params.client (patch 0054)
// =====================================================

const CLIENT_ADVICE = {
  tasks: ["stopped after", (c) => `blocks holding ${c} or on its pages (its tasks bound)`, "blocks tagged Task (its tasks bound)"],
  "open-tasks": ["found more than", (c) => `open tasks of ${c} (its open-tasks bound)`, "open tasks (its open-tasks bound)"],
  reads: ["stopped after", () => "reads (its reads bound, the backstop over every read)", "reads (its reads bound, the backstop over every read)"],
};

/**
 * open-tasks-by-client's 422 at `bound` (tasks, open-tasks or reads) of `value`: worded for
 * `client` (its name) when given, else the advice to give one. The tasks bound counts candidates
 * before their status is read, so its advice never says to mark tasks Done.
 */
export function clientBoundMessage(bound, value, client) {
  const words = CLIENT_ADVICE[bound];
  if (!words) throw new Error(`open-tasks-by-client has no bound ${bound}`);
  const [verb, counted, plain] = words;
  const n = value.toLocaleString("en-NZ");
  const advice = client
    ? bound === "tasks"
      ? "list one of its pages' tasks with datalog_query"
      : `mark ${client}'s finished tasks Done or Canceled, or list one of its pages' tasks with datalog_query`
    : bound === "tasks"
      ? "give a client (params.client)"
      : "give a client (params.client), or mark finished tasks Done or Canceled";
  return `open-tasks-by-client ${verb} ${n} ${client ? counted(client) : plain}; ${advice}`;
}

/** The 400 for a params.client title that `matches` ([{kind, uuid}], oldest first) name. */
export function sharedTitleMessage(title, matches) {
  const each = matches.map(({ kind, uuid }) => `${title}: ${kind} ${uuid}`).join(", ");
  return `params.client: ${JSON.stringify(title)} matches ${matches.length} entities (${each}); give the one you mean by UUID`;
}

/**
 * Throws unless `body` is a client run's answer: exactly `rows` ([client title, task title], cell
 * for cell, in order) with total-rows to match, params.client echoed as {title, uuid}, and a plan
 * and work naming each of its bounds.
 */
export function expectClientRun(body, { title, uuid, rows }) {
  const echo = body.params?.client;
  if (JSON.stringify(echo) !== JSON.stringify({ title, uuid })) {
    throw new Error(`params.client echo ${JSON.stringify(echo)}, expected ${JSON.stringify({ title, uuid })}`);
  }
  assertRows(body.rows.map(cells), rows);
  if (body["total-rows"] !== rows.length) throw new Error(`total-rows ${body["total-rows"]}, expected ${rows.length}`);
  assertPlanAndWork(body, ["tasks", "open-tasks", "reads"]);
}

/** Throws unless `res` is a refusal of exactly `status` and `message`, with no rows. */
export function expectRefusal(res, status, message) {
  if (res.status !== status) throw new Error(`HTTP ${res.status}, expected ${status}: ${res.text.slice(0, 300)}`);
  if (res.json?.error !== message) throw new Error(`error ${JSON.stringify(res.json?.error)}, expected ${JSON.stringify(message)}`);
  if (res.json && "rows" in res.json) throw new Error("the refusal carries rows");
}

/**
 * Lowers each of open-tasks-by-client's bounds on the Durable Object in turn (namedQueryBounds, as
 * the upstream tests do) and checks the 422: first the tasks bound without a client (the advice to
 * give one), then tasks, open-tasks and reads with `client`, each naming it. Puts the defaults back,
 * even after a failure.
 */
export async function checkClientBounds(stub, clientProperty, client) {
  const cases = [
    ["tasks", 3, undefined],
    ["tasks", 3, client],
    ["open-tasks", 1, client],
    ["reads", 5, client],
  ];
  try {
    for (const [bound, value, given] of cases) {
      stub.namedQueryBounds = { [bound]: value };
      const params = { client_property: clientProperty, ...(given ? { client: given } : {}) };
      const res = await call(stub, "POST", "/semantic/named-queries/open-tasks-by-client", { params, limit: 200 });
      try {
        expectRefusal(res, 422, clientBoundMessage(bound, value, given));
      } catch (error) {
        throw new Error(`${bound} bound ${given ? "with" : "without"} params.client: ${error.message}`);
      }
    }
  } finally {
    delete stub.namedQueryBounds;
  }
}

/** The params.client checks on the scale fixture (patch 0054). */
function clientChecks(ctx, seeded) {
  const { stub } = ctx;
  const named = (params) => call(stub, "POST", "/semantic/named-queries/open-tasks-by-client", { params, limit: 200 });
  const ok = (step, res) => {
    if (res.status < 200 || res.status > 299) throw new Error(`${step}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  const clientUuid = async () => {
    const q = `[:find ?u :where [?e :block/name ${JSON.stringify(CLIENT.toLowerCase())}] [?e :block/uuid ?u]]`;
    const rows = ok("the client's uuid", await call(stub, "POST", "/semantic/query", { query: q })).rows;
    if (rows?.length !== 1) throw new Error(`the client's uuid: rows ${JSON.stringify(rows)}`);
    return rows[0][0];
  };
  const byClient = (how) => [
    `at scale: open-tasks-by-client with params.client by ${how} answers that client's rows of the full run and echoes it`,
    async () => {
      const { client } = seeded().expected["open-tasks-by-client"];
      const uuid = await clientUuid();
      const runs = await timed(() => named({ client_property: SCALE.titles.client, client: how === "title" ? CLIENT : uuid.toUpperCase() }));
      for (const { res } of runs) if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
      const body = runs[1].res.json;
      expectClientRun(body, { title: CLIENT, uuid, rows: client.rows });
      return `${runs[0].ms} ms, then ${runs[1].ms} ms; ${body["total-rows"]} rows; work ${JSON.stringify(body.work)}`;
    },
  ];
  return [
    byClient("title"),
    byClient("UUID"),
    [
      "at scale: open-tasks-by-client refuses a client title a tag and a block share, naming each",
      async () => {
        seeded();
        const tag = ok("create the tag", await call(stub, "POST", "/semantic/tags", { title: SHARED_CLIENT }));
        const [block] = ok(
          "insert the block",
          await call(stub, "POST", "/semantic/block-trees", { "target-id": ctx.pageUuid, blocks: [{ title: SHARED_CLIENT }] }),
        ).blocks;
        const message = sharedTitleMessage(SHARED_CLIENT, [{ kind: "tag", uuid: tag.uuid }, { kind: "block", uuid: block.uuid }]);
        expectRefusal(await named({ client_property: SCALE.titles.client, client: SHARED_CLIENT }), 400, message);
      },
    ],
    [
      "at scale: open-tasks-by-client with params.client names the client in each bound's 422",
      async () => {
        seeded();
        await checkClientBounds(stub, SCALE.titles.client, CLIENT);
      },
    ],
  ];
}

/**
 * The width cap's two 422s: a query of more than 12 function bindings, refused before it runs (as
 * the F1 shapes are), and the running charge past the cap.
 */
export const WIDTH_422 = /^query (has \d+ function bindings, more than the \d+ the width cap allows|stopped after function bindings copied [\d,]+ values \(the width cap\))/;

/**
 * Sends F1 query `q` four times: each must answer the width-cap 422, and the median of the last
 * three within F1_MS (the first also pays for compiling the code it runs, and as in the bench a
 * single run after the bulk inserts can pay for collecting their garbage, which the cap does not
 * bound). Returns the timings as a note; throws naming the status or the time.
 */
export async function checkF1(stub, q) {
  const runs = await timed(() => call(stub, "POST", "/semantic/query", { query: q }), 4);
  for (const { res } of runs) {
    if (res.status !== 422 || !WIDTH_422.test(res.json?.error ?? "")) {
      throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    }
  }
  const warm = runs.slice(1).map((r) => r.ms).sort((a, b) => a - b)[1];
  const note = `${runs[0].ms} ms, then ${runs.slice(1).map((r) => r.ms).join(", ")} ms (median ${warm} ms)`;
  if (warm > F1_MS) throw new Error(`answered after ${note}, expected under ${F1_MS} ms`);
  return note;
}

/** Sends a datalog_query that reads every datom: it must answer the scan-cap 422 and log nothing. */
export async function checkScanCapQuiet(stub) {
  const { value: res, calls } = await captureConsole(() =>
    call(stub, "POST", "/semantic/query", { query: "[:find ?e ?a ?v :where [?e ?a ?v]]" }),
  );
  if (res.status !== 422 || !String(res.json?.error).includes("(the scan cap)")) {
    throw new Error(`expected the scan-cap 422, got HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  }
  if (calls.length) {
    throw new Error(`the refusal logged ${calls.length} time(s): ${calls.map((c) => `console.${c.level}(${c.args.map(String).join(" ").slice(0, 200)})`).join("; ")}`);
  }
}

/** The checks, each a name and a function that throws with the reason on failure (or returns a note to print). */
export function checks(ctx) {
  const { stub } = ctx;
  const expectOk = (name, res) => {
    if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  const query = (q, extra = {}) => call(stub, "POST", "/semantic/query", { query: q, ...extra });
  const name = JSON.stringify(PAGE_TITLE.toLowerCase());
  return [
    [
      "a value bound by a data pattern comes back (title)",
      async () => {
        const body = expectOk("query", await query(`[:find ?t :where [?e :block/name ${name}] [?e :block/title ?t]]`));
        assertRows(body.rows, [[PAGE_TITLE]]);
      },
    ],
    [
      "a uuid bound by a data pattern comes back",
      async () => {
        const body = expectOk("query", await query(`[:find ?u :where [?e :block/name ${name}] [?e :block/uuid ?u]]`));
        assertRows(body.rows, [[ctx.pageUuid]]);
      },
    ],
    [
      "a function takes the bound value (clojure.string/includes?)",
      async () => {
        const body = expectOk(
          "query",
          await query(
            `[:find ?t :where [?e :block/name ${name}] [?e :block/title ?t] [(clojure.string/includes? ?t "Check")]]`,
          ),
        );
        assertRows(body.rows, [[PAGE_TITLE]]);
      },
    ],
    [
      "a join through a datom value matches (tag by title)",
      async () => {
        const tag = JSON.stringify(TAG_TITLE);
        const body = expectOk(
          "query",
          await query(`[:find ?id :where [?t :block/title ${tag}] [?t :block/tags ?c] [?c :db/ident ?id]]`),
        );
        assertRows(body.rows, [["logseq.class/Tag"]]);
      },
    ],
    [
      "run_named_query pages-missing-property returns the tag page",
      async () => {
        const body = expectOk(
          "named query",
          await call(stub, "POST", "/semantic/named-queries/pages-missing-property", {
            params: { tag: "Tag", property: PROPERTY_TITLE },
            limit: 200,
          }),
        );
        const titles = (body.rows ?? []).map((row) => row?.[0]?.["block/title"] ?? row?.page?.["block/title"]);
        if (!titles.includes(TAG_TITLE)) {
          throw new Error(`named query: no row titled ${TAG_TITLE}; rows: ${JSON.stringify(body.rows).slice(0, 300)}`);
        }
        assertPlanAndWork(body, ["tagged", "reads"]);
      },
    ],
    [
      "run_named_query meetings-without-decision leaves out a meeting with a decision 10 levels down",
      async () => {
        await deepChain(stub, ctx.pageUuid, 10, "Release Shallow Meeting", "Release Shallow Decision");
        const body = expectOk("named query", await meetings(stub, "Release Shallow Meeting", "Release Shallow Decision"));
        assertRows(body.rows, []);
        assertPlanAndWork(body, MEETING_BOUNDS);
      },
    ],
    [
      "run_named_query meetings-without-decision leaves out a meeting with a decision 180 levels down, quickly",
      async () => {
        await deepChain(stub, ctx.pageUuid, 181, "Release Deep Meeting", "Release Deep Decision");
        const start = performance.now();
        const res = await meetings(stub, "Release Deep Meeting", "Release Deep Decision");
        const ms = Math.round(performance.now() - start);
        const body = expectOk(`named query after ${ms} ms`, res);
        assertRows(body.rows, []);
        assertPlanAndWork(body, MEETING_BOUNDS);
        if (body.work["ancestor-steps"] < 180) {
          throw new Error(`the walk took ${body.work["ancestor-steps"]} steps up, expected at least 180: ${JSON.stringify(body.work)}`);
        }
        if (ms > 500) throw new Error(`answered after ${ms} ms, expected under 500 ms`);
      },
    ],
    ...queryBlockChecks(ctx),
    ...scaleChecks(ctx),
  ];
}

/**
 * A chain of `n` blocks on `page`, each the only child of the one before, with tags `meeting` and
 * `decision` (created here) on the top and the deepest block. Returns the top block's title.
 */
async function deepChain(stub, page, n, meeting, decision) {
  const ok = async (step, res) => {
    if (res.status < 200 || res.status > 299) throw new Error(`${step}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return res.json;
  };
  for (const title of [meeting, decision]) await ok(`create tag ${title}`, await call(stub, "POST", "/semantic/tags", { title }));
  let tree;
  for (let i = n - 1; i >= 0; i--) tree = { title: `${meeting} level ${i}`, ...(tree ? { children: [tree] } : {}) };
  const [top] = (await ok("insert the chain", await call(stub, "POST", "/semantic/block-trees", { "target-id": page, blocks: [tree] }))).blocks;
  let deepest = top;
  while (deepest.children?.length) deepest = deepest.children[0];
  const tags = encodeURIComponent("block/tags");
  await ok("tag the meeting", await call(stub, "PUT", `/semantic/blocks/${top.uuid}/properties/${tags}`, { value: [meeting] }));
  await ok("tag the decision", await call(stub, "PUT", `/semantic/blocks/${deepest.uuid}/properties/${tags}`, { value: [decision] }));
  return top.title;
}

const meetings = (stub, meeting, decision) =>
  call(stub, "POST", "/semantic/named-queries/meetings-without-decision", {
    params: { meeting_tag: meeting, decision_tag: decision, days: 3650 },
    limit: 200,
  });

// meetings-without-decision's bounds, as plan names them and work counts them.
export const MEETING_BOUNDS = ["meetings", "decisions", "ancestor-steps", "reads"];

/** A named-query answer carries plan (naming each bound) and work (a count per bound), and no Datalog. */
export function assertPlanAndWork(body, bounds) {
  for (const bound of bounds) {
    if (!String(body.plan ?? "").includes(`(${bound} bound `)) {
      throw new Error(`plan does not name the ${bound} bound: ${JSON.stringify(body.plan)?.slice(0, 300)}`);
    }
    if (!Number.isInteger(body.work?.[bound])) throw new Error(`work has no ${bound} count: ${JSON.stringify(body.work)}`);
  }
  for (const gone of ["query", "inputs", "rules"]) {
    if (gone in body) throw new Error(`the answer still carries ${gone}`);
  }
}

/** Throws unless `actual` holds the same rows as `expected`, cell for cell, in the same order. */
export function assertRows(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`rows ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

/** Creates the fixture and runs every check. Returns [{name, ok, error?}]. */
export async function runReleaseQueryCheck(upstream, { bundle } = {}) {
  const fixture = scaleFixture(Date.now());
  const { stub, close } = await loadReleaseSyncDO(upstream, bundle, { preseed: staleTx(fixture) });
  try {
    const ctx = { stub, fixture };
    for (const [path, body] of [
      ["/semantic/tags", { title: TAG_TITLE }],
      ["/semantic/properties", { title: PROPERTY_TITLE, type: "default" }],
      ["/semantic/pages", { title: PAGE_TITLE }],
    ]) {
      const res = await call(stub, "POST", path, body);
      if (res.status < 200 || res.status > 299) throw new Error(`setup ${path}: HTTP ${res.status}: ${res.text.slice(0, 300)}`);
      if (path === "/semantic/pages") ctx.pageUuid = res.json?.uuid;
    }
    if (!ctx.pageUuid) throw new Error("setup /semantic/pages: no uuid in the response");
    const results = [];
    for (const [name, fn] of checks(ctx)) {
      try {
        const note = await fn();
        results.push({ name, ok: true, ...(typeof note === "string" ? { note } : {}) });
      } catch (error) {
        results.push({ name, ok: false, error: error.message });
      }
    }
    return results;
  } finally {
    close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--bundle");
  const bundleArg = at >= 0 ? args.splice(at, 2)[1] : undefined;
  if (at >= 0 && !bundleArg) {
    console.error("usage: release-query-check.mjs [upstream-dir] [--bundle <main.js>]");
    process.exit(2);
  }
  const upstream = resolve(args[0] ?? join(root, ".upstream"));
  const bundle = resolve(bundleArg ?? bundlePath(upstream));
  if (!existsSync(bundle)) {
    console.error(`release bundle missing: ${bundle} (run scripts/build.sh ${upstream})`);
    process.exit(2);
  }
  const build = findBuild(upstream);
  if (build.missing) {
    console.error(`dev build missing: ${build.missing}`);
    process.exit(2);
  }
  const results = await runReleaseQueryCheck(upstream, { bundle });
  for (const r of results) {
    console.log(`${r.ok ? "ok    " : "FAILED"} ${r.name}${r.ok ? "" : `: ${r.error}`}`);
    if (r.note) console.log(`       ${r.note}`);
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
