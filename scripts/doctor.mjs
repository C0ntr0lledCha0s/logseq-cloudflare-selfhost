#!/usr/bin/env node
// Usage: doctor.mjs [--repo-root <dir>]   (normally run through doctor.sh, which loads .env.local)
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SYNC_HOSTNAME, CONNECTOR_ENABLED, CONNECTOR_HOSTNAME,
// SEMANTIC_SEARCH_ENABLED, DB_SYNC_ALLOWED_USERS. CF_API_BASE and CF_API_TEST are for tests (cloudflare-api.mjs).
//
// A read-only check of the Cloudflare account, the token, the domain, the GitHub repo and the local
// files. It prints one line per check (ok, warn or FAIL) and exits 1 if any check failed. It never
// prints a secret, an ID or a DNS record's content: only names, counts and the API's own messages.
// The check that matters most is `dns`: a deploy from Actions replaces an existing DNS record on the
// hostname without asking, so a hostname that is already in use must stop setup.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseAllowedUsers } from "./allowed-users.mjs";
import { apiBaseFromEnv, cf, CfError } from "./cloudflare-api.mjs";
import { R2_NOT_ENABLED, R2_NOT_ENABLED_MESSAGE } from "./ensure-account.mjs";
import { tokenLink } from "./token-link.mjs";

// The seven required secrets (README 1.8), and the six more the connector needs. The connector's
// OAuth app values are stored under CONNECTOR_GITHUB_* because GitHub forbids names starting with GITHUB_.
const REQUIRED_SECRETS = [
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TOFU_ENCRYPTION_PASSPHRASE", "ASSET_LINK_SECRET",
  "DB_SYNC_ADMIN_TOKEN", "DB_SYNC_ALLOWED_USERS", "SYNC_HOSTNAME",
];
const CONNECTOR_SECRETS = [
  "CONNECTOR_HOSTNAME", "CONNECTOR_GITHUB_CLIENT_ID", "CONNECTOR_GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID", "COOKIE_ENCRYPTION_KEY", "GRAPH_TOKEN_KEY",
];

// The permission each check needs, as the token page spells it (see config/token-permissions.json).
const PERMISSION = {
  d1: "D1 Edit",
  r2: "Workers R2 Storage Edit",
  workers: "Workers Scripts Edit",
  kv: "Workers KV Storage Edit",
  zone: "Zone Read",
  observability: "Workers Observability Write",
  vectorize: "Vectorize Write",
};

const WINDOW_MS = 60_000;

/**
 * The zone that contains `hostname`: tries each suffix from the parent domain down to two labels,
 * then the hostname itself (a zone's apex can be the hostname), and returns the first exact name match.
 */
export async function findZone(hostname, cfCall) {
  const labels = hostname.split(".");
  const candidates = [];
  for (let i = 1; labels.length - i >= 2; i++) candidates.push(labels.slice(i).join("."));
  candidates.push(hostname);
  for (const name of candidates) {
    const { result } = await cfCall({ path: "/zones", query: { name } });
    const match = (result ?? []).find((z) => z?.name === name);
    if (match) return { id: match.id, name: match.name, status: match.status };
  }
  return null;
}

const isForbidden = (e) => e instanceof CfError && (e.status === 401 || e.status === 403) && !e.codes.includes(R2_NOT_ENABLED);

function readSettings(repoRoot) {
  const settings = JSON.parse(readFileSync(join(repoRoot, "config", "settings.json"), "utf8"));
  const syncWorker = settings.workerName;
  const connectorWorker = settings.connector?.workerName;
  if (typeof syncWorker !== "string" || typeof connectorWorker !== "string") {
    throw new Error("config/settings.json needs workerName and connector.workerName");
  }
  return { syncWorker, connectorWorker };
}

const defaultRepoRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs every check. `cfCall` is `(opts) => cf({ apiBase, apiToken, ...opts })`, `gh(args)` returns
 * `{ status, stdout }`, and `now` is the time in milliseconds. Never throws for a failed check.
 */
