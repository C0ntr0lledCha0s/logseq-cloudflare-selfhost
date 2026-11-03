import { ownerGithubUserId } from "../config";

/** The `fetch` used for GitHub calls; injected so tests can stub github.com and api.github.com. */
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubUser {
  id: number;
  login: string;
}

/** GitHub refused the code or returned something unusable. Carries no response content. */
export class GitHubSignInError extends Error {}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "logseq-connector";

/** True only for the owner. Throws if OWNER_GITHUB_USER_ID is not a positive integer. */
export function isOwner(githubUserId: number, env: Env): boolean {
  const owner = ownerGithubUserId(env);
  return Number.isSafeInteger(githubUserId) && githubUserId === owner;
}

/** The GitHub sign-in callback on this host. */
export function githubCallbackUrl(request: Request): string {
  return `https://${new URL(request.url).host}/callback`;
}

/** Where to send the browser to sign in with GitHub. No scope: only the public profile is read. */
export function githubAuthorizeUrl(
  env: Env,
  options: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

/** Exchanges GitHub's code (with the PKCE verifier) and returns who signed in. */
export async function fetchGitHubUser(
  githubFetch: GitHubFetch,
  env: Env,
  options: { code: string; redirectUri: string; codeVerifier: string },
): Promise<GitHubUser> {
  const tokenResponse = await githubFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    }).toString(),
  });
  if (!tokenResponse.ok) throw new GitHubSignInError("GitHub token exchange failed");
  const token = ((await tokenResponse.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || token === "") throw new GitHubSignInError("GitHub token exchange failed");

  const userResponse = await githubFetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userResponse.ok) throw new GitHubSignInError("GitHub user lookup failed");
  const user = (await userResponse.json()) as { id?: unknown; login?: unknown };
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new GitHubSignInError("GitHub user lookup returned no id");
  }
  if (typeof user.login !== "string" || user.login === "") {
    throw new GitHubSignInError("GitHub user lookup returned no login");
  }
  return { id: user.id, login: user.login };
}

/** A PKCE verifier and its S256 challenge, for the GitHub leg of either sign-in. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
