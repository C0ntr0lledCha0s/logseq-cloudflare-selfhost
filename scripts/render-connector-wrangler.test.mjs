import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KB_INDEX_CRON, SEMANTIC_CRON, renderConnectorWrangler } from "./render-connector-wrangler.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(
  join(root, "connector", "wrangler.template.jsonc"),
  "utf8",
);
const baseSettings = JSON.parse(
  readFileSync(join(root, "config", "settings.json"), "utf8"),
);
const settings = baseSettings;
const hostname = "mcp.example.com";
const tofuOutputs = {
  connector_oauth_kv_id: "11111111111111111111111111111111",
  connector_kb_index_kv_id: "22222222222222222222222222222222",
  connector_d1_id: "00000000-0000-0000-0000-000000000000",
};

function render(over = {}) {
  return JSON.parse(
    renderConnectorWrangler({ template, settings, hostname, tofuOutputs, semanticSearch: false, ...over }),
  );
}

test("renders hostname, bindings and no workers.dev", () => {
  const out = render();
  assert.equal(out.name, "logseq-connector");
  assert.equal(out.workers_dev, false);
  assert.equal(out.preview_urls, false);
  assert.deepEqual(out.routes[0], { pattern: "mcp.example.com", custom_domain: true });
  assert.deepEqual(out.services[0], { binding: "SYNC", service: "logseq-sync" });
  assert.deepEqual(out.kv_namespaces, [
    { binding: "OAUTH_KV", id: tofuOutputs.connector_oauth_kv_id },
    { binding: "KB_INDEX_KV", id: tofuOutputs.connector_kb_index_kv_id },
  ]);
  assert.equal(out.kv_namespaces[0].binding, "OAUTH_KV");
  assert.deepEqual(out.d1_databases, [
    {
      binding: "DB",
      database_name: "logseq-connector",
      database_id: tofuOutputs.connector_d1_id,
      migrations_dir: "migrations",
    },
  ]);
  assert.ok(out.compatibility_flags.includes("global_fetch_strictly_public"));
  assert.ok(out.compatibility_flags.includes("nodejs_compat"));
  assert.equal(out.main, "src/index.ts");
  assert.equal(out.observability.enabled, true);
  assert.deepEqual(out.triggers, { crons: ["0 * * * *"] });
});

test("throws when the connector settings are missing", () => {
  assert.throws(
    () =>
      renderConnectorWrangler({
        template,
        settings: { ...baseSettings, connector: undefined },
        hostname,
        tofuOutputs,
        semanticSearch: false,
      }),
    /connector/,
  );
});

test("throws on missing kv/d1 id or hostname", () => {
  assert.throws(
    () => render({ tofuOutputs: { ...tofuOutputs, connector_oauth_kv_id: "" } }),
    /missing connector_oauth_kv_id/,
  );
  assert.throws(
    () => render({ tofuOutputs: { ...tofuOutputs, connector_kb_index_kv_id: undefined } }),
    /missing connector_kb_index_kv_id/,
  );
  assert.throws(
    () => render({ tofuOutputs: { ...tofuOutputs, connector_d1_id: undefined } }),
    /missing connector_d1_id/,
  );
  assert.throws(() => render({ hostname: "" }), /missing hostname/);
});

test("throws on missing settings names", () => {
  for (const key of ["workerName", "d1DatabaseName"]) {
    assert.throws(
      () =>
        render({
          settings: { ...settings, connector: { ...settings.connector, [key]: "" } },
        }),
      new RegExp(`missing settings.connector.${key}`),
    );
  }
  assert.throws(
    () => render({ settings: { ...settings, workerName: "" } }),
    /missing settings.workerName/,
  );
});

test("parses JSONC comments and trailing commas without touching strings", () => {
  const jsonc = `{
    // line comment
    "main": "src/index.ts", /* block */
    "compatibility_date": "2026-07-11",
    "vars": { "URL": "https://x.example/a//b", "S": "/* not a comment */", },
  }`;
  const out = render({ template: jsonc });
  assert.equal(out.vars.URL, "https://x.example/a//b");
  assert.equal(out.vars.S, "/* not a comment */");
});

