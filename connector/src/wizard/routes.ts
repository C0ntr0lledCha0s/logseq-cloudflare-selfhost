import {
  type OwnerSession,
  checkCsrf,
  csrfToken,
  openPendingGraph,
  requireOwnerSession,
  sealPendingGraph,
} from "../auth/session";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, type ServiceTokenAccess, ServiceTokenStore } from "../auth/service-tokens";
import { readForm } from "../form";
import { type GraphMode, type GraphPermission, GraphStore, normalizeAlias, normalizeToken } from "../graphs";
import { InspectError, SyncError, type TokenGraph, inspectToken } from "../sync";
import {
  type GraphFormValues,
  confirmPage,
  disconnectedPage,
  encryptedGraphPage,
  forbiddenPage,
  graphListPage,
  messagePage,
  newGraphPage,
  newTokenPage,
  tokenCreatedPage,
  tokenListPage,
  type TokenFormValues,
} from "./views";

// The "Connect a graph" wizard: every route needs the owner's session, and every POST its CSRF token.
// A token is only ever read from a form, checked with the sync server and stored encrypted; no page,
// error message or log line contains it.

/** A problem with what the owner submitted. Its message is shown on the page; it never holds a token. */
class FormError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Ctx {
  env: Env;
  session: OwnerSession;
  csrf: string;
  store: GraphStore;
}

interface FormCtx extends Ctx {
  form: FormData;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALIAS_ACTION = /^\/graphs\/([a-z0-9][a-z0-9-]{0,39})\/(edit|token|disconnect)$/;
const TOKEN_REVOKE = /^\/tokens\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revoke$/;
const TOKEN_NAME = /^[a-z0-9-]{1,40}$/;
const WHOLE_DAYS = /^\d{1,3}$/;
const DAY_MS = 86_400_000;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function toList(): Response {
  return new Response(null, { status: 303, headers: { Location: "/graphs", "Cache-Control": "no-store" } });
}

function notFound(): Response {
  return messagePage(404, "Not found", "No connected graph has that alias.");
}

function parseToken(raw: string): string {
  try {
    return normalizeToken(raw);
  } catch (error) {
    // normalizeToken's message describes the shape problem and never includes the value.
    throw new FormError(`That doesn't look like a Logseq token: ${(error as Error).message}.`);
  }
}

function tryAlias(raw: string): string | undefined {
  try {
    return normalizeAlias(raw);
  } catch {
    return undefined;
  }
}

function parseAlias(raw: string): string {
  const alias = tryAlias(raw);
  if (alias === undefined) {
    throw new FormError("The alias must be 1–40 lowercase letters, digits or hyphens, starting with a letter or digit.");
  }
  return alias;
}

function parseMode(form: FormData): GraphMode {
  const mode = text(form, "mode");
  if (mode !== "read" && mode !== "write") throw new FormError("Choose read-only or read-write mode.");
  return mode;
}

/** `listGraphs` needs read scope, so a token that passed inspection is `read` or `both`. */
function parsePermission(form: FormData): GraphPermission {
  const permission = text(form, "permission");
  if (permission !== "read" && permission !== "both") {
    throw new FormError("Choose the token's permission as set in Logseq: both or read.");
  }
  return permission;
}

function checkModeFits(mode: GraphMode, permission: GraphPermission): void {
  if (mode === "write" && permission !== "both") {
    throw new FormError("A read-only token can only be connected in read-only mode.");
  }
}

/** The token's expiry as YYYY-MM-DD, or null when the owner ticked "unknown". Exactly one is required. */
function parseExpiry(form: FormData): string | null {
  const date = text(form, "expires").trim();
  const unknown = text(form, "expires_unknown") === "1";
  if (unknown && date !== "") throw new FormError("Enter an expiry date or tick “I don't know”, not both.");
  if (unknown) return null;
  if (date === "") throw new FormError("Enter the token's expiry date, or tick “I don't know”.");
  const parsed = DATE.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new FormError("The expiry date must be a real date written as YYYY-MM-DD.");
  }
  if (date < new Date(Date.now()).toISOString().slice(0, 10)) throw new FormError("That expiry date has passed.");
  return date;
}

function syncRefusal(error: SyncError): FormError {
  const reason = `${error.message}, HTTP ${error.status}`;
  if (error.status === 401) {
    return new FormError(`The sync server did not accept this token (${reason}). It may be mistyped, expired or revoked.`);
  }
  if (error.status === 403) {
    return new FormError(`The sync server refused this token (${reason}). It needs read permission.`);
  }
  if (error.status === 429) {
    const wait = error.retryAfter === undefined ? "a minute" : `${error.retryAfter} seconds`;
    return new FormError(`The sync server is rate limiting requests (${reason}). Try again in ${wait}.`, 429);
  }
  return new FormError(`The sync server could not check this token (${reason}).`, 502);
}

