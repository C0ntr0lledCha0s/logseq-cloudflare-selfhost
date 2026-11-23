import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";

function must(value, what) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing ${what}`);
  }
  return value;
}

const FORBIDDEN_TOP_LEVEL = [
  "kv_namespaces", "queues", "services", "hyperdrive", "vectorize",
  "account_id", "route", "routes",
];

// Upstream's account-scoped bindings must be exactly the one we rewrite; anything else
// would carry upstream (Logseq account) resource ids into our config.
function exactlyOne(list, binding, table) {
  if (!Array.isArray(list) || list.length !== 1 || list[0].binding !== binding) {
    throw new Error(`${table} must contain exactly one binding: ${binding}`);
  }
  return list[0];
}

export function renderWrangler({ upstreamToml, settings, tofuOutputs, hostname }) {
  const cfg = parse(upstreamToml);
  delete cfg.env;
  for (const key of FORBIDDEN_TOP_LEVEL) {
    if (key in cfg) throw new Error(`forbidden top-level key: ${key}`);
  }

  for (const m of cfg.migrations ?? []) {
    for (const key of ["deleted_classes", "renamed_classes", "transferred_classes"]) {
      if (Array.isArray(m[key]) ? m[key].length > 0 : m[key] !== undefined) {
        throw new Error(
          `destructive Durable Object migration ${m.tag} refused (${key}) — graphs live in Durable Objects; review manually`,
        );
      }
    }
  }

  cfg.name = must(settings.workerName, "settings.workerName");
  cfg.workers_dev = false;
  cfg.preview_urls = false;
  cfg.routes = [
    { pattern: must(hostname, "hostname"), custom_domain: true },
  ];

  const r2 = exactlyOne(cfg.r2_buckets, "LOGSEQ_SYNC_ASSETS", "r2_buckets");
  r2.bucket_name = must(settings.assetsBucket, "settings.assetsBucket");

  const databaseId = must(tofuOutputs?.d1_database_id, "d1_database_id");
  const d1 = exactlyOne(cfg.d1_databases, "DB", "d1_databases");
  d1.database_name = must(settings.d1DatabaseName, "settings.d1DatabaseName");
  d1.database_id = databaseId;

  for (const r of cfg.ratelimits ?? []) {
    r.namespace_id = must(
      settings.rateLimitNamespaces?.[r.name],
      `rateLimitNamespaces entry: ${r.name}`,
    );
  }

  // Upstream's Worker Loader only served its /mcp code mode, which is removed
  // (patch 0020), so neither plan binds it.
  delete cfg.worker_loaders;
  if (settings.plan === "free") {
    delete cfg.limits;
  } else if (settings.plan !== "paid") {
    throw new Error(`unknown plan: ${settings.plan}`);
  }

  for (const key of Object.keys(cfg.vars ?? {})) {
    if (key === "DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS" || key.startsWith("SENTRY_")) {
      throw new Error(`forbidden var: ${key}`);
    }
  }
  if (cfg.vars) {
    delete cfg.vars.COGNITO_CLIENT_IDS;
    delete cfg.vars.OPENAI_APPS_CHALLENGE;
  }

  // Upstream turns invocation logs off, so Workers Logs show only what the code logs and no
  // line per request. Keep them on: they show each request's outcome (a sync that fails, a
  // rejected write) without wrangler tail running at the time.
  cfg.observability = {
    ...(cfg.observability ?? {}),
    enabled: true,
    logs: { ...(cfg.observability?.logs ?? {}), invocation_logs: true },
  };

  // 'Today' (capture, tasks and assets with no page) is the date in this zone. Workers run in
  // UTC, so without it a New Zealand morning lands on yesterday's journal (patch 0025).
  if (settings.timeZone !== undefined) {
    cfg.vars = { ...(cfg.vars ?? {}), TIMEZONE: timeZone(settings.timeZone) };
  }

  // HEALTH_TAG_PROPERTIES (patch 0051) is never a [vars] entry: wrangler deploy prints each var's
  // value in its bindings table, and the deploy log is public. healthTagPropertiesSecret gives the
  // value deploy.sh sends in its secrets file instead.
  if (cfg.vars) delete cfg.vars.HEALTH_TAG_PROPERTIES;

  return stringify(cfg);
}

function timeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`settings.timeZone is not an IANA time zone: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The tag-property pairs getGraphHealth's missing-tag-properties check uses when a call gives none
 * (patch 0051), as the JSON string deploy.sh sends as the HEALTH_TAG_PROPERTIES Worker secret. Tag
 * names are the owner's data and the committed settings.json keeps [], so the HEALTH_TAG_PROPERTIES
 * GitHub secret (`healthTagProperties`), when set, replaces it: CI deploys from the committed file on
 * every merge. Always a value ("[]" for none), so a deploy replaces whatever the Worker held. The
 * server skips a pair that doesn't resolve in a graph, since one Worker serves every graph.
 */
