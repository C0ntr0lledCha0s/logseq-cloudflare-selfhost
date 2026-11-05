import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareWithKnownUsers, fetchUsers, parseAllowedUsers } from "./allowed-users.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "allowed-users.mjs");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
// Has hex letters, so upper-casing it changes it.
const D = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EMAIL = "owner@example.com";

const EMPTY_OR_MISSING =
  "DB_SYNC_ALLOWED_USERS is empty or missing: set it to your Logseq user ID(s), or none (README section 9)";

test("parseAllowedUsers: none means nobody", () => {
  assert.deepEqual(parseAllowedUsers("none"), { ok: true, ids: [] });
  assert.deepEqual(parseAllowedUsers(" none\n"), { ok: true, ids: [] });
});

test("parseAllowedUsers: comma-separated IDs, trimmed", () => {
  assert.deepEqual(parseAllowedUsers(`${A}, ${B}`), { ok: true, ids: [A, B] });
  assert.deepEqual(parseAllowedUsers(` ${A}\n`), { ok: true, ids: [A] });
});

test("parseAllowedUsers: empty or missing is not ok", () => {
  for (const raw of ["", undefined, "  \n"]) {
    assert.deepEqual(parseAllowedUsers(raw), { ok: false, error: EMPTY_OR_MISSING }, JSON.stringify(raw));
  }
});

test("parseAllowedUsers: upper case is rejected with a hint and never echoed", () => {
  const upper = D.toUpperCase();
  assert.notEqual(upper, D);
  const r = parseAllowedUsers(upper);
  assert.equal(r.ok, false);
  assert.match(r.error, /entry 1 of 1 .*use lowercase/);
  assert.match(r.error, /\(use lowercase\)$/);
  assert.ok(!r.error.includes(upper));
  assert.ok(!r.error.toLowerCase().includes(D));
});

test("parseAllowedUsers: empty entries and non-UUIDs are errors naming the position only", () => {
  const trailing = parseAllowedUsers(`${A},`);
  assert.equal(trailing.ok, false);
  assert.equal(trailing.error, "DB_SYNC_ALLOWED_USERS entry 2 of 2 is not a lowercase UUID");
  const gap = parseAllowedUsers(`${A},,${B}`);
  assert.equal(gap.ok, false);
  assert.equal(gap.error, "DB_SYNC_ALLOWED_USERS entry 2 of 3 is not a lowercase UUID");
  const bob = parseAllowedUsers("bob");
  assert.equal(bob.ok, false);
  assert.equal(bob.error, "DB_SYNC_ALLOWED_USERS entry 1 of 1 is not a lowercase UUID");
  assert.ok(!bob.error.includes("bob"));
});

test("parseAllowedUsers: none inside a list is not a UUID", () => {
  assert.equal(parseAllowedUsers(`${A},none`).ok, false);
});

test("compareWithKnownUsers: all listed and known is clean", () => {
  assert.deepEqual(compareWithKnownUsers([A], [{ id: A, graphs: 1 }]), { error: null, warnings: [] });
});

test("compareWithKnownUsers: no listed ID known is an error, and the owner warning still comes", () => {
  const r = compareWithKnownUsers([B], [{ id: A, graphs: 1 }]);
  assert.equal(
    r.error,
    "none of the 1 listed user IDs is a known user of this server (1 known); check DB_SYNC_ALLOWED_USERS. Nothing was deployed",
  );
  assert.ok(r.warnings.includes("1 users who own graphs aren't on the list and will be refused"));
});

test("compareWithKnownUsers: none on an install that has users is an error with n = 0", () => {
  const r = compareWithKnownUsers([], [{ id: A, graphs: 0 }]);
  assert.equal(
    r.error,
    "none of the 0 listed user IDs is a known user of this server (1 known); check DB_SYNC_ALLOWED_USERS. Nothing was deployed",
  );
});

