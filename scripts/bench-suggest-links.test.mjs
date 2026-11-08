import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "bench-suggest-links.mjs");

// The bench bundles the connector's matcher with the esbuild in connector/node_modules, and the
// matcher's imports reach connector/vendor. Without them it cannot run, so the test says so.
const missing = ["connector/node_modules", "connector/vendor"].filter((p) => !existsSync(join(root, p)));
const skip = missing.length ? `${missing.join(" and ")} missing: run npm --prefix connector ci and scripts/vendor-upstream-api.sh` : false;

/** A word split independent of the matcher: fixture titles and drafts are ASCII. */
const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

test("the fixture is seeded: the same size gives the same titles and draft", { skip }, async () => {
  const { makeTitles, makeDraft } = await import(script);
  const a = makeTitles(500);
  assert.deepEqual(makeTitles(500), a);
  assert.equal(makeDraft(a, 4_000), makeDraft(a, 4_000));
  assert.equal(a.length, 500);
  for (const [uuid, title, aliases] of a) {
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(typeof title, "string");
    assert.ok(Array.isArray(aliases));
  }
  assert.ok(a.some(([, , aliases]) => aliases.length > 0), "some pages have aliases");
  assert.equal(makeDraft(a, 4_000).length, 4_000);
});

test("--json reports parse and match times on a 500-page fixture, and the tokenised bound holds", { skip }, async () => {
  const run = spawnSync(process.execPath, [script, "--pages", "500", "--runs", "3", "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);

  assert.equal(out.pages, 500);
  assert.equal(out.runs, 3);
  assert.equal(out.draftChars, 10_000);
  assert.equal(out.budgetMs, 10);
  assert.ok(out.titlesBytes > 0);
  for (const k of ["parseMs", "matchMs", "totalMs"]) {
    assert.equal(typeof out[k], "number", k);
    assert.ok(out[k] >= 0, k);
  }
  assert.equal(out.overBudget, out.totalMs > out.budgetMs);
  assert.ok(out.suggestions > 0, "the draft names fixture pages, so the matcher finds some");

  // Spec 3.3 c: only titles and aliases whose first word is in the draft are tokenised. The
  // bound is worked out here, apart from the bench, from the same seeded fixture.
  const { makeTitles, makeDraft } = await import(script);
  const titles = makeTitles(500);
  const draftWords = new Set(words(makeDraft(titles, 10_000)));
  const names = titles.flatMap(([, title, aliases]) => [title, ...aliases]);
  const bound = names.filter((n) => draftWords.has(words(n)[0])).length;
  assert.equal(out.firstWordBound, bound);
  assert.ok(out.tokenised > 0);
  assert.ok(out.tokenised <= bound, `tokenised ${out.tokenised} > bound ${bound}`);
  assert.ok(bound < names.length, "the fixture has titles the draft never starts, so the bound is a real cut");

  // r1-light-1: a name of two or more words is tokenised only when its first two words are also
  // next to each other in the draft (outside [[links]] and `code`, or inside a link's text). The
  // pair bound is worked out here from plain word pairs, which can only over-count.
  const draftList = words(makeDraft(titles, 10_000));
  const pairs = new Set(draftList.slice(1).map((w, i) => `${draftList[i]} ${w}`));
  const pairBound = names.filter((n) => {
    const w = words(n);
    return draftWords.has(w[0]) && (w.length === 1 || pairs.has(`${w[0]} ${w[1]}`));
  }).length;
  assert.ok(out.tokenised <= pairBound, `tokenised ${out.tokenised} > pair bound ${pairBound}`);
  assert.ok(pairBound < bound, `the pair bound ${pairBound} is a real cut of the first-word bound ${bound}`);
});

test("text output names the budget and both medians", { skip }, () => {
  const run = spawnSync(process.execPath, [script, "--pages", "500", "--runs", "2"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /500 pages/);
  assert.match(run.stdout, /JSON\.parse .* ms/);
  assert.match(run.stdout, /matchLinks .* ms/);
  assert.match(run.stdout, /10 ms budget/);
});

test("over budget is strictly more than 10 ms", { skip }, async () => {
  const { isOverBudget } = await import(script);
  assert.equal(isOverBudget(9.999), false);
  assert.equal(isOverBudget(10), false);
  assert.equal(isOverBudget(10.001), true);
});

test("a bad --pages is refused with the flag named", { skip }, () => {
  const run = spawnSync(process.execPath, [script, "--pages", "zero"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--pages/);
});
