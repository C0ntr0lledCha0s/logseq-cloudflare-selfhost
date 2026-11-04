import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectorHostname } from "../config";
import { EXPIRY_WARN_DAYS, type GraphRecord, type GraphStore, daysUntilExpiry } from "../graphs";
import { runTool, textResult } from "./common";
import { SEMANTIC_HELP } from "./semantic-search";

/** Usage conventions (design §7), so Claude writes well-formed Logseq content. */
export const CONNECTOR_HELP = [
  "Address a graph by its alias from list_graphs; graphs marked read-only refuse every write.",
  "For a broad topic, an overview or 'what do I know about X', call kb_index first: one call lists the graph's pages grouped by class with their summaries and UUIDs, so you can pick the pages to read instead of searching keyword by keyword. Use search_graph for specific words.",
  "To see how a page is used, call get_page_backlinks: links in text, tagged objects and property values that point at it, with counts. For a periodic review, get_graph_health lists unused tags and properties, duplicate titles, and pages without a summary or a tag.",
  "Start a new page with a first block that begins with **Summary:** and one or two sentences; kb_index shows it as the page's summary.",
  "To read a page, use get_page_outline: one call returns its tags, property values and whole block tree as markdown with [[links]] resolved. get_page and get_block return one entity's tags and property values; get_blocks returns them for up to 100 UUIDs in one call (view outline adds each one's tree).",
  "Writes are rate-limited to about 20 per minute, and a call counts once however much it writes, so batch: prefer insert_block_tree for whole notes such as a meeting transcript (a nested block tree in one call), batch_insert_block_trees to build or fill several pages in one call (each entry names a page by title, created when missing, or a target-id, with the page's own properties), batch_set_block_property to tag or set properties on many existing blocks, and delete_blocks and batch_move_blocks for up to 100 blocks at a time.",
  "Give new blocks their tags and properties as you insert them: every block tree node takes properties, e.g. {\"Tags\": [\"Person\"], \"user.property/email\": \"a@example.com\"}, keyed by property ident, UUID or exact title. Prefer idents, since a title can match a built-in property.",
  "Batch writes apply every entry or none. Pass dry-run: true to check a large delete, move or insert first: it reports what would change and changes nothing.",
  "Insert tools return only the new blocks' UUIDs and a count; pass verbose: true to get their titles back.",
  "Link pages by writing [[Page]] in titles and block text (people, projects, topics).",
  "create_page and create_tag refuse a title that a page, journal, tag or property already uses (ignoring case) and name it with its UUID, so create without searching first and use the named one when refused.",
  "delete_page, delete_tag and delete_property refuse while the delete would lose references, tag holders, child tags or property values, and say which acknowledge-* flag to pass; pass dry-run to see the counts first, and only acknowledge a loss the user agreed to.",
  "Tag a block with an existing tag by writing #Tag or #[[Multi Word Tag]] in its title. A name that is not an existing tag stays plain text, so create the tag first with create_tag.",
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

/**
 * `list_graphs` and `connector_help`. Neither calls the sync server or returns anything secret. The
 * help mentions semantic_search only when it is registered.
 */
export function registerHandwrittenTools(server: McpServer, env: Env, store: GraphStore, semantic: boolean): void {
  const help = semantic ? `${CONNECTOR_HELP} ${SEMANTIC_HELP}` : CONNECTOR_HELP;
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
    () => runTool("connector_help", undefined, async () => textResult(help)),
  );
}
