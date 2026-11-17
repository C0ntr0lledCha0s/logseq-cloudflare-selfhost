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
// rule cap), and each answer carries plan and work. Exits 0 when every check passes, 1 when one
// fails (naming it), and 2 when either build is missing.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBuild, loadBuild } from "./bench-datalog-query.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Stores the built-in graph (what a client's first upload holds) in the kvs table, with the dev build. */
function seedBuiltInGraph(upstream, sql) {
  const build = findBuild(upstream);
  if (build.missing) throw new Error(build.missing);
  const { cljs, d, logseq } = loadBuild(build);
  sql.exec("create table if not exists kvs (addr INTEGER primary key, content TEXT, addresses JSON)");
  const conn = logseq.db.sqlite.export$.create_conn();
  d.store.cljs$core$IFn$_invoke$arity$2(cljs.deref(conn), logseq.db_sync.storage.new_sqlite_storage(sql));
}

/** Loads the release SyncDO over an in-memory SQLite holding a new graph. Call close() when done. */
export async function loadReleaseSyncDO(upstream, bundle = bundlePath(upstream)) {
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
    seedBuiltInGraph(upstream, sql);
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

async function call(stub, method, path, body) {
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

/** The checks, each a name and a function that throws with the reason on failure. */
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

function assertRows(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`rows ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

/** Creates the fixture and runs every check. Returns [{name, ok, error?}]. */
export async function runReleaseQueryCheck(upstream, { bundle } = {}) {
  const { stub, close } = await loadReleaseSyncDO(upstream, bundle);
  try {
    const ctx = { stub };
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
        await fn();
        results.push({ name, ok: true });
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
  for (const r of results) console.log(`${r.ok ? "ok    " : "FAILED"} ${r.name}${r.ok ? "" : `: ${r.error}`}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
