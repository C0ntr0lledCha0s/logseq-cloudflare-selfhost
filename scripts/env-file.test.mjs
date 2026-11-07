import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvValue, setEnvLine } from "./env-file.mjs";
import { runScript } from "./test-helpers.mjs";

const script = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "env-file.mjs");
const NOW = new Date("2026-11-06T09:30:00Z");

const FIXTURE = [
  "# secrets for the stack",
  "export A=1",
  "  B='x y'",
  "",
  "DB_SYNC_ALLOWED_USERS=none",
  "export CONNECTOR_ENABLED=false",
  "TAIL=last",
  "",
].join("\n");

function withEnvFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "env-file-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, content, { mode: 0o600 });
  return Promise.resolve(fn(file, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("setEnvLine rewrites only the named line, after a mode-600 backup", () =>
  withEnvFile(FIXTURE, (file, dir) => {
    const backup = setEnvLine(file, "DB_SYNC_ALLOWED_USERS", "11111111-1111-4111-8111-111111111111", { now: NOW });
    assert.equal(backup, `${file}.bak-20261106093000`);
    assert.equal(readFileSync(backup, "utf8"), FIXTURE);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), FIXTURE.replace("DB_SYNC_ALLOWED_USERS=none", "DB_SYNC_ALLOWED_USERS=11111111-1111-4111-8111-111111111111"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // No temp file is left behind.
    assert.deepEqual(readdirSync(dir).sort(), [".env.local", ".env.local.bak-20261106093000"]);
  }));

test("setEnvLine keeps the export prefix and the indentation", () =>
  withEnvFile(FIXTURE + "  export INDENTED=old\n", (file) => {
    setEnvLine(file, "CONNECTOR_ENABLED", "true", { now: NOW });
    setEnvLine(file, "INDENTED", "new", { now: new Date("2026-11-06T09:30:01Z") });
    const text = readFileSync(file, "utf8");
    assert.match(text, /^export CONNECTOR_ENABLED=true$/m);
    assert.match(text, /^ {2}export INDENTED=new$/m);
  }));

test("setEnvLine keeps a CRLF line ending", () =>
  withEnvFile("A=1\r\nCONNECTOR_ENABLED=false\r\nB=2\r\n", (file) => {
    setEnvLine(file, "CONNECTOR_ENABLED", "true", { now: NOW });
    assert.equal(readFileSync(file, "utf8"), "A=1\r\nCONNECTOR_ENABLED=true\r\nB=2\r\n");
  }));

test("setEnvLine does not match a name that merely starts or ends the same, or a comment", () =>
  withEnvFile("# CONNECTOR_ENABLED=false\nXCONNECTOR_ENABLED=false\nCONNECTOR_ENABLED_X=false\nCONNECTOR_ENABLED=false\n", (file) => {
    setEnvLine(file, "CONNECTOR_ENABLED", "true", { now: NOW });
    assert.equal(
      readFileSync(file, "utf8"),
      "# CONNECTOR_ENABLED=false\nXCONNECTOR_ENABLED=false\nCONNECTOR_ENABLED_X=false\nCONNECTOR_ENABLED=true\n",
    );
  }));

test("setEnvLine throws with the --add-missing hint when the name is absent, and writes nothing", () =>
  withEnvFile(FIXTURE, (file, dir) => {
    assert.throws(
      () => setEnvLine(file, "NOT_THERE", "x", { now: NOW }),
      (e) => e.message === `NOT_THERE is not in ${file}; add it with scripts/init-env.sh --add-missing`,
    );
    assert.equal(readFileSync(file, "utf8"), FIXTURE);
    assert.deepEqual(readdirSync(dir), [".env.local"]);
  }));

test("setEnvLine refuses values with whitespace, quotes, $, a newline, or nothing", () =>
  withEnvFile(FIXTURE, (file, dir) => {
    for (const value of ["a b", "a\tb", "$x", "a'b", 'a"b', "a\nb", "a\rb", ""]) {
      assert.throws(() => setEnvLine(file, "DB_SYNC_ALLOWED_USERS", value, { now: NOW }), /refusing value/, JSON.stringify(value));
    }
    assert.equal(readFileSync(file, "utf8"), FIXTURE);
    assert.deepEqual(readdirSync(dir), [".env.local"]);
  }));

test("setEnvLine refusals never print the value", () =>
  withEnvFile(FIXTURE, (file) => {
    assert.throws(
      () => setEnvLine(file, "DB_SYNC_ALLOWED_USERS", "s3cret value", { now: NOW }),
      (e) => !e.message.includes("s3cret"),
    );
  }));

test("setEnvLine refuses a name that is not a shell variable name", () =>
  withEnvFile(FIXTURE, (file) => {
    assert.throws(() => setEnvLine(file, "A.*", "x", { now: NOW }), /invalid name/);
  }));

test("setEnvLine does not overwrite an existing backup", () =>
  withEnvFile(FIXTURE, (file) => {
    setEnvLine(file, "CONNECTOR_ENABLED", "true", { now: NOW });
    const after = readFileSync(file, "utf8");
    assert.throws(() => setEnvLine(file, "CONNECTOR_ENABLED", "false", { now: NOW }), /EEXIST/);
    assert.equal(readFileSync(file, "utf8"), after);
    assert.equal(readFileSync(`${file}.bak-20261106093000`, "utf8"), FIXTURE);
  }));

test("readEnvValue reads NAME=, export NAME=, indented, CRLF and quoted lines", () =>
  withEnvFile(
    ["A=1", "export E=two", "  I=three", "Q1='x y'", 'Q2="p q"', "MIX='x\"", "EMPTY=", "CR=four\r", "# C=no", ""].join("\n"),
    (file) => {
      assert.equal(readEnvValue(file, "A"), "1");
      assert.equal(readEnvValue(file, "E"), "two");
      assert.equal(readEnvValue(file, "I"), "three");
      assert.equal(readEnvValue(file, "Q1"), "x y");
      assert.equal(readEnvValue(file, "Q2"), "p q");
      assert.equal(readEnvValue(file, "MIX"), "'x\"");
      assert.equal(readEnvValue(file, "EMPTY"), "");
      assert.equal(readEnvValue(file, "CR"), "four");
      assert.equal(readEnvValue(file, "C"), undefined);
      assert.equal(readEnvValue(file, "ABSENT"), undefined);
    },
  ));

test("a name on more than one line is refused by readEnvValue and setEnvLine, with nothing written", () =>
  withEnvFile("A=first\nexport A=second\n  A=third\n# A=comment\nB=1\n", (file, dir) => {
    const before = readFileSync(file, "utf8");
    const message = `A appears 3 times in ${file}; keep one line`;
    assert.throws(() => readEnvValue(file, "A"), (e) => e.message === message);
    assert.throws(() => setEnvLine(file, "A", "new", { now: NOW }), (e) => e.message === message);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), [".env.local"]);
    // Another name in the same file is unaffected.
    assert.equal(readEnvValue(file, "B"), "1");
  }));

