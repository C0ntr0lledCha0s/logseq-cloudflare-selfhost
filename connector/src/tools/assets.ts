import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ResolvedGraph } from "../graphs";
import { SafeFetchError, readUpTo, safeFetch } from "../net/safe-fetch";
import { RESULT_CHAR_LIMIT, ToolError, aliasArg, runTool, textResult } from "./common";
import { type GraphAccess, graphFetch, resolveGraph } from "./semantic";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION } from "./spec.mjs";

// The file tools replace the generated createAsset/getAsset (design §7). createAsset takes the raw
// bytes as `application/octet-stream` with their exact `size` and SHA-256 `checksum` as query
// parameters, and attaches the asset block to the page in its `page-id` parameter (a page UUID; when
// omitted the server appends it to today's journal). A page given by title is looked up by exact,
// case-insensitive title through searchGraph first. getAsset returns a five-minute signed URL whose
// origin is the request's, so read_file fetches its path and query over the SYNC binding.

/** Content types save_file_from_url accepts (global constraints). */
export const FILE_TYPES: readonly string[] = [
  "text/*",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/json",
  "application/vnd.openxmlformats-officedocument.*",
];
const MIB = 1024 * 1024;
export const URL_MAX_BYTES = 25 * MIB;
/** read_file returns images up to this size as image content, and describes larger ones. */
const IMAGE_MAX_BYTES = 5 * MIB;
/** claude.ai caps one tool argument at about the same size as one result. */
const ARGUMENT_CHAR_LIMIT = RESULT_CHAR_LIMIT;
/** UTF-8 needs at most 4 bytes per UTF-16 code unit, so this many bytes always fill a result. */
const TEXT_READ_BYTES = 4 * RESULT_CHAR_LIMIT;
/** Search result pages read while looking up a page title before asking for its UUID instead. */
const MAX_SEARCH_PAGES = 5;
const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UUID = new RegExp(UUID_PATTERN);

/** Media types of the asset types (file extensions) read_file returns as text or image content. */
const EXTENSION_TYPES: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  org: "text/plain",
  edn: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  xml: "text/xml",
  css: "text/css",
  yaml: "text/yaml",
  yml: "text/yaml",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const graphArg = z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION);
const pageArg = z
  .string()
  .min(1)
  .optional()
  .describe("Title or UUID of an existing page to attach the file to. Omit to add it to today's journal.");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new ToolError("base64 is not valid base64", "refused");
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function graphPath(graph: ResolvedGraph, rest: string): string {
  return `/api/v1/graphs/${encodeURIComponent(graph.graphId)}${rest}`;
}

/** The UUID of the page `page` names: itself if it is a UUID, else the page with exactly that title. */
async function pageIdFor(access: GraphAccess, alias: string, graph: ResolvedGraph, page: string): Promise<string> {
  if (UUID.test(page)) return page;
  const wanted = page.toLowerCase();
  const matches = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; n < MAX_SEARCH_PAGES; n += 1) {
    const response = await graphFetch(access, alias, graph.pat, {
      method: "GET",
      path: graphPath(graph, "/search"),
      query: { q: page, types: "blocks", limit: 200, ...(cursor === undefined ? {} : { cursor }) },
    });
    const body = (await response.json()) as {
      results: { uuid: string; kind: string; title: string }[];
      "next-cursor"?: string;
    };
    for (const result of body.results) {
      if (result.kind === "page" && result.title.toLowerCase() === wanted) matches.add(result.uuid);
    }
    cursor = body["next-cursor"];
    if (cursor === undefined) break;
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size > 1) throw new ToolError(`several pages are titled '${page}' — pass the page's UUID`, "refused");
  if (cursor !== undefined) {
    throw new ToolError(`too many search results to find page '${page}' — pass the page's UUID`, "refused");
  }
  throw new ToolError(
    `no page titled '${page}' in graph '${alias}' — pass an existing page title or its UUID`,
    "refused",
  );
}

