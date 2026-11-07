#!/usr/bin/env node
// Usage: token-link.mjs
// Prints the Cloudflare dashboard link that opens "create API token" with the permissions this
// stack needs already ticked, so setup and doctor can hand the owner one click instead of a list.
// The permissions live in config/token-permissions.json. Each entry is either a short key with a
// type (`{ key, type }`) or a permission group ID with a label (`{ id, label, verified }`); Cloudflare's
// link takes an ID in the `key` field.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "token-permissions.json");

// Display names for the short keys, as the token page spells them.
const KEY_NAMES = {
  workers_scripts: "Workers Scripts",
  d1: "D1",
  workers_r2: "Workers R2 Storage",
  workers_kv_storage: "Workers KV Storage",
  workers_routes: "Workers Routes",
  dns: "DNS",
};

export function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** The link's `permissionGroupKeys` entries: `{ key, type }`, or `{ key: <id> }` for an ID. */
function groupKeys(config) {
  return config.permissions.map((p) => (p.id === undefined ? { key: p.key, type: p.type } : { key: p.id }));
}

export function tokenLink(config = readConfig()) {
  const keys = encodeURIComponent(JSON.stringify(groupKeys(config)));
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${encodeURIComponent(config.name)}`;
}

/** Human names for the permissions, for the README and for messages. */
export function permissionLabels(config) {
  return config.permissions.map((p) => {
    if (p.id !== undefined) return p.label;
    const name = KEY_NAMES[p.key];
    if (name === undefined) throw new Error(`no display name for permission key ${p.key}; add it to KEY_NAMES in token-link.mjs`);
    return `${name} ${p.type === "edit" ? "Edit" : "Read"}`;
  });
}

// Compare real paths so a symlinked invocation still runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    console.log(tokenLink());
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
