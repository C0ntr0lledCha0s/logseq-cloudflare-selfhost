/**
 * Server-side fetch of a URL that Claude supplied, guarded against SSRF.
 *
 * A Worker cannot resolve DNS itself, so these checks cover what the URL says: `https:` only, no
 * userinfo, no port but 443, no `localhost`/internal or single-label names, and no IP literal in a
 * loopback, private, CGNAT, link-local, metadata or other non-public range. The URL parser has already
 * canonicalized IPv4 written as decimal, octal, hex or short forms (`2130706433`, `0177.0.0.1`,
 * `127.1` → `127.0.0.1`) and IPv6 to bracketed hex, so the checks see one form each. Redirects are
 * followed by hand (`redirect: "manual"`), re-checking every hop, at most `MAX_REDIRECTS`.
 *
 * A public-looking hostname whose DNS answer is private is stopped by the Worker's
 * `global_fetch_strictly_public` compatibility flag (wrangler.template.jsonc), under which `fetch()`
 * reaches only the public Internet. That flag is the backstop for resolved targets; the tests run
 * without it and exercise only the checks here.
 */

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  /** The body may be at most this many bytes. */
  maxBytes: number;
  /** Media types, exact (`application/pdf`) or a prefix ending in `*` (`text/*`). */
  allowTypes: readonly string[];
}

export interface FetchedFile {
  bytes: Uint8Array;
  /** The response's media type, lowercased, without parameters. */
  mediaType: string;
  /** The URL that answered, after redirects. */
  url: URL;
}

export const MAX_REDIRECTS = 5;
/** Each hop, body included, must finish within this. */
export const HOP_TIMEOUT_MS = 45_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

type IPv4 = [number, number, number, number];

/** Dotted-quad IPv4 (the URL parser's canonical form), or null. */
function parseIPv4(text: string): IPv4 | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? (octets as IPv4) : null;
}

/** IPv6 text (no brackets) as eight 16-bit groups, or null. Accepts a dotted IPv4 tail. */
function parseIPv6(text: string): number[] | null {
  let s = text;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const split = (h: string) => (h === "" ? [] : h.split(":"));
  const head = split(halves[0]);
  const rest = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...head, ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;
  const zeros = new Array(8 - groups.length).fill("0");
  return [...head, ...zeros, ...rest].map((g) => parseInt(g, 16));
}

function blockedIPv4([a, b, c]: IPv4): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && (b & 0xc0) === 64) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local, including metadata 169.254.169.254
    (a === 172 && (b & 0xf0) === 16) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // deprecated 6to4 relay anycast
    (a === 198 && (b & 0xfe) === 18) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function embeddedIPv4(high: number, low: number): IPv4 {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function blockedIPv6(g: number[]): boolean {
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUntil(6)) return blockedIPv4(embeddedIPv4(g[6], g[7])); // ::, ::1 and IPv4-compatible
  if (zeroUntil(5) && g[5] === 0xffff) return blockedIPv4(embeddedIPv4(g[6], g[7])); // IPv4-mapped
  if (zeroUntil(4) && g[4] === 0xffff && g[5] === 0) return blockedIPv4(embeddedIPv4(g[6], g[7])); // IPv4-translated
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // NAT64: the well-known /96 embeds an IPv4 address; the local-use 64:ff9b:1::/48 is never public.
    return g.slice(2, 6).every((x) => x === 0) ? blockedIPv4(embeddedIPv4(g[6], g[7])) : true;
  }
  if (g[0] === 0x2002) return blockedIPv4(embeddedIPv4(g[1], g[2])); // 6to4
  return (
    (g[0] & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g[0] & 0xff80) === 0xfe80 || // link-local fe80::/10 and deprecated site-local fec0::/10
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x2001 && g[1] === 0x0db8) || // documentation
    (g[0] === 0x2001 && g[1] === 0) || // Teredo 2001::/32, which tunnels to an obfuscated IPv4 address
    (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) // discard-only 100::/64
  );
}

