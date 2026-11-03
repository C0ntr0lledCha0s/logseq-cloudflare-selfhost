import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { SafeFetchError, safeFetch } from "../src/net/safe-fetch";
import { RESULT_CHAR_LIMIT } from "../src/tools/common";
import { FILE_TYPES, IMAGE_MAX_BYTES } from "../src/tools/assets";

const ORIGIN = "https://mcp.example.com";
const WORK_TOKEN = "logseq_pat_WorkToken123";
const NOTES_TOKEN = "logseq_pat_NotesToken456";
const WORK_ID = "11111111-1111-1111-1111-111111111111";
const NOTES_ID = "22222222-2222-2222-2222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const MIB = 1024 * 1024;
const MAX_BYTES = 25 * MIB;

interface SyncCall {
  method: string;
  url: URL;
  auth: string | null;
  contentType: string | null;
  bytes: Uint8Array;
}

type SyncHandler = (request: Request) => Response | Promise<Response>;
let syncHandler: SyncHandler;
let syncCalls: SyncCall[];
let fetchSpy: MockInstance<typeof fetch>;
let consoleSpies: MockInstance[];

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

function testEnv(): Env {
  const sync = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      syncCalls.push({
        method: request.method,
        url: new URL(request.url),
        auth: request.headers.get("Authorization"),
        contentType: request.headers.get("Content-Type"),
        bytes: new Uint8Array(await request.clone().arrayBuffer()),
      });
      return syncHandler(request);
    },
  } as unknown as Fetcher;
  return { ...env, SYNC: sync } as Env;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
  await store().add({
    alias: "work",
    graphId: WORK_ID,
    graphName: "Work",
    mode: "write",
    permission: "both",
    expiresAt: null,
    token: WORK_TOKEN,
  });
  await store().add({
    alias: "notes",
    graphId: NOTES_ID,
    graphName: "Notes",
    mode: "read",
    permission: "read",
    expiresAt: null,
    token: NOTES_TOKEN,
  });
  syncCalls = [];
  syncHandler = () => Response.json({ error: "unexpected sync call" }, { status: 500 });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected public fetch");
  });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const spy of consoleSpies) spy.mockRestore();
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** One `tools/call` through the connector's MCP handler. */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: Content[] }> {
  const e = testEnv();
  const request = new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ctx = createExecutionContext();
  const res = await mcpHandler(e, ctx)(request, e, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((msg) => msg.id === 1)
    : JSON.parse(text);
  expect(json.error).toBeUndefined();
  return { isError: json.result.isError === true, content: json.result.content };
}

function onlyText(result: { content: Content[] }): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return (result.content[0] as { text: string }).text;
}

/** A sync stub that accepts asset uploads and answers like createAsset. */
function acceptUploads(): void {
  syncHandler = (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === `/api/v1/graphs/${WORK_ID}/assets`) {
      return Response.json(
        {
          uuid: ASSET_ID,
          title: "x",
          type: "md",
          size: Number(url.searchParams.get("size")),
          checksum: url.searchParams.get("checksum"),
        },
        { status: 201 },
      );
    }
    return Response.json({ error: "unexpected sync call" }, { status: 500 });
  };
}

