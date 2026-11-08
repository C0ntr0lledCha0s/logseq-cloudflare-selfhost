import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { GraphStore } from "../graphs";
import { ToolError, runTool, textResult } from "./common";
import { type GraphAccess, graphFetch, resolveGraph } from "./semantic";
import type { OnSuccess } from "./readable";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";

// kb_index (design: README §11.8) answers "what is in this graph?" in one call. The sync server's
// listKnowledgeIndex does the expensive part (summaries, reference counts, class lineage); the
// connector pages through it, caches the result per graph alias in KB_INDEX_KV, and groups it into
// fixed buckets when it renders. The cache is rebuilt by the hourly cron (src/index.ts), when a
// page is created, renamed or deleted through this connector, on `refresh: true`, and whenever it
// is older than two cron periods (so a broken cron never serves an old index silently).
// Every rebuild also writes a slim titles key beside the record, for suggest_links (design:
// docs/superpowers/specs/2026-11-08-suggest-links-existing-pages-design.md, section 3.2). Both keys
// come from one fetch, carry the same builtAt, and are judged by one freshness rule (`isFresh`).

/** One page as the sync server's listKnowledgeIndex returns it. */
export interface KbIndexEntry {
  uuid: string;
  title: string;
  tags: { uuid: string; title: string; ident?: string }[];
  /** The page's tags, each followed by the classes it extends. */
  classes: string[];
  summary?: string;
  "reference-count": number;
  "created-at"?: number;
  "updated-at"?: number;
  /** The titles of the page's aliases, sorted (patch 0036); absent from an older server's answer. */
  aliases?: string[];
}

/** The cache format. A record or titles key without this version predates aliases and is rebuilt. */
export const KB_INDEX_VERSION = 2;

/** What KB_INDEX_KV holds for one alias. `graphId` guards against an alias re-pointed to another graph. */
export interface KbIndexRecord {
  graphId: string;
  /** Epoch ms when the build started; writes after it make the record dirty. */
  builtAt: number;
  version: typeof KB_INDEX_VERSION;
  pages: KbIndexEntry[];
}

/** One knowledge-index page as suggest_links needs it: its UUID, title and alias titles. */
export type KbTitlesPage = [uuid: string, title: string, aliases: string[]];

/** The titles key: the record's pages cut to KbTitlesPage, with the record's graphId and builtAt. */
export interface KbTitlesRecord {
  graphId: string;
  builtAt: number;
  version: typeof KB_INDEX_VERSION;
  pages: KbTitlesPage[];
}

/** Pages tagged with these classes (or a class extending one) never reach the index or its cache. */
export const KB_INDEX_PRIVATE_TAGS = ["private"];
/** The cron runs hourly (wrangler.template.jsonc); an older cache means it has not run, so rebuild. */
export const KB_INDEX_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Tools whose success changes the index's pages or their names; they mark the cache dirty. */
export const KB_INDEX_WRITE_TOOLS = new Set([
  "create_page",
  "update_page",
  "delete_page",
  "promote_page_to_tag",
  "update_tag",
  "delete_tag",
]);

const PAGE_SIZE = 200;
/** 100 requests of 200 pages: an index larger than 20,000 pages is refused rather than truncated. */
const MAX_REQUESTS = 100;
const SUMMARY_CHARS = 240;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RECORD_TTL_S = 7 * 24 * 60 * 60;
const DIRTY_TTL_S = 24 * 60 * 60;

const recordKey = (alias: string) => `kb-index:${alias}`;
const titlesKey = (alias: string) => `kb-index-titles:${alias}`;
const dirtyKey = (alias: string) => `kb-index-dirty:${alias}`;

/**
 * Buckets in the order they are tried and shown. A page goes to the first bucket one of its
 * classes names (its tags or any class they extend, compared ignoring case and spaces), else Other.
 * Resource also takes schema.org CreativeWork (articles, books, documents, guides, web sites).
 */
const BUCKETS: readonly { name: string; classes: readonly string[] }[] = [
  { name: "Project", classes: ["project"] },
  { name: "Organization", classes: ["organization", "organisation"] },
  { name: "Person", classes: ["person"] },
  { name: "Area", classes: ["area"] },
  { name: "Resource", classes: ["resource", "creativework"] },
];
const OTHER = "Other";

const normalize = (title: string) => title.toLowerCase().replace(/\s+/g, "");

export function kbGroup(entry: KbIndexEntry): string {
  const classes = new Set(entry.classes.map(normalize));
  return BUCKETS.find((bucket) => bucket.classes.some((c) => classes.has(c)))?.name ?? OTHER;
}

