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
