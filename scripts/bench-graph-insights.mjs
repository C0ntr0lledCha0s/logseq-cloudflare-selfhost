// Bench for the three graph-insight reads at their caps (spec 2026-11-20 §5, plan 2026-11-22 Stage 6):
// getGraphHealth (the default call, with three stored tag-property pairs, and each of its nine checks
// named alone), listChangesSince over a window of 2,500 changes (the cap) with limit=200 and
// blocks-per-page=50, and getGraphSchema with both sections at limit=200.
//
// Each read runs in the sync Worker's graph Durable Object, where the clock does not move during
// synchronous CPU work, so nothing stops a slow read but the Free plan's CPU limit. The times are
// taken in the RELEASE bundle deploy ships (Closure advanced compilation, loaded as
// release-query-check.mjs loads it), through SyncDO.fetch, as the spec asks (§5). The graph is built
// with upstream db-sync's compiled test build (as bench-datalog-query.mjs builds its graph): for each
// size it writes the schema (tags, properties with choices and the tags' properties) through the
// test build's real handle-http on a new conn, adds the pages and blocks in bulk transactions (the
// API would take hours at 20,000 pages), and stores the graph through the Durable Object's SQLite
// storage adapter in a better-sqlite3 file. A child process then imports the release bundle (the test
// build stops working in a process once a release bundle is imported after it) and, for each shape,
// makes a new SyncDO over that file: its first fetch opens the conn and loads B-tree nodes lazily, as
// the Durable Object does after a wake (cold); warm runs reuse that SyncDO.
//
//   node scripts/bench-graph-insights.mjs [--pages 5000,20000] [--changes 2500] [--runs 5]
//                                         [--upstream .upstream] [--json]
//
// The fixture: one page in ten a Bench Project (with an owner and a stage half the time each), one in
// twenty-five Private, one in twenty a Bench Topic; four blocks a page with up to two children, one
// top block in eight a Bench Meeting (with an owner half the time), one block in four linking a page
// as [[uuid]] and one in a hundred a uuid nothing has. Every page and block is stamped long ago,
// except `changes` of them, chosen at random, stamped inside the feed's window (half created there).
// Each response's counts are checked against the counts the fixture implies, at every size.
//
// Warm times are medians over --runs runs. cf_cold and cf_warm are the times x1.65, the factor
// docs/solutions/cost/durable-object-cpu-limit-on-free.md gives for Cloudflare's hardware; a figure
// over 1,000 ms is flagged. The numbers are a guide: Node on a developer machine is not a Durable
// Object on Cloudflare.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { findBuild, loadBuild, prng } from "./bench-datalog-query.mjs";
import { bundlePath, call, durableObjectState, importReleaseBundle } from "./release-query-check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_PAGES = [5_000, 20_000];
/** listChangesSince's max-changes: the most updated-at stamps one window may hold. */
export const DEFAULT_CHANGES = 2_500;
export const DEFAULT_RUNS = 5;
/** Node on a developer machine to a Durable Object on Cloudflare (durable-object-cpu-limit-on-free.md). */
export const CF_FACTOR = 1.65;
/** A Cloudflare figure over this many ms is flagged: the plan stops the stage there rather than raise a cap. */
export const OVER_MS = 1_000;
/** The feed's page limit and blocks per page, and the schema's limit: each read's maximum. */
const LIMIT = 200;
const BLOCKS_PER_PAGE = 50;

