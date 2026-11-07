import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectorHostname } from "../config";
import { EXPIRY_WARN_DAYS, type GraphRecord, type GraphStore, daysUntilExpiry } from "../graphs";
import { runTool, textResult } from "./common";
import { annotationsFor } from "./spec.mjs";
import { SEMANTIC_HELP } from "./semantic-search";

/** Usage conventions (design §7), so Claude writes well-formed Logseq content. */
export const CONNECTOR_HELP = [
  "Address a graph by its alias from list_graphs; graphs marked read-only refuse every write.",
  "For a broad topic, an overview or 'what do I know about X', call kb_index first: one call lists the graph's pages grouped by class with their summaries and UUIDs, so you can pick the pages to read instead of searching keyword by keyword. Use search_graph for specific words.",
  "To see how a page is used, call get_page_backlinks: links in text, tagged objects and property values that point at it, with counts. For a periodic review, get_graph_health lists unused tags and properties, duplicate titles, pages without a summary or a tag, and property values that are not one of their property's own choices (mismatched-choice-values: another property's choice, also on a node property, or a choice the holder's tags don't allow).",
  "Start a new page with a first block that begins with **Summary:** and one or two sentences; kb_index shows it as the page's summary.",
  "To read a page, use get_page_outline: one call returns its tags, property values and whole block tree as markdown with [[links]] resolved. get_page and get_block return one entity's tags and property values; get_blocks returns them for up to 100 UUIDs in one call (view outline adds each one's tree).",
  "Writes are rate-limited to about 20 per minute, and a call counts once however much it writes, so batch: prefer insert_block_tree for whole notes such as a meeting transcript (a nested block tree in one call), batch_insert_block_trees to build or fill several pages in one call (each entry names a page by title, created when missing, or a target-id, with the page's own properties), batch_set_block_property to tag or set properties on many existing blocks, and delete_blocks and batch_move_blocks for up to 100 blocks at a time.",
  "Give new blocks their tags and properties as you insert them: every block tree node takes properties, e.g. {\"Tags\": [\"Person\"], \"user.property/email\": \"a@example.com\"}, keyed by property ident, UUID or exact title. Prefer idents, since a title can match a built-in property.",
  "Give a text, number or URL property its choices when you create it (create_property's choices), and change them with update_property: choices.add adds new ones after the existing ones, choices.update renames or re-icons one (a rename may take a title another rename in the same call gives up, in any order; renames that swap titles, or pass them round a longer cycle, are refused, so rename one to a spare title in a separate call first), and choices.order lists every choice once in the order the editor should show them, each by the title the call leaves it with (a choice added in the same call can be named by its title, and a title a rename frees and an add takes names the new choice). A title that is already a choice ignoring case, a number property's title that isn't a number and a URL property's that isn't a URL are refused, naming the entry. Each response lists the choices with their UUIDs. To turn a free-text property into a choice property, give update_property convert_values: true with the choices (choices.add in the same call): each text value becomes the choice it names, exactly or ignoring case, and text that matches no choice refuses the whole call and is listed; a property with a default value, or a text value with child blocks under it, is refused (deleting the value would delete them), and values cleared to the empty placeholder are left alone; run it with dry-run first to see the mapping. choices and convert_values are refused on E2EE graphs. A property with choices (closed values, such as Status) takes only one of its own choices that the block's tags allow: give its UUID, ident or title (matched ignoring case, and only among that property's choices, so another property's choice with the same title never matches), or a number (2 or \"2\") for a choice that is a number. A value that is not one of them is refused with the valid choices listed; get_property lists them. A node property given a title takes the page with that title, never another property's choice or value; one restricted to classes (tags) takes only an object with one of those tags, or with a tag extending one, and refuses anything else however it is given, by title, UUID, ident or db id; a title several pages share is refused with their UUIDs, so pass the UUID. A value the property doesn't take is refused, naming the property and the reason: a page for a text property, a page that isn't a journal for a date property (every item of a list is checked), a UUID for a text, URL or number property that isn't one of that property's own values (give the text, URL or number itself; a number property given a number, 3 or \"3\", stores that number, and refuses text that is not a finite number, such as \"NaN\" or \"Infinity\"), and anything but epoch milliseconds for a datetime property such as Deadline or Scheduled. A URL property given a URL stores it in a value block of the block's own, as the editor does, so deleting or editing another block with the same URL never changes it; it never uses a block whose text is the link. In batch_set_block_property and batch_insert_block_trees, tags an earlier entry gives a block or page count for the later entries for it; with isResetExistingValues, a list of tags replaces the block's tags and a single tag adds to them.",
  "Tools that overwrite or remove data (deletes, updates, property sets, refresh_refs and promote_page_to_tag) are marked destructive, so claude.ai asks before running them. batch_insert_block_trees is one of them, since an entry's properties replace the values an existing page or block already has.",
  "Give every write and delete a reason: one plain sentence, at most 200 characters, on why you are making the change (e.g. tidy duplicate notes from the Nov 5th standup). The owner sees it on the approval card and at the top of the result; it is never sent to or stored on the graph, and a longer one is refused.",
  "Name a page by its UUID, its title (exact, else the one page with that title ignoring case) or its journal date (YYYY-MM-DD, e.g. 2026-11-05 for Nov 5th, 2026): every page-id (refresh_refs' included), every target-id and create_task's page-id take any of them. Several pages matching (including a date that is also another page's title) is refused with an error naming each one's title and UUID, so pass the UUID of the one you mean; no match is refused naming what was tried; hidden and Recycle bin pages never match, and a selector never creates a page (batch_insert_block_trees's page and capture_to_today still create theirs). Titles and dates are refused on E2EE graphs; pass UUIDs there. dry-run any delete you name by title (delete_page with dry-run: true) and check the page it names before the real call.",
  "Give a block-targeted write a target-label naming its target as \"Page > parent > ... > block\" (e.g. Nov 5th, 2026 > Meeting > Agenda; a page target takes its title alone): insert_block_children, insert_block_tree, update_block, delete_block, set_block_property, delete_block_property and move_blocks (for its target-id) take target-label, each entry of batch_insert_block_trees, batch_move_blocks, batch_set_block_property and batch_delete_block_property takes one, and delete_blocks takes labels, parallel to block-ids. The label is checked against the real target, never used to find it: the page title must match in full, ignoring case, and each later segment must start the first line of the target or one of its parent blocks, ignoring case, with at least 3 characters (or the whole line when it is shorter); upper parent blocks may be left out, and a block whose first line is empty is named by its page and parent blocks alone. A batch_insert_block_trees page given as a date (2026-11-05) takes the journal's title (Nov 5th, 2026) as its label. If any label in a call doesn't fit, a mismatch writes nothing: the whole call is refused (409), naming each entry with what was given and what was found. target-label is refused on E2EE graphs.",
  "Batch writes apply every entry or none. Pass dry-run: true to check a large delete, move or insert first (move_blocks takes it too): it names each block the write would touch by page, breadcrumb and snippet, with its descendant and reference counts, a page's block count and first blocks, and the pages an insert would create, and changes nothing. Show the user that summary before the real call.",
  "Insert tools return the new blocks' UUIDs and a count (pass verbose: true to get their titles back), and name the target and each new top-level block by page, breadcrumb and snippet even without verbose.",
  "Write, move and delete results start with a plain summary of what changed: for each block, its page title, the breadcrumb of its parent blocks and its first line (for a move, where it was and where it is now). Show it to the user after a write. The JSON after it holds the same under affected and target; the summary lists the first 20 blocks of a section and says how many more the JSON holds. A delete names its blocks as they were before it ran, and fails with an error naming the UUID of any block still there afterwards; context: unavailable means the write was applied but could not be read back (a dry run whose context can't be read fails instead). A batch_insert_block_trees entry with no blocks is summarised as setting properties on its target, not as an insert.",
  "Link pages by writing [[Page]] in titles and block text (people, projects, topics).",
  "create_page and create_tag refuse a title that a page, journal, tag or property already uses (ignoring case) and name it with its UUID, so create without searching first and use the named one when refused; when create_tag is refused because a page has the title, promote_page_to_tag converts that page, keeping its blocks and references. Setting a page's tags to Tag is refused; use promote_page_to_tag instead. The other built-in type tags (Journal, Whiteboard, PDF Annotation, Property, Asset) are set by Logseq itself, so adding one as a tags value is refused with a 400 naming the entry and the tag; sending back one the entity already holds is fine. A tags list replaces only user tags: Page, Tag, Journal and the other built-in type tags an entity holds are kept, so a page given [\"Food\"] stays a page tagged Food.",
  "Set up a tag in one call: create_tag takes extends (the tags it extends) and properties (its tag properties). update_tag changes them later: properties.add or properties.remove changes only the properties listed and keeps the tag's others, properties.set replaces its own properties (built-in ones stay), and extends replaces the tags it extends; a tag can't extend itself, a tag that already extends it, or a built-in tag the app hides from its extends picker (Tag, Page, Journal, Property, Query, Template and the like).",
  "delete_page, delete_tag and delete_property refuse while the delete would lose references, tag holders, child tags or property values, and say which acknowledge-* flag to pass, and update_property's choices.retire refuses while blocks hold a choice it retires, or the choice is the property's default value, unless acknowledge-holders is true; pass dry-run to see the counts first, and only acknowledge a loss the user agreed to.",
  "Tag a block with an existing tag by writing #Tag or #[[Multi Word Tag]] in its title. Any other # that Logseq would read as a tag, such as an issue number or an unknown name, is stored escaped (\\#) so it stays text, and the write's response lists those tags under escaped; create the tag first with create_tag if you want it. refresh_refs applies the same handling to blocks written before it existed.",
  "Make a block a heading by starting its title with # to ###### and a space (## Section), in update_block, create_task or any insert tool: it is stored as the app stores a heading, the title without the prefix and the level in logseq.property/heading, which get_block and get_blocks show as a property and get_page_outline shows as the ## prefix (list_page_blocks titles don't show it). update_block with a title that has no prefix keeps the block's heading. A code, math or quote block (one with a display type) keeps its title as given, # lines included, with no heading. Seven or more #, or # with nothing after it, is not a heading and stays as text (the first # stored escaped as \\#).",
  "Create tasks and action items with create_task, never as TODO text.",
  "Add to today's journal with capture_to_today. Today is the date in the owner's time zone, which the sync server is configured with (timeZone in config/settings.json, for example Pacific/Auckland; UTC when unset), not the server's UTC clock. capture_to_today, create_task with no page-id, and save_document and save_file_from_url with no page all use it, and their results name the journal they wrote to (page-id and page-title, or pageId and pageTitle). capture_to_today always writes to today and takes no page; to write to another day's journal, use insert_block_tree with that journal's date (YYYY-MM-DD) or UUID as target-id, create_task with page-id, or save_document or save_file_from_url with page. delete_page on today's journal (in the same time zone) clears its blocks and keeps the page, as the app does, and says so (truncated: true, with cleared, the number of blocks deleted; the summary starts Cleared today's journal); any other journal moves to the Recycle bin with its blocks.",
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

  server.registerTool(
    "list_graphs",
    {
      description:
        "List the connected Logseq graphs: the alias every other tool's `graph` argument takes, the Logseq graph name, read or write mode, and token expiry.",
      inputSchema: z.object({}),
      annotations: annotationsFor("list_graphs"),
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
      annotations: annotationsFor("connector_help"),
    },
    () => runTool("connector_help", undefined, async () => textResult(help)),
  );
}
