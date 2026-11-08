import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RESULT_CHAR_LIMIT, ToolError, capResult } from "./common";

// What a write tool call says about itself: the caller's `reason` and the targets the server names in
// its response, turned into a plain-text summary that leads the result (spec section 3.7,
// docs/superpowers/specs/2026-11-07-readable-tool-calls-reason-targets-design.md). Item 28 (audit
// log) consumes the same `WriteOutcome` through `onSuccess`. Nothing here fetches.

/** The longest `reason` accepted, in characters (code points). A longer one is refused, not cut. */
export const REASON_MAX = 200;

/** The optional `reason` argument every non-read tool takes. It is never sent to the sync server. */
export const reasonSchema = z
  .string()
  .optional()
  .describe(
    `One plain sentence on why (at most ${REASON_MAX} characters); shown with the result, never sent to the graph.`,
  );

/** Where a moved block was (`from`) or is now (`to`). */
export interface TargetLocation {
  pageUuid?: string;
  pageTitle?: string;
  breadcrumb: string[];
}

/**
 * One block or page a write touched, as the server names it in a `BlockContext` (patch 0028).
 * `role` is "target" for what the write wrote to or under (an insert's parent, a property write's
 * block) and "affected" for a block it deleted, moved or inserted. On an E2EE graph titles and text
 * are encrypted, so `pageTitle`, `breadcrumb` and `snippet` are empty and `e2ee` is true.
 */
export interface AffectedTarget {
  uuid: string;
  kind: string;
  role: "target" | "affected";
  pageUuid?: string;
  pageTitle?: string;
  breadcrumb: string[];
  snippet?: string;
  descendants?: number;
  /** Delete dry runs: how many blocks and pages the delete leaves refer to it (or a block under it). */
  references?: number;
  /** delete_page dry run: the blocks on the page. */
  blocks?: number;
  /** delete_page dry run: the first line of each of its first three top-level blocks. */
  roots?: string[];
  /** batch_insert_block_trees dry run, on an entry's target: the entry would create this page. */
  wouldCreate?: boolean;
  /** batch_insert_block_trees, on an entry's target: the entry inserts no blocks, only sets its properties. */
  propertiesOnly?: boolean;
  from?: TargetLocation;
  to?: TargetLocation;
  e2ee?: boolean;
}

/**
 * The write tools whose responses name what they touched, with the verb a summary uses ([past,
 * present]). Every non-read tool is in exactly one of `CONTEXT_TOOLS` and `NO_CONTEXT_TOOLS`; a test
 * over the manifest holds that (`contextClassFor`), so a new write tool can't ship without a decision.
 */
export const CONTEXT_TOOLS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  delete_block: ["Deleted", "delete"],
  delete_blocks: ["Deleted", "delete"],
  delete_page: ["Deleted", "delete"],
  move_blocks: ["Moved", "move"],
  batch_move_blocks: ["Moved", "move"],
  insert_block_children: ["Inserted", "insert"],
  insert_block_tree: ["Inserted", "insert"],
  batch_insert_block_trees: ["Inserted", "insert"],
  capture_to_today: ["Inserted", "insert"],
  create_task: ["Created", "create"],
  update_block: ["Updated", "update"],
  set_block_property: ["Set a property on", "set a property on"],
  delete_block_property: ["Removed a property from", "remove a property from"],
  batch_set_block_property: ["Set properties on", "set properties on"],
  batch_delete_block_property: ["Removed properties from", "remove properties from"],
});

/** The write tools whose responses add no context, each with the reason. */
export const NO_CONTEXT_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  create_page: "the response already names the page by title",
  update_page: "the response already names the page by title",
  create_tag: "the response already names the tag by title",
  update_tag: "the response already names the tag by title",
  delete_tag: "the dry run and refusal already name the tag; deletes of tags are not block writes",
  promote_page_to_tag: "the response already names the page and tag by title",
  create_property: "the response already names the property by title",
  update_property: "the response already names the property by title",
  delete_property: "the dry run and refusal already name the property; deletes of properties are not block writes",
  refresh_refs: "the response already lists each changed block's text before and after",
  save_document: "the response already names the asset and its journal or page",
  save_file_from_url: "the response already names the asset and its journal or page",
});

