#!/usr/bin/env node
// Usage: node scripts/check-tools-manifest.mjs [--write]
// Regenerates the tools manifest from connector/vendor/openapi.json and compares it with the committed
// connector/tools-manifest.json. Exits 1 with the differences when they differ, so an upstream bump
// that adds, removes or moves a tool shows up in review. --write updates the committed file instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const specPath = `${root}vendor/openapi.json`;
const manifestPath = `${root}tools-manifest.json`;

if (!existsSync(specPath) || !existsSync(`${root}vendor/semantic_api_tools.mjs`)) {
  console.error("connector/vendor/ is not populated: run scripts/vendor-upstream-api.sh <built upstream checkout> first");
  process.exit(1);
}

const { buildManifest, checkManifest, formatManifest } = await import("../src/tools/spec.mjs");
const spec = JSON.parse(readFileSync(specPath, "utf8"));

if (process.argv.includes("--write")) {
  writeFileSync(manifestPath, formatManifest(buildManifest(spec)));
  console.log("wrote connector/tools-manifest.json");
  process.exit(0);
}

const committed = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
const diff = checkManifest(committed, spec);
if (diff.length > 0) {
  console.error("connector/tools-manifest.json is stale (+ the spec has it, - the manifest has it):");
  for (const line of diff) console.error(`  ${line}`);
  console.error("Run `npm --prefix connector run update:manifest` and commit the result.");
  process.exit(1);
}
console.log(`connector/tools-manifest.json is up to date (${buildManifest(spec).length} tools)`);
