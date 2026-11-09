// Bench for datalog_query's scan cap (spec 2026-11-09 §3.5, §5, §7 risks 1 and 3).
//
// The query runs in the sync Worker's graph Durable Object, where the clock does not move during
// synchronous CPU work, so the scan cap (datoms the privacy filter is asked about) is the only
// bound, and it is set from this bench. It loads upstream db-sync's compiled test build from
// .upstream (the real handler namespace, Datascript fork and Logseq schema), builds a seeded N-page
// graph in memory, stores it through the Durable Object's own SQLite storage adapter
// (storage/new-sqlite-storage over an in-memory kvs table) and, for each shape, restores a fresh
// conn from that storage, so the cold run loads B-tree nodes lazily as the Durable Object does
// after a wake. It then times the handler's own parse, validation and run-query (which builds the
// private set, filters, sorts, pulls and serialises), cold and then warm, without HTTP.
//
//   node scripts/bench-datalog-query.mjs [--pages 5000,20000] [--runs 5] [--scan-cap N]
//                                        [--shapes a,b] [--upstream .upstream] [--json]
//
// Warm times are medians over --runs runs on the conn the cold run warmed. The numbers are a guide:
// Node on a developer machine is not a Durable Object on Cloudflare's hardware.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PAGES = [5_000, 20_000];
export const DEFAULT_RUNS = 5;
/** Blocks per page (top level), each with up to two children. */
const BLOCKS_PER_PAGE = 4;
/** Depth of the one deep chain of nested blocks the recursive rule walks. */
const CHAIN_DEPTH = 60;
/** The CPU tail README records as tolerated on the Free plan (spec §5). */
export const TOLERATED_MS = 92;

/**
 * The shapes, in output order. private-set times private-ids alone; the others run the whole
 * handler path (parse, validate, run-query) with the given body.
 */
export const SHAPES = [
  "private-set",
  "scan-cap",
  "or-join-wide",
  "rule-recursive",
  "rule-deep-chain",
  "not-join-fanout",
  "join-fanout",
  "pull-star-200",
];

const ANCESTOR_RULES = `[[(anc ?c ?a) [?c :block/parent ?a]]
 [(anc ?c ?a) [?c :block/parent ?p] (anc ?p ?a)]]`;

/** Request bodies (the fields POST /query takes) per shape. */
export const BODIES = {
  // Every datom: what a query with no selective clause costs before the cap stops it.
  "scan-cap": { query: "[:find ?e ?a ?v :where [?e ?a ?v]]" },
  // Eight branches, each a lookup per bound ?b: join work the cap counts only as datoms read.
  "or-join-wide": {
    query: `[:find ?b :where [?b :block/page ?p]
             (or-join [?b] [?b :block/tags ?x] [?b :block/refs ?x] [?b :block/link ?x]
                           [?b :block/path-refs ?x] [?b :logseq.property/status ?x]
                           [?b :logseq.property/priority ?x] [?b :block/collapsed? ?x]
                           [?b :logseq.property/deadline ?x])]`,
  },
  // A right-recursive closure with neither end bound: every block's ancestors, through a chain
  // 60 deep. Allowed (a data pattern binds ?p before the call), bounded only by the cap.
  "rule-recursive": { query: "[:find ?c ?a :in $ % :where (anc ?c ?a)]", rules: ANCESTOR_RULES },
  // The same rule bound to the leaf of the 60-deep chain: a few datoms per level, but Datascript's
  // rule solver adds a guard per level, so the work grows faster than the datoms it reads.
  "rule-deep-chain": {
    query: `[:find ?a :in $ % :where [?c :block/title "chain 59"] (anc ?c ?a)]`,
    rules: ANCESTOR_RULES,
  },
  // For every page, a three-clause not-join: the anti-join's fan-out over blocks, refs and tags.
  "not-join-fanout": {
    query: `[:find ?p :where [?p :block/name ?n]
             (not-join [?p] [?b :block/page ?p] [?b :block/refs ?r] [?r :block/tags ?t])]`,
  },
  // A self-join on the 60 blocks tagged Bench Chain: not a cross product, as ?t joins every
  // clause, but it matches 60 × 60 rows from the few datoms it reads, over the row cap (2,500),
  // so it times d/q and the refusal before the sort.
  "join-fanout": {
    query: `[:find ?a ?c :where [?t :block/name "bench chain"] [?a :block/tags ?t] [?c :block/tags ?t]]`,
  },
  // A wildcard pull at the maximum limit: 200 full entities pulled and serialised.
  "pull-star-200": {
    query: `[:find (pull ?b [*]) :where [?t :block/name "bench project"] [?b :block/tags ?t]]`,
    limit: 200,
  },
};

