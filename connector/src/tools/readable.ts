import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ToolError } from "./common";

// What a write tool call says about itself: the caller's `reason` and, from Stage 3 of the readable
// tool calls plan, the targets the server names in its response (spec section 3.7,
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

/** One block or page a write touched, as the server names it (filled from Stage 3). */
export interface AffectedTarget {
  uuid: string;
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

/** The plain-text summary that leads a write's result: for now only `Reason: …`, or nothing. */
export function summarise(_targets: AffectedTarget[], opts: { reason?: string }): string {
  return opts.reason === undefined ? "" : `Reason: ${opts.reason}`;
}

/** `result` with `summary` as its first content item, or unchanged when the summary is empty. */
export function withSummary(result: CallToolResult, summary: string): CallToolResult {
  if (summary === "") return result;
  return { ...result, content: [{ type: "text", text: summary }, ...result.content] };
}
