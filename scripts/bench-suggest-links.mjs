// Bench for suggest_links on the front Worker's 10 ms CPU budget (spec 2026-11-08 §5).
//
// vitest cannot measure CPU in workerd (performance.now does not advance during CPU work), so this
// runs the connector's real matcher under Node: it bundles connector/src/tools/suggest-links.ts with
// the esbuild in connector/node_modules (a wrangler dependency; the connector's extensionless
// imports do not load under Node's type stripping), builds a seeded fixture of example page titles
// in the titles key's shape, and times JSON.parse of that key, resolving page plus EXCLUDE_LIMIT
// exclude refs (all unknown, the costliest case), and matchLinks on a draft.
//
//   node scripts/bench-suggest-links.mjs [--pages 20000] [--runs 20] [--json]
//
// Times are medians over --runs runs, after one warm-up run. The numbers are a guide: Node on a
// developer machine is not workerd on Cloudflare's hardware.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The front Worker's CPU limit per request on the Free plan. */
export const BUDGET_MS = 10;
/** Over the budget means strictly more than 10 ms; exactly 10 ms fits. */
export const isOverBudget = (ms) => ms > BUDGET_MS;
/** suggest_links's TEXT_LIMIT: the longest draft it accepts. */
export const DRAFT_CHARS = 10_000;
export const DEFAULT_PAGES = 20_000;
export const DEFAULT_RUNS = 20;
/** suggest_links's DEFAULT_LIMIT. */
const LIMIT = 25;