/** A small seeded PRNG (mulberry32), so the fixture is the same on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "workflow review project client meeting decision idea research budget forecast roadmap delivery " +
  "platform report data model team strategy design product customer service partner finance audit " +
  "risk policy process quality support account market growth pricing contract vendor training"
).split(" ");
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = (rand) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;

/** The tags the fixture creates, by title. Private is the class the privacy filter looks for. */
export const TAGS = ["Private", "Bench Project", "Bench Topic", "Bench Chain"];

/**
 * A seeded graph of `pages` pages as plain data: {tags, pages, chain}. About one page in ten is
 * a Bench Project, one in twenty-five Private; each page has BLOCKS_PER_PAGE blocks with up to two
 * children, and about one block in four refs another page; one in twenty is tagged Bench Topic.
 * `chain` is CHAIN_DEPTH nested blocks on the first page, each tagged Bench Chain.
 */
export function makeFixture(pages, seed = 1) {
  const rand = prng(seed);
  const tags = TAGS.map((title) => ({ title, uuid: uuid(rand) }));
  const out = [];
  for (let i = 0; i < pages; i++) {
    const n = 1 + Math.floor(rand() * 3);
    const title = `${Array.from({ length: n }, () => cap(pick(rand, WORDS))).join(" ")} ${i}`;
    const pageTags = [];
    if (rand() < 0.1) pageTags.push("Bench Project");
    if (rand() < 0.04) pageTags.push("Private");
    out.push({ uuid: uuid(rand), title, tags: pageTags, blocks: [] });
  }
  for (const page of out) {
    for (let b = 0; b < BLOCKS_PER_PAGE; b++) {
      const refs = rand() < 0.25 ? [pick(rand, out).uuid] : [];
      const block = {
        uuid: uuid(rand),
        title: `${cap(pick(rand, WORDS))} ${pick(rand, WORDS)} ${pick(rand, WORDS)}`,
        refs,
        tags: rand() < 0.05 ? ["Bench Topic"] : [],
        children: [],
      };
      const kids = Math.floor(rand() * 3);
      for (let k = 0; k < kids; k++) {
        block.children.push({ uuid: uuid(rand), title: `${pick(rand, WORDS)} note ${k}`, refs: [], tags: [], children: [] });
      }
      page.blocks.push(block);
    }
  }
  const chain = Array.from({ length: CHAIN_DEPTH }, (_, d) => ({ uuid: uuid(rand), title: `chain ${d}` }));
  return { tags, pages: out, chain };
}

// Loading the build
// =================

/** The compiled test build of a patched upstream checkout, or why it can't be loaded. */
export function findBuild(checkout) {
  const dir = join(checkout, "deps", "db-sync");
  const entry = join(dir, "worker", "dist", "worker-test.js");
  const runtime = join(dir, ".shadow-cljs", "builds", "db-sync-test", "dev", "out", "cljs-runtime");
  const datalog = join(runtime, "logseq.db_sync.worker.handler.datalog.js");
  const shown = (p) => relative(root, p) || p;
  if (!existsSync(entry) || !existsSync(runtime)) {
    return { missing: `${shown(entry)} is missing: compile upstream db-sync's test build first (scripts/fetch-upstream.sh .upstream, then scripts/upstream-test.sh .upstream or pnpm test in deps/db-sync; scripts/build.sh alone removes it)` };
  }
  if (!existsSync(datalog)) {
    return { missing: `${shown(datalog)} is missing: the build predates patch 0039; recompile it with scripts/upstream-test.sh` };
  }
  return { dir, entry };
}

