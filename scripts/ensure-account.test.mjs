import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAccount, STATE_BUCKET } from "./ensure-account.mjs";
import { cfStub, runScript } from "./test-helpers.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "ensure-account.mjs");

const ok = (result) => [200, { success: true, errors: [], result }];
const fail = (status, code, message) => [status, { success: false, errors: [{ code, message }], result: null }];
const buckets = (...names) => () => ok({ buckets: names.map((name) => ({ name })) });

/** Routes for an account with nothing set up. Override entries to change one answer. */
const routes = (overrides = {}) => ({
  "GET /accounts/acct/r2/buckets": buckets(),
  "POST /accounts/acct/r2/buckets": (req) => ok({ name: req.body.name }),
  "GET /accounts/acct/workers/subdomain": () => fail(404, 10007, "no subdomain"),
  "PUT /accounts/acct/workers/subdomain": (req) => ok({ subdomain: req.body.subdomain }),
  ...overrides,
});

async function withStub(table, fn) {
  const stub = await cfStub(table);
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

const ensure = (stub) => ensureAccount({ accountId: "acct", apiToken: "tok", apiBase: stub.base });
const writes = (stub) => stub.requests.filter((r) => r.method !== "GET");

test("ensureAccount: creates the bucket and the subdomain when both are missing", () =>
  withStub(routes(), async (stub) => {
    assert.deepEqual(await ensure(stub), { bucket: "created", subdomain: "created" });
    const [post, put, ...rest] = writes(stub);
    assert.equal(rest.length, 0);
    assert.equal(post.method, "POST");
    assert.deepEqual(post.body, { name: STATE_BUCKET });
    assert.equal(put.method, "PUT");
    assert.match(put.body.subdomain, /^logseq-[0-9a-f]{8}$/);
    assert.deepEqual(stub.requests[0].query, { name_contains: STATE_BUCKET });
  }));

test("ensureAccount: leaves a bucket and a subdomain that already exist alone", () =>
  withStub(
    routes({
      "GET /accounts/acct/r2/buckets": buckets(STATE_BUCKET),
      "GET /accounts/acct/workers/subdomain": () => ok({ subdomain: "existing" }),
    }),
    async (stub) => {
      assert.deepEqual(await ensure(stub), { bucket: "present", subdomain: "present" });
      assert.deepEqual(writes(stub), []);
    },
  ));

test("ensureAccount: a bucket whose name only contains the state bucket's is not a match", () =>
  withStub(routes({ "GET /accounts/acct/r2/buckets": buckets(`${STATE_BUCKET}-old`) }), async (stub) => {
    assert.equal((await ensure(stub)).bucket, "created");
    assert.deepEqual(writes(stub)[0].body, { name: STATE_BUCKET });
  }));

test("ensureAccount: an empty or missing subdomain counts as none yet", async () => {
  for (const result of [{ subdomain: "" }, {}, null]) {
    await withStub(routes({ "GET /accounts/acct/workers/subdomain": () => ok(result) }), async (stub) => {
      assert.equal((await ensure(stub)).subdomain, "created", JSON.stringify(result));
    });
  }
});

test("ensureAccount: uses the injected random source for the subdomain", () =>
  withStub(routes(), async (stub) => {
    await ensureAccount({ accountId: "acct", apiToken: "tok", apiBase: stub.base, randomHex: (n) => "ab".repeat(n / 2) });
    assert.equal(writes(stub)[1].body.subdomain, "logseq-abababab");
  }));

const R2_OFF =
  "R2 isn't enabled on this account. Enable it at dash.cloudflare.com → R2 (a payment method is required), then re-run.";

test("ensureAccount: R2 not enabled on the list call rejects with advice and changes nothing", () =>
  withStub(routes({ "GET /accounts/acct/r2/buckets": () => fail(403, 10042, "Please enable R2") }), async (stub) => {
    await assert.rejects(ensure(stub), { message: R2_OFF });
    assert.deepEqual(writes(stub), []);
  }));

test("ensureAccount: R2 not enabled on the create call rejects with the same advice and makes no PUT", () =>
  withStub(routes({ "POST /accounts/acct/r2/buckets": () => fail(403, 10042, "Please enable R2") }), async (stub) => {
    await assert.rejects(ensure(stub), { message: R2_OFF });
    assert.deepEqual(writes(stub).map((r) => r.method), ["POST"]);
  }));

test("ensureAccount: any other API error is thrown as it is", async () => {
  await withStub(routes({ "GET /accounts/acct/r2/buckets": () => fail(403, 10000, "Authentication error") }), async (stub) => {
    await assert.rejects(ensure(stub), { message: "Cloudflare API 403: Authentication error" });
  });
  await withStub(routes({ "GET /accounts/acct/workers/subdomain": () => fail(500, 1000, "server error") }), async (stub) => {
    await assert.rejects(ensure(stub), { message: "Cloudflare API 500: server error" });
    // The bucket was created before the subdomain call failed; the subdomain is not guessed at.
    assert.deepEqual(writes(stub).map((r) => r.method), ["POST"]);
  });
});

const cli = (stub, env = {}) =>
  runScript(process.execPath, [script], {
    cwd: root,
    env: { CF_API_TEST: "1", CF_API_BASE: stub.base, CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", ...env },
  });

test("cli: prints one line per prerequisite, exits 0 and echoes neither the account nor the token", () =>
  withStub(routes(), async (stub) => {
    const r = await cli(stub);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^state bucket: (created|present)$/m);
    assert.match(r.stdout, /^workers.dev subdomain: (created|present)$/m);
    for (const text of [r.stdout, r.stderr]) {
      assert.ok(!text.includes("acct"));
      assert.ok(!text.includes("tok"));
    }
  }));

test("cli: an API error exits 1 with the message, and Actions gets an ::error:: line", () =>
  withStub(routes({ "GET /accounts/acct/r2/buckets": () => fail(403, 10042, "Please enable R2") }), async (stub) => {
    const local = await cli(stub);
    assert.equal(local.status, 1);
    assert.equal(local.stderr, `error: ${R2_OFF}\n`);
    const actions = await cli(stub, { GITHUB_ACTIONS: "true" });
    assert.equal(actions.status, 1);
    assert.equal(actions.stdout, `::error::${R2_OFF}\n`);
  }));

test("cli: refuses a base override without the test switch, and a missing token", () =>
  withStub(routes(), async (stub) => {
    const open = await cli(stub, { CF_API_TEST: "" });
    assert.equal(open.status, 1);
    assert.match(open.stderr, /CF_API_BASE is test-only and requires CF_API_TEST=1/);
    const noToken = await cli(stub, { CLOUDFLARE_API_TOKEN: "" });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /CLOUDFLARE_API_TOKEN is not set/);
    assert.deepEqual(stub.requests, []);
  }));
