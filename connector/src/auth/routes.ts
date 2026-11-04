import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { readForm } from "../form";
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
import { badRequestPage, consentPage, formExpiredPage, githubFailedPage, notAllowedPage, signedOutPage } from "./views";

/** The env the provider hands its default handler. */
export type DefaultEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Props stored in every grant and handed to the `/mcp` handler. */
export interface GrantProps {
  githubUserId: number;
  login: string;
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
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
  const form = await readForm(request);
  if (!form) return badRequestPage("The consent form is incomplete.");
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
      redirectUri: githubCallbackUrl(env),
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
      redirectUri: githubCallbackUrl(env),
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
    redirectUri: githubCallbackUrl(env),
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
      redirectUri: githubCallbackUrl(env),
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
  if (!(await checkCsrf(request, session))) return formExpiredPage();
  return signedOutPage(new Headers({ "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" }));
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