test("compareWithKnownUsers: a fresh install with none only warns", () => {
  assert.deepEqual(compareWithKnownUsers([], []), {
    error: null,
    warnings: [
      "no users have signed in yet, and every user will be refused until DB_SYNC_ALLOWED_USERS lists one (README section 9)",
    ],
  });
});

test("compareWithKnownUsers: an empty users table with listed IDs warns, not errors", () => {
  assert.deepEqual(compareWithKnownUsers([A], []), {
    error: null,
    warnings: ["1 of 1 listed user IDs haven't signed in to this server yet"],
  });
});

test("compareWithKnownUsers: listed IDs that haven't signed in warn", () => {
  assert.deepEqual(compareWithKnownUsers([A, C], [{ id: A, graphs: 1 }]), {
    error: null,
    warnings: ["1 of 2 listed user IDs haven't signed in to this server yet"],
  });
});

test("compareWithKnownUsers: unlisted graph owners warn, unlisted users without graphs do not", () => {
  assert.deepEqual(compareWithKnownUsers([A], [{ id: A, graphs: 1 }, { id: B, graphs: 2 }]), {
    error: null,
    warnings: ["1 users who own graphs aren't on the list and will be refused"],
  });
  assert.deepEqual(compareWithKnownUsers([A], [{ id: A, graphs: 1 }, { id: B, graphs: 0 }]), {
    error: null,
    warnings: [],
  });
});

// A fetchImpl that serves the two D1 calls and records them.
function d1Fetch({ databases, rows = [], queryResponse, listResponse }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    if (u.pathname.endsWith("/d1/database")) {
      return (
        listResponse ??
        new Response(JSON.stringify({ success: true, errors: [], result: databases }), { status: 200 })
      );
    }
    return (
      queryResponse ??
      new Response(JSON.stringify({ success: true, errors: [], result: [{ results: rows, success: true, meta: {} }] }), {
        status: 200,
      })
    );
  };
  return { fetchImpl, calls };
}

const FETCH_ARGS = { accountId: "acct", apiToken: "tok", databaseName: "logseq-sync-index" };

test("fetchUsers: picks the exact name match and returns the rows", async () => {
  const rows = [{ id: A, email: EMAIL, username: null, graphs: 2 }];
  const { fetchImpl, calls } = d1Fetch({
    databases: [
      { uuid: "uuid-old", name: "logseq-sync-index-old" },
      { uuid: "uuid-1", name: "logseq-sync-index" },
    ],
    rows,
  });
  const got = await fetchUsers({ ...FETCH_ARGS, apiBase: "https://api.test/v4", fetchImpl });
  assert.deepEqual(got, rows);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.test/v4/accounts/acct/d1/database?name=logseq-sync-index");
  assert.equal(calls[1].url, "https://api.test/v4/accounts/acct/d1/database/uuid-1/query");
  assert.equal(calls[1].init.method, "POST");
  assert.match(JSON.parse(calls[1].init.body).sql, /FROM users u/);
  for (const c of calls) assert.equal(c.init.headers.Authorization, "Bearer tok");
});

test("fetchUsers: zero or two exact matches throw", async () => {
  const none = d1Fetch({ databases: [{ uuid: "u", name: "logseq-sync-index-old" }] });
  await assert.rejects(fetchUsers({ ...FETCH_ARGS, fetchImpl: none.fetchImpl }), /database/);
  const two = d1Fetch({
    databases: [
      { uuid: "u1", name: "logseq-sync-index" },
      { uuid: "u2", name: "logseq-sync-index" },
    ],
  });
  await assert.rejects(fetchUsers({ ...FETCH_ARGS, fetchImpl: two.fetchImpl }), /database/);
  assert.equal(two.calls.length, 1, "no query is sent when the database is ambiguous");
});