/**
 * Loads the build into this process without running its tests: the build's own loader with the
 * line that calls the test runner's main left out. Returns the ClojureScript namespaces.
 */
export function loadBuild({ entry }) {
  const main = 'SHADOW_IMPORT("shadow.module.main.append.js");';
  const source = readFileSync(entry, "utf8").replace(/^#!.*\n/, "");
  if (!source.includes(main)) throw new Error(`${entry}: no test runner main to leave out`);
  const code = `(function (require, module, __filename, __dirname) {\n${source.replace(main, "")}\n})`;
  const fn = vm.runInThisContext(code, { filename: entry });
  fn.call(globalThis, createRequire(entry), { exports: {} }, entry, dirname(entry));
  const g = globalThis;
  return { cljs: g.cljs.core, reader: g.cljs.reader, d: g.datascript.core, logseq: g.logseq };
}

// Running
// =======

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (ms) => Math.round(ms * 100) / 100;

/** EDN for the fixture's transaction, in chunks of about `size` entities. */
function fixtureTx(fixture, now) {
  const str = (s) => JSON.stringify(s);
  const ident = (t) => `:user.class/${t.title.replace(/\s+/g, "")}-bench`;
  const byTitle = Object.fromEntries(fixture.tags.map((t) => [t.title, t]));
  const tagRefs = (titles, page) =>
    `#{${[...(page ? [":logseq.class/Page"] : []), ...titles.map((t) => ident(byTitle[t]))].join(" ")}}`;
  const chunks = [];
  chunks.push(
    fixture.tags
      .map(
        (t) =>
          `{:db/ident ${ident(t)} :block/uuid #uuid ${str(t.uuid)} :block/title ${str(t.title)} :block/name ${str(t.title.toLowerCase())} :block/tags #{:logseq.class/Tag} :logseq.property.class/extends #{:logseq.class/Root} :block/created-at ${now} :block/updated-at ${now}}`,
      )
      .join(" "),
  );
  chunks.push(
    fixture.pages
      .map(
        (p) =>
          `{:block/uuid #uuid ${str(p.uuid)} :block/title ${str(p.title)} :block/name ${str(p.title.toLowerCase())} :block/tags ${tagRefs(p.tags, true)} :block/created-at ${now} :block/updated-at ${now}}`,
      )
      .join(" "),
  );
  let order = 0;
  const block = (b, page, parent) => {
    const refs = b.refs.length ? ` :block/refs #{${b.refs.map((r) => `[:block/uuid #uuid ${str(r)}]`).join(" ")}}` : "";
    const tags = b.tags?.length ? ` :block/tags ${tagRefs(b.tags, false)}` : "";
    return `{:block/uuid #uuid ${str(b.uuid)} :block/title ${str(b.title)} :block/page [:block/uuid #uuid ${str(page)}] :block/parent [:block/uuid #uuid ${str(parent)}] :block/order ${str(`a${(order++).toString(36)}`)} :block/created-at ${now} :block/updated-at ${now}${refs}${tags}}`;
  };
  for (let i = 0; i < fixture.pages.length; i += 500) {
    const top = [];
    const kids = [];
    for (const p of fixture.pages.slice(i, i + 500)) {
      for (const b of p.blocks) {
        top.push(block(b, p.uuid, p.uuid));
        for (const c of b.children) kids.push(block(c, p.uuid, b.uuid));
      }
    }
    chunks.push(top.join(" "));
    chunks.push(kids.join(" "));
  }
  const first = fixture.pages[0].uuid;
  let parent = first;
  for (const c of fixture.chain) {
    chunks.push(block({ ...c, refs: [], tags: ["Bench Chain"] }, first, parent));
    parent = c.uuid;
  }
  return chunks.map((c) => `[${c}]`);
}

/** An in-memory stand-in for the Durable Object's SQL kvs table, counting the nodes it restores. */
function memorySql() {
  const kvs = new Map();
  const sql = {
    restored: 0,
    exec(statement, ...args) {
      if (statement.includes("insert into kvs")) {
        const [addr, content, addresses] = args;
        kvs.set(addr, { content, addresses });
        return [];
      }
      if (statement.includes("from kvs where addr")) {
        const row = kvs.get(args[0]);
        if (!row) return [];
        sql.restored++;
        return [{ content: row.content, addresses: row.addresses }];
      }
      return [];
    },
  };
  return sql;
}

/** Builds the fixture graph and stores it, so each shape can restore a cold conn. */
export function storeGraph(ns, pages, seed) {
  const { cljs, reader, d, logseq } = ns;
  const conn = logseq.db.sqlite.export$.create_conn();
  const now = 1_762_646_400_000; // 2025-11-09, fixed so the fixture is the same on every run
  for (const chunk of fixtureTx(makeFixture(pages, seed), now)) d.transact_BANG_.cljs$core$IFn$_invoke$arity$2(conn, reader.read_string.cljs$core$IFn$_invoke$arity$1(chunk));
  const sql = memorySql();
  const storage = logseq.db_sync.storage.new_sqlite_storage(sql);
  d.store.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), storage);
  const datoms = cljs.count(d.datoms.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), cljs.keyword("eavt")));
  return { sql, storage, datoms };
}

