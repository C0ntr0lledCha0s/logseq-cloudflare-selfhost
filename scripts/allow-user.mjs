#!/usr/bin/env node
// Usage: allow-user.mjs [--owner] [--wait <minutes, default 10>] [--show-ids]
//   (normally run through allow-user.sh, which loads .env.local)
// Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SYNC_HOSTNAME. CF_API_BASE and CF_API_TEST are for tests
// (cloudflare-api.mjs). ALLOW_USER_POLL_SECONDS (seconds between polls, default 10) is for tests and
// needs ALLOW_USER_TEST=1.
//
// Claims a fresh sync server for its owner (--owner), or adds one more person to an existing one. The
// sync Worker refuses every user who isn't on DB_SYNC_ALLOWED_USERS and logs each refusal
// (`db-sync/user-not-allowed`, with the user's `sub` and email). This finds those refusals in Workers
// Logs, asks at the terminal whether to allow one, writes its ID into .env.local (keeping a backup),
// pushes the secret and redeploys. Only one person is added per run. It prints emails, so it never runs
// in GitHub Actions.
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fetchUsers, parseAllowedUsers } from "./allowed-users.mjs";
import { apiBaseFromEnv, cf, CfError } from "./cloudflare-api.mjs";
import { readEnvValue, setEnvLine } from "./env-file.mjs";
import { tokenLink } from "./token-link.mjs";

const NAME = "DB_SYNC_ALLOWED_USERS";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
const LOOKBACK_MS = 30 * 60 * 1000;
const POLL_OVERLAP_MS = 60 * 1000;
const USAGE = "usage: allow-user.mjs [--owner] [--wait <minutes>] [--show-ids]";

// A value written after its key, in the forms the event can take once serialised: EDN text (`:sub "x"`),
// a JSON member (`"sub":"x"`), and a JSON object embedded in a string (`\"sub\":\"x\"`). Whitespace,
// including the escaped `\n` of an embedded string, may sit between the key and the value.
const GAP = String.raw`(?:\s|\\[nrt])*`;
const keyedValue = (key, value) =>
  new RegExp(String.raw`(?::${key}|\\?"${key}\\?"${GAP}:)${GAP}\\?"(${value})\\?"`);
const SUB = keyedValue("sub", UUID);
const EMAIL_VALUE = keyedValue("email", EMAIL);

/**
 * The `sub` and email in a `user-not-allowed` log event, or null when it isn't one. It reads the whole
 * serialised event, so it works whether the map was logged as text or as an object. Both values are
 * taken from their own key: a real event carries other UUIDs (script version, trace ids), and a wrong ID
 * would be written and pushed unnoticed. No `sub` key means no refusal, never an unanchored UUID.
 */
export function parseRefusal(event) {
  const text = JSON.stringify(event) ?? "";
  if (!text.includes("user-not-allowed")) return null;
  const sub = SUB.exec(text)?.[1];
  if (sub === undefined) return null;
  return { sub, email: EMAIL_VALUE.exec(text)?.[1] ?? null };
}

/** The refused sign-ins logged by the sync Worker between the two times (ms), one per sub. */
export async function findRefusals({ cfCall, accountId, workerName, fromMs, toMs }) {
  const res = await cfCall({
    method: "POST",
    path: `/accounts/${accountId}/workers/observability/telemetry/query`,
    body: {
      queryId: "allow-user",
      timeframe: { from: fromMs, to: toMs },
      view: "events",
      limit: 100,
      dry: true,
      parameters: {
        filters: [
          { key: "$metadata.message", operation: "includes", type: "string", value: "user-not-allowed" },
          { key: "$workers.scriptName", operation: "eq", type: "string", value: workerName },
        ],
      },
    },
  });
  const list = res.result?.events?.events;
  if (!Array.isArray(list)) throw new Error("Workers Logs query: the response has no events list (result.events.events)");
  const bySub = new Map();
  for (const event of list) {
    const refusal = parseRefusal(event);
    if (refusal !== null && !bySub.has(refusal.sub)) bySub.set(refusal.sub, refusal);
  }
  return [...bySub.values()];
}

