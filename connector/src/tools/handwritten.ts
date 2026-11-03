import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectorHostname } from "../config";
import { EXPIRY_WARN_DAYS, type GraphRecord, type GraphStore, daysUntilExpiry } from "../graphs";
import { runTool, textResult } from "./common";

/** Usage conventions (design §7), so Claude writes well-formed Logseq content. */
export const CONNECTOR_HELP = [
  "Address a graph by its alias from list_graphs; graphs marked read-only refuse every write.",
  "Prefer insert_block_tree for whole notes such as a meeting transcript: it writes a nested block tree in one call, and writes are rate-limited to about 20 per minute, so batch them.",
  "Link pages by writing [[Page]] in titles and block text (people, projects, topics).",
  "Create tasks and action items with create_task, never as TODO text.",
  "Add to today's journal with capture_to_today.",
  "Make flashcards by tagging each card block with the Card tag.",
  "Save files with save_document (text or base64) or save_file_from_url (a public https link), and read them back with read_file.",
  "List tools are paginated: pass the returned next-cursor as cursor to get the next page.",
].join(" ");

function expiryWarning(graph: GraphRecord, now: number, host: string): string | null {
  if (graph.expiresAt === null) return null;
  const days = daysUntilExpiry(graph.expiresAt, now);
  if (days <= 0) return `token expired — replace it at https://${host}/graphs`;
  if (days > EXPIRY_WARN_DAYS) return null;
  return `token expires in ${days} ${days === 1 ? "day" : "days"} — replace it at https://${host}/graphs`;
}

/** `list_graphs` and `connector_help`. Neither calls the sync server or returns anything secret. */
export function registerHandwrittenTools(server: McpServer, env: Env, store: GraphStore): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "list_graphs",
    {
      description:
        "List the connected Logseq graphs: the alias every other tool's `graph` argument takes, the Logseq graph name, read or write mode, and token expiry.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () =>
      runTool("list_graphs", undefined, async () => {
        const now = Date.now();
        const host = connectorHostname(env);
        const graphs = (await store.list()).map((graph) => ({
          alias: graph.alias,
          graphName: graph.graphName,
          mode: graph.mode,
          expiresAt: graph.expiresAt,
          expiryWarning: expiryWarning(graph, now, host),
        }));
        return textResult(JSON.stringify(graphs, null, 2));
      }),
  );

  server.registerTool(
    "connector_help",
    {
      description: "How to write well-formed Logseq content with these tools. Read it before writing to a graph.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => runTool("connector_help", undefined, async () => textResult(CONNECTOR_HELP)),
  );
}