/** Throws `SafeFetchError` unless `url` is one the connector may fetch. */
function checkUrl(url: URL): void {
  if (url.protocol !== "https:") throw new SafeFetchError("only https: URLs are allowed");
  if (url.username !== "" || url.password !== "") throw new SafeFetchError("URLs with credentials are not allowed");
  // The parser drops the default port, so any port left is a non-standard one.
  if (url.port !== "") throw new SafeFetchError("only the standard https port is allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const groups = parseIPv6(host.slice(1, -1));
    if (!groups || blockedIPv6(groups)) throw new SafeFetchError("the address is not a public one");
    return;
  }
  const v4 = parseIPv4(host);
  if (v4) {
    if (blockedIPv4(v4)) throw new SafeFetchError("the address is not a public one");
    return;
  }
  const labels = host.split(".");
  // Public names have a dot and an alphabetic top-level label; anything numeric there would be an
  // address form the parser did not canonicalize, so it is refused rather than guessed at.
  if (labels.length < 2 || !/^(xn--)?[a-z][a-z0-9-]*$/.test(labels[labels.length - 1])) {
    throw new SafeFetchError("the host is not a public domain name");
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SafeFetchError("the host is not a public domain name");
  }
}

function parseUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new SafeFetchError("not a valid URL");
  }
  checkUrl(url);
  return url;
}

/** `Text/HTML; charset=utf-8` → `text/html`. */
export function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function typeAllowed(mediaType: string, allowTypes: readonly string[]): boolean {
  return allowTypes.some((pattern) =>
    pattern.endsWith("*")
      ? mediaType.length >= pattern.length && mediaType.startsWith(pattern.slice(0, -1))
      : mediaType === pattern,
  );
}

/**
 * Reads at most `maxBytes` of `body`. Stops and cancels the stream as soon as more arrive, and then
 * returns the first `maxBytes` with `complete: false`.
 */
export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  if (body === null) return { bytes: new Uint8Array(0), complete: true };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      complete = false;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, complete };
}

/** A network, TLS, timeout or policy failure as a message for Claude, never naming the host. */
function unreachable(error: unknown): SafeFetchError {
  if (error instanceof SafeFetchError) return error;
  if (error instanceof Error && error.name === "TimeoutError") return new SafeFetchError("the URL timed out");
  // Includes refusals by global_fetch_strictly_public; their messages may name the host, so none is echoed.
  return new SafeFetchError("the URL could not be reached");
}

/**
 * Fetches `rawUrl` with the checks above, following redirects by hand, and reads its body up to
 * `maxBytes`. Each hop has `HOP_TIMEOUT_MS`. Throws `SafeFetchError` with a message for Claude on any
 * refusal or failure.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<FetchedFile> {
  let url = parseUrl(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
    } catch (error) {
      throw unreachable(error);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) throw new SafeFetchError(`more than ${MAX_REDIRECTS} redirects`);
      const location = response.headers.get("Location");
      if (location === null) throw new SafeFetchError("a redirect had no Location");
      url = parseUrl(location, url);
      continue;
    }
    try {
      return await readResponse(response, url, options);
    } catch (error) {
      throw unreachable(error);
    }
  }
}

async function readResponse(response: Response, url: URL, options: SafeFetchOptions): Promise<FetchedFile> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new SafeFetchError(`the URL answered HTTP ${response.status}`);
  }
  const contentType = response.headers.get("Content-Type");
  if (contentType === null) {
    await response.body?.cancel();
    throw new SafeFetchError("the response has no content type");
  }
  const mediaType = mediaTypeOf(contentType);
  if (!typeAllowed(mediaType, options.allowTypes)) {
    await response.body?.cancel();
    throw new SafeFetchError(`content type ${mediaType} is not allowed`);
  }
  const tooLarge = `the file is larger than ${options.maxBytes} bytes`;
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) > options.maxBytes) {
    await response.body?.cancel();
    throw new SafeFetchError(tooLarge);
  }
  const { bytes, complete } = await readUpTo(response.body, options.maxBytes);
  if (!complete) throw new SafeFetchError(tooLarge);
  return { bytes, mediaType, url };
}
