import { aesKeyFromHex, fromBase64url, timingSafeEqual } from "../crypto";
import { readForm } from "../form";
import { base64url, isOwner } from "./github";

/** The wizard's own sign-in. Separate from OAuth grants: an MCP token never opens the wizard. */
export interface OwnerSession {
  githubUserId: number;
  /** Random per session, sealed inside the cookie; forms echo it back. */
  csrf: string;
}

const SESSION_COOKIE = "__Host-connector-session";
const LOGIN_COOKIE = "__Host-connector-login";
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_SECONDS = 10 * 60;
const PENDING_SECONDS = 10 * 60;
/** Prefix that tells a wizard sign-in `state` apart from the OAuth library's (base64url, no dot). */
export const LOGIN_STATE_PREFIX = "login.";

type Purpose = "session" | "login" | "pending-token";

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function cookieKey(env: Env): Promise<CryptoKey> {
  return aesKeyFromHex(env.COOKIE_ENCRYPTION_KEY, "COOKIE_ENCRYPTION_KEY");
}

/** AES-GCM with the purpose as associated data, so a login cookie can never pass as a session. */
async function seal(env: Env, purpose: Purpose, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose) },
    await cookieKey(env),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** Undefined when the value is malformed, tampered with, or sealed for another purpose. */
async function unseal(env: Env, purpose: Purpose, value: string): Promise<unknown> {
  const [iv, data, extra] = value.split(".");
  if (!iv || !data || extra !== undefined) return undefined;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv), additionalData: new TextEncoder().encode(purpose) },
      await cookieKey(env),
      fromBase64url(data),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return undefined;
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A `Set-Cookie` value for a new 8 h wizard session, encrypted with COOKIE_ENCRYPTION_KEY. */
export async function createSession(env: Env, githubUserId: number): Promise<string> {
  const value = await seal(env, "session", { sub: githubUserId, csrf: randomToken(), exp: now() + SESSION_SECONDS });
  return cookie(SESSION_COOKIE, value, SESSION_SECONDS);
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

/** The owner's session, or a redirect to `/login` when there is none, it expired, or it is not the owner's. */
export async function requireOwnerSession(request: Request, env: Env): Promise<OwnerSession | Response> {
  const toLogin = new Response(null, { status: 302, headers: { Location: "/login", "Cache-Control": "no-store" } });
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return toLogin;
  const payload = (await unseal(env, "session", value)) as { sub?: unknown; csrf?: unknown; exp?: unknown } | undefined;
  if (!payload || typeof payload.sub !== "number" || typeof payload.csrf !== "string" || typeof payload.exp !== "number") {
    return toLogin;
  }
  if (payload.exp <= now() || !isOwner(payload.sub, env)) return toLogin;
  return { githubUserId: payload.sub, csrf: payload.csrf };
}

export function csrfToken(session: OwnerSession): string {
  return session.csrf;
}

/** True when the form's `csrf` field matches this session's token. Reads a clone of the body. */
export async function checkCsrf(request: Request, session: OwnerSession): Promise<boolean> {
  const submitted = (await readForm(request.clone()))?.get("csrf");
  return typeof submitted === "string" && timingSafeEqual(submitted, session.csrf);
}

/** Starts a wizard sign-in: the `state` for GitHub and a cookie binding it (and the PKCE verifier) to this browser. */
export async function beginLogin(env: Env, verifier: string): Promise<{ state: string; setCookie: string }> {
  const state = LOGIN_STATE_PREFIX + randomToken();
  const value = await seal(env, "login", { state, verifier, exp: now() + LOGIN_SECONDS });
  return { state, setCookie: cookie(LOGIN_COOKIE, value, LOGIN_SECONDS) };
}

/** The PKCE verifier for this sign-in, or undefined unless `state` matches this browser's unexpired login cookie. */
export async function finishLogin(request: Request, env: Env, state: string): Promise<string | undefined> {
  const value = readCookie(request, LOGIN_COOKIE);
  if (!value) return undefined;
  const payload = (await unseal(env, "login", value)) as { state?: unknown; verifier?: unknown; exp?: unknown } | undefined;
  if (!payload || typeof payload.state !== "string" || typeof payload.verifier !== "string" || typeof payload.exp !== "number") {
    return undefined;
  }
  if (payload.exp <= now() || !timingSafeEqual(payload.state, state)) return undefined;
  return payload.verifier;
}

export function clearLoginCookie(): string {
  return cookie(LOGIN_COOKIE, "", 0);
}

/** A checked token waiting for the owner to confirm the connection. */
export interface PendingGraph {
  token: string;
  graphId: string;
  graphName: string;
}

/**
 * Seals a pending graph (token included) for the confirm form's hidden field: encrypted with
 * COOKIE_ENCRYPTION_KEY for the "pending-token" purpose, tied to this session, valid for 10 minutes.
 */
export async function sealPendingGraph(env: Env, session: OwnerSession, pending: PendingGraph): Promise<string> {
  const { token, graphId, graphName } = pending;
  return seal(env, "pending-token", { token, graphId, graphName, sid: session.csrf, exp: now() + PENDING_SECONDS });
}

/** The pending graph, or undefined when the value is tampered with, expired, or sealed for another session. */
export async function openPendingGraph(env: Env, session: OwnerSession, value: string): Promise<PendingGraph | undefined> {
  const payload = (await unseal(env, "pending-token", value)) as
    | { token?: unknown; graphId?: unknown; graphName?: unknown; sid?: unknown; exp?: unknown }
    | undefined;
  if (
    !payload ||
    typeof payload.token !== "string" ||
    typeof payload.graphId !== "string" ||
    typeof payload.graphName !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return undefined;
  }
  if (payload.exp <= now() || !timingSafeEqual(payload.sid, session.csrf)) return undefined;
  return { token: payload.token, graphId: payload.graphId, graphName: payload.graphName };
}