describe("save_document", () => {
  it("save_document computes size and sha256 and sends octet-stream", async () => {
    acceptUploads();
    const text = "# Standup\n\n- wörk on [[Ann]] ✓\n";
    const bytes = new TextEncoder().encode(text);
    const checksum = await sha256Hex(bytes);

    const result = await callTool("save_document", { graph: "work", fileName: "standup.md", text });

    expect(result.isError).toBe(false);
    expect(JSON.parse(onlyText(result))).toEqual({ assetUuid: ASSET_ID, fileName: "standup.md", size: bytes.length });
    expect(syncCalls).toHaveLength(1);
    const upload = syncCalls[0];
    expect(upload.method).toBe("POST");
    expect(upload.url.origin + upload.url.pathname).toBe(`https://sync.internal/api/v1/graphs/${WORK_ID}/assets`);
    expect(Object.fromEntries(upload.url.searchParams)).toEqual({
      "file-name": "standup.md",
      size: String(bytes.length),
      checksum,
    });
    expect(upload.contentType).toBe("application/octet-stream");
    expect(upload.auth).toBe(`Bearer ${WORK_TOKEN}`);
    expect(upload.bytes).toEqual(bytes);
    expect(await sha256Hex(upload.bytes)).toBe(checksum);

    // Base64 input is decoded to the raw bytes before hashing.
    syncCalls = [];
    const raw = new Uint8Array([0, 255, 1, 2, 128, 64]);
    const fromBase64 = await callTool("save_document", { graph: "work", fileName: "blob.bin", base64: base64(raw) });
    expect(fromBase64.isError).toBe(false);
    expect(JSON.parse(onlyText(fromBase64))).toEqual({ assetUuid: ASSET_ID, fileName: "blob.bin", size: 6 });
    expect(Object.fromEntries(syncCalls[0].url.searchParams)).toEqual({
      "file-name": "blob.bin",
      size: "6",
      checksum: await sha256Hex(raw),
    });
    expect(syncCalls[0].bytes).toEqual(raw);
  });

  it("save_document attaches to a page by UUID through createAsset's page-id, or by exact title via search", async () => {
    acceptUploads();
    const byUuid = await callTool("save_document", { graph: "work", fileName: "a.md", text: "a", page: PAGE_ID });
    expect(byUuid.isError).toBe(false);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].url.searchParams.get("page-id")).toBe(PAGE_ID);

    syncCalls = [];
    const upload = syncHandler;
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/api/v1/graphs/${WORK_ID}/search`) {
        return Response.json({
          results: [
            { uuid: "55555555-5555-4555-8555-555555555555", kind: "page", title: "Standup notes", resource: "blocks" },
            { uuid: "66666666-6666-4666-8666-666666666666", kind: "block", title: "standup", resource: "blocks" },
            { uuid: PAGE_ID, kind: "page", title: "Standup", resource: "blocks" },
          ],
        });
      }
      return upload(request);
    };
    const byTitle = await callTool("save_document", { graph: "work", fileName: "b.md", text: "b", page: "standup" });
    expect(byTitle.isError).toBe(false);
    expect(syncCalls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /api/v1/graphs/${WORK_ID}/search`,
      `POST /api/v1/graphs/${WORK_ID}/assets`,
    ]);
    expect(syncCalls[0].url.searchParams.get("q")).toBe("standup");
    expect(syncCalls[1].url.searchParams.get("page-id")).toBe(PAGE_ID);

    // No exact page title: refused before any upload.
    syncCalls = [];
    const missing = await callTool("save_document", { graph: "work", fileName: "c.md", text: "c", page: "Stand" });
    expect(missing.isError).toBe(true);
    expect(onlyText(missing)).toBe("no page titled 'Stand' in graph 'work' — pass an existing page title or its UUID");
    expect(syncCalls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("save_document refuses a page title that several pages share, or that the search cannot exhaust", async () => {
    acceptUploads();
    const upload = syncHandler;
    const page = (uuid: string, title: string) => ({ uuid, kind: "page", title, resource: "blocks" });
    const OTHER_PAGE = "77777777-7777-4777-8777-777777777777";

    // Two pages share the title (DB graphs allow it), on different search pages.
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname !== `/api/v1/graphs/${WORK_ID}/search`) return upload(request);
      return url.searchParams.get("cursor") === null
        ? Response.json({ results: [page(PAGE_ID, "Standup")], "next-cursor": "c1" })
        : Response.json({ results: [page(OTHER_PAGE, "standup")] });
    };
    const several = await callTool("save_document", { graph: "work", fileName: "a.md", text: "a", page: "Standup" });
    expect(several.isError).toBe(true);
    expect(onlyText(several)).toBe("several pages are titled 'Standup' — pass the page's UUID");
    expect(syncCalls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(syncCalls[1].url.searchParams.get("cursor")).toBe("c1");

    // One exact match, but the search still has more pages after the fifth: another match could follow.
    syncCalls = [];
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname !== `/api/v1/graphs/${WORK_ID}/search`) return upload(request);
      const n = Number(url.searchParams.get("cursor") ?? "0");
      return Response.json({
        results: n === 0 ? [page(PAGE_ID, "Standup")] : [page(`${n}`, "Standup notes")],
        "next-cursor": String(n + 1),
      });
    };
    const tooMany = await callTool("save_document", { graph: "work", fileName: "a.md", text: "a", page: "Standup" });
    expect(tooMany.isError).toBe(true);
    expect(onlyText(tooMany)).toBe("too many search results to find page 'Standup' — pass the page's UUID");
    expect(syncCalls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);
  });

  it("save_document rejects both or neither of text/base64 and oversize input", async () => {
    const both = await callTool("save_document", { graph: "work", fileName: "a.md", text: "a", base64: "YQ==" });
    expect(both.isError).toBe(true);
    expect(onlyText(both)).toBe("pass exactly one of text or base64");

    const neither = await callTool("save_document", { graph: "work", fileName: "a.md" });
    expect(neither.isError).toBe(true);
    expect(onlyText(neither)).toBe("pass exactly one of text or base64");

    const bigText = await callTool("save_document", { graph: "work", fileName: "a.md", text: "x".repeat(150_001) });
    expect(bigText.isError).toBe(true);
    expect(onlyText(bigText)).toBe(
      "text is 150001 characters; save_document accepts at most 150000 — use save_file_from_url for larger files",
    );

    const bigBase64 = await callTool("save_document", { graph: "work", fileName: "a.bin", base64: "A".repeat(150_004) });
    expect(bigBase64.isError).toBe(true);
    expect(onlyText(bigBase64)).toBe(
      "base64 is 150004 characters; save_document accepts at most 150000 — use save_file_from_url for larger files",
    );

    const badBase64 = await callTool("save_document", { graph: "work", fileName: "a.bin", base64: "not base64!" });
    expect(badBase64.isError).toBe(true);
    expect(onlyText(badBase64)).toBe("base64 is not valid base64");

    expect(syncCalls).toHaveLength(0);
  });

  it("write file tools on a read-only graph are refused before any sync call or fetch", async () => {
    const doc = await callTool("save_document", { graph: "notes", fileName: "a.md", text: "a" });
    expect(doc).toEqual({ isError: true, content: [{ type: "text", text: "graph 'notes' is read-only" }] });
    const fromUrl = await callTool("save_file_from_url", { graph: "notes", url: "https://files.example.com/a.pdf" });
    expect(fromUrl).toEqual({ isError: true, content: [{ type: "text", text: "graph 'notes' is read-only" }] });
    expect(syncCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("safeFetch", () => {
  const options = { maxBytes: MAX_BYTES, allowTypes: FILE_TYPES };

  it("safeFetch rejects http:, localhost, 127.0.0.1, 10.0.0.1, 169.254.169.254, [::1], fd00::1", async () => {
    for (const url of [
      "http://files.example.com/a.pdf",
      "ftp://files.example.com/a.pdf",
      "https://localhost/a.pdf",
      "https://localhost./a.pdf",
      "https://api.localhost/a.pdf",
      "https://127.0.0.1/a.pdf",
      "https://10.0.0.1/a.pdf",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.pdf",
      "https://[fd00::1]/a.pdf",
      // Other private, CGNAT, link-local and "this network" ranges.
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.1.1/",
      "https://100.64.0.1/",
      "https://0.0.0.0/",
      "https://[fe80::1]/",
      "https://[::]/",
      // IPv4 in the forms the URL parser canonicalizes: decimal, octal, hex, short.
      "https://2130706433/",
      "https://0177.0.0.1/",
      "https://0x7f.0.0.1/",
      "https://0x7f000001/",
      "https://127.1/",
      // IPv4-mapped, IPv4-compatible and NAT64 IPv6.
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://[::127.0.0.1]/",
      "https://[64:ff9b::a00:1]/",
      // IPv4-translated, Teredo, discard-only, and the 6to4 relay anycast range.
      "https://[::ffff:0:127.0.0.1]/",
      "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
      "https://[100::1]/",
      "https://192.88.99.1/",
      // Userinfo, non-standard ports, internal and single-label names.
      "https://user:pass@files.example.com/a.pdf",
      "https://files.example.com@127.0.0.1/a.pdf",
      "https://files.example.com:8443/a.pdf",
      "https://files.example.com:80/a.pdf",
      "https://sync.internal/assets/x",
      "https://intranet/a.pdf",
      "not a url",
    ]) {
      await expect(safeFetch(url, options), url).rejects.toBeInstanceOf(SafeFetchError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("safeFetch rejects https public URL that redirects to http://169.254.169.254 and to https://localhost", async () => {
    for (const location of [
      "http://169.254.169.254/latest/meta-data",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/a.pdf",
      "https://[::ffff:10.0.0.1]/a.pdf",
    ]) {
      fetchSpy.mockReset();
      fetchSpy.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: location } }));
      await expect(safeFetch("https://files.example.com/a.pdf", options), location).rejects.toBeInstanceOf(SafeFetchError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [target, init] = fetchSpy.mock.calls[0];
      expect(String(target)).toBe("https://files.example.com/a.pdf");
      expect(init?.redirect).toBe("manual");
    }

    // A public redirect chain is followed, each hop re-checked, relative Locations resolved.
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://cdn.example.net/x" } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "/files/report.pdf" } }))
      .mockResolvedValueOnce(new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }));
    const fetched = await safeFetch("https://files.example.com/a", options);
    expect(new TextDecoder().decode(fetched.bytes)).toBe("%PDF-1.7");
    expect(fetched.mediaType).toBe("application/pdf");
    expect(fetched.url.href).toBe("https://cdn.example.net/files/report.pdf");
    expect(fetchSpy.mock.calls.map(([target]) => String(target))).toEqual([
      "https://files.example.com/a",
      "https://cdn.example.net/x",
      "https://cdn.example.net/files/report.pdf",
    ]);

    // At most 5 redirects.
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(
      async () => new Response(null, { status: 302, headers: { Location: "https://files.example.com/again" } }),
    );
    await expect(safeFetch("https://files.example.com/a", options)).rejects.toThrow("more than 5 redirects");
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it("safeFetch aborts past 25 MiB and rejects disallowed content type", async () => {
    // An endless body: the read must stop as soon as the count passes the cap.
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(MIB));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(endless, { headers: { "Content-Type": "application/pdf" } }));
    await expect(safeFetch("https://files.example.com/big.pdf", options)).rejects.toThrow(
      "the file is larger than 26214400 bytes",
    );
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(27);

    // A declared Content-Length over the cap is refused without reading.
    fetchSpy.mockResolvedValueOnce(
      new Response("small", { headers: { "Content-Type": "application/pdf", "Content-Length": String(MAX_BYTES + 1) } }),
    );
    await expect(safeFetch("https://files.example.com/big.pdf", options)).rejects.toThrow(
      "the file is larger than 26214400 bytes",
    );

    // Exactly the cap is accepted.
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array(MAX_BYTES), { headers: { "Content-Type": "image/png" } }));
    expect((await safeFetch("https://files.example.com/ok.png", options)).bytes.byteLength).toBe(MAX_BYTES);

    for (const type of ["application/octet-stream", "application/zip", "image/svg+xml", "application/x-msdownload"]) {
      fetchSpy.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": type } }));
      await expect(safeFetch("https://files.example.com/f", options), type).rejects.toThrow(
        `content type ${type} is not allowed`,
      );
    }
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: {} }));
    await expect(safeFetch("https://files.example.com/f", options)).rejects.toThrow("the response has no content type");

    // Parameters are ignored and wildcards match by prefix.
    for (const type of [
      "text/html; charset=utf-8",
      "Text/Plain",
      "application/json",
      "image/webp",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]) {
      fetchSpy.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": type } }));
      const ok = await safeFetch("https://files.example.com/f", options);
      expect(ok.mediaType, type).toBe(type.split(";")[0].toLowerCase());
    }

    fetchSpy.mockResolvedValueOnce(new Response("gone", { status: 404, headers: { "Content-Type": "text/plain" } }));
    await expect(safeFetch("https://files.example.com/f", options)).rejects.toThrow("the URL answered HTTP 404");
  });

  it("safeFetch times out each hop and reports network failures without naming the host", async () => {
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(safeFetch("https://files.example.com/slow.pdf", options)).rejects.toThrow(
      new SafeFetchError("the URL timed out"),
    );
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    for (const failure of [
      new TypeError("Network connection lost to files.example.com"),
      new Error("TLS handshake with files.example.com failed"),
      new TypeError("fetch to files.example.com refused: not a public address"),
    ]) {
      fetchSpy.mockRejectedValueOnce(failure);
      const error = await safeFetch("https://files.example.com/a.pdf", options).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as Error).message).toBe("the URL could not be reached");
    }

    // A failure while reading the body is mapped the same way.
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("connection reset by files.example.com"));
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(broken, { headers: { "Content-Type": "application/pdf" } }));
    await expect(safeFetch("https://files.example.com/a.pdf", options)).rejects.toThrow(
      new SafeFetchError("the URL could not be reached"),
    );
  });
});

