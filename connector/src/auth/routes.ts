import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { escapeHtml, htmlPage } from "../html";
import {
  type GitHubFetch,
  GitHubSignInError,
  createPkce,
  fetchGitHubUser,
  githubAuthorizeUrl,
  githubCallbackUrl,
  isOwner,
} from "./github";
import { isAllowedRedirectUri } from "./redirect-uris";
import {
  LOGIN_STATE_PREFIX,
  beginLogin,
  checkCsrf,
  clearLoginCookie,
  clearSessionCookie,
  createSession,
  finishLogin,
  requireOwnerSession,
} from "./session";

/** The env the provider hands its default handler. */
export type DefaultEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Props stored in every grant and handed to the `/mcp` handler. */
export interface GrantProps {
  githubUserId: number;
  login: string;
}

function notAllowedPage(headers: Headers = new Headers()): Response {
  return htmlPage(
    403,
    "Not allowed",
    "<p>This GitHub account is not allowed to use this connector.</p>",
    headers,
  );
}

function badRequestPage(message: string, headers: Headers = new Headers()): Response {
  return htmlPage(400, "Sign-in failed", `<p>${escapeHtml(message)}</p>`, headers);
}

function githubFailedPage(headers: Headers = new Headers()): Response {
  return htmlPage(502, "Sign-in failed", "<p>GitHub sign-in failed. Please try again.</p>", headers);
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  const scopes =
    details.scope.length > 0
      ? `<p>Scopes: ${details.scope.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}</p>`
      : "";
  return htmlPage(
    200,
    `Authorize ${details.clientName}`,
    `<h1>Allow ${name} to access your Logseq graphs?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}${scopes}
<p>You will sign in with GitHub next.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`,
    headers,
  );
}

/** Errors the consent helpers raise for the user's request rather than for a bug or an outage. */
function authorizationFailure(error: unknown): Response | undefined {
  if (error instanceof AuthorizationError) {
    // Redirect only to a URI the library validated and our allow-list accepts.
    if (error.redirectTo && error.redirectUri && isAllowedRedirectUri(error.redirectUri)) {
      return redirect(error.redirectTo);
    }
    return badRequestPage(error.description);
  }
  if (error instanceof CimdFetchError) return badRequestPage("This app could not be verified.");
  return undefined;
}

/** GET /authorize: validate the client's request, then ask for consent before any redirect to GitHub. */
async function showConsent(request: Request, env: DefaultEnv): Promise<Response> {
  let authRequest: AuthRequest;
  let details: ConsentDescription;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!isAllowedRedirectUri(authRequest.redirectUri)) {
      return badRequestPage("This app's redirect URI is not allowed.");
    }
    details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
  } catch (error) {
    const response = authorizationFailure(error);
    if (response) return response;
    throw error;
  }
  const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
  return consentPage(details, consent.handle, consent.headers);
}

/** POST /authorize: on approval, save the request and send the browser to GitHub. */
async function submitConsent(request: Request, env: DefaultEnv): Promise<Response> {
  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string") return badRequestPage("The consent form is incomplete.");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
    const pkce = await createPkce();
    const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
      data: { verifier: pkce.verifier },
      headers: approved.headers,
    });
    const location = githubAuthorizeUrl(env, {
      redirectUri: githubCallbackUrl(request),
      state,
      codeChallenge: pkce.challenge,
    });
    return redirect(location, headers);
  } catch (error) {
    const response = authorizationFailure(error);
    if (response) return response;
    throw error;
  }
}