/** A small seeded PRNG (mulberry32), so the fixture is the same on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_WORDS = (
  "workflow intelligence operational sales health sprint plans review project client meeting " +
  "decision idea research budget forecast roadmap delivery platform report data model team " +
  "strategy design product customer service partner finance audit risk policy process quality " +
  "support account market growth pricing contract vendor training onboarding hiring culture " +
  "security compliance privacy cloud integration automation analytics dashboard metric goal " +
  "objective outcome initiative programme portfolio release incident retro standup governance"
).split(" ");
const SYLLABLES = "ka ri to ne mo la su vi de pa ho ru mi te na po li se ga fu".split(" ");
const FILLER = "the a of and to in for on with as by at from is was that this it".split(" ");

/** Base words plus seeded made-up words, enough that a 20,000-page graph has many first words. */
function vocabulary(rand) {
  const words = new Set(BASE_WORDS);
  while (words.size < 3_000) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    words.add(w);
  }
  return [...words];
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const hex = (rand, n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

/**
 * `pages` titles-key entries, [uuid, title, aliases], seeded: titles of one to four words, about
 * one page in ten with an alias (an acronym or a short form).
 */
export function makeTitles(pages, seed = 1) {
  const rand = prng(seed);
  const vocab = vocabulary(rand);
  const seen = new Set();
  const out = [];
  while (out.length < pages) {
    const n = 1 + Math.floor(rand() * 4);
    const words = Array.from({ length: n }, () => pick(rand, vocab));
    const title = words.map(cap).join(" ");
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const uuid = `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
    const aliases = n > 1 && rand() < 0.1 ? [words.map((w) => w[0].toUpperCase()).join("") + words[0]] : [];
    out.push([uuid, title, aliases]);
  }
  return out;
}

/**
 * A seeded draft of exactly `chars` characters: prose from the fixture's words with page titles
 * every few words, some already [[linked]], some inside `code`, so every masking path runs.
 */
export function makeDraft(titles, chars = DRAFT_CHARS, seed = 2) {
  const rand = prng(seed);
  const vocab = vocabulary(prng(1));
  const parts = [];
  let len = 0;
  while (len < chars) {
    const r = rand();
    let piece;
    if (r < 0.06) piece = pick(rand, titles)[1];
    else if (r < 0.07) piece = `[[${pick(rand, titles)[1]}]]`;
    else if (r < 0.08) piece = `\`${pick(rand, titles)[1]}\``;
    else if (r < 0.4) piece = pick(rand, FILLER);
    else piece = pick(rand, vocab);
    if (rand() < 0.05) piece += ".\n";
    parts.push(piece);
    len += piece.length + 1;
  }
  return parts.join(" ").slice(0, chars);
}

/** Titles and aliases whose first word appears anywhere in the draft: spec 3.3 c's bound. */
export function firstWordBound(titles, draft) {
  const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const inDraft = new Set(words(draft));
  let n = 0;
  for (const [, title, aliases] of titles) for (const name of [title, ...aliases]) if (inDraft.has(words(name)[0])) n++;
  return n;
}

/** Bundles the real matcher with the connector's esbuild and imports it. */
export async function loadMatcher() {
  const connector = join(root, "connector");
  const esbuild = createRequire(join(connector, "package.json"))("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "bench-suggest-links-"));
  try {
    const outfile = join(dir, "suggest-links.mjs");
    await esbuild.build({
      entryPoints: [join(connector, "src", "tools", "suggest-links.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (ms) => Math.round(ms * 1000) / 1000;

export async function bench({ pages = DEFAULT_PAGES, runs = DEFAULT_RUNS } = {}) {
  const { matchLinks, pageResolver, EXCLUDE_LIMIT } = await loadMatcher();
  const titles = makeTitles(pages);
  const draft = makeDraft(titles, DRAFT_CHARS);
  // The titles key as kb-index.ts writes it (KbTitlesRecord).
  const key = JSON.stringify({ graphId: "bench", builtAt: 0, version: 2, pages: titles });
  // page (a UUID) plus EXCLUDE_LIMIT excludes, none in the index, so each one misses every lookup
  // and the UUID makes every page's UUID a candidate too.
  const refs = ["ffffffff-ffff-4fff-8fff-ffffffffffff", ...Array.from({ length: EXCLUDE_LIMIT }, (_, i) => `Not A Page ${i}`)];

  const once = () => {
    const t0 = performance.now();
    const record = JSON.parse(key);
    const t1 = performance.now();
    const exclude = new Set();
    for (const found of pageResolver(record.pages, refs)) if (found && "uuid" in found) exclude.add(found.uuid);
    const t2 = performance.now();
    const result = matchLinks(draft, record.pages, { exclude, limit: LIMIT });
    const t3 = performance.now();
    return { parse: t1 - t0, resolve: t2 - t1, match: t3 - t2, result };
  };
  const first = once();
  const parse = [];
  const resolveTimes = [];
  const match = [];
  let result = first.result;
  for (let i = 0; i < runs; i++) {
    const r = once();
    parse.push(r.parse);
    resolveTimes.push(r.resolve);
    match.push(r.match);
    result = r.result;
  }
  const parseMs = round(median(parse));
  const resolveMs = round(median(resolveTimes));
  const matchMs = round(median(match));
  const totalMs = round(parseMs + resolveMs + matchMs);
  return {
    pages,
    titlesBytes: Buffer.byteLength(key),
    draftChars: draft.length,
    runs,
    budgetMs: BUDGET_MS,
    parseMs,
    resolveRefs: refs.length,
    resolveMs,
    matchMs,
    totalMs,
    firstRunMs: round(first.parse + first.resolve + first.match),
    overBudget: isOverBudget(totalMs),
    tokenised: result.tokenised,
    firstWordBound: firstWordBound(titles, draft),
    suggestions: result.suggestions.length,
    node: process.version,
  };
}

function parseArgs(argv) {
  const opts = { pages: DEFAULT_PAGES, runs: DEFAULT_RUNS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--pages" || a === "--runs") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${a} needs a whole number of at least 1, got ${argv[i]}`);
      opts[a.slice(2)] = n;
    } else throw new Error(`unknown argument ${a}; usage: bench-suggest-links.mjs [--pages N] [--runs N] [--json]`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const r = await bench(opts);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else {
    const kb = (r.titlesBytes / 1024).toFixed(0);
    console.log(`suggest_links bench: ${r.pages} pages (titles key ${kb} KiB), ${r.draftChars}-character draft, median of ${r.runs} runs, Node ${r.node}`);
    console.log(`  JSON.parse of the titles key  ${r.parseMs} ms`);
    console.log(`  resolving ${r.resolveRefs} page refs        ${r.resolveMs} ms (page plus every exclude, none in the index)`);
    console.log(`  matchLinks on the draft       ${r.matchMs} ms (tokenised ${r.tokenised} of a first-word bound of ${r.firstWordBound}; ${r.suggestions} suggestions)`);
    console.log(`  total                         ${r.totalMs} ms against the ${r.budgetMs} ms budget${r.overBudget ? ": OVER BUDGET" : ""} (first run ${r.firstRunMs} ms)`);
  }
}