export async function runDoctor({ env, cfCall, gh, now, repoRoot = defaultRepoRoot() }) {
  const { syncWorker, connectorWorker } = readSettings(repoRoot);
  const results = [];
  const add = (level, name, detail) => results.push({ level, name, detail });
  const link = tokenLink();
  const connectorOn = env.CONNECTOR_ENABLED === "true";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const account = `/accounts/${encodeURIComponent(accountId)}`;

  /** Records `fn`'s failure as a FAIL named `name`, and returns whether it passed. */
  const guard = async (name, fn) => {
    try {
      await fn();
      return true;
    } catch (e) {
      const hint = isForbidden(e) ? ` Check the token's permissions: ${link}` : "";
      add("FAIL", name, `${e.message}.${hint}`);
      return false;
    }
  };

  const checkHostname = (name, variable, value) => {
    if (value === "") {
      add("FAIL", name, `${variable} is not set`);
      return false;
    }
    if (value !== value.trim().toLowerCase() || value.endsWith(".")) {
      add("FAIL", name, `${variable} must be lower case, with no spaces and no trailing dot: Cloudflare compares names exactly. Fix it in .env.local and in the production secret`);
      return false;
    }
    add("ok", name, "the hostname is in its plain lower-case form");
    return true;
  };

  const syncHost = env.SYNC_HOSTNAME ?? "";
  const syncHostOk = checkHostname("hostname", "SYNC_HOSTNAME", syncHost);

  // Whether the sync Worker already serves its hostname. A permission that only the newer token link
  // adds is a warning on an install that is already deployed, and a FAIL before the first deploy.
  // A failed lookup counts as not deployed, which is the stricter answer.
  let deployedLookup;
  const deployed = () =>
    (deployedLookup ??= (async () => {
      if (!syncHostOk) return false;
      try {
        const { result } = await cfCall({ path: `${account}/workers/domains`, query: { hostname: syncHost, service: syncWorker } });
        return (result ?? []).some((d) => d?.hostname === syncHost && d?.service === syncWorker);
      } catch {
        return false;
      }
    })());

  /** Runs one permission's harmless call. Returns `{ ok, value }`; the result line is added here. */
  const permission = async (name, key, call, { isNew = false, skipNote = "" } = {}) => {
    const label = PERMISSION[key];
    try {
      const value = await call();
      add("ok", name, `${label} works`);
      return { ok: true, value };
    } catch (e) {
      if (isForbidden(e)) {
        if (isNew && (await deployed())) {
          add("warn", name, `${label} is missing from the token (${skipNote}). Make a new token with ${link}`);
        } else {
          add("FAIL", name, `${label} is missing from the token. Make a new token with ${link}`);
        }
      } else {
        add("FAIL", name, `${label} couldn't be checked: ${e.message}`);
      }
      return { ok: false };
    }
  };

  const checkZone = (prefix, host, zone) => {
    if (zone === null) {
      add("FAIL", `${prefix}zone`, `${host} isn't in a zone on this account: add its domain to Cloudflare first (README "Before you start")`);
    } else if (zone.status !== "active") {
      add("FAIL", `${prefix}zone`, `zone ${zone.name} is ${zone.status}: its nameservers haven't switched to Cloudflare yet (README "Before you start")`);
    } else {
      add("ok", `${prefix}zone`, `${host} is in zone ${zone.name}, which is active`);
    }
  };

  const checkDns = (prefix, host, worker, zone) =>
    guard(`${prefix}dns`, async () => {
      const records = (await cfCall({ path: `/zones/${encodeURIComponent(zone.id)}/dns_records`, query: { name: host } })).result ?? [];
      const domains = (await cfCall({ path: `${account}/workers/domains`, query: { hostname: host } })).result ?? [];
      if (records.length === 0) {
        add("ok", `${prefix}dns`, `no DNS record at ${host}`);
      } else if (domains.some((d) => d?.hostname === host && d?.service === worker)) {
        add("ok", `${prefix}dns`, `${host} is already a custom domain of the ${worker} Worker`);
      } else {
        const types = [...new Set(records.map((r) => r?.type ?? "?"))].join(", ");
        add(
          "FAIL",
          `${prefix}dns`,
          `${host} already has a DNS record (${types}), so it is probably in use. A deploy from Actions would replace the record, and whatever is served from that name would go down. Choose another hostname, or delete the record if it is unused`,
        );
      }
    });

  // ---- Cloudflare ----
  let tokenOk = false;
  if (accountId === "" || !env.CLOUDFLARE_API_TOKEN) {
    add("FAIL", "token", "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set in .env.local");
  } else {
    tokenOk = await (async () => {
      try {
        const status = (await cfCall({ path: `${account}/tokens/verify` })).result?.status;
        if (status === "active") {
          add("ok", "token", "the token is active");
          return true;
        }
        add("FAIL", "token", `the token is ${status ?? "not verified"}. Make a new one with ${link}`);
      } catch (e) {
        add("FAIL", "token", `the API rejected the token (${e.message}). Make a new one with ${link}`);
      }
      return false;
    })();
  }

  let zoneUsable = false;
  if (tokenOk) {
    await permission("perm:d1", "d1", () => cfCall({ path: `${account}/d1/database`, query: { per_page: 1 } }));

    // R2 "not enabled" is its own failure, not a missing permission.
    try {
      await cfCall({ path: `${account}/r2/buckets`, query: { per_page: 1 } });
      add("ok", "perm:r2", `${PERMISSION.r2} works`);
      add("ok", "r2-enabled", "R2 is enabled");
    } catch (e) {
      if (e instanceof CfError && e.codes.includes(R2_NOT_ENABLED)) {
        add("warn", "perm:r2", "not checked until R2 is enabled (see r2-enabled)");
        add("FAIL", "r2-enabled", R2_NOT_ENABLED_MESSAGE);
      } else if (isForbidden(e)) {
        add("FAIL", "perm:r2", `${PERMISSION.r2} is missing from the token. Make a new token with ${link}`);
      } else {
        add("FAIL", "perm:r2", `${PERMISSION.r2} couldn't be checked: ${e.message}`);
      }
    }

    await permission("perm:workers", "workers", async () => {
      try {
        await cfCall({ path: `${account}/workers/subdomain` });
      } catch (e) {
        // No workers.dev subdomain yet: the call was allowed.
        if (!(e instanceof CfError && e.status === 404)) throw e;
      }
    });
    if (connectorOn) {
      await permission("perm:kv", "kv", () => cfCall({ path: `${account}/storage/kv/namespaces`, query: { per_page: 1 } }));
    }

    let syncZone = null;
    if (syncHostOk) {
      const probe = await permission("perm:zone", "zone", () => findZone(syncHost, cfCall), { isNew: true, skipNote: "skipped checks: zone, dns" });
      zoneUsable = probe.ok;
      syncZone = probe.value ?? null;
    } else {
      // Nothing to look up, so the permission can't be tested. Don't claim either way.
      add("warn", "perm:zone", "not checked: SYNC_HOSTNAME is not usable (see hostname)");
      zoneUsable = true;
    }

    await permission(
      "perm:observability",
      "observability",
      () =>
        cfCall({
          method: "POST",
          path: `${account}/workers/observability/telemetry/query`,
          body: { queryId: "doctor", timeframe: { from: now - WINDOW_MS, to: now }, view: "events", limit: 1, dry: true },
        }),
      { isNew: true, skipNote: "allow-user.sh needs it" },
    );
    if (env.SEMANTIC_SEARCH_ENABLED === "true") {
      await permission("perm:vectorize", "vectorize", () => cfCall({ path: `${account}/vectorize/v2/indexes` }));
    }

    if (syncHostOk && zoneUsable) {
      checkZone("", syncHost, syncZone);
      if (syncZone !== null) await checkDns("", syncHost, syncWorker, syncZone);
    }

    if (connectorOn) {
      const connectorHost = env.CONNECTOR_HOSTNAME ?? "";
      if (checkHostname("connector-hostname", "CONNECTOR_HOSTNAME", connectorHost) && zoneUsable) {
        let zone;
        if (await guard("connector-zone", async () => (zone = await findZone(connectorHost, cfCall)))) {
          checkZone("connector-", connectorHost, zone);
          if (zone !== null) await checkDns("connector-", connectorHost, connectorWorker, zone);
        }
      }
    }
  } else if (connectorOn) {
    checkHostname("connector-hostname", "CONNECTOR_HOSTNAME", env.CONNECTOR_HOSTNAME ?? "");
  }

  // ---- GitHub ----
  await checkGithub({ env, gh, add, connectorOn });

  // ---- Local files ----
  try {
    const mode = statSync(join(repoRoot, ".env.local")).mode & 0o777;
    if (mode === 0o600) add("ok", "env-mode", ".env.local is mode 600");
    else add("FAIL", "env-mode", `.env.local is mode ${mode.toString(8)}, and it holds secrets: run chmod 600 .env.local`);
  } catch (e) {
    add("FAIL", "env-mode", `can't read .env.local (${e.code ?? e.message}): run scripts/setup.sh`);
  }
  const allowed = parseAllowedUsers(env.DB_SYNC_ALLOWED_USERS);
  if (!allowed.ok) add("FAIL", "allowed-users", allowed.error);
  else add("ok", "allowed-users", allowed.ids.length === 0 ? "none: every user is refused until one is added" : `${allowed.ids.length} user(s) listed`);

  return { results, exitCode: results.some((r) => r.level === "FAIL") ? 1 : 0 };
}