/** GET /callback for an MCP authorization: only the owner gets a grant and a code. */
async function finishAuthorization(request: Request, env: DefaultEnv, githubFetch: GitHubFetch): Promise<Response> {
  const params = new URL(request.url).searchParams;
  let resumed;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return badRequestPage("This sign-in has expired or was already used. Start again from your app.");
    }
    throw error;
  }
  const { request: authRequest, data, headers } = resumed;
  if (params.get("error")) return redirect(authorizationErrorRedirect(authRequest, "access_denied"), headers);
  const code = params.get("code");
  if (!code) return badRequestPage("GitHub returned no code.", headers);

  let user;
  try {
    user = await fetchGitHubUser(githubFetch, env, {
      code,
      redirectUri: githubCallbackUrl(request),
      codeVerifier: data.verifier,
    });
  } catch (error) {
    if (error instanceof GitHubSignInError) return githubFailedPage(headers);
    throw error;
  }
  // The allow-list gate: nobody but the owner reaches completeAuthorization().
  if (!isOwner(user.id, env)) return notAllowedPage(headers);

  const props: GrantProps = { githubUserId: user.id, login: user.login };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: authRequest.scope,
    props,
  });
  return redirect(redirectTo, headers);
}

/** GET /login: the wizard's own GitHub sign-in. */
async function startLogin(request: Request, env: DefaultEnv): Promise<Response> {
  const pkce = await createPkce();
  const { state, setCookie } = await beginLogin(env, pkce.verifier);
  const location = githubAuthorizeUrl(env, {
    redirectUri: githubCallbackUrl(request),
    state,
    codeChallenge: pkce.challenge,
  });
  return redirect(location, new Headers({ "Set-Cookie": setCookie, "Cache-Control": "no-store" }));
}

/** GET /callback for a wizard sign-in: only the owner gets a session. */
async function finishLoginCallback(
  request: Request,
  env: DefaultEnv,
  githubFetch: GitHubFetch,
  state: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const headers = new Headers({ "Set-Cookie": clearLoginCookie(), "Cache-Control": "no-store" });
  const verifier = await finishLogin(request, env, state);
  if (!verifier) return badRequestPage("This sign-in has expired or was started in another browser.", headers);
  const code = params.get("code");
  if (!code) return badRequestPage("GitHub sign-in was cancelled.", headers);

  let user;
  try {
    user = await fetchGitHubUser(githubFetch, env, {
      code,
      redirectUri: githubCallbackUrl(request),
      codeVerifier: verifier,
    });
  } catch (error) {
    if (error instanceof GitHubSignInError) return githubFailedPage(headers);
    throw error;
  }
  if (!isOwner(user.id, env)) return notAllowedPage(headers);
  headers.append("Set-Cookie", await createSession(env, user.id));
  return redirect("/graphs", headers);
}

/** GET /callback: GitHub returns here for both sign-ins; the `state` says which. */
async function callback(request: Request, env: DefaultEnv, githubFetch: GitHubFetch): Promise<Response> {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  if (state.startsWith(LOGIN_STATE_PREFIX)) return finishLoginCallback(request, env, githubFetch, state);
  return finishAuthorization(request, env, githubFetch);
}

/** POST /logout: ends the wizard session. CSRF-protected like every state-changing form. */
async function logout(request: Request, env: DefaultEnv): Promise<Response> {
  const session = await requireOwnerSession(request, env);
  if (session instanceof Response) return session;
  if (!(await checkCsrf(request, session))) return htmlPage(403, "Forbidden", "<p>The form has expired. Reload and try again.</p>");
  return htmlPage(
    200,
    "Signed out",
    '<p>You are signed out. <a href="/login">Sign in again</a></p>',
    new Headers({ "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" }),
  );
}

/** Routes the auth pages own, or undefined when the path is not one of them. */
export function authRoute(
  request: Request,
  env: DefaultEnv,
  githubFetch: GitHubFetch,
): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === "/authorize" && method === "GET") return showConsent(request, env);
  if (pathname === "/authorize" && method === "POST") return submitConsent(request, env);
  if (pathname === "/callback" && method === "GET") return callback(request, env, githubFetch);
  if (pathname === "/login" && method === "GET") return startLogin(request, env);
  if (pathname === "/logout" && method === "POST") return logout(request, env);
  return undefined;
}
