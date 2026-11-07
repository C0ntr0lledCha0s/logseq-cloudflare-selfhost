#!/usr/bin/env node
// Usage: env-file.mjs get NAME [--file <path>]
//        ENV_FILE_VALUE=<value> env-file.mjs set NAME [--file <path>]
// Reads or rewrites one line of an env file (default: .env.local at the repo root). The new value
// comes from ENV_FILE_VALUE, never argv, and is never printed. `set` first copies the file to
// `<file>.bak-YYYYMMDDHHMMSS` (UTC, mode 600), then replaces the `NAME=` line through a
// temp file and a rename, so the file is never half-written. Only that line changes, and it keeps
// its `export ` prefix, indentation and line ending.
//
// The line forms match init-env.sh --push-only: `NAME=`, `export NAME=`, an indented line, a
// trailing CR, and one pair of matching surrounding quotes removed.
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_VALUE = /[\s'"$]/;

function checkName(name) {
  if (!NAME.test(name)) throw new Error(`invalid name: ${JSON.stringify(name)}`);
}

/**
 * Splits `text` into lines and finds the one `NAME=` line. Returns { lines, index, match }, with
 * index -1 when there is none. A name on more than one line is refused: init-env.sh reads the last
 * such line, so editing or reading any other would silently disagree with what gets pushed.
 */
function findLine(text, name, path) {
  const pattern = new RegExp(`^(\\s*(?:export\\s+)?${name}=)(.*?)(\\r?)$`);
  const lines = text.split("\n");
  const found = [];
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line);
    if (match) found.push({ index, match });
  }
  if (found.length > 1) throw new Error(`${name} appears ${found.length} times in ${path}; keep one line`);
  return found.length === 1 ? { lines, ...found[0] } : { lines, index: -1, match: null };
}

function unquote(value) {
  const first = value[0];
  if (value.length >= 2 && (first === "'" || first === '"') && value.at(-1) === first) return value.slice(1, -1);
  return value;
}

/** The value of the `NAME=` line, or undefined when there is none. */
export function readEnvValue(path, name) {
  checkName(name);
  const { match } = findLine(readFileSync(path, "utf8"), name, path);
  return match ? unquote(match[2]) : undefined;
}

function stamp(now) {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:TZ]/g, "");
}

/**
 * Replaces the `NAME=` line with `NAME=value` after backing the file up. Returns the backup
 * path. Refuses a value with whitespace, a quote or `$` (it is written unquoted and would not read
 * back as itself in a shell), and an empty one. Error messages never include the value.
 */
export function setEnvLine(path, name, value, { now = new Date() } = {}) {
  checkName(name);
  if (value === "" || UNSAFE_VALUE.test(value)) {
    throw new Error(`refusing value for ${name}: it must be non-empty and contain no whitespace, quote or $`);
  }
  const original = readFileSync(path);
  const { lines, index, match } = findLine(original.toString("utf8"), name, path);
  if (!match) throw new Error(`${name} is not in ${path}; add it with scripts/init-env.sh --add-missing`);

  // Flag "wx": two edits in the same second must not replace the earlier backup.
  const backup = `${path}.bak-${stamp(now)}`;
  writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
  chmodSync(backup, 0o600);

  lines[index] = `${match[1]}${value}${match[3]}`;
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    writeFileSync(temp, lines.join("\n"), { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return backup;
}

const USAGE = "usage: env-file.mjs get NAME [--file <path>] | ENV_FILE_VALUE=<value> env-file.mjs set NAME [--file <path>]";

function defaultFile() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
}

export function run(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { file: { type: "string" } }, allowPositionals: true });
  } catch {
    console.error(USAGE);
    return 1;
  }
  const [command, name, ...extra] = parsed.positionals;
  if (!["get", "set"].includes(command) || name === undefined || extra.length > 0) {
    console.error(USAGE);
    return 1;
  }
  const file = parsed.values.file ?? defaultFile();

  if (command === "get") {
    const value = readEnvValue(file, name);
    if (value === undefined) throw new Error(`${name} is not in ${file}`);
    console.log(value);
    return 0;
  }
  const value = env.ENV_FILE_VALUE;
  if (value === undefined) throw new Error("set takes the new value from the environment variable ENV_FILE_VALUE");
  const backup = setEnvLine(file, name, value);
  console.log(`${name} updated (backup: ${basename(backup)})`);
  return 0;
}

// Compare real paths so a symlinked invocation still runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}