describe("save_file_from_url", () => {
  it("fetches the URL safely, then uploads its bytes with size and checksum under the URL's file name", async () => {
    acceptUploads();
    const pdf = new TextEncoder().encode("%PDF-1.7 report");
    fetchSpy.mockResolvedValueOnce(new Response(pdf, { headers: { "Content-Type": "application/pdf" } }));

    const result = await callTool("save_file_from_url", {
      graph: "work",
      url: "https://files.example.com/docs/Q3%20report.pdf?download=1",
      page: PAGE_ID,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(onlyText(result))).toEqual({ assetUuid: ASSET_ID, fileName: "Q3 report.pdf", size: pdf.length });
    expect(syncCalls).toHaveLength(1);
    expect(Object.fromEntries(syncCalls[0].url.searchParams)).toEqual({
      "file-name": "Q3 report.pdf",
      size: String(pdf.length),
      checksum: await sha256Hex(pdf),
      "page-id": PAGE_ID,
    });
    expect(syncCalls[0].contentType).toBe("application/octet-stream");
    expect(syncCalls[0].bytes).toEqual(pdf);

    // A refused URL becomes a tool error and nothing is uploaded.
    syncCalls = [];
    const refused = await callTool("save_file_from_url", { graph: "work", url: "https://127.0.0.1/a.pdf" });
    expect(refused.isError).toBe(true);
    expect(onlyText(refused)).toMatch(/^cannot fetch that URL: /);
    expect(syncCalls).toHaveLength(0);

    // No usable file name: ask for one rather than guess.
    fetchSpy.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "text/plain" } }));
    const unnamed = await callTool("save_file_from_url", { graph: "work", url: "https://files.example.com/download" });
    expect(unnamed.isError).toBe(true);
    expect(onlyText(unnamed)).toBe("the URL has no file name with an extension — pass fileName, e.g. notes.txt");
    expect(syncCalls).toHaveLength(0);
  });
});

