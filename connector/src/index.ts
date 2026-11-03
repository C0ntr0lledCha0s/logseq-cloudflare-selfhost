import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { GitHubFetch } from "./auth/github";
import { isAllowedRedirectUri } from "./auth/redirect-uris";
import { type DefaultEnv, authRoute } from "./auth/routes";
import { csrfToken, requireOwnerSession } from "./auth/session";
import { ConfigError, checkConfig } from "./config";
import { escapeHtml, htmlPage } from "./html";
import { mcpApiHandler } from "./mcp";

/** Placeholder for the "Connect a graph" wizard, behind the owner's session. */
async function graphsPage(request: Request, env: DefaultEnv): Promise<Response> {
  const session = await requireOwnerSession(request, env);
  if (session instanceof Response) return session;
  return htmlPage(
    200,
    "Connected graphs",
    `<h1>Connected graphs — coming soon</h1>
<form method="post" action="/logout">
  <input type="hidden" name="csrf" value="${escapeHtml(csrfToken(session))}">
  <button>Sign out</button>
</form>`,
  );
}

function defaultHandler(githubFetch: GitHubFetch): ExportedHandler<DefaultEnv> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
      if (url.pathname === "/graphs" && request.method === "GET") return graphsPage(request, env);
      const auth = authRoute(request, env, githubFetch);
      if (auth) return auth;
      return new Response("Not found", { status: 404 });
    },
  };
}

/**
 * The provider options for one hostname. `resource` must be the exact `https://<host>/mcp` URL the
 * client reaches, and the provider takes it as a fixed string, so there is one provider per host.
 */
export function providerOptions(host: string, githubFetch: GitHubFetch): OAuthProviderOptions<Env> {
  return {
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: defaultHandler(githubFetch) as ExportedHandler<Env>,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `https://${host}/mcp`, resource_name: "Logseq graphs" },
    clientRegistrationCallback({ clientMetadata }) {
      const uris = clientMetadata.redirect_uris;
      const allowed =
        Array.isArray(uris) && uris.length > 0 && uris.every((uri) => typeof uri === "string" && isAllowedRedirectUri(uri));
      if (!allowed) {
        return { code: "invalid_redirect_uri", description: "redirect_uris must be allowed by this server", status: 400 };
      }
    },
    // The library's default logs descriptions; keep logs to the status and code only.
    onError({ status, code }) {
      console.warn(`oauth error ${status} ${code}`);
    },
  };
}

/** The Worker, with GitHub reached through `githubFetch` (stubbed in tests). */
export function createConnector({ githubFetch }: { githubFetch: GitHubFetch }): ExportedHandler<Env> {
  const providers = new Map<string, OAuthProvider<Env>>();
  return {
    async fetch(request, env, ctx) {
      try {
        checkConfig(env);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        console.error(`connector misconfigured: ${error.message}`);
        return new Response("Server misconfigured", { status: 500 });
      }
      // Cloudflare routes only the configured hostname here, so this holds one entry in practice.
      const host = new URL(request.url).host;
      let provider = providers.get(host);
      if (!provider) {
        provider = new OAuthProvider(providerOptions(host, githubFetch));
        providers.set(host, provider);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}

export default createConnector({ githubFetch: (url, init) => fetch(url, init) });
