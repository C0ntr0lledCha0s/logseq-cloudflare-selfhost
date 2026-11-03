import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConnectorWrangler } from "./render-connector-wrangler.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const template = readFileSync(
  join(root, "connector", "wrangler.template.jsonc"),
  "utf8",
);
const baseSettings = JSON.parse(
  readFileSync(join(root, "config", "settings.json"), "utf8"),
);
const settings = {
  ...baseSettings,
  connector: { ...baseSettings.connector, enabled: true },
};
const hostname = "mcp.example.com";
const tofuOutputs = {
  connector_oauth_kv_id: "11111111111111111111111111111111",
  connector_d1_id: "00000000-0000-0000-0000-000000000000",
};

function render(over = {}) {
  return JSON.parse(
    renderConnectorWrangler({ template, settings, hostname, tofuOutputs, ...over }),
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
});

test("throws when connector disabled", () => {
  assert.throws(
    () =>
      renderConnectorWrangler({
        template,
        settings: { ...settings, connector: { ...settings.connector, enabled: false } },
        hostname,
        tofuOutputs,
      }),
    /connector.*enabled/,
  );
  assert.throws(
    () =>
      renderConnectorWrangler({
        template,
        settings: { ...baseSettings, connector: undefined },
        hostname,
        tofuOutputs,
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
  for (const key of ["kv_namespaces", "d1_databases", "services", "routes", "account_id"]) {
    assert.throws(
      () => render({ template: JSON.stringify({ [key]: [] }) }),
      new RegExp(`forbidden top-level key: ${key}`),
    );
  }
});