/** The token's graph, with sync refusals and unexpected answers turned into messages for the page. */
async function inspect(env: Env, token: string): Promise<TokenGraph> {
  try {
    return await inspectToken(env, token);
  } catch (error) {
    if (error instanceof SyncError) throw syncRefusal(error);
    if (error instanceof InspectError) throw new FormError(`The token could not be used: ${error.message}.`);
    throw error;
  }
}

async function connectedAlias(store: GraphStore, graphId: string): Promise<string | undefined> {
  return (await store.list()).find((graph) => graph.graphId === graphId)?.alias;
}

async function context(request: Request, env: Env): Promise<Ctx | Response> {
  const session = await requireOwnerSession(request, env);
  if (session instanceof Response) return session;
  return { env, session, csrf: csrfToken(session), store: new GraphStore(env.DB, env.GRAPH_TOKEN_KEY) };
}

async function withSession(request: Request, env: Env, handler: (ctx: Ctx) => Promise<Response>): Promise<Response> {
  const ctx = await context(request, env);
  return ctx instanceof Response ? ctx : handler(ctx);
}

async function withForm(request: Request, env: Env, handler: (ctx: FormCtx) => Promise<Response>): Promise<Response> {
  const ctx = await context(request, env);
  if (ctx instanceof Response) return ctx;
  if (!(await checkCsrf(request, ctx.session))) return forbiddenPage();
  const form = await readForm(request);
  if (!form) return messagePage(400, "Bad request", "The form could not be read.");
  return handler({ ...ctx, form });
}

/** GET /graphs */
async function listGraphs({ store, csrf }: Ctx): Promise<Response> {
  return graphListPage(await store.list(), csrf, Date.now());
}

/** POST /graphs/new: check the token, refuse E2EE and already-connected graphs, then ask to confirm. */
async function submitToken({ env, session, csrf, store, form }: FormCtx): Promise<Response> {
  try {
    const token = parseToken(text(form, "token"));
    const graph = await inspect(env, token);
    if (graph.e2ee) return encryptedGraphPage(csrf, graph.graphName);
    const existing = await connectedAlias(store, graph.graphId);
    if (existing !== undefined) {
      throw new FormError(`This graph is already connected as “${existing}”. To use a new token, replace it there.`, 409);
    }
    const pending = await sealPendingGraph(env, session, { token, graphId: graph.graphId, graphName: graph.graphName });
    return confirmPage(csrf, pending, graph.graphName, {
      alias: tryAlias(graph.graphName) ?? "",
      mode: "",
      permission: "",
      expires: "",
      expiresUnknown: false,
    });
  } catch (error) {
    if (error instanceof FormError) return newGraphPage(csrf, error.status, error.message);
    throw error;
  }
}

/** POST /graphs/confirm: save the pending graph under the chosen alias, mode, permission and expiry. */
async function confirmGraph({ env, session, csrf, store, form }: FormCtx): Promise<Response> {
  const sealed = text(form, "pending");
  const pending = sealed === "" ? undefined : await openPendingGraph(env, session, sealed);
  if (!pending) {
    return messagePage(400, "Confirmation expired", "This confirmation expired or is not valid. Nothing was saved; connect the graph again.");
  }
  try {
    const alias = parseAlias(text(form, "alias"));
    const mode = parseMode(form);
    const permission = parsePermission(form);
    checkModeFits(mode, permission);
    const expiresAt = parseExpiry(form);
    if (await store.get(alias)) throw new FormError(`The alias “${alias}” is already in use.`, 409);
    const existing = await connectedAlias(store, pending.graphId);
    if (existing !== undefined) throw new FormError(`This graph is already connected as “${existing}”.`, 409);
    await store.add({ alias, graphId: pending.graphId, graphName: pending.graphName, mode, permission, expiresAt, token: pending.token });
    return toList();
  } catch (error) {
    if (!(error instanceof FormError)) throw error;
    // Echo only values that are already valid; an invalid alias could be anything the owner pasted.
    const mode = text(form, "mode");
    const permission = text(form, "permission");
    const expires = text(form, "expires").trim();
    const values: GraphFormValues = {
      alias: tryAlias(text(form, "alias")) ?? tryAlias(pending.graphName) ?? "",
      mode: mode === "read" || mode === "write" ? mode : "",
      permission: permission === "read" || permission === "both" ? permission : "",
      expires: DATE.test(expires) ? expires : "",
      expiresUnknown: text(form, "expires_unknown") === "1",
    };
    return confirmPage(csrf, sealed, pending.graphName, values, error.status, error.message);
  }
}