export function restore(ns, graph) {
  const { cljs, d } = ns;
  return cljs.deref(d.restore_conn.cljs$core$IFn$_invoke$arity$1(graph.storage));
}

function body(ns, b) {
  const { cljs } = ns;
  const kv = [];
  for (const [k, v] of Object.entries(b)) kv.push(cljs.keyword(k), v);
  return cljs.hash_map(...kv);
}

/** One run of a shape on `db`: {ms, scanned, outcome, rows}. */
export function runShape(ns, shape, db, scanCap) {
  const { cljs, logseq } = ns;
  const datalog = logseq.db_sync.worker.handler.datalog;
  const kw = cljs.keyword;
  const get = (m, k) => cljs.get.cljs$core$IFn$_invoke$arity$2(m, k);
  if (shape === "private-set") {
    const t0 = performance.now();
    const ids = datalog.private_ids(db);
    return { ms: performance.now() - t0, scanned: 0, outcome: "rows", rows: cljs.count(ids) };
  }
  const t0 = performance.now();
  cljs.reset_BANG_(datalog.last_run, cljs.hash_map(kw("private-set-built?"), false, kw("scanned"), 0, kw("pulled"), 0));
  const given = BODIES[shape];
  const parsed = datalog.parse_request(body(ns, given));
  const status = kw("logseq.db-sync.worker.handler.datalog", "status");
  let result = parsed;
  if (!cljs.contains_QMARK_(parsed, status)) {
    const opts = cljs.hash_map(
      kw("query"), get(parsed, kw("query")),
      kw("inputs"), get(parsed, kw("inputs")),
      kw("rules"), get(parsed, kw("rules")),
      kw("limit"), given.limit ?? datalog.default_limit,
      kw("scan-cap"), scanCap,
      kw("echo"), cljs.hash_map(kw("query"), given.query, kw("inputs"), "[]"),
    );
    result = datalog.run_query(db, opts);
  }
  const ms = performance.now() - t0;
  const scanned = get(cljs.deref(datalog.last_run), kw("scanned"));
  const refused = get(result, status);
  if (refused != null) {
    const error = get(result, kw("logseq.db-sync.worker.handler.datalog", "error"));
    const outcome =
      refused !== 422 ? "refused"
      : error.includes("the row cap of") ? "row-cap"
      : error.includes("(the join cap)") ? "join-cap"
      : error.includes("(the value cap)") ? "value-cap"
      : "scan-cap";
    return { ms, scanned, outcome, rows: 0, error };
  }
  return { ms, scanned, outcome: "rows", rows: get(result, kw("returned")), total: get(result, kw("total-rows")) };
}

