import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");

/** The lines of the deploy job's step named `name`, up to the next step. */
function step(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step ${name} not found`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - ")) end += 1;
  return lines.slice(start, end);
}

/** The step's `run: |` block, dedented. */
function runBlock(name) {
  const lines = step(name);
  const at = lines.indexOf("        run: |");
  assert.notEqual(at, -1, `step ${name} has no run block`);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** Runs the "Read connector setting" step against `settings` as GitHub would (bash -e). */
function readSetting(settings) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  try {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "settings.json"), JSON.stringify(settings));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    const r = spawnSync("bash", ["-e", "-c", runBlock("Read connector setting")], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return { status: r.status, stderr: r.stderr, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the connector steps run only when the setting step says enabled", () => {
  assert.ok(step("Read connector setting").includes("        id: connector"));
  for (const name of ["Prepare connector", "Deploy connector"]) {
    assert.ok(step(name).includes("        if: steps.connector.outputs.enabled == 'true'"), name);
  }
});

test("the setting step outputs enabled=true or enabled=false from settings.json", () => {
  for (const enabled of [true, false]) {
    const r = readSetting({ connector: { enabled } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, `enabled=${enabled}\n`);
  }
});

test("the setting step reads no secrets", () => {
  assert.ok(!step("Read connector setting").some((line) => line.includes("secrets.")));
});

test("the setting step fails on a missing or non-boolean enabled", () => {
  for (const settings of [{ connector: { enabled: "true" } }, { connector: {} }, {}]) {
    const r = readSetting(settings);
    assert.notEqual(r.status, 0, JSON.stringify(settings));
    assert.equal(r.output, "", JSON.stringify(settings));
  }
});