/** POST /graphs/:alias/edit: alias, mode, expiry and edit stamps (an unticked box is not posted, so it saves off). */
async function editGraph({ store, form }: FormCtx, alias: string): Promise<Response> {
  const graph = await store.get(alias);
  if (!graph) return notFound();
  try {
    const next = parseAlias(text(form, "alias"));
    const mode = parseMode(form);
    checkModeFits(mode, graph.permission);
    const expiresAt = parseExpiry(form);
    if (next !== alias && (await store.get(next))) throw new FormError(`The alias “${next}” is already in use.`, 409);
    const editStamps = text(form, "edit_stamps") === "1";
    await store.update(alias, { alias: next, mode, expiresAt, editStamps });
    return toList();
  } catch (error) {
    if (error instanceof FormError) return messagePage(error.status, "Not saved", error.message);
    throw error;
  }
}

/** POST /graphs/:alias/token: a new token for the same graph, re-checked with the sync server. */
async function replaceToken({ env, store, form }: FormCtx, alias: string): Promise<Response> {
  const graph = await store.get(alias);
  if (!graph) return notFound();
  try {
    const token = parseToken(text(form, "token"));
    const permission = parsePermission(form);
    if (graph.mode === "write" && permission !== "both") {
      throw new FormError("This graph is read-write, so its token needs permission both. Switch it to read-only first.");
    }
    const expiresAt = parseExpiry(form);
    const inspected = await inspect(env, token);
    if (inspected.graphId !== graph.graphId) {
      throw new FormError(
        `This token is for a different graph (“${inspected.graphName}”). Create a token for “${graph.graphName}” instead.`,
      );
    }
    if (inspected.e2ee) {
      throw new FormError("This graph is now end-to-end encrypted, so the connector can't read it. Disconnect it instead.", 422);
    }
    await store.replaceToken(alias, token, inspected.graphId);
    await store.update(alias, { permission, expiresAt });
    return toList();
  } catch (error) {
    if (error instanceof FormError) return messagePage(error.status, "Token not replaced", error.message);
    throw error;
  }
}

/** POST /graphs/:alias/disconnect: deletes the graph and its stored token at once. */
async function disconnectGraph({ store }: FormCtx, alias: string): Promise<Response> {
  if (!(await store.get(alias))) return notFound();
  await store.remove(alias);
  return disconnectedPage(alias);
}

/** GET /tokens: every token, revoked and expired ones included, with its graphs by current alias. */
async function listTokens({ env, store, csrf }: Ctx): Promise<Response> {
  const [list, graphs] = await Promise.all([new ServiceTokenStore(env.DB).list(), store.list()]);
  return tokenListPage(list, graphs, csrf, Date.now());
}

/** GET /tokens/new: read-only and DEFAULT_EXPIRY_DAYS unless the owner changes them. */
async function newToken({ store, csrf }: Ctx): Promise<Response> {
  const values: TokenFormValues = { name: "", graphIds: [], access: "read", expiresDays: String(DEFAULT_EXPIRY_DAYS) };
  return newTokenPage(csrf, await store.list(), values);
}

interface TokenInput {
  name: string;
  graphIds: string[];
  access: ServiceTokenAccess;
  days: number;
}

/** Every field of the create form, checked before anything is read or written; each refusal names its field. */
function parseTokenForm(form: FormData, connected: ReadonlySet<string>): TokenInput {
  const name = text(form, "name").trim();
  if (!TOKEN_NAME.test(name)) throw new FormError("name: use 1–40 lowercase letters, digits or hyphens.");
  const graphIds = [...new Set(form.getAll("graph").map((value) => (typeof value === "string" ? value : "")))];
  if (graphIds.length === 0) throw new FormError("graph: choose at least one graph.");
  if (!graphIds.every((id) => connected.has(id))) throw new FormError("graph: a chosen graph is not connected. Reload the page and choose again.");
  const access = text(form, "access");
  if (access !== "read" && access !== "write") throw new FormError("access: choose read-only or read-write.");
  const days = text(form, "expires_days").trim();
  const count = WHOLE_DAYS.test(days) ? Number(days) : NaN;
  if (!(count >= 1 && count <= MAX_EXPIRY_DAYS)) {
    throw new FormError(`expires_days: a whole number of days from 1 to ${MAX_EXPIRY_DAYS}.`);
  }
  return { name, graphIds, access, days: count };
}