export async function bench({ pages = DEFAULT_PAGES, runs = DEFAULT_RUNS, scanCap, shapes = SHAPES, upstream = join(root, ".upstream"), seed = 1 } = {}) {
  const build = findBuild(upstream);
  if (build.missing) return { skipped: build.missing };
  const ns = loadBuild(build);
  const datalog = ns.logseq.db_sync.worker.handler.datalog;
  const cap = scanCap ?? datalog.scan_cap;
  const records = [];
  for (const size of pages) {
    const graph = storeGraph(ns, size, seed);
    for (const shape of shapes) {
      const before = graph.sql.restored;
      const db = restore(ns, graph);
      const cold = runShape(ns, shape, db, cap);
      const nodesLoaded = graph.sql.restored - before;
      const warm = [];
      let last = cold;
      for (let i = 0; i < runs; i++) {
        last = runShape(ns, shape, db, cap);
        warm.push(last.ms);
      }
      records.push({
        shape,
        pages: size,
        datoms: graph.datoms,
        cold_ms: round(cold.ms),
        warm_ms: round(median(warm)),
        datoms_scanned: last.scanned,
        outcome: last.outcome,
        rows: last.rows,
        ...(last.total != null ? { total_rows: last.total } : {}),
        ...(last.error ? { error: last.error } : {}),
        nodes_loaded_cold: nodesLoaded,
      });
    }
  }
  return { scan_cap: cap, runs, tolerated_ms: TOLERATED_MS, node: process.version, records };
}

function parseArgs(argv) {
  const opts = { pages: DEFAULT_PAGES, runs: DEFAULT_RUNS, json: false };
  const whole = (flag, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number of at least 1, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--pages") opts.pages = String(argv[++i]).split(",").map((v) => whole(a, v));
    else if (a === "--runs") opts.runs = whole(a, argv[++i]);
    else if (a === "--scan-cap") opts.scanCap = whole(a, argv[++i]);
    else if (a === "--upstream") opts.upstream = resolve(argv[++i] ?? "");
    else if (a === "--shapes") {
      opts.shapes = String(argv[++i]).split(",");
      for (const s of opts.shapes) if (!SHAPES.includes(s)) throw new Error(`--shapes: unknown shape ${s} (shapes: ${SHAPES.join(", ")})`);
    }
    else throw new Error(`unknown argument ${a}; usage: bench-datalog-query.mjs [--pages N[,N…]] [--runs N] [--scan-cap N] [--shapes NAME[,NAME…]] [--upstream DIR] [--json]`);
  }
  return opts;
}

const fmt = (n) => n.toLocaleString("en-NZ");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const r = await bench(opts);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else if (r.skipped) console.log(`skipped: ${r.skipped}`);
  else {
    console.log(`datalog_query bench: scan cap ${fmt(r.scan_cap)}, warm median of ${r.runs} runs, Node ${r.node} (tolerated tail ${r.tolerated_ms} ms)`);
    console.log("shape              pages    datoms  cold_ms  warm_ms  scanned  outcome   rows  nodes_cold");
    for (const x of r.records) {
      console.log(
        [
          x.shape.padEnd(18),
          String(x.pages).padStart(6),
          String(x.datoms).padStart(9),
          x.cold_ms.toFixed(1).padStart(8),
          x.warm_ms.toFixed(1).padStart(8),
          String(x.datoms_scanned).padStart(8),
          x.outcome.padEnd(8),
          String(x.rows).padStart(6),
          String(x.nodes_loaded_cold).padStart(11),
        ].join(" "),
      );
    }
  }
}