/** getGraphHealth's checks, in the handler's order. */
export const HEALTH_CHECKS = [
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

/** The checks a getGraphHealth call without checks runs (the handler's default-health-checks). */
export const DEFAULT_HEALTH_CHECKS = ["orphan-tags", "orphan-properties", "mismatched-choice-values", "orphan-choices"];

/** The default health call, then each health check named alone, then the feed and the schema. */
export const SHAPES = ["health-default", ...HEALTH_CHECKS, "changes", "schema"];

/** The user tags the fixture makes, by role, and the tags' own properties. */
export const TAGS = {
  private: { title: "Private" },
  project: { title: "Bench Project", properties: ["owner", "stage"] },
  meeting: { title: "Bench Meeting", properties: ["owner"] },
  topic: { title: "Bench Topic" },
  orphan: { title: "Bench Orphan" },
};
/** The user properties, by role: a node property, a text property with choices, and one never used. */
export const PROPERTIES = {
  owner: { title: "bench owner", type: "node" },
  stage: { title: "bench stage", type: "default", choices: ["Idea", "Active", "Done"] },
  unused: { title: "bench unused", type: "default" },
};
/** The three expected tag-property pairs, stored as deploy stores them (HEALTH_TAG_PROPERTIES). */
export const PAIRS = [
  { tag: TAGS.project.title, property: PROPERTIES.owner.title },
  { tag: TAGS.project.title, property: PROPERTIES.stage.title },
  { tag: TAGS.meeting.title, property: PROPERTIES.owner.title },
];

const WORDS = (
  "workflow review project client meeting decision idea research budget forecast roadmap delivery " +
  "platform report data model team strategy design product customer service partner finance audit"
).split(" ");
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = (rand) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
const fmt = (n) => n.toLocaleString("en-NZ");

/** 2025-11-09: every stamp outside the window, fixed so the fixture is the same on every run. */
const T0 = 1_762_646_400_000;

/**
 * A seeded graph of `pages` pages as plain data, {pages, window, expected}: each page {uuid, title,
 * tags (roles), owner (a page index), stage (a choice index), created, updated, blocks}, each block
 * {uuid, title, refs, ghost, tags, owner, created, updated, children}. `changes` pages and blocks are
 * stamped inside window (since, until]. `expected` holds the counts each shape's response must give.
 */
export function makeFixture(pages, seed = 1, { changes = DEFAULT_CHANGES } = {}) {
  const rand = prng(seed);
  const out = [];
  for (let i = 0; i < pages; i++) {
    const n = 1 + Math.floor(rand() * 3);
    const title = `${Array.from({ length: n }, () => cap(pick(rand, WORDS))).join(" ")} ${i}`;
    const tags = [];
    if (rand() < 0.1) tags.push("project");
    if (rand() < 0.04) tags.push("private");
    if (rand() < 0.05) tags.push("topic");
    const page = { uuid: uuid(rand), title, tags, created: T0, updated: T0, blocks: [] };
    if (tags.includes("project")) {
      if (rand() < 0.5) page.owner = Math.floor(rand() * pages);
      if (rand() < 0.5) page.stage = Math.floor(rand() * PROPERTIES.stage.choices.length);
    }
    out.push(page);
  }
  for (const page of out) {
    for (let b = 0; b < 4; b++) {
      const words = `${cap(pick(rand, WORDS))} ${pick(rand, WORDS)} ${pick(rand, WORDS)}`;
      const block = { uuid: uuid(rand), refs: [], tags: [], created: T0, updated: T0, children: [] };
      let title = b === 0 && rand() < 0.3 ? `**Summary:** ${words}` : words;
      if (rand() < 0.25) {
        const target = pick(rand, out).uuid;
        block.refs.push(target);
        title += ` about [[${target}]]`;
      }
      if (rand() < 0.01) {
        block.ghost = uuid(rand);
        title += ` see [[${block.ghost}]]`;
      }
      block.title = title;
      if (rand() < 0.125) {
        block.tags.push("meeting");
        if (rand() < 0.5) block.owner = Math.floor(rand() * pages);
      }
      const kids = Math.floor(rand() * 3);
      for (let k = 0; k < kids; k++) {
        block.children.push({ uuid: uuid(rand), title: `${pick(rand, WORDS)} note ${k}`, refs: [], tags: [], created: T0, updated: T0, children: [] });
      }
      page.blocks.push(block);
    }
  }
  // The window's changes: `changes` of the pages and blocks, chosen by a partial shuffle, each with a
  // stamp of its own, every other one created in the window too.
  const entities = [];
  for (const page of out) {
    entities.push({ entity: page, page });
    for (const b of page.blocks) for (const e of [b, ...b.children]) entities.push({ entity: e, page });
  }
  if (changes > entities.length) {
    throw new Error(`${fmt(changes)} changes need more than the ${entities.length} pages and blocks of ${pages} pages`);
  }
  const order = entities.map((_, i) => i);
  for (let k = 0; k < changes; k++) {
    const j = k + Math.floor(rand() * (order.length - k));
    [order[k], order[j]] = [order[j], order[k]];
    const { entity } = entities[order[k]];
    entity.updated = T0 + 1_000 + k;
    if (k % 2 === 0) entity.created = entity.updated;
  }
  const window = { since: T0 + 500, until: T0 + 2_000 + changes };
  const fixture = { pages: out, window };
  fixture.expected = expectedCounts(fixture, entities);
  return fixture;
}

/** The counts each shape's response must give on `fixture`, worked out from its data alone. */
function expectedCounts({ pages, window }, entities) {
  const isPrivate = (page) => page.tags.includes("private");
  const visible = pages.filter((p) => !isPrivate(p));
  const visibleBlocks = visible.flatMap((p) => p.blocks.flatMap((b) => [b, ...b.children]));
  const allBlocks = pages.flatMap((p) => p.blocks.flatMap((b) => [b, ...b.children]));
  const broken = visibleBlocks.filter((b) => b.ghost).length;
  const projectMissing = visible.filter((p) => p.tags.includes("project") && (p.owner === undefined || p.stage === undefined)).length;
  const meetingMissing = visibleBlocks.filter((b) => b.tags.includes("meeting") && b.owner === undefined).length;
  const missing = projectMissing + meetingMissing;
  // Usage counts Private objects too: a tag or property only they use is in use.
  const used = (role) => pages.some((p) => p.tags.includes(role)) || allBlocks.some((b) => b.tags.includes(role));
  const orphanTags = Object.keys(TAGS).filter((role) => role !== "private" && !used(role)).length + (used("private") ? 0 : 1);
  const owners = [...pages, ...allBlocks].some((e) => e.owner !== undefined);
  const stages = pages.some((p) => p.stage !== undefined);
  const orphanProperties = 1 + (owners ? 0 : 1) + (stages ? 0 : 1);
  const summaryless = visible.filter((p) => !p.blocks[0].title.startsWith("**Summary:**")).length;
  const untagged = visible.filter((p) => p.tags.length === 0).length;

  // The feed: each visible page or block stamped in the window, grouped by page, newest first.
  const groups = new Map();
  for (const { entity, page } of entities) {
    if (isPrivate(page) || entity.updated <= window.since || entity.updated > window.until) continue;
    const g = groups.get(page) ?? { latest: 0, pageChanged: false, created: 0, updated: 0 };
    g.latest = Math.max(g.latest, entity.updated);
    if (entity === page) g.pageChanged = true;
    else if (entity.created > window.since) g.created++;
    else g.updated++;
    groups.set(page, g);
  }
  const sorted = [...groups.entries()].sort(([pa, a], [pb, b]) => b.latest - a.latest || (pa.uuid < pb.uuid ? -1 : 1));
  const first = sorted.slice(0, LIMIT).map(([, g]) => g);
  const sum = (k) => first.reduce((n, g) => n + g[k], 0);

  const checkCounts = {
    "orphan-tags": orphanTags,
    "orphan-properties": orphanProperties,
    "duplicate-titles": 0,
    "pages-without-summary": summaryless,
    "pages-without-tags": untagged,
    "mismatched-choice-values": 0,
    "orphan-choices": 0,
    "broken-refs": broken,
    "missing-tag-properties": missing,
  };

  return {
    "health-default": { checks: Object.fromEntries(DEFAULT_HEALTH_CHECKS.map((c) => [c, checkCounts[c]])) },
    ...Object.fromEntries(
      HEALTH_CHECKS.map((check) => [
        check,
        check === "missing-tag-properties"
          ? { count: missing, pairs: PAIRS.length, "pairs-from": "settings" }
          : { count: checkCounts[check] },
      ]),
    ),
    changes: {
      pages: first.length,
      created: sum("created"),
      updated: sum("updated"),
      "page-changed": first.filter((g) => g.pageChanged).length,
      "next-cursor": sorted.length > LIMIT,
    },
    schema: {
      tags: Object.keys(TAGS).length,
      properties: Object.keys(PROPERTIES).length,
      "project-objects": visible.filter((p) => p.tags.includes("project")).length,
      "owner-values": [...visible, ...visibleBlocks].filter((e) => e.owner !== undefined).length,
      "stage-usage": PROPERTIES.stage.choices.map((_, i) => visible.filter((p) => p.stage === i).length),
    },
  };
}

/** The request each shape sends, against `window`. */
export function shapePath(shape, window) {
  if (HEALTH_CHECKS.includes(shape)) return `/semantic/health?checks=${shape}`;
  switch (shape) {
    case "health-default":
      return "/semantic/health";
    case "changes":
      return `/semantic/changes?since=${window.since}&until=${window.until}&limit=${LIMIT}&blocks-per-page=${BLOCKS_PER_PAGE}`;
    case "schema":
      return `/semantic/schema?sections=tags,properties&limit=${LIMIT}`;
  }
  throw new Error(`no shape ${shape}`);
}

/** The counts a shape's response gives, in the shape of the fixture's expected counts. */
export function responseCounts(shape, body) {
  if (HEALTH_CHECKS.includes(shape) && shape !== "missing-tag-properties") return { count: body.checks?.[shape]?.count };
  switch (shape) {
    case "health-default":
      return { checks: Object.fromEntries(Object.keys(body.checks ?? {}).map((c) => [c, body.checks[c]?.count])) };
    case "missing-tag-properties": {
      const c = body.checks?.["missing-tag-properties"] ?? {};
      return { count: c.count, pairs: c.pairs?.length, "pairs-from": c["pairs-from"] };
    }
    case "changes": {
      const pages = body.pages ?? [];
      const sum = (k) => pages.reduce((n, p) => n + p[k], 0);
      return {
        pages: pages.length,
        created: sum("created"),
        updated: sum("updated"),
        "page-changed": pages.filter((p) => p["page-changed"]).length,
        "next-cursor": body["next-cursor"] !== null,
      };
    }
    case "schema": {
      const tag = body.tags?.items?.find((t) => t.title === TAGS.project.title);
      const property = (title) => body.properties?.items?.find((p) => p.title === title);
      return {
        tags: body.tags?.count,
        properties: body.properties?.count,
        "project-objects": tag?.["object-count"],
        "owner-values": property(PROPERTIES.owner.title)?.["value-count"],
        "stage-usage": (property(PROPERTIES.stage.title)?.choices ?? []).map((c) => c["usage-count"]),
      };
    }
  }
  throw new Error(`no shape ${shape}`);
}

// The graph
// =========

/** A better-sqlite3 database (`file`, or in memory) in the shape ctx.storage.sql gives the handler. */
function openSql(dbSync, file = ":memory:") {
  const Database = createRequire(join(dbSync, "package.json"))("better-sqlite3");
  const db = new Database(file);
  return {
    db,
    sql: {
      exec(query, ...args) {
        const stmt = db.prepare(query);
        return stmt.reader ? stmt.all(...args) : (stmt.run(...args), []);
      },
      transaction: (f) => db.transaction(f)(),
    },
  };
}

async function write(ns, self, method, path, body) {
  const url = `http://localhost${path}?graph-id=bench`;
  const res = await ns.logseq.db_sync.worker.handler.sync.handle_http(
    self,
    new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  const text = await res.text();
  if (res.status < 200 || res.status > 299) throw new Error(`${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** EDN for the fixture's pages, blocks and property values, in chunks, given the schema's uuids and idents. */
export function fixtureTx(fixture, schema) {
  const str = (s) => JSON.stringify(s);
  const ref = (u) => `[:block/uuid #uuid ${str(u)}]`;
  const tagSet = (roles, page) => `#{${[...(page ? [":logseq.class/Page"] : []), ...roles.map((r) => ref(schema.tags[r]))].join(" ")}}`;
  const pages = fixture.pages;
  const chunks = [];
  for (let i = 0; i < pages.length; i += 1000) {
    chunks.push(
      pages
        .slice(i, i + 1000)
        .map((p) => `{:block/uuid #uuid ${str(p.uuid)} :block/title ${str(p.title)} :block/name ${str(p.title.toLowerCase())} :block/tags ${tagSet(p.tags, true)} :block/created-at ${p.created} :block/updated-at ${p.updated}}`)
        .join(" "),
    );
  }
  // Order keys of one length, so string order is creation order and a page's first block is block 0.
  let order = 0;
  const block = (b, page, parent) => {
    const refs = b.refs.length ? ` :block/refs #{${b.refs.map(ref).join(" ")}}` : "";
    const tags = b.tags.length ? ` :block/tags ${tagSet(b.tags, false)}` : "";
    return `{:block/uuid #uuid ${str(b.uuid)} :block/title ${str(b.title)} :block/page ${ref(page)} :block/parent ${ref(parent)} :block/order ${str(`a${(order++).toString(36).padStart(6, "0")}`)} :block/created-at ${b.created} :block/updated-at ${b.updated}${refs}${tags}}`;
  };
  for (let i = 0; i < pages.length; i += 500) {
    const top = [];
    const kids = [];
    for (const p of pages.slice(i, i + 500)) {
      for (const b of p.blocks) {
        top.push(block(b, p.uuid, p.uuid));
        for (const c of b.children) kids.push(block(c, p.uuid, b.uuid));
      }
    }
    chunks.push(top.join(" "));
    chunks.push(kids.join(" "));
  }
  // Property values last, once every page they point to exists.
  const values = [];
  const owner = `:${schema.properties.owner}`;
  const stage = `:${schema.properties.stage}`;
  for (const p of pages) {
    const kv = [];
    if (p.owner !== undefined) kv.push(`${owner} ${ref(pages[p.owner].uuid)}`);
    if (p.stage !== undefined) kv.push(`${stage} ${ref(schema.choices[p.stage])}`);
    if (kv.length) values.push(`{:block/uuid #uuid ${str(p.uuid)} ${kv.join(" ")}}`);
    for (const b of p.blocks) if (b.owner !== undefined) values.push(`{:block/uuid #uuid ${str(b.uuid)} ${owner} ${ref(pages[b.owner].uuid)}}`);
  }
  for (let i = 0; i < values.length; i += 2000) chunks.push(values.slice(i, i + 2000).join(" "));
  return chunks.map((c) => `[${c}]`);
}

/** Writes the schema through the API, the fixture in bulk, and stores the graph in SQLite file `file`. */
async function storeGraph(ns, dbSync, fixture, file) {
  const { cljs, d, reader, logseq } = ns;
  const conn = logseq.db.sqlite.export$.create_conn();
  const seeding = openSql(dbSync);
  logseq.db_sync.storage.init_schema_BANG_(seeding.sql);
  const self = { conn, sql: seeding.sql, env: {} };
  const schema = { tags: {}, properties: {}, choices: [] };
  for (const [role, p] of Object.entries(PROPERTIES)) {
    const body = { title: p.title, type: p.type, ...(p.choices ? { choices: p.choices.map((title) => ({ title })) } : {}) };
    const made = await write(ns, self, "POST", "/semantic/properties", body);
    schema.properties[role] = made.ident;
    if (p.choices) schema.choices = p.choices.map((title) => made.choices.find((c) => c.title === title).uuid);
  }
  for (const [role, t] of Object.entries(TAGS)) {
    const body = { title: t.title, ...(t.properties ? { properties: t.properties.map((r) => PROPERTIES[r].title) } : {}) };
    schema.tags[role] = (await write(ns, self, "POST", "/semantic/tags", body)).uuid;
  }
  for (const chunk of fixtureTx(fixture, schema)) {
    d.transact_BANG_.cljs$core$IFn$_invoke$arity$2(conn, reader.read_string.cljs$core$IFn$_invoke$arity$1(chunk));
  }
  seeding.db.close();
  const stored = openSql(dbSync, file);
  logseq.db_sync.storage.init_schema_BANG_(stored.sql);
  d.store.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), logseq.db_sync.storage.new_sqlite_storage(stored.sql));
  stored.db.close();
  return cljs.count(d.datoms.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), cljs.keyword("eavt")));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (ms) => Math.round(ms * 100) / 100;

/** The Worker variables deploy sets: the three stored pairs, and a zone for the feed. */
export const ENV = { HEALTH_TAG_PROPERTIES: JSON.stringify(PAIRS), TIMEZONE: "UTC" };

/**
 * Runs every shape through the release bundle over the graph in SQLite file `file` (call it in a
 * process that has loaded no test build): per shape {status, cold_ms, warm (ms per run), counts, error?}.
 */
export async function releaseRuns({ upstream, bundle, file, window, runs }) {
  const release = await importReleaseBundle(upstream, bundle);
  const db = new release.Database(file);
  try {
    const out = [];
    for (const shape of SHAPES) {
      const path = shapePath(shape, window);
      // A new SyncDO over the stored graph: its first fetch opens the conn, as after a wake. The
      // B-tree nodes it reads from the kvs table are counted, to show the cold run starts cold.
      const { state } = durableObjectState(db);
      let nodes = 0;
      const exec = state.storage.sql.exec;
      state.storage.sql.exec = (query, ...args) => {
        if (/from kvs/i.test(query)) nodes++;
        return exec(query, ...args);
      };
      const stub = new release.SyncDO(state, ENV);
      const timed = async () => {
        const t0 = performance.now();
        const res = await call(stub, "GET", path);
        return { ...res, ms: performance.now() - t0 };
      };
      const cold = await timed();
      const nodesCold = nodes;
      const warm = [];
      let last = cold;
      for (let r = 0; r < runs; r++) {
        last = await timed();
        warm.push(last.ms);
      }
      out.push({
        shape,
        status: last.status,
        cold_ms: cold.ms,
        nodes_loaded_cold: nodesCold,
        warm,
        ...(last.status === 200 ? { counts: responseCounts(shape, last.json) } : { error: last.json?.error ?? last.text.slice(0, 300) }),
      });
    }
    return out;
  } finally {
    db.close();
    release.close();
  }
}

/** Every shape at every size, cold then warm, with its counts beside the fixture's. */
export async function benchGraphInsights({ pages = DEFAULT_PAGES, changes = DEFAULT_CHANGES, runs = DEFAULT_RUNS, upstream = join(root, ".upstream"), seed = 1 } = {}) {
  const build = findBuild(upstream);
  if (build.missing) return { skipped: build.missing };
  const bundle = bundlePath(upstream);
  if (!existsSync(bundle)) return { skipped: `${relative(root, bundle) || bundle} is missing: build the release bundle with scripts/build.sh` };
  // Check every size's fixture before the minutes of loading and seeding.
  const fixtures = pages.map((size) => makeFixture(size, seed, { changes }));
  const ns = loadBuild(build);
  const records = [];
  const dir = mkdtempSync(join(tmpdir(), "bench-graph-insights-"));
  try {
    for (const [i, size] of pages.entries()) {
      const fixture = fixtures[i];
      const file = join(dir, `graph-${size}.sqlite`);
      const datoms = await storeGraph(ns, build.dir, fixture, file);
      const code = `import { releaseRuns } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};
        console.log(JSON.stringify(await releaseRuns(${JSON.stringify({ upstream, bundle, file, window: fixture.window, runs })})));`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (child.status !== 0) throw new Error(`the release runs at ${size} pages failed: ${child.stderr.slice(-2000)}`);
      for (const run of JSON.parse(child.stdout.trim().split("\n").pop())) {
        const warm = median(run.warm.length ? run.warm : [run.cold_ms]);
        const record = {
          shape: run.shape,
          pages: size,
          changes,
          datoms,
          status: run.status,
          cold_ms: round(run.cold_ms),
          warm_ms: round(warm),
          cf_cold_ms: round(run.cold_ms * CF_FACTOR),
          cf_warm_ms: round(warm * CF_FACTOR),
          nodes_loaded_cold: run.nodes_loaded_cold,
          counts: run.counts,
          expected: fixture.expected[run.shape],
          ...(run.error ? { error: run.error } : {}),
        };
        record.counts_ok = isDeepStrictEqual(record.counts, record.expected);
        records.push(record);
      }
      rmSync(file, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { build: "release", cf_factor: CF_FACTOR, over_ms: OVER_MS, changes, runs, node: process.version, records };
}

/** The records that failed: a status other than 200, or counts other than the fixture's. */
export function failedRecords(records) {
  return records.filter((x) => x.status !== 200 || !isDeepStrictEqual(x.counts, x.expected));
}

function parseArgs(argv) {
  const opts = { pages: DEFAULT_PAGES, changes: DEFAULT_CHANGES, runs: DEFAULT_RUNS, json: false };
  const whole = (flag, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number of at least 1, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--pages") opts.pages = String(argv[++i]).split(",").map((v) => whole(a, v));
    else if (a === "--changes") opts.changes = whole(a, argv[++i]);
    else if (a === "--runs") opts.runs = whole(a, argv[++i]);
    else if (a === "--upstream") opts.upstream = resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument ${a}; usage: bench-graph-insights.mjs [--pages N[,N…]] [--changes N] [--runs N] [--upstream DIR] [--json]`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const r = await benchGraphInsights(opts);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else if (r.skipped) console.log(`skipped: ${r.skipped}`);
  else {
    console.log(`graph insights bench (release bundle): ${fmt(r.changes)} changes in the feed's window, warm median of ${r.runs} runs, x${r.cf_factor} for Cloudflare, Node ${r.node}`);
    console.log("shape                   pages  changes status  cold_ms  warm_ms  cf_cold  cf_warm  counts");
    for (const x of r.records) {
      console.log(
        [
          x.shape.padEnd(22),
          String(x.pages).padStart(6),
          String(x.changes).padStart(8),
          String(x.status).padStart(6),
          x.cold_ms.toFixed(1).padStart(8),
          x.warm_ms.toFixed(1).padStart(8),
          x.cf_cold_ms.toFixed(1).padStart(8),
          x.cf_warm_ms.toFixed(1).padStart(8),
          x.counts_ok ? "ok" : `DIFFER: got ${JSON.stringify(x.counts)}, expected ${JSON.stringify(x.expected)}`,
        ].join(" "),
      );
    }
    for (const x of r.records.filter((x) => Math.max(x.cf_cold_ms, x.cf_warm_ms) > r.over_ms)) {
      console.log(`OVER ${fmt(r.over_ms)} ms on Cloudflare: ${x.shape} at ${fmt(x.pages)} pages (${x.cf_cold_ms} ms cold, ${x.cf_warm_ms} ms warm)`);
    }
  }
  if (!r.skipped && failedRecords(r.records).length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