/** The GitHub checks. They compare names and states only: `gh` never shows a secret's value. */
async function checkGithub({ env, gh, add, connectorOn }) {
  const json = (args) => {
    const out = gh(args);
    if (out.status !== 0) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(out.stdout) };
    } catch {
      return { ok: false };
    }
  };

  const repoInfo = json(["repo", "view", "--json", "nameWithOwner,isFork"]);
  if (!repoInfo.ok || typeof repoInfo.value?.nameWithOwner !== "string") {
    add("FAIL", "github", "gh isn't installed or logged in (gh auth login)");
    return;
  }
  const repo = repoInfo.value.nameWithOwner;

  const actions = json(["api", `repos/${repo}/actions/permissions`]);
  if (!actions.ok) add("FAIL", "actions", "couldn't read the repo's Actions settings: run gh auth status, and check you can administer the repo");
  else if (actions.value.enabled !== true) add("FAIL", "actions", "GitHub Actions is disabled on this repo: enable it under Settings → Actions → General (README 1.8)");
  else add("ok", "actions", "GitHub Actions is enabled");

  const environment = json(["api", `repos/${repo}/environments/production`]);
  if (!environment.ok) {
    add("FAIL", "environment", "the production environment doesn't exist: run scripts/setup.sh (README 1.8)");
  } else if (environment.value.deployment_branch_policy?.custom_branch_policies !== true) {
    add("FAIL", "environment", "the production environment isn't restricted to named branches, so any branch could read its secrets: run scripts/setup.sh (README 1.8)");
  } else {
    add("ok", "environment", "the production environment is restricted to named branches");
  }

  const secrets = json(["secret", "list", "-R", repo, "--env", "production", "--json", "name"]);
  const required = connectorOn ? [...REQUIRED_SECRETS, ...CONNECTOR_SECRETS] : REQUIRED_SECRETS;
  if (!secrets.ok) {
    add("FAIL", "secrets", "couldn't list the production environment's secrets (does the environment exist?)");
  } else {
    const present = new Set(secrets.value.map((s) => s.name));
    const missing = required.filter((name) => !present.has(name));
    if (missing.length > 0) add("FAIL", "secrets", `missing from the production environment: ${missing.join(", ")}. scripts/setup.sh pushes them (README 1.8)`);
    else add("ok", "secrets", `all ${required.length} required names are present`);
  }

  // The deploy reads the environment variable, else the repository one, else treats it as off.
  const effective = (() => {
    for (const args of [
      ["variable", "get", "CONNECTOR_ENABLED", "-R", repo, "--env", "production"],
      ["variable", "get", "CONNECTOR_ENABLED", "-R", repo],
    ]) {
      const out = gh(args);
      if (out.status === 0) return out.stdout.trim() || "false";
    }
    return "false";
  })();
  const local = env.CONNECTOR_ENABLED || "false";
  if (effective === local) {
    add("ok", "connector-setting", `CONNECTOR_ENABLED is ${local} on GitHub and in .env.local`);
  } else {
    add("FAIL", "connector-setting", `CONNECTOR_ENABLED is ${effective} on GitHub but ${local} in .env.local. A local OpenTofu run would plan to destroy the connector's resources (README 11.5)`);
  }

  const workflows = json(["workflow", "list", "-R", repo, "--all", "--json", "name,state"]);
  if (!workflows.ok) {
    add("FAIL", "schedules", "couldn't list the repo's workflows");
  } else {
    const wanted = ["backup", "usage", repoInfo.value.isFork ? "sync-upstream" : "bump-upstream"];
    let problems = 0;
    for (const name of wanted) {
      const found = workflows.value.find((w) => w.name === name);
      if (found?.state === "active") continue;
      problems++;
      const why = found ? `is ${found.state}` : "wasn't found in this repo";
      add("warn", "schedules", `the ${name} workflow ${why}, so it won't run on its schedule: gh workflow enable ${name} (README 7)`);
    }
    if (problems === 0) add("ok", "schedules", `${wanted.join(", ")} are active`);
  }
}

const formatResult = (r) => `${r.level.padEnd(4)} ${r.name}: ${r.detail}`;

function ghRunner(repoRoot) {
  return (args) => {
    const out = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: out.error ? 127 : (out.status ?? 1), stdout: out.stdout ?? "" };
  };
}

/** Returns the exit code. */
export async function run(argv, env = process.env) {
  const { values } = parseArgs({ args: argv, options: { "repo-root": { type: "string" } } });
  const repoRoot = values["repo-root"] ?? defaultRepoRoot();
  const apiBase = apiBaseFromEnv(env);
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const cfCall = (opts) => cf({ apiBase, apiToken, ...opts });
  const { results, exitCode } = await runDoctor({ env, cfCall, gh: ghRunner(repoRoot), now: Date.now(), repoRoot });
  for (const r of results) console.log(formatResult(r));
  const failed = results.filter((r) => r.level === "FAIL").length;
  const warnings = results.filter((r) => r.level === "warn").length;
  console.log(`doctor: ${failed} failed, ${warnings} warnings`);
  return exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`error: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