/** "owner" or "add". Throws when the local list, the server's users and the flag disagree. */
export function chooseMode({ owner, localList, knownUsers }) {
  if (localList === "none" && knownUsers > 0) {
    throw new Error(
      `.env.local looks out of date: the server has ${knownUsers} users but ${NAME} is none here. ` +
        "Restore the current .env.local (password manager or your other machine), then re-run.",
    );
  }
  if (owner) {
    if (localList !== "none") {
      throw new Error("the server is already claimed; run scripts/allow-user.sh without --owner to add someone");
    }
    return "owner";
  }
  if (localList === "none") throw new Error("the list is none: run scripts/allow-user.sh --owner to claim the server first");
  return "add";
}

/** The list after allowing `sub`. */
export function nextList(mode, localList, sub) {
  if (mode === "owner") return sub;
  return localList.split(",").includes(sub) ? localList : `${localList},${sub}`;
}

/**
 * Writes the list into the env file (after a backup) and reads it back through the same format check
 * the deploy uses. An invalid value puts the file back as it was. Returns the backup path.
 */
export function writeAllowedUsers(path, value) {
  const backup = setEnvLine(path, NAME, value);
  const parsed = parseAllowedUsers(readEnvValue(path, NAME));
  if (!parsed.ok) {
    copyFileSync(backup, path);
    chmodSync(path, 0o600);
    throw new Error(parsed.error);
  }
  return backup;
}

/** Reads one line from stdin at a time. A closed stdin answers with an empty line. */
function lineReader(input) {
  let rl = null;
  let lines = null;
  return {
    async next() {
      if (lines === null) {
        rl = createInterface({ input });
        lines = rl[Symbol.asyncIterator]();
      }
      const { value, done } = await lines.next();
      return done ? "" : value;
    },
    close: () => rl?.close(),
  };
}

function waitingMessage(mode, host) {
  if (mode === "owner") {
    return `In Logseq, set the sync server to https://${host} and sign in. You'll be refused; that's expected. Waiting for the sign-in…`;
  }
  return `Ask them to sign in to https://${host} in Logseq. They'll be refused; that's expected. Waiting for the sign-in…`;
}