/** Whether a write tool's response names what it touched. Throws for a tool in neither table. */
export function contextClassFor(name: string): "context" | "no-context" {
  if (Object.hasOwn(CONTEXT_TOOLS, name)) return "context";
  if (Object.hasOwn(NO_CONTEXT_TOOLS, name)) return "no-context";
  throw new Error(`no context class for write tool ${name}: add it to CONTEXT_TOOLS or NO_CONTEXT_TOOLS`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function location(value: unknown): TargetLocation | undefined {
  const loc = record(value);
  if (!loc) return undefined;
  const page = record(loc.page);
  return { pageUuid: text(page?.uuid), pageTitle: text(page?.title), breadcrumb: strings(loc.breadcrumb) };
}

function target(value: unknown, role: AffectedTarget["role"]): AffectedTarget | undefined {
  const ctx = record(value);
  if (!ctx || typeof ctx.uuid !== "string") return undefined;
  const page = record(ctx.page);
  const out: AffectedTarget = { uuid: ctx.uuid, kind: text(ctx.kind) ?? "block", role, breadcrumb: strings(ctx.breadcrumb) };
  if (typeof page?.uuid === "string") out.pageUuid = page.uuid;
  if (typeof page?.title === "string") out.pageTitle = page.title;
  if (typeof ctx.snippet === "string") out.snippet = ctx.snippet;
  if (typeof ctx.descendants === "number") out.descendants = ctx.descendants;
  if (typeof ctx.references === "number") out.references = ctx.references;
  if (typeof ctx.blocks === "number") out.blocks = ctx.blocks;
  if (Array.isArray(ctx.roots)) out.roots = strings(ctx.roots);
  if (ctx.from !== undefined) out.from = location(ctx.from);
  if (ctx.to !== undefined) out.to = location(ctx.to);
  if (ctx.e2ee === true) out.e2ee = true;
  return out;
}

/**
 * The targets a write's response names, in order: each `target`, then each `affected` entry, at the
 * top level and in each of `entries` (batch inserts). Anything that is not a `BlockContext` with a
 * UUID is skipped, so a response without context gives [].
 */
export function toAffectedTargets(response: unknown): AffectedTarget[] {
  const out: AffectedTarget[] = [];
  const collect = (holder: Record<string, unknown> | undefined) => {
    if (!holder) return;
    const t = target(holder.target, "target");
    if (t && holder["would-create"] === true) t.wouldCreate = true;
    // An insert entry answers affected, its new top-level blocks, even when it inserts none.
    if (t && Array.isArray(holder.affected) && holder.affected.length === 0) t.propertiesOnly = true;
    if (t) out.push(t);
    if (Array.isArray(holder.affected)) {
      for (const item of holder.affected) {
        const a = target(item, "affected");
        if (a) out.push(a);
      }
    }
  };
  const top = record(response);
  collect(top);
  if (Array.isArray(top?.entries)) for (const entry of top.entries) collect(record(entry));
  return out;
}

/** What `onSuccess` learns about an accepted write. `targets` is empty until the server names them. */
export interface WriteOutcome {
  reason?: string;
  targets: AffectedTarget[];
}

/** Runs after each call the server accepted; `outcome` is given for writes only. */
export type OnSuccess = (tool: string, alias: string, outcome?: WriteOutcome) => void;

/** True when the arguments carry a `reason` worth logging as given (not empty or only spaces). */
export function reasonGiven(args: unknown): boolean {
  const reason = (args as { reason?: unknown } | undefined)?.reason;
  return reason !== undefined && !(typeof reason === "string" && reason.trim() === "");
}

/**
 * Splits `reason` from a write's arguments. Returns the trimmed reason (undefined when absent, empty
 * or only spaces) and a copy of the arguments without it, which is all the tool's handler may see.
 * Throws a `ToolError` for a reason that is not a string or is longer than `REASON_MAX` characters.
 */
export function takeReason<A extends Record<string, unknown>>(args: A): { reason: string | undefined; rest: Omit<A, "reason"> } {
  const { reason: given, ...rest } = args;
  if (given === undefined) return { reason: undefined, rest };
  if (typeof given !== "string") {
    throw new ToolError(`reason must be a string of at most ${REASON_MAX} characters`, "refused");
  }
  const reason = given.trim();
  const length = [...reason].length;
  if (length > REASON_MAX) {
    throw new ToolError(`reason is ${length} characters; at most ${REASON_MAX} are accepted — shorten it`, "refused");
  }
  return { reason: reason === "" ? undefined : reason, rest };
}

/** Options for `summarise`: the tool (for its verb), the caller's reason and what the server said. */
export interface SummaryOptions {
  tool?: string;
  reason?: string;
  /** The response was a dry run: nothing changed. */
  dryRun?: boolean;
  /** The write was applied but the server could not read what it touched; the server's reason. */
  unavailable?: string;
  /** delete_page on today's journal: its blocks are (or would be) deleted and the page kept. */
  truncated?: { cleared?: number };
}

const E2EE_NOTE = "titles unavailable on an E2EE graph";

/** The most blocks one section of a summary lists; the JSON result after it holds them all. */
export const SUMMARY_MAX_ITEMS = 20;

/** The longest page title a summary shows, in code points: the server cuts snippets and breadcrumbs to the same. */
const TITLE_MAX = 80;

function shortTitle(title: string | undefined): string {
  if (title === undefined) return "?";
  const chars = [...title];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join("") : title;
}

/** `segments` joined with " > ", keeping the first and last two when there are more than four. */
function path(segments: string[]): string {
  const shown = segments.length > 4 ? [segments[0], "…", ...segments.slice(-2)] : segments;
  return shown.join(" > ");
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** The counts a line ends with, e.g. " (+3 children, 2 references)"; empty when there are none. */
function counts(t: AffectedTarget): string {
  const parts: string[] = [];
  if (t.descendants !== undefined) parts.push(`+${count(t.descendants, "child", "children")}`);
  if (t.blocks !== undefined) parts.push(count(t.blocks, "block", "blocks"));
  if (t.references !== undefined) parts.push(count(t.references, "reference", "references"));
  const roots = t.roots && t.roots.length > 0 ? `; first blocks: ${t.roots.map((r) => `"${r}"`).join(", ")}` : "";
  return parts.length > 0 || roots ? ` (${parts.join(", ")}${roots})` : "";
}

function where(loc: TargetLocation | undefined): string {
  if (!loc) return "(not read)";
  return path([shortTitle(loc.pageTitle), ...loc.breadcrumb]);
}

/** One target as a summary line shows it: page > breadcrumb > "snippet" (counts), or a move's from and to. */
export function targetLine(t: AffectedTarget): string {
  if (t.e2ee) return `${t.kind} ${t.uuid}${counts(t)}`;
  const quoted = `"${t.snippet ?? ""}"`;
  if (t.from !== undefined || t.to !== undefined) return `${quoted} from ${where(t.from)} to ${where(t.to)}`;
  if (t.kind === "page" || t.kind === "journal") return `${t.kind} ${quoted}${counts(t)}`;
  return `${path([shortTitle(t.pageTitle), ...t.breadcrumb, quoted])}${counts(t)}`;
}

/**
 * The plain-text summary that leads a write's result: one line per block or page the write deleted,
 * moved or inserted (or, when it names none and is not an insert, per block it wrote to; a batch
 * insert entry with no blocks is listed under "Set properties on", and today's journal under
 * "Cleared today's journal" since its page is kept), each as page > breadcrumb >
 * "snippet" with the middle of a long path elided and a page title cut to 80 characters, at most
 * `SUMMARY_MAX_ITEMS` per section with a line saying how many more the JSON holds, and the counts the server gave (descendants, and
 * on a dry run references, a page's blocks and its first blocks); on a dry run, a line per page an
 * insert would create; then a line when the context could not be read; then `Reason: …`. Empty when
 * there is nothing to say. Only what the server returned is shown, so nothing here fetches.
 */
export function summarise(targets: AffectedTarget[], opts: SummaryOptions): string {
  const lines: string[] = [];
  const [past, present] = (opts.tool !== undefined && CONTEXT_TOOLS[opts.tool]) || ["Changed", "change"];
  const affected = targets.filter((t) => t.role === "affected");
  // An insert's targets are where it wrote, not what it inserted, so only other writes fall back to them.
  const shown = affected.length > 0 || present === "insert" ? affected : targets;
  // Insert entries that only set properties on their target say so, rather than count as inserts.
  const propertied = targets.filter((t) => t.propertiesOnly);
  // A long batch lists its first blocks only: the JSON result after the summary names every one.
  const list = (items: AffectedTarget[]) => {
    for (const t of items.slice(0, SUMMARY_MAX_ITEMS)) lines.push(`- ${targetLine(t)}`);
    if (items.length > SUMMARY_MAX_ITEMS) lines.push(`- … and ${items.length - SUMMARY_MAX_ITEMS} more, listed in the JSON result`);
  };
  const section = (items: AffectedTarget[], pastVerb: string, presentVerb: string, first: boolean) => {
    if (items.length === 0) return;
    const pages = items.every((t) => t.kind === "page" || t.kind === "journal");
    const noun = `${pages ? "page" : "block"}${items.length === 1 ? "" : "s"}`;
    const verb = opts.dryRun ? `${first ? "Dry run, nothing changed: would" : "Would"} ${presentVerb}` : pastVerb;
    lines.push(`${verb} ${items.length} ${noun}${items.some((t) => t.e2ee) ? ` (${E2EE_NOTE})` : ""}:`);
    list(items);
  };
  if (opts.truncated !== undefined && shown.length > 0) {
    // Today's journal: Logseq deletes its blocks and keeps the page.
    const cleared = opts.truncated.cleared;
    lines.push(
      opts.dryRun
        ? "Dry run, nothing changed: would clear today's journal, deleting its blocks and keeping the page:"
        : `Cleared today's journal: ${cleared === undefined ? "its blocks were" : `${count(cleared, "block was", "blocks were")}`} deleted and the page kept:`,
    );
    list(shown);
  } else {
    section(shown, past, present, true);
  }
  section(propertied, "Set properties on", "set properties on", shown.length === 0);
  // Only a dry run's entries carry would-create; a real insert says created instead.
  for (const t of targets.filter((t) => t.wouldCreate)) lines.push(`Would create page "${t.pageTitle ?? t.uuid}".`);
  if (opts.unavailable !== undefined) {
    // A dry run changes nothing, whether or not its context could be read.
    lines.push(`Context unavailable (${opts.unavailable || "no reason given"}); ${opts.dryRun ? "nothing was changed" : "the write was applied"}.`);
  }
  if (opts.reason !== undefined) lines.push(`Reason: ${opts.reason}`);
  return lines.join("\n");
}

/** The JSON a generated tool's result carries in its first text item, or undefined. */
export function resultJson(result: CallToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  try {
    return JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

/**
 * A write's targets and summary, from its result. Whatever context the response carries is read, so
 * nothing here can fail a call after its write; a tool in `NO_CONTEXT_TOOLS` simply names none.
 */
export function describeWrite(tool: string, result: CallToolResult, reason: string | undefined): { targets: AffectedTarget[]; summary: string } {
  const response = record(resultJson(result));
  const targets = toAffectedTargets(response);
  const unavailable = response?.context === "unavailable" ? (text(response["context-reason"]) ?? "") : undefined;
  const truncated = response?.truncated === true ? { cleared: typeof response.cleared === "number" ? response.cleared : undefined } : undefined;
  return { targets, summary: summarise(targets, { tool, reason, dryRun: response?.["dry-run"] === true, unavailable, truncated }) };
}

/** `result` with `summary` as its first content item, or unchanged when the summary is empty. */
export function withSummary(result: CallToolResult, summary: string): CallToolResult {
  if (summary === "") return result;
  return { ...result, content: [{ type: "text", text: summary }, ...result.content] };
}

function compact(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * A write's result (summary first, then the server's JSON) cut to `RESULT_CHAR_LIMIT` characters.
 * Over the cap, the JSON is first written without indentation. The write was applied, so the read path's "request less" never applies: when the JSON alone fits,
 * the summary is cut before its last line (the audit entry line) and the JSON kept whole; otherwise the summary is kept and the JSON cut with a
 * notice that says the write was applied.
 */
export function capWriteResult(given: CallToolResult): CallToolResult {
  const size = (r: CallToolResult) => r.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
  if (size(given) <= RESULT_CHAR_LIMIT) return given;
  // Over the cap, the JSON drops its indentation first: a 100-block move's is a fifth spaces.
  const result = { ...given, content: given.content.map((c, i) => (i > 0 && c.type === "text" ? { ...c, text: compact(c.text) } : c)) };
  const total = size(result);
  if (total <= RESULT_CHAR_LIMIT) return result;
  const [first, ...rest] = result.content;
  const cut = "\n\n[summary cut: the write was applied; the JSON result below is complete]";
  const budget = RESULT_CHAR_LIMIT - (total - (first?.type === "text" ? first.text.length : 0)) - cut.length;
  if (first?.type === "text" && budget >= 0) {
    // The summary's last line (Logged as audit entry <id>) is kept: the middle is cut, not the end.
    const end = first.text.lastIndexOf("\n");
    const last = end >= 0 ? first.text.slice(end) : "";
    const keep = last.length <= budget ? last : "";
    return { ...result, content: [{ ...first, text: first.text.slice(0, budget - keep.length) + cut + keep }, ...rest] };
  }
  return capResult(
    result,
    (n) => `\n\n[truncated: the write was applied; its result had ${n} characters and the limit is ${RESULT_CHAR_LIMIT}, so the JSON is cut. Read the pages it names to see the outcome.]`,
  );
}