test("refuses a template that already carries account bindings", () => {
  for (const key of ["kv_namespaces", "d1_databases", "services", "routes", "account_id", "ai", "vectorize", "triggers"]) {
    assert.throws(
      () => render({ template: JSON.stringify({ [key]: [] }) }),
      new RegExp(`forbidden top-level key: ${key}`),
    );
  }
});

test("semantic search off renders no AI, Vectorize, indexer cron or cap", () => {
  const out = render();
  for (const key of ["ai", "vectorize"]) assert.equal(out[key], undefined, key);
  assert.deepEqual(out.triggers, { crons: [KB_INDEX_CRON] });
  assert.equal(out.vars?.SEMANTIC_MAX_VECTORS, undefined);
});

test("semantic search on adds the AI and Vectorize bindings, the cron and the cap", () => {
  const out = render({ semanticSearch: true });
  assert.deepEqual(out.ai, { binding: "AI" });
  assert.deepEqual(out.vectorize, [{ binding: "VECTORIZE", index_name: "logseq-connector-blocks" }]);
  assert.deepEqual(out.triggers, { crons: [KB_INDEX_CRON, SEMANTIC_CRON] });
  assert.equal(SEMANTIC_CRON, "* * * * *");
  assert.equal(out.vars.SEMANTIC_MAX_VECTORS, "13000");
  // The rest of the config is as with it off.
  assert.deepEqual(out.d1_databases, render().d1_databases);
  assert.deepEqual(out.services, render().services);
});

test("semantic search keeps template vars and refuses a template that sets the cap", () => {
  const withVars = `{ "main": "src/index.ts", "vars": { "OTHER": "x" } }`;
  assert.deepEqual(render({ template: withVars, semanticSearch: true }).vars, { OTHER: "x", SEMANTIC_MAX_VECTORS: "13000" });
  assert.throws(
    () => render({ template: `{ "vars": { "SEMANTIC_MAX_VECTORS": "1" } }`, semanticSearch: true }),
    /must not set SEMANTIC_MAX_VECTORS/,
  );
});

test("semantic search on needs its settings, with a positive integer cap", () => {
  const connector = settings.connector;
  assert.throws(
    () => render({ semanticSearch: true, settings: { ...settings, connector: { ...connector, semanticSearch: undefined } } }),
    /missing settings.connector.semanticSearch/,
  );
  assert.throws(
    () =>
      render({
        semanticSearch: true,
        settings: { ...settings, connector: { ...connector, semanticSearch: { ...connector.semanticSearch, vectorizeIndexName: "" } } },
      }),
    /missing settings.connector.semanticSearch.vectorizeIndexName/,
  );
  for (const maxVectors of [0, -1, 1.5, "13000", undefined]) {
    assert.throws(
      () =>
        render({
          semanticSearch: true,
          settings: { ...settings, connector: { ...connector, semanticSearch: { ...connector.semanticSearch, maxVectors } } },
        }),
      /maxVectors must be a positive integer/,
      String(maxVectors),
    );
  }
  // Off, the settings are not read.
  assert.doesNotThrow(() => render({ settings: { ...settings, connector: { ...connector, semanticSearch: undefined } } }));
});

test("semanticSearch must be a boolean", () => {
  for (const semanticSearch of [undefined, "true", 1]) {
    assert.throws(() => render({ semanticSearch }), /semanticSearch must be true or false/);
  }
});

test("the cap fits the Free plan's 5M stored Vectorize dimensions", () => {
  assert.ok(settings.connector.semanticSearch.maxVectors * 384 <= 5_000_000);
});

test("the rendered crons match the ones the connector dispatches on", () => {
  const source = readFileSync(new URL("../connector/src/crons.ts", import.meta.url), "utf8");
  const declared = Object.fromEntries([...source.matchAll(/export const (\w+) = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(declared, { KB_INDEX_CRON, SEMANTIC_CRON });
});