describe("read_file", () => {
  const SIGNED = `/assets/${WORK_ID}/${ASSET_ID}`;

  /** getAsset answers with metadata and a signed URL; the signed path answers with `body`. */
  function serveAsset(
    meta: { title: string; type: string; size: number },
    body: BodyInit,
    { origin = "https://sync.internal", graphId = WORK_ID } = {},
  ) {
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/api/v1/graphs/${graphId}/assets/${ASSET_ID}`) {
        return Response.json({
          uuid: ASSET_ID,
          ...meta,
          checksum: "0".repeat(64),
          url: `${origin}${SIGNED}.${meta.type}?expires=1999999999&signature=abcd`,
          "expires-at": 1999999999,
        });
      }
      if (url.pathname === `${SIGNED}.${meta.type}`) return new Response(body);
      return Response.json({ error: "unexpected sync call" }, { status: 500 });
    };
  }

  it("read_file returns text, image content, and description for other types; text truncated with notice", async () => {
    serveAsset({ title: "standup", type: "md", size: 12 }, "# Standup ✓");
    const text = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
    expect(text.isError).toBe(false);
    expect(onlyText(text)).toBe("# Standup ✓");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    serveAsset({ title: "diagram", type: "png", size: png.length }, png);
    const image = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
    expect(image).toEqual({ isError: false, content: [{ type: "image", data: base64(png), mimeType: "image/png" }] });

    syncCalls = [];
    serveAsset({ title: "contract", type: "pdf", size: 4096 }, "%PDF");
    const pdf = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
    expect(pdf.isError).toBe(false);
    expect(JSON.parse(onlyText(pdf))).toEqual({ fileName: "contract.pdf", type: "pdf", size: 4096 });
    expect(syncCalls).toHaveLength(1); // metadata only: the bytes are never fetched

    // An image over 3.75 MiB is described, not returned.
    expect(IMAGE_MAX_BYTES).toBe(3_932_160);
    syncCalls = [];
    serveAsset({ title: "photo", type: "jpg", size: IMAGE_MAX_BYTES + 1 }, "x");
    const bigImage = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
    expect(JSON.parse(onlyText(bigImage))).toEqual({ fileName: "photo.jpg", type: "jpg", size: IMAGE_MAX_BYTES + 1 });
    expect(syncCalls).toHaveLength(1);

    // Long text is cut to the result limit, notice included.
    const long = "a".repeat(200_000);
    serveAsset({ title: "log", type: "txt", size: long.length }, long);
    const truncated = onlyText(await callTool("read_file", { graph: "work", assetUuid: ASSET_ID }));
    expect(truncated).toHaveLength(RESULT_CHAR_LIMIT);
    expect(truncated.startsWith("aaaa")).toBe(true);
    expect(truncated).toMatch(/\n\n\[truncated: log\.txt has 200000 bytes; this shows the start, up to the 150000-character result limit\]$/);

    // JSON is text too.
    serveAsset({ title: "data", type: "json", size: 8 }, '{"a":1}');
    expect(onlyText(await callTool("read_file", { graph: "work", assetUuid: ASSET_ID }))).toBe('{"a":1}');
  });

  it("read_file returns an image only when its first bytes match its extension", async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1, 2]);
    const images: [string, string, Uint8Array][] = [
      ["png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])],
      ["jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2])],
      ["jpeg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xdb])],
      ["gif", "image/gif", new TextEncoder().encode("GIF89a...")],
      ["webp", "image/webp", webp],
    ];
    for (const [type, mimeType, bytes] of images) {
      serveAsset({ title: "pic", type, size: bytes.length }, bytes);
      const result = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
      expect(result, type).toEqual({ isError: false, content: [{ type: "image", data: base64(bytes), mimeType }] });
    }

    const png = images[0][2];
    const mismatches: [string, Uint8Array][] = [
      ["png", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")],
      ["jpg", png],
      ["gif", new TextEncoder().encode("GIF")],
      ["webp", new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ")],
      ["png", new Uint8Array(0)],
    ];
    for (const [type, bytes] of mismatches) {
      serveAsset({ title: "pic", type, size: bytes.length }, bytes);
      const result = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
      expect(result.isError, type).toBe(false);
      expect(JSON.parse(onlyText(result)), type).toEqual({ fileName: `pic.${type}`, type, size: bytes.length });
    }
  });

  it("read_file base64-encodes a multi-chunk image at the size limit exactly", async () => {
    const bytes = new Uint8Array(IMAGE_MAX_BYTES);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    bytes.set([0xff, 0xd8, 0xff], 0);
    // Several chunks, so the bytes reach the encoder through readUpTo's copy.
    const chunk = 64 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
        controller.close();
      },
    });
    serveAsset({ title: "big", type: "jpg", size: bytes.length }, body);
    const result = await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });
    expect(result.isError).toBe(false);
    const image = result.content[0] as { type: string; data: string; mimeType: string };
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data).toHaveLength(5 * MIB);
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    expect(image.data === btoa(binary)).toBe(true);
  });

  it("read_file fetches signed URL through SYNC not public fetch", async () => {
    // Even when the signed URL names a public origin, only its path and query are used, over SYNC.
    // Reading works on a read-only graph, with that graph's own PAT.
    serveAsset({ title: "standup", type: "md", size: 5 }, "hello", {
      origin: "https://sync.example.com",
      graphId: NOTES_ID,
    });
    const result = await callTool("read_file", { graph: "notes", assetUuid: ASSET_ID });
    expect(onlyText(result)).toBe("hello");
    expect(syncCalls.map((c) => `${c.method} ${c.url.href}`)).toEqual([
      `GET https://sync.internal/api/v1/graphs/${NOTES_ID}/assets/${ASSET_ID}`,
      `GET https://sync.internal${SIGNED}.md?expires=1999999999&signature=abcd`,
    ]);
    // The PAT goes to getAsset only; the signed route is authorized by its signature.
    expect(syncCalls.map((c) => c.auth)).toEqual([`Bearer ${NOTES_TOKEN}`, null]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // A malformed asset UUID never reaches the sync server.
    syncCalls = [];
    const bad = await callTool("read_file", { graph: "work", assetUuid: "../pages" });
    expect(bad.isError).toBe(true);
    expect(syncCalls).toHaveLength(0);
  });
});

