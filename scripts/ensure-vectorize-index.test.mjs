import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIMENSIONS, METRIC, ensureVectorizeIndex } from "./ensure-vectorize-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.cloudflare.com/client/v4/accounts/acct/vectorize/v2/indexes";

/** A fetch that answers each call with the next of `responses` and records the calls. */
function fakeFetch(...responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body, auth: init.headers?.authorization });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  return { fetch, calls };
}

const ARGS = { accountId: "acct", token: "tok", name: "blocks" };

test("an existing index with the right shape is left alone", async () => {
  const { fetch, calls } = fakeFetch({ status: 200, body: { result: { config: { dimensions: DIMENSIONS, metric: METRIC } } } });
  assert.equal(await ensureVectorizeIndex({ ...ARGS, fetch }), "exists");
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.auth]), [["GET", `${BASE}/blocks`, "Bearer tok"]]);
});

test("a missing index is created with the connector's dimensions and metric", async () => {
  const { fetch, calls } = fakeFetch({ status: 404 }, { status: 200, body: { success: true } });
  assert.equal(await ensureVectorizeIndex({ ...ARGS, fetch }), "created");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, BASE);
  assert.deepEqual(JSON.parse(calls[1].body), { name: "blocks", config: { dimensions: DIMENSIONS, metric: METRIC } });
});

test("an existing index with other dimensions or metric fails the deploy", async () => {
  for (const config of [{ dimensions: 768, metric: METRIC }, { dimensions: DIMENSIONS, metric: "euclidean" }]) {
    const { fetch, calls } = fakeFetch({ status: 200, body: { result: { config } } });
    await assert.rejects(ensureVectorizeIndex({ ...ARGS, fetch }), /Delete the index and deploy again/);
    assert.equal(calls.length, 1);
  }
});

test("a refused read is an error, not a create", async () => {
  const { fetch, calls } = fakeFetch({ status: 403, body: { errors: [{ code: 10000, message: "Authentication error" }] } });
  await assert.rejects(ensureVectorizeIndex({ ...ARGS, fetch }), /reading Vectorize index blocks failed: HTTP 403 .*Authentication error/);
  assert.equal(calls.length, 1);
});

test("a refused create is an error", async () => {
  const { fetch } = fakeFetch({ status: 404 }, { status: 400, body: { errors: [{ message: "bad" }] } });
  await assert.rejects(ensureVectorizeIndex({ ...ARGS, fetch }), /creating Vectorize index blocks failed: HTTP 400/);
});

test("the dimensions match the connector's embedding model", () => {
  const config = readFileSync(join(root, "connector/src/semantic/config.ts"), "utf8");
  assert.match(config, new RegExp(`export const DIMENSIONS = ${DIMENSIONS};`));
});
