import type { CallToolResult } from "@modelcontextprotocol/server";
import { ToolError, resolveGraph } from "../tools/common";
import { type AffectedTarget, resultJson } from "../tools/readable";
import { type GraphAccess, graphFetch } from "../tools/semantic";

/**
 * Before-snapshots (design 2026-11-07-connector-write-audit-log §3.4). Before a write that overwrites
 * something, `audited()` reads it with one GET through the same graph token and stores the server's
 * JSON as the row's `before`: `{source, truncated?, e2ee?, error?, data}`. A block or page delete must
 * keep its whole subtree, so one that can't be read in full is refused, naming the entry; any other
 * write keeps a cut-down snapshot or the read's error and goes ahead. Dry runs keep nothing, and only a delete's dry run reads (to be refused as the real call would be).
 */

/**
 * The largest snapshot stored, in UTF-8 bytes of the server's JSON. get_activity_log returns a
 * snapshot whole in one result, which claude.ai cuts at RESULT_CHAR_LIMIT (150,000) characters; a
 * UTF-8 byte count is never below the character count, so 100 KB leaves the entry's other fields
 * about 47,000 characters.
 */
export const SNAPSHOT_MAX_BYTES = 100 * 1024;
const SNAPSHOT_MAX_LABEL = `${SNAPSHOT_MAX_BYTES / 1024} KB`;
/** getBlocks takes at most this many ids. */
const GET_BLOCKS_MAX_IDS = 100;
/** batch_insert_block_trees: the most pages named by title or date read with getPage, one GET each. */
export const PAGE_READS_MAX = 10;

export type SnapshotSource = "getBlocks" | "getPageOutline" | "getPage" | "getTag" | "getProperty" | "refresh_refs";

/** One GET under the graph's path. */
export interface SnapshotRequest {
  source: Exclude<SnapshotSource, "refresh_refs">;
  path: string;
  query?: Record<string, string>;
  /** The call's ids, when there were more than getBlocks takes and only the first ones are read. */
  cut?: boolean;
  /** For a getBlocks read, the UUIDs as the call gave them, in the order read (to name an entry). */
  ids?: string[];
  /** For a getBlocks read, each of `ids`' index in the call's list. */
  indexes?: number[];
}