describe("logging", () => {
  it("file tools log only tool, alias, status and duration — no PAT, URL or hostname", async () => {
    acceptUploads();
    await callTool("save_document", { graph: "work", fileName: "a.md", text: "secret text", page: PAGE_ID });
    fetchSpy.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "text/plain" } }));
    await callTool("save_file_from_url", { graph: "work", url: "https://files.example.com/private/a.txt" });
    await callTool("save_file_from_url", { graph: "work", url: "https://127.0.0.1/a.txt" });
    syncHandler = (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return Response.json({
          uuid: ASSET_ID,
          title: "a",
          type: "txt",
          size: 1,
          checksum: "0".repeat(64),
          url: `https://sync.internal/assets/${WORK_ID}/${ASSET_ID}.txt?expires=1&signature=ab`,
        });
      }
      return new Response("x");
    };
    await callTool("read_file", { graph: "work", assetUuid: ASSET_ID });

    const lines = consoleSpies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
    expect(lines.map((line) => line.replace(/ms=\d+$/, "ms=N"))).toEqual([
      "tool save_document graph=work status=ok ms=N",
      "tool save_file_from_url graph=work status=ok ms=N",
      "tool save_file_from_url graph=work status=refused ms=N",
      "tool read_file graph=work status=ok ms=N",
    ]);
    for (const line of lines) {
      for (const leak of [WORK_TOKEN, "logseq_pat_", "https://", "example.com", "127.0.0.1", "sync.internal", "secret"]) {
        expect(line).not.toContain(leak);
      }
    }
  });
});
