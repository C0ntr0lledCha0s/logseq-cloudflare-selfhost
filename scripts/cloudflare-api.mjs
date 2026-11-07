// The Cloudflare API client the Node scripts share: one fetch wrapper, one response parser and the
// rule for the test-only base URL override.

export const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

const TEST_BASE = /^(https:\/\/\S+|http:\/\/127\.0\.0\.1:\d+)$/;

/** A failed Cloudflare API call: the HTTP status and the numeric codes from `errors[]`. */
export class CfError extends Error {
  constructor(message, { status, codes = [] }) {
    super(message);
    this.name = "CfError";
    this.status = status;
    this.codes = codes;
  }
}

/**
 * The API base for this process. `CF_API_BASE` only applies with `CF_API_TEST=1`, and only to an
 * https:// URL or a local stub, so a stray variable can never send the API token to another host.
 */
export function apiBaseFromEnv(env) {
  if (!env.CF_API_BASE) return DEFAULT_API_BASE;
  if (env.CF_API_TEST !== "1") throw new Error("CF_API_BASE is test-only and requires CF_API_TEST=1");
  if (!TEST_BASE.test(env.CF_API_BASE)) {
    throw new Error("CF_API_BASE must be https:// or http://127.0.0.1:<port>");
  }
  return env.CF_API_BASE;
}

/** Parses an API response. Throws the API's own error messages and codes, never any result rows. */
export async function readEnvelope(res, label = "Cloudflare API") {
  let body;
  try {
    body = await res.json();
  } catch {
    throw new CfError(`${label} ${res.status}: response is not JSON`, { status: res.status });
  }
  if (!res.ok || body?.success !== true) {
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const messages = errors.map((e) => e?.message).filter(Boolean);
    const codes = errors.map((e) => e?.code).filter(Number.isInteger);
    throw new CfError(`${label} ${res.status}: ${messages.length > 0 ? messages.join("; ") : "no error message"}`, {
      status: res.status,
      codes,
    });
  }
  return body;
}

/** One API call. Returns the whole parsed envelope (`result`, `result_info`). */
export async function cf({ apiBase, apiToken, method = "GET", path, query, body, fetchImpl = fetch }) {
  if (!apiBase) throw new Error("cf: apiBase is required");
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = { Authorization: `Bearer ${apiToken}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return readEnvelope(res);
}
