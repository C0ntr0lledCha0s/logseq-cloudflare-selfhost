import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, ".github", "workflows", name), "utf8");
const sync = read("sync-upstream.yml");
const bump = read("bump-upstream.yml");
const ci = read("ci.yml");

/** The lines of the job `name`, up to the next job (two-space-indented key). */
function jobLines(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `job ${name} not found`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

/** The names of the jobs under the top-level `jobs:` key. */
function jobNames(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.notEqual(start, -1, "no jobs: key");
  return lines
    .slice(start + 1)
    .map((l) => /^ {2}([\w-]+):\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** The child lines of `key:` inside `lines`, where `key` is indented by `indent` spaces. */
function children(lines, key, indent) {
  const at = lines.indexOf(`${" ".repeat(indent)}${key}:`);
  assert.notEqual(at, -1, `${key} not found`);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ".repeat(indent + 2))) break;
    out.push(line.trim());
  }
  return out;
}

test("sync-upstream is named for the lookups in doctor and setup", () => {
  assert.match(sync, /^name: sync-upstream$/m);
});

test("triggers are a weekly schedule and a manual dispatch", () => {
  const lines = sync.split("\n");
  assert.deepEqual(children(lines, "on", 0), ["schedule:", '- cron: "0 4 * * 1"', "workflow_dispatch:"]);
});

test("workflow permissions are read-only and runs are serialised", () => {
  assert.deepEqual(children(sync.split("\n"), "permissions", 0), ["contents: read"]);
  assert.match(sync, /^concurrency:\n {2}group: sync-upstream$/m);
});

test("resolve runs on forks only", () => {
  const job = jobLines(sync, "resolve");
  assert.ok(job.includes("    if: ${{ github.event.repository.fork }}"));
});

test("resolve reads the parent from the API, never hard-coded", () => {
  const job = jobLines(sync, "resolve").join("\n");
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job, /\.parent\.full_name/);
  assert.match(job, /compare\/main\.\.\.\$\{parent_owner\}:main/);
  assert.doesNotMatch(sync, /logseq-cloudflare-selfhost/);
});

test("check runs the reusable ci workflow on the parent's commit", () => {
  const job = jobLines(sync, "check");
  assert.ok(job.includes("    uses: ./.github/workflows/ci.yml"));
  assert.ok(job.includes("    needs: resolve"));
  assert.ok(job.includes("    if: needs.resolve.outputs.behind == 'true'"));
  assert.deepEqual(children(job, "permissions", 4), ["contents: read"]);
  const inputs = children(job, "with", 4);
  assert.ok(inputs.includes("repository: ${{ needs.resolve.outputs.parent }}"));
  assert.ok(inputs.includes("ref: ${{ needs.resolve.outputs.sha }}"));
});

test("pr has exactly the permissions it uses", () => {
  const job = jobLines(sync, "pr");
  assert.deepEqual(children(job, "permissions", 4), [
    "contents: read",
    "pull-requests: write",
    "statuses: write",
  ]);
  assert.ok(job.includes("    needs: [resolve, check]"));
  assert.ok(job.includes("    if: always() && needs.resolve.outputs.behind == 'true'"));
});

test("pr reports a check status that is success only when ci passed", () => {
  const job = jobLines(sync, "pr").join("\n");
  assert.match(job, /statuses\/\$SHA/);
  assert.match(job, /context=check/);
  assert.match(job, /\[ "\$CI_RESULT" = success \]/);
});

test("expressions in run scripts are only the repository's own name", () => {
  // Parent names and commit text arrive through env: and are quoted in shell.
  const lines = sync.split("\n");
  const runLines = [];
  let inRun = false;
  for (const line of lines) {
    if (/^\s+run: \|$/.test(line)) inRun = true;
    else if (/^\s+(- )?\w[\w-]*:/.test(line) && !/^\s{10,}/.test(line)) inRun = false;
    if (inRun) runLines.push(line);
  }
  assert.ok(runLines.length > 0);
  for (const line of runLines) {
    for (const m of line.matchAll(/\$\{\{ ([^}]*) \}\}/g)) {
      assert.equal(m[1], "github.repository", `unsafe interpolation: ${line.trim()}`);
    }
  }
});

test("every action is pinned by full SHA", () => {
  const uses = sync.split("\n").filter((l) => /^\s*(- )?uses: /.test(l));
  for (const line of uses) {
    if (line.includes("uses: ./")) continue;
    assert.match(line, /@[0-9a-f]{40}\b/, `unpinned: ${line.trim()}`);
  }
});

test("the workflow uses no secrets", () => {
  assert.doesNotMatch(sync, /\$\{\{ secrets\./);
});

test("every bump-upstream job is skipped on a fork", () => {
  const names = jobNames(bump);
  assert.deepEqual(names, ["resolve", "check", "pr"]);
  for (const name of names) {
    const ifLine = jobLines(bump, name).find((l) => /^ {4}if:/.test(l));
    assert.ok(ifLine, `job ${name} has no if`);
    assert.ok(ifLine.includes("!github.event.repository.fork"), `job ${name}: ${ifLine}`);
  }
  assert.ok(jobLines(bump, "pr").some((l) => /^ {4}if: always\(\) && /.test(l)));
});

test("ci accepts a repository and ref from a caller", () => {
  const lines = ci.split("\n");
  const inputs = children(lines, "inputs", 4);
  assert.ok(inputs.includes("repository:"));
  assert.ok(inputs.includes("ref:"));
  const checkout = lines.filter((l) => /^ {10}(repository|ref): /.test(l));
  assert.deepEqual(checkout, [
    "          repository: ${{ inputs.repository || github.repository }}",
    "          ref: ${{ inputs.ref }}",
  ]);
});
