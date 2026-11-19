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
//   node scripts/bench-datalog-query.mjs --named [--bounds reads=N,tagged=N…] [--pages …] [--runs …]
//   node scripts/bench-datalog-query.mjs --width [--width-cap N] [--pages …] [--runs …]
//
// --named runs the four named queries as code (named-queries/run-named on the restored db, as the
// handler does after resolving params) under default-bounds, or the values --bounds gives, and
// reports the work each bound counted. Every Bench Project page is older than 30 days, so
// projects-untouched reads every block on them; open-tasks-by-client reads each task's
// :block/refs as its clients, which walks as a node property does. --width runs the F1 shapes
// (many function bindings over one page's blocks; more than 12, so the width cap refuses them
// before they run) and the 3-binding query over 2,500 blocks through run-query under the width
// cap, or --width-cap, and reports the width charged.
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
/** Depth of the one deep chain of nested blocks, each tagged Bench Chain (join-fanout's self-join). */
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
  "not-join-fanout",
  "join-fanout",
  "pull-star-200",
];

/**
 * Request bodies (the fields POST /query takes) per shape. datalog_query takes no rules (patch 0039
 * stage 3 removed them), so no shape has any.
 */
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
/** The tags the named-query extras add, from their own stream (so the shapes' fixture is unchanged). */
export const NAMED_TAGS = ["Bench Meeting", "Bench Decision"];
const TASK_STATUSES = ["todo", "doing", "done", "canceled"];

/** The pages a width shape counts over: one page of `blocks` blocks each. */
export const WIDTH_SHAPES = [
  { shape: "f1-identity-175", blocks: 100, clauses: () => identityClauses(175) },
  { shape: "f1-identity-99", blocks: 200, clauses: () => identityClauses(99) },
  {
    shape: "f1-includes-20",
    blocks: 500,
    clauses: () => Array.from({ length: 20 }, (_, i) => `[(clojure.string/includes? ?t "block") ?b${i}]`),
  },
  // Three function bindings in all, the title's get-else (in widthQuery) and these two.
  { shape: "three-bindings", blocks: 2500, clauses: () => ["[(identity ?t) ?a]", "[(clojure.string/lower-case ?t) ?b]"] },
];

function identityClauses(n) {
  return Array.from({ length: n }, (_, i) => `[(identity ?t) ?r${i}]`);
}

/**
 * A width shape's query: a count of the blocks on page `title` (titled "… block N"), with its
 * clauses. It reads only that page's datoms whatever the graph's size: the page by :block/name
 * (indexed) and each block's title with get-else (one datom a row). A data pattern such as
 * [?p :block/title "…"] or [?e :block/title ?t] joined to many rows scans every title, which on a
 * graph of 20,000 blocks stops at the scan cap before any function binding runs.
 */
export function widthQuery(spec, title) {
  return `[:find (count ?e) . :where [?p :block/name ${JSON.stringify(title.toLowerCase())}] [?e :block/page ?p] [(get-else $ ?e :block/title "") ?t] ${spec.clauses().join(" ")}]`;
}

/**
 * A seeded graph of `pages` pages as plain data: {tags, pages, chain}. About one page in ten is
 * a Bench Project, one in twenty-five Private; each page has BLOCKS_PER_PAGE blocks with up to two
 * children, and about one block in four refs another page; one in twenty is tagged Bench Topic.
 * `chain` is CHAIN_DEPTH nested blocks on the first page, each tagged Bench Chain.
 */