/** createAsset with the bytes' exact size and SHA-256. */
async function upload(
  access: GraphAccess,
  alias: string,
  graph: ResolvedGraph,
  file: { fileName: string; bytes: Uint8Array; pageId: string | undefined },
): Promise<CallToolResult> {
  const query: Record<string, string | number> = {
    "file-name": file.fileName,
    size: file.bytes.byteLength,
    checksum: await sha256Hex(file.bytes),
  };
  if (file.pageId !== undefined) query["page-id"] = file.pageId;
  const response = await graphFetch(access, alias, graph.pat, {
    method: "POST",
    path: graphPath(graph, "/assets"),
    query,
    body: file.bytes,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const asset = (await response.json()) as { uuid?: unknown };
  if (typeof asset.uuid !== "string") throw new Error("createAsset answered without an asset uuid");
  return textResult(JSON.stringify({ assetUuid: asset.uuid, fileName: file.fileName, size: file.bytes.byteLength }));
}

/** The decoded last path segment of `url` when it is a file name with an extension. */
function fileNameFromUrl(url: URL): string | null {
  const segment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return /^[^/\\]+\.[A-Za-z0-9]+$/.test(name) ? name : null;
}

/** Text of a file for a tool result: whole if it fits, else its start with a notice, within the limit. */
function fileText(text: string, complete: boolean, fileName: string, size: number): string {
  if (complete && text.length <= RESULT_CHAR_LIMIT) return text;
  const notice = `\n\n[truncated: ${fileName} has ${size} bytes; this shows the start, up to the ${RESULT_CHAR_LIMIT}-character result limit]`;
  return text.slice(0, RESULT_CHAR_LIMIT - notice.length) + notice;
}

interface AssetMeta {
  title: string;
  type: string;
  size: number;
  url: string;
}

function assetMeta(body: unknown): AssetMeta {
  const meta = body as Partial<AssetMeta> | null;
  if (
    typeof meta?.title !== "string" ||
    typeof meta.type !== "string" ||
    typeof meta.size !== "number" ||
    typeof meta.url !== "string"
  ) {
    throw new Error("getAsset answered without title, type, size and url");
  }
  return meta as AssetMeta;
}

async function readFile(access: GraphAccess, alias: string, assetUuid: string): Promise<CallToolResult> {
  const graph = await resolveGraph(access, alias, false);
  const metaResponse = await graphFetch(access, alias, graph.pat, {
    method: "GET",
    path: graphPath(graph, `/assets/${encodeURIComponent(assetUuid)}`),
  });
  const meta = assetMeta(await metaResponse.json());
  const fileName = `${meta.title}.${meta.type}`;
  const mediaType = EXTENSION_TYPES[meta.type.toLowerCase()];
  const isImage = mediaType !== undefined && IMAGE_TYPES.has(mediaType) && meta.size <= IMAGE_MAX_BYTES;
  const isText = mediaType !== undefined && (mediaType.startsWith("text/") || mediaType === "application/json");
  if (!isImage && !isText) return textResult(JSON.stringify({ fileName, type: meta.type, size: meta.size }));

  // The signed URL's origin is whatever the sync server saw (sync.internal over the binding); only its
  // path and query are used, and they go over SYNC, never the public Internet.
  const signed = new URL(meta.url);
  if (!signed.pathname.startsWith("/assets/")) throw new Error("getAsset answered with an unexpected URL path");
  const fileResponse = await graphFetch(access, alias, graph.pat, {
    method: "GET",
    path: signed.pathname,
    query: Object.fromEntries(signed.searchParams),
  });
  if (isImage) {
    const { bytes, complete } = await readUpTo(fileResponse.body, IMAGE_MAX_BYTES);
    if (!complete) throw new Error("the asset is larger than its recorded size");
    return { content: [{ type: "image", data: toBase64(bytes), mimeType: mediaType }] };
  }
  const { bytes, complete } = await readUpTo(fileResponse.body, TEXT_READ_BYTES);
  // Streaming mode holds back a UTF-8 sequence cut off at the read limit instead of mangling it.
  const text = new TextDecoder().decode(bytes, { stream: !complete });
  return textResult(fileText(text, complete, fileName, meta.size));
}

/** `save_document`, `save_file_from_url` and `read_file`. `onSuccess` runs after each successful call. */
export function registerAssetTools(
  server: McpServer,
  access: GraphAccess,
  onSuccess: (tool: string, alias: string) => void,
): void {
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  function handle<A>(name: string, call: (alias: string, args: A) => Promise<CallToolResult>) {
    return (args: A) => {
      const alias = aliasArg(args);
      return runTool(name, alias, async () => {
        // The input schema requires a well-formed alias, so a call that got this far has one.
        if (alias === undefined) throw new Error("file tool ran without a valid alias");
        const result = await call(alias, args);
        onSuccess(name, alias);
        return result;
      });
    };
  }

  server.registerTool(
    "save_document",
    {
      description:
        "Save a document to the graph as a file asset (e.g. a transcript, report or note), from text (utf-8) or base64 bytes, at most 150,000 characters. The file name's extension sets its type. Returns the asset's UUID.",
      inputSchema: z.object({
        graph: graphArg,
        fileName: z.string().min(1).describe("File name with an extension, e.g. meeting-notes.md"),
        text: z.string().optional().describe("The document as text, saved as utf-8. Pass this or base64."),
        base64: z.string().optional().describe("The document's bytes, base64-encoded. Pass this or text."),
        page: pageArg,
      }),
      annotations: write,
    },
    handle("save_document", async (alias, args) => {
      const graph = await resolveGraph(access, alias, true);
      if ((args.text === undefined) === (args.base64 === undefined)) {
        throw new ToolError("pass exactly one of text or base64", "refused");
      }
      const [field, input] = args.text !== undefined ? ["text", args.text] : ["base64", args.base64 as string];
      if (input.length > ARGUMENT_CHAR_LIMIT) {
        throw new ToolError(
          `${field} is ${input.length} characters; save_document accepts at most ${ARGUMENT_CHAR_LIMIT} — use save_file_from_url for larger files`,
          "refused",
        );
      }
      const bytes = field === "text" ? new TextEncoder().encode(input) : fromBase64(input);
      const pageId = args.page === undefined ? undefined : await pageIdFor(access, alias, graph, args.page);
      return upload(access, alias, graph, { fileName: args.fileName, bytes, pageId });
    }),
  );

  server.registerTool(
    "save_file_from_url",
    {
      description:
        "Download a file from a public https URL (at most 25 MiB; text, PDF, PNG, JPEG, GIF, WebP, JSON or Office documents) and save it to the graph as a file asset. Returns the asset's UUID.",
      inputSchema: z.object({
        graph: graphArg,
        url: z.string().describe("Public https URL of the file"),
        fileName: z
          .string()
          .min(1)
          .optional()
          .describe("File name with an extension; defaults to the URL's last path segment"),
        page: pageArg,
      }),
      annotations: write,
    },
    handle("save_file_from_url", async (alias, args) => {
      const graph = await resolveGraph(access, alias, true);
      const pageId = args.page === undefined ? undefined : await pageIdFor(access, alias, graph, args.page);
      let fetched;
      try {
        fetched = await safeFetch(args.url, { maxBytes: URL_MAX_BYTES, allowTypes: FILE_TYPES });
      } catch (error) {
        if (!(error instanceof SafeFetchError)) throw error;
        throw new ToolError(`cannot fetch that URL: ${error.message}`, "refused");
      }
      const fileName = args.fileName ?? fileNameFromUrl(fetched.url);
      if (fileName === null) {
        throw new ToolError("the URL has no file name with an extension — pass fileName, e.g. notes.txt", "refused");
      }
      return upload(access, alias, graph, { fileName, bytes: fetched.bytes, pageId });
    }),
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a file asset back: text files as text (truncated beyond 150,000 characters), PNG/JPEG/GIF/WebP images up to 5 MiB as images, anything else as a one-line description.",
      inputSchema: z.object({
        graph: graphArg,
        assetUuid: z
          .string()
          .regex(UUID)
          .describe("The asset block's UUID, e.g. from save_document, list_assets or search_graph"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    handle("read_file", (alias, args) => readFile(access, alias, args.assetUuid)),
  );
}