test("fetchUsers: a 403 throws the API's error message and nothing else", async () => {
  const forbidden = () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }], result: null }), {
      status: 403,
    });
  const listDenied = d1Fetch({ listResponse: forbidden() });
  await assert.rejects(fetchUsers({ ...FETCH_ARGS, fetchImpl: listDenied.fetchImpl }), {
    message: "D1 API 403: Authentication error",
  });
  const queryDenied = d1Fetch({ databases: [{ uuid: "u", name: "logseq-sync-index" }], queryResponse: forbidden() });
  await assert.rejects(fetchUsers({ ...FETCH_ARGS, fetchImpl: queryDenied.fetchImpl }), {
    message: "D1 API 403: Authentication error",
  });
});

test("fetchUsers: success false on a 200 throws, and never echoes rows", async () => {
  const { fetchImpl } = d1Fetch({
    databases: [{ uuid: "u", name: "logseq-sync-index" }],
    queryResponse: new Response(
      JSON.stringify({ success: false, errors: [{ message: "bad sql" }], result: [{ results: [{ id: A, email: EMAIL }] }] }),
      { status: 200 },
    ),
  });
  await assert.rejects(fetchUsers({ ...FETCH_ARGS, fetchImpl }), (e) => {
    assert.equal(e.message, "D1 API 200: bad sql");
    assert.ok(!e.message.includes(A) && !e.message.includes(EMAIL));
    return true;
  });
});

// --- CLI, against a local stub of the Cloudflare API ---

