#!/usr/bin/env node
// Usage: allowed-users.mjs <check-format|check-known|list> [--database <d1 database name>]
// Env: DB_SYNC_ALLOWED_USERS, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and optionally
// ALLOWED_USERS_API_BASE, honoured only with DEPLOY_SYNC_TEST=1 (a stub server in the tests).
//
// The deploy-time and local side of the Worker's user allow-list:
//   check-format  DB_SYNC_ALLOWED_USERS is `none` or a comma-separated list of lowercase UUIDs.
//   check-known   the list names at least one user the sync server already knows (D1 `users`).
//   list          every user of the sync server, and whether each is on the list. Local only.
// Everything that can run in GitHub Actions prints counts and entry positions, never an ID or an
// email. The value's format is the same rule the Worker applies; keep the two in step.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = "DB_SYNC_ALLOWED_USERS";
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

const USERS_SQL =
  "SELECT u.id AS id, u.email AS email, u.username AS username, " +
  "(SELECT count(*) FROM graphs g WHERE g.user_id = u.id) AS graphs FROM users u ORDER BY u.id";

/**
 * Parses the list. Unlike the Worker, a missing or empty value is an error here: the deploy must
 * not ship a forgotten secret. Errors give entry positions, never the entry.
 */
export function parseAllowedUsers(raw) {
  const value = (raw ?? "").trim();
  if (value === "") {
    return { ok: false, error: `${NAME} is empty or missing: set it to your Logseq user ID(s), or none (README section 9)` };
  }
  if (value === "none") return { ok: true, ids: [] };
  const entries = value.split(",").map((entry) => entry.trim());
  for (const [i, entry] of entries.entries()) {
    if (USER_ID.test(entry)) continue;
    const hint = USER_ID.test(entry.toLowerCase()) ? " (use lowercase)" : "";
    return { ok: false, error: `${NAME} entry ${i + 1} of ${entries.length} is not a lowercase UUID${hint}` };
  }
  return { ok: true, ids: entries };
}

/** Compares the listed IDs with the server's users. Both results can apply at once. */
export function compareWithKnownUsers(ids, users) {
  const listed = new Set(ids);
  const known = new Set(users.map((u) => u.id));
  const warnings = [];
  let error = null;

  if (users.length === 0) {
    if (ids.length === 0) {
      warnings.push(`no users have signed in yet, and every user will be refused until ${NAME} lists one (README section 9)`);
    } else {
      // A refused user is never recorded, so a fresh install's owner is not in `users` yet.
      warnings.push(`${ids.length} of ${ids.length} listed user IDs haven't signed in to this server yet`);
    }
    return { error, warnings };
  }

  const unknown = ids.filter((id) => !known.has(id)).length;
  if (unknown === ids.length) {
    error = `none of the ${ids.length} listed user IDs is a known user of this server (${users.length} known); check ${NAME}. Nothing was deployed`;
  } else if (unknown > 0) {
    warnings.push(`${unknown} of ${ids.length} listed user IDs haven't signed in to this server yet`);
  }
  const refusedOwners = users.filter((u) => u.graphs > 0 && !listed.has(u.id)).length;
  if (refusedOwners > 0) warnings.push(`${refusedOwners} users who own graphs aren't on the list and will be refused`);
  return { error, warnings };
}

/** Parses a D1 API response. Throws the API's own error messages, never any rows. */
async function readEnvelope(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`D1 API ${res.status}: response is not JSON`);
  }
  if (!res.ok || body?.success !== true) {
    const messages = Array.isArray(body?.errors) ? body.errors.map((e) => e?.message).filter(Boolean) : [];
    throw new Error(`D1 API ${res.status}: ${messages.length > 0 ? messages.join("; ") : "no error message"}`);
  }
  return body;
}

