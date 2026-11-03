/**
 * Calls to the `logseq-sync` Worker over the `SYNC` service binding, authenticated with a graph PAT.
 * The origin is a placeholder: a service binding ignores it, and nothing goes over the public hostname.
 */
export const SYNC_ORIGIN = "https://sync.internal";

export interface SyncRequest {
  method: string;
  /** Starts with `/`, e.g. `/api/v1/graphs`. */
  path: string;
  query?: Record<string, string | number | boolean>;
  /** Sent as `application/json`. Pass this or `body`, not both. */
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

/** A non-2xx answer from the sync server. `message` is the body's `error` field; never a token. */
export class SyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds, from `Retry-After`, when the server sent one. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/** The graph a PAT reaches. */
export interface TokenGraph {
  graphId: string;
  graphName: string;
  e2ee: boolean;
}

/** The sync server's graph list was not exactly one well-formed graph. */
export class InspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectError";
  }
}

async function syncErrorFrom(response: Response): Promise<SyncError> {
  let message = `sync server returned HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (typeof body?.error === "string" && body.error !== "") message = body.error;
  } catch {
    // Not JSON: keep the status-only message rather than echo an unknown body.
  }
  const retryHeader = response.headers.get("Retry-After");
  const retryAfter = retryHeader !== null && /^[0-9]+$/.test(retryHeader) ? Number(retryHeader) : undefined;
  return new SyncError(response.status, message, retryAfter);
}

/** One request to the sync server as the PAT's owner. Returns 2xx responses; throws `SyncError` otherwise. */
export async function syncFetch(env: Env, pat: string, req: SyncRequest): Promise<Response> {
  if (!req.path.startsWith("/")) throw new Error("sync path must start with /");
  if (req.json !== undefined && req.body !== undefined) throw new Error("pass json or body to syncFetch, not both");
  const url = new URL(SYNC_ORIGIN + req.path);
  for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, String(value));
  const headers = new Headers(req.headers);
  let body = req.body;
  if (req.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(req.json);
  }
  headers.set("Authorization", `Bearer ${pat}`);
  const response = await env.SYNC.fetch(new Request(url, { method: req.method, headers, body }));
  if (!response.ok) throw await syncErrorFrom(response);
  return response;
}

/**
 * The single graph a PAT is scoped to, via `GET /api/v1/graphs`. Throws `SyncError` when the server
 * refuses the token, and `InspectError` unless the answer is exactly one graph with an id, a name and
 * an explicit `graph-e2ee?` flag (so an unknown encryption state is never treated as unencrypted).
 */
export async function inspectToken(env: Env, pat: string): Promise<TokenGraph> {
  const response = await syncFetch(env, pat, { method: "GET", path: "/api/v1/graphs" });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InspectError("the sync server's graph list was not JSON");
  }
  const graphs = (body as { graphs?: unknown } | null)?.graphs;
  if (!Array.isArray(graphs)) throw new InspectError("the sync server's graph list had no graphs");
  if (graphs.length !== 1) {
    throw new InspectError(`expected the token to reach exactly one graph, but it reaches ${graphs.length}`);
  }
  const graph = graphs[0] as { "graph-id"?: unknown; "graph-name"?: unknown; "graph-e2ee?"?: unknown } | null;
  const graphId = graph?.["graph-id"];
  const graphName = graph?.["graph-name"];
  const e2ee = graph?.["graph-e2ee?"];
  if (typeof graphId !== "string" || graphId === "" || typeof graphName !== "string" || typeof e2ee !== "boolean") {
    throw new InspectError("the sync server's graph entry was incomplete");
  }
  return { graphId, graphName, e2ee };
}
