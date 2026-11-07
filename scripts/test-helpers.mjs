// Shared stubs for the scripts' tests: a `gh` on PATH, a local Cloudflare API, and a script runner.
// Not a *.test.mjs file, so `npm test` doesn't run it.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * Writes a Node `gh` stub into `dir/bin` (put `bin` on PATH). Each call is logged as a JSON line.
 * `rules` are `{ match: string[], stdout?: string, stderr?: string, exit?: number }`: the first rule whose `match`
 * is a prefix of argv applies. A call no rule matches exits 1 with `unstubbed gh call: <argv>`.
 */
export function stubGh(dir, rules) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("fs");
const stdin = fs.readFileSync(0, "utf8");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin }) + "\\n");
const rules = ${JSON.stringify(rules)};
const rule = rules.find((r) => r.match.every((word, i) => argv[i] === word));
if (!rule) {
  process.stderr.write("unstubbed gh call: " + argv.join(" ") + "\\n");
  process.exit(1);
}
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.exit ?? 0);
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
  return { bin, log, calls };
}

/**
 * Starts a Cloudflare API stub on 127.0.0.1. `routes` maps "METHOD /path" (no query string) to
 * `(req) => [status, json]`, where `req` is `{ method, path, query, body }`. A route that isn't
 * listed answers 404 with error code 7003. Every request is recorded in `requests`.
 */
export async function cfStub(routes) {
  const requests = [];
  const server = createServer((incoming, res) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = new URL(incoming.url, "http://127.0.0.1");
      const text = Buffer.concat(chunks).toString("utf8");
      const req = {
        method: incoming.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: text === "" ? undefined : JSON.parse(text),
      };
      requests.push(req);
      const route = routes[`${req.method} ${req.path}`];
      const [status, json] = route
        ? route(req)
        : [404, { success: false, errors: [{ code: 7003, message: "no route" }], result: null }];
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

/** Spawns `file` with `args`, writing `input` to stdin. GITHUB_ACTIONS is blanked unless `env` sets it. */
export function runScript(file, args, { env, input, cwd } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, GITHUB_ACTIONS: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
