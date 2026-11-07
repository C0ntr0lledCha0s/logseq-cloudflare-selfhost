import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { permissionLabels, readConfig, tokenLink } from "./token-link.mjs";
import { runScript } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "token-link.mjs");
const PREFIX = "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=";

function decodedKeys(link) {
  const params = new URLSearchParams(link.slice(link.indexOf("?", link.indexOf("api-tokens")) + 1));
  return JSON.parse(params.get("permissionGroupKeys"));
}

test("the link opens the token page with the permission keys and the token name", () => {
  const link = tokenLink();
  assert.ok(link.startsWith(PREFIX), link);
  assert.ok(link.endsWith("&name=logseq-selfhost"), link);
  const keys = decodedKeys(link);
  assert.ok(keys.some((k) => k.key === "workers_scripts" && k.type === "edit" && Object.keys(k).length === 2));
  // An ID goes in `key`, with no `type`.
  assert.deepEqual(
    keys.find((k) => k.key === "66c1ed49f4ed46098b75696a6d4ee3c9"),
    { key: "66c1ed49f4ed46098b75696a6d4ee3c9" },
  );
  assert.equal(keys.length, readConfig().permissions.length);
});

test("the permission list is encoded once, so it survives a round trip", () => {
  const config = { name: "a b&c", permissions: [{ key: "d1", type: "edit" }, { id: "abc", label: "L" }] };
  const link = tokenLink(config);
  assert.ok(link.includes("&name=a%20b%26c"), link);
  assert.deepEqual(decodedKeys(link), [{ key: "d1", type: "edit" }, { key: "abc" }]);
  assert.ok(!link.includes("%25"), "double-encoded");
});

test("config/token-permissions.json is well formed", () => {
  const config = JSON.parse(readFileSync(join(root, "config", "token-permissions.json"), "utf8"));
  assert.equal(config.name, "logseq-selfhost");
  assert.ok(config.permissions.length > 0);
  for (const p of config.permissions) {
    const keyed = typeof p.key === "string" && ["edit", "read"].includes(p.type);
    const identified = typeof p.id === "string" && typeof p.label === "string" && /^[0-9a-f]{32}$/.test(p.id);
    assert.ok(keyed !== identified, JSON.stringify(p));
    // Group IDs are unverified until a real token page has confirmed them.
    if (identified) assert.equal(p.verified, false, JSON.stringify(p));
  }
  assert.deepEqual(
    config.permissions.filter((p) => p.key).map((p) => `${p.key}:${p.type}`),
    ["workers_scripts:edit", "d1:edit", "workers_r2:edit", "workers_kv_storage:edit", "workers_routes:edit", "dns:edit"],
  );
  assert.deepEqual(
    config.permissions.filter((p) => p.id).map((p) => [p.id, p.label]),
    [
      ["c8fed203ed3043cba015a93ad1616f1f", "Zone Read"],
      ["66c1ed49f4ed46098b75696a6d4ee3c9", "Workers Observability Write"],
      ["64156ba5be47441096c83c7fc17c488b", "Vectorize Write"],
    ],
  );
});

test("permissionLabels gives a human name for every permission", () => {
  assert.deepEqual(
    permissionLabels({ name: "n", permissions: [{ key: "workers_scripts", type: "edit" }, { key: "dns", type: "read" }, { id: "abc", label: "Zone Read" }] }),
    ["Workers Scripts Edit", "DNS Read", "Zone Read"],
  );
  const labels = permissionLabels(readConfig());
  assert.equal(labels.length, readConfig().permissions.length);
  assert.ok(labels.includes("Workers R2 Storage Edit"));
  assert.ok(labels.includes("Vectorize Write"));
});

test("permissionLabels refuses a short key it has no name for", () => {
  assert.throws(() => permissionLabels({ name: "n", permissions: [{ key: "mystery", type: "edit" }] }), /mystery/);
});

test("the CLI prints the link", async () => {
  const r = await runScript(script, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${tokenLink()}\n`);
});
