#!/usr/bin/env node
// Usage: ensure-account.mjs
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers R2 Storage Edit and Workers Scripts Edit).
// Creates the account prerequisites the first deploy needs and OpenTofu can't: the R2 bucket that
// holds OpenTofu's state, and the account's workers.dev subdomain. Each is created only when it is
// missing, so a re-run changes nothing.
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiBaseFromEnv, cf, CfError } from "./cloudflare-api.mjs";

export const STATE_BUCKET = "logseq-selfhost-tofu-state";

export const R2_NOT_ENABLED = 10042;
export const R2_NOT_ENABLED_MESSAGE =
  "R2 isn't enabled on this account. Enable it at dash.cloudflare.com → R2 (a payment method is required), then re-run.";

const defaultRandomHex = (length) => randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);

/** Creates the state bucket and the workers.dev subdomain when missing. */
export async function ensureAccount({ accountId, apiToken, apiBase, fetchImpl, randomHex = defaultRandomHex }) {
  const call = (opts) => cf({ apiBase, apiToken, fetchImpl, ...opts });
  const account = `/accounts/${encodeURIComponent(accountId)}`;

  let bucket;
  try {
    const list = await call({ path: `${account}/r2/buckets`, query: { name_contains: STATE_BUCKET } });
    if ((list.result?.buckets ?? []).some((b) => b?.name === STATE_BUCKET)) {
      bucket = "present";
    } else {
      await call({ method: "POST", path: `${account}/r2/buckets`, body: { name: STATE_BUCKET } });
      bucket = "created";
    }
  } catch (e) {
    if (e instanceof CfError && e.codes.includes(R2_NOT_ENABLED)) throw new Error(R2_NOT_ENABLED_MESSAGE);
    throw e;
  }

  let current;
  try {
    current = (await call({ path: `${account}/workers/subdomain` })).result?.subdomain;
  } catch (e) {
    if (!(e instanceof CfError && e.status === 404)) throw e;
  }
  if (current) return { bucket, subdomain: "present" };
  await call({ method: "PUT", path: `${account}/workers/subdomain`, body: { subdomain: `logseq-${randomHex(8)}` } });
  return { bucket, subdomain: "created" };
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

/** Returns the exit code. */
export async function run(env = process.env) {
  try {
    const outcome = await ensureAccount({
      accountId: requireEnv(env, "CLOUDFLARE_ACCOUNT_ID"),
      apiToken: requireEnv(env, "CLOUDFLARE_API_TOKEN"),
      apiBase: apiBaseFromEnv(env),
    });
    console.log(`state bucket: ${outcome.bucket}`);
    console.log(`workers.dev subdomain: ${outcome.subdomain}`);
    return 0;
  } catch (e) {
    if (env.GITHUB_ACTIONS === "true") console.log(`::error::${e.message}`);
    else console.error(`error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run();
}
