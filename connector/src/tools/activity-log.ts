import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type AuditCursor, type AuditLog, type AuditRow } from "../audit/log";
import { RESULT_CHAR_LIMIT, ToolError, resolveGraph, runTool } from "./common";
import { type AffectedTarget, targetLine } from "./readable";
import type { GraphAccess } from "./semantic";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";

// get_activity_log (design 2026-11-07-connector-write-audit-log §3.5 and §4) reads the audit log
// back: "what did Claude change this week" in one call. A listing is one capped query
// (AuditLog.query, at most 500 rows read), a lookup by id one row; each call then records its own
// cost as a kind = 'read' row (2 rows written), which listings never show.

const DAY_MS = 86_400_000;
/** The default window: the last 7 days. */
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
export const MAX_WINDOW_DAYS = 92;
/**
 * A window of 92 calendar days that spans the end of daylight saving is an hour longer; it is kept.
 * The slack is one hour, the largest daylight saving shift in use.
 */
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * DAY_MS + 3_600_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The longest error text a summary line shows; the JSON holds all of it. */
const ERROR_CHARS = 200;
const STATUSES = ["ok", "error", "refused", "pending", "dry-run"] as const;
/**
 * Room kept in a result for its text part's header and cursor line and the JSON's own keys. An
 * entry's JSON longer than RESULT_CHAR_LIMIT less this keeps only its first target.
 */
const RESULT_RESERVE = 2_000;

