import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

// Shape of the top-level (non-env) wrangler config. env.* tables are not inspected.
export function collectShape(tomlText) {
  const cfg = parse(tomlText);
  const out = new Set();
  const add = (kind, value) => {
    if (value !== undefined) out.add(`${kind}:${value}`);
  };
  for (const key of Object.keys(cfg)) add("toplevel", key);
  for (const b of cfg.durable_objects?.bindings ?? []) {
    add("durable_object", b.name);
    add("do_class", b.class_name);
  }
  for (const m of cfg.migrations ?? []) {
    add("do_migration", m.tag);
    for (const c of [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]) {
      add("do_class", c);
    }
  }
  for (const b of cfg.r2_buckets ?? []) add("r2", b.binding);
  for (const b of cfg.d1_databases ?? []) add("d1", b.binding);
  for (const b of cfg.worker_loaders ?? []) add("worker_loader", b.binding);
  for (const b of cfg.ratelimits ?? []) add("ratelimit", b.name);
  if (cfg.version_metadata) add("version_metadata", cfg.version_metadata.binding);
  for (const k of Object.keys(cfg.vars ?? {})) add("var", k);
  return [...out].sort();
}

export function checkUpstreamBindings(tomlText, expected) {
  const actual = new Set(collectShape(tomlText));
  const want = new Set(expected);
  const unexpected = [...actual].filter((e) => !want.has(e)).sort();
  const missing = [...want].filter((e) => !actual.has(e)).sort();
  return { ok: unexpected.length === 0 && missing.length === 0, unexpected, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tomlPath] = process.argv.slice(2);
  if (!tomlPath) {
    console.error("usage: check-upstream-bindings.mjs <upstream wrangler.toml>");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const expected = JSON.parse(
    readFileSync(join(root, "config", "expected-bindings.json"), "utf8"),
  );
  const r = checkUpstreamBindings(readFileSync(tomlPath, "utf8"), expected);
  if (r.ok) {
    console.log("upstream bindings OK");
  } else {
    for (const e of r.unexpected) console.log(`unexpected: ${e}`);
    for (const e of r.missing) console.log(`missing: ${e}`);
    process.exit(1);
  }
}
