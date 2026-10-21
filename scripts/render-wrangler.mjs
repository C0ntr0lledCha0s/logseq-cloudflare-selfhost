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

export function renderWrangler({ upstreamToml, settings, tofuOutputs }) {
  const cfg = parse(upstreamToml);
  delete cfg.env;
  for (const key of FORBIDDEN_TOP_LEVEL) {
    if (key in cfg) throw new Error(`forbidden top-level key: ${key}`);
  }

  cfg.name = must(settings.workerName, "settings.workerName");
  cfg.workers_dev = false;
  cfg.preview_urls = false;
  cfg.routes = [
    { pattern: must(settings.hostname, "settings.hostname"), custom_domain: true },
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

  if (settings.plan === "free") {
    delete cfg.limits;
    delete cfg.worker_loaders;
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

  return stringify(cfg);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      upstream: { type: "string" },
      settings: { type: "string" },
      "tofu-outputs": { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
    },
  });
  for (const k of ["upstream", "settings", "tofu-outputs", "out"]) {
    if (!values[k]) {
      console.error(
        "usage: render-wrangler.mjs --upstream <toml> --settings <json> --tofu-outputs <json> --out <path> [--plan free|paid]",
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
  });
  writeFileSync(values.out, toml);
}
