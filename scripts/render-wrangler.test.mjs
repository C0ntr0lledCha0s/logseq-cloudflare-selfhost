import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { renderWrangler } from "./render-wrangler.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readFileSync(
  join(root, "scripts", "fixtures", "upstream-wrangler.toml"),
  "utf8",
);
const settings = JSON.parse(
  readFileSync(join(root, "config", "settings.json"), "utf8"),
);
const tofuOutputs = { d1_database_id: "00000000-0000-0000-0000-000000000000" };

function render(over = {}) {
  const { upstreamToml = fixture, ...rest } = over;
  return parse(
    renderWrangler({ upstreamToml, settings, tofuOutputs, ...rest }),
  );
}

// Insert a var into the top-level [vars] table of the fixture.
function withVar(line) {
  return fixture.replace("[vars]\n", `[vars]\n${line}\n`);
}

test("free plan drops limits and worker_loaders", () => {
  const out = render({ settings: { ...settings, plan: "free" } });
  assert.equal(out.limits, undefined);
  assert.equal(out.worker_loaders, undefined);
  assert.equal(out.ratelimits.length, 2);
  assert.ok(out.durable_objects);
  assert.ok(out.version_metadata);
});

test("paid plan keeps limits and worker_loaders", () => {
  const out = render({ settings: { ...settings, plan: "paid" } });
  assert.equal(out.limits.cpu_ms, 300000);
  assert.equal(out.worker_loaders[0].binding, "LOADER");
});

test("names, ids and domain come from settings", () => {
  const out = render();
  assert.equal(out.name, "logseq-sync");
  assert.equal(out.workers_dev, false);
  assert.equal(out.preview_urls, false);
  assert.deepEqual({ ...out.routes[0] }, {
    pattern: "sync.example.com",
    custom_domain: true,
  });
  assert.equal(out.r2_buckets[0].bucket_name, "logseq-sync-assets");
  assert.equal(out.d1_databases[0].database_name, "logseq-sync-index");
  assert.equal(out.d1_databases[0].database_id, tofuOutputs.d1_database_id);
  const ns = Object.fromEntries(
    out.ratelimits.map((r) => [r.name, r.namespace_id]),
  );
  assert.deepEqual(ns, {
    SEMANTIC_READ_RATE_LIMITER: "1001",
    SEMANTIC_WRITE_RATE_LIMITER: "1002",
  });
  assert.equal(out.ratelimits[0].simple.limit, 120);
  assert.equal("env" in out, false);
  assert.equal(out.main, "entry.mjs");
});

test("unsafe or unused vars are removed or rejected", () => {
  const out = render({
    upstreamToml: withVar('COGNITO_CLIENT_IDS = "a,b"\nOPENAI_APPS_CHALLENGE = "x"'),
  });
  assert.equal("COGNITO_CLIENT_IDS" in out.vars, false);
  assert.equal("OPENAI_APPS_CHALLENGE" in out.vars, false);
  assert.equal(out.vars.COGNITO_CLIENT_ID, "69cs1lgme7p8kbgld8n5kseii6");
});

test("forbidden vars throw", () => {
  for (const key of ["DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS", "SENTRY_DSN"]) {
    assert.throws(
      () => render({ upstreamToml: withVar(`${key} = "true"`) }),
      new RegExp(`forbidden var: ${key}`),
    );
  }
});

test("unknown plan throws", () => {
  assert.throws(() => render({ settings: { ...settings, plan: "pro" } }), /plan/);
});

test("unknown rate limiter throws", () => {
  const { SEMANTIC_WRITE_RATE_LIMITER: _drop, ...rest } =
    settings.rateLimitNamespaces;
  assert.throws(
    () => render({ settings: { ...settings, rateLimitNamespaces: rest } }),
    /SEMANTIC_WRITE_RATE_LIMITER/,
  );
});

test("missing d1_database_id throws", () => {
  assert.throws(() => render({ tofuOutputs: {} }), /d1_database_id/);
});

test("rendered output contains no upstream account identifiers", () => {
  const up = parse(fixture);
  const sections = [up, ...Object.values(up.env)];
  const ours = new Set(["1001", "1002"]);
  const leaks = new Set();
  for (const s of sections) {
    for (const b of s.r2_buckets ?? []) leaks.add(b.bucket_name);
    for (const d of s.d1_databases ?? []) {
      leaks.add(d.database_name);
      leaks.add(d.database_id);
    }
    for (const r of s.ratelimits ?? []) {
      if (!ours.has(r.namespace_id)) leaks.add(r.namespace_id);
    }
  }
  assert.ok(leaks.size >= 6);
  for (const plan of ["free", "paid"]) {
    const text = renderWrangler({
      upstreamToml: fixture,
      settings: { ...settings, plan },
      tofuOutputs,
    });
    for (const id of leaks) {
      assert.equal(text.includes(`"${id}"`), false, `${plan} leaks ${id}`);
    }
  }
});

test("renamed, missing or extra r2/d1 bindings throw", () => {
  const swap = (from, to) => fixture.replace(from, to);
  assert.throws(
    () => render({ upstreamToml: swap('binding = "LOGSEQ_SYNC_ASSETS"\nbucket_name = "logseq-sync-assets-prod"', 'binding = "RENAMED"\nbucket_name = "logseq-sync-assets-prod"') }),
    /exactly one binding: LOGSEQ_SYNC_ASSETS/,
  );
  assert.throws(
    () => render({ upstreamToml: swap('binding = "DB"\ndatabase_name', 'binding = "OTHER"\ndatabase_name') }),
    /exactly one binding: DB/,
  );
  const extraR2 = fixture.replace("[[d1_databases]]", '[[r2_buckets]]\nbinding = "X"\nbucket_name = "x"\n\n[[d1_databases]]');
  assert.throws(() => render({ upstreamToml: extraR2 }), /r2_buckets/);
  const extraD1 = fixture.replace("[[migrations]]", '[[d1_databases]]\nbinding = "X"\ndatabase_name = "x"\ndatabase_id = "y"\n\n[[migrations]]');
  assert.throws(() => render({ upstreamToml: extraD1 }), /d1_databases/);
});

test("account-scoped top-level keys throw", () => {
  const cases = {
    kv_namespaces: '[[kv_namespaces]]\nbinding = "KV"\nid = "x"\n\n',
    queues: '[[queues.producers]]\nbinding = "Q"\nqueue = "q"\n\n',
    services: '[[services]]\nbinding = "S"\nservice = "s"\n\n',
    hyperdrive: '[[hyperdrive]]\nbinding = "H"\nid = "h"\n\n',
    vectorize: '[[vectorize]]\nbinding = "V"\nindex_name = "v"\n\n',
    account_id: null,
    route: null,
    routes: null,
  };
  for (const [key, block] of Object.entries(cases)) {
    const toml = block
      ? block + fixture
      : `${key} = ${key === "routes" ? '["a.example.com"]' : '"x"'}\n` + fixture;
    assert.throws(() => render({ upstreamToml: toml }), new RegExp(`forbidden top-level key: ${key}`), key);
  }
});