export type SnapshotPlanEntry =
  | {
      source: Exclude<SnapshotSource, "refresh_refs">;
      /** The read, or null when nothing the call names can be read (the write refuses it itself). */
      read(args: Record<string, unknown>): SnapshotRequest | null;
      /** A delete: refused unless its snapshot is read in full. */
      delete?: { e2ee(args: Record<string, unknown>): SnapshotRequest | null };
      /** Pages the call names by title or date whose values it overwrites, each read with getPage. */
      pages?(args: Record<string, unknown>): unknown[];
      keep: string;
    }
  | { source: "refresh_refs"; keep: string }
  | { source: "none"; why: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The body's list under `key`, as records. */
function entries(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return list(record(args.body)?.[key]).flatMap((e) => (record(e) ? [record(e)!] : []));
}

/**
 * A getBlocks read of the UUIDs among `given`, each once (ignoring case, as getBlocks refuses a
 * duplicate), in call order, at most 100. Titles, dates and other selectors can't name a block for
 * getBlocks; the write refuses what doesn't exist.
 */
function blocksRead(given: unknown[], view: "summary" | "outline"): SnapshotRequest | null {
  const seen = new Set<string>();
  const ids: string[] = [];
  const indexes: number[] = [];
  given.forEach((id, index) => {
    if (typeof id !== "string" || !UUID.test(id) || seen.has(id.toLowerCase())) return;
    seen.add(id.toLowerCase());
    ids.push(id);
    indexes.push(index);
  });
  if (ids.length === 0) return null;
  const read = ids.slice(0, GET_BLOCKS_MAX_IDS);
  return {
    source: "getBlocks",
    path: "/blocks",
    query: { ids: read.join(","), view },
    ids: read,
    indexes: indexes.slice(0, GET_BLOCKS_MAX_IDS),
    cut: ids.length > read.length,
  };
}

/** A string that names a page by title or date rather than by UUID (UUIDs go to getBlocks). */
function pageSelector(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "." && value !== ".." && !UUID.test(value);
}

/** A read of `/<kind>/<id><suffix>`, or null for an id the handler itself refuses before any request. */
function entityRead(source: SnapshotRequest["source"], kind: string, id: unknown, suffix = ""): SnapshotRequest | null {
  if (typeof id !== "string" || id === "" || id === "." || id === "..") return null;
  return { source, path: `/${kind}/${encodeURIComponent(id)}${suffix}` };
}

const blockSummary = (ids: (args: Record<string, unknown>) => unknown[]) => ({
  source: "getBlocks" as const,
  read: (args: Record<string, unknown>) => blocksRead(ids(args), "summary"),
  keep: "title, tags, properties, parent-id, order and page-id of each addressed block",
});

const blockDelete = (ids: (args: Record<string, unknown>) => unknown[]) => ({
  source: "getBlocks" as const,
  read: (args: Record<string, unknown>) => blocksRead(ids(args), "outline"),
  delete: { e2ee: (args: Record<string, unknown>) => blocksRead(ids(args), "summary") },
  keep: "each block's summary and its subtree as a markdown outline",
});

const page = (args: Record<string, unknown>) => entityRead("getPage", "pages", args["page-id"]);
const tag = (args: Record<string, unknown>) => entityRead("getTag", "tags", args["tag-id"]);
const property = (args: Record<string, unknown>) => entityRead("getProperty", "properties", args["property-id"]);

const NOTHING_OVERWRITTEN = "it adds new blocks, pages or files and overwrites nothing";

/** What each write tool reads before it writes (§3.4's table). Every non-read tool has an entry. */
export const SNAPSHOT_PLAN: Readonly<Record<string, SnapshotPlanEntry>> = Object.freeze({
  update_block: blockSummary((a) => [a["block-id"]]),
  set_block_property: blockSummary((a) => [a["block-id"]]),
  delete_block_property: blockSummary((a) => [a["block-id"]]),
  batch_set_block_property: blockSummary((a) => entries(a, "entries").map((e) => e["block-id"])),
  batch_delete_block_property: blockSummary((a) => entries(a, "entries").map((e) => e["block-id"])),
  move_blocks: blockSummary((a) => list(record(a.body)?.["block-ids"])),
  batch_move_blocks: blockSummary((a) => entries(a, "moves").flatMap((m) => list(m["block-ids"]))),
  // Entries that set properties replace the values of the block or page they name: by UUID through
  // getBlocks, by title or date (target-id or page) through getPage. Plain inserts overwrite nothing.
  batch_insert_block_trees: {
    ...blockSummary((a) =>
      entries(a, "entries")
        .filter((e) => e.properties !== undefined)
        .map((e) => e["target-id"]),
    ),
    pages: (a) =>
      entries(a, "entries")
        .filter((e) => e.properties !== undefined)
        .flatMap((e) => [e["target-id"], e.page]),
    keep: "title, tags, properties, parent-id, order and page-id of each addressed block, and each page named by title or date",
  },
  delete_block: blockDelete((a) => [a["block-id"]]),
  delete_blocks: blockDelete((a) => list(record(a.body)?.["block-ids"])),
  delete_page: {
    source: "getPageOutline",
    read: (a) => entityRead("getPageOutline", "pages", a["page-id"], "/outline"),
    delete: { e2ee: page },
    keep: "the page, its properties and its whole outline",
  },
  update_page: { source: "getPage", read: page, keep: "title, tags and properties" },
  promote_page_to_tag: { source: "getPage", read: page, keep: "the page's title, tags and properties" },
  update_tag: { source: "getTag", read: tag, keep: "title, extends and tag properties" },
  delete_tag: { source: "getTag", read: tag, delete: { e2ee: () => null }, keep: "title, extends and tag properties" },
  update_property: { source: "getProperty", read: property, keep: "type, cardinality, choices and classes" },
  delete_property: { source: "getProperty", read: property, delete: { e2ee: () => null }, keep: "type, cardinality, choices and classes" },
  refresh_refs: { source: "refresh_refs", keep: "each changed block's text before the refresh, from its own response" },
  insert_block_children: { source: "none", why: NOTHING_OVERWRITTEN },
  insert_block_tree: { source: "none", why: NOTHING_OVERWRITTEN },
  capture_to_today: { source: "none", why: NOTHING_OVERWRITTEN },
  create_task: { source: "none", why: NOTHING_OVERWRITTEN },
  create_page: { source: "none", why: NOTHING_OVERWRITTEN },
  create_tag: { source: "none", why: NOTHING_OVERWRITTEN },
  create_property: { source: "none", why: NOTHING_OVERWRITTEN },
  save_document: { source: "none", why: NOTHING_OVERWRITTEN },
  save_file_from_url: { source: "none", why: NOTHING_OVERWRITTEN },
});

/** The tool's snapshot plan. Throws for a tool with no entry, so a new write can't ship without one. */
export function snapshotClassFor(name: string): SnapshotPlanEntry {
  if (!Object.hasOwn(SNAPSHOT_PLAN, name)) throw new Error(`no snapshot plan for tool ${name}`);
  return SNAPSHOT_PLAN[name];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytes(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The stored snapshot: the server's JSON text kept as sent, wrapped without re-serialising it. */
function wrap(source: string, flags: { truncated?: boolean; e2ee?: boolean }, data: string): string {
  const head = JSON.stringify({ source, ...(flags.truncated ? { truncated: true } : {}), ...(flags.e2ee ? { e2ee: true } : {}) });
  return `${head.slice(0, -1)},"data":${data}}`;
}

const SUMMARY_KEYS = ["uuid", "kind", "title", "order", "parent-id", "page-id"];

function pick(value: unknown): Record<string, unknown> {
  const from = record(value) ?? {};
  return Object.fromEntries(SUMMARY_KEYS.filter((k) => from[k] !== undefined).map((k) => [k, from[k]]));
}

/** A read's data cut down to each addressed block's (or the entity's) summary. */
function cutData(parsed: unknown): unknown {
  const blocks = record(parsed)?.blocks;
  return Array.isArray(blocks) ? { blocks: blocks.map(pick), missing: record(parsed)?.missing } : pick(parsed);
}

function fits(text: string): boolean {
  return new TextEncoder().encode(text).length <= SNAPSHOT_MAX_BYTES;
}

/** A non-delete snapshot over the cap, cut down to each addressed block's (or the entity's) summary. */
function cutDown(source: string, parsed: unknown, e2ee: boolean): string {
  const text = wrap(source, { truncated: true, e2ee }, JSON.stringify(cutData(parsed)));
  return fits(text) ? text : wrap(source, { truncated: true, e2ee }, "null");
}

interface Read {
  request: SnapshotRequest;
  text: string;
  size: number;
  parsed: unknown;
}

async function get(access: GraphAccess, alias: string, request: SnapshotRequest): Promise<Read> {
  const graph = await resolveGraph(access, alias, true);
  const response = await graphFetch(access, alias, graph.pat, {
    method: "GET",
    path: `/api/v1/graphs/${encodeURIComponent(graph.graphId)}${request.path}`,
    query: request.query,
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(body);
  const parsed: unknown = JSON.parse(text);
  if (request.source === "getBlocks" && !Array.isArray(record(parsed)?.blocks)) throw new Error("getBlocks answered without blocks");
  if (record(parsed) === undefined) throw new Error(`${request.source} answered without an object`);
  return { request, text, size: body.byteLength, parsed };
}

/** Each entry the read returned, with its index in the call and the id as the call gave it. */
function readEntries(read: Read): { index: number; id: string; entry: Record<string, unknown> }[] {
  if (read.request.source !== "getBlocks") {
    const entry = record(read.parsed)!;
    return [{ index: 0, id: typeof entry.uuid === "string" ? entry.uuid : "", entry }];
  }
  const given = read.request.ids ?? [];
  return list(record(read.parsed)?.blocks).flatMap((block) => {
    const entry = record(block);
    const uuid = typeof entry?.uuid === "string" ? entry.uuid.toLowerCase() : undefined;
    const index = given.findIndex((id) => id.toLowerCase() === uuid);
    return entry && index >= 0 ? [{ index: read.request.indexes?.[index] ?? index, id: given[index], entry }] : [];
  });
}

/**
 * Refuses a block delete when the read didn't return a block it names: getBlocks hides blocks under a
 * deleted (Recycle bin) or hidden ancestor, which the delete still finds and removes.
 */
function checkFound(read: Read): void {
  if (read.request.source !== "getBlocks") return;
  const found = new Set(readEntries(read).map((f) => f.id.toLowerCase()));
  const ids = read.request.ids ?? [];
  const i = ids.findIndex((id) => !found.has(id.toLowerCase()));
  if (i >= 0) {
    throw new ToolError(`entry ${read.request.indexes?.[i] ?? i}: ${ids[i]} can't be read (hidden, in the Recycle bin or not found); nothing was deleted`, "refused");
  }
}

/** Refuses a delete whose snapshot isn't whole: an entry the budget cut short, or over the size cap. */
function checkWhole(read: Read): void {
  const found = readEntries(read);
  const cut = found.find((f) => f.entry.truncated === true);
  if (cut) {
    throw new ToolError(`entry ${cut.index}: ${cut.id} has more descendants than the 2,000-block snapshot budget; delete it in parts`, "refused");
  }
  if (read.size > SNAPSHOT_MAX_BYTES) {
    // Name the entry whose subtree takes the snapshot over the cap, counting each entry in read order.
    const encoder = new TextEncoder();
    let total = 0;
    let over = found.at(-1);
    for (const f of found) {
      total += encoder.encode(JSON.stringify(f.entry)).length;
      if (total > SNAPSHOT_MAX_BYTES) {
        over = f;
        break;
      }
    }
    const named = over ? `entry ${over.index}: ${over.id}` : "the snapshot";
    throw new ToolError(`${named} takes the snapshot over ${SNAPSHOT_MAX_LABEL} (${bytes(read.size)} bytes); delete it in parts`, "refused");
  }
}

/** What a pre-read learnt: the row's `before`, and the pages it names (for the log's page filter). */
export interface Snapshot {
  before: string | null;
  /** Page UUIDs and titles the reads returned. */
  pages: string[];
  /** The page a getPage or getPageOutline read returned, as a target, for a write whose response names none. */
  subject?: AffectedTarget;
}

/** A delete refused after its read, carrying what the read learnt (no `before`) for the log's page filter. */
export class SnapshotRefusal extends ToolError {
  constructor(
    message: string,
    readonly snapshot: Snapshot,
  ) {
    super(message, "refused");
  }
}

/** The pages a read names: a page read's UUID and title, and each block's page-id. */
function pagesRead(read: Read): string[] {
  if (read.request.source === "getBlocks") {
    return list(record(read.parsed)?.blocks).flatMap((b) => {
      const page = record(b)?.["page-id"];
      return typeof page === "string" ? [page] : [];
    });
  }
  if (read.request.source !== "getPage" && read.request.source !== "getPageOutline") return [];
  const entity = record(read.parsed)!;
  return [entity.uuid, entity.title].filter((v): v is string => typeof v === "string" && v !== "");
}

function subjectOf(read: Read): AffectedTarget | undefined {
  if (read.request.source !== "getPage" && read.request.source !== "getPageOutline") return undefined;
  const entity = record(read.parsed)!;
  if (typeof entity.uuid !== "string") return undefined;
  const title = typeof entity.title === "string" ? entity.title : undefined;
  const kind = typeof entity.kind === "string" ? entity.kind : "page";
  return { uuid: entity.uuid, kind, role: "target", pageUuid: entity.uuid, pageTitle: title, breadcrumb: [], snippet: title };
}

function snapshotOf(before: string | null, reads: Read[]): Snapshot {
  const pages = [...new Set(reads.flatMap(pagesRead))];
  const subject = reads.length === 1 ? subjectOf(reads[0]) : undefined;
  return { before, pages, ...(subject ? { subject } : {}) };
}

/** Each distinct page selector (ignoring case), in call order. */
function distinctSelectors(given: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of given) {
    if (!pageSelector(value) || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

/**
 * batch_insert_block_trees with pages named by title or date: the getBlocks read (or null when no
 * block UUID carries properties) and one getPage read per page, the first PAGE_READS_MAX of them,
 * stored as `{source: getBlocks, truncated?, error?, data, pages: [{page, source: getPage, data | error}]}`.
 * Over the cap, each read is cut down to its summary, and past that every data is null.
 */
async function batchInsertSnapshot(access: GraphAccess, alias: string, request: SnapshotRequest | null, selectors: string[]): Promise<Snapshot> {
  const reads: Read[] = [];
  let blocks: Read | undefined;
  let blocksError: string | undefined;
  if (request !== null) {
    try {
      blocks = await get(access, alias, request);
      reads.push(blocks);
    } catch (error) {
      blocksError = messageOf(error);
    }
  }
  const pages: { page: string; read?: Read; error?: string }[] = [];
  for (const page of selectors.slice(0, PAGE_READS_MAX)) {
    try {
      const read = await get(access, alias, entityRead("getPage", "pages", page)!);
      pages.push({ page, read });
      reads.push(read);
    } catch (error) {
      pages.push({ page, error: messageOf(error) });
    }
  }
  const truncated = request?.cut === true || selectors.length > PAGE_READS_MAX;
  const build = (data: (read: Read) => string, cut: boolean): string => {
    const head = JSON.stringify({ source: "getBlocks", ...(cut ? { truncated: true } : {}), ...(blocksError !== undefined ? { error: blocksError } : {}) });
    const parts = pages.map((p) =>
      p.read ? `{"page":${JSON.stringify(p.page)},"source":"getPage","data":${data(p.read)}}` : JSON.stringify({ page: p.page, source: "getPage", error: p.error }),
    );
    return `${head.slice(0, -1)},"data":${blocks ? data(blocks) : "null"},"pages":[${parts.join(",")}]}`;
  };
  let text = build((r) => r.text, truncated);
  if (!fits(text)) text = build((r) => JSON.stringify(cutData(r.parsed)), true);
  if (!fits(text)) text = build(() => "null", true);
  return snapshotOf(text, reads);
}

/**
 * Reads what `tool` will overwrite, for the row's `before`: null when the tool reads nothing or the
 * call names nothing readable. A delete whose snapshot isn't whole, whose read fails or doesn't
 * return a block it names, throws a refusal (`ToolError` "refused") naming the entry; any other write
 * keeps the error or a cut-down snapshot. On an E2EE graph (an outline read answers 409) a delete
 * keeps the summaries, with e2ee.
 */
export async function takeSnapshot(access: GraphAccess, alias: string, tool: string, args: Record<string, unknown>): Promise<Snapshot> {
  const none: Snapshot = { before: null, pages: [] };
  const plan = snapshotClassFor(tool);
  if (plan.source === "none" || plan.source === "refresh_refs") return none;
  const request = plan.read(args);
  const selectors = distinctSelectors(plan.pages?.(args) ?? []);
  if (selectors.length > 0) return batchInsertSnapshot(access, alias, request, selectors);
  if (request === null) return none;

  if (plan.delete) {
    let read: Read;
    let e2ee = false;
    try {
      try {
        read = await get(access, alias, request);
      } catch (error) {
        const fallback = error instanceof ToolError && error.status === "http-409" ? plan.delete.e2ee(args) : null;
        if (fallback === null) throw error;
        read = await get(access, alias, fallback);
        e2ee = true;
      }
    } catch (error) {
      throw new ToolError(`audit snapshot failed: ${messageOf(error)}; nothing was deleted`, "refused");
    }
    try {
      checkFound(read);
      checkWhole(read);
    } catch (error) {
      // Refused after a read: the pages it read still find the refusal in the log.
      throw new SnapshotRefusal(messageOf(error), snapshotOf(null, [read]));
    }
    return snapshotOf(wrap(read.request.source, { truncated: read.request.cut, e2ee }, read.text), [read]);
  }

  let read: Read;
  try {
    read = await get(access, alias, request);
  } catch (error) {
    return { before: JSON.stringify({ source: request.source, error: messageOf(error) }), pages: [] };
  }
  if (read.size > SNAPSHOT_MAX_BYTES) return snapshotOf(cutDown(read.request.source, read.parsed, false), [read]);
  return snapshotOf(wrap(read.request.source, { truncated: read.request.cut }, read.text), [read]);
}

/** refresh_refs' snapshot, from its own response: each changed block's text before the refresh. Null for a preview. */
export function refreshRefsBefore(result: CallToolResult): string | null {
  const response = record(resultJson(result));
  if (response?.applied !== true) return null;
  const data = list(response.changed).map((c) => {
    const change = record(c) ?? {};
    return { uuid: change.uuid, "page-id": change["page-id"], before: change.before };
  });
  const whole = JSON.stringify({ source: "refresh_refs", ...(response.truncated === true ? { truncated: true } : {}), data });
  if (fits(whole)) return whole;
  // Over the cap: every block's uuid and page-id, and its text while the texts, in order, still fit.
  const encoder = new TextEncoder();
  const ids = data.map(({ uuid, "page-id": pageId }) => ({ uuid, "page-id": pageId }));
  const cut = (kept: unknown) => JSON.stringify({ source: "refresh_refs", truncated: true, data: kept });
  let room = SNAPSHOT_MAX_BYTES - encoder.encode(cut(ids)).length;
  if (room < 0) return cut(null);
  let texts = 0;
  for (; texts < data.length; texts += 1) {
    const extra = encoder.encode(JSON.stringify(data[texts])).length - encoder.encode(JSON.stringify(ids[texts])).length;
    if (extra > room) break;
    room -= extra;
  }
  return cut([...data.slice(0, texts), ...ids.slice(texts)]);
}