export function healthTagPropertiesSecret({ settings, healthTagProperties }) {
  const pairs = typeof healthTagProperties === "string" && healthTagProperties.trim() !== ""
    ? secretTagProperties(healthTagProperties)
    : expectedTagProperties(settings.health);
  return JSON.stringify(pairs ?? []);
}

// The handler's own cap (max-tag-property-pairs in patch 0051).
const MAX_TAG_PROPERTY_PAIRS = 50;

function expectedTagProperties(health) {
  if (health === undefined) return undefined;
  if (health === null || typeof health !== "object" || Array.isArray(health)) {
    throw new Error("settings.health must be an object");
  }
  const pairs = health.expectedTagProperties;
  if (pairs === undefined) return undefined;
  return checkedTagProperties(pairs, "settings.health.expectedTagProperties");
}

function secretTagProperties(raw) {
  const key = "the HEALTH_TAG_PROPERTIES secret";
  let pairs;
  try {
    pairs = JSON.parse(raw);
  } catch {
    throw new Error(`${key} is not JSON`);
  }
  return checkedTagProperties(pairs, key);
}

function checkedTagProperties(pairs, key) {
  if (!Array.isArray(pairs)) throw new Error(`${key} must be an array`);
  if (pairs.length > MAX_TAG_PROPERTY_PAIRS) {
    throw new Error(`${key} must hold at most ${MAX_TAG_PROPERTY_PAIRS} pairs (got ${pairs.length})`);
  }
  return pairs.map((pair, i) => {
    if (pair === null || typeof pair !== "object" || Array.isArray(pair)) {
      throw new Error(`${key}[${i}] must be an object with tag and property`);
    }
    for (const field of ["tag", "property"]) {
      if (typeof pair[field] !== "string" || pair[field].trim() === "") {
        throw new Error(`${key}[${i}].${field} must be a non-empty string`);
      }
    }
    return { tag: pair.tag, property: pair.property };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      upstream: { type: "string" },
      settings: { type: "string" },
      "tofu-outputs": { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
      hostname: { type: "string" },
      "secrets-out": { type: "string" },
    },
  });
  for (const k of ["upstream", "settings", "tofu-outputs", "out", "hostname", "secrets-out"]) {
    if (!values[k]) {
      console.error(
        "usage: render-wrangler.mjs --upstream <toml> --settings <json> --tofu-outputs <json> --out <path> --hostname <host> --secrets-out <json> [--plan free|paid]",
      );
      process.exit(2);
    }
  }
  const settings = JSON.parse(readFileSync(values.settings, "utf8"));
  if (values.plan) settings.plan = values.plan;
  const tofu = JSON.parse(readFileSync(values["tofu-outputs"], "utf8"));
  const toml = renderWrangler({
    upstreamToml: readFileSync(values.upstream, "utf8"),
    settings,
    tofuOutputs: { d1_database_id: tofu.d1_database_id?.value },
    hostname: values.hostname,
  });
  // The Worker secrets this render decides, for deploy.sh's --secrets-file; owner-only, like it.
  const secrets = {
    HEALTH_TAG_PROPERTIES: healthTagPropertiesSecret({ settings, healthTagProperties: process.env.HEALTH_TAG_PROPERTIES }),
  };
  writeFileSync(values.out, toml);
  writeFileSync(values["secrets-out"], JSON.stringify(secrets), { mode: 0o600 });
}