/** Every page of the graph's knowledge index, read from the sync server. */
async function fetchIndex(access: GraphAccess, alias: string): Promise<KbIndexRecord> {
  const graph = await resolveGraph(access, alias, false);
  const builtAt = Date.now();
  const pages: KbIndexEntry[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < MAX_REQUESTS; n += 1) {
    const response = await graphFetch(access, alias, graph.pat, {
      method: "GET",
      path: `/api/v1/graphs/${encodeURIComponent(graph.graphId)}/knowledge-index`,
      query: {
        limit: PAGE_SIZE,
        "exclude-tags": KB_INDEX_PRIVATE_TAGS.join(","),
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    const body = (await response.json()) as { pages: KbIndexEntry[]; "next-cursor"?: string };
    pages.push(...body.pages);
    cursor = body["next-cursor"];
    if (cursor === undefined) return { graphId: graph.graphId, builtAt, version: KB_INDEX_VERSION, pages };
  }
  throw new ToolError(`the knowledge index of '${alias}' has more than ${MAX_REQUESTS * PAGE_SIZE} pages`, "too-large");
}

function titlesOf(record: KbIndexRecord): KbTitlesRecord {
  return {
    graphId: record.graphId,
    builtAt: record.builtAt,
    version: record.version,
    pages: record.pages.map((p) => [p.uuid, p.title, p.aliases ?? []]),
  };
}

/**
 * Rebuilds and stores the index of `alias`: the titles key, then the record, both from one fetch
 * with one builtAt. The titles key is written first, so a failed write never leaves a record newer
 * than its titles.
 */
async function rebuild(access: GraphAccess, alias: string): Promise<{ record: KbIndexRecord; titles: KbTitlesRecord }> {
  const record = await fetchIndex(access, alias);
  const titles = titlesOf(record);
  await access.env.KB_INDEX_KV.put(titlesKey(alias), JSON.stringify(titles), { expirationTtl: RECORD_TTL_S });
  await access.env.KB_INDEX_KV.put(recordKey(alias), JSON.stringify(record), { expirationTtl: RECORD_TTL_S });
  return { record, titles };
}

/** Rebuilds and stores the index of `alias` (the record and the titles key). */
export async function rebuildKbIndex(access: GraphAccess, alias: string): Promise<KbIndexRecord> {
  return (await rebuild(access, alias)).record;
}

/** Records that the pages of `alias` changed, so the next kb_index call rebuilds. */
export async function markKbIndexDirty(env: Env, alias: string): Promise<void> {
  await env.KB_INDEX_KV.put(dirtyKey(alias), String(Date.now()), { expirationTtl: DIRTY_TTL_S });
}

/**
 * The one freshness rule for both keys: built for the same graph, in the current format, no older
 * than the max age, and not marked dirty at or after its builtAt.
 */
function isFresh(
  cached: { graphId: string; builtAt: number; version?: number } | null,
  graphId: string,
  dirty: string | null,
  now: number,
): boolean {
  if (cached === null || cached.graphId !== graphId) return false;
  if (cached.version !== KB_INDEX_VERSION) return false;
  if (now - cached.builtAt > KB_INDEX_MAX_AGE_MS) return false;
  if (dirty !== null && Number(dirty) >= cached.builtAt) return false;
  return true;
}

/** The cached value under `key` if `isFresh` accepts it: 2 KV reads (the key and the dirty mark). */
async function freshKey<T extends { graphId: string; builtAt: number; version?: number }>(
  access: GraphAccess,
  alias: string,
  key: string,
  now: number,
): Promise<T | null> {
  const graph = await resolveGraph(access, alias, false);
  const [cached, dirty] = await Promise.all([
    access.env.KB_INDEX_KV.get<T>(key, "json"),
    access.env.KB_INDEX_KV.get(dirtyKey(alias)),
  ]);
  return isFresh(cached, graph.graphId, dirty, now) ? cached : null;
}

/** The cached index of `alias` if it is fresh. */
function freshRecord(access: GraphAccess, alias: string, now: number): Promise<KbIndexRecord | null> {
  return freshKey<KbIndexRecord>(access, alias, recordKey(alias), now);
}

/** The cached titles of `alias` if they are fresh, by the same rule as the record. */
export function freshTitles(access: GraphAccess, alias: string, now: number): Promise<KbTitlesRecord | null> {
  return freshKey<KbTitlesRecord>(access, alias, titlesKey(alias), now);
}

/** The titles of `alias`: the cached key if fresh, else from a rebuild that rewrites both keys. */
export async function loadTitles(access: GraphAccess, alias: string, now: number): Promise<KbTitlesRecord> {
  return (await freshTitles(access, alias, now)) ?? (await rebuild(access, alias)).titles;
}

/** How long ago, for a cache's age: "just now", "23 min ago", "2 h 5 min ago". */
export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

function entryLine(entry: KbIndexEntry): string {
  const refs = entry["reference-count"];
  const parts = [
    entry.tags.length > 0 ? `${entry.title} [${entry.tags.map((t) => t.title).join(", ")}]` : entry.title,
    `${refs} ${refs === 1 ? "ref" : "refs"}${
      entry["updated-at"] === undefined ? "" : `, updated ${new Date(entry["updated-at"]).toISOString().slice(0, 10)}`
    }`,
  ];
  if (entry.summary !== undefined) {
    parts.push(entry.summary.length > SUMMARY_CHARS ? `${entry.summary.slice(0, SUMMARY_CHARS - 1)}…` : entry.summary);
  }
  return `- ${parts.join(" — ")} (${entry.uuid})`;
}

/** The index as markdown: a header with its age, then one section per non-empty bucket. */
export function renderKbIndex(
  alias: string,
  record: KbIndexRecord,
  { tag, limit, now }: { tag?: string; limit: number; now: number },
): string {
  const wanted = tag === undefined ? null : normalize(tag);
  const pages = wanted === null ? record.pages : record.pages.filter((p) => p.classes.some((c) => normalize(c) === wanted));
  const scope =
    wanted === null ? `${pages.length} pages` : `${pages.length} of ${record.pages.length} pages tagged '${tag}'`;
  const lines = [
    `Knowledge index of graph '${alias}': ${scope}, built ${new Date(record.builtAt).toISOString()} (${age(now - record.builtAt)}). ` +
      "It is rebuilt hourly and when pages are created, renamed or deleted through this connector; pass refresh: true to rebuild it now. " +
      "Journals, built-in pages and pages tagged private are left out. Read a page with get_page_outline using the UUID in parentheses.",
  ];
  let truncated = false;
  for (const name of [...BUCKETS.map((b) => b.name), OTHER]) {
    const members = pages
      .filter((p) => kbGroup(p) === name)
      .sort((a, b) => b["reference-count"] - a["reference-count"] || a.title.localeCompare(b.title));
    if (members.length === 0) continue;
    const shown = members.slice(0, limit);
    truncated ||= shown.length < members.length;
    lines.push("", `## ${name} (${members.length}${shown.length < members.length ? `, showing ${shown.length}` : ""})`);
    lines.push(...shown.map(entryLine));
  }
  if (truncated) lines.push("", "Some groups are cut to the most referenced pages: pass a higher limit or a tag to see more.");
  return lines.join("\n");
}

export function registerKbIndexTool(
  server: McpServer,
  access: GraphAccess,
  onSuccess: OnSuccess,
): void {
  server.registerTool(
    "kb_index",
    {
      description:
        "The graph's knowledge-base index in one call: every non-journal page grouped by class (Project, Organization, Person, Area, Resource, Other), with its tags, summary, reference count, last update and UUID, most referenced first. " +
        "Call this first for a broad topic or an overview, then read the relevant pages with get_page_outline. Served from a cache that is rebuilt hourly; the first line says how old it is.",
      inputSchema: z.object({
        graph: z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION),
        tag: z
          .string()
          .min(1)
          .optional()
          .describe("Only pages tagged with this class or a class extending it, e.g. Project or Person (ignoring case)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe(`Most pages listed per group (default ${DEFAULT_LIMIT}). Group counts are always complete.`),
        refresh: z.boolean().optional().describe("Rebuild the index from the graph now instead of using the cache."),
      }),
      annotations: annotationsFor("kb_index"),
    },
    ({ graph: alias, tag, limit, refresh }) =>
      runTool("kb_index", alias, async () => {
        const now = Date.now();
        const record = (refresh ? null : await freshRecord(access, alias, now)) ?? (await rebuildKbIndex(access, alias));
        onSuccess("kb_index", alias);
        return textResult(renderKbIndex(alias, record, { tag, limit: limit ?? DEFAULT_LIMIT, now: Date.now() }));
      }),
  );
}

/**
 * The cron job: rebuilds the index of every connected graph. A failing graph is logged and the
 * rest still run; the run then fails so the dashboard shows it. E2EE graphs have no server-side
 * index (the server answers 409) and are skipped.
 */
export async function refreshAllKbIndexes(env: Env): Promise<void> {
  const store = new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
  const access: GraphAccess = { env, resolve: (alias) => store.resolve(alias) };
  const graphs = await store.list();
  let failed = 0;
  for (const { alias } of graphs) {
    const started = Date.now();
    try {
      const record = await rebuildKbIndex(access, alias);
      logKbIndex(alias, `ok pages=${record.pages.length}`, started);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      if (error.status === "http-409") {
        logKbIndex(alias, "skipped-e2ee", started);
      } else {
        failed += 1;
        logKbIndex(alias, error.status, started);
      }
    }
  }
  if (failed > 0) throw new Error(`kb index refresh failed for ${failed} of ${graphs.length} graphs`);
}

/** Like the tool log line: the alias and outcome only, never page content or tokens. */
function logKbIndex(alias: string, status: string, started: number): void {
  console.log(`kb-index graph=${alias} status=${status} ms=${Date.now() - started}`);
}