async function withStub({ rows = [{ id: A, email: EMAIL, username: "owner", graphs: 1 }, { id: B, email: null, username: null, graphs: 0 }], status = 200 } = {}, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (status !== 200) {
      res.statusCode = status;
      res.end(JSON.stringify({ success: false, errors: [{ message: "stub failure" }], result: null, leak: [A, EMAIL] }));
    } else if (req.url.startsWith("/accounts/acct/d1/database?")) {
      res.end(JSON.stringify({ success: true, errors: [], result: [{ uuid: "uuid-1", name: "logseq-sync-index" }] }));
    } else if (req.url === "/accounts/acct/d1/database/uuid-1/query") {
      res.end(JSON.stringify({ success: true, errors: [], result: [{ results: rows, success: true, meta: {} }] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function cli(args, env) {
  return new Promise((resolveRun, reject) => {
    const base = { ...process.env, GITHUB_ACTIONS: "", DEPLOY_SYNC_TEST: "1", DB_SYNC_ALLOWED_USERS: "", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" };
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...base, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

/** What an Actions log would show: everything except the ::add-mask:: lines. */
function unmasked(r) {
  return (r.stdout + r.stderr)
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
}
function assertNoIdentifiers(r) {
  const text = unmasked(r);
  for (const secret of [A, B, C, EMAIL]) assert.ok(!text.includes(secret), `output leaked ${secret}: ${text}`);
}

test("cli check-format: masks IDs in Actions before the summary", async () => {
  const r = await cli(["check-format"], { DB_SYNC_ALLOWED_USERS: `${A},${B}`, GITHUB_ACTIONS: "true" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.deepEqual(lines, [`::add-mask::${A}`, `::add-mask::${B}`, "DB_SYNC_ALLOWED_USERS: 2 user(s)"]);
  assertNoIdentifiers(r);
});

test("cli check-format: none and no masks outside Actions", async () => {
  const r = await cli(["check-format"], { DB_SYNC_ALLOWED_USERS: "none" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "DB_SYNC_ALLOWED_USERS: none (every user is refused)");
  const local = await cli(["check-format"], { DB_SYNC_ALLOWED_USERS: A });
  assert.equal(local.stdout.trim(), "DB_SYNC_ALLOWED_USERS: 1 user(s)");
});

test("cli check-format: a bad value exits 1 with the error on stderr and no value", async () => {
  for (const value of ["", D.toUpperCase(), "bob", `${A},,${B}`]) {
    const r = await cli(["check-format"], { DB_SYNC_ALLOWED_USERS: value, GITHUB_ACTIONS: "true" });
    assert.equal(r.status, 1, JSON.stringify(value));
    assert.match(r.stderr, /DB_SYNC_ALLOWED_USERS/);
    assert.ok(!r.stdout.includes("::add-mask::"), "nothing is masked from a malformed value");
    assert.ok(!(r.stdout + r.stderr).includes(D.toUpperCase()));
    assert.ok(!(r.stdout + r.stderr).includes("bob"));
  }
});

test("cli check-known: a listed and known user passes with counts only", async () => {
  await withStub({}, async (base) => {
    const r = await cli(["check-known", "--database", "logseq-sync-index"], {
      DB_SYNC_ALLOWED_USERS: A,
      GITHUB_ACTIONS: "true",
      ALLOWED_USERS_API_BASE: base,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /allowed users: 1 listed, 1 known/);
    assertNoIdentifiers(r);
  });
});

test("cli check-known: warnings print as warning: locally and ::warning:: in Actions", async () => {
  const rows = [{ id: A, email: EMAIL, username: null, graphs: 1 }, { id: B, email: null, username: null, graphs: 3 }];
  await withStub({ rows }, async (base) => {
    const env = { DB_SYNC_ALLOWED_USERS: A, ALLOWED_USERS_API_BASE: base };
    const local = await cli(["check-known", "--database", "logseq-sync-index"], env);
    assert.equal(local.status, 0, local.stdout + local.stderr);
    assert.match(local.stderr, /^warning: 1 users who own graphs aren't on the list and will be refused$/m);
    const actions = await cli(["check-known", "--database", "logseq-sync-index"], { ...env, GITHUB_ACTIONS: "true" });
    assert.equal(actions.status, 0);
    assert.match(actions.stdout, /^::warning::1 users who own graphs aren't on the list and will be refused$/m);
    assertNoIdentifiers(local);
    assertNoIdentifiers(actions);
  });
});

test("cli check-known: a list of unknown users exits 1", async () => {
  await withStub({ rows: [{ id: A, email: EMAIL, username: null, graphs: 1 }] }, async (base) => {
    const env = { DB_SYNC_ALLOWED_USERS: B, ALLOWED_USERS_API_BASE: base };
    const local = await cli(["check-known", "--database", "logseq-sync-index"], env);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /^error: none of the 1 listed user IDs is a known user of this server \(1 known\)/m);
    const actions = await cli(["check-known", "--database", "logseq-sync-index"], { ...env, GITHUB_ACTIONS: "true" });
    assert.equal(actions.status, 1);
    assert.match(actions.stdout, /^::error::none of the 1 listed user IDs/m);
    assertNoIdentifiers(local);
    assertNoIdentifiers(actions);
  });
});

test("cli check-known: a D1 API failure exits 1 without echoing the response", async () => {
  await withStub({ status: 500 }, async (base) => {
    const r = await cli(["check-known", "--database", "logseq-sync-index"], {
      DB_SYNC_ALLOWED_USERS: A,
      GITHUB_ACTIONS: "true",
      ALLOWED_USERS_API_BASE: base,
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::D1 API 500: stub failure/);
    assertNoIdentifiers(r);
  });
});

test("cli check-known: a malformed list exits 1 before touching the network", async () => {
  await withStub({}, async (base, requests) => {
    const r = await cli(["check-known", "--database", "logseq-sync-index"], {
      DB_SYNC_ALLOWED_USERS: "bob",
      ALLOWED_USERS_API_BASE: base,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /entry 1 of 1/);
    assert.equal(requests.length, 0);
  });
});

test("cli: a missing --database or unknown command exits 1", async () => {
  const noDb = await cli(["check-known"], { DB_SYNC_ALLOWED_USERS: A });
  assert.equal(noDb.status, 1);
  assert.match(noDb.stderr, /--database/);
  const unknown = await cli(["frobnicate"], {});
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /usage/i);
});

test("cli list: refuses in Actions before touching the network", async () => {
  await withStub({}, async (base, requests) => {
    const r = await cli(["list", "--database", "logseq-sync-index"], {
      DB_SYNC_ALLOWED_USERS: A,
      GITHUB_ACTIONS: "true",
      ALLOWED_USERS_API_BASE: base,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /list prints user IDs and emails, so it never runs in GitHub Actions/);
    assertNoIdentifiers(r);
    assert.equal(requests.length, 0);
  });
});

test("cli list: prints a table with listed yes/no", async () => {
  await withStub({}, async (base) => {
    const r = await cli(["list", "--database", "logseq-sync-index"], { DB_SYNC_ALLOWED_USERS: A, ALLOWED_USERS_API_BASE: base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.deepEqual(lines[0].split(/\s+/), ["id", "email", "username", "graphs", "listed"]);
    assert.deepEqual(lines[1].split(/\s+/), [A, EMAIL, "owner", "1", "yes"]);
    assert.deepEqual(lines[2].split(/\s+/), [B, "-", "-", "0", "no"]);
    // fixed-width: every column starts at the same offset on every row
    for (const col of ["email", "username", "graphs", "listed"]) {
      const at = lines[0].indexOf(col);
      assert.ok(lines[1][at - 1] === " " && lines[1][at] !== " ", `${col} column aligned on row 1`);
      assert.ok(lines[2][at - 1] === " " && lines[2][at] !== " ", `${col} column aligned on row 2`);
    }
  });
});

test("cli list: a missing or malformed list shows every user as no, with one note", async () => {
  await withStub({}, async (base) => {
    for (const value of ["", "bob"]) {
      const r = await cli(["list", "--database", "logseq-sync-index"], { DB_SYNC_ALLOWED_USERS: value, ALLOWED_USERS_API_BASE: base });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const rows = r.stdout.trimEnd().split("\n").filter((l) => l.startsWith(A) || l.startsWith(B));
      assert.equal(rows.length, 2);
      for (const row of rows) assert.match(row, /\sno$/);
      const notes = (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith("note:"));
      assert.equal(notes.length, 1, value);
      assert.match(notes[0], /DB_SYNC_ALLOWED_USERS/);
      assert.ok(!notes[0].includes("bob"));
    }
  });
});

test("cli list: none is valid, so no note, every row is no", async () => {
  await withStub({}, async (base) => {
    const r = await cli(["list", "--database", "logseq-sync-index"], { DB_SYNC_ALLOWED_USERS: "none", ALLOWED_USERS_API_BASE: base });
    assert.equal(r.status, 0);
    assert.ok(!(r.stdout + r.stderr).includes("note:"));
    assert.ok(!r.stdout.includes("yes"));
  });
});

test("cli: ALLOWED_USERS_API_BASE without DEPLOY_SYNC_TEST=1 fails fast, before any network call", async () => {
  await withStub({}, async (base, requests) => {
    for (const command of [["check-format"], ["check-known", "--database", "logseq-sync-index"], ["list", "--database", "logseq-sync-index"]]) {
      const r = await cli(command, { DB_SYNC_ALLOWED_USERS: A, ALLOWED_USERS_API_BASE: base, DEPLOY_SYNC_TEST: "" });
      assert.equal(r.status, 1, command[0]);
      assert.match(r.stderr, /ALLOWED_USERS_API_BASE is test-only and requires DEPLOY_SYNC_TEST=1/);
      assert.ok(!(r.stdout + r.stderr).includes("tok"));
    }
    assert.equal(requests.length, 0);
  });
});

test("cli: runs, and fails closed, when invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "allowed-users-link-"));
  return new Promise((resolveTest, reject) => {
    const link = join(dir, "link.mjs");
    symlinkSync(script, link);
    const child = spawn(process.execPath, [link, "check-format"], { cwd: root, env: { ...process.env, DB_SYNC_ALLOWED_USERS: "bob" } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      rmSync(dir, { recursive: true, force: true });
      try {
        assert.equal(status, 1);
        assert.match(stderr, /DB_SYNC_ALLOWED_USERS entry 1 of 1/);
        resolveTest();
      } catch (e) {
        reject(e);
      }
    });
  });
});
