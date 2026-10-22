import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpstreamBindings } from "./check-upstream-bindings.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readFileSync(
  join(root, "scripts", "fixtures", "upstream-wrangler.toml"),
  "utf8",
);
const expected = JSON.parse(
  readFileSync(join(root, "config", "expected-bindings.json"), "utf8"),
);

// Insert text immediately before the first [env.*] table so it lands at top level.
function withTopLevel(extra) {
  const i = fixture.indexOf("[env.staging]");
  return fixture.slice(0, i) + extra + "\n\n" + fixture.slice(i);
}

test("pinned upstream toml matches expected", () => {
  const r = checkUpstreamBindings(fixture, expected);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("new top-level binding kind is unexpected", () => {
  const toml = withTopLevel('[[kv_namespaces]]\nbinding = "KV"\nid = "x"');
  const r = checkUpstreamBindings(toml, expected);
  assert.ok(r.unexpected.includes("toplevel:kv_namespaces"));
});

test("new var is unexpected", () => {
  const toml = fixture.replace("[vars]\n", '[vars]\nNEW_SECRET_THING = "x"\n');
  const r = checkUpstreamBindings(toml, expected);
  assert.ok(r.unexpected.includes("var:NEW_SECRET_THING"));
});

test("new DO migration tag is unexpected", () => {
  const toml = withTopLevel(
    '[[migrations]]\ntag = "v2"\nnew_sqlite_classes = [ "OtherDO" ]',
  );
  const r = checkUpstreamBindings(toml, expected);
  assert.ok(r.unexpected.includes("do_migration:v2"));
});

test("removed binding is missing", () => {
  const toml = fixture.replace(
    /\[\[r2_buckets\]\]\nbinding = "LOGSEQ_SYNC_ASSETS"\nbucket_name = "[^"]*"\n/,
    "",
  );
  assert.notEqual(toml, fixture);
  const r = checkUpstreamBindings(toml, expected);
  assert.ok(r.missing.includes("r2:LOGSEQ_SYNC_ASSETS"));
});

test("env sections are ignored", () => {
  const toml = fixture + '\n[env.foo.vars]\nX = "1"\n';
  const r = checkUpstreamBindings(toml, expected);
  assert.equal(r.ok, true, JSON.stringify(r));
});
