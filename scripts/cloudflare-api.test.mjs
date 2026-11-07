import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBaseFromEnv, cf, CfError, DEFAULT_API_BASE, readEnvelope } from "./cloudflare-api.mjs";
import { cfStub } from "./test-helpers.mjs";

test("apiBaseFromEnv: the default with nothing set", () => {
  assert.equal(apiBaseFromEnv({}), DEFAULT_API_BASE);
  assert.equal(apiBaseFromEnv({ CF_API_TEST: "1" }), DEFAULT_API_BASE);
});

test("apiBaseFromEnv: CF_API_BASE without CF_API_TEST=1 is an error, not a fallback", () => {
  assert.throws(() => apiBaseFromEnv({ CF_API_BASE: "http://127.0.0.1:1234" }), {
    message: "CF_API_BASE is test-only and requires CF_API_TEST=1",
  });
  assert.throws(() => apiBaseFromEnv({ CF_API_BASE: "https://stub.example.com", CF_API_TEST: "0" }), /requires CF_API_TEST=1/);
});

test("apiBaseFromEnv: only https or a local stub is accepted, even with the switch", () => {
  for (const base of ["http://example.com", "http://127.0.0.1", "http://localhost:1234", "ftp://127.0.0.1:1", "http://127.0.0.1:1234/x"]) {
    assert.throws(() => apiBaseFromEnv({ CF_API_BASE: base, CF_API_TEST: "1" }), {
      message: "CF_API_BASE must be https:// or http://127.0.0.1:<port>",
    }, base);
  }
});

test("apiBaseFromEnv: accepts a local stub or https with the switch", () => {
  assert.equal(apiBaseFromEnv({ CF_API_BASE: "http://127.0.0.1:1234", CF_API_TEST: "1" }), "http://127.0.0.1:1234");
  assert.equal(apiBaseFromEnv({ CF_API_BASE: "https://stub.example.com/client/v4", CF_API_TEST: "1" }), "https://stub.example.com/client/v4");
});

test("cf: sends the bearer token, the query and a JSON body, and returns the whole envelope", async () => {
  const headers = [];
  const stub = await cfStub({
    "POST /things": (req) => [200, { success: true, errors: [], result: req.body, result_info: { page: 1 } }],
  });
  try {
    const seen = async (url, init) => {
      headers.push(init.headers);
      return fetch(url, init);
    };
    const out = await cf({ apiBase: stub.base, apiToken: "tok", method: "POST", path: "/things", query: { a: "1", skipped: undefined }, body: { n: 2 }, fetchImpl: seen });
    assert.deepEqual(out, { success: true, errors: [], result: { n: 2 }, result_info: { page: 1 } });
    assert.equal(headers[0].Authorization, "Bearer tok");
    assert.deepEqual(stub.requests, [{ method: "POST", path: "/things", query: { a: "1" }, body: { n: 2 } }]);
  } finally {
    await stub.close();
  }
});

test("cf: an error envelope throws a CfError with the status and codes, and the message has no token", async () => {
  const stub = await cfStub({
    "GET /boom": () => [403, { success: false, errors: [{ code: 10042, message: "x" }, { code: 1, message: "y" }], result: null }],
  });
  try {
    await assert.rejects(
      cf({ apiBase: stub.base, apiToken: "tok", path: "/boom" }),
      (e) => {
        assert.ok(e instanceof CfError);
        assert.equal(e.status, 403);
        assert.deepEqual(e.codes, [10042, 1]);
        assert.equal(e.message, "Cloudflare API 403: x; y");
        assert.ok(!e.message.includes("tok"));
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("cf: needs an apiBase", async () => {
  await assert.rejects(cf({ apiToken: "tok", path: "/x" }), /apiBase is required/);
});

test("readEnvelope: the label leads the message, a non-JSON body is a CfError, and success:false on a 200 fails", async () => {
  await assert.rejects(readEnvelope(new Response("<html>", { status: 502 }), "D1 API"), (e) => {
    assert.ok(e instanceof CfError);
    assert.equal(e.message, "D1 API 502: response is not JSON");
    assert.equal(e.status, 502);
    assert.deepEqual(e.codes, []);
    return true;
  });
  await assert.rejects(
    readEnvelope(Response.json({ success: false, errors: [], result: null })),
    { message: "Cloudflare API 200: no error message" },
  );
});
