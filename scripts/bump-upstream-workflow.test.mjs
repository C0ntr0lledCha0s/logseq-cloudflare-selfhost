import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github", "workflows", "bump-upstream.yml"), "utf8");
const branchScript = readFileSync(join(root, "scripts", "bump-branch.sh"), "utf8");

/** The lines of the step named `name`, up to the next step. */
function step(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `step ${name} not found`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - ") && !lines[end].startsWith("      #")) end += 1;
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

test("the branch step hands the branch to bump-branch.sh and the workflow never force-pushes itself", () => {
  assert.match(runBlock("Update the bump branch"), /^scripts\/bump-branch\.sh "\$branch" "\$NEW_SHA" "\$BASE_BRANCH" "\$RUNNER_TEMP\/bump-note\.md"$/m);
  assert.ok(step("Update the bump branch").includes("        id: bump"));
  assert.doesNotMatch(workflow, /--force|push -f\b|\+refs\/heads|git push/);
});

test("the branch step keeps picking the first open bump/upstream-* PR", () => {
  assert.match(runBlock("Update the bump branch"), /select\(\.headRefName \| startswith\("bump\/upstream-"\)\)\]\[0\]/);
});

test("bump-branch.sh force-pushes only on the path where every commit is the bot's", () => {
  const lines = branchScript.split("\n");
  const force = lines.flatMap((line, i) => (/--force|push -f\b/.test(line) ? [i] : []));
  assert.equal(force.length, 1, "one force push");
  const guard = lines.findLastIndex((line, i) => i < force[0] && /^if /.test(line));
  assert.equal(lines[guard], 'if [ -z "$hand_made" ]; then');
  assert.ok(lines.slice(guard, force[0]).every((line) => line === "" || line.startsWith("  ") || line.startsWith("if ")));
});

test("the pr job checks out full history, so the script can compare and merge", () => {
  const job = workflow.slice(workflow.indexOf("\n  pr:\n"));
  assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n\s+# .*\n\s+fetch-depth: 0\n/);
});

test("CI is not dispatched on a branch the run skipped", () => {
  const ci = step("Run CI on the bump branch");
  assert.ok(ci.includes("        if: steps.bump.outputs.mode != 'skip'"));
  assert.ok(ci.includes('        run: gh workflow run ci.yml --ref "$BRANCH"'));
});

/** Runs the "Create or update the bump PR" step with a stub gh that logs its arguments. */
function runPrStep({ number, mode, note }) {
  const dir = mkdtempSync(join(tmpdir(), "bump-workflow-"));
  try {
    mkdirSync(join(dir, "bin"));
    const log = join(dir, "gh.log");
    writeFileSync(log, "");
    writeFileSync(join(dir, "bin", "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    writeFileSync(join(dir, "pr-body.md"), "body\n");
    writeFileSync(join(dir, "bump-note.md"), note);
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const r = spawnSync("bash", ["-e", "-c", runBlock("Create or update the bump PR")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
        NEW_SHA: "b".repeat(40),
        BASE_BRANCH: "main",
        NUMBER: number,
        BRANCH: "bump/upstream-aaaaaaaaaa",
        MODE: mode,
      },
    });
    return { status: r.status, stderr: r.stderr, gh: readFileSync(log, "utf8"), summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a rebuilt branch updates the PR title and body and posts no comment", () => {
  const r = runPrStep({ number: "81", mode: "force", note: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.gh, /^pr edit 81 --title chore: bump upstream to bbbbbbbbbb --body-file .*pr-body\.md$/m);
  assert.doesNotMatch(r.gh, /pr comment/);
  assert.equal(r.summary, "");
});

test("a kept branch updates the PR, and the note goes to a PR comment and the step summary", () => {
  const r = runPrStep({ number: "81", mode: "merge", note: "kept the patch refresh\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.gh, /^pr edit 81 /m);
  assert.match(r.gh, /^pr comment 81 --body-file .*bump-note\.md$/m);
  assert.equal(r.summary, "kept the patch refresh\n");
});

test("a skipped branch keeps its PR title and body, and says why in a comment and the summary", () => {
  const r = runPrStep({ number: "81", mode: "skip", note: "not updated\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.gh, /pr edit/);
  assert.match(r.gh, /^pr comment 81 --body-file .*bump-note\.md$/m);
  assert.equal(r.summary, "not updated\n");
});

test("with no open PR, it opens one on the branch and comments there when there is a note", () => {
  const r = runPrStep({ number: "", mode: "merge", note: "kept\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.gh, /^pr create --base main --head bump\/upstream-aaaaaaaaaa --title chore: bump upstream to bbbbbbbbbb /m);
  assert.match(r.gh, /^pr comment bump\/upstream-aaaaaaaaaa --body-file /m);
});
