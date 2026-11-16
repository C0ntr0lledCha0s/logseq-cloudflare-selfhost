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
  /** Send the PAT as a bearer token (default). False for routes that authorize otherwise, e.g. signed asset URLs. */
  auth?: boolean;
}

/** A non-2xx answer from the sync server. `message` is the body's `error` field; never a token. */
export class SyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds, from `Retry-After`, when the server sent one. */
    readonly retryAfter?: number,
    /**
     * False when the body held no `error` of the server's own (not JSON, empty, or JSON without
     * one): the answer came from the platform, e.g. a Durable Object stopped at its CPU limit.
     */
    readonly serverMessage = true,
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

/** `env.SYNC.fetch` rejected: the sync server gave no answer at all (it was stopped or reset mid-request). */
export class SyncStoppedError extends Error {
  constructor(readonly reason: string) {
    super(`the sync server gave no answer: ${reason}`);
    this.name = "SyncStoppedError";
  }
}

async function syncErrorFrom(response: Response): Promise<SyncError> {
  let message = `sync server returned HTTP ${response.status}`;
  let serverMessage = false;
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    if (typeof body?.error === "string" && body.error !== "") {
      message = body.error;
      serverMessage = true;
    }
  } catch {
    // Not JSON: keep the status-only message rather than echo an unknown body.
  }
  const retryHeader = response.headers.get("Retry-After");
  const retryAfter = retryHeader !== null && /^[0-9]+$/.test(retryHeader) ? Number(retryHeader) : undefined;
  return new SyncError(response.status, message, retryAfter, serverMessage);
}

/**
 * One request to the sync server as the PAT's owner. Returns 2xx responses; throws `SyncError` for
 * any other answer, and `SyncStoppedError` when the service binding's fetch rejects.
 */
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
  if (req.auth !== false) headers.set("Authorization", `Bearer ${pat}`);
  let response: Response;
  try {
    response = await env.SYNC.fetch(new Request(url, { method: req.method, headers, body }));
  } catch (error) {
    throw new SyncStoppedError(error instanceof Error ? error.message : String(error));
  }
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