export interface ActivityLogDeps {
  log: AuditLog;
  access: GraphAccess;
  /** The owner's IANA time zone (config/settings.json `timeZone`): dates are read and shown in it. */
  timeZone: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** The time zone's offset from UTC at `t`, in ms (positive east of Greenwich). */
function offsetAt(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - (t - (((t % 1000) + 1000) % 1000));
}

/** The instant a wall-clock time in `timeZone` names (fields as Date.UTC takes them, overflow allowed). */
function zoned(timeZone: string, ...fields: [number, number, number, number?, number?, number?, number?]): number {
  const wall = Date.UTC(...fields);
  const first = offsetAt(wall - offsetAt(wall, timeZone), timeZone);
  return wall - first;
}

/** True when the fields name a real calendar date and time. */
function valid(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

/**
 * `since` or `until` as ms since the epoch. A date (YYYY-MM-DD) is that day in the owner's time
 * zone: its start for `since`, the start of the next day for `until` (which is exclusive), so a
 * single date names the whole day. A datetime without Z or an offset is local time there.
 */
export function parseWhen(name: "since" | "until", value: string, timeZone: string): number {
  const refuse = () => new ToolError(`${name}: not a date or datetime (YYYY-MM-DD or an ISO datetime, e.g. 2026-11-05 or 2026-11-05T14:00)`, "refused");
  const date = DATE.exec(value);
  if (date) {
    const [y, mo, d] = date.slice(1, 4).map(Number);
    if (!valid(y, mo, d)) throw refuse();
    return zoned(timeZone, y, mo - 1, name === "until" ? d + 1 : d);
  }
  const dt = DATETIME.exec(value);
  if (!dt) throw refuse();
  const [y, mo, d, h, mi] = dt.slice(1, 6).map(Number);
  const s = dt[6] === undefined ? 0 : Number(dt[6]);
  const ms = dt[7] === undefined ? 0 : Number(dt[7].padEnd(3, "0"));
  if (!valid(y, mo, d, h, mi, s)) throw refuse();
  const zone = dt[8];
  if (zone === undefined) return zoned(timeZone, y, mo - 1, d, h, mi, s, ms);
  const offset = zone === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
  return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset;
}

/** The window a call reads: `[since, until)`, by default the last 7 days. Refuses one over 92 days. */
export function windowOf(args: { since?: string; until?: string }, timeZone: string, now: number): { since: number; until: number } {
  const until = args.until === undefined ? now + 1 : parseWhen("until", args.until, timeZone);
  const since = args.since === undefined ? until - DEFAULT_WINDOW_MS : parseWhen("since", args.since, timeZone);
  if (since >= until) throw new ToolError("window: since must be before until", "refused");
  if (until - since > MAX_WINDOW_MS) {
    const days = Math.ceil((until - since - 3_600_000) / DAY_MS);
    throw new ToolError(`window: at most ${MAX_WINDOW_DAYS} days; this one is ${days} days, so read it in parts`, "refused");
  }
  return { since, until };
}

const CURSOR = /^(\d{1,16})\.(\d{1,16})$/;

function encodeCursor(c: AuditCursor): string {
  return `${c.at}.${c.id}`;
}

function decodeCursor(value: string): AuditCursor {
  const m = CURSOR.exec(value);
  if (!m) throw new ToolError("cursor: not a next-cursor from get_activity_log; pass the previous result's next-cursor as given", "refused");
  return { at: Number(m[1]), id: Number(m[2]) };
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** `t` as the journal titles show a date, with the local time: Nov 5th, 2026 14:02. */
export function formatWhen(t: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${ordinal(Number(get("day")))}, ${get("year")} ${get("hour")}:${get("minute")}`;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function targetsOf(row: AuditRow): AffectedTarget[] {
  const parsed = parseJson(row.targets);
  return Array.isArray(parsed) ? (parsed as AffectedTarget[]) : [];
}

function addressedOf(row: AuditRow): string[] {
  const parsed = parseJson(row.addressed);
  return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
}

/** The outcome as a summary line shows it. A pending row's write may or may not have been applied. */
function outcome(row: AuditRow): string {
  if (row.status === "pending") return "outcome unknown";
  if (row.status === "ok") return row.dryRun ? "dry run" : "ok";
  const error = (row.error ?? "").replace(/\s*\n\s*/g, " ");
  const shown = error.length > ERROR_CHARS ? `${error.slice(0, ERROR_CHARS - 1)}…` : error;
  return `${row.status}${row.dryRun ? " (dry run)" : ""}: ${shown}`;
}

/**
 * One entry as a line: when (local time), tool, outcome, the first block or page it changed (or, when
 * it names none, wrote to) as item 17's summaries show it, how many more, and the reason. An entry
 * with no target shows the first UUID or selector the call named instead.
 */
export function entryLine(row: AuditRow, timeZone: string): string {
  const targets = targetsOf(row);
  const affected = targets.filter((t) => t.role === "affected");
  const shown = affected.length > 0 ? affected : targets;
  const addressed = addressedOf(row);
  let text = `${formatWhen(row.at, timeZone)} ${row.tool} ${outcome(row)}`;
  if (shown.length > 0) text += `: ${targetLine(shown[0])}${shown.length > 1 ? ` (+${shown.length - 1} more)` : ""}`;
  else if (addressed.length > 0) text += `: ${addressed[0]}${addressed.length > 1 ? ` (+${addressed.length - 1} more)` : ""}`;
  if (row.reason !== null) text += `. Reason: ${row.reason}`;
  return text;
}

/**
 * The entry as the JSON part shows it, as text; `before` only when asked for. One that wouldn't fit a
 * result keeps only its first target, with `targets-omitted` the count left out: a snapshot is at most
 * SNAPSHOT_MAX_BYTES, so the snapshot itself always fits whole.
 */
function entryJson(row: AuditRow, withBefore: boolean): string {
  const targets = targetsOf(row);
  const json = (shown: AffectedTarget[]) =>
    JSON.stringify({
      id: row.id,
      at: new Date(row.at).toISOString(),
      tool: row.tool,
      status: row.status,
      dry_run: row.dryRun,
      reason: row.reason,
      client: row.client,
      session: row.session,
      addressed: addressedOf(row),
      targets: shown,
      ...(shown.length < targets.length ? { "targets-omitted": targets.length - shown.length } : {}),
      error: row.error,
      ...(withBefore ? { before: parseJson(row.before) } : {}),
    });
  const whole = json(targets);
  return whole.length <= RESULT_CHAR_LIMIT - RESULT_RESERVE ? whole : json(targets.slice(0, 1));
}

/** The JSON part: the entries' JSON texts, the cursor and the rows scanned. */
function listingJson(entries: string[], nextCursor: string | null, scanned: number): string {
  return `{"entries":[${entries.join(",")}],"next-cursor":${JSON.stringify(nextCursor)},"scanned":${scanned}}`;
}

export function registerActivityLogTool(server: McpServer, { log, access, timeZone }: ActivityLogDeps): void {
  server.registerTool(
    "get_activity_log",
    {
      description:
        "What was changed in this graph through the connector: the audit log of every write, move and delete call, including refused and failed calls and dry runs, newest first. " +
        "One line per entry with its time (in the owner's time zone), tool, outcome, the first block or page it touched as page > breadcrumb > snippet, and its reason; then the entries as JSON. " +
        `Defaults to the last 7 days, so one call answers "what did you change this week". A pending entry is shown as outcome unknown: its write may or may not have been applied.`,
      inputSchema: z.object({
        graph: z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION),
        since: z
          .string()
          .optional()
          .describe(
            "Start of the window: YYYY-MM-DD (that day's start) or an ISO datetime, in the owner's time zone unless it has Z or an offset. Default: 7 days before until.",
          ),
        until: z
          .string()
          .optional()
          .describe(`End of the window, exclusive: YYYY-MM-DD (includes that day) or an ISO datetime. Default: now. A window is at most ${MAX_WINDOW_DAYS} days.`),
        page: z
          .string()
          .optional()
          .describe("Only entries that touched or named this page, refused and failed calls included: its UUID or its exact title, ignoring case (not a prefix)."),
        tool: z.string().optional().describe("Only entries for this tool, e.g. delete_blocks."),
        session: z.string().optional().describe("Only entries from this MCP session id."),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("Only entries with this outcome: ok (applied writes, no dry runs), error, refused, pending (outcome unknown) or dry-run (every dry run)."),
        include_snapshot: z
          .boolean()
          .optional()
          .describe("Add each entry's before: what an update, move, property change or delete overwrote, as read just before the write. Default false."),
        id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("One entry by its audit entry id (from a write's Logged as audit entry <id>), with its snapshot. The other inputs are ignored."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Most entries returned (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`),
        cursor: z.string().optional().describe("The previous result's next-cursor, for older entries in the same window. next-cursor is null at the end."),
      }),
      annotations: annotationsFor("get_activity_log"),
    },
    (args) =>
      runTool("get_activity_log", args.graph, async () => {
        const alias = args.graph;
        const { graphId } = await resolveGraph(access, alias, false);

        if (args.id !== undefined) {
          const { row, rowsRead } = await log.lookup(graphId, args.id);
          await log.recordRead(graphId, alias, [`id:${args.id}`], rowsRead);
          if (row === null || row.kind !== "write") throw new ToolError(`id ${args.id}: no such entry for graph ${alias}`, "refused");
          const text = `Audit log entry ${row.id} of graph '${alias}' (times in ${timeZone}):\n- ${entryLine(row, timeZone)}`;
          return {
            content: [
              { type: "text", text },
              { type: "text", text: listingJson([entryJson(row, true)], null, 1) },
            ],
          };
        }

        const { since, until } = windowOf(args, timeZone, Date.now());
        const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);
        const page = await log.query(graphId, {
          since,
          until,
          page: args.page,
          tool: args.tool,
          session: args.session,
          status: args.status,
          limit: args.limit ?? DEFAULT_LIMIT,
          cursor,
          includeSnapshot: args.include_snapshot === true,
        });
        await log.recordRead(graphId, alias, [`${new Date(since).toISOString()}/${new Date(until).toISOString()}`], page.rowsRead);

        // Entries are kept, newest first, while the result fits; the rest follow from the last one kept.
        const entryLines = page.entries.map((row) => `- ${entryLine(row, timeZone)}`);
        const entryTexts = page.entries.map((row) => entryJson(row, args.include_snapshot === true));
        let kept = 0;
        let used = RESULT_RESERVE;
        while (kept < page.entries.length) {
          const size = entryLines[kept].length + 1 + entryTexts[kept].length + 1;
          if (kept > 0 && used + size > RESULT_CHAR_LIMIT) break;
          used += size;
          kept += 1;
        }
        const last = page.entries[kept - 1];
        const next = kept < page.entries.length ? { at: last.at, id: last.id } : page.nextCursor;
        const nextCursor = next === null ? null : encodeCursor(next);

        const header =
          `Activity log of graph '${alias}', ${formatWhen(since, timeZone)} to ${formatWhen(until, timeZone)} (${timeZone}), newest first: ` +
          (kept === 0 ? "No entries" : `${kept} ${kept === 1 ? "entry" : "entries"}`) +
          (cursor === undefined ? "." : " after the cursor.");
        const lines = [header, ...entryLines.slice(0, kept)];
        if (nextCursor !== null) lines.push(`Older entries in the window may follow: pass next-cursor as cursor (next-cursor: ${nextCursor}).`);
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            { type: "text", text: listingJson(entryTexts.slice(0, kept), nextCursor, page.scanned) },
          ],
        };
      }),
  );
}