/** Every user of the sync server's D1 database, with how many graphs each owns. */
export async function fetchUsers({ accountId, apiToken, databaseName, apiBase = DEFAULT_API_BASE, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${apiToken}` };
  const dbUrl = `${apiBase}/accounts/${accountId}/d1/database`;

  const list = await readEnvelope(await fetchImpl(`${dbUrl}?name=${encodeURIComponent(databaseName)}`, { headers }));
  // The name filter isn't guaranteed to be exact.
  const matches = (list.result ?? []).filter((db) => db?.name === databaseName);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one D1 database named ${databaseName}, found ${matches.length}`);
  }

  const query = await readEnvelope(
    await fetchImpl(`${dbUrl}/${matches[0].uuid}/query`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: USERS_SQL }),
    }),
  );
  const rows = query.result?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("D1 API: the users query returned no result set");
  return rows;
}

function table(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((row) => row[c].length)));
  return all.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

async function usersFromEnv(env, databaseName) {
  return fetchUsers({
    accountId: requireEnv(env, "CLOUDFLARE_ACCOUNT_ID"),
    apiToken: requireEnv(env, "CLOUDFLARE_API_TOKEN"),
    databaseName,
    apiBase: env.ALLOWED_USERS_API_BASE || undefined,
  });
}

/** Returns the exit code. In Actions, `::` workflow commands go to stdout, where GitHub reads them. */
export async function run(argv, env = process.env) {
  // A stray variable must never send the API token to another host.
  if (env.ALLOWED_USERS_API_BASE && env.DEPLOY_SYNC_TEST !== "1") {
    console.error("error: ALLOWED_USERS_API_BASE is test-only and requires DEPLOY_SYNC_TEST=1");
    return 1;
  }
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { database: { type: "string" } } });
  const [command] = positionals;
  const inActions = env.GITHUB_ACTIONS === "true";
  const fail = (text) => {
    if (inActions) console.log(`::error::${text}`);
    else console.error(`error: ${text}`);
    return 1;
  };
  const needDatabase = () => {
    if (!values.database) throw new Error(`${command} needs --database <name>`);
    return values.database;
  };

  if (command === "check-format") {
    const parsed = parseAllowedUsers(env[NAME]);
    if (!parsed.ok) return fail(parsed.error);
    if (inActions) for (const id of parsed.ids) console.log(`::add-mask::${id}`);
    console.log(parsed.ids.length === 0 ? `${NAME}: none (every user is refused)` : `${NAME}: ${parsed.ids.length} user(s)`);
    return 0;
  }

  if (command === "check-known") {
    const database = needDatabase();
    const parsed = parseAllowedUsers(env[NAME]);
    if (!parsed.ok) return fail(parsed.error);
    if (inActions) for (const id of parsed.ids) console.log(`::add-mask::${id}`);
    let users;
    try {
      users = await usersFromEnv(env, database);
    } catch (e) {
      return fail(e.message);
    }
    const { error, warnings } = compareWithKnownUsers(parsed.ids, users);
    for (const text of warnings) {
      if (inActions) console.log(`::warning::${text}`);
      else console.error(`warning: ${text}`);
    }
    if (error) return fail(error);
    const known = new Set(users.map((u) => u.id));
    console.log(`allowed users: ${parsed.ids.length} listed, ${parsed.ids.filter((id) => known.has(id)).length} known`);
    return 0;
  }

  if (command === "list") {
    if (inActions) {
      console.error("error: list prints user IDs and emails, so it never runs in GitHub Actions");
      return 1;
    }
    const database = needDatabase();
    const parsed = parseAllowedUsers(env[NAME]);
    const listed = new Set(parsed.ok ? parsed.ids : []);
    const users = await usersFromEnv(env, database);
    if (!parsed.ok) console.error(`note: every user shows as not listed. ${parsed.error}`);
    const rows = users.map((u) => [u.id, u.email ?? "-", u.username ?? "-", String(u.graphs), listed.has(u.id) ? "yes" : "no"]);
    for (const line of table(["id", "email", "username", "graphs", "listed"], rows)) console.log(line);
    return 0;
  }

  console.error("usage: allowed-users.mjs <check-format|check-known|list> [--database <name>]");
  return 1;
}

// Compare real paths: this is a deploy gate, and a symlinked invocation must still run it.
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