/** The first field the stored row disagrees on, or undefined when it holds exactly what was submitted. */
function readBackMismatch(
  row: Awaited<ReturnType<ServiceTokenStore["get"]>>,
  want: TokenInput & { expiresAt: number },
): string | undefined {
  if (!row) return "token";
  if (row.name !== want.name) return "name";
  if (row.graphIds.length !== want.graphIds.length || row.graphIds.some((id, i) => id !== want.graphIds[i])) return "graph";
  if (row.access !== want.access) return "access";
  if (row.expiresAt !== want.expiresAt) return "expires_days";
  return undefined;
}

/** POST /tokens/new: validate, insert, read back and compare, then show the token once. */
async function createToken({ env, session, csrf, store, form }: FormCtx): Promise<Response> {
  const graphs = await store.list();
  const tokens = new ServiceTokenStore(env.DB);
  try {
    const input = parseTokenForm(form, new Set(graphs.map((graph) => graph.graphId)));
    if (await tokens.nameInUse(input.name)) {
      throw new FormError(`name: “${input.name}” is already in use by another token, revoked or not.`, 409);
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + input.days * DAY_MS;
    const { id, token } = await tokens.create({
      name: input.name,
      ownerId: session.githubUserId,
      graphIds: input.graphIds,
      access: input.access,
      createdAt,
      expiresAt,
    });
    const field = readBackMismatch(await tokens.get(id), { ...input, expiresAt });
    if (field !== undefined) {
      await tokens.remove(id);
      throw new FormError(`${field}: the stored token did not match the form, so it was deleted. No token was created.`, 500);
    }
    return tokenCreatedPage(input.name, token);
  } catch (error) {
    if (!(error instanceof FormError)) throw error;
    // Echo only values that are already valid; an invalid name could be anything the owner pasted.
    const name = text(form, "name").trim();
    const access = text(form, "access");
    const days = text(form, "expires_days").trim();
    const values: TokenFormValues = {
      name: TOKEN_NAME.test(name) ? name : "",
      graphIds: form.getAll("graph").filter((id): id is string => typeof id === "string"),
      access: access === "read" || access === "write" ? access : "",
      expiresDays: WHOLE_DAYS.test(days) ? days : "",
    };
    return newTokenPage(csrf, graphs, values, error.status, error.message);
  }
}

/** POST /tokens/:id/revoke: sets revoked_at once; a re-send keeps the first time and still redirects. */
async function revokeToken({ env }: FormCtx, id: string): Promise<Response> {
  const tokens = new ServiceTokenStore(env.DB);
  // The lookup runs only when nothing changed, to tell an unknown id from an already revoked one.
  if (!(await tokens.revoke(id, Date.now())) && !(await tokens.get(id))) {
    return messagePage(404, "Not found", "No service token has that id.");
  }
  return new Response(null, { status: 303, headers: { Location: "/tokens", "Cache-Control": "no-store" } });
}

const ACTIONS = { edit: editGraph, token: replaceToken, disconnect: disconnectGraph } as const;

/** Routes the wizard owns, or undefined when the path is not one of them. */
export function wizardRoute(request: Request, env: Env): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === "/graphs" && method === "GET") return withSession(request, env, listGraphs);
  if (pathname === "/graphs/new" && method === "GET") return withSession(request, env, async ({ csrf }) => newGraphPage(csrf));
  if (pathname === "/graphs/new" && method === "POST") return withForm(request, env, submitToken);
  if (pathname === "/graphs/confirm" && method === "POST") return withForm(request, env, confirmGraph);
  if (pathname === "/tokens" && method === "GET") return withSession(request, env, listTokens);
  if (pathname === "/tokens/new" && method === "GET") return withSession(request, env, newToken);
  if (pathname === "/tokens/new" && method === "POST") return withForm(request, env, createToken);
  const revoke = TOKEN_REVOKE.exec(pathname);
  if (revoke && method === "POST") return withForm(request, env, (ctx) => revokeToken(ctx, revoke[1]));
  const match = ALIAS_ACTION.exec(pathname);
  if (match && method === "POST") {
    const [, alias, action] = match;
    return withForm(request, env, (ctx) => ACTIONS[action as keyof typeof ACTIONS](ctx, alias));
  }
  return undefined;
}
