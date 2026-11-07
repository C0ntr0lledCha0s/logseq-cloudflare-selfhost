import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfStub, runScript, stubGh } from "./test-helpers.mjs";

test("stubGh: the first matching prefix rule answers, and every call is logged with its stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-helpers-"));
  try {
    const gh = stubGh(dir, [
      { match: ["secret", "set", "A"], exit: 3 },
      { match: ["secret"], stdout: "any secret\n" },
      { match: ["repo", "view"], stdout: "owner/repo\n" },
    ]);
    const env = { PATH: `${gh.bin}:${process.env.PATH}` };
    const view = await runScript("gh", ["repo", "view", "--json", "x"], { env });
    assert.deepEqual([view.status, view.stdout], [0, "owner/repo\n"]);
    assert.equal((await runScript("gh", ["secret", "set", "A"], { env, input: "value" })).status, 3);
    assert.equal((await runScript("gh", ["secret", "set", "B"], { env })).stdout, "any secret\n");
    assert.deepEqual(gh.calls(), [
      { argv: ["repo", "view", "--json", "x"], stdin: "" },
      { argv: ["secret", "set", "A"], stdin: "value" },
      { argv: ["secret", "set", "B"], stdin: "" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stubGh: a rule's stderr is written with its exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-helpers-"));
  try {
    const gh = stubGh(dir, [{ match: ["api"], stderr: "gh: Not Found (HTTP 404)\n", exit: 1 }]);
    const r = await runScript("gh", ["api", "x"], { env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", "gh: Not Found (HTTP 404)\n"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stubGh: an unmatched call exits 1 and names the call on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-helpers-"));
  try {
    const gh = stubGh(dir, [{ match: ["repo"] }]);
    const r = await runScript("gh", ["pr", "list"], { env: { PATH: `${gh.bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "unstubbed gh call: pr list\n");
    assert.equal(gh.calls().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cfStub: routes by method and path, records requests, and answers 404 code 7003 to the rest", async () => {
  const stub = await cfStub({ "POST /a": (req) => [201, { echoed: req.body, query: req.query }] });
  try {
    const hit = await fetch(`${stub.base}/a?x=1`, { method: "POST", body: JSON.stringify({ n: 1 }) });
    assert.equal(hit.status, 201);
    assert.deepEqual(await hit.json(), { echoed: { n: 1 }, query: { x: "1" } });
    const miss = await fetch(`${stub.base}/a`);
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { success: false, errors: [{ code: 7003, message: "no route" }], result: null });
    assert.deepEqual(stub.requests.map((r) => `${r.method} ${r.path}`), ["POST /a", "GET /a"]);
  } finally {
    await stub.close();
  }
});

test("runScript: blanks GITHUB_ACTIONS unless the caller sets it", async () => {
  const code = "process.stdout.write(JSON.stringify(process.env.GITHUB_ACTIONS))";
  assert.equal((await runScript(process.execPath, ["-e", code], { env: {} })).stdout, '""');
  assert.equal((await runScript(process.execPath, ["-e", code], { env: { GITHUB_ACTIONS: "true" } })).stdout, '"true"');
});
