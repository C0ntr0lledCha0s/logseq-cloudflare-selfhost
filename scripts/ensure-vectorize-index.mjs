#!/usr/bin/env node
// Usage: ensure-vectorize-index.mjs --settings <settings.json>
// Env: CLOUDFLARE_API_TOKEN (with Vectorize Write), CLOUDFLARE_ACCOUNT_ID.
// Creates the connector's Vectorize index (settings.connector.semanticSearch.vectorizeIndexName) when
// it doesn't exist yet, and fails when an existing one has other dimensions or another metric. The
// Cloudflare provider has no Vectorize resource, so OpenTofu can't manage the index.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The embedding model's output size. Must match DIMENSIONS in connector/src/semantic/config.ts. */
export const DIMENSIONS = 384;
export const METRIC = "cosine";

const API = "https://api.cloudflare.com/client/v4";

async function failure(what, response) {
  const text = (await response.text()).slice(0, 500);
  return new Error(`${what} failed: HTTP ${response.status} ${text}`);
}

/** Returns "exists" or "created". Throws on a mismatched index or any other API answer. */
export async function ensureVectorizeIndex({ accountId, token, name, fetch = globalThis.fetch }) {
  const base = `${API}/accounts/${encodeURIComponent(accountId)}/vectorize/v2/indexes`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const got = await fetch(`${base}/${encodeURIComponent(name)}`, { headers });
  if (got.ok) {
    const config = (await got.json()).result?.config;
    if (config?.dimensions !== DIMENSIONS || config?.metric !== METRIC) {
      throw new Error(
        `Vectorize index ${name} has ${config?.dimensions} dimensions and metric ${config?.metric}; ` +
          `the connector needs ${DIMENSIONS} and ${METRIC}. Delete the index and deploy again (README 11.11).`,
      );
    }
    return "exists";
  }
  if (got.status !== 404) throw await failure(`reading Vectorize index ${name}`, got);

  const created = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, config: { dimensions: DIMENSIONS, metric: METRIC } }),
  });
  if (!created.ok) throw await failure(`creating Vectorize index ${name}`, created);
  return "created";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { settings: { type: "string" } } });
  if (!values.settings) {
    console.error("usage: ensure-vectorize-index.mjs --settings <settings.json>");
    process.exit(2);
  }
  const name = JSON.parse(readFileSync(values.settings, "utf8")).connector?.semanticSearch?.vectorizeIndexName;
  if (typeof name !== "string" || name === "") {
    console.error("missing setting: connector.semanticSearch.vectorizeIndexName");
    process.exit(1);
  }
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } = process.env;
  if (!token || !accountId) {
    console.error("ensure-vectorize-index: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(1);
  }
  const outcome = await ensureVectorizeIndex({ accountId, token, name });
  console.log(`Vectorize index ${name}: ${outcome}`);
}
