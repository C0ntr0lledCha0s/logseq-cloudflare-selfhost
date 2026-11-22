// get_sync_status (spec docs/superpowers/specs/2026-11-20-blank-blocks-and-sync-status-design.md
// §3.3, §4, §6): one read-only call that answers where a graph's sync log stands (patch 0055's
// getSyncStatus, one sync request) and how far behind the semantic index is (two D1 reads, only when
// semantic search is configured). It copies the route's fields by name, never the whole answer, so
// nothing the route did not promise (an email, a user id, a block UUID) can reach Claude.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuditContext } from "../audit/log";
import { type SemanticStatusPart, semanticStatusPart } from "../semantic/status";
import type { SemanticStore } from "../semantic/store";
import { ToolError, lookupGraph, resolveGraph, runTool, textResult, withCallGraphs } from "./common";
import type { OnSuccess } from "./readable";
import { type GraphAccess, graphFetch } from "./semantic";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";

const TOOL = "get_sync_status";

/** `semantic-note` when semantic search is off on this connector. */
export const SEMANTIC_NOTE = "semantic search not configured";

/** connector_help's status entry (spec §4, text to update in PR 1). */
export const SYNC_STATUS_HELP =
  "To see whether a graph is up to date, call get_sync_status: one read-only call answers its latest sync t, when and how it was last written, its block and page counts (as list_pages and list_page_blocks show them), the app's connected clients as counts only (connected, users, own, others, editing; presence carries no device or client kind, so it can't say desktop or mobile, and names no user or block) and, where semantic search is configured, the index's state with behind-by: how many sync transactions the semantic index has not seen yet (negative when the index is ahead of the log, as after a graph reset; null when unknown).";

export const SYNC_STATUS_DESCRIPTION =
  "Read-only; changes nothing. Returns graph; t (the latest sync transaction); last-written-at (ISO) and last-op (such as delete-blocks), both of the transaction at t and null when the log holds no row for it; block-count and page-count (what list_pages and list_page_blocks show: no hidden pages, Recycle bin or Private content), with counts-include-private true on E2EE graphs, where Private can't be recognised; e2ee; checksum (as stored, never recomputed, or null); and clients, counts only: connected (the app's live connections that identified a user; API calls are not connections), users (distinct users), own and others (yours and everyone else's connections; null when unknown) and editing (connections editing a block). No user, email, device or block is named, and presence carries no device or client kind, so it can't say desktop or mobile. semantic is the semantic index's state: status, indexed-blocks, indexed-at, index-t (the sync t its last complete listing reached) and behind-by (t minus index-t: sync transactions the index has not seen yet; null when either is unknown; negative when the index is ahead of the log, as after a graph reset), and error. Without semantic search, semantic is null and semantic-note says so. A field the sync server did not return is null.";

/** The route's answer, as the tool copies it. */
interface SyncFields {
  t: number | null;
  "last-written-at": string | null;
  "last-op": string | null;
  "block-count": number | null;
  "page-count": number | null;
  "counts-include-private": boolean | null;
  e2ee: boolean | null;
  checksum: string | null;
  clients: {
    connected: number | null;
    users: number | null;
    own: number | null;
    others: number | null;
    editing: number | null;
  } | null;
}

type Check = (value: unknown) => boolean;
const integer: Check = (v) => Number.isInteger(v);
const count: Check = (v) => Number.isInteger(v) && (v as number) >= 0;
const string: Check = (v) => typeof v === "string";
const boolean: Check = (v) => typeof v === "boolean";

/** `body[key]` when it passes `check`; null when absent or null; otherwise the call fails naming the field. */
function field<T>(body: Record<string, unknown>, key: string, check: Check, path = key): T | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!check(value)) throw new ToolError(`getSyncStatus returned an invalid ${path}`, "bad-response");
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The named fields of a getSyncStatus answer, in spec §4's order; nothing else is copied. */
export function syncFields(body: unknown): SyncFields {
  if (!isRecord(body)) throw new ToolError("getSyncStatus returned no object", "bad-response");
  const clients = body.clients;
  if (clients !== undefined && clients !== null && !isRecord(clients)) {
    throw new ToolError("getSyncStatus returned an invalid clients", "bad-response");
  }
  return {
    t: field(body, "t", integer),
    "last-written-at": field(body, "last-written-at", string),
    "last-op": field(body, "last-op", string),
    "block-count": field(body, "block-count", count),
    "page-count": field(body, "page-count", count),
    "counts-include-private": field(body, "counts-include-private", boolean),
    e2ee: field(body, "e2ee", boolean),
    checksum: field(body, "checksum", string),
    clients: isRecord(clients)
      ? {
          connected: field(clients, "connected", count, "clients.connected"),
          users: field(clients, "users", count, "clients.users"),
          own: field(clients, "own", count, "clients.own"),
          others: field(clients, "others", count, "clients.others"),
          editing: field(clients, "editing", count, "clients.editing"),
        }
      : null,
  };
}

/**
 * Registers get_sync_status, with or without semantic search (`semantic` null when it is off). Each
 * call leaves one `kind = 'read'` audit row (2 rows written), `ok` or `error`.
 */
export function registerSyncStatusTool(
  server: McpServer,
  access: GraphAccess,
  semantic: { store: SemanticStore } | null,
  onSuccess: OnSuccess,
  audit: AuditContext,
): void {
  server.registerTool(
    TOOL,
    {
      description: SYNC_STATUS_DESCRIPTION,
      inputSchema: z.object({ graph: z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION) }),
      annotations: annotationsFor(TOOL),
    },
    ({ graph: alias }) =>
      runTool(TOOL, alias, () =>
        withCallGraphs(async () => {
          let status: "ok" | "error" = "error";
          try {
            const graph = await resolveGraph(access, alias, false);
            const response = await graphFetch(access, alias, graph.pat, {
              method: "GET",
              path: `/api/v1/graphs/${encodeURIComponent(graph.graphId)}/sync-status`,
            });
            const sync = syncFields(await response.json());
            const part: SemanticStatusPart | null = semantic ? await semanticStatusPart(semantic.store, graph.graphId, sync.t) : null;
            const answer = { graph: alias, ...sync, semantic: part, ...(semantic ? {} : { "semantic-note": SEMANTIC_NOTE }) };
            status = "ok";
            onSuccess(TOOL, alias);
            return textResult(JSON.stringify(answer, null, 2));
          } finally {
            // The graph was looked up once for this call (withCallGraphs), so its id costs no D1 read.
            try {
              const graphId = (await lookupGraph(access, alias))?.graphId ?? null;
              await audit.log.recordRead(TOOL, status, graphId, alias, [], 0);
            } catch (error) {
              console.error(`audit-read-failed tool=${TOOL} graph=${alias} ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }),
      ),
  );
}