function nothingAcceptedMessage(minutes, host) {
  return [
    `No refused sign-in was accepted within ${minutes} minutes, and nothing was changed. Check that:`,
    `  - Logseq's sync server is set to https://${host}`,
    "  - you're using the nightly Logseq client",
    "  - the sign-in really went to this server (a refused sign-in shows an error in Logseq)",
    "Then run scripts/allow-user.sh again, with --wait <minutes> to wait longer.",
  ].join("\n");
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

function readSetting(repoRoot, name) {
  const value = JSON.parse(readFileSync(join(repoRoot, "config", "settings.json"), "utf8"))[name];
  if (typeof value !== "string" || value === "") throw new Error(`missing setting: ${name}`);
  return value;
}

/** Runs one of this repo's scripts from the repo root with its output shown. Returns whether it succeeded. */
function runRepoScript(repoRoot, script, args, env) {
  const result = spawnSync(join(repoRoot, "scripts", script), args, { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  return result.status === 0;
}

/** Returns the exit code. */
export async function run(argv, env = process.env, stdin = process.stdin) {
  // Refuse before reading anything: this prints emails.
  if (env.GITHUB_ACTIONS === "true") {
    console.error("error: allow-user prints emails, so it never runs in GitHub Actions");
    return 1;
  }
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: { owner: { type: "boolean" }, wait: { type: "string", default: "10" }, "show-ids": { type: "boolean" }, "repo-root": { type: "string" } },
    }).values;
  } catch (e) {
    console.error(`error: ${e.message}\n${USAGE}`);
    return 1;
  }
  const waitMinutes = args.wait.trim() === "" ? NaN : Number(args.wait);
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0) {
    console.error("error: --wait must be a number of minutes, 0 or more");
    return 1;
  }
  let pollMs = 10_000;
  if (env.ALLOW_USER_POLL_SECONDS) {
    if (env.ALLOW_USER_TEST !== "1") {
      console.error("error: ALLOW_USER_POLL_SECONDS is test-only and requires ALLOW_USER_TEST=1");
      return 1;
    }
    pollMs = Number(env.ALLOW_USER_POLL_SECONDS) * 1000;
    if (!Number.isFinite(pollMs) || pollMs < 0) throw new Error("ALLOW_USER_POLL_SECONDS must be a number of seconds");
  }

  const repoRoot = args["repo-root"] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const envFile = join(repoRoot, ".env.local");
  if (!existsSync(envFile)) {
    console.error("error: no .env.local; run scripts/setup.sh first");
    return 1;
  }
  const localList = (readEnvValue(envFile, NAME) ?? "").trim();
  const parsedList = parseAllowedUsers(localList);
  if (!parsedList.ok) {
    console.error(`error: ${parsedList.error}`);
    return 1;
  }

  const accountId = requireEnv(env, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv(env, "CLOUDFLARE_API_TOKEN");
  const host = requireEnv(env, "SYNC_HOSTNAME");
  const apiBase = apiBaseFromEnv(env);
  const cfCall = (opts) => cf({ apiBase, apiToken, ...opts });

  const users = await fetchUsers({ accountId, apiToken, databaseName: readSetting(repoRoot, "d1DatabaseName"), apiBase });
  let mode;
  try {
    mode = chooseMode({ owner: args.owner === true, localList, knownUsers: users.length });
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }

  const workerName = readSetting(repoRoot, "workerName");
  console.log(waitingMessage(mode, host));
  const reader = lineReader(stdin);
  const ask = async ({ sub, email }) => {
    const who = email ?? "an account with no email";
    process.stderr.write(`Allow ${args["show-ids"] ? `${who} [${sub}]` : who}? [y/N] `);
    return ["y", "yes"].includes((await reader.next()).trim().toLowerCase());
  };

  let accepted = null;
  try {
    const deadline = Date.now() + waitMinutes * 60_000;
    const offered = new Set();
    let previousStart = null;
    while (accepted === null) {
      const toMs = Date.now();
      const fromMs = previousStart === null ? toMs - LOOKBACK_MS : previousStart - POLL_OVERLAP_MS;
      previousStart = toMs;
      let refusals;
      try {
        refusals = await findRefusals({ cfCall, accountId, workerName, fromMs, toMs });
      } catch (e) {
        if (e instanceof CfError && (e.status === 401 || e.status === 403)) {
          console.error(`error: the token can't read Workers Logs: add "Workers Observability Write" to it, or make a new token with ${tokenLink()}`);
          return 1;
        }
        throw e;
      }
      for (const refusal of refusals) {
        if (offered.has(refusal.sub)) continue;
        offered.add(refusal.sub);
        if (await ask(refusal)) {
          accepted = refusal;
          break;
        }
      }
      const remaining = deadline - Date.now();
      if (accepted !== null || remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }
  } finally {
    reader.close();
  }

  if (accepted === null) {
    console.error(nothingAcceptedMessage(waitMinutes, host));
    return 1;
  }

  const backup = writeAllowedUsers(envFile, nextList(mode, localList, accepted.sub));
  console.log(`${NAME} updated in .env.local (backup: ${basename(backup)}). Pushing it and deploying…`);
  if (!runRepoScript(repoRoot, "init-env.sh", ["--push-only", NAME], env)) {
    console.error(`error: the secret was not pushed. .env.local is updated; run scripts/init-env.sh --push-only ${NAME}, then scripts/run-deploy.sh`);
    return 1;
  }
  if (!runRepoScript(repoRoot, "run-deploy.sh", [], env)) {
    console.error("error: the deploy did not succeed. The secret is pushed; run scripts/run-deploy.sh to deploy again");
    return 1;
  }
  console.log("Sign in again. (Re-enter the server URL first if Logseq signed you out.)");
  return 0;
}

// Compare real paths so a symlinked invocation still runs.
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