test("a name with one line and a commented copy is accepted", () =>
  withEnvFile("# A=old\nA=1\n", (file) => {
    assert.equal(readEnvValue(file, "A"), "1");
    setEnvLine(file, "A", "2", { now: NOW });
    assert.equal(readFileSync(file, "utf8"), "# A=old\nA=2\n");
  }));

test("CLI get and set exit non-zero on a duplicated name, and change nothing", () =>
  withEnvFile("A=first\nA=second\n", async (file, dir) => {
    const get = await runScript(script, ["get", "A", "--file", file]);
    assert.equal(get.status, 1);
    assert.equal(get.stdout, "");
    assert.match(get.stderr, /A appears 2 times in .*; keep one line/);
    const set = await runScript(script, ["set", "A", "--file", file], { env: { ENV_FILE_VALUE: "new" } });
    assert.equal(set.status, 1);
    assert.match(set.stderr, /A appears 2 times in .*; keep one line/);
    assert.equal(readFileSync(file, "utf8"), "A=first\nA=second\n");
    assert.deepEqual(readdirSync(dir), [".env.local"]);
  }));

test("CLI get prints the value", () =>
  withEnvFile(FIXTURE, async (file) => {
    const r = await runScript(script, ["get", "B", "--file", file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "x y\n");
  }));

test("CLI get of an absent name exits 1 and says so", () =>
  withEnvFile(FIXTURE, async (file) => {
    const r = await runScript(script, ["get", "NOPE", "--file", file]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /NOPE is not in /);
  }));

test("CLI set takes the value from ENV_FILE_VALUE and never prints it", () =>
  withEnvFile(FIXTURE, async (file, dir) => {
    const r = await runScript(script, ["set", "DB_SYNC_ALLOWED_USERS", "--file", file], { env: { ENV_FILE_VALUE: "uniquevalue123" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^DB_SYNC_ALLOWED_USERS updated \(backup: \.env\.local\.bak-\d{14}\)\n$/);
    assert.ok(!r.stdout.includes("uniquevalue123") && !r.stderr.includes("uniquevalue123"));
    assert.equal(readEnvValue(file, "DB_SYNC_ALLOWED_USERS"), "uniquevalue123");
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(".env.local.bak-")).length, 1);
  }));

test("CLI set without ENV_FILE_VALUE fails and changes nothing", () =>
  withEnvFile(FIXTURE, async (file, dir) => {
    const r = await runScript(script, ["set", "DB_SYNC_ALLOWED_USERS", "--file", file], { env: { ENV_FILE_VALUE: undefined } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ENV_FILE_VALUE/);
    assert.equal(readFileSync(file, "utf8"), FIXTURE);
    assert.deepEqual(readdirSync(dir), [".env.local"]);
  }));

test("CLI set refuses a bad value without echoing it", () =>
  withEnvFile(FIXTURE, async (file) => {
    const r = await runScript(script, ["set", "DB_SYNC_ALLOWED_USERS", "--file", file], { env: { ENV_FILE_VALUE: "bad value" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing value/);
    assert.ok(!r.stderr.includes("bad value"));
    assert.equal(readFileSync(file, "utf8"), FIXTURE);
  }));

test("CLI defaults to .env.local at the repo root, and refuses --file with no path", async () => {
  const r = await runScript(script, ["get", "A", "--file"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
  const bad = await runScript(script, ["frobnicate", "A"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage:/);
});

test("CLI runs through a symlink", () =>
  withEnvFile(FIXTURE, async (file, dir) => {
    const link = join(dir, "env-file-link.mjs");
    symlinkSync(script, link);
    const r = await runScript(process.execPath, [link, "get", "A", "--file", file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "1\n");
    assert.ok(existsSync(file));
  }));