export function makeFixture(pages, seed = 1, { width = false } = {}) {
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
  // The named-query extras, from a second stream: about one top block in eight is a Bench Meeting
  // with each child a Bench Decision half the time, and about one block in ten a Task with a status.
  const extra = prng(seed ^ 0x5eed);
  for (const title of NAMED_TAGS) tags.push({ title, uuid: uuid(extra) });
  for (const page of out) {
    for (const block of page.blocks) {
      if (extra() < 0.125) {
        block.tags = [...block.tags, "Bench Meeting"];
        for (const child of block.children) if (extra() < 0.5) child.tags = ["Bench Decision"];
      } else if (extra() < 0.1) {
        block.task = pick(extra, TASK_STATUSES);
      }
    }
  }
  const widthPages = !width
    ? []
    : WIDTH_SHAPES.map(({ blocks }) => ({
        uuid: uuid(extra),
        title: `Bench Width ${blocks}`,
        blocks: Array.from({ length: blocks }, (_, i) => ({ uuid: uuid(extra), title: `Bench Width ${blocks} block ${i}` })),
      }));
  return { tags, pages: out, chain, width: widthPages };
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
export function fixtureTx(fixture, now) {
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
    const idents = [...(b.task ? [":logseq.class/Task"] : []), ...(b.tags ?? []).map((t) => ident(byTitle[t]))];
    const tags = (idents.length ? ` :block/tags #{${idents.join(" ")}}` : "") + (b.task ? ` :logseq.property/status :logseq.property/status.${b.task}` : "");
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
  for (const p of fixture.width ?? []) {
    chunks.push(`{:block/uuid #uuid ${str(p.uuid)} :block/title ${str(p.title)} :block/name ${str(p.title.toLowerCase())} :block/tags #{:logseq.class/Page} :block/created-at ${now} :block/updated-at ${now}}`);
    chunks.push(p.blocks.map((b) => block({ ...b, refs: [] }, p.uuid, p.uuid)).join(" "));
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
export function storeGraph(ns, pages, seed, opts = {}) {
  const { cljs, reader, d, logseq } = ns;
  const conn = logseq.db.sqlite.export$.create_conn();
  const now = 1_762_646_400_000; // 2025-11-09, fixed so the fixture is the same on every run
  for (const chunk of fixtureTx(makeFixture(pages, seed, opts), now)) d.transact_BANG_.cljs$core$IFn$_invoke$arity$2(conn, reader.read_string.cljs$core$IFn$_invoke$arity$1(chunk));
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

/**
 * One run of a shape on `db`: {ms, scanned, width, outcome, rows}. `given` is the request body (the
 * shape's own in BODIES by default) and `widthCap` the width cap (the build's when not given).
 */
export function runShape(ns, shape, db, scanCap, given = BODIES[shape], widthCap) {
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
  cljs.reset_BANG_(datalog.last_run, cljs.hash_map(kw("private-set-built?"), false, kw("scanned"), 0, kw("width"), 0, kw("pulled"), 0));
  const parsed = datalog.parse_request(body(ns, given));
  const status = kw("logseq.db-sync.worker.handler.datalog", "status");
  let result = parsed;
  if (!cljs.contains_QMARK_(parsed, status)) {
    const opts = cljs.hash_map(
      kw("query"), get(parsed, kw("query")),
      kw("inputs"), get(parsed, kw("inputs")),
      kw("limit"), given.limit ?? datalog.default_limit,
      kw("scan-cap"), scanCap,
      ...(widthCap != null ? [kw("width-cap"), widthCap] : []),
      kw("echo"), cljs.hash_map(kw("query"), given.query, kw("inputs"), "[]"),
    );
    result = datalog.run_query(db, opts);
  }
  const ms = performance.now() - t0;
  const scanned = get(cljs.deref(datalog.last_run), kw("scanned"));
  const width = get(cljs.deref(datalog.last_run), kw("width"));
  const refused = get(result, status);
  if (refused != null) {
    const error = get(result, kw("logseq.db-sync.worker.handler.datalog", "error"));
    const outcome =
      refused !== 422 ? "refused"
      : error.includes("the row cap of") ? "row-cap"
      : error.includes("(the join cap)") ? "join-cap"
      : error.includes("(the value cap)") ? "value-cap"
      : error.includes("(the scan cap)") ? "scan-cap"
      : error.includes("(the width cap)") || error.includes("the width cap allows") ? "width-cap"
      : "refused";
    return { ms, scanned, width, outcome, rows: 0, error };
  }
  return { ms, scanned, width, outcome: "rows", rows: get(result, kw("returned")), total: get(result, kw("total-rows")) };
}

// Named queries and the width cap
// ===============================

/** The named queries, in output order, and the bounds each counts (named-queries/named-queries). */
export const NAMED = {
  "projects-untouched": ["tagged", "page-blocks", "reads"],
  "meetings-without-decision": ["meetings", "decisions", "ancestor-steps", "reads"],
  "open-tasks-by-client": ["tasks", "open-tasks", "reads"],
  "pages-missing-property": ["tagged", "reads"],
};
/** Every named bound, as default-bounds names them. */
export const NAMED_BOUNDS = ["meetings", "decisions", "ancestor-steps", "tagged", "page-blocks", "tasks", "open-tasks", "reads"];
const DAY_MS = 86_400_000;

/**
 * The resolved inputs (by param name) and params echo the handler would give each named query on
 * the bench fixture, as EDN: Bench Project pages older than 30 days; Bench Meetings created in the
 * last 3,650 days (the fixture's fixed date is within it) with Bench Decisions; Tasks with their
 * :block/refs as clients; Bench Project pages with no Description.
 */
function namedInputs(ns, db, query) {
  const { cljs, d } = ns;
  const tag = (title) => d.entid(db, cljs.keyword("user.class", `${title.replace(/\s+/g, "")}-bench`));
  const now = Date.now();
  const echo = (title) => `{:title ${JSON.stringify(title)} :includes []}`;
  switch (query) {
    case "projects-untouched":
      return `{:inputs {:tag [${tag("Bench Project")}] :days ${now - 30 * DAY_MS}} :params {"tag" ${echo("Bench Project")} "days" 30}}`;
    case "meetings-without-decision":
      return `{:inputs {:meeting_tag [${tag("Bench Meeting")}] :decision_tag #{${tag("Bench Decision")}} :days ${now - 3650 * DAY_MS}} :params {"meeting_tag" ${echo("Bench Meeting")} "decision_tag" ${echo("Bench Decision")} "days" 3650}}`;
    case "open-tasks-by-client":
      return `{:inputs {:client_property :block/refs} :params {"client_property" {:title "Refs"}}}`;
    case "pages-missing-property":
      return `{:inputs {:tag [${tag("Bench Project")}] :property :logseq.property/description} :params {"tag" ${echo("Bench Project")} "property" {:title "Description"}}}`;
  }
  throw new Error(`no named query ${query}`);
}

/** One run of named query `query` on `db` under `bounds` (EDN): {ms, outcome, rows, work, bound?}. */
export function runNamed(ns, query, db, bounds) {
  const { cljs, reader } = ns;
  const named = ns.logseq.db_sync.worker.named_queries;
  const read = (edn) => reader.read_string.cljs$core$IFn$_invoke$arity$1(edn);
  const resolved = read(namedInputs(ns, db, query));
  const work = cljs.volatile_BANG_(cljs.PersistentArrayMap.EMPTY);
  const t0 = performance.now();
  try {
    const result = named.run_named.cljs$core$IFn$_invoke$arity$5(query, db, resolved, read(bounds), work);
    const ms = performance.now() - t0;
    return { ms, outcome: "rows", rows: cljs.count(cljs.get.cljs$core$IFn$_invoke$arity$2(result, cljs.keyword("rows"))), work: cljs.clj__GT_js(cljs.deref(work)) };
  } catch (e) {
    const ms = performance.now() - t0;
    const data = cljs.ex_data(e);
    const bound = data && cljs.get.cljs$core$IFn$_invoke$arity$2(data, cljs.keyword("logseq.db-sync.worker.named-queries", "bound"));
    if (!bound) throw e;
    const which = cljs.clj__GT_js(bound);
    return { ms, outcome: "bound", rows: 0, work: cljs.clj__GT_js(cljs.deref(work)), bound: which.bound, error: named.bound_message(bound) };
  }
}

function boundsEdn(bounds) {
  return `{${Object.entries(bounds).map(([k, v]) => `:${k} ${v}`).join(" ")}}`;
}

/** --named: each named query at each size, cold then warm, with the work each of its bounds counted. */
export async function benchNamed({ pages = DEFAULT_PAGES, runs = DEFAULT_RUNS, bounds = {}, upstream = join(root, ".upstream"), seed = 1 } = {}) {
  const build = findBuild(upstream);
  if (build.missing) return { skipped: build.missing };
  const ns = loadBuild(build);
  const given = { ...ns.cljs.clj__GT_js(ns.logseq.db_sync.worker.named_queries.default_bounds), ...bounds };
  const records = [];
  for (const size of pages) {
    const graph = storeGraph(ns, size, seed);
    for (const [query, own] of Object.entries(NAMED)) {
      const edn = boundsEdn(Object.fromEntries(own.map((b) => [b, given[b]])));
      const db = restore(ns, graph);
      const cold = runNamed(ns, query, db, edn);
      const warm = [];
      let last = cold;
      for (let i = 0; i < runs; i++) {
        last = runNamed(ns, query, db, edn);
        warm.push(last.ms);
      }
      records.push({
        query,
        pages: size,
        datoms: graph.datoms,
        cold_ms: round(cold.ms),
        warm_ms: round(median(warm)),
        outcome: last.outcome,
        rows: last.rows,
        work: Object.fromEntries(own.map((b) => [b, last.work[b] ?? 0])),
        ...(last.bound ? { bound: last.bound, error: last.error } : {}),
      });
    }
  }
  return { mode: "named", bounds: given, runs, node: process.version, records };
}

/** --width: the F1 shapes and the 3-binding query at each size, cold then warm, with the width charged. */
export async function benchWidth({ pages = DEFAULT_PAGES, runs = DEFAULT_RUNS, widthCap, upstream = join(root, ".upstream"), seed = 1 } = {}) {
  const build = findBuild(upstream);
  if (build.missing) return { skipped: build.missing };
  const ns = loadBuild(build);
  const datalog = ns.logseq.db_sync.worker.handler.datalog;
  const cap = widthCap ?? datalog.width_cap;
  const records = [];
  for (const size of pages) {
    const graph = storeGraph(ns, size, seed, { width: true });
    for (const spec of WIDTH_SHAPES) {
      const given = { query: widthQuery(spec, `Bench Width ${spec.blocks}`) };
      const db = restore(ns, graph);
      const cold = runShape(ns, spec.shape, db, datalog.scan_cap, given, cap);
      const warm = [];
      let last = cold;
      for (let i = 0; i < runs; i++) {
        last = runShape(ns, spec.shape, db, datalog.scan_cap, given, cap);
        warm.push(last.ms);
      }
      records.push({
        shape: spec.shape,
        pages: size,
        blocks: spec.blocks,
        cold_ms: round(cold.ms),
        warm_ms: round(median(warm)),
        width: last.width,
        outcome: last.outcome,
        ...(last.error ? { error: last.error } : {}),
      });
    }
  }
  return { mode: "width", width_cap: cap, runs, node: process.version, records };
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
  const modes = [];
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
    else if (a === "--named" || a === "--width") modes.push(a.slice(2));
    else if (a === "--width-cap") opts.widthCap = whole(a, argv[++i]);
    else if (a === "--bounds") {
      opts.bounds = {};
      for (const pair of String(argv[++i]).split(",")) {
        const [bound, v] = pair.split("=");
        if (!NAMED_BOUNDS.includes(bound)) throw new Error(`--bounds: unknown bound ${bound} (bounds: ${NAMED_BOUNDS.join(", ")})`);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--bounds: ${bound} needs a whole number, got ${v}`);
        opts.bounds[bound] = n;
      }
    }
    else if (a === "--shapes") {
      opts.shapes = String(argv[++i]).split(",");
      for (const s of opts.shapes) if (!SHAPES.includes(s)) throw new Error(`--shapes: unknown shape ${s} (shapes: ${SHAPES.join(", ")})`);
    }
    else throw new Error(`unknown argument ${a}; usage: bench-datalog-query.mjs [--named [--bounds NAME=N[,…]] | --width [--width-cap N]] [--pages N[,N…]] [--runs N] [--scan-cap N] [--shapes NAME[,NAME…]] [--upstream DIR] [--json]`);
  }
  if (modes.length > 1) throw new Error("give one of --named or --width");
  opts.mode = modes[0] ?? "shapes";
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
  const r = opts.mode === "named" ? await benchNamed(opts) : opts.mode === "width" ? await benchWidth(opts) : await bench(opts);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else if (r.skipped) console.log(`skipped: ${r.skipped}`);
  else if (r.mode === "named") {
    console.log(`named queries bench: bounds ${Object.entries(r.bounds).map(([k, v]) => `${k} ${fmt(v)}`).join(", ")}; warm median of ${r.runs} runs, Node ${r.node}`);
    console.log("query                       pages    datoms  cold_ms  warm_ms  outcome   rows  work");
    for (const x of r.records) {
      console.log(
        [
          x.query.padEnd(26),
          String(x.pages).padStart(6),
          String(x.datoms).padStart(9),
          x.cold_ms.toFixed(1).padStart(8),
          x.warm_ms.toFixed(1).padStart(8),
          (x.bound ? `${x.bound}!` : x.outcome).padEnd(8),
          String(x.rows).padStart(6),
          Object.entries(x.work).map(([k, v]) => `${k} ${v}`).join(", "),
        ].join(" "),
      );
    }
  } else if (r.mode === "width") {
    console.log(`width bench: width cap ${fmt(r.width_cap)}, warm median of ${r.runs} runs, Node ${r.node}`);
    console.log("shape              pages  blocks  cold_ms  warm_ms     width  outcome");
    for (const x of r.records) {
      console.log(
        [
          x.shape.padEnd(18),
          String(x.pages).padStart(6),
          String(x.blocks).padStart(7),
          x.cold_ms.toFixed(1).padStart(8),
          x.warm_ms.toFixed(1).padStart(8),
          String(x.width).padStart(9),
          x.outcome,
        ].join(" "),
      );
    }
  } else {
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
