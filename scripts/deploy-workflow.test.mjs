import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Runs the "Read connector setting" step with the CONNECTOR_ENABLED variable set to `value`, as GitHub would (bash -e). */
function readSetting(value) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  try {
    const output = join(dir, "github-output");
    const env = join(dir, "github-env");
    writeFileSync(output, "");
    writeFileSync(env, "");
    const r = spawnSync("bash", ["-e", "-c", runBlock("Read connector setting")], {
      cwd: dir,
      env: { ...process.env, CONNECTOR_ENABLED: value, GITHUB_OUTPUT: output, GITHUB_ENV: env },
      encoding: "utf8",
    });
    return {
      status: r.status,
      stdout: r.stdout,
      output: readFileSync(output, "utf8"),
      env: readFileSync(env, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The index of the step named `name` among the deploy job's steps. */
function stepIndex(name) {
  const at = workflow.split("\n").filter((line) => line.startsWith("      - ")).indexOf(`      - name: ${name}`);
  assert.notEqual(at, -1, `step ${name} not found`);
  return at;
}

test("the connector steps run only when the setting step says enabled", () => {
  assert.ok(step("Read connector setting").includes("        id: connector"));
  for (const name of ["Prepare connector", "Deploy connector"]) {
    assert.ok(step(name).includes("        if: steps.connector.outputs.enabled == 'true'"), name);
  }
});

test("the setting step reads the CONNECTOR_ENABLED variable and runs before OpenTofu", () => {
  assert.ok(step("Read connector setting").includes("          CONNECTOR_ENABLED: ${{ vars.CONNECTOR_ENABLED }}"));
  for (const later of ["Tofu init", "Tofu apply", "Deploy connector"]) {
    assert.ok(stepIndex("Read connector setting") < stepIndex(later), later);
  }
});

test("the setting step passes true or false to the later steps, with unset meaning false", () => {
  for (const [value, enabled] of [["true", "true"], ["false", "false"], ["", "false"]]) {
    const r = readSetting(value);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.output, `enabled=${enabled}\n`, JSON.stringify(value));
    assert.equal(r.env, `CONNECTOR_ENABLED=${enabled}\nTF_VAR_connector_enabled=${enabled}\n`, JSON.stringify(value));
  }
});

test("the setting step reads no secrets", () => {
  assert.ok(!step("Read connector setting").some((line) => line.includes("secrets.")));
});

test("the setting step fails on a value other than true or false", () => {
  for (const value of ["yes", "TRUE", "1", "true "]) {
    const r = readSetting(value);
    assert.notEqual(r.status, 0, JSON.stringify(value));
    assert.match(r.stdout, /::error::The CONNECTOR_ENABLED variable must be true or false/);
    assert.equal(r.output, "", JSON.stringify(value));
    assert.equal(r.env, "", JSON.stringify(value));
  }
});

/**
 * Runs the "Mask the D1 and connector ids" step as GitHub would (bash -e), with a stub wrapper that
 * prints its own ::add-mask:: lines to stdout like the real one does in Actions, and a stub tofu that
 * prints `outputs` as `tofu output -json` would.
 */
function runMaskStep(outputs) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "bin"));
    const wrapper = join(dir, "scripts", "with-r2-credentials.sh");
    writeFileSync(wrapper, '#!/usr/bin/env bash\necho "::add-mask::r2-secret"\nexec "$@"\n');
    chmodSync(wrapper, 0o755);
    const tofu = join(dir, "bin", "tofu");
    writeFileSync(tofu, `#!/usr/bin/env bash\nprintf '%s' '${JSON.stringify(outputs)}'\n`);
    chmodSync(tofu, 0o755);
    const r = spawnSync("bash", ["-e", "-c", runBlock("Mask the D1 and connector ids")], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, RUNNER_TEMP: dir },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the mask step masks every id and keeps the wrapper's own mask lines out of the JSON", () => {
  const r = runMaskStep({
    d1_database_id: { value: "d1-id" },
    connector_oauth_kv_id: { value: "kv-id" },
    connector_kb_index_kv_id: { value: "kb-index-kv-id" },
    connector_d1_id: { value: "connector-d1-id" },
  });
  assert.equal(r.status, 0, r.stderr);
  for (const value of ["r2-secret", "d1-id", "kv-id", "kb-index-kv-id", "connector-d1-id"]) {
    assert.ok(r.stdout.split("\n").includes(`::add-mask::${value}`), value);
  }
});

test("the mask step passes on a first-ever run with no outputs", () => {
  const r = runMaskStep({});
  assert.equal(r.status, 0, r.stderr);
});

/** Runs the "Read semantic search setting" step with the variable and CONNECTOR_ENABLED (from the earlier step's GITHUB_ENV). */
function readSemanticSetting(value, connectorEnabled) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-workflow-"));
  try {
    const env = join(dir, "github-env");
    writeFileSync(env, "");
    const r = spawnSync("bash", ["-e", "-c", runBlock("Read semantic search setting")], {
      cwd: dir,
      env: { ...process.env, SEMANTIC_SEARCH_ENABLED: value, CONNECTOR_ENABLED: connectorEnabled, GITHUB_ENV: env },
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, env: readFileSync(env, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the semantic search step reads its variable after the connector setting and before OpenTofu", () => {
  assert.ok(step("Read semantic search setting").includes("          SEMANTIC_SEARCH_ENABLED: ${{ vars.SEMANTIC_SEARCH_ENABLED }}"));
  assert.ok(stepIndex("Read connector setting") < stepIndex("Read semantic search setting"));
  assert.ok(stepIndex("Read semantic search setting") < stepIndex("Tofu init"));
  assert.ok(!step("Read semantic search setting").some((line) => line.includes("secrets.")));
});

test("the semantic search step passes true or false on, with unset meaning false", () => {
  for (const [value, connector, enabled] of [["true", "true", "true"], ["false", "true", "false"], ["", "true", "false"], ["", "false", "false"], ["false", "false", "false"]]) {
    const r = readSemanticSetting(value, connector);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.env, `SEMANTIC_SEARCH_ENABLED=${enabled}\n`, JSON.stringify([value, connector]));
  }
});

test("the semantic search step fails on another value or without the connector", () => {
  for (const value of ["yes", "TRUE", "1"]) {
    const r = readSemanticSetting(value, "true");
    assert.notEqual(r.status, 0, value);
    assert.match(r.stdout, /::error::The SEMANTIC_SEARCH_ENABLED variable must be true or false/);
    assert.equal(r.env, "");
  }
  const r = readSemanticSetting("true", "false");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /::error::SEMANTIC_SEARCH_ENABLED=true needs CONNECTOR_ENABLED=true/);
  assert.equal(r.env, "");
});

test("the Deploy step passes DB_SYNC_ALLOWED_USERS and no other step does", () => {
  assert.ok(step("Deploy").includes("          DB_SYNC_ALLOWED_USERS: ${{ secrets.DB_SYNC_ALLOWED_USERS }}"));
  const others = workflow
    .split("\n")
    .filter((line) => line.includes("DB_SYNC_ALLOWED_USERS"));
  assert.equal(others.length, 1, others.join("\n"));
});

test("the account prerequisites step runs before Tofu init, with the API token and account only", () => {
  const name = "Ensure account prerequisites";
  assert.ok(stepIndex(name) < stepIndex("Tofu init"));
  const lines = step(name);
  assert.ok(lines.includes("        run: node scripts/ensure-account.mjs"));
  const at = lines.indexOf("        env:");
  assert.notEqual(at, -1);
  const env = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("          ")) break;
    env.push(line.trim());
  }
  assert.deepEqual(env, [
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  ]);
});
